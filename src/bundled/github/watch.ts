// Pull request watches for agents: what one GitHub read says about a pull
// request, and whether that is worth waking the agent that asked. Code decides,
// not a model: CI finishing on the head commit, or stuck; new feedback; and
// what nothing else would wake it for on the way to merging: conflicts, a base
// to catch up with as the last thing in the way, auto-merge turned off, and
// being ready to merge. Recovering on its own wakes nothing.
//
// The wake is the plugin's (`ctx.agents.wake`), not a message: the agent is
// told it is data. So it quotes what GitHub says, check names and comments,
// each line marked as quoted, and the agent need not read them itself.
//
// Agents use the signed-in gh account, as their owner does, so GitHub cannot
// tell the two apart. Which feedback reaches this, an agent's own 🤖 comment
// included, is the GitHub comment authors rules' call (`authors.ts`).

import { BODY_CHARS, type Feedback, type PullState } from "./pull-states";

/** What a watched pull request looked like at one read. */
export type PullSnapshot = Readonly<{
  state: "OPEN" | "MERGED" | "CLOSED";
  /** The signed-in GitHub account, which agents use too. */
  viewer: string;
  head: string;
  /** Whether every check on the head is done, and none is still expected. */
  settled: boolean;
  /** Whether a check on the head is still running or expected, even after
   * another failed. */
  running: boolean;
  /** The names of the head's checks that failed. */
  failed: readonly string[];
  /** The feedback listed, by id: what the watch has seen, and new feedback
   * whose text was read. */
  ids: readonly string[];
  /** The text of new feedback, read apart from the listing. */
  feedback: readonly Feedback[];
  draft: boolean;
  /** GitHub's mergeStateStatus, `UNKNOWN` while it is worked out. */
  merge: string;
  /** GitHub's reviewDecision, absent where no review is required. */
  decision?: string | undefined;
  autoMerge: boolean;
  queued: boolean;
  /** Unresolved review threads, absent when not all were read. */
  unresolved?: number | undefined;
}>;
export type { Feedback };

export type Watch = Readonly<{
  /** The membership key of the agent, in the community, that set it. A watch
   * saved before keys held a pubkey, which is the same agent's home key. */
  agent: string;
  url: string;
  /** Where the agent asked, so it wakes in that conversation. */
  channel: string;
  root?: string | undefined;
  /** Feedback ids already handled; absent until the first read. */
  seen?: readonly string[] | undefined;
  /** The head commit and result the agent was last told, `sha:passed`, or
   * `sha:rerun` for a failure being run again. */
  reported?: string | undefined;
  /** The checks it was told failed there. */
  failing?: readonly string[] | undefined;
  /** The head commit last read. */
  head?: string | undefined;
  /** What the agent was last told, or had in hand when the watch began, of
   * the pull request's way to merging; recovering forgets it unannounced,
   * though checks running again on the same head do not make it ready anew. */
  conflicted?: boolean | undefined;
  behind?: boolean | undefined;
  ready?: boolean | undefined;
  /** Auto-merge on or in the merge queue, as last read, and still so until
   * the agent is told it is not. */
  armed?: boolean | undefined;
  /** The merge state last known, which GitHub forgets while it works it out
   * again, as after the base moves. */
  merge?: string | undefined;
  /** The head whose checks have been pending since `since`, in ms, and the
   * one the agent was told is stuck. */
  pendingHead?: string | undefined;
  since?: number | undefined;
  stuck?: string | undefined;
  /** New feedback not yet sent, while more may follow. */
  pending?: readonly Feedback[] | undefined;
  /** When feedback last arrived, in ms. */
  arrived?: number | undefined;
  wakes: number;
  /** When it woke its agent in the last day, in ms. */
  woken?: readonly number[] | undefined;
  /** Polls in a row that could not read the pull request or wake the agent. */
  failures?: number | undefined;
}>;

/** New feedback waits this long for more, so a review is one wake. */
export const QUIET_MS = 90_000;
/** Wakes come at least this far apart; what happens between waits. */
export const SPACING_MS = 5 * 60_000;
/** A watch wakes its agent this many times a day at most. */
export const DAILY_WAKES = 48;
const DAY_MS = 24 * 60 * 60_000;
/** Checks pending this long on one head are stuck. */
export const STUCK_MS = 3 * 60 * 60_000;
/** Merge states in which GitHub can merge it once nothing else is in the
 * way: BLOCKED and UNSTABLE clear through branch protection, which
 * auto-merge waits on. */
