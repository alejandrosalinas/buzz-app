import { READ_STATE_MAX, record, uint32 } from "./read-state-model.ts";

/** NIP-RS "Buzz Thread Follow Choices": one installation's own-slot recovery
 * state, kept as three separate authorities (rules: PLANS
 * READ_STATE_FOLLOW_SYNC_RULES_2026_11_14 §2):
 * - `heads`: the accepted own head per coordinate, exactly as published;
 * - `edits`: durable pending choices, each with its reservation `r`;
 * - `packets`: the exact signed packet captured by an in-flight send.
 * Pure: callers persist the returned state atomically before acting on it. */

export const FOLLOW_PLAINTEXT_BYTES = 40 * 1024;
export const FOLLOW_SLOTS = 16;
/** The signing host's created_at window. */
export const FOLLOW_CLOCK_SKEW = 60;

export type FollowEntry = Readonly<{
  follow: boolean;
  at: number;
  /** Unknown entry fields, carried unchanged. */
  extra?: Readonly<Record<string, unknown>>;
}>;
export type FollowPayload = Readonly<{
  clientId: string;
  threads: Readonly<Record<string, FollowEntry>>;
  /** Unknown top-level fields of this slot, carried unchanged. */
  extra?: Readonly<Record<string, unknown>>;
}>;
export type EventVersion = Readonly<{ id: string; created_at: number }>;
export type FollowHead = EventVersion &
  Readonly<{ payload: FollowPayload | undefined }>;
export type FollowEdit = Readonly<{
  slot: string;
  entry: FollowEntry;
  r: number;
  origin: "explicit" | "legacy-import";
  basis: EventVersion | "empty";
}>;
export type FollowPacket = EventVersion &
  Readonly<{
    slot: string;
    payload: FollowPayload;
    captured: Readonly<Record<string, number>>;
    /** The complete signed event, replayed byte-for-byte. */
    event?: unknown;
  }>;
export type FollowSyncState = Readonly<{
  /** Own head per slot. `payload: undefined` is a recognized unreadable head. */
  heads: Readonly<Record<string, FollowHead>>;
  edits: Readonly<Record<string, FollowEdit>>;
  packets: Readonly<Record<string, FollowPacket>>;
  /** Shared allocator high-waters; neither ever lowers. */
  reserved: number;
  observed: number;
}>;

export const EMPTY_FOLLOW_SYNC: FollowSyncState = Object.freeze({
  heads: {},
  edits: {},
  packets: {},
  reserved: 0,
  observed: 0,
});

/** Full event order within one coordinate: newer `created_at`, then lower ID. */
export function outranks(a: EventVersion, b: EventVersion | undefined) {
  if (!b) return true;
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  return a.id.toLowerCase() < b.id.toLowerCase();
}

/** `r = max(now, observed + 1, reserved + 1)`; never wraps or reuses. */
export function reserve(
  state: FollowSyncState,
  now: number,
): [FollowSyncState, number] {
  const r = Math.max(now, state.observed + 1, state.reserved + 1);
  if (!uint32(r) || r > READ_STATE_MAX)
    throw new Error("Follow choice timestamps are exhausted");
  return [{ ...state, reserved: r }, r];
}

/** Raises the allocator to every retained edit and packet (hydration, §2). */
export function hydrate(state: FollowSyncState): FollowSyncState {
  const reserved = Math.max(
    state.reserved,
    ...Object.values(state.edits).map((edit) => edit.r),
    ...Object.values(state.packets).map((packet) => packet.created_at),
  );
  const observed = Math.max(
    state.observed,
    ...Object.values(state.heads).map((head) => head.created_at),
  );
  return { ...state, reserved, observed };
}

/** Accepts one explicit choice. Unknown entry fields of the edited key are
 * kept; only `follow` and `at` change. Throws on an unreadable own slot. */
