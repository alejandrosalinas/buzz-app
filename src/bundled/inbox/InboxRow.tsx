import type { ComponentProps, ReactNode } from "react";
import { channelText } from "../../features/channels/channel-icon";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import type { InboxFeedSnapshot } from "../../features/relay/inbox-feed";
import type { RelaySession } from "../../features/relay/session";
import { workflowLabel } from "../../features/relay/workflow-attribution";
import { messagePreview } from "../../features/notifications/content";
import { avatarMedia } from "../../shared/avatar-source";
import { LightningIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { formatPublicKey } from "../../shared/identity/public-key";
import { dmLabel } from "./dm-label";
import styles from "./Inbox.module.css";

type ResolveName = (
  key: string,
  fallback: string,
  candidates?: readonly string[],
) => string;

export const hasUnread = (item: InboxItem) =>
  item.unreadCount > 0 || item.manual;

/** Who sent a row and where, as the Inbox page and its sidebar preview name it. */
export function rowIdentity(
  item: InboxItem,
  channel: ChannelSummary | undefined,
  profiles: ReadonlyMap<string, Profile>,
  name: ResolveName,
) {
  const displayId = item.workflowOwnerId ?? item.authorId;
  const profile = profiles.get(displayId);
  const resolved = name(
    displayId,
    profile?.name ?? formatPublicKey(displayId) ?? "Unknown sender",
    channel?.members,
  );
  const sender = item.workflowOwnerId ? workflowLabel(resolved) : resolved;
  const context =
    channel?.channelType === "dm"
      ? `DM · ${dmLabel(channel.participants, profiles, name, channel.name ?? "Direct message")}`
      : channel
        ? channelText(channel)
        : "Conversation";
  return { sender, context, profile };
}

/** Profiles a row names: its sender or workflow owner and up to three DM participants. */
export const rowProfileIds = (
  item: InboxItem,
  channel: ChannelSummary | undefined,
): string[] => [
  ...(item.workflowOwnerId ? [item.workflowOwnerId] : []),
  ...(channel?.channelType === "dm"
    ? (channel.participants?.slice(0, 3) ?? [])
    : []),
];

/** One Inbox conversation row's button: avatar, sender, source, time, preview and unread mark. */
export function InboxRowButton({
  item,
  identity: { sender, context, profile },
  media,
  feed,
  time,
  previewId,
  ...props
}: {
  item: InboxItem;
  identity: ReturnType<typeof rowIdentity>;
  media: RelaySession["media"];
  feed: InboxFeedSnapshot;
  time: ReactNode;
  previewId?: string | undefined;
} & Omit<
  ComponentProps<typeof NavigationItem>,
  "icon" | "label" | "trailing" | "aria-label"
>) {
  const unread = hasUnread(item);
  return (
    <NavigationItem
      {...props}
      aria-label={`Open ${sender} in ${context}`}
      aria-describedby={previewId}
      icon={
        <Avatar
          size="default"
          alt=""
          fallback={sender}
          fallbackContent={
            item.workflowOwnerId ? <LightningIcon size={20} /> : undefined
          }
          src={
            item.workflowOwnerId
              ? undefined
              : avatarMedia(profile?.picture, media)
          }
          shape={
            item.workflowOwnerId || profile?.isAgent ? "squircle" : "circle"
          }
        />
      }
      label={
        <span className={styles.content}>
          <span className={styles.heading}>
            <span className={styles.identity}>
              <strong
                className={`text-label-sm text-standard ${styles.sender}`}
              >
                {sender}
              </strong>
              <span
                className={`text-caption ${styles.source}`}
                data-inbox-source=""
              >
                {context}
              </span>
            </span>
            <time
              className={`text-caption text-subtle ${styles.rowDate}`}
              dateTime={new Date(item.createdAt * 1000).toISOString()}
            >
              {time}
            </time>
          </span>
          <span
            id={previewId}
            className={`text-body ${unread ? "text-standard" : "text-subtle"} ${styles.preview}`}
          >
            {[item.previewMessageId, ...item.messageIds].some(
              (id) => id !== undefined && feed.incomplete.includes(id),
            )
              ? feed.status === "error"
                ? "Preview unavailable. Retry inbox."
                : "Preview updating…"
              : messagePreview(item.preview)}
          </span>
        </span>
      }
      trailing={
        unread ? (
          <span className={styles.unreadSlot} role="img" aria-label="Unread">
            <span className={styles.unreadDot} />
          </span>
        ) : (
          <span className={styles.unreadSlot} aria-hidden="true" />
        )
      }
    />
  );
}
