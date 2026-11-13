import { useEffect, useSyncExternalStore } from "react";
import type { MessageReaction } from "../relay/contracts";
import { isReactionShortcode, type CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";

const catalogIndexes = new WeakMap<
  readonly CustomEmoji[],
  ReadonlyMap<string, CustomEmoji>
>();
/** Resolve a `:shortcode:` against one index per custom-emoji catalog snapshot. */
export function catalogEmoji(entries: readonly CustomEmoji[], content: string) {
  if (!content.startsWith(":")) return undefined;
  let index = catalogIndexes.get(entries);
  if (!index) {
    index = new Map(entries.map((entry) => [`:${entry.shortcode}:`, entry]));
    catalogIndexes.set(entries, index);
  }
  return index.get(content.toLowerCase());
}

/** The emoji a reaction slot draws: its own NIP-30 tag, else, for a tagless
 * `:shortcode:` (agents send these), the community palette's entry. */
export function useReactionEmoji(
  reaction: MessageReaction,
  session: RelaySession,
) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const tagless = !reaction.emoji && isReactionShortcode(reaction.content);
  useEffect(() => {
    if (tagless) void session.emoji.ensure();
  }, [tagless, session.emoji]);
  return (
    reaction.emoji ??
    (tagless ? catalogEmoji(catalog.entries, reaction.content) : undefined)
  );
}
