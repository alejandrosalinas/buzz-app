import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { galleryMotion } from "./use-image-gallery-motion";
import { useRef, useState, useLayoutEffect, type RefObject } from "react";
import { MediaReviewFrame } from "./MediaReviewFrame";
import { ImageReviewStage } from "./ImageReviewStage";
import { useMediaElementSource } from "./use-media-element-source";
import { VideoPlayer } from "./VideoPlayer";
import { AudioAttachment } from "./AudioAttachment";
import { FileAttachment } from "./FileAttachment";
import { AttachmentView } from "../conversation/AttachmentView";
import { AttachmentDownloadContext } from "./AttachmentDownloadContext";
import type {
  AttachmentRenderer,
  ContributionReader,
} from "../conversation/contracts";
import type { Attachment } from "../relay/contracts";
import type { DraftAttachment } from "./attachment-draft";
import {
  draftAttachmentMedia,
  useDraftAttachmentSource,
} from "./use-draft-attachment-source";
import { readReviewOrigin } from "./use-review-entrance";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  CaretLeftIcon,
  CaretRightIcon,
} from "../../shared/design-system/icons";
import styles from "./Messages.module.css";

export function ComposerAttachmentViewer({
  items,
  selected,
  select,
  media,
  renderers,
  restoreFocus,
  close,
}: {
  items: readonly DraftAttachment[];
  selected: string;
  select(id: string): void;
  media(url: string): string | undefined;
  renderers?: ContributionReader<AttachmentRenderer> | undefined;
  restoreFocus: RefObject<HTMLElement | null>;
  close(): void;
}) {
  const index = items.findIndex((item) => item.id === selected);
  const item = items[index];
  const frame = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [origin] = useState(() => readReviewOrigin(restoreFocus.current));
  const [initial] = useState(selected);
  const [previewList] = useState(() => restoreFocus.current?.closest("ul"));
  const [initialSource] = useState(
    () =>
      restoreFocus.current?.querySelector<HTMLImageElement | HTMLVideoElement>(
        "img, video",
      )?.src,
  );
  const selectedPreview = () =>
    Array.from(
      previewList?.querySelectorAll<HTMLButtonElement>(
        "[data-draft-preview]",
      ) ?? [],
    ).find((button) => button.dataset.draftPreview === selected);
  const returnOrigin = () => {
    const button = selectedPreview();
    if (!button || !previewList) return undefined;
    const bounds = button.getBoundingClientRect();
    const visible = previewList.getBoundingClientRect();
    if (
      bounds.left < visible.left ||
      bounds.right > visible.right ||
      bounds.top < visible.top ||
      bounds.bottom > visible.bottom
    )
      return undefined;
    button.dataset.reviewMotion = "pointer";
    return readReviewOrigin(button);
  };
  const [direction, setDirection] = useState(1);
  const instant = useReducedMotion();
  if (!item) return null;
  const { video: isVideo } = draftAttachmentMedia(item);
  const navigate = (direction: -1 | 1) => {
    const next = items[index + direction];
    if (!next) return;
    const target = Array.from(
      previewList?.querySelectorAll<HTMLButtonElement>(
        "[data-draft-preview]",
      ) ?? [],
    ).find((button) => button.dataset.draftPreview === next.id);
    if (target) restoreFocus.current = target;
    setDirection(direction);
    frame.current?.focus({ preventScroll: true });
    select(next.id);
  };
  return (
    <MediaReviewFrame
      title={item.file.name}
      label="Attachment preview"
      isVideo={isVideo}
      video={video}
      frame={frame}
      origin={origin}
      returnOrigin={returnOrigin}
      restoreFocus={restoreFocus}
      close={close}
      navigate={items.length > 1 ? navigate : undefined}
      actions={
        items.length > 1 && (
          <>
            <IconButton
              size="compact"
              aria-label="Previous attachment"
              disabled={index === 0}
              onClick={() => navigate(-1)}
              icon={<CaretLeftIcon size={20} />}
            />
            <span aria-live="polite">
              {index + 1} / {items.length}
            </span>
            <IconButton
              size="compact"
              aria-label="Next attachment"
              disabled={index === items.length - 1}
              onClick={() => navigate(1)}
              icon={<CaretRightIcon size={20} />}
            />
          </>
        )
      }
    >
      <AnimatePresence initial={false} custom={direction}>
        <motion.div
          key={item.id}
          className={styles.draftMediaSlide}
          custom={direction}
          variants={{
            enter: (direction: number) => ({
              x: instant ? 0 : direction * galleryMotion.distance,
              opacity: instant ? 1 : 0,
            }),
            exit: (direction: number) => ({
              x: instant ? 0 : -direction * galleryMotion.distance,
              opacity: 0,
            }),
          }}
          initial="enter"
          animate={{ x: 0, opacity: 1 }}
          exit="exit"
          transition={{
            duration: instant ? 0 : galleryMotion.duration,
            ease: galleryMotion.ease,
          }}
        >
          <DraftSlide
            item={item}
            initialSource={initial === selected ? initialSource : undefined}
            media={media}
            renderers={renderers}
            video={video}
          />
        </motion.div>
      </AnimatePresence>
    </MediaReviewFrame>
  );
}

