import { ActivityIndicatorPresentation } from "./typing-presentation";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ChannelSummary } from "../relay/contracts";
import {
  ChannelTimeline,
  type ChannelTimelineProps,
} from "../messages/ChannelTimeline";
import {
  MessageComposer,
  type MessageComposerProps,
} from "../messages/MessageComposer";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../messages/MessageManagement";
import { MediaReviewViewer } from "../messages/MediaReviewViewer";
import { ThreadPanel, type ThreadPanelProps } from "../messages/ThreadPanel";
import { useListedChannel } from "../relay/listed-channel";
import { ownSolo } from "../solo/labels";
import { useSoloHasPeople } from "../solo/people";
import {
  ConversationHost,
  type ConversationHostServices,
  type ConversationInteractions,
} from "./ConversationHost";

/** Everything a reader or composer needs from its channel, supplied once,
 * including the Solo policy, so no view can open a chat under other rules. */
type Conversation = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName" | "extensions"
> &
  ConversationInteractions & {
    soloConversation: boolean;
    ownSoloConversation: boolean;
  };
type Shared = keyof Conversation;
/** Pages supply only their own policy, and may relabel the channel. */
type Own<P> = Omit<P, Shared> &
  Partial<Pick<P, Extract<keyof P, "channelName">>>;

/** A page's open review; the scope supplies its conversation. */
export type MediaReview = Pick<
  ComponentProps<typeof MediaReviewViewer>,
  | "messageId"
  | "attachment"
  | "initialAttachments"
  | "initialTime"
  | "hasComments"
  | "restoreFocus"
  | "close"
>;

/** A review that opens over its page and returns focus to its opener. */
export function useMediaReview() {
  const [media, setMedia] =
    useState<Omit<MediaReview, "restoreFocus" | "close">>();
  const trigger = useRef<HTMLElement | null>(null);
  // Stable, so memoized rows reading it do not re-render with the page.
  const open = useCallback<ConversationInteractions["onOpenMediaReview"]>(
    (
      messageId,
      attachment,
      initialTime,
      hasComments = false,
      initialAttachments,
    ) => {
      trigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setMedia({
        messageId,
        attachment,
        initialTime,
        hasComments,
        initialAttachments,
      });
    },
    [],
  );
  const review: MediaReview | undefined = media && {
    ...media,
    restoreFocus: trigger,
    close: () => setMedia(undefined),
  };
  return { open, review };
}

const Context = createContext<Conversation | undefined>(undefined);
export function useConversation() {
  const value = useContext(Context);
  if (!value)
    throw new Error("Conversation readers need a ConversationChannel");
  return value;
}

type ChannelProps = Pick<Conversation, "session" | "scope" | "extensions"> & {
  /** Absent while a page has no selected channel; readers need one. */
  channel?:
    | {
        id: string;
        name: string;
        channelType?: ChannelSummary["channelType"] | undefined;
        /** Decides whether this is the viewer's own Solo chat; see ownSolo. */
        creator?: ChannelSummary["creator"] | undefined;
      }
    | undefined;
  /** Presentation name, when the page labels the channel differently. */
  channelName?: string | undefined;
  /** Whether the channel visit marks it read; see MessageManagement. */
  active?: boolean | undefined;
  children: ReactNode;
} & (
    | {
        interactions: ConversationInteractions;
        /** The page owns when a review opens and retires. */
        mediaReview?: MediaReview | undefined;
        host?: undefined;
      }
    | {
        /** Pages without their own placement use the shared dialog host. */
        host: ConversationHostServices;
        /** Overlays belong to one thread; recovery spans the channel. */
        threadId?: string | undefined;
        interactions?: undefined;
        mediaReview?: undefined;
      }
  );

