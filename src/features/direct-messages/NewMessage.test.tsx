import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
import type { ConversationHostServices } from "../conversation/ConversationHost";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { composerDOMFixture } from "../messages/composer-testing";

import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { PageNavigation } from "../navigation/service";
import userEvent from "@testing-library/user-event";
import type { ChannelSummary, Profile } from "../relay/contracts";
import type { VerifiedProfile } from "../relay/verified-profile";
import type { OutgoingEvent } from "../relay/outbox";
import {
  pickerText,
  readSearchUsage,
  recordChoice,
  recordVisit,
} from "../search/usage";
import {
  abbreviatedPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import type { RelaySession } from "../relay/session";
import { NewMessage } from "./NewMessage";
import { createAgentChoices } from "../agents/choices";
import type { LocalAgentsSnapshot } from "../agents/local";

composerDOMFixture();

const emptyPanels: never[] = [];
const scope = `https://relay.example:${"f".repeat(64)}`;

const people = Array.from({ length: 10 }, (_, index) => ({
  pubkey: (index + 1).toString(16).padStart(64, "0"),
  name: `Person ${index + 1}`,
  ...(index === 1 ? { isAgent: true as const } : {}),
}));
const channel = "11111111-1111-4111-8111-111111111111";
const play = vi.fn(async () => {});
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.parentElement;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        // Supply row and viewport sizes; real scrolling is covered in browsers.
        queueMicrotask(() =>
          this.callback(
            [
              {
                target,
                contentRect: {
                  width: 400,
                  height: target.getAttribute("role") === "listbox" ? 400 : 40,
                },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  play.mockClear();
  vi.stubGlobal(
    "Audio",
    class {
      pause = vi.fn();
      volume = 1;
      play = play;
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  const empty: never[] = [];
  const emoji = { status: "ready", entries: empty };
  const profiles = new Map();
  const channels: { channels: ChannelSummary[] } = { channels: [] };
  const agents = { status: "ready", identities: empty };
  const directMessages = {
    available: true,
    people: vi.fn<RelaySession["directMessages"]["people"]>(async () => ({
      people,
      hasMore: false,
    })),
    open: vi.fn<RelaySession["directMessages"]["open"]>(async () => channel),
    delivered: vi.fn(async () => {}),
    delivery: vi.fn<RelaySession["directMessages"]["delivery"]>(() => "failed"),
    subscribeOpened: () => () => {},
  };
  let operations: readonly OutgoingEvent[] = [];
  const outboxListeners = new Set<() => void>();
  const notifyOutbox = () => {
    for (const listener of outboxListeners) listener();
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(
      (channelId, content, _mentions, _attachments, recovery) => {
        const id = "d".repeat(64);
        operations = [
          {
            event: {
              id,
              pubkey: "f".repeat(64),
              kind: 9,
              content,
              created_at: 1,
              tags: [["h", channelId]],
            },
            delivery: "failed",
            recovery,
          },
        ];
        notifyOutbox();
        return id;
      },
    ),
  };
  const outbox = {
    ready: async () => {},
    snapshot: () => operations,
    subscribe: (listener: () => void) => {
      outboxListeners.add(listener);
      return () => outboxListeners.delete(listener);
    },
    supports: () => true,
    dismiss: vi.fn(async () => {
      operations = [];
      notifyOutbox();
    }),
    recover: async () => {},
    acknowledge: vi.fn(async () => {
      operations = [];
      notifyOutbox();
    }),
  };
  const session = {
    viewer: "f".repeat(64),
    directMessages,
    messages,
    outbox,
    channels: {
      list: () => channels,
      subscribeList: () => () => {},
    },
    profiles: {
      ensure: async () => {},
      snapshot: () => profiles,
      subscribe: () => () => {},
    },
    agentLibrary: {
      snapshot: () => agents,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    emoji: {
      snapshot: () => emoji,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const onOpenThread = vi.fn();
  const onStarted = vi.fn();
  let controlState: LocalAgentsSnapshot = {
    status: "ready",
    agents: [
      {
        pubkey: people[1]?.pubkey ?? "",
        name: people[1]?.name ?? "",
        relayUrl: "https://relay.example",
        owner: "f".repeat(64),
      },
    ],
  };
  const listeners = new Set<() => void>();
  const control = {
    snapshot: () => controlState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: async () => {},
  };
  Object.assign(session, {
    agentChoices: createAgentChoices({
      scope,
      library: session.agentLibrary,
      native: control,
      signal: new AbortController().signal,
    }),
  });
  const mount = (visit?: PageNavigation) =>
    render(
      <NewMessage
        channels={channels.channels}
        host={
          {
            panels: {
              snapshot: () => emptyPanels,
              subscribe: () => () => {},
              resolve: () => undefined,
            },
            relay: {
              snapshot: () => ({ status: "ready", session: session, scope }),
            },
            navigation: { open: vi.fn() },
          } as unknown as ConversationHostServices
        }
        session={session}
        scope={scope}
        visit={visit}
        onOpenThread={onOpenThread}
        onStarted={onStarted}
      />,
    );
  return {
    session,
    channels,
    directMessages,
    messages,
    outbox,
    onOpenThread,
    onStarted,
    mount,
    control,
    updateControl(next: LocalAgentsSnapshot) {
      controlState = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    user: userEvent.setup(),
  };
}
const recipient = () =>
  screen.getByRole("combobox", { name: "Message recipients" });
const send = () => screen.getByRole("button", { name: "Send message" });

it("finds a hosted agent by its owned name and sends without local custody", async () => {
  const t = setup();
  const [owned] = t.control.snapshot().agents;
  assert(owned);
  const hosted = { ...owned, name: "Hosted helper" };
  t.updateControl({ status: "ready", agents: [], hosted: [hosted] });
  t.mount();
  await t.user.type(recipient(), "Hosted helper");
  await t.user.click(
    await screen.findByRole("option", { name: "Person 2, Agent" }),
  );
  expect(t.directMessages.open).not.toHaveBeenCalled();
  expect(t.messages.send).not.toHaveBeenCalled();
  await t.user.type(screen.getByRole("textbox"), "Hello hosted helper");
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.directMessages.open).toHaveBeenCalledWith(
    [hosted.pubkey],
    expect.any(AbortSignal),
  );
  expect(t.messages.send).toHaveBeenCalledOnce();
});

it("revalidates a hosted recipient when its owned evidence disappears", async () => {
  const t = setup();
  const hosted = t.control.snapshot().agents;
  t.updateControl({ status: "ready", agents: [], hosted });
  t.mount();
  await t.user.click(
    await screen.findByRole("option", { name: "Person 2, Agent" }),
  );
  await t.user.type(screen.getByRole("textbox"), "Private draft");
  t.updateControl({ status: "ready", agents: [], hosted: [] });
  await t.user.click(send());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer available",
  );
  expect(t.directMessages.open).not.toHaveBeenCalled();
  expect(t.messages.send).not.toHaveBeenCalled();
});

it("offers only local agents in this community, including cached searches after their list changes", async () => {
  const t = setup();
  const foreign = {
    pubkey: "a".repeat(64),
    name: "Other agent",
    isAgent: true as const,
  };
  const otherCommunity = {
    pubkey: "b".repeat(64),
    name: "Other community agent",
    isAgent: true as const,
  };
  const state = t.control.snapshot();
  t.updateControl({
    ...state,
    agents: [
      ...state.agents,
      {
        pubkey: otherCommunity.pubkey,
        name: otherCommunity.name,
        relayUrl: "https://elsewhere.example",
        owner: "f".repeat(64),
      },
    ],
  });
  t.directMessages.people.mockResolvedValue({
    people: [...people, foreign, otherCommunity],
    hasMore: false,
  });
  t.mount();
  await screen.findByRole("option", { name: "Person 2, Agent" });
  expect(screen.getByRole("option", { name: "Person 1" })).toBeVisible();
  expect(
    screen.queryByRole("option", { name: "Other agent, Agent" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Other community agent, Agent" }),
  ).not.toBeInTheDocument();
  await t.user.type(recipient(), "Other agent");
  await screen.findByText("No matching people.");
  await t.user.clear(recipient());
  expect(
    await screen.findByRole("option", { name: "Person 2, Agent" }),
  ).toBeVisible();
  t.updateControl({ ...state, status: "error", error: "Unavailable" });
  expect(
    screen.queryByRole("option", { name: "Person 2, Agent" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Person 1" })).toBeVisible();
  t.updateControl(state);
  expect(
    await screen.findByRole("option", { name: "Person 2, Agent" }),
  ).toBeVisible();
});

it("appends background pages without reshuffling and ranks new search results", async () => {
  const t = setup();
  const directory = [
    { pubkey: "a".repeat(64), name: "Zoe" },
    { pubkey: "b".repeat(64), name: "Adam Avery" },
    { pubkey: "c".repeat(64), name: "Avery" },
  ];
  let release = () => {};
  const background = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.directMessages.people.mockImplementation(async (query, page) => {
    if (!query && page !== 1) await background;
    return {
      people: query
        ? directory
        : page === 1
          ? directory.slice(0, 2)
          : directory.slice(2),
      hasMore: !query && page === 1,
    };
  });
  t.mount();
  const names = () =>
    screen
      .getAllByRole("option")
      .map((item) => item.getAttribute("aria-label"));
  try {
    await screen.findByRole("option", { name: "Zoe" });
    expect(names()).toEqual(["Adam Avery", "Zoe"]);
  } finally {
    release();
  }
  await screen.findByRole("option", { name: "Avery" });
  expect(names()).toEqual(["Adam Avery", "Zoe", "Avery"]);
  await t.user.type(recipient(), "avery");
  await screen.findByRole("option", { name: "Avery" });
  expect(names()).toEqual(["Avery", "Adam Avery"]);
});

it("retains mounted options and keyboard selection when paging past 100 people", async () => {
  const t = setup();
  const directory = Array.from({ length: 101 }, (_, index) => ({
    pubkey: (index + 100).toString(16).padStart(64, "0"),
    name: `Recipient ${String(index).padStart(3, "0")}`,
  }));
  let release = () => {};
  const background = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.directMessages.people.mockImplementation(async (_query, page) => {
    if (page !== 1) await background;
    return {
      people: page === 1 ? directory.slice(0, 100) : directory.slice(100),
      hasMore: page === 1,
    };
  });
  t.mount();
  try {
    const first = await screen.findByRole("option", { name: "Recipient 000" });
    await t.user.keyboard("{ArrowDown}");
    const activeId = recipient().getAttribute("aria-activedescendant");
    expect(activeId).toBe(first.id);
    release();
    await waitFor(() => expect(first.getAttribute("aria-setsize")).toBe("101"));
    expect(screen.getByRole("option", { name: "Recipient 000" })).toBe(first);
    expect(recipient().getAttribute("aria-activedescendant")).toBe(activeId);
    await t.user.keyboard("{Enter}");
    expect(
      screen.getByRole("button", { name: "Remove Recipient 000" }),
    ).toBeTruthy();
  } finally {
    release();
  }
});

it("highlights the first typed match, so Enter adds it, and keeps it as results arrive", async () => {
  const t = setup();
  const avery = { pubkey: "a".repeat(64), name: "Avery" };
  const ava = { pubkey: "b".repeat(64), name: "Ava" };
  let release = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  // An unfinished directory sends typed text to the relay.
  t.directMessages.people.mockImplementation(async (query, page) => {
    if (!query)
      return page === 1 ? { people, hasMore: true } : new Promise(() => {});
    if (page === 1) return { people: [avery], hasMore: true };
    await later;
    return { people: [ava], hasMore: false };
  });
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  await t.user.type(recipient(), "av");
  const first = await screen.findByRole("option", { name: "Avery" });
  await waitFor(() => expect(first).toHaveAttribute("aria-selected", "true"));
  expect(recipient()).toHaveAttribute("aria-activedescendant", first.id);
  // A later page adds a better-sorting name; it lands below and Enter stays.
  await waitFor(() =>
    expect(t.directMessages.people).toHaveBeenCalledWith(
      "av",
      2,
      expect.any(AbortSignal),
    ),
  );
  release();
  await screen.findByRole("option", { name: "Ava" });
  expect(first).toHaveAttribute("aria-selected", "true");
  await t.user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Remove Avery" })).toBeVisible();
});

it("orders typed matches by exact name, earlier choice, relationship, then usage, and underlines them", async () => {
  const t = setup();
  const person = (letter: string, name: string) => ({
    pubkey: letter.repeat(64),
    name,
  });
  const sam = person("a", "Sam");
  const samantha = person("b", "Samantha");
  const sami = person("c", "Sami");
  const sammy = person("d", "Sammy");
  const samuel = person("e", "Samuel");
  t.directMessages.people.mockResolvedValue({
    people: [samuel, sammy, sami, samantha, sam],
    hasMore: false,
  });
  t.channels.channels = [samantha, sami].map(
    ({ pubkey }, index) =>
      ({
        id: `dm-${index}`,
        name: "",
        channelType: "dm",
        participants: [pubkey],
      }) as ChannelSummary,
  );
  for (let visit = 0; visit < 5; visit++) recordVisit(scope, "channel:dm-1");
  recordChoice(scope, pickerText("dm", "sam"), `person:${sammy.pubkey}`);
  // Command-K's choice for the same text belongs to Command-K.
  recordChoice(scope, "sam", `person:${samuel.pubkey}`);
  t.mount();
  await screen.findByRole("option", { name: "Samuel" });
  await t.user.type(recipient(), "sam");
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("option")
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["Sam", "Sammy", "Sami", "Samantha", "Samuel"]),
  );
  expect(
    screen.getByRole("option", { name: "Samantha" }).querySelector("mark"),
  ).toHaveTextContent(/^Sam$/);
  // Choosing remembers the person for this text, and the same message uses
  // it the next time the text is typed.
  await t.user.click(screen.getByRole("option", { name: "Samuel" }));
  expect(
    readSearchUsage(scope).pick(
      pickerText("dm", "sam"),
      new Set([`person:${samuel.pubkey}`, `person:${sammy.pubkey}`]),
    ),
  ).toBe(`person:${samuel.pubkey}`);
  await t.user.click(screen.getByRole("button", { name: "Remove Samuel" }));
  await t.user.type(recipient(), "sam");
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("option")
        .map((row) => row.getAttribute("aria-label"))
        .slice(0, 2),
    ).toEqual(["Sam", "Samuel"]),
  );
});

it("matches accented names the way the directory finds them", async () => {
  const t = setup();
  const jose = { pubkey: "a".repeat(64), name: "José" };
  const joseph = { pubkey: "b".repeat(64), name: "Joseph" };
  const paros = { pubkey: "c".repeat(64), name: "ΠΑΡΟΣ" };
  const parosKostas = { pubkey: "d".repeat(64), name: "παρος Κώστας" };
  t.directMessages.people.mockResolvedValue({
    people: [joseph, jose, parosKostas, paros],
    hasMore: false,
  });
  t.mount();
  await screen.findByRole("option", { name: "José" });
  await t.user.type(recipient(), "jose");
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("option")
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["José", "Joseph"]),
  );
  expect(
    screen.getByRole("option", { name: "José" }).querySelector("mark"),
  ).toHaveTextContent(/^José$/);
  // A final sigma: typed as shown or in lowercase, the exact name leads.
  for (const text of ["ΠΑΡΟΣ", "παρος"]) {
    await t.user.clear(recipient());
    await t.user.type(recipient(), text);
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("option")
          .map((row) => row.getAttribute("aria-label")),
      ).toEqual(["ΠΑΡΟΣ", "παρος Κώστας"]),
    );
  }
});

it("completes with Space only for one exact name, and with Tab", async () => {
  const t = setup();
  const avery = { pubkey: "a".repeat(64), name: "Avery" };
  const averyChen = { pubkey: "b".repeat(64), name: "Avery Chen" };
  const jose = { pubkey: "c".repeat(64), name: "José" };
  const josefa = { pubkey: "d".repeat(64), name: "Josefa" };
  t.directMessages.people.mockResolvedValue({
    people: [avery, averyChen, jose, josefa],
    hasMore: false,
  });
  t.mount();
  await screen.findByRole("option", { name: "José" });
  // Exact without accents, and no longer name continues it: Space picks.
  await t.user.type(recipient(), "jose");
  await screen.findByRole("option", { name: "Josefa" });
  await t.user.keyboard(" ");
  expect(
    await screen.findByRole("button", { name: "Remove José" }),
  ).toBeVisible();
  expect(recipient()).toHaveValue("");
  // "Avery Chen" continues "avery", so Space is a normal space.
  await t.user.type(recipient(), "avery");
  await screen.findByRole("option", { name: "Avery Chen" });
  await t.user.keyboard(" ");
  expect(recipient()).toHaveValue("avery ");
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  // Tab picks the highlighted row.
  await t.user.keyboard("c");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Avery Chen" })).toHaveAttribute(
      "aria-selected",
      "true",
    ),
  );
  await t.user.keyboard("{Tab}");
  expect(
    await screen.findByRole("button", { name: "Remove Avery Chen" }),
  ).toBeVisible();
  expect(recipient()).toHaveFocus();
  // With recipients chosen and nothing typed, Tab starts composing.
  await t.user.keyboard("{Tab}");
  const composer = screen.getByRole("textbox", {
    name: "Message José, Avery Chen",
  });
  expect(composer).toHaveFocus();
  await t.user.keyboard("Hello");
  expect(composer).toHaveTextContent("Hello");
  expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
});

it("Space waits for a longer name after any word break", async () => {
  const t = setup();
  const avery = { pubkey: "a".repeat(64), name: "Avery" };
  const averyChen = { pubkey: "b".repeat(64), name: "Avery-Chen" };
  t.directMessages.people.mockImplementation(async (_query, page) => {
    if (page === 1) return { people: [avery], hasMore: true };
    if (page === 2) return { people: [averyChen], hasMore: false };
    throw new Error("relay down");
  });
  t.mount();
  await screen.findByRole("option", { name: "Avery" });
  await t.user.type(recipient(), "avery");
  await screen.findByRole("option", { name: "Avery-Chen" });
  await t.user.keyboard(" ");
  expect(recipient()).toHaveValue("avery ");
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
});

it("Space does not pick a one-character name the unread directory could continue", async () => {
  const t = setup();
  const q = { pubkey: "a".repeat(64), name: "Q" };
  t.directMessages.people.mockImplementation(async (query, page) =>
    !query && page === 1
      ? { people: [q], hasMore: true }
      : new Promise(() => {}),
  );
  t.mount();
  await screen.findByRole("option", { name: "Q" });
  await t.user.type(recipient(), "q");
  await screen.findByRole("option", { name: "Q" });
  await t.user.keyboard(" ");
  expect(recipient()).toHaveValue("q ");
  expect(
    screen.queryByRole("button", { name: "Remove Q" }),
  ).not.toBeInTheDocument();
  expect(
    t.directMessages.people.mock.calls.filter(([query]) => query === "q"),
  ).toEqual([]);
});

it("explains the minimum instead of reporting no people for one character", async () => {
  const t = setup();
  t.directMessages.people.mockImplementation(async (query, page) =>
    !query && page === 1
      ? { people: people.slice(0, 1), hasMore: true }
      : new Promise(() => {}),
  );
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  await t.user.type(recipient(), "z");
  expect(
    await screen.findByText("Type at least 2 characters to search people."),
  ).toBeVisible();
  expect(screen.queryByText("No matching people.")).toBeNull();
});

it("Space does not pick while the rest of the list failed to load", async () => {
  const t = setup();
  const kim = { pubkey: "a".repeat(64), name: "Kim" };
  t.directMessages.people.mockImplementation(async (_query, page) => {
    if (page === 1) return { people: [kim], hasMore: true };
    throw new Error("relay down");
  });
  t.mount();
  await screen.findByRole("option", { name: "Kim" });
  await t.user.type(recipient(), "kim");
  await screen.findByRole("option", { name: "Kim" });
  await screen.findByRole("button", { name: /retry|try again/i });
  await t.user.keyboard(" ");
  expect(recipient()).toHaveValue("kim ");
  expect(
    screen.queryByRole("button", { name: "Remove Kim" }),
  ).not.toBeInTheDocument();
});

it("a pointer passing over the people returns Enter to the keyboard's choice when it leaves", async () => {
  const t = setup();
  t.directMessages.people.mockResolvedValue({ people, hasMore: false });
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  await t.user.keyboard("{ArrowDown}");
  const chosen = screen.getByRole("option", { name: "Person 1" });
  const hovered = screen.getByRole("option", { name: "Person 3" });
  await waitFor(() => expect(chosen).toHaveAttribute("aria-selected", "true"));
  for (const clientX of [10, 12])
    fireEvent.pointerMove(hovered, {
      pointerType: "mouse",
      clientX,
      clientY: 10,
    });
  expect(hovered).toHaveAttribute("aria-selected", "true");
  fireEvent.pointerLeave(screen.getByRole("listbox", { name: "People" }), {
    pointerType: "mouse",
  });
  expect(chosen).toHaveAttribute("aria-selected", "true");
  await t.user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Remove Person 1" })).toBeVisible();
});

it("reveals the highlighted person on every arrow key and when the list reopens", async () => {
  const t = setup();
  const scrolled = vi.mocked(Element.prototype.scrollIntoView);
  t.directMessages.people.mockResolvedValue({ people, hasMore: false });
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  await t.user.keyboard("{ArrowUp}");
  const last = screen.getAllByRole("option").at(-1);
  await waitFor(() => expect(last).toHaveAttribute("aria-selected", "true"));
  // At the last row, Down keeps the highlight but still reveals it.
  scrolled.mockClear();
  await t.user.keyboard("{ArrowDown}");
  await waitFor(() => expect(scrolled).toHaveBeenCalled());
  expect(scrolled.mock.contexts.at(-1)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Closing and reopening the list reveals it again.
  await t.user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
  scrolled.mockClear();
  await t.user.click(recipient());
  await waitFor(() => expect(scrolled).toHaveBeenCalled());
  expect(scrolled.mock.contexts.at(-1)).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("stays out of Back history until a message is written, whoever it addresses", async () => {
  const t = setup();
  const passThrough = vi.fn<PageNavigation["passThrough"]>(() => () => {});
  t.mount({ passThrough } as unknown as PageNavigation);
  const passes = passThrough.mock.lastCall?.[0];
  expect(passes?.()).toBe(true);
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  expect(passes?.()).toBe(true);
  await t.user.type(screen.getByRole("textbox"), "Hello");
  expect(passes?.()).toBe(false);
});

it("stays in Back history once a message is written, even if it cannot be saved", async () => {
  const draftStorageKey = `buzz-view.v1:${JSON.stringify([scope, "direct-message:new-draft"])}`;
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key === draftStorageKey)
      throw new DOMException("Storage is full", "QuotaExceededError");
    setItem.call(this, key, value);
  });
  try {
    const t = setup();
    const passThrough = vi.fn<PageNavigation["passThrough"]>(() => () => {});
    t.mount({ passThrough } as unknown as PageNavigation);
    const passes = passThrough.mock.lastCall?.[0];
    await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
    await t.user.type(screen.getByRole("textbox"), "Hello");
    expect(localStorage.getItem(draftStorageKey)).toBeNull();
    expect(passes?.()).toBe(false);
  } finally {
    vi.mocked(Storage.prototype.setItem).mockRestore();
  }
});

it("leaves Back history once its written message is sent", async () => {
  const t = setup();
  const passThrough = vi.fn<PageNavigation["passThrough"]>(() => () => {});
  t.mount({ passThrough } as unknown as PageNavigation);
  const passes = passThrough.mock.lastCall?.[0];
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.type(screen.getByRole("textbox"), "Hello");
  expect(passes?.()).toBe(false);
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  // The sent message is spent; the conversation it started takes its place.
  expect(passes?.()).toBe(true);
});

it("opens blank and focused, adds multiple recipients, deduplicates, and enforces eight", async () => {
  const t = setup();
  t.directMessages.people.mockResolvedValue({
    people: [
      ...people,
      ...people.slice(0, 1),
      { pubkey: "f".repeat(64), name: "Me" },
    ],
    hasMore: false,
  });
  const view = t.mount();
  await waitFor(() => expect(recipient()).toHaveFocus());
  expect(
    view.container.querySelector("[data-new-message-body]"),
  ).toBeEmptyDOMElement();
  expect(screen.getByRole("textbox")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await screen.findByRole("option", { name: "Person 1" });
  expect(screen.queryByRole("option", { name: "Me" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(10);
  await t.user.type(recipient(), "Person 2");
  await screen.findByRole("option", { name: "Person 2, Agent" });
  await t.user.keyboard("{ArrowDown}{Enter}");
  expect(recipient()).toHaveValue("");
  expect(recipient()).toHaveFocus();
  expect(screen.getByRole("button", { name: "Remove Person 2" })).toBeVisible();
  for (let index = 0; index < 7; index++) {
    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
    );
    await t.user.keyboard("{ArrowDown}{Enter}");
  }
  expect(
    screen.getAllByRole("button", { name: /^Remove Person/ }),
  ).toHaveLength(8);
  expect(recipient()).toHaveAttribute("readonly");
  // The eighth pick keeps the list open and swaps it for the limit, since
  // "8 people selected" alone doesn't say eight is the most.
  expect(recipient()).toHaveFocus();
  expect(recipient()).toHaveAttribute("aria-expanded", "true");
  expect(recipient()).toHaveAttribute("placeholder", "8 people selected");
  expect(
    screen.getByText("You can message up to 8 people at once."),
  ).toHaveAttribute("role", "status");
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  await t.user.keyboard("{Tab}");
  expect(screen.getByRole("textbox")).toHaveFocus();
  await t.user.click(recipient());
  expect(
    await screen.findByText("You can message up to 8 people at once."),
  ).toHaveAttribute("role", "status");
  await t.user.keyboard("{Enter}");
  expect(
    screen.getAllByRole("button", { name: /^Remove Person/ }),
  ).toHaveLength(8);
  expect(t.directMessages.open).not.toHaveBeenCalled();
  await t.user.keyboard("{Backspace}");
  expect(
    screen.getAllByRole("button", { name: /^Remove Person/ }),
  ).toHaveLength(7);
  expect(recipient()).not.toHaveAttribute("readonly");
  expect(await screen.findAllByRole("option")).not.toHaveLength(0);
});

it("shows selected recipient artwork without opening or sending, and updates it on removal", async () => {
  const t = setup();
  const view = t.mount();
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  const editor = screen.getByRole("textbox");
  expect(editor.querySelector("[data-placeholder]")).toHaveAttribute(
    "data-placeholder",
    "Message Person 1",
  );
  await t.user.click(
    await screen.findByRole("option", { name: "Person 2, Agent" }),
  );
  expect(editor.querySelector("[data-placeholder]")).toHaveAttribute(
    "data-placeholder",
    "Message Person 1, Person 2",
  );
  const artwork = () => view.container.querySelector("[data-new-message-body]");
  expect(artwork()?.querySelector('[title="Person 1"]')).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  expect(artwork()?.querySelector('[title="Person 2"]')).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await t.user.click(screen.getByRole("button", { name: "Remove Person 1" }));
  expect(artwork()?.querySelector('[title="Person 1"]')).toBeNull();
  expect(artwork()?.querySelector('[title="Person 2"]')).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(editor.querySelector("[data-placeholder]")).toHaveAttribute(
    "data-placeholder",
    "Message Person 2",
  );
  await t.user.click(screen.getByRole("button", { name: "Remove Person 2" }));
  expect(editor.querySelector("[data-placeholder]")).toHaveAttribute(
    "data-placeholder",
    "",
  );
  expect(t.directMessages.open).not.toHaveBeenCalled();
  expect(t.messages.send).not.toHaveBeenCalled();
  expect(t.onOpenThread).not.toHaveBeenCalled();
});

it("requires an arrow key before Enter selects a recipient", async () => {
  const t = setup();
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });

  await t.user.keyboard("{Enter}");
  expect(
    screen.queryByRole("button", { name: "Remove Person 1" }),
  ).not.toBeInTheDocument();

  await t.user.keyboard("{ArrowDown}{Enter}");
  expect(screen.getByRole("button", { name: "Remove Person 1" })).toBeVisible();
});

it("matches an exact public key without exposing short key substrings", async () => {
  const t = setup();
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });

  await t.user.type(recipient(), people[0]?.pubkey ?? "");
  expect(await screen.findByRole("option", { name: "Person 1" })).toBeVisible();
  for (const length of [8, 40]) {
    await t.user.clear(recipient());
    await t.user.type(recipient(), (people[0]?.pubkey ?? "").slice(0, length));
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: "Person 1" }),
      ).not.toBeInTheDocument(),
    );
  }
});

