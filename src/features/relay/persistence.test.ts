import { afterEach, expect, it, vi } from "vitest";
import { createHeadPersistence, type HeadPersistence } from "./persistence";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Store = Partial<IDBObjectStore>;
function transaction(
  abort: () => void,
  run: (cache: HeadPersistence) => Promise<unknown> = (cache) =>
    cache.remove("channel"),
  store: Store = { delete: vi.fn() },
) {
  const tx = {
    abort: vi.fn(abort),
    error: null,
    oncomplete: () => {},
    onabort: () => {},
    onerror: () => {},
    objectStore: () => store,
  };
  const request = {
    onsuccess: () => {},
    result: { transaction: () => tx, close: vi.fn() },
  };
  vi.stubGlobal("indexedDB", { open: () => request });
  const cache = createHeadPersistence("viewer", "relay");
  const result = run(cache);
  request.onsuccess();
  return { tx, result };
}

it("waits for completion when a timeout races an already-finished transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => {
    throw new DOMException("The transaction has finished", "InvalidStateError");
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(tx.abort).toHaveBeenCalledOnce();
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("still aborts and rejects a genuinely stalled transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => tx.onabort());
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects unexpected abort errors instead of leaving the operation pending", async () => {
  vi.useFakeTimers();
  const failure = new Error("Unexpected abort failure");
  const { result } = transaction(() => {
    throw failure;
  });
  const rejected = expect(result).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
});

function inactivating() {
  const state = { active: true };
  const get = { onsuccess: () => {}, result: undefined };
  const store: Store = {
    get: vi.fn(() => get as unknown as IDBRequest),
    getAll: vi.fn(),
    put: vi.fn(() => {
      if (state.active) return {} as IDBRequest<IDBValidKey>;
      throw new DOMException(
        "Failed to store record in an IDBObjectStore: The transaction is inactive or finished.",
        "TransactionInactiveError",
      );
    }),
  };
  return { state, get, store };
}
const writeStartup = (cache: HeadPersistence) =>
  cache.writeStartup?.({}) ?? Promise.reject();

it("ignores a request result delivered after the timeout aborted its transaction", async () => {
  vi.useFakeTimers();
  const { state, get, store } = inactivating();
  const { tx, result } = transaction(
    () => {
      state.active = false;
    },
    writeStartup,
    store,
  );
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(2000);
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(() => get.onsuccess()).not.toThrow();
  expect(store.put).not.toHaveBeenCalled();
  tx.onabort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("swallows a follow-up request thrown by a browser-initiated abort", async () => {
  vi.useFakeTimers();
  const { state, get, store } = inactivating();
  const { tx, result } = transaction(() => {}, writeStartup, store);
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get).toHaveBeenCalledOnce();
  state.active = false;
  expect(() => get.onsuccess()).not.toThrow();
  expect(store.put).toHaveBeenCalledOnce();
  expect(store.getAll).not.toHaveBeenCalled();
  tx.onabort();
  await rejected;
  expect(tx.abort).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("evicts the profile mirror before any saved roster", async () => {
  vi.useFakeTimers();
  const MB = 1024 * 1024;
  const rows = {
    onsuccess: () => {},
    result: [
      { key: "viewer:relay", bytes: 6.5 * MB, savedAt: 1 },
      { key: "viewer:relay:profiles", bytes: 2 * MB, savedAt: 2 },
    ],
  };
  const store = {
    put: vi.fn(),
    delete: vi.fn(),
    getAll: () => rows as unknown as IDBRequest,
  };
  const { tx, result } = transaction(
    () => {},
    (cache) => cache.writeProfiles?.([]) ?? Promise.resolve(),
    store,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(store.put).toHaveBeenCalledOnce();
  rows.onsuccess();
  expect(store.delete.mock.calls).toEqual([["viewer:relay:profiles"]]);
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
});
