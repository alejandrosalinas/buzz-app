import { networkMetrics } from "../developer/network-metrics";
import { networkRecorder } from "../developer/network-diagnostics";
import { getLogger, setLogLevel } from "../developer/logging";
import {
  verifyEvent,
  type EventTemplate,
  type VerifiedEvent,
} from "nostr-tools";
import {
  assert,
  beforeEach,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLiveAdmission,
  LIVE_BATCH_REFRESH_INTERVAL,
  LIVE_CHECK_TIMEOUT_MS,
  LIVE_RECOVERY_INTERVAL,
  liveChannels,
  liveReconnectDelay,
  liveResumeSince,
  SETUP_TIMEOUT_MS,
  liveSlowRetryDelay,
  subscribeRelayTraffic,
  type LiveCallbacks,
} from "./live";
import {
  keypair,
  message,
  nativeSignatureChecks,
  roster,
  signed,
  scriptedTransport,
} from "./testing";
import type { SignatureVerifier } from "./events";
import { yieldToHost } from "./yield";
import { createRelaySession } from "./session";
import { liveRecoveryStatus } from "./live-recovery";
import { createPresence } from "../presence/presence";
import { matchesEvent } from "./projection";
import {
  VERIFIED_PROFILE_MAX_SYNCS,
  verifiedProfileFilter,
} from "./verified-profile";
type WireFilter = {
  kinds: number[];
  "#h"?: string[];
  "#p"?: string[];
  since: number;
  until?: number;
  limit: number;
};
type WireRequest = [string, string, WireFilter, ...WireFilter[]];
const filtersOf = (request: WireRequest) => request.slice(2) as WireFilter[];
const scopeOf = (request: WireRequest) =>
  filtersOf(request).flatMap((f) => f["#h"] ?? []);
const isProbe = (frame: unknown[]) =>
  typeof frame[1] === "string" && frame[1].startsWith("probe-");
class Socket {
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: (event?: { code?: number | undefined }) => void;
  onerror?: (event: Event) => void;
  sent: unknown[][] = [];
  /** A responsive relay answers liveness probes; a silent one answers nothing. */
  silent = false;
  send(text: string) {
    const frame = JSON.parse(text);
    this.sent.push(frame);
    if (frame[0] === "REQ" && isProbe(frame) && !this.silent)
      queueMicrotask(() => void this.receive(["EOSE", frame[1]]));
  }
  close(code?: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
  /** Route requests; liveness probes are counted by `probes`. */
  requests() {
    return this.sent.filter(
      (entry) => entry[0] === "REQ" && !isProbe(entry),
    ) as WireRequest[];
  }
  probes() {
    return this.sent.filter((entry) => entry[0] === "REQ" && isProbe(entry));
  }
  async auth() {
    await this.receive(["AUTH", "challenge"]);
    const event = this.sent.find((entry) => entry[0] === "AUTH")?.[1] as {
      id: string;
    };
    await this.receive(["OK", event.id, true]);
  }
}
// Count the real verifier; its cryptographic result is never replaced.
vi.mock("nostr-tools", async (original) => {
  const actual = await original<typeof import("nostr-tools")>();
  return { ...actual, verifyEvent: vi.fn(actual.verifyEvent) };
});
beforeEach(() => networkRecorder.setEnabled(true));

afterEach(() => {
  vi.useRealTimers();
  networkMetrics.setEnabled(false);
  networkMetrics.reset();
});
it("keeps the browser authentication deadline measured from construction", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await vi.advanceTimersByTimeAsync(9000);
    h.first.onopen?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("retrying");
  } finally {
    h.owner.dispose();
  }
});
function setup(
  channels = ["a", "b"],
  admission = createLiveAdmission(),
  batchSize = 10,
  random?: () => number,
  signatures?: SignatureVerifier,
) {
  const key = keypair(),
    sockets: Socket[] = [];
  const callbacks = {
    presence: vi.fn(),
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  } satisfies LiveCallbacks;
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    key.pubkey,
    callbacks,
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    admission,
    undefined,
    undefined,
    batchSize,
    random,
    signatures,
  );
  owner.update(channels);
  const first = sockets[0];
  assert.exists(first);
  return { key, sockets, callbacks, owner, first };
}

describe("native live verification", () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const check = vi.fn<SignatureVerifier>(async (claims) => {
      await promise;
      return nativeSignatureChecks({ claims });
    });
    return { check, release };
  }
  const channelRequest = (socket: Socket) => {
    const route = socket
      .requests()
      .find((request) => scopeOf(request).includes("a"));
    assert.exists(route);
    return route;
  };

  it("batches a burst without JS signatures and delivers valid events before EOSE and CLOSED", async () => {
    const host = gate();
    const h = setup(["a"], undefined, undefined, undefined, host.check);
    const delivered: string[] = [];
    h.callbacks.receive.mockImplementation(([event], provenance) =>
      delivered.push(`${event?.content}:${provenance?.phase}`),
    );
    h.callbacks.established.mockImplementation((channel) => {
      if (channel === "a") delivered.push("EOSE");
    });
    try {
      await h.first.auth();
      const route = channelRequest(h.first);
      const first = message(h.key, "a", "first", 1700000000);
      const second = message(h.key, "a", "second", 1700000001);
      const frames = [
        ["EVENT", route[1], first],
        ["EVENT", route[1], { ...first, content: "tampered" }],
        ["EVENT", route[1], { ...second, sig: "0".repeat(128) }],
        ["EVENT", route[1], second],
        ["EOSE", route[1]],
        ["EVENT", route[1], first],
        ["CLOSED", route[1], "restricted: not a channel member"],
        ["EVENT", route[1], second],
      ].map((frame) => h.first.receive(frame));
      vi.mocked(verifyEvent).mockClear();
      await vi.waitFor(() => expect(host.check).toHaveBeenCalledOnce());
      expect(host.check.mock.calls[0]?.[0]).toHaveLength(5);
      expect(delivered).toEqual([]);
      host.release();
      await Promise.all(frames);
      expect(delivered).toEqual([
        "first:replay",
        "second:replay",
        "EOSE",
        "first:live",
      ]);
      expect(h.callbacks.denied).toHaveBeenCalledWith(
        "a",
        "restricted: not a channel member",
      );
      expect(verifyEvent).not.toHaveBeenCalled();
    } finally {
      host.release();
      h.owner.dispose();
    }
  });

  it.each(["retire", "disconnect", "dispose"])(
    "discards native results after %s",
    async (action) => {
      const host = gate();
      const h = setup(["a"], undefined, undefined, undefined, host.check);
      try {
        await h.first.auth();
        const route = channelRequest(h.first);
        const event = message(h.key, "a", "late", 1700000000);
        const frames = [
          h.first.receive(["EVENT", route[1], event]),
          h.first.receive(["EOSE", route[1]]),
        ];
        await vi.waitFor(() => expect(host.check).toHaveBeenCalledOnce());
        if (action === "retire") h.owner.update([]);
        else if (action === "disconnect") h.first.close();
        else h.owner.dispose();
        host.release();
        await host.check.mock.results[0]?.value;
        await Promise.all(frames);
        // Finish the native-result microtasks even when disconnect settled the frames early.
        await yieldToHost();
        expect(h.callbacks.receive).not.toHaveBeenCalled();
        expect(h.callbacks.established).not.toHaveBeenCalledWith("a");
      } finally {
        host.release();
        h.owner.dispose();
      }
    },
  );

  it("recovers a rejected host check without admitting the event or its EOSE", async () => {
    const check = vi
      .fn<SignatureVerifier>(async (claims) =>
        nativeSignatureChecks({ claims }),
      )
      .mockRejectedValueOnce(new Error("host unavailable"));
    const h = setup(["a"], undefined, undefined, undefined, check);
    try {
      await h.first.auth();
      const route = channelRequest(h.first);
      const event = message(h.key, "a", "retry", 1700000000);
      await Promise.all([
        h.first.receive(["EVENT", route[1], event]),
        h.first.receive(["EOSE", route[1]]),
      ]);
      expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("retrying");
      expect(h.callbacks.receive).not.toHaveBeenCalled();
      expect(h.callbacks.established).not.toHaveBeenCalledWith("a");
      h.owner.retry();
      const next = h.sockets[1];
      assert.exists(next);
      await next.auth();
      await next.receive(["EVENT", channelRequest(next)[1], event]);
      expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
        phase: "replay",
        channelId: "a",
      });
    } finally {
      h.owner.dispose();
    }
  });

  it.each(["frames", "bytes"])(
    "bounds pending %s and resumes before undelivered native work",
    async (bound) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const host = gate();
      const h = setup(["a"], undefined, undefined, () => 0, host.check);
      try {
        await h.first.auth();
        for (const req of h.first.requests())
          await h.first.receive(["EOSE", req[1]]);
        const admittedAt = Math.floor(Date.now() / 1000);
        const route = channelRequest(h.first);
        const event = message(h.key, "a", "pending", 1700000000);
        const pending = h.first.receive(["EVENT", route[1], event]);
        await vi.waitFor(() => expect(host.check).toHaveBeenCalledOnce());
        // Control traffic can advance liveness while the native batch is held.
        await vi.advanceTimersByTimeAsync(14 * LIVE_RECOVERY_INTERVAL);
        await h.first.receive(["NOTICE", "still connected"]);
        const count = bound === "frames" ? 32_768 : 38;
        const frame =
          bound === "frames"
            ? ["EOSE", route[1]]
            : ["EVENT", route[1], { ...event, content: "x".repeat(900_000) }];
        await Promise.all([
          pending,
          ...Array.from({ length: count }, () => h.first.receive(frame)),
        ]);
        expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
          status: "retrying",
          error: "Live event verification backlog exceeded",
        });
        h.owner.retry();
        const next = h.sockets[1];
        assert.exists(next);
        await next.auth();
        expect(channelRequest(next)[2].since).toBe(
          Math.max(route[2].since, admittedAt - 960),
        );
        host.release();
        await host.check.mock.results[0]?.value;
        await yieldToHost();
        expect(h.callbacks.receive).not.toHaveBeenCalled();
        await next.receive(["EVENT", channelRequest(next)[1], event]);
        expect(h.callbacks.receive).toHaveBeenCalledOnce();
      } finally {
        host.release();
        h.owner.dispose();
      }
    },
  );
});
/** The relay's member-added notice for `channel` on the viewer's membership
 * route: the one event that makes a live batch re-send its REQ. */
