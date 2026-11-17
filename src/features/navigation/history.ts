import {
  joinBeneath,
  parseOpenTarget,
  targetKey,
  withoutJoin,
  type OpenTarget,
} from "./targets";

export const HISTORY_CAPACITY = 100;

/** Stable visit identity, distinct from the cancellable attempts to reveal it. */
export type NavigationEntry = Readonly<{ id: string; target: OpenTarget }>;
/** Match a logical dialog (including its sections), or exact content visits. */
export type DismissedVisits =
  | readonly string[]
  | ((target: OpenTarget) => boolean);
/**
 * Which entries a dismissal retires: the visits it names, and every join
 * dialog presented over one of them, so Forward cannot reopen a closed view
 * with its join. Closing one join leaves other openings over the same view.
 */
export function dismissalOf(
  entries: readonly NavigationEntry[],
  visits: DismissedVisits,
) {
  const named = (entry: NavigationEntry) =>
    typeof visits === "function"
      ? visits(entry.target) ||
        (!!entry.target.join && visits(withoutJoin(entry.target)))
      : visits.includes(entry.id);
  const closedViews = new Set(
    entries
      .filter((entry) => !entry.target.join && named(entry))
      .map((entry) => targetKey(joinBeneath(entry.target))),
  );
  return (entry: NavigationEntry) =>
    named(entry) ||
    (!!entry.target.join &&
      closedViews.has(targetKey(joinBeneath(entry.target))));
}
export type HistorySnapshot = Readonly<{
  current: NavigationEntry;
  /** Managed, non-dismissed return window, including identities retained across reload. */
  retainedVisits?: readonly string[] | undefined;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The preceding eligible visit, when known to this driver. */
  previous?: NavigationEntry;
  /** Host-address parsing failed; retained target is not a successful destination. */
  invalidAddress?: boolean;
}>;
/** A host uses exactly one driver. Traversal publishes; it never calls push. */
export interface NavigationHistory {
  snapshot(): HistorySnapshot;
  /** Exactly one controller attachment for the lifetime of this driver. UI observes Navigation. */
  attach(controller: () => void): () => void;
  push(target: OpenTarget): void;
  /** Normalize this visit's resolved destination without creating another visit. */
  resolve(target: OpenTarget): void;
  replace(target: OpenTarget): void;
  /** Explicit dismissal retires visits; traversal alone never retires one. */
  dismiss(visits: DismissedVisits, fallback: OpenTarget): void;
  back(): void;
  forward(): void;
  returnTo(entryId: string): boolean;
  dispose(): void;
}
export const homeTarget = Object.freeze({ version: 1, kind: "home" } as const);
export function navigationEntry(target: OpenTarget): NavigationEntry {
  return Object.freeze({
    id: crypto.randomUUID(),
    target: parseOpenTarget(target),
  });
}

/** Non-browser host driver. Browser hosts supply actual session-history traversal. */
export function createMemoryHistory(
  initial: OpenTarget = homeTarget,
  capacity = HISTORY_CAPACITY,
): NavigationHistory {
  if (!Number.isSafeInteger(capacity) || capacity < 2 || capacity > 1000)
    throw new Error("Invalid navigation history capacity");
  let entries = [navigationEntry(initial)];
  let index = 0;
  let disposed = false;
  let attached = false;
  let controller: (() => void) | undefined;
  const dismissed = new Set<string>();
  const adjacent = (direction: -1 | 1) => {
    let next = index + direction;
    while (entries[next] && dismissed.has(entries[next]?.id ?? ""))
      next += direction;
    return entries[next] ? next : -1;
  };
  const current = () =>
    Object.freeze({
      current: entries[index] as NavigationEntry,
      retainedVisits: entries
        .filter((entry) => !dismissed.has(entry.id))
        .map((entry) => entry.id),
      canGoBack: adjacent(-1) !== -1,
      canGoForward: adjacent(1) !== -1,
      ...(adjacent(-1) !== -1 ? { previous: entries[adjacent(-1)] } : {}),
    });
  let snapshot = current();
  function emit() {
    snapshot = current();
    controller?.();
  }
  return {
    snapshot: () => snapshot,
    attach(listener) {
      if (attached || disposed)
        throw new Error("Navigation history already has an owner");
      attached = true;
      controller = listener;
      return () => {
        controller = undefined;
      };
    },
    push(input) {
      if (disposed) return;
      const target = parseOpenTarget(input);
      if (targetKey(target) === targetKey(snapshot.current.target)) return;
      entries = [...entries.slice(0, index + 1), navigationEntry(target)].slice(
        -capacity,
      );
      index = entries.length - 1;
      for (const id of dismissed)
        if (!entries.some((entry) => entry.id === id)) dismissed.delete(id);
      emit();
    },
    resolve(target) {
      if (disposed) return;
      entries[index] = Object.freeze({
        id: snapshot.current.id,
        target: parseOpenTarget(target),
      });
      emit();
    },
    replace(target) {
      if (disposed) return;
      entries[index] = navigationEntry(target);
      emit();
    },
    dismiss(visits, input) {
      if (disposed || (typeof visits !== "function" && !visits.length)) return;
      const fallback = parseOpenTarget(input);
      const closing = entries.filter(dismissalOf(entries, visits));
      for (const entry of closing) dismissed.add(entry.id);
      if (dismissed.has(snapshot.current.id)) {
        const previous = adjacent(-1);
        const entry = entries[previous];
        if (entry && targetKey(entry.target) === targetKey(fallback))
          index = previous;
        else entries[index] = navigationEntry(fallback);
      }
      emit();
    },
    back() {
      const next = adjacent(-1);
      if (disposed || next === -1) return;
      index = next;
      emit();
    },
    forward() {
      const next = adjacent(1);
      if (disposed || next === -1) return;
      index = next;
      emit();
    },
    returnTo(entryId) {
      const found = entries.findIndex((entry) => entry.id === entryId);
      if (disposed || found < 0 || dismissed.has(entryId)) return false;
      index = found;
      emit();
      return true;
    },
    dispose() {
      disposed = true;
      controller = undefined;
    },
  };
}