function DraftSlide(props: Parameters<typeof DraftMedia>[0]) {
  const present = useIsPresent();
  const localVideo = useRef<HTMLVideoElement>(null);
  useLayoutEffect(() => {
    const element = localVideo.current;
    if (present) props.video.current = element;
    else element?.pause();
    return () => {
      if (props.video.current === element) props.video.current = null;
    };
  }, [present, props.video]);
  return (
    <div
      className={styles.draftMediaContent}
      inert={!present}
      aria-hidden={!present || undefined}
    >
      <DraftMedia
        {...props}
        video={localVideo}
        activeVideo={present ? props.video : undefined}
      />
    </div>
  );
}

function DraftMedia({
  item,
  media,
  renderers,
  video,
  activeVideo,
  initialSource,
}: {
  item: DraftAttachment;
  media(url: string): string | undefined;
  renderers?: ContributionReader<AttachmentRenderer> | undefined;
  video: RefObject<HTMLVideoElement | null>;
  activeVideo?: RefObject<HTMLVideoElement | null> | undefined;
  initialSource?: string | undefined;
}) {
  const [openedItem] = useState(item);
  const [failed, setFailed] = useState<string>();
  const openedMedia = draftAttachmentMedia(openedItem);
  // A mounted slide owns its local URL until it closes. Failed local decoding
  // can recover through the uploaded representation once it is available.
  const keepLocal =
    !openedItem.uploaded &&
    !failed &&
    (openedMedia.image ||
      openedMedia.video ||
      openedMedia.type.startsWith("audio/") ||
      !!openedItem.voice);
  const previewItem = keepLocal ? openedItem : item;
  const {
    source: resolvedSource,
    type,
    image,
    video: isVideo,
  } = useDraftAttachmentSource(previewItem, media);
  const source = previewItem.uploaded
    ? resolvedSource
    : (resolvedSource ?? initialSource);
  const sourceUnavailable = useMediaElementSource(
    isVideo ? source : undefined,
  ).unavailable;
  useLayoutEffect(() => {
    if (!activeVideo || !source) return;
    const element = video.current;
    activeVideo.current = element;
    return () => {
      if (activeVideo.current === element) activeVideo.current = null;
    };
  }, [source, activeVideo, video]);
  const attachment: Attachment = {
    url: previewItem.uploaded?.url ?? source ?? item.id,
    name: item.uploaded?.name ?? item.file.name,
    mime: type,
    size: item.uploaded?.size ?? item.file.size,
    kind: image
      ? "image"
      : isVideo
        ? "video"
        : type.startsWith("audio/")
          ? "audio"
          : "file",
    ...(item.voice ? { voiceNote: true, ...item.voice } : {}),
  };
  if (!source && attachment.kind === "file")
    return (
      <p className={styles.mediaReviewUnavailable}>
        {item.file.name}
        <br />
        No preview available for this file type.
      </p>
    );
  if (!source || sourceUnavailable || failed === source)
    return (
      <p className={styles.mediaReviewUnavailable} role="status">
        Preview unavailable
      </p>
    );
  if (image)
    return (
      <ImageReviewStage
        attachments={[attachment]}
        selectedUrl={attachment.url}
        select={() => {}}
        media={() => source}
        onOpenLink={() => false}
      />
    );
  if (isVideo)
    return (
      <VideoPlayer
        key={source}
        source={source}
        videoRef={video}
        onTime={() => {}}
        onError={() => setFailed(source)}
      />
    );
  const fallback =
    attachment.kind === "audio" ? (
      <AudioAttachment
        key={source}
        attachment={attachment}
        source={source}
        allowDownload={false}
      />
    ) : item.uploaded ? (
      <FileAttachment
        attachment={attachment}
        source={source}
        onOpenLink={() => false}
      />
    ) : (
      <p className={styles.mediaReviewUnavailable}>
        {item.file.name}
        <br />
        No preview available for this file type.
      </p>
    );
  return renderers ? (
    <AttachmentDownloadContext value={false}>
      <AttachmentView
        registry={renderers}
        attachment={attachment}
        source={source}
        placement="composer"
        FileCard={FileAttachment}
        fallback={fallback}
      />
    </AttachmentDownloadContext>
  ) : (
    fallback
  );
}
