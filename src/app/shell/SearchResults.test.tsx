import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type Filter, matchFilter } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import userEvent from "@testing-library/user-event";
import {
  bindNames,
  type IdentityNames,
} from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { BestieConversationContext } from "./bestie-context";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { ChannelList } from "../../features/relay/contracts";
import { eventDto, type RelayEvent } from "../../features/relay/events";
import type { VerifiedProfileSink } from "../../features/relay/verified-profile";
import { ReadError } from "../../features/relay/errors";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import type { ReadStateSigning } from "../../features/relay/read-state-host";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Test the production Node codec with disposable identities.
} from "../../../browser-host/read-state.mjs";
import {
  readJournal,
  type ReadJournal,
} from "../../features/relay/read-state-storage";
import type { AppServices } from "../services";
import type {
  DecisionRequest,
  Decisions,
} from "../../features/decisions/service";
import type { SearchGroup } from "./SearchChoices";
import { setUnreadFirstPreference } from "../../features/search/unread-first-preference";
import { messageSortPreference } from "../../features/search/message-sort-preference";
import { SearchResults } from "./SearchResults";
import { useSearchMessages } from "./useSearchMessages";
import { useSearchSettings } from "./SearchSettings";
import {
  readSearchUsage,
  recordChoice,
  recordVisit,
} from "../../features/search/usage";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import referenceStyles from "../../shared/InlineReference.module.css";
import { clearViewScope, writeView } from "../../shared/view-state";
import {
  namePreference,
  setNamePreference,
} from "../../features/profiles/name-preference";

// jsdom lacks scrollIntoView; the palette reveals its typed-text selection.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
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
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

/** A chip's hover hint, which shows what its text leaves out. */
async function expectHint(target: HTMLElement, hint: string) {
  await userEvent.setup().hover(target);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(hint);
}

it("keeps a joined private Guest channel in recents without calling it public or unjoined", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "guest", "Private updates", 1700000000, [["private"]]),
    signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", "guest"],
        ["p", viewer.pubkey, "", "guest"],
      ],
    }),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query: async (filters) =>
      discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      ),
  });
  const props = {
    session: owner.session,
    onQueryChange() {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: vi.fn(),
  };
  try {
    const mounted = render(<SearchResults {...props} query="" />);
    const recent = await screen.findByRole("group", {
      name: "Recents",
    });
    expect(
      within(recent).getByRole("option", { name: /Private updates/ }),
    ).toBeVisible();
    mounted.rerender(<SearchResults {...props} query="Private" />);
    expect(
      await screen.findByRole("option", { name: /Private updates/ }),
    ).toHaveTextContent("Conversation");
    expect(
      screen.queryByText("Public channel · not joined"),
    ).not.toBeInTheDocument();
    expect(owner.session.channels.get?.("guest")).toMatchObject({
      readOnly: true,
      viewerRole: "guest",
      visibility: "private",
    });
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens on recent channels in activity order, hinting the chord that searches this conversation", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "older", "older", 1700000000),
    roster(relay, "older", [viewer.pubkey]),
    metadata(relay, "latest", "latest", 1700000100),
    roster(relay, "latest", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query=""
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="older"
        conversationBinding={{ key: "f", mod: true }}
        onScopeChange={() => {}}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const recent = within(
      await screen.findByRole("group", { name: "Recents" }),
    );
    // The conversation's own search is a chord, not a row.
    expect(screen.queryByRole("option", { name: /Search in/ })).toBeNull();
    expect(screen.getByText("This conversation")).toHaveTextContent(
      "Ctrl+F This conversation",
    );
    const [first, second] = recent.getAllByRole("option");
    expect(first).toHaveTextContent("latest");
    expect(second).toHaveTextContent("older");
    expect(screen.queryByText("from: person")).toBeNull();
    expect(screen.queryByText("in: channel")).toBeNull();
    expect(screen.queryByText("during: date")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^(from:|in:|during:|ask:)/ }),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("leads an empty search with other unmuted unread channels and DMs, selecting the first for Enter", async () => {
  const relay = keypair();
  const viewer = keypair();
  const friend = keypair();
  let journal: ReadJournal | undefined;
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = ["alpha", "dm", "muted", "other", "quiet", "read"].flatMap(
    (id) => [
      metadata(relay, id, id, undefined, id === "dm" ? [["t", "dm"]] : []),
      roster(
        relay,
        id,
        id === "dm" ? [viewer.pubkey, friend.pubkey] : [viewer.pubkey],
      ),
    ],
  );
  const owner = createRelaySession(
    {
      ...wire.transport,
      query(filters) {
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        );
      },
      decodeSidebarPreferences: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: ["muted"],
      }),
    },
    {
      readStateFloor: () => 0,
      readPublisherLock: async (_signal, work) => work(),
      readStateStorage: {
        capture: async () => structuredClone(journal),
        close() {},
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
      },
    },
  );
  const open = vi.fn();
  const props = {
    session: owner.session,
    onQueryChange() {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    currentChannelId: "read",
    onScopeChange() {},
    openNewMessage: () => {},
    openConversation: open,
  };
  const markUnread = (channelId: string) =>
    act(async () => {
      await owner.session.unread.markUnreadLocal({
        kind: "channel",
        channelId,
      });
    });
  const rowsOf = (group: string) =>
    within(screen.getByRole("group", { name: group })).getAllByRole("option");
  try {
    await owner.session.sidebarPreferences.refresh();
    const first = render(<SearchResults {...props} query="" />);
    await waitFor(() => expect(rowsOf("Recents")).toHaveLength(4));
    // Nothing unread: the suggestions are unchanged and Enter opens nothing.
    const idle = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(screen.queryByRole("group", { name: "Unread" })).toBeNull();
    expect(idle).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(idle, { key: "Enter" });
    expect(open).not.toHaveBeenCalled();
    first.unmount();
    // The conversation already open is not somewhere to jump to.
    for (const id of ["other", "muted", "dm", "read"]) await markUnread(id);
    const mounted = render(<SearchResults {...props} query="" />);
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    await waitFor(() => expect(rowsOf("Unread")).toHaveLength(2));
    const rows = rowsOf("Unread");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/DM$/),
      expect.stringMatching(/^other/),
    ]);
    // Search opens on Unread alone.
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Unread"]);
    expect(input).toHaveAttribute("aria-activedescendant", rows[0]?.id);
    // Once the highlight is moved, an unread arriving above does not
    // redirect Enter.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", rows[1]?.id);
    // A DM still leads; alpha is newer than other.
    await markUnread("alpha");
    expect(rowsOf("Unread")[1]).toHaveTextContent(/^alpha/);
    expect(input).toHaveAttribute("aria-activedescendant", rows[1]?.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("other");
    // Typed text searches as before, without an Unread group.
    mounted.rerender(<SearchResults {...props} query="other" />);
    await screen.findByRole("group", { name: "Channels" });
    expect(screen.queryByRole("group", { name: "Unread" })).toBeNull();
    // Turned off in Settings, an empty search is unread-blind again.
    act(() => setUnreadFirstPreference(false));
    mounted.rerender(<SearchResults {...props} query="" />);
    await waitFor(() => expect(rowsOf("Recents")).toHaveLength(4));
    expect(screen.queryByRole("group", { name: "Unread" })).toBeNull();
    expect(input).not.toHaveAttribute("aria-activedescendant");
  } finally {
    setUnreadFirstPreference(true);
    cleanup();
    owner.dispose();
  }
});

