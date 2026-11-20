import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { RelayEvent } from "../../src/features/relay/events";
import {
  AgentConfigStore,
  syncedSettings,
} from "../../src/features/agents/agent-config";
import {
  artifactTemplate,
  type SnapshotRead,
} from "../../src/features/agents/agent-config-artifacts";
import { localStore } from "../../src/features/agents/store";
import { createConfigWriter } from "../../src/features/agents/config-writes";
import { createAppearance } from "../../src/shared/theme/service";
import { ClaudeLogoIcon } from "../../src/shared/design-system/icons";
import { agentAvatars } from "../../src/features/agents/avatar-packs";
import { createRoot } from "react-dom/client";
import { useId, useState } from "react";
import { AgentSaveButton } from "../../src/features/agents/AgentSaveButton";
import { CreationReview } from "../../src/bundled/agents/CreationReview";
import { UpdateReview } from "../../src/bundled/agents/UpdateReview";
import { AgentsPage } from "../../src/bundled/agents/AgentsPage";
import { AgentDetails } from "../../src/bundled/agents/AgentDetails";
import { createAgentMemories } from "../../src/features/agents/memory";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  AgentCreationRequest,
  AgentUpdateRequest,
  NewAgent,
  AgentViewProps,
} from "../../src/features/agents/service";
import type { RelayData } from "../../src/features/relay/service";
import { AgentInstructions } from "../../src/features/agents/AgentInstructions";
import { CreateModelChoices } from "../../src/features/agents/CreateModelChoices";
import { ModelPicker } from "../../src/features/agents/ModelPicker";
import { createTabs as createClaudeTabs } from "../../src/bundled/claude-code/tabs";
import { DEFAULT_CONFIG as claudeDefaults } from "../../src/bundled/claude-code/runtime";
import { createTabs as createCodexTabs } from "../../src/bundled/codex/tabs";
import { defaults as codexDefaults } from "../../src/bundled/codex/config";
import "../../src/shared/styles/globals.css";

const harness = new URLSearchParams(location.search).get("harness");
const settingsSync = new URLSearchParams(location.search).has("settingsSync");
const thinkingHarness = settingsSync
  ? new URLSearchParams(location.search).get("settingsSync") || "claude"
  : new URLSearchParams(location.search).get("thinking");
const importing = new URLSearchParams(location.search).has("import");
const teamImport = new URLSearchParams(location.search).has("teamImport");
if (importing || teamImport) createAppearance();
const importTargets: { pubkey: string; type: string }[] = [];
Object.assign(window, { importTargets });

const inheritedModel = new URLSearchParams(location.search).get(
  "inheritedModel",
);
const saveFooter = new URLSearchParams(location.search).has("saveFooter");
const instructions = new URLSearchParams(location.search).get("instructions");
const memoryLabel = new URLSearchParams(location.search).get("memoryLabel");

function Settings({
  agent,
  save,
  settingsContent,
  settingsSection,
}: AgentViewProps<{ instructions?: string }>) {
  const form = useId();
  const saved = agent.config.instructions ?? "";
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  return (
    <form
      id={form}
      className="grid gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await save({ instructions: draft });
        } finally {
          setSaving(false);
        }
      }}
    >
      <p>
        {"These settings apply when the agent starts its next turn. ".repeat(
          40,
        )}
      </p>
      <AgentInstructions value={draft} onChange={setDraft} />
      {settingsSection === "runtime" && settingsContent}
      <AgentSaveButton form={form} saving={saving} disabled={draft === saved} />
    </form>
  );
}

