import { agentAvatars } from "../../src/features/agents/avatar-packs";
import { createRoot } from "react-dom/client";
import { AgentShareDialog } from "../../src/bundled/agents/AgentShareDialog";
import type {
  Agent,
  RegisteredAgentType,
} from "../../src/features/agents/service";
import type { RelaySession } from "../../src/features/relay/session";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

// The real Share dialog for an agent with no picture, over a session that
// reaches nobody: enough to open Export and draw the card on a real canvas.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);
if (params.has("large")) document.documentElement.style.fontSize = "150%";
const owner = "f".repeat(64);
// A real decoded portrait exercises palette sampling and canvas export together.
let picture: string | undefined;
if (params.has("portrait")) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Missing portrait canvas");
  context.fillStyle = "white";
  context.fillRect(0, 0, 96, 96);
  context.fillStyle =
    params.get("portrait") === "red" ? "rgb(210, 50, 70)" : "rgb(48, 178, 76)";
  context.beginPath();
  context.arc(48, 48, 40, 0, Math.PI * 2);
  context.fill();
  picture = canvas.toDataURL();
}
if (params.has("pack")) picture = agentAvatars[0].url;
const agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  picture,
  type: "test/echo",
  owner,
  relay: "wss://relay.example",
  place: "here",
  config: { instructions: "Review pull requests.", model: "echo-1" },
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
} as Agent;
const type = {
  key: "test/echo",
  title: "Echo",
  summary: () => "echo-1",
  carry: (saved: { instructions: string }) => ({
    instructions: saved.instructions,
  }),
  exportShared: (saved: { model: string }) => ({
    runtime: "echo",
    model: saved.model,
  }),
} as unknown as RegisteredAgentType;
// Stable snapshots, as the stores they stand in for keep.
const nothing: never[] = [];
const channels = { channels: nothing };
const session = {
  read: async () => [],
  outbox: {
    supports: () => true,
    ready: async () => {},
    snapshot: () => nothing,
    subscribe: () => () => {},
  },
  viewer: owner,
  scope: `wss://relay.example ${owner}`,
  directMessages: {
    available: true,
    people: async () => ({ people: [], hasMore: false }),
  },
  channels: { list: () => channels, subscribeList: () => () => {} },
  media: (url: string) => url,
} as unknown as RelaySession;

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <ToastProvider>
    <AgentShareDialog
      agent={agent}
      type={type}
      session={session}
      onClose={() => {}}
    />
  </ToastProvider>,
);
