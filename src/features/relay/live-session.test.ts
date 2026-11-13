import { ReadError } from "./errors";
import { RECOVERY_NOTICE_DELAY_MS } from "./recovery";
import { networkRecorder } from "../developer/network-diagnostics";
import { assert, describe, expect, it, vi, afterEach } from "vitest";
import { createRelaySession } from "./session";
import type { ChannelStoreOptions } from "./store";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { headRecovering } from "./live-recovery";
import { EMOJI_SET } from "./emoji";
import type { SidebarPreferences } from "./sidebar-preferences";
import { readJournal, type ReadJournal } from "./read-state-storage";
// The real host codec, as read-state.test.ts uses it.
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Node-only host module
} from "../../../browser-host/read-state.mjs";
import {
  bounds,
  flush,
  isNoticeRead,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

it("attributes a reconnect notice to a failed preference read while the socket stays connected", async () => {
  vi.useFakeTimers();
  networkRecorder.clear();
  networkRecorder.setEnabled(true);
  networkRecorder.configure("info");
  let live!: LiveCallbacks;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let preferenceReads = 0;
  const retrySocket = vi.fn();
  const owner = createRelaySession({
    scope: "https://relay.test",
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    async query(filters) {
      if (!filters.some((filter) => filter.kinds?.includes(30078))) return [];
      if (++preferenceReads === 1)
        throw new ReadError(
          "unavailable",
          "Relay read failed (503)",
          503,
          60_000,
        );
      return [];
    },
    decodeSidebarPreferences: async () => {
      // Hold the retry in decoding, after its finite read's deadline is released.
      await gate;
      return { sections: [], assignments: {}, starred: [], muted: [] };
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry: retrySocket, dispose() {} };
    },
  });
  try {
    live.state({ status: "connected", routes: [] });
    await owner.session.sidebarPreferences.refresh();
    expect(owner.session.sidebarPreferences.snapshot().status).toBe("error");
    expect(
      networkRecorder
        .snapshot()
        .events.filter((event) => event.event === "recovery")
        .at(-1)?.sources,
    ).toContainEqual({ name: "sidebar-preferences", status: "failed" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(preferenceReads).toBe(2);
    const completion = owner.session.sidebarPreferences.refresh();
    await vi.advanceTimersByTimeAsync(RECOVERY_NOTICE_DELAY_MS - 1001);
    expect(owner.session.recovery?.snapshot().shown).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.session.recovery?.snapshot().shown).toBe(true);
    expect(owner.session.live.snapshot().status).toBe("connected");
    expect(
      networkRecorder
        .snapshot()
        .events.filter((event) => event.event === "recovery")
        .at(-1),
    ).toMatchObject({
      shown: true,
      sources: expect.arrayContaining([
        { name: "sidebar-preferences", status: "busy" },
      ]),
    });
    release();
    await completion;
    expect(owner.session.recovery?.snapshot().recovering).toBe(false);
    expect(
      networkRecorder
        .snapshot()
        .events.filter((event) => event.event === "recovery")
        .at(-1)?.recovering,
    ).toBe(false);
    expect(retrySocket).not.toHaveBeenCalled();
    expect(preferenceReads).toBe(2);
  } finally {
    release();
    owner.dispose();
    networkRecorder.setEnabled(false);
    networkRecorder.clear();
    vi.useRealTimers();
  }
});

it("clears retained repository homes on live recovery, cache clearing, and disposal", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0 },
  );
  const seed = async () => {
    const pending = owner.session.repositories.home(
      "repo-channel",
      new AbortController().signal,
    );
    wire.next().respond([]);
    await pending;
    expect(owner.session.repositories.peekHome("repo-channel")).toEqual({
      status: "none",
    });
  };
  try {
    await seed();
    live.state({ status: "connected", routes: [] });
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
    await seed();
    await owner.clearCache();
    expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
    await seed();
  } finally {
    owner.dispose();
  }
  expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
});

it("establishing a large roster reads only retained windows, not every channel head", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0 },
  );
  try {
    const ids = Array.from({ length: 128 }, (_, i) => `channel-${i}`);
    const first = ids[0];
    assert.exists(first);
    live.receive(ids.map((id) => roster(relay, id, [viewer.pubkey])));
    owner.session.channels.ensure(first);
    const initial = wire.next();
    initial.respond([
      bounds(relay, first, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    live.state({ status: "connected", routes: [] });
    for (const id of ids) live.established(id);
    await flush();
    const catchup = wire.next();
    expect(catchup.filters[0]?.["#h"]).toEqual([ids[0]]);
    catchup.respond([
      bounds(relay, first, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(
      owner.session.live.snapshot().heads.filter((h) => h.state === "verified"),
    ).toHaveLength(1);
    expect(
      owner.session.live.snapshot().heads.filter((h) => h.state === "deferred"),
    ).toHaveLength(127);
  } finally {
    owner.dispose();
  }
});

it("a skipped warm head cannot hide the stream gap behind its freshness lease", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0, prepared: true },
  );
  try {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    owner.session.channels.prepare?.("a");
    const warm = wire.next();
    warm.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(owner.retainedChannels()).toEqual([]);
    expect(owner.diagnostics().heads.entries).toBe(1);
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(owner.session.live.snapshot().heads[0]?.state).toBe("deferred");
    // Same wall-clock: freshness lease has not expired, but post-gap read is still required.
    owner.session.channels.ensure("a");
    await flush();
    const demand = wire.next();
    expect(demand.filters[0]?.["#h"]).toEqual(["a"]);
    demand.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(owner.session.channels.window("a").freshness).toBe("verified");
    expect(
      owner.session.live.snapshot().heads.find((h) => h.channelId === "a")
        ?.state,
    ).toBe("verified");
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.channels.window("a").freshness).toBe("cached");
  } finally {
    owner.dispose();
  }
});

it("keeps a failed head recovery-owned from a dropped stream until the re-established head settles", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const route = (status: "pending" | "live") => ({
    id: "channel:a",
    channelId: "a",
    status,
    replay: "unknown" as const,
  });
  const owned = () => headRecovering(owner.session.live.snapshot(), "a");
  try {
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    owner.session.channels.ensure("a");
    wire
      .next()
      .respond([
        bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    live.state({ status: "connected", routes: [route("live")] });
    live.established("a");
    await flush();
    wire.next().fail(new ReadError("unavailable", "Bad gateway", 502));
    await flush();
    expect(owned()).toBe(true);
    // The drop clears catch-up entries; reconnecting re-reads the head.
    live.state({ status: "retrying", routes: [route("pending")] });
    expect(owner.session.live.snapshot().heads).toEqual([]);
    expect(owned()).toBe(true);
    // Authenticated before the channel's EOSE: no entry yet, route pending.
    live.state({ status: "connected", routes: [route("pending")] });
    expect(owner.session.live.snapshot().heads).toEqual([]);
    expect(owned()).toBe(true);
    live.state({ status: "connected", routes: [route("live")] });
    live.established("a");
    await flush();
    expect(owned()).toBe(true);
    wire
      .next()
      .respond([
        bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    expect(
      owner.session.live.snapshot().heads.find((h) => h.channelId === "a")
        ?.state,
    ).toBe("verified");
    expect(owned()).toBe(false);
  } finally {
    owner.dispose();
  }
});

afterEach(() => vi.useRealTimers());
it("post-subscribe demand supersedes a pre-stream head and prioritizes the current retained reader", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const priority = vi.fn();
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, prioritize: priority, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0 },
  );
  try {
    live.receive(["a", "z"].map((id) => roster(relay, id, [viewer.pubkey])));
    owner.session.channels.ensure("a");
    const oldA = wire.next();
    oldA.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    owner.session.channels.ensure("z");
    const oldZ = wire.next();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    live.established("z");
    await flush();
    const current = wire.next();
    expect(current.filters[0]?.["#h"]).toEqual(["z"]);
    expect(oldZ.signal?.aborted).toBe(true);
    expect(priority.mock.lastCall?.[0][0]).toBe("z");
    current.respond([
      bounds(relay, "z", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    const other = wire.next();
    expect(other.filters[0]?.["#h"]).toEqual(["a"]);
    other.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "verified"),
    ).toBe(true);
  } finally {
    owner.dispose();
  }
});
it("long API pause keeps lightweight catch-up obligations; retry does not drain or bypass cooldown", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0 },
  );
  try {
    live.receive(["a", "b"].map((id) => roster(relay, id, [viewer.pubkey])));
    for (const id of ["a", "b"]) {
      owner.session.channels.ensure(id);
      wire
        .next()
        .respond([
          bounds(relay, id, "head", { has_more: false, next_cursor: null }),
        ]);
      await flush();
    }
    live.state({ status: "connected", routes: [] });
    live.established("a");
    live.established("b");
    await flush();
    wire
      .next()
      .fail(new ReadError("unavailable", "Relay requests paused", 429, 60000));
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "error"),
    ).toBe(true);
    owner.session.live.retry();
    owner.session.channels.ensure("a");
    await flush();
    expect(wire.pending).toHaveLength(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValue(performance.now() + 61000);
    owner.session.live.retry();
    await flush();
    const retry = wire.next();
    retry.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    const second = wire.next();
    second.respond([
      bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    clock.mockRestore();
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "verified"),
    ).toBe(true);
  } finally {
    vi.restoreAllMocks();
    owner.dispose();
  }
});

