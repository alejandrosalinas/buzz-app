import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { prepareReviewEntrance } from "./use-review-entrance";
import { useMediaCorners } from "./use-media-corners";
import { MediaViewer } from "./MediaAttachment";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { imageDimensions, rememberImageDimensions } from "./image-dimensions";
import { validatedBlurhash } from "../relay/blurhash";
import { BLURHASH_SIZE, paintBlurhash } from "./blurhash";
import {
  decodedImageCapture,
  hasDecodedImage,
  retainDecodedImage,
  takeDecodedImage,
} from "../relay/media";
import styles from "./Messages.module.css";

export function AttachmentImage({
  attachment,
  session,
  source,
  thumbnail,
  cached = false,
  compact = false,
  overlayCount = 0,
  onOpenReview,
  onOpenLink,
  keepMounted,
  label = "Open image attachment",
}: {
  label?: string;
  attachment: Attachment;
  session?: RelaySession | undefined;
  source: string | undefined;
  thumbnail?: string | undefined;
  cached?: boolean;
  /** Square thumbnail geometry for a condensed image group. */
  compact?: boolean;
  /** Includes the covered image, matching the gallery's remaining count. */
  overlayCount?: number;
  onOpenReview?: (attachment: Attachment, seconds: number) => void;
  onOpenLink?: ((url: string) => boolean) | undefined;
  /** Pins the owning row in a virtualized list; returns the release. */
  keepMounted?: (() => () => void) | undefined;
}) {
  const active = useConversationPresentation();
  const corners = useMediaCorners();
  const [viewerOpen, setViewerOpen] = useState(false);
  if (!active && viewerOpen) setViewerOpen(false);
  // The viewer portal and its opener live in this row; eviction closes it.
  useEffect(() => {
    const release = viewerOpen ? keepMounted?.() : undefined;
    // The modal boundary restores focus on the next frame; releasing after it
    // lets the restored preview keep the row mounted instead.
    return release && (() => void requestAnimationFrame(release));
  }, [viewerOpen, keepMounted]);
  const [decoded, setDecoded] = useState<{
    source: string | undefined;
    session: RelaySession | undefined;
    dimensions?: NonNullable<Attachment["dimensions"]>;
  }>({ source, session });
  if (decoded.source !== source || decoded.session !== session)
    setDecoded({ source, session });
  const onDecoded = useCallback(
    (dimensions: NonNullable<Attachment["dimensions"]>) => {
      if (source) {
        rememberImageDimensions(session, source, dimensions);
        setDecoded({ source, session, dimensions });
      }
    },
    [source, session],
  );
  const decodedDimensions =
    decoded.source === source && decoded.session === session
      ? decoded.dimensions
      : undefined;
  const knownDimensions = decodedDimensions ?? imageDimensions(session, source);
  const dimensions = knownDimensions ?? attachment.dimensions;
  const width = dimensions
    ? Math.min(
        360,
        dimensions.width,
        (320 * dimensions.width) / dimensions.height,
      )
    : 0;
  const height = dimensions
    ? (width * dimensions.height) / dimensions.width
    : 0;
  const previewWidth = knownDimensions ? Math.max(1, width) : width;
  const previewHeight = knownDimensions ? Math.max(1, height) : height;
  const style = compact
    ? // Percentage padding reserves square tracks in WebKit too, including when
      // this grid is measured inside the virtualized, right-aligned message row.
      { width: "100%", height: 0, paddingBottom: "100%", aspectRatio: "auto" }
    : dimensions &&
        Number.isFinite(previewWidth) &&
        Number.isFinite(previewHeight) &&
        previewWidth >= 1 &&
        previewHeight >= 1
      ? {
          width: previewWidth,
          aspectRatio: knownDimensions
            ? `${previewWidth} / ${previewHeight}`
            : `${dimensions.width} / ${dimensions.height}`,
        }
      : undefined;
  if (!source && !overlayCount)
    return cached ? (
      <span
        ref={corners}
        className={`${styles.attachmentImage} ${styles.mediaPlaceholder}`}
        style={style}
        aria-hidden="true"
      />
    ) : (
      <span
        ref={corners}
        className={`${styles.attachmentImage} ${styles.mediaPlaceholder} ${styles.attachmentImageUnavailable}`}
        style={style}
        role="status"
      >
        <span>Image unavailable</span>
      </span>
    );
  return (
    <>
      <a
        ref={corners}
        className={styles.attachmentImage}
        style={style}
        href={source ?? attachment.url}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        data-media-preview=""
        data-image-ready={decodedDimensions ? true : undefined}
        onClick={(event) => {
          // Every activation stays in-app, modifiers included: the desktop
          // opener treats an unprevented Ctrl/Shift or `_blank` click as browser
          // intent, and no browser tab holds the app's credentials.
          event.preventDefault();
          prepareReviewEntrance(event);
          if (onOpenReview) onOpenReview(attachment, 0);
          else if (!onOpenLink?.(attachment.url)) setViewerOpen(true);
        }}
      >
        {/* Retargeting retires both the DOM pixels and all pending callbacks before
            the new source can paint. Session switches also remount the workspace. */}
        <span className={styles.attachmentImagePixels}>
          {source && (
            <ImagePixels
              key={JSON.stringify([source, attachment.blurhash])}
              session={session}
              source={source}
              thumbnail={thumbnail}
              blurhash={attachment.blurhash}
              onDecoded={onDecoded}
            />
          )}
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
      {active &&
        viewerOpen &&
        createPortal(
          <MediaViewer
            title="Image attachment"
            close={() => setViewerOpen(false)}
          >
            <img
              className={styles.mediaViewerImage}
              src={source}
              alt="Attachment preview"
            />
          </MediaViewer>,
          document.body,
        )}
    </>
  );
}

