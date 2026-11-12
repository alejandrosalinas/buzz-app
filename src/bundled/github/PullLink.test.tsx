// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type { LinkRenderer } from "../../features/conversation/contracts";
import {
  LinkDescriptionContext,
  LinkInteractiveContext,
  LinkLabelContext,
} from "../../features/conversation/LinkLabelContext";
import {
  MessageLink,
  resolveLink,
} from "../../features/conversation/MessageLink";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import inlineStyles from "../../shared/InlineReference.module.css";
import { apply as applyLinks } from "../links/index";
import { apply } from "./index";
import { PullLink } from "./PullLink";
import { issueIcons, stateIcons } from "./pull-state-view";
import type { PullState, PullStates } from "./pull-states";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = "https://github.com/block/buzz-app/pull/7";
const issue = "https://github.com/block/buzz-app/issues/7";
const issueCased = "https://github.com/Block/Buzz-App/issues/7";

/** A store the test moves by hand. */
function fakeStates(initial?: PullState | "failed") {
  let value = initial;
  const listeners = new Set<() => void>();
  const unwatch = vi.fn();
  return {
    watch: vi.fn((_url: string, listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unwatch();
      };
    }),
    get: () => value,
    readAt: () => undefined,
    read: () => Promise.reject(new Error("Links do not read")),
    unwatch,
    set(next: PullState | "failed" | undefined) {
      value = next;
      for (const listener of listeners) listener();
    },
  } satisfies PullStates & Record<string, unknown>;
}
const glyph = (
  Icon:
    | (typeof stateIcons)[keyof typeof stateIcons]
    | (typeof issueIcons)[keyof typeof issueIcons],
) =>
  renderToStaticMarkup(
    <Icon aria-hidden="true" className={inlineStyles.icon} />,
  );
const icon = (container: HTMLElement) =>
  container.querySelector("[data-pr-state]");

it("shows the authored label with the plain pull request glyph until read, then each state's own", () => {
  const states = fakeStates();
  const describe = vi.fn();
  const { container, unmount } = render(
    <LinkDescriptionContext value={describe}>
      <LinkLabelContext value="fix(search): tokens">
        <PullLink url={pull} states={states} />
      </LinkLabelContext>
    </LinkDescriptionContext>,
  );
  expect(container).toHaveTextContent("fix(search): tokens");
  expect(icon(container)).toHaveAttribute("data-pr-state", "unknown");
  expect(icon(container)).toHaveAttribute("title", "Pull request");
  // The state is read out as the link's description, not only shown.
  expect(describe).toHaveBeenLastCalledWith("Pull request");
  expect(icon(container)?.innerHTML).toBe(glyph(stateIcons.open));
  for (const [state, words] of [
    [
      { state: "open", checks: "pending" },
      "Pull request, open, checks running",
    ],
    [{ state: "draft", conflicts: true }, "Pull request, draft, conflicts"],
    [{ state: "merged" }, "Pull request, merged"],
    [{ state: "closed" }, "Pull request, closed"],
  ] as const) {
    act(() => states.set(state));
    expect(icon(container)).toHaveAttribute("data-pr-state", state.state);
    expect(icon(container)).toHaveAttribute("title", words);
    expect(describe).toHaveBeenLastCalledWith(words);
    expect(icon(container)?.innerHTML).toBe(glyph(stateIcons[state.state]));
  }
  // One GitHub cannot read keeps the plain glyph, and says so.
  act(() => states.set("failed"));
  expect(icon(container)).toHaveAttribute("data-pr-state", "unknown");
  expect(icon(container)).toHaveAttribute("title", "Pull request, unavailable");
  expect(describe).toHaveBeenLastCalledWith("Pull request, unavailable");
  expect(icon(container)?.innerHTML).toBe(glyph(stateIcons.open));
  // A removed link leaves the anchor undescribed.
  unmount();
  expect(describe).toHaveBeenLastCalledWith(undefined);
});