it.each([1, 2, 130])(
  "catch-up preserves unread evidence for a %s-channel roster",
  async (count) => {
    const relay = keypair(),
      viewer = keypair(),
      peer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...wire.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { readStateFloor: () => 0 },
    );
    try {
      const ids = Array.from(
        { length: count },
        (_, i) => `room-${i.toString().padStart(3, "0")}`,
      );
      const first = ids[0];
      assert.exists(first);
      live.receive(ids.map((id) => roster(relay, id, [viewer.pubkey])));
      owner.session.channels.ensure(first);
      const oldHead = wire.next();
      const repair = owner.session.unread.ensure();
      await flush();
      const evidence = wire.next();
      expect(evidence.filters[0]?.["#h"]).toEqual(ids.slice(0, 128));
      // Force the production race: both the old head and unread batch are still
      // in flight when the live route establishes. Only the old head is obsolete.
      live.state({ status: "connected", routes: [] });
      live.established(first);
      await flush();
      const head = wire.next();
      expect(head.filters[0]).toMatchObject({ "#h": [first], top_level: true });
      expect(oldHead.signal?.aborted).toBe(true);
      expect(evidence.signal?.aborted).toBe(false);
      head.respond([
        bounds(relay, first, "head", { has_more: false, next_cursor: null }),
      ]);
      for (let offset = 0; offset < ids.length; offset += 128) {
        const batch = offset === 0 ? evidence : wire.next();
        const batchIds = ids.slice(offset, offset + 128);
        expect(batch.filters[0]?.["#h"]).toEqual(batchIds);
        batch.respond(
          batchIds.map((id) =>
            message(peer, id, "unread evidence", 1700000900),
          ),
        );
        await flush();
      }
      await repair;
      expect(wire.pending).toHaveLength(0);
      for (const channelId of ids) {
        const snapshot = owner.session.unread.snapshot({
          kind: "channel",
          channelId,
        });
        expect(snapshot).toMatchObject({
          observedCount: 1,
          freshness: "observed",
        });
        expect(snapshot.error).toBeUndefined();
      }
      // Evidence repair must not populate timeline windows or undo catch-up.
      expect(owner.session.channels.window(first).rows).toEqual([]);
      expect(
        owner.session.live.snapshot().heads.find((h) => h.channelId === first)
          ?.state,
      ).toBe("verified");
    } finally {
      owner.dispose();
    }
  },
);

function reconnectHarness(
  options: ChannelStoreOptions = {},
  scripted: { notices?: boolean } = {},
) {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey, scripted);
  let live!: LiveCallbacks;
  /** Every read sent, membership notice reads included. */
  const queries: (readonly ReadFilter[])[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      query(filters, signal) {
        queries.push(filters);
        return wire.transport.query(filters, signal);
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0, prepared: true, ...options },
  );
  const window = () => owner.session.channels.window("c");
  const rows = () => window().rows.map((row) => row.id);
  /** Outstanding channel window reads; merged rows also queue profile reads.
   * A read the reader cancelled stays on the wire, aborted. */
  const reads = () =>
    wire.pending.filter(
      (entry) => !entry.signal?.aborted && entry.filters[0]?.top_level === true,
    );
  /** The one outstanding window read, after answering profile reads empty.
   * A head's notice read, sent beside it, stays pending. */
  const read = (channelId = "c") => {
    for (const entry of wire.pending.splice(0)) {
      if (entry.signal?.aborted) continue;
      if (entry.filters[0]?.kinds?.includes(0)) entry.respond([]);
      else wire.pending.push(entry);
    }
    const reads = wire.pending.filter((entry) => !isNoticeRead(entry.filters));
    expect(reads.map((entry) => entry.filters)).toMatchObject([
      [{ "#h": [channelId], top_level: true }],
    ]);
    const [entry] = reads;
    assert(entry);
    wire.pending.splice(wire.pending.indexOf(entry), 1);
    return entry;
  };
  const page = (
    suffix: string,
    events: readonly ReturnType<typeof message>[],
    next: ReturnType<typeof message> | null,
    channelId = "c",
  ) => [
    ...events,
    bounds(relay, channelId, suffix, {
      has_more: next !== null,
      next_cursor: next ? { created_at: next.created_at, id: next.id } : null,
    }),
  ];
  /** Read the roster: channel c and `others`, with no window open yet. */
  const list = async (others: readonly string[] = []) => {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond(
        ["c", ...others].flatMap((id) => [
          roster(relay, id, [viewer.pubkey]),
          metadata(relay, id, id.toUpperCase()),
        ]),
      );
    await flush();
  };
  /** Open channel c with `seen` loaded and more history behind it. */
  const open = async (seen: ReturnType<typeof message>) => {
    owner.session.channels.ensure("c");
    await flush();
    read().respond(page("head", [seen], seen));
    await flush();
    expect(rows()).toEqual([seen.id]);
  };
  /** Open channel c with `seen` loaded and more history behind it, then reconnect. */
  const reconnect = async (
    seen: ReturnType<typeof message>,
    others: readonly string[] = [],
  ) => {
    await list(others);
    await open(seen);
    live.state({ status: "connected", routes: [] });
    live.established("c");
    await flush();
  };
  /** The relay's grant notice for `channelId`, delivered live. Any roster
   * check it schedules is answered with c's roster. */
  const grant = async (channelId = "c") => {
    live.receive([
      signed(relay, {
        kind: 44100,
        content: "",
        created_at: 55,
        tags: [
          ["p", viewer.pubkey],
          ["h", channelId],
        ],
      }),
    ]);
    await flush();
    for (const entry of wire.pending.splice(0))
      if (entry.filters[0]?.top_level === true) wire.pending.push(entry);
      else
        entry.respond(
          entry.filters[0]?.kinds?.includes(0)
            ? []
            : [roster(relay, "c", [viewer.pubkey]), metadata(relay, "c", "C")],
        );
    await flush();
  };
  /** Drop the stream, with no reconnect yet. */
  const drop = async () => {
    live.state({ status: "retrying", routes: [] });
    await flush();
  };
  const cursor = (event: ReturnType<typeof message>) =>
    `${event.created_at}:${event.id}`;
  /** Connect; the establishment replays `replayed` before EOSE. */
  const connectAndReplay = async (replayed: readonly RelayEvent[]) => {
    live.state({ status: "connected", routes: [] });
    live.receive(replayed);
    await flush();
    live.established("c");
    await flush();
  };
  /** Drop the stream; the later re-establishment replays `replayed` before EOSE. */
  const dropAndReplay = async (replayed: readonly RelayEvent[]) => {
    await drop();
    await connectAndReplay(replayed);
  };
  return {
    owner,
    alice,
    wire,
    queries,
    get live() {
      return live;
    },
    window,
    rows,
    reads,
    read,
    page,
    list,
    open,
    reconnect,
    grant,
    drop,
    connectAndReplay,
    dropAndReplay,
    cursor,
  };
}
type ReconnectHarness = ReturnType<typeof reconnectHarness>;

it("a reconnect catch-up head newer than every loaded row pages back until it reaches one", async () => {
  // Live replay covers minutes. The head alone would leave the loaded rows on
  // screen with a silent gap before it; each page merges as it lands.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      old = message(h.alice, "c", "old", 5);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [missed], missed));
    await flush();
    expect(h.rows()).toEqual([seen.id, missed.id]);
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: 30,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      error: undefined,
    });
    expect(h.reads()).toHaveLength(0);
    // Reads older than any loaded page still wait for paging to reach them.
    const read = h.owner.session.read([{ ids: [old.id], limit: 1 }]);
    const entry = h.wire.pending.find((entry) => entry.filters[0]?.ids);
    assert(entry);
    entry.respond([old]);
    await read;
    expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
  } finally {
    h.owner.dispose();
  }
});

