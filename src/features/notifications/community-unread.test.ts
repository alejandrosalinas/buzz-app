import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Communities } from "../communities/service";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { UnreadSnapshot } from "../relay/unread";
import {
  BACKGROUND_JITTER_MS,
  BACKGROUND_UNREAD_LIMIT,
  createCommunityUnreads,
  observeCommunityUnread,
  type CommunityUnread,
  type UnreadGates,
} from "./community-unread";
import { soloConversation } from "../../bundled/focus/status";

const viewer = "a".repeat(64);
const one = "https://one.example";
const two = "https://two.example";
const cleanups: (() => void)[] = [];
// Background admission waits a random 0–3 s; tests start each at once.
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function signal() {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
    get size() {
      return listeners.size;
    },
  };
}

/** A community session reduced to what the sidebar's unread rows read. */
function fakeSession() {
  let preferences: { status: string; data?: { muted: string[] } } = {
    status: "ready",
    data: { muted: [] },
  };
  let channels: {
    id: string;
    members: string[];
    huddle?: true;
    cached?: true;
    channelType?: string;
  }[] = [];
  let listStatus = "loading";
  const unread = new Map<string, Partial<UnreadSnapshot>>();
  let liveStatus = "connected";
  const ensure = vi.fn(async () => {});
  const prefs = signal(),
    list = signal(),
    rows = signal(),
    live = signal();
  const session = {
    live: {
      snapshot: () => ({ status: liveStatus, routes: [] }),
      subscribe: live.subscribe,
    },
    sidebarPreferences: {
      snapshot: () => preferences,
      subscribe: prefs.subscribe,
    },
    channels: {
      list: () => ({ status: listStatus, channels }),
      subscribeList: list.subscribe,
    },
    unread: {
      snapshot: ({ channelId }: { channelId: string }) => ({
        manual: "none",
        observedCount: 0,
        attentionCount: 0,
        coverage: "observed",
        freshness: "observed",
        ...unread.get(channelId),
      }),
      // One listener per channel, as the real capability holds them.
      subscribe: (_target: unknown, listener: () => void) =>
        rows.subscribe(() => listener()),
      ensure,
    },
  } as unknown as RelaySession;
  return {
    session,
    ensure,
    rows,
    live,
    connection(status: string) {
      liveStatus = status;
      live.emit();
    },
    /** Lists fresh joined channels while the roster is still loading. */
    load(...ids: string[]) {
      channels = ids.map((id) => ({ id, members: [viewer] }));
      list.emit();
    },
    /** Lists channels repair cannot read while the roster is still loading. */
    loadUnreadable(channel: { id: string; members: string[]; cached?: true }) {
      channels = [channel];
      list.emit();
    },
    /** Adds a joined channel of `type` to the roster. */
    channelType(id: string, type: string) {
      channels = [...channels, { id, members: [viewer], channelType: type }];
      list.emit();
    },
    join(...ids: string[]) {
      channels = ids.map((id) => ({ id, members: [viewer] }));
      listStatus = "ready";
      list.emit();
    },
    set(id: string, snapshot: Partial<UnreadSnapshot>) {
      unread.set(id, snapshot);
      rows.emit();
    },
    preferences(next: typeof preferences) {
      preferences = next;
      prefs.emit();
    },
  };
}

function observe(
  fake: ReturnType<typeof fakeSession>,
  allows?: (id: string) => boolean,
) {
  const publish = vi.fn<(state: CommunityUnread | undefined) => void>();
  const gates = allows && {
    allows: (target: { channelId?: string }) => allows(target.channelId ?? ""),
    subscribe: () => () => {},
  };
  cleanups.push(
    observeCommunityUnread(
      fake.session,
      viewer,
      one,
      publish,
      gates as Parameters<typeof observeCommunityUnread>[4],
    ),
  );
  return () => publish.mock.lastCall?.[0];
}

it("counts items that need you and reports ordinary unread as a dot", () => {
  const fake = fakeSession();
  const state = observe(fake);
  fake.join("a", "b");
  expect(state()).toEqual({ unread: false, attention: 0 });
  fake.set("a", { observedCount: 3 });
  expect(state()).toEqual({ unread: true, attention: 0 });
  fake.set("b", { observedCount: 2, attentionCount: 2 });
  expect(state()).toEqual({ unread: true, attention: 2 });
});

