// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { formatPublicKey } from "../../shared/identity/public-key";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { setThreadPlacementPreference } from "../../features/messages/thread-preferences";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationTab as Tab } from "./useChannelTabState";
import { PageTabs, type PageTabOptions, type PageTabTarget } from "./PageTabs";

// The tab's own conversation has its mounted suite; this owner places it.
vi.mock("./ConversationTab", () => ({
  ConversationTab: ({
    tab,
    channel,
    visit,
    onResolvedRoot,
    parent,
  }: {
    tab: Tab;
    channel: { name: string };
    visit: boolean;
    onResolvedRoot?: (rootId: string) => void;
    parent?: { label: string; open(): void };
  }) => (
    <p
      data-tab={tab.id}
      data-message={tab.messageId}
      data-reveal={tab.revealRequest}
      data-mark-read={tab.kind === "conversation" ? tab.markRead : undefined}
      data-focus={tab.focusRequest}
      data-reply={tab.kind === "thread" ? tab.replyRequest : undefined}
    >
      {tab.kind} in {channel.name}
      {!visit && " unvisited"}
      {onResolvedRoot && (
        <button type="button" onClick={() => onResolvedRoot("older")}>
          Resolve root
        </button>
      )}
      {parent && (
        <button type="button" onClick={parent.open}>
          {parent.label}
        </button>
      )}
    </p>
  ),
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function fixture(visits?: boolean) {
  const channels = [
    { id: "alpha", name: "alpha" },
    { id: "beta", name: "beta" },
    { id: "pending", name: "pending", cached: true },
    { id: "dm", name: "Alice", channelType: "dm" },
    {
      id: "group",
      name: "Everyone",
      channelType: "dm",
      participants: ["a", "b", "e", "z"].map((c) => c.repeat(64)),
    },
  ];
  const list = { channels };
  const rows = { rows: [{ id: "root", content: "Root text" }] };
  const profiles = new Map([
    ["a".repeat(64), { name: "Ann" }],
    ["b".repeat(64), { name: "Bob" }],
    ["z".repeat(64), { name: "Zed" }],
  ]);
  const available: never[] = [];
  const session = {
    viewer: "viewer",
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => list,
      window: () => rows,
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: () => Promise.resolve(),
    },
  } as unknown as RelaySession;
  const connection = { status: "ready", session };
  const host = {
    relay: { snapshot: () => connection },
    panels: {
      snapshot: () => available,
      subscribe: () => () => {},
      resolve: () => undefined,
    },
    navigation: { open: vi.fn() },
  } as unknown as ConversationHostServices;
  let open: (target: PageTabTarget, options?: PageTabOptions) => boolean = () =>
    false;
  let close: (target: PageTabTarget) => boolean = () => false;
  let isOpen: (target: PageTabTarget) => boolean = () => false;
  const openers = new Set<typeof open>();
  render(
    <PageTabs
      id="switchboard"
      session={session}
      scope="origin:viewer"
      label="Switchboard"
      host={host}
      extensions={{} as ConversationExtensions}
      visits={visits}
    >
      {(next, closer, opened) => {
        open = next;
        close = closer;
        isOpen = opened;
        openers.add(next);
        return <p>Chat list</p>;
      }}
    </PageTabs>,
  );
  return {
    openers,
    navigation: host.navigation,
    open(target: PageTabTarget, options?: PageTabOptions) {
      let opened = false;
      act(() => {
        opened = open(target, options);
      });
      return opened;
    },
    isOpen: (target: PageTabTarget) => isOpen(target),
    close(target: PageTabTarget) {
      let closed = false;
      act(() => {
        closed = close(target);
      });
      return closed;
    },
  };
}
const tabs = (name: string) =>
  within(screen.getByRole("tablist", { name }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);

const side = () => {
  const list = screen
    .getAllByRole("tablist")
    .find((item) => item.getAttribute("aria-label") !== "Switchboard tabs");
  return within(list as HTMLElement)
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
};

it("keeps the page in view, opening threads in the side pane", () => {
  setThreadPlacementPreference("main");
  const page = fixture();
  expect(screen.getByText("Chat list")).toBeVisible();
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard"]);
  expect(side()).toEqual(["Root text"]);
  expect(screen.getByText("Chat list")).toBeVisible();
  expect(screen.getByText("thread in alpha")).toBeVisible();
});

it("replaces the last opened tab unless asked to keep it", () => {
  const page = fixture();
  expect(page.open({ channelId: "missing" })).toBe(false);
  // Membership a cached channel has not confirmed cannot show a tab.
  expect(page.open({ channelId: "pending" })).toBe(false);
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(side()).toEqual(["Root text"]);
  expect(page.open({ channelId: "beta" }, { keep: true })).toBe(true);
  expect(page.open({ channelId: "alpha" })).toBe(true);
  expect(side()).toEqual(["beta", "alpha"]);
  // Opening a kept tab's conversation again selects it in place.
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(side()).toEqual(["beta", "alpha"]);
  expect(screen.getByText("conversation in beta")).toBeVisible();
  // Pages can depend on one opener across the renders its tabs cause.
  expect(page.openers.size).toBe(1);
});

it("gives each conversation tab its sidebar icon", () => {
  const page = fixture();
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(page.open({ channelId: "dm" }, { keep: true })).toBe(true);
  const list = screen
    .getAllByRole("tablist")
    .find((item) => item.getAttribute("aria-label") !== "Switchboard tabs");
  expect(
    within(list as HTMLElement)
      .getAllByRole("tab")
      .map(
        (tab) =>
          `${
            tab
              .querySelector("svg")
              ?.getAttribute("class")
              ?.match(/tabler-icon-[\w-]+/)?.[0]
          } ${tab.textContent}`,
      ),
  ).toEqual(["tabler-icon-hash beta", "tabler-icon-message-circle Alice"]);
});

it("opens a thread moved to the main pane where it is", () => {
  const page = fixture();
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  act(() => {
    fireEvent.keyDown(screen.getByRole("tab", { name: /Root text/ }), {
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    });
  });
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard", "Root text"]);
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard", "Root text"]);
  // The next plain open does not replace it.
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard", "Root text"]);
  expect(side()).toEqual(["beta"]);
});

it("opens at a message, asking again on each open, with the page's read choice", () => {
  const page = fixture();
  expect(
    page.open({ channelId: "beta", messageId: "post" }, { markRead: false }),
  ).toBe(true);
  const tab = () => screen.getByText("conversation in beta");
  expect(tab()).toHaveAttribute("data-message", "post");
  expect(tab()).toHaveAttribute("data-reveal", "1");
  expect(tab()).toHaveAttribute("data-mark-read", "false");
  // The same message again reveals it again; a later open sets the read choice.
  page.open({ channelId: "beta", messageId: "post" }, { markRead: false });
  expect(tab()).toHaveAttribute("data-reveal", "2");
  page.open({ channelId: "beta" });
  expect(tab()).not.toHaveAttribute("data-message");
  expect(tab()).not.toHaveAttribute("data-mark-read");
  expect(side()).toEqual(["beta"]);
});

it("opens a thread at one of its messages", () => {
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  const thread = () => screen.getByText("thread in alpha");
  expect(thread()).toHaveAttribute("data-message", "reply");
  expect(thread()).toHaveAttribute("data-reveal", "1");
  // Each open at a message asks the reader to show it again.
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  expect(thread()).toHaveAttribute("data-reveal", "2");
  // Opening the thread itself asks for no reveal.
  page.open({ channelId: "alpha", threadId: "root" });
  expect(thread()).toHaveAttribute("data-message", "root");
  expect(thread()).toHaveAttribute("data-reveal", "2");
});

it("reopens a thread opened at a reply in its tab once its root resolves", () => {
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "reply" });
  const thread = () => screen.getByText("thread in alpha");
  const id = thread().getAttribute("data-tab");
  fireEvent.click(screen.getByRole("button", { name: "Resolve root" }));
  expect(
    page.open({ channelId: "alpha", threadId: "reply", messageId: "reply" }),
  ).toBe(true);
  expect(thread()).toHaveAttribute("data-tab", id);
  expect(thread()).toHaveAttribute("data-reveal", "1");
  expect(page.isOpen({ channelId: "alpha", threadId: "older" })).toBe(true);
});

it("opens a page's tabs without visiting their conversations when it asks", () => {
  const page = fixture(false);
  expect(
    page.open({ channelId: "alpha", threadId: "root", messageId: "reply" }),
  ).toBe(true);
  expect(screen.getByText("thread in alpha unvisited")).toHaveAttribute(
    "data-message",
    "reply",
  );
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(screen.getByText("conversation in beta unvisited")).toBeVisible();
});

it("closes a conversation's tab only when one is open", () => {
  const page = fixture();
  expect(page.close({ channelId: "alpha", threadId: "root" })).toBe(false);
  expect(page.open({ channelId: "beta" }, { keep: true })).toBe(true);
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(page.isOpen({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(page.close({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(page.isOpen({ channelId: "alpha", threadId: "root" })).toBe(false);
  expect(side()).toEqual(["beta"]);
  expect(page.close({ channelId: "beta" })).toBe(true);
  expect(screen.getAllByRole("tablist")).toHaveLength(1);
});

it("focuses the composer of each tab it opens, except at a message", () => {
  const page = fixture();
  const tab = () => screen.getByText("conversation in beta");
  const thread = () => screen.getByText("thread in alpha");
  page.open({ channelId: "beta" });
  expect(tab()).toHaveAttribute("data-focus", "1");
  page.open({ channelId: "beta" });
  expect(tab()).toHaveAttribute("data-focus", "2");
  page.open({ channelId: "beta", messageId: "post" });
  expect(tab()).toHaveAttribute("data-focus", "2");
  page.open({ channelId: "alpha", threadId: "root" }, { keep: true });
  expect(thread()).toHaveAttribute("data-focus", "1");
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  expect(thread()).toHaveAttribute("data-focus", "1");
  page.open({ channelId: "alpha", threadId: "root" });
  expect(thread()).toHaveAttribute("data-focus", "2");
  // Focus is not a Reply, which would retarget the reply box at the root.
  expect(thread()).not.toHaveAttribute("data-reply");
});

it("names a thread's conversation inside it, linking where the menu's Open in channel goes", async () => {
  const user = userEvent.setup();
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  await user.click(screen.getByRole("button", { name: "#alpha" }));
  expect(page.navigation.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope: { viewer: "viewer", communityOrigin: "origin" },
    channelId: "alpha",
    messageId: "reply",
    threadRootId: "root",
    context: "channel",
  });
  page.open({ channelId: "dm", threadId: "root" });
  expect(screen.getByRole("button", { name: "DM · Alice" })).toBeVisible();
  // A group DM's caption bounds its names as Inbox rows do; its tab lists all.
  page.open({ channelId: "group", threadId: "root" });
  expect(
    screen.getByRole("button", {
      name: `DM · Ann, Bob, ${formatPublicKey("e".repeat(64))} +1`,
    }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Root text" })).toBeVisible();
});

it("opens a tab's conversation in its channel from the tab's menu", async () => {
  const user = userEvent.setup();
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  const scope = { viewer: "viewer", communityOrigin: "origin" };
  // The menu has handed focus back to the tab, so the destination can take it.
  let focused: Element | null = null;
  vi.mocked(page.navigation.open).mockImplementation(async () => {
    focused = document.activeElement;
    return { status: "opened" };
  });
  const thread = screen.getByRole("tab", { name: /Root text/ });
  await user.pointer({ keys: "[MouseRight]", target: thread });
  await user.click(
    await screen.findByRole("menuitem", { name: "Open in channel" }),
  );
  await vi.waitFor(() => expect(focused).toBe(thread));
  expect(page.navigation.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "alpha",
    messageId: "reply",
    threadRootId: "root",
    context: "channel",
  });
  page.open({ channelId: "beta" });
  await user.pointer({
    keys: "[MouseRight]",
    target: screen.getByRole("tab", { name: /beta/ }),
  });
  await user.click(
    await screen.findByRole("menuitem", { name: "Open in channel" }),
  );
  await vi.waitFor(() =>
    expect(page.navigation.open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "beta",
    }),
  );
});
