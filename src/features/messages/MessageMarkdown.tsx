import { useChannelIdentityNames } from "../identity-names/react";
import {
  createContext,
  isValidElement,
  memo,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import type { ComposerSession } from "./composer-session";
import { MessageLink } from "../conversation/MessageLink";
import { parseBuzzLink } from "../navigation/buzz-links";
import { messageLinkParts } from "./message-link-parts";
import { labelText } from "./label-text";
import {
  ReferenceText,
  channelForLink,
  channelLinkLabel,
  emptyReferenceDirectory,
  MentionLabel,
} from "./ReferenceText";
import { CopyIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { profileKey } from "../profiles/target";
import referenceStyles from "../../shared/InlineReference.module.css";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkSpoilers } from "./remark-spoilers";
import type {
  CodeBlockRenderer,
  ContributionReader,
  ConversationExtensions,
} from "../conversation/contracts";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import { resolveMatch } from "../../plugins/contributions";
import { InlineText } from "../conversation/InlineText";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { emojiMatches, linkPart, messageParts } from "../relay/emoji";
import { safeLinkUrl, visibleHtmlSource } from "../relay/message-content";
import styles from "./Messages.module.css";
import { profileMentionNames, profileMentionParts } from "./profile-mentions";
import {
  isLiteralMarkdownContext,
  isPlainProse,
  plainProseTree,
  prepareMarkdown,
  type LiteralRange,
  type PreparedMarkdown,
} from "./markdown-preparation";
import { writeClipboardText } from "../../shared/clipboard";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  alt?: string;
  identifier?: string;
  label?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
};

type InlinePart = {
  text: string;
  target?: string | undefined;
  literal?: boolean;
};
type ProtectedContent = {
  content: string;
  prefix: string;
  parts: InlinePart[];
};
/** Bind exact names on the FULL signed body, before Markdown decodes escapes or
 * divides emphasis. Reference labels must also survive unchanged for resolution. */
