import { assert, describe, expect, it, vi } from "vitest";
import { huddleDescription } from "../huddle/lifecycle";
import { ReadError } from "./errors";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import type { HeadPersistence, SavedStartup } from "./persistence";
import type { RelayEvent } from "./events";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const id = (n: number) => n.toString(16).padStart(64, "0");
function setup(maxWindows = 2, now = Date.now) {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const store = createRelaySession(scripted.transport, { maxWindows, now });
  return { ...scripted, store, queries: store.session.channels };
}

describe("channel store", () => {
  it("is unavailable without a transport and rejects bad capacity", () => {
    const store = createRelaySession(null);
    expect(store.session.channels.list().status).toBe("unavailable");
    store.session.channels.ensureList();
    store.session.channels.ensure("x");
    store.session.channels.loadOlder("x");
    expect(store.session.channels.window("x")).toMatchObject({
      status: "idle",
      rows: [],
    });
    expect(store.session.media("https://x.test/a.png")).toBeUndefined();
    expect(() => createRelaySession(null, { maxWindows: 0 })).toThrow();
  });
  it("loads the roster once, notifies list subscribers, and reports errors without losing state", async () => {
    // Roster and metadata phases have identical asOf values for this dedupe check.
    const { queries, next, pending } = setup(2, () => 1_000);
    const listener = vi.fn();
    queries.subscribeList(listener);
    queries.ensureList();
    queries.ensureList();
    expect(pending.length).toBe(1);
    expect(queries.list().status).toBe("loading");
    next().respond([
      roster(relay, "b", [viewer.pubkey]),
      metadata(relay, "b", "Beta"),
      roster(relay, "a", [alice.pubkey]),
    ]);
    await flush();
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "b", name: "Beta" }],
    });
    expect(listener).toHaveBeenCalledTimes(2);
    queries.ensureList();
    expect(pending.length).toBe(0);
    const failing = setup();
    failing.queries.ensureList();
    failing.next().fail(new Error("offline"));
    await flush();
    expect(failing.queries.list()).toMatchObject({
      status: "error",
      error: "offline",
    });
    failing.queries.ensureList();
    expect(failing.queries.list().status).toBe("loading");
  });
  it("replaces a channel summary when only its private visibility changes", async () => {
    const { store, queries, next } = setup();
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    const publicSummary = queries.list().channels[0];
    expect(publicSummary?.private).toBeUndefined();

    queries.refreshList?.();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      signed(relay, {
        kind: 39000,
        content: JSON.stringify({ name: "Work" }),
        created_at: 1_700_000_001,
        tags: [["d", "work"], ["name", "Work"], ["private"]],
      }),
    ]);
    await flush();
    expect(queries.list().channels[0]).not.toBe(publicSummary);
    expect(queries.list().channels[0]?.private).toBe(true);
    store.dispose();
  });
  it("replaces a channel summary when only its auto-join flag changes", async () => {
    const { store, queries, next } = setup();
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    const plain = queries.list().channels[0];
    expect(plain?.autoJoin).toBeUndefined();

    queries.refreshList?.();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work", 1_700_000_001, [["auto_join"]]),
    ]);
    await flush();
    expect(queries.list().channels[0]).not.toBe(plain);
    expect(queries.list().channels[0]?.autoJoin).toBe(true);
    store.dispose();
  });
  it("preserves summary identity on preview refreshes and detects same-length DM roster changes", () => {
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
      { now: () => 1_000 },
    );
    try {
      const queries = owner.session.channels;
      live.receive([
        roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
        metadata(relay, "dm", "Direct", undefined, [["t", "dm"]]),
        roster(relay, "other", [viewer.pubkey]),
        metadata(relay, "other", "Other"),
      ]);
      const initial = queries.list().channels[0];
      const other = queries.list().channels[1];
      const listener = vi.fn();
      queries.subscribeList(listener);
      const incoming = message(alice, "dm", "hello", 10);
      live.receive([incoming]);
      const preview = queries.list();
      const direct = preview.channels[0];
      expect(direct).toMatchObject({ preview: "hello" });
      expect(direct?.members).toBe(initial?.members);
      expect(direct?.participants).toBe(initial?.participants);
      expect(preview.channels[1]).toBe(other);
      expect(listener).toHaveBeenCalledOnce();

      live.receive([incoming]);
      expect(queries.list()).toBe(preview);
      expect(listener).toHaveBeenCalledOnce();
      live.receive([
        roster(relay, "dm", [alice.pubkey, viewer.pubkey], 1_700_000_001),
      ]);
      expect(queries.list().channels[0]).toBe(direct);

      const replacement = keypair().pubkey;
      live.receive([
        roster(relay, "dm", [viewer.pubkey, replacement], 1_700_000_002),
      ]);
      expect(queries.list().channels[0]).not.toBe(direct);
      expect(queries.list().channels[0]).toMatchObject({
        preview: "hello",
        members: [viewer.pubkey, replacement].sort(),
        participants: [replacement],
      });
      expect(queries.list().channels[1]).toBe(other);
    } finally {
      owner.dispose();
    }
  });
  it("pages a window by the relay cursor, prepends older rows, and fetches missing profiles once", async () => {
    const { store, queries, next, pending } = setup();
    const listener = vi.fn();
    queries.subscribeWindow("c", listener);
    queries.ensure("c");
    queries.ensure("c");
    expect(pending.length).toBe(1);
    expect(queries.window("c").status).toBe("loading");
    const newer = message(alice, "c", "newer", 20),
      older = message(alice, "c", "older", 10);
    const head = next();
    expect(head.filters[0]).toMatchObject({
      "#h": ["c"],
      top_level: true,
      include_aux: true,
      include_summaries: true,
      limit: 20,
    });
    head.respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ]);
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "ready",
      hasMore: true,
      loadingOlder: false,
      rows: [{ id: newer.id }],
    });
    const profiles = next();
    expect(profiles.filters[0]).toMatchObject({
      kinds: [0],
      authors: [alice.pubkey],
    });
    queries.loadOlder("c");
    queries.loadOlder("c");
    expect(pending.length).toBe(1);
    expect(queries.window("c").loadingOlder).toBe(true);
    const page = next();
    expect(page.filters[0]).toMatchObject({
      until: 20,
      before_id: newer.id,
      top_level: true,
      include_aux: true,
      include_summaries: true,
      limit: 20,
    });
    // Older rows prepend; the duplicated `newer` row is deduped; alice is already pending so no second profile query.
    page.respond([
      older,
      newer,
      bounds(relay, "c", `20:${newer.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "ready",
      hasMore: false,
      loadingOlder: false,
      rows: [{ id: older.id }, { id: newer.id }],
    });
    expect(pending.length).toBe(0);
    profiles.respond([profile(alice, { name: "Alice" })]);
    await flush();
    expect(store.session.profiles.snapshot().get(alice.pubkey)).toEqual({
      name: "Alice",
    });
    queries.loadOlder("c");
    expect(pending.length).toBe(0);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it("keeps rows older than a paged window's history bound out until a page reaches them", async () => {
    // Agents, search and previews read single old messages through the
    // session. Merging one into an open window above its loaded history makes
    // a gap that later pages fill in the middle, which the timeline reads as
    // new arrivals and does not anchor, so the reader jumps back.
    const { store, queries, next, pending } = setup();
    const page = (filter: Record<string, unknown>) => {
      const index = pending.findIndex((entry) =>
        Object.entries(filter).every(
          ([key, value]) =>
            JSON.stringify(entry.filters[0]?.[key as "limit"]) ===
            JSON.stringify(value),
        ),
      );
      const [entry] = pending.splice(index, 1);
      assert.exists(entry);
      return entry;
    };
    const newer = message(alice, "c", "newer", 20),
      middle = message(alice, "c", "middle", 10),
      old = message(alice, "c", "old", 5);
    // Read before the window opens: it also seeds the live tail.
    const early = store.session.read([{ ids: [old.id], limit: 1 }]);
    next().respond([old]);
    await early;
    queries.ensure("c");
    next().respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ]);
    await flush();
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([newer.id]);
    // Read while the window is open.
    const late = store.session.read([{ ids: [old.id], limit: 1 }]);
    page({ ids: [old.id] }).respond([old]);
    await late;
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([newer.id]);
    // A read inside the loaded history still lands.
    const live = message(alice, "c", "live", 30);
    const current = store.session.read([{ ids: [live.id], limit: 1 }]);
    page({ ids: [live.id] }).respond([live]);
    await current;
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([
      newer.id,
      live.id,
    ]);
    queries.loadOlder("c");
    page({ until: 20 }).respond([
      middle,
      old,
      bounds(relay, "c", `20:${newer.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([
      old.id,
      middle.id,
      newer.id,
      live.id,
    ]);
    store.dispose();
  });
  it("evicts the least recently ensured window beyond capacity, aborting its request and rejecting late results", async () => {
    const { queries, store, next, pending } = setup(2);
    const evicted = vi.fn();
    queries.subscribeWindow("a", evicted);
    queries.ensure("a");
    const requestA = next();
    queries.ensure("b");
    next().respond([
      bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    queries.ensure("c");
    expect(store.retainedChannels()).toEqual(["b", "c"]);
    expect(requestA.signal?.aborted).toBe(true);
    expect(queries.window("a")).toMatchObject({ status: "idle", rows: [] });
    requestA.respond([
      message(alice, "a", "late", 1),
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(queries.window("a")).toMatchObject({ status: "idle", rows: [] });
    // Re-ensuring a still-retained window only touches recency; re-ensuring the evicted one reloads it.
    queries.ensure("b");
    expect(store.retainedChannels()).toEqual(["c", "b"]);
    queries.ensure("a");
    expect(store.retainedChannels()).toEqual(["b", "a"]);
    const lateRead = pending.at(-1);
    assert.exists(lateRead);
    expect(lateRead.filters[0]).toMatchObject({ "#h": ["a"] });
    store.dispose();
    lateRead.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(queries.window("a").status).not.toBe("ready");
  });
  it("surfaces bounds failures as window errors and lets ensure retry", async () => {
    const { queries, next } = setup();
    queries.ensure("c");
    next().respond([message(alice, "c", "no bounds", 1)]);
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "error",
      error: expect.stringMatching(/window bounds/),
    });
    queries.ensure("c");
    expect(queries.window("c").status).toBe("loading");
    next().respond([
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 1, id: id(1) },
      }),
    ]);
    await flush();
    queries.loadOlder("c");
    next().fail(new Error("relay down"));
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "ready",
      loadingOlder: false,
      error: "relay down",
      hasMore: true,
    });
  });
});

