import type { ReadFilter } from "../../features/relay/events";
import { deletionApplies, messageAuthor } from "../../features/relay/fold";
import {
  accepted,
  compareEvents,
  eventMs,
  threadRoot,
  type Entry,
  type ReadEvent,
} from "./model";

/** How a row's conversation is read: a thread, a whole DM or Solo chat, or replies to a channel post. */
export type Shape = "thread" | "room" | "post";

/** A conversation message with the author Buzz shows for it; `pubkey` stays its signer. */
export type ContextEvent = ReadEvent & { author: string };

/** What happened around one message: who's involved, and what others said after it. */
export type Activity = {
  /** Other people and agents in the conversation, most recently active first. */
  people: string[];
  /** Messages by others after this one, oldest first. */
  after: ContextEvent[];
  /** Replies to a channel post (any author), for posts that aren't in a thread. */
  replies?: number;
};

/** Kinds Buzz shows as conversation messages: messages, agent replies and patches. */
export const CONTEXT_KINDS = [9, 40002, 40008];
/** NIP-09 and NIP-29 deletions. */
export const DELETION_KINDS = [5, 9005];
export const THREAD_LIMIT = 500;
export const THREAD_KEYS = 150;
export const ROOM_LIMIT = 100;
export const ROOMS_PER_VIEW = 4;
export const ROOM_VIEWS = 6;

export function shapeOf(entry: Entry, room: boolean): Shape {
  return entry.threadRootId ? "thread" : room ? "room" : "post";
}

/**
 * Bounded reads for the context of the listed messages. `threads` covers every thread
 * (its root and replies) and replies to channel posts; each `rooms` group is one view of
 * at most four DM or Solo chats, read from the oldest listed message in each.
 */
export function contextFilters(
  entries: readonly Entry[],
  isRoom: (channelId: string) => boolean,
) {
  const keys = new Set<string>();
  const roots = new Set<string>();
  const since = new Map<string, number>();
  for (const entry of entries) {
    const shape = shapeOf(entry, isRoom(entry.channelId));
    if (shape === "thread" && entry.threadRootId) {
      if (keys.size < THREAD_KEYS) keys.add(entry.threadRootId);
      if (roots.size < THREAD_KEYS) roots.add(entry.threadRootId);
    } else if (shape === "post") {
      if (entry.createdAt !== undefined && keys.size < THREAD_KEYS)
        keys.add(entry.id);
    } else if (entry.createdAt !== undefined) {
      const earliest = since.get(entry.channelId);
      since.set(
        entry.channelId,
        earliest === undefined
          ? entry.createdAt
          : Math.min(earliest, entry.createdAt),
      );
    }
  }
  const threads: ReadFilter[] = [];
  if (keys.size)
    threads.push({
      kinds: CONTEXT_KINDS,
      "#e": [...keys].sort(),
      limit: THREAD_LIMIT,
    });
  if (roots.size)
    threads.push({
      kinds: CONTEXT_KINDS,
      ids: [...roots].sort(),
      limit: roots.size,
    });
  const rooms: ReadFilter[][] = [];
  const listed = [...since]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, ROOMS_PER_VIEW * ROOM_VIEWS);
  for (let i = 0; i < listed.length; i += ROOMS_PER_VIEW)
    rooms.push(
      listed.slice(i, i + ROOMS_PER_VIEW).map(([id, from]) => ({
        kinds: CONTEXT_KINDS,
        "#h": [id],
        since: from,
        limit: ROOM_LIMIT,
      })),
    );
  return { threads, rooms };
}

/**
 * How far back a bounded read is complete, in Unix seconds. A read that returned fewer
 * events than its limit is complete (`-Infinity`). One that filled it holds the newest
 * `limit` events, so it's complete only for times after its oldest one: events in that
 * same second may have been cut. Extra retained or live events only raise the floor.
 */
export function coverageFloor(events: readonly ReadEvent[], limit: number) {
  if (events.length < limit) return -Infinity;
  return (
    events.map((event) => event.created_at).sort((a, b) => b - a)[limit - 1] ??
    -Infinity
  );
}

/** The host keeps at most this many events, and bytes of them, per view, newest first (its `retainEvents`). */
export const RETAINED_EVENTS = 2000;
export const RETAINED_BYTES = 8 * 1024 * 1024;
/** Room left for the next event: the host stops before one that would cross its byte budget. */
const EVENT_BYTES = 1024 * 1024;
const sizes = new WeakMap<object, number>();
const encoder = new TextEncoder();

/**
 * How far back the host's own retention leaves a view complete, in Unix seconds. Under its
 * caps nothing was evicted (`-Infinity`). Near them, older events may have been dropped, so
 * only times after the oldest retained one are complete.
 */
export function retentionFloor(events: readonly ReadEvent[]) {
  if (!events.length) return -Infinity;
  let bytes = 0;
  for (const event of events) {
    let size = sizes.get(event);
    if (size === undefined) {
      size = encoder.encode(JSON.stringify(event)).byteLength;
      sizes.set(event, size);
    }
    bytes += size;
  }
  if (events.length < RETAINED_EVENTS && bytes + EVENT_BYTES <= RETAINED_BYTES)
    return -Infinity;
  return Math.min(...events.map((event) => event.created_at));
}

