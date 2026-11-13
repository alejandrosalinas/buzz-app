// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CoreMemoryCache, forgetCoreMemory } from "./core-memory-cache";
import type { AgentReads, MemoryListing } from "./reads";

const agent = "a".repeat(64);
const listing = (body?: string, partial = false): MemoryListing => ({
  entries: body === undefined ? [] : [{ slug: "core", body, createdAt: 1 }],
  partial,
});

function setup() {
  const memoryListing = vi.fn(async (_signal: AbortSignal) => listing("one"));
  let reads: AgentReads | undefined = {
    connection: {},
    scope: "wss://one.test",
    memoryListing,
  } as unknown as AgentReads;
  const cache = new CoreMemoryCache(() => reads);
  return {
    cache,
    memoryListing,
    /** Loses the connection, with nothing to read through. */
    disconnect() {
      reads = undefined;
    },
    /** Replaces the connection, which may read as someone else. */
    reconnect(read = memoryListing, scope = "wss://one.test") {
      reads = {
        connection: {},
        scope,
        memoryListing: read,
      } as unknown as AgentReads;
    },
  };
}

function held() {
  let release!: (value: MemoryListing) => void;
  const promise = new Promise<MemoryListing>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(() => vi.restoreAllMocks());

it("waits on one read with nothing cached, then answers from the cache with none", async () => {
  const f = setup();
  await expect(f.cache.core(agent)).resolves.toBe("one");
  await expect(f.cache.core(agent)).resolves.toBe("one");
  // It reads `core` alone, by its address, not the whole listing.
  expect(f.memoryListing).toHaveBeenCalledExactlyOnceWith(
    expect.any(AbortSignal),
    "core",
  );
  // A new cache, as after a restart, starts empty and reads `core` again.
  const reads = {
    connection: {},
    scope: "wss://one.test",
    memoryListing: f.memoryListing,
  } as unknown as AgentReads;
  const restarted = new CoreMemoryCache(() => reads);
  await expect(restarted.core(agent)).resolves.toBe("one");
  expect(f.memoryListing).toHaveBeenCalledTimes(2);
  expect(f.memoryListing).toHaveBeenLastCalledWith(
    expect.any(AbortSignal),
    "core",
  );
});

it("never saves core memory to web storage", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const f = setup();
  await f.cache.core(agent);
  f.cache.wrote(agent, "core", "written");
  await f.cache.refresh(agent);
  expect(setItem).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});

it("shares one read between concurrent starts with nothing cached", async () => {
  const f = setup();
  const read = held();
  f.memoryListing.mockReturnValueOnce(read.promise);
  const starts = Promise.all(
    Array.from({ length: 5 }, () => f.cache.core(agent)),
  );
  read.release(listing("shared"));
  await expect(starts).resolves.toEqual(Array(5).fill("shared"));
  expect(f.memoryListing).toHaveBeenCalledOnce();
});

