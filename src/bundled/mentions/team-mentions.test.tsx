// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { AgentsContext } from "../../features/agents/react";
import { AgentsService, type Agents } from "../../features/agents/service";
import {
  fakeCommunities,
  fakeNative,
  fakeRelay,
  viewer,
} from "../../features/agents/service-testing";
import { memoryStorage } from "../../features/agents/test-fakes";
import { readTeams, type Team } from "../../features/agents/store";
import { AgentsPage } from "../agents/AgentsPage";
import { resolveSpaceMention } from "./resolve-space-mention";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import * as communityConfig from "../../features/agents/community-config";
import { SyncedTeams, teamArtifact } from "../../features/agents/team-config";
import type { RelayEvent } from "../../features/relay/events";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MentionCompletion } from "./MentionCompletion";
import { MentionPicker } from "./MentionPicker";
import { mentionQuery } from "./mention-query";
import { MENTION_ROWS, useMentionChoices } from "./use-mention-choices";
import { useTeamMentions } from "./use-team-mentions";
import { createAgentLibrary } from "../../features/agents/library";
import { createAgentChoices } from "../../features/agents/choices";
import { ComposerCompletions } from "../../features/conversation/ComposerCompletions";
import type {
  ComposerCompletion,
  CompletionResult,
} from "../../features/conversation/contracts";
import type { CompletionEditor } from "../../features/conversation/useCompletionEditor";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import { SelectedMentionContext } from "../../features/messages/selected-mention-context";
import type { RelaySession } from "../../features/relay/session";
import type { Contribution } from "../../plugins/contributions";
import * as personMatch from "../../features/search/person-match";

// jsdom lacks scrollIntoView; the search highlight keeps its row in view.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
});

function fixture({
  count = 1,
  loading = false,
  failure = false,
  dm = false,
  team = 1,
} = {}) {
  const people = Array.from({ length: count }, (_, i) => ({
    pubkey: (i + 1).toString(16).padStart(64, "0"),
    name: `Person ${String(i).padStart(2, "0")}`,
  }));
  const agent = people[0];
  if (!agent) throw new Error("Fixture needs at least one person");
  const teamAgents = people.slice(0, team);
  const read = vi.fn(async () => ({
    definitions: [],
    identities: teamAgents,
  }));
  if (failure) read.mockRejectedValueOnce(new Error("temporary read failure"));
  const library = createAgentLibrary(read);
  const choices = createAgentChoices({
    scope: "test",
    library: library.queries,
    signal: new AbortController().signal,
  });
  const profiles = new Map(people.map((p) => [p.pubkey, { name: p.name }]));
  let list: ReturnType<RelaySession["channels"]["list"]> = {
    status: "ready",
    channels: [
      {
        id: "parent",
        name: "Parent",
        channelType: dm ? "dm" : "stream",
        members: failure ? [] : people.map((p) => p.pubkey),
      },
    ],
  };
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const archives = { status: "ready" as const, archived: [] };
  const entries: ReturnType<
    NonNullable<RelaySession["channelKit"]>["snapshot"]
  >["entries"] = [
    {
      eventId: "head",
      createdAt: 1,
      record: {
        version: 1,
        community: "fixture",
        deleted: false,
        value: {
          type: "team",
          id: "team",
          name: "Team",
          agents: teamAgents.map((person) => person.pubkey),
        },
      },
    },
  ];
  let catalog: ReturnType<NonNullable<RelaySession["channelKit"]>["snapshot"]> =
    { status: loading ? "loading" : "ready", entries: loading ? [] : entries };
  const none = () => () => {};
  const session = {
    unread: undefined,
    directMessages: {
      people: vi.fn(async () => ({ people: [], hasMore: false })),
    },
    archives: {
      snapshot: () => archives,
      subscribe: none,
      ensure: async () => {},
      refresh: async () => {},
      state: () => "not-archived",
    },
    channels: {
      list: () => list,
      subscribeList: subscribe,
      ensureList: () => {},
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: none,
      ensure: async () => {},
    },
    names: { subscribe: none, snapshot: () => 0, scope: () => () => undefined },
    agentLibrary: library.queries,
    agentChoices: choices,
    media: () => undefined,
    channelKit: {
      available: true,
      snapshot: () => catalog,
      subscribe,
      ensure() {},
      async refresh() {},
      async save() {
        return "head";
      },
    },
  } as unknown as RelaySession;
  return {
    session,
    people,
    agent,
    read,
    library,
    catalog(next: typeof catalog) {
      act(() => {
        catalog = next;
        listeners.forEach((f) => {
          f();
        });
      });
    },
    loaded() {
      act(() => {
        catalog = { status: "ready", entries };
        listeners.forEach((f) => {
          f();
        });
      });
    },
    remove(notify = true) {
      act(() => {
        list = {
          ...list,
          channels: list.channels.map((c) => ({ ...c, members: [] })),
        };
        if (notify)
          listeners.forEach((f) => {
            f();
          });
      });
    },
    notify() {
      act(() => {
        listeners.forEach((f) => {
          f();
        });
      });
    },
    /** Replace the channel summary, as a new message or metadata change does. */
    update(patch: Partial<(typeof list.channels)[number]>) {
      act(() => {
        list = {
          ...list,
          channels: list.channels.map((c) => ({ ...c, ...patch })),
        };
        listeners.forEach((f) => {
          f();
        });
      });
    },
  };
}

