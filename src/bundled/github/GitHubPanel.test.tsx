// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  GhUnavailable,
  GitHubError,
  OutputTooLarge,
  type GitHubCli,
} from "./gh";
import { GitHubPanel, REFRESH_MS } from "./index";
import { createPanelMemory } from "./panel-memory";
import { createPullStates } from "./pull-states";
import { ToastProvider } from "../../shared/design-system/ui/Toast";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ["open", false, false, "open"],
  ["open", true, false, "Draft"],
  ["closed", true, false, "closed"],
  ["closed", true, true, "Merged"],
])(
  "presents PR state with terminal states before draft: %s, draft=%s, merged=%s",
  async (state, draft, merged, label) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: "A small improvement",
            state,
            draft,
            merged,
            additions: 174,
            deletions: 28,
            changed_files: 6,
          }),
        ),
      ),
    );
    render(
      <GitHubPanel
        target="https://github.com/example/project/pull/1"
        close={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "A small improvement #1" });
    expect(screen.getByText(label)).toHaveAttribute(
      "data-pr-state",
      label.toLowerCase(),
    );
    expect(screen.getByText(label).querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const changes = screen.getByText("Changes").parentElement;
    if (!changes) throw new Error("Missing Changes row");
    expect(changes.querySelector("dd")).toHaveTextContent("+174 / −28");
  },
);

it("preserves zero counts and leaves an open issue neutral", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A small improvement",
          state: "open",
          additions: 0,
          deletions: 0,
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/issues/1"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "A small improvement" });
  expect(screen.getByText("open")).not.toHaveAttribute("data-pr-state");
  expect(screen.getByText("+0")).toBeInTheDocument();
  expect(screen.getByText("−0")).toBeInTheDocument();
});

it("links branch labels to their own repositories and preserves unavailable branches", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A fork contribution",
          state: "open",
          head: {
            label: "contributor:fix/small detail",
            ref: "fix/small detail",
            repo: { full_name: "contributor/project" },
          },
          base: {
            label: "example:main",
            ref: "main",
            repo: { full_name: "example/project" },
          },
        }),
      ),
    ),
  );
  const { unmount } = render(
    <GitHubPanel
      target="https://github.com/example/project/pull/1"
      close={() => {}}
    />,
  );
  const head = await screen.findByRole("link", {
    name: "contributor:fix/small detail",
  });
  expect(head).toHaveAttribute(
    "href",
    "https://github.com/contributor/project/tree/fix/small%20detail",
  );
  expect(head).toHaveAttribute("target", "_blank");
  expect(head).toHaveAttribute("rel", "noreferrer");
  expect(screen.getByRole("link", { name: "main" })).toHaveAttribute(
    "href",
    "https://github.com/example/project/tree/main",
  );
  unmount();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "An unavailable branch",
          head: { label: "contributor:deleted", ref: "deleted", repo: null },
          base: { label: "example:main" },
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/pull/2"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "An unavailable branch #2" });
  const deleted = screen.getByText("contributor:deleted");
  expect(deleted).toBeVisible();
  expect(deleted.parentElement).toHaveTextContent(
    "contributor:deleted → example:main",
  );
  expect(
    screen.queryByRole("link", { name: "contributor:deleted" }),
  ).not.toBeInTheDocument();
});

it("links the author login to their external GitHub profile", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A small improvement",
          user: { login: "tellaho" },
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/pull/1"
      close={() => {}}
    />,
  );
  const authors = await screen.findAllByRole("link", { name: "tellaho" });
  const author = authors.find(
    (link) => link.parentElement?.textContent === "by tellaho",
  );
  expect(authors).toHaveLength(1);
  expect(author).toHaveAttribute("href", "https://github.com/tellaho");
  expect(author).toHaveAttribute("target", "_blank");
  expect(author).toHaveAttribute("rel", "noreferrer");
  expect(author?.parentElement).toHaveTextContent("by tellaho");
});

it.each([
  [
    {
      commit: { message: "A commit", author: { name: "Sample Author" } },
      owner: { login: "someone-else" },
    },
    "Sample Author",
  ],
  [{ user: { login: "invalid/profile" } }, "invalid/profile"],
])(
  "does not invent a profile for raw or invalid authors",
  async (data, name) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(data))),
    );
    render(
      <GitHubPanel
        target="https://github.com/example/project/commit/abcdef1"
        close={() => {}}
      />,
    );
    await screen.findByText(`by ${name}`);
    expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
  },
);

it("links the PR owner and repository and moves its number to the title", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ title: "A small improvement" })),
      ),
  );
  render(
    <GitHubPanel
      target="https://github.com/block/buzz-app/pull/629"
      close={() => {}}
    />,
  );
  const owner = screen.getByRole("link", { name: "block" });
  const repository = screen.getByRole("link", { name: "buzz-app" });
  expect(owner).toHaveAttribute("href", "https://github.com/block");
  expect(repository).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app",
  );
  for (const link of [owner, repository]) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  }
  const identity = screen.getByText("Pull request", {
    selector: "small",
  }).parentElement;
  expect(identity).toHaveTextContent("block / buzz-appPull request");
  expect(identity).not.toHaveTextContent("#629");
  const title = await screen.findByRole("heading", {
    name: "A small improvement #629",
  });
  expect(within(title).getByText("#629")).toBeVisible();
  const titleLink = within(title).getByRole("link", {
    name: "A small improvement #629",
  });
  expect(titleLink).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/pull/629",
  );
  expect(titleLink).toHaveAttribute("target", "_blank");
  expect(titleLink).toHaveAttribute("rel", "noreferrer");
  expect(
    screen.queryByRole("link", { name: "Open on GitHub" }),
  ).not.toBeInTheDocument();
});

it.each([
  ["https://github.com/example/project", "Repository project"],
  ["https://github.com/example/project/issues/2", "Issue #2"],
  ["https://github.com/example/project/commit/abcdef1", "Commit abcdef1"],
])(
  "preserves the non-PR identity and title for %s",
  async (target, identity) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ title: "GitHub object" })),
        ),
    );
    render(<GitHubPanel target={target} close={() => {}} />);
    expect(screen.getByText(identity)).toBeVisible();
    expect(screen.getByText("example/project")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "example" }),
    ).not.toBeInTheDocument();
    await screen.findByRole("heading", { name: "GitHub object" });
    expect(
      screen.getByRole("link", { name: "Open on GitHub" }),
    ).toHaveAttribute("href", target);
  },
);

