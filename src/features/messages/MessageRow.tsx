import { AgentResponsePreview } from "./AgentResponsePreview";
import { useActivityIndicator } from "./use-activity-indicator";
import type { ActivityRowPresentation } from "./activity-presentation";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import { Collapsible } from "@base-ui/react/collapsible";
import { formatItemTimestamp } from "../../shared/datetime";
import { useClockPreference } from "../../shared/clock-preference";
import { ProfilePeek } from "../profiles/ProfilePeek";
import { AgentAvatar } from "../agents/AgentAvatar";
import {
  TypingPresentation,
  useReplacedTypers,
} from "../conversation/typing-presentation";
import { breathing, localActivity } from "../agents/local-activity";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { LightningIcon, RobotIcon } from "../../shared/design-system/icons";
import { useProfileOwner } from "../profiles/useProfileOwner";
import { messagePreviewText } from "../conversation/message-preview-text";
import { profileMentionParts } from "./profile-mentions";
import { addressedMessage } from "./audience-address";
import { WorkflowByline } from "./WorkflowByline";
import { threadWorkingAgents } from "../agents/thread-working";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { ComposerAccessories } from "../conversation/ComposerAccessories";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { MessageLink } from "../conversation/MessageLink";
import {
  DayDivider,
  MessageTimestamp,
  MessageTimestampHint,
} from "./MessageTimestamp";
import { useChannelIdentityNames } from "../identity-names/react";
import { Button } from "../../shared/design-system/ui/Button";
import { ReplySummary } from "./ReplySummary";
import { usePresenceStatus } from "../presence/react";
import { UserStatusDisplay } from "../user-status/StatusDisplay";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  memo,
  useMemo,
  useId,
  useRef,
  useState,
  useEffect,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
  type ReactElement,
  type RefObject,
} from "react";
import { useListedChannel } from "../relay/listed-channel";
import type { RelaySession } from "../relay/session";
import type { UnreadCapability } from "../relay/unread";
import { MediaAttachment, type MediaPlayback } from "./MediaAttachment";
import { parseMediaTimeReply } from "./media-timecode";
import { profileTarget, profileActivityViewTarget } from "../profiles/target";
import { MessageCard, useMessageRenderer } from "../conversation/MessageBody";
import { TargetOpenerProvider, WithTargetOpener } from "../conversation/opener";
import { InlineText } from "../conversation/InlineText";
import type {
  ConversationExtensions,
  MessageRenderer,
  MessageSummaryActivity,
} from "../conversation/contracts";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { AttachmentImage } from "./AttachmentImage";
import { DeliveryNotice } from "./DeliveryNotice";
import { AttachmentView } from "../conversation/AttachmentView";
import { AudioAttachment } from "./AudioAttachment";
import { AttachmentDownloadContext } from "./AttachmentDownloadContext";
import { isNativeMediaSource, isProxySource } from "./attachment-source";
import { FileAttachment } from "./FileAttachment";
import { useReferenceDirectory } from "./ReferenceText";
import { EditedMarker, MessageMarkdown } from "./MessageMarkdown";
import { safeMessageUrl } from "../relay/message-content";
import styles from "./Messages.module.css";
import { usesLargeEmojiPresentation } from "./emoji-size";
import { separateChatCards } from "./chat-cards";
import { MessageReactionControls, MessageReactions } from "./MessageReactions";

import {
  MessageManagementItems,
  MessageReadStateItem,
} from "./MessageManagement";
import { MessageActionBar } from "./MessageActionBar";
import { useForwardMessage } from "./ForwardMessage";
import { FlagIcon, ListBulletsIcon } from "../../shared/design-system/icons";
import {
  MenuIcon,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { ReportMessageDialog } from "./ReportMessageDialog";
import { messageCopyLink, messageCopyText } from "./message-copy";
import { avatarMedia } from "../../shared/avatar-source";

export type MessageLinkOrigin = Readonly<{ rootId: string }>;
export type MessageRowProps = {
  row: ChannelMessage;
  recordedActivity?: ActivityRowPresentation | undefined;
  representedAgents?: readonly string[] | undefined;
  repliedAgents?: readonly string[] | undefined;
  stoppedRequest?: ChannelMessage | undefined;
  staticMentions?: boolean | undefined;
  getThreadRoot?: (() => ChannelMessage | undefined) | undefined;
  session?: RelaySession | undefined;
  /** Resolves names, channels and mentions where the row is shown without
   * `session`, which would also offer its controls. */
  references?: RelaySession | undefined;
  scope?: string | undefined;
  unread?: UnreadCapability | undefined;
  extensions?: ConversationExtensions | undefined;
  profile: Profile | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  media(url: string, size?: "small"): string | undefined;
  /** Receives the thread the link was opened from: the row’s root, or the row. */
  onOpenLink(url: string, origin?: MessageLinkOrigin): boolean;
  day: boolean;
  retry: ((id: string) => void) | undefined;
  /** Pins this row in a virtualized list; returns the release. */
  keepMounted?: ((messageId: string) => () => void) | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string, intent?: "reply") => void)
    | undefined;
  onReply?: ((messageId: string) => void) | undefined;
  /** False: existing threads open, but the row offers none to start or reply in. */
  startsThreads?: boolean;
  quickControls?: ReactNode;
  overflowItems?: ReactNode;
  layout?: "timeline" | "thread" | "continuation";
  compactAvatar?: boolean;
  viewer?: string | undefined;
  stackPrevious?: boolean;
  stackNext?: boolean;
  alignViewer?: boolean;

  mediaMode?: "inline" | "thread";
  mediaSeekTo?: number;
  mediaSeekRequest?: number;
  onMediaPlayback?: (playback: MediaPlayback) => void;
  onMediaTime?: (seconds: number) => void;
  onOpenMediaReview?: (
    messageId: string,
    attachment: ChannelMessage["attachments"][number],
    seconds: number,
    hasComments?: boolean,
    attachments?: ChannelMessage["attachments"],
  ) => void;
};

type MessageContentProps = MessageRowProps & {
  shownRow?: ChannelMessage;
  renderMessage?: (
    message: ReactNode,
    trigger: RefObject<HTMLButtonElement | null>,
  ) => ReactElement;
};

