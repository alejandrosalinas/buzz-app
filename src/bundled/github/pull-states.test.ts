// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import { GitHubRateLimited } from "./data";
import {
  BODY_CHARS,
  createPullStates,
  PANEL_REFRESH_MS,
  PUBLIC_READS_PER_HOUR,
  PUBLIC_READS_PER_POLL,
  PULL_REFRESH_MS,
  PULL_RETAIN_MS,
  PULL_SLOW_REFRESH_MS,
} from "./pull-states";

const pull = "https://github.com/block/buzz-app/pull/7";
const second = "https://github.com/block/buzz/pull/9";
const third = "https://github.com/block/goose/pull/3";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rollup = (
  state: string,
  extra: Record<string, unknown> = {},
  checks?: string,
) => ({
  pullRequest: {
    state,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    commits: {
      nodes: [
        { commit: { statusCheckRollup: checks ? { state: checks } : null } },
      ],
    },
    ...extra,
  },
});
const mockGh = (implementation: (...args: never[]) => unknown) =>
  vi.fn(implementation) as unknown as GitHubCli & ReturnType<typeof vi.fn>;

it("reads every watched pull request together, once, then again each minute while watched", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let checks = "FAILURE";
  const gh = mockGh(async () => ({
    r0: rollup("OPEN", { mergeStateStatus: "DIRTY" }, checks),
    r1: rollup("MERGED"),
  }));
  const states = createPullStates(gh);
  const changed = [vi.fn(), vi.fn(), vi.fn()] as const;
  const stop = [
    states.watch(pull, changed[0]),
    states.watch(pull, changed[1]),
    states.watch(second, changed[2]),
  ];
  await vi.waitFor(() => expect(states.get(second)).toBeDefined());
  // Two links to one pull request cost one read, and both hear of it.
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[1]).toEqual({
    o0: "block",
    n0: "buzz-app",
    p0: 7,
    o1: "block",
    n1: "buzz",
    p1: 9,
  });
  for (const listener of changed) expect(listener).toHaveBeenCalledOnce();
  expect(states.get(pull)).toEqual({
    state: "open",
    checks: "failure",
    conflicts: true,
  });
  expect(states.get(pull)).toBe(states.get(pull));
  expect(states.get(second)).toEqual({ state: "merged", conflicts: false });

  // Only the open one is polled: a merged pull request stays that way, and
  // whoever shows it is not told of a poll that did not touch it.
  checks = "SUCCESS";
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(gh.mock.calls[1]?.[1]).toEqual({ o0: "block", n0: "buzz-app", p0: 7 });
  expect(changed[0]).toHaveBeenCalledTimes(2);
  expect(changed[1]).toHaveBeenCalledTimes(2);
  expect(changed[2]).toHaveBeenCalledOnce();
  expect(states.get(pull)).toMatchObject({ checks: "success" });
  for (const unwatch of stop) unwatch();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS * 3);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("keeps the state object, and tells no one, when a poll reads the same state", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let checks = "PENDING";
  const gh = mockGh(async () => ({ r0: rollup("OPEN", {}, checks) }));
  const states = createPullStates(gh);
  const changed = vi.fn();
  states.watch(pull, changed);
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  const before = states.get(pull);
  // GitHub answers the same each time, so the links and sidebar rows showing
  // the pull request have nothing to re-render for.
  await vi.advanceTimersByTimeAsync(2 * PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(3);
  expect(states.get(pull)).toBe(before);
  expect(changed).toHaveBeenCalledOnce();
  checks = "SUCCESS";
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(states.get(pull)).not.toBe(before);
  expect(states.get(pull)).toMatchObject({ checks: "success" });
  expect(changed).toHaveBeenCalledTimes(2);
});

it("keeps one reader that throws from failing the read, or keeping it from the rest", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const gh = mockGh(async () => ({
    r0: rollup("OPEN", {}, "SUCCESS"),
    r1: rollup("OPEN", {}, "SUCCESS"),
  }));
  const states = createPullStates(gh);
  const broken = vi.fn(() => {
    throw new DOMException("The quota has been exceeded.");
  });
  const changed = vi.fn();
  states.watch(pull, broken);
  states.watch(second, changed);
  await vi.waitFor(() => expect(broken).toHaveBeenCalledOnce());
  expect(changed).toHaveBeenCalledOnce();
  expect(states.readAt(pull)?.error).toBeUndefined();
  expect(states.readAt(second)?.error).toBeUndefined();
});

it("reads the title with the state, so a poll renames a renamed pull request in the read it already makes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let title = "Fix the lab";
  const gh = mockGh(async () => ({ r0: rollup("OPEN", { title }) }));
  const states = createPullStates(gh);
  const changed = vi.fn();
  states.watch(pull, changed);
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  expect(states.get(pull)).toEqual({
    state: "open",
    title: "Fix the lab",
    conflicts: false,
  });
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[0]).toMatch(
    /pullRequest\(number:\$p0\)\{state title /,
  );
  const before = states.get(pull);
  title = "Fix the lab, renamed";
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(states.get(pull)).not.toBe(before);
  expect(states.get(pull)).toMatchObject({ title: "Fix the lab, renamed" });
  expect(changed).toHaveBeenCalledTimes(2);

  // From the public API too: the title is in the pull request it reads.
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ title, state: "open" })),
  );
  vi.stubGlobal("fetch", fetch);
  const publicly = createPullStates(undefined);
  publicly.watch(second, changed);
  await vi.waitFor(() =>
    expect(publicly.get(second)).toEqual({ state: "open", title }),
  );
  title = "Fix the lab, renamed again";
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS);
  expect(publicly.get(second)).toEqual({ state: "open", title });
  expect(fetch).toHaveBeenCalledTimes(2);
});

const issue = "https://github.com/block/buzz-app/issues/5";
/** GitHub's answer to one query, by the number each alias asks for. */
const answers =
  (byNumber: (number: number) => unknown) =>
  async (_query: string, variables: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(variables).flatMap(([name, value]) =>
        name.startsWith("p") ? [[`r${name.slice(1)}`, byNumber(value)]] : [],
      ),
    );

it("reads an issue's state and title in the query it reads pull requests in, so a poll renames it in the read it already makes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let found: Record<string, unknown> = {
    state: "OPEN",
    stateReason: null,
    title: "Crash on start",
  };
  const gh = mockGh(
    answers((number) =>
      number === 5
        ? { issue: found }
        : rollup("OPEN", { title: "Fix the lab" }),
    ),
  );
  const states = createPullStates(gh);
  const changed = vi.fn();
  const [unwatchPull] = [
    states.watch(pull, () => {}),
    states.watch(issue, changed),
  ];
  await vi.waitFor(() => expect(states.get(issue)).toBeDefined());
  // One request for both, asking the issue for its state, why and title.
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[0]).toContain(
    "r1:repository(owner:$o1,name:$n1){issue(number:$p1){state stateReason title}}",
  );
  expect(gh.mock.calls[0]?.[1]).toEqual({
    o0: "block",
    n0: "buzz-app",
    p0: 7,
    o1: "block",
    n1: "buzz-app",
    p1: 5,
  });
  expect(states.get(issue)).toEqual({ state: "open", title: "Crash on start" });
  expect(states.get(pull)).toMatchObject({ title: "Fix the lab" });
  const before = states.get(issue);
  found = { ...found, title: "Crash on start, renamed" };
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(states.get(issue)).not.toBe(before);
  expect(states.get(issue)).toEqual({
    state: "open",
    title: "Crash on start, renamed",
  });
  expect(changed).toHaveBeenCalledTimes(2);
  found = { ...found, state: "CLOSED", stateReason: "NOT_PLANNED" };
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(3);
  expect(states.get(issue)).toEqual({
    state: "closed",
    reason: "not planned",
    title: "Crash on start, renamed",
  });
  expect(changed).toHaveBeenCalledTimes(3);

  // A closed issue can reopen, as a closed pull request can: it is read
  // every few minutes, not every minute, and not never, as a merged one is.
  unwatchPull?.();
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(3);
  found = { ...found, stateReason: "COMPLETED" };
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(4);
  expect(gh.mock.calls[3]?.[1]).toEqual({ o0: "block", n0: "buzz-app", p0: 5 });
  expect(states.get(issue)).toMatchObject({ reason: "completed" });
  expect(changed).toHaveBeenCalledTimes(4);
});

