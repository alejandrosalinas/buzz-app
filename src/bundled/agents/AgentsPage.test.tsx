import { ProfilePanel } from "../profiles/ProfilePanel";
import { createAgentMemories } from "../../features/agents/memory";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import {
  profileActivityViewTarget,
  profileTarget,
} from "../../features/profiles/target";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import closeRequest from "../../../src-tauri/src/close-request.js?raw";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { flushSync } from "react-dom";
import { onBestieMade } from "./BestieChoice";
import { Context } from "@deepseek-ai/cordis";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentCreateProps,
  AgentProviderSnapshot,
  AgentViewProps,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
  TeamChange,
  FoundAgents,
  TeamPort,
} from "../../features/agents/service";
import type { OldTeam, PortableAgent } from "../../features/agents/native";
import type { SyncState } from "../../features/agents/team-migration";
import { localStore } from "../../features/agents/state";
import {
  chooseDefaultAgent,
  setDefaultAgent,
} from "../../features/solo/default-agent";
import { readView, writeView } from "../../shared/view-state";
import type { RelayData } from "../../features/relay/service";
import type { CommunityReader } from "../../features/communities/service";
import {
  createNavigationController,
  type Navigation,
} from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import type { PageNavigation } from "../../features/navigation/service";
import type { OpenTarget } from "../../features/navigation/targets";
import { PlugIcon, RobotIcon } from "../../shared/design-system/icons";
import { AgentSettings } from "../../app/AgentSettings";
import { registerNavigationShortcuts } from "../../app/shortcuts";
import { ShortcutsService } from "../../features/shortcuts/service";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";
import { AgentsPage } from "./AgentsPage";

vi.mock("../../features/profiles/avatar-upload", async (actual) => ({
  ...(await actual<typeof import("../../features/profiles/avatar-upload")>()),
  paintEmojiAvatar: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const agent = (name: string, n: number): Agent => ({
  key: String(n).repeat(64),
  pubkey: String(n).repeat(64),
  name,
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: { reply: `${name} says hi` },
  skipped: {},
  timers: {},
  attentionEnabled: true,
  attention: {
    "interest/default": {
      slug: "interest/default",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Help." },
    },
    "watch/hourly": {
      slug: "watch/hourly",
      modifiedAt: 1,
      value: {
        type: "timer",
        interest_id: "default",
        prompt: "Check in",
        enabled: true,
        interval_secs: 3600,
        armed_at: 1,
        max_occurrences: null,
        expires_at: null,
      },
    },
  },
});

const portable: PortableAgent[] = [
  {
    source: "harness",
    pubkey: "a".repeat(64),
    name: "Ada",
    relay: "wss://relay.example",
  },
  {
    source: "installed",
    pubkey: "b".repeat(64),
    name: "Bea",
    picture: "https://old.example/media/b.png",
    relay: "",
  },
];

function provider(
  initial: AgentProviderSnapshot["readiness"],
  DialogBody: (props: { onClose(): void }) => ReactNode = () => (
    <p>Provider controls</p>
  ),
  attentionLabel = "Set up provider",
) {
  let state: AgentProviderSnapshot =
    initial === "attention"
      ? { readiness: initial, attentionLabel }
      : { readiness: initial };
  let attentionAction: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const check = vi.fn(async () => undefined);
  return {
    contribution: {
      snapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      check,
      get attentionAction() {
        return attentionAction;
      },
      DialogBody,
    },
    check,
    set(next: AgentProviderSnapshot) {
      state = next;
      for (const listener of listeners) listener();
    },
    setAttentionAction(next: (() => void) | undefined) {
      attentionAction = next;
    },
  };
}

function setup(
  saved: Agent[],
  {
    shown = true,
    scope = undefined as string | undefined,
    model = false,
    status = "ready" as AgentsSnapshot["status"],
    more = [] as RegisteredAgentType[],
    dirtySettings = false,
    found = portable as readonly PortableAgent[],
    warnings = [] as readonly string[],
    discover = async (): Promise<FoundAgents> => ({
      agents: found,
      teams: [],
      warnings,
      here: [],
    }),
    page = {} as {
      navigation?: PageNavigation;
      navigator?: Navigation;
      communities?: CommunityReader;
    },
    teams = [] as AgentsSnapshot["teams"],
    linkTab = false,
  } = {},
) {
  let snapshot: AgentsSnapshot = {
    status,
    classifier: "unavailable",
    agents: saved,
    running: saved,
    interrupted: [],
    teams,
  };
  const listeners = new Set<() => void>();
  const echoProvider = provider("ready", ({ onClose }) => (
    <>
      <p>Echo controls</p>
      <button type="button" onClick={onClose}>
        Save defaults
      </button>
    </>
  ));
  const DirtySettings = ({ agent, save, settingsHost }: AgentViewProps) => {
    const saved = (agent.config as { reply: string }).reply;
    const [reply, setReply] = useState(saved);
    const [error, setError] = useState("");
    const pendingSave = settingsHost?.pendingSave;
    // As real settings tabs do through AgentSaveButton.
    useAgentSaveState(reply !== saved, false);
    return settingsHost ? (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void save({ reply }).catch((reason: unknown) =>
            setError(String(reason instanceof Error ? reason.message : reason)),
          );
        }}
      >
        {settingsHost.typeControl?.(true)}
        <p>Provider settings</p>
        <label>
          Reply
          <input
            value={reply}
            onChange={(event) => setReply(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={!pendingSave}>
          Save
        </button>
      </form>
    ) : (
      <p>Provider settings</p>
    );
  };
  const tabs = dirtySettings
    ? [
        {
          id: "settings",
          title: "Settings",
          role: "settings" as const,
          component: DirtySettings,
        },
      ]
    : [{ id: "reply", title: "Reply", component: () => <p>Reply tab</p> }];
  const type = {
    key: "test/echo",
    pluginId: "test",
    revision: "1",
    id: "echo",
    title: "Echo",
    icon: RobotIcon,
    description: "Says its line.",
    migrationWarning: "Anything Echo left running will stop.",
    defaults: () => ({ config: { reply: "" } }),
    summary: (item: Agent) => (item.config as { reply: string }).reply,
    Peek: ({ agent }: { agent: Agent }) => <p>Peek of {agent.name}</p>,
    CreateModel: model
      ? ({
          agent,
          openSettings,
          config,
          onChange,
          disabled,
        }: AgentCreateProps<{ reply: string }>) => (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...config, reply: "New model" })}
            >
              Change model
            </button>
            <button type="button" onClick={openSettings}>
              Model settings for {agent?.name}
            </button>
          </>
        )
      : undefined,
    provider: echoProvider.contribution,
    tabs,
    Create: ({
      config,
      onChange,
    }: {
      config: { reply: string };
      onChange(config: { reply: string }): void;
    }) => (
      <input
        aria-label="Reply"
        value={config.reply}
        onChange={(event) => onChange({ reply: event.target.value })}
      />
    ),
  } as unknown as RegisteredAgentType;
  const created = agent("Nova", 3);
  const types = [type, ...more];
  // Local teams kept from moving by their editor.
  const held = new Set<string>();
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    find: (pubkey: string) => snapshot.agents.find((a) => a.pubkey === pubkey),
    relay: () => undefined,
    handle: () => undefined,
    canConnectExternal: () => false,
    connectExternal: vi.fn(),
    sessionState: () => "unavailable" as const,
    session: vi.fn(async () => {}),
    register: vi.fn(),
    addTool: vi.fn(),
    addInstructions: vi.fn(),
    tools: () => [],
    create: vi.fn(async () => {
      // `shown: false`: it was made for a community no longer selected.
      if (!shown) return created;
      snapshot = { ...snapshot, agents: [...snapshot.agents, created] };
      for (const listener of listeners) listener();
      return created;
    }),
    finish: vi.fn(async (_: string) => created),
    portable: vi.fn(discover),
    port: vi.fn(async () => ({ agent: created, notes: [] })),
    portTeam: vi.fn(
      async (): Promise<TeamPort> => ({
        imported: [],
        failed: [],
        elsewhere: [],
        foreign: [],
      }),
    ),
    save: vi.fn(async () => {}),
    previewRetype: vi.fn(
      () =>
        ({
          config: { endpoint: "wss://relay.example" },
          moved: [],
          dropped: ["workspace"],
          settings: [
            {
              id: "model",
              label: "Model",
              outcome: "reset",
            },
            {
              id: "thinking",
              label: "Thinking",
              outcome: "dropped",
            },
          ],
        }) as const,
    ),
    retype: vi.fn(async (pubkey, typeKey, change) => {
      const changed = snapshot.agents.map((saved) =>
        saved.pubkey === pubkey
          ? { ...saved, type: typeKey, config: change?.config ?? {} }
          : saved,
      );
      snapshot = { ...snapshot, agents: changed, running: changed };
      for (const listener of listeners) listener();
      return ["workspace"] as const;
    }),
    remove: vi.fn(async (_pubkey: string): Promise<void> => {}),
    unarchive: vi.fn(async (): Promise<string | undefined> => undefined),
    interruptible: () => false,
    hostedInstructions: () => undefined,
    interrupt: vi.fn(async () => false),
    note: () => false,
    classifier: () => "unavailable",
    saveTeam: vi.fn(async (change: TeamChange) => {
      const team = { ...change, id: change.id ?? "team-1" };
      snapshot = {
        ...snapshot,
        teams: [...snapshot.teams.filter((t) => t.id !== team.id), team],
      };
      for (const listener of listeners) listener();
      return team;
    }),
    // The selected community, where each hosted agent was picked, syncs teams
    // and is every synced team's home.
    teamHere: vi.fn(
      ({ id }: Pick<TeamChange, "id" | "draft">, _community?: string) =>
        !id || !!snapshot.teams.find((team) => team.id === id)?.revision,
    ),
    teamSync: vi.fn(
      (id: string): SyncState =>
        snapshot.teams.find((team) => team.id === id)?.revision
          ? { synced: "wss://relay.example" }
          : { local: undefined },
    ),
    agentSync: vi.fn((): SyncState | undefined => undefined),
    holdTeam: vi.fn((id: string) => {
      held.add(id);
      return () => held.delete(id);
    }),
    core: vi.fn(async () => undefined),
    removeTeam: vi.fn(async (id: string) => {
      snapshot = {
        ...snapshot,
        teams: snapshot.teams.filter((t) => t.id !== id),
      };
      for (const listener of listeners) listener();
    }),
    attentionProviders: () => [],
    presentWatch: () => undefined,
    addAttentionSource: vi.fn(),
    storage: localStore(),
    resumeInterrupted: vi.fn(),
    dismissInterrupted: vi.fn(),
    wake: vi.fn(),
    memberships: vi.fn(
      (_pubkey: string): ReturnType<Agents["memberships"]> => [],
    ),
    forget: vi.fn(),
    joinable: (): readonly Agent[] => [],
    join: vi.fn(),
    leave: vi.fn(),
    creationRequests: () => [],
    dismissCreation: vi.fn(),
    approveCreation: vi.fn(),
    updateRequests: () => [],
    dismissUpdate: vi.fn(),
    approveUpdate: vi.fn(),
    registerHook: vi.fn(),
    dispatchHook: vi.fn(async () => undefined),
    configHistory: () => undefined,
    teamHistory: () => undefined,
    teamUpdateRequests: () => [],
    dismissTeamUpdate: vi.fn(),
    approveTeamUpdate: vi.fn(async () => {}),
    addedTabs: () =>
      linkTab
        ? [
            {
              id: "link",
              key: "link",
              pluginId: "test",
              revision: "1",
              title: "Link",
              component: ({
                canOpen,
              }: {
                canOpen?: ((target: string) => boolean) | undefined;
              }) => (
                <>
                  <p>
                    Agent{" "}
                    {String(canOpen?.(profileTarget("2".repeat(64)) ?? ""))}
                  </p>
                  <p>
                    Person{" "}
                    {String(canOpen?.(profileTarget("9".repeat(64)) ?? ""))}
                  </p>
                </>
              ),
            },
          ]
        : [],
    registerTab: () => {},
    controlAttention: () => {},
    registerSessionRouter: () => {},
    registerExecution: () => {},
    bindExecution: async () => {},
    executionBinding: () => undefined,
    inspectExecution: async () => undefined,
    execution: async () => undefined,
    harness: {} as Agents["harness"],
    subscribeSteps: () => () => {},
  } satisfies Agents;
  const disconnected = { status: "disconnected", generation: 0, scope };
  const relay = {
    snapshot: () => disconnected,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const view = render(<AgentsPage agents={agents} relay={relay} {...page} />);
  const show = (next: Agent[]) => {
    snapshot = { ...snapshot, agents: next };
    for (const listener of listeners) listener();
  };
  const change = (patch: Partial<AgentsSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  /** Tells subscribers something changed, with the same snapshot. */
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    agents,
    echoProvider,
    types,
    show,
    change,
    notify,
    relay,
    held,
    ...view,
  };
}

it("offers a plugin tab's links only to the agents it can open", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1), agent("Bo", 2)], { linkTab: true });
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.click(await screen.findByRole("tab", { name: "Link" }));
  expect(screen.getByText("Agent true")).toBeVisible();
  expect(screen.getByText("Person false")).toBeVisible();
});

