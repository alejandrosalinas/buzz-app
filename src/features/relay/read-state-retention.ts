import {
  mergeReadStates,
  READ_STATE_KEYS,
  type ReadState,
} from "./read-state-model";

/** The mark that already reads all `key` reads, if any. `frontier` looks up
 * marks that are being kept, plus `key` itself. */
export type CoveredFrontier = (
  key: string,
  frontier: (key: string) => number | undefined,
) => string | undefined;
/** The message a mark is about. Message, thread and thread catch-up marks
 * each name one message (a thread names its root); other marks name none. */
export function markMessage(key: string): string | undefined {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  return separator > 0 &&
    (kind === "msg" || kind === "thread" || kind === "thread-activity")
    ? key.slice(separator + 1) || undefined
    : undefined;
}
/** Broader marks first: a channel or thread mark covers many messages, so
 * losing one makes old history unread again. Catch-up marks (`activity:`,
 * `thread-activity:`) come next: only this app reads them, so recent catch-up
 * must never push out a quiet channel's mark. Message marks only cover one.
 * Row marks (`seen:`) read nothing, so losing one only relights a row. */
const scope = (key: string) =>
  !key.includes(":")
    ? 0
    : key.startsWith("thread:")
      ? 1
      : key.startsWith("activity:") || key.startsWith("thread-activity:")
        ? 2
        : key.startsWith("seen:")
          ? 4
          : 3;
/** Share of the budget that broad marks may fill before recent use decides.
 * The rest always goes to the most recently used marks, so a new read is never
 * dropped just because old channel or thread marks fill the budget. */
const SCOPED_SHARE = 0.75;
/** Frontier hints are bounded recent activity, not an everlasting receipt log (NIP-RS).
 * Up to `SCOPED_SHARE` of the budget, channel marks outrank thread marks, then
 * catch-up marks, then message marks. The rest goes by local interaction order,
 * which wins over event time so reading old history still synchronizes.
 * Every override group and its direct frontier is protected; pressure can never lose a floor.
 *
 * Marks that `covered` proves redundant are dropped only after the budget has
 * chosen what to keep, and only when their covering mark was kept. The freed
 * space then goes to the next marks in line. A dropped mark gives its recency
 * to its cover, so a smaller limit later (such as the synced one) protects the
 * cover as it would have protected the dropped read.
 */
