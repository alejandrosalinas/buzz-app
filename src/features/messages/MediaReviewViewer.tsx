import { TypingIndicator } from "./TypingIndicator";
import { workflowLabel } from "../relay/workflow-attribution";
import { MessageEditScope } from "./MessageEditScope";
import { useReviewSidebarMotion } from "./use-review-sidebar-motion";
import { readReviewOrigin } from "./use-review-entrance";
import { VideoPlayer, videoTime } from "./VideoPlayer";
import { useMediaElementSource } from "./use-media-element-source";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  SidebarIcon,
  ChatCircleIcon,
  CaretLeftIcon,
  CaretRightIcon,
} from "../../shared/design-system/icons/index";
import type { ConversationExtensions } from "../conversation/contracts";
import type { Attachment, ChannelMessage } from "../relay/contracts";
import { safeMessageUrl } from "../relay/message-content";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { compareMessages } from "../relay/message-order";
import { useProfileGeneration, useRowProfiles } from "../relay/react";
import { rowProfileIds } from "../relay/membership";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { MessageComposer } from "./MessageComposer";
import { ImageReviewStage } from "./ImageReviewStage";
import { MessageRow } from "./MessageRow";
import {
  useActivityPresentation,
  useStableRowActivity,
} from "./activity-presentation";
import { parseMediaTimeReply } from "./media-timecode";
import { VideoReviewReactions } from "./VideoReviewReactions";
import styles from "./Messages.module.css";
import { MediaReviewFrame } from "./MediaReviewFrame";
import { avatarMedia } from "../../shared/avatar-source";
import { LinkThreadTabContext } from "../conversation/LinkLabelContext";

type MediaReviewViewerProps = {
  attachment: Attachment;
  initialAttachments?: readonly Attachment[] | undefined;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  messageId: string;
  initialTime: number;
  hasComments?: boolean;
  restoreFocus?: RefObject<HTMLElement | null>;
  onOpenLink(url: string): boolean;
  close(): void;
};

export function MediaReviewViewer(props: MediaReviewViewerProps) {
  const { session, channelId, messageId } = props;
  const [{ origin, readingAnchor }] = useState(() => {
    const opener =
      props.restoreFocus?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    return {
      origin: readReviewOrigin(opener),
      readingAnchor: firstVisibleMessageId(opener),
    };
  });
  const [active, setActive] = useState(() => ({
    attachment: props.attachment,
    initialTime: props.initialTime,
    request: 0,
  }));
  const [view, setView] = useState<ThreadView>();
  const [threadError, setThreadError] = useState<string>();
  useEffect(() => {
    try {
      const owned = session.thread(channelId, messageId, { exact: true });
      setThreadError(undefined);
      setView(owned);
      void owned.refresh();
      return () => owned.dispose();
    } catch (error) {
      setThreadError(String(error));
    }
  }, [session, channelId, messageId]);
  const activeProps = {
    ...props,
    origin,
    readingAnchor,
    attachment: active.attachment,
    initialTime: active.initialTime,
    selectionRequest: active.request,
    selectAttachment: (attachment: Attachment, initialTime: number) =>
      setActive((current) => ({
        attachment,
        initialTime,
        request: current.request + 1,
      })),
  };
  return (
    <ResolvedReview {...activeProps} view={view} threadError={threadError} />
  );
}

/** The reader's place in the conversation the review opens over. */
function firstVisibleMessageId(opener: HTMLElement | null) {
  const scroller = opener?.closest<HTMLElement>("[data-message-scroller]");
  if (!scroller) return undefined;
  const top = scroller.getBoundingClientRect().top;
  return [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")].find(
    (row) => row.getBoundingClientRect().bottom > top,
  )?.dataset.messageId;
}

type ActiveReviewProps = MediaReviewViewerProps & {
  origin: ReturnType<typeof readReviewOrigin>;
  readingAnchor: string | undefined;
  selectionRequest: number;
  selectAttachment(attachment: Attachment, initialTime: number): void;
};