it("a reconnect catch-up that never reaches a loaded row drops it and continues from its last page", async () => {
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10);
    // Newest first: the head returns the first, then one row per page.
    const missed = [6, 5, 4, 3, 2, 1].map((n) =>
      message(h.alice, "c", `missed ${n}`, 10 + n * 10),
    );
    // The re-established stream delivers a row while the fill is in flight.
    const arrived = message(h.alice, "c", "arrived", 100);
    await h.reconnect(seen);
    let previous: (typeof missed)[number] | undefined;
    for (const [index, row] of missed.entries()) {
      const read = h.read();
      if (previous)
        expect(read.filters[0]).toMatchObject({
          until: previous.created_at,
          before_id: previous.id,
        });
      read.respond(h.page(previous ? h.cursor(previous) : "head", [row], row));
      await flush();
      if (index === 2) {
        h.live.receive([arrived]);
        await flush();
      }
      previous = row;
    }
    // Five pages past the head never reached `seen`: it goes rather than
    // sitting below a gap, and older history continues from the last page.
    // The row the stream delivered meanwhile stays.
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([
      ...missed.map((row) => row.id).reverse(),
      arrived.id,
    ]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      historyLimited: false,
      error: undefined,
    });
    h.owner.session.channels.loadOlder("c");
    expect(h.read().filters[0]).toMatchObject({
      until: previous?.created_at,
      before_id: previous?.id,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a reconnect catch-up whose head reaches a loaded row verifies the window with that one read", async () => {
  // The path every renewal takes: a healthy window costs one head read. This
  // is also the cold start: `reconnect` opens the window before any stream is
  // up, so the rows read over HTTP then are the first catch-up's snapshot.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      missed = message(h.alice, "c", "missed", 30);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [missed, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, missed.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it.each<
  [
    string,
    (h: ReconnectHarness) => void,
    (h: ReconnectHarness) => void,
    string | undefined,
  ]
>([
  ["fails", (h) => h.read().fail(new Error("offline")), () => {}, "offline"],
  [
    "is cancelled by the stream dropping",
    (h) => {
      h.read();
      h.live.state({ status: "retrying", routes: [] });
    },
    (h) => h.live.state({ status: "connected", routes: [] }),
    undefined,
  ],
])(
  "a catch-up fill whose page %s settles the window on the pages merged, and a retry pages on from there",
  async (_, interrupt, recover, error) => {
    // Were the loaded rows kept below the hole, the retry's head would overlap
    // the rows above it and certify the window with the hole still in it.
    const h = reconnectHarness();
    try {
      const seen = message(h.alice, "c", "seen", 10),
        between = message(h.alice, "c", "between", 20),
        missed = message(h.alice, "c", "missed", 30);
      await h.reconnect(seen);
      h.read().respond(h.page("head", [missed], missed));
      await flush();
      h.read().respond(h.page(h.cursor(missed), [between], between));
      await flush();
      expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
      interrupt(h);
      await flush();
      expect(h.rows()).toEqual([between.id, missed.id]);
      expect(h.window()).toMatchObject({
        status: "ready",
        freshness: "cached",
        hasMore: true,
        error,
      });
      recover(h);
      h.live.established("c");
      await flush();
      h.read().respond(h.page("head", [missed], missed));
      await flush();
      expect(h.reads()).toHaveLength(0);
      expect(h.rows()).toEqual([between.id, missed.id]);
      expect(h.window()).toMatchObject({
        status: "ready",
        freshness: "verified",
        hasMore: true,
        error: undefined,
      });
      // A verified head owns the cursor; the rows below it stay, and older
      // history pages on through them to the rows the fill never reached.
      h.owner.session.channels.loadOlder("c");
      const older = h.read();
      expect(older.filters[0]).toMatchObject({
        until: missed.created_at,
        before_id: missed.id,
      });
      older.respond(h.page(h.cursor(missed), [between, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, between.id, missed.id]);
    } finally {
      h.owner.dispose();
    }
  },
);

it("a catch-up fill page denied after its head purges the channel as a denied head would", async () => {
  // Settling on the pages read would keep the head just fetched on screen
  // after the relay refused the reader.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      fresh = message(h.alice, "c", "fresh", 30);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [fresh], fresh));
    await flush();
    expect(h.rows()).toEqual([seen.id, fresh.id]);
    h.read().fail(new ReadError("denied", "restricted: not a member", 403));
    await flush();
    expect(h.rows()).toEqual([]);
    expect(h.window().status).toBe("error");
    expect(
      h.owner.session.channels.list().channels.map((channel) => channel.id),
    ).not.toContain("c");
  } finally {
    h.owner.dispose();
  }
});

it("rows the re-established stream replays before catch-up are not overlap with the rows kept across the drop", async () => {
  // Replay covers the five minutes before reconnect, so the head always
  // overlaps it. The rows kept across the drop are what the fill must reach.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    expect(h.window().freshness).toBe("verified");
    await h.dropAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.rows()).toEqual([seen.id, missed.id, recent.id]);
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("an interrupted fill drops the rows kept across the drop and retains the replayed ones", async () => {
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.dropAndReplay([recent]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    h.read().fail(new Error("offline"));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "cached",
      hasMore: true,
      error: "offline",
    });
  } finally {
    h.owner.dispose();
  }
});

it("a fill the stream drop interrupts settles on rows the next catch-up must reach in turn", async () => {
  // The drop is seen before the cancelled page is; the settled window, not
  // the rows replayed after this second drop, is what its catch-up must reach.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40),
      later = message(h.alice, "c", "later", 50);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.dropAndReplay([recent]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    h.read();
    await h.dropAndReplay([later]);
    expect(h.rows()).toEqual([missed.id, recent.id, later.id]);
    h.read().respond(h.page("head", [later], later));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: later.created_at,
      before_id: later.id,
    });
    older.respond(h.page(h.cursor(later), [recent, missed], missed));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([missed.id, recent.id, later.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a second drop before any catch-up completes keeps the rows kept across the first", async () => {
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40),
      later = message(h.alice, "c", "later", 50);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.dropAndReplay([recent]);
    // The first catch-up's head is still outstanding when the stream drops again.
    h.read();
    await h.dropAndReplay([later]);
    expect(h.rows()).toEqual([seen.id, recent.id, later.id]);
    h.read().respond(h.page("head", [later, recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([
      seen.id,
      between.id,
      missed.id,
      recent.id,
      later.id,
    ]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a channel opened while the stream is down keeps the head it read for its catch-up to reach", async () => {
  // Its window has no drop-time snapshot. Were the rows at catch-up time the
  // snapshot, the replay among them would be the head's overlap, and the gap
  // between that head read and the replay would never be paged.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.list();
    h.live.state({ status: "connected", routes: [] });
    await h.drop();
    await h.open(seen);
    await h.dropAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a window evicted and re-created while the stream is down snapshots the head it re-reads, not the stale cached one", async () => {
  // The cached head it adopts is replaced by a fresh read before the stream
  // is back. Were the cached rows the snapshot, the catch-up would page after
  // rows no longer in the window until the bound, then drop the fresh ones.
  const h = reconnectHarness({ maxWindows: 1 });
  try {
    const old = message(h.alice, "c", "old", 5),
      seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.reconnect(old, ["d"]);
    await h.drop();
    // Opening d evicts c's window; c's head stays cached.
    h.owner.session.channels.ensure("d");
    await flush();
    h.read("d").respond(h.page("head", [], null, "d"));
    await flush();
    expect(h.rows()).toEqual([]);
    h.owner.session.channels.ensure("c");
    await flush();
    expect(h.rows()).toEqual([old.id]);
    // The cached head is stale, so the window revalidates it while still down.
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    expect(h.rows()).toEqual([seen.id]);
    await h.dropAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a window with no rows at the drop snapshots the head it reads while the stream is down", async () => {
  // An empty drop-time snapshot means contiguous. Were it kept past the head
  // read while down, that head's rows would never be reached and the gap
  // between them and the replay would be certified.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.list();
    h.owner.session.channels.ensure("c");
    await flush();
    h.read().respond(h.page("head", [], null));
    await flush();
    expect(h.rows()).toEqual([]);
    await h.connectAndReplay([]);
    h.read().respond(h.page("head", [], null));
    await flush();
    expect(h.window().freshness).toBe("verified");
    await h.drop();
    // Revisiting while down revalidates the stale cached head.
    h.owner.session.channels.ensure("c");
    await flush();
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    expect(h.rows()).toEqual([seen.id]);
    await h.dropAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("rows read before the first connection are the first catch-up's snapshot, not the rows after replay", async () => {
  // A first connect that takes longer than the replay covers (the socket
  // down while HTTP is up) leaves the same gap as a reconnect.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40);
    await h.list();
    await h.open(seen);
    await h.connectAndReplay([recent]);
    expect(h.rows()).toEqual([seen.id, recent.id]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    expect(h.window().freshness).toBe("cached");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: missed.created_at,
      before_id: missed.id,
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      error: undefined,
    });
  } finally {
    h.owner.dispose();
  }
});

it("a fill whose last page lands in the tick the stream drops reports the window cached", async () => {
  // The fill reached the rows kept across the drop, but the stream is
  // retrying: the window is not verified until the next catch-up is.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      between = message(h.alice, "c", "between", 20),
      missed = message(h.alice, "c", "missed", 30),
      recent = message(h.alice, "c", "recent", 40),
      later = message(h.alice, "c", "later", 50);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.dropAndReplay([recent]);
    h.read().respond(h.page("head", [recent, missed], missed));
    await flush();
    const older = h.read();
    // The stream drops as the page that reaches `seen` is being merged: the
    // drop is seen before the fill completes, after the page it would cancel.
    const unsubscribe = h.owner.session.channels.subscribeWindow("c", () => {
      unsubscribe();
      h.live.state({ status: "retrying", routes: [] });
    });
    older.respond(h.page(h.cursor(missed), [between, seen], seen));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([seen.id, between.id, missed.id, recent.id]);
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "cached",
      error: undefined,
    });
    // The rows the fill settled are what the next catch-up must reach.
    await h.dropAndReplay([later]);
    h.read().respond(h.page("head", [later, recent], recent));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual([
      seen.id,
      between.id,
      missed.id,
      recent.id,
      later.id,
    ]);
    expect(h.window().freshness).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});

it("an older page read while the stream is down waits below a settled fill until paging reaches it", async () => {
  // Those rows are not in the drop-time snapshot, so a fill that gives up on
  // the snapshot does not drop them; the settle's cursor hides them below the
  // window's floor until an older read from the last page reaches them.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      old = message(h.alice, "c", "old", 5);
    const missed = [6, 5, 4, 3, 2, 1].map((n) =>
      message(h.alice, "c", `missed ${n}`, 10 + n * 10),
    );
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.drop();
    h.owner.session.channels.loadOlder("c");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: seen.created_at,
      before_id: seen.id,
    });
    older.respond(h.page(h.cursor(seen), [old], old));
    await flush();
    expect(h.rows()).toEqual([old.id, seen.id]);
    await h.dropAndReplay([]);
    let previous: (typeof missed)[number] | undefined;
    for (const row of missed) {
      h.read().respond(
        h.page(previous ? h.cursor(previous) : "head", [row], row),
      );
      await flush();
      previous = row;
    }
    assert(previous);
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual(missed.map((row) => row.id).reverse());
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
    });
    h.owner.session.channels.loadOlder("c");
    const next = h.read();
    expect(next.filters[0]).toMatchObject({
      until: previous.created_at,
      before_id: previous.id,
    });
    next.respond(h.page(h.cursor(previous), [seen, old], old));
    await flush();
    expect(h.rows()).toEqual([
      old.id,
      seen.id,
      ...missed.map((row) => row.id).reverse(),
    ]);
  } finally {
    h.owner.dispose();
  }
});

