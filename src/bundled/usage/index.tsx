import type { PluginModule } from "../../plugins/api";
import { ChartBarIcon } from "../../shared/design-system/icons";
import { UsagePage } from "./UsagePage";

export const inject = ["settingsCards", "agents", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, navigation } = ctx;
  ctx.settingsCards.register({
    id: "usage",
    title: "Usage",
    icon: ChartBarIcon,
    group: "Plugins",
    component: () => <UsagePage agents={agents} open={navigation.open} />,
  });
};
