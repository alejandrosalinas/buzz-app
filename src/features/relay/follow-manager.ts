import { eventDto, newer, type RelayEvent } from "./events";
import {
  capture,
  dirtySlots,
  EMPTY_FOLLOW_SYNC,
  FOLLOW_PLAINTEXT_BYTES,
  FOLLOW_SLOTS,
  hydrate,
  journal as journalPacket,
  mergeFollows,
  observe,
  outranks,
  ownChoices,
  parseFollowPayload,
  plaintext,
  slotPayload,
  tap,
  type FollowEdit,
  type FollowEntry,
  type FollowPacket,
  type FollowHead,
  type FollowPayload,
  type FollowSyncState,
} from "./follow-sync";
import {
  followCoordinate,
  ReadStateTimestampRejected,
  type ReadStateHost,
} from "./read-state-host";
import { record, slotId, uint32 } from "./read-state-model";
import type { ReadPublisherLock } from "./read-state";
import {
  newSlotId,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import { PublishRejected } from "./outbox";
import { LARGE_READ_DEADLINE_MS, type RelayReader } from "./reader";
import type { ThreadFollows, ThreadFollowStorage } from "./thread-follows";

/** Follow sync state kept in the read-state journal, saved in the same
 * transactions as read state (rules §2). `slots` are the thread-follows
 * slots this installation owns, in placement order. */
export type StoredFollows = Readonly<{
  state: FollowSyncState;
  slots: readonly string[];
  /** The device-local choices were imported (at=0) after a complete merge. */
  imported?: true;
  /** Newest head of every coordinate we don't own, so peer choices still
   * display offline (by coordinate). */
  peers?: Readonly<Record<string, FollowHead>>;
}>;
const DECODE_EVENTS = 16;
const DECODE_BYTES = 512 * 1024;
/** Worst-case `at`, so a sized slot still fits after any later reservation. */
const MAX_AT = 4294967295;
const encoder = new TextEncoder();
const PEER = /^thread-follows:[0-9a-f]{32}$/;
const FOLLOWS_CHANGED = "follows";
const EMPTY_STORED: StoredFollows = { state: EMPTY_FOLLOW_SYNC, slots: [] };

const version = (raw: unknown) =>
  record(raw) &&
  typeof raw.id === "string" &&
  /^[0-9a-f]{64}$/.test(raw.id) &&
  uint32(raw.created_at);
const parsePayload = (raw: unknown): FollowPayload => {
  if (!record(raw) || typeof raw.clientId !== "string" || !record(raw.threads))
    throw new Error("Invalid saved follow choices");
  return parseFollowPayload(wire(raw as FollowPayload));
};
/** Storage is untrusted: corrupt follow state is an error, never dropped work. */
export function parseStoredFollows(
  raw: unknown,
  viewer: string,
): StoredFollows {
  const fail = () => {
    throw new Error("Invalid saved follow choices");
  };
  if (!record(raw) || !record(raw.state) || !Array.isArray(raw.slots)) fail();
  const r = raw as Record<string, unknown> & { state: Record<string, unknown> };
  const slots = r.slots as unknown[];
  if (
    !slots.every(slotId) ||
    new Set(slots).size !== slots.length ||
    slots.length > FOLLOW_SLOTS
  )
    fail();
  const { heads, edits, packets, reserved, observed } = r.state;
  if (
    !record(heads) ||
    !record(edits) ||
    !record(packets) ||
    !uint32(reserved) ||
    !uint32(observed)
  )
    fail();
  const owned = (slot: unknown) =>
    typeof slot === "string" && slots.includes(slot);
  const state: FollowSyncState = {
    heads: Object.fromEntries(
      Object.entries(heads as Record<string, unknown>).map(([slot, head]) => {
        if (!owned(slot) || !version(head)) fail();
        const h = head as FollowHead;
        return [
          slot,
          {
            id: h.id,
            created_at: h.created_at,
            payload:
              h.payload === undefined ? undefined : parsePayload(h.payload),
          },
        ];
      }),
    ),
    edits: Object.fromEntries(
      Object.entries(edits as Record<string, unknown>).map(([key, edit]) => {
        if (
          !record(edit) ||
          !owned(edit.slot) ||
          !uint32(edit.r) ||
          !["explicit", "legacy-import"].includes(edit.origin as string) ||
          !(edit.basis === "empty" || version(edit.basis))
        )
          fail();
        const e = edit as unknown as FollowEdit;
        const entry = parseFollowPayload({
          v: 1,
          // Validates the entry only; any valid client id will do.
          client_id: "journal",
          threads: { [key]: wireEntry(e.entry) },
        }).threads[key];
        return [key, { ...e, entry: entry as FollowEntry }];
      }),
    ),
    packets: Object.fromEntries(
      Object.entries(packets as Record<string, unknown>).map(([id, packet]) => {
        if (
          !record(packet) ||
          packet.id !== id ||
          !version(packet) ||
          !owned(packet.slot) ||
          !record(packet.captured) ||
          !Object.values(packet.captured).every(uint32)
        )
          fail();
        const p = packet as unknown as FollowPacket;
        if (p.event !== undefined) {
          const event = eventDto(p.event);
          if (
            event.id !== id ||
            event.pubkey !== viewer ||
            followCoordinate(event) !== `thread-follows:${p.slot}`
          )
            fail();
        }
        return [id, { ...p, payload: parsePayload(p.payload) }];
      }),
    ),
    reserved: reserved as number,
    observed: observed as number,
  };
  if (r.peers !== undefined && !record(r.peers)) fail();
  const peers = Object.fromEntries(
    Object.entries((r.peers ?? {}) as Record<string, unknown>).map(
      ([coordinate, head]) => {
        if (!PEER.test(coordinate) || !version(head)) fail();
        const h = head as FollowHead;
        return [
          coordinate,
          {
            id: h.id,
            created_at: h.created_at,
            payload:
              h.payload === undefined ? undefined : parsePayload(h.payload),
          },
        ];
      },
    ),
  );
  return {
    state,
    slots: [...(slots as string[])],
    ...(r.imported === true ? { imported: true as const } : {}),
    ...(Object.keys(peers).length ? { peers } : {}),
  };
}
function wireEntry(entry: unknown) {
  if (!record(entry)) return entry;
  const { extra, ...rest } = entry as FollowEntry;
  return { ...extra, ...rest };
}
/** The wire object for a payload, unknown fields included. */
const wire = (payload: FollowPayload): unknown =>
  JSON.parse(plaintext(payload));

export type FollowSyncSnapshot = Readonly<{
  /** `incomplete`: some coordinate is unreadable or not yet loaded, so
   * choices may be missing (NIP-RS). */
  status: "loading" | "pending" | "synchronized" | "failed" | "local";
  complete: boolean;
  error?: string;
}>;

/** One installation's synced thread follow choices (rules §2–5, §7). The
 * startup gate (§6) is not here yet. Exposes `ThreadFollowStorage` for
 * unread, plus an async `set` that resolves only once the choice is saved. */
export function createThreadFollowSync({
  viewer,
  reader,
  host,
  storage,
  lock,
  legacy,
  now = () => Math.floor(Date.now() / 1000),
  debounceMs = 2000,
  notify = (listener) => listener(),
  capacity,
  broadcastName,
}: {
  viewer: string;
  reader: RelayReader;
  host: ReadStateHost | undefined;
  storage: ReadStateStorage;
  lock?: ReadPublisherLock | undefined;
  /** Device-local choices from before sync: imported once, at=0. */
  legacy: ThreadFollowStorage;
  now?: () => number;
  debounceMs?: number;
  notify?: (listener: () => void) => void;
  /** The shared own kind-30078 snapshot budget (4096 events, 8 MiB), §3. */
  capacity?: {
    admit(events: readonly RelayEvent[]): void;
    observeSize(event: RelayEvent): void;
    refresh(): Promise<void>;
    /** The read-state owner's own-author reads: gap repair and snapshots. */
    subscribeOwn?(
      listener: (events: readonly RelayEvent[], complete: boolean) => void,
    ): () => void;
  };
  /** The read-state journal's cross-window channel: follow commits are
   * announced on it so other owners reload the shared journal. */
  broadcastName?: string | undefined;
}) {
  const synced =
    !!host?.decodeFollows && !!host.signFollows && !!host.publishFollows;
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let closed = false;
  let stored: StoredFollows = EMPTY_STORED;
  let clientId = "";
  /** Newest head of every coordinate we don't own, cached in the journal. */
  const peers = () => Object.values(stored.peers ?? {});
  let complete = false;
  // Startup gate (§6, Option 1): taps wait for this writer's first complete
  // recovery; set also refuses while an owned head is unreadable. Cached
  // choices still display.
  let ready = false;
  let merged: ThreadFollows | undefined;
  let snapshot: FollowSyncSnapshot = { status: "loading", complete: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;
  let work: Promise<unknown> = Promise.resolve();
  const queue = <T>(job: () => Promise<T>) => {
    const next = work.then(job);
    work = next.catch(() => {});
    return next;
  };
  const emit = () => {
    merged = undefined;
    if (!closed) for (const listener of listeners) notify(listener);
  };
  const health = (next: FollowSyncSnapshot) => {
    snapshot = next;
    emit();
  };
  const broadcast =
    broadcastName && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(broadcastName)
      : undefined;
  const settled = () =>
    health({
      status:
        !synced || !snapshotted()
          ? "local"
          : Object.keys(stored.state.edits).length ||
              Object.keys(stored.state.packets).length
            ? "pending"
            : "synchronized",
      complete,
    });
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : "Follow choices unavailable";
  /** One atomic journal transaction over the latest saved record. */
  async function save(
    change: (current: StoredFollows, journal: ReadJournal) => StoredFollows,
  ) {
    const saved = await storage.update((current) => {
      if (!current) throw new Error("Saved read state unavailable");
      const before = current.follows ?? EMPTY_STORED;
      const next = change(before, current);
      // One allocator with read-state packets (rules §3).
      const reserved = Math.max(next.state.reserved, current.lastCreatedAt);
      return {
        ...current,
        lastCreatedAt: Math.max(current.lastCreatedAt, next.state.reserved),
        follows: { ...next, state: { ...next.state, reserved } },
      };
    });
    stored = saved.follows ?? EMPTY_STORED;
    clientId = saved.clientId;
    broadcast?.postMessage(FOLLOWS_CHANGED);
    return saved;
  }
  /** Loads the latest journal into this owner without writing it back. */
  async function load() {
    const journal = await storage.update((current) => {
      if (!current) throw new Error("Saved read state unavailable");
      return current;
    });
    stored = journal.follows ?? EMPTY_STORED;
    clientId = journal.clientId;
    stored = { ...stored, state: hydrate(stored.state) };
    emit();
  }
  /** Before every allocation: the shared high-water from read state. */
  const shared = (current: StoredFollows, journal: ReadJournal) => ({
    ...current,
    state: hydrate({
      ...current.state,
      reserved: Math.max(current.state.reserved, journal.lastCreatedAt),
    }),
  });
  const decodeHead = (event: RelayEvent, payload: unknown): FollowHead => {
    let parsed: FollowPayload | undefined;
    try {
      parsed = payload === null ? undefined : parseFollowPayload(payload);
    } catch {
      parsed = undefined;
    }
    return { id: event.id, created_at: event.created_at, payload: parsed };
  };
  /** Newest full-order event per coordinate, then decoded in batches within
   * the host's 16-event and 512 KiB request limits. */
  async function decodeNewest(
    events: readonly RelayEvent[],
    signal: AbortSignal,
  ) {
    const newest = new Map<string, RelayEvent>();
    for (const event of events) {
      const coordinate = followCoordinate(event);
      if (event.pubkey !== viewer || !coordinate) continue;
      newest.set(coordinate, newer(newest.get(coordinate), event));
    }
    const heads: [string, FollowHead][] = [];
    let batch: RelayEvent[] = [];
    let bytes = 2;
    const drain = async () => {
      if (!batch.length || !host?.decodeFollows) return;
      const decoded = await host.decodeFollows(batch, signal);
      signal.throwIfAborted();
      if (decoded.length !== batch.length)
        throw new Error("Follow decode mismatch");
      for (const [index, event] of batch.entries()) {
        if (decoded[index]?.eventId !== event.id)
          throw new Error("Follow decode mismatch");
        heads.push([
          followCoordinate(event) as string,
          decodeHead(event, decoded[index]?.payload),
        ]);
      }
      batch = [];
      bytes = 2;
    };
    for (const event of newest.values()) {
      const size = encoder.encode(JSON.stringify(event)).byteLength + 1;
      if (batch.length >= DECODE_EVENTS || bytes + size > DECODE_BYTES)
        await drain();
      batch.push(event);
      bytes += size;
    }
    await drain();
    return heads;
  }
  /** Validated own events (snapshot, fetch or live echo) into the latest
   * journal: owned heads are observed, everything else is a cached peer. */
  async function ingest(events: readonly RelayEvent[], signal: AbortSignal) {
    const heads = await decodeNewest(events, signal);
    // Every own kind-30078 event read counts toward the shared snapshot
    // budget, read state included, so a follow write is admitted against
    // the growth this read just fetched.
    for (const event of events)
      if (event.pubkey === viewer && event.kind === 30078)
        capacity?.observeSize(event);
    if (!heads.length) return;
    await save((current, journal) => {
      let next = shared(current, journal);
      const peerHeads: Record<string, FollowHead> = { ...next.peers };
      for (const [coordinate, head] of heads) {
        const slot = coordinate.slice("thread-follows:".length);
        const owned = next.slots.includes(slot);
        const ours = head.payload?.clientId === journal.clientId;
        if (owned || (ours && next.slots.length < FOLLOW_SLOTS)) {
          // A readable head from another client in a slot we own is a
          // conflict: never adopt it or let it retire our work. Hold the
          // slot like an unreadable one (§5).
          const own =
            head.payload && !ours ? { ...head, payload: undefined } : head;
          next = {
            ...next,
            slots: owned ? next.slots : [...next.slots, slot],
            state: observe(next.state, slot, own),
          };
          delete peerHeads[coordinate];
        } else if (
          !peerHeads[coordinate] ||
          outranks(head, peerHeads[coordinate])
        )
          peerHeads[coordinate] = head;
      }
      return { ...next, peers: peerHeads };
    });
  }
  const ownUnreadable = (current: StoredFollows = stored) =>
    Object.values(current.state.heads).some((head) => !head.payload);
  const unreadable = () =>
    peers().some((head) => !head.payload) || ownUnreadable();
  const UNREADABLE = "Follow choices are unreadable on this device";
  const NOT_READY = "Follow choices are not ready. Connect and try again.";
  const INCOMPLETE =
    "Follow choices can't sync without a complete read of this account";
  /** Merged choices of every coordinate (rules: greater `at`, unfollow ties). */
  function choices(): ThreadFollows {
    if (merged) return merged;
    // Each owned slot is its own source, so slots merge by the protocol
    // rule, never by iteration order.
    const sources: ReadonlyMap<string, FollowEntry>[] = stored.slots.map(
      (slot) =>
        new Map(
          Object.entries(slotPayload(stored.state, slot, clientId).threads),
        ) as ReadonlyMap<string, FollowEntry>,
    );
    for (const head of peers())
      if (head.payload)
        sources.push(
          new Map(Object.entries(head.payload.threads)) as ReadonlyMap<
            string,
            FollowEntry
          >,
        );
    const out = mergeFollows(sources);
    // Before the first complete load, device-local choices still apply.
    if (!stored.imported)
      for (const [key, follow] of legacy.read())
        if (!out.has(key)) out.set(key, follow);
    merged = out;
    return out;
  }
  /** Stable placement: a key stays in its slot; new keys fill the first
   * slot with room, then a new owned slot, up to 16 owned slots (§7). The
   * prospective full slot is sized, so nothing unsendable is accepted. */
  function place(current: StoredFollows, key: string, follow: boolean) {
    const fits = (slot: string) => {
      const payload = slotPayload(current.state, slot, clientId);
      const prior = payload.threads[key];
      const entry = { ...prior, follow, at: MAX_AT };
      return (
        encoder.encode(
          plaintext({
            ...payload,
            threads: { ...payload.threads, [key]: entry },
          }),
        ).byteLength <= FOLLOW_PLAINTEXT_BYTES
      );
    };
    for (const slot of current.slots)
      if (
        current.state.edits[key]?.slot === slot ||
        current.state.heads[slot]?.payload?.threads[key]
      ) {
        if (!fits(slot)) throw new Error("Follow choices do not fit");
        return { current, slot };
      }
    for (const slot of current.slots)
      if (
        current.state.heads[slot]?.payload !== undefined ||
        !current.state.heads[slot]
      )
        if (fits(slot)) return { current, slot };
    if (current.slots.length >= FOLLOW_SLOTS)
      throw new Error("Follow choices are full");
    const slot = newSlotId();
    return { current: { ...current, slots: [...current.slots, slot] }, slot };
  }
  function schedule(delay = debounceMs) {
    if (closed || !synced || !snapshotted()) return;
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), delay);
  }
  const snapshotted = () => !!host?.communityId && !!reader.readStateSnapshot;
  const budget = (snapshot = false) =>
    AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(15000 + (snapshot ? LARGE_READ_DEADLINE_MS : 0)),
    ]);
  /** Fresh own heads, persisted before anything relies on them. Only the
   * complete authenticated snapshot counts as complete; the bounded tag read
   * is a fallback for hosts without one (NIP-RS). */
  async function recover(
    signal: AbortSignal,
    priority: "foreground" | "background",
  ) {
    if (snapshotted() && reader.readStateSnapshot) {
      await ingest(
        await reader.readStateSnapshot({ signal, priority, fresh: true }),
        signal,
      );
      ready = true;
      return true;
    }
    await ingest(
      await reader.read(
        [
          {
            kinds: [30078],
            authors: [viewer],
            "#t": ["thread-follows"],
            limit: 500,
          },
        ],
        { signal, priority, fresh: true },
      ),
      signal,
    );
    return false;
  }
  /** Publish every dirty slot and retry retained packets byte-for-byte,
   * after a fresh read of our own heads (read before write). */
  function flush(): Promise<void> {
    // Without the snapshot capability, choices stay local journal edits.
    if (
      closed ||
      !synced ||
      !snapshotted() ||
      !host?.signFollows ||
      !host.publishFollows
    )
      return Promise.resolve();
    if (sending) return sending;
    const signal = budget(snapshotted());
    const run = async () => {
      // Read before write, from the same complete snapshot as recovery.
      // Without it the bounded read only displays: nothing is published and
      // every edit and packet is kept (NIP-RS, §7).
      if (!(await recover(signal, "foreground"))) throw new Error(INCOMPLETE);
      complete = !unreadable();
      // Any unreadable or conflicting own head holds all follow publication
      // and keeps every edit and packet (§5, §7).
      if (ownUnreadable()) throw new Error(UNREADABLE);
      const errors: unknown[] = [];
      for (const packet of Object.values(stored.state.packets))
        if (packet.event !== undefined)
          await send(
            eventDto(packet.event),
            packet.payload,
            packet.slot,
            signal,
          ).catch((error: unknown) => errors.push(error));
      for (const slot of dirtySlots(stored.state))
        await compose(slot, signal).catch((error: unknown) =>
          errors.push(error),
        );
      if (errors.length) throw errors[0];
    };
    const task = queue(async () => {
      try {
        // Re-read a lost capacity basis before taking the shared publisher
        // lock: read state's refresh may be queued behind a flush that is
        // itself waiting for that lock.
        try {
          capacity?.admit([]);
        } catch {
          await capacity?.refresh();
        }
        await (lock ? lock(signal, run) : run());
        settled();
        // A successor may now be owed behind a resolved packet.
        if (dirtySlots(stored.state).length) schedule(0);
      } catch (error) {
        if (!closed)
          health({ status: "failed", complete, error: errorText(error) });
      }
    });
    sending = task.finally(() => {
      sending = undefined;
    });
    return sending;
  }
  async function compose(slot: string, signal: AbortSignal) {
    if (!host?.signFollows) return;
    // Capture and reserve in one transaction with the shared allocator.
    let frozen: NonNullable<ReturnType<typeof capture>>[1] | undefined;
    await save((current, journal) => {
      // Another window may have stored an unreadable owned head (§5).
      if (ownUnreadable(current)) throw new Error(UNREADABLE);
      const base = shared(current, journal);
      const captured = capture(
        base.state,
        slot,
        clientId || journal.clientId,
        now(),
      );
      if (!captured) return current;
      frozen = captured[1];
      return { ...base, state: captured[0] };
    });
    if (!frozen) return;
    const intent = frozen;
    const event = await host.signFollows(
      { slot, createdAt: intent.created_at, payload: wire(intent.payload) },
      signal,
    );
    signal.throwIfAborted();
    if (
      event.pubkey !== viewer ||
      followCoordinate(event) !== `thread-follows:${slot}` ||
      event.created_at !== intent.created_at
    )
      throw new Error("Follow signer changed identity or version");
    // Journal before send; a moved head or another writer's packet discards it.
    let journaled = false;
    await save((current) => {
      if (
        Object.values(current.state.packets).some(
          (packet) => packet.slot === slot,
        )
      )
        return current;
      const next = journalPacket(
        current.state,
        slot,
        { id: event.id, created_at: event.created_at, event },
        intent,
      );
      if (!next) return current;
      journaled = true;
      return { ...current, state: next };
    });
    if (!journaled) {
      // Rebuilt from the new head on the next flush.
      schedule(0);
      return;
    }
    await send(event, intent.payload, slot, signal);
  }
  async function send(
    event: RelayEvent,
    payload: FollowPayload,
    slot: string,
    signal: AbortSignal,
  ) {
    if (!host?.publishFollows) return;
    // Recheck the latest journal: an unreadable owned head stored by another
    // window since this flush began holds every slot (§5).
    await save((current) => {
      if (ownUnreadable(current)) throw new Error(UNREADABLE);
      return current;
    });
    // Preflight: never publish what would make the next snapshot impossible.
    capacity?.admit([event]);
    try {
      await host.publishFollows(event, signal);
    } catch (error) {
      // A definite refusal never lands: drop the packet so its edits are
      // recaptured with a fresh reservation. Unknown outcomes keep the exact bytes.
      if (
        error instanceof ReadStateTimestampRejected ||
        error instanceof PublishRejected
      )
        await save((current) => {
          const packets = { ...current.state.packets };
          delete packets[event.id];
          return { ...current, state: { ...current.state, packets } };
        });
      throw error;
    }
    // A positive OK for this exact ID acknowledges with the packet's payload.
    capacity?.observeSize(event);
    await save((current) => ({
      ...current,
      state: observe(current.state, slot, {
        id: event.id,
        created_at: event.created_at,
        payload,
      }),
    }));
  }
  /** After either complete recovery path: the legacy import once, then any
   * pending work, dirty slots and retained packets alike. */
  async function recovered() {
    // Legacy import once, after a complete merge, only for unsynced keys.
    if (complete && !stored.imported) {
      const local = legacy.read();
      const known = mergeFollows([
        ownChoices(stored.state, clientId),
        ...peers().map(
          (head) => new Map(Object.entries(head.payload?.threads ?? {})),
        ),
      ]);
      // Decided inside the transaction: another window may have imported,
      // or tapped a key, since this one read the relay.
      await save((current, journal) => {
        if (current.imported) return current;
        let next = shared(current, journal);
        const own = ownChoices(current.state, journal.clientId);
        let batch: number | undefined;
        for (const [key, follow] of local) {
          if (known.has(key) || own.has(key)) continue;
          const placed = place(next, key, follow);
          next = {
            ...placed.current,
            state: tap(
              placed.current.state,
              placed.slot,
              key,
              follow,
              now(),
              "legacy-import",
              batch,
            ),
          };
          batch ??= next.state.reserved;
        }
        return { ...next, imported: true };
      });
    }
    settled();
    if (
      dirtySlots(stored.state).length ||
      Object.keys(stored.state.packets).length
    )
      schedule(0);
  }
  async function refresh() {
    if (closed) return;
    return queue(async () => {
      try {
        // Cached choices show now; taps stay closed until recovery.
        await load();
        if (!synced) {
          health({ status: "local", complete: false });
          return;
        }
        const signal = budget(snapshotted());
        complete = (await recover(signal, "background")) && !unreadable();
        await recovered();
      } catch (error) {
        if (!closed)
          health({ status: "failed", complete, error: errorText(error) });
      }
    });
  }
  // Gap repair and reconnects: read state re-reads the complete snapshot,
  // and follow heads reconcile from that same read.
  const stopOwn = capacity?.subscribeOwn?.((events, full) => {
    if (!full || closed || !synced) return;
    void queue(async () => {
      try {
        await ingest(events, budget());
        // A complete snapshot, durably ingested, opens the startup gate.
        ready = true;
        complete = !unreadable();
        await recovered();
      } catch (error) {
        if (!closed)
          health({ status: "failed", complete, error: errorText(error) });
      }
    });
  });
  // Another window committed follow choices: reload, never echo.
  if (broadcast)
    broadcast.onmessage = (message: MessageEvent) => {
      if (message.data !== FOLLOWS_CHANGED || closed) return;
      void queue(async () => {
        try {
          await load();
        } catch (error) {
          if (!closed)
            health({ status: "failed", complete, error: errorText(error) });
        }
      });
    };
  return {
    read: choices,
    /** Legacy whole-map write: unsupported once synced. */
    write(next: ThreadFollows) {
      if (synced) throw new Error("Use set for synced follow choices");
      legacy.write(next);
      emit();
    },
    /** Saves one explicit choice; resolves only after it is durable (§3). */
    set(key: string, follow: boolean): Promise<void> {
      if (!synced) {
        const next = new Map(legacy.read());
        next.delete(key);
        next.set(key, follow);
        legacy.write(next);
        emit();
        return Promise.resolve();
      }
      // Local only: never queued behind signing, sending or reads (§3).
      return (async () => {
        // A relay without the snapshot keeps the tap as a local edit. Known
        // gap: a later full recovery can retire it if the bounded read missed
        // a newer own head.
        if (!ready && snapshotted()) throw new Error(NOT_READY);
        await save((current, journal) => {
          if (ownUnreadable(current)) throw new Error(UNREADABLE);
          const placed = place(shared(current, journal), key, follow);
          return {
            ...placed.current,
            state: tap(placed.current.state, placed.slot, key, follow, now()),
          };
        });
        settled();
        schedule();
      })();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      const stop = legacy.subscribe(emit);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    snapshot: () => snapshot,
    /** Health for the shared sync notice: later publication errors too. */
    syncHealth: () => snapshot,
    async retry() {
      await refresh();
      await flush();
    },
    refresh,
    flush,
    /** Live own events: echoes and other devices' slots. */
    accept(events: readonly RelayEvent[]) {
      if (
        closed ||
        !synced ||
        !events.some(
          (event) => event.pubkey === viewer && followCoordinate(event),
        )
      )
        return;
      void queue(async () => {
        try {
          await ingest(events, budget());
          complete = complete && !unreadable();
          settled();
          if (dirtySlots(stored.state).length) schedule();
        } catch (error) {
          if (!closed)
            health({ status: "failed", complete, error: errorText(error) });
        }
      });
    },
    dispose() {
      closed = true;
      broadcast?.close();
      stopOwn?.();
      clearTimeout(timer);
      lifetime.abort();
      listeners.clear();
    },
  };
}
export type ThreadFollowSync = ReturnType<typeof createThreadFollowSync>;
