import { useMediaReadRecovery } from "./use-media-read-recovery";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { prepareReviewEntrance } from "./use-review-entrance";
import { useMediaCorners } from "./use-media-corners";
import { VideoPlayer, VideoControls } from "./VideoPlayer";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowsOutIcon,
  PlayIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { createPortal } from "react-dom";
import type { Attachment } from "../relay/contracts";
import {
  openingFrame,
  openingFrameCapture,
  rememberOpeningFrame,
} from "../relay/media";
import styles from "./Messages.module.css";
import { useModalBoundary } from "./useModalBoundary";
import { useMediaElementSource } from "./use-media-element-source";
import { MediaContextMenu } from "./MediaContextMenu";
import { MediaActionAnnouncements } from "./MediaActionAnnouncements";

export type MediaPlayback = Readonly<{
  attachmentUrl: string;
  seconds: number;
}>;

type MediaAttachmentProps = {
  attachment: Attachment;
  media(url: string): string | undefined;
  mode?: "inline" | "thread";
  imageDescription?: string;
  preload?: "auto" | "metadata" | "none";
  seekTo?: number;
  seekRequest?: number;
  onPlayback?(playback: MediaPlayback): void;
  onOpenReview?(attachment: Attachment, seconds: number): void;
  compact?: boolean;
  overlayCount?: number;
  label?: string;
};

function useVideoPosition(
  video: RefObject<HTMLVideoElement | null>,
  seekTo: number | undefined,
  seekRequest: number | undefined,
  active: boolean,
) {
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    // A monotonically increasing request lets the same timecode seek again.
    void seekRequest;
    const recovered = active && !wasActive.current;
    wasActive.current = active;
    const element = video.current;
    if (!element) return;
    if (!active) {
      element.pause();
      return;
    }
    // Recovery restores the same paused position, not an old seek intent.
    if (recovered || seekTo === undefined) return;
    const seek = () => {
      element.currentTime = Math.max(0, seekTo);
      void element.play().catch(() => {});
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else element.addEventListener("loadedmetadata", seek, { once: true });
    return () => element.removeEventListener("loadedmetadata", seek);
  }, [seekTo, seekRequest, video, active]);
}

