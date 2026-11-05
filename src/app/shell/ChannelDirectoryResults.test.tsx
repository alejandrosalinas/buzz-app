// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
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
import { type Filter, matchFilter } from "nostr-tools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import type { LiveCallbacks } from "../../features/relay/live";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import { createShortcutBindings } from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";
import { setUnreadFirstPreference } from "../../features/search/unread-first-preference";
import { PageSearch, type SearchServices } from "./PageSearch";

// jsdom lacks scrollIntoView; the palette reveals its typed-text selection.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

const pages: RegisteredPage[] = [
  {
    key: "buzz.channels/channels",
    pluginId: "buzz.channels",
    id: "channels",
    title: "Channels",
    revision: "bundled",
    component: () => null,
  },
];
const open = [
  ["public", ""],
  ["t", "stream"],
];

/** A connected search over a scripted relay: the viewer is in `design`, and
 * `buzz-community` and `release-notes` are open to join. */
function connected(
  options: {
    fail?: boolean;
    /** Newer open channels, which fill the directory's first page. */
    newer?: number;
    /** The newer channels' name prefix. */
    prefix?: string;
    /** Holds the directory's later pages until it settles. */
    later?: Promise<void>;
    /** The directory's page size. */
    page?: number;
  } = {},
) {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "design", "design", 1700000000, open),
    roster(relay, "design", [viewer.pubkey]),
    metadata(relay, "release", "release-notes", 1700000000, open),
    roster(relay, "release", [other.pubkey]),
    metadata(relay, "community", "buzz-community", 1700000000, [
      ...open,
      ["about", "Questions and tips"],
    ]),
    roster(relay, "community", [other.pubkey, relay.pubkey]),
    metadata(relay, "design-crit", "design-crit", 1700000000, open),
    roster(relay, "design-crit", [other.pubkey]),
    // The viewer is a read-only guest in both of these: still a member.
    metadata(relay, "guest-open", "design-guests", 1700000000, open),
    signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", "guest-open"],
        ["p", viewer.pubkey, "", "guest"],
      ],
    }),
    metadata(relay, "guest-private", "design-private", 1700000000, [
      ["private", ""],
      ["t", "stream"],
    ]),
    signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", "guest-private"],
        ["p", viewer.pubkey, "", "guest"],
      ],
    }),
    metadata(relay, "old", "old-news", 1700000000, [
      ...open,
      ["archived", "true"],
    ]),
    metadata(relay, "secret", "secret-plans", 1700000000, [
      ["private", ""],
      ["t", "stream"],
    ]),
    ...Array.from({ length: options.newer ?? 0 }, (_, index) =>
      metadata(
        relay,
        `bulk-${index}`,
        `${options.prefix ?? "team"}-${String(index).padStart(3, "0")}`,
        1700000100 + index,
        open,
      ),
    ),
  ];
  let failing = options.fail ?? false;
  /** Exact reads of open channels' rosters, for their member counts. */
  let countReads = 0;
  /** Paged reads of the whole open directory, as opposed to exact lookups. */
  let directoryReads = 0;
  let live: LiveCallbacks | undefined;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
      query(filters) {
        const directory = filters.some(
          (filter) =>
            filter.kinds?.includes(39000) && !filter["#p"] && !filter["#d"],
        );
        if (directory) directoryReads += 1;
        if (
          filters.some(
            (filter) => filter.kinds?.includes(39002) && !filter["#p"],
          )
        )
          countReads += 1;
        // Only the directory's paged read fails, not the joined list.
        if (failing && directory) return Promise.reject(new Error("offline"));
        const [filter] = filters;
        if (directory && filter) {
          // The relay's pages: newest first, then by id, after the cursor.
          const { limit, until, before_id, ...match } = filter as Filter & {
            before_id?: string;
          };
          const page = discovery
            .filter((event) => matchFilter(match as Filter, event))
            .sort(
              (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
            )
            .filter(
              (event) =>
                until === undefined ||
                event.created_at < until ||
                (event.created_at === until && event.id > (before_id ?? "")),
            )
            .slice(0, limit);
          return until === undefined || !options.later
            ? Promise.resolve(page)
            : options.later.then(() => page);
        }
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      },
    },
    options.page ? { publicDirectoryPage: options.page } : {},
  );
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const navigate = vi.fn(async () => {});
  const connection = {
    status: "ready",
    session: owner.session,
    scope: "scope",
    generation: 0,
  };
  const community = {
    selected: "wss://relay.example",
    viewer: viewer.pubkey,
  };
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => ({ entry: { target: null } }),
      open: navigate,
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: { subscribe: () => () => {}, snapshot: () => connection },
    },
  } as unknown as SearchServices;
  return {
    navigate,
    directoryReads: () => directoryReads,
    countReads: () => countReads,
    recover: () => {
      failing = false;
    },
    /** The relay drops the viewer from `channelId`, live, in this session. */
    revoke(channelId: string) {
      live?.state({ status: "connected", routes: [] });
      live?.receive([roster(relay, channelId, [], 1700000200)]);
    },
    render: () =>
      render(
        <PageSearch pages={pages} onSelect={vi.fn()} services={services} />,
      ),
    async dispose() {
      cleanup();
      bindings.dispose();
      await root.fiber.dispose();
      owner.dispose?.();
    },
  };
}

