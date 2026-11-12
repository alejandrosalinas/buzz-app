import { useEffect, useState } from "react";
import {
  attachmentDraftCount,
  clearAttachmentDraft,
  subscribeAttachmentDraftCounts,
} from "../../features/messages/attachment-draft";
import { draftCounts } from "../../features/messages/draft-places";
import { mentionDraft } from "../../features/messages/mention-draft";
import type { RelaySession } from "../../features/relay/session";
import {
  clearView,
  draftCoordinates,
  listDraftViews,
  parseDraftView,
  subscribeView,
  viewRevision,
} from "../../shared/view-state";
import type { Entry } from "./model";

export type DraftEntry = Entry & {
  /** No typed text: the row shows what the draft holds instead. */
  placeholder?: true;
  signature: string;
};
export type DraftSnapshot = Readonly<{
  entries: readonly DraftEntry[];
  limited: boolean;
  unavailable: boolean;
}>;
export const EMPTY_DRAFTS: DraftSnapshot = Object.freeze({
  entries: [],
  limited: false,
  unavailable: false,
});

type Session = Pick<RelaySession, "scope">;

/** When each draft last changed on this device, per `<origin>:<viewer>`:
 * draft key → [content fingerprint, Unix seconds]. Never the text itself. */
const ACTIVITY_KEY = "buzz-drafts-sent-activity.v1";
type ActivityRecord = Record<string, [string, number]>;
const storage = () =>
  typeof localStorage === "undefined" ? undefined : localStorage;
function readActivity(scope: string): ActivityRecord {
  try {
    const raw = storage()?.getItem(`${ACTIVITY_KEY}:${scope}`);
    const value: unknown = raw ? JSON.parse(raw) : undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record: ActivityRecord = {};
    for (const [key, item] of Object.entries(value))
      if (
        Array.isArray(item) &&
        typeof item[0] === "string" &&
        typeof item[1] === "number"
      )
        record[key] = [item[0], item[1]];
    return record;
  } catch {
    return {};
  }
}
function writeActivity(scope: string, record: ActivityRecord) {
  try {
    storage()?.setItem(`${ACTIVITY_KEY}:${scope}`, JSON.stringify(record));
  } catch {
    // Times stay in memory for this window; the list is still correct.
  }
}

