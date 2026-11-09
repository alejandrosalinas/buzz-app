// Seeded random lifecycle runs of the real live subscription against a model
// relay. Hand-written cases cover only the holes someone thought of; this
// checks one invariant over whatever sequence the seed produces:
//
//   A channel reported continuous holds every message the relay stored for it,
//   and an open subscription streams it.
//
// A channel reported without continuity is caught up by a read, so the oracle
// then counts every stored message as held. The relay model follows block/buzz
// (`crates/buzz-relay`): it accepts `created_at` up to 900 s in the past,
// replays stored events per filter, newest first, up to the filter's limit,
// and fans each new event out to every open subscription it matches. It does
// not model the relay gaps the docs list as known (a send-buffer drop, filters
// after the limit, a channel deleted during an outage).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { subscribeRelayTraffic, type LiveCallbacks } from "./live";
import { keypair, message, signed } from "./testing";
import { matchesEvent } from "./projection";
import type { ReadFilter, RelayEvent } from "./events";

afterEach(() => vi.useRealTimers());

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const order = (a: RelayEvent, b: RelayEvent) =>
  b.created_at - a.created_at || (a.id < b.id ? -1 : 1);
const seconds = () => Math.floor(Date.now() / 1000);

class ModelRelay {
  stored: RelayEvent[] = [];
  sockets: ModelSocket[] = [];
  downUntil = 0;
  /** Channels the viewer may read. A REQ leaves out a channel it cannot read,
   * with no CLOSED, and access lost later leaves it out too; only a new REQ
   * after a grant includes it again (block/buzz `bridge.rs`). */
  access = new Set<string>();
  /** Called for each REQ with the time until its replay ends. */
  onReq?: (socket: ModelSocket, id: string, delay: number) => void;
  constructor(readonly random: () => number) {}
  get down() {
    return Date.now() < this.downUntil;
  }
  current() {
    return this.sockets.at(-1);
  }
  publish(event: RelayEvent) {
    this.stored.push(event);
    for (const socket of this.sockets) socket.fanOut(event);
  }
  /** Whether an open subscription on an open socket names the channel. */
  streams(channel: string) {
    return this.sockets.some(
      (socket) =>
        socket.readyState === 1 &&
        [...socket.subs.values()].some((sub) => sub.channels.has(channel)),
    );
  }
}

/** `filter` with `keys` removed. */
const without = (filter: ReadFilter, ...keys: (keyof ReadFilter)[]) => {
  const rest = { ...filter };
  for (const key of keys) delete rest[key];
  return rest;
};

/** A channel filter delivers only the channels its REQ could read. */
const visible = (
  sub: { channels: Set<string> },
  filter: ReadFilter,
  event: RelayEvent,
) =>
  !filter["#h"] ||
  event.tags.some((t) => t[0] === "h" && sub.channels.has(t[1] ?? ""));

