// FOUNDATION: Preview conversation contribution contract; data and delivery stay session-owned.
import type { ComponentType, ReactElement, ReactNode, Ref } from "react";
import type { Contribution, MatchOrder } from "../../plugins/contributions";
import type { VoiceRecording } from "../relay/voice-media";
import type { Attachment, ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ComposerSession } from "../messages/composer-session";

/**
 * Opens a target, such as a plugin panel URL, where the conversation host
 * places it. In a channel or thread, panel targets open as side-pane tabs.
 */
export type TargetOpener = Readonly<{
  /** Presentation only; the host re-resolves targets when opening. */
  canOpen(target: string): boolean;
  /** False when nothing can open the target, outside a conversation host,
   * or after this contribution or its placement retires. */
  open(target: string): boolean;
}>;
/** Editor-independent reference to plugin content. Not an access grant or recipient. */
export type ComposerResource = Readonly<{ uri: string; label: string }>;
export type ComposerToolProps = Readonly<{
  session: ComposerSession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  /** Sessions may offer library agents; the host confirms channel admission before sending. */
  inviteAgents?: boolean | undefined;
  disabled: boolean;
  /** Read-only: who the draft mentions, in draft order. The tool re-renders when
   * this changes; the array keeps its identity while only the prose changes. */
  recipients: readonly Readonly<{ pubkey: string; name: string }>[];
  /** Solo, alone with agents: who hears the message. Inline mentions decide
   * when there are any; otherwise the toolbar's agents stand in. `only`
   * replaces those stand-ins with a non-empty list and `toggle` adds or
   * removes one, never the last; they also follow each send. While inline
   * mentions decide, `toggle` adds or removes that mention instead. Absent
   * elsewhere, where mentions alone decide. */
  audience?:
    | Readonly<{
        recipients: readonly Readonly<{ pubkey: string; name: string }>[];
        /** True while inline mentions in the text decide, so picks only change the stand-ins. */
        named: boolean;
        only(
          recipients: readonly Readonly<{ pubkey: string; name: string }>[],
        ): void;
        toggle(recipient: Readonly<{ pubkey: string; name: string }>): void;
      }>
    | undefined;
  /** False after removal, destination change, read-only state or a rejected edit. */
  insertText(text: string): boolean;
  /** Atomically insert display text and explicit notification intent at the caret.
   * Prose never resolves to identities. Membership is checked by session delivery.
   * Like insertText, this command is revoked with the tool/destination lifetime. */
  insertMention(recipient: Readonly<{ pubkey: string; name: string }>): boolean;
  /** All-or-nothing insertion of a saved selection as individual mentions. */
  insertMentions(
    recipients: readonly Readonly<{ pubkey: string; name: string }>[],
  ): boolean;
  /** Replace all selected mentions in one undoable edit, preserving prose and focus.
   * An empty selection clears mentions. Rejected while editing a sent message. */
  replaceRecipients(
    recipients: readonly Readonly<{ pubkey: string; name: string }>[],
  ): boolean;
  /** Automatic targeting only: reject when text outside selected mentions is nonempty.
   * Older hosts may omit this command. A rejected edit must not trigger unrestricted replacement. */
  replaceRecipientsIfEmpty?(
    recipients: readonly Readonly<{ pubkey: string; name: string }>[],
  ): boolean;
  /** Atomically insert a host-owned inline resource at the caret. The host validates
   * the link, escapes the label and sends exactly `[label](uri)` there; the draft
   * keeps it after tool removal. Otherwise returns the host's user-facing reason. */
  insertResource(resource: ComposerResource): true | string;
  capture?(
    component: ComponentType<ComposerCaptureProps>,
  ): (() => void) | false;
  focus(): void;
}> &
  TargetOpener;