it.each([400])(
  "keeps the PR title and prominent external recovery action usable after API failure %s",
  async (status) => {
    const target = "https://github.com/block/buzz-app/pull/629";
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(response)
      .mockImplementation(
        async (input: string) =>
          new Response(
            JSON.stringify(
              input === "https://api.github.com/repos/block/buzz-app/pulls/629"
                ? { title: "Recovered PR" }
                : [],
            ),
          ),
      );
    vi.stubGlobal("fetch", fetch);
    render(<GitHubPanel target={target} close={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(
      screen.queryByRole("link", { name: "Open on Github" }),
    ).not.toBeInTheDocument();
    const titleLink = screen.getByRole("link", { name: "Pull request #629" });
    expect(titleLink).toHaveAttribute("href", target);
    finish(new Response(null, { status }));
    const alert = await screen.findByRole("alert");
    expect(titleLink).toBeVisible();
    const external = within(alert).getByRole("link", {
      name: "Open on Github",
    });
    const retry = within(alert).getByRole("button", { name: "Retry" });
    expect(external).toHaveAttribute("href", target);
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noreferrer");
    expect(external).toHaveAttribute("data-variant", "prominent");
    expect(retry).toHaveAttribute("data-variant", "subtle");
    expect(external.nextElementSibling).toBe(retry);
    fireEvent.click(retry);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await screen.findByRole("heading", { name: "Recovered PR #629" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open on Github" }),
    ).not.toBeInTheDocument();
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/block/buzz-app/pulls/629",
    );
  },
);

const pull = "https://github.com/block/private/pull/9";
/** The store's `gh` answer for an open pull request, with `pull` overrides:
 * the panel reads it as the first alias of the store's query. */
function pullData(over: Record<string, unknown> = {}) {
  return {
    r0: {
      viewerDefaultMergeMethod: "SQUASH",
      squashMergeAllowed: true,
      mergeCommitAllowed: true,
      rebaseMergeAllowed: false,
      pullRequest: {
        id: "PR_9",
        title: "Private change",
        state: "OPEN",
        isDraft: false,
        body: "Why it changes",
        author: { login: "baxen" },
        baseRefName: "main",
        headRefName: "fix",
        headRefOid: "abc123",
        headRepository: { nameWithOwner: "block/private" },
        headRepositoryOwner: { login: "block" },
        baseRepository: { nameWithOwner: "block/private" },
        additions: 3,
        deletions: 1,
        changedFiles: 2,
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        viewerCanUpdate: true,
        viewerCanUpdateBranch: true,
        viewerCanMergeAsAdmin: false,
        viewerCanEnableAutoMerge: false,
        viewerCanDisableAutoMerge: false,
        autoMergeRequest: null,
        reviewRequests: { nodes: [] },
        latestOpinionatedReviews: {
          nodes: [{ author: { login: "wes" }, state: "APPROVED" }],
        },
        reviewThreads: { nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    totalCount: 2,
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "unit",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                      },
                      {
                        __typename: "StatusContext",
                        context: "deploy",
                        state: "SUCCESS",
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
        ...over,
      },
    },
  };
}
const checklist = () =>
  screen.getByRole("list", { name: "Pull request checklist" });
const row = (label: string) =>
  within(checklist()).getByText(label).closest("li") as HTMLElement;

it("reads a private pull request with gh as one checklist, without the public API", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const gh = vi.fn(async () =>
    pullData({
      mergeStateStatus: "BLOCKED",
      reviewDecision: "CHANGES_REQUESTED",
      latestOpinionatedReviews: {
        nodes: [{ author: { login: "wes" }, state: "CHANGES_REQUESTED" }],
      },
      reviewThreads: {
        nodes: [
          { isResolved: false },
          { isResolved: true },
          { isResolved: false },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  totalCount: 3,
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "e2e",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      detailsUrl: "https://github.com/block/private/runs/1",
                    },
                    {
                      __typename: "CheckRun",
                      name: "lint",
                      status: "IN_PROGRESS",
                      conclusion: null,
                    },
                    {
                      __typename: "CheckRun",
                      name: "unit",
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
    }),
  ) as unknown as GitHubCli;
  render(<GitHubPanel target={pull} close={() => {}} gh={gh} />);
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(row("Checks")).toHaveTextContent("1 failed · 1 running · 1 passed");
  expect(row("Checks")).toHaveAttribute("data-tone", "failure");
  expect(
    within(row("Checks")).queryByRole("link", { name: "e2e" }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    within(row("Checks")).getByRole("button", {
      name: "1 failed · 1 running · 1 passed",
    }),
  );
  expect(
    within(row("Checks")).getByRole("link", { name: "e2e" }),
  ).toHaveAttribute("href", "https://github.com/block/private/runs/1");
  expect(row("Review")).toHaveTextContent("Changes requested by wes");
  expect(row("Threads")).toHaveTextContent("2 unresolved");
  expect(row("Merge")).toHaveTextContent("Blocked by main’s rules");
  expect(row("Merge")).not.toHaveTextContent("bypass");
  // Blocked, and this viewer cannot bypass: nothing to merge with.
  expect(
    screen.queryByRole("button", { name: /merge/i }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Read with your gh sign-in.")).toBeInTheDocument();
  expect(screen.getByText("Changes").parentElement).toHaveTextContent(
    "+3 / −1",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("falls back to public data when gh is unavailable, and says why private links fail", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/pulls/9")
        ? new Response(null, { status: 404 })
        : new Response("{}"),
    ),
  );
  const gh = vi.fn(async () => {
    throw new GhUnavailable("To get started with GitHub CLI");
  }) as unknown as GitHubCli;
  render(<GitHubPanel target={pull} close={() => {}} gh={gh} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in to the gh CLI to see private repositories",
  );
});

it("says when the signed-in account cannot see it, without falling back", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const gh = vi.fn(async () => {
    throw new GitHubError("Could not resolve", "NOT_FOUND");
  }) as unknown as GitHubCli;
  render(<GitHubPanel target={pull} close={() => {}} gh={gh} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "your GitHub account can’t see it",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("merges after confirming, at the head it showed, then shows it merged", async () => {
  const user = userEvent.setup();
  let merged = false;
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation")) {
      merged = true;
      return {};
    }
    return merged
      ? pullData({
          state: "MERGED",
          mergedBy: { login: "baxen" },
          mergedAt: new Date().toISOString(),
        })
      : pullData();
  });
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(row("Checks")).toHaveTextContent("All 2 passed");
  expect(row("Review")).toHaveTextContent("Approved by wes");
  expect(row("Threads")).toHaveTextContent("None unresolved");
  expect(row("Merge")).toHaveTextContent("Ready to merge into main");
  await user.click(screen.getByRole("button", { name: "Squash and merge" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(gh).toHaveBeenCalledTimes(1);
  await user.click(within(dialog).getByRole("button", { name: "Merge" }));
  await screen.findByText(/Merged into/);
  expect(screen.getByText(/Merged into/)).toHaveTextContent(
    "Merged into main by baxen",
  );
  expect(gh.mock.calls[1]).toEqual([
    "mutation($input:MergePullRequestInput!){mergePullRequest(input:$input){clientMutationId}}",
    {
      input: {
        pullRequestId: "PR_9",
        expectedHeadOid: "abc123",
        mergeMethod: "SQUASH",
      },
    },
    undefined,
  ]);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Submit review" }),
  ).not.toBeInTheDocument();
});

it.each(["CLEAN", "BLOCKED", "BEHIND"])(
  "queues the displayed head on a queue-required branch (%s), then shows it queued",
  async (mergeStateStatus) => {
    const user = userEvent.setup();
    let queued = false;
    const gh = vi.fn(async (query: string, _variables?: unknown) => {
      if (query.startsWith("mutation")) {
        queued = true;
        return {};
      }
      return pullData({
        isMergeQueueEnabled: true,
        isInMergeQueue: queued,
        mergeStateStatus,
        viewerCanMergeAsAdmin: true,
        viewerCanEnableAutoMerge: true,
      });
    });
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    const button = await screen.findByRole("button", {
      name: "Queue for merge",
    });
    expect(button).toHaveAttribute("data-variant", "prominent");
    expect(
      screen.queryByRole("button", { name: "Squash and merge" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More pull request actions" }),
    );
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(["Convert to draft"]);
    await user.keyboard("{Escape}");
    await user.click(button);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAccessibleName("Queue for merge #9?");
    expect(gh).toHaveBeenCalledTimes(1);
    await user.click(
      within(dialog).getByRole("button", { name: "Queue for merge" }),
    );
    await screen.findByText("Queued for merge");
    expect(row("Merge")).toHaveTextContent("Queued for merge into main");
    expect(gh.mock.calls[0]?.[0]).toContain(
      "isMergeQueueEnabled isInMergeQueue",
    );
    expect(gh.mock.calls[1]).toEqual([
      "mutation($input:EnqueuePullRequestInput!){enqueuePullRequest(input:$input){clientMutationId}}",
      { input: { pullRequestId: "PR_9", expectedHeadOid: "abc123" } },
      undefined,
    ]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Queue for merge" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Merge when ready" }),
    ).not.toBeInTheDocument();
  },
);

it.each([
  { mergeStateStatus: "DIRTY" },
  { mergeStateStatus: "UNKNOWN" },
  { isDraft: true },
  { isInMergeQueue: true },
])(
  "does not offer queueing an ineligible or already queued pull (%j)",
  async (over) => {
    const gh = vi.fn(async () =>
      pullData({
        isMergeQueueEnabled: true,
        viewerCanEnableAutoMerge: true,
        ...over,
      }),
    );
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await screen.findByRole("heading", { name: "Private change #9" });
    expect(
      screen.queryByRole("button", { name: "Queue for merge" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Merge when ready" }),
    ).not.toBeInTheDocument();
  },
);

it("shows GitHub's queue rejection and allows retrying the confirmed head", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation"))
      throw new GitHubError("Required approvals are missing");
    return pullData({ isMergeQueueEnabled: true, mergeStateStatus: "BLOCKED" });
  });
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Queue for merge" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  await user.click(
    within(dialog).getByRole("button", { name: "Queue for merge" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Required approvals are missing",
  );
  expect(
    within(dialog).getByRole("button", { name: "Queue for merge" }),
  ).toBeEnabled();
});

it("closes a merge confirmation if the branch starts requiring a queue", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let queue = false;
    const gh = vi.fn(async () =>
      pullData({
        isMergeQueueEnabled: queue,
        ...(queue && { title: "Queue required" }),
      }),
    );
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Squash and merge" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    queue = true;
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await screen.findByRole("heading", { name: "Queue required #9" });
    expect(dialog).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Queue for merge" }),
    ).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "closes the merge confirmation when a refresh brings a newer push (queue=%s)",
  async (queue) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let head = "abc123";
      const gh = vi.fn(async (query: string, _variables?: unknown) =>
        query.startsWith("mutation")
          ? {}
          : pullData({
              isMergeQueueEnabled: queue,
              headRefOid: head,
              ...(head !== "abc123" && { title: "Pushed again" }),
            }),
      );
      render(
        <GitHubPanel
          target={pull}
          close={() => {}}
          gh={gh as unknown as GitHubCli}
        />,
      );
      await screen.findByRole("heading", { name: "Private change #9" });
      await user.click(
        screen.getByRole("button", {
          name: queue ? "Queue for merge" : "Squash and merge",
        }),
      );
      const dialog = await screen.findByRole("alertdialog");
      head = "def456";
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      await screen.findByRole("heading", { name: "Pushed again #9" });
      expect(dialog).not.toBeInTheDocument();
      // Confirming again names the head now shown.
      await user.click(
        screen.getByRole("button", {
          name: queue ? "Queue for merge" : "Squash and merge",
        }),
      );
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: queue ? "Queue for merge" : "Merge",
        }),
      );
      await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(4));
      expect(gh.mock.calls[2]?.[1]).toEqual({
        input: {
          pullRequestId: "PR_9",
          expectedHeadOid: "def456",
          ...(!queue && { mergeMethod: "SQUASH" }),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "closes the merge confirmation when the pull request is retargeted, for good (queue=%s)",
  async (queue) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let base = "main";
      const gh = vi.fn(async () =>
        pullData({
          isMergeQueueEnabled: queue,
          baseRefName: base,
          ...(base !== "main" && { title: "Retargeted" }),
        }),
      );
      render(
        <GitHubPanel
          target={pull}
          close={() => {}}
          gh={gh as unknown as GitHubCli}
        />,
      );
      await screen.findByRole("heading", { name: "Private change #9" });
      await user.click(
        screen.getByRole("button", {
          name: queue ? "Queue for merge" : "Squash and merge",
        }),
      );
      const dialog = await screen.findByRole("alertdialog");
      base = "release";
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      await screen.findByRole("heading", { name: "Retargeted #9" });
      expect(dialog).not.toBeInTheDocument();
      // Changing back does not open it again without another click.
      base = "main";
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      await screen.findByRole("heading", { name: "Private change #9" });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("says when threads beyond the latest 100 went unread, and gates actions on GitHub's viewer flags", async () => {
  const gh = vi.fn(async () =>
    pullData({
      mergeStateStatus: "BEHIND",
      viewerCanUpdateBranch: false,
      reviewThreads: { totalCount: 101, nodes: [{ isResolved: true }] },
    }),
  );
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(row("Threads")).toHaveTextContent("0 unresolved in the latest 100");
  expect(
    screen.queryByRole("button", { name: "Update branch" }),
  ).not.toBeInTheDocument();
});

it("keeps the confirmation open with GitHub's reason when a merge fails, under StrictMode", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation"))
      throw new GitHubError(
        "Head branch was modified. Review and try the merge again.",
      );
    return pullData();
  });
  // StrictMode replays effect cleanup, which must not leave the panel deaf.
  render(
    <StrictMode>
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />
    </StrictMode>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Squash and merge" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Merge" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Head branch was modified",
  );
});

it("offers a bypass merge to admins, and other methods and drafting in the menu", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async () =>
    pullData({ mergeStateStatus: "BLOCKED", viewerCanMergeAsAdmin: true }),
  );
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  const merge = await screen.findByRole("button", { name: "Squash and merge" });
  expect(merge).toHaveAttribute("data-variant", "attention");
  expect(row("Merge")).toHaveTextContent("you can bypass them");
  await user.click(
    screen.getByRole("button", { name: "More pull request actions" }),
  );
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["Create a merge commit", "Convert to draft"]);
  await user.click(
    screen.getByRole("menuitem", { name: "Create a merge commit" }),
  );
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "This bypasses main’s branch rules",
  );
});

