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
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  SOLO_CHAT_CAP,
  SOLO_CHAT_STEP,
  SoloWorkspaces,
  type ChatListItem,
} from "./SoloWorkspaces";
import { createSoloRegionFixture } from "../../features/channel-navigation/solo-navigation-testing";
import { readView } from "../../shared/view-state";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  cleanup();
  localStorage.clear();
});

/** A workspace heading's row, which also holds its actions. */
const PROJECT_HEADER = '[data-solo-menu-id^="project-"]';
/** The workspace containing a heading: its row and its chats. */
function projectOf(heading: HTMLElement) {
  const project = heading.closest(PROJECT_HEADER)?.parentElement;
  if (!project) throw new Error("Missing project");
  return project;
}
function fixture(projectName = "Work") {
  const owner = createRelaySession(null);
  const details = { ...owner.session.channelDetails };
  owners.push(owner);
  let saved: SidebarPreferences = {
    sections: [{ id: "work", name: projectName, order: 0 }],
    assignments: {},
    starred: [],
    muted: [],
  };
  const write = vi.fn(
    async (intent: {
      channelId?: string;
      sectionId?: string;
      createSection?: { id: string; name: string };
    }) => {
      if (intent.createSection)
        saved = {
          ...saved,
          sections: [...saved.sections, { ...intent.createSection, order: 1 }],
        };
      const assignments = { ...saved.assignments };
      const target = intent.createSection?.id ?? intent.sectionId;
      if (intent.channelId !== undefined) {
        if (target) assignments[intent.channelId] = target;
        else delete assignments[intent.channelId];
      }
      saved = { ...saved, assignments };
      return saved;
    },
  );
  const remove = vi.fn(async (id: string) => {
    saved = {
      ...saved,
      sections: saved.sections.filter((project) => project.id !== id),
      assignments: Object.fromEntries(
        Object.entries(saved.assignments).filter(
          ([, project]) => project !== id,
        ),
      ),
    };
    return saved;
  });
  const store = () =>
    createSidebarPreferencesStore({
      read: async () => saved,
      available: true,
      write,
      writeStar: async () => [],
      removeSection: remove,
      // Groups-only chats have no Messages sort coordinate.
      groupsOnly: true,
    });
  const onNew = vi.fn();
  const channels = {
    status: "ready",
    channels: [
      { id: "chat", name: "Planning", channelType: "solo" },
      { id: "other", name: "Existing chat", channelType: "solo" },
    ],
  };
  const view = (
    preferences: ReturnType<typeof store>["queries"],
    scope = "viewer:community",
    unread: unknown = owner.session.unread,
    chats: readonly ChatListItem[] = [
      { id: "chat", title: "Planning" },
      { id: "other", title: "Existing chat" },
    ],
  ) => (
    <SoloWorkspaces
      onNew={onNew}
      session={
        {
          ...owner.session,
          channelDetails: details,
          soloPreferences: preferences,
          unread,
          canvas: { available: false },
          channels: { list: () => channels, subscribeList: () => () => {} },
        } as unknown as RelaySession
      }
      scope={scope}
      chats={chats}
      renderChat={(item, rename) => (
        <button type="button" onDoubleClick={rename}>
          {item.title}
        </button>
      )}
    />
  );
  return {
    store,
    details,
    view,
    write,
    remove,
    onNew,
    saved: () => saved,
  };
}

it("creates and moves through the relay service, then restores in a fresh store", async () => {
  const h = fixture();
  const first = h.store();
  const user = userEvent.setup();
  const mounted = render(h.view(first.queries));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for Planning" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("button", { name: "Actions for Planning" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Chat settings" }),
  ).toHaveAttribute("aria-disabled", "true");
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Workspace name" }),
    "Projects",
  );
  await user.click(screen.getByRole("button", { name: "Create and move" }));
  await waitFor(() =>
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "chat",
        createSection: expect.objectContaining({ name: "Projects" }),
      }),
      expect.objectContaining({ aborted: false }),
    ),
  );
  await waitFor(() =>
    expect(screen.queryByText("Saving workspace…")).toBeNull(),
  );
  expect(h.saved().assignments.chat).toBe(h.saved().sections[1]?.id);
  mounted.unmount();
  first.dispose();
  const second = h.store();
  render(h.view(second.queries, "other-device"));
  const project = await screen.findByRole("button", { name: "Projects" });
  expect(projectOf(project)).toHaveTextContent("Planning");
  fireEvent.click(project);
  expect(screen.queryByRole("button", { name: "Planning" })).toBeNull();
  expect(screen.getByRole("button", { name: "Existing chat" })).toBeVisible();
  second.dispose();
});

