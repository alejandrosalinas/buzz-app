import { memo, type ReactNode, useEffect, useId, useLayoutEffect } from "react";
import {
  ConversationTimeline,
  useConversation,
} from "../../features/conversation/Conversation";
import type { ChannelTimelineProps } from "../../features/messages/ChannelTimeline";
import type { PageNavigation } from "../../features/navigation/service";
import { useChannelWindow } from "../../features/relay/react";
import { useRecoveryOwns } from "../../features/relay/RecoveryNotice";
import { headRecovering } from "../../features/relay/live-recovery";
import { clientMetrics } from "../../features/developer/client-metrics";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Channels.module.css";

export const ChannelBody = memo(function ChannelBody({
  cached,
  intro,
  viewer,
  revealMessageId,
  inlineTarget,
  marksRead,
  holding,
  onOpenThread,
  navigation,
  onContentReady,
}: {
  onContentReady?(channelId: string): void;
  cached: boolean;
  intro?: ReactNode;
  viewer?: string | undefined;
  navigation?: PageNavigation | undefined;
  revealMessageId?: string | undefined;
  /** One exact visit to a loaded message, without a page navigation. */
  inlineTarget?: ChannelTimelineProps["inlineTarget"];
  /** False: viewing rows marks nothing read. */
  marksRead?: boolean | undefined;
  /** Show the loading notice instead of the list, as while a message is sought. */
  holding?: boolean | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string, intent?: "reply") => void)
    | undefined;
}) {
  // The owner's Solo chat is a chat-style timeline that loads history on scroll.
  const {
    session: queries,
    channelId,
    ownSoloConversation: solo,
  } = useConversation();
  // ChannelWorkspace already keys this lifetime by viewer/scope/generation.
  const continuityKey = useId();
  const window = useChannelWindow(queries.channels, channelId);
  useLayoutEffect(() => {
    clientMetrics.channelMounted(channelId);
    return () => clientMetrics.channelUnmounted(channelId);
  }, [channelId]);
  const headRecovers = useRecoveryOwns(queries, (live) =>
    headRecovering(live, channelId),
  );
  const newest = window.rows.at(-1)?.id;
  const settled = window.status === "ready" || window.status === "error";
  useEffect(() => {
    if (newest || settled) onContentReady?.(channelId);
  }, [channelId, newest, settled, onContentReady]);
  useLayoutEffect(() => {
    // Repeat calls for the same open are ignored; only the first rows count.
    // Any row counts as content, since a saved scroll position may keep the
    // newest one unmounted.
    if (newest)
      clientMetrics.channelRendered(
        channelId,
        () =>
          !!document.querySelector(
            `[data-channel-timeline="${CSS.escape(channelId)}"] [data-message-id]`,
          ),
      );
    else if (settled) clientMetrics.channelEmpty(channelId);
  }, [channelId, newest, settled]);
  useEffect(() => {
    // Only the normalized conversation attempt can acknowledge its channel.
    // A warm child effect runs before the parent's default resolution effect.
    if (
      navigation?.target.kind !== "conversation" ||
      navigation.target.messageId
    )
      return;
    if (window.status === "ready") navigation?.complete({ status: "opened" });
    // The timeline shows this failure in place, beside its own Retry.
    else if (!cached && window.status === "error")
      navigation?.complete({
        status: "failed",
        reason: "unavailable",
        presented: true,
      });
  }, [cached, navigation, window.status]);
  // While recovery retries this timeline's head read, its notice is the one
  // report, after the quiet delay; the empty timeline waits.
  if (window.status === "error" && !window.rows.length && !headRecovers)
    return (
      <div
        className={`${styles.empty} ${styles.timelinePlaceholder}`}
        role="alert"
      >
        <p>{window.error}</p>
        <Button
          type="button"
          onClick={() => queries.channels.ensure(channelId)}
        >
          Retry messages
        </Button>
      </div>
    );
  if (holding || (window.status !== "ready" && !window.rows.length))
    return (
      <div
        className={`${styles.empty} ${styles.timelinePlaceholder}`}
        role="status"
        data-buzz-launch-pending={!cached ? "required" : undefined}
      >
        Loading messages…
      </div>
    );
  return (
    <ConversationTimeline
      continuityKey={continuityKey}
      intro={intro}
      viewer={viewer}
      window={window}
      launchPending={
        !cached &&
        !window.error &&
        (window.status === "idle" ||
          window.status === "loading" ||
          (window.status === "ready" && window.freshness === "cached"))
      }
      {...(onOpenThread ? { onOpenThread } : {})}
      revealMessageId={revealMessageId}
      inlineTarget={inlineTarget}
      marksRead={marksRead}
      navigation={navigation}
      chatPresentation={solo}
      historyControl={solo ? "scroll" : "button"}
    />
  );
});
