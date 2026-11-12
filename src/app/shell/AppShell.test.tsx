import { createPortal } from "react-dom";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PageSidebarProps,
  RegisteredPage,
} from "../../features/pages/service";
import { createServices, type AppServices } from "../services";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AppShell } from "./AppShell";
import { createAppearance } from "../../shared/theme/service";
import { Context } from "@deepseek-ai/cordis";
import { BackdropsService } from "../../features/backdrops/service";
import { ShellBackdrops } from "../../features/backdrops/ShellBackdrops";
import { ChannelsPage } from "../../bundled/channels/ChannelsPage";

const testAppearance = createAppearance(window);

vi.mock("../../bundled", () => ({ bundledPlugins: [] }));

// jsdom has no media queries or layout observers; responsive geometry is
// covered in browser tests.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("hides and shows the channel sidebar without re-rendering its content", async () => {
  const current = createServices();
  services = current;
  const renders = vi.fn();
  function Sidebar({ children }: { children: ReactNode }) {
    renders();
    return (
      <aside aria-label="Sidebar" className="shell-sidebar">
        {children}
      </aside>
    );
  }
  const sidebar = (pages: ReactNode) => <Sidebar>{pages}</Sidebar>;
  // Stable inputs, so only `selected` changes between the renders below.
  const pages: RegisteredPage[] = [
    {
      id: "channels",
      key: "buzz.channels/channels",
      pluginId: "buzz.channels",
      revision: "1",
      title: "Channels",
      component: () => null,
      primary: true,
    },
    {
      id: "inbox",
      key: "example.inbox/inbox",
      pluginId: "example.inbox",
      revision: "1",
      title: "Inbox",
      component: () => null,
      primary: true,
      placement: "topbar",
    },
  ];
  const onSelect = () => {};
  const shell = (selected: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected={selected}
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        sidebar={sidebar}
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("buzz.channels/channels"));
  const content = screen.getByRole("complementary", {
    name: "Sidebar",
  });
  const navigation = document.getElementById("shell-navigation");
  const rendered = renders.mock.calls.length;

  for (const [label, hidden] of [
    ["Hide sidebar", "true"],
    ["Show sidebar", "false"],
    ["Hide sidebar", "true"],
    ["Show sidebar", "false"],
  ] as const) {
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(navigation).toHaveAttribute("aria-hidden", hidden);
  }
  expect(content).toBeInTheDocument();
  expect(renders).toHaveBeenCalledTimes(rendered);

  rerender(shell("example.inbox/inbox"));
  expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Hide sidebar" })).toBeNull();
  rerender(shell("buzz.channels/channels"));
  expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
});

