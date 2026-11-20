import { afterEach, expect, it, vi } from "vitest";
import { createLocalAgentActivity } from "../agents/local-activity";

afterEach(() => vi.useRealTimers());
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import { transportPartition } from "./partition";
import { keypair, roster, scriptedTransport, signed } from "./testing";

it.each(["CLOSED", "private metadata", "concurrent readPage"])(
  "restores retained local activity after verified preview recovery from %s",
  async (loss) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const viewer = keypair();
    const relay = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const local = createLocalAgentActivity();
    const work = vi.fn(local.reader.work);
    const update = vi.fn();
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...wire.transport,
        agentActivity: true,
        subscribe(callbacks) {
          live = callbacks;
          return { update, retry() {}, dispose() {} };
        },
      },
      { localAgents: { ...local.reader, work } },
    );
    const channelId = "preview";
    const metadata = (visibility: "public" | "private", created_at: number) =>
      signed(relay, {
        kind: 39000,
        content: "",
        created_at,
        tags: [["d", channelId], [visibility]],
      });
    const publicPreview = metadata("public", 10);
    const failedId = "1".repeat(64);
    const declinedId = "2".repeat(64);
    const begin = (messageId: string) =>
      local.begin({
        scope: transportPartition(wire.transport),
        agent: "a".repeat(64),
        channelId,
        threadRootId: messageId,
        messageId,
      });
    const activity = owner.session.agentActivity;
    const snapshot = () => activity.snapshot(channelId);
    const onActivity = vi.fn();
    const onOtherActivity = vi.fn();
    try {
      const resolve = owner.session.channels.resolve?.([channelId]);
      await vi.advanceTimersByTimeAsync(0);
      wire.next().respond([publicPreview]);
      await resolve;
      expect(owner.session.channels.get?.(channelId)?.readOnly).toBe(true);
      activity.activate();
      const observer = {
        id: "observer",
        status: "live",
        replay: "unknown",
      } as const;
      live.state({ status: "connected", routes: [observer] });
      begin(failedId).finish({ ok: false, error: "Agent failed" });
      begin(declinedId).remove("workflow");
      expect(snapshot().local).toMatchObject([
        { messageId: failedId, state: "error" },
      ]);
      expect(snapshot().declined).toMatchObject([{ messageId: declinedId }]);
      const interests = update.mock.lastCall;
      update.mockClear();

      if (loss === "CLOSED") {
        live.state({
          status: "connected",
          routes: [
            observer,
            {
              id: `channel:${channelId}`,
              channelId,
              status: "error",
              replay: "unknown",
              error: "restricted: channel access revoked",
            },
          ],
        });
      } else {
        live.receive([metadata("private", 20)]);
      }
      expect(owner.session.channels.get?.(channelId)).toBeUndefined();
      expect(snapshot().local ?? []).toEqual([]);
      expect(snapshot().declined ?? []).toEqual([]);
      activity.subscribe(onActivity, channelId);
      activity.subscribe(onOtherActivity, "unrelated");

      const recovery =
        loss !== "CLOSED"
          ? owner.session.channels.resolve?.([channelId])
          : undefined;
      void recovery?.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const recheck = wire.pending.find(({ filters }) =>
        filters.some((filter) => filter["#d"]?.includes(channelId)),
      );
      expect(recheck).toBeDefined();
      const publicAgain =
        loss === "CLOSED" ? publicPreview : metadata("public", 30);
      if (loss === "concurrent readPage") {
        const page = owner.session.readPage([
          {
            kinds: [39000],
            authors: [relay.pubkey],
            "#d": [channelId],
            limit: 1,
          },
        ]);
        void page.catch(() => {});
        await vi.advanceTimersByTimeAsync(0);
        const read = wire.pending.find(
          ({ filters }) =>
            filters.length === 1 && filters[0]?.["#d"]?.includes(channelId),
        );
        expect(read).toBeDefined();
        read?.respond([publicAgain]);
        await page;
        expect(owner.session.channels.get?.(channelId)?.readOnly).toBe(true);
        expect(snapshot().local).toMatchObject([
          { messageId: failedId, state: "error" },
        ]);
        expect(snapshot().declined).toMatchObject([{ messageId: declinedId }]);
      }
      recheck?.respond([publicAgain]);
      await recovery;
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.session.channels.get?.(channelId)?.readOnly).toBe(true);
      expect(update.mock.calls.length).toBeGreaterThan(0);
      for (const call of update.mock.calls) expect(call).toEqual(interests);
      expect(snapshot().local).toMatchObject([
        { messageId: failedId, state: "error" },
      ]);
      expect(snapshot().declined).toMatchObject([{ messageId: declinedId }]);
      expect(onActivity).toHaveBeenCalledTimes(1);
      expect(onOtherActivity).not.toHaveBeenCalled();

      work.mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      expect(work).not.toHaveBeenCalled();
      expect(onActivity).toHaveBeenCalledTimes(1);
    } finally {
      owner.dispose();
    }
  },
);