const openSearch = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Search Buzz" }));
  return screen.findByRole("dialog", { name: "Search Buzz" });
};
const field = () => screen.getByRole("combobox", { name: "Search Buzz" });
const rows = () =>
  Array.from(
    screen
      .getByRole("listbox", { name: "Channels" })
      .querySelectorAll('[role="option"]'),
    (row) => row.textContent,
  );

it("opens on All, and the Channels tab browses open channels to join A–Z", async () => {
  const t = connected();
  try {
    t.render();
    const dialog = await openSearch();
    const tabs = within(dialog).getByRole("tablist", { name: "Search in" });
    expect(within(tabs).getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(within(tabs).getByRole("tab", { name: "Channels" }));
    await waitFor(() =>
      expect(rows()).toEqual([
        expect.stringContaining("buzz-community"),
        expect.stringContaining("design-crit"),
        expect.stringContaining("release-notes"),
      ]),
    );
    // A pointer switch returns to the field, ready for typing.
    expect(field()).toHaveFocus();
    // The selected tab names and controls the panel holding its results.
    const panel = screen.getByRole("tabpanel", { name: "Channels" });
    expect(within(tabs).getByRole("tab", { name: "Channels" })).toHaveAttribute(
      "aria-controls",
      panel.id,
    );
    expect(
      within(panel).getByRole("listbox", { name: "Channels" }),
    ).toBeVisible();
    expect(
      screen.getByRole("group", { name: "Channels you can join" }),
    ).toBeVisible();
    // Member counts fill in after the rows, in one read for the rows shown.
    await waitFor(() =>
      expect(rows()).toEqual([
        "buzz-communityQuestions and tips2 members",
        "design-crit1 member",
        "release-notes1 member",
      ]),
    );
    expect(t.countReads()).toBe(1);
    // Joined (guests included), archived and private channels aren't
    // offered to join.
    for (const hidden of [
      /^design$/,
      /design-guests/,
      /design-private/,
      /old-news/,
      /secret-plans/,
    ])
      expect(screen.queryByRole("option", { name: hidden })).toBeNull();
    // The first row is ready for Enter, which opens its preview.
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(t.navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "conversation",
          channelId: "community",
        }),
      ),
    );
  } finally {
    await t.dispose();
  }
});

