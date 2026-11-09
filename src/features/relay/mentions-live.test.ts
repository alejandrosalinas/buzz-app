import { assert, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { subscribeRelayTraffic } from "./live";
import { keypair, metadata, roster, signed } from "./testing";
import { matchesEvent } from "./projection";
import { createRelayProfiler } from "./profiling";
import { deliveryFeedback } from "../messages/delivery";
import type { EventTemplate } from "nostr-tools";
import type { ReadFilter, RelayEvent } from "./events";
import type { OutgoingEvent } from "./outbox";

class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
  requests() {
    return this.sent.filter((e) => e[0] === "REQ");
  }
  async auth() {
    await this.receive(["AUTH", "challenge"]);
    const event = this.sent.find((e) => e[0] === "AUTH")?.[1];
    await this.receive(["OK", (event as RelayEvent).id, true]);
  }
}
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function setup(restored?: {
  viewer: ReturnType<typeof keypair>;
  relay: ReturnType<typeof keypair>;
  agent: ReturnType<typeof keypair>;
  records: OutgoingEvent[];
}) {
  vi.useFakeTimers();
  const viewer = restored?.viewer ?? keypair(),
    relay = restored?.relay ?? keypair(),
    agent = restored?.agent ?? keypair();
  let members = [viewer.pubkey, agent.pubkey],
    time = 1700000000;
  let failMetadata = false,
    loseAck = false;
  const sockets: Socket[] = [];
  const preflights: {
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  let holdPreflight = false;
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (
      holdPreflight &&
      filters[0]?.authors?.includes(relay.pubkey) &&
      filters[0]?.kinds?.includes(39002)
    )
      return new Promise<RelayEvent[]>((resolve, reject) =>
        preflights.push({ resolve, reject }),
      );
    if (failMetadata && filters.some((f) => f.kinds?.includes(39000)))
      throw new Error("optional metadata unavailable");
    return [
      roster(relay, "c", members, time),
      metadata(relay, "c", "General"),
    ].filter((e) => filters.some((f) => matchesEvent(e, f)));
  });
  const publish = vi.fn(async (_event: RelayEvent) => {
    if (loseAck) throw new Error("ACK connection lost");
  });
  const sign = vi.fn(async (template: EventTemplate) =>
    signed(viewer, template),
  );
  const profiling = createRelayProfiler();
  let afterPreparation: (() => Promise<void>) | undefined;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      query,
      writer: { kinds: [9], sign, publish },
      subscribe(callbacks) {
        return subscribeRelayTraffic(
          "wss://fixture.invalid",
          async (t) => signed(viewer, t),
          viewer.pubkey,
          callbacks,
          () => {
            const socket = new Socket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        );
      },
    },
    {
      outboxStorage: { load: () => restored?.records ?? [], save: () => {} },
      profiling: {
        ...profiling,
        async measureAsync(stage, id, work) {
          const result = await profiling.measureAsync(stage, id, work);
          if (stage === "send.prepare") {
            const action = afterPreparation;
            afterPreparation = undefined;
            await action?.();
          }
          return result;
        },
      },
    },
  );
  owners.push(owner);
  owner.session.channels.ensureList();
  return {
    ...owner,
    agent,
    viewer,
    relay,
    socket(index = 0) {
      const socket = sockets[index];
      assert.exists(socket);
      return socket;
    },
    query,
    preflights,
    holdPreflight() {
      holdPreflight = true;
    },
    afterPreparation(action: () => Promise<void>) {
      afterPreparation = action;
    },
    sign,
    publish,
    removeAgent() {
      members = [viewer.pubkey];
      time++;
    },
    failMetadata() {
      failMetadata = true;
    },
    loseAck() {
      loseAck = true;
    },
  };
}
async function established(h: ReturnType<typeof setup>) {
  await vi.advanceTimersByTimeAsync(0);
  await h.socket().auth();
  await vi.advanceTimersByTimeAsync(750);
  for (const request of h.socket().requests())
    await h.socket().receive(["EOSE", request[1]]);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.session.live.snapshot().roster.state).toBe("verified");
}
it("reconnect AUTH must not reuse previous-generation roster before establishment/read", async () => {
  const h = setup();
  await established(h);
  h.socket().close();
  h.removeAgent();
  expect(() =>
    h.session.messages.send("c", "@Agent", [h.agent.pubkey]),
  ).toThrow(/membership/);
  await vi.advanceTimersByTimeAsync(500);
  await h.socket(1).auth();
  // No new stream has reached EOSE and no post-reconnect finite read has run.
  expect(h.session.live.snapshot()).toMatchObject({
    status: "connected",
    roster: { state: "verified" },
  });
  h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    h.publish,
    "stale member must not reach transport",
  ).not.toHaveBeenCalled();
});
it("failed channel and membership routes must invalidate mention freshness", async () => {
  const h = setup();
  await established(h);
  for (const request of h.socket().requests())
    if (
      (request[2] as Record<string, unknown>)["#h"] ||
      (request[2] as Record<string, unknown>)["#p"]
    )
      await h.socket().receive(["CLOSED", request[1], "subscription failed"]);
  h.removeAgent();
  h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    h.publish,
    "unobserved membership route must not authorize stale member",
  ).not.toHaveBeenCalled();
});
it("local rejection on retry does not prove an earlier dispatched event was unsent", async () => {
  const h = setup();
  await established(h);
  h.loseAck();
  const id = h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("unknown");
  h.removeAgent();
  h.session.channels.refreshList?.();
  await vi.advanceTimersByTimeAsync(0);
  h.session.messages.retry(id);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.sign).toHaveBeenCalledTimes(1);
  const operation = h.session.outbox?.snapshot()[0];
  assert.exists(operation);
  expect(operation.delivery).toBe("unknown");
  expect(operation.error).toMatch(/^Retry blocked:/);
  expect(
    deliveryFeedback(
      {
        delivery: operation.delivery,
        deliveryError: operation.error,
        createdAt: operation.event.created_at,
      },
      Date.now() + 10001,
    ),
  ).toMatch(/not yet confirmed.*Retry blocked/);
});
it("successful fresh roster must not be blocked by optional channel metadata failure", async () => {
  const h = setup();
  await established(h);
  h.failMetadata();
  h.session.channels.refreshList?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.session.channels.list().channels[0]?.members).toContain(
    h.agent.pubkey,
  );
  expect(() =>
    h.session.messages.send("c", "@Agent", [h.agent.pubkey]),
  ).not.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish).toHaveBeenCalledTimes(1);
});

