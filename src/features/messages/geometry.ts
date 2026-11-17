import type { VirtualizerHandle } from "virtua";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { ChannelQueries } from "../relay/contracts";

type Entry = {
  signature: string;
  width: number;
  cache: VirtualizerHandle["cache"];
};
/** Identity/session-scoped and bounded. Event content (not IDs alone) and exact layout width
 * invalidate measurements. Weak ownership releases geometry with the query session. */
const sessions = new WeakMap<ChannelQueries, Map<string, Entry>>();
export function geometryFor(queries: ChannelQueries) {
  const entries = sessions.get(queries) ?? new Map<string, Entry>();
  sessions.set(queries, entries);
  return {
    /** The signature is built only when a saved entry could match it. */
    get(channelId: string, signature: () => string, width: number) {
      const entry = entries.get(channelId);
      return entry?.width === width && entry.signature === signature()
        ? entry.cache
        : undefined;
    },
    set(
      channelId: string,
      signature: string,
      width: number,
      cache: VirtualizerHandle["cache"],
    ) {
      entries.delete(channelId);
      // Signatures include rendered text; bound that memory too, not only view count.
      if (signature.length > 256 * 1024) return;
      entries.set(channelId, { signature, width, cache });
      while (entries.size > 3) {
        const first = entries.keys().next().value;
        if (first === undefined) break;
        entries.delete(first);
      }
    },
  };
}
const eventSignatures = new WeakMap<ChannelMessage, string>();
export const geometrySignature = (
  events: readonly ChannelMessage[],
  profiles: ReadonlyMap<string, Profile>,
  resolveName?: (id: string, fallback: string) => string,
) =>
  events
    .map((event) => {
      let signature = eventSignatures.get(event);
      if (!signature) {
        signature = JSON.stringify(event);
        eventSignatures.set(event, signature);
      }
      const ids = event.membership
        ? [event.membership.actor, event.membership.target]
        : [
            event.authorId,
            ...(event.workflowOwnerId ? [event.workflowOwnerId] : []),
            ...event.mentions,
            ...(event.mentionReferences ?? []),
          ];
      const names = resolveName
        ? ids.map((id) => resolveName(id, profiles.get(id)?.name ?? id))
        : event.workflowOwnerId
          ? [profiles.get(event.workflowOwnerId)?.name]
          : [];
      return `${JSON.stringify(names)}:${signature.length}:${signature}:${JSON.stringify(event.membership ? [profiles.get(event.membership.actor), profiles.get(event.membership.target)] : profiles.get(event.authorId))}`;
    })
    .join("");
