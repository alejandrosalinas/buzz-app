import type { RelayEvent } from "./events.ts";
import { READ_SNAPSHOT_BYTES } from "./read-state-host.ts";

/** NIP-RS timestamps/counters are uint32, not timeline event-ID cursors. */
export const READ_STATE_MAX = 0xffff_ffff;
export const READ_STATE_KEYS = 10_000;
export const READ_STATE_EVENT_BYTES = 64 * 1024;
export const READ_STATE_PLAINTEXT_BYTES = 40 * 1024;
/** Frontiers older than this are pruned and every older message counts as read. */
export const READ_RETENTION_SECONDS = 30 * 24 * 60 * 60;
/** Maximum-size events one installation may own before it alone fills a snapshot. */
export const READ_STATE_SLOTS = READ_SNAPSHOT_BYTES / READ_STATE_EVENT_BYTES;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
export const uint32 = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= READ_STATE_MAX;
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const contextId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  // UTF-8 takes at most 3 bytes per UTF-16 unit: short strings need no encoding.
  (value.length <= 85 || bytes(value) <= 256);
export const slotId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

export type ReadTarget =
  | Readonly<{ kind: "channel"; channelId: string }>
  | Readonly<{ kind: "thread"; channelId: string; rootId: string }>
  | Readonly<{ kind: "message"; channelId: string; messageId: string }>;
export function targetKey(target: ReadTarget): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(target.channelId))
    throw new Error("Invalid read channel");
  if (target.kind === "channel") return target.channelId;
  const id = target.kind === "thread" ? target.rootId : target.messageId;
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid read event ID");
  return `${target.kind === "thread" ? "thread" : "msg"}:${id}`;
}
/** Only whole-channel override groups sync; message and thread unread stay local. */
export const channelContext = (key: string) =>
  /^[a-zA-Z0-9_-]{1,128}$/.test(key);
/** Drops `msg:` and `thread:` override groups: never evaluated, merged or carried. */
export function channelGroups<T extends Readonly<{ state: ReadState }>>(
  parsed: T,
): T {
  const overrides = Object.entries(parsed.state.overrides);
  if (overrides.every(([key]) => channelContext(key))) return parsed;
  return Object.freeze({
    ...parsed,
    state: Object.freeze({
      frontiers: parsed.state.frontiers,
      overrides: Object.freeze(
        Object.fromEntries(overrides.filter(([key]) => channelContext(key))),
      ),
    }),
  });
}
export type Override = Readonly<{
  set: number;
  clear: number;
  baseline: number;
}>;
export type ReadState = Readonly<{
  frontiers: Readonly<Record<string, number>>;
  overrides: Readonly<Record<string, Override>>;
}>;
export type ReadBlob = Readonly<{
  v: 1 | 2;
  client_id: string;
  contexts: Readonly<Record<string, number>>;
}>;
export type ParsedReadBlob = Readonly<{
  clientId: string;
  /** 1: read positions; 2: expiring channel unread groups with paired frontiers. */
  version?: 1 | 2;
  state: ReadState;
}>;
export const EMPTY_READ_STATE: ReadState = Object.freeze({
  frontiers: Object.freeze({}),
  overrides: Object.freeze({}),
});
const escapeContext = (key: string) =>
  /^(ov_|esc:)/.test(key) ? `esc:${key}` : key;
const unescapeContext = (key: string) =>
  key.startsWith("esc:") ? key.slice(4) : key;

/** Signature verification belongs to the transport. This is a structural selector only. */
export function readCoordinate(
  event: Pick<RelayEvent, "kind" | "tags">,
): string | undefined {
  if (event.kind !== 30078) return;
  const ds = event.tags.filter(([name]) => name === "d");
  const ts = event.tags.filter(
    ([name, value]) => name === "t" && value === "read-state",
  );
  const coordinate = ds[0]?.[1];
  return ds.length === 1 &&
    ts.length === 1 &&
    coordinate &&
    /^read-state:[0-9a-f]{32}$/.test(coordinate)
    ? coordinate
    : unreadCoordinate(event);
}
/** The version-2 expiring unread record: its own prefix, paired with its tag. */
export function unreadCoordinate(
  event: Pick<RelayEvent, "kind" | "tags">,
): string | undefined {
  if (event.kind !== 30078) return;
  const ds = event.tags.filter(([name]) => name === "d");
  const ts = event.tags.filter(
    ([name, value]) => name === "t" && value === UNREAD_TAG,
  );
  const coordinate = ds[0]?.[1];
  return ds.length === 1 &&
    ts.length === 1 &&
    coordinate &&
    /^read-state-unread-v2:[0-9a-f]{32}$/.test(coordinate)
    ? coordinate
    : undefined;
}
export const UNREAD_TAG = "read-state-unread-v2";