it("live typing is owner-recognized and self-suppressed, bypasses history/read views, and loses access before a mixed batch", async () => {
  const viewer = keypair(),
    agent = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  let generation = 0;
  const owner = createRelaySession({
    ...wire.transport,
    agentActivity: true,
    subscribe(callbacks) {
      live = callbacks;
      return {
        update() {},
        retry() {},
        dispose() {},
        observe(next) {
          generation = next ?? 0;
        },
      };
    },
  });
  const state = () =>
    live.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
  const now = Math.floor(Date.now() / 1000);
  const make = (key = agent) =>
    signed(key, {
      kind: 20002,
      content: "",
      created_at: now,
      tags: [
        ["h", "a"],
        ["e", "a".repeat(64), "", "reply"],
      ],
    });
  const recognize = (key = agent) =>
    live.observer?.(
      {
        id: key.pubkey,
        agent: key.pubkey,
        createdAt: now,
        plaintext: JSON.stringify({
          kind: "turn_liveness",
          channelId: "a",
          turnId: key.pubkey,
          timestamp: new Date().toISOString(),
        }),
      },
      generation,
    );
  try {
    live.receive([roster(relay, "a", [viewer.pubkey, agent.pubkey])]);
    const release = owner.session.agentActivity.activate();
    state();
    recognize();
    recognize(viewer);
    const view = owner.session.observe([
      { kinds: [20002], "#h": ["a"], limit: 10 },
    ]);
    live.receive([make(), make(viewer)]);
    expect(
      owner.session.agentActivity.snapshot().typing.map((entry) => entry.agent),
    ).toEqual([agent.pubkey]);
    expect(owner.session.typing.snapshot()).toMatchObject([
      { pubkey: agent.pubkey },
    ]);
    expect(view.snapshot().events).toEqual([]);
    expect(JSON.stringify(owner.session.channels.window("a"))).not.toContain(
      make().id,
    );
    const read = owner.session.read([
      { kinds: [20002], "#h": ["a"], limit: 10 },
    ]);
    wire.next().respond([make()]);
    expect(await read).toEqual([]);
    release();
    const activate = owner.session.agentActivity.activate();
    state();
    recognize();
    // Finite reads must not seed either history or typing after a reset.
    const finite = owner.session.read([
      { kinds: [20002], "#h": ["a"], limit: 10 },
    ]);
    wire.next().respond([make()]);
    expect(await finite).toEqual([]);
    expect(owner.session.agentActivity.snapshot().typing).toEqual([]);
    live.receive([make(), roster(relay, "a", [agent.pubkey], now + 1)]);
    expect(owner.session.agentActivity.snapshot().typing).toEqual([]);
    expect(owner.session.agentActivity.snapshot().records).toEqual([]);
    activate();
    view.dispose();
  } finally {
    owner.dispose();
  }
});