it("reads an issue's state and title from the public API in the one read of the issue, so a poll renames it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let body: Record<string, unknown> = {
    title: "Crash on start",
    state: "open",
    state_reason: null,
  };
  const fetch = vi.fn(
    async (_url: string) => new Response(JSON.stringify(body)),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  const changed = vi.fn();
  states.watch(issue, changed);
  await vi.waitFor(() =>
    expect(states.get(issue)).toEqual({
      state: "open",
      title: "Crash on start",
    }),
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/block/buzz-app/issues/5",
    expect.anything(),
  );
  body = {
    title: "Crash on start, renamed",
    state: "closed",
    state_reason: "completed",
  };
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(states.get(issue)).toEqual({
    state: "closed",
    reason: "completed",
    title: "Crash on start, renamed",
  });
  expect(changed).toHaveBeenCalledTimes(2);
  // One that can't be read again keeps what was read, title and all.
  const before = states.get(issue);
  fetch.mockResolvedValueOnce(new Response(null, { status: 502 }));
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(states.get(issue)).toBe(before);
  expect(states.readAt(issue)?.error).toBeInstanceOf(Error);
  expect(changed).toHaveBeenCalledTimes(2);
});

it.each([
  ["COMPLETED", "completed"],
  ["NOT_PLANNED", "not planned"],
  ["DUPLICATE", "not planned"],
  [null, "completed"],
])(
  "reads an issue closed with the reason %s as closed as %s, with gh and from the public API",
  async (reason, expected) => {
    const read = { state: "closed", reason: expected, title: "A" };
    const gh = mockGh(async () => ({
      r0: { issue: { state: "CLOSED", stateReason: reason, title: "A" } },
    }));
    const signedIn = createPullStates(gh);
    const stop = [signedIn.watch(issue, () => {})];
    await vi.waitFor(() => expect(signedIn.get(issue)).toEqual(read));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              title: "A",
              state: "closed",
              state_reason: reason?.toLowerCase() ?? null,
            }),
          ),
      ),
    );
    const publicly = createPullStates(undefined);
    stop.push(publicly.watch(issue, () => {}));
    await vi.waitFor(() => expect(publicly.get(issue)).toEqual(read));
    for (const unwatch of stop) unwatch();
  },
);

it("keys an issue by its canonical URL, so pasted variants share one entry and read", async () => {
  const gh = mockGh(async () => ({
    r0: { issue: { state: "OPEN", title: "A" } },
  }));
  const states = createPullStates(gh);
  const variants = [
    `${issue}?notification_referrer_id=abc`,
    `${issue}/`,
    "https://github.com/Block/Buzz-App/issues/5",
  ];
  const stop = [issue, ...variants].map((url) => states.watch(url, () => {}));
  await vi.waitFor(() => expect(states.get(issue)).toBeDefined());
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[1]).toEqual({ o0: "block", n0: "buzz-app", p0: 5 });
  for (const url of variants) expect(states.get(url)).toBe(states.get(issue));
  for (const unwatch of stop) unwatch();
});

it("keeps an issue's URL apart from the pull request's with its number, and reads neither as the other", async () => {
  const numbered = "https://github.com/block/buzz-app/issues/7";
  // GitHub's public issues answer for a pull request too, and say so.
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({
          title: "Fix the lab",
          state: "open",
          ...(url.includes("/issues/") && {
            pull_request: {
              url: "https://api.github.com/repos/block/buzz-app/pulls/7",
            },
          }),
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const publicly = createPullStates(undefined);
  const stop = [
    publicly.watch(pull, () => {}),
    publicly.watch(numbered, () => {}),
  ];
  await vi.waitFor(() => expect(publicly.get(numbered)).toBe("failed"));
  expect(publicly.get(pull)).toEqual({ state: "open", title: "Fix the lab" });
  expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
    "https://api.github.com/repos/block/buzz-app/issues/7",
    "https://api.github.com/repos/block/buzz-app/pulls/7",
  ]);
  expect(publicly.readAt(numbered)?.error?.message).toBe(
    "GitHub has a pull request, not an issue, at this number.",
  );
  // With gh, GitHub finds no issue at a pull request's number, and still
  // answers for the rest.
  const gh = mockGh(async () => {
    throw new GitHubError(
      "Could not resolve to an Issue with the number of 7.",
      "NOT_FOUND",
      { r0: rollup("OPEN", { title: "Fix the lab" }), r1: { issue: null } },
    );
  });
  const signedIn = createPullStates(gh);
  stop.push(
    signedIn.watch(pull, () => {}),
    signedIn.watch(numbered, () => {}),
  );
  await vi.waitFor(() => expect(signedIn.get(numbered)).toBe("failed"));
  expect(gh).toHaveBeenCalledOnce();
  expect(signedIn.get(pull)).toMatchObject({
    state: "open",
    title: "Fix the lab",
  });
  for (const unwatch of stop) unwatch();
});

it("keys a pull request by its canonical URL, so pasted variants share one entry and read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => ({
    r0: rollup("OPEN", {}, "SUCCESS"),
    r1: rollup("MERGED"),
  }));
  const states = createPullStates(gh);
  const changed = [vi.fn(), vi.fn(), vi.fn(), vi.fn()] as const;
  // As pasted from a GitHub email, from the address bar, with GitHub's own
  // casing, and plain, as a watch gives it.
  const query = `${pull}?notification_referrer_id=abc&diff=split`;
  const slash = `${pull}/`;
  const cased = "https://github.com/Block/Buzz-App/pull/7";
  const stop = [
    states.watch(query, changed[0]),
    states.watch(slash, changed[1]),
    states.watch(second, changed[2]),
    states.watch(cased, changed[3]),
  ];
  await vi.waitFor(() => expect(states.get(second)).toBeDefined());
  // One query, with the numbers GitHub needs, not `null` or 0 for the
  // variants, which would fail the whole batch.
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[1]).toEqual({
    o0: "block",
    n0: "buzz-app",
    p0: 7,
    o1: "block",
    n1: "buzz",
    p1: 9,
  });
  for (const listener of changed) expect(listener).toHaveBeenCalledOnce();
  const state = { state: "open", checks: "success", conflicts: false };
  expect(states.get(query)).toEqual(state);
  expect(states.get(slash)).toBe(states.get(query));
  expect(states.get(pull)).toBe(states.get(query));
  expect(states.get(cased)).toBe(states.get(query));
  expect(states.get(second)).toEqual({ state: "merged", conflicts: false });
  for (const unwatch of stop) unwatch();
});

