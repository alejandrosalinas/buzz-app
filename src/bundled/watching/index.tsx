import type { PluginModule } from "../../plugins/api";
import { createTab } from "./Tab";

export const inject = ["agents", "relay", "navigation"];
export const apply: PluginModule["apply"] = ({ agents, relay, navigation }) => {
  // Attention runs only while this plugin is on to show and control it.
  agents.controlAttention();
  agents.registerTab({
    id: "watching",
    title: "Attention",
    // Hosted agents have no attention on this device.
    when: (agent) => agent.place === "here",
    component: createTab({ agents, relay, navigation }),
  });
};
