// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StrictMode,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type VerifiedEvent } from "nostr-tools";
import {
  provideNavigation,
  type PageNavigation,
} from "../../features/navigation/service";
import type { GitRead } from "../../features/repos/git";
import type { ReadFilter } from "../../features/relay/events";
import {
  MAX_MARKDOWN_DEPTH,
  MAX_MARKDOWN_LENGTH,
} from "../../features/relay/message-content";
import { ReadError } from "../../features/relay/errors";
import type { LiveCallbacks } from "../../features/relay/live";
import { entityTarget, type EntityRoute } from "../../features/repos/routes";
import type { GitSnapshot } from "../../features/repos/git";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { matchesEvent } from "../../features/relay/projection";
import { RepoPage } from "./RepoPage";

const key = new Uint8Array(32).fill(5),
  owner = getPublicKey(key);
const scope = { viewer: owner, communityOrigin: "https://community.example" };
const repo = finalizeEvent(
  {
    kind: 30617,
    created_at: 1,
    content: "Repository description",
    tags: [
      ["buzz-related-channel", "private-channel"],
      ["buzz-related-channel", "missing-channel"],
      ["d", "repo"],
      ["name", "Real repository"],
      ["buzz-channel", "private-channel"],
      ["buzz-related-channel", "missing-channel"],
      ["h", "stray-channel"],
    ],
  },
  key,
);
const issue = finalizeEvent(
  {
    kind: 1621,
    created_at: 2,
    content: "The issue body",
    tags: [
      ["a", `30617:${owner}:repo`],
      ["subject", "Selected issue"],
    ],
  },
  key,
);
const pr = finalizeEvent(
  {
    kind: 1618,
    created_at: 2,
    content: "The pull request body",
    tags: [
      ["a", `30617:${owner}:repo`],
      ["subject", "Selected pull request"],
      ["c", "a".repeat(40)],
    ],
  },
  key,
);
const git = {
  head: "a".repeat(40),
  commits: [
    {
      hash: "a".repeat(40),
      author: "Contributor",
      date: 2,
      subject: "Selected commit",
    },
  ],
  files: [{ path: "README.md", hash: "b".repeat(40), size: 6 }],
  readme: "# Actual README",
  file: null,
  diff: null,
} satisfies GitSnapshot;
const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposals.splice(0)) await dispose();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});
function setup(
  route?: EntityRoute,
  unscoped = false,
  gitAvailable = true,
  events: readonly VerifiedEvent[] = [repo, issue, pr],
) {
  const roster = (allowed: boolean, created_at = 1) =>
    finalizeEvent(
      {
        kind: 39002,
        created_at,
        content: "",
        tags: [["d", "private-channel"], ...(allowed ? [["p", owner]] : [])],
      },
      key,
    );
  const channel = finalizeEvent(
    {
      kind: 39000,
      created_at: 1,
      content: "",
      tags: [
        ["d", "private-channel"],
        ["name", "Private channel"],
        ["private"],
      ],
    },
    key,
  );
  let live: LiveCallbacks | undefined;
  const ctx = new Context();
  const host = provideNavigation(ctx);
  const readGit = vi.fn(
    async (input: GitRead): Promise<GitSnapshot> => ({
      ...git,
      ...(input.commit
        ? { diff: "diff --git a/readme b/readme\n+actual change" }
        : {}),
      ...(input.path
        ? { file: { path: input.path, content: "actual file", size: 11 } }
        : {}),
    }),
  );
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    [...events, roster(true), channel].filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
  const store = createRelaySession(
    {
      viewer: owner,
      relayAuthor: owner,
      scope: scope.communityOrigin,
      query,
      media: () => undefined,
      ...(gitAvailable ? { projectGit: { read: readGit } } : {}),
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { warm: false },
  );
  let connection: RelaySnapshot = {
    status: "ready",
    scope: `${scope.communityOrigin}:${owner}`,
    viewer: owner,
    generation: 1,
    session: store.session,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  disposals.push(
    () => store.dispose(),
    () => ctx.fiber.dispose(),
  );
  const promise = host.navigation.open(
    route
      ? entityTarget(route, scope)
      : {
          version: 1,
          kind: "page",
          pluginId: "buzz.repos",
          pageId: "repos",
          ...(unscoped ? {} : { scope }),
        },
  );
  function Presentation() {
    const snapshot = useSyncExternalStore(
      host.navigation.subscribe,
      host.navigation.snapshot,
    );
    const [request, setRequest] = useState<PageNavigation>();
    useLayoutEffect(() => {
      const binding = host.request(snapshot.attempt, {
        valid: () => true,
        subscribe: () => () => {},
      });
      setRequest(binding.request);
      return binding.dispose;
    }, [snapshot.attempt]);
    return (
      <RepoPage
        relay={relay}
        navigation={request}
        open={host.navigation.open}
      />
    );
  }
  return {
    host,
    relay,
    store,
    readGit,
    revoke() {
      live?.receive([roster(false, 5)]);
    },
    revokeOther() {
      for (const allowed of [true, false])
        live?.receive([
          finalizeEvent(
            {
              kind: 39002,
              created_at: allowed ? 1 : 5,
              content: "",
              tags: [["d", "unrelated"], ...(allowed ? [["p", owner]] : [])],
            },
            key,
          ),
        ]);
    },
    query,
    promise,
    mount: () =>
      render(
        <StrictMode>
          <Presentation />
        </StrictMode>,
      ),
    replace() {
      connection = { ...connection, generation: 2, status: "disconnected" };
      for (const listener of listeners) listener();
    },
  };
}
it("shows the retired-container notice without metadata or git reads", async () => {
  const t = setup(undefined);
  t.mount();
  await screen.findByText(/Project containers are no longer available/);
  await expect(t.promise).resolves.toEqual({ status: "opened" });
  expect(
    t.query.mock.calls
      .flatMap(([filters]) => filters)
      .some(
        (filter) =>
          filter.kinds?.includes(30617) || filter.kinds?.includes(30621),
      ),
  ).toBe(false);
  expect(t.readGit).not.toHaveBeenCalled();
});
it.each([
  {
    route: { type: "repo", owner, dtag: "repo" },
    heading: "Real repository",
    content: "Actual README",
  },
  {
    route: { type: "issue", owner, dtag: "repo", id: issue.id },
    heading: "Selected issue",
    content: "The issue body",
  },
  {
    route: { type: "pr", owner, dtag: "repo", id: pr.id },
    heading: "Selected pull request",
    content: "The pull request body",
  },
] as { route: EntityRoute; heading: string; content: string }[])(
  "presents actual $route.type content before acknowledging navigation",
  async ({ route, heading, content }) => {
    const t = setup(route);
    t.mount();
    await screen.findByText(content);
    expect(
      screen.getByRole("heading", { name: heading, level: 1 }),
    ).toHaveFocus();
    await expect(t.promise).resolves.toEqual({ status: "opened" });
  },
);
it.each([
  "files",
  "commits",
  "contributors",
  "issues",
  "prs",
  "channels",
] as const)("renders the requested $0 tab", async (tab) => {
  const t = setup({ type: "repo", owner, dtag: "repo", tab });
  t.mount();
  await waitFor(() =>
    expect(t.host.navigation.snapshot().status).toBe("opened"),
  );
  const label = {
    files: "Files",
    commits: "Commits",
    contributors: "Contributors",
    issues: "Issues",
    prs: "Pull requests",
    channels: "Channels",
  }[tab];
  expect(screen.getByRole("tab", { name: label })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("region", { name: label })).toBeVisible();
});
it("holds navigation pending for Git content, then opens the exact commit changes", async () => {
  const t = setup({
    type: "repo",
    owner,
    dtag: "repo",
    tab: "commits",
    commit: git.head,
  });
  let release: (value: GitSnapshot) => void = () => {};
  t.readGit.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  t.mount();
  try {
    await waitFor(() => expect(t.readGit).toHaveBeenCalled());
    expect(screen.getByRole("status")).toHaveTextContent("Loading repository");
    expect(t.host.navigation.snapshot().status).toBe("opening");
  } finally {
    await act(async () => release({ ...git, diff: "+actual selected change" }));
  }
  expect(
    await screen.findByRole("region", { name: "Commit changes" }),
  ).toHaveTextContent("+actual selected change");
  await expect(t.promise).resolves.toEqual({ status: "opened" });
});
it("reports missing entities and retries the same destination", async () => {
  const t = setup({ type: "issue", owner, dtag: "repo", id: "f".repeat(64) });
  t.mount();
  await expect(t.promise).resolves.toEqual({
    status: "failed",
    reason: "not-found",
  });
  expect(screen.getByRole("alert")).toHaveTextContent("not found");
  const kept = t.host.navigation.snapshot().entry.target;
  await act(async () => {
    void t.host.navigation.retry();
  });
  await waitFor(() =>
    expect(t.host.navigation.snapshot().status).toBe("failed"),
  );
  expect(t.host.navigation.snapshot().entry.target).toEqual(kept);
});
it("a newer entity visit cancels old content and Back restores the prior route", async () => {
  const t = setup({ type: "repo", owner, dtag: "repo", tab: "files" });
  t.mount();
  await expect(t.promise).resolves.toEqual({ status: "opened" });
  await userEvent.click(screen.getByRole("button", { name: "README.md" }));
  await screen.findByText("actual file");
  await act(async () => {
    void t.host.navigation.open(
      entityTarget({ type: "issue", owner, dtag: "repo", id: issue.id }, scope),
    );
  });
  await screen.findByText("The issue body");
  expect(screen.queryByText("actual file")).not.toBeInTheDocument();
  await act(async () => t.host.navigation.back());
  await screen.findByRole("button", { name: "README.md" });
  expect(screen.queryByText("actual file")).not.toBeInTheDocument();
});
it("session replacement prevents a late read from opening or revealing old content", async () => {
  const t = setup({ type: "repo", owner, dtag: "repo" });
  let release: (value: GitSnapshot) => void = () => {};
  t.readGit.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  t.mount();
  await waitFor(() => expect(t.readGit).toHaveBeenCalled());
  await act(async () => t.replace());
  await act(async () => release(git));
  expect(screen.queryByText("Actual README")).not.toBeInTheDocument();
  expect(t.host.navigation.snapshot().status).toBe("failed");
});
it("keeps global repository metadata visible when Git access is denied, but fails a files destination", async () => {
  const t = setup({ type: "repo", owner, dtag: "repo" });
  t.readGit.mockRejectedValue(new ReadError("denied", "Access denied"));
  t.mount();
  await screen.findByText("Repository description");
  await expect(t.promise).resolves.toEqual({ status: "opened" });
  expect(
    within(screen.getByRole("region", { name: "Overview" })).getByRole(
      "status",
    ),
  ).toHaveTextContent("require access");
  expect(
    screen.queryByText("No README in this repository."),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Files" }));
  await waitFor(() =>
    expect(t.host.navigation.snapshot()).toMatchObject({
      status: "failed",
      reason: "denied",
    }),
  );
});
it.each([undefined, "files", "commits"] as const)(
  "removes already loaded Git content when access is revoked ($0)",
  async (tab) => {
    const t = setup({
      type: "repo",
      owner,
      dtag: "repo",
      ...(tab ? { tab } : {}),
    });
    t.mount();
    await expect(t.promise).resolves.toEqual({ status: "opened" });
    expect(t.readGit).toHaveBeenCalled();
    await act(async () => t.revoke());
    expect(screen.queryByText("Actual README")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "README.md" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Selected commit" }),
    ).not.toBeInTheDocument();
    if (tab) expect(screen.getByRole("alert")).toBeVisible();
    else expect(screen.getByText("Repository description")).toBeVisible();
  },
);
it.each([true, false])(
  "only the actual repository's revocation invalidates an in-flight Git read (related: %s)",
  async (related) => {
    const t = setup({ type: "repo", owner, dtag: "repo", tab: "files" });
    let release: (value: GitSnapshot) => void = () => {};
    t.readGit.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    t.mount();
    try {
      await waitFor(() => expect(t.readGit).toHaveBeenCalled());
      await act(async () => {
        if (related) t.revoke();
        else t.revokeOther();
      });
      expect(
        screen.queryByRole("button", { name: "README.md" }),
      ).not.toBeInTheDocument();
    } finally {
      await act(async () => release(git));
    }
    if (related) {
      await expect(t.promise).resolves.toEqual({
        status: "failed",
        reason: "denied",
      });
      expect(
        screen.queryByRole("button", { name: "README.md" }),
      ).not.toBeInTheDocument();
    } else {
      await expect(t.promise).resolves.toEqual({ status: "opened" });
      expect(screen.getByRole("button", { name: "README.md" })).toBeVisible();
    }
  },
);

it("resolves linked channels before presentation and removes them on revocation", async () => {
  const t = setup({ type: "repo", owner, dtag: "repo", tab: "channels" });
  t.mount();
  await expect(t.promise).resolves.toEqual({ status: "opened" });
  expect(screen.getByRole("button", { name: "Private channel" })).toBeVisible();
  expect(screen.queryByText("private-channel")).not.toBeInTheDocument();
  expect(screen.queryByText("missing-channel")).not.toBeInTheDocument();
  await act(async () => t.revoke());
  expect(
    screen.queryByRole("button", { name: "Private channel" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("private-channel")).not.toBeInTheDocument();
  expect(screen.getByText("No accessible linked channels.")).toBeVisible();
});

it("omits inaccessible channel metadata without hiding the repository", async () => {
  const t = setup({ type: "repo", owner, dtag: "repo", tab: "channels" });
  const query = t.query.getMockImplementation();
  t.query.mockImplementation(async (filters) =>
    ((await query?.(filters)) ?? []).filter((event) => event.kind !== 39002),
  );
  t.mount();
  await expect(t.promise).resolves.toEqual({ status: "opened" });
  expect(
    screen.getByRole("heading", { name: "Real repository" }),
  ).toBeVisible();
  expect(screen.queryByText("Private channel")).not.toBeInTheDocument();
  expect(screen.queryByText("private-channel")).not.toBeInTheDocument();
  expect(screen.getByText("No accessible linked channels.")).toBeVisible();
});
it("labels PR revision lookup as base-only and disables it without a host Git reader", async () => {
  const t = setup({ type: "pr", owner, dtag: "repo", id: pr.id }, false, false);
  t.mount();
  await expect(t.promise).resolves.toEqual({ status: "opened" });
  expect(screen.getByRole("button", { name: "a".repeat(40) })).toBeDisabled();
  expect(
    screen.getByText(/Exact PR diffs from external forks are unavailable/),
  ).toBeVisible();
});

// Exercise every remote Markdown producer through the real session and destination.
for (const type of ["repo", "issue"] as const) {
  it.each([
    {
      boundary: "at the length limit",
      text: "**bounded**".padEnd(MAX_MARKDOWN_LENGTH, "x"),
      plain: false,
    },
    {
      boundary: "over the length limit",
      text: "**bounded**\n<img src=x>".padEnd(MAX_MARKDOWN_LENGTH + 1, "x"),
      plain: true,
    },
    {
      boundary: "at the depth limit",
      // Root depth is zero; paragraph and text contribute two more levels.
      text: `${"> ".repeat(MAX_MARKDOWN_DEPTH - 2)}bounded`,
      plain: false,
    },
    {
      boundary: "over the depth limit",
      text: `${"> ".repeat(MAX_MARKDOWN_DEPTH - 1)}bounded\n<img src=x>`,
      plain: true,
    },
  ])(
    `renders ${type} content $boundary with the shared bounds`,
    async ({ text, plain }) => {
      const entity = finalizeEvent({ ...repo, content: text }, key);
      const item = finalizeEvent({ ...issue, content: text }, key);
      const comment = finalizeEvent(
        { kind: 1111, created_at: 3, content: text, tags: [["E", item.id]] },
        key,
      );
      const t = setup(
        {
          type,
          owner,
          dtag: "repo",
          ...(type === "issue" ? { id: item.id } : {}),
        } as EntityRoute,
        false,
        true,
        [entity, item, comment],
      );
      t.readGit.mockResolvedValue({ ...git, readme: text });
      const { container } = t.mount();
      await expect(t.promise).resolves.toEqual({ status: "opened" });
      const bodies = container.querySelectorAll(".repo-markdown");
      // Overview description + README, or item + discussion.
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        if (plain) {
          expect(body).toHaveClass("repo-plain");
          expect(body.textContent).toBe(text);
          expect(body.childElementCount).toBe(0);
        } else {
          expect(body).not.toHaveClass("repo-plain");
          expect(body.querySelector("strong, blockquote")).not.toBeNull();
        }
      }
    },
  );
}

it("keeps normal Markdown formatting and routes Buzz links through navigation", async () => {
  const t = setup({ type: "repo", owner, dtag: "repo" });
  const href = `buzz://repo?owner=${owner}&d=repo&tab=issues`;
  t.readGit.mockResolvedValue({
    ...git,
    readme: `## Readme heading\n\n**Formatted** and ~~removed~~\n\n[Issues](${href})\n\n[Unsafe](javascript:alert)`,
  });
  t.mount();
  await expect(t.promise).resolves.toEqual({ status: "opened" });
  const content = screen.getByRole("region", { name: "Overview" });
  expect(
    within(content).getByRole("heading", { name: "Readme heading", level: 2 }),
  ).toBeVisible();
  expect(within(content).getByText("Formatted").tagName).toBe("STRONG");
  expect(within(content).getByText("removed").tagName).toBe("DEL");
  expect(within(content).getByText("Unsafe")).toHaveAttribute("href", "");
  const link = within(content).getByRole("link", { name: "Issues" });
  expect(link).toHaveAttribute("href", href);
  await userEvent.click(link);
  await screen.findByRole("button", { name: "Selected issue" });
  expect(t.host.navigation.snapshot().entry.target).toMatchObject(
    entityTarget({ type: "repo", owner, dtag: "repo", tab: "issues" }, scope),
  );
});
it("reads a repository refused while signed out again once the organization signs in", async () => {
  const t = setup({ type: "repo", owner, dtag: "repo" });
  t.readGit.mockRejectedValueOnce(new Error("Federated sign-in is required"));
  t.mount();
  await screen.findByText("Repository files are unavailable.");
  expect(t.readGit).toHaveBeenCalledTimes(1);
  act(() => t.store.session.recovery?.retryAll());
  await waitFor(() =>
    expect(
      screen.queryByText("Repository files are unavailable."),
    ).not.toBeInTheDocument(),
  );
  expect(t.readGit).toHaveBeenCalledTimes(2);
});
