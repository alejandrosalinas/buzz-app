import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { ProfileQueries } from "./profile-directory";
import { createReadState } from "./read-state";
import { readJournal, type ReadJournal } from "./read-state-storage";
import { keypair, message, signed } from "./testing";
import { createUnread } from "./unread";

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert(value !== undefined, "Missing fixture entry");
  return value;
}

async function setup(count = 3, profiles?: ProfileQueries) {
  const viewer = keypair(),
    peer = keypair();
  const roster: readonly ChannelSummary[] = Array.from(
    { length: count },
    (_, i) => ({
      id: `c${i}`,
      name: `Channel ${i}`,
      members: [viewer.pubkey],
    }),
  );
  const channels: ChannelQueries = {
    list: () => ({ status: "ready" as const, channels: roster }),
    subscribeList() {
      return () => {};
    },
    window() {
      throw new Error("Unread must not inspect windows");
    },
    subscribeWindow() {
      throw new Error("Unread must not subscribe to windows");
    },
    ensureList() {},
    ensure() {},
    loadOlder() {},
  };
  let journal: ReadJournal | undefined;
  const reader = { read: vi.fn(async () => []) };
  const reads = createReadState({
    floor: () => 0,
    viewer: viewer.pubkey,
    reader,
    host: undefined,
    storage: {
      async update(change) {
        journal = readJournal(change(journal), viewer.pubkey);
        return journal;
      },
      close() {},
    },
  });
  await reads.ready;
  const state = vi.spyOn(reads, "state");
  const owner = createUnread({
    reads,
    channels,
    reader,
    viewer: viewer.pubkey,
    ...(profiles && { profiles }),
  });
  owners.push(owner);
  const targets = roster.map(({ id }) => ({
    kind: "channel" as const,
    channelId: id,
  }));
  const rows = roster.map(({ id }) => message(peer, id, "seed", 11));
  owner.accept(rows);
  const listeners = targets.map(() => vi.fn());
  targets.forEach((target, i) => {
    owner.capability.subscribe(target, at(listeners, i));
  });
  const reset = () => state.mockClear();
  reset();
  return {
    owner,
    unread: owner.capability,
    viewer,
    peer,
    rows,
    targets,
    listeners,
    state,
    reads,
    reset,
  };
}

it("does not trust workflow-owner metadata without a configured relay identity", async () => {
  const h = await setup(1);
  const row = message(h.peer, "c0", "workflow-shaped output", 12, [
    ["p", h.viewer.pubkey],
    ["buzz:workflow", "true"],
    ["buzz:workflow-owner", h.viewer.pubkey],
  ]);
  h.owner.accept([row]);
  expect(h.unread.attention("c0", row.id)).toMatchObject({
    category: "mention",
    mentioned: true,
    unread: true,
  });
});

it("republishes activity folded before an owner answer changed", async () => {
  const agent = keypair(),
    controller = keypair();
  let verified: string | undefined;
  let notify = () => {};
  const profiles = {
    snapshot: () => new Map(),
    subscribe(listener: () => void) {
      notify = listener;
      return () => {};
    },
    ensure: async () => {},
    owner: (pubkey: string) => (pubkey === agent.pubkey ? verified : undefined),
  } satisfies ProfileQueries;
  const h = await setup(2, profiles);
  h.owner.accept(
    h.rows.flatMap((row, i) => {
      const reply = message(agent, `c${i}`, "Whole answer", 12, [
        ["e", row.id, "", "reply"],
        ["p", h.viewer.pubkey],
      ]);
      const edit = signed(controller, {
        kind: 40003,
        created_at: 13,
        content: "Spoken",
        tags: [
          ["h", `c${i}`],
          ["e", reply.id],
        ],
      });
      return [reply, edit];
    }),
  );
  const preview = (channelId: string) =>
    h.unread.activity(channelId).items?.[0]?.preview;
  expect(preview("c0")).toBe("Whole answer");
  // One owner resolves before the directory's batch notification.
  verified = controller.pubkey;
  expect(preview("c1")).toBe("Spoken");
  notify();
  expect(preview("c0")).toBe("Spoken");
});