const type: RegisteredAgentType = {
  key: "fixture/agent",
  pluginId: "fixture",
  revision: "1",
  id: "agent",
  title: "Fixture",
  description: "Fixture agent",
  defaults: () => ({ config: {} }),
  ...(saveFooter || new URLSearchParams(location.search).has("settingsRecovery")
    ? {
        tabs: [
          {
            id: "settings",
            title: "Settings",
            role: "settings" as const,
            splitSettings: new URLSearchParams(location.search).has(
              "settingsRecovery",
            ),
            component: Settings,
          },
        ],
      }
    : {}),
  adopt: ({ instructions }, config) => ({
    ...(config as object),
    instructions,
  }),
  Create: ({ config, disabled, onChange }) => (
    <AgentInstructions
      value={(config as { instructions?: string }).instructions ?? ""}
      disabled={disabled}
      onChange={(instructions) =>
        onChange({ ...(config as object), instructions })
      }
      creation
    />
  ),
  CreateModel: ({ disabled, modelAppearance }) =>
    inheritedModel !== null ? (
      <ModelPicker
        compact
        groupByFamily
        appearance={modelAppearance}
        models={[{ id: inheritedModel, label: inheritedModel }]}
        value={
          new URLSearchParams(location.search).has("pinned")
            ? inheritedModel
            : ""
        }
        defaultModel={inheritedModel}
        defaultLabel={inheritedModel}
        effortLabel="Automatic"
        disabled={disabled}
        onChange={() => {}}
      />
    ) : (
      <CreateModelChoices
        modelAppearance={modelAppearance}
        models={[{ id: "example", label: "Example model" }]}
        value="example"
        defaultLabel=""
        includeDefault={false}
        disabled={disabled}
        onChange={() => {}}
      />
    ),
};
const staticStore = <T,>(state: T) => ({
  snapshot: () => state,
  subscribe: () => () => {},
});
const thinkingTypes: Record<string, RegisteredAgentType> = {};
if (thinkingHarness === "claude") {
  const setup = staticStore({
    status: { state: "ready", version: "fixture" },
    running: undefined,
    checking: false,
    models: [
      ...(settingsSync
        ? [
            {
              value: "claude-fixture-other",
              displayName: "Other Claude model",
              supportedEffortLevels: ["low", "high"],
            },
          ]
        : []),
      {
        value: "default",
        resolvedModel: "claude-fixture-model",
        displayName: "Fictional Claude model",
        supportedEffortLevels: ["low", "high"],
      },
      {
        value: "claude-fixture-model",
        displayName: "Fictional Claude model",
        supportedEffortLevels: ["low", "high"],
      },
    ],
    modelsChecking: false,
    modelsError: "",
  });
  const defaults = staticStore({ model: "", effort: "" });
  const tabs = createClaudeTabs({
    // The listed models stay current, so a picker's refresh finds nothing new.
    setup: { ...setup, loadModels: async () => {} } as never,
    defaults: defaults as never,
    runtime: { isRemote: async () => false } as never,
  });
  thinkingTypes.claude = {
    ...type,
    key: "fixture/claude",
    id: "claude",
    title: "Claude",
    defaults: () => ({ config: { ...claudeDefaults } }),
    CreateModel: tabs.CreateModel,
    CreateThinking: tabs.CreateThinking,
    ...(settingsSync
      ? {
          tabs: [
            {
              id: "settings",
              title: "Settings",
              role: "settings" as const,
              splitSettings: true,
              component: tabs.SettingsTab,
            },
          ],
        }
      : {}),
  };
} else if (thinkingHarness === "codex") {
  const model = {
    model: "codex-fixture-model",
    displayName: "Fictional Codex model",
    description: "Synthetic browser fixture",
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "high", description: "" },
    ],
  };
  const providerState = {
    readiness: "ready",
    checking: false,
    data: {
      models: [model],
      defaultVoice: "cove",
      ...(!new URLSearchParams(location.search).has("voicesUnavailable") && {
        voices: ["cove", "maple", "vale", "porto"],
      }),
      previews: Object.fromEntries(
        ["cove", "maple", "vale"].map((voice) => [
          voice,
          `https://persistent.oaistatic.com/voice/previews/${voice}.m4a`,
        ]),
      ),
      accents: {
        cove: "American English",
        maple: "American English",
        vale: "British English",
      },
    },
    error: "",
    defaults: { model: "", effort: "" },
  };
  const provider = {
    ...staticStore({
      ...providerState,
      ...(new URLSearchParams(location.search).has("modelsUnavailable") && {
        data: undefined,
        error: "Codex models could not be checked.",
      }),
    }),
    check: async () => {},
    recommended: () => null,
    resolve: (value: unknown) => ({
      ...codexDefaults,
      ...(value as Partial<typeof codexDefaults>),
    }),
  };
  const setup = staticStore({
    status: { state: "ready", version: "fixture" },
    running: undefined,
  });
  const tabs = createCodexTabs(
    provider as never,
    {} as never,
    (() => Promise.resolve(undefined)) as never,
    setup as never,
  );
  thinkingTypes.codex = {
    ...type,
    key: "fixture/codex",
    id: "codex",
    title: "Codex",
    settingsProposal: { voice: true, apps: true, compactAt: true },
    defaults: () => ({ config: { ...codexDefaults } }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: tabs.SettingsTab,
      },
    ],
    CreateModel: tabs.CreateModel,
    CreateThinking: tabs.CreateThinking,
    ...(settingsSync
      ? {
          tabs: [
            {
              id: "settings",
              title: "Settings",
              role: "settings" as const,
              splitSettings: true,
              component: tabs.SettingsTab,
            },
          ],
        }
      : {}),
  };
}
let snapshot = {
  status: "ready" as const,
  running: [] as Agent[],
  teams: teamImport
    ? [
        {
          id: "team",
          name: "Research",
          instructions: "Help.",
          members: ["4".repeat(64), "5".repeat(64)],
        },
      ]
    : [],
  agents: ["Ada", "Bo", "Cy"].map(
    (name, index) =>
      ({
        pubkey: String(index + 1).repeat(64),
        key: String(index + 1).repeat(64),
        owner: "f".repeat(64),
        type: type.key,
        name,
        picture: agentAvatars[index]?.url,
        config: instructions === null ? {} : { instructions },
        relay: "",
        place: "here",
        skipped: {},
        timers: {},
        attention: {},
        attentionEnabled: true,
      }) as Agent,
  ),
};
const fixtureThinkingType = thinkingTypes[thinkingHarness ?? ""];
if (fixtureThinkingType) {
  snapshot.agents = snapshot.agents.map((agent) => ({
    ...agent,
    type: fixtureThinkingType.key,
  }));
}
if (settingsSync) {
  const saved = JSON.parse(
    localStorage.getItem("fixture-agent-settings") ?? "{}",
  );
  snapshot.agents = snapshot.agents.map((agent) => ({
    ...agent,
    config: saved[agent.key] ?? agent.config,
  }));
}
const joining = [4, 5].map(
  (n) =>
    ({
      ...snapshot.agents[0],
      key: String(n).repeat(64),
      pubkey: String(n).repeat(64),
      name: `Member ${n}`,
      relay: `wss://community-${n}.example`,
    }) as Agent,
);
const joined: string[] = [];
Object.assign(window, { joined });
const other: RegisteredAgentType = {
  ...type,
  key: "fixture/other",
  id: "other",
  title: "Other",
};
const hosted: RegisteredAgentType = {
  ...type,
  key: "fixture/hosted",
  id: "hosted",
  title: "Builderlab",
  remote: {
    provision: async () => {
      throw new Error("Unexpected remote provision");
    },
    activate: async () => {
      throw new Error("Unexpected remote activation");
    },
    profile: async () => {
      throw new Error("Unexpected remote profile write");
    },
    remove: async () => {
      throw new Error("Unexpected remote removal");
    },
  },
};
if (harness === "hosted") {
  snapshot.agents = snapshot.agents.map((agent) => ({
    ...agent,
    place: "hosted",
    type: hosted.key,
  }));
}
const proposingSettings = new URLSearchParams(location.search).has(
  "proposeSettings",
);
const reviewing = new URLSearchParams(location.search).has("review");
const changing = new URLSearchParams(location.search).has("change");
const types = thinkingTypes[thinkingHarness ?? ""]
  ? [thinkingTypes[thinkingHarness ?? ""]]
  : harness
    ? [type, other, hosted]
    : importing
      ? [
          { ...type, title: "Alternative" },
          { ...other, title: "Claude Code", icon: ClaudeLogoIcon },
        ]
      : changing
        ? [type, other]
        : [type];
