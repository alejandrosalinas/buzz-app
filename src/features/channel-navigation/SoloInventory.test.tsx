// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { writeView } from "../../shared/view-state";
import { conversationTarget, soloDraftTarget } from "./routes";
import type { Contribution } from "../../plugins/contributions";
import type { ChatIcon, ChatMenu } from "../conversation/service";
import { Context } from "@deepseek-ai/cordis";
import {
  SidebarRowsService,
  type SidebarRowContribution,
} from "./sidebar-rows-service";

import {
  fixture,
  owners,
  id,
  other,
  agent,
  outsider,
  root,
  scope,
  viewer,
} from "../../app/shell/sidebar-testing";
stubAvatarBrowserApis();
const rowOwners: Context[] = [];
afterEach(async () => {
  cleanup();
  for (const owner of rowOwners.splice(0)) await owner.fiber.dispose();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function contributedRows(contribution?: SidebarRowContribution) {
  const root = new Context();
  rowOwners.push(root);
  let active = true;
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const rows = new SidebarRowsService(root);
  const fiber = root
    .extend({ pluginOwner: { id: "fixture.rows", revision: "one" } })
    .plugin((ctx) => {
      if (contribution) ctx.reflect.get("sidebarRows")?.register(contribution);
    });
  await fiber.await();
  return {
    rows,
    fiber,
    listeners,
    dispose: () => root.fiber.dispose(),
    disable() {
      act(() => {
        active = false;
        for (const listener of listeners) listener();
      });
    },
  };
}

it.each([false, true])(
  "decorates ordinary Solo rows through the %s combined host with live metadata",
  async (combined) => {
    const seen = vi.fn();
    const plugin = await contributedRows({
      version: 1,
      id: "details",
      render(row, Default) {
        seen(row);
        return (
          <div data-plugin-row={row.id}>
            {Default}
            <span>
              {row.kind}:{row.sectionKey}:
              {row.channel.lastActivityAt ?? "unknown"}:
              {row.unread.observedCount ?? "unknown"}
            </span>
          </div>
        );
      },
    });
    const f = fixture(
      combined,
      false,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      { sidebarRows: plugin.rows },
    );
    const row = screen.getByRole("button", { name: /^Planning/ });
    expect(row.closest("[data-plugin-row]")).toHaveAttribute(
      "data-plugin-row",
      id,
    );
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        kind: "solo",
        sectionKey: "",
        label: "Planning",
      }),
    );
    f.roster((channels) =>
      channels.map((channel) =>
        channel.id === id ? { ...channel, lastActivityAt: 123 } : channel,
      ),
    );
    expect(screen.getByText("solo::123:2")).toBeInTheDocument();
    f.clearUnread();
    expect(screen.getByText("solo::123:0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Planning/ })).toBe(row);
    f.activity({
      ...f.activitySnapshot,
      status: "listening",
      turns: [
        {
          channelId: id,
          agent,
          turnId: "one",
          timestamp: Date.now(),
          state: "working",
        },
      ],
    });
    expect(
      within(row).getByRole("img", { name: /working/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Planning/ })).toBe(row);
    await act(() => plugin.fiber.dispose());
    expect(row.isConnected).toBe(false);
    expect(
      screen
        .getByRole("button", { name: /^Planning/ })
        .closest("[data-plugin-row]"),
    ).toBeNull();
    cleanup();
    expect(f.listeners.size).toBe(0);
    await plugin.dispose();
    expect(plugin.listeners.size).toBe(0);
  },
);

it("keeps the original Solo DOM when the capability has no render contributions", async () => {
  const html = () =>
    document
      .querySelector(`[data-solo-project=""]`)
      ?.innerHTML.replace(/base-ui-_r_[a-z0-9]+_/g, "base-ui-generated");
  fixture();
  const expected = html();
  cleanup();
  const plugin = await contributedRows({
    version: 1,
    id: "sort-only",
    sortModes: [{ id: "reverse", label: "Reverse", compare: () => -1 }],
  });
  fixture(false, false, undefined, undefined, 0, undefined, undefined, {
    sidebarRows: plugin.rows,
  });
  expect(html()).toBe(expected);
});

it("hides the whole Solo entry and skips it as a successor, then restores it on disable", async () => {
  const plugin = await contributedRows({
    version: 1,
    id: "hide",
    render: (row, Default) => (row.id === id ? null : Default),
  });
  const f = fixture(
    true,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    { sidebarRows: plugin.rows },
  );
  expect(screen.queryByRole("button", { name: /^Planning/ })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Actions for Planning" }),
  ).toBeNull();
  expect(document.querySelector(`[data-solo-menu-id="${id}"]`)).toBeNull();
  expect(f.handoff()?.soloNeighbors.current?.(other)).not.toContain(id);
  plugin.disable();
  expect(screen.getByRole("button", { name: /^Planning/ })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Actions for Planning" }),
  ).toBeInTheDocument();
  expect(f.handoff()?.soloNeighbors.current?.(other)).toContain(id);
});

it.each(["neighbor", "heading", "moved"])(
  "recovers focus after plugin hiding to the %s without stealing it",
  async (destination) => {
    const plugin = await contributedRows({
      version: 1,
      id: "live-hide",
      render: (row, Default) =>
        row.channel.lastActivityAt === 1 ? null : Default,
    });
    const f = fixture(
      false,
      false,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      {
        sidebarRows: plugin.rows,
      },
    );
    screen.getByRole("button", { name: /^Planning/ }).focus();
    await act(async () => {
      f.roster((channels) =>
        channels.map((channel) =>
          channel.id === id || destination === "heading"
            ? { ...channel, lastActivityAt: 1 }
            : channel,
        ),
      );
      if (destination === "moved")
        screen.getByRole("button", { name: "Chats" }).focus();
    });
    expect(screen.queryByRole("button", { name: /^Planning/ })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: destination === "neighbor" ? /^Other/ : "Chats",
      }),
    ).toHaveFocus();
  },
);

