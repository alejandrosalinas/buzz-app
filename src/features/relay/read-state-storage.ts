import { eventDto, type RelayEvent } from "./events";
import {
  EMPTY_READ_STATE,
  contextId,
  parseReadBlob,
  readCoordinate,
  READ_STATE_SLOTS,
  record,
  slotId,
  uint32,
  type ReadState,
} from "./read-state-model";

import {
  markMessage,
  READ_RESERVE_BYTES,
  READ_RESERVE_KEYS,
} from "./read-state-retention";

export type ReadJournal = Readonly<{
  version: 1;
  slot: string;
  clientId: string;
  state: ReadState;
  /** Explicitly local-only intent; the counter fences older reading handles. */
  localUnread: Readonly<Record<string, number>>;
  /** Local interaction order, bounded with retained frontier hints. */
  recent?: Readonly<Record<string, number>>;
  /** Local-only evicted receipts, deleted with this partition even by old builds. */
  reserve?: Readonly<Record<string, number>>;
  /** Local-only: every message at or before this time counts as read here.
   * Raised to the time of the newest mark that the reserve had no room for. */
  floor?: number;
  /** Local-only: the channel of each message that a kept mark names (see
   * `markMessage`), taken from a signed event. A mark does not carry its
   * channel, so this lets a channel mark cover it while the message is not
   * loaded. */
  homes?: Readonly<Record<string, string>>;
  /** The frontiers this installation advanced: all it publishes, never a
   * peer's value. Message marks stay local (frontier-only sync). */
  own?: Readonly<Record<string, number>>;
  /** Further slots this installation owns after `slot`, in placement order. */
  spill?: readonly string[];
  revision: number;
  /** Saves among `revision` that read nothing (row `seen:` marks), from any
   * window, so unread intent is `revision - quiet`. */
  quiet?: number;
  acceptedRevision: number;
  lastCreatedAt: number;
  pending?: Readonly<{ event: RelayEvent; revision: number }>;
}>;
/** Mutations run against the latest record in one strict transaction (including other tabs). */
export interface ReadStateStorage {
  update(
    change: (current: ReadJournal | undefined) => ReadJournal,
  ): Promise<ReadJournal>;
  /** The latest saved record, read without writing; undefined before first use. */
  read?(): Promise<ReadJournal | undefined>;
  close(): void;
}
export const newSlotId = () => crypto.randomUUID().replaceAll("-", "");
export function newReadJournal(): ReadJournal {
  return {
    version: 1,
    slot: newSlotId(),
    clientId: crypto.randomUUID(),
    state: EMPTY_READ_STATE,
    localUnread: {},
    revision: 0,
    acceptedRevision: 0,
    lastCreatedAt: 0,
  };
}
/** Storage is untrusted. Corrupt intent is an error, never an empty journal to overwrite. */
export function readJournal(raw: unknown, viewer: string): ReadJournal {
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !slotId(raw.slot) ||
    typeof raw.clientId !== "string" ||
    !record(raw.state) ||
    !record(raw.state.frontiers) ||
    !record(raw.state.overrides) ||
    !record(raw.localUnread) ||
    !uint32(raw.lastCreatedAt) ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    !Number.isSafeInteger(raw.acceptedRevision) ||
    (raw.acceptedRevision as number) < 0 ||
    (raw.acceptedRevision as number) > (raw.revision as number) ||
    (raw.quiet !== undefined &&
      (!Number.isSafeInteger(raw.quiet) ||
        (raw.quiet as number) < 0 ||
        (raw.quiet as number) > (raw.revision as number)))
  )
    throw new Error("Invalid saved read state");
  const contexts: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw.state.frontiers).map(([key, value]) => [
      /^(ov_|esc:)/.test(key) ? `esc:${key}` : key,
      value,
    ]),
  );
  for (const [key, value] of Object.entries(raw.state.overrides)) {
    if (
      !record(value) ||
      !uint32(value.set) ||
      !uint32(value.clear) ||
      !uint32(value.baseline)
    )
      throw new Error("Invalid saved read override");
    contexts[`ov_s:${key}`] = value.set;
    contexts[`ov_c:${key}`] = value.clear;
    contexts[`ov_b:${key}`] = value.baseline;
  }
  const parsed = parseReadBlob({ v: 1, client_id: raw.clientId, contexts });
  if (
    Object.keys(parsed.state.frontiers).length !==
      Object.keys(raw.state.frontiers).length ||
    Object.keys(parsed.state.overrides).length !==
      Object.keys(raw.state.overrides).length ||
    Object.keys(raw.localUnread).length > 10000 ||
    !Object.values(raw.localUnread).every(
      (v) =>
        Number.isSafeInteger(v) &&
        (v as number) > 0 &&
        (v as number) <= (raw.revision as number),
    )
  )
    throw new Error("Invalid saved read entries");
  if (
    raw.recent !== undefined &&
    (!record(raw.recent) ||
      Object.keys(raw.recent).length > 10000 ||
      !Object.entries(raw.recent).every(
        ([key, value]) =>
          Object.hasOwn(parsed.state.frontiers, key) &&
          Number.isSafeInteger(value) &&
          (value as number) > 0 &&
          (value as number) <= (raw.revision as number),
      ))
  )
    throw new Error("Invalid saved read interaction order");
  if (
    raw.reserve !== undefined &&
    (!record(raw.reserve) ||
      Object.keys(raw.reserve).length > READ_RESERVE_KEYS ||
      new TextEncoder().encode(JSON.stringify(raw.reserve)).byteLength >
        READ_RESERVE_BYTES ||
      !Object.entries(raw.reserve).every(
        ([key, value]) =>
          contextId(key) &&
          uint32(value) &&
          !Object.hasOwn(parsed.state.frontiers, key),
      ))
  )
    throw new Error("Invalid saved read reserve");
  if (
    raw.homes !== undefined &&
    (!record(raw.homes) ||
      !Object.entries(raw.homes).every(
        ([id, channel]) => contextId(id) && contextId(channel),
      ))
  )
    throw new Error("Invalid saved read mark channels");
  if (
    raw.own !== undefined &&
    (!record(raw.own) ||
      !Object.entries(raw.own).every(
        ([key, value]) => contextId(key) && uint32(value),
      ))
  )
    throw new Error("Invalid saved own read state");
  if (raw.floor !== undefined && !uint32(raw.floor))
    throw new Error("Invalid saved read floor");
  const spill = raw.spill ?? [];
  if (
    !Array.isArray(spill) ||
    spill.length >= READ_STATE_SLOTS ||
    !spill.every(slotId) ||
    new Set([raw.slot, ...spill]).size !== spill.length + 1
  )
    throw new Error("Invalid saved read slots");
  // Before own values were kept apart, the journal published everything it held.
  const own =
    (raw.own as Record<string, number> | undefined) ??
    Object.fromEntries(
      Object.entries(parsed.state.frontiers).filter(
        ([key]) => !key.startsWith("msg:"),
      ),
    );
  // Keep only the channels of messages that a kept mark still names.
  const named = new Set(
    [
      ...Object.keys(parsed.state.frontiers),
      ...Object.keys((raw.reserve as Record<string, number>) ?? {}),
    ].flatMap((key) => markMessage(key) ?? []),
  );
  const homes = Object.fromEntries(
    Object.entries((raw.homes as Record<string, string>) ?? {}).filter(([id]) =>
      named.has(id),
    ),
  );
  let pending: ReadJournal["pending"];
  if (raw.pending !== undefined) {
    if (
      !record(raw.pending) ||
      !Number.isSafeInteger(raw.pending.revision) ||
      (raw.pending.revision as number) < 0 ||
      (raw.pending.revision as number) > (raw.revision as number)
    )
      throw new Error("Invalid saved read operation");
    const event = eventDto(raw.pending.event);
    if (
      event.pubkey !== viewer ||
      ![raw.slot, ...spill].some(
        (slot) => readCoordinate(event) === `read-state:${slot}`,
      ) ||
      event.created_at > raw.lastCreatedAt
    )
      throw new Error("Saved read operation identity mismatch");
    pending = { event, revision: raw.pending.revision as number };
  }
  return {
    version: 1,
    slot: raw.slot,
    clientId: raw.clientId,
    state: parsed.state,
    localUnread: Object.freeze({ ...raw.localUnread }) as Readonly<
      Record<string, number>
    >,
    recent: Object.freeze({
      ...(raw.recent as Record<string, number> | undefined),
    }),
    reserve: Object.freeze({
      ...(raw.reserve as Record<string, number> | undefined),
    }),
    homes: Object.freeze(homes),
    ...(raw.floor ? { floor: raw.floor } : {}),
    own: Object.freeze({ ...own }),
    spill: Object.freeze([...(spill as string[])]),
    revision: raw.revision as number,
    ...(raw.quiet !== undefined && { quiet: raw.quiet as number }),
    acceptedRevision: raw.acceptedRevision as number,
    lastCreatedAt: raw.lastCreatedAt,
    ...(pending ? { pending } : {}),
  };
}
function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-read-state-v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("partitions");
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Buzz windows to open read state"));
  });
}
/** Forgets one partition's journal after its session is disposed, so a left
 * community's read markers do not outlive the membership on this device. */