class ModelSocket {
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: (event?: { code?: number; renew?: true }) => void;
  onerror?: (event: Event) => void;
  subs = new Map<string, { filters: ReadFilter[]; channels: Set<string> }>();
  constructor(readonly model: ModelRelay) {
    if (model.down) {
      setTimeout(() => this.close(1006), 0);
      return;
    }
    setTimeout(() => this.deliver(["AUTH", "challenge"]), 0);
  }
  deliver(value: unknown) {
    if (this.readyState !== 1) return;
    void this.onmessage?.({ data: JSON.stringify(value) });
  }
  send(text: string) {
    if (this.readyState !== 1) return;
    const frame = JSON.parse(text) as unknown[];
    if (frame[0] === "AUTH") {
      const event = frame[1] as RelayEvent;
      setTimeout(() => this.deliver(["OK", event.id, true]), 0);
    } else if (frame[0] === "REQ") {
      const [, id, ...filters] = frame as [string, string, ...ReadFilter[]];
      const sub = {
        filters,
        channels: new Set(
          filters
            .flatMap((filter) => filter["#h"] ?? [])
            .filter((channel) => this.model.access.has(channel)),
        ),
      };
      this.subs.set(id, sub);
      const delay = Math.floor(this.model.random() * 3000);
      this.model.onReq?.(this, id, delay);
      setTimeout(() => {
        if (this.readyState !== 1 || this.subs.get(id) !== sub) return;
        const seen = new Set<string>();
        for (const filter of filters) {
          if (!filter.limit) continue;
          const hits = this.model.stored
            .filter(
              (event) =>
                visible(sub, filter, event) &&
                matchesEvent(event, without(filter, "limit")),
            )
            .sort(order)
            .slice(0, filter.limit);
          for (const event of hits)
            if (!seen.has(event.id)) {
              seen.add(event.id);
              this.deliver(["EVENT", id, event]);
            }
        }
        this.deliver(["EOSE", id]);
      }, delay);
    } else if (frame[0] === "CLOSE") this.subs.delete(frame[1] as string);
    else if (frame[0] === "EVENT") {
      const event = frame[1] as RelayEvent;
      setTimeout(() => this.deliver(["OK", event.id, true]), 0);
    }
  }
  /** A live event, to every subscription it matches; `since`, `until` and
   * `limit` bound only the replay. */
  fanOut(event: RelayEvent) {
    for (const [id, sub] of this.subs)
      if (
        sub.filters.some(
          (filter) =>
            visible(sub, filter, event) &&
            matchesEvent(event, without(filter, "since", "until", "limit")),
        )
      )
        this.deliver(["EVENT", id, event]);
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.subs.clear();
    this.onclose?.(code === undefined ? {} : { code });
  }
  renew() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.subs.clear();
    this.onclose?.({ renew: true });
  }
}

type Violation = { step: number; channel: string; reason: string };

