// The real Goose Settings tab, with a long Databricks model as its default.
import { createRoot } from "react-dom/client";
import type { Agent } from "../../src/features/agents/service";
import { fakeSpawn } from "../../src/bundled/goose/goose-testing";
import {
  type Config,
  DEFAULT_CONFIG,
  type GooseRuntime,
} from "../../src/bundled/goose/runtime";
import { GooseSetup } from "../../src/bundled/goose/setup";
import { createTabs } from "../../src/bundled/goose/tabs";
import { GooseHistory } from "../../src/bundled/goose/transcript";
import { PreferenceRow } from "../../src/shared/design-system/ui/PreferenceRow";
import "../../src/shared/styles/globals.css";

const params = new URLSearchParams(location.search);
const LONG =
  "databricks-claude-sonnet-5-5-extended-context-thinking-preview-2026-10";
const SHORT = "databricks-claude-opus-5-5";
const model = params.get("model") === "short" ? SHORT : LONG;
const fake = fakeSpawn({
  providers: [
    {
      providerId: "databricks",
      providerName: "Databricks",
      configured: true,
      visibleInSetup: true,
      defaultModel: model,
      configKeys: [{ name: "DATABRICKS_HOST", required: true, secret: false }],
    },
  ],
  defaults: { providerId: "databricks", modelId: model },
  saved: new Map([["databricks", new Set(["DATABRICKS_HOST"])]]),
  supported: [model],
  // Create agent shows a thinking level beside the model when it lists one.
  ...(params.has("thinking") && {
    thinking: { [model]: { current: "", levels: ["low", "medium", "high"] } },
  }),
});
const { SettingsTab, CreateModel } = createTabs({
  setup: new GooseSetup(fake),
  runtime: {} as GooseRuntime,
  history: new GooseHistory(undefined),
});
const width = Number(params.get("width"));

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");

createRoot(root).render(
  <div style={{ width }}>
    {params.get("surface") === "create" ? (
      // Create agent's Model row, which nests the picker in its recovery.
      <PreferenceRow
        title="Model"
        trailing={
          <CreateModel
            config={DEFAULT_CONFIG}
            disabled={false}
            onChange={() => undefined}
          />
        }
      />
    ) : (
      <SettingsTab
        agent={
          {
            pubkey: "c".repeat(64),
            name: "Gander",
            type: "buzz.goose/goose",
            owner: "a".repeat(64),
            config: DEFAULT_CONFIG,
          } as Agent<Config>
        }
        save={async () => undefined}
        settingsSection="identity"
      />
    )}
  </div>,
);