export function retainRead(
  states: readonly ReadState[],
  recent: Readonly<Record<string, number>>,
  clientId: string,
  maxBytes = 96 * 1024,
  covered?: CoveredFrontier,
): { state: ReadState; recent: Readonly<Record<string, number>> } {
  const frontiers = new Map<string, number>();
  let protectedState: ReadState = { frontiers: {}, overrides: {} };
  for (const state of states) {
    for (const [key, value] of Object.entries(state.frontiers))
      frontiers.set(key, Math.max(frontiers.get(key) ?? 0, value));
    protectedState = mergeReadStates(protectedState, {
      frontiers: {},
      overrides: state.overrides,
    });
  }
  // Overrides make inherited ancestry load-bearing (see below); keep everything then.
  const coveredBy = Object.keys(protectedState.overrides).length
    ? undefined
    : covered;
  const encoder = new TextEncoder();
  let used = encoder.encode(
    JSON.stringify({ v: 1, client_id: clientId, contexts: {} }),
  ).byteLength;
  let keys = 0;
  const retained = new Map<string, number>();
  const frontierKey = (key: string) =>
    /^(ov_|esc:)/.test(key) ? `esc:${key}` : key;
  // Separators are counted per entry, so release can return exactly what take spent.
  const cost = (key: string, value: number) =>
    encoder.encode(JSON.stringify(key)).byteLength + 2 + String(value).length;
  const take = (key: string, value: number, share = 1) => {
    const size = cost(key, value);
    if (used + size > maxBytes * share || keys >= READ_STATE_KEYS * share)
      return false;
    used += size;
    keys++;
    return true;
  };
  for (const [key, value] of Object.entries(protectedState.overrides)) {
    for (const [prefix, timestamp] of [
      ["ov_s:", value.set],
      ["ov_c:", value.clear],
      ["ov_b:", value.baseline],
    ] as const)
      if (!take(`${prefix}${key}`, timestamp))
        throw new Error(
          "Read override capacity reached; saved floors retained",
        );
    const frontier = frontiers.get(key);
    if (frontier !== undefined) {
      if (!take(frontierKey(key), frontier))
        throw new Error(
          "Read override capacity reached; saved floors retained",
        );
      retained.set(key, frontier);
    }
  }
  // Encrypted registers do not carry trustworthy ancestry. Preserve every possible
  // inherited channel/thread frontier while any override exists: pruning a parent
  // could otherwise reactivate a child register. Only frontier-only msg hints,
  // and row marks, which no register inherits, are free.
  if (Object.keys(protectedState.overrides).length) {
    for (const [key, value] of frontiers) {
      if (
        retained.has(key) ||
        key.startsWith("msg:") ||
        key.startsWith("seen:")
      )
        continue;
      if (!take(frontierKey(key), value))
        throw new Error(
          "Read override ancestry capacity reached; saved floors retained",
        );
      retained.set(key, value);
    }
  }
  const nextRecent: Record<string, number> = { ...recent };
  const byUse = ([a, av]: [string, number], [b, bv]: [string, number]) =>
    Number(a.startsWith("seen:")) - Number(b.startsWith("seen:")) ||
    (nextRecent[b] ?? 0) - (nextRecent[a] ?? 0) ||
    bv - av ||
    a.localeCompare(b);
  const scoped = [...frontiers].sort(
    (a, b) => scope(a[0]) - scope(b[0]) || byUse(a, b),
  );
  const byRecent = [...frontiers].sort(byUse);
  const dropped = new Set<string>();
  // Each kept mark's coverage answer, and the kept marks that answer read.
  // A pure `covered` can only answer differently once one of those marks
  // enters or leaves the kept set, so each round asks again only about
  // those marks. The rounds and their results stay exactly the same.
  const coverOf = new Map<string, string | undefined>();
  const readers = new Map<string, Set<string>>();
  const keep = (key: string, value: number) => {
    retained.set(key, value);
    for (const reader of readers.get(key) ?? []) coverOf.delete(reader);
  };
  const release = (key: string) => {
    retained.delete(key);
    coverOf.delete(key);
    for (const reader of readers.get(key) ?? []) coverOf.delete(reader);
  };
  const keptCover = (key: string, value: number) => {
    if (coverOf.has(key)) return coverOf.get(key);
    const read = (other: string) => {
      const set = readers.get(other) ?? new Set<string>();
      readers.set(other, set);
      set.add(key);
    };
    const answer = coveredBy?.(key, (other) => {
      read(other);
      return other === key ? value : retained.get(other);
    });
    if (answer !== undefined) read(answer);
    const cover =
      answer !== undefined && answer !== key && retained.has(answer)
        ? answer
        : undefined;
    coverOf.set(key, cover);
    return cover;
  };
  const select = () => {
    for (const [key, value] of scoped) {
      if (retained.has(key) || dropped.has(key)) continue;
      // Stop at the first broad mark that does not fit, so a narrower mark
      // never takes the share ahead of it.
      if (!take(frontierKey(key), value, SCOPED_SHARE)) break;
      keep(key, value);
    }
    for (const [key, value] of byRecent)
      if (
        !retained.has(key) &&
        !dropped.has(key) &&
        take(frontierKey(key), value)
      )
        keep(key, value);
  };
  select();
  // Refilling can keep more covered marks, so repeat until nothing drops.
  let pruned = true;
  while (coveredBy && pruned) {
    pruned = false;
    // Prune against the kept marks only: a cover that did not fit cannot
    // replace anything. Decide on one snapshot so a cover is never pruned
    // after it has already replaced another mark.
    const covers = new Map<string, string>();
    for (const [key, value] of retained) {
      const cover = keptCover(key, value);
      if (cover !== undefined) covers.set(key, cover);
    }
    // A cover that is itself covered passes the recency on to what replaced it.
    const final = (key: string) => {
      let cover = covers.get(key) ?? key;
      for (let hops = 0; covers.has(cover) && hops < covers.size; hops++)
        cover = covers.get(cover) as string;
      return cover;
    };
    for (const key of covers.keys()) {
      const cover = final(key);
      if (cover === key || covers.has(cover)) continue;
      const value = retained.get(key) as number;
      release(key);
      dropped.add(key);
      pruned = true;
      used -= cost(frontierKey(key), value);
      keys--;
      if (nextRecent[key] !== undefined)
        nextRecent[cover] = Math.max(nextRecent[cover] ?? 0, nextRecent[key]);
    }
    if (pruned) select();
  }
  const state = Object.freeze({
    frontiers: Object.freeze(Object.fromEntries(retained)),
    overrides: protectedState.overrides,
  });
  return {
    state,
    recent: Object.freeze(
      Object.fromEntries(
        Object.entries(nextRecent).filter(([key]) => retained.has(key)),
      ),
    ),
  };
}
/** `retainRead` when the caller keeps no recency, such as a publication. */
export function retainReadState(
  states: readonly ReadState[],
  recent: Readonly<Record<string, number>>,
  clientId: string,
  maxBytes?: number,
  covered?: CoveredFrontier,
): ReadState {
  return retainRead(states, recent, clientId, maxBytes, covered).state;
}