it.each([true, false])(
  "keeps the Messages sidebar for a plugin page listed in it, not for an unlisted one (primary: %s)",
  (primary) => {
    const current = createServices();
    services = current;
    render(
      <ToastProvider>
        <AppShell
          pages={[
            {
              id: "channels",
              key: "buzz.channels/channels",
              pluginId: "buzz.channels",
              revision: "1",
              title: "Channels",
              component: () => null,
              primary: true,
            },
            {
              id: "main",
              key: "example.plugin/main",
              pluginId: "example.plugin",
              revision: "1",
              title: "Beacon",
              component: () => null,
              primary,
            },
          ]}
          selected="example.plugin/main"
          navigationAttempt=""
          onSelect={() => {}}
          tone="default"
          sidebar={() => <aside aria-label="Message sidebar">Messages</aside>}
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          Main app content
        </AppShell>
      </ToastProvider>,
    );
    expect(screen.getByText("Main app content")).toBeVisible();
    // A primary page is listed in the Messages sidebar, so it keeps it.
    if (primary) {
      expect(
        screen.getByRole("complementary", { name: "Message sidebar" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Hide sidebar" }),
      ).toBeVisible();
    } else {
      expect(
        screen.queryByRole("complementary", { name: "Message sidebar" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /sidebar/i })).toBeNull();
    }
  },
);

it("renders the default shell unchanged until a plugin registers a backdrop, and again after", async () => {
  const current = createServices();
  services = current;
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const backdrops = new BackdropsService(root);
  const shell = (backdrop?: ReactNode) => (
    <ToastProvider>
      <AppShell
        pages={[]}
        selected="buzz.channels/channels"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
        backdrop={backdrop}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const view = render(shell());
  const baseline = view.container.innerHTML;
  view.rerender(shell(<ShellBackdrops backdrops={backdrops} />));
  expect(view.container.innerHTML).toBe(baseline);

  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) =>
      ctx.backdrops?.register({
        id: "glow",
        component: () => <canvas data-testid="glow" />,
      }),
    );
  await act(() => fiber.await());
  const layer = screen.getByTestId("glow").closest(".shell-backdrop");
  expect(layer?.parentElement).toHaveClass("shell-background");
  expect(layer).toHaveAttribute("aria-hidden", "true");
  expect(layer).toHaveAttribute("inert");

  await act(() => fiber.dispose());
  expect(view.container.innerHTML).toBe(baseline);
  await root.fiber.dispose();
});

it("opens the dock's community switcher from Messages in Personal space", async () => {
  // No saved community: the shell shows Messages without a session, as after
  // leaving the last community or choosing Personal space.
  const current = createServices();
  services = current;
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <AppShell
        pages={[]}
        selected="buzz.channels/channels"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        <ChannelsPage
          relay={current.relay}
          panels={current.panels}
          navigator={current.navigation}
        />
      </AppShell>
    </ToastProvider>,
  );
  const channels = screen.getByRole("region", { name: "Channels" });
  expect(
    within(channels).getByRole("heading", {
      name: "Your channels, one conversation.",
    }),
  ).toBeVisible();
  expect(channels).not.toHaveTextContent(/top bar/i);

  await user.click(
    within(channels).getByRole("button", { name: "Choose a community" }),
  );
  const switcher = await screen.findByRole("dialog", {
    name: "Switch community",
  });
  expect(
    within(switcher).getByRole("button", { name: "Join a community" }),
  ).toBeVisible();

  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Switch community" }),
    ).toBeNull(),
  );
  // Focus lands on the dock's own trigger, which shows where the switcher lives.
  expect(
    within(screen.getByRole("navigation", { name: "Apps dock" })).getByRole(
      "button",
      { name: /^Community switcher: / },
    ),
  ).toHaveFocus();
});