async function grant(
  h: { key: ReturnType<typeof keypair>; first: Socket },
  channel: string,
  socket = h.first,
) {
  const membership = socket
    .requests()
    .find((r) => filtersOf(r)[0]?.kinds.includes(44100));
  assert.exists(membership);
  await socket.receive([
    "EVENT",
    membership[1],
    signed(keypair(), {
      kind: 44100,
      content: "",
      tags: [
        ["p", h.key.pubkey],
        ["h", channel],
      ],
    }),
  ]);
  await vi.advanceTimersByTimeAsync(0);
}
it("uses independent explicit channel routes and self-p globals; equal interests do not restart", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  expect(h.first.requests().map((r) => r[2])).toEqual([
    { kinds: [0, 10100, 30177], since: expect.any(Number), limit: 500 },
    {
      kinds: [44100, 44101],
      "#p": [h.key.pubkey],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: expect.arrayContaining([
        20002, 9, 40002, 40008, 40003, 7, 39002, 40099,
      ]),
      "#h": ["a"],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: expect.arrayContaining([9]),
      "#h": ["b"],
      since: expect.any(Number),
      limit: 500,
    },
  ]);
  // NIP-CL: system channel notices reach only a filter with #t:["system"].
  expect(h.first.requests()[1]?.[3]).toEqual({
    kinds: [44100, 44101],
    "#p": [h.key.pubkey],
    "#t": ["system"],
    since: expect.any(Number),
    limit: 500,
  });
  const before = h.first.sent.length;
  h.owner.update(["b", "a", "a"]);
  expect(h.first.sent).toHaveLength(before);
  const request = h.first.requests()[2];
  assert.exists(request);
  const event = message(keypair(), "a", "incoming", 1700000000);
  await h.first.receive(["EVENT", request[1], event]);
  await h.first.receive(["EOSE", request[1]]);
  expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
    phase: "replay",
    channelId: "a",
  });
  await h.first.receive(["EVENT", request[1], event]);
  expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
    phase: "live",
    channelId: "a",
  });
  expect(h.callbacks.established).toHaveBeenCalledWith("a");
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find(
      (r) => r.channelId === "a",
    ),
  ).toMatchObject({ status: "live", replay: "unknown" });
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])(
  "delivers artifact changes to session consumers through a batched route (%s)",
  async (batched) => {
    vi.useFakeTimers();
    const h = setup([]);
    const relay = keypair();
    const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        h.callbacks.receive.mockImplementation(callbacks.receive);
        h.callbacks.state.mockImplementation(callbacks.state);
        return {
          ...h.owner,
          update: (ids, joined) => h.owner.update(ids, batched ? joined : []),
        };
      },
    });
    try {
      h.callbacks.receive(
        ["notes", "other"].map((id) => roster(relay, id, [h.key.pubkey])),
      );
      const receive = vi.fn();
      owner.session.subscribeLive(receive);
      await h.first.auth();
      const route = h.first
        .requests()
        .find((r) => scopeOf(r).includes("notes"));
      assert.exists(route);
      expect(scopeOf(route)).toHaveLength(batched ? 2 : 1);
      await h.first.receive(["EOSE", route[1]]);
      const author = keypair();
      const event = signed(author, {
        kind: 45010,
        created_at: Math.floor(Date.now() / 1000),
        content: '{"text":"Shared note"}',
        tags: [
          ["ar", "1"],
          ["h", "notes"],
          ["d", crypto.randomUUID()],
          ["type", "example.note"],
          ["title", "Note"],
          ["op", "create"],
        ],
      });
      expect(
        filtersOf(route).some((filter) => matchesEvent(event, filter)),
      ).toBe(true);
      await h.first.receive(["EVENT", route[1], event]);
      expect(receive).toHaveBeenCalledWith({
        events: [event],
        channelId: "notes",
      });
      h.callbacks.receive([roster(relay, "notes", [], event.created_at + 1)]);
      receive.mockClear();
      const afterRemoval = signed(author, {
        kind: event.kind,
        created_at: event.created_at + 2,
        content: '{"text":"After removal"}',
        tags: [
          ...event.tags.map((tag) =>
            tag[0] === "op" ? ["op", "update"] : tag,
          ),
          ["prev", event.id],
        ],
      });
      await h.first.receive(["EVENT", route[1], afterRemoval]);
      expect(receive).not.toHaveBeenCalled();
    } finally {
      owner.dispose();
    }
  },
);
it("batches joined background interests without rebalance and fences retired batch wires", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    const joined = Array.from(
      { length: 332 },
      (_, i) => `c${String(i).padStart(3, "0")}`,
    );
    h.owner.prioritize?.(["c331"]);
    h.owner.update([...joined, "preview"], joined);
    await h.first.auth();
    // Each EOSE is the setup completion barrier and releases the next slot.
    for (let i = 0; i < h.first.requests().length; i++)
      await h.first.receive(["EOSE", h.first.requests()[i]?.[1]]);
    const requests = h.first.requests();
    expect(requests).toHaveLength(37);
    const batches = requests.filter((r) => scopeOf(r).length > 1);
    expect(batches.map((r) => scopeOf(r).length).sort((a, b) => a - b)).toEqual(
      [2, ...Array(33).fill(10)],
    );
    for (const r of requests) {
      expect(filtersOf(r).length).toBeLessThanOrEqual(10);
      for (const f of filtersOf(r))
        if (f["#h"]) {
          expect(f["#h"]).toHaveLength(1);
          expect(f.limit).toBe(500);
        }
    }
    expect(
      requests.filter((r) => scopeOf(r).length === 1).map(scopeOf),
    ).toEqual([["preview"]]);
    expect(h.callbacks.established).toHaveBeenCalledTimes(37);
    expect(h.callbacks.state.mock.lastCall?.[0].routes).toHaveLength(335);
    const batch = batches.find((request) => scopeOf(request).includes("c000"));
    assert.exists(batch);
    const first = message(h.key, "c000", "first", 1700000000);
    await h.first.receive(["EVENT", batch[1], first]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([first], {
      phase: "live",
      channelId: "c000",
    });
    const other = message(h.key, "preview", "wrong wire", 1700000001);
    h.callbacks.receive.mockClear();
    await h.first.receive(["EVENT", batch[1], other]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    const typing = signed(h.key, {
      kind: 20002,
      tags: [["h", "c001"]],
      content: "",
    });
    await h.first.receive(["EVENT", batch[1], typing]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([typing], {
      phase: "live",
      channelId: "c001",
    });
    h.owner.prioritize?.(["c001"]);
    expect(h.first.requests()).toHaveLength(37);
    const retained = joined.filter((id) => id !== "c000");
    h.owner.update([...retained, "preview"], retained);
    // Healthy survivors keep one scope and overlap the old wire until EOSE.
    expect(h.first.requests()).toHaveLength(38);
    const replacement = h.first.requests().at(-1);
    assert.exists(replacement);
    expect(replacement[2].limit).toBe(0);
    expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([]);
    await h.first.receive(["EOSE", replacement[1]]);
    expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([
      ["CLOSE", batch[1]],
    ]);
    h.callbacks.receive.mockClear();
    h.callbacks.established.mockClear();
    await h.first.receive(["EVENT", batch[1], first]);
    await h.first.receive(["EOSE", batch[1]]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    expect(h.callbacks.established).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

describe("per-channel replay allowance", () => {
  const now = 1_700_000_100;
  let hot: ReturnType<typeof message>[];
  beforeAll(() => {
    // Signing also verifies each signature. Keep large fixture construction
    // separate from the behavior budget; socket delivery still verifies all 501
    // distinct received events through the real live/session path.
    const author = keypair();
    hot = Array.from({ length: 501 }, (_, i) =>
      message(author, "hot", `hot-${i}`, now - 1),
    );
  });
  it("keeps quiet-channel unread evidence when another filter fills its replay allowance", async () => {
    vi.useFakeTimers({ now: now * 1000 });
    const h = setup([]);
    const relay = keypair(),
      author = keypair();
    const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        h.callbacks.receive.mockImplementation(callbacks.receive);
        h.callbacks.state.mockImplementation(callbacks.state);
        return h.owner;
      },
    });
    try {
      const ids = ["hot", "quiet"];
      h.callbacks.receive(ids.map((id) => roster(relay, id, [h.key.pubkey])));
      await h.first.auth();
      const batch = h.first
        .requests()
        .find((r) => scopeOf(r).includes("quiet"));
      assert.exists(batch);
      const incoming = vi.fn();
      owner.session.subscribeIncoming(incoming);
      const quiet = signed(author, {
        kind: 9,
        content: "quiet mention",
        created_at: now - 100,
        tags: [
          ["h", "quiet"],
          ["p", h.key.pubkey],
        ],
      });
      const history = [quiet, ...hot];
      // Relay's existing OR contract applies each filter's limit separately.
      // The former multi-h filter loses quiet to the 500 newer hot events.
      const delivered = new Set<string>();
      for (const filter of filtersOf(batch)) {
        const matches = history
          .filter(
            (e) =>
              filter.kinds.includes(e.kind) &&
              e.created_at >= filter.since &&
              e.tags.some(
                ([k, v]) =>
                  k === "h" && v !== undefined && filter["#h"]?.includes(v),
              ),
          )
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit);
        for (const event of matches)
          if (!delivered.has(event.id)) {
            delivered.add(event.id);
            await h.first.receive(["EVENT", batch[1], event]);
          }
      }
      await h.first.receive(["EOSE", batch[1]]);
      expect(delivered.has(quiet.id)).toBe(true);
      expect(delivered.size).toBe(501);
      expect(
        owner.session.unread.snapshot({ kind: "channel", channelId: "hot" }),
      ).toMatchObject({ observedCount: 500, attentionCount: 0 });
      expect(
        owner.session.unread.snapshot({ kind: "channel", channelId: "quiet" }),
      ).toMatchObject({ observedCount: 1, attentionCount: 1 });
      expect(incoming).not.toHaveBeenCalled();
      // Aggregate replay evidence stays conservative for every logical channel.
      expect(
        h.callbacks.state.mock.lastCall?.[0].routes
          .filter((r) => r.channelId)
          .every((r) => r.replay === "limited"),
      ).toBe(true);
    } finally {
      owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("delivers verified live-phase events to subscribeLive, never replay", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const relay = keypair(),
    author = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation(callbacks.state);
      return h.owner;
    },
  });
  try {
    h.callbacks.receive([roster(relay, "a", [h.key.pubkey])]);
    await h.first.auth();
    const initial = h.first.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(initial);
    const live = vi.fn();
    owner.session.subscribeLive(live);
    await h.first.receive([
      "EVENT",
      initial[1],
      message(author, "a", "replayed", 1700000000),
    ]);
    await h.first.receive(["EOSE", initial[1]]);
    expect(live).not.toHaveBeenCalled();
    const fresh = message(author, "a", "fresh", 1700000002);
    await h.first.receive(["EVENT", initial[1], fresh]);
    expect(live).toHaveBeenCalledTimes(1);
    expect(live.mock.calls[0]?.[0]).toMatchObject({
      channelId: "a",
      events: [expect.objectContaining({ id: fresh.id })],
    });
  } finally {
    owner.dispose();
  }
});

it.each(["single", "chained"])(
  "preserves survivor alerts before replacement EOSE and deduplicates the overlapping live copy (%s removal)",
  async (removal) => {
    vi.useFakeTimers();
    const h = setup([]);
    const relay = keypair(),
      author = keypair();
    const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        h.callbacks.receive.mockImplementation(callbacks.receive);
        h.callbacks.state.mockImplementation(callbacks.state);
        return h.owner;
      },
    });
    try {
      h.callbacks.receive(
        ["a", "b", "c"].map((id) => roster(relay, id, [h.key.pubkey])),
      );
      await h.first.auth();
      const initial = h.first.requests().find((r) => scopeOf(r).length === 3);
      assert.exists(initial);
      expect(initial[2].limit).toBe(500);
      await h.first.receive(["EOSE", initial[1]]);
      const incoming = vi.fn();
      owner.session.subscribeIncoming(incoming);
      // Signed membership removes A through the real session's interest callback.
      await h.first.receive([
        "EVENT",
        initial[1],
        roster(relay, "a", [], 1700000001),
      ]);
      let replacement = h.first.requests().at(-1);
      assert.exists(replacement);
      expect(scopeOf(replacement)).toEqual(["b", "c"]);
      expect(filtersOf(replacement)).toEqual([
        expect.objectContaining({
          "#h": ["b", "c"],
          since: initial[2].since,
          limit: 0,
        }),
      ]);
      expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([]);
      if (removal === "chained") {
        const intermediate = replacement;
        // Hold both EOSEs. The original is still the only established source.
        await h.first.receive([
          "EVENT",
          initial[1],
          roster(relay, "b", [], 1700000001),
        ]);
        replacement = h.first.requests().at(-1);
        assert.exists(replacement);
        expect(replacement[2]).toMatchObject({
          "#h": ["c"],
          since: initial[2].since,
          limit: 0,
        });
        expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([
          ["CLOSE", intermediate[1]],
        ]);
        // Superseded EVENT/EOSE/CLOSED frames cannot retire or establish a source.
        h.callbacks.receive.mockClear();
        h.callbacks.established.mockClear();
        await h.first.receive([
          "EVENT",
          intermediate[1],
          message(author, "c", "superseded", 1700000002),
        ]);
        await h.first.receive(["EOSE", intermediate[1]]);
        await h.first.receive([
          "CLOSED",
          intermediate[1],
          "restricted: not a channel member",
        ]);
        expect(h.callbacks.receive).not.toHaveBeenCalled();
        expect(h.callbacks.established).not.toHaveBeenCalled();
        // Count at every sent frame, not only at the end of the handoff.
        const retained = new Set<unknown>();
        for (const [kind, id, filter] of h.first.sent) {
          if (kind === "REQ" && (filter as { "#h"?: string[] })["#h"])
            retained.add(id);
          if (kind === "CLOSE") retained.delete(id);
          expect(retained.size).toBeLessThanOrEqual(2);
        }
      }
      // Replacement-first and original-first orders both produce one incoming item.
      const firstChannel = removal === "chained" ? "c" : "b";
      for (const [first, second, id] of [
        [replacement[1], initial[1], firstChannel],
        [initial[1], replacement[1], "c"],
      ] as const) {
        const event = message(author, id, `fresh-${id}-${first}`, 1700000002);
        await h.first.receive(["EVENT", first, event]);
        await h.first.receive(["EVENT", second, event]);
      }
      expect(
        incoming.mock.calls.map(([events]) => events[0].channelId),
      ).toEqual([firstChannel, "c"]);
      h.callbacks.receive.mockClear();
      for (const id of removal === "chained" ? ["a", "b"] : ["a"])
        for (const source of [initial, replacement])
          await h.first.receive([
            "EVENT",
            source[1],
            message(author, id, "retired", 1700000003),
          ]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
      // Re-adding A creates a new lifetime; the old scope must stay retired for A.
      h.callbacks.receive([roster(relay, "a", [h.key.pubkey], 1700000004)]);
      h.callbacks.receive.mockClear();
      await h.first.receive([
        "EVENT",
        initial[1],
        message(author, "a", "old lifetime", 1700000005),
      ]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
      const latest = h.first.requests().at(-1);
      assert.exists(latest);
      await h.first.receive(["EOSE", latest[1]]);
      expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
    } finally {
      owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("renews with one bounded overlap and releases both wires on timeout and disposal", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a", "b", "c"], ["a", "b", "c"]);
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const initial = h.first.requests()[2];
    assert.exists(initial);
    // A healthy batch is never re-sent on a timer.
    await vi.advanceTimersByTimeAsync(180000);
    expect(h.first.requests()).toHaveLength(3);
    await grant(h, "b");
    const renewal = h.first.requests().at(-1);
    assert.exists(renewal);
    expect(h.first.requests()).toHaveLength(4);
    expect(scopeOf(renewal)).toEqual(["a", "b", "c"]);
    expect(filtersOf(renewal)).toEqual([
      expect.objectContaining({
        "#h": ["a", "b", "c"],
        kinds: initial[2].kinds,
        limit: 0,
        since: initial[2].since,
      }),
    ]);
    expect(
      h.first.sent.filter((frame) => frame[0] === "CLOSE" && !isProbe(frame)),
    ).toEqual([]);
    const event = message(h.key, "b", "fresh", 1700000000);
    await h.first.receive(["EVENT", renewal[1], event]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
      phase: "live",
      channelId: "b",
    });
    // Removal during a pending renewal never stacks a third retained wire.
    h.owner.update(["b", "c"], ["b", "c"]);
    const survivor = h.first.requests().at(-1);
    assert.exists(survivor);
    expect(
      h.first.sent.filter((frame) => frame[0] === "CLOSE" && !isProbe(frame)),
    ).toEqual([["CLOSE", renewal[1]]]);
    h.callbacks.receive.mockClear();
    await h.first.receive(["EVENT", initial[1], event]);
    expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
      phase: "live",
      channelId: "b",
    });
    h.callbacks.receive.mockClear();
    await h.first.receive([
      "EVENT",
      initial[1],
      message(h.key, "a", "removed", 1700000001),
    ]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    await h.first.receive(["EOSE", renewal[1]]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.first.sent).toContainEqual(["CLOSE", survivor[1]]);
    expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes
        .filter((r) => r.channelId)
        .every((r) => r.status === "error"),
    ).toBe(true);
    h.owner.retry();
    const retry = h.first.requests().at(-1);
    assert.exists(retry);
    expect(filtersOf(retry)).toEqual(filtersOf(survivor));
    expect(filtersOf(retry)).toHaveLength(1);
    expect(retry[2]).toMatchObject({ "#h": ["b", "c"], limit: 0 });
    await h.first.receive([
      "CLOSED",
      retry[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    const quotaRetry = h.first.requests().at(-1);
    assert.exists(quotaRetry);
    expect(filtersOf(quotaRetry)).toEqual(filtersOf(retry));
    await h.first.receive(["EOSE", quotaRetry[1]]);
    const settled = h.first.requests().length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.first.requests()).toHaveLength(settled);
    await grant(h, "c");
    const nextRenewal = h.first.requests().at(-1);
    assert.exists(nextRenewal);
    expect(h.first.requests()).toHaveLength(settled + 1);
    expect(filtersOf(nextRenewal)).toEqual(filtersOf(retry));
  } finally {
    h.owner.dispose();
  }
  expect(h.first.readyState).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("re-sends only the batches a grant names, and once more after an in-flight REQ", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `c${String(i).padStart(2, "0")}`,
    );
    h.owner.update(ids, ids);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const [first, second] = h.first
      .requests()
      .filter((r) => scopeOf(r).length > 1);
    assert.exists(first);
    assert.exists(second);
    expect(scopeOf(second)).toEqual(["c10", "c11"]);
    // "c11" is granted while the second batch's REQ waits for EOSE: the relay
    // may have checked access before the grant, so it is re-sent after EOSE.
    for (const r of h.first.requests())
      if (r !== second) await h.first.receive(["EOSE", r[1]]);
    const count = h.first.requests().length;
    await grant(h, "c11");
    expect(h.first.requests()).toHaveLength(count);
    await h.first.receive(["EOSE", second[1]]);
    expect(h.first.requests()).toHaveLength(count + 1);
    expect(h.first.requests().at(-1)?.[2]).toMatchObject({
      "#h": ["c10", "c11"],
      limit: 0,
    });
    await h.first.receive(["EOSE", h.first.requests().at(-1)?.[1]]);
    // A grant that fails and is retried after the grant needs no re-send.
    const retried = h.first.requests().length;
    await grant(h, "c10");
    expect(h.first.requests()).toHaveLength(retried + 1);
    const failing = h.first.requests().at(-1);
    assert.exists(failing);
    await grant(h, "c11");
    await h.first.receive([
      "CLOSED",
      failing[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    const retry = h.first.requests().at(-1);
    assert.exists(retry);
    expect(retry[1]).not.toBe(failing[1]);
    await h.first.receive(["EOSE", retry[1]]);
    expect(h.first.requests().slice(retried).map(scopeOf)).toEqual([
      ["c10", "c11"],
      ["c10", "c11"],
    ]);
    // Each notice is its own socket message. The first re-sends the batch at
    // once; the second, while that REQ is in flight, re-sends it at its EOSE.
    // Other batches stay put.
    const before = h.first.requests().length;
    const membership = h.first
      .requests()
      .find((r) => filtersOf(r)[0]?.kinds.includes(44100));
    assert.exists(membership);
    const notice = (kind: number, channel: string) =>
      signed(keypair(), {
        kind,
        content: "",
        tags: [
          ["p", h.key.pubkey],
          ["h", channel],
        ],
      });
    await h.first.receive(["EVENT", membership[1], notice(44100, "c01")]);
    await h.first.receive(["EVENT", membership[1], notice(44100, "c02")]);
    expect(h.first.requests()).toHaveLength(before + 1);
    await h.first.receive(["EOSE", h.first.requests().at(-1)?.[1]]);
    await h.first.receive(["EOSE", h.first.requests().at(-1)?.[1]]);
    expect(h.first.requests().slice(before).map(scopeOf)).toEqual([
      ids.slice(0, 10),
      ids.slice(0, 10),
    ]);
    // A removal, or a grant for a channel in no batch, sends nothing.
    const settled = h.first.requests().length;
    await h.first.receive(["EVENT", membership[1], notice(44101, "c03")]);
    await grant(h, "elsewhere");
    expect(h.first.requests()).toHaveLength(settled);
  } finally {
    h.owner.dispose();
  }
});

it("re-sends a batch with no grant after the slow refresh interval", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a", "b"], ["a", "b"]);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const batches = () =>
      h.first.requests().filter((r) => scopeOf(r).length > 1);
    expect(batches()).toHaveLength(1);
    // A lost grant must not leave the batch narrow for good.
    await vi.advanceTimersByTimeAsync(LIVE_BATCH_REFRESH_INTERVAL - 60_000);
    expect(batches()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(batches()).toHaveLength(2);
    expect(batches().at(-1)?.[2]).toMatchObject({ "#h": ["a", "b"], limit: 0 });
    await h.first.receive(["EOSE", batches().at(-1)?.[1]]);
    // A grant re-send restarts the interval.
    await vi.advanceTimersByTimeAsync(LIVE_BATCH_REFRESH_INTERVAL / 2);
    await grant(h, "a");
    expect(batches()).toHaveLength(3);
    await h.first.receive(["EOSE", batches().at(-1)?.[1]]);
    await vi.advanceTimersByTimeAsync(LIVE_BATCH_REFRESH_INTERVAL - 60_000);
    expect(batches()).toHaveLength(3);
    // The next tick after the interval re-sends it.
    await vi.advanceTimersByTimeAsync(LIVE_RECOVERY_INTERVAL * 2);
    expect(batches()).toHaveLength(4);
  } finally {
    h.owner.dispose();
  }
});

it.each(["timeout", "error: temporarily unavailable"])(
  "retains unchanged live coverage after renewal %s and retries on the minute boundary",
  async (failure) => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      h.owner.update(["a", "b"], ["a", "b"]);
      await h.first.auth();
      for (const [, id] of h.first.requests())
        await h.first.receive(["EOSE", id]);
      const initial = h.first.requests()[2];
      assert.exists(initial);
      await grant(h, "a");
      const renewal = h.first.requests().at(-1);
      assert.exists(renewal);
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(10000);
      else await h.first.receive(["CLOSED", renewal[1], failure]);
      expect(h.first.sent).toContainEqual(["CLOSE", renewal[1]]);
      expect(h.first.sent).not.toContainEqual(["CLOSE", initial[1]]);
      expect(
        h.callbacks.state.mock.lastCall?.[0].routes.filter((r) => r.channelId),
      ).toEqual(
        ["a", "b"].map((channelId) =>
          expect.objectContaining({
            channelId,
            status: "error",
            error: expect.any(String),
          }),
        ),
      );
      const event = message(h.key, "b", "still live", 1700000001);
      h.callbacks.receive.mockClear();
      h.callbacks.established.mockClear();
      await h.first.receive(["EVENT", renewal[1], event]);
      await h.first.receive(["EOSE", renewal[1]]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
      expect(h.callbacks.established).not.toHaveBeenCalled();
      await h.first.receive(["EVENT", initial[1], event]);
      expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
        phase: "live",
        channelId: "b",
      });
      await vi.advanceTimersByTimeAsync(failure === "timeout" ? 49999 : 59999);
      expect(h.first.requests()).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      const retry = h.first.requests().at(-1);
      assert.exists(retry);
      expect(h.first.requests()).toHaveLength(5);
      expect(filtersOf(retry)).toEqual(filtersOf(renewal));
      expect(
        h.callbacks.state.mock.lastCall?.[0].routes.find(
          (r) => r.channelId === "b",
        ),
      ).toMatchObject({ status: "live", error: expect.any(String) });
      await h.first.receive(["EOSE", retry[1]]);
      expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
      const state = h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.channelId === "b",
      );
      expect(state?.status).toBe("live");
      expect(state?.error).toBeUndefined();
      h.callbacks.receive.mockClear();
      await h.first.receive(["EVENT", initial[1], event]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["recover", "exhaust", "unsupported"])(
  "retains coverage through renewal quota %s without resetting retry limits",
  async (outcome) => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      h.owner.update(["a", "b"], ["a", "b"]);
      await h.first.auth();
      for (const [, id] of h.first.requests())
        await h.first.receive(["EOSE", id]);
      const initial = h.first.requests()[2];
      assert.exists(initial);
      await grant(h, "a");
      for (let i = 0; i < (outcome === "exhaust" ? 4 : 1); i++) {
        const renewal = h.first.requests().at(-1);
        assert.exists(renewal);
        const count = h.first.requests().length;
        await h.first.receive([
          "CLOSED",
          renewal[1],
          `rate-limited: quota exceeded; retry in ${outcome === "unsupported" ? 120 : 2}s`,
        ]);
        const event = message(
          h.key,
          "b",
          `during cooldown ${i}`,
          1700000001 + i,
        );
        await h.first.receive(["EVENT", initial[1], event]);
        expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
          phase: "live",
          channelId: "b",
        });
        expect(h.first.sent).not.toContainEqual(["CLOSE", initial[1]]);
        // Admission includes one safety second for the relay's rounded hint.
        await vi.advanceTimersByTimeAsync(2999);
        expect(h.first.requests()).toHaveLength(count);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.first.requests()).toHaveLength(
          outcome === "unsupported" || i === 3 ? count : count + 1,
        );
      }
      if (outcome === "recover") {
        const retry = h.first.requests().at(-1);
        assert.exists(retry);
        await h.first.receive(["EOSE", retry[1]]);
        expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
      } else {
        const count = h.first.requests().length;
        await vi.advanceTimersByTimeAsync(180000);
        expect(h.first.requests()).toHaveLength(count);
        expect(
          h.callbacks.state.mock.lastCall?.[0].routes.find(
            (r) => r.channelId === "b",
          ),
        ).toMatchObject({
          status: "error",
          error: expect.stringContaining("rate-limited:"),
        });
        const event = message(h.key, "b", "after stopped retries", 1700000010);
        await h.first.receive(["EVENT", initial[1], event]);
        expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
          phase: "live",
          channelId: "b",
        });
        h.owner.retry();
        expect(h.first.requests()).toHaveLength(count + 1);
      }
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("replaces an open socket that stops answering and replays what it missed", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a", "b"], ["a", "b"]);
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    // Writes still succeed, but nothing comes back: no error, no close.
    h.first.silent = true;
    await vi.advanceTimersByTimeAsync(60000);
    // Renewals were answered before this minute, so no probe yet.
    expect(h.first.probes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.first.probes()).toHaveLength(1);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
    expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
      status: "retrying",
      error: "Live connection stopped answering",
    });
    await vi.advanceTimersByTimeAsync(1000);
    const next = h.sockets[1];
    assert.exists(next);
    expect(h.first.readyState).toBe(3);
    await next.auth();
    // The new routes reach back past the silence, so its traffic replays.
    const silentSince = Math.floor(Date.now() / 1000) - 131;
    const batch = next.requests().find((r) => scopeOf(r).includes("b"));
    assert.exists(batch);
    expect(filtersOf(batch)[0]?.since).toBeLessThanOrEqual(silentSince);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a quiet socket that answers its probes", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    await vi.advanceTimersByTimeAsync(10 * 60000);
    expect(h.sockets).toHaveLength(1);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    // Each answered probe is closed, so none stays open on the relay.
    const probes = h.first.probes().map(([, id]) => id);
    expect(probes.length).toBeGreaterThan(0);
    for (const id of probes) expect(h.first.sent).toContainEqual(["CLOSE", id]);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces a socket that looks open but does not answer a wake check", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    // Asleep, the socket died without a close; writes still appear to succeed.
    h.first.silent = true;
    await vi.advanceTimersByTimeAsync(20_000);
    h.owner.check?.();
    expect(h.first.probes()).toHaveLength(1);
    // A frame handled now may have waited through the sleep: it is no answer.
    await h.first.receive(["NOTICE", "queued before sleep"]);
    await vi.advanceTimersByTimeAsync(LIVE_CHECK_TIMEOUT_MS - 1);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    // A second hint while one is pending sends nothing more.
    h.owner.check?.();
    expect(h.first.probes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
      status: "retrying",
      error: "Live connection did not answer a wake check",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sockets).toHaveLength(2);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a socket that answers a wake check, and skips one it just heard", async () => {
  vi.useFakeTimers();
  const admission = createLiveAdmission();
  const h = setup(["a"], admission);
  try {
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    // Not yet admitted sockets and relay cooldowns send no probe.
    admission.pause(10);
    h.owner.check?.();
    expect(h.first.probes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(11_000);
    h.owner.check?.();
    expect(h.first.probes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIVE_CHECK_TIMEOUT_MS);
    expect(h.sockets).toHaveLength(1);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    // Focus can fire often; an answer this fresh already proves the socket.
    h.owner.check?.();
    expect(h.first.probes()).toHaveLength(1);
    // A network change voids that proof.
    h.owner.check?.(true);
    expect(h.first.probes()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    h.owner.check?.();
    expect(h.first.probes()).toHaveLength(3);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a relay cooldown that a probe was refused with", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    h.first.silent = true;
    await vi.advanceTimersByTimeAsync(120000);
    const probe = h.first.probes().at(-1);
    assert.exists(probe);
    await h.first.receive([
      "CLOSED",
      probe[1],
      "rate-limited: quota exceeded; retry in 30s",
    ]);
    // The refusal is an answer, so the socket stays.
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
    expect(h.sockets).toHaveLength(1);
    const count = h.first.requests().length;
    h.owner.update(["a", "b"]);
    await vi.advanceTimersByTimeAsync(20000 - SETUP_TIMEOUT_MS);
    expect(h.first.requests()).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(12000);
    expect(
      h.first.requests().filter((r) => scopeOf(r).includes("b")),
    ).not.toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("sends no probe while the relay asked it to wait", async () => {
  vi.useFakeTimers();
  const admission = createLiveAdmission();
  const h = setup(["a"], admission);
  try {
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    admission.pause(300);
    await vi.advanceTimersByTimeAsync(5 * 60000);
    expect(h.first.probes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.first.probes()).toHaveLength(1);
    expect(h.sockets).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["previous closed", "restricted: not a channel member"])(
  "does not preserve a renewal source after %s",
  async (failure) => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      h.owner.update(["a", "b"], ["a", "b"]);
      await h.first.auth();
      for (const [, id] of h.first.requests())
        await h.first.receive(["EOSE", id]);
      const initial = h.first.requests()[2];
      assert.exists(initial);
      await vi.advanceTimersByTimeAsync(60000);
      const renewal = h.first.requests().at(-1);
      assert.exists(renewal);
      if (failure === "previous closed") {
        await h.first.receive(["CLOSED", initial[1], "error: closed"]);
        await vi.advanceTimersByTimeAsync(10000);
      } else await h.first.receive(["CLOSED", renewal[1], failure]);
      expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
      expect(h.first.sent).toContainEqual(["CLOSE", renewal[1]]);
      const count = h.first.requests().length;
      await vi.advanceTimersByTimeAsync(120000);
      expect(h.first.requests()).toHaveLength(count);
      h.callbacks.receive.mockClear();
      await h.first.receive([
        "EVENT",
        initial[1],
        message(h.key, "b", "stale", 1700000001),
      ]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
      if (failure.startsWith("restricted:"))
        expect(h.callbacks.denied.mock.calls.map(([id]) => id)).toEqual([
          "a",
          "b",
        ]);
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

function captureLog() {
  const logger = getLogger("relay-ws");
  const reporters = [...logger.options.reporters];
  const lines: string[] = [];
  logger.setReporters([
    { log: (value) => lines.push(`${value.type} ${value.args.join(" ")}`) },
  ]);
  return {
    lines,
    restore: () => logger.setReporters(reporters),
  };
}

it("verifies a reconnect's replayed events once and still rejects a changed copy", async () => {
  vi.useFakeTimers();
  const h = setup(["a"], undefined, undefined, () => 0.5);
  const log = captureLog();
  try {
    await h.first.auth();
    const route = h.first.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(route);
    const event = message(keypair(), "a", "heard before the drop", 1700000000);
    vi.mocked(verifyEvent).mockClear();
    await h.first.receive(["EVENT", route[1], event]);
    expect(verifyEvent).toHaveBeenCalledTimes(1);
    await h.first.receive(["EOSE", route[1]]);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    const replay = next.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(replay);
    vi.mocked(verifyEvent).mockClear();
    h.callbacks.receive.mockClear();
    // The resume window sends it again, as fresh wire bytes.
    await next.receive(["EVENT", replay[1], JSON.parse(JSON.stringify(event))]);
    expect(verifyEvent).not.toHaveBeenCalled();
    expect(h.callbacks.receive).toHaveBeenCalledWith(
      [event],
      expect.anything(),
    );
    h.callbacks.receive.mockClear();
    await next.receive([
      "EVENT",
      replay[1],
      { ...event, content: "changed under the same id and signature" },
    ]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    expect(log.lines).toContain(
      "warn relay.test dropped an undecodable live event",
    );
  } finally {
    log.restore();
    h.owner.dispose();
  }
});

it("drops one undecodable event and keeps its batch route", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const log = captureLog();
  try {
    h.owner.update(["a", "b"], ["a", "b"]);
    await h.first.auth();
    const batch = h.first.requests().find((r) => scopeOf(r).length === 2);
    assert.exists(batch);
    await h.first.receive(["EVENT", batch[1], {}]);
    expect(log.lines).toEqual([
      "warn relay.test dropped an undecodable live event",
    ]);
    await h.first.receive(["EOSE", batch[1]]);
    const event = message(h.key, "a", "after the bad one", 1700000000);
    await h.first.receive(["EVENT", batch[1], event]);
    expect(h.callbacks.receive).toHaveBeenCalledWith(
      [event],
      expect.anything(),
    );
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes
        .filter((r) => r.channelId === "a" || r.channelId === "b")
        .map((r) => r.status),
    ).toEqual(["live", "live"]);
  } finally {
    log.restore();
    h.owner.dispose();
  }
});

it("retries a route closed with a needs-action reason on the recover tick, backing off, and resets once live", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a"], ["a"]);
    await h.first.auth();
    const route = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.channelId === "a",
      );
    const refuse = async () => {
      const request = h.first.requests().at(-1);
      assert.exists(request);
      await h.first.receive(["CLOSED", request[1], "auth-required: sign in"]);
      expect(route()).toMatchObject({
        status: "error",
        error: "auth-required: sign in",
      });
      return request;
    };
    // The first refusal waits one recover tick; each next one doubles.
    for (const wait of [60_000, 120_000, 240_000]) {
      const count = h.first.requests().length;
      await refuse();
      await vi.advanceTimersByTimeAsync(wait - 60_000 + 59_999);
      expect(h.first.requests()).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.first.requests()).toHaveLength(count + 1);
      // Retried routes keep showing the last refusal until EOSE.
      expect(route()).toMatchObject({
        status: "pending",
        error: "auth-required: sign in",
      });
    }
    const request = h.first.requests().at(-1);
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
    expect(route()?.status).toBe("live");
    const count = h.first.requests().length;
    await refuse();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.first.requests()).toHaveLength(count + 1);
    expect(liveSlowRetryDelay(1)).toBe(60_000);
    expect(liveSlowRetryDelay(100)).toBe(600_000);
  } finally {
    h.owner.dispose();
  }
});

it("a cooldown stop after a manual retry is not revived by the earlier refusal's deadline", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    const wire = (channel: string) =>
      h.first
        .requests()
        .filter((r) => (r[2] as { "#h"?: string[] })["#h"]?.[0] === channel);
    const [a] = wire("a");
    const [b] = wire("b");
    const [observer] = h.first.requests();
    assert.exists(a);
    assert.exists(b);
    assert.exists(observer);
    await h.first.receive(["CLOSED", a[1], "auth-required: sign in"]);
    // Hold the queue so the retried route waits for admission.
    await h.first.receive([
      "CLOSED",
      b[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    h.owner.retry();
    await h.first.receive([
      "CLOSED",
      observer[1],
      "rate-limited: quota exceeded; retry in 120s",
    ]);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.channelId === "a",
      ),
    ).toMatchObject({
      status: "error",
      error: "Unsupported live cooldown; automatic setup stopped",
    });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(wire("a")).toHaveLength(1);
    expect(wire("b")).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("keeps the recover tick running when its hook throws, and logs the failure", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const log = captureLog();
  const recover = vi.fn(() => {
    throw new Error("hook failed");
  });
  Object.assign(h.callbacks, { recover });
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(log.lines.filter((line) => line.startsWith("error "))).toHaveLength(
      3,
    );
  } finally {
    log.restore();
    h.owner.dispose();
  }
});

it("applies a batch denial through the session before rescheduling surviving interests", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const relay = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation(callbacks.state);
      h.callbacks.denied.mockImplementation(callbacks.denied);
      return h.owner;
    },
  });
  try {
    h.callbacks.receive(
      ["a", "b", "c"].map((id) => roster(relay, id, [h.key.pubkey])),
    );
    await h.first.auth();
    const batch = h.first.requests().find((r) => scopeOf(r).length === 3);
    assert.exists(batch);
    await h.first.receive([
      "CLOSED",
      batch[1],
      "restricted: not a channel member",
    ]);
    expect(owner.session.channels.list().channels).toEqual([]);
    expect(h.callbacks.denied.mock.calls.map(([id]) => id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(h.first.requests().filter((r) => r[2]["#h"])).toHaveLength(1);
  } finally {
    owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("batch denial does not cross a synchronous removal and re-addition", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a", "b", "c"], ["a", "b", "c"]);
    await h.first.auth();
    const batch = h.first.requests().find((r) => scopeOf(r).length === 3);
    assert.exists(batch);
    h.callbacks.denied.mockImplementation((id) => {
      if (id === "a") {
        h.owner.update(["c"], ["c"]);
        h.owner.update(["b", "c"], ["b", "c"]);
      } else h.owner.update(["b"], ["b"]);
    });
    await h.first.receive([
      "CLOSED",
      batch[1],
      "restricted: not a channel member",
    ]);
    expect(h.callbacks.denied.mock.calls.map(([id]) => id)).toEqual(["a", "c"]);
    expect(
      h.first
        .requests()
        .filter((r) => r[2]["#h"])
        .map(scopeOf),
    ).toEqual([["a", "b", "c"], ["b"]]);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("isolates denial, fences removed/readded routes and late sockets, and disposes retries", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const a = h.first.requests()[2],
    b = h.first.requests()[3];
  assert.exists(a);
  assert.exists(b);
  await h.first.receive(["CLOSED", a[1], "restricted: not a channel member"]);
  expect(h.callbacks.denied).toHaveBeenCalledWith(
    "a",
    "restricted: not a channel member",
  );
  expect(h.first.readyState).toBe(1);
  await h.first.receive(["EOSE", b[1]]);
  h.owner.update(["b"]);
  h.owner.update(["a", "b"]);
  await vi.advanceTimersByTimeAsync(250);
  const fresh = h.first.requests().at(-1);
  assert.exists(fresh);
  expect(fresh[1]).not.toBe(a[1]);
  await h.first.receive(["EVENT", a[1], message(h.key, "a", "stale", 1)]);
  await h.first.receive(["CLOSED", a[1], "restricted: not a channel member"]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  expect(h.callbacks.denied).toHaveBeenCalledTimes(1);
  h.first.close();
  await vi.advanceTimersByTimeAsync(500);
  expect(h.sockets).toHaveLength(2);
  await h.first.receive(["EVENT", b[1], message(h.key, "b", "old socket", 2)]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  h.owner.dispose();
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.sockets).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("restores prompt reconnects after each healthy connection across repeated rollouts", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    for (let cycle = 0; cycle < 7; cycle++) {
      const socket = h.sockets[cycle];
      assert.exists(socket);
      await socket.auth();
      await vi.advanceTimersByTimeAsync(750);
      for (const request of socket.requests())
        await socket.receive(["EOSE", request[1]]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
      socket.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(h.sockets).toHaveLength(cycle + 2);
    }
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([0, 0.5])(
  "keeps jittered recovery capped through auth flaps and a prolonged outage (random=%s)",
  async (sample) => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(sample);
    const h = setup([]);
    try {
      const ceilings = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000];
      for (const [cycle, ceiling] of ceilings.entries()) {
        const socket = h.sockets[cycle];
        assert.exists(socket);
        // Authentication alone must not reset backoff on a flapping relay.
        if (cycle < 4) await socket.auth();
        socket.close();
        const delay = ceiling * (0.5 + sample / 2);
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(h.sockets).toHaveLength(cycle + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.sockets).toHaveLength(cycle + 2);
      }
      const recovered = h.sockets.at(-1);
      assert.exists(recovered);
      await recovered.auth();
      await vi.advanceTimersByTimeAsync(750);
      for (const request of recovered.requests())
        await recovered.receive(["EOSE", request[1]]);
      expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
      expect(h.callbacks.established).toHaveBeenCalled();
      // Cancel a retry at the capped delay, not just the initial short delay.
      recovered.close();
      h.owner.dispose();
      await vi.advanceTimersByTimeAsync(60000);
      expect(h.sockets).toHaveLength(9);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.owner.dispose();
      random.mockRestore();
    }
  },
);

it.each([
  [
    "resumes sixteen minutes before the connection last heard",
    1000,
    5000,
    4040,
  ],
  ["never reaches back past the original window", 1000, 1500, 1000],
  ["keeps the original window at its edge", 1000, 1960, 1000],
  ["moves past the original window one second later", 1000, 1961, 1001],
] as const)("liveResumeSince: %s", (_name, original, liveUntil, expected) => {
  expect(liveResumeSince(original, { liveUntil })).toBe(expected);
});

it.each([
  ["a restarting relay is spread from zero", 1012, 500, 0, 0],
  ["going away is spread the same way", 1001, 500, 0.5, 5000],
  ["the spread stays under its bound", 1012, 500, 0.999, 9990],
  [
    "repeated bounces widen the spread with the backoff",
    1012,
    16000,
    0.5,
    8000,
  ],
  ["other closes back off at half the backoff", 1006, 500, 0, 250],
  ["other closes back off at three quarters", undefined, 500, 0.5, 375],
  ["other closes back off at most the backoff", 1000, 8000, 1, 8000],
] as const)(
  "liveReconnectDelay: %s",
  (_name, code, backoff, sample, expected) => {
    expect(liveReconnectDelay(code, backoff, () => sample)).toBeCloseTo(
      expected,
      6,
    );
  },
);

// A session older than the resume lag, so a cursor is not held back by the
// session's first window. Timers keep their offsets.
const age = () => vi.setSystemTime(Date.now() + 2_000_000);
// A refusal the relay retries on the same socket after the pause it names.
const REFUSED = "rate-limited: quota exceeded; retry in 0s";
const isProfiles = (r: WireRequest) =>
  filtersOf(r)[0]?.kinds?.includes(0) === true;
const sinceOf = (socket: Socket, match: (r: WireRequest) => boolean) =>
  filtersOf(socket.requests().find(match) as WireRequest).map((f) => f.since);

it("resumes a rebuilt route sixteen minutes before its connection last heard the relay, and only if it reached EOSE", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a", "b"], undefined, undefined, () => 0.5);
  try {
    age();
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const [profiles, membership, a, b] = h.first.requests();
    assert.exists(profiles);
    assert.exists(membership);
    assert.exists(a);
    assert.exists(b);
    // Established: profiles and "a". Still replaying at the close: membership and "b".
    await h.first.receive(["EOSE", profiles[1]]);
    await h.first.receive(["EOSE", a[1]]);
    const heard = Math.floor(Date.now() / 1000);
    await vi.advanceTimersByTimeAsync(30_000);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const first = Math.floor(Date.now() / 1000) - 300;
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    // Reaches back past an event stored just after the close and backdated by
    // the relay's full 900s drift.
    expect(sinceOf(next, (r) => scopeOf(r).includes("a"))).toEqual([
      heard - 960,
    ]);
    expect(
      sinceOf(next, (r) => filtersOf(r)[0]?.kinds.includes(0) === true)[0],
    ).toBe(heard - 960);
    // Never established on any connection: the five-minute window.
    expect(sinceOf(next, (r) => scopeOf(r).includes("b"))).toEqual([first]);
    expect(
      sinceOf(next, (r) => filtersOf(r)[0]?.kinds.includes(44100) === true)[0],
    ).toBe(first);
  } finally {
    h.owner.dispose();
  }
});

it("never resumes from before the session's first window", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, undefined, () => 0.5);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(sinceOf(next, (r) => scopeOf(r).includes("a"))).toEqual([
      1_700_000_000 - 300,
    ]);
  } finally {
    h.owner.dispose();
  }
});

it("takes a batch's resume point from its earliest channel", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, undefined, () => 0.5);
  try {
    age();
    h.owner.update(["a", "b"], ["a", "b"]);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const batch = h.first.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(batch);
    await h.first.receive(["EOSE", batch[1]]);
    const heard = Math.floor(Date.now() / 1000);
    h.first.close();
    // "c" joins after the last connection: it has no cursor, and its own
    // window would start later than the cursor of "a".
    h.owner.update(["a", "c"], ["a", "c"]);
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(sinceOf(next, (r) => scopeOf(r).includes("c"))).toEqual([
      heard - 960,
      heard - 960,
    ]);
  } finally {
    h.owner.dispose();
  }
});