it("opens settings for a selected agent beside the grid and follows the arrow keys", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1), agent("Bo", 2)]);
  const grid = screen.getByRole("grid", { name: "Agents" });
  expect(within(grid).getByText("Ada says hi")).toBeInTheDocument();
  expect(screen.queryByText("Peek of Ada")).not.toBeInTheDocument();

  await user.click(within(grid).getByText("Ada"));
  expect(screen.getByRole("gridcell", { name: /Ada/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
  const profilePane = screen.getByRole("region", { name: "Agent profile" });
  expect(screen.getByRole("region", { name: "Agents" })).not.toContainElement(
    profilePane,
  );
  expect(
    within(profilePane).getByRole("tablist", { name: "Panel tabs" }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Reply" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Wakes on")).not.toBeInTheDocument();

  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("heading", { name: "Bo" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: /Bo/ })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tab", { name: "Reply" })).not.toBeInTheDocument();
  expect(grid).toBeInTheDocument();
});

it("opens the side panel with the type's tabs and the app's Settings and Memory tabs", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  expect(screen.getByRole("grid")).toBeInTheDocument();
  const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
  expect(tabs).toEqual([
    "Agents",
    "Your agents",
    "Your teams",
    "Marketplace",
    "AAda",
    "Reply",
    "Memory",
    "Settings",
  ]);
  expect(
    within(
      screen.getByRole("complementary", { name: "Ada identity" }),
    ).queryByText("Type"),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Reply" }));
  expect(screen.getByText("Reply tab")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(screen.getByRole("gridcell", { name: /Ada/ })).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

it("opens memory Buzz links in their community and rejects a retired page's callback", async () => {
  const user = userEvent.setup();
  const viewer = "f".repeat(64),
    channelId = "11111111-1111-4111-8111-111111111111",
    messageId = "e".repeat(64);
  const url = `buzz://message?channel=${channelId}&id=${messageId}`;
  const owner = createRelaySession({
    viewer,
    relayAuthor: "d".repeat(64),
    query: async () => [],
    media: () => undefined,
  });
  const memories = createAgentMemories(
    async () => ({
      entries: [
        { slug: "core", body: url, eventId: "b".repeat(64), createdAt: 1 },
      ],
      partial: false,
    }),
    viewer,
    () => true,
  );
  const signal = new AbortController();
  const target = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  let entryId = "agents";
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = {
    snapshot: () => ({ entry: { id: entryId, target } }),
    open,
  } as unknown as Navigation;
  const navigation = {
    entryId,
    target,
    signal: signal.signal,
    position: () => undefined,
    savePosition() {},
  } as unknown as PageNavigation;
  const page = { navigation, navigator };
  const view = setup([agent("Ada", 1)]);
  const connection = {
    status: "ready",
    generation: 1,
    viewer,
    origin: "https://relay.example",
    scope: `https://relay.example:${viewer}`,
    session: { ...owner.session, agentMemories: memories.capability },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  try {
    view.rerender(<AgentsPage agents={view.agents} relay={relay} {...page} />);
    await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    await user.click(await screen.findByRole("button", { name: "core" }));
    const link = screen.getByRole("link", { name: url });
    await user.click(link);
    expect(open).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: "https://relay.example" },
      channelId,
      messageId,
    });
    entryId = "another-page";
    await user.click(link);
    expect(open).toHaveBeenCalledTimes(1);
    entryId = "agents";
    signal.abort();
    await user.click(link);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("checks providers in Agent setup and opens their host-owned dialogs", async () => {
  const user = userEvent.setup();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const relay = {
    key: "test/relay",
    pluginId: "test",
    revision: "1",
    id: "relay",
    title: "Relay",
    icon: PlugIcon,
    defaults: () => ({ config: {} }),
  } as unknown as RegisteredAgentType;
  const brokenProvider = provider(
    "attention",
    () => {
      throw new Error("Broken controls");
    },
    "Repair Broken",
  );
  brokenProvider.contribution.check = vi.fn(() => {
    throw new Error("Broken check");
  });
  const broken = {
    ...relay,
    key: "test/broken",
    id: "broken",
    title: "Broken",
    provider: brokenProvider.contribution,
  } as unknown as RegisteredAgentType;
  const checkingProvider = provider("checking");
  const checking = {
    ...relay,
    key: "test/checking",
    id: "checking",
    title: "Checking",
    provider: checkingProvider.contribution,
  } as unknown as RegisteredAgentType;
  try {
    const { echoProvider, agents } = setup([agent("Ada", 1)], {
      more: [
        relay,
        broken,
        checking,
        {
          ...relay,
          key: "test/crashed",
          id: "crashed",
          title: "Crashed",
          provider: {
            ...checkingProvider.contribution,
            snapshot: () => {
              throw new Error("Snapshot crashed");
            },
          },
        },
      ],
    });
    expect(
      screen.queryByRole("button", { name: "More agent actions" }),
    ).toBeNull();
    const defaults = render(<AgentSettings agents={agents} active={false} />);
    expect(echoProvider.check).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Harness defaults" }),
    ).toBeNull();
    defaults.rerender(<AgentSettings agents={agents} />);
    expect(screen.getByRole("heading", { name: "Agent setup" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Harness defaults" }),
    ).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Remember mentioned agents" }),
    ).toBeVisible();
    const menu = defaults.container;
    const echo = within(menu).getByRole("button", {
      name: "Echo, ready",
    });
    expect(
      within(menu).queryByRole("button", {
        name: "Relay, unavailable",
      }),
    ).toBeNull();
    expect(
      within(menu).getByRole("button", {
        name: "Repair Broken, attention",
      }),
    ).toBeEnabled();
    expect(
      within(menu).getByRole("button", { name: "Crashed, unavailable" }),
    ).toBeDisabled();
    const checkingRow = within(menu).getByRole("button", {
      name: "Checking, checking",
    });
    expect(checkingRow).toBeDisabled();
    expect(checkingRow).toHaveAttribute("aria-busy", "true");
    expect(
      checkingRow.querySelector(".motion-safe\\:animate-spin"),
    ).toBeVisible();
    expect(checkingProvider.check).toHaveBeenCalled();

    fireEvent.click(echo);
    const dialog = await screen.findByRole("dialog", { name: "Echo" });
    expect(within(dialog).getByText("Echo controls")).toBeVisible();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(
      within(dialog.querySelector("header") as HTMLElement).getAllByRole(
        "button",
      ),
    ).toEqual([close]);
    await user.click(
      within(dialog).getByRole("button", { name: "Save defaults" }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Echo, ready" }));
    const reopenedDialog = await screen.findByRole("dialog", { name: "Echo" });
    act(() => echoProvider.set({ readiness: "attention" }));
    expect(
      within(reopenedDialog).queryByRole("button", { name: "Check again" }),
    ).toBeNull();
    act(() => echoProvider.set({ readiness: "ready", blocking: true }));
    await user.keyboard("{Escape}");
    expect(reopenedDialog).toBeInTheDocument();
    expect(
      within(reopenedDialog).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
    act(() => echoProvider.set({ readiness: "ready" }));
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const attentionAction = vi.fn();
    echoProvider.setAttentionAction(attentionAction);
    act(() =>
      echoProvider.set({
        readiness: "attention",
        attentionLabel: "Log in to Echo",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Log in to Echo, attention" }),
    );
    expect(attentionAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Echo" })).toBeNull();

    const brokenTrigger = screen.getByRole("button", {
      name: "Repair Broken, attention",
    });
    await user.click(brokenTrigger);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider controls are unavailable.",
    );
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(brokenTrigger).toHaveFocus());
  } finally {
    errors.mockRestore();
  }
});

it("restores provider links and retires only that provider's visits after close guards permit it", async () => {
  const user = userEvent.setup();
  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const routed = {
    ...base,
    route: { version: 1, params: { provider: "test/echo" } },
  } as const;
  let current: { id: string; target: OpenTarget } = {
    id: "base",
    target: base,
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const dismiss = vi.fn();
  const navigator = {
    snapshot: () => ({ entry: current }),
    open,
    dismiss,
  } as unknown as Navigation;
  const request = (): PageNavigation => {
    const navigation = {
      entryId: current.id,
      target: current.target,
      signal: new AbortController().signal,
      focus: "content" as const,
      position: () => undefined,
      savePosition() {},
      forSession: () => navigation,
      passThrough: () => () => {},
      resolve: () => true,
      complete: () => true,
    };
    return navigation;
  };
  const pageView = (agents: Agents, relay: RelayData) => (
    <AgentsPage
      agents={agents}
      relay={relay}
      navigator={navigator}
      navigation={request()}
    />
  );
  const page = { navigator, navigation: request() };
  const view = setup([agent("Ada", 1)], { page });

  current = { id: "provider", target: routed };
  view.unmount();
  const restored = render(pageView(view.agents, view.relay));
  expect(await screen.findByRole("dialog", { name: "Echo" })).toBeVisible();

  current = { id: "base", target: base };
  restored.rerender(pageView(view.agents, view.relay));
  expect(screen.queryByRole("dialog", { name: "Echo" })).toBeNull();

  current = { id: "provider", target: routed };
  restored.rerender(pageView(view.agents, view.relay));
  act(() => view.echoProvider.set({ readiness: "ready", blocking: true }));
  await user.keyboard("{Escape}");
  expect(dismiss).not.toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: "Close" })).toBeDisabled();
  act(() => view.echoProvider.set({ readiness: "ready" }));
  await user.click(await screen.findByRole("button", { name: "Close" }));
  expect(dismiss).toHaveBeenCalledOnce();
  const [matches, fallback] = dismiss.mock.calls[0] as unknown as [
    (target: OpenTarget) => boolean,
    OpenTarget,
  ];
  expect(fallback).toEqual(base);
  expect(matches(routed)).toBe(true);
  expect(matches(base)).toBe(false);
  expect(
    matches({
      ...routed,
      route: { version: 1, params: { provider: "test/other" } },
    }),
  ).toBe(false);
  const { scope: _scope, ...unscoped } = routed;
  expect(matches(unscoped)).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it("lets the Back shortcut hide a routed provider's blocking work and Forward restore it", async () => {
  const page = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const controller = createNavigationController(createMemoryHistory(page));
  const navigator = controller.navigation;
  const remove = registerNavigationShortcuts(
    new ShortcutsService(ctx, window),
    navigator,
  );
  /** The Agents page as the host presents each visit to it. */
  function Host({ agents, relay }: { agents: Agents; relay: RelayData }) {
    const { entry, attempt } = useSyncExternalStore(
      navigator.subscribe,
      navigator.snapshot,
    );
    const navigation = useMemo(() => {
      const request: PageNavigation = {
        entryId: entry.id,
        target: entry.target,
        signal: attempt.signal,
        position: () => undefined,
        savePosition() {},
        passThrough: () => () => {},
        forSession: () => request,
        resolve: () => true,
        complete: () => true,
      };
      return request;
    }, [entry, attempt]);
    return (
      <AgentsPage
        agents={agents}
        relay={relay}
        navigator={navigator}
        navigation={navigation}
      />
    );
  }
  try {
    const view = setup([agent("Ada", 1)]);
    view.rerender(<Host agents={view.agents} relay={view.relay} />);
    void navigator.open({
      ...page,
      route: { version: 1, params: { provider: "test/echo" } },
    });
    const dialog = await screen.findByRole("dialog", { name: "Echo" });
    act(() => view.echoProvider.set({ readiness: "ready", blocking: true }));
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
    expect(dialog).toHaveAttribute("data-navigation-visit");
    expect(fireEvent.keyDown(dialog, { key: "[", ctrlKey: true })).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Echo" })).toBeNull(),
    );
    expect(navigator.snapshot().entry.target).toEqual(page);
    expect(screen.getByRole("grid", { name: "Agents" })).toBeVisible();
    // Hiding is not a Close, which would retire the visit Forward returns to.
    expect(fireEvent.keyDown(document.body, { key: "]", ctrlKey: true })).toBe(
      false,
    );
    const restored = await screen.findByRole("dialog", { name: "Echo" });
    expect(restored).toHaveAttribute("data-navigation-visit");
    expect(
      within(restored).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
  } finally {
    remove();
    controller.dispose();
    await ctx.fiber.dispose();
  }
});

it("opens the agent a link names, on Your agents", async () => {
  const target = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
    route: { version: 1, params: { agent: "2".repeat(64) } },
  } as const;
  const navigator = {
    snapshot: () => ({ entry: { id: "agent", target } }),
    open: vi.fn(async () => ({ status: "opened" as const })),
  } as unknown as Navigation;
  const navigation: PageNavigation = {
    entryId: "agent",
    target,
    signal: new AbortController().signal,
    focus: "content",
    position: () => undefined,
    savePosition() {},
    forSession: () => navigation,
    resolve: () => true,
    complete: () => true,
    passThrough: () => () => {},
  };
  setup([agent("Ada", 1), agent("Bea", 2)], {
    page: { navigator, navigation },
  });
  const profile = await screen.findByRole("region", { name: "Agent profile" });
  expect(within(profile).getAllByText("Bea").length).toBeGreaterThan(0);
  expect(within(profile).queryByText("Ada")).toBeNull();
});

it("shows an agent's picture in the grid and side panel", async () => {
  const user = userEvent.setup();
  const picture = "https://old.example/media/a.png";
  setup([{ ...agent("Ada", 1), picture }]);
  const pictures = () =>
    document.querySelectorAll(`img[src="${picture}"]`).length;
  expect(pictures()).toBe(1);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  expect(pictures()).toBe(3);
  await user.keyboard("{Enter}");
  expect(screen.getByRole("grid")).toBeInTheDocument();
  expect(pictures()).toBe(3);
});

it("keeps name edits inline and lets a failed save retry", async () => {
  const user = userEvent.setup();
  const picture = "https://old.example/media/a.png";
  const { agents } = setup([{ ...agent("Ada", 1), picture }]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  agents.save.mockRejectedValueOnce(new Error("Could not save"));
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change name" }),
  );
  const field = screen.getByRole("textbox", { name: "Agent name" });
  expect(field).toHaveAttribute("data-appearance", "heading");
  await waitFor(() => expect(field).toHaveFocus());
  expect((field as HTMLInputElement).selectionStart).toBe(3);
  expect((field as HTMLInputElement).selectionEnd).toBe(3);
  await user.clear(field);
  await user.type(field, "Updated");
  expect(agents.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(agents.save).toHaveBeenCalledWith("1".repeat(64), {
    name: "Updated",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
  // An empty name replaces the failed save's error with the name prompt.
  Element.prototype.animate = vi.fn();
  try {
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add a name to save your agent",
    );
  } finally {
    Reflect.deleteProperty(Element.prototype, "animate");
  }
  await user.type(field, "Updated");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(field).not.toHaveAttribute("aria-invalid");
  expect(agents.save).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Agent name" }),
    ).not.toBeInTheDocument(),
  );
});

it("saves a reviewed provider change with the destination settings", async () => {
  const user = userEvent.setup();
  const RelaySettings = ({
    agent,
    save,
    settingsHost,
  }: AgentViewProps<{ endpoint: string }>) => {
    const [endpoint, setEndpoint] = useState(agent.config.endpoint);
    const [error, setError] = useState("");
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void save({ endpoint }).catch((reason: unknown) =>
            setError(String(reason instanceof Error ? reason.message : reason)),
          );
        }}
      >
        {settingsHost?.typeControl?.(false)}
        <label>
          Endpoint
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit">Save</button>
      </form>
    );
  };
  const relay = {
    key: "test/relay",
    pluginId: "test",
    revision: "1",
    id: "relay",
    title: "Relay",
    icon: PlugIcon,
    defaults: () => ({ config: { endpoint: "wss://relay.example" } }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: RelaySettings,
      },
    ],
  } as unknown as RegisteredAgentType;
  const { agents } = setup([agent("Ada", 1)], {
    more: [relay],
    dirtySettings: true,
  });
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  const rail = screen.getByRole("complementary", { name: "Ada identity" });
  expect(
    within(rail).queryByRole("button", { name: "Change harness from Echo" }),
  ).not.toBeInTheDocument();
  agents.retype.mockRejectedValueOnce(new Error("Ada is answering"));
  const typeTrigger = screen.getByRole("button", {
    name: "Change harness from Echo",
  });
  expect(typeTrigger.querySelectorAll("svg")).toHaveLength(2);
  await user.click(typeTrigger);
  const providerMenu = await screen.findByRole("menu");
  const currentChoice = within(providerMenu).getByRole("menuitemradio", {
    name: "Echo",
  });
  const relayChoice = within(providerMenu).getByRole("menuitemradio", {
    name: "Relay",
  });
  expect(currentChoice).toBeChecked();
  expect(relayChoice).not.toBeChecked();
  expect(relayChoice.querySelector("svg")).toBeInTheDocument();
  await user.click(relayChoice);
  const dialog = await screen.findByRole("dialog", {
    name: "Move Ada to Relay?",
  });
  expect(
    screen.queryByRole("dialog", { name: "Change provider" }),
  ).not.toBeInTheDocument();
  expect(agents.retype).not.toHaveBeenCalled();
  expect(within(dialog).queryByText("Instructions")).toBeNull();
  expect(within(dialog).getByText("Workspace").parentElement).toHaveTextContent(
    "WorkspaceDropped",
  );
  expect(within(dialog).getByText("Model").parentElement).toHaveTextContent(
    "ModelResets",
  );
  expect(within(dialog).getByText("Thinking").parentElement).toHaveTextContent(
    "ThinkingDropped",
  );
  expect(dialog).toHaveTextContent(
    "Your agent will continue the conversation in Buzz.",
  );
  expect(dialog).toHaveTextContent("Anything Echo left running will stop.");
  expect(dialog).toHaveTextContent(
    "Unsaved Settings changes will be discarded when you continue.",
  );
  expect(dialog).toHaveTextContent(
    "The provider changes when you save settings.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(agents.retype).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Change harness from Relay" }),
  ).toBeVisible();
  expect(screen.queryByText("Provider settings")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Reply" }),
  ).not.toBeInTheDocument();
  const endpoint = screen.getByRole("textbox", { name: "Endpoint" });
  expect(endpoint).toHaveValue("wss://relay.example");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeEnabled();
  await user.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Ada is answering",
  );
  expect(agents.retype).toHaveBeenCalledOnce();
  expect(agents.retype).toHaveBeenLastCalledWith("1".repeat(64), "test/relay", {
    config: { endpoint: "wss://relay.example" },
  });
  await user.clear(endpoint);
  await user.type(endpoint, "wss://custom.example");
  await user.click(save);
  expect(agents.retype).toHaveBeenLastCalledWith("1".repeat(64), "test/relay", {
    config: { endpoint: "wss://custom.example" },
  });
  expect(
    screen.getByRole("button", { name: "Change harness from Relay" }),
  ).toBeVisible();
});

it("makes a new agent in the create dialog and goes straight to building it", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new agent" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  expect(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  ).toHaveTextContent("Echo");
  await user.type(within(dialog).getByLabelText("Reply"), "Hi there");
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(agents.create).toHaveBeenCalledWith({
    type: "test/echo",
    name: "Nova",
    picture: expect.stringMatching(/^https:\/\//),
    config: { reply: "Hi there" },
  });
  expect(await screen.findByRole("tab", { name: "Settings" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Nova" })).toBeInTheDocument();
});

it("stays on the grid when the new agent belongs to a community no longer shown", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { shown: false });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new agent" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalled());
  expect(
    await screen.findByRole("grid", { name: "Agents" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "New agent" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Attention" })).toBeNull();
});

it("cancels inline name edits and flags an empty name on Save", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  const edit = async () => {
    await user.click(
      screen.getByRole("button", { name: "Agent profile actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Change name" }),
    );
  };
  await edit();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Message" }),
  ).not.toBeInTheDocument();
  const field = screen.getByRole("textbox", { name: "Agent name" });
  await user.clear(field);
  // jsdom lacks the Web Animations API the shake uses.
  const animate = vi.fn();
  Element.prototype.animate = animate;
  try {
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add a name to save your agent",
    );
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Add a name to save your agent");
    expect(animate).toHaveBeenCalledOnce();
    await user.keyboard("{Enter}");
    expect(animate).toHaveBeenCalledTimes(2);
    expect(agents.save).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(Element.prototype, "animate");
  }
  // Cancelling while flagged starts the next edit clean.
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await edit();
  const reopened = screen.getByRole("textbox", { name: "Agent name" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(reopened).not.toHaveAttribute("aria-invalid");
  await user.clear(reopened);
  await user.type(reopened, "Discarded");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(agents.save).not.toHaveBeenCalled();
  await edit();
  expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue(
    "Ada",
  );
});

it("imports an earlier agent as the chosen type and shows it in Your agents", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const list = await screen.findByRole("region", { name: "Agents to import" });
  // Names are unique here, so each card shows only where it comes from.
  expect(within(list).getAllByText("Buzz (Legacy)")).toHaveLength(2);
  expect(within(list).queryByText(/npub/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Import as Echo, Bea" }));
  expect(agents.port).toHaveBeenCalledWith({
    source: "installed",
    pubkey: "b".repeat(64),
    type: "test/echo",
  });
  // The dialog stays open so another can be imported; closing it is the owner's.
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(
    await within(dialog).findByRole("button", { name: "Bea imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    within(dialog).getByRole("button", { name: "Import as Echo, Ada" }),
  ).toBeEnabled();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.getByRole("tab", { name: "Your agents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("imports an agent from another community as the same agent, keeping its key", async () => {
  const user = userEvent.setup();
  const { agents, show } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  agents.joinable = () => [bea];
  agents.join.mockImplementation(async () => {
    const added = { ...bea, relay: "wss://relay.example" };
    show([agent("Ada", 1), added]);
    return { agent: added, notes: [] };
  });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const list = await screen.findByRole("region", { name: "Agents to import" });
  // It keeps its type, so it offers no choice of one.
  expect(
    within(list).queryByRole("button", { name: /Choose a type for Bea/ }),
  ).not.toBeInTheDocument();
  await user.click(
    within(list).getByRole("button", {
      name: "Import, Bea from other.example",
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Import Bea",
  });
  expect(agents.join).not.toHaveBeenCalled();
  expect(confirmation).not.toHaveAccessibleDescription();
  expect(within(confirmation).getByText("One setup, everywhere")).toBeVisible();
  expect(
    within(confirmation).getByText("Memories stay in each community"),
  ).toBeVisible();
  await user.click(
    within(confirmation).getByRole("button", { name: "Import" }),
  );
  expect(agents.join).toHaveBeenCalledWith(bea.key);
  expect(
    await within(list).findByRole("button", { name: "Bea imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(
    within(screen.getByRole("grid", { name: "Agents" })).getByText("Bea"),
  ).toBeInTheDocument();
});

it("cancels cross-community consent and discards it when the destination changes", async () => {
  const user = userEvent.setup();
  const { agents, relay, rerender } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  agents.joinable = () => [bea];
  let connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    scope: "https://destination.example:owner",
    viewer: "owner",
  };
  relay.snapshot = () => connection;
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const trigger = await screen.findByRole("button", {
    name: "Import, Bea from other.example",
  });
  const open = async () => {
    await user.click(trigger);
    return screen.findByRole("dialog", {
      name: "Import Bea",
    });
  };
  let dialog = await open();
  expect(dialog).not.toHaveAccessibleDescription();
  const reminder = () =>
    within(dialog).getByRole("checkbox", { name: "Don’t remind me again" });
  expect(reminder()).not.toBeChecked();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Import" }),
    ).toHaveFocus(),
  );
  await user.click(reminder());
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  dialog = await open();
  expect(reminder()).not.toBeChecked();
  await user.click(reminder());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  dialog = await open();
  expect(reminder()).not.toBeChecked();
  await user.click(reminder());
  connection = {
    ...connection,
    origin: "https://different.example",
    scope: "https://different.example:owner",
  };
  rerender(<AgentsPage agents={agents} relay={relay} />);
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(agents.join).not.toHaveBeenCalled();
});

it("remembers the import reminder on confirmation across communities, only for this account", async () => {
  const user = userEvent.setup();
  const { agents, relay, rerender } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  const cy = { ...agent("Cy", 3), relay: "wss://other.example" };
  agents.joinable = () => [bea, cy];
  let connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    scope: "https://destination.example:owner",
    viewer: "owner",
  };
  relay.snapshot = () => connection;
  agents.join.mockResolvedValue({ agent: bea, notes: [] });
  const open = async () => {
    await user.click(screen.getByRole("button", { name: "New agent" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Import an agent" }),
    );
    return screen.findByRole("button", {
      name: "Import, Bea from other.example",
    });
  };
  await user.click(await open());
  const dialog = await screen.findByRole("dialog", { name: "Import Bea" });
  await user.click(
    within(dialog).getByRole("checkbox", { name: "Don’t remind me again" }),
  );
  expect(agents.join).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  expect(
    await screen.findByRole("button", { name: "Bea imported" }),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Import, Cy from other.example" }),
  );
  expect(
    await screen.findByRole("button", { name: "Cy imported" }),
  ).toBeVisible();
  expect(agents.join).toHaveBeenLastCalledWith(cy.key);
  expect(
    screen.queryByRole("dialog", { name: "Import Cy" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  // Reopening in another community retains the account's local preference.
  connection = {
    ...connection,
    origin: "https://different.example",
    scope: "https://different.example:owner",
  };
  rerender(<AgentsPage agents={agents} relay={relay} />);
  await user.click(await open());
  expect(
    await screen.findByRole("button", { name: "Bea imported" }),
  ).toBeVisible();
  expect(agents.join).toHaveBeenCalledTimes(3);
  await user.click(screen.getByRole("button", { name: "Close" }));
  connection = {
    ...connection,
    viewer: "another-owner",
    scope: "https://different.example:another-owner",
  };
  rerender(<AgentsPage agents={agents} relay={relay} />);
  await user.click(await open());
  expect(
    await screen.findByRole("dialog", { name: "Import Bea" }),
  ).toBeVisible();
  expect(agents.join).toHaveBeenCalledTimes(3);
});

it("still explains imports with corrupt or unavailable reminder storage", async () => {
  const user = userEvent.setup();
  const { agents, relay } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  agents.joinable = () => [bea];
  agents.join.mockResolvedValue({ agent: bea, notes: [] });
  const connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    scope: "https://destination.example:owner",
    viewer: "owner",
  };
  relay.snapshot = () => connection;
  writeView("owner", "agent-community-import:dismissed", "true");
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Import, Bea from other.example",
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Import Bea" });
  await user.click(
    within(dialog).getByRole("checkbox", { name: "Don’t remind me again" }),
  );
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(
      await screen.findByRole("button", { name: "Bea imported" }),
    ).toBeVisible();
    expect(agents.join).toHaveBeenCalledWith(bea.key);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "New agent" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Import an agent" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Import, Bea from other.example",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Import Bea" }),
    ).toBeVisible();
    expect(agents.join).toHaveBeenCalledOnce();
  } finally {
    save.mockRestore();
  }
});

it("keeps a cross-community import error on its card and confirms a retry", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  agents.joinable = () => [bea];
  agents.join.mockRejectedValueOnce(
    new Error("Community could not be reached"),
  );
  agents.join.mockResolvedValue({ agent: bea, notes: [] });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const confirm = async () => {
    await user.click(
      await screen.findByRole("button", {
        name: "Import, Bea from other.example",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Import Bea",
    });
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
  };
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Bea wasn't imported. Community could not be reached.",
  );
  await confirm();
  expect(
    await screen.findByRole("button", { name: "Bea imported" }),
  ).toBeInTheDocument();
  expect(agents.join).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("shows the matching community images and follows their presentation updates", async () => {
  const user = userEvent.setup();
  let state = {
    memberships: [
      {
        id: "https://other.example",
        name: "Block",
        icon: "https://images.example/bee.png",
      },
      {
        id: "https://destination.example",
        name: "Feedback",
        icon: "https://images.example/pollen.png",
      },
    ],
  };
  const listeners = new Set<() => void>();
  const communities = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as CommunityReader;
  const { agents, relay } = setup([agent("Ada", 1)], {
    found: [],
    page: { communities },
  });
  const connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    scope: "https://destination.example:owner",
  };
  relay.snapshot = () => connection;
  agents.joinable = () => [
    { ...agent("Bea", 2), relay: "wss://other.example" },
  ];
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Import, Bea from other.example",
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Import Bea",
  });
  const from = within(dialog).getByRole("figure", { name: "From Block" });
  const to = within(dialog).getByRole("figure", { name: "To Feedback" });
  expect(from.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/bee.png",
  );
  expect(to.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/pollen.png",
  );
  expect(from).toHaveTextContent("other.example");
  expect(to).toHaveTextContent("destination.example");
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Import" }),
    ).toHaveFocus(),
  );
  await user.hover(from);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "From: Block · other.example",
  );
  await user.unhover(from);
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  // Return through Cancel and Close to the destination illustration using the keyboard.
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  expect(to).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "To: Feedback · destination.example",
  );
  await act(async () => {
    state = {
      memberships: state.memberships.map((item) =>
        item.name === "Feedback"
          ? { ...item, icon: "javascript:alert(1)" }
          : item,
      ),
    };
    for (const listener of listeners) listener();
  });
  // An unavailable or unsafe image keeps its named community, never another logo.
  expect(to.querySelector("img")).toBeNull();
  expect(to).toHaveTextContent("Feedback");
  expect(from.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/bee.png",
  );
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(listeners.size).toBe(0));
  expect(agents.join).not.toHaveBeenCalled();
});

it("imports an exported agent file as a new agent of the type that runs it", async () => {
  const user = userEvent.setup();
  const scout = {
    key: "test/scout",
    title: "Scout",
    defaults: () => ({ config: { model: "" } }),
    importShared: (source: { runtime?: string; model: string }) =>
      source.runtime === "scout" ? { model: source.model } : undefined,
  } as unknown as RegisteredAgentType;
  const { agents } = setup([agent("Ada", 1)], { more: [scout] });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  const file = (text: string) =>
    new File([text], "Scout.agent.json", { type: "application/json" });
  await user.upload(within(dialog).getByLabelText("Choose file"), file("{"));
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Failed to read agent snapshot file. Invalid snapshot JSON.",
  );
  await user.upload(
    within(dialog).getByLabelText("Choose file"),
    file(
      JSON.stringify({
        format: "buzz-agent-snapshot",
        version: 1,
        definition: {
          name: "Scout",
          systemPrompt: "Scout ahead.",
          runtime: "scout",
          model: "scout-1",
        },
        profile: { displayName: "Scout" },
        memory: { level: "none", entries: [] },
      }),
    ),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Scout",
  });
  // What the new agent will follow is shown before it is accepted.
  expect(
    within(confirmation).getByRole("textbox", { name: "Instructions" }),
  ).toHaveValue("Scout ahead.");
  await user.click(
    within(confirmation).getByRole("button", { name: "Import" }),
  );
  expect(agents.port).toHaveBeenCalledWith({
    source: "shared",
    type: "test/scout",
    name: "Scout",
    instructions: "Scout ahead.",
    config: { model: "scout-1" },
  });
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Import Scout" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("dialog", { name: "Import an agent" }),
  ).toBeInTheDocument();
});