it("rolls back a rejected move and keeps retry available", async () => {
  const h = fixture();
  const store = h.store();
  const user = userEvent.setup();
  h.write.mockRejectedValueOnce(new Error("Relay unavailable"));
  render(h.view(store.queries));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for Planning" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("button", { name: "Actions for Planning" }),
  );
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(await screen.findByText("Relay unavailable")).toBeVisible();
  expect(
    projectOf(screen.getByRole("button", { name: "Chats" })),
  ).toHaveTextContent("Planning");
  await user.click(screen.getByRole("button", { name: "Retry move" }));
  await waitFor(() => expect(h.saved().assignments.chat).toBe("work"));
  await waitFor(() =>
    expect(screen.queryByText("Relay unavailable")).toBeNull(),
  );
  expect(
    projectOf(screen.getByRole("button", { name: "Work" })),
  ).toHaveTextContent("Planning");
  store.dispose();
});

it("keeps chats after project deletion and allows retry after a rejected deletion", async () => {
  const h = fixture();
  const owner = h.store();
  const user = userEvent.setup();
  await owner.queries.ensure();
  await owner.queries.assign("chat", "work");
  render(h.view(owner.queries));
  h.remove.mockRejectedValueOnce(new Error("Deletion unavailable"));
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workspace" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Deletion unavailable",
  );
  expect(screen.getByRole("button", { name: "Work" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workspace" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Planning" })).toBeVisible();
  expect(h.saved().assignments).toEqual({});
  owner.dispose();
});

it("starts an unfiled chat from the Chats heading plus without collapsing it", async () => {
  const h = fixture();
  const owner = h.store();
  render(h.view(owner.queries));
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "New chat in Chats" }),
  );
  expect(h.onNew).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  owner.dispose();
});

