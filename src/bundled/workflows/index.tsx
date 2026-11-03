import type { PluginModule } from "../../plugins/api";
import { WorkflowsPage } from "./WorkflowsPage";
import { workflowsRoute } from "./routes";
export const inject = ["pages", "relay", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { relay, navigation: navigator } = ctx;
  ctx.pages.register({
    id: "workflows",
    title: "Workflows",
    layout: "workspace",
    primary: true,
    route: { version: 1, validate: (params) => !!workflowsRoute(params) },
    component: ({ navigation }) => (
      <WorkflowsPage
        relay={relay}
        navigator={navigator}
        {...(navigation ? { navigation } : {})}
      />
    ),
  });
};