/** Short, stable fingerprint, so change tracking never stores draft text. */
export function signature(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

const newestFirst = (a: DraftEntry, b: DraftEntry) =>
  (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id);

/** One listed draft's row; records in `activity` when its content changed. */
function draftEntry(
  session: Session,
  key: string,
  value: unknown,
  activity: ActivityRecord,
  nowSeconds: number,
) {
  const where = draftCoordinates(key);
  if (!where) return undefined;
  const draft = mentionDraft(value);
  const count = attachmentDraftCount(
    session as Parameters<typeof attachmentDraftCount>[0],
    `${session.scope}:${key}`,
  );
  const text = draft.text.trim();
  const fingerprint = signature(
    `${count}:${draft.chatCards?.length ?? 0}:${draft.gifs?.length ?? 0}:${text}`,
  );
  const changed = activity[key]?.[0] !== fingerprint;
  if (changed) activity[key] = [fingerprint, nowSeconds];
  const entry: DraftEntry = {
    id: key,
    channelId: where.channelId,
    ...(where.threadRootId ? { threadRootId: where.threadRootId } : {}),
    text:
      text ||
      (count
        ? `${count} attached file${count === 1 ? "" : "s"}`
        : "Attached chat or GIF"),
    ...(text ? {} : { placeholder: true as const }),
    createdAt: activity[key]?.[1] ?? nowSeconds,
    signature: fingerprint,
  };
  return { entry, changed };
}

/** `previous` with one listed draft re-read, or undefined when the change
 * could add, drop or hide a draft and only a full `readDrafts` is exact. */
export function rereadDraft(
  session: Session,
  previous: DraftSnapshot,
  key: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): DraftSnapshot | undefined {
  if (previous.limited || previous.unavailable) return undefined;
  const index = previous.entries.findIndex((entry) => entry.id === key);
  if (index < 0) return undefined;
  const draft = parseDraftView(viewRevision(session.scope, key));
  if (typeof draft !== "object" || !draftCounts(session, key, draft.value))
    return undefined;
  const activity = readActivity(session.scope);
  // The other rows keep their times only while the record holds exactly them,
  // as a full read would leave it (it re-stamps lost rows and prunes others).
  if (Object.keys(activity).length !== previous.entries.length)
    return undefined;
  for (const entry of previous.entries) {
    const known = activity[entry.id];
    if (
      !known ||
      (entry.id !== key &&
        (known[0] !== entry.signature || known[1] !== entry.createdAt))
    )
      return undefined;
  }
  const next = draftEntry(session, key, draft.value, activity, nowSeconds);
  if (!next) return undefined;
  if (next.changed) writeActivity(session.scope, activity);
  const entries = previous.entries.slice();
  entries[index] = next.entry;
  entries.sort(newestFirst);
  return { ...previous, entries };
}

/** Read-only over the composer's own saved drafts: never clones or restores one. */
export function readDrafts(
  session: Session,
  nowSeconds = Math.floor(Date.now() / 1000),
): DraftSnapshot {
  const listed = listDraftViews(session.scope, (value, key) =>
    draftCounts(session, key, value),
  );
  const activity = readActivity(session.scope);
  const seen = new Set<string>();
  let changed = false;
  const entries: DraftEntry[] = [];
  for (const { key, value } of listed.entries) {
    const next = draftEntry(session, key, value, activity, nowSeconds);
    if (!next) continue;
    seen.add(key);
    if (next.changed) changed = true;
    entries.push(next.entry);
  }
  for (const key of Object.keys(activity))
    if (!seen.has(key)) {
      delete activity[key];
      changed = true;
    }
  if (changed) writeActivity(session.scope, activity);
  entries.sort(newestFirst);
  return {
    entries,
    limited: listed.limited,
    unavailable: listed.unavailable > 0,
  };
}

/** Erases one saved draft and this window's files for it. A mounted composer
 * reloads the empty draft, or keeps unsaved edits as a conflict. Throws when
 * storage could not forget it, before discarding any files. */
export function clearDraft(session: Session, key: string) {
  clearView(session.scope, key);
  clearAttachmentDraft(
    session as Parameters<typeof clearAttachmentDraft>[0],
    `${session.scope}:${key}`,
  );
}

/** The session's drafts, re-read when the composer saves, clears or attaches. */
export function useDrafts(session: Session | undefined) {
  const [snapshot, setSnapshot] = useState<DraftSnapshot>(EMPTY_DRAFTS);
  useEffect(() => {
    if (!session) {
      setSnapshot(EMPTY_DRAFTS);
      return;
    }
    // The listener needs the snapshot it last showed, outside React's queue.
    let current = EMPTY_DRAFTS;
    const show = (next: DraftSnapshot) => {
      current = next;
      setSnapshot(next);
    };
    const refresh = () => show(readDrafts(session));
    refresh();
    // Other view keys (scroll places, panels) never change the draft list, and
    // a keystroke in a listed draft re-reads only that draft.
    const stopViews = subscribeView(session.scope, (key) => {
      if (key === undefined) refresh();
      else if (draftCoordinates(key))
        show(rereadDraft(session, current, key) ?? readDrafts(session));
    });
    const stopFiles = subscribeAttachmentDraftCounts(
      session as Parameters<typeof subscribeAttachmentDraftCounts>[0],
      refresh,
    );
    window.addEventListener("focus", refresh);
    return () => {
      stopViews();
      stopFiles();
      window.removeEventListener("focus", refresh);
    };
  }, [session]);
  return snapshot;
}
