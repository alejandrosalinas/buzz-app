import { createRoot } from "react-dom/client";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { ExternalConnectionSettings } from "../../src/bundled/agents/ExternalConnectionSettings";
import { ExternalAuthorizationDialog } from "../../src/features/agents/ExternalAuthorizationDialog";
import { createExternalApps } from "../../src/features/agents/external-connection";
import type { Agents } from "../../src/features/agents/service";
import type { Communities } from "../../src/features/communities/service";
import type { RelayData } from "../../src/features/relay/service";
import { Button } from "../../src/shared/design-system/ui/Button";
import { createAppearance } from "../../src/shared/theme/service";
import "../../src/shared/styles/globals.css";
const appearance = createAppearance(),
  parameters = new URLSearchParams(location.search);
appearance.setMode(parameters.get("theme") === "dark" ? "dark" : "light");
appearance.setFontScale(Number(parameters.get("scale") ?? 1));
const pubkey = "a".repeat(64),
  viewer = "b".repeat(64),
  origin = "https://fixture.example.test";
const inventory = {
  agents: [{ key: pubkey, pubkey, name: "Test agent", place: "here" }],
};
const subscribe = () => () => {};
const choices = {
  selectable: [{ pubkey }],
  pending: false,
  archives: { status: "ready" },
};
const snapshot = {
  status: "ready",
  scope: origin,
  session: { agentChoices: { subscribe, snapshot: () => choices } },
};
const client = {
  viewer,
  selected: origin,
  memberships: [{ id: origin, name: "Test community" }],
};
let admit = () => {},
  end = () => {};
const connection = createExternalApps();
connection.bind({
  connect: async (_key, signal, connected) => {
    admit = connected;
    const closed = new Promise<void>((resolve) => {
      end = resolve;
    });
    signal.addEventListener("abort", () => end(), { once: true });
    return {
      url: "http://127.0.0.1:1234/mcp",
      headers: [],
      close: async () => end(),
      closed,
      authorize: async () => {},
    };
  },
  deny: async () => {},
});
const request = () =>
  connection.open(
    {
      version: 1,
      client: "Test external app",
      callback: "http://127.0.0.1:1234/buzz/authorize",
      state: "A".repeat(43),
      scope: ["agent"],
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
    },
    viewer,
  );
function Fixture() {
  useKeyboardFocusVisibility();
  return (
    <main className="mx-auto grid max-w-3xl gap-section-gap p-4">
      <ExternalConnectionSettings connection={connection} />
      <ExternalAuthorizationDialog
        connection={connection}
        agents={
          {
            subscribe,
            snapshot: () => inventory,
            canConnectExternal: () => true,
          } as unknown as Agents
        }
        communities={
          {
            subscribe,
            snapshot: () => client,
            select: () => {},
          } as unknown as Communities
        }
        relay={{ subscribe, snapshot: () => snapshot } as unknown as RelayData}
      />
      <div className="flex flex-wrap gap-2">
        <Button aria-label="Fixture: request access" onClick={request}>
          Request
        </Button>
        <Button aria-label="Fixture: admit app" onClick={() => admit()}>
          Admit
        </Button>
        <Button aria-label="Fixture: end runtime" onClick={() => end()}>
          End
        </Button>
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
