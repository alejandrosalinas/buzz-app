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
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createNavigationController,
  type Navigation,
} from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import type { PageNavigation } from "../../features/navigation/service";
import { Context } from "@deepseek-ai/cordis";
import { PanelsService } from "../../features/panels/service";
import { notesRoute } from "./routes";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentChoicesSnapshot } from "../../features/agents/choices";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { EventData, ReadFilter } from "../../features/relay/events";
import type { ReadOptions } from "../../features/relay/reader";
import { NotesCommunity, NotesPage } from "./NotesPage";
import { noteHeads } from "./collection";

const carl = "c".repeat(64),
  ned = "d".repeat(64),
  other = "e".repeat(64);
const note = (title: string, pubkey = carl, created_at = 10): EventData => ({
  id: `${created_at}${pubkey}`.slice(0, 64),
  kind: 30023,
  pubkey,
  created_at,
  tags: [
    ["d", title.toLowerCase()],
    ["title", title],
  ],
  content: `## ${title} content\n\n**Reusable recipe**`,
});
function fixture(events = [note("Icons"), note("Guide", ned)]) {
  const choices = {
    status: "ready",
    pending: false,
    complete: true,
    definitions: [],
    identities: [
      { pubkey: carl, name: "Carl" },
      { pubkey: ned, name: "Ned" },
    ],
    selectable: [{ pubkey: carl, name: "Carl" }],
  } as unknown as AgentChoicesSnapshot;
  const readPage = vi.fn(
    async (_filters: readonly ReadFilter[], _options?: ReadOptions) => ({
      events,
      relayCount: events.length,
    }),
  );
  const profileMap = new Map();
  const session = {
    profiles: {
      snapshot: () => profileMap,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      refresh: vi.fn(async () => {}),
    },
    readPage,
  } as unknown as RelaySession;
  return { session, readPage };
}
async function enterFolder(name = "Carl") {
  await userEvent.click(
    await screen.findByRole("button", { name: `Open ${name} folder` }),
  );
}

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
});

it("opens shared-note guidance from the header and returns focus on dismissal", async () => {
  const f = fixture();
  render(<NotesCommunity session={f.session} />);
  const info = screen.getByRole("button", { name: "About shared notes" });
  expect(
    screen.queryByText(/Shared notes are reusable documents/),
  ).not.toBeInTheDocument();
  await userEvent.click(info);
  const popup = await screen.findByRole("dialog", {
    name: "About shared notes",
  });
  expect(popup).toHaveTextContent(
    "Ask the agent who saved a note to update it",
  );
  expect(popup).toHaveTextContent(
    "Don’t include secrets or private information.",
  );
  expect(popup).toHaveAccessibleDescription(
    /Shared notes are reusable documents.*Don’t include secrets or private information\./,
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "About shared notes" }),
    ).not.toBeInTheDocument(),
  );
  expect(info).toHaveFocus();
});

it("selects replacement heads per author and identifier with the NIP-01 tie break", () => {
  const older = note("Icons", carl, 10);
  const newest = { ...note("Icons", carl, 11), id: "a".repeat(64) };
  const tie = { ...newest, id: "b".repeat(64) };
  const sibling = note("Icons", ned);
  expect(
    noteHeads(
      [
        older,
        tie,
        newest,
        sibling,
        note("Other", other),
        { ...older, kind: 1 },
      ],
      [carl, ned],
    ),
  ).toEqual([newest, sibling]);
});

