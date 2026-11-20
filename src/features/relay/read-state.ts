import { newer, type RelayEvent } from "./events";
import {
  markMessage,
  retainLocalRead,
  type CoveredFrontier,
} from "./read-state-retention";
import {
  READ_SNAPSHOT_BYTES,
  READ_SNAPSHOT_EVENTS,
  ReadStateTimestampRejected,
  type ReadStateHost,
} from "./read-state-host";
import {
  effectiveFrontier,
  EMPTY_READ_STATE,
  mergeReadStates,
  packReadState,
  parseReadBlob,
  readBlob,
  readCoordinate,
  unreadActive,
  unreadBlob,
  unreadGroups,
  unreadReceive,
  unreadStamp,
  unreadCoordinate as unreadCoordinateOf,
  UNREAD_DEFER_AHEAD,
  UNREAD_LIFETIME,
  UNREAD_TAG,
  readVersion,
  READ_RETENTION_SECONDS,
  READ_STATE_SLOTS,
  contextId,
  channelContext,
  channelGroups,
  uint32,
  type ReadBlob,
  type ReadState,
  type ParsedReadBlob,
} from "./read-state-model";
import {
  HELD_GROUPS_PER_KEY,
  newReadJournal,
  readJournal,
  newReadUndoEpochId,
  newSlotId,
  newUnreadJournal,
  UNRESOLVED_ROOT,
  type HeldGroup,
  type LocalCover,
  READ_LOCAL_UNREAD_KEYS,
  type ReadJournal,
  type ReadStateStorage,
  type UnreadJournal,
} from "./read-state-storage";
import {
  LARGE_READ_DEADLINE_MS,
  type Priority,
  type RelayReader,
} from "./reader";

export type ReadSyncSnapshot = Readonly<{
  capability: "unsupported" | "read-only" | "frontier-sync";
  status:
    | "loading"
    | "local"
    | "pending"
    | "accepted"
    | "reconciled"
    | "stale"
    | "error";
  /** Atomic marker enumeration only; says nothing about completeness of message history. */
  completeness: "unknown" | "snapshot" | "bounded";
  error?: string | undefined;
}>;
export type ReadMutationResult = Readonly<{
  operationId: string;
  durability: "saved";
  sync: "pending" | "local-only";
  /** Conditional device-local inverse; coverage depends on `undoScope`.
   * Untagged handles may restore saved reminders only. Later overlapping
   * intent or lost operation validity can expire the handle. */
  undo?: () => Promise<ReadMutationResult>;
  /** With `undo`, identifies exact captured-action receipt, reminder and
   * visit-overlay restoration. Absent on legacy saved-marker-only handles. */
  undoScope?: "captured-action";
}>;
export type ReadPublisherLock = (
  signal: AbortSignal,
  work: () => Promise<void>,
) => Promise<void>;
export function browserReadPublisherLock(
  scope: string,
): ReadPublisherLock | undefined {
  if (typeof navigator === "undefined" || !navigator.locks) return;
  return (signal, work) =>
    navigator.locks.request(
      `buzz-read-state:${scope}`,
      { mode: "exclusive", signal },
      work,
    );
}
const encoder = new TextEncoder();
const encodedBytes = (event: RelayEvent) =>
  encoder.encode(JSON.stringify(event)).byteLength;
const dTag = (event: RelayEvent) =>
  event.tags.find(([name]) => name === "d")?.[1] ?? "";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Read state unavailable";
const UNREAD_HELD =
  "Unread state from another device is ahead of this clock; marks wait for it";
const UNREAD_STALE = "Unread state changed while publishing; retrying";
const UNREAD_CLOCK = "Unread state is ahead of this clock; try again shortly";
const UNREAD_CAPACITY = "Channel mark read cannot be synchronized";
/** The reader left before the save ran: the caller's intent, not sync health. */
class ObservationExpired extends Error {
  constructor() {
    super("Reading observation expired");
  }
}
export class CapturedReadWouldWidenError extends Error {
  constructor() {
    super("Exact captured read would widen the retained read set");
    this.name = "CapturedReadWouldWidenError";
  }
}
export class CapturedReadNotRetainedError extends Error {
  constructor() {
    super("Exact captured read could not retain every selected message");
    this.name = "CapturedReadNotRetainedError";
  }
}
const withBlockedClear = (
  unread: UnreadJournal,
  error?: string,
  keys: readonly string[] = [],
  capacity: readonly string[] = [],
): UnreadJournal => {
  const {
    blockedClear: _,
    blockedKeys: __,
    capacityKeys: ___,
    ...rest
  } = unread;
  return {
    ...rest,
    ...(error !== undefined && { blockedClear: error }),
    ...(error !== undefined && keys.length > 0 && { blockedKeys: keys }),
    ...(capacity.length > 0 && { capacityKeys: capacity }),
  };
};
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.entries(a),
    right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.hasOwn(b, key) &&
        same(value, (b as Record<string, unknown>)[key]),
    )
  );
};
/** The expiry clock: a clock rollback never revives a mark a save expired. */
const unreadClock = (journal: ReadJournal, now: number) =>
  Math.max(now, journal.unread?.watermark ?? 0);
/** Reserve and journal are disjoint; only own values are published. Unread
 * groups are shown expired and canonical at the expiry clock, so display
 * never waits for a save. */
/** The covers of marks still saved at the revision they were saved with. */
const keptCovers = (
  covers: Readonly<Record<string, LocalCover>>,
  localUnread: Readonly<Record<string, number>>,
) => {
  const kept = Object.entries(covers).filter(
    ([key, [revision]]) => localUnread[key] === revision,
  );
  return kept.length ? Object.fromEntries(kept) : undefined;
};
/** A mark's saved cover, if it is the one saved with the mark's revision. */
const coverOf = (journal: ReadJournal, key: string) => {
  const cover = journal.localCovers?.[key];
  return cover && journal.localUnread[key] === cover[0] ? cover : undefined;
};
type CapturedValue<T> =
  | Readonly<{ present: false }>
  | Readonly<{ present: true; value: T }>;
type CapturedMapChanges<T> = Readonly<
  Record<
    string,
    Readonly<{ before: CapturedValue<T>; after: CapturedValue<T> }>
  >
>;
const capturedValue = <T>(map: Readonly<Record<string, T>>, key: string) =>
  Object.hasOwn(map, key)
    ? ({ present: true, value: map[key] as T } as const)
    : ({ present: false } as const);
function capturedMapChanges<T>(
  before: Readonly<Record<string, T>>,
  after: Readonly<Record<string, T>>,
): CapturedMapChanges<T> {
  const changes: Record<
    string,
    { before: CapturedValue<T>; after: CapturedValue<T> }
  > = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = capturedValue(before, key);
    const next = capturedValue(after, key);
    if (!same(old, next)) changes[key] = { before: old, after: next };
  }
  return changes;
}
function matchesCapturedMap<T>(
  current: Readonly<Record<string, T>>,
  changes: CapturedMapChanges<T>,
) {
  return Object.entries(changes).every(([key, change]) =>
    same(capturedValue(current, key), change.after),
  );
}
function restoreCapturedMap<T>(
  current: Readonly<Record<string, T>>,
  changes: CapturedMapChanges<T>,
) {
  const restored = { ...current };
  for (const [key, change] of Object.entries(changes)) {
    if (change.before.present) restored[key] = change.before.value;
    else delete restored[key];
  }
  return restored;
}
const EMPTY_CAPTURED_UNDO_VERSIONS: Readonly<Record<string, string>> =
  Object.freeze({});
function invalidateCapturedUndoVersions(
  versions: Readonly<Record<string, string>> | undefined,
  keys: Iterable<string>,
): Readonly<Record<string, string>> {
  if (!versions) return EMPTY_CAPTURED_UNDO_VERSIONS;
  const actions = new Set(
    [...keys].flatMap((key) =>
      versions[key] ? [versions[key] as string] : [],
    ),
  );
  if (!actions.size) return versions;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(versions).filter(([, action]) => !actions.has(action)),
    ),
  );
}
function captureUndoVersions(
  versions: Readonly<Record<string, string>> | undefined,
  keys: Iterable<string>,
  actionId: string,
) {
  const selected = [...new Set(keys)];
  const remaining = invalidateCapturedUndoVersions(versions, selected);
  if (
    Object.keys(remaining ?? {}).length + selected.length >
    READ_LOCAL_UNREAD_KEYS
  )
    return { versions: remaining, tracked: false } as const;
  const next = { ...remaining };
  for (const key of selected) next[key] = actionId;
  return { versions: Object.freeze(next), tracked: true } as const;
}
function removeCapturedUndoAction(
  versions: Readonly<Record<string, string>> | undefined,
  actionId: string,
): Readonly<Record<string, string>> {
  if (!versions) return EMPTY_CAPTURED_UNDO_VERSIONS;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(versions).filter(([, action]) => action !== actionId),
    ),
  );
}
const localState = (journal: ReadJournal, now: number): ReadState => {
  const frontiers: Record<string, number> = {
    ...journal.reserve,
    ...journal.state.frontiers,
  };
  for (const [key, value] of Object.entries(journal.own ?? {}))
    frontiers[key] = Math.max(frontiers[key] ?? 0, value);
  return Object.freeze({
    frontiers: Object.freeze(frontiers),
    overrides: unreadGroups(
      journal.state.overrides,
      (key) => frontiers[key],
      unreadClock(journal, now),
    ),
  });
};
const heldCount = (journal: ReadJournal | undefined) =>
  Object.keys(journal?.unread?.held ?? {}).length;
/** Every save: resolve held groups the clock has reached (incoming cutoff
 * first, so a stale baseline never merges), expire and drop accepted groups
 * at the expiry clock (discard guard), and advance the durable watermark. */
