// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { bindNames } from "../../features/identity-names/service";
import {
  openProfileTranscript,
  profileTarget,
  profileActivityViewTarget,
  profileHistoryTarget,
} from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";
import { createAgentMemories } from "../../features/agents/memory";
import { resolveMatch } from "../../plugins/contributions";
import { parseEntityLink } from "../../features/repos/routes";
import type {
  PanelProps,
  RegisteredPanel,
} from "../../features/panels/service";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";
import type { Navigation } from "../../features/navigation/controller";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  TranscriptRequest,
} from "../../features/agents/service";

import { agentDirectory } from "../../features/identity-names/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import { keypair, profile, signed } from "../../features/relay/testing";

const key = "a".repeat(64),
  viewer = "b".repeat(64),
  threadRoot = "c".repeat(64);
const personLink = profileTarget("d".repeat(64)) ?? "";
afterEach(cleanup);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
it("updates a mounted profile from the shared name view without replacing its identity", async () => {
  let name = "Local name";
  let notify = () => {};
  const owner = createRelaySession(null, {
    identityNames: {
      register() {},
      bind(source) {
        return bindNames(source, {
          snapshot: () => [
            {
              id: "test",
              activate() {
                return undefined;
              },
              scope: () => () => ({ name }),
            },
          ],
          subscribe(listener) {
            notify = listener;
            return () => {};
          },
        });
      },
    },
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  try {
    const presenceStatus = vi
      .spyOn(owner.session.presence, "status")
      .mockReturnValue("online");
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(key) ?? ""}
        close={() => {}}
      />,
    );
    expect(await screen.findByRole("heading", { name })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^Presence:/ })).toBeNull();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    expect(
      screen.getAllByRole("img", { name: `${name} avatar, online` }),
    ).toHaveLength(1);
    expect(document.querySelector(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      "online",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Channels" }));
    expect(
      screen.getByRole("img", { name: `${name} avatar, online` }),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Presence: Active" })).toBeNull();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Info" }));
    expect(screen.queryByRole("img", { name: /^Presence:/ })).toBeNull();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    expect(
      screen.getAllByRole("img", { name: `${name} avatar, online` }),
    ).toHaveLength(1);
    act(() => {
      name = "Edited name";
      notify();
    });
    expect(screen.getByRole("heading", { name })).toBeTruthy();
    for (const [status, label] of [
      ["away", "Away"],
      ["offline", "Offline"],
    ] as const) {
      presenceStatus.mockReturnValue(status);
      act(() => {
        name = `${label} name`;
        notify();
      });
      expect(screen.getByText(label, { exact: true })).toBeVisible();
      expect(
        screen.getByRole("img", { name: `${name} avatar, ${status}` }),
      ).toBeTruthy();
      expect(screen.queryByText("Active", { exact: true })).toBeNull();
    }
    presenceStatus.mockReturnValue("unknown");
    act(() => {
      name = "Unknown status name";
      notify();
    });
    expect(screen.getByRole("img", { name: `${name} avatar` })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Presence: Active" })).toBeNull();
    expect(document.querySelector(".buzz-avatar-status")).not.toHaveAttribute(
      "data-status",
    );
    expect(screen.queryByText(/^(Active|Away|Offline)$/)).toBeNull();
    expect(owner.session.profiles.snapshot().size).toBe(0);
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.dispose();
  }
});