it("queues several imports in a row and keeps the dialog open until they finish", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  let finish = () => {};
  agents.port.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ agent: agent("Ada", 1), notes: [] });
      }),
  );
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  await user.click(
    await within(dialog).findByRole("button", { name: "Import as Echo, Ada" }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  );
  // Bea waits for Ada; neither can be chosen twice, and the dialog stays open.
  expect(agents.port).toHaveBeenCalledTimes(1);
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  );
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Import an agent" })).toBeVisible();
  finish();
  expect(
    await within(dialog).findByRole("button", { name: "Bea imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    within(dialog).getByRole("button", { name: "Ada imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(agents.port).toHaveBeenCalledTimes(2);
  expect(agents.port).toHaveBeenLastCalledWith({
    source: "installed",
    pubkey: "b".repeat(64),
    type: "test/echo",
  });
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(
    screen.queryByRole("dialog", { name: "Import an agent" }),
  ).not.toBeInTheDocument();
});

it("keeps keyboard focus on an import when it finishes", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  let finish = () => {};
  agents.port.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ agent: agent("Ada", 1), notes: [] });
      }),
  );
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  const ada = await within(dialog).findByRole("button", {
    name: "Import as Echo, Ada",
  });
  ada.focus();
  await user.keyboard("{Enter}");
  finish();
  const done = await within(dialog).findByRole("button", {
    name: "Ada imported",
  });
  expect(done).toHaveFocus();
  // The next import is one Tab away.
  await user.tab();
  expect(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  ).toHaveFocus();
});

it("drops imports still waiting their turn when the page goes away", async () => {
  const user = userEvent.setup();
  const view = setup([]);
  let finish = () => {};
  view.agents.port.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ agent: agent("Ada", 1), notes: [] });
      }),
  );
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  await user.click(
    await within(dialog).findByRole("button", { name: "Import as Echo, Ada" }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  );
  view.unmount();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Bea would otherwise land in whatever community was selected by then.
  expect(view.agents.port).toHaveBeenCalledTimes(1);
});

it("keeps importing the rest after one fails, and clears the failure on a retry", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.port.mockRejectedValueOnce(new Error("Keychain access was denied"));
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  await user.click(
    await within(dialog).findByRole("button", { name: "Import as Echo, Ada" }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  );
  expect(
    await within(dialog).findByRole("button", { name: "Bea imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Ada wasn't imported. Keychain access was denied.",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Ada" }),
  );
  expect(
    await within(dialog).findByRole("button", { name: "Ada imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(
    screen.queryByRole("dialog", { name: "Import an agent" }),
  ).not.toBeInTheDocument();
});

it("tells same-named agents to import apart by their keys", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: [
      ...portable,
      { source: "development", pubkey: "c".repeat(64), name: "Bea", relay: "" },
    ],
    teams: [],
    warnings: [],
    here: [],
  });
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const list = await screen.findByRole("region", { name: "Agents to import" });
  expect(within(list).getByText("Buzz (Legacy)")).toBeInTheDocument();
  expect(within(list).getAllByText(/^Buzz \(Legacy\) · npub…/)).toHaveLength(2);
});

it("imports agents only as a type that runs here", async () => {
  const user = userEvent.setup();
  const { agents, types } = setup([]);
  types.push({
    ...types[0],
    key: "test/cloud",
    title: "Cloud",
    remote: {},
  } as unknown as RegisteredAgentType);
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const importAda = await screen.findByRole("button", {
    name: "Import as Echo, Ada",
  });
  await user.click(
    screen.getByRole("button", { name: "Choose a type for Ada" }),
  );
  expect(
    await screen.findByRole("menuitemradio", { name: "Echo" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitemradio", { name: "Cloud" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(importAda);
  expect(agents.port).toHaveBeenCalledWith(
    expect.objectContaining({ type: "test/echo" }),
  );
});

it("shows why importing an agent failed and keeps it listed", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.port.mockRejectedValueOnce(new Error("Keychain access was denied"));
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Import as Echo, Ada" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Ada wasn't imported. Keychain access was denied.",
  );
  expect(
    screen.getByRole("button", { name: "Import as Echo, Ada" }),
  ).toBeEnabled();
});

const nightShift: OldTeam = {
  id: "old-night-shift",
  name: "Night Shift",
  instructions: "Ship small.",
  members: [
    { pubkey: "b".repeat(64), name: "Bea", source: "installed" },
    { pubkey: "c".repeat(64), name: "Cy", source: "installed" },
  ],
};
const onImport = () =>
  expect(
    screen.getByRole("dialog", { name: "Import a team" }),
  ).toBeInTheDocument();
async function openImport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import a team" }),
  );
}

it("explains shared team members before importing and shares the account reminder preference", async () => {
  const user = userEvent.setup();
  const { agents, relay, rerender } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  const cy = { ...agent("Cy", 3), relay: "wss://third.example" };
  agents.joinable = () => [bea, cy];
  agents.join.mockResolvedValue({ agent: bea, notes: [] });
  let connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    viewer: "owner",
    scope: "destination:owner",
  };
  relay.snapshot = () => connection;
  await act(async () => {
    await agents.saveTeam({
      name: "Night Shift",
      instructions: "Help.",
      members: [bea.pubkey, cy.pubkey],
    });
  });
  const open = async () => {
    await user.click(screen.getByRole("tab", { name: "Your teams" }));
    await user.click(screen.getByRole("button", { name: "New team" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Import a team" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Import team Night Shift" }),
    );
    return screen.findByRole("dialog", { name: "Import Night Shift" });
  };
  let confirmation = await open();
  expect(agents.join).not.toHaveBeenCalled();
  expect(within(confirmation).getByText("One setup, everywhere")).toBeVisible();
  expect(
    within(confirmation).getByRole("figure", { name: "From other.example" }),
  ).toBeVisible();
  expect(
    within(confirmation).getByRole("figure", { name: "From third.example" }),
  ).toBeVisible();
  await user.click(
    within(confirmation).getByRole("checkbox", {
      name: "Don’t remind me again",
    }),
  );
  await user.click(
    within(confirmation).getByRole("button", { name: "Cancel" }),
  );
  expect(agents.join).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Import team Night Shift" }),
    ).toHaveFocus(),
  );
  await user.click(
    screen.getByRole("button", { name: "Import team Night Shift" }),
  );
  confirmation = await screen.findByRole("dialog", {
    name: "Import Night Shift",
  });
  expect(
    within(confirmation).getByRole("checkbox", {
      name: "Don’t remind me again",
    }),
  ).not.toBeChecked();
  await user.click(
    within(confirmation).getByRole("checkbox", {
      name: "Don’t remind me again",
    }),
  );
  await user.click(
    within(confirmation).getByRole("button", { name: "Import" }),
  );
  await waitFor(() => expect(agents.join).toHaveBeenCalledTimes(2));
  expect(agents.join).toHaveBeenNthCalledWith(1, bea.key);
  expect(agents.join).toHaveBeenNthCalledWith(2, cy.key);
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Import, Bea from other.example",
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Bea imported" }),
  ).toBeVisible();
  expect(agents.join).toHaveBeenCalledTimes(3);
  expect(
    screen.queryByRole("dialog", { name: "Import Bea" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  writeView("owner", "agent-community-import:dismissed", false);
  confirmation = await open();
  connection = {
    ...connection,
    scope: "different:owner",
    origin: "https://different.example",
  };
  rerender(<AgentsPage agents={agents} relay={relay} />);
  await waitFor(() => expect(confirmation).not.toBeInTheDocument());
  expect(agents.join).toHaveBeenCalledTimes(3);
});

it("stops queued team joins when the destination changes", async () => {
  const user = userEvent.setup();
  const { agents, relay, rerender } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  const cy = { ...agent("Cy", 3), relay: "wss://other.example" };
  agents.joinable = () => [bea, cy];
  let finish!: (result: { agent: Agent; notes: readonly string[] }) => void;
  const pending = new Promise<{ agent: Agent; notes: readonly string[] }>(
    (resolve) => {
      finish = resolve;
    },
  );
  agents.join.mockImplementation(() => pending);
  let connection = {
    ...relay.snapshot(),
    scope: "first:owner",
    viewer: "owner",
  };
  relay.snapshot = () => connection;
  await act(async () => {
    await agents.saveTeam({
      name: "Night Shift",
      instructions: "Help.",
      members: [bea.pubkey, cy.pubkey],
    });
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import a team" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Import team Night Shift" }),
  );
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Import Night Shift" }),
    ).getByRole("button", { name: "Import" }),
  );
  expect(agents.join).toHaveBeenCalledTimes(1);
  const originalList = screen.getByRole("region", { name: "Teams to import" });
  try {
    connection = { ...connection, scope: "second:owner" };
    rerender(<AgentsPage agents={agents} relay={relay} />);
    expect(originalList).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      finish({ agent: bea, notes: [] });
      await pending;
    });
  }
  expect(agents.join).toHaveBeenCalledTimes(1);
  expect(agents.join).toHaveBeenCalledWith(bea.key);
});

it.each(["agents", "teams"])(
  "warns about duplicate runtimes before Legacy %s imports",
  async (kind) => {
    const user = userEvent.setup();
    const { agents } = setup([agent("Ada", 1)]);
    agents.portable.mockResolvedValue({
      agents: portable,
      teams: [nightShift],
      warnings: [],
      here: [],
    });
    if (kind === "teams")
      await user.click(screen.getByRole("tab", { name: "Your teams" }));
    await user.click(
      screen.getByRole("button", {
        name: kind === "teams" ? "New team" : "New agent",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", {
        name: kind === "teams" ? "Import a team" : "Import an agent",
      }),
    );
    const warning = await screen.findByText(
      /Stop the old runtime before importing, or both may answer/,
    );
    expect(warning).toHaveTextContent(
      "Instructions and workspace come over only if the chosen type supports them",
    );
    expect(warning).toHaveTextContent("provider, model and other settings");
    expect(agents.port).not.toHaveBeenCalled();
    expect(agents.portTeam).not.toHaveBeenCalled();
  },
);