function settleUnread(journal: ReadJournal, now: number): ReadJournal {
  const unread = journal.unread ?? newUnreadJournal();
  const clock = Math.max(now, unread.watermark);
  const held: Record<string, readonly HeldGroup[]> = {};
  const overrides: Record<string, ReadState["overrides"][string]> = {};
  const frontiers: Record<string, number> = {};
  for (const [key, groups] of Object.entries(unread.held)) {
    const waiting = groups.filter((group) => {
      const [set, clear, baseline, frontier] = group;
      const value = { set, clear, baseline };
      const verdict = unreadReceive(value, now);
      if (verdict === "defer") return true;
      // Its read position is not a stamp: it always merges.
      frontiers[key] = Math.max(frontiers[key] ?? 0, frontier);
      if (verdict === "merge") {
        const old = overrides[key];
        overrides[key] = {
          set: Math.max(old?.set ?? 0, set),
          clear: Math.max(old?.clear ?? 0, clear),
          baseline: Math.max(old?.baseline ?? 0, baseline),
        };
      }
      return false;
    });
    if (waiting.length) held[key] = waiting;
  }
  const merged = mergeReadStates(journal.state, {
    frontiers,
    overrides,
  });
  const visible = localState({ ...journal, state: merged }, clock);
  const state = Object.freeze({
    frontiers: merged.frontiers,
    overrides: unreadGroups(
      merged.overrides,
      (key) => visible.frontiers[key],
      clock,
    ),
  });
  // The watermark records the clock only when it expired or dropped something:
  // what it expired is saved, so a rollback has nothing to revive.
  const moved = !same(
    state.overrides,
    unreadGroups(
      merged.overrides,
      (key) => visible.frontiers[key],
      unread.watermark,
    ),
  );
  const next = Object.freeze({
    ...unread,
    watermark: moved ? clock : unread.watermark,
    held,
  });
  // Nothing moved: the journal itself, so an unchanged save stays unchanged.
  if (same(state, journal.state) && same(next, journal.unread)) return journal;
  return { ...journal, state, unread: next };
}
/** Which broader mark covers a mark, as in `CoveredFrontier`. `home` gives
 * the channel of a message when it is known: from a loaded message, or from
 * a channel saved with the mark. */