const noThreadSubscription = () => () => {};
const noThreadSnapshot = () => undefined;

function ResolvedReview({
  view,
  threadError,
  ...props
}: ActiveReviewProps & {
  view: ThreadView | undefined;
  threadError: string | undefined;
}) {
  const snapshot = useSyncExternalStore(
    view?.subscribe ?? noThreadSubscription,
    view?.snapshot ?? noThreadSnapshot,
    view?.snapshot ?? noThreadSnapshot,
  );
  useEffect(() => {
    if (snapshot?.status === "ready" && snapshot.canLoadMore)
      void view?.loadMore();
  }, [view, snapshot?.status, snapshot?.canLoadMore]);
  const knownRows = [
    snapshot?.root,
    snapshot?.target,
    ...(snapshot?.replies ?? []),
  ].filter((row): row is ChannelMessage => !!row);
  const attachmentAvailable = knownRows.some((row) =>
    row.attachments.some((item) => item.url === props.attachment.url),
  );
  const resolved = snapshot?.status === "ready" && !snapshot.error;
  const invalidated =
    snapshot?.targetStatus === "unavailable" ||
    (resolved && (!snapshot.root || !attachmentAvailable)) ||
    (!!snapshot?.error &&
      (snapshot.status === "idle" || (snapshot.limited && !knownRows.length)));
  const authoritative =
    resolved &&
    !!snapshot.root &&
    attachmentAvailable &&
    snapshot.targetStatus === "ready";
  // A retry clears the thread's error before it has fresh evidence. Keep an
  // invalidated viewer closed to its opener's stale media until re-admitted.
  const [blockedView, setBlockedView] = useState<ThreadView>();
  if (view && invalidated && blockedView !== view) setBlockedView(view);
  else if (authoritative && blockedView === view) setBlockedView(undefined);
  const galleryAttachments = attachmentAvailable
    ? knownRows.flatMap((row) => row.attachments)
    : props.initialAttachments;
  const pendingProps = { ...props, galleryAttachments };
  if (threadError) return <ReviewShell {...pendingProps} error={threadError} />;
  if (!view || !snapshot) return <ReviewShell {...pendingProps} loading />;
  if (invalidated || (blockedView === view && !authoritative))
    return (
      <ReviewShell
        {...props}
        error={
          snapshot.error ??
          (snapshot.root
            ? "Attachment unavailable."
            : "Original message unavailable.")
        }
        unavailable
        retry={view.refresh}
      />
    );
  if (snapshot.error)
    return (
      <ReviewShell
        {...pendingProps}
        error={snapshot.error}
        retry={view.refresh}
      />
    );
  if (snapshot.status === "loading" || snapshot.status === "idle")
    return <ReviewShell {...pendingProps} loading />;
  if (!snapshot.root)
    return (
      <ReviewShell
        {...props}
        error="Original message unavailable."
        unavailable
        retry={view.refresh}
      />
    );
  const replies = [snapshot.target, ...snapshot.replies]
    .filter(
      (row): row is NonNullable<typeof row> =>
        !!row && row.id !== snapshot.root?.id,
    )
    .filter(
      (row, index, rows) =>
        rows.findIndex((item) => item.id === row.id) === index,
    )
    .sort(compareMessages);
  const threadRows = [snapshot.root, ...replies];
  return (
    <ReviewShell
      {...props}
      rootId={snapshot.root.id}
      editMessages={threadRows}
      replies={replies}
      limited={snapshot.limited}
      timecodesSeekable={props.attachment.kind === "video"}
    />
  );
}