it("keeps the typed text across tabs and marks joined matches", async () => {
  const t = connected();
  try {
    t.render();
    await openSearch();
    await userEvent.type(field(), "design");
    fireEvent.keyDown(field(), { key: "Tab", ctrlKey: true });
    await screen.findByRole("tab", { name: "Channels", selected: true });
    expect(field()).toHaveValue("design");
    expect(field()).toHaveFocus();
    await waitFor(() =>
      expect(rows()).toEqual([
        "designJoined1 member",
        // Guests are members, open or private, so they're marked Joined.
        "design-guestsJoined1 member",
        "design-privateJoined1 member",
        "design-crit1 member",
      ]),
    );
    expect(screen.getByRole("group", { name: "Channels" })).toBeVisible();
    await userEvent.clear(field());
    await userEvent.type(field(), "zzz");
    expect(await screen.findByText("No matching channels.")).toBeVisible();
    expect(
      screen.getByText("Private channels show up once someone invites you."),
    ).toBeVisible();
    fireEvent.keyDown(field(), { key: "Tab", ctrlKey: true, shiftKey: true });
    await screen.findByRole("tab", { name: "All", selected: true });
    expect(
      screen.getByRole("listbox", { name: "Search results" }),
    ).toBeVisible();
  } finally {
    await t.dispose();
  }
});

it("switches from the tab row by keyboard and keeps focus there", async () => {
  const t = connected();
  try {
    t.render();
    await openSearch();
    await waitFor(() => expect(field()).toHaveFocus());
    await userEvent.tab();
    expect(screen.getByRole("tab", { name: "All" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Channels" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Channels", selected: true }),
      ).toHaveFocus(),
    );
  } finally {
    await t.dispose();
  }
});

it("shows a failed directory read with a retry", async () => {
  const t = connected({ fail: true });
  try {
    t.render();
    await openSearch();
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    expect(
      await screen.findByText("Couldn’t load channels.", undefined, {
        timeout: 5000,
      }),
    ).toBeVisible();
    t.recover();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry channels" }),
    );
    await waitFor(() =>
      expect(rows()).toContainEqual(expect.stringContaining("buzz-community")),
    );
    expect(screen.queryByText("Couldn’t load channels.")).toBeNull();
  } finally {
    await t.dispose();
  }
});