it("neither watches nor throws for a URL that is not a pull request's or issue's, and reads the rest", async () => {
  const gh = mockGh(async () => ({ r0: rollup("OPEN") }));
  const states = createPullStates(gh);
  const commit = "https://github.com/block/buzz-app/commit/abcdef1";
  const issue = "https://github.com/block/buzz-app/issues/7";
  // A number GraphQL's Int cannot hold would fail the whole query, and with
  // it every pull request shown alongside.
  const beyond = "https://github.com/block/buzz-app/pull/2147483648";
  const stop = [commit, beyond, pull].map((url) => states.watch(url, () => {}));
  // An issue has only its state: an agent's watch or the panel can't have it.
  stop.push(
    states.watch(issue, () => {}, "feedback"),
    states.watch(issue, () => {}, "details"),
  );
  states.watch("not a url", () => {})();
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[1]).toEqual({ o0: "block", n0: "buzz-app", p0: 7 });
  expect(states.get(pull)).toMatchObject({ state: "open" });
  for (const url of [commit, beyond, "not a url"])
    expect(states.get(url)).toBe("failed");
  expect(states.get(issue)).toBeUndefined();
  for (const unwatch of stop) unwatch();
});

it("keeps what it read for a pull request watched again within the minute", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => ({ r0: rollup("OPEN", {}, "SUCCESS") }));
  const states = createPullStates(gh);
  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  unwatch();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  // A row that scrolls out and back shows its state at once, unread.
  states.watch(pull, () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(states.get(pull)).toEqual({
    state: "open",
    checks: "success",
    conflicts: false,
  });
  expect(gh).toHaveBeenCalledOnce();
  // The poll keeps its original time.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("tries unreadable pull requests again every 5 minutes, in the one query with the rest", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // GitHub answers the pull requests it can read and an error for the rest.
  const gh = mockGh(
    async (_query: string, variables: Record<string, unknown>) => {
      const data: Record<string, unknown> = {};
      let missing = false;
      for (let i = 0; `n${i}` in variables; i++)
        if (variables[`n${i}`] === "buzz-app")
          data[`r${i}`] = rollup("OPEN", { isDraft: true }, "PENDING");
        else {
          data[`r${i}`] = null;
          missing = true;
        }
      if (missing) throw new GitHubError("Not found", "NOT_FOUND", data);
      return data;
    },
  );
  const states = createPullStates(gh);
  for (const url of [pull, second, third]) states.watch(url, () => {});
  await vi.waitFor(() => expect(states.get(third)).toBe("failed"));
  expect(gh).toHaveBeenCalledOnce();
  expect(states.get(second)).toBe("failed");
  expect(states.get(pull)).toEqual({
    state: "draft",
    checks: "pending",
    conflicts: false,
  });
  const repositories = () =>
    gh.mock.calls.map(([, variables]) =>
      Object.entries(variables as Record<string, unknown>)
        .filter(([key]) => key.startsWith("n"))
        .map(([, name]) => name),
    );
  // Four minutes of polls: only the readable one, once a minute.
  await vi.advanceTimersByTimeAsync(4 * PULL_REFRESH_MS);
  expect(repositories().slice(1)).toEqual(
    Array.from({ length: 4 }, () => ["buzz-app"]),
  );
  // The fifth also tries both missing ones, longest unread first, in the
  // same query: one gh run.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(repositories().slice(5)).toEqual([["buzz", "goose", "buzz-app"]]);
  expect(states.get(second)).toBe("failed");
});

it("tries again in a minute, not at once, when GitHub answers for none", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => {
    throw new GitHubError("API rate limit exceeded", "RATE_LIMITED");
  });
  const states = createPullStates(gh);
  const changed = vi.fn();
  states.watch(pull, changed);
  states.watch(second, changed);
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // Nothing was learnt, so nothing is shown as unavailable, and the next
  // try waits the poll interval rather than spinning while GitHub refuses.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(gh).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(states.get(pull)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(gh.mock.calls[1]?.[1]).toEqual(gh.mock.calls[0]?.[1]);
});

it("leaves a read in flight alone when another pull request is watched, reading it next", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let answer: (value: unknown) => void = () => {};
  const signals: (AbortSignal | undefined)[] = [];
  const gh = mockGh(
    (
      _query: string,
      variables: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      signals.push(signal);
      if ("p1" in variables || variables.n0 === "buzz")
        return Promise.resolve({ r0: rollup("MERGED") });
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  );
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // A row mounting mid-read neither restarts the read nor loses its result.
  states.watch(second, () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(gh).toHaveBeenCalledOnce();
  expect(signals[0]?.aborted).toBe(false);
  answer({ r0: rollup("OPEN", {}, "SUCCESS") });
  await vi.waitFor(() => expect(states.get(second)).toBeDefined());
  expect(states.get(pull)).toMatchObject({ checks: "success" });
  expect(states.get(second)).toMatchObject({ state: "merged" });
  expect(gh).toHaveBeenCalledTimes(2);
  expect(gh.mock.calls[1]?.[1]).toEqual({ o0: "block", n0: "buzz", p0: 9 });
});

it("reads a link once but does not poll it while the window is hidden", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => ({ r0: rollup("OPEN", {}, "SUCCESS") }));
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  await vi.advanceTimersByTimeAsync(10 * PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  visibility.mockRestore();
});

it("reads what became due while the window was hidden as soon as it comes back", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => ({ r0: rollup("OPEN", {}, "SUCCESS") }));
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const states = createPullStates(gh);
  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  await vi.advanceTimersByTimeAsync(2 * PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  // Back after two minutes: the overdue read is now, not at the next look.
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(gh).toHaveBeenCalledTimes(2);
  // Back after half a minute, with nothing due: the poll keeps its time.
  visibility.mockReturnValue("hidden");
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(gh).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(gh).toHaveBeenCalledTimes(3);
  // Nothing watched, nothing to read on return.
  unwatch();
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(3);
});

it("reads a closed pull request, which can reopen, again every few minutes rather than every minute", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = vi
    .fn()
    .mockResolvedValueOnce({ r0: rollup("CLOSED") })
    .mockResolvedValue({
      r0: rollup("OPEN", {}, "SUCCESS"),
    }) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() =>
    expect(states.get(pull)).toMatchObject({ state: "closed" }),
  );
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(states.get(pull)).toMatchObject({ state: "open" });
  // Open again, it is polled every minute.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(3);
});

it("reads public data without gh every few minutes until it is merged", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ title: "A", state: "open" })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ title: "A", state: "open", draft: true })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ title: "A", state: "closed" })),
    )
    .mockResolvedValue(
      new Response(
        JSON.stringify({ title: "A", state: "closed", merged: true }),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  states.watch(pull, () => {});
  await vi.waitFor(() =>
    expect(states.get(pull)).toEqual({ state: "open", title: "A" }),
  );
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/block/buzz-app/pulls/7",
    expect.anything(),
  );
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(fetch).toHaveBeenCalledOnce();
  // Open, draft and closed can each still change.
  for (const state of ["draft", "closed", "merged"]) {
    await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
    await vi.waitFor(() =>
      expect(states.get(pull)).toEqual({ state, title: "A" }),
    );
    await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  }
  await vi.advanceTimersByTimeAsync(3 * PULL_SLOW_REFRESH_MS);
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("tries a public read that failed again every few minutes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValue(
      new Response(JSON.stringify({ title: "A", state: "closed" })),
    );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBe("failed"));
  // One bad moment, GitHub's or the network's, is not for good.
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  await vi.waitFor(() =>
    expect(states.get(pull)).toEqual({ state: "closed", title: "A" }),
  );
});

