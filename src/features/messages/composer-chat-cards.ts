import { scanMarkdown } from "../relay/message-content";
import { parseBuzzLink } from "../navigation/buzz-links";
import { EditorState } from "prosemirror-state";
import {
  composerMarkdownContext,
  composerSchema,
  projectComposerDocument,
  readComposerDocument,
} from "./composer-document";
import type { MentionDraft } from "./mention-draft";
import { canonicalChatCard, separateChatCards } from "./chat-cards";
import type { ReferenceChannel } from "./ReferenceText";
import type { ChannelMessage } from "../relay/contracts";

/** Move references out of editable prose without changing recipient identity or marks. */
export function stageChatCards(
  draft: MentionDraft,
  channels: readonly ReferenceChannel[],
): MentionDraft {
  if (!/buzz:/i.test(draft.text)) return draft;
  const doc = readComposerDocument(draft, draft.recipients);
  const source = projectComposerDocument(doc);
  const context = composerMarkdownContext(doc, source);
  // Rich documents have no Markdown delimiters in their editable text. Keep
  // quoted/list content and spoilers in prose, just like their raw equivalents.
  let text = context.text;
  const protectedRanges = [...context.protected];
  const mask = (start: number, end: number) => {
    text =
      text.slice(0, start) +
      text.slice(start, end).replace(/[^\r\n]/g, "x") +
      text.slice(end);
  };
  doc.descendants((node, position) => {
    if (
      ["blockquote", "bullet_list", "ordered_list"].includes(node.type.name) ||
      composerSchema.marks.spoiler.isInSet(node.marks)
    ) {
      const start = source.source(position);
      const end = source.source(position + node.nodeSize);
      protectedRanges.push({ start, end });
      mask(start, end);
      return false;
    }
  });
  // Protect the whole link when just part of its label has hidden formatting.
  for (const link of scanMarkdown(context.text).links) {
    const start = link.position?.start.offset,
      end = link.position?.end.offset;
    if (
      start !== undefined &&
      end !== undefined &&
      protectedRanges.some((range) => start < range.end && end > range.start)
    )
      mask(start, end);
  }
  const { cards, ranges } = separateChatCards(
    { content: text } as ChannelMessage,
    channels,
  );
  if (!cards.length || cards.length + (draft.chatCards?.length ?? 0) > 32)
    return draft;
  const tr = EditorState.create({ doc }).tr;
  for (const range of [...ranges].reverse()) {
    const before = draft.text[range.start - 1],
      after = draft.text[range.end];
    const boundary = before && after && !/\s/.test(before + after) ? " " : "";
    tr.insertText(
      boundary,
      source.position(range.start),
      source.position(range.end, -1),
    );
  }
  return {
    ...projectComposerDocument(tr.doc).draft,
    ...(draft.gifs ? { gifs: draft.gifs } : {}),
    chatCards: [
      ...new Set([
        ...(draft.chatCards ?? []),
        ...cards.flatMap((card) => {
          const canonical = canonicalChatCard(card.content);
          if (canonical) return canonical;
          const url = scanMarkdown(card.content).links[0]?.url ?? card.content;
          const target = parseBuzzLink(url);
          return (
            canonicalChatCard(
              `[Chat: ${target?.format === "legacy" ? target.channelId.slice(0, 8) : "chat"}](${url})`,
            ) ?? []
          );
        }),
      ]),
    ],
  };
}

/** Restore older attachment-style chat drafts into the ordinary editable document. */
export function restoreChatLinks(draft: MentionDraft): MentionDraft {
  if (!draft.chatCards?.length) return draft;
  const { chatCards, ...caption } = draft;
  const links = readComposerDocument(
    {
      text: chatCards.join("\n\n"),
      recipients: [],
    },
    [],
  );
  const body = readComposerDocument(caption, caption.recipients);
  const doc = links.copy(
    draft.text
      ? links.content
          .addToEnd(composerSchema.nodes.paragraph.create())
          .append(body.content)
      : links.content,
  );
  return {
    ...projectComposerDocument(doc).draft,
    ...(draft.forward !== undefined ? { forward: draft.forward } : {}),
    ...(draft.gifs ? { gifs: draft.gifs } : {}),
  };
}