it("follows the sidebar row a visit quieted, and keeps manual unread", () => {
  const fake = fakeSession();
  const state = observe(fake);
  fake.join("a");
  fake.set("a", {
    observedCount: 4,
    attentionCount: 1,
    row: { observedCount: 0, attentionCount: 0, threadCount: 0 },
  });
  expect(state()).toEqual({ unread: false, attention: 0 });
  fake.set("a", { observedCount: 0, manual: "local-only" });
  expect(state()).toEqual({ unread: true, attention: 0 });
});

it("counts muted channels as their sidebar rows do, and leaves out channels notification settings exclude", () => {
  const fake = fakeSession();
  const state = observe(fake, (id) => id !== "quiet");
  fake.join("muted", "quiet", "open");
  fake.channelType("dm", "dm");
  fake.preferences({ status: "ready", data: { muted: ["muted", "dm"] } });
  fake.set("muted", { observedCount: 5, attentionCount: 0 });
  fake.set("quiet", { observedCount: 5, attentionCount: 5 });
  expect(state()).toEqual({ unread: false, attention: 0 });
  // A muted channel's mention still shows, as in its sidebar row.
  fake.set("muted", { observedCount: 5, attentionCount: 1 });
  expect(state()).toEqual({ unread: true, attention: 1 });
  fake.set("muted", { observedCount: 0, attentionCount: 0 });
  expect(state()).toEqual({ unread: false, attention: 0 });
  // A muted DM still shows.
  fake.set("dm", { observedCount: 1, attentionCount: 0 });
  expect(state()).toEqual({ unread: true, attention: 0 });
  fake.set("dm", { observedCount: 0 });
  fake.set("open", { observedCount: 1 });
  expect(state()).toEqual({ unread: true, attention: 0 });
});

it("is unknown, never all read, until confirmed mutes are known", () => {
  const fake = fakeSession();
  fake.preferences({ status: "loading" });
  const state = observe(fake);
  fake.join("a");
  fake.set("a", { observedCount: 1 });
  expect(state()).toBeUndefined();
  fake.preferences({ status: "unsupported" });
  expect(state()).toEqual({ unread: true, attention: 0 });
});

it("stops observing every channel when disposed", () => {
  const fake = fakeSession();
  const publish = vi.fn();
  const stop = observeCommunityUnread(fake.session, viewer, one, publish);
  fake.join("a", "b");
  expect(fake.rows.size).toBe(2);
  stop();
  expect(fake.rows.size).toBe(0);
  publish.mockClear();
  fake.set("a", { observedCount: 1 });
  fake.join("a", "b", "c");
  expect(publish).not.toHaveBeenCalled();
});

it("keys every joined community's unread, opening its session and repair once", async () => {
  const [first, second] = [fakeSession(), fakeSession()];
  const sessions = new Map<string, { relay: RelayData }>(
    (
      [
        [one, first],
        [two, second],
      ] as const
    ).map(([id, fake]) => {
      const changes = signal();
      const relay = {
        snapshot: () => ({ status: "ready", viewer, session: fake.session }),
        subscribe: changes.subscribe,
      } as unknown as RelayData;
      return [id, { relay }] as const;
    }),
  );
  let open = new Set<string>([one]);
  const client = signal();
  let snapshot = {
    viewer,
    selected: one,
    memberships: [{ id: one }, { id: two }],
  };
  const opened = vi.fn((id: string) =>
    open.has(id) ? sessions.get(id)?.relay : undefined,
  );
  const communities = {
    snapshot: () => snapshot,
    subscribe: client.subscribe,
    open: opened,
    relay: { snapshot: () => ({ status: "ready" }), subscribe: () => () => {} },
  } as unknown as Communities;
  const unreads = createCommunityUnreads(communities);
  cleanups.push(unreads.dispose);
  // Badges wait for the selected community's first repair.
  expect(opened).not.toHaveBeenCalledWith(two, true);
  // Repair reads the roster's channels, so it waits for one it can read.
  expect(first.ensure).not.toHaveBeenCalled();
  first.loadUnreadable({ id: "a", members: [viewer], cached: true });
  expect(first.ensure).not.toHaveBeenCalled();
  first.loadUnreadable({ id: "a", members: ["someone-else"] });
  expect(first.ensure).not.toHaveBeenCalled();
  first.load("a");
  expect(first.ensure).toHaveBeenCalledTimes(1);
  expect(opened).not.toHaveBeenCalledWith(two, true);
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(two, true));
  first.join("a");
  first.set("a", { observedCount: 1, attentionCount: 1 });
  expect([...unreads.snapshot()]).toEqual([
    [one, { unread: true, attention: 1 }],
  ]);
  expect(opened).toHaveBeenCalledWith(two, true);
  expect(first.ensure).toHaveBeenCalledTimes(1);
  // A community whose session opens later is picked up when memberships change.
  open = new Set([one, two]);
  snapshot = { ...snapshot, selected: two };
  client.emit();
  second.join("b");
  second.set("b", { observedCount: 2 });
  expect(unreads.snapshot().get(two)).toEqual({ unread: true, attention: 0 });
  // Leaving drops it.
  snapshot = { ...snapshot, selected: one, memberships: [{ id: one }] };
  client.emit();
  expect([...unreads.snapshot().keys()]).toEqual([one]);
  expect(first.ensure).toHaveBeenCalledTimes(1);
  expect(second.rows.size).toBe(0);
});