it("shows an issue link's authored label with the plain issue glyph until read, then each state's own", () => {
  const states = fakeStates();
  const describe = vi.fn();
  const { container, unmount } = render(
    <LinkDescriptionContext value={describe}>
      <LinkLabelContext value="the crash">
        <PullLink url={issue} states={states} />
      </LinkLabelContext>
    </LinkDescriptionContext>,
  );
  expect(container).toHaveTextContent(/^the crash$/);
  expect(icon(container)).toHaveAttribute("data-pr-state", "unknown");
  expect(icon(container)).toHaveAttribute("title", "Issue");
  expect(describe).toHaveBeenLastCalledWith("Issue");
  expect(icon(container)?.innerHTML).toBe(glyph(issueIcons.open));
  for (const [state, shown, words] of [
    [{ state: "open", title: "Crash on start" }, "open", "Issue, open"],
    [
      { state: "closed", reason: "completed", title: "Crash on start" },
      "completed",
      "Issue, closed as completed",
    ],
    [
      { state: "closed", reason: "not planned", title: "Crash on start" },
      "not planned",
      "Issue, closed as not planned",
    ],
  ] as const) {
    act(() => states.set(state));
    expect(icon(container)).toHaveAttribute("data-pr-state", shown);
    expect(icon(container)).toHaveAttribute("title", words);
    expect(describe).toHaveBeenLastCalledWith(words);
    expect(icon(container)?.innerHTML).toBe(glyph(issueIcons[shown]));
    // The authored label stays; the title read with the state doesn't join it.
    expect(container).toHaveTextContent(/^the crash$/);
  }
  act(() => states.set("failed"));
  expect(icon(container)).toHaveAttribute("data-pr-state", "unknown");
  expect(icon(container)).toHaveAttribute("title", "Issue, unavailable");
  expect(describe).toHaveBeenLastCalledWith("Issue, unavailable");
  expect(icon(container)?.innerHTML).toBe(glyph(issueIcons.open));
  unmount();
  expect(describe).toHaveBeenLastCalledWith(undefined);
});

it("shows what is known of a pull request while composing, without watching it", () => {
  const states = fakeStates({ state: "merged" });
  const { container } = render(
    <LinkInteractiveContext value={false}>
      <PullLink url={pull} states={states} />
    </LinkInteractiveContext>,
  );
  expect(icon(container)).toHaveAttribute("data-pr-state", "merged");
  expect(states.watch).not.toHaveBeenCalled();
});

it("watches the pull request only while shown", () => {
  const states = fakeStates({ state: "open" });
  const { unmount } = render(<PullLink url={pull} states={states} />);
  expect(states.watch).toHaveBeenCalledWith(pull, expect.any(Function));
  expect(states.watch).toHaveBeenCalledOnce();
  unmount();
  expect(states.unwatch).toHaveBeenCalledOnce();
});

/** Both bundled renderers, registered as the host would hold them. */
function renderers() {
  const found: Contribution<LinkRenderer>[] = [];
  const register = (pluginId: string) => (renderer: LinkRenderer) => {
    found.push({
      ...renderer,
      key: `${pluginId}/${renderer.id}`,
      pluginId,
      revision: "one",
    });
  };
  applyLinks({
    conversation: { registerLink: register("buzz.links") },
  } as never);
  apply({
    host: {},
    panels: { register: () => {} },
    conversation: {
      registerChatIcon: () => {},
      registerChatMenu: () => {},
      registerLink: register("buzz.github"),
    },
    relay: {},
    agents: { addTool: () => {} },
    inject: () => {},
  } as never);
  const [links, github] = found;
  if (!links || !github) throw new Error("expected both renderers");
  return { links, github };
}
const registry = (entries: readonly Contribution<LinkRenderer>[]) => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});
const message = (
  entries: readonly Contribution<LinkRenderer>[],
  interactive = true,
) =>
  render(
    <ToastProvider>
      <MessageLink
        url={pull}
        registry={registry(entries)}
        onOpenLink={() => true}
        label="Fix the lab"
        interactive={interactive}
      />
    </ToastProvider>,
  );