export type ComposerCaptureProps = Readonly<{
  accept(recording: VoiceRecording): boolean;
  cancel(): void;
}>;
export type FileCardProps = Readonly<{
  attachment: Attachment;
  source: string;
  onOpenLink(url: string): boolean;
  onPreview?: (() => void) | undefined;
  typeLabel?: string | undefined;
}>;
export type AttachmentRendererProps = Readonly<{
  attachment: Attachment;
  source: string;
  placement?: "message" | "composer";
  message?: ChannelMessage | undefined;
  FileCard?: ComponentType<FileCardProps> | undefined;
  onRemove?: (() => void) | undefined;
}> &
  TargetOpener;
export type AttachmentRenderer = Readonly<{
  id: string;
  title: string;
  matches(attachment: Attachment): boolean;
  /** Claim strength when several renderers match an attachment; see `MatchOrder`. */
  order?: MatchOrder<Attachment> | undefined;
  component: ComponentType<AttachmentRendererProps>;
}>;
export type ReactionToolProps = Readonly<{
  session: RelaySession;
  scope: string;
  disabled: boolean;
  /** Host-owned reaction intent; revoked when the tool or target is removed. */
  select(emoji: string): boolean;
}>;
export type ComposerTool = Readonly<{
  id: string;
  title: string;
  /** Lower values appear first; defaults to zero. Equal values sort by contribution key. */
  order?: number;
  component: ComponentType<ComposerToolProps>;
  /** Optional emoji-only chooser for the message reaction row. */
  reactionComponent?: ComponentType<ReactionToolProps>;
}>;
export type InlineContent = Readonly<{
  text: string;
  message: ChannelMessage;
  reaction?: ChannelMessage["reactions"][number] | undefined;
}>;
export type InlineRange = Readonly<{ start: number; end: number }>;
export type InlineRenderer = Readonly<{
  id: string;
  title: string;
  /** UTF-16 ranges within this plain-text segment. Links are never offered. */
  matches(content: InlineContent): readonly InlineRange[];
  component: ComponentType<
    TargetOpener & {
      text: string;
      content: InlineContent;
      media(url: string): string | undefined;
    }
  >;
}>;
/** Link presentation only. The host retains the anchor, destination and activation. */
export type LinkRenderer = Readonly<{
  id: string;
  title: string;
  matches(url: string): boolean;
  /** Claim strength when several renderers match a URL; see `MatchOrder`. */
  order?: MatchOrder | undefined;
  className?: string | undefined;
  component: ComponentType<{ url: string }>;
}>;
export type LinkPreviewProps = Readonly<{
  url: string;
  /** The host's id for the message the link is in. */
  messageId: string;
  /** Opens `url` through the host, as clicking the link does. False once the
   * contribution or message retires. */
  open(): boolean;
}>;
/** A card below a message for one of its links. The lowest `order` among
 * matches draws it, so a plugin can claim its own URLs ahead of the default
 * web card; a component that renders nothing leaves the link without a card.
 * Links written `<url>`, in code, or naming an attachment get no card. */
export type LinkPreviewRenderer = Readonly<{
  id: string;
  title: string;
  matches(url: string): boolean;
  /** Claim strength when several renderers match a URL; see `MatchOrder`. */
  order?: MatchOrder | undefined;
  component: ComponentType<LinkPreviewProps>;
}>;
/** Presentation for a fenced code block, chosen by its info-string language.
 * The host retains the frame and copy action; failure or removal restores the code. */
