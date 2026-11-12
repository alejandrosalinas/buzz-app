import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import {
  profilePanelKey,
  profileActivityViewKey,
} from "../../features/profiles/target";
import { ProfilePanel, type PersonProfileInfoContent } from "./ProfilePanel";

export const inject = [
  "panels",
  "relay",
  "navigation",
  "agents",
  "communityReader",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "profile",
    title: "Profile",
    matches: (target) =>
      !!profilePanelKey(target) || !!profileActivityViewKey(target),
    component: Object.assign(
      (props: PanelProps & PersonProfileInfoContent) => (
        <ProfilePanel
          {...props}
          relay={ctx.relay}
          navigation={ctx.navigation}
          agents={ctx.agents}
          communities={ctx.communityReader}
          linkRenderers={ctx.conversation.links}
        />
      ),
      { supportsPersonInfoContent: true },
    ),
  });
};
