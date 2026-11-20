// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { readView, writeView } from "../../shared/view-state";
import {
  conversationTarget,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";

import { fixture, owners, id, viewer, scope, root } from "./sidebar-testing";
import { federatedFixture } from "../../features/federated-identity/testing";
import type { ChannelDetails } from "../../features/relay/channel-details-protocol";
import { createSoloRegionFixture } from "../../features/channel-navigation/solo-navigation-testing";
import { PrimarySidebar } from "./sidebar-section-testing";
import type { OpenTarget } from "../../features/navigation/targets";
import { NewMenu } from "./NewMenu";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import type {
  RegisteredSidebarRestriction,
  SidebarScope,
} from "../../features/channel-navigation/sidebar-scope-service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import { SOLO_LABEL } from "../../features/solo/labels";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import { SIDEBAR_REVEAL_BUDGET_MS } from "../../bundled/channels/useSidebarStartup";
import { teamSidebarSource } from "../../bundled/channels/TeamSidebarSource";
import type { RegisteredSidebarSectionSource } from "../../features/channel-navigation/sidebar-section-components";
import type { RegisteredSidebarSection } from "../../features/channel-navigation/sidebar-sections-service";
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

it("double-clicks a Solo row to edit its selected name, retaining a failed save for retry", async () => {
  const user = userEvent.setup();
  const f = fixture();
  const base: ChannelDetails = {
    channelId: id,
    name: "Planning",
    description: "",
    visibility: "private",
    labels: [SOLO_LABEL],
    version: "original",
    canEdit: true,
  };
  const save = vi.fn(async () => {});
  save.mockRejectedValueOnce(new Error("Couldn’t save the name. Try again."));
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(async () => base),
      save,
    },
  });
  f.navigate(soloDraftTarget(scope));
  const row = screen.getByRole("button", { name: /^Planning/ });
  await user.click(row);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  f.open.mockClear();
  await user.dblClick(row);
  expect(f.open).toHaveBeenCalledTimes(1);
  const name = await screen.findByRole("textbox", { name: "Chat name" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(name).toHaveFocus());
  expect(name).toHaveValue("Planning");
  expect((name as HTMLInputElement).selectionStart).toBe(0);
  expect((name as HTMLInputElement).selectionEnd).toBe(8);
  await user.keyboard("New plan");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t save the name",
  );
  expect(name).toHaveValue("New plan");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(save).toHaveBeenLastCalledWith(
    base,
    expect.objectContaining({ name: "New plan", labels: [SOLO_LABEL] }),
    expect.any(AbortSignal),
    undefined,
    f.session.channels,
  );
  await user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  await screen.findByRole("textbox", { name: "Chat name" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(save).toHaveBeenCalledTimes(2);
});

it("does not open renaming when Solo details are unavailable", async () => {
  const user = userEvent.setup();
  const f = fixture();
  await user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

function delayedRename() {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const save: ChannelDetailsCapability["save"] = vi.fn(
    async (_base, _draft, active) => {
      signal = active;
      await gate;
    },
  );
  const f = fixture();
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(
        async (channelId: string): Promise<ChannelDetails> => ({
          channelId,
          name: channelId === id ? "Planning" : "Other",
          description: "",
          visibility: "private",
          labels: [SOLO_LABEL],
          version: "one",
          canEdit: true,
        }),
      ),
      save,
    },
  });
  f.navigate(soloDraftTarget(scope));
  return {
    user: userEvent.setup(),
    save,
    signal: () => signal,
    finish: async () => {
      await act(async () => {
        finish();
        await gate;
      });
    },
  };
}

it("keeps a click-away save alive when another row is double-clicked", async () => {
  const f = delayedRename();
  await f.user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  const input = screen.getByRole("textbox", { name: "Chat name" });
  await waitFor(() => expect(input).toHaveFocus());
  await f.user.keyboard("First renamed");
  try {
    await f.user.dblClick(screen.getByRole("button", { name: /^Other/ }));
    await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
    expect(input).toHaveValue("First renamed");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(f.signal()?.aborted).toBe(false);
  } finally {
    await f.finish();
  }
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  const destination = screen.getByRole("button", { name: /^Other/ });
  expect(destination).toHaveFocus();
  await f.user.dblClick(destination);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
      "Other",
    ),
  );
  await f.user.keyboard("{Escape}");
});

