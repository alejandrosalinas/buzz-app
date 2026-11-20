import { useId, type ReactNode } from "react";
import styles from "./ChannelStateNotice.module.css";

/** The pane's one live region for channel state. It stays mounted, so a
 * notice that appears while a channel is open, such as losing membership,
 * lands in an existing status and is announced; a status mounted with its
 * content may not be. */
export function ChannelStateRegion({ children }: { children?: ReactNode }) {
  return (
    <div role="status" className={styles.region}>
      {children}
    </div>
  );
}

/** A lasting state of the open channel, named above the history it affects.
 * Render it inside `ChannelStateRegion`, which announces it. */
export function ChannelStateNotice({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string | undefined;
  /** At most one small action. */
  children?: ReactNode;
}) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className={styles.notice}>
      <div className={styles.message}>
        <p id={heading} className="text-label-sm">
          {title}
        </p>
        {detail && <p className="text-body-sm text-subtle">{detail}</p>}
      </div>
      {children}
    </section>
  );
}