it("resumes from when a silent socket last answered, not from when it was replaced", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, undefined, () => 0.5);
  try {
    age();
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const heard = Math.floor(Date.now() / 1000);
    h.first.silent = true;
    // The stall is found by a probe and the socket replaced; wait for that.
    for (let i = 0; i < 300 && h.sockets.length < 2; i++)
      await vi.advanceTimersByTimeAsync(1000);
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(sinceOf(next, (r) => scopeOf(r).includes("a"))).toEqual([
      heard - 960,
    ]);
  } finally {
    h.owner.dispose();
  }
});

/** A joined batch of "a" and "b", established, then renewed by a grant after
 * the next recovery tick. */
async function renewing(h: ReturnType<typeof setup>) {
  age();
  h.owner.update(["a", "b"], ["a", "b"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  for (const [, id] of h.first.requests()) await h.first.receive(["EOSE", id]);
  await vi.advanceTimersByTimeAsync(60_000);
  // The grant is a frame, so it proves the relay up to the tick before it.
  const heard = Math.floor(Date.now() / 1000) - 60;
  await grant(h, "a");
  const renewal = h.first
    .requests()
    .find((r) => scopeOf(r).includes("a") && filtersOf(r)[0]?.limit === 0);
  assert.exists(renewal);
  return { heard, renewal };
}
const batchSince = (socket: Socket, id: string) =>
  sinceOf(socket, (r) => scopeOf(r).includes(id));
async function rebuilt(h: ReturnType<typeof setup>) {
  await vi.advanceTimersByTimeAsync(1000);
  const next = h.sockets[1];
  assert.exists(next);
  await next.auth();
  await vi.advanceTimersByTimeAsync(750);
  return next;
}

it("resumes large live batches and their separate replay from the established cursor", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, 2048, () => 0.5);
  try {
    age();
    const ids = Array.from({ length: 11 }, (_, i) => `channel-${i}`);
    h.owner.update(ids, ids);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (let i = 0; i < h.first.requests().length; i++) {
      const request = h.first.requests()[i];
      assert.exists(request);
      await h.first.receive(["EOSE", request[1]]);
    }
    const heard = Math.floor(Date.now() / 1000);
    h.first.close();
    const next = await rebuilt(h);
    for (let i = 0; i < next.requests().length; i++) {
      const request = next.requests()[i];
      assert.exists(request);
      await next.receive(["EOSE", request[1]]);
    }
    const requests = next
      .requests()
      .filter((r) => scopeOf(r).includes("channel-0"));
    expect(requests).toHaveLength(2);
    expect(
      requests.flatMap(filtersOf).filter((f) => f["#h"]?.includes("channel-0")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ since: heard - 960, limit: 0 }),
        expect.objectContaining({ since: heard - 960, limit: 500 }),
      ]),
    );
  } finally {
    h.owner.dispose();
  }
});

describe("a joined batch over the replay batch size", () => {
  const ids = Array.from({ length: 11 }, (_, i) => `channel-${i}`).sort();
  const isReplay = (request: WireRequest) =>
    scopeOf(request).length > 0 && request[2].limit === 500;
  const channels = (h: ReturnType<typeof setup>) =>
    h.callbacks.established.mock.calls.flatMap((call) =>
      call[0] === undefined ? [] : [call],
    );
  async function eoseAll(socket: Socket) {
    for (let i = 0; i < socket.requests().length; i++) {
      const request = socket.requests()[i];
      assert.exists(request);
      await socket.receive(["EOSE", request[1]]);
    }
  }
  /** The second connection with its live batch at EOSE, replay still open. */
  async function reconnected(h: ReturnType<typeof setup>) {
    age();
    h.owner.update(ids, ids);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    await eoseAll(h.first);
    h.first.close();
    const next = await rebuilt(h);
    h.callbacks.established.mockClear();
    for (const request of [...next.requests()])
      if (!isReplay(request)) await next.receive(["EOSE", request[1]]);
    const replay = next.requests().find(isReplay);
    assert.exists(replay);
    return { next, replay };
  }

  it("establishes each channel when its replay ends, with that replay's continuity", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 2048, () => 0.5);
    try {
      const { next, replay } = await reconnected(h);
      expect(scopeOf(replay)).toEqual(ids);
      // The live batch replays nothing, so its channels wait for the replay.
      expect(channels(h)).toEqual([]);
      await next.receive([
        "EVENT",
        replay[1],
        message(h.key, "channel-1", "a reply", 1_700_002_000, [
          ["e", "root", "", "reply"],
        ]),
      ]);
      await next.receive([
        "EVENT",
        replay[1],
        message(h.key, "channel-2", "a top-level message", 1_700_002_000),
      ]);
      await next.receive(["EOSE", replay[1]]);
      expect(channels(h)).toEqual([
        [ids, undefined, ids.filter((id) => id !== "channel-1")],
      ]);
    } finally {
      h.owner.dispose();
    }
  });

  it("reports a combined replay continuous only for channels it finished on a page below the limit", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 2048, () => 0.5);
    try {
      const { next, replay } = await reconnected(h);
      const now = Math.floor(Date.now() / 1000);
      const author = keypair();
      const held = message(
        author,
        "channel-2",
        "sent in the outage",
        now - 300,
      );
      // Newest first: the reaction is on this page, its target on the next.
      await next.receive([
        "EVENT",
        replay[1],
        signed(author, {
          kind: 7,
          content: "+",
          created_at: now - 1,
          tags: [
            ["h", "channel-2"],
            ["e", held.id],
          ],
        }),
      ]);
      for (let i = 0; i < 499; i++)
        await next.receive([
          "EVENT",
          replay[1],
          message(
            author,
            "channel-0",
            `busy ${i}`,
            now - 2 - Math.floor(i / 4),
          ),
        ]);
      await next.receive(["EOSE", replay[1]]);
      // channel-0 has 499 of the page's 500: its replay continues too.
      const page = next.requests().find((r) => isReplay(r) && r[2].until);
      assert.exists(page);
      expect(channels(h)).toEqual([]);
      await next.receive(["EVENT", page[1], held]);
      await next.receive(["EOSE", page[1]]);
      expect(channels(h)).toEqual([
        [ids, undefined, ids.filter((id) => id !== "channel-2")],
      ]);
    } finally {
      h.owner.dispose();
    }
  });

  it("does not report a channel continuous when the limit cut its replay", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 2048, () => 0.5);
    try {
      const { next, replay } = await reconnected(h);
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 500; i++)
        await next.receive([
          "EVENT",
          replay[1],
          message(h.key, "channel-0", `busy ${i}`, now - 1 - Math.floor(i / 4)),
        ]);
      await next.receive(["EOSE", replay[1]]);
      expect(channels(h)).toEqual([[["channel-0"]]]);
      const page = next.requests().find((r) => isReplay(r) && r[2].until);
      assert.exists(page);
      await next.receive(["EOSE", page[1]]);
      const rest = ids.slice(1);
      expect(channels(h)).toEqual([[["channel-0"]], [rest, undefined, rest]]);
    } finally {
      h.owner.dispose();
    }
  });

  it("establishes a channel whose replay failed at once, to catch up", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 2048, () => 0.5);
    try {
      const { next, replay } = await reconnected(h);
      await next.receive(["CLOSED", replay[1], "error: replay unavailable"]);
      expect(channels(h)).toEqual([[ids]]);
    } finally {
      h.owner.dispose();
    }
  });

  it("reports no channel continuous when a grant re-sends the batch during its replay", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 2048, () => 0.5);
    try {
      const { next, replay } = await reconnected(h);
      await grant(h, "channel-3", next);
      const resend = next
        .requests()
        .filter((r) => !isReplay(r) && scopeOf(r).length === ids.length)
        .at(-1);
      assert.exists(resend);
      await next.receive(["EOSE", resend[1]]);
      expect(channels(h)).toEqual([]);
      await next.receive(["EOSE", replay[1]]);
      expect(channels(h)).toEqual([[ids]]);
    } finally {
      h.owner.dispose();
    }
  });

  it("reports no channel continuous when a grant during its retry re-sends the batch during its replay", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 2048, () => 0.5);
    try {
      const { next, replay } = await reconnected(h);
      const batch = next
        .requests()
        .find((r) => !isReplay(r) && scopeOf(r).length === ids.length);
      assert.exists(batch);
      await next.receive(["CLOSED", batch[1], "error: unavailable"]);
      const sent = next.requests().length;
      h.owner.retry();
      await vi.advanceTimersByTimeAsync(0);
      const retry = next
        .requests()
        .slice(sent)
        .find((r) => scopeOf(r).length === ids.length);
      assert.exists(retry);
      // The grant reaches the broker while the retry is in flight: its EOSE
      // re-sends the batch.
      await grant(h, "channel-3", next);
      await next.receive(["EOSE", retry[1]]);
      const resend = next
        .requests()
        .filter((r) => !isReplay(r) && scopeOf(r).length === ids.length)
        .at(-1);
      assert.exists(resend);
      expect(resend[1]).not.toBe(retry[1]);
      await next.receive(["EOSE", resend[1]]);
      await next.receive(["EOSE", replay[1]]);
      expect(channels(h).flatMap((call) => call[0])).toEqual(ids);
      expect(channels(h).some((call) => call[2]?.length)).toBe(false);
    } finally {
      h.owner.dispose();
    }
  });

  it("establishes a channel whose live batch failed during its replay only when the batch is live again", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 2048, () => 0.5);
    try {
      const { next, replay } = await reconnected(h);
      const batch = next
        .requests()
        .find((r) => !isReplay(r) && scopeOf(r).length === ids.length);
      assert.exists(batch);
      await next.receive(["CLOSED", batch[1], "error: unavailable"]);
      await next.receive(["EOSE", replay[1]]);
      // The replay ended, but nothing streams these channels now.
      expect(channels(h)).toEqual([]);
      const sent = next.requests().length;
      h.owner.retry();
      await vi.advanceTimersByTimeAsync(0);
      const retry = next
        .requests()
        .slice(sent)
        .find((r) => scopeOf(r).length === ids.length);
      assert.exists(retry);
      await next.receive(["EOSE", retry[1]]);
      expect(channels(h).flatMap((call) => call[0])).toEqual(ids);
      expect(channels(h).some((call) => call[2]?.length)).toBe(false);
    } finally {
      h.owner.dispose();
    }
  });

  it("keeps the earlier cursor of a channel whose replay a drop interrupted", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 2048, () => 0.5);
    try {
      age();
      h.owner.update(ids, ids);
      await h.first.auth();
      await vi.advanceTimersByTimeAsync(750);
      await eoseAll(h.first);
      const heard = Math.floor(Date.now() / 1000);
      h.first.close();
      const second = await rebuilt(h);
      for (const request of [...second.requests()])
        if (!isReplay(request)) await second.receive(["EOSE", request[1]]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // The drop comes before the replay's EOSE: this connection proved no gap.
      second.close();
      await vi.advanceTimersByTimeAsync(5000);
      const third = h.sockets[2];
      assert.exists(third);
      await third.auth();
      await vi.advanceTimersByTimeAsync(750);
      for (const request of [...third.requests()])
        if (!isReplay(request)) await third.receive(["EOSE", request[1]]);
      const replay = third.requests().find(isReplay);
      assert.exists(replay);
      expect(replay[2]).toMatchObject({ since: heard - 960 });
      h.callbacks.established.mockClear();
      await third.receive(["EOSE", replay[1]]);
      expect(channels(h)).toEqual([[ids, undefined, ids]]);
    } finally {
      h.owner.dispose();
    }
  });
});

it("resumes a joined batch closed during its renewal from the source it kept", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, undefined, () => 0.5);
  try {
    const { heard } = await renewing(h);
    h.first.close();
    expect(batchSince(await rebuilt(h), "a")).toEqual([
      heard - 960,
      heard - 960,
    ]);
  } finally {
    h.owner.dispose();
  }
});

it("resumes a joined batch whose renewal failed but kept its source", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, undefined, () => 0.5);
  try {
    const { heard, renewal } = await renewing(h);
    // After one tick, a frame proves the relay only as far as the AUTH.
    await h.first.receive(["CLOSED", renewal[1], "error: busy"]);
    h.first.close();
    expect(batchSince(await rebuilt(h), "a")).toEqual([
      heard - 960,
      heard - 960,
    ]);
  } finally {
    h.owner.dispose();
  }
});

it("resumes a silent joined batch from its last frame, though its renewal never answered", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, undefined, () => 0.5);
  try {
    age();
    h.owner.update(["a", "b"], ["a", "b"]);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const heard = Math.floor(Date.now() / 1000);
    await grant(h, "a");
    h.first.silent = true;
    for (let i = 0; i < 300 && h.sockets.length < 2; i++)
      await vi.advanceTimersByTimeAsync(1000);
    // A grant renewed the batch before the stall was found.
    expect(
      h.first
        .requests()
        .some((r) => scopeOf(r).includes("a") && filtersOf(r)[0]?.limit === 0),
    ).toBe(true);
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(batchSince(next, "a")).toEqual([heard - 960, heard - 960]);
  } finally {
    h.owner.dispose();
  }
});

it("gives a renewal's kept source no cursor for a channel the renewal dropped", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, undefined, () => 0.5);
  try {
    age();
    h.owner.update(["a", "b"], ["a", "b"]);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const heard = Math.floor(Date.now() / 1000);
    // "b" leaves: the survivor renewal for "a" keeps the source of both.
    h.owner.update(["a"], ["a"]);
    await vi.advanceTimersByTimeAsync(0);
    h.first.close();
    // "b" is back before the rebuild, on its own route, without having
    // streamed since it left.
    h.owner.update(["a", "b"], ["a"]);
    const next = await rebuilt(h);
    expect(batchSince(next, "a")).toEqual([heard - 960]);
    const [since] = batchSince(next, "b");
    expect(since).toBeGreaterThanOrEqual(heard - 300);
  } finally {
    h.owner.dispose();
  }
});

it("resumes a batch rebuilt before its EOSE from the cursor, not the last five minutes", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, undefined, () => 0.5);
  try {
    age();
    h.owner.update(["a", "b", "c"], ["a", "b", "c"]);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const heard = Math.floor(Date.now() / 1000);
    h.first.close();
    // Ten minutes offline, so five minutes back from the reconnect misses a gap.
    vi.setSystemTime(Date.now() + 600_000);
    const next = await rebuilt(h);
    expect(new Set(batchSince(next, "a"))).toEqual(new Set([heard - 960]));
    // "c" leaves the joined set before the batch's EOSE, so the batch is rebuilt.
    h.owner.update(["a", "b", "c"], ["a", "b"]);
    await vi.advanceTimersByTimeAsync(750);
    const batches = next.requests().filter((r) => scopeOf(r).includes("a"));
    expect(batches).toHaveLength(2);
    const [, survivor] = batches as [WireRequest, WireRequest];
    expect(new Set(scopeOf(survivor))).toEqual(new Set(["a", "b"]));
    expect(new Set(filtersOf(survivor).map((f) => f.since))).toEqual(
      new Set([heard - 960]),
    );
  } finally {
    h.owner.dispose();
  }
});

it("does not move the cursor to the wake time for a frame that waited through a sleep", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, undefined, () => 0.5);
  try {
    age();
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const heard = Math.floor(Date.now() / 1000);
    // An hour asleep; a frame queued before it is handled on wake, then the
    // relay's restart close behind it.
    vi.setSystemTime(Date.now() + 3_600_000);
    await h.first.receive(["NOTICE", "queued before the sleep"]);
    h.first.close(1012);
    await vi.advanceTimersByTimeAsync(10_000);
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(sinceOf(next, (r) => scopeOf(r).includes("a"))).toEqual([
      heard - 960,
    ]);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  ["the frame", false],
  ["the late tick", true],
])(
  "a frame handled after a short sleep proves the relay only up to the tick before the latest, whether %s is handled first",
  async (_, tickFirst) => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup(["a"], undefined, undefined, () => 0.5);
    try {
      age();
      await h.first.auth();
      await vi.advanceTimersByTimeAsync(750);
      for (const [, id] of h.first.requests())
        await h.first.receive(["EOSE", id]);
      const ticks: number[] = [];
      for (const _ of [1, 2]) {
        await vi.advanceTimersByTimeAsync(60_000);
        ticks.push(Math.floor(Date.now() / 1000));
        await h.first.receive(["NOTICE", "live"]);
      }
      const [before, last] = ticks;
      assert.exists(before);
      assert.exists(last);
      // Asleep from just after the last tick until 100s after it: a frame
      // queued before the sleep is handled on wake, then the relay's restart
      // close behind it. An event stored then may be backdated past last - 900.
      if (tickFirst) {
        vi.setSystemTime(Date.now() + 40_000);
        await vi.advanceTimersByTimeAsync(60_000);
      } else vi.setSystemTime(Date.now() + 100_000);
      await h.first.receive(["NOTICE", "queued before the sleep"]);
      h.first.close(1012);
      await vi.advanceTimersByTimeAsync(10_000);
      const next = h.sockets[1];
      assert.exists(next);
      await next.auth();
      await vi.advanceTimersByTimeAsync(750);
      const [since] = sinceOf(next, (r) => scopeOf(r).includes("a"));
      expect(since).toBe((tickFirst ? last : before) - 960);
      expect(since).toBeLessThanOrEqual(last - 900);
    } finally {
      h.owner.dispose();
    }
  },
);

it("keeps a route's cursor through a connection that never established it", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, undefined, () => 0.5);
  try {
    age();
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const heard = Math.floor(Date.now() / 1000);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1];
    assert.exists(second);
    // Authenticated, but the relay closes before any route is established.
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    second.close();
    await vi.advanceTimersByTimeAsync(1000);
    const third = h.sockets[2];
    assert.exists(third);
    await third.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(sinceOf(third, (r) => scopeOf(r).includes("a"))).toEqual([
      heard - 960,
    ]);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  [0, false],
  [659, false],
  [660, true],
  [661, true],
] as const)(
  "requires the full resume lag for channel and global continuity at session age %is",
  async (seconds, continuous) => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup(["a"], undefined, 10, () => 0.5);
    try {
      // The original replay starts 300s before startup; the cursor needs another
      // 660s before its full 960s safety window fits beyond that floor.
      vi.setSystemTime(Date.now() + seconds * 1000);
      await establish(h.first);
      h.callbacks.established.mockClear();
      h.first.close();
      await vi.advanceTimersByTimeAsync(500);
      const next = h.sockets[1];
      assert.exists(next);
      await establish(next);
      expect(h.callbacks.established.mock.calls).toEqual([
        [undefined, { route: "profiles", continuous }],
        [undefined, { route: "membership", continuous }],
        continuous ? ["a", undefined, ["a"]] : ["a"],
      ]);
    } finally {
      h.owner.dispose();
    }
  },
);

