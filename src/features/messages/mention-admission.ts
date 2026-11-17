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
 * Whether a composer can name people outside its destination from the
 * community directory. In a Solo chat only the composers that invite agents
 * can (the chat and its threads, the owner's and a shared chat's), so its
 * people can reference anyone; media comments and edits do not invite agents
 * and keep their members-only choices. Other known channels can unless a
 * closed roster or agent invitation limits the choices. Delivery decides what
 * an outside key becomes: an added member, or a reference that notifies
 * nobody (`outsideMentionReferences`).
 */
export function allowsOutsideMentions(
  channel: Pick<ChannelSummary, "channelType"> | undefined,
  roster?: readonly MentionRecipient[],
  inviteAgents = false,
) {
  if (!channel) return false;
  return channel.channelType === "solo"
    ? inviteAgents
    : !roster && !inviteAgents;
}

/**
 * Whether sending names this outside key only as a reference, which adds and
 * notifies nobody. Nobody can be added to a DM. A Solo chat adds only the
 * viewer's available agents; any other outside key is a reference there too.
 * Elsewhere the sender chooses whether to add outside people.
 */
export function outsideMentionReferences(
  channel: Pick<ChannelSummary, "channelType"> | undefined,
  agents: readonly { pubkey: string }[],
  pubkey: string,
) {
  if (channel?.channelType === "dm") return true;
  if (channel?.channelType === "solo")
    return !agents.some((agent) => agent.pubkey === pubkey);
  return false;
}

type AgentRead = {
  complete: boolean;
  identities: readonly { pubkey: string }[];
};
/** Each session's last complete agent read, kept across composer lifetimes. */
const completeReads = new WeakMap<object, AgentRead["identities"]>();

/**
 * The agents that classify names already picked, or undefined until the
 * session has read every agent source once: before that, any outside name may
 * be one of the viewer's agents. A refresh or a failed source drops agents
 * until a read completes. Until then, an agent the current read lists or the
 * session's last complete read listed stays an agent: admission picked it
 * from a complete read, and the send reads again before it goes.
 */
export function pickedAgents(choices: { snapshot(): AgentRead }) {
  const read = choices.snapshot();
  if (read.complete) {
    completeReads.set(choices, read.identities);
    return read.identities;
  }
  const kept = completeReads.get(choices);
  return kept && [...read.identities, ...kept];
}

/** Solo chats a New chat is about to start, by their reserved ids. */
const startingChats = new Map<string, ChannelSummary>();

/**
 * Reserve `channelId` for the Solo chat a New chat starts. Until that chat
 * lists, its mentions follow a Solo chat holding only the viewer, so the
 * first message can reference people as later ones do. Returns the release.
 */
export function reserveSoloMentions(
  session: ComposerSession,
  channelId: string,
) {
  const chat: ChannelSummary = {
    id: channelId,
    name: "",
    channelType: "solo",
    members: session.viewer ? [session.viewer] : [],
  };
  startingChats.set(channelId, chat);
  return () => {
    if (startingChats.get(channelId) === chat) startingChats.delete(channelId);
  };
}

/** The destination a draft's mentions follow: its listed channel, else the
 * Solo chat a New chat reserved it for. */
export function mentionChannel(session: ComposerSession, channelId: string) {
  return (
    session.channels.list().channels.find((c) => c.id === channelId) ??
    startingChats.get(channelId)
  );
}

/** The reserved New chat stand-in alone, for callers that read the listed channel reactively. */
export function startingChat(channelId: string) {
  return startingChats.get(channelId);
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
  const channel = mentionChannel(session, channelId);
  if (channel?.archived || channel?.readOnly) return () => false;
  const allowed = roster
    ? new Set(roster.map((person) => person.pubkey))
    : new Set(channel?.members);
  if (!roster && inviteAgents && channel?.channelType !== "dm")
    for (const agent of session.agentChoices.snapshot().identities)
      allowed.add(agent.pubkey);
  // A roster leaves some members out on purpose (another person's agent in
  // a Solo chat); naming outside people must not bring them back. Without
  // known membership a roster admits no outside key. A Solo chat tells a
  // reference from your agent only by a complete agent read, so until then
  // it admits no outside key: a row must not say "Will not be notified" for
  // an agent the send would add. There an outside key is only a reference:
  // an agent of yours the roster leaves out (one a region's plugin refuses)
  // stays out, since the send would add it.
  const agents = session.agentChoices.snapshot();
  const solo = channel?.channelType === "solo";
  const open =
    allowsOutsideMentions(channel, roster, inviteAgents) &&
    (!solo || agents.complete);
  const members = roster ? channel?.members : undefined;
  const outside = (pubkey: string) =>
    open &&
    (!roster || (!!members && !members.includes(pubkey))) &&
    (!solo || outsideMentionReferences(channel, agents.identities, pubkey));
  return (pubkey) =>
    /^[0-9a-f]{64}$/.test(pubkey) &&
    // Whatever route offers it: member, roster, directory or bring-back, which
    // takes an agent out of its archive but never offers one being deleted.
    !agentUnavailable(session, pubkey, bringable) &&
    (allowed.has(pubkey) || outside(pubkey));
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