describe.each([
  ["a complete", true],
  ["an incomplete", false],
])("in %s directory", (_directory, complete) => {
  const avery = { pubkey: "a".repeat(64), name: "Avery" };
  it.each([
    ["hex key", avery.pubkey],
    ["npub", npubEncode(avery.pubkey)],
    ["nostr: npub", `nostr:${npubEncode(avery.pubkey)}`],
  ])("finds the person named by a pasted %s", async (_case, key) => {
    const t = setup();
    // A complete directory matches typed text locally; an incomplete one
    // sends it to the relay.
    t.directMessages.people.mockImplementation(async (query, page) => {
      if (!query && complete)
        return { people: [...people, avery], hasMore: false };
      if (!query)
        return page === 1 ? { people, hasMore: true } : new Promise(() => {});
      return { people: complete ? [] : [avery], hasMore: false };
    });
    t.mount();
    await screen.findByRole("option", { name: "Person 1" });
    await t.user.click(recipient());
    await t.user.paste(key);
    expect(await screen.findByRole("option", { name: "Avery" })).toBeVisible();
    expect(screen.queryByText("No matching people.")).toBeNull();
  });
});

it.each([
  ["hex key", (key: string) => key],
  ["npub", (key: string) => npubEncode(key)],
  ["nostr: npub", (key: string) => `nostr:${npubEncode(key)}`],
])(
  "finds a local agent the directory has no profile for by its pasted %s",
  async (_case, form) => {
    const t = setup();
    const owner = "f".repeat(64);
    const local = {
      pubkey: "c".repeat(64),
      name: "Local helper",
      relayUrl: "https://relay.example",
      owner,
    };
    const otherCommunity = {
      pubkey: "e".repeat(64),
      name: "Other community agent",
      relayUrl: "https://elsewhere.example",
      owner,
    };
    t.updateControl({ status: "ready", agents: [local, otherCommunity] });
    t.mount();
    await screen.findByRole("option", { name: "Person 1" });
    await t.user.click(recipient());
    await t.user.paste(form(local.pubkey));
    expect(
      await screen.findByRole("option", { name: "Local helper, Agent" }),
    ).toBeVisible();
    await t.user.clear(recipient());
    await t.user.paste(form(otherCommunity.pubkey));
    await screen.findByText("No matching people.");
    expect(
      screen.queryByRole("option", { name: "Other community agent, Agent" }),
    ).not.toBeInTheDocument();
  },
);

