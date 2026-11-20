// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The thread region supports keyboard scrolling and Escape.
import { AgentConnectionSetup } from "../agents/AgentConnectionSetup";
import { TypingIndicator, useLiveConversationAgents } from "./TypingIndicator";
import { ActivityExpansion } from "./ActivityExpansion";
import { ActivityGroupPreview } from "./ActivityGroupPreview";
import {
  activityPresentation,
  useChannelActivitySnapshot,
  useStableRowActivity,
} from "./activity-presentation";
import { activityRuns, relayedRuns } from "./activity-groups";
import { RelayedRunPreview } from "./RelayedRunPreview";
import { DayDivider } from "./MessageTimestamp";
import { workflowLabel } from "../relay/workflow-attribution";
import { usePanelTabHost } from "../panels/PanelWorkspace";
import { moveMessageSelection } from "./message-selection";
import { MessageSelection } from "./use-message-selection";
import { MessageEditScope } from "./MessageEditScope";
import { useMessageSelectionCopy } from "./selection-copy";
import { ReplySummary } from "./ReplySummary";
import { ReplyBranch } from "./ReplyBranch";
import { replyTree } from "./reply-tree";
import { useChannelIdentityNames } from "../identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { XIcon } from "../../shared/design-system/icons/index";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage } from "../relay/contracts";
import { compareMessages } from "../relay/message-order";
import type { RelaySession } from "../relay/session";
import {
  threadFailure,
  type ThreadRetarget,
  type ThreadView,
} from "../relay/threads";
import { useProfileGeneration, useRowProfiles } from "../relay/react";
import { diffPreview, rowProfileIds } from "../relay/membership";
import { plainText } from "../notifications/content";
import { MessageRow, type MessageLinkOrigin } from "./MessageRow";
import { MessageContextMenus } from "./MessageActionBar";
import {
  continuesMessageGroup,
  publicMessageNeighbor,
} from "./message-grouping";
import { MessageComposer, type MessageComposerProps } from "./MessageComposer";
import { ChannelJoinNotice } from "./ChannelJoinNotice";
import { useListedChannel } from "../relay/listed-channel";
import type { CSSProperties } from "react";
import styles from "./Messages.module.css";
import { Reading, readingPositioned } from "./use-reading";
import { useMessageReveal } from "./use-message-reveal";
import { usePendingRequest } from "./use-pending-request";
import type { PageNavigation } from "../navigation/service";
import { messageViewKey } from "./view-key";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { correctScrollTop } from "./scroll-correction";

export type ThreadPanelProps = {
  intro?: ReactNode;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelName: string;
  channelId: string;
  /** Solo agents answer at top level, so a Solo thread is read-only. */
  soloConversation?: boolean | undefined;
  disabled?: boolean | undefined;
  messageId: string;
  /** Channel workspaces retain the editor across same-thread link navigation. */
  retainThread?: boolean | undefined;
  /** The hosting tab strip owns the title, close and Escape. */
  tabbed?: boolean | undefined;
  /** Called with the reader's verified thread root once it is known. */
  onResolvedRoot?: ((rootId: string) => void) | undefined;
  /** Workspace identity is retained when a link's claimed root was wrong. */
  onDifferentThread?: ((requested: string, kept: string) => void) | undefined;
  /** Retry a failed routed opening with fresh navigation authority. */
  onRetryNavigation?: (() => void) | undefined;
  replyRequest?: number | undefined;
  /** Each new value focuses the reply box, keeping its target. */
  focusRequest?: number | undefined;
  /** A saved draft carries its cancellable target through a delayed root read. */
  autoFocus?: MessageComposerProps["autoFocus"];
  /** Inline Inbox visit retains and reveals its exact selected message. */
  revealSelected?: boolean | undefined;
  /** Reveal an inline target without taking focus from its host. */
  revealFocus?: boolean | undefined;
  /** With revealSelected: each new value reveals the selected message again. */
  revealRequest?: number | undefined;
  latestRequest?: AbortSignal | undefined;
  /** An opening that reads the thread as it opens it names the thread's read
   * time from before that read; each new request decides the divider again. */
  unreadRequest?: { readThrough: number } | undefined;
  headerActions?: ReactNode | undefined;
  /** Saved drafts may compose only against a verified matching root. */
  requireReadyRoot?: boolean | undefined;
  onDraftSaved?: (() => void) | undefined;
  /** The hosting preview may track delivery of this exact outgoing message. */
  onSend?: ((id: string) => void) | undefined;
  active?: boolean | undefined;
  navigation?: PageNavigation | undefined;
  /** Omit to embed the thread: no header or Escape dismissal; the owner supplies both. */
  close?: (() => void) | undefined;
  /** The conversation this thread lives in, named as Inbox rows name it, when
   * the host can show the thread there. */
  parent?: { label: string; open(): void } | undefined;
  onOpenLink(url: string, origin?: MessageLinkOrigin): boolean;
  onOpenMediaReview?(
    messageId: string,
    attachment: ChannelMessage["attachments"][number],
    seconds: number,
    hasComments?: boolean,
    attachments?: ChannelMessage["attachments"],
  ): void;
  canOpenLink?: ((target: string) => boolean) | undefined;
};

// Read errors are diagnostics, not copy; the notice says what happened.
const THREAD_FAILED = "This thread didn’t load.";

