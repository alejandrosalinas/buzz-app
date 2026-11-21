import { describe, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  bounds,
  flush,
  keypair,
  metadata,
  roster,
  scriptedTransport,
} from "./testing";
import type { HeadPersistence, SavedHead } from "./persistence";

const relay = keypair(),
  viewer = keypair();
const empty = (id: string) => [
  bounds(relay, id, "head", { has_more: false, next_cursor: null }),
];
const discovery = (ids: string[]) =>
  ids.flatMap((id) => [
    roster(relay, id, [viewer.pubkey]),
    metadata(relay, id, id),
  ]);
function memoryDisk(records: SavedHead[]): HeadPersistence {
  return {
    read: vi.fn(async () => records),
    write: vi.fn(async () => {}),
    retain: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    close: vi.fn(),
  };
}
function setup(
  options: Parameters<typeof createRelaySession>[1] = {},
  starred?: readonly string[],
) {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  if (starred)
    scripted.transport = {
      ...scripted.transport,
      decodeSidebarPreferences: async () => ({
        sections: [],
        assignments: {},
        muted: [],
        starred: Object.freeze([...starred]),
      }),
    };
  const store = createRelaySession(scripted.transport, {
    prepared: true,
    warm: true,
    ...options,
  });
  return { ...scripted, store, queries: store.session.channels };
}
/** Channel ids addressed by the currently pending reads, in issue order. */
const warmed = (
  pending: readonly {
    filters: readonly { "#h"?: readonly string[] }[];
  }[],
) =>
  pending.flatMap((entry) => [
    // A head read's notice filter addresses the same channel.
    ...new Set(entry.filters.flatMap((filter) => filter["#h"] ?? [])),
  ]);

describe("roster warming", () => {
  it("warms the roster on a cold load without any channel being opened, one background head at a time", async () => {
    const { queries, next, pending, store } = setup();
    queries.ensureList();
    next().respond(discovery(["a", "b"]));
    await flush();
    expect(store.retainedChannels()).toEqual([]);
    expect(warmed(pending)).toEqual(["a"]);
    next().respond(empty("a"));
    await flush();
    expect(warmed(pending)).toEqual(["b"]);
    next().respond(empty("b"));
    await flush();
    expect(pending).toHaveLength(0);
  });

  it("orders warm reads starred first, then by head recency, never-fetched last", async () => {
    const disk = memoryDisk([
      {
        channelId: "b",
        savedAt: Date.now() - 2000,
        events: empty("b"),
        profiles: [],
      },
      {
        channelId: "c",
        savedAt: Date.now() - 1000,
        events: empty("c"),
        profiles: [],
      },
      {
        channelId: "d",
        savedAt: Date.now() - 3000,
        events: empty("d"),
        profiles: [],
      },
    ]);
    const { store, queries, next, pending } = setup({ persistence: disk });
    queries.ensureList();
    next().respond(discovery(["a", "b", "c", "d"]));
    await vi.waitFor(() => expect(store.diagnostics().heads.entries).toBe(3));
    queries.warm?.(["a"]);
    expect(warmed(pending)).toEqual(["a"]);
    next().respond(empty("a"));
    await flush();
    expect(warmed(pending)).toEqual(["c"]);
    next().respond(empty("c"));
    await flush();
    expect(warmed(pending)).toEqual(["b"]);
    next().respond(empty("b"));
    await flush();
    expect(warmed(pending)).toEqual(["d"]);
    next().respond(empty("d"));
    await flush();
    expect(pending).toHaveLength(0);
  });

  it("re-warming skips heads inside their freshness lease", async () => {
    const { queries, next, pending } = setup();
    queries.ensureList();
    next().respond(discovery(["a", "b"]));
    await flush();
    next().respond(empty("a"));
    await flush();
    next().respond(empty("b"));
    await flush();
    expect(pending).toHaveLength(0);
    queries.refreshList?.();
    next().respond(discovery(["a", "b"]));
    await flush();
    expect(pending).toHaveLength(0);
  });

  it("leaves open channels to demand instead of warming them", async () => {
    let clock = Date.now();
    const { queries, next, pending } = setup({ now: () => clock });
    queries.ensureList();
    next().respond(discovery(["a"]));
    await flush();
    next().respond(empty("a"));
    await flush();
    queries.ensure("a");
    expect(pending).toHaveLength(0); // The window opens from the fresh head.
    clock += 61_000; // Outlive the freshness lease.
    queries.warm?.([]);
    expect(pending).toHaveLength(0); // Demand owns the open channel.
  });
});
