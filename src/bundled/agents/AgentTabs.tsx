import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChannelChoice } from "../../features/agents/attention";
import type {
  Agent,
  AgentConversation,
  AgentSettingsHost,
  Agents,
  AgentViewProps,
  RegisteredAgentType,
  TranscriptRequest,
} from "../../features/agents/service";
import type {
  AgentMemories,
  MemoryLinks,
} from "../../features/agents/MemoryPanel";
import type { CommunityReader } from "../../features/communities/service";
import { agentSections } from "../../features/agents/tabs";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import {
  AgentSaveState,
  DiscardChanges,
  useAgentSaveReports,
  useAgentSaveState,
} from "../../features/agents/AgentSaveButton";

/** An agent's sections as tabs, opening on the first. */
export function AgentTabs(props: {
  showSettings?: boolean | undefined;
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  settingsHost: AgentSettingsHost;
  memories: AgentMemories | undefined;
  memoryLinks?: MemoryLinks | undefined;
  communities?: CommunityReader | undefined;
  settingsContent: ReactNode;
  conversation?: AgentConversation | undefined;
  initialActivity?: boolean | undefined;
  initialTranscript?: TranscriptRequest | undefined;
  close?: (() => void) | undefined;
  openConversation?: AgentViewProps["openConversation"];
  openLink?: ((target: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  onDiscard?: () => void;
}) {
  const split = props.type?.tabs?.some(
    (section) => section.role === "settings" && section.splitSettings,
  );
  const historyPanel = useRef<HTMLDivElement>(null);
  const [focusHistory, setFocusHistory] = useState(false);
  const [draft, reportDraft] = useAgentSaveReports();
  const openVersionHistory = () => choose("agent:management", true);
  const supplied = agentSections({
    ...props,
    openVersionHistory,
    versionHistoryDisabled: draft.saving,
    ...(split ? { settingsSection: "identity" as const } : {}),
  });
  const identity = supplied.find(
    (section) => section.value === "agent:settings",
  );
  const sections = [
    ...(identity ? [{ ...identity, label: "Identity" }] : []),
    ...supplied.filter((section) => section.value.startsWith("agent:type:")),
    ...supplied.filter((section) => section.value === "agent:memory"),
    ...supplied.filter((section) => section.value === "agent:activity"),
    ...supplied.filter((section) => section.value.startsWith("agent:added:")),
    {
      value: "agent:management",
      label: "Settings",
      render: () => props.settingsContent,
    },
  ];
  const [tab, setTab] = useState<string>(
    props.showSettings
      ? "agent:management"
      : props.initialActivity
        ? "agent:activity"
        : (sections[0]?.value ?? ""),
  );
  // Hosts that replace or close the whole pane ask with the same total.
  useAgentSaveState(
    draft.dirty || Boolean(props.settingsHost.pendingSave),
    draft.saving,
  );
  // Focus intent travels with the navigation it belongs to.
  const [pendingTab, setPendingTab] = useState<{
    value: string;
    focus: boolean;
  }>();
  const panelPrefix = useId();
  const selected =
    sections.find((section) => section.value === tab) ?? sections[0];
  const choose = (value: string, focus = false) => {
    if (value === selected?.value) return setFocusHistory(focus);
    if (draft.saving) return;
    if (draft.dirty || props.settingsHost.pendingSave)
      setPendingTab({ value, focus });
    else {
      setTab(value);
      setFocusHistory(focus);
    }
  };
  const requestSettings = useEffectEvent(() => choose("agent:management"));
  useEffect(() => {
    if (props.showSettings) requestSettings();
  }, [props.showSettings]);
  useEffect(() => {
    if (focusHistory && selected?.value === "agent:management") {
      historyPanel.current
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Previous versions"]',
        )
        ?.focus();
      setFocusHistory(false);
    }
  }, [focusHistory, selected?.value]);
  const settingsSelected =
    selected?.value === "agent:settings" ||
    selected?.value === "agent:management";
  // Each section owns its draft and save action for its visible lifetime.
  const settings = split
    ? agentSections({
        ...props,
        openVersionHistory,
        versionHistoryDisabled: draft.saving,
        settingsSection:
          selected?.value === "agent:management" ? "runtime" : "identity",
        settingsContent: props.settingsContent,
      }).find((section) => section.value === "agent:settings")
    : undefined;
  const settingsValue =
    selected?.value === "agent:management"
      ? "agent:management"
      : "agent:settings";
  const panelId = (value: string) => `${panelPrefix}-${value}`;
  // A new transcript request shows Activity, as choosing its tab would.
  const opening = props.initialTranscript?.opening;
  const [asked, setAsked] = useState(opening);
  if (opening !== asked) {
    setAsked(opening);
    if (
      opening !== undefined &&
      sections.some((section) => section.value === "agent:activity")
    )
      choose("agent:activity");
  }
  return (
    <AgentSaveState value={reportDraft}>
      <Tabs
        value={selected?.value ?? ""}
        onValueChange={(value) => choose(value)}
        items={sections.map(({ value, label }) => ({
          value,
          label,
          panelId: panelId(value),
          disabled: draft.saving && value !== selected?.value,
        }))}
        label={`${props.agent.name} sections`}
        variant="panel"
      />
      {settings && settingsSelected && (
        <div
          ref={
            selected?.value === "agent:management" ? historyPanel : undefined
          }
          key={settingsValue}
          role="tabpanel"
          id={panelId(settingsValue)}
          aria-labelledby={`${panelId(settingsValue)}-tab`}
        >
          <div className="grid gap-6 pt-4">{settings.render()}</div>
        </div>
      )}
      {sections
        .filter(
          ({ value }) =>
            !(
              settings &&
              (value === "agent:settings" || value === "agent:management")
            ) && value === selected?.value,
        )
        .map((section) => (
          <div
            ref={
              section.value === "agent:management" ? historyPanel : undefined
            }
            role="tabpanel"
            id={panelId(section.value)}
            aria-labelledby={`${panelId(section.value)}-tab`}
            key={section.value}
          >
            <div className="grid gap-6 pt-4">{section.render()}</div>
          </div>
        ))}
      {pendingTab && (
        <DiscardChanges
          description="Your unsaved changes will be lost if you switch tabs."
          onKeep={() => setPendingTab(undefined)}
          onDiscard={() => {
            props.onDiscard?.();
            setTab(pendingTab.value);
            setFocusHistory(pendingTab.focus);
            setPendingTab(undefined);
          }}
        />
      )}
    </AgentSaveState>
  );
}
