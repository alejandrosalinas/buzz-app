// FOUNDATION: Shared conversation UI and plugin-owned tools/renderers; never another data owner.
import type { ComponentType, ReactNode } from "react";
import {
  EmbeddedConversation,
  EmbeddedThread,
  type EmbeddedConversationProps,
  type EmbeddedThreadProps,
} from "./EmbeddedThread";
import { Service, type Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import {
  MessageComposer,
  type MessageComposerProps,
} from "../messages/MessageComposer";
import { MessageRow, type MessageRowProps } from "../messages/MessageRow";
import {
  formatDayGroupLabel,
  formatFullTimestamp,
  formatItemTimestamp,
} from "../../shared/datetime";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import type {
  AttachmentRenderer,
  CodeBlockRenderer,
  ComposerTool,
  ComposerAccessory,
  ComposerCompletion,
  InlineRenderer,
  LinkRenderer,
  MessageRenderer,
  MessageAction,
  ContributionReader,
  PageTabsProps,
} from "./contracts";
import type { RelaySession } from "../relay/session";

/** A Solo chat's sidebar icon: what the plugin knows about the chat, or
 * `fallback` when it has nothing to show. */
export type ChatIconProps = Readonly<{
  session: RelaySession;
  channelId: string;
  fallback: ReactNode;
}>;
export type ChatIcon = Readonly<{
  id: string;
  component: ComponentType<ChatIconProps>;
}>;

export type ChatMenuProps = Readonly<{
  session: RelaySession;
  channelId: string;
}>;
export type ChatMenu = Readonly<{
  id: string;
  component: ComponentType<ChatMenuProps>;
}>;

export type Conversation = {
  chatMenus: ContributionReader<ChatMenu>;
  registerChatMenu(component: ComponentType<ChatMenuProps>): void;
  attachments: ContributionReader<AttachmentRenderer>;
  registerAttachment(renderer: AttachmentRenderer): void;
  messages: ContributionReader<MessageRenderer>;
  registerMessage(renderer: MessageRenderer): void;
  accessories: ContributionReader<ComposerAccessory>;
  registerAccessory(accessory: ComposerAccessory): void;
  tools: ContributionReader<ComposerTool>;
  registerTool(tool: ComposerTool): void;
  completions: ContributionReader<ComposerCompletion>;
  registerCompletion(provider: ComposerCompletion): void;
  inline: ContributionReader<InlineRenderer>;
  registerInline(renderer: InlineRenderer): void;
  links: ContributionReader<LinkRenderer>;
  registerLink(renderer: LinkRenderer): void;
  codeBlocks: ContributionReader<CodeBlockRenderer>;
  registerCodeBlock(renderer: CodeBlockRenderer): void;
  actions: ContributionReader<MessageAction>;
  registerMessageAction(action: MessageAction): void;
  ui: {
    Thread: (props: EmbeddedThreadProps) => ReactNode;
    /** One channel's message management, edit target and overlays for a page's
     * own `Message` rows and `Composer`, without visiting the channel. */
    Conversation: (props: EmbeddedConversationProps) => ReactNode;
    Composer: (props: Omit<MessageComposerProps, "extensions">) => ReactNode;
    Message: (props: Omit<MessageRowProps, "extensions">) => ReactNode;
    /** The page's content as the first tab, beside conversations it opens;
     * absent until a plugin provides the tab workspace, as Channels does. */
    readonly Tabs?: ((props: PageTabsProps) => ReactNode) | undefined;
  };
  /** Provides `ui.Tabs` while the providing plugin runs; the first one wins. */
  registerTabs(component: ComponentType<PageTabsProps>): void;
  /** Solo chat icons; the sidebar shows the first one. */
  chatIcons: ContributionReader<ChatIcon>;
  /** Shows `component` as each Solo chat's sidebar icon while the providing
   * plugin runs. */
  registerChatIcon(component: ComponentType<ChatIconProps>): void;
  /** The host's date labels, so plugin text reads like the message rows. */
  format: {
    /** "9:05 AM", "Yesterday", "Monday", "Sat, Jun 20", "Jun 20, 2025";
     * `withTime` appends " at 9:05 AM" outside today. */
    itemTimestamp: typeof formatItemTimestamp;
    /** The day divider: "Today", "Yesterday", "Monday", "Saturday, June 20",
     * "June 20, 2025". */
    dayGroupLabel: typeof formatDayGroupLabel;
    /** The hover text on a byline: "Friday, October 2, 2026 at 3:05:09 PM EDT". */
    fullTimestamp: typeof formatFullTimestamp;
    /** Link previews: "just now", "5 minutes ago", "3 days ago", "on Jun 20". */
    relativeTimestamp: typeof relativeTimestamp;
  };
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    conversation: Conversation;
  }
}
function validate(
  value:
    | AttachmentRenderer
    | ComposerTool
    | InlineRenderer
    | ComposerCompletion
    | ComposerAccessory
    | LinkRenderer
    | CodeBlockRenderer
    | MessageRenderer
    | MessageAction,
) {
  if (
    !value ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value.id) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.component !== "function"
  )
    throw new Error(
      "A conversation contribution needs an id, title and component",
    );
}
export class ConversationService extends Service implements Conversation {
  readonly attachments;
  private readonly attachmentEntries;
  readonly messages;
  private readonly messageEntries;
  readonly tools;
  readonly accessories;
  private readonly accessoryEntries;
  readonly completions;
  private readonly completionEntries;
  readonly inline;
  private readonly toolEntries;
  private readonly inlineEntries;
  readonly links;
  private readonly linkEntries;
  readonly codeBlocks;
  private readonly codeBlockEntries;
  readonly actions;
  private readonly actionEntries;
  private readonly tabEntries;
  readonly chatMenus;
  private readonly chatMenuEntries;
  readonly chatIcons;
  private readonly chatIconEntries;
  readonly ui: Conversation["ui"];
  constructor(ctx: Context) {
    super(ctx, "conversation");
    const attachments = createContributions<AttachmentRenderer>(ctx);
    this.attachmentEntries = attachments;
    this.attachments = {
      snapshot: attachments.snapshot,
      subscribe: attachments.subscribe,
    };
    const messages = createContributions<MessageRenderer>(ctx);
    this.messageEntries = messages;
    this.messages = {
      snapshot: messages.snapshot,
      subscribe: messages.subscribe,
    };
    const accessories = createContributions<ComposerAccessory>(ctx);
    this.accessoryEntries = accessories;
    this.accessories = {
      snapshot: accessories.snapshot,
      subscribe: accessories.subscribe,
    };
    const tools = createContributions<ComposerTool>(ctx);
    const completions = createContributions<ComposerCompletion>(ctx);
    this.completionEntries = completions;
    this.completions = {
      snapshot: completions.snapshot,
      subscribe: completions.subscribe,
    };
    const inline = createContributions<InlineRenderer>(ctx);
    this.toolEntries = tools;
    this.inlineEntries = inline;
    this.tools = { snapshot: tools.snapshot, subscribe: tools.subscribe };
    this.inline = { snapshot: inline.snapshot, subscribe: inline.subscribe };
    const links = createContributions<LinkRenderer>(ctx);
    this.linkEntries = links;
    this.links = { snapshot: links.snapshot, subscribe: links.subscribe };
    const codeBlocks = createContributions<CodeBlockRenderer>(ctx);
    this.codeBlockEntries = codeBlocks;
    this.codeBlocks = {
      snapshot: codeBlocks.snapshot,
      subscribe: codeBlocks.subscribe,
    };
    const actions = createContributions<MessageAction>(ctx);
    this.actionEntries = actions;
    this.actions = { snapshot: actions.snapshot, subscribe: actions.subscribe };
    const tabs = createContributions<{
      id: string;
      component: ComponentType<PageTabsProps>;
    }>(ctx);
    this.tabEntries = tabs;
    const chatMenus = createContributions<ChatMenu>(ctx);
    this.chatMenuEntries = chatMenus;
    this.chatMenus = {
      snapshot: chatMenus.snapshot,
      subscribe: chatMenus.subscribe,
    };
    const chatIcons = createContributions<ChatIcon>(ctx);
    this.chatIconEntries = chatIcons;
    this.chatIcons = {
      snapshot: chatIcons.snapshot,
      subscribe: chatIcons.subscribe,
    };
    const Tabs = (props: PageTabsProps) => {
      const Provided = tabs.snapshot()[0]?.component;
      return Provided ? <Provided {...props} /> : null;
    };
    this.ui = {
      Thread: (props: EmbeddedThreadProps) => (
        <EmbeddedThread {...props} host={this.ctx} extensions={this} />
      ),
      Conversation: (props: EmbeddedConversationProps) => (
        <EmbeddedConversation {...props} host={this.ctx} extensions={this} />
      ),
      Composer: (props: Omit<MessageComposerProps, "extensions">) => (
        <MessageComposer {...props} extensions={this} />
      ),
      Message: (props: Omit<MessageRowProps, "extensions">) => (
        <MessageRow {...props} extensions={this} />
      ),
      get Tabs() {
        return tabs.snapshot().length ? Tabs : undefined;
      },
    };
  }
  registerTabs(component: ComponentType<PageTabsProps>) {
    if (typeof component !== "function")
      throw new Error("Page tabs need a component");
    this.tabEntries.register(this.ctx, { id: "tabs", component });
  }
  registerChatMenu(component: ComponentType<ChatMenuProps>) {
    if (typeof component !== "function")
      throw new Error("A chat menu needs a component");
    this.chatMenuEntries.register(this.ctx, { id: "chat-menu", component });
  }
  registerChatIcon(component: ComponentType<ChatIconProps>) {
    if (typeof component !== "function")
      throw new Error("A chat icon needs a component");
    this.chatIconEntries.register(this.ctx, { id: "chat-icon", component });
  }
  registerMessageAction(value: MessageAction) {
    validate(value);
    if (
      typeof value.matches !== "function" ||
      (value.icon !== undefined && typeof value.icon !== "function") ||
      (value.marker !== undefined && typeof value.marker !== "function")
    )
      throw new Error("A message action needs a matcher");
    this.actionEntries.register(this.ctx, value);
  }
  registerAttachment(value: AttachmentRenderer) {
    validate(value);
    if (typeof value.matches !== "function")
      throw new Error("An attachment renderer needs a matcher");
    if (
      value.order !== undefined &&
      typeof value.order !== "number" &&
      typeof value.order !== "function"
    )
      throw new Error(
        "An attachment renderer order must be a number or function",
      );
    this.attachmentEntries.register(this.ctx, value);
  }
  registerMessage(value: MessageRenderer) {
    validate(value);
    if (typeof value.matches !== "function")
      throw new Error("A message renderer needs a matcher");
    if (
      value.ownsAttachment !== undefined &&
      typeof value.ownsAttachment !== "function"
    )
      throw new Error("A message renderer's ownsAttachment must be a function");
    this.messageEntries.register(this.ctx, value);
  }
  registerAccessory(value: ComposerAccessory) {
    validate(value);
    if (
      value.placement !== undefined &&
      !["composer", "message", "response"].includes(value.placement)
    )
      throw new Error("Invalid accessory placement");
    this.accessoryEntries.register(this.ctx, value);
  }
  registerTool(value: ComposerTool) {
    validate(value);
    this.toolEntries.register(this.ctx, value);
  }
  registerCompletion(value: ComposerCompletion) {
    validate(value);
    if (typeof value.match !== "function")
      throw new Error("A completion provider needs a matcher");
    this.completionEntries.register(this.ctx, value);
  }
  registerInline(value: InlineRenderer) {
    validate(value);
    if (typeof value.matches !== "function")
      throw new Error("An inline renderer needs a matcher");
    this.inlineEntries.register(this.ctx, value);
  }
  registerLink(value: LinkRenderer) {
    validate(value);
    if (typeof value.matches !== "function")
      throw new Error("A link renderer needs a matcher");
    if (
      value.order !== undefined &&
      typeof value.order !== "number" &&
      typeof value.order !== "function"
    )
      throw new Error("A link renderer order must be a number or function");
    if (value.className !== undefined && typeof value.className !== "string")
      throw new Error("A link renderer class must be a string");
    this.linkEntries.register(this.ctx, value);
  }
  registerCodeBlock(value: CodeBlockRenderer) {
    validate(value);
    if (typeof value.matches !== "function")
      throw new Error("A code block renderer needs a matcher");
    if (value.action !== undefined && typeof value.action !== "function")
      throw new Error("A code block action must be a component");
    this.codeBlockEntries.register(this.ctx, value);
  }
  readonly format = Object.freeze({
    itemTimestamp: formatItemTimestamp,
    dayGroupLabel: formatDayGroupLabel,
    fullTimestamp: formatFullTimestamp,
    relativeTimestamp,
  });
}
