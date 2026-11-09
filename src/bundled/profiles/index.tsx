import type { PluginModule } from "../../plugins/api";
import {
  profilePanelKey,
  profileActivityViewKey,
} from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";

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
    component: (props) => (
      <ProfilePanel
        {...props}
        relay={ctx.relay}
        navigation={ctx.navigation}
        agents={ctx.agents}
        communities={ctx.communityReader}
        linkRenderers={ctx.conversation.links}
      />
    ),
  });
};