it("reports a global route continuous only when it resumed from a cursor and its replay stayed under the limit", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, undefined, () => 0.5);
  const globals = () =>
    h.callbacks.established.mock.calls.flatMap(([channels, global]) =>
      channels === undefined ? [global] : [],
    );
  try {
    age();
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    // The first connection has no cursor: its five-minute window proves nothing.
    expect(globals()).toEqual([
      { route: "profiles", continuous: false },
      { route: "membership", continuous: false },
    ]);
    h.callbacks.established.mockClear();
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    const profiles = next.requests().find(isProfiles);
    const membership = next.requests().find((r) => !isProfiles(r));
    assert.exists(profiles);
    assert.exists(membership);
    // The limit cut the profiles replay: there may be more it did not send.
    const event = signed(h.key, {
      kind: 0,
      content: "{}",
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    for (let i = 0; i < 500; i++)
      await next.receive(["EVENT", profiles[1], event]);
    await next.receive(["EOSE", profiles[1]]);
    await next.receive(["EVENT", membership[1], event]);
    await next.receive(["EOSE", membership[1]]);
    expect(globals()).toEqual([
      { route: "profiles", continuous: false },
      { route: "membership", continuous: true },
    ]);
  } finally {
    h.owner.dispose();
  }
});

it("reports per channel which replays closed their gap: a cursor and fewer events than the limit", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, 10, () => 0.5);
  const channels = () =>
    h.callbacks.established.mock.calls.flatMap((call) =>
      call[0] === undefined ? [] : [call],
    );
  // The count is of frames: one signed event per channel set, sent repeatedly.
  const author = keypair(),
    at = 1_700_000_000;
  const inA = message(author, "a", "in a", at),
    inB = message(author, "b", "in b", at),
    inBoth = message(author, "a", "in a and b", at, [["h", "b"]]);
  try {
    age();
    h.owner.update(["a", "b"], ["a", "b"]);
    await establish(h.first);
    // The first connection has no cursor.
    expect(channels()).toEqual([[["a", "b"]]]);
    h.callbacks.established.mockClear();
    h.first.close();
    // Joined while the stream is down: c has no cursor yet.
    h.owner.update(["a", "b", "c"], ["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    const batch = second.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(batch);
    // One filter and one limit per channel, so the counts are per channel.
    expect(filtersOf(batch).map((filter) => filter.limit)).toEqual([
      500, 500, 500,
    ]);
    for (let i = 0; i < 500; i++)
      await second.receive(["EVENT", batch[1], inA]);
    for (let i = 0; i < 3; i++) await second.receive(["EVENT", batch[1], inB]);
    for (const [, id] of second.requests()) await second.receive(["EOSE", id]);
    // The limit cut a's replay; c had no cursor; b's replay closed its gap.
    expect(channels()).toEqual([[["a", "b", "c"], undefined, ["b"]]]);
    h.callbacks.established.mockClear();
    // The recovery tick's slow live-only batch refresh replays nothing.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const renewal = second
      .requests()
      .find((r) => scopeOf(r).includes("a") && filtersOf(r)[0]?.limit === 0);
    assert.exists(renewal);
    await second.receive(["EOSE", renewal[1]]);
    expect(channels()).toEqual([[["a", "b", "c"]]]);
    h.callbacks.established.mockClear();
    second.close();
    await vi.advanceTimersByTimeAsync(1000);
    const third = h.sockets[2];
    assert.exists(third);
    await third.auth();
    await vi.advanceTimersByTimeAsync(750);
    const next = third.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(next);
    // An event in two channels of the batch counts against both.
    for (let i = 0; i < 499; i++) {
      await third.receive(["EVENT", next[1], inA]);
      await third.receive(["EVENT", next[1], inB]);
    }
    await third.receive(["EVENT", next[1], inBoth]);
    for (const [, id] of third.requests()) await third.receive(["EOSE", id]);
    expect(channels()).toEqual([[["a", "b", "c"], undefined, ["c"]]]);
  } finally {
    h.owner.dispose();
  }
});

it("reports a channel continuous only when the session can apply its whole replay", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, 10, () => 0.5);
  const channels = () =>
    h.callbacks.established.mock.calls.flatMap((call) =>
      call[0] === undefined ? [] : [call],
    );
  const author = keypair(),
    at = 1_700_000_000;
  const ids = ["reply", "old", "order", "plain", "deleted", "edited", "atag"];
  const aux = (channelId: string, kind: number, target: string) =>
    signed(author, {
      kind,
      content: kind === 7 ? "+" : "",
      created_at: at,
      tags: [
        ["h", channelId],
        ["e", target],
      ],
    });
  try {
    age();
    h.owner.update(ids, ids);
    await establish(h.first);
    h.callbacks.established.mockClear();
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    const batch = second.requests().find((r) => scopeOf(r).includes("reply"));
    assert.exists(batch);
    const sent = message(author, "order", "sent in the outage", at - 1);
    for (const event of [
      // A reply changes its root's summary, which no replay carries.
      message(author, "reply", "a reply", at, [["e", "root", "", "reply"]]),
      // An edit or reaction to a message held before the drop applies as is.
      aux("old", 7, "held"),
      aux("edited", 40003, "held"),
      // Newest first: this reaction arrives before the message it targets.
      aux("order", 7, sent.id),
      sent,
      message(author, "plain", "a top-level message", at),
      aux("deleted", 5, "held"),
      // A deletion by address alone changes a summary too.
      signed(author, {
        kind: 5,
        content: "",
        created_at: at,
        tags: [
          ["h", "atag"],
          ["a", `30023:${author.pubkey}:post`],
        ],
      }),
    ])
      await second.receive(["EVENT", batch[1], event]);
    for (const [, id] of second.requests()) await second.receive(["EOSE", id]);
    expect(channels()).toEqual([
      [[...ids].sort(), undefined, ["edited", "old", "plain"]],
    ]);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  ["rebuilt for narrower interests", "rebuild"],
  ["re-created on the next connection", "reconnect"],
] as const)(
  "catches up a channel granted while its refused batch was %s",
  async (_, after) => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 10, () => 0.5);
    try {
      age();
      h.owner.update(["a", "b", "c"], ["a", "b", "c"]);
      await establish(h.first);
      h.first.close();
      await vi.advanceTimersByTimeAsync(500);
      const second = h.sockets[1];
      assert.exists(second);
      await second.auth();
      await vi.advanceTimersByTimeAsync(750);
      const first = second.requests().find((r) => scopeOf(r).length > 1);
      assert.exists(first);
      await second.receive(["CLOSED", first[1], "auth-required: sign in"]);
      for (const r of second.requests())
        if (r !== first) await second.receive(["EOSE", r[1]]);
      await grant(h, "b", second);
      h.callbacks.established.mockClear();
      let socket = second;
      if (after === "rebuild") h.owner.update(["b", "c"], ["b", "c"]);
      else {
        // The grant is no longer in the next membership replay.
        second.close();
        await vi.advanceTimersByTimeAsync(1_000);
        const third = h.sockets[2];
        assert.exists(third);
        await third.auth();
        socket = third;
      }
      await vi.advanceTimersByTimeAsync(750);
      for (const r of socket.requests())
        if (scopeOf(r).includes("c")) await socket.receive(["EOSE", r[1]]);
      const calls = h.callbacks.established.mock.calls.filter((c) =>
        c[0]?.includes("c"),
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const [, , continuous] of calls)
        expect(continuous ?? []).not.toContain("b");
    } finally {
      h.owner.dispose();
    }
  },
);

it.each([
  ["in the same millisecond as its REQ", 0],
  ["after the clock went back a second", -1_000],
])(
  "keeps a channel owed when it is granted %s while that REQ is in flight",
  async (_, shift) => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 10, () => 0.5);
    try {
      age();
      h.owner.update(["a", "b"], ["a", "b"]);
      await establish(h.first);
      h.first.close();
      await vi.advanceTimersByTimeAsync(500);
      const second = h.sockets[1];
      assert.exists(second);
      await second.auth();
      const sent = Date.now();
      await vi.advanceTimersByTimeAsync(750);
      const batch = second.requests().find((r) => scopeOf(r).length > 1);
      assert.exists(batch);
      for (const r of second.requests())
        if (r !== batch) await second.receive(["EOSE", r[1]]);
      // Its REQ was sent at `sent`; the grant comes before its EOSE.
      vi.setSystemTime(sent + shift);
      await grant(h, "b", second);
      await second.receive(["EOSE", batch[1]]);
      // Its re-send is sent; the drop comes before that EOSE.
      expect(second.requests().at(-1)).not.toBe(batch);
      h.callbacks.established.mockClear();
      second.close();
      await vi.advanceTimersByTimeAsync(1_000);
      const third = h.sockets[2];
      assert.exists(third);
      // The grant is no longer in the next membership replay.
      await establish(third);
      expect(h.callbacks.established.mock.calls.filter((c) => c[0])).toEqual([
        [["a", "b"], undefined, ["a"]],
      ]);
    } finally {
      h.owner.dispose();
    }
  },
);

it.each([
  ["after its re-send reached EOSE", true, ["a", "b"]],
  ["while its re-send was still pending", false, ["a"]],
] as const)(
  "resumes a granted channel on the next connection only %s",
  async (_, finish, continuous) => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 10, () => 0.5);
    try {
      age();
      h.owner.update(["a", "b"], ["a", "b"]);
      await establish(h.first);
      await grant(h, "b");
      const resent = h.first.requests().at(-1);
      assert.exists(resent);
      if (finish) await h.first.receive(["EOSE", resent[1]]);
      h.callbacks.established.mockClear();
      h.first.close();
      await vi.advanceTimersByTimeAsync(500);
      const second = h.sockets[1];
      assert.exists(second);
      // The grant is no longer in the next membership replay.
      await establish(second);
      expect(h.callbacks.established.mock.calls.filter((c) => c[0])).toEqual([
        [["a", "b"], undefined, continuous],
      ]);
    } finally {
      h.owner.dispose();
    }
  },
);

it("catches up a channel granted while its batch waits to retry its first REQ", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, 10, () => 0.5);
  try {
    age();
    h.owner.update(["a", "b"], ["a", "b"]);
    await establish(h.first);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    const batches = () =>
      second.requests().filter((r) => scopeOf(r).length > 1);
    const first = batches()[0];
    assert.exists(first);
    await second.receive(["CLOSED", first[1], "auth-required: sign in"]);
    for (const r of second.requests())
      if (r !== first) await second.receive(["EOSE", r[1]]);
    h.callbacks.established.mockClear();
    // The retry follows the grant, but its replay was planned from b's cursor.
    await grant(h, "b", second);
    for (let tick = 0; tick < 30 && batches().length < 2; tick++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await second.receive(["NOTICE", "live"]);
    }
    const retry = batches().at(-1);
    assert.exists(retry);
    await second.receive(["EOSE", retry[1]]);
    expect(batches()).toHaveLength(2);
    expect(h.callbacks.established.mock.calls.filter((c) => c[0])).toEqual([
      [["a", "b"], undefined, ["a"]],
    ]);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  ["an undecodable replay event", () => ({})],
  [
    "a replay event tagged for another channel",
    () => message(keypair(), "elsewhere", "stray", 1_700_000_000),
  ],
] as const)(
  "reports no channel of a batch continuous after it dropped %s",
  async (_, event) => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup([], undefined, 10, () => 0.5);
    const log = captureLog();
    try {
      age();
      h.owner.update(["a", "b"], ["a", "b"]);
      await establish(h.first);
      h.callbacks.established.mockClear();
      h.first.close();
      await vi.advanceTimersByTimeAsync(500);
      const second = h.sockets[1];
      assert.exists(second);
      await second.auth();
      await vi.advanceTimersByTimeAsync(750);
      const batch = second.requests().find((r) => scopeOf(r).includes("a"));
      assert.exists(batch);
      // It spent a replay slot of a channel the session cannot apply it to.
      await second.receive(["EVENT", batch[1], event()]);
      for (const [, id] of second.requests())
        await second.receive(["EOSE", id]);
      expect(h.callbacks.established).toHaveBeenCalledWith(["a", "b"]);
    } finally {
      log.restore();
      h.owner.dispose();
    }
  },
);

it("reports a global route not continuous after it dropped an undecodable replay event, and counts it against the limit", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, undefined, () => 0.5);
  const log = captureLog();
  const globals = () =>
    h.callbacks.established.mock.calls.flatMap(([channels, global]) =>
      channels === undefined ? [global] : [],
    );
  try {
    age();
    await establish(h.first);
    h.callbacks.established.mockClear();
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    const profiles = next.requests().find(isProfiles);
    const membership = next.requests().find((r) => !isProfiles(r));
    assert.exists(profiles);
    assert.exists(membership);
    const event = signed(h.key, {
      kind: 0,
      content: "{}",
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    // 499 events and one the session rejected fill the limit.
    for (let i = 0; i < 499; i++)
      await next.receive(["EVENT", profiles[1], event]);
    await next.receive(["EVENT", profiles[1], {}]);
    await next.receive(["EOSE", profiles[1]]);
    await next.receive(["EVENT", membership[1], {}]);
    await next.receive(["EOSE", membership[1]]);
    expect(globals()).toEqual([
      { route: "profiles", continuous: false },
      { route: "membership", continuous: false },
    ]);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.id === "profiles",
      )?.replay,
    ).toBe("limited");
  } finally {
    log.restore();
    h.owner.dispose();
  }
});

it("reports a singleton channel route's continuity with its establishment", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, 10, () => 0.5);
  try {
    age();
    await establish(h.first);
    expect(h.callbacks.established).toHaveBeenCalledWith("a");
    h.callbacks.established.mockClear();
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1];
    assert.exists(second);
    await establish(second);
    expect(h.callbacks.established).toHaveBeenCalledWith("a", undefined, ["a"]);
  } finally {
    h.owner.dispose();
  }
});

it("forgets the cursor of a channel that left the interests before a rebuild", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a", "b"], undefined, undefined, () => 0.5);
  try {
    age();
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    h.first.close();
    h.owner.update(["a"]);
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    // Before its first tick, a connection's frames prove the relay as of the AUTH.
    const heard = Math.floor(Date.now() / 1000);
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of second.requests()) await second.receive(["EOSE", id]);
    h.owner.update(["a", "b"]);
    second.close();
    // The doubled backoff at three quarters: the rebuild happens now.
    await vi.advanceTimersByTimeAsync(750);
    const floor = Math.floor(Date.now() / 1000) - 300;
    const third = h.sockets[2];
    assert.exists(third);
    await third.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(sinceOf(third, (r) => scopeOf(r).includes("a"))).toEqual([
      heard - 960,
    ]);
    // "b" was not routed when its old cursor would have been renewed.
    expect(sinceOf(third, (r) => scopeOf(r).includes("b"))).toEqual([floor]);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  ["a 1012 close", (socket: Socket) => socket.close(1012)],
  ["an abnormal 1006 close", (socket: Socket) => socket.close(1006)],
  [
    "a transport error",
    (socket: Socket) => socket.onerror?.(new Event("error")),
  ],
])(
  "stamps the last relay frame, not the wake-up, when waking finds %s",
  async (_name, drop) => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const h = setup(["a"], undefined, undefined, () => 0.5);
    try {
      age();
      await h.first.auth();
      await vi.advanceTimersByTimeAsync(750);
      for (const [, id] of h.first.requests())
        await h.first.receive(["EOSE", id]);
      const heard = Math.floor(Date.now() / 1000);
      // The machine sleeps for an hour: the clock moves, no timer runs and no
      // frame arrives. The buffered close or error is handled on waking, and
      // is the transport's own event, not a frame from the relay.
      vi.setSystemTime(Date.now() + 3_600_000);
      drop(h.first);
      await vi.advanceTimersByTimeAsync(10_000);
      const next = h.sockets[1];
      assert.exists(next);
      await next.auth();
      await vi.advanceTimersByTimeAsync(750);
      expect(sinceOf(next, (r) => scopeOf(r).includes("a"))).toEqual([
        heard - 960,
      ]);
    } finally {
      h.owner.dispose();
    }
  },
);

it("does not take a late EOSE for a superseded REQ as the replacement's catch-up", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, undefined, () => 0.5);
  try {
    age();
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const first = h.first.requests().find(isProfiles);
    assert.exists(first);
    // The relay refuses the first REQ; the same socket asks again.
    await h.first.receive(["CLOSED", first[1], REFUSED]);
    await vi.advanceTimersByTimeAsync(1000);
    const retry = h.first.requests().filter(isProfiles).at(-1);
    assert.exists(retry);
    expect(retry[1]).not.toBe(first[1]);
    // The old REQ's EOSE arrives late, before the replacement's history.
    await h.first.receive(["EOSE", first[1]]);
    await vi.advanceTimersByTimeAsync(30_000);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const floor = Math.floor(Date.now() / 1000) - 300;
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    // No connection established the route, so no cursor: the five-minute window.
    expect(new Set(sinceOf(next, isProfiles))).toEqual(new Set([floor]));
  } finally {
    h.owner.dispose();
  }
});

it("keeps an earlier cursor when the replacement REQ on the same socket has not caught up", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, undefined, () => 0.5);
  try {
    age();
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const heard = Math.floor(Date.now() / 1000);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    const asked = second.requests().find(isProfiles);
    assert.exists(asked);
    // Refused, asked again; the old REQ's EOSE comes late and the replacement's
    // history never arrives before this connection also drops.
    await second.receive(["CLOSED", asked[1], REFUSED]);
    await vi.advanceTimersByTimeAsync(1000);
    await second.receive(["EOSE", asked[1]]);
    await vi.advanceTimersByTimeAsync(30_000);
    second.close();
    await vi.advanceTimersByTimeAsync(1000);
    const third = h.sockets[2];
    assert.exists(third);
    await third.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(new Set(sinceOf(third, isProfiles))).toEqual(new Set([heard - 960]));
  } finally {
    h.owner.dispose();
  }
});

it("keeps the earlier cursor when a channel is unsubscribed and subscribed again before its late EOSE", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, undefined, () => 0.5);
  try {
    age();
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const heard = Math.floor(Date.now() / 1000);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    const old = second.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(old);
    // Unsubscribe, then subscribe the same channel again on the same socket.
    h.owner.update([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.sent).toContainEqual(["CLOSE", old[1]]);
    h.owner.update(["a"]);
    await vi.advanceTimersByTimeAsync(10);
    const fresh = second.requests().filter((r) => scopeOf(r).includes("a"));
    expect(fresh.length).toBeGreaterThan(1);
    const again = fresh.at(-1);
    assert.exists(again);
    expect(again[1]).not.toBe(old[1]);
    // The old REQ's EOSE was still buffered when its CLOSE went out; the new
    // history has not arrived when this connection drops.
    await second.receive(["EOSE", old[1]]);
    await vi.advanceTimersByTimeAsync(30_000);
    second.close();
    await vi.advanceTimersByTimeAsync(1000);
    const third = h.sockets[2];
    assert.exists(third);
    await third.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(sinceOf(third, (r) => scopeOf(r).includes("a"))).toEqual([
      heard - 960,
    ]);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  [1012, 9000],
  [1001, 9000],
  [1006, 475],
  [undefined, 475],
])(
  "waits for the jitter its close code calls for before reconnecting (code %s)",
  async (code, delay) => {
    vi.useFakeTimers();
    const h = setup(["a"], undefined, undefined, () => 0.9);
    try {
      await h.first.auth();
      const connection = networkRecorder
        .snapshot()
        .events.filter((event) => event.event === "socket.connect")
        .at(-1)?.connection;
      h.first.close(code);
      expect(
        networkRecorder
          .snapshot()
          .events.filter((event) => event.event === "socket.retry")
          .at(-1)?.connection,
      ).toBe(connection);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(2);
    } finally {
      h.owner.dispose();
    }
  },
);

it("reconnects at once when the spread draws zero, then backs off normally after a plain failure", async () => {
  vi.useFakeTimers();
  const draws = [0, 0.5];
  const h = setup(["a"], undefined, undefined, () => draws.shift() ?? 0.5);
  try {
    await h.first.auth();
    h.first.close(1012);
    await vi.advanceTimersByTimeAsync(0);
    const second = h.sockets[1];
    assert.exists(second);
    // The restart spread leaves the backoff to double: a failure now waits 750ms.
    second.close(1006);
    await vi.advanceTimersByTimeAsync(749);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(3);
  } finally {
    h.owner.dispose();
  }
});

it("retries a rejected authentication slowly, doubling the wait, and keeps the error visible", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    for (const [index, wait] of [60_000, 120_000, 240_000].entries()) {
      const socket = h.sockets[index];
      assert.exists(socket);
      await socket.receive(["AUTH", "challenge"]);
      const auth = socket.sent.find((frame) => frame[0] === "AUTH")?.[1] as {
        id: string;
      };
      await socket.receive(["OK", auth.id, false, "restricted: access denied"]);
      expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
        status: "error",
        error: "Relay rejected live authentication",
      });
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(h.sockets).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(index + 2);
    }
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("retries a failed live signature slowly, but never a signer that does not match the viewer", async () => {
  vi.useFakeTimers();
  const key = keypair(),
    sockets: Socket[] = [];
  let signer: (event: EventTemplate) => Promise<VerifiedEvent> = async () => {
    throw new Error("keychain locked");
  };
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    (event) => signer(event),
    key.pubkey,
    {
      state: vi.fn(),
      receive: vi.fn(),
      established: vi.fn(),
      denied: vi.fn(),
    },
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  try {
    await sockets[0]?.receive(["AUTH", "challenge"]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    signer = async (event) => signed(keypair(), event);
    await sockets[1]?.receive(["AUTH", "challenge"]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sockets).toHaveLength(2);
  } finally {
    owner.dispose();
  }
});

it("times out individual setup, releases queue slots and never calls capped replay complete", async () => {
  vi.useFakeTimers();
  const h = setup(["a", "b", "c", "d"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  expect(h.first.requests()).toHaveLength(4);
  const a = h.first.requests()[2];
  assert.exists(a);
  const event = message(h.key, "a", "echo", 1);
  for (let i = 0; i < 500; i++) await h.first.receive(["EVENT", a[1], event]);
  await h.first.receive(["EOSE", a[1]]);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.first.requests()).toHaveLength(5);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "a")
      ?.replay,
  ).toBe("limited");
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.first.requests()).toHaveLength(6);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "b")
      ?.status,
  ).toBe("error");
  expect(h.callbacks.denied).not.toHaveBeenCalled();
  h.owner.dispose();
});
it("bounds interests and exposes every omitted ID without exceeding 1024 subscriptions", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 1024 },
    (_, i) => `channel-${i.toString().padStart(4, "0")}`,
  );
  const h = setup(ids);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  let index = 0;
  while (index < 1023) {
    if (index >= h.first.requests().length)
      await vi.advanceTimersByTimeAsync(250);
    const request = h.first.requests()[index++];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
  }
  expect(h.first.requests()).toHaveLength(1023);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes
      .filter((r) => r.status === "limited")
      .map((r) => r.channelId),
  ).toEqual(ids.slice(1021));
  expect(
    liveChannels(Array.from({ length: 100_001 }, (_, i) => `c${i}`)),
  ).toHaveLength(100_001);
  for (const invalid of [[""], ["a b"], ["x".repeat(129)], [9], {}])
    expect(() => liveChannels(invalid)).toThrow();
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("admits an opened preview before other previews past capacity, though it sorts last", async () => {
  vi.useFakeTimers();
  // Agents' watched public channels are previews too; an opened one keeps its
  // wire however many of them there are.
  const ids = [
    ...Array.from(
      { length: 1_100 },
      (_, i) => `attended-${i.toString().padStart(4, "0")}`,
    ),
    "zz-opened",
  ];
  const h = setup(ids);
  try {
    h.owner.prioritize?.(["zz-opened"]);
    await h.first.auth();
    const routes = h.callbacks.state.mock.lastCall?.[0].routes ?? [];
    const limited = routes
      .filter((r) => r.status === "limited")
      .map((r) => r.channelId);
    expect(limited).not.toContain("zz-opened");
    expect(limited.length).toBeGreaterThan(0);
    expect(routes.find((r) => r.channelId === "zz-opened")?.status).not.toBe(
      "limited",
    );
  } finally {
    h.owner.dispose();
  }
});
it("surfaces invalid signatures and terminal auth failure without an automatic policy loop", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const request = h.first.requests()[2];
  assert.exists(request);
  const event = message(h.key, "a", "valid", 1);
  await h.first.receive([
    "EVENT",
    request[1],
    { ...event, content: "tampered" },
  ]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  // Only that event is dropped: the route survives.
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "a")
      ?.status,
  ).toBe("pending");
  h.owner.dispose();
  const key = keypair(),
    socket = new Socket(),
    state = vi.fn();
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    keypair().pubkey,
    { state, receive: vi.fn(), established: vi.fn(), denied: vi.fn() },
    () => socket as unknown as WebSocket,
  );
  await socket.receive(["AUTH", "challenge"]);
  expect(state.mock.lastCall?.[0]).toMatchObject({
    status: "error",
    error: "Live signer does not match viewer",
  });
  expect(socket.sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
  owner.dispose();
});