it("takes repository, pull request, issue and commit links from Links, which keeps the rest of GitHub and stands in without it", async () => {
  const { links, github } = renderers();
  expect(resolveLink(pull, [links, github])).toBe(github);
  for (const url of [issue, `${issue}?q=1`, `${issue}/`, issueCased])
    expect(resolveLink(url, [links, github])).toBe(github);
  // Pull request sub-targets share the parent's badge; issue ones stay Links'.
  for (const url of [`${pull}#issuecomment-1`, `${pull}/files`])
    expect(resolveLink(url, [github, links])).toBe(github);
  for (const url of [
    "https://github.com/block/buzz-app",
    "https://github.com/block/buzz-app/commit/abcdef1",
  ])
    expect(resolveLink(url, [links, github])).toBe(github);
  for (const url of [
    "https://github.com/block",
    "https://github.com/block/buzz-app/blob/main/README.md",
    `${issue}#issuecomment-1`,
    `${issue}/timeline`,
  ])
    expect(resolveLink(url, [github, links])).toBe(links);

  // Without gh in this host, the state comes from the public API.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ title: "A useful change", state: "open" }),
        ),
    ),
  );
  const both = message([links, github]);
  const anchor = screen.getByRole("link", { name: "Fix the lab" });
  expect(anchor).toHaveAttribute("href", pull);
  expect(anchor).toHaveAttribute("data-link-renderer", "buzz.github/pull");
  expect(anchor.className).toBe(inlineStyles.link);
  expect(icon(both.container)).toHaveAttribute("data-pr-state", "unknown");
  await waitFor(() =>
    expect(icon(both.container)).toHaveAttribute("data-pr-state", "open"),
  );
  // The state describes the link; the link keeps its authored name, not the
  // title read with the state.
  expect(anchor).toHaveAttribute("aria-description", "Pull request, open");
  expect(screen.getByRole("link", { name: "Fix the lab" })).toBe(anchor);
  expect(anchor).not.toHaveTextContent("A useful change");
  cleanup();

  const only = message([links]);
  expect(screen.getByRole("link")).toHaveAttribute(
    "data-link-renderer",
    "buzz.links/links",
  );
  expect(icon(only.container)).toBeNull();
  expect(only.container.querySelector("[data-link-kind]")).toHaveAttribute(
    "data-link-kind",
    "github",
  );
});

it("shares one PR badge state across anchors and subpages while keeping each full destination", async () => {
  const { links, github } = renderers();
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify({ state: "closed", merged: true })),
  );
  vi.stubGlobal("fetch", fetch);
  const onOpenLink = vi.fn(() => true);
  const urls = [
    pull,
    `${pull}#top`,
    `${pull}/commits`,
    `${pull}/checks?check_run_id=1`,
    `${pull}/changes#diff-123`,
  ];
  const { container } = render(
    <ToastProvider>
      {urls.map((url) => (
        <MessageLink
          key={url}
          url={url}
          registry={registry([links, github])}
          onOpenLink={onOpenLink}
          label={url}
        />
      ))}
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(container.querySelectorAll('[data-pr-state="merged"]')).toHaveLength(
      urls.length,
    );
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/repos/block/buzz-app/pulls/7",
  );
  for (const url of urls) {
    const anchor = screen.getByRole("link", { name: url });
    expect(anchor).toHaveAttribute("href", url);
    expect(anchor).toHaveAttribute("data-link-renderer", "buzz.github/pull");
    expect(anchor).toHaveAttribute("aria-description", "Pull request, merged");
    fireEvent.click(anchor);
    expect(onOpenLink).toHaveBeenLastCalledWith(url);
  }
});

/** A link pasted as its URL, as messages give the renderer one. */
const pasted = (entries: readonly Contribution<LinkRenderer>[], url: string) =>
  render(
    <ToastProvider>
      <MessageLink
        url={url}
        registry={registry(entries)}
        onOpenLink={() => true}
      />
    </ToastProvider>,
  );

it("names a pasted pull request link by its repository and number, then the title read with its state", async () => {
  const { links, github } = renderers();
  const raw = "https://github.com/block/buzz-app/pull/8";
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ title: "Fix the lab", state: "closed", merged: true }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const { container } = pasted([links, github], raw);
  const anchor = screen.getByRole("link", { name: "buzz-app#8" });
  expect(anchor).toHaveAttribute("href", raw);
  expect(anchor).toHaveAttribute("aria-description", "Pull request");
  await waitFor(() =>
    expect(icon(container)).toHaveAttribute("data-pr-state", "merged"),
  );
  // The title arrives with the state, from the one read the icon makes.
  expect(anchor).toHaveAccessibleName("buzz-app#8 · Fix the lab");
  expect(anchor).toHaveAttribute("aria-description", "Pull request, merged");
  // The owner the name leaves out is in the URL its tooltip shows.
  expect(anchor).toHaveAttribute("title", raw);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/block/buzz-app/pulls/8",
    expect.anything(),
  );
});