if (changing || proposingSettings) {
  snapshot.agents = snapshot.agents.map((agent) => ({
    ...agent,
    relay: "wss://relay.example",
  }));
  snapshot.running = snapshot.agents;
}
let updates: readonly AgentUpdateRequest[] = changing
  ? [
      {
        id: "change",
        requester: "a".repeat(64),
        requesterName: "Parent",
        owner: "f".repeat(64),
        community: "https://relay.example",
        agent: "1".repeat(64),
        agentName: "Ada",
        agentType: type.key,
        name: "Ada Reviewer",
        type: other.key,
        instructions: "Review pull requests before they merge.",
      },
    ]
  : [];
const changed: NewAgent[] = [];
const failFirstApproval = new URLSearchParams(location.search).has("fail");
let approvalAttempts = 0;
let requests: readonly AgentCreationRequest[] = reviewing
  ? [
      {
        id: "draft",
        requester: "a".repeat(64),
        requesterName: "Parent",
        owner: "f".repeat(64),
        community: "https://relay.example",
        type: type.key,
        name: "Child",
      },
    ]
  : [];
const listeners = new Set<() => void>();
const reviewed: NewAgent[] = [];
const dismissCreation = () => {
  requests = [];
  for (const listener of listeners) listener();
};
const dismissUpdate = () => {
  updates = [];
  for (const listener of listeners) listener();
};
Object.assign(window, {
  creationReviewResult: () => reviewed,
  updateReviewResult: () => changed,
  proposeFixtureSettings: (settings: AgentUpdateRequest["settings"]) => {
    const agent = snapshot.agents[0];
    if (!proposingSettings || !agent || !settings)
      throw new Error("Missing settings proposal fixture");
    updates = [
      {
        id: crypto.randomUUID(),
        requester: agent.pubkey,
        requesterName: agent.name,
        owner: agent.owner,
        community: "https://relay.example",
        agent: agent.pubkey,
        agentName: agent.name,
        agentType: agent.type,
        settings,
        instructions: "Review the change.",
      },
    ];
    for (const listener of listeners) listener();
  },
});
const agents = {
  snapshot: () => snapshot,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  creationRequests: () => requests,
  dismissCreation,
  approveCreation: async (_id: string, input: NewAgent) => {
    if (failFirstApproval && ++approvalAttempts === 1)
      throw new Error("Credential store refused");
    reviewed.push(input);
    dismissCreation();
    return {} as Agent;
  },
  updateRequests: () => updates,
  dismissUpdate,
  approveUpdate: async (_id: string, input: NewAgent) => {
    changed.push(input);
    if (proposingSettings && snapshot.agents[0])
      await agents.save(snapshot.agents[0].key, { config: input.config });
    dismissUpdate();
  },
  previewRetype: () => ({
    config: {},
    moved: ["instructions"],
    dropped: ["workspace"],
    settings: [],
  }),
  types: () => types,
  find: (pubkey: string) =>
    snapshot.agents.find((agent) => agent.pubkey === pubkey),
  memberships: (pubkey: string) =>
    saveFooter
      ? [
          { key: pubkey, origin: "https://current.example", connected: true },
          {
            key: `${pubkey}@other.example`,
            origin: "https://other.example",
            connected: false,
          },
        ]
      : [],
  configHistory: () => undefined,
  agentSync: () => undefined,
  teamSync: () => ({ local: undefined }),
  addedTabs: () => [],
  registerTab: () => {},
  controlAttention: () => {},
  joinable: () => (teamImport ? joining : []),
  join: async (key: string) => {
    joined.push(key);
    return { agent: joining.find((agent) => agent.key === key), notes: [] };
  },
  portable: async () => ({
    agents: importing
      ? [1, 2].map((n) => ({
          source: "installed" as const,
          pubkey: String(n).repeat(64),
          name: `Legacy ${n}`,
          relay: "",
        }))
      : [],
    teams: [],
    here: [],
    warnings: [],
  }),
  port: async (input: { pubkey: string; type: string }) => {
    importTargets.push(input);
    return { agent: snapshot.agents[0], notes: [] };
  },
  relay: () => undefined,
  save: async (key: string, change: { config?: unknown }) => {
    if (!saveFooter && !settingsSync) return;
    snapshot.agents = snapshot.agents.map((agent) =>
      agent.key === key
        ? { ...agent, config: change.config ?? agent.config }
        : agent,
    );
    if (proposingSettings) snapshot.running = snapshot.agents;
    if (settingsSync) {
      snapshot = { ...snapshot };
      localStorage.setItem(
        "fixture-agent-settings",
        JSON.stringify(
          Object.fromEntries(
            snapshot.agents.map((agent) => [agent.key, agent.config]),
          ),
        ),
      );
    }
    for (const listener of listeners) listener();
  },
  classifier: () => "unavailable",
} as unknown as Agents;