it("recovers provider-owned names in the same live session and releases demand when disabled", async () => {
  const person = keypair();
  const relayKey = keypair();
  const publicProfile = profile(person, { name: "Public Carl" });
  let live!: LiveCallbacks;
  let entries = [agentDirectory];
  let changed = () => {};
  const read = vi.fn(async () => ({
    definitions: [],
    identities: [{ pubkey: person.pubkey, name: "Configured Carl" }],
  }));
  const owner = createRelaySession(
    {
      viewer: person.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: "wss://relay.example.test",
      query: async (filters) =>
        filters.some((filter) => filter.kinds?.includes(0))
          ? [publicProfile]
          : [],
      media: () => undefined,
      readAgentLibrary: read,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      identityNames: {
        register() {},
        bind(source) {
          return bindNames(source, {
            snapshot: () => entries,
            subscribe(listener) {
              changed = listener;
              return () => {};
            },
          });
        },
      },
    },
  );
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const reconnect = () => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    live.established();
  };
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(person.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "Configured Carl" });
    await waitFor(() =>
      expect(owner.session.profiles.snapshot().get(person.pubkey)?.name).toBe(
        "Public Carl",
      ),
    );
    act(() => live.state({ status: "connected", routes: [] }));
    act(() => live.state({ status: "retrying", routes: [] }));
    expect(screen.getByRole("heading", { name: "Public Carl" })).toBeTruthy();
    expect(owner.session.agentLibrary.snapshot().status).toBe("idle");
    expect(read).toHaveBeenCalledTimes(1);
    act(() => {
      live.state({ status: "connected", routes: [] });
      live.established();
    });
    await screen.findByRole("heading", { name: "Configured Carl" });
    expect(read).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    act(() => {
      entries = [];
      changed();
      reconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.useRealTimers();
    expect(screen.getByRole("heading", { name: "Public Carl" })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    act(() => {
      entries = [agentDirectory];
      changed();
    });
    await screen.findByRole("heading", { name: "Configured Carl" });
    expect(read).toHaveBeenCalledTimes(3);
    owner.dispose();
    act(reconnect);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.dispose();
  }
});

