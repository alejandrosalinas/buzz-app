import { useId, useLayoutEffect, useRef } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { ComposerSession } from "./composer-session";
import {
  cancelBackgroundUpload,
  dismissBackgroundUploadNotice,
  useBackgroundUploads,
} from "./background-upload";
import styles from "./Messages.module.css";

/** Desktop's composer upload pill and failure toasts, for this session's sends. */
export function BackgroundUploadStatus({
  session,
  focusTarget,
  here,
  onOpenLink,
}: {
  session: ComposerSession;
  focusTarget: React.RefObject<HTMLElement | null>;
  /** The conversation the hosting composer presents, which a notice need not
   * open. Absent while a covered tab hides it. */
  here?: string | undefined;
  /** The hosting composer's link handler opens a notice's conversation. */
  onOpenLink?: ((target: string) => boolean) | undefined;
}) {
  const uploads = useBackgroundUploads(session);
  const focusedCancel = useRef(false);
  const phase = useId();
  useLayoutEffect(() => {
    if (uploads.uploading || !focusedCancel.current) return;
    focusedCancel.current = false;
    const target = focusTarget.current;
    if (
      document.activeElement === document.body &&
      target?.isConnected &&
      !target.closest("[inert]") &&
      !target.hasAttribute("disabled")
    )
      target.focus();
  }, [uploads.uploading, focusTarget]);
  return (
    <>
      {uploads.destination && (
        <div className={styles.backgroundUpload}>
          {/* The text takes the spare width, so the bar and Cancel stay put
              as it changes. */}
          <span id={phase} role="status" className="min-w-0 flex-1 truncate">
            {`${uploads.phase} to ${uploads.destination.name}`}
            {uploads.others > 0 && ` and ${uploads.others} more`}
          </span>
          {/* Desktop's bar: measured bytes, or an indeterminate sweep while
              the host reports none. It never shows a number. */}
          <div
            aria-labelledby={phase}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={
              uploads.progress === null
                ? undefined
                : Math.round(uploads.progress * 100)
            }
            className={styles.backgroundUploadBar}
            role="progressbar"
          >
            <div
              className={
                uploads.progress === null
                  ? styles.backgroundUploadSweep
                  : styles.backgroundUploadFill
              }
              style={
                uploads.progress === null
                  ? undefined
                  : { transform: `scaleX(${uploads.progress})` }
              }
            />
          </div>
          <Button
            onFocus={() => {
              focusedCancel.current = true;
            }}
            onBlur={(event) => {
              // A real move away relinquishes ownership; removal of the
              // focused control does not dispatch blur.
              if (
                event.relatedTarget ||
                document.activeElement === document.body
              )
                focusedCancel.current = false;
            }}
            size="sm"
            variant="ghost"
            aria-label={`Cancel upload to ${uploads.destination.name}`}
            // Pressing Cancel can disable it; focus stays for the handoff above.
            disabled={!uploads.cancellable}
            focusableWhenDisabled
            onClick={() => cancelBackgroundUpload(session)}
          >
            Cancel
          </Button>
        </div>
      )}
      {uploads.notices.map((notice) => {
        const dismiss = () => dismissBackgroundUploadNotice(session, notice.id);
        const { link } = notice.destination;
        return (
          <ToastNotice
            key={notice.id}
            title={notice.title}
            {...(notice.description && { description: notice.description })}
            {...(!notice.retry && { onDismiss: dismiss })}
          >
            {notice.retry && (
              <Button type="button" onClick={notice.retry}>
                Retry failed send recovery
              </Button>
            )}
            {onOpenLink && link && link !== here && (
              <Button
                type="button"
                onClick={() => {
                  // Opening answers a failure; recovery stays until it succeeds.
                  if (onOpenLink(link) && !notice.retry) dismiss();
                }}
              >
                {`Open ${notice.destination.name}`}
              </Button>
            )}
          </ToastNotice>
        );
      })}
    </>
  );
}