function ReviewShell({
  attachment,
  galleryAttachments = [],
  extensions,
  session,
  scope,
  channelId,
  channelName,
  initialTime,
  hasComments = false,
  origin,
  readingAnchor,
  close,
  onOpenLink,
  rootId,
  replies = [],
  editMessages = [],
  limited = false,
  timecodesSeekable = false,
  loading = false,
  unavailable = false,
  error,
  retry,
  restoreFocus,
  selectAttachment,
  selectionRequest,
}: ActiveReviewProps & {
  galleryAttachments?: readonly Attachment[] | undefined;
  rootId?: string;
  editMessages?: readonly ChannelMessage[];
  replies?: ReturnType<ThreadView["snapshot"]>["replies"];
  limited?: boolean;
  timecodesSeekable?: boolean;
  loading?: boolean;
  unavailable?: boolean;
  error?: string;
  retry?: () => void | Promise<void>;
}) {
  const source = session.media(attachment.url);
  // Listener unavailability is not a playback error the selection resets.
  const sourceUnavailable = useMediaElementSource(
    attachment.kind === "video" ? source : undefined,
  ).unavailable;
  const frame = useRef<HTMLElement>(null);
  const retryThread = () => {
    // Refresh removes Retry while loading; keep keyboard input in the viewer.
    frame.current?.focus({ preventScroll: true });
    void retry?.();
  };
  const video = useRef<HTMLVideoElement>(null);
  const [commentsChoice, setCommentsOpen] = useState<boolean>();
  const [selectedImageUrl, setSelectedImageUrl] = useState(attachment.url);
  const commentsOpen =
    commentsChoice ?? (loading ? hasComments : replies.length > 0 || !!error);
  useEffect(() => {
    if (rootId && !loading)
      setCommentsOpen((choice) => choice ?? replies.length > 0);
  }, [rootId, loading, replies.length]);
  const prepareSidebarMotion = useReviewSidebarMotion(frame, commentsOpen);
  const [commentsMotion, setCommentsMotion] = useState(false);
  const [selectedComment, setSelectedComment] = useState<string>();
  const profiles = useRowProfiles(session.profiles, replies);
  const [currentTime, setCurrentTime] = useState(initialTime);
  const [includeTime, setIncludeTime] = useState(true);
  const mediaAttachments = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...galleryAttachments,
      ...editMessages.flatMap((row) => row.attachments),
      attachment,
    ].filter(
      (item) =>
        (item.kind === "image" || item.kind === "video") &&
        !!safeMessageUrl(item.url) &&
        !seen.has(item.url) &&
        !!seen.add(item.url),
    );
  }, [attachment, editMessages, galleryAttachments]);
  const attachmentOwner = editMessages.find((row) =>
    row.attachments.some((item) => item.url === attachment.url),
  );
  const videoCount = mediaAttachments.filter(
    (item) => item.kind === "video",
  ).length;
  const timecodeApplies = (row: ChannelMessage) => {
    if (row.mediaTargetUrl) return row.mediaTargetUrl === attachment.url;
    if (videoCount === 1) return true;
    // Older timed replies were always rooted at the thread, so their exact
    // gallery target cannot be recovered. Preserve their previous broad
    // visibility instead of hiding them from reply-owned videos.
    if (row.replyParentId === rootId) return true;
    return row.replyParentId === attachmentOwner?.id;
  };
  const markers = timecodesSeekable
    ? replies.flatMap((row) => {
        const parsed = parseMediaTimeReply(row.content);
        if (!parsed || !timecodeApplies(row)) return [];
        const displayId = row.workflowOwnerId ?? row.authorId;
        const profile = profiles.get(displayId);
        const name = profile?.name ?? displayId.slice(0, 10);
        return [
          {
            id: row.id,
            seconds: parsed.anchor.seconds,
            label: parsed.label,
            text: parsed.content,
            author: row.workflowOwnerId ? workflowLabel(name) : name,
            picture: row.workflowOwnerId
              ? undefined
              : avatarMedia(profile?.picture, session.media),
          },
        ];
      })
    : [];
  const mixedGallery =
    mediaAttachments.length > 1 &&
    mediaAttachments.some((item) => item.kind === "video");
  const displayedAttachment =
    !mixedGallery && attachment.kind === "image"
      ? (mediaAttachments.find((item) => item.url === selectedImageUrl) ??
        attachment)
      : attachment;
  const mediaTitle =
    displayedAttachment.name?.trim() ||
    (displayedAttachment.kind === "video" ? "Video" : "Image");
  const mediaIndex = mediaAttachments.findIndex(
    (item) => item.url === attachment.url,
  );
  const navigateMedia = (direction: -1 | 1) => {
    const next = mediaAttachments[mediaIndex + direction];
    if (next) {
      video.current?.pause();
      // The stage may unmount and an end-arrow may become disabled.
      // Keep subsequent keyboard events inside the surviving dialog.
      frame.current?.focus({ preventScroll: true });
      selectAttachment(next, 0);
    }
  };
  const [mediaFailed, setMediaFailed] = useState(false);
  // selectionRequest intentionally re-applies a seek when the same URL/time is selected again.
  useEffect(() => {
    void selectionRequest;
    setMediaFailed(false);
    setSelectedImageUrl(attachment.url);
    const seconds = Math.max(0, initialTime);
    const element = video.current;
    if (attachment.kind !== "video" || !element) {
      setCurrentTime(seconds);
      return;
    }
    const apply = () => {
      if (!video.current) return;
      video.current.currentTime = seconds;
      setCurrentTime(video.current.currentTime);
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    else element.addEventListener("loadedmetadata", apply, { once: true });
    return () => element.removeEventListener("loadedmetadata", apply);
  }, [attachment.url, attachment.kind, initialTime, selectionRequest]);
  const seek = (seconds: number) => {
    if (!video.current) return;
    const duration = video.current.duration;
    video.current.currentTime = Math.max(
      0,
      Math.min(seconds, Number.isFinite(duration) ? duration : seconds),
    );
    setCurrentTime(video.current.currentTime);
    video.current.dispatchEvent(new Event("timeupdate"));
    void video.current.play().catch(() => {});
  };
  return (
    <MediaReviewFrame
      title={mediaTitle}
      label={attachment.kind === "video" ? "Video review" : "Image viewer"}
      isVideo={attachment.kind === "video"}
      video={video}
      frame={frame}
      origin={origin}
      canReturnToOrigin={
        selectionRequest === 0 && selectedImageUrl === attachment.url
      }
      commentsOpen={commentsOpen}
      commentsMotion={commentsMotion}
      restoreFocus={restoreFocus}
      close={close}
      navigate={mixedGallery ? navigateMedia : undefined}
      actions={
        <>
          {mixedGallery && (
            <div className={styles.imageReviewSwitcher}>
              <IconButton
                size="compact"
                aria-label="Previous media"
                disabled={mediaIndex <= 0}
                onClick={() => navigateMedia(-1)}
                icon={<CaretLeftIcon size={20} />}
              />
              <span aria-live="polite" aria-atomic="true">
                {mediaIndex + 1} / {mediaAttachments.length}
              </span>
              <IconButton
                size="compact"
                aria-label="Next media"
                disabled={mediaIndex >= mediaAttachments.length - 1}
                onClick={() => navigateMedia(1)}
                icon={<CaretRightIcon size={20} />}
              />
            </div>
          )}
          <IconButton
            size="compact"
            aria-label={commentsOpen ? "Hide comments" : "Show comments"}
            aria-pressed={commentsOpen}
            onClick={(event) => {
              prepareSidebarMotion(event.detail > 0);
              setCommentsMotion(event.detail > 0);
              setCommentsOpen(!commentsOpen);
            }}
            icon={<SidebarIcon size={20} />}
          />
        </>
      }
      sidebar={
        <aside
          data-review-chrome=""
          className={styles.mediaReviewConversation}
          inert={!commentsOpen}
          aria-hidden={!commentsOpen || undefined}
          aria-label="Media comments"
          data-attachment-drop-zone=""
        >
          <div className={styles.mediaReviewConversationContent}>
            <div className={styles.mediaReviewThreadHeading}>
              <PanelHeader
                variant="compact"
                title={
                  <PanelHeaderLabel
                    title="Comments"
                    icon={<ChatCircleIcon size={20} />}
                  />
                }
                actions={
                  rootId ? (
                    <span className={styles.mediaReviewCommentCount}>
                      {replies.length}
                    </span>
                  ) : undefined
                }
              />
            </div>
            {rootId && source ? (
              <MessageEditScope>
                <ReviewComments
                  channelId={channelId}
                  threadRootId={rootId}
                  selectedComment={selectedComment}
                  readingAnchor={readingAnchor}
                  replies={replies}
                  limited={limited}
                  session={session}
                  scope={scope}
                  extensions={extensions}
                  selectAttachment={selectAttachment}
                  canSeekTimecode={timecodeApplies}
                  {...(attachment.kind === "video" && timecodesSeekable
                    ? { seek }
                    : {})}
                />
                {attachment.kind === "video" && (
                  <div className={styles.mediaReviewTimeOption}>
                    <span>{videoTime(currentTime)}</span>
                    <Checkbox
                      label="Comment at current frame"
                      checked={includeTime}
                      onCheckedChange={setIncludeTime}
                    />
                  </div>
                )}
                <div
                  className={styles.mediaReviewComposer}
                  onFocusCapture={() => {
                    if (attachment.kind === "video") video.current?.pause();
                  }}
                >
                  <MessageComposer
                    extensions={extensions}
                    session={session}
                    scope={scope}
                    channelId={channelId}
                    channelName={channelName}
                    threadRootId={rootId}
                    editMessages={editMessages}
                    {...(attachment.kind === "video" && includeTime
                      ? {
                          mediaTimeSeconds: currentTime,
                          replyParentId: attachmentOwner?.id ?? rootId,
                          mediaTargetUrl: attachment.url,
                        }
                      : {})}
                    hideMediaTimeIndicator
                  />
                </div>
              </MessageEditScope>
            ) : (
              <p className={styles.empty} role={error ? "alert" : "status"}>
                {error ?? "Loading comments…"}
                {retry && !unavailable && (
                  <Button size="sm" type="button" onClick={retryThread}>
                    Retry
                  </Button>
                )}
              </p>
            )}
          </div>
        </aside>
      }
    >
      {(!source &&
        (attachment.kind === "video" || mediaAttachments.length < 2)) ||
      unavailable ||
      sourceUnavailable ||
      mediaFailed ? (
        <p
          className={styles.mediaReviewUnavailable}
          role={error ? "alert" : "status"}
        >
          {error ?? (loading ? "Loading media…" : "Media unavailable")}
          {retry && unavailable && (
            <Button size="sm" type="button" onClick={retryThread}>
              Retry
            </Button>
          )}
        </p>
      ) : attachment.kind === "video" && source ? (
        <VideoPlayer
          key={source}
          downloadName={attachment.name ?? ""}
          videoRef={video}
          source={source}
          poster={
            (selectionRequest === 0 ? origin?.poster : undefined) ??
            (attachment.previewUrl
              ? session.media(attachment.previewUrl)
              : undefined)
          }
          initialTime={initialTime}
          markers={markers}
          onMarker={(id) => {
            setSelectedComment(id);
            setCommentsOpen(true);
          }}
          onError={() => setMediaFailed(true)}
          onTime={setCurrentTime}
        >
          {rootId && (
            <VideoReviewReactions
              session={session}
              scope={scope}
              channelId={channelId}
              rootId={rootId}
              replyParentId={attachmentOwner?.id ?? rootId}
              mediaTargetUrl={attachment.url}
              videoRef={video}
              extensions={extensions}
            />
          )}
        </VideoPlayer>
      ) : (
        <ImageReviewStage
          key={mixedGallery ? attachment.url : "images"}
          attachments={
            mixedGallery
              ? [attachment]
              : mediaAttachments.filter((item) => item.kind === "image")
          }
          selectedUrl={mixedGallery ? attachment.url : selectedImageUrl}
          select={setSelectedImageUrl}
          media={session.media}
          onOpenLink={onOpenLink}
        />
      )}
    </MediaReviewFrame>
  );
}