// Both projections consume the same live delivery, but public typing listeners
// may synchronously retire that delivery before the owner-only consumer runs.
it.each(["cache", "dispose", "access", "reconnect"] as const)(
  "fences owner-only activity after a shared typing subscriber triggers %s",
  async (transition) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const viewer = keypair(),
      relay = keypair(),
      agent = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    let generation = 0;
    const owner = createRelaySession({
      ...wire.transport,
      agentActivity: true,
      subscribe(callbacks) {
        live = callbacks;
        return {
          update() {},
          retry() {},
          dispose() {},
          observe(next) {
            generation = next ?? 0;
          },
        };
      },
    });
    const connected = () =>
      live.state({
        status: "connected",
        routes: [{ id: "observer", status: "live", replay: "unknown" }],
      });
    let clearing: Promise<void> | undefined;
    try {
      live.receive([
        roster(relay, "a", [viewer.pubkey]),
        roster(relay, "b", [viewer.pubkey]),
      ]);
      owner.session.agentActivity.activate();
      connected();
      live.observer?.(
        {
          id: agent.pubkey,
          agent: agent.pubkey,
          createdAt: 1_800_000_000,
          plaintext: JSON.stringify({ kind: "telemetry", channelId: "a" }),
        },
        generation,
      );
      expect(owner.session.agentActivity.snapshot().records).toHaveLength(1);
      let transitioned = false;
      const listener = vi.fn(() => {
        if (transitioned || !owner.session.typing.snapshot().length) return;
        transitioned = true;
        if (transition === "cache") clearing = owner.clearCache();
        else if (transition === "dispose") owner.dispose();
        else if (transition === "access")
          live.receive([roster(relay, "b", [], 1_800_000_001)]);
        else {
          live.state({ status: "retrying", routes: [] });
          connected();
        }
      });
      owner.session.typing.subscribe(listener);
      live.receive([
        signed(agent, {
          kind: 20002,
          content: "",
          created_at: 1_800_000_000,
          tags: [["h", "a"]],
        }),
      ]);
      await clearing;
      expect(transitioned).toBe(true);
      expect(owner.session.typing.snapshot()).toEqual([]);
      expect(owner.session.agentActivity.snapshot().typing).toEqual([]);
    } finally {
      owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("late retained trigger admission updates message and thread work synchronously without advancing the freshness clock", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const viewer = keypair(),
    agent = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  let generation = 0;
  const owner = createRelaySession({
    ...wire.transport,
    agentActivity: true,
    subscribe(callbacks) {
      live = callbacks;
      return {
        update() {},
        retry() {},
        dispose() {},
        observe(next) {
          generation = next ?? 0;
        },
      };
    },
  });
  const root = "b".repeat(64);
  const trigger = signed(viewer, {
    kind: 9,
    content: "please work",
    created_at: 1_800_000_000,
    tags: [
      ["h", "a"],
      ["e", root, "", "reply"],
    ],
  });
  try {
    live.receive([roster(relay, "a", [viewer.pubkey, agent.pubkey])]);
    owner.session.agentActivity.activate();
    live.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
    for (const [seq, kind] of [
      [1, "turn_started"],
      [2, "turn_completed"],
    ] as const) {
      live.observer?.(
        {
          id: String(seq).repeat(64),
          agent: agent.pubkey,
          createdAt: 1_800_000_000,
          plaintext: JSON.stringify({
            kind,
            seq,
            channelId: "a",
            turnId: "work",
            timestamp: new Date().toISOString(),
            payload: { triggeringEventIds: [trigger.id] },
          }),
        },
        generation,
      );
    }
    expect(owner.session.agentActivity.snapshot().turns[0]?.requests).toEqual(
      [],
    );
    const listener = vi.fn();
    owner.session.agentActivity.subscribe(listener);
    live.receive([trigger]);
    expect(listener).toHaveBeenCalled();
    expect(owner.session.agentActivity.snapshot().turns[0]).toMatchObject({
      state: "ended",
      requests: [{ messageId: trigger.id, threadRootId: root }],
    });
  } finally {
    owner.dispose();
  }
});