it("an older page still in flight when a catch-up fill settles is discarded, and paging continues from the settled fill", async () => {
  // It continues from the cursor the settle replaced: merged, its rows would
  // sit directly below the hole and move the floor past it as verified.
  const h = reconnectHarness();
  try {
    const seen = message(h.alice, "c", "seen", 10),
      old = message(h.alice, "c", "old", 5);
    const missed = [6, 5, 4, 3, 2, 1].map((n) =>
      message(h.alice, "c", `missed ${n}`, 10 + n * 10),
    );
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    await h.drop();
    h.owner.session.channels.loadOlder("c");
    const older = h.read();
    expect(older.filters[0]).toMatchObject({
      until: seen.created_at,
      before_id: seen.id,
    });
    await h.connectAndReplay([]);
    let previous: (typeof missed)[number] | undefined;
    for (const row of missed) {
      h.read().respond(
        h.page(previous ? h.cursor(previous) : "head", [row], row),
      );
      await flush();
      previous = row;
    }
    assert(previous);
    older.respond(h.page(h.cursor(seen), [old], old));
    await flush();
    expect(h.reads()).toHaveLength(0);
    expect(h.rows()).toEqual(missed.map((row) => row.id).reverse());
    expect(h.window()).toMatchObject({
      status: "ready",
      freshness: "verified",
      hasMore: true,
      loadingOlder: false,
    });
    h.owner.session.channels.loadOlder("c");
    const next = h.read();
    expect(next.filters[0]).toMatchObject({
      until: previous.created_at,
      before_id: previous.id,
    });
  } finally {
    h.owner.dispose();
  }
});

it("re-reads held profiles and the roster on reconnect only when their replay was cut, had no cursor, failed or went unreported, or an earlier read failed", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  let profile = signed(alice, {
    kind: 0,
    content: '{"name":"Alice"}',
    tags: [],
  });
  // Every roster read finds the same channel, so no read revokes access.
  const channel = [
    roster(relay, "c", [viewer.pubkey]),
    metadata(relay, "c", "C"),
  ];
  let refuseProfiles = false;
  /** Answers every read until the wire is quiet; returns what was read. */
  const drain = async () => {
    const reads: (readonly ReadFilter[])[] = [];
    for (let quiet = 0; quiet < 3; ) {
      await flush();
      if (!wire.pending.length) quiet++;
      else quiet = 0;
      for (const entry of wire.pending.splice(0)) {
        reads.push(entry.filters);
        const kinds = entry.filters.flatMap((f) => f.kinds ?? []);
        if (refuseProfiles && kinds.includes(0)) {
          entry.fail(new Error("refused"));
          continue;
        }
        entry.respond(
          kinds.includes(0)
            ? [profile]
            : kinds.includes(39002) || kinds.includes(39000)
              ? channel
              : [],
        );
      }
    }
    return reads;
  };
  const profileReads = (reads: (readonly ReadFilter[])[]) =>
    reads.filter((filters) =>
      filters.some(
        (f) => f.kinds?.includes(0) && f.authors?.includes(alice.pubkey),
      ),
    );
  const rosterReads = (reads: (readonly ReadFilter[])[]) =>
    reads.filter((filters) => filters.some((f) => f.kinds?.includes(39002)));
  /** Drop the stream, reconnect, and establish both globals. */
  const reconnect = async (profiles?: boolean, membership = true) => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    if (profiles === undefined) {
      // A host that reports no route: both globals establish plainly.
      live.established();
      live.established();
    } else {
      live.established(undefined, { route: "profiles", continuous: profiles });
      live.established(undefined, {
        route: "membership",
        continuous: membership,
      });
    }
    return drain();
  };
  try {
    owner.session.channels.ensureList();
    await drain();
    const held = owner.session.profiles.ensure([alice.pubkey]);
    await drain();
    await held;
    expect(owner.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice",
    );
    // The first connection has no cursor: every held profile is read again.
    live.state({ status: "connected", routes: [] });
    live.established(undefined, { route: "profiles", continuous: false });
    live.established(undefined, { route: "membership", continuous: false });
    expect(profileReads(await drain())).toHaveLength(1);
    // A continuous replay already delivered every change: no full read.
    const quiet = await reconnect(true);
    expect(profileReads(quiet)).toEqual([]);
    expect(rosterReads(quiet)).toEqual([]);
    // A cut replay may have left changes out: read what that route covers.
    const cut = await reconnect(false);
    expect(profileReads(cut)).toHaveLength(1);
    expect(rosterReads(cut)).toEqual([]);
    const cutRoster = await reconnect(true, false);
    expect(profileReads(cutRoster)).toEqual([]);
    expect(rosterReads(cutRoster)).toHaveLength(1);
    // A read that fails stays owed: the next continuous reconnect reads again.
    refuseProfiles = true;
    expect(profileReads(await reconnect(false))).toHaveLength(1);
    refuseProfiles = false;
    expect(profileReads(await reconnect(true))).toHaveLength(1);
    expect(profileReads(await reconnect(true))).toEqual([]);
    // An older host reports no route: once per connection, as before.
    expect(profileReads(await reconnect(undefined))).toHaveLength(1);
    expect(owner.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice",
    );
    /** Drop the stream and reconnect without establishing anything yet. */
    const drop = () => {
      live.state({ status: "retrying", routes: [] });
      live.state({ status: "connected", routes: [] });
    };
    // Membership reports its route but profiles report nothing, in either
    // order: the missing report still reads every held profile again, once.
    drop();
    live.established(undefined, { route: "membership", continuous: true });
    live.established();
    expect(profileReads(await drain())).toHaveLength(1);
    drop();
    live.established();
    live.established(undefined, { route: "membership", continuous: true });
    expect(profileReads(await drain())).toHaveLength(1);
    // The profiles route fails before it establishes while membership
    // establishes: the finite reads replace its replay, once per connection.
    profile = signed(alice, {
      kind: 0,
      content: '{"name":"Alice Two"}',
      tags: [],
      created_at: 1_700_000_100,
    });
    drop();
    live.established(undefined, { route: "membership", continuous: true });
    const failed = {
      status: "connected",
      routes: [
        {
          id: "profiles",
          status: "error",
          replay: "unknown",
          error: "Live subscription setup timed out; retry available",
        },
      ],
    } as const;
    live.state(failed);
    live.state(failed);
    expect(profileReads(await drain())).toHaveLength(1);
    expect(owner.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice Two",
    );
    // Its later continuous establishment on the same connection reads nothing.
    live.established(undefined, { route: "profiles", continuous: true });
    expect(profileReads(await drain())).toEqual([]);
  } finally {
    owner.dispose();
  }
});

