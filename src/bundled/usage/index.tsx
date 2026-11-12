import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { RelayData } from "../../features/relay/service";
import { ChartBarIcon } from "../../shared/design-system/icons";
import { UsagePage } from "./UsagePage";

export const inject = ["settingsCards", "agents", "navigation", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, navigation, relay } = ctx;
  ctx.settingsCards.register({
    id: "usage",
    title: "Usage",
    icon: ChartBarIcon,
    group: "Plugins",
    component: () => (
      <UsageCard agents={agents} relay={relay} open={navigation.open} />
    ),
  });
};

/** Each community's filters are its own: a switch shows that community's. */
function UsageCard({
  agents,
  relay,
  open,
}: {
  agents: Agents;
  relay: RelayData;
  open: Navigation["open"];
}) {
  const scope = useSyncExternalStore(
    relay.subscribe,
    () => relay.snapshot().scope,
    () => relay.snapshot().scope,
  );
  return (
    <UsagePage key={scope} viewScope={scope} agents={agents} open={open} />
  );
}