it("offers New team on Your teams with create and import, but no marketplace", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  agents.portable.mockResolvedValue({
    agents: [],
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(
    screen.queryByRole("button", { name: "New agent" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New team" }));
  expect(
    await screen.findByRole("menuitem", { name: "Import a team" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Browse the marketplace" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "Create a new team" }));
  expect(screen.getByRole("form", { name: "New team" })).toBeInTheDocument();
});

it("hides Import a team when there is nothing to import, and keeps Import an agent for files", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { found: [] });
  await act(async () => {
    await agents.portable.mock.results[0]?.value;
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  expect(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Import a team" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(within(dialog).getByLabelText("Choose file")).toBeInTheDocument();
});

it("offers a first agent from a file when discovery finds nothing", async () => {
  const user = userEvent.setup();
  const { agents } = setup([], { found: [] });
  await act(async () => {
    await agents.portable.mock.results[0]?.value;
  });
  expect(
    screen.queryByRole("button", { name: /Check for agents to import/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Import from a file" }));
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(within(dialog).getByLabelText("Choose file")).toBeInTheDocument();
});

it.each([
  [
    "Your agents",
    "New agent",
    "Import an agent",
    "No agents found in the sources we could read.",
  ],
  [
    "Your teams",
    "New team",
    "Import a team",
    "No teams found in the sources we could read.",
  ],
])(
  "keeps %s import diagnostics reachable after incomplete discovery",
  async (tab, menu, entry, partialResult) => {
    const user = userEvent.setup();
    const warning = "Couldn't read Buzz (Legacy) agents.";
    const { agents } = setup([agent("Ada", 1)], {
      found: [],
      warnings: [warning],
    });
    await act(async () => {
      await agents.portable.mock.results[0]?.value;
    });
    await user.click(screen.getByRole("tab", { name: tab }));
    await user.click(screen.getByRole("button", { name: menu }));
    await user.click(await screen.findByRole("menuitem", { name: entry }));
    const dialog = screen.getByRole("dialog", { name: entry });
    expect(await within(dialog).findByText(warning)).toBeVisible();
    expect(within(dialog).getByText(partialResult)).toBeVisible();
    expect(agents.port).not.toHaveBeenCalled();
    expect(agents.portTeam).not.toHaveBeenCalled();
  },
);

it("keeps first-run actions stable from pending to empty discovery", async () => {
  let finish!: (found: FoundAgents) => void;
  const discovery = new Promise<FoundAgents>((resolve) => {
    finish = resolve;
  });
  const { agents } = setup([], { discover: () => discovery });
  expect(agents.portable).toHaveBeenCalledTimes(1);
  const create = screen.getByRole("button", {
    name: "Create your first agent",
  });
  const marketplace = screen.getByRole("button", {
    name: "Explore the marketplace",
  });
  const expectPrimaryActions = () => {
    expect(
      screen.queryByRole("button", {
        name: /Check for agents to import|Import them now/,
      }),
    ).not.toBeInTheDocument();
    expect(create).toBeEnabled();
    expect(marketplace).toBeEnabled();
    expect(
      within(create).getByText("Create your first agent"),
    ).not.toHaveAttribute("data-tone", "secondary");
    expect(
      within(marketplace).getByText("Explore the marketplace"),
    ).not.toHaveAttribute("data-tone", "secondary");
  };
  create.focus();
  try {
    expectPrimaryActions();
  } finally {
    await act(async () =>
      finish({ agents: [], teams: [], warnings: [], here: [] }),
    );
  }
  expectPrimaryActions();
  expect(screen.getByRole("button", { name: "Create your first agent" })).toBe(
    create,
  );
  expect(screen.getByRole("button", { name: "Explore the marketplace" })).toBe(
    marketplace,
  );
  expect(create).toHaveFocus();
});

it("offers first-run import diagnostics after discovery fails", async () => {
  const user = userEvent.setup();
  let fail!: (reason: Error) => void;
  const discovery = new Promise<FoundAgents>((_resolve, reject) => {
    fail = reject;
  });
  const { agents } = setup([], { discover: () => discovery });
  expect(agents.portable).toHaveBeenCalledTimes(1);
  try {
    expect(
      screen.queryByRole("button", { name: /Check for agents to import/ }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => fail(new Error("Discovery unavailable")));
  }
  await user.click(
    screen.getByRole("button", { name: /Check for agents to import/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Discovery unavailable",
  );
  expect(agents.port).not.toHaveBeenCalled();
});

it("offers import diagnostics to a first-time owner after warning-only discovery", async () => {
  const user = userEvent.setup();
  const warning = "Couldn't read Buzz (Legacy) agents.";
  const { agents } = setup([], { found: [], warnings: [warning] });
  await act(async () => {
    await agents.portable.mock.results[0]?.value;
  });
  const entry = screen.getByRole("button", {
    name: /Check for agents to import/,
  });
  expect(
    screen.queryByText("You have agents in Buzz (Legacy)."),
  ).not.toBeInTheDocument();
  await user.click(entry);
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(await within(dialog).findByText(warning)).toBeVisible();
  expect(
    within(dialog).getByText("No agents found in the sources we could read."),
  ).toBeVisible();
  expect(agents.port).not.toHaveBeenCalled();
});

it("imports an old Buzz agent as the type chosen on its button", async () => {
  const user = userEvent.setup();
  const { agents, types } = setup([]);
  types.push({
    ...types[0],
    key: "test/other",
    title: "Other",
  } as unknown as RegisteredAgentType);
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  await user.click(
    await within(dialog).findByRole("button", {
      name: "Choose a type for Ada",
    }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Other" }));
  // Choosing changes the visible label; only pressing it imports.
  expect(
    within(dialog).getByRole("button", { name: "Import as Other, Ada" }),
  ).toHaveTextContent("Other");
  expect(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  ).toHaveTextContent("Echo");
  expect(agents.port).not.toHaveBeenCalled();
  expect(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  ).toBeInTheDocument();
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Other, Ada" }),
  );
  expect(agents.port).toHaveBeenCalledWith({
    source: "harness",
    pubkey: "a".repeat(64),
    type: "test/other",
  });
});

it("shows only teams in Import a team and only agents in Import an agent", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: portable,
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  await openImport(user);
  const teamDialog = screen.getByRole("dialog", { name: "Import a team" });
  expect(
    await within(teamDialog).findByRole("region", { name: "Teams to import" }),
  ).toBeInTheDocument();
  expect(
    within(teamDialog).queryByRole("region", { name: "Agents to import" }),
  ).not.toBeInTheDocument();
  await user.click(within(teamDialog).getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const agentDialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(
    await within(agentDialog).findByRole("region", {
      name: "Agents to import",
    }),
  ).toBeInTheDocument();
  expect(
    within(agentDialog).queryByRole("region", { name: "Teams to import" }),
  ).not.toBeInTheDocument();
});

it("keeps Import a team from closing while a team import is pending", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: [],
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  let finish!: (value: Awaited<ReturnType<typeof agents.portTeam>>) => void;
  agents.portTeam.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  await openImport(user);
  await user.click(
    await screen.findByRole("button", {
      name: "Import as Echo, team Night Shift",
    }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import a team" });
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(dialog).toBeInTheDocument();
  await act(async () =>
    finish({
      imported: [],
      failed: [],
      elsewhere: ["Cy"],
      foreign: [],
      teamError: { name: "Night Shift" },
    }),
  );
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("dialog", { name: "Import a team" }),
  ).not.toBeInTheDocument();
});

it("lists old teams with how many members are here, and imports one as a team", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: portable,
    teams: [nightShift],
    warnings: [],
    here: ["c".repeat(64)],
  });
  await openImport(user);
  const teams = await screen.findByRole("region", { name: "Teams to import" });
  expect(within(teams).getByText("Night Shift")).toBeInTheDocument();
  // Cy is here already; Bea is still listed as an agent.
  expect(
    within(teams).getByText("2 members · 1 already here · Buzz (Legacy)"),
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Import as Echo, team Night Shift" }),
  );
  expect(agents.portTeam).toHaveBeenCalledWith({
    id: "old-night-shift",
    type: "test/echo",
  });
  expect(
    screen.queryByRole("dialog", { name: "Import a team" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Your teams" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("counts no member of a team as here when they were imported into another community", async () => {
  const user = userEvent.setup();
  // Bea and Cy were imported into another community; Import there lists none.
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: [],
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  await openImport(user);
  const teams = await screen.findByRole("region", { name: "Teams to import" });
  expect(
    within(teams).getByText("2 members · Buzz (Legacy)"),
  ).toBeInTheDocument();
  expect(within(teams).queryByText(/already here/)).not.toBeInTheDocument();
  expect(
    within(teams).getByRole("button", {
      name: "Import as Echo, team Night Shift",
    }),
  ).toBeEnabled();
});

it("keeps a team whose members are all here importable with no agents to list", async () => {
  const user = userEvent.setup();
  const bea = { ...agent("Bea", 2), pubkey: "b".repeat(64) };
  const cy = { ...agent("Cy", 3), pubkey: "c".repeat(64) };
  const { agents } = setup([bea, cy]);
  agents.portable.mockResolvedValue({
    agents: [],
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  agents.portTeam.mockImplementationOnce(async () => ({
    team: await agents.saveTeam({
      name: "Night Shift",
      instructions: "Ship small.",
      members: [bea.pubkey, cy.pubkey],
    }),
    imported: [],
    failed: [],
    elsewhere: [],
    foreign: [],
  }));
  await openImport(user);
  await user.click(
    await screen.findByRole("button", {
      name: "Import as Echo, team Night Shift",
    }),
  );
  expect(
    screen.queryByRole("region", { name: "Agents to import" }),
  ).not.toBeInTheDocument();
  expect(agents.portTeam).toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Your teams" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.getByRole("button", { name: /Night Shift/ }),
  ).toBeInTheDocument();
});

it("keeps Import open and names each part of a team import that did not come", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: portable,
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  // Renamed in old Buzz since it was listed: messages name what was saved.
  const team = { id: "t", name: "Late Shift", instructions: "", members: [] };
  const bea = { ...agent("Bea", 2), pubkey: "b".repeat(64) };
  agents.portTeam
    .mockResolvedValueOnce({
      team,
      imported: [bea],
      failed: [{ name: "Cy", error: "Keychain access was denied" }],
      elsewhere: [],
      foreign: [],
    })
    .mockResolvedValueOnce({
      imported: [bea],
      failed: [],
      elsewhere: ["Cy"],
      foreign: [],
      teamError: { name: "Late Shift" },
    })
    .mockResolvedValueOnce({
      team,
      imported: [],
      failed: [],
      elsewhere: ["Cy"],
      foreign: [],
    });
  await openImport(user);
  const importTeam = await screen.findByRole("button", {
    name: "Import as Echo, team Night Shift",
  });
  await user.click(importTeam);
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Imported team Late Shift with Bea. Couldn't import Cy: Keychain access was denied.",
  );
  expect(
    screen.getByText("2 members · 1 already here · Buzz (Legacy)"),
  ).toBeInTheDocument();
  await user.click(importTeam);
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn't save team Late Shift. Imported Bea; add them in Teams. Not added: Cy, in your other communities. Use Import an agent to add them here, then import the team again.",
  );
  await user.click(importTeam);
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Imported team Late Shift. Not added: Cy, in your other communities. Use Import an agent to add them here, then import the team again.",
  );
});

it("neither counts nor adds a member another account on this device has", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: portable,
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  const bea = { ...agent("Bea", 2), pubkey: "b".repeat(64) };
  agents.portTeam.mockResolvedValueOnce({
    team: { id: "t", name: "Night Shift", instructions: "", members: [] },
    imported: [bea],
    failed: [],
    elsewhere: [],
    foreign: ["Cy"],
  });
  await openImport(user);
  const teams = await screen.findByRole("region", { name: "Teams to import" });
  expect(
    within(teams).getByText("2 members · Buzz (Legacy)"),
  ).toBeInTheDocument();
  await user.click(
    within(teams).getByRole("button", {
      name: "Import as Echo, team Night Shift",
    }),
  );
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Imported team Night Shift with Bea. Kept out: Cy, which another account on this device has.",
  );
});

it("makes a team of chosen agents and lists it with its members", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const { agents, notify } = setup([ada, agent("Bo", 2), agent("Cy", 3)]);
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(screen.queryByRole("grid", { name: "Teams" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Ada leads.",
  );
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  await user.click(screen.getByRole("checkbox", { name: "Cy" }));
  await user.click(screen.getByRole("button", { name: "Create team" }));

  expect(agents.saveTeam).toHaveBeenCalledWith({
    draft: expect.any(String),
    name: "Crew",
    instructions: "Ada leads.",
    members: [ada.pubkey, agent("Cy", 3).pubkey],
  });
  const card = within(screen.getByRole("list", { name: "Teams" })).getByRole(
    "button",
    { name: "Crew" },
  );
  expect(card).toHaveTextContent("Ada, Cy");

  await user.click(card);
  const form = screen.getByRole("form", { name: "Edit Crew" });
  expect(form).toHaveTextContent("Only on this Mac");
  // A move that fails while the editor is open shows at once.
  agents.teamSync.mockReturnValue({ local: "failed" });
  act(() => notify());
  expect(form).toHaveTextContent(
    "Only on this Mac. Moving it to the community failed; Buzz will try again.",
  );
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  let dialog = await screen.findByRole("alertdialog", { name: "Delete Crew?" });
  expect(dialog).toHaveAccessibleDescription(
    "Its agents aren't deleted, but they stop getting its instructions. It can't be undone.",
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  // Escape dismisses only the confirmation, not the editor under it.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(agents.removeTeam).not.toHaveBeenCalled();
  expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Delete team" })).toHaveFocus(),
  );
  // So does one pressed before focus moves into the dialog, which starts in
  // the editor.
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  await screen.findByRole("alertdialog", { name: "Delete Crew?" });
  fireEvent.keyDown(
    within(
      screen.getByRole("form", { name: "Edit Crew", hidden: true }),
    ).getByRole("button", { name: "Delete team", hidden: true }),
    { key: "Escape" },
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  dialog = await screen.findByRole("alertdialog", { name: "Delete Crew?" });
  await user.click(within(dialog).getByRole("button", { name: "Delete team" }));
  expect(agents.removeTeam).toHaveBeenCalledWith("team-1");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByRole("list", { name: "Teams" })).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Your teams" })).toHaveFocus(),
  );
});

it("keeps a local team with a draft from moving, so its editor stays open, and lets it move once saved", async () => {
  const ada = agent("Ada", 1);
  const local = {
    id: "local-team",
    name: "Crew",
    instructions: "Before",
    members: [ada.pubkey],
  };
  const view = setup([ada], { teams: [local] });
  const user = userEvent.setup();
  // What a move does unless the team is held: its synced copy replaces it.
  const move = () =>
    act(() => {
      if (!view.held.has(local.id))
        view.change({
          teams: [{ ...local, id: "moved-team", revision: "confirmed" }],
        });
    });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(
    within(screen.getByRole("list", { name: "Teams" })).getByRole("button", {
      name: "Crew",
    }),
  );
  const box = screen.getByRole("textbox", { name: "Instructions" });
  await user.clear(box);
  await user.type(box, "UNSAVED DRAFT");
  expect(view.agents.holdTeam).toHaveBeenCalledWith(local.id);
  move();
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "UNSAVED DRAFT",
  );
  // Back to what it opened with, nothing is held.
  await user.clear(box);
  await user.type(box, "Before");
  expect(view.held.has(local.id)).toBe(false);
});

it("offers hosted agents as members, warning that they may not get the instructions", async () => {
  const user = userEvent.setup();
  setup([
    agent("Ada", 1),
    { ...agent("Sky", 2), place: "hosted" },
    { ...agent("Kai", 5), place: "hosted" },
    { ...agent("Bo", 3), place: "hosted", unfinished: true },
    { ...agent("Cy", 4), place: "elsewhere" },
  ]);
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  );
  const members = ["Ada", "Sky", "Bo", "Cy"].map((name) =>
    screen.queryByRole("checkbox", { name }),
  );
  expect(members.map(Boolean)).toEqual([true, true, false, false]);
  const instructions = screen.getByRole("textbox", { name: "Instructions" });
  const local = "Every member follows these after its own instructions.";
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  expect(instructions).toHaveAccessibleDescription(local);
  await user.click(screen.getByRole("checkbox", { name: "Sky" }));
  expect(instructions).toHaveAccessibleDescription(
    "Agents on your devices follow these after their own instructions. Agents run by their provider (Sky) will not get these team instructions.",
  );
  await user.click(screen.getByRole("checkbox", { name: "Kai" }));
  expect(instructions).toHaveAccessibleDescription(
    /\(Sky and Kai\) will not get these team instructions\.$/,
  );
  await user.click(screen.getByRole("checkbox", { name: "Sky" }));
  await user.click(screen.getByRole("checkbox", { name: "Kai" }));
  expect(instructions).toHaveAccessibleDescription(local);
});

it("offers hosted agents only to a team Save puts in this community", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const synced = (id: string, name: string) => ({
    id,
    name,
    instructions: "",
    members: [ada.pubkey],
    revision: "1",
  });
  const { agents } = setup([ada, { ...agent("Sky", 2), place: "hosted" }], {
    teams: [
      { id: "crew", name: "Crew", instructions: "", members: [ada.pubkey] },
      synced("synced", "Synced"),
      synced("away", "Away"),
    ],
  });
  // Away's home is another community, and a new team made here is local.
  agents.teamHere.mockImplementation(({ id }) => id === "synced");
  const sky = () => screen.queryByRole("checkbox", { name: "Sky" });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  for (const name of ["Crew", "Away", "Synced"]) {
    await user.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("checkbox", { name: "Ada" })).toBeChecked();
    expect(!!sky()).toBe(name === "Synced");
    await user.keyboard("{Escape}");
  }
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  );
  expect(agents.teamHere).toHaveBeenCalledWith({ draft: expect.any(String) });
  expect(screen.getByRole("checkbox", { name: "Ada" })).toBeInTheDocument();
  expect(sky()).not.toBeInTheDocument();
});

it("leaves a hosted agent picked in another community off a new team, keeping the rest", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const sky: Agent = { ...agent("Sky", 2), place: "hosted" };
  const { agents, show } = setup([ada, sky], {
    teams: [
      {
        id: "sky",
        name: "Sky crew",
        instructions: "",
        members: [sky.pubkey],
        revision: "1",
      },
    ],
  });
  // Ada runs on this device, in the first community only.
  agents.memberships.mockImplementation((pubkey) =>
    pubkey === ada.pubkey
      ? [{ key: ada.key, origin: "https://relay.example", connected: true }]
      : [],
  );
  // A new team syncs in the selected community.
  let selected = ada.relay;
  agents.teamHere.mockImplementation(
    ({ id }, community = selected) => !!id || community === selected,
  );
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  await user.click(screen.getByRole("checkbox", { name: "Sky" }));
  // Another community that syncs teams, with its own hosted agent.
  const other = "wss://other.example";
  act(() => {
    selected = other;
    show([
      { ...agent("Bo", 3), relay: other },
      { ...agent("Kai", 5), place: "hosted", relay: other },
    ]);
  });
  expect(screen.getByRole("form", { name: "New team" })).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "Sky" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Kai" })).not.toBeChecked();
  expect(
    screen.getByText("+1 in your other communities, who stay on the team."),
  ).toBeInTheDocument();
  const instructions = screen.getByRole("textbox", { name: "Instructions" });
  expect(instructions).toHaveAccessibleDescription(
    "Every member follows these after its own instructions.",
  );
  await user.click(screen.getByRole("button", { name: "Create team" }));
  expect(agents.saveTeam).toHaveBeenLastCalledWith({
    draft: expect.any(String),
    name: "Crew",
    instructions: "",
    members: [ada.pubkey],
  });
  // A hosted member the team already has stays, though not listed here.
  await user.click(screen.getByRole("button", { name: "Sky crew" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(agents.saveTeam).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "sky", members: [sky.pubkey] }),
  );
});

it("keeps a hosted agent picked for a new team while its community lists agents again", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const sky: Agent = { ...agent("Sky", 2), place: "hosted" };
  const { agents, show } = setup([ada, sky]);
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  await user.click(screen.getByRole("checkbox", { name: "Sky" }));
  // The community reconnects and still syncs teams, but its hosted agents
  // are unlisted until their records are read again, so Save refuses Sky,
  // which still shows checked.
  act(() => show([ada]));
  expect(screen.getByRole("checkbox", { name: "Sky" })).toBeChecked();
  const refusal = "Can't tell yet whether Sky is in relay.example";
  agents.saveTeam.mockRejectedValueOnce(new Error(refusal));
  await user.click(screen.getByRole("button", { name: "Create team" }));
  const form = screen.getByRole("form", { name: "New team" });
  expect(await within(form).findByRole("alert")).toHaveTextContent(refusal);
  const draft = agents.saveTeam.mock.calls.at(-1)?.[0].draft;
  expect(agents.saveTeam).toHaveBeenLastCalledWith({
    draft: expect.any(String),
    name: "Crew",
    instructions: "",
    members: [ada.pubkey, sky.pubkey],
  });
  // Once they are, Sky is listed again, and Create keeps the draft.
  act(() => show([ada, sky]));
  expect(screen.getAllByRole("checkbox", { name: "Sky" })).toHaveLength(1);
  expect(screen.getByRole("checkbox", { name: "Sky" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Create team" }));
  expect(agents.saveTeam).toHaveBeenLastCalledWith({
    draft,
    name: "Crew",
    instructions: "",
    members: [ada.pubkey, sky.pubkey],
  });
});

it("lets a hosted agent picked for a new team be unchecked once it is no longer listed", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const sky: Agent = { ...agent("Sky", 2), place: "hosted" };
  const { agents, show } = setup([ada, sky]);
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  await user.click(screen.getByRole("checkbox", { name: "Sky" }));
  // Sky is deleted from another device, and the community's agent list is
  // read without it, so Save refuses it. It still shows, named in the warning.
  act(() => show([ada]));
  expect(
    screen.getByRole("textbox", { name: "Instructions" }),
  ).toHaveAccessibleDescription(
    /\(Sky\) will not get these team instructions\.$/,
  );
  const refusal = "Add Sky to relay.example first";
  agents.saveTeam.mockRejectedValueOnce(new Error(refusal));
  await user.click(screen.getByRole("button", { name: "Create team" }));
  const form = screen.getByRole("form", { name: "New team" });
  expect(await within(form).findByRole("alert")).toHaveTextContent(refusal);
  const draft = agents.saveTeam.mock.calls.at(-1)?.[0].draft;
  // Unchecking it keeps the draft, and Create leaves it off.
  await user.click(screen.getByRole("checkbox", { name: "Sky" }));
  expect(screen.getByRole("checkbox", { name: "Sky" })).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "Create team" }));
  expect(agents.saveTeam).toHaveBeenLastCalledWith({
    draft,
    name: "Crew",
    instructions: "",
    members: [ada.pubkey],
  });
});

it("offers an open new team hosted agents once its community is known to sync teams", async () => {
  const user = userEvent.setup();
  const { agents, change } = setup([
    agent("Ada", 1),
    { ...agent("Sky", 2), place: "hosted" },
  ]);
  // A new team syncs here once the community's config channels are up.
  agents.teamHere.mockImplementation(
    ({ id }) => !id && !!agents.snapshot().syncsTeams,
  );
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  expect(
    screen.queryByRole("checkbox", { name: "Sky" }),
  ).not.toBeInTheDocument();
  act(() => change({ syncsTeams: true }));
  expect(screen.getByRole("checkbox", { name: "Sky" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Ada" })).toBeChecked();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Crew");
});

it("closes the team editor when leaving Your teams", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await act(() =>
    agents.saveTeam({ name: "Crew", instructions: "", members: [] }),
  );
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "Crew" }));
  expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(
    screen.queryByRole("form", { name: "Edit Crew" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Crew" })).toBeInTheDocument();
});

it("asks before Escape, Close or another tab drops a team's unsaved edits", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await act(() =>
    agents.saveTeam({ name: "Crew", instructions: "Before.", members: [] }),
  );
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  const open = () => user.click(screen.getByRole("button", { name: "Crew" }));
  const prompt = () =>
    screen.findByRole("alertdialog", { name: "Discard changes?" });
  // An untouched editor closes at once.
  await open();
  expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull();

  // Escape asks about an edited name, instructions and members; Keep editing
  // keeps each edit.
  await open();
  await user.type(screen.getByRole("textbox", { name: "Name" }), " 2");
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    " More.",
  );
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  const edited = () => {
    expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Crew 2");
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "Before. More.",
    );
    expect(screen.getByRole("checkbox", { name: "Ada" })).toBeChecked();
  };
  // Shift+Escape is Mark all as read's, and leaves the editor alone.
  await user.keyboard("{Shift>}{Escape}{/Shift}");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  edited();
  await user.keyboard("{Escape}");
  let asked = await prompt();
  expect(asked).toHaveTextContent("Your unsaved changes to Crew will be lost.");
  const keep = within(asked).getByRole("button", { name: "Keep editing" });
  await waitFor(() => expect(keep).toHaveFocus());
  await user.click(keep);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  edited();

  // The Your agents tab asks too, and Keep editing stays on Your teams.
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  asked = await prompt();
  await user.click(within(asked).getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("tab", { name: "Your teams" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  edited();
  // Discard changes leaves, and the reopened team shows its saved version.
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  asked = await prompt();
  await user.click(
    within(asked).getByRole("button", { name: "Discard changes" }),
  );
  expect(screen.getByRole("tab", { name: "Your agents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull();
  await open();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Crew");
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "Before.",
  );
  expect(screen.getByRole("checkbox", { name: "Ada" })).not.toBeChecked();

  // So does Close, and Discard changes closes the editor.
  await user.type(screen.getByRole("textbox", { name: "Name" }), " 3");
  await user.click(
    within(screen.getByRole("form", { name: "Edit Crew" })).getByRole(
      "button",
      { name: "Close" },
    ),
  );
  asked = await prompt();
  await user.click(
    within(asked).getByRole("button", { name: "Discard changes" }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull();
  expect(screen.getByRole("button", { name: "Crew" })).toBeInTheDocument();
  expect(agents.saveTeam).toHaveBeenCalledOnce();
});

it("asks before dropping a new team with a name, and closes an empty one at once", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  const create = async () => {
    await user.click(screen.getByRole("button", { name: "New team" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Create a new team" }),
    );
    expect(screen.getByRole("form", { name: "New team" })).toBeInTheDocument();
  };
  await create();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("form", { name: "New team" })).toBeNull();

  await create();
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
  await user.keyboard("{Escape}");
  const asked = await screen.findByRole("alertdialog", {
    name: "Discard changes?",
  });
  expect(asked).toHaveTextContent("Your new team will be lost.");
  await user.click(
    within(asked).getByRole("button", { name: "Discard changes" }),
  );
  expect(screen.queryByRole("form", { name: "New team" })).toBeNull();
});

it("offers New team again when the team being edited disappears", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await act(async () => {
    await agents.saveTeam({
      id: "crew",
      name: "Crew",
      instructions: "",
      members: [],
    });
    await agents.saveTeam({
      id: "gone",
      name: "Gone",
      instructions: "",
      members: [],
    });
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "Gone" }));
  expect(
    screen.queryByRole("button", { name: "New team" }),
  ).not.toBeInTheDocument();
  await act(() => agents.removeTeam("gone"));
  expect(screen.getByRole("button", { name: "Crew" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New team" })).toBeInTheDocument();
});

it("explains an unavailable harness without claiming the key is on another device", async () => {
  const user = userEvent.setup();
  const navigator = {
    open: vi.fn(async () => ({ status: "opened" as const })),
  } as unknown as Navigation;
  setup(
    [
      {
        ...agent("Starf", 3),
        type: "block.builderlab/builderlab",
        place: "elsewhere",
      },
    ],
    { page: { navigator } },
  );
  const grid = screen.getByRole("grid", { name: "Agents" });
  expect(within(grid).getByText("Harness unavailable")).toBeInTheDocument();
  expect(screen.queryByText("On another device")).not.toBeInTheDocument();

  await user.click(within(grid).getByText("Starf"));
  expect(screen.getByText(/harness is unavailable/)).toHaveTextContent(
    "Check Manage plugins or use a build with this harness configured.",
  );
  expect(screen.queryByText(/another of your devices/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Delete agent" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Manage plugins" }));
  expect(navigator.open).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "settings",
    section: "plugins",
  });
});

it("links a profile whose type's plugin is off to Manage plugins", async () => {
  const user = userEvent.setup();
  const navigator = {
    open: vi.fn(async () => ({ status: "opened" as const })),
  } as unknown as Navigation;
  setup([{ ...agent("Lou", 3), type: "test/off" }], { page: { navigator } });

  await user.click(
    within(screen.getByRole("grid", { name: "Agents" })).getByText("Lou"),
  );
  const settings = screen.getByRole("region", { name: "Lou settings" });
  expect(
    within(settings).getByText(/provides this agent's type/),
  ).toHaveTextContent(
    "Enable the plugin that provides this agent's type in Manage plugins to change its settings.",
  );
  await user.click(
    within(settings).getByRole("button", { name: "Manage plugins" }),
  );
  expect(navigator.open).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "settings",
    section: "plugins",
  });
});

it("shows a synced team only where its members are, after switching communities", async () => {
  const user = userEvent.setup();
  const sky: Agent = { ...agent("Sky", 2), place: "hosted" };
  const { agents, show } = setup([agent("Ada", 1), sky], {
    teams: [
      {
        id: "sky",
        name: "Sky crew",
        instructions: "",
        members: [sky.pubkey],
        revision: "1",
      },
      {
        id: "empty",
        name: "Empty",
        instructions: "",
        members: [],
        revision: "1",
      },
      {
        id: "stale",
        name: "Stale",
        instructions: "",
        members: ["9".repeat(64)],
      },
    ],
  });
  const listed = () =>
    within(screen.getByRole("list", { name: "Teams" }))
      .getAllByRole("button")
      .map((card) => card.getAttribute("aria-label"));
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(listed()).toEqual(["Sky crew", "Empty", "Stale"]);
  await user.click(screen.getByRole("button", { name: "Sky crew" }));
  expect(
    screen.getByRole("form", { name: "Edit Sky crew" }),
  ).toBeInTheDocument();
  // Bo's community is no synced team's home.
  agents.teamHere.mockReturnValue(false);
  act(() => show([agent("Bo", 3)]));
  expect(
    screen.queryByRole("form", { name: "Edit Sky crew" }),
  ).not.toBeInTheDocument();
  expect(listed()).toEqual(["Empty", "Stale"]);
});

it("keeps a synced team in its home while none of its members is listed", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], {
    teams: [
      {
        id: "gone",
        name: "Gone",
        instructions: "",
        members: ["9".repeat(64)],
        revision: "1",
      },
    ],
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(agents.teamHere).toHaveBeenCalledWith({ id: "gone" }, undefined);
  await user.click(screen.getByRole("button", { name: "Gone" }));
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Delete Gone?",
  });
  expect(dialog).toHaveAccessibleDescription(
    "It's deleted on all your devices. Its agents aren't deleted, but they stop getting its instructions. It can't be undone.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Delete team" }));
  expect(agents.removeTeam).toHaveBeenCalledWith("gone");
});

it("keeps a failed team delete in its dialog, and only there", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], {
    teams: [
      {
        id: "crew",
        name: "Crew",
        instructions: "",
        members: ["9".repeat(64)],
        revision: "1",
      },
    ],
  });
  let fail!: (reason: Error) => void;
  agents.removeTeam.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "Crew" }));
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Delete Crew?",
  });
  await user.click(within(dialog).getByRole("button", { name: "Delete team" }));
  expect(agents.removeTeam).toHaveBeenCalledWith("crew");
  // While pending, neither Cancel nor Escape closes it or the editor.
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(dialog).toBeInTheDocument();
  expect(
    screen.getByRole("form", { name: "Edit Crew", hidden: true }),
  ).toBeInTheDocument();

  await act(async () =>
    fail(new Error("Connect to relay.example to delete this team")),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Connect to relay.example to delete this team",
  );
  expect(screen.getAllByText(/^Connect to relay\.example/)).toHaveLength(1);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByText(/^Connect to relay\.example/)).toBeNull();
  expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Delete team" })).toHaveFocus(),
  );
});

it("keeps a local team's editor open through a failed delete, for a retry", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const crew = {
    id: "crew",
    name: "Crew",
    instructions: "",
    members: [ada.pubkey],
  };
  const { agents, change } = setup([ada], { teams: [crew] });
  let fail!: () => void;
  // As the service does: a local team leaves the list as its delete starts,
  // and comes back when the write fails.
  agents.removeTeam.mockImplementationOnce(async () => {
    change({ teams: [] });
    await new Promise<void>((resolve) => {
      fail = resolve;
    });
    change({ teams: [crew] });
    throw new Error("Could not save teams");
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "Crew" }));
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Delete Crew?",
  });
  await user.click(within(dialog).getByRole("button", { name: "Delete team" }));
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(
    screen.getByRole("form", { name: "Edit Crew", hidden: true }),
  ).toBeInTheDocument();

  await act(async () => fail());
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Could not save teams",
  );
  expect(dialog).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Delete team" }));
  expect(agents.removeTeam).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Your teams" })).toHaveFocus(),
  );
});

it("closes a synced team's editor when its delete ends, before the team leaves the list", async () => {
  const user = userEvent.setup();
  const { agents, change } = setup([agent("Ada", 1)], {
    teams: [
      {
        id: "crew",
        name: "Crew",
        instructions: "",
        members: ["9".repeat(64)],
        revision: "1",
      },
    ],
  });
  let finish!: () => void;
  agents.removeTeam.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "Crew" }));
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Delete Crew?",
  });
  await user.click(within(dialog).getByRole("button", { name: "Delete team" }));
  expect(
    within(dialog).getByRole("button", { name: "Delete team" }),
  ).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

  await act(async () => finish());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Your teams" })).toHaveFocus(),
  );
  act(() => change({ teams: [] }));
  expect(screen.queryByRole("button", { name: "Crew" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Your teams" })).toHaveFocus();
});

it("focuses Your teams when a team is deleted elsewhere under its dialog", async () => {
  const user = userEvent.setup();
  const { change } = setup([agent("Ada", 1)], {
    teams: [
      {
        id: "crew",
        name: "Crew",
        instructions: "",
        members: ["9".repeat(64)],
        revision: "1",
      },
    ],
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "Crew" }));
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  await screen.findByRole("alertdialog", { name: "Delete Crew?" });
  act(() => change({ teams: [] }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Your teams" })).toHaveFocus(),
  );
});

it("shows an agent on another device read-only, and offers only Finish setup and Delete for an unfinished hosted one", async () => {
  const user = userEvent.setup();
  const far: Agent = {
    ...agent("Far", 3),
    place: "elsewhere",
    attention: {},
  };
  const sky: Agent = {
    ...agent("Sky", 4),
    place: "hosted",
    unfinished: true,
    attention: {},
  };
  const { agents } = setup([far, sky]);
  const grid = screen.getByRole("grid", { name: "Agents" });
  expect(within(grid).getByText("On another device")).toBeInTheDocument();
  expect(within(grid).getByText("Setup unfinished")).toBeInTheDocument();

  await user.click(within(grid).getByText("Far"));
  expect(screen.getByText(/another of your devices/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Wakes on")).not.toBeInTheDocument();
  await user.dblClick(within(grid).getByText("Far"));
  expect(screen.getByRole("grid")).toBeInTheDocument();

  await user.click(within(grid).getByText("Sky"));
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Delete agent" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Finish setup" }));
  expect(agents.finish).toHaveBeenCalledWith(sky.pubkey);
  await user.dblClick(within(grid).getByText("Sky"));
  expect(screen.getByRole("grid")).toBeInTheDocument();
});