const pulls = Array.from(
  { length: PUBLIC_READS_PER_POLL + 2 },
  (_, i) => `https://github.com/block/repo-${i}/pull/1`,
);
const limited = (resetAt?: number) =>
  new Response(null, {
    status: 403,
    headers: resetAt ? { "x-ratelimit-reset": String(resetAt / 1000) } : {},
  });

it("spends a few public reads at once, then only its share of each hour's", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(
    async (_url: string) =>
      new Response(JSON.stringify({ title: "A", state: "open" })),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  for (const url of pulls) states.watch(url, () => {});
  await vi.waitFor(() =>
    expect(states.get(pulls[PUBLIC_READS_PER_POLL - 1] ?? "")).toBeDefined(),
  );
  // A channel of links does not spend the hour's public reads at once.
  expect(fetch).toHaveBeenCalledTimes(PUBLIC_READS_PER_POLL);
  expect(states.get(pulls.at(-1) ?? "")).toBeUndefined();
  // Kept current for an hour, and the next, they leave the panel the rest of
  // GitHub's 60, however many are shown.
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(fetch).toHaveBeenCalledTimes(
    PUBLIC_READS_PER_POLL + PUBLIC_READS_PER_HOUR,
  );
  expect(states.get(pulls.at(-1) ?? "")).toEqual({ state: "open", title: "A" });
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(fetch).toHaveBeenCalledTimes(
    PUBLIC_READS_PER_POLL + 2 * PUBLIC_READS_PER_HOUR,
  );
  // Each is read in turn, none left behind.
  const read = fetch.mock.calls.map(([url]) => url);
  expect(new Set(read.slice(-pulls.length)).size).toBe(pulls.length);
});

it("spends nothing, rather than everything, when the clock is set back", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ title: "A", state: "open" })),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  for (const url of pulls) states.watch(url, () => {});
  await vi.waitFor(() =>
    expect(states.get(pulls[PUBLIC_READS_PER_POLL - 1] ?? "")).toBeDefined(),
  );
  // The budget spent, the clock corrected back a minute: links shown now are
  // not read, and no time is earned until the clock passes where it was.
  vi.setSystemTime(Date.now() - PULL_REFRESH_MS);
  for (const url of [second, third, pull]) states.watch(url, () => {});
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(fetch).toHaveBeenCalledTimes(PUBLIC_READS_PER_POLL);
  await vi.advanceTimersByTimeAsync(11 * PULL_REFRESH_MS);
  expect(fetch).toHaveBeenCalledTimes(PUBLIC_READS_PER_POLL + 5);
  expect(states.get(pull)).toEqual({ state: "open", title: "A" });
});

it("reads links shown while the budget is spent in turn with those left before them", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(
    async (_url: string) =>
      new Response(JSON.stringify({ title: "A", state: "open" })),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  for (const url of pulls) states.watch(url, () => {});
  await vi.waitFor(() =>
    expect(states.get(pulls[PUBLIC_READS_PER_POLL - 1] ?? "")).toBeDefined(),
  );
  // Shown half a minute after the rest were left over, they are not out of
  // step with them, so the earlier ones cannot take every read as it is earned.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  const later = [second, third, pull];
  for (const url of later) states.watch(url, () => {});
  await vi.advanceTimersByTimeAsync(10 * PULL_REFRESH_MS);
  for (const url of [...pulls, ...later])
    expect(states.get(url)).toEqual({ state: "open", title: "A" });
  expect(fetch).toHaveBeenCalledTimes(PUBLIC_READS_PER_POLL + 5);
});

it("reads a public pull request never read before those that keep failing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // Private repositories are 404 without gh. Enough of them that some are
  // still unread when the first come round again, wanting every read there is.
  const failing = Array.from(
    { length: PUBLIC_READS_PER_POLL + 3 },
    (_, i) => `https://github.com/block/private-${i}/pull/1`,
  );
  const fetch = vi.fn(async (url: string) =>
    url.includes("/private-")
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify({ title: "A", state: "open" })),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  for (const url of [...failing, pull]) states.watch(url, () => {});
  await vi.advanceTimersByTimeAsync(2 * PULL_SLOW_REFRESH_MS);
  await vi.waitFor(() =>
    expect(states.get(pull)).toEqual({ state: "open", title: "A" }),
  );
  expect(states.get(failing[0] ?? "")).toBe("failed");
});

it.each([
  ["when GitHub says it resets", 30 * 60_000],
  ["for an hour when it does not say", undefined],
])(
  "holds every public read once GitHub refuses one, %s",
  async (_, resetIn) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const hold = resetIn ?? 60 * 60_000;
    const resetAt = resetIn && Date.now() + resetIn;
    let refusals = 2;
    const fetch = vi.fn(async () =>
      refusals-- > 0
        ? limited(resetAt)
        : new Response(JSON.stringify({ title: "A", state: "open" })),
    );
    vi.stubGlobal("fetch", fetch);
    const states = createPullStates(undefined);
    const changed = vi.fn();
    states.watch(pull, changed);
    states.watch(second, changed);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    // Over the limit, nothing is learnt or shown as unavailable, and neither
    // these nor a link shown meanwhile is tried until the limit resets.
    states.watch(third, changed);
    await vi.advanceTimersByTimeAsync(hold - PULL_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    expect(states.get(pull)).toBeUndefined();
    expect(states.get(third)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(5);
    for (const url of [pull, second, third])
      expect(states.get(url)).toEqual({ state: "open", title: "A" });
  },
);

it("tries gh again before GitHub's public limit resets, when there is one", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => limited(Date.now() + 60 * 60_000)),
  );
  let signedIn = false;
  const gh = mockGh(async () => {
    if (!signedIn) throw new GhUnavailable();
    return { r0: rollup("OPEN", {}, "SUCCESS") };
  });
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  signedIn = true;
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(states.get(pull)).toMatchObject({ checks: "success" });
  expect(fetch).toHaveBeenCalledOnce();
});

it("holds public reads for GitHub's limit while gh is unavailable too", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(limited(Date.now() + 60 * 60_000))
    .mockResolvedValue(
      new Response(JSON.stringify({ title: "A", state: "open" })),
    );
  vi.stubGlobal("fetch", fetch);
  // The desktop host always supplies gh; without a sign-in every read throws.
  const gh = mockGh(async () => {
    throw new GhUnavailable();
  });
  const states = createPullStates(gh);
  const changed = vi.fn();
  states.watch(pull, changed);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  // gh is tried again every few minutes; the public API, refused, not until
  // GitHub says it resets, and nothing is shown as unavailable meanwhile.
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(gh).toHaveBeenCalledTimes(7);
  expect(fetch).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(states.get(pull)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  await vi.waitFor(() =>
    expect(states.get(pull)).toEqual({ state: "open", title: "A" }),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("reads public data while gh is unavailable, and goes back to gh once it is available again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ title: "A", state: "open" })),
    ),
  );
  let signedIn = false;
  const gh = mockGh(async () => {
    if (!signedIn) throw new GhUnavailable();
    return { r0: rollup("OPEN", {}, "SUCCESS") };
  });
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() =>
    expect(states.get(pull)).toEqual({ state: "open", title: "A" }),
  );
  // Public reads are sparse: the next one, with gh back, is in five minutes.
  signedIn = true;
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(states.get(pull)).toMatchObject({ checks: "success" });
});

