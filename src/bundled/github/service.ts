// What the GitHub plugin offers other plugins: the pull request states the
// app already holds, as the agent tool `github_pr_state` gives them. It never
// reads GitHub, so a plugin can use what links, the panel and agents' watches
// have read without spending GitHub's limit.
import { type PullStateReport, pullStateReport } from "./pull-state-report";
import type { PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";

export type { PullStateDetails, PullStateReport } from "./pull-state-report";

/** The pull request states the app holds, read-only. */
export type GitHubPulls = Readonly<{
  /** What `github_pr_state` answers for the pull request `url` names, from
   * what the app last read and without reading again: the same fields, with
   * `details` when `details` is true and something read them. Undefined when
   * the app holds no state for it (never read, could not be read, forgotten
   * after nobody showed it for a while) or `url` is not a pull request's (or
   * one of its pages, such as its files), where the tool would read GitHub
   * or fail. A merged pull request stays merged. */
  prState(
    url: string,
    options?: Readonly<{ details?: boolean }>,
  ): PullStateReport | undefined;
  /** Calls `listener` after a read records a changed state, or when reading
   * it again starts failing, fails for another reason, or works again (so
   * `last_read_failed` changed); read `prState` again then. An issue link's
   * read calls it too, though `prState` gives nothing for an issue. A read that
   * finds the same state only moves `read_at` and `age_seconds`, and is not
   * announced; nor is a state the app forgets. It does not make the app read
   * anything. */
  subscribe(listener: () => void): () => void;
}>;

export function gitHubPulls(states: PullStates): GitHubPulls {
  return Object.freeze({
    prState(url: string, options?: Readonly<{ details?: boolean }>) {
      // As a link names it: a pull request's files or commits page is the
      // pull request.
      const pull = parseGitHubReference(url, { pullSubtargets: true });
      if (pull?.kind !== "pull") return undefined;
      const state = states.get(pull.url);
      const read = states.readAt(pull.url);
      return typeof state === "object" && read
        ? pullStateReport({ state, ...read }, options?.details === true)
        : undefined;
    },
    subscribe: (listener: () => void) => states.observe(listener),
  });
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    githubPulls: GitHubPulls;
  }
}
