import type {
  AttachmentRenderer,
  ContributionReader,
} from "../conversation/contracts";
import { AttachmentView } from "../conversation/AttachmentView";
import { AttachmentDownloadContext } from "./AttachmentDownloadContext";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { useRef, useState } from "react";
import { FileTypeIcon } from "./FileTypeIcon";
import fileIconStyles from "./FileTypeIcon.module.css";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { prepareReviewEntrance } from "./use-review-entrance";
import { ComposerAttachmentViewer } from "./ComposerAttachmentViewer";
import {
  draftAttachmentMedia,
  useDraftAttachmentSource,
} from "./use-draft-attachment-source";
import { XIcon } from "../../shared/design-system/icons";
import type { DraftAttachment } from "./attachment-draft";
import styles from "./ComposerAttachments.module.css";
import { useMediaElementSource } from "./use-media-element-source";

/** A GIF staged with the draft. It sends as its Markdown, not as an upload. */
export type ComposerGif = Readonly<{
  markdown: string;
  title: string;
  source?: string | undefined;
}>;

export function ComposerAttachments({
  items,
  gifs = [],
  removeGif,
  renderers,
  disabled,
  remove,
  retry,
  media,
  onExitComplete,
}: {
  renderers?: ContributionReader<AttachmentRenderer> | undefined;
  media(url: string): string | undefined;
  items: readonly DraftAttachment[];
  gifs?: readonly ComposerGif[] | undefined;
  removeGif?(markdown: string): void;
  disabled: boolean;
  remove(id: string): void;
  retry(id: string): void;
  /** The section finished animating out after the last item was removed. */
  onExitComplete?: (() => void) | undefined;
}) {
  const active = useConversationPresentation();
  const mixed = items.some((item) => {
    const { image, video } = draftAttachmentMedia(item);
    return !image && !video;
  });
  const [selected, setSelected] = useState<string>();
  const restoreFocus = useRef<HTMLElement | null>(null);
  const reducedMotion = useReducedMotion();
  const instant =
    reducedMotion ||
    document.documentElement.hasAttribute("data-keyboard-navigation");
  // Items present when the composer mounts are a returning draft, not new picks.
  const shown = items.length + gifs.length > 0;
  const [restored, setRestored] = useState(shown);
  if (restored && !shown) setRestored(false);
  if (selected && (!active || !items.some((item) => item.id === selected)))
    setSelected(undefined);
  return (
    <>
      <AnimatePresence
        initial={false}
        {...(onExitComplete ? { onExitComplete } : {})}
      >
        {shown && (
          <motion.section
            key="attachments"
            aria-label="Attachments"
            className={styles.attachments}
            initial={instant ? false : { height: 0, overflow: "hidden" }}
            animate={{
              height: "auto",
              opacity: 1,
              transitionEnd: { overflow: "visible" },
            }}
            exit={{
              height: 0,
              opacity: 0,
              overflow: "hidden",
              transition: { duration: instant ? 0 : 0.15 },
            }}
            transition={{
              duration: instant ? 0 : 0.22,
              ease: [0.23, 1, 0.32, 1],
            }}
          >
            <ul
              className={`${styles.list} buzz-thin-scrollbar`}
              data-compact-media={mixed || undefined}
            >
              <AnimatePresence initial={!instant && !restored} propagate>
                {/* GIFs precede uploads in the sent message, so here as well. */}
                {gifs.map((gif) => (
                  <GifItem
                    key={gif.markdown}
                    gif={gif}
                    disabled={disabled}
                    remove={() => removeGif?.(gif.markdown)}
                  />
                ))}
                {items.map((item) => (
                  <AttachmentItem
                    renderers={renderers}
                    media={media}
                    key={item.id}
                    item={item}
                    disabled={disabled}
                    remove={remove}
                    retry={retry}
                    preview={(trigger) => {
                      restoreFocus.current = trigger;
                      setSelected(item.id);
                    }}
                  />
                ))}
              </AnimatePresence>
            </ul>
          </motion.section>
        )}
      </AnimatePresence>
      {active && selected && (
        <ComposerAttachmentViewer
          items={items}
          selected={selected}
          select={setSelected}
          media={media}
          renderers={renderers}
          restoreFocus={restoreFocus}
          close={() => setSelected(undefined)}
        />
      )}
    </>
  );
}

