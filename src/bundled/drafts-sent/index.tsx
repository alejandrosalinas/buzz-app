import type { PluginModule } from "../../plugins/api";
import { DraftsSentBadge } from "../../features/drafts-sent/DraftsSentBadge";
import { DraftsSentPage } from "../../features/drafts-sent/DraftsSentPage";

export const inject = [
  "pages",
  "relay",
  "panels",
  "conversation",
  "navigation",
];

/** Opt-in Drafts & sent page, listed in the Messages sidebar. */
export const apply: PluginModule["apply"] = (ctx) => {
  const { relay, panels, navigation: navigator } = ctx;
  ctx.pages.register({
    id: "drafts-sent",
    title: "Drafts & sent",
    layout: "workspace",
    primary: true,
    companion: true,
    handlesNavigation: true,
    badge: () => <DraftsSentBadge relay={relay} />,
    component: ({ companion, navigation }) => (
      <DraftsSentPage
        relay={relay}
        navigator={navigator}
        navigation={navigation}
        companion={companion}
        panels={panels}
        extensions={ctx.conversation}
      />
    ),
  });
};