/** The ids of the folded group, activity or relayed, that holds a reply. */
function foldedGroupOf(tree: ReturnType<typeof replyTree>, id: string) {
  return [...tree.children.values()]
    .flatMap((rows) => [
      ...activityRuns(rows),
      ...relayedRuns(rows).map((run) => run.relayed),
    ])
    .find((group) => group.some((row) => row.id === id))
    ?.map((row) => row.id);
}

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ThreadPanel(props: ThreadPanelProps) {
  useMessageSelectionCopy();
  const host = !!usePanelTabHost();
  const tabbed = props.tabbed ?? host;
  const { close } = props;
  const viewKey = messageViewKey(
    props.session,
    props.scope,
    props.channelId,
    props.retainThread ? undefined : props.messageId,
  );
  return (
    <aside
      className={
        close ? styles.thread : `${styles.thread} ${styles.embeddedThread}`
      }
      data-attachment-drop-zone=""
      data-reading-surface=""
      aria-label="Thread"
      onKeyDown={(event) => {
        // Portalled viewers bubble here through React but own their Escape.
        if (
          event.key === "Escape" &&
          !event.shiftKey &&
          !event.defaultPrevented &&
          !tabbed &&
          close &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.stopPropagation();
          close();
        }
      }}
    >
      {!tabbed && close && (
        <ThreadHeader
          key={`header:${viewKey}`}
          close={close}
          actions={props.headerActions}
        />
      )}
      {props.parent && (
        <p className={styles.threadParent}>
          In{" "}
          <Button variant="link" size="inline" onClick={props.parent.open}>
            {props.parent.label}
          </Button>
        </p>
      )}
      {props.retainThread ? (
        <RetainedThreadPanel key={viewKey} {...props} />
      ) : (
        <OwnedThreadPanel key={viewKey} {...props} />
      )}
    </aside>
  );
}
function ThreadHeader({
  close,
  actions,
}: {
  close(): void;
  actions?: ReactNode;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  return (
    <PanelHeader
      title="Thread"
      actions={
        <>
          {actions}
          <IconButton
            ref={closeButton}
            size="toolbar"
            aria-label="Close thread"
            onClick={close}
            icon={<XIcon size={18} aria-hidden="true" />}
          />
        </>
      }
    />
  );
}
type SelectionFailure = {
  unavailable: boolean;
  pending: boolean;
  retry(): void;
};
/** Where the reader left a routed visit: a row's offset, or else the end. */
type ThreadPlace = {
  anchor?: { id: string; top: number; ancestors: readonly string[] };
};
const THREAD_PLACE = "thread";
/** Reader lifetime follows the open thread; navigation owns only a reveal request. */
function RetainedThreadPanel(props: ThreadPanelProps) {
  type Opening = {
    view: ThreadView;
    messageId: string;
    navigation: PageNavigation | undefined;
    revealRequest: number | undefined;
    // Settles with its selection, so a retarget's line is decided for it.
    unreadRequest: ThreadPanelProps["unreadRequest"];
    revision: number;
  };
  const current = useRef<Opening | undefined>(undefined);
  const [opening, setOpening] = useState<Opening>();
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<{ unavailable: boolean }>();
  // Retry keeps its control mounted and focused until the new attempt settles.
  const [pending, setPending] = useState(false);
  const retrying = useRef(false);
  const [attempt, retry] = useState(0);
  // A route to the thread already shown waits while retarget confirms it.
  const [routing, setRouting] = useState<PageNavigation>();
  useEffect(
    () => () => {
      current.current?.view.dispose();
      current.current = undefined;
    },
    [],
  );
  const differentThread = useRef(props.onDifferentThread);
  differentThread.current = props.onDifferentThread;
  const {
    session,
    channelId,
    messageId,
    navigation,
    onRetryNavigation,
    revealSelected,
    revealRequest,
    unreadRequest,
  } = props;
  const retryNavigation = useCallback(() => {
    retrying.current = true;
    setPending(true);
    if (navigation && onRetryNavigation) onRetryNavigation();
    else retry((value) => value + 1);
  }, [navigation, onRetryNavigation]);
  // A new request never clears a previously opened editor while evidence loads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries the selected request; outer identity owns session/channel lifetime.
  useEffect(() => {
    if (navigation?.signal.aborted) return;
    const request = new AbortController();
    const signal = navigation
      ? AbortSignal.any([request.signal, navigation.signal])
      : request.signal;
    if (!retrying.current) {
      setError(undefined);
      setFailure(undefined);
    }
    const settle = (next?: { unavailable: boolean }, message?: string) => {
      retrying.current = false;
      setPending(false);
      setFailure(next);
      setError(message);
    };
    async function select() {
      const prior = current.current;
      if (
        prior &&
        !navigation &&
        prior.messageId === messageId &&
        prior.revealRequest === revealRequest &&
        !retrying.current
      ) {
        const next = { ...prior, navigation: undefined, unreadRequest };
        current.current = next;
        setOpening(next);
        return;
      }
      if (prior?.view.snapshot().root) {
        if (navigation) setRouting(navigation);
        let result: ThreadRetarget;
        try {
          result = await prior.view.retarget(messageId, signal);
        } finally {
          setRouting((routing) =>
            routing === navigation ? undefined : routing,
          );
        }
        if (signal.aborted || current.current !== prior) return;
        if (result === "selected") {
          const next = {
            ...prior,
            messageId,
            navigation,
            revealRequest,
            unreadRequest,
          };
          current.current = next;
          setOpening(next);
          settle();
          return;
        }
        if (result === "different" && differentThread.current) {
          settle();
          const kept = { ...prior, navigation: undefined };
          current.current = kept;
          setOpening(kept);
          differentThread.current(messageId, prior.messageId);
          return;
        }
        if (result !== "different") {
          settle({ unavailable: result === "unavailable" });
          navigation?.complete({
            status: "failed",
            reason: result === "unavailable" ? "not-found" : "unavailable",
            presented: true,
          });
          return;
        }
      }
      try {
        const exact =
          revealSelected ||
          (navigation?.target.kind === "conversation" &&
            navigation.target.threadRootId !== messageId);
        const view = session.thread(channelId, messageId, {
          exact,
          reading: true,
        });
        prior?.view.dispose();
        const next = {
          view,
          messageId,
          navigation,
          revealRequest,
          unreadRequest,
          revision: (prior?.revision ?? 0) + 1,
        };
        current.current = next;
        setOpening(next);
        settle();
        void view.refresh();
      } catch (error) {
        // An existing thread stays usable; its notice owns the retry.
        if (prior) settle({ unavailable: false });
        else settle(undefined, String(error));
        navigation?.complete({
          status: "failed",
          reason: "unavailable",
          presented: true,
        });
      }
    }
    void select();
    return () => request.abort();
  }, [
    session,
    channelId,
    messageId,
    navigation,
    revealSelected,
    revealRequest,
    unreadRequest,
    attempt,
  ]);
  return (
    <>
      {error && !opening && (
        <div role="alert" className={styles.empty}>
          <p>{THREAD_FAILED}</p>
          <Button loading={pending} onClick={retryNavigation}>
            Try again
          </Button>
        </div>
      )}
      {opening ? (
        <ThreadMessages
          {...props}
          key={opening.revision}
          view={opening.view}
          messageId={opening.messageId}
          navigation={opening.navigation}
          routePending={!!routing}
          revealRequest={opening.revealRequest}
          unreadRequest={opening.unreadRequest}
          selectionFailure={
            failure && { ...failure, pending, retry: retryNavigation }
          }
        />
      ) : (
        !error && <ThreadLoading />
      )}
    </>
  );
}
function OwnedThreadPanel({
  intro,
  session,
  extensions,
  scope,
  channelName,
  channelId,
  messageId,
  navigation,
  onOpenLink,
  onOpenMediaReview,
  canOpenLink,
  soloConversation,
  disabled,
  replyRequest,
  focusRequest,
  autoFocus,
  active = true,
  revealSelected,
  revealFocus,
  unreadRequest,
  requireReadyRoot,
  onDraftSaved,
  onSend,
}: ThreadPanelProps) {
  const [view, setView] = useState<ThreadView>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // Allocate in the effect, not render/useMemo: StrictMode must not leak owned views.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery after view allocation fails.
  useEffect(() => {
    try {
      if (navigation?.signal.aborted) return;
      const exact =
        requireReadyRoot ||
        revealSelected ||
        (navigation?.target.kind === "conversation" &&
          navigation.target.threadRootId !== messageId);
      const owned = session.thread(channelId, messageId, {
        exact,
        reading: true,
      });
      const cancel = () => {
        owned.dispose();
        setView(undefined);
      };
      setError(undefined);
      setView(owned);
      navigation?.signal.addEventListener("abort", cancel, { once: true });
      void owned.refresh();
      return () => {
        navigation?.signal.removeEventListener("abort", cancel);
        owned.dispose();
      };
    } catch (error) {
      setError(String(error));
      navigation?.complete({
        status: "failed",
        reason: "unavailable",
        presented: true,
      });
    }
  }, [
    session,
    channelId,
    messageId,
    attempt,
    navigation,
    revealSelected,
    requireReadyRoot,
  ]);
  return error ? (
    <div className={styles.empty} role="alert">
      <p>{THREAD_FAILED}</p>
      <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
        Try again
      </Button>
    </div>
  ) : view ? (
    <ThreadMessages
      intro={intro}
      soloConversation={soloConversation}
      disabled={disabled}
      extensions={extensions}
      session={session}
      scope={scope}
      channelId={channelId}
      channelName={channelName}
      view={view}
      navigation={navigation}
      messageId={messageId}
      replyRequest={replyRequest}
      focusRequest={focusRequest}
      autoFocus={autoFocus}
      active={active}
      revealSelected={revealSelected}
      revealFocus={revealFocus}
      unreadRequest={unreadRequest}
      requireReadyRoot={requireReadyRoot}
      onDraftSaved={onDraftSaved}
      onSend={onSend}
      onOpenLink={onOpenLink}
      onOpenMediaReview={onOpenMediaReview}
      canOpenLink={canOpenLink}
    />
  ) : (
    <ThreadLoading />
  );
}
function ThreadMessages({
  intro,
  session,
  extensions,
  scope,
  channelId,
  channelName,
  messageId,
  view,
  navigation,
  onOpenLink,
  onOpenMediaReview,
  canOpenLink,
  soloConversation,
  disabled,
  replyRequest,
  focusRequest,
  autoFocus,
  active,
  revealSelected,
  revealFocus,
  revealRequest,
  latestRequest,
  unreadRequest,
  requireReadyRoot,
  onDraftSaved,
  onSend,
  selectionFailure,
  onResolvedRoot,
  routePending,
}: {
  intro?: ReactNode;
  onResolvedRoot?: ThreadPanelProps["onResolvedRoot"];
  /** A route to this reader is on its way: until it lands, a reader not yet
   * shown stays hidden and unread rather than showing a place the route
   * replaces. */
  routePending?: boolean | undefined;
  /** A same-thread link that couldn't open; the current thread stays usable. */
  selectionFailure?: SelectionFailure | undefined;
  /** Solo agents answer at top level, so a Solo thread is read-only. */
  soloConversation?: boolean | undefined;
  disabled?: boolean | undefined;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  messageId: string;
  view: ThreadView;
  replyRequest?: number | undefined;
  focusRequest?: number | undefined;
  autoFocus?: ThreadPanelProps["autoFocus"];
  active?: boolean | undefined;
  revealSelected?: boolean | undefined;
  /** Reveal an inline target without taking focus from its host. */
  revealFocus?: boolean | undefined;
  revealRequest?: number | undefined;
  latestRequest?: AbortSignal | undefined;
  unreadRequest?: ThreadPanelProps["unreadRequest"];
  requireReadyRoot?: boolean | undefined;
  onDraftSaved?: ThreadPanelProps["onDraftSaved"];
  onSend?: ThreadPanelProps["onSend"];
  navigation?: PageNavigation | undefined;
  onOpenLink(url: string, origin?: MessageLinkOrigin): boolean;
  onOpenMediaReview?: ThreadPanelProps["onOpenMediaReview"];
  canOpenLink?: ((target: string) => boolean) | undefined;
}) {
  const channelAccess = useListedChannel(
    session.channels,
    channelId,
    (listed) => {
      const channel = listed ?? session.channels?.get?.(channelId);
      if (channel?.archived) return "archived";
      if (channel?.viewerRole === "guest") return "guest";
      if (channel?.readOnly && !channel.cached) {
        return channel.channelType === "stream" ||
          channel.channelType === "forum" ||
          (channel.channelType === "solo" && channel.joinRole === "guest")
          ? "joinable"
          : "preview";
      }
      return listed && !listed.readOnly ? "member" : "other";
    },
  );
  const preview =
    channelAccess === "joinable" ||
    channelAccess === "preview" ||
    channelAccess === "archived" ||
    channelAccess === "guest";
  const joinRole = useListedChannel(
    session.channels,
    channelId,
    (listed) => (listed ?? session.channels?.get?.(channelId))?.joinRole,
  );
  const [joinNoticeHeight, setJoinNoticeHeight] = useState(0);
  const [joining, setJoining] = useState(false);
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const threadChannels = useMemo(() => new Set([channelId]), [channelId]);
  const activitySnapshot = useChannelActivitySnapshot(
    session.agentActivity,
    threadChannels,
  );
  const stableActivity = useStableRowActivity();
  const resolvedRoot = snapshot.root?.id;
  const reportRoot = useRef(onResolvedRoot);
  reportRoot.current = onResolvedRoot;
  useEffect(() => {
    if (resolvedRoot) reportRoot.current?.(resolvedRoot);
  }, [resolvedRoot]);
  // Read the current root only when sharing; paging must not invalidate every reply row.
  const getThreadRoot = useCallback(() => {
    const current = view.snapshot();
    return current.status === "ready" ? current.root : undefined;
  }, [view]);
  const tree = useMemo(
    () => replyTree(snapshot.replies, snapshot.root?.id),
    [snapshot.replies, snapshot.root?.id],
  );
  const branchReplies = useMemo(() => {
    const branches = new Map<string, ChannelMessage[]>();
    for (const reply of snapshot.replies) {
      for (const ancestor of tree.ancestors(reply.id)) {
        const replies = branches.get(ancestor) ?? [];
        replies.push(reply);
        branches.set(ancestor, replies);
      }
    }
    return branches;
  }, [tree, snapshot.replies]);
  const subscribeUnread = useCallback(
    (listener: () => void) =>
      session.unread.subscribe(
        { kind: "thread", channelId, rootId: snapshot.root?.id ?? messageId },
        listener,
      ),
    [session.unread, channelId, snapshot.root?.id, messageId],
  );
  const unreadSnapshot = useCallback(
    () =>
      session.unread.snapshot({
        kind: "thread",
        channelId,
        rootId: snapshot.root?.id ?? messageId,
      }),
    [session.unread, channelId, snapshot.root?.id, messageId],
  );
  const threadUnread = useSyncExternalStore(
    subscribeUnread,
    unreadSnapshot,
    unreadSnapshot,
  );
  const [expandedActivity, setExpandedActivity] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const activityVisit = useRef<unknown[]>([]);
  useLayoutEffect(() => {
    if (!messageId || !snapshot.replies.some((row) => row.id === messageId))
      return;
    const group = foldedGroupOf(tree, messageId);
    // A target that joins a group later, as a relay does once its owner
    // verifies, opens that group. One that stays in a group stays as the
    // reader left it, even when paging or the unread line reshapes the group.
    const request = [messageId, navigation?.signal, revealRequest, !!group];
    if (request.every((part, index) => part === activityVisit.current[index]))
      return;
    activityVisit.current = request;
    // Every id, so a group split at the unread line opens where the target is.
    const ids = group ?? [];
    if (ids.length)
      setExpandedActivity((current) => new Set([...current, ...ids]));
  }, [messageId, navigation?.signal, revealRequest, snapshot.replies, tree]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [replyParent, setReplyParent] = useState<string>();
  const resolveName = useChannelIdentityNames(session, channelId);
  const senderName = (row: ChannelMessage) => {
    const id = row.workflowOwnerId ?? row.authorId;
    const name = resolveName(
      id,
      profiles.get(id)?.name ?? formatPublicKey(id) ?? "Unknown author",
    );
    return row.workflowOwnerId ? workflowLabel(name) : name;
  };
  // Never address the viewer: threads they started (every agent exchange) stay neutral.
  const replyPlaceholder = (root: ChannelMessage) =>
    (root.workflowOwnerId ?? root.authorId) === session.viewer
      ? "Reply in thread"
      : `Reply in thread to ${senderName(root)}`;
  const rows = useMemo(
    () =>
      snapshot.root ? [snapshot.root, ...snapshot.replies] : snapshot.replies,
    [snapshot.root, snapshot.replies],
  );
  // Remembered agents follow the viewer's latest message here, not the root.
  // Undefined until the first page lands: the seeded root is not yet the thread.
  const threadSeed = useMemo(
    () =>
      snapshot.status === "ready"
        ? rows.filter((row) => row.authorId === session.viewer).at(-1)
        : undefined,
    [snapshot.status, rows, session.viewer],
  );
  const authors = [...new Set(rows.flatMap(rowProfileIds))].sort().join(":");
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (authors)
      void session.profiles
        .ensure(authors.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, authors, profileGeneration]);
  const profiles = useRowProfiles(session.profiles, rows);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const scroller = useRef<HTMLElement>(null);
  const positioned = useRef(false);
  const positionedLatestRequest = useRef<AbortSignal | undefined>(undefined);
  const shown = useRef(active);
  const readingSettled = useRef(false);
  const [initialPositioned, setInitialPositioned] = useState(false);
  const follow = useRef(true);
  // Where a placed unread line and the panel's own corrections since left the
  // scroller; a scroll landing there is not the reader's.
  const lineTop = useRef<number | undefined>(undefined);
  const resizePosition = useRef<
    | {
        width: number;
        height: number;
        contentHeight: number;
        scrollTop: number;
        anchor?: { element: HTMLElement; top: number };
        line?: number;
      }
    | undefined
  >(undefined);
  const captureResizePosition = useCallback(() => {
    const element = scroller.current;
    if (!element || !positioned.current || !element.clientHeight) return;
    const top = element.getBoundingClientRect().top;
    const row = [
      ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((row) => row.getBoundingClientRect().bottom > top);
    const line = element.querySelector<HTMLElement>(
      "[data-new-messages-boundary]",
    );
    resizePosition.current = {
      width: element.clientWidth,
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      ...(row
        ? {
            anchor: {
              element: row,
              top: row.getBoundingClientRect().top - top,
            },
          }
        : {}),
      ...(line ? { line: line.getBoundingClientRect().top - top } : {}),
    };
  }, []);
  const jumpingToLatest = useRef(false);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const previousReplies = useRef({
    ids: new Set(snapshot.replies.map((reply) => reply.id)),
    latestCreatedAt: Math.max(
      0,
      ...snapshot.replies.map((reply) => reply.createdAt),
    ),
    complete: snapshot.status === "ready" && !snapshot.canLoadMore,
  });
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  useEffect(
    () => () => {
      if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current);
    },
    [],
  );
  // Back/Forward to a visit with a recorded place returns there instead of
  // replaying its opening, unless that place can no longer be shown.
  const [lostPlace, setLostPlace] = useState<AbortSignal>();
  const returning =
    !!navigation?.traversal &&
    lostPlace !== navigation.signal &&
    navigation.position(THREAD_PLACE) !== undefined;
  const restoredVisit = useRef<AbortSignal | undefined>(undefined);
  // The row Back/Forward restored. If it joins a folded group later, as a
  // relay does once its owner verifies, that group opens once to keep it shown;
  // the reader can close it again.
  const restoredRow = useRef<
    { signal: AbortSignal; id: string; grouped: boolean } | undefined
  >(undefined);
  useLayoutEffect(() => {
    const restored = restoredRow.current;
    if (!restored || restored.signal !== navigation?.signal) return;
    const group = foldedGroupOf(tree, restored.id);
    if (!!group === restored.grouped) return;
    restored.grouped = !!group;
    if (group)
      setExpandedActivity((current) => new Set([...current, ...group]));
  }, [tree, navigation?.signal]);
  const olderAnchor = useRef<
    { id: string; top: number; ancestors: readonly string[] } | undefined
  >(undefined);
  const olderDemand = useRef(false);
  // The reading anchor's id while its row is detached, until it remounts.
  const remounted = useRef<{ id: string; top: number } | undefined>(undefined);
  const targetAnchor = useRef<number | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new target request retires the previous reveal anchor, not the reader's state.
  useLayoutEffect(() => {
    targetAnchor.current = undefined;
  }, [messageId, navigation?.signal, revealRequest]);
  const selectedRow = useCallback(
    () =>
      [
        ...(scroller.current?.querySelectorAll<HTMLElement>(
          "[data-message-id]",
        ) ?? []),
      ].find((row) => row.dataset.messageId === messageId),
    [messageId],
  );
  // A late ancestor reparents the exact row. Transfer only focus owned at detach,
  // within this commit/layout expansion; a later user expansion must not restore it.
  const selectedBranchRef = useMemo(() => {
    let restore = false;
    return (branch: HTMLElement | null) => {
      if (!branch) return;
      const row = branch.querySelector<HTMLElement>("[data-message-id]");
      if (
        restore &&
        row &&
        !navigation?.signal.aborted &&
        !branch.closest("[inert]") &&
        document.activeElement === document.body
      ) {
        row.tabIndex = -1;
        row.focus({ preventScroll: true });
      }
      restore = false;
      return () => {
        restore =
          row?.dataset.messageId === messageId &&
          document.activeElement === row;
        // Ancestor expansion happens synchronously in a layout effect. Do not
        // retain focus intent after this update (deletion or unmount).
        queueMicrotask(() => {
          restore = false;
        });
      };
    };
  }, [messageId, navigation?.signal]);
  const selectedOffset = useCallback(() => {
    const row = selectedRow();
    const container = scroller.current;
    return row && container
      ? row.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop
      : undefined;
  }, [selectedRow]);
  const completeTarget = useCallback(() => {
    // Exact lookup can finish before context. Preserve this row's reading
    // position through prepended history without refocusing it after opening.
    targetAnchor.current = selectedOffset();
    setInitialPositioned(true);
    captureResizePosition();
    readingSettled.current = true;
    readingPositioned(scroller.current);
    navigation?.complete({ status: "opened" });
  }, [captureResizePosition, navigation, selectedOffset]);
  const prepareTarget = useCallback(() => {
    follow.current = false;
  }, []);
  // Each request reveals its ancestors once; a branch the reader then
  // collapses stays closed until the next request.
  const revealedAncestors = useRef({
    request: [] as unknown[],
    ids: new Set<string>(),
  });
  // A page may supply the parent of a reply shown without it. The reply stays
  // shown, in its parent's branch: commit that before restoring geometry.
  const shownTree = useRef(tree);
  useLayoutEffect(() => {
    const added = (shownTree.current.children.get(undefined) ?? []).flatMap(
      (row) => tree.parents.get(row.id) ?? [],
    );
    shownTree.current = tree;
    if (added.length)
      setExpanded((current) => {
        if (added.every((id) => current.has(id))) return current;
        return new Set([...current, ...added]);
      });
  }, [tree]);
  // Exact targets may precede their ancestors in bounded history. Reveal every
  // available ancestor as it arrives; missing parents remain visible at the top.
  useLayoutEffect(() => {
    if (navigation?.signal.aborted) return;
    const request = [messageId, navigation?.signal, revealRequest];
    if (
      request.some(
        (part, index) => part !== revealedAncestors.current.request[index],
      )
    )
      revealedAncestors.current = { request, ids: new Set() };
    const ancestors = tree
      .ancestors(messageId)
      .filter((id) => !revealedAncestors.current.ids.has(id));
    for (const id of ancestors) revealedAncestors.current.ids.add(id);
    if (ancestors.length)
      setExpanded((current) => {
        if (ancestors.every((id) => current.has(id))) return current;
        return new Set([...current, ...ancestors]);
      });
  }, [tree, messageId, navigation, revealRequest]);
  const rootTarget =
    navigation?.target.kind === "conversation" &&
    navigation.target.threadRootId === messageId;
  // Ordinary opens are positioned, not revealed; so is a return to a saved place.
  const positionedVisit = rootTarget || returning;
  // Reopening an already-shown thread selects nothing new, so its reader needs
  // a focus handoff to start reading. First positioning leaves the opening's
  // tab/composer focus handoff alone.
  // The signal identifies one request; the navigation object is re-bound per
  // relay snapshot, so a re-render of the same request must not refocus.
  const handledRequest = useRef(navigation?.signal);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request moves focus; the others merely qualify it.
  useLayoutEffect(() => {
    if (handledRequest.current === navigation?.signal) return;
    handledRequest.current = navigation?.signal;
    const element = scroller.current;
    if (
      !navigation ||
      navigation.signal.aborted ||
      navigation.focus === "preserve" ||
      !positionedVisit ||
      !active ||
      !positioned.current ||
      !element
    )
      return;
    // Only focus the opener left behind (its control unmounted) moves in.
    // Focus the person has since placed anywhere, even a moment after a first
    // opening whose request arrived late, is not stolen.
    const focused = document.activeElement;
    if (!focused || focused === document.body)
      element.focus({ preventScroll: true });
  }, [navigation?.signal]);
  // Ordinary opens follow the latest reply after bounded history finishes.
  // Keep that first positioning invisible; exact-message navigation reveals itself.
  const positioning =
    !revealSelected &&
    !initialPositioned &&
    (!navigation || positionedVisit) &&
    snapshot.status !== "error";
  // Each ordinary opening starts at the first top-level reply with unread in
  // its branch, decided once before positioning so reading it does not move
  // the line. Undefined while deciding.
  const opening =
    (rootTarget && !returning ? navigation?.signal : undefined) ??
    unreadRequest;
  const [boundary, setBoundary] = useState<{
    opening?: object | undefined;
    id?: string | null;
    failed?: true;
    shown?: string | null | undefined;
  }>(() => ({ opening }));
  // A route can arrive after its opening already showed a line; keep that line
  // on screen until the new decision replaces it, rather than blinking it out.
  if (opening && opening !== boundary.opening)
    setBoundary({
      opening,
      shown: boundary.id === undefined ? boundary.shown : boundary.id,
    });
  const unreadBoundary = boundary.id;
  const shownBoundary =
    unreadBoundary === undefined ? boundary.shown : unreadBoundary;
  // The line stays with a reply that moved under its late parent.
  const lineRow = tree.parents.get(shownBoundary ?? "") ?? shownBoundary;
  const placed = useRef<typeof boundary>(undefined);
  // Focus as this panel opened, and whether pointer or keyboard input has
  // come since: either way the person owns focus now.
  const opened = useRef<{ focused: Element | null; interacted?: true }>({
    focused: null,
  });
  useLayoutEffect(() => {
    opened.current = { focused: document.activeElement };
    const interact = () => {
      opened.current.interacted = true;
    };
    document.addEventListener("pointerdown", interact, true);
    document.addEventListener("keydown", interact, true);
    return () => {
      document.removeEventListener("pointerdown", interact, true);
      document.removeEventListener("keydown", interact, true);
    };
  }, []);
  useEffect(() => {
    // Attention and read marks change without a new thread snapshot.
    void threadUnread;
    if (boundary.id !== undefined) {
      // A failed read decided nothing: decide again once it recovers, unless
      // the reader has left the latest reply since.
      if (
        boundary.failed &&
        snapshot.status === "ready" &&
        !snapshot.recovering
      )
        setBoundary(
          follow.current
            ? { opening: boundary.opening }
            : { opening: boundary.opening, id: null },
        );
      return;
    }
    if (
      revealSelected ||
      returning ||
      (latestRequest && positionedLatestRequest.current === latestRequest) ||
      (navigation && !rootTarget) ||
      (snapshot.status === "ready" && snapshot.root?.id !== messageId)
    ) {
      setBoundary({ ...boundary, id: null });
      return;
    }
    // A read waiting on recovery may wait long: show what is loaded.
    if (snapshot.status === "error" || snapshot.recovering) {
      setBoundary({ ...boundary, id: null, failed: true });
      return;
    }
    // Decide once positioning could proceed, but not while an older page this
    // decision asked for is in flight.
    if (
      snapshot.readKind === "older" ||
      (!(snapshot.root && snapshot.direction) &&
        (snapshot.status !== "ready" ||
          (snapshot.direction !== "older" && snapshot.canLoadMore)))
    )
      return;
    // An inactive reader reads nothing. Shown, it is a preview and gets no
    // line; in a covered tab, it decides once shown, so the line is measured.
    if (!active) {
      const shown =
        scroller.current &&
        (scroller.current.checkVisibility?.({ visibilityProperty: true }) ??
          true) &&
        !scroller.current.closest("[inert]");
      if (shown) setBoundary({ ...boundary, id: null });
      return;
    }
    // A requested read time outlasts the read that opened the thread: unread
    // is judged as of that time.
    const since = unreadRequest?.readThrough;
    const unread = (row: ChannelMessage): boolean => {
      const attention = session.unread.attention(channelId, row.id, since);
      return (
        attention.unread ||
        attention.forced ||
        (tree.children.get(row.id) ?? []).some(unread)
      );
    };
    const first = (tree.children.get(undefined) ?? []).find(unread);
    // A requested read time follows a read of the whole thread, so a nested
    // unread reply shows no new count: reveal it, as a reply target is.
    const nested = (row: ChannelMessage): ChannelMessage | undefined => {
      for (const child of tree.children.get(row.id) ?? []) {
        const attention = session.unread.attention(channelId, child.id, since);
        if (attention.unread || attention.forced) return child;
        const found = nested(child);
        if (found) return found;
      }
    };
    const revealed = since !== undefined && first && nested(first);
    const known =
      since !== undefined || !!first || (threadUnread?.observedCount ?? 0) > 0;
    // Resumed rows show at once; with unread known, the line waits for this
    // view's own rows.
    if (known && snapshot.resumed) return;
    // With unread known in the thread, only a thread-wide read reaching the
    // oldest loaded reply shows that older replies are read: one read alone,
    // or the viewer's own, does not. A legacy walk reads forward from the
    // oldest reply.
    const oldest = snapshot.replies[0];
    // A reply marked unread is unread whatever the frontier says; one the
    // store knows of outside the loaded rows is older than them.
    const loadedUnread = [snapshot.root, ...snapshot.replies].filter(
      (row) => row && session.unread.attention(channelId, row.id).unread,
    ).length;
    const unreadOlder = (threadUnread?.observedCount ?? 0) > loadedUnread;
    const readThrough =
      since ?? session.unread.threadReadThrough(channelId, messageId);
    if (
      known &&
      snapshot.direction === "older" &&
      (snapshot.canLoadMore || snapshot.limited) &&
      oldest &&
      (unreadOlder || oldest.createdAt > readThrough)
    ) {
      // Page to the frontier in one read, not one page per decision. Read
      // per page: a read synced mid-load can move it.
      if (snapshot.canLoadMore)
        void view.loadMore(
          () => since ?? session.unread.threadReadThrough(channelId, messageId),
        );
      // Past the page limit the first unread reply stays unknown.
      else setBoundary({ ...boundary, id: null });
      return;
    }
    if (revealed) {
      const ancestors = tree.ancestors(revealed.id);
      setExpanded((current) =>
        ancestors.every((id) => current.has(id))
          ? current
          : new Set([...current, ...ancestors]),
      );
    }
    setBoundary({ ...boundary, id: first?.id ?? null });
  }, [
    boundary,
    active,
    unreadRequest,
    revealSelected,
    latestRequest,
    returning,
    navigation,
    rootTarget,
    snapshot,
    messageId,
    tree,
    session.unread,
    channelId,
    view,
    threadUnread,
  ]);
  const [inlineReveal, setInlineReveal] = useState<AbortSignal>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: each reveal request needs its own signal.
  useEffect(() => {
    if (!revealSelected) return;
    const request = new AbortController();
    setInlineReveal(request.signal);
    return () => request.abort();
  }, [revealSelected, revealRequest]);
  const revealSignal =
    inlineReveal ?? (positionedVisit ? undefined : navigation?.signal);
  const revealed = useMessageReveal({
    scroller,
    focus:
      revealFocus !== false &&
      !(
        navigation?.target.kind === "conversation" &&
        navigation.target.panel === "members"
      ),
    mark: !(
      navigation?.target.kind === "conversation" &&
      navigation.target.panel === "members"
    ),
    settled: positioned,
    messageId,
    signal: active ? revealSignal : undefined,
    ready:
      snapshot.targetStatus === "ready" && snapshot.target?.id === messageId,
    complete: completeTarget,
    prepare: prepareTarget,
  });
  // Leaving a visit once it was presented, by navigating on, hiding or
  // unmounting, records where the reader was. A return counts only once
  // restored, so an unrestored return keeps the place it came back for. New
  // replies don't record one; a relay rebind does, mid-visit, but restoring
  // that place leaves the reader where they already are. A reader whose route
  // is withdrawn records again when it leaves, is hidden, is shown again or
  // the next route arrives, before that route can restore the place. No
  // reading is captured while it is hidden, and showing it again restores the
  // reading first, so an offset the browser dropped meanwhile is never saved.
  const leftTree = useRef(tree);
  leftTree.current = tree;
  const withdrawn = useRef<() => void>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: hiding or showing the reader again records its place too.
  useLayoutEffect(() => {
    if (!navigation) return withdrawn.current;
    withdrawn.current = undefined;
    return () => {
      const presented = returning
        ? restoredVisit.current === navigation.signal
        : (rootTarget && positioned.current) ||
          revealed.current === navigation.signal;
      if (!presented) return;
      const record = () => {
        const reading = resizePosition.current;
        if (!reading) return;
        const id = reading.anchor?.element.dataset.messageId;
        navigation.savePosition(
          THREAD_PLACE,
          follow.current || !reading.anchor || !id
            ? {}
            : {
                anchor: {
                  id,
                  top: reading.anchor.top,
                  ancestors: leftTree.current.ancestors(id),
                },
              },
        );
      };
      record();
      withdrawn.current = record;
    };
  }, [navigation, active, returning, rootTarget, revealed]);
  const failure = threadFailure(snapshot, rootTarget);
  useEffect(() => {
    if (!navigation || navigation.signal.aborted || !failure) return;
    // Each failure is shown in the thread, next to its own Try again.
    navigation.complete({ status: "failed", reason: failure, presented: true });
  }, [navigation, failure]);
  const [sent, setSent] = useState<string>();
  const [replyFocus, setReplyFocus] = useState(0);
  useEffect(() => {
    if (!joining || (channelAccess !== "member" && channelAccess !== "guest"))
      return;
    setJoining(false);
    if (active) {
      if (channelAccess === "guest")
        scroller.current?.focus({ preventScroll: true });
      else setReplyFocus((value) => value + 1);
    }
  }, [joining, channelAccess, active]);
  const focusReply = useCallback(() => {
    setReplyParent(undefined);
    setReplyFocus((value) => value + 1);
  }, []);
  const targetReply = useCallback((id: string) => {
    setReplyParent((current) => (current === id ? undefined : id));
    setReplyFocus((value) => value + 1);
  }, []);
  useEffect(() => {
    if (replyRequest) focusReply();
  }, [replyRequest, focusReply]);
  useEffect(() => {
    if (focusRequest) setReplyFocus((value) => value + 1);
  }, [focusRequest]);
  const pendingReplyFocus = usePendingRequest(replyFocus);
  const [mediaSeek, setMediaSeek] = useState<{
    seconds: number;
    request: number;
  }>();
  const rootId = snapshot.root?.id;
  const rootPresentation = useMemo(
    () =>
      activityPresentation(
        snapshot.root?.audience === "agents"
          ? [snapshot.root, ...snapshot.replies]
          : snapshot.replies,
        activitySnapshot,
        agentPubkeys,
        rootId,
      ),
    [snapshot.root, snapshot.replies, activitySnapshot, agentPubkeys, rootId],
  );
  const rootActivity = rootId ? rootPresentation.byRow.get(rootId) : undefined;
  // A stopped note may follow only a reply that is always shown: collapsed
  // branches do not mount their rows.
  // Each displayed level is projected alone, but a signed claim may name a
  // request loaded at another level.
  const loadedRows = useMemo(
    () =>
      snapshot.root ? [snapshot.root, ...snapshot.replies] : snapshot.replies,
    [snapshot.root, snapshot.replies],
  );
  const rootReplies = useMemo(
    () =>
      activityPresentation(
        tree.children.get(undefined) ?? [],
        activitySnapshot,
        agentPubkeys,
        rootId,
        undefined,
        loadedRows,
      ),
    [tree, activitySnapshot, agentPubkeys, rootId, loadedRows],
  );
  const liveAgents = useLiveConversationAgents(session, channelId, rootId);
  const lastMessage = publicMessageNeighbor(rows, rows.length, -1);
  const joinsLive =
    !!lastMessage &&
    !lastMessage.membership &&
    lastMessage.audience !== "agents" &&
    lastMessage.authorId === liveAgents[0];
  const hasMediaComments =
    (snapshot.root?.replyCount ?? 0) > 0 ||
    snapshot.replies.length > 0 ||
    (!!snapshot.target && snapshot.target.id !== rootId);
  const openRootMedia = useCallback(
    (
      _rowId: string,
      attachment: ChannelMessage["attachments"][number],
      seconds: number,
      _hasComments?: boolean,
      attachments?: ChannelMessage["attachments"],
    ) => {
      if (rootId)
        onOpenMediaReview?.(
          _rowId,
          attachment,
          seconds,
          hasMediaComments,
          attachments,
        );
    },
    [rootId, onOpenMediaReview, hasMediaComments],
  );
  // Without a selected viewer, bare timecodes need one unambiguous video.
  const videoUrls = new Set(
    [snapshot.root, snapshot.target, ...snapshot.replies].flatMap(
      (row) =>
        row?.attachments
          .filter((item) => item.kind === "video")
          .map((item) => item.url) ?? [],
    ),
  );
  const videoOwner =
    videoUrls.size === 1
      ? [snapshot.root, snapshot.target, ...snapshot.replies].find((row) =>
          row?.attachments.some((item) => item.kind === "video"),
        )
      : undefined;
  const videoAttachment = videoOwner?.attachments.find(
    (item) => item.kind === "video",
  );
  const canSeekVideo =
    !!videoAttachment && (videoOwner?.id === rootId || !!onOpenMediaReview);
  const handleMediaTime = useCallback(
    (seconds: number) => {
      if (!videoOwner || !videoAttachment) return;
      if (onOpenMediaReview) {
        // Open the connected video at the comment, including root attachments.
        openRootMedia(videoOwner.id, videoAttachment, Math.max(0, seconds - 3));
        return;
      }
      setMediaSeek((current) => ({
        seconds,
        request: (current?.request ?? 0) + 1,
      }));
    },
    [videoOwner, videoAttachment, onOpenMediaReview, openRootMedia],
  );
  // Only legacy traversal is eager. Strict windows open at the newest page.
  useEffect(() => {
    if (
      snapshot.direction !== "older" &&
      snapshot.status === "ready" &&
      snapshot.canLoadMore
    )
      void view.loadMore();
  }, [view, snapshot]);
  useLayoutEffect(() => {
    const previous = previousReplies.current;
    const complete = snapshot.status === "ready" && !snapshot.canLoadMore;
    // Initial traversal has no baseline. Once complete, retain the last
    // observed replies through reconnect loading so recovery can reconcile them.
    if (!complete && !previous.complete) return;
    const arrivals =
      complete && previous.complete
        ? snapshot.replies.filter(
            (reply) =>
              !previous.ids.has(reply.id) &&
              reply.createdAt >= previous.latestCreatedAt,
          ).length
        : 0;
    if (complete)
      previousReplies.current = {
        ids: new Set(snapshot.replies.map((reply) => reply.id)),
        latestCreatedAt: Math.max(
          previous.latestCreatedAt,
          ...snapshot.replies.map((reply) => reply.createdAt),
        ),
        complete: true,
      };
    if (arrivals > 0 && !follow.current)
      setNewMessageCount((count) => count + arrivals);
  }, [snapshot.status, snapshot.canLoadMore, snapshot.replies]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rendered rows/profiles change scroll height; sending is explicit navigation intent.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || navigation?.signal.aborted) return;
    // Restored background tabs and returning visits verify their target without
    // revealing it.
    if (
      navigation &&
      (!active || returning) &&
      snapshot.targetStatus === "ready" &&
      snapshot.target?.id === messageId &&
      revealed.current !== navigation.signal
    ) {
      revealed.current = navigation.signal;
      navigation.complete({ status: "opened" });
    }
    // A mounted ordinary thread acknowledges the visit before slow history can
    // exhaust navigation's deadline. Positioning still waits for bounded loading.
    if (
      rootTarget &&
      snapshot.status !== "error" &&
      snapshot.root?.id === messageId &&
      revealed.current !== navigation.signal
    ) {
      revealed.current = navigation.signal;
      navigation.complete({ status: "opened" });
    }
    const openLatest =
      active &&
      element.clientHeight > 0 &&
      latestRequest &&
      !latestRequest.aborted &&
      positionedLatestRequest.current !== latestRequest;
    if (
      (revealSelected && !inlineReveal) ||
      (revealSignal && revealed.current !== revealSignal) ||
      // Seeded rows are not yet the thread: hold the loader until this view's
      // first page lands. Later pages and repairs keep presented rows showing.
      (!positioned.current &&
        !(snapshot.root && snapshot.direction) &&
        (snapshot.status !== "ready" ||
          (snapshot.direction !== "older" && snapshot.canLoadMore))) ||
      (!positioned.current && unreadBoundary === undefined && !openLatest)
    )
      return;
    // Native scroll anchoring is off here, so this panel owns ordinary reading
    // too. With no explicit anchor, keep the saved first visible row in place
    // through this commit's layout shift. A scroll since that save is newer
    // reader intent and wins. A drop in scrollTop while the scroll range shrank
    // is the browser clamping it during this commit's layout, not the reader;
    // nor is any change while the reader was hidden, where WebKit drops the
    // offset under display: none and would show the reader at its top.
    const reading = resizePosition.current;
    const clamped =
      reading !== undefined &&
      element.scrollTop < reading.scrollTop &&
      element.scrollHeight - element.clientHeight <
        reading.contentHeight - reading.height;
    const reshown = active && !shown.current;
    shown.current = active;
    // Back/Forward returns once to where this visit was left: its row, with
    // the branch holding it reopened, or else its nearest ancestor shown.
    // When neither is loaded the visit opens again as it first did.
    if (openLatest) {
      positionedLatestRequest.current = latestRequest;
      targetAnchor.current = undefined;
      olderAnchor.current = undefined;
      remounted.current = undefined;
      lineTop.current = undefined;
      jumpingToLatest.current = false;
      follow.current = true;
    } else if (
      navigation &&
      returning &&
      restoredVisit.current !== navigation.signal
    ) {
      const { anchor } = navigation.position(THREAD_PLACE) as ThreadPlace;
      const closed = anchor
        ? tree.ancestors(anchor.id).filter((id) => !expanded.has(id))
        : [];
      if (closed.length) {
        setExpanded((current) => new Set([...current, ...closed]));
        return;
      }
      // A place inside a folded group reopens that group before it is
      // measured: every member, so either side of the unread line opens.
      const folded =
        anchor && !element.querySelector(`[data-message-id="${anchor.id}"]`)
          ? foldedGroupOf(tree, anchor.id)
          : undefined;
      if (folded?.some((id) => !expandedActivity.has(id))) {
        setExpandedActivity((current) => new Set([...current, ...folded]));
        return;
      }
      const row =
        anchor &&
        [anchor.id, ...anchor.ancestors]
          .map((id) =>
            element.querySelector<HTMLElement>(`[data-message-id="${id}"]`),
          )
          .find((row) => row);
      if (anchor && !row) {
        revealed.current = undefined;
        setLostPlace(navigation.signal);
        return;
      }
      restoredVisit.current = navigation.signal;
      lineTop.current = undefined;
      const restoredId = row?.dataset.messageId;
      restoredRow.current = restoredId
        ? {
            signal: navigation.signal,
            id: restoredId,
            grouped: !!foldedGroupOf(tree, restoredId),
          }
        : undefined;
      targetAnchor.current = undefined;
      follow.current = !row;
      if (row && anchor)
        element.scrollTop += readingDrift(
          element,
          shownAnchor({ element: row, top: anchor.top }),
        );
    } else if (
      !olderAnchor.current &&
      targetAnchor.current === undefined &&
      !follow.current &&
      !jumpingToLatest.current &&
      reading &&
      (reading.scrollTop === element.scrollTop || clamped || reshown)
    ) {
      // While the reader still starts at a placed line, the line holds its
      // offset: replies around it can fold away, the first unread one too.
      const line =
        lineTop.current !== undefined && reading.line !== undefined
          ? element.querySelector<HTMLElement>("[data-new-messages-boundary]")
          : null;
      // A row remounted in place, as when a group folds and then opens around
      // it, keeps the saved offset on its replacement. The commit between may
      // anchor on another row; the remounted one still wins when it returns.
      const saved = reading.anchor;
      const id = saved?.element.dataset.messageId;
      if (saved && id && !element.contains(saved.element))
        remounted.current = { id, top: saved.top };
      const pending = remounted.current;
      const row =
        pending &&
        element.querySelector<HTMLElement>(`[data-message-id="${pending.id}"]`);
      if (row) remounted.current = undefined;
      const anchor =
        pending && row
          ? { element: row, top: pending.top }
          : saved && element.contains(saved.element)
            ? saved
            : undefined;
      if (line && reading.line !== undefined) {
        correctScrollTop(
          element,
          Math.round(
            line.getBoundingClientRect().top -
              element.getBoundingClientRect().top -
              reading.line,
          ),
        );
        lineTop.current = element.scrollTop;
      } else if (anchor) {
        correctScrollTop(element, readingDrift(element, shownAnchor(anchor)));
        if (lineTop.current !== undefined) lineTop.current = element.scrollTop;
      }
    }
    // An exact target holds its own place through a page: a second anchor
    // would correct for the same page again.
    if (targetAnchor.current !== undefined) olderAnchor.current = undefined;
    if (olderAnchor.current) {
      const anchor = olderAnchor.current;
      const added = tree
        .ancestors(anchor.id)
        .filter((id) => !anchor.ancestors.includes(id));
      if (added.every((id) => expanded.has(id))) {
        const row = [
          ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
        ].find((row) => row.dataset.messageId === anchor.id);
        if (row) {
          correctScrollTop(
            element,
            row.getBoundingClientRect().top - anchor.top,
          );
          if (lineTop.current !== undefined)
            lineTop.current = element.scrollTop;
        }
        if (snapshot.status !== "loading") olderAnchor.current = undefined;
      }
    }
    if (targetAnchor.current !== undefined) {
      const offset = selectedOffset();
      if (offset !== undefined) {
        correctScrollTop(element, offset - targetAnchor.current);
        targetAnchor.current = offset;
        follow.current = false;
      }
      if (snapshot.status !== "loading" && !snapshot.canLoadMore)
        targetAnchor.current = undefined;
    }
    // Initial positioning waits for one strict page or the legacy bounded walk.
    // subsequent live changes follow only while the reader is at the bottom.
    // Each opening's line is placed once, when decided.
    const placing = unreadBoundary !== undefined && placed.current !== boundary;
    if (placing) placed.current = boundary;
    const line =
      !openLatest && placing && unreadBoundary
        ? element.querySelector<HTMLElement>("[data-new-messages-boundary]")
        : null;
    if (line) {
      correctScrollTop(
        element,
        line.getBoundingClientRect().top - element.getBoundingClientRect().top,
      );
      // Only a line that leaves the reader at the latest reply follows it.
      follow.current =
        element.scrollHeight - element.clientHeight - element.scrollTop < 1;
      lineTop.current = element.scrollTop;
      // Like a revealed message, the line is where a first opening's reading
      // starts, so content-focused navigation moves focus in: from where the
      // opening or navigation left it, not from where the person has since
      // moved it. A reopening keeps its own focus handoff.
      const focused = document.activeElement;
      if (
        active &&
        navigation &&
        navigation.focus !== "preserve" &&
        !positioned.current &&
        !opened.current.interacted &&
        (!focused ||
          focused === document.body ||
          focused === opened.current.focused ||
          focused === document.getElementById("main-content"))
      )
        element.focus({ preventScroll: true });
    }
    if (follow.current) element.scrollTop = element.scrollHeight;
    positioned.current = true;
    if (!routePending) {
      setInitialPositioned(true);
      readingPositioned(element);
    }
    if (jumpingToLatest.current) {
      setShowJumpToLatest(false);
    } else {
      const bottom =
        element.scrollHeight - element.clientHeight - element.scrollTop < 80;
      setShowJumpToLatest(!bottom);
      if (bottom) setNewMessageCount(0);
    }
    captureResizePosition();
  }, [
    captureResizePosition,
    active,
    latestRequest,
    revealSelected,
    inlineReveal,
    revealSignal,
    snapshot.status,
    snapshot.targetStatus,
    snapshot.target,
    snapshot.canLoadMore,
    snapshot.direction,
    snapshot.root,
    messageId,
    rows,
    profiles,
    sent,
    navigation,
    routePending,
    rootTarget,
    returning,
    revealed,
    selectedOffset,
    tree,
    expanded,
    expandedActivity,
    boundary,
  ]);
  // The effect above re-pins only when thread data changes. A growing composer
  // shrinks this viewport, late media grows rows and a join error grows the end
  // spacer's preview lane; keep a bottom reader there.
  useLayoutEffect(() => {
    const element = scroller.current;
    const content = element?.querySelector("[data-thread-rows]");
    const end = element?.querySelector("[data-thread-end]");
    if (!element || !content || !end || typeof ResizeObserver === "undefined")
      return;
    const observer = new ResizeObserver(() => {
      if (positioned.current && follow.current && !jumpingToLatest.current)
        element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    observer.observe(content);
    observer.observe(end);
    return () => observer.disconnect();
  }, []);
  // Main's retained presentation can be usable before the initial history walk
  // finishes. That is not yet automatic reading intent. Exact revealed targets
  // remain individually readable; later background refreshes keep earned readiness.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active can complete an exact background visit, and a decided unread line can position one, in the preceding layout effect without changing the snapshot.
  useLayoutEffect(() => {
    if (
      !positioned.current ||
      readingSettled.current ||
      routePending ||
      (navigation && !rootTarget && revealed.current !== navigation.signal)
    )
      return;
    if (
      snapshot.status === "ready" &&
      (snapshot.direction === "older" || !snapshot.canLoadMore)
    ) {
      readingSettled.current = true;
      readingPositioned(scroller.current);
    }
  }, [
    active,
    navigation,
    routePending,
    rootTarget,
    revealed,
    snapshot,
    unreadBoundary,
  ]);
  // An own send can land in the middle of a branch, not at the list bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry DOM lookup after history or branch visibility changes.
  useLayoutEffect(() => {
    if (!sent) return;
    const row = [
      ...(scroller.current?.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      ) ?? []),
    ].find((element) => element.dataset.messageId === sent);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      captureResizePosition();
      setSent(undefined);
    }
  }, [sent, snapshot.replies, expanded, captureResizePosition]);
  // Parent commits already position history, exact targets and own sends. Save
  // their result; only child-only reflow and viewport resizing need correction.
  useLayoutEffect(() => {
    const element = scroller.current;
    const content = element?.querySelector("[data-thread-rows]");
    const end = element?.querySelector("[data-thread-end]");
    if (!active || !initialPositioned || !element || !content || !end) return;
    const observer = new ResizeObserver(() => {
      const previous = resizePosition.current;
      if (!previous || !element.clientHeight || jumpingToLatest.current) return;
      if (
        previous.width === element.clientWidth &&
        previous.height === element.clientHeight &&
        previous.contentHeight === element.scrollHeight
      )
        return;
      if (follow.current) {
        element.scrollTop = element.scrollHeight;
      } else if (previous.anchor && element.contains(previous.anchor.element)) {
        correctScrollTop(
          element,
          readingDrift(element, shownAnchor(previous.anchor)),
        );
        if (lineTop.current !== undefined) lineTop.current = element.scrollTop;
      }
      // Exact-history restoration must start from this corrected geometry,
      // rather than applying the same child-only height delta a second time.
      if (targetAnchor.current !== undefined)
        targetAnchor.current = selectedOffset();
      if (olderAnchor.current) {
        const row = element.querySelector<HTMLElement>(
          `[data-message-id="${olderAnchor.current.id}"]`,
        );
        if (row) olderAnchor.current.top = row.getBoundingClientRect().top;
      }
      captureResizePosition();
    });
    observer.observe(element);
    observer.observe(content);
    observer.observe(end);
    return () => observer.disconnect();
  }, [active, initialPositioned, captureResizePosition, selectedOffset]);
  const jumpToLatest = () => {
    const element = scroller.current;
    if (!element) return;
    targetAnchor.current = undefined;
    positioned.current = true;
    follow.current = true;
    jumpingToLatest.current = true;
    element.focus({ preventScroll: true });
    setShowJumpToLatest(false);
    setNewMessageCount(0);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current);
    jumpTimer.current = setTimeout(() => {
      jumpTimer.current = undefined;
      const current = scroller.current;
      if (!current || !jumpingToLatest.current) return;
      current.scrollTop = current.scrollHeight;
      jumpingToLatest.current = false;
      captureResizePosition();
    }, 1000);
  };
  const keepReadingPosition = () => {
    jumpingToLatest.current = false;
    remounted.current = undefined;
    if (jumpTimer.current !== undefined) {
      clearTimeout(jumpTimer.current);
      jumpTimer.current = undefined;
    }
    olderDemand.current = true;
    targetAnchor.current = undefined;
    setInitialPositioned(true);
    // A new reader gesture supersedes any queued resize restoration.
    captureResizePosition();
    if (positioned.current) return;
    positioned.current = true;
    follow.current = false;
  };
  let previousReply: ChannelMessage | undefined = snapshot.root;
  let previousParent: string | undefined;
  let previousDay = snapshot.root
    ? new Date(snapshot.root.createdAt * 1000).toDateString()
    : undefined;
  function renderReplies(parent: string | undefined, depth = 0): ReactNode {
    const chronologicalSiblings = tree.children.get(parent) ?? [];
    // Outcome captions stay within one displayed level, so a collapsed branch
    // cannot hide the reply that owns a request's outcome.
    const requestRows = new Map(
      chronologicalSiblings.map((row) => [row.id, row]),
    );
    if (parent === undefined && snapshot.root)
      requestRows.set(snapshot.root.id, snapshot.root);
    const presentation = activityPresentation(
      chronologicalSiblings,
      activitySnapshot,
      agentPubkeys,
      parent ?? rootId,
      // A failure with replies needs its own visible branch controls.
      (failure) => !tree.children.get(failure.id)?.length,
      loadedRows,
    );
    const groups = [
      ...presentation.groups,
      ...relayedRuns(chronologicalSiblings, lineRow ?? undefined),
    ].filter((group) =>
      group.ids.every((id) => !tree.children.get(id)?.length),
    );
    const siblings = chronologicalSiblings;
    const groupsByFirst = new Map(groups.map((group) => [group.ids[0], group]));
    const groupedIds = new Set(groups.flatMap((group) => group.ids));
    // A group stays open while any of its rows was opened, so one that gains
    // an earlier row from paging keeps the reader's choice.
    const open = (ids: readonly string[]) =>
      ids.some((id) => expandedActivity.has(id));
    const hidden = new Set(
      groups.flatMap((group) => (open(group.ids) ? [] : group.ids)),
    );
    return siblings.map((row, index) => {
      const group = groupsByFirst.get(row.id);
      if (hidden.has(row.id) && !group) return null;
      const nextRow =
        row.audience === "agents"
          ? siblings[index + 1]
          : publicMessageNeighbor(siblings, index, 1);
      const children = tree.children.get(row.id);
      const continuation =
        !!previousReply &&
        previousReply !== snapshot.root &&
        previousParent === parent &&
        continuesMessageGroup(
          row.audience === "agents"
            ? previousReply
            : publicMessageNeighbor(siblings, index, -1),
          row,
        );
      // A collapsed branch breaks bubble grouping, not calendar continuity.
      const currentDay = new Date(row.createdAt * 1000).toDateString();
      const day = previousDay !== currentDay;
      previousDay = currentDay;
      previousReply =
        children?.length && !expanded.has(row.id) ? undefined : row;
      previousParent = parent;
      const descendants = branchReplies.get(row.id) ?? [];
      const unreadCount = descendants.filter(
        (reply) =>
          session.unread.attention(
            channelId,
            reply.id,
            unreadRequest?.readThrough,
          ).unread,
      ).length;
      const unreadLabel = unreadCount
        ? `${unreadCount} new in available replies`
        : undefined;
      const renderMessage = (row: ChannelMessage, inside = false) => {
        const recordedActivity = presentation.byRow.get(row.id);
        const requestId = presentation.replyRequests.get(row.id);
        return (
          <MessageRow
            representedAgents={stableActivity.agents(
              row.id,
              presentation.representedAgents.get(row.id),
            )}
            repliedAgents={stableActivity.agents(
              `replied:${row.id}`,
              presentation.repliedAgents.get(row.id),
            )}
            stoppedRequest={requestId ? requestRows.get(requestId) : undefined}
            recordedActivity={stableActivity.activity(
              row.id,
              recordedActivity,
              groupedIds.has(row.id) ? "history" : recordedActivity?.container,
            )}
            viewer={session.viewer}
            extensions={extensions}
            session={session}
            scope={scope}
            onReply={
              snapshot.root && !soloConversation ? targetReply : undefined
            }
            row={row}
            getThreadRoot={getThreadRoot}
            stackPrevious={inside || continuation}
            stackNext={
              inside ||
              presentation.bubbleAnchors.has(row.id) ||
              (joinsLive && row.id === lastMessage?.id) ||
              (!!nextRow &&
                continuesMessageGroup(row, nextRow) &&
                !children?.length)
            }
            profile={profiles.get(row.authorId)}
            participantProfiles={profiles}
            agentPubkeys={agentPubkeys}
            media={session.media}
            onOpenLink={onOpenLink}
            canOpenLink={canOpenLink}
            day={!inside && day}
            layout={continuation ? "continuation" : "thread"}
            compactAvatar={depth > 0}
            retry={session.messages.retry}
            {...(canSeekVideo ? { onMediaTime: handleMediaTime } : {})}
            {...(onOpenMediaReview && rootId
              ? { onOpenMediaReview: openRootMedia }
              : {})}
          />
        );
      };
      const renderHistory = (entry: ChannelMessage) => (
        <div ref={entry.id === messageId ? selectedBranchRef : undefined}>
          {renderMessage(entry, true)}
        </div>
      );
      const toggleGroup = () => {
        follow.current = false;
        targetAnchor.current = undefined;
        setExpandedActivity((current) => {
          const next = new Set(current);
          const ids = group?.ids ?? [row.id];
          const opened = ids.some((id) => next.has(id));
          for (const id of ids) {
            if (opened) next.delete(id);
            else next.add(id);
          }
          return next;
        });
      };
      const message = (
        <ActivityExpansion
          open={!hidden.has(row.id) && !groupedIds.has(row.id)}
          enabled={row.audience === "agents" || !!row.relayedFrom?.verified}
        >
          {renderMessage(row)}
        </ActivityExpansion>
      );
      return (
        <li
          key={row.id}
          ref={
            row.id === messageId && !groupedIds.has(row.id)
              ? selectedBranchRef
              : undefined
          }
          className={styles.replyItem}
          data-layout={continuation ? "continuation" : "thread"}
        >
          {!parent && row.id === lineRow && (
            <div className={styles.newMessages} data-new-messages-boundary>
              <hr className="sr-only select-none" aria-label="New messages" />
              <span className="select-none" aria-hidden="true">
                New messages
              </span>
            </div>
          )}
          {/* Not while the root, or history that may hold the parent, loads. */}
          {!parent &&
            rootId &&
            !snapshot.seeking &&
            row.replyParentId &&
            row.replyParentId !== rootId &&
            !requestRows.has(row.replyParentId) && (
              <p className={styles.threadNote}>
                Earlier reply unavailable in loaded history.
              </p>
            )}

          {group && (
            <>
              {/* A relayed run lists its lines without their own dividers. */}
              {day && ("relayed" in group || hidden.has(row.id)) && (
                <DayDivider createdAt={row.createdAt} />
              )}
              {"relayed" in group ? (
                <RelayedRunPreview
                  session={session}
                  run={group}
                  renderHistory={renderHistory}
                  profiles={profiles}
                  agentPubkeys={agentPubkeys}
                  media={session.media}
                  expanded={open(group.ids)}
                  onToggle={toggleGroup}
                  extensions={extensions}
                  scope={scope}
                  onOpenLink={onOpenLink}
                  layout="thread"
                />
              ) : (
                <ActivityGroupPreview
                  session={session}
                  group={group}
                  openActivity={onOpenLink}
                  canOpenActivity={canOpenLink}
                  renderHistory={renderHistory}
                  profiles={profiles}
                  media={session.media}
                  layout="thread"
                  expanded={open(group.ids)}
                  onToggle={toggleGroup}
                />
              )}
            </>
          )}
          <ReplyBranch
            message={message}
            hasReplies={!!children?.length}
            layout={continuation ? "continuation" : "thread"}
            label={`View ${descendants.length} ${descendants.length === 1 ? "reply" : "replies"}${unreadLabel ? `. ${unreadLabel}` : ""}`}
            summary={
              <ReplySummary
                count={descendants.length}
                participants={[
                  ...new Set(
                    descendants.map((reply) => reply.authorId).reverse(),
                  ),
                ]}
                profiles={profiles}
                agentPubkeys={agentPubkeys}
                resolveName={resolveName}
                media={session.media}
                unreadLabel={unreadLabel}
                unreadCount={unreadCount}
              />
            }
            depth={depth}
            open={expanded.has(row.id)}
            onExpand={() => {
              follow.current = false;
              targetAnchor.current = undefined;
              setExpanded((current) => new Set([...current, row.id]));
            }}
            collapseLabel={`Collapse ${descendants.length} ${descendants.length === 1 ? "reply" : "replies"}`}
            onCollapse={() => {
              follow.current = false;
              targetAnchor.current = undefined;
              setExpanded(
                (current) =>
                  new Set([...current].filter((id) => id !== row.id)),
              );
            }}
          >
            {expanded.has(row.id) && (
              <ol>{renderReplies(row.id, depth + 1)}</ol>
            )}
          </ReplyBranch>
        </li>
      );
    });
  }
  const selectedParent = snapshot.replies.find((row) => row.id === replyParent);
  // The banner's one line about its target. `plainText` flattens CommonMark,
  // replaces control characters and cuts the result at 200 characters; GFM
  // that the row renders (strikethrough, tables, task-list boxes) still
  // reaches the banner as source. A diff's content is a raw patch, never
  // Markdown, so it gets the sidebar's summary instead. `diffPreview` prints
  // the diff's file and description tags as sent: no length bound and no
  // control-character cleanup.
  const selectedParentText = useMemo(
    () =>
      selectedParent?.diff
        ? diffPreview(selectedParent.diff)
        : plainText(selectedParent?.content ?? ""),
    [selectedParent?.diff, selectedParent?.content],
  );
  const captureOlderAnchor = (element: HTMLElement, following = false) => {
    follow.current &&= following;
    const row = [
      ...element.querySelectorAll<HTMLElement>("ol [data-message-id]"),
    ].find(
      (row) =>
        row.getBoundingClientRect().bottom >
        element.getBoundingClientRect().top,
    );
    olderAnchor.current = row?.dataset.messageId
      ? {
          id: row.dataset.messageId,
          top: row.getBoundingClientRect().top,
          ancestors: tree.ancestors(row.dataset.messageId),
        }
      : undefined;
  };
  // A page read for a missing parent lands with no gesture: hold the reader's
  // place through it as through a page scrolled for, still following. Every
  // commit may have used the anchor or moved its row.
  useLayoutEffect(() => {
    if (
      snapshot.seeking &&
      !olderAnchor.current &&
      positioned.current &&
      scroller.current
    )
      captureOlderAnchor(scroller.current, true);
  });
  const loadOlder = () => {
    const element = scroller.current;
    if (
      !element ||
      !olderDemand.current ||
      snapshot.direction !== "older" ||
      snapshot.status !== "ready" ||
      !snapshot.canLoadMore ||
      element.scrollTop >
        Math.max(80, (element.scrollHeight - element.clientHeight) * 0.2)
    )
      return;
    olderDemand.current = false;
    captureOlderAnchor(element);
    void view.loadMore();
  };
  const selectionNotice =
    selectionFailure && !snapshot.error ? selectionFailure : undefined;
  const showOlderPageStatus =
    snapshot.direction === "older" &&
    snapshot.readKind === "older" &&
    !!snapshot.root;
  const targetUnavailable =
    snapshot.targetStatus === "unavailable" && !selectionNotice;
  const historyError = !!snapshot.error && !showOlderPageStatus;
  const focusArchivedHistory = useCallback(() => {
    const history = scroller.current;
    if (
      session.channels?.get?.(channelId)?.archived &&
      history?.isConnected &&
      !history.closest("[inert]")
    )
      history.focus({ preventScroll: true });
  }, [session.channels, channelId]);
  // The reply composer, and the activity lane its TypingIndicator needs.
  const composerRoot =
    !preview &&
    !soloConversation &&
    (!requireReadyRoot ||
      (snapshot.root?.id === messageId && snapshot.targetStatus === "ready"))
      ? snapshot.root
      : undefined;
  const retryThread = () => {
    if (showOlderPageStatus) {
      if (scroller.current) captureOlderAnchor(scroller.current);
      void view.loadMore();
    } else void view.refresh();
  };
  return (
    <MessageEditScope>
      <Reading
        session={session}
        channelId={channelId}
        scroller={scroller}
        settled={readingSettled}
        // The thread opened bounds DM reads even before its root resolves. An
        // exact reply under an unavailable original shows alone, so it, not
        // its signed root, is the thread: its hidden siblings stay unread.
        rootId={snapshot.root?.id ?? messageId}
        // A visible exact reply can outlive its unavailable root. Until resolved,
        // observe rows individually; an absent root must not mean channel catch-up.
        // The same order the rows are shown in, so a same-second tie names
        // the row a folded group shows as its latest.
        latestMessageId={
          snapshot.root
            ? snapshot.replies.reduce<ChannelMessage | undefined>(
                (latest, row) =>
                  !latest || compareMessages(row, latest) > 0 ? row : latest,
                undefined,
              )?.id
            : undefined
        }
      />
      <section
        ref={scroller}
        data-message-scroller
        className={styles.threadHistory}
        style={
          {
            "--channel-preview-inset": preview
              ? `calc(${joinNoticeHeight}px + var(--space-3))`
              : "0px",
          } as CSSProperties
        }
        aria-label="Thread messages"
        aria-busy={positioning}
        data-positioning={positioning || undefined}
        data-jump-visible={showJumpToLatest || undefined}
        onScroll={(event) => {
          if (!positioned.current) return;
          const element = event.currentTarget;
          if (olderAnchor.current) {
            const anchor = olderAnchor.current;
            const row = [
              ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
            ].find((row) => row.dataset.messageId === anchor.id);
            if (row) anchor.top = row.getBoundingClientRect().top;
          }
          // A browser-generated scroll during reflow must not replace the
          // reading intent before ResizeObserver has corrected the new geometry.
          const previous = resizePosition.current;
          if (
            previous &&
            (previous.width !== element.clientWidth ||
              previous.height !== element.clientHeight ||
              previous.contentHeight !== element.scrollHeight)
          )
            return;
          const bottom =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            80;
          if (jumpingToLatest.current) return;
          captureResizePosition();
          if (element.scrollTop !== lineTop.current) {
            follow.current = bottom;
            lineTop.current = undefined;
          }
          setShowJumpToLatest(!bottom);
          if (bottom) setNewMessageCount(0);
          loadOlder();
        }}
        onWheel={(event) => {
          keepReadingPosition();
          if (event.deltaY < 0) loadOlder();
        }}
        onTouchMove={() => {
          keepReadingPosition();
          loadOlder();
        }}
        onPointerDown={keepReadingPosition}
        onKeyDown={(event) => {
          moveMessageSelection(event);
          if (event.defaultPrevented) return;
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(event.key)
          ) {
            keepReadingPosition();
            if (
              ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
              (event.key === " " && event.shiftKey)
            )
              loadOlder();
          }
        }}
        tabIndex={0}
      >
        <JumpToLatestButton
          visible={showJumpToLatest}
          newMessageCount={newMessageCount}
          onClick={jumpToLatest}
        />
        <MessageContextMenus>
          <div
            data-thread-rows=""
            data-activity-history-scope=""
            inert={positioning}
          >
            {snapshot.root && intro}
            {snapshot.root ? (
              <MessageRow
                viewer={session.viewer}
                extensions={extensions}
                session={session}
                scope={scope}
                onReply={soloConversation ? undefined : focusReply}
                stackNext={joinsLive && snapshot.root.id === lastMessage?.id}
                row={snapshot.root}
                representedAgents={stableActivity.agents(
                  snapshot.root.id,
                  rootPresentation.representedAgents.get(snapshot.root.id),
                )}
                repliedAgents={stableActivity.agents(
                  `replied:${snapshot.root.id}`,
                  rootReplies.repliedAgents.get(snapshot.root.id),
                )}
                recordedActivity={stableActivity.activity(
                  snapshot.root.id,
                  rootActivity,
                  "history",
                )}
                profile={profiles.get(snapshot.root.authorId)}
                participantProfiles={profiles}
                agentPubkeys={agentPubkeys}
                media={session.media}
                onOpenLink={onOpenLink}
                canOpenLink={canOpenLink}
                day={false}
                layout="thread"
                retry={session.messages.retry}
                mediaMode="thread"
                {...(mediaSeek
                  ? {
                      mediaSeekTo: mediaSeek.seconds,
                      mediaSeekRequest: mediaSeek.request,
                    }
                  : {})}
                {...(onOpenMediaReview
                  ? { onOpenMediaReview: openRootMedia }
                  : {})}
              />
            ) : snapshot.status !== "loading" ? (
              targetUnavailable ? (
                // One notice, with its recovery beside it, when nothing loaded.
                <div className={styles.threadNotice}>
                  <p role="status">This message isn’t available.</p>
                  {!historyError && (
                    <Button type="button" onClick={() => void view.refresh()}>
                      Try again
                    </Button>
                  )}
                </div>
              ) : (
                <p className={styles.empty}>Original message unavailable.</p>
              )
            ) : null}
            <ol>
              {showOlderPageStatus && snapshot.error && (
                <li className={styles.threadHistoryPageStatus}>
                  <p role="alert">{snapshot.error}</p>
                  <Button type="button" onClick={retryThread}>
                    Try again
                  </Button>
                </li>
              )}
              {renderReplies(undefined)}
            </ol>
            {!preview && !positioning && composerRoot && (
              <AgentConnectionSetup
                key={`${channelId}:${rootId}`}
                session={session}
                channel={session.channels?.get?.(channelId)}
                rows={rows}
              />
            )}
            {!positioning && rootId && (
              <TypingIndicator
                audience="agents"
                inFlow
                session={session}
                channelId={channelId}
                threadRootId={rootId}
                previousAuthor={joinsLive ? lastMessage?.authorId : undefined}
                openActivity={onOpenLink}
                canOpenActivity={canOpenLink}
              />
            )}
          </div>
        </MessageContextMenus>
        {requireReadyRoot &&
          snapshot.root &&
          snapshot.root.id !== messageId && (
            <p role="status">
              This saved draft does not identify a thread root. Open its origin
              to check the destination.
            </p>
          )}
        {positioning || (snapshot.status === "loading" && !rows.length) ? (
          <ThreadLoading />
        ) : null}
        {selectionNotice && (
          <p role="alert">
            {selectionNotice.unavailable
              ? "That message is no longer available."
              : "Couldn’t open that message."}
          </p>
        )}
        {snapshot.limited && !snapshot.error && (
          <p className={styles.threadNote}>Thread history limit reached.</p>
        )}
        {(historyError || (targetUnavailable && snapshot.root)) && (
          <div className={styles.threadNotice}>
            {targetUnavailable && snapshot.root && (
              <p role="status">Selected message unavailable.</p>
            )}
            {historyError && <p role="alert">{THREAD_FAILED}</p>}
            <Button type="button" onClick={() => void view.refresh()}>
              Try again
            </Button>
          </div>
        )}
        {selectionNotice && !selectionNotice.unavailable && (
          <div className={styles.threadHistoryControls}>
            <Button
              type="button"
              loading={selectionNotice.pending}
              onClick={selectionNotice.retry}
            >
              Try again
            </Button>
          </div>
        )}
        <div
          className={styles.timelineEnd}
          data-thread-end=""
          aria-hidden="true"
        />
      </section>
      {/* After the scroller, so its ref is attached when this registers. */}
      <MessageSelection
        list={scroller}
        rows={rows}
        session={session}
        conversationId={rootId}
      />
      {preview && (
        <ChannelJoinNotice
          ready={
            !positioning &&
            (snapshot.status === "ready" ||
              snapshot.status === "error" ||
              !!rows.length)
          }
          channelId={channelId}
          archived={channelAccess === "archived"}
          place={soloConversation ? "chat" : "channel"}
          guest={channelAccess === "guest"}
          joinRole={joinRole}
          lifecycle={session.channelLifecycle}
          joinable={channelAccess === "joinable"}
          onJoin={() => setJoining(true)}
          onHeightChange={setJoinNoticeHeight}
        />
      )}
      {composerRoot && (
        <MessageComposer
          onFocusedRemoval={focusArchivedHistory}
          key={`${scope}:${channelId}:${composerRoot.id}`}
          extensions={extensions}
          session={session}
          scope={scope}
          channelId={channelId}
          channelName={channelName}
          placeholder={replyPlaceholder(composerRoot)}
          threadRootId={composerRoot.id}
          threadSeed={threadSeed}
          replyParentId={replyParent}
          disabled={
            disabled ||
            (requireReadyRoot &&
              (snapshot.status !== "ready" || !!snapshot.error)) ||
            (!!replyParent && !selectedParent)
          }
          replyContext={
            replyParent && !selectedParent ? (
              <div className={styles.replyContext}>
                <span>Reply target is no longer available.</span>
                <Button size="sm" onClick={focusReply}>
                  Cancel reply target
                </Button>
              </div>
            ) : (
              selectedParent && (
                <div className={styles.replyContext}>
                  <Avatar
                    src={avatarMedia(
                      profiles.get(selectedParent.authorId)?.picture,
                      session.media,
                    )}
                    alt=""
                    fallback={senderName(selectedParent)}
                    size="default"
                  />
                  <div>
                    <span>Replying to {senderName(selectedParent)}</span>
                    {selectedParentText && <p>{selectedParentText}</p>}
                  </div>
                  <IconButton
                    size="sm"
                    aria-label="Cancel reply target"
                    onClick={focusReply}
                    icon={<XIcon size={16} aria-hidden="true" />}
                  />
                </div>
              )
            )
          }
          editMessages={rows}
          focusRequest={pendingReplyFocus ?? 0}
          autoFocus={autoFocus ?? false}
          onOpenLink={onOpenLink}
          canOpenLink={canOpenLink}
          onDraftSaved={onDraftSaved}
          onSend={(id) => {
            onSend?.(id);
            targetAnchor.current = undefined;
            positioned.current = true;
            follow.current = !selectedParent;
            // Never count this composer's own send as a new arrival.
            previousReplies.current.ids.add(id);
            if (selectedParent)
              setExpanded(
                (current) =>
                  new Set([
                    ...current,
                    selectedParent.id,
                    ...tree.ancestors(selectedParent.id),
                  ]),
              );
            // A background send may publish after the user picked a new target.
            setReplyParent((current) =>
              current === replyParent ? undefined : current,
            );
            setSent(id);
          }}
        />
      )}
    </MessageEditScope>
  );
}
/** Holds the thread's area with the Buzz mark until its first page can show. */
// How far a saved reading row has moved from its saved viewport offset. WebKit
// quantizes scrollTop: round instead of letting tiny negative fractions lose a
// whole pixel on every animation frame.
function readingDrift(
  element: HTMLElement,
  anchor: { element: HTMLElement; top: number },
) {
  return Math.round(
    anchor.element.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      anchor.top,
  );
}

// A saved row that has since shrunk, as a reply does when it becomes a group's
// line, keeps its offset only while part of it stays shown. Otherwise its top
// meets the viewport's. A row without a laid-out box keeps its offset.
function shownAnchor(anchor: { element: HTMLElement; top: number }) {
  const { height } = anchor.element.getBoundingClientRect();
  return !height || anchor.top + height > 0
    ? anchor
    : { element: anchor.element, top: 0 };
}

function ThreadLoading() {
  return (
    <div className={styles.threadLoading} role="status">
      <picture>
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet="/buzz-mark.svg"
        />
        <img src="/buzz-loading-mark.svg" alt="" width="498" height="341" />
      </picture>
      <span className="sr-only">Loading thread…</span>
    </div>
  );
}