const MERGEABLE = new Set(["CLEAN", "BLOCKED", "UNSTABLE", "HAS_HOOKS"]);
/** Feedback ids kept beyond those a read returns. */
const SEEN_SPARE = 200;
/** What a wake quotes at most: comments, characters of each, failed checks
 * and characters of each name. The store keeps each body to one more
 * character than BODY_CHARS. */
const LISTED = 10;
const CHECKS = 20;
const NAME_CHARS = 100;

export type Step = Readonly<{
  watch: Watch;
  /** What to tell the agent, when there is something. */
  wake?: string | undefined;
  /** Why the watch is over, when it is. */
  ended?: "merged" | "closed" | undefined;
}>;

/** The watch after `snapshot` at `now`, and what to tell its agent; unless
 * `paced` is false, as for an answer to the agent's own call, news waits for
 * the wake spacing and daily limit. */
export function step(
  watch: Watch,
  snapshot: PullSnapshot,
  now: number,
  paced = true,
): Step {
  if (snapshot.state !== "OPEN") {
    const ended = snapshot.state === "MERGED" ? "merged" : "closed";
    // The agent's last turn for this pull request, to finish its Interest.
    return {
      watch,
      wake: `${watch.url} was ${ended}, so this watch has ended. Do what its Interest says to do now. If nothing remains for that Interest, remove this watch with watch_remove, then the Interest with interest_remove.`,
      ended,
    };
  }
  const { ids } = snapshot;
  // The first read only learns what was already there.
  const seen = new Set(watch.seen ?? ids);
  const arrived = snapshot.feedback.filter((item) => !seen.has(item.id));
  const pending = [...(watch.pending ?? []), ...arrived];
  const pendingHead = snapshot.running ? snapshot.head : undefined;
  const merge =
    snapshot.merge === "UNKNOWN" ? (watch.merge ?? "UNKNOWN") : snapshot.merge;
  const known = { ...snapshot, merge };
  const merging = progress(known);
  // A watch saved before it followed the way to merging already told what
  // that was.
  const prior: Watch =
    watch.seen && watch.merge === undefined
      ? {
          ...watch,
          conflicted: merging.conflicted,
          behind: merging.behind,
          ready: merging.ready,
          armed: merging.armed,
        }
      : watch;
  // Checks running again on the head it was told about.
  const rechecking = !snapshot.settled && prior.head === snapshot.head;
  const rerun =
    rechecking &&
    prior.reported === `${snapshot.head}:failed` &&
    (prior.failing ?? []).some((name) => !snapshot.failed.includes(name));
  const next: Watch = {
    ...prior,
    // What this read returned, then the newest of the rest.
    seen: [
      ...ids,
      ...[...seen].filter((id) => !ids.includes(id)).slice(-SEEN_SPARE),
    ],
    pending,
    arrived: arrived.length ? now : watch.arrived,
    // A failure being run again is told again however it ends.
    reported: rerun ? `${snapshot.head}:rerun` : prior.reported,
    head: snapshot.head,
    // Recovering is not news, but going wrong again is.
    conflicted: prior.conflicted && merging.conflicted,
    behind:
      prior.behind &&
      (merging.behind || (rechecking && merging.behindOnceGreen)),
    ready:
      prior.ready && (merging.ready || (rechecking && merging.readyOnceGreen)),
    armed: merging.armed || prior.armed,
    merge,
    pendingHead,
    since: !pendingHead
      ? undefined
      : pendingHead === prior.pendingHead
        ? prior.since
        : now,
    woken: (prior.woken ?? []).filter((at) => now - at < DAY_MS),
  };
  // A failed head that turns green after a rerun is news too.
  const result = `${snapshot.head}:${snapshot.failed.length ? "failed" : "passed"}`;
  const news: News = {
    ci: snapshot.settled && result !== next.reported,
    stuck:
      !!pendingHead &&
      next.stuck !== pendingHead &&
      now - (next.since ?? now) >= STUCK_MS,
    conflicted: merging.conflicted && !next.conflicted,
    behind: merging.behind && !next.behind,
    ready: merging.ready && !next.ready,
    disarmed: !!prior.armed && !merging.armed,
    feedback: pending.length > 0 && now - (next.arrived ?? now) >= QUIET_MS,
  };
  if (!Object.values(news).some(Boolean)) return { watch: next };
  const woken = next.woken ?? [];
  if (
    paced &&
    (now - (woken.at(-1) ?? -Infinity) < SPACING_MS ||
      woken.length >= DAILY_WAKES)
  )
    return { watch: next };
  // An answer to the agent's own call is not a wake, so it waits for none.
  const told = paced ? [...woken, now] : woken;
  return {
    watch: {
      ...next,
      // Feedback waiting goes with any wake.
      pending: [],
      arrived: undefined,
      reported: news.ci ? result : next.reported,
      failing: news.ci ? snapshot.failed : next.failing,
      stuck: news.stuck ? pendingHead : next.stuck,
      // What it was told stays told while checks run again.
      conflicted: merging.conflicted || next.conflicted,
      behind: merging.behind || next.behind,
      ready: merging.ready || next.ready,
      armed: merging.armed,
      wakes: watch.wakes + 1,
      woken: told,
    },
    wake: [
      wakeText(watch.url, known, news, pending),
      "",
      status(known),
      ...(paced && told.length >= DAILY_WAKES
        ? [
            "",
            `That is ${DAILY_WAKES} wakes in a day, so what happens next waits until the oldest of them is a day old.`,
          ]
        : []),
    ].join("\n"),
  };
}