export async function purgeReadStateStorage(scope: string) {
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("partitions", "readwrite", {
        durability: "strict",
      });
      tx.objectStore("partitions").delete(scope);
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new Error("Read-state purge aborted"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export function browserReadStateStorage(
  scope: string,
  viewer: string,
): ReadStateStorage {
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  // The record this handle last wrote, already validated, under a random
  // token saved with it. Another window or build writes without the token,
  // so finding it again proves the stored record is this one.
  let written: { token: string; journal: ReadJournal } | undefined;
  function open() {
    if (closed) return Promise.reject(new Error("Read-state storage closed"));
    database ??= openDatabase();
    return database;
  }
  return {
    async update(change) {
      const db = await open();
      if (closed) throw new Error("Read-state storage closed");
      return new Promise((resolve, reject) => {
        const tx = db.transaction("partitions", "readwrite", {
          durability: "strict",
        });
        const store = tx.objectStore("partitions");
        const request = store.get(scope);
        let result: ReadJournal;
        let error: unknown;
        request.onsuccess = () => {
          try {
            const stored: unknown = request.result;
            const current =
              stored === undefined
                ? undefined
                : written && record(stored) && stored.written === written.token
                  ? written.journal
                  : readJournal(stored, viewer);
            result = readJournal(change(current), viewer);
            const token = crypto.randomUUID();
            store.put({ ...result, written: token }, scope);
            written = { token, journal: result };
          } catch (cause) {
            error = cause;
            tx.abort();
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => {
          written = undefined;
          reject(error ?? tx.error ?? new Error("Read-state save aborted"));
        };
        tx.onerror = () => reject(tx.error);
      });
    },
    async read() {
      const db = await open();
      if (closed) throw new Error("Read-state storage closed");
      return new Promise((resolve, reject) => {
        const request = db
          .transaction("partitions", "readonly")
          .objectStore("partitions")
          .get(scope);
        request.onsuccess = () => {
          try {
            resolve(
              request.result === undefined
                ? undefined
                : readJournal(request.result, viewer),
            );
          } catch (error) {
            reject(error);
          }
        };
        request.onerror = () => reject(request.error);
      });
    },
    close() {
      closed = true;
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