/**
 * Groups override siblings BEFORE invalid-entry dropping. Unknown versions fail closed.
 * A version-2 wire record keeps only complete channel groups with their own
 * valid paired frontier (0 included); `journal` hydrates saved state instead.
 */
export function parseReadBlob(raw: unknown, journal = false): ParsedReadBlob {
  if (
    !record(raw) ||
    (raw.v !== 1 && raw.v !== 2) ||
    typeof raw.client_id !== "string" ||
    [...raw.client_id].length < 1 ||
    [...raw.client_id].length > 64 ||
    !record(raw.contexts)
  )
    throw new Error("Unsupported read-state blob");
  const entries = Object.entries(raw.contexts);
  if (
    entries.length > READ_STATE_KEYS ||
    bytes(JSON.stringify(raw)) > 128 * 1024
  )
    throw new Error("Read-state blob exceeds capacity");
  const frontiers = new Map<string, number>();
  const groups = new Map<string, Map<string, unknown>>();
  for (const [key, value] of entries) {
    const prefix = /^(ov_s:|ov_c:|ov_b:)/.exec(key)?.[0];
    if (prefix) {
      const suffix = key.slice(5);
      const group = groups.get(suffix) ?? new Map();
      group.set(prefix, contextId(key) ? value : undefined);
      groups.set(suffix, group);
    } else if (!key.startsWith("ov_") && contextId(key) && uint32(value)) {
      const id = unescapeContext(key);
      frontiers.set(id, Math.max(frontiers.get(id) ?? 0, value));
    }
  }
  const overrides = new Map<string, Override>();
  for (const [key, group] of groups) {
    if (!contextId(key) || ![...group.values()].every(uint32)) continue;
    if (group.size === 1 && group.has("ov_c:"))
      overrides.set(
        key,
        Object.freeze({
          set: 0,
          clear: group.get("ov_c:") as number,
          baseline: 0,
        }),
      );
    else if (group.size === 3)
      overrides.set(
        key,
        Object.freeze({
          set: group.get("ov_s:") as number,
          clear: group.get("ov_c:") as number,
          baseline: group.get("ov_b:") as number,
        }),
      );
  }
  // Version-1 override keys are never imported, merged or carried.
  if (raw.v === 1) overrides.clear();
  else if (!journal) {
    const contexts = raw.contexts;
    frontiers.clear();
    for (const key of [...overrides.keys()]) {
      const frontier = contexts[escapeContext(key)];
      if (channelContext(key) && uint32(frontier)) frontiers.set(key, frontier);
      else overrides.delete(key);
    }
  }
  return Object.freeze({
    clientId: raw.client_id,
    version: raw.v,
    state: freezeState(frontiers, overrides),
  });
}
function freezeState(
  frontiers: Map<string, number>,
  overrides: Map<string, Override>,
): ReadState {
  return Object.freeze({
    frontiers: Object.freeze(Object.fromEntries(frontiers)),
    overrides: Object.freeze(Object.fromEntries(overrides)),
  });
}
/** No coordinate replacement, duplicate, or replay can rewind already merged intent. */
export function mergeReadStates(...states: readonly ReadState[]): ReadState {
  const frontiers = new Map<string, number>();
  const overrides = new Map<string, Override>();
  for (const state of states) {
    for (const [key, value] of Object.entries(state.frontiers))
      frontiers.set(key, Math.max(frontiers.get(key) ?? 0, value));
    for (const [key, value] of Object.entries(state.overrides)) {
      const old = overrides.get(key);
      overrides.set(
        key,
        Object.freeze({
          set: Math.max(old?.set ?? 0, value.set),
          clear: Math.max(old?.clear ?? 0, value.clear),
          baseline: Math.max(old?.baseline ?? 0, value.baseline),
        }),
      );
    }
  }
  if (frontiers.size + 3 * overrides.size > READ_STATE_KEYS)
    throw new Error("Read-state capacity reached; saved intent retained");
  return freezeState(frontiers, overrides);
}
/** The graph-supplied parent/root is never read from encrypted caller ancestry. */
export function effectiveFrontier(
  state: ReadState,
  key: string,
  channelId?: string,
  rootId?: string,
): number | undefined {
  const values = [
    state.frontiers[key],
    channelId === undefined ? undefined : state.frontiers[channelId],
    rootId === undefined ? undefined : state.frontiers[`thread:${rootId}`],
  ].filter((v): v is number => v !== undefined);
  return values.length ? Math.max(...values) : undefined;
}
export function overrideActive(
  value: Override | undefined,
  frontier: number | undefined,
): boolean {
  return (
    !!value &&
    value.set > 0 &&
    value.set > value.clear &&
    (frontier ?? 0) <= value.baseline
  );
}
export function advanceRead(
  state: ReadState,
  key: string,
  timestamp: number,
): ReadState {
  if (!contextId(key) || !uint32(timestamp))
    throw new Error("Invalid read frontier");
  return mergeReadStates(state, {
    frontiers: { [key]: timestamp },
    overrides: {},
  });
}
/** Code-unit order, so every client sorts keys identically. */
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Canonical floors are permanent. Never call on a partial snapshot for publication. */
export function readBlob(
  clientId: string,
  state: ReadState,
  frontier: (key: string) => number | undefined,
): ReadBlob {
  const contexts: Record<string, number> = Object.fromEntries(
    Object.entries(state.frontiers)
      .sort(([a], [b]) => byKey(a, b))
      .map(([key, value]) => [escapeContext(key), value]),
  );
  for (const [key, value] of Object.entries(state.overrides).sort(([a], [b]) =>
    byKey(a, b),
  )) {
    if (!contextId(`ov_s:${key}`))
      throw new Error("Read override key exceeds capacity");
    if (overrideActive(value, frontier(key))) {
      contexts[`ov_s:${key}`] = value.set;
      contexts[`ov_c:${key}`] = value.clear;
      contexts[`ov_b:${key}`] = value.baseline;
    } else if (value.set || value.clear)
      contexts[`ov_c:${key}`] = Math.max(value.set, value.clear);
  }
  const blob = Object.freeze({
    v: 1 as const,
    client_id: clientId,
    contexts: Object.freeze(contexts),
  });
  parseReadBlob(blob);
  if (bytes(JSON.stringify(blob)) > READ_STATE_PLAINTEXT_BYTES)
    throw new Error(
      "Read-state publication capacity reached; saved intent retained",
    );
  return blob;
}
export type ReadSlotPlan = Readonly<{
  slot: string;
  frontiers: Readonly<Record<string, number>>;
}>;
/**
 * Places frontiers into an installation's slots without ever dropping one.
 * A key keeps the slot whose observed blob already carries it, so a new key
 * can never move a sole carrier between coordinates mid-publication. Other
 * keys fill the first slot with room in key order, then new slots.
 */