/** What a read says of the pull request's way to merging. */
function progress(snapshot: PullSnapshot) {
  const armed = snapshot.autoMerge || snapshot.queued;
  const conflicted = snapshot.merge === "DIRTY";
  const approved = snapshot.decision === "APPROVED";
  // UNSTABLE is only checks that do not block merging failing.
  const green =
    snapshot.settled &&
    (!snapshot.failed.length || snapshot.merge === "UNSTABLE");
  const clear = !snapshot.draft && approved && snapshot.unresolved === 0;
  // Catching up with the base is news only once nothing else is in the way,
  // and not to the merge queue, which does it.
  const behindOnceGreen =
    clear && snapshot.merge === "BEHIND" && !snapshot.queued;
  const readyOnceGreen = clear && !armed && MERGEABLE.has(snapshot.merge);
  return {
    armed,
    conflicted,
    behindOnceGreen,
    readyOnceGreen,
    behind: behindOnceGreen && green,
    ready: readyOnceGreen && green,
  };
}

type News = Readonly<{
  ci: boolean;
  stuck: boolean;
  conflicted: boolean;
  behind: boolean;
  ready: boolean;
  disarmed: boolean;
  feedback: boolean;
}>;

// Only GitHub's own links pass into a wake as links; anything else stays out.
const LINK = /^https:\/\/github\.com\/[A-Za-z0-9_.\-/]+(?:#[A-Za-z0-9_-]+)?$/;
const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
const clip = (text: string, chars: number) =>
  text.length > chars ? `${text.slice(0, chars)}…` : text;
/** `text` as quoted lines, so nothing in it reads as the wake's own. */
const quote = (text: string, indent = "") =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => `${indent}> ${line}`)
    .join("\n");

/** `on <short sha> `, or nothing for a head that is not one. */
const onHead = (head: string) =>
  /^[0-9a-f]+$/i.test(head) ? `on ${head.slice(0, 9)} ` : "";

