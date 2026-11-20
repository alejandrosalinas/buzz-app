import type { EventData } from "./events";

const HEX64 = /^[0-9a-f]{64}$/;

/** The signer's claim, in a signed `["relayed-from", <agent>, <source chat>?]`
 * tag, that another agent wrote this text and the signer relayed it. One
 * well-formed claim, or none: conflicting claims name no one. */
export function relayedFromClaim(
  event: Pick<EventData, "kind" | "tags">,
): { agent: string; channelId?: string } | undefined {
  if (event.kind !== 9) return undefined;
  const claims = event.tags.filter(([name]) => name === "relayed-from");
  const [claim] = claims;
  const agent = claim?.[1];
  if (claims.length !== 1 || !agent || !HEX64.test(agent)) return undefined;
  const channelId = claim[2];
  return channelId ? { agent, channelId } : { agent };
}

/** Text before the first blank line of the signed original is the relaying
 * sender's notice for clients that do not read the tag. */
export function relayNotice(content: string) {
  const end = content.indexOf("\n\n");
  return end > 0 ? content.slice(0, end) : undefined;
}

/** A mention the editor bound to its profile reads as its label. */
const mentionLabels = (text: string) =>
  text.replace(/\[((?:\\.|[^\]\\])*)\]\(nostr:[^)\s]+\)/g, (_, label: string) =>
    label.replace(/\\(.)/g, "$1"),
  );

/** A client that draws attribution from the tag omits the notice, but only
 * while the shown text still opens with the whole notice paragraph: an edit
 * may have replaced it, or bound its mention to a profile link. */
export function withoutRelayNotice(
  content: string,
  notice: string | undefined,
) {
  if (!notice) return content;
  const end = content.indexOf("\n\n");
  const first = end < 0 ? content : content.slice(0, end);
  if (first !== notice && mentionLabels(first) !== mentionLabels(notice))
    return content;
  return end < 0 ? "" : content.slice(end).replace(/^\s*\n/, "");
}