it("projects explicit visibility and replaces description-only changes", async () => {
  const { store, queries, next } = setup();
  try {
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    expect(queries.list().channels[0]?.visibility).toBeUndefined();
    for (const [index, description] of [
      "First description",
      "Second description",
      "",
    ].entries()) {
      const old = queries.list().channels[0];
      queries.refreshList?.();
      next().respond([
        roster(relay, "work", [viewer.pubkey]),
        metadata(relay, "work", "Work", 1_700_000_001 + index, [
          ["public"],
          ["about", description],
          ["t", "stream"],
        ]),
      ]);
      await flush();
      expect(queries.list().channels[0]).not.toBe(old);
      expect(queries.list().channels[0]).toMatchObject({
        description,
        visibility: "public",
      });
    }
  } finally {
    store.dispose();
  }
});

it("projects the signed metadata lifetime and replaces lifetime-only changes", async () => {
  const { store, queries, next } = setup();
  try {
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    expect(queries.list().channels[0]).not.toHaveProperty("ttlSeconds");
    // Malformed metadata keeps the channel listed without inventing a lifetime.
    for (const [index, [ttl, expected, replaced]] of (
      [
        [["ttl", "604800"], 604800, true],
        [["ttl", "86400"], 86400, true],
        [["ttl", "01"], undefined, true],
        [[], undefined, false],
      ] as const
    ).entries()) {
      const old = queries.list().channels[0];
      queries.refreshList?.();
      next().respond([
        roster(relay, "work", [viewer.pubkey]),
        metadata(relay, "work", "Work", 1_700_000_001 + index, [
          ...(ttl.length ? [[...ttl]] : []),
          ["t", "stream"],
        ]),
      ]);
      await flush();
      const channel = queries.list().channels[0];
      expect(channel?.name).toBe("Work");
      expect(channel?.ttlSeconds).toBe(expected);
      expect(channel === old).toBe(!replaced);
    }
  } finally {
    store.dispose();
  }
});