function useItemAppearance() {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const instant =
    reducedMotion ||
    document.documentElement.hasAttribute("data-keyboard-navigation");
  return {
    instant,
    appearance: {
      initial: instant
        ? (false as const)
        : { opacity: 0, transform: "translateY(6px)" },
      animate: { opacity: 1, transform: "translateY(0px)" },
      exit: {
        opacity: 0,
        transform: instant ? "translateY(0px)" : "translateY(6px)",
        transition: { duration: instant ? 0 : 0.15 },
      },
      transition: {
        duration: instant ? 0 : 0.22,
        ease: [0.23, 1, 0.32, 1] as const,
        opacity: { duration: instant ? 0 : 0.15 },
      },
      inert: !present,
      "aria-hidden": !present || undefined,
    },
  };
}

function GifItem({
  gif,
  disabled,
  remove,
}: {
  gif: ComposerGif;
  disabled: boolean;
  remove(): void;
}) {
  const { instant, appearance } = useItemAppearance();
  const [failed, setFailed] = useState<string>();
  const source = gif.source && failed !== gif.source ? gif.source : undefined;
  return (
    <motion.li
      layout={!instant}
      {...appearance}
      className={styles.item}
      data-media={source ? "" : undefined}
    >
      {source ? (
        <span className={styles.preview}>
          <img src={source} alt="" onError={() => setFailed(source)} />
        </span>
      ) : (
        <span className={fileIconStyles.slot}>
          <FileTypeIcon name={`${gif.title}.gif`} mime="image/gif" />
        </span>
      )}
      <div className={styles.details}>
        <span className={styles.name}>{gif.title}</span>
        <span className={styles.hint}>GIF</span>
      </div>
      <div className={styles.actions} data-remove="">
        <IconButton
          size="xs"
          shape="round"
          variant="media"
          type="button"
          disabled={disabled}
          data-remove-action=""
          aria-label={`Remove ${gif.title}`}
          onClick={remove}
          icon={<XIcon size={16} />}
        />
      </div>
    </motion.li>
  );
}

