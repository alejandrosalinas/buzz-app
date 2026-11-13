import { stageChatCards } from "../messages/composer-chat-cards";
import { composerMarkdown } from "../messages/composer-markdown";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import { isBuzzLink } from "../navigation/buzz-links";
import { scanMarkdown } from "../relay/message-content";

/** Remove only structured leading recipient tags; literal @ text remains title content. */
export function startingChatTitle(value: MentionDraft | string): string {
  return chatTitle(value, true);
}

/** Older clients persisted literal Markdown; accept their default during automatic naming. */
export function isStartingChatTitle(
  name: string,
  value: MentionDraft | string,
): boolean {
  const current = canonicalDetailsName(name);
  return (
    current === startingChatTitle(value) || current === chatTitle(value, false)
  );
}

function chatTitle(
  value: MentionDraft | string,
  readableLinks: boolean,
): string {
  const draft = stageChatCards(mentionDraft(value), []);
  // Match main’s caption-first title; cards remain the fallback for card-only sends.
  const text =
    composerMarkdown({ ...draft, chatCards: [], gifs: [] }).trim() ||
    composerMarkdown({ ...draft, gifs: [] });
  let start = 0;
  let draftStart = 0;
  for (const recipient of [...draft.recipients].sort(
    (a, b) => a.start - b.start,
  )) {
    if (
      recipient.start < draftStart ||
      draft.text.slice(draftStart, recipient.start).trim()
    )
      break;
    const leading = text.slice(start).match(/^\s*/)?.[0].length ?? 0;
    const tag = `@${recipient.name}`;
    if (!text.startsWith(tag, start + leading)) break;
    start += leading + tag.length;
    // A namesake is sent with its full key; that qualifier is part of the tag.
    start += /^ \([0-9a-f]{64}\)/.exec(text.slice(start))?.[0].length ?? 0;
    draftStart = recipient.end;
  }
  const body = text.slice(start).trim();
  // A link-only prompt falls back to its cards, then "Chat".
  const source =
    withoutLeadingBuzzLinks(body) || (draft.chatCards ?? []).join("\n\n");
  return (
    canonicalDetailsName(
      [
        ...(readableLinks ? readableLinkLabels(source) : source).replace(
          /\s+/g,
          " ",
        ),
      ]
        .slice(0, 80)
        .join(""),
    ) || "Chat"
  );
}

/** Project link labels only; code and unrelated authored source remain literal. */
function readableLinkLabels(text: string): string {
  const { links, tooDeep } = scanMarkdown(text);
  if (tooDeep) return text;
  const parts: string[] = [];
  let offset = 0;
  for (const link of links) {
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    if (start === undefined || end === undefined || start < offset) continue;
    const label: string[] = [];
    const pending = [...(link.children ?? [])].reverse();
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (node.children) pending.push(...[...node.children].reverse());
      else
        label.push(
          node.value ?? node.alt ?? (node.type === "break" ? " " : ""),
        );
    }
    parts.push(text.slice(offset, start), label.join(""));
    offset = end;
  }
  return parts.join("") + text.slice(offset);
}

/** A starting source link, as from Start Solo chat, is context rather than title. */
function withoutLeadingBuzzLinks(text: string) {
  let rest = text;
  for (;;) {
    const [token = ""] = rest.split(/\s/, 1);
    if (!token || !isBuzzLink(token)) return rest;
    rest = rest.slice(token.length).trim();
  }
}