/** Two joined channels discovered in one short page, so the list is ready. */
async function discovered(test: ReturnType<typeof setup>) {
  test.queries.ensureList();
  test
    .next()
    .respond([
      roster(relay, "a", [viewer.pubkey]),
      metadata(relay, "a", "Alpha"),
      roster(relay, "b", [viewer.pubkey]),
      metadata(relay, "b", "Beta"),
    ]);
  await vi.waitFor(() =>
    expect(test.queries.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "a" }, { id: "b" }],
    }),
  );
  await vi.waitFor(() =>
    expect(test.store.session.live.snapshot().roster.state).toBe("verified"),
  );
}
it("refreshes one channel's roster with an exact read and merges it without dropping other channels", async () => {
  const test = setup();
  const { queries, next, pending } = test;
  const agent = keypair().pubkey;
  try {
    await discovered(test);
    const listener = vi.fn();
    const unsubscribe = queries.subscribeList(listener);
    const refreshing = queries.refreshRoster?.("a");
    expect(pending).toHaveLength(1);
    const request = next();
    expect(request.filters).toEqual([
      {
        kinds: [39002],
        authors: [relay.pubkey],
        "#d": ["a"],
        "#p": [viewer.pubkey],
        limit: 2,
      },
    ]);
    request.respond([
      roster(relay, "a", [viewer.pubkey, agent], 1_700_000_001),
    ]);
    await expect(refreshing).resolves.toBe(true);
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [
        { id: "a", name: "Alpha", members: [agent, viewer.pubkey].sort() },
        { id: "b", name: "Beta", members: [viewer.pubkey] },
      ],
    });
    expect(listener).toHaveBeenCalledOnce();
    await flush();
    // One exact read; no viewer-wide roster page followed it.
    expect(pending).toHaveLength(0);
    unsubscribe();
  } finally {
    test.store.dispose();
  }
});
it("reports no fresh roster evidence when an exact read omits the cached channel", async () => {
  const test = setup();
  try {
    await discovered(test);
    const before = test.queries.list();
    const refreshing = test.queries.refreshRoster?.("a");
    test.next().respond([]);
    await expect(refreshing).resolves.toBe(false);
    expect(test.queries.list()).toBe(before);
  } finally {
    test.store.dispose();
  }
});
it.each([
  ["older", 1_700_000_000, false],
  ["identical", 1_700_000_001, true],
] as const)(
  "requires discovery confirmation for an %s roster over a restored cache",
  async (_version, timestamp, confirmed) => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    const cached = roster(
      relay,
      "alpha",
      [viewer.pubkey, alice.pubkey],
      1_700_000_001,
    );
    const persistence: HeadPersistence = {
      read: async () => [],
      readStartup: async () => ({
        discovery: {
          savedAt: Date.now(),
          relayAuthor: relay.pubkey,
          events: [cached, metadata(relay, "alpha", "Alpha")],
        },
      }),
      writeStartup: async () => {},
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close: () => {},
    };
    const owner = createRelaySession(scripted.transport, {
      persistence,
      prepared: true,
    });
    try {
      await owner.restore();
      expect(owner.session.channels.list().channels[0]?.cached).toBe(true);
      const refreshing = owner.session.channels.refreshRoster?.("alpha");
      scripted
        .next()
        .respond([
          roster(relay, "alpha", [viewer.pubkey, alice.pubkey], timestamp),
        ]);
      await expect(refreshing).resolves.toBe(confirmed);
      expect(!!owner.session.channels.list().channels[0]?.cached).toBe(
        !confirmed,
      );
    } finally {
      owner.dispose();
    }
  },
);
it("keeps a cached denial and never reads for a channel it does not authorize", async () => {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const agent = keypair().pubkey;
  // A restored launch snapshot: alpha's membership is display-only until a
  // fresh relay roster confirms it.
  const persistence: HeadPersistence = {
    read: async () => [],
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [
          roster(relay, "alpha", [viewer.pubkey]),
          metadata(relay, "alpha", "Alpha"),
        ],
      },
    }),
    writeStartup: async () => {},
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {},
    close: () => {},
  };
  const owner = createRelaySession(scripted.transport, {
    persistence,
    prepared: true,
  });
  const queries = owner.session.channels;
  try {
    await owner.restore();
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "alpha", cached: true }],
    });
    // The exact viewer-scoped read omits the restored roster: a cached denial.
    const resolving = queries.resolve?.(["alpha"]);
    expect(scripted.pending).toHaveLength(1);
    scripted.next().respond([]);
    await expect(resolving).resolves.toBeUndefined();
    expect(queries.get?.("alpha")).toBeUndefined();
    expect(queries.list().channels).toEqual([]);
    queries.ensureList();
    await vi.waitFor(() => expect(scripted.pending).toHaveLength(1));
    scripted
      .next()
      .respond([
        roster(relay, "beta", [viewer.pubkey]),
        metadata(relay, "beta", "Beta"),
      ]);
    await vi.waitFor(() =>
      expect(queries.list()).toMatchObject({
        status: "ready",
        channels: [{ id: "beta" }],
      }),
    );
    // A denied id is not this method's to re-read: no request leaves, and the
    // denial stands. Fresh admission belongs to `resolve` and the full pass.
    await expect(queries.refreshRoster?.("alpha")).resolves.toBe(false);
    expect(scripted.pending).toHaveLength(0);
    const refreshing = queries.refreshRoster?.("beta");
    expect(scripted.pending).toHaveLength(1);
    scripted
      .next()
      .respond([roster(relay, "beta", [viewer.pubkey, agent], 1_700_000_001)]);
    await expect(refreshing).resolves.toBe(true);
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "beta", members: [agent, viewer.pubkey].sort() }],
    });
    expect(queries.get?.("alpha")).toBeUndefined();
  } finally {
    owner.dispose();
  }
});
it("writes one startup snapshot with the final content after a burst of discovery batches", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const writeStartup = vi.fn(async (_patch: SavedStartup) => {});
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      persistence: {
        read: async () => [],
        readStartup: async () => undefined,
        writeStartup,
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close: () => {},
      },
      prepared: true,
    },
  );
  try {
    const ids = ["a", "b", "c", "d"];
    for (const channel of ids)
      live.receive([roster(relay, channel, [viewer.pubkey])]);
    live.receive([metadata(relay, "a", "Alpha")]);
    vi.advanceTimersByTime(499);
    expect(writeStartup).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(writeStartup).toHaveBeenCalledTimes(1);
    const [patch] = writeStartup.mock.calls[0] ?? [];
    assert(patch);
    const saved = (patch.discovery?.events ?? []) as RelayEvent[];
    expect(
      saved.map((event) => [event.kind, event.tags[0]?.[1]]).sort(),
    ).toEqual([
      [39000, "a"],
      [39002, "a"],
      [39002, "b"],
      [39002, "c"],
      [39002, "d"],
    ]);
    vi.advanceTimersByTime(5_000);
    expect(writeStartup).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});