function AttachmentItem({
  item,
  renderers,
  disabled,
  remove,
  retry,
  media,
  preview,
}: {
  preview(trigger: HTMLButtonElement): void;
  renderers?: ContributionReader<AttachmentRenderer> | undefined;
  media(url: string): string | undefined;
  item: DraftAttachment;
  disabled: boolean;
  remove(id: string): void;
  retry(id: string): void;
}) {
  const { instant, appearance } = useItemAppearance();
  const { source, image, video } = useDraftAttachmentSource(item, media);
  const previewButton = useRef<HTMLButtonElement>(null);
  const [failedSource, setFailedSource] = useState<string>();
  const element = useMediaElementSource(video ? source : undefined);
  const videoSource = element.src;
  const failed = !!source && (failedSource === source || element.unavailable);
  // A finished upload swaps in the sent copy. Keep the current thumbnail until
  // that copy has loaded so the swap never shows a blank frame.
  const [shown, setShown] = useState(source);
  const incoming = image && source !== shown ? source : undefined;
  const bytes = item.uploaded?.size ?? item.file.size;
  const size =
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const uploadFailed = item.status === "error";
  const status = {
    queued: "Queued",
    preparing: "Preparing…",
    uploading: "Uploading…",
    ready: "Ready",
    error: "Upload failed",
  }[item.status];
  // Preparation has no byte total; transfer progress comes from the host.
  const busy =
    item.status === "queued" ||
    item.status === "preparing" ||
    item.status === "uploading";
  if (item.voice && source && renderers)
    return (
      <motion.li {...appearance} className={styles.voiceItem} data-voice-draft>
        <AttachmentDownloadContext value={false}>
          <AttachmentView
            registry={renderers}
            attachment={{
              url: item.uploaded?.url ?? source,
              kind: "audio",
              mime: item.uploaded?.type ?? item.file.type,
              name: item.uploaded?.name ?? item.file.name,
              voiceNote: true,
              ...item.voice,
            }}
            source={source}
            placement="composer"
            onRemove={disabled ? undefined : () => remove(item.id)}
            fallback={
              <div>
                <span>{item.file.name}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => remove(item.id)}
                >
                  Remove voice note
                </button>
              </div>
            }
          />
        </AttachmentDownloadContext>
        {item.error && (
          <>
            <span role="alert">{item.error}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => retry(item.id)}
            >
              Retry voice note upload
            </button>
          </>
        )}
      </motion.li>
    );
  return (
    <motion.li
      layout={!instant}
      {...appearance}
      className={styles.item}
      data-media={!uploadFailed && (image || video) ? "" : undefined}
      data-upload-error={uploadFailed || undefined}
    >
      {source && !failed && (image || video) ? (
        <button
          ref={previewButton}
          data-media-preview=""
          data-draft-preview={item.id}
          className={styles.preview}
          type="button"
          aria-label={`Preview ${item.file.name}`}
          onClick={(event) => {
            prepareReviewEntrance(event);
            preview(event.currentTarget);
          }}
        >
          {image ? (
            <>
              {shown && (
                <img
                  key={shown}
                  src={shown}
                  alt=""
                  onError={() => setFailedSource(shown)}
                />
              )}
              {incoming && (
                <img
                  key={incoming}
                  src={incoming}
                  alt=""
                  onLoad={() => setShown(incoming)}
                  onError={() => {
                    setShown(incoming);
                    setFailedSource(incoming);
                  }}
                />
              )}
            </>
          ) : (
            // Not `muted`: this still preview never plays. WebKitGTK stops a
            // muted video's pipeline whenever it leaves the viewport and
            // reloads it on return. A stop during that reload can deadlock
            // the page (MediaPlayerPrivateGStreamer::managePlayerSuspend).
            // biome-ignore lint/a11y/useMediaCaption: silent still preview that never plays.
            <video
              key={source}
              src={videoSource}
              playsInline
              preload="metadata"
              onError={() => setFailedSource(source)}
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime = Math.min(
                  0.1,
                  event.currentTarget.duration || 0.1,
                );
              }}
            />
          )}
        </button>
      ) : (
        <span className={fileIconStyles.slot}>
          <IconButton
            type="button"
            variant="bare"
            size="compact"
            style={{ width: "100%", height: "100%", borderRadius: "inherit" }}
            ref={previewButton}
            data-draft-preview={item.id}
            aria-label={`Preview ${item.file.name}`}
            onClick={(event) => preview(event.currentTarget)}
            icon={<FileTypeIcon name={item.file.name} mime={item.file.type} />}
          />
        </span>
      )}
      <div className={styles.details}>
        <span className={styles.name} tabIndex={source && !failed ? -1 : 0}>
          {item.file.name}
        </span>
        <span
          className={styles.hint}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="sr-only">{item.file.name}: </span>
          {uploadFailed ? size : `${size} · ${status}`}
        </span>
        {failed && <span className="sr-only">Preview unavailable</span>}
      </div>
      {uploadFailed && (
        <p className={styles.error} role="alert">
          <span className="sr-only">{item.file.name}: </span>
          {item.error || "Upload failed. Retry or remove it to send."}
        </p>
      )}
      <div
        className={styles.actions}
        data-remove={!busy && !uploadFailed ? "" : undefined}
      >
        {uploadFailed ? (
          <>
            <Button
              size="sm"
              disabled={disabled}
              aria-label={`Retry ${item.file.name}`}
              onClick={(event) => {
                // Retry replaces this control. Hand off only focus that it owns.
                if (document.activeElement === event.currentTarget)
                  previewButton.current?.focus();
                retry(item.id);
              }}
            >
              Retry
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              aria-label={`Remove ${item.file.name}`}
              onClick={() => remove(item.id)}
            >
              Remove
            </Button>
          </>
        ) : (
          <IconButton
            size="xs"
            shape="round"
            variant="media"
            type="button"
            disabled={disabled}
            data-remove-action={!busy ? "" : undefined}
            aria-label={`Remove ${item.file.name}`}
            title={busy ? "Cancel upload and remove attachment" : undefined}
            onClick={() => remove(item.id)}
            icon={
              busy ? (
                <span className={styles.uploadControl}>
                  <span
                    className={styles.progress}
                    role="progressbar"
                    aria-label={`${item.status === "queued" ? "Queued" : "Uploading"} ${item.file.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={
                      item.transfer
                        ? Math.round(
                            (item.transfer.sent / item.transfer.total) * 100,
                          )
                        : undefined
                    }
                    aria-valuetext={
                      item.transfer
                        ? item.transfer.sent === item.transfer.total
                          ? "Transfer complete; waiting for server confirmation"
                          : undefined
                        : item.status === "queued"
                          ? "Queued"
                          : "Preparing upload"
                    }
                  >
                    <svg
                      key={item.transfer ? "transfer" : "preparation"}
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      className={!item.transfer ? styles.preparing : undefined}
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="9"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        opacity="0.5"
                      />
                      <circle
                        data-upload-progress=""
                        className={styles.progressArc}
                        cx="12"
                        cy="12"
                        r="9"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        pathLength="100"
                        strokeDasharray={`${item.transfer ? (item.transfer.sent / item.transfer.total) * 100 : 25} 100`}
                        transform="rotate(-90 12 12)"
                      />
                    </svg>
                  </span>
                  <XIcon
                    size={16}
                    className={styles.uploadRemove}
                    data-upload-cancel=""
                  />
                </span>
              ) : (
                <XIcon size={16} />
              )
            }
          />
        )}
      </div>
    </motion.li>
  );
}