it("names a pasted issue link by its repository and number, then the title read with its state", async () => {
  const { links, github } = renderers();
  const raw = "https://github.com/block/buzz-app/issues/12";
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          title: "Crash on start",
          state: "closed",
          state_reason: "not_planned",
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const { container } = pasted([links, github], raw);
  const anchor = screen.getByRole("link", { name: "buzz-app#12" });
  expect(anchor).toHaveAttribute("href", raw);
  expect(anchor).toHaveAttribute("data-link-renderer", "buzz.github/pull");
  expect(anchor).toHaveAttribute("aria-description", "Issue");
  await waitFor(() =>
    expect(icon(container)).toHaveAttribute("data-pr-state", "not planned"),
  );
  // The title arrives with the state, from the one read the icon makes.
  expect(anchor).toHaveAccessibleName("buzz-app#12 · Crash on start");
  expect(anchor).toHaveAttribute(
    "aria-description",
    "Issue, closed as not planned",
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/block/buzz-app/issues/12",
    expect.anything(),
  );
});

it.each([
  ["pull request", "pull", "Pull request, unavailable"],
  ["issue", "issues", "Issue, unavailable"],
])(
  "names a pasted %s link by its repository and number when it cannot be read",
  async (_, surface, words) => {
    const { links, github } = renderers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const { container } = pasted(
      [links, github],
      `https://github.com/block/buzz-app/${surface}/9`,
    );
    const anchor = screen.getByRole("link", { name: "buzz-app#9" });
    await waitFor(() =>
      expect(anchor).toHaveAttribute("aria-description", words),
    );
    expect(icon(container)).toHaveAttribute("data-pr-state", "unknown");
    expect(anchor).toHaveAccessibleName("buzz-app#9");
  },
);

it("renames a pasted pull request link with each title the store reads, and names it by number alone when nothing is held", () => {
  const states = fakeStates({ state: "open", title: "Fix the lab" });
  const { container } = render(<PullLink url={pull} states={states} />);
  expect(container).toHaveTextContent(/^buzz-app#7 · Fix the lab$/);
  act(() => states.set({ state: "merged", title: "Fix the lab, renamed" }));
  expect(container).toHaveTextContent(/^buzz-app#7 · Fix the lab, renamed$/);
  act(() => states.set("failed"));
  expect(container).toHaveTextContent(/^buzz-app#7$/);
});

it("renames a pasted issue link with each title the store reads, and shows what is held of it while composing, without watching it", () => {
  const states = fakeStates({ state: "open", title: "Crash on start" });
  const shown = render(<PullLink url={issue} states={states} />);
  expect(shown.container).toHaveTextContent(/^buzz-app#7 · Crash on start$/);
  expect(states.watch).toHaveBeenCalledWith(issue, expect.any(Function));
  act(() =>
    states.set({
      state: "closed",
      reason: "completed",
      title: "Crash on start, renamed",
    }),
  );
  expect(shown.container).toHaveTextContent(
    /^buzz-app#7 · Crash on start, renamed$/,
  );
  shown.unmount();
  states.watch.mockClear();
  const composing = render(
    <LinkInteractiveContext value={false}>
      <PullLink url={issueCased} states={states} />
    </LinkInteractiveContext>,
  );
  expect(icon(composing.container)).toHaveAttribute(
    "data-pr-state",
    "completed",
  );
  expect(composing.container).toHaveTextContent(
    /^Buzz-App#7 · Crash on start, renamed$/,
  );
  expect(states.watch).not.toHaveBeenCalled();
});

it("reads nothing for a pull request link while it is composed", async () => {
  const { links, github } = renderers();
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ state: "open" })),
  );
  vi.stubGlobal("fetch", fetch);
  // Typing the link mounts a decoration for `/pull/1`, `/pull/17`, …; none of
  // them spends a public read.
  const { container } = message([links, github], false);
  // The store reads in a microtask after the first subscriber; flush it.
  await act(async () => {});
  expect(screen.queryByRole("link")).toBeNull();
  expect(container).toHaveTextContent("Fix the lab");
  expect(icon(container)).toHaveAttribute("data-pr-state", "unknown");
  expect(fetch).not.toHaveBeenCalled();
});

it("leaves the plain link when the renderer fails", () => {
  const { links, github } = renderers();
  const broken = {
    ...github,
    component: () => {
      throw new Error("broken renderer");
    },
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { container } = message([links, broken]);
    const anchor = screen.getByRole("link", { name: "Fix the lab" });
    expect(anchor).toHaveAttribute("href", pull);
    expect(anchor).not.toHaveAttribute("data-link-renderer");
    expect(container.querySelector("[data-link-kind]")).toBeNull();
  } finally {
    error.mockRestore();
  }
});