it.each([
  ["saves once after", false],
  ["drops the pending save when the cache is purged during", true],
] as const)("%s a burst of profile changes", async (_, purge) => {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const writeProfiles = vi.fn(async (_: readonly unknown[]) => {});
  // Fake from the start: a save armed on the real clock would hold the burst.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const owner = createRelaySession(scripted.transport, {
    persistence: {
      read: async () => [],
      readStartup: async () => undefined,
      writeStartup: async () => {},
      readProfiles: async () => [],
      writeProfiles,
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close: () => {},
    },
    prepared: true,
  });
  const queries = owner.session.channels;
  try {
    await owner.restore();
    queries.ensureList();
    await vi.waitFor(() => expect(scripted.pending).toHaveLength(1));
    scripted
      .next()
      .respond([
        roster(relay, "alpha", [viewer.pubkey, alice.pubkey]),
        metadata(relay, "alpha", "Alpha"),
        roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
        metadata(relay, "dm", "Direct", undefined, [["t", "dm"]]),
      ]);
    await vi.waitFor(() => expect(queries.list().status).toBe("ready"));
    await vi.advanceTimersByTimeAsync(1000);
    writeProfiles.mockClear();
    for (const person of [alice, keypair()]) {
      const ensuring = owner.session.profiles.ensure(
        [person.pubkey],
        "foreground",
      );
      // Fake-clock polls advance 1ms each, far inside the save delay.
      await vi.waitFor(() => expect(scripted.pending).not.toHaveLength(0), {
        interval: 1,
      });
      scripted.next().respond([profile(person, { name: "Person" })]);
      await ensuring;
      expect(owner.session.profiles.snapshot().get(person.pubkey)?.name).toBe(
        "Person",
      );
    }
    expect(writeProfiles).not.toHaveBeenCalled();
    if (purge) {
      const clearing = owner.clearCache();
      await vi.advanceTimersByTimeAsync(1000);
      await clearing;
      expect(writeProfiles).not.toHaveBeenCalled();
    } else {
      await vi.advanceTimersByTimeAsync(1000);
      expect(writeProfiles).toHaveBeenCalledTimes(1);
      expect(writeProfiles.mock.calls[0]?.[0]).toHaveLength(2);
    }
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});
it("does not rewrite the profile mirror when only cache hits reorder it", async () => {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const writeProfiles = vi.fn(async (_: readonly unknown[]) => {});
  const bob = keypair();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const owner = createRelaySession(scripted.transport, {
    persistence: {
      read: async () => [],
      readStartup: async () => undefined,
      writeStartup: async () => {},
      readProfiles: async () => [],
      writeProfiles,
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close: () => {},
    },
    prepared: true,
  });
  const profiles = owner.session.profiles;
  const load = async (ids: string[], events: RelayEvent[]) => {
    const ensuring = profiles.ensure(ids, "foreground");
    await vi.waitFor(() => expect(scripted.pending).not.toHaveLength(0), {
      interval: 1,
    });
    scripted.next().respond(events);
    await ensuring;
    await vi.advanceTimersByTimeAsync(1000);
  };
  try {
    await owner.restore();
    await load([alice.pubkey], [profile(alice, { name: "Alice" })]);
    await load([bob.pubkey], [profile(bob, { name: "Bob" })]);
    expect(writeProfiles).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.anything(), expect.anything()]),
    );
    writeProfiles.mockClear();
    // A hit reorders the cache; an unanswered name notifies without a new profile.
    await load([alice.pubkey, keypair().pubkey], []);
    expect(writeProfiles).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});
