// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { UnreadSnapshot } from "../../features/relay/unread";
import type { PresenceStatus } from "../../features/presence/presence";
import { ChannelSidebarItem } from "./ChannelSidebarItem";
import { UnreadBadge } from "./UnreadBadge";
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";

afterEach(cleanup);

const noTyping = Object.freeze([]);

function owner(profiles = new Map<string, Profile>()) {
  const listeners = new Set<() => void>();
  const preferenceListeners = new Set<() => void>();
  let muted: string[] = [];
  let snapshot: UnreadSnapshot = {
    target: { kind: "channel", channelId: "alpha" },
    observedCount: 0,
    attentionCount: 0,
    coverage: "observed",
    freshness: "observed",
    manual: "none",
  };
  const activity = {
    channelId: "alpha",
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  const session = {
    channels: { prepare: vi.fn() },
    sidebarPreferences: {
      snapshot: () => ({ data: { muted } }),
      subscribe: (listener: () => void) => {
        preferenceListeners.add(listener);
        return () => preferenceListeners.delete(listener);
      },
    },
    agentActivity: {
      subscribe: () => () => {},
      snapshot: () => ({
        status: "listening",
        records: [],
        turns: [
          {
            agent: "a".repeat(64),
            channelId: "alpha",
            turnId: "one",
            timestamp: Date.now(),
            state: "working",
          },
        ],
        typing: [],
        trimmed: 0,
      }),
    },
    media: (url: string) => `media:${url}`,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
    },
    typing: { snapshot: () => noTyping, subscribe: () => () => {} },
    unread: {
      snapshot: () => snapshot,
      subscribe: (_target: unknown, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      activity: () => activity,
      subscribeActivity: () => () => {},
    },
  } as unknown as RelaySession;
  return {
    session,
    profiles,
    listeners,
    mute(value: boolean) {
      muted = value ? ["alpha"] : [];
      for (const listener of preferenceListeners) listener();
    },
    manual() {
      snapshot = { ...snapshot, manual: "local-only" };
      for (const listener of listeners) listener();
    },
    unread(count: number, attentionCount = 0, row?: UnreadSnapshot["row"]) {
      snapshot = {
        ...snapshot,
        observedCount: count,
        attentionCount,
        ...(row ? { row } : {}),
      };
      for (const listener of listeners) listener();
    },
  };
}

function itemProps(
  session: RelaySession,
  working: boolean,
  channel: ChannelSummary = {
    id: "alpha",
    name: "Alpha",
    channelType: "stream",
  },
) {
  return {
    channel,
    session,
    working,
    sessionsEnabled: true,
    selected: undefined,
    onSelect: vi.fn(),
    onOpenThread: vi.fn(),
    onOpenMessage: vi.fn(),
  };
}

it("keeps the DM identity avatar and shows only a separate thinking badge", () => {
  const agent = "a".repeat(64);
  const state = owner(new Map([[agent, { name: "Buzzy", isAgent: true }]]));
  render(
    <ChannelSidebarItem
      {...itemProps(state.session, true, {
        id: "alpha",
        name: "Buzzy",
        channelType: "dm",
        participants: [agent],
      })}
      profile={state.profiles.get(agent)}
    />,
  );
  expect(
    document.querySelectorAll("[data-dm-identity] .buzz-avatar"),
  ).toHaveLength(1);
  expect(
    document.querySelector("[data-dm-identity] .agent-motion-avatar"),
  ).toBeNull();
  expect(
    document.querySelector("[data-dm-identity] .badge-pill-root"),
  ).toBeNull();
  const badge = document.querySelector("[data-channel-working]");
  expect(badge).toHaveAttribute("aria-label", "Buzzy working in Buzzy");
  expect(badge?.querySelectorAll("[data-state=working] > span")).toHaveLength(
    3,
  );
  expect(badge?.closest("[data-dm-identity]")).toBeNull();
});

it.each([
  { name: "unread-only", working: false, unread: true },
  { name: "working-only", working: true, unread: false },
])(
  "keeps $name state in the shared indicator position",
  ({ working, unread }) => {
    const state = owner();
    render(<ChannelSidebarItem {...itemProps(state.session, working)} />);
    if (unread) act(() => state.unread(1, 1));
    const stack = document.querySelector("[data-channel-indicators]");
    if (!(stack instanceof HTMLElement))
      throw new Error("Missing indicator stack");
    expect(stack.querySelector("[data-channel-working]") !== null).toBe(
      working,
    );
    expect(stack.querySelector("[data-channel-priority]") !== null).toBe(
      unread,
    );
  },
);

it("shows the viewer's agents typing in the channel or its threads as working", () => {
  const agent = "b".repeat(64),
    human = "c".repeat(64),
    hinted = "e".repeat(64);
  const listeners = new Set<() => void>();
  let typing: readonly {
    channelId: string;
    threadRootId?: string;
    pubkey: string;
  }[] = [];
  const library = { identities: [{ pubkey: agent }] };
  const state = owner(
    new Map<string, Profile>([
      [agent, { name: "Pinky" }],
      [hinted, { name: "Brain", isAgent: true }],
    ]),
  );
  const session = {
    ...state.session,
    typing: {
      snapshot: () => typing,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    agentChoices: {
      snapshot: () => library,
      subscribe: () => () => {},
    },
  } as unknown as RelaySession;
  const set = (next: typeof typing) =>
    act(() => {
      typing = next;
      for (const listener of listeners) listener();
    });
  const view = render(<ChannelSidebarItem {...itemProps(session, false)} />);
  set([{ channelId: "alpha", pubkey: human }]);
  expect(document.querySelector("[data-channel-working]")).toBeNull();
  set([{ channelId: "alpha", threadRootId: "d".repeat(64), pubkey: agent }]);
  expect(
    screen.getByRole("img", { name: "Pinky working in Alpha" }),
  ).toBeInTheDocument();
  // Another person's agent only declares itself in its profile.
  set([{ channelId: "alpha", pubkey: hinted }]);
  expect(document.querySelector("[data-channel-working]")).toBeNull();
  set([{ channelId: "beta", pubkey: agent }]);
  expect(document.querySelector("[data-channel-working]")).toBeNull();
  // A working agent in its DM keeps the avatar instead of also showing typing.
  view.rerender(
    <ChannelSidebarItem
      {...itemProps(session, false, {
        id: "beta",
        name: "Pinky",
        channelType: "dm",
        participants: [agent],
      })}
    />,
  );
  expect(
    screen.getByRole("img", { name: "Pinky working in Pinky" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: /typing/ })).toBeNull();
});

it("layers the working indicator above unread at the same position", () => {
  const state = owner();
  render(<ChannelSidebarItem {...itemProps(state.session, true)} />);
  act(() => state.unread(1, 1));
  const stack = document.querySelector("[data-channel-indicators]");
  const unread = stack?.querySelector("[data-channel-priority]");
  const working = stack?.querySelector("[data-channel-working]");
  expect(stack).toBeInTheDocument();
  expect(unread).toHaveAttribute("data-indicator-layer", "unread");
  expect(working).toHaveAttribute("data-indicator-layer", "working");
  expect(working?.compareDocumentPosition(unread as Node)).toBe(
    Node.DOCUMENT_POSITION_PRECEDING,
  );
});

it("keeps live unread updates and uses replacement session callbacks across row updates", async () => {
  const user = userEvent.setup(),
    first = owner(),
    second = owner();
  const onSelect = vi.fn(),
    replacement = vi.fn();
  const props = {
    channel: { id: "alpha", name: "Alpha", channelType: "stream" as const },
    session: first.session,
    working: false,
    selected: undefined,
    onSelect,
    onOpenThread: vi.fn(),
    onOpenMessage: vi.fn(),
  };
  const view = render(<ChannelSidebarItem {...props} />);
  const row = screen.getByRole("button", { name: "Alpha" });
  view.rerender(<ChannelSidebarItem {...props} />);
  act(() => first.unread(2));
  expect(
    screen.getByRole("img", { name: /2 observed unread/ }),
  ).toBeInTheDocument();
  await user.click(row);
  expect(onSelect).toHaveBeenCalledWith("alpha");
  view.rerender(
    <ChannelSidebarItem
      {...props}
      session={second.session}
      working
      selected="alpha"
      onSelect={replacement}
    />,
  );
  const activeRow = screen.getByRole("button", { name: /^Alpha/ });
  expect(activeRow).toHaveAttribute("aria-current", "page");
  expect(activeRow.querySelector("svg")).toHaveAttribute("width", "1rem");
  expect(activeRow.querySelector("svg")).toHaveAttribute("height", "1rem");
  expect(
    screen.getByRole("img", { name: /working in Alpha/ }),
  ).toBeInTheDocument();
  expect(first.listeners.size).toBe(0);
  expect(
    screen.queryByRole("img", { name: /observed unread/ }),
  ).not.toBeInTheDocument();
  act(() => second.unread(3));
  expect(
    screen.getByRole("img", { name: /3 observed unread/ }),
  ).toBeInTheDocument();
  await user.click(activeRow);
  expect(replacement).toHaveBeenCalledWith("alpha");
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("badges one-to-one DM avatars with live presence and sanitizes their media", () => {
  let status: PresenceStatus = "unknown";
  const presenceListeners = new Set<() => void>();
  const session = {
    ...owner().session,
    media: vi.fn((url: string) =>
      url.startsWith("https://") ? `/media?url=${url}` : undefined,
    ),
  };
  // Profile data is supplied by the page; presence is owned by the connected row.
  Object.defineProperties(session, {
    profiles: {
      get: () => {
        throw new Error("Unexpected profile acquisition");
      },
    },
    presence: {
      value: {
        status: () => status,
        limited: () => false,
        subscribe: (_pubkey: string, listener: () => void) => {
          presenceListeners.add(listener);
          return () => presenceListeners.delete(listener);
        },
      },
    },
  });
  const props = {
    channel: {
      id: "dm",
      name: "Alice",
      channelType: "dm" as const,
      participants: ["alice"],
    },
    session,
    working: false,
    selected: undefined,
    onSelect: vi.fn(),
    onOpenThread: vi.fn(),
    onOpenMessage: vi.fn(),
  };
  const view = render(<ChannelSidebarItem {...props} />);
  const row = screen.getByRole("button", { name: /^Alice$/ });
  expect(row.querySelector(".buzz-avatar")).toHaveTextContent("A");
  expect(row.querySelector(".buzz-avatar-status")).not.toHaveAttribute(
    "data-status",
  );
  act(() => {
    status = "away";
    for (const listener of presenceListeners) listener();
  });
  expect(row.querySelector(".buzz-avatar-status")).toHaveAttribute(
    "data-status",
    "away",
  );
  expect(row).toHaveAccessibleName("Alice");
  expect(row).toHaveAccessibleDescription("Presence: away");
  view.rerender(
    <ChannelSidebarItem
      {...props}
      profile={{
        name: "Alice",
        picture: "https://example.com/alice.png",
        isAgent: true,
      }}
    />,
  );
  expect(session.media).toHaveBeenLastCalledWith(
    "https://example.com/alice.png",
    "small",
  );
  const image = row.querySelector("img");
  expect(image).toHaveAttribute(
    "src",
    "/media?url=https://example.com/alice.png",
  );
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(row.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  if (!image) throw new Error("Avatar image is missing");
  fireEvent.error(image);
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector(".buzz-avatar")).toHaveTextContent("A");
  view.rerender(
    <ChannelSidebarItem
      {...props}
      profile={{ name: "Alice", picture: "javascript:bad" }}
    />,
  );
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  view.rerender(<ChannelSidebarItem {...props} profile={undefined} />);
  expect(row.querySelector(".buzz-avatar")).toHaveTextContent("A");
  for (const participants of [[], ["alice", "bob"]]) {
    view.rerender(
      <ChannelSidebarItem
        {...props}
        channel={{ ...props.channel, participants }}
      />,
    );
    expect(row.querySelector(".buzz-avatar")).toBeNull();
    expect(row).not.toHaveAccessibleDescription();
    expect(row).toHaveAccessibleName("Alice");
    if (participants.length) {
      expect(
        row.querySelector("[title='2 other participants']"),
      ).toHaveTextContent("2");
    } else expect(row.querySelector("svg")).toBeInTheDocument();
  }
});

it.each(["ContextMenu", "F10"])(
  "opens the row menu with %s without selecting the row",
  (key) => {
    const onSelect = vi.fn();
    const onOpenMenu = vi.fn();
    const channel = {
      id: "alpha",
      name: "Alpha",
      channelType: "stream" as const,
    };
    render(
      <ChannelSidebarItem
        channel={channel}
        session={owner().session}
        working={false}
        selected={undefined}
        onSelect={onSelect}
        onOpenThread={vi.fn()}
        onOpenMessage={vi.fn()}
        menuEnabled
        sectionKey="group:work"
        onOpenMenu={onOpenMenu}
      />,
    );
    const parent = screen.getByRole("button", { name: "Alpha" });
    fireEvent.keyDown(parent, { key, shiftKey: key === "F10" });
    expect(onOpenMenu).toHaveBeenCalledWith(
      channel,
      "group:work",
      parent.parentElement,
    );
    expect(onSelect).not.toHaveBeenCalled();
  },
);

it("retains the focused row across idle and working transitions", () => {
  const props = itemProps(owner().session, false);
  const view = render(<ChannelSidebarItem {...props} />);
  const row = () =>
    document.querySelector<HTMLElement>('button[data-channel-id="alpha"]');
  const control = row();
  control?.focus();
  for (const working of [true, false]) {
    view.rerender(<ChannelSidebarItem {...props} working={working} />);
    expect(row()).toBe(control);
    expect(control).toHaveFocus();
  }
});

it("marks the row for ordinary unread and working agents", () => {
  const state = owner();
  // Rendered by the row core, so it counts row renders but not badge-only ones.
  const frame = vi.fn(({ children }: { children: ReactNode }) => children);
  const props = {
    ...itemProps(state.session, true),
    sectionKey: "group:work",
    selectFrame: frame,
  };
  const view = render(<ChannelSidebarItem {...props} />);
  const row = () => document.querySelector("[data-channel-sidebar-row]");
  const select = () => document.querySelector('[data-channel-id="alpha"]');
  const badges = () =>
    document.querySelector("[data-channel-indicators]")?.parentElement;
  expect(select()).toHaveAttribute("data-working");
  expect(badges()).toHaveAttribute("data-working");
  expect(row()).not.toHaveAttribute("data-ordinary");
  // Protected attention alone keeps its dot; only ordinary backlog bolds the label.
  act(() => state.unread(1, 1));
  expect(row()).not.toHaveAttribute("data-ordinary");
  act(() => state.unread(2, 1));
  expect(row()).toHaveAttribute("data-ordinary");
  // Counts that leave the boolean alone re-render only the badge.
  const renders = frame.mock.calls.length;
  act(() => state.unread(3, 1));
  expect(frame).toHaveBeenCalledTimes(renders);
  act(() => state.unread(0, 0));
  expect(row()).not.toHaveAttribute("data-ordinary");
  expect(frame.mock.calls.length).toBeGreaterThan(renders);
  view.rerender(<ChannelSidebarItem {...props} working={false} />);
  expect(select()).not.toHaveAttribute("data-working");
  expect(badges()).not.toHaveAttribute("data-working");
});

it("shows what the row has not seen, while the channel stays unread", () => {
  const state = owner();
  render(
    <ChannelSidebarItem
      {...itemProps(state.session, false)}
      sectionKey="group:work"
    />,
  );
  const row = () => document.querySelector("[data-channel-sidebar-row]");
  const marker = (name: string) => document.querySelector(`[${name}]`);
  // Opening the channel saw its mention, thread reply and ordinary message.
  act(() =>
    state.unread(3, 2, { observedCount: 0, attentionCount: 0, threadCount: 0 }),
  );
  expect(row()).not.toHaveAttribute("data-ordinary");
  for (const name of [
    "data-channel-unread",
    "data-channel-priority",
    "data-channel-activity",
  ])
    expect(marker(name)).toBeNull();
  // A later thread reply lights the row's thread dot.
  act(() =>
    state.unread(4, 3, { observedCount: 1, attentionCount: 1, threadCount: 1 }),
  );
  expect(marker("data-channel-activity")).not.toBeNull();
  expect(row()).not.toHaveAttribute("data-ordinary");
});

it("marks a temporary channel with its lifetime and yields the slot to working agents", () => {
  const state = owner();
  const temporary: ChannelSummary = {
    id: "alpha",
    name: "Alpha",
    channelType: "stream",
    ttlSeconds: 604800,
  };
  const view = render(
    <ChannelSidebarItem {...itemProps(state.session, false, temporary)} />,
  );
  const label = "Temporary channel. Cleans up after 7 days without activity.";
  const marker = screen.getByRole("img", { name: label });
  expect(marker).toHaveAttribute("title", label);
  // Metadata inside the select surface, not a separate control.
  expect(marker.closest("button")).toHaveAttribute("data-channel-id", "alpha");
  act(() => state.unread(1, 1));
  expect(document.querySelector("[data-channel-priority]")).not.toBeNull();
  expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
  view.rerender(
    <ChannelSidebarItem {...itemProps(state.session, true, temporary)} />,
  );
  expect(document.querySelector("[data-channel-working]")).not.toBeNull();
  expect(document.querySelector("[data-channel-temporary]")).toBeNull();
  view.rerender(<ChannelSidebarItem {...itemProps(state.session, false)} />);
  expect(document.querySelector("[data-channel-temporary]")).toBeNull();
});

it("re-renders a working row for its agents' profiles, not every profile", () => {
  const agent = "a".repeat(64);
  let profiles = new Map<string, Profile>([
    [agent, { name: "Buzzy", isAgent: true }],
  ]);
  const listeners = new Set<() => void>();
  const session = {
    ...owner().session,
    profiles: {
      snapshot: () => profiles,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const publish = (next: typeof profiles) =>
    act(() => {
      profiles = next;
      for (const listener of listeners) listener();
    });
  let commits = 0;
  render(
    <Profiler id="row" onRender={() => commits++}>
      <ChannelSidebarItem {...itemProps(session, true)} />
    </Profiler>,
  );
  expect(
    screen.getByRole("img", { name: "Buzzy working in Alpha" }),
  ).toBeInTheDocument();
  const settled = commits;
  publish(new Map([...profiles, ["b".repeat(64), { name: "Bystander" }]]));
  expect(commits).toBe(settled);
  publish(
    new Map([...profiles, [agent, { name: "Buzzy Two", isAgent: true }]]),
  );
  expect(
    screen.getByRole("img", { name: "Buzzy Two working in Alpha" }),
  ).toBeInTheDocument();
});

it("keeps Solo unread labels and markers independent of mute", () => {
  const state = owner();
  const view = render(
    <UnreadBadge
      session={state.session}
      channelId="alpha"
      label="Solo"
      labelUnread="all"
    />,
  );
  const label = () =>
    view.container.querySelector("[data-channel-unread-title]");
  act(() => state.unread(2));
  expect(label()).toBeInTheDocument();
  act(() => state.mute(true));
  expect(label()).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: /2 observed unread/ }),
  ).toBeInTheDocument();
  act(() => state.unread(3, 1));
  expect(label()).toBeInTheDocument();
  expect(view.container.querySelector("[data-channel-priority]")).toBeNull();
  act(() => state.unread(0));
  expect(label()).toBeNull();
  expect(view.container.querySelector("[data-channel-unread]")).toBeNull();
});

it.each([
  { channelType: "stream", mutedIndicators: 0 },
  { channelType: "dm", mutedIndicators: 1 },
] as const)(
  "replaces the muted $channelType unread dot with a bell, restores it on unmute, and retains unread evidence",
  ({ channelType, mutedIndicators }) => {
    const state = owner();
    const view = render(
      <ChannelSidebarItem
        {...itemProps(state.session, false, {
          id: "alpha",
          name: "Alpha",
          channelType,
        })}
      />,
    );
    const row = () =>
      view.container.querySelector("[data-channel-sidebar-row]");
    expect(
      screen.queryByRole("img", { name: "Muted" }),
    ).not.toBeInTheDocument();
    act(() => state.mute(true));
    expect(screen.getByRole("img", { name: "Muted" })).toBeInTheDocument();
    expect(row()).not.toHaveAttribute("data-ordinary");
    act(() => state.mute(false));
    act(() => state.unread(2));
    expect(row()).toHaveAttribute("data-ordinary");
    act(() => state.mute(true));
    expect(row()).not.toHaveAttribute("data-ordinary");
    act(() => state.unread(3, 0));
    expect(row()).not.toHaveAttribute("data-ordinary");
    expect(
      view.container.querySelectorAll("[data-channel-unread]"),
    ).toHaveLength(mutedIndicators);
    expect(
      view.container.querySelectorAll("[data-channel-priority]"),
    ).toHaveLength(0);
    expect(screen.getByRole("img", { name: "Muted" })).toBeInTheDocument();
    act(() => state.mute(false));
    expect(row()).toHaveAttribute("data-ordinary");
    expect(
      screen.queryByRole("img", { name: "Muted" }),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelectorAll("[data-channel-priority]"),
    ).toHaveLength(mutedIndicators);
    act(() => state.mute(true));
    act(() => state.unread(4, 1));
    expect(row()).not.toHaveAttribute("data-ordinary");
    expect(view.container.querySelector("[data-channel-priority]")).toBeNull();
    expect(
      screen.getByRole("img", { name: /4 observed unread messages/ }),
    ).toBeInTheDocument();
    act(() => state.mute(false));
    expect(
      view.container.querySelector("[data-channel-priority]"),
    ).toBeInTheDocument();
    act(() => state.mute(true));
    act(() => state.manual());
    expect(row()).toHaveAttribute("data-ordinary");
    expect(
      screen.getByRole("img", { name: "Marked unread on this device only" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Muted" })).toBeInTheDocument();
  },
);

it("keeps cached mute from quieting unread but retains confirmed mute through read failures", async () => {
  const data: SidebarPreferences = {
    sections: [],
    assignments: {},
    starred: [],
    muted: ["alpha"],
  };
  let rejectRead!: (error: Error) => void;
  const read = vi.fn(
    () =>
      new Promise<SidebarPreferences>((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  const store = createSidebarPreferencesStore({
    available: true,
    read,
    persistence: {
      read: async () => [],
      readStartup: async () => ({ preferences: { savedAt: Date.now(), data } }),
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close() {},
    },
  });
  try {
    await store.ready;
    const preferences = store.queries;
    expect(preferences.snapshot().cached).toBe(true);
    const state = owner();
    state.unread(2);
    const session = { ...state.session, sidebarPreferences: preferences };
    const view = render(<ChannelSidebarItem {...itemProps(session, false)} />);
    const row = () =>
      view.container.querySelector("[data-channel-sidebar-row]");
    expect(row()).toHaveAttribute("data-ordinary");
    expect(
      screen.getByRole("img", { name: /2 observed unread/ }),
    ).toBeInTheDocument();
    let pending!: Promise<void>;
    await act(async () => {
      pending = preferences.refresh();
    });
    expect(preferences.snapshot().status).toBe("loading");
    expect(row()).toHaveAttribute("data-ordinary");
    await act(async () => {
      rejectRead(new Error("Preference read failed"));
      await pending;
    });
    expect(preferences.snapshot().status).toBe("error");
    expect(row()).toHaveAttribute("data-ordinary");
    read.mockResolvedValueOnce(data);
    await act(async () => {
      await preferences.refresh();
    });
    expect(preferences.snapshot().cached).toBeUndefined();
    expect(row()).not.toHaveAttribute("data-ordinary");
    await act(async () => {
      pending = preferences.refresh();
    });
    expect(row()).not.toHaveAttribute("data-ordinary");
    await act(async () => {
      rejectRead(new Error("Refresh failed"));
      await pending;
    });
    expect(row()).not.toHaveAttribute("data-ordinary");
    read.mockResolvedValueOnce({ ...data, muted: [] });
    await act(async () => {
      await preferences.refresh();
    });
    expect(row()).toHaveAttribute("data-ordinary");
  } finally {
    store.dispose();
  }
});