it.each([false, true])(
  "bounds outstanding setup by the supplied concurrency (joined=%s)",
  async (joined) => {
    const key = keypair();
    const socket = new Socket();
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (event) => signed(key, event),
      key.pubkey,
      { receive() {}, state() {}, established() {}, denied() {} },
      () => socket as unknown as WebSocket,
      undefined,
      16,
      undefined,
      10,
    );
    const channels = Array.from({ length: 170 }, (_, i) => `channel-${i}`);
    owner.update(channels, joined ? channels : []);
    await socket.auth();
    expect(socket.requests()).toHaveLength(16);
    const first = socket.requests()[0];
    assert.exists(first);
    await socket.receive(["EOSE", first[1]]);
    expect(socket.requests()).toHaveLength(17);
    owner.dispose();
  },
);
it("refills setup immediately on EOSE; quota CLOSED pauses the whole queue and only retries refused routes", async () => {
  vi.useFakeTimers();
  const h = setup(Array.from({ length: 80 }, (_, i) => `channel-${i}`));
  await h.first.auth();
  // Each completion immediately frees one of four outstanding setup slots.
  for (let i = 0; i < 20; i++) {
    expect(h.first.requests()).toHaveLength(i + 4);
    const request = h.first.requests()[i];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
    expect(h.first.requests()).toHaveLength(i + 5);
    expect(performance.now()).toBe(0);
  }
  const refused = h.first.requests()[20];
  assert.exists(refused);
  const before = h.first.requests().length;
  await h.first.receive([
    "CLOSED",
    refused[1],
    "rate-limited: quota exceeded; retry in 2s",
  ]);
  await vi.advanceTimersByTimeAsync(2999);
  expect(h.first.requests()).toHaveLength(before);
  // Explicit retry keeps established routes and cannot bypass the shared cooldown.
  h.owner.retry();
  expect(h.sockets).toHaveLength(1);
  expect(h.first.requests()).toHaveLength(before);
  await vi.advanceTimersByTimeAsync(1);
  const retry = h.first.requests().at(-1);
  assert.exists(retry);
  expect(retry[2]).toEqual(refused[2]);
  expect(retry[1]).not.toBe(refused[1]);
  await h.first.receive(["EOSE", refused[1]]);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.filter(
      (r) => r.status === "live",
    ),
  ).toHaveLength(20);
  await h.first.receive(["EOSE", retry[1]]);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.filter(
      (r) => r.status === "live",
    ),
  ).toHaveLength(21);
  expect(h.callbacks.denied).not.toHaveBeenCalled();
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves host cooldown across subscription replacement and stops bounded quota retries", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const admission = createLiveAdmission();
  const callbacks = {
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  };
  const open = () => {
    const socket = new Socket();
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (e) => signed(key, e),
      key.pubkey,
      callbacks,
      () => socket as unknown as WebSocket,
      admission,
    );
    owner.update(["a", "b"]);
    return { socket, owner };
  };
  const first = open();
  await first.socket.auth();
  const request = first.socket.requests()[0];
  assert.exists(request);
  await first.socket.receive([
    "CLOSED",
    request[1],
    "rate-limited: quota exceeded; retry in 2s",
  ]);
  first.owner.dispose();
  const second = open();
  await second.socket.auth();
  expect(second.socket.requests()).toHaveLength(0);
  second.owner.retry();
  await vi.advanceTimersByTimeAsync(2999);
  expect(second.socket.requests()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  for (let i = 0; i < 4; i++) {
    const pending = second.socket.requests().at(-1);
    assert.exists(pending);
    await second.socket.receive([
      "CLOSED",
      pending[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    await vi.advanceTimersByTimeAsync(3000);
  }
  const count = second.socket.requests().length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(second.socket.requests()).toHaveLength(count);
  expect(
    callbacks.state.mock.lastCall?.[0].routes.every(
      (r) => r.status === "error",
    ),
  ).toBe(true);
  expect(callbacks.denied).not.toHaveBeenCalled();
  second.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["61", "9007199254740992"])(
  "an unsupported %s-second hint stops the unsent queue instead of draining it",
  async (seconds) => {
    vi.useFakeTimers();
    const h = setup(["a", "b", "c", "d"]);
    await h.first.auth();
    const request = h.first.requests()[0];
    assert.exists(request);
    await h.first.receive([
      "CLOSED",
      request[1],
      `rate-limited: quota exceeded; retry in ${seconds}s`,
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.first.requests()).toHaveLength(4);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.filter(
        (r) => r.status === "error",
      ).length,
    ).toBe(3);
    h.owner.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.first.requests()).toHaveLength(4);
    h.owner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("disposal from a live state notification fences the following established callback", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  const request = h.first.requests()[0];
  assert.exists(request);
  h.callbacks.state.mockImplementation((snapshot) => {
    if (snapshot.routes.some((r) => r.status === "live")) h.owner.dispose();
  });
  await h.first.receive(["EOSE", request[1]]);
  expect(h.callbacks.established).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

// Reentrant remove/re-add control contributed by Brain.
it("EOSE from a removed incarnation cannot establish its replacement", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(500);
    const old = h.first.requests()[2];
    assert.exists(old);
    let replaced = false;
    h.callbacks.state.mockImplementation((snapshot) => {
      if (
        !replaced &&
        snapshot.routes.find((r) => r.channelId === "a")?.status === "live"
      ) {
        replaced = true;
        h.owner.update(["b"]);
        h.owner.update(["a", "b"]);
      }
    });
    await h.first.receive(["EOSE", old[1]]);
    expect(replaced).toBe(true);
    expect(h.callbacks.established).not.toHaveBeenCalledWith("a");
    await vi.advanceTimersByTimeAsync(500);
    const fresh = h.first
      .requests()
      .find((r) => r[2]["#h"]?.[0] === "a" && r[1] !== old[1]);
    assert.exists(fresh);
    await h.first.receive(["EOSE", fresh[1]]);
    expect(h.callbacks.established).toHaveBeenCalledWith("a");
  } finally {
    h.owner.dispose();
  }
});

it("prioritizes a demanded tail channel after globals, without bypassing cooldown or adding interests", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 128 },
    (_, i) => `channel-${String(i).padStart(3, "0")}`,
  );
  const h = setup(ids);
  try {
    h.owner.prioritize?.([ids[127] as string, "unowned"]);
    await h.first.auth();
    expect(h.first.requests()[2]?.[2]["#h"]).toEqual([ids[127]]);
    const first = h.first.requests()[0];
    assert.exists(first);
    await h.first.receive([
      "CLOSED",
      first[1],
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    h.owner.prioritize?.([ids[126] as string]);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.first.requests()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await h.first.receive(["EOSE", h.first.requests().at(-1)?.[1]]);
    expect(h.first.requests().at(-1)?.[2]["#h"]).toEqual([ids[126]]);
    expect(h.first.requests().some((r) => r[2]["#h"]?.[0] === "unowned")).toBe(
      false,
    );
    expect(h.sockets).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("retains quota recovery evidence through automatic and manual retries until fresh EOSE", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    const first = h.first.requests()[0];
    assert.exists(first);
    const error = "rate-limited: quota exceeded; retry in 0s";
    const profiles = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.id === "profiles",
      );
    await h.first.receive(["CLOSED", first[1], error]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    await vi.advanceTimersByTimeAsync(1000);
    const retry = h.first.requests().at(-1);
    assert.exists(retry);
    // Force an unrelated notification after retry dispatch: old error must not
    // disappear just because the new REQ was sent, or because stale EOSE arrives.
    h.owner.prioritize?.(["a"]);
    await h.first.receive(["EOSE", first[1]]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    await h.first.receive(["EOSE", retry[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
    // Exhaust the same route's remaining automatic attempts.
    for (let i = 0; i < 3; i++) {
      const latest = h.first
        .requests()
        .filter((r) => r[2].kinds?.includes(0))
        .at(-1);
      assert.exists(latest);
      await h.first.receive(["CLOSED", latest[1], error]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(profiles()).toMatchObject({ status: "error", error });
    h.owner.retry();
    h.owner.prioritize?.(["b"]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    const manual = h.first
      .requests()
      .filter((r) => r[2].kinds?.includes(0))
      .at(-1);
    assert.exists(manual);
    await h.first.receive(["EOSE", manual[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
  } finally {
    h.owner.dispose();
  }
});

it("replaces unconfirmed quota recovery with a timeout and retains nonquota manual failures", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    const first = h.first.requests()[0];
    assert.exists(first);
    await h.first.receive([
      "CLOSED",
      first[1],
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    await vi.advanceTimersByTimeAsync(11000);
    const profiles = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (route) => route.id === "profiles",
      );
    const error = "Live subscription setup timed out; retry available";
    expect(profiles()).toMatchObject({ status: "error", error });
    h.owner.retry();
    expect(profiles()).toMatchObject({ status: "pending", error });
    const manual = h.first
      .requests()
      .filter((r) => r[2].kinds.includes(0))
      .at(-1);
    assert.exists(manual);
    await h.first.receive(["EOSE", manual[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
  } finally {
    h.owner.dispose();
  }
});

it("requests statuses and community emoji on the profile route and delivers verified updates", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  await h.first.auth();
  const req = h.first.sent.find((entry) => entry[0] === "REQ");
  expect(req?.slice(2)).toEqual([
    { kinds: [0, 10100, 30177], since: expect.any(Number), limit: 500 },
    {
      kinds: [30315],
      "#d": ["general"],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: [30030],
      "#d": ["buzz:custom-emoji"],
      since: expect.any(Number),
      limit: 500,
    },
  ]);
  const event = signed(h.key, {
    kind: 30030,
    content: "",
    tags: [
      ["d", "buzz:custom-emoji"],
      ["emoji", "party", "https://x.test/p"],
    ],
  });
  await h.first.receive(["EVENT", req?.[1], event]);
  expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
    phase: "replay",
  });
  h.owner.dispose();
});

it.each([false, true])(
  "a reconnect restores per-channel replay after established/renewed routes (joined=%s)",
  async (joined) => {
    vi.useFakeTimers();
    const h = setup([]);
    h.owner.update(["a", "b"], joined ? ["a", "b"] : []);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const request = h.first.requests()[2];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
    const event = message(keypair(), "a", "live", 1700000000);
    await h.first.receive(["EVENT", request[1], event]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
      phase: "live",
      channelId: "a",
    });
    if (joined) {
      await grant(h, "b");
      const renewal = h.first.requests().at(-1);
      assert.exists(renewal);
      expect(filtersOf(renewal)).toHaveLength(1);
      expect(renewal[2]).toMatchObject({ "#h": ["a", "b"], limit: 0 });
      await h.first.receive(["EOSE", renewal[1]]);
    }
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const socket = h.sockets[1];
    assert.exists(socket);
    await socket.auth();
    await vi.advanceTimersByTimeAsync(750);
    const replay = socket.requests()[2];
    assert.exists(replay);
    expect(filtersOf(replay)).toEqual(
      (joined ? ["a", "b"] : ["a"]).map((id) =>
        expect.objectContaining({ "#h": [id], limit: 500 }),
      ),
    );
    await socket.receive(["EVENT", replay[1], event]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
      phase: "replay",
      channelId: "a",
    });
    h.owner.dispose();
  },
);

it("live channel provenance excludes observer telemetry while preserving membership traffic", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = h.first.requests()[2];
    assert.exists(route);
    await h.first.receive(["EOSE", route[1]]);
    const telemetry = signed(h.key, {
      kind: 24200,
      content: "opaque",
      tags: [],
    });
    await h.first.receive(["EVENT", route[1], telemetry]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    const membership = signed(h.key, {
      kind: 40099,
      content: "{}",
      tags: [["h", "a"]],
    });
    await h.first.receive(["EVENT", route[1], membership]);
    expect(h.callbacks.receive).toHaveBeenCalledExactlyOnceWith([membership], {
      phase: "live",
      channelId: "a",
    });
  } finally {
    h.owner.dispose();
  }
});

it("observer route is optional, live-only at dispatch/retry, separately fenced and never ordinary replay", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const h = setup([]);
  const telemetry = vi.fn();
  Object.assign(h.callbacks, { telemetry });
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(500);
  const globals = h.first.requests().map((request) => request[1]);
  h.owner.observe?.(1);
  await vi.advanceTimersByTimeAsync(250);
  const first = h.first.requests().at(-1);
  assert.exists(first);
  expect(first[2]).toEqual({
    kinds: [24200],
    "#p": [h.key.pubkey],
    since: Math.floor(Date.now() / 1000),
  });
  const event = signed(h.key, {
    kind: 24200,
    content: "opaque",
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  });
  await h.first.receive(["EVENT", first[1], event]);
  expect(telemetry).toHaveBeenCalledWith(event, 1);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  await h.first.receive(["EOSE", first[1]]);
  expect(h.callbacks.established).not.toHaveBeenCalled();
  await h.first.receive(["CLOSED", first[1], "temporary: unavailable"]);
  await vi.advanceTimersByTimeAsync(3000);
  h.owner.retry();
  const retried = h.first.requests().at(-1);
  assert.exists(retried);
  expect(retried[2].since).toBeGreaterThan(first[2].since);
  h.owner.observe?.(2);
  await vi.advanceTimersByTimeAsync(250);
  await h.first.receive(["EVENT", first[1], event]);
  await h.first.receive(["EVENT", retried[1], event]);
  expect(telemetry).toHaveBeenCalledTimes(1);
  h.owner.observe?.(null);
  expect(
    h.first.sent
      .filter((entry) => entry[0] === "CLOSE")
      .some((entry) => globals.includes(entry[1] as string)),
  ).toBe(false);
  expect(h.sockets).toHaveLength(1);
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("presence holds its receipt without delaying ordinary setup and shares correlated cooldown", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  expect(
    await h.owner.publishPresence?.("online", new AbortController().signal),
  ).toBeNull();
  await h.first.auth();
  // No EOSE: ordinary setup is still pending.
  const abort = new AbortController();
  const result = h.owner.publishPresence?.("online", abort.signal);
  await vi.advanceTimersByTimeAsync(0);
  const event = h.first.sent.find(([kind]) => kind === "EVENT")?.[1] as {
    id: string;
    content: string;
  };
  assert.exists(event);
  expect(event.content).toBe("online");
  h.owner.update(["foreground"]);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.first.requests().at(-1)?.[2]["#h"]).toEqual(["foreground"]);
  abort.abort(); // Keep the receipt correlation after cancellation, to honor late quota.
  await h.first.receive(["OK", "unrelated", true]);
  await h.first.receive([
    "OK",
    event.id,
    false,
    "rate-limited: quota exceeded; retry in 3s",
  ]);
  expect(await result).toBe(false);
  const count = h.first.requests().length;
  h.owner.update(["foreground", "next"]);
  expect(h.first.requests()).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(4000);
  expect(h.first.requests()).toHaveLength(count + 1);
  h.owner.dispose();
});

it.each(["reconnect", "cooldown"])(
  "an outstanding presence signer respects %s",
  async (mode) => {
    vi.useFakeTimers();
    const key = keypair(),
      sockets: Socket[] = [];
    const admission = createLiveAdmission();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callbacks = {
      receive() {},
      state() {},
      established() {},
      denied() {},
    };
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (event) => {
        if (event.kind === 20001) await gate;
        return signed(key, event);
      },
      key.pubkey,
      callbacks,
      () => {
        const s = new Socket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      admission,
    );
    const first = sockets[0];
    assert.exists(first);
    await first.auth();
    await vi.advanceTimersByTimeAsync(500);
    for (const [, id] of first.requests()) await first.receive(["EOSE", id]);
    const result = owner.publishPresence?.(
      "away",
      new AbortController().signal,
    );
    expect(admission.presenceIdle()).toBe(false);
    if (mode === "reconnect") {
      first.close();
      await vi.advanceTimersByTimeAsync(500);
      const next = sockets[1];
      assert.exists(next);
      await next.auth();
      await vi.advanceTimersByTimeAsync(500);
      for (const [, id] of next.requests()) await next.receive(["EOSE", id]);
      expect(
        await owner.publishPresence?.("online", new AbortController().signal),
      ).toBeNull();
    } else {
      admission.pause(3);
      // A real cooldown wins even when another flight is busy signing.
      expect(
        await owner.publishPresence?.("online", new AbortController().signal),
      ).toEqual({ retryAfterMs: 4000 });
    }
    release();
    expect(await result).toEqual(
      mode === "reconnect" ? null : { retryAfterMs: 4000 },
    );
    expect(
      sockets.flatMap((s) => s.sent).filter(([kind]) => kind === "EVENT"),
    ).toEqual([]);
    expect(admission.presenceIdle()).toBe(true);
    owner.dispose();
  },
);

it("admits signed typing only on its authenticated channel route, without extra subscriptions", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const requests = h.first.requests();
  expect(requests).toHaveLength(4);
  const route = requests[2];
  assert.exists(route);
  expect(route[2].kinds).toContain(20002);
  const event = signed(keypair(), {
    kind: 20002,
    content: "",
    tags: [["h", "a"]],
  });
  await h.first.receive(["EVENT", requests[0]?.[1], event]);
  await h.first.receive(["EVENT", requests[3]?.[1], event]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  await h.first.receive(["EVENT", route[1], event]);
  expect(h.callbacks.receive).toHaveBeenCalledExactlyOnceWith([event], {
    channelId: "a",
    phase: "replay",
  });
  await h.first.receive([
    "EVENT",
    route[1],
    { ...event, sig: "0".repeat(128) },
  ]);
  expect(h.callbacks.receive).toHaveBeenCalledTimes(1);
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps misrouted activity out of accessible conversations; session rejects ambiguous scope", async () => {
  vi.useFakeTimers();
  const h = setup();
  const relay = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation(callbacks.state);
      return h.owner;
    },
  });
  // Establish both accessible channels before starting their live routes.
  h.callbacks.receive([
    roster(relay, "a", [h.key.pubkey]),
    roster(relay, "b", [h.key.pubkey]),
  ]);
  // This case exercises distinct wire scopes. Joined background batching is
  // covered separately below; membership alone no longer implies one wire each.
  h.owner.update(["a", "b"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const requests = h.first.requests();
  const a = requests.find((r) => r[2]["#h"]?.includes("a"));
  const b = requests.find((r) => r[2]["#h"]?.includes("b"));
  assert.exists(a);
  assert.exists(b);
  const agent = keypair();
  const activity = (tags: string[][]) =>
    signed(agent, {
      kind: 20002,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags,
    });
  const pulse = activity([["h", "b"]]);
  const snapshot = owner.session.typing.snapshot;
  for (const route of [requests[0], requests[1], a]) {
    await h.first.receive(["EVENT", route?.[1], pulse]);
    expect(snapshot()).toEqual([]);
  }
  for (const tags of [
    [],
    [["h"]],
    [["h", "bad channel"]],
    [["h", "denied"]],
    [
      ["h", "b"],
      ["h", "b"],
    ],
    [
      ["h", "b"],
      ["h", "a"],
    ],
    [
      ["h", "b"],
      ["e", "bad", "", "reply"],
    ],
  ]) {
    const event = activity(tags);
    await h.first.receive(["EVENT", b[1], event]);
    expect(snapshot()).toEqual([]);
    // Even a host that has already discarded route metadata cannot activate these.
    h.callbacks.receive([event]);
    expect(snapshot()).toEqual([]);
  }
  await h.first.receive(["EVENT", b[1], pulse]);
  expect(snapshot()).toEqual([{ channelId: "b", pubkey: agent.pubkey }]);
  // Once route metadata is gone, the session can only use the event's own scope.
  const other = activity([["h", "a"]]);
  await h.first.receive(["EVENT", b[1], other]);
  expect(snapshot()).toHaveLength(1);
  h.callbacks.receive([other]);
  expect(snapshot()).toEqual([
    { channelId: "b", pubkey: agent.pubkey },
    { channelId: "a", pubkey: agent.pubkey },
  ]);
  owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("gates publication on AUTH, shares admission with live routes, and accepts only matching OK", async () => {
  vi.useFakeTimers();
  networkMetrics.setEnabled(true);
  const h = setup();
  try {
    const event = message(h.key, "a", "outgoing", 1700000000);
    assert.exists(h.owner.publish);
    const done = vi.fn();
    const result = h.owner
      .publish(event, new AbortController().signal)
      .then(done, done);
    await h.first.receive(["OK", event.id, true, "early"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.first.sent).toEqual([]);
    await h.first.auth();
    expect(h.first.sent.filter((f) => f[0] === "EVENT")).toEqual([
      ["EVENT", JSON.parse(JSON.stringify(event))],
    ]);
    expect(h.first.requests()).toHaveLength(4);
    await h.first.receive(["OK", "f".repeat(64), true, "wrong"]);

    expect(done).not.toHaveBeenCalled();
    expect(h.first.requests()).toHaveLength(4);
    expect(performance.now()).toBe(100);
    await vi.advanceTimersByTimeAsync(25);
    await h.first.receive(["OK", event.id, true, "private-result"]);
    await result;
    expect(done).toHaveBeenCalledWith("private-result");
    expect(
      networkMetrics.snapshot().relays[0]?.session.latency.publicationAck,
    ).toMatchObject({ count: 1, mean: 25 });
    expect(networkMetrics.snapshot().relays[0]?.session.counts).toMatchObject({
      publishOk: 1,
      publishFailed: 0,
      publishCancelled: 0,
      txFrames: h.first.sent.length,
      txBytes: h.first.sent.reduce(
        (bytes, frame) =>
          bytes + new TextEncoder().encode(JSON.stringify(frame)).length,
        0,
      ),
      rxFrames: 5,
    });
    expect(h.callbacks.receive).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["restricted: not a member", false],
  ["invalid: event rejected", false],
  ["error: internal server error", true],
  ["unknown failure", true],
])("preserves publication uncertainty for %s", async (reason, sent) => {
  vi.useFakeTimers();
  networkMetrics.setEnabled(true);
  const h = setup([]);
  try {
    const event = message(h.key, "a", "command", 1700000000);
    assert.exists(h.owner.publish);
    const result = h.owner
      .publish(event, new AbortController().signal)
      .catch((e) => e);
    await h.first.auth();
    await h.first.receive(["OK", event.id, false, reason]);
    expect(await result).toMatchObject({ sent });
    expect(
      networkMetrics.snapshot().relays[0]?.session.latency.publicationAck.count,
    ).toBe(1);
    expect(networkMetrics.snapshot().relays[0]?.session.counts).toMatchObject({
      publishOk: 0,
      publishFailed: 1,
      publishCancelled: 0,
    });
  } finally {
    h.owner.dispose();
  }
});

it.each(["abort", "dispose", "disconnect"])(
  "settles queued versus sent publications on %s without replay",
  async (action) => {
    vi.useFakeTimers();
    for (const dispatched of [false, true]) {
      networkMetrics.setEnabled(true);
      networkMetrics.reset();
      const h = setup([]);
      try {
        const event = message(h.key, "a", "outgoing", 1700000000);
        const cancel = new AbortController();
        assert.exists(h.owner.publish);
        const result = h.owner.publish(event, cancel.signal).catch((e) => e);
        if (dispatched) await h.first.auth();
        if (action === "abort") cancel.abort();
        else if (action === "dispose") h.owner.dispose();
        else h.first.close();
        expect(await result).toMatchObject({ sent: dispatched });
        expect(
          networkMetrics.snapshot().relays[0]?.session.latency.publicationAck
            .count,
        ).toBe(0);
        expect(
          networkMetrics.snapshot().relays[0]?.session.counts,
        ).toMatchObject({
          publishOk: 0,
          publishFailed: action === "abort" ? 0 : 1,
          publishCancelled: action === "abort" ? 1 : 0,
        });
        if (action === "disconnect") {
          await vi.advanceTimersByTimeAsync(500);
          const next = h.sockets[1];
          assert.exists(next);
          await next.auth();
          await h.first.receive(["OK", event.id, true, "late"]);
          expect(next.sent.filter((f) => f[0] === "EVENT")).toEqual([]);
        }
      } finally {
        h.owner.dispose();
      }
    }
  },
);

it("bounds pending IDs, receipts and timeout; a socket send exception remains unknown", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    assert.exists(h.owner.publish);
    const event = message(h.key, "a", "outgoing", 1700000000);
    const result = h.owner
      .publish(event, new AbortController().signal)
      .catch((e) => e);
    await expect(
      h.owner.publish(event, new AbortController().signal),
    ).rejects.toMatchObject({ sent: false });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ sent: false });
  } finally {
    h.owner.dispose();
  }
  const second = setup([]);
  try {
    assert.exists(second.owner.publish);
    await second.first.auth();
    second.first.send = () => {
      throw new Error("interrupted");
    };
    const result = second.owner
      .publish(
        message(second.key, "a", "outgoing", 1700000000),
        new AbortController().signal,
      )
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ sent: true });
  } finally {
    second.owner.dispose();
  }
});

it("publication quota pauses both writes and live REQs without replaying the refused event", async () => {
  vi.useFakeTimers();
  const h = setup(["a", "b", "c"]);
  try {
    assert.exists(h.owner.publish);
    const a = message(h.key, "a", "first", 1700000000);
    const b = message(h.key, "a", "second", 1700000001);
    const first = h.owner
      .publish(a, new AbortController().signal)
      .catch((e) => e);
    await h.first.auth();
    await h.first.receive([
      "OK",
      a.id,
      false,
      "rate-limited: quota exceeded; retry in 1s",
    ]);
    const second = h.owner
      .publish(b, new AbortController().signal)
      .catch((e) => e);
    await h.first.receive(["EOSE", h.first.requests()[0]?.[1]]);
    expect(await first).toMatchObject({ sent: false });
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.first.sent.filter((f) => f[0] === "EVENT")).toHaveLength(1);
    expect(h.first.requests()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.first.sent.filter((f) => f[0] === "EVENT")).toHaveLength(2);
    await h.first.receive(["OK", b.id, true, ""]);
    expect(await second).toBe("");
    expect(h.first.requests()).toHaveLength(5);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  ["OK", true],
  ["OK", true, "x".repeat(16385)],
  ["OK", "true", ""],
])(
  "rejects malformed/bounded receipt (%j) without acceptance",
  async (...frame) => {
    vi.useFakeTimers();
    networkMetrics.setEnabled(true);
    const h = setup([]);
    try {
      assert.exists(h.owner.publish);
      const event = message(h.key, "a", "outgoing", 1700000000);
      const result = h.owner
        .publish(event, new AbortController().signal)
        .catch((e) => e);
      await h.first.auth();
      await h.first.receive([frame[0], event.id, ...frame.slice(1)]);
      expect(await result).toMatchObject({
        sent: true,
        message: "Invalid publication receipt",
      });
      expect(
        networkMetrics.snapshot().relays[0]?.session.latency.publicationAck
          .count,
      ).toBe(0);
    } finally {
      h.owner.dispose();
    }
  },
);

it.each(["event", "empty"] as const)(
  "samples subscription first response and EOSE once from regular traffic (%s)",
  async (response) => {
    vi.useFakeTimers();
    networkMetrics.setEnabled(true);
    const h = setup(["a"]);
    try {
      await h.first.auth();
      const request = h.first.requests().find((r) => scopeOf(r).includes("a"));
      assert.exists(request);
      const event = message(h.key, "a", "incoming", 1700000000);
      await h.first.receive(["EOSE", "unowned"]);
      await h.first.receive(["EVENT", request[1], { invalid: true }]);
      expect(
        networkMetrics.snapshot().relays[0]?.session.latency.subscriptionFirst
          .count,
      ).toBe(0);
      await vi.advanceTimersByTimeAsync(20);
      if (response === "event")
        await h.first.receive(["EVENT", request[1], event]);
      await vi.advanceTimersByTimeAsync(30);
      await h.first.receive(["EOSE", request[1]]);
      await h.first.receive(["EVENT", request[1], event]);
      await h.first.receive(["EOSE", request[1]]);
      expect(
        networkMetrics.snapshot().relays[0]?.session.latency,
      ).toMatchObject({
        subscriptionFirst: { count: 1, mean: response === "event" ? 20 : 50 },
        subscriptionEose: { count: 1, mean: 50 },
        rtt: { count: 0 },
      });
    } finally {
      h.owner.dispose();
    }
  },
);

it.each(["clear", "resume", "enable", "remove", "disconnect"] as const)(
  "does not sample obsolete subscription replies after %s",
  async (transition) => {
    vi.useFakeTimers();
    networkMetrics.setEnabled(transition !== "enable");
    const h = setup(["a"]);
    try {
      await h.first.auth();
      const request = h.first.requests().find((r) => scopeOf(r).includes("a"));
      assert.exists(request);
      if (transition === "clear") networkMetrics.reset();
      if (transition === "resume") networkMetrics.setEnabled(false);
      if (transition === "resume" || transition === "enable")
        networkMetrics.setEnabled(true);
      if (transition === "remove") h.owner.update([]);
      if (transition === "disconnect") h.first.close();
      await vi.advanceTimersByTimeAsync(20);
      await h.first.receive([
        "EVENT",
        request[1],
        message(h.key, "a", "late", 1700000000),
      ]);
      await h.first.receive(["EOSE", request[1]]);
      expect(
        networkMetrics.snapshot().relays[0]?.session.latency,
      ).toMatchObject({
        subscriptionFirst: { count: 0 },
        subscriptionEose: { count: 0 },
      });
    } finally {
      h.owner.dispose();
    }
  },
);

it.each(["clear", "resume", "enable"] as const)(
  "does not sample a publication dispatched before the current capture (%s)",
  async (transition) => {
    vi.useFakeTimers();
    networkMetrics.setEnabled(transition !== "enable");
    const h = setup([]);
    const event = message(h.key, "a", "outgoing", 1700000000);
    assert.exists(h.owner.publish);
    const request = h.owner
      .publish(event, new AbortController().signal)
      .catch((error: unknown) => error);
    try {
      await h.first.auth();
      if (transition === "clear") networkMetrics.reset();
      if (transition === "resume") networkMetrics.setEnabled(false);
      if (transition === "enable" || transition === "resume")
        networkMetrics.setEnabled(true);
      await vi.advanceTimersByTimeAsync(20);
      await h.first.receive(["OK", event.id, true, ""]);
      await request;
      expect(
        networkMetrics.snapshot().relays[0]?.session.latency.publicationAck
          .count,
      ).toBe(0);
    } finally {
      h.owner.dispose();
      await request;
    }
  },
);

it("samples sync subscriptions from dispatch and retires latency after EOSE", async () => {
  vi.useFakeTimers();
  networkMetrics.setEnabled(true);
  const h = setup([]);
  let stop: (() => void) | undefined;
  try {
    await h.first.auth();
    assert.exists(h.owner.syncArtifacts);
    stop = h.owner.syncArtifacts(
      { artifact: "current", "#h": ["a"] },
      { event: vi.fn(), eose: vi.fn(), closed: vi.fn() },
    );
    await vi.advanceTimersByTimeAsync(0);
    const request = h.first
      .requests()
      .find(
        (r) => (r[2] as unknown as { artifact: string }).artifact === "current",
      );
    assert.exists(request);
    await vi.advanceTimersByTimeAsync(25);
    await h.first.receive(["EOSE", request[1]]);
    await h.first.receive(["EOSE", request[1]]);
    expect(networkMetrics.snapshot().relays[0]?.session.latency).toMatchObject({
      subscriptionFirst: { count: 1, mean: 25 },
      subscriptionEose: { count: 1, mean: 25 },
    });
  } finally {
    stop?.();
    h.owner.dispose();
  }
});

it("ignores signed events outside a presence subscription before sampling its first response", async () => {
  vi.useFakeTimers();
  networkMetrics.setEnabled(true);
  const h = setup([]);
  try {
    h.owner.watchPresence?.([h.key.pubkey]);
    await h.first.auth();
    const request = h.first.requests().find((r) => r[2].kinds.includes(20001));
    assert.exists(request);
    await vi.advanceTimersByTimeAsync(10);
    await h.first.receive([
      "EVENT",
      request[1],
      message(h.key, "a", "wrong kind", 1700000000),
    ]);
    await vi.advanceTimersByTimeAsync(10);
    const template = {
      kind: 20001,
      content: "online",
      tags: [],
      created_at: 1700000000,
    };
    await h.first.receive(["EVENT", request[1], signed(keypair(), template)]);
    expect(h.callbacks.presence).not.toHaveBeenCalled();
    expect(
      networkMetrics.snapshot().relays[0]?.session.latency.subscriptionFirst
        .count,
    ).toBe(0);
    await vi.advanceTimersByTimeAsync(10);
    await h.first.receive(["EVENT", request[1], signed(h.key, template)]);
    expect(h.callbacks.presence).toHaveBeenCalledOnce();
    expect(
      networkMetrics.snapshot().relays[0]?.session.latency.subscriptionFirst,
    ).toMatchObject({ count: 1, mean: 30 });
  } finally {
    h.owner.dispose();
  }
});

it("fills three publication slots at one clock instant and refills on matching OK without a timer", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    assert.exists(h.owner.publish);
    const events = Array.from({ length: 4 }, (_, i) =>
      message(h.key, "a", `burst-${i}`, 1700000000 + i),
    );
    const publish = h.owner.publish;
    const results = events.map((event) =>
      publish(event, new AbortController().signal),
    );
    await h.first.auth();
    const writes = () => h.first.sent.filter((f) => f[0] === "EVENT");
    expect(writes()).toHaveLength(3);
    expect(performance.now()).toBe(0);
    await h.first.receive(["OK", events[0]?.id, true, ""]);
    expect(writes()).toHaveLength(4);
    expect(performance.now()).toBe(0);
    for (const event of events.slice(1))
      await h.first.receive(["OK", event.id, true, ""]);
    await Promise.all(results);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("presence and ordinary publications correlate independently and share only real cooldown", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    assert.exists(h.owner.publish);
    assert.exists(h.owner.publishPresence);
    const presenceDone = vi.fn();
    const presence = h.owner
      .publishPresence("online", new AbortController().signal)
      .then(presenceDone);
    await vi.advanceTimersByTimeAsync(0);
    const event = h.first.sent.find(([kind]) => kind === "EVENT")?.[1] as {
      id: string;
    };
    assert.exists(event);
    const chat = message(h.key, "a", "ordinary", 1700000000);
    const ordinaryDone = vi.fn();
    const ordinary = h.owner
      .publish(chat, new AbortController().signal)
      .then(ordinaryDone);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.first.sent.filter(([kind]) => kind === "EVENT")).toHaveLength(2);
    expect(performance.now()).toBe(0);
    await h.first.receive(["OK", event.id, true, ""]);
    await presence;
    expect(presenceDone).toHaveBeenCalledWith(true);
    expect(ordinaryDone).not.toHaveBeenCalled();
    await h.first.receive(["OK", chat.id, true, "chat accepted"]);
    await ordinary;
    expect(ordinaryDone).toHaveBeenCalledWith("chat accepted");
    await vi.advanceTimersByTimeAsync(5000);
    const refused = message(h.key, "a", "refused", 1700000001);
    const result = h.owner
      .publish(refused, new AbortController().signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    await h.first.receive([
      "OK",
      refused.id,
      false,
      "rate-limited: quota exceeded; retry in 1s",
    ]);
    expect(await result).toMatchObject({ sent: false });
    expect(
      await h.owner.publishPresence("away", new AbortController().signal),
    ).toEqual({ retryAfterMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    const renewal = h.owner.publishPresence(
      "away",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    const last = h.first.sent
      .filter(([kind]) => kind === "EVENT")
      .at(-1)?.[1] as { id: string; content: string };
    expect(last.content).toBe("away");
    await h.first.receive(["OK", last.id, true, ""]);
    expect(await renewal).toBe(true);
    expect(h.sockets).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("publishes manual Offline on the authenticated presence socket with a correlated receipt", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    const result = h.owner.publishPresence?.(
      "offline",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    const event = h.first.sent.find(([kind]) => kind === "EVENT")?.[1] as {
      id: string;
      kind: number;
      content: string;
      tags: string[][];
    };
    assert.exists(event);
    expect(event).toMatchObject({ kind: 20001, content: "offline", tags: [] });
    await h.first.receive(["OK", event.id, true]);
    expect(await result).toBe(true);
  } finally {
    h.owner.dispose();
  }
});

it("receives public agent metadata on the existing profile route without another subscription", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = h.first
      .requests()
      .find((request) => request[2].kinds.includes(10100));
    assert.exists(route);
    expect(route[2].kinds).toEqual([0, 10100, 30177]);
    expect(h.first.requests()).toHaveLength(2);
    await h.first.receive(["EOSE", route[1]]);
    for (const kind of [10100, 30177]) {
      const event = signed(h.key, {
        kind,
        content: "{}",
        tags: [],
        created_at: 10,
      });
      await h.first.receive(["EVENT", route[1], event]);
      expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
        phase: "live",
      });
    }
  } finally {
    h.owner.dispose();
  }
});

it("logs every real transport frame without payloads and applies level changes to an open socket", async () => {
  vi.useFakeTimers();
  const logger = getLogger("relay-ws");
  const reporters = [...logger.options.reporters];
  const lines: string[] = [];
  logger.setReporters([{ log: (value) => lines.push(value.args.join(" ")) }]);
  setLogLevel("debug");
  const h = setup(["a"]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(lines.some((line) => line.includes("← AUTH"))).toBe(true);
    expect(lines.some((line) => line.includes("→ AUTH"))).toBe(true);
    expect(lines.some((line) => line.includes("→ REQ"))).toBe(true);
    const request = h.first.requests().find((r) => r[2]["#h"]?.[0] === "a");
    assert.exists(request);
    const incoming = message(keypair(), "a", "secret message", 1700000000);
    lines.length = 0;
    for (let i = 0; i < 20; i++)
      await h.first.receive(["EVENT", request[1], incoming]);
    expect(lines).toHaveLength(20);
    expect(
      lines.every(
        (line) => line.includes("← EVENT") && line.includes("kind=9"),
      ),
    ).toBe(true);
    expect(lines.join(" ")).not.toContain("secret message");
    expect(h.callbacks.receive).toHaveBeenCalledTimes(20);
    setLogLevel("info");
    await h.first.receive(["EVENT", request[1], incoming]);
    expect(lines).toHaveLength(20);
    expect(h.callbacks.receive).toHaveBeenCalledTimes(21);
  } finally {
    h.owner.dispose();
    logger.setReporters(reporters);
    setLogLevel("info");
  }
});

it("logs authentication failure and retry reasons at Info without server payloads", async () => {
  vi.useFakeTimers();
  const logger = getLogger("relay-ws");
  const reporters = [...logger.options.reporters];
  const lines: string[] = [];
  logger.setReporters([
    { log: (value) => lines.push(`${value.type} ${value.args.join(" ")}`) },
  ]);
  setLogLevel("info");
  const rejected = setup([]);
  let timedOut: ReturnType<typeof setup> | undefined;
  try {
    await rejected.first.receive(["AUTH", "private challenge"]);
    const auth = rejected.first.sent.find(
      (frame) => frame[0] === "AUTH",
    )?.[1] as { id: string };
    await rejected.first.receive(["OK", auth.id, false, "private rejection"]);
    expect(
      lines.filter((line) =>
        line.includes("Relay rejected live authentication"),
      ),
    ).toEqual(["error relay.test Relay rejected live authentication"]);
    timedOut = setup([]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(
      lines.filter((line) => line.includes("Live authentication timed out")),
    ).toEqual(["warn relay.test Live authentication timed out"]);
    expect(lines.join(" ")).not.toContain("private");
  } finally {
    rejected.owner.dispose();
    timedOut?.owner.dispose();
    logger.setReporters(reporters);
    setLogLevel("info");
  }
});

it("a rejected AUTH is settled for session recovery, retries on its own slow timer and on explicit retry", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.receive(["AUTH", "challenge"]);
    const auth = h.first.sent.find((frame) => frame[0] === "AUTH")?.[1] as {
      id: string;
    };
    await h.first.receive(["OK", auth.id, false, "restricted: no"]);
    const view = h.callbacks.state.mock.lastCall?.[0];
    assert.exists(view);
    expect(view).toMatchObject({
      status: "error",
      error: "Relay rejected live authentication",
    });
    // Recovery and wake signals skip it, so they cannot shorten the slow timer.
    expect(
      liveRecoveryStatus({ ...view, roster: { state: "verified" }, heads: [] }),
    ).toBe("settled");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.sockets).toHaveLength(1);
    // The conversation's Retry live updates calls this after the user fixes
    // the signer or access problem.
    h.owner.retry();
    expect(h.sockets).toHaveLength(2);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connecting");
  } finally {
    h.owner.dispose();
  }
});

it("presence shares the authenticated socket, verifies signatures, and replaces demand without an observation gap", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const peer = keypair();
  h.owner.watchPresence?.([peer.pubkey]);
  await h.first.auth();
  const first = h.first.requests().find((r) => r[2].kinds.includes(20001));
  assert.exists(first);
  expect(first[2]).toMatchObject({ authors: [peer.pubkey], limit: 0 });
  await h.first.receive(["EOSE", first[1]]);
  const event = signed(peer, {
    kind: 20001,
    tags: [],
    content: "away",
    created_at: Math.floor(Date.now() / 1000),
  });
  h.owner.watchPresence?.([peer.pubkey, h.key.pubkey]);
  const next = h.first
    .requests()
    .filter((r) => r[2].kinds.includes(20001))
    .at(-1);
  assert.exists(next);
  expect(next[1]).not.toBe(first[1]);
  expect(h.first.sent).not.toContainEqual(["CLOSE", first[1]]);
  await h.first.receive(["EVENT", first[1], event]);
  expect(h.callbacks.presence).toHaveBeenLastCalledWith(event);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  await h.first.receive(["EOSE", next[1]]);
  expect(h.first.sent).toContainEqual(["CLOSE", first[1]]);
  h.callbacks.presence.mockClear();
  await h.first.receive(["EVENT", first[1], event]);
  await h.first.receive(["EVENT", next[1], { ...event, content: "online" }]);
  expect(h.callbacks.presence).not.toHaveBeenCalled();
  h.owner.dispose();
});

it.each([false, true])(
  "paces replacement commands behind a held receipt without polling (late cooldown: %s)",
  async (cooldown) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          work: () => Promise<void>,
        ) => work(),
      },
    });
    const h = setup([]);
    const listeners = new Set<() => void>();
    let status: "online" | "away" | "offline" = "online",
      command = 0;
    const attempts: number[] = [];
    const publishPresence = h.owner.publishPresence;
    assert.exists(publishPresence);
    const publish = vi.fn(
      (value: "online" | "away" | "offline", signal: AbortSignal) => {
        attempts.push(performance.now());
        return publishPresence(value, signal);
      },
    );
    const owner = createPresence(
      {
        ...scriptedTransport(h.key.pubkey, h.key.pubkey).transport,
        viewer: h.key.pubkey,
        presenceSnapshot: async () => new Map([[h.key.pubkey, "online"]]),
      },
      {
        visible: () => true,
        status: () => status,
        command: () => command,
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        dispose() {},
      },
      publish,
      (fn) => fn(),
    );
    const events = () =>
      h.first.sent
        .filter(([kind]) => kind === "EVENT")
        .map(([, event]) => event as { id: string; content: string });
    try {
      await h.first.auth();
      owner.subscribe(h.key.pubkey, () => {});
      owner.connected(true);
      await vi.advanceTimersByTimeAsync(250);
      for (const request of h.first.requests())
        await h.first.receive(["EOSE", request[1]]);
      expect(events().map((event) => event.content)).toEqual(["online"]);
      await vi.advanceTimersByTimeAsync(1000);
      status = "away";
      command++;
      for (const fn of listeners) fn();
      await vi.advanceTimersByTimeAsync(4050);
      // The gate opened, but the original receipt still owns the flight.
      expect(attempts).toEqual([250, 1250, 5300]);
      expect(await publish.mock.results[2]?.value).toBeNull();
      await vi.advanceTimersByTimeAsync(700);
      status = "offline";
      command++;
      for (const fn of listeners) fn();
      await vi.advanceTimersByTimeAsync(4000);
      expect(attempts).toEqual([250, 1250, 5300, 6000]);
      expect(events()).toHaveLength(1);
      const first = events()[0];
      assert.exists(first);
      // Aborting the old owner must not discard a late shared quota refusal.
      await h.first.receive([
        "OK",
        first.id,
        !cooldown,
        cooldown ? "rate-limited: quota exceeded; retry in 1s" : "",
      ]);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toEqual([250, 1250, 5300, 6000]);
      await vi.advanceTimersByTimeAsync(1);
      if (cooldown) {
        expect(events()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1049);
        expect(attempts).toEqual([250, 1250, 5300, 6000, 11000]);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(attempts).toEqual(
        cooldown
          ? [250, 1250, 5300, 6000, 11000, 12050]
          : [250, 1250, 5300, 6000, 11000],
      );
      expect(events().map((event) => event.content)).toEqual([
        "online",
        "offline",
      ]);
      expect(owner.status(h.key.pubkey)).toBe("online");
      const last = events().at(-1);
      assert.exists(last);
      await h.first.receive(["OK", last.id, true, ""]);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.status(h.key.pubkey)).toBe("offline");
      const count = attempts.length;
      await vi.advanceTimersByTimeAsync(65000);
      expect(attempts).toHaveLength(count); // No superseded renewal or Offline lease.
    } finally {
      owner.dispose();
      h.owner.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);