it.each(["idle", "loading", "error"] as const)(
  "rejects a roster refresh without reading while the list is %s",
  async (status) => {
    const test = setup();
    const { queries, next, pending } = test;
    try {
      if (status !== "idle") queries.ensureList();
      if (status === "error") {
        next().fail(new Error("offline"));
        await vi.waitFor(() => expect(queries.list().status).toBe("error"));
      }
      expect(queries.list().status).toBe(status);
      const outstanding = pending.length;
      await expect(queries.refreshRoster?.("a")).rejects.toThrow(/not ready/);
      expect(pending).toHaveLength(outstanding);
      expect(queries.list().status).toBe(status);
    } finally {
      test.store.dispose();
    }
  },
);
it.each<[string, (agent: string) => ReturnType<typeof roster>[]]>([
  [
    "a roster signed by another key",
    (agent) => [roster(keypair(), "a", [viewer.pubkey, agent], 1_700_000_001)],
  ],
  [
    "another channel's roster",
    (agent) => [roster(relay, "b", [viewer.pubkey, agent], 1_700_000_001)],
  ],
  [
    "two rosters",
    (agent) => [
      roster(relay, "a", [viewer.pubkey, agent], 1_700_000_001),
      roster(relay, "a", [viewer.pubkey, agent], 1_700_000_002),
    ],
  ],
])(
  "rejects %s from an exact roster read and leaves the list unchanged",
  async (_response, answer) => {
    const test = setup();
    const { queries, next, pending } = test;
    const agent = keypair().pubkey;
    try {
      await discovered(test);
      const before = queries.list();
      const refreshing = queries.refreshRoster?.("a");
      next().respond(answer(agent));
      await expect(refreshing).rejects.toThrow(/read budget/);
      expect(queries.list()).toBe(before);
      await flush();
      expect(pending).toHaveLength(0);
    } finally {
      test.store.dispose();
    }
  },
);
it("does not commit a roster read that lands after the list stopped being ready", async () => {
  const test = setup();
  const { queries, pending } = test;
  const agent = keypair().pubkey;
  try {
    await discovered(test);
    queries.refreshList?.();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const refreshing = queries.refreshRoster?.("a");
    expect(pending).toHaveLength(2);
    const page = pending.find((request) =>
      request.filters.some((filter) => filter["#p"] && !filter["#d"]),
    );
    const exact = pending.find((request) =>
      request.filters.some((filter) => filter["#d"]),
    );
    pending.splice(0);
    page?.fail(new Error("offline"));
    await vi.waitFor(() => expect(queries.list().status).toBe("error"));
    exact?.respond([roster(relay, "a", [viewer.pubkey, agent], 1_700_000_001)]);
    // Committing now would publish a ready list over the failed rediscovery.
    await expect(refreshing).rejects.toThrow(/Stale roster refresh/);
    expect(queries.list()).toMatchObject({
      status: "error",
      channels: [
        { id: "a", members: [viewer.pubkey] },
        { id: "b", members: [viewer.pubkey] },
      ],
    });
  } finally {
    test.store.dispose();
  }
});

