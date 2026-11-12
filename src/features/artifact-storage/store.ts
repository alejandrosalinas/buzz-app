import type { JsonValue } from "../navigation/targets";
import { relayPartition } from "../relay/partition";
import type {
  ArtifactBatch,
  ArtifactCollectionDefinition,
  ArtifactEntry,
  ArtifactImport,
  ArtifactPage,
  ArtifactPageQuery,
  HostArtifactCollection,
  ArtifactRefresh,
  SavedArtifact,
} from "./types";

const DB = "buzz-artifacts-v1";
const STORES = ["records", "preferences", "entries", "metadata"];
type Row = {
  record: SavedArtifact;
  scope: string;
  collection: string;
  id: string;
};
type StoredPreference = { value: JsonValue };

function sameStoredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  if (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length !== right.length
  )
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameStoredValue(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

function sameRefresh(
  left: ArtifactRefresh | undefined,
  right: ArtifactRefresh,
) {
  return left?.source === right.source && left.generation === right.generation;
}

/** Same IndexedDB transaction boundary as the relay journals. No head-cache eviction. */
export function createArtifactStore(viewer: string, relay: string) {
  if (!viewer || !relay)
    throw new Error("Artifact storage needs an identity and relay");
  const scope = relayPartition(relay, viewer);
  let closed = false;
  const collections = new Set<HostArtifactCollection>();
  let opening: Promise<IDBDatabase> | undefined;
  function database() {
    if (closed) throw new Error("Artifact storage closed");
    if (!opening) {
      const attempt = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB, 3);
        let blocked = false;
        request.onupgradeneeded = () => {
          const db = request.result;
          if (db.objectStoreNames.contains("members"))
            db.deleteObjectStore("members");
          if (db.objectStoreNames.contains("records")) {
            const transaction = request.transaction;
            if (!transaction)
              throw new Error("Artifact database upgrade has no transaction");
            const records = transaction.objectStore("records");
            if (!records.indexNames.contains("channel"))
              records.createIndex("channel", [
                "scope",
                "collection",
                "record.channelId",
                "id",
              ]);
          }
          for (const name of STORES) {
            if (db.objectStoreNames.contains(name)) continue;
            const store = db.createObjectStore(name, {
              keyPath:
                name === "entries"
                  ? ["scope", "collection", "index", "value", "order", "id"]
                  : name === "metadata"
                    ? ["scope", "collection", "key"]
                    : ["scope", "collection", "id"],
            });
            if (name === "entries")
              store.createIndex("record", ["scope", "collection", "id"]);
            if (name === "records")
              store.createIndex("channel", [
                "scope",
                "collection",
                "record.channelId",
                "id",
              ]);
          }
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          blocked = true;
          reject(
            new Error("Close other Buzz windows to open artifact storage"),
          );
        };
        request.onsuccess = () => {
          const db = request.result;
          if (closed || blocked) {
            db.close();
            reject(new Error("Artifact storage closed"));
            return;
          }
          db.onversionchange = () => {
            db.close();
            opening = undefined;
          };
          resolve(db);
        };
      });
      opening = attempt;
      void attempt.catch(() => {
        if (opening === attempt) opening = undefined;
      });
    }
    return opening;
  }
  type Then = <T>(request: IDBRequest<T>, next: (value: T) => void) => void;
  async function transact<T>(
    mode: IDBTransactionMode,
    stores: string[],
    work: (tx: IDBTransaction, then: Then, done: (value: T) => void) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const db = await database();
    signal?.throwIfAborted();
    if (closed) throw new Error("Artifact storage closed");
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode, { durability: "strict" });
      let value: T;
      let failure: unknown;
      const stop = () => {
        try {
          tx.abort();
        } catch (error) {
          if (
            !(
              error instanceof DOMException &&
              error.name === "InvalidStateError"
            )
          )
            throw error;
        }
      };
      const abort = () => {
        failure = signal?.reason;
        stop();
      };
      signal?.addEventListener("abort", abort, { once: true });
      const guard = (fn: () => void) => {
        if (signal?.aborted) return;
        try {
          fn();
        } catch (error) {
          if (!signal?.aborted) failure = error;
          stop();
        }
      };
      const then: Then = (request, next) => {
        request.onsuccess = () => guard(() => next(request.result));
      };
      tx.oncomplete = () => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      tx.onabort = () => {
        signal?.removeEventListener("abort", abort);
        reject(
          failure ?? tx.error ?? new Error("Artifact transaction aborted"),
        );
      };
      guard(() =>
        work(tx, then, (result) => {
          value = result;
        }),
      );
    });
  }
  function collection(
    owner: string,
    definition: ArtifactCollectionDefinition,
  ): HostArtifactCollection {
    if (closed) throw new Error("Artifact storage closed");
    if (
      !owner ||
      !definition.name ||
      !definition.type ||
      !Number.isSafeInteger(definition.version) ||
      definition.version < 1
    )
      throw new Error("Invalid artifact collection");
    const collection = JSON.stringify([owner, definition.name]);
    const prefix = [scope, collection];
    const key = (id: string) => [...prefix, id];
    const range = (parts: IDBValidKey[]) =>
      IDBKeyRange.bound(parts, [...parts, []]);
    let disposed = false;
    const lifetime = new AbortController();
    const listeners = new Set<() => void>();
    const channelName = `${DB}:${JSON.stringify(prefix)}`;
    const channel = new BroadcastChannel(channelName);
    const changed = () => {
      for (const listener of listeners)
        queueMicrotask(() => {
          if (!disposed && listeners.has(listener)) listener();
        });
    };
    channel.onmessage = changed;
    const publish = () => {
      if (!disposed) {
        changed();
        channel.postMessage(null);
      } else {
        const notification = new BroadcastChannel(channelName);
        notification.postMessage(null);
        notification.close();
      }
    };
    function reindex(
      tx: IDBTransaction,
      then: Then,
      row: Row,
      preference: JsonValue | undefined,
      next: () => void,
    ) {
      const entries = tx.objectStore("entries");
      then(
        entries.index("record").getAllKeys(IDBKeyRange.only(key(row.id))),
        (keys) => {
          for (const old of keys) entries.delete(old);
          for (const index of definition.project({
            record: row.record,
            ...(preference !== undefined ? { preference } : {}),
          })) {
            if (
              !index.index ||
              typeof index.value !== "string" ||
              typeof index.order !== "string"
            )
              throw new Error("Invalid artifact index entry");
            entries.put({ ...index, scope, collection, id: row.id });
          }
          next();
        },
      );
    }
    const ready = transact<void>(
      "readwrite",
      STORES,
      (tx, then, done) => {
        const metadata = tx.objectStore("metadata");
        then(metadata.get(key("schema")), (schema) => {
          if (schema?.type && schema.type !== definition.type)
            throw new Error("Artifact collection type changed");
          if (schema?.version === definition.version) {
            done();
            return;
          }
          if (schema?.version > definition.version)
            throw new Error("Artifact collection requires a newer plugin");
          metadata.delete(key("source"));
          metadata.delete(key("refresh"));
          metadata.delete(key("checkpoint"));
          const request = tx.objectStore("records").openCursor(range(prefix));
          then(request, (cursor) => {
            if (!cursor) {
              metadata.put({
                scope,
                collection,
                key: "schema",
                version: definition.version,
                type: definition.type,
              });
              done();
              return;
            }
            then(
              tx.objectStore("preferences").get(key(cursor.value.id)),
              (pref: StoredPreference | undefined) =>
                reindex(tx, then, cursor.value, pref?.value, () =>
                  cursor.continue(),
                ),
            );
          });
        });
      },
      lifetime.signal,
    );
    // Keep an unopened handle's initialization rejection observable by its first operation.
    void ready.catch(() => {});
    async function run<T>(
      mode: IDBTransactionMode,
      stores: string[],
      work: Parameters<typeof transact<T>>[2],
      signal?: AbortSignal,
    ) {
      await ready;
      if (disposed) throw new Error("Artifact collection closed");
      return transact<T>(
        mode,
        stores,
        (tx, then, done) => {
          then(tx.objectStore("metadata").get(key("schema")), (schema) => {
            if (schema?.version !== definition.version)
              throw new Error("Artifact collection version changed");
            work(tx, then, done);
          });
        },
        signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
      );
    }
    function bindSource(
      tx: IDBTransaction,
      then: Then,
      source: string,
      next: () => void,
    ) {
      if (!source) throw new Error("Artifact source is empty");
      const metadata = tx.objectStore("metadata");
      then(metadata.get(key("source")), (saved) => {
        if (saved && saved.value !== source)
          throw new Error("Artifact collection query changed");
        if (!saved)
          metadata.put({ scope, collection, key: "source", value: source });
        next();
      });
    }
    function checkRefresh(
      tx: IDBTransaction,
      then: Then,
      refresh: ArtifactRefresh,
      next: () => void,
    ) {
      bindSource(tx, then, refresh.source, () => {
        then(tx.objectStore("metadata").get(key("refresh")), (saved) => {
          if (!sameRefresh(saved?.value, refresh))
            throw new Error("Artifact refresh changed");
          next();
        });
      });
    }
    function readEntry(
      tx: IDBTransaction,
      then: Then,
      id: string,
      done: (entry: ArtifactEntry | undefined) => void,
    ) {
      then(tx.objectStore("records").get(key(id)), (row: Row | undefined) => {
        if (!row) {
          done(undefined);
          return;
        }
        then(
          tx.objectStore("preferences").get(key(id)),
          (pref: StoredPreference | undefined) =>
            done({
              record: row.record,
              ...(pref ? { preference: pref.value } : {}),
            }),
        );
      });
    }
    function mutate(
      tx: IDBTransaction,
      then: Then,
      id: string,
      change: (
        row: Row,
        preference: JsonValue | undefined,
      ) => { row: Row; preference?: JsonValue },
      next: () => void,
    ) {
      if (!id) throw new Error("Artifact identity is empty");
      then(tx.objectStore("records").get(key(id)), (saved: Row | undefined) => {
        then(
          tx.objectStore("preferences").get(key(id)),
          (pref: StoredPreference | undefined) => {
            // A preference callback can edit its input before it returns.
            const previousPreference = structuredClone(pref?.value);
            const result = change(
              saved ?? {
                record: { id, availability: { state: "unknown" } },
                scope,
                collection,
                id,
              },
              pref?.value,
            );
            const preference =
              result.preference !== undefined ? result.preference : pref?.value;
            if (
              saved &&
              sameStoredValue(saved.record, result.row.record) &&
              sameStoredValue(previousPreference, preference)
            ) {
              next();
              return;
            }
            tx.objectStore("records").put(result.row);
            if (result.preference !== undefined)
              tx.objectStore("preferences").put({
                scope,
                collection,
                id,
                value: result.preference,
              });
            reindex(tx, then, result.row, preference, next);
          },
        );
      });
    }
    function series(items: readonly (() => void)[]) {
      let at = 0;
      return () => {
        items[at++]?.();
      };
    }
    const handle: HostArtifactCollection = {
      scope: Object.freeze({ viewer, relay, partition: scope }),
      get: (id) =>
        run<ArtifactEntry | undefined>(
          "readonly",
          ["metadata", "records", "preferences"],
          (tx, then, done) => readEntry(tx, then, id, done),
        ),
      page(query: ArtifactPageQuery) {
        const limit = query.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
          return Promise.reject(
            new Error("Artifact page limit must be 1 to 1000"),
          );
        return run<ArtifactPage>("readonly", STORES, (tx, then, done) => {
          const pagePrefix = [...prefix, query.index, query.value];
          const lower = query.after
            ? [...pagePrefix, query.after.order, query.after.id]
            : pagePrefix;
          const request = tx
            .objectStore("entries")
            .openCursor(
              IDBKeyRange.bound(lower, [...pagePrefix, []], !!query.after),
            );
          const entries: ArtifactEntry[] = [];
          let last: { order: string; id: string } | undefined;
          then(request, function visit(cursor) {
            if (!cursor || entries.length === limit) {
              done({ entries, ...(cursor && last ? { next: last } : {}) });
              return;
            }
            const { id, order } = cursor.value;
            readEntry(tx, then, id, (entry) => {
              if (!entry) throw new Error("Artifact index has no record");
              entries.push(entry);
              last = { id, order };
              cursor.continue();
            });
          });
        });
      },
      subscribe(listener) {
        if (disposed) throw new Error("Artifact collection closed");
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      preferences: {
        get: (id) =>
          run<JsonValue | undefined>(
            "readonly",
            ["metadata", "preferences"],
            (tx, then, done) =>
              then(
                tx.objectStore("preferences").get(key(id)),
                (pref: StoredPreference | undefined) => done(pref?.value),
              ),
          ),
        async update(id, change) {
          await run<void>("readwrite", STORES, (tx, then, done) =>
            mutate(
              tx,
              then,
              id,
              (row, current) => ({ row, preference: change(current) }),
              () => done(),
            ),
          );
          publish();
        },
      },
      async importBatch(batch: ArtifactImport) {
        await run<void>("readwrite", STORES, (tx, then, done) => {
          const jobs: (() => void)[] = [];
          const next = series(jobs);
          for (const record of batch.records ?? [])
            jobs.push(() =>
              mutate(
                tx,
                then,
                record.id,
                (row) => ({
                  row:
                    row.record.local !== undefined
                      ? row
                      : {
                          ...row,
                          record: { ...row.record, local: record.local },
                        },
                }),
                next,
              ),
            );
          for (const pref of batch.preferences ?? [])
            jobs.push(() =>
              mutate(
                tx,
                then,
                pref.id,
                (row, current) => ({
                  row,
                  preference: current === undefined ? pref.value : current,
                }),
                next,
              ),
            );
          jobs.push(() => {
            if (batch.marker)
              tx.objectStore("metadata").put({
                scope,
                collection,
                key: JSON.stringify(["import", batch.marker]),
                value: true,
              });
            done();
          });
          next();
        });
        publish();
      },
      imported: (marker) =>
        run<boolean>("readonly", ["metadata"], (tx, then, done) =>
          then(
            tx
              .objectStore("metadata")
              .get(key(JSON.stringify(["import", marker]))),
            (row) => done(row?.value === true),
          ),
        ),
      refreshError: () =>
        run<string | null>("readonly", ["metadata"], (tx, then, done) =>
          then(tx.objectStore("metadata").get(key("refresh-error")), (row) =>
            done(row?.value ?? null),
          ),
        ),
      async setRefreshError(refresh, message, signal) {
        if (!message) throw new Error("Artifact refresh error is empty");
        await run<void>(
          "readwrite",
          ["metadata"],
          (tx, then, done) => {
            checkRefresh(tx, then, refresh, () => {
              tx.objectStore("metadata").put({
                scope,
                collection,
                key: "refresh-error",
                value: message,
              });
              done();
            });
          },
          signal,
        );
        publish();
      },
      knownIds(query) {
        const limit = query.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
          return Promise.reject(
            new Error("Artifact page limit must be 1 to 1000"),
          );
        return run<{ ids: string[]; next?: string }>(
          "readonly",
          ["metadata", "records"],
          (tx, then, done) => {
            const records = tx.objectStore("records");
            const parts =
              query.channelId === undefined
                ? prefix
                : [...prefix, query.channelId];
            const lower =
              query.after === undefined ? parts : [...parts, query.after];
            const request = (
              query.channelId === undefined ? records : records.index("channel")
            ).openKeyCursor(
              IDBKeyRange.bound(
                lower,
                [...parts, []],
                query.after !== undefined,
              ),
            );
            const ids: string[] = [];
            then(request, function visit(cursor) {
              if (!cursor || ids.length === limit) {
                const last = ids.at(-1);
                done({
                  ids,
                  ...(cursor && last !== undefined ? { next: last } : {}),
                });
                return;
              }
              ids.push(String((cursor.primaryKey as IDBValidKey[])[2]));
              cursor.continue();
            });
          },
        );
      },
      checkpoint: () =>
        run<string | null>("readonly", ["metadata"], (tx, then, done) =>
          then(tx.objectStore("metadata").get(key("checkpoint")), (row) =>
            done(row?.value ?? null),
          ),
        ),
      beginRefresh(source) {
        if (!source)
          return Promise.reject(new Error("Artifact source is empty"));
        return run<ArtifactRefresh>(
          "readwrite",
          ["metadata"],
          (tx, then, done) => {
            bindSource(tx, then, source, () => {
              const refresh = { source, generation: crypto.randomUUID() };
              tx.objectStore("metadata").put({
                scope,
                collection,
                key: "refresh",
                value: refresh,
              });
              done(refresh);
            });
          },
        );
      },
      async completeRefresh(refresh, checkpoint, signal) {
        await run<void>(
          "readwrite",
          ["metadata"],
          (tx, then, done) => {
            checkRefresh(tx, then, refresh, () => {
              const metadata = tx.objectStore("metadata");
              then(metadata.get(key("checkpoint")), (row) => {
                if ((row?.value ?? null) !== checkpoint.expected)
                  throw new Error("Artifact checkpoint changed");
                metadata.put({
                  scope,
                  collection,
                  key: "checkpoint",
                  value: checkpoint.next,
                });
                metadata.delete(key("refresh"));
                metadata.delete(key("refresh-error"));
                done();
              });
            });
          },
          signal,
        );
        publish();
      },
      async applyBatch(batch: ArtifactBatch, signal) {
        await run<void>(
          "readwrite",
          STORES,
          (tx, then, done) => {
            const jobs: (() => void)[] = [];
            const next = series(jobs);
            if (!batch.refresh || batch.source !== batch.refresh.source)
              throw new Error("Artifact refresh source mismatch");
            jobs.push(() => checkRefresh(tx, then, batch.refresh, next));
            for (const incoming of batch.records ?? [])
              jobs.push(() =>
                mutate(
                  tx,
                  then,
                  incoming.id,
                  (row) => {
                    if (incoming.type !== definition.type)
                      throw new Error(
                        "Artifact type does not match collection",
                      );
                    if (
                      !incoming.channelId ||
                      !incoming.revision.id ||
                      typeof incoming.revision.content !== "string"
                    )
                      throw new Error("Invalid authoritative artifact");
                    return {
                      row: {
                        scope,
                        collection,
                        id: incoming.id,
                        record: {
                          id: incoming.id,
                          channelId: incoming.channelId,
                          type: incoming.type,
                          current: incoming.revision,
                          availability: row.record.availability,
                          ...(row.record.local !== undefined
                            ? { local: row.record.local }
                            : {}),
                        },
                      },
                    };
                  },
                  next,
                ),
              );
            for (const availability of batch.availability ?? [])
              jobs.push(() =>
                mutate(
                  tx,
                  then,
                  availability.id,
                  (row) => {
                    if (
                      (row.record.current?.id ?? null) !==
                      availability.expectedRevision
                    )
                      throw new Error("Artifact revision changed");
                    return {
                      row: {
                        ...row,
                        record: {
                          ...row.record,
                          availability: availability.value,
                        },
                      },
                    };
                  },
                  next,
                ),
              );
            jobs.push(() => done());
            next();
          },
          signal,
        );
        publish();
      },
      close() {
        lifetime.abort(new Error("Artifact collection closed"));
        disposed = true;
        listeners.clear();
        channel.close();
        collections.delete(handle);
      },
    };
    collections.add(handle);
    return handle;
  }
  return {
    collection,
    async clear() {
      const affected = new Set<string>();
      await transact<void>("readwrite", STORES, (tx, then, done) => {
        let pending = STORES.length;
        for (const name of STORES) {
          const request = tx
            .objectStore(name)
            .openCursor(IDBKeyRange.bound([scope], [scope, []]));
          then(request, function visit(cursor) {
            if (!cursor) {
              if (--pending === 0) done();
              return;
            }
            affected.add(cursor.value.collection);
            cursor.delete();
            cursor.continue();
          });
        }
      });
      for (const collection of affected) {
        const channel = new BroadcastChannel(
          `${DB}:${JSON.stringify([scope, collection])}`,
        );
        channel.postMessage(null);
        channel.close();
      }
    },
    close() {
      closed = true;
      for (const handle of collections) handle.close();
      void opening?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
export type ArtifactStore = ReturnType<typeof createArtifactStore>;

export async function purgeArtifactStorage(viewer: string, relay: string) {
  if (typeof indexedDB === "undefined") return;
  const store = createArtifactStore(viewer, relay);
  try {
    await store.clear();
  } finally {
    store.close();
  }
}
