import type { OutboxStorage, OutgoingEvent } from "./outbox";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-outbox-v2", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("partitions"))
        db.createObjectStore("partitions");
      if (!db.objectStoreNames.contains("events"))
        db.createObjectStore("events", {
          keyPath: ["scope", "id"],
        }).createIndex("scope", "scope");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Buzz windows to upgrade the outbox"));
  });
}

/** Drops one partition's journal, including its legacy record, after that
 * community's session is disposed: nothing left there can still be delivered. */
export async function purgeOutboxStorage(scope: string) {
  localStorage.removeItem(`buzz-outbox-v1:${scope}`);
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["events", "partitions"], "readwrite", {
        durability: "strict",
      });
      const events = tx.objectStore("events");
      const keys = events.index("scope").getAllKeys(IDBKeyRange.only(scope));
      keys.onsuccess = () => {
        for (const key of keys.result) events.delete(key);
      };
      tx.objectStore("partitions").delete(scope);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Outbox purge aborted"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Incremental asynchronous journal, atomically partitioned by relay and viewer. */
export function browserOutboxStorage(scope: string): OutboxStorage {
  let database: Promise<IDBDatabase> | undefined;
  let persisted = new Map<string, OutgoingEvent>();
  let legacyIds = new Set<string>();
  let ownershipRevision = 0;
  const forgotten = new Map<string, number>();
  const open = () => (database ??= openDatabase());
  return {
    async lock(id, run) {
      if (!navigator.locks) throw new Error("Window ownership is unavailable.");
      return navigator.locks.request(`buzz-outbox:${scope}:${id}`, run);
    },
    forget(id) {
      forgotten.set(id, ++ownershipRevision);
      persisted.delete(id);
      legacyIds.delete(id);
    },
    async load(options) {
      const db = await open();
      let migrated = false;
      const records = await new Promise<readonly OutgoingEvent[]>(
        (resolve, reject) => {
          const tx = db.transaction(["events", "partitions"]);
          const entries = tx
            .objectStore("events")
            .index("scope")
            .getAll(IDBKeyRange.only(scope));
          const legacy = tx.objectStore("partitions").get(scope);
          tx.oncomplete = () => {
            try {
              migrated = legacy.result === true;
              const values = entries.result.map(
                (entry: { operation: OutgoingEvent }) => entry.operation,
              );
              // The marker distinguishes a migrated empty journal from an un-migrated one.
              resolve(
                values.length || legacy.result === true
                  ? values
                  : (legacy.result ??
                      JSON.parse(
                        localStorage.getItem(`buzz-outbox-v1:${scope}`) ?? "[]",
                      )),
              );
            } catch (error) {
              reject(error);
            }
          };
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        },
      );
      // A first save migrates legacy records into the per-event store.
      if (!options?.readOnly) {
        persisted = migrated
          ? new Map(records.map((item) => [item.event.id, item]))
          : new Map();
        legacyIds = new Set(
          migrated ? [] : records.map((item) => item.event.id),
        );
      }
      return records;
    },
    async save(operations, options) {
      const revision = ownershipRevision;
      const db = await open();
      const next = new Map(operations.map((item) => [item.event.id, item]));
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["events", "partitions"], "readwrite", {
          durability: "strict",
        });
        const events = tx.objectStore("events");
        const partitions = tx.objectStore("partitions");
        const migration = legacyIds.size ? partitions.get(scope) : undefined;
        for (const [id, operation] of next) {
          const old = persisted.get(id);
          if (
            id !== options?.force &&
            old &&
            old.delivery === operation.delivery &&
            old.error === operation.error &&
            old.refused === operation.refused &&
            old.acknowledged === operation.acknowledged &&
            old.signed?.id === operation.signed?.id &&
            old.recovery?.key === operation.recovery?.key &&
            old.recovery?.value === operation.recovery?.value &&
            old.guarded === operation.guarded
          )
            continue;
          if (id === options?.force || (!old && !legacyIds.has(id))) {
            events.put({ scope, id, operation });
          } else {
            // Another window may have removed this row. Check in the same
            // transaction as the update, including while migrating legacy rows.
            const key = events.getKey([scope, id]);
            key.onsuccess = () => {
              if (
                key.result !== undefined ||
                (!old && migration?.result !== true)
              )
                events.put({ scope, id, operation });
            };
          }
        }
        for (const id of persisted.keys())
          if (!next.has(id)) events.delete([scope, id]);
        for (const id of legacyIds)
          if (!next.has(id)) events.delete([scope, id]);
        partitions.put(true, scope);
        tx.oncomplete = () => {
          // A read can relinquish an ID while this transaction is pending.
          // Do not let completion reclaim deletion ownership of that ID.
          persisted = new Map(
            [...next].filter(([id]) => (forgotten.get(id) ?? 0) <= revision),
          );
          legacyIds.clear();
          resolve();
        };
        tx.onabort = () =>
          reject(tx.error ?? new Error("Outbox transaction aborted"));
        tx.onerror = () => reject(tx.error);
      });
    },
    close() {
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
