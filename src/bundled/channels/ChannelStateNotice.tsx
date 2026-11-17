import { useId, type ReactNode } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { Button } from "../../shared/design-system/ui/Button";
import { useLifecycleOffer, type LifecycleSession } from "./useLifecycleOffer";
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

/** A lasting state of the open channel, named at the top of its pane, above
 * the history it affects. The lower composer notice says what that state does
 * to writing; this one says what the channel is and what can change it.
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

/** Archived channels stay readable; owners and admins can restore them here.
 * The offer comes from live channel state; confirmation rechecks the relay. */
export function ArchivedChannelNotice({
  channel,
  session,
  unarchive,
}: {
  channel: ChannelSummary;
  session: LifecycleSession;
  unarchive(trigger: HTMLElement): void;
}) {
  const offer = useLifecycleOffer(session, channel);
  // A preview reader never had it in their sidebar. Cached membership and
  // guests are members, so readOnly alone does not mean a preview.
  const preview =
    channel.readOnly && !channel.cached && channel.viewerRole !== "guest";
  return (
    <ChannelStateNotice
      title="Archived · view only"
      detail={
        preview
          ? undefined
          : "It’s hidden from the sidebar until it’s unarchived."
      }
    >
      {offer?.canUnarchive && session.channelLifecycle.available && (
        <Button
          type="button"
          size="sm"
          onClick={(event) => unarchive(event.currentTarget)}
        >
          Unarchive
        </Button>
      )}
    </ChannelStateNotice>
  );
}
