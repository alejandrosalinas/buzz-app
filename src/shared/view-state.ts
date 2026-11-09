// View intent is durable and explicitly partitioned; connection generations are not storage keys.
const viewListeners = new Map<string, Set<(key?: string) => void>>();
const composerDraftKey =
  /^draft:([a-zA-Z0-9][a-zA-Z0-9._-]{0,255})(?::thread:([0-9a-f]{64}))?$/;
export function draftCoordinates(key: string) {
  const match = composerDraftKey.exec(key);
  return match?.[1]
    ? { channelId: match[1], ...(match[2] ? { threadRootId: match[2] } : {}) }
    : undefined;
}
// `key` names the one key that changed; undefined means any key may have.
const changed = (scope: string, key?: string) => {
  for (const listener of viewListeners.get(scope) ?? []) listener(key);
};
/** Same durable view keys as the composer; no parallel draft store or index. */
export function subscribeView(scope: string, listener: (key?: string) => void) {
  let listeners = viewListeners.get(scope);
  if (!listeners) {
    listeners = new Set();
    viewListeners.set(scope, listeners);
  }
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    try {
      if (event.storageArea !== localStorage) return;
      if (event.key === null) {
        listener();
        return;
      }
      if (!event.key.startsWith("buzz-view.v1:")) return;
      const pair: unknown = JSON.parse(event.key.slice("buzz-view.v1:".length));
      if (Array.isArray(pair) && pair[0] === scope)
        listener(typeof pair[1] === "string" ? pair[1] : undefined);
    } catch {
      /* Storage may be unavailable while a window is closing. */
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    listeners?.delete(listener);
    if (!listeners?.size) viewListeners.delete(scope);
  };
}

export function readView<T>(scope: string, key: string, fallback: T): T {
  try {
    return JSON.parse(viewRevision(scope, key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
/** Exact serialized revision; undefined means storage could not be read. */
export function viewRevision(scope: string, key: string) {
  try {
    return localStorage.getItem(`buzz-view.v1:${JSON.stringify([scope, key])}`);
  } catch {
    return undefined;
  }
}
export function writeView(scope: string, key: string, value: unknown) {
  try {
    const revision = JSON.stringify(value);
    localStorage.setItem(
      `buzz-view.v1:${JSON.stringify([scope, key])}`,
      revision,
    );
    if (viewRevision(scope, key) !== revision) return false;
    changed(scope, key);
    return true;
  } catch {
    // Ordinary view callers remain usable in memory; recovery callers check this.
    return false;
  }
}
/** Foreground comparison, not a cross-window transaction or lock. */
export function replaceView(
  scope: string,
  key: string,
  expected: string | null | undefined,
  value: unknown,
): "saved" | "changed" | "failed" {
  const current = viewRevision(scope, key);
  if (current === undefined) return "failed";
  if (current !== expected) return "changed";
  return writeView(scope, key, value) ? "saved" : "failed";
}

// Rich snapshots contain structure as well as text (up to 32,001 nodes).
// Keep a receiver bound, not the old text-sized 128 KiB envelope cutoff.
export const MAX_DRAFT_VIEW_LENGTH = 8 * 1024 * 1024;

/** Snapshot of a viewer's existing composer drafts, never other view coordinates. */
export function listDraftViews(
  scope: string,
  meaningful: (value: unknown, key: string) => boolean,
  selected?: string,
): Readonly<{
  entries: readonly Readonly<{ key: string; value: unknown }>[];
  limited: boolean;
  unavailable: number;
}> {
  const prefix = "buzz-view.v1:";
  const drafts: { key: string; value: unknown }[] = [];
  let limited = false;
  let unavailable = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith(prefix)) continue;
      let pair: unknown;
      try {
        pair = JSON.parse(storageKey.slice(prefix.length));
      } catch {
        continue;
      }
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair[0] !== scope ||
        typeof pair[1] !== "string" ||
        !draftCoordinates(pair[1])
      )
        continue;
      const raw = localStorage.getItem(storageKey);
      if (!raw) continue;
      if (raw.length > MAX_DRAFT_VIEW_LENGTH) {
        unavailable++;
        continue;
      }
      try {
        const value: unknown = JSON.parse(raw);
        if (!meaningful(value, pair[1])) continue;
        if (drafts.length === 500) {
          limited = true;
          break;
        }
        drafts.push({ key: pair[1], value });
      } catch {
        /* Malformed old draft. */
      }
    }
  } catch {
    /* Storage unavailable; composer remains usable in memory. */
  }
  // Direct scoped lookup preserves an emptied selected editor even beyond the cap.
  if (
    selected &&
    draftCoordinates(selected) &&
    !drafts.some((entry) => entry.key === selected)
  ) {
    try {
      const raw = localStorage.getItem(
        `${prefix}${JSON.stringify([scope, selected])}`,
      );
      if (raw && raw.length <= MAX_DRAFT_VIEW_LENGTH)
        drafts.push({ key: selected, value: JSON.parse(raw) });
    } catch {
      /* Missing/malformed/removed draft has no list summary. */
    }
  }
  return { entries: drafts, limited, unavailable };
}

/** Forgets every key saved under one scope, for a community the viewer has left. */
export function clearViewScope(scope: string) {
  const prefix = `buzz-view.v1:${JSON.stringify([scope]).slice(0, -1)},`;
  const stale: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
  changed(scope);
}

/** Forgets one key in every scope where it holds `value`, as when the thing it
 * names is deleted. */
export function clearViewValue(key: string, value: unknown) {
  const revision = JSON.stringify(value);
  const scopes: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const storageKey = localStorage.key(index);
      if (!storageKey?.startsWith("buzz-view.v1:")) continue;
      let pair: unknown;
      try {
        pair = JSON.parse(storageKey.slice("buzz-view.v1:".length));
      } catch {
        continue;
      }
      if (
        Array.isArray(pair) &&
        typeof pair[0] === "string" &&
        pair[1] === key &&
        localStorage.getItem(storageKey) === revision
      )
        scopes.push(pair[0]);
    }
    for (const scope of scopes)
      localStorage.removeItem(`buzz-view.v1:${JSON.stringify([scope, key])}`);
  } catch {
    /* Storage unavailable; nothing was saved to forget. */
  }
  for (const scope of scopes) changed(scope);
}

/** Recovery callers must confirm cleanup before retiring their durable operation. */
export function clearView(scope: string, ...keys: string[]) {
  for (const key of keys) {
    const storageKey = `buzz-view.v1:${JSON.stringify([scope, key])}`;
    localStorage.removeItem(storageKey);
    if (localStorage.getItem(storageKey) !== null)
      throw new Error("Could not clear the saved message. Try again.");
  }
  changed(scope, keys.length === 1 ? keys[0] : undefined);
}