it("keeps focus on a different chat after an Enter-save finishes", async () => {
  const f = delayedRename();
  await f.user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveFocus(),
  );
  await f.user.keyboard("First renamed{Enter}");
  const destination = screen.getByRole("button", { name: /^Other/ });
  try {
    await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
    await f.user.click(destination);
    expect(destination).toHaveFocus();
  } finally {
    await f.finish();
  }
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(destination).toHaveFocus();
});
it("shows only chats under a plugin restriction and restores the other sections after", async () => {
  let restrictions: readonly RegisteredSidebarRestriction[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: readonly RegisteredSidebarRestriction[]) => {
    restrictions = next;
    for (const listener of listeners) listener();
  };
  const sidebarScope: SidebarScope = {
    snapshot: () => restrictions,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    restrict: () => () => {},
  };
  const contributions: readonly RegisteredSidebarSection[] = [
    {
      version: 1,
      id: "inventory",
      key: "test.sidebar/inventory",
      pluginId: "test.sidebar",
      revision: "fixture",
      title: "Plugin heading",
      icon: null,
      rows: {
        snapshot: () => sectionRows,
        subscribe: () => () => {},
      },
      select: () => conversationTarget(scope, "team"),
    },
  ];
  const sectionRows = [{ id: "plugin-row", label: "Plugin row" }];
  const sources: readonly RegisteredSidebarSectionSource[] = [
    {
      ...teamSidebarSource,
      key: "buzz.channels/team",
      pluginId: "buzz.channels",
      revision: "bundled",
    },
    {
      ...teamSidebarSource,
      id: "team-addon",
      key: "test.sidebar/team-addon",
      pluginId: "test.sidebar",
      revision: "fixture",
      component: ({ render }) =>
        render([
          {
            id: "team-addon",
            defaultPosition: 99,
            element: <span>Team plugin slot</span>,
          },
        ]),
    },
  ];
  const f = fixture(
    true,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    {
      sidebarScope,
      sidebarSections: {
        version: 1,
        register() {},
        subscribe: () => () => {},
        snapshot: () => contributions,
        sourceSnapshot: () => sources,
      },
    },
  );
  f.roster((rows) => [
    ...rows,
    { id: "team", name: "Team row", channelType: "stream" },
  ]);
  expect(await screen.findByText("Plugin heading")).toBeVisible();
  expect(await screen.findByText("Team plugin slot")).toBeVisible();
  act(() =>
    publish([
      {
        id: "focus",
        scope: "solo",
        banner: () => <span>Focusing</span>,
        key: "test.focus/focus",
        pluginId: "test.focus",
        revision: "bundled",
      },
    ]),
  );
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(screen.getByText("Focusing")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Inbox" })).toBeNull();
  expect(screen.getByRole("button", { name: /^Planning/ })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "More actions for Team" }),
  ).toBeNull();
  expect(screen.queryByText("Plugin heading")).toBeNull();
  expect(screen.queryByText("Team plugin slot")).toBeNull();
  f.roster((rows) => rows.filter((row) => row.channelType !== "solo"));
  expect(screen.queryByRole("button", { name: /^Planning/ })).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New options" }));
  await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
  expect(f.open).toHaveBeenLastCalledWith(soloDraftTarget(scope));
  act(() => publish([]));
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(screen.getByText("Plugin heading")).toBeVisible();
  expect(screen.getByText("Team plugin slot")).toBeVisible();
});
it("keeps Solo creation to chats and the New menu above the sections", async () => {
  const user = userEvent.setup();
  const f = fixture(true, true);
  expect(screen.queryByRole("tab")).toBeNull();
  const solo = document.querySelector('[data-sidebar-section="solo"]');
  if (!(solo instanceof HTMLElement)) throw new Error("Missing Solo section");
  expect(
    within(solo).getByRole("button", { name: "New Solo chat" }),
  ).not.toHaveAttribute("aria-haspopup");
  expect(
    within(solo).queryByRole("button", { name: "New options" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "New options" }));
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["New chat", "New channel", "New DM", "New workspace"]);
  await user.click(screen.getByRole("menuitem", { name: "New DM" }));
  expect(f.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: { viewer, communityOrigin: "https://relay.test" },
    route: { version: 1, params: "new-message" },
  });
});

it("collapses the Solo and Team home sections independently", async () => {
  const user = userEvent.setup();
  fixture(true);
  const section = (key: "solo" | "team") => {
    const summary = document.querySelector<HTMLElement>(
      `[data-sidebar-section="${key === "team" ? "channels" : key}"] [aria-controls]`,
    );
    expect(summary).not.toBeNull();
    const panel = document.getElementById(
      summary?.getAttribute("aria-controls") ?? "",
    );
    expect(panel).not.toBeNull();
    return { summary: summary as HTMLElement, panel: panel as HTMLElement };
  };
  const solo = section("solo");
  const team = section("team");
  expect(solo.panel).not.toHaveAttribute("hidden");
  expect(team.panel).not.toHaveAttribute("hidden");

  await user.click(solo.summary);
  expect(solo.panel).toHaveAttribute("hidden");
  expect(team.panel).not.toHaveAttribute("hidden");

  await user.click(team.summary);
  expect(solo.panel).toHaveAttribute("hidden");
  expect(team.panel).toHaveAttribute("hidden");

  expect(section("solo").panel).toHaveAttribute("hidden");
  expect(section("team").panel).toHaveAttribute("hidden");
});