it("exposes thinking through the named profile avatar across tabs", async () => {
  const agent = keypair();
  const owner = createRelaySession({
    viewer: key,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [
      profile(agent, { name: "Thinking agent", is_agent: true }),
    ],
  });
  await owner.session.profiles.ensure([agent.pubkey]);
  vi.spyOn(owner.session.presence, "status").mockReturnValue("online");
  let activity = owner.session.agentActivity.snapshot();
  const listeners = new Set<() => void>();
  const session = {
    ...owner.session,
    agentActivity: {
      ...owner.session.agentActivity,
      snapshot: () => activity,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  try {
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(agent.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Thinking agent" }),
    ).toBeTruthy();
    const details = screen.getByRole("region", { name: "Profile details" });
    expect(details).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, available" }),
    ).toBeVisible();
    act(() => {
      activity = {
        ...activity,
        turns: [
          {
            agent: agent.pubkey,
            channelId: "alpha",
            turnId: "one",
            timestamp: 0,
            state: "working",
          },
        ],
      };
      for (const listener of listeners) listener();
    });
    expect(details).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, thinking" }),
    ).toBeVisible();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Channels" }));
    // The first channel list changes access, which clears cached profiles;
    // the rest of the app reads them again.
    await act(() => owner.session.profiles.ensure([agent.pubkey]));
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, thinking" }),
    ).toBeVisible();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    act(() => {
      activity = { ...activity, turns: [] };
      for (const listener of listeners) listener();
    });
    expect(details).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, available" }),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

function renderAgentActivity(
  tabs: { title: string; role?: string }[],
  rootId?: string,
  transcript: "opened" | "shown again" | false = false,
  navigation?: Navigation,
  channelType?: "solo" | "dm" | "stream",
  linkTab = false,
  memory?: {
    body: string;
    context: PanelProps["context"];
    dirty: boolean;
    saving: boolean;
  },
) {
  const owner = createRelaySession(null);
  const memories =
    memory &&
    createAgentMemories(
      async () => ({
        entries: [
          { slug: "core", body: memory.body, eventId: key, createdAt: 1 },
        ],
        partial: false,
      }),
      viewer,
      () => true,
    );
  // The originating channel, as the community lists it.
  const listed = channelType && {
    ...owner.session.channels.list(),
    channels: [{ id: "originating-channel", name: "Originating", channelType }],
  };
  const session = listed
    ? {
        ...owner.session,
        channels: { ...owner.session.channels, list: () => listed },
      }
    : owner.session;
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: memories
      ? { ...session, agentMemories: memories.capability }
      : session,
    ...(navigation && { scope: `https://relay.test:${viewer}`, viewer }),
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const offered = vi.fn();
  const type = {
    key: "test/echo",
    title: "Echo",
    ...(memory && {
      ProfileActions: ({ children }: { children: ReactNode }) => {
        useAgentSaveState(memory.dirty, memory.saving);
        return children;
      },
    }),
    tabs: tabs.map(({ title, role }) => ({
      id: title.toLowerCase(),
      title,
      role,
      component: function Echo({
        conversation,
        initialTranscript,
        openConversation,
      }: {
        conversation?: { channelId: string; rootId?: string };
        initialTranscript?: TranscriptRequest;
        openConversation?: (channelId: string, threadRootId?: string) => void;
      }) {
        // Like a type's Activity tab: it acts on the request as it shows.
        const [first] = useState(!!initialTranscript);
        // Like a settings section, it can hold an unsaved change.
        const [dirty, setDirty] = useState(false);
        useAgentSaveState(dirty, false, role === "settings");
        // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening.
        useEffect(() => {
          if (!initialTranscript) return;
          offered(initialTranscript.opening);
          initialTranscript.done();
        }, [initialTranscript?.opening]);
        return (
          <>
            <p>Echo {title.toLowerCase()}</p>
            {role === "settings" && (
              <button type="button" onClick={() => setDirty(true)}>
                Make a change
              </button>
            )}
            {first && <p>Transcript first</p>}
            {conversation && (
              <p>
                Opened from {conversation.channelId}/
                {conversation.rootId ?? "channel"}
              </p>
            )}
            {openConversation && (
              <>
                <button type="button" onClick={() => openConversation("c")}>
                  Open channel
                </button>
                <button
                  type="button"
                  onClick={() => openConversation("c", threadRoot)}
                >
                  Open thread
                </button>
              </>
            )}
          </>
        );
      },
    })),
  } as unknown as RegisteredAgentType;
  const agent = {
    key,
    pubkey: key,
    ...(memory && { owner: viewer }),
    name: "Echo",
    type: type.key,
    place: "here",
    config: {},
    attention: {},
  } as unknown as Agent;
  const types = [type];
  const agentsSnapshot = { agents: [agent], teams: [] };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => agentsSnapshot,
    types: () => types,
    find: (pubkey: string) => (pubkey === key ? agent : undefined),
    memberships: () => [],
    configHistory: () => undefined,
    addedTabs: () =>
      linkTab
        ? [
            {
              key: "link",
              title: "Link",
              component: ({ open }: { open?: (target: string) => boolean }) => (
                <button type="button" onClick={() => open?.(personLink)}>
                  Open person
                </button>
              ),
            },
          ]
        : [],
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
  const open = vi.fn(() => true);
  let target = profileActivityViewTarget(key) ?? "";
  // Like Working now: the opener asks as it opens the target.
  if (transcript === "opened") openProfileTranscript(target, () => true);
  const panel = (mount: number) => (
    <ProfilePanel
      key={mount}
      relay={relay}
      agents={agents}
      target={target}
      context={
        memory?.context ?? {
          channelId: "originating-channel",
          ...(rootId && { rootId }),
          canOpen: () => true,
          open,
        }
      }
      close={() => {}}
      {...(navigation && { navigation })}
    />
  );
  let mounts = 0;
  const view = render(panel(mounts));
  return Object.assign(
    () => {
      cleanup();
      owner.dispose();
    },
    {
      target,
      offered,
      open,
      navigate: (next: string) => {
        target = next;
        view.rerender(panel(mounts));
      },
      /** Remounts the retained profile, as on returning to its channel. */
      remount: () => view.rerender(panel(++mounts)),
      refresh: () => view.rerender(panel(mounts)),
    },
  );
}

it.each([false, "opened"] as const)(
  "keeps an Activity profile mounted across version addresses (transcript %s)",
  (transcript) => {
    const dispose = renderAgentActivity(
      [
        { title: "Settings", role: "settings" },
        { title: "Activity", role: "activity" },
      ],
      "thread-root",
      transcript,
    );
    try {
      const activity = screen.getByText("Echo activity");
      const pane = activity.closest('[role="tabpanel"]') as HTMLElement;
      pane.scrollTop = 636;
      for (const target of [
        profileHistoryTarget(dispose.target),
        profileHistoryTarget(dispose.target, {
          side: "instructions",
          id: "b".repeat(64),
        }),
        dispose.target,
      ]) {
        dispose.navigate(target);
        expect(screen.getByText("Echo activity")).toBe(activity);
        expect(pane.scrollTop).toBe(636);
        expect(!!screen.queryByText("Transcript first")).toBe(!!transcript);
      }
    } finally {
      dispose();
    }
  },
);

it("opens an agent's activity on its type's Activity tab, the profile's only one", async () => {
  const dispose = renderAgentActivity(
    [
      { title: "Settings", role: "settings" },
      { title: "Activity", role: "activity" },
    ],
    "thread-root",
  );
  try {
    expect(
      screen.getByRole("tab", { name: "Activity", selected: true }),
    ).toBeVisible();
    // The originating thread reaches the tab that selects its session.
    expect(
      screen.getByText("Opened from originating-channel/thread-root"),
    ).toBeVisible();
    expect(screen.getAllByRole("tab", { name: "Activity" })).toHaveLength(1);
    expect(screen.getByText("Echo activity")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.getByText("Echo settings")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("Echo activity")).toBeVisible();
  } finally {
    dispose();
  }
});

it.each([
  ["solo", "channel"],
  ["dm", "channel"],
  ["stream", "thread-root"],
] as const)(
  "gives the Activity tab a %s's message as its %s, as agents keep it",
  (channelType, place) => {
    const dispose = renderAgentActivity(
      [{ title: "Activity", role: "activity" }],
      "thread-root",
      false,
      undefined,
      channelType,
    );
    try {
      expect(
        screen.getByText(`Opened from originating-channel/${place}`),
      ).toBeVisible();
    } finally {
      dispose();
    }
  },
);

it("lets the Activity tab open a turn's channel or thread in this community, only with navigation", () => {
  const navigate = vi.fn(async () => ({ status: "opened" as const }));
  const tabs = [{ title: "Activity", role: "activity" }];
  const dispose = renderAgentActivity(tabs, undefined, false, {
    open: navigate,
  } as unknown as Navigation);
  const scope = { viewer, communityOrigin: "https://relay.test" };
  try {
    act(() => screen.getByRole("button", { name: "Open thread" }).click());
    // A thread opens at its root message, which names the thread.
    expect(navigate).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "c",
      messageId: threadRoot,
      threadRootId: threadRoot,
    });
    act(() => screen.getByRole("button", { name: "Open channel" }).click());
    expect(navigate).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "c",
    });
  } finally {
    dispose();
  }
  const without = renderAgentActivity(tabs);
  try {
    expect(screen.getByText("Echo activity")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open thread" })).toBeNull();
  } finally {
    without();
  }
});