it.each(["throw", "invalid", "descendant", "disable"])(
  "retains Solo focus through a live %s transition",
  async (failure) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never {
      throw new Error("broken decoration");
    }
    const plugin = await contributedRows({
      version: 1,
      id: "live-failure",
      render(row, Default) {
        if (row.id === id && row.channel.lastActivityAt === 1) {
          if (failure === "throw") throw new Error("broken renderer");
          if (failure === "invalid") return "invalid" as never;
          if (failure === "descendant") return <Broken />;
        }
        return <div>{Default}</div>;
      },
    });
    const f = fixture(
      false,
      false,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      {
        sidebarRows: plugin.rows,
      },
    );
    screen.getByRole("button", { name: /^Planning/ }).focus();
    await act(async () => {
      if (failure === "disable") plugin.disable();
      else
        f.roster((channels) =>
          channels.map((channel) =>
            channel.id === id ? { ...channel, lastActivityAt: 1 } : channel,
          ),
        );
    });
    expect(screen.getByRole("button", { name: /^Planning/ })).toHaveFocus();
    if (failure !== "disable") {
      await act(async () =>
        f.roster((channels) =>
          channels.map((channel) =>
            channel.id === id ? { ...channel, lastActivityAt: 2 } : channel,
          ),
        ),
      );
      expect(screen.getByRole("button", { name: /^Planning/ })).toHaveFocus();
    }
  },
);

it("reports the saved Solo workspace id rather than its drag target key", async () => {
  const seen = vi.fn();
  const plugin = await contributedRows({
    version: 1,
    id: "workspace",
    render(row, Default) {
      seen(row);
      return Default;
    },
  });
  const f = fixture(
    false,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    { sidebarRows: plugin.rows },
  );
  const preferences = f.session.soloPreferences.snapshot();
  Object.assign(preferences, {
    data: {
      ...preferences.data,
      sections: [{ id: "work", name: "Work" }],
      assignments: { [id]: "work" },
    },
  });
  seen.mockClear();
  f.replaceSession();
  expect(seen).toHaveBeenCalledWith(
    expect.objectContaining({ id, kind: "solo", sectionKey: "work" }),
  );
  expect(seen).toHaveBeenCalledWith(
    expect.objectContaining({ id: other, sectionKey: "" }),
  );
});

it("retains selection, menu keyboard access, and rename through the opaque host element", async () => {
  const plugin = await contributedRows({
    version: 1,
    id: "wrap",
    render: (_, Default) => <div data-plugin-row="wrapped">{Default}</div>,
  });
  const f = fixture(
    false,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    { sidebarRows: plugin.rows },
  );
  const user = userEvent.setup();
  Object.assign(f.session, {
    channelDetails: { ...f.session.channelDetails, available: true },
  });
  f.replaceSession();
  const row = screen.getByRole("button", { name: /^Other/ });
  expect(row).toHaveAttribute("aria-current", "page");
  fireEvent.keyDown(row, { key: "ContextMenu" });
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
    "Other",
  );
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: /^Other/ })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: /^Planning/ }), {
    detail: 0,
  });
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
});