function protectInlineContent(
  row: Pick<
    ChannelMessage,
    | "content"
    | "edited"
    | "attachmentSeams"
    | "mentions"
    | "mentionReferences"
    | "emoji"
  >,
  profiles: ReadonlyMap<string, Profile> | undefined,
  literalRanges: readonly LiteralRange[],
  agents: typeof emptyReferenceDirectory.agents,
  spoilerDelimiters: readonly number[],
): ProtectedContent {
  let rangeIndex = 0;
  const isLiteral = (start: number, end: number) => {
    while (
      literalRanges[rangeIndex] &&
      (literalRanges[rangeIndex]?.end ?? 0) <= start
    )
      rangeIndex++;
    return (literalRanges[rangeIndex]?.start ?? Infinity) < end;
  };

  // Numeric entities can manufacture private-use characters during parsing too.
  // Choose an unused prefix in that decoded source; never trust a fixed marker.
  const decoded = row.content.replace(
    /&#(x[a-f\d]{1,6}|\d{1,7});/gi,
    (entity, number: string) => {
      const code =
        number[0]?.toLowerCase() === "x"
          ? Number.parseInt(number.slice(1), 16)
          : Number.parseInt(number, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
  const used = new Set(
    [...decoded.matchAll(/[\uE000\uFFFC](\d+)\uE001/g)].map(
      (match) => match[1],
    ),
  );
  let nonce = 0;
  while (used.has(String(nonce))) nonce++;
  const prefix = `\uE000${nonce}\uE001`;
  const parts: InlinePart[] = [];
  const token = (part: InlinePart) => {
    parts.push(part);
    // Mention edges must keep their punctuation class for emphasis flanking:
    // @Honey* beside italic ! is punctuation on both sides, not a word. The
    // wire itself holds no emphasis there for a parser that does not split
    // out the mention first, since the name's star and the delimiter merge
    // into one run; the exact signed name was kept over italics that other
    // clients could read.
    // U+FFFC is a Unicode symbol, not Markdown syntax. Keep it inside the
    // nonce-protected token so restoration removes only generated characters.
    const start = part.target ? `\uFFFC${nonce}\uE001` : prefix;
    const end =
      part.target && /[\p{P}\p{S}]$/u.test(part.text) ? "\uFFFC" : "\uE002";
    return `${start}${parts.length - 1}${end}`;
  };
  let offset = 0;
  const content = profileMentionParts(row, profiles, agents)
    .map((segment) => {
      const start = offset;
      offset += segment.text.length;
      if (segment.target && !isLiteral(start, offset)) return token(segment);
      let partOffset = start;
      return messageParts(segment.text)
        .map((part) => {
          const partStart = partOffset;
          partOffset += part.length;
          const urlPart = linkPart(part);
          let result = "";
          let end = 0;
          // Protect explicitly encoded URL punctuation before GFM's fallback
          // autolinker decodes it. Restore as literal text, not another URL scan.
          const encoded = [...part.matchAll(/&#(58|46|64|x3a|x2e|x40);/gi)].map(
            (match) => ({
              start: match.index,
              end: match.index + match[0].length,
              literal: String.fromCodePoint(
                match[1]?.toLowerCase().startsWith("x")
                  ? Number.parseInt(match[1].slice(1), 16)
                  : Number(match[1]),
              ),
            }),
          );
          const replacements = [
            ...(urlPart
              ? []
              : Array.from(emojiMatches(part, row.emoji ?? []), (match) => ({
                  ...match,
                  literal: undefined,
                }))),
            ...(urlPart ? [] : encoded),
            ...spoilerDelimiters
              .filter(
                (start) =>
                  start >= partStart && start + 2 <= partStart + part.length,
              )
              .map((start) => ({
                start: start - partStart,
                end: start - partStart + 2,
                literal: undefined,
                spoiler: true,
              })),
          ].sort((a, b) => a.start - b.start);
          for (const match of replacements) {
            if (
              match.start < end ||
              isLiteral(partStart + match.start, partStart + match.end)
            )
              continue;
            result += part.slice(end, match.start);
            // Angle punctuation preserves the pipes' emphasis flanking while
            // `<` terminates GFM autolinks. The private-use first character is
            // not an HTML/autolink opener, so this remains a text delimiter.
            result +=
              "spoiler" in match
                ? `<${prefix}spoiler\uE002>`
                : token(
                    match.literal
                      ? { text: match.literal, literal: true }
                      : { text: part.slice(match.start, match.end) },
                  );
            end = match.end;
          }
          return result + part.slice(end);
        })
        .join("");
    })
    .join("");
  return { content, prefix, parts };
}

const placeholderPattern = (protectedContent: ProtectedContent) =>
  new RegExp(
    `[\uE000\uFFFC]${protectedContent.prefix.slice(1)}(\\d+)[\uE002\uFFFC]`,
    "g",
  );

function inlineProtectionKey(
  row: ChannelMessage,
  profiles: ReadonlyMap<string, Profile> | undefined,
  agents: typeof emptyReferenceDirectory.agents,
) {
  const identities = [...row.mentions, ...(row.mentionReferences ?? [])];
  const mentions = identities.map((id) => [
    id,
    ...profileMentionNames(profiles?.get(id)),
  ]);
  const mentioned = new Set(identities);
  const agentNames = agents
    .filter((agent) => mentioned.has(agent.pubkey))
    .map((agent) => [agent.pubkey, agent.name]);
  const emoji = row.emoji?.map(({ shortcode, url }) => [shortcode, url]);
  return JSON.stringify([
    row.edited === true,
    row.attachmentSeams,
    mentions,
    agentNames,
    emoji,
  ]);
}

/** Containers whose children are blocks. Raw HTML anywhere else is inline,
 * including plugin nodes such as `spoiler`, so it stays inline as text. */
const flowParents = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

/** Chat never renders raw HTML, but `<harness>` is still something the author
 * typed. Show the exact source as text, with chat line breaks, instead of
 * dropping it. Complete HTML comments stay hidden (`visibleHtmlSource`).
 * Run last: the source is literal, so no mention, emoji or autolink
 * processing applies. */
function remarkLiteralHtml() {
  const literal = (value: string): MarkdownNode[] =>
    value
      .split(/\r?\n|\r/)
      .flatMap((line, index) => [
        ...(index ? [{ type: "break" }] : []),
        ...(line ? [{ type: "text", value: line }] : []),
      ]);
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return;
      parent.children = parent.children.flatMap((child) => {
        if (child.type !== "html") {
          visit(child);
          return [child];
        }
        const source = visibleHtmlSource(child.value ?? "");
        if (!source.trim()) return [];
        const text = literal(source);
        return !flowParents.has(parent.type)
          ? text
          : [
              {
                type: "paragraph",
                children: text,
                ...(child.position ? { position: child.position } : {}),
              },
            ];
      });
    };
    visit(tree);
  };
}

type HtmlNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
  value?: string;
};
const blockTags = new Set([
  ...["p", "ul", "ol", "li", "blockquote", "pre", "hr", "section"],
  ...["table", "h1", "h2", "h3", "h4", "h5", "h6"],
]);
const isBlock = (node: HtmlNode | undefined) =>
  node?.type === "root" || blockTags.has(node?.tagName ?? "");
/** Bodies keep authored spaces (`white-space: pre-wrap`), so drop the newlines
 * the renderer writes only as markup: between blocks and after a `<br>`. */
function rehypeMarkupNewlines() {
  return function visit(node: HtmlNode) {
    const children = node.children;
    if (!children) return;
    node.children = children.flatMap((child, index) => {
      if (child.type !== "text") {
        visit(child);
        return [child];
      }
      const before = index ? children[index - 1] : node;
      const after = children[index + 1] ?? node;
      let value = child.value ?? "";
      if (before?.tagName === "br" || isBlock(before))
        value = value.replace(/^\n/, "");
      if (isBlock(after)) value = value.replace(/\n$/, "");
      return value ? [{ ...child, value }] : [];
    });
  };
}
/** Lists and quotes the slot descends into, so their last line keeps it. */
const editedSlotContainers = new Set(["ul", "ol", "li", "blockquote"]);
/** Leave a slot after the body's last rendered line for the edited marker:
 * inside a closing paragraph, list item or quote line, else after the last
 * block, including generated footnotes. Parses are cached by content alone, so
 * every body has the slot and rendering decides whether to fill it. */
function rehypeEditedSlot() {
  return (tree: HtmlNode) => {
    let parent = tree;
    for (;;) {
      const last = parent.children
        ?.filter((child) => child.type === "element")
        .at(-1);
      if (last?.tagName === "p") parent = last;
      else if (last && editedSlotContainers.has(last.tagName ?? "")) {
        parent = last;
        continue;
      }
      break;
    }
    parent.children = [
      ...(parent.children ?? []),
      {
        type: "element",
        tagName: "span",
        properties: { dataEditedSlot: "" },
        children: [],
      },
    ];
  };
}

/** GFM ends a bare URL only at whitespace. End it where bare message links end;
 * `<url>` and `[url](url)` keep their destination. */
function remarkBareLinkEnd(content: string) {
  return function visit(parent: MarkdownNode) {
    if (!parent.children) return;
    parent.children = parent.children.flatMap((child) => {
      const text = child.url;
      const { start, end } = child.position ?? {};
      if (
        child.type !== "link" ||
        !text ||
        child.children?.[0]?.value !== text ||
        (start && content.slice(start.offset, end?.offset) !== text)
      ) {
        visit(child);
        return [child];
      }
      const parts = messageLinkParts(text).filter((part) => part.text);
      if (parts.length < 2) return [child];
      return parts.map(({ text: value, url }) => {
        const node = { type: "text", value };
        return url ? { type: "link", url, children: [node] } : node;
      });
    });
  };
}

/** Offer only Markdown prose to profile controls and inline plugins. */
function remarkInlineContent(protectedContent: ProtectedContent) {
  const restore = (value: string) =>
    value.replace(
      placeholderPattern(protectedContent),
      (match, index: string) =>
        protectedContent.parts[Number(index)]?.text ?? match,
    );
  const restoreLiteral = (node: MarkdownNode) => {
    for (const key of [
      "value",
      "url",
      "title",
      "alt",
      "identifier",
      "label",
    ] as const) {
      const value = node[key];
      if (typeof value === "string") node[key] = restore(value);
    }
    for (const child of node.children ?? []) restoreLiteral(child);
  };
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (isLiteralMarkdownContext(parent.type)) {
        restoreLiteral(parent);
        return;
      }
      if (!parent.children) return;
      parent.children = parent.children.flatMap((child) => {
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          return [child];
        }
        const parts: InlinePart[] = [];
        let plain = "";
        let end = 0;
        for (const match of child.value.matchAll(
          placeholderPattern(protectedContent),
        )) {
          plain += child.value.slice(end, match.index);
          const part = protectedContent.parts[Number(match[1])];
          if (part?.target || part?.literal) {
            if (plain) parts.push({ text: plain });
            parts.push(part);
            plain = "";
          } else {
            plain += part?.text ?? match[0];
          }
          end = match.index + match[0].length;
        }
        plain += child.value.slice(end);
        if (plain) parts.push({ text: plain });
        return parts.map((part) => ({
          type: "buzzInlineContent",
          data: {
            hName: "span",
            hProperties: {
              "data-inline-text": part.text,
              ...(part.literal ? { "data-literal-text": "true" } : {}),
              ...(part.target ? { "data-profile-target": part.target } : {}),
            },
          },
        }));
      });
    };
    visit(tree);
  };
}