it("reports the remaining presence gate without extending it and honors cooldown", () => {
  vi.useFakeTimers();
  const admission = createLiveAdmission();
  expect(admission.presenceDelay()).toBe(0);
  const release = admission.tryPresence();
  expect(admission.presenceDelay()).toBe(0);
  admission.presenceSent();
  vi.advanceTimersByTime(1200);
  expect(admission.presenceDelay()).toBe(3800);
  release?.();
  expect(admission.tryPresence()).toBeUndefined();
  admission.pause(10);
  expect(admission.presenceDelay()).toBe(11000);
  vi.advanceTimersByTime(10999);
  expect(admission.presenceDelay()).toBe(1);
  expect(admission.tryPresence()).toBeUndefined();
  vi.advanceTimersByTime(1);
  expect(admission.presenceDelay()).toBe(0);
  admission.tryPresence()?.();
});

it("carries verified workflow attribution from live admission to notification candidates", async () => {
  vi.useFakeTimers({ now: 1_700_000_100_000 });
  const h = setup([]),
    relay = keypair(),
    workflowOwner = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    archiveAuthority: relay.pubkey,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation(callbacks.state);
      return h.owner;
    },
  });
  try {
    h.callbacks.receive([roster(relay, "room", [h.key.pubkey])]);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = h.first
      .requests()
      .find((request) => scopeOf(request).includes("room"));
    assert.exists(route);
    await h.first.receive(["EOSE", route[1]]);
    const incoming = vi.fn();
    owner.session.subscribeIncoming(incoming);
    const event = message(relay, "room", "workflow live", 1_700_000_100, [
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", workflowOwner.pubkey],
    ]);
    await h.first.receive(["EVENT", route[1], event]);
    expect(incoming).toHaveBeenCalledWith([
      expect.objectContaining({
        messageId: event.id,
        authorId: relay.pubkey,
        workflowOwnerId: workflowOwner.pubkey,
      }),
    ]);
  } finally {
    owner.dispose();
    h.owner.dispose();
  }
});

it("keeps 10,000 joined channels live through membership changes, reconnect and restart", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 10_000 },
    (_, i) => `task-${String(i).padStart(5, "0")}`,
  );
  const previews = Array.from(
    { length: 64 },
    (_, i) => `preview-${String(i).padStart(2, "0")}`,
  );
  const h = setup([]);
  let latest: Parameters<LiveCallbacks["state"]>[0] | undefined;
  h.callbacks.state.mockImplementation((state) => {
    latest = state;
  });
  const settle = async (socket: Socket, start = 0) => {
    for (let i = start; i < socket.requests().length; i++) {
      await socket.receive(["EOSE", socket.requests()[i]?.[1]]);
      h.callbacks.state.mockClear();
    }
  };
  const assertBounds = (socket: Socket) => {
    const active = new Set<unknown>();
    for (const [kind, id] of socket.sent) {
      if (kind === "REQ") active.add(id);
      if (kind === "CLOSE") active.delete(id);
      expect(active.size).toBeLessThanOrEqual(1024);
    }
    return active;
  };
  try {
    h.owner.prioritize?.(ids.slice(-64));
    h.owner.observe?.(1);
    h.owner.watchPresence?.([h.key.pubkey]);
    h.owner.update(ids);
    h.owner.update([...ids, ...previews], ids);
    await h.first.auth();
    await settle(h.first);
    expect(h.first.requests()).toHaveLength(1019);
    expect(
      latest?.routes.filter(
        (route) => route.channelId && route.status === "live",
      ),
    ).toHaveLength(10_015);
    expect(
      latest?.routes.filter((route) => route.status === "limited"),
    ).toHaveLength(49);
    expect(new Set(h.first.requests().flatMap(scopeOf))).toEqual(
      new Set([...ids, ...previews.slice(0, 15)]),
    );
    assertBounds(h.first);
    const route = h.first
      .requests()
      .find((request) => scopeOf(request).includes("task-09999"));
    assert.exists(route);
    const event = message(
      h.key,
      "task-09999",
      "input on the last task",
      1700000001,
    );
    await h.first.receive(["EVENT", route[1], event]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
      phase: "live",
      channelId: ids[9999],
    });

    // Churn across every batch must reuse space, rather than grow one route per join.
    const retained = ids.filter((_, i) => i % 10 !== 0);
    const added = Array.from({ length: 1000 }, (_, i) => `replacement-${i}`);
    const next = [...retained, ...added];
    let start = h.first.requests().length;
    h.owner.update([...retained, ...previews], retained);
    h.owner.update([...next, ...previews], next);
    await settle(h.first, start);
    expect(
      latest?.routes.filter(
        (route) => route.channelId && route.status === "live",
      ),
    ).toHaveLength(10_015);
    expect(assertBounds(h.first).size).toBe(1019);

    start = h.first.requests().length;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(h.first, start);
    expect(assertBounds(h.first).size).toBe(1019);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const reconnect = h.sockets.at(-1);
    assert.exists(reconnect);
    expect(reconnect).not.toBe(h.first);
    await reconnect.auth();
    await settle(reconnect);
    expect(new Set(reconnect.requests().flatMap(scopeOf))).toEqual(
      new Set([...next, ...previews.slice(0, 15)]),
    );
    expect(latest?.status).toBe("connected");
    assertBounds(reconnect);

    h.owner.dispose();
    const restarted = setup([]);
    try {
      restarted.callbacks.state.mockImplementation(() =>
        restarted.callbacks.state.mockClear(),
      );
      restarted.owner.update(next, next);
      await restarted.first.auth();
      await settle(restarted.first);
      expect(new Set(restarted.first.requests().flatMap(scopeOf))).toEqual(
        new Set(next),
      );
      assertBounds(restarted.first);
    } finally {
      restarted.owner.dispose();
    }
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
}, 60_000);