export function MediaAttachment({
  attachment,
  media,
  mode = "inline",
  imageDescription = "Attachment preview",
  preload = "auto",
  seekTo,
  seekRequest,
  onPlayback,
  onOpenReview,
  compact = false,
  overlayCount = 0,
  label = "Open video fullscreen",
}: MediaAttachmentProps) {
  const active = useConversationPresentation();
  const corners = useMediaCorners();
  const source = media(attachment.url);
  const preview = attachment.previewUrl
    ? media(attachment.previewUrl)
    : undefined;
  const video = useRef<HTMLVideoElement>(null);
  const expandedVideo = useRef<HTMLVideoElement>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  if (!active && viewerOpen) setViewerOpen(false);
  const [currentTime, setCurrentTime] = useState(seekTo ?? 0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const captured = source ? openingFrame(source) : undefined;
  const openingSeek = useRef<{ time: number; capture: number }>(undefined);
  const encoding = useRef(false);
  const [capturedPreview, setCapturedPreview] = useState(captured?.poster);
  const [measuredDimensions, setMeasuredDimensions] = useState<
    { width: number; height: number } | undefined
  >(captured && { width: captured.width, height: captured.height });
  const dimensions = attachment.dimensions ?? measuredDimensions;
  const previewStyle = dimensions
    ? ({
        "--media-ratio": `${dimensions.width} / ${dimensions.height}`,
        aspectRatio: "var(--media-ratio)",
      } as CSSProperties)
    : undefined;
  const visiblePreview = preview ?? capturedPreview;
  useVideoPosition(video, seekTo, seekRequest, active && !compact);
  const element = useMediaElementSource(
    attachment.kind === "video" ? source : undefined,
  );
  const videoSource = element.src;
  const { recover: recoverMedia } = useMediaReadRecovery(
    active ? videoSource : undefined,
    () => setFailed(true),
  );
  const viewMedia = (seconds: number) => {
    video.current?.pause();
    if (onOpenReview) onOpenReview(attachment, seconds);
    else setViewerOpen(true);
  };

  if (!source && !compact)
    return (
      <span className={styles.attachmentUnavailable} role="status">
        {attachment.kind === "video"
          ? "Video unavailable"
          : "Image unavailable"}
      </span>
    );

  if ((failed || element.unavailable) && !compact)
    return (
      <span className={styles.attachmentUnavailable} role="status">
        {attachment.kind === "video"
          ? "Video unavailable"
          : "Image unavailable"}
      </span>
    );

  if (attachment.kind === "image")
    return (
      <>
        <MediaContextMenu
          kind="image"
          url={attachment.url}
          source={source}
          name={attachment.name}
          onView={() => viewMedia(0)}
        >
          <button
            ref={corners}
            className={`${styles.mediaPreview} ${mode === "thread" ? styles.mediaPreviewThread : ""}`}
            style={previewStyle}
            type="button"
            aria-label="Open image fullscreen"
            data-image-preview=""
            data-media-preview=""
            onClick={(event) => {
              prepareReviewEntrance(event);
              viewMedia(0);
            }}
          >
            <span className={styles.mediaPreviewPixels}>
              <img
                src={source}
                alt={imageDescription}
                loading="lazy"
                onLoad={(event) =>
                  setMeasuredDimensions({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                onError={() => setFailed(true)}
              />
            </span>
            <svg
              className={styles.imageOutline}
              data-image-outline=""
              aria-hidden="true"
            >
              <path />
            </svg>
          </button>
        </MediaContextMenu>
        {active &&
          viewerOpen &&
          createPortal(
            <MediaViewer
              title="Image attachment"
              close={() => setViewerOpen(false)}
            >
              <MediaContextMenu
                kind="image"
                url={attachment.url}
                source={source}
                name={attachment.name}
              >
                <img
                  className={styles.mediaViewerImage}
                  src={source}
                  alt={imageDescription}
                />
              </MediaContextMenu>
            </MediaViewer>,
            document.body,
          )}
      </>
    );

  if (attachment.kind !== "video")
    return (
      <span className={styles.attachmentUnavailable} role="status">
        Attachment unavailable
      </span>
    );

  // WebKit can emit loadeddata before nonzero dimensions are available.
  // Invalid geometry must not replace the usable preview fallback.
  const measureVideo = (element: HTMLVideoElement) => {
    if (
      Number.isFinite(element.videoWidth) &&
      element.videoWidth > 0 &&
      Number.isFinite(element.videoHeight) &&
      element.videoHeight > 0
    )
      setMeasuredDimensions({
        width: element.videoWidth,
        height: element.videoHeight,
      });
  };

  const videoElement = (
    // biome-ignore lint/a11y/useMediaCaption: signed attachment metadata has no caption track URL.
    <video
      ref={video}
      className={styles.mediaVideo}
      src={videoSource}
      poster={visiblePreview}
      preload={compact ? "metadata" : preload}
      playsInline
      style={previewStyle}
      // With preload="metadata", WebKit may load no frame until playback, so
      // the size is taken from metadata too.
      onLoadedMetadata={(event) => measureVideo(event.currentTarget)}
      onLoadedData={(event) => {
        const element = event.currentTarget;
        measureVideo(element);
        if (!preview && !capturedPreview && element.currentTime === 0) {
          // WebKit often paints no frame at exactly zero. Seeking after actual
          // frame data arrives forces a decodable opening frame.
          const time = Math.min(0.1, element.duration || 0.1);
          openingSeek.current = { time, capture: openingFrameCapture() };
          element.currentTime = time;
          return;
        }
      }}
      onSeeked={(event) => {
        const element = event.currentTarget;
        const opening = openingSeek.current;
        openingSeek.current = undefined;
        if (
          !preview &&
          !capturedPreview &&
          !encoding.current &&
          element.videoWidth > 0
        ) {
          try {
            const canvas = document.createElement("canvas");
            const scale = Math.min(1, 640 / element.videoWidth);
            canvas.width = Math.max(1, Math.round(element.videoWidth * scale));
            canvas.height = Math.max(
              1,
              Math.round(element.videoHeight * scale),
            );
            const context = canvas.getContext("2d");
            context?.drawImage(element, 0, 0, canvas.width, canvas.height);
            const { videoWidth: width, videoHeight: height } = element;
            // Only a drawn opening frame is shared; an explicit timecode seek
            // or a blank export stays with this mount.
            const shared =
              source &&
              context &&
              opening &&
              Math.abs(element.currentTime - opening.time) < 0.01
                ? { source, capture: opening.capture }
                : undefined;
            // Chromium encodes toBlob off the main thread; WebKit still
            // encodes inline. The first seek owns the poster until its
            // encode fails.
            encoding.current = true;
            canvas.toBlob(
              (blob) => {
                if (!blob) {
                  encoding.current = false;
                  return;
                }
                const reader = new FileReader();
                reader.onloadend = () => {
                  const poster = reader.result;
                  if (typeof poster !== "string") {
                    encoding.current = false;
                    return;
                  }
                  if (shared && poster.startsWith("data:image/jpeg;"))
                    rememberOpeningFrame(
                      shared.source,
                      { poster, width, height },
                      shared.capture,
                    );
                  setCapturedPreview(poster);
                };
                reader.readAsDataURL(blob);
              },
              "image/jpeg",
              0.8,
            );
          } catch {
            encoding.current = false;
            // A decoded frame may still paint in the video when canvas export
            // is unavailable; the poster capture is only a compatibility aid.
          }
        }
      }}
      onError={(event) => {
        if (!recoverMedia(event.currentTarget)) setFailed(true);
      }}
      onPause={() => setPlaying(false)}
      onPlay={() => {
        setStarted(true);
        setPlaying(true);
      }}
      onTimeUpdate={(event) => {
        const seconds = event.currentTarget.currentTime;
        setCurrentTime(seconds);
        onPlayback?.({ attachmentUrl: attachment.url, seconds });
      }}
    />
  );

  if (compact)
    return (
      <MediaContextMenu
        kind="video"
        url={attachment.url}
        source={source}
        name={attachment.name}
        onView={() => viewMedia(0)}
      >
        <a
          ref={corners}
          className={styles.attachmentImage}
          style={{
            width: "100%",
            height: 0,
            paddingBottom: "100%",
            aspectRatio: "auto",
          }}
          href={source ?? attachment.url}
          aria-label={label}
          data-media-preview=""
          data-video-preview=""
          onClick={(event) => {
            event.preventDefault();
            prepareReviewEntrance(event);
            onOpenReview?.(attachment, 0);
          }}
        >
          <span className={styles.attachmentImagePixels}>
            {source && !failed && !element.unavailable ? videoElement : null}
            <span className={styles.mediaGridBadge} aria-hidden="true">
              <PlayIcon size={24} />
            </span>
            {overlayCount > 0 && (
              <span className={styles.imageOverflow} aria-hidden="true">
                +{overlayCount}
              </span>
            )}
          </span>
          <svg
            className={styles.imageOutline}
            data-image-outline=""
            aria-hidden="true"
          >
            <path />
          </svg>
        </a>
      </MediaContextMenu>
    );

  return (
    <>
      <MediaContextMenu
        kind="video"
        url={attachment.url}
        source={source}
        name={attachment.name}
        onView={() => viewMedia(currentTime)}
      >
        <div
          ref={corners}
          className={`${styles.mediaPreview} ${mode === "thread" ? styles.mediaPreviewThread : ""}`}
          data-video-preview=""
          data-media-preview=""
          data-started={started || undefined}
          data-playing={playing ? "true" : undefined}
          style={previewStyle}
        >
          <div
            className={`${styles.mediaPreviewPixels} dark`}
            data-color-mode="dark"
          >
            {visiblePreview && !started && (
              <img
                className={styles.mediaPoster}
                src={visiblePreview}
                alt=""
                aria-hidden="true"
              />
            )}
            {videoElement}
            {active && <VideoControls videoRef={video} inline />}
            <span className={styles.mediaExpand}>
              <IconButton
                size="compact"
                variant="media"
                type="button"
                aria-label="Open video fullscreen"
                onClick={(event) => {
                  prepareReviewEntrance(event);
                  viewMedia(currentTime);
                }}
                icon={<ArrowsOutIcon size={16} aria-hidden="true" />}
              />
            </span>
          </div>
          <svg
            className={styles.imageOutline}
            data-image-outline=""
            aria-hidden="true"
          >
            <path />
          </svg>
        </div>
      </MediaContextMenu>
      {source &&
        active &&
        viewerOpen &&
        createPortal(
          <MediaViewer
            title="Video attachment"
            close={() => setViewerOpen(false)}
          >
            <VideoPlayer
              attachmentUrl={attachment.url}
              downloadName={attachment.name ?? ""}
              source={source}
              poster={visiblePreview}
              videoRef={expandedVideo}
              initialTime={currentTime}
              onError={() => setFailed(true)}
              onTime={(seconds) => {
                setCurrentTime(seconds);
                if (video.current) video.current.currentTime = seconds;
                onPlayback?.({ attachmentUrl: attachment.url, seconds });
              }}
            />
          </MediaViewer>,
          document.body,
        )}
    </>
  );
}

/** The plain fullscreen fallback for surfaces that host no media review. */
export function MediaViewer({
  title,
  close,
  children,
}: {
  title: string;
  close(): void;
  children: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalBoundary(backdrop, closeButton, close);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a pointer-only shortcut; the dialog has an explicit close button and Escape behavior.
    <div
      ref={backdrop}
      className={styles.mediaViewerBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className={`${styles.mediaViewer} dark`}
        data-color-mode="dark"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.mediaViewerHeading} data-tauri-drag-region>
          <PanelHeader
            title={<PanelHeaderLabel title={title} />}
            actions={
              <IconButton
                size="compact"
                ref={closeButton}
                type="button"
                aria-label="Close fullscreen viewer"
                onClick={close}
                icon={<XIcon size={20} aria-hidden="true" />}
              />
            }
          />
        </div>
        <MediaActionAnnouncements>{children}</MediaActionAnnouncements>
      </section>
    </div>
  );
}
