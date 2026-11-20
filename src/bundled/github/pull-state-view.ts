// How a pull request's state looks and reads, the same in the sidebar, the
// panel and links in messages, and an issue's in links.
import {
  CheckCircleIcon,
  CircleDashedIcon,
  GitHubIssueIcon,
  GitMergeIcon,
  GitPullRequestApprovedIcon,
  GitPullRequestIcon,
  XCircleIcon,
} from "../../shared/design-system/icons/index";
import type { PullState } from "./pull-states";

export const stateIcons = {
  open: GitPullRequestIcon,
  draft: CircleDashedIcon,
  closed: XCircleIcon,
  merged: GitMergeIcon,
};

/** A link's glyph for `state`. An open pull request with every approval it
 * needs gets a checked glyph of the same size. A draft keeps its own, as it
 * cannot merge either way. */
export function pullLinkIcon(state: PullState | undefined) {
  if (state?.state === "open" && state.review === "approved")
    return GitPullRequestApprovedIcon;
  return stateIcons[state?.state ?? "open"];
}

/** An issue's: one completed is checked off, as on GitHub, and one not
 * planned is crossed out, as a closed pull request is here. */
export const issueIcons = {
  open: GitHubIssueIcon,
  completed: CheckCircleIcon,
  "not planned": XCircleIcon,
};

type Read = Readonly<{
  state?: PullState | undefined;
  /** It could not be read. */
  failed?: boolean | undefined;
}>;

/** The words for what the icon shows. */
export function describePull({ state, failed }: Read) {
  if (failed) return "Pull request, unavailable";
  if (!state) return "Pull request";
  const notes = [state.state === "draft" ? "draft" : state.state];
  if (state.state === "open" || state.state === "draft") {
    if (state.review) notes.push(state.review);
    if (state.checks === "failure") notes.push("checks failing");
    if (state.checks === "pending") notes.push("checks running");
    if (state.conflicts) notes.push("conflicts");
  }
  return `Pull request, ${notes.join(", ")}`;
}

/** The tone a pull request shows: its state, or whether an open one needs
 * attention. */
export function pullTone({ state }: Read) {
  if (!state) return "unknown";
  if (state.state !== "open") return state.state;
  if (state.checks === "failure" || state.conflicts) return "failure";
  return state.checks === "pending" ? "pending" : "open";
}

/** What an issue's icon shows: open, or why it was closed. */
export const issueState = (state: PullState) =>
  state.state === "closed" ? (state.reason ?? "completed") : "open";

/** The words for what an issue's icon shows. */
export function describeIssue({ state, failed }: Read) {
  if (failed) return "Issue, unavailable";
  if (!state) return "Issue";
  const shown = issueState(state);
  return shown === "open" ? "Issue, open" : `Issue, closed as ${shown}`;
}