it("asks the Activity tab for its transcript only when the opener knows the conversation", () => {
  const tabs = [{ title: "Activity", role: "activity" }];
  // Work in several threads opens the plain destination, never a transcript.
  let dispose = renderAgentActivity(tabs);
  try {
    expect(screen.getByText("Echo activity")).toBeVisible();
    expect(screen.queryByText("Transcript first")).toBeNull();
  } finally {
    dispose();
  }
  dispose = renderAgentActivity(tabs, "thread-root", "opened");
  try {
    expect(screen.getByText("Transcript first")).toBeVisible();
  } finally {
    dispose();
  }
  // Its retained tab remounting, as on returning to the channel, asks nothing.
  dispose = renderAgentActivity(tabs, "thread-root", "shown again");
  try {
    expect(screen.getByText("Echo activity")).toBeVisible();
    expect(screen.queryByText("Transcript first")).toBeNull();
  } finally {
    dispose();
  }
});

it("asks for the transcript once, not again on returning from another section", async () => {
  const dispose = renderAgentActivity(
    [
      { title: "Settings", role: "settings" },
      { title: "Activity", role: "activity" },
    ],
    "thread-root",
    "opened",
  );
  try {
    expect(screen.getByText("Transcript first")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("Echo activity")).toBeVisible();
    expect(screen.queryByText("Transcript first")).toBeNull();
  } finally {
    dispose();
  }
});

