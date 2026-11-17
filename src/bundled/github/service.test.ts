// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { GitHubCli } from "./gh";
import { addPullStateTool } from "./pull-state-tool";
import { createPullStates } from "./pull-states";
import { gitHubPulls } from "./service";

const pull = "https://github.com/block/buzz-app/pull/7";
const second = "https://github.com/block/buzz/pull/9";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rollup = (state: string, isDraft = false) => ({
  pullRequest: {
    state,
    isDraft,
    mergeStateStatus: "CLEAN",
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  },
});

it("gives other plugins the states links read, and never reads GitHub itself", async () => {
  const gh = vi.fn(async () => ({
    r0: rollup("MERGED"),
    r1: rollup("OPEN", true),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const heard = vi.fn();
  const stop = github.subscribe(heard);

  // Asking about a pull request nobody shows reads nothing.
  expect(github.prState(pull)).toBeUndefined();
  expect(
    github.prState("https://github.com/block/buzz-app/issues/7"),
  ).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(gh).not.toHaveBeenCalled();
  expect(heard).not.toHaveBeenCalled();

  // A link shown in a message reads both; the observer hears of it.
  const unwatch = [
    states.watch(pull, () => {}),
    states.watch(second, () => {}),
  ];
  await vi.waitFor(() => expect(heard).toHaveBeenCalled());
  expect(gh).toHaveBeenCalledOnce();
  expect(github.prState(pull)?.state).toBe("merged");
  // The same pull request, however its link is written.
  expect(
    github.prState("https://github.com/Block/Buzz-App/pull/7/files")?.state,
  ).toBe("merged");
  expect(github.prState(second)?.state).toBe("draft");

  stop();
  for (const end of unwatch) end();
  expect(Object.isFrozen(github)).toBe(true);
});

it("gives nothing for an issue the links hold, though its read is announced", async () => {
  const issue = "https://github.com/block/buzz-app/issues/8";
  const gh = vi.fn(async () => ({
    r0: { issue: { state: "CLOSED", stateReason: "COMPLETED", title: "Done" } },
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const heard = vi.fn();
  github.subscribe(heard);
  const unwatch = states.watch(issue, () => {});
  await vi.waitFor(() => expect(heard).toHaveBeenCalled());
  // The store holds the issue's state for its link; this is pull requests'.
  expect(states.get(issue)).toMatchObject({ state: "closed" });
  expect(github.prState(issue)).toBeUndefined();
  expect(github.prState(issue, { details: true })).toBeUndefined();
  unwatch();
});

it("stops telling an observer once it unsubscribes, and an observer alone keeps nothing read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let state = "OPEN";
  const gh = vi.fn(async () => ({
    r0: rollup(state),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const kept = vi.fn();
  const left = vi.fn();
  github.subscribe(kept);
  const stop = github.subscribe(left);
  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(kept).toHaveBeenCalledOnce());
  expect(left).toHaveBeenCalledOnce();
  stop();

  state = "MERGED";
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(kept).toHaveBeenCalledTimes(2));
  expect(left).toHaveBeenCalledOnce();
  expect(github.prState(pull)?.state).toBe("merged");

  // With the link gone, observing does not keep the pull request polled.
  unwatch();
  const reads = gh.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(gh.mock.calls.length).toBe(reads);
});

it("keeps reading, and telling the other observers, when one observer throws", async () => {
  const reported = vi.fn();
  vi.stubGlobal("reportError", reported);
  const gh = vi.fn(async () => ({
    r0: rollup("MERGED"),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const failure = new Error("observer failed");
  github.subscribe(() => {
    throw failure;
  });
  const after = vi.fn();
  github.subscribe(after);
  const watched = vi.fn();
  const unwatch = states.watch(pull, watched);
  await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
  expect(watched).toHaveBeenCalledOnce();
  expect(reported).toHaveBeenCalledWith(failure);
  expect(github.prState(pull)?.state).toBe("merged");
  expect(states.readAt(pull)?.error).toBeUndefined();
  unwatch();
});

it("answers as the agent tool github_pr_state does, without reading again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let fail = false;
  const gh = vi.fn(async () => {
    if (fail) throw new Error("socket hang up");
    return {
      r0: {
        pullRequest: {
          state: "OPEN",
          isDraft: false,
          mergeStateStatus: "DIRTY",
          headRefOid: "abc123",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: "FAILURE",
                    contexts: {
                      totalCount: 1,
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "unit",
                          status: "COMPLETED",
                          conclusion: "FAILURE",
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
    };
  }) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const tools: AddedTool[] = [];
  addPullStateTool({ addTool: (tool) => tools.push(tool) }, states);
  const tool = tools[0] as AddedTool;
  const ask = async (args: Record<string, unknown>) =>
    JSON.parse(
      String(await tool.call({} as BuzzClient, { channel: "c" }, args)),
    );

  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  const readAt = states.readAt(pull)?.readAt ?? 0;
  vi.setSystemTime(readAt + 12_000);
  const report = github.prState(pull);
  expect(report).toMatchObject({
    state: "open",
    checks: "failure",
    failed: ["unit"],
    conflicts: true,
    head: "abc123",
    age_seconds: 12,
    source: "gh",
  });
  // The tool answers the same from the same read, within its minute.
  expect(JSON.parse(JSON.stringify(report))).toEqual(await ask({ url: pull }));
  // Details nobody read are not there, and asking for them reads nothing.
  expect(github.prState(pull, { details: true })).not.toHaveProperty("details");
  expect(gh).toHaveBeenCalledOnce();

  // A plugin that changes its report changes nothing the app holds.
  (report?.failed as string[] | undefined)?.splice(0);
  expect(github.prState(pull)?.failed).toEqual(["unit"]);
  expect(await ask({ url: pull })).toMatchObject({ failed: ["unit"] });

  // When reading it again fails, both give the last state and why.
  fail = true;
  vi.setSystemTime(readAt + 120_000);
  const stale = await ask({ url: pull });
  expect(stale.last_read_failed).toBe("socket hang up");
  expect(JSON.parse(JSON.stringify(github.prState(pull)))).toEqual(stale);
  unwatch();
});

it("tells observers when reading again starts failing and when it works again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let fail: string | undefined;
  const gh = vi.fn(async () => {
    if (fail) throw new Error(fail);
    return { r0: rollup("OPEN") };
  }) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const tools: AddedTool[] = [];
  addPullStateTool({ addTool: (tool) => tools.push(tool) }, states);
  const tool = tools[0] as AddedTool;
  let at = Date.now();
  // Each asks a minute and more after the last, so the tool reads again.
  const read = async () => {
    at += 120_000;
    vi.setSystemTime(at);
    await tool.call({} as BuzzClient, { channel: "c" }, { url: pull });
  };
  const observed = vi.fn();
  github.subscribe(observed);

  await read();
  expect(observed).toHaveBeenCalledOnce();
  expect(github.prState(pull)).not.toHaveProperty("last_read_failed");

  fail = "socket hang up";
  await read();
  expect(github.prState(pull)?.last_read_failed).toBe("socket hang up");
  expect(observed).toHaveBeenCalledTimes(2);
  // Failing again the same way changes nothing an observer shows.
  await read();
  expect(observed).toHaveBeenCalledTimes(2);
  fail = "GitHub did not answer in time";
  await read();
  expect(observed).toHaveBeenCalledTimes(3);

  // It works again with the same state: what failed is gone, and told.
  fail = undefined;
  await read();
  expect(github.prState(pull)?.state).toBe("open");
  expect(github.prState(pull)).not.toHaveProperty("last_read_failed");
  expect(observed).toHaveBeenCalledTimes(4);
  // The same state read again only moves read_at, and is not told.
  await read();
  expect(observed).toHaveBeenCalledTimes(4);
  expect(gh).toHaveBeenCalledTimes(6);
});

it("gives each plugin its own copy of the details' lists and objects", async () => {
  const gh = vi.fn(async () => ({
    r0: {
      viewerDefaultMergeMethod: "SQUASH",
      squashMergeAllowed: true,
      pullRequest: {
        id: "PR_7",
        title: "A change",
        state: "OPEN",
        isDraft: false,
        body: "",
        author: { login: "wes" },
        baseRefName: "main",
        headRefName: "fix",
        headRefOid: "abc123",
        headRepository: { nameWithOwner: "block/buzz-app" },
        headRepositoryOwner: { login: "block" },
        baseRepository: { nameWithOwner: "block/buzz-app" },
        additions: 3,
        deletions: 1,
        changedFiles: 2,
        mergeStateStatus: "BLOCKED",
        reviewDecision: "REVIEW_REQUIRED",
        viewerCanUpdate: true,
        viewerCanUpdateBranch: false,
        viewerCanMergeAsAdmin: false,
        viewerCanEnableAutoMerge: true,
        viewerCanDisableAutoMerge: true,
        autoMergeRequest: {
          mergeMethod: "SQUASH",
          enabledBy: { login: "wes" },
        },
        reviewRequests: { nodes: [{ requestedReviewer: { login: "rae" } }] },
        latestOpinionatedReviews: { nodes: [] },
        reviewThreads: { totalCount: 0, nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      },
    },
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const unwatch = states.watch(pull, () => {}, "details");
  await vi.waitFor(() =>
    expect(states.get(pull)).toHaveProperty("details.checklist"),
  );
  const first = github.prState(pull, { details: true });
  const expected = structuredClone(first);
  const details = first?.details as {
    review: {
      approved: string[];
      changes_requested: string[];
      waiting: string[];
    };
    auto_merge: { method: string; by?: string };
  };
  expect(details.auto_merge).toEqual({ method: "SQUASH", by: "wes" });
  details.review.waiting.splice(0);
  details.review.approved.push("mallory");
  details.review.changes_requested.push("mallory");
  details.auto_merge.by = "mallory";
  expect(github.prState(pull, { details: true })).toEqual(expected);
  expect(gh).toHaveBeenCalledOnce();
  unwatch();
});
