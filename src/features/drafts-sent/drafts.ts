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
  subscribeView,
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

/** Read-only over the composer's own saved drafts: never clones or restores one. */
export function readDrafts(
  session: Session,
  nowSeconds = Math.floor(Date.now() / 1000),
): DraftSnapshot {
  const files = (key: string) =>
    attachmentDraftCount(
      session as Parameters<typeof attachmentDraftCount>[0],
      `${session.scope}:${key}`,
    );
  const listed = listDraftViews(session.scope, (value, key) =>
    draftCounts(session, key, value),
  );
  const activity = readActivity(session.scope);
  const seen = new Set<string>();
  let changed = false;
  const entries: DraftEntry[] = [];
  for (const { key, value } of listed.entries) {
    const where = draftCoordinates(key);
    if (!where) continue;
    const draft = mentionDraft(value);
    const count = files(key);
    const text = draft.text.trim();
    const fingerprint = signature(
      `${count}:${draft.chatCards?.length ?? 0}:${draft.gifs?.length ?? 0}:${text}`,
    );
    seen.add(key);
    const known = activity[key];
    if (known?.[0] !== fingerprint) {
      activity[key] = [fingerprint, nowSeconds];
      changed = true;
    }
    entries.push({
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
    });
  }
  for (const key of Object.keys(activity))
    if (!seen.has(key)) {
      delete activity[key];
      changed = true;
    }
  if (changed) writeActivity(session.scope, activity);
  entries.sort(
    (a, b) =>
      (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id),
  );
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
    const refresh = () => setSnapshot(readDrafts(session));
    refresh();
    // Other view keys (scroll places, panels) never change the draft list.
    const stopViews = subscribeView(session.scope, (key) => {
      if (key === undefined || draftCoordinates(key)) refresh();
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