export type CodeBlockRenderer = Readonly<{
  id: string;
  title: string;
  matches(language: string): boolean;
  component: ComponentType<{ code: string; language: string }>;
  /** A control the host places before its copy action, such as expanding the block. */
  action?: ComponentType<{ code: string; language: string }> | undefined;
}>;
export type ContributionReader<T> = Readonly<{
  snapshot(): readonly Contribution<T>[];
  subscribe(listener: () => void): () => void;
}>;
/** Optional presentation supplied to the host-owned thread button. */
export type MessageSummaryActivity = Readonly<{
  participants: readonly string[];
  content: ReactNode;
  label: string;
  ref: Ref<HTMLButtonElement>;
}>;
export type ComposerAccessoryProps = Readonly<{
  session: RelaySession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  /** Present only for message-placed accessories; the exact triggering row. */
  message?: ChannelMessage;
  /** Agents already represented by subsequent content in this request's visible run. */
  representedAgents?: readonly string[] | undefined;
  /** Agents with a later public reply to this request; their outcome captions
   * follow that reply instead of this message. */
  repliedAgents?: readonly string[] | undefined;
  /** The request this row is its author's latest public reply to; that
   * author's outcome caption follows this row. */
  stoppedRequest?: ChannelMessage | undefined;
  /** Host geometry for response-side accessories. */
  messageLayout?: "timeline" | "thread" | "continuation" | undefined;
  /** A single selected decorator may wrap the host summary with its preview.
   * Render without activity when idle; the host owns reply counts/navigation. */
  renderMessageSummary?:
    | ((activity?: MessageSummaryActivity) => ReactElement | null)
    | undefined;
  /** Host-owned thread navigation from a timeline message, even before replies.
   * Absent inside the thread. False after this contribution or message retires. */
  openThread?: (() => boolean) | undefined;
  /** Return keyboard focus to a stable host control when a focused accessory retires. */
  onFocusedRemoval?: (() => void) | undefined;
  /** Presentation only; the host re-resolves targets. No editor or access grant. */
  canOpen(target: string): boolean;
  /** False after contribution removal or the originating composer retires.
   * A message-placed accessory's target opens in that message's thread, like
   * a link in its body. */
  open(target: string): boolean;
}>;
export type ComposerAccessory = Readonly<{
  /** Defaults to the composer. Message accessories sit beside reactions;
   * response accessories occupy an incoming row after the triggering message. */
  placement?: "composer" | "message" | "response";
  /** Opt into decorating the message summary; only the first ordered owner wins. */
  decoratesMessageSummary?: boolean;
  id: string;
  title: string;
  order?: number;
  component: ComponentType<ComposerAccessoryProps>;
}>;
/** A whole message body, not an inline Markdown segment. No data or delivery ownership. */
export type MessageRenderer = Readonly<{
  id: string;
  title: string;
  matches(message: ChannelMessage): boolean;
  /** True for each attachment the component draws itself. The host leaves
   * those out of its attachment list only while it draws the component, and
   * lists them again if the component fails. A throwing claim is treated as
   * false. */
  ownsAttachment?(
    message: ChannelMessage,
    attachment: ChannelMessage["attachments"][number],
  ): boolean;
  component: ComponentType<TargetOpener & { message: ChannelMessage }>;
}>;
/** A message action. The host owns placement, focus and row lifetime. */
export type MessageAction = Readonly<{
  id: string;
  title: string;
  icon?: ComponentType;
  matches(message: ChannelMessage, session: RelaySession): boolean;
  /** `menu` mounts inside the menu. `toolbar` uses a host icon button.
   * Without a placement, the host adds a menu entry that opens the component. */
  placement?: "menu" | "toolbar";
  /** Mounted on activation, or inside the menu for `menu`; call close() to dismiss. */
  component: ComponentType<
    TargetOpener & {
      message: ChannelMessage;
      session: RelaySession;
      close(): void;
    }
  >;
  /**
   * Optional presentation beside the message timestamp, such as a state mark.
   * Rendered only while `matches` passes: hiding the menu entry hides the mark.
   */
  marker?: ComponentType<{ message: ChannelMessage; session: RelaySession }>;
}>;
/** Presentation after a person's name in @mention suggestions, such as an
 * identity check. The host owns placement, focus and the row; the component
 * decides from `pubkey` whether to draw anything. */
export type IdentityMark = Readonly<{
  id: string;
  title: string;
  component: ComponentType<IdentityMarkProps>;
}>;
/** `profiles` is the session's shared profile directory, whose entries carry
 * community verification (`verified`) when the community provides it. */