it("keeps built-in sidebar controls available before page contributions load", () => {
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [];
  const shell = (selected: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected={selected}
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  render(shell("buzz.channels/channels"));
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

it("keeps the narrow Messages sidebar in the existing Escape-dismissed navigation drawer", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const current = createServices();
  services = current;
  const sidebar = () => (
    <aside aria-label="Beacon sidebar" className="shell-sidebar">
      <button type="button">Sidebar action</button>
    </aside>
  );
  const pages: RegisteredPage[] = [
    {
      id: "main",
      key: "example.plugin/main",
      pluginId: "example.plugin",
      revision: "1",
      title: "Beacon",
      component: () => null,
      sidebar: () => null,
    },
  ];
  const shell = (attempt: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="buzz.channels/channels"
        navigationAttempt={attempt}
        onSelect={() => {}}
        tone="default"
        sidebar={sidebar}
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("first"));
  const nav = document.getElementById("shell-navigation");
  const toggle = screen.getByRole("button", { name: "Show navigation" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(toggle);
  expect(nav).toHaveAttribute("aria-hidden", "false");
  const action = screen.getByRole("button", { name: "Sidebar action" });
  action.focus();
  // Closing the drawer consumes Escape, so a window-level Escape shortcut
  // (mark as read) does not also fire.
  const reachedWindow = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
  window.addEventListener("keydown", reachedWindow);
  await userEvent.keyboard("{Escape}");
  window.removeEventListener("keydown", reachedWindow);
  expect(reachedWindow).toHaveReturnedWith(true);
  expect(nav).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByRole("button", { name: "Show navigation" })).toHaveFocus();

  await userEvent.click(
    screen.getByRole("button", { name: "Show navigation" }),
  );
  rerender(shell("second"));
  expect(nav).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByRole("button", { name: "Show navigation" })).toBeVisible();
});

it.each([
  { creationInSidebar: true, selected: "buzz.channels/channels" },
  { creationInSidebar: false, selected: "buzz.channels/channels" },
  { creationInSidebar: true, selected: "inbox" },
  // A page listed in the Messages sidebar keeps its New menu.
  { creationInSidebar: true, selected: "example.listed/main" },
  // App omits New from a page's own sidebar, which replaces Messages'.
  { creationInSidebar: false, selected: "example.own-sidebar/main" },
])(
  "keeps New in its sidebar ($selected, sidebar placement: $creationInSidebar)",
  async ({ creationInSidebar, selected }) => {
    const current = createServices();
    services = current;
    const select = vi.fn();
    const create = vi.fn();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <AppShell
          pages={[
            { id: "channels", pluginId: "buzz.channels" },
            { id: "main", pluginId: "example.listed" },
            {
              id: "main",
              pluginId: "example.own-sidebar",
              sidebar: () => null,
            },
          ].map((page) => ({
            ...page,
            key: `${page.pluginId}/${page.id}`,
            title: page.pluginId,
            revision: "one",
            primary: true,
            component: () => null,
          }))}
          selected={selected}
          navigationAttempt="same-conversation"
          onSelect={select}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
          searchServices={current}
          creationInSidebar={creationInSidebar}
          sidebar={(_, action) => (
            <aside aria-label="Sidebar">
              {creationInSidebar
                ? action
                : "Contributed sidebar without children"}
            </aside>
          )}
          creationAction={(open, onOpenChange, container) => (
            <MenuRoot open={open} onOpenChange={onOpenChange}>
              {container &&
                createPortal(
                  <MenuTrigger render={<button type="button">New</button>} />,
                  container,
                )}
              <MenuPopup>
                <MenuItem onClick={create}>New chat</MenuItem>
              </MenuPopup>
            </MenuRoot>
          )}
        >
          Current conversation
        </AppShell>
      </ToastProvider>,
    );
    if (selected !== "inbox") {
      await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
    }
    expect(
      within(screen.getByRole("banner")).queryByRole("button", { name: "New" }),
    ).toBeNull();
    if (!creationInSidebar || selected === "inbox") {
      expect(screen.queryByRole("button", { name: "New" })).toBeNull();
      fireEvent.keyDown(window, { key: "n", ctrlKey: true });
      expect(screen.queryByRole("menuitem", { name: "New chat" })).toBeNull();
      expect(select).not.toHaveBeenCalled();
      return;
    }
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(
      await screen.findByRole("menuitem", { name: "New chat" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Hide sidebar" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(select).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "New chat" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
    expect(create).toHaveBeenCalledOnce();
  },
);

it("shows global pages in the side dock and keeps the conversation mounted across selection", async () => {
  const current = createServices();
  services = current;
  const onSelect = vi.fn();
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Conversation() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <textarea aria-label="Message draft" />;
  }
  const pages = [
    { id: "channels", pluginId: "buzz.channels", title: "Channels" },
    { id: "reminders", pluginId: "buzz.reminders", title: "Reminders" },
    { id: "bestie", pluginId: "buzz.bestie", title: "Bestie" },
  ].map((page) => ({
    ...page,
    key: `${page.pluginId}/${page.id}`,
    revision: "one",
    primary: true,
    component: () => null,
  }));
  const tree = () => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="buzz.channels/channels"
        navigationAttempt="same-conversation"
        onSelect={onSelect}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        <Conversation />
      </AppShell>
    </ToastProvider>
  );
  const view = render(tree());
  const user = userEvent.setup();
  const draft = screen.getByRole("textbox", { name: "Message draft" });
  await user.type(draft, "Keep this draft");
  const dock = screen.getByRole("navigation", { name: "Apps dock" });
  const tabs = within(dock).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Bestie",
    "Messages",
    "Reminders",
  ]);
  expect(screen.getByRole("tablist")).toHaveAttribute(
    "aria-orientation",
    "vertical",
  );
  expect(screen.getByRole("tabpanel", { name: "Messages" })).toContainElement(
    draft,
  );
  expect(screen.getByRole("button", { name: "Search Buzz" })).toHaveTextContent(
    "Search",
  );
  tabs[1]?.focus();
  await user.keyboard("{ArrowDown}");
  expect(tabs[2]).toHaveFocus();
  expect(onSelect).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenLastCalledWith("buzz.reminders/reminders", {
    focus: "preserve",
  });
  view.rerender(tree());
  expect(screen.getByRole("textbox", { name: "Message draft" })).toBe(draft);
  expect(draft).toHaveValue("Keep this draft");
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});

