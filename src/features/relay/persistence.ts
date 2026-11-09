import { byteSize } from "./budget";
import type { SidebarPreferences } from "./sidebar-preferences";
/** Device-local resume data, never proof of current access or permission to write. */
export type SavedStartup = {
  discovery?: {
    savedAt: number;
    relayAuthor: string;
    events: unknown[];
  };
  preferences?: { savedAt: number; data: SidebarPreferences };
};
/** Signed wire records only. The owner re-verifies before displaying cached history.
 * A cache hit is never authority for current membership or freshness. No keys/tokens are persisted. */
export type SavedHead = {
  channelId: string;
  savedAt: number;
  events: unknown[];
  profiles: unknown[];
};
export interface HeadPersistence {
  read(): Promise<SavedHead[]>;
  readStartup?(): Promise<SavedStartup | undefined>;
  writeStartup?(patch: SavedStartup): Promise<void>;
  /** Signed kind 0 events mirrored from the profile directory. */
  readProfiles?(): Promise<unknown[]>;
  writeProfiles?(events: readonly unknown[]): Promise<void>;
  write(head: SavedHead): Promise<void>;
  remove(channelId: string): Promise<void>;
  retain(channelIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}
const DB = "buzz-channel-heads-v1";
const STORE = "heads";
const STARTUP = "startup";
const MIRROR = ":profiles";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_HEADS = 64;
const MAX_AGE = 24 * 60 * 60 * 1000;
type Record = SavedHead & { key: string; scope: string; bytes: number };

export function createHeadPersistence(
  viewer: string,
  relay: string,
): HeadPersistence {
  const scope = `${viewer}:${relay}`;
  const profiles = `${scope}${MIRROR}`;
  let closed = false;
  let opening: Promise<IDBDatabase> | undefined;
  function database() {
    if (closed || typeof indexedDB === "undefined")
      return Promise.reject(new Error("Cache unavailable"));
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 2);
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true;
        reject(new Error("Cache open timed out"));
      }, 1500);
      request.onupgradeneeded = () => {
        for (const name of [STORE, STARTUP])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name, { keyPath: "key" });
      };
      request.onerror = () => {
        clearTimeout(timeout);
        reject(request.error);
      };
      request.onblocked = () => {
        expired = true;
        clearTimeout(timeout);
        reject(new Error("Cache blocked"));
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (closed || expired) {
          request.result.close();
          reject(new Error("Cache closed"));
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    return opening;
  }
  /** `handler` must issue follow-up requests synchronously (IDB auto-commits). */
  type Then = <R>(request: IDBRequest<R>, handler: (result: R) => void) => void;
  /** Keep the startup store, across identities, within its byte budget.
   * Optional profile mirrors give way before any saved roster. */
  function prune(store: IDBObjectStore, then: Then) {
    then(
      store.getAll(),
      (rows: { key: string; bytes: number; savedAt: number }[]) => {
        const mirror = (row: { key: string }) =>
          Number(row.key.endsWith(MIRROR));
        let total = 0;
        for (const row of rows.sort(
          (a, b) => mirror(a) - mirror(b) || b.savedAt - a.savedAt,
        )) {
          total += row.bytes;
          if (total > MAX_BYTES) store.delete(row.key);
        }
      },
    );
  }
  async function transact<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore, done: (value: T) => void, then: Then) => void,
    name = STORE,
  ): Promise<T> {
    const db = await database();
    if (closed) throw new Error("Cache closed");
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode);
      let result: T;
      let ended = false;
      const timeout = setTimeout(() => {
        ended = true;
        try {
          tx.abort();
        } catch (error) {
          // Native completion can precede its queued event. Let that event
          // settle the operation when the transaction can no longer abort.
          if (
            !(
              error instanceof DOMException &&
              error.name === "InvalidStateError"
            )
          )
            reject(error);
        }
      }, 2000);
      tx.oncomplete = () => {
        clearTimeout(timeout);
        resolve(result);
      };
      tx.onabort = tx.onerror = () => {
        ended = true;
        clearTimeout(timeout);
        reject(tx.error ?? new Error("Cache transaction aborted"));
      };
      work(
        tx.objectStore(name),
        (value) => {
          result = value;
        },
        (request, handler) => {
          request.onsuccess = () => {
            if (ended) return;
            try {
              handler(request.result);
            } catch (error) {
              // WebKit delivers a queued success after a browser-initiated abort.
              if (
                !(
                  error instanceof DOMException &&
                  error.name === "TransactionInactiveError"
                )
              )
                throw error;
              ended = true;
            }
          };
        },
      );
    });
  }
  return {
    readStartup: () =>
      transact(
        "readonly",
        (store, done, then) => then(store.get(scope), (row) => done(row?.data)),
        STARTUP,
      ),
    writeStartup: (patch) =>
      transact(
        "readwrite",
        (store, done, then) =>
          then(store.get(scope), (row) => {
            const data = { ...row?.data, ...patch };
            const bytes = byteSize(data);
            if (bytes <= MAX_BYTES) {
              store.put({ key: scope, data, bytes, savedAt: Date.now() });
              prune(store, then);
            }
            done(undefined);
          }),
        STARTUP,
      ),
    readProfiles: () =>
      transact(
        "readonly",
        (store, done, then) =>
          then(store.get(profiles), (row) => done(row?.data ?? [])),
        STARTUP,
      ),
    writeProfiles: (events) =>
      transact(
        "readwrite",
        (store, done, then) => {
          const bytes = byteSize(events);
          if (bytes <= MAX_BYTES) {
            store.put({
              key: profiles,
              data: events,
              bytes,
              savedAt: Date.now(),
            });
            prune(store, then);
          }
          done(undefined);
        },
        STARTUP,
      ),
    read: () =>
      transact("readonly", (store, done, then) =>
        then(store.getAll(), (rows: Record[]) =>
          done(
            rows
              .filter(
                (row) =>
                  row.scope === scope && Date.now() - row.savedAt < MAX_AGE,
              )
              .sort((a, b) => b.savedAt - a.savedAt)
              .slice(0, MAX_HEADS),
          ),
        ),
      ),
    write: (head) =>
      transact("readwrite", (store, done, then) => {
        const bytes = byteSize(head);
        if (bytes > MAX_BYTES) {
          done(undefined);
          return;
        }
        const row: Record = {
          ...head,
          scope,
          key: `${scope}:${head.channelId}`,
          bytes,
        };
        store.put(row);
        then(store.getAll(), (rows: Record[]) => {
          // Global disk budget across identities; scope is still required for every read.
          let total = 0,
            count = 0;
          for (const entry of rows.sort((a, b) => b.savedAt - a.savedAt)) {
            total += entry.bytes;
            count++;
            if (
              total > MAX_BYTES ||
              count > MAX_HEADS ||
              Date.now() - entry.savedAt >= MAX_AGE
            )
              store.delete(entry.key);
          }
          done(undefined);
        });
      }),
    remove: (channelId) =>
      transact("readwrite", (store, done) => {
        store.delete(`${scope}:${channelId}`);
        done(undefined);
      }),
    retain: (ids) =>
      transact("readwrite", (store, done, then) => {
        const allowed = new Set(ids);
        then(store.getAll(), (rows: Record[]) => {
          for (const row of rows)
            if (row.scope === scope && !allowed.has(row.channelId))
              store.delete(row.key);
          done(undefined);
        });
      }),
    clear: async () => {
      await transact(
        "readwrite",
        (store, done) => {
          store.delete(scope);
          store.delete(profiles);
          done(undefined);
        },
        STARTUP,
      );
      await transact("readwrite", (store, done, then) =>
        then(store.getAll(), (rows: Record[]) => {
          for (const row of rows)
            if (row.scope === scope) store.delete(row.key);
          done(undefined);
        }),
      );
    },
    close() {
      closed = true;
      void opening?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