it("skips the reads a continuous global replay covers, and keeps them after a cut, no cursor, a failed route or an unreported one", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  let journal: ReadJournal | undefined;
  const decodeMarkers = vi.fn(async (events: readonly RelayEvent[]) =>
    decodeReadState(events, viewer.secret),
  );
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
      readState: { decode: decodeMarkers },
      writer: {
        sign: async () => {
          throw new Error("unused");
        },
        publish: async () => {},
      },
      reminders: {
        decode: async (events) =>
          events.map((e) => ({
            eventId: e.id,
            content: JSON.parse(e.content),
          })),
        sign: async () => {
          throw new Error("unused");
        },
      },
    },
    {
      readStateStorage: {
        capture: async () => structuredClone(journal),
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
    },
  );
  const status = (text: string, at: number) =>
    signed(alice, {
      kind: 30315,
      content: text,
      tags: [["d", "general"]],
      created_at: at,
    });
  const emojiSet = (shortcode: string, at: number) =>
    signed(alice, {
      kind: 30030,
      content: "",
      tags: [
        ["d", EMOJI_SET],
        ["emoji", shortcode, `https://example.com/${shortcode}.png`],
      ],
      created_at: at,
    });
  const reminder = (state: string, at: number) =>
    signed(viewer, {
      kind: 30300,
      content: JSON.stringify({ note: "Call Bob", status: state }),
      tags: [["d", "r1"]],
      created_at: at,
    });
  // Another device's read-state marker for channel "c".
  const marker: RelayEvent = signReadState(
    {
      slot: "ab".repeat(16),
      createdAt: 1_700_000_100,
      blob: { v: 1, client_id: "phone", contexts: { c: 1_700_000_050 } },
    },
    viewer.secret,
    1_700_000_100,
  );
  const channel = [
    roster(relay, "c", [viewer.pubkey]),
    metadata(relay, "c", "C"),
  ];
  /** Answers every read until the wire is quiet; returns what was read. */
  const drain = async () => {
    const reads: (readonly ReadFilter[])[] = [];
    for (let quiet = 0; quiet < 3; ) {
      await flush();
      if (!wire.pending.length) quiet++;
      else quiet = 0;
      for (const entry of wire.pending.splice(0)) {
        reads.push(entry.filters);
        const kinds = entry.filters.flatMap((f) => f.kinds ?? []);
        entry.respond(
          kinds.includes(39002) || kinds.includes(39000)
            ? channel
            : kinds.includes(30315)
              ? [status("At lunch", 1_700_000_000)]
              : kinds.includes(30030)
                ? [emojiSet("wave", 1_700_000_000)]
                : kinds.includes(30300)
                  ? [reminder("pending", 1_700_000_000)]
                  : [],
        );
      }
    }
    return reads;
  };
  /** The finite reads of each covered hook. */
  const covered = (reads: (readonly ReadFilter[])[]) => {
    const count = (kind: number) =>
      reads.filter((filters) => filters.some((f) => f.kinds?.includes(kind)))
        .length;
    return {
      statuses: count(30315),
      emoji: count(30030),
      markers: count(30078),
      reminders: count(30300),
    };
  };
  const once = { statuses: 1, emoji: 1, markers: 1, reminders: 1 };
  const none = { statuses: 0, emoji: 0, markers: 0, reminders: 0 };
  const drop = () => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
  };
  const establish = (profiles: boolean, membership: boolean) => {
    live.established(undefined, { route: "profiles", continuous: profiles });
    live.established(undefined, {
      route: "membership",
      continuous: membership,
    });
  };
  /** Every covered owner is back to its ready state. */
  const ready = () => {
    expect(owner.session.emoji.snapshot().status).toBe("ready");
    expect(owner.session.unread.sync().status).toBe("reconciled");
    expect(owner.session.reminders?.snapshot()).toMatchObject({
      status: "ready",
      hydrated: true,
    });
  };
  try {
    owner.session.channels.ensureList();
    const stop = owner.session.statuses.watch([alice.pubkey]);
    void owner.session.emoji.ensure();
    void owner.session.unread.ensure();
    await drain();
    // The first connection has no cursor: every covered hook reads.
    live.state({ status: "connected", routes: [] });
    establish(false, false);
    expect(covered(await drain())).toEqual(once);
    ready();
    // A quiet outage with a continuous replay: no covered hook reads, and each
    // owner is ready again. Changes made during the outage arrive through it.
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.reminders?.snapshot().status).toBe("loading");
    expect(owner.session.unread.sync().status).toBe("stale");
    live.state({ status: "connected", routes: [] });
    live.receive([
      status("In a meeting", 1_700_000_100),
      emojiSet("party", 1_700_000_100),
      reminder("done", 1_700_000_100),
      marker,
    ]);
    establish(true, true);
    expect(covered(await drain())).toEqual(none);
    ready();
    // The replayed marker went through the same ingest as a snapshot read.
    expect(decodeMarkers.mock.calls.at(-1)?.[0]).toEqual([marker]);
    expect(owner.session.statuses.snapshot().get(alice.pubkey)?.text).toBe(
      "In a meeting",
    );
    expect(
      owner.session.emoji.snapshot().entries.map((e) => e.shortcode),
    ).toContain("party");
    expect(owner.session.reminders?.snapshot().reminders).toMatchObject([
      { id: "r1", status: "done" },
    ]);
    // Each route decides only its own hooks.
    drop();
    establish(true, false);
    expect(covered(await drain())).toEqual({
      ...none,
      markers: 1,
      reminders: 1,
    });
    drop();
    establish(false, true);
    expect(covered(await drain())).toEqual({ ...none, statuses: 1, emoji: 1 });
    ready();
    // A cut replay reads as before.
    drop();
    establish(false, false);
    expect(covered(await drain())).toEqual(once);
    // An older host reports no route: once per connection, as before.
    drop();
    live.established();
    live.established();
    expect(covered(await drain())).toEqual(once);
    ready();
    // Routes that fail before they establish: the finite reads stand in for
    // their replay, once per connection; a later continuous establishment on
    // the same connection reads nothing.
    drop();
    const failed = {
      status: "connected",
      routes: (["profiles", "membership"] as const).map((id) => ({
        id,
        status: "error" as const,
        replay: "unknown" as const,
        error: "Live subscription setup timed out; retry available",
      })),
    } as const;
    live.state(failed);
    live.state(failed);
    expect(covered(await drain())).toEqual(once);
    establish(true, true);
    expect(covered(await drain())).toEqual(none);
    ready();
    // A cut report later on the same connection still reads.
    establish(false, false);
    expect(covered(await drain())).toEqual(once);
    ready();
    stop();
  } finally {
    owner.dispose();
  }
});