it.each([
  [48100, 48103],
  [48103, 48100],
])(
  "keeps one Huddle card when live events arrive as %s then %s",
  async (first, second) => {
    let receive!: (events: readonly import("./events").RelayEvent[]) => void;
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        if (filters.some((filter) => filter.top_level))
          return [
            bounds(relay, "parent", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ];
        return [
          roster(relay, "parent", [viewer.pubkey]),
          metadata(relay, "parent", "Parent"),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        );
      },
      subscribe(callbacks) {
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      const channels = owner.session.channels;
      channels.ensureList();
      await vi.waitFor(() => expect(channels.list().status).toBe("ready"));
      channels.ensure("parent");
      await vi.waitFor(() =>
        expect(channels.window("parent").status).toBe("ready"),
      );
      let startId: string | undefined;
      for (const kind of [first, second]) {
        const event = signed(relay, {
          kind,
          tags: [["h", "parent"]],
          content: JSON.stringify({
            ephemeral_channel_id: "00000000-0000-4000-8000-000000000002",
          }),
        });
        if (kind === 48100) startId = event.id;
        receive([event]);
        expect(channels.window("parent").rows).toEqual([
          expect.objectContaining({
            id: startId ?? event.id,
            huddle: expect.objectContaining({
              state: startId ? "started" : "ended",
            }),
          }),
        ]);
      }
    } finally {
      owner.dispose();
    }
  },
);