it.each(["throw", "invalid", "descendant"])(
  "restores the complete host Solo row after a %s renderer failure",
  async (failure) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never {
      throw new Error("broken decoration");
    }
    const plugin = await contributedRows({
      version: 1,
      id: "broken",
      render(row, Default) {
        if (row.id !== id) return <div data-plugin-row="other">{Default}</div>;
        if (failure === "throw") throw new Error("broken renderer");
        if (failure === "invalid") return "invalid" as never;
        return <Broken />;
      },
    });
    const f = fixture(
      false,
      false,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      { sidebarRows: plugin.rows },
    );
    const row = screen.getByRole("button", { name: /^Planning/ });
    expect(
      screen.getByRole("button", { name: "Actions for Planning" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: /^Other/ })
        .closest("[data-plugin-row]"),
    ).toBeInTheDocument();
    f.clearUnread();
    const restored = screen.getByRole("button", { name: /^Planning/ });
    if (failure !== "descendant") expect(restored).toBe(row);
    fireEvent.click(restored, { detail: 0 });
    expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
  },
);

it.each(["unavailable", "cached", "readOnly"])(
  "immediately opens a narrow Solo row when rename is %s",
  (state) => {
    const f = fixture();
    Object.assign(f.session, {
      channelDetails: {
        ...f.session.channelDetails,
        available: state !== "unavailable",
      },
    });
    if (state !== "unavailable") {
      const channel = f.session.channels
        .list()
        .channels.find((item) => item.id === id);
      if (!channel) throw new Error("Missing Planning fixture");
      Object.assign(channel, { [state]: true });
    }
    f.replaceSession();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 650px)",
      addEventListener() {},
      removeEventListener() {},
    }));
    const row = screen.getByRole("button", { name: /^Planning/ });
    fireEvent.click(row, { detail: 1 });
    expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row);
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull();
  },
);

it("opens the chat if rename admission changes before the double-click completes", () => {
  const f = fixture();
  const details = { ...f.session.channelDetails, available: true };
  Object.assign(f.session, { channelDetails: details });
  f.replaceSession();
  const row = screen.getByRole("button", { name: /^Planning/ });
  details.available = false;
  fireEvent.doubleClick(row);
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
  expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull();
});
it("keeps unread state while owned thread typing and observer working signals start and stop", () => {
  const f = fixture();
  const row = screen.getByRole("button", { name: /^Planning/ });
  const bold = () => row.querySelector('[data-channel-unread-title="true"]');
  expect(bold()).toBeInTheDocument();
  f.typing([{ channelId: id, threadRootId: root, pubkey: outsider }]);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  f.typing([{ channelId: other, pubkey: agent }]);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  f.typing([{ channelId: id, threadRootId: root, pubkey: agent }]);
  expect(
    within(row).getByRole("img", { name: "Owned Agent working in Planning" }),
  ).toBeInTheDocument();
  expect(bold()).toBeInTheDocument();
  expect(row).toHaveAccessibleName(/observed unread messages/);
  expect(row).toHaveAccessibleName(/Owned Agent working in Planning/);
  f.activity({
    ...f.activitySnapshot,
    status: "listening",
    turns: [
      {
        channelId: id,
        agent,
        turnId: "one",
        timestamp: Date.now(),
        state: "working",
      },
    ],
  });
  expect(row.querySelectorAll("[data-channel-working]")).toHaveLength(1);
  f.typing([]);
  expect(within(row).getByRole("img", { name: /working/ })).toBeInTheDocument();
  f.activity(f.activitySnapshot);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  expect(bold()).toBeInTheDocument();
  f.clearUnread();
  expect(row.querySelector("[data-channel-unread]")).toBeNull();
  cleanup();
  expect(f.listeners.size).toBe(0);
});
it("offers unread thread navigation and mark-read through the shared activity popover", async () => {
  const f = fixture();
  const user = userEvent.setup();
  f.threads({
    channelId: id,
    items: [
      {
        channelId: id,
        rootId: root,
        latestMessageId: "e".repeat(64),
        authorId: agent,
        preview: "Needs review",
        unreadCount: 1,
        createdAt: 1,
      },
    ],
    coverage: "observed",
    freshness: "observed",
  });
  const row = screen.getByRole("button", { name: /^Planning/ });
  row.focus();
  await user.keyboard("{Enter}");
  const popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", {
      name: "Mark thread from Owned Agent as read",
    }),
  );
  expect(f.markThrough).toHaveBeenCalledWith(
    { kind: "thread", channelId: id, rootId: root },
    "e".repeat(64),
  );
  await user.click(
    within(popup).getByRole("button", {
      name: "Open unread thread from Owned Agent: Needs review",
    }),
  );
  expect(f.open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: id,
      messageId: root,
    }),
  );
});
it("opens an unread mention from the shared activity popover at its message, with no thread root", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const message = "e".repeat(64);
  f.threads({
    channelId: id,
    items: [],
    mentions: [
      {
        channelId: id,
        messageId: message,
        authorId: agent,
        preview: "Can you sign off?",
        createdAt: 1,
      },
    ],
    coverage: "observed",
    freshness: "observed",
  });
  screen.getByRole("button", { name: /^Planning/ }).focus();
  await user.keyboard("{Enter}");
  await user.click(
    within(
      screen.getByRole("dialog", { name: "Activity in Planning" }),
    ).getByRole("button", {
      name: "Open unread mention from Owned Agent: Can you sign off?",
    }),
  );
  expect(f.open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: id,
      messageId: message,
    }),
  );
  expect(f.open.mock.lastCall?.[0]).not.toHaveProperty("threadRootId");
});
it("opens a typing-only agent's profile activity in its Solo chat", async () => {
  const f = fixture();
  f.typing([{ channelId: id, pubkey: agent }]);
  const user = userEvent.setup();
  screen.getByRole("button", { name: /^Planning/ }).focus();
  await user.keyboard("{Enter}");
  let popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  let intent: unknown;
  const navigate = f.open.getMockImplementation();
  f.open.mockImplementationOnce(async (next) => {
    intent = f.handoff()?.activityAgent.current;
    if (!navigate) throw new Error("Missing navigator");
    return navigate(next);
  });
  await user.click(
    within(popup).getByRole("button", { name: "View Owned Agent activity" }),
  );
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
  // A Solo chat is one conversation, so its page opens the transcript.
  expect(intent).toMatchObject({ channelId: id, agent });
  expect(intent).toHaveProperty("transcript", {});
  screen.getByRole("button", { name: /^Planning/ }).focus();
  await user.keyboard("{Enter}");
  popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", {
      name: "Open conversation for Owned Agent in Planning",
    }),
  );
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
});