it("keeps a new opening for a profile on another section to itself, so a remount does not reopen it", async () => {
  const sections = [
    { title: "Settings", role: "settings" },
    { title: "Activity", role: "activity" },
  ];
  const user = userEvent.setup();
  let dispose = renderAgentActivity(sections, "thread-root", "shown again");
  try {
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    // Working now opens the retained profile again while it shows Identity.
    act(() => void openProfileTranscript(dispose.target, () => true));
    dispose.remount();
    expect(screen.getByText("Echo activity")).toBeVisible();
    expect(screen.queryByText("Transcript first")).toBeNull();
  } finally {
    dispose();
  }
  dispose = renderAgentActivity(sections, "thread-root", "shown again");
  try {
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    act(() => void openProfileTranscript(dispose.target, () => true));
    // Not remounted, the profile shows Activity for the opening itself.
    expect(
      screen.getByRole("tab", { name: "Activity", selected: true }),
    ).toBeVisible();
    expect(screen.getByText("Transcript first")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.queryByText("Transcript first")).toBeNull();
  } finally {
    dispose();
  }
});

it("keeps an unsaved change until the reader chooses to leave it for a transcript", async () => {
  const dispose = renderAgentActivity(
    [
      { title: "Settings", role: "settings" },
      { title: "Activity", role: "activity" },
    ],
    "thread-root",
  );
  const user = userEvent.setup();
  try {
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    await user.click(screen.getByRole("button", { name: "Make a change" }));
    act(() => void openProfileTranscript(dispose.target, () => true));
    // The section guard asks first, as choosing the Activity tab does.
    const dialog = screen.getByRole("alertdialog", {
      name: "Discard changes?",
    });
    expect(screen.getByText("Echo settings")).toBeVisible();
    expect(dispose.offered).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    expect(
      screen.getByRole("tab", { name: "Activity", selected: true }),
    ).toBeVisible();
    expect(dispose.offered).toHaveBeenCalledOnce();
  } finally {
    dispose();
  }
});