it.each([
  // Channels, DMs, threads and Solo chats all open the Messages page, which
  // has no row of its own in the sidebar.
  ["a conversation", "buzz.channels/channels", undefined],
  ["Drafts & sent", "buzz.drafts-and-sent/drafts-sent", "Drafts & sent"],
  // A third-party page with `primary: true` and no `placement` or `sidebar`.
  ["a third-party plugin page", "example.pr-status/pr-status", "PR status"],
])(
  "keeps Messages selected in the dock with its sidebar on %s",
  async (_destination, selected, row) => {
    const current = createServices();
    services = current;
    const onSelect = vi.fn();
    const pages = [
      { id: "channels", pluginId: "buzz.channels", title: "Channels" },
      { id: "bestie", pluginId: "buzz.bestie", title: "Bestie" },
      {
        id: "drafts-sent",
        pluginId: "buzz.drafts-and-sent",
        title: "Drafts & sent",
      },
      { id: "pr-status", pluginId: "example.pr-status", title: "PR status" },
    ].map((page) => ({
      ...page,
      key: `${page.pluginId}/${page.id}`,
      revision: "one",
      primary: true,
      component: () => null,
    }));
    render(
      <ToastProvider>
        <AppShell
          pages={pages}
          selected={selected}
          navigationAttempt=""
          onSelect={onSelect}
          tone="default"
          sidebar={(links) => <aside aria-label="Sidebar">{links}</aside>}
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          Page content
        </AppShell>
      </ToastProvider>,
    );
    const dock = screen.getByRole("navigation", { name: "Apps dock" });
    const messages = within(dock).getByRole("tab", { name: "Messages" });
    expect(messages).toHaveAttribute("aria-selected", "true");
    expect(within(dock).getByRole("tab", { name: "Bestie" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(
      screen.getByRole("tabpanel", { name: "Messages" }),
    ).toHaveTextContent("Page content");
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(sidebar).toBeVisible();
    // The open page is the only current row in the sidebar.
    expect(within(sidebar).queryByRole("button", { current: "page" })).toBe(
      row ? within(sidebar).getByRole("button", { name: row }) : null,
    );

    // Messages returns from a page opened in its sidebar.
    await userEvent.click(messages);
    if (selected === "buzz.channels/channels")
      expect(onSelect).not.toHaveBeenCalled();
    else
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(
        "buzz.channels/channels",
        { focus: "preserve" },
      );
  },
);

it("keeps Messages selected when a page listed in its sidebar supplies its own sidebar", async () => {
  const current = createServices();
  services = current;
  const onSelect = vi.fn();
  const page = (pluginId: string, id: string, title: string) => ({
    id,
    pluginId,
    title,
    key: `${pluginId}/${id}`,
    revision: "one",
    primary: true,
    component: () => null,
  });
  function PlaygroundSidebar({ children }: PageSidebarProps) {
    return <aside aria-label="Playground sidebar">{children}</aside>;
  }
  const playground: RegisteredPage = {
    ...page("example.playground", "sidebar", "Sidebar playground"),
    sidebar: PlaygroundSidebar,
  };
  render(
    <ToastProvider>
      <AppShell
        pages={[
          page("buzz.channels", "channels", "Channels"),
          page("buzz.bestie", "bestie", "Bestie"),
          playground,
        ]}
        selected={playground.key}
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        // As in App, the open page's own sidebar replaces the Messages sidebar.
        sidebar={(links) => (
          <PlaygroundSidebar
            target={{
              version: 1,
              kind: "page",
              pluginId: playground.pluginId,
              pageId: playground.id,
            }}
          >
            {links}
          </PlaygroundSidebar>
        )}
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        Page content
      </AppShell>
    </ToastProvider>,
  );
  const dock = screen.getByRole("navigation", { name: "Apps dock" });
  const messages = within(dock).getByRole("tab", { name: "Messages" });
  expect(messages).toHaveAttribute("aria-selected", "true");
  expect(within(dock).getByRole("tab", { name: "Bestie" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  expect(screen.getByRole("tabpanel", { name: "Messages" })).toHaveTextContent(
    "Page content",
  );
  // One sidebar: the page's own, still listing the Messages sidebar pages.
  expect(screen.getAllByRole("complementary")).toHaveLength(1);
  const sidebar = screen.getByRole("complementary", {
    name: "Playground sidebar",
  });
  expect(sidebar).toBeVisible();
  expect(
    within(sidebar).getByRole("button", { name: "Sidebar playground" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();

  await userEvent.click(messages);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("buzz.channels/channels", {
    focus: "preserve",
  });
});

it("opens the narrow navigation drawer from Drafts & sent", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const current = createServices();
  services = current;
  const pages = [
    { id: "channels", pluginId: "buzz.channels", title: "Channels" },
    {
      id: "drafts-sent",
      pluginId: "buzz.drafts-and-sent",
      title: "Drafts & sent",
    },
  ].map((page) => ({
    ...page,
    key: `${page.pluginId}/${page.id}`,
    revision: "one",
    primary: true,
    component: () => null,
  }));
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="buzz.drafts-and-sent/drafts-sent"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        sidebar={(links) => <aside aria-label="Sidebar">{links}</aside>}
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        Drafts content
      </AppShell>
    </ToastProvider>,
  );
  const navigation = document.getElementById("shell-navigation");
  const toggle = screen.getByRole("button", { name: "Show navigation" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(navigation).toHaveAttribute("aria-hidden", "true");
  await userEvent.click(toggle);
  expect(navigation).toHaveAttribute("aria-hidden", "false");
  expect(navigation).toContainElement(
    screen.getByRole("complementary", { name: "Sidebar" }),
  );
});

it.each(["sidebar", "dock", "topbar", "toolbar"] as const)(
  "keeps %s plugin icons, badge failures, selection and removal at the navigation boundary",
  async (placement) => {
    const current = createServices();
    services = current;
    const onSelect = vi.fn();
    const icon = "data:image/png;base64,iVBORbeacon";
    const page = (id: string, badge?: () => ReactNode): RegisteredPage => ({
      id,
      key: `example/${id}`,
      pluginId: "example",
      revision: "one",
      title: id,
      primary: true,
      placement,
      icon,
      component: () => null,
      ...(badge ? { badge } : {}),
    });
    const pages = [
      page("Broken", () => {
        throw new Error("broken badge");
      }),
      page("Healthy", () => <span>3 unread</span>),
      { ...page("Search only"), primary: false },
    ];
    const tree = (entries = pages) => (
      <ToastProvider>
        <AppShell
          pages={entries}
          selected="buzz.channels/channels"
          navigationAttempt="same"
          onSelect={onSelect}
          tone="default"
          sidebar={(links) => <aside>{links}</aside>}
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          Retained content
        </AppShell>
      </ToastProvider>
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = render(tree());
      const nav = screen.getByRole("navigation", {
        name: placement === "sidebar" ? "Pages" : "Apps dock",
      });
      const role = placement === "sidebar" ? "button" : "tab";
      const broken = within(nav).getByRole(role, { name: "Broken" });
      const healthy = within(nav).getByRole(role, { name: /Healthy/ });
      expect(healthy).toHaveTextContent("3 unread");
      expect(screen.getAllByRole(role, { name: /Healthy/ })).toHaveLength(1);
      expect(within(nav).queryByRole(role, { name: "Search only" })).toBeNull();
      const image = broken.querySelector("img");
      expect(image).toHaveAttribute("src", icon);
      if (!image) throw new Error("Plugin image missing");
      fireEvent.error(image);
      expect(broken.querySelector("img")).toBeNull();
      expect(broken.querySelector("svg")).toBeInTheDocument();
      await userEvent.click(healthy);
      if (placement === "sidebar") {
        expect(onSelect).toHaveBeenLastCalledWith("example/Healthy");
        expect(screen.getByRole("main")).toHaveFocus();
      } else {
        expect(onSelect).toHaveBeenLastCalledWith("example/Healthy", {
          focus: "preserve",
        });
        expect(healthy).toHaveFocus();
      }
      expect(screen.getByText("Retained content")).toBeVisible();
      view.rerender(tree([]));
      expect(screen.queryByRole(role, { name: /Healthy/ })).toBeNull();
    } finally {
      error.mockRestore();
    }
  },
);

it.each(["sidebar", "topbar"] as const)(
  "previews inactive %s pages on hover while retaining navigation and focus handoff",
  async (placement) => {
    const current = createServices();
    services = current;
    let hover = true;
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: hover && media.includes("(hover: hover)"),
      addEventListener() {},
      removeEventListener() {},
    }));
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const page = (
      id: string,
      preview: RegisteredPage["preview"],
      placement?: RegisteredPage["placement"],
    ): RegisteredPage => ({
      id,
      key: `example/${id}`,
      pluginId: "example",
      revision: "1",
      title: id,
      component: () => null,
      primary: true,
      ...(preview ? { preview } : {}),
      ...(placement ? { placement } : {}),
      ...(placement === "sidebar" ? { sidebar: () => null } : {}),
    });
    const pages = [
      page("Home", undefined, placement),
      page(
        "Inbox",
        ({ close }) => (
          <button type="button" onClick={close}>
            Recent item
          </button>
        ),
        placement,
      ),
      page(
        "Broken",
        () => {
          throw new Error("broken preview");
        },
        placement,
      ),
      page("Notes", undefined, "topbar"),
    ];
    const shell = (selected: string) => (
      <ToastProvider>
        <AppShell
          pages={pages}
          selected={selected}
          navigationAttempt=""
          onSelect={onSelect}
          tone="default"
          sidebar={(links) => (
            <aside aria-label="Fixture sidebar">{links}</aside>
          )}
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          content
        </AppShell>
      </ToastProvider>
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = render(shell("example/Home"));
      const landmark = placement === "sidebar" ? "Pages" : "Apps dock";
      const role = placement === "sidebar" ? "button" : "tab";
      const nav = screen.getByRole("navigation", { name: landmark });
      const inbox = within(nav).getByRole(role, { name: "Inbox" });
      // Rich previews replace the trigger's ordinary title hint.
      expect(inbox).toHaveAttribute("aria-haspopup", "dialog");
      expect(inbox).not.toHaveAttribute("title");
      expect(screen.getByRole("tab", { name: "Notes" })).not.toHaveAttribute(
        "aria-haspopup",
      );
      if (placement === "topbar") {
        // Keyboard focus names the icon-only tile without opening its preview.
        await user.click(within(nav).getByRole(role, { name: "Home" }));
        await user.keyboard("{ArrowDown}");
        expect(inbox).toHaveFocus();
        expect(
          await screen.findByRole("tooltip", { name: "Inbox" }),
        ).toBeVisible();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await user.keyboard("{ArrowUp}");
        await waitFor(() =>
          expect(screen.queryByRole("tooltip", { name: "Inbox" })).toBeNull(),
        );
        onSelect.mockClear();
      }
      await user.hover(inbox);
      const card = await screen.findByRole("dialog", { name: "Inbox" });
      expect(inbox).toHaveAttribute("data-popup-preview");
      await waitFor(() =>
        expect(screen.queryByRole("tooltip", { name: "Inbox" })).toBeNull(),
      );
      // Content closes the card, for example after opening a conversation, and
      // focus is not pulled back to the row.
      await user.click(
        within(card).getByRole("button", { name: "Recent item" }),
      );
      await waitFor(() => expect(card).not.toBeInTheDocument());
      expect(inbox).not.toHaveFocus();

      // A throwing preview renders nothing and leaves navigation usable.
      const broken = within(nav).getByRole(role, { name: "Broken" });
      await user.hover(broken);
      expect(
        await screen.findByRole("dialog", { name: "Broken" }),
      ).toBeEmptyDOMElement();
      await user.click(broken);
      expect(onSelect).toHaveBeenLastCalledWith(
        "example/Broken",
        ...(placement === "topbar" ? [{ focus: "preserve" }] : []),
      );
      await user.unhover(broken);
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );

      // Pressing the row selects its page instead of opening the card.
      await user.click(inbox);
      expect(onSelect).toHaveBeenLastCalledWith(
        "example/Inbox",
        ...(placement === "topbar" ? [{ focus: "preserve" }] : []),
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // A selected page shows no preview of itself.
      view.rerender(shell("example/Inbox"));
      expect(within(nav).getByRole(role, { name: "Inbox" })).toBe(inbox);
      if (placement === "topbar") expect(inbox).toHaveFocus();
      expect(
        within(nav).getByRole(role, { name: "Inbox" }),
      ).not.toHaveAttribute("aria-haspopup");
      if (placement === "topbar") {
        expect(inbox).not.toHaveAttribute("title");
        await user.unhover(inbox);
        await user.hover(inbox);
        expect(
          await screen.findByRole("tooltip", { name: "Inbox" }),
        ).toBeVisible();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(inbox).toHaveFocus();
        // Pressed Inbox, then pressed Home: when an arrow key moves roving
        // focus back, the earlier press no longer hides Inbox's label.
        view.rerender(shell("example/Home"));
        const home = within(nav).getByRole(role, { name: "Home" });
        await user.click(home);
        await user.unhover(home);
        await waitFor(() =>
          expect(screen.queryByRole("tooltip", { name: "Inbox" })).toBeNull(),
        );
        await user.keyboard("{ArrowDown}");
        expect(inbox).toHaveFocus();
        expect(
          await screen.findByRole("tooltip", { name: "Inbox" }),
        ).toBeVisible();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      } else {
        expect(within(nav).getByRole(role, { name: "Inbox" })).toHaveAttribute(
          "title",
          "Inbox",
        );
      }
      view.unmount();

      // Devices without hover never get one.
      hover = false;
      render(shell("example/Home"));
      expect(
        within(screen.getByRole("navigation", { name: landmark })).getByRole(
          role,
          { name: "Inbox" },
        ),
      ).not.toHaveAttribute("aria-haspopup");
    } finally {
      error.mockRestore();
    }
  },
);