it("opens the merge confirmation without an earlier action's error", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation"))
      throw new GitHubError("Could not convert to draft");
    return pullData({ viewerCanMergeAsAdmin: true });
  });
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "More pull request actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Convert to draft" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not convert to draft",
  );
  await user.click(screen.getByRole("button", { name: "Squash and merge" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
});

it("marks a draft ready for review, and offers auto-merge while blocked", async () => {
  const user = userEvent.setup();
  let draft = true;
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation")) {
      draft = false;
      return {};
    }
    return pullData({
      isDraft: draft,
      mergeStateStatus: draft ? "DRAFT" : "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
      latestOpinionatedReviews: { nodes: [] },
      reviewRequests: {
        nodes: [{ requestedReviewer: { login: "wes" } }],
      },
    });
  });
  const { rerender } = render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Ready for review" }),
  );
  expect(
    screen.getByRole("button", { name: "Submit review" }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Ready for review" }),
    ).not.toBeInTheDocument(),
  );
  expect(gh.mock.calls[1]?.[0]).toContain("markPullRequestReadyForReview");
  expect(row("Review")).toHaveTextContent("Required · waiting on wes");
  expect(
    screen.queryByRole("button", { name: "Merge when ready" }),
  ).not.toBeInTheDocument();
  // Where the repository allows it, a blocked pull request can merge itself.
  gh.mockImplementation(async () =>
    pullData({ mergeStateStatus: "BLOCKED", viewerCanEnableAutoMerge: true }),
  );
  rerender(
    <GitHubPanel
      target={`${pull}0`}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "Merge when ready" }),
  ).toBeInTheDocument();
});