it("mounts one action menu for each home section", async () => {
  vi.useFakeTimers();
  try {
    fixture(true);
    await act(() => vi.advanceTimersByTimeAsync(SIDEBAR_REVEAL_BUDGET_MS));
    const more = (title: string) =>
      document.querySelector(`button[aria-label="More actions for ${title}"]`);
    expect(more("Solo")).not.toBeNull();
    expect(more("Team")).not.toBeNull();
    expect(more("Channels")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("expands Team when navigation selects one of its conversations", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(true);
    f.roster((channels) => [
      ...channels,
      { id: "team-channel", name: "Team channel", channelType: "stream" },
    ]);
    await act(() => vi.advanceTimersByTimeAsync(SIDEBAR_REVEAL_BUDGET_MS));
    const summary = document.querySelector<HTMLElement>(
      '[data-sidebar-section="channels"] [aria-controls]',
    );
    expect(summary).not.toBeNull();
    const panel = document.getElementById(
      summary?.getAttribute("aria-controls") ?? "",
    );
    expect(panel).not.toBeNull();
    fireEvent.click(summary as HTMLElement);
    expect(panel).toHaveAttribute("hidden");

    await act(() =>
      f.open({
        version: 1,
        kind: "conversation",
        channelId: "team-channel",
        scope: { viewer, communityOrigin: "https://relay.test" },
      }),
    );
    expect(panel).not.toHaveAttribute("hidden");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a manually collapsed Solo section closed when navigation selects a chat", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(true);
    f.navigate({
      version: 1,
      kind: "conversation",
      channelId: "team-channel",
      scope: { viewer, communityOrigin: "https://relay.test" },
    });
    await act(() => vi.advanceTimersByTimeAsync(SIDEBAR_REVEAL_BUDGET_MS));
    const summary = document.querySelector<HTMLElement>(
      '[data-sidebar-section="solo"] [aria-controls]',
    );
    expect(summary).not.toBeNull();
    const panel = document.getElementById(
      summary?.getAttribute("aria-controls") ?? "",
    );
    expect(panel).not.toBeNull();
    fireEvent.click(summary as HTMLElement);
    expect(panel).toHaveAttribute("hidden");

    await act(() => f.open(conversationTarget(scope, id)));
    expect(panel).toHaveAttribute("hidden");
    fireEvent.click(summary as HTMLElement);
    expect(panel).not.toHaveAttribute("hidden");
  } finally {
    vi.useRealTimers();
  }
});

it("preserves a source opening only for itself, through a later render", async () => {
  const f = fixture(true);
  f.roster((channels) => [
    ...channels,
    {
      id: "source",
      name: "Source channel",
      channelType: "stream",
      cached: true,
    },
  ]);
  await waitFor(() =>
    expect(document.querySelector('[data-channel-id="source"]')).not.toBeNull(),
  );
  const target = conversationTarget(scope, "source");
  const thread: OpenTarget = {
    version: 1,
    kind: "conversation",
    scope: { viewer, communityOrigin: "https://relay.test" },
    channelId: "source",
    messageId: root,
    threadRootId: root,
  };
  const teamRow = () => document.querySelector('[data-channel-id="source"]');
  await act(() => f.open(target, { sidebar: "preserve" }));
  // Something unrelated rendering the sidebar keeps the preserved opening.
  f.connection({ status: "ready" });
  expect(teamRow()).not.toHaveAttribute("aria-current");
  // A later open in it, here a thread, uses the normal destination rules.
  await act(() => f.open(thread));
  expect(teamRow()).toHaveAttribute("aria-current", "page");
  // Moving within the conversation, as Back and Forward over the thread do,
  // keeps a filter chosen since: it is not a new destination.
  f.navigateWithin(target);
  f.navigateWithin(thread);
  // And a preserved opening from inside that thread applies again.
  await act(() => f.open(target, { sidebar: "preserve" }));
  expect(teamRow()).not.toHaveAttribute("aria-current");
});

it.each([
  ["New workspace", "New workspace", "Cancel"],
  ["New channel", "Create a channel", "Close channel creation"],
])(
  "opens %s and returns focus to New options on cancel",
  async (item, title, close) => {
    const user = userEvent.setup();
    fixture(true, true);
    const trigger = screen.getByRole("button", { name: "New options" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: item }));
    const dialog = await screen.findByRole("dialog", { name: title });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("textbox", { name: "Name" }),
      ).toHaveFocus(),
    );
    await user.click(within(dialog).getByRole("button", { name: close }));
    await waitFor(() => expect(trigger).toHaveFocus());
  },
);

