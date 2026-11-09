import { useEffect, useSyncExternalStore } from "react";
import type { ChannelList } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { readView, writeView } from "../../shared/view-state";
import type { CommunityMembership } from "../moderation/membership";

export const FIRST_CHANNEL_NAME = "general";
const SETTLED = "first-channel";
// One attempt per community each app run, whatever it ends with: a failure
// waits for the next launch rather than retrying on every render.
const attempted = new Set<string>();

/**
 * Gives a brand-new community its first channel, until the relay does
 * (block/buzz#9108). Only the community owner's client acts, only while it
 * has joined no channel, and only when the relay holds no channel at all,
 * archived and private ones included, DMs and Solo chats aside (one small
 * capped read). It then creates one open
 * `general` and flags it as the starter channel, so the relay joins new
 * members to it. It never joins anyone or posts in a channel. Messages opens
 * it through its usual first-channel fallback.
 *
 * Duplicates are bounded three ways: a settled marker per community on this
 * device, one attempt per app run, and the relay's unique open channel name
 * (block/buzz#8787), which refuses a second `general` from another device.
 */
export function useFirstChannel({
  scope,
  cached,
  queries,
  list,
  membership,
}: {
  scope: string;
  cached: boolean;
  queries: RelaySession;
  list: ChannelList;
  membership?: CommunityMembership | undefined;
}) {
  const noChannels =
    !cached &&
    list.status === "ready" &&
    !list.channels.some(
      (channel) =>
        channel.metadataPending ||
        channel.channelType === "stream" ||
        channel.channelType === "forum",
    ) &&
    !readView(scope, SETTLED, false);
  // Read the community roster only for a viewer with no channel to open.
  useEffect(
    () => (noChannels ? membership?.ensure() : undefined),
    [noChannels, membership],
  );
  const owner = useSyncExternalStore(
    membership?.subscribe ?? noSubscription,
    () => ownsCommunity(membership),
    () => ownsCommunity(membership),
  );
  useEffect(() => {
    if (!owner || !noChannels) return;
    if (attempted.has(scope)) return;
    attempted.add(scope);
    ensureFirstChannel(queries).then(
      (settled) => {
        if (settled) writeView(scope, SETTLED, true);
      },
      (error: unknown) => {
        console.warn("Could not create the community's first channel", error);
      },
    );
  }, [scope, owner, noChannels, queries]);
}

/** True once the community has a channel; false when it cannot tell yet. */
export async function ensureFirstChannel(queries: RelaySession) {
  const { channels, channelCreation, channelLifecycle } = queries;
  if (!channels.anyChannel || !channelCreation.available) return false;
  // Any stream or forum the relay knows of, open, private or archived, means
  // the community is not new. DMs and Solo chats (the Bestie tab opens one)
  // do not count, unless a full batch of 20 comes back.
  if (await channels.anyChannel()) return true;
  const id = await channelCreation.create({
    name: FIRST_CHANNEL_NAME,
    visibility: "open",
  });
  if (channelLifecycle.available)
    await channelLifecycle.run("auto-join-on", id).catch((error: unknown) => {
      // The channel stands without the flag; an admin can still set it.
      console.warn("Could not make the first channel a starter channel", error);
    });
  return true;
}

const noSubscription = () => () => {};
const ownsCommunity = (membership: CommunityMembership | undefined) => {
  const roster = membership?.snapshot();
  return roster?.status === "ready" && roster.role === "owner";
};

/** Test seam: forget this run's attempts. */
export function resetFirstChannelAttempts() {
  attempted.clear();
}