it("keeps what the agent wrote over a read that started before it", async () => {
  const f = setup();
  await f.cache.core(agent);
  const read = held();
  f.memoryListing.mockReturnValueOnce(read.promise);
  f.cache.refresh(agent);
  f.cache.wrote(agent, "core", "written");
  read.release(listing("stale"));
  await vi.waitFor(() => expect(f.memoryListing).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  await expect(f.cache.core(agent)).resolves.toBe("written");
});

it("leaves the cached copy when a refresh fails or its listing is partial", async () => {
  const f = setup();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await f.cache.core(agent);
  f.memoryListing.mockRejectedValueOnce(new Error("offline"));
  f.cache.refresh(agent);
  await vi.waitFor(() => expect(f.memoryListing).toHaveBeenCalledTimes(2));
  f.memoryListing.mockResolvedValueOnce(listing(undefined, true));
  f.cache.refresh(agent);
  await vi.waitFor(() => expect(f.memoryListing).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  await expect(f.cache.core(agent)).resolves.toBe("one");
});

it("does not declare core missing from a partial first listing", async () => {
  const f = setup();
  f.memoryListing.mockResolvedValue(listing(undefined, true));
  await expect(f.cache.core(agent)).resolves.toBeUndefined();
  await expect(f.cache.core(agent)).resolves.toBeUndefined();
  expect(f.memoryListing).toHaveBeenCalledTimes(2);
});

it("keeps nothing a replaced connection read", async () => {
  const f = setup();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const read = held();
  f.memoryListing.mockReturnValueOnce(read.promise);
  const first = f.cache.core(agent);
  const fresh = vi.fn(async () => listing("new owner's"));
  f.reconnect(fresh);
  read.release(listing("old owner's"));
  await expect(first).resolves.toBeUndefined();
  await expect(f.cache.core(agent)).resolves.toBe("new owner's");
  expect(fresh).toHaveBeenCalledOnce();
});

it("keeps each community's copy apart", async () => {
  const f = setup();
  await f.cache.core(agent);
  f.reconnect(
    vi.fn(async () => listing("two")),
    "wss://two.test",
  );
  await expect(f.cache.core(agent)).resolves.toBe("two");
  f.reconnect(f.memoryListing, "wss://one.test");
  await expect(f.cache.core(agent)).resolves.toBe("one");
  f.reconnect(
    vi.fn(async () => listing("unused")),
    "wss://two.test",
  );
  await expect(f.cache.core(agent)).resolves.toBe("two");
  expect(f.memoryListing).toHaveBeenCalledOnce();
});

it("gives a start waiting on its first read what the agent wrote meanwhile", async () => {
  const f = setup();
  const read = held();
  f.memoryListing.mockReturnValueOnce(read.promise);
  const waiting = f.cache.core(agent);
  await vi.waitFor(() => expect(f.memoryListing).toHaveBeenCalledOnce());
  f.cache.wrote(agent, "core", "new");
  read.release(listing("old"));
  await expect(waiting).resolves.toBe("new");
});

it("forgets a left community's copy, keeps it across a disconnect, and lets no held read restore it", async () => {
  const f = setup();
  await f.cache.core(agent);
  f.reconnect(
    vi.fn(async () => listing("two")),
    "wss://two.test",
  );
  await f.cache.core(agent);
  // A disconnect keeps the offline copy.
  f.reconnect(
    vi.fn(async () => listing("unused")),
    "wss://one.test",
  );
  await expect(f.cache.core(agent)).resolves.toBe("one");
  // A refresh is under way when the community is left.
  const read = held();
  f.reconnect(
    vi.fn(() => read.promise),
    "wss://one.test",
  );
  const refreshed = f.cache.refresh(agent);
  forgetCoreMemory("wss://one.test");
  // The read finishes on the same connection: only the purge's fence keeps it out.
  read.release(listing("stale"));
  await refreshed;
  // The other community's copy stays.
  f.reconnect(
    vi.fn(async () => listing("unused")),
    "wss://two.test",
  );
  await expect(f.cache.core(agent)).resolves.toBe("two");
  // Rejoining reads it again rather than reusing the forgotten copy.
  const rejoin = vi.fn(async () => listing("fresh"));
  f.reconnect(rejoin, "wss://one.test");
  await expect(f.cache.core(agent)).resolves.toBe("fresh");
  expect(rejoin).toHaveBeenCalledOnce();
});

it("keeps core memory with no connection, but not once its community is left", async () => {
  const f = setup();
  await f.cache.core(agent);
  f.disconnect();
  await expect(f.cache.core(agent)).resolves.toBe("one");
  forgetCoreMemory("wss://one.test");
  await expect(f.cache.core(agent)).resolves.toBeUndefined();
  // Rejoining, a first read that fails or misses it does not restore it.
  f.reconnect(vi.fn(async () => listing(undefined, true)));
  await expect(f.cache.core(agent)).resolves.toBeUndefined();
  f.reconnect(vi.fn(async () => Promise.reject(new Error("offline"))));
  await expect(f.cache.core(agent)).resolves.toBeUndefined();
});

it("clears core memory once a read finds none, even with no connection", async () => {
  const f = setup();
  await f.cache.core(agent);
  const none = vi.fn(async () => listing());
  f.reconnect(none);
  await f.cache.refresh(agent);
  f.disconnect();
  await expect(f.cache.core(agent)).resolves.toBeNull();
});

it("gives a failed first read what was cached while it waited", async () => {
  const f = setup();
  let fail!: (error: Error) => void;
  f.memoryListing.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const start = f.cache.core(agent);
  f.cache.wrote(agent, "core", "written");
  await expect(f.cache.core(agent)).resolves.toBe("written");
  fail(new Error("offline"));
  await expect(start).resolves.toBe("written");
});

it("gives a read outlived by its connection what the new one cached", async () => {
  const f = setup();
  const first = held();
  f.memoryListing.mockReturnValueOnce(first.promise);
  const start = f.cache.core(agent);
  f.reconnect(vi.fn(async () => listing("fresh")));
  await expect(f.cache.core(agent)).resolves.toBe("fresh");
  first.release(listing("stale"));
  await expect(start).resolves.toBe("fresh");
});

it("falls back to the community it last answered from, cached or not", async () => {
  const f = setup();
  await f.cache.core(agent);
  f.reconnect(
    vi.fn(async () => listing("two")),
    "wss://two.test",
  );
  await expect(f.cache.core(agent)).resolves.toBe("two");
  f.reconnect(f.memoryListing, "wss://one.test");
  await expect(f.cache.core(agent)).resolves.toBe("one");
  f.disconnect();
  await expect(f.cache.core(agent)).resolves.toBe("one");
});