it("keeps unavailable creation actions disabled", async () => {
  const user = userEvent.setup();
  fixture(true);
  await user.click(screen.getByRole("button", { name: "New options" }));
  expect(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("menuitem", { name: "New channel" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.queryByRole("menuitem", { name: "New section" })).toBeNull();
});

it.each([["New options", "New workspace"]])(
  "opens an ordinary workspace draft from %s and ignores later completion after session replacement",
  async (triggerName, itemName) => {
    const f = fixture(true, true);
    const user = userEvent.setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const create = vi
      .spyOn(f.session.sidebarPreferences, "createSection")
      .mockResolvedValueOnce(undefined)
      .mockReturnValue(pending);
    await user.click(screen.getByRole("button", { name: triggerName }));
    await user.click(await screen.findByRole("menuitem", { name: itemName }));
    const first = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(
      within(first).getByRole("textbox", { name: "Name" }),
      "First workspace",
    );
    await user.click(within(first).getByRole("button", { name: "Create" }));
    const project = create.mock.calls[0]?.[0];
    if (!project) throw new Error("Missing created workspace");
    await waitFor(() =>
      expect(f.open).toHaveBeenCalledWith(
        soloDraftTarget(scope, { project: project.id }),
      ),
    );
    await waitFor(() => expect(first).not.toBeInTheDocument());
    f.open.mockClear();
    await user.click(screen.getByRole("button", { name: triggerName }));
    await user.click(await screen.findByRole("menuitem", { name: itemName }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Name" }),
      "Planning",
    );
    try {
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      f.replaceSession();
    } finally {
      await act(async () => {
        finish();
        await pending;
      });
    }
    expect(f.open).not.toHaveBeenCalled();
  },
);

it.each([
  ["New workspace", "New workspace", "Name"],
  ["New channel", "Create a channel", "Name"],
])(
  "retains typed %s input through cached reconnect and session replacement",
  async (item, title, inputName) => {
    const f = fixture(true, true);
    const user = userEvent.setup();
    f.connection({ status: "connecting", cached: true });
    await user.click(screen.getByRole("button", { name: "New options" }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
    const input = within(
      await screen.findByRole("dialog", { name: title }),
    ).getByRole("textbox", { name: inputName });
    await user.type(input, "Keep this draft");
    f.connection({ status: "error" });
    expect(input).toHaveValue("Keep this draft");
    f.replaceSession();
    expect(
      within(screen.getByRole("dialog", { name: title })).getByRole("textbox", {
        name: inputName,
      }),
    ).toHaveValue("Keep this draft");
  },
);

it("header channel creation expands the saved destination without changing other collapsed sections", async () => {
  writeView(scope, "channel-sidebar", {
    collapsed: ["channels", "starred"],
    width: 280,
  });
  const f = fixture(true, true);
  const create = vi
    .spyOn(f.session.channelCreation, "create")
    .mockResolvedValue("new-channel");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New options" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "New channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Create a channel",
  });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Planning",
  );
  await user.click(
    within(dialog).getByRole("button", { name: /^Create channel$/ }),
  );
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "conversation",
        channelId: "new-channel",
      }),
    ),
  );
  expect(readView(scope, "channel-sidebar", null)).toMatchObject({
    collapsed: ["starred"],
    width: 280,
  });
});

it("reveals Solo when New chat reopens the same destination after filtering it out", async () => {
  const f = fixture(true);
  const user = userEvent.setup();
  f.navigate(soloDraftTarget(scope));
  await user.click(screen.getByRole("button", { name: "New options" }));
  await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
});

const soloFailure = vi.hoisted(() => ({ active: false }));
vi.mock("../../bundled/channels/SoloInventory", async (original) => {
  const actual =
    await original<typeof import("../../bundled/channels/SoloInventory")>();
  return {
    ...actual,
    SoloInventory: (props: Parameters<typeof actual.SoloInventory>[0]) => {
      if (soloFailure.active) throw new Error("Solo inventory failed");
      return <actual.SoloInventory {...props} />;
    },
  };
});

it("contains a Solo render failure without rendering the failed inventory in its fallback", async () => {
  const h = createSoloRegionFixture(viewer);
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) => ({ ...channel, cached: true })),
  );
  await h.register({
    composeWorkspaces: true,
    component: ({ ui }) => ui.Chats && <ui.Chats />,
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  soloFailure.active = true;
  try {
    render(
      <ToastProvider>
        <PrimarySidebar
          relay={h.relay}
          navigator={h.navigator}
          target={conversationTarget(h.scope, "chat")}
        >
          <button type="button">Inbox</button>
        </PrimarySidebar>
      </ToastProvider>,
    );
    expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Conversations couldn’t open.",
    );
    soloFailure.active = false;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry sidebar" }));
    expect(await screen.findByRole("button", { name: /^Chat$/ })).toBeVisible();
  } finally {
    soloFailure.active = false;
    consoleError.mockRestore();
    await h.dispose();
  }
});

it("does not reveal or open a channel when its creation completes in a replaced session", async () => {
  writeView(scope, "channel-sidebar", {
    collapsed: ["channels", "starred"],
    width: 280,
  });
  const f = fixture(true, true);
  let finish!: (id: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const create = vi
    .spyOn(f.session.channelCreation, "create")
    .mockReturnValue(pending);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New options" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "New channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Create a channel",
  });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Planning",
  );
  try {
    await user.click(
      within(dialog).getByRole("button", { name: /^Create channel$/ }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    f.replaceSession();
  } finally {
    await act(async () => {
      finish("new-channel");
      await pending;
    });
  }
  expect(f.open).not.toHaveBeenCalled();
  expect(readView(scope, "channel-sidebar", null)).toMatchObject({
    collapsed: ["channels", "starred"],
    width: 280,
  });
});