it("Focus judges each community's conversations in that community, whatever is selected", async () => {
  const [first, second] = [fakeSession(), fakeSession()];
  const fakes = new Map([
    [one, first],
    [two, second],
  ]);
  const relays = new Map(
    [...fakes].map(([id, fake]) => [
      id,
      {
        snapshot: () => ({ status: "ready", viewer, session: fake.session }),
        subscribe: () => () => {},
      } as unknown as RelayData,
    ]),
  );
  const client = signal();
  let snapshot: {
    viewer: string;
    selected: string | null;
    memberships: { id: string }[];
  } = {
    viewer,
    selected: one,
    memberships: [{ id: one }, { id: two }],
  };
  const communities = {
    snapshot: () => snapshot,
    subscribe: client.subscribe,
    open: (id: string) => relays.get(id),
    relay: { snapshot: () => ({ status: "ready" }), subscribe: () => () => {} },
  } as unknown as Communities;
  // Focus's gate, looking each target up as the community reader does.
  const gates: UnreadGates = {
    allows: (target) =>
      soloConversation(
        target.kind === "conversation"
          ? relays.get(target.scope.communityOrigin)?.snapshot()
          : undefined,
        target,
      ),
    subscribe: () => () => {},
  };
  const unreads = createCommunityUnreads(communities, gates);
  cleanups.push(unreads.dispose);
  // The same channel id is a stream in one and a Solo chat in two.
  first.join();
  first.channelType("x", "stream");
  first.set("x", { observedCount: 1, attentionCount: 1 });
  second.join();
  second.channelType("x", "solo");
  second.set("x", { observedCount: 1, attentionCount: 1 });
  await vi.waitFor(() =>
    expect(unreads.snapshot().get(two)).toEqual({ unread: true, attention: 1 }),
  );
  // One counts no channel, so its unread is not known: never a badge.
  expect(unreads.snapshot().get(one)).toBeUndefined();
  for (const selected of [two, null]) {
    snapshot = { ...snapshot, selected };
    client.emit();
    expect(unreads.snapshot().get(one)).toBeUndefined();
    expect(unreads.snapshot().get(two)).toEqual({ unread: true, attention: 1 });
  }
  // Its own roster change is judged again in its own community.
  second.join();
  second.channelType("x", "stream");
  expect(unreads.snapshot().get(two)).toBeUndefined();
});

function observeKnown(fake: ReturnType<typeof fakeSession>) {
  const publish = vi.fn<(state: CommunityUnread | undefined) => void>();
  cleanups.push(
    observeCommunityUnread(fake.session, viewer, one, publish, undefined, true),
  );
  return () => publish.mock.lastCall?.[0];
}

it("hides a known community's badge while its connection is down, and restores it after reconnecting", () => {
  const fake = fakeSession();
  const state = observeKnown(fake);
  fake.join("a", "b");
  fake.set("a", { observedCount: 1, attentionCount: 1 });
  expect(state()).toEqual({ unread: true, attention: 1 });
  // A dropped connection marks the session's unread stale.
  fake.set("a", { observedCount: 1, attentionCount: 1, freshness: "stale" });
  expect(state()).toBeUndefined();
  // The reconnect's read observes it again.
  fake.set("a", { observedCount: 1, attentionCount: 1 });
  expect(state()).toEqual({ unread: true, attention: 1 });
});

