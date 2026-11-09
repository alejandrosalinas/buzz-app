import type { VisibleEvent } from "../../features/relay/projection";
import { threadReference } from "../../features/relay/thread-reference";
import { plainText } from "../../features/notifications/content";

export type ReadEvent = VisibleEvent;
export type Entry = {
  id: string;
  channelId: string;
  threadRootId?: string;
  text: string;
  /** Sent: relay time. Draft: when this device last saw it change. */
  createdAt?: number;
  /** Sent: Buzz's millisecond send order (`ms` tag), so same-second messages sort as Buzz shows them. */
  createdAtMs?: number;
};

export const SENT_LIMIT = 100;
/** Recent own edits and deletions read alongside Sent. */
export const UPDATE_LIMIT = 500;
/** Kinds that change an own message after it's sent: deletions and edits. */
export const UPDATE_KINDS = [5, 9005, 40003];

/** Relay-accepted, or already on the relay; a send still in flight or failed is not sent. */
export const accepted = (event: Pick<ReadEvent, "delivery">) =>
  !event.delivery || event.delivery === "accepted" || event.delivery === "seen";

/** The thread a message belongs to, by Buzz's rule; a lone root makes it top-level. */
export const threadRoot = (event: Parameters<typeof threadReference>[0]) =>
  threadReference(event)?.rootId;

/** Buzz's sub-second send order: `ms` is a 0–999 offset within the signed second. */
export function eventMs(event: Pick<ReadEvent, "created_at" | "tags">) {
  const value = event.tags.find(([name]) => name === "ms")?.[1];
  const offset = value && /^(0|[1-9]\d{0,2})$/.test(value) ? Number(value) : 0;
  return event.created_at * 1000 + offset;
}

/** Buzz's one message order: effective milliseconds, then event id. */
export const compareEvents = (a: ReadEvent, b: ReadEvent) =>
  eventMs(a) - eventMs(b) || a.id.localeCompare(b.id);

const targetsOf = (update: ReadEvent) =>
  update.tags.flatMap(([name, target]) =>
    name === "e" && target ? [target] : [],
  );

/**
 * Own messages as they read now: deleted ones are dropped, and edited ones show their latest
 * edit. Only the message's author can change it here, since every event is the viewer's.
 */
function current(events: readonly ReadEvent[], viewer: string) {
  const updates = events.filter(
    (update) =>
      update.pubkey === viewer &&
      UPDATE_KINDS.includes(update.kind) &&
      accepted(update),
  );
  const deleted = new Set(
    updates.filter((update) => update.kind !== 40003).flatMap(targetsOf),
  );
  const edits = new Map<string, ReadEvent>();
  // A deleted edit no longer counts, so the message falls back to its previous text.
  for (const edit of updates)
    if (edit.kind === 40003 && !deleted.has(edit.id))
      for (const target of targetsOf(edit)) {
        const known = edits.get(target);
        if (!known || compareEvents(edit, known) > 0) edits.set(target, edit);
      }
  return (event: ReadEvent) => {
    if (deleted.has(event.id)) return undefined;
    const edit = edits.get(event.id);
    return edit ? { ...event, content: edit.content } : event;
  };
}

export function sentEntries(
  events: readonly ReadEvent[],
  viewer: string,
): Entry[] {
  const entries = new Map<string, Entry>();
  const now = current(events, viewer);
  for (const original of events) {
    if (
      original.kind !== 9 ||
      original.pubkey !== viewer ||
      !accepted(original)
    )
      continue;
    const event = now(original);
    if (!event) continue;
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channelId || !Number.isFinite(event.created_at)) continue;
    const root = threadRoot(event);
    entries.set(event.id, {
      id: event.id,
      channelId,
      ...(root ? { threadRootId: root } : {}),
      text: event.content,
      createdAt: event.created_at,
      createdAtMs: eventMs(event),
    });
  }
  // Newest first: the reverse of Buzz's message order.
  return [...entries.values()]
    .sort(
      (a, b) =>
        (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0) || b.id.localeCompare(a.id),
    )
    .slice(0, SENT_LIMIT);
}

/** One readable line: spoilers hidden, Markdown and media reduced to their words. */
export const preview = (text: string, fallback: string) =>
  plainText(text) || fallback;

export function matches(text: string, label: string, search: string) {
  const haystack = `${text} ${label}`.toLocaleLowerCase();
  return search
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

const day = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function clockTime(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fullTime(seconds: number) {
  return new Date(seconds * 1000).toLocaleString([], {
    dateStyle: "full",
    timeStyle: "short",
  });
}

/** Group heading for a sent message: "Today", "Yesterday", or its date. */
export function dayLabel(seconds: number, now = Date.now()) {
  const then = new Date(seconds * 1000);
  const days = Math.round((day(new Date(now)) - day(then)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return then.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(then.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}