it.each(["empty", "chats", "projects", "both"])(
  "keeps unfiled creation available with %s",
  async (inventory) => {
    const user = userEvent.setup();
    const f = fixture(true, true);
    const channels = f.session.channels.list();
    const preferences = f.session.sidebarPreferences.snapshot();
    vi.spyOn(f.session.channels, "list").mockReturnValue({
      ...channels,
      channels:
        inventory === "empty" || inventory === "projects"
          ? []
          : channels.channels,
    });
    vi.spyOn(f.session.sidebarPreferences, "snapshot").mockReturnValue({
      ...preferences,
      data: {
        sections:
          inventory === "projects" || inventory === "both"
            ? [{ id: "project", name: "Work", order: 0 }]
            : [],
        assignments: {},
        starred: [],
        muted: [],
      },
    });
    f.connection({});
    expect(
      await screen.findByLabelText("Solo", { selector: "summary" }),
    ).toBeVisible();
    const trigger = screen.getByRole("button", { name: "New options" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
    expect(f.open).toHaveBeenLastCalledWith(soloDraftTarget(scope));
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "New workspace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  },
);

it("keeps new Solo chats available when project creation is unavailable", async () => {
  const user = userEvent.setup();
  const f = fixture(true);
  await user.click(screen.getByRole("button", { name: "New options" }));
  expect(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("menuitem", { name: "New chat" }));
  expect(f.open).toHaveBeenLastCalledWith(soloDraftTarget(scope));
});

it("renders one contributed region heading with no built-in creation action", async () => {
  const h = createSoloRegionFixture(viewer);
  await h.register({ title: "Nexus", component: () => null });
  const target = conversationTarget(h.scope, "owned");
  const view = render(
    <ToastProvider>
      <PrimarySidebar relay={h.relay} navigator={h.navigator} target={target}>
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getAllByText("Nexus")).toHaveLength(1);
    // Headings carry no creation of their own; the New menu owns it.
    expect(
      screen.queryByRole("button", { name: "Create" }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    await h.dispose();
  }
});

it("omits a contributed create action whose menu fails", async () => {
  const h = createSoloRegionFixture(viewer);
  await h.register({
    title: "Nexus",
    component: () => null,
    actions: () => [
      {
        id: "create",
        label: "Create",
        icon: "plus",
        onSelect() {},
        menu() {
          throw new Error("Broken contribution");
        },
      },
    ],
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "owned")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    expect(screen.getAllByText("Nexus")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Create" }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    await h.dispose();
  }
});

it("collapses contributed Solo rows while leaving the single ordinary chat in Solo", async () => {
  const h = createSoloRegionFixture(viewer);
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) => ({ ...channel, cached: true })),
  );
  await h.register({
    title: "Nexus",
    component: ({ ui }) => (
      <ui.Conversation channelId="owned">
        {(c) => <c.Link label={c.name} />}
      </ui.Conversation>
    ),
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "chat")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    const heading = view.container.querySelector(
      '[data-sidebar-section^="solo-region:"] summary',
    );
    expect(heading).not.toBeNull();
    await userEvent.setup().click(heading as HTMLElement);
    await waitFor(() =>
      expect(heading?.closest("details")).not.toHaveAttribute("open"),
    );
    expect(
      document.getElementById(heading?.getAttribute("aria-controls") ?? ""),
    ).toHaveAttribute("hidden");
    expect(await screen.findByRole("button", { name: /^Chat/ })).toBeVisible();
    expect(
      view.container.querySelectorAll(
        '[data-solo-channel-id="chat"], [data-solo-destination-id="chat"]',
      ),
    ).toHaveLength(1);
  } finally {
    view.unmount();
    await h.dispose();
  }
});

// A refused community gets one notice in the toast stack on every page, with
// what fixes it. The sidebar's sign-in prompt and Try again would repeat it.
it("moves a refusal's recovery from the sidebar to its one notice", async () => {
  const h = federatedFixture();
  const f = fixture(
    true,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    {
      federatedIdentity: h.service,
    },
  );
  const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
  // A connection failure with native's sign-in error asks for sign-in here.
  f.connection({ status: "error", error: "Federated sign-in is required" });
  expect(
    within(sidebar()).getByRole("button", {
      name: "Sign in with builderlab.example",
    }),
  ).toBeVisible();
  f.connection({ denied: true, refusal: "sign-in" });
  const notice = await screen.findByRole("dialog", {
    name: "Sign in to open this community",
  });
  expect(
    within(notice).getByRole("button", {
      name: "Sign in with builderlab.example",
    }),
  ).toBeVisible();
  expect(
    within(notice).queryByRole("button", { name: "Try again" }),
  ).toBeNull();
  expect(
    within(sidebar()).queryByRole("button", { name: /Sign in|Try again/ }),
  ).toBeNull();
  expect(within(sidebar()).queryByText(/sign-in/)).toBeNull();
});

// NIP-FA: an issuer refusal is not retried automatically, but the user's
// Try again asks the issuer again rather than repeating it from the cache.
it("makes Try again a person's retry, which asks the issuer again", async () => {
  const h = federatedFixture();
  const f = fixture(
    true,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    {
      federatedIdentity: h.service,
    },
  );
  const retry = vi.spyOn(f.relay, "retry");
  const tryAgain = vi.spyOn(f.relay, "tryAgain");
  const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
  f.connection({
    status: "error",
    error: "grant-refused",
    origin: "wss://relay.example",
  });
  // So its issuer-refusal advice is that Try again, not a restart.
  expect(within(sidebar()).getByRole("alert")).toHaveTextContent(
    "Buzz couldn’t confirm your organization sign-in for this community. Try again. If it keeps happening, contact your administrator.",
  );
  await userEvent
    .setup()
    .click(within(sidebar()).getByRole("button", { name: "Try again" }));
  expect(tryAgain).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
});

it("shows Try again beside a settled failure, and Connecting while the connection retries", async () => {
  const f = fixture(true);
  const retry = vi.spyOn(f.relay, "tryAgain");
  const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
  const error = "ReadError: Relay read failed (502)";
  f.connection({ status: "error", error });
  expect(within(sidebar()).getByText("Couldn’t load channels.")).toBeVisible();
  expect(within(sidebar()).queryByText(/ReadError/)).toBeNull();
  await userEvent
    .setup()
    .click(within(sidebar()).getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledOnce();
  // A refusal is about access, not the connection. Its notice reports it on
  // every page; the sidebar neither repeats it nor offers Try again.
  f.connection({
    status: "error",
    error: "ReadError: Relay read failed (403)",
    denied: true,
  });
  const notice = await screen.findByRole("dialog", {
    name: "You don’t have access to this community",
  });
  expect(
    within(notice).getByRole("button", { name: "Check again" }),
  ).toBeVisible();
  expect(within(sidebar()).queryByText("Couldn’t load channels.")).toBeNull();
  expect(within(sidebar()).queryByText(/have access/)).toBeNull();
  expect(
    within(sidebar()).queryByRole("button", { name: "Try again" }),
  ).toBeNull();
  for (const working of [
    { status: "connecting" },
    { status: "error", error, retrying: true },
  ] as const) {
    f.connection(working);
    expect(within(sidebar()).getByText("Connecting…")).toBeVisible();
    expect(
      within(sidebar()).queryByRole("button", { name: "Try again" }),
    ).toBeNull();
  }
});

it("renders each framed workspace once with creation controls and restores the ordinary frame when the source goes away", async () => {
  const h = createSoloRegionFixture(viewer);
  const preferences = createSidebarPreferencesStore({
    available: true,
    writeStar: async () => [],
    read: async () => ({
      sections: [
        { id: "work", name: "Work", order: 0 },
        { id: "empty", name: "Empty", order: 1 },
        { id: "mixed", name: "Mixed", order: 2 },
      ],
      assignments: {
        chat: "work",
        "public-row": "mixed",
        "mixed-chat": "mixed",
      },
      starred: [],
      muted: [],
    }),
  });
  await preferences.queries.ensure();
  Object.assign(h.session, {
    sidebarPreferences: preferences.queries,
  });
  h.roster([
    {
      id: "chat",
      name: "Chat",
      channelType: "solo",
      creator: viewer,
      cached: true,
    },
    {
      id: "mixed-chat",
      name: "Mixed chat",
      channelType: "solo",
      creator: viewer,
    },
    { id: "public-row", name: "Public channel", channelType: "stream" },
  ]);
  const view = render(
    <ToastProvider>
      <NewMenu relay={h.relay} navigator={h.navigator} />
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "chat")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const checkOrdinary = async () => {
    expect(
      await screen.findByRole("button", { name: "New chat in Work" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "New chat in Empty" }),
    ).toBeVisible();
    expect(
      view.container.querySelectorAll(
        '[data-solo-channel-id="chat"], [data-solo-destination-id="chat"]',
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Chats" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "New options" }));
    expect(
      await screen.findByRole("menuitem", { name: "New chat" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  };
  try {
    await checkOrdinary();
    const source = await act(() =>
      h.register({
        composeWorkspaces: true,
        component: ({ ui }) => {
          const Workspace = ui.Workspace;
          const Chats = ui.Chats;
          if (!Workspace || !Chats)
            throw new Error("Missing workspace composition");
          return (
            <>
              <Workspace id="work" />
              <Workspace id="empty" />
              <Workspace id="mixed" />
              <Chats />
            </>
          );
        },
      }),
    );
    const workspaces = view.container.querySelectorAll(
      '[data-sidebar-section="group:work"]',
    );
    expect(workspaces).toHaveLength(1);
    expect(
      view.container.querySelector('[data-solo-workspace="work"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New chat in Work" }),
    ).toBeVisible();
    const mixed = view.container.querySelectorAll(
      '[data-sidebar-section="group:mixed"]',
    );
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toHaveTextContent("Mixed chat");
    expect(mixed[0]).toHaveTextContent("Public channel");
    expect(
      view.container.querySelector('[data-solo-workspace="mixed"]'),
    ).toBeNull();
    expect(
      view.container.querySelectorAll(
        '[data-solo-channel-id="chat"], [data-solo-destination-id="chat"]',
      ),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "New options" }));
    await screen.findByRole("menuitem", { name: "New workspace" });
    expect(screen.getByRole("menuitem", { name: "New chat" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await act(() => source.fiber.dispose());
    await checkOrdinary();
  } finally {
    view.unmount();
    preferences.dispose();
    await h.dispose();
  }
});

it("shows a disabled region's chat in Solo while leaving its saved filing dormant", async () => {
  const h = createSoloRegionFixture(viewer);
  const saved = {
    sections: [{ id: "personal", name: "Personal", order: 0 }],
    assignments: { owned: "personal" },
    starred: [],
    muted: [],
  };
  const write = vi.fn(async () => saved);
  const preferences = createSidebarPreferencesStore({
    available: true,
    write,
    writeStar: async () => [],
    read: async () => saved,
  });
  await preferences.queries.ensure();
  Object.assign(h.session, { sidebarPreferences: preferences.queries });
  await h.register();
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) =>
        channel.id === "chat" ? { ...channel, cached: true } : channel,
      ),
  );
  h.plugins({
    status: "ready",
    externalPluginsPaused: false,
    catalog: {
      profile: "fixture",
      location: "Fixture",
      plugins: [
        {
          manifest: { id: "example", name: "Example", apiVersion: 1 },
          source: "external",
          enabled: false,
          revision: "one",
          previous: null,
          reloadable: false,
          error: null,
        },
      ],
    },
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "owned")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    const row = await screen.findByRole("button", {
      name: /^Owned$/,
    });
    expect(row.closest("[data-sidebar-section]")).toHaveAttribute(
      "data-sidebar-section",
      "solo",
    );
    expect(
      view.container.querySelectorAll('[data-solo-destination-id="owned"]'),
    ).toHaveLength(1);
    row.focus();
    const user = userEvent.setup();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", { name: "Actions for Owned" });
    expect(
      within(menu).queryByRole("menuitem", { name: "Move to…" }),
    ).toBeNull();
    expect(preferences.queries.snapshot().data?.assignments.owned).toBe(
      "personal",
    );
    expect(write).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    preferences.dispose();
    await h.dispose();
  }
});

it.each(["New options"])(
  "selects the created workspace through its source from %s and retains selection failures for retry",
  async (triggerName) => {
    const h = createSoloRegionFixture(viewer);
    let saved: SidebarPreferences = {
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    };
    const preferences = createSidebarPreferencesStore({
      available: true,
      writeStar: async () => [],
      read: async () => saved,
      write: async () => saved,
      createSection: async (section) => {
        if (!saved.sections.some(({ id }) => id === section.id))
          saved = {
            ...saved,
            sections: [...saved.sections, { ...section, order: 0 }],
          };
        return saved;
      },
    });
    await preferences.queries.ensure();
    Object.assign(h.session, {
      sidebarPreferences: preferences.queries,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const select = vi.fn(async () => {});
    select.mockImplementationOnce(async () => {
      await gate;
      throw new Error("The workspace could not be opened. Try again.");
    });
    const source = await h.register({
      composeWorkspaces: true,
      openWorkspace: select,
      component: ({ ui }) => (ui.Chats ? <ui.Chats /> : null),
    });
    const open = vi.fn(async () => ({ status: "opened" as const }));
    const navigator = { ...h.navigator, open };
    const view = render(
      <ToastProvider>
        <NewMenu relay={h.relay} navigator={navigator} />
        <PrimarySidebar
          relay={h.relay}
          navigator={navigator}
          target={conversationTarget(h.scope, "owned")}
        >
          {null}
        </PrimarySidebar>
      </ToastProvider>,
    );
    const user = userEvent.setup();
    try {
      await user.click(screen.getByRole("button", { name: triggerName }));
      await user.click(
        await screen.findByRole("menuitem", { name: "New workspace" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "New workspace",
      });
      await user.type(
        within(dialog).getByRole("textbox", { name: "Name" }),
        "Planning",
      );
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(select).toHaveBeenCalledOnce());
      const workspace = saved.sections[0];
      if (!workspace) throw new Error("Missing saved workspace");
      expect(select).toHaveBeenLastCalledWith(source.binding(), workspace.id);
      expect(
        within(dialog).getByRole("textbox", { name: "Name" }),
      ).toBeDisabled();
      expect(open).not.toHaveBeenCalled();
      await act(async () => release());
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "The workspace could not be opened",
      );
      await user.click(within(dialog).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(select).toHaveBeenLastCalledWith(source.binding(), workspace.id);
      expect(saved.sections).toEqual([workspace]);
      expect(open).not.toHaveBeenCalled();
    } finally {
      release();
      view.unmount();
      preferences.dispose();
      await h.dispose();
    }
  },
);

it.each(["neighbor", "heading", "moved"])(
  "recovers plain-list focus after the last chat in a workspace disappears (%s)",
  async (destination) => {
    const h = createSoloRegionFixture(viewer);
    const preferences = createSidebarPreferencesStore({
      available: true,
      writeStar: async () => [],
      read: async () => ({
        sections: [{ id: "work", name: "Work", order: 0 }],
        assignments: { chat: "work" },
        starred: [],
        muted: [],
      }),
    });
    await preferences.queries.ensure();
    Object.assign(h.session, { sidebarPreferences: preferences.queries });
    h.roster([
      {
        id: "chat",
        name: "Chat",
        channelType: "solo",
        creator: viewer,
        cached: true,
      },
      { id: "other", name: "Other", channelType: "solo", creator: viewer },
    ]);
    await h.register({
      composeWorkspaces: true,
      component: ({ ui }) => (ui.ChatList ? <ui.ChatList /> : null),
    });
    const view = render(
      <ToastProvider>
        <PrimarySidebar
          relay={h.relay}
          navigator={h.navigator}
          target={conversationTarget(h.scope, "chat")}
        >
          <button type="button">Elsewhere</button>
        </PrimarySidebar>
      </ToastProvider>,
    );
    try {
      const region = view.container.querySelector<HTMLElement>(
        '[data-sidebar-section="solo-region:example/work"]',
      );
      if (!region) throw new Error("Missing Work region");
      const heading = within(region).getByLabelText("Work", {
        selector: "summary",
      });
      const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
      const chat = screen.getByRole("button", { name: "Chat" });
      chat.focus();
      await act(async () => {
        h.roster(
          destination === "heading"
            ? []
            : h.session.channels
                .list()
                .channels.filter(({ id }) => id !== "chat"),
        );
        if (destination === "moved") elsewhere.focus();
      });
      await waitFor(() => expect(chat).not.toBeInTheDocument());
      expect(
        destination === "neighbor"
          ? screen.getByRole("button", { name: "Other" })
          : destination === "heading"
            ? heading
            : elsewhere,
      ).toHaveFocus();
    } finally {
      view.unmount();
      preferences.dispose();
      await h.dispose();
    }
  },
);

it("keeps an ordinary chat editor and pending save through layout changes and task-source recovery", async () => {
  const h = createSoloRegionFixture(viewer);
  const preferences = createSidebarPreferencesStore({
    available: true,
    writeStar: async () => [],
    read: async () => ({
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: { chat: "work" },
      starred: [],
      muted: [],
    }),
  });
  await preferences.queries.ensure();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let savingSignal: AbortSignal | undefined;
  const save = vi.fn<ChannelDetailsCapability["save"]>(
    async (_base, _draft, signal) => {
      savingSignal = signal;
      await gate;
      throw new Error("Couldn’t save the name. Try again.");
    },
  );
  save.mockImplementationOnce(async (_base, _draft, signal) => {
    savingSignal = signal;
    await gate;
    throw new Error("Couldn’t save the name. Try again.");
  });
  Object.assign(h.session, {
    sidebarPreferences: preferences.queries,
    channelDetails: {
      ...h.session.channelDetails,
      available: true,
      load: vi.fn(
        async (): Promise<ChannelDetails> => ({
          channelId: "chat",
          name: "Chat",
          description: "",
          visibility: "private",
          labels: [SOLO_LABEL],
          version: "one",
          canEdit: true,
        }),
      ),
      save,
    },
  });
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) =>
        channel.id === "unknown" ? { ...channel, cached: true } : channel,
      ),
  );
  const source = await h.register({
    composeWorkspaces: true,
    component: ({ ui, snapshot }) => {
      const Workspace = ui.Workspace;
      const Chats = ui.Chats;
      const ChatList = ui.ChatList;
      if (!Workspace || !Chats || !ChatList)
        throw new Error("Missing workspace composition");
      if (snapshot.model === "list") return <ChatList />;
      return (
        <>
          <Workspace id="work">{null}</Workspace>
          <Chats />
        </>
      );
    },
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "chat")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const change = (
    status: "loading" | "ready",
    revision: number,
    model?: string,
  ) =>
    act(() =>
      source.update({
        status,
        binding: source.binding(),
        revision,
        ...(model ? { model } : {}),
      }),
    );
  try {
    await user.dblClick(await screen.findByRole("button", { name: /^Chat$/ }));
    const input = await screen.findByRole("textbox", { name: "Chat name" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("Keep this name");
    change("ready", 2, "list");
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Chat name" })).toBe(input);
    change("loading", 3);
    expect(screen.getByRole("textbox", { name: "Chat name" })).toBe(input);
    expect(input).toHaveValue("Keep this name");
    change("ready", 4, "list");
    expect(screen.getByRole("textbox", { name: "Chat name" })).toBe(input);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    change("loading", 5);
    expect(savingSignal?.aborted).toBe(false);
    expect(screen.getByRole("textbox", { name: "Chat name" })).toBe(input);
    change("ready", 6, "list");
    expect(savingSignal?.aborted).toBe(false);
    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t save the name",
    );
    expect(input).toHaveValue("Keep this name");
    save.mockResolvedValueOnce(undefined);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
    );
  } finally {
    release();
    view.unmount();
    preferences.dispose();
    await h.dispose();
  }
});
