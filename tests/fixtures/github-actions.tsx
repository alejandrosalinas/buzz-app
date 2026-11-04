import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";
import { GitHubPanel } from "../../src/bundled/github";
import type { GitHubCli } from "../../src/bundled/github/gh";
import { PanelWorkspace } from "../../src/features/panels/PanelWorkspace";
import { Panel } from "../../src/shared/design-system/ui/Panel";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";

// Real panel and menu; GitHub reads and changes stay in memory.
const ready = new URLSearchParams(location.search).has("ready");
const queue = new URLSearchParams(location.search).has("queue");
let queued = false;
let draft = false;
const gh: GitHubCli = async (query) => {
  if (query.startsWith("mutation($input:ConvertPullRequestToDraftInput!")) {
    draft = true;
    return JSON.parse("{}");
  }
  if (query.startsWith("mutation($input:EnqueuePullRequestInput!")) {
    queued = true;
    return JSON.parse("{}");
  }
  if (!query.startsWith("query("))
    throw new Error("Unsupported fixture action");
  // The plugin's store reads each pull request under an alias.
  return JSON.parse(
    JSON.stringify({
      r0: {
        viewerDefaultMergeMethod: "SQUASH",
        squashMergeAllowed: true,
        mergeCommitAllowed: true,
        pullRequest: {
          id: "PR_fixture",
          title: "Keep the release notes easy to scan",
          state: "OPEN",
          isDraft: draft,
          isMergeQueueEnabled: queue,
          isInMergeQueue: queued,
          body: "This sample change groups release notes by feature.\n\nReview the checklist above, then open the action menu to see the available options. All names and pull request data on this page are fictional.",
          author: { login: "alex-example" },
          baseRefName: "main",
          headRefName: "fix/release-notes",
          headRefOid: "fixture-head",
          headRepository: { nameWithOwner: "sample/project" },
          baseRepository: { nameWithOwner: "sample/project" },
          additions: 12,
          deletions: 4,
          changedFiles: 2,
          updatedAt: "2026-10-27T12:00:00Z",
          mergeStateStatus: ready ? "CLEAN" : "BLOCKED",
          reviewDecision: ready ? "APPROVED" : "REVIEW_REQUIRED",
          viewerCanUpdate: true,
          reviewRequests: {
            nodes: ready
              ? []
              : [{ requestedReviewer: { name: "sample-reviewers" } }],
          },
          latestOpinionatedReviews: {
            nodes: ready
              ? [{ author: { login: "sam-example" }, state: "APPROVED" }]
              : [],
          },
          reviewThreads: { totalCount: 0, nodes: [] },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: 1,
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "Unit tests",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    }),
  );
};

function Fixture() {
  useKeyboardFocusVisibility();
  return (
    <Panel style={{ height: "100dvh", maxWidth: 900, margin: "0 auto" }}>
      <PanelWorkspace
        value="github"
        select={() => {}}
        items={[
          {
            id: "github",
            label: "GitHub",
            content: (
              <GitHubPanel
                target="https://github.com/sample/project/pull/42"
                close={() => {}}
                gh={gh}
              />
            ),
          },
        ]}
      />
    </Panel>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(<Fixture />);
