import { useProfileGeneration } from "../relay/react";
import { workflowLabel } from "../relay/workflow-attribution";
import {
  useChannelIdentityNames,
  useIdentityNames,
} from "../identity-names/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import { threadFailure, type ThreadView } from "../relay/threads";
import type { ChannelReference } from "../relay/contracts";
import {
  LightningIcon,
  LockIcon,
} from "../../shared/design-system/icons/index";
import { channelIcon } from "../channels/channel-icon";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import styles from "./LinkPreview.module.css";
import { messagePreviewText } from "./message-preview-text";
import { linkedMessage } from "./linked-message";
import { avatarMedia } from "../../shared/avatar-source";
import { sortParticipantNames } from "../identity-names/participant-order";
import { namedChannel, useChannelReference } from "./channel-reference";

/** Why a message link's preview can't be shown. Surfaces that report a failed
 * message link use these words too. */
export const previewFailures = {
  withheld:
    "Private channel. You aren’t a member, it no longer exists, or the link is from another community.",
  "not-found": "This message isn’t available. It may have been deleted.",
  unavailable: "Couldn’t load this preview.",
} as const;
type FoundChannel = Extract<ChannelReference, { state: "found" }>;
const loading = <span role="status">Loading message…</span>;

/** Mounted only while a preview is open. The session owns access, edits and
 * deletion. Like a click, the card looks the channel up before trusting a
 * refused read: an unjoined public channel is readable once found, and one
 * the viewer left once a lookup confirms it is still open. */
export function BuzzLinkPreview({
  session,
  channelId,
  messageId,
}: {
  session: RelaySession;
  channelId: string;
  messageId: string;
}) {
  const reference = useChannelReference(session.channels, channelId);
  const listLoading = useSyncExternalStore(
    session.channels.subscribeList,
    () => session.channels.list().status === "loading",
    () => false,
  );
  const readable = reference.state === "found" && reference.readable !== false;
  const withheld = reference.state === "withheld";
  // A channel becoming readable starts a fresh read, and a read from before
  // it is never shown; a withheld channel is never read.
  const [read, setRead] = useState<{
    view: ThreadView | undefined;
    readable: boolean;
  }>();
  useEffect(() => {
    if (withheld) return;
    try {
      const owned = session.thread(channelId, messageId, { exact: true });
      setRead({ view: owned, readable });
      void owned.refresh();
      return () => owned.dispose();
    } catch {
      setRead({ view: undefined, readable });
    }
  }, [session, channelId, messageId, readable, withheld]);
  const destination = namedChannel(reference);
  if (withheld) return <PreviewFailure reason="withheld" />;
  if (read?.readable !== readable) return loading;
  if (!read.view)
    return <PreviewFailure reason="unavailable" channel={destination} />;
  return (
    <PreviewContent
      view={read.view}
      session={session}
      messageId={messageId}
      destination={destination}
      // A lookup is on the way while one is queued or in flight, or while
      // discovery is still loading the list, which then either looks the
      // channel up or errors. Otherwise (the list errored, a failed lookup is
      // backing off, or the store is cached-only), the read's answer stands.
      looking={
        reference.state === "looking" ||
        (reference.state === "found" && !!reference.looking) ||
        listLoading
      }
    />
  );
}