export type IdentityMarkProps = Readonly<{
  pubkey: string;
  profiles: RelaySession["profiles"];
}>;
export type ConversationExtensions = Readonly<{
  attachments?: ContributionReader<AttachmentRenderer>;
  messages?: ContributionReader<MessageRenderer>;
  actions?: ContributionReader<MessageAction>;
  identityMarks?: ContributionReader<IdentityMark>;
  accessories?: ContributionReader<ComposerAccessory>;
  tools: ContributionReader<ComposerTool>;
  inline: ContributionReader<InlineRenderer>;
  completions?: ContributionReader<ComposerCompletion>;
  links?: ContributionReader<LinkRenderer>;
  linkPreviews?: ContributionReader<LinkPreviewRenderer>;
  codeBlocks?: ContributionReader<CodeBlockRenderer>;
  annotators?: ContributionReader<ComposerAnnotator>;
}>;

/** One document revision of the draft an annotator may mark: the projected text
 * completion providers observe, without the selection. `prose` lists its
 * ascending, disjoint runs of ordinary prose, outside code, links, chips, line
 * breaks and raw Markdown syntax. */
export type AnnotationObservation = Pick<
  ComposerObservation,
  "revision" | "text"
> &
  Readonly<{ prose: readonly InlineRange[] }>;
/** Text the person may put in place of an annotation's range. `label` names the
 * choice when the text alone would not, and is required for an empty `text`. */
export type ComposerReplacement = Readonly<{ text: string; label?: string }>;
/** A mark on UTF-16 `[start, end)` of the observed text, which must equal `text`
 * and lie within one prose run. `label` says what is wrong; `kind` announces a
 * spelling or grammar error rather than a general one. */
export type ComposerAnnotation = Readonly<{
  start: number;
  end: number;
  text: string;
  label: string;
  kind?: "spelling" | "grammar" | undefined;
  replacements?: readonly ComposerReplacement[] | undefined;
}>;
export type ComposerAnnotatorProps = CompletionContext &
  Readonly<{
    observation: AnnotationObservation;
    /** Shows annotations for this observation, replacing this annotator's
     * earlier ones. Returns false once the draft has changed or the annotator
     * retired; cleanup of the returned disposer withdraws them. */
    publish(annotations: readonly ComposerAnnotation[]): (() => void) | false;
  }>;
/** A headless component that marks ranges of the focused composer's prose. The
 * host draws the marks and replaces text only when the person picks a
 * replacement; scheduling and the annotations themselves are the plugin's. */
export type ComposerAnnotator = Readonly<{
  id: string;
  title: string;
  component: ComponentType<ComposerAnnotatorProps>;
}>;

/** Immutable host-issued evidence, scoped to one live editor observation. */
export type ComposerObservation = Readonly<{
  revision: number;
  text: string;
  start: number;
  end: number;
}>;
export type CompletionContext = Pick<
  ComposerToolProps,
  "session" | "scope" | "channelId" | "threadRootId" | "inviteAgents"
>;
export type CompletionQuery = Readonly<{
  start: number;
  end: number;
  query: string;
}>;
/** A name the provider cannot decide on yet. The host may hold it as a chip
 * with no recipient and ask `resolve` for the recipient the terminator would
 * have selected once the provider's evidence is complete; null returns the
 * name to prose. `resolve` is headless: the provider has unmounted by then. */
export type CompletionPending = Readonly<{
  name: string;
  resolve(signal: AbortSignal): Promise<CompletionResolution>;
}>;
/** The recipient; null for prose; or, when only longer known names kept the
 * name from selecting over the complete choice set, those names, each
 * resolvable under the same rule. The host may extend the chip over the words
 * typed after it when they complete one of them, and ask that one. */