it("keeps folded rows through a profile change that leaves owners alone", async () => {
  const agent = keypair(),
    controller = keypair();
  let notify = () => {};
  const owner = vi.fn((pubkey: string) =>
    pubkey === agent.pubkey ? controller.pubkey : undefined,
  );
  const profiles = {
    snapshot: () => new Map(),
    subscribe(listener: () => void) {
      notify = listener;
      return () => {};
    },
    ensure: async () => {},
    owner,
  } satisfies ProfileQueries;
  const h = await setup(2, profiles);
  h.owner.accept(
    h.rows.flatMap((row, i) => {
      const reply = message(agent, `c${i}`, "Whole answer", 12, [
        ["e", row.id, "", "reply"],
        ["p", h.viewer.pubkey],
      ]);
      const edit = signed(controller, {
        kind: 40003,
        created_at: 13,
        content: "Spoken",
        tags: [
          ["h", `c${i}`],
          ["e", reply.id],
        ],
      });
      return [reply, edit];
    }),
  );
  h.unread.subscribeActivity("c0", () => {});
  h.unread.subscribeActivity("c1", () => {});
  expect(owner).toHaveBeenCalled();
  owner.mockClear();
  // A display-only change reads the one recorded owner; the next projections
  // reuse their folded rows instead of asking again.
  notify();
  await h.reads.markLocalUnread("c0", () => true);
  expect(owner).toHaveBeenCalledTimes(1);
});

it("keeps read-state and freshness invalidation global", async () => {
  const h = await setup();
  const before = h.targets.map(h.unread.snapshot);
  const activity = h.unread.activity("c0");
  const activityChanges = vi.fn();
  h.unread.subscribeActivity("c0", activityChanges);
  expect(activity).toMatchObject({
    coverage: "observed",
    freshness: "observed",
    items: [],
  });
  h.reset();
  const readChanges = vi.fn();
  h.reads.subscribe(readChanges);
  await h.reads.markLocalUnread("c0", () => true);
  expect(readChanges).toHaveBeenCalled();
  expect(h.unread.snapshot(at(h.targets, 0)).manual).toBe("local-only");
  expect(h.unread.snapshot(at(h.targets, 1))).toBe(before[1]);
  expect(h.unread.activity("c0")).toBe(activity);
  expect(activityChanges).not.toHaveBeenCalled();
  h.owner.stale();
  expect(
    h.targets.map((target) => h.unread.snapshot(target).freshness),
  ).toEqual(["stale", "stale", "stale"]);
  expect(h.unread.activity("c0")).toMatchObject({
    freshness: "stale",
    items: [],
  });
  expect(activityChanges).toHaveBeenCalledOnce();
  const beforeFreshnessRecovery = h.listeners.map(
    (listener) => listener.mock.calls.length,
  );
  h.reset();
  h.owner.accept([message(h.peer, "c0", "fresh evidence", 12)]);
  expect(h.listeners.map((listener) => listener.mock.calls.length)).toEqual(
    beforeFreshnessRecovery.map((count) => count + 1),
  );
  expect(activityChanges).toHaveBeenCalledTimes(2);
  expect(
    h.targets.map((target) => h.unread.snapshot(target).freshness),
  ).toEqual(["observed", "observed", "observed"]);
});

it.each([5, 9005])(
  "kind-%s deletion invalidates every target channel before reentrant snapshot reads",
  async (kind) => {
    const h = await setup();
    const dormant = {
      kind: "message" as const,
      channelId: "c1",
      messageId: at(h.rows, 1).id,
    };
    expect(h.unread.snapshot(dormant).observedCount).toBe(1);
    const seen: (number | null)[][] = [];
    h.unread.subscribe(at(h.targets, 0), () =>
      seen.push([
        h.unread.snapshot(at(h.targets, 1)).observedCount,
        h.unread.snapshot(dormant).observedCount,
      ]),
    );
    h.reset();
    h.owner.accept([
      signed(h.peer, {
        kind,
        content: "",
        tags: [
          ["h", "c0"],
          ["e", at(h.rows, 0).id],
          ["e", at(h.rows, 1).id],
        ],
      }),
    ]);
    expect(seen).toEqual([[0, 0]]);
    expect(h.state).toHaveBeenCalledTimes(3); // two subscribed + one lazy reentrant read
    expect(h.listeners[2]).not.toHaveBeenCalled();
  },
);