if (new URLSearchParams(location.search).has("settingsRecovery")) {
  const secret = generateSecretKey();
  const first = snapshot.agents[0];
  if (!first) throw new Error("Missing fixture agent");
  const expected = {
    channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
    d: "5b1d3b52-6c4e-5a0b-8e3c-1f2a3b4c5d6e",
    type: "buzz.agent.settings" as const,
  };
  const check = {
    agentType: first.type,
    schema: {
      scope: ["thread", "channel"],
      model: "string",
      effort: ["low", "high"],
    },
  } as const;
  const previous = finalizeEvent(
    artifactTemplate({
      ...expected,
      op: "create",
      title: "Agent settings",
      content: JSON.stringify({
        version: 1,
        agentType: first.type,
        settings: { scope: "channel", model: "older-model", effort: "high" },
      }),
    }),
    secret,
  ) as RelayEvent;
  let head: RelayEvent =
    JSON.parse(localStorage.getItem("fixture-recovery-head") ?? "null") ??
    finalizeEvent(
      artifactTemplate({
        ...expected,
        op: "update",
        prev: previous.id,
        title: "Agent settings",
        content: JSON.stringify({
          version: 1,
          agentType: first.type,
          settings: {
            scope: "community",
            voice: "maple",
            model: 42,
            effort: "high",
          },
          future: { keep: true },
        }),
      }),
      secret,
    );
  const store = new AgentConfigStore(localStore(sessionStorage));
  const subject = {
    owner: first.owner,
    community: "https://relay.example",
    subject: first.pubkey,
    channel: expected.channel,
    type: expected.type,
  };
  const update = () => {
    const checked = syncedSettings(head.content, first.type, check.schema);
    snapshot = {
      ...snapshot,
      agents: snapshot.agents.map((agent) => {
        if (agent.key !== first.key) return agent;
        const { configProblem: _, ...rest } = agent;
        return {
          ...rest,
          configBase: { settings: head.id },
          ...("problem" in checked
            ? {
                configProblem: `These agent settings aren't compatible with this version of Buzz: ${checked.problem}`,
              }
            : { config: { ...(agent.config as object), ...checked.settings } }),
        };
      }),
    };
    for (const listener of listeners) listener();
  };
  const older = [previous];
  const readHistory: SnapshotRead = async ([filter]) =>
    filter?.artifact === "history" ? [head, ...older] : [head];
  const writer = createConfigWriter({
    store,
    read: readHistory,
    online: () => true,
    signal: new AbortController().signal,
    maxEventBytes: 512 * 1024,
    writer: {
      sign: async (template) => finalizeEvent(template, secret) as RelayEvent,
      publish: async (event) => {
        if (event.tags.find(([name]) => name === "prev")?.[1] !== head.id)
          throw new Error("stale prev");
        older.unshift(head);
        head = event;
        localStorage.setItem("fixture-recovery-head", JSON.stringify(head));
      },
    },
  });
  agents.configHistory = (key) =>
    key !== first.key
      ? undefined
      : {
          sides: [{ side: "settings", expected, head, version: 1 }],
          settings: check,
          read: readHistory,
          revise: async (_side, template) => {
            const result = await writer.revise(
              { subject, expected, title: "Agent settings" },
              template,
              template.tags.find(([name]) => name === "prev")?.[1] ?? "",
            );
            update();
            return result.status === "saved"
              ? { status: "accepted" }
              : {
                  status: "refused",
                  message: `Repair failed: ${result.status}`,
                };
          },
        };
  update();
}

