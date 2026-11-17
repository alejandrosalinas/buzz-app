// An agent's lookup of a pull request's state: what the owner's links and
// sidebar show, from the same store, with how old it is.
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { pullStateReport } from "./pull-state-report";
import { PULL_REFRESH_MS, type PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";

export function addPullStateTool(
  agents: { addTool(tool: AddedTool): void },
  states: PullStates,
) {
  agents.addTool({
    name: "github_pr_state",
    description:
      "Reads a GitHub pull request's state as the owner's links show it: open, draft, merged or closed, its checks, failed check names and conflicts, and when it was read. With details true it also gives what the owner's GitHub panel shows: title, branches, files changed, the review decision and reviewers, unresolved review threads, the merge state and auto-merge. It is at most a minute old unless fresh is true, or the last read failed: then last_read_failed says why and age_seconds how old it is. Checks and conflicts need the gh CLI signed in; without it a lookup gives only the state, and with details true also the title and branches, and the head's public checks once the owner's panel has read them.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The pull request's https://github.com/… URL",
        },
        fresh: {
          type: "boolean",
          description: "Read it from GitHub now rather than within the minute",
        },
        details: {
          type: "boolean",
          description:
            "Also give what the panel shows: reviews, unresolved threads, merge state and branches",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      // The store reads issues' state too, for links; this is pull requests'.
      if (
        typeof args.url !== "string" ||
        parseGitHubReference(args.url)?.kind !== "pull"
      )
        throw new Error("url must be a GitHub pull request URL");
      const { state, readAt, error } = await states.read(args.url, {
        maxAge: args.fresh === true ? 0 : PULL_REFRESH_MS,
        ...(args.details === true ? { level: "details" as const } : {}),
      });
      if (state === "failed")
        throw new Error(
          `Could not read ${args.url}: ${error?.message ?? "GitHub did not answer"}`,
        );
      return JSON.stringify(
        pullStateReport({ state, readAt, error }, args.details === true),
        null,
        2,
      );
    },
  });
}