/** One channel's editing recovery, visit and interactions for every reader in it. */
export function ConversationChannel(props: ChannelProps) {
  const { session, scope, extensions, channel, active, children } = props;
  const channelName = props.channelName ?? channel?.name ?? "";
  // While the channel is open the profile cache keeps room for its whole roster
  // on top of its base; leaving gives the room back after a short hold. A
  // retained tab in the background and a preview that does not visit the
  // channel hold none.
  const members = useListedChannel(
    session.channels,
    channel?.id,
    (listed) => listed?.members?.length ?? 0,
  );
  const held = active === false ? 0 : members;
  const { profiles } = session;
  // A layout effect runs before every passive effect in the commit, so a child
  // such as the mention menu reads the grown limit when the roster arrives.
  useLayoutEffect(
    () => (held ? profiles.reserve?.(held) : undefined),
    [profiles, held],
  );
  // One stable element, so selecting a channel never remounts the page below.
  const provide = (
    interactions: ConversationInteractions,
    review = props.mediaReview,
  ) => (
    <Provider
      session={session}
      scope={scope}
      extensions={extensions}
      channel={channel}
      channelName={channelName}
      interactions={interactions}
    >
      {children}
      {review && <ConversationMediaReview {...review} />}
    </Provider>
  );
  return (
    <MessageManagement
      session={session}
      channelId={channel?.id}
      active={active}
    >
      {props.host ? (
        <>
          {/* Dialog-hosted pages have no layout of their own for recovery. */}
          <MessageManagementStatus />
          {channel && (
            <ConversationHost
              key={props.threadId}
              host={props.host}
              session={session}
              scope={scope}
              channelId={channel.id}
              channelName={channelName}
              threadId={props.threadId}
            >
              {provide}
            </ConversationHost>
          )}
        </>
      ) : (
        provide(props.interactions)
      )}
    </MessageManagement>
  );
}

/** Rows are memoized; the environment changes only with its parts. */
function Provider({
  children,
  session,
  scope,
  extensions,
  channel,
  channelName,
  interactions: { onOpenLink, canOpenLink, onOpenMediaReview },
}: Pick<ChannelProps, "session" | "scope" | "extensions" | "channel"> & {
  channelName: string;
  interactions: ConversationInteractions;
  children: ReactNode;
}) {
  const id = channel?.id;
  const soloConversation = channel?.channelType === "solo";
  const ownSoloConversation = ownSolo(channel, session.viewer);
  const value = useMemo(
    () =>
      id
        ? {
            session,
            scope,
            extensions,
            channelId: id,
            channelName,
            soloConversation,
            ownSoloConversation,
            onOpenLink,
            canOpenLink,
            onOpenMediaReview,
          }
        : undefined,
    [
      session,
      scope,
      extensions,
      id,
      channelName,
      soloConversation,
      ownSoloConversation,
      onOpenLink,
      canOpenLink,
      onOpenMediaReview,
    ],
  );
  return (
    <Context.Provider value={value}>
      <ActivityIndicatorPresentation>{children}</ActivityIndicatorPresentation>
    </Context.Provider>
  );
}

function ConversationMediaReview(props: MediaReview) {
  const { session, scope, channelId, channelName, extensions, onOpenLink } =
    useConversation();
  return (
    <MediaReviewViewer
      session={session}
      scope={scope}
      channelId={channelId}
      channelName={channelName}
      extensions={extensions}
      onOpenLink={onOpenLink}
      {...props}
    />
  );
}

export function ConversationThread(props: Own<ThreadPanelProps>) {
  return <ThreadPanel {...useConversation()} {...props} />;
}

export function ConversationTimeline(
  props: Own<Omit<ChannelTimelineProps, "queries">>,
) {
  const {
    session,
    soloConversation,
    ownSoloConversation: _,
    ...shared
  } = useConversation();
  // Solo agents answer at top level: show existing threads, start none.
  return (
    <ChannelTimeline
      queries={session}
      viewer={session.viewer}
      startsThreads={!soloConversation}
      {...shared}
      {...props}
    />
  );
}

export function ConversationComposer(props: Own<MessageComposerProps>) {
  const { onOpenMediaReview: _, ...shared } = useConversation();
  // Alone, a Solo chat addresses agents; shared, it is a conversation.
  const withPeople = useSoloHasPeople(
    shared.session,
    shared.channelId,
    shared.soloConversation,
  );
  return (
    <MessageComposer
      {...shared}
      {...(shared.soloConversation
        ? {
            label: withPeople
              ? "Message this conversation"
              : "Message your agents",
          }
        : {})}
      chatPresentation={shared.ownSoloConversation}
      requireMention={shared.soloConversation}
      {...props}
    />
  );
}