it("copies the chat link", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<ToastProvider>{h.view(h.store().queries)}</ToastProvider>);
  await user.click(
    await screen.findByRole("button", { name: "Actions for Planning" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  expect(write).toHaveBeenCalledWith("buzz://channel/chat");
  expect(await screen.findByText("Link copied.")).toBeVisible();
});

it("reports a clipboard failure without claiming success", async () => {
  const h = fixture();
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  render(<ToastProvider>{h.view(h.store().queries)}</ToastProvider>);
  await user.click(
    await screen.findByRole("button", { name: "Actions for Planning" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  expect(await screen.findByText("Couldn’t copy the link.")).toBeVisible();
});

it("only offers Chats as a destination from a project", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const store = h.store();
  render(h.view(store.queries));
  const openProjectMenu = async () => {
    await user.click(
      await screen.findByRole("button", { name: "Actions for Planning" }),
    );
    (await screen.findByRole("menuitem", { name: "Move to" })).focus();
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("menuitem", { name: "New workspace" });
  };
  await openProjectMenu();
  expect(screen.queryByRole("menuitem", { name: "Chats" })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "Work" }));
  await waitFor(() => expect(h.saved().assignments.chat).toBe("work"));
  await openProjectMenu();
  await user.click(screen.getByRole("menuitem", { name: "Chats" }));
  await waitFor(() => expect(h.saved().assignments.chat).toBeUndefined());
  store.dispose();
});

it("starts a chat in a project from its heading plus", async () => {
  const h = fixture();
  const store = h.store();
  const user = userEvent.setup();
  render(h.view(store.queries));
  try {
    const heading = await screen.findByRole("button", { name: "Work" });
    const header = heading.closest<HTMLElement>(PROJECT_HEADER);
    if (!header) throw new Error("Missing project header");
    await user.click(
      within(header).getByRole("button", { name: "New chat in Work" }),
    );
    expect(h.onNew).toHaveBeenCalledExactlyOnceWith("work");
  } finally {
    store.dispose();
  }
});

it("opens the exact project from an empty project's New chat row", async () => {
  const projectName =
    "A very long project name that should not become the new chat label";
  const h = fixture(projectName);
  const store = h.store();
  const user = userEvent.setup();
  render(h.view(store.queries, "empty-project"));
  try {
    const choices = await screen.findAllByRole("button", {
      name: `New chat in ${projectName}`,
    });
    const row = choices.find((choice) => choice.textContent === "New chat");
    expect(row).toBeDefined();
    if (!row) throw new Error("Missing empty project action");
    row.focus();
    await user.keyboard("{Enter}");
    expect(h.onNew).toHaveBeenCalledExactlyOnceWith("work");
  } finally {
    store.dispose();
  }
});

it("marks a chat read from its row menu and reports a failed save", async () => {
  const h = fixture();
  const store = h.store();
  const user = userEvent.setup();
  const markChannelRead = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read state unavailable"))
    .mockResolvedValue(undefined);
  const snapshot = (channelId: string, observedCount: number) => ({
    target: { kind: "channel", channelId },
    observedCount,
    attentionCount: 0,
    manual: "none",
    coverage: "observed",
    freshness: "observed",
  });
  const unreadChat = snapshot("chat", 3);
  const readChat = snapshot("other", 0);
  const unread = {
    sync: () => ({ capability: "frontier-sync" }),
    snapshot: (target: { channelId: string }) =>
      target.channelId === "chat" ? unreadChat : readChat,
    subscribe: () => () => {},
    markChannelRead,
    markUnreadLocal: vi.fn(),
  };
  render(h.view(store.queries, "viewer:community", unread));
  try {
    const actions = screen.getByRole("button", {
      name: "Actions for Planning",
    });
    await user.click(actions);
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as read" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Read state unavailable",
    );
    await user.click(actions);
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as read" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(markChannelRead).toHaveBeenNthCalledWith(2, "chat");
  } finally {
    store.dispose();
  }
});