it("keeps a refresh that was given up on from marking pull requests unavailable", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let answer: (value: unknown) => void = () => {};
  const gh = mockGh(
    (_query: string, _variables: unknown, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        answer = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const states = createPullStates(gh);
  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // The last row goes away mid-read, then comes back.
  unwatch();
  await vi.advanceTimersByTimeAsync(0);
  states.watch(pull, () => {});
  expect(states.get(pull)).toBeUndefined();
  await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
  answer({ r0: rollup("OPEN", {}, "SUCCESS") });
  await vi.waitFor(() =>
    expect(states.get(pull)).toMatchObject({ checks: "success" }),
  );
});

it("keeps what a timed-out refresh read, and marks what it could not", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let started = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      started++;
      if (input.includes("/buzz-app/"))
        return new Response(JSON.stringify({ title: "A", state: "open" }));
      // The other never answers before the deadline.
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        ),
      );
    }),
  );
  const states = createPullStates(undefined);
  const stop = [states.watch(pull, () => {}), states.watch(second, () => {})];
  await vi.waitFor(() => expect(started).toBe(2));
  try {
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    await vi.waitFor(() => expect(states.get(second)).toBe("failed"));
    expect(states.get(pull)).toEqual({ state: "open", title: "A" });
  } finally {
    for (const unwatch of stop) unwatch();
  }
});

/** A pull request as the store's query answers for it with `gh`, at every
 * level: its head and checks, feedback ids, and what the panel reads. */
type Check = { name: string; status: string; conclusion: string | null };
const full = ({
  comments = ["I1"],
  checks = [
    { name: "unit", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "e2e", status: "COMPLETED", conclusion: "SUCCESS" },
  ] as Check[],
  total = undefined as number | undefined,
  rollupState = "FAILURE",
} = {}) => ({
  squashMergeAllowed: true,
  pullRequest: {
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    headRefOid: "abc123",
    id: "PR_1",
    title: "A change",
    baseRefName: "main",
    headRefName: "feature",
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: rollupState,
              contexts: {
                totalCount: total ?? checks.length,
                nodes: checks.map((check) => ({
                  __typename: "CheckRun",
                  ...check,
                })),
              },
            },
          },
        },
      ],
    },
    reviews: {
      nodes: [
        { id: "R1", comments: { nodes: [{ id: "C1" }] } },
        { id: "R2", comments: { nodes: [] } },
      ],
    },
    comments: { nodes: comments.map((id) => ({ id })) },
  },
});
/** What GitHub says of each feedback node asked for. */
const text = (ids: string[]) => ({
  nodes: ids.map((id) =>
    id.startsWith("R")
      ? {
          __typename: "PullRequestReview",
          id,
          author: { login: "wes" },
          state: id === "R2" ? "COMMENTED" : "CHANGES_REQUESTED",
          body: id === "R2" ? " " : "Fix it",
          url: `u/${id}`,
        }
      : id.startsWith("C")
        ? {
            __typename: "PullRequestReviewComment",
            id,
            author: { login: "codex" },
            body: "Here",
            path: "src/a.ts",
            url: `u/${id}`,
          }
        : {
            __typename: "IssueComment",
            id,
            author: null,
            body: "x".repeat(BODY_CHARS + 50),
            url: `u/${id}`,
          },
  ),
});
type Variables = Record<string, unknown>;
const ghFor = (answer: () => Record<string, unknown>) =>
  mockGh(async (_query: string, variables: Variables) =>
    "ids" in variables
      ? text(variables.ids as string[])
      : { viewer: { login: "baxen" }, ...answer() },
  );
/** The feedback items held for `url`. */
const itemsOf = (states: ReturnType<typeof createPullStates>, url: string) => {
  const state = states.get(url);
  return typeof state === "object" ? (state.feedback?.items ?? []) : [];
};
const listings = (gh: ReturnType<typeof mockGh>) =>
  gh.mock.calls.filter(([, variables]) => !("ids" in (variables as Variables)));

it("reads a pull request once at every level its readers ask for", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = ghFor(() => ({ r0: full(), r1: rollup("OPEN", {}, "SUCCESS") }));
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  states.watch(pull, () => {}, "feedback");
  states.watch(pull, () => {}, "details");
  states.watch(second, () => {});
  await vi.waitFor(() =>
    expect(states.get(pull)).toMatchObject({ details: expect.anything() }),
  );
  // One listing for both, and only the followed one lists its feedback.
  expect(listings(gh)).toHaveLength(1);
  const query = String(listings(gh)[0]?.[0]);
  expect(query).toContain("viewer{login}");
  const [first, other] = query.split("r1:");
  expect(first).toContain("reviews(");
  expect(first).toContain("viewerDefaultMergeMethod");
  expect(other).not.toContain("reviews(");
  expect(other).not.toContain("viewerDefaultMergeMethod");
  expect(states.get(pull)).toMatchObject({
    state: "open",
    checks: "failure",
    head: "abc123",
    settled: true,
    failed: ["unit"],
    feedback: {
      viewer: "baxen",
      ids: ["review/R1", "inline/C1", "review/R2", "comment/I1"],
    },
    details: {
      signedIn: true,
      details: { title: "A change" },
      checklist: { id: "PR_1", head: "abc123", base: "main" },
    },
  });
  expect(states.get(second)).not.toHaveProperty("feedback");
  expect(states.get(second)).not.toHaveProperty("details");
});

it("is not settled while a check runs, more are unread, or the rollup waits", async () => {
  const running = [{ name: "e2e", status: "IN_PROGRESS", conclusion: null }];
  for (const answer of [
    full({ checks: running }),
    full({ total: 3 }),
    full({ rollupState: "EXPECTED" }),
  ]) {
    const states = createPullStates(ghFor(() => ({ r0: answer })));
    const { state } = await states.read(pull, { maxAge: 0 });
    expect(state).toMatchObject({ settled: false });
  }
});

it("reads the text of feedback it does not hold, newest first, and keeps it while listed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let comments = ["I1"];
  const gh = ghFor(() => ({ r0: full({ comments }) }));
  const states = createPullStates(gh);
  states.watch(pull, () => {}, "feedback");
  await vi.waitFor(() => expect(itemsOf(states, pull)).toHaveLength(4));
  const asked = () =>
    gh.mock.calls
      .map(([, variables]) => (variables as Variables).ids)
      .filter(Boolean);
  expect(asked()).toEqual([["R1", "C1", "R2", "I1"]]);
  const items = itemsOf(states, pull);
  expect(items.map((item) => item.id)).toEqual([
    "review/R1",
    "inline/C1",
    "review/R2",
    "comment/I1",
  ]);
  // Long bodies are clipped; an empty review wrapper is held as read.
  expect(items[3]?.body).toHaveLength(BODY_CHARS + 1);
  expect(items[2]).toMatchObject({ state: "COMMENTED", body: " " });

  // Only what is new is read; what is no longer listed is let go.
  comments = ["I2"];
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(asked().at(-1)).toEqual(["I2"]);
  expect(itemsOf(states, pull).map((item) => item.id)).toEqual([
    "review/R1",
    "inline/C1",
    "review/R2",
    "comment/I2",
  ]);
});