it("passes the full session roster and delivers input and artifacts on task 10,000", async () => {
  vi.useFakeTimers({ now: 1_700_000_100_000 });
  const h = setup([], createLiveAdmission(), 2048),
    relay = keypair(),
    author = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  let latest: Parameters<LiveCallbacks["state"]>[0] | undefined;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation((state) => {
        latest = state;
        callbacks.state(state);
      });
      h.callbacks.established.mockImplementation(callbacks.established);
      return h.owner;
    },
  });
  try {
    const ids = Array.from(
      { length: 10_000 },
      (_, i) => `task-${String(i).padStart(5, "0")}`,
    );
    h.callbacks.receive(ids.map((id) => roster(relay, id, [h.key.pubkey])));
    expect(owner.session.channels.list().channels).toHaveLength(10_000);
    const live = vi.fn(),
      input = vi.fn();
    owner.session.subscribeLive(live, { replay: true });
    owner.session.subscribeIncoming(input);
    await h.first.auth();
    for (let i = 0; i < h.first.requests().length; i++) {
      await h.first.receive(["EOSE", h.first.requests()[i]?.[1]]);
      h.callbacks.state.mockClear();
    }
    expect(latest?.status).toBe("connected");
    expect(
      latest?.routes.filter(
        (route) => route.channelId && route.status === "live",
      ),
    ).toHaveLength(10_000);
    const route = h.first
      .requests()
      .find((request) => scopeOf(request).includes("task-09999"));
    assert.exists(route);
    const messageEvent = message(
      author,
      "task-09999",
      "run this task",
      1_700_000_101,
    );
    const artifactEvent = signed(author, {
      kind: 45010,
      created_at: 1_700_000_102,
      content: '{"text":"Result"}',
      tags: [
        ["h", "task-09999"],
        ["ar", "1"],
        ["d", "result"],
        ["type", "example.note"],
        ["op", "create"],
      ],
    });
    await h.first.receive(["EVENT", route[1], messageEvent]);
    await h.first.receive(["EVENT", route[1], artifactEvent]);
    expect(input).toHaveBeenCalledWith([
      expect.objectContaining({
        channelId: "task-09999",
        messageId: messageEvent.id,
      }),
    ]);
    expect(live).toHaveBeenCalledWith({
      channelId: "task-09999",
      events: [artifactEvent],
    });
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const reconnect = h.sockets.at(-1);
    assert.exists(reconnect);
    await reconnect.auth();
    let cursor = 0;
    while (
      !reconnect
        .requests()
        .some(
          (request) =>
            scopeOf(request).includes("task-00000") && request[2].limit === 500,
        )
    ) {
      const request: WireRequest | undefined = reconnect.requests()[cursor++];
      assert.exists(request);
      await reconnect.receive(["EOSE", request[1]]);
    }
    const replayRoute = reconnect
      .requests()
      .find(
        (request) =>
          scopeOf(request).includes("task-00000") && request[2].limit === 500,
      );
    assert.exists(replayRoute);
    const missed = message(author, "task-00000", "missed input", 1_700_000_103);
    await reconnect.receive(["EVENT", replayRoute[1], missed]);
    expect(live).toHaveBeenCalledWith({
      channelId: "task-00000",
      events: [missed],
      replay: true,
    });
  } finally {
    owner.dispose();
  }
}, 120_000);

it("finishes initial channel setup before renewing established batches", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    const ids = Array.from(
      { length: 400 },
      (_, i) => `c${String(i).padStart(3, "0")}`,
    );
    h.owner.update(ids, ids);
    await h.first.auth();
    for (const request of h.first
      .requests()
      .filter((request) => !scopeOf(request).length))
      await h.first.receive(["EOSE", request[1]]);
    let cursor = 2;
    for (let round = 0; round < 7; round++) {
      await vi.advanceTimersByTimeAsync(8000);
      const pending = h.first.requests().slice(cursor);
      cursor = h.first.requests().length;
      for (const request of pending)
        await h.first.receive(["EOSE", request[1]]);
    }
    const pending = h.first.requests().slice(cursor);
    await vi.advanceTimersByTimeAsync(4000);
    assert.exists(pending[0]);
    const before = h.first.requests().length;
    await h.first.receive(["EOSE", pending[0][1]]);
    expect(h.first.requests()).toHaveLength(before + 1);
    expect(h.first.requests().at(-1)?.[2].limit).toBe(500);
  } finally {
    h.owner.dispose();
  }
});

it.each(["replacement", "source"])(
  "keeps survivor alerts when %s delivers first during batch expansion",
  async (first) => {
    vi.useFakeTimers({ now: 1_700_000_100_000 });
    const h = setup([]),
      relay = keypair(),
      author = keypair();
    const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        h.callbacks.receive.mockImplementation(callbacks.receive);
        h.callbacks.state.mockImplementation(callbacks.state);
        return h.owner;
      },
    });
    try {
      h.callbacks.receive([roster(relay, "a", [h.key.pubkey])]);
      await h.first.auth();
      for (const request of h.first.requests())
        await h.first.receive(["EOSE", request[1]]);
      const source = h.first
        .requests()
        .find((request) => scopeOf(request).includes("a"));
      assert.exists(source);
      const incoming = vi.fn();
      owner.session.subscribeIncoming(incoming);
      h.callbacks.receive([roster(relay, "b", [h.key.pubkey])]);
      const replacement = h.first.requests().at(-1);
      assert.exists(replacement);
      expect(scopeOf(replacement)).toEqual(["a", "b"]);
      const event = message(author, "a", "fresh survivor", 1_700_000_101);
      const sources =
        first === "replacement" ? [replacement, source] : [source, replacement];
      for (const request of sources)
        await h.first.receive(["EVENT", request[1], event]);
      expect(incoming).toHaveBeenCalledTimes(1);
      expect(filtersOf(replacement).map((filter) => filter.limit)).toEqual([
        0, 500,
      ]);
    } finally {
      owner.dispose();
    }
  },
);

it.each(["transient failure", "removal"])(
  "keeps the live survivor source after %s in an expanding batch",
  async (outcome) => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      h.owner.update(["a", "b"], ["a", "b"]);
      await h.first.auth();
      for (const request of h.first.requests())
        await h.first.receive(["EOSE", request[1]]);
      const source = h.first
        .requests()
        .find((request) => scopeOf(request).includes("b"));
      assert.exists(source);
      h.owner.update(["a", "b", "c"], ["a", "b", "c"]);
      const replacement = h.first.requests().at(-1);
      assert.exists(replacement);
      if (outcome === "transient failure")
        await h.first.receive([
          "CLOSED",
          replacement[1],
          "error: internal server error",
        ]);
      else h.owner.update(["b", "c"], ["b", "c"]);
      expect(h.first.sent).not.toContainEqual(["CLOSE", source[1]]);
      const event = message(h.key, "b", "survivor remains live", 1_700_000_101);
      await h.first.receive(["EVENT", source[1], event]);
      expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
        phase: "live",
        channelId: "b",
      });
      if (outcome === "transient failure") h.owner.retry();
      const retry = h.first.requests().at(-1);
      assert.exists(retry);
      expect(
        filtersOf(retry).find((filter) => filter["#h"]?.includes("c"))?.limit,
      ).toBe(500);
    } finally {
      h.owner.dispose();
    }
  },
);

it("prioritizes a growing initial batch over healthy renewals", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    const ids = Array.from(
      { length: 320 },
      (_, i) => `c${String(i).padStart(3, "0")}`,
    );
    h.owner.update(ids, ids);
    await h.first.auth();
    for (let i = 0; i < h.first.requests().length; i++)
      await h.first.receive(["EOSE", h.first.requests()[i]?.[1]]);
    const start = h.first.requests().length;
    await vi.advanceTimersByTimeAsync(60_000);
    h.owner.update([...ids, "new-a"], [...ids, "new-a"]);
    const renewal = h.first.requests()[start];
    assert.exists(renewal);
    await h.first.receive(["EOSE", renewal[1]]);
    const initial = h.first.requests().at(-1);
    assert.exists(initial);
    expect(scopeOf(initial)).toEqual(["new-a"]);
    h.owner.update([...ids, "new-a", "new-b"], [...ids, "new-a", "new-b"]);
    const expanded = h.first.requests().at(-1);
    assert.exists(expanded);
    expect(scopeOf(expanded)).toEqual(["new-a", "new-b"]);
  } finally {
    h.owner.dispose();
  }
});

it("covers 100,000 channels with protocol-sized live batches and a bounded replay queue", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 100_000 },
    (_, i) => `task-${String(i).padStart(6, "0")}`,
  );
  const h = setup([], createLiveAdmission(), 2048);
  let latest: Parameters<LiveCallbacks["state"]>[0] | undefined;
  h.callbacks.state.mockImplementation((state) => {
    latest = state;
    h.callbacks.state.mockClear();
  });
  const live = new Map<string, WireRequest>();
  let replayed = 0;
  const active = new Set<string>();
  const drain = async (start = 0) => {
    for (let i = start; i < h.first.sent.length; i++) {
      const frame = h.first.sent[i] as WireRequest;
      if (frame[0] === "CLOSE") active.delete(frame[1]);
      if (frame[0] !== "REQ") continue;
      active.add(frame[1]);
      expect(active.size).toBeLessThanOrEqual(1024);
      const filters = filtersOf(frame);
      expect(filters.length).toBeLessThanOrEqual(10);
      expect(scopeOf(frame).length).toBeLessThanOrEqual(2048);
      if (scopeOf(frame).length && filters[0]?.limit === 0) {
        for (const id of scopeOf(frame)) live.set(id, frame);
      } else if (scopeOf(frame).length) {
        // One combined replay filter per REQ, at most 256 channels.
        expect(filters).toHaveLength(1);
        expect(filters[0]?.limit).toBe(500);
        expect(scopeOf(frame).length).toBeLessThanOrEqual(256);
        replayed += scopeOf(frame).length;
      }
      await h.first.receive(["EOSE", frame[1]]);
    }
  };
  try {
    h.owner.update(ids, ids);
    await h.first.auth();
    await drain();
    expect(live.size).toBe(100_000);
    expect(replayed).toBe(100_000);
    expect(active.size).toBe(51);
    expect(
      latest?.routes.filter((r) => r.channelId && r.status === "live"),
    ).toHaveLength(100_000);
    const last = ids.at(-1);
    assert.exists(last);
    const source = live.get(last);
    assert.exists(source);
    const event = message(h.key, last, "last channel input", 1700000001);
    await h.first.receive(["EVENT", source[1], event]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
      channelId: last,
      phase: "live",
    });
    const start = h.first.sent.length;
    h.owner.update(
      [...ids.slice(0, -1), "replacement"],
      [...ids.slice(0, -1), "replacement"],
    );
    await drain(start);
    h.callbacks.receive.mockClear();
    await h.first.receive(["EVENT", source[1], event]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    expect(
      latest?.routes.some(
        (r) => r.channelId === "replacement" && r.status === "live",
      ),
    ).toBe(true);
    expect(latest?.routes.some((r) => r.channelId === last)).toBe(false);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
}, 60_000);

it("reports a replay failure to recovery, continues other channels, and exposes its retry", async () => {
  vi.useFakeTimers();
  // Enough channels for more combined replays than setup slots.
  const ids = Array.from(
    { length: 2000 },
    (_, i) => `c${String(i).padStart(3, "0")}`,
  );
  const h = setup([], createLiveAdmission(), 2048);
  try {
    h.owner.update(ids, ids);
    await h.first.auth();
    for (const request of [...h.first.requests()])
      await h.first.receive(["EOSE", request[1]]);
    const replay = h.first
      .requests()
      .find((request) => scopeOf(request).length && request[2].limit === 500);
    assert.exists(replay);
    const id = scopeOf(replay)[0];
    assert.exists(id);
    const before = h.first.requests().length;
    await h.first.receive(["CLOSED", replay[1], "error: replay unavailable"]);
    expect(h.first.requests()).toHaveLength(before + 1);
    const snapshot = h.callbacks.state.mock.lastCall?.[0];
    assert.exists(snapshot);
    expect(
      snapshot.routes.find((route) => route.channelId === id),
    ).toMatchObject({ status: "error", error: "error: replay unavailable" });
    expect(
      liveRecoveryStatus({
        ...snapshot,
        roster: { state: "verified" },
        heads: [],
      }),
    ).toBe("failed");
    h.owner.retry();
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (route) => route.channelId === id,
      ),
    ).toMatchObject({ status: "pending" });
    let retry: WireRequest | undefined;
    for (let i = before; i < h.first.requests().length; i++) {
      const request = h.first.requests()[i];
      assert.exists(request);
      if (scopeOf(request).includes(id)) {
        retry = request;
        break;
      }
      await h.first.receive(["EOSE", request[1]]);
    }
    assert.exists(retry);
    await h.first.receive(["EOSE", retry[1]]);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (route) => route.channelId === id,
      ),
    ).toMatchObject({ status: "live" });
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (route) => route.channelId === id,
      )?.error,
    ).toBeUndefined();
  } finally {
    h.owner.dispose();
  }
});

describe("combined replay paging", () => {
  const ids = Array.from(
    { length: 300 },
    (_, i) => `c${String(i).padStart(3, "0")}`,
  );
  const isReplay = (request: WireRequest) =>
    scopeOf(request).length > 0 && request[2].limit === 500;
  async function start() {
    const h = setup([], createLiveAdmission(), 2048);
    h.owner.update(ids, ids);
    await h.first.auth();
    for (const request of [...h.first.requests()])
      if (!isReplay(request)) await h.first.receive(["EOSE", request[1]]);
    const first = h.first.requests().find(isReplay);
    assert.exists(first);
    expect(scopeOf(first)).toEqual(ids.slice(0, 256));
    return { h, first };
  }
  async function page(
    h: ReturnType<typeof setup>,
    request: WireRequest,
    events: [channel: string, at: number][],
  ) {
    for (const [i, [channel, at]] of events.entries())
      await h.first.receive([
        "EVENT",
        request[1],
        message(h.key, channel, `${request[1]} ${i}`, at),
      ]);
    await h.first.receive(["EOSE", request[1]]);
  }
  const run = (channel: string, newest: number, count: number) =>
    Array.from(
      { length: count },
      (_, i) => [channel, newest - Math.floor(i / 4)] as [string, number],
    );
  const pagesAfter = (h: ReturnType<typeof setup>, request: WireRequest) =>
    h.first
      .requests()
      .slice(h.first.requests().indexOf(request) + 1)
      .filter((r) => isReplay(r) && r[2].until !== undefined);

  it("asks for the rest below its oldest event, without channels that have their newest 500", async () => {
    vi.useFakeTimers({ now: 1_700_000_600_000 });
    const { h, first } = await start();
    try {
      await page(h, first, run("c000", 1_700_000_600, 500));
      const second = pagesAfter(h, first)[0];
      assert.exists(second);
      expect(filtersOf(second)).toHaveLength(1);
      expect(second[2]).toMatchObject({
        "#h": ids.slice(1, 256),
        since: first[2].since,
        until: 1_700_000_476,
        limit: 500,
      });
      await page(h, second, run("c001", 1_700_000_476, 500));
      const third = pagesAfter(h, second)[0];
      assert.exists(third);
      // The event at the cutoff second may repeat one already delivered.
      expect(third[2]).toMatchObject({
        "#h": ids.slice(1, 256),
        until: 1_700_000_352,
      });
      await page(h, third, run("c002", 1_700_000_352, 3));
      expect(pagesAfter(h, third)).toEqual([]);
      expect(
        h.first
          .requests()
          .filter((r) => isReplay(r) && r[2]["#h"]?.length === 1),
      ).toEqual([]);
    } finally {
      h.owner.dispose();
    }
  }, 60_000);

  it("keeps paging when an undecodable frame fills the page", async () => {
    vi.useFakeTimers({ now: 1_700_000_600_000 });
    const { h, first } = await start();
    const log = captureLog();
    try {
      await h.first.receive(["EVENT", first[1], {}]);
      await page(h, first, run("c000", 1_700_000_600, 499));
      expect(log.lines).toEqual([
        "warn relay.test dropped an undecodable live event",
      ]);
      const second = pagesAfter(h, first)[0];
      assert.exists(second);
      // c000 counted only 499, so it stays in the next page.
      expect(second[2]).toMatchObject({
        "#h": ids.slice(0, 256),
        until: 1_700_000_476,
      });
    } finally {
      log.restore();
      h.owner.dispose();
    }
  }, 60_000);

  it.each([
    "tied cutoff",
    "duplicate live event",
    "backdated live event",
    "page of undecodable frames",
  ])(
    "falls back to per-channel replay after a %s",
    async (scenario) => {
      vi.useFakeTimers({ now: 1_700_000_600_000 });
      const { h, first } = await start();
      try {
        const at = 1_700_000_500;
        const tie = (n: number) =>
          Array.from(
            { length: n },
            (_, i) => [ids[i % 10] ?? "", at] as [string, number],
          );
        let last = first;
        if (scenario === "tied cutoff") {
          await page(h, first, tie(500));
          const second = pagesAfter(h, first)[0];
          assert.exists(second);
          expect(second[2]).toMatchObject({
            "#h": ids.slice(0, 256),
            until: at,
          });
          await page(h, second, tie(500));
          last = second;
        } else if (scenario === "page of undecodable frames") {
          // No decodable event gives a cutoff to page below.
          const log = captureLog();
          try {
            for (let i = 0; i < 500; i++)
              await h.first.receive(["EVENT", first[1], {}]);
            await h.first.receive(["EOSE", first[1]]);
          } finally {
            log.restore();
          }
        } else {
          // Fan-out is registered before historical delivery. A duplicate must
          // not count as A's 500th row; a backdated arrival must not skip a tail.
          await h.first.receive([
            "EVENT",
            first[1],
            message(
              h.key,
              "c000",
              scenario === "duplicate live event" ? `${first[1]} 0` : "late",
              scenario === "duplicate live event" ? at + 100 : at - 50,
            ),
          ]);
          await page(h, first, [
            ...run("c000", at + 100, 499),
            ["c001", at - 24],
          ]);
        }
        expect(pagesAfter(h, last)).toEqual([]);
        for (let i = 0; i < 40; i++) {
          const pending = h.first
            .requests()
            .slice(h.first.requests().indexOf(last) + 1)
            .filter((r) => isReplay(r) && scopeOf(r).length < 256);
          if (pending.some((r) => r[2]["#h"]?.length === 1)) break;
          for (const r of pending) await h.first.receive(["EOSE", r[1]]);
        }
        const singles = h.first
          .requests()
          .filter(
            (r) =>
              isReplay(r) && filtersOf(r).every((f) => f["#h"]?.length === 1),
          );
        const single = singles[0];
        assert.exists(single);
        expect(filtersOf(single)).toHaveLength(10);
        expect(scopeOf(single)).toContain("c000");
        expect(
          filtersOf(single).every(
            (f) => f.since === first[2].since && !("until" in f),
          ),
        ).toBe(true);
      } finally {
        h.owner.dispose();
      }
    },
    60_000,
  );
});

it.each([
  "replay-first",
  "live-first",
  "known-history",
  "replay-finite-live",
  "finite-first",
])(
  "keeps incoming alerts correct across duplicate sources: %s",
  async (order) => {
    vi.useFakeTimers({ now: 1_700_000_100_000 });
    const h = setup([], createLiveAdmission(), 2048);
    const relay = keypair(),
      author = keypair();
    const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        h.callbacks.receive.mockImplementation(callbacks.receive);
        h.callbacks.state.mockImplementation(callbacks.state);
        return h.owner;
      },
    });
    try {
      const ids = Array.from(
        { length: 11 },
        (_, i) => `c${String(i).padStart(2, "0")}`,
      );
      h.callbacks.receive(ids.map((id) => roster(relay, id, [h.key.pubkey])));
      await h.first.auth();
      for (const request of [...h.first.requests()])
        await h.first.receive(["EOSE", request[1]]);
      const source = h.first
        .requests()
        .find((r) => scopeOf(r).includes("c00") && r[2].limit === 0);
      const replay = h.first
        .requests()
        .find((r) => scopeOf(r).includes("c00") && r[2].limit === 500);
      assert.exists(source);
      assert.exists(replay);
      const incoming = vi.fn();
      owner.session.subscribeIncoming(incoming);
      const event = message(author, "c00", "fresh input", 1_700_000_100);
      const finite = async () => {
        const read = owner.session.readRemote([
          { kinds: [9], "#h": ["c00"], limit: 10 },
        ]);
        wire.next().respond([event]);
        await read;
      };
      if (order === "known-history") h.callbacks.receive([event]);
      if (order === "finite-first") await finite();
      if (order === "live-first")
        await h.first.receive(["EVENT", source[1], event]);
      await h.first.receive(["EVENT", replay[1], event]);
      await h.first.receive(["EVENT", replay[1], event]);
      expect(incoming).toHaveBeenCalledTimes(order === "live-first" ? 1 : 0);
      if (order === "replay-finite-live") await finite();
      await h.first.receive(["EVENT", source[1], event]);
      const count =
        order === "known-history" || order === "finite-first" ? 0 : 1;
      expect(incoming).toHaveBeenCalledTimes(count);
      await h.first.receive(["EVENT", replay[1], event]);
      await h.first.receive(["EVENT", source[1], event]);
      expect(incoming).toHaveBeenCalledTimes(count);
    } finally {
      owner.dispose();
    }
  },
);