it("is unknown when no channel has observed evidence, and counts the ones that do", () => {
  const fake = fakeSession();
  const state = observeKnown(fake);
  const unknown = {
    coverage: "unknown",
    observedCount: null,
    attentionCount: null,
  } as const;
  fake.join("a", "b");
  fake.set("a", unknown);
  fake.set("b", unknown);
  expect(state()).toBeUndefined();
  fake.set("b", { observedCount: 2, attentionCount: 1 });
  expect(state()).toEqual({ unread: true, attention: 1 });
  fake.set("b", { observedCount: 0, attentionCount: 0 });
  expect(state()).toEqual({ unread: false, attention: 0 });
});

it("hides the badge while the live connection is down, even when reads still succeed", () => {
  const fake = fakeSession();
  // Startup: HTTP reads observed unread, but the socket never connected.
  fake.connection("retrying");
  const state = observeKnown(fake);
  fake.join("a");
  fake.set("a", { observedCount: 1, attentionCount: 1 });
  expect(state()).toBeUndefined();
  fake.connection("connected");
  expect(state()).toEqual({ unread: true, attention: 1 });
  // A drop, then a successful finite refresh while the socket is still down.
  fake.connection("retrying");
  expect(state()).toBeUndefined();
  fake.set("a", { observedCount: 2, attentionCount: 2 });
  expect(state()).toBeUndefined();
  fake.connection("connected");
  expect(state()).toEqual({ unread: true, attention: 2 });
});

it("stops listening to the live connection when disposed", () => {
  const fake = fakeSession();
  const stop = observeCommunityUnread(
    fake.session,
    viewer,
    one,
    () => {},
    undefined,
    true,
  );
  expect(fake.live.size).toBe(1);
  stop();
  expect(fake.live.size).toBe(0);
});

it("opens at most the background limit, plus communities selected this launch", () => {
  const ids = Array.from(
    { length: BACKGROUND_UNREAD_LIMIT + 3 },
    (_, index) => `https://c${index}.example`,
  );
  const client = signal();
  let snapshot = {
    viewer,
    selected: ids[0] as string,
    memberships: ids.map((id) => ({ id })),
  };
  const opened = vi.fn((_id: string) => undefined);
  const communities = {
    snapshot: () => snapshot,
    subscribe: client.subscribe,
    open: opened,
    // The selected community's session is unavailable, so badges do not wait.
    relay: { snapshot: () => ({ status: "error" }), subscribe: () => () => {} },
  } as unknown as Communities;
  const unreads = createCommunityUnreads(communities);
  cleanups.push(unreads.dispose);
  const asked = () => new Set(opened.mock.calls.map(([id]) => id));
  vi.runOnlyPendingTimers();
  expect(asked()).toEqual(new Set(ids.slice(0, BACKGROUND_UNREAD_LIMIT)));
  // Selecting one past the limit keeps observing it after it is left.
  const late = ids.at(-1) as string;
  snapshot = { ...snapshot, selected: late };
  client.emit();
  snapshot = { ...snapshot, selected: ids[0] as string };
  opened.mockClear();
  client.emit();
  expect(asked()).toEqual(
    new Set([...ids.slice(0, BACKGROUND_UNREAD_LIMIT), late]),
  );
});

it("badges wait for a restored selection's first repair, not the loading snapshot", async () => {
  const [first, second] = [fakeSession(), fakeSession()];
  let release = () => {};
  first.ensure.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const relays = new Map<string, RelayData>(
    (
      [
        [one, first],
        [two, second],
      ] as const
    ).map(([id, fake]) => [
      id,
      {
        snapshot: () => ({ status: "ready", viewer, session: fake.session }),
        subscribe: () => () => {},
      } as unknown as RelayData,
    ]),
  );
  const client = signal();
  // Before hydration nothing is selected yet; that is not Personal space.
  let snapshot: {
    status: string;
    viewer?: string;
    selected: string | null;
    memberships: { id: string }[];
  } = { status: "loading", selected: null, memberships: [] };
  const opened = vi.fn((id: string) => relays.get(id));
  const communities = {
    snapshot: () => snapshot,
    subscribe: client.subscribe,
    open: opened,
    relay: { snapshot: () => ({ status: "ready" }), subscribe: () => () => {} },
  } as unknown as Communities;
  const unreads = createCommunityUnreads(communities);
  cleanups.push(unreads.dispose);
  snapshot = {
    status: "ready",
    viewer,
    selected: one,
    memberships: [{ id: one }, { id: two }],
  };
  client.emit();
  first.load("a");
  expect(first.ensure).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(opened).not.toHaveBeenCalledWith(two, true);
  release();
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(two, true));
});