export function packReadState(
  clientId: string,
  frontiers: Readonly<Record<string, number>>,
  slots: readonly Readonly<{ slot: string; carried: readonly string[] }>[],
  newSlot: () => string,
  maxBytes = READ_STATE_PLAINTEXT_BYTES,
  /** Placed in the first slot before anything else: override groups' blob. */
  primary?: ReadBlob,
): ReadSlotPlan[] {
  const base = bytes(
    JSON.stringify({ v: 1, client_id: clientId, contexts: {} }),
  );
  const bins = slots.map(({ slot }) => ({
    slot,
    frontiers: {} as Record<string, number>,
    used: base,
  }));
  const pinned = new Set<string>();
  if (primary && Object.keys(primary.contexts).length) {
    const first = bins[0];
    if (!first) throw new Error("Read-state primary slot missing");
    first.used = bytes(JSON.stringify(primary));
    // Each group's paired frontier stays in the primary, own or not.
    for (const [key, value] of Object.entries(primary.contexts))
      if (!key.startsWith("ov_")) {
        const id = unescapeContext(key);
        pinned.add(id);
        first.frontiers[id] = Math.max(value, frontiers[id] ?? 0);
      }
  }
  const home = new Map<string, number>();
  slots.forEach(({ carried }, index) => {
    for (const key of carried) if (!home.has(key)) home.set(key, index);
  });
  const add = (bin: (typeof bins)[number], key: string, value: number) => {
    const size =
      bytes(JSON.stringify(escapeContext(key))) +
      1 +
      String(value).length +
      (bin.used > base ? 1 : 0);
    if (bin.used + size > maxBytes) return false;
    bin.frontiers[key] = value;
    bin.used += size;
    return true;
  };
  const keys = Object.keys(frontiers)
    .filter((key) => !pinned.has(key))
    .sort(byKey);
  const rest = keys.filter((key) => {
    const bin = bins[home.get(key) ?? -1];
    return !bin || !add(bin, key, frontiers[key] as number);
  });
  for (const key of rest) {
    const value = frontiers[key] as number;
    if (bins.some((bin) => add(bin, key, value))) continue;
    const bin = { slot: newSlot(), frontiers: {}, used: base };
    if (!add(bin, key, value))
      throw new Error("Read frontier exceeds publication capacity");
    bins.push(bin);
  }
  return bins.map(({ slot, frontiers }) => ({ slot, frontiers }));
}
/** Wait rather than manufacture unbounded future timestamps on rapid/backward clocks. */
export function readVersion(now: number, previous: number): number {
  const next = Math.max(now, previous + 1);
  if (!uint32(next) || next > now + 60)
    throw new Error(
      "Read-state clock is ahead; retry when the clock catches up",
    );
  return next;
}