function PreviewContent({
  view,
  session,
  messageId,
  destination,
  looking,
}: {
  view: ThreadView;
  session: RelaySession;
  messageId: string;
  destination: FoundChannel | undefined;
  /** A channel lookup is on the way, so a refused read may yet succeed. */
  looking: boolean;
}) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const { message, ready, stopped } = linkedMessage(snapshot, messageId);
  const resolveName = useChannelIdentityNames(session, message?.channelId);
  const identityName = useIdentityNames(session.names);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const authorId = message?.workflowOwnerId ?? message?.authorId;
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (authorId)
      void session.profiles.ensure([authorId], "background").catch(() => {});
  }, [session, authorId, profileGeneration]);
  if (!ready || !message) {
    if (!stopped || looking) return loading;
    // The card stops at any failed read, as navigation does at a failed root.
    const reason =
      threadFailure(snapshot, true) ??
      (snapshot.status === "ready" ? "not-found" : "unavailable");
    return <PreviewFailure reason={reason} channel={destination} />;
  }
  const displayId = message.workflowOwnerId ?? message.authorId;
  const profile = profiles.get(displayId);
  const resolved = resolveName(
    displayId,
    profile?.name ?? displayId.slice(0, 10),
  );
  const name = message.workflowOwnerId ? workflowLabel(resolved) : resolved;
  const date = new Date(message.createdAt * 1000);
  if (!Number.isFinite(date.getTime()))
    return <PreviewFailure reason="unavailable" channel={destination} />;
  // An unjoined channel is never listed; its lookup names it.
  const channel =
    channels.channels.find((item) => item.id === message.channelId) ??
    session.channels.get?.(message.channelId);
  const channelName =
    channel?.channelType === "dm" && channel.participants
      ? sortParticipantNames(
          channel.participants.map((id) =>
            identityName(
              id,
              profiles.get(id)?.name ?? id.slice(0, 10),
              channel.participants,
            ),
          ),
        ).join(", ") || "Notes to self"
      : (channel?.name ?? "Channel unavailable");
  const ChannelIcon =
    channel?.hidden || channel?.channelType === "dm"
      ? LockIcon
      : channelIcon(channel);
  return (
    <>
      <span className={styles.byline}>
        <Avatar
          alt={name}
          fallback={name}
          fallbackContent={
            message.workflowOwnerId ? <LightningIcon size={20} /> : undefined
          }
          shape={message.workflowOwnerId ? "squircle" : "circle"}
          src={
            message.workflowOwnerId
              ? null
              : avatarMedia(profile?.picture, session.media)
          }
        />
        <span className={styles.metadata}>
          <span className={styles.author}>
            <strong>{name}</strong>
            <time
              dateTime={date.toISOString()}
              title={date.toLocaleString(undefined, {
                dateStyle: "full",
                timeStyle: "short",
              })}
            >
              {relativeTimestamp(message.createdAt)}
            </time>
          </span>
          <span className={styles.channel}>
            {channel && <ChannelIcon aria-hidden="true" size={13} />}
            <span>{channelName}</span>
          </span>
        </span>
      </span>
      <span className={styles.message}>
        {messagePreviewText(message.content) ||
          (message.attachments.length ? "Attachment" : "Empty message")}
      </span>
    </>
  );
}

/** A failed preview names its channel when found, says why it failed, and
 * shows that the card still opens the link. */
function PreviewFailure({
  reason,
  channel,
}: {
  reason: keyof typeof previewFailures;
  channel?: FoundChannel | undefined;
}) {
  return (
    <>
      {channel && <ChannelByline channel={channel} />}
      <span role="status">{previewFailures[reason]}</span>
      {/* A withheld destination's card explains why; it opens nothing. */}
      {reason !== "withheld" && <span className={styles.hint}>Open link</span>}
    </>
  );
}

/** Hover card for a channel-only link. The store supplies what the reader
 * may see; a nonmember sees an open channel's public metadata, never its
 * roster. */
export function ChannelLinkPreview({ channel }: { channel: FoundChannel }) {
  return (
    <>
      <ChannelByline channel={channel} />
      {channel.description && (
        <span className={styles.message}>{channel.description}</span>
      )}
    </>
  );
}

function ChannelByline({ channel }: { channel: FoundChannel }) {
  const Icon = channelIcon(channel.private ? { private: true } : undefined);
  const details = [
    channel.private ? "Private channel" : "Public channel",
    channel.archived ? "Archived" : "",
    channel.joined ? "Joined" : "Not joined",
    channel.members
      ? `${channel.members} ${channel.members === 1 ? "member" : "members"}`
      : "",
  ].filter(Boolean);
  return (
    <span className={styles.byline}>
      <Icon aria-hidden="true" size={20} />
      <span className={styles.metadata}>
        <span className={styles.author}>
          <strong>{channel.name}</strong>
        </span>
        <span className={styles.channel}>
          <span>{details.join(" · ")}</span>
        </span>
      </span>
    </span>
  );
}
