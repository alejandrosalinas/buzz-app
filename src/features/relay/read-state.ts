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
  readVersion,
  READ_RETENTION_SECONDS,
  READ_STATE_SLOTS,
  contextId,
  uint32,
  type ReadState,
  type ParsedReadBlob,
  type Override,
} from "./read-state-model";
import {
  newReadJournal,
  newSlotId,
  type ReadJournal,
  type ReadStateStorage,
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
  /** Local-only restore of saved unread journal markers only; forced-message
   * overlays are not restored. Any later journal revision, even unrelated, or
   * lost operation validity makes the handle stale. */
  undo?: () => Promise<ReadMutationResult>;
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
/** Reserve and journal are disjoint; only own values are published. */
const localState = (journal: ReadJournal): ReadState => {
  const frontiers: Record<string, number> = {
    ...journal.reserve,
    ...journal.state.frontiers,
  };
  for (const [key, value] of Object.entries(journal.own ?? {}))
    frontiers[key] = Math.max(frontiers[key] ?? 0, value);
  return Object.freeze({
    frontiers: Object.freeze(frontiers),
    overrides: journal.state.overrides,
  });
};
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
  type AutomaticReadAttempt = {
    status: "pending" | "saved" | "failed";
    order: number;
    seenSet: number;
    before?: number;
    after?: number;
  };
  const pendingAutomaticReads = new Map<string, Set<AutomaticReadAttempt>>();
  type PeerObservation = {
    event: RelayEvent;
    order: number;
    reads: Map<string, Set<AutomaticReadAttempt>>;
  };
  // Remember first arrival through retries, never recapturing later reads on
  // replay. Decode compacts settled overlaps; a committed ingest retires them.
  const peerObservations = new Map<string, PeerObservation>();
  type PeerGeneration = {
    version: Pick<RelayEvent, "id" | "created_at">;
    order: number;
    override: Override;
    reads: Set<AutomaticReadAttempt>;
    promoted: number;
  };
  const peerGenerations = new Map<
    string,
    Map<string, Map<number, PeerGeneration>>
  >();
  let arrivalOrder = 0;
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
  const health = (patch: Partial<ReadSyncSnapshot>) => {
    if (patch.status) failedRevision = undefined;
    if (patch.status === "error") resumable = undefined;
    const next = { ...snapshot, ...patch };
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
    valid: () => boolean;
  };
  type LocalUnreadAttempt = {
    key: string;
    saved?: { revision: number; previous: number };
  };
  const pendingLocalUnread = new Set<LocalUnreadAttempt>();
  type LocalUnreadFence = Promise<{ valid: Validity } | { error: unknown }>;
  function captureLocalUnreadRevision() {
    return new Promise<ReadJournal | undefined>((resolve) =>
      resolve(storage.capture()),
    ).then(
      (captured) => ({ revision: captured?.revision ?? 0 }),
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
  /** Own values advanced by `frontiers`, without message marks or anything
   * the retention floor already reads. */
  const advanceOwn = (
    own: Readonly<Record<string, number>> = {},
    frontiers: Readonly<Record<string, number>> = {},
  ) => {
    const next: Record<string, number> = {};
    for (const [key, value] of [
      ...Object.entries(own),
      ...Object.entries(frontiers),
    ])
      if (!/^(seen:)?msg:/.test(key) && value > floor())
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
    const saved = await storage.update((current) => {
      if (closed) throw new Error("Read-state session closed");
      return change(current ?? newReadJournal());
    });
    if (closed) return saved;
    journal = saved;
    state = localState(saved);
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
    state = localState(current);
    emit();
  }
  const ready = queue(async () => {
    try {
      await save((current) => current, false);
      // Recovered arrivals precede every read handle created by this owner.
      for (const item of journal?.peerOverlaps ?? []) {
        const keys = peerGenerations.get(item.coordinate) ?? new Map();
        const generations = keys.get(item.key) ?? new Map();
        generations.set(item.set, {
          version: item.version,
          order: 0,
          override: { set: item.set, clear: 0, baseline: item.baseline },
          reads: new Set(),
          promoted: item.baseline,
        });
        keys.set(item.key, generations);
        peerGenerations.set(item.coordinate, keys);
      }
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
  function undoLocalUnread(
    actionSlot: string,
    actionRevision: number,
    cleared: readonly string[],
    valid: Validity,
    options?: LocalUnreadUndo,
  ): (() => Promise<ReadMutationResult>) | undefined {
    if (
      !options ||
      !cleared.length ||
      !cleared.every((key) => options.keys.has(key))
    )
      return;
    return () => {
      const attempts: LocalUnreadAttempt[] = cleared.map((key) => ({ key }));
      for (const attempt of attempts) pendingLocalUnread.add(attempt);
      return queue(async () => {
        await ready;
        if (!journal)
          throw new Error("Saved read state unavailable; retry storage first");
        try {
          const saved = await save((current) => {
            // Revision catches newer mark-then-clear intent; slot also catches a
            // replacement journal whose counter has reached the same revision.
            if (
              !valid(current) ||
              !options.valid() ||
              current.slot !== actionSlot ||
              current.revision !== actionRevision ||
              cleared.some((key) => current.localUnread[key] !== undefined)
            )
              throw new ObservationExpired();
            const revision = current.revision + 1;
            const localUnread = { ...current.localUnread };
            for (const key of cleared) localUnread[key] = revision;
            return {
              ...current,
              revision,
              localUnread,
              acceptedRevision:
                current.acceptedRevision === current.revision
                  ? revision
                  : current.acceptedRevision,
            };
          });
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
        result.push({ event, parsed: parseReadBlob(item.blob) });
      }
    }
    return result;
  }
  async function ingest(
    events: readonly RelayEvent[],
    signal: AbortSignal,
    generation = epoch,
  ) {
    const decoded = await decode(events, signal);
    const coordinates = new Set(
      decoded.map(({ event }) => readCoordinate(event)),
    );
    const superseded = new Map<string, string>();
    // Decode original arrivals too: a newer envelope can carry the same set
    // generation, but must not replace its first overlap with later reads.
    for (const observation of peerObservations.values()) {
      const coordinate = readCoordinate(observation.event);
      if (!coordinate || !coordinates.has(coordinate)) continue;
      let parsed = decoded.find(
        ({ event }) => event.id === observation.event.id,
      )?.parsed;
      if (!parsed) {
        try {
          parsed = (await decode([observation.event], signal))[0]?.parsed;
        } catch (error) {
          signal.throwIfAborted();
          if (closed || generation !== epoch) throw error;
          const replacement = decoded.find(
            ({ event }) => readCoordinate(event) === coordinate,
          )?.event;
          if (
            !replacement ||
            replacement.id === observation.event.id ||
            newer(observation.event, replacement).id !== replacement.id
          )
            throw error;
          // An obsolete unreadable envelope cannot poison its valid successor.
          // Keep it retryable until that successor's storage transaction commits.
          superseded.set(observation.event.id, coordinate);
          continue;
        }
      }
      if (!parsed) throw new Error("Read-state decode identity missing");
      if (parsed.clientId !== journal?.clientId) {
        const keys = peerGenerations.get(coordinate) ?? new Map();
        for (const [key, override] of Object.entries(parsed.state.overrides)) {
          const generations = keys.get(key) ?? new Map();
          const previous = generations.get(override.set);
          const version = newer(previous?.version, {
            id: observation.event.id,
            created_at: observation.event.created_at,
          });
          if (!previous || observation.order < previous.order)
            generations.set(override.set, {
              version,
              order: observation.order,
              override,
              reads: observation.reads.get(key) ?? new Set(),
              promoted: override.baseline,
            });
          else previous.version = version;
          keys.set(key, generations);
        }
        if (keys.size) peerGenerations.set(coordinate, keys);
      }
      // The correlation now lives in exact generations, not encrypted revisions.
      peerObservations.delete(observation.event.id);
    }
    const overlaps = [...peerGenerations].flatMap(([coordinate, keys]) =>
      coordinates.has(coordinate)
        ? [...keys].flatMap(([key, generations]) =>
            [...generations.values()].map((value) => ({
              coordinate,
              key,
              value,
            })),
          )
        : [],
    );
    const rememberEarlier = () => {
      const reads = new Map(
        [...pendingAutomaticReads].map(([key, values]) => [
          key,
          new Set(values),
        ]),
      );
      for (const observation of peerObservations.values())
        for (const [key, values] of observation.reads) {
          const pending = reads.get(key) ?? new Set();
          for (const read of values) pending.add(read);
          reads.set(key, pending);
        }
      for (const { key, value } of overlaps) {
        const pending = reads.get(key) ?? new Set();
        for (const read of value.reads) pending.add(read);
        reads.set(key, pending);
      }
      for (const { key, value } of overlaps)
        for (const read of reads.get(key) ?? [])
          if (read.order > value.order)
            read.seenSet = Math.max(read.seenSet, value.override.set);
    };
    rememberEarlier();
    for (const { coordinate, value } of overlaps) {
      // Snapshot successors advance recovery fences too, without changing the
      // generation's first-arrival correlation with automatic reads.
      const observed = decoded.find(
        ({ event }) => readCoordinate(event) === coordinate,
      )?.event;
      if (observed)
        value.version = newer(value.version, {
          id: observed.id,
          created_at: observed.created_at,
        });
      const override = value.override;
      for (const read of value.reads) {
        if (read.status === "pending") continue;
        value.reads.delete(read);
        const { before, after } = read;
        if (
          override.set > override.clear &&
          read.status === "saved" &&
          before !== undefined &&
          after !== undefined &&
          after > before &&
          override.set > read.seenSet &&
          override.baseline >= before
        )
          value.promoted = Math.max(value.promoted, after);
      }
    }
    if (closed || generation !== epoch)
      throw new DOMException("Read-state observation cancelled", "AbortError");
    // A later queued revision must not checkpoint ahead of this batch's merge.
    const recovery = overlaps.filter(
      ({ coordinate, key, value }) =>
        key.startsWith("msg:") &&
        !value.reads.size &&
        decoded.some(
          ({ event }) =>
            readCoordinate(event) === coordinate &&
            newer(value.version, event).id === event.id,
        ),
    );
    const overlapId = (coordinate: string, key: string, set: number) =>
      JSON.stringify([coordinate, key, set]);
    if (recovery.length) {
      // A separate committed checkpoint survives a failed/cancelled merge. Until
      // this write succeeds, the accepted overlap is only in-memory evidence.
      await save((current) => {
        signal.throwIfAborted();
        if (closed || generation !== epoch)
          throw new DOMException(
            "Read-state observation cancelled",
            "AbortError",
          );
        const pending = new Map(
          (current.peerOverlaps ?? []).map((item) => [
            overlapId(item.coordinate, item.key, item.set),
            item,
          ]),
        );
        for (const { coordinate, key, value } of recovery) {
          const id = overlapId(coordinate, key, value.override.set);
          const previous = pending.get(id);
          pending.set(id, {
            coordinate,
            key,
            set: value.override.set,
            baseline: Math.max(previous?.baseline ?? 0, value.promoted),
            version: newer(previous?.version, value.version),
          });
        }
        return { ...current, peerOverlaps: [...pending.values()] };
      });
    }
    signal.throwIfAborted();
    let committed: typeof decoded = [];
    // Merge locally before admitting slot versions. Failed storage must remain retryable.
    await save((current) => {
      signal.throwIfAborted();
      if (closed || generation !== epoch)
        throw new DOMException(
          "Read-state observation cancelled",
          "AbortError",
        );
      // A sibling's newer checkpoint supersedes this revision without making
      // observation fail. Only committed envelopes may retire its recovery fence.
      committed = decoded.filter(
        ({ event }) =>
          !current.peerOverlaps?.some(
            (item) =>
              item.coordinate === readCoordinate(event) &&
              newer(event, item.version).id !== event.id,
          ),
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
          own = advanceOwn(own, parsed.state.frontiers);
      const recovered = new Map(
        (current.peerOverlaps ?? []).map((item) => [
          overlapId(item.coordinate, item.key, item.set),
          item,
        ]),
      );
      const incoming = committed.map(({ event, parsed }) => {
        if (parsed.clientId === current.clientId) return parsed.state;
        const overrides = { ...parsed.state.overrides };
        let changed = false;
        // A peer unread accepted during an automatic read wins locally without
        // changing the signed event or overtaking a newer local frontier.
        for (const [key, override] of Object.entries(overrides)) {
          const existing = current.state.overrides[key];
          if (
            override.set <= Math.max(override.clear, existing?.clear ?? 0) ||
            override.set < (existing?.set ?? 0)
          )
            continue;
          const preserved = peerGenerations
            .get(readCoordinate(event) ?? "")
            ?.get(key)
            ?.get(override.set);
          const afterRead = Math.max(
            override.baseline,
            preserved?.promoted ?? 0,
            recovered.get(
              overlapId(readCoordinate(event) ?? "", key, override.set),
            )?.baseline ?? 0,
          );
          if (afterRead > override.baseline) {
            overrides[key] = { ...override, baseline: afterRead };
            changed = true;
          }
        }
        return changed
          ? { ...parsed.state, overrides: Object.freeze(overrides) }
          : parsed.state;
      });
      return {
        ...current,
        ...retainMarks(
          current,
          [current.state, ...incoming],
          current.recent ?? {},
        ),
        ...(own && { own }),
        peerOverlaps: (current.peerOverlaps ?? []).filter((item) => {
          const observed = committed.find(
            ({ event }) => readCoordinate(event) === item.coordinate,
          )?.event;
          return !observed || newer(item.version, observed).id !== observed.id;
        }),
      };
    });
    for (const [id, coordinate] of superseded)
      if (committed.some(({ event }) => readCoordinate(event) === coordinate))
        peerObservations.delete(id);
    // Reads can start while storage is saving. Fence their later envelopes
    // before retiring the earlier generation after its committed ingest.
    rememberEarlier();
    for (const { coordinate, key, value } of overlaps) {
      const incoming = committed.find(
        ({ event }) => readCoordinate(event) === coordinate,
      )?.event;
      if (
        value.reads.size ||
        !incoming ||
        newer(value.version, incoming).id !== incoming.id
      )
        continue;
      const keys = peerGenerations.get(coordinate);
      const generations = keys?.get(key);
      generations?.delete(value.override.set);
      if (!generations?.size) keys?.delete(key);
      if (!keys?.size) peerGenerations.delete(coordinate);
    }
    if (closed || generation !== epoch) return;
    for (const item of committed) {
      const coordinate = readCoordinate(item.event);
      if (!coordinate) throw new Error("Read-state coordinate missing");
      const old = slots.get(coordinate);
      if (!old || newer(old.event, item.event) === item.event) {
        slots.set(coordinate, item);
        // Every observation keeps the capacity basis current, not only refresh.
        snapshotSizes?.set(coordinate, encodedBytes(item.event));
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
  // Sizes of a complete snapshot, kept current by every later observation.
  function basis(events: readonly RelayEvent[]) {
    snapshotSizes = new Map(
      events.map((event) => [dTag(event), encodedBytes(event)]),
    );
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
                    "#t": ["read-state"],
                    limit: 500,
                  },
                ],
                { signal, priority },
              );
        await ingest(events, signal, generation);
        if (closed || generation !== epoch) return;
        if (complete) basis(events);
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
  async function mutate(
    key: string,
    timestamp: number | undefined,
    unread: boolean | undefined,
    valid: Validity,
    clearLocalKeys: readonly string[] = [key],
    observedFrontier?: (state: ReadState) => number | undefined,
    fence?: LocalUnreadFence,
    localUnreadAttempt?: LocalUnreadAttempt,
    undoOptions?: LocalUnreadUndo,
  ): Promise<ReadMutationResult> {
    const automatic =
      key.startsWith("msg:") && timestamp !== undefined && unread === undefined;
    // Convergence and client rotation can carry observed registers across
    // coordinates, so read-start fences join set counters from every peer.
    const automaticRead: AutomaticReadAttempt | undefined = automatic
      ? {
          status: "pending",
          order: ++arrivalOrder,
          seenSet: (journal?.peerOverlaps ?? []).reduce(
            (seen, item) =>
              item.key === key ? Math.max(seen, item.set) : seen,
            state.overrides[key]?.set ?? 0,
          ),
        }
      : undefined;
    if (automaticRead) {
      const reads = pendingAutomaticReads.get(key) ?? new Set();
      reads.add(automaticRead);
      pendingAutomaticReads.set(key, reads);
    }
    // Reserve before the owner queue can suspend. A late reload cannot tell
    // an already-ingested generation from one arriving during this read.
    const captured = automaticRead
      ? new Promise<ReadJournal | undefined>((resolve) =>
          resolve(storage.capture()),
        ).then(
          (current) => ({ current }),
          (error: unknown) => ({ error }),
        )
      : undefined;
    const result = queue<ReadMutationResult>(async () => {
      await ready;
      if (!journal)
        throw new Error("Saved read state unavailable; retry storage first");
      if (timestamp !== undefined && capability !== "frontier-sync")
        throw new Error("Read-state sync unsupported by this host");
      try {
        if (automaticRead && captured) {
          const start = await captured;
          if ("error" in start) throw start.error;
          automaticRead.seenSet = (start.current?.peerOverlaps ?? []).reduce(
            (seen, item) =>
              item.key === key ? Math.max(seen, item.set) : seen,
            Math.max(
              automaticRead.seenSet,
              start.current?.state.overrides[key]?.set ?? 0,
            ),
          );
        }
        const currentValid = fence
          ? await capturedValidity(valid, fence)
          : valid;
        let previousLocalUnread = 0;
        const clearedLocalUnread: string[] = [];
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
          const before =
            automaticRead === undefined
              ? undefined
              : ((observedFrontier
                  ? observedFrontier(localState(current))
                  : localState(current).frontiers[key]) ?? 0);
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
          previousLocalUnread = localUnread[key] ?? 0;
          // Automatic observations do not clear explicit local manual-unread intent.
          if (unread === false)
            for (const clearKey of new Set(clearLocalKeys)) {
              const previous = localUnread[clearKey];
              if (undoOptions && previous !== undefined)
                clearedLocalUnread.push(clearKey);
              delete localUnread[clearKey];
            }
          if (unread === true) localUnread[key] = revision;
          const own = advanceOwn(
            current.own,
            timestamp === undefined ? {} : { [key]: timestamp },
          );
          let peerOverlaps = current.peerOverlaps;
          if (automaticRead && before !== undefined) {
            automaticRead.before = before;
            const after = localState({
              ...current,
              state: kept.state,
              reserve: kept.reserve,
              own,
            });
            automaticRead.after =
              (observedFrontier
                ? observedFrontier(after)
                : after.frontiers[key]) ?? before;
            // Refresh and sibling-only ingestion need no live accept() here.
            // Settle their post-capture generations in this same read commit.
            const override = kept.state.overrides[key];
            if (
              override &&
              override.set > Math.max(override.clear, automaticRead.seenSet) &&
              override.baseline >= before &&
              automaticRead.after > before
            )
              kept.state = {
                ...kept.state,
                overrides: {
                  ...kept.state.overrides,
                  [key]: {
                    ...override,
                    baseline: Math.max(override.baseline, automaticRead.after),
                  },
                },
              };
            // A sibling may have checkpointed the arrival but not ingested it.
            // Preserve that same recovery point without recapturing older sets.
            if (automaticRead.after > before) {
              const after = automaticRead.after;
              peerOverlaps = peerOverlaps?.map((item) =>
                item.key === key &&
                item.set >
                  Math.max(automaticRead.seenSet, override?.clear ?? 0) &&
                item.set >= (override?.set ?? 0) &&
                item.baseline >= before
                  ? { ...item, baseline: Math.max(item.baseline, after) }
                  : item,
              );
            }
          }
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
            ...(peerOverlaps && { peerOverlaps }),
            acceptedRevision:
              timestamp === undefined &&
              current.acceptedRevision === current.revision
                ? revision
                : current.acceptedRevision,
          };
        });
        if (localUnreadAttempt)
          localUnreadAttempt.saved = {
            revision: saved.revision,
            previous: previousLocalUnread,
          };
        if (automaticRead) automaticRead.status = "saved";
        health({
          status: capability === "frontier-sync" ? "pending" : "local",
          error: undefined,
        });
        if (timestamp !== undefined) schedule();
        const undo = undoLocalUnread(
          saved.slot,
          saved.revision,
          clearedLocalUnread,
          currentValid,
          undoOptions,
        );
        return {
          operationId: `${saved.slot}:${saved.revision}`,
          durability: "saved",
          sync:
            capability === "frontier-sync" && timestamp !== undefined
              ? "pending"
              : "local-only",
          ...(undo && { undo }),
        };
      } catch (error) {
        if (automaticRead) automaticRead.status = "failed";
        if (!(error instanceof ObservationExpired))
          health({ status: "error", error: errorText(error) });
        throw error;
      }
    });
    if (!automatic) return result;
    return result.finally(() => {
      if (automaticRead?.status === "pending") automaticRead.status = "failed";
      const reads = pendingAutomaticReads.get(key);
      reads?.delete(automaticRead as AutomaticReadAttempt);
      if (!reads?.size) pendingAutomaticReads.delete(key);
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
          if (journal.revision <= journal.acceptedRevision) return;
          const owned = [journal.slot, ...(journal.spill ?? [])];
          const events = await reader.read(
            [
              {
                kinds: [30078],
                authors: [viewer],
                "#d": owned.map((slot) => `read-state:${slot}`),
                limit: owned.length,
              },
            ],
            { signal, priority: "background", fresh: true },
          );
          await ingest(events, signal);
          const seen = owned.map((slot) => slots.get(`read-state:${slot}`));
          if (
            seen.some((own) => own && own.parsed.clientId !== journal?.clientId)
          )
            throw new Error("Read-state slot conflict; publication blocked");
          // The acknowledged revision is the one this plan was packed from;
          // anything saved later, even during the spill save, stays pending.
          const revision = journal.revision;
          // Only own frontiers are published; peers' overrides stay in their blobs.
          const plan = packReadState(
            journal.clientId,
            advanceOwn(journal.own),
            owned.map((slot, index) => ({
              slot,
              carried: Object.keys(seen[index]?.parsed.state.frontiers ?? {}),
            })),
            newSlotId,
          );
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
          const changed = plan
            .map((blob, index) => ({ ...blob, index }))
            .filter(({ frontiers, index }) =>
              Object.entries(frontiers).some(
                ([key, value]) =>
                  (seen[index]?.parsed.state.frontiers[key] ?? -1) < value,
              ),
            )
            .sort((a, b) => Number(drops(a.index)) - Number(drops(b.index)));
          attemptedRevision = revision;
          if (!changed.length) {
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
          for (const { slot, frontiers } of changed) {
            const coordinate = `read-state:${slot}`;
            const state = { frontiers, overrides: {} };
            const payload = readBlob(journal.clientId, state, () => undefined);
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
            const last = index === signed.length - 1;
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
            await publishPending(signal);
          }
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
      // Peer intent may have arrived during signing/readback, ahead of its broadcast.
      reconcileJournal();
    });
    return publishing;
  }
  async function publishPending(signal: AbortSignal, recover = false) {
    const before = journal;
    const pending = before?.pending;
    if (!pending || !before) return;
    if (!host?.publish) throw new Error("Read-state publication unavailable");
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
          own: advanceOwn(current.own, payload.state.frontiers),
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
  return {
    ready,
    captureLocalUnread,
    captureLocalUnreadRevision,
    snapshot: () => snapshot,
    /** Markers may be missing: a snapshot read is still owed. */
    owed: () => observationOwed,
    state: () => state,
    localUnread: (key: string) => journal?.localUnread[key],
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
    ensure: () =>
      refreshing ?? (requested ? Promise.resolve() : refresh("foreground")),
    flush,
    read: (
      key: string,
      timestamp: number,
      valid: Validity,
      explicit = false,
      clearLocalKeys?: readonly string[],
      /** Verified observation ancestry, evaluated only inside the fenced transaction. */
      observedFrontier?: (state: ReadState) => number | undefined,
      fence?: LocalUnreadFence,
      undoOptions?: LocalUnreadUndo,
    ) =>
      mutate(
        key,
        timestamp,
        explicit ? false : undefined,
        valid,
        clearLocalKeys,
        observedFrontier,
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
      mutate(
        key,
        undefined,
        false,
        valid,
        keys,
        undefined,
        fence,
        undefined,
        undoOptions,
      ),
    /** Atomic explicit subtree read; local-only hosts clear intent without
     * fabricating frontiers. A `quiet` save (a row's `seen:` marks) reads
     * nothing, so it is counted apart from unread intent (`intentRevision`). */
    readMessages: (
      messages: readonly Readonly<{
        key: string;
        timestamp: number;
        channelId: string;
        rootId?: string | undefined;
      }>[],
      clearForce: string | undefined,
      valid: Validity,
      quiet = false,
      fence?: LocalUnreadFence,
      clearLocalKeys: readonly string[] = [],
      options: { preserveCapturedSet?: boolean; undo?: LocalUnreadUndo } = {},
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
          const saved = await save((current) => {
            if (!currentValid(current)) throw new ObservationExpired();
            if (
              messages.some(
                ({ key, timestamp }) => !contextId(key) || !uint32(timestamp),
              )
            )
              throw new Error("Invalid read frontier");
            const currentState = localState(current);
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
              if (options.undo && previous !== undefined)
                clearedLocalUnread.add(key);
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
            return {
              ...current,
              revision,
              state: kept.state,
              recent: kept.recent,
              reserve: kept.reserve,
              homes: kept.homes,
              floor: kept.floor,
              own: advanceOwn(current.own, frontiers),
              localUnread,
              ...(quiet && { quiet: (current.quiet ?? 0) + 1 }),
              acceptedRevision: Object.keys(frontiers).length
                ? current.acceptedRevision
                : current.acceptedRevision === current.revision
                  ? revision
                  : current.acceptedRevision,
            };
          });
          health({
            status:
              capability === "frontier-sync" && messages.length
                ? "pending"
                : "local",
            error: undefined,
          });
          if (capability === "frontier-sync" && messages.length) schedule();
          const clearedKeys = [...clearedLocalUnread];
          const undo = undoLocalUnread(
            saved.slot,
            saved.revision,
            clearedKeys,
            currentValid,
            options.undo,
          );
          return {
            operationId: `${saved.slot}:${saved.revision}`,
            durability: "saved" as const,
            sync:
              capability === "frontier-sync" && messages.length
                ? ("pending" as const)
                : ("local-only" as const),
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
    ) {
      const attempt: LocalUnreadAttempt = { key };
      pendingLocalUnread.add(attempt);
      try {
        return await enqueue(() =>
          mutate(
            key,
            undefined,
            true,
            valid,
            undefined,
            undefined,
            undefined,
            attempt,
          ),
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
      for (const event of events) {
        const coordinate = readCoordinate(event);
        const known = coordinate ? slots.get(coordinate)?.event : undefined;
        if (
          !coordinate ||
          event.pubkey !== viewer ||
          peerObservations.has(event.id) ||
          (known && newer(known, event).id === known.id)
        )
          continue;
        peerObservations.set(event.id, {
          event,
          order: ++arrivalOrder,
          reads: new Map(
            [...pendingAutomaticReads].map(([key, reads]) => [
              key,
              new Set(reads),
            ]),
          ),
        });
      }
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
      listeners.clear();
      slots.clear();
      peerObservations.clear();
      peerGenerations.clear();
      pendingAutomaticReads.clear();
      broadcast?.close();
      storage.close();
    },
  };
}