it("shows a plugin's chat icon in place of the chat bubble, from when it registers", () => {
  let icons: readonly Contribution<ChatIcon>[] = [];
  const listeners = new Set<() => void>();
  fixture(false, false, undefined, undefined, 0, {
    snapshot: () => icons,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const planning = screen.getByRole("button", { name: /^Planning/ });
  expect(planning.querySelector("[aria-hidden] svg")).not.toBeNull();
  act(() => {
    icons = [
      {
        id: "chat-icon",
        key: "github/chat-icon",
        pluginId: "github",
        revision: "one",
        component: ({ channelId, fallback }) =>
          channelId === id ? (
            <span data-testid="pull">Pull request, merged: </span>
          ) : (
            fallback
          ),
      },
    ];
    for (const listener of listeners) listener();
  });
  expect(within(planning).getByTestId("pull")).toBeInTheDocument();
  expect(planning).toHaveAccessibleName(/^Pull request, merged:\s*Planning/);
  // A chat the plugin knows nothing about keeps its bubble.
  const otherRow = screen.getByRole("button", { name: /^Other/ });
  expect(otherRow.querySelector("[aria-hidden] svg")).not.toBeNull();
});
it.each([
  { observedCount: 1, attentionCount: 1 },
  { observedCount: 1, attentionCount: 0 },
])(
  "bolds a Solo chat for any unread message, without an attention dot ($observedCount unread, $attentionCount attention)",
  (counts) => {
    const f = fixture(false, false, undefined, counts);
    const row = screen.getByRole("button", { name: /^Planning/ });
    expect(
      row.querySelector('[data-channel-unread-title="true"]'),
    ).toBeInTheDocument();
    expect(row.querySelector("[data-channel-priority]")).toBeNull();
    f.clearUnread();
    expect(row.querySelector('[data-channel-unread-title="true"]')).toBeNull();
  },
);

it.each(["new", "linked", "agent", "region"])(
  "selects ordinary drafts without marking a region draft as New chat (%s)",
  async (route) => {
    const f = fixture();
    writeView(scope, "solo:collapsed-projects", [""]);
    const target = soloDraftTarget(
      scope,
      route === "region"
        ? { region: "buzz.region:example:tasks" }
        : route === "agent"
          ? { agent }
          : route === "linked"
            ? { linked: "33333333-3333-4333-8333-333333333333" }
            : {},
    );
    act(() => f.navigate(target));
    if (route === "region") {
      expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
      return;
    }
    const draft = await screen.findByRole("button", { name: "New chat" });
    expect(draft).toHaveAttribute("aria-current", "page");
    expect(draft).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: /^Other/ })).not.toHaveAttribute(
      "aria-current",
    );
    await userEvent.click(draft);
    expect(f.open).toHaveBeenLastCalledWith(target);
    act(() => f.navigate(conversationTarget(scope, id)));
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Planning/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  },
);