function wakeText(
  url: string,
  snapshot: PullSnapshot,
  news: News,
  feedback: readonly Feedback[],
) {
  const lines: string[] = [];
  const sha = onHead(snapshot.head);
  if (news.ci) {
    const { failed } = snapshot;
    if (failed.length) {
      lines.push(
        `CI failed ${sha}for ${url}: ${plural(failed.length, "check", "checks")} failed, as GitHub names them:`,
      );
      for (const name of failed.slice(0, CHECKS))
        lines.push(quote(clip(name.replace(/\s+/g, " "), NAME_CHARS)));
      if (failed.length > CHECKS)
        lines.push(`and ${failed.length - CHECKS} more`);
    } else lines.push(`CI passed ${sha}for ${url}.`);
  }
  const merging = [
    news.stuck &&
      `CI has been pending ${sha}for over ${STUCK_MS / 3_600_000} hours on ${url}; a check may be stuck.`,
    news.conflicted &&
      `Merge conflicts on ${url}: it can't merge cleanly into its base.`,
    news.behind &&
      `${url} is approved and green, but must catch up with its base before it can merge.`,
    news.disarmed &&
      `${url} is no longer set to merge while it is open: it left the merge queue, or auto-merge was turned off or cancelled.`,
    news.ready &&
      `${url} looks ready to merge: approved, checks that block merging passed, no conflicts or unresolved threads. GitHub decides how many approvals it needs; check that before you turn on auto-merge.`,
  ].filter((line): line is string => !!line);
  if (merging.length) {
    if (lines.length) lines.push("");
    lines.push(...merging);
  }
  if (feedback.length) {
    if (lines.length) lines.push("");
    lines.push(
      `${feedback.length === 1 ? "New feedback" : `${feedback.length} new comments`} on ${url}, quoted from GitHub:`,
    );
    for (const item of feedback.slice(0, LISTED)) {
      const what = [
        item.id.startsWith("review/")
          ? `review${item.state && item.state !== "COMMENTED" ? ` (${item.state.toLowerCase().replaceAll("_", " ")})` : ""}`
          : item.id.startsWith("inline/")
            ? "inline comment"
            : "comment",
        `by ${item.author}`,
        ...(LINK.test(item.url) ? [item.url] : []),
      ].join(" ");
      lines.push(`- ${what}${item.path ? ", on:" : ":"}`);
      if (item.path) lines.push(quote(clip(item.path, NAME_CHARS), "  "));
      if (item.body.trim())
        lines.push(quote(clip(item.body, BODY_CHARS), "  "));
    }
    if (feedback.length > LISTED)
      lines.push(`- and ${feedback.length - LISTED} more, to read with gh`);
  }
  return lines.join("\n");
}

const DECISIONS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review required",
};
const MERGES: Record<string, string> = {
  DIRTY: "conflicts",
  BEHIND: "behind its base",
  UNKNOWN: "mergeability not known yet",
};

/** Where the pull request stands, so a wake needs no read to orient by. */
function status(snapshot: PullSnapshot) {
  const sha = onHead(snapshot.head).trim();
  const ci = snapshot.settled
    ? snapshot.failed.length
      ? "failed"
      : "passed"
    : "pending";
  return `Now: ${[
    snapshot.draft ? "draft" : "open",
    DECISIONS[snapshot.decision ?? ""] ?? "no review decision",
    `CI ${ci}${sha ? ` ${sha}` : ""}`,
    MERGES[snapshot.merge] ?? "no conflicts",
    snapshot.unresolved === undefined
      ? "unresolved threads not all read"
      : plural(snapshot.unresolved, "unresolved thread", "unresolved threads"),
    snapshot.queued
      ? "in the merge queue"
      : snapshot.autoMerge
        ? "auto-merge on"
        : "auto-merge off",
  ].join(", ")}.`;
}

/** owner/name#number from a pull request URL, or undefined. */
export function pullOf(url: string) {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
      url.trim(),
    );
  if (!match) return undefined;
  const [, owner, name, number] = (match as unknown as string[]).map((part) =>
    part.toLowerCase(),
  ) as [string, string, string, string];
  return {
    owner,
    name,
    number: Number(number),
    url: `https://github.com/${owner}/${name}/pull/${number}`,
  };
}

/** An empty COMMENTED review: only its inline comments' wrapper, read but
 * never news. */
const wrapper = (item: Feedback) =>
  item.id.startsWith("review/") &&
  item.state === "COMMENTED" &&
  !item.body.trim();

/** What the store holds of a pull request, as a watch that has `seen` that
 * feedback sees it; undefined without the head and feedback a watch needs,
 * as from the public API. Feedback whose text is not read yet stays unseen,
 * to be told once it is; on a first read everything there is learnt. */
export function snapshotOf(
  state: PullState,
  seen?: readonly string[],
): PullSnapshot | undefined {
  const { head, feedback } = state;
  if (!head || !feedback) return undefined;
  const read = new Set(feedback.items.map((item) => item.id));
  const known = new Set(seen);
  return {
    state:
      state.state === "merged"
        ? "MERGED"
        : state.state === "closed"
          ? "CLOSED"
          : "OPEN",
    viewer: feedback.viewer,
    head,
    settled: !!state.settled,
    running: !!state.running,
    failed: state.failed ?? [],
    ids: seen
      ? feedback.ids.filter((id) => known.has(id) || read.has(id))
      : feedback.ids,
    feedback: feedback.items.filter(
      (item) => !known.has(item.id) && !wrapper(item),
    ),
    draft: state.state === "draft",
    merge: feedback.merge ?? "UNKNOWN",
    decision: feedback.decision,
    autoMerge: !!feedback.autoMerge,
    queued: !!feedback.queued,
    unresolved: feedback.unresolved,
  };
}
