import { eventDto, type RelayEvent } from "./events";
import { parseStoredFollows, type StoredFollows } from "./follow-manager";
import {
  EMPTY_READ_STATE,
  channelContext,
  contextId,
  READ_STATE_KEYS,
  parseReadBlob,
  readCoordinate,
  READ_STATE_SLOTS,
  record,
  slotId,
  uint32,
  unreadCoordinate,
  type ReadState,
} from "./read-state-model";

import {
  markMessage,
  READ_RESERVE_BYTES,
  READ_RESERVE_KEYS,
} from "./read-state-retention";

export const READ_LOCAL_UNREAD_KEYS = 10_000;

export type ReadJournal = Readonly<{
  version: 1;
  slot: string;
  clientId: string;
  state: ReadState;
  /** Explicitly local-only intent; the counter fences older reading handles. */
  localUnread: Readonly<Record<string, number>>;
  /** What covered each local message or thread unread when it was marked:
   * [its `localUnread` revision, the covering read mark, channel, root ("" for
   * none, `UNRESOLVED_ROOT` while unknown)]. A later advance past it ends the mark, after a reload too. */
  localCovers?: Readonly<Record<string, LocalCover>> | undefined;
  /** Local-only last change revision per unread key; reset with the undo epoch. */
  localUnreadIntent?: Readonly<Record<string, number>>;
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
  /** Local captured-Undo epoch; rotates on startup or intent-history retention. */
  capturedReadUndo?: string;
  /** Message keys held by in-session captured Undo actions. */
  capturedUndoVersions?: Readonly<Record<string, string>>;
  revision: number;
  /** Saves among `revision` that read nothing (row `seen:` marks), from any
   * window, so unread intent is `revision - quiet`. */
  quiet?: number;
  acceptedRevision: number;
  lastCreatedAt: number;
  pending?: Readonly<{ event: RelayEvent; revision: number }>;
  /** Synced thread follow choices, saved in these same transactions. */
  follows?: StoredFollows;
  /** Expiring unread (version 2). Absent on a journal saved before it: its
   * version-1 override groups are never imported. */
  unread?: UnreadJournal;
}>;
/** One held-back incoming contribution: [S, C, B, F], F its paired frontier
 * (or this device's, if greater) at the time it was held. Never admitted, so
 * it gets the incoming cutoff, not the local discard guard, when it resolves. */