export function tap(
  state: FollowSyncState,
  slot: string,
  key: string,
  follow: boolean,
  now: number,
  origin: FollowEdit["origin"] = "explicit",
  /** One reservation shared by a batch of distinct keys saved together
   * (legacy import), so a large import doesn't run the clock ahead. */
  shared?: number,
): FollowSyncState {
  const head = state.heads[slot];
  if (head && !head.payload)
    throw new Error("Follow choices are unreadable on this device");
  const previous =
    state.edits[key]?.slot === slot
      ? state.edits[key]?.entry
      : head?.payload?.threads[key];
  const [next, r] =
    shared === undefined ? reserve(state, now) : [state, shared];
  const at = origin === "legacy-import" ? 0 : now;
  if (!uint32(at)) throw new Error("Invalid follow choice time");
  return {
    ...next,
    edits: {
      ...next.edits,
      [key]: {
        slot,
        entry: {
          follow,
          at,
          ...(previous?.extra ? { extra: previous.extra } : {}),
        },
        r,
        origin,
        basis: head ? { id: head.id, created_at: head.created_at } : "empty",
      },
    },
  };
}

/** The slot's candidate payload: its head plus EVERY pending edit for it,
 * including edits already captured by an unacknowledged packet (§7). */
export function slotPayload(
  state: FollowSyncState,
  slot: string,
  clientId: string,
): FollowPayload {
  const head = state.heads[slot]?.payload;
  const threads: Record<string, FollowEntry> = { ...head?.threads };
  for (const [key, edit] of Object.entries(state.edits))
    if (edit.slot === slot) threads[key] = edit.entry;
  return {
    clientId: head?.clientId ?? clientId,
    threads,
    ...(head?.extra ? { extra: head.extra } : {}),
  };
}

export function plaintext(payload: FollowPayload) {
  const threads: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(payload.threads))
    threads[key] = { ...entry.extra, follow: entry.follow, at: entry.at };
  return JSON.stringify({
    ...payload.extra,
    v: 1,
    client_id: payload.clientId,
    threads,
  });
}

/** Slots with pending edits that no unresolved packet already carries. */
export function dirtySlots(state: FollowSyncState): string[] {
  const slots = new Set<string>();
  for (const [key, edit] of Object.entries(state.edits)) {
    const packet = Object.values(state.packets).find(
      (candidate) => candidate.slot === edit.slot,
    );
    if (packet?.captured[key] !== edit.r) slots.add(edit.slot);
  }
  return [...slots];
}

/** Freezes a packet for `slot` at a fresh reservation later than every edit
 * it captures. Returns undefined while that slot still has an unresolved
 * packet: successors wait for it (§4.5). The caller signs `payload` at
 * `created_at`, then `journal`s the signed event before sending. */
export function capture(
  state: FollowSyncState,
  slot: string,
  clientId: string,
  now: number,
):
  | [
      FollowSyncState,
      Readonly<{
        created_at: number;
        payload: FollowPayload;
        captured: Readonly<Record<string, number>>;
        basis: EventVersion | undefined;
      }>,
    ]
  | undefined {
  const head = state.heads[slot];
  if (head && !head.payload)
    throw new Error("Follow choices are unreadable on this device");
  if (Object.values(state.packets).some((packet) => packet.slot === slot))
    return undefined;
  const captured: Record<string, number> = {};
  for (const [key, edit] of Object.entries(state.edits))
    if (edit.slot === slot) captured[key] = edit.r;
  if (!Object.keys(captured).length) return undefined;
  const payload = slotPayload(state, slot, clientId);
  if (
    new TextEncoder().encode(plaintext(payload)).byteLength >
    FOLLOW_PLAINTEXT_BYTES
  )
    throw new Error("Follow choices do not fit");
  const [next, created_at] = reserve(state, now);
  // The host refuses created_at more than 60s from now; never clamp below the
  // reservation, which would let an older-looking packet lose to a seen head.
  if (created_at - now > FOLLOW_CLOCK_SKEW)
    throw new Error("Follow choices are ahead of this device's clock");
  return [
    next,
    {
      created_at,
      payload,
      captured,
      basis: head ? { id: head.id, created_at: head.created_at } : undefined,
    },
  ];
}

/** Records the signed packet; refuses one composed on a superseded basis. */
export function journal(
  state: FollowSyncState,
  slot: string,
  signed: EventVersion & { event?: unknown },
  frozen: NonNullable<ReturnType<typeof capture>>[1],
): FollowSyncState | undefined {
  const head = state.heads[slot];
  if (head?.id !== frozen.basis?.id) return undefined;
  if (signed.created_at !== frozen.created_at)
    throw new Error("Signed follow packet changed its timestamp");
  return {
    ...state,
    packets: {
      ...state.packets,
      [signed.id]: {
        id: signed.id,
        created_at: signed.created_at,
        slot,
        payload: frozen.payload,
        captured: frozen.captured,
        ...(signed.event === undefined ? {} : { event: signed.event }),
      },
    },
  };
}