it("opens on every unread conversation, with recents a Tab away", async () => {
  const relay = keypair();
  const viewer = keypair();
  let journal: ReadJournal | undefined;
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const ids = [
    ...Array.from({ length: 8 }, (_, index) => `unread-${index}`),
    "read",
  ];
  const discovery = ids.flatMap((id) => [
    metadata(relay, id, id),
    roster(relay, id, [viewer.pubkey]),
  ]);
  const owner = createRelaySession(
    {
      ...wire.transport,
      query(filters) {
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        );
      },
    },
    {
      readStateFloor: () => 0,
      readPublisherLock: async (_signal, work) => work(),
      readStateStorage: {
        capture: async () => structuredClone(journal),
        close() {},
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
      },
    },
  );
  const rowsOf = (group: string) =>
    within(screen.getByRole("group", { name: group })).getAllByRole("option");
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().channels).toHaveLength(9),
    );
    for (const id of ids.slice(0, 8))
      await owner.session.unread.markUnreadLocal({
        kind: "channel",
        channelId: id,
      });
    render(
      <SearchResults
        session={owner.session}
        query=""
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    // Search opens on Unread, whole, with its first row chosen.
    await waitFor(() => expect(rowsOf("Unread")).toHaveLength(8));
    const rows = rowsOf("Unread");
    expect(rows[0]).toHaveTextContent(/^unread-0/);
    const field = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(field).toHaveAttribute("aria-activedescendant", rows[0]?.id);
    expect(
      screen
        .getAllByRole("button", { pressed: true })
        .map((chip) => chip.textContent),
    ).toEqual([expect.stringMatching(/^Unread/)]);
    expect(screen.queryByRole("button", { name: /Jump back in/ })).toBeNull();
    // Tab shows Recents, without the unread rows; Escape comes back.
    fireEvent.keyDown(field, { key: "Tab" });
    expect(rowsOf("Recents").map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^read/),
    ]);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(rowsOf("Unread")).toHaveLength(8);
    // With every conversation unread, Recents does not claim none.
    await owner.session.unread.markUnreadLocal({
      kind: "channel",
      channelId: "read",
    });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Recents" })).toBeNull(),
    );
    expect(screen.queryByText("No recent activity yet.")).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("previews the newest unread reply of a channel unread only through threads and opens its thread", async () => {
  const relay = keypair(),
    viewer = keypair(),
    larry = keypair(),
    moe = keypair();
  const discovery = [
    profile(larry, { name: "Larry" }),
    profile(moe, { name: "Moe" }),
    ...["team", "blank", "mixed", "marked"].flatMap((id) => [
      metadata(relay, id, id),
      roster(relay, id, [viewer.pubkey, larry.pubkey]),
    ]),
    ...(
      [
        ["solo", larry],
        ["pair", moe],
      ] as const
    ).flatMap(([id, friend]) => [
      metadata(relay, id, id, undefined, [["t", "dm"]]),
      roster(relay, id, [viewer.pubkey, friend.pubkey]),
    ]),
  ];
  let live: LiveCallbacks | undefined;
  let journal: ReadJournal | undefined;
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      readState: {
        decode: async (events) => decodeReadState(events, viewer.secret),
        sign: async (intent: ReadStateSigning) =>
          signReadState(intent, viewer.secret),
        publish: async () => {},
      },
      async query(filters) {
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateFloor: () => 0,
      readPublisherLock: async (_signal, work) => work(),
      readStateStorage: {
        capture: async () => structuredClone(journal),
        close() {},
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
      },
    },
  );
  const reply = (
    root: RelayEvent,
    content: string,
    time: number,
    author = larry,
  ) =>
    message(
      author,
      root.tags.find(([tag]) => tag === "h")?.[1] ?? "",
      content,
      time,
      [["e", root.id, "", "reply"]],
    );
  const root = message(
    viewer,
    "team",
    "so uh how do I get that audio to stop",
    10,
  );
  const blankRoot = message(viewer, "blank", "attachment thread", 10);
  const mixedRoot = message(viewer, "mixed", "mixed thread", 10);
  const markedRoot = message(viewer, "marked", "marked thread", 10);
  const newerRoot = message(viewer, "team", "newer thread", 15);
  const oldest = reply(root, "Draft PR is up", 11);
  const older = reply(root, "CI is green now", 12);
  const newest = reply(newerRoot, "Newest thread reply", 16);
  const soloRoot = message(viewer, "solo", "solo thread", 10);
  const soloReply = reply(soloRoot, "Only DM thread reply", 11);
  const pairRoots = [
    message(viewer, "pair", "first DM thread", 10),
    message(viewer, "pair", "second DM thread", 10),
  ] as const;
  const open = vi.fn();
  const rowsOf = (group: string) =>
    within(screen.getByRole("group", { name: group })).getAllByRole("option");
  const row = (name: string) =>
    rowsOf("Unread").find((option) => option.textContent?.startsWith(name));
  try {
    render(
      <SearchResults
        session={owner.session}
        query=""
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={open}
      />,
    );
    await waitFor(() => expect(rowsOf("Recents")).toHaveLength(4));
    assert(live);
    const callbacks = live;
    act(() =>
      callbacks.receive([
        root,
        oldest,
        older,
        newerRoot,
        newest,
        blankRoot,
        reply(blankRoot, "", 13),
        mixedRoot,
        reply(mixedRoot, "mixed reply", 14),
        message(larry, "mixed", "new top-level message", 15),
        markedRoot,
        reply(markedRoot, "marked reply", 17),
        soloRoot,
        soloReply,
        ...pairRoots,
        reply(pairRoots[0], "First DM reply", 11, moe),
        reply(pairRoots[1], "Second DM reply", 12, moe),
      ]),
    );
    await act(async () => {
      await owner.session.unread.markUnreadLocal({
        kind: "channel",
        channelId: "marked",
      });
    });
    await waitFor(() => expect(rowsOf("Unread")).toHaveLength(6));
    // DMs lead, then channels with threads you're in, each tagged with why.
    expect(
      rowsOf("Unread").map(
        (option) => option.textContent?.match(/(DM|Thread)$/)?.[0],
      ),
    ).toEqual(["DM", "DM", "Thread", "Thread", "Thread", "Thread"]);
    expect(
      rowsOf("Unread")
        .slice(0, 2)
        .map((option) => option.textContent?.match(/^(Larry|Moe)/)?.[0])
        .sort(),
    ).toEqual(["Larry", "Moe"]);
    // The newest unread reply of the newest thread, by its author, not a root.
    await waitFor(() =>
      expect(row("team")).toHaveTextContent(
        "Thread reply, Larry: Newest thread reply",
      ),
    );
    expect(row("blank")).toHaveTextContent("Larry replied in a thread");
    // Unread channel messages keep the channel's destination, but the row
    // still shows the reply that earned its Thread tag.
    expect(row("mixed")).toHaveTextContent("Thread reply, Larry: mixed reply");
    fireEvent.click(row("mixed") as HTMLElement);
    expect(open).toHaveBeenLastCalledWith("mixed");
    // So does a channel marked unread, whatever its threads hold.
    expect(row("marked")).toHaveTextContent(
      "Thread reply, Larry: marked reply",
    );
    fireEvent.click(row("marked") as HTMLElement);
    expect(open).toHaveBeenLastCalledWith("marked");
    // A DM shares one read marker, so only a single unread thread leads it.
    expect(row("Larry")).toHaveTextContent(
      "Thread reply, Larry: Only DM thread reply",
    );
    fireEvent.click(row("Larry") as HTMLElement);
    expect(open).toHaveBeenLastCalledWith("solo", soloRoot.id, soloRoot.id);
    expect(row("Moe")).not.toHaveTextContent("Thread reply,");
    fireEvent.click(row("Moe") as HTMLElement);
    expect(open).toHaveBeenLastCalledWith("pair");
    // The row opens the thread it previews, which starts at its first unread reply.
    fireEvent.click(row("team") as HTMLElement);
    expect(open).toHaveBeenLastCalledWith("team", newerRoot.id, newerRoot.id);
    // Reading that thread previews the other one's newest reply.
    const read = (rootId: string, messageId: string) =>
      act(async () => {
        await owner.session.unread.markThrough(
          { kind: "thread", channelId: "team", rootId },
          messageId,
        );
      });
    await read(newerRoot.id, newest.id);
    await waitFor(() =>
      expect(row("team")).toHaveTextContent("Larry: CI is green now"),
    );
    expect(row("team")).not.toHaveTextContent("audio");
    fireEvent.click(row("team") as HTMLElement);
    expect(open).toHaveBeenLastCalledWith("team", root.id, root.id);
    // Reading every thread takes the channel out of Unread.
    await read(root.id, older.id);
    await waitFor(() => expect(row("team")).toBeUndefined());
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("leads with DMs, then mentions of you, then threads, then the rest, showing a muted channel only for a mention", async () => {
  const relay = keypair(),
    viewer = keypair(),
    larry = keypair();
  const discovery = [
    profile(larry, { name: "Larry" }),
    ...["chatter", "thread", "ping", "quiet-ping", "quiet"].flatMap((id) => [
      metadata(relay, id, id),
      roster(relay, id, [viewer.pubkey, larry.pubkey]),
    ]),
    metadata(relay, "solo", "solo", undefined, [["t", "dm"]]),
    roster(relay, "solo", [viewer.pubkey, larry.pubkey]),
  ];
  let live: LiveCallbacks | undefined;
  let journal: ReadJournal | undefined;
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      readState: {
        decode: async (events) => decodeReadState(events, viewer.secret),
        sign: async (intent: ReadStateSigning) =>
          signReadState(intent, viewer.secret),
        publish: async () => {},
      },
      async query(filters) {
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
      decodeSidebarPreferences: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: ["quiet-ping", "quiet"],
      }),
    },
    {
      readStateFloor: () => 0,
      readPublisherLock: async (_signal, work) => work(),
      readStateStorage: {
        capture: async () => structuredClone(journal),
        close() {},
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
      },
    },
  );
  const mention = [["p", viewer.pubkey]];
  const threadRoot = message(viewer, "thread", "thread root", 10);
  const rowsOf = (group: string) =>
    within(screen.getByRole("group", { name: group })).getAllByRole("option");
  try {
    await owner.session.sidebarPreferences.refresh();
    render(
      <SearchResults
        session={owner.session}
        query=""
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await waitFor(() => expect(rowsOf("Recents")).toHaveLength(4));
    assert(live);
    const callbacks = live;
    act(() =>
      callbacks.receive([
        message(larry, "chatter", "just chatting", 11),
        threadRoot,
        message(larry, "thread", "a reply", 12, [
          ["e", threadRoot.id, "", "reply"],
        ]),
        message(larry, "ping", "can you look at this", 13, mention),
        message(larry, "quiet-ping", "you too", 14, mention),
        message(larry, "quiet", "muted chatter", 15),
        message(larry, "solo", "hey there", 16),
      ]),
    );
    await waitFor(() => expect(rowsOf("Unread")).toHaveLength(5));
    const rows = rowsOf("Unread").map((row) => row.textContent ?? "");
    expect(rows[0]).toMatch(/^Larry.*DM$/);
    expect(rows.slice(1, 3).sort()).toEqual([
      expect.stringMatching(
        /^ping.*Mention, Larry: can you look at this.*Mentioned$/,
      ),
      expect.stringMatching(/^quiet-ping.*Larry: you too.*Mentioned$/),
    ]);
    expect(rows[3]).toMatch(/^thread.*Thread$/);
    expect(rows[4]).toMatch(/^chatter/);
    expect(rows[4]).not.toMatch(/(DM|Mentioned|Thread)$/);
    // A DM shows its newest unread message; a channel with only its own
    // messages unread keeps naming what it is.
    expect(rows[0]).toMatch(/^Larry.*hey there.*DM$/);
    expect(rows[0]).not.toMatch(/Direct message/);
    expect(rows[4]).toMatch(/Conversation/);
    // Muted without a mention stays quiet.
    expect(rows.some((row) => row.startsWith("quiet "))).toBe(false);
    expect(rows.filter((row) => row.startsWith("quiet"))).toHaveLength(1);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("counts a reply that mentions you, even muted, tiers Thread only for threads you're in, and opens the thread a row shows", async () => {
  const relay = keypair(),
    viewer = keypair(),
    larry = keypair();
  const discovery = [
    profile(larry, { name: "Larry" }),
    ...["muted-reply", "aside", "mixed", "two-threads", "picked"].flatMap(
      (id) => [
        metadata(relay, id, id),
        roster(relay, id, [viewer.pubkey, larry.pubkey]),
      ],
    ),
  ];
  let live: LiveCallbacks | undefined;
  let journal: ReadJournal | undefined;
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      readState: {
        decode: async (events) => decodeReadState(events, viewer.secret),
        sign: async (intent: ReadStateSigning) =>
          signReadState(intent, viewer.secret),
        publish: async () => {},
      },
      async query(filters) {
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
      decodeSidebarPreferences: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: ["muted-reply"],
      }),
    },
    {
      readStateFloor: () => 0,
      readPublisherLock: async (_signal, work) => work(),
      readStateStorage: {
        capture: async () => structuredClone(journal),
        close() {},
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
      },
    },
  );
  const mention = [["p", viewer.pubkey]];
  const reply = (root: { id: string }) => ["e", root.id, "", "reply"];
  const mutedRoot = message(larry, "muted-reply", "muted root", 10);
  const asideRoot = message(larry, "aside", "aside root", 10);
  const mixedRoot = message(viewer, "mixed", "my root", 10);
  // A mention in one thread, then a newer reply in another you're in.
  const mentionRoot = message(viewer, "two-threads", "my root", 10);
  const ownRoot = message(viewer, "two-threads", "my other root", 10);
  // No mention: an older reply in your thread, then a newer broadcast in a
  // thread you're not in, whose root you've read.
  const pickedRoot = message(viewer, "picked", "my picked root", 10);
  const otherRoot = message(larry, "picked", "their picked root", 11);
  const open = vi.fn();
  const rowsOf = (group: string) =>
    within(screen.getByRole("group", { name: group })).getAllByRole("option");
  try {
    await owner.session.sidebarPreferences.refresh();
    render(
      <SearchResults
        session={owner.session}
        query=""
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={open}
      />,
    );
    // Recents shows four conversations at most.
    await waitFor(() => expect(rowsOf("Recents")).toHaveLength(4));
    assert(live);
    const callbacks = live;
    act(() => callbacks.receive([pickedRoot, otherRoot]));
    await act(async () => {
      await owner.session.unread.markThrough(
        { kind: "channel", channelId: "picked" },
        otherRoot.id,
      );
    });
    act(() =>
      callbacks.receive([
        message(larry, "picked", "in your thread", 12, [reply(pickedRoot)]),
        message(larry, "picked", "for everyone", 18, [
          reply(otherRoot),
          ["broadcast", "1"],
        ]),
        mutedRoot,
        asideRoot,
        mixedRoot,
        mentionRoot,
        ownRoot,
        message(larry, "muted-reply", "are you around", 12, [
          reply(mutedRoot),
          ...mention,
        ]),
        message(larry, "aside", "for everyone", 13, [
          reply(asideRoot),
          ["broadcast", "1"],
        ]),
        message(larry, "mixed", "top-level news", 14),
        message(larry, "mixed", "answering you", 15, [reply(mixedRoot)]),
        message(larry, "two-threads", "need you here", 16, [
          reply(mentionRoot),
          ...mention,
        ]),
        message(larry, "two-threads", "newer, in yours", 17, [reply(ownRoot)]),
      ]),
    );
    await waitFor(() => expect(rowsOf("Unread")).toHaveLength(5));
    const rows = rowsOf("Unread");
    const text = rows.map((row) => row.textContent ?? "");
    expect(text.slice(0, 2).sort()).toEqual([
      expect.stringMatching(/^muted-reply.*Larry: are you around.*Mentioned$/),
      expect.stringMatching(/^two-threads.*Larry: need you here.*Mentioned$/),
    ]);
    expect(text.slice(2, 4).sort()).toEqual([
      expect.stringMatching(/^mixed.*Larry: answering you.*Thread$/),
      expect.stringMatching(/^picked.*Larry: in your thread.*Thread$/),
    ]);
    expect(text[4]).toMatch(/^aside/);
    expect(text[4]).not.toMatch(/(Mentioned|Thread)$/);
    // A thread-only row opens the thread its mention is in, not the newest.
    const row = (name: string) =>
      rows.find((option) => option.textContent?.startsWith(name));
    fireEvent.click(row("two-threads") as HTMLElement);
    expect(open).toHaveBeenLastCalledWith(
      "two-threads",
      mentionRoot.id,
      mentionRoot.id,
    );
    // With no mention, it previews your thread, but a broadcast in a thread
    // you're not in is ordinary channel unread, like a top-level post, so the
    // row opens its conversation.
    fireEvent.click(row("picked") as HTMLElement);
    expect(open).toHaveBeenLastCalledWith("picked");
    // A mixed row still opens its conversation.
    fireEvent.click(row("mixed") as HTMLElement);
    expect(open).toHaveBeenLastCalledWith("mixed");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("ranks typed channel names and selects the best one for Enter", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  // Weak matches come first in list order and exceed the lead group's
  // five-row limit.
  const names = [
    ...Array.from({ length: 8 }, (_, index) => `xlar-${index}`),
    "the-lar",
    "lar-crew",
    "lar",
  ];
  const discovery = names.flatMap((name, index) => [
    metadata(relay, name, name, 1700000000 + index),
    roster(relay, name, [viewer.pubkey]),
  ]);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="lar"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="xlar-0"
        onScopeChange={() => {}}
        openNewMessage={() => {}}
        openConversation={open}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    await waitFor(() =>
      expect(within(channels).getAllByRole("option")).toHaveLength(5),
    );
    expect(
      within(channels)
        .getAllByRole("option")
        .slice(0, 4)
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^lar/),
      expect.stringMatching(/^lar-crew/),
      expect.stringMatching(/^the-lar/),
      expect.stringMatching(/^xlar-/),
    ]);
    // The conversation's own search is a chord, not a row.
    expect(
      within(screen.getByRole("listbox")).queryByRole("group", {
        name: "This conversation",
      }),
    ).toBeNull();
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      within(channels).getAllByRole("option")[0]?.id,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("lar");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("matches channel names by substring, then word-start letter runs, not scattered letters", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const names = [
    "big-grape",
    "buzz-github-prs",
    "debug-pr",
    "general",
    "ops-bgp",
  ];
  const discovery = names.flatMap((name, index) => [
    metadata(relay, name, name, 1700000000 + index),
    roster(relay, name, [viewer.pubkey]),
  ]);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="bgp"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={open}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    // The substring match leads, then initials ("b"uzz-"g"ithub-"p"rs). Names
    // that merely hold the letters in order (big-grape, debug-pr) do not match.
    await waitFor(() =>
      expect(
        within(channels)
          .getAllByRole("option")
          .map((option) => option.textContent?.split(/[A-Z]/)[0]),
      ).toEqual(["ops-bgp", "buzz-github-prs"]),
    );
    // The matched letters are underlined, and only those letters.
    const marks = (name: string) =>
      [
        ...within(channels)
          .getByRole("option", { name: new RegExp(`^${name}`) })
          .querySelectorAll("mark"),
      ].map((mark) => mark.textContent);
    expect(marks("ops-bgp")).toEqual(["bgp"]);
    expect(marks("buzz-github-prs")).toEqual(["b", "g", "p"]);
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("ops-bgp");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("leads with the group holding the best match and ranks archived channels after live ties", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "space", "team-workspace", 1700000000),
    roster(relay, "space", [viewer.pubkey]),
    signed(relay, {
      kind: 39000,
      created_at: 1700000001,
      content: "",
      tags: [
        ["d", "old"],
        ["t", "stream"],
        ["name", "work-old"],
        ["archived", "true"],
      ],
    }),
    roster(relay, "old", [viewer.pubkey]),
    metadata(relay, "log", "work-log", 1700000002),
    roster(relay, "log", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      return discovery.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
  });
  const work = vi.fn();
  const page = (label: string, run = () => {}) => ({
    key: label,
    label,
    icon: ChatCircleIcon,
    run,
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="work"
        onQueryChange={() => {}}
        input={createRef()}
        // PageSearch ranks pages before they arrive here.
        pages={[page("Work", work), page("Workflows")]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    await waitFor(() =>
      expect(within(channels).getAllByRole("option")).toHaveLength(3),
    );
    expect(
      within(channels)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^work-log/),
      expect.stringMatching(/^work-old/),
      expect.stringMatching(/^team-workspace/),
    ]);
    const groups = within(screen.getByRole("listbox"))
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(groups.slice(0, 2)).toEqual(["Pages", "Channels"]);
    const pages = screen.getByRole("group", { name: "Pages" });
    expect(
      within(pages)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Work", "Workflows"]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(work).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows the real read failure, retains conversation choices, and retries to an exact message", async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "wes-crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      // Message search is scripted; the People directory finds nobody.
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wes-cr"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={open}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9], // The real reader canonicalizes set order.
        search: "wes-cr",
        search_mode: "prefix",
        limit: 20,
      },
    ]);
    await act(async () =>
      request.fail(
        new ReadError("invalid-response", "Relay response was invalid"),
      ),
    );
    expect(
      screen.getByText(
        /Message search couldn’t finish: Relay response was invalid/,
      ),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: /wes-crew/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
    expect(screen.queryByText(/Message search couldn’t finish/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    const hit = message(viewer, "crew", "wes-crew exact message", 1700000001);
    await act(async () => wire.next().respond([hit]));
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    // Typed text selects the first result; the late message sits below it.
    expect(
      screen.getByRole("option", { name: /^wes-crew(?! exact)/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: /wes-crew exact message/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("scopes conversation search at the relay and discards out-of-scope hits", async () => {
  vi.useFakeTimers();
  // A saved Most recent cannot apply on a relay that does not sort.
  localStorage.setItem("buzz-search-message-sort.v1", "newest");
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    metadata(relay, "other", "other"),
    roster(relay, "other", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const changeScope = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="scope"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        scopedChannelId="crew"
        onScopeChange={changeScope}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        search: "scope",
        search_mode: "prefix",
        limit: 20,
        "#h": ["crew"],
      },
    ]);
    await act(async () =>
      request.respond([
        message(viewer, "crew", "scope match", 1700000001),
        message(viewer, "other", "scope elsewhere", 1700000002),
      ]),
    );
    expect(screen.getByRole("option", { name: /scope match/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /scope elsewhere/ }),
    ).toBeNull();
    // A relay without `buzz-search-sort` would rank "Most recent" anyway.
    expect(screen.queryByRole("button", { name: /^Sort messages/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Remove .* search scope/ }),
    );
    expect(changeScope).toHaveBeenCalledExactlyOnceWith();
  } finally {
    localStorage.removeItem("buzz-search-message-sort.v1");
    cleanup();
    owner.dispose();
  }
});

it("offers more messages in overall search when the first page shows none", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      // Message reads are scripted; the people directory finds no one.
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="scope"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    // A full page of hits in conversations search does not show.
    const first = wire.next();
    await act(async () =>
      first.respond(
        Array.from({ length: 20 }, (_, i) =>
          message(viewer, "unknown", `scope hidden ${i}`, 1700000100 - i),
        ),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(
      screen.queryByText("No matching messages in accessible conversations."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Show more messages" }));
    const second = wire.next();
    expect(second.filters).toEqual([
      expect.objectContaining({ search: "scope", page: 2 }),
    ]);
    await act(async () =>
      second.respond([message(viewer, "crew", "scope match", 1700000001)]),
    );
    expect(screen.getByRole("option", { name: /scope match/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Show more messages" }),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("reranks message hits once the decision provider can answer, holding them once the person moves for that text", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const limits: (number | undefined)[] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      const read = filters.find(
        (filter) => filter.search !== undefined && filter.kinds?.includes(9),
      );
      if (read) {
        limits.push(read.limit);
        return Promise.resolve(
          ["one", "two", "runbook"].map((word, index) =>
            message(
              viewer,
              "crew",
              `${read.search} ${word}`,
              1700000500 - index,
            ),
          ),
        );
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  // Each call waits until the test answers it, favouring the runbook.
  const pending: (() => void)[] = [];
  let status = "needs-setup";
  const listeners = new Set<() => void>();
  const decisions = {
    status: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    decide: (request: DecisionRequest) =>
      new Promise((resolve) => {
        const { candidates } = JSON.parse(request.state) as {
          candidates: { n: number; text: string }[];
        };
        pending.push(() =>
          resolve({
            outcome: "answered",
            backend: "test",
            model: "test",
            answers: Object.fromEntries(
              candidates.map(({ n, text }) => [
                `m${n}`,
                {
                  type: "yes_no",
                  probability: text.endsWith("runbook") ? 0.9 : 0.1,
                },
              ]),
            ),
          }),
        );
      }),
  } as unknown as Decisions;
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
    openNewMessage: () => {},
    decisions,
  };
  // Results land, then settle long enough for the provider to be asked.
  const search = async (query: string) => {
    view.rerender(<SearchResults {...props} query={query} />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(pending).toHaveLength(1);
  };
  const answer = () => act(async () => pending.shift()?.());
  const order = () =>
    within(screen.getByRole("group", { name: "Messages" }))
      .getAllByRole("option")
      .map((row) => /(one|two|runbook)/.exec(row.textContent ?? "")?.[1]);
  const view = render(<SearchResults {...props} query="deploy" />);
  try {
    // Until the provider is set up, one page reads and nothing is asked.
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(limits).toEqual([20]);
    expect(pending).toHaveLength(0);

    // Once it can answer, the same text reads more and asks once. Moving
    // before the answer lands keeps the keyword order.
    act(() => {
      status = "ready";
      for (const listener of listeners) listener();
    });
    await search("deploy");
    expect(limits).toEqual([20, 60]);
    expect(order()).toEqual(["one", "two", "runbook"]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "ArrowDown",
    });
    await answer();
    expect(order()).toEqual(["one", "two", "runbook"]);
    expect(screen.queryByTitle("Reranked")).toBeNull();
    expect(
      screen.getByRole("group", { name: "Messages" }),
    ).not.toHaveAccessibleDescription(/Reranked/);

    // New text isn't held.
    await search("deploys");
    await answer();
    expect(order()).toEqual(["runbook", "one", "two"]);
    expect(screen.getByTitle("Reranked")).toBeInTheDocument();
    // The mark is hidden from assistive technology; the group says it.
    expect(
      screen.getByRole("group", { name: "Messages" }),
    ).toHaveAccessibleDescription(/Reranked/);

    // Nor is the earlier text, once the person has typed past it.
    await search("deploy");
    await answer();
    expect(order()).toEqual(["runbook", "one", "two"]);

    // A provider that stops being able to answer leaves this text's hits
    // and order; new text then reads one page.
    const reads = limits.length;
    act(() => {
      status = "needs-setup";
      for (const listener of listeners) listener();
    });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(limits).toHaveLength(reads);
    expect(order()).toEqual(["runbook", "one", "two"]);
    expect(screen.getByTitle("Reranked")).toBeInTheDocument();
    view.rerender(<SearchResults {...props} query="deployed" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(limits.slice(reads)).toEqual([20]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  { from: "crew", to: undefined },
  { from: undefined, to: "crew" },
])(
  "a move in one conversation's hits doesn't hold the rerank after the scope goes from $from to $to",
  async ({ from, to }) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const discovery = [
      metadata(relay, "crew", "crew"),
      roster(relay, "crew", [viewer.pubkey]),
    ];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        const read = filters.find(
          (filter) => filter.search !== undefined && filter.kinds?.includes(9),
        );
        if (read)
          // Each scope finds its own hits; the provider favours the last.
          return Promise.resolve(
            (read["#h"]
              ? ["one", "two", "runbook"]
              : ["three", "four", "guide"]
            ).map((word, index) =>
              message(viewer, "crew", `deploy ${word}`, 1700000500 - index),
            ),
          );
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      },
    });
    const pending: (() => void)[] = [];
    const decisions = {
      status: () => "ready",
      subscribe: () => () => {},
      decide: (request: DecisionRequest) =>
        new Promise((resolve) => {
          const { candidates } = JSON.parse(request.state) as {
            candidates: { n: number; text: string }[];
          };
          pending.push(() =>
            resolve({
              outcome: "answered",
              backend: "test",
              model: "test",
              answers: Object.fromEntries(
                candidates.map(({ n, text }) => [
                  `m${n}`,
                  {
                    type: "yes_no",
                    probability: /(runbook|guide)$/.test(text) ? 0.9 : 0.1,
                  },
                ]),
              ),
            }),
          );
        }),
    } as unknown as Decisions;
    const props = (channel: string | undefined) => ({
      session: owner.session,
      onQueryChange: () => {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      openConversation: () => {},
      openNewMessage: () => {},
      onScopeChange: () => {},
      decisions,
      query: "deploy",
      ...(channel ? { scopedChannelId: channel } : {}),
    });
    const settle = async () => {
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(pending).toHaveLength(1);
    };
    const answer = () => act(async () => pending.shift()?.());
    const order = () =>
      within(screen.getByRole("group", { name: "Messages" }))
        .getAllByRole("option")
        .map(
          (row) =>
            /(one|two|runbook|three|four|guide)/.exec(
              row.textContent ?? "",
            )?.[1],
        );
    const view = render(<SearchResults {...props(from)} />);
    try {
      await settle();
      // The field's name follows the scope.
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
      await answer();
      expect(order()).toEqual(
        from ? ["one", "two", "runbook"] : ["three", "four", "guide"],
      );

      view.rerender(<SearchResults {...props(to)} />);
      await settle();
      await answer();
      expect(order()).toEqual(
        to ? ["runbook", "one", "two"] : ["guide", "three", "four"],
      );
      expect(screen.getByTitle("Reranked")).toBeInTheDocument();
      expect(
        screen.getByRole("group", { name: "Messages" }),
      ).toHaveAccessibleDescription(/Reranked/);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

// Searches several signed pages; a busy runner has taken over 5 s.
it("sorts a conversation newest first across pages and restarts paging when the order changes", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    metadata(relay, "other", "other"),
    roster(relay, "other", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    searchSort: true,
    // Searches and history pages reach the scripted wire; the preview's
    // neighbor reads, three before the hit or a window after it, don't.
    query(filters, signal) {
      if (
        filters.some(
          (filter) =>
            filter.kinds?.includes(9) &&
            filter.since === undefined &&
            filter.limit !== 3,
        )
      )
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const request = async () => {
    await waitFor(() => expect(wire.pending).toHaveLength(1));
    return wire.next();
  };
  const hits = (count: number, newest: number) =>
    Array.from({ length: count }, (_, n) =>
      message(viewer, "crew", `sortword ${newest - n}`, newest - n),
    );
  const rows = () =>
    within(screen.getByRole("listbox", { name: "Search results" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
  const order = () =>
    screen
      .getByRole("group", { name: "Messages" })
      .querySelector(".navigation-section-label")?.textContent;
  const scoped = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    scopedChannelId: "crew",
    onScopeChange: () => {},
    openNewMessage: () => {},
    openConversation: () => {},
  };
  const text = {
    kinds: [40002, 40008, 9],
    search: "sortword",
    search_mode: "prefix",
    limit: 20,
    "#h": ["crew"],
  };
  try {
    const mounted = render(<SearchResults {...scoped} query="sortword" />);
    const relevance = await request();
    expect(relevance.filters).toEqual([text]);
    await act(async () => relevance.respond(hits(20, 1700000020)));
    expect(order()).toBe("Messages · Most relevant");

    fireEvent.click(screen.getByRole("button", { name: /^Sort messages/ }));
    expect(
      await screen.findByRole("menuitemradio", { name: "Most relevant" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Most recent" }));
    const first = await request();
    expect(first.filters).toEqual([{ ...text, search_sort: "newest" }]);
    // The menu leaves the saved default alone.
    expect(messageSortPreference()).toBe("relevance");
    const page1 = hits(20, 1700000100);
    const tail = page1.pop();
    assert(tail);
    // Order two signed hits instead of searching random hashes for a lower id.
    const [tie, last] = [
      tail,
      message(viewer, "crew", "sortword tie", tail.created_at),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    assert(tie && last);
    page1.push(last);
    await act(async () => first.respond(page1));
    expect(order()).toBe("Messages · Most recent");
    expect(rows().at(-1)).toMatch(/Show more messages/);

    fireEvent.click(screen.getByRole("option", { name: /Show more messages/ }));
    const failed = await request();
    expect(failed.filters).toEqual([
      { ...text, search_sort: "newest", page: 2 },
    ]);
    await act(async () =>
      failed.fail(
        new ReadError("invalid-response", "Relay response was invalid"),
      ),
    );
    expect(
      screen.getByText(
        "More messages couldn’t load: Relay response was invalid",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: /Show more messages/ }));
    const second = await request();
    expect(second.filters).toEqual([
      { ...text, search_sort: "newest", page: 2 },
    ]);
    // Offsets drift: a repeat, a backdated tie that sorts before it by id,
    // and an out-of-scope hit.
    const older = hits(2, last.created_at - 1);
    await act(async () =>
      second.respond([
        last,
        tie,
        message(viewer, "other", "sortword elsewhere", 1700000200),
        ...older,
      ]),
    );
    expect(screen.queryByText(/More messages couldn’t load/)).toBeNull();
    const ordered = [...page1, tie, ...older].sort(
      (a, b) =>
        b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    expect(rows()).toHaveLength(ordered.length);
    for (const [index, row] of rows().entries())
      expect(row).toContain(ordered[index]?.content);

    // Without text the relay reads newest-first history; there is no choice.
    mounted.rerender(<SearchResults {...scoped} query="before:2026-10-01" />);
    const history = await request();
    expect(history.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        limit: 20,
        "#h": ["crew"],
        until: expect.any(Number),
      },
    ]);
    await act(async () => history.respond(hits(1, 1700000001)));
    expect(order()).toBe("Messages · Filters apply to messages");
    expect(screen.queryByRole("button", { name: /^Sort messages/ })).toBeNull();

    mounted.rerender(<SearchResults {...scoped} query="sortword" />);
    const resumed = await request();
    expect(resumed.filters).toEqual([{ ...text, search_sort: "newest" }]);
    await act(async () => resumed.respond(hits(20, 1700000100)));

    // Search across conversations has no sort control, so it keeps relevance.
    const { scopedChannelId: _, ...unscoped } = scoped;
    mounted.rerender(<SearchResults {...unscoped} query="sortword" />);
    const global = await request();
    const { "#h": __, ...unscopedText } = text;
    expect(global.filters).toEqual([unscopedText]);
    await act(async () => global.respond(hits(1, 1700000001)));
    expect(screen.getByRole("group", { name: "Messages" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Sort messages/ })).toBeNull();

    mounted.rerender(<SearchResults {...scoped} query="sortword" />);
    const rescoped = await request();
    expect(rescoped.filters).toEqual([{ ...text, search_sort: "newest" }]);
    await act(async () => rescoped.respond(hits(20, 1700000100)));
    fireEvent.click(screen.getByRole("button", { name: /^Sort messages/ }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Most relevant" }),
    );
    const reset = await request();
    expect(reset.filters).toEqual([text]);

    // A saved Most recent seeds each new opening; restart reads it too.
    localStorage.setItem("buzz-search-message-sort.v1", "newest");
    mounted.unmount();
    render(<SearchResults {...scoped} query="sortword" />);
    expect((await request()).filters).toEqual([
      { ...text, search_sort: "newest" },
    ]);
  } finally {
    localStorage.removeItem("buzz-search-message-sort.v1");
    cleanup();
    owner.dispose();
  }
}, 15_000);

// Searches several signed pages; a busy runner has taken over 5 s.
it.each([
  { path: "the scope chip", scopedChannelId: "crew", query: "sortword" },
  { path: "a single in: channel", query: "in:#crew sortword" },
])(
  "shows one conversation's messages the same way from $path, with sort",
  async ({ scopedChannelId, query }) => {
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      metadata(relay, "crew", "crew"),
      roster(relay, "crew", [viewer.pubkey]),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      searchSort: true,
      // Searches reach the scripted wire; the preview's neighbor reads don't.
      query(filters, signal) {
        if (filters.some((filter) => filter.search !== undefined))
          return wire.transport.query(filters, signal);
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        );
      },
    });
    const request = async () => {
      await waitFor(() => expect(wire.pending).toHaveLength(1));
      return wire.next();
    };
    const group = () => screen.getByRole("group", { name: "Messages" });
    const heading = () =>
      group().querySelector(".navigation-section-label")?.textContent;
    const text = {
      kinds: [40002, 40008, 9],
      search: "sortword",
      search_mode: "prefix",
      limit: 20,
      "#h": ["crew"],
    };
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          scopedChannelId={scopedChannelId}
          onScopeChange={() => {}}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
          openNewMessage={() => {}}
        />,
      );
      const relevance = await request();
      expect(relevance.filters).toEqual([text]);
      await act(async () =>
        relevance.respond([
          message(viewer, "crew", "sortword hit", 1700000001),
        ]),
      );
      expect(within(screen.getByRole("listbox")).getAllByRole("group")).toEqual(
        [group()],
      );
      expect(heading()).toBe("Messages · Most relevant");
      expect(
        within(group()).getByRole("option", { name: /sortword hit/ }),
      ).toBeVisible();
      await waitFor(() =>
        expect(
          screen.getByRole("complementary", { name: "Preview" }),
        ).toHaveTextContent(/sortword hit/),
      );

      // The heading's order is visual only; the trigger names it.
      fireEvent.click(
        screen.getByRole("button", { name: "Sort messages: Most relevant" }),
      );
      fireEvent.click(
        await screen.findByRole("menuitemradio", { name: "Most recent" }),
      );
      const newest = await request();
      expect(newest.filters).toEqual([{ ...text, search_sort: "newest" }]);
      await act(async () => newest.respond([]));
      expect(heading()).toBe("Messages · Most recent");
      expect(
        screen.getByRole("button", { name: "Sort messages: Most recent" }),
      ).toBeVisible();
      expect(
        within(group()).getByText(
          "No matching messages in accessible conversations.",
        ),
      ).toBeVisible();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
  15_000,
);

it.each([
  { state: "an empty field", query: "", offline: undefined },
  {
    state: "a disconnected search",
    query: "sortword",
    offline: <p>Only saved conversations are searched.</p>,
  },
])(
  "shows no order for a conversation search with $state",
  ({ query, offline }) => {
    const relay = keypair();
    const viewer = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      searchSort: true,
      query: async () => [],
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          scopedChannelId="crew"
          onScopeChange={() => {}}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
          openNewMessage={() => {}}
          offline={offline}
        />,
      );
      if (offline) {
        // Nothing is searched, so no order shows.
        expect(screen.queryByText(/Most (recent|relevant)/)).toBeNull();
      } else {
        const group = screen.getByRole("group", { name: "Messages" });
        expect(
          group.querySelector(".navigation-section-label")?.textContent,
        ).toBe("Messages");
        expect(
          within(group).getByText(
            "Type to search messages in this conversation.",
          ),
        ).toBeVisible();
      }
      expect(
        screen.queryByRole("button", { name: /^Sort messages/ }),
      ).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it.each(["metadata", "denial"])(
  "does not resurrect displayed public hits after %s loss and regrant",
  async (loss) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const hit = message(viewer, "open", "crew public result", 1700000000);
    let live: LiveCallbacks | undefined;
    const metadata = (privateChannel: boolean, created_at: number) =>
      signed(relay, {
        kind: 39000,
        created_at,
        content: "",
        tags: [
          ["d", "open"],
          ["name", "Public"],
          [privateChannel ? "private" : "public"],
        ],
      });
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        return filters.some((filter) => filter.search)
          ? [hit]
          : filters.some((filter) => filter.kinds?.includes(39000))
            ? [metadata(false, 1700000000)]
            : [];
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query="crew"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      });
      expect(
        screen.getByRole("option", { name: /crew public result/ }),
      ).toBeVisible();
      const before = owner.session.channels.list();
      act(() => {
        if (loss === "denial")
          live?.denied("open", "restricted: not a channel member");
        else live?.receive([metadata(true, 1700000001)]);
        const denied = owner.session.channels.list();
        expect(denied).not.toBe(before);
        expect(denied.channels).toBe(before.channels);
        live?.receive([metadata(false, 1700000002)]);
      });
      expect(
        screen.queryByRole("option", { name: /crew public result/ }),
      ).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not reveal a revoked public hit queued before React commits its result", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const hit = message(viewer, "open", "crew queued result", 1700000000);
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  const publicEvent = (created_at: number) =>
    signed(relay, {
      kind: 39000,
      created_at,
      content: "",
      tags: [["d", "open"], ["public"]],
    });
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        filters.some((filter) => filter.kinds?.includes(39000))
          ? [publicEvent(1700000000)]
          : [],
      );
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    await act(async () => {
      wire.next().respond([hit]);
      // Drain the finite reader and palette's promise callback, without a React commit.
      await vi.advanceTimersByTimeAsync(0);
      live?.denied("open", "restricted: not a channel member");
      live?.receive([publicEvent(1700000001)]);
    });
    expect(
      screen.queryByRole("option", { name: /crew queued result/ }),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["", "Crew"])(
  "explains cold conversation loading without redundant banners (query=%s)",
  async (query) => {
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      metadata(relay, "crew", "Crew"),
      roster(relay, "crew", [viewer.pubkey]),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      query(filters, signal) {
        return filters.some((filter) => filter.kinds?.includes(39002))
          ? wire.transport.query(filters, signal)
          : Promise.resolve(discovery);
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[
            {
              key: "settings",
              label: "Settings",
              icon: ChatCircleIcon,
              run() {},
            },
          ]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      const pending = wire.next();
      expect(owner.session.channels.list().status).toBe("loading");
      if (query)
        expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
      else
        expect(screen.queryByRole("option", { name: /Settings/ })).toBeNull();
      if (query) {
        expect(screen.getByText("Loading joined conversations…")).toBeVisible();
        expect(screen.queryByText("Loading recent conversations…")).toBeNull();
      } else {
        expect(screen.getByText("Loading recent conversations…")).toBeVisible();
        expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      }
      await act(async () => pending.respond(discovery));
      expect(await screen.findByRole("option", { name: /Crew/ })).toBeVisible();
      expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      if (query)
        expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
      else
        expect(screen.queryByRole("option", { name: /Settings/ })).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not announce conversation enrichment over retained search choices", () => {
  const owner = createRelaySession(null);
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      list: () => list,
      ensureList() {},
    },
  };
  const list = {
    status: "loading" as const,
    channels: [{ id: "crew", name: "Crew", channelType: "stream" as const }],
  };
  try {
    render(
      <SearchResults
        session={session}
        query="Crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(screen.getByRole("option", { name: /Crew/ })).toBeVisible();
    expect(screen.queryByText("Loading joined conversations…")).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(
  (["stream", "forum", "solo"] as const).flatMap((channelType) =>
    (["live", "saved"] as const).map((source) => ({ channelType, source })),
  ),
)(
  "finds joined archived $channelType channels by name in a $source session without putting them in Recent activity",
  async ({ channelType, source }) => {
    const relay = keypair(),
      viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      signed(relay, {
        kind: 39000,
        created_at: 1700000000,
        content: "",
        tags: [
          ["d", "archive"],
          ["t", channelType === "solo" ? "stream" : channelType],
          ...(channelType === "solo" ? [["private"], ["t", "buzz.solo"]] : []),
          ["name", "Past project"],
          ["archived", "true"],
        ],
      }),
      roster(relay, "archive", [viewer.pubkey]),
      metadata(relay, "active", "Current project"),
      roster(relay, "active", [viewer.pubkey]),
    ];
    const saved = source === "saved";
    const owner = createRelaySession(
      {
        ...wire.transport,
        async query(filters) {
          // A saved session's relay reads fail.
          if (saved) throw new Error("Relay unavailable");
          return discovery.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          );
        },
      },
      saved
        ? {
            cachedOnly: true,
            prepared: true,
            persistence: {
              readStartup: async () => ({
                discovery: {
                  savedAt: Date.now(),
                  relayAuthor: relay.pubkey,
                  events: discovery,
                },
              }),
              read: async () => [],
              write: async () => {},
              remove: async () => {},
              retain: async () => {},
              clear: async () => {},
              close() {},
            },
          }
        : undefined,
    );
    if (saved) await owner.restore();
    const open = vi.fn();
    const props = {
      session: owner.session,
      onQueryChange: () => {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      openNewMessage: () => {},
      openConversation: open,
      offline: saved ? (
        <p>Only saved conversations are searched.</p>
      ) : undefined,
    };
    try {
      const mounted = render(<SearchResults {...props} query="" />);
      await screen.findByRole("option", { name: /Current project/ });
      const archived = owner.session.channels.get?.("archive");
      expect(archived?.channelType).toBe(channelType);
      // Restoration marks the saved member row read-only.
      expect(!!archived?.readOnly).toBe(saved);
      expect(!!archived?.cached).toBe(saved);
      expect(screen.queryByRole("option", { name: /Past project/ })).toBeNull();
      mounted.rerender(<SearchResults {...props} query="Past" />);
      fireEvent.click(
        await screen.findByRole("option", {
          name: /Past project/,
        }),
      );
      // The preview beside the row names it too, so look in the row.
      expect(
        within(screen.getByRole("option", { name: /Past project/ })).getByText(
          channelType === "solo"
            ? "Archived chat"
            : "Archived channel · 1 member",
        ),
      ).toBeTruthy();
      expect(open).toHaveBeenCalledExactlyOnceWith("archive");
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it.each([
  { channelType: "stream", readOnly: true },
  { channelType: "forum", readOnly: true },
  { channelType: "solo", readOnly: true },
  { channelType: "dm" },
  { channelType: "dm", readOnly: true, cached: true },
  { channelType: "stream", readOnly: true, cached: true, viewerRole: "guest" },
] as const)(
  "does not surface archived nonmember, guest or non-channel destinations: %j",
  (state) => {
    const owner = createRelaySession(null);
    const snapshot = {
      status: "ready" as const,
      channels: [
        {
          id: "excluded",
          name: "Past project",
          archived: true as const,
          ...state,
        },
      ],
    };
    const session = {
      ...owner.session,
      channels: {
        ...owner.session.channels,
        list: () => snapshot,
        ensureList() {},
      },
    };
    try {
      render(
        <SearchResults
          session={session}
          query="Past"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      expect(screen.queryByRole("option", { name: /Past project/ })).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("shows each channel result's member count, reading an unjoined channel's roster for display only", async () => {
  const relay = keypair();
  const viewer = keypair();
  const [first, second, third] = [keypair(), keypair(), keypair()];
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "crew-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey, first.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [first.pubkey, second.pubkey, third.pubkey]),
    metadata(relay, "solo-room", "crew-solo", 1700000000, open),
    roster(relay, "solo-room", [second.pubkey]),
  ];
  const reads: unknown[] = [];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      reads.push(filters);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const group = () => within(screen.getByRole("group", { name: "Channels" }));
    await waitFor(() =>
      expect(
        group()
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual([
        expect.stringContaining("Conversation · 2 members"),
        expect.stringContaining("Public channel · not joined · 3 members"),
        expect.stringContaining("Public channel · not joined · 1 member"),
      ]),
    );
    // The joined row counts the roster it carries; only unjoined rows read,
    // without the viewer filter, so their rosters stay out of discovery.
    expect(reads).toContainEqual([
      {
        kinds: [39002],
        authors: [relay.pubkey],
        "#d": ["lobby", "solo-room"],
        limit: 2,
      },
    ]);
    expect(owner.session.channels.get?.("lobby")?.members).toEqual([]);
    expect(
      owner.session.channels.list().channels.map((channel) => channel.id),
    ).toEqual(["joined"]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("finds active public channels the viewer has not joined without adding them to the joined list", async () => {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "crew-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [other.pubkey]),
    metadata(relay, "secret", "crew-secret", 1700000000, [
      ["private", ""],
      ["t", "stream"],
    ]),
    metadata(relay, "old", "crew-old", 1700000000, [
      ...open,
      ["archived", "true"],
    ]),
    metadata(relay, "dm", "crew-dm", 1700000000, [
      ["public", ""],
      ["hidden", ""],
      ["t", "dm"],
    ]),
    // Only relay-signed metadata is channel authority.
    metadata(other, "forged", "crew-forged", 1700000000, open),
  ];
  const reads: unknown[] = [];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      reads.push(filters);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
      />,
    );
    const lobby = await screen.findByRole("option", { name: /crew-lobby/ });
    expect(lobby).toHaveTextContent("Public channel · not joined");
    const group = within(screen.getByRole("group", { name: "Channels" }));
    expect(
      group.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      expect.stringContaining("crew-chat"),
      expect.stringContaining("crew-lobby"),
    ]);
    for (const hidden of ["crew-secret", "crew-old", "crew-dm", "crew-forged"])
      expect(
        screen.queryByRole("option", { name: new RegExp(hidden) }),
      ).toBeNull();
    // The match resolved through exact signed metadata and the viewer roster.
    expect(reads).toContainEqual([
      expect.objectContaining({ kinds: [39000], "#d": ["lobby"] }),
      expect.objectContaining({
        kinds: [39002],
        "#d": ["lobby"],
        "#p": [viewer.pubkey],
      }),
    ]);
    expect(owner.session.channels.get?.("lobby")).toMatchObject({
      readOnly: true,
      name: "crew-lobby",
    });
    expect(
      owner.session.channels.list().channels.map((channel) => channel.id),
    ).toEqual(["joined"]);
    fireEvent.click(lobby);
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([false, true])(
  "delays People feedback with existing rows=%s and clears it on completion",
  async (populated) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair(),
      person = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => [],
    });
    const t = peopleSession(
      owner.session,
      populated ? [{ pubkey: person.pubkey, name: "Crew person" }] : [],
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const people = vi.fn(async (query?: string) => {
      if (populated && query === "cre")
        return {
          people: [{ pubkey: person.pubkey, name: "Crew person" }],
          hasMore: false,
        };
      await held;
      return { people: [], hasMore: false };
    });
    const session = {
      ...t.session,
      directMessages: { ...t.session.directMessages, people },
    };
    try {
      const props = {
        session,
        onQueryChange: () => {},
        input: createRef<HTMLInputElement>(),
        pages: [],
        openNewMessage: () => {},
        openConversation: () => {},
      };
      const view = render(
        <SearchResults
          session={session}
          query={populated ? "cre" : "crew"}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      if (populated) {
        await act(async () => vi.advanceTimersByTimeAsync(300));
        expect(screen.getByRole("group", { name: "People" })).toHaveTextContent(
          "Crew person",
        );
        view.rerender(<SearchResults {...props} query="crew" />);
      }
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(people).toHaveBeenCalledTimes(populated ? 2 : 1);
      expect(screen.queryByText("· Searching…")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      const group = screen.getByRole("group", { name: "People" });
      expect(
        within(group).getByRole("heading", { name: "People" }),
      ).toHaveTextContent(/^People\b.*· Searching…$/);
      expect(within(group).queryAllByRole("option")).toHaveLength(
        populated ? 1 : 0,
      );
      expect(group.querySelector(".search-palette-group-empty")).toBeNull();
      if (populated) expect(group).not.toHaveAttribute("aria-busy");
      else expect(group).toHaveAttribute("aria-busy", "true");
      expect(screen.getByRole("status")).toHaveTextContent("Searching people…");
      await act(async () => release());
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("group", { name: "People" })).toBeNull();
    } finally {
      release();
      cleanup();
      owner.dispose();
    }
  },
);

it.each([false, true])(
  "delays message heading feedback in scoped=%s search",
  async (scoped) => {
    vi.useFakeTimers();
    const messages = "Messages";
    const relay = keypair(),
      viewer = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => [],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readPage = vi.fn(async () => {
      await held;
      return { events: [], relayCount: 0 };
    });
    const channel = {
      id: "crew",
      name: "Crew",
      channelType: "stream" as const,
    };
    const session = {
      ...owner.session,
      readPage,
      channels: {
        ...owner.session.channels,
        get: () => channel,
        resolve: async () => {},
      },
    };
    try {
      render(
        <SearchResults
          session={session}
          query="crew"
          scopedChannelId={scoped ? "crew" : undefined}
          onQueryChange={() => {}}
          input={createRef()}
          pages={
            scoped
              ? []
              : [
                  {
                    key: "page:crew",
                    label: "Crew page",
                    icon: ChatCircleIcon,
                    run: () => {},
                  },
                ]
          }
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(readPage).toHaveBeenCalledOnce();
      expect(screen.queryByRole("group", { name: messages })).toBeNull();
      expect(screen.queryByText("Still searching messages…")).toBeNull();
      expect(
        screen.queryByText("No matching messages in accessible conversations."),
      ).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      if (scoped) {
        const group = screen.getByRole("group", { name: messages });
        expect(within(group).getByText("· Searching…")).toBeVisible();
        expect(group.querySelector(".search-palette-group-empty")).toBeNull();
      } else {
        // Top results ends with a line saying messages are still coming.
        expect(screen.getByText("Still searching messages…")).toBeVisible();
        expect(screen.queryByRole("heading", { name: messages })).toBeNull();
        expect(screen.getByRole("group", { name: "Pages" })).toBeVisible();
      }
      expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
      await act(async () => release());
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("listbox")).not.toHaveAttribute("aria-busy");
      expect(screen.queryByText("Still searching messages…")).toBeNull();
      if (scoped)
        expect(
          screen.getByText("No matching messages in accessible conversations."),
        ).toBeVisible();
      else expect(screen.queryByRole("group", { name: messages })).toBeNull();
    } finally {
      release();
      cleanup();
      owner.dispose();
    }
  },
);

it.each(["crew after:", "crew from:"])(
  "announces no hidden result lookups behind the %s picker",
  async (query) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => [],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const searchPublic = vi.fn(async () => {
      await held;
      return { channels: [], partial: false };
    });
    const readPage = vi.fn(async () => {
      await held;
      return { events: [], relayCount: 0 };
    });
    const session = {
      ...owner.session,
      readPage,
      channels: { ...owner.session.channels, searchPublic },
    };
    try {
      render(
        <SearchResults
          session={session}
          query={query}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(searchPublic).toHaveBeenCalled();
      expect(
        screen.getByRole("group", {
          name: query.endsWith("after:") ? "Dates" : "People",
        }),
      ).toBeVisible();
      expect(screen.queryByText(/· Searching…/)).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      release();
      cleanup();
      owner.dispose();
    }
  },
);

it.each([false, true])(
  "freezes the announcement with simultaneous sources=%s",
  async (simultaneous) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => [],
    });
    let releaseChannels!: () => void, releasePeople!: () => void;
    const channelsHeld = new Promise<void>((resolve) => {
      releaseChannels = resolve;
    });
    const peopleHeld = new Promise<void>((resolve) => {
      releasePeople = resolve;
    });
    const t = peopleSession(owner.session);
    const session = {
      ...t.session,
      channels: {
        ...t.session.channels,
        searchPublic: async () => {
          await channelsHeld;
          return { channels: [], partial: false };
        },
      },
      directMessages: {
        ...t.session.directMessages,
        people: async (query?: string) => {
          if (simultaneous || query === "crew") await peopleHeld;
          return { people: [], hasMore: false };
        },
      },
    };
    const props = {
      session,
      onQueryChange: () => {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      openNewMessage: () => {},
      openConversation: () => {},
    };
    try {
      const view = render(<SearchResults {...props} query="cre" />);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      const expected = simultaneous
        ? "Searching channels and people…"
        : "Searching channels…";
      expect(screen.getByRole("status")).toHaveTextContent(expected);
      if (!simultaneous) {
        view.rerender(<SearchResults {...props} query="crew" />);
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(
          within(screen.getByRole("group", { name: "People" })).getByText(
            "· Searching…",
          ),
        ).toBeVisible();
        expect(screen.getByRole("status")).toHaveTextContent(expected);
      }
      await act(async () => releaseChannels());
      expect(screen.queryByRole("group", { name: "Channels" })).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(expected);
      await act(async () => releasePeople());
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      releaseChannels();
      releasePeople();
      cleanup();
      owner.dispose();
    }
  },
);

it("shows a delayed Channels group only while an empty directory read is pending", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: async () => [],
  });
  const searchPublic = vi.fn(async () => {
    await held;
    return { channels: [], partial: false };
  });
  const session = {
    ...owner.session,
    channels: { ...owner.session.channels, searchPublic },
  };
  try {
    render(
      <SearchResults
        session={session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(searchPublic).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Channels" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const group = screen.getByRole("group", { name: "Channels" });
    expect(within(group).getByText("· Searching…")).toBeVisible();
    expect(within(group).queryByRole("option")).toBeNull();
    expect(group).not.toHaveTextContent("No matching results.");
    expect(
      within(group).getByRole("heading", { name: "Channels" }),
    ).toHaveTextContent(/^Channels\b.*· Searching…$/);
    expect(group.querySelector(".search-palette-group-empty")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("listbox")).not.toContainElement(
      screen.getByRole("status"),
    );
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    await act(async () => release());
    expect(screen.queryByRole("group", { name: "Channels" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it("keeps a selected person and the delayed notice when channel results stream in", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    person = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: async () => [],
  });
  const t = peopleSession(owner.session, [
    { pubkey: person.pubkey, name: "Crew member" },
  ]);
  const channel = {
    id: "crew",
    name: "crew",
    readOnly: true as const,
    channelType: "stream" as const,
  };
  let progress!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const searchPublic: NonNullable<
    typeof owner.session.channels.searchPublic
  > = async (_query, options) => {
    progress = () =>
      options?.progress?.({ channels: [channel], partial: false });
    await held;
    return { channels: [channel], partial: false };
  };
  const session = {
    ...t.session,
    channels: {
      ...t.session.channels,
      searchPublic,
      get: (id: string) =>
        id === channel.id ? channel : t.session.channels.get?.(id),
    },
  };
  const openNewMessage = vi.fn();
  try {
    render(
      <SearchResults
        session={session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={openNewMessage}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const field = screen.getByRole("combobox", { name: "Search Buzz" });
    const personRow = within(
      screen.getByRole("group", { name: "People" }),
    ).getByRole("option");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(personRow).toHaveAttribute("aria-selected", "true");
    const status = screen.getByRole("status");
    expect(
      within(screen.getByRole("group", { name: "Channels" })).queryByRole(
        "option",
      ),
    ).toBeNull();
    await act(async () => progress());
    const channels = screen.getByRole("group", { name: "Channels" });
    expect(
      within(channels).getByRole("option", { name: /^crew/ }),
    ).toBeVisible();
    expect(within(channels).getByText("· Searching…")).toBeVisible();
    expect(screen.getByRole("status")).toBe(status);
    // Once the highlight has moved, groups keep their places: the channel
    // that streamed in goes after the person's group, not above it.
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("group")
        .slice(0, 2)
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["People", "Channels"]);
    expect(personRow).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {});
    expect(openNewMessage).toHaveBeenCalledExactlyOnceWith(person.pubkey);
    expect(t.open).not.toHaveBeenCalled();
    await act(async () => release());
    expect(screen.queryByRole("status")).toBeNull();
    expect(within(channels).queryByText("· Searching…")).toBeNull();
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it.each(["finish", "fail"])(
  "shows open channels from the first directory page while older pages load, and keeps them when they %s",
  async (outcome) => {
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const open = (id: string) =>
      metadata(relay, id, id, 1700000000, [
        ["public", ""],
        ["t", "stream"],
      ]);
    // A full first page, so the directory read goes on to an older one.
    const discovery = [
      open("crew-lobby"),
      ...Array.from({ length: 499 }, (_, i) => open(`extra-${i}`)),
    ];
    let older!: (failed: boolean) => void;
    const held = new Promise<boolean>((resolve) => (older = resolve));
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters) {
        if (filters.some((filter) => filter.before_id !== undefined)) {
          if (await held) throw new Error("Relay read failed (500)");
          return [];
        }
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    try {
      vi.useFakeTimers();
      const props = {
        session: owner.session,
        onQueryChange: () => {},
        input: createRef<HTMLInputElement>(),
        pages: [],
        openNewMessage: () => {},
        openConversation: () => {},
      };
      const mounted = render(<SearchResults {...props} query="crew" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      });
      expect(
        screen.getByRole("option", { name: /crew-lobby/ }),
      ).toHaveTextContent("Public channel · not joined");
      // The read's feedback waits a second; its rows do not.
      expect(screen.queryByRole("status")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByRole("status")).toHaveTextContent(
        "Searching channels…",
      );
      const channels = screen.getByRole("group", { name: "Channels" });
      const notice = within(channels).getByText("· Searching…");
      expect(notice.closest("h2")).toHaveTextContent(
        /^Channels\b.*· Searching…$/,
      );
      expect(notice).toHaveAttribute("aria-hidden", "true");
      expect(channels.querySelector(".search-palette-group-empty")).toBeNull();
      expect(within(channels).getAllByRole("option")).toHaveLength(1);
      expect(
        within(channels).getByRole("option").compareDocumentPosition(notice) &
          Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy();
      expect(screen.getByRole("listbox")).not.toContainElement(
        screen.getByRole("status"),
      );
      // Narrowing the query while older pages load keeps the row.
      mounted.rerender(<SearchResults {...props} query="crew-l" />);
      expect(screen.getByRole("option", { name: /crew-lobby/ })).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Searching channels…",
      );
      older(outcome === "fail");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      });
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("option", { name: /crew-lobby/ })).toBeVisible();
      if (outcome === "fail")
        expect(
          screen.getByText(/Public channel search couldn’t finish/),
        ).toBeVisible();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("keeps the open-channel search notice silent when the directory answers within a second", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "lobby", "crew-lobby", 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
    roster(relay, "lobby", [keypair().pubkey]),
  ];
  // The match's exact resolution is the warm directory's one round trip.
  let resolved!: () => void;
  const held = new Promise<void>((release) => (resolved = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter["#d"])) await held;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(screen.queryByRole("option", { name: /crew-lobby/ })).toBeNull();
    expect(screen.queryByText("Searching channels…")).toBeNull();
    await act(async () => resolved());
    expect(screen.getByRole("option", { name: /crew-lobby/ })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByText("Searching channels…")).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens the open channel that lands after an early Enter, without first saying nothing matched", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "lobby", "crew-lobby", 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
    roster(relay, "lobby", [keypair().pubkey]),
  ];
  let resolved!: () => void;
  const held = new Promise<void>((release) => (resolved = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter["#d"])) await held;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(screen.queryByRole("option")).toBeNull();
    expect(
      screen.queryByText("No matching messages in accessible conversations."),
    ).toBeNull();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(openConversation).not.toHaveBeenCalled();
    await act(async () => resolved());
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("holds an early Enter for an open channel over a message that lands first, and for a message once channels settle empty", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "general", "general"),
    roster(relay, "general", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
    roster(relay, "lobby", [keypair().pubkey]),
  ];
  let resolved!: () => void;
  const held = new Promise<void>((release) => (resolved = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters, signal) {
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      if (filters.some((filter) => filter["#d"]?.includes("lobby"))) await held;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    const props = {
      session: owner.session,
      onQueryChange: () => {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      openNewMessage: () => {},
      openConversation,
    };
    const mounted = render(<SearchResults {...props} query="crew" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    await act(async () =>
      wire
        .next()
        .respond([message(viewer, "general", "crew news", 1700000001)]),
    );
    expect(screen.getByRole("option", { name: /crew news/ })).toBeVisible();
    expect(openConversation).not.toHaveBeenCalled();
    await act(async () => resolved());
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
    // With no channel to wait for, Enter waits for message search instead.
    mounted.rerender(<SearchResults {...props} query="news" />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(openConversation).toHaveBeenCalledOnce();
    const news = message(viewer, "general", "news", 1700000002);
    await act(async () => wire.next().respond([news]));
    expect(openConversation).toHaveBeenLastCalledWith("general", news.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens an open channel from the first directory page after an early Enter, while older pages load", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = (id: string) =>
    metadata(relay, id, id, 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]);
  // A full first page, so the directory read goes on to an older one.
  const discovery = [
    open("crew-lobby"),
    ...Array.from({ length: 499 }, (_, i) => open(`extra-${i}`)),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters, signal) {
      if (filters.some((filter) => filter.before_id !== undefined))
        return new Promise(() => {});
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
      />,
    );
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    // Neither the older directory page nor message search has answered.
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("crew-lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("holds an early Enter for an open channel over Show more messages", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "general", "general"),
    roster(relay, "general", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
    roster(relay, "lobby", [keypair().pubkey]),
  ];
  let resolved!: () => void;
  const held = new Promise<void>((release) => (resolved = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters, signal) {
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      if (filters.some((filter) => filter["#d"]?.includes("lobby"))) await held;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef<HTMLInputElement>()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    // A full page of hits in conversations search does not show.
    await act(async () =>
      wire
        .next()
        .respond(
          Array.from({ length: 20 }, (_, i) =>
            message(viewer, "unknown", `crew hidden ${i}`, 1700000100 - i),
          ),
        ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(
      screen.getByRole("option", { name: "Show more messages" }),
    ).toBeVisible();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(wire.pending).toHaveLength(0);
    await act(async () => resolved());
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
    expect(wire.pending).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("drops a held Enter when search narrows to this conversation", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "general", "general"),
    roster(relay, "general", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
    roster(relay, "lobby", [keypair().pubkey]),
  ];
  let resolved!: () => void;
  const held = new Promise<void>((release) => (resolved = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters, signal) {
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      if (filters.some((filter) => filter["#d"]?.includes("lobby"))) await held;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  const props = {
    session: owner.session,
    query: "crew",
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    currentChannelId: "general",
    onScopeChange: () => {},
    openNewMessage: () => {},
    openConversation,
  };
  try {
    const { rerender } = render(<SearchResults {...props} />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const field = screen.getByRole("combobox", { name: "Search Buzz" });
    // Enter waits for the lobby lookup, then ⌘F narrows the same text.
    fireEvent.keyDown(field, { key: "Enter" });
    rerender(<SearchResults {...props} scopedChannelId="general" />);
    await act(async () => resolved());
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const hit = message(viewer, "general", "crew standup", 1700000001);
    while (wire.pending.length)
      await act(async () => wire.next().respond([hit]));
    expect(screen.getByRole("option", { name: /crew standup/ })).toBeVisible();
    expect(openConversation).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("returns keyboard focus to search when channel lookup retries, through repeated failure and recovery", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "other-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [other.pubkey]),
  ];
  let failures = 2;
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      // Only the public-channel page read fails; exact lookups still succeed.
      if (
        failures > 0 &&
        filters.some(
          (filter) => filter.kinds?.includes(39000) && !filter["#d"],
        ) &&
        !filters.some((filter) => filter.kinds?.includes(39002))
      ) {
        failures--;
        return Promise.reject(new Error("Relay read timed out"));
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await screen.findByRole("button", {
        name: "Retry channels",
      });
      retry.focus();
      fireEvent.click(retry);
      expect(
        screen.queryByRole("button", { name: "Retry channels" }),
      ).toBeNull();
      expect(input).toHaveFocus();
    }
    const lobby = await screen.findByRole("option", { name: /crew-lobby/ });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(lobby).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

function usageSession(
  names: readonly string[],
  publicNames: readonly string[] = [],
) {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    ...names.flatMap((name, index) => [
      metadata(relay, name, name, 1700000000 + index),
      roster(relay, name, [viewer.pubkey]),
    ]),
    ...publicNames.flatMap((name) => [
      metadata(relay, name, name, 1700000000, open),
      roster(relay, name, [other.pubkey]),
    ]),
  ];
  return createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
}

const usage = `wss://relay.example:${"a".repeat(64)}`;
const optionNames = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .getAllByRole("option")
    .map((option) => option.textContent?.split(/Conversation|Public/)[0]);

it("puts the earlier choice for typed text first, unless another name is exact", async () => {
  localStorage.clear();
  recordChoice(usage, "wo", "channel:team-work");
  const owner = usageSession(["work", "team-work", "workshop"]);
  const open = vi.fn();
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: open,
    usageScope: usage,
  };
  try {
    const { rerender } = render(<SearchResults {...props} query="wor" />);
    await waitFor(() =>
      expect(optionNames("Channels")).toEqual([
        "team-work",
        "work",
        "workshop",
      ]),
    );
    const combobox = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(open).toHaveBeenLastCalledWith("team-work");
    // Typing a channel's whole name opens that channel.
    rerender(<SearchResults {...props} query="work" />);
    expect(optionNames("Channels")).toEqual(["work", "team-work", "workshop"]);
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(open).toHaveBeenLastCalledWith("work");
    // Each choice is remembered for the text that led to it.
    const remembered = readSearchUsage(usage);
    const all = new Set(["channel:work", "channel:team-work"]);
    expect(remembered.pick("work", all)).toBe("channel:work");
    expect(remembered.pick("wor", all)).toBe("channel:team-work");
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("puts a remembered public channel first, even past eight joined matches", async () => {
  localStorage.clear();
  recordChoice(usage, "wo", "channel:team-work");
  const joined = Array.from({ length: 8 }, (_, n) => `work-${n + 1}`);
  const owner = usageSession(joined, ["team-work"]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wo"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[
          {
            key: "Workflows",
            label: "Workflows",
            icon: ChatCircleIcon,
            run() {},
          },
        ]}
        openNewMessage={() => {}}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    // The group leads because of the remembered row, so that row leads it.
    await waitFor(() => expect(optionNames("Channels")[0]).toBe("team-work"));
    expect(optionNames("Channels")).toHaveLength(5);
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label"))
        .slice(0, 2),
    ).toEqual(["Channels", "Pages"]);
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("lets frequent visits lift a match past a slightly better one, not a much better one", async () => {
  localStorage.clear();
  for (let visit = 0; visit < 20; visit++) {
    recordVisit(usage, "channel:the-lar");
    recordVisit(usage, "channel:xlarx");
  }
  const owner = usageSession(["xlarx", "the-lar", "lar-crew"]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="lar"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    // Word start beats prefix with usage; a busy substring match does not.
    await waitFor(() =>
      expect(optionNames("Channels")).toEqual(["the-lar", "lar-crew", "xlarx"]),
    );
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("keeps the remembered choice selected when a better match arrives late", async () => {
  localStorage.clear();
  recordChoice(usage, "wor", "Workflows");
  const owner = usageSession([], ["wor"]);
  const workflows = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wor"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[
          {
            key: "Workflows",
            label: "Workflows",
            icon: ChatCircleIcon,
            run: workflows,
          },
        ]}
        openNewMessage={() => {}}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    const page = screen.getByRole("option", { name: "Workflows" });
    expect(page).toHaveAttribute("aria-selected", "true");
    // Until the highlight is moved it follows the first row, so the person
    // confirms the remembered choice, here by moving onto it.
    const field = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(page).toHaveAttribute("aria-selected", "true");
    // The relay's exact public match arrives later, after the groups shown.
    await screen.findByRole("option", { name: /^wor/ });
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label"))
        .slice(0, 2),
    ).toEqual(["Pages", "Channels"]);
    expect(page).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(workflows).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("translates combined operators into a single server-ranked scoped read and opens the match", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        [
          metadata(relay, "crew", "crew"),
          roster(relay, "crew", [viewer.pubkey]),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#crew from:@alice after:2024-01-15 before:2024-02-01"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={open}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    // The exact open-channel lookup settles before the in: channel resolves.
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const users = wire.next();
    expect(users.filters).toEqual([
      { kinds: [0], search: "alice", search_mode: "prefix", limit: 40 },
    ]);
    await act(async () =>
      users.respond([profile(alice, { display_name: "Alice" })]),
    );
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        search: "deploy",
        search_mode: "prefix",
        limit: 20,
        "#h": ["crew"],
        authors: [alice.pubkey],
        since: Math.floor(new Date(2024, 0, 15).getTime() / 1000),
        until: Math.floor(new Date(2024, 1, 1).getTime() / 1000) - 1,
      },
    ]);
    const hit = message(alice, "crew", "deploy matched", 1700000001);
    await act(async () => request.respond([hit]));
    fireEvent.click(screen.getByRole("option", { name: /deploy matched/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("does not read messages for punctuation-only operands after normalization", async () => {
  const relay = keypair(),
    viewer = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: vi.fn(),
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: vi.fn(),
  };
  try {
    const view = render(<SearchResults {...props} query="in:#" />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
    expect(reads).toHaveLength(0);
    view.rerender(<SearchResults {...props} query="from:. " />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
    expect(reads).toHaveLength(0);
    view.rerender(<SearchResults {...props} query="in:# after:2024-01-15" />);
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0]).toEqual([
      expect.objectContaining({
        since: Math.floor(new Date(2024, 0, 15).getTime() / 1000),
      }),
    ]);
    expect(reads[0]?.[0]).not.toHaveProperty("search");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  "ask: summarize in:#rel",
  "ask: what did from:ali",
  "ask: plans before:tom",
])("keeps %s a question, opening no operator picker", async (query) => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query={query}
        onQueryChange={vi.fn()}
        input={createRef<HTMLInputElement>()}
        pages={[]}
        openNewMessage={vi.fn()}
        openConversation={vi.fn()}
        openAsk={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("group", { name: /^New chat with/ }),
    ).toBeInTheDocument();
    for (const picker of ["Channels", "People", "Dates"])
      expect(screen.queryByRole("group", { name: picker })).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

/** Message searches (not people or channel lookups) a session sends. */
const isMessageSearch = (filters: readonly Filter[]) =>
  filters.some(
    (filter) => filter.search !== undefined && !!filter.kinds?.includes(9),
  );

it("reads no message search until the last word has three characters", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const searches: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (isMessageSearch(filters as Filter[]))
        searches.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="ab" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toHaveLength(0);
    expect(
      screen.getByText("Type at least 3 characters to search messages."),
    ).toBeVisible();
    expect(
      screen.queryByText("No matching messages in accessible conversations."),
    ).toBeNull();

    // The relay prefix-matches the last word, so completed words before it
    // do not make a short one searchable.
    view.rerender(<SearchResults {...props} query="project pl" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toHaveLength(0);
    expect(
      screen.getByText(
        "Type at least 3 characters in the last word to search messages.",
      ),
    ).toBeVisible();

    view.rerender(<SearchResults {...props} query="project pla" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toEqual([
      [expect.objectContaining({ search: "project pla" })],
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a chosen Messages group, with its reason, while the text as typed isn't searchable", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    metadata(relay, "crit", "design-crit"),
    roster(relay, "crit", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      const search = filters.find(
        (filter) => filter.search !== undefined && filter.kinds?.includes(9),
      )?.search;
      if (search !== undefined)
        return Promise.resolve([
          message(viewer, "crew", `${search} notes`, 1700000500),
        ]);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
  const shown = () =>
    screen.getByRole("button", { pressed: true }).textContent ?? "";
  try {
    const view = render(<SearchResults {...props} query="design" />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Messages/ }));
    expect(screen.getByRole("option", { name: /design notes/ })).toBeVisible();

    // design-crit still matches, but messages aren't searched yet.
    view.rerender(<SearchResults {...props} query="design c" />);
    await settle();
    expect(shown()).toMatch(/^Messages/);
    expect(
      screen.getByText(
        "Type at least 3 characters in the last word to search messages.",
      ),
    ).toBeVisible();

    view.rerender(<SearchResults {...props} query="-design" />);
    await settle();
    expect(shown()).toMatch(/^Messages/);
    expect(
      screen.getByText(
        "Add a word or “phrase” to search for alongside -exclusions.",
      ),
    ).toBeVisible();

    view.rerender(<SearchResults {...props} query="design crit" />);
    await settle();
    expect(shown()).toMatch(/^Messages/);
    expect(
      screen.getByRole("option", { name: /design crit notes/ }),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("an in: operator does not lower the message search minimum", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const searches: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (isMessageSearch(filters as Filter[])) {
        searches.push(filters as Filter[]);
        return Promise.resolve([]);
      }
      return Promise.resolve(
        [
          metadata(relay, "crew", "crew"),
          roster(relay, "crew", [viewer.pubkey]),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="in:#crew ab" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toHaveLength(0);
    expect(
      screen.getByText("Type at least 3 characters to search messages."),
    ).toBeVisible();

    view.rerender(<SearchResults {...props} query="in:#crew abc" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toEqual([
      [
        {
          kinds: [40002, 40008, 9],
          search: "abc",
          search_mode: "prefix",
          limit: 20,
          "#h": ["crew"],
        },
      ],
    ]);
    expect(
      screen.queryByText("Type at least 3 characters to search messages."),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("looks up an author by name only from two characters", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const searchProfiles = vi.fn(async () => []);
  const props = {
    session: { ...owner.session, searchProfiles } as typeof owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="from:@a" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searchProfiles).not.toHaveBeenCalled();
    // No lookup ran, so the picker asks for more text rather than reporting none.
    expect(
      screen.getByText("Type at least 2 characters to search people."),
    ).toBeVisible();
    expect(screen.queryByText(/No matching people/)).toBeNull();
    view.rerender(<SearchResults {...props} query="from:@al" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searchProfiles).toHaveBeenCalledExactlyOnceWith(
      "al",
      expect.objectContaining({ limit: 40 }),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("asks for the connection, not more text, when a saved session's author picker finds no one", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const searchProfiles = vi.fn(async () => []);
  const props = {
    session: { ...owner.session, searchProfiles } as typeof owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
    offline: <p>Only saved conversations are searched.</p>,
  };
  try {
    const view = render(<SearchResults {...props} query="from:a" />);
    for (const query of ["from:a", "from:al"]) {
      view.rerender(<SearchResults {...props} query={query} />);
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      expect(
        screen.getByText("Connect to this community to search people."),
      ).toBeVisible();
      expect(screen.queryByText(/^Type at least/)).toBeNull();
      expect(screen.queryByText(/Try a longer name/)).toBeNull();
    }
    expect(searchProfiles).not.toHaveBeenCalled();
    // The offline notice sits below the results, outside their scrollport.
    expect(
      screen
        .getByText("Only saved conversations are searched.")
        .closest(".search-palette-scroll"),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("searches the people directory only from two characters", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const people = vi.fn(async () => ({ people: [], hasMore: false }));
  const props = {
    session: {
      ...owner.session,
      directMessages: { ...owner.session.directMessages, people },
    } as typeof owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="a" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(people).not.toHaveBeenCalled();
    view.rerender(<SearchResults {...props} query="al" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(people).toHaveBeenCalledExactlyOnceWith(
      "al",
      1,
      expect.any(AbortSignal),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["hex key", (pubkey: string) => pubkey],
  ["npub", (pubkey: string) => npubEncode(pubkey)],
  ["nostr: npub", (pubkey: string) => `nostr:${npubEncode(pubkey)}`],
])("lists the person a pasted %s names under People", async (_case, typed) => {
  const relay = keypair(),
    viewer = keypair(),
    sam = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  // The directory finds Sam by key; no name of his matches the text.
  const t = peopleSession(owner.session, [
    { pubkey: sam.pubkey, name: "Sam Rivera" },
  ]);
  try {
    render(
      <SearchResults
        session={t.session}
        query={typed(sam.pubkey)}
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const group = await screen.findByRole("group", { name: "People" });
    expect(within(group).getByRole("option")).toHaveTextContent("Sam Rivera");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("neither lists nor starts a DM with someone whose Delete started, without agent flags", async () => {
  const relay = keypair(),
    viewer = keypair(),
    sam = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const agents: { pubkey: string; name: string; managed: boolean }[] = [];
  // Sam's profile carries neither auth nor is_agent.
  const t = peopleSession(
    owner.session,
    [{ pubkey: sam.pubkey, name: "Sam Rivera" }],
    agents,
  );
  const props = {
    session: t.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="Sam" />);
    const group = await screen.findByRole("group", { name: "People" });
    const option = within(group).getByRole("option", { name: /Sam Rivera/ });
    // Listed before its Delete started; the action checks again.
    agents.push({
      pubkey: sam.pubkey,
      name: "Sam Rivera",
      managed: true,
      deleting: true,
    } as (typeof agents)[number]);
    fireEvent.click(option);
    expect(
      await screen.findByText(
        "This identity is archived or being deleted in this community.",
      ),
    ).toBeVisible();
    expect(t.open).not.toHaveBeenCalled();
    view.rerender(<SearchResults {...props} query="Sam R" />);
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /Sam Rivera/ })).toBeNull(),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("still looks up a one-character channel named by in:", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [metadata(relay, "x", "x", 1700000000, [["public", ""]])];
  const owner = createRelaySession({
    ...wire.transport,
    query: async (filters) =>
      discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      ),
  });
  const source = owner.session.channels.searchPublic;
  assert.exists(source);
  const searchPublic = vi.fn(source);
  try {
    render(
      <SearchResults
        session={{
          ...owner.session,
          channels: { ...owner.session.channels, searchPublic },
        }}
        query="in:#x"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await waitFor(() =>
      expect(searchPublic).toHaveBeenCalledWith(
        "x",
        expect.objectContaining({ exact: true }),
      ),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("runs operator-only date and author searches without a text predicate", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const channel = "crew";
  const before = message(alice, channel, "before the cutoff", 1700000001);
  const after = message(alice, channel, "after the cutoff", 1800000001);
  const discovery = [
    metadata(relay, channel, "Wes"),
    roster(relay, channel, [viewer.pubkey]),
  ];
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(alice, { display_name: "Alice" })]);
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        reads.push(filters as Filter[]);
        return Promise.resolve(
          [before, after].filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const mounted = render(
      <SearchResults
        {...props}
        query="before:2026-10-01"
        scopedChannelId={channel}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /before the cutoff/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /after the cutoff/ }),
    ).toBeNull();
    expect(reads.at(-1)).toEqual([
      expect.objectContaining({
        "#h": [channel],
        until: Math.floor(new Date(2026, 9, 1).getTime() / 1000) - 1,
      }),
    ]);
    expect(reads.at(-1)?.[0]).not.toHaveProperty("search");
    mounted.rerender(
      <SearchResults
        {...props}
        query="after:2026-10-01"
        scopedChannelId={channel}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /after the cutoff/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /before the cutoff/ }),
    ).toBeNull();
    mounted.rerender(<SearchResults {...props} query="from:alice " />);
    expect(
      await screen.findByRole("option", { name: /after the cutoff/ }),
    ).toBeVisible();
    expect(reads.at(-1)).toEqual([
      expect.objectContaining({ authors: [alice.pubkey] }),
    ]);
    expect(reads.at(-1)?.[0]).not.toHaveProperty("search");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["from:ba", "from:@ba"])(
  "%s opens the same prefix picker and never reads messages before identity selection",
  async (query) => {
    const relay = keypair(),
      viewer = keypair(),
      human = keypair();
    const reads: Filter[][] = [];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(9)))
          reads.push(filters as Filter[]);
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([profile(human, { display_name: "Baxen" })]);
        return Promise.resolve([]);
      },
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={change}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      const people = within(screen.getByRole("group", { name: "People" }));
      const choice = await people.findByRole("option", { name: /Baxen/ });
      expect(reads).toHaveLength(0);
      fireEvent.click(choice);
      expect(change).toHaveBeenCalledWith(`from:${human.pubkey} `);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("requests a bounded prefix page before declaring a short name absent", async () => {
  const relay = keypair(),
    viewer = keypair(),
    wes = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0))) {
        reads.push(filters as Filter[]);
        return Promise.resolve([profile(wes, { display_name: "Wes" })]);
      }
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:@we"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(await screen.findByRole("option", { name: /Wes/ })).toBeVisible();
    expect(reads).toContainEqual([
      { kinds: [0], search: "we", search_mode: "prefix", limit: 40 },
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["from:we"])(
  "%s retains a confirmed channel member when global prefix lookup fails",
  async (query) => {
    const relay = keypair(),
      viewer = keypair(),
      wes = keypair();
    const channel = "crew";
    const discovery = [
      metadata(relay, channel, "crew"),
      roster(relay, channel, [viewer.pubkey, wes.pubkey]),
    ];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.search === "we"))
          return Promise.reject(new Error("prefix lookup unavailable"));
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([profile(wes, { display_name: "Wes" })]);
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      },
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={change}
          scopedChannelId={channel}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      const choice = await within(
        screen.getByRole("group", { name: "People" }),
      ).findByRole("option", { name: /Wes/ });
      fireEvent.click(choice);
      expect(change).toHaveBeenCalledWith(`from:${wes.pubkey} `);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("distinguishes an unavailable global author lookup from no matching people", async () => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.search === "we"))
        return Promise.reject(new Error("prefix lookup unavailable"));
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:@we"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByText(
        "People search is unavailable. Try a longer name.",
      ),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("offers a bounded from:@ picker with distinct identities and selects an exact author", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(first, { display_name: "Baxen" }),
          profile(second, { display_name: "Baxen" }),
        ]);
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        reads.push(filters as Filter[]);
        return Promise.resolve([
          message(second, "crew", "chosen author", 1700000010),
        ]);
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const change = vi.fn();
  try {
    const mounted = render(
      <SearchResults
        session={owner.session}
        query="from:@baxen"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const people = within(screen.getByRole("group", { name: "People" }));
    expect(await people.findAllByRole("option")).toHaveLength(2);
    expect(reads).toHaveLength(0);
    mounted.rerender(
      <SearchResults
        session={owner.session}
        query="from:baxen"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const ambiguous = within(
      await screen.findByRole("group", { name: "People" }),
    );
    expect(await ambiguous.findAllByRole("option")).toHaveLength(2);
    expect(reads).toHaveLength(0);
    fireEvent.click(ambiguous.getAllByRole("option")[1] as HTMLElement);
    expect(change).toHaveBeenCalledWith(`from:${second.pubkey} `);
    mounted.rerender(
      <SearchResults
        session={owner.session}
        query={`from:${second.pubkey} `}
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /chosen author/ }),
    ).toBeVisible();
    expect(reads.at(-1)).toEqual([
      expect.objectContaining({ authors: [second.pubkey] }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(
  ["from:@", "from:", "in:@"].flatMap((operator) =>
    ["crew", undefined].flatMap((scope) =>
      ["username", "full-name"].map((preference) => ({
        operator,
        scope,
        preference,
      })),
    ),
  ),
)(
  "matches both verified names for $operator in $scope with $preference labels",
  async ({ operator, scope, preference }) => {
    const previousPreference = namePreference();
    setNamePreference(preference as "username" | "full-name");
    const label = preference === "full-name" ? "Robin Example" : "robinz";
    const relay = keypair(),
      viewer = keypair(),
      person = keypair();
    const raw = profile(person, {
      name: "public-handle",
      display_name: "Robin",
    });
    const verified = eventDto(
      signed(relay, {
        kind: 30382,
        content: "",
        tags: [
          ["d", person.pubkey],
          ["p", person.pubkey],
          ["active", "true"],
          ["display_name", "robinz"],
          ["username", "robinz"],
          ["full_name", "Robin Example"],
          ["issuer_label", "Example"],
          ["verified_at", "1700000000"],
        ],
      }),
    );
    const discovery = [
      metadata(relay, "crew", "crew"),
      roster(relay, "crew", [viewer.pubkey, person.pubkey]),
      raw,
      verified,
    ];
    const searches: string[] = [];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      verifiedProfiles: {
        pubkey: relay.pubkey,
        multipleIssuers: false,
        searchable: true,
      },
      async query(filters) {
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
      async searchProfiles(query) {
        searches.push(query);
        // The endpoint can find a person by a verified head alone.
        return query === "example" ? [verified] : [raw, verified];
      },
      subscribe(callbacks) {
        callbacks.state({ status: "connected", routes: [] });
        return {
          update() {},
          retry() {},
          dispose() {},
          syncVerifiedProfiles(_filter, sink) {
            sink.event(eventDto(verified));
            sink.eose();
            return () => {};
          },
        };
      },
    });
    function Search() {
      const [query, setQuery] = useState(`${operator}robin`);
      return (
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={setQuery}
          input={createRef()}
          pages={[]}
          scopedChannelId={scope}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />
      );
    }
    try {
      render(<Search />);
      const input = screen.getByRole("combobox");
      expect(
        await screen.findByRole("option", { name: new RegExp(label) }),
      ).toBeVisible();
      fireEvent.change(input, { target: { value: `${operator}robinz` } });
      expect(
        await screen.findByRole("option", { name: new RegExp(label) }),
      ).toBeVisible();
      await waitFor(() => expect(searches).toEqual(["robin", "robinz"]));
      for (const alias of ["example", "public"]) {
        fireEvent.change(input, { target: { value: `${operator}${alias}` } });
        expect(
          await screen.findByRole("option", { name: new RegExp(label) }),
        ).toBeVisible();
      }
      fireEvent.click(screen.getByRole("option", { name: new RegExp(label) }));
      const chip = screen.getByRole("button", {
        name: `Remove ${operator.startsWith("in:") ? "conversation with" : "author"} ${label}`,
      });
      await expectHint(chip, npubEncode(person.pubkey));
      expect(chip).toHaveTextContent(
        `${operator.startsWith("in:") ? "in" : "from"}:@${label}`,
      );
      expect(input).toHaveValue("");
    } finally {
      cleanup();
      owner.dispose();
      setNamePreference(previousPreference);
    }
  },
);

function verifiedAuthorSession({
  namesakeName,
  pageOnly = false,
  namingPolicy = false,
  profileName = "Robin",
  verification,
  searchEmpty = false,
  extraMembers = 0,
  earlyHead = false,
  refuseVerification,
  messageCount = 1,
  searchableNames = true,
}: {
  namesakeName?: string;
  pageOnly?: boolean;
  namingPolicy?: boolean;
  profileName?: string | null;
  verification?: Promise<void>;
  searchEmpty?: boolean;
  extraMembers?: number;
  earlyHead?: boolean;
  refuseVerification?: "before-eose" | "after-eose";
  messageCount?: number;
  searchableNames?: boolean;
} = {}) {
  const relay = keypair(),
    viewer = keypair(),
    person = keypair(),
    namesake = keypair();
  const raw =
    profileName === null ? undefined : profile(person, { name: profileName });
  const head = eventDto(
    signed(relay, {
      kind: 30382,
      content: "",
      tags: [
        ["d", person.pubkey],
        ["p", person.pubkey],
        ["active", "true"],
        ["display_name", "robinz"],
        ["username", "robinz"],
        ["full_name", "Robinexample"],
        ["issuer_label", "Example"],
        ["verified_at", "1700000000"],
      ],
    }),
  );
  const publicProfiles = [
    ...(raw ? [raw] : []),
    ...(namesakeName ? [profile(namesake, { name: namesakeName })] : []),
  ];
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [
      viewer.pubkey,
      ...Array.from({ length: extraMembers }, () => keypair().pubkey),
      person.pubkey,
      ...(namesakeName ? [namesake.pubkey] : []),
    ]),
    ...publicProfiles,
    head,
    ...Array.from({ length: messageCount }, (_, index) =>
      message(person, "crew", `deploy the engine ${index}`, 1700000500 + index),
    ),
  ];
  const reads: Filter[] = [];
  const verificationReads: Filter[] = [];
  const verifiedSubscriptions: VerifiedProfileSink[] = [];
  let deliverHead = () => {};
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      verifiedProfiles: {
        pubkey: relay.pubkey,
        multipleIssuers: false,
        ...(searchableNames ? { searchable: true as const } : {}),
      },
      async query(filters) {
        const verifying = filters.filter((filter) =>
          filter.kinds?.includes(30382),
        );
        verificationReads.push(...(verifying as Filter[]));
        if (verifying.length) await verification;
        reads.push(
          ...(filters.filter((filter) =>
            filter.kinds?.includes(9),
          ) as Filter[]),
        );
        const found = discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
        const messages = filters.find((filter) => filter.kinds?.includes(9));
        const offset = ((messages?.page ?? 1) - 1) * (messages?.limit ?? 20);
        return messages
          ? found.slice(offset, offset + (messages.limit ?? 20))
          : found;
      },
      async searchProfiles() {
        return searchEmpty
          ? []
          : [...publicProfiles, ...(searchableNames ? [head] : [])];
      },
      subscribe(callbacks) {
        callbacks.state({ status: "connected", routes: [] });
        return {
          update() {},
          retry() {},
          dispose() {},
          syncVerifiedProfiles(_filter, sink) {
            let active = true;
            verifiedSubscriptions.push(sink);
            if (refuseVerification) {
              queueMicrotask(() => {
                if (!active) return;
                if (refuseVerification === "after-eose") sink.eose();
                sink.closed("error: relay refused verification");
              });
              return () => {
                active = false;
              };
            }
            deliverHead = () => {
              if (active) sink.event(head);
            };
            const deliver = () => {
              if (!active) return;
              if (!pageOnly && !earlyHead) sink.event(head);
              sink.eose();
            };
            if (verification) void verification.then(deliver, () => {});
            else deliver();
            return () => {
              active = false;
            };
          },
        };
      },
    },
    namingPolicy
      ? {
          identityNames: {
            bind: (source) =>
              bindNames(source, {
                snapshot: () => [createAgentDirectory()],
                subscribe: () => () => {},
              }),
            register() {},
          },
        }
      : {},
  );
  return {
    owner,
    relay,
    head,
    person,
    reads,
    verificationReads,
    verifiedSubscriptions,
    deliverHead: () => deliverHead(),
  };
}

it.each(["crew", undefined])(
  "preserves author results and pagination in %s when an unrelated head arrives",
  async (scope) => {
    const {
      owner,
      person,
      relay,
      head,
      reads,
      verificationReads,
      verifiedSubscriptions,
    } = verifiedAuthorSession({ messageCount: 21 });
    try {
      owner.session.channels.ensureList();
      await waitFor(() =>
        expect(owner.session.channels.get?.("crew")?.members).toContain(
          person.pubkey,
        ),
      );
      await act(async () =>
        owner.session.profiles.ensure(
          owner.session.channels.get?.("crew")?.members ?? [],
        ),
      );
      await waitFor(() =>
        expect(owner.session.profiles.verifiedHeld?.(person.pubkey)).toBe(true),
      );
      const { result } = renderHook(() =>
        useSearchMessages(owner.session, "from:robinz deploy", scope),
      );
      await waitFor(() => expect(result.current.messages).toHaveLength(20));
      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.messages).toHaveLength(21));
      expect(reads).toHaveLength(2);
      const counts = [reads.length, verificationReads.length];
      const stranger = keypair();
      await act(async () => owner.session.profiles.ensure([stranger.pubkey]));
      const sink = verifiedSubscriptions.at(-1);
      assert(sink);
      const revision = owner.session.profiles.verifiedRevision?.() ?? 0;
      vi.useFakeTimers();
      await act(async () => {
        sink.event(
          eventDto(
            signed(relay, {
              kind: 30382,
              content: head.content,
              tags: head.tags.map((tag) =>
                tag[0] === "d" || tag[0] === "p"
                  ? [tag[0], stranger.pubkey]
                  : tag,
              ),
            }),
          ),
        );
        sink.eose();
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(owner.session.profiles.verifiedRevision?.()).toBeGreaterThan(
        revision,
      );
      expect(result.current.loading).toBe(false);
      expect(result.current.messages).toHaveLength(21);
      for (let cycle = 0; cycle < 3; cycle++)
        await act(async () =>
          vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1),
        );
      expect([reads.length, verificationReads.length]).toEqual(counts);
      expect(result.current.messages).toHaveLength(21);
      // A changed head for the consulted author must still invalidate its name.
      await act(async () => {
        for (const memberSink of verifiedSubscriptions)
          memberSink.event(
            eventDto(
              signed(relay, {
                kind: 30382,
                created_at: head.created_at + 1,
                content: "",
                tags: head.tags.map((tag) =>
                  tag[0] === "active" ? ["active", "false"] : tag,
                ),
              }),
            ),
          );
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.loading).toBe(true);
      for (let cycle = 0; cycle < 3; cycle++)
        await act(async () =>
          vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1),
        );
      expect(result.current.loading).toBe(false);
      expect(result.current.messages).toEqual([]);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("fails closed when remote author verification is unavailable", async () => {
  const gate = authorVerificationGate();
  const { owner, reads, verificationReads } = verifiedAuthorSession({
    namesakeName: "robinz",
    pageOnly: true,
    searchableNames: false,
    verification: gate.promise,
  });
  try {
    const { result } = renderHook(() =>
      useSearchMessages(owner.session, "from:robinz deploy"),
    );
    await waitFor(() => expect(verificationReads.length).toBeGreaterThan(0));
    await act(async () => gate.reject(new Error("Verification unavailable")));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("Verification unavailable");
    expect(reads).toEqual([]);
  } finally {
    gate.resolve();
    cleanup();
    owner.dispose();
  }
});

it.each(
  (["before-eose", "after-eose"] as const).flatMap((refuseVerification) =>
    [true, false].map((kind0) => ({ refuseVerification, kind0 })),
  ),
)(
  "offers a scoped verified namesake absent from profile search with kind 0 $kind0 when live sync refuses $refuseVerification",
  async ({ refuseVerification, kind0 }) => {
    const { owner, person, reads } = verifiedAuthorSession({
      pageOnly: true,
      searchEmpty: true,
      namesakeName: "robinz",
      refuseVerification,
      profileName: kind0 ? "Robin" : null,
      searchableNames: false,
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query="from:robinz deploy"
          scopedChannelId="crew"
          onQueryChange={change}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      await waitFor(() =>
        expect(
          within(screen.getByRole("group", { name: "People" })).getAllByRole(
            "option",
          ),
        ).toHaveLength(2),
      );
      expect(reads).toEqual([]);
      fireEvent.click(
        screen.getByRole("option", {
          name: new RegExp(person.pubkey.slice(0, 12)),
        }),
      );
      expect(change).toHaveBeenCalledWith(`from:${person.pubkey} deploy`);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

function authorVerificationGate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it.each(["before-eose", "after-eose"] as const)(
  "keeps scoped author results stable when live verification is repeatedly refused %s",
  async (refuseVerification) => {
    const { owner, person, reads, verificationReads, verifiedSubscriptions } =
      verifiedAuthorSession({ refuseVerification });
    // The preview reads the hit's neighbors; count message searches alone.
    const searches = () => reads.filter((read) => read.search !== undefined);
    try {
      owner.session.channels.ensureList();
      await waitFor(() =>
        expect(owner.session.channels.get?.("crew")?.members).toContain(
          person.pubkey,
        ),
      );
      await act(async () =>
        owner.session.profiles.ensure(
          owner.session.channels.get?.("crew")?.members ?? [],
        ),
      );
      const beforeSearch = verifiedSubscriptions.length;
      vi.useFakeTimers();
      render(
        <SearchResults
          session={owner.session}
          query="from:robinz deploy"
          scopedChannelId="crew"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      // Let every refusal and debounce finish without changing the query.
      for (let cycle = 0; cycle < 6; cycle++)
        await act(async () =>
          vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1),
        );
      // Query resolution, first-message byline enrichment and the preview's
      // bylines each ensure once.
      expect(verifiedSubscriptions.length).toBeLessThanOrEqual(
        beforeSearch + 3,
      );
      expect(verificationReads).toHaveLength(1);
      expect(searches()).toHaveLength(1);
      expect(searches()).toContainEqual(
        expect.objectContaining({ authors: [person.pubkey], search: "deploy" }),
      );
      const counts = [
        verifiedSubscriptions.length,
        verificationReads.length,
        searches().length,
      ];
      const result = screen.getByRole("option", { name: /deploy the engine/ });
      for (let cycle = 0; cycle < 4; cycle++)
        await act(async () =>
          vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1),
        );
      expect([
        verifiedSubscriptions.length,
        verificationReads.length,
        searches().length,
      ]).toEqual(counts);
      expect(result).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Retry messages" }),
      ).toBeNull();
      // A new explicit demand may retry, without restarting the settled query.
      const beforeRetry = verifiedSubscriptions.length;
      await act(async () => owner.session.profiles.ensure([person.pubkey]));
      for (let cycle = 0; cycle < 3; cycle++)
        await act(async () =>
          vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1),
        );
      expect(verifiedSubscriptions).toHaveLength(beforeRetry + 1);
      expect([verificationReads.length, searches().length]).toEqual(
        counts.slice(1),
      );
      expect(result).toBeVisible();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it.each([
  { namesake: false, extraMembers: 0, earlyHead: false },
  { namesake: true, extraMembers: 0, earlyHead: false },
  { namesake: true, extraMembers: 128, earlyHead: false },
  { namesake: true, extraMembers: 0, earlyHead: true },
])(
  "waits for scoped verification with namesake $namesake, $extraMembers extra members and early head $earlyHead",
  async ({ namesake, extraMembers, earlyHead }) => {
    const gate = authorVerificationGate();
    const { owner, person, reads, verificationReads, deliverHead } =
      verifiedAuthorSession({
        ...(namesake ? { namesakeName: "robinz" } : {}),
        verification: gate.promise,
        extraMembers,
        pageOnly: extraMembers > 0,
        earlyHead,
      });
    const change = vi.fn();
    try {
      owner.session.channels.ensureList();
      await waitFor(() =>
        expect(owner.session.channels.get?.("crew")?.members).toContain(
          person.pubkey,
        ),
      );
      await act(async () => {
        await owner.session.profiles.ensure(
          owner.session.channels.get?.("crew")?.members ?? [],
        );
      });
      if (earlyHead) {
        await act(async () => deliverHead());
        expect(owner.session.profiles.verifiedHeld?.(person.pubkey)).toBe(
          false,
        );
        expect(
          owner.session.profiles.snapshot().get(person.pubkey)?.verified,
        ).toBeUndefined();
      }
      render(
        <SearchResults
          session={owner.session}
          query="from:@robinz deploy"
          scopedChannelId="crew"
          onQueryChange={change}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      await waitFor(() => expect(verificationReads.length).toBeGreaterThan(0));
      expect(reads).toEqual([]);
      await act(async () => {
        gate.resolve();
      });
      if (namesake) {
        await waitFor(() =>
          expect(
            within(screen.getByRole("group", { name: "People" })).getAllByRole(
              "option",
            ),
          ).toHaveLength(2),
        );
        expect(reads).toEqual([]);
        fireEvent.click(
          screen.getByRole("option", {
            name: new RegExp(person.pubkey.slice(0, 12)),
          }),
        );
        expect(change).toHaveBeenCalledWith(`from:${person.pubkey} deploy`);
      } else {
        await waitFor(() =>
          expect(reads).toContainEqual(
            expect.objectContaining({
              authors: [person.pubkey],
              search: "deploy",
            }),
          ),
        );
      }
      expect(
        verificationReads.every((filter) => (filter["#d"]?.length ?? 0) <= 128),
      ).toBe(true);
    } finally {
      gate.resolve();
      cleanup();
      owner.dispose();
    }
  },
);

it.each(["cancel", "fail"])(
  "does not search an unverified namesake when scoped verification must %s",
  async (outcome) => {
    const gate = authorVerificationGate();
    const { owner, person, reads, verificationReads } = verifiedAuthorSession({
      namesakeName: "robinz",
      verification: gate.promise,
    });
    const props = {
      session: owner.session,
      scopedChannelId: "crew",
      onQueryChange() {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      openNewMessage() {},
      openConversation() {},
    };
    try {
      owner.session.channels.ensureList();
      await waitFor(() =>
        expect(owner.session.channels.get?.("crew")?.members).toContain(
          person.pubkey,
        ),
      );
      const mounted = render(
        <SearchResults {...props} query="from:robinz deploy" />,
      );
      await waitFor(() => expect(verificationReads.length).toBeGreaterThan(0));
      expect(reads).toEqual([]);
      if (outcome === "fail") {
        await act(async () =>
          gate.reject(new Error("Verification unavailable")),
        );
        await screen.findByRole("button", { name: "Retry messages" });
        expect(reads).toEqual([]);
      }
      // Exact-key selection is independent of a failed or cancelled name lookup.
      mounted.rerender(
        <SearchResults {...props} query={`from:${person.pubkey} ship`} />,
      );
      await waitFor(() =>
        expect(reads).toContainEqual(
          expect.objectContaining({
            authors: [person.pubkey],
            search: "ship",
          }),
        ),
      );
      if (outcome === "cancel") {
        await act(async () => gate.resolve());
        await waitFor(() =>
          expect(
            owner.session.profiles.snapshot().get(person.pubkey)?.verified
              ?.username,
          ).toBe("robinz"),
        );
      }
      expect(reads.every((filter) => filter.search === "ship")).toBe(true);
    } finally {
      gate.resolve();
      cleanup();
      owner.dispose();
    }
  },
);

it("offers every scoped alias match when completion is ambiguous", async () => {
  const { owner, person, reads } = verifiedAuthorSession({
    profileName: "alice",
    namesakeName: "alice",
    namingPolicy: true,
    searchEmpty: true,
  });
  const change = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:alice deploy"
        scopedChannelId="crew"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "People" })).getAllByRole(
          "option",
        ),
      ).toHaveLength(2),
    );
    expect(reads).toEqual([]);
    fireEvent.click(
      screen.getByRole("option", {
        name: new RegExp(person.pubkey.slice(0, 12)),
      }),
    );
    expect(change).toHaveBeenCalledWith(`from:${person.pubkey} deploy`);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(
  [false, true].flatMap((namingPolicy) =>
    ["username", "full-name"].map((preference) => ({
      namingPolicy,
      preference,
    })),
  ),
)(
  "prefers page-only verified labels over cached kind 0 with policy $namingPolicy and $preference",
  async ({ namingPolicy, preference }) => {
    const previous = namePreference();
    setNamePreference(preference as "username" | "full-name");
    const { owner, person } = verifiedAuthorSession({
      pageOnly: true,
      namingPolicy,
    });
    const label = preference === "full-name" ? "Robinexample" : "robinz";
    const change = vi.fn();
    function Search() {
      const [query, setQuery] = useState("from:@robinz");
      return (
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={(value) => {
            change(value);
            setQuery(value);
          }}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />
      );
    }
    try {
      await act(async () => owner.session.profiles.ensure([person.pubkey]));
      expect(
        owner.session.profiles.snapshot().get(person.pubkey),
      ).toMatchObject({ name: "Robin" });
      expect(
        owner.session.profiles.snapshot().get(person.pubkey)?.verified,
      ).toBeUndefined();
      render(<Search />);
      const row = await screen.findByRole("option", {
        name: new RegExp(`^${label}`),
      });
      fireEvent.click(row);
      expect(change).toHaveBeenCalledWith(`from:${person.pubkey} `);
      expect(
        screen.getByRole("button", { name: `Remove author ${label}` }),
      ).toHaveTextContent(`from:@${label}`);
      expect(
        owner.session.profiles.snapshot().get(person.pubkey)?.verified,
      ).toBeUndefined();
    } finally {
      cleanup();
      owner.dispose();
      setNamePreference(previous);
    }
  },
);

it.each(
  ["crew", undefined].flatMap((scope) =>
    ["username", "full-name"].flatMap((preference) =>
      ["robinz", "Robinexample"].flatMap((alias) =>
        [false, true].map((namesake) => ({
          scope,
          preference,
          alias,
          namesake,
        })),
      ),
    ),
  ),
)(
  "completes verified alias $alias in $scope with $preference and namesake $namesake",
  async ({ scope, preference, alias, namesake }) => {
    // A controlled clock: the namesake lands after up to three chained search
    // debounces, which in real time sits at a wait's one-second default.
    vi.useFakeTimers();
    const settle = async () => {
      for (let step = 0; step < 3; step += 1)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        });
    };
    const previous = namePreference();
    setNamePreference(preference as "username" | "full-name");
    const { owner, person, reads } = verifiedAuthorSession(
      namesake ? { namesakeName: alias } : {},
    );
    const change = vi.fn();
    const props = {
      session: owner.session,
      onQueryChange: change,
      input: createRef<HTMLInputElement>(),
      pages: [],
      scopedChannelId: scope,
      openNewMessage() {},
      openConversation() {},
    };
    try {
      // Username cases exercise the picker→space transition. Full-name cases
      // start from a pasted completed query, with no earlier page lookup.
      const completed = `from:@${alias} deploy`;
      const mounted = render(
        <SearchResults
          {...props}
          query={alias === "robinz" ? `from:@${alias}` : completed}
        />,
      );
      await settle();
      if (alias === "robinz") {
        screen.getByRole("option", {
          name: new RegExp(person.pubkey.slice(0, 12)),
        });
        mounted.rerender(<SearchResults {...props} query={completed} />);
        await settle();
      }
      if (namesake) {
        expect(
          within(screen.getByRole("group", { name: "People" })).getAllByRole(
            "option",
          ),
        ).toHaveLength(2);
        expect(reads).toEqual([]);
        fireEvent.click(
          screen.getByRole("option", {
            name: new RegExp(person.pubkey.slice(0, 12)),
          }),
        );
        expect(change).toHaveBeenCalledWith(`from:${person.pubkey} deploy`);
      } else {
        expect(reads).toContainEqual(
          expect.objectContaining({
            authors: [person.pubkey],
            search: "deploy",
          }),
        );
      }
    } finally {
      cleanup();
      owner.dispose();
      setNamePreference(previous);
    }
  },
);

it("ignores a superseded author-name lookup after the full username settles", async () => {
  const relay = keypair(),
    viewer = keypair(),
    person = keypair();
  const raw = profile(person, { name: "Robin" });
  const requests: {
    signal: AbortSignal | undefined;
    resolve: (events: RelayEvent[]) => void;
  }[] = [];
  const verification = (name: string) =>
    eventDto(
      signed(relay, {
        kind: 30382,
        content: "",
        tags: [
          ["d", person.pubkey],
          ["p", person.pubkey],
          ["active", "true"],
          ["display_name", name],
          ["username", name],
          ["issuer_label", "Example"],
          ["verified_at", "1700000000"],
        ],
      }),
    );
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false },
    query(filters, signal) {
      if (filters.some((filter) => filter.kinds?.includes(30382)))
        return new Promise((resolve) => requests.push({ signal, resolve }));
      return Promise.resolve([]);
    },
    async searchProfiles() {
      return [raw];
    },
  });
  const change = vi.fn();
  const props = {
    session: owner.session,
    onQueryChange: change,
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage() {},
    openConversation() {},
  };
  try {
    const mounted = render(<SearchResults {...props} query="from:@robin" />);
    await screen.findByRole("option", { name: /Robin/ });
    await waitFor(() => expect(requests).toHaveLength(1));
    mounted.rerender(<SearchResults {...props} query="from:@robinz" />);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.signal?.aborted).toBe(true);
    await act(async () => requests[1]?.resolve([verification("robinz")]));
    const row = await screen.findByRole("option", { name: /robinz/ });
    // The transport ignores cancellation and finishes the obsolete read last.
    await act(async () => requests[0]?.resolve([verification("robinold")]));
    expect(row).toHaveTextContent("robinz");
    expect(screen.queryByRole("option", { name: /robinold/ })).toBeNull();
    fireEvent.click(row);
    expect(change).toHaveBeenCalledWith(`from:${person.pubkey} `);
  } finally {
    for (const request of requests) request.resolve([]);
    cleanup();
    owner.dispose();
  }
});

it("finds and resolves authors by name words, sending the relay the typed accents", async () => {
  const relay = keypair(),
    viewer = keypair(),
    zoe = keypair(),
    other = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const reads: Filter[][] = [];
  const searches: string[] = [];
  const people = [
    profile(zoe, { display_name: "Zoë" }),
    profile(other, { display_name: "Mary Zoë" }),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      const search = filters.find((filter) => filter.kinds?.includes(0))
        ?.search as string | undefined;
      if (search !== undefined) {
        searches.push(search);
        // Like the relay's `simple` text index: lowercase word prefixes,
        // with no accent folding.
        return Promise.resolve(
          people.filter((event) =>
            String(JSON.parse(event.content).display_name)
              .toLowerCase()
              .split(/[^\p{L}\p{N}]+/u)
              .some((word) => word.startsWith(search)),
          ),
        );
      }
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        reads.push(filters as Filter[]);
        return Promise.resolve([]);
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const mounted = render(<SearchResults {...props} query="from:@Zoë" />);
    const group = within(screen.getByRole("group", { name: "People" }));
    // The exact name first, then a later word that matches.
    await waitFor(() =>
      expect(
        group.getAllByRole("option").map((option) => option.textContent),
      ).toEqual([
        expect.stringContaining("Zoë"),
        expect.stringContaining("Mary Zoë"),
      ]),
    );
    mounted.rerender(<SearchResults {...props} query="from:Zoë " />);
    await waitFor(() =>
      expect(reads.at(-1)).toEqual([
        expect.objectContaining({ authors: [zoe.pubkey] }),
      ]),
    );
    // Folding is local only; the relay sees what the user typed.
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((search) => search === "zoë")).toBe(true);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("prioritizes people, separates agents, shows profile avatars, and excludes archived identities", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair(),
    agent = keypair(),
    archived = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(agent, {
            display_name: "Algo Agent",
            is_agent: true,
            picture: "https://example.com/agent.png",
          }),
          profile(archived, { display_name: "Archived", is_agent: true }),
          profile(human, {
            display_name: "Alice",
            picture: "https://example.com/human.png",
          }),
        ]);
      return Promise.resolve([]);
    },
  });
  const known = { status: "ready" as const, archived: [archived.pubkey] };
  const session = {
    ...owner.session,
    archives: {
      ...owner.session.archives,
      state: (key: string) =>
        key === archived.pubkey ? ("archived" as const) : ("active" as const),
      snapshot: () => known,
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="from:@al"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const people = within(screen.getByRole("group", { name: "People" }));
    const person = await people.findByRole("option", { name: /Alice/ });
    expect(person).toBeVisible();
    expect(
      person.querySelector('img[src="https://example.com/human.png"]'),
    ).not.toBeNull();
    const agents = within(screen.getByRole("group", { name: "Agents" }));
    const choice = await agents.findByRole("option", { name: /Agent/ });
    expect(choice).toBeVisible();
    expect(
      choice.querySelector('img[src="https://example.com/agent.png"]'),
    ).not.toBeNull();
    expect(agents.queryByRole("option", { name: /Archived/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Archived/ })).toBeNull();
    expect(
      [...document.querySelectorAll('[role="option"]')].indexOf(person),
    ).toBeLessThan(
      [...document.querySelectorAll('[role="option"]')].indexOf(choice),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens the identity picker for bare from: without an unfiltered message read", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(human, { display_name: "Alice" })]);
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(screen.getByRole("group", { name: "People" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Messages" })).toBeNull();
    expect(reads).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  "from:baxen deploy",
  "from:@baxen ",
  "deploy from:baxen after:2024-01-15",
])(
  "resolves a completed ambiguous %s without losing surrounding query text",
  async (query) => {
    const relay = keypair(),
      viewer = keypair(),
      first = keypair(),
      second = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([
            profile(first, { display_name: "Baxen" }),
            profile(second, { display_name: "Baxen" }),
          ]);
        return Promise.resolve([]);
      },
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={change}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />,
      );
      const people = within(
        await screen.findByRole("group", { name: "People" }),
      );
      expect(await people.findAllByRole("option")).toHaveLength(2);
      fireEvent.click(people.getAllByRole("option")[1] as HTMLElement);
      expect(change).toHaveBeenCalledWith(
        `from:${second.pubkey} ${query.replace(/from:@?baxen\s*/i, "")}`,
      );
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

// A full first page can hide an exact namesake past the cap.
const alexSession = (
  exact: ReturnType<typeof keypair>,
  page: readonly ReturnType<typeof profile>[],
) => {
  const relay = keypair(),
    viewer = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(exact, { display_name: "Alex" }),
          ...page,
        ]);
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  return { owner, reads };
};
const alexandras = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    profile(keypair(), { display_name: `Alexandra ${index}` }),
  );

it.each([
  ["a full prefix page", () => alexandras(39), 12],
  ["exact namesakes", () => [profile(keypair(), { display_name: "Alex" })], 2],
])(
  "asks which author a completed from: name means with %s",
  async (_, page, shown) => {
    const exact = keypair();
    const { owner, reads } = alexSession(exact, page());
    const change = vi.fn();
    const props = {
      session: owner.session,
      onQueryChange: change,
      input: createRef<HTMLInputElement>(),
      pages: [],
      openNewMessage: () => {},
      openConversation: () => {},
    };
    try {
      const mounted = render(<SearchResults {...props} query="from:Alex " />);
      const people = within(
        await screen.findByRole("group", { name: "People" }),
      );
      expect(await people.findAllByRole("option")).toHaveLength(shown);
      // The picker follows the resolver's completed lookup.
      expect(reads).toEqual([]);
      fireEvent.click(
        people.getByRole("option", {
          name: new RegExp(exact.pubkey.slice(0, 12)),
        }),
      );
      expect(change).toHaveBeenCalledWith(`from:${exact.pubkey} `);
      mounted.rerender(
        <SearchResults {...props} query={`from:${exact.pubkey} `} />,
      );
      await waitFor(() =>
        expect(reads.at(-1)).toEqual([
          expect.objectContaining({ authors: [exact.pubkey] }),
        ]),
      );
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("resolves one exact from: name in a partial prefix page", async () => {
  const exact = keypair();
  const { owner, reads } = alexSession(exact, alexandras(38));
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:Alex "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await waitFor(() =>
      expect(reads.at(-1)).toEqual([
        expect.objectContaining({ authors: [exact.pubkey] }),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["resolves it", false],
  ["reports a profile namesake as ambiguous", true],
])("completing an agent's own name with Space %s", async (_, namesake) => {
  const relay = keypair(),
    viewer = keypair(),
    agent = keypair(),
    human = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(agent, { display_name: "Legacy Bee" }),
          ...(namesake ? [profile(human, { display_name: "Jose" })] : []),
        ]);
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  const source = owner.session.agentChoices;
  const choices = {
    ...source.snapshot(),
    identities: [{ pubkey: agent.pubkey, name: "José", managed: true }],
    selectable: [{ pubkey: agent.pubkey, name: "José", managed: true }],
  };
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  const props = {
    session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const mounted = render(<SearchResults {...props} query="from:jose" />);
    // The picker offers the agent by its own name.
    expect(
      await within(
        await screen.findByRole("group", { name: "Agents" }),
      ).findByRole("option"),
    ).toBeVisible();
    mounted.rerender(<SearchResults {...props} query="from:jose " />);
    if (!namesake) {
      await waitFor(() =>
        expect(reads.at(-1)).toEqual([
          expect.objectContaining({ authors: [agent.pubkey] }),
        ]),
      );
    } else {
      // Both keys are offered; neither is searched silently.
      await waitFor(() =>
        expect(
          within(screen.getByRole("group", { name: "People" })).getAllByRole(
            "option",
          ),
        ).toHaveLength(1),
      );
      expect(
        within(screen.getByRole("group", { name: "Agents" })).getAllByRole(
          "option",
        ),
      ).toHaveLength(1);
      expect(reads).toEqual([]);
    }
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("adds a late shared agent without another keystroke or prefix read", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    agent = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query() {
      return [];
    },
  });
  const reads = vi.fn(async () => []);
  const source = owner.session.agentChoices;
  const listeners = new Set<() => void>();
  let choices = source.snapshot();
  const session = {
    ...owner.session,
    read: reads,
    searchProfiles: reads,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="from:late"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: "Agents" })).toBeNull();
    act(() => {
      choices = {
        ...choices,
        identities: [
          { pubkey: agent.pubkey, name: "Late Agent", managed: false },
        ],
        selectable: [
          { pubkey: agent.pubkey, name: "Late Agent", managed: false },
        ],
      };
      for (const listener of listeners) listener();
    });
    expect(
      within(screen.getByRole("group", { name: "Agents" })).getByRole(
        "option",
        { name: /Late Agent/ },
      ),
    ).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["from:alice", "from:bob", ""],
  [
    "deploy in:crew after:2026-10-01 from:alice",
    "deploy in:crew after:2026-10-01 from:bob",
    "deploy in:crew after:2026-10-01 ",
  ],
])(
  "replaces author chip in %s without leaking or restoring its filter",
  async (initial, typed, remaining) => {
    const relay = keypair(),
      viewer = keypair(),
      alice = keypair(),
      bob = keypair();
    const reads: Filter[][] = [];
    const changes: string[] = [];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([
            profile(alice, { display_name: "Alice" }),
            profile(bob, { display_name: "Bob" }),
          ]);
        if (filters.some((filter) => filter.kinds?.includes(9)))
          reads.push(filters as Filter[]);
        return Promise.resolve(
          [
            metadata(relay, "crew", "crew"),
            roster(relay, "crew", [viewer.pubkey]),
          ].filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      },
    });
    function Search() {
      const [query, setQuery] = useState(initial);
      return (
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={(next) => {
            changes.push(next);
            setQuery(next);
          }}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />
      );
    }
    try {
      render(<Search />);
      fireEvent.click(
        await within(screen.getByRole("group", { name: "People" })).findByRole(
          "option",
          { name: /Alice/ },
        ),
      );
      const input = screen.getByRole("combobox", { name: "Search Buzz" });
      expect(
        screen.getByRole("button", { name: "Remove author Alice" }),
      ).toBeVisible();
      fireEvent.change(input, {
        target: { value: typed },
      });
      fireEvent.click(
        await within(screen.getByRole("group", { name: "People" })).findByRole(
          "option",
          { name: /Bob/ },
        ),
      );
      expect(
        screen.queryByRole("button", { name: "Remove author Alice" }),
      ).toBeNull();
      expect(input).toHaveValue(remaining);
      expect((input as HTMLInputElement).value).not.toContain(alice.pubkey);
      await waitFor(() =>
        expect(reads.at(-1)?.[0]).toMatchObject({ authors: [bob.pubkey] }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Remove author Bob" }),
      );
      expect(input).toHaveValue(remaining);
      expect((input as HTMLInputElement).value).not.toContain(alice.pubkey);
      expect((input as HTMLInputElement).value).not.toContain(bob.pubkey);
      expect(changes.at(-1)).toBe(remaining);
      if (remaining) {
        await waitFor(() =>
          expect(reads.at(-1)?.[0]).not.toHaveProperty("authors"),
        );
      }
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("renders from:<author chip> without exposing the signed operand in the input", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(human, { display_name: "Wes" })]);
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  function Search() {
    const [query, setQuery] = useState("from:@wes");
    return (
      <SearchResults
        session={owner.session}
        query={query}
        onQueryChange={setQuery}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />
    );
  }
  try {
    render(<Search />);
    fireEvent.click(
      await within(screen.getByRole("group", { name: "People" })).findByRole(
        "option",
        { name: /Wes/ },
      ),
    );
    const chip = screen.getByRole("button", { name: "Remove author Wes" });
    expect(chip).toHaveTextContent("from:@Wes");
    await expectHint(chip, npubEncode(human.pubkey));
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(chip.closest(".search-field")).toContainElement(input);
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({ authors: [human.pubkey] }),
    );
    fireEvent.change(input, { target: { value: "before:" } });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Dates" })).getByRole("option", {
        name: /Yesterday/,
      }),
    );
    expect(chip).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: /^Remove date before:\d{4}-\d{2}-\d{2}$/,
      }),
    ).toBeVisible();
    expect(input).toHaveValue("");
    expect((input as HTMLInputElement).value).not.toContain(human.pubkey);
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({ authors: [human.pubkey] }),
    );
    fireEvent.change(input, { target: { value: "deploy" } });
    expect(input).toHaveValue("deploy");
    expect(chip).toBeVisible();
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({
        authors: [human.pubkey],
        search: "deploy",
      }),
    );
    fireEvent.click(chip);
    expect(
      screen.queryByRole("button", { name: "Remove author Wes" }),
    ).toBeNull();
    expect(input).toHaveValue("deploy");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps both exact authors selectable ahead of a crowded prefix page", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair();
  const prefixes = Array.from({ length: 12 }, () => keypair());
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          ...prefixes.map((person, index) =>
            profile(person, { display_name: `Samantha ${index}` }),
          ),
          profile(first, { display_name: "Sam" }),
          profile(second, { display_name: "Sam" }),
        ]);
      return Promise.resolve([]);
    },
  });
  const change = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:sam deploy"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const people = within(await screen.findByRole("group", { name: "People" }));
    await waitFor(() => expect(people.getAllByRole("option")).toHaveLength(12));
    for (const pubkey of [first.pubkey, second.pubkey]) {
      expect(
        people.getByRole("option", { name: new RegExp(pubkey.slice(0, 12)) }),
      ).toBeVisible();
    }
    expect(reads).toHaveLength(0);
    fireEvent.click(
      people.getByRole("option", {
        name: new RegExp(second.pubkey.slice(0, 12)),
      }),
    );
    expect(change).toHaveBeenCalledExactlyOnceWith(
      `from:${second.pubkey} deploy`,
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a person visible when agent candidates exceed the picker cap", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair();
  const agents = Array.from({ length: 12 }, () => keypair());
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          ...agents.map((agent) =>
            profile(agent, { display_name: "Algo Agent", is_agent: true }),
          ),
          profile(human, { display_name: "Alice" }),
        ]);
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:al"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(
      await within(screen.getByRole("group", { name: "People" })).findByRole(
        "option",
        { name: /Alice/ },
      ),
    ).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(12);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("retains a member of the in: channel when global author lookup fails", async () => {
  const relay = keypair(),
    viewer = keypair(),
    wes = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey, wes.pubkey]),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.search === "we"))
        return Promise.reject(new Error("prefix lookup unavailable"));
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(wes, { display_name: "Wes" })]);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="in:#crew from:we"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(
      await within(screen.getByRole("group", { name: "People" })).findByRole(
        "option",
        { name: /Wes/ },
      ),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows only the requested date suggestions and inserts local calendar dates", async () => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const change = vi.fn();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 5, 12));
  try {
    render(
      <SearchResults
        session={owner.session}
        query="after:"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const dates = within(screen.getByRole("group", { name: "Dates" }));
    expect(
      dates.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Today2026-10-05",
      "Yesterday2026-10-04",
      "This week2026-10-05",
      "Last week2026-09-28",
      "This month2026-10-01",
    ]);
    fireEvent.click(dates.getByRole("option", { name: /Last week/ }));
    expect(change).toHaveBeenCalledWith("after:2026-09-28 ");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("offers during: periods and an on: calendar that insert local dates", async () => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const change = vi.fn();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 7, 12));
  try {
    const props = {
      session: owner.session,
      onQueryChange: change,
      input: createRef<HTMLInputElement>(),
      pages: [],
      openNewMessage: () => {},
      openConversation: () => {},
    };
    const view = render(<SearchResults {...props} query="deploy during:" />);
    const dates = within(screen.getByRole("group", { name: "Dates" }));
    expect(
      dates.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Past 7 days7d",
      "Past 30 days30d",
      "Past 3 months3m",
      "Past 12 months12m",
      "Today2026-10-07",
      "Yesterday2026-10-06",
      "This week2026-10-05",
      "This month2026-10",
      "This year2026",
    ]);
    // A rolling period inserts its length, not a date.
    fireEvent.click(dates.getByRole("option", { name: /Past 3 months/ }));
    expect(change).toHaveBeenLastCalledWith("during:3m deploy ");
    fireEvent.click(dates.getByRole("option", { name: /This week/ }));
    // There is no week period, so the week starts after its Monday.
    expect(change).toHaveBeenLastCalledWith("after:2026-10-05 deploy ");
    fireEvent.click(dates.getByRole("option", { name: /This year/ }));
    expect(change).toHaveBeenLastCalledWith("during:2026 deploy ");
    view.rerender(<SearchResults {...props} query="deploy on:" />);
    expect(screen.queryByRole("group", { name: "Dates" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /October 14th, 2026/ }));
    expect(change).toHaveBeenLastCalledWith("on:2026-10-14 deploy ");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens a filter guide from Filters or ?, adds a filter for its picker, and closes on Escape", async () => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const change = vi.fn();
  const dismiss = vi.fn();
  function Harness() {
    const [query, setQuery] = useState("");
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: Hears Escape that leaves the palette.
      <div onKeyDown={(event) => event.key === "Escape" && dismiss()}>
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={(next) => {
            change(next);
            setQuery(next);
          }}
          input={createRef<HTMLInputElement>()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={() => {}}
        />
      </div>
    );
  }
  try {
    render(<Harness />);
    const field = screen.getByRole("combobox", { name: "Search Buzz" });
    const filters = screen.getByRole("button", { name: "Filters" });
    expect(filters).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(filters);
    expect(filters).toHaveAttribute("aria-pressed", "true");
    const guide = within(screen.getByRole("group", { name: "Filters" }));
    expect(
      guide.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^Who sent itfrom:me/),
      expect.stringMatching(/^Where it was sent/),
      expect.stringMatching(/^When it was sentduring:today/),
      expect.stringMatching(/^Before a daybefore:today/),
      expect.stringMatching(/^After a dayafter:yesterday/),
      expect.stringMatching(/^On one dayon:yesterday/),
      expect.stringMatching(/^Exact words/),
    ]);
    // Escape leaves the guide, not search.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    expect(dismiss).not.toHaveBeenCalled();
    // So does Escape from the button that opened it.
    fireEvent.click(filters);
    fireEvent.keyDown(filters, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    expect(dismiss).not.toHaveBeenCalled();
    // `?` alone opens it without searching for "?".
    fireEvent.change(field, { target: { value: "?" } });
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("group", { name: "Filters" })).getByRole(
        "option",
        { name: /When it was sent/ },
      ),
    );
    // Its filter waits for the picker to finish it.
    expect(change).toHaveBeenLastCalledWith("during:");
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    expect(screen.getByRole("group", { name: "Dates" })).toBeInTheDocument();
    // Deleting back to where it opened doesn't bring it back.
    fireEvent.change(field, { target: { value: "" } });
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    // An example tried from the preview adds its chip ahead of the text.
    fireEvent.change(field, { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.click(
      within(screen.getByRole("complementary", { name: "Preview" })).getByRole(
        "button",
        { name: /during:7d/ },
      ),
    );
    expect(change).toHaveBeenLastCalledWith("during:7d deploy");
    expect(
      screen.getByRole("button", { name: "Remove date during:7d" }),
    ).toHaveTextContent("during:7d");
    // A tried author replaces a typed one, which the parser would read last.
    fireEvent.change(field, {
      target: { value: `deploy from:${"a".repeat(64)}` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(
      within(screen.getByRole("complementary", { name: "Preview" })).getByRole(
        "button",
        { name: /from:me/ },
      ),
    );
    expect(change).toHaveBeenLastCalledWith("during:7d from:me deploy ");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps the filter guide to itself: a waiting Enter, Settings rows and a restored from:me", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport);
  const change = vi.fn();
  const openSetting = vi.fn();
  function Harness({
    initial,
    inlineSettings,
  }: {
    initial: string;
    inlineSettings?: SearchGroup[];
  }) {
    const [query, setQuery] = useState(initial);
    return (
      <SearchResults
        session={owner.session}
        query={query}
        onQueryChange={(next) => {
          change(next);
          setQuery(next);
        }}
        input={createRef<HTMLInputElement>()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
        inlineSettings={inlineSettings}
      />
    );
  }
  try {
    // Enter while the search is still out waits for its first row; opening
    // the guide drops that wait rather than running the guide's first row.
    render(<Harness initial="deploy" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const field = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("group", { name: "Filters" })).toBeVisible();
    expect(change).not.toHaveBeenCalled();
    cleanup();
    // Settings that match the text stay out of the guide.
    render(
      <Harness
        initial="appearance"
        inlineSettings={[
          {
            label: "Settings",
            destinations: [
              {
                key: "appearance-setting",
                label: "Appearance",
                icon: ChatCircleIcon,
                run: openSetting,
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByRole("option", { name: /Appearance/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.queryByRole("option", { name: /Appearance/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(openSetting).not.toHaveBeenCalled();
    cleanup();
    // Opened over an unfinished filter, Tab keeps the query and the guide.
    for (const initial of ["during:", "from:zz"]) {
      change.mockClear();
      render(<Harness initial={initial} />);
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      fireEvent.click(screen.getByRole("button", { name: "Filters" }));
      const tabbed = fireEvent.keyDown(
        screen.getByRole("combobox", { name: "Search Buzz" }),
        { key: "Tab" },
      );
      expect(tabbed).toBe(true);
      expect(screen.getByRole("group", { name: "Filters" })).toBeVisible();
      expect(change).not.toHaveBeenCalled();
      cleanup();
    }
    // A remembered from:me comes back as its chip.
    render(<Harness initial="from:me deploy" />);
    expect(
      screen.getByRole("button", { name: "Remove author me" }),
    ).toHaveTextContent("from:me");
    expect(screen.getByRole("combobox", { name: "Search Buzz" })).toHaveValue(
      "deploy",
    );
  } finally {
    cleanup();
    owner.dispose();
    vi.useRealTimers();
  }
});

it("picks an in: channel from the joined channels and an in:@ person like from:@", async () => {
  const relay = keypair(),
    viewer = keypair(),
    baxen = keypair();
  const { owner } = operatorSession(viewer, relay, [
    metadata(relay, "bugs", "buzz-bugs"),
    roster(relay, "bugs", [viewer.pubkey]),
    metadata(relay, "builds", "builds"),
    roster(relay, "builds", [viewer.pubkey]),
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    profile(baxen, { display_name: "Baxen" }),
  ]);
  const session = {
    ...owner.session,
    searchProfiles: async () => [
      eventDto(profile(baxen, { display_name: "Baxen" })),
    ],
  };
  const change = vi.fn();
  const props = {
    session,
    onQueryChange: change,
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="deploy in:#bu" />);
    const channels = within(
      await screen.findByRole("group", { name: "Channels" }),
    );
    await waitFor(() =>
      expect(
        channels.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["builds" + "Channel", "buzz-bugs" + "Channel"]),
    );
    fireEvent.click(channels.getByRole("option", { name: /buzz-bugs/ }));
    expect(change).toHaveBeenLastCalledWith("in:bugs deploy ");
    view.rerender(<SearchResults {...props} query="in:#" />);
    expect(
      await within(
        await screen.findByRole("group", { name: "Channels" }),
      ).findAllByRole("option"),
    ).toHaveLength(3);
    view.rerender(<SearchResults {...props} query="deploy in:@bax" />);
    const people = within(await screen.findByRole("group", { name: "People" }));
    fireEvent.click(await people.findByRole("option", { name: /Baxen/ }));
    expect(change).toHaveBeenLastCalledWith(`in:@${baxen.pubkey} deploy `);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a picked channel's identity past an open live namesake", async () => {
  const relay = keypair(),
    viewer = keypair();
  const joined = "00000000-0000-4000-8000-000000000001";
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      metadata(relay, joined, "crew", 1700000000, [
        ["t", "stream"],
        ["archived", "true"],
      ]),
      roster(relay, joined, [viewer.pubkey]),
      metadata(relay, "open", "crew", 1700000000, openChannel),
    ],
    [message(viewer, joined, "deploy archived", 1700000001)],
  );
  const change = vi.fn();
  const props = {
    ...operatorProps,
    session: owner.session,
    onQueryChange: change,
  };
  try {
    const view = render(<SearchResults {...props} query="deploy in:#cr" />);
    const channels = within(
      await screen.findByRole("group", { name: "Channels" }),
    );
    fireEvent.click(await channels.findByRole("option", { name: /crew/ }));
    expect(change).toHaveBeenLastCalledWith(`in:${joined} deploy `);
    view.rerender(<SearchResults {...props} query={`in:${joined} deploy `} />);
    expect(
      screen.getByRole("button", { name: "Remove channel crew" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(reads.flat()).toEqual([
        expect.objectContaining({ "#h": [joined] }),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["from:@ali", "Alice", "in:@bo", "Bob"],
  ["IN:@bo", "Bob", "from:@ali", "Alice"],
])(
  "keeps %s as a chip when a person is then picked for the other operator",
  async (first, firstName, second, secondName) => {
    const relay = keypair(),
      viewer = keypair(),
      alice = keypair(),
      bob = keypair();
    const { owner } = operatorSession(viewer, relay, []);
    const session = {
      ...owner.session,
      searchProfiles: async () => [
        eventDto(profile(alice, { display_name: "Alice" })),
        eventDto(profile(bob, { display_name: "Bob" })),
      ],
    };
    const operand = (name: string, typed: string) =>
      /^in:/i.test(typed)
        ? `in:@${(name === "Bob" ? bob : alice).pubkey}`
        : `from:${(name === "Bob" ? bob : alice).pubkey}`;
    const changes: string[] = [];
    function Search() {
      const [query, setQuery] = useState(first);
      return (
        <SearchResults
          {...operatorProps}
          session={session}
          query={query}
          onQueryChange={(next) => {
            changes.push(next);
            setQuery(next);
          }}
        />
      );
    }
    const pick = async (name: string) =>
      fireEvent.click(
        await within(
          await screen.findByRole("group", { name: "People" }),
        ).findByRole("option", { name: new RegExp(name) }),
      );
    try {
      render(<Search />);
      await pick(firstName);
      const input = screen.getByRole("combobox", { name: "Search Buzz" });
      fireEvent.change(input, { target: { value: second } });
      await pick(secondName);
      expect(changes.at(-1)).toBe(
        `${operand(firstName, first)} ${operand(secondName, second)} `,
      );
      expect(input).toHaveValue("");
      const chips = screen
        .getAllByRole("button", { name: /^Remove (author|conversation)/ })
        .map((chip) => chip.textContent);
      expect(chips).toEqual([
        `${/^in:/i.test(first) ? "in" : "from"}:@${firstName}`,
        `${/^in:/i.test(second) ? "in" : "from"}:@${secondName}`,
      ]);
      // Backspace before the text turns the last chip back into its text.
      fireEvent.keyDown(input, { key: "Backspace" });
      const restored = `${/^in:/i.test(second) ? "in" : "from"}:@${secondName}`;
      expect(input).toHaveValue(restored);
      expect(changes.at(-1)).toBe(`${operand(firstName, first)} ${restored}`);
      expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(
        1,
      );
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it.each([
  ["deploy in:#cr", "Channels", /crew/, "in:crew deploy "],
  ["deploy from:@ali", "People", /Alice/, "from:<alice> deploy "],
  ["deploy after:", "Dates", /Today/, "after:2026-10-07 deploy "],
])(
  "completes %s with the highlighted suggestion on Tab",
  async (query, group, row, completed) => {
    const relay = keypair(),
      viewer = keypair(),
      alice = keypair();
    const { owner } = operatorSession(viewer, relay, [
      metadata(relay, "crew", "crew"),
      roster(relay, "crew", [viewer.pubkey]),
    ]);
    const change = vi.fn();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 7, 12));
    try {
      render(
        <SearchResults
          {...operatorProps}
          session={{
            ...owner.session,
            searchProfiles: async () => [
              eventDto(profile(alice, { display_name: "Alice" })),
            ],
          }}
          query={query}
          onQueryChange={change}
        />,
      );
      const option = await within(
        await screen.findByRole("group", { name: group }),
      ).findByRole("option", { name: row });
      await waitFor(() =>
        expect(option).toHaveAttribute("aria-selected", "true"),
      );
      const input = screen.getByRole("combobox", { name: "Search Buzz" });
      // Shift+Tab still leaves the field.
      expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(
        true,
      );
      expect(change).not.toHaveBeenCalled();
      expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
      expect(change).toHaveBeenLastCalledWith(
        completed.replace("<alice>", alice.pubkey),
      );
    } finally {
      vi.useRealTimers();
      cleanup();
      owner.dispose();
    }
  },
);

it("keeps Tab in the field while a filter's people are still loading", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const { owner } = operatorSession(viewer, relay, []);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const change = vi.fn();
  try {
    render(
      <SearchResults
        {...operatorProps}
        session={{
          ...owner.session,
          searchProfiles: async () => {
            await held;
            return [eventDto(profile(alice, { display_name: "Alice" }))];
          },
        }}
        query="deploy from:@ali"
        onQueryChange={change}
      />,
    );
    expect(await screen.findByText("Searching people…")).toBeVisible();
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(change).not.toHaveBeenCalled();
    release();
    const option = await within(
      await screen.findByRole("group", { name: "People" }),
    ).findByRole("option", { name: /Alice/ });
    await waitFor(() =>
      expect(option).toHaveAttribute("aria-selected", "true"),
    );
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(change).toHaveBeenLastCalledWith(`from:${alice.pubkey} deploy `);
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it("moves focus on Tab when a filter has no suggestion to complete", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner } = operatorSession(viewer, relay, []);
  const change = vi.fn();
  try {
    render(
      <SearchResults
        {...operatorProps}
        session={owner.session}
        query="from:@a"
        onQueryChange={change}
      />,
    );
    expect(
      await screen.findByText("Type at least 2 characters to search people."),
    ).toBeVisible();
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
    expect(change).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("turns date and channel picks into chips that Backspace edits", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner } = operatorSession(viewer, relay, [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ]);
  const changes: string[] = [];
  function Search() {
    const [query, setQuery] = useState("deploy in:#cr");
    return (
      <SearchResults
        {...operatorProps}
        session={owner.session}
        query={query}
        onQueryChange={(next) => {
          changes.push(next);
          setQuery(next);
        }}
      />
    );
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 7, 12));
  try {
    render(<Search />);
    fireEvent.click(
      await within(
        await screen.findByRole("group", { name: "Channels" }),
      ).findByRole("option", { name: /crew/ }),
    );
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(input).toHaveValue("deploy ");
    fireEvent.change(input, { target: { value: "deploy on:" } });
    fireEvent.click(screen.getByRole("button", { name: /October 14th, 2026/ }));
    expect(changes.at(-1)).toBe("in:crew on:2026-10-14 deploy ");
    expect(input).toHaveValue("deploy ");
    expect(
      screen.getByRole("button", { name: "Remove channel crew" }),
    ).toHaveTextContent("in:#crew");
    expect(
      screen.getByRole("button", { name: "Remove date on:2026-10-14" }),
    ).toBeVisible();
    (input as HTMLInputElement).setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "Backspace" });
    // The edited token ends the query, where its picker can see it.
    expect(input).toHaveValue("deploy on:2026-10-14");
    expect(changes.at(-1)).toBe("in:crew deploy on:2026-10-14");
    // Backspace inside the text edits text, not a chip.
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(
      screen.getByRole("button", { name: "Remove channel crew" }),
    ).toBeVisible();
    fireEvent.change(input, { target: { value: "deploy " } });
    (input as HTMLInputElement).setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(input).toHaveValue("deploy in:#crew");
    fireEvent.click(
      await within(
        await screen.findByRole("group", { name: "Channels" }),
      ).findByRole("option", { name: /crew/ }),
    );
    expect(changes.at(-1)).toBe("in:crew deploy ");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("lets a picked person or channel replace a typed filter of its kind", async () => {
  const relay = keypair(),
    viewer = keypair(),
    bob = keypair();
  const first = "00000000-0000-4000-8000-00000000000a";
  const crew = "00000000-0000-4000-8000-00000000000b";
  const { owner, reads } = operatorSession(viewer, relay, [
    metadata(relay, first, "builds"),
    roster(relay, first, [viewer.pubkey]),
    metadata(relay, crew, "crew"),
    roster(relay, crew, [viewer.pubkey]),
  ]);
  const session = {
    ...owner.session,
    searchProfiles: async () => [
      eventDto(profile(bob, { display_name: "Bob" })),
    ],
  };
  const change = vi.fn();
  const props = { ...operatorProps, session, onQueryChange: change };
  try {
    const view = render(
      <SearchResults {...props} query={'from:me "from:me" deploy from:@bo'} />,
    );
    fireEvent.click(
      await within(
        await screen.findByRole("group", { name: "People" }),
      ).findByRole("option", { name: /Bob/ }),
    );
    const author = `from:${bob.pubkey} "from:me" deploy `;
    expect(change).toHaveBeenLastCalledWith(author);
    view.rerender(<SearchResults {...props} query={author} />);
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({ authors: [bob.pubkey] }),
    );
    view.rerender(
      <SearchResults {...props} query={`in:${first} deploy in:#cr`} />,
    );
    fireEvent.click(
      await within(
        await screen.findByRole("group", { name: "Channels" }),
      ).findByRole("option", { name: /crew/ }),
    );
    const channel = `in:${crew} deploy `;
    expect(change).toHaveBeenLastCalledWith(channel);
    view.rerender(<SearchResults {...props} query={channel} />);
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({ "#h": [crew] }),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows only messages once text sits beside an operator, each still previewed", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      metadata(relay, "bugs", "buzz-bugs"),
      roster(relay, "bugs", [viewer.pubkey]),
      metadata(relay, "kr", "kalvin-reviewers"),
      roster(relay, "kr", [viewer.pubkey]),
    ],
    [message(viewer, "bugs", "kalvin found it", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="in:#buzz-bugs kalvin"
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /kalvin found it/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([
      expect.objectContaining({ "#h": ["bugs"], search: "kalvin" }),
    ]);
    expect(screen.queryByRole("group", { name: "Channels" })).toBeNull();
    expect(
      screen.queryByRole("option", { name: /kalvin-reviewers/ }),
    ).toBeNull();
    // Only messages, so no group filters, but the hit still previews.
    expect(screen.queryByRole("group", { name: "Result groups" })).toBeNull();
    const preview = screen.getByRole("complementary", { name: "Preview" });
    await waitFor(() => expect(preview).toHaveTextContent(/kalvin found it/));
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("never widens a search when a name or channel operator is unresolved", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        [
          metadata(relay, "crew", "crew"),
          roster(relay, "crew", [viewer.pubkey]),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  try {
    const { rerender } = render(
      <SearchResults
        session={owner.session}
        query="deploy from:@missing"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        scopedChannelId="crew"
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const users = wire.next();
    expect(users.filters[0]?.kinds).toEqual([0]);
    await act(async () => users.respond([]));
    expect(
      wire.pending.filter((request) =>
        request.filters.some((filter) => filter.kinds?.includes(9)),
      ),
    ).toHaveLength(0);
    for (const request of wire.pending.splice(0)) request.respond([]);
    rerender(
      <SearchResults
        session={owner.session}
        query="deploy in:#missing"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(
      wire.pending.filter((request) =>
        request.filters.some((filter) => filter.kinds?.includes(9)),
      ),
    ).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["private", "missing"])(
  "revalidates a retained public preview before an in: search when metadata becomes %s",
  async (change) => {
    const relay = keypair(),
      viewer = keypair();
    const id = "12345678-1234-1234-1234-123456789abc";
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const publicMeta = metadata(relay, id, "Public", 1700000000, [
      ["public", ""],
    ]);
    const privateMeta = metadata(relay, id, "Private", 1700000001, [
      ["private", ""],
    ]);
    let current = publicMeta;
    let revoked = false;
    const scopedReads: Filter[][] = [];
    let exactReads = 0;
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters) {
        if (filters.some((filter) => filter.search !== undefined)) {
          scopedReads.push(filters as Filter[]);
          return [message(viewer, id, "stale secret hit", 1700000002)];
        }
        if (filters.some((filter) => filter["#d"]?.includes(id))) {
          exactReads++;
          return revoked
            ? change === "missing"
              ? []
              : [current]
            : [publicMeta];
        }
        return [publicMeta].filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    try {
      const props = {
        session: owner.session,
        onQueryChange: () => {},
        input: createRef<HTMLInputElement>(),
        pages: [],
        openNewMessage: () => {},
        openConversation: () => {},
      };
      const mounted = render(<SearchResults {...props} query="Public" />);
      await screen.findByRole("option", {
        name: /Public channel · not joined/,
      });
      expect(owner.session.channels.get?.(id)?.readOnly).toBe(true);
      const beforeRevalidation = exactReads;
      scopedReads.length = 0;
      vi.useFakeTimers();
      current = privateMeta;
      revoked = true;
      mounted.rerender(<SearchResults {...props} query={`secret in:${id}`} />);
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      expect(exactReads).toBeGreaterThan(beforeRevalidation);
      expect(scopedReads).toHaveLength(0);
      expect(owner.session.channels.get?.(id)).toBeUndefined();
      expect(
        screen.queryByRole("option", { name: /stale secret hit/ }),
      ).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("resolves an exact public name beyond eight preceding substring matches and reports page coverage", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const names = [
    "a-dev",
    "b-dev",
    "c-dev",
    "d-dev",
    "android-dev",
    "backend-dev",
    "core-dev",
    "data-dev",
    "dev",
  ];
  const discovery = names.map((name) =>
    metadata(relay, name, name, 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
  );
  // A partial directory means an exact-name miss outside it cannot be declared exhaustive.
  for (let i = 0; i < 491; i++)
    discovery.push(
      metadata(relay, `extra-${i}`, `extra-${i}`, 1700000000, [
        ["public", ""],
        ["t", "stream"],
      ]),
    );
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return [message(viewer, "dev", "deploy found", 1700000001)];
      }
      // The directory is one full page: nothing is older than its cursor.
      if (filters.some((filter) => filter.before_id !== undefined)) return [];
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  // Reaching the store's read bound takes 20,000 signed events; report it here.
  const searchPublic = owner.session.channels.searchPublic;
  assert.exists(searchPublic);
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      searchPublic: async (...args: Parameters<typeof searchPublic>) => ({
        ...(await searchPublic(...args)),
        partial: true,
      }),
    },
  };
  try {
    render(
      <SearchResults
        session={session}
        query="deploy in:#dev "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy found/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([
      expect.objectContaining({ "#h": ["dev"], search: "deploy" }),
    ]);
    expect(
      screen.getByText("Only the newest open channels were searched."),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a pending in: lookup pending, then retries its failure and resumes scoped search", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "dev", "dev", 1700000000, [["public", ""]]),
  ];
  let failLookup!: (error: Error) => void;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const pending = new Promise<typeof discovery>((_resolve, reject) => {
    failLookup = reject;
  });
  let failures = 1;
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return Promise.resolve([
          message(viewer, "dev", "deploy found", 1700000001),
        ]);
      }
      if (
        filters.some(
          (filter) => filter.kinds?.includes(39000) && !filter["#d"],
        ) &&
        failures-- > 0
      ) {
        lookupStarted();
        return pending;
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#dev "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await started;
    expect(
      screen.queryByText("No matching messages in accessible conversations."),
    ).toBeNull();
    await act(async () => failLookup(new Error("network down")));
    expect(
      await screen.findByText(
        /Public channel search couldn’t finish: network down/,
      ),
    ).toBeVisible();
    expect(screen.getByText("Message search is unavailable.")).toBeVisible();
    expect(reads).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry channels" }));
    expect(
      await screen.findByRole("option", { name: /deploy found/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([expect.objectContaining({ "#h": ["dev"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows a pending in: channel lookup beside Messages", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: async () => [],
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookupStarted = false;
  const searchPublic = vi.fn(async (query: string) => {
    if (query === "dev") {
      lookupStarted = true;
      await held;
    }
    return { channels: [], partial: false };
  });
  const readPage = vi.fn(async () => ({ events: [], relayCount: 0 }));
  const session = {
    ...owner.session,
    readPage,
    channels: { ...owner.session.channels, searchPublic },
  };
  try {
    render(
      <SearchResults
        session={session}
        query="deploy in:#dev "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    for (let step = 0; step < 100 && !lookupStarted; step++)
      await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(lookupStarted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const group = screen.getByRole("group", { name: "Messages" });
    expect(
      within(group).getByRole("heading", { name: "Messages" }),
    ).toHaveTextContent(/^Messages\b.*· Searching…$/);
    expect(group.querySelector(".search-palette-group-empty")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Searching messages…");
    expect(readPage).not.toHaveBeenCalled();
    await act(async () => release());
    expect(screen.queryByText(/· Searching…/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it("holds an early Enter while an in: channel is still being found", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "dev", "dev", 1700000000, [["public", ""]]),
  ];
  const found = message(viewer, "dev", "deploy found", 1700000001);
  let listRead!: () => void;
  const listStarted = new Promise<void>((resolve) => (listRead = resolve));
  let releaseList!: () => void;
  const listHeld = new Promise<void>((release) => (releaseList = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) return [found];
      // The joined list must load before the in: channel can resolve.
      if (filters.some((filter) => filter.kinds?.includes(39002))) {
        listRead();
        await listHeld;
      }
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#dev "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
      />,
    );
    await listStarted;
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    await act(async () => releaseList());
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("dev", found.id),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("holds an early Enter while the joined list is still loading", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "engineering", "engineering"),
    roster(relay, "engineering", [viewer.pubkey]),
  ];
  const reads: Promise<unknown>[] = [];
  let listRead!: () => void;
  const listStarted = new Promise<void>((resolve) => (listRead = resolve));
  let releaseList!: () => void;
  const listHeld = new Promise<void>((release) => (releaseList = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(39002))) {
        listRead();
        await listHeld;
      }
      const read = Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
      reads.push(read);
      return read;
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="eng"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
      />,
    );
    await listStarted;
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    // Message search and the people lookup settle empty before the list.
    expect(
      await screen.findByText(
        "No matching messages in accessible conversations.",
      ),
    ).toBeVisible();
    await act(async () => {
      await Promise.all(reads);
    });
    expect(screen.getByText("Loading joined conversations…")).toBeVisible();
    await act(async () => releaseList());
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("engineering"),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("matches an in: operator against the rendered DM participant label", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "dm", "opaque", 1700000000, [
      ["hidden", ""],
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
    profile(alice, { name: "Alice" }),
  ];
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return [message(alice, "dm", "deploy to Alice", 1700000001)];
      }
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:alice "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy to Alice/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([expect.objectContaining({ "#h": ["dm"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("treats bare in:# as no channel operator", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return [message(viewer, "crew", "hello world", 1700000001)];
      }
      return [
        metadata(relay, "crew", "crew"),
        roster(relay, "crew", [viewer.pubkey]),
      ].filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="hello in:# "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /hello world/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([
      expect.not.objectContaining({ "#h": expect.anything() }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([true, false])(
  "only shows relay-attested workflow ownership in ranked search (relay signer: %s), keeping from: signer-based",
  async (relaySigned) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair(),
      workflowOwner = keypair();
    const signer = relaySigned ? relay : keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      archiveAuthority: relay.pubkey,
      query(filters, signal) {
        if (filters.some((filter) => filter.search !== undefined))
          return wire.transport.query(filters, signal);
        return Promise.resolve(
          [
            metadata(relay, "crew", "crew"),
            roster(relay, "crew", [viewer.pubkey]),
            profile(workflowOwner, { display_name: "Workflow owner" }),
            profile(signer, { display_name: "Actual signer" }),
          ].filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        );
      },
    });
    const open = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={`deploy in:#crew from:${signer.pubkey} `}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={open}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      // The exact open-channel lookup settles before the in: channel resolves.
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      const request = wire.next();
      expect(request.filters[0]?.authors).toEqual([signer.pubkey]);
      const hit = eventDto(
        message(signer, "crew", "deploy automated", 1700000001, [
          ["buzz:workflow", "true"],
          ["buzz:workflow-owner", workflowOwner.pubkey],
        ]),
      );
      await act(async () => request.respond([hit]));
      const option = screen.getByRole("option", { name: /deploy automated/ });
      if (relaySigned) {
        expect(option).toHaveTextContent("Workflow · owned by Workflow owner");
      } else {
        expect(option).toHaveTextContent("Actual signer");
        expect(option).not.toHaveTextContent("Workflow");
      }
      fireEvent.click(option);
      expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("leads a message hit's conversation name with its type icon and words", async () => {
  const relay = keypair(),
    viewer = keypair(),
    peer = keypair(),
    other = keypair();
  // Each hit's channel, its icon, and the words read in place of the icon.
  const rows = [
    ["crew", "hash", "Public channel", "crew"],
    ["plans", "lock", "Private channel", "plans"],
    ["board", "hash", "Public channel", "board"],
    ["vault", "lock", "Private channel", "vault"],
    ["notes", "message-circle", "Chat", "Notes"],
    ["dm", "message-circle", "Direct message", "Pinky"],
    ["group", "message-circle", "Direct message", "Brain, Pinky"],
  ] as const;
  const dm = [
    ["t", "dm"],
    ["private", ""],
  ];
  const discovery = [
    metadata(relay, "crew", "crew", 1700000000, [["t", "stream"]]),
    metadata(relay, "plans", "plans", 1700000000, [
      ["t", "stream"],
      ["private"],
    ]),
    metadata(relay, "board", "board", 1700000000, [["t", "forum"]]),
    metadata(relay, "vault", "vault", 1700000000, [
      ["t", "forum"],
      ["private"],
    ]),
    metadata(relay, "notes", "Notes", 1700000000, [
      ["t", "stream"],
      ["private"],
      ["t", "buzz.solo"],
    ]),
    metadata(relay, "dm", "opaque", 1700000000, dm),
    metadata(relay, "group", "opaque", 1700000000, dm),
    ...rows.map(([id]) =>
      roster(
        relay,
        id,
        id === "dm"
          ? [viewer.pubkey, peer.pubkey]
          : id === "group"
            ? [viewer.pubkey, peer.pubkey, other.pubkey]
            : [viewer.pubkey],
      ),
    ),
    profile(peer, { name: "Pinky" }),
    profile(other, { name: "Brain" }),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined))
        return filters.some((filter) => filter.kinds?.includes(0))
          ? []
          : rows.map(([id]) =>
              message(viewer, id, `match in ${id}`, 1700000001),
            );
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const palette = (inlineSettings?: SearchGroup[]) => (
    <SearchResults
      session={owner.session}
      query="match"
      onQueryChange={() => {}}
      input={createRef()}
      // A detail without a type icon, for contrast.
      pages={[
        {
          key: "page",
          label: "Inbox",
          detail: "Page",
          icon: ChatCircleIcon,
          run: () => {},
        },
      ]}
      openNewMessage={() => {}}
      openConversation={() => {}}
      inlineSettings={inlineSettings}
    />
  );
  try {
    const { rerender } = render(palette());
    await screen.findByRole("group", { name: "Messages" });
    // A detail without a type icon has none beside it.
    const page = screen.getByRole("option", { name: /^Inbox\s*Page$/ });
    expect(page.querySelector(`.${referenceStyles.icon}`)).toBeNull();
    // Top results shows five hits; Tab shows the whole Messages group.
    const field = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(field, { key: "Tab" });
    // An option is named from its content: the message, then the detail led
    // by its icon's hidden words (jsdom joins the two block lines unspaced).
    await waitFor(() => {
      for (const [id, icon, kind, name] of rows) {
        const option = screen.getByRole("option", {
          name: new RegExp(`match in ${id}\\s*${kind}, ${name} · `),
        });
        // The icon styled as a channel mention's in a message: a hash
        // flush against the name, a lock or bubble a little apart.
        expect(
          option.querySelector(
            `.${referenceStyles.icon}.${icon === "hash" ? referenceStyles.flush : referenceStyles.snug}`,
          ),
        ).toHaveClass(`tabler-icon-${icon}`);
        expect(within(option).getByText(`${kind},`)).toHaveClass("sr-only");
      }
    });
    fireEvent.keyDown(field, { key: "Escape" });
    // A grid row's own label reads the same words before the detail.
    rerender(
      palette([
        {
          label: "Settings",
          destinations: [
            {
              key: "sound-setting",
              label: "Notifications",
              detail: "Sound",
              icon: ChatCircleIcon,
              content: <button type="button">Sound</button>,
              run: vi.fn(),
            },
          ],
        },
      ]),
    );
    for (const [id, , kind, name] of rows.slice(0, 5))
      screen.getByRole("row", {
        name: new RegExp(`match in ${id} — ${kind}, ${name} · `),
      });
  } finally {
    cleanup();
    owner.dispose();
  }
});

function peopleSession(
  session: ReturnType<typeof createRelaySession>["session"],
  directory: {
    pubkey: string;
    name: string;
    username?: string;
    isAgent?: true;
    ownerPubkey?: string;
  }[] = [],
  agents: readonly {
    pubkey: string;
    name: string;
    managed: boolean;
    messageable?: true;
  }[] = [],
  /** People the viewer already has a DM with, which Message confirms. */
  dms: readonly string[] = [],
) {
  const people = vi.fn(async (_query?: string) => ({
    people: directory,
    hasMore: false,
  }));
  const open = vi.fn(async (_pubkeys: readonly string[]) => "started-dm");
  const source = session.agentChoices;
  const choices = { ...source.snapshot(), identities: agents, selectable: [] };
  let listed: [ChannelList, ChannelList] | undefined;
  const list = () => {
    const base = session.channels.list();
    if (listed?.[0] !== base)
      listed = [
        base,
        {
          ...base,
          channels: [
            ...base.channels,
            ...dms.map((pubkey) => ({
              id: `dm-${pubkey.slice(0, 8)}`,
              name: "",
              channelType: "dm" as const,
              participants: [pubkey],
            })),
          ],
        },
      ];
    return listed[1];
  };
  return {
    people,
    open,
    session: {
      ...session,
      ...(dms.length ? { channels: { ...session.channels, list } } : {}),
      directMessages: {
        ...session.directMessages,
        available: true,
        people,
        open,
      },
      agentChoices: {
        ...source,
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
        ensure: () => {},
      },
    } as typeof session,
  };
}

it("opens a draft to a hosted agent from search without local management", async () => {
  const relay = keypair(),
    viewer = keypair(),
    hosted = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const t = peopleSession(
    owner.session,
    [],
    [
      {
        pubkey: hosted.pubkey,
        name: "Hosted helper",
        managed: false,
        messageable: true,
      },
    ],
  );
  const openNewMessage = vi.fn();
  try {
    render(
      <SearchResults
        session={t.session}
        query="Hosted helper"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={openNewMessage}
        openConversation={() => {}}
      />,
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /Hosted helper/ }),
    );
    await waitFor(() =>
      expect(openNewMessage).toHaveBeenCalledExactlyOnceWith(hosted.pubkey),
    );
    expect(t.open).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps the directory's order for tied people, as New message does", async () => {
  const relay = keypair(),
    viewer = keypair(),
    park = keypair(),
    lee = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      return filters.some((filter) => filter.kinds?.includes(0))
        ? [profile(lee, { display_name: "Kim Lee" })]
        : [];
    },
  });
  // The relay ranked Kim Park first. Kim Lee is also in the profile cache and
  // sorts first by name; neither may move the directory's order.
  const t = peopleSession(owner.session, [
    { pubkey: park.pubkey, name: "Kim Park" },
    { pubkey: lee.pubkey, name: "Kim Lee" },
  ]);
  try {
    render(
      <SearchResults
        session={t.session}
        query="kim"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    await act(async () => owner.session.profiles.ensure([lee.pubkey]));
    const group = await screen.findByRole("group", { name: "People" });
    await waitFor(() =>
      expect(
        within(group)
          .getAllByRole("option")
          .map((row) => row.textContent?.match(/Kim (Park|Lee)/)?.[0]),
      ).toEqual(["Kim Park", "Kim Lee"]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("finds a person by username and opens a draft to them", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      return filters.some((filter) => filter.kinds?.includes(0))
        ? [profile(alice, { display_name: "Alice Chen", name: "achen" })]
        : [];
    },
  });
  const t = peopleSession(owner.session);
  const openNewMessage = vi.fn();
  try {
    render(
      <SearchResults
        session={t.session}
        query="achen"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={openNewMessage}
        openConversation={() => {}}
      />,
    );
    // A profile already loaded elsewhere, read through the real kind-0 fold.
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    await act(async () => owner.session.profiles.ensure([alice.pubkey]));
    const row = await within(
      await screen.findByRole("group", { name: "People" }),
    ).findByRole("option");
    expect(row).toHaveTextContent("Alice Chen");
    expect(row).toHaveTextContent("@achen · Start a direct message");
    expect(row).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(openNewMessage).toHaveBeenCalledExactlyOnceWith(alice.pubkey),
    );
    expect(t.open).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("lets the newest choice win over a DM that is still opening", async () => {
  const relay = keypair(),
    viewer = keypair(),
    bob = keypair(),
    carol = keypair();
  const discovery = [
    metadata(relay, "chat", "ally-chat"),
    roster(relay, "chat", [viewer.pubkey]),
  ];
  // A full first page of hits, so search offers more messages.
  const hits = Array.from({ length: 20 }, (_, i) =>
    message(viewer, "chat", `ally note ${i}`, 1700000100 - i),
  );
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return filters.some((filter) => filter.page === 2) ? [] : hits;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  // Each has a DM, so choosing them waits on its confirmed open.
  const t = peopleSession(
    owner.session,
    [
      { pubkey: bob.pubkey, name: "Ally Bob" },
      { pubkey: carol.pubkey, name: "Ally Carol" },
    ],
    [],
    [bob.pubkey, carol.pubkey],
  );
  const held: ((id: string) => void)[] = [];
  const hold = () => new Promise<string>((resolve) => held.push(resolve));
  t.open
    .mockImplementationOnce(hold)
    .mockImplementationOnce(async () => "carol-dm")
    .mockImplementationOnce(hold)
    .mockImplementationOnce(hold)
    .mockImplementationOnce(hold);
  const signal = (call: number) =>
    (t.open.mock.calls[call] as unknown as [unknown, AbortSignal])[1];
  const openConversation = vi.fn();
  const props = {
    session: t.session,
    query: "ally",
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    currentChannelId: "chat",
    onScopeChange: () => {},
    openNewMessage: () => {},
    openConversation,
  };
  try {
    const mounted = render(<SearchResults {...props} />);
    const people = await screen.findByRole("group", { name: "People" });
    const bobRow = await within(people).findByRole("option", {
      name: /Ally Bob/,
    });
    fireEvent.click(bobRow);
    expect(
      await screen.findByText("Opening your conversation with Ally Bob…"),
    ).toBeVisible();
    // Another person replaces the open still under way.
    fireEvent.click(within(people).getByRole("option", { name: /Ally Carol/ }));
    expect(signal(0).aborted).toBe(true);
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("carol-dm"),
    );
    // So does a channel.
    fireEvent.click(bobRow);
    expect(
      await screen.findByText("Opening your conversation with Ally Bob…"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: /^ally-chat/ }));
    expect(signal(2).aborted).toBe(true);
    expect(openConversation).toHaveBeenLastCalledWith("chat");
    expect(
      screen.queryByText("Opening your conversation with Ally Bob…"),
    ).toBeNull();
    // So does showing more messages.
    fireEvent.click(bobRow);
    expect(
      await screen.findByText("Opening your conversation with Ally Bob…"),
    ).toBeVisible();
    // Top results omits that action; the whole Messages group holds it.
    fireEvent.click(
      await screen.findByRole("button", { name: "Show all Messages" }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Show more messages" }),
    );
    expect(signal(3).aborted).toBe(true);
    expect(
      screen.queryByText("Opening your conversation with Ally Bob…"),
    ).toBeNull();
    // So does searching in this conversation (⌘F).
    fireEvent.click(
      await screen.findByRole("button", { name: /^Top results/ }),
    );
    fireEvent.click(
      within(await screen.findByRole("group", { name: "People" })).getByRole(
        "option",
        { name: /Ally Bob/ },
      ),
    );
    expect(
      await screen.findByText("Opening your conversation with Ally Bob…"),
    ).toBeVisible();
    mounted.rerender(<SearchResults {...props} scopedChannelId="chat" />);
    expect(signal(4).aborted).toBe(true);
    // Opens that finish after being replaced go nowhere.
    await act(async () => {
      for (const resolve of held) resolve("bob-dm");
    });
    expect(openConversation).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens an existing DM from a person row, and a draft to someone without one", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair(),
    bob = keypair();
  const discovery = [
    metadata(relay, "dm", "opaque", 1700000000, [
      ["hidden", ""],
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
    profile(alice, { display_name: "Alice Chen", name: "ally" }),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  // Alice's cached profile names her DM; Bob is only in the directory.
  const t = peopleSession(owner.session, [
    { pubkey: bob.pubkey, name: "Ally Bob" },
  ]);
  // The relay's DM visibility has loaded and hides nothing.
  await owner.session.channelLifecycle.refreshVisibility();
  expect(owner.session.channelLifecycle.snapshot()).toMatchObject({
    status: "ready",
    hidden: [],
  });
  const openConversation = vi.fn();
  const openNewMessage = vi.fn();
  try {
    render(
      <SearchResults
        session={t.session}
        query="ally"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={openNewMessage}
        openConversation={openConversation}
      />,
    );
    const group = await screen.findByRole("group", { name: "People" });
    // The existing DM is the closer relationship, so it leads.
    await waitFor(() =>
      expect(
        within(group)
          .getAllByRole("option")
          .map((row) => row.querySelector(".text-subtle")?.textContent),
      ).toEqual(["@ally · Direct message", "Start a direct message"]),
    );
    fireEvent.click(within(group).getByRole("option", { name: /Alice Chen/ }));
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("dm");
    expect(t.open).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole("option", { name: /Ally Bob/ }));
    await waitFor(() =>
      expect(openNewMessage).toHaveBeenCalledExactlyOnceWith(bob.pubkey),
    );
    expect(t.open).not.toHaveBeenCalled();
    expect(openConversation).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens a DM from a person row through the confirmed open until the relay's hidden DMs load", async () => {
  // Before the first visibility snapshot, a DM the relay hides looks
  // visible. The confirmed open asks the relay to unhide it, so the sidebar
  // cannot hide the row once the snapshot lands.
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const discovery = [
    metadata(relay, "dm", "opaque", 1700000000, [
      ["hidden", ""],
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
    profile(alice, { display_name: "Alice Chen", name: "ally" }),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) return [];
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  // A username match leaves the DM out of Direct messages, so the person row
  // is what opens it.
  const t = peopleSession(owner.session);
  t.open
    .mockRejectedValueOnce(new Error("Relay refused the DM."))
    .mockResolvedValueOnce("dm");
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={t.session}
        query="ally"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
      />,
    );
    const people = within(await screen.findByRole("group", { name: "People" }));
    const row = await people.findByRole("option", { name: /Alice Chen/ });
    expect(row.querySelector(".text-subtle")?.textContent).toBe(
      "@ally · Direct message",
    );
    expect(owner.session.channelLifecycle.snapshot().status).toBe("idle");
    fireEvent.click(row);
    // A failed open is reported and can be chosen again.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Relay refused the DM.",
    );
    expect(openConversation).not.toHaveBeenCalled();
    fireEvent.click(row);
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("dm"),
    );
    expect(t.open).toHaveBeenCalledTimes(2);
    expect(t.open).toHaveBeenLastCalledWith(
      [alice.pubkey],
      expect.any(AbortSignal),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["loading", "error"] as const)(
  "opens a DM from a person row through the confirmed open while the relay's hidden DMs are %s",
  async (status) => {
    // A refresh keeps the last hidden set, which may be stale, and a failed
    // one never replaces it, so neither shows the DM is still visible.
    const relay = keypair(),
      viewer = keypair(),
      alice = keypair();
    const discovery = [
      metadata(relay, "dm", "opaque", 1700000000, [
        ["hidden", ""],
        ["t", "dm"],
        ["private", ""],
      ]),
      roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
      profile(alice, { display_name: "Alice Chen", name: "ally" }),
    ];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        if (filters.some((filter) => filter.search !== undefined)) return [];
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    const t = peopleSession(owner.session);
    t.open.mockResolvedValueOnce("dm");
    const lifecycle = owner.session.channelLifecycle;
    const visibility = {
      ...lifecycle.snapshot(),
      status,
      hidden: Object.freeze([]),
    };
    const session = {
      ...t.session,
      channelLifecycle: {
        ...lifecycle,
        snapshot: () => visibility,
        subscribe: () => () => {},
      },
    } as typeof t.session;
    const openConversation = vi.fn();
    try {
      render(
        <SearchResults
          session={session}
          query="ally"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={openConversation}
        />,
      );
      const people = within(
        await screen.findByRole("group", { name: "People" }),
      );
      const row = await people.findByRole("option", { name: /Alice Chen/ });
      expect(row.querySelector(".text-subtle")?.textContent).toBe(
        "@ally · Direct message",
      );
      fireEvent.click(row);
      await waitFor(() =>
        expect(openConversation).toHaveBeenCalledExactlyOnceWith("dm"),
      );
      expect(t.open).toHaveBeenCalledExactlyOnceWith(
        [alice.pubkey],
        expect.any(AbortSignal),
      );
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("opens a sidebar-hidden DM from a person row when this connection cannot start DMs", async () => {
  // Relay-signed DM metadata carries NIP-29 `hidden`; the row must still find
  // the DM, or it would ask a connection without DMs to start one.
  const scope = "search-hidden-dm-unavailable";
  writeView(scope, "hidden-dms", [{ id: "dm" }]);
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const discovery = [
    metadata(relay, "dm", "opaque", 1700000000, [
      ["hidden", ""],
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
    profile(alice, { name: "Alice Chen" }),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) return [];
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const open = vi.fn();
  const session = {
    ...owner.session,
    directMessages: {
      ...owner.session.directMessages,
      available: false,
      open,
    },
  } as typeof owner.session;
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={session}
        query="alice"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
        sidebarScope={scope}
      />,
    );
    const people = within(await screen.findByRole("group", { name: "People" }));
    const row = await people.findByRole("option", { name: /Alice Chen/ });
    expect(row.querySelector(".text-subtle")?.textContent).toBe(
      "Direct message",
    );
    fireEvent.click(row);
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("dm"),
    );
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
    clearViewScope(scope);
  }
});

it("lists directory people and managed agents, not agents this community cannot message", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    carol = keypair(),
    stray = keypair(),
    keeper = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query() {
      return [];
    },
  });
  const t = peopleSession(
    owner.session,
    [
      { pubkey: carol.pubkey, name: "Carol" },
      { pubkey: stray.pubkey, name: "Carl Bot", isAgent: true },
    ],
    [{ pubkey: keeper.pubkey, name: "Caretaker", managed: true }],
  );
  const props = {
    session: t.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: () => {},
  };
  try {
    const mounted = render(<SearchResults {...props} query="car" />);
    // The managed agent is known locally before the directory answers.
    expect(
      within(screen.getByRole("group", { name: "Agents" })).getByRole("option"),
    ).toHaveTextContent("Caretaker");
    expect(t.people).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(t.people).toHaveBeenCalledExactlyOnceWith(
      "car",
      1,
      expect.any(AbortSignal),
    );
    expect(
      within(screen.getByRole("group", { name: "People" })).getByRole("option"),
    ).toHaveTextContent("Carol");
    expect(screen.queryByText("Carl Bot")).toBeNull();
    // `#` asks for a channel and an operator for messages: no people. Text
    // longer than the directory accepts reads nothing, so shows no error.
    for (const query of ["#car", "car in:general", `car ${"x".repeat(97)}`]) {
      mounted.rerender(<SearchResults {...props} query={query} />);
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      expect(screen.queryByRole("group", { name: "People" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Agents" })).toBeNull();
      expect(screen.queryByText(/search community people/)).toBeNull();
    }
    expect(t.people).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
  }
});
it("tells uncached directory namesakes apart before a DM opens", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair();
  // The default naming policy, as the bundled plugin registers it.
  const directory = createAgentDirectory();
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query() {
        return [];
      },
    },
    {
      identityNames: {
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [directory],
            subscribe: () => () => {},
          }),
      } as IdentityNames,
    },
  );
  const t = peopleSession(owner.session, [
    { pubkey: first.pubkey, name: "Namesake" },
    { pubkey: second.pubkey, name: "Namesake" },
  ]);
  try {
    render(
      <SearchResults
        session={t.session}
        query="namesake"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const group = await screen.findByRole("group", { name: "People" });
    await waitFor(() =>
      expect(within(group).getAllByRole("option")).toHaveLength(2),
    );
    const labels = within(group)
      .getAllByRole("option")
      .map((row) => row.textContent);
    expect(new Set(labels).size).toBe(2);
    for (const key of [first.pubkey, second.pubkey])
      expect(
        labels.some((label) =>
          label?.includes(`Namesake · ${npubEncode(key).slice(-4)}`),
        ),
      ).toBe(true);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("uses readable owners before key suffixes for agent namesakes", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair(),
    secondOwner = keypair();
  // The default naming policy, as the bundled plugin registers it.
  const directory = createAgentDirectory();
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        return filters.some((filter) => filter.kinds?.includes(0))
          ? [profile(secondOwner, { display_name: "Morgan" })]
          : [];
      },
    },
    {
      identityNames: {
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [directory],
            subscribe: () => () => {},
          }),
      } as IdentityNames,
    },
  );
  const t = peopleSession(
    owner.session,
    [
      {
        pubkey: first.pubkey,
        name: "Namesake",
        isAgent: true,
        ownerPubkey: viewer.pubkey,
      },
      {
        pubkey: second.pubkey,
        name: "Namesake",
        isAgent: true,
        ownerPubkey: secondOwner.pubkey,
      },
    ],
    [
      { pubkey: first.pubkey, name: "Namesake", managed: true },
      { pubkey: second.pubkey, name: "Namesake", managed: true },
    ],
  );
  try {
    render(
      <SearchResults
        session={t.session}
        query="namesake"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    const group = await screen.findByRole("group", { name: "Agents" });
    await waitFor(() =>
      expect(within(group).getAllByRole("option")).toHaveLength(2),
    );
    expect(
      await within(group).findByRole("option", {
        name: /^Morgan’s Namesake/,
      }),
    ).toBeVisible();
    expect(
      within(group).getByRole("option", {
        name: /^NamesakeStart a direct message$/,
      }),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});
it.each([true, false])(
  "leads with a new chat for the viewer's agents, then their chats, then their DMs (Solo=%s)",
  async (solo) => {
    const relay = keypair(),
      viewer = keypair(),
      mine = keypair(),
      fresh = keypair(),
      theirs = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const dm = (id: string, member: string) => [
      metadata(relay, id, "opaque", 1700000000, [
        ["hidden", ""],
        ["t", "dm"],
        ["private", ""],
      ]),
      roster(relay, id, [viewer.pubkey, member]),
    ];
    const chat = (id: string, name: string, at: number, member: string) => [
      metadata(relay, id, name, at, [
        ["t", "stream"],
        ["private"],
        ["t", "buzz.solo"],
      ]),
      roster(relay, id, [viewer.pubkey, member]),
    ];
    const discovery = [
      ...dm("mine-dm", mine.pubkey),
      ...dm("theirs-dm", theirs.pubkey),
      // Scout's chats match by their agent, not their names.
      ...chat("older-chat", "Fix the build", 1700000001, mine.pubkey),
      ...chat("newer-chat", "Plan the week", 1700000002, mine.pubkey),
      ...chat("other-chat", "Unrelated", 1700000003, theirs.pubkey),
      // A channel that matches as well as the agent does.
      metadata(relay, "scout-ops", "scout-ops"),
      roster(relay, "scout-ops", [viewer.pubkey]),
      profile(mine, { name: "Scout", is_agent: true }),
      profile(theirs, { name: "Scooter", is_agent: true }),
      profile(fresh, { name: "Scotia", is_agent: true }),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters) {
        if (filters.some((filter) => filter.search !== undefined)) return [];
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    const source = owner.session.agentChoices;
    const choices = {
      ...source.snapshot(),
      identities: [
        { pubkey: mine.pubkey, name: "Scout", managed: true },
        { pubkey: fresh.pubkey, name: "Scotia", managed: true },
      ],
      selectable: [
        { pubkey: mine.pubkey, name: "Scout", managed: true },
        { pubkey: fresh.pubkey, name: "Scotia", managed: true },
      ],
    };
    const session = {
      ...owner.session,
      agentChoices: {
        ...source,
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
        ensure: () => {},
      },
    } as typeof owner.session;
    const openAgentSession = vi.fn();
    const openConversation = vi.fn();
    try {
      const mounted = render(
        <SearchResults
          session={session}
          query="sco"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={openConversation}
          {...(solo ? { openAgentSession } : {})}
        />,
      );
      const direct = within(
        await screen.findByRole("group", { name: "Direct messages" }),
      );
      expect(
        await direct.findByRole("option", { name: /Scooter/ }),
      ).toBeVisible();
      if (!solo) {
        expect(
          await direct.findByRole("option", { name: /Scout/ }),
        ).toBeVisible();
        // An agent without a DM still offers one, as before.
        const agents = within(
          await screen.findByRole("group", { name: "Agents" }),
        );
        expect(
          agents.getByRole("option", { name: /Scotia/ }),
        ).toHaveTextContent("Start a direct message");
        expect(agents.queryByRole("option", { name: /Scout/ })).toBeNull();
        return;
      }
      const agents = within(
        await screen.findByRole("group", { name: "Agents" }),
      );
      const choice = agents.getByRole("option", { name: /Scout/ });
      expect(choice).toHaveTextContent("New chat");
      // The chats with Scout follow, newest first; the DM comes later.
      const chats = within(await screen.findByRole("group", { name: "Chats" }));
      await waitFor(() =>
        expect(
          chats.getAllByRole("option").map((row) => row.textContent),
        ).toEqual([
          expect.stringContaining("Plan the week"),
          expect.stringContaining("Fix the build"),
        ]),
      );
      expect(chats.getAllByRole("option")[0]).toHaveTextContent(
        "Chat with Scout",
      );
      expect(
        await direct.findByRole("option", { name: /Scout/ }),
      ).toBeVisible();
      await screen.findByRole("group", { name: "Channels" });
      const options = screen.getAllByRole("option");
      expect(options[0]).toBe(choice);
      const at = (name: RegExp) =>
        options.findIndex((row) => name.test(row.textContent ?? ""));
      expect(at(/Plan the week/)).toBeLessThan(at(/scout-ops/));
      expect(at(/Fix the build/)).toBeLessThan(
        options.indexOf(direct.getByRole("option", { name: /Scout/ })),
      );
      // An agent with no DM yet starts a chat too, not a DM.
      expect(agents.getByRole("option", { name: /Scotia/ })).toHaveTextContent(
        "New chat",
      );
      expect(agents.queryByRole("option", { name: /Scooter/ })).toBeNull();
      fireEvent.click(choice);
      expect(openAgentSession).toHaveBeenCalledExactlyOnceWith(mine.pubkey);
      expect(openConversation).not.toHaveBeenCalled();
      // The DM gives way only to a New chat row that shows. "cout" finds
      // the DM by substring but not the agent, so the DM stays.
      mounted.rerender(
        <SearchResults
          session={session}
          query="cout"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={() => {}}
          openConversation={openConversation}
          openAgentSession={openAgentSession}
        />,
      );
      expect(
        await within(
          await screen.findByRole("group", { name: "Direct messages" }),
        ).findByRole("option", { name: /Scout/ }),
      ).toBeVisible();
      expect(screen.queryByRole("group", { name: "Agents" })).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

/**
 * Command-K for a viewer whose Bestie is Scout (DM "bestie-dm", chat "Plan the
 * week") and who also owns Scotia (DM "other-dm", chat "Fix the build").
 * `humans` adds that many DMs with people whose names match "sco" too, and
 * `hideBestieDm` hides Bestie's DM from the sidebar by the relay's list.
 */
function renderBestieSearch({
  query,
  bestieProfile = "Scout",
  humans = 0,
  hideBestieDm = false,
  extraOwnedAgents = 0,
}: {
  query: string;
  bestieProfile?: string;
  humans?: number;
  hideBestieDm?: boolean;
  extraOwnedAgents?: number;
}) {
  const relay = keypair(),
    viewer = keypair(),
    bestie = keypair(),
    other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const dm = (id: string, member: string, at = 1700000000) => [
    metadata(relay, id, "opaque", at, [
      ["hidden", ""],
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, id, [viewer.pubkey, member]),
  ];
  const chat = (id: string, name: string, at: number, member: string) => [
    metadata(relay, id, name, at, [
      ["t", "stream"],
      ["private"],
      ["t", "buzz.solo"],
    ]),
    roster(relay, id, [viewer.pubkey, member]),
  ];
  const people = Array.from({ length: humans }, (_, index) => ({
    key: keypair(),
    name: `Scoby ${String.fromCharCode(97 + index)}`,
  }));
  const extraAgents = Array.from({ length: extraOwnedAgents }, (_, index) => ({
    key: keypair(),
    name: `Scout ${String.fromCharCode(65 + index)}`,
  }));
  const discovery = [
    ...dm("bestie-dm", bestie.pubkey),
    ...dm("other-dm", other.pubkey),
    ...chat("bestie-chat", "Plan the week", 1700000002, bestie.pubkey),
    ...chat("other-chat", "Fix the build", 1700000003, other.pubkey),
    profile(bestie, { name: bestieProfile, is_agent: true }),
    profile(other, { name: "Scotia", is_agent: true }),
    ...extraAgents.flatMap(({ key, name }, index) => [
      ...dm(`extra-agent-dm-${index}`, key.pubkey),
      profile(key, { name, is_agent: true }),
    ]),
    ...people.flatMap(({ key, name }, index) => [
      ...dm(`human-dm-${index}`, key.pubkey, 1700000010 + index),
      profile(key, { name }),
    ]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) return [];
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const source = owner.session.agentChoices;
  const mine = [
    { pubkey: bestie.pubkey, name: "Scout", managed: true },
    { pubkey: other.pubkey, name: "Scotia", managed: true },
    ...extraAgents.map(({ key, name }) => ({
      pubkey: key.pubkey,
      name,
      managed: true,
    })),
  ];
  const choices = { ...source.snapshot(), identities: mine, selectable: mine };
  const lifecycle = owner.session.channelLifecycle;
  const visibility = {
    ...lifecycle.snapshot(),
    status: "ready" as const,
    hidden: Object.freeze(["bestie-dm"]),
  };
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
    ...(hideBestieDm
      ? {
          channelLifecycle: {
            ...lifecycle,
            snapshot: () => visibility,
            subscribe: () => () => {},
          },
        }
      : {}),
  } as typeof owner.session;
  const openAgentSession = vi.fn();
  const openConversation = vi.fn();
  render(
    <BestieConversationContext value={{ session, channelId: "bestie-dm" }}>
      <SearchResults
        session={session}
        query={query}
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
        openAgentSession={openAgentSession}
      />
    </BestieConversationContext>,
  );
  return {
    openAgentSession,
    openConversation,
    dispose: () => {
      cleanup();
      owner.dispose();
    },
  };
}

it("keeps the Bestie DM in Top results when the cut hides its New chat too", async () => {
  // Five better-matching agents put Bestie's New chat sixth, past the five
  // rows Top results shows of its lead group. Its DM is not listed under
  // Direct messages, so Top results must still show it.
  localStorage.clear();
  const { openConversation, dispose } = renderBestieSearch({
    query: "scout",
    bestieProfile: "Z Scout",
    extraOwnedAgents: 5,
  });
  try {
    const agents = within(await screen.findByRole("group", { name: "Agents" }));
    await waitFor(() => {
      const rows = agents.getAllByRole("option").map((row) => row.textContent);
      expect(rows).toEqual([
        ...Array.from({ length: 5 }, () =>
          expect.stringMatching(/Scout [A-E].*New chat/),
        ),
        expect.stringMatching(/Z Scout.*Direct message/),
      ]);
    });
    expect(
      screen.getAllByRole("option", { name: /Z Scout.*Direct message/ }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("option", { name: /Z Scout.*Direct message/ }),
    );
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("bestie-dm");
  } finally {
    dispose();
    localStorage.clear();
  }
});

it("puts the Bestie DM back under its New chat when Agents is shown whole", async () => {
  localStorage.clear();
  const { dispose } = renderBestieSearch({
    query: "scout",
    bestieProfile: "Z Scout",
    extraOwnedAgents: 5,
  });
  try {
    await screen.findByRole("group", { name: "Agents" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Show all Agents" }),
    );
    const expanded = within(screen.getByRole("group", { name: "Agents" }));
    await waitFor(() =>
      expect(
        expanded
          .getAllByRole("option")
          .slice(5, 7)
          .map((row) => row.textContent),
      ).toEqual([
        expect.stringMatching(/Z Scout.*New chat/),
        expect.stringMatching(/Z Scout.*Direct message/),
      ]),
    );
    expect(
      screen.getAllByRole("option", { name: /Z Scout.*Direct message/ }),
    ).toHaveLength(1);
  } finally {
    dispose();
    localStorage.clear();
  }
});

it("keeps the Bestie DM under its New chat when Top results cuts Agents after it", async () => {
  // Four better-matching agents put Bestie's New chat fifth, the last row
  // Top results shows of its lead group; its DM is not listed under Direct
  // messages, so it must stay with that row.
  localStorage.clear();
  const { dispose } = renderBestieSearch({
    query: "scout",
    bestieProfile: "Z Scout",
    extraOwnedAgents: 4,
  });
  try {
    const agents = within(await screen.findByRole("group", { name: "Agents" }));
    await waitFor(() => {
      const rows = agents.getAllByRole("option").map((row) => row.textContent);
      expect(rows.slice(0, 4)).toEqual(
        Array.from({ length: 4 }, () =>
          expect.stringMatching(/Scout [A-D].*New chat/),
        ),
      );
      expect(rows.slice(4)).toEqual([
        expect.stringMatching(/Z Scout.*New chat/),
        expect.stringMatching(/Z Scout.*Direct message/),
      ]);
    });
    expect(
      screen.getAllByRole("option", { name: /Z Scout.*Direct message/ }),
    ).toHaveLength(1);
    // Those six rows are the whole group, so nothing is left to show.
    expect(
      screen.queryByRole("button", { name: "Show all Agents" }),
    ).toBeNull();
  } finally {
    dispose();
    localStorage.clear();
  }
});

it("puts the viewer's Bestie DM right under its new chat, ahead of its chats", async () => {
  const { openAgentSession, openConversation, dispose } = renderBestieSearch({
    query: "sco",
  });
  try {
    const agents = within(await screen.findByRole("group", { name: "Agents" }));
    await waitFor(() =>
      expect(
        agents.getAllByRole("option").map((row) => row.textContent),
      ).toEqual([
        expect.stringMatching(/Scout.*New chat/),
        expect.stringMatching(/Scout.*Direct message/),
        expect.stringMatching(/Scotia.*New chat/),
      ]),
    );
    await screen.findByRole("group", { name: "Chats" });
    const options = screen.getAllByRole("option");
    const bestieDm = agents.getAllByRole("option")[1];
    assert(bestieDm);
    // The DM follows its new chat at once, before any chat.
    expect(options.indexOf(bestieDm)).toBe(1);
    // Other agents keep their chats-then-DM order, and the Bestie DM shows once.
    const direct = within(
      await screen.findByRole("group", { name: "Direct messages" }),
    );
    expect(direct.getByRole("option", { name: /Scotia/ })).toBeVisible();
    expect(direct.queryByRole("option", { name: /Scout/ })).toBeNull();
    fireEvent.click(bestieDm);
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("bestie-dm");
    expect(openAgentSession).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

it.each([
  {
    // "@" finds people, not channel labels, so the DM itself does not match.
    name: "the @ query @scou",
    query: "@scou",
    bestieProfile: "Scout",
    humans: 0,
    label: "Scout",
  },
  {
    // Here Scotia's New chat row shows as well.
    name: "the @ query @sco",
    query: "@sco",
    bestieProfile: "Scout",
    humans: 0,
    label: "Scout",
  },
  {
    // Bestie's profile name differs from its agent name; "sco" finds the
    // agent by that name only, and the DM's label does not match.
    name: "a query that finds Bestie by its agent name only",
    query: "sco",
    bestieProfile: "Trail Guide",
    humans: 0,
    label: "Trail Guide",
  },
  {
    // Eight matching DMs with people rank ahead of the agents' DMs, so with
    // Scotia's DM the Bestie DM falls past the eight Direct messages rows.
    name: "more matching DMs than Direct messages shows",
    query: "sco",
    bestieProfile: "Scout",
    humans: 8,
    label: "Scout",
  },
])(
  "puts the viewer's Bestie DM under its new chat for $name",
  async ({ query, bestieProfile, humans, label }) => {
    const { openAgentSession, openConversation, dispose } = renderBestieSearch({
      query,
      bestieProfile,
      humans,
    });
    try {
      const agents = within(
        await screen.findByRole("group", { name: "Agents" }),
      );
      const newChat = new RegExp(`${label}.*New chat`);
      const direct = new RegExp(`${label}.*Direct message`);
      await waitFor(() => {
        const rows = agents
          .getAllByRole("option")
          .map((row) => row.textContent);
        const at = rows.findIndex((row) => newChat.test(row ?? ""));
        expect(at).toBeGreaterThanOrEqual(0);
        expect(rows[at + 1]).toMatch(direct);
      });
      const rows = agents.getAllByRole("option");
      const at = rows.findIndex((row) => newChat.test(row.textContent ?? ""));
      const [bestieNewChat, bestieDm] = rows.slice(at, at + 2);
      assert(bestieNewChat && bestieDm);
      const options = screen.getAllByRole("option");
      expect(options.indexOf(bestieDm)).toBe(
        options.indexOf(bestieNewChat) + 1,
      );
      // The Bestie DM shows once.
      expect(
        screen
          .getAllByRole("option")
          .filter((row) => direct.test(row.textContent ?? "")),
      ).toEqual([bestieDm]);
      fireEvent.click(bestieDm);
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("bestie-dm");
      expect(openAgentSession).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  },
);

it("promotes no Bestie DM that the sidebar hides", async () => {
  const { dispose } = renderBestieSearch({ query: "sco", hideBestieDm: true });
  try {
    const agents = within(await screen.findByRole("group", { name: "Agents" }));
    const direct = within(
      await screen.findByRole("group", { name: "Direct messages" }),
    );
    await waitFor(() =>
      expect(direct.getByRole("option", { name: /Scotia/ })).toBeVisible(),
    );
    expect(agents.getAllByRole("option").map((row) => row.textContent)).toEqual(
      [
        expect.stringMatching(/Scout.*New chat/),
        expect.stringMatching(/Scotia.*New chat/),
      ],
    );
    expect(direct.queryByRole("option", { name: /Scout/ })).toBeNull();
    expect(
      screen
        .getAllByRole("option")
        .filter((row) => /Scout.*Direct message/.test(row.textContent ?? "")),
    ).toEqual([]);
  } finally {
    dispose();
  }
});

it.each([
  {
    name: "keeps an agent's new chat and chats ahead of a picked channel",
    // The viewer last chose this channel for the same text; Scout matches
    // only part of it, as "Scoo" and the "scoo" chat do.
    picked: "channel:scout-ops",
    exactName: "Scoo",
    groups: ["Agents", "Chats"],
    chats: ["Plan the week", "scoo"],
    first: /Scout.*New chat/,
  },
  {
    name: "puts exact names ahead of an agent's new chat",
    picked: undefined,
    exactName: "Sco",
    // Chats leads with its exact name; Channels and Direct messages have
    // exact names too, so they come before the partly matching agent.
    groups: ["Chats", "Channels", "Direct messages", "Agents"],
    chats: ["sco", "Plan the week"],
    first: /^sco/,
  },
])("$name", async ({ picked, exactName, groups, chats: chatOrder, first }) => {
  localStorage.clear();
  if (picked) recordChoice(usage, "sco", picked);
  const relay = keypair(),
    viewer = keypair(),
    mine = keypair(),
    human = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const lower = exactName.toLowerCase();
  const dm = (id: string, member: string) => [
    metadata(relay, id, "opaque", 1700000000, [
      ["hidden", ""],
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, id, [viewer.pubkey, member]),
  ];
  const chat = (id: string, name: string, at: number, members: string[]) => [
    metadata(relay, id, name, at, [
      ["t", "stream"],
      ["private"],
      ["t", "buzz.solo"],
    ]),
    roster(relay, id, [viewer.pubkey, ...members]),
  ];
  const discovery = [
    ...dm("mine-dm", mine.pubkey),
    ...dm("human-dm", human.pubkey),
    ...chat("agent-chat", "Plan the week", 1700000002, [mine.pubkey]),
    // A chat found by its name, not its agent.
    ...chat("named-chat", lower, 1700000003, []),
    metadata(relay, "scout-ops", "scout-ops"),
    roster(relay, "scout-ops", [viewer.pubkey]),
    metadata(relay, "named-channel", lower),
    roster(relay, "named-channel", [viewer.pubkey]),
    profile(mine, { name: "Scout", is_agent: true }),
    profile(human, { name: exactName }),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) return [];
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const source = owner.session.agentChoices;
  const choices = {
    ...source.snapshot(),
    identities: [{ pubkey: mine.pubkey, name: "Scout", managed: true }],
    selectable: [{ pubkey: mine.pubkey, name: "Scout", managed: true }],
  };
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="sco"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        usageScope={usage}
        openNewMessage={() => {}}
        openConversation={vi.fn()}
        openAgentSession={vi.fn()}
      />,
    );
    const direct = within(
      await screen.findByRole("group", { name: "Direct messages" }),
    );
    await direct.findByRole("option", {
      name: new RegExp(`^${exactName}(?!ut)`),
    });
    await direct.findByRole("option", { name: /Scout/ });
    await screen.findByRole("group", { name: "Channels" });
    await screen.findByRole("group", { name: "Agents" });
    const chats = within(await screen.findByRole("group", { name: "Chats" }));
    await waitFor(() =>
      expect(
        chats.getAllByRole("option").map((row) => row.textContent),
      ).toEqual(chatOrder.map((name) => expect.stringContaining(name))),
    );
    const labels = within(screen.getByRole("listbox"))
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(labels.slice(0, groups.length)).toEqual(groups);
    expect(screen.getAllByRole("option")[0]?.textContent).toMatch(first);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  {
    name: "keeps an exactly named chat ahead of an exact agent's many chats",
    named: "chat" as const,
    groups: ["Agents", "Chats"],
  },
  {
    name: "does not let an exact agent's chats claim an exact name",
    named: "channel" as const,
    // Channels has the exact name; the agent's chats only inherit it.
    groups: ["Agents", "Channels", "Chats"],
  },
])("$name", async ({ named, groups }) => {
  localStorage.clear();
  const relay = keypair(),
    viewer = keypair(),
    mine = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const chat = (id: string, name: string, at: number, members: string[]) => [
    metadata(relay, id, name, at, [
      ["t", "stream"],
      ["private"],
      ["t", "buzz.solo"],
    ]),
    roster(relay, id, [viewer.pubkey, ...members]),
  ];
  const discovery = [
    // More chats with the agent than the group shows, all newer.
    ...Array.from({ length: 9 }, (_, index) =>
      chat(`agent-chat-${index}`, `Task ${index}`, 1700000010 + index, [
        mine.pubkey,
      ]),
    ).flat(),
    ...(named === "chat"
      ? chat("named-chat", "scout", 1700000001, [])
      : [
          metadata(relay, "named-channel", "scout"),
          roster(relay, "named-channel", [viewer.pubkey]),
        ]),
    profile(mine, { name: "Scout", is_agent: true }),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) return [];
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const source = owner.session.agentChoices;
  const choices = {
    ...source.snapshot(),
    identities: [{ pubkey: mine.pubkey, name: "Scout", managed: true }],
    selectable: [{ pubkey: mine.pubkey, name: "Scout", managed: true }],
  };
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="scout"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        usageScope={usage}
        openNewMessage={() => {}}
        openConversation={vi.fn()}
        openAgentSession={vi.fn()}
      />,
    );
    await screen.findByRole("group", { name: "Agents" });
    if (named === "channel")
      await screen.findByRole("group", { name: "Channels" });
    const chats = within(await screen.findByRole("group", { name: "Chats" }));
    // Past the first group, Top results shows three rows of a group.
    await waitFor(() => expect(chats.getAllByRole("option")).toHaveLength(3));
    if (named === "chat")
      expect(chats.getAllByRole("option")[0]).toHaveTextContent(/^scout/);
    const labels = within(screen.getByRole("listbox"))
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(labels.slice(0, groups.length)).toEqual(groups);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("preserves remembered page ranking when inline settings match", async () => {
  localStorage.clear();
  recordChoice(usage, "sound", "Ultrasound");
  const owner = usageSession(["sound-chat"]);
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="sound"
        onQueryChange={() => {}}
        input={createRef()}
        usageScope={usage}
        openNewMessage={() => {}}
        openConversation={() => {}}
        pages={[
          {
            key: "Ultrasound",
            label: "Ultrasound",
            icon: ChatCircleIcon,
            run: open,
          },
        ]}
        inlineSettings={[
          {
            label: "Settings",
            destinations: [
              {
                key: "sound-setting",
                label: "Notifications",
                detail: "Sound",
                rank: 0,
                icon: ChatCircleIcon,
                content: <button type="button">Sound</button>,
                run: vi.fn(),
              },
            ],
          },
        ]}
      />,
    );
    await screen.findByRole("row", { name: /^sound-chat/ });
    const names = screen
      .getAllByRole("rowgroup")
      .map((group) => group.getAttribute("aria-label"));
    expect(names.indexOf("Pages")).toBeLessThan(names.indexOf("Channels"));
    expect(screen.getByRole("row", { name: "Ultrasound" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(open).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it.each([
  ["buzz", "Channels", "buzz-dev", ["IdentityBuzz"]],
  ["buzz", "People", "Buzz Aldrin", ["IdentityBuzz"]],
  [
    "community",
    "Channels",
    "community-news",
    ["ProfileCommunity", "MembershipCommunity admin"],
  ],
  [
    "community",
    "People",
    "Community Lead",
    ["ProfileCommunity", "MembershipCommunity admin"],
  ],
  ["labs", "Channels", "labs-crew", ["ExperimentsLabs"]],
])(
  "leads %s with %s starting with it, ahead of sections found by their Settings group",
  async (query, group, name, sections) => {
    const relay = keypair(),
      viewer = keypair(),
      person = keypair();
    const discovery =
      group === "Channels"
        ? [
            metadata(relay, name, name, 1700000000),
            roster(relay, name, [viewer.pubkey]),
          ]
        : [profile(person, { display_name: name })];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: (filters) =>
        Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        ),
    });
    const t = peopleSession(owner.session);
    const cards = [
      {
        key: "buzz.moderation/membership",
        title: "Membership",
        section: "administration",
      },
      { key: "labs.tools/experiments", title: "Experiments", group: "Labs" },
    ].map((card) => ({
      ...card,
      id: card.key.split("/")[1] ?? "",
      pluginId: card.key.split("/")[0] ?? "",
      revision: "one",
      component: () => null,
    }));
    const settingsCards = {
      subscribe: () => () => {},
      snapshot: () => cards,
      retainVisibility: () => () => {},
    } as unknown as AppServices["settingsCards"];
    const client = {
      selected: "primary",
      memberships: [{ id: "primary", name: "Primary" }],
    };
    const communities = {
      subscribe: () => () => {},
      snapshot: () => client,
    } as unknown as AppServices["communities"];
    const openSection = vi.fn();
    const openConversation = vi.fn();
    const openNewMessage = vi.fn();
    function Palette({ query }: { query: string }) {
      const inlineSettings = useSearchSettings({
        query,
        settingsCards,
        communities,
        navigation: {} as AppServices["navigation"],
        close: () => {},
        openSection,
      });
      return (
        <SearchResults
          session={t.session}
          query={query}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openNewMessage={openNewMessage}
          openConversation={openConversation}
          inlineSettings={inlineSettings}
        />
      );
    }
    try {
      const view = render(<Palette query="" />);
      // The joined list and a profile seen elsewhere are known before the
      // text is typed, so the name match is there when the Settings rows are.
      await waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      await act(async () => owner.session.profiles.ensure([person.pubkey]));
      view.rerender(<Palette query={query} />);
      const [lead] = within(
        screen.getByRole("group", { name: group }),
      ).getAllByRole("option");
      expect(lead).toHaveTextContent(name);
      const groups = screen
        .getAllByRole("group")
        .map((element) => element.getAttribute("aria-label"));
      expect(groups.indexOf(group)).toBeLessThan(groups.indexOf("Settings"));
      const input = screen.getByRole("combobox", { name: "Search Buzz" });
      // The group label still finds its sections, after the name match. Top
      // results shows three of them; the heading shows the rest.
      const seeAll = screen.queryByRole("button", {
        name: "Show all Settings",
      });
      if (seeAll) fireEvent.click(seeAll);
      expect(
        within(screen.getByRole("group", { name: "Settings" }))
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(expect.arrayContaining(sections));
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input).toHaveAttribute("aria-activedescendant", lead?.id);
      fireEvent.keyDown(input, { key: "Enter" });
      // Someone without a DM opens a draft to them; nothing is created.
      await waitFor(() =>
        group === "Channels"
          ? expect(openConversation).toHaveBeenCalledExactlyOnceWith(name)
          : expect(openNewMessage).toHaveBeenCalledExactlyOnceWith(
              person.pubkey,
            ),
      );
      expect(t.open).not.toHaveBeenCalled();
      expect(openSection).not.toHaveBeenCalled();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("holds an early Enter for a person still being found over a section holding the letters only in order", async () => {
  const relay = keypair(),
    viewer = keypair(),
    person = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: () => Promise.resolve([]),
  });
  // Only the directory knows Champa Rao, so the People row lands when it
  // answers.
  const t = peopleSession(owner.session);
  let answer!: () => void;
  t.people.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = () =>
          resolve({
            people: [{ pubkey: person.pubkey, name: "Champa Rao" }],
            hasMore: false,
          });
      }),
  );
  const cards = [
    {
      key: "buzz.channels/templates",
      id: "templates",
      pluginId: "buzz.channels",
      title: "Channel templates",
      group: "App",
      revision: "one",
      component: () => null,
    },
  ];
  const settingsCards = {
    subscribe: () => () => {},
    snapshot: () => cards,
    retainVisibility: () => () => {},
  } as unknown as AppServices["settingsCards"];
  const openSection = vi.fn();
  const openConversation = vi.fn();
  const openNewMessage = vi.fn();
  // "wes" finds Software updates the same way, but in the shipped palette
  // plugin rows still take its early Enter: plugin descriptions hold most
  // names' letters in order. Of the bundled plugins, controls and a member's
  // sections, "champ" matched only Channel templates, so this Enter turns on
  // section matching alone.
  function Palette() {
    const inlineSettings = useSearchSettings({
      query: "champ",
      settingsCards,
      navigation: {} as AppServices["navigation"],
      close: () => {},
      openSection,
    });
    return (
      <SearchResults
        session={t.session}
        query="champ"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={openNewMessage}
        openConversation={openConversation}
        inlineSettings={inlineSettings}
      />
    );
  }
  try {
    render(<Palette />);
    await waitFor(() => expect(t.people).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(openSection).not.toHaveBeenCalled();
    expect(openNewMessage).not.toHaveBeenCalled();
    await act(async () => answer());
    await waitFor(() =>
      expect(openNewMessage).toHaveBeenCalledExactlyOnceWith(person.pubkey),
    );
    expect(t.open).not.toHaveBeenCalled();
    expect(openConversation).not.toHaveBeenCalled();
    expect(openSection).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("excludes proven Huddles but keeps ordinary hits after mutable metadata changes", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  let live: LiveCallbacks | undefined;
  const marker = (id: string, time: number) =>
    metadata(relay, id, id, time, [
      ["t", "stream"],
      ["private"],
      ["P", viewer.pubkey],
      [
        "about",
        "Buzz Huddle (buzz.huddles/v1)\nparent:00000000-0000-4000-8000-000000000001",
      ],
    ]);
  const discovery = [
    marker("hidden", 1700000000),
    signed(viewer, {
      kind: 9007,
      created_at: 1700000000,
      content: "",
      tags: [
        ["h", "hidden"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        [
          "about",
          "Buzz Huddle (buzz.huddles/v1)\nparent:00000000-0000-4000-8000-000000000001",
        ],
      ],
    }),
    metadata(relay, "later", "later"),
    roster(relay, "hidden", [viewer.pubkey]),
    roster(relay, "later", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      return filters.some((filter) => filter.search)
        ? [
            message(viewer, "hidden", "hidden match", 1700000001),
            message(viewer, "later", "later match", 1700000001),
          ]
        : discovery.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          );
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="match"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(screen.queryByRole("option", { name: /hidden match/ })).toBeNull();
    expect(screen.getByRole("option", { name: /later match/ })).toBeVisible();
    act(() => live?.receive([marker("later", 1700000002)]));
    expect(screen.getByRole("option", { name: /later match/ })).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("withholds unknown metadata, then reveals unproven legacy rooms as ordinary destinations", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (filters.some((filter) => filter.search))
        return [
          message(viewer, "room", "match private", 1700000001),
          message(viewer, "ordinary", "match ordinary", 1700000001),
        ];
      if (filters.some((filter) => filter.kinds?.includes(39000))) {
        await gate;
        return [
          metadata(relay, "room", "Room", 1700000000, [
            ["private"],
            [
              "about",
              "Buzz Huddle (buzz.huddles/v1)\nparent:00000000-0000-4000-8000-000000000001",
            ],
          ]),
          metadata(relay, "ordinary", "Ordinary"),
        ];
      }
      if (filters.some((filter) => filter.kinds?.includes(39002)))
        return [
          roster(relay, "room", [viewer.pubkey]),
          roster(relay, "ordinary", [viewer.pubkey]),
        ];
      return [];
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="match"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(owner.session.channels.get?.("room")?.metadataPending).toBe(true);
    expect(
      screen.queryByRole("option", { name: /match private|match ordinary/ }),
    ).toBeNull();
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("option", { name: /match private/ })).toBeVisible();
    expect(
      screen.getByRole("option", { name: /match ordinary/ }),
    ).toBeVisible();
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it("leaves sidebar-hidden DMs out of the rows but keeps their message hits", async () => {
  // The sidebar hides a DM on this device (Hide conversation) or by the
  // relay's DM visibility list. Search reads both, as the sidebar does.
  const scope = "search-hidden-dms";
  writeView(scope, "hidden-dms", [{ id: "local-dm" }]);
  const relay = keypair(),
    viewer = keypair();
  const dms = [
    { id: "local-dm", name: "Scotty", key: keypair() },
    { id: "relay-dm", name: "Scooby", key: keypair() },
    { id: "shown-dm", name: "Scott", key: keypair() },
  ];
  const discovery = dms.flatMap(({ id, key, name }) => [
    metadata(relay, id, "opaque", 1700000000, [
      ["hidden", ""],
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, id, [viewer.pubkey, key.pubkey]),
    profile(key, { name }),
  ]);
  const hits = [
    message(viewer, "local-dm", "sco from local", 1700000001),
    message(viewer, "relay-dm", "sco from relay", 1700000001),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined))
        return filters.some((filter) => filter.kinds?.includes(0)) ? [] : hits;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const lifecycle = owner.session.channelLifecycle;
  const visibility = {
    ...lifecycle.snapshot(),
    status: "ready" as const,
    hidden: Object.freeze(["relay-dm"]),
  };
  // The confirmed open is what restores a hidden DM's sidebar row.
  const open = vi.fn(async () => "local-dm");
  const session = {
    ...owner.session,
    channelLifecycle: {
      ...lifecycle,
      snapshot: () => visibility,
      subscribe: () => () => {},
    },
    directMessages: {
      ...owner.session.directMessages,
      available: true,
      open,
    },
  } as typeof owner.session;
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={session}
        query="sco"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={openConversation}
        sidebarScope={scope}
      />,
    );
    const direct = within(
      await screen.findByRole("group", { name: "Direct messages" }),
    );
    expect(
      await direct.findByRole("option", { name: /^Scott(?!y)/ }),
    ).toBeVisible();
    expect(direct.queryByRole("option", { name: /Scotty/ })).toBeNull();
    expect(direct.queryByRole("option", { name: /Scooby/ })).toBeNull();
    expect(
      await screen.findByRole("option", { name: /sco from local/ }),
    ).toBeVisible();
    expect(
      await screen.findByRole("option", { name: /sco from relay/ }),
    ).toBeVisible();
    // Choosing the person opens the locally hidden DM through the confirmed
    // open, not the plain shortcut that leaves its row hidden.
    const people = within(await screen.findByRole("group", { name: "People" }));
    fireEvent.click(await people.findByRole("option", { name: /Scotty/ }));
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("local-dm"),
    );
    expect(open).toHaveBeenCalledExactlyOnceWith(
      [dms[0]?.key.pubkey],
      expect.any(AbortSignal),
    );
    // So does the DM the relay's visibility snapshot hides.
    open.mockResolvedValueOnce("relay-dm");
    fireEvent.click(await people.findByRole("option", { name: /Scooby/ }));
    await waitFor(() =>
      expect(openConversation).toHaveBeenLastCalledWith("relay-dm"),
    );
    expect(open).toHaveBeenLastCalledWith(
      [dms[1]?.key.pubkey],
      expect.any(AbortSignal),
    );
    expect(open).toHaveBeenCalledTimes(2);
    // When the sidebar restores the row, search follows without remounting.
    act(() => {
      writeView(scope, "hidden-dms", []);
    });
    expect(await direct.findByRole("option", { name: /Scotty/ })).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
    clearViewScope(scope);
  }
});

it("loads verified names for a settled search page in the background and shows them beside the detail", async () => {
  const relay = keypair(),
    viewer = keypair(),
    fake = keypair(),
    newcomer = keypair();
  const reads: {
    subjects: readonly string[] | undefined;
    signal: AbortSignal | undefined;
    release: () => void;
  }[] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false },
    async query(filters, signal) {
      if (!filters.some((filter) => filter.kinds?.includes(30382))) return [];
      await new Promise<void>((release) =>
        reads.push({ subjects: filters[0]?.["#d"], signal, release }),
      );
      return [
        eventDto(
          signed(relay, {
            kind: 30382,
            created_at: 1_000_000,
            content: "",
            tags: [
              ["d", fake.pubkey],
              ["p", fake.pubkey],
              ["active", "true"],
              ["display_name", "fname"],
              ["username", "fname"],
              ["issuer_label", "Block"],
              ["verified_at", "1000000"],
              ["full_name", "Fake Name"],
            ],
          }),
        ),
      ];
    },
  });
  const t = peopleSession(owner.session);
  let settle = () => {};
  const page = new Promise<void>((release) => (settle = release));
  t.people.mockImplementation(async (query?: string) => {
    await page;
    return {
      people: [
        { pubkey: fake.pubkey, name: "Fake" },
        ...(query === "fake na"
          ? [{ pubkey: newcomer.pubkey, name: "Fake Na" }]
          : []),
      ],
      hasMore: false,
    };
  });
  const props = {
    session: t.session,
    onQueryChange() {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openNewMessage: () => {},
    openConversation: vi.fn(),
  };
  try {
    const mounted = render(<SearchResults {...props} query="fake" />);
    await waitFor(() => expect(t.people).toHaveBeenCalled());
    // Nothing verified is read before the page settles.
    expect(reads).toHaveLength(0);
    await act(async () => settle());
    const people = await screen.findByRole("group", { name: "People" });
    await waitFor(() => expect(reads).toHaveLength(1));
    // The page shows its profile names while the verified read is held.
    expect(within(people).getByRole("option")).toHaveTextContent(
      "FakeStart a direct message",
    );
    expect(within(people).getByRole("option")).not.toHaveTextContent("Name");
    await act(async () => reads[0]?.release());
    await waitFor(() =>
      expect(within(people).getByRole("option")).toHaveTextContent(
        /fnameFake Name · Start a direct message$/,
      ),
    );
    // Refining the query keeps the row by its verified full name and does not
    // ask about someone already looked up.
    mounted.rerender(<SearchResults {...props} query="fake n" />);
    await waitFor(() =>
      expect(t.people).toHaveBeenLastCalledWith("fake n", 1, expect.anything()),
    );
    expect(within(people).getByRole("option")).toHaveTextContent("Fake Name");
    // A page with someone new asks only about them, and a newer query
    // cancels that held read.
    mounted.rerender(<SearchResults {...props} query="fake na" />);
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1]?.subjects).toEqual([newcomer.pubkey]);
    mounted.rerender(<SearchResults {...props} query="fake nam" />);
    await waitFor(() => expect(reads[1]?.signal?.aborted).toBe(true));
  } finally {
    for (const read of reads) read.release();
    cleanup();
    owner.dispose();
  }
});

it("reuses shared verified names and reads only the rest of a search page", async () => {
  const relay = keypair(),
    viewer = keypair(),
    known = keypair(),
    fake = keypair();
  const assertion = (subject: string, display: string, full: string) =>
    eventDto(
      signed(relay, {
        kind: 30382,
        created_at: 1_000_000,
        content: "",
        tags: [
          ["d", subject],
          ["p", subject],
          ["active", "true"],
          ["display_name", display],
          ["username", display],
          ["issuer_label", "Block"],
          ["verified_at", "1000000"],
          ["full_name", full],
        ],
      }),
    );
  const searched: (readonly string[] | undefined)[] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false },
    async query(filters) {
      const filter = filters.find((item) => item.kinds?.includes(30382));
      if (!filter) return [];
      searched.push(filter["#d"]);
      // The relay fails this read: the page keeps its profile names.
      throw new ReadError("unavailable", "Relay unavailable");
    },
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles(_filter, sink) {
          sink.event(assertion(known.pubkey, "fother", "Fake Other"));
          sink.eose();
          return () => {};
        },
      };
    },
  });
  const t = peopleSession(owner.session, [
    { pubkey: known.pubkey, name: "Fake" },
    { pubkey: fake.pubkey, name: "Fake" },
  ]);
  try {
    void owner.session.profiles.ensure([known.pubkey]);
    await waitFor(() =>
      expect(
        owner.session.profiles.snapshot().get(known.pubkey)?.verified,
      ).toBeDefined(),
    );
    render(
      <SearchResults
        session={t.session}
        query="fake"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={vi.fn()}
      />,
    );
    await waitFor(() => expect(searched).toEqual([[fake.pubkey]]));
    const people = await screen.findByRole("group", { name: "People" });
    // The shared directory names the known Fake without a search read.
    await waitFor(() =>
      expect(
        within(people)
          .getAllByRole("option")
          .map((row) => row.textContent),
      ).toEqual([
        // The exact profile name ranks first; the failed read keeps it.
        expect.stringMatching(/FakeStart a direct message$/),
        expect.stringMatching(/fotherFake Other · Start a direct message$/),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a row found by its profile name once a verified name replaces it, drops page names when discovery withdraws the authority, and checks again when it returns", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    fake = keypair(),
    other = keypair();
  const advertised = { pubkey: relay.pubkey, multipleIssuers: false };
  let discovery: typeof advertised | null = advertised,
    display = "fname",
    reads = 0;
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: advertised,
    readVerifiedProfileAuthority: async () => discovery && { ...discovery },
    async query(filters) {
      const filter = filters.find((item) => item.kinds?.includes(30382));
      if (!filter?.["#d"]?.includes(fake.pubkey)) return [];
      reads++;
      // No optional full name: only the profile name matches "fake".
      return [
        eventDto(
          signed(relay, {
            kind: 30382,
            created_at: 1_000_000 + reads,
            content: "",
            tags: [
              ["d", fake.pubkey],
              ["p", fake.pubkey],
              ["active", "true"],
              ["display_name", display],
              ["username", display],
              ["issuer_label", "Block"],
              ["verified_at", "1000000"],
            ],
          }),
        ),
      ];
    },
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles: () => () => {},
      };
    },
  });
  const t = peopleSession(owner.session, [
    { pubkey: fake.pubkey, name: "Fake" },
  ]);
  const settle = (ms: number) =>
    act(async () => vi.advanceTimersByTimeAsync(ms));
  const row = () =>
    within(screen.getByRole("group", { name: "People" })).getByRole("option");
  try {
    // Shared demand for someone else arms the discovery refresh.
    void owner.session.profiles.ensure([other.pubkey]);
    render(
      <SearchResults
        session={t.session}
        query="fake"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={vi.fn()}
      />,
    );
    await settle(SEARCH_DEBOUNCE_MS);
    await settle(0);
    expect(row()).toHaveTextContent(/fnameStart a direct message$/);
    discovery = null;
    await settle(5 * 60_000);
    await settle(1_000);
    expect(row()).toHaveTextContent(/FakeStart a direct message$/);
    // The same key, re-enabled, checks the page again instead of restoring
    // what the withdrawn authority checked.
    discovery = advertised;
    display = "knew";
    await settle(5 * 60_000);
    await settle(1_000);
    expect(row()).toHaveTextContent(/knewStart a direct message$/);
    expect(reads).toBe(2);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("labels a row by its verified name over a cached profile name without a naming policy", async () => {
  const relay = keypair(),
    viewer = keypair(),
    fake = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false },
    async query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return [
          eventDto(
            signed(fake, {
              kind: 0,
              created_at: 1_000_000,
              content: JSON.stringify({ name: "fak" }),
              tags: [],
            }),
          ),
        ];
      const filter = filters.find((item) => item.kinds?.includes(30382));
      if (!filter?.["#d"]?.includes(fake.pubkey)) return [];
      return [
        eventDto(
          signed(relay, {
            kind: 30382,
            created_at: 1_000_000,
            content: "",
            tags: [
              ["d", fake.pubkey],
              ["p", fake.pubkey],
              ["active", "true"],
              ["display_name", "fname"],
              ["username", "fname"],
              ["issuer_label", "Block"],
              ["verified_at", "1000000"],
            ],
          }),
        ),
      ];
    },
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles: () => () => {},
      };
    },
  });
  const t = peopleSession(owner.session, [
    { pubkey: fake.pubkey, name: "fak" },
  ]);
  try {
    // The shared profiles hold their kind-0 name but no verified name.
    void owner.session.profiles.ensure([fake.pubkey]);
    await waitFor(() =>
      expect(owner.session.profiles.snapshot().get(fake.pubkey)?.name).toBe(
        "fak",
      ),
    );
    render(
      <SearchResults
        session={t.session}
        query="fak"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={vi.fn()}
      />,
    );
    const people = await screen.findByRole("group", { name: "People" });
    await waitFor(() =>
      expect(within(people).getByRole("option")).toHaveTextContent(
        /fnameStart a direct message$/,
      ),
    );
    expect(owner.session.profiles.snapshot().get(fake.pubkey)?.verified).toBe(
      undefined,
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

/** A session over joined `discovery` whose searches answer `hits`, recording
 * every message read. */
function operatorSession(
  viewer: ReturnType<typeof keypair>,
  relay: ReturnType<typeof keypair>,
  discovery: ReturnType<typeof metadata>[],
  hits: ReturnType<typeof message>[] = [],
) {
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (
        filters.some(
          (filter) => filter.search !== undefined || filter.kinds?.includes(9),
        )
      ) {
        reads.push(filters as Filter[]);
        return hits;
      }
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  return { owner, reads };
}

const operatorProps = {
  onQueryChange: () => {},
  input: createRef<HTMLInputElement>(),
  pages: [],
  openNewMessage: () => {},
  openConversation: () => {},
};

it.each(["from:me", "deploy from:@ME in:#crew "])(
  "searches the viewer's own messages for %s without a people lookup",
  async (query) => {
    const relay = keypair(),
      viewer = keypair();
    const { owner, reads } = operatorSession(
      viewer,
      relay,
      [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
      [message(viewer, "crew", "deploy by me", 1700000001)],
    );
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          {...operatorProps}
        />,
      );
      expect(
        await screen.findByRole("option", { name: /deploy by me/ }),
      ).toBeVisible();
      expect(reads.flat()).toEqual([
        expect.objectContaining({ authors: [viewer.pubkey] }),
      ]);
      expect(screen.queryByText("Searching people…")).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("resolves in:@person to the viewer's direct message with them", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair(),
    bob = keypair();
  const dm = (id: string, person: ReturnType<typeof keypair>) => [
    metadata(relay, id, "opaque", 1700000000, [
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, id, [viewer.pubkey, person.pubkey]),
  ];
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      ...dm("dm-alice", alice),
      ...dm("dm-bob", bob),
      profile(alice, { name: "Alice" }),
      profile(bob, { name: "Bob" }),
    ],
    [message(alice, "dm-alice", "deploy to Alice", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:@alice "
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy to Alice/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([
      expect.objectContaining({ "#h": ["dm-alice"] }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("resolves in:@me to the viewer's self-DM", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      metadata(relay, "self", "opaque", 1700000000, [
        ["t", "dm"],
        ["private", ""],
      ]),
      roster(relay, "self", [viewer.pubkey]),
      metadata(relay, "dm-alice", "opaque", 1700000000, [
        ["t", "dm"],
        ["private", ""],
      ]),
      roster(relay, "dm-alice", [viewer.pubkey, alice.pubkey]),
    ],
    [message(viewer, "self", "deploy note to self", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:@me "
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy note to self/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([expect.objectContaining({ "#h": ["self"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("prefers a live in: channel over an archived namesake", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      metadata(relay, "old", "crew", 1700000000, [
        ["t", "stream"],
        ["archived", "true"],
      ]),
      roster(relay, "old", [viewer.pubkey]),
      metadata(relay, "live", "crew"),
      roster(relay, "live", [viewer.pubkey]),
    ],
    [message(viewer, "live", "deploy live", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#crew "
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy live/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([expect.objectContaining({ "#h": ["live"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

const openChannel = [
  ["public", ""],
  ["t", "stream"],
];

it("prefers a live open in: channel over an archived joined namesake", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      metadata(relay, "old", "crew", 1700000000, [
        ["t", "stream"],
        ["archived", "true"],
      ]),
      roster(relay, "old", [viewer.pubkey]),
      metadata(relay, "open", "crew", 1700000000, openChannel),
    ],
    [message(viewer, "open", "deploy open", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#crew "
        {...operatorProps}
      />,
    );
    await waitFor(() =>
      expect(reads.flat()).toEqual([
        expect.objectContaining({ "#h": ["open"] }),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("refuses a joined in: channel with a live open namesake", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(viewer, relay, [
    metadata(relay, "joined", "crew"),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "open", "crew", 1700000000, openChannel),
  ]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#crew "
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByText(
        "More than one conversation is named “crew”. Search in that conversation instead.",
      ),
    ).toBeVisible();
    expect(reads).toEqual([]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("waits for the exact in: lookup before trusting one cached open namesake", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(viewer, relay, [
    metadata(relay, "team-a", "team", 1700000000, openChannel),
    metadata(relay, "team-b", "team", 1700000000, openChannel),
  ]);
  const searchPublic = owner.session.channels.searchPublic;
  assert.exists(searchPublic);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    // Both namesakes are previewable, but the cache holds only the first.
    const { channels } = await searchPublic("team", { exact: true });
    expect(channels).toHaveLength(2);
    const session = {
      ...owner.session,
      channels: {
        ...owner.session.channels,
        matchPublic: () => channels.slice(0, 1),
        searchPublic: async (...args: Parameters<typeof searchPublic>) => {
          if (args[1]?.exact) lookups++;
          await held;
          return searchPublic(...args);
        },
      },
    };
    vi.useFakeTimers();
    render(
      <SearchResults
        session={session}
        query="deploy in:#team "
        {...operatorProps}
      />,
    );
    // Past both debounces: a resolved channel would have started a read.
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
    expect(lookups).toBe(1);
    expect(reads).toEqual([]);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
    });
    expect(
      screen.getByText(
        "More than one conversation is named “team”. Search in that conversation instead.",
      ),
    ).toBeVisible();
    expect(reads).toEqual([]);
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it.each([
  [
    "deploy in:#crew ",
    "More than one conversation is named “crew”. Search in that conversation instead.",
  ],
  ["deploy in:@nobody ", "No conversation named “@nobody”."],
])("explains an unresolved %s and does not search", async (query, text) => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(viewer, relay, [
    metadata(relay, "one", "crew"),
    roster(relay, "one", [viewer.pubkey]),
    metadata(relay, "two", "crew"),
    roster(relay, "two", [viewer.pubkey]),
  ]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query={query}
        {...operatorProps}
      />,
    );
    // Past the debounce, with the joined list read: any search has started.
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
    expect(screen.getByText(text)).toBeVisible();
    expect(reads).toEqual([]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("sends a phrase with exclusions as a full-text search", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
    [message(viewer, "crew", "the rollback plan for prod", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query={'"rollback plan" -staging on:2023-11-14'}
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /rollback plan for prod/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([
      expect.objectContaining({
        search: '"rollback plan" -staging',
        search_mode: "fulltext",
        since: Math.floor(new Date(2023, 10, 14).getTime() / 1000),
        until: Math.floor(new Date(2023, 10, 15).getTime() / 1000) - 1,
      }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  '"rollback during:october from:me plan"',
  '"-staging"',
  '"OR"',
  'error:"connection refused"',
  'rollback"plan now"',
])(
  "searches the quoted phrase %s as text, not filters or exclusions",
  async (query) => {
    const relay = keypair(),
      viewer = keypair();
    const { owner, reads } = operatorSession(
      viewer,
      relay,
      [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
      [message(viewer, "crew", "quoted phrase hit", 1700000001)],
    );
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          {...operatorProps}
        />,
      );
      expect(
        await screen.findByRole("option", { name: /quoted phrase hit/ }),
      ).toBeVisible();
      // Plain text also searches people; only the message read is in scope.
      expect(
        reads.flat().filter((filter) => filter.kinds?.includes(9)),
      ).toEqual([
        {
          kinds: [40002, 40008, 9],
          search: query,
          search_mode: "fulltext",
          limit: 20,
        },
      ]);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("keeps an author operator typed inside an open quote as phrase text", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
    [message(viewer, "crew", "quoted author text", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query={'"rollback from:alex'}
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /quoted author text/ }),
    ).toBeVisible();
    expect(screen.queryByRole("group", { name: "People" })).toBeNull();
    expect(reads.flat().filter((filter) => filter.kinds?.includes(9))).toEqual([
      expect.objectContaining({
        search: '"rollback from:alex',
        search_mode: "prefix",
      }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("searches a double-hyphen command flag rather than refusing it as an exclusion", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
    [message(viewer, "crew", "run it with --help", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="--help"
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /run it with --help/ }),
    ).toBeVisible();
    expect(reads.flat().filter((filter) => filter.kinds?.includes(9))).toEqual([
      expect.objectContaining({ search: "--help", search_mode: "prefix" }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("asks for a search word when the text only excludes", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(viewer, relay, [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="-staging in:#crew "
        {...operatorProps}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
    expect(
      screen.getByText(
        "Add a word or “phrase” to search for alongside -exclusions.",
      ),
    ).toBeVisible();
    expect(reads).toEqual([]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps chosen filters when ask: is added, and asks with them, across reopening", async () => {
  const relay = keypair(),
    viewer = keypair(),
    agent = keypair();
  const { owner } = operatorSession(viewer, relay, [
    metadata(relay, "bugs", "buzz-bugs"),
    roster(relay, "bugs", [viewer.pubkey]),
  ]);
  const source = owner.session.agentChoices;
  const picked = { pubkey: agent.pubkey, name: "Aria", managed: true };
  const choices = {
    ...source.snapshot(),
    complete: true,
    identities: [picked],
    selectable: [picked],
    archives: { status: "unavailable", archived: [] },
  } as ReturnType<typeof source.snapshot>;
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  const openAsk = vi.fn();
  const input = createRef<HTMLInputElement>();
  // Closing search unmounts the results; the query outlives them.
  let reopen!: () => void;
  function Host() {
    const [query, setQuery] = useState("deploy in:#bu");
    const [opening, setOpening] = useState(0);
    reopen = () => setOpening((count) => count + 1);
    return (
      <SearchResults
        key={opening}
        session={session}
        query={query}
        onQueryChange={setQuery}
        input={input}
        pages={[]}
        openNewMessage={vi.fn()}
        openConversation={vi.fn()}
        openAsk={openAsk}
        sidebarScope={`wss://relay.example:${viewer.pubkey}`}
      />
    );
  }
  try {
    render(<Host />);
    fireEvent.click(
      await within(
        await screen.findByRole("group", { name: "Channels" }),
      ).findByRole("option", { name: /buzz-bugs/ }),
    );
    const chip = screen.getByRole("button", {
      name: "Remove channel buzz-bugs",
    });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "ask: deploy" },
    });
    expect(chip).toBeInTheDocument();
    expect(input.current).toHaveValue("ask: deploy");
    fireEvent.click(await screen.findByRole("option", { name: /Aria/ }));
    expect(openAsk).toHaveBeenCalledWith(
      "in:#buzz-bugs deploy",
      expect.objectContaining({ pubkey: agent.pubkey }),
    );
    // Reopened, the chip and Ask are read back from the remembered query.
    act(() => reopen());
    expect(
      await screen.findByRole("button", { name: "Remove channel buzz-bugs" }),
    ).toBeInTheDocument();
    expect(input.current).toHaveValue("ask: deploy");
    expect(
      screen.getByRole("button", { name: "Remove Ask Aria" }),
    ).toBeInTheDocument();
    // Removing Ask keeps the filter, and the question's words.
    fireEvent.click(screen.getByRole("button", { name: "Remove Ask Aria" }));
    expect(
      screen.getByRole("button", { name: "Remove channel buzz-bugs" }),
    ).toBeInTheDocument();
    expect(input.current).toHaveValue("deploy");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("restores only dates the parser reads as chips, so literal text before ask: stays a search", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner } = operatorSession(viewer, relay, []);
  const input = createRef<HTMLInputElement>();
  try {
    for (const query of [
      "after:soon ask: deploy",
      'during:"release ask: deploy',
    ]) {
      render(
        <SearchResults
          {...operatorProps}
          session={owner.session}
          query={query}
          input={input}
        />,
      );
      expect(input.current).toHaveValue(query);
      expect(
        screen.queryByRole("button", { name: /^Remove Ask/ }),
      ).not.toBeInTheDocument();
      cleanup();
    }
    render(
      <SearchResults
        {...operatorProps}
        session={owner.session}
        query="after:today ask: deploy"
        input={input}
      />,
    );
    expect(input.current).toHaveValue("ask: deploy");
    expect(
      screen.getByRole("button", { name: "Remove date after:today" }),
    ).toBeInTheDocument();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows a recent search's filters by name, and searches again with them as chips", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner } = operatorSession(viewer, relay, [
    metadata(relay, "bugs", "buzz-bugs"),
    roster(relay, "bugs", [viewer.pubkey]),
  ]);
  const usageScope = `recent-chips:${viewer.pubkey}`;
  writeView(usageScope, "search-recent", ["in:bugs deploy"]);
  const input = createRef<HTMLInputElement>();
  function Host() {
    const [query, setQuery] = useState("");
    return (
      <SearchResults
        session={owner.session}
        query={query}
        onQueryChange={setQuery}
        input={input}
        pages={[]}
        openNewMessage={vi.fn()}
        openConversation={vi.fn()}
        usageScope={usageScope}
      />
    );
  }
  try {
    render(<Host />);
    const recents = await screen.findByRole("group", { name: "Recents" });
    const search = await within(recents).findByRole("option", {
      name: /in:#buzz-bugs deploy/,
    });
    // Recent conversations come first, then recent searches.
    expect(
      within(recents)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^buzz-bugs/),
      expect.stringMatching(/in:#buzz-bugs deploy/),
    ]);
    fireEvent.click(search);
    expect(
      await screen.findByRole("button", { name: "Remove channel buzz-bugs" }),
    ).toBeInTheDocument();
    expect(input.current).toHaveValue("deploy");
  } finally {
    cleanup();
    owner.dispose();
    clearViewScope(usageScope);
  }
});

it("holds an early Enter while only Ask is offered, until message search answers", async () => {
  const relay = keypair(),
    viewer = keypair(),
    agent = keypair();
  let answer!: () => void;
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: (filters) =>
      isMessageSearch(filters as Filter[])
        ? new Promise((resolve) => {
            answer = () => resolve([]);
          })
        : Promise.resolve([]),
  });
  const source = owner.session.agentChoices;
  const picked = { pubkey: agent.pubkey, name: "Aria", managed: true };
  const choices = {
    ...source.snapshot(),
    complete: true,
    identities: [picked],
    selectable: [picked],
    archives: { status: "unavailable", archived: [] },
  } as ReturnType<typeof source.snapshot>;
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  const openAsk = vi.fn();
  try {
    render(
      <SearchResults
        session={session}
        query="how do we rotate keys"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={vi.fn()}
        openConversation={vi.fn()}
        openAsk={openAsk}
        sidebarScope={`wss://relay.example:${viewer.pubkey}`}
      />,
    );
    await screen.findByRole("option", { name: /Aria/ });
    await waitFor(() => expect(answer).toBeDefined());
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(openAsk).not.toHaveBeenCalled();
    await act(async () => answer());
    await waitFor(() => expect(openAsk).toHaveBeenCalledOnce());
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows a message hit's resolved mention as a chip and keeps its highlight", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const tomb = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey, tomb.pubkey]),
    profile(tomb, { name: "tomb" }),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="getting"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openNewMessage={() => {}}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    await act(async () =>
      wire
        .next()
        .respond([
          message(viewer, "crew", "ugh @tomb now getting errors", 1700000001, [
            ["p", tomb.pubkey],
          ]),
        ]),
    );
    const row = screen.getByRole("option", { name: /now getting errors/ });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const chip = row.querySelector("[data-mention-kind]");
    expect(chip).toHaveTextContent("tomb");
    expect(chip).toHaveClass(referenceStyles.link ?? "");
    expect(row.querySelector("mark.search-match")).toHaveTextContent("getting");
  } finally {
    cleanup();
    owner.dispose();
  }
});
