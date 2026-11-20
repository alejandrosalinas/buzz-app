import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { traceDraft } from "./draft-diagnostics";

// View intent is durable and explicitly partitioned; connection generations are not storage keys.
type RemovedView = { key: string; revision: string };
type ViewListener = (key?: string, removed?: readonly RemovedView[]) => void;
const viewListeners = new Map<string, Set<ViewListener>>();
const composerDraftKey =
  /^draft:([a-zA-Z0-9][a-zA-Z0-9._-]{0,255})(?::thread:([0-9a-f]{64})(?::subthread:([0-9a-f]{64}))?)?$/;
export function draftCoordinates(key: string) {
  const match = composerDraftKey.exec(key);
  return match?.[1]
    ? {
        channelId: match[1],
        ...(match[2] ? { threadRootId: match[2] } : {}),
        ...(match[3] ? { subthreadId: match[3] } : {}),
      }
    : undefined;
}
// `key` names the one key that changed; undefined means any key may have.
const changed = (
  scope: string,
  key?: string,
  removed?: readonly RemovedView[],
) => {
  if (key) traceDraft(scope, key, "notify");
  for (const listener of viewListeners.get(scope) ?? []) listener(key, removed);
};
/** Same durable view keys as the composer; no parallel draft store or index. */
export function subscribeView(
  scope: string,
  listener: ViewListener,
  keys?: string | readonly string[] | ((key: string) => boolean),
) {
  const notify: ViewListener = (key, removed) => {
    if (
      key === undefined ||
      keys === undefined ||
      (typeof keys === "string"
        ? key === keys
        : typeof keys === "function"
          ? keys(key)
          : keys.includes(key))
    ) {
      if (removed?.length) listener(key, removed);
      else listener(key);
    }
  };
  let listeners = viewListeners.get(scope);
  if (!listeners) {
    listeners = new Set();
    viewListeners.set(scope, listeners);
  }
  listeners.add(notify);
  const onStorage = (event: StorageEvent) => {
    try {
      if (event.storageArea !== localStorage) return;
      if (event.key === null) {
        notify();
        return;
      }
      if (event.key === viewScopePurgeKey(scope)) {
        notify();
        return;
      }
      const prefix = event.key.startsWith(draftRetirementPrefix)
        ? draftRetirementPrefix
        : "buzz-view.v1:";
      if (!event.key.startsWith(prefix)) return;
      const pair: unknown = JSON.parse(event.key.slice(prefix.length));
      if (Array.isArray(pair) && pair[0] === scope) {
        const key = typeof pair[1] === "string" ? pair[1] : undefined;
        if (key) traceDraft(scope, key, "storage");
        notify(
          key,
          prefix === "buzz-view.v1:" &&
            key &&
            event.newValue === null &&
            event.oldValue !== null
            ? [{ key, revision: event.oldValue }]
            : undefined,
        );
      }
    } catch {
      /* Storage may be unavailable while a window is closing. */
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    listeners?.delete(notify);
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
    return writeViewRevision(scope, key, JSON.stringify(value));
  } catch {
    traceDraft(scope, key, "serialize-failed");
    return false;
  }
}

function writeViewRevision(
  scope: string,
  key: string,
  revision: string,
  retired?: string,
) {
  let phase: "write-failed" | "notify-failed" = "write-failed";
  try {
    traceDraft(scope, key, "write");
    const storageKey = `buzz-view.v1:${JSON.stringify([scope, key])}`;
    localStorage.setItem(storageKey, revision);
    const current = viewRevision(scope, key);
    if (current !== revision) {
      traceDraft(scope, key, "write-mismatch", 0, {
        expected: revision,
        current,
        next: revision,
        flags: 0,
      });
      return false;
    }
    phase = "notify-failed";
    if (retired !== undefined) recordDraftRetirement(scope, key, retired);
    changed(
      scope,
      key,
      retired === undefined ? undefined : [{ key, revision: retired }],
    );
    return true;
  } catch {
    traceDraft(scope, key, phase);
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

/** Compare and save a draft that already holds its exact serialized revision. */
export function replaceViewRevision(
  scope: string,
  key: string,
  expected: string | null | undefined,
  revision: string,
): "saved" | "changed" | "failed" {
  const current = viewRevision(scope, key);
  if (current === undefined) return "failed";
  if (current !== expected) return "changed";
  return writeViewRevision(scope, key, revision) ? "saved" : "failed";
}

/** Outbox admission retires the sent revision without overwriting peer edits. */
export function retireViewDraft(
  scope: string,
  key: string,
  expected: string | null | undefined,
  replacement: string,
  cursor: number | undefined,
): "saved" | "changed" | "failed" {
  const current = viewRevision(scope, key);
  if (current === undefined || expected === undefined) return "failed";
  if (expected !== null && draftWasRetired(scope, key, expected, cursor))
    return current === replacement ? "saved" : "changed";
  if (current === replacement || current !== expected) {
    // An empty follow-up could belong to a different accepted send.
    if (expected !== null && expected !== replacement) {
      recordDraftRetirement(scope, key, expected);
      changed(scope, key, [{ key, revision: expected }]);
    }
    return current === replacement ? "saved" : "changed";
  }
  return writeViewRevision(scope, key, replacement, expected ?? undefined)
    ? "saved"
    : "failed";
}

// Rich snapshots contain structure as well as text (up to 32,001 nodes).
// Keep a receiver bound, not the old text-sized 128 KiB envelope cutoff.
const MAX_DRAFT_VIEW_LENGTH = 8 * 1024 * 1024;

/** A saved draft record as `listDraftViews` reads it: the parsed value,
 * "oversized" past the receiver bound, or undefined when absent, empty or
 * malformed. */
export function parseDraftView(
  raw: string | null | undefined,
): { value: unknown } | "oversized" | undefined {
  if (!raw) return undefined;
  if (raw.length > MAX_DRAFT_VIEW_LENGTH) return "oversized";
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return undefined;
  }
}

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
      const draft = parseDraftView(localStorage.getItem(storageKey));
      if (draft === "oversized") {
        unavailable++;
        continue;
      }
      if (!draft) continue;
      try {
        if (!meaningful(draft.value, pair[1])) continue;
        if (drafts.length === 500) {
          limited = true;
          break;
        }
        drafts.push({ key: pair[1], value: draft.value });
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

const conflictDraftPrefix = "buzz-draft-conflict.v1:";
const draftRetirementPrefix = "buzz-ret.v1:";
const draftRetirementKey = (scope: string, key: string) =>
  `${draftRetirementPrefix}${JSON.stringify([scope, key])}`;
const maxRetiredRevisions = 32;
const viewScopePurgeKey = (scope: string) =>
  `buzz-view-purge.v1:${JSON.stringify(scope)}`;

/** A leave invalidates window-local recovery even when its editor is closed. */
export function viewScopePurgeToken(scope: string) {
  try {
    return localStorage.getItem(viewScopePurgeKey(scope));
  } catch {
    return undefined;
  }
}

export function conflictDraftKey(scope: string, key: string) {
  return `${conflictDraftPrefix}${JSON.stringify([scope, key])}`;
}

function retirementHistory(scope: string, key: string): [number, ...string[]] {
  return JSON.parse(
    localStorage.getItem(draftRetirementKey(scope, key)) ?? "[0]",
  );
}

export function draftRetirementCursor(scope: string, key: string) {
  try {
    return retirementHistory(scope, key)[0];
  } catch {
    return undefined;
  }
}

const revisionDigest = (revision: string) =>
  bytesToHex(sha256(utf8ToBytes(revision)));

export function draftWasRetired(
  scope: string,
  key: string,
  revision: string,
  cursor: number | undefined,
) {
  if (cursor === undefined) return false;
  try {
    const [end, ...revisions] = retirementHistory(scope, key);
    return revisions
      .slice(Math.max(0, cursor - end + revisions.length))
      .includes(revisionDigest(revision));
  } catch {
    return false;
  }
}

function recordDraftRetirement(scope: string, key: string, revision: string) {
  try {
    const [end, ...previous] = retirementHistory(scope, key);
    const digest = revisionDigest(revision);
    const recent = previous.slice(1 - maxRetiredRevisions);
    for (const revisions of [[...recent, digest], [digest]]) {
      try {
        localStorage.setItem(
          draftRetirementKey(scope, key),
          JSON.stringify([end + 1, ...revisions]),
        );
        return;
      } catch {
        // Retry with one exact receipt. Keep prior receipts if it cannot fit.
      }
    }
  } catch {
    // Storage failure must not prevent clearing the draft itself.
  }
}

function clearScopedStorage(storage: Storage, prefix: string) {
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
}

/** Forgets every key saved under one scope, for a community the viewer has left. */
export function clearViewScope(scope: string) {
  const keyPrefix = `${JSON.stringify([scope]).slice(0, -1)},`;
  const purgeKey = viewScopePurgeKey(scope);
  const token = crypto.randomUUID();
  let retry = false;
  try {
    localStorage.setItem(purgeKey, token);
  } catch {
    // Removing the old scope can free enough quota to record the purge.
    retry = true;
  }
  clearScopedStorage(localStorage, `buzz-view.v1:${keyPrefix}`);
  clearScopedStorage(localStorage, `${draftRetirementPrefix}${keyPrefix}`);
  try {
    if (retry) localStorage.setItem(purgeKey, token);
  } finally {
    changed(scope);
    if (typeof sessionStorage !== "undefined")
      clearScopedStorage(sessionStorage, `${conflictDraftPrefix}${keyPrefix}`);
  }
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
  for (const scope of scopes) changed(scope, key);
}

/** Recovery callers must confirm cleanup before retiring their durable operation. */
export function clearView(scope: string, ...keys: string[]) {
  const removed: RemovedView[] = [];
  for (const key of keys) {
    const storageKey = `buzz-view.v1:${JSON.stringify([scope, key])}`;
    const revision = localStorage.getItem(storageKey);
    localStorage.removeItem(storageKey);
    if (localStorage.getItem(storageKey) !== null)
      throw new Error("Could not clear the saved message. Try again.");
    if (revision !== null) removed.push({ key, revision });
  }
  for (const { key, revision } of removed)
    if (draftCoordinates(key)) recordDraftRetirement(scope, key, revision);
  changed(scope, keys.length === 1 ? keys[0] : undefined, removed);
}