it("keeps the listing when feedback text cannot be read, and reads it next time", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let texts = false;
  const gh = mockGh(async (_query: string, variables: Variables) => {
    if (!("ids" in variables)) return { viewer: { login: "b" }, r0: full() };
    if (!texts) throw new GitHubError("Something went wrong", "INTERNAL");
    return text(variables.ids as string[]);
  });
  const states = createPullStates(gh);
  states.watch(pull, () => {}, "feedback");
  await vi.waitFor(() =>
    expect(states.get(pull)).toMatchObject({ head: "abc123" }),
  );
  expect(states.get(pull)).toMatchObject({ feedback: { items: [] } });
  texts = true;
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(states.get(pull)).toMatchObject({
    feedback: { items: expect.arrayContaining([expect.anything()]) },
  });
});

it("holds what a level adds only while someone asks for it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = ghFor(() => ({ r0: full() }));
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  const unfollow = states.watch(pull, () => {}, "feedback");
  await vi.waitFor(() => expect(states.get(pull)).toHaveProperty("feedback"));
  unfollow();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(states.get(pull)).not.toHaveProperty("feedback");
  expect(String(listings(gh).at(-1)?.[0])).not.toContain("reviews(");
});

it("follows a pull request's feedback while the window is hidden, but not one only shown", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = ghFor(() => ({ r0: full(), r1: full() }));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const states = createPullStates(gh);
  states.watch(pull, () => {}, "feedback");
  states.watch(second, () => {});
  await vi.waitFor(() => expect(states.get(second)).toBeDefined());
  expect(listings(gh)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(3 * PULL_REFRESH_MS);
  const read = listings(gh).map(([, variables]) => (variables as Variables).n0);
  expect(read).toEqual(["buzz-app", "buzz-app", "buzz-app", "buzz-app"]);
  expect(
    listings(gh)
      .slice(1)
      .every(([, v]) => !("n1" in (v as Variables))),
  ).toBe(true);
});

it("polls a pull request open in the panel twice a minute", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = ghFor(() => ({ r0: full() }));
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  // Opening the panel reads what it adds now, then on the panel's interval.
  const close = states.watch(pull, () => {}, "details");
  await vi.advanceTimersByTimeAsync(0);
  expect(listings(gh)).toHaveLength(2);
  expect(states.get(pull)).toHaveProperty("details");
  await vi.advanceTimersByTimeAsync(PANEL_REFRESH_MS);
  expect(listings(gh)).toHaveLength(3);
  // Closed, the links' minute after the last poll follows, and drops what
  // only the panel holds.
  close();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS - 1);
  expect(listings(gh)).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(listings(gh)).toHaveLength(4);
  expect(states.get(pull)).not.toHaveProperty("details");
});

it("answers a reader from what it holds within the age asked, and reads otherwise", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = ghFor(() => ({ r0: full() }));
  const states = createPullStates(gh);
  const first = await states.read(pull, { maxAge: PULL_REFRESH_MS });
  expect(first).toMatchObject({
    state: { head: "abc123" },
    readAt: Date.now(),
  });
  expect(states.readAt(pull)).toEqual({
    readAt: first.readAt,
    error: undefined,
  });
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  // Within the minute, from the store; at a level it lacks, read again.
  expect(
    (await states.read(`${pull}?tab=files`, { maxAge: PULL_REFRESH_MS }))
      .readAt,
  ).toBe(first.readAt);
  expect(listings(gh)).toHaveLength(1);
  const followed = await states.read(pull, {
    maxAge: PULL_REFRESH_MS,
    level: "feedback",
  });
  expect(followed.state).toHaveProperty("feedback");
  expect(listings(gh)).toHaveLength(2);
  // Nothing watches it, so nothing polls it.
  await vi.advanceTimersByTimeAsync(3 * PULL_REFRESH_MS);
  expect(listings(gh)).toHaveLength(2);
  // Two readers asking together share one read.
  const [a, b] = await Promise.all([
    states.read(pull, { maxAge: 0 }),
    states.read(second, { maxAge: 0 }),
  ]);
  expect(listings(gh)).toHaveLength(3);
  expect(a.readAt).toBe(b.readAt);
  await expect(
    states.read("https://github.com/block/buzz-app/commit/abcdef1", {
      maxAge: 0,
    }),
  ).rejects.toThrow("Not a GitHub pull request URL");
  await expect(
    states.read("https://github.com/block/buzz-app/issues/7", {
      maxAge: 0,
      level: "details",
    }),
  ).rejects.toThrow("Not a GitHub pull request URL");
  expect(listings(gh)).toHaveLength(3);
});

it("tells a reader why a pull request could not be read, or that GitHub answered for none", async () => {
  let fail = false;
  const gh = mockGh(async () => {
    if (fail) throw new GitHubError("Bad gateway", "INTERNAL");
    throw new GitHubError("Not found", "NOT_FOUND", {
      r0: { pullRequest: null },
    });
  });
  const states = createPullStates(gh);
  const read = await states.read(pull, { maxAge: 0 });
  expect(read.state).toBe("failed");
  expect(read.error?.message).toMatch("couldn’t find this");
  expect(states.readAt(pull)?.error?.message).toMatch("couldn’t find this");
  fail = true;
  await expect(states.read(pull, { maxAge: 0 })).rejects.toThrow("Bad gateway");
});

it("forgets a pull request nobody has watched or asked for in a while", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = ghFor(() => ({ r0: full() }));
  const states = createPullStates(gh);
  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  unwatch();
  await vi.advanceTimersByTimeAsync(PULL_RETAIN_MS - PULL_REFRESH_MS);
  await states.read(second, { maxAge: 0 });
  expect(states.get(pull)).toBeDefined();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  await states.read(second, { maxAge: 0 });
  expect(states.get(pull)).toBeUndefined();
  expect(states.readAt(pull)).toBeUndefined();
});

it("reads the panel without gh apart from the links' share, with the head's checks", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(async (url: string) =>
    url.includes("/commits/")
      ? new Response(
          JSON.stringify(
            url.includes("check-runs")
              ? {
                  total_count: 1,
                  check_runs: [
                    {
                      name: "unit",
                      status: "completed",
                      conclusion: "success",
                    },
                  ],
                }
              : { total_count: 0, statuses: [] },
          ),
        )
      : new Response(
          JSON.stringify({ title: "A", state: "open", head: { sha: "abc" } }),
        ),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  // The links' share is spent.
  for (const url of pulls) states.watch(url, () => {});
  await vi.waitFor(() =>
    expect(states.get(pulls[PUBLIC_READS_PER_POLL - 1] ?? "")).toBeDefined(),
  );
  // The panel opens.
  states.watch(pull, () => {}, "details");
  const { state } = await states.read(pull, {
    maxAge: 0,
    level: "details",
    interactive: true,
  });
  expect(state).toMatchObject({
    state: "open",
    details: {
      signedIn: false,
      details: { title: "A" },
      publicChecks: { state: "success" },
    },
  });
});

it.each([
  ["with no panel open", false],
  ["with the panel open on it", true],
])(
  "charges an agent's lookup of the details without gh to the links' share, %s",
  async (_, open) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetch = vi.fn(async (url: string) =>
      url.includes("/commits/")
        ? new Response(JSON.stringify({ total_count: 0, check_runs: [] }))
        : new Response(
            JSON.stringify({ title: "A", state: "open", head: { sha: "abc" } }),
          ),
    );
    vi.stubGlobal("fetch", fetch);
    const states = createPullStates(undefined);
    // The panel's own read, when it is open, is outside the share.
    if (open) {
      states.watch(pull, () => {}, "details");
      await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
    }
    // An agent looks at the details every minute for an hour.
    for (let minute = 0; minute < 60; minute++) {
      await states.read(pull, { maxAge: 0, level: "details" }).catch(() => {});
      await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
    }
    const pulls = fetch.mock.calls.filter(
      ([url]) => !url.includes("/commits/"),
    );
    const checks = fetch.mock.calls.length - pulls.length;
    // Within the links' share, rather than three requests a minute; only the
    // panel's own read reads checks (check runs and statuses).
    expect(pulls.length).toBeLessThanOrEqual(
      Number(open) + PUBLIC_READS_PER_POLL + PUBLIC_READS_PER_HOUR,
    );
    expect(checks).toBe(open ? 2 : 0);
  },
);

