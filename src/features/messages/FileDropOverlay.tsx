import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { CloudUploadIcon } from "../../shared/design-system/icons";
import styles from "./Messages.module.css";

/** The existing nearest-pane drop owner also owns its visible affordance. */
export function FileDropOverlay({
  composer,
}: {
  composer: RefObject<HTMLFormElement | null>;
}) {
  const zone =
    composer.current?.closest<HTMLElement>("[data-attachment-drop-zone]") ??
    composer.current;
  return zone
    ? createPortal(
        // The frame leaves the pane readable, so a thread summary under the
        // drag can still be found and seen to spring open.
        <div className={styles.fileDropOverlay} role="status">
          <span className={styles.fileDropBadge}>
            <CloudUploadIcon size={16} />
            Drop files into this conversation
          </span>
        </div>,
        zone,
      )
    : null;
}