it("matches names from the start of a word, like mentions", async () => {
  const t = setup();
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });

  await t.user.type(recipient(), "erson");
  await waitFor(() =>
    expect(screen.queryAllByRole("option", { name: /^Person/ })).toHaveLength(
      0,
    ),
  );
  await t.user.clear(recipient());
  await t.user.type(recipient(), "1");
  expect(await screen.findByRole("option", { name: "Person 1" })).toBeVisible();
  expect(screen.getByRole("option", { name: "Person 10" })).toBeVisible();
  expect(
    screen.queryByRole("option", { name: "Person 3" }),
  ).not.toBeInTheDocument();
});

it("finds and completes a managed agent by its own name when its profile name differs", async () => {
  const t = setup();
  t.updateControl({
    status: "ready",
    agents: [
      {
        pubkey: people[1]?.pubkey ?? "",
        name: "José",
        relayUrl: "https://relay.example",
        owner: "f".repeat(64),
      },
    ],
  });
  t.mount();
  // Browsing caches the agent under its profile name, Person 2.
  await screen.findByRole("option", { name: "Person 2, Agent" });
  await t.user.type(recipient(), "jose");
  expect(
    await screen.findByRole("option", { name: "Person 2, Agent" }),
  ).toBeVisible();
  expect(screen.queryByRole("option", { name: "Person 1" })).toBeNull();
  // Space completes the agent's own name, as it does a profile name.
  await t.user.keyboard(" ");
  expect(
    await screen.findByRole("button", { name: "Remove Person 2" }),
  ).toBeVisible();
  expect(recipient()).toHaveValue("");
});