const FullMessageRow = memo(function MessageRow(props: MessageContentProps) {
  return props.session && props.scope && props.extensions?.accessories ? (
    <TypingPresentation
      active
      key={`${props.scope}:${props.row.channelId}:${props.row.id}`}
    >
      <MessageRowContent {...props} />
    </TypingPresentation>
  ) : (
    <MessageRowContent {...props} />
  );
});
function MessageRowContent({
  row,
  shownRow,
  renderMessage,
  getThreadRoot,
  session,
  references = session,
  scope,
  unread,
  extensions,
  profile,
  media,
  onOpenLink,
  canOpenLink,
  day,
  retry,
  keepMounted,
  onOpenThread,
  onReply,
  startsThreads = true,
  quickControls,
  overflowItems,
  participantProfiles,
  layout = "timeline",
  compactAvatar = false,
  viewer = session?.viewer,
  stackPrevious = layout === "continuation",
  stackNext = false,
  representedAgents,
  repliedAgents,
  stoppedRequest,
  alignViewer = true,

  mediaMode = "inline",
  mediaSeekTo,
  mediaSeekRequest,
  onMediaPlayback,
  onMediaTime,
  onOpenMediaReview,
  agentPubkeys,
}: MessageContentProps) {
  const [avatarFocused, setAvatarFocused] = useState(false);
  const resolveName = useChannelIdentityNames(references, row.channelId);
  const directory = useReferenceDirectory(references, participantProfiles);
  const reactions = row.reactions;
  const threadUnread = useThreadUnread(
    row.replyCount > 0 && onOpenThread ? unread : undefined,
    row.channelId,
    row.threadRootId ?? row.id,
  );
  const { agents: threadAgents, waiting: threadWaiting } = useThreadAgents(
    onOpenThread && (row.replyCount > 0 || (startsThreads && !row.threadRootId))
      ? session
      : undefined,
    row.channelId,
    row.threadRootId ?? row.id,
    row.id,
    row.threadRootId,
  );
  const rootId = row.threadRootId ?? row.id;
  const openLink = useCallback(
    (url: string) => onOpenLink(url, { rootId }),
    [onOpenLink, rootId],
  );
  const channels = session?.channels;
  const listed = useListedChannel(
    channels,
    row.channelId,
    (channel) => !!channel,
  );
  const cached = useListedChannel(
    channels,
    row.channelId,
    (channel) => !!channel?.cached,
  );
  const archived = useListedChannel(
    channels,
    row.channelId,
    (channel) => !!channel?.archived,
  );
  const readOnly = useListedChannel(
    channels,
    row.channelId,
    (channel) => !!channel?.readOnly,
  );
  const { messageTimestamps } = useClockPreference();
  const solo = useListedChannel(
    references?.channels,
    row.channelId,
    (channel) => channel?.channelType === "solo",
  );
  const showTime =
    messageTimestamps === "show" ||
    (messageTimestamps === "hide-solo" && !solo);
  const unreadLabel =
    threadUnread?.manual === "local-only"
      ? "Thread marked unread on this device only"
      : threadUnread?.manual === "remote"
        ? "Thread marked unread"
        : (threadUnread?.observedCount ?? 0) > 0
          ? `Observed unread replies${threadUnread?.freshness === "stale" ? "; may be out of date" : ""}. Not an exact total.`
          : undefined;
  const workingLabel = threadAgents.length
    ? `${threadAgents
        .map(({ pubkey, name }) => resolveName(pubkey, name))
        .join(", ")} ${threadWaiting ? "waiting" : "working"}`
    : undefined;
  const firstThreadAgent = threadAgents[0];
  const threadWorkingLabel =
    threadAgents.length === 1 && firstThreadAgent
      ? `${resolveName(firstThreadAgent.pubkey, firstThreadAgent.name)} is ${threadWaiting ? "waiting" : "working"}`
      : `${threadAgents.length} agents are ${threadWaiting ? "waiting" : "working"}`;
  const name = resolveName(
    row.authorId,
    profile?.name ?? row.authorId.slice(0, 10),
  );
  const workflowOwnerName = row.workflowOwnerId
    ? resolveName(
        row.workflowOwnerId,
        directory.profiles.get(row.workflowOwnerId)?.name ??
          `${row.workflowOwnerId.slice(0, 10)}…`,
      )
    : undefined;
  const picture = avatarMedia(profile?.picture, media);
  const target = profileTarget(row.authorId, {
    agent: !!(row.agentEnvelope || agentPubkeys?.has(row.authorId)),
  });
  const clickable = target && canOpenLink?.(target);
  const activityView = profileActivityViewTarget(row.authorId);
  const canViewActivity =
    !!(
      row.agentEnvelope ||
      agentPubkeys?.has(row.authorId) ||
      profile?.isAgent
    ) &&
    activityView &&
    canOpenLink?.(activityView);
  const activityItem = canViewActivity && (
    <MenuItem
      onClick={() => {
        if (canOpenLink?.(activityView)) onOpenLink(activityView);
      }}
    >
      <MenuIcon>
        <ListBulletsIcon />
      </MenuIcon>
      View activity
    </MenuItem>
  );
  const avatarShape =
    row.agentEnvelope || agentPubkeys?.has(row.authorId) || profile?.isAgent
      ? "squircle"
      : "circle";
  const presence = usePresenceStatus(
    !row.workflowOwnerId && avatarShape === "squircle"
      ? session?.presence
      : undefined,
    row.authorId,
  );
  const agentAuthor = !row.workflowOwnerId && avatarShape === "squircle";
  const owner = useProfileOwner(
    session,
    agentAuthor && !stackPrevious ? row.authorId : undefined,
  );
  // The viewer's own agents carry only the agent mark.
  const ownerLabel =
    owner &&
    owner.id !== viewer &&
    owner.profile &&
    !owner.profile.nameIsFallback
      ? `${resolveName(owner.id, owner.profile.name)}’s agent`
      : undefined;
  const presenceId = useId();
  const shown = shownRow ?? row;
  const timeReply = shown.diff ? undefined : parseMediaTimeReply(shown.content);
  const sourceRow = timeReply
    ? { ...shown, content: timeReply.content }
    : shown;
  const { caption: displayRow, cards: chatCards } = useMemo(
    () => separateChatCards(sourceRow, directory.channels),
    [sourceRow, directory.channels],
  );
  const cardsOnly =
    chatCards.length > 0 && !displayRow.content.trim() && !timeReply;
  const attachmentOnly =
    !row.content.trim() &&
    !row.diff &&
    !row.agentEnvelope &&
    row.attachments.length > 0 &&
    row.attachments.every((attachment) => !!safeMessageUrl(attachment.url));
  // Own-message surface colours apply to a bubble, never to a shown thread root.
  const ownBubble =
    !shownRow && !row.workflowOwnerId && !!viewer && row.authorId === viewer;
  const emojiOnly = usesLargeEmojiPresentation(displayRow.content, row.emoji);
  const canReact = !!(
    extensions &&
    session &&
    scope &&
    session.outbox?.supports(7) &&
    session.outbox.supports(5) &&
    (!session.channels.get || listed) &&
    !archived &&
    !readOnly
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const active = useConversationPresentation();
  const forward = useForwardMessage();
  const [reporting, setReporting] = useState<"open" | "sent">();
  const registeredActions = useSyncExternalStore(
    extensions?.actions?.subscribe ?? noSubscribe,
    extensions?.actions?.snapshot ?? noActions,
    extensions?.actions?.snapshot ?? noActions,
  );
  const actions = session
    ? registeredActions.filter((action) => {
        try {
          return action.matches(row, session);
        } catch {
          return false; // A broken optional action leaves the menu usable.
        }
      })
    : [];
  // The instance, not its key: a reinstalled plugin must not reopen a dialog.
  const [openAction, setOpenAction] = useState<(typeof actions)[number]>();
  const opened =
    openAction && actions.includes(openAction) ? openAction : undefined;
  useEffect(() => {
    if (openAction && !opened) setOpenAction(undefined);
  }, [openAction, opened]);
  const keepAlive = reporting !== undefined || !!opened;
  // The dialog, pending submit and notice live in this row; eviction loses them.
  useEffect(() => {
    const release = keepAlive ? keepMounted?.(row.id) : undefined;
    // Dialog focus restoration runs in a microtask after unmount; releasing a
    // task later lets restored focus keep the row mounted instead.
    return release && (() => void setTimeout(release));
  }, [keepAlive, keepMounted, row.id]);
  const keepRowMounted = useMemo(
    () => keepMounted && (() => keepMounted(row.id)),
    [keepMounted, row.id],
  );
  const report =
    !row.membership &&
    !row.huddle &&
    (!row.delivery || ["accepted", "seen"].includes(row.delivery))
      ? session?.messages.report
      : undefined;
  const reportItem = report && (
    <>
      <MenuSeparator />
      <MenuItem
        disabled={reporting === "open"}
        onClick={() => setReporting("open")}
      >
        <MenuIcon>
          <FlagIcon />
        </MenuIcon>
        Report
      </MenuItem>
    </>
  );
  const actionItems = actions.map((action) =>
    action.placement === "menu" && session && extensions?.actions ? (
      <ContributionBoundary key={contributionKey(action)} fallback={null}>
        <WithTargetOpener
          component={action.component}
          props={{
            message: row,
            session,
            close: () => setOpenAction(undefined),
          }}
          registry={extensions.actions}
          entry={action}
        />
      </ContributionBoundary>
    ) : (
      <MenuItem key={action.key} onClick={() => setOpenAction(action)}>
        {action.icon && (
          <MenuIcon>
            <ContributionBoundary key={contributionKey(action)} fallback={null}>
              <action.icon />
            </ContributionBoundary>
          </MenuIcon>
        )}
        {action.title}
      </MenuItem>
    ),
  );
  // A message renderer may draw some attachments itself. Its claims count only
  // while its card is mounted, and they return to the host list while its
  // fallback shows. A remounted card starts healthy and claims again.
  const bodyShown = !attachmentOnly && !cardsOnly;
  const messageRenderer = useMessageRenderer(extensions?.messages, row);
  const [failedRenderer, setFailedRenderer] = useState<MessageRenderer>();
  const claims =
    bodyShown && messageRenderer !== failedRenderer
      ? messageRenderer?.ownsAttachment
      : undefined;
  // The host's Markdown marks an edit after the caption's last line. Plugin
  // cards are marked inside their bubble; diffs and captionless rows after the
  // payload.
  const editedInBody =
    bodyShown &&
    !row.diff &&
    !!displayRow.content.trim() &&
    (!messageRenderer || messageRenderer === failedRenderer);
  const claimed = (attachment: ChannelMessage["attachments"][number]) => {
    try {
      return !!claims?.call(messageRenderer, row, attachment);
    } catch {
      return false;
    }
  };
  // A plugin may draw an image itself, such as a shared agent's card; it
  // stands alone rather than joining the gallery around it.
  const attachmentRenderers = useSyncExternalStore(
    extensions?.attachments?.subscribe ?? noSubscribe,
    extensions?.attachments?.snapshot ?? noActions,
    extensions?.attachments?.snapshot ?? noActions,
  );
  const drawn = (attachment: ChannelMessage["attachments"][number]) =>
    attachment.kind === "image" &&
    attachmentRenderers.some((renderer) => {
      try {
        return renderer.matches(attachment);
      } catch {
        return false;
      }
    });
  // Gallery-backed images and videos share a group, preserving sender order.
  const attachmentGroups: ChannelMessage["attachments"][number][][] = [];
  for (const attachment of row.attachments) {
    if (!safeMessageUrl(attachment.url) || claimed(attachment)) continue;
    const previous = attachmentGroups.at(-1);
    if (
      previous?.[0] &&
      !drawn(attachment) &&
      !drawn(previous[0]) &&
      (((attachment.kind === "image" || attachment.kind === "file") &&
        previous[0].kind === attachment.kind) ||
        (onOpenMediaReview &&
          (attachment.kind === "image" || attachment.kind === "video") &&
          (previous[0].kind === "image" || previous[0].kind === "video")))
    )
      previous.push(attachment);
    else attachmentGroups.push([attachment]);
  }
  const body = row.diff ? (
    <div>
      <p className="text-label-sm">{row.diff.filePath || "Diff"}</p>
      {row.diff.description && (
        <p className="text-body-sm">{row.diff.description}</p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: The raw scroll region preserves preformatted text and needs keyboard access. */}
      <pre
        className={styles.rawDiff}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The raw scroll owner must support keyboard scrolling.
        tabIndex={0}
        role="region"
        aria-label="Raw diff"
      >
        {row.content || "No diff content"}
      </pre>
      {row.diff.truncated && (
        <p className="text-body-sm">
          Diff truncated. View the full diff at the source repository.
        </p>
      )}
    </div>
  ) : (
    <MessageMarkdown
      directory={directory}
      session={references}
      scope={scope}
      row={displayRow}
      extensions={extensions}
      media={media}
      onOpenLink={openLink}
      canOpenLink={canOpenLink}
      participantProfiles={participantProfiles}
      largeEmoji={emojiOnly}
      edited={editedInBody && displayRow.edited}
    />
  );
  const avatarSize = compactAvatar
    ? "tiny"
    : layout === "timeline"
      ? "default"
      : "small";
  const authorName = (
    <>
      {/* Inside the name, so the byline keeps the text baseline. */}
      {agentAuthor && !stackPrevious && (
        <RobotIcon aria-hidden="true" className={styles.authorAgentIcon} />
      )}
      {name}
    </>
  );
  const avatar = row.workflowOwnerId ? (
    <span className={styles.nestedAvatar}>
      <Avatar
        alt="Workflow"
        fallback="Workflow"
        fallbackContent={<LightningIcon size={16} />}
        shape="squircle"
        size={avatarSize}
      />
    </span>
  ) : clickable ? (
    <ProfilePeek
      key={`${scope}:${viewer}:${row.authorId}`}
      viewer={viewer}
      name={name}
      picture={picture}
      pubkey={row.authorId}
      agent={avatarShape === "squircle"}
      session={session}
      channelId={row.channelId}
      target={target}
      onOpen={openLink}
      onFocusChange={setAvatarFocused}
      trigger={
        <IconButton
          size="sm"
          shape="round"
          aria-label={`View ${name} profile`}
          aria-describedby={presence !== "unknown" ? presenceId : undefined}
          icon={
            <>
              <Avatar
                src={picture}
                alt=""
                fallback={name}
                size={avatarSize}
                shape={avatarShape}
                statusBadge={presence === "unknown" ? undefined : presence}
              />
              {presence !== "unknown" && (
                <span className="sr-only select-none" id={presenceId}>
                  Presence: {presence}
                </span>
              )}
            </>
          }
        />
      }
    />
  ) : (
    <span className={styles.nestedAvatar}>
      <Avatar
        src={picture}
        alt={
          presence === "unknown"
            ? ""
            : avatarShape === "squircle"
              ? "Agent"
              : `${name} avatar`
        }
        fallback={name}
        size={avatarSize}
        shape={avatarShape}
        statusBadge={presence === "unknown" ? undefined : presence}
      />
    </span>
  );
  const messageActions = (target?: ReactElement) => (
    <MessageActionBar
      rowRef={rowRef}
      menuTriggerRef={menuTrigger}
      messageId={row.id}
      onForward={forward ? () => forward(row) : undefined}
      onReply={
        (onReply ? () => onReply(row.id) : undefined) ??
        (onOpenThread && startsThreads
          ? () =>
              onOpenThread(
                row.threadRootId ?? row.id,
                row.threadRootId ?? row.id,
                "reply",
              )
          : undefined)
      }
      replyDisabled={
        !!(row.delivery && !["accepted", "seen"].includes(row.delivery)) ||
        archived ||
        (!!session?.channels.get && (!listed || readOnly))
      }
      onSendToChannel={
        session &&
        listed &&
        !archived &&
        !readOnly &&
        row.threadRootId &&
        row.authorId === session.viewer &&
        !row.agentEnvelope &&
        !row.diff &&
        (!row.delivery || ["accepted", "seen"].includes(row.delivery)) &&
        session.outbox?.supports(9)
          ? () => {
              session.messages.sendToChannel(row, getThreadRoot?.());
            }
          : undefined
      }
      link={messageCopyLink(row, scope)}
      copyText={() =>
        messageCopyText(row, directory.profiles, directory.agents)
      }
      quickControls={
        <>
          {stackPrevious && showTime && (
            <span
              className={styles.keyboardMessageTime}
              data-message-keyboard-time
              aria-hidden="true"
            >
              {formatItemTimestamp(row.createdAt, {
                withTime: true,
              })}
            </span>
          )}
          {quickControls ??
            (canReact && session && scope && extensions ? (
              <MessageReactionControls
                row={row}
                session={session}
                scope={scope}
                tools={extensions.tools}
                inline={extensions.inline}
                disabled={
                  !!row.delivery && !["accepted", "seen"].includes(row.delivery)
                }
              />
            ) : undefined)}
        </>
      }
      leadingItems={
        session ? (
          <MessageReadStateItem row={row} session={session} />
        ) : undefined
      }
      overflowItems={
        <>
          {overflowItems ??
            (session ? (
              <MessageManagementItems row={row} session={session} />
            ) : undefined)}
          {actionItems}
          {activityItem}
          {reportItem}
        </>
      }
    >
      {target}
    </MessageActionBar>
  );
  const overlays = (
    <>
      {opened && session && extensions?.actions && (
        <ContributionBoundary key={contributionKey(opened)} fallback={null}>
          <WithTargetOpener
            component={opened.component}
            props={{
              message: row,
              session,
              close: () => setOpenAction(undefined),
            }}
            registry={extensions.actions}
            entry={opened}
          />
        </ContributionBoundary>
      )}
      {report && reporting === "open" && (
        <ReportMessageDialog
          report={(type, note) => report(row.id, type, note)}
          close={(submitted) => setReporting(submitted ? "sent" : undefined)}
          finalFocus={menuTrigger}
        />
      )}
      {active && reporting === "sent" && (
        <ToastNotice
          tone="success"
          timeout={5000}
          title="Report submitted to community moderators"
          onDismiss={() => setReporting(undefined)}
        />
      )}
    </>
  );
  // Accessories may only point at a thread the row could open or start.
  const summaryThread =
    startsThreads || row.replyCount > 0 ? onOpenThread : undefined;
  const renderMessageSummary = (activity?: MessageSummaryActivity) => {
    const remainingThreadAgents = threadAgents.filter(
      (agent) => !activity?.participants.includes(agent.pubkey),
    );
    const remainingWorkingLabel = remainingThreadAgents.length
      ? `${remainingThreadAgents.map(({ pubkey, name }) => resolveName(pubkey, name)).join(", ")} ${threadWaiting ? "waiting" : "working"}`
      : undefined;
    return (
      ((row.replyCount > 0 ||
        (startsThreads && !row.threadRootId && threadAgents.length > 0) ||
        activity) &&
        onOpenThread && (
          <Button
            ref={activity?.ref}
            variant="ghost"
            size="sm"
            data-thread-summary=""
            data-activity-summary={activity ? "" : undefined}
            data-reply-connector={
              (!activity && row.replyCount > 0) || undefined
            }
            data-first-participant-shape={
              agentPubkeys?.has(row.participants[0] ?? "")
                ? "squircle"
                : "circle"
            }
            type="button"
            aria-label={
              row.replyCount > 0
                ? `View thread: ${row.replyCount} ${row.replyCount === 1 ? "reply" : "replies"}${unreadLabel ? `. ${unreadLabel}` : ""}${workingLabel ? `. ${workingLabel}` : ""}${activity ? `. ${activity.label}` : ""}`
                : `View thread: ${activity ? [remainingWorkingLabel, activity.label].filter(Boolean).join(". ") : threadWorkingLabel}`
            }
            onClick={(event) => {
              event.currentTarget.focus();
              onOpenThread(row.id, row.threadRootId ?? row.id);
            }}
          >
            <ReplySummary
              hideEmptyLabel={!!activity}
              count={activity ? 0 : row.replyCount}
              participants={row.participants}
              profiles={participantProfiles}
              agentPubkeys={agentPubkeys}
              resolveName={resolveName}
              media={media}
              unreadLabel={unreadLabel}
              workingParticipants={[
                ...threadAgents.map((agent) => agent.pubkey),
                ...(activity?.participants ?? []),
              ]}
              activity={
                <>
                  {remainingThreadAgents.length > 0 ? (
                    <span
                      className={`${styles.threadWorking} buzz-arrive`}
                      data-thread-working=""
                      aria-hidden="true"
                    >
                      {remainingThreadAgents.slice(0, 2).map((agent) => {
                        const name = resolveName(agent.pubkey, agent.name);
                        return (
                          <Avatar
                            key={agent.pubkey}
                            src={avatarMedia(agent.avatar, media)}
                            alt=""
                            fallback={name}
                            size="compact"
                            shape="squircle"
                          />
                        );
                      })}
                      {remainingThreadAgents.length > 2 && (
                        <span>+{remainingThreadAgents.length - 2}</span>
                      )}
                      <TypingDots
                        state={threadWaiting ? "waiting" : "working"}
                      />
                    </span>
                  ) : null}
                  {activity?.content}
                </>
              }
            />
          </Button>
        )) ||
      null
    );
  };
  const reactionsInBubble =
    !attachmentOnly &&
    !cardsOnly &&
    !row.huddle &&
    !shownRow &&
    !emojiOnly &&
    !row.diff;
  // A plugin card keeps reactions in its bubble, so its mark goes above them.
  const editedInBubble = !editedInBody && reactionsInBubble;
  const reactionContent =
    session && scope && extensions ? (
      <MessageReactions
        onFocusedRemoval={() =>
          menuTrigger.current?.focus({ preventScroll: true })
        }
        row={row}
        session={session}
        scope={scope}
        tools={extensions.tools}
        inline={extensions.inline}
        profiles={directory.profiles}
        disabled={
          !canReact ||
          (!!row.delivery && !["accepted", "seen"].includes(row.delivery))
        }
      />
    ) : (
      reactions.length > 0 && (
        <div
          className={`${styles.reactions} ${styles.reactionFallback}`}
          data-message-reactions
        >
          {reactions.flatMap((reaction) =>
            [...new Set(reaction.events.map((event) => event.authorId))].map(
              (authorId) => (
                <span
                  key={JSON.stringify([
                    reaction.content,
                    reaction.emoji?.url,
                    authorId,
                  ])}
                >
                  {extensions ? (
                    <InlineText
                      registry={extensions.inline}
                      content={{
                        text: reaction.content,
                        message: row,
                        reaction,
                      }}
                      media={media}
                    />
                  ) : (
                    reaction.content
                  )}
                </span>
              ),
            ),
          )}
        </div>
      )
    );
  const message = (
    <div
      data-message-id={renderMessage ? undefined : row.id}
      data-huddle-row={row.huddle ? "" : undefined}
    >
      {day && <DayDivider createdAt={row.createdAt} />}
      <div
        ref={rowRef}
        className={styles.message}
        data-highlight-surface=""
        data-layout={layout}
        data-stack-previous={stackPrevious || undefined}
        data-stack-next={stackNext || undefined}
        data-viewer-message={
          alignViewer && !row.workflowOwnerId && row.authorId === viewer
            ? ""
            : undefined
        }
        data-own={
          (!attachmentOnly && !cardsOnly && !row.huddle && ownBubble) ||
          undefined
        }
      >
        {!renderMessage && <span className={styles.messageGutter} />}

        <div className={styles.messageBody}>
          {!renderMessage && overlays}
          <div
            className={styles.messageContent}
            data-bubble={
              (!attachmentOnly && !cardsOnly && !row.huddle && !shownRow) ||
              undefined
            }
          >
            {/* A live append must not remove the reader's current focus target. */}
            {!renderMessage && (!stackNext || avatarFocused) && (
              <div className={styles.messageAvatar}>{avatar}</div>
            )}
            <div className={styles.messageHeader}>
              {!row.membership &&
                !row.huddle &&
                !renderMessage &&
                messageActions()}
              {/* Screen-reader text stays out of selections: the clipboard carries
                what the reader saw, so a continuation copies without a byline. */}
              <div
                className={
                  stackPrevious ? "sr-only select-none" : styles.byline
                }
              >
                {row.workflowOwnerId && workflowOwnerName ? (
                  <WorkflowByline
                    ownerId={row.workflowOwnerId}
                    ownerName={workflowOwnerName}
                    canOpenLink={canOpenLink}
                    onOpenLink={openLink}
                  />
                ) : (
                  <span className={styles.authorWithStatus}>
                    <strong className={styles.author}>
                      {clickable && !stackPrevious ? (
                        // The avatar is the group's keyboard stop and preview;
                        // the name only answers a click. Text, not a button, so
                        // a selection can start on it and a copy keeps it as
                        // plain prose (no profile target).
                        // biome-ignore lint/a11y/useSemanticElements: a <button> would block starting a text selection on the name
                        <span
                          role="button"
                          tabIndex={-1}
                          data-message-author=""
                          className={styles.authorLink}
                          onClick={(event) => {
                            // A click arriving with text selected (the end of
                            // a drag, or the second click of a double-click)
                            // is a selection, not a request. A double-click's
                            // first click opens the profile like any click.
                            const selection =
                              event.currentTarget.ownerDocument.getSelection();
                            if (selection && !selection.isCollapsed) return;
                            // WebKit skips focusing on pointer click, so the
                            // profile tab's close would have no origin.
                            event.currentTarget.focus();
                            openLink(target);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ")
                              return;
                            event.preventDefault();
                            openLink(target);
                          }}
                        >
                          {authorName}
                        </span>
                      ) : (
                        authorName
                      )}
                    </strong>
                    {session && !stackPrevious && (
                      <UserStatusDisplay
                        session={session}
                        userId={row.authorId}
                        compact
                        focusable={false}
                      />
                    )}
                  </span>
                )}
                {ownerLabel && (
                  <span className={styles.authorOwner}>
                    <span aria-hidden="true">· </span>
                    {ownerLabel}
                  </span>
                )}
                {!stackPrevious && (
                  <MessageTimestamp
                    createdAt={row.createdAt}
                    visible={showTime}
                  />
                )}
                {session &&
                  actions.map(
                    (action) =>
                      action.marker && (
                        <ContributionBoundary
                          key={contributionKey(action)}
                          fallback={null}
                        >
                          <action.marker message={row} session={session} />
                        </ContributionBoundary>
                      ),
                  )}
              </div>
            </div>
            {row.sentFromThread && (
              <div className={styles.sentFromThread}>
                Sent from{" "}
                <MessageLink
                  url={`buzz://message?${new URLSearchParams({ channel: row.channelId, id: row.sentFromThread.rootId, thread: row.sentFromThread.rootId })}`}
                  registry={extensions?.links}
                  session={session}
                  scope={scope}
                  onOpenLink={openLink}
                  label={
                    row.sentFromThread.excerpt
                      ? `Thread — ${row.sentFromThread.excerpt}`
                      : "Thread"
                  }
                />
              </div>
            )}
            <MessageTimestampHint
              createdAt={
                !renderMessage && stackPrevious ? row.createdAt : undefined
              }
              attachments={attachmentGroups.length > 0}
            >
              {chatCards.length > 0 && (
                <div
                  className={styles.messageAttachments}
                  data-solo-cards
                  data-message-action-anchor
                >
                  {chatCards.map((card) => (
                    <MessageMarkdown
                      key={card.start}
                      directory={directory}
                      session={references}
                      scope={scope}
                      row={{
                        ...shown,
                        content: card.content,
                        attachmentSeams: [],
                      }}
                      extensions={extensions}
                      media={media}
                      onOpenLink={openLink}
                      canOpenLink={canOpenLink}
                      participantProfiles={participantProfiles}
                    />
                  ))}
                </div>
              )}
              {bodyShown && (
                <div
                  className={
                    shownRow || row.huddle ? undefined : styles.messageBubble
                  }
                  data-message-action-anchor
                  data-emoji-only={emojiOnly || undefined}
                  data-diff-only={!!row.diff || undefined}
                  data-own={ownBubble || undefined}
                >
                  {timeReply && (
                    <div className={styles.mediaTimeLink} data-media-timecode>
                      {onMediaTime ? (
                        <Button
                          variant="subtle"
                          size="inline"
                          title="Open video"
                          type="button"
                          onClick={() => onMediaTime(timeReply.anchor.seconds)}
                        >
                          <span className={styles.mediaTimeDigits}>
                            {timeReply.label}
                          </span>
                        </Button>
                      ) : (
                        <span className={styles.mediaTimeLabel}>
                          {timeReply.label}
                        </span>
                      )}
                    </div>
                  )}
                  {extensions?.messages ? (
                    <MessageCard
                      registry={extensions.messages}
                      renderer={messageRenderer}
                      message={row}
                      onFailedChange={(renderer, failed) =>
                        setFailedRenderer((current) =>
                          failed
                            ? renderer
                            : current === renderer
                              ? undefined
                              : current,
                        )
                      }
                    >
                      {body}
                    </MessageCard>
                  ) : (
                    body
                  )}
                  {editedInBubble && shown.edited && <EditedMarker />}
                  {reactionsInBubble && reactionContent}
                </div>
              )}
              {attachmentGroups.length > 0 && (
                <div
                  className={styles.messageAttachments}
                  data-message-attachments
                >
                  {attachmentGroups.map((group) => {
                    const images =
                      group[0]?.kind === "image" || group[0]?.kind === "video";
                    const imageOnly = group.every(
                      (item) => item.kind === "image",
                    );
                    const mediaLabel = imageOnly
                      ? "images"
                      : "photos and videos";
                    const files = group[0]?.kind === "file";
                    // Only collapse when the host can open the complete gallery.
                    const collapsed =
                      images && group.length > 4 && !!onOpenMediaReview;
                    const previews = collapsed ? group.slice(0, 4) : group;
                    const items = previews.map((attachment, index) => {
                      const url = safeMessageUrl(attachment.url);
                      if (!url) return null;
                      const source = media(url);
                      if (attachment.kind === "file")
                        return (
                          <FileAttachment
                            key={url}
                            attachment={{ ...attachment, url }}
                            source={source}
                            onOpenLink={openLink}
                          />
                        );
                      if (attachment.kind === "audio") {
                        if (
                          source &&
                          (isProxySource(source) || isNativeMediaSource(source))
                        )
                          return extensions?.attachments ? (
                            <AttachmentDownloadContext key={url} value={true}>
                              <AttachmentView
                                registry={extensions.attachments}
                                attachment={{ ...attachment, url }}
                                source={source}
                                fallback={
                                  <AudioAttachment
                                    attachment={{ ...attachment, url }}
                                    source={source}
                                  />
                                }
                              />
                            </AttachmentDownloadContext>
                          ) : (
                            <AudioAttachment
                              key={url}
                              attachment={{ ...attachment, url }}
                              source={source}
                            />
                          );
                        return (
                          <FileAttachment
                            key={url}
                            attachment={{ ...attachment, url }}
                            source={source}
                            onOpenLink={openLink}
                          />
                        );
                      }
                      if (attachment.kind === "image") {
                        // biome-ignore lint/plugin: Attachment thumbnails, not avatars.
                        const small = media(url, "small");
                        // Third-party URLs map to themselves: no thumbnail. JPEG
                        // drops alpha, so these formats use the WebP variant.
                        const alpha =
                          /^(.+\/[0-9a-f]{64})\.(?:png|gif|webp|avif)$/.exec(
                            url,
                          );
                        const thumbnail =
                          small === source
                            ? undefined
                            : alpha
                              ? media(`${alpha[1]}.thumb.webp`)
                              : small;
                        const image = (
                          <AttachmentImage
                            onOpenLink={
                              canOpenLink?.(attachment.url)
                                ? openLink
                                : undefined
                            }
                            key={url}
                            session={session}
                            attachment={{ ...attachment, url }}
                            source={source}
                            thumbnail={thumbnail}
                            cached={cached}
                            compact={group.length >= 4}
                            overlayCount={
                              collapsed && index === 3 ? group.length - 3 : 0
                            }
                            keepMounted={keepRowMounted}
                            label={
                              collapsed && index === 3
                                ? `View all ${group.length} ${mediaLabel}, starting at ${imageOnly ? "image" : "item"} 4`
                                : group.length > 1
                                  ? `Open image ${index + 1} of ${group.length}`
                                  : "Open image attachment"
                            }
                            {...(onOpenMediaReview
                              ? {
                                  onOpenReview: (item, seconds) =>
                                    onOpenMediaReview(
                                      row.id,
                                      item,
                                      seconds,
                                      row.replyCount > 0 ||
                                        (!!row.threadRootId &&
                                          row.threadRootId !== row.id),
                                      row.attachments,
                                    ),
                                }
                              : {})}
                          />
                        );
                        return source &&
                          extensions?.attachments &&
                          drawn(attachment) ? (
                          <AttachmentView
                            key={url}
                            registry={extensions.attachments}
                            attachment={{ ...attachment, url }}
                            source={source}
                            fallback={image}
                          />
                        ) : (
                          image
                        );
                      }
                      return (
                        <MediaAttachment
                          key={url}
                          attachment={{ ...attachment, url }}
                          media={media}
                          compact={
                            images && group.length >= 4 && !!onOpenMediaReview
                          }
                          overlayCount={
                            collapsed && index === 3 ? group.length - 3 : 0
                          }
                          label={
                            collapsed && index === 3
                              ? `View all ${group.length} ${mediaLabel}, starting at item 4`
                              : `Open video ${index + 1} of ${group.length}`
                          }
                          mode={mediaMode}
                          {...(attachment.kind === "video" &&
                          mediaSeekTo !== undefined
                            ? {
                                seekTo: mediaSeekTo,
                                ...(mediaSeekRequest !== undefined
                                  ? { seekRequest: mediaSeekRequest }
                                  : {}),
                              }
                            : {})}
                          {...(onMediaPlayback
                            ? { onPlayback: onMediaPlayback }
                            : {})}
                          {...(onOpenMediaReview
                            ? {
                                onOpenReview: (item, seconds) =>
                                  onOpenMediaReview(
                                    row.id,
                                    item,
                                    seconds,
                                    row.replyCount > 0 ||
                                      (!!row.threadRootId &&
                                        row.threadRootId !== row.id),
                                    row.attachments,
                                  ),
                              }
                            : {})}
                        />
                      );
                    });
                    return images &&
                      !(group[0] && drawn(group[0])) &&
                      (imageOnly || group.length >= 4) ? (
                      <div className={styles.imageGroup} key={group[0]?.url}>
                        {/* biome-ignore lint/a11y/useSemanticElements: This labels related media links, not a fieldset of form controls. */}
                        <div
                          className={`${styles.imageList} ${group.length >= 4 ? styles.imageGrid : ""}`}
                          data-image-grid={group.length >= 4 || undefined}
                          role="group"
                          aria-label={`${group.length} ${imageOnly ? (group.length === 1 ? "image" : "images") : "photos and videos"}`}
                        >
                          {items}
                        </div>
                      </div>
                    ) : files ? (
                      <div className={styles.fileGroup} key={group[0]?.url}>
                        {items}
                      </div>
                    ) : (
                      items
                    );
                  })}
                </div>
              )}
              {!editedInBody && !editedInBubble && shown.edited && (
                <EditedMarker />
              )}
            </MessageTimestampHint>
          </div>
          {!reactionsInBubble && reactionContent}
          <DeliveryNotice row={row} retry={retry} />
          {active && session && scope && extensions?.accessories && (
            <ComposerAccessories
              registry={extensions.accessories}
              renderMessageSummary={
                summaryThread ? renderMessageSummary : undefined
              }
              session={session}
              scope={scope}
              channelId={row.channelId}
              threadRootId={row.threadRootId}
              message={row}
              onFocusedRemoval={() =>
                menuTrigger.current?.focus({ preventScroll: true })
              }
              openThread={
                summaryThread
                  ? () => {
                      summaryThread(row.id, row.threadRootId ?? row.id);
                      return true;
                    }
                  : undefined
              }
              canOpen={canOpenLink ?? (() => false)}
              open={openLink}
            />
          )}
          {!(active && session && scope && extensions?.accessories) &&
            renderMessageSummary()}
        </div>
      </div>
      {active && session && scope && extensions?.accessories && (
        <ComposerAccessories
          registry={extensions.accessories}
          placement="response"
          representedAgents={representedAgents}
          repliedAgents={repliedAgents}
          stoppedRequest={stoppedRequest}
          messageLayout={layout}
          session={session}
          scope={scope}
          channelId={row.channelId}
          threadRootId={row.threadRootId}
          message={row}
          onFocusedRemoval={() =>
            menuTrigger.current?.focus({ preventScroll: true })
          }
          openThread={
            summaryThread
              ? () => {
                  summaryThread(row.id, row.threadRootId ?? row.id);
                  return true;
                }
              : undefined
          }
          canOpen={canOpenLink ?? (() => false)}
          open={openLink}
        />
      )}
    </div>
  );
  return renderMessage ? (
    <>
      {messageActions(renderMessage(message, menuTrigger))}
      {overlays}
    </>
  ) : (
    message
  );
}
/** Coordination between agents reads as one quiet line in time order: who
 * wrote it, who it is for, and its first paragraph. Opening the line shows
 * the whole message. The mentions it opens with become the line's recipients,
 * so they are not repeated in its text. */
export const MessageRow = memo(function AudienceMessageRow(
  props: MessageRowProps,
) {
  const { onOpenLink, canOpenLink, row } = props;
  const rootId = row.threadRootId ?? row.id;
  // Plugin content in this row opens targets as the row's own links do.
  return (
    <TargetOpenerProvider
      canOpen={(target) => canOpenLink?.(target) ?? false}
      open={(target) => onOpenLink(target, { rootId })}
    >
      {row.audience === "agents" ? (
        <AgentsMessageRow {...props} />
      ) : (
        <FullMessageRow {...props} />
      )}
    </TargetOpenerProvider>
  );
});

function AgentsMessageRow(props: MessageRowProps) {
  const { row, session, media, participantProfiles, agentPubkeys } = props;
  const references = props.references ?? session;
  const [open, setOpen] = useState(false);
  const activity = props.recordedActivity;
  const bubble =
    activity?.container === "bubble" || activity?.container === "standalone";
  const live = useActivityIndicator(
    session,
    row,
    activity?.ownsLive ?? false,
    undefined,
    activity?.requestId,
  );
  const active = live || (activity?.active ?? false);
  const keepMounted = props.keepMounted;
  useEffect(() => {
    if (open) return keepMounted?.(row.id);
  }, [open, keepMounted, row.id]);
  const resolveName = useChannelIdentityNames(references, row.channelId);
  const directory = useReferenceDirectory(references, participantProfiles);
  const { recipients, body } = useMemo(
    () =>
      addressedMessage(
        row,
        profileMentionParts(row, directory.profiles, directory.agents),
      ),
    [row, directory.profiles, directory.agents],
  );
  const person = (pubkey: string, profile: Profile | undefined) => {
    const name = resolveName(pubkey, profile?.name ?? pubkey.slice(0, 10));
    const agent =
      agentPubkeys?.has(pubkey) ||
      !!profile?.isAgent ||
      directory.agents.some((item) => item.pubkey === pubkey);
    return {
      pubkey,
      name,
      picture: avatarMedia(profile?.picture, media),
      shape: agent ? ("squircle" as const) : ("circle" as const),
    };
  };
  const author = person(row.authorId, props.profile);
  const to = recipients.map((pubkey) =>
    person(pubkey, directory.profiles.get(pubkey)),
  );
  const excerpt = Array.from(
    messagePreviewText(body.content).replace(/\s+/g, " "),
  );
  const preview =
    excerpt.length > 280
      ? `${excerpt.slice(0, 279).join("")}…`
      : excerpt.join("");
  const addressedPreview = Array.from(
    `${to.length ? `${to.map((who) => `@${who.name}`).join(", ")} ` : ""}${preview}`,
  );
  const visiblePreview =
    addressedPreview.length > 280
      ? `${addressedPreview.slice(0, 279).join("")}…`
      : addressedPreview.join("");
  const avatar = (who: typeof author) => (
    <span className={styles.audienceAvatar} title={who.name}>
      <AgentAvatar
        session={session}
        agentPubkey={who.pubkey}
        channelId={row.channelId}
        src={who.picture}
        alt=""
        fallback={who.name}
        size="fill"
        shape={who.shape}
      />
    </span>
  );
  const content = (
    <FullMessageRow
      {...props}
      shownRow={row}
      alignViewer={false}
      day={false}
      layout="continuation"
      stackPrevious
      stackNext
      renderMessage={(message, trigger) => (
        <div
          className={styles.audienceRow}
          data-audience="agents"
          data-coordination={to.length > 0 || undefined}
          data-layout={props.layout ?? "timeline"}
          data-stack-previous={props.stackPrevious || undefined}
          data-stack-next={props.stackNext || undefined}
          data-viewer-message={
            (props.alignViewer ?? true) &&
            !row.workflowOwnerId &&
            row.authorId === (props.viewer ?? session?.viewer)
              ? ""
              : undefined
          }
          data-open={open || undefined}
        >
          {props.day && !bubble && <DayDivider createdAt={row.createdAt} />}
          {/* Keep the address column stable while details open and close. */}
          <Collapsible.Root
            open={open}
            onOpenChange={setOpen}
            className={styles.audienceEntry}
            data-highlight-surface=""
            // One stable anchor survives both animation directions. Not the
            // button: revealing an anchor takes it out of the Tab order.
            data-message-id={row.id}
            // Open, a click anywhere in the box folds it, except on its own
            // controls and links or at the end of a text selection.
            onClick={(event) => {
              const target = event.target as Element;
              if (
                !open ||
                !event.currentTarget.contains(target) ||
                target.closest(
                  "a, button, input, textarea, select, summary, [role='button'], [role='menuitem'], [contenteditable='true']",
                ) ||
                !target.ownerDocument.getSelection()?.isCollapsed
              )
                return;
              setOpen(false);
            }}
          >
            <Collapsible.Trigger
              ref={trigger}
              data-buzz-ui=""
              className={styles.audienceLine}
              aria-label={`${author.name}${to.length ? ` to ${to.map((who) => who.name).join(", ")}` : ""}: ${preview}${row.edited ? " (edited)" : ""}`}
            >
              {!bubble && avatar(author)}
              {open && bubble && "Collapse"}
              {!open && (
                <span className={styles.audiencePreviewText}>
                  <ShimmerText active={active}>{visiblePreview}</ShimmerText>
                </span>
              )}
              {!open && row.edited && <EditedMarker />}
            </Collapsible.Trigger>
            <Collapsible.Panel
              className={`${styles.audiencePanel} ${styles.audienceBody}`}
              inert={!open || undefined}
              aria-hidden={!open || undefined}
            >
              <div className={styles.activityExpansionContent}>
                <div className={styles.audienceContent}>{message}</div>
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        </div>
      )}
    />
  );
  return bubble ? (
    <>
      {props.day && <DayDivider createdAt={row.createdAt} />}
      <AgentResponsePreview
        name={author.name}
        participants={[
          {
            id: author.pubkey,
            name: author.name,
            picture: author.picture,
          },
        ]}
        stackPrevious={activity?.container !== "standalone"}
        picture={author.picture}
        layout={props.layout === "thread" ? "thread" : "timeline"}
      >
        <div className={styles.standaloneActivity}>{content}</div>
      </AgentResponsePreview>
    </>
  ) : (
    content
  );
}

// Subscribe only for mounted thread buttons. Evidence and reading remain session-owned;
// rendering a row must not initiate per-thread reads or acknowledge unseen replies.
function useThreadUnread(
  unread: UnreadCapability | undefined,
  channelId: string,
  rootId: string,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      unread?.subscribe({ kind: "thread", channelId, rootId }, listener) ??
      (() => {}),
    [unread, channelId, rootId],
  );
  const get = useCallback(
    () => unread?.snapshot({ kind: "thread", channelId, rootId }),
    [unread, channelId, rootId],
  );
  return useSyncExternalStore(subscribe, get, get);
}
const noSubscribe = () => () => {};
const none: readonly never[] = [];
const noActions = () => none;
const noLibrary = () => undefined;
// Confirmed lifecycle evidence wins; legacy agents retain public typing fallback.
// A joined-key snapshot keeps unrelated typing from re-rendering the row. Like
// the sidebar, only the viewer's own agents count: the library is read while
// someone types here, so an agent no loaded row names yet is still recognized.
function useThreadAgents(
  session: RelaySession | undefined,
  channelId: string,
  rootId: string,
  messageId: string,
  messageThreadRootId: string | undefined,
) {
  const represented = useReplacedTypers(
    session,
    channelId,
    messageThreadRootId,
  );
  const get = () =>
    session?.typing
      .snapshot()
      .filter(
        (entry) =>
          entry.channelId === channelId && entry.threadRootId === rootId,
      )
      .map((entry) => entry.pubkey)
      .join(",") ?? "";
  const keys = useSyncExternalStore(
    session?.typing.subscribe ?? noSubscribe,
    get,
    get,
  );
  // Subscribe to this thread's working agents, not every activity step.
  const getWork = () => {
    const activity = session?.agentActivity?.snapshot();
    const typers = threadWorkingAgents(
      activity,
      keys ? keys.split(",") : [],
      channelId,
      rootId,
      { messageId, agents: represented },
    );
    const local = localActivity(
      {
        local: (activity?.local ?? []).filter(
          (row) => row.messageId !== messageId || !represented.has(row.agent),
        ),
      },
      channelId,
      rootId,
    );
    const waiting =
      typers.length > 0 && typers.every((agent) => breathing(local.get(agent)));
    return `${waiting ? "waiting" : "working"}:${typers.join(",")}`;
  };
  const work = useSyncExternalStore(
    session?.agentActivity?.subscribe ?? noSubscribe,
    getWork,
    getWork,
  );
  const [state, joined = ""] = work.split(/:(.*)/s);
  const typers = joined ? joined.split(",") : [];
  const hasWork = typers.length > 0;
  const getLibrary = (hasWork && session?.agentChoices.snapshot) || noLibrary;
  const library = useSyncExternalStore(
    (hasWork && session?.agentChoices.subscribe) || noSubscribe,
    getLibrary,
    getLibrary,
  );
  return {
    agents:
      library?.identities.filter(({ pubkey }) => typers.includes(pubkey)) ?? [],
    waiting: state === "waiting",
  };
}
