import { Button } from "../../shared/design-system/ui/Button";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import styles from "./Channels.module.css";

type UnreadSnapshot = ReturnType<RelaySession["unread"]["snapshot"]>;

/** What the channel's row shows: opening it quiets the row (`row`) while
 * its messages and threads stay unread elsewhere. */
const shown = (snapshot: UnreadSnapshot) => snapshot.row ?? snapshot;

/** Bold tracks ordinary backlog; protected attention has its own dot. */
export function ordinaryUnread(
  snapshot: UnreadSnapshot,
  dm: boolean,
  muted = false,
) {
  const { observedCount, attentionCount } = shown(snapshot);
  const count = observedCount ?? 0;
  return (
    snapshot.manual !== "none" ||
    (!muted && (dm ? count > 0 : count > (attentionCount ?? 0)))
  );
}

/** Observe only confirmed preferences; optimistic menu intents do not quiet unread. */
export function useConfirmedMute(session: RelaySession, channelId: string) {
  const get = useCallback(() => {
    const snapshot = session.sidebarPreferences.snapshot();
    return !snapshot.cached && !!snapshot.data?.muted.includes(channelId);
  }, [session, channelId]);
  return useSyncExternalStore(session.sidebarPreferences.subscribe, get, get);
}

/** Unread evidence for one channel's badge. */
export function useUnreadState(
  session: RelaySession,
  channelId: string,
  dm: boolean,
) {
  const target = useMemo(
    () => ({ kind: "channel" as const, channelId }),
    [channelId],
  );
  const subscribe = useCallback(
    (listener: () => void) => session.unread.subscribe(target, listener),
    [session, target],
  );
  const get = useCallback(
    () => session.unread.snapshot(target),
    [session, target],
  );
  const subscribeActivity = useCallback(
    (listener: () => void) =>
      session.unread.subscribeActivity(channelId, listener),
    [session, channelId],
  );
  const getActivity = useCallback(
    () => session.unread.activity(channelId),
    [session, channelId],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const activity = useSyncExternalStore(
    subscribeActivity,
    getActivity,
    getActivity,
  );
  const muted = useConfirmedMute(session, channelId);
  const { observedCount: count, attentionCount } = shown(snapshot);
  const manual = snapshot.manual !== "none";
  const unread =
    manual || ((count ?? 0) > 0 && (dm || !muted || (attentionCount ?? 0) > 0));
  const ordinary = ordinaryUnread(snapshot, dm, muted);
  const threadCount = snapshot.row?.threadCount ?? activity.items?.length ?? 0;
  return {
    snapshot,
    activity,
    count,
    attentionCount,
    manual,
    unread,
    ordinary,
    threadCount,
    muted,
  };
}

export function UnreadBadge({
  session,
  channelId,
  dm = false,
  label,
  labelUnread = "ordinary",
  preserveUnread = false,
}: {
  session: RelaySession;
  channelId: string;
  dm?: boolean;
  label?: ReactNode;
  /** Solo labels emphasize every unread message, so attention adds no dot. */
  labelUnread?: "ordinary" | "all";
  /** Preserve observed evidence for Solo destinations with their own labels. */
  preserveUnread?: boolean;
}) {
  const {
    snapshot,
    activity,
    count,
    manual,
    attentionCount,
    unread: quietUnread,
    ordinary,
    threadCount,
    muted,
  } = useUnreadState(session, channelId, dm);
  const unread =
    labelUnread === "all" || preserveUnread
      ? manual || (count ?? 0) > 0
      : quietUnread;
  const hideUnreadDots = muted && labelUnread === "ordinary" && !preserveUnread;
  if (!unread && !threadCount && label === undefined) return null;
  const priority = dm || (attentionCount ?? 0) > 0;
  const showUnreadDot =
    !hideUnreadDots &&
    priority &&
    threadCount === 0 &&
    labelUnread === "ordinary";
  const unreadLabel = manual
    ? `Marked unread${snapshot.manual === "local-only" ? " on this device only" : ""}`
    : `${count} observed unread messages${snapshot.freshness === "stale" ? "; may be out of date" : ""}. Not an exact total.`;
  const mentionCount = activity.mentions?.length ?? 0;
  const stale = activity.freshness === "stale" ? "; may be out of date" : "";
  const mentionLabel = `${mentionCount} unread ${mentionCount === 1 ? "mention" : "mentions"}`;
  // Mentions share the thread dot. Without a thread they have only the
  // aria-hidden priority dot, or none when muted, so name them on their own.
  const activityLabel = `${mentionCount ? `${mentionLabel}, ` : ""}${threadCount} unread ${threadCount === 1 ? "thread" : "threads"}${stale}`;
  return (
    <>
      {label !== undefined && (
        <span
          data-channel-unread-title={
            (labelUnread === "all" ? unread : ordinary) || undefined
          }
        >
          {label}
        </span>
      )}
      {unread && (
        <span
          className={styles.unreadState}
          data-channel-unread=""
          data-channel-muted={muted || undefined}
          data-priority={priority}
          role="img"
          aria-label={unreadLabel}
        />
      )}
      {showUnreadDot && (
        <span
          className={styles.priorityDot}
          data-channel-priority=""
          data-indicator-layer="unread"
          aria-hidden="true"
        />
      )}
      {mentionCount > 0 && threadCount === 0 && (
        <span className="sr-only">{`${mentionLabel}${stale}`}</span>
      )}
      {threadCount > 0 &&
        (hideUnreadDots ? (
          <span className="sr-only">{activityLabel}</span>
        ) : (
          <span
            className={styles.threadActivityDot}
            data-channel-activity=""
            data-channel-muted={muted || undefined}
            role="img"
            aria-label={activityLabel}
            title={activityLabel}
          />
        ))}
    </>
  );
}
export function UnreadOptions({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId?: string | undefined;
}) {
  const sync = useSyncExternalStore(
    session.unread.subscribeSync,
    session.unread.sync,
    session.unread.sync,
  );
  const [error, setError] = useState<string>();
  const run = (operation: Promise<unknown>) => {
    setError(undefined);
    void operation.catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : "Read-state operation failed",
      ),
    );
  };
  return (
    <>
      {channelId && (
        <Button
          type="button"
          onClick={() =>
            run(session.unread.markUnreadLocal({ kind: "channel", channelId }))
          }
        >
          Mark unread on this device
        </Button>
      )}
      {channelId && sync.capability === "frontier-sync" && (
        <Button
          type="button"
          onClick={() => {
            const last = session.channels
              .window(channelId)
              .rows.filter((row) => !row.membership && !row.huddle)
              .at(-1);
            if (last)
              run(
                session.unread.markThrough(
                  { kind: "channel", channelId },
                  last.id,
                ),
              );
            else setError("Load a verified message before marking through it.");
          }}
        >
          Mark read through loaded messages
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Unread status</summary>
        <p>
          Observed messages only—not exact totals. Manual unread is local to
          this device. Older read hints can expire; this is not an everlasting
          read receipt log.
        </p>
        <p>
          Read sync: {sync.capability} · {sync.status}
        </p>
        {sync.error && <p role="alert">{sync.error}</p>}
        <Button type="button" onClick={() => run(session.unread.refresh())}>
          Refresh unread observations
        </Button>
        {sync.capability === "frontier-sync" && (
          <Button type="button" onClick={() => run(session.unread.retrySync())}>
            Retry read sync
          </Button>
        )}
      </details>
    </>
  );
}
