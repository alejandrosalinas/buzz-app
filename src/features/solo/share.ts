import {
  sameLabels,
  type ChannelDetailsDraft,
  type ChannelDetails,
} from "../relay/channel-details-protocol";
import { canAddMembers, canShareSoloChat } from "../channel-members/members";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { ownSolo, soloLabels } from "./labels";
import { generalAccessPolicy } from "../channels/general-access";

/** Sharing changes access, never presentation or Solo placement. */
export function canShareConversation(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return (
    canShareSoloChat(session, channel) ||
    !!(
      channel &&
      !channel.huddle &&
      !channel.metadataPending &&
      !channel.cached &&
      !channel.readOnly &&
      !channel.archived &&
      channel.members?.includes(session.viewer ?? "") &&
      canAddMembers(session, channel)
    )
  );
}

export const soloChatLink = (id: string) =>
  `buzz://channel/${encodeURIComponent(id)}`;
export const soloChatLinkMessage = (id: string, name = id.slice(0, 8)) =>
  `[${name.replace(/\s+/g, " ").replace(/[\\`[\]*_~<>&|]/g, "\\$&")}](${soloChatLink(id)})`;

/** Link sharing is available in channels, their threads and DMs. */
export function chatShareDestination(
  destination: Pick<ChannelSummary, "channelType"> | undefined,
) {
  return ["stream", "forum", "dm"].includes(destination?.channelType ?? "");
}

/** Check the destination before opening community reading; never enroll its members. */
export async function checkShareDestination(
  session: RelaySession,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const fresh = await session.channels.refreshRoster?.(id, {
    consistency: "strong",
    signal,
  });
  signal.throwIfAborted();
  const destination = session.channels
    .list()
    .channels.find((item) => item.id === id);
  if (
    !fresh ||
    !destination ||
    destination.huddle ||
    destination.metadataPending ||
    destination.cached ||
    destination.archived ||
    destination.readOnly ||
    !destination.members?.includes(session.viewer ?? "") ||
    !chatShareDestination(destination)
  )
    throw new Error(
      "Destination membership could not be confirmed. Retry to share.",
    );
}

/** Both share entry points confirm Private and View only chats. Public stays intact.
 * Return the signed snapshot for consent; confirmed Private writes use the existing
 * details owner and retain its exact uncertain attempt for explicit checking. */
export async function shareSoloChatAccess(
  session: RelaySession,
  id: string,
  {
    signal,
    confirmed,
    attempts,
    check = () => signal.throwIfAborted(),
    onAccessChanged,
  }: {
    signal: AbortSignal;
    confirmed?: ChannelDetails | undefined;
    attempts: Map<string, ChannelDetailsDraft>;
    check?: () => void;
    /** Only after this share's save or exact uncertain attempt is confirmed. */
    onAccessChanged?: () => void;
  },
): Promise<ChannelDetails | undefined> {
  check();
  const details = session.channelDetails;
  const pending = details.snapshot(id);
  if (pending) {
    if (pending.status !== "unconfirmed" || pending.draft !== attempts.get(id))
      throw new Error(
        "Finish the existing General access change before sharing.",
      );
    await details.check(id, signal);
    check();
    onAccessChanged?.();
  }
  const base = await details.load(id, signal);
  check();
  if (confirmed && confirmed.channelId !== id)
    throw new Error("Chat selection changed. Try sharing again.");
  if (base.visibility === "public")
    return base.joinRole === "guest" && !confirmed ? base : undefined;
  const source = session.channels
    .list()
    .channels.find((item) => item.id === id);
  if (
    !base.canEdit ||
    !soloLabels(base.labels) ||
    !ownSolo(source, session.viewer)
  )
    throw new Error("You can no longer change this chat’s general access.");
  if (!confirmed) return base;
  if (confirmed.visibility !== "private")
    throw new Error(
      "The chat is now Private. Close this dialog and share again to confirm the access change.",
    );
  const saving = details.save(
    confirmed,
    {
      ...confirmed,
      ...generalAccessPolicy("view-only", confirmed.joinRole),
    },
    signal,
    () => {
      check();
      return true;
    },
  );
  const draft = details.snapshot(id)?.draft;
  if (draft) attempts.set(id, draft);
  await saving;
  check();
  onAccessChanged?.();
}

/** Promote in place through the existing signed details owner. A retry checks an
 * uncertain save; it never republishes it or resets an unchanged cleanup deadline. */
export async function applySharedChannelDetails(
  session: RelaySession,
  id: string,
  draft: ChannelDetailsDraft,
  expected: ChannelDetailsDraft,
  signal: AbortSignal,
) {
  const details = session.channelDetails;
  const matches = (value: ChannelDetailsDraft) =>
    value.name === draft.name &&
    value.description === draft.description &&
    value.visibility === draft.visibility &&
    (draft.joinRole === undefined || value.joinRole === draft.joinRole) &&
    value.ttlSeconds === draft.ttlSeconds &&
    (draft.labels === undefined ||
      sameLabels(value.labels ?? [], draft.labels));
  const pending = details.snapshot(id);
  if (pending) {
    if (!matches(pending.draft) || pending.status !== "unconfirmed")
      throw new Error(
        "Finish the existing channel details change before continuing.",
      );
    await details.check(id, signal);
  }
  const base = await details.load(id, signal);
  if (!base.canEdit)
    throw new Error("You no longer have permission to edit this conversation.");
  if (!matches(base)) {
    if (
      base.name !== expected.name ||
      base.description !== expected.description ||
      base.visibility !== expected.visibility ||
      base.joinRole !== expected.joinRole ||
      base.ttlSeconds !== expected.ttlSeconds ||
      (draft.labels !== undefined &&
        !sameLabels(base.labels ?? [], expected.labels ?? []))
    )
      throw new Error(
        "Channel settings changed. Reload details before continuing.",
      );
    await details.save(base, draft, signal);
  }
}