it("control: verified current membership publishes exact keys; observed removal blocks before enqueue", async () => {
  const h = setup();
  await established(h);
  h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.publish.mock.calls[0]?.[0].tags).toContainEqual([
    "p",
    h.agent.pubkey,
  ]);
  h.removeAgent();
  h.session.channels.refreshList?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(() =>
    h.session.messages.send("c", "@Agent", [h.agent.pubkey]),
  ).toThrow(/no longer/);
  expect(h.publish).toHaveBeenCalledTimes(1);
});
it("control: restored signed unknown retry rejects a removed member without re-signing/replacing identity", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const event = signed(viewer, {
    kind: 9,
    content: "@Agent",
    tags: [
      ["h", "c"],
      ["p", agent.pubkey],
    ],
  });
  const h = setup({
    viewer,
    relay,
    agent,
    records: [{ event, signed: event, delivery: "unknown" }],
  });
  h.removeAgent();
  await established(h);
  h.session.messages.retry(event.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]?.signed).toEqual(event);
});

it.each([
  "empty",
  "wrong-author",
  "wrong-channel",
  "duplicate-coordinate",
  "failed-read",
])("preflight %s cannot authorize a cached recipient", async (failure) => {
  const h = setup();
  await established(h);
  h.holdPreflight();
  h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  const read = h.preflights.shift();
  assert.exists(read);
  if (failure === "failed-read") read.reject(new Error("disconnected"));
  else
    read.resolve(
      failure === "empty"
        ? []
        : [
            failure === "duplicate-coordinate"
              ? signed(h.relay, {
                  kind: 39002,
                  content: "",
                  tags: [
                    ["d", "c"],
                    ["d", "other"],
                    ["p", h.viewer.pubkey],
                    ["p", h.agent.pubkey],
                  ],
                })
              : roster(
                  failure === "wrong-author" ? h.agent : h.relay,
                  failure === "wrong-channel" ? "other" : "c",
                  [h.viewer.pubkey, h.agent.pubkey],
                ),
          ],
    );
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
});
it.each(["disconnect", "clear", "newer-removal"])(
  "fences %s during a held publication preflight",
  async (change) => {
    const h = setup();
    await established(h);
    h.holdPreflight();
    h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
    await vi.advanceTimersByTimeAsync(0);
    const read = h.preflights.shift();
    assert.exists(read);
    if (change === "disconnect") {
      h.socket().close();
      await vi.advanceTimersByTimeAsync(500);
      await h.socket(1).auth();
    } else if (change === "clear") await h.clearCache();
    else {
      const route = h
        .socket()
        .requests()
        .find((request) => (request[2] as Record<string, unknown>)["#h"]);
      assert.exists(route);
      await h
        .socket()
        .receive([
          "EVENT",
          route[1],
          roster(h.relay, "c", [h.viewer.pubkey], 1700000001),
        ]);
    }
    read.resolve([
      roster(h.relay, "c", [h.viewer.pubkey, h.agent.pubkey], 1700000000),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
  },
);
it("publication preflight does not join an older identical in-flight roster read", async () => {
  const h = setup();
  await established(h);
  h.holdPreflight();
  const prior = h.session.read([
    { kinds: [39002], authors: [h.relay.pubkey], "#d": ["c"], limit: 1 },
  ]);
  h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.preflights).toHaveLength(2);
  const old = h.preflights.shift(),
    current = h.preflights.shift();
  assert.exists(old);
  assert.exists(current);
  old.resolve([
    roster(h.relay, "c", [h.viewer.pubkey, h.agent.pubkey], 1700000000),
  ]);
  await prior;
  current.resolve([roster(h.relay, "c", [h.viewer.pubkey], 1700000001)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish).not.toHaveBeenCalled();
});

it("signed retry re-reads membership rather than reusing the first attempt's preflight", async () => {
  const h = setup();
  await established(h);
  h.loseAck();
  const id = h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  const event = h.publish.mock.calls[0]?.[0];
  assert.exists(event);
  h.removeAgent(); // No discovery refresh or live notification: cached roster still includes the agent.
  h.session.messages.retry(id);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    h.query.mock.calls.filter(
      ([filters]) =>
        filters[0]?.authors?.includes(h.relay.pubkey) &&
        filters[0]?.kinds?.includes(39002),
    ),
  ).toHaveLength(2);
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.session.outbox?.snapshot()[0]).toMatchObject({
    delivery: "unknown",
    signed: event,
    error: expect.stringMatching(/^Retry blocked:/),
  });
});
it("a failed live route still permits a fresh positive finite roster preflight", async () => {
  const h = setup();
  await established(h);
  for (const request of h.socket().requests())
    await h.socket().receive(["CLOSED", request[1], "failed route"]);
  h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish).toHaveBeenCalledTimes(1);
});

