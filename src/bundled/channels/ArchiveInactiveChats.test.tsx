// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { inactiveChat } from "./ArchiveInactiveChats";
import { SoloWorkspaces } from "./SoloWorkspaces";

const VIEWER = "a".repeat(64);
const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;
const ids = {
  old: "00000000-0000-4000-8000-000000000001",
  older: "00000000-0000-4000-8000-000000000002",
  recent: "00000000-0000-4000-8000-000000000003",
  working: "00000000-0000-4000-8000-000000000004",
  elsewhere: "00000000-0000-4000-8000-000000000005",
};

// Toast actions sit on Sonner's swipeable card, which captures the pointer.
HTMLElement.prototype.setPointerCapture ??= () => {};

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

function chat(
  id: string,
  name: string,
  daysAgo: number,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name,
    channelType: "solo",
    members: [VIEWER],
    owners: [VIEWER],
    viewerRole: "owner",
    lastActivityAt: NOW - daysAgo * DAY,
    activityKnown: true,
    ...extra,
  };
}

/** A channel list whose activity read the test can finish later. */
function listOf(channels: ChannelSummary[], activityStatus = "ready") {
  const listeners = new Set<() => void>();
  let list = { status: "ready", activityStatus, channels };
  return {
    list: () => list,
    subscribeList: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle(status: string) {
      list = { ...list, activityStatus: status };
      for (const listener of listeners) listener();
    },
  };
}

function sessionWith(
  channels: ChannelSummary[],
  overrides: Partial<Record<keyof RelaySession, unknown>> = {},
  list = listOf(channels),
) {
  const owner = createRelaySession(null);
  owners.push(owner);
  return {
    ...owner.session,
    viewer: VIEWER,
    scope: "viewer:community",
    agentActivity: {
      ...owner.session.agentActivity,
      snapshot: () => ({
        status: "listening",
        turns: [
          { channelId: ids.working, agent: "b".repeat(64), state: "working" },
        ],
        typing: [],
        local: [],
      }),
    },
    channels: {
      ...owner.session.channels,
      list: list.list,
      subscribeList: list.subscribeList,
    },
    ...overrides,
  } as unknown as RelaySession;
}

it("counts a chat as inactive only after 14 quiet days with nothing running", () => {
  const session = sessionWith([]);
  expect(inactiveChat(session, chat(ids.old, "Old", 15), NOW)).toBe(true);
  expect(inactiveChat(session, chat(ids.recent, "Recent", 13), NOW)).toBe(
    false,
  );
  // Without messages, creation stands in; unknown activity proves nothing.
  expect(
    inactiveChat(
      session,
      chat(ids.old, "Empty", 0, {
        lastActivityAt: undefined,
        createdAt: NOW - 20 * DAY,
      }),
      NOW,
    ),
  ).toBe(true);
  const { activityKnown: _known, ...unknown } = chat(ids.old, "Unknown", 30);
  expect(inactiveChat(session, unknown, NOW)).toBe(false);
  expect(inactiveChat(session, chat(ids.working, "Working", 30), NOW)).toBe(
    false,
  );
  expect(
    inactiveChat(
      session,
      chat(ids.old, "Member", 30, { viewerRole: "member" }),
      NOW,
    ),
  ).toBe(false);
  expect(
    inactiveChat(
      session,
      chat(ids.old, "Archived", 30, { archived: true }),
      NOW,
    ),
  ).toBe(false);
});

it("keeps a chat where someone is typing, as an agent on another device does", () => {
  const typing = sessionWith([], {
    typing: {
      snapshot: () => [
        {
          channelId: ids.old,
          threadRootId: "f".repeat(64),
          pubkey: "c".repeat(64),
        },
      ],
      subscribe: () => () => {},
    },
  });
  expect(inactiveChat(typing, chat(ids.old, "Old", 30), NOW)).toBe(false);
});

it("keeps a chat with a queued follow-up or a message still sending", () => {
  const sending = sessionWith([], {
    outbox: {
      snapshot: () => [
        { event: { tags: [["h", ids.old]] }, delivery: "sending" },
      ],
      subscribe: () => () => {},
      ready: () => new Promise(() => {}),
    },
  });
  expect(inactiveChat(sending, chat(ids.old, "Old", 30), NOW)).toBe(false);
});