type MessageComponents = {
  [Tag in "p" | "a" | "img" | "span" | "pre"]: (
    props: ComponentPropsWithoutRef<Tag> & ExtraProps,
  ) => ReactNode;
};
const MessageComponentsContext = createContext<MessageComponents | null>(null);
function useMessageComponents() {
  const components = useContext(MessageComponentsContext);
  if (!components) throw new Error("Missing message rendering context");
  return components;
}
// Keep component types stable: profile/directory updates must not remount a
// focused link or discard its pending preview timer.
const markdownComponents: Components = {
  p: (props) => useMessageComponents().p(props),
  a: (props) => useMessageComponents().a(props),
  img: (props) => useMessageComponents().img(props),
  span: (props) => useMessageComponents().span(props),
  pre: (props) => useMessageComponents().pre(props),
  table: ({ node: _node, ...props }) => (
    <table ref={observeTableOverflow} {...props} />
  ),
};

/** WebKit adds an `overflow-x: auto` scrollbar after flex and grid ancestors
 * have taken their heights, then lays out only the table again. A scrollbar
 * that takes space then overlaps the next row, or leaves a gap when removed.
 * CSS chooses the scrollbar from measured overflow so it is laid out with
 * the ancestors. Observe content too: edits can change scrollWidth without
 * resizing a table at its width cap. Measure on mount because the resize
 * observer's first report arrives after the row's. */