it("removes once for pointerdown plus click, then Backspace; effects outlive chips", async () => {
  const t = setup();
  t.mount();
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.click(screen.getByRole("option", { name: "Person 2, Agent" }));
  const control = screen.getByRole("button", { name: "Remove Person 1" });
  fireEvent.pointerDown(control, { button: 0 });
  fireEvent.click(control, { detail: 1, clientX: 123, clientY: 234 });
  expect(
    screen.queryByRole("button", { name: "Remove Person 1" }),
  ).not.toBeInTheDocument();
  expect(play).toHaveBeenCalledOnce();
  const frame = document.querySelector('img[src$="poof1@3x.png"]');
  expect(frame?.parentElement).toHaveStyle({ left: "123px", top: "234px" });
  await t.user.keyboard("{Backspace}");
  expect(
    screen.queryAllByRole("button", { name: /^Remove Person/ }),
  ).toHaveLength(0);
  expect(play).toHaveBeenCalledTimes(2);
  expect(document.querySelectorAll('img[src$="poof1@3x.png"]')).toHaveLength(2);
  expect(recipient()).toHaveFocus();
  await t.user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await t.user.click(screen.getByText("To:"));
  expect(screen.getByRole("listbox")).toBeVisible();
});

it("keeps a failed draft editable and resolves changed recipients again", async () => {
  const t = setup();
  t.mount();
  t.directMessages.delivered.mockRejectedValueOnce(
    new Error("Delivery failed"),
  );
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.type(screen.getByRole("textbox"), "Hello");
  await t.user.click(send());
  expect(await screen.findByRole("alert")).toHaveTextContent("Delivery failed");
  expect(screen.getByRole("textbox")).toHaveTextContent("Hello");
  expect(t.onStarted).not.toHaveBeenCalled();
  await t.user.click(recipient());
  await t.user.click(screen.getByRole("option", { name: "Person 2, Agent" }));
  await t.user.click(send());
  await waitFor(() =>
    expect(t.onStarted).toHaveBeenCalledWith(channel, "d".repeat(64)),
  );
  expect(t.directMessages.open.mock.calls).toEqual([
    [[people[0]?.pubkey], expect.any(AbortSignal)],
    [[people[0]?.pubkey, people[1]?.pubkey], expect.any(AbortSignal)],
  ]);
  expect(t.outbox.dismiss).toHaveBeenCalledOnce();
});