type Run = (
  action: string,
  id: string,
  signal?: AbortSignal,
  active?: () => boolean,
) => Promise<void>;

/** A Work workspace holding `work` and a Home workspace holding `home`. */
async function mount(
  channels: ChannelSummary[],
  work: readonly string[],
  home: readonly string[],
  run: Run,
  list = listOf(channels),
  demandActivity?: () => () => void,
) {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  const session = sessionWith(
    channels,
    { channelLifecycle: { available: true, run } },
    list,
  );
  if (demandActivity)
    (session.channels as { demandActivity?: () => () => void }).demandActivity =
      demandActivity;
  const saved: SidebarPreferences = {
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "home", name: "Home", order: 1 },
    ],
    assignments: Object.fromEntries([
      ...work.map((id) => [id, "work"]),
      ...home.map((id) => [id, "home"]),
    ]),
    starred: [],
    muted: [],
  };
  const store = createSidebarPreferencesStore({
    read: async () => saved,
    available: true,
    write: async () => saved,
    writeStar: async () => [],
    removeSection: async () => saved,
    writeOrder: async () => saved,
    groupsOnly: true,
  });
  await store.queries.ensure();
  const solo = { ...session, soloPreferences: store.queries } as RelaySession;
  const snapshot = {
    status: "ready",
    scope: "viewer:community",
    viewer: VIEWER,
    generation: 1,
    session: solo,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const tree = (sidebar: boolean) => (
    <ToastProvider>
      <ChannelNavigationProvider relay={relay}>
        {sidebar && (
          <SoloWorkspaces
            session={solo}
            scope="viewer:community"
            chats={channels.map((channel) => ({
              id: channel.id,
              title: channel.name,
            }))}
            renderChat={(item) => <button type="button">{item.title}</button>}
          />
        )}
      </ChannelNavigationProvider>
    </ToastProvider>
  );
  const view = render(tree(true));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Archive inactive chats" }),
  );
  return {
    user,
    store,
    dialog: await screen.findByRole("alertdialog"),
    /** Unmounts the sidebar, as switching the sidebar filter does. */
    hideSidebar: () => view.rerender(tree(false)),
    showSidebar: () => view.rerender(tree(true)),
  };
}

it("confirms the count, archives each inactive chat in the workspace, and undoes it", async () => {
  const run = vi.fn<Run>(async () => {});
  const { user, store, dialog } = await mount(
    [
      chat(ids.old, "Old plan", 15),
      chat(ids.recent, "Recent plan", 2),
      chat(ids.working, "Running plan", 30),
      chat(ids.older, "Older plan", 40),
      chat(ids.elsewhere, "Other workspace", 30),
    ],
    [ids.old, ids.recent, ids.working, ids.older],
    [ids.elsewhere],
    run,
  );
  expect(dialog).toHaveTextContent(
    "2 chats have been inactive for the last 14 days.",
  );
  await user.click(screen.getByRole("button", { name: "Archive 2 chats" }));
  expect(await screen.findByText("Archived 2 chats")).toBeVisible();
  expect(screen.getByRole("button", { name: "Work" })).toHaveFocus();
  expect(run.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["archive", ids.old],
    ["archive", ids.older],
  ]);
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Restored 2 chats")).toBeVisible();
  expect(run.mock.calls.slice(2).map((call) => call.slice(0, 2))).toEqual([
    ["unarchive", ids.old],
    ["unarchive", ids.older],
  ]);
  store.dispose();
});