function observeTableOverflow(table: HTMLTableElement | null) {
  if (!table || typeof ResizeObserver === "undefined") return;
  const update = () => {
    const overflow = String(table.scrollWidth > table.clientWidth);
    if (table.dataset.overflow !== overflow) table.dataset.overflow = overflow;
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(table);
  const contentObserver = new MutationObserver(update);
  contentObserver.observe(table, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  return () => {
    observer.disconnect();
    contentObserver.disconnect();
  };
}

export function MessageMarkdown({
  row,
  directory = emptyReferenceDirectory,
  session,
  scope,
  extensions,
  media,
  onOpenLink,
  canOpenLink,
  participantProfiles,
  largeEmoji = false,
  interactive = true,
  edited = false,
}: {
  row: ChannelMessage;
  directory?: typeof emptyReferenceDirectory;
  session?: RelaySession | ComposerSession | undefined;
  scope?: string | undefined;
  extensions?: ConversationExtensions | undefined;
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
  largeEmoji?: boolean | undefined;
  interactive?: boolean;
  /** Mark the body as replaced by an edit, after its last line. */
  edited?: boolean | undefined;
}) {
  const resolveName = useChannelIdentityNames(session, row.channelId);
  const prepared = useMemo(
    () => preparedBodies(row.content, () => prepareMarkdown(row.content)),
    [row.content],
  );
  if (prepared.kind === "plain")
    return (
      <div className={styles.plainText}>
        {prepared.content}
        {edited && <EditedMarker />}
      </div>
    );
  return (
    <PreparedMessageMarkdown
      row={row}
      prepared={prepared}
      directory={directory}
      session={session}
      scope={scope}
      extensions={extensions}
      media={media}
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
      participantProfiles={participantProfiles}
      resolveName={resolveName}
      largeEmoji={largeEmoji}
      interactive={interactive}
      edited={edited}
    />
  );
}

/** Metadata, not prose: selection copy omits it like the byline's clock. */
export function EditedMarker() {
  return <span className={`${styles.edited} select-none`}> (edited)</span>;
}

function PreparedMessageMarkdown({
  row: sourceRow,
  prepared,
  directory = emptyReferenceDirectory,
  session,
  scope,
  extensions,
  media,
  onOpenLink,
  canOpenLink,
  participantProfiles,
  resolveName,
  largeEmoji = false,
  interactive = true,
  edited = false,
}: Parameters<typeof MessageMarkdown>[0] & {
  prepared: Extract<ReturnType<typeof prepareMarkdown>, { kind: "markdown" }>;
  resolveName: (pubkey: string, fallback: string) => string;
}) {
  const row =
    prepared.content === sourceRow.content
      ? sourceRow
      : { ...sourceRow, content: prepared.content };
  const renderLink = (url: string, label?: string, children?: ReactNode) => {
    const channel = channelForLink(url, directory.channels);
    return (
      <MessageLink
        url={url}
        label={label}
        directoryLabel={channelLinkLabel(url, directory.channels)}
        registry={extensions?.links}
        onOpenLink={onOpenLink}
        canOpenLink={canOpenLink}
        session={session}
        scope={scope}
        interactive={interactive}
        channelPrivate={!!channel?.private}
      >
        {children}
      </MessageLink>
    );
  };
  const renderInline = (text: string) =>
    extensions ? (
      <InlineText
        registry={extensions.inline}
        content={{ text, message: row }}
        media={media}
      />
    ) : (
      text
    );
  const renderText = (text: string) => {
    let offset = 0;
    return messageLinkParts(text).map((part) => {
      // A trailing bare link yields two empty text parts at the same offset.
      if (!part.url && !part.text) return null;
      const key = `${offset}:${part.text}`;
      offset += part.text.length;
      return part.url ? (
        <span key={key}>{renderLink(part.url, part.label)}</span>
      ) : (
        <ReferenceText
          channelId={row.channelId}
          key={key}
          text={part.text}
          mentions={[]}
          directory={directory}
          renderText={renderInline}
          onOpenLink={onOpenLink}
          extensions={extensions}
          session={session}
          scope={scope}
          interactive={interactive}
        />
      );
    });
  };

  const profiles = participantProfiles ?? directory.profiles;
  const protectionKey = inlineProtectionKey(
    sourceRow,
    profiles,
    directory.agents,
  );
  // The key contains every row/profile/agent/emoji value consumed below. It
  // avoids reparsing for equivalent folded rows without hiding live inputs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: semantic key
  const protectedContent = useMemo(
    () =>
      protectInlineContent(
        {
          content: prepared.content,
          // Seams index the folded body. Leave link-repaired prose unbound, as edits are.
          ...(sourceRow.edited ||
          (sourceRow.attachmentSeams && prepared.content !== sourceRow.content)
            ? { edited: true as const }
            : {}),
          ...(sourceRow.attachmentSeams
            ? { attachmentSeams: sourceRow.attachmentSeams }
            : {}),
          mentions: sourceRow.mentions,
          mentionReferences: sourceRow.mentionReferences ?? [],
          ...(sourceRow.emoji ? { emoji: sourceRow.emoji } : {}),
        },
        profiles,
        prepared.literalRanges,
        directory.agents,
        prepared.spoilerDelimiters,
      ),
    [
      prepared.content,
      prepared.literalRanges,
      prepared.spoilerDelimiters,
      protectionKey,
    ],
  );
  // Explicit profile links are identity locators, not signed notification intent.
  // Reuse the same control and availability gate as bound prose mentions.
  const renderProfile = (text: unknown, target: unknown) => {
    const key = typeof target === "string" ? profileKey(target) : undefined;
    const agent =
      !!key &&
      (directory.agents.some((agent) => agent.pubkey === key) ||
        (participantProfiles ?? directory.profiles).get(key)?.isAgent);
    const clickable =
      interactive && typeof target === "string" && !!canOpenLink?.(target);
    if (typeof text === "string" && typeof target === "string") {
      const label = key ? resolveName(key, text.slice(1)) : text.slice(1);
      const Mention = clickable ? "button" : "span";
      // Selection copy reads the identity and the whole label (selection-copy.ts).
      return (
        <Mention
          type={clickable ? "button" : undefined}
          className={referenceStyles.link}
          data-mention-kind={agent ? "agent" : "person"}
          data-mention-self={key && key === session?.viewer ? "" : undefined}
          data-profile-target={target}
          data-mention-name={label}
          aria-label={clickable ? `View ${label} profile` : undefined}
          onClick={
            clickable
              ? (event) => {
                  event.currentTarget.focus();
                  onOpenLink(target);
                }
              : undefined
          }
        >
          <MentionLabel agent={!!agent} label={label} />
        </Mention>
      );
    }
    return undefined;
  };
  const components: MessageComponents = {
    p: ({ node: _node, ...props }) => (
      <p
        {...props}
        className={largeEmoji ? styles.text : undefined}
        data-single-emoji={largeEmoji || undefined}
      />
    ),
    a: ({ href: target, children }) => {
      const href =
        target &&
        (parseBuzzLink(target) ||
        profileKey(target) ||
        (interactive &&
          !/^(?:https?|buzz|nostr):/i.test(target) &&
          canOpenLink?.(target))
          ? target
          : safeLinkUrl(target));
      if (href && profileKey(href)) {
        const label = labelText(children);
        return renderProfile(label.startsWith("@") ? label : `@${label}`, href);
      }
      return href ? (
        renderLink(
          href,
          labelText(children) === href ? undefined : labelText(children),
          labelText(children) === href ? undefined : children,
        )
      ) : (
        <span>{children}</span>
      );
    },
    img: ({ node: _node, alt }) =>
      alt ? <span className={styles.imageAlt}>{alt}</span> : null,
    span: ({ node: _node, children, ...props }) => {
      if ("data-edited-slot" in props) return edited ? <EditedMarker /> : null;
      if ((props as Record<string, unknown>)["data-spoiler"] === "true")
        return (
          <MessageSpoiler key={row.content} interactive={interactive}>
            {children}
          </MessageSpoiler>
        );
      const {
        "data-inline-text": text,
        "data-profile-target": target,
        "data-literal-text": literalText,
      } = props as typeof props & {
        "data-inline-text"?: unknown;
        "data-profile-target"?: unknown;
        "data-literal-text"?: unknown;
      };
      const profile = renderProfile(text, target);
      if (profile) return profile;
      return typeof text === "string" ? (
        literalText === "true" ? (
          text
        ) : (
          renderText(text)
        )
      ) : (
        <span {...props}>{children}</span>
      );
    },
    pre: ({ node, children, ...props }) => {
      const code = labelText(children).replace(/\n$/, "");
      const plain = (
        <pre {...props}>
          {children}
          {interactive && <CodeActions code={code} />}
        </pre>
      );
      const language = codeLanguage(node);
      // Previews are not interactive, so they keep the plain code.
      return interactive && language && extensions?.codeBlocks ? (
        <CodeBlock
          registry={extensions.codeBlocks}
          language={language}
          code={code}
          fallback={plain}
        />
      ) : (
        plain
      );
    },
  };

  const markdown = (
    <MessageComponentsContext value={components}>
      <MarkdownBody protectedContent={protectedContent} />
    </MessageComponentsContext>
  );
  return largeEmoji ? markdown : <div className={styles.text}>{markdown}</div>;
}

/** Switching channels remounts every row. Keep recent results so a revisit
 * does not prepare and parse unchanged bodies again. */
function recentResults<T>(
  budget: number,
  weigh: (key: string, value: T) => number,
) {
  const results = new Map<string, Readonly<{ value: T; weight: number }>>();
  let total = 0;
  return (key: string, make: () => T) => {
    let entry = results.get(key);
    if (entry) results.delete(key);
    else {
      const value = make();
      entry = { value, weight: weigh(key, value) };
      // Keeping a result heavier than the budget would evict all the others.
      if (entry.weight > budget) return value;
      total += entry.weight;
    }
    results.set(key, entry);
    for (const [oldest, { weight }] of results) {
      if (total <= budget) break;
      results.delete(oldest);
      total -= weight;
    }
    return entry.value;
  };
}
function elementCount(node: ReactNode): number {
  if (Array.isArray(node))
    return node.reduce<number>((sum, child) => sum + elementCount(child), 0);
  return isValidElement<{ children?: ReactNode }>(node)
    ? 1 + elementCount(node.props.children)
    : 0;
}
// A prepared body keeps its content and literal ranges: ~200k characters.
const preparedBodies = recentResults<PreparedMarkdown>(
  200_000,
  (content) => 100 + content.length,
);
// A parsed body keeps ~2 KB, ~1 KB per element and ~2 bytes per character of
// its key and text. Dense markup has an element every few characters, so weigh
// both: ~4 MB in all. The elements depend only on the protected content; their
// components still read the rendering row's context.
const parsedBodies = recentResults<ReactElement>(
  4_000,
  (key, body) => 2 + elementCount(body) + Math.ceil(key.length / 500),
);

/** Plain prose skips micromark: the same tree, then the same plugins. */
function remarkPlainProse(this: { parser?: unknown }) {
  this.parser = plainProseTree;
}

const MarkdownBody = memo(function MarkdownBody({
  protectedContent,
}: {
  protectedContent: ProtectedContent;
}) {
  return parsedBodies(
    JSON.stringify([
      protectedContent.content,
      protectedContent.prefix,
      protectedContent.parts,
    ]),
    // The default export is a hook-free function: calling it keeps its result.
    () =>
      Markdown({
        remarkPlugins: [
          // Protection only inserts placeholders isPlainProse rejects, so this
          // agrees with prepareMarkdown's check on the raw content.
          ...(isPlainProse(protectedContent.content) ? [remarkPlainProse] : []),
          remarkGfm,
          [remarkBareLinkEnd, protectedContent.content],
          remarkBreaks,
          [remarkSpoilers, `<${protectedContent.prefix}spoiler\uE002>`],
          [remarkInlineContent, protectedContent],
          remarkLiteralHtml,
        ],
        rehypePlugins: [rehypeMarkupNewlines, rehypeEditedSlot],
        components: markdownComponents,
        skipHtml: true,
        // The live anchor renderer validates URLs. Cached parsing cannot decide
        // whether a panel contribution is still registered.
        urlTransform: (value) => value,
        children: protectedContent.content,
      }),
  );
});

function MessageSpoiler({
  children,
  interactive,
}: {
  children: ReactNode;
  interactive: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    // `data-spoiler` is the mark the composer parses; selection copy reads it.
    <span className={styles.spoiler} data-spoiler="" data-revealed={revealed}>
      {interactive ? (
        <button
          type="button"
          className={styles.spoilerMask}
          aria-label={revealed ? "Hide spoiler" : "Reveal spoiler"}
          aria-expanded={revealed}
          onClick={(event) => {
            event.stopPropagation();
            setRevealed(!revealed);
          }}
        />
      ) : (
        <span className={styles.spoilerMask} aria-hidden="true" />
      )}
      <span
        className={styles.spoilerContent}
        aria-hidden={!revealed}
        inert={!revealed}
      >
        {children}
      </span>
    </span>
  );
}

/** The fence's info-string language, as remark records it on the inner `code`. */
function codeLanguage(pre: ExtraProps["node"]) {
  const code = pre?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return undefined;
  const classes = code.properties.className;
  return Array.isArray(classes)
    ? classes
        .map(String)
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length)
    : undefined;
}

/** A plugin presents the block and may add an action; the host keeps the frame,
 * action placement and copy, and restores the plain code when the plugin fails
 * or is removed. */
function CodeBlock({
  registry,
  language,
  code,
  fallback,
}: {
  registry: ContributionReader<CodeBlockRenderer>;
  language: string;
  code: string;
  fallback: ReactNode;
}) {
  const renderers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const renderer = resolveMatch(renderers, language);
  if (!renderer) return fallback;
  const { component: Renderer, action: Action } = renderer;
  return (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${language}:${code}`}
      fallback={fallback}
    >
      {/* Selection copy reads the source here (selection-copy.ts). */}
      <div
        className={styles.codeBlock}
        data-copy-code={code}
        data-copy-language={language}
      >
        <Renderer code={code} language={language} />
        <CodeActions code={code}>
          {Action && <Action code={code} language={language} />}
        </CodeActions>
      </div>
    </ContributionBoundary>
  );
}

function CodeActions({
  code,
  children,
}: {
  code: string;
  children?: ReactNode;
}) {
  const notify = useToastNotification();
  const [copying, setCopying] = useState(false);
  return (
    <span className={styles.codeActions}>
      {children}
      <IconButton
        hint="familiar"
        aria-label="Copy code block"
        title="Copy code block"
        disabled={copying}
        focusableWhenDisabled
        icon={<CopyIcon />}
        onClick={() => {
          setCopying(true);
          void Promise.resolve()
            .then(() => writeClipboardText(code))
            .then(
              () => notify("Copied code to clipboard", "success"),
              () => notify("Failed to copy code", "error"),
            )
            .finally(() => setCopying(false));
        }}
      />
    </span>
  );
}