it("holds Send while the To field has text that is not a recipient", async () => {
  const t = setup();
  t.mount();
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.type(screen.getByRole("textbox"), "Hello");
  expect(send()).toBeEnabled();
  const error = "“zz” is not a valid recipient";
  await t.user.type(recipient(), "zz");
  expect(send()).toBeDisabled();
  // No error while the name is typed.
  expect(screen.queryByText(error)).not.toBeInTheDocument();
  await t.user.click(screen.getByRole("textbox"));
  await t.user.keyboard("{Enter}");
  expect(t.directMessages.open).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveTextContent("Hello");
  // Once To is left, the error names its text in a status under the field.
  const hint = within(
    screen.getByRole("group", { name: "Recipients" }),
  ).getByRole("status");
  expect(hint).toHaveTextContent(error);
  expect(hint).toHaveClass("text-body-sm", "text-danger");
  // Back in To it hides with the list open, and shows when Escape closes it.
  await t.user.click(recipient());
  expect(screen.queryByText(error)).not.toBeInTheDocument();
  await t.user.keyboard("{Escape}");
  expect(screen.getByRole("status")).toHaveTextContent(error);
  // Focus stays in To, which the error describes while it shows.
  expect(recipient()).toHaveAccessibleDescription(error);
  // Typing in To, where Escape left focus, removes it, so the status never
  // changes text while shown.
  await t.user.keyboard("z");
  expect(screen.queryByText(/is not a valid recipient/)).toBeNull();
  expect(recipient()).not.toHaveAccessibleDescription();
  await t.user.clear(recipient());
  await t.user.click(screen.getByRole("textbox"));
  expect(screen.queryByText(error)).not.toBeInTheDocument();
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.directMessages.open).toHaveBeenCalledWith(
    [people[0]?.pubkey],
    expect.any(AbortSignal),
  );
});

it("shows the To error only beside a recipient, and clears it once the text becomes one", async () => {
  const t = setup();
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  // With no recipient Send is held anyway, so the closed list shows no error.
  await t.user.type(recipient(), "Person 3");
  await t.user.keyboard("{Escape}");
  expect(screen.queryByText(/is not a valid recipient/)).toBeNull();
  await t.user.clear(recipient());
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.type(recipient(), "Person 3");
  await t.user.click(screen.getByRole("textbox"));
  expect(
    screen.getByText("“Person 3” is not a valid recipient"),
  ).toBeInTheDocument();
  await t.user.click(recipient());
  await t.user.click(screen.getByRole("option", { name: "Person 3" }));
  await t.user.type(screen.getByRole("textbox"), "Hello");
  expect(screen.queryByText(/is not a valid recipient/)).toBeNull();
  expect(send()).toBeEnabled();
});

it("does not hold Send for spaces left in the To field", async () => {
  const t = setup();
  t.mount();
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.type(recipient(), "  ");
  expect(recipient()).toHaveValue("  ");
  await t.user.click(screen.getByRole("textbox"));
  await t.user.keyboard("Hello");
  // Spaces are no name, so they neither hold Send nor raise the To error.
  expect(send()).toBeEnabled();
  expect(
    within(screen.getByRole("group", { name: "Recipients" })).queryByRole(
      "status",
    ),
  ).toBeNull();
});

it("cuts the text named by the To error to 24 characters", async () => {
  const t = setup();
  t.mount();
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.click(recipient());
  await t.user.paste("  Avery Chen and Jordan 👩‍👩‍👧 Lee");
  await t.user.click(screen.getByRole("textbox"));
  // Trimmed, then cut after the 23rd character, which here is an emoji
  // sequence of several code points.
  expect(
    screen.getByText(
      "“Avery Chen and Jordan 👩‍👩‍👧…” is not a valid recipient",
    ),
  ).toBeInTheDocument();
  await t.user.clear(recipient());
  await t.user.paste("Avery Chen and Jordan Le");
  await t.user.click(screen.getByRole("textbox"));
  expect(
    screen.getByText("“Avery Chen and Jordan Le” is not a valid recipient"),
  ).toBeInTheDocument();
});

it("locks during opening and delivery, waits for confirmation, and retries the same uncertain send", async () => {
  const t = setup();
  t.mount();
  let release: (id: string) => void = () => {};
  t.directMessages.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  t.directMessages.delivery.mockReturnValue("unknown");
  t.directMessages.delivered.mockRejectedValueOnce(
    new Error("Delivery uncertain"),
  );
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.type(screen.getByRole("textbox"), "Keep this draft");
  await t.user.dblClick(send());
  expect(t.directMessages.open).toHaveBeenCalledOnce();
  expect(recipient()).toBeDisabled();
  expect(send()).toBeDisabled();
  expect(t.onStarted).not.toHaveBeenCalled();
  release(channel);
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox")).toHaveTextContent("Keep this draft");
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.messages.send).toHaveBeenCalledOnce();
  expect(t.directMessages.open).toHaveBeenCalledOnce();
  expect(t.directMessages.delivered).toHaveBeenCalledTimes(2);
});

it("preserves recipients and draft after opening fails and across remount", async () => {
  const t = setup();
  const view = t.mount();
  t.directMessages.open.mockRejectedValueOnce(new Error("Offline"));
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.type(screen.getByRole("textbox"), "Try later");
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() => expect(send()).toBeEnabled());
  expect(recipient()).not.toHaveFocus();
  expect(
    screen.queryByRole("listbox", { name: "People" }),
  ).not.toBeInTheDocument();
  expect(t.messages.send).not.toHaveBeenCalled();
  view.unmount();
  t.mount();
  expect(screen.getByRole("button", { name: "Remove Person 1" })).toBeVisible();
  expect(screen.getByRole("textbox")).toHaveTextContent("Try later");
  await waitFor(() => expect(send()).toBeEnabled());
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
});

it("filters the completed directory immediately without loading or searching again", async () => {
  const t = setup();
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  const requests = t.directMessages.people.mock.calls.length;
  fireEvent.change(recipient(), { target: { value: "person 3" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: "Person 3" })).toBeVisible();
  expect(
    screen.queryByRole("status", { name: "Loading people" }),
  ).not.toBeInTheDocument();
  fireEvent.change(recipient(), { target: { value: "Nobody" } });
  expect(screen.getByText("No matching people.")).toBeVisible();
  // Drive the remote-search boundary without depending on runner speed.
  vi.useFakeTimers();
  fireEvent.change(recipient(), { target: { value: "Still nobody" } });
  try {
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  } finally {
    vi.useRealTimers();
  }
  expect(t.directMessages.people).toHaveBeenCalledTimes(requests);
});

