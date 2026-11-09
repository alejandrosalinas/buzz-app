import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ChannelSidebarItem } from "../../src/bundled/channels/ChannelSidebarItem";
import type {
  ChannelSummary,
  Profile,
} from "../../src/features/relay/contracts";
import type { RelaySession } from "../../src/features/relay/session";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";
import "./nav-thinking.css";

const agents = {
  buzzy: "a".repeat(64),
  atlas: "b".repeat(64),
  nova: "c".repeat(64),
};
const channels: ChannelSummary[] = [
  { id: "design", name: "buzz-design", channelType: "stream" },
  { id: "development", name: "buzz-development", channelType: "stream" },
  {
    id: "buzzy-dm",
    name: "Buzzy",
    channelType: "dm",
    participants: [agents.buzzy],
  },
  {
    id: "group-dm",
    name: "Buzzy, Atlas, Nova",
    channelType: "dm",
    participants: Object.values(agents),
  },
];
const profiles = new Map<string, Profile>([
  [agents.buzzy, { name: "Buzzy", isAgent: true }],
  [agents.atlas, { name: "Atlas", isAgent: true }],
  [agents.nova, { name: "Nova", isAgent: true }],
]);
type Active = Readonly<Record<string, readonly string[]>>;
const listeners = new Set<() => void>();
let active: Active = { design: [agents.buzzy] };
let activitySnapshot = snapshot(active);
function snapshot(value: Active) {
  return {
    status: "listening" as const,
    records: Object.entries(value).flatMap(([channelId, ids]) =>
      ids.map((agent) => ({
        id: "d".repeat(64),
        agent,
        receivedAt: Date.now(),
        kind: "turn_started",
        plaintext: JSON.stringify({
          kind: "turn_started",
          channelId,
          turnId: `${channelId}:${agent}`,
          timestamp: new Date(Date.now() - 125_000).toISOString(),
          payload: { triggeringEventIds: [agent] },
        }),
      })),
    ),
    turns: Object.entries(value).flatMap(([channelId, ids]) =>
      ids.map((agent) => ({
        agent,
        channelId,
        turnId: `${channelId}:${agent}`,
        state: "working" as const,
        timestamp: Date.now(),
      })),
    ),
    typing: [],
    trimmed: 0,
  };
}
function setActive(next: Active) {
  active = next;
  activitySnapshot = snapshot(next);
  for (const listener of listeners) listener();
}
const unread = new Map(
  channels.map((channel) => [
    channel.id,
    {
      target: { kind: "channel" as const, channelId: channel.id },
      observedCount: 0,
      attentionCount: 0,
      coverage: "observed" as const,
      freshness: "observed" as const,
      manual: "none" as const,
    },
  ]),
);
const threadActivity = new Map(
  channels.map((channel) => [
    channel.id,
    {
      channelId: channel.id,
      items: [],
      coverage: "observed" as const,
      freshness: "observed" as const,
    },
  ]),
);
const unreadThread = {
  channelId: "design",
  rootId: "e".repeat(64),
  latestMessageId: "f".repeat(64),
  authorId: agents.atlas,
  createdAt: Math.floor(Date.now() / 1000) - 300,
  preview: "Can you review the latest design?",
  unreadCount: 2,
};
const activeThreadActivity = {
  ...threadActivity.get("design"),
  items: [unreadThread],
};
let showUnreadThread = true;
const session = {
  channels: { prepare() {} },
  media: (url: string) => url,
  agentChoices: {
    snapshot: () => ({
      identities: Object.values(agents).map((pubkey) => ({ pubkey })),
    }),
  },
  profiles: {
    snapshot: () => profiles,
    subscribe: () => () => {},
    ensure: async () => {},
  },
  presence: {
    status: () => "online",
    limited: () => false,
    subscribe: () => () => {},
  },
  typing: { snapshot: () => [], subscribe: () => () => {} },
  agentActivity: {
    snapshot: () => activitySnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  unread: {
    snapshot: (target: { channelId: string }) => unread.get(target.channelId),
    subscribe: () => () => {},
    activity: (channelId: string) =>
      channelId === "design" && active.design?.length && showUnreadThread
        ? activeThreadActivity
        : threadActivity.get(channelId),
    subscribeActivity(_channelId: string, listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async markThrough() {
      showUnreadThread = false;
      for (const listener of listeners) listener();
      return {
        operationId: "preview",
        durability: "saved",
        sync: "local-only",
      };
    },
  },
} as unknown as RelaySession;

type Scenario = "one" | "two" | "dm" | "group" | "complete" | "reset";
const choices: { id: Scenario; label: string; activity: Active }[] = [
  {
    id: "one",
    label: "Channel · one agent",
    activity: { design: [agents.buzzy] },
  },
  {
    id: "two",
    label: "Channel · two agents",
    activity: { design: [agents.buzzy, agents.atlas] },
  },
  { id: "dm", label: "Agent DM", activity: { "buzzy-dm": [agents.buzzy] } },
  {
    id: "group",
    label: "Group DM · three agents",
    activity: { "group-dm": Object.values(agents) },
  },
  { id: "complete", label: "Complete", activity: {} },
  { id: "reset", label: "Reset", activity: {} },
];

function Preview() {
  const [mode, setMode] = useState<"light" | "dark">("light");
  useLayoutEffect(() => {
    document.documentElement.dataset.colorMode = mode;
  }, [mode]);
  const [scenario, selectScenario] = useState<Scenario>("one");
  const [selected, selectChannel] = useState("design");
  const [detail, setDetail] = useState<{
    agent: string;
    destination: "thread" | "activity";
  }>();
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activitySnapshot,
  );
  const choose = (choice: (typeof choices)[number]) => {
    selectScenario(choice.id);
    setDetail(undefined);
    setActive(choice.activity);
    if (choice.id === "dm") selectChannel("buzzy-dm");
    else if (choice.id === "group") selectChannel("group-dm");
    else if (choice.id === "one" || choice.id === "two")
      selectChannel("design");
  };
  const activeNames = current.turns
    .filter((turn) => turn.channelId === selected)
    .map((turn) => profiles.get(turn.agent)?.name ?? "Agent");
  return (
    <main className="nav-thinking-preview text-standard">
      <header className="nav-thinking-header">
        <h1 className="text-heading-lg">Agent thinking in navigation</h1>
        <p className="text-body-sm text-subtle">
          Local preview · controls change only this sample. Hover or click an
          active row to open the agent’s thread or activity.
        </p>
        <fieldset className="nav-thinking-theme" aria-label="Preview theme">
          <Button
            variant={mode === "light" ? "prominent" : "subtle"}
            aria-pressed={mode === "light"}
            onClick={() => setMode("light")}
          >
            Light mode
          </Button>
          <Button
            variant={mode === "dark" ? "prominent" : "subtle"}
            aria-pressed={mode === "dark"}
            onClick={() => setMode("dark")}
          >
            Dark mode
          </Button>
        </fieldset>
        <fieldset className="nav-thinking-controls" aria-label="Preview states">
          {choices.map((choice) => (
            <Button
              key={choice.id}
              variant={scenario === choice.id ? "prominent" : "subtle"}
              aria-pressed={scenario === choice.id}
              onClick={() => choose(choice)}
            >
              {choice.label}
            </Button>
          ))}
        </fieldset>
      </header>
      <div className="nav-thinking-workspace">
        <aside className="nav-thinking-sidebar" aria-label="Sidebar preview">
          <h2 className="text-label text-subtle">Channels</h2>
          {channels.slice(0, 2).map((channel) => (
            <ChannelSidebarItem
              key={channel.id}
              channel={channel}
              session={session}
              working={!!active[channel.id]?.length}
              selected={selected}
              onSelect={selectChannel}
              onOpenThread={() => {}}
              onOpenMessage={() => {}}
              onOpenWorkingAgent={(channelId, agent) => {
                selectChannel(channelId);
                setDetail({ agent, destination: "thread" });
              }}
              onOpenAgentActivity={(channelId, agent) => {
                selectChannel(channelId);
                setDetail({ agent, destination: "activity" });
              }}
            />
          ))}
          <h2 className="text-label text-subtle">Direct messages</h2>
          {channels.slice(2).map((channel) => (
            <ChannelSidebarItem
              key={channel.id}
              channel={channel}
              profile={
                channel.participants?.length === 1
                  ? profiles.get(channel.participants[0] ?? "")
                  : undefined
              }
              session={session}
              working={!!active[channel.id]?.length}
              selected={selected}
              onSelect={selectChannel}
              onOpenThread={() => {}}
              onOpenMessage={() => {}}
              onOpenWorkingAgent={(channelId, agent) => {
                selectChannel(channelId);
                setDetail({ agent, destination: "thread" });
              }}
              onOpenAgentActivity={(channelId, agent) => {
                selectChannel(channelId);
                setDetail({ agent, destination: "activity" });
              }}
            />
          ))}
        </aside>
        <section
          className="nav-thinking-conversation"
          aria-label="Sample conversation"
        >
          <h2 className="text-heading">
            {channels.find((channel) => channel.id === selected)?.name}
          </h2>
          <p className="text-body-md text-subtle">
            {detail
              ? `${profiles.get(detail.agent)?.name ?? "Agent"} is working here. This opens ${detail.destination === "thread" ? "the thread" : "agent activity"} in Buzz.`
              : activeNames.length
                ? `${activeNames.join(" and ")} ${activeNames.length === 1 ? "is" : "are"} working here.`
                : scenario === "complete"
                  ? "Work completed. The navigation indicator has cleared."
                  : "No active agent work in this conversation."}
          </p>
          {detail && (
            <Button variant="subtle" onClick={() => setDetail(undefined)}>
              Close detail
            </Button>
          )}
        </section>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