it("moves focus from Finish setup to the first tab once the setup finishes", async () => {
  const user = userEvent.setup();
  const finished: Agent = {
    ...agent("Sky", 4),
    place: "hosted",
    attention: {},
  };
  const { agents, show } = setup([{ ...finished, unfinished: true }]);
  agents.finish.mockImplementationOnce(async () => {
    show([finished]);
    return finished;
  });
  await user.click(screen.getByText("Sky"));
  screen.getByRole("button", { name: "Finish setup" }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("tab", { name: "Reply" })).toHaveFocus();
});

it("keeps a failed Delete's agent and its warning on screen", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const { agents, show } = setup([ada]);
  const failure = "Ada isn't deleted yet and may still be in some channels.";
  agents.remove.mockImplementationOnce(async () => {
    show([{ ...ada, deleting: true }]);
    throw new Error(failure);
  });
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Delete agent" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(failure);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByText(/Its Delete didn't finish/)).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "Ada" })).toBeInTheDocument();
});

it("keeps a failed Remove from this community open to retry here alone", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const { agents, show } = setup([ada]);
  let leaving = false;
  agents.memberships.mockImplementation(() => [
    {
      key: ada.key,
      origin: "https://relay.example",
      connected: true,
      ...(leaving && { deleting: true as const }),
    },
    {
      key: `${ada.pubkey}@other.example`,
      origin: "https://other.example",
      connected: true,
    },
  ]);
  const failure = "Ada hasn't left relay.example yet.";
  agents.leave.mockImplementationOnce(async () => {
    leaving = true;
    show([{ ...ada, deleting: true }]);
    throw new Error(failure);
  });
  // Ada's card shows her second community once the page next renders, as it
  // does when Import's reads settle; a click mid-render would miss the card.
  await act(async () => {});
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  const remove = () =>
    user.click(
      screen.getByRole("button", { name: "Remove from this community" }),
    );
  await remove();
  let dialog = await screen.findByRole("dialog", {
    name: "Remove Ada from relay.example?",
  });
  await user.click(within(dialog).getByRole("button", { name: "Remove" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(failure);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByText(/Its Remove didn't finish/)).toBeInTheDocument();
  expect(screen.queryByText(/Its Delete didn't finish/)).toBeNull();
  await remove();
  dialog = await screen.findByRole("dialog", {
    name: "Remove Ada from relay.example?",
  });
  await user.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(agents.leave).toHaveBeenCalledTimes(2);
  expect(agents.leave).toHaveBeenLastCalledWith(ada.key);
  expect(agents.remove).not.toHaveBeenCalled();
});

it.each([
  ["a Delete", true, true],
  ["a Remove from there", false, false],
])(
  "forgets an agent where %s can't reach, and asks to Delete again only after a Delete",
  async (_, deleting, again) => {
    const user = userEvent.setup();
    const ada = agent("Ada", 1);
    const away = `${ada.pubkey}@other.example`;
    const { agents } = setup([deleting ? { ...ada, deleting } : ada]);
    let forgot = false;
    agents.memberships.mockImplementation(() => [
      {
        key: ada.key,
        origin: "https://relay.example",
        connected: true,
        ...(deleting && { deleting: true as const }),
      },
      ...(forgot
        ? []
        : [
            {
              key: away,
              origin: "https://other.example",
              connected: false,
              deleting: true as const,
            },
          ]),
    ]);
    agents.forget.mockImplementationOnce(async () => {
      forgot = true;
    });
    await user.click(screen.getByRole("gridcell", { name: "Ada" }));
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Delete agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Forget it in other.example",
      }),
    );
    expect(agents.forget).toHaveBeenCalledWith(away);
    expect(agents.remove).not.toHaveBeenCalled();
    expect(!!within(dialog).queryByText("Delete again to finish here.")).toBe(
      again,
    );
  },
);

it("opens deletion from the card menu without selecting it and requires confirmation", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: "Actions for Ada" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete agent" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
  expect(screen.queryByText("Peek of Ada")).not.toBeInTheDocument();
  expect(agents.remove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(agents.remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Actions for Ada" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Open settings" }),
  );
  expect(screen.getByRole("tab", { name: "Reply" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it.each([false, true])(
  "keeps the production provider/model presentation on a remote card (model controls: %s)",
  (model) => {
    setup(
      [{ ...agent("Ada", 1), place: "hosted", config: { reply: "Echo" } }],
      { model },
    );
    const card = screen.getByRole("gridcell", { name: "Ada" });
    expect(within(card).queryByText("Remote")).not.toBeInTheDocument();
    if (model) {
      expect(
        within(card).getByRole("button", { name: "Change model" }),
      ).toBeVisible();
      expect(within(card).queryByText("Echo")).not.toBeInTheDocument();
    } else {
      const detail = within(card).getByText("Echo");
      expect(detail.parentElement?.querySelector("svg")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    }
  },
);

it("saves a card model through its type and keeps failures on the card", async () => {
  const user = userEvent.setup();
  const saved = agent("Ada", 1);
  const { agents } = setup([saved], { model: true });
  expect(screen.queryByText("Local · Desktop")).not.toBeInTheDocument();
  agents.save.mockRejectedValueOnce(new Error("Model could not save"));
  await user.click(screen.getByRole("button", { name: "Change model" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Model could not save",
  );
  expect(screen.queryByText("Peek of Ada")).not.toBeInTheDocument();
  expect(agents.save).toHaveBeenCalledWith(saved.pubkey, {
    config: { reply: "New model" },
  });
  await user.click(screen.getByRole("button", { name: "Change model" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(agents.save).toHaveBeenCalledTimes(2);
  await user.click(
    screen.getByRole("button", { name: "Model settings for Ada" }),
  );
  expect(
    await screen.findByRole("complementary", { name: "Ada identity" }),
  ).toBeVisible();
});

it("opens marketplace beside Your teams without a modal", async () => {
  const user = userEvent.setup();
  setup([]);
  await user.click(screen.getByRole("tab", { name: "Marketplace" }));
  expect(
    screen.getByRole("tabpanel", { name: "Marketplace" }),
  ).toHaveTextContent("Connect to a community to browse shared agents.");
  expect(
    screen.queryByRole("dialog", { name: "Marketplace" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "New agent" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  expect(
    screen.getByRole("button", { name: "Create your first agent" }),
  ).toBeVisible();
});

it("offers importing first agents only when there are some to import", async () => {
  const user = userEvent.setup();
  setup([]);
  const tile = await screen.findByRole("button", { name: /Import them now/ });
  // Agents show by picture alone; one without a picture shows its initial.
  expect(tile).toHaveTextContent("You have agents in Buzz (Legacy).");
  expect(tile).not.toHaveTextContent("Ada");
  expect(
    tile.querySelectorAll("[data-avatar-stack] > [data-avatar-shape]"),
  ).toHaveLength(2);
  await user.click(
    screen.getByRole("button", { name: "Create your first agent" }),
  );
  expect(screen.getByRole("dialog", { name: "Create agent" })).toBeVisible();
  cleanup();
  setup([], { found: [] });
  expect(
    await screen.findByRole("button", { name: "Create your first agent" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Explore the marketplace" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Import them now/ }),
  ).not.toBeInTheDocument();
});

it("stacks five old agents, pictures first, and counts the rest", async () => {
  setup([], {
    found: ["Ada", "Bea", "Cy", "Di", "Ed", "Flo", "Gus"].map(
      (name, index) => ({
        source: "installed" as const,
        pubkey: String(index).repeat(64),
        name,
        relay: "",
        ...(name === "Gus"
          ? { picture: "https://old.example/media/g.png" }
          : {}),
      }),
    ),
  });
  const tile = await screen.findByRole("button", { name: /Import them now/ });
  const stacked = tile.querySelectorAll(
    "[data-avatar-stack] > [data-avatar-shape]",
  );
  // Five agents, then the count as one more stack item.
  expect(stacked).toHaveLength(6);
  expect(stacked[5]).toHaveTextContent("+2");
  // Gus, the only one with a picture, leads; the rest show initials.
  expect(stacked[1]).toHaveTextContent("A");
  expect(stacked[0]?.querySelector("img")).toHaveAttribute(
    "src",
    "https://old.example/media/g.png",
  );
});

it("offers creating and the marketplace while agents load", () => {
  setup([], { status: "loading" });
  expect(
    screen.getByRole("button", { name: "Create your first agent" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Explore the marketplace" }),
  ).toBeEnabled();
});

it.each(["error", "unavailable"] as const)(
  "keeps import and marketplace reachable while agents are %s",
  async (status) => {
    setup([], { status });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New agent" }));
    expect(
      await screen.findByRole("menuitem", { name: "Create a new agent" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Import an agent" }));
    expect(
      await screen.findByRole("dialog", { name: "Import an agent" }),
    ).toBeVisible();
  },
);

it("says in Settings where an agent's config lives, and why it is only here", async () => {
  const user = userEvent.setup();
  const { agents, notify } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  // Still checking: no line, until the relay turns out not to sync.
  expect(screen.queryByText("Only on this Mac")).not.toBeInTheDocument();
  agents.agentSync.mockReturnValue({ local: "unsupported" });
  act(() => notify());
  expect(screen.getByText("Only on this Mac")).toBeVisible();
  expect(
    screen.getByText("This community's relay doesn't sync agent settings."),
  ).toBeVisible();
});

it("keeps the copy and delete rows in Settings, below the agent identity", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  const copy = vi.spyOn(navigator.clipboard, "writeText");
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  const identity = screen.getByRole("complementary", { name: "Ada identity" });
  expect(within(identity).queryByText("Public key")).not.toBeInTheDocument();
  expect(
    within(identity).queryByRole("button", { name: "Delete agent" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(copy).toHaveBeenCalledWith(expect.stringMatching(/^npub1/));
  expect(
    await screen.findByRole("button", { name: "Copied" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete agent" }));
  const dialog = screen.getByRole("dialog", { name: "Delete Ada?" });
  expect(agents.remove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("tab", { name: "Reply" }));
  expect(
    screen.queryByRole("button", { name: "Delete agent" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  copy.mockRejectedValueOnce(new Error("Clipboard denied"));
  await user.click(
    screen.getByRole("button", { name: /Copied|Copy public key/ }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not copy the public key",
  );
  copy.mockRestore();
});

it("opens provider setup before staging an unready provider, and leaves the switch unsaved", async () => {
  const user = userEvent.setup();
  const install = vi.fn();
  const destination = provider("attention", ({ onClose }) => (
    <>
      <p>Provider installation and sign-in</p>
      <button
        type="button"
        onClick={() => {
          install();
          destination.set({ readiness: "ready" });
          onClose();
        }}
      >
        Install and connect
      </button>
    </>
  ));
  const target = {
    key: "test/destination",
    pluginId: "test",
    revision: "1",
    id: "destination",
    title: "Destination",
    defaults: () => ({ config: {} }),
    provider: destination.contribution,
  } as unknown as RegisteredAgentType;
  const { agents } = setup([agent("Ada", 1)], { more: [target] });
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  const choose = async () => {
    await user.click(
      screen.getByRole("button", { name: "Change harness from Echo" }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Destination" }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    return screen.findByRole("dialog", { name: "Destination" });
  };
  const setupDialog = await choose();
  expect(destination.check).toHaveBeenCalledOnce();
  expect(install).not.toHaveBeenCalled();
  expect(agents.retype).not.toHaveBeenCalled();
  await user.click(within(setupDialog).getByRole("button", { name: "Close" }));
  expect(
    screen.getByRole("button", { name: "Change harness from Echo" }),
  ).toBeInTheDocument();
  await choose();
  await user.click(screen.getByRole("button", { name: "Install and connect" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Change harness from Destination" }),
  ).toBeInTheDocument();
  expect(agents.retype).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(agents.retype).toHaveBeenCalledWith("1".repeat(64), target.key, {
    config: expect.anything(),
  });
});

it("opens avatar and name editing from the profile menu", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  const menu = screen.getByRole("button", { name: "Agent profile actions" });
  await user.click(menu);
  await user.click(
    await screen.findByRole("menuitem", { name: "Change avatar" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Change avatar" });
  expect(dialog).toHaveAttribute("data-height", "content");
  expect(within(dialog).getByRole("tab", { name: "Emoji" })).toBeVisible();
  expect(
    within(dialog).queryByRole("button", { name: "Back" }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(menu).toHaveFocus());
  await user.click(menu);
  await user.click(
    await screen.findByRole("menuitem", { name: "Change name" }),
  );
  expect(
    await screen.findByRole("textbox", { name: "Agent name" }),
  ).toHaveValue("Ada");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(agents.save).not.toHaveBeenCalled();
});

it("keeps avatar changes as a draft until Save and closes without saving", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change avatar" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Change avatar" });
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  expect(
    within(dialog).getByRole("button", { name: "Choose emoji" }),
  ).toBeVisible();
  expect(
    within(dialog).getByRole("group", { name: "Avatar background" }),
  ).toBeVisible();
  expect(agents.save).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(dialog).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(agents.save).not.toHaveBeenCalled();
});

it("shares the editable owner profile with chat profile targets", async () => {
  const ada = agent("Ada", 1);
  const view = setup([ada]);
  const owner = createRelaySession(null);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: ada.owner,
    session: owner.session,
  };
  const relay = { ...view.relay, snapshot: () => snapshot };
  const close = vi.fn();
  try {
    view.rerender(
      <ProfilePanel
        agents={view.agents}
        relay={relay}
        target={profileTarget(ada.pubkey, { agent: true }) ?? ""}
        close={close}
      />,
    );
    expect(screen.getByRole("heading", { name: "Ada" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Reply" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Info" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Agent profile actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Change name" }),
    );
    expect(screen.getByRole("textbox", { name: "Agent name" })).toBeVisible();
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("saves an avatar directly from the creation picker", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  vi.mocked(agents.save).mockRejectedValueOnce(
    new Error("Could not save avatar"),
  );
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change avatar" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Change avatar" });
  await user.click(within(dialog).getByRole("button", { name: "Gloopies 1" }));
  expect(
    within(dialog).queryByRole("textbox", { name: "Agent name" }),
  ).not.toBeInTheDocument();
  expect(agents.save).not.toHaveBeenCalled();
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Could not save avatar",
  );
  expect(dialog).toBeVisible();
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(agents.save).toHaveBeenCalledWith("1".repeat(64), {
    picture: expect.any(String),
  });
});

it("opens the owned agent provider Activity tab for the originating conversation", async () => {
  const ada = agent("Ada", 1);
  const view = setup([ada]);
  const owner = createRelaySession(null);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: ada.owner,
    session: owner.session,
  };
  const relay = { ...view.relay, snapshot: () => snapshot };
  const renderActivity = vi.fn(({ agent, conversation }: AgentViewProps) => (
    <p>
      Transcript: {agent.pubkey} / {conversation?.channelId}
    </p>
  ));
  const originalType = view.agents.types()[0];
  if (!originalType) throw new Error("Missing fixture type");
  const activityType: RegisteredAgentType = {
    ...originalType,
    tabs: [
      ...(originalType.tabs ?? []),
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: renderActivity,
      },
    ],
  };
  const types = [activityType];
  view.agents.types = () => types;
  const context = {
    channelId: "channel-a",
    canOpen: vi.fn(() => true),
    open: vi.fn(() => true),
  };
  const close = vi.fn();
  try {
    view.rerender(
      <ProfilePanel
        agents={view.agents}
        relay={relay}
        target={profileTarget(ada.pubkey) ?? ""}
        context={context}
        close={close}
      />,
    );
    expect(screen.getByRole("tab", { name: "Reply" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    view.rerender(
      <ProfilePanel
        agents={view.agents}
        relay={relay}
        target={profileActivityViewTarget(ada.pubkey) ?? ""}
        context={context}
        close={close}
      />,
    );
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByText(`Transcript: ${ada.pubkey} / channel-a`),
    ).toBeVisible();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Reply" }));
    expect(screen.getByRole("tab", { name: "Reply" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    types[0] = originalType;
    view.rerender(
      <ProfilePanel
        agents={view.agents}
        relay={relay}
        target={profileActivityViewTarget(ada.pubkey) ?? ""}
        context={context}
        close={close}
      />,
    );
    expect(
      screen.queryByRole("tab", { name: "Activity" }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("lets an Activity tab open a thread or channel through the host", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = { open } as unknown as Navigation;
  const view = setup([ada], { page: { navigator } });
  const owner = createRelaySession(null);
  const origin = "https://relay.test";
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: ada.owner,
    origin,
    scope: `${origin}:${ada.owner}`,
    session: owner.session,
  };
  const relay = { ...view.relay, snapshot: () => snapshot };
  const root = "c".repeat(64);
  const Activity = ({ openConversation }: AgentViewProps) => (
    <>
      <button
        type="button"
        onClick={() => openConversation?.("channel-a", root)}
      >
        Thread cccccccc
      </button>
      <button type="button" onClick={() => openConversation?.("channel-a")}>
        Channel
      </button>
    </>
  );
  const echo = view.agents.types()[0];
  if (!echo) throw new Error("Missing fixture type");
  const types = [
    {
      ...echo,
      tabs: [
        {
          id: "activity",
          title: "Activity",
          role: "activity" as const,
          component: Activity,
        },
      ],
    },
  ];
  view.agents.types = () => types;
  try {
    view.rerender(
      <AgentsPage agents={view.agents} relay={relay} navigator={navigator} />,
    );
    await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
    const profile = await screen.findByRole("region", {
      name: "Agent profile",
    });
    await user.click(within(profile).getByRole("tab", { name: "Activity" }));
    const scope = { viewer: ada.owner, communityOrigin: origin };
    await user.click(
      within(profile).getByRole("button", { name: "Thread cccccccc" }),
    );
    // A thread opens at its root message, which names the thread.
    expect(open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "channel-a",
      messageId: root,
      threadRootId: root,
    });
    await user.click(within(profile).getByRole("button", { name: "Channel" }));
    expect(open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "channel-a",
    });
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("removes an existing avatar through the image editor and explicit Save", async () => {
  const user = userEvent.setup();
  const { agents } = setup([
    { ...agent("Ada", 1), picture: "https://example.com/avatar.png" },
  ]);
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change avatar" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Change avatar" });
  await user.click(
    within(dialog).getByRole("button", { name: "Remove avatar" }),
  );
  expect(agents.save).not.toHaveBeenCalled();
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  expect(agents.save).toHaveBeenCalledWith("1".repeat(64), { picture: null });
});

it("retains the selected profile draft while viewing teams", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { dirtySettings: true });
  await user.click(
    within(screen.getByRole("grid", { name: "Agents" })).getByText("Ada"),
  );
  const field = screen.getByRole("textbox", { name: "Reply" });
  await user.clear(field);
  await user.type(field, "Unsaved reply");
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(screen.getByRole("button", { name: "New team" })).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  expect(field).toBeInTheDocument();
  expect(field).not.toBeVisible();
  expect(agents.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(field);
  expect(field).toBeVisible();
  expect(field).toHaveValue("Unsaved reply");
  expect(agents.save).not.toHaveBeenCalled();
});

it("asks before choosing another agent discards an unsaved draft", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1), agent("Bo", 2)], {
    dirtySettings: true,
  });
  const grid = screen.getByRole("grid", { name: "Agents" });
  await user.click(within(grid).getByText("Ada"));
  const field = screen.getByRole("textbox", { name: "Reply" });
  await user.clear(field);
  await user.type(field, "Unsaved reply");

  await user.click(within(grid).getByText("Bo"));
  const prompt = await screen.findByRole("alertdialog", {
    name: "Discard changes?",
  });
  expect(prompt).toHaveTextContent("Your unsaved changes to Ada will be lost.");
  const keep = within(prompt).getByRole("button", { name: "Keep editing" });
  await waitFor(() => expect(keep).toHaveFocus());
  await user.click(keep);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "Ada" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(field);
  expect(field).toHaveValue("Unsaved reply");

  // The arrow keys ask the same way; Escape keeps editing.
  screen.getByRole("gridcell", { name: "Ada" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(
    await screen.findByRole("alertdialog", { name: "Discard changes?" }),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("gridcell", { name: "Ada" })).toHaveFocus(),
  );
  expect(field).toHaveValue("Unsaved reply");

  // Discarding moves the selection, and keyboard focus with it.
  await user.keyboard("{ArrowRight}");
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Discard changes" }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "Bo" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "Bo" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await waitFor(() =>
    expect(screen.getByRole("gridcell", { name: "Bo" })).toHaveFocus(),
  );
  expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(
    "Bo says hi",
  );
  expect(agents.save).not.toHaveBeenCalled();

  // Without a draft, nothing asks.
  await user.click(within(grid).getByText("Ada"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(
    "Ada says hi",
  );
});

it("asks before closing a panel with an unsaved draft and keeps it through another agent's deletion", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const { agents, show } = setup([ada, agent("Bo", 2)], {
    dirtySettings: true,
  });
  const grid = screen.getByRole("grid", { name: "Agents" });
  await user.click(within(grid).getByText("Ada"));
  const field = screen.getByRole("textbox", { name: "Reply" });
  await user.clear(field);
  await user.type(field, "Unsaved reply");

  const close = screen.getByRole("button", { name: "Close Ada tab" });
  await user.click(close);
  const prompt = await screen.findByRole("alertdialog", {
    name: "Discard changes?",
  });
  await user.click(
    within(prompt).getByRole("button", { name: "Keep editing" }),
  );
  await waitFor(() => expect(close).toHaveFocus());
  expect(screen.getByRole("region", { name: "Agent profile" })).toBeVisible();
  expect(field).toHaveValue("Unsaved reply");

  // Escape in the grid asks too.
  screen.getByRole("gridcell", { name: "Ada" }).focus();
  await user.keyboard("{Escape}");
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Keep editing" }),
  );
  expect(field).toHaveValue("Unsaved reply");

  // Deleting another agent leaves this panel and its draft.
  agents.remove.mockImplementationOnce(async () => show([ada]));
  await user.click(screen.getByRole("button", { name: "Actions for Bo" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete agent" }),
  );
  await user.click(
    within(await screen.findByRole("dialog", { name: "Delete Bo?" })).getByRole(
      "button",
      { name: "Delete" },
    ),
  );
  expect(agents.remove).toHaveBeenCalledWith("2".repeat(64));
  await waitFor(() =>
    expect(screen.queryByRole("gridcell", { name: "Bo" })).toBeNull(),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
  expect(field).toHaveValue("Unsaved reply");

  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Discard changes" }),
  );
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "Ada" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  expect(agents.save).not.toHaveBeenCalled();
  await user.click(within(grid).getByText("Ada"));
  expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(
    "Ada says hi",
  );
});

it("leaves focus in the grid when changing agents after keeping a draft over Close", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1), agent("Bo", 2)], { dirtySettings: true });
  const grid = screen.getByRole("grid", { name: "Agents" });
  await user.click(within(grid).getByText("Ada"));
  const field = screen.getByRole("textbox", { name: "Reply" });
  await user.type(field, "!");
  const close = screen.getByRole("button", { name: "Close Ada tab" });
  await user.click(close);
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Keep editing" }),
  );
  await waitFor(() => expect(close).toHaveFocus());
  // Undoing the edit leaves nothing to ask about.
  await user.type(field, "{Backspace}");
  screen.getByRole("gridcell", { name: "Ada" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "Bo" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "Bo" })).toHaveFocus();
});

/** Runs the script native Close Tab evaluates; jsdom gives the pane no geometry. */
const closeTab = () => {
  const rects = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue([{ width: 500, height: 500 }] as unknown as DOMRectList);
  let status: unknown;
  try {
    act(() => {
      status = new Function(
        "window",
        "document",
        "Event",
        "tabEvent",
        `return eval(${JSON.stringify(closeRequest)})`,
      )(window, document, Event, "buzz:close-active-tab");
    });
  } finally {
    rects.mockRestore();
  }
  return status;
};

it("focuses the closed agent's card after discarding a draft over ×, panel Escape or native Close Tab", async () => {
  const user = userEvent.setup();
  const [ada, bo] = [agent("Ada", 1), agent("Bo", 2)];
  const { show } = setup([ada, bo], { dirtySettings: true });
  const grid = screen.getByRole("grid", { name: "Agents" });
  const cell = (name: string) => screen.getByRole("gridcell", { name });
  const edit = async (name: string) => {
    await user.click(within(grid).getByText(name));
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "!");
  };
  const prompt = () =>
    screen.findByRole("alertdialog", { name: "Discard changes?" });
  const discard = async () =>
    user.click(
      within(await prompt()).getByRole("button", { name: "Discard changes" }),
    );

  // The card is found by key, so a reorder behind the prompt cannot misplace it.
  await edit("Bo");
  await user.click(screen.getByRole("button", { name: "Close Bo tab" }));
  await prompt();
  act(() => show([bo, ada]));
  await discard();
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(cell("Bo")).toHaveFocus());

  await edit("Ada");
  await user.keyboard("{Escape}");
  await discard();
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(cell("Ada")).toHaveFocus());

  await edit("Bo");
  expect(closeTab()).toBe("handled");
  await discard();
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(cell("Bo")).toHaveFocus());
});

it("focuses a cleanly closed panel's card, and leaves focus held outside the panel", async () => {
  const user = userEvent.setup();
  const sky: Agent = {
    ...agent("Sky", 4),
    place: "hosted",
    unfinished: true,
    attention: {},
  };
  setup([agent("Ada", 1), sky]);
  const grid = screen.getByRole("grid", { name: "Agents" });
  const cell = (name: string) => screen.getByRole("gridcell", { name });

  await user.click(within(grid).getByText("Ada"));
  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  expect(cell("Ada")).toHaveFocus();

  // An unfinished agent's peek closes from its own button the same way.
  await user.click(within(grid).getByText("Sky"));
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  expect(cell("Sky")).toHaveFocus();

  // Native Close Tab still closes the panel from outside it, leaving focus.
  await user.click(within(grid).getByText("Ada"));
  const yours = screen.getByRole("tab", { name: "Your agents" });
  yours.focus();
  expect(closeTab()).toBe("handled");
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  expect(yours).toHaveFocus();
});

it("keeps grid focus on the card a prompt leaves selected, after a click, a second click or Escape", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1), agent("Bo", 2)], { dirtySettings: true });
  const grid = screen.getByRole("grid", { name: "Agents" });
  const cell = (name: string) => screen.getByRole("gridcell", { name });
  const edit = (name: string) =>
    user
      .click(within(grid).getByText(name))
      .then(() =>
        user.type(screen.getByRole("textbox", { name: "Reply" }), "!"),
      );
  const answer = async (name: "Keep editing" | "Discard changes") =>
    user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Discard changes?" }),
      ).getByRole("button", { name }),
    );
  await edit("Ada");

  // Keeping the draft over another card returns focus to the kept one;
  // discarding it moves focus to the chosen one.
  await user.click(within(grid).getByText("Bo"));
  await answer("Keep editing");
  await waitFor(() => expect(cell("Ada")).toHaveFocus());
  expect(cell("Ada")).toHaveAttribute("aria-selected", "true");
  await user.click(within(grid).getByText("Bo"));
  await answer("Discard changes");
  expect(cell("Bo")).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(cell("Bo")).toHaveFocus());

  // A second click on the open card closes it, keeping focus there.
  await user.type(screen.getByRole("textbox", { name: "Reply" }), "!");
  await user.click(within(grid).getByText("Bo"));
  await answer("Discard changes");
  expect(cell("Bo")).toHaveAttribute("aria-selected", "false");
  await waitFor(() => expect(cell("Bo")).toHaveFocus());

  // Bo leaves the tab order once closed, so focus must be put back on it.
  await edit("Bo");
  cell("Bo").focus();
  await user.keyboard("{Escape}");
  await answer("Discard changes");
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(cell("Bo")).toHaveFocus());
  // The arrow keys still move from there.
  await user.keyboard("{Home}");
  expect(cell("Ada")).toHaveAttribute("aria-selected", "true");
  expect(cell("Ada")).toHaveFocus();
});

it("focuses the card a discard chose even when the list reorders behind the prompt", async () => {
  const user = userEvent.setup();
  const [ada, bo, cy] = [agent("Ada", 1), agent("Bo", 2), agent("Cy", 3)];
  const { show } = setup([ada, bo, cy], { dirtySettings: true });
  const grid = screen.getByRole("grid", { name: "Agents" });
  await user.click(within(grid).getByText("Ada"));
  await user.type(screen.getByRole("textbox", { name: "Reply" }), "!");
  screen.getByRole("gridcell", { name: "Ada" }).focus();
  await user.keyboard("{ArrowRight}");
  const prompt = await screen.findByRole("alertdialog", {
    name: "Discard changes?",
  });
  act(() => show([cy, ada, bo]));
  await user.click(
    within(prompt).getByRole("button", { name: "Discard changes" }),
  );
  expect(screen.getByRole("gridcell", { name: "Bo" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await waitFor(() =>
    expect(screen.getByRole("gridcell", { name: "Bo" })).toHaveFocus(),
  );
});

it("asks before a marketplace listing opens one of your agents over a draft", async () => {
  const user = userEvent.setup();
  const helper: Agent = {
    ...agent("Marketplace helper", 2),
    type: "test/shared",
    config: {},
  };
  const view = setup([agent("Ada", 1), helper], {
    dirtySettings: true,
    more: [
      {
        key: "test/shared",
        id: "shared",
        title: "Shared",
        defaults: () => ({ config: {} }),
        importShared: () => ({}),
        exportShared: () => ({
          model: "example-model",
          runtime: "test/shared",
        }),
        carry: () => ({ instructions: "Help with tasks." }),
      } as unknown as RegisteredAgentType,
    ],
  });
  const owner = createRelaySession(null);
  const session = {
    ...owner.session,
    read: vi.fn().mockResolvedValue([
      {
        id: "ab".repeat(32),
        pubkey: "cd".repeat(32),
        kind: 30175,
        created_at: 1,
        tags: [
          ["d", "helper"],
          ["shared", "true"],
        ],
        content: JSON.stringify({
          display_name: "Marketplace helper",
          system_prompt: "Help with tasks.",
          model: "example-model",
          runtime: "test/shared",
        }),
      },
    ]),
  };
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay = { ...view.relay, snapshot: () => snapshot };
  try {
    view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
    await user.click(screen.getByRole("gridcell", { name: "Ada" }));
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "!");
    await user.click(screen.getByRole("tab", { name: "Marketplace" }));
    await user.click(
      await screen.findByRole("button", { name: "Marketplace helper" }),
    );
    await user.click(screen.getByRole("button", { name: "Import" }));
    const open = within(
      screen.getByRole("dialog", { name: "Marketplace helper" }),
    ).getByRole("button", { name: "Open Marketplace helper" });

    await user.click(open);
    const prompt = await screen.findByRole("alertdialog", {
      name: "Discard changes?",
    });
    expect(prompt).toHaveTextContent(
      "Your unsaved changes to Ada will be lost.",
    );
    await user.click(
      within(prompt).getByRole("button", { name: "Keep editing" }),
    );
    // Nothing moves: the listing's dialog stays open over Marketplace.
    await waitFor(() => expect(open).toHaveFocus());
    expect(
      screen.getByRole("tab", { name: "Marketplace", hidden: true }),
    ).toHaveAttribute("aria-selected", "true");

    await user.click(open);
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Discard changes?" }),
      ).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Your agents" })).toHaveFocus(),
    );
    expect(
      screen.queryByRole("region", { name: "Shared agent profile" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("gridcell", { name: "Marketplace helper" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(view.agents.save).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("leaves an agent a link opened while an unfinished agent's Delete was finishing", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const sky: Agent = {
    ...agent("Sky", 4),
    place: "hosted",
    unfinished: true,
    attention: {},
  };
  const { agents, relay, rerender, show } = setup([ada, sky]);
  await user.click(
    within(screen.getByRole("grid", { name: "Agents" })).getByText("Sky"),
  );
  let finish!: () => void;
  agents.remove.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          show([ada]);
          resolve();
        };
      }),
  );
  await user.click(screen.getByRole("button", { name: "Delete agent" }));
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Delete Sky?" }),
    ).getByRole("button", { name: "Delete" }),
  );
  expect(agents.remove).toHaveBeenCalledWith(sky.key);

  const target = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
    route: { version: 1, params: { agent: ada.pubkey } },
  } as const;
  const navigator = {
    snapshot: () => ({ entry: { id: "ada", target } }),
    open: vi.fn(async () => ({ status: "opened" as const })),
  } as unknown as Navigation;
  const navigation: PageNavigation = {
    entryId: "ada",
    target,
    signal: new AbortController().signal,
    focus: "content",
    position: () => undefined,
    savePosition() {},
    passThrough: () => () => {},
    forSession: () => navigation,
    resolve: () => true,
    complete: () => true,
  };
  rerender(
    <AgentsPage
      agents={agents}
      relay={relay}
      navigator={navigator}
      navigation={navigation}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "Ada" }),
  ).toBeInTheDocument();
  await act(async () => finish());
  expect(screen.queryByRole("gridcell", { name: "Sky" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "Ada" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("keeps a draft open behind Import without asking, and deleting the open agent closes it without asking", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const bo = agent("Bo", 2);
  const { agents, show } = setup([ada, bo], { dirtySettings: true });
  const grid = screen.getByRole("grid", { name: "Agents" });
  await user.click(within(grid).getByText("Ada"));
  const field = screen.getByRole("textbox", { name: "Reply" });
  await user.clear(field);
  await user.type(field, "Unsaved reply");

  // Import is a dialog over the page, so the panel and its draft stay.
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const importing = await screen.findByRole("dialog", {
    name: "Import an agent",
  });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(within(importing).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Import an agent" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
  expect(field).toHaveValue("Unsaved reply");

  agents.remove.mockImplementationOnce(async () => show([bo]));
  await user.click(screen.getByRole("button", { name: "Actions for Ada" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete agent" }),
  );
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Delete Ada?" }),
    ).getByRole("button", { name: "Delete" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Agent profile" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(agents.save).not.toHaveBeenCalled();
});

it("asks about an unsaved agent name and keeps the selection while it saves", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1), agent("Bo", 2)]);
  const grid = screen.getByRole("grid", { name: "Agents" });
  await user.click(within(grid).getByText("Ada"));
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change name" }),
  );
  const name = await screen.findByRole("textbox", { name: "Agent name" });
  await user.clear(name);
  await user.type(name, "Ada Two");

  await user.click(within(grid).getByText("Bo"));
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Keep editing" }),
  );
  expect(name).toHaveValue("Ada Two");

  let finish!: () => void;
  agents.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  try {
    expect(agents.save).toHaveBeenCalledWith("1".repeat(64), {
      name: "Ada Two",
    });
    await user.click(within(grid).getByText("Bo"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("gridcell", { name: "Ada" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(grid).toHaveAttribute("aria-busy", "true");
  } finally {
    finish();
  }
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Agent name" }),
    ).not.toBeInTheDocument(),
  );
  expect(grid).not.toHaveAttribute("aria-busy");
  await user.click(within(grid).getByText("Bo"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "Bo" })).toBeInTheDocument();
});

it("asks before choosing another agent drops a staged harness change", async () => {
  const user = userEvent.setup();
  const relay = {
    key: "test/relay",
    pluginId: "test",
    revision: "1",
    id: "relay",
    title: "Relay",
    icon: PlugIcon,
    defaults: () => ({ config: { endpoint: "wss://relay.example" } }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: ({ settingsHost }: AgentViewProps) => (
          <>
            {settingsHost?.typeControl?.(false)}
            <p>Relay settings</p>
          </>
        ),
      },
    ],
  } as unknown as RegisteredAgentType;
  const { agents } = setup([agent("Ada", 1), agent("Bo", 2)], {
    more: [relay],
    dirtySettings: true,
  });
  const grid = screen.getByRole("grid", { name: "Agents" });
  await user.click(within(grid).getByText("Ada"));
  await user.click(
    screen.getByRole("button", { name: "Change harness from Echo" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Relay" }));
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Move Ada to Relay?" }),
    ).getByRole("button", { name: "Continue" }),
  );
  expect(await screen.findByText("Relay settings")).toBeVisible();

  // Only the staged change is unsaved; its settings tab reports nothing.
  await user.click(within(grid).getByText("Bo"));
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Keep editing" }),
  );
  expect(
    screen.getByRole("button", { name: "Change harness from Relay" }),
  ).toBeVisible();

  await user.click(within(grid).getByText("Bo"));
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Discard changes" }),
  );
  expect(screen.getByRole("heading", { name: "Bo" })).toBeInTheDocument();
  expect(agents.retype).not.toHaveBeenCalled();
  await user.click(within(grid).getByText("Ada"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Change harness from Echo" }),
  ).toBeVisible();
});

it("asks before Create or another card's Open settings replaces an unsaved draft", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1), agent("Bo", 2)], {
    dirtySettings: true,
  });
  const grid = screen.getByRole("grid", { name: "Agents" });
  await user.click(within(grid).getByText("Ada"));
  const field = screen.getByRole("textbox", { name: "Reply" });
  await user.clear(field);
  await user.type(field, "Unsaved reply");

  // The new agent is made either way; keeping the draft leaves it unopened.
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new agent" }),
  );
  const creating = screen.getByRole("dialog", { name: "Create agent" });
  await user.type(within(creating).getByLabelText("Name"), "Nova");
  await user.click(
    within(creating).getByRole("button", { name: "Create agent" }),
  );
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalled());
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Keep editing" }),
  );
  expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "Nova" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  expect(field).toHaveValue("Unsaved reply");

  await user.click(screen.getByRole("button", { name: "Actions for Bo" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Open settings" }),
  );
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Keep editing" }),
  );
  expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
  expect(field).toHaveValue("Unsaved reply");

  await user.click(screen.getByRole("button", { name: "Actions for Nova" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Open settings" }),
  );
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Discard changes" }),
  );
  expect(screen.getByRole("heading", { name: "Nova" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "Nova" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(agents.save).not.toHaveBeenCalled();
});

it("announces the Bestie on its card without repeating it in actions", async () => {
  const ada = agent("Ada", 1);
  const view = setup([ada]);
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: [{ pubkey: ada.pubkey, name: ada.name, managed: true }],
    selectable: [{ pubkey: ada.pubkey, name: ada.name, managed: true }],
    archives: { status: "unavailable", archived: [] },
  };
  const connection = {
    status: "ready",
    scope: "default-card",
    session: {
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const card = screen.getByRole("gridcell", { name: "Ada, Bestie" });
  expect(within(card).getByText("Bestie")).toBeVisible();
  expect(within(card).queryByRole("img", { name: "Bestie" })).toBeNull();
  fireEvent.keyDown(card, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  expect(within(menu).queryByText("Bestie")).toBeNull();
  // Without an account to save none to, it can't be removed here.
  expect(
    within(menu).queryByRole("menuitem", { name: "Remove as bestie" }),
  ).toBeNull();
  // Right-click carries the same ordinary actions as the card's "..." menu.
  expect(
    within(menu).getByRole("menuitem", { name: "Copy public key" }),
  ).toBeVisible();
  expect(within(menu).queryByRole("menuitemcheckbox")).toBeNull();
});

it("offers Make my bestie from the card's actions button", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const bea = agent("Bea", 2);
  const view = setup([ada, bea]);
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: [
      { pubkey: ada.pubkey, name: ada.name, managed: true },
      { pubkey: bea.pubkey, name: bea.name, managed: true },
    ],
    selectable: [
      { pubkey: ada.pubkey, name: ada.name, managed: true },
      { pubkey: bea.pubkey, name: bea.name, managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const connection = {
    status: "ready",
    scope: "main-card-button",
    session: {
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  expect(screen.getByRole("gridcell", { name: "Ada, Bestie" })).toBeVisible();
  const card = screen.getByRole("gridcell", { name: "Bea" });
  await user.click(
    within(card).getByRole("button", { name: "Actions for Bea" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Make my bestie" }),
  );
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  expect(confirmation).toHaveAccessibleDescription(
    "Your existing chats with Ada will still be available in your DMs.",
  );
  expect(
    within(confirmation).getByRole("button", { name: "Keep Ada" }),
  ).toBeVisible();
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Bea" }),
  );
  expect(
    await screen.findByRole("gridcell", { name: "Bea, Bestie" }),
  ).toBeVisible();
  expect(screen.getByRole("gridcell", { name: "Ada" })).toBeVisible();
  // Right-click opens the same actions, including the Bestie choice.
  fireEvent.contextMenu(screen.getByRole("gridcell", { name: "Ada" }));
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  await user.click(
    within(menu).getByRole("menuitem", { name: "Make my bestie" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Switch to Ada",
    }),
  );
  expect(
    await screen.findByRole("gridcell", { name: "Ada, Bestie" }),
  ).toBeVisible();
  expect(screen.getByRole("gridcell", { name: "Bea" })).toBeVisible();
});

it("offers Make my bestie for a remote agent, asking first, and Cancel saves nothing", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const sky: Agent = { ...agent("Sky", 2), place: "hosted" };
  const view = setup([ada, sky]);
  const rows = [ada, sky].map((each) => ({
    pubkey: each.pubkey,
    name: each.name,
    managed: true,
  }));
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: rows,
    selectable: rows,
    archives: { status: "unavailable", archived: [] },
  };
  // Saved none: there is no Bestie to replace.
  const mainAgent = {
    read: async () => null,
    write: vi.fn(async (_agent: string | null) => {}),
  };
  const connection = {
    status: "ready",
    scope: "remote-bestie",
    session: {
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const card = await screen.findByRole("gridcell", { name: /^Sky/ });
  const make = async () => {
    await user.click(
      within(card).getByRole("button", { name: "Actions for Sky" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Make my bestie" }),
    );
    return screen.findByRole("alertdialog", {
      name: "Use Sky as your bestie?",
    });
  };
  const ask = await make();
  expect(ask).toHaveTextContent(
    "Some bestie features aren’t available with remote agents.",
  );
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(mainAgent.write).not.toHaveBeenCalled();

  await user.click(
    within(await make()).getByRole("button", { name: "Use as bestie" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(sky.pubkey);
  await vi.waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
});

it("removes a Bestie on another device from its card, asking first", async () => {
  const user = userEvent.setup();
  const ada: Agent = { ...agent("Ada", 1), place: "elsewhere" };
  const view = setup([ada]);
  const rows = [{ pubkey: ada.pubkey, name: ada.name, managed: true }];
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: rows,
    selectable: rows,
    archives: { status: "unavailable", archived: [] },
  };
  const mainAgent = {
    read: async () => ada.pubkey,
    write: vi.fn(async (_agent: string | null) => {}),
  };
  const connection = {
    status: "ready",
    scope: "remove-remote-bestie",
    session: {
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const card = await screen.findByRole("gridcell", { name: "Ada, Bestie" });
  const ask = async () => {
    await user.click(
      within(card).getByRole("button", { name: "Actions for Ada" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove as bestie" }),
    );
    return screen.findByRole("alertdialog", {
      name: "Remove Ada as your Bestie?",
    });
  };
  // Removal starts on the secondary Cancel, which saves nothing; its
  // settings are on the device it runs on.
  let dialog = await ask();
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  expect(cancel).toHaveAttribute("data-variant", "subtle");
  await waitFor(() => expect(cancel).toHaveFocus());
  expect(dialog).toHaveTextContent(
    "turn them off in its Former Bestie tab on the device it runs on.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(mainAgent.write).not.toHaveBeenCalled();
  // A failed save says so and keeps the Bestie.
  mainAgent.write.mockRejectedValueOnce(new Error("offline"));
  dialog = await ask();
  await user.click(
    within(dialog).getByRole("button", { name: "Remove as Bestie" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Removing your Bestie couldn't be saved to your account. Try again.",
  );
  // The open dialog hides the page from the accessibility tree.
  expect(
    screen.getByRole("gridcell", { name: "Ada, Bestie", hidden: true }),
  ).toBeInTheDocument();
  await user.click(
    within(dialog).getByRole("button", { name: "Remove as Bestie" }),
  );
  expect(mainAgent.write).toHaveBeenLastCalledWith(null);
  expect(await screen.findByRole("gridcell", { name: "Ada" })).toBeVisible();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  // No longer Bestie, it is offered again instead.
  fireEvent.contextMenu(screen.getByRole("gridcell", { name: "Ada" }));
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  expect(
    within(menu).getByRole("menuitem", { name: "Make my bestie" }),
  ).toBeVisible();
  expect(
    within(menu).queryByRole("menuitem", { name: "Remove as bestie" }),
  ).toBeNull();
});

it("keeps a Bestie chosen elsewhere while its removal is being asked about", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const bea = agent("Bea", 2);
  const view = setup([ada, bea]);
  const rows = [ada, bea].map((each) => ({
    pubkey: each.pubkey,
    name: each.name,
    managed: true,
  }));
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: rows,
    selectable: rows,
    archives: { status: "unavailable", archived: [] },
  };
  const mainAgent = {
    read: async () => ada.pubkey,
    write: vi.fn(async (_agent: string | null) => {}),
  };
  const connection = {
    status: "ready",
    scope: "remove-superseded-bestie",
    session: {
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const card = await screen.findByRole("gridcell", { name: "Ada, Bestie" });
  await user.click(
    within(card).getByRole("button", { name: "Actions for Ada" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove as bestie" }),
  );
  const dialog = await screen.findByRole("alertdialog", {
    name: "Remove Ada as your Bestie?",
  });
  // Another surface makes Bea Bestie while the question is open.
  await act(() =>
    chooseDefaultAgent(
      connection.session as unknown as RelaySession,
      connection.scope,
      bea.pubkey,
    ),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Remove as Bestie" }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  expect(mainAgent.write).toHaveBeenCalledTimes(1);
  expect(mainAgent.write).toHaveBeenLastCalledWith(bea.pubkey);
  expect(screen.getByRole("gridcell", { name: "Bea, Bestie" })).toBeVisible();
});

it("keeps a failed Bestie replacement visible and retries the account save", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const bea = agent("Bea", 2);
  const view = setup([ada, bea]);
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: [
      { pubkey: ada.pubkey, name: ada.name, managed: true },
      { pubkey: bea.pubkey, name: bea.name, managed: true },
    ],
    selectable: [
      { pubkey: ada.pubkey, name: ada.name, managed: true },
      { pubkey: bea.pubkey, name: bea.name, managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const writes: Array<(failure?: Error) => void> = [];
  const mainAgent = {
    read: async () => ada.pubkey,
    write: () =>
      new Promise<void>((resolve, reject) =>
        writes.push((failure) => (failure ? reject(failure) : resolve())),
      ),
  };
  const connection = {
    status: "ready",
    scope: "bestie-retry",
    session: {
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const adaCard = await screen.findByRole("gridcell", {
    name: "Ada, Bestie",
  });
  expect(adaCard).toBeVisible();
  expect(view.container.querySelector("[data-celebrating]")).toBeNull();

  const beaCard = screen.getByRole("gridcell", { name: "Bea" });
  await user.click(
    within(beaCard).getByRole("button", { name: "Actions for Bea" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Make my bestie" }),
  );
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Bea" }),
  );
  expect(view.container.querySelector("[data-celebrating]")).toBeNull();
  await act(async () => writes[0]?.(new Error("offline")));
  expect(view.container.querySelector("[data-celebrating]")).toBeNull();
  expect(within(confirmation).getByRole("alert")).toHaveTextContent(
    "Your bestie couldn't be saved to your account. Try again.",
  );
  expect(confirmation).toBeVisible();
  expect(readView(connection.scope, "solo:default-agent", null)).toBe(
    bea.pubkey,
  );

  await user.click(
    within(confirmation).getByRole("button", { name: "Keep Ada" }),
  );
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(readView(connection.scope, "solo:default-agent", null)).toBe(
    ada.pubkey,
  );
  expect(screen.getByRole("gridcell", { name: "Ada, Bestie" })).toBeVisible();

  await user.click(
    within(screen.getByRole("gridcell", { name: "Bea" })).getByRole("button", {
      name: "Actions for Bea",
    }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Make my bestie" }),
  );
  const retry = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  expect(within(retry).queryByRole("alert")).not.toBeInTheDocument();
  await user.click(
    within(retry).getByRole("button", { name: "Switch to Bea" }),
  );
  // The saved store publishes before the local celebration callback. Force
  // that intermediate render: the new badge must not flash at full opacity.
  let checkedBeforeCelebration = false;
  const stop = onBestieMade(() => {
    flushSync(() => {});
    expect(beaCard).toBeInTheDocument();
    expect(within(beaCard).queryByText("Bestie")).toBeNull();
    checkedBeforeCelebration = true;
  });
  try {
    await act(async () => writes[1]?.());
  } finally {
    stop();
  }
  expect(checkedBeforeCelebration).toBe(true);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(
    await screen.findByRole("gridcell", { name: "Bea, Bestie" }),
  ).toBeVisible();
  const badge = view.container.querySelector("[data-celebrating]");
  expect(badge).not.toBeNull();
  const star = badge?.querySelector("svg");
  if (!star?.parentElement) throw new Error("Missing celebrating star");
  // React uses the prefixed animation event in jsdom (no AnimationEvent).
  fireEvent(star, new Event("webkitAnimationEnd", { bubbles: true }));
  expect(badge).toHaveAttribute("data-celebrating");
  fireEvent(
    star.parentElement,
    new Event("webkitAnimationEnd", { bubbles: true }),
  );
  expect(view.container.querySelector("[data-celebrating]")).toBeNull();
});

it("retries a failed replacement in the same dialog after an earlier Bestie save", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const bea = agent("Bea", 2);
  const view = setup([ada, bea]);
  const identities = [ada, bea].map(({ pubkey, name }) => ({
    pubkey,
    name,
    managed: true,
  }));
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities,
    selectable: identities,
    archives: { status: "unavailable", archived: [] },
  };
  const writes: Array<(failure?: Error) => void> = [];
  const finishWrite = (failure?: Error) => {
    const finish = writes.shift();
    if (!finish) throw new Error("Expected a pending Bestie write");
    finish(failure);
  };
  const mainAgent = {
    read: async () => ada.pubkey,
    write: vi.fn(
      (_pubkey: string) =>
        new Promise<void>((resolve, reject) => {
          writes.push((failure) => (failure ? reject(failure) : resolve()));
        }),
    ),
  };
  const connection = {
    status: "ready",
    scope: "bestie-confirmed-retry",
    session: {
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const choose = async (name: string) => {
    await user.click(
      within(await screen.findByRole("gridcell", { name })).getByRole(
        "button",
        { name: `Actions for ${name}` },
      ),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Make my bestie" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: `Make ${name} your bestie?`,
    });
    await user.click(
      within(dialog).getByRole("button", { name: `Switch to ${name}` }),
    );
    return dialog;
  };
  try {
    await screen.findByRole("gridcell", { name: "Ada, Bestie" });
    await choose("Bea");
    expect(mainAgent.write).toHaveBeenNthCalledWith(1, bea.pubkey);
    await act(async () => finishWrite());
    await screen.findByRole("gridcell", { name: "Bea, Bestie" });
    const dialog = await choose("Ada");
    expect(mainAgent.write).toHaveBeenNthCalledWith(2, ada.pubkey);
    await act(async () => finishWrite(new Error("offline")));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "couldn't be saved",
    );
    expect(
      screen.getByRole("gridcell", { name: "Bea, Bestie", hidden: true }),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Switch to Ada" }),
    );
    expect(mainAgent.write).toHaveBeenNthCalledWith(3, ada.pubkey);
    expect(dialog).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Keep Bea" }),
    ).toBeDisabled();
    await act(async () => finishWrite());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("gridcell", { name: "Ada, Bestie" }),
    ).toBeVisible();
  } finally {
    await act(async () => {
      for (const finish of writes.splice(0)) finish();
    });
  }
});

it("opens deletion from the card's right-click menu", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  fireEvent.contextMenu(screen.getByRole("gridcell", { name: "Ada" }));
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  await user.click(
    within(menu).getByRole("menuitem", { name: "Delete agent" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
  expect(agents.remove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect(agents.remove).toHaveBeenCalledWith(agent("Ada", 1).pubkey);
});

it("opens a Marketplace tile in the profile pane and returns focus on close and import", async () => {
  const user = userEvent.setup();
  const view = setup([], {
    more: [
      {
        key: "test/shared",
        id: "shared",
        title: "Shared",
        defaults: () => ({ config: {} }),
        importShared: () => ({}),
      } as unknown as RegisteredAgentType,
    ],
  });
  const owner = createRelaySession(null);
  const session = {
    ...owner.session,
    read: vi.fn().mockResolvedValue([
      {
        id: "ab".repeat(32),
        pubkey: "cd".repeat(32),
        kind: 30175,
        created_at: 1,
        tags: [
          ["d", "helper"],
          ["shared", "true"],
        ],
        content: JSON.stringify({
          display_name: "Marketplace helper",
          system_prompt: "Help with tasks.",
          model: "example-model",
        }),
      },
    ]),
  };
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay = { ...view.relay, snapshot: () => snapshot };
  try {
    view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
    await user.click(screen.getByRole("tab", { name: "Marketplace" }));
    const tile = await screen.findByRole("button", {
      name: "Marketplace helper",
    });
    await user.click(tile);
    expect(tile).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("heading", { name: "Marketplace helper" }),
    ).toBeVisible();
    expect(screen.getByText("Help with tasks.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Close Marketplace helper tab" }),
    );
    expect(tile).toHaveFocus();
    expect(
      screen.queryByRole("heading", { name: "Marketplace helper" }),
    ).not.toBeInTheDocument();
    // Importing removes the panel and its trigger, so focus follows the tab.
    await user.click(tile);
    await user.click(screen.getByRole("button", { name: "Import" }));
    const dialog = screen.getByRole("dialog", {
      name: "Marketplace helper",
    });
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("tab", { name: "Your agents" })).toHaveFocus(),
    );
    expect(view.agents.port).toHaveBeenCalledWith(
      expect.objectContaining({ type: "test/shared", config: {} }),
    );
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("offers Make my bestie on a stand-in for a missing chosen agent", async () => {
  const ada = agent("Ada", 1);
  const view = setup([ada]);
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: [{ pubkey: ada.pubkey, name: ada.name, managed: true }],
    selectable: [{ pubkey: ada.pubkey, name: ada.name, managed: true }],
    archives: { status: "unavailable", archived: [] },
  };
  const connection = {
    status: "ready",
    scope: "stand-in",
    session: {
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  // The chosen agent isn't among the choices, and wasn't deleted.
  act(() => {
    setDefaultAgent("stand-in", "d".repeat(64));
  });
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const card = screen.getByRole("gridcell", { name: "Ada" });
  fireEvent.contextMenu(card);
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Make my bestie" }),
  );
  await screen.findByRole("gridcell", { name: "Ada, Bestie" });
  fireEvent.contextMenu(screen.getByRole("gridcell", { name: "Ada, Bestie" }));
  expect(
    within(
      await screen.findByRole("menu", { name: "Actions for Ada" }),
    ).queryByRole("menuitem", { name: "Make my bestie" }),
  ).toBeNull();
});

it("restores scoped card order without menu reorder actions or remounting neighbours", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const bo = agent("Bo", 2);
  const nova = agent("Nova", 3);
  const scope = "https://relay.example:owner";
  const view = setup([ada, bo], { scope });
  const order = () =>
    screen
      .getAllByRole("gridcell")
      .map((card) => card.getAttribute("aria-label"));
  await user.click(screen.getByRole("button", { name: "Actions for Ada" }));
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  expect(
    within(menu).queryByRole("menuitem", { name: "Move earlier" }),
  ).toBeNull();
  expect(
    within(menu).queryByRole("menuitem", { name: "Move later" }),
  ).toBeNull();
  act(() => view.show([ada, bo, nova]));
  expect(menu).toBeInTheDocument();
  await user.keyboard("{Escape}");
  act(() => writeView(scope, "agents:order", [bo.pubkey, ada.pubkey]));
  expect(order()).toEqual(["Bo", "Ada", "Nova"]);
  await user.click(screen.getByRole("gridcell", { name: "Bo" }));
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("gridcell", { name: "Ada" })).toHaveFocus();
  view.unmount();
  const restored = setup([ada, bo, nova, agent("New", 4)], { scope });
  expect(order()).toEqual(["Bo", "Ada", "Nova", "New"]);
  restored.unmount();
  setup([ada, bo], { scope: "https://other.example:owner" });
  expect(order()).toEqual(["Ada", "Bo"]);
});

it("offers to save an automatic bestie to the account, and again after a failed save", async () => {
  const ada = agent("Ada", 1);
  const bea = agent("Bea", 2);
  const view = setup([ada, bea]);
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: [
      { pubkey: ada.pubkey, name: ada.name, managed: true },
      { pubkey: bea.pubkey, name: bea.name, managed: true },
    ],
    selectable: [
      { pubkey: ada.pubkey, name: ada.name, managed: true },
      { pubkey: bea.pubkey, name: bea.name, managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const writes: Array<(failure?: Error) => void> = [];
  const mainAgent = {
    read: async () => undefined,
    write: () =>
      new Promise<void>((resolve, reject) =>
        writes.push((failure) => (failure ? reject(failure) : resolve())),
      ),
  };
  const connection = {
    status: "ready",
    scope: "account-save",
    session: {
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const make = async (name: string) => {
    fireEvent.contextMenu(
      await screen.findByRole("gridcell", { name: new RegExp(`^${name}`) }),
    );
    const menu = await screen.findByRole("menu", {
      name: `Actions for ${name}`,
    });
    return within(menu).queryByRole("menuitem", { name: "Make my bestie" });
  };
  // Picked automatically, so it is not labelled Bestie until saved.
  await screen.findByRole("gridcell", { name: "Ada" });
  fireEvent.click((await make("Ada")) as HTMLElement);
  await act(async () => writes[0]?.(new Error("offline")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your bestie couldn't be saved to your account. Try again.",
  );
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  // A failed save can be tried again; a newer choice hides an older failure.
  fireEvent.click((await make("Ada")) as HTMLElement);
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  fireEvent.click((await make("Bea")) as HTMLElement);
  await act(async () => writes[2]?.());
  await act(async () => writes[1]?.(new Error("offline")));
  expect(screen.queryByRole("alert")).toBeNull();
  await screen.findByRole("gridcell", { name: "Bea, Bestie" });
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  expect(await make("Bea")).toBeNull();
});

it("opens a restored version address in Settings, closes on Back, and retires only that scoped version on Close", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const bea = agent("Bea", 2);
  const revision = {
    id: "a".repeat(64),
    pubkey: ada.pubkey,
    sig: "b".repeat(128),
    kind: 45010,
    created_at: 1700000000,
    content: JSON.stringify({ version: 1, text: "Help." }),
    tags: [
      ["ar", "1"],
      ["h", "c"],
      ["d", "instructions"],
      ["type", "buzz.agent.instructions"],
      ["op", "create"],
    ],
  };
  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
    route: { version: 1, params: { agent: ada.pubkey, revision: "" } },
  } as const;
  const opened = {
    ...base,
    route: {
      version: 1,
      params: { agent: ada.pubkey, revision: `instructions/${revision.id}` },
    },
  } as const;
  let current: { id: string; target: OpenTarget } = {
    id: "version",
    target: opened,
  };
  const dismiss = vi.fn();
  const navigator = {
    snapshot: () => ({ entry: current }),
    open: vi.fn(),
    dismiss,
  } as unknown as Navigation;
  const request = (): PageNavigation => {
    const navigation = {
      entryId: current.id,
      target: current.target,
      signal: new AbortController().signal,
      position: () => undefined,
      savePosition() {},
      passThrough: () => () => {},
      forSession: () => navigation,
      resolve: () => true,
      complete: () => true,
    };
    return navigation;
  };
  const view = setup([ada, bea]);
  const read = vi.fn(async () => [revision]);
  const revise = vi.fn();
  Object.assign(view.agents, {
    configHistory: () => ({
      read,
      revise,
      sides: [
        {
          side: "instructions",
          expected: {
            channel: "c",
            d: "instructions",
            type: "buzz.agent.instructions",
          },
          head: revision,
        },
      ],
    }),
  });
  const page = () => (
    <AgentsPage
      agents={view.agents}
      relay={view.relay}
      navigation={request()}
      navigator={navigator}
    />
  );
  view.rerender(page());
  expect(
    await screen.findByRole("heading", {
      name: "Instructions version Current",
    }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Revert to this" })).toBeNull();
  current = { id: "base", target: base };
  view.rerender(page());
  expect(
    screen.queryByRole("dialog", { name: "Instructions version Current" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Previous versions" }),
  ).toHaveAttribute("aria-expanded", "true");
  current = { id: "version", target: opened };
  view.rerender(page());
  expect(
    await screen.findByRole("dialog", { name: "Instructions version Current" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Close" }));
  const [matches, fallback] = dismiss.mock.calls[0] as unknown as [
    (target: OpenTarget) => boolean,
    OpenTarget,
  ];
  expect(fallback).toEqual(base);
  expect(matches(opened)).toBe(true);
  expect(matches(base)).toBe(false);
  expect(
    matches({
      ...opened,
      scope: {
        viewer: "f".repeat(64),
        communityOrigin: "https://elsewhere.example",
      },
    }),
  ).toBe(false);
  expect(revise).not.toHaveBeenCalled();
  current = { id: "base", target: base };
  view.rerender(page());
  await user.click(
    within(screen.getByRole("grid", { name: "Agents" })).getByText("Bea"),
  );
  expect(screen.getByRole("heading", { name: "Bea" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Reply" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(
    screen.getByRole("button", { name: "Previous versions" }),
  ).toHaveAttribute("aria-expanded", "false");
});

it("opens a team's version link in its editor", async () => {
  const id = "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d";
  const revision = {
    id: "a".repeat(64),
    pubkey: "o".repeat(64),
    sig: "b".repeat(128),
    kind: 45010,
    created_at: 1700000000,
    content: JSON.stringify({ version: 1, name: "Crew", instructions: "Hi." }),
    tags: [
      ["h", "c"],
      ["d", "team"],
      ["type", "buzz.team"],
      ["op", "create"],
      ["team", id],
    ],
  };
  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
    route: { version: 1, params: { team: id, revision: "" } },
  } as const;
  const opened = {
    ...base,
    route: {
      version: 1,
      params: { team: id, revision: `instructions/${revision.id}` },
    },
  } as const;
  const navigator = {
    snapshot: () => ({ entry: { id: "version", target: opened } }),
    open: vi.fn(),
    dismiss: vi.fn(),
  } as unknown as Navigation;
  const navigation = {
    entryId: "version",
    target: opened,
    signal: new AbortController().signal,
    position: () => undefined,
    savePosition() {},
    passThrough: () => () => {},
    forSession: () => navigation,
    resolve: () => true,
    complete: () => true,
  } as unknown as PageNavigation;
  const view = setup([], {
    teams: [
      {
        id,
        name: "Crew",
        instructions: "Hi.",
        members: [],
        revision: revision.id,
      },
    ],
    page: { navigation, navigator },
  });
  Object.assign(view.agents, {
    teamHistory: (team: string) =>
      team === id
        ? {
            read: vi.fn(async () => [revision]),
            revise: vi.fn(),
            sides: [
              {
                side: "instructions",
                expected: {
                  channel: "c",
                  d: "team",
                  type: "buzz.team",
                  team: id,
                },
                head: revision,
                version: 0,
              },
            ],
          }
        : undefined,
  });
  view.rerender(
    <AgentsPage
      agents={view.agents}
      relay={view.relay}
      navigation={navigation}
      navigator={navigator}
    />,
  );
  expect(
    await screen.findByRole("dialog", { name: "Instructions version Current" }),
  ).toBeVisible();
  expect(
    screen.getByRole("form", { name: "Edit Crew", hidden: true }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Previous versions", hidden: true }),
  ).toHaveAttribute("aria-expanded", "true");
});

it("opens Create agent from an agent card's link and retires the link's visits when it closes", async () => {
  const user = userEvent.setup();
  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const routed = {
    ...base,
    route: { version: 1, params: { card: "tinker" } },
  } as const;
  const dismiss = vi.fn();
  const navigator = {
    snapshot: () => ({ entry: { id: "card", target: routed } }),
    open: vi.fn(),
    dismiss,
  } as unknown as Navigation;
  const navigation: PageNavigation = {
    entryId: "card",
    target: routed,
    signal: new AbortController().signal,
    focus: "content",
    position: () => undefined,
    savePosition() {},
    passThrough: () => () => {},
    forSession: () => navigation,
    resolve: () => true,
    complete: () => true,
  };
  const fetch = vi.fn(async () =>
    Response.json({
      id: "tinker",
      name: "Tinker",
      avatarUrl: "https://cdn.example/tinker/avatar.png",
      instructions: "You are Tinker.",
    }),
  );
  vi.stubGlobal("fetch", fetch);
  try {
    const { agents } = setup([agent("Ada", 1)], {
      page: { navigator, navigation },
    });
    const dialog = await screen.findByRole("dialog", { name: "Create agent" });
    expect(fetch).toHaveBeenCalledWith(
      "https://d2z0pbxrxbsiz5.cloudfront.net/tinker/agent.json",
      expect.anything(),
    );
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Tinker");
    await user.click(
      within(dialog).getByRole("button", { name: "Create agent" }),
    );
    expect(agents.create).toHaveBeenCalledWith({
      type: "test/echo",
      name: "Tinker",
      picture: "https://cdn.example/tinker/avatar.png",
      config: { reply: "" },
    });
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
    const [matches, fallback] = dismiss.mock.calls[0] as unknown as [
      (target: OpenTarget) => boolean,
      OpenTarget,
    ];
    expect(fallback).toEqual(base);
    expect(matches(routed)).toBe(true);
    expect(matches(base)).toBe(false);
    expect(
      matches({ ...routed, route: { version: 1, params: { card: "occam" } } }),
    ).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("explains an agent card that can't be loaded, and retries it", async () => {
  const user = userEvent.setup();
  const routed = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
    route: { version: 1, params: { card: "gone" } },
  } as const;
  const dismiss = vi.fn();
  const navigator = {
    snapshot: () => ({ entry: { id: "card", target: routed } }),
    open: vi.fn(),
    dismiss,
  } as unknown as Navigation;
  const navigation: PageNavigation = {
    entryId: "card",
    target: routed,
    signal: new AbortController().signal,
    focus: "content",
    position: () => undefined,
    savePosition() {},
    passThrough: () => () => {},
    forSession: () => navigation,
    resolve: () => true,
    complete: () => true,
  };
  const fetch = vi.fn(async () => new Response("", { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  try {
    setup([agent("Ada", 1)], { page: { navigator, navigation } });
    const dialog = await screen.findByRole("dialog", { name: "Agent card" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This agent card isn’t available.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await user.click(
      await within(dialog).findByRole("button", { name: "Close" }),
    );
    expect(dismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Create agent" })).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("team editor visits", () => {
  const id = "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d";
  const page = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const visit = {
    ...page,
    route: { version: 1, params: { team: id } },
  } as const;
  const crew = (revision: string, instructions: string) => ({
    id,
    name: "Crew",
    instructions,
    members: [agent("Ada", 1).pubkey],
    revision,
  });
  function at(target: OpenTarget, entryId: string) {
    const navigator = {
      snapshot: () => ({ entry: { id: entryId, target } }),
      open: vi.fn(),
      dismiss: vi.fn(),
    } as unknown as Navigation;
    const navigation = {
      entryId,
      target,
      signal: new AbortController().signal,
      position: () => undefined,
      savePosition() {},
      passThrough: () => () => {},
      forSession: () => navigation,
      resolve: () => true,
      complete: () => true,
    } as unknown as PageNavigation;
    return { navigation, navigator };
  }

  it("opens a team card as a visit that Back and Forward leave and return to", async () => {
    const user = userEvent.setup();
    const start = at(page, "page");
    const view = setup([agent("Ada", 1)], {
      teams: [crew("r1", "Hi.")],
      page: start,
    });
    await user.click(screen.getByRole("tab", { name: "Your teams" }));
    await user.click(
      within(screen.getByRole("list", { name: "Teams" })).getByRole("button", {
        name: "Crew",
      }),
    );
    expect(start.navigator.open).toHaveBeenCalledWith(visit);
    expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull();
    const show = (where: ReturnType<typeof at>) =>
      view.rerender(
        <AgentsPage agents={view.agents} relay={view.relay} {...where} />,
      );
    show(at(visit, "team"));
    expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
    show(at(page, "page"));
    expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull();
    show(at(visit, "team"));
    expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
  });

  it("ends the team's visit when its editor closes", async () => {
    const user = userEvent.setup();
    const where = at(visit, "team");
    setup([agent("Ada", 1)], { teams: [crew("r1", "Hi.")], page: where });
    await user.click(
      within(screen.getByRole("form", { name: "Edit Crew" })).getByRole(
        "button",
        { name: "Close" },
      ),
    );
    expect(where.navigator.dismiss).toHaveBeenCalledOnce();
    const [matches, fallback] = vi.mocked(where.navigator.dismiss).mock
      .calls[0] as unknown as [(target: OpenTarget) => boolean, OpenTarget];
    expect(fallback).toEqual(page);
    expect(matches(visit)).toBe(true);
    expect(
      matches({
        ...page,
        route: {
          version: 1,
          params: { team: id, revision: `instructions/${"a".repeat(64)}` },
        },
      }),
    ).toBe(true);
    expect(matches(page)).toBe(false);
  });

  const ada = agent("Ada", 1).pubkey;
  const bo = agent("Bo", 2).pubkey;
  /** Edits the open team, lets `elsewhere` save over it, reverts its
   * instructions to "Before." as `reverted`, then saves. */
  async function revert({
    edit,
    elsewhere,
    reverted,
  }: {
    edit(user: ReturnType<typeof userEvent.setup>): Promise<void>;
    elsewhere?: ReturnType<typeof crew>;
    reverted: ReturnType<typeof crew>;
  }) {
    const user = userEvent.setup();
    const revision = (n: number, text: string) => ({
      id: `${n}`.repeat(64),
      pubkey: "o".repeat(64),
      sig: "b".repeat(128),
      kind: 45010,
      created_at: 1700000000 + n,
      content: JSON.stringify({ version: 1, name: "Crew", instructions: text }),
      tags: [
        ["ar", "1"],
        ["h", "c"],
        ["d", "team"],
        ["type", "buzz.team"],
        ["title", "Crew"],
        ["op", n ? "update" : "create"],
        ["team", id],
        ...(n ? [["prev", "0".repeat(64)]] : []),
      ],
    });
    const [now, before] = [revision(1, "Now."), revision(0, "Before.")];
    const view = setup([agent("Ada", 1), agent("Bo", 2)], {
      teams: [crew(now.id, "Now.")],
      page: at(visit, "team"),
    });
    Object.assign(view.agents, {
      teamHistory: () => ({
        read: vi.fn(async () => [now, before]),
        revise: vi.fn(async () => {
          view.change({ teams: [reverted] });
          return { status: "accepted" };
        }),
        sides: [
          {
            side: "instructions",
            expected: { channel: "c", d: "team", type: "buzz.team", team: id },
            head: now,
            version: 0,
          },
        ],
      }),
    });
    view.change({});
    await edit(user);
    if (elsewhere) view.change({ teams: [elsewhere] });
    const older = {
      ...page,
      route: {
        version: 1,
        params: { team: id, revision: `instructions/${before.id}` },
      },
    } as const;
    view.rerender(
      <AgentsPage
        agents={view.agents}
        relay={view.relay}
        {...at(older, "version")}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Revert to this" }),
    );
    await vi.waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Instructions", hidden: true }),
      ).toHaveValue("Before."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save", hidden: true }));
    await vi.waitFor(() => expect(view.agents.saveTeam).toHaveBeenCalled());
    return vi.mocked(view.agents.saveTeam).mock.calls[0]?.[0];
  }
  const rename = async (user: ReturnType<typeof userEvent.setup>) => {
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Night crew");
  };

  it("takes a revert's instructions and version but keeps the other edits", async () => {
    const saved = await revert({
      edit: async (user) => {
        await rename(user);
        await user.click(screen.getByRole("checkbox", { name: "Bo" }));
      },
      reverted: crew("2".repeat(64), "Before."),
    });
    expect(saved).toMatchObject({
      opened: { revision: "2".repeat(64) },
      name: "Night crew",
      instructions: "Before.",
      members: [ada, bo],
    });
  });

  it("takes another device's rename and new member with a revert", async () => {
    const renamed = {
      ...crew("2".repeat(64), "Now."),
      name: "Day crew",
      members: [ada, bo],
    };
    const saved = await revert({
      edit: async () => {},
      elsewhere: renamed,
      reverted: {
        ...renamed,
        revision: "3".repeat(64),
        instructions: "Before.",
      },
    });
    expect(saved).toMatchObject({
      opened: { revision: "3".repeat(64) },
      name: "Day crew",
      instructions: "Before.",
      members: [ada, bo],
    });
  });

  it("keeps an edit over another device's rename a conflict after a revert", async () => {
    const renamed = { ...crew("2".repeat(64), "Now."), name: "Day crew" };
    const saved = await revert({
      edit: rename,
      elsewhere: renamed,
      reverted: {
        ...renamed,
        revision: "3".repeat(64),
        instructions: "Before.",
      },
    });
    expect(saved).toMatchObject({
      opened: { revision: "1".repeat(64) },
      name: "Night crew",
    });
  });

  it("leaves an editor with unsaved edits open on Back", async () => {
    const view = setup([agent("Ada", 1)], {
      teams: [crew("r1", "Hi.")],
      page: at(visit, "team"),
    });
    await rename(userEvent.setup());
    const show = (where: ReturnType<typeof at>) =>
      view.rerender(
        <AgentsPage agents={view.agents} relay={view.relay} {...where} />,
      );
    show(at(page, "page"));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Night crew",
    );
    const agentVisit = {
      ...page,
      route: { version: 1, params: { agent: agent("Ada", 1).pubkey } },
    } as const;
    show(at(agentVisit, "agent"));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Night crew",
    );
    show(at(visit, "team"));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Night crew",
    );
  });

  describe("between two teams", () => {
    const other = "2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182";
    const second = {
      ...crew("s1", "There."),
      id: other,
      name: "Second",
    };
    const otherVisit = {
      ...page,
      route: { version: 1, params: { team: other } },
    } as const;
    const open = (options: Parameters<typeof setup>[1] = {}) => {
      const view = setup([agent("Ada", 1)], {
        teams: [crew("r1", "Hi."), second],
        page: at(otherVisit, "second"),
        ...options,
      });
      const show = (where: ReturnType<typeof at>) => {
        view.rerender(
          <AgentsPage agents={view.agents} relay={view.relay} {...where} />,
        );
        return where;
      };
      return { view, show };
    };

    it("keeps a dirty editor open on Back to another team, and Forward finds it", async () => {
      const user = userEvent.setup();
      const { show } = open();
      const name = screen.getByRole("textbox", { name: "Name" });
      await user.clear(name);
      await user.type(name, "Unsaved Second");
      show(at(visit, "team"));
      expect(screen.getByRole("form", { name: "Edit Second" })).toBeVisible();
      show(at(otherVisit, "second"));
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Unsaved Second",
      );
    });

    it("keeps an editor whose Save runs, then dismisses its own visits", async () => {
      const user = userEvent.setup();
      const { view, show } = open();
      let finish = () => {};
      vi.mocked(view.agents.saveTeam).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ ...second, revision: "s2" });
          }),
      );
      await user.click(screen.getByRole("button", { name: "Save" }));
      const first = show(at(visit, "team"));
      expect(screen.getByRole("form", { name: "Edit Second" })).toBeVisible();
      finish();
      await vi.waitFor(() =>
        expect(screen.getByRole("form", { name: "Edit Crew" })).toBeVisible(),
      );
      const ended = vi.mocked(first.navigator.dismiss).mock.calls[0]?.[0] as (
        visit: OpenTarget,
      ) => boolean;
      expect(ended(otherVisit)).toBe(true);
      expect(ended(visit)).toBe(false);
    });

    it("keeps an editor whose Save was refused", async () => {
      const user = userEvent.setup();
      const { view, show } = open();
      vi.mocked(view.agents.saveTeam).mockRejectedValueOnce(
        new Error("Refused"),
      );
      const name = screen.getByRole("textbox", { name: "Name" });
      await user.type(name, "!");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Refused");
      show(at(visit, "team"));
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Second!",
      );
    });
  });

  it("asks before a team's visit discards an agent's unsaved settings", async () => {
    const user = userEvent.setup();
    const ada = agent("Ada", 1);
    const agentVisit = {
      ...page,
      route: { version: 1, params: { agent: ada.pubkey } },
    } as const;
    const view = setup([ada], {
      dirtySettings: true,
      teams: [crew("r1", "Hi.")],
      page: at(agentVisit, "agent"),
    });
    const show = (where: ReturnType<typeof at>) =>
      view.rerender(
        <AgentsPage agents={view.agents} relay={view.relay} {...where} />,
      );
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "!");
    show(at(visit, "team"));
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Discard changes?" }),
      ).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull();
    show(at(agentVisit, "agent-again"));
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(
      "Ada says hi!",
    );
    show(at(visit, "team-again"));
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Discard changes?" }),
      ).getByRole("button", { name: "Discard changes" }),
    );
    expect(screen.getByRole("form", { name: "Edit Crew" })).toBeVisible();
  });

  it("opens the routed team's card after Keep editing, with no new visit", async () => {
    const user = userEvent.setup();
    const ada = agent("Ada", 1);
    const agentVisit = {
      ...page,
      route: { version: 1, params: { agent: ada.pubkey } },
    } as const;
    const view = setup([ada], {
      dirtySettings: true,
      teams: [crew("r1", "Hi.")],
      page: at(agentVisit, "agent"),
    });
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "!");
    const where = at(visit, "team");
    view.rerender(
      <AgentsPage agents={view.agents} relay={view.relay} {...where} />,
    );
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Discard changes?" }),
      ).getByRole("button", { name: "Keep editing" }),
    );
    await user.click(screen.getByRole("tab", { name: "Your teams" }));
    await user.click(
      within(screen.getByRole("list", { name: "Teams" })).getByRole("button", {
        name: "Crew",
      }),
    );
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Discard changes?" }),
      ).getByRole("button", { name: "Discard changes" }),
    );
    expect(screen.getByRole("form", { name: "Edit Crew" })).toBeVisible();
    expect(where.navigator.open).not.toHaveBeenCalled();
  });

  it("leaves an editor open on Back while its Save runs, then closes it", async () => {
    const user = userEvent.setup();
    const view = setup([agent("Ada", 1)], {
      teams: [crew("r1", "Hi.")],
      page: at(visit, "team"),
    });
    let finish = () => {};
    vi.mocked(view.agents.saveTeam).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(crew("r2", "Hi."));
        }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    view.rerender(
      <AgentsPage
        agents={view.agents}
        relay={view.relay}
        {...at(page, "page")}
      />,
    );
    expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
    view.rerender(
      <AgentsPage
        agents={view.agents}
        relay={view.relay}
        {...at(
          {
            ...page,
            route: { version: 1, params: { agent: agent("Ada", 1).pubkey } },
          },
          "agent",
        )}
      />,
    );
    expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
    expect(view.agents.saveTeam).toHaveBeenCalled();
    finish();
    await vi.waitFor(() =>
      expect(screen.queryByRole("form", { name: "Edit Crew" })).toBeNull(),
    );
  });
});

it("leaves the next team's draft alone when a closed editor's Save finishes", async () => {
  const A = {
    id: "1a2b3c4d-5e6f-4a70-8b9c-0d1e2f3a4b5c",
    name: "Crew A",
    instructions: "A",
    members: [agent("Ada", 1).pubkey],
    revision: "rA",
  };
  const B = {
    ...A,
    id: "2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182",
    name: "Crew B",
    instructions: "B",
    revision: "rB",
  };
  const C = {
    ...A,
    id: "3b3c4d5e-6f70-4a81-9b2c-3d4e5f607182",
    name: "Crew C",
    instructions: "C",
    revision: "rC",
  };
  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const host = createNavigationController(createMemoryHistory(base));
  const navigator = host.navigation;
  function Host({ agents, relay }: { agents: Agents; relay: RelayData }) {
    const { entry, attempt } = useSyncExternalStore(
      navigator.subscribe,
      navigator.snapshot,
    );
    const navigation = useMemo(() => {
      const request: PageNavigation = {
        entryId: entry.id,
        target: entry.target,
        signal: attempt.signal,
        position: () => undefined,
        savePosition() {},
        passThrough: () => () => {},
        forSession: () => request,
        resolve: () => true,
        complete: () => true,
      };
      return request;
    }, [entry, attempt]);
    useEffect(() => {
      host.complete(attempt, { status: "opened" });
    }, [attempt]);
    return (
      <AgentsPage
        agents={agents}
        relay={relay}
        navigator={navigator}
        navigation={navigation}
      />
    );
  }
  const view = setup([agent("Ada", 1)], { teams: [A, B, C] });
  let finish!: () => void;
  const pending = new Promise<typeof B>((resolve) => {
    finish = () => resolve(B);
  });
  vi.mocked(view.agents.saveTeam).mockReturnValueOnce(pending);
  try {
    view.rerender(<Host agents={view.agents} relay={view.relay} />);
    act(() => {
      void navigator.open({
        ...base,
        route: { version: 1, params: { team: A.id } },
      });
    });
    await screen.findByRole("form", { name: "Edit Crew A" });
    act(() => {
      void navigator.open({
        ...base,
        route: { version: 1, params: { team: B.id } },
      });
    });
    await userEvent
      .setup()
      .click(
        within(
          await screen.findByRole("form", { name: "Edit Crew B" }),
        ).getByRole("button", { name: "Save" }),
      );
    expect(view.agents.saveTeam).toHaveBeenCalledOnce();
    act(() => navigator.back());
    await userEvent
      .setup()
      .click(
        within(screen.getByRole("form", { name: "Edit Crew B" })).getByRole(
          "button",
          { name: "Close" },
        ),
      );
    const name = within(
      await screen.findByRole("form", { name: "Edit Crew A" }),
    ).getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved A" } });
    act(() => {
      void navigator.open({
        ...base,
        route: { version: 1, params: { team: C.id } },
      });
    });
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Unsaved A",
    );
    await act(async () => finish());
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Unsaved A",
    );
  } finally {
    finish();
    view.unmount();
    host.dispose();
  }
});

describe("a team Save that finishes after its editor is gone", () => {
  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const B = {
    id: "2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182",
    name: "Crew B",
    instructions: "Before",
    members: [agent("Ada", 1).pubkey],
    revision: "rB",
  };
  const visit = {
    ...base,
    route: { version: 1, params: { team: B.id } },
  } as const;
  async function fixture({
    save = true,
    refresh = true,
    nativeHistory = false,
  } = {}) {
    const host = createNavigationController(createMemoryHistory(base));
    // Browser history applies a dismissal on a later task, after Save's
    // completion has run.
    const navigator: typeof host.navigation = nativeHistory
      ? {
          ...host.navigation,
          dismiss: (...args) => {
            setTimeout(() => host.navigation.dismiss(...args));
          },
        }
      : host.navigation;
    const view = setup([agent("Ada", 1)], { teams: [B] });
    function Host() {
      const { entry, attempt } = useSyncExternalStore(
        navigator.subscribe,
        navigator.snapshot,
      );
      const navigation = useMemo(() => {
        const request: PageNavigation = {
          entryId: entry.id,
          target: entry.target,
          signal: attempt.signal,
          position: () => undefined,
          savePosition() {},
          passThrough: () => () => {},
          forSession: () => request,
          resolve: () => true,
          complete: () => true,
        };
        return request;
      }, [entry, attempt]);
      useEffect(() => {
        host.complete(attempt, { status: "opened" });
      }, [attempt]);
      // App/PageView swaps the page subtree when the registered page changes.
      return entry.target.kind === "page" &&
        entry.target.pluginId === "buzz.agents" ? (
        <AgentsPage
          agents={view.agents}
          relay={view.relay}
          navigator={navigator}
          navigation={navigation}
        />
      ) : (
        <p>Other page</p>
      );
    }
    let resolve!: () => void, reject!: () => void;
    const pending = new Promise<typeof B>((r, j) => {
      resolve = () => {
        if (refresh)
          view.change({
            teams: [
              { ...B, instructions: "Submitted draft", revision: "rSaved" },
            ],
          });
        r(B);
      };
      reject = () => j(new Error("Late refusal"));
    });
    vi.mocked(view.agents.saveTeam).mockReturnValueOnce(pending);
    view.rerender(<Host />);
    act(() => {
      void navigator.open(visit);
    });
    const form = await screen.findByRole("form", { name: "Edit Crew B" });
    fireEvent.change(
      within(form).getByRole("textbox", { name: "Instructions" }),
      { target: { value: "Submitted draft" } },
    );
    if (save) {
      await userEvent
        .setup()
        .click(within(form).getByRole("button", { name: "Save" }));
      expect(view.agents.saveTeam).toHaveBeenCalledOnce();
    }
    const visitId = navigator.snapshot().entry.id;
    return {
      view,
      host,
      navigator,
      resolve,
      reject,
      visitId,
      dispose() {
        view.unmount();
        host.dispose();
      },
    };
  }
  it("closes the dirty editor and ends its visit on Close", async () => {
    const f = await fixture({ save: false });
    try {
      const user = userEvent.setup();
      await user.click(
        within(screen.getByRole("form", { name: "Edit Crew B" })).getByRole(
          "button",
          { name: "Close" },
        ),
      );
      // Its unsaved draft is asked about first, and the visit stays with it.
      const asked = await screen.findByRole("alertdialog", {
        name: "Discard changes?",
      });
      expect(f.navigator.snapshot().entry.target).toEqual(visit);
      await user.click(
        within(asked).getByRole("button", { name: "Discard changes" }),
      );
      expect(screen.queryByRole("form", { name: "Edit Crew B" })).toBeNull();
      expect(f.navigator.snapshot().entry.target).toEqual(base);
    } finally {
      f.dispose();
    }
  });

  it("closes the editor once its Save succeeds, before the saved team arrives", async () => {
    const f = await fixture({ refresh: false, nativeHistory: true });
    try {
      await act(async () => f.resolve());
      // The dismissal lands on a later task; wait for it, then check the form.
      await waitFor(() =>
        expect(f.navigator.snapshot().entry.target).toEqual(base),
      );
      expect(screen.queryByRole("form", { name: "Edit Crew B" })).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it("ends B's visits after leaving the Agents page entirely", async () => {
    const f = await fixture();
    try {
      act(() => {
        void f.navigator.open({
          version: 1,
          kind: "page",
          pluginId: "test.other",
          pageId: "other",
        });
      });
      expect(screen.getByText("Other page")).toBeVisible();
      await act(async () => f.resolve());
      const retained = f.navigator
        .snapshot()
        .retainedVisits?.includes(f.visitId);
      act(() => f.navigator.back());
      const reopened = !!screen.queryByRole("form", { name: "Edit Crew B" });
      expect(reopened, "Back must skip B's completed presentation").toBe(false);
      expect(retained).toBe(false);
    } finally {
      f.dispose();
    }
  });
  it("ends B's visits if B disappears while Save runs", async () => {
    const f = await fixture();
    try {
      act(() => f.view.change({ teams: [] }));
      expect(screen.queryByRole("form", { name: "Edit Crew B" })).toBeNull();
      await act(async () => f.resolve());
      expect(f.navigator.snapshot().retainedVisits).not.toContain(f.visitId);
    } finally {
      f.dispose();
    }
  });
  it("ends B's visits after switching the internal section", async () => {
    const f = await fixture();
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("tab", { name: "Your agents" }));
      expect(screen.queryByRole("form", { name: "Edit Crew B" })).toBeNull();
      await act(async () => f.resolve());
      expect(f.navigator.snapshot().retainedVisits).not.toContain(f.visitId);
    } finally {
      f.dispose();
    }
  });
});