function ImagePixels({
  session,
  source,
  thumbnail,
  blurhash,
  onDecoded,
}: {
  session: RelaySession | undefined;
  source: string;
  thumbnail: string | undefined;
  blurhash: string | undefined;
  onDecoded: (dimensions: NonNullable<Attachment["dimensions"]>) => void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLSpanElement>(null);
  // Only peeks: the layout effect claims the element before paint, and a
  // concurrent mount of the same source falls back to its own original.
  const [retained, setRetained] = useState(
    () => !!session && hasDecodedImage(session, source),
  );
  const [ready, setReady] = useState(false);
  const [thumbnailLoaded, setThumbnailLoaded] = useState(false);
  const hash = validatedBlurhash(blurhash);
  useLayoutEffect(() => {
    if (!retained) return;
    const capture = decodedImageCapture();
    const original = session && takeDecodedImage(session, source);
    if (!original) {
      setRetained(false);
      return;
    }
    host.current?.append(original);
    onDecoded({ width: original.naturalWidth, height: original.naturalHeight });
    return () => {
      original.remove();
      retainDecodedImage(session, source, original, capture);
    };
  }, [retained, session, source, onDecoded]);
  useEffect(() => {
    const original = image.current;
    if (retained || !original) return;
    const capture = decodedImageCapture();
    let active = true;
    let decoded = false;
    let painted = false;
    let decoding = false;
    let observer: IntersectionObserver | undefined;
    const loaded = async () => {
      if (!active || decoding || decoded || !original.naturalWidth) return;
      decoding = true;
      try {
        await original.decode();
        if (!active) return;
        decoded = true;
        observer?.disconnect();
        setReady(true);
        if (original.naturalWidth > 0 && original.naturalHeight > 0)
          onDecoded({
            width: original.naturalWidth,
            height: original.naturalHeight,
          });
      } catch {
        // Keep the blur preview on original failure, including decode rejection.
      } finally {
        decoding = false;
      }
    };
    original.addEventListener("load", loaded);
    if (original.complete) void loaded();
    const preview = canvas.current;
    if (hash && preview && typeof IntersectionObserver !== "undefined") {
      // Original requests keep native loading="lazy". Only preview CPU work is
      // visibility-gated, including nonvirtualized thread rows. No new scheduler.
      observer = new IntersectionObserver((entries) => {
        if (
          !active ||
          decoded ||
          painted ||
          !entries.some((entry) => entry.isIntersecting)
        )
          return;
        observer?.disconnect();
        painted = true;
        paintBlurhash(preview, hash);
      });
      observer.observe(preview);
    }
    // Without IntersectionObserver, retain the old placeholder rather than
    // eagerly decode every mounted thread attachment.
    return () => {
      active = false;
      original.removeEventListener("load", loaded);
      observer?.disconnect();
      // Only a deleted row detaches its original; a rerun keeps it mounted.
      // Unparent it so the pool retains the element, not the deleted row, and
      // show it: the row can unmount before its ready state commits.
      if (session && decoded && !original.isConnected) {
        original.remove();
        original.style.visibility = "visible";
        retainDecodedImage(session, source, original, capture);
      }
    };
  }, [retained, session, source, hash, onDecoded]);
  if (retained) return <span ref={host} />;
  return (
    <>
      {hash && !ready && (
        <canvas
          ref={canvas}
          width={BLURHASH_SIZE}
          height={BLURHASH_SIZE}
          tabIndex={-1}
          aria-hidden="true"
        />
      )}
      <img
        ref={image}
        src={source}
        alt=""
        loading="lazy"
        style={{ visibility: ready ? "visible" : "hidden" }}
      />
      {/* After the original, so preview queries still find the original first. */}
      {thumbnail && !ready && (
        <img
          src={thumbnail}
          alt=""
          loading="lazy"
          data-thumbnail=""
          style={{ visibility: thumbnailLoaded ? "visible" : "hidden" }}
          onLoad={() => setThumbnailLoaded(true)}
        />
      )}
    </>
  );
}