it("shows the viewer's own sends from before the loaded history only once paging reaches them", async () => {
  // The outbox keeps confirmed sends. One older than the head page must wait
  // for the older page, as every other row does: shown early, the reader
  // scrolls up through their own messages with everyone else's missing, even
  // while the head page loads. A failed send stays, since only its row offers
  // Retry.
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const lost = message(viewer, "c", "lost", 3),
    mine = message(viewer, "c", "mine", 5),
    before = message(alice, "c", "before", 4),
    after = message(alice, "c", "after", 6),
    seen = message(alice, "c", "seen", 10);
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: async () => {
          throw new Error("unused");
        },
        publish: async () => {},
      },
    },
    {
      prepared: true,
      outboxStorage: {
        load: () => [
          { event: lost, delivery: "failed" },
          { event: mine, signed: mine, delivery: "seen" },
        ],
        save() {},
      },
    },
  );
  const rows = () =>
    owner.session.channels.window("c").rows.map((row) => row.id);
  try {
    await owner.session.outbox?.ready();
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "c", [viewer.pubkey]),
        metadata(relay, "c", "C"),
      ]);
    await flush();
    owner.session.channels.ensure("c");
    await flush();
    // Before the head answers, the history's extent is unknown, not unbounded.
    expect(rows()).toEqual([lost.id]);
    wire.next().respond([
      seen,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 10, id: seen.id },
      }),
    ]);
    await flush();
    expect(rows()).toEqual([lost.id, seen.id]);
    // Other reads (profiles, outbox readback) answer empty.
    for (const entry of wire.pending.splice(0)) entry.respond([]);
    await flush();
    owner.session.channels.loadOlder("c");
    const older = wire.pending.find(
      ({ filters }) => filters[0]?.before_id === seen.id,
    );
    assert.exists(older);
    older.respond([
      after,
      mine,
      before,
      bounds(relay, "c", `10:${seen.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(rows()).toEqual([lost.id, before.id, mine.id, after.id, seen.id]);
  } finally {
    owner.dispose();
  }
});

describe("a reconnect whose replay was continuous", () => {
  /** Channel c open and verified on a first connection, then dropped. */
  const verifiedThenDropped = async (h: ReconnectHarness) => {
    const seen = message(h.alice, "c", "seen", 10);
    await h.reconnect(seen);
    h.read().respond(h.page("head", [seen], seen));
    await flush();
    expect(h.window().freshness).toBe("verified");
    await h.drop();
    expect(h.window().freshness).toBe("cached");
    h.queries.length = 0;
    return seen;
  };
  /** Connect; c's replay delivers `replayed`, then c establishes. */
  const resume = async (
    h: ReconnectHarness,
    replayed: readonly RelayEvent[],
    continuous: boolean,
  ) => {
    h.live.state({ status: "connected", routes: [] });
    h.live.receive(replayed, { phase: "replay", channelId: "c" });
    await flush();
    if (continuous) h.live.established("c", undefined, ["c"]);
    else h.live.established("c");
    await flush();
  };
  const channelReads = (h: ReconnectHarness) =>
    h.queries.filter((filters) => filters.some((f) => f["#h"]?.includes("c")));

  it("verifies a window live at the drop with no head, page or notice read", async () => {
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      // Sent in the outage, and one backdated by the relay's drift allowance:
      // both are inside the replay, which starts before the drop.
      const missed = message(h.alice, "c", "missed", 40),
        backdated = message(h.alice, "c", "backdated", 20);
      await resume(h, [missed, backdated], true);
      expect(channelReads(h)).toEqual([]);
      expect(h.reads()).toHaveLength(0);
      expect(h.rows()).toEqual([seen.id, backdated.id, missed.id]);
      expect(h.window()).toMatchObject({
        status: "ready",
        freshness: "verified",
        hasMore: true,
        error: undefined,
      });
      expect(
        h.owner.session.live
          .snapshot()
          .heads.find((head) => head.channelId === "c"),
      ).toMatchObject({ state: "verified" });
      // A later drop and a cut replay still catch up from the rows held now.
      await h.drop();
      const later = message(h.alice, "c", "later", 50);
      await resume(h, [], false);
      h.read().respond(h.page("head", [later, missed], missed));
      await flush();
      expect(h.rows()).toEqual([seen.id, backdated.id, missed.id, later.id]);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("applies an outage edit and reaction to a held message from a continuous replay", async () => {
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      const edit = signed(h.alice, {
          kind: 40003,
          content: "edited",
          created_at: 40,
          tags: [
            ["h", "c"],
            ["e", seen.id],
          ],
        }),
        reaction = signed(h.alice, {
          kind: 7,
          content: "+",
          created_at: 41,
          tags: [
            ["h", "c"],
            ["e", seen.id],
          ],
        });
      // Newest first, as the relay replays.
      await resume(h, [reaction, edit], true);
      expect(channelReads(h)).toEqual([]);
      expect(h.window().rows).toMatchObject([
        { id: seen.id, content: "edited", edited: true },
      ]);
      expect(JSON.stringify(h.window().rows[0]?.reactions ?? [])).toContain(
        '"+"',
      );
    } finally {
      h.owner.dispose();
    }
  });

  it("clears a failed outage page read when a continuous replay verifies the window", async () => {
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      h.owner.session.channels.loadOlder("c");
      h.read().fail(new Error("Relay request failed"));
      await flush();
      expect(h.window().error).toBe("Relay request failed");
      h.queries.length = 0;
      await resume(h, [], true);
      expect(channelReads(h)).toEqual([]);
      expect(h.window()).toMatchObject({
        freshness: "verified",
        error: undefined,
      });
      // Automatic paging can use the retained cursor again after recovery.
      h.owner.session.channels.loadOlder("c");
      const older = message(h.alice, "c", "older", 5);
      h.read().respond(h.page(h.cursor(seen), [older], null));
      await flush();
      expect(h.rows()).toEqual([older.id, seen.id]);
    } finally {
      h.owner.dispose();
    }
  });

  it("catches up from the rows held at a grant when a resumed channel is reported again with nothing continuous", async () => {
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      await resume(h, [], true);
      expect(h.reads()).toHaveLength(0);
      // Access ended during the outage, so the relay left c out of the batch,
      // and the stream has delivered nothing for it since. A grant re-sends it.
      await h.grant();
      expect(h.reads()).toHaveLength(0);
      // The re-sent batch delivers a live event before its report.
      const fresh = message(h.alice, "c", "fresh", 60);
      h.live.receive([fresh]);
      await flush();
      h.live.established("c");
      await flush();
      const hidden = message(h.alice, "c", "hidden", 30),
        newer = message(h.alice, "c", "newer", 50);
      // The head holds the live row; the gap lies below it, above `seen`.
      h.read().respond(h.page("head", [fresh, newer], newer));
      await flush();
      const older = h.read();
      expect(older.filters[0]).toMatchObject({ before_id: newer.id });
      older.respond(h.page(h.cursor(newer), [hidden, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, hidden.id, newer.id, fresh.id]);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("catches up from the drop's rows when a delayed continuous report arrives after a grant and its traffic", async () => {
    // The browser broker writes live events at once but holds a report under
    // backpressure: the grant and the re-sent batch's first event reach the
    // session before the report of the replay that left c out.
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      h.live.state({ status: "connected", routes: [] });
      await flush();
      await h.grant();
      const fresh = message(h.alice, "c", "fresh", 60);
      h.live.receive([fresh]);
      await flush();
      h.live.established("c", undefined, ["c"]);
      await flush();
      expect(h.window().freshness).toBe("cached");
      const hidden = message(h.alice, "c", "hidden", 30),
        newer = message(h.alice, "c", "newer", 50);
      h.read().respond(h.page("head", [fresh, newer], newer));
      await flush();
      const older = h.read();
      expect(older.filters[0]).toMatchObject({ before_id: newer.id });
      older.respond(h.page(h.cursor(newer), [hidden, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, hidden.id, newer.id, fresh.id]);
      expect(h.window().freshness).toBe("verified");
      // The re-sent batch's own report then needs only the head.
      h.live.established("c");
      await flush();
      h.read().respond(h.page("head", [fresh, newer], newer));
      await flush();
      expect(h.reads()).toHaveLength(0);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("keeps the rows held at a grant owed past a catch-up already running at its report", async () => {
    // A catch-up whose head was read before access ended still runs when the
    // grant, its re-sent batch's first row and that batch's report arrive.
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      await resume(h, [], false);
      const before = h.read();
      await h.grant();
      const fresh = message(h.alice, "c", "fresh", 60);
      h.live.receive([fresh]);
      await flush();
      h.live.established("c");
      await flush();
      // The older head lands: it reaches the drop's rows and settles.
      before.respond(h.page("head", [seen], seen));
      await flush();
      const hidden = message(h.alice, "c", "hidden", 30),
        newer = message(h.alice, "c", "newer", 50);
      h.read().respond(h.page("head", [fresh, newer], newer));
      await flush();
      const older = h.read();
      expect(older.filters[0]).toMatchObject({ before_id: newer.id });
      older.respond(h.page(h.cursor(newer), [hidden, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, hidden.id, newer.id, fresh.id]);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("keeps the rows held at a grant when the stream drops again before its catch-up", async () => {
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      await resume(h, [], true);
      await h.grant();
      const fresh = message(h.alice, "c", "fresh", 60);
      h.live.receive([fresh]);
      await flush();
      // The stream drops before the re-sent batch reports.
      await h.drop();
      const later = message(h.alice, "c", "later", 70);
      await resume(h, [later], true);
      expect(h.window().freshness).toBe("cached");
      const hidden = message(h.alice, "c", "hidden", 30),
        newer = message(h.alice, "c", "newer", 50);
      h.read().respond(h.page("head", [later, fresh, newer], newer));
      await flush();
      const older = h.read();
      expect(older.filters[0]).toMatchObject({ before_id: newer.id });
      older.respond(h.page(h.cursor(newer), [hidden, seen], seen));
      await flush();
      expect(h.rows()).toEqual([
        seen.id,
        hidden.id,
        newer.id,
        fresh.id,
        later.id,
      ]);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("catches up a resumed window from its current rows when the batch is later re-sent", async () => {
    // A routine refresh after a no-read resume: the window is contiguous
    // through the rows the stream delivered since, so the head reaching the
    // newest of them ends the catch-up.
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      await resume(h, [], true);
      const first = message(h.alice, "c", "live 1", 61),
        second = message(h.alice, "c", "live 2", 62),
        third = message(h.alice, "c", "live 3", 63);
      const live = [first, second, third];
      h.live.receive(live);
      await flush();
      h.live.established("c");
      await flush();
      h.read().respond(h.page("head", [third, second], second));
      await flush();
      expect(h.reads()).toHaveLength(0);
      expect(h.rows()).toEqual([seen.id, ...live.map((event) => event.id)]);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("catches up as before when the replay was cut", async () => {
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      const missed = message(h.alice, "c", "missed", 40);
      await resume(h, [], false);
      expect(h.window().freshness).toBe("cached");
      h.read().respond(h.page("head", [missed, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, missed.id]);
      expect(h.window().freshness).toBe("verified");
      // The head read also asks for the newest membership notices.
      expect(
        channelReads(h).filter((filters) => filters[0]?.kinds?.[0] === 40099),
      ).toHaveLength(1);
    } finally {
      h.owner.dispose();
    }
  });

  it("catches up a window whose last head read is older than the replay, though its replay was continuous", async () => {
    // The relay drops a live frame when its send buffer is full, with no
    // notice. The replay starts 16 minutes before the drop, so it holds only
    // what a head read in the last 15 minutes cannot have missed.
    let clock = 1_700_000_000_000;
    const h = reconnectHarness({ now: () => clock });
    try {
      const seen = message(h.alice, "c", "seen", 10);
      await h.reconnect(seen);
      h.read().respond(h.page("head", [seen], seen));
      await flush();
      expect(h.window().freshness).toBe("verified");
      const lost = message(h.alice, "c", "frame the relay dropped", 20);
      clock += 15 * 60_000 + 1;
      await h.drop();
      h.queries.length = 0;
      await resume(h, [], true);
      expect(h.window().freshness).toBe("cached");
      h.read().respond(h.page("head", [lost, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, lost.id]);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("catches up a window whose only recent head read was a prefetch it never took, though its replay was continuous", async () => {
    // The prefetch's rows went to the cached head, not the open window, so
    // they cannot show the window holds the frame the relay dropped.
    let clock = 1_700_000_000_000;
    const h = reconnectHarness({ now: () => clock });
    try {
      const seen = message(h.alice, "c", "seen", 10);
      await h.reconnect(seen);
      h.read().respond(h.page("head", [seen], seen));
      await flush();
      expect(h.window().freshness).toBe("verified");
      const lost = message(h.alice, "c", "frame the relay dropped", 20);
      clock += 15 * 60_000 + 1;
      h.owner.session.channels.prepare?.("c");
      await flush();
      h.read().respond(h.page("head", [lost, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id]);
      await h.drop();
      h.queries.length = 0;
      await resume(h, [], true);
      expect(h.window().freshness).toBe("cached");
      h.read().respond(h.page("head", [lost, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, lost.id]);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("a live batch refresh re-reads the head, so a later continuous reconnect needs no read", async () => {
    let clock = 1_700_000_000_000;
    const h = reconnectHarness({ now: () => clock });
    try {
      const seen = message(h.alice, "c", "seen", 10);
      await h.reconnect(seen);
      h.read().respond(h.page("head", [seen], seen));
      await flush();
      const lost = message(h.alice, "c", "frame the relay dropped", 20);
      // The refresh re-sends the batch live-only: it reports nothing continuous.
      clock += 15 * 60_000;
      h.live.established("c");
      await flush();
      h.read().respond(h.page("head", [lost, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, lost.id]);
      clock += 10 * 60_000;
      await h.drop();
      h.queries.length = 0;
      await resume(h, [], true);
      expect(channelReads(h)).toEqual([]);
      expect(h.reads()).toHaveLength(0);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("catches up a window read before the first connection, though its replay was continuous", async () => {
    // Its rows never reached a live stream, so no replay can join them to it.
    const h = reconnectHarness();
    try {
      const seen = message(h.alice, "c", "seen", 10),
        missed = message(h.alice, "c", "missed", 40);
      await h.list();
      await h.open(seen);
      h.queries.length = 0;
      await resume(h, [], true);
      expect(h.window().freshness).toBe("cached");
      h.read().respond(h.page("head", [missed, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, missed.id]);
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("catches up a window still owed a catch-up when the stream dropped again", async () => {
    // The connection between took a cut replay and dropped before its
    // catch-up finished: the rows held since the first drop are still behind
    // a gap, whatever the next replay covers.
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      await resume(h, [], false);
      const head = h.read();
      await h.drop();
      expect(head.signal?.aborted).toBe(true);
      const missed = message(h.alice, "c", "missed", 40);
      await resume(h, [], true);
      expect(h.window().freshness).toBe("cached");
      h.read().respond(h.page("head", [missed, seen], seen));
      await flush();
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("catches up a window read again during the outage, though its replay was continuous", async () => {
    // The rows it shows came from that read, not from the stream.
    const h = reconnectHarness();
    try {
      const seen = await verifiedThenDropped(h);
      const between = message(h.alice, "c", "between", 20);
      h.owner.session.channels.ensure("c");
      h.read().respond(h.page("head", [between, seen], seen));
      await flush();
      expect(h.rows()).toEqual([seen.id, between.id]);
      h.queries.length = 0;
      await resume(h, [], true);
      expect(h.window().freshness).toBe("cached");
      h.read().respond(h.page("head", [between, seen], seen));
      await flush();
      expect(h.window().freshness).toBe("verified");
    } finally {
      h.owner.dispose();
    }
  });

  it("finishes a membership notice read still owed when a continuous replay verifies the window", async () => {
    const h = reconnectHarness({}, { notices: true });
    try {
      const notices = () =>
        h.wire.pending.filter(
          (entry) =>
            !entry.signal?.aborted && entry.filters[0]?.kinds?.[0] === 40099,
        );
      const seen = message(h.alice, "c", "seen", 10);
      await h.list();
      await h.open(seen);
      for (const entry of notices()) entry.respond([]);
      h.live.state({ status: "connected", routes: [] });
      h.live.established("c");
      await flush();
      h.read().respond(h.page("head", [seen], seen));
      await flush();
      expect(h.window().freshness).toBe("verified");
      // The catch-up's notice read fails: its notices are still owed.
      const owed = notices();
      expect(owed).toHaveLength(1);
      owed[0]?.fail(new Error("Membership notices did not advance"));
      await flush();
      expect(notices()).toHaveLength(0);
      await h.drop();
      h.queries.length = 0;
      await resume(h, [], true);
      expect(h.window().freshness).toBe("verified");
      expect(h.reads()).toHaveLength(0);
      expect(notices()).toHaveLength(1);
    } finally {
      h.owner.dispose();
    }
  });

  it("refreshes an open thread only when its channel's replay was cut", async () => {
    const h = reconnectHarness();
    try {
      const root = message(h.alice, "c", "root", 10);
      await verifiedThenDropped(h);
      await resume(h, [], true);
      const thread = h.owner.session.thread("c", root.id);
      const answer = async () => {
        for (let quiet = 0; quiet < 3; ) {
          await flush();
          if (!h.wire.pending.length) quiet++;
          else quiet = 0;
          for (const entry of h.wire.pending.splice(0))
            entry.respond(
              entry.filters[0]?.ids?.includes(root.id) ? [root] : [],
            );
        }
      };
      void thread.refresh();
      await answer();
      expect(thread.snapshot().status).toBe("ready");
      const threadReads = () =>
        h.queries.filter((filters) =>
          filters.some(
            (f) => f.ids?.includes(root.id) || f["#e"]?.includes(root.id),
          ),
        );
      await h.drop();
      h.queries.length = 0;
      await resume(h, [], true);
      await answer();
      expect(threadReads()).toEqual([]);
      expect(thread.snapshot().status).toBe("ready");
      await h.drop();
      h.queries.length = 0;
      await resume(h, [], false);
      await answer();
      expect(threadReads().length).toBeGreaterThan(0);
      thread.dispose();
    } finally {
      h.owner.dispose();
    }
  });

  it("refreshes an open thread whose last read is older than the replay, though its replay was continuous", async () => {
    // A reply the relay dropped from the live stream before the replay starts
    // reaches the view only through a read.
    let clock = 1_700_000_000_000;
    const h = reconnectHarness({ now: () => clock });
    try {
      const root = message(h.alice, "c", "root", 10);
      await verifiedThenDropped(h);
      await resume(h, [], true);
      const thread = h.owner.session.thread("c", root.id);
      /** Replies the relay holds for the root. */
      let replies: RelayEvent[] = [];
      const answer = async () => {
        for (let quiet = 0; quiet < 3; ) {
          await flush();
          if (!h.wire.pending.length) quiet++;
          else quiet = 0;
          for (const entry of h.wire.pending.splice(0))
            entry.respond([
              ...(entry.filters[0]?.ids?.includes(root.id) ? [root] : []),
              ...(entry.filters.some((f) => f["#e"]?.includes(root.id))
                ? replies
                : []),
            ]);
        }
      };
      const threadReads = () =>
        h.queries.filter((filters) =>
          filters.some(
            (f) => f.ids?.includes(root.id) || f["#e"]?.includes(root.id),
          ),
        );
      void thread.refresh();
      await answer();
      expect(thread.snapshot().status).toBe("ready");
      // A reply the live stream dropped before the replay window.
      const reply = message(h.alice, "c", "reply", 20, [
        ["e", root.id, "", "reply"],
      ]);
      replies = [reply];
      clock += 15 * 60_000;
      await h.drop();
      h.queries.length = 0;
      await resume(h, [], true);
      await answer();
      expect(threadReads()).toEqual([]);
      expect(thread.snapshot().replies).toEqual([]);
      clock += 1;
      await h.drop();
      h.queries.length = 0;
      await resume(h, [], true);
      await answer();
      expect(threadReads().length).toBeGreaterThan(0);
      expect(thread.snapshot().status).toBe("ready");
      expect(thread.snapshot().replies.map((row) => row.id)).toEqual([
        reply.id,
      ]);
      thread.dispose();
    } finally {
      h.owner.dispose();
    }
  });

  it.each(["a refresh during the outage", "a refresh between two drops"])(
    "refreshes a thread after %s, though its channel's replay was continuous",
    async (change) => {
      // Its replies came from that read, not from the stream.
      const h = reconnectHarness();
      try {
        const root = message(h.alice, "c", "root", 10);
        await verifiedThenDropped(h);
        await resume(h, [], true);
        const thread = h.owner.session.thread("c", root.id);
        const answer = async () => {
          for (let quiet = 0; quiet < 3; ) {
            await flush();
            if (!h.wire.pending.length) quiet++;
            else quiet = 0;
            for (const entry of h.wire.pending.splice(0))
              entry.respond(
                entry.filters[0]?.ids?.includes(root.id) ? [root] : [],
              );
          }
        };
        const threadReads = () =>
          h.queries.filter((filters) =>
            filters.some(
              (f) => f.ids?.includes(root.id) || f["#e"]?.includes(root.id),
            ),
          );
        if (change === "a refresh during the outage") {
          void thread.refresh();
          await answer();
          await h.drop();
          void thread.refresh();
          await answer();
        } else {
          void thread.refresh();
          await answer();
          await h.drop();
          void thread.refresh();
          await answer();
          // A connection that drops before it establishes the channel: the
          // second drop keeps what the first took.
          h.live.state({ status: "connected", routes: [] });
          await flush();
          await h.drop();
        }
        expect(thread.snapshot().status).toBe("ready");
        h.queries.length = 0;
        await resume(h, [], true);
        await answer();
        expect(threadReads().length).toBeGreaterThan(0);
        expect(thread.snapshot().status).toBe("ready");
        thread.dispose();
      } finally {
        h.owner.dispose();
      }
    },
  );

  it.each(["a cache clear", "a failed refresh"])(
    "refreshes a thread after %s between the drop and a continuous replay",
    async (change) => {
      const h = reconnectHarness();
      try {
        const root = message(h.alice, "c", "root", 10);
        await verifiedThenDropped(h);
        await resume(h, [], true);
        const thread = h.owner.session.thread("c", root.id);
        const answer = async (fail = false) => {
          for (let quiet = 0; quiet < 3; ) {
            await flush();
            if (!h.wire.pending.length) quiet++;
            else quiet = 0;
            for (const entry of h.wire.pending.splice(0))
              if (fail && entry.filters[0]?.ids?.includes(root.id))
                entry.fail(new Error("Relay request failed"));
              else
                entry.respond(
                  entry.filters[0]?.ids?.includes(root.id) ? [root] : [],
                );
          }
        };
        void thread.refresh();
        await answer();
        expect(thread.snapshot().status).toBe("ready");
        await h.drop();
        // The view no longer holds what the stream kept live before the drop.
        if (change === "a cache clear") {
          await h.owner.clearCache();
          expect(thread.snapshot().status).toBe("idle");
        } else {
          void thread.refresh();
          await answer(true);
          expect(thread.snapshot().status).toBe("error");
        }
        const threadReads = () =>
          h.queries.filter((filters) =>
            filters.some(
              (f) => f.ids?.includes(root.id) || f["#e"]?.includes(root.id),
            ),
          );
        h.queries.length = 0;
        await resume(h, [], true);
        await answer();
        expect(threadReads().length).toBeGreaterThan(0);
        expect(thread.snapshot().status).toBe("ready");
        thread.dispose();
      } finally {
        h.owner.dispose();
      }
    },
  );
});

it("reconciles own sidebar hints with full fresh reads and bounded reconnect repair", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const data = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { alpha: "work" },
    starred: ["beta"],
    muted: ["gamma"],
  };
  const decode = vi.fn(async (): Promise<SidebarPreferences> => data);
  const owner = createRelaySession({
    ...wire.transport,
    decodeSidebarPreferences: decode,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const hint = signed(viewer, {
    kind: 30078,
    created_at: 1700000000,
    content: "encrypted",
    tags: [
      ["d", "channel-sections"],
      ["t", "channel-sections"],
    ],
  });
  const preferences = owner.session.sidebarPreferences;
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const empty = { ...data, assignments: {} };
    decode.mockResolvedValueOnce(empty);
    live.receive([hint, hint]);
    await flush();
    const read = wire.next();
    expect(read.filters).toHaveLength(5);
    expect(
      read.filters.every(
        (filter) =>
          filter.consistency === "strong" &&
          filter.limit === 1 &&
          filter.authors?.[0] === viewer.pubkey,
      ),
    ).toBe(true);
    read.respond([]);
    await preferences.ensure();
    expect(preferences.snapshot().data).toEqual(empty);
    live.receive([
      hint,
      signed(keypair(), { ...hint, created_at: hint.created_at + 1 }),
      signed(viewer, { ...hint, tags: [["d", "unknown"]] }),
      signed(viewer, {
        ...hint,
        tags: [
          ["d", "channel-stars"],
          ["d", "channel-sections"],
        ],
      }),
    ]);
    await flush();
    expect(wire.pending).toHaveLength(0);
    live.state({ status: "connected", routes: [] });
    live.established(undefined, { route: "membership", continuous: true });
    await flush();
    // Other global owners may read; only count this complete account batch.
    const batches = () =>
      wire.pending.filter((entry) =>
        entry.filters.some((f) => f["#d"]?.includes("channel-sections")),
      );
    expect(batches()).toHaveLength(0);
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    live.established(undefined, { route: "membership", continuous: false });
    await flush();
    expect(batches()).toHaveLength(1);
    batches()[0]?.respond([]);
    await preferences.ensure();
    expect(preferences.snapshot().data).toEqual(data);
    live.established(undefined, { route: "membership", continuous: true });
    await flush();
    expect(decode).toHaveBeenCalledTimes(3);
  } finally {
    owner.dispose();
  }
});

it("retries transient sidebar hint failures through existing preference recovery", async () => {
  vi.useFakeTimers();
  const viewer = keypair(),
    relay = keypair();
  let live!: LiveCallbacks;
  const data = { sections: [], assignments: {}, starred: [], muted: [] };
  const read = vi.fn(async () => []);
  const decode = vi.fn(async () => data);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: read,
    decodeSidebarPreferences: decode,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    await owner.session.sidebarPreferences.ensure();
    decode.mockRejectedValueOnce(new TypeError("network unavailable"));
    live.receive([
      signed(viewer, {
        kind: 30078,
        content: "encrypted",
        tags: [["d", "channel-sections"]],
      }),
    ]);
    await Promise.resolve();
    await owner.session.sidebarPreferences.ensure();
    expect(owner.session.sidebarPreferences.snapshot()).toMatchObject({
      status: "error",
      data,
      transient: true,
    });
    expect(owner.session.recovery?.snapshot().recovering).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    await owner.session.sidebarPreferences.ensure();
    expect(owner.session.sidebarPreferences.snapshot()).toEqual({
      status: "ready",
      data,
    });
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    owner.dispose();
  }
});
