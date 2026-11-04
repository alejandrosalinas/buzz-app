// An agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's tabs, settings, and Memory.
// Memory is relay-backed for both local and hosted agents. Agents classified
// as `elsewhere` expose no sections in these views.
import { useId, useState, type ReactNode } from "react";
import { MemoryPanel, type AgentMemories } from "./MemoryPanel";
import type { CommunityReader } from "../communities/service";
import type {
  Agent,
  AgentConversation,
  AgentSettingsHost,
  AgentViewProps,
  Agents,
  RegisteredAgentType,
  TranscriptRequest,
} from "./service";
import { AgentSaveButton } from "./AgentSaveButton";
import { AgentConfigHistoryRow } from "./AgentConfigHistoryRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";

export type AgentSection = Readonly<{
  /** `agent:<type tab id>`, `agent:settings`, `agent:activity`,
   * `agent:added:<plugin>/<tab id>` or `agent:memory`; never collides with a
   * host tab. */
  value: `agent:${string}`;
  label: string;
  render(): ReactNode;
}>;

export function agentSections({
  agents,
  agent,
  type,
  conversation,
  initialTranscript,
  close,
  openConversation,
  settingsHost,
  memories,
  communities,
  settingsSection,
  settingsContent,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  conversation?: AgentConversation | undefined;
  /** Asks to show the conversation's transcript first; see AgentViewProps. */
  initialTranscript?: TranscriptRequest | undefined;
  /** Closes the panel the sections are shown in. */
  close?: (() => void) | undefined;
  /** Opens a turn's conversation; see AgentViewProps. */
  openConversation?: AgentViewProps["openConversation"];
  settingsHost?: AgentSettingsHost;
  settingsSection?: "identity" | "runtime";
  settingsContent?: ReactNode;
  /** Memory reads through the owner's session; absent while it connects. */
  memories: AgentMemories | undefined;
  communities?: CommunityReader | undefined;
}): readonly AgentSection[] {
  if (agent.place === "elsewhere") return [];
  const historyContent =
    settingsContent === undefined &&
    agent.place === "here" &&
    agents.configHistory(agent.pubkey) ? (
      <SettingsGroup>
        <AgentConfigHistoryRow agents={agents} pubkey={agent.pubkey} />
      </SettingsGroup>
    ) : undefined;
  const details = settingsContent ?? historyContent;
  const typeTabs = type?.tabs ?? [];
  const settingsTab = typeTabs.find((tab) => tab.role === "settings");
  const orderedTabs =
    settingsHost && settingsTab
      ? [settingsTab, ...typeTabs.filter((tab) => tab !== settingsTab)]
      : typeTabs;
  const tabs = orderedTabs.map(({ id, title, role, component: Component }) => ({
    value: (role ? `agent:${role}` : `agent:type:${id}`) as `agent:${string}`,
    label: title,
    render: () => (
      <EditorBase agents={agents} agent={agent}>
        {(save) => (
          <Component
            agent={agent}
            {...(role === "settings" && settingsSection
              ? { settingsSection }
              : {})}
            {...(role === "settings" && details
              ? { settingsContent: details }
              : {})}
            {...(conversation && { conversation })}
            {...(role === "activity" &&
              conversation &&
              initialTranscript && { initialTranscript })}
            {...(role === "activity" && close && { close })}
            {...(role === "activity" &&
              openConversation && { openConversation })}
            save={(config) =>
              settingsHost?.pendingSave
                ? settingsHost.pendingSave(config)
                : save(config)
            }
            {...(role === "settings" && settingsHost ? { settingsHost } : {})}
          />
        )}
      </EditorBase>
    ),
  }));
  if (
    !settingsTab &&
    (settingsHost?.typeControl || settingsHost?.pendingSave || historyContent)
  )
    tabs.unshift({
      value: "agent:settings",
      label: "Settings",
      render: () => (
        <>
          {settingsHost && <HostSettings host={settingsHost} />}
          {historyContent}
        </>
      ),
    });
  // A tab for local agents only says so in its `when`.
  for (const { key, title, component: Component, when } of agents.addedTabs())
    if (!when || shows(when, agent, key))
      tabs.push({
        value: `agent:added:${key}`,
        label: title,
        render: () => <Component agent={agent} />,
      });
  return [
    ...tabs,
    {
      value: "agent:memory",
      label: "Memory",
      render: () => (
        <MemoryPanel
          agents={agents}
          agent={agent}
          memories={memories}
          communities={communities}
        />
      ),
    },
  ];
}

/** A plugin's `when`; one that throws hides only its own tab. */
function shows(when: (agent: Agent) => boolean, agent: Agent, key: string) {
  try {
    return when(agent);
  } catch (error) {
    console.error(`Agent tab ${key} could not decide whether to show`, error);
    return false;
  }
}

function HostSettings({ host }: { host: AgentSettingsHost }) {
  const form = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!host.pendingSave) return;
    setSaving(true);
    setError("");
    try {
      await host.pendingSave();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      id={form}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {host.typeControl?.(false)}
      {error && (
        <p role="alert" className="buzz-field-error">
          {error}
        </p>
      )}
      <AgentSaveButton
        form={form}
        saving={saving}
        disabled={!host.pendingSave}
      />
    </form>
  );
}

/** Saves a type tab's config as a revision of the synced heads it opened
 * with, so an edit made over a stale view conflicts instead of overwriting.
 * Each save moves the base to what it saved. */
function EditorBase({
  agents,
  agent,
  children,
}: {
  agents: Pick<Agents, "save" | "snapshot">;
  agent: Agent;
  children(save: (config: unknown) => Promise<void>): ReactNode;
}) {
  const [base, setBase] = useState(agent.configBase);
  const editor = children(async (config) => {
    await agents.save(agent.key, { config, ...(base && { base }) });
    setBase(
      agents.snapshot().agents.find((a) => a.key === agent.key)?.configBase,
    );
  });
  return agent.configProblem ? (
    <>
      <p role="alert" className="buzz-field-error">
        {agent.configProblem}
      </p>
      {editor}
    </>
  ) : (
    editor
  );
}