export const DELETION_IDS = 1000;
/** Deletion views kept at once before they're rebuilt as full chunks. */
export const DELETION_VIEWS = 8;
/** One chunk per view: its two id lists stay well inside the host's 64 KB read budget. */
const DELETION_CHUNK = 250;

/**
 * Bounded reads for deletions of the given messages, newest first, one view per chunk. Each
 * also reads its targets by id, so deletions arrive in the same view as the messages they remove.
 */
export function deletionFilters(ids: readonly string[]): ReadFilter[][] {
  const views: ReadFilter[][] = [];
  for (let i = 0; i < Math.min(ids.length, DELETION_IDS); i += DELETION_CHUNK) {
    const chunk = ids.slice(i, Math.min(i + DELETION_CHUNK, DELETION_IDS));
    views.push([
      { kinds: CONTEXT_KINDS, ids: chunk, limit: chunk.length },
      { kinds: DELETION_KINDS, "#e": chunk, limit: THREAD_LIMIT },
    ]);
  }
  return views;
}

const channelOf = (event: ReadEvent) =>
  event.tags.find((tag) => tag[0] === "h")?.[1];
/** After the entry in Buzz's message order: effective milliseconds, then event id. */
const later = (event: ReadEvent, entry: Entry) => {
  if (event.id === entry.id) return false;
  const ms = entry.createdAtMs ?? (entry.createdAt ?? 0) * 1000;
  return eventMs(event) > ms || (eventMs(event) === ms && event.id > entry.id);
};

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/**
 * Indexes the context events once, so each row is a cheap lookup. Deleted messages are left
 * out, and each keeps the author Buzz shows for it, given the community relay's `authority`.
 */
export function indexContext(
  events: readonly ReadEvent[],
  deletions: readonly ReadEvent[] = [],
  authority?: string,
) {
  const byThread = new Map<string, ContextEvent[]>();
  const byRoom = new Map<string, ContextEvent[]>();
  const byId = new Map<string, ContextEvent>();
  const removals = new Map<string, ReadEvent[]>();
  for (const deletion of deletions) {
    if (!DELETION_KINDS.includes(deletion.kind) || !accepted(deletion))
      continue;
    for (const [name, target] of deletion.tags)
      if (name === "e" && target) push(removals, target, deletion);
  }
  for (const signed of events) {
    if (
      !CONTEXT_KINDS.includes(signed.kind) ||
      byId.has(signed.id) ||
      !accepted(signed)
    )
      continue;
    if (
      removals
        .get(signed.id)
        ?.some((deletion) => deletionApplies(deletion, signed, authority))
    )
      continue;
    const event: ContextEvent = {
      ...signed,
      author: messageAuthor(signed, authority),
    };
    byId.set(event.id, event);
    const root = threadRoot(event);
    if (root) push(byThread, root, event);
    const channel = channelOf(event);
    if (channel) push(byRoom, channel, event);
  }
  for (const list of [...byThread.values(), ...byRoom.values()])
    list.sort(compareEvents);
  return { byThread, byRoom, byId };
}
export type ContextIndex = ReturnType<typeof indexContext>;

/** Others in the conversation, most recently active first, then the conversation's own members. */
function people(
  events: readonly ContextEvent[],
  viewer: string,
  members: readonly string[] = [],
) {
  const order: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const key = events[i]?.author;
    if (key && key !== viewer && !order.includes(key)) order.push(key);
  }
  for (const key of members)
    if (key !== viewer && !order.includes(key)) order.push(key);
  return order;
}

/**
 * Others' messages after your newest one in the conversation, from this entry on. A later
 * message of yours that isn't in Sent, such as one the relay signed in your name, settles
 * what came before it.
 */
function afterYours(
  events: readonly ContextEvent[],
  entry: Entry,
  viewer: string,
) {
  let mark = entry;
  for (const event of events)
    if (event.author === viewer && later(event, mark))
      mark = { ...mark, id: event.id, createdAtMs: eventMs(event) };
  return events.filter(
    (event) => event.author !== viewer && later(event, mark),
  );
}

export function activityOf(
  entry: Entry,
  shape: Shape,
  index: ContextIndex,
  viewer: string,
  members?: readonly string[],
): Activity {
  if (shape === "thread") {
    const rootId = entry.threadRootId ?? "";
    const root = index.byId.get(rootId);
    const thread = [
      ...(root ? [root] : []),
      ...(index.byThread.get(rootId) ?? []),
    ];
    return {
      people: people(thread, viewer),
      after:
        entry.createdAt === undefined ? [] : afterYours(thread, entry, viewer),
    };
  }
  if (shape === "room") {
    const room = index.byRoom.get(entry.channelId) ?? [];
    return {
      people: people(room, viewer, members),
      after:
        entry.createdAt === undefined ? [] : afterYours(room, entry, viewer),
    };
  }
  const replies = index.byThread.get(entry.id) ?? [];
  return {
    people: people(replies, viewer),
    after: afterYours(replies, entry, viewer),
    replies: replies.length,
  };
}
