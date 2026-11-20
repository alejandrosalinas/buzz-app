import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";

/** Your open DM with just `pubkey` among `channels`, if you have one. */
export const directMessageWith = (
  channels: readonly ChannelSummary[],
  pubkey: string,
) =>
  channels.find(
    (channel) =>
      channel.channelType === "dm" &&
      !channel.archived &&
      channel.participants?.length === 1 &&
      channel.participants[0] === pubkey,
  );

/** Where Message on a person leads: your DM with them, or a New message draft
 * addressed to them. Only a send creates a DM, so choosing someone by mistake
 * never leaves them an empty conversation. */
export async function messagePerson(
  session: RelaySession,
  pubkey: string,
  signal: AbortSignal,
): Promise<{ channelId: string } | { draftTo: string }> {
  if (!directMessageWith(session.channels.list().channels, pubkey))
    return { draftTo: pubkey };
  // The confirmed open also restores a DM this device hid.
  return { channelId: await session.directMessages.open([pubkey], signal) };
}

/** A New message draft addressed to `pubkey`. */
export const newMessageLink = (pubkey: string) =>
  `buzz://dm/new?to=${encodeURIComponent(pubkey)}`;

/** `messagePerson`, as a link for hosts that open links. */
export async function messagePersonLink(
  session: RelaySession,
  pubkey: string,
  signal: AbortSignal,
) {
  const destination = await messagePerson(session, pubkey, signal);
  return "channelId" in destination
    ? `buzz://channel/${encodeURIComponent(destination.channelId)}`
    : newMessageLink(destination.draftTo);
}
