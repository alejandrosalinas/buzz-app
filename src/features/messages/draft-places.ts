import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import {
  draftCoordinates,
  listDraftViews,
  parseDraftView,
  subscribeView,
  viewRevision,
} from "../../shared/view-state";
import {
  attachmentDraftCount,
  subscribeAttachmentDraftCounts,
} from "./attachment-draft";
import type { ComposerSession } from "./composer-session";
import { hasDraftContent, mentionDraft } from "./mention-draft";

type Session = Pick<ComposerSession, "scope">;

/** Where the viewer has an unsent composer draft on this device. */
type DraftPlace = Readonly<{
  key: string;
  channelId: string;
  threadRootId?: string;
}>;

/** The one rule for whether a saved draft counts: Drafts & sent and every
 * draft marker read through it, so they cannot disagree. */
export function draftCounts(session: Session, key: string, value: unknown) {
  return hasDraftContent(
    mentionDraft(value),
    attachmentDraftCount(session as ComposerSession, `${session.scope}:${key}`),
  );
}

function readDraftPlaces(session: Session): readonly DraftPlace[] {
  const places: DraftPlace[] = [];
  for (const { key } of listDraftViews(session.scope, (value, key) =>
    draftCounts(session, key, value),
  ).entries) {
    const where = draftCoordinates(key);
    if (where) places.push({ key, ...where });
  }
  return places;
}

// Whether one changed key leaves the set of draft places as it was, so a
// keystroke in a draft, or a write to any other view key, skips the rescan.
function sameMembership(
  session: Session,
  places: readonly DraftPlace[],
  key: string,
) {
  if (!draftCoordinates(key)) return true;
  const listed = places.some((place) => place.key === key);
  const raw = viewRevision(session.scope, key);
  // Unreadable or oversized keys are left to the full scan, as before; a
  // forgotten, empty or malformed one is never listed.
  if (raw === undefined) return false;
  const draft = parseDraftView(raw);
  if (draft === "oversized") return false;
  if (!draft) return !listed;
  return listed === draftCounts(session, key, draft.value);
}

type Store = {
  places: readonly DraftPlace[] | undefined;
  listeners: Set<() => void>;
  stop?: (() => void) | undefined;
};
// One storage scan per change for the whole window, however many rows read it.
const stores = new WeakMap<Session, Store>();
function storeFor(session: Session) {
  let store = stores.get(session);
  if (!store) {
    store = { places: undefined, listeners: new Set() };
    stores.set(session, store);
  }
  return store;
}
function subscribePlaces(session: Session, listener: () => void) {
  const store = storeFor(session);
  if (!store.listeners.size) {
    // Storage may have changed while nobody listened.
    store.places = undefined;
    const changed = (key?: string) => {
      if (
        key !== undefined &&
        store.places &&
        sameMembership(session, store.places, key)
      )
        return;
      store.places = undefined;
      for (const notify of [...store.listeners]) notify();
    };
    const stopViews = subscribeView(session.scope, changed);
    const stopFiles = subscribeAttachmentDraftCounts(
      session as ComposerSession,
      changed,
    );
    const focused = () => changed();
    window.addEventListener("focus", focused);
    store.stop = () => {
      stopViews();
      stopFiles();
      window.removeEventListener("focus", focused);
    };
  }
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size) return;
    store.stop?.();
    store.stop = undefined;
    store.places = undefined;
  };
}
function placesOf(session: Session) {
  const store = storeFor(session);
  store.places ??= readDraftPlaces(session);
  return store.places;
}

const NONE: readonly DraftPlace[] = Object.freeze([]);

function useDraftSnapshot<T>(
  session: Session | undefined,
  select: (places: readonly DraftPlace[]) => T,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      session ? subscribePlaces(session, listener) : () => {},
    [session],
  );
  const get = () => select(session ? placesOf(session) : NONE);
  return useSyncExternalStore(subscribe, get, get);
}

// Draft keys whose composer is on screen, so their markers stay out of the way.
const showing = new Map<string, number>();
const showingListeners = new Set<() => void>();
const showingKey = (scope: string, key: string) => `${scope}\n${key}`;
function subscribeShowing(listener: () => void) {
  showingListeners.add(listener);
  return () => {
    showingListeners.delete(listener);
  };
}
function setShowing(id: string, delta: 1 | -1) {
  const count = (showing.get(id) ?? 0) + delta;
  if (count > 0) showing.set(id, count);
  else showing.delete(id);
  for (const notify of [...showingListeners]) notify();
}

/** A composer on screen marks its draft as already in view. A layout effect,
 * so opening a thread never paints its summary's marker for a frame. */
export function useShowingDraft(scope: string, key: string, shown: boolean) {
  useLayoutEffect(() => {
    if (!shown) return;
    const id = showingKey(scope, key);
    setShowing(id, 1);
    return () => setShowing(id, -1);
  }, [scope, key, shown]);
}

/** A thread draft that no open composer already shows. */
export function useThreadDraft(
  session: Session | undefined,
  channelId: string,
  threadRootId: string,
) {
  const key = `draft:${channelId}:thread:${threadRootId}`;
  const saved = useDraftSnapshot(session, (places) =>
    places.some((place) => place.key === key),
  );
  const scope = session?.scope;
  const inView = () =>
    scope !== undefined && showing.has(showingKey(scope, key));
  const shown = useSyncExternalStore(subscribeShowing, inView, inView);
  return saved && !shown;
}
