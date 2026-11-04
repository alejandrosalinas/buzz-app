import { useCallback, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import {
  draftCoordinates,
  listDraftViews,
  readView,
  subscribeView,
  viewRevision,
} from "../../shared/view-state";
import { hasDraftContent, mentionDraft } from "./mention-draft";
import {
  attachmentDraftCount,
  attachmentDraftKeys,
  subscribeAttachmentDraftCounts,
} from "./attachment-draft";

type Presence = ReturnType<typeof createDraftPresence>;
const sessions = new WeakMap<RelaySession, Presence>();

/** The existing saved drafts plus session-retained file-only composers. */
export function listComposerDrafts(
  session: RelaySession,
  selected?: string,
  limit = 500,
) {
  const saved = listDraftViews(
    session.scope,
    (value, key) =>
      hasDraftContent(
        mentionDraft(value),
        attachmentDraftCount(session, `${session.scope}:${key}`),
      ),
    selected,
    limit,
  );
  const entries = [...saved.entries];
  const seen = new Set(entries.map(({ key }) => key));
  let limited = saved.limited;
  const prefix = `${session.scope}:`;
  for (const scoped of attachmentDraftKeys(session)) {
    if (!scoped.startsWith(prefix)) continue;
    const key = scoped.slice(prefix.length);
    if (!draftCoordinates(key) || seen.has(key)) continue;
    if (entries.length >= limit && key !== selected) {
      limited = true;
      continue;
    }
    entries.push({ key, value: readView(session.scope, key, "") });
    seen.add(key);
  }
  return { ...saved, entries, limited };
}

/** Derived presence only; the composer still owns every draft and its lifetime. */
function createDraftPresence(session: RelaySession) {
  const listeners = new Set<() => void>();
  let stops: (() => void)[] = [];
  let keys = new Set<string>();
  let counts = new Map<string, number>();
  let total = 0;
  const meaningful = (value: unknown, key: string) =>
    hasDraftContent(
      mentionDraft(value),
      attachmentDraftCount(session, `${session.scope}:${key}`),
    );
  const updateKey = (key: string) => {
    if (!draftCoordinates(key)) return;
    if (attachmentDraftCount(session, `${session.scope}:${key}`)) {
      keys.add(key);
      return;
    }
    try {
      const raw = viewRevision(session.scope, key);
      if (raw && raw.length > 8 * 1024 * 1024) {
        keys.delete(key);
        return;
      }
      if (meaningful(raw ? JSON.parse(raw) : null, key)) keys.add(key);
      else keys.delete(key);
    } catch {
      keys.delete(key);
    }
  };
  const publish = () => {
    const excluded = new Set(
      session.channels
        .list()
        .channels.filter((channel) => channel.huddle || channel.metadataPending)
        .map((channel) => channel.id),
    );
    const next = new Map<string, number>();
    let size = 0;
    for (const key of keys) {
      const coordinates = draftCoordinates(key);
      if (!coordinates || excluded.has(coordinates.channelId)) continue;
      const id = coordinates.channelId;
      next.set(id, (next.get(id) ?? 0) + 1);
      size++;
    }
    if (
      total === size &&
      counts.size === next.size &&
      [...next].every(([id, count]) => counts.get(id) === count)
    )
      return;
    counts = next;
    total = size;
    for (const listener of listeners) listener();
  };
  const filesChanged = () => {
    const prefix = `${session.scope}:`;
    for (const key of attachmentDraftKeys(session))
      if (key.startsWith(prefix)) updateKey(key.slice(prefix.length));
    // The removed file may have been the only content in a known composer.
    for (const key of keys) updateKey(key);
    publish();
  };
  const refresh = () => {
    // Presence must include destinations beyond the Drafts view's preview cap.
    keys = new Set(
      listComposerDrafts(session, undefined, Infinity).entries.map(
        ({ key }) => key,
      ),
    );
    filesChanged();
  };
  refresh();
  return {
    count: (channelId?: string) =>
      channelId === undefined ? total : (counts.get(channelId) ?? 0),
    subscribe(listener: () => void) {
      if (!listeners.size) {
        stops = [
          subscribeView(session.scope, (key) => {
            if (key === undefined) refresh();
            else if (draftCoordinates(key)) {
              updateKey(key);
              publish();
            }
          }),
          subscribeAttachmentDraftCounts(session, filesChanged),
          session.channels.subscribeList(publish),
        ];
        refresh();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          for (const stop of stops) stop();
          stops = [];
        }
      };
    },
  };
}

function draftPresence(session: RelaySession) {
  let presence = sessions.get(session);
  if (!presence) {
    presence = createDraftPresence(session);
    sessions.set(session, presence);
  }
  return presence;
}

export function useDraftCount(session: RelaySession, channelId?: string) {
  const presence = draftPresence(session);
  const snapshot = useCallback(
    () => presence.count(channelId),
    [presence, channelId],
  );
  return useSyncExternalStore(presence.subscribe, snapshot, snapshot);
}
