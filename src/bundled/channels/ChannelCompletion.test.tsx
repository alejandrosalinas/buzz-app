import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { CompletionResult } from "../../features/conversation/contracts";
import type {
  ChannelList,
  ChannelSummary,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { scanMarkdown } from "../../features/relay/message-content";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { LinkLabel } from "../links/InlineLink";
import { ChannelCompletion } from "./ChannelCompletion";
import {
  chosenWorkspace,
  WorkspaceCompletion,
  type WorkspaceCompletionTarget,
} from "../../features/conversation/workspace-completion";
import {
  composerClipboard,
  buzzCopyDocument,
} from "../../features/messages/composer-clipboard";
import { composerSchema } from "../../features/messages/composer-document";

afterEach(cleanup);
const channel = (
  id: string,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary => ({
  id,
  name: id,
  channelType: "stream",
  members: ["viewer"],
  ...extra,
});
function fixture(
  channels: readonly ChannelSummary[],
  viewer: string | undefined = "viewer",
) {
  let list: ChannelList = { status: "ready", channels };
  let result: CompletionResult | undefined;
  const listeners = new Set<() => void>();
  const withdrawals = vi.fn();
  const ensureList = vi.fn(),
    refreshList = vi.fn();
  const session = {
    viewer,
    channels: {
      list: () => list,
      ensureList,
      refreshList,
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const publish = vi.fn((next: CompletionResult) => {
    result = next;
    return () => {
      withdrawals();
      if (result === next) result = undefined;
    };
  });
  return {
    session,
    listeners,
    withdrawals,
    ensureList,
    refreshList,
    publish,
    result: () => {
      if (!result) throw new Error("No published result");
      return result;
    },
    set(next: ChannelList, notify = true) {
      list = next;
      if (notify)
        act(() => {
          for (const listener of listeners) listener();
        });
    },
    element(query = "") {
      return (
        <StrictMode>
          <ChannelCompletion
            session={session}
            scope="test"
            channelId="source"
            observation={{
              revision: 1,
              text: `#${query}`,
              start: query.length + 1,
              end: query.length + 1,
            }}
            query={{ start: 0, end: query.length + 1, query }}
            publish={publish}
          />
        </StrictMode>
      );
    },
  };
}
it("offers joined streams/forums, including private and still-confirming channels", () => {
  const t = fixture([
    channel("stream"),
    channel("forum", { channelType: "forum" }),
    channel("private", { private: true }),
    channel("private-guest", {
      private: true,
      readOnly: true,
      viewerRole: "guest",
    }),
    channel("huddle", { huddle: true }),
    channel("archived", { archived: true }),
    // The real store's shape for a joined channel restored from cache.
    channel("cached", { cached: true, readOnly: true }),
    channel("readOnly", { readOnly: true }),
    channel("dm", { channelType: "dm" }),
    channel("chat", { channelType: "solo" }),
    { id: "unknown", name: "unknown", members: ["viewer"] },
    channel("outside", { members: ["other"] }),
    { id: "missing", name: "missing", channelType: "stream" },
    channel("blank", { name: " " }),
    channel("multiline", { name: "a\n\nb" }),
  ]);
  render(t.element());
  expect(t.result().items.map((item) => item.id)).toEqual([
    "cached",
    "forum",
    "private",
    "private-guest",
    "stream",
    "unknown",
  ]);
  expect(t.result().items[2]?.detail).toBe("Private channel");
  expect(t.ensureList).not.toHaveBeenCalled();
  expect(t.refreshList).not.toHaveBeenCalled();
});
it("does not offer channels without a viewer", () => {
  const t = fixture([channel("a")]);
  const session = { ...t.session, viewer: undefined };
  render(
    <ChannelCompletion
      session={session}
      scope="test"
      channelId="source"
      observation={{ revision: 1, text: "#", start: 1, end: 1 }}
      query={{ start: 0, end: 1, query: "" }}
      publish={t.publish}
    />,
  );
  expect(t.result().items).toEqual([]);
});
it("ranks exact/prefix/word/substring case-insensitively, qualifies namesakes, and caps at 20", () => {
  const t = fixture([
    channel("d", { name: "screwdriver" }),
    channel("z", { name: "crew" }),
    channel("a", { name: "crew" }),
    channel("b", { name: "Crew-tools" }),
    channel("c", { name: "My crew" }),
    ...Array.from({ length: 25 }, (_, i) => channel(`unrelated-${i}`)),
  ]);
  const view = render(t.element("CREW"));
  expect(t.result().items.map((item) => item.id)).toEqual([
    "a",
    "z",
    "b",
    "c",
    "d",
  ]);
  expect(
    t
      .result()
      .items.slice(0, 2)
      .map((item) => item.detail),
  ).toEqual(["a", "z"]);
  view.rerender(t.element());
  expect(t.result().items).toHaveLength(20);
  expect(t.result().status).toBe("Keep typing to narrow the list.");
});
it("inserts an escaped ID-backed Markdown link, not notification intent", () => {
  const name = "a [b] *c* &amp; <d> \\ !";
  const t = fixture([channel("id-with-(parens)", { name })]);
  render(t.element());
  const edit = t.result().items[0]?.edit;
  expect(edit).not.toHaveProperty("mention");
  const tree = scanMarkdown(edit?.text ?? "").tree;
  expect(tree.children?.[0]?.children?.[0]).toMatchObject({
    type: "link",
    url: "buzz://channel/id-with-%28parens%29",
    children: [{ type: "text", value: `#${name}` }],
  });
});
it.each(["Beta", "a [b] *c* _d_ ~e~ &amp; <f> \\ !"])(
  "copies a picker-produced channel label without Markdown escapes: %s",
  (name) => {
    const t = fixture([channel("beta", { name })]);
    render(t.element());
    const source = t.result().items[0]?.edit.text;
    const doc = composerSchema.nodes.doc.create(
      null,
      composerSchema.nodes.paragraph.create(
        null,
        composerSchema.nodes.token.create({ source }),
      ),
    );
    const copied = composerClipboard(doc, document);
    expect(copied.text).toBe(`#${name}`);
    const html = new DOMParser().parseFromString(copied.html, "text/html");
    expect(html.querySelector("a")?.textContent).toBe(`#${name}`);
    expect(
      scanMarkdown(buzzCopyDocument(copied.html)?.textContent ?? "").links[0],
    ).toMatchObject({
      url: "buzz://channel/beta",
      children: [{ type: "text", value: `#${name}` }],
    });
  },
);
it.each<Partial<ChannelSummary>>([
  {},
  { members: [] },
  { huddle: true },
  { archived: true },
  { readOnly: true },
  { name: "renamed" },
])("rechecks selection before React can repaint: %j", (change) => {
  const t = fixture([channel("a")]);
  render(t.element());
  const old = t.result().items[0];
  expect(old?.canSelect?.("a")).toBe(true);
  t.set(
    {
      status: "ready",
      channels: Object.keys(change).length ? [channel("a", change)] : [],
    },
    false,
  );
  expect(old?.canSelect?.("a")).toBe(false);
});
it("withdraws on updates and unsubscribes on disposal under StrictMode", () => {
  const t = fixture([channel("a")]);
  const view = render(t.element());
  // The publishing effect and the list-ready snapshot.
  expect(t.listeners.size).toBe(2);
  const before = t.withdrawals.mock.calls.length;
  t.set({ status: "ready", channels: [] });
  expect(t.withdrawals).toHaveBeenCalledTimes(before + 1);
  expect(t.result().items).toEqual([]);
  view.unmount();
  expect(t.listeners.size).toBe(0);
  expect(t.withdrawals).toHaveBeenCalledTimes(before + 2);
});
it("distinguishes loading, empty and failed lists; only explicit retry refreshes", () => {
  const t = fixture([]);
  t.set({ status: "loading", channels: [] });
  render(t.element());
  expect(t.result().status).toBe("Loading channels…");
  t.set({ status: "ready", channels: [] });
  expect(t.result().status).toBeUndefined();
  t.set({ status: "error", channels: [channel("a")], error: "offline" });
  expect(t.result().items).toHaveLength(1);
  expect(t.result().status).toBe("Could not refresh channels.");
  expect(t.refreshList).not.toHaveBeenCalled();
  act(() => t.result().retry?.());
  expect(t.refreshList).toHaveBeenCalledTimes(1);
});

it("offers cached joined channels at once and stays quiet when nothing matches offline", () => {
  const cached = channel("alpha", { cached: true, readOnly: true });
  const t = fixture([cached]);
  const view = render(t.element("alp"));
  expect(t.result().items.map((item) => item.id)).toEqual(["alpha"]);
  expect(t.result().items[0]?.canSelect?.("click")).toBe(true);
  // A cachedOnly session stays "ready" with cached channels forever.
  view.rerender(t.element("zzz"));
  expect(t.result().items).toEqual([]);
  expect(t.result().status).toBeUndefined();
});
it("completes multi-word names only while a channel name continues the query", () => {
  const t = fixture([
    channel("design", { name: "Design Review" }),
    channel("other", { name: "design" }),
  ]);
  const view = render(t.element("design r"));
  expect(t.result().items.map((item) => item.id)).toEqual(["design"]);
  view.rerender(t.element("design is"));
  expect(t.result().items).toEqual([]);
  expect(t.result().status).toBeUndefined();
});
it("lists open channels the viewer hasn't joined below joined ones, after a pause", async () => {
  vi.useFakeTimers();
  try {
    const open = channel("open", {
      name: "crew-open",
      members: ["other"],
      readOnly: true,
    });
    let answer!: (value: {
      channels: ChannelSummary[];
      partial: boolean;
    }) => void;
    const t = fixture([channel("mine", { name: "crew" })]);
    const previews = new Map<string, ChannelSummary>();
    const searchPublic = vi.fn(
      () =>
        new Promise<{ channels: ChannelSummary[]; partial: boolean }>(
          (resolve) => (answer = resolve),
        ),
    );
    Object.assign(t.session.channels, {
      searchPublic,
      get: (id: string) => previews.get(id),
    });
    render(t.element("crew"));
    expect(t.result().items.map((item) => item.id)).toEqual(["mine"]);
    expect(t.result().status).toBe("Searching open channels…");
    expect(searchPublic).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(searchPublic).toHaveBeenCalledWith(
      "crew",
      expect.objectContaining({ priority: "foreground" }),
    );
    previews.set("open", open);
    await act(async () => answer({ channels: [open], partial: false }));
    const items = t.result().items;
    expect(items.map((item) => item.id)).toEqual(["mine", "open"]);
    expect(items[1]?.detail).toBe("Not joined");
    expect(items[1]?.edit.text).toBe("[\\#crew-open](buzz://channel/open)");
    expect(t.result().status).toBeUndefined();
    expect(items[1]?.canSelect?.("click")).toBe(true);
    previews.delete("open");
    expect(items[1]?.canSelect?.("click")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it("keeps joined matches when open-channel search fails", async () => {
  vi.useFakeTimers();
  try {
    const t = fixture([channel("mine", { name: "crew" })]);
    Object.assign(t.session.channels, {
      searchPublic: vi.fn(() => Promise.reject(new Error("offline"))),
      get: () => undefined,
    });
    render(t.element("crew"));
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(t.result().items.map((item) => item.id)).toEqual(["mine"]);
    expect(t.result().status).toBe("Could not search open channels.");
    expect(t.result().retry).toBeTypeOf("function");
  } finally {
    vi.useRealTimers();
  }
});

it("uses the channel pickers' name rule, without scattered-letter matches", () => {
  const t = fixture([
    channel("plan", { name: "team-launch-planning" }),
    channel("re", { name: "relaunch" }),
    channel("tags", { name: "debounce-tags" }),
  ]);
  const view = render(t.element("launch"));
  // A word start (after "-") ranks before a match inside a word.
  expect(t.result().items.map((item) => item.id)).toEqual(["plan", "re"]);
  // Letter runs that each begin a word match, as in Command-K.
  view.rerender(t.element("tlp"));
  expect(t.result().items.map((item) => item.id)).toEqual(["plan"]);
  view.rerender(t.element("team-pl"));
  expect(t.result().items.map((item) => item.id)).toEqual(["plan"]);
  // Letters merely in order do not, because Enter would turn prose into a
  // channel link: "dtg" is in debounce-tags only as scattered letters.
  view.rerender(t.element("dtg"));
  expect(t.result().items).toEqual([]);
});
it("lists open channels after joined ones, each ranked by match", async () => {
  vi.useFakeTimers();
  try {
    const exact = channel("open-exact", {
      name: "ops",
      members: [],
      readOnly: true,
    });
    const tie = channel("open-tie", {
      name: "ops-alerts",
      members: [],
      readOnly: true,
    });
    const t = fixture([
      channel("mine-word", { name: "team-ops" }),
      channel("mine-tie", { name: "ops-alerts" }),
    ]);
    const previews = new Map([exact, tie].map((entry) => [entry.id, entry]));
    Object.assign(t.session.channels, {
      searchPublic: vi.fn(async () => ({
        channels: [exact, tie],
        partial: false,
      })),
      get: (id: string) => previews.get(id),
    });
    render(t.element("ops"));
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(t.result().items.map((item) => item.id)).toEqual([
      "mine-tie",
      "mine-word",
      "open-exact",
      "open-tie",
    ]);
    expect(t.result().items.map((item) => item.detail)).toEqual([
      "mine-tie",
      undefined,
      "Not joined",
      "Not joined · open-tie",
    ]);
  } finally {
    vi.useRealTimers();
  }
});
it("completes open channels by word runs, without scattered letters", async () => {
  vi.useFakeTimers();
  try {
    const runs = channel("runs", {
      name: "buzz-community",
      members: [],
      readOnly: true,
    });
    const scattered = channel("scattered", {
      name: "lobster-cat",
      members: [],
      readOnly: true,
    });
    const t = fixture([]);
    const previews = new Map(
      [runs, scattered].map((entry) => [entry.id, entry]),
    );
    Object.assign(t.session.channels, {
      // The store's answer may hold scattered-letter matches; completion
      // drops them, as it does for joined channels.
      searchPublic: vi.fn(async () => ({
        channels: [runs, scattered],
        partial: false,
      })),
      get: (id: string) => previews.get(id),
    });
    render(t.element("bc"));
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(t.result().items.map((item) => item.id)).toEqual(["runs"]);
  } finally {
    vi.useRealTimers();
  }
});
it("finds multi-word open channel names by prefix", async () => {
  vi.useFakeTimers();
  try {
    const review = channel("review", {
      name: "Design Review",
      members: [],
      readOnly: true,
    });
    const prose = channel("prose", {
      name: "new design rules",
      members: [],
      readOnly: true,
    });
    const t = fixture([]);
    const searchPublic = vi.fn(async () => ({
      channels: [review, prose],
      partial: false,
    }));
    Object.assign(t.session.channels, {
      searchPublic,
      get: (id: string) => [review, prose].find((entry) => entry.id === id),
    });
    render(t.element("design r"));
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(searchPublic).toHaveBeenCalledWith("design r", expect.anything());
    expect(t.result().items.map((item) => item.id)).toEqual(["review"]);
  } finally {
    vi.useRealTimers();
  }
});

function searching(
  t: ReturnType<typeof fixture>,
  results: Record<string, ChannelSummary[] | Error | "pending">,
  extra: { partial?: boolean } = {},
) {
  const all = new Map(
    Object.values(results)
      .flatMap((value) => (Array.isArray(value) ? value : []))
      .map((entry) => [entry.id, entry]),
  );
  // The store's last answer, as `matchPublic` keeps it across remounts.
  let last: readonly ChannelSummary[] = [];
  const searchPublic = vi.fn(async (query: string) => {
    const value = results[query] ?? [];
    if (value === "pending") return new Promise<never>(() => {});
    if (value instanceof Error) throw value;
    last = value;
    return { channels: value, partial: !!extra.partial };
  });
  Object.assign(t.session.channels, {
    searchPublic,
    matchPublic: (query: string) =>
      last.filter((entry) => entry.name.includes(query)),
    get: (id: string) => all.get(id),
  });
  return searchPublic;
}
const openChannel = (
  id: string,
  name = id,
  extra: Partial<ChannelSummary> = {},
) => channel(id, { name, members: [], readOnly: true, ...extra });

it("never offers a private search result", async () => {
  vi.useFakeTimers();
  try {
    const t = fixture([]);
    searching(t, {
      ops: [
        openChannel("public", "ops"),
        openChannel("secret", "ops-x", { private: true }),
      ],
    });
    render(t.element("ops"));
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(t.result().items.map((item) => item.id)).toEqual(["public"]);
  } finally {
    vi.useRealTimers();
  }
});

it("reserves rows for open channels when joined matches fill the list", async () => {
  vi.useFakeTimers();
  try {
    const t = fixture(
      Array.from({ length: 25 }, (_, i) =>
        channel(`team-${String(i).padStart(2, "0")}`),
      ),
    );
    searching(t, { team: [openChannel("open-team", "team")] });
    render(t.element("team"));
    expect(t.result().status).toBe("Searching open channels…");
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    const ids = t.result().items.map((item) => item.id);
    expect(ids).toHaveLength(20);
    expect(ids.slice(0, 19)).toEqual(
      Array.from(
        { length: 19 },
        (_, i) => `team-${String(i).padStart(2, "0")}`,
      ),
    );
    expect(ids[19]).toBe("open-team");
    expect(t.result().status).toBe("Keep typing to narrow the list.");
  } finally {
    vi.useRealTimers();
  }
});

it("says when the search covered only the newest page, beside rows already shown", async () => {
  vi.useFakeTimers();
  try {
    const t = fixture([channel("mine", { name: "crew" })]);
    searching(t, { crew: [], zzz: [] }, { partial: true });
    const view = render(t.element("crew"));
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(t.result().items.map((item) => item.id)).toEqual(["mine"]);
    expect(t.result().status).toBe(
      "Only the newest open channels were searched.",
    );
    // Prose that matches nothing keeps the popup hidden.
    view.rerender(t.element("zzz"));
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(t.result().items).toEqual([]);
    expect(t.result().status).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("reports a failed open-channel search and retries it on request", async () => {
  vi.useFakeTimers();
  try {
    const t = fixture([]);
    const searchPublic = searching(t, { ops: new Error("rate limited") });
    render(t.element("ops"));
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(t.result().items).toEqual([]);
    expect(t.result().status).toBe("Could not search open channels.");
    expect(searchPublic).toHaveBeenCalledTimes(1);
    await act(async () => {
      t.result().retry?.();
    });
    expect(t.result().status).toBe("Searching open channels…");
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(searchPublic).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps still-matching open rows while the next keystroke's search runs", async () => {
  vi.useFakeTimers();
  try {
    const t = fixture([]);
    searching(t, {
      op: [openChannel("ops"), openChannel("opal")],
      ops: "pending",
    });
    const view = render(t.element("op"));
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(t.result().items.map((item) => item.id)).toEqual(["opal", "ops"]);
    // The composer remounts its completion on every edit.
    view.unmount();
    render(t.element("ops"));
    expect(t.result().items.map((item) => item.id)).toEqual(["ops"]);
    expect(t.result().status).toBe("Searching open channels…");
  } finally {
    vi.useRealTimers();
  }
});

it.each([true, false])(
  "renders the channel name without its hash beside the icon, with the stable target and member visibility %s",
  (member) => {
    const name = "crew-ops [a] & <b>";
    const row = channel("stable", { name, private: true });
    const t = fixture([row]);
    render(t.element());
    const content = t.result().items[0]?.edit.text ?? "";
    const onOpenLink = vi.fn(() => member);
    const links = [
      {
        id: "links",
        key: "buzz.links/links",
        pluginId: "buzz.links",
        revision: "1",
        title: "Links",
        matches: () => true,
        component: ({ url }: { url: string }) => <LinkLabel href={url} />,
      },
    ];
    render(
      <MessageMarkdown
        row={{
          id: "message",
          channelId: "source",
          authorId: "author",
          content,
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
        directory={{
          profiles: new Map(),
          agents: [],
          channels: member ? [row] : [],
          named: member ? [row] : [],
        }}
        extensions={{
          tools: { snapshot: () => [], subscribe: () => () => {} },
          inline: { snapshot: () => [], subscribe: () => () => {} },
          links: { snapshot: () => links, subscribe: () => () => {} },
        }}
        media={() => undefined}
        onOpenLink={onOpenLink}
      />,
    );
    const link = screen.getByRole("link", { name: "#crew-ops [a] & <b>" });
    expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(link.textContent).toBe("crew-ops [a] & <b>");
    expect(link.getAttribute("href")).toBe("buzz://channel/stable");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    fireEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledWith("buzz://channel/stable");
    if (!member)
      expect(screen.getByRole("status").textContent).toContain(
        "couldn’t be opened here",
      );
  },
);
function workspaces(names: readonly string[] | undefined) {
  const toSections = (next: readonly string[]) =>
    next.map((name, order) => ({ id: name.toLowerCase(), name, order }));
  let sections = names && toSections(names);
  const listeners = new Set<() => void>();
  const target = {
    preferences: {
      snapshot: () =>
        sections
          ? { status: "ready", data: { sections, assignments: {} } }
          : { status: "loading" },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    choose: vi.fn(),
  } as unknown as WorkspaceCompletionTarget;
  return {
    target,
    listeners,
    set(next: readonly string[]) {
      sections = toSections(next);
    },
    /** Completes the held workspace read. */
    load(next: readonly string[]) {
      sections = toSections(next);
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
  };
}
it("lists a new chat's workspaces first, by the channel name rule", () => {
  const t = fixture([channel("dev"), channel("design-reviews")]);
  const w = workspaces(["Docs", "Design", "Billing"]);
  render(
    <WorkspaceCompletion.Provider value={w.target}>
      {t.element("d")}
    </WorkspaceCompletion.Provider>,
  );
  expect(t.result().items.map((item) => item.id)).toEqual([
    "workspace:design",
    "workspace:docs",
    "design-reviews",
    "dev",
  ]);
  const [first] = t.result().items;
  expect(first?.label).toBe("Design");
  expect(first?.detail).toBe("Workspace");
  expect(first && chosenWorkspace(first.edit)).toBe("design");
  w.set(["Docs"]);
  expect(first?.canSelect?.("Enter")).toBe(false);
});
it("adds workspace rows that load after `#` opens, and stops listening on unmount", () => {
  const t = fixture([channel("dev")]);
  const w = workspaces(undefined);
  const view = render(
    <WorkspaceCompletion.Provider value={w.target}>
      {t.element("d")}
    </WorkspaceCompletion.Provider>,
  );
  expect(t.result().items.map((item) => item.id)).toEqual(["dev"]);
  w.load(["Design"]);
  expect(t.result().items.map((item) => item.id)).toEqual([
    "workspace:design",
    "dev",
  ]);
  view.unmount();
  expect(w.listeners.size).toBe(0);
});
it("offers no workspace rows outside a new chat", () => {
  const t = fixture([channel("dev")]);
  render(t.element("d"));
  expect(t.result().items.map((item) => item.id)).toEqual(["dev"]);
});
it("lets workspace rows take their place within the row limit", () => {
  const t = fixture(
    Array.from({ length: 20 }, (_, i) =>
      channel(`d${String(i).padStart(2, "0")}`),
    ),
  );
  const w = workspaces(["Design", "Docs"]);
  render(
    <WorkspaceCompletion.Provider value={w.target}>
      {t.element("d")}
    </WorkspaceCompletion.Provider>,
  );
  const ids = t.result().items.map((item) => item.id);
  expect(ids).toHaveLength(20);
  expect(ids.slice(0, 2)).toEqual(["workspace:design", "workspace:docs"]);
  expect(t.result().status).toBe("Keep typing to narrow the list.");
});
