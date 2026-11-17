import { useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons";
import { useModalBoundary } from "./useModalBoundary";
import { MediaActionAnnouncements } from "./MediaActionAnnouncements";
import {
  type readReviewOrigin,
  useReviewEntrance,
} from "./use-review-entrance";
import { seekVideoBy } from "./use-video-gestures";
import styles from "./Messages.module.css";

/** Shared fullscreen surface for sent media and local composer previews. */
export function MediaReviewFrame({
  title,
  label,
  isVideo,
  video,
  frame,
  origin,
  canReturnToOrigin = true,
  returnOrigin,
  commentsOpen = false,
  commentsMotion = false,
  actions,
  navigate,
  children,
  sidebar,
  restoreFocus,
  close,
}: {
  title: string;
  label: string;
  isVideo: boolean;
  video: RefObject<HTMLVideoElement | null>;
  frame: RefObject<HTMLElement | null>;
  origin: ReturnType<typeof readReviewOrigin>;
  canReturnToOrigin?: boolean;
  returnOrigin?: (() => ReturnType<typeof readReviewOrigin>) | undefined;
  commentsOpen?: boolean;
  commentsMotion?: boolean;
  actions?: ReactNode;
  navigate?: ((direction: -1 | 1) => void) | undefined;
  children: ReactNode;
  sidebar?: ReactNode;
  restoreFocus?: RefObject<HTMLElement | null> | undefined;
  close(): void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const { dismiss } = useReviewEntrance(
    frame,
    origin,
    close,
    canReturnToOrigin,
    returnOrigin,
  );
  useModalBoundary(backdrop, frame, close, restoreFocus);
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal complements the close button and Escape shortcut.
    <div
      ref={backdrop}
      className={`${styles.mediaReviewBackdrop} ${styles.darkReviewBackdrop}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget)
          dismiss(true);
      }}
    >
      <div
        className={styles.mediaReviewScrim}
        data-review-backdrop=""
        aria-hidden="true"
      />
      <section
        ref={frame}
        className={styles.mediaReviewViewer}
        data-review-pending={origin ? "" : undefined}
        data-video={isVideo || undefined}
        data-comments-motion={commentsMotion || undefined}
        data-comments-hidden={!commentsOpen || undefined}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        onKeyDown={(event) => {
          if (
            event.currentTarget.hasAttribute("data-review-closing") ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            (event.key !== "ArrowLeft" &&
              event.key !== "ArrowRight" &&
              event.key !== " ")
          )
            return;
          const target = event.target;
          if (
            !(target instanceof Element) ||
            !event.currentTarget.contains(target) ||
            target.closest(
              'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="menu"], [role="listbox"], [aria-label="Media comments"], [aria-label="Playback speed"]',
            )
          )
            return;
          if (
            navigate &&
            event.key !== " " &&
            !target.closest("[data-video-controls]")
          ) {
            event.preventDefault();
            event.stopPropagation();
            navigate(event.key === "ArrowRight" ? 1 : -1);
            return;
          }
          if (!isVideo || !video.current) return;
          if (event.key === " ") {
            // Space still activates a deliberately focused control normally.
            if (
              target.closest(
                'button, a[href], [role="button"], [role="checkbox"], [role="switch"]',
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat) return;
            if (video.current.paused) void video.current.play().catch(() => {});
            else video.current.pause();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          seekVideoBy(video.current, event.key === "ArrowRight" ? 10 : -10);
        }}
        aria-label={label}
      >
        <div
          className={styles.mediaReviewHeading}
          title={title}
          data-review-chrome=""
          data-tauri-drag-region
        >
          <PanelHeader
            title={<PanelHeaderLabel title={title} />}
            actions={
              <>
                {actions}
                <IconButton
                  size="compact"
                  type="button"
                  aria-label="Close fullscreen viewer"
                  data-review-dismiss=""
                  onClick={(event) => dismiss(event.detail > 0)}
                  icon={<XIcon size={20} aria-hidden="true" />}
                />
              </>
            }
          />
        </div>
        <div
          className={`${styles.mediaReviewStage} dark`}
          data-color-mode="dark"
          data-review-stage=""
        >
          <MediaActionAnnouncements>{children}</MediaActionAnnouncements>
        </div>
        {sidebar}
      </section>
    </div>,
    document.body,
  );
}