function inline(session: RelaySession, inviteAgents = false) {
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    inviteAgents,
    publish,
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    query: { start: 0, end: 1, query: "" },
  };
  const view = render(<MentionCompletion {...props} />);
  const result = () => publish.mock.lastCall?.[0] as CompletionResult;
  return {
    view,
    props,
    result,
    team: () => result()?.items.find((i) => i.id === "team:team"),
  };
}

it("late teams preserve the highlighted recipient and all 50 installed people", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const h = fixture({ count: 50, loading: true });
  const replace = vi.fn(
    (_edit: CompletionResult["items"][number]["edit"]) => true,
  );
  const provider: Contribution<ComposerCompletion> = {
    id: "typeahead",
    key: "buzz.mentions/typeahead",
    pluginId: "buzz.mentions",
    revision: "1",
    title: "Mention",
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  };
  const providers = [provider];
  const input = document.createElement(
    "div",
  ) as unknown as ComposerInputElement;
  document.body.append(input);
  const editor = {
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    valid: () => true,
    observe() {},
    invalidate() {},
    keys: { current: undefined },
    composing: { current: false },
  } as unknown as CompletionEditor;
  const view = render(
    <ComposerCompletions
      registry={{ snapshot: () => providers, subscribe: () => () => {} }}
      editor={editor}
      input={{ current: input }}
      replace={replace}
      resolved={{ text: "@", recipients: [] }}
      session={h.session}
      scope="test"
      channelId="parent"
    />,
  );
  const press = (key: string) =>
    act(() =>
      editor.keys.current?.({
        key,
        nativeEvent: {},
        preventDefault() {},
        stopPropagation() {},
      } as Parameters<NonNullable<CompletionEditor["keys"]["current"]>>[0]),
    );
  try {
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(50));
    // Agent knowledge may arrive late and mark a row; the rows themselves stay.
    const rows = () =>
      screen
        .getAllByRole("option")
        .map((row) => row.textContent?.replace(/ Agent$/, ""));
    const initial = rows();
    press("ArrowUp");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
      "Person 49",
    );
    h.loaded();
    await waitFor(() => expect(h.read).toHaveBeenCalledOnce());
    expect(rows()).toEqual(initial);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
      "Person 49",
    );
    press("Enter");
    expect(replace.mock.lastCall?.[0]).toEqual({ mention: h.people[49] });
    expect(screen.queryByText(/Narrow your search/)).not.toBeInTheDocument();
  } finally {
    view.unmount();
    input.remove();
    h.library.dispose();
  }
});

