import { useSyncExternalStore, type ReactNode } from "react";
import type { ThreadPanelProps } from "../messages/ThreadPanel";
import { messageViewKey } from "../messages/view-key";
import {
  ConversationChannel,
  ConversationThread,
  useConversation,
} from "./Conversation";
import type {
  ConversationHostServices,
  ConversationInteractions,
} from "./ConversationHost";

/** The host owns conversation behavior; the page owns its task and placement. */
export type EmbeddedThreadProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName" | "messageId"
>;
/** One channel's host behavior for a page's own rows and composer, without a visit. */
export type EmbeddedConversationProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId"
> & {
  channelName?: string | undefined;
  /** The thread a card shows; panels opened from it stay in that thread. */
  threadId?: string | undefined;
  children(interactions: ConversationInteractions): ReactNode;
};
type Hosted = {
  host: ConversationHostServices;
  extensions: NonNullable<ThreadPanelProps["extensions"]>;
};

/** Channel visits and recovery span threads; overlays belong to one thread. */
export function EmbeddedThread({
  messageId,
  ...props
}: EmbeddedThreadProps & Hosted) {
  return (
    <HostedChannel {...props} threadId={messageId}>
      <ConversationThread messageId={messageId} />
    </HostedChannel>
  );
}

/** Rows and composer act as in Channels; nothing marks the channel read or follows it. */
export function EmbeddedConversation({
  children,
  ...props
}: EmbeddedConversationProps & Hosted) {
  return (
    <HostedChannel {...props} active={false}>
      <Interactions>{children}</Interactions>
    </HostedChannel>
  );
}

function Interactions({
  children,
}: Pick<EmbeddedConversationProps, "children">) {
  const { onOpenLink, canOpenLink, onOpenMediaReview } = useConversation();
  return children({ onOpenLink, canOpenLink, onOpenMediaReview });
}

function HostedChannel({
  session,
  scope,
  channelId,
  channelName,
  threadId,
  active,
  host,
  extensions,
  children,
}: Omit<EmbeddedConversationProps, "children"> &
  Hosted & { active?: false; children: ReactNode }) {
  const { channels } = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = channels.find((item) => item.id === channelId);
  return (
    <ConversationChannel
      key={messageViewKey(session, scope, channelId)}
      session={session}
      scope={scope}
      extensions={extensions}
      host={host}
      threadId={threadId}
      active={active}
      channel={{
        id: channelId,
        name: channelName ?? channel?.name ?? "",
        channelType: channel?.channelType,
        creator: channel?.creator,
      }}
    >
      {children}
    </ConversationChannel>
  );
}
