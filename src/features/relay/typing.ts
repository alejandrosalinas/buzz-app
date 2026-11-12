import type { RelayEvent } from "./events";
import { threadReference } from "./thread-reference";

const ACTIVITY_LIFETIME_MS = 8_000;
const POST_MESSAGE_QUIET_MS = 2_000;
const MAX_ACTIVITY_RECORDS = 1024;
export type TypingEntry = Readonly<{
  channelId: string;
  threadRootId?: string;
  pubkey: string;
}>;
type ParticipantActivity = {
  entry: TypingEntry;
  lastActivityAt: number;
  lastMessageAt: number;
  visibleUntil: number;
  quietUntil: number;
};

/** Session-owned activity from verified events; no event payloads or persistence. */
export function createTyping(
  viewer: string,
  canAccess: (channelId: string) => boolean,
  notify: (listener: () => void) => void,
) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const records = new Map<string, ParticipantActivity>();
  const listeners = new Set<() => void>();
  let snapshot: readonly TypingEntry[] = Object.freeze([]);
  function retainUntil(record: ParticipantActivity) {
    return Math.max(
      Math.max(record.lastActivityAt, record.lastMessageAt) +
        ACTIVITY_LIFETIME_MS,
      record.quietUntil,
    );
  }
  function expireSilence(now: number) {
    for (const [key, record] of records) {
      if (retainUntil(record) <= now) records.delete(key);
    }
  }
  function publish() {
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    let nextWake = Infinity;
    const next: TypingEntry[] = [];
    expireSilence(now);
    for (const record of records.values()) {
      nextWake = Math.min(nextWake, retainUntil(record));
      if (record.visibleUntil > now) {
        next.push(record.entry);
        nextWake = Math.min(nextWake, record.visibleUntil);
      }
    }
    if (!closed && nextWake < Infinity)
      timer = setTimeout(publish, nextWake - now);
    if (
      next.length === snapshot.length &&
      next.every((e, i) => e === snapshot[i])
    )
      return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  function receiveActivity(
    record: ParticipantActivity,
    at: number,
    now: number,
  ) {
    if (at <= record.lastActivityAt || at <= record.lastMessageAt) return;
    // Remember suppressed pulses too: quiet ending must not admit their replays.
    record.lastActivityAt = at;
    if (now < record.quietUntil) return;
    record.visibleUntil = at + ACTIVITY_LIFETIME_MS;
  }
  function recordCompletion(
    record: ParticipantActivity,
    at: number,
    now: number,
  ) {
    if (at <= record.lastMessageAt) return;
    record.lastMessageAt = at;
    if (at < record.lastActivityAt) return;
    record.visibleUntil = 0;
    record.quietUntil = now + POST_MESSAGE_QUIET_MS;
  }
  function receive(event: RelayEvent, now: number) {
    const typing = event.kind === 20002;
    if (event.pubkey === viewer || !/^[0-9a-f]{64}$/.test(event.pubkey)) return;
    const at = event.created_at * 1000;
    if (
      !Number.isSafeInteger(event.created_at) ||
      at > now ||
      at + ACTIVITY_LIFETIME_MS <= now
    )
      return;
    const channels = event.tags.filter(([name]) => name === "h");
    const channelId = channels[0]?.[1];
    if (
      channels.length !== 1 ||
      !channelId ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(channelId) ||
      !canAccess(channelId)
    )
      return;
    const refs = event.tags.filter(([name]) => name === "e");
    // Pulses require an unambiguous canonical scope. Content uses the same
    // threadReference semantics as folding, including non-thread references.
    if (
      typing &&
      refs.length &&
      (refs.length > 2 ||
        refs.some(
          (tag) =>
            !/^[0-9a-f]{64}$/i.test(tag[1] ?? "") ||
            !["root", "reply"].includes(tag[3] ?? ""),
        ) ||
        refs.filter((tag) => tag[3] === "reply").length !== 1 ||
        refs.filter((tag) => tag[3] === "root").length > 1)
    )
      return;
    const threadRootId = threadReference(event)?.rootId;
    const record = recordFor(channelId, threadRootId, event.pubkey);
    if (typing) {
      if (record) receiveActivity(record, at, now);
      return;
    }
    if (record) recordCompletion(record, at, now);
    // A reply in a thread also ends the author's channel-level typing: its
    // pulses and replies can be filed apart for the same turn. Other threads
    // keep theirs.
    const channel =
      threadRootId && recordFor(channelId, undefined, event.pubkey);
    if (channel) recordCompletion(channel, at, now);
  }
  function recordFor(
    channelId: string,
    threadRootId: string | undefined,
    pubkey: string,
  ) {
    const key = `${channelId}:${threadRootId ?? ""}:${pubkey}`;
    let record = records.get(key);
    if (!record) {
      if (records.size >= MAX_ACTIVITY_RECORDS) return;
      record = {
        entry: Object.freeze({
          channelId,
          ...(threadRootId ? { threadRootId } : {}),
          pubkey,
        }),
        lastActivityAt: -1,
        lastMessageAt: -1,
        visibleUntil: 0,
        quietUntil: 0,
      };
      records.set(key, record);
    }
    return record;
  }
  function accept(events: readonly RelayEvent[], live = false) {
    if (closed) return;
    const now = Date.now();
    // Keep completion evidence until old pulses can no longer be current.
    // At capacity, drop new scopes rather than evict that evidence.
    expireSilence(now);
    for (const event of events) {
      if (event.kind === 9 || event.kind === 40002 || event.kind === 40008)
        receive(event, now);
    }
    // Completion wins even when activity came first in the batch.
    if (live) {
      for (const event of events) {
        if (event.kind === 20002) receive(event, now);
      }
    }
    publish();
  }
  function clear() {
    records.clear();
    publish();
  }
  return {
    capability: Object.freeze({
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    accept,
    clear,
    dispose() {
      closed = true;
      clear();
      listeners.clear();
    },
  };
}