it("still checks shared notes when the owned-agent inventory is empty", async () => {
  const f = fixture();
  const empty = { ...f.session.agentChoices.snapshot(), identities: [] };
  const session = {
    ...f.session,
    agentChoices: { ...f.session.agentChoices, snapshot: () => empty },
  };
  render(<NotesCommunity session={session} />);
  expect(await screen.findByText("No notes yet")).toBeVisible();
  expect(f.readPage).toHaveBeenCalledExactlyOnceWith(
    [{ kinds: [30023], limit: 100 }],
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it("groups other agents below owned agents and excludes human-authored notes", async () => {
  const human = "f".repeat(64);
  const f = fixture([
    note("Icons"),
    note("Shared", other),
    note("Personal", human),
  ]);
  const profiles = new Map([
    [other, { name: "Other agent", isAgent: true as const }],
    [human, { name: "Human" }],
  ]);
  const ensure = vi.fn(async () => {});
  const session = {
    ...f.session,
    profiles: { snapshot: () => profiles, subscribe: () => () => {}, ensure },
  };
  render(<NotesCommunity session={session} />);
  const otherFolder = await screen.findByRole("button", {
    name: "Open Other agent folder",
  });
  expect(
    within(screen.getByRole("region", { name: "Your agents" })).getByRole(
      "button",
      { name: "Open Carl folder" },
    ),
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Other agents" })).getByRole(
      "button",
      { name: "Open Other agent folder" },
    ),
  ).toBe(otherFolder);
  expect(
    screen.queryByRole("button", { name: "Open Human folder" }),
  ).not.toBeInTheDocument();
  expect(within(otherFolder).getByText("1 shared note")).toBeVisible();
  await userEvent.click(otherFolder);
  await userEvent.click(
    screen.getByRole("button", { name: "Open Shared by Other agent" }),
  );
  expect(screen.getByRole("tab", { name: "Shared" })).toBeVisible();
  expect(ensure).toHaveBeenCalledWith(
    expect.arrayContaining([other, human]),
    "background",
  );
});

it.each(["relay", "profile"])(
  "retains owned notes when shared %s discovery fails",
  async (failure) => {
    const f = fixture([note("Icons")]);
    const profiles = new Map();
    if (failure === "relay")
      f.readPage.mockImplementation(async (filters) => {
        if (!filters[0]?.authors) throw new Error("offline");
        return { events: [note("Icons")], relayCount: 1 };
      });
    const session = {
      ...f.session,
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: async () => {
          if (failure === "profile") throw new Error("offline");
        },
      },
    };
    render(<NotesCommunity session={session} />);
    await enterFolder();
    expect(
      screen.getByRole("button", { name: "Open Icons by Carl" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Other agents’ notes could not be checked. Refresh to try again.",
      ),
    ).toBeVisible();
  },
);

it("scopes reads to all owned identities, including archived ones, and opens independent closable tabs", async () => {
  const user = userEvent.setup();
  const f = fixture([note("Icons"), note("Guide"), note("Archive", ned)]);
  render(<NotesCommunity session={f.session} />);
  await enterFolder();
  const icons = await screen.findByRole("button", {
    name: /Open Icons by Carl/,
  });
  expect(f.readPage.mock.calls[0]).toMatchObject([
    [{ kinds: [30023], authors: [carl, ned], limit: 100 }],
    { signal: expect.any(AbortSignal) },
  ]);
  await user.click(icons);
  expect(screen.getByRole("heading", { name: "Icons content" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: /Open Guide by Carl/ }));
  expect(screen.getByRole("tab", { name: "Icons" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Guide" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "Icons" }));
  expect(screen.getByRole("heading", { name: "Icons content" })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("tab", { name: "Icons" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("tab", { name: "Icons" })).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Guide" })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("tab", { name: "Guide" }), {
    key: "Escape",
  });
  await waitFor(() =>
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Open Guide by Carl/ }),
    ).toHaveFocus(),
  );
});

it.each(["icons", "", "two\nlines"])(
  "records folder visits with opaque identifier %j without file history steps",
  async (identifier) => {
    const user = userEvent.setup();
    const iconsNote = note("Icons");
    const f = fixture([
      {
        ...iconsNote,
        tags: iconsNote.tags.map((tag) =>
          tag[0] === "d" ? ["d", identifier] : tag,
        ),
      },
      note("Guide"),
      note("Archive", ned),
    ]);
    const controller = createNavigationController(
      createMemoryHistory({
        version: 1,
        kind: "page",
        pluginId: "buzz.relay-notes",
        pageId: "notes",
      }),
    );
    const navigator = controller.navigation;
    function Host() {
      const snapshot = useSyncExternalStore(
        navigator.subscribe,
        navigator.snapshot,
      );
      const navigation = useMemo(() => {
        const request: PageNavigation = {
          entryId: snapshot.entry.id,
          target: snapshot.entry.target,
          signal: snapshot.attempt.signal,
          position: () => undefined,
          savePosition() {},
          forSession: () => request,
          passThrough: () => () => {},
          resolve: () => false,
          complete: (result) => controller.complete(snapshot.attempt, result),
        };
        return request;
      }, [snapshot.attempt, snapshot.entry]);
      useEffect(() => {
        navigation.complete({ status: "opened" });
      }, [navigation]);
      return (
        <NotesCommunity
          session={f.session}
          navigation={navigation}
          navigator={navigator}
        />
      );
    }
    const view = render(<Host />);
    try {
      await enterFolder();
      await user.click(
        screen.getByRole("button", { name: "Open Icons by Carl" }),
      );
      const target = navigator.snapshot().entry.target;
      expect(target.kind).toBe("page");
      if (target.kind === "page")
        expect(notesRoute(target.route?.params)).toMatchObject({
          author: carl,
          note: `30023:${carl}:${identifier}`,
        });
      await user.click(
        screen.getByRole("button", { name: "Open Guide by Carl" }),
      );
      expect(screen.getByRole("tab", { name: "Guide" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      act(() => navigator.back());
      expect(
        await screen.findByRole("button", { name: "Open Carl folder" }),
      ).toBeVisible();
      expect(screen.getByRole("tab", { name: "Guide" })).toBeVisible();
      expect(navigator.snapshot().canGoBack).toBe(false);
      expect(navigator.snapshot().canGoForward).toBe(true);
      act(() => navigator.forward());
      expect(
        await screen.findByRole("button", { name: "Open Icons by Carl" }),
      ).toBeVisible();
      expect(screen.getByRole("tab", { name: "Guide" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await user.click(screen.getByRole("button", { name: "Back to folders" }));
      expect(screen.getByRole("tab", { name: "Icons" })).toBeVisible();
      await enterFolder("Ned");
      act(() => navigator.back());
      expect(
        await screen.findByRole("button", { name: "Open Carl folder" }),
      ).toBeVisible();
      act(() => navigator.forward());
      expect(
        await screen.findByRole("button", { name: "Open Archive by Ned" }),
      ).toBeVisible();
      expect(f.readPage).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      controller.dispose();
    }
  },
);

it("opens the registered author profile beside notes and retires it with its plugin", async () => {
  const user = userEvent.setup();
  const f = fixture([note("Icons")]);
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const panels = new PanelsService(ctx);
  const scope = ctx
    .extend({ pluginOwner: { id: "test.profile", revision: "1" } })
    .plugin((owner) => {
      owner.panels.register({
        id: "profile",
        title: "Profile",
        matches: (target) => target === `buzz:agent-profile:${carl}`,
        component: ({ target }) => <p>Profile for {target}</p>,
      });
    });
  await scope;
  const view = render(<NotesCommunity session={f.session} panels={panels} />);
  try {
    await enterFolder();
    await user.click(
      screen.getByRole("button", { name: "Open Icons by Carl" }),
    );
    await user.click(
      within(screen.getByRole("complementary")).getByRole("button", {
        name: "View Carl profile",
      }),
    );
    expect(screen.getByRole("tab", { name: "Icons" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Carl · Profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByText(`Profile for buzz:agent-profile:${carl}`),
    ).toBeVisible();
    await act(async () => {
      await scope.dispose();
    });
    expect(
      screen.queryByRole("tab", { name: "Carl · Profile" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Icons" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    view.unmount();
    await ctx.fiber.dispose();
  }
});

it("validates route shapes without turning locators into author scope", () => {
  expect(
    notesRoute({ author: carl, note: `30023:${carl}:icons` }),
  ).toBeDefined();
  for (const route of [
    { author: "bad" },
    { author: carl, note: "bad" },
    { author: carl, extra: true },
    [],
  ])
    expect(notesRoute(route)).toBeUndefined();
});

it("toggles existing note tabs from cards without closing other notes", async () => {
  const user = userEvent.setup();
  const f = fixture([note("Icons"), note("Guide")]);
  render(<NotesCommunity session={f.session} />);
  await enterFolder();
  const icons = screen.getByRole("button", { name: "Open Icons by Carl" });
  const guide = screen.getByRole("button", { name: "Open Guide by Carl" });
  await user.click(icons);
  await user.click(guide);
  expect(icons).toHaveAttribute("aria-pressed", "true");
  // Clicking an already-open card closes its tab even when another tab is active.
  await user.click(icons);
  expect(screen.queryByRole("tab", { name: "Icons" })).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Guide" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(icons).toHaveAttribute("aria-pressed", "false");
  await user.click(icons);
  expect(screen.getByRole("tab", { name: "Icons" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(icons);
  expect(screen.getByRole("tab", { name: "Guide" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(guide);
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  await waitFor(() => expect(guide).toHaveFocus());
  await user.keyboard("{Enter}");
  expect(screen.getByRole("tab", { name: "Guide" })).toBeVisible();
  guide.focus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

it("shows owned notes on the index, filters by agent, and retains reader tabs across folders", async () => {
  const user = userEvent.setup();
  const f = fixture([note("Icons"), note("Guide"), note("Archive", ned)]);
  render(<NotesCommunity session={f.session} />);
  const carlFolder = await screen.findByRole("button", {
    name: "Open Carl folder",
  });
  expect(within(carlFolder).getByText("2 shared notes")).toBeVisible();
  expect(
    within(screen.getByRole("button", { name: "Open Ned folder" })).getByText(
      "1 shared note",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Open Icons by Carl/ }),
  ).toBeVisible();
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  await user.click(carlFolder);
  expect(screen.getByRole("heading", { name: "Carl" })).toBeVisible();
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Open Archive by Ned/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Open Icons by Carl/ }));
  expect(screen.getByRole("tab", { name: "Icons" })).toBeVisible();
  expect(
    screen
      .getByRole("tab", { name: "Icons" })
      .querySelector('[data-avatar-shape="squircle"]'),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to folders" }));
  expect(screen.getByRole("tab", { name: "Icons" })).toBeVisible();
  const restored = screen.getByRole("button", { name: "Open Carl folder" });
  await waitFor(() => expect(restored).toHaveFocus());
  await enterFolder("Ned");
  expect(
    screen.getByRole("button", { name: /Open Archive by Ned/ }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Icons" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: /Open Archive by Ned/ }));
  expect(screen.getByRole("tab", { name: "Icons" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Archive" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("shows only agents with loaded notes and returns to folders when the open folder disappears", async () => {
  const user = userEvent.setup();
  const f = fixture([note("Icons")]);
  render(<NotesCommunity session={f.session} />);
  await screen.findByRole("button", { name: "Open Carl folder" });
  expect(
    screen.queryByRole("button", { name: "Open Ned folder" }),
  ).not.toBeInTheDocument();
  await enterFolder();
  f.readPage.mockResolvedValueOnce({
    events: [note("Guide", ned)],
    relayCount: 1,
  });
  await user.click(screen.getByRole("button", { name: "Refresh notes" }));
  expect(
    await screen.findByRole("button", { name: "Open Ned folder" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Open Carl folder" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Back to folders" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

it("keeps loading distinct from empty, retries failures and updates open note revisions on refresh", async () => {
  const user = userEvent.setup();
  const f = fixture();
  let resolve!: (value: { events: EventData[]; relayCount: number }) => void;
  f.readPage.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<NotesCommunity session={f.session} />);
  expect(screen.getByRole("status")).toHaveTextContent("Reading notes");
  expect(screen.getByRole("status").closest("header")).toContainElement(
    screen.getByRole("button", { name: "Refresh notes" }),
  );
  expect(screen.queryByText("No notes yet")).not.toBeInTheDocument();
  await act(async () => resolve({ events: [note("Icons")], relayCount: 100 }));
  expect(
    screen.getByRole("button", { name: "Load older notes" }),
  ).toBeVisible();
  expect(
    within(screen.getByRole("button", { name: "Open Carl folder" })).getByText(
      "1 shared note",
    ),
  ).toBeVisible();
  await enterFolder();
  await user.click(screen.getByRole("button", { name: /Open Icons by Carl/ }));
  f.readPage.mockRejectedValueOnce(new Error("offline"));
  await user.click(screen.getByRole("button", { name: "Refresh notes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t read notes",
  );
  expect(screen.getByRole("tab", { name: "Icons" })).toBeVisible();
  f.readPage.mockResolvedValueOnce({
    events: [{ ...note("Icons", carl, 12), content: "Updated recipe" }],
    relayCount: 1,
  });
  await user.click(screen.getByRole("button", { name: "Retry notes" }));
  expect(
    await within(screen.getByRole("tabpanel")).findByText("Updated recipe"),
  ).toBeVisible();
  expect(
    within(
      screen.getByRole("button", { name: "Open Icons by Carl" }),
    ).getByText("Updated recipe"),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(f.readPage.mock.calls.at(-1)?.[1]).toMatchObject({ fresh: true });
});

it("cancels retired community reads and never displays their late result", async () => {
  const f = fixture();
  let resolve!: (value: { events: EventData[]; relayCount: number }) => void;
  f.readPage.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let connection = {
    status: "ready",
    generation: 1,
    scope: "first",
    session: f.session,
  } as RelaySnapshot;
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => connection,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry: vi.fn(),
    tryAgain: vi.fn(),
    disconnect: vi.fn(),
    clearCache: vi.fn(async () => {}),
  } as RelayData;
  render(<NotesPage relay={relay} />);
  const signal = f.readPage.mock.calls[0]?.[1]?.signal;
  act(() => {
    connection = { ...connection, status: "disconnected" };
    for (const listener of listeners) listener();
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve({ events: [note("Stale")], relayCount: 1 }));
  expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Connect to a community",
  );
});

it("renders note content as Markdown without executable HTML or unsafe links", async () => {
  const user = userEvent.setup();
  const f = fixture([
    {
      ...note("Safety"),
      content:
        "**Safe**\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert%281%29)\n\n[Good](https://example.com)\n\n![Tracking image](https://tracker.example/p.gif?n=1)\n\n[Relative](/settings)\n\n[Email](mailto:reader@example.com)",
    },
  ]);
  render(<NotesCommunity session={f.session} />);
  await enterFolder();
  await user.click(
    await screen.findByRole("button", { name: /Open Safety by Carl/ }),
  );
  const reader = screen.getByRole("complementary");
  expect(reader.querySelector("strong")).toHaveTextContent("Safe");
  expect(reader.querySelector("script")).toBeNull();
  expect(reader.querySelector("img")).toBeNull();
  expect(
    document.querySelector(
      'link[rel="preload"][as="image"][href^="https://tracker.example"]',
    ),
  ).toBeNull();
  expect(within(reader).getByText("Tracking image")).toBeVisible();
  expect(within(reader).getByText("Relative")).not.toHaveAttribute("href");
  expect(within(reader).getByText("Email")).not.toHaveAttribute("href");

  expect(within(reader).getByText("Bad")).not.toHaveAttribute(
    "href",
    expect.stringMatching(/^javascript:/),
  );
  expect(within(reader).getByRole("link", { name: "Good" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
});

/** A full session whose channel links name a joined #Release. */
function withReleaseChannel(session: RelaySession) {
  const channels = { status: "ready", channels: [] };
  return {
    ...session,
    unread: undefined,
    channels: {
      list: () => channels,
      get: () => undefined,
      describe: () => ({
        state: "found",
        name: "Release",
        channelType: "stream",
        private: false,
        hidden: false,
        archived: false,
        joined: true,
      }),
      refer: () => () => {},
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
}

it("opens Buzz message and channel links in the app, naming a raw channel link", async () => {
  const user = userEvent.setup();
  const root = "a".repeat(64);
  const f = fixture([
    {
      ...note("Blockers"),
      content: `Summarised from [the blockers thread](buzz://message?channel=release&id=${root}) in <buzz://channel/release>.`,
    },
  ]);
  const session = withReleaseChannel(f.session);
  const open = vi.fn(async () => {});
  const connection = {
    status: "ready",
    generation: 1,
    scope: `https://relay.example:${other}`,
    viewer: other,
    session,
  } as RelaySnapshot;
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
    retry: vi.fn(),
    tryAgain: vi.fn(),
    disconnect: vi.fn(),
    clearCache: vi.fn(async () => {}),
  } as RelayData;
  render(
    <NotesPage relay={relay} navigator={{ open } as unknown as Navigation} />,
  );
  await enterFolder();
  await user.click(
    screen.getByRole("button", { name: "Open Blockers by Carl" }),
  );
  const reader = screen.getByRole("complementary");
  const message = within(reader).getByRole("link", {
    name: "the blockers thread",
  });
  await user.hover(message);
  expect(await screen.findByLabelText("Message preview")).toBeInTheDocument();
  const scope = { viewer: other, communityOrigin: "https://relay.example" };
  await user.click(message);
  expect(open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "release",
    messageId: root,
  });
  await user.click(within(reader).getByRole("link", { name: "#Release" }));
  expect(open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "release",
  });
  expect(open).toHaveBeenCalledTimes(2);
});

it("keeps a formatted label on a Buzz channel link", async () => {
  const user = userEvent.setup();
  const f = fixture([
    {
      ...note("Launch"),
      content: "Meet in [the **release** room](buzz://channel/release).",
    },
  ]);
  render(<NotesCommunity session={withReleaseChannel(f.session)} />);
  await enterFolder();
  await user.click(screen.getByRole("button", { name: "Open Launch by Carl" }));
  const link = within(screen.getByRole("complementary")).getByRole("link", {
    name: "the release room",
  });
  expect(link).toHaveTextContent("the release room");
  expect(link.querySelector("strong")).toHaveTextContent("release");
});

it("explains that a Buzz link can't be opened without a scope or navigator", async () => {
  const user = userEvent.setup();
  const f = fixture([
    {
      ...note("Launch"),
      content: "Meet in [the release room](buzz://channel/release).",
    },
  ]);
  render(<NotesCommunity session={f.session} />);
  await enterFolder();
  await user.click(screen.getByRole("button", { name: "Open Launch by Carl" }));
  const reader = screen.getByRole("complementary");
  expect(
    within(reader).queryByText("This Buzz link couldn’t be opened here."),
  ).not.toBeInTheDocument();
  await user.click(
    within(reader).getByRole("link", { name: "the release room" }),
  );
  expect(
    within(reader).getByText("This Buzz link couldn’t be opened here."),
  ).toBeInTheDocument();
});

it("shows the saved identifier separately from the display title in row and reader metadata", async () => {
  const f = fixture([
    {
      ...note("Recipe title"),
      tags: [
        ["d", "saved-recipe-name"],
        ["title", "Recipe title"],
      ],
    },
  ]);
  render(<NotesCommunity session={f.session} />);
  await enterFolder();
  const row = await screen.findByRole("button", {
    name: /Open Recipe title by Carl/,
  });
  expect(within(row).getByText("saved-recipe-name")).toHaveAttribute(
    "title",
    "Saved as saved-recipe-name",
  );
  await userEvent.click(row);
  expect(
    within(screen.getByRole("complementary")).getByText("saved-recipe-name"),
  ).toBeVisible();
});

it.each([
  [120, "2 minutes ago"],
  [30 * 86400, "30 days ago"],
] as const)(
  "shows author avatars and relative timestamps with precise native titles (%s seconds old)",
  async (age, label) => {
    const timestamp = Math.floor(Date.now() / 1000) - age;
    const f = fixture([note("Recent", carl, timestamp)]);
    render(<NotesCommunity session={f.session} />);
    await enterFolder();
    const row = await screen.findByRole("button", {
      name: /Open Recent by Carl/,
    });
    expect(
      screen
        .getByRole("article")
        .querySelector('[data-avatar-shape="squircle"]'),
    ).toBeInTheDocument();
    expect(row.querySelector('[data-avatar-shape="squircle"]')).toBeNull();
    const time = within(screen.getByRole("article")).getByText(label);
    expect(time).toHaveAttribute(
      "datetime",
      new Date(timestamp * 1000).toISOString(),
    );
    expect(time).toHaveAttribute(
      "title",
      new Date(timestamp * 1000).toLocaleString(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      }),
    );
    await userEvent.click(row);
    expect(
      within(screen.getByRole("complementary")).getByText(label),
    ).toHaveAttribute("title", time.title);
  },
);

it("loads older pages independently, keeps heads and open tabs, and refreshes from the start", async () => {
  const f = fixture();
  const recent = { ...note("Recent", carl, 20), id: "a".repeat(64) };
  const older = { ...note("Older", carl, 20), id: "b".repeat(64) };
  const oldest = note("Oldest", ned, 5);
  const choices = f.session.agentChoices.snapshot();
  const reversed = {
    ...choices,
    identities: [...choices.identities].reverse(),
  };
  vi.spyOn(f.session.agentChoices, "snapshot").mockReturnValue(reversed);
  let release!: (page: { events: EventData[]; relayCount: number }) => void;
  f.readPage.mockImplementation(async ([filter]) => {
    if (!filter?.authors) return { events: [], relayCount: 0 };
    if (filter.before_id === recent.id)
      return new Promise((done) => {
        release = done;
      });
    if (filter.before_id === older.id)
      return { events: [oldest, note("Recent", carl, 4)], relayCount: 2 };
    return { events: [recent], relayCount: 100 };
  });
  render(<NotesCommunity session={f.session} />);
  await enterFolder();
  await userEvent.click(
    screen.getByRole("button", { name: "Open Recent by Carl" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Load older notes" }),
  );
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(
    screen.getByRole("button", { name: "Load older notes" }),
  ).toHaveAttribute("aria-busy", "true");
  await act(async () => release({ events: [older], relayCount: 100 }));
  expect(
    screen.getByRole("button", { name: "Open Older by Carl" }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Recent" })).toBeVisible();
  expect(
    screen
      .getAllByRole("button", { name: /^Open .* by Carl$/ })
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Open Recent by Carl", "Open Older by Carl"]);
  await userEvent.click(
    screen.getByRole("button", { name: "Load older notes" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Load older notes" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    f.readPage.mock.calls.filter(([filters]) => !filters[0]?.authors),
  ).toHaveLength(1);
  expect(f.readPage.mock.calls[2]?.[0][0]).toMatchObject({
    until: 20,
    before_id: recent.id,
  });
  expect(
    within(screen.getByRole("tabpanel")).getByText("Recent content"),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Back to folders" }),
  );
  expect(
    within(screen.getByRole("region", { name: "Your agents" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Open Carl folder", "Open Ned folder"]);
  f.readPage.mockResolvedValue({ events: [note("Fresh")], relayCount: 1 });
  await userEvent.click(screen.getByRole("button", { name: "Refresh notes" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Open Ned folder" }),
    ).not.toBeInTheDocument(),
  );
  expect(f.readPage.mock.calls.at(-2)?.[0][0]).not.toHaveProperty("until");
  expect(screen.getByRole("tab", { name: "Recent" })).toBeVisible();
});

it("retains pages on a failed or stalled continuation and retries the same cursor", async () => {
  const f = fixture();
  const first = note("First");
  let attempt = 0;
  f.readPage.mockImplementation(async ([filter]) => {
    if (!filter?.authors) return { events: [], relayCount: 0 };
    if (!filter.before_id) return { events: [first], relayCount: 100 };
    attempt++;
    if (attempt === 1) throw new Error("offline");
    if (attempt === 2) return { events: [first], relayCount: 100 };
    return { events: [note("Older", carl, 1)], relayCount: 1 };
  });
  render(<NotesCommunity session={f.session} />);
  await enterFolder();
  for (let i = 0; i < 2; i++) {
    await userEvent.click(
      screen.getByRole("button", {
        name: i === 0 ? "Load older notes" : "Retry notes",
      }),
    );
    await screen.findByRole("alert");
    expect(
      screen.getByRole("button", { name: "Open First by Carl" }),
    ).toBeVisible();
  }
  await userEvent.click(screen.getByRole("button", { name: "Retry notes" }));
  await screen.findByRole("button", { name: "Open Older by Carl" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    f.readPage.mock.calls.slice(2).map(([filters]) => filters[0]?.before_id),
  ).toEqual([first.id, first.id, first.id]);
});

it("continues shared discovery past human-only pages and ignores a late page after refresh", async () => {
  const f = fixture();
  const human = note("Human", "f".repeat(64), 15);
  const shared = note("Shared", other, 2);
  (f.session.profiles.snapshot() as Map<string, unknown>).set(other, {
    name: "Other",
    isAgent: true,
  });
  let release!: (page: { events: EventData[]; relayCount: number }) => void;
  f.readPage.mockImplementation(async ([filter]) => {
    if (filter?.authors) return { events: [note("Icons")], relayCount: 1 };
    if (filter?.before_id)
      return new Promise((done) => {
        release = done;
      });
    return { events: [human], relayCount: 100 };
  });
  render(<NotesCommunity session={f.session} />);
  await screen.findByRole("button", { name: "Open Carl folder" });
  await userEvent.click(
    screen.getByRole("button", { name: "Load older notes" }),
  );
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => release({ events: [shared], relayCount: 100 }));
  await screen.findByRole("button", { name: "Open Other folder" });
  expect(
    screen.queryByRole("button", { name: "Open Human folder" }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Load older notes" }),
  );
  await waitFor(() => expect(f.readPage).toHaveBeenCalledTimes(4));
  const late = release;
  const signal = f.readPage.mock.calls.at(-1)?.[1]?.signal;
  f.readPage.mockResolvedValue({ events: [note("Fresh")], relayCount: 1 });
  // Refresh can supersede an in-flight continuation; its abort fence owns the result.
  fireEvent.click(screen.getByRole("button", { name: "Refresh notes" }));
  await waitFor(() => expect(signal?.aborted).toBe(true));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Open Other folder" }),
    ).not.toBeInTheDocument(),
  );
  await act(async () => late({ events: [shared], relayCount: 1 }));
  expect(
    screen.queryByRole("button", { name: "Open Other folder" }),
  ).not.toBeInTheDocument();
});

it("orders other-agent folders by their newest loaded note, with alphabetical ties", async () => {
  const beta = "b".repeat(64),
    zed = "a".repeat(64);
  const events = [
    note("Old", zed, 1),
    note("Alpha", other, 20),
    note("Zed", zed, 30),
    note("Beta", beta, 20),
    note("Carl", carl, 2),
    note("Ned", ned, 50),
  ];
  const f = fixture(events);
  const profiles = new Map([
    [other, { name: "Alpha", isAgent: true as const }],
    [beta, { name: "Beta", isAgent: true as const }],
    [zed, { name: "Zed", isAgent: true as const }],
  ]);
  const session = {
    ...f.session,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
  };
  render(<NotesCommunity session={session} />);
  await screen.findByRole("button", { name: "Open Zed folder" });
  const order = (group: string) =>
    within(screen.getByRole("region", { name: group }))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
  expect(order("Other agents")).toEqual([
    "Open Zed folder",
    "Open Alpha folder",
    "Open Beta folder",
  ]);
  expect(order("Your agents")).toEqual(["Open Carl folder", "Open Ned folder"]);
  f.readPage.mockResolvedValue({
    events: [...events, note("Alpha", other, 40)],
    relayCount: 7,
  });
  await userEvent.click(screen.getByRole("button", { name: "Refresh notes" }));
  await waitFor(() =>
    expect(order("Other agents")).toEqual([
      "Open Alpha folder",
      "Open Zed folder",
      "Open Beta folder",
    ]),
  );
});

it("shows only owned notes in the index grid and retains a note while filtering by agent", async () => {
  const user = userEvent.setup();
  const now = Math.floor(Date.now() / 1000);
  const f = fixture([
    note("Latest", carl, now),
    note("Second", ned, now - 60),
    note("Community", other, now - 120),
    note("Old", carl, now - 40 * 86400),
  ]);
  (f.session.profiles.snapshot() as Map<string, unknown>).set(other, {
    name: "Visitor",
    isAgent: true,
  });
  render(<NotesCommunity session={f.session} />);
  const latest = await screen.findByRole("button", {
    name: "Open Latest by Carl",
  });
  const grid = latest.closest("article")?.parentElement as HTMLElement;
  expect(
    within(grid)
      .getAllByRole("button")
      .map((item) => item.getAttribute("aria-label")),
  ).toEqual(["Open Latest by Carl", "Open Second by Ned", "Open Old by Carl"]);
  expect(
    within(grid).getByRole("button", {
      name: "Open Old by Carl",
    }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Open Community by Visitor" }),
  ).not.toBeInTheDocument();
  expect(
    grid.compareDocumentPosition(
      screen.getByRole("region", { name: "Other agents" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await user.click(latest);
  await enterFolder("Ned");
  expect(
    screen.queryByRole("button", { name: "Open Latest by Carl" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open Second by Ned" }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Latest" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to folders" }));
  expect(
    screen.getByRole("button", { name: "Open Latest by Carl" }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Latest" })).toBeVisible();
});

it("pages beyond the real profile directory budget and retains evicted agent classification", async () => {
  const { createProfileDirectory } = await import(
    "../../features/relay/profile-directory"
  );
  const entries = Array.from({ length: 1101 }, (_, i) => ({
    ...note(`Entry ${i}`, (i + 1).toString(16).padStart(64, "0"), 2000 - i),
    id: (i + 1).toString(16).padStart(64, "0"),
  }));
  const directory = createProfileDirectory({
    read: vi.fn(async ([filter]: readonly ReadFilter[]) =>
      (filter?.authors ?? []).map((pubkey) => ({
        ...note("Profile", pubkey),
        kind: 0,
        content: JSON.stringify({
          name: `Agent ${entries.findIndex((entry) => entry.pubkey === pubkey)}`,
          is_agent:
            pubkey === entries[0]?.pubkey || pubkey === entries.at(-1)?.pubkey,
        }),
      })),
    ),
  } as unknown as Parameters<typeof createProfileDirectory>[0]);
  try {
    await expect(
      directory.ensure(entries.map((entry) => entry.pubkey)),
    ).rejects.toThrow("directory budget");
    const f = fixture();
    let page = 0;
    f.readPage.mockImplementation(async ([filter]) => {
      if (filter?.authors) return { events: [], relayCount: 0 };
      const events = entries.slice(page * 100, ++page * 100);
      return { events, relayCount: events.length };
    });
    render(
      <NotesCommunity
        session={{ ...f.session, profiles: directory.queries }}
      />,
    );
    await screen.findByRole("button", { name: "Open Agent 0 folder" });
    for (let i = 1; i <= 11; i++) {
      await userEvent.click(
        screen.getByRole("button", { name: "Load older notes" }),
      );
      await waitFor(() => expect(page).toBe(i + 1));
      await waitFor(() => {
        const more = screen.queryByRole("button", { name: "Load older notes" });
        if (i === 11) expect(more).not.toBeInTheDocument();
        else expect(more).not.toHaveAttribute("aria-busy", "true");
      });
    }
    await screen.findByRole("button", { name: "Open Agent 1100 folder" });
    expect(directory.queries.snapshot().has(entries[0]?.pubkey ?? "")).toBe(
      false,
    );
    expect(
      screen.getByRole("button", { name: "Open Agent 0 folder" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Open Agent 500 folder" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be checked/)).not.toBeInTheDocument();
  } finally {
    cleanup();
    directory.dispose();
  }
});

it.each([false, true])(
  "preserves retry focus through pending and failure, with success=%s",
  async (success) => {
    const f = fixture();
    let release!: () => void;
    let attempt = 0;
    f.readPage.mockImplementation(async ([filter]) => {
      if (!filter?.authors) return { events: [], relayCount: 0 };
      if (++attempt === 1) throw new Error("offline");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (!success) throw new Error("still offline");
      return { events: [note("Recovered")], relayCount: 1 };
    });
    render(<NotesCommunity session={f.session} />);
    const retry = await screen.findByRole("button", { name: "Retry notes" });
    retry.focus();
    fireEvent.click(retry);
    try {
      await waitFor(() => expect(retry).toHaveAttribute("aria-busy", "true"));
      expect(retry).toHaveFocus();
    } finally {
      await act(async () => release());
    }
    if (success) {
      await screen.findByRole("button", { name: "Open Recovered by Carl" });
      expect(
        screen.getByRole("button", { name: "Refresh notes" }),
      ).toHaveFocus();
    } else {
      await waitFor(() =>
        expect(retry).not.toHaveAttribute("aria-busy", "true"),
      );
      expect(retry).toHaveFocus();
    }
  },
);

it.each([false, true])(
  "hands terminal pagination focus to Refresh without overriding a move, moved=%s",
  async (moved) => {
    const f = fixture();
    let release!: () => void;
    f.readPage.mockImplementation(async ([filter]) => {
      if (!filter?.authors) return { events: [], relayCount: 0 };
      if (!filter.before_id)
        return { events: [note("First")], relayCount: 100 };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { events: [note("Last", carl, 1)], relayCount: 1 };
    });
    render(<NotesCommunity session={f.session} />);
    const more = await screen.findByRole("button", {
      name: "Load older notes",
    });
    more.focus();
    fireEvent.click(more);
    const about = screen.getByRole("button", { name: "About shared notes" });
    try {
      await waitFor(() => expect(more).toHaveAttribute("aria-busy", "true"));
      if (moved) about.focus();
    } finally {
      await act(async () => release());
    }
    await waitFor(() => expect(more).not.toBeInTheDocument());
    expect(
      moved ? about : screen.getByRole("button", { name: "Refresh notes" }),
    ).toHaveFocus();
  },
);