it("draws the first rows of a long list and more as its end nears, counting them all", async () => {
  const observed = new Set<Element>();
  let report: IntersectionObserverCallback = () => {};
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        report = callback;
      }
      observe(row: Element) {
        observed.add(row);
      }
      unobserve(row: Element) {
        observed.delete(row);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  const t = connected({ newer: 150 });
  try {
    t.render();
    await openSearch();
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    await waitFor(() => expect(rows()).toHaveLength(100));
    const options = screen.getAllByRole("option");
    // Assistive technology hears the whole list's size.
    expect(options[0]).toHaveAttribute("aria-setsize", "153");
    expect(options[99]).toHaveAttribute("aria-posinset", "100");
    // A row well above the end coming into view draws nothing more.
    const near = (index: number) =>
      options[index]?.closest("[data-search-key]") ?? undefined;
    const show = (row: Element | undefined) =>
      act(() =>
        report(
          [{ target: row, isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
    show(near(10));
    expect(rows()).toHaveLength(100);
    // Nearing the last drawn rows draws the rest.
    show(near(90));
    await waitFor(() => expect(rows()).toHaveLength(153));
    expect(screen.getAllByRole("option")[152]).toHaveAttribute(
      "aria-posinset",
      "153",
    );
    // Every drawn row is watched once, the old ones still included.
    expect(observed.size).toBe(153);
  } finally {
    await t.dispose();
  }
});

it("reads the directory again when access changes while Channels shows it", async () => {
  const t = connected();
  try {
    t.render();
    await openSearch();
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    const offered = [
      expect.stringContaining("buzz-community"),
      expect.stringContaining("design-crit"),
      expect.stringContaining("release-notes"),
    ];
    await waitFor(() => expect(rows()).toEqual(offered));
    const reads = t.directoryReads();
    // Losing another channel drops this session's directory, not the session.
    t.revoke("guest-private");
    await waitFor(() => expect(t.directoryReads()).toBe(reads + 1));
    await waitFor(() => expect(rows()).toEqual(offered));
    expect(screen.queryByText("You’ve joined every open channel.")).toBeNull();
  } finally {
    await t.dispose();
  }
});

it("starts reading the directory as search opens, so Channels has it at once", async () => {
  const t = connected();
  try {
    t.render();
    await openSearch();
    // Still on All: nothing asked for channels yet.
    await waitFor(() => expect(t.directoryReads()).toBe(1));
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    await waitFor(() =>
      expect(rows()).toContainEqual(expect.stringContaining("buzz-community")),
    );
    // The tab reused the read search started.
    expect(t.directoryReads()).toBe(1);
  } finally {
    await t.dispose();
  }
});

it("reopens where it was left after opening a channel, and fresh after Escape or a while away", async () => {
  const t = connected();
  const now = vi.spyOn(Date, "now");
  try {
    t.render();
    await openSearch();
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    await userEvent.type(field(), "crit");
    await waitFor(() => expect(rows()).toEqual(["design-crit1 member"]));
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
    );
    // Back within a few minutes: same tab, same text, same rows.
    await openSearch();
    expect(
      screen.getByRole("tab", { name: "Channels", selected: true }),
    ).toBeVisible();
    expect(field()).toHaveValue("crit");
    await waitFor(() => expect(rows()).toEqual(["design-crit1 member"]));
    // The kept text is selected, so new typing replaces it.
    await waitFor(() => expect(field()).toHaveFocus());
    expect(field()).toHaveProperty("selectionStart", 0);
    expect(field()).toHaveProperty("selectionEnd", 4);
    await userEvent.keyboard("release");
    expect(field()).toHaveValue("release");
    // With nothing typed, the row last chosen is still the one Enter picks.
    await userEvent.clear(field());
    await waitFor(() => expect(rows()).toHaveLength(3));
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(
      screen.getByRole("option", { name: /release-notes/, selected: true }),
    ).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
    );
    t.navigate.mockClear();
    await openSearch();
    expect(
      await screen.findByRole("option", {
        name: /release-notes/,
        selected: true,
      }),
    ).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(t.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "release" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
    );
    await openSearch();
    // Escape means done: the next opening starts fresh.
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
    );
    await openSearch();
    expect(
      screen.getByRole("tab", { name: "All", selected: true }),
    ).toBeVisible();
    expect(field()).toHaveValue("");
    // A kept place expires.
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    await userEvent.type(field(), "crit");
    await userEvent.click(
      await screen.findByRole("option", { name: /design-crit/ }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
    );
    now.mockReturnValue(Date.now() + 6 * 60_000);
    await openSearch();
    expect(
      screen.getByRole("tab", { name: "All", selected: true }),
    ).toBeVisible();
    expect(field()).toHaveValue("");
  } finally {
    now.mockRestore();
    await t.dispose();
  }
});

it("reopens an empty All view fresh, so it leads with what is unread now", async () => {
  const t = connected();
  try {
    t.render();
    await openSearch();
    const recent = await screen.findByRole("group", {
      name: "Recent activity",
    });
    await waitFor(() =>
      expect(within(recent).getAllByRole("option")).not.toHaveLength(0),
    );
    await userEvent.keyboard("{ArrowDown}");
    expect(within(recent).getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
    );
    await openSearch();
    const reopened = await screen.findByRole("group", {
      name: "Recent activity",
    });
    await waitFor(() =>
      expect(within(reopened).getAllByRole("option")).not.toHaveLength(0),
    );
    expect(field()).not.toHaveAttribute("aria-activedescendant");
  } finally {
    await t.dispose();
  }
});

it("keeps an empty All view's place only while unread does not lead it", async () => {
  const t = connected();
  const recentRows = async () => {
    const recent = await screen.findByRole("group", {
      name: "Recent activity",
    });
    await waitFor(() =>
      expect(within(recent).getAllByRole("option")).not.toHaveLength(0),
    );
    return within(recent).getAllByRole("option");
  };
  const closed = () =>
    waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
    );
  try {
    setUnreadFirstPreference(false);
    t.render();
    await openSearch();
    await recentRows();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    await closed();
    // Off, an empty search reopens where it was left.
    await openSearch();
    const kept = (await recentRows())[0];
    expect(field()).toHaveAttribute("aria-activedescendant", kept?.id);
    await userEvent.keyboard("{Enter}");
    await closed();
    // Turned back on, that place is not restored over what is unread now.
    setUnreadFirstPreference(true);
    await openSearch();
    await recentRows();
    expect(field()).not.toHaveAttribute("aria-activedescendant");
  } finally {
    setUnreadFirstPreference(true);
    await t.dispose();
  }
});

it("shows the directory's first page while the rest loads", async () => {
  let release = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Pages of 10: the 10 newest fill the first, and the rest are one more.
  const t = connected({ newer: 10, later, page: 10 });
  try {
    t.render();
    await openSearch();
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    // The newest page arrives first and shows while the older page is held.
    await waitFor(() => expect(rows()).toHaveLength(10));
    expect(rows()[0]).toContain("team-000");
    expect(screen.getByText("Loading more channels…")).toBeVisible();
    expect(rows()).not.toContainEqual(
      expect.stringContaining("buzz-community"),
    );
    release();
    await waitFor(() =>
      expect(screen.queryByText("Loading more channels…")).toBeNull(),
    );
    // The older page joins below them rather than reshuffling the rows
    // already shown, A–Z among itself.
    expect(rows()).toHaveLength(13);
    expect(rows()[0]).toContain("team-000");
    expect(rows().slice(10)).toEqual([
      expect.stringContaining("buzz-community"),
      expect.stringContaining("design-crit"),
      expect.stringContaining("release-notes"),
    ]);
    // Opened again on the finished read, the whole list is A–Z.
    await userEvent.click(screen.getByRole("tab", { name: "All" }));
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    await waitFor(() => expect(rows()[0]).toContain("buzz-community"));
  } finally {
    release();
    await t.dispose();
  }
});

it("reads the directory again when access changes while its pages load", async () => {
  let release = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = connected({ newer: 10, later, page: 10 });
  try {
    t.render();
    await openSearch();
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    await waitFor(() => expect(rows()).toHaveLength(10));
    const reads = t.directoryReads();
    // The held page's read is now stale; a fresh read replaces it, unasked.
    t.revoke("guest-private");
    await waitFor(() => expect(t.directoryReads()).toBeGreaterThan(reads));
    release();
    await waitFor(() =>
      expect(screen.queryByText("Loading more channels…")).toBeNull(),
    );
    expect(rows()).toHaveLength(13);
    expect(screen.queryByText("Couldn’t load channels.")).toBeNull();
  } finally {
    release();
    await t.dispose();
  }
});

it("puts joined matches first among equal matches after later pages land", async () => {
  let release = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The 4 newest fill the first page; design-crit lands on a later one while
  // Channels shows, and joined channels never land at all.
  const t = connected({ newer: 4, prefix: "design-new", page: 4, later });
  try {
    t.render();
    await openSearch();
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    await waitFor(() => expect(rows()).toHaveLength(4));
    release();
    await waitFor(() =>
      expect(screen.queryByText("Loading more channels…")).toBeNull(),
    );
    await userEvent.type(field(), "design-");
    await waitFor(() =>
      expect(rows().map((row) => row?.split(/Joined|\d+ members?/)[0])).toEqual(
        [
          "design-guests",
          "design-private",
          "design-new-000",
          "design-new-001",
          "design-new-002",
          "design-new-003",
          "design-crit",
        ],
      ),
    );
  } finally {
    release();
    await t.dispose();
  }
});