/** Local-only receipts evicted from the sync journal. Never passed to publication. */
export const READ_RESERVE_KEYS = 5000;
export const READ_RESERVE_BYTES = 512 * 1024;
/**
 * The local read set: the journal (`retainRead`) plus the reserve, with a
 * read-through `floor`. Every message at or before the floor counts as read
 * on this installation, so a mark that capacity drops raises the floor to its
 * own time rather than making what it read unread again. The reserve keeps
 * the newest marks, so the floor rises as little as it can. A mark at or
 * below the floor reads nothing more and is dropped, unless overrides make
 * inherited marks load-bearing.
 */
export function retainLocalRead(
  states: readonly ReadState[],
  recent: Readonly<Record<string, number>>,
  clientId: string,
  reserve: Readonly<Record<string, number>> = {},
  covered?: CoveredFrontier,
  floor = 0,
) {
  const overrides = new Set(
    states.flatMap((state) => Object.keys(state.overrides)),
  );
  const below = (value: number) => !overrides.size && value <= floor;
  const frontiers = new Map(
    Object.entries(reserve).filter(([, value]) => !below(value)),
  );
  const returning: Record<string, number> = {};
  const current: ReadState[] = [];
  for (const state of states) {
    const kept: Record<string, number> = {};
    for (const [key, value] of Object.entries(state.frontiers)) {
      if (below(value)) continue;
      kept[key] = value;
      const previous = frontiers.get(key);
      if (previous !== undefined) returning[key] = previous;
      frontiers.set(key, Math.max(previous ?? 0, value));
    }
    current.push({ frontiers: kept, overrides: state.overrides });
  }
  // Direct override floors belong in the journal. Possible inherited floors
  // stay protected in the reserve instead of overflowing the smaller journal.
  for (const key of overrides) {
    const value = frontiers.get(key);
    if (value !== undefined) returning[key] = value;
  }
  const kept = retainRead(
    [...current, { frontiers: returning, overrides: {} }],
    recent,
    clientId,
    undefined,
    covered,
  );
  for (const key of Object.keys(kept.state.frontiers)) frontiers.delete(key);
  const encoder = new TextEncoder();
  let bytes = 2;
  const entries: [string, number][] = [];
  const accepted = new Map<string, number>();
  // A mark that a kept broader mark already reads is redundant here too, as
  // in the journal: keep it and it only takes room from real reads. A cover
  // reads through at least the time of what it covers, so newest first,
  // then broader scope at equal times, accepts it before what it covers.
  // Overrides make inherited ancestry load-bearing; keep everything then.
  const coveredBy = overrides.size ? undefined : covered;
  const redundant = (key: string, value: number) => {
    const cover = coveredBy?.(key, (other) =>
      other === key
        ? value
        : (kept.state.frontiers[other] ?? accepted.get(other)),
    );
    return (
      cover !== undefined &&
      cover !== key &&
      (kept.state.frontiers[cover] !== undefined || accepted.has(cover))
    );
  };
  const protectedKey = (key: string) =>
    overrides.size > 0 && !key.startsWith("msg:") && !key.startsWith("seen:");
  // Keep inherited floors first (a subset of the already bounded reserve), then
  // the newest read marks, so a drop raises the floor as little as it can.
  // Row hints read nothing: keep them last and never raise the floor for them.
  // Journal recency still controls newly read old history.
  let raised = floor;
  let full = false;
  for (const [key, value] of [...frontiers].sort(
    ([a, av], [b, bv]) =>
      Number(protectedKey(b)) - Number(protectedKey(a)) ||
      Number(a.startsWith("seen:")) - Number(b.startsWith("seen:")) ||
      bv - av ||
      scope(a) - scope(b) ||
      a.localeCompare(b),
  )) {
    // Once one mark does not fit, every later one is dropped too.
    if (full) {
      if (!key.startsWith("seen:")) raised = Math.max(raised, value);
      continue;
    }
    if (redundant(key, value)) continue;
    const cost =
      encoder.encode(JSON.stringify(key)).byteLength +
      1 +
      String(value).length +
      (entries.length ? 1 : 0);
    if (
      entries.length >= READ_RESERVE_KEYS ||
      bytes + cost > READ_RESERVE_BYTES
    ) {
      // Protected-first ordering is not newest-first: a dropped message can
      // be newer than every retained ancestor. Never raise the floor then.
      if (overrides.size) {
        if (protectedKey(key))
          throw new Error(
            "Read override ancestry capacity reached; saved floors retained",
          );
        break;
      }
      full = true;
      if (!key.startsWith("seen:")) raised = Math.max(raised, value);
      continue;
    }
    entries.push([key, value]);
    accepted.set(key, value);
    bytes += cost;
  }
  return {
    ...kept,
    reserve: Object.freeze(Object.fromEntries(entries)),
    floor: raised,
  };
}
