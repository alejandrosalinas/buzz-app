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
      if (!key.startsWith("msg:") && value > floor())
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
    if (closed || generation !== epoch)
      throw new DOMException("Read-state observation cancelled", "AbortError");
    // Merge locally before admitting slot versions. Failed storage must remain retryable.
    await save((current) => {
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
      for (const { event, parsed } of decoded)
        if (
          parsed.clientId === current.clientId &&
          owned.includes(readCoordinate(event) ?? "")
        )
          own = advanceOwn(own, parsed.state.frontiers);
      return {
        ...current,
        ...retainMarks(
          current,
          [current.state, ...decoded.map(({ parsed }) => parsed.state)],
          current.recent ?? {},
        ),
        ...(own && { own }),
      };
    });
    if (closed || generation !== epoch) return;
    for (const item of decoded) {
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
  ): Promise<ReadMutationResult> {
    return queue(async () => {
      await ready;
      if (!journal)
        throw new Error("Saved read state unavailable; retry storage first");
      if (timestamp !== undefined && capability !== "frontier-sync")
        throw new Error("Read-state sync unsupported by this host");
      try {
        const saved = await save((current) => {
          if (!valid(current)) throw new ObservationExpired();
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
          // Automatic observations do not clear explicit local manual-unread intent.
          if (unread === false)
            for (const clearKey of clearLocalKeys) delete localUnread[clearKey];
          if (unread === true) localUnread[key] = revision;
          return {
            ...current,
            revision,
            state: kept.state,
            recent: kept.recent,
            reserve: kept.reserve,
            homes: kept.homes,
            own: advanceOwn(
              current.own,
              timestamp === undefined ? {} : { [key]: timestamp },
            ),
            localUnread,
            acceptedRevision:
              timestamp === undefined &&
              current.acceptedRevision === current.revision
                ? revision
                : current.acceptedRevision,
          };
        });
        health({
          status: capability === "frontier-sync" ? "pending" : "local",
          error: undefined,
        });
        if (timestamp !== undefined) schedule();
        return {
          operationId: `${saved.slot}:${saved.revision}`,
          durability: "saved",
          sync:
            capability === "frontier-sync" && timestamp !== undefined
              ? "pending"
              : "local-only",
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
    snapshot: () => snapshot,
    /** Markers may be missing: a snapshot read is still owed. */
    owed: () => observationOwed,
    state: () => state,
    localUnread: (key: string) => journal?.localUnread[key],
    revision: () => journal?.revision ?? 0,
    /** Every message at or before this time counts as read. */
    floor,
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
    ) =>
      mutate(
        key,
        timestamp,
        explicit ? false : undefined,
        valid,
        clearLocalKeys,
      ),
    clearLocalUnread: (key: string, keys: readonly string[], valid: Validity) =>
      mutate(key, undefined, false, valid, keys),
    /** Atomic explicit subtree read; local-only hosts clear intent without fabricating frontiers. */
    readMessages: (
      messages: readonly Readonly<{
        key: string;
        timestamp: number;
        channelId: string;
        rootId?: string | undefined;
      }>[],
      clearForce: string | undefined,
      valid: Validity,
    ) =>
      queue(async () => {
        await ready;
        if (!journal)
          throw new Error("Saved read state unavailable; retry storage first");
        try {
          const saved = await save((current) => {
            if (!valid(current)) throw new ObservationExpired();
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
              delete localUnread[key];
            }
            if (clearForce) delete localUnread[clearForce];
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
                };
            return {
              ...current,
              revision,
              state: kept.state,
              recent: kept.recent,
              reserve: kept.reserve,
              homes: kept.homes,
              own: advanceOwn(current.own, frontiers),
              localUnread,
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
          return {
            operationId: `${saved.slot}:${saved.revision}`,
            durability: "saved" as const,
            sync:
              capability === "frontier-sync" && messages.length
                ? ("pending" as const)
                : ("local-only" as const),
          };
        } catch (error) {
          if (!(error instanceof ObservationExpired))
            health({ status: "error", error: errorText(error) });
          throw error;
        }
      }),
    markLocalUnread: (key: string, valid: () => boolean) =>
      mutate(key, undefined, true, valid),
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
      listeners.clear();
      slots.clear();
      broadcast?.close();
      storage.close();
    },
  };
}