it("spends only the links' share on an agent's lookups of many pull requests without gh", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(async (url: string) =>
    url.includes("/commits/")
      ? new Response(JSON.stringify({ total_count: 0, check_runs: [] }))
      : new Response(
          JSON.stringify({ title: "A", state: "open", head: { sha: url } }),
        ),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  // An agent looks at the details of another pull request, with its own
  // head, every minute for an hour.
  for (let minute = 0; minute < 60; minute++) {
    await states
      .read(`https://github.com/block/buzz-app/pull/${100 + minute}`, {
        maxAge: 0,
        level: "details",
      })
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  }
  // Each read spends one request of the links' share, and no more for checks.
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(
    PUBLIC_READS_PER_POLL + PUBLIC_READS_PER_HOUR,
  );
  expect(fetch.mock.calls.some(([url]) => url.includes("/commits/"))).toBe(
    false,
  );
});

it("tries gh again for a read someone waits for, while polls still wait for it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ title: "A", state: "open" })),
    ),
  );
  let signedIn = false;
  const gh = mockGh(async () => {
    if (!signedIn) throw new GhUnavailable();
    return { r0: rollup("OPEN", {}, "SUCCESS") };
  });
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() =>
    expect(states.get(pull)).toEqual({ state: "open", title: "A" }),
  );
  expect(gh).toHaveBeenCalledOnce();
  // Back online within the minute: a link shown now is read without gh, ...
  signedIn = true;
  states.watch(second, () => {});
  await vi.waitFor(() =>
    expect(states.get(second)).toEqual({ state: "open", title: "A" }),
  );
  expect(gh).toHaveBeenCalledOnce();
  // ... but a read someone waits for uses gh at once.
  const { state } = await states.read(pull, { maxAge: 0 });
  expect(gh).toHaveBeenCalledTimes(2);
  expect(state).toMatchObject({ checks: "success" });
});

it("keeps a reader's read when a refresh given up on before it finishes late", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const ends: (() => void)[] = [];
  const gh = mockGh(
    (_query: string, _variables: unknown, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        const read = gh.mock.calls.length;
        // The first read ends only some time after it is given up on.
        ends.push(() =>
          read === 1
            ? reject(signal?.reason)
            : resolve({ r0: rollup("OPEN", {}, "SUCCESS") }),
        );
        signal?.addEventListener("abort", () => {
          if (read > 1) reject(signal.reason);
        });
      }),
  );
  const states = createPullStates(gh);
  const stop = states.watch(pull, () => {});
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // The only link goes away, so its read is given up on.
  stop();
  // A reader asks while another pull request is shown.
  const shown = states.watch(second, () => {});
  const read = states.read(pull, { maxAge: 0 });
  await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
  // The first read ends late, then the other pull request stops being shown.
  ends[0]?.();
  await vi.advanceTimersByTimeAsync(0);
  shown();
  ends[1]?.();
  await expect(read).resolves.toMatchObject({ state: { checks: "success" } });
});

it.each([
  ["without gh", false],
  ["while gh is unavailable", true],
])(
  "lets the panel's own read try GitHub while its public limit holds the links, %s",
  async (_, withGh) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(limited(Date.now() + 60 * 60_000))
      .mockResolvedValueOnce(limited(Date.now() + 60 * 60_000))
      .mockResolvedValue(
        new Response(JSON.stringify({ title: "Recovered", state: "open" })),
      );
    vi.stubGlobal("fetch", fetch);
    const gh = mockGh(async () => {
      throw new GhUnavailable();
    });
    const states = createPullStates(withGh ? gh : undefined);
    states.watch(pull, () => {});
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    // A link's state waits for the reset; asking for it does not read.
    await expect(states.read(pull, { maxAge: 0 })).rejects.toBeInstanceOf(
      GitHubRateLimited,
    );
    expect(fetch).toHaveBeenCalledOnce();
    // The open panel asks GitHub each time: refused, then read.
    states.watch(pull, () => {}, "details");
    await expect(
      states.read(pull, { maxAge: 0, level: "details", interactive: true }),
    ).rejects.toBeInstanceOf(GitHubRateLimited);
    const { state } = await states.read(pull, {
      maxAge: 0,
      level: "details",
      interactive: true,
    });
    expect(state).toMatchObject({
      details: { details: { title: "Recovered" } },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it("keeps the latest state, and when it was read, when a later read fails", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let fail = false;
  const gh = mockGh(async () => {
    if (fail)
      throw new GitHubError("Not found", "NOT_FOUND", {
        r0: { pullRequest: null },
      });
    return { r0: rollup("OPEN", {}, "SUCCESS") };
  });
  const states = createPullStates(gh);
  const changed = vi.fn();
  states.watch(pull, changed);
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  const shown = states.get(pull);
  const readAt = states.readAt(pull)?.readAt;
  fail = true;
  const read = await states.read(pull, { maxAge: 0 });
  expect(read).toMatchObject({ state: shown, readAt });
  expect(read.error?.message).toMatch("couldn’t find this");
  expect(states.get(pull)).toBe(shown);
  expect(states.readAt(pull)).toMatchObject({ readAt });
  expect(changed).toHaveBeenCalledOnce();
  fail = false;
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS);
  await vi.waitFor(() => expect(states.readAt(pull)?.error).toBeUndefined());
  expect(states.readAt(pull)?.readAt).toBeGreaterThan(readAt ?? 0);
});

/** The pull requests each GitHub call read, by owner/name. */
const readPerCall = (gh: ReturnType<typeof mockGh>) =>
  gh.mock.calls.map(([, variables]) => {
    const vars = variables as Record<string, unknown>;
    return Object.keys(vars)
      .filter((key) => /^o\d+$/.test(key))
      .map((key) => `${vars[key]}/${vars[`n${key.slice(1)}`]}`)
      .sort();
  });

it("reads each pull request as often as its most eager reader wants, all that are due together", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async (_query: string, variables: Variables) =>
    Object.fromEntries(
      Object.keys(variables)
        .filter((key) => /^o\d+$/.test(key))
        .map((key) => [`r${key.slice(1)}`, rollup("OPEN", {}, "SUCCESS")]),
    ),
  );
  const states = createPullStates(gh);
  const every = (ms: number) => () => ms;
  states.watch(pull, () => {}, "state", { polling: every(20_000) });
  states.watch(second, () => {}, "state", { polling: every(40_000) });
  // A second reader of the first wanting it less often changes nothing.
  states.watch(pull, () => {}, "state", { polling: every(60_000) });
  await vi.advanceTimersByTimeAsync(0);
  expect(readPerCall(gh)).toEqual([["block/buzz", "block/buzz-app"]]);
  await vi.advanceTimersByTimeAsync(20_000);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(readPerCall(gh).slice(1)).toEqual([
    ["block/buzz-app"],
    ["block/buzz", "block/buzz-app"],
  ]);
  // A reader wanting the second more often brings its next read forward.
  states.watch(second, () => {}, "state", { polling: every(10_000) });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(readPerCall(gh).at(-1)).toEqual(["block/buzz"]);
});

