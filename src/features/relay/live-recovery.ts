import type { RecoveryStatus } from "./recovery";
import type { LiveSnapshot } from "./live";

/** The parts of a session's live view that recovery classifies. */
export type LiveRecoveryView = LiveSnapshot &
  Readonly<{
    roster: Readonly<{ state: string; transient?: true }>;
    heads: readonly Readonly<{
      channelId?: string;
      state: string;
      transient?: true;
    }>[];
    previews?: "checking" | "suspended";
  }>;

/** NIP-01 CLOSED prefixes that mean someone has to act: the same request
 * fails again until access, the request or the client changes. Session
 * recovery leaves them alone; the live layer retries them on its own slow
 * schedule (liveSlowRetryDelay). */
const PERMANENT_PREFIXES = [
  "restricted:",
  "blocked:",
  "invalid:",
  "auth-required:",
  "unsupported:",
  "pow:",
  "duplicate:",
];
/** Deterministic local failures (live.ts): retrying sends the same thing. */
const PERMANENT_LOCAL = new Set([
  "Unsupported live cooldown; automatic setup stopped",
]);
/** A route failure that a later attempt can clear. Anything not known to
 * need action counts: relays use other and unprefixed reasons for outages,
 * and a capped retry costs little next to a live view that never recovers. */
export function isTransientLiveError(reason: string | undefined): boolean {
  if (reason === undefined) return true;
  return (
    !PERMANENT_LOCAL.has(reason) &&
    !PERMANENT_PREFIXES.some((prefix) => reason.startsWith(prefix))
  );
}

/** How the live layer looks to session recovery. Only failures a retry can
 * fix count as failed. A sign-in error or a denial is settled here and stays
 * visible in live status instead; the live layer retries it slowly itself. */
export function liveRecoveryStatus(view: LiveRecoveryView): RecoveryStatus {
  // A terminal connection error closed the socket: its routes stay pending
  // but nothing is in flight. Finite roster and head reads still count.
  const routes = view.status === "error" ? [] : view.routes;
  // "retrying" counts as failed so wake, network and focus signals skip the
  // live layer's own backoff wait too.
  if (
    view.status === "retrying" ||
    view.previews === "suspended" ||
    view.roster.state === "deferred" ||
    (view.roster.state === "error" && view.roster.transient) ||
    view.heads.some((head) => head.state === "error" && head.transient) ||
    routes.some(
      (route) => route.status === "error" && isTransientLiveError(route.error),
    )
  )
    return "failed";
  // A retried read in flight is not proof of recovery. Reporting it as
  // settled would reset the delay and loop the retry every second.
  return view.status === "connecting" ||
    view.previews === "checking" ||
    view.roster.state === "pending" ||
    view.heads.some((head) => head.state === "pending") ||
    routes.some((route) => route.status === "pending")
    ? "busy"
    : "settled";
}

type LiveRead = Readonly<{ state: string; transient?: true }>;
/** True while session recovery retries the roster read (failed or busy in
 * liveRecoveryStatus), so recovery reports a list error. A denial is not. */
export const rosterRecovering = (roster: LiveRead) =>
  roster.state === "deferred" ||
  roster.state === "pending" ||
  (roster.state === "error" && !!roster.transient);
/** The same for one channel's timeline: true while the live source is not
 * settled for that channel. That covers its head read failing transiently or
 * in flight, and the handoff after a dropped stream: catch-up entries are
 * cleared until the channel's route re-establishes, which reads its head
 * again. */
export function headRecovering(view: LiveRecoveryView, channelId: string) {
  return (
    liveRecoveryStatus({
      status: view.status,
      routes: view.routes.filter((route) => route.channelId === channelId),
      roster: { state: "verified" },
      heads: view.heads.filter((head) => head.channelId === channelId),
    }) !== "settled"
  );
}
/** True while the session owes this channel a catch-up head read that is
 * queued or in flight. A cancelled, failed or settled read is not pending, so
 * a caller that waits on this cannot wait for a read nobody will send. A
 * session with no live view owes none. */
export const headReadPending = (
  live: { snapshot(): Pick<LiveRecoveryView, "heads"> } | undefined,
  channelId: string,
) =>
  !!live
    ?.snapshot()
    .heads.some(
      (head) => head.channelId === channelId && head.state === "pending",
    );