describe("creator proof reads", () => {
  const stream = (
    channel: string,
    creator = alice.pubkey,
    createdAt = 1_700_000_000,
  ) =>
    metadata(relay, channel, channel, createdAt, [
      ["t", "stream"],
      ["P", creator],
    ]);
  type Pending = ReturnType<typeof setup>["pending"];
  /** Answer metadata reads with stream metadata and every other read with
   * nothing, until only creator proofs are pending; return those. */
  async function proofs(
    pending: Pending,
    creators = new Map<string, string>(),
  ) {
    for (let round = 0; round < 20; round++) {
      await flush();
      const found = pending.filter((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(9007)),
      );
      const other = pending.filter((entry) => !found.includes(entry));
      if (found.length && !other.length) return found;
      for (const entry of other) {
        pending.splice(pending.indexOf(entry), 1);
        entry.respond(
          entry.filters.flatMap((filter) =>
            filter.kinds?.includes(39000)
              ? (filter["#d"] ?? []).map((channel) =>
                  stream(channel, creators.get(channel)),
                )
              : [],
          ),
        );
      }
    }
    throw new Error("no creator proof read");
  }
  async function listed(channels: readonly string[]) {
    const test = setup();
    test.queries.ensureList();
    test
      .next()
      .respond(
        channels.map((channel) => roster(relay, channel, [viewer.pubkey])),
      );
    return test;
  }

  it("reads up to 250 channels' creations in one filter", async () => {
    const channels = Array.from({ length: 300 }, (_, i) => `c${i}`);
    const creators = new Map(
      channels.map((channel, i) => [
        channel,
        i % 2 ? alice.pubkey : viewer.pubkey,
      ]),
    );
    const { store, pending } = await listed(channels);
    try {
      const [read] = await proofs(pending, creators);
      assert.exists(read);
      const [first, second] = read.filters;
      expect(read.filters).toHaveLength(2);
      expect([first?.limit, second?.limit]).toEqual([500, 100]);
      expect([first?.["#h"]?.length, second?.["#h"]?.length]).toEqual([
        250, 50,
      ]);
      expect(
        new Set([...(first?.["#h"] ?? []), ...(second?.["#h"] ?? [])]),
      ).toEqual(new Set(channels));
      for (const filter of read.filters) {
        expect(filter.kinds).toEqual([9007]);
        expect(new Set(filter.authors)).toEqual(
          new Set([viewer.pubkey, alice.pubkey]),
        );
      }
    } finally {
      store.dispose();
    }
  });

  /** A session fed live, with the creator-proof reads it has pending. */
  function liveSession() {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    const reads = () =>
      wire.pending.filter((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(9007)),
      );
    return {
      owner,
      reads,
      receive: async (events: RelayEvent[]) => {
        live.receive(events);
        await flush();
      },
      take() {
        const [read] = reads();
        assert.exists(read);
        wire.pending.splice(wire.pending.indexOf(read), 1);
        return read;
      },
    };
  }
  const creation = (channel: string, extra: string[][] = []) =>
    signed(alice, {
      kind: 9007,
      created_at: 1_700_000_000,
      content: "",
      tags: [["h", channel], ...extra],
    });

  /** Holds the monotonic clock at `at` ms, with no retry jitter. */
  function clock() {
    let at = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => at);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    return {
      advance(ms: number) {
        at += ms;
      },
      restore() {
        now.mockRestore();
        random.mockRestore();
      },
    };
  }

  it("reads a channel's creation once as membership changes republish its metadata", async () => {
    // Each membership change republishes 39000 to every online member. A read
    // per version, times members, times a run of adds, was a relay-wide burst.
    const time = clock();
    const { owner, reads, receive, take } = liveSession();
    const members = [viewer.pubkey];
    const add = () => {
      members.push(keypair().pubkey);
      const at = 1_700_000_000 + members.length;
      return receive([
        roster(relay, "a", members, at),
        stream("a", alice.pubkey, at),
      ]);
    };
    try {
      await receive([roster(relay, "a", members), stream("a")]);
      take().fail(new Error("offline"));
      await flush();
      // A failed read backs off rather than retrying on every version.
      await add();
      expect(reads()).toEqual([]);
      time.advance(60_000);
      await add();
      const first = take();
      expect(first.filters).toMatchObject([
        { kinds: [9007], authors: [alice.pubkey], "#h": ["a"] },
      ]);
      // A version arriving while that read is in flight shares it.
      await add();
      expect(reads()).toEqual([]);
      first.respond([creation("a")]);
      await flush();
      for (let n = 0; n < 3; n++) await add();
      time.advance(24 * 3_600_000);
      await add();
      // Every version was applied, so each one was a candidate for a read.
      expect(owner.session.channels.list().channels[0]?.members).toHaveLength(
        members.length,
      );
      expect(reads()).toEqual([]);
    } finally {
      owner.dispose();
      time.restore();
    }
  });

  it("lets the next version read again after a cancelled creation read", async () => {
    // A cancelled read learned nothing, so it must not back off: a cancelled
    // lookup would otherwise hold off the channel's proof for a minute or more.
    const time = clock();
    const { owner, reads, receive, take } = liveSession();
    try {
      await receive([roster(relay, "a", [viewer.pubkey]), stream("a")]);
      take().fail(new DOMException("Cancelled", "AbortError"));
      await flush();
      const at = 1_700_000_001;
      await receive([
        roster(relay, "a", [viewer.pubkey, keypair().pubkey], at),
        stream("a", alice.pubkey, at),
      ]);
      expect(reads()).toHaveLength(1);
    } finally {
      owner.dispose();
      time.restore();
    }
  });

  it("retries a missing creation with backoff until it arrives", async () => {
    // A live 39000 can precede its creation on a read replica, and a channel
    // first seen long after creation can still meet a lagging replica. No
    // miss is final, or a Huddle could stay classified as an ordinary channel.
    const parent = "00000000-0000-4000-8000-000000000001";
    const room = "00000000-0000-4000-8000-000000000002";
    const about = huddleDescription(parent);
    let at = 1_700_000_000;
    const version = () => {
      at += 1;
      return [
        roster(relay, room, [viewer.pubkey], at),
        metadata(relay, room, "Huddle", at, [
          ["P", alice.pubkey],
          ["private"],
          ["t", "stream"],
          ["created_at", String(1_600_000_000)],
          ["ttl", "3600"],
          ["about", about],
        ]),
      ];
    };
    const summary = () =>
      owner.session.channels.list().channels.find(({ id }) => id === room);
    const time = clock();
    const { owner, reads, receive, take } = liveSession();
    try {
      await receive(version());
      take().respond([]);
      await flush();
      expect(summary()?.parentChannelId).toBeUndefined();
      time.advance(59_999);
      await receive(version());
      expect(reads()).toEqual([]);
      time.advance(1);
      await receive(version());
      take().respond([]);
      await flush();
      // The second miss doubles the backoff.
      time.advance(119_999);
      await receive(version());
      expect(reads()).toEqual([]);
      time.advance(1);
      await receive(version());
      take().respond([
        creation(room, [
          ["visibility", "private"],
          ["channel_type", "stream"],
          ["about", about],
        ]),
      ]);
      await flush();
      expect(summary()).toMatchObject({
        huddle: true,
        parentChannelId: parent,
      });
      time.advance(24 * 3_600_000);
      await receive(version());
      expect(reads()).toEqual([]);
    } finally {
      owner.dispose();
      time.restore();
    }
  });

  it.each(["missing", "cross-author", "ambiguous-coordinate"])(
    "retries a %s proof after a filter reaches its limit",
    async (receipt) => {
      const { store, queries, pending } = await listed(["a", "b"]);
      const creators = new Map([["a", viewer.pubkey]]);
      try {
        const [first] = await proofs(pending, creators);
        assert.exists(first);
        expect(first.filters).toMatchObject([{ "#h": ["a", "b"], limit: 4 }]);
        pending.splice(pending.indexOf(first), 1);
        // The shared author set admits viewer's creation in b, whose creator is
        // alice. Neither that cross match nor an ambiguous coordinate proves b.
        first.respond(
          [0, 1, 2, 3].map((n) =>
            signed(
              receipt === "ambiguous-coordinate" && n > 0 ? alice : viewer,
              {
                kind: 9007,
                created_at: 1_700_000_000 - n,
                content: "",
                tags:
                  n === 0 || receipt === "missing"
                    ? [["h", "a"]]
                    : receipt === "cross-author"
                      ? [["h", "b"]]
                      : [
                          ["h", "outside"],
                          ["h", "b"],
                        ],
              },
            ),
          ),
        );
        await flush();
        queries.refreshList?.();
        pending
          .shift()
          ?.respond([
            roster(relay, "a", [viewer.pubkey]),
            stream("a", viewer.pubkey),
            roster(relay, "b", [viewer.pubkey]),
            stream("b"),
          ]);
        const [again] = await proofs(pending);
        assert.exists(again);
        expect(again.filters).toMatchObject([{ "#h": ["b"], limit: 2 }]);
      } finally {
        store.dispose();
      }
    },
  );
});

it("settles a metadata retry during quota cooldown without issuing another read", async () => {
  const { store, queries, next, pending } = setup();
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  try {
    queries.ensureList();
    next().respond([roster(relay, "a", [viewer.pubkey])]);
    await flush();
    next().fail(new ReadError("unavailable", "Quota", 429, 5000));
    await flush();
    const failed = queries.list();
    expect(failed.status).toBe("error");
    expect(failed.channels[0]?.metadataPending).toBe(true);
    const settled = vi.fn();
    const stop = queries.subscribeList(settled);
    queries.ensureList();
    await flush();
    expect(pending).toHaveLength(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(queries.list()).not.toBe(failed);
    expect(queries.list()).toEqual(failed);
    stop();
    clock.mockReturnValue(6001);
    queries.ensureList();
    next().respond([roster(relay, "a", [viewer.pubkey])]);
    await flush();
    next().respond([metadata(relay, "a", "Alpha")]);
    await flush();
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [{ name: "Alpha", metadataPending: undefined }],
    });
  } finally {
    store.dispose();
    clock.mockRestore();
  }
});