export type CompletionResolution =
  | Readonly<{ pubkey: string; name: string }>
  | Readonly<{ continued: readonly CompletionPending[] }>
  | null;
export type CompletionEdit =
  | Readonly<{
      text: string;
      mention?: never;
      mentions?: never;
      pending?: never;
    }>
  | Readonly<{
      mention: Readonly<{ pubkey: string; name: string }>;
      text?: never;
      mentions?: never;
      pending?: never;
    }>
  | Readonly<{
      mentions: readonly Readonly<{ pubkey: string; name: string }>[];
      text?: never;
      mention?: never;
      pending?: never;
    }>
  /** Host-only: the terminator typed over an undecided name. Never a suggestion's edit. */
  | Readonly<{
      pending: CompletionPending;
      text?: never;
      mention?: never;
      mentions?: never;
    }>;
export type CompletionSuggestion = Readonly<{
  id: string;
  label: string;
  detail?: string;
  /** Decorative presentation only; the host owns option semantics and interaction. */
  preview?: import("react").ReactNode;
  /**
   * An agent, not a person. The host marks the name and announces "Agent" only
   * for its bundled people providers (mentions, channels); others are ignored.
   */
  agent?: boolean;
  edit: CompletionEdit;
  /** Keep an installed identity in place after eligibility is revoked. */
  disabled?: string | undefined;
  /** Final synchronous evidence check; false never falls through to sending. */
  canSelect?: ((key: string) => boolean) | undefined;
}>;
export type CompletionResult = Readonly<{
  items: readonly CompletionSuggestion[];
  /** Provider-verified unique exact match across its uncapped candidate set. */
  spaceId?: string | undefined;
  /** No `spaceId` yet only because evidence is still arriving; the terminator
   * may hold the query as a pending mention instead of typing a literal. */
  spacePending?: CompletionPending | undefined;
  status?: string;
  /** Optional explicit recovery. A new query or disposal revokes this action. */
  retry?: () => void;
}>;
export type ComposerCompletionProps = CompletionContext &
  Readonly<{
    observation: ComposerObservation;
    query: CompletionQuery;
    /** Publishes only for this query/lifetime; returns false after revocation.
     * Cleanup of the returned disposer withdraws that exact publication. */
    publish(result: CompletionResult): (() => void) | false;
  }>;
export type ComposerCompletion = Readonly<{
  id: string;
  title: string;
  order?: number;
  /** Pure syntax matcher. Host prefers the closest trigger; order/key break ties. */
  match(
    observation: ComposerObservation,
    context: CompletionContext,
  ): CompletionQuery | null;
  component: ComponentType<ComposerCompletionProps>;
}>;

/** A conversation a page opens in a tab beside its own. `messageId` opens at
 * that message: in its thread when `threadId` is given, or else in the
 * conversation, or its thread if it is a reply or too old to find. Without
 * `messageId`, keyboard focus moves to the tab's composer once it is ready,
 * unless the user clicks or types first. */
export type PageTabTarget = {
  channelId: string;
  threadId?: string;
  messageId?: string;
};
/** `keep` opens a tab beside the others instead of in place of the last.
 * `markRead: false` keeps a conversation tab from marking what it shows read,
 * so the page decides; threads read as in Channels. */
export type PageTabOptions = { keep?: boolean; markRead?: boolean };
export type PageTabsProps = {
  /** Keys the page's tabs, which last as long as its community session. */
  id: string;
  session: RelaySession;
  scope: string;
  label: string;
  icon?: ReactNode;
  /** The page's own first tab. `open` shows a joined conversation in a host tab. */
  children(
    open: (target: PageTabTarget, options?: PageTabOptions) => boolean,
    close: (target: PageTabTarget) => boolean,
    isOpen: (target: PageTabTarget) => boolean,
  ): ReactNode;
  /** `false` keeps showing a tab out of its channel visit, so the page decides
   * what is read; tabs visit as Channels tabs do by default. */
  visits?: boolean | undefined;
};
