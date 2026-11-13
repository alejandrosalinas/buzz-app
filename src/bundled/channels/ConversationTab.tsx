import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  ConversationChannel,
  ConversationComposer,
  ConversationThread,
  useMediaReview,
} from "../../features/conversation/Conversation";
import { MessageManagementStatus } from "../../features/messages/MessageManagement";
import { useMessageOpening } from "../../features/messages/use-message-opening";
import { usePendingRequest } from "../../features/messages/use-pending-request";
import type { MessageLinkOrigin } from "../../features/messages/MessageRow";
import type { ThreadPanelProps } from "../../features/messages/ThreadPanel";
import { ChannelBody } from "./ChannelBody";
import { SoloColumn } from "../../features/solo/SoloPresentation";
import type { ConversationTab as Tab } from "./useChannelTabState";
import type { PageNavigation } from "../../features/navigation/service";
import styles from "./ChannelTabs.module.css";

type ConversationTabProps = {
  tab: Tab;
  intro?: ReactNode;
  active: boolean;
  /** Showing the tab visits its conversation, as Channels does. */
  visit?: boolean | undefined;
  focusOnMount?: boolean;
  /** The tab as its visit began, when it mounts later in that visit. */
  restored?: Tab | undefined;
  channel: ChannelSummary;
  session: RelaySession;
  scope: string;
  extensions?: ConversationExtensions | undefined;
  openLink(target: string, origin?: MessageLinkOrigin): boolean;
  canOpenLink(target: string): boolean;
  openThread(messageId: string, rootId: string, intent?: "reply"): void;
  close(): void;
  /** The current route's request, only for the thread it addresses. */
  navigation?: PageNavigation | undefined;
  onRetryNavigation?: (() => void) | undefined;
  onResolvedRoot?: ((rootId: string) => void) | undefined;
  onDifferentThread?: ((requested: string, kept: string) => void) | undefined;
  /** Where a thread shown here lives, when it can open there. */
  parent?: ThreadPanelProps["parent"];
};
/** Each secondary conversation retains its own editing and media-review scope. */
export function ConversationTab({
  tab,
  intro,
  active,
  visit = true,
  focusOnMount = true,
  restored,
  channel,
  session,
  scope,
  extensions,
  openLink,
  canOpenLink,
  openThread,
  close,
  navigation,
  onRetryNavigation,
  onResolvedRoot,
  onDifferentThread,
  parent,
}: ConversationTabProps) {
  // A saved reply intent belongs to the previous visit, not this restoration;
  // a renamed or merged copy of the tab carries the same request.
  const initial = restored ?? (focusOnMount ? undefined : tab);
  const reply = tab.kind === "thread" ? tab.replyRequest : undefined;
  const restoredReply = useRef(
    initial?.kind === "thread" ? initial.replyRequest : undefined,
  );
  if (reply !== restoredReply.current) restoredReply.current = undefined;
  const soloConversation = channel.channelType === "solo";
  // Likewise a saved reveal belongs to the opening that asked for it.
  const restoredReveal = useRef(initial?.revealRequest);
  if (tab.revealRequest !== restoredReveal.current)
    restoredReveal.current = undefined;
  const asked =
    tab.revealRequest !== restoredReveal.current
      ? tab.revealRequest
      : undefined;
  const opening = tab.kind === "conversation" ? tab : undefined;
  // Likewise a saved focus request.
  const focus = tab.focusRequest;
  const restoredFocus = useRef(initial?.focusRequest);
  if (focus !== restoredFocus.current) restoredFocus.current = undefined;
  const focusRequest = usePendingRequest(
    focus === restoredFocus.current ? undefined : focus,
  );
  const target = opening?.messageId && asked ? opening.messageId : undefined;
  const revealRequest = target ? asked : undefined;
  const threadReveal = tab.kind === "thread" ? asked : undefined;
  const inTimeline = useMessageOpening(
    session.channels,
    channel.id,
    target,
    revealRequest,
  );
  const [reveal, setReveal] = useState<{
    key: string;
    signal: AbortSignal;
  }>();
  const revealKey = target && JSON.stringify([target, revealRequest]);
  useEffect(() => {
    if (!revealKey) return;
    const request = new AbortController();
    setReveal({ key: revealKey, signal: request.signal });
    return () => request.abort();
  }, [revealKey]);
  const [sent, setSent] = useState<string>();
  const media = useMediaReview();
  // A retained tab re-renders with its page. Its memoized rows open links and
  // threads through stable openers that consult the latest handlers when chosen.
  const latest = useRef({ openLink, openThread });
  useLayoutEffect(() => {
    latest.current = { openLink, openThread };
  });
  const onOpenLink = useCallback(
    (url: string, origin?: MessageLinkOrigin) =>
      latest.current.openLink(url, origin),
    [],
  );
  const onOpenThread = useCallback<typeof openThread>(
    (messageId, rootId, intent) =>
      latest.current.openThread(messageId, rootId, intent),
    [],
  );
  return (
    <ConversationChannel
      session={session}
      scope={scope}
      extensions={extensions}
      channel={channel}
      active={active && visit}
      interactions={{
        onOpenLink,
        canOpenLink,
        onOpenMediaReview: media.open,
      }}
      mediaReview={media.review}
    >
      <section
        data-attachment-drop-zone=""
        className={styles.conversation}
        aria-label={`Conversation in ${channel.name}`}
      >
        <MessageManagementStatus />
        {tab.kind === "thread" ? (
          <ConversationThread
            intro={intro}
            active={active}
            messageId={tab.messageId}
            navigation={navigation}
            retainThread
            tabbed
            onRetryNavigation={onRetryNavigation}
            onResolvedRoot={onResolvedRoot}
            onDifferentThread={onDifferentThread}
            replyRequest={reply === restoredReply.current ? undefined : reply}
            focusRequest={focusRequest}
            revealSelected={threadReveal !== undefined}
            revealRequest={threadReveal}
            close={close}
            parent={parent}
          />
        ) : target && inTimeline === false ? (
          <ConversationThread
            intro={intro}
            active={active}
            messageId={target}
            retainThread
            tabbed
            revealSelected
            revealRequest={revealRequest}
            close={close}
            parent={parent}
          />
        ) : (
          <SoloColumn enabled={soloConversation}>
            <ChannelBody
              intro={intro}
              viewer={session.viewer}
              cached={!!channel.cached}
              // The composer below mounts TypingIndicator for a live channel.
              onOpenThread={onOpenThread}
              revealMessageId={sent}
              // Mount the list once, at the message, not while it is sought.
              holding={!!target && inTimeline === undefined}
              inlineTarget={
                target &&
                reveal &&
                reveal.key === revealKey &&
                !reveal.signal.aborted
                  ? { messageId: target, signal: reveal.signal }
                  : undefined
              }
              marksRead={opening?.markRead !== false}
            />
            <ConversationComposer
              // Shown follows the tab, not whether showing it visits the chat.
              shown={active}
              onSend={setSent}
              {...(focusRequest ? { focusRequest } : {})}
            />
          </SoloColumn>
        )}
      </section>
    </ConversationChannel>
  );
}