it("toggles a deferred collapse intent and protects a failed rename from workspace deletion", async () => {
  const h = fixture();
  Object.assign(h.details, {
    available: true,
    load: vi.fn(async () => ({
      channelId: "chat",
      name: "Planning",
      description: "",
      visibility: "private",
      labels: ["buzz.solo"],
      canEdit: true,
      version: "one",
    })),
    save: vi.fn(async () => {
      throw new Error("Save failed");
    }),
  });
  const owner = h.store();
  await owner.queries.ensure();
  await owner.queries.assign("chat", "work");
  render(h.view(owner.queries));
  const user = userEvent.setup();
  await user.dblClick(screen.getByRole("button", { name: "Planning" }));
  const field = screen.getByRole("textbox", { name: "Chat name" });
  await waitFor(() => expect(field).not.toHaveAttribute("readonly"));
  await user.clear(field);
  await user.type(field, "Retained draft{Enter}");
  await screen.findByText("Save failed");
  const heading = screen.getByRole("button", { name: "Work" });
  for (const intent of [["work"], [], ["work"], []]) {
    await user.click(heading);
    expect(readView("viewer:community", "solo:collapsed-projects", [])).toEqual(
      intent,
    );
  }
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  expect(
    await screen.findByRole("menuitem", {
      name: "Delete workspace",
    }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(h.remove).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Cancel rename" }));
  expect(heading).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  expect(
    await screen.findByRole("menuitem", {
      name: "Delete workspace",
    }),
  ).not.toHaveAttribute("aria-disabled", "true");
});

it("opens the inline rename editor from the row actions menu", async () => {
  const h = fixture();
  Object.assign(h.details, {
    available: true,
    load: vi.fn(async () => ({
      channelId: "chat",
      name: "Planning",
      description: "",
      visibility: "private",
      labels: ["buzz.solo"],
      canEdit: true,
      version: "one",
    })),
  });
  const owner = h.store();
  render(h.view(owner.queries));
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Actions for Planning" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const field = screen.getByRole("textbox", { name: "Chat name" });
  await waitFor(() => expect(field).not.toHaveAttribute("readonly"));
  expect(field).toHaveFocus();
  expect(field).toHaveValue("Planning");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull();
  expect(screen.getByRole("button", { name: "Planning" })).toHaveFocus();
  owner.dispose();
});

it("prevents rename in a deleting workspace while other workspaces remain editable", async () => {
  const h = fixture();
  Object.assign(h.details, {
    available: true,
    load: vi.fn(async (channelId: string) => ({
      channelId,
      name: channelId === "chat" ? "Planning" : "Existing chat",
      description: "",
      visibility: "private",
      labels: ["buzz.solo"],
      canEdit: true,
      version: "one",
    })),
  });
  const owner = h.store();
  await owner.queries.ensure();
  await owner.queries.assign("chat", "work");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remove = h.remove.getMockImplementation();
  if (!remove) throw new Error("Missing workspace removal fixture");
  h.remove.mockImplementation(async (id) => {
    await pending;
    return remove(id);
  });
  render(h.view(owner.queries));
  const user = userEvent.setup();
  try {
    await user.click(screen.getByRole("button", { name: "Actions for Work" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete workspace" }),
    );
    await waitFor(() =>
      expect(h.remove).toHaveBeenCalledWith("work", expect.any(AbortSignal)),
    );
    await user.dblClick(screen.getByRole("button", { name: "Planning" }));
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull();
    await user.dblClick(screen.getByRole("button", { name: "Existing chat" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Chat name" }),
      ).not.toHaveAttribute("readonly"),
    );
    await user.keyboard("{Escape}");
  } finally {
    release();
  }
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull(),
  );
  await user.dblClick(screen.getByRole("button", { name: "Planning" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
      "Planning",
    ),
  );
  owner.dispose();
});

it("caps each workspace, keeps pinned chats, and remembers Show more", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const total = SOLO_CHAT_CAP + SOLO_CHAT_STEP + 3;
  const chats = Array.from({ length: total }, (_, index) => ({
    id: `c${index}`,
    title: `Chat ${index}`,
    pinned: index === total - 1,
  }));
  const titles = () =>
    screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((text) => /^Chat \d+$/.test(text ?? ""));
  const mounted = render(
    h.view(h.store().queries, undefined, undefined, chats),
  );
  await waitFor(() => expect(titles()).toHaveLength(SOLO_CHAT_CAP + 1));
  // Newest first, with the pinned older chat kept in order after the cap.
  expect(titles()).toEqual([
    ...chats.slice(0, SOLO_CHAT_CAP).map((chat) => chat.title),
    `Chat ${total - 1}`,
  ]);
  await user.click(
    screen.getByRole("button", { name: "Show more chats in Chats" }),
  );
  expect(titles()).toHaveLength(SOLO_CHAT_CAP + SOLO_CHAT_STEP + 1);
  // The last step shows what remains, then only Show less is left.
  await user.click(
    screen.getByRole("button", { name: "Show more chats in Chats" }),
  );
  expect(titles()).toHaveLength(total);
  expect(
    screen.queryByRole("button", { name: "Show more chats in Chats" }),
  ).toBeNull();

  mounted.unmount();
  render(h.view(h.store().queries, undefined, undefined, chats));
  await waitFor(() => expect(titles()).toHaveLength(total));
  await user.click(
    screen.getByRole("button", { name: "Show fewer chats in Chats" }),
  );
  expect(titles()).toHaveLength(SOLO_CHAT_CAP + 1);
});

it("offers Show less beside Show more and always folds back to the cap", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const chats = Array.from(
    { length: SOLO_CHAT_CAP + SOLO_CHAT_STEP * 3 },
    (_, index) => ({
      id: `c${index}`,
      title: `Chat ${index}`,
    }),
  );
  const titles = () =>
    screen
      .getAllByRole("button")
      .filter((button) => /^Chat \d+$/.test(button.textContent ?? ""));
  render(h.view(h.store().queries, undefined, undefined, chats));
  const more = await screen.findByRole("button", {
    name: "Show more chats in Chats",
  });
  expect(
    screen.queryByRole("button", { name: "Show fewer chats in Chats" }),
  ).toBeNull();
  await user.click(more);
  await user.click(
    screen.getByRole("button", { name: "Show more chats in Chats" }),
  );
  expect(titles()).toHaveLength(SOLO_CHAT_CAP + SOLO_CHAT_STEP * 2);
  const row = screen.getByRole("button", {
    name: "Show fewer chats in Chats",
  }).parentElement;
  expect(
    within(row as HTMLElement).getByRole("button", {
      name: "Show more chats in Chats",
    }),
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Show fewer chats in Chats" }),
  );
  expect(titles()).toHaveLength(SOLO_CHAT_CAP);
});

it("offers no Show more when a workspace fits under the cap", async () => {
  const h = fixture();
  render(h.view(h.store().queries));
  await screen.findByRole("button", { name: "Planning" });
  expect(document.querySelector("[data-solo-show-more]")).toBeNull();
});

it("keeps keyboard focus on the row when Show more or Show less is spent", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const chats = Array.from({ length: SOLO_CHAT_CAP + 2 }, (_, index) => ({
    id: `c${index}`,
    title: `Chat ${index}`,
  }));
  render(h.view(h.store().queries, undefined, undefined, chats));
  const more = await screen.findByRole("button", {
    name: "Show more chats in Chats",
  });
  more.focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Show fewer chats in Chats" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Show more chats in Chats" }),
  ).toHaveFocus();
});