function ReviewComments({
  channelId,
  threadRootId,
  replies,
  selectedComment,
  readingAnchor,
  limited,
  session,
  scope,
  extensions,
  seek,
  canSeekTimecode,
  selectAttachment,
}: {
  channelId: string;
  threadRootId: string;
  replies: ReturnType<ThreadView["snapshot"]>["replies"];
  selectedComment?: string | undefined;
  readingAnchor: string | undefined;
  limited: boolean;
  session: RelaySession;
  scope: string;
  extensions?: ConversationExtensions | undefined;
  seek?: (seconds: number) => void;
  canSeekTimecode(row: ChannelMessage): boolean;
  selectAttachment(attachment: Attachment, initialTime: number): void;
}) {
  const profiles = useRowProfiles(session.profiles, replies);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const activity = useActivityPresentation(
    replies,
    session.agentActivity,
    agentPubkeys,
  );
  const stableActivity = useStableRowActivity();
  const comments = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selectedComment)
      comments.current
        ?.querySelector(`[data-review-comment="${selectedComment}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedComment]);
  // Open where the reader was in the thread behind the review. Replies load in
  // pages, so wait for the anchor to arrive, then place it once.
  const anchored = useRef(false);
  const anchorLoaded = replies.some((row) => row.id === readingAnchor);
  useLayoutEffect(() => {
    const section = comments.current;
    const row =
      anchorLoaded &&
      section?.querySelector(
        `[data-review-comment="${CSS.escape(readingAnchor ?? "")}"]`,
      );
    if (anchored.current || !section || !row) return;
    anchored.current = true;
    section.scrollTop +=
      row.getBoundingClientRect().top - section.getBoundingClientRect().top;
  }, [readingAnchor, anchorLoaded]);
  const authors = [...new Set(replies.flatMap(rowProfileIds))].sort().join(":");
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (authors)
      void session.profiles
        .ensure(authors.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, authors, profileGeneration]);
  // Comment links stay inert: no host tab opener reaches them behind the review,
  // so mentions render as static names.
  return (
    <LinkThreadTabContext value={undefined}>
      <section
        ref={comments}
        data-message-scroller
        className={styles.mediaReviewThread}
        aria-label="Media comments"
      >
        {replies.map((row, index) => {
          return (
            <div
              key={row.id}
              data-review-comment={row.id}
              data-selected={selectedComment === row.id || undefined}
              className={styles.mediaReviewComment}
            >
              <MessageRow
                row={row}
                recordedActivity={stableActivity.activity(
                  row.id,
                  activity.byRow.get(row.id),
                  "history",
                )}
                extensions={extensions}
                session={session}
                scope={scope}
                profile={profiles.get(row.authorId)}
                agentPubkeys={agentPubkeys}
                media={session.media}
                onOpenLink={() => false}
                day={
                  index === 0 ||
                  new Date(
                    (replies[index - 1]?.createdAt ?? 0) * 1000,
                  ).toDateString() !==
                    new Date(row.createdAt * 1000).toDateString()
                }
                retry={session.messages.retry}
                onOpenMediaReview={(_rowId, attachment, seconds) =>
                  selectAttachment(attachment, seconds)
                }
                {...(seek && canSeekTimecode(row) ? { onMediaTime: seek } : {})}
              />
            </div>
          );
        })}
        <TypingIndicator
          session={session}
          channelId={channelId}
          threadRootId={threadRootId}
          audience="agents"
          inFlow
          previousAuthor={replies.at(-1)?.authorId}
        />
        {!replies.length && (
          <p className={styles.threadNote}>
            No comments yet. Add the first below.
          </p>
        )}
        {limited && (
          <p className={styles.threadNote}>Thread history limit reached.</p>
        )}
      </section>
    </LinkThreadTabContext>
  );
}