// Independent review regression: timeout is owned by the outbox deadline, not
// by whether the asynchronous preflight has managed to reject yet.
it("first preflight deadline is unsent and never starts confirmation reads", async () => {
  const h = setup();
  await established(h);
  h.holdPreflight();
  const id = h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.preflights).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10001);
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
  expect(
    h.query.mock.calls.some(([filters]) =>
      filters.some((f) => f.ids?.includes(id)),
    ),
  ).toBe(false);
  h.preflights[0]?.resolve([
    roster(h.relay, "c", [h.viewer.pubkey, h.agent.pubkey]),
  ]);
  await vi.advanceTimersByTimeAsync(20000);
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
  expect(
    h.query.mock.calls.some(([filters]) =>
      filters.some((f) => f.ids?.includes(id)),
    ),
  ).toBe(false);
});
it.each(["unknown", "accepted"] as const)(
  "preflight deadline preserves earlier %s delivery and exact retry identity",
  async (prior) => {
    const h = setup();
    await established(h);
    if (prior === "unknown") h.loseAck();
    const id = h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.outbox?.snapshot()[0]?.delivery).toBe(prior);
    const event = h.publish.mock.calls[0]?.[0];
    h.holdPreflight();
    h.session.messages.retry(id);
    await vi.advanceTimersByTimeAsync(10001);
    expect(h.session.outbox?.snapshot()[0]).toMatchObject({
      delivery: prior,
      signed: event,
      error: expect.stringMatching(/^Retry failed:/),
    });
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.sign).toHaveBeenCalledTimes(1);
  },
);

it.each(["reconnect", "clear", "removal"] as const)(
  "final dispatch check fences %s after preparation resolves",
  async (change) => {
    const h = setup();
    await established(h);
    h.afterPreparation(async () => {
      if (change === "reconnect") {
        h.socket().close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        await h.socket(1).auth();
        expect(h.session.live.snapshot().status).toBe("connected");
      } else if (change === "clear") await h.clearCache();
      else {
        const route = h
          .socket()
          .requests()
          .find((r) => (r[2] as Record<string, unknown>)["#h"]);
        assert.exists(route);
        await h
          .socket()
          .receive([
            "EVENT",
            route[1],
            roster(h.relay, "c", [h.viewer.pubkey], 1700000001),
          ]);
      }
    });
    h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
  },
);

it("a deadline in the preparation continuation cannot publish or leave sending stuck", async () => {
  const h = setup();
  await established(h);
  h.afterPreparation(
    () => new Promise((resolve) => setTimeout(resolve, 10001)),
  );
  h.session.messages.send("c", "@Agent", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(10002);
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
});