it("moves focus to the last chat when Show less leaves nothing to fold", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const chats = (pinned: boolean) =>
    Array.from({ length: SOLO_CHAT_CAP + 1 }, (_, index) => ({
      id: `c${index}`,
      title: `Chat ${index}`,
      pinned: pinned && index === SOLO_CHAT_CAP,
    }));
  const queries = h.store().queries;
  const mounted = render(h.view(queries, undefined, undefined, chats(false)));
  await user.click(
    await screen.findByRole("button", { name: "Show more chats in Chats" }),
  );
  // Opening the last chat pins it, so folding hides nothing.
  mounted.rerender(h.view(queries, undefined, undefined, chats(true)));
  screen.getByRole("button", { name: "Show fewer chats in Chats" }).focus();
  await user.keyboard("{Enter}");
  expect(document.querySelector("[data-solo-show-more]")).toBeNull();
  expect(
    screen.getByRole("button", { name: `Chat ${SOLO_CHAT_CAP}` }),
  ).toHaveFocus();
});

it("keeps a chat listed after it loses its pin until the workspace folds", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const chats = (pinned: boolean) =>
    Array.from({ length: SOLO_CHAT_CAP + 2 }, (_, index) => ({
      id: `c${index}`,
      title: `Chat ${index}`,
      pinned: pinned && index === SOLO_CHAT_CAP,
    }));
  const queries = h.store().queries;
  const mounted = render(h.view(queries, undefined, undefined, chats(true)));
  const kept = await screen.findByRole("button", {
    name: `Chat ${SOLO_CHAT_CAP}`,
  });
  kept.focus();
  // Marking it read drops the pin; the row the user is on stays put.
  mounted.rerender(h.view(queries, undefined, undefined, chats(false)));
  expect(kept).toBeInTheDocument();
  expect(kept).toHaveFocus();
  await user.click(
    screen.getByRole("button", { name: "Show more chats in Chats" }),
  );
  screen.getByRole("button", { name: "Show fewer chats in Chats" }).focus();
  await user.keyboard("{Enter}");
  expect(
    screen.queryByRole("button", { name: `Chat ${SOLO_CHAT_CAP}` }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Show more chats in Chats" }),
  ).toHaveFocus();
});