export type LocalCover = readonly [number, number, string, string];
/** A cover's root while the message's thread is not yet known: not "none". */
export const UNRESOLVED_ROOT = "?";
export type HeldGroup = readonly [number, number, number, number];
export type UnreadJournal = Readonly<{
  /** This installation's one version-2 coordinate. */
  slot: string;
  /** The greatest expiry clock any successful save used: a clock rollback
   * never makes an expired mark live again. */
  watermark: number;
  held: Readonly<Record<string, readonly HeldGroup[]>>;
  /** A clock or held refusal's warning, kept across reloads. The clear
   * itself is not retried; the user reads again. */
  blockedClear?: string;
  /** The channels whose clears it refused: it clears once each has had a
   * successful clear or its group is no longer active. */
  blockedKeys?: readonly string[];
  /** Channels whose clears capacity refused, which a fitting publication
   * also resolves. */
  capacityKeys?: readonly string[];
}>;
export const HELD_GROUPS_PER_KEY = 8;
export const newUnreadJournal = (): UnreadJournal => ({
  slot: newSlotId(),
  watermark: 0,
  held: {},
});
/** Mutations run against the latest record in one strict transaction (including other tabs). */
export interface ReadStateStorage {
  update(
    change: (current: ReadJournal | undefined) => ReadJournal,
  ): Promise<ReadJournal>;
  /** The latest saved record, read without writing; undefined before first use. */
  read?(): Promise<ReadJournal | undefined>;
  /** Reserves a journal snapshot synchronously, before later transactions, on
   * an initialized connection. Rejects rather than deferring that reservation. */
  capture(): Promise<ReadJournal | undefined>;
  close(): void;
}
export const newSlotId = () => crypto.randomUUID().replaceAll("-", "");
export const newReadUndoEpochId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
export function newReadJournal(): ReadJournal {
  return {
    version: 1,
    slot: newSlotId(),
    clientId: crypto.randomUUID(),
    state: EMPTY_READ_STATE,
    localUnread: {},
    localUnreadIntent: {},
    revision: 0,
    acceptedRevision: 0,
    lastCreatedAt: 0,
    unread: newUnreadJournal(),
  };
}
function readUnread(raw: unknown, slots: readonly string[]): UnreadJournal {
  if (
    !record(raw) ||
    !slotId(raw.slot) ||
    slots.includes(raw.slot) ||
    !uint32(raw.watermark) ||
    !record(raw.held) ||
    Object.keys(raw.held).length > READ_STATE_KEYS / 3 ||
    (raw.blockedClear !== undefined &&
      (typeof raw.blockedClear !== "string" ||
        raw.blockedClear.length > 200)) ||
    (raw.blockedKeys !== undefined &&
      (raw.blockedClear === undefined ||
        !Array.isArray(raw.blockedKeys) ||
        raw.blockedKeys.length > READ_STATE_KEYS / 3 ||
        !raw.blockedKeys.every(channelContext))) ||
    (raw.capacityKeys !== undefined &&
      (!Array.isArray(raw.capacityKeys) ||
        raw.capacityKeys.length > READ_STATE_KEYS / 3 ||
        !raw.capacityKeys.every(channelContext)))
  )
    throw new Error("Invalid saved unread state");
  const held: Record<string, readonly HeldGroup[]> = {};
  for (const [key, groups] of Object.entries(raw.held)) {
    if (
      !channelContext(key) ||
      !Array.isArray(groups) ||
      groups.length < 1 ||
      groups.length > HELD_GROUPS_PER_KEY ||
      !groups.every(
        (group) =>
          Array.isArray(group) && group.length === 4 && group.every(uint32),
      )
    )
      throw new Error("Invalid saved held unread group");
    held[key] = Object.freeze(
      groups.map((group) => Object.freeze([...group]) as unknown as HeldGroup),
    );
  }
  return Object.freeze({
    slot: raw.slot,
    watermark: raw.watermark,
    held: Object.freeze(held),
    ...(raw.blockedClear === undefined
      ? {}
      : { blockedClear: raw.blockedClear as string }),
    ...(raw.blockedKeys === undefined
      ? {}
      : { blockedKeys: Object.freeze([...(raw.blockedKeys as string[])]) }),
    ...(raw.capacityKeys === undefined
      ? {}
      : { capacityKeys: Object.freeze([...(raw.capacityKeys as string[])]) }),
  });
}
/** Keeps only the covers of marks still saved at the same revision. */
function readLocalCovers(
  raw: unknown,
  localUnread: Readonly<Record<string, number>>,
): Readonly<Record<string, LocalCover>> {
  if (!record(raw) || Object.keys(raw).length > 10000)
    throw new Error("Invalid saved local unread covers");
  const covers: Record<string, LocalCover> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !Number.isSafeInteger(value[0]) ||
      !Number.isSafeInteger(value[1]) ||
      (value[1] as number) < -1 ||
      typeof value[2] !== "string" ||
      typeof value[3] !== "string"
    )
      throw new Error("Invalid saved local unread covers");
    if (localUnread[key] === value[0])
      covers[key] = Object.freeze([...value]) as unknown as LocalCover;
  }
  return Object.freeze(covers);
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
    (raw.capturedReadUndo !== undefined && !slotId(raw.capturedReadUndo)) ||
    (raw.capturedUndoVersions !== undefined &&
      (!record(raw.capturedUndoVersions) ||
        Object.keys(raw.capturedUndoVersions).length > READ_LOCAL_UNREAD_KEYS ||
        !Object.entries(raw.capturedUndoVersions).every(
          ([key, action]) =>
            contextId(key) && key.startsWith("msg:") && slotId(action),
        ))) ||
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
  const parsed = parseReadBlob(
    { v: 2, client_id: raw.clientId, contexts },
    true,
  );
  if (
    Object.keys(parsed.state.frontiers).length !==
      Object.keys(raw.state.frontiers).length ||
    Object.keys(parsed.state.overrides).length !==
      Object.keys(raw.state.overrides).length ||
    Object.keys(raw.localUnread).length > READ_LOCAL_UNREAD_KEYS ||
    !Object.values(raw.localUnread).every(
      (v) =>
        Number.isSafeInteger(v) &&
        (v as number) > 0 &&
        (v as number) <= (raw.revision as number),
    )
  )
    throw new Error("Invalid saved read entries");
  if (
    raw.localUnreadIntent !== undefined &&
    (!record(raw.localUnreadIntent) ||
      Object.keys(raw.localUnreadIntent).length > READ_LOCAL_UNREAD_KEYS ||
      !Object.values(raw.localUnreadIntent).every(
        (value) =>
          Number.isSafeInteger(value) &&
          (value as number) > 0 &&
          (value as number) <= (raw.revision as number),
      ))
  )
    throw new Error("Invalid saved read intent revisions");
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
  // A malformed saved unread record is corrupt intent: an error, like the rest.
  let unread: UnreadJournal | undefined;
  let fresh = true;
  if (raw.unread !== undefined) {
    unread = readUnread(raw.unread, [raw.slot, ...(spill as string[])]);
    fresh = false;
  }
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
    // A fresh unread record drops the envelope its discarded slot was sending.
    if (fresh && unreadCoordinate(event)) {
      if (event.pubkey !== viewer || event.created_at > raw.lastCreatedAt)
        throw new Error("Saved read operation identity mismatch");
    } else if (
      event.pubkey !== viewer ||
      ![
        ...[raw.slot, ...spill].map((slot) => `read-state:${slot}`),
        ...(unread ? [`read-state-unread-v2:${unread.slot}`] : []),
      ].includes(readCoordinate(event) ?? "") ||
      event.created_at > raw.lastCreatedAt
    )
      throw new Error("Saved read operation identity mismatch");
    else pending = { event, revision: raw.pending.revision as number };
  }
  return {
    version: 1,
    slot: raw.slot,
    clientId: raw.clientId,
    // A journal from before version 2 holds only version-1 marks: not imported.
    state: unread
      ? parsed.state
      : Object.freeze({ frontiers: parsed.state.frontiers, overrides: {} }),
    localUnread: Object.freeze({ ...raw.localUnread }) as Readonly<
      Record<string, number>
    >,
    ...(raw.localCovers !== undefined && {
      localCovers: readLocalCovers(
        raw.localCovers,
        raw.localUnread as Record<string, number>,
      ),
    }),
    ...(raw.localUnreadIntent !== undefined && {
      localUnreadIntent: Object.freeze({
        ...(raw.localUnreadIntent as Record<string, number>),
      }),
    }),
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
    ...(raw.capturedReadUndo !== undefined && {
      capturedReadUndo: raw.capturedReadUndo as string,
    }),
    ...(raw.capturedUndoVersions !== undefined && {
      capturedUndoVersions: Object.freeze({
        ...(raw.capturedUndoVersions as Record<string, string>),
      }),
    }),
    revision: raw.revision as number,
    ...(raw.quiet !== undefined && { quiet: raw.quiet as number }),
    acceptedRevision: raw.acceptedRevision as number,
    lastCreatedAt: raw.lastCreatedAt,
    ...(pending ? { pending } : {}),
    ...(raw.follows !== undefined && {
      follows: parseStoredFollows(raw.follows, viewer),
    }),
    unread: unread ?? newUnreadJournal(),
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
  let connection: IDBDatabase | undefined;
  let closed = false;
  // The record this handle last wrote, already validated, under a random
  // token saved with it. Another window or build writes without the token,
  // so finding it again proves the stored record is this one.
  let written: { token: string; journal: ReadJournal } | undefined;
  function open() {
    if (closed) return Promise.reject(new Error("Read-state storage closed"));
    database ??= openDatabase().then((db) => {
      connection = db;
      return db;
    });
    return database;
  }
  function readFrom(db: IDBDatabase): Promise<ReadJournal | undefined> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("partitions", "readonly");
      const request = tx.objectStore("partitions").get(scope);
      let result: ReadJournal | undefined;
      let error: unknown;
      request.onsuccess = () => {
        try {
          result =
            request.result === undefined
              ? undefined
              : readJournal(request.result, viewer);
        } catch (cause) {
          error = cause;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(error ?? tx.error ?? new Error("Read-state load aborted"));
      tx.onerror = () => reject(tx.error);
    });
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
      return readFrom(db);
    },
    capture() {
      return connection && !closed
        ? readFrom(connection)
        : Promise.reject(new Error("Read-state storage not ready"));
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
