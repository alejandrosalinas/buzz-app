// The production Security settings over an in-memory native IPC. No Keychain.
// `?viewer=1` mounts Authorize external identity below the list, as Settings
// does with a native identity; the mock does not serve authorizing a key.
import { mockIPC } from "@tauri-apps/api/mocks";
import { createRoot } from "react-dom/client";
import { SecuritySettings } from "../../src/app/SecuritySettings";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { createAppearance } from "../../src/shared/theme/service";
import "../../src/shared/styles/globals.css";
const appearance = createAppearance(),
  parameters = new URLSearchParams(location.search);
appearance.setMode(parameters.get("theme") === "dark" ? "dark" : "light");
appearance.setFontScale(Number(parameters.get("scale") ?? 1));
const now = Math.floor(Date.now() / 1000),
  day = 86_400,
  relay = "wss://relay.example.org/";
let tools = [
  {
    id: "p1",
    client: "buzz-cli",
    relay,
    created: now - 12 * day,
    lastUsed: now - day,
    expires: now + 29 * day,
  },
  {
    id: "p2",
    client: "release-notes",
    relay,
    created: now - 3 * day,
    lastUsed: now - 3 * day,
    expires: now + 27 * day,
  },
];
// `release-notes` refuses to be revoked, to show the failure path. The mock
// serves the event plugin itself, so the section's `credential-pairings-changed`
// listener is accepted and a test can `emit` it to refresh the list.
mockIPC(
  (command, payload) => {
    if (command === "credential_pairings_list") return tools;
    if (command !== "credential_pairing_revoke")
      throw new Error(`Unexpected command ${command}`);
    const { id } = payload as { id: string };
    if (id === "p2") throw "Paired tools could not be saved to secure storage";
    tools = tools.filter((tool) => tool.id !== id);
  },
  { shouldMockEvents: true },
);
function Fixture() {
  useKeyboardFocusVisibility();
  return (
    <main className="mx-auto grid max-w-3xl gap-section-gap p-4">
      <SecuritySettings
        viewer={parameters.has("viewer") ? "ab".repeat(32) : undefined}
      />
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
