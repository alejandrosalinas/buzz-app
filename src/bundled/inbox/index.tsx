import type { PluginModule } from "../../plugins/api";
import { InboxPage } from "./InboxPage";
import { InboxPreview } from "./InboxPreview";
import { inboxRouteTarget, isInboxRoute, type InboxRoute } from "./route";
export const inject = [
  "pages",
  "relay",
  "navigation",
  "conversation",
  "panels",
  "shortcuts",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  // Slack's chords for jumping to a filtered Activity view, including from the composer.
  const open = (
    id: string,
    title: string,
    key: string,
    order: number,
    params: InboxRoute,
  ) =>
    ctx.shortcuts.register({
      id,
      title,
      binding: { key, mod: true, shift: true },
      order,
      allowInEditable: true,
      run: () => {
        void navigator.open(inboxRouteTarget(params));
      },
    });
  open("open-unread", "Open unread in Activity", "a", 20, {
    activity: "all",
    attention: "unread",
  });
  open("open-threads", "Open threads in Activity", "t", 30, {
    activity: "threads",
  });
  open("open-mentions", "Open mentions in Activity", "m", 40, {
    activity: "mentions",
  });
  open("open-dms", "Open DMs in Activity", "k", 50, { activity: "dms" });
  ctx.pages.register({
    id: "inbox",
    title: "Activity",
    layout: "workspace",
    primary: true,
    route: { version: 1, validate: isInboxRoute },
    component: ({ navigation }) => (
      <InboxPage
        relay={relay}
        navigator={navigator}
        tabs={ctx.conversation.ui.Tabs}
        navigation={navigation}
      />
    ),
    preview: ({ close }) => (
      <InboxPreview relay={relay} navigator={navigator} close={close} />
    ),
  });
};