it("late directory people do not displace a team already filling the shared budget", async () => {
  const h = fixture({ count: 49 });
  let resolve!: (value: {
    people: { pubkey: string; name: string }[];
    hasMore: boolean;
  }) => void;
  const people = vi.fn(
    () =>
      new Promise<{
        people: { pubkey: string; name: string }[];
        hasMore: boolean;
      }>((done) => {
        resolve = done;
      }),
  );
  const session = {
    ...h.session,
    directMessages: { ...h.session.directMessages, people },
  };
  const menu = inline(session);
  try {
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    expect(menu.result().items).toHaveLength(50);
    const ids = menu.result().items.map((item) => item.id);
    await waitFor(() => expect(people).toHaveBeenCalledOnce());
    await act(async () =>
      resolve({
        people: [{ pubkey: "f".repeat(64), name: "Zed" }],
        hasMore: false,
      }),
    );
    expect(menu.result().items.map((item) => item.id)).toEqual(ids);
    expect(menu.team()?.canSelect?.("Enter")).toBe(true);
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("teams retain installed membership through rerenders and stale acceptance until a new query", async () => {
  const h = fixture();
  const menu = inline(h.session, true);
  try {
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    const stale = menu.team();
    if (!stale) throw new Error("Expected team choice");
    // Revoke membership before React sees the new roster: acceptance must reread it.
    h.remove(false);
    expect(stale.canSelect?.("Enter")).toBe(false);
    h.notify();
    expect(menu.team()?.disabled).toContain("membership changed");
    expect(menu.team()?.canSelect?.("Enter")).toBe(false);
    expect(menu.team()?.edit.mentions).toBeUndefined();
    expect(
      menu.result().items.find((i) => i.id === h.agent.pubkey)?.disabled,
    ).toContain("membership changed");
    menu.view.rerender(
      <MentionCompletion
        {...menu.props}
        query={{ start: 0, end: 3, query: "Te" }}
      />,
    );
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    expect(menu.team()?.detail).toContain("Adds 1");
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("a team pick in an agents-only audience replaces the audience with the team", async () => {
  const h = fixture({ count: 2, team: 2 }),
    user = userEvent.setup(),
    only = vi.fn();
  const view = render(
    <MentionPicker
      session={h.session}
      scope="test"
      channelId="parent"
      disabled={false}
      inviteAgents
      audience={{ recipients: [], named: false, only, toggle: vi.fn() }}
      select={() => true}
      selectTeam={() => true}
    />,
  );
  try {
    await user.click(screen.getByRole("button", { name: "Choose agent" }));
    const team = await screen.findByRole("button", {
      name: /Team.*Saved team/,
    });
    await waitFor(() => expect(team).toBeEnabled());
    await user.click(team);
    const [first, second] = [
      { pubkey: "1".padStart(64, "0"), name: "Person 00" },
      { pubkey: "2".padStart(64, "0"), name: "Person 01" },
    ];
    expect(only).toHaveBeenCalledExactlyOnceWith([first, second]);
    await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  } finally {
    view.unmount();
    h.library.dispose();
  }
});

it("the team picker disables a removed member until reopened", async () => {
  const h = fixture(),
    user = userEvent.setup(),
    selectTeam = vi.fn(() => true);
  const view = render(
    <MentionPicker
      session={h.session}
      scope="test"
      channelId="parent"
      disabled={false}
      inviteAgents
      select={() => true}
      selectTeam={selectTeam}
    />,
  );
  try {
    const trigger = screen.getByRole("button", { name: "Mention a member" });
    await user.click(trigger);
    const team = await screen.findByRole("button", {
      name: /Team.*Saved team/,
    });
    await waitFor(() => expect(team).toBeEnabled());
    h.remove();
    expect(team).toBeDisabled();
    expect(team).toHaveTextContent("membership changed");
    await user.click(team);
    expect(selectTeam).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await user.click(trigger);
    const reopened = await screen.findByRole("button", {
      name: /Team.*Saved team/,
    });
    expect(reopened).toBeEnabled();
    await user.click(reopened);
    expect(selectTeam).toHaveBeenCalledWith([h.agent]);
  } finally {
    view.unmount();
    h.library.dispose();
  }
});

it.each([false, true])(
  "inline Retry recovers the team inventory (DM: %s)",
  async (dm) => {
    const h = fixture({ failure: true, dm });
    const menu = inline(h.session);
    try {
      await waitFor(() =>
        expect(menu.result()?.status).toBe(
          "Could not load agents. Retry to refresh.",
        ),
      );
      expect(menu.team()?.disabled).toContain("unavailable");
      act(() => menu.result().retry?.());
      await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
      expect(menu.team()?.edit.mentions).toEqual([h.agent]);
    } finally {
      menu.view.unmount();
      h.library.dispose();
    }
  },
);

it.each([false, true])(
  "picker Retry recovers a selectable team (DM: %s)",
  async (dm) => {
    const h = fixture({ failure: true, dm }),
      user = userEvent.setup(),
      selectTeam = vi.fn(() => true);
    const view = render(
      <MentionPicker
        session={h.session}
        scope="test"
        channelId="parent"
        disabled={false}
        select={() => true}
        selectTeam={selectTeam}
      />,
    );
    try {
      await user.click(
        screen.getByRole("button", { name: "Mention a member" }),
      );
      const retry = await screen.findByRole("button", {
        name: "Retry agent list",
      });
      expect(
        screen.getByRole("button", { name: /Team.*unavailable/ }),
      ).toBeDisabled();
      await user.click(retry);
      await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
      const team = await screen.findByRole("button", {
        name: /Team.*Saved team/,
      });
      expect(team).toBeEnabled();
      await user.click(team);
      expect(selectTeam).toHaveBeenCalledWith([h.agent]);
    } finally {
      view.unmount();
      h.library.dispose();
    }
  },
);

it("more members than the shown rows rank only the first rows", async () => {
  const h = fixture({ count: MENTION_ROWS + 1, team: 0 });
  const view = renderHook(() =>
    useMentionChoices(h.session, "parent", false, "", "open", true),
  );
  try {
    await waitFor(() =>
      expect(view.result.current.choices).toHaveLength(MENTION_ROWS),
    );
  } finally {
    view.unmount();
    h.library.dispose();
  }
});

it("reserves room for teams ready when the first 50-choice budget installs", async () => {
  const h = fixture({ count: 50 });
  const menu = inline(h.session);
  try {
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    expect(menu.result().items).toHaveLength(50);
    expect(
      menu
        .result()
        .items.slice(0, 49)
        .map((item) => item.id),
    ).toEqual(h.people.slice(0, 49).map((person) => person.pubkey));
    expect(menu.result().items[49]?.id).toBe("team:team");
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("waits for the initial roster before installing team membership facts", async () => {
  const h = fixture();
  let pending = true;
  const loading: ReturnType<RelaySession["channels"]["list"]> = {
    status: "loading",
    channels: [],
  };
  const session = {
    ...h.session,
    channels: {
      ...h.session.channels,
      list: () => (pending ? loading : h.session.channels.list()),
    },
  };
  const menu = inline(session, true);
  try {
    await waitFor(() =>
      expect(h.session.agentChoices.snapshot().status).toBe("ready"),
    );
    expect(menu.team()).toBeUndefined();
    pending = false;
    h.notify();
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    const stale = menu.team();
    h.remove();
    expect(menu.team()?.disabled).toContain("membership changed");
    expect(stale?.canSelect?.("Enter")).toBe(false);
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("a closed chooser reads no member while its composer rerenders", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const h = fixture({ count: 300 });
  const members = new Set(h.people.map((person) => person.pubkey));
  const get = vi.spyOn(h.session.profiles.snapshot(), "get");
  const memberReads = () =>
    get.mock.calls.filter(([key]) => members.has(key)).length;
  const picker = (select: () => boolean) => (
    <MentionPicker
      session={h.session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={select}
      selectTeam={() => true}
    />
  );
  const view = render(picker(() => true));
  // Each keystroke rerenders the composer and its closed chooser.
  for (let key = 0; key < 5; key++) view.rerender(picker(() => true));
  expect(memberReads()).toBe(0);
  await userEvent.click(
    screen.getByRole("button", { name: "Mention a member" }),
  );
  expect(memberReads()).toBeGreaterThan(0);
});

it("an @ keystroke reuses the name index across draft and team rerenders", async () => {
  const h = fixture({ count: 300 });
  const starts = vi.spyOn(personMatch, "nameStarts");
  function Chooser({ query }: { query: string }) {
    const model = useMentionChoices(h.session, "parent", false, query, "open");
    // Shown team rows read candidates with their own directory.
    useTeamMentions(h.session, "parent", false, query, model);
    return null;
  }
  // The draft builds a new recipient array on every edit.
  const draft = (query: string, selected: readonly MentionRecipient[]) => (
    <SelectedMentionContext.Provider value={selected}>
      {/* Inline completion remounts on every keystroke. */}
      <Chooser key={query} query={query} />
    </SelectedMentionContext.Provider>
  );
  vi.useFakeTimers();
  // Each settled directory search finds nobody.
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  const view = render(draft("te", []));
  await settle();
  expect(h.session.directMessages.people).toHaveBeenCalled();
  expect(starts).toHaveBeenCalled();
  starts.mockClear();
  view.rerender(draft("tea", []));
  await settle();
  view.rerender(draft("team", []));
  await settle();
  expect(starts).not.toHaveBeenCalled();
  // A different selection is a different naming fact.
  view.rerender(draft("team", [{ pubkey: "f".repeat(64), name: "Picked" }]));
  expect(starts).toHaveBeenCalled();
  view.unmount();
  h.library.dispose();
});

it("directory pages rebuild the name index only for people they add", async () => {
  const h = fixture({ count: 300 });
  const profiles = h.session.profiles.snapshot();
  // Naming knows every profile, as the real service does.
  Object.assign(h.session, {
    names: {
      subscribe: () => () => {},
      snapshot: () => 0,
      scope: () => (key: string) => {
        const name = profiles.get(key)?.name;
        return name ? { name, source: "public-profile" } : undefined;
      },
    },
  });
  const members = h.people.slice(1, 4);
  const outsider = { pubkey: "e".repeat(64), name: "Teal Outsider" };
  let page = members;
  // Every settled search returns a new array. Pages are truncated so each
  // keystroke reads rather than deriving from the complete `p` page.
  vi.mocked(h.session.directMessages.people).mockImplementation(async () => ({
    people: [...page],
    hasMore: true,
  }));
  const starts = vi.spyOn(personMatch, "nameStarts");
  function Chooser({ query }: { query: string }) {
    const model = useMentionChoices(h.session, "parent", false, query, "open");
    useTeamMentions(h.session, "parent", false, query, model);
    return null;
  }
  vi.useFakeTimers();
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  // Inline completion remounts on every keystroke.
  const type = async (query: string) => {
    view.rerender(<Chooser key={query} query={query} />);
    await settle();
  };
  const view = render(<Chooser key="p" query="p" />);
  await settle();
  starts.mockClear();
  // Pages of members change no row.
  await type("pe");
  await type("per");
  // `p` is too short to search; `pe` and `per` each read.
  expect(h.session.directMessages.people).toHaveBeenCalledTimes(2);
  expect(starts).not.toHaveBeenCalled();
  // An outsider is a new choice set: one rebuild, then reused while it stays.
  page = [...members, outsider];
  await type("pers");
  expect(starts).toHaveBeenCalledTimes(301);
  starts.mockClear();
  await type("perso");
  await type("person");
  expect(starts).not.toHaveBeenCalled();
  view.unmount();
  h.library.dispose();
});

it("a mention keystroke checks longer names only on choices the query matches", async () => {
  const h = fixture({ count: 300 });
  // A running directory search leaves Space undecided, so the chooser asks
  // whether a known name continues the query.
  vi.mocked(h.session.directMessages.people).mockImplementation(
    () => new Promise(() => {}),
  );
  const menu = inline(h.session);
  try {
    await waitFor(() => expect(menu.result()?.items.length).toBeGreaterThan(0));
    const longer = vi.spyOn(personMatch, "extendsName");
    // Team names are checked separately; count member names only.
    const checked = () =>
      longer.mock.calls
        .map(([name]) => name)
        .filter((name) => name.startsWith("Person"));
    for (const query of ["zz", "Person 0"]) {
      longer.mockClear();
      menu.view.rerender(
        <MentionCompletion
          {...menu.props}
          query={{ start: 0, end: query.length + 1, query }}
        />,
      );
      await waitFor(() =>
        expect(h.session.directMessages.people).toHaveBeenCalled(),
      );
      // `Person 0` is continued by the ten `Person 0x` names; `zz` by none.
      if (query !== "zz")
        await waitFor(() => expect(checked().length).toBeGreaterThan(0));
      // Only names that start with the query can continue it.
      expect(checked().every((name) => name.startsWith(query))).toBe(true);
    }
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("Retry after a failed names read rereads members, known absences included", async () => {
  const h = fixture({ count: 3 });
  const nameless = h.people[2]?.pubkey ?? "";
  (h.session.profiles.snapshot() as Map<string, unknown>).delete(nameless);
  // A member who never set a name is a complete answer; only the failed read
  // offers Retry.
  const ensure = vi.fn(async (_ids: readonly string[], priority?: string) => {
    if (priority === "background") throw new Error("relay unavailable");
  });
  Object.assign(h.session.profiles, { ensure });
  const menu = inline(h.session);
  try {
    await waitFor(() => expect(menu.result()?.retry).toBeDefined());
    expect(ensure).toHaveBeenLastCalledWith(
      expect.arrayContaining([nameless]),
      "background",
    );
    act(() => menu.result()?.retry?.());
    // Background enrichment skips known absences; an explicit Retry does not.
    await waitFor(() =>
      expect(ensure).toHaveBeenLastCalledWith(
        expect.arrayContaining([nameless]),
        "foreground",
      ),
    );
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("an open chooser relabels choices when only names change", async () => {
  const h = fixture();
  let name = "Before";
  let revision = 0;
  const listeners = new Set<() => void>();
  Object.assign(h.session, {
    names: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => revision,
      scope: () => () => ({ name, source: "agent-directory" }),
    },
  });
  function Chooser() {
    const model = useMentionChoices(h.session, "parent", false, "", "open");
    return <>{model.candidates.map((choice) => choice.label).join(",")}</>;
  }
  render(<Chooser />);
  await waitFor(() => expect(screen.getByText("Before")).toBeInTheDocument());
  act(() => {
    name = "After";
    revision++;
    for (const listener of listeners) listener();
  });
  expect(screen.getByText("After")).toBeInTheDocument();
  h.library.dispose();
});

it("keeps a closed chooser quiet when a message only changes the channel preview", () => {
  const h = fixture();
  let renders = 0;
  let members: readonly string[] | undefined;
  function Chooser() {
    renders++;
    members = useMentionChoices(h.session, "parent", false, "", "closed", false)
      .channel?.members;
    return null;
  }
  render(<Chooser />);
  const settled = renders;
  h.update({ preview: "New message", lastActivityAt: 2 });
  h.update({ preview: "Another message", lastActivityAt: 3 });
  expect(renders).toBe(settled);
  h.update({ members: [h.agent.pubkey, "f".repeat(64)] });
  expect(renders).toBe(settled + 1);
  expect(members).toEqual([h.agent.pubkey, "f".repeat(64)]);
  h.library.dispose();
});

function completion(publish: ReturnType<typeof vi.fn>): CompletionResult {
  const result = publish.mock.lastCall?.[0] as CompletionResult | undefined;
  if (!result) throw new Error("No mention completion published");
  return result;
}

async function savedTeamFixture(elsewhere = false, storage = memoryStorage()) {
  const h = fixture({ count: 2, team: elsewhere ? 1 : 2 });
  h.catalog({ status: "ready", entries: [] });
  const context = new Context();
  context.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
    settled: () => true,
  });
  const relay = fakeRelay();
  const communities = fakeCommunities(
    relay,
    fakeRelay("https://other.example.test"),
  );
  const service = new AgentsService(
    context,
    communities.communities,
    fakeNative(
      h.people.map((person, index) => ({
        ...person,
        owner: viewer,
        relay:
          elsewhere && index === 1
            ? "wss://other.example.test"
            : "wss://relay.example.test",
        type: "fixture/agent",
        deleted: false,
      })),
    ),
    storage,
  );
  await service.refresh();
  const session = { ...h.session, viewer, scope: `${relay.origin}:${viewer}` };
  const pageSnapshot = { ...relay.relay.snapshot(), session };
  const pageRelay = {
    ...relay.relay,
    snapshot: () => pageSnapshot,
    subscribe: () => () => {},
  };
  return {
    ...h,
    pageRelay,
    session,
    service,
    relay,
    storage,
    communities,
    context,
  };
}

it("offers a team created through Your teams in both mention choosers", async () => {
  const h = await savedTeamFixture(),
    user = userEvent.setup(),
    publish = vi.fn(),
    selectTeam = vi.fn(() => true);
  const view = render(<AgentsPage agents={h.service} relay={h.pageRelay} />);
  try {
    await user.click(screen.getByRole("tab", { name: "Your teams" }));
    await user.click(screen.getByRole("button", { name: "New team" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Create a new team" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "ReviewCrew",
    );
    await user.click(screen.getByRole("checkbox", { name: "Person 00" }));
    await user.click(screen.getByRole("checkbox", { name: "Person 01" }));
    await user.click(screen.getByRole("button", { name: "Create team" }));
    await screen.findByRole("button", { name: "ReviewCrew" });
    expect(readTeams(h.storage)[0]?.members).toEqual(
      h.people.map((p) => p.pubkey),
    );
    view.rerender(
      <AgentsContext.Provider value={h.service}>
        <MentionCompletion
          session={h.session}
          scope="test"
          channelId="parent"
          publish={publish}
          observation={{ revision: 1, text: "@Review", start: 7, end: 7 }}
          query={{ start: 0, end: 7, query: "Review" }}
        />
        <MentionPicker
          session={h.session}
          scope="test"
          channelId="parent"
          disabled={false}
          select={() => true}
          selectTeam={selectTeam}
        />
      </AgentsContext.Provider>,
    );
    const choice = () =>
      completion(publish)?.items.find((item) => item.label === "ReviewCrew");
    await waitFor(() => expect(choice()?.canSelect?.("Enter")).toBe(true));
    expect(choice()?.edit).toEqual({ mentions: h.people });
    await user.click(screen.getByRole("button", { name: "Mention a member" }));
    await user.click(
      await screen.findByRole("button", { name: /ReviewCrew.*Saved team/ }),
    );
    expect(selectTeam).toHaveBeenCalledExactlyOnceWith(h.people);
  } finally {
    view.unmount();
    h.library.dispose();
    await h.context.fiber.dispose();
  }
});

it.each(["loading", "error", "unavailable"] as const)(
  "current teams work while the legacy catalog is %s, and stale picks are refused",
  async (status) => {
    const h = await savedTeamFixture(),
      publish = vi.fn();
    h.catalog({ status, entries: [] });
    const team = await h.service.saveTeam({
      name: "Review Crew",
      instructions: "",
      members: h.people.map((p) => p.pubkey),
    });
    const props = {
      session: h.session,
      scope: "test",
      channelId: "parent",
      publish,
      observation: { revision: 1, text: "@Review C", start: 9, end: 9 },
      query: { start: 0, end: 9, query: "Review C" },
    };
    const content = (query = props.query) => (
      <AgentsContext.Provider value={h.service}>
        <MentionCompletion {...props} query={query} />
      </AgentsContext.Provider>
    );
    const view = render(content());
    const choice = () =>
      completion(publish)?.items.find((item) => item.label === "Review Crew");
    try {
      await waitFor(() => expect(choice()?.canSelect?.("Enter")).toBe(true));
      await waitFor(() =>
        expect(completion(publish).status).toBe(
          status === "loading"
            ? "Loading legacy teams…"
            : status === "error"
              ? "Could not load legacy teams. Retry to refresh."
              : undefined,
        ),
      );
      const accepted = choice();
      await act(() =>
        h.service.saveTeam({ ...team, members: [h.agent.pubkey] }),
      );
      expect(accepted?.canSelect?.("Enter")).toBe(false);
      expect(choice()?.disabled).toContain("changed");
      view.rerender(content({ start: 0, end: 10, query: "Review Cr" }));
      await waitFor(() => expect(choice()?.canSelect?.("Enter")).toBe(true));
      expect(choice()?.edit).toEqual({ mentions: h.people.slice(0, 1) });
      const renamed = choice();
      await act(() => h.service.saveTeam({ ...team, name: "Renamed Crew" }));
      expect(renamed?.canSelect?.("Enter")).toBe(false);
      expect(choice()?.disabled).toContain("changed");
      view.rerender(content({ start: 0, end: 10, query: "Renamed C" }));
      await waitFor(() =>
        expect(
          completion(publish).items.some(
            (item) => item.label === "Renamed Crew",
          ),
        ).toBe(true),
      );
      const removed = completion(publish).items.find(
        (item) => item.label === "Renamed Crew",
      );
      await act(() => h.service.removeTeam(team.id));
      expect(removed?.canSelect?.("Enter")).toBe(false);
      expect(
        completion(publish).items.find((item) => item.label === "Renamed Crew")
          ?.disabled,
      ).toContain("changed");
    } finally {
      view.unmount();
      h.library.dispose();
      await h.context.fiber.dispose();
    }
  },
);

it("adds late synced teams without moving installed choices and checks member keys even at the same revision", async () => {
  const h = await savedTeamFixture();
  let snapshot = h.service.snapshot();
  const listeners = new Set<() => void>();
  const service = {
    snapshot: () => snapshot,
    subscribe: (f: () => void) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    joinable: () => [],
    memberships: () => [],
    teamHere: () => true,
  } as unknown as Agents;
  const update = (teams: readonly Team[]) =>
    act(() => {
      snapshot = { ...snapshot, teams };
      listeners.forEach((f) => {
        f();
      });
    });
  const publish = vi.fn();
  const view = render(
    <AgentsContext.Provider value={service}>
      <MentionCompletion
        session={h.session}
        scope="test"
        channelId="parent"
        publish={publish}
        observation={{ revision: 1, text: "@", start: 1, end: 1 }}
        query={{ start: 0, end: 1, query: "" }}
      />
    </AgentsContext.Provider>,
  );
  try {
    await waitFor(() => expect(completion(publish)?.items.length).toBe(2));
    const before = completion(publish).items.map((item) => item.id);
    const team = {
      id: "synced",
      revision: "same-head",
      name: "ReviewCrew",
      instructions: "",
      members: h.people.map((p) => p.pubkey),
    };
    update([team]);
    await waitFor(() => expect(completion(publish).items.length).toBe(3));
    expect(
      completion(publish)
        .items.slice(0, 2)
        .map((item) => item.id),
    ).toEqual(before);
    const choice = completion(publish).items[2];
    expect(choice?.canSelect?.("Enter")).toBe(true);
    update([{ ...team, members: [h.agent.pubkey] }]);
    expect(choice?.canSelect?.("Enter")).toBe(false);
    update([]); // e.g. account switch removes the old account's synced teams
    expect(choice?.canSelect?.("Enter")).toBe(false);
  } finally {
    view.unmount();
    h.library.dispose();
    await h.context.fiber.dispose();
  }
});

it("a current team blocks a same-name person during delayed Space resolution", async () => {
  const h = fixture();
  try {
    const names = ["Person 00"];
    const result = await resolveSpaceMention(
      h.session,
      { channelId: "parent", selected: [], teamNames: () => names },
      "Person 00",
      new AbortController().signal,
    );
    expect(result).toBeNull();
  } finally {
    h.library.dispose();
  }
});

it("a team named like a pasted npub does not block its owner during delayed Space resolution", async () => {
  const h = fixture();
  try {
    const key = npubEncode(h.agent.pubkey);
    const result = await resolveSpaceMention(
      h.session,
      {
        channelId: "parent",
        selected: [],
        teamNames: () => [key, `${key} Crew`],
      },
      key,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ pubkey: h.agent.pubkey });
  } finally {
    h.library.dispose();
  }
});

it.each([true, false])(
  "mixed-community team uses the individual chooser's addition permission: %s",
  async (canAdd) => {
    const h = await savedTeamFixture(true),
      publish = vi.fn();
    h.update({ members: [h.agent.pubkey] });
    const session = {
      ...h.session,
      outbox: { supports: () => canAdd } as unknown as RelaySession["outbox"],
    };
    await h.service.saveTeam({
      name: "ReviewCrew",
      instructions: "",
      members: h.people.map((p) => p.pubkey),
    });
    const view = render(
      <AgentsContext.Provider value={h.service}>
        <MentionCompletion
          session={session}
          scope="test"
          channelId="parent"
          publish={publish}
          observation={{ revision: 1, text: "@Review", start: 7, end: 7 }}
          query={{ start: 0, end: 7, query: "Review" }}
        />
      </AgentsContext.Provider>,
    );
    try {
      await waitFor(() => expect(completion(publish)?.items.length).toBe(1));
      const choice = completion(publish).items[0];
      expect(choice?.canSelect?.("Enter")).toBe(canAdd);
      if (canAdd) expect(choice?.edit).toEqual({ mentions: h.people });
      else expect(choice?.disabled).toContain("unavailable");
    } finally {
      view.unmount();
      h.library.dispose();
      await h.context.fiber.dispose();
    }
  },
);

it("rechecks team names when a pending Space directory read finishes", async () => {
  const h = fixture();
  let release!: (value: {
    people: { pubkey: string; name: string }[];
    hasMore: boolean;
  }) => void;
  const read = new Promise<{
    people: { pubkey: string; name: string }[];
    hasMore: boolean;
  }>((resolve) => {
    release = resolve;
  });
  const started = vi.fn();
  vi.spyOn(h.session.directMessages, "people").mockImplementation(async () => {
    started();
    return read;
  });
  const names: string[] = [];
  try {
    const result = resolveSpaceMention(
      h.session,
      { channelId: "parent", selected: [], teamNames: () => names },
      "Review Crew",
      new AbortController().signal,
    );
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    names.push("Review Crew");
    release({
      people: [{ pubkey: "e".repeat(64), name: "Review Crew" }],
      hasMore: false,
    });
    expect(await result).toBeNull();
  } finally {
    release({ people: [], hasMore: false });
    h.library.dispose();
  }
});

it("retires saved choices when the composer switches community sessions", async () => {
  const h = await savedTeamFixture(),
    publish = vi.fn();
  await h.service.saveTeam({
    name: "ReviewCrew",
    instructions: "",
    members: h.people.map((p) => p.pubkey),
  });
  const content = (session: RelaySession) => (
    <AgentsContext.Provider value={h.service}>
      <MentionCompletion
        session={session}
        scope={session.scope}
        channelId="parent"
        publish={publish}
        observation={{ revision: 1, text: "@Review", start: 7, end: 7 }}
        query={{ start: 0, end: 7, query: "Review" }}
      />
    </AgentsContext.Provider>
  );
  const view = render(content(h.session));
  try {
    await waitFor(() =>
      expect(
        completion(publish)?.items.some((item) => item.label === "ReviewCrew"),
      ).toBe(true),
    );
    view.rerender(
      content({ ...h.session, scope: `https://other.example.test:${viewer}` }),
    );
    await waitFor(() =>
      expect(
        completion(publish)?.items.some((item) => item.label === "ReviewCrew"),
      ).toBe(false),
    );
    view.rerender(content(h.session));
    await waitFor(() =>
      expect(
        completion(publish)?.items.some((item) => item.label === "ReviewCrew"),
      ).toBe(true),
    );
  } finally {
    view.unmount();
    h.library.dispose();
    await h.context.fiber.dispose();
  }
});

it("refreshes team visibility on an agents snapshot change with the same teams array and choice model", async () => {
  const h = await savedTeamFixture();
  const team = await h.service.saveTeam({
    name: "ReviewCrew",
    instructions: "",
    members: [h.agent.pubkey],
  });
  let origin = "https://other.example.test";
  let snapshot = { ...h.service.snapshot(), agents: [], teams: [team] };
  const listeners = new Set<() => void>();
  const service = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    memberships: () => [{ origin }],
    teamHere: () => false,
    joinable: () => [],
  } as unknown as Agents;
  const model = {
    pending: false,
    channel: h.session.channels.list().channels[0],
  } as ReturnType<typeof useMentionChoices>;
  const hook = renderHook(
    () => useTeamMentions(h.session, "parent", false, "Review", model),
    {
      wrapper: ({ children }) => (
        <AgentsContext.Provider value={service}>
          {children}
        </AgentsContext.Provider>
      ),
    },
  );
  try {
    expect(hook.result.current.choices).toEqual([]);
    const teams = snapshot.teams;
    act(() => {
      origin = h.relay.origin;
      snapshot = { ...snapshot };
      listeners.forEach((listener) => {
        listener();
      });
    });
    expect(snapshot.teams).toBe(teams);
    expect(hook.result.current.choices.map((choice) => choice.name)).toEqual([
      "ReviewCrew",
    ]);
    expect(hook.result.current.choices[0]?.canSelect()).toBe(true);
  } finally {
    hook.unmount();
    h.library.dispose();
    await h.context.fiber.dispose();
  }
});

it("projects confirmed synced teams through the real service without colliding with legacy IDs", async () => {
  const configs = new Map<string, communityConfig.CommunityConfigInput>();
  vi.spyOn(communityConfig, "communityConfig").mockImplementation(
    async (input) => {
      configs.set(input.community, input);
      return {
        attach: async () => {},
        binding: () => undefined,
        dispose: () => {},
      } as unknown as communityConfig.CommunityConfig;
    },
  );
  const home = "https://relay.example.test";
  const storage = memoryStorage();
  const team = {
    id: "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d",
    channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
    archived: false,
    members: ["1".padStart(64, "0"), "2".padStart(64, "0")],
  };
  const archived = {
    ...team,
    id: "archived",
    channel: "archived-channel",
    archived: true,
  };
  new SyncedTeams(storage).set(viewer, home, [team, archived]);
  const h = await savedTeamFixture(false, storage);
  h.catalog({
    status: "ready",
    entries: [
      {
        eventId: "legacy-head",
        createdAt: 1,
        record: {
          version: 1,
          community: "fixture",
          deleted: false,
          value: {
            type: "team",
            id: team.id,
            name: "Legacy Crew",
            agents: [h.agent.pubkey],
          },
        },
      },
    ],
  });
  const publish = vi.fn();
  const view = render(
    <AgentsContext.Provider value={h.service}>
      <MentionCompletion
        session={h.session}
        scope={h.session.scope}
        channelId="parent"
        publish={publish}
        observation={{ revision: 1, text: "@", start: 1, end: 1 }}
        query={{ start: 0, end: 1, query: "" }}
      />
    </AgentsContext.Provider>,
  );
  try {
    await waitFor(() => expect(configs.has(home)).toBe(true));
    await waitFor(() =>
      expect(
        completion(publish).items.some((item) => item.label === "Legacy Crew"),
      ).toBe(true),
    );
    // Discovery alone is not a confirmed copy. Startup and rendering settled.
    expect(h.service.snapshot().teams).toEqual([]);
    expect(
      completion(publish).items.some((item) => item.label === "Synced Crew"),
    ).toBe(false);
    const input = configs.get(home);
    if (!input) throw new Error("Config coordinator did not start");
    const confirm = (entry: typeof team, name: string) => {
      const subject = teamArtifact(viewer, home, entry);
      input.store.applyRead(subject, input.store.capture(subject), {
        kind: "head",
        event: finalizeEvent(
          {
            kind: 45010,
            created_at: 1,
            content: JSON.stringify({ version: 1, name, instructions: "" }),
            tags: [["op", "create"]],
          },
          generateSecretKey(),
        ) as RelayEvent,
      });
    };
    act(() => confirm(archived, "Archived Crew"));
    expect(h.service.snapshot().teams).toEqual([]);
    act(() => confirm(team, "Synced Crew"));
    await waitFor(() =>
      expect(
        completion(publish).items.some((item) => item.label === "Synced Crew"),
      ).toBe(true),
    );
    const choices = completion(publish).items;
    const synced = choices.find((item) => item.label === "Synced Crew");
    const legacy = choices.find((item) => item.label === "Legacy Crew");
    expect(synced?.edit).toEqual({ mentions: h.people });
    expect(legacy?.edit).toEqual({ mentions: [h.agent] });
    expect(synced?.id).not.toBe(legacy?.id);
    expect(synced?.canSelect?.("Enter")).toBe(true);
    expect(legacy?.canSelect?.("Enter")).toBe(true);
    expect(choices.some((item) => item.label === "Archived Crew")).toBe(false);
    act(() => {
      input.teams.set(viewer, home, [{ ...team, archived: true }, archived]);
      input.changed();
    });
    expect(synced?.canSelect?.("Enter")).toBe(false);
    expect(
      completion(publish).items.find((item) => item.label === "Synced Crew")
        ?.disabled,
    ).toContain("changed");
    expect(legacy?.canSelect?.("Enter")).toBe(true);
  } finally {
    view.unmount();
    h.library.dispose();
    await h.context.fiber.dispose();
  }
});