it("searches again for people added after a completed directory when New message reopens", async () => {
  const t = setup();
  const view = t.mount();
  await screen.findByRole("option", { name: "Person 10" });
  view.unmount();
  const requests = t.directMessages.people.mock.calls.length;
  const colleague = { pubkey: "c".repeat(64), name: "New colleague" };
  t.directMessages.people.mockImplementation(async (query) => ({
    people: [...people, colleague].filter((person) =>
      person.name.toLowerCase().startsWith(query.trim().toLowerCase()),
    ),
    hasMore: false,
  }));
  vi.useFakeTimers();
  try {
    t.mount();
    fireEvent.change(recipient(), { target: { value: "New colleague" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    await act(() => vi.advanceTimersToNextFrame());
    expect(screen.getByRole("option", { name: "New colleague" })).toBeVisible();
    // The reopened list is reused; a completed search is not read again.
    fireEvent.change(recipient(), { target: { value: "" } });
    fireEvent.change(recipient(), { target: { value: "New colleague" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  } finally {
    vi.useRealTimers();
  }
  expect(
    await screen.findByRole("option", { name: "New colleague" }),
  ).toBeVisible();
  expect(t.directMessages.people.mock.calls.slice(requests)).toEqual([
    ["New colleague", 1, expect.any(AbortSignal)],
  ]);
});

it("repeats a search completed during an earlier visit while the directory is incomplete", async () => {
  const t = setup();
  const source = [...people];
  t.directMessages.people.mockImplementation(async (query, page) => {
    if (!query && page === 1)
      return { people: people.slice(0, 1), hasMore: true };
    if (!query) return new Promise(() => {});
    return {
      people: source.filter((person) => person.name.startsWith(query)),
      hasMore: false,
    };
  });
  const view = t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  fireEvent.change(recipient(), { target: { value: "Ali" } });
  await screen.findByText("No matching people.");
  view.unmount();
  const requests = t.directMessages.people.mock.calls.length;
  source.push({ pubkey: "c".repeat(64), name: "Alice" });
  vi.useFakeTimers();
  try {
    t.mount();
    fireEvent.change(recipient(), { target: { value: "Ali" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    await act(() => vi.advanceTimersToNextFrame());
  } finally {
    vi.useRealTimers();
  }
  expect(await screen.findByRole("option", { name: "Alice" })).toBeVisible();
  expect(t.directMessages.people.mock.calls.slice(requests)).toEqual([
    ["Ali", 1, expect.any(AbortSignal)],
  ]);
});

it("browses an empty query but searches an incomplete directory only from two characters", async () => {
  const t = setup();
  t.directMessages.people.mockImplementation(async (query, page) => {
    if (!query)
      return page === 1
        ? { people: people.slice(0, 1), hasMore: true }
        : new Promise(() => {});
    return { people: [], hasMore: false };
  });
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  expect(t.directMessages.people).toHaveBeenCalledWith(
    "",
    1,
    expect.any(AbortSignal),
  );
  const requests = t.directMessages.people.mock.calls.length;
  vi.useFakeTimers();
  try {
    fireEvent.change(recipient(), { target: { value: "P" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(t.directMessages.people).toHaveBeenCalledTimes(requests);
    fireEvent.change(recipient(), { target: { value: "Pe" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  } finally {
    vi.useRealTimers();
  }
  expect(t.directMessages.people.mock.calls.slice(requests)).toEqual([
    ["Pe", 1, expect.any(AbortSignal)],
  ]);
});

it("keeps local matches visible while an incomplete directory searches in the background", async () => {
  const t = setup();
  let release: (value: { people: typeof people; hasMore: boolean }) => void =
    () => {};
  t.directMessages.people.mockImplementation(async (query, page) => {
    if (!query && page === 1)
      return { people: people.slice(0, 1), hasMore: true };
    if (!query) return new Promise(() => {});
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  fireEvent.change(recipient(), { target: { value: "Person" } });
  expect(await screen.findByRole("option", { name: "Person 1" })).toBeVisible();
  expect(
    screen.queryByRole("status", { name: "Loading people" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(t.directMessages.people).toHaveBeenCalledWith(
      "Person",
      1,
      expect.any(AbortSignal),
    ),
  );
  expect(screen.getByRole("option", { name: "Person 1" })).toBeVisible();
  expect(
    screen.queryByRole("status", { name: "Loading people" }),
  ).not.toBeInTheDocument();
  release({ people: people.slice(0, 3), hasMore: false });
  await screen.findByRole("option", { name: "Person 3" });
  expect(screen.getAllByRole("option")).toHaveLength(3);
});

it("loads directory pages on scroll and ignores a late previous search", async () => {
  const t = setup();
  let late: (value: { people: typeof people; hasMore: boolean }) => void =
    () => {};
  t.directMessages.people.mockImplementation(async (query, page) => {
    if (query === "Old")
      return new Promise((resolve) => {
        late = resolve;
      });
    if (query === "Person 2")
      return { people: people.slice(1, 2), hasMore: false };
    if (page > 2) return new Promise(() => {});
    return { people: people.slice(page - 1, page), hasMore: true };
  });
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  fireEvent.scroll(screen.getByRole("listbox"));
  await screen.findByRole("option", { name: "Person 2, Agent" });
  expect(t.directMessages.people).toHaveBeenCalledWith(
    "",
    2,
    expect.any(AbortSignal),
  );
  await t.user.type(recipient(), "Old");
  await waitFor(() =>
    expect(t.directMessages.people).toHaveBeenCalledWith(
      "Old",
      1,
      expect.any(AbortSignal),
    ),
  );
  await t.user.clear(recipient());
  await t.user.type(recipient(), "Person 2");
  await screen.findByRole("option", { name: "Person 2, Agent" });
  late({ people: people.slice(0, 1), hasMore: false });
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
  expect(
    await screen.findByRole("option", { name: "Person 2, Agent" }),
  ).toBeVisible();
});

it("keeps loaded pages when clearing search or returning to New message, scoped to the session", async () => {
  const t = setup();
  t.directMessages.people.mockImplementation(async (query, page) => ({
    people: query ? people.slice(2, 3) : people.slice(page - 1, page),
    hasMore: !query && page < 3,
  }));
  const view = t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  fireEvent.scroll(screen.getByRole("listbox"));
  await screen.findByRole("option", { name: "Person 2, Agent" });
  const loaded = screen.getAllByRole("option").map((row) => row.textContent);
  await t.user.type(recipient(), "Person 3");
  await screen.findByRole("option", { name: "Person 3" });
  await t.user.clear(recipient());
  await waitFor(() =>
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      loaded,
    ),
  );
  const requests = t.directMessages.people.mock.calls.length;
  view.unmount();
  const reopened = t.mount();
  await waitFor(() => expect(recipient()).toBeEnabled());
  await waitFor(() =>
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      loaded,
    ),
  );
  await screen.findByRole("option", { name: "Person 3" });
  expect(t.directMessages.people).toHaveBeenCalledTimes(requests + 1);
  expect(t.directMessages.people).toHaveBeenLastCalledWith(
    "",
    3,
    expect.any(AbortSignal),
  );
  reopened.unmount();
  const other = setup();
  other.directMessages.people.mockResolvedValue({ people: [], hasMore: false });
  other.mount();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  await screen.findByText("No matching people.");
});

it("keeps searching past pages of excluded agents and never announces a false empty result", async () => {
  const t = setup();
  const foreign = {
    pubkey: "a".repeat(64),
    name: "Cy agent",
    isAgent: true as const,
  };
  const human = { pubkey: "b".repeat(64), name: "Cynthia" };
  let release: (value: { people: (typeof human)[]; hasMore: boolean }) => void =
    () => {};
  t.directMessages.people.mockImplementation(async (query, page) => {
    if (!query) return new Promise(() => {});
    if (page === 1) return { people: [foreign], hasMore: true };
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  t.mount();
  await waitFor(() => expect(recipient()).toBeEnabled());
  await t.user.type(recipient(), "Cy");
  await waitFor(() =>
    expect(t.directMessages.people).toHaveBeenCalledWith(
      "Cy",
      2,
      expect.any(AbortSignal),
    ),
  );
  expect(screen.queryByText("No matching people.")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Load more people" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Loading people" })).toBeVisible();
  release({ people: [human], hasMore: false });
  await screen.findByRole("option", { name: "Cynthia" });
  expect(
    screen.queryByRole("status", { name: "Loading people" }),
  ).not.toBeInTheDocument();
});

it("preserves the preview on background failure and retries the same page without duplicate rows", async () => {
  const t = setup();
  t.directMessages.people
    .mockResolvedValueOnce({ people: people.slice(0, 2), hasMore: true })
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ people: people.slice(0, 3), hasMore: false });
  t.mount();
  await screen.findByRole("option", { name: "Person 1" });
  await screen.findByRole("alert");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(t.directMessages.people).toHaveBeenCalledTimes(2);
  await t.user.click(
    screen.getByRole("button", { name: "Retry loading people" }),
  );
  await screen.findByRole("option", { name: "Person 3" });
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(t.directMessages.people.mock.calls.map(([, page]) => page)).toEqual([
    1, 2, 2,
  ]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("cancels opening on page exit and does not send after a late response", async () => {
  const t = setup();
  let release: (id: string) => void = () => {};
  t.directMessages.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = t.mount();
  await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
  await t.user.type(screen.getByRole("textbox"), "Keep for later");
  await t.user.click(send());
  view.unmount();
  expect(t.directMessages.open.mock.calls[0]?.[1].aborted).toBe(true);
  release(channel);
  await waitFor(() => expect(t.messages.send).not.toHaveBeenCalled());
  t.mount();
  expect(screen.getByRole("textbox")).toHaveTextContent("Keep for later");
  expect(t.onStarted).not.toHaveBeenCalled();
});

it.each(["removed", "loading", "error"] as const)(
  "revalidates selected and restored agents before a fresh send: %s",
  async (state) => {
    const t = setup();
    const mounted = t.mount();
    await t.user.click(
      await screen.findByRole("option", { name: "Person 2, Agent" }),
    );
    await t.user.type(screen.getByRole("textbox"), "Private draft");
    const current = t.control.snapshot();
    t.updateControl({
      ...current,
      status: state === "removed" ? "ready" : state,
      agents: [],
    });
    await t.user.click(send());
    await screen.findByRole("alert");
    expect(t.directMessages.open).not.toHaveBeenCalled();
    expect(t.messages.send).not.toHaveBeenCalled();
    mounted.unmount();
    t.mount();
    await waitFor(() => expect(send()).toBeEnabled());
    await t.user.click(send());
    await screen.findByRole("alert");
    expect(t.directMessages.open).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveTextContent("Private draft");
  },
);

it("checks local agents again after opening and leaves queued retries alone", async () => {
  const t = setup();
  let opened: (id: string) => void = () => {};
  t.directMessages.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        opened = resolve;
      }),
  );
  t.mount();
  await t.user.click(
    await screen.findByRole("option", { name: "Person 2, Agent" }),
  );
  await t.user.type(screen.getByRole("textbox"), "Private draft");
  await t.user.click(send());
  const previous = t.control.snapshot();
  t.updateControl({ ...previous, status: "loading" });
  opened(channel);
  await screen.findByRole("alert");
  expect(t.messages.send).not.toHaveBeenCalled();
  t.updateControl(previous);
  t.directMessages.delivery.mockReturnValue("unknown");
  t.directMessages.delivered.mockRejectedValueOnce(new Error("Uncertain"));
  await t.user.click(send());
  await screen.findByRole("button", { name: "Retry send" });
  t.updateControl({ ...previous, status: "error" });
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.messages.send).toHaveBeenCalledOnce();
});

it("distinguishes namesake options and chips without pictures", async () => {
  const t = setup();
  const same = people
    .slice(2, 4)
    .map((person) => ({ ...person, name: "Chris" }));
  const labels = publicKeyLabels(same.map((person) => person.pubkey));
  t.directMessages.people.mockResolvedValue({ people: same, hasMore: false });
  t.mount();
  for (const person of same) {
    const discriminator = labels.get(person.pubkey);
    assert.exists(discriminator);
    const label = `Chris ${discriminator}`;
    const option = await screen.findByRole("option", { name: label });
    expect(option).toHaveTextContent(discriminator);
    await t.user.click(option);
    expect(
      screen.getByRole("button", { name: `Remove ${label}` }).parentElement,
    ).toHaveTextContent(discriminator);
  }
  await t.user.type(recipient(), "Nobody");
  for (const person of same)
    expect(
      screen.getByRole("button", {
        name: `Remove Chris ${labels.get(person.pubkey)}`,
      }),
    ).toBeVisible();
});

it("surfaces exhausted directory cancellation without a UI retry loop", async () => {
  const t = setup();
  t.directMessages.people.mockRejectedValueOnce(
    new DOMException("Stale directory read", "AbortError"),
  );
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    t.mount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load people.",
    );
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(t.directMessages.people).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("status", { name: "Loading people" }),
    ).not.toBeInTheDocument();
  } finally {
    cleanup();
    warning.mockRestore();
    vi.useRealTimers();
  }
});

it("revalidates an unchanged definitively failed agent send before retry", async () => {
  const t = setup();
  t.mount();
  await t.user.click(
    await screen.findByRole("option", { name: "Person 2, Agent" }),
  );
  await t.user.type(screen.getByRole("textbox"), "Private draft");
  t.directMessages.delivered.mockRejectedValueOnce(new Error("Not sent"));
  await t.user.click(send());
  await screen.findByRole("alert");
  t.updateControl({ ...t.control.snapshot(), status: "error" });
  await t.user.click(send());
  expect(t.directMessages.delivered).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
});

it("retains an older build's pending pointer as confirmation-only recovery", async () => {
  const t = setup();
  const person = people[0];
  assert.exists(person);
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([scope, "direct-message:recipients"])}`,
    JSON.stringify([people[0]]),
  );
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([scope, "direct-message:pending"])}`,
    JSON.stringify({
      id: "d".repeat(64),
      channelId: channel,
      recipients: person.pubkey,
      draft: { text: "Old uncertain message", recipients: [] },
    }),
  );
  t.directMessages.delivery.mockReturnValue(undefined);
  t.directMessages.delivered.mockRejectedValue(
    new Error("Could not confirm earlier delivery"),
  );
  t.mount();
  await waitFor(() => expect(send()).toBeEnabled());
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await screen.findByRole("alert");
  expect(t.messages.send).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Remove Person 1" }),
  ).toBeDisabled();
});

it("retires a confirmed legacy message when the page stays mounted", async () => {
  const t = setup();
  const person = people[0];
  assert.exists(person);
  const storageKey = (key: string) =>
    `buzz-view.v1:${JSON.stringify([scope, key])}`;
  localStorage.setItem(
    storageKey("direct-message:recipients"),
    JSON.stringify([person]),
  );
  localStorage.setItem(
    storageKey("direct-message:pending"),
    JSON.stringify({
      id: "d".repeat(64),
      channelId: channel,
      recipients: person.pubkey,
      draft: { text: "Already sent legacy message", recipients: [] },
    }),
  );
  // No journal entry backs the legacy record, so delivery is never recorded.
  t.directMessages.delivery.mockReturnValue(undefined);
  t.mount();
  await t.user.click(await screen.findByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(
    screen.queryByRole("button", { name: "Remove Person 1" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).not.toHaveTextContent(
    "Already sent legacy message",
  );
  expect(send()).toBeDisabled();
  expect(t.messages.send).not.toHaveBeenCalled();
});

it("can retry legacy confirmation after partial saved-view cleanup fails", async () => {
  const t = setup();
  const person = people[0];
  assert.exists(person);
  const storageKey = (key: string) =>
    `buzz-view.v1:${JSON.stringify([scope, key])}`;
  localStorage.setItem(
    storageKey("direct-message:recipients"),
    JSON.stringify([person]),
  );
  const pointerKey = storageKey("direct-message:pending");
  localStorage.setItem(
    pointerKey,
    JSON.stringify({
      id: "d".repeat(64),
      channelId: channel,
      recipients: person.pubkey,
      draft: { text: "Confirmed legacy draft", recipients: [] },
    }),
  );
  t.directMessages.delivery.mockReturnValue("accepted");
  const removeItem = Storage.prototype.removeItem;
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(function (this: Storage, key) {
      if (key === pointerKey) throw new Error("Cannot clear pointer");
      removeItem.call(this, key);
    });
  const page = t.mount();
  try {
    await t.user.click(
      await screen.findByRole("button", { name: "Retry send" }),
    );
    await screen.findByRole("alert");
    page.unmount();
    t.mount();
    await screen.findByRole("button", { name: "Retry send" });
  } finally {
    remove.mockRestore();
  }
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.messages.send).not.toHaveBeenCalled();
  expect(localStorage.getItem(pointerKey)).toBeNull();
});

it.each([
  { archived: true },
  { cached: true },
  { readOnly: true },
  { pending: true },
  { members: ["f".repeat(64)] },
  { channelType: "stream" },
] as Partial<ChannelSummary>[])(
  "does not preview a nonmatching or unavailable DM: %j",
  async (override) => {
    const t = setup();
    t.channels.channels = [
      {
        id: channel,
        name: "Unavailable",
        channelType: "dm",
        members: ["f".repeat(64), people[0]?.pubkey ?? ""],
        ...override,
      },
    ];
    const view = t.mount();
    await t.user.click(await screen.findByRole("option", { name: "Person 1" }));
    expect(
      view.container.querySelector(
        '[data-new-message-body] [title="Person 1"]',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Channel message history" }),
    ).not.toBeInTheDocument();
    expect(t.directMessages.open).not.toHaveBeenCalled();
  },
);

const verifiedAs = (
  displayName: string,
  username: string,
  fullName?: string,
): VerifiedProfile => ({
  displayName,
  username,
  ...(fullName ? { fullName } : {}),
  issuerLabel: "Block",
  verifiedAt: 1,
  status: "checked",
  multipleIssuers: false,
});
/** A community verifying names with `answers`. Its reads wait for `held`, and
 * `change` swaps or withdraws its authority. */
function verifying(
  t: ReturnType<typeof setup>,
  answers: ReadonlyMap<string, VerifiedProfile>,
  held: Promise<void> = Promise.resolve(),
) {
  let authority: { pubkey: string; multipleIssuers: boolean } | undefined = {
    pubkey: "9".repeat(64),
    multipleIssuers: false,
  };
  const listeners = new Set<() => void>();
  Object.assign(t.session.profiles, {
    verifiedAuthority: () => authority,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const verified = vi.fn(async (pubkeys: readonly string[]) => {
    await held;
    return {
      authority,
      profiles: new Map(
        pubkeys.flatMap((pubkey) => {
          const answer = answers.get(pubkey);
          return answer ? [[pubkey, answer] as const] : [];
        }),
      ),
    };
  });
  Object.assign(t.directMessages, { verified });
  return {
    verified,
    change(next: typeof authority) {
      authority = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}
const aleksandr = { pubkey: "a".repeat(64), name: "jack" };
const petrov = verifiedAs("Aleksandr", "aleksandr", "Aleksandr Petrov");
const petrovRow = { name: "Aleksandr, Aleksandr Petrov · @aleksandr" };

it("labels people by verified identity, never an editable handle, and opens the chosen key", async () => {
  const t = setup();
  // An unverified "jack" whose handle imitates the verified one, and a
  // verified "jack" whose handle equals its name.
  const imitator = {
    pubkey: "b".repeat(64),
    name: "jack",
    username: "aleksandr",
  };
  const realJack = { pubkey: "c".repeat(64), name: "Jack" };
  t.directMessages.people.mockResolvedValue({
    people: [aleksandr, imitator, realJack],
    hasMore: false,
  });
  verifying(
    t,
    new Map([
      [aleksandr.pubkey, petrov],
      [realJack.pubkey, verifiedAs("jack", "jack")],
    ]),
  );
  const labels = publicKeyLabels([imitator.pubkey, realJack.pubkey]);
  t.mount();
  await waitFor(() => expect(recipient()).toBeEnabled());
  await t.user.type(recipient(), "jack");
  await screen.findByRole("option", petrovRow);
  expect(
    screen.getByRole("option", { name: `jack ${labels.get(imitator.pubkey)}` }),
  ).not.toHaveTextContent("@");
  screen.getByRole("option", {
    name: `jack ${labels.get(realJack.pubkey)}, @jack`,
  });
  // Found by the editable "jack", Aleksandr is that name's namesake: Space
  // has no single exact name to pick.
  await t.user.keyboard(" ");
  expect(recipient()).toHaveValue("jack ");
  await t.user.click(screen.getByRole("option", petrovRow));
  await t.user.type(screen.getByRole("textbox"), "Hello");
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.directMessages.open).toHaveBeenCalledWith(
    [aleksandr.pubkey],
    expect.any(AbortSignal),
  );
});

it.each([
  ["the shared profiles", true],
  ["an earlier page", false],
])(
  "finds people verified by %s by their verified name, handle or full name",
  async (_source, shared) => {
    const t = setup();
    if (shared) {
      const profiles = t.session.profiles.snapshot() as Map<string, Profile>;
      profiles.set(aleksandr.pubkey, { ...aleksandr, verified: petrov });
    }
    // The directory finds them only by the editable name, and only in the browse.
    t.directMessages.people.mockImplementation(async (query) => ({
      people: shared || query.trim() ? [] : [aleksandr],
      hasMore: false,
    }));
    verifying(t, shared ? new Map() : new Map([[aleksandr.pubkey, petrov]]));
    t.mount();
    await waitFor(() => expect(recipient()).toBeEnabled());
    for (const text of ["aleksandr", "petrov"]) {
      await t.user.clear(recipient());
      await t.user.type(recipient(), text);
      expect(await screen.findByRole("option", petrovRow)).toBeVisible();
    }
  },
);

it("relabels a recipient whose verification answers late, keeping a failed send's error", async () => {
  const t = setup();
  t.directMessages.people.mockResolvedValue({
    people: [aleksandr],
    hasMore: false,
  });
  let release = () => {};
  verifying(
    t,
    new Map([[aleksandr.pubkey, petrov]]),
    new Promise<void>((resolve) => (release = resolve)),
  );
  t.directMessages.open.mockRejectedValueOnce(new Error("Offline"));
  t.mount();
  await waitFor(() => expect(recipient()).toBeEnabled());
  await t.user.click(await screen.findByRole("option", { name: "jack" }));
  await t.user.type(screen.getByRole("textbox"), "Hello");
  await t.user.click(send());
  await screen.findByRole("alert");
  release();
  await screen.findByRole("button", { name: "Remove Aleksandr" });
  screen.getByRole("textbox", { name: "Message Aleksandr" });
  expect(screen.getByRole("alert")).toBeVisible();
});

it.each([
  ["the browsed profile name", true],
  ["the key", false],
])(
  "names a chosen recipient by %s once verification is withdrawn, then by a current profile",
  async (_fallback, browsed) => {
    const t = setup();
    // Shared heads replace the profile name with the verified one.
    let shared = new Map<string, Profile>([
      [aleksandr.pubkey, { name: "Aleksandr", verified: petrov }],
    ]);
    Object.assign(t.session.profiles, { snapshot: () => shared });
    t.directMessages.people.mockResolvedValue({
      people: browsed ? [aleksandr] : [],
      hasMore: false,
    });
    const { change } = verifying(t, new Map());
    t.mount();
    await waitFor(() => expect(recipient()).toBeEnabled());
    if (browsed) await screen.findByRole("option", petrovRow);
    await t.user.type(recipient(), "aleks");
    await t.user.click(await screen.findByRole("option", petrovRow));
    shared = new Map();
    change(undefined);
    const name = browsed ? "jack" : abbreviatedPublicKey(aleksandr.pubkey);
    await screen.findByRole("button", { name: `Remove ${name}` });
    screen.getByRole("textbox", { name: `Message ${name}` });
    shared = new Map([[aleksandr.pubkey, { name: "Jack Editable" }]]);
    change(undefined);
    await screen.findByRole("button", { name: "Remove Jack Editable" });
  },
);

it("searches and labels by profile names on a relay without verified identity", async () => {
  const t = setup();
  const imitator = {
    pubkey: "b".repeat(64),
    name: "jack",
    username: "aleksandr",
  };
  const labels = publicKeyLabels([aleksandr.pubkey, imitator.pubkey]);
  t.directMessages.people.mockResolvedValue({
    people: [aleksandr, imitator],
    hasMore: false,
  });
  expect(t.session.profiles.verifiedAuthority).toBeUndefined();
  expect("verified" in t.directMessages).toBe(false);
  t.mount();
  await waitFor(() => expect(recipient()).toBeEnabled());
  await t.user.type(recipient(), "jack");
  for (const person of [aleksandr, imitator])
    expect(
      await screen.findByRole("option", {
        name: `jack ${labels.get(person.pubkey)}`,
      }),
    ).not.toHaveTextContent("@");
  await t.user.click(
    screen.getByRole("option", { name: `jack ${labels.get(imitator.pubkey)}` }),
  );
  screen.getByRole("textbox", { name: "Message jack" });
});