it("skips a chat that becomes active before its archive publishes", async () => {
  const channels = [
    chat(ids.old, "Old plan", 15),
    chat(ids.older, "Older plan", 40),
  ];
  const run = vi.fn<Run>(async (_action, id, _signal, active) => {
    // A message arrives while this chat's archive is being prepared.
    if (id === ids.older) channels[1] = chat(ids.older, "Older plan", 0);
    if (active?.() === false)
      throw new DOMException("Channel action cancelled", "AbortError");
  });
  const { user, store } = await mount(channels, [ids.old, ids.older], [], run);
  await user.click(screen.getByRole("button", { name: "Archive 2 chats" }));
  expect(await screen.findByText("Archived 1 chat")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Restored 1 chat")).toBeVisible();
  expect(run.mock.calls.at(-1)?.slice(0, 2)).toEqual(["unarchive", ids.old]);
  store.dispose();
});

it("says so when nothing in the workspace is inactive", async () => {
  const run = vi.fn<Run>(async () => {});
  const { user, store, dialog } = await mount(
    [chat(ids.recent, "Recent plan", 2)],
    [ids.recent],
    [],
    run,
  );
  expect(dialog).toHaveTextContent(
    "No chats have been inactive for the last 14 days.",
  );
  await user.click(
    within(dialog)
      .getAllByRole("button", { name: "Close" })
      .at(-1) as HTMLElement,
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(run).not.toHaveBeenCalled();
  store.dispose();
});

it("finishes a run and offers Undo after the sidebar remounts", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn<Run>(async (action, id) => {
    if (action === "archive" && id === ids.old) await held;
  });
  const { user, store, hideSidebar, showSidebar } = await mount(
    [chat(ids.old, "Old plan", 15), chat(ids.older, "Older plan", 40)],
    [ids.old, ids.older],
    [],
    run,
  );
  await user.click(screen.getByRole("button", { name: "Archive 2 chats" }));
  await screen.findByText("Archiving inactive chats…");
  hideSidebar();
  release();
  expect(await screen.findByText("Archived 2 chats")).toBeVisible();
  showSidebar();
  // The removed sidebar took focus with it; start from its heading again.
  screen.getByRole("button", { name: "Work" }).focus();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Restored 2 chats")).toBeVisible();
  expect(run.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["archive", ids.old],
    ["archive", ids.older],
    ["unarchive", ids.old],
    ["unarchive", ids.older],
  ]);
  store.dispose();
});

it("waits for chat activity to load before counting, and says so when it can't", async () => {
  const release = vi.fn();
  const demand = vi.fn(() => release);
  const channels = [chat(ids.old, "Old plan", 15)];
  const list = listOf(channels, "loading");
  const run = vi.fn<Run>(async () => {});
  const { user, store, dialog } = await mount(
    channels,
    [ids.old],
    [],
    run,
    list,
    demand,
  );
  expect(demand).toHaveBeenCalledOnce();
  expect(dialog).toHaveTextContent("Checking which chats are inactive…");
  // The confirm button holds its place, disabled, until the count arrives.
  expect(screen.getByRole("button", { name: "Archive chats" })).toBeDisabled();
  act(() => list.settle("error"));
  expect(dialog).toHaveTextContent("Couldn’t check which chats are inactive.");
  expect(
    within(dialog).getAllByRole("button", { name: "Close" }),
  ).not.toHaveLength(0);
  // Try again asks for activity again.
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(demand).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledOnce();
  act(() => list.settle("ready"));
  expect(dialog).toHaveTextContent(
    "1 chat has been inactive for the last 14 days.",
  );
  await user.click(screen.getByRole("button", { name: "Archive 1 chat" }));
  expect(await screen.findByText("Archived 1 chat")).toBeVisible();
  expect(release).toHaveBeenCalledTimes(2);
  store.dispose();
});

it("reports a cancelled archive as a failure, not as a chat that became active", async () => {
  const run = vi.fn<Run>(async (_action, id) => {
    if (id === ids.older)
      throw new DOMException("Channel action cancelled", "AbortError");
  });
  const { user, store } = await mount(
    [chat(ids.old, "Old plan", 15), chat(ids.older, "Older plan", 40)],
    [ids.old, ids.older],
    [],
    run,
  );
  await user.click(screen.getByRole("button", { name: "Archive 2 chats" }));
  expect(
    await screen.findByText(
      "Archived 1 chat. Couldn’t archive 1. Channel action cancelled",
    ),
  ).toBeVisible();
  store.dispose();
});