it("asks before a plugin tab's link replaces a profile with an unsaved name", async () => {
  const dispose = renderAgentActivity(
    [],
    undefined,
    false,
    undefined,
    undefined,
    true,
  );
  const user = userEvent.setup();
  try {
    await user.click(screen.getByRole("tab", { name: "Link" }));
    await user.click(screen.getByRole("button", { name: "Open person" }));
    expect(dispose.open).toHaveBeenCalledTimes(1);
    dispose.open.mockClear();
    await user.click(
      screen.getByRole("button", { name: "Agent profile actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Change name" }),
    );
    await user.type(screen.getByRole("textbox", { name: "Agent name" }), "!");
    await user.click(screen.getByRole("button", { name: "Open person" }));
    const dialog = screen.getByRole("alertdialog", {
      name: "Discard changes?",
    });
    expect(dispose.open).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue(
      "Echo!",
    );
    await user.click(screen.getByRole("button", { name: "Open person" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(dispose.open).toHaveBeenCalledExactlyOnceWith(personLink);
  } finally {
    dispose();
  }
});

it.each([
  { dirty: false, saving: false },
  { dirty: true, saving: false },
  { dirty: true, saving: true },
])(
  "routes profile memory links with real panel matching (guard %j)",
  async ({ dirty, saving }) => {
    const channelId = "11111111-1111-4111-8111-111111111111";
    const messageId = "e".repeat(64);
    const messageLink = `buzz://message?channel=${channelId}&id=${messageId}`;
    const panelLink = `buzz://repo?owner=${key}&d=example`;
    const navigate = vi.fn(async () => ({ status: "opened" as const }));
    const push = vi.fn((_target: string) => true);
    const panels: RegisteredPanel[] = [
      {
        id: "repo",
        title: "Repository",
        key: "test/repo",
        pluginId: "test",
        revision: "one",
        matches: (target) => !!parseEntityLink(new URL(target)),
        component: () => null,
      },
    ];
    // The production panel host resolves only registered panels, not messages.
    const context = {
      channelId: "originating-channel",
      canOpen: (target: string) => !!resolveMatch(panels, target),
      open: () => false,
      push: (target: string) => !!resolveMatch(panels, target) && push(target),
    };
    expect(context.canOpen(messageLink)).toBe(false);
    expect(context.canOpen(panelLink)).toBe(true);
    const memory = {
      body: `[Source](${messageLink})\n\n[Repository](${panelLink})`,
      context,
      dirty: false,
      saving: false,
    };
    const dispose = renderAgentActivity(
      [],
      undefined,
      false,
      {
        open: navigate,
        snapshot: () => ({ entry: { target: { kind: "conversation" } } }),
      } as unknown as Navigation,
      undefined,
      false,
      memory,
    );
    const user = userEvent.setup();
    try {
      await user.click(screen.getByRole("tab", { name: "Memory" }));
      await user.click(await screen.findByRole("button", { name: "core" }));
      memory.dirty = dirty;
      memory.saving = saving;
      dispose.refresh();
      for (const name of ["Source", "Repository"]) {
        navigate.mockClear();
        push.mockClear();
        await user.click(screen.getByRole("link", { name }));
        if (saving) {
          expect(screen.queryByRole("alertdialog")).toBeNull();
          expect(navigate).not.toHaveBeenCalled();
          expect(push).not.toHaveBeenCalled();
          continue;
        }
        if (dirty) {
          expect(navigate).not.toHaveBeenCalled();
          expect(push).not.toHaveBeenCalled();
          await user.click(
            within(screen.getByRole("alertdialog")).getByRole("button", {
              name: "Keep editing",
            }),
          );
          expect(navigate).not.toHaveBeenCalled();
          expect(push).not.toHaveBeenCalled();
          await user.click(screen.getByRole("link", { name }));
          await user.click(
            within(screen.getByRole("alertdialog")).getByRole("button", {
              name: "Discard changes",
            }),
          );
        }
        if (name === "Source") {
          expect(navigate).toHaveBeenCalledExactlyOnceWith({
            version: 1,
            kind: "conversation",
            channelId,
            messageId,
            scope: { viewer, communityOrigin: "https://relay.test" },
          });
          expect(push).not.toHaveBeenCalled();
        } else {
          expect(push).toHaveBeenCalledExactlyOnceWith(panelLink);
          expect(navigate).not.toHaveBeenCalled();
        }
      }
    } finally {
      dispose();
    }
  },
);

it("asks an Activity tab already open for the transcript, rather than opening another", () => {
  const dispose = renderAgentActivity(
    [{ title: "Activity", role: "activity" }],
    "thread-root",
  );
  try {
    expect(dispose.offered).not.toHaveBeenCalled();
    const opened: string[] = [];
    act(
      () =>
        void openProfileTranscript(dispose.target, (next) => {
          opened.push(next);
          return true;
        }),
    );
    // The opener reaches the same Activity destination this tab shows.
    expect(opened).toEqual([profileActivityViewTarget(key)]);
    expect(dispose.offered).toHaveBeenCalledOnce();
  } finally {
    dispose();
  }
});

it("opens an agent's activity on its type's first tab when the type has no Activity tab", () => {
  const dispose = renderAgentActivity([
    { title: "Settings", role: "settings" },
    { title: "Logs" },
  ]);
  try {
    expect(
      screen.getByRole("tab", { name: "Identity", selected: true }),
    ).toBeVisible();
    expect(screen.getByText("Echo settings")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
  } finally {
    dispose();
  }
});

it("links an owned agent whose type's plugin is off to Manage plugins", async () => {
  const owner = createRelaySession(null);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const agent = {
    key,
    pubkey: key,
    name: "Lou",
    type: "test/off",
    place: "here",
    config: {},
    attention: {},
  } as unknown as Agent;
  const types: RegisteredAgentType[] = [];
  const agentsSnapshot = { agents: [agent], teams: [] };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => agentsSnapshot,
    types: () => types,
    find: (pubkey: string) => (pubkey === key ? agent : undefined),
    memberships: () => [],
    configHistory: () => undefined,
    addedTabs: () => [],
  } as unknown as Agents;
  const navigation = {
    snapshot: () => ({
      entry: { id: "profile", target: { version: 1, kind: "home" } },
    }),
    open: vi.fn(async () => ({ status: "opened" as const })),
  } as unknown as Navigation;
  try {
    render(
      <ProfilePanel
        relay={relay}
        agents={agents}
        navigation={navigation}
        target={profileTarget(key) ?? ""}
        close={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Manage plugins" }));
    expect(navigation.open).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      kind: "settings",
      section: "plugins",
    });
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows historical verification time and issuer, discloses cache, and hides disabled marks", async () => {
  const { eventDto } = await import("../../features/relay/events");
  const person = keypair();
  const relayKey = keypair();
  let live!: LiveCallbacks;
  let sink:
    | import("../../features/relay/verified-profile").VerifiedProfileSink
    | undefined;
  // Kind-0 reads wait on the test; the first fails while the projection succeeds.
  const profileReads: ReturnType<typeof deferred>[] = [];
  const owner = createRelaySession({
    viewer: person.pubkey,
    relayAuthor: relayKey.pubkey,
    scope: "wss://relay.example.test",
    query: async (filters) => {
      if (filters.some((filter) => filter.kinds?.includes(0))) {
        const read = deferred();
        profileReads.push(read);
        if (profileReads.length === 1)
          read.reject(new Error("profile read rejected"));
        await read.promise;
      }
      return [];
    },
    media: () => undefined,
    verifiedProfiles: { pubkey: relayKey.pubkey, multipleIssuers: false },
    readVerifiedProfileAuthority: async () => null,
    subscribe(callbacks) {
      live = callbacks;
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles(_filter, next) {
          sink = next;
          return () => {};
        },
      };
    },
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  try {
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(person.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    await waitFor(() => expect(sink).toBeDefined());
    act(() => {
      sink?.event(
        eventDto(
          signed(relayKey, {
            kind: 30382,
            created_at: 1_000_000,
            content: "",
            tags: [
              ["d", person.pubkey],
              ["p", person.pubkey],
              ["active", "true"],
              ["display_name", "Alice"],
              ["username", "alice"],
              ["issuer_label", "Example"],
              ["verified_at", "1000000"],
              ["full_name", "Alice Example"],
            ],
          }),
        ),
      );
      sink?.eose();
    });
    expect(await screen.findByRole("heading", { name: "Alice" })).toBeVisible();
    expect(screen.getByText(/Name verified by Example.*@alice/)).toBeVisible();
    expect(screen.getByText("Alice Example")).toBeVisible();
    expect(
      screen.getByText("Alice Example").closest("p")?.querySelector("svg"),
    ).not.toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Info" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load this profile.",
    );
    const retryButton = screen.getByRole("button", { name: "Retry profile" });
    // A pending retry keeps its focused control and announces the read.
    await user.click(retryButton);
    await waitFor(() => expect(profileReads).toHaveLength(2));
    expect(retryButton).toHaveFocus();
    expect(retryButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading profile…")).toHaveAttribute(
      "role",
      "status",
    );
    await act(async () => profileReads[1]?.reject(new Error("still rejected")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load this profile.",
    );
    expect(retryButton).toHaveFocus();
    expect(retryButton).not.toHaveAttribute("aria-busy");
    // Success removes Retry and hands its focus to the profile region.
    await user.click(retryButton);
    await waitFor(() => expect(profileReads).toHaveLength(3));
    await act(async () => profileReads[2]?.resolve());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry profile" })).toBeNull();
    expect(
      screen.getByRole("region", { name: "Profile details" }),
    ).toHaveFocus();
    expect(screen.getByText("Name verified by Example")).toBeVisible();
    expect(screen.getByText(/Last verified/)).toHaveTextContent(/1970/);
    expect(screen.getByText(/current issuer endorsement/)).toBeVisible();
    act(() => live.state({ status: "connecting", routes: [] }));
    expect(await screen.findByText(/Cached verification/)).toBeVisible();
    expect(
      screen.getByText("Alice Example").closest("p")?.querySelector("svg"),
    ).toBeNull();
    expect(screen.getByText(/Cached evidence/)).toBeVisible();
    await act(async () => live.state({ status: "connected", routes: [] }));
    await waitFor(() =>
      expect(screen.queryByText("Name verified by Example")).toBeNull(),
    );
    expect(screen.queryByText("Alice Example")).toBeNull();
    expect(screen.queryByText(/Cached verification/)).toBeNull();
  } finally {
    for (const read of profileReads) read.resolve();
    cleanup();
    owner.dispose();
  }
});