async function run(seed: number, channelCount: number, steps: number) {
  const random = rng(seed);
  const model = new ModelRelay(random);
  const viewer = keypair(),
    author = keypair(),
    relayKey = keypair();
  const ids = Array.from({ length: channelCount }, (_, i) => `c${i}`);
  let joined = [...ids];
  const held = new Set<string>();
  const violations: Violation[] = [];
  const log: string[] = [];
  let step = 0;
  let serial = 0;
  let proven = 0;
  /** Channels whose replay carried a reply since their last report: the
   * relay never stores the thread summary a reply changes, so no replay
   * carries it (see docs/relay-queries.md). */
  const replayedReply = new Set<string>();
  /** Channels whose grant the relay stored but has not delivered yet. Until
   * it arrives the broker cannot know the relay left the channel out. */
  const grantInFlight = new Set<string>();
  /** Claims that missed a message while the channel's grant was in flight.
   * Each must be retracted by a later report with the channel not continuous,
   * which catches up from the rows held at the drop. */
  let claims: Violation[] = [];
  const stored = (channel: string) =>
    model.stored.filter(
      (event) =>
        event.kind === 9 &&
        event.tags.some((t) => t[0] === "h" && t[1] === channel),
    );
  const callbacks: LiveCallbacks = {
    presence() {},
    denied() {},
    state() {},
    receive(events, provenance) {
      for (const event of events) {
        held.add(event.id);
        if (event.kind === 44100)
          for (const t of event.tags)
            if (t[0] === "h") grantInFlight.delete(t[1] ?? "");
        const channel = event.tags.find((t) => t[0] === "h")?.[1];
        if (
          channel &&
          provenance?.phase === "replay" &&
          event.tags.some((t) => t[0] === "e" && t[3] === "reply")
        )
          replayedReply.add(channel);
      }
    },
    established(channelId, _global, continuous) {
      if (!channelId) return;
      const reported = typeof channelId === "string" ? [channelId] : channelId;
      log.push(
        `${step} established ${reported.join(",")} continuous=${(continuous ?? []).join(",")}`,
      );
      for (const channel of reported) {
        const replied = replayedReply.delete(channel);
        if (!model.access.has(channel)) continue;
        if (!continuous?.includes(channel)) {
          // Caught up by a read, which retracts any earlier claim.
          claims = claims.filter((claim) => claim.channel !== channel);
          for (const event of stored(channel)) held.add(event.id);
          continue;
        }
        proven++;
        if (replied)
          violations.push({
            step,
            channel,
            reason: "continuous after a replay that carried a reply",
          });
        const missing = stored(channel).filter((event) => !held.has(event.id));
        if (missing.length)
          (grantInFlight.has(channel) ? claims : violations).push({
            step,
            channel,
            reason: `continuous but missing ${missing.length} (${missing
              .map((event) => event.content)
              .join(", ")})`,
          });
        if (!model.streams(channel))
          violations.push({
            step,
            channel,
            reason: "continuous but no open subscription streams it",
          });
      }
    },
  };
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(viewer, event),
    viewer.pubkey,
    callbacks,
    () => {
      const socket = new ModelSocket(model);
      model.sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    undefined,
    undefined,
    undefined,
    undefined,
    random,
  );
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)] as T;
  const roots: RelayEvent[] = [];
  const post = (channel: string, backdate: number) => {
    const at = seconds() - backdate;
    const root = roots.filter((event) =>
      event.tags.some((t) => t[0] === "h" && t[1] === channel),
    );
    const reply = root.length && random() < 0.2 ? pick(root) : undefined;
    const event = message(
      author,
      channel,
      `m${++serial}@${step}`,
      at,
      reply ? [["e", reply.id, "", "reply"]] : [],
    );
    if (!reply) roots.push(event);
    model.publish(event);
  };
  const grantAccess = (channel: string) => {
    model.access.add(channel);
    grantInFlight.add(channel);
    model.publish(
      signed(relayKey, {
        kind: 44100,
        content: "",
        created_at: seconds(),
        tags: [
          ["p", viewer.pubkey],
          ["h", channel],
        ],
      }),
    );
  };
  /** Posts into a gap in the stream of `channels`, as late as the relay's
   * backdate allowance lets an event land before the gap: a hole anywhere in
   * the broker's recovery then misses a message, which the oracle sees. */
  const gap = (channels: readonly string[]) => {
    for (const channel of channels)
      if (random() < 0.7)
        post(channel, pick([0, 899, Math.floor(random() * 900)]));
    // A gap the replay limit cuts.
    if (channels.length && random() < 0.05) {
      const channel = pick(channels);
      log.push(`${step} burst ${channel} in gap`);
      for (let i = 0; i < 501; i++) post(channel, 0);
    }
  };
  /** Disrupts a replay in flight, where the broker defers its proofs. */
  let injected = 0;
  model.onReq = (socket, id, delay) => {
    if (injected >= 3 || random() >= 0.2) return;
    injected++;
    const at = Math.floor(random() * delay);
    const kind = pick(["grant", "revoke", "closed", "post", "renew", "drop"]);
    setTimeout(() => {
      if (socket.readyState !== 1) return;
      const sub = socket.subs.get(id);
      const scope = [...(sub?.channels ?? [])];
      const channel = scope.length ? pick(scope) : pick(ids);
      log.push(`${step} ${kind} ${kind === "closed" ? id : channel} in replay`);
      if (kind === "grant") {
        if (!model.access.has(channel)) gap([channel]);
        grantAccess(channel);
      } else if (kind === "revoke") {
        model.access.delete(channel);
        for (const other of model.sockets)
          for (const each of other.subs.values()) each.channels.delete(channel);
        gap([channel]);
      } else if (kind === "closed" && sub) {
        socket.subs.delete(id);
        socket.deliver(["CLOSED", id, "error: unavailable"]);
        gap(scope);
      } else if (kind === "post") post(channel, pick([0, 899]));
      else if (kind === "renew") {
        socket.renew();
        gap(ids);
      } else if (kind === "drop") {
        model.downUntil = Date.now() + Math.floor(random() * 5000);
        socket.close(1006);
        gap(ids);
      }
    }, at);
  };
  for (const channel of ids) model.access.add(channel);
  try {
    owner.update(joined, joined);
    // Old enough that resume windows are not cut by the session's start.
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    for (step = 0; step < steps; step++) {
      const roll = random();
      if (roll < 0.3) {
        const channel = pick(ids);
        const backdate = random() < 0.3 ? Math.floor(random() * 900) : 0;
        log.push(`${step} post ${channel} -${backdate}s`);
        post(channel, backdate);
      } else if (roll < 0.45) {
        const ms = Math.floor(random() * 20 * 60_000) + 1000;
        log.push(`${step} wait ${ms}ms`);
        await vi.advanceTimersByTimeAsync(ms);
      } else if (roll < 0.53) {
        // Most deploys bounce briefly; some outages pass the resume lag.
        const outage = Math.floor(
          random() * (random() < 0.7 ? 60_000 : 25 * 60_000),
        );
        log.push(`${step} outage ${outage}ms`);
        model.downUntil = Date.now() + outage;
        model.current()?.close(1006);
        gap(ids);
      } else if (roll < 0.58) {
        log.push(`${step} restart`);
        model.downUntil = Date.now() + Math.floor(random() * 5000);
        model.current()?.close(1012);
        gap(ids);
      } else if (roll < 0.63) {
        log.push(`${step} renew`);
        model.current()?.renew();
        gap(ids);
      } else if (roll < 0.7) {
        const socket = model.current();
        const open = socket
          ? [...socket.subs.keys()].filter((id) => !id.startsWith("probe-"))
          : [];
        if (socket && open.length) {
          const id = pick(open);
          log.push(`${step} CLOSED ${id}`);
          const closed = [...(socket.subs.get(id)?.channels ?? [])];
          socket.subs.delete(id);
          socket.deliver(["CLOSED", id, "error: unavailable"]);
          gap(closed);
        }
      } else if (roll < 0.77) {
        const channel = pick(ids);
        if (model.access.has(channel) && random() < 0.5) {
          // Access ends with no frame: open subscriptions leave it out.
          log.push(`${step} revoke ${channel}`);
          model.access.delete(channel);
          for (const socket of model.sockets)
            for (const sub of socket.subs.values())
              sub.channels.delete(channel);
          gap([channel]);
        } else {
          log.push(`${step} grant ${channel}`);
          if (!model.access.has(channel)) gap([channel]);
          grantAccess(channel);
        }
      } else if (roll < 0.82) {
        const channel = pick(ids);
        joined = joined.includes(channel)
          ? joined.filter((id) => id !== channel)
          : [...joined, channel].sort();
        log.push(`${step} interests ${joined.join(",")}`);
        owner.update(joined, joined);
      } else if (roll < 0.84) {
        const channel = pick(ids);
        log.push(`${step} burst ${channel}`);
        for (let i = 0; i < 501; i++) post(channel, 0);
      } else {
        // Short steps land the next operation inside a replay in flight.
        const ms = Math.floor(random() * 1500);
        await vi.advanceTimersByTimeAsync(ms);
      }
      await vi.advanceTimersByTimeAsync(0);
      injected = 0;
    }
    // Let everything settle: the relay comes back and every route ends.
    model.downUntil = 0;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    violations.push(...claims);
  } finally {
    owner.dispose();
  }
  return { violations, log, proven };
}

describe("live continuity under random lifecycles", () => {
  let proven = 0;
  let runs = 0;
  afterAll(() => {
    // The invariant is vacuous unless the runs report continuity often.
    expect(proven).toBeGreaterThanOrEqual(runs * 2);
  });
  const seeds = Number(process.env.LIVE_MODEL_SEEDS ?? 12);
  const steps = Number(process.env.LIVE_MODEL_STEPS ?? 40);
  for (const channels of [3, 12])
    for (let seed = 1; seed <= seeds; seed++)
      it(`${channels} channels, seed ${seed}`, async () => {
        vi.useFakeTimers({ now: 1_700_000_000_000 });
        const result = await run(seed * 7919 + channels, channels, steps);
        proven += result.proven;
        runs++;
        if (result.violations.length)
          expect.fail(
            `${JSON.stringify(result.violations.slice(0, 3))}\n${result.log.join("\n")}`,
          );
      }, 60_000);
});