export type MarkCoverage = Readonly<{
  covered: (
    key: string,
    frontier: (key: string) => number | undefined,
    home: (id: string) => string | undefined,
  ) => string | undefined;
  /** The channel of a loaded, verified message. */
  home: (id: string) => string | undefined;
}>;
/** One durable domain owner. Read intent is not cache; one tab never saves over another's intent. */
export function createReadState({
  viewer,
  reader,
  host,
  storage,
  lock,
  notify = (listener) => listener(),
  now = () => Math.floor(Date.now() / 1000),
  debounceMs = 5000,
  broadcastName,
  floor = () => now() - READ_RETENTION_SECONDS,
}: {
  viewer: string;
  reader: RelayReader;
  host: ReadStateHost | undefined;
  storage: ReadStateStorage;
  lock?: ReadPublisherLock | undefined;
  notify?: (listener: () => void) => void;
  now?: () => number;
  debounceMs?: number;
  broadcastName?: string | undefined;
  /** Every message at or before this time counts as read. */
  floor?: (() => number) | undefined;
}) {
  let closed = false;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let journal: ReadJournal | undefined;
  /** Bumped whenever saved unread groups change (an admission, a resolved
   * held group, a local action): a version-2 record built before it is stale. */
  let unreadEpoch = 0;
  let rebuild = false;
  let state: ReadState = EMPTY_READ_STATE;
  // Message evidence (and so ancestry) belongs to unread, which registers this.
  let coverage: MarkCoverage | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | undefined;
  let publishing: Promise<void> | undefined;
  // Loading a peer revision is not attempting it. Failed attempts wait for explicit retry.
  let attemptedRevision = -1;
  let failedRevision: number | undefined;
  let work: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  let requested = false;
  /** The completeness the last drop interrupted, while nothing since has
   * failed: a continuous replay brings the markers back to it without a read. */
  let resumable: ReadSyncSnapshot["completeness"] | undefined;
  const slots = new Map<
    string,
    { event: RelayEvent; parsed: ParsedReadBlob }
  >();
  // Encoded size of each own kind-30078 coordinate in the last complete
  // snapshot, so a publication cannot make the next snapshot impossible.
  let snapshotSizes: Map<string, number> | undefined;
  // The version each size was taken from, so a stale echo never shrinks it.
  const sizeVersions = new Map<string, RelayEvent>();
  /** Other own kind-30078 shapes (thread follows) recover from the same reads. */
  const ownListeners = new Set<
    (events: readonly RelayEvent[], complete: boolean) => void
  >();
  const capability = !host
    ? "unsupported"
    : !host.sign || !host.publish || !lock
      ? "read-only"
      : "frontier-sync";
  let snapshot: ReadSyncSnapshot = Object.freeze({
    capability,
    status: "loading",
    completeness: "unknown",
  });
  const broadcast =
    broadcastName && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(broadcastName)
      : undefined;
  const emit = () => {
    if (!closed) for (const listener of listeners) notify(listener);
  };
  /** A snapshot read failed, an accepted marker failed to apply, or the
   * stream dropped, and no snapshot read or resume has succeeded since. */
  let observationOwed = false;
  /** A channel clear the overfull primary cannot carry: never reported as
   * synchronized until a publication fits the merged groups again. */
  let blockedClear: string | undefined;
  let blockedKeys: readonly string[] = [];
  let capacityKeys: readonly string[] = [];
  /** A clock or held warning outranks a capacity one. */
  const warning = () =>
    blockedClear ?? (capacityKeys.length ? UNREAD_CAPACITY : undefined);
  const health = (patch: Partial<ReadSyncSnapshot>) => {
    if (patch.status) failedRevision = undefined;
    if (patch.status === "error") resumable = undefined;
    let next = { ...snapshot, ...patch };
    const error = warning();
    if (
      error &&
      (next.status === "local" ||
        next.status === "pending" ||
        next.status === "accepted" ||
        next.status === "reconciled")
    )
      next = { ...next, status: "error", error };
    if (!same(next, snapshot)) {
      snapshot = Object.freeze(next);
      emit();
    }
  };
  /**
   * Checked inside the storage transaction with the journal it will replace,
   * so a fence on local intent sees other windows' saves, not this cache.
   */
  type Validity = (current: ReadJournal) => boolean;
  type LocalUnreadUndo = {
    keys: ReadonlySet<string>;
    /** Keys whose newer explicit intent also invalidates a captured inverse. */
    intentKeys?: readonly string[];
    valid: () => boolean;
  };
  type CapturedMessageRead = Readonly<{
    key: string;
    timestamp: number;
    channelId: string;
    rootId?: string | undefined;
  }>;
  type CapturedScopeState = Readonly<{
    key: string;
    frontier?: number | undefined;
    recent?: number | undefined;
  }>;
  type CapturedReadUndo = {
    token: string;
    actionId: string;
    keys: readonly string[];
    floor: number;
    stateFrontiers: CapturedMapChanges<number>;
    recent: CapturedMapChanges<number>;
    reserve: CapturedMapChanges<number>;
    homes: CapturedMapChanges<string>;
    intentVersions: Readonly<Record<string, CapturedValue<number>>>;
    messages: readonly CapturedMessageRead[];
    scopes: readonly (readonly CapturedScopeState[])[];
  };
  type LocalUnreadAttempt = {
    key: string;
    /** A message or thread mark's covering context, saved with it. */
    cover?: Readonly<{ channelId: string; rootId?: string | undefined }>;
    saved?: { revision: number; previous: number; set?: number | undefined };
  };
  const pendingLocalUnread = new Set<LocalUnreadAttempt>();
  type LocalUnreadFence = Promise<{ valid: Validity } | { error: unknown }>;
  function captureLocalUnreadRevision() {
    return new Promise<ReadJournal | undefined>((resolve) =>
      resolve(storage.capture()),
    ).then(
      (captured) => ({
        revision: captured?.revision ?? 0,
        sets: captured?.state.overrides ?? {},
      }),
      (error: unknown) => ({ error }),
    );
  }
  function captureLocalUnread(
    keys: readonly string[],
    cut?: ReturnType<typeof captureLocalUnreadRevision>,
  ): LocalUnreadFence {
    // Reserve at the click, not when a channel's queue eventually runs. Older
    // queued local actions are allowed only after their save actually succeeds.
    const older = [...pendingLocalUnread].filter(({ key }) =>
      keys.includes(key),
    );
    return (cut ?? captureLocalUnreadRevision()).then((captured) => {
      if ("error" in captured) return captured;
      return {
        valid: (current: ReadJournal) =>
          keys.every((key) => {
            // A synced mark unread saved since the cut, by any window, is
            // newer intent too; it changes no local-unread revision.
            const set = current.state.overrides[key]?.set ?? 0;
            if (
              set > (captured.sets[key]?.set ?? 0) &&
              !older.some(
                (attempt) => attempt.key === key && attempt.saved?.set === set,
              )
            )
              return false;
            let revision = current.localUnread[key] ?? 0;
            // An older queued save may overwrite a newer window's mark. Only
            // follow successful older saves back to the captured journal cut.
            while (revision > captured.revision) {
              const saved = older.find(
                (attempt) =>
                  attempt.key === key && attempt.saved?.revision === revision,
              )?.saved;
              if (!saved) return false;
              revision = saved.previous;
            }
            return true;
          }),
      };
    });
  }
  async function capturedValidity(valid: Validity, fence: LocalUnreadFence) {
    const captured = await fence;
    if ("error" in captured) throw captured.error;
    return (current: ReadJournal) => valid(current) && captured.valid(current);
  }
  function queue<T>(job: () => Promise<T>): Promise<T> {
    const next = work.then(job);
    work = next.catch(() => {});
    return next;
  }
  /** Own values advanced by `frontiers`, without anything the retention
   * floor already reads. Only an explicit mark read publishes a message's
   * mark; display and dwell marks stay local. */
  const advanceOwn = (
    own: Readonly<Record<string, number>> = {},
    frontiers: Readonly<Record<string, number>> = {},
    explicit = false,
  ) => {
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(own))
      if (value > floor()) next[key] = value;
    for (const [key, value] of Object.entries(frontiers))
      if (
        !key.startsWith("seen:msg:") &&
        (explicit || !key.startsWith("msg:")) &&
        value > floor()
      )
        next[key] = Math.max(next[key] ?? 0, value);
    return next;
  };
  const homeLookup =
    (saved: Readonly<Record<string, string>> = {}) =>
    (id: string) =>
      saved[id] ?? coverage?.home(id);
  const coveredWith = (
    home: (id: string) => string | undefined,
  ): CoveredFrontier | undefined =>
    coverage && ((key, frontier) => coverage?.covered(key, frontier, home));
  /** `retainLocalRead`, with the channels of the messages that the kept
   * marks name. Each save records the channel of every loaded message that a
   * kept mark names, so the mark can still be covered after a reload. */
  function retainMarks(
    current: ReadJournal,
    states: readonly ReadState[],
    recent: Readonly<Record<string, number>>,
    learned: Readonly<Record<string, string>> = {},
  ) {
    const home = homeLookup({ ...current.homes, ...learned });
    const kept = retainLocalRead(
      states,
      recent,
      current.clientId,
      current.reserve,
      coveredWith(home),
      current.floor,
    );
    const homes: Record<string, string> = {};
    for (const key of [
      ...Object.keys(kept.state.frontiers),
      ...Object.keys(kept.reserve),
    ]) {
      const id = markMessage(key);
      const channel = id === undefined ? undefined : home(id);
      // A channel the saved record cannot hold is used for this save's
      // pruning but not kept, so it cannot make the whole save fail.
      if (id !== undefined && contextId(channel)) homes[id] = channel;
    }
    return { ...kept, homes: Object.freeze(homes) };
  }
  async function save(
    change: (current: ReadJournal) => ReadJournal,
    announce = true,
  ) {
    if (closed) throw new Error("Read-state session closed");
    let released = false;
    const changedLocalUnread = new Set<string>();
    const saved = await storage.update((current) => {
      if (closed) throw new Error("Read-state session closed");
      const before = current ?? newReadJournal();
      const changed = change(before);
      let next = settleUnread(changed, now());
      // A released held group is new publishable intent, whichever save
      // settles it: bump once here and wake one publish pass after commit.
      released = heldCount(next) < heldCount(changed);
      if (released) next = { ...next, revision: next.revision + 1 };
      for (const key of new Set([
        ...Object.keys(before.localUnread),
        ...Object.keys(next.localUnread),
      ]))
        if (
          !same(
            capturedValue(before.localUnread, key),
            capturedValue(next.localUnread, key),
          )
        )
          changedLocalUnread.add(key);
      const intentBase =
        next.localUnreadIntent ?? before.localUnreadIntent ?? {};
      let localUnreadIntent: Readonly<Record<string, number>> = intentBase;
      if (changedLocalUnread.size) {
        const updatedIntent = { ...intentBase };
        for (const key of changedLocalUnread)
          updatedIntent[key] = next.revision;
        localUnreadIntent = updatedIntent;
      }
      let intentHistoryPruned = false;
      if (Object.keys(localUnreadIntent).length > READ_LOCAL_UNREAD_KEYS) {
        const changedKeys = [...changedLocalUnread].filter((key) =>
          Object.hasOwn(localUnreadIntent, key),
        );
        const kept = new Set(changedKeys.slice(-READ_LOCAL_UNREAD_KEYS));
        for (const [key] of Object.entries(localUnreadIntent)
          .filter(([key]) => !changedLocalUnread.has(key))
          .sort(([, a], [, b]) => b - a)
          .slice(0, READ_LOCAL_UNREAD_KEYS - kept.size))
          kept.add(key);
        localUnreadIntent = Object.fromEntries(
          [...kept].map((key) => [key, localUnreadIntent[key] as number]),
        );
        intentHistoryPruned = true;
      }
      const intentHistoryMissing = before.localUnreadIntent === undefined;
      const epochChanged = next.capturedReadUndo !== before.capturedReadUndo;
      if (intentHistoryPruned || (intentHistoryMissing && !epochChanged)) {
        const activeVersions = Object.fromEntries(
          Object.entries(next.capturedUndoVersions ?? {}).filter(
            ([key, action]) => before.capturedUndoVersions?.[key] !== action,
          ),
        );
        next = {
          ...next,
          capturedReadUndo: newReadUndoEpochId(),
          capturedUndoVersions: activeVersions,
        };
      }
      return next.localUnreadIntent === localUnreadIntent
        ? next
        : { ...next, localUnreadIntent };
    });
    if (closed) return saved;
    if (!same(journal?.state.overrides, saved.state.overrides)) unreadEpoch++;
    journal = saved;
    blockedClear = saved.unread?.blockedClear;
    blockedKeys = saved.unread?.blockedKeys ?? [];
    capacityKeys = saved.unread?.capacityKeys ?? [];
    state = localState(saved, now());
    armUpkeep();
    if (released) schedule();
    if (announce) broadcast?.postMessage("changed");
    emit();
    return saved;
  }
  /** A peer's save is already durable, so load it without writing it back.
   * Only a missing record (first use, or cleared elsewhere) still saves. */
  async function load() {
    const current = await storage.read?.();
    if (!current) return save((current) => current, false);
    if (closed) return;
    journal = current;
    blockedClear = current.unread?.blockedClear;
    blockedKeys = current.unread?.blockedKeys ?? [];
    capacityKeys = current.unread?.capacityKeys ?? [];
    state = localState(current, now());
    armUpkeep();
    emit();
  }
  const ready = queue(async () => {
    try {
      await save(
        (current) => ({
          ...current,
          capturedReadUndo: newReadUndoEpochId(),
          capturedUndoVersions: {},
          localUnreadIntent: {},
        }),
        false,
      );
      if (!closed)
        health({
          status:
            journal?.pending ||
            (journal && journal.revision > journal.acceptedRevision)
              ? "pending"
              : "local",
        });
    } catch (error) {
      health({
        status: "error",
        error: `Read-state storage: ${errorText(error)}`,
      });
    }
  });
  function undoLocalRead(
    actionSlot: string,
    actionRevision: number,
    cleared: readonly string[],
    valid: Validity,
    options?: LocalUnreadUndo,
    captured?: CapturedReadUndo,
    covers: Readonly<Record<string, LocalCover>> = {},
  ): (() => Promise<ReadMutationResult>) | undefined {
    if (
      !options ||
      (!cleared.length && !captured) ||
      !cleared.every((key) => options.keys.has(key))
    )
      return;
    let consumed = false;
    return () => {
      if (consumed) return Promise.reject(new ObservationExpired());
      const attempts: LocalUnreadAttempt[] = cleared.map((key) => ({ key }));
      for (const attempt of attempts) pendingLocalUnread.add(attempt);
      return queue(async () => {
        await ready;
        if (!journal)
          throw new Error("Saved read state unavailable; retry storage first");
        try {
          const saved = await save((current) => {
            const currentReadState = localState(current, now());
            const capturedStillCurrent =
              !captured ||
              (current.capturedReadUndo === captured.token &&
                captured.keys.every(
                  (key) =>
                    current.capturedUndoVersions?.[key] === captured.actionId,
                ) &&
                current.localUnreadIntent !== undefined &&
                Object.entries(captured.intentVersions).every(([key, value]) =>
                  same(
                    capturedValue(current.localUnreadIntent ?? {}, key),
                    value,
                  ),
                ) &&
                matchesCapturedMap(
                  current.state.frontiers,
                  captured.stateFrontiers,
                ) &&
                matchesCapturedMap(current.recent ?? {}, captured.recent) &&
                matchesCapturedMap(current.reserve ?? {}, captured.reserve) &&
                matchesCapturedMap(current.homes ?? {}, captured.homes) &&
                captured.messages.every(
                  ({ timestamp }) =>
                    captured.floor >= timestamp ||
                    Math.max(floor(), current.floor ?? 0) < timestamp,
                ) &&
                captured.scopes.every((scope) =>
                  scope.every(
                    ({ key, frontier, recent }) =>
                      currentReadState.frontiers[key] === frontier &&
                      current.recent?.[key] === recent,
                  ),
                ));
            if (
              consumed ||
              !valid(current) ||
              !options.valid() ||
              current.slot !== actionSlot ||
              (!captured && current.revision !== actionRevision) ||
              !capturedStillCurrent ||
              cleared.some((key) => current.localUnread[key] !== undefined)
            )
              throw new ObservationExpired();
            const revision = current.revision + 1;
            const localUnread = { ...current.localUnread };
            for (const key of cleared) localUnread[key] = revision;
            const reverted: ReadJournal = {
              ...current,
              // Only device-local receipt/retention effects are reverted. The
              // action never advances synced prefixes; own/publication state stays.
              ...(captured && {
                state: {
                  ...current.state,
                  frontiers: restoreCapturedMap(
                    current.state.frontiers,
                    captured.stateFrontiers,
                  ),
                },
                recent: restoreCapturedMap(
                  current.recent ?? {},
                  captured.recent,
                ),
                reserve: restoreCapturedMap(
                  current.reserve ?? {},
                  captured.reserve,
                ),
                homes: restoreCapturedMap(current.homes ?? {}, captured.homes),
              }),
            };
            // A restored mark keeps its context, covered from now: the read
            // it undoes may have advanced past its old cover.
            const localCovers = { ...current.localCovers };
            for (const key of cleared) {
              const cover = covers[key];
              if (!cover) continue;
              const [, , channel, root] = cover;
              localCovers[key] = [
                revision,
                effectiveFrontier(
                  localState(reverted, now()),
                  key,
                  channel,
                  root && root !== UNRESOLVED_ROOT ? root : undefined,
                ) ?? -1,
                channel,
                root,
              ];
            }
            const restored: ReadJournal = {
              ...reverted,
              revision,
              localUnread,
              localCovers: keptCovers(localCovers, localUnread),
              ...(captured && {
                capturedUndoVersions: removeCapturedUndoAction(
                  current.capturedUndoVersions,
                  captured.actionId,
                ),
              }),
              acceptedRevision:
                current.acceptedRevision === current.revision
                  ? revision
                  : current.acceptedRevision,
            };
            if (captured) {
              // Unrelated retained receipts may have filled the space this inverse needs.
              try {
                readJournal(restored, viewer);
              } catch {
                throw new ObservationExpired();
              }
            }
            return restored;
          });
          consumed = true;
          for (const attempt of attempts)
            attempt.saved = { revision: saved.revision, previous: 0 };
          health({
            status:
              saved.pending || saved.revision > saved.acceptedRevision
                ? "pending"
                : "local",
            error: undefined,
          });
          return {
            operationId: `${saved.slot}:${saved.revision}`,
            durability: "saved" as const,
            sync: "local-only" as const,
          };
        } catch (error) {
          if (!(error instanceof ObservationExpired))
            health({ status: "error", error: errorText(error) });
          throw error;
        }
      }).finally(() => {
        for (const attempt of attempts) pendingLocalUnread.delete(attempt);
      });
    };
  }
  if (broadcast)
    broadcast.onmessage = () => {
      void queue(async () => {
        try {
          await load();
          reconcileJournal();
        } catch (error) {
          health({ status: "error", error: errorText(error) });
        }
      });
    };
  function reconcileJournal() {
    if (closed || !journal) return;
    if (journal.pending || journal.revision > journal.acceptedRevision) {
      if (journal.revision > attemptedRevision) {
        health({ status: "pending", error: undefined });
        schedule();
      }
    } else if (
      snapshot.status === "pending" ||
      snapshot.status === "accepted" ||
      (failedRevision !== undefined &&
        journal.acceptedRevision >= failedRevision)
    ) {
      failedRevision = undefined;
      health({
        status: journal.lastCreatedAt > 0 ? "reconciled" : "local",
        error: undefined,
      });
    }
  }
  function schedule() {
    if (closed || capability !== "frontier-sync" || timer || publishing) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, debounceMs);
  }
  async function decode(events: readonly RelayEvent[], signal: AbortSignal) {
    if (!host) throw new Error("Read-state decoding unsupported by this host");
    const selected = new Map<string, RelayEvent>();
    for (const event of events) {
      const coordinate = readCoordinate(event);
      if (event.pubkey === viewer && coordinate)
        selected.set(coordinate, newer(selected.get(coordinate), event));
    }
    const result: { event: RelayEvent; parsed: ParsedReadBlob }[] = [];
    const values = [...selected.values()];
    // Host body bounds apply independently from the aggregate snapshot limit.
    for (let index = 0; index < values.length; index += 4) {
      const batch = values.slice(index, index + 4);
      const decoded = await host.decode(batch, signal);
      signal.throwIfAborted();
      if (!Array.isArray(decoded) || decoded.length !== batch.length)
        throw new Error("Incomplete read-state decode");
      const seen = new Set<string>();
      for (const item of decoded) {
        const event = batch.find((event) => event.id === item.eventId);
        if (!event || seen.has(event.id))
          throw new Error("Read-state decode identity mismatch");
        seen.add(event.id);
        result.push({
          event,
          parsed: channelGroups(parseReadBlob(item.blob)),
        });
      }
    }
    return result;
  }
  /** Incoming groups by the receive rule, at the raw local clock: a group
   * older than the lifetime is dropped before its baseline merges, one too far
   * ahead is held back with its paired frontier (or this device's, if
   * greater), and the rest merge. Read positions always merge. */
  function receiveGroups(current: ReadJournal, incoming: readonly ReadState[]) {
    const at = now();
    const mine = localState(current, at).frontiers;
    const held: Record<string, HeldGroup[]> = Object.fromEntries(
      Object.entries(current.unread?.held ?? {}).map(([key, groups]) => [
        key,
        [...groups],
      ]),
    );
    const states = incoming.map((state) => {
      const overrides: Record<string, ReadState["overrides"][string]> = {};
      for (const [key, value] of Object.entries(state.overrides)) {
        const verdict = unreadReceive(value, at);
        if (verdict === "merge") overrides[key] = value;
        else if (verdict === "defer") {
          const group: HeldGroup = [
            value.set,
            value.clear,
            value.baseline,
            Math.max(state.frontiers[key] ?? 0, mine[key] ?? 0),
          ];
          // One group per (set, clear, baseline): a re-delivery after a local
          // read only raises its frontier, never adds a group.
          const list = held[key] ?? [];
          const at = list.findIndex((other) =>
            same(other.slice(0, 3), group.slice(0, 3)),
          );
          if (at >= 0) {
            if (group[3] > (list[at]?.[3] ?? 0))
              held[key] = list.map((other, i) => (i === at ? group : other));
          } else {
            // A full list drops this version; every other group still
            // merges, and a later refresh brings the peer's latest.
            if (list.length < HELD_GROUPS_PER_KEY) held[key] = [...list, group];
          }
        }
      }
      return { frontiers: state.frontiers, overrides };
    });
    return { states, held };
  }
  async function ingest(
    events: readonly RelayEvent[],
    signal: AbortSignal,
    generation = epoch,
  ) {
    const committed = await decode(events, signal);
    // Merge locally before admitting slot versions. Failed storage must remain retryable.
    await save((current) => {
      signal.throwIfAborted();
      if (closed || generation !== epoch)
        throw new DOMException(
          "Read-state observation cancelled",
          "AbortError",
        );
      // Our own slots can hold values this journal lacks (a restored or
      // cloned profile): recover them, or the next blob would drop them.
      const owned = [current.slot, ...(current.spill ?? [])].map(
        (slot) => `read-state:${slot}`,
      );
      let own = current.own;
      for (const { event, parsed } of committed)
        if (
          parsed.clientId === current.clientId &&
          owned.includes(readCoordinate(event) ?? "")
        )
          own = advanceOwn(own, parsed.state.frontiers, true);
      const { states, held } = receiveGroups(
        current,
        committed.map(({ parsed }) => parsed.state),
      );
      const capturedUndoVersions = invalidateCapturedUndoVersions(
        current.capturedUndoVersions,
        committed
          .filter(({ event, parsed }) => {
            if (parsed.clientId === current.clientId) return false;
            const previous = slots.get(readCoordinate(event) ?? "");
            // Re-reading an admitted envelope is bookkeeping, not a later read intent.
            return (
              !previous || newer(previous.event, event).id !== previous.event.id
            );
          })
          .flatMap(({ event, parsed }) => {
            const previous = slots.get(readCoordinate(event) ?? "");
            return Object.entries(parsed.state.frontiers)
              .filter(
                ([key, value]) =>
                  key.startsWith("msg:") &&
                  previous?.parsed.state.frontiers[key] !== value,
              )
              .map(([key]) => key);
          }),
      );
      return {
        ...current,
        ...retainMarks(
          current,
          [current.state, ...states],
          current.recent ?? {},
        ),
        capturedUndoVersions,
        ...(own && { own }),
        unread: { ...(current.unread ?? newUnreadJournal()), held },
      };
    });
    if (closed || generation !== epoch) return;
    for (const item of committed) {
      const coordinate = readCoordinate(item.event);
      if (!coordinate) throw new Error("Read-state coordinate missing");
      const old = slots.get(coordinate);
      if (!old || newer(old.event, item.event) === item.event) {
        slots.set(coordinate, item);
        // Every observation keeps the capacity basis current, not only refresh.
        noteSize(item.event);
      }
    }
    if (slots.size > 4096) {
      slots.clear();
      throw new Error("Read-state coordinate capacity exceeded");
    }
  }
  const snapshotted = () => !!host?.communityId && !!reader.readStateSnapshot;
  // An operation's ten seconds, plus the reader's large-read deadline when it
  // reads a complete snapshot: a caller signal shorter than that deadline would
  // cancel the snapshot first.
  const budget = (snapshot: boolean) =>
    AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(10000 + (snapshot ? LARGE_READ_DEADLINE_MS : 0)),
    ]);
  /** Counts a coordinate's newest version only: a stale echo never shrinks it. */
  function noteSize(event: RelayEvent) {
    const coordinate = dTag(event);
    const prior = sizeVersions.get(coordinate);
    if (prior && newer(prior, event) !== event) return;
    // Remember the newest version even without a basis, so a snapshot
    // installed after a gap cannot restore an older, smaller size.
    sizeVersions.set(coordinate, event);
    snapshotSizes?.set(coordinate, encodedBytes(event));
  }
  // Sizes of a complete snapshot, kept current by every later observation.
  function basis(events: readonly RelayEvent[]) {
    // An observation newer than the snapshot's cut (for example a follow
    // that arrived during the fetch) outranks the snapshot's version.
    const observed = new Map(sizeVersions);
    snapshotSizes = new Map();
    sizeVersions.clear();
    for (const event of events) {
      const coordinate = dTag(event);
      const prior = observed.get(coordinate);
      const kept = prior ? newer(prior, event) : event;
      sizeVersions.set(coordinate, kept);
      snapshotSizes.set(coordinate, encodedBytes(kept));
      observed.delete(coordinate);
    }
    for (const [coordinate, event] of observed) {
      sizeVersions.set(coordinate, event);
      snapshotSizes.set(coordinate, encodedBytes(event));
    }
  }
  // A local projection, not a reservation: other devices can still grow the
  // snapshot concurrently. Checked before every send, replays included. A gap
  // can drop the basis while a send awaits its signer or storage, so a missing
  // basis refuses the send; the next flush takes a fresh snapshot first.
  function admit(events: readonly RelayEvent[]) {
    if (!snapshotSizes) {
      if (snapshotted())
        throw new Error(
          "Read-state capacity basis lost; saved intent retained",
        );
      return;
    }
    const projected = new Map(snapshotSizes);
    for (const event of events) projected.set(dTag(event), encodedBytes(event));
    let total = 2 + Math.max(0, projected.size - 1);
    for (const size of projected.values()) total += size;
    if (projected.size > READ_SNAPSHOT_EVENTS || total > READ_SNAPSHOT_BYTES)
      throw new Error(
        "Read-state snapshot capacity reached; saved intent retained",
      );
  }
  async function refresh(priority: Priority = "background") {
    requested = true;
    if (closed || !host) return;
    if (refreshing) return refreshing;
    const generation = epoch;
    const signal = budget(snapshotted());
    const task = queue(async () => {
      try {
        await ready;
        if (!journal) throw new Error("Saved read state unavailable");
        const complete = snapshotted();
        const events =
          complete && reader.readStateSnapshot
            ? await reader.readStateSnapshot({
                signal,
                priority,
                fresh: true,
              })
            : await reader.read(
                [
                  {
                    kinds: [30078],
                    authors: [viewer],
                    "#t": ["read-state", UNREAD_TAG],
                    limit: 500,
                  },
                ],
                { signal, priority },
              );
        await ingest(events, signal, generation);
        if (closed || generation !== epoch) return;
        if (complete) basis(events);
        for (const listener of ownListeners) listener(events, complete);
        observationOwed = false;
        health({
          status:
            journal.pending || journal.revision > journal.acceptedRevision
              ? "pending"
              : "reconciled",
          completeness: complete ? "snapshot" : "bounded",
          error: undefined,
        });
        if (journal.pending || journal.revision > journal.acceptedRevision)
          schedule();
      } catch (error) {
        if (!closed && generation === epoch) {
          observationOwed = true;
          health({ status: "error", error: errorText(error) });
        }
      }
    });
    refreshing = task.finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }
  /** Sets or clears the channel unread groups an action covers, per the
   * Actions of NIP-RS: a set needs a complete load, a stamp the clock allows
   * and room in the one version-2 record; nothing is ever evicted for it. A
   * clear stamps only groups that are still live. While any incoming group is
   * held back, neither may run. Undefined: nothing synced. */
  function changeGroups(
    current: ReadJournal,
    key: string,
    unread: boolean | undefined,
    clearKeys: readonly string[],
  ): ReadState | undefined {
    if (capability !== "frontier-sync" || unread === undefined) return;
    const clock = unreadClock(current, now());
    const frontier = (state: ReadState, ctx: string) =>
      localState({ ...current, state }, now()).frontiers[ctx];
    const fits = (state: ReadState) =>
      unreadBlob(
        current.clientId,
        state.overrides,
        (ctx) => frontier(state, ctx),
        clock,
      );
    let next = current.state;
    if (unread) {
      // Without a complete load the mark stays on this device, labelled so.
      if (!channelContext(key) || snapshot.completeness !== "snapshot") return;
      // Held groups keep a new mark on this device, like an incomplete load.
      if (heldCount(current)) return;
      const old = next.overrides[key];
      const set = unreadStamp(old, now());
      if (set === null) throw new Error(UNREAD_CLOCK);
      next = {
        frontiers: next.frontiers,
        overrides: {
          ...next.overrides,
          [key]: {
            set,
            clear: old?.clear ?? 0,
            baseline: frontier(next, key) ?? 0,
          },
        },
      };
      fits(next);
      return next;
    }
    const active = (ctx: string) =>
      unreadActive(next.overrides[ctx], frontier(next, ctx), clock);
    // Each refused channel resolves on its own clear or inactivity.
    const settle = (resolved: readonly string[]) => {
      const open = (ctx: string) => !resolved.includes(ctx) && active(ctx);
      blockedKeys = blockedKeys.filter(open);
      capacityKeys = capacityKeys.filter(open);
      if (!blockedKeys.length) blockedClear = undefined;
    };
    const refuse = (error: string) => {
      if (error === UNREAD_CAPACITY)
        capacityKeys = [...new Set([...capacityKeys, ...live])];
      else {
        blockedClear = error;
        blockedKeys = [...new Set([...blockedKeys, ...live])];
      }
    };
    const live = [...new Set([key, ...clearKeys])].filter(
      (ctx) => channelContext(ctx) && active(ctx),
    );
    if (!live.length) {
      settle([]);
      return;
    }
    // A clear that cannot be stamped or carried stays unsynced: the read
    // itself still advances, and the failure shows in the sync notice.
    if (heldCount(current)) {
      refuse(UNREAD_HELD);
      return;
    }
    const overrides = { ...next.overrides };
    for (const ctx of live) {
      const old = overrides[ctx];
      const clear = unreadStamp(old, now());
      if (!old || clear === null) {
        refuse(UNREAD_CLOCK);
        return;
      }
      overrides[ctx] = { ...old, clear };
    }
    next = { frontiers: next.frontiers, overrides };
    try {
      fits(next);
    } catch {
      refuse(UNREAD_CAPACITY);
      return;
    }
    settle(live);
    return next;
  }
  async function mutate(
    key: string,
    timestamp: number | undefined,
    unread: boolean | undefined,
    valid: Validity,
    clearLocalKeys: readonly string[] = [key],
    fence?: LocalUnreadFence,
    localUnreadAttempt?: LocalUnreadAttempt,
    undoOptions?: LocalUnreadUndo,
  ): Promise<ReadMutationResult> {
    return queue<ReadMutationResult>(async () => {
      await ready;
      if (!journal)
        throw new Error("Saved read state unavailable; retry storage first");
      if (timestamp !== undefined && capability !== "frontier-sync")
        throw new Error("Read-state sync unsupported by this host");
      try {
        const currentValid = fence
          ? await capturedValidity(valid, fence)
          : valid;
        let previousLocalUnread = 0;
        let synced = false;
        const clearedLocalUnread: string[] = [];
        const clearedCovers: Record<string, LocalCover> = {};
        const saved = await save((current) => {
          if (!currentValid(current)) throw new ObservationExpired();
          if (
            !contextId(key) ||
            (timestamp !== undefined && !uint32(timestamp))
          )
            throw new Error("Invalid read frontier");
          const revision = current.revision + 1;
          const recent =
            timestamp === undefined
              ? (current.recent ?? {})
              : { ...current.recent, [key]: revision };
          const kept =
            timestamp === undefined
              ? {
                  state: current.state,
                  recent,
                  reserve: current.reserve ?? {},
                  homes: current.homes ?? {},
                  floor: current.floor ?? 0,
                }
              : retainMarks(
                  current,
                  [
                    current.state,
                    { frontiers: { [key]: timestamp }, overrides: {} },
                  ],
                  recent,
                );
          const localUnread = { ...current.localUnread };
          const localCovers = { ...current.localCovers };
          previousLocalUnread = localUnread[key] ?? 0;
          // Automatic observations do not clear explicit local manual-unread intent.
          if (unread === false)
            for (const clearKey of new Set(clearLocalKeys)) {
              const previous = localUnread[clearKey];
              if (undoOptions && previous !== undefined) {
                clearedLocalUnread.push(clearKey);
                const cover = coverOf(current, clearKey);
                if (cover) clearedCovers[clearKey] = cover;
              }
              delete localUnread[clearKey];
            }
          const own = advanceOwn(
            current.own,
            timestamp === undefined ? {} : { [key]: timestamp },
            unread === false,
          );
          // A whole channel's mark unread, and its clears, sync as override
          // groups; message and thread mark unread stay on this device.
          // The shared journal's warning, not this tab's cached copy: only a
          // refusal here, or the publication fit recheck, changes it.
          blockedClear = current.unread?.blockedClear;
          blockedKeys = current.unread?.blockedKeys ?? [];
          capacityKeys = current.unread?.capacityKeys ?? [];
          const groups = changeGroups(
            { ...current, state: kept.state, reserve: kept.reserve, own },
            key,
            unread,
            clearLocalKeys,
          );
          if (groups) kept.state = groups;
          if (unread === true && !groups) {
            localUnread[key] = revision;
            const cover = localUnreadAttempt?.cover;
            if (cover) {
              localCovers[key] = [
                revision,
                effectiveFrontier(
                  localState(current, now()),
                  key,
                  cover.channelId,
                  cover.rootId === UNRESOLVED_ROOT ? undefined : cover.rootId,
                ) ?? -1,
                cover.channelId,
                cover.rootId ?? "",
              ];
            }
          }
          // A refused clear is not retried: its warning persists until a
          // publication fits again or a later read's clear succeeds.
          const unreadJournal =
            current.unread &&
            withBlockedClear(
              current.unread,
              blockedClear,
              blockedKeys,
              capacityKeys,
            );
          synced = timestamp !== undefined || !!groups;
          const capturedUndoVersions =
            timestamp === undefined
              ? (current.capturedUndoVersions ?? EMPTY_CAPTURED_UNDO_VERSIONS)
              : invalidateCapturedUndoVersions(current.capturedUndoVersions, [
                  key,
                ]);
          return {
            ...current,
            revision,
            state: kept.state,
            recent: kept.recent,
            reserve: kept.reserve,
            homes: kept.homes,
            floor: kept.floor,
            own,
            localUnread,
            localCovers: keptCovers(localCovers, localUnread),
            ...(unreadJournal ? { unread: unreadJournal } : {}),
            capturedUndoVersions,
            acceptedRevision:
              !synced && current.acceptedRevision === current.revision
                ? revision
                : current.acceptedRevision,
          };
        });
        if (localUnreadAttempt)
          localUnreadAttempt.saved = {
            revision: saved.revision,
            previous: previousLocalUnread,
            set: saved.state.overrides[key]?.set,
          };
        health({
          status: capability === "frontier-sync" ? "pending" : "local",
          error: undefined,
        });
        if (synced) schedule();
        const undo = undoLocalRead(
          saved.slot,
          saved.revision,
          clearedLocalUnread,
          currentValid,
          undoOptions,
          undefined,
          clearedCovers,
        );
        return {
          operationId: `${saved.slot}:${saved.revision}`,
          durability: "saved",
          sync:
            capability === "frontier-sync" && synced ? "pending" : "local-only",
          ...(undo && { undo }),
        };
      } catch (error) {
        if (!(error instanceof ObservationExpired))
          health({ status: "error", error: errorText(error) });
        throw error;
      }
    });
  }
  async function flush() {
    if (closed || capability !== "frontier-sync" || !lock || !host?.sign)
      return;
    if (publishing) return publishing;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    let signal = budget(false);
    const sign = host.sign;
    const task = queue(async () => {
      try {
        await ready;
        attemptedRevision = journal?.revision ?? attemptedRevision;
        await lock(signal, async () => {
          await save((current) => current, false);
          if (!journal) throw new Error("Saved read state unavailable");
          attemptedRevision = journal.revision;
          // A restart or gap leaves no capacity basis: take one before any send.
          if (!snapshotSizes && snapshotted() && reader.readStateSnapshot) {
            // Decided here, not at the call: a gap while this flush waited
            // can drop the basis. The lock only uses its signal to acquire.
            signal = budget(true);
            const generation = epoch;
            const observed = await reader.readStateSnapshot({
              signal,
              priority: "background",
              fresh: true,
            });
            await ingest(observed, signal, generation);
            // A gap during the fetch invalidates this basis too.
            if (closed || generation !== epoch) return;
            basis(observed);
          }
          // Unknown outcomes retry exact bytes; only expired, rejected state may be renewed.
          if (journal.pending) {
            admit([journal.pending.event]);
            await publishPending(signal, true);
          }
          // A blocked clear is rechecked even with nothing new to send: peer
          // clears may have shrunk the merged groups until they fit again.
          if (journal.revision <= journal.acceptedRevision && !warning())
            return;
          const owned = [journal.slot, ...(journal.spill ?? [])];
          const unreadSlot = (journal.unread ?? newUnreadJournal()).slot;
          const unreadAt = `read-state-unread-v2:${unreadSlot}`;
          const events = await reader.read(
            [
              {
                kinds: [30078],
                authors: [viewer],
                "#d": [...owned.map((slot) => `read-state:${slot}`), unreadAt],
                limit: owned.length + 1,
              },
            ],
            { signal, priority: "background", fresh: true },
          );
          // Held groups the clock has reached resolve here, before planning.
          await ingest(events, signal);
          const seen = owned.map((slot) => slots.get(`read-state:${slot}`));
          const seenUnread = slots.get(unreadAt);
          if (
            [...seen, seenUnread].some(
              (own) => own && own.parsed.clientId !== journal?.clientId,
            )
          )
            throw new Error("Read-state slot conflict; publication blocked");
          // The acknowledged revision is the one this plan was packed from;
          // anything saved later, even during the spill save, stays pending.
          const revision = journal.revision;
          // Own frontiers in version 1; the merged union of every
          // installation's channel unread groups, with their paired
          // frontiers, in this installation's one version-2 record.
          const ownFrontiers = advanceOwn(journal.own);
          const merged = localState(journal, now());
          const { clientId } = journal;
          const clock = unreadClock(journal, now());
          const built = unreadEpoch;
          const unreadOf = (overrides: ReadState["overrides"]) =>
            unreadBlob(
              clientId,
              overrides,
              (key) => merged.frontiers[key],
              clock,
            );
          // When the merged groups overfill the record, republish the last
          // published groups, compacted against current frontiers so they can
          // only shrink: override actions fail visibly in changeGroups.
          // A refused clear's warning ends once none of its groups is active.
          const { overrides } = journal.state;
          if (
            [...blockedKeys, ...capacityKeys].some(
              (key) =>
                !unreadActive(overrides[key], merged.frontiers[key], clock),
            )
          )
            await save((current) => {
              if (!current.unread) return current;
              const at = localState(current, now());
              const open = (keys: readonly string[] = []) =>
                keys.filter((key) =>
                  unreadActive(
                    current.state.overrides[key],
                    at.frontiers[key],
                    unreadClock(current, now()),
                  ),
                );
              const keys = open(current.unread.blockedKeys);
              return {
                ...current,
                unread: withBlockedClear(
                  current.unread,
                  keys.length ? current.unread.blockedClear : undefined,
                  keys,
                  open(current.unread.capacityKeys),
                ),
              };
            });
          let groups: ReadBlob;
          try {
            groups = unreadOf(journal.state.overrides);
            // Fitting resolves only capacity refusals; clock and held
            // refusals wait for a successful clear.
            if (!heldCount(journal) && capacityKeys.length)
              await save((current) =>
                current.unread?.capacityKeys
                  ? {
                      ...current,
                      unread: withBlockedClear(
                        current.unread,
                        current.unread.blockedClear,
                        current.unread.blockedKeys,
                      ),
                    }
                  : current,
              );
          } catch {
            groups = unreadOf(seenUnread?.parsed.state.overrides ?? {});
          }
          const plan = packReadState(
            journal.clientId,
            ownFrontiers,
            owned.map((slot, index) => ({
              slot,
              carried: Object.keys(seen[index]?.parsed.state.frontiers ?? {}),
            })),
            newSlotId,
          );
          const unreadState = parseReadBlob(groups).state;
          // An empty record is never written in place of no record.
          const unreadChanged = !same(
            seenUnread?.parsed.state ?? EMPTY_READ_STATE,
            unreadState,
          );
          // Nothing in version 2 is published while a group is held back.
          const unreadHeld = unreadChanged && !!heldCount(journal);
          if (plan.length > READ_STATE_SLOTS)
            throw new Error(
              "Read-state publication capacity reached; saved intent retained",
            );
          // New slots are owned before anything is published to them.
          if (plan.length > owned.length)
            await save((current) => ({
              ...current,
              spill: plan.slice(1).map(({ slot }) => slot),
            }));
          // Only slots missing one of their own values are written: an
          // unchanged blob keeps its event, and an emptied one stays inert.
          // A blob that drops a key it carries goes last, after the key's new
          // home, so no frontier is ever off the relay.
          const drops = (index: number) =>
            Object.keys(seen[index]?.parsed.state.frontiers ?? {}).some(
              (key) => !(key in (plan[index]?.frontiers ?? {})),
            );
          const changed: {
            coordinate: string;
            slot: string;
            blob: ReadBlob;
          }[] = plan
            .map((blob, index) => ({ ...blob, index }))
            .filter(({ frontiers, index }) =>
              Object.entries(frontiers).some(
                ([key, value]) =>
                  (seen[index]?.parsed.state.frontiers[key] ?? -1) < value,
              ),
            )
            .sort((a, b) => Number(drops(a.index)) - Number(drops(b.index)))
            .map(({ slot, frontiers }) => ({
              coordinate: `read-state:${slot}`,
              slot,
              blob: readBlob(
                journal?.clientId ?? clientId,
                { frontiers, overrides: {} },
                () => undefined,
              ),
            }));
          if (unreadChanged && !unreadHeld)
            changed.push({
              coordinate: unreadAt,
              slot: unreadSlot,
              blob: groups,
            });
          attemptedRevision = revision;
          if (!changed.length) {
            if (unreadHeld) throw new Error(UNREAD_HELD);
            const expired = journal.pending?.event.id;
            await save((current) => {
              // An expired envelope whose values the relay already holds
              // needs no replacement.
              const { pending, ...rest } = current;
              return {
                ...(pending?.event.id === expired ? rest : current),
                acceptedRevision: Math.max(current.acceptedRevision, revision),
              };
            });
            health({ status: "reconciled", error: undefined });
            return;
          }
          const signed: RelayEvent[] = [];
          for (const { coordinate, slot, blob: payload } of changed) {
            // Above every version this installation ever signed, so a
            // successor always supersedes a pending event the relay missed.
            const createdAt = readVersion(
              now(),
              Math.max(
                journal.lastCreatedAt,
                slots.get(coordinate)?.event.created_at ?? 0,
              ),
            );
            const event = await sign(
              { slot, createdAt, blob: payload },
              signal,
            );
            signal.throwIfAborted();
            if (
              event.pubkey !== viewer ||
              readCoordinate(event) !== coordinate ||
              event.created_at !== createdAt
            )
              throw new Error("Read-state signer changed identity or version");
            // Decode signed output too: a host response cannot acknowledge a different plaintext.
            const decoded = await decode([event], signal);
            if (
              decoded[0]?.parsed.clientId !== journal.clientId ||
              !same(decoded[0]?.parsed.state, parseReadBlob(payload).state)
            )
              throw new Error("Read-state signer changed the payload");
            signed.push(event);
          }
          // Every prefix must fit: a later blob's shrink is no credit until
          // it reaches the relay.
          for (let end = 1; end <= signed.length; end++)
            admit(signed.slice(0, end));
          for (const [index, event] of signed.entries()) {
            // Only the last blob acknowledges the revision: a partial
            // publication never marks local intent as synchronized.
            // Nor while unread intent is held back.
            const last = index === signed.length - 1 && !unreadHeld;
            await save((current) => ({
              ...current,
              lastCreatedAt: Math.max(current.lastCreatedAt, event.created_at),
              pending: {
                event,
                revision: last ? revision : current.acceptedRevision,
              },
            }));
            // Saving awaited storage: fence the send itself, not just the plan.
            // Earlier blobs are observed by now, so the basis already holds them.
            admit([event]);
            await publishPending(signal, false, built);
          }
          if (unreadHeld) throw new Error(UNREAD_HELD);
        });
      } catch (error) {
        if (!closed) {
          health({ status: "error", error: errorText(error) });
          failedRevision =
            journal &&
            (journal.pending || journal.revision > journal.acceptedRevision)
              ? journal.revision
              : undefined;
        }
      }
    });
    publishing = task.finally(() => {
      publishing = undefined;
      if (rebuild) {
        rebuild = false;
        attemptedRevision = -1;
        schedule();
      }
      // Peer intent may have arrived during signing/readback, ahead of its broadcast.
      reconcileJournal();
    });
    return publishing;
  }
  async function publishPending(
    signal: AbortSignal,
    recover = false,
    /** The unread epoch an in-pass version-2 record was built at. */
    built?: number,
  ) {
    const before = journal;
    const pending = before?.pending;
    if (!pending || !before) return;
    if (!host?.publish) throw new Error("Read-state publication unavailable");
    // Checked at the send, after every await before it: a group held back
    // since planning (a live delivery mid-pass) still stops version 2.
    // A pure check: it never admits or saves. Anything admitted since the
    // record was built refuses the send; the next pass rebuilds it.
    if (unreadCoordinateOf(pending.event)) {
      if (heldCount(journal)) throw new Error(UNREAD_HELD);
      if (built !== undefined && built !== unreadEpoch) {
        // Never sent, so it is dropped, not replayed: exact bytes of a
        // stale record must not reach the relay on a later retry either.
        await save((current) => {
          if (current.pending?.event.id !== pending.event.id) return current;
          const { pending: _stale, ...rest } = current;
          return rest;
        }, false);
        rebuild = true;
        throw new Error(UNREAD_STALE);
      }
    }
    health({ status: "pending", error: undefined });
    let expired = false;
    try {
      await host.publish(pending.event, signal);
    } catch (error) {
      // A timestamp refusal also covers future clock skew. Only renew old state,
      // outside the signer's 60s clock allowance, and at most once per flush.
      if (
        !recover ||
        !(error instanceof ReadStateTimestampRejected) ||
        pending.event.created_at >= now() - 60
      )
        throw error;
      expired = true;
    }
    signal.throwIfAborted();
    // Acknowledgement is not coordinate observation. An expired retry may also
    // have been stored before its original response was lost.
    if (!expired) health({ status: "accepted" });
    const coordinate = readCoordinate(pending.event);
    if (!coordinate) throw new Error("Read-state coordinate missing");
    const events = await reader.read(
      [
        {
          kinds: [30078],
          authors: [viewer],
          "#d": [coordinate],
          limit: 500,
        },
      ],
      { signal, priority: "background", fresh: true },
    );
    await ingest(events, signal);
    const own = slots.get(coordinate);
    const payload = (await decode([pending.event], signal))[0]?.parsed;
    if (!payload) throw new Error("Saved read-state decode missing");
    if (own && own.parsed.clientId !== before.clientId)
      throw new Error("Read-state slot conflict; publication blocked");
    const observed =
      !!own &&
      same(mergeReadStates(own.parsed.state, payload.state), own.parsed.state);
    if (!observed) {
      if (!expired)
        throw new Error(
          "Read-state accepted; coordinate observation still pending",
        );
      // Keep the old envelope until its replacement is saved by flush. Merge its
      // plaintext durably without acknowledging it or erasing newer local intent.
      await save((current) => {
        if (current.pending?.event.id !== pending.event.id) return current;
        return {
          ...current,
          ...retainMarks(
            current,
            [current.state, payload.state],
            current.recent ?? {},
          ),
          own: advanceOwn(current.own, payload.state.frontiers, true),
        };
      });
      return;
    }
    const saved = await save((current) => {
      if (current.pending?.event.id !== pending.event.id) return current;
      const { pending: _pending, ...rest } = current;
      return {
        ...rest,
        acceptedRevision: Math.max(current.acceptedRevision, pending.revision),
      };
    });
    health({
      status:
        saved.revision > saved.acceptedRevision ? "pending" : "reconciled",
      error: undefined,
    });
  }
  /** Expiry moves with time, not only with saves: show it then, and save the
   * watermark (and any held group the clock reached) whenever it moves. The
   * saved watermark is only ever the one storage returned, so a failed save
   * stays due and is retried. */
  function upkeep() {
    if (closed || !journal) return Promise.resolve();
    const shown = localState(journal, now());
    if (!same(shown.overrides, state.overrides)) {
      state = shown;
      emit();
    }
    const settled = settleUnread(journal, now());
    if (
      same(settled.state, journal.state) &&
      same(settled.unread?.held, journal.unread?.held)
    ) {
      armUpkeep();
      return Promise.resolve();
    }
    return queue(async () => {
      try {
        await save((current) => current);
      } catch (error) {
        health({ status: "error", error: errorText(error) });
        armUpkeep(60);
      }
    });
  }
  let upkeepTimer: ReturnType<typeof setTimeout> | undefined;
  /** The next moment a mark expires or a held group's time comes, if any. */
  function armUpkeep(retry?: number) {
    if (upkeepTimer) clearTimeout(upkeepTimer);
    upkeepTimer = undefined;
    if (closed || !journal) return;
    const at = now();
    const clock = unreadClock(journal, at);
    const due: number[] = retry === undefined ? [] : [at + retry];
    for (const [key, value] of Object.entries(journal.state.overrides))
      if (unreadActive(value, state.frontiers[key], clock))
        due.push(value.set + UNREAD_LIFETIME + 1);
    for (const groups of Object.values(journal.unread?.held ?? {}))
      for (const [set, clear] of groups)
        due.push(Math.max(set, clear) - UNREAD_DEFER_AHEAD);
    if (!due.length) return;
    const wait = Math.min(
      Math.max(Math.min(...due) - at, 1) * 1000,
      2 ** 31 - 1,
    );
    upkeepTimer = setTimeout(() => {
      upkeepTimer = undefined;
      void upkeep();
    }, wait);
  }
  return {
    ready,
    upkeep,
    captureLocalUnread,
    captureLocalUnreadRevision,
    snapshot: () => snapshot,
    /** Markers may be missing: a snapshot read is still owed. */
    owed: () => observationOwed,
    state: () => state,
    localUnread: (key: string) => journal?.localUnread[key],
    localUnreadKeys: () => Object.keys(journal?.localUnread ?? {}),
    /** A mark's saved covering context, while it is still the saved mark. */
    localCover: (key: string) => journal && coverOf(journal, key),
    /** Saves the thread a mark's unresolved root resolved to, with its
     * baseline then, while that mark and its unresolved cover are still saved. */
    resolveLocalCover: (key: string, cover: LocalCover) =>
      queue(async () => {
        await ready;
        const fits = (current: ReadJournal) =>
          current.localUnread[key] === cover[0] &&
          current.localCovers?.[key]?.[3] === UNRESOLVED_ROOT;
        if (!journal || !fits(journal)) return;
        await save((current) =>
          fits(current)
            ? {
                ...current,
                localCovers: { ...current.localCovers, [key]: cover },
              }
            : current,
        );
      }),
    /** A key's saved synced mark-unread stamp: a newer one fences reading. */
    unreadSet: (key: string) => journal?.state.overrides[key]?.set ?? 0,
    revision: () => journal?.revision ?? 0,
    /** `revision`, less quiet saves from any window: they change no unread
     * state, so a reader's entry evidence outlives them. */
    intentRevision: () => (journal?.revision ?? 0) - (journal?.quiet ?? 0),
    /** Every message at or before this time counts as read: the retention
     * window, or the local floor that dropped marks raised, whichever is
     * later. Publication uses only the retention window. */
    floor: () => Math.max(floor(), journal?.floor ?? 0),
    /** Lets the next save drop marks that broader marks already cover. */
    setCoverage(next: MarkCoverage | undefined) {
      coverage = next;
    },
    /** The saved channel of a message that a kept mark names. */
    home: (id: string) => journal?.homes?.[id],
    /** Saves channels found for marked messages (from signed events) and
     * drops the marks that they show are covered. Like a synced update, this
     * changes no read, so it publishes nothing. */
    learnHomes: (found: Readonly<Record<string, string>>) =>
      queue(async () => {
        await ready;
        if (!journal || closed) return;
        await save((current) => ({
          ...current,
          ...retainMarks(current, [current.state], current.recent ?? {}, found),
        }));
      }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    /** Snapshot preflight for another own kind-30078 shape (thread follows):
     * throws unless the complete snapshot still fits with `events`. */
    admit,
    /** Keeps the capacity basis current for an accepted own event. */
    observeSize(event: RelayEvent) {
      noteSize(event);
    },
    /** Every own-author read this owner completes: `complete` when it was
     * the full authenticated snapshot. */
    subscribeOwn(
      listener: (events: readonly RelayEvent[], complete: boolean) => void,
    ) {
      ownListeners.add(listener);
      return () => {
        ownListeners.delete(listener);
      };
    },
    ensure: () =>
      refreshing ?? (requested ? Promise.resolve() : refresh("foreground")),
    flush,
    read: (
      key: string,
      timestamp: number,
      valid: Validity,
      explicit = false,
      clearLocalKeys?: readonly string[],
      fence?: LocalUnreadFence,
      undoOptions?: LocalUnreadUndo,
    ) =>
      mutate(
        key,
        timestamp,
        explicit ? false : undefined,
        valid,
        clearLocalKeys,
        fence,
        undefined,
        undoOptions,
      ),
    clearLocalUnread: (
      key: string,
      keys: readonly string[],
      valid: Validity,
      fence?: LocalUnreadFence,
      undoOptions?: LocalUnreadUndo,
    ) =>
      mutate(key, undefined, false, valid, keys, fence, undefined, undoOptions),
    /** Atomic explicit subtree read; local-only hosts clear intent without
     * fabricating frontiers. A `quiet` save (a row's `seen:` marks) reads
     * nothing, so it is counted apart from unread intent (`intentRevision`). */
    readMessages: (
      messages: readonly CapturedMessageRead[],
      clearForce: string | undefined,
      valid: Validity,
      quiet = false,
      fence?: LocalUnreadFence,
      clearLocalKeys: readonly string[] = [],
      options: {
        preserveCapturedSet?: boolean;
        /** Full selection, including authored messages without receipt writes. */
        selectedMessages?: readonly CapturedMessageRead[];
        undo?: LocalUnreadUndo;
        /** An explicit Mark read of these messages: their marks sync. */
        explicit?: boolean;
      } = {},
    ) =>
      queue(async () => {
        await ready;
        if (!journal)
          throw new Error("Saved read state unavailable; retry storage first");
        try {
          const currentValid = fence
            ? await capturedValidity(valid, fence)
            : valid;
          const clearedLocalUnread = new Set<string>();
          const clearedCovers: Record<string, LocalCover> = {};
          const captureUndo = Boolean(
            options.preserveCapturedSet && options.undo,
          );
          const messageKeys = [
            ...new Set([...messages.map(({ key }) => key), ...clearLocalKeys]),
          ];
          const intentKeys = captureUndo
            ? [
                ...new Set([
                  ...messages.map(({ key }) => key),
                  ...clearLocalKeys,
                  ...(options.undo?.intentKeys ?? []),
                ]),
              ]
            : [];
          const capturedActionId = captureUndo ? newSlotId() : undefined;
          let capturedUndoTracked = false;
          let captured: CapturedReadUndo | undefined;
          const saved = await save((current) => {
            if (!currentValid(current)) throw new ObservationExpired();
            if (
              messages.some(
                ({ key, timestamp }) => !contextId(key) || !uint32(timestamp),
              )
            )
              throw new Error("Invalid read frontier");
            // Capture the current owner epoch transactionally. A different
            // owner's startup invalidates earlier handles but need not prevent
            // this still-live owner from creating a new one.
            const token = captureUndo
              ? (current.capturedReadUndo ?? capturedActionId)
              : undefined;
            if (captureUndo && !token) throw new ObservationExpired();
            if (token) {
              if (
                messageKeys.some((key) => !key.startsWith("msg:")) ||
                clearForce
              )
                throw new Error(
                  "Captured Undo requires exact message receipts",
                );
            }
            const undoVersionUpdate =
              capturedActionId === undefined
                ? {
                    versions: invalidateCapturedUndoVersions(
                      current.capturedUndoVersions,
                      messageKeys,
                    ),
                    tracked: false as const,
                  }
                : captureUndoVersions(
                    current.capturedUndoVersions,
                    messageKeys,
                    capturedActionId,
                  );
            capturedUndoTracked = undoVersionUpdate.tracked;
            const currentState = localState(current, now());
            if (
              capability !== "frontier-sync" &&
              messages.some(
                ({ key, timestamp, channelId, rootId }) =>
                  (effectiveFrontier(currentState, key, channelId, rootId) ??
                    -1) < timestamp,
              )
            )
              throw new Error("Read-state sync unsupported by this host");
            const revision = current.revision + 1;
            const recent = { ...current.recent };
            const frontiers: Record<string, number> = {};
            const localUnread = { ...current.localUnread };
            for (const { key, timestamp } of messages) {
              if (capability === "frontier-sync") {
                recent[key] = revision;
                frontiers[key] = Math.max(frontiers[key] ?? 0, timestamp);
              }
            }
            const clearLocalUnread = (key: string) => {
              const previous = localUnread[key];
              if (options.undo && previous !== undefined) {
                clearedLocalUnread.add(key);
                const cover = coverOf(current, key);
                if (cover) clearedCovers[key] = cover;
              }
              delete localUnread[key];
            };
            for (const { key } of messages) clearLocalUnread(key);
            if (clearForce) clearLocalUnread(clearForce);
            for (const key of clearLocalKeys) clearLocalUnread(key);
            const kept = Object.keys(frontiers).length
              ? retainMarks(
                  current,
                  [current.state, { frontiers, overrides: {} }],
                  recent,
                )
              : {
                  state: current.state,
                  recent,
                  reserve: current.reserve ?? {},
                  homes: current.homes ?? {},
                  floor: current.floor ?? 0,
                };
            if (
              options.preserveCapturedSet &&
              kept.floor > (current.floor ?? 0)
            ) {
              // The local floor reads every older message, beyond the captured set.
              throw new CapturedReadWouldWidenError();
            }
            if (options.preserveCapturedSet) {
              const retainedFrontiers = {
                ...kept.reserve,
                ...kept.state.frontiers,
              };
              const retainedState = {
                frontiers: retainedFrontiers,
                overrides: kept.state.overrides,
              };
              const home = homeLookup({ ...current.homes, ...kept.homes });
              const covered = coveredWith(home);
              if (
                messages.some(({ key, timestamp, channelId }) => {
                  if (
                    timestamp <= kept.floor ||
                    (effectiveFrontier(retainedState, key, channelId) ?? -1) >=
                      timestamp
                  )
                    return false;
                  const cover = covered?.(key, (other) =>
                    other === key ? timestamp : retainedFrontiers[other],
                  );
                  return (
                    cover === undefined ||
                    (retainedFrontiers[cover] ?? -1) < timestamp
                  );
                })
              )
                throw new CapturedReadNotRetainedError();
            }
            if (token && capturedUndoTracked && capturedActionId) {
              const afterReadState = localState(
                {
                  ...current,
                  state: kept.state,
                  recent: kept.recent,
                  reserve: kept.reserve,
                  homes: kept.homes,
                  floor: kept.floor,
                },
                now(),
              );
              const capturedMessages = (
                options.selectedMessages ?? messages
              ).map((message) => ({
                key: message.key,
                timestamp: message.timestamp,
                channelId: message.channelId,
                ...(message.rootId !== undefined && {
                  rootId: message.rootId,
                }),
              }));
              captured = {
                token,
                actionId: capturedActionId,
                keys: messageKeys,
                floor: Math.max(floor(), current.floor ?? 0),
                stateFrontiers: capturedMapChanges(
                  current.state.frontiers,
                  kept.state.frontiers,
                ),
                recent: capturedMapChanges(current.recent ?? {}, kept.recent),
                reserve: capturedMapChanges(
                  current.reserve ?? {},
                  kept.reserve,
                ),
                homes: capturedMapChanges(current.homes ?? {}, kept.homes),
                intentVersions: {},
                messages: capturedMessages,
                scopes: capturedMessages.map(({ key, channelId, rootId }) =>
                  [
                    ...new Set([
                      key,
                      channelId,
                      `activity:${channelId}`,
                      ...(rootId
                        ? [`thread:${rootId}`, `thread-activity:${rootId}`]
                        : []),
                    ]),
                  ].map((scopeKey) => ({
                    key: scopeKey,
                    frontier: afterReadState.frontiers[scopeKey],
                    recent: kept.recent[scopeKey],
                  })),
                ),
              };
            }
            return {
              ...current,
              revision,
              state: kept.state,
              recent: kept.recent,
              reserve: kept.reserve,
              homes: kept.homes,
              floor: kept.floor,
              own: advanceOwn(current.own, frontiers, options.explicit),
              localUnread,
              capturedUndoVersions: undoVersionUpdate.versions,
              ...(token && { capturedReadUndo: token }),
              ...(quiet && { quiet: (current.quiet ?? 0) + 1 }),
              acceptedRevision:
                Object.keys(frontiers).length && !token
                  ? current.acceptedRevision
                  : current.acceptedRevision === current.revision
                    ? revision
                    : current.acceptedRevision,
            };
          });
          if (captured) {
            captured.token = saved.capturedReadUndo ?? captured.token;
            captured.intentVersions = Object.freeze(
              Object.fromEntries(
                intentKeys.map((key) => [
                  key,
                  capturedValue(saved.localUnreadIntent ?? {}, key),
                ]),
              ),
            );
          }
          const publishable =
            capability === "frontier-sync" &&
            messages.length > 0 &&
            !captureUndo;
          health({
            status:
              saved.pending || saved.revision > saved.acceptedRevision
                ? "pending"
                : "local",
            error: undefined,
          });
          if (publishable) schedule();
          const clearedKeys = [...clearedLocalUnread];
          // Captured inverses recheck selected intent versions, not the save's
          // shared channel hint that unrelated messages can advance.
          const undo = undoLocalRead(
            saved.slot,
            saved.revision,
            clearedKeys,
            captured ? valid : currentValid,
            captureUndo && !captured ? undefined : options.undo,
            captured,
            clearedCovers,
          );
          return {
            operationId: `${saved.slot}:${saved.revision}`,
            durability: "saved" as const,
            sync: publishable ? ("pending" as const) : ("local-only" as const),
            ...(undo && { undo }),
          };
        } catch (error) {
          if (!(error instanceof ObservationExpired))
            health({ status: "error", error: errorText(error) });
          throw error;
        }
      }),
    async markLocalUnread(
      key: string,
      valid: () => boolean,
      enqueue: (
        save: () => Promise<ReadMutationResult>,
      ) => Promise<ReadMutationResult> = (save) => save(),
      cover?: LocalUnreadAttempt["cover"],
    ) {
      const attempt: LocalUnreadAttempt = { key, ...(cover && { cover }) };
      pendingLocalUnread.add(attempt);
      try {
        return await enqueue(() =>
          mutate(key, undefined, true, valid, undefined, undefined, attempt),
        );
      } finally {
        pendingLocalUnread.delete(attempt);
      }
    },
    accept(events: readonly RelayEvent[]) {
      if (
        closed ||
        !host ||
        !events.some(
          (event) => event.pubkey === viewer && readCoordinate(event),
        )
      )
        return;
      const generation = epoch;
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(10000),
      ]);
      void queue(async () => {
        try {
          await ingest(events, signal, generation);
        } catch (error) {
          if (!closed && generation === epoch) {
            observationOwed = true;
            health({ status: "error", error: errorText(error) });
          }
          // A drop cancelled it: the replay may not carry it again, so the
          // snapshot is read again instead of resuming.
          else resumable = undefined;
        }
      });
    },
    stale() {
      resumable =
        snapshot.completeness !== "unknown" &&
        snapshot.status !== "error" &&
        snapshot.status !== "stale"
          ? snapshot.completeness
          : undefined;
      epoch++;
      // Capacity needs a fresh complete snapshot after a gap.
      snapshotSizes = undefined;
      observationOwed = true;
      health({ status: "stale", completeness: "unknown" });
    },
    /** The membership route resumed from its cursor and its replay ended
     * under the limit: it fed every marker written since the drop through
     * `accept`, the same `ingest` the snapshot read uses. Once those land, the
     * state the drop interrupted stands again. Without one, or after a
     * failure since, the snapshot is read again as on any reconnect. */
    resume(): Promise<void> {
      if (closed || !host) return Promise.resolve();
      const generation = epoch;
      return queue(async () => {
        await ready;
        const completeness = resumable;
        if (!completeness || !journal || closed || generation !== epoch)
          return false;
        resumable = undefined;
        observationOwed = false;
        const pending =
          journal.pending || journal.revision > journal.acceptedRevision;
        health({
          status: pending ? "pending" : "reconciled",
          completeness,
          error: undefined,
        });
        if (pending) schedule();
        return true;
      })
        .catch(() => false)
        .then((resumed) =>
          resumed || closed || generation !== epoch ? undefined : refresh(),
        );
    },
    dispose() {
      closed = true;
      epoch++;
      lifetime.abort();
      if (timer) clearTimeout(timer);
      if (upkeepTimer) clearTimeout(upkeepTimer);
      listeners.clear();
      slots.clear();
      broadcast?.close();
      storage.close();
    },
  };
}