// Expiring unread state (version 2). Stamps are uint32 Unix seconds.
export const UNREAD_LIFETIME = READ_RETENTION_SECONDS;
export const UNREAD_DISCARD_GUARD = 600;
export const UNREAD_DEFER_AHEAD = 660;
export const UNREAD_ALLOCATE_AHEAD = 60;
const stamp = (value: Override) => Math.max(value.set, value.clear);
/** Live at `S == clock - lifetime`; `clock` is max(now, durable watermark). */
export function unreadActive(
  value: Override | undefined,
  frontier: number | undefined,
  clock: number,
): boolean {
  return (
    overrideActive(value, frontier) &&
    (value as Override).set >= clock - UNREAD_LIFETIME
  );
}
export const unreadExpired = (value: Override, clock: number) =>
  stamp(value) < clock - UNREAD_LIFETIME;
/** Retained at equality with the guard. */
export const unreadDiscardable = (value: Override, clock: number) =>
  stamp(value) < clock - UNREAD_LIFETIME - UNREAD_DISCARD_GUARD;
/** A dead group is the tombstone `C = K = max(S, C)`. */
export function unreadCanonical(
  value: Override,
  frontier: number | undefined,
  clock: number,
): Override {
  return unreadActive(value, frontier, clock) ||
    (value.set === 0 && value.baseline === 0)
    ? value
    : Object.freeze({ set: 0, clear: stamp(value), baseline: 0 });
}
/** Raw local `now`, never advanced by received stamps. Null: refused. */
export function unreadStamp(value: Override | undefined, now: number) {
  const next = Math.max(now, (value ? stamp(value) : 0) + 1);
  return next > now + UNREAD_ALLOCATE_AHEAD || !uint32(next) ? null : next;
}
/** An incoming group, before its baseline may merge. Checks max(S,C) only. */
export function unreadReceive(value: Override, now: number) {
  const greatest = stamp(value);
  return greatest < now - UNREAD_LIFETIME
    ? ("drop" as const)
    : greatest > now + UNREAD_DEFER_AHEAD
      ? ("defer" as const)
      : ("merge" as const);
}
/** Canonical groups with discardable ones removed, expiry applied at `clock`. */
export function unreadGroups(
  groups: ReadState["overrides"],
  frontier: (key: string) => number | undefined,
  clock: number,
): ReadState["overrides"] {
  const kept: Record<string, Override> = {};
  for (const [key, value] of Object.entries(groups)) {
    if (!channelContext(key) || unreadDiscardable(value, clock)) continue;
    kept[key] = unreadCanonical(value, frontier(key), clock);
  }
  return Object.freeze(kept);
}
/** The version-2 plaintext: each group with its merged stored frontier, 0
 * when never read. Throws rather than evict when it cannot fit. */
export function unreadBlob(
  clientId: string,
  groups: ReadState["overrides"],
  frontier: (key: string) => number | undefined,
  clock: number,
): ReadBlob {
  const canonical = unreadGroups(groups, frontier, clock);
  const frontiers = Object.fromEntries(
    Object.keys(canonical).map((key) => [key, frontier(key) ?? 0]),
  );
  const blob = readBlob(clientId, { frontiers, overrides: canonical }, (key) =>
    frontier(key),
  );
  return Object.freeze({ ...blob, v: 2 as const });
}
