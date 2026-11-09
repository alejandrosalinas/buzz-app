import { groupReactions } from "../../features/relay/fold";
import type { InboxReaction } from "../../features/relay/inbox-reactions";
import type { RelayEvent } from "../../features/relay/events";

/** Apply the sender filter before deciding which emoji are shared. */
export function reactionRows(
  items: readonly InboxReaction[],
  include: (authorId: string) => boolean = () => true,
): InboxReaction[] {
  return items
    .flatMap((item) => {
      const events = item.events.filter((event) => include(event.pubkey));
      const rows = new Map<string, RelayEvent[]>();
      for (const group of groupReactions(events)) {
        const authors = new Set(group.events.map((event) => event.authorId));
        const key =
          authors.size > 1
            ? `emoji:${JSON.stringify([group.content, group.emoji?.url])}`
            : `person:${group.events[0]?.authorId}`;
        const ids = new Set(group.events.map((event) => event.id));
        rows.set(key, [
          ...(rows.get(key) ?? []),
          ...events.filter((event) => ids.has(event.id)),
        ]);
      }
      return [...rows].flatMap(([key, reactions]) => {
        reactions.sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
        const latest = reactions[0];
        if (!latest) return [];
        return [
          {
            ...item,
            id: `${item.id}:${key}`,
            events: reactions,
            createdAt: latest.created_at,
          },
        ];
      });
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