it("badges open at once when nothing is selected after loading", () => {
  const fake = fakeSession();
  const relay = {
    snapshot: () => ({ status: "ready", viewer, session: fake.session }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const opened = vi.fn((_id: string) => relay);
  const communities = {
    snapshot: () => ({
      status: "ready",
      viewer,
      selected: null,
      memberships: [{ id: two }],
    }),
    subscribe: () => () => {},
    open: opened,
    relay: { snapshot: () => ({ status: "ready" }), subscribe: () => () => {} },
  } as unknown as Communities;
  const unreads = createCommunityUnreads(communities);
  cleanups.push(unreads.dispose);
  vi.runOnlyPendingTimers();
  expect(opened).toHaveBeenCalledWith(two, true);
});

it("opens background communities after a bounded random delay, never the selected one", () => {
  vi.mocked(Math.random).mockReturnValue(0.5);
  const three = "https://three.example";
  const client = signal();
  let snapshot: {
    viewer: string;
    selected: string | null;
    memberships: { id: string }[];
  } = {
    viewer,
    selected: one,
    memberships: [{ id: one }, { id: two }, { id: three }],
  };
  const opened = vi.fn((_id: string) => undefined);
  const communities = {
    snapshot: () => snapshot,
    subscribe: client.subscribe,
    open: opened,
    relay: { snapshot: () => ({ status: "error" }), subscribe: () => () => {} },
  } as unknown as Communities;
  const unreads = createCommunityUnreads(communities);
  cleanups.push(unreads.dispose);
  const asked = () => opened.mock.calls.map(([id]) => id);
  // The selected community opens at once; the rest wait 1.5 s.
  expect(asked()).toEqual([one]);
  vi.advanceTimersByTime(1000);
  // Ordinary updates don't restart the deadline.
  client.emit();
  expect(asked()).not.toContain(two);
  // Selecting a pending community opens it at once.
  snapshot = { ...snapshot, selected: two };
  client.emit();
  expect(asked()).toContain(two);
  expect(asked()).not.toContain(three);
  vi.advanceTimersByTime(499);
  expect(asked()).not.toContain(three);
  vi.advanceTimersByTime(1);
  expect(asked()).toContain(three);
});

it("cancels a pending admission on leave, viewer change and dispose", () => {
  vi.mocked(Math.random).mockReturnValue(0.5);
  const client = signal();
  let snapshot = {
    viewer,
    selected: one as string | null,
    memberships: [{ id: one }, { id: two }],
  };
  const opened = vi.fn((_id: string) => undefined);
  const communities = {
    snapshot: () => snapshot,
    subscribe: client.subscribe,
    open: opened,
    relay: { snapshot: () => ({ status: "error" }), subscribe: () => () => {} },
  } as unknown as Communities;
  const unreads = createCommunityUnreads(communities);
  const asked = () => opened.mock.calls.map(([id]) => id);
  // Leaving before the delay ends never opens it, and rejoining waits again.
  snapshot = { ...snapshot, memberships: [{ id: one }] };
  client.emit();
  vi.advanceTimersByTime(BACKGROUND_JITTER_MS);
  expect(asked()).not.toContain(two);
  snapshot = { ...snapshot, memberships: [{ id: one }, { id: two }] };
  client.emit();
  vi.advanceTimersByTime(1000);
  // Another account with the same community ids draws a fresh delay.
  snapshot = { ...snapshot, viewer: "b".repeat(64) };
  client.emit();
  vi.advanceTimersByTime(1000);
  expect(asked()).not.toContain(two);
  vi.advanceTimersByTime(500);
  expect(asked()).toContain(two);
  // And one admitted for the old account isn't carried over.
  opened.mockClear();
  snapshot = { ...snapshot, viewer };
  client.emit();
  expect(asked()).not.toContain(two);
  // Disposing cancels what is still pending.
  unreads.dispose();
  vi.advanceTimersByTime(BACKGROUND_JITTER_MS);
  expect(asked()).not.toContain(two);
});
