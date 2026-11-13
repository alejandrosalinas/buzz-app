import type { ChannelSummary } from "../relay/contracts";
import type { ComposerSession } from "./composer-session";
import type { MentionRecipient } from "./mention-draft";
import { agentUnavailable } from "../agents/choices";

/** The shared forward-looking rule applied to mention recipients: archived
 * here or being deleted ({@link agentUnavailable}). */
export function archivedMention(session: ComposerSession, pubkey: string) {
  return agentUnavailable(session, pubkey);
}

/**
 * Whether a destination can name people outside it from the community
 * directory. A Solo chat cannot: its mentions admit agents through the Solo chat
 * choice policy. This follows the channel type, not composer props, because
 * some Solo chat composers (media comments, edits) do not carry Solo mode.
 */
export function allowsOutsideMentions(
  channel: Pick<ChannelSummary, "channelType"> | undefined,
) {
  return !!channel && channel.channelType !== "solo";
}

/**
 * Which keys a draft may address in this destination, read once from current
 * state. The host owns this rule; the mentions plugin offers a subset of it and
 * owns its order and labels. Delivery checks membership again and asks before
 * addressing outside people.
 */
export function mentionAdmission(
  session: ComposerSession,
  channelId: string,
  inviteAgents = false,
  roster?: readonly MentionRecipient[],
  /** The owner's agents from their other communities: bringing one here
   * takes it out of its archive here, as after a Remove. */
  bringable: ReadonlySet<string> = new Set(),
): (pubkey: string) => boolean {
  const channel = session.channels
    .list()
    .channels.find((c) => c.id === channelId);
  if (channel?.archived || channel?.readOnly) return () => false;
  const allowed = roster
    ? new Set(roster.map((person) => person.pubkey))
    : new Set(channel?.members);
  if (!roster && inviteAgents && channel?.channelType !== "dm")
    for (const agent of session.agentChoices.snapshot().identities)
      allowed.add(agent.pubkey);
  const outside = !roster && !inviteAgents && allowsOutsideMentions(channel);
  return (pubkey) =>
    /^[0-9a-f]{64}$/.test(pubkey) &&
    // Whatever route offers it: member, roster, directory or bring-back, which
    // takes an agent out of its archive but never offers one being deleted.
    !agentUnavailable(session, pubkey, bringable) &&
    (outside || allowed.has(pubkey));
}

/**
 * The recipient a pasted identity link adds, under its current name, or null.
 * The pasted label is never the name: it could disguise the invitee. A key
 * with no known name is accepted only if it is a member; otherwise the link
 * stays display-only, as the chooser would not offer it.
 */
export function pastedMentionRecipient(
  session: ComposerSession,
  channelId: string,
  pubkey: string,
  inviteAgents = false,
  roster?: readonly MentionRecipient[],
): MentionRecipient | null {
  if (!mentionAdmission(session, channelId, inviteAgents, roster)(pubkey))
    return null;
  const listed = roster?.find((person) => person.pubkey === pubkey);
  const name =
    session.profiles.snapshot().get(pubkey)?.name ||
    listed?.name ||
    session.agentChoices
      .snapshot()
      .identities.find((agent) => agent.pubkey === pubkey)?.name;
  if (name) return { pubkey, name };
  const member = roster
    ? !!listed
    : !!session.channels
        .list()
        .channels.find((c) => c.id === channelId)
        ?.members?.includes(pubkey);
  return member ? { pubkey, name: pubkey.slice(0, 12) } : null;
}
