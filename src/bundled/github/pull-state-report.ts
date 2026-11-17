// A pull request's state as agents and other plugins read it: the same
// answer from the agent tool `github_pr_state` and from `ctx.githubPulls`.
import type { GitHubDetails } from "./data";
import type { PullDetails, PullRead, PullState } from "./pull-states";

/** What the panel shows beyond the state: the title, author, the panel's
 * facts under snake_case keys (such as `files_changed`), and the review,
 * threads and merge state when read with `gh`, or else the public checks. */
export type PullStateDetails = Readonly<Record<string, unknown>>;

/** A pull request's state, as `github_pr_state` gives it. */
export type PullStateReport = Readonly<{
  state: PullState["state"];
  /** These five come with a read made with `gh`. */
  checks?: "success" | "failure" | "pending" | "none";
  failed?: readonly string[] | undefined;
  settled?: boolean | undefined;
  conflicts?: boolean | undefined;
  head?: string;
  /** With `details`, once something read it at that level. */
  details?: PullStateDetails;
  /** When it was read, as an ISO 8601 time. */
  read_at: string;
  age_seconds: number;
  /** `gh` when read with the signed-in `gh` CLI, or `public` from GitHub's
   * public API. */
  source: "gh" | "public";
  /** The state above is the last one read; reading it again failed. */
  last_read_failed?: string;
}>;

/** The panel's facts, such as files changed, as plain values under
 * snake_case keys. */
const factsOf = (facts: GitHubDetails["facts"]) =>
  Object.fromEntries(
    facts.map(([label, value]) => [
      label.toLowerCase().replaceAll(" ", "_"),
      typeof value !== "object"
        ? value
        : "additions" in value
          ? `+${value.additions} -${value.deletions}`
          : `${value.head.label} -> ${value.base.label}`,
    ]),
  );

/** What the panel shows beyond the state, for `details: true`. Lists and
 * objects are copies: other plugins get this report, and a change they make
 * must not change what the store holds. */
const detailsOf = ({
  details,
  checklist,
  publicChecks,
}: PullDetails): PullStateDetails => ({
  title: details.title,
  author: details.author,
  ...factsOf(details.facts),
  ...(checklist
    ? {
        review: {
          decision: checklist.review.decision,
          approved: [...checklist.review.approved],
          changes_requested: [...checklist.review.changes],
          waiting: [...checklist.review.waiting],
        },
        unresolved_threads: checklist.unresolved,
        ...(checklist.moreThreads ? { more_threads_unread: true } : {}),
        merge_state: checklist.merge,
        auto_merge: checklist.autoMerge ? { ...checklist.autoMerge } : null,
        can_update_branch: checklist.canUpdateBranch,
      }
    : { checks: publicChecks?.state ?? "unknown" }),
});

/** `read`'s state as `github_pr_state` gives it, with the panel's details
 * when `details` and they were read. It shares no list or object with the
 * store (see `detailsOf`). */
export function pullStateReport(
  { state, readAt, error }: PullRead & { state: PullState },
  details: boolean,
  now = Date.now(),
): PullStateReport {
  return {
    state: state.state,
    ...(state.head
      ? {
          checks: state.checks ?? "none",
          failed: state.failed && [...state.failed],
          settled: state.settled,
          conflicts: state.conflicts,
          head: state.head,
        }
      : {}),
    ...(details && state.details ? { details: detailsOf(state.details) } : {}),
    read_at: new Date(readAt).toISOString(),
    age_seconds: Math.max(0, Math.round((now - readAt) / 1000)),
    source: state.head ? "gh" : "public",
    ...(error ? { last_read_failed: error.message } : {}),
  };
}
