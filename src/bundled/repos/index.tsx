import type { PluginModule } from "../../plugins/api";
import { parseEntityRoute } from "../../features/repos/routes";
import { RepoPage } from "./RepoPage";
import { ResourcePicker } from "./ResourcePicker";

export const inject = ["pages", "relay", "navigation", "conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "repos",
    title: "Repository",
    layout: "workspace",
    primary: false,
    handlesNavigation: true,
    route: {
      version: 1,
      validate: (params) => parseEntityRoute(params) !== null,
    },
    component: (props) => (
      <RepoPage
        {...props}
        relay={ctx.relay}
        open={ctx.navigation.open}
        codeBlocks={ctx.conversation.codeBlocks}
      />
    ),
  });
  ctx.conversation.registerTool({
    id: "resources",
    title: "Issues and pull requests",
    component: ResourcePicker,
  });
};
