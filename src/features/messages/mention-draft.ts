import { canonicalChatCard } from "./chat-cards";
import {
  projectComposerDocument,
  readComposerSnapshot,
} from "./composer-document";

export type MentionRecipient = Readonly<{ pubkey: string; name: string }>;
export type DraftRecipient = MentionRecipient &
  Readonly<{ start: number; end: number }>;
// Serializable draft metadata must not expose editor implementation types to plugins.
export type ComposerSnapshot = { version: 1; content: unknown };
/** A name Space committed before the chooser could decide. The editor resolves
 * it off-screen into a recipient or back into prose; it is never a recipient. */
export type PendingMention = Readonly<{
  id: string;
  name: string;
  start: number;
  end: number;
}>;
export type MentionDraft = {
  text: string;
  /** Chat links staged above the editor; serialized with the caption. */
  chatCards?: readonly string[];
  /** GIF image Markdown staged in the attachment row; sent after the caption. */
  gifs?: readonly string[];
  recipients: readonly DraftRecipient[];
  /** Projection of the live document only; `mentionDraft()` never restores one. */
  pending?: readonly PendingMention[];
  document?: ComposerSnapshot;
};
// A name ends at the next character that is not a letter, mark, digit or
// underscore. The timeline also ends a signed name at punctuation, quotes and
// the inline Markdown delimiters *, ~ and `, so typing `’s` or a closing
// delimiter after a chip keeps its recipient here, however the character
// arrives, and an underscore continues the name in both. A combining mark
// differs: it changes the name's last letter, so it continues the name here,
// while the timeline matches only letters, digits and underscores and ends the
// name before the mark.
export const mentionBoundary = (text: string, end: number) =>
  end === text.length ||
  !/[\p{L}\p{M}\p{N}_]/u.test(String.fromCodePoint(text.codePointAt(end) ?? 0));
/** A key typed straight after a name that selects it as Space does (mentions
 * README §5): Space, or closing punctuation, which stays after the mention in
 * place of the space. Tab, Enter and a click select the highlighted row. */
export const mentionTerminator = (key: string) => /^[ .,!?;:)'’"”]$/u.test(key);
export const MAX_DRAFT_GIFS = 10;
/** The lone image Markdown a staged GIF keeps, as the picker writes it. */
export function stageableGif(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    /^!\[[^\]]*\]\([^()\s]+\)$/.test(value)
  );
}
/** Old text-only drafts remain text-only: restoring prose never creates notifications. */
export function mentionDraft(value: unknown): MentionDraft {
  if (typeof value === "string") return { text: value, recipients: [] };
  if (!value || typeof value !== "object") return { text: "", recipients: [] };
  const record = value as Record<string, unknown>;
  const doc = readComposerSnapshot(record.document);
  const { text, recipients, document } = doc
    ? projectComposerDocument(doc).draft
    : record;
  if (typeof text !== "string") return { text: "", recipients: [] };
  const safe = Array.isArray(recipients)
    ? recipients.filter(
        (item): item is DraftRecipient =>
          !!item &&
          typeof item === "object" &&
          typeof item.pubkey === "string" &&
          /^[0-9a-f]{64}$/.test(item.pubkey) &&
          typeof item.name === "string" &&
          !!item.name.trim() &&
          Number.isInteger(item.start) &&
          Number.isInteger(item.end) &&
          item.start >= 0 &&
          item.end <= text.length &&
          text.slice(item.start, item.end) === `@${item.name}` &&
          mentionBoundary(text, item.end),
      )
    : [];
  // Drafts saved before the rename keep their cards under `sessionCards`.
  const cards = Array.isArray(record.chatCards)
    ? record.chatCards
    : record.sessionCards;
  return {
    text,
    ...(Array.isArray(cards) && cards.length
      ? {
          chatCards: cards
            .map(canonicalChatCard)
            .filter((item): item is string => item !== undefined)
            .slice(0, 32),
        }
      : {}),
    ...(Array.isArray(record.gifs) && record.gifs.length
      ? {
          gifs: [...new Set(record.gifs.filter(stageableGif))].slice(
            0,
            MAX_DRAFT_GIFS,
          ),
        }
      : {}),
    ...(doc ? { document: document as ComposerSnapshot } : {}),
    recipients: safe
      .slice(0, 32)
      .map(({ pubkey, name, start, end }) => ({ pubkey, name, start, end })),
  };
}
/** What counts as a draft everywhere: text, an attached chat or GIF, or `files`.
 * A typed tag is text the person put there; the composer no longer saves
 * tags of its own, and the ones earlier releases saved are not content. */
export function hasDraftContent(value: MentionDraft, files = 0): boolean {
  return (
    files > 0 ||
    !!value.chatCards?.length ||
    !!value.gifs?.length ||
    (!!value.text.trim() && !legacyFollowupDraft(value))
  );
}
/** A remembered-agent follow-up that a release through preview.177.1 saved
 * as the draft: selected recipients and nothing else, without the editor
 * snapshot every typed draft carries. Relay history seeds it now. */
export function legacyFollowupDraft(value: MentionDraft): boolean {
  return !value.document && addressingOnly(value);
}
/** Selected recipients and nothing else: no prose outside their spans and no
 * attached chat or GIF. */
export function addressingOnly(value: MentionDraft): boolean {
  if (!value.recipients.length || value.chatCards?.length || value.gifs?.length)
    return false;
  let rest = value.text;
  for (const { start, end } of [...value.recipients].sort(
    (a, b) => b.start - a.start,
  ))
    rest = rest.slice(0, start) + rest.slice(end);
  return !rest.trim();
}
/** Prefill exact, already-selected identities; never infer recipients from prose. */
export function followupDraft(
  recipients: readonly MentionRecipient[],
): MentionDraft {
  const next: MentionDraft = { text: "", recipients: [] };
  const spans: DraftRecipient[] = [];
  const unique = new Map(recipients.map((item) => [item.pubkey, item]));
  for (const { pubkey, name } of [...unique.values()].slice(0, 32)) {
    const start = next.text.length;
    const text = `@${name} `;
    if (start + text.length > 16000) break;
    next.text += text;
    spans.push({ pubkey, name, start, end: next.text.length - 1 });
  }
  return mentionDraft({ text: next.text, recipients: spans });
}