if (settingsSync) {
  Object.assign(window, {
    updateFixtureInstructions: (instructions: string) => {
      const agent = snapshot.agents[0];
      if (!agent) throw new Error("Missing fixture agent");
      return agents.save(agent.key, {
        config: { ...(agent.config as Record<string, unknown>), instructions },
      });
    },
  });
}
const disconnected = {
  status: "disconnected",
  generation: 0,
  ...(new URLSearchParams(location.search).has("reorder")
    ? { scope: "https://relay.example:fixture-owner" }
    : {}),
  ...(teamImport
    ? {
        viewer: "owner",
        origin: "https://current.example",
        scope: "current:owner",
      }
    : {}),
};
const relay = {
  snapshot: () => disconnected,
  subscribe: () => () => {},
} as unknown as RelayData;
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
const memoryOwner =
  memoryLabel === null
    ? undefined
    : createAgentMemories(
        async () => ({
          entries: [
            {
              slug: "core",
              body: "Keep replies concise.",
              eventId: "b".repeat(64),
              createdAt: 1_700_000_000,
            },
            {
              slug: memoryLabel,
              body: `# Saved detail\n\n${"A long body remains readable. ".repeat(30)}`,
              eventId: "c".repeat(64),
              createdAt: 1_700_000_000,
            },
          ],
          partial: false,
        }),
        "f".repeat(64),
        () => true,
      );
const memoryAgent = snapshot.agents[0];
if (memoryOwner && !memoryAgent) throw new Error("Missing memory agent");
createRoot(root).render(
  <div
    className="h-screen"
    style={memoryOwner ? { maxWidth: "28rem" } : undefined}
  >
    {memoryOwner && memoryAgent ? (
      <AgentDetails
        agents={agents}
        agent={{ ...memoryAgent, relay: "wss://current.example" }}
        type={type}
        types={types}
        channels={[]}
        memories={memoryOwner.capability}
        onRemoved={() => {}}
        messageAction={() => null}
      />
    ) : (
      <AgentsPage agents={agents} relay={relay} />
    )}
    {reviewing && <CreationReview agents={agents} />}
    {(changing || proposingSettings) && <UpdateReview agents={agents} />}
  </div>,
);
