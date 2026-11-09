import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import { apply } from "../../src/bundled/mesh-compute/index";
import type { PluginModule } from "../../src/plugins/api";
import "../../src/shared/styles/globals.css";

// Synthetic IPC only: no native host, credentials, network discovery or models.
const model = "unsloth/Qwen3.8-27B-GGUF:Q4_K_M";
let sharing: string | null = null;
let enabled = false;
let state = "stopped";
let modelReady = false;
let activity = {
  outputTokens: 0,
  completedRequests: 0,
  finishedRequests: 0,
  retries: 0,
  activeRequests: 0,
  tokensPerSecond: 0,
  otherNodes: 1,
  sharingNodes: 1,
};
const profiles = new Map();
const snapshot = {
  origin: "https://fixture.example",
  status: "ready",
  viewer: "fixture",
  scope: "https://fixture.example:fixture",
  session: {
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
  },
};
const calls: { command: string; args: unknown }[] = [];
Object.assign(window, {
  isTauri: true,
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args?: { model?: string | null }) => {
      calls.push({ command, args });
      switch (command) {
        case "mesh_compute_select":
          return "lease";
        case "mesh_compute_status":
          return {
            available: true,
            sharing,
            savedSharing: enabled ? { model: sharing, enabled } : null,
            lifecycle: { state },
            modelReady,
            activity,
          };
        case "mesh_compute_inventory":
          return { unavailable: null, entries: [] };
        case "mesh_compute_catalog":
          return {
            gpuName: "Apple fixture GPU",
            vramDisplay: "64 GB",
            recommended: model,
            entries: [
              {
                model: "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M",
                name: "Gemma E4B",
                size: "4 GB",
                installed: true,
                curated: true,
                fit: "comfortable",
              },
              {
                model: "unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
                name: "Qwen 9B",
                size: "6 GB",
                installed: true,
                curated: true,
                fit: "comfortable",
              },
              {
                model,
                name: "Qwen 27B",
                size: "17 GB",
                installed: true,
                curated: true,
                fit: "comfortable",
              },
            ],
          };
        case "mesh_compute_share":
          sharing = args?.model ?? null;
          enabled = !!sharing;
          state = enabled ? "ready" : "stopped";
          return;
        case "mesh_compute_widget_open":
        case "mesh_compute_widget_close":
          return;
        case "mesh_compute_release":
          state = "stopped";
          sharing = null;
          return;
        default:
          throw new Error(`Unexpected fixture command: ${command}`);
      }
    },
  },
  meshShareFixture: {
    calls,
    setStatus(next: {
      state: string;
      ready: boolean;
      active: number;
      tokens: number;
    }) {
      state = next.state;
      modelReady = next.ready;
      sharing = model;
      enabled = true;
      activity = {
        ...activity,
        activeRequests: next.active,
        outputTokens: next.tokens,
        completedRequests: next.tokens > 0 && next.active === 0 ? 1 : 0,
      };
    },
  },
});
const agentState = { status: "ready", agents: [], running: [], teams: [] };
const agentTypes: object[] = [];
const created: object[] = [];
Object.assign(window, { meshHelperFixture: { created } });
let Page: ComponentType<{ community?: { id: string; name: string } }> = () =>
  null;
apply({
  relay: { snapshot: () => snapshot, subscribe: () => () => {} },
  communityReader: {
    snapshot: () => ({ viewer: snapshot.viewer }),
    subscribe: () => () => {},
  },
  effect: () => {},
  host: {
    spawn: () => {
      throw new Error("No runtime in UI fixture");
    },
    resolveDirectory: () => {
      throw new Error("No files in UI fixture");
    },
    serveMcp: () => {
      throw new Error("No MCP server in UI fixture");
    },
  },
  agents: {
    register: (type: object) =>
      agentTypes.push({
        ...type,
        key: "buzz.mesh-compute/mesh",
        pluginId: "buzz.mesh-compute",
        revision: "fixture",
      }),
    types: () => agentTypes,
    snapshot: () => agentState,
    subscribe: () => () => {},
    create: async (input: object) => {
      created.push(input);
      return { ...input, pubkey: "a".repeat(64) };
    },
  },
  settingsCards: {
    register: (card: { component: typeof Page }) => {
      Page = card.component;
    },
  },
} as unknown as Parameters<PluginModule["apply"]>[0]);
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <main data-buzz-ui="" className="p-6 bg-surface text-primary">
    <Page community={{ id: "https://fixture.example", name: "Fixture" }} />
  </main>,
);