it("keeps each reader's own pace: the panel stops at a closed pull request, links slow down", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let state = "OPEN";
  const gh = ghFor(() => ({
    r0: { ...full(), pullRequest: { ...full().pullRequest, state } },
  }));
  const states = createPullStates(gh);
  const close = states.watch(pull, () => {}, "details");
  await vi.advanceTimersByTimeAsync(0);
  expect(listings(gh)).toHaveLength(1);
  state = "CLOSED";
  await vi.advanceTimersByTimeAsync(PANEL_REFRESH_MS);
  expect(states.get(pull)).toMatchObject({ state: "closed" });
  // The panel alone reads a closed pull request no more.
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS * 2);
  expect(listings(gh)).toHaveLength(2);
  // A link on it reads it every few minutes, as links did.
  states.watch(pull, () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(listings(gh)).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS);
  expect(listings(gh)).toHaveLength(4);
  close();
});

it("reads the panel without gh when opened and with its links, apart from their share, reading checks for a new head", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let head = "abc";
  const fetch = vi.fn(async (url: string) =>
    url.includes("/commits/")
      ? new Response(
          JSON.stringify(
            url.includes("check-runs")
              ? { total_count: 0, check_runs: [] }
              : { total_count: 0, statuses: [] },
          ),
        )
      : new Response(
          JSON.stringify({ title: "A", state: "open", head: { sha: head } }),
        ),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  // The links' share is spent.
  for (const url of pulls) states.watch(url, () => {});
  await vi.waitFor(() =>
    expect(states.get(pulls[PUBLIC_READS_PER_POLL - 1] ?? "")).toBeDefined(),
  );
  const pullReads = () =>
    fetch.mock.calls.filter(([url]) => url.endsWith("/pulls/7")).length;
  const checkReads = () =>
    fetch.mock.calls.filter(([url]) => url.includes("/commits/abc")).length;
  states.watch(pull, () => {}, "details");
  await vi.waitFor(() => expect(states.get(pull)).toHaveProperty("details"));
  expect([pullReads(), checkReads()]).toEqual([1, 2]);
  // The panel alone does not poll the public API.
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS);
  expect([pullReads(), checkReads()]).toEqual([1, 2]);
  // A link on it does, every few minutes; the same head keeps its checks.
  states.watch(pull, () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect([pullReads(), checkReads()]).toEqual([2, 2]);
  head = "def";
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS);
  expect(pullReads()).toBe(3);
  expect(
    fetch.mock.calls.filter(([url]) => url.includes("/commits/def")),
  ).toHaveLength(2);
});

it("parses only the levels a read asked for, and reads a level asked for meanwhile at once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let answer: (value: unknown) => void = () => {};
  const gh = mockGh(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // The panel opens while the links' read is in flight.
  states.watch(pull, () => {}, "details");
  states.watch(pull, () => {}, "feedback");
  answer({ r0: rollup("OPEN") });
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  expect(states.get(pull)).not.toHaveProperty("details");
  expect(states.get(pull)).not.toHaveProperty("feedback");
  // What they asked for is read next, not a poll later.
  await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
  const query = String(gh.mock.calls[1]?.[0]);
  expect(query).toContain("bodyHTML");
  expect(query).toContain("viewer{login}");
});

it("spends no public read on a watch while gh is unavailable, and tries gh again as links do", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(async () =>
    Response.json({ title: "A", state: "open", head: { sha: "abc" } }),
  );
  vi.stubGlobal("fetch", fetch);
  const gh = mockGh(async () => {
    throw new GhUnavailable("signed out");
  });
  const states = createPullStates(gh);
  states.watch(pull, () => {}, "feedback");
  await vi.advanceTimersByTimeAsync(0);
  expect(states.get(pull)).toBe("failed");
  expect(states.readAt(pull)?.error).toBeInstanceOf(GhUnavailable);
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - 1);
  expect(gh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(gh).toHaveBeenCalledTimes(2);
  // A link on it reads it publicly, at the links' pace, not the watch's.
  states.watch(pull, () => {});
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(3);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - 1);
  expect(fetch).toHaveBeenCalledOnce();
});

it("records why GitHub answered for none, and reads again as its readers want", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let down = false;
  const gh = ghFor(() => {
    if (down)
      throw new GitHubError("Service unavailable", "SERVICE_UNAVAILABLE");
    return { r0: full() };
  });
  const states = createPullStates(gh);
  states.watch(pull, () => {}, "details");
  await vi.waitFor(() => expect(states.get(pull)).toHaveProperty("details"));
  const { readAt } = states.readAt(pull) ?? {};
  down = true;
  await vi.advanceTimersByTimeAsync(PANEL_REFRESH_MS);
  expect(listings(gh)).toHaveLength(2);
  // What is held stays, with why it could not be read again, also for a
  // reader answered from what is held.
  expect(states.get(pull)).toHaveProperty("details");
  expect(states.readAt(pull)).toMatchObject({
    readAt,
    error: { type: "SERVICE_UNAVAILABLE" },
  });
  expect(
    (await states.read(pull, { maxAge: Infinity, level: "details" })).error,
  ).toMatchObject({ type: "SERVICE_UNAVAILABLE" });
  // The panel is read again at its own pace.
  await vi.advanceTimersByTimeAsync(PANEL_REFRESH_MS);
  expect(listings(gh)).toHaveLength(3);
});

it("reads a level asked for during a read GitHub answered for none at once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let fail: (error: unknown) => void = () => {};
  const gh = mockGh(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // A watch subscribes while the links' read is in flight, and it fails.
  states.watch(pull, () => {}, "feedback");
  fail(new GitHubError("Service unavailable", "SERVICE_UNAVAILABLE"));
  await vi.advanceTimersByTimeAsync(0);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(String(gh.mock.calls[1]?.[0])).toContain("reviews(");
});

it("reads the panel's public checks once gh drops out, rather than keeping none", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      url.includes("/commits/")
        ? url.includes("check-runs")
          ? {
              total_count: 1,
              check_runs: [
                { name: "unit", status: "completed", conclusion: "success" },
              ],
            }
          : { total_count: 0, statuses: [] }
        : { title: "A", state: "open", head: { sha: "abc" } },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  let signedIn = true;
  const gh = mockGh(async () => {
    if (!signedIn) throw new GhUnavailable("signed out");
    return {
      r0: {
        ...full(),
        pullRequest: { ...full().pullRequest, headRefOid: "abc" },
      },
    };
  });
  const states = createPullStates(gh);
  states.watch(pull, () => {}, "details");
  await vi.waitFor(() =>
    expect(states.get(pull)).toMatchObject({ details: { signedIn: true } }),
  );
  signedIn = false;
  await vi.advanceTimersByTimeAsync(PANEL_REFRESH_MS);
  expect(states.get(pull)).toMatchObject({
    details: { signedIn: false, publicChecks: { state: "success" } },
  });
});

it("reads a pull request a panel and a watch share without gh once, not again and again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      url.includes("/commits/")
        ? { total_count: 0, check_runs: [], statuses: [] }
        : { title: "A", state: "open", head: { sha: "abc" } },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  states.watch(pull, () => {}, "details");
  states.watch(pull, () => {}, "feedback");
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  // The pull request and its two kinds of checks, once; public data has no
  // feedback to read again for.
  expect(fetch).toHaveBeenCalledTimes(3);
});