it("lists and focuses a chat moved into a full workspace", async () => {
  const h = fixture();
  const owner = h.store();
  const user = userEvent.setup();
  const chats = [
    ...Array.from({ length: SOLO_CHAT_CAP }, (_, index) => ({
      id: `c${index}`,
      title: `Chat ${index}`,
    })),
    { id: "chat", title: "Planning" },
  ];
  await owner.queries.ensure();
  for (const chat of chats.slice(0, SOLO_CHAT_CAP))
    await owner.queries.assign(chat.id, "work");
  render(h.view(owner.queries, undefined, undefined, chats));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for Planning" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("button", { name: "Actions for Planning" }),
  );
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  await waitFor(() => expect(h.saved().assignments.chat).toBe("work"));
  const work = projectOf(screen.getByRole("button", { name: "Work" }));
  await waitFor(() =>
    expect(
      within(work).getByRole("button", { name: "Planning" }),
    ).toHaveFocus(),
  );
  owner.dispose();
});

it("keeps a pinned chat past the expanded limit held after a partial fold", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const total = SOLO_CHAT_CAP + SOLO_CHAT_STEP + 3;
  const last = `Chat ${total - 1}`;
  const chats = (pinned: boolean) =>
    Array.from({ length: total }, (_, index) => ({
      id: `c${index}`,
      title: `Chat ${index}`,
      pinned: pinned && index === total - 1,
    }));
  const queries = h.store().queries;
  const mounted = render(h.view(queries, undefined, undefined, chats(true)));
  await user.click(
    await screen.findByRole("button", { name: "Show more chats in Chats" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Show fewer chats in Chats" }),
  );
  const kept = screen.getByRole("button", { name: last });
  kept.focus();
  // The work finishes: the pin drops, but the row the user is on stays.
  mounted.rerender(h.view(queries, undefined, undefined, chats(false)));
  expect(kept).toBeInTheDocument();
  expect(kept).toHaveFocus();
});

it("offers Show less for retained chats in a never-expanded workspace", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const chats = (pinned: boolean) =>
    Array.from({ length: SOLO_CHAT_CAP + 1 }, (_, index) => ({
      id: `c${index}`,
      title: `Chat ${index}`,
      pinned: pinned && index === SOLO_CHAT_CAP,
    }));
  const queries = h.store().queries;
  const mounted = render(h.view(queries, undefined, undefined, chats(true)));
  await screen.findByRole("button", { name: `Chat ${SOLO_CHAT_CAP}` });
  mounted.rerender(h.view(queries, undefined, undefined, chats(false)));
  await user.click(
    screen.getByRole("button", { name: "Show fewer chats in Chats" }),
  );
  expect(
    screen.queryByRole("button", { name: `Chat ${SOLO_CHAT_CAP}` }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Show more chats in Chats" }),
  ).toHaveFocus();
});

it("rejects a late personal move through the same owner used by menu selections and drops", async () => {
  const h = createSoloRegionFixture();
  const write = vi.fn(async () => ({
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { owned: "work" },
    starred: [],
    muted: [],
  }));
  const preferences = createSidebarPreferencesStore({
    read: async () => ({
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: {},
      starred: [],
      muted: [],
    }),
    available: true,
    groupsOnly: true,
    write,
  });
  try {
    await preferences.queries.ensure();
    Object.assign(h.session, { soloPreferences: preferences.queries });
    const channel = h.session.channels
      .list()
      .channels.find((item) => item.id === "owned");
    if (!channel) throw new Error("Missing owned channel");
    h.roster([{ ...channel, labels: ["buzz.solo"] }]);
    render(
      <SoloWorkspaces
        session={h.session}
        scope={h.scope}
        chats={[{ id: "owned", title: "Owned" }]}
        renderChat={(item) => <button type="button">{item.title}</button>}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Owned" }));
    (await screen.findByRole("menuitem", { name: "Move to" })).focus();
    await user.keyboard("{ArrowRight}");
    const target = await screen.findByRole("menuitem", { name: "Work" });
    await act(async () => {
      h.roster([channel]);
      fireEvent.click(target);
    });
    expect(write).not.toHaveBeenCalled();
    expect(
      preferences.queries.snapshot().data?.assignments.owned,
    ).toBeUndefined();
  } finally {
    cleanup();
    preferences.dispose();
    await h.dispose();
  }
});
