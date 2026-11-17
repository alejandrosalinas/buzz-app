import type { SidebarContextProps } from "../../features/sidebar/contracts";
import { useSyncExternalStore } from "react";
import { MessagesSidebar } from "./MessagesSidebar";
import { soloSidebarSource } from "./SoloSidebarSource";
import { teamSidebarSource } from "./TeamSidebarSource";
import { StartLinkedChat, canStartLinkedChatFrom } from "./StartLinkedChat";
import { ChannelCompletion } from "./ChannelCompletion";
import { channelQuery } from "./channel-query";
import { isChannelRoute } from "../../features/channel-navigation/routes";
import type { PluginModule } from "../../plugins/api";
import { ChannelsPage } from "./ChannelsPage";
import { ConversationWorkspace, PageTabs } from "./PageTabs";
import { registerCanvas } from "./canvas-panel";
import { ChannelTemplateSettings } from "./ChannelTemplateSettings";
import { ChatCircleIcon, CopyIcon } from "../../shared/design-system/icons";
import { isApplePlatform } from "../../features/shortcuts/format";
import type { ArchiveShortcut, ReadShortcut } from "./ChannelsPage";
import {
  conversationRows,
  inFieldOutsideComposer,
  inTerminal,
  stepConversation,
} from "./conversation-rows";
export const inject = [
  "pages",
  "relay",
  "panels",
  "conversation",
  "navigation",
  "settingsCards",
  "agents",
  "shortcuts",
  "communityReader",
  "adminAccess",
];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.reflect.get("sidebarSections")?.registerContext?.({
    id: "messages",
    page: "buzz.channels/channels",
    matches: () => true,
    order: 100,
    component: function MessagesContext(props: SidebarContextProps) {
      const client = useSyncExternalStore(
        ctx.communityReader.subscribe,
        ctx.communityReader.snapshot,
      );
      return (
        <MessagesSidebar
          {...props}
          relay={ctx.relay}
          navigator={ctx.navigation}
          agents={ctx.agents}
          federatedIdentity={ctx.reflect.get("federatedIdentity")}
          memberships={client.memberships}
          chatIcons={ctx.conversation.chatIcons}
          chatMenus={ctx.conversation.chatMenus}
          sidebarSections={ctx.reflect.get("sidebarSections")}
          sidebarScope={ctx.reflect.get("sidebarScope")}
          sidebarRows={ctx.reflect.get("sidebarRows")}
        >
          {props.children}
        </MessagesSidebar>
      );
    },
  });
  ctx.reflect.get("sidebarSections")?.registerSource?.(soloSidebarSource);
  ctx.reflect.get("sidebarSections")?.registerSource?.(teamSidebarSource);
  registerCanvas(ctx);
  ctx.conversation.registerCompletion({
    id: "channel-typeahead",
    title: "Channel",
    match: ({ text, start }) => channelQuery(text, start),
    component: ChannelCompletion,
  });
  const extensions = ctx.conversation;
  extensions.registerTabs((props) => (
    <PageTabs {...props} host={ctx} extensions={extensions} />
  ));
  extensions.registerWorkspace((props) => (
    <ConversationWorkspace {...props} host={ctx} extensions={extensions} />
  ));
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  ctx.conversation.registerMessageAction({
    id: "start-solo-chat",
    title: "Start Solo chat",
    placement: "menu",
    icon: () => <ChatCircleIcon size={16} aria-hidden="true" />,
    matches: canStartLinkedChatFrom,
    component: ({ message, session }) => (
      <StartLinkedChat
        session={session}
        navigation={navigator}
        channelId={message.channelId}
        message={message}
      />
    ),
  });
  const panels = ctx.panels;
  const archive: ArchiveShortcut = {};
  ctx.shortcuts.register({
    id: "archive-chat",
    title: "Archive chat",
    // Apple Mail's Archive. Elsewhere Ctrl is Mod, and Ctrl+Shift+A opens Inbox unread.
    binding: isApplePlatform(globalThis.navigator?.platform ?? "")
      ? { key: "a", mod: true, ctrl: true }
      : { key: "e", mod: true, shift: true },
    order: 20,
    allowInEditable: true,
    when: () => !!archive.current?.available(),
    run: () => archive.current?.run(),
  });
  // Slack's sidebar stepping. Terminals and text fields outside the composer
  // keep Option+Arrow, and stepping is unavailable (the key is left alone)
  // while the sidebar renders no rows.
  const stepping = [
    ["previous-conversation", "Previous conversation", "ArrowUp", false, 30],
    ["next-conversation", "Next conversation", "ArrowDown", false, 31],
    [
      "previous-unread-conversation",
      "Previous unread conversation",
      "ArrowUp",
      true,
      32,
    ],
    [
      "next-unread-conversation",
      "Next unread conversation",
      "ArrowDown",
      true,
      33,
    ],
  ] as const;
  for (const [id, title, key, unreadOnly, order] of stepping)
    ctx.shortcuts.register({
      id,
      title,
      binding: { key, alt: true, shift: unreadOnly },
      order,
      allowInEditable: true,
      when: () =>
        !inTerminal() &&
        !inFieldOutsideComposer() &&
        conversationRows().length > 0,
      run: () =>
        stepConversation(key === "ArrowUp" ? "previous" : "next", unreadOnly),
    });
  const read: ReadShortcut = {};
  ctx.shortcuts.register({
    id: "mark-read",
    title: "Mark conversation as read",
    binding: { key: "Escape" },
    order: 40,
    allowInEditable: true,
    // Escape in a terminal belongs to its shell.
    when: () => !inTerminal() && !!read.current?.available(),
    run: () => read.current?.run(),
  });
  const agents = ctx.agents;
  const membership = ctx.adminAccess.membership;
  ctx.settingsCards.register({
    id: "templates",
    title: "Channel templates",
    group: "App",
    icon: CopyIcon,
    component: ({ active }) => (
      <ChannelTemplateSettings agents={agents} active={active} />
    ),
  });
  ctx.pages.register({
    id: "channels",
    title: "Channels",
    primary: true,
    placement: "dock",
    layout: "workspace",
    companion: true,
    handlesNavigation: true,
    route: { version: 1, validate: isChannelRoute },
    component: ({ companion, navigation }) => (
      <ChannelsPage
        chatMenus={ctx.conversation.chatMenus}
        navigation={navigation}
        navigator={navigator}
        extensions={extensions}
        relay={relay}
        panels={panels}
        archive={archive}
        read={read}
        companion={companion}
        agents={agents}
        communities={ctx.communityReader}
        membership={membership}
      />
    ),
  });
};