it("keeps the open, unread and working chats listed past a workspace's cap", () => {
  const f = fixture(false, false, undefined, undefined, 10);
  const listed = () =>
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("data-solo-channel-id"))
      .filter(Boolean);
  // Seven newest, then unread Planning and open Other past the cap, in order.
  expect(listed()).toEqual([
    ...Array.from({ length: 7 }, (_, index) => `newer-${index}`),
    id,
    other,
  ]);
  // Reading it does not pull the row away; it stays until the workspace folds.
  f.clearUnread();
  expect(listed()).toContain(id);
  f.activity({
    ...f.activitySnapshot,
    status: "listening",
    turns: [
      {
        channelId: "newer-9",
        agent,
        turnId: "one",
        timestamp: Date.now(),
        state: "working",
      },
    ],
  });
  expect(listed()).toContain("newer-9");
  expect(listed()).not.toContain("newer-8");
});

it("renders again only the Solo row whose chat changed", () => {
  const renders = new Map<string, number>();
  const icons: readonly Contribution<ChatIcon>[] = [
    {
      id: "render-count",
      key: "test/render-count",
      pluginId: "test",
      revision: "one",
      component: ({ channelId, fallback }) => {
        renders.set(channelId, (renders.get(channelId) ?? 0) + 1);
        return fallback;
      },
    },
  ];
  const f = fixture(false, false, undefined, undefined, 0, {
    snapshot: () => icons,
    subscribe: () => () => {},
  });
  expect(renders.get(id)).toBeGreaterThan(0);
  renders.clear();
  f.roster((channels) =>
    channels.map((channel) =>
      channel.id === other ? { ...channel, name: "Renamed" } : channel,
    ),
  );
  expect(screen.getByRole("button", { name: /^Renamed/ })).toBeInTheDocument();
  expect(renders.get(other)).toBeGreaterThan(0);
  // Planning's chat did not change, so its row did not render again.
  expect(renders.has(id)).toBe(false);
});

it("renames and opens settings for a chat the roster delivers after mount", async () => {
  const f = fixture();
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(async (channelId: string) => ({
        channelId,
        name: "Fresh",
        description: "",
        visibility: "private",
        labels: ["buzz.solo"],
        canEdit: true,
        version: "one",
      })),
    },
  });
  f.replaceSession();
  f.roster((channels) => [
    ...channels,
    { id: "fresh", name: "Fresh", channelType: "solo", creator: viewer },
  ]);
  const user = userEvent.setup();
  // Rows read their actions when used: a row added after mount must reach
  // the actions of the current render, not those of the first one.
  await user.click(
    await screen.findByRole("button", { name: "Actions for Fresh" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
    "Fresh",
  );
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Actions for Fresh" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Chat settings" }),
  );
  expect(await screen.findByRole("dialog")).toBeVisible();
});

it("describes a Solo row as Shared only when its Shared mark renders", () => {
  fixture();
  expect(screen.getByRole("button", { name: /^Planning/ })).not.toHaveAttribute(
    "aria-describedby",
  );
});

it("shows plugin actions in the primary sidebar right-click menu", async () => {
  const { MenuItem } = await import("../../shared/design-system/ui/Menu");
  const menus: Contribution<ChatMenu>[] = [
    {
      id: "test-menu",
      key: "test/menu",
      pluginId: "test",
      revision: "1",
      component: ({ channelId }) =>
        channelId === id ? <MenuItem>Unlink pull request</MenuItem> : null,
    },
  ];
  fixture(true, false, undefined, undefined, 0, undefined, {
    snapshot: () => menus,
    subscribe: () => () => {},
  });
  fireEvent.keyDown(screen.getByRole("button", { name: /^Planning/ }), {
    key: "ContextMenu",
  });
  expect(
    await screen.findByRole("menuitem", { name: "Unlink pull request" }),
  ).toBeVisible();
});
