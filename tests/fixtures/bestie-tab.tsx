// The production Bestie tabs in the Agents side panel's layout, with only the
// host data boundary replaced. `?former` shows the Former Bestie tab, and
// `?edited` a memory section whose closing marker was edited by hand.
import { createRoot } from "react-dom/client";
import styles from "../../src/bundled/agents/AgentsPage.module.css";
import { bestieTab, formerBestieTab } from "../../src/bundled/bestie/BestieTab";
import { memory, withFeature } from "../../src/bundled/bestie/features";
import type { Agent } from "../../src/features/agents/service";
import type { RelayData } from "../../src/features/relay/service";
import "../../src/shared/styles/globals.css";

const OWNER = "f".repeat(64);
const ADA = "a".repeat(64);
const BEA = "b".repeat(64);
const query = new URLSearchParams(location.search);
const former = query.has("former");
const edited = query.has("edited");
const channel = (name: string, members: string[]) => ({
  id: `id-${name}`,
  name,
  channelType: "stream",
  private: true,
  members,
});
const list = {
  channels: [
    channel("design-reviews-and-weekly-planning-notes", [OWNER, ADA]),
    channel("family", [OWNER, ADA]),
    channel("leadership-offsite", [OWNER]),
    channel("hiring", [OWNER]),
  ],
};
const choice = (pubkey: string, name: string) => ({
  pubkey,
  name,
  managed: true,
});
const choices = {
  status: "ready",
  complete: true,
  pending: false,
  identities: [choice(ADA, "Ada"), choice(BEA, "Bea")],
  selectable: [choice(ADA, "Ada"), choice(BEA, "Bea")],
  archives: { status: "unavailable", archived: [] },
};
const connection = {
  status: "ready",
  scope: `https://relay.example:${OWNER}`,
  session: {
    viewer: OWNER,
    outbox: { supports: () => true },
    directMessages: { open: async () => "dm" },
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList: () => {},
    },
    memberAdditions: { add: async () => {} },
    memberAdministration: {
      refresh: async () => {},
      run: async () => {},
      snapshot: () => ({ status: "ready", authority: { roles: {} } }),
    },
    mainAgent: {
      read: async () => (former ? BEA : ADA),
      write: async () => {},
    },
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
const agents = {
  save: async () => {},
  types: () => [{ key: "claude-code", adopt: () => ({}) }],
  // Both are on this device, so neither is asked about as remote.
  find: (pubkey: string) =>
    [ADA, BEA].includes(pubkey) ? { pubkey, place: "here" } : undefined,
};
const agent = {
  key: ADA,
  pubkey: ADA,
  name: "Ada",
  type: "claude-code",
  owner: OWNER,
  relay: "wss://relay.example",
  place: "here",
  attentionEnabled: true,
  attention: {
    "interest/bestie-notes": { value: { type: "interest" } },
    "watch/bestie-notes": { value: { type: "timer" } },
  },
  config: {
    instructions: withFeature("Be brief.", memory, true).replace(
      "<!-- /buzz:bestie/memory -->",
      edited ? "<!-- /buzz:bestie/memory--> Also answer in French." : "$&",
    ),
  },
} as unknown as Agent;
const tab = (former ? formerBestieTab : bestieTab)(relay, agents);
const Tab = tab.component;
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <div style={{ display: "flex", justifyContent: "flex-end", height: "100%" }}>
    <aside
      className={styles.side}
      aria-label="Agent panel"
      style={{ width: "var(--secondary-panel-width, 28rem)", overflow: "auto" }}
    >
      <div className={styles.detailsScroll}>
        <section aria-label="Ada settings">
          <div className="grid gap-6 pt-4">
            <Tab agent={agent} />
          </div>
        </section>
      </div>
    </aside>
  </div>,
);