it("reads an open pull request again while the panel is open", async () => {
  vi.useFakeTimers();
  try {
    const gh = vi.fn(async () => pullData());
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await vi.waitFor(() =>
      screen.getByRole("heading", { name: "Private change #9" }),
    );
    expect(gh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(gh).toHaveBeenCalledTimes(2);
    // A merged pull request doesn't change, so it isn't read again.
    gh.mockImplementation(async () => pullData({ state: "MERGED" }));
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(gh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(gh).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a required review pending while an approval is in", async () => {
  const gh = vi.fn(async () =>
    pullData({
      reviewDecision: "REVIEW_REQUIRED",
      reviewRequests: {
        nodes: [{ requestedReviewer: { login: "kalvin" } }],
      },
    }),
  );
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(row("Review")).toHaveTextContent(
    "Required · approved by wes · waiting on kalvin",
  );
});

it("places each resolution action in its matching checklist row", async () => {
  const data = pullData({ mergeStateStatus: "DIRTY" });
  const check =
    data.r0.pullRequest.commits.nodes[0]?.commit.statusCheckRollup.contexts
      .nodes[0];
  if (!check) throw new Error("Missing fixture check");
  check.conclusion = "FAILURE";
  const gh = vi.fn(async () => data) as GitHubCli;
  render(
    <GitHubPanel
      target="https://github.com/block/private/pull/9"
      close={() => {}}
      gh={gh}
      resolveActions={(_url, _pull, action) => (
        <button type="button">Resolve {action}</button>
      )}
    />,
  );
  await screen.findByRole("button", { name: "Resolve failures" });
  expect(
    within(row("Checks")).getByRole("button", { name: "Resolve failures" }),
  ).toBeInTheDocument();
  expect(
    within(row("Merge")).getByRole("button", { name: "Resolve conflicts" }),
  ).toBeInTheDocument();
  expect(within(row("Review")).queryByRole("button")).not.toBeInTheDocument();
  expect(within(row("Threads")).queryByRole("button")).not.toBeInTheDocument();
});

const reviewMutation =
  "mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){clientMutationId}}";

const patch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1 @@
+Hello
`;

it("approves someone else's pull request without a comment, at the head it showed", async () => {
  const user = userEvent.setup();
  let approved = false;
  const gh = vi.fn(async (query: string, _variables?: unknown) => {
    if (query.startsWith("mutation")) {
      approved = true;
      return {};
    }
    return pullData({
      reviewDecision: approved ? "APPROVED" : "REVIEW_REQUIRED",
      latestOpinionatedReviews: {
        nodes: approved ? [{ author: { login: "me" }, state: "APPROVED" }] : [],
      },
    });
  });
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
    { wrapper: ToastProvider },
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  await user.click(screen.getByRole("button", { name: "Submit review" }));
  const popup = await screen.findByRole("dialog", { name: "Submit review" });
  const submit = within(popup).getByRole("button", { name: "Submit review" });
  // A comment, or a change request, needs something to say. The field says
  // so, and Submit stays reachable from the keyboard.
  expect(within(popup).getByRole("radio", { name: /^Comment/ })).toBeChecked();
  expect(within(popup).getByRole("textbox")).toHaveFocus();
  expect(within(popup).getByRole("textbox")).toHaveAccessibleDescription(
    "Required unless you approve.",
  );
  await user.tab();
  await user.tab();
  expect(submit).toHaveFocus();
  expect(submit).toHaveAttribute("aria-disabled", "true");
  await user.click(submit);
  await user.click(within(popup).getByRole("radio", { name: /^Request/ }));
  expect(submit).toHaveAttribute("aria-disabled", "true");
  expect(gh).toHaveBeenCalledTimes(1);
  await user.click(within(popup).getByRole("radio", { name: /^Approve/ }));
  expect(within(popup).getByText("Optional")).toBeInTheDocument();
  await user.click(submit);
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Submit review" }),
    ).not.toBeInTheDocument(),
  );
  expect(row("Review")).toHaveTextContent("Approved by me");
  expect(await screen.findByText("Review submitted")).toBeInTheDocument();
  expect(gh.mock.calls[1]).toEqual([
    reviewMutation,
    { input: { pullRequestId: "PR_9", commitOID: "abc123", event: "APPROVE" } },
    undefined,
  ]);
});

it("shows a pull request's changes under Changes, with its line counts", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async () => pullData());
  const diff = vi.fn(async () => patch);
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
      diff={diff}
    />,
    { wrapper: ToastProvider },
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(diff).not.toHaveBeenCalled();
  const changes = screen.getByRole("tab", { name: /^Changes/ });
  expect(changes).toHaveTextContent("+3 −1");
  await user.click(changes);
  expect(
    await screen.findByRole("region", { name: "src/app.ts" }),
  ).toHaveTextContent("+1−1");
  expect(screen.getByRole("region", { name: "README.md" })).toHaveTextContent(
    "New file",
  );
  expect(
    screen.queryByRole("heading", { name: "Private change #9" }),
  ).not.toBeInTheDocument();
  // Reviewing stays a click away while reading the changes.
  expect(
    screen.getByRole("button", { name: "Submit review" }),
  ).toBeInTheDocument();
  expect(diff).toHaveBeenCalledWith(
    {
      repository: "block/private",
      base: "main",
      head: "abc123",
      merged: undefined,
    },
    expect.any(AbortSignal),
  );
  await user.click(screen.getByRole("tab", { name: "Summary" }));
  expect(
    screen.getByRole("heading", { name: "Private change #9" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "src/app.ts" }),
  ).not.toBeInTheDocument();
  await user.click(changes);
  expect(screen.getByRole("region", { name: "src/app.ts" })).toBeVisible();
  expect(diff).toHaveBeenCalledTimes(1);
});

it("opens a pull request again on the view and unsent review it was left with", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async (query: string, _variables?: unknown) =>
    query.startsWith("mutation") ? {} : pullData(),
  );
  const diff = vi.fn(async () => patch);
  // The plugin's, so it outlives a panel the channel unmounts on leaving.
  const memory = createPanelMemory();
  const panel = () => (
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
      diff={diff}
      memory={memory}
    />
  );
  const first = render(panel(), { wrapper: ToastProvider });
  await screen.findByRole("heading", { name: "Private change #9" });
  await user.click(screen.getByRole("button", { name: "Submit review" }));
  let popup = await screen.findByRole("dialog", { name: "Submit review" });
  await user.click(within(popup).getByRole("radio", { name: /^Request/ }));
  await user.type(within(popup).getByRole("textbox"), "Needs a test");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(popup).not.toBeInTheDocument());
  await user.click(screen.getByRole("tab", { name: /^Changes/ }));
  await screen.findByRole("region", { name: "src/app.ts" });
  first.unmount();

  render(panel(), { wrapper: ToastProvider });
  expect(await screen.findByRole("tab", { name: /^Changes/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The diff is read again, as the pull request is on every open.
  expect(
    await screen.findByRole("region", { name: "src/app.ts" }),
  ).toBeVisible();
  expect(diff).toHaveBeenCalledTimes(2);
  expect(
    screen.queryByRole("heading", { name: "Private change #9" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Submit review" }));
  popup = await screen.findByRole("dialog", { name: "Submit review" });
  expect(within(popup).getByRole("radio", { name: /^Request/ })).toBeChecked();
  expect(within(popup).getByRole("textbox")).toHaveValue("Needs a test");
  await user.click(
    within(popup).getByRole("button", { name: "Submit review" }),
  );
  await waitFor(() => expect(popup).not.toBeInTheDocument());
  expect(
    gh.mock.calls.find(([query]) => query.startsWith("mutation"))?.[1],
  ).toEqual({
    input: {
      pullRequestId: "PR_9",
      commitOID: "abc123",
      event: "REQUEST_CHANGES",
      body: "Needs a test",
    },
  });
  // Once it is in, the next panel on it starts a fresh review.
  expect(memory.get(pull)).toEqual({ view: "changes", review: undefined });
});

it("starts on Summary in another channel, with the pull request's unsent review", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async () => pullData());
  const memory = createPanelMemory();
  const panel = (channelId: string) => (
    <GitHubPanel
      target={pull}
      close={() => {}}
      context={{ channelId, canOpen: () => false, open: () => false }}
      gh={gh as unknown as GitHubCli}
      diff={async () => patch}
      memory={memory}
    />
  );
  const alpha = render(panel("alpha"), { wrapper: ToastProvider });
  await screen.findByRole("heading", { name: "Private change #9" });
  await user.click(screen.getByRole("tab", { name: /^Changes/ }));
  await user.click(screen.getByRole("button", { name: "Submit review" }));
  let popup = await screen.findByRole("dialog", { name: "Submit review" });
  await user.type(within(popup).getByRole("textbox"), "Looks right");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(popup).not.toBeInTheDocument());
  alpha.unmount();

  // A first look from elsewhere starts at the title; the review waits there.
  const beta = render(panel("beta"), { wrapper: ToastProvider });
  expect(await screen.findByRole("tab", { name: "Summary" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.getByRole("heading", { name: "Private change #9" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Submit review" }));
  popup = await screen.findByRole("dialog", { name: "Submit review" });
  expect(within(popup).getByRole("textbox")).toHaveValue("Looks right");
  beta.unmount();

  render(panel("alpha"), { wrapper: ToastProvider });
  expect(await screen.findByRole("tab", { name: /^Changes/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it.each([
  ["goes in", false, ""],
  ["is refused", true, "Looks right"],
])(
  "offers a review sent as its panel unmounted to the next panel only if it is refused: %s",
  async (_, refused, offered) => {
    const user = userEvent.setup();
    let release!: () => void;
    const gh = vi.fn(async (query: string, _variables?: unknown) => {
      if (!query.startsWith("mutation")) return pullData();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (refused) throw new GitHubError("Pull request is locked");
      return {};
    });
    const memory = createPanelMemory();
    const panel = () => (
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
        memory={memory}
      />
    );
    const first = render(panel(), { wrapper: ToastProvider });
    await screen.findByRole("heading", { name: "Private change #9" });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    let popup = await screen.findByRole("dialog", { name: "Submit review" });
    await user.type(within(popup).getByRole("textbox"), "Looks right");
    await user.click(
      within(popup).getByRole("button", { name: "Submit review" }),
    );
    await waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
    // Leaving the channel and coming back before GitHub answers doesn't
    // stop the review going in, so the panel there can't send it again.
    first.unmount();
    render(panel(), { wrapper: ToastProvider });
    await screen.findByRole("heading", { name: "Private change #9" });
    const trigger = screen.getByRole("button", { name: "Submit review" });
    await user.click(trigger);
    popup = await screen.findByRole("dialog", { name: "Submit review" });
    expect(within(popup).getByRole("textbox")).toHaveValue("");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(popup).not.toBeInTheDocument());
    release();
    await waitFor(() =>
      expect(memory.get(pull).review?.body ?? "").toBe(offered),
    );
    await user.click(trigger);
    popup = await screen.findByRole("dialog", { name: "Submit review" });
    expect(
      within(popup).getByRole("radio", { name: /^Comment/ }),
    ).toBeChecked();
    expect(within(popup).getByRole("textbox")).toHaveValue(offered);
  },
);

it("drops a review another panel on the pull request sent", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async (query: string, _variables?: unknown) =>
    query.startsWith("mutation") ? {} : pullData(),
  );
  const memory = createPanelMemory();
  const panel = () => (
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
      memory={memory}
    />
  );
  // Two tabs on one pull request, as /pull/9 and /pull/9/ would be.
  const first = within(render(panel(), { wrapper: ToastProvider }).container);
  const second = within(render(panel(), { wrapper: ToastProvider }).container);
  const review = async (view: typeof first) => {
    await view.findByRole("heading", { name: "Private change #9" });
    await user.click(view.getByRole("button", { name: "Submit review" }));
    return screen.findByRole("dialog", { name: "Submit review" });
  };
  const dismiss = async (popup: HTMLElement) => {
    await user.keyboard("{Escape}");
    await waitFor(() => expect(popup).not.toBeInTheDocument());
  };
  let popup = await review(first);
  await user.type(within(popup).getByRole("textbox"), "Looks right");
  await dismiss(popup);
  popup = await review(second);
  expect(within(popup).getByRole("textbox")).toHaveValue("Looks right");
  await dismiss(popup);
  popup = await review(first);
  await user.click(
    within(popup).getByRole("button", { name: "Submit review" }),
  );
  await waitFor(() => expect(popup).not.toBeInTheDocument());
  popup = await review(second);
  expect(within(popup).getByRole("radio", { name: /^Comment/ })).toBeChecked();
  expect(within(popup).getByRole("textbox")).toHaveValue("");
});

it.each([
  ["sent", false, undefined],
  ["refused, then sent on an unedited retry", true, false],
  ["refused, then refused again on an unedited retry", true, true],
])(
  "keeps a draft written in another tab while a review was %s from this one",
  async (_outcome, refuse, retryRefused) => {
    const user = userEvent.setup();
    let release!: () => void;
    let refuseNext = refuse;
    const gh = vi.fn(async (query: string, _variables?: unknown) => {
      if (!query.startsWith("mutation")) return pullData();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (refuseNext) throw new GitHubError("Pull request is locked");
      return {};
    });
    const memory = createPanelMemory();
    const panel = () => (
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
        memory={memory}
      />
    );
    // Two tabs on one pull request, both staying mounted once shown.
    const first = within(render(panel(), { wrapper: ToastProvider }).container);
    const second = within(
      render(panel(), { wrapper: ToastProvider }).container,
    );
    await first.findByRole("heading", { name: "Private change #9" });
    await second.findByRole("heading", { name: "Private change #9" });
    await user.click(first.getByRole("button", { name: "Submit review" }));
    const sending = await screen.findByRole("dialog", {
      name: "Submit review",
    });
    await user.type(within(sending).getByRole("textbox"), "Looks right");
    await user.click(
      within(sending).getByRole("button", { name: "Submit review" }),
    );
    await waitFor(() =>
      expect(within(sending).getByRole("textbox")).toBeDisabled(),
    );
    // While it goes in, the other tab writes a new review and puts it away.
    await user.click(second.getByRole("button", { name: "Submit review" }));
    const popups = await screen.findAllByRole("dialog", {
      name: "Submit review",
    });
    const drafting = popups.find((popup) => popup !== sending);
    if (!drafting) throw new Error("Missing the second tab's popover");
    await user.click(within(drafting).getByRole("radio", { name: /^Request/ }));
    await user.type(within(drafting).getByRole("textbox"), "Needs a test");
    await user.click(within(drafting).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(drafting).not.toBeInTheDocument());
    release();
    if (refuse) {
      expect(await within(sending).findByRole("alert")).toHaveTextContent(
        "Pull request is locked",
      );
      expect(within(sending).getByRole("textbox")).toHaveValue("Looks right");
    } else await waitFor(() => expect(sending).not.toBeInTheDocument());
    // However the first ends, the second's draft is the one remembered.
    const drafted = {
      event: "REQUEST_CHANGES",
      body: "Needs a test",
      head: "abc123",
    };
    expect(memory.get(pull).review).toEqual(drafted);
    if (retryRefused !== undefined) {
      // The first tab still shows its refused review. Retrying it as it
      // stands sends only it; the second tab's newer draft is not its to
      // clear, however the retry ends.
      refuseNext = retryRefused;
      await user.click(
        within(sending).getByRole("button", { name: "Submit review" }),
      );
      await waitFor(() =>
        expect(within(sending).getByRole("textbox")).toBeDisabled(),
      );
      release();
      if (retryRefused) {
        expect(await within(sending).findByRole("alert")).toHaveTextContent(
          "Pull request is locked",
        );
      } else await waitFor(() => expect(sending).not.toBeInTheDocument());
      expect(memory.get(pull).review).toEqual(drafted);
    }
    await user.click(second.getByRole("button", { name: "Submit review" }));
    const popup = (
      await screen.findAllByRole("dialog", { name: "Submit review" })
    ).find((candidate) => candidate !== sending);
    if (!popup) throw new Error("Missing the second tab's popover");
    expect(
      within(popup).getByRole("radio", { name: /^Request/ }),
    ).toBeChecked();
    expect(within(popup).getByRole("textbox")).toHaveValue("Needs a test");
  },
);

it("keeps a review going in out of memory when a push lands meanwhile", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let pushed = false;
    let release!: () => void;
    const gh = vi.fn(async (query: string, _variables?: unknown) => {
      if (!query.startsWith("mutation"))
        return pullData(
          pushed ? { headRefOid: "def456", title: "Pushed again" } : {},
        );
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {};
    });
    const memory = createPanelMemory();
    const panel = () => (
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
        memory={memory}
      />
    );
    const first = render(panel(), { wrapper: ToastProvider });
    await screen.findByRole("heading", { name: "Private change #9" });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    let popup = await screen.findByRole("dialog", { name: "Submit review" });
    await user.type(within(popup).getByRole("textbox"), "Looks right");
    await user.click(
      within(popup).getByRole("button", { name: "Submit review" }),
    );
    await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
    // A push lands while it goes in. Taking it then changes nothing, so the
    // review stays out of memory however this panel ends.
    pushed = true;
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await screen.findByRole("heading", { name: "Pushed again #9" });
    await user.click(
      within(popup).getByRole("button", { name: "Use latest commit" }),
    );
    first.unmount();
    render(panel(), { wrapper: ToastProvider });
    await screen.findByRole("heading", { name: "Pushed again #9" });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    popup = await screen.findByRole("dialog", { name: "Submit review" });
    expect(
      within(popup).getByRole("radio", { name: /^Comment/ }),
    ).toBeChecked();
    expect(within(popup).getByRole("textbox")).toHaveValue("");
    release();
  } finally {
    vi.useRealTimers();
  }
});

it("asks about a newer push only for a remembered review with text", async () => {
  const user = userEvent.setup();
  let head = "abc123";
  const gh = vi.fn(async () => pullData({ headRefOid: head }));
  const memory = createPanelMemory();
  const reopen = async () => {
    cleanup();
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
        memory={memory}
      />,
      { wrapper: ToastProvider },
    );
    await screen.findByRole("heading", { name: "Private change #9" });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    return screen.findByRole("dialog", { name: "Submit review" });
  };
  let popup = await reopen();
  // A decision with only spaces is no draft, so it waits on no push.
  await user.click(within(popup).getByRole("radio", { name: /^Request/ }));
  await user.type(within(popup).getByRole("textbox"), "   ");
  head = "def456";
  popup = await reopen();
  expect(within(popup).getByRole("radio", { name: /^Comment/ })).toBeChecked();
  expect(within(popup).getByRole("textbox")).toHaveValue("");
  expect(within(popup).queryByRole("status")).not.toBeInTheDocument();
  await user.type(within(popup).getByRole("textbox"), "Looks right");
  head = "0a1b2c3";
  popup = await reopen();
  expect(within(popup).getByRole("textbox")).toHaveValue("Looks right");
  expect(within(popup).getByRole("status")).toHaveTextContent(
    "New commits were pushed after you started this review.",
  );
  expect(
    within(popup).getByRole("button", { name: "Submit review" }),
  ).toHaveAttribute("aria-disabled", "true");
});

it("reads a merged pull request's changes by its number", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async () => pullData({ state: "MERGED" }));
  const diff = vi.fn(async () => patch);
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
      diff={diff}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  await user.click(screen.getByRole("tab", { name: /^Changes/ }));
  expect(
    await screen.findByRole("region", { name: "src/app.ts" }),
  ).toBeInTheDocument();
  expect(diff).toHaveBeenCalledWith(
    { repository: "block/private", base: "main", head: "abc123", merged: 9 },
    expect.any(AbortSignal),
  );
});

it("points to GitHub when the changes cannot be shown", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async () => pullData());
  const diff = vi.fn(async () => {
    throw new OutputTooLarge();
  });
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
      diff={diff}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  await user.click(screen.getByRole("tab", { name: /^Changes/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This diff is too large to show here.",
  );
  expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
    "href",
    `${pull}/files`,
  );
});

it("shows a file the parser cannot render as raw text beside the rest", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async () => pullData({ viewerDidAuthor: true }));
  const binary = `diff --git a/logo.png b/logo.png
GIT binary patch
literal 1
Ic${"$"}@
`;
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
      diff={async () => patch + binary}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  // The viewer's own pull request takes no review, but its changes show.
  expect(
    screen.queryByRole("button", { name: "Submit review" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: /^Changes/ }));
  expect(
    await screen.findByRole("region", { name: "src/app.ts" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Raw diff" })).toHaveTextContent(
    "GIT binary patch",
  );
});

it("keeps a refused review's draft with GitHub's reason, and clears it once it is in", async () => {
  const user = userEvent.setup();
  let refuse = true;
  let release!: () => void;
  const gh = vi.fn(async (query: string, _variables?: unknown) => {
    if (!query.startsWith("mutation")) return pullData();
    if (refuse) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new GitHubError("Can not request changes on a locked pull request");
    }
    return {};
  });
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  const trigger = screen.getByRole("button", { name: "Submit review" });
  await user.click(trigger);
  let popup = await screen.findByRole("dialog", { name: "Submit review" });
  await user.click(within(popup).getByRole("radio", { name: /^Request/ }));
  await user.type(within(popup).getByRole("textbox"), "Needs a test");
  await user.click(
    within(popup).getByRole("button", { name: "Submit review" }),
  );
  await waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
  // Pending, it holds: no edits, and no dismissing it.
  try {
    expect(within(popup).getByRole("textbox")).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(popup).toBeInTheDocument();
  } finally {
    release();
  }
  expect(await within(popup).findByRole("alert")).toHaveTextContent(
    "Can not request changes on a locked pull request",
  );
  expect(within(popup).getByRole("textbox")).toHaveValue("Needs a test");
  // Dismissed and reopened, the draft is still there without the old reason.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(popup).not.toBeInTheDocument());
  await user.click(trigger);
  popup = await screen.findByRole("dialog", { name: "Submit review" });
  expect(within(popup).getByRole("radio", { name: /^Request/ })).toBeChecked();
  expect(within(popup).getByRole("textbox")).toHaveValue("Needs a test");
  expect(within(popup).queryByRole("alert")).not.toBeInTheDocument();
  refuse = false;
  await user.click(
    within(popup).getByRole("button", { name: "Submit review" }),
  );
  await waitFor(() => expect(popup).not.toBeInTheDocument());
  expect(gh.mock.calls.at(-2)?.[1]).toEqual({
    input: {
      pullRequestId: "PR_9",
      commitOID: "abc123",
      event: "REQUEST_CHANGES",
      body: "Needs a test",
    },
  });
  await user.click(trigger);
  popup = await screen.findByRole("dialog", { name: "Submit review" });
  expect(within(popup).getByRole("radio", { name: /^Comment/ })).toBeChecked();
  expect(within(popup).getByRole("textbox")).toHaveValue("");
});

it("asks before a review goes in against a push that arrived mid-draft", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let read = 0;
    const gh = vi.fn(async (query: string, _variables?: unknown) =>
      query.startsWith("mutation")
        ? {}
        : pullData(
            read === 0
              ? {}
              : read === 1
                ? { headRefOid: "def456", title: "Pushed again" }
                : {
                    headRefOid: "def456",
                    state: "MERGED",
                    mergedBy: { login: "baxen" },
                  },
          ),
    );
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await screen.findByRole("heading", { name: "Private change #9" });
    const trigger = screen.getByRole("button", { name: "Submit review" });
    await user.click(trigger);
    let popup = await screen.findByRole("dialog", { name: "Submit review" });
    await user.type(within(popup).getByRole("textbox"), "Looks right");
    read = 1;
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await screen.findByRole("heading", { name: "Pushed again #9" });
    expect(within(popup).getByRole("status")).toHaveTextContent(
      "New commits were pushed after you started this review.",
    );
    expect(
      within(popup).getByRole("button", { name: "Submit review" }),
    ).toHaveAttribute("aria-disabled", "true");
    // Dismissed and reopened, the draft still waits on that choice.
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(popup).not.toBeInTheDocument());
    await user.click(trigger);
    popup = await screen.findByRole("dialog", { name: "Submit review" });
    expect(within(popup).getByRole("textbox")).toHaveValue("Looks right");
    await user.click(
      within(popup).getByRole("button", { name: "Use latest commit" }),
    );
    expect(within(popup).queryByRole("status")).not.toBeInTheDocument();
    // Merged meanwhile, the open review keeps its draft and says so.
    read = 2;
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await screen.findByText(/Merged into/);
    expect(within(popup).getByRole("status")).toHaveTextContent(
      "This pull request merged.",
    );
    expect(within(popup).getByRole("textbox")).toHaveValue("Looks right");
    await user.click(
      within(popup).getByRole("button", { name: "Submit review" }),
    );
    await vi.waitFor(() => expect(popup).not.toBeInTheDocument());
    expect(gh.mock.calls[3]?.[1]).toEqual({
      input: {
        pullRequestId: "PR_9",
        commitOID: "def456",
        event: "COMMENT",
        body: "Looks right",
      },
    });
    expect(
      screen.queryByRole("button", { name: "Submit review" }),
    ).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("asks before an approval without text goes in against a push since it was chosen", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let pushed = false;
    const gh = vi.fn(async (query: string, _variables?: unknown) =>
      query.startsWith("mutation")
        ? {}
        : pullData(
            pushed ? { headRefOid: "def456", title: "Pushed again" } : {},
          ),
    );
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await screen.findByRole("heading", { name: "Private change #9" });
    const trigger = screen.getByRole("button", { name: "Submit review" });
    await user.click(trigger);
    let popup = await screen.findByRole("dialog", { name: "Submit review" });
    await user.click(within(popup).getByRole("radio", { name: /^Approve/ }));
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(popup).not.toBeInTheDocument());
    pushed = true;
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await screen.findByRole("heading", { name: "Pushed again #9" });
    await user.click(trigger);
    popup = await screen.findByRole("dialog", { name: "Submit review" });
    expect(
      within(popup).getByRole("radio", { name: /^Approve/ }),
    ).toBeChecked();
    expect(within(popup).getByRole("status")).toHaveTextContent(
      "New commits were pushed after you started this review.",
    );
    expect(
      within(popup).getByRole("button", { name: "Submit review" }),
    ).toHaveAttribute("aria-disabled", "true");
  } finally {
    vi.useRealTimers();
  }
});

it("offers no review on the viewer's own pull request", async () => {
  const gh = vi.fn(async () => pullData({ viewerDidAuthor: true }));
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(
    screen.queryByRole("button", { name: "Submit review" }),
  ).not.toBeInTheDocument();
});

it("retries a transient gh failure on opening quietly", async () => {
  const gh = vi
    .fn()
    .mockRejectedValueOnce(new GitHubError("down", "SERVICE_UNAVAILABLE"))
    .mockImplementation(async () => pullData());
  vi.useFakeTimers();
  try {
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
    // The first retry waits at most a second.
    await vi.advanceTimersByTimeAsync(1000);
    expect(gh).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Private change #9" }),
      ).toBeVisible(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("reads through the plugin's store, so a link and the panel on one pull request cost one read", async () => {
  const gh = vi.fn(async (_query: string) => pullData());
  const states = createPullStates(gh as unknown as GitHubCli);
  const link = vi.fn();
  const unwatch = states.watch(pull, link);
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
      states={states}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(gh).toHaveBeenCalledOnce();
  // The one query carries what the panel shows beside the link's state.
  expect(gh.mock.calls[0]?.[0]).toContain("reviewThreads");
  expect(states.get(pull)).toMatchObject({ state: "open", head: "abc123" });
  expect(link).toHaveBeenCalled();
  unwatch();
});

it("reads GitHub each time the panel opens, even with the details just read", async () => {
  const gh = vi.fn(async (_query: string) => pullData());
  const states = createPullStates(gh as unknown as GitHubCli);
  const panel = () => (
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
      states={states}
    />
  );
  const first = render(panel());
  await screen.findByRole("heading", { name: "Private change #9" });
  first.unmount();
  expect(gh).toHaveBeenCalledOnce();
  render(panel());
  await waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
});

it("shows public checks the store read for the head, without gh", async () => {
  const fetch = vi.fn(async (input: string) =>
    Response.json(
      input.endsWith("/pulls/3")
        ? { title: "Public change", state: "open", head: { sha: "f00d" } }
        : input.includes("/check-runs")
          ? {
              total_count: 1,
              check_runs: [
                { name: "unit", status: "completed", conclusion: "failure" },
              ],
            }
          : { total_count: 0, statuses: [] },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <GitHubPanel
      target="https://github.com/example/project/pull/3"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Public change #3" });
  await waitFor(() => expect(row("Checks")).toHaveTextContent("1 failed"));
  expect(
    fetch.mock.calls.filter(([input]) => input.includes("/commits/f00d/")),
  ).toHaveLength(2);
});

it("shows the latest the store read when a refresh fails, then what it reads next", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let answer: "first" | "fail" | "next" = "first";
    const gh = vi.fn(async () => {
      if (answer === "fail")
        throw new GitHubError("Not found", "NOT_FOUND", {
          r0: { pullRequest: null },
        });
      return pullData(answer === "next" ? { title: "Renamed" } : {});
    });
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await screen.findByRole("heading", { name: "Private change #9" });
    answer = "fail";
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("heading", { name: "Private change #9" }),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    answer = "next";
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await screen.findByRole("heading", { name: "Renamed #9" });
  } finally {
    vi.useRealTimers();
  }
});
