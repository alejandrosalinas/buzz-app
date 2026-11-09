import {
  type FocusEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { useRecovery } from "../../features/relay/RecoveryNotice";
import { liveRecoveryStatus } from "../../features/relay/live-recovery";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./LiveStatus.module.css";

export function LiveStatus({
  live,
  channelId,
  partialRoster,
  diagnostics = false,
  recovery,
  onRecovered,
}: {
  live: RelaySession["live"];
  channelId: string | undefined;
  partialRoster: boolean;
  diagnostics?: boolean;
  /** The session recovery owner. While its notice shows, that notice is the
   * one report, so this status stays empty. */
  recovery?: RelaySession["recovery"];
  /** A retry control that had focus went away; move focus on. */
  onRecovered?: (() => void) | undefined;
}) {
  const { recovering: retrying, shown } = useRecovery(
    diagnostics ? undefined : recovery,
  );
  const focused = useRef(false);
  const snapshot = useSyncExternalStore(
    live.subscribe,
    live.snapshot,
    live.snapshot,
  );
  const route = channelId
    ? snapshot.routes.find((route) => route.channelId === channelId)
    : undefined;
  const head = snapshot.heads.find((head) => head.channelId === channelId);
  const globals = snapshot.routes.filter((route) => !route.channelId);
  const relevant = [...(route ? [route] : []), ...globals];
  const recovering = relevant.filter((route) => {
    const quota = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
      route.error ?? "",
    );
    return (
      snapshot.status === "connected" &&
      route.status === "pending" &&
      quota !== null &&
      Number(quota[1]) <= 60
    );
  });
  // Only bounded automatic WS quota recovery is quiet. Do not let it mask an
  // actionable failure in another route, connection, roster or finite head.
  const actionable = relevant.filter((route) => !recovering.includes(route));
  const routeError = actionable.find((route) => route.error)?.error;
  const error =
    snapshot.error ?? snapshot.roster.error ?? head?.error ?? routeError;
  const incompleteRoster =
    partialRoster && snapshot.roster.state === "verified";
  // An issue that is not one of the passive notices (capacity, partial roster).
  const blocking =
    ["unavailable", "retrying", "error"].includes(snapshot.status) ||
    (snapshot.error ?? snapshot.roster.error ?? head?.error) !== undefined ||
    actionable.some(
      (route) =>
        route.status === "error" ||
        (route.status !== "limited" && route.error !== undefined),
    ) ||
    head?.state === "error" ||
    ["error", "deferred"].includes(snapshot.roster.state);
  const issue =
    blocking ||
    actionable.some((route) => route.status === "limited") ||
    incompleteRoster;
  const reason = error?.includes("rate-limited: quota exceeded")
    ? "A relay request was rate-limited; recovery needs attention."
    : (error ??
      (incompleteRoster
        ? "Some channels are missing from the current roster."
        : ["error", "deferred"].includes(snapshot.roster.state)
          ? "Channel list needs refreshing."
          : "Live updates are unavailable."));
  const settled = liveRecoveryStatus(snapshot) === "settled";
  // Startup, bounded automatic quota recovery and recovery before its notice
  // delay do not need user attention.
  const quiet = !issue || (retrying && !settled);
  // What automatic recovery cannot change: capacity, a partial roster, a
  // denial or a sign-in failure. Capacity and a partial roster stay passive.
  // A failure that recovery skips keeps an explicit retry.
  const failed =
    !quiet &&
    settled &&
    (snapshot.status === "error" ||
      actionable.some((route) => route.status === "error") ||
      head?.state === "error" ||
      snapshot.roster.state === "error");
  // The live layer retries such a failure slowly on its own. Keep the notice,
  // its reason and its Retry while an attempt runs, so they do not vanish and
  // come back with every attempt or a routine roster or head refresh. The
  // hold ends once live state settles, or once this channel has neither a
  // blocking issue nor work in flight: unrelated work elsewhere must not keep
  // it, and a passive notice never offers Retry.
  const [held, setHeld] = useState<{ channelId?: string; reason: string }>();
  const attempting =
    snapshot.status === "connecting" ||
    snapshot.roster.state === "pending" ||
    head?.state === "pending" ||
    relevant.some((route) => route.status === "pending");
  const holding =
    !failed &&
    !settled &&
    (blocking || attempting) &&
    held !== undefined &&
    held.channelId === channelId;
  const keep = failed
    ? { ...(channelId ? { channelId } : {}), reason }
    : holding
      ? held
      : undefined;
  if (keep?.reason !== held?.reason || keep?.channelId !== held?.channelId)
    setHeld(keep);
  const manual = failed || holding;
  const control = diagnostics || shown || !manual ? undefined : "manual";
  // The control can go away while focused, by recovery or by an automatic
  // retry. A removed element does not always report blur, so check where
  // focus landed once the control changed.
  useEffect(() => {
    if (!focused.current) return;
    const active = document.activeElement;
    if (control && active && active !== document.body) return;
    focused.current = false;
    if (!active || active === document.body) onRecovered?.();
  }, [control, onRecovered]);
  const track = {
    onFocus: () => {
      focused.current = true;
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      focused.current = event.currentTarget.contains(
        event.relatedTarget as Node | null,
      );
    },
  };
  if (diagnostics) {
    const connecting =
      snapshot.status === "connecting" ||
      (channelId && route?.status !== "live") ||
      globals.some((route) => route.status === "pending");
    return (
      <>
        <p>
          Live updates:{" "}
          {issue
            ? reason
            : recovering.length
              ? "recovering automatically after rate limiting; awaiting confirmation"
              : connecting
                ? "connecting"
                : "stream established"}
        </p>
        {(error || recovering[0]?.error) && (
          <p>Last rejection: {error ?? recovering[0]?.error}</p>
        )}
      </>
    );
  }
  if (shown || (quiet && !holding)) return null;
  return (
    <section
      role="status"
      aria-label="Live updates limited"
      className={styles.recovery}
      {...track}
    >
      <div className={styles.message}>
        <p className="text-label-sm text-warning">Live updates limited</p>
        <p className="text-body-sm text-subtle">
          {issue ? reason : held?.reason} Only currently accessible messages
          remain readable.
        </p>
      </div>
      {manual && (
        <Button
          type="button"
          size="sm"
          // The notice and this control stay until the attempt succeeds.
          onClick={() => live.retry()}
        >
          Retry live updates
        </Button>
      )}
    </section>
  );
}