/** A validated owned head for `slot` — echo, fetch, or ID-specific relay OK
 * (pass the packet's own payload). `payload: undefined` is unreadable. */
export function observe(
  state: FollowSyncState,
  slot: string,
  incoming: FollowHead,
): FollowSyncState {
  const edits: Record<string, FollowEdit> = { ...state.edits };
  const packets: Record<string, FollowPacket> = { ...state.packets };
  const exact = packets[incoming.id];
  const readable = incoming.payload !== undefined;
  // 1. An identical ID acknowledges that exact packet and only the
  //    generations it captured that are still current.
  // A newer unreadable head already in the journal holds everything (§5).
  const held = state.heads[slot];
  const blocked = !!held && !held.payload && !outranks(incoming, held);
  if (exact && exact.slot === slot && readable && !blocked) {
    delete packets[incoming.id];
    for (const [key, r] of Object.entries(exact.captured))
      if (edits[key]?.r === r) delete edits[key];
  }
  // 2. Advance the head only on outranking arrival.
  const current = state.heads[slot];
  const heads = { ...state.heads };
  if (outranks(incoming, current)) heads[slot] = incoming;
  const accepted = heads[slot];
  if (accepted?.payload) {
    // 3. Retire edits on this coordinate covered by the accepted head.
    for (const [key, edit] of Object.entries(edits))
      if (edit.slot === slot && edit.r <= accepted.created_at)
        delete edits[key];
    // 4. Packets below the accepted head are superseded, never re-signed.
    for (const [id, packet] of Object.entries(packets))
      if (packet.slot === slot && !outranks(packet, accepted))
        delete packets[id];
  }
  // Unreadable: hold edits and packets; publication is blocked (§5).
  return {
    heads,
    edits,
    packets,
    reserved: state.reserved,
    observed: Math.max(state.observed, incoming.created_at),
  };
}

/** Own effective choices across owned slots: each slot's head plus pending edits. */
export function ownChoices(
  state: FollowSyncState,
  clientId: string,
): Map<string, FollowEntry> {
  const out = new Map<string, FollowEntry>();
  const slots = new Set([
    ...Object.keys(state.heads),
    ...Object.values(state.edits).map((edit) => edit.slot),
  ]);
  for (const slot of slots)
    for (const [key, entry] of Object.entries(
      slotPayload(state, slot, clientId).threads,
    ))
      out.set(key, entry);
  return out;
}

/** Cross-slot merge (unchanged NIP-RS rule): greater `at`, unfollow on ties. */
export function mergeFollows(
  slots: Iterable<ReadonlyMap<string, FollowEntry>>,
): Map<string, boolean> {
  const best = new Map<string, FollowEntry>();
  for (const slot of slots)
    for (const [key, entry] of slot) {
      const prior = best.get(key);
      if (
        !prior ||
        entry.at > prior.at ||
        (entry.at === prior.at && !entry.follow)
      )
        best.set(key, entry);
    }
  return new Map([...best].map(([key, entry]) => [key, entry.follow]));
}

const FOLLOW_KEY = /^[a-zA-Z0-9_-]{1,128}:[0-9a-f]{64}$/;
/** Parses a decrypted plaintext; throws when the coordinate is unreadable. */
export function parseFollowPayload(raw: unknown): FollowPayload {
  if (
    !record(raw) ||
    raw.v !== 1 ||
    typeof raw.client_id !== "string" ||
    raw.client_id.length < 1 ||
    [...raw.client_id].length > 64
  )
    throw new Error("Unreadable follow choices");
  const { v: _v, client_id, threads: rawThreads, ...extra } = raw;
  if (!record(rawThreads)) throw new Error("Unreadable follow choices");
  const threads: Record<string, FollowEntry> = {};
  for (const [key, value] of Object.entries(rawThreads)) {
    if (!FOLLOW_KEY.test(key) || !record(value))
      throw new Error("Unreadable follow choices");
    const { follow, at, ...rest } = value;
    if (typeof follow !== "boolean" || !uint32(at))
      throw new Error("Unreadable follow choices");
    threads[key] = {
      follow,
      at,
      ...(Object.keys(rest).length ? { extra: rest } : {}),
    };
  }
  return {
    clientId: client_id,
    threads,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}