it("shares the wire budget with artifact syncs and the silence probe", async () => {
  vi.useFakeTimers();
  const ids = Array.from({ length: 1024 }, (_, i) => `c${i}`);
  const h = setup(ids);
  const release: (() => void)[] = [];
  try {
    await h.first.auth();
    assert.exists(h.owner.syncArtifacts);
    for (let i = 0; i < 32; i++)
      release.push(
        h.owner.syncArtifacts(
          {
            artifact: "current",
            "#h": ["11111111-1111-4111-8111-111111111111"],
          },
          { event() {}, eose() {}, closed() {} },
        ),
      );
    const refused = vi.fn();
    h.owner.syncArtifacts(
      { artifact: "current", "#h": ["11111111-1111-4111-8111-111111111111"] },
      { event() {}, eose() {}, closed: refused },
    );
    await Promise.resolve();
    expect(refused).toHaveBeenCalledExactlyOnceWith(
      "error: artifact sync capacity reached",
    );
    for (let i = 0; i < h.first.requests().length; i++) {
      await h.first.receive(["EOSE", h.first.requests()[i]?.[1]]);
      h.callbacks.state.mockClear();
    }
    await vi.advanceTimersByTimeAsync(120_000);
    const active = new Set();
    for (const [kind, id] of h.first.sent) {
      if (kind === "REQ") active.add(id);
      if (kind === "CLOSE") active.delete(id);
      expect(active.size).toBeLessThanOrEqual(1024);
    }
    expect(
      h.first.requests().filter((request) => request[1].startsWith("sync-")),
    ).toHaveLength(32);
    expect(h.first.probes()).toHaveLength(1);
  } finally {
    for (const close of release) close();
    h.owner.dispose();
  }
});
it("reserves the silence probe when a profile sync starts at channel capacity", async () => {
  vi.useFakeTimers();
  const h = setup(Array.from({ length: 1021 }, (_, index) => `c${index}`));
  let release: (() => void) | undefined;
  try {
    await h.first.auth();
    for (let i = 0; i < h.first.requests().length; i++)
      await h.first.receive(["EOSE", h.first.requests()[i]?.[1]]);
    assert.exists(h.owner.syncVerifiedProfiles);
    release = h.owner.syncVerifiedProfiles(
      verifiedProfileFilter("a".repeat(64), ["b".repeat(64)]),
      { event() {}, eose() {}, closed() {} },
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.first.probes()).toHaveLength(1);
    release();
    release = undefined;
    for (let i = 0; i < h.first.requests().length; i++)
      await h.first.receive(["EOSE", h.first.requests()[i]?.[1]]);
    const active = new Set();
    for (const [kind, id] of h.first.sent) {
      if (kind === "REQ") active.add(id);
      if (kind === "CLOSE") active.delete(id);
      expect(active.size).toBeLessThanOrEqual(1024);
    }
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.some(
        (route) => route.status === "limited",
      ),
    ).toBe(false);
  } finally {
    release?.();
    h.owner.dispose();
  }
});
it("bounds profile syncs even without channel routes", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const release: (() => void)[] = [];
  try {
    await h.first.auth();
    assert.exists(h.owner.syncVerifiedProfiles);
    const filter = verifiedProfileFilter("a".repeat(64), ["b".repeat(64)]);
    for (let i = 0; i < VERIFIED_PROFILE_MAX_SYNCS; i++)
      release.push(
        h.owner.syncVerifiedProfiles(filter, {
          event() {},
          eose() {},
          closed() {},
        }),
      );
    const refused = vi.fn();
    release.push(
      h.owner.syncVerifiedProfiles(filter, {
        event() {},
        eose() {},
        closed: refused,
      }),
    );
    await Promise.resolve();
    expect(refused).toHaveBeenCalledExactlyOnceWith(
      "error: profile sync capacity reached",
    );
    expect(
      h.first.requests().filter((request) => request[1].startsWith("sync-")),
    ).toHaveLength(VERIFIED_PROFILE_MAX_SYNCS);
  } finally {
    for (const close of release) close();
    h.owner.dispose();
  }
});
it("admits a full directory's profile syncs without refusing artifact views", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const release: (() => void)[] = [];
  const sink = { event() {}, eose() {}, closed: vi.fn() };
  const artifact = {
    artifact: "current" as const,
    "#h": ["11111111-1111-4111-8111-111111111111"],
  };
  try {
    await h.first.auth();
    assert.exists(h.owner.syncVerifiedProfiles);
    assert.exists(h.owner.syncArtifacts);
    // The largest directory needs this many 128-subject batches.
    expect(VERIFIED_PROFILE_MAX_SYNCS).toBe(80);
    const filter = verifiedProfileFilter("a".repeat(64), ["b".repeat(64)]);
    for (let i = 0; i < VERIFIED_PROFILE_MAX_SYNCS; i++)
      release.push(h.owner.syncVerifiedProfiles(filter, sink));
    for (let i = 0; i < 32; i++)
      release.push(h.owner.syncArtifacts(artifact, sink));
    await Promise.resolve();
    expect(sink.closed).not.toHaveBeenCalled();
    const refused = vi.fn();
    release.push(
      h.owner.syncArtifacts(artifact, {
        event() {},
        eose() {},
        closed: refused,
      }),
    );
    await Promise.resolve();
    expect(refused).toHaveBeenCalledExactlyOnceWith(
      "error: artifact sync capacity reached",
    );
    expect(
      h.first.requests().filter((request) => request[1].startsWith("sync-")),
    ).toHaveLength(VERIFIED_PROFILE_MAX_SYNCS + 32);
    // A released profile sync frees its own pool, not the artifact pool.
    release.shift()?.();
    const again = vi.fn();
    release.push(
      h.owner.syncArtifacts(artifact, { event() {}, eose() {}, closed: again }),
    );
    await Promise.resolve();
    expect(again).toHaveBeenCalledExactlyOnceWith(
      "error: artifact sync capacity reached",
    );
  } finally {
    for (const close of release) close();
    h.owner.dispose();
  }
});
it("does not forward a relay CLOSED as local socket loss", async () => {
  const h = setup([]);
  try {
    await h.first.auth();
    assert.exists(h.owner.syncVerifiedProfiles);
    const closed = vi.fn();
    h.owner.syncVerifiedProfiles(
      verifiedProfileFilter("a".repeat(64), ["b".repeat(64)]),
      { event() {}, eose() {}, closed },
    );
    await Promise.resolve();
    const sync = h.first
      .requests()
      .find((request) => request[1].startsWith("sync-"));
    assert.exists(sync);
    await h.first.receive(["CLOSED", sync[1], "disconnected: forged"]);
    expect(closed).toHaveBeenCalledExactlyOnceWith(
      "error: relay closed the sync",
    );
  } finally {
    h.owner.dispose();
  }
});
describe("policy close (1008) recovery", () => {
  const deny = async (socket: Socket) => {
    await socket.receive(["NOTICE", "auth-required: authorization denied"]);
    (
      socket.onclose as unknown as (event: {
        code: number;
        reason: string;
      }) => void
    )?.({
      code: 1008,
      reason: "authorization denied",
    });
  };
  const status = (h: ReturnType<typeof setup>) =>
    h.callbacks.state.mock.lastCall?.[0].status;
  it("stops when the fresh-evidence reconnect is denied after NIP-42", async () => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      await h.first.auth();
      await deny(h.first);
      expect(status(h)).toBe("retrying");
      await vi.advanceTimersByTimeAsync(2000);
      const second = h.sockets[1];
      assert.exists(second);
      // The relay checks the deny set after the upgrade and the AUTH frame.
      await second.receive(["AUTH", "challenge"]);
      expect(second.sent.some((entry) => entry[0] === "AUTH")).toBe(true);
      await deny(second);
      expect(status(h)).toBe("error");
      await vi.advanceTimersByTimeAsync(600000);
      expect(h.sockets).toHaveLength(2);
    } finally {
      h.owner.dispose();
    }
  });
  it("keeps recovering ordinary expiry once each admission succeeds", async () => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      for (let i = 0; i < 3; i++) {
        const socket = h.sockets[i];
        assert.exists(socket);
        await socket.auth();
        expect(status(h)).toBe("connected");
        await deny(socket);
        expect(status(h)).toBe("retrying");
        await vi.advanceTimersByTimeAsync(2000);
      }
      expect(h.sockets).toHaveLength(4);
    } finally {
      h.owner.dispose();
    }
  });
  it("stops on a repeated policy close before AUTH", async () => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      await deny(h.first);
      expect(status(h)).toBe("retrying");
      await vi.advanceTimersByTimeAsync(2000);
      const second = h.sockets[1];
      assert.exists(second);
      await deny(second);
      expect(status(h)).toBe("error");
    } finally {
      h.owner.dispose();
    }
  });
  it("does not reconnect a disposed subscription", async () => {
    vi.useFakeTimers();
    const h = setup([]);
    await h.first.auth();
    h.owner.dispose();
    await deny(h.first);
    await vi.advanceTimersByTimeAsync(600000);
    expect(h.sockets).toHaveLength(1);
  });
});
it("a replaced socket's late 1008 leaves the current connection's budget", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const policyClose = (socket: Socket) =>
    (
      socket.onclose as unknown as (event: {
        code: number;
        reason: string;
      }) => void
    )?.({ code: 1008, reason: "expired" });
  try {
    // The first socket never authenticates and is replaced after its deadline.
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(1000);
    const current = h.sockets[1];
    assert.exists(current);
    await current.auth();
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    policyClose(h.first);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    // Ordinary expiry on the admitted socket still gets its reconnect.
    policyClose(current);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("retrying");
  } finally {
    h.owner.dispose();
  }
});

it("backs off a relay's sign-in refusal and stops on a local terminal one", async () => {
  vi.useFakeTimers();
  const run = (message: string) => {
    const sockets: Socket[] = [];
    const state = vi.fn();
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (event) => signed(keypair(), event),
      keypair().pubkey,
      { state, receive: vi.fn(), established: vi.fn(), denied: vi.fn() },
      () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );
    const refuse = () =>
      (sockets.at(-1)?.onerror as ((event: Event) => void) | undefined)?.(
        Object.assign(new Event("error"), { terminal: true, message }),
      );
    return { owner, sockets, state, refuse };
  };
  const signIn = run("Federated sign-in is required");
  signIn.refuse();
  expect(signIn.state.mock.lastCall?.[0]).toMatchObject({
    status: "error",
    error: "Federated sign-in is required",
  });
  // Never a tight loop: nothing before the slow interval, then one attempt.
  await vi.advanceTimersByTimeAsync(59_000);
  expect(signIn.sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(signIn.sockets).toHaveLength(2);
  // The next refusal doubles the wait.
  signIn.refuse();
  await vi.advanceTimersByTimeAsync(119_000);
  expect(signIn.sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(signIn.sockets).toHaveLength(3);
  signIn.owner.dispose();

  const forbidden = run("relay-forbidden");
  forbidden.refuse();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(forbidden.sockets).toHaveLength(1);
  forbidden.owner.dispose();
});

/** Authenticate, send every route, and establish each one. */
async function establish(socket: Socket) {
  await socket.auth();
  await vi.advanceTimersByTimeAsync(750);
  for (const request of socket.requests())
    await socket.receive(["EOSE", request[1]]);
}
/** The native socket's planned federated renewal of an admitted connection. */
function renew(socket: Socket) {
  socket.readyState = 3;
  (socket.onclose as (event: { renew: true }) => void)({ renew: true });
}
it("establishes a carried batch whose renewal replay carried a reply", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a", "b", "c"], ["a", "b"]);
    await establish(h.first);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    for (const request of h.first.requests())
      await h.first.receive(["EOSE", request[1]]);
    h.callbacks.established.mockClear();
    renew(h.first);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    const batch = second.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(batch);
    // A reply changes a thread summary no replay carries, so channel a owes
    // its read even though the renewal kept the batch's cursor.
    const reply = message(keypair(), "a", "a reply", 1700000000, [
      ["e", "root", "", "reply"],
    ]);
    await second.receive(["EVENT", batch[1], reply]);
    for (const request of second.requests())
      await second.receive(["EOSE", request[1]]);
    expect(h.callbacks.established).toHaveBeenCalledTimes(1);
    const [channels, , continuous] =
      h.callbacks.established.mock.calls[0] ?? [];
    expect(channels).toEqual(["a", "b"]);
    expect(continuous ?? []).not.toContain("a");
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps a planned renewal connected and skips catch-up for carried routes", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a", "b", "c"], ["a", "b"]);
    await establish(h.first);
    // A batch for a and b, a singleton for c, and both globals.
    expect(h.callbacks.established).toHaveBeenCalledTimes(4);
    // Long enough that the cursor, not the first connect, bounds the resume.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // Each recovery tick renews the batch; establish its latest replacement.
    for (const request of h.first.requests())
      await h.first.receive(["EOSE", request[1]]);
    h.callbacks.established.mockClear();
    h.callbacks.state.mockClear();
    renew(h.first);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    const batch = second.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(batch);
    // The new batch replays from its cursor, with the drift overlap.
    const resumed = filtersOf(batch)[0];
    expect(resumed?.limit).toBe(500);
    const lag = Math.floor(Date.now() / 1000) - (resumed?.since ?? 0);
    expect(lag).toBeGreaterThan(960);
    expect(lag).toBeLessThanOrEqual(1100);
    const event = message(keypair(), "a", "during renewal", 1700000000);
    await second.receive(["EVENT", batch[1], event]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
      phase: "replay",
      channelId: "a",
    });
    for (const request of second.requests())
      await second.receive(["EOSE", request[1]]);
    expect(h.callbacks.established).not.toHaveBeenCalled();
    const states = h.callbacks.state.mock.calls.map(([state]) => state);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.status).toBe("connected");
      for (const route of state.routes)
        expect(route, JSON.stringify(state)).toMatchObject({ status: "live" });
    }
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});
it("catches up a live-only batch after a planned renewal", async () => {
  vi.useFakeTimers();
  const h = setup([], undefined, 2048);
  const ids = Array.from({ length: 11 }, (_, index) => `room-${index}`);
  try {
    h.owner.update(ids, ids);
    await establish(h.first);
    for (let i = 0; i < h.first.requests().length; i++)
      await h.first.receive(["EOSE", h.first.requests()[i]?.[1]]);
    h.callbacks.established.mockClear();
    h.callbacks.state.mockClear();
    renew(h.first);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    const batch = second
      .requests()
      .find((request) =>
        filtersOf(request).some(
          (filter) => filter.limit === 0 && filter["#h"]?.length === 11,
        ),
      );
    assert.exists(batch);
    for (const request of second.requests())
      if (request[1] !== batch[1]) await second.receive(["EOSE", request[1]]);
    expect(h.callbacks.established).not.toHaveBeenCalled();
    h.callbacks.state.mockClear();
    await second.receive(["EOSE", batch[1]]);
    expect(h.callbacks.state.mock.calls.map(([state]) => state.status)).toEqual(
      ["connected", "connecting", "connected"],
    );
    // The batch's channels establish when their history replay ends.
    expect(h.callbacks.established).toHaveBeenCalledTimes(2);
    for (let i = 0; i < second.requests().length; i++)
      await second.receive(["EOSE", second.requests()[i]?.[1]]);
    expect(h.callbacks.established).toHaveBeenCalledTimes(3);
    expect(h.callbacks.established).toHaveBeenLastCalledWith([...ids].sort());
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});
it("recovers like an outage after a renewal whose replay hit the limit", async () => {
  vi.useFakeTimers();
  const h = setup(["a", "b"]);
  try {
    age();
    await establish(h.first);
    h.callbacks.established.mockClear();
    renew(h.first);
    h.callbacks.state.mockClear();
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    const a = second.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(a);
    const event = message(keypair(), "a", "busy", 1700000000);
    for (let i = 0; i < 500; i++) await second.receive(["EVENT", a[1], event]);
    for (const request of second.requests())
      if (request[1] !== a[1]) await second.receive(["EOSE", request[1]]);
    expect(h.callbacks.established).not.toHaveBeenCalled();
    await second.receive(["EOSE", a[1]]);
    // The cut replay reports the hidden drop, so session and agent consumers
    // run their outage recovery, and every live route establishes again. Only
    // b's replay closed its gap: a's hit the limit.
    const statuses = h.callbacks.state.mock.calls.map(
      ([state]) => state.status,
    );
    expect(statuses.slice(-2)).toEqual(["connecting", "connected"]);
    expect(statuses.slice(0, -2)).not.toContain("connecting");
    expect(h.callbacks.established.mock.calls).toEqual(
      expect.arrayContaining([
        [undefined, { route: "profiles", continuous: true }],
        [undefined, { route: "membership", continuous: true }],
        ["b", undefined, ["b"]],
        ["a"],
      ]),
    );
    expect(h.callbacks.established).toHaveBeenCalledTimes(4);
  } finally {
    h.owner.dispose();
  }
});
it("falls back to the outage path when a renewal's new socket fails", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    age();
    await establish(h.first);
    h.callbacks.established.mockClear();
    h.callbacks.state.mockClear();
    renew(h.first);
    const second = h.sockets[1];
    assert.exists(second);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    second.close(1006);
    const failed = h.callbacks.state.mock.lastCall?.[0];
    expect(failed?.status).toBe("retrying");
    expect(failed?.routes.map((route) => route.status)).not.toContain("live");
    await vi.advanceTimersByTimeAsync(1000);
    const third = h.sockets[2];
    assert.exists(third);
    await establish(third);
    // A real outage: every route establishes again. The replay resumed from
    // the first socket's cursor and ended below the limit, so it closed the gap.
    expect(h.callbacks.established).toHaveBeenCalledWith("a", undefined, ["a"]);
    expect(h.callbacks.established).toHaveBeenCalledTimes(3);
  } finally {
    h.owner.dispose();
  }
});
it.each(["complete", "cut", "closed", "renewed"] as const)(
  "runs the session's outage recovery after a renewal only when continuity breaks (%s)",
  async (mode) => {
    vi.useFakeTimers();
    const h = setup([]);
    const relay = keypair();
    const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
    const rosters = ["a", "b"].map((id) => roster(relay, id, [h.key.pubkey]));
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        h.callbacks.receive.mockImplementation(callbacks.receive);
        h.callbacks.state.mockImplementation(callbacks.state);
        h.callbacks.established.mockImplementation(callbacks.established);
        return h.owner;
      },
    });
    /** Answers every read: rosters for membership reads, nothing otherwise. */
    const answer = async (reads: (readonly unknown[])[] = []) => {
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50);
        for (const entry of wire.pending.splice(0)) {
          reads.push(entry.filters);
          entry.respond(
            entry.filters.some((f) => f.kinds?.includes(39002)) ? rosters : [],
          );
        }
      }
      return reads;
    };
    try {
      age();
      h.callbacks.receive(rosters);
      owner.session.channels.ensure("a");
      await answer();
      await establish(h.first);
      await answer();
      // What Attention and reminders watch: the session's live status.
      const seen: string[] = [];
      const stopSeen = owner.session.live.subscribe(() =>
        seen.push(owner.session.live.snapshot().status),
      );
      renew(h.first);
      h.callbacks.state.mockClear();
      const second = h.sockets[1];
      assert.exists(second);
      await second.auth();
      await vi.advanceTimersByTimeAsync(750);
      const a = second.requests().find((r) => scopeOf(r).includes("a"));
      assert.exists(a);
      const event = message(keypair(), "a", "busy", 1700000000);
      if (mode === "cut")
        for (let i = 0; i < 500; i++)
          await second.receive(["EVENT", a[1], event]);
      let socket = second;
      if (mode === "closed") {
        // The carried route fails after AUTH; a retry then establishes it.
        await second.receive(["CLOSED", a[1], "error: shutting down"]);
        h.owner.retry();
        await vi.advanceTimersByTimeAsync(750);
      } else if (mode === "renewed") {
        // A second renewal arrives before the first one's replay completed.
        renew(second);
        const third = h.sockets[2];
        assert.exists(third);
        await third.auth();
        await vi.advanceTimersByTimeAsync(750);
        socket = third;
      }
      for (const request of socket.requests())
        await socket.receive(["EOSE", request[1]]);
      const reads = await answer();
      // A complete replay needs no read. A broken one re-reads the open
      // channel's head, as after any outage. The membership route itself
      // stayed continuous, so the roster is not read again.
      stopSeen();
      if (mode === "complete") {
        expect(reads).toEqual([]);
        expect(new Set(seen)).toEqual(new Set(["connected"]));
      } else {
        // Agents start a new catch-up epoch on this drop and reconnect.
        expect(seen).toContain("connecting");
        expect(seen.at(-1)).toBe("connected");
        expect(reads).not.toContainEqual([
          expect.objectContaining({ kinds: [39002] }),
        ]);
        expect(reads).toContainEqual([
          expect.objectContaining({ "#h": ["a"], top_level: true }),
        ]);
      }
    } finally {
      owner.dispose();
    }
  },
);
it("ends a renewal's quiet state when a cooldown stops unsent carried routes", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    // Singleton routes, so setup concurrency leaves b and c unsent.
    h.owner.update(["a", "b", "c"]);
    h.owner.watchPresence?.([keypair().pubkey]);
    await establish(h.first);
    // Setup concurrency sent b and c only after earlier routes went live.
    for (const request of h.first.requests().slice(-2))
      await h.first.receive(["EOSE", request[1]]);
    renew(h.first);
    const second = h.sockets[1];
    assert.exists(second);
    await second.auth();
    const presence = second
      .requests()
      .find((r) => (r[2] as { kinds?: number[] }).kinds?.[0] === 20001);
    assert.exists(presence);
    h.callbacks.state.mockClear();
    await second.receive([
      "CLOSED",
      presence[1],
      "rate-limited: quota exceeded; retry in 120s",
    ]);
    // Presence carries nothing, but the carried routes it stopped lost continuity.
    expect(
      h.callbacks.state.mock.calls.map(([state]) => state.status),
    ).toContain("connecting");
  } finally {
    h.owner.dispose();
  }
});
it("ends a renewal's quiet state when an interest change replaces a carried batch", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    age();
    h.owner.update(["a", "b", "c"], ["a", "b", "c"]);
    await establish(h.first);
    h.callbacks.established.mockClear();
    renew(h.first);
    const second = h.sockets[1];
    assert.exists(second);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    h.owner.update(["a", "b"], ["a", "b"]);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connecting");
    await establish(second);
    // The narrowed batch was never sent, so it replays from both cursors.
    expect(h.callbacks.established).toHaveBeenCalledWith(
      ["a", "b"],
      undefined,
      ["a", "b"],
    );
  } finally {
    h.owner.dispose();
  }
});

it("starts without diagnostic random identities and captures on the existing socket when enabled", async () => {
  networkRecorder.setEnabled(false);
  networkRecorder.clear();
  const identities = vi.spyOn(crypto, "randomUUID");
  const h = setup([]);
  try {
    await h.first.auth();
    expect(identities).not.toHaveBeenCalled();
    expect(networkRecorder.snapshot().events).toEqual([]);
    networkRecorder.setEnabled(true);
    networkRecorder.configure("debug");
    await h.first.receive(["NOTICE", "ready"]);
    expect(h.sockets).toHaveLength(1);
    expect(networkRecorder.snapshot().events).toContainEqual(
      expect.objectContaining({
        event: "ws.frame",
        parentId: expect.stringMatching(/^live:/),
        connection: expect.any(String),
      }),
    );
  } finally {
    h.owner.dispose();
    identities.mockRestore();
    networkRecorder.configure("info");
    networkRecorder.clear();
  }
});

it.each(
  (["idle", "wake"] as const).flatMap((trigger) =>
    (["answered", "timeout"] as const).map(
      (outcome) => [trigger, outcome] as const,
    ),
  ),
)(
  "collects Info metrics for connection and %s probe %s without frame records",
  async (trigger, outcome) => {
    vi.useFakeTimers();
    networkRecorder.configure("info");
    networkRecorder.clear();
    networkMetrics.setEnabled(true);
    const h = setup([], createLiveAdmission(), undefined, () => 1);
    try {
      await vi.advanceTimersByTimeAsync(20);
      h.first.onopen?.();
      await h.first.auth();
      expect(networkMetrics.snapshot().relays[0]).toMatchObject({
        active: 1,
        authenticated: 1,
        session: {
          counts: { connects: 1, connectOk: 1 },
          latency: { opening: { mean: 20 } },
        },
      });
      h.first.silent = true;
      await vi.advanceTimersByTimeAsync(trigger === "wake" ? 20_000 : 60_000);
      if (trigger === "wake") h.owner.check?.();
      const probe = h.first.probes().at(-1);
      expect(probe).toBeDefined();
      expect(
        networkMetrics.snapshot().relays[0]?.session.counts.probeSent,
      ).toBe(1);
      if (outcome === "answered") {
        await vi.advanceTimersByTimeAsync(25);
        await h.first.receive(["EOSE", probe?.[1]]);
        expect(
          networkMetrics.snapshot().relays[0]?.session.latency.rtt,
        ).toMatchObject({ count: 1, mean: 25 });
      } else {
        const timeout =
          trigger === "wake" ? LIVE_CHECK_TIMEOUT_MS : SETUP_TIMEOUT_MS;
        await vi.advanceTimersByTimeAsync(timeout - 1);
        expect(
          networkMetrics.snapshot().relays[0]?.session.counts.probeTimeout,
        ).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(networkMetrics.snapshot().relays[0]).toMatchObject({
          active: 0,
          session: { counts: { probeTimeout: 1, reconnects: 0 } },
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(
          networkMetrics.snapshot().relays[0]?.session.counts.reconnects,
        ).toBe(1);
      }
      expect(
        networkRecorder
          .snapshot()
          .events.some((event) => event.event === "ws.frame"),
      ).toBe(false);
    } finally {
      h.owner.dispose();
      networkMetrics.setEnabled(false);
      networkMetrics.reset();
    }
  },
);

it.each(
  (["enable", "clear", "resume"] as const).flatMap((transition) =>
    (["answered", "timeout"] as const).map(
      (outcome) => [transition, outcome] as const,
    ),
  ),
)(
  "does not attribute a pre-capture probe to a new capture after %s (%s)",
  async (transition, outcome) => {
    vi.useFakeTimers();
    networkMetrics.setEnabled(transition !== "enable");
    const h = setup([]);
    try {
      await h.first.auth();
      h.first.silent = true;
      await vi.advanceTimersByTimeAsync(60_000);
      const probe = h.first.probes().at(-1);
      assert.exists(probe);
      if (transition === "clear") networkMetrics.reset();
      else {
        networkMetrics.setEnabled(false);
        networkMetrics.setEnabled(true);
      }
      if (outcome === "answered") await h.first.receive(["EOSE", probe[1]]);
      else await vi.advanceTimersByTimeAsync(10_000);
      expect(networkMetrics.snapshot().relays[0]).toMatchObject({
        session: {
          counts: {
            probeSent: 0,
            probeAnswered: 0,
            probeTimeout: 0,
            probeCancelled: 0,
          },
          latency: { rtt: { count: 0 } },
        },
      });
    } finally {
      h.owner.dispose();
      networkMetrics.setEnabled(false);
      networkMetrics.reset();
    }
  },
);

it("shows authentication state without counting a handshake started before capture", async () => {
  networkMetrics.setEnabled(false);
  const h = setup([]);
  try {
    h.first.onopen?.();
    networkMetrics.setEnabled(true);
    await h.first.auth();
    expect(networkMetrics.snapshot().relays[0]).toMatchObject({
      active: 1,
      authenticated: 1,
      session: {
        counts: { connects: 0, connectOk: 0 },
        latency: { ready: { count: 0 }, authentication: { count: 0 } },
      },
    });
  } finally {
    h.owner.dispose();
    networkMetrics.setEnabled(false);
    networkMetrics.reset();
  }
});
