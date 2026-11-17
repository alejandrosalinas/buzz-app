import { renderedProfileMentionParts } from "../messages/profile-mentions";
import { profileKey } from "../profiles/target";
import type { ChannelMessage, Profile } from "./contracts";
import type { CustomEmoji } from "./emoji";
import { workflowLabel } from "./workflow-attribution";
import type { EventData } from "./events";

export const FORWARD_TAG = "buzz:forward";
/** Display attribution supplied by the forwarder, not proof of authorship. */
export type ForwardSnapshot = Readonly<{
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  createdAt: number;
  content: string;
  workflow?: boolean;
  attachmentUrls?: readonly string[];
  mentionLabels?: readonly { id: string; names: readonly string[] }[];
  emoji?: readonly CustomEmoji[];
}>;
/** Freeze display bindings without creating notification recipients. */
export function snapshotMessage(
  row: ChannelMessage,
  authorName: string,
  profiles?: ReadonlyMap<string, Profile>,
  agents: readonly { pubkey: string; name: string }[] = [],
): ForwardSnapshot {
  if (row.forward) {
    const snapshot = row.forward.snapshot;
    const { edited: _edited, ...unedited } = row;
    return {
      ...snapshot,
      mentionLabels: displayedMentionLabels(
        {
          ...unedited,
          content: snapshot.content,
          mentions: [],
          mentionReferences: snapshot.mentionLabels?.map(({ id }) => id) ?? [],
          mentionLabels: snapshot.mentionLabels ?? [],
          attachmentSeams: [],
        },
        undefined,
        [],
      ),
    };
  }
  return {
    id: row.id,
    channelId: row.channelId,
    authorId: row.workflowOwnerId ?? row.authorId,
    authorName: authorName.slice(0, 500),
    createdAt: row.createdAt,
    content: row.sourceContent ?? row.content,
    attachmentUrls: row.attachments.map(({ url }) => url),
    ...(row.workflowOwnerId ? { workflow: true } : {}),
    mentionLabels: displayedMentionLabels(row, profiles, agents),
    emoji: row.emoji ?? [],
  };
}
/** Copy only names actually rendered in the body, never implicit recipients. */
function displayedMentionLabels(
  row: ChannelMessage,
  profiles: ReadonlyMap<string, Profile> | undefined,
  agents: readonly { pubkey: string; name: string }[],
) {
  const bindings = new Map<string, Set<string>>();
  for (const part of renderedProfileMentionParts(row, profiles, agents)) {
    const id = part.target && profileKey(part.target);
    if (!id) continue;
    const name = part.text.slice(1).replace(/ \([a-f0-9]{64}\)$/i, "");
    const names = bindings.get(id) ?? new Set<string>();
    names.add(name);
    bindings.set(id, names);
  }
  return [...bindings].map(([id, names]) => ({ id, names: [...names] }));
}
/** Legacy cards predate separate sender uploads; all their media belongs to the copy. */
export function snapshotAttachments(row: ChannelMessage) {
  const urls = row.forward?.snapshot.attachmentUrls;
  return urls
    ? row.attachments.filter(({ url }) => urls.includes(url))
    : row.attachments;
}
const hex = /^[0-9a-f]{64}$/;
const literal = (text: string) =>
  text.replace(/[\\`*_{}[\]<>()#+\-.!|~]/g, "\\$&");
export function forwardQuote(snapshot: ForwardSnapshot): string {
  return `Forwarded message from ${literal(snapshot.workflow ? workflowLabel(snapshot.authorName) : snapshot.authorName)} · ${new Date(snapshot.createdAt * 1000).toISOString()}\n\n${snapshot.content
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`;
}
export function forwardBody(snapshot: ForwardSnapshot, note: string): string {
  return [literal(note.trim()), forwardQuote(snapshot)]
    .filter(Boolean)
    .join("\n\n");
}
export function forwardTag(snapshot: ForwardSnapshot): string[] {
  return [FORWARD_TAG, "1", JSON.stringify(snapshot)];
}
export function readForward(
  event: Pick<EventData, "kind" | "tags" | "content">,
): Readonly<{ snapshot: ForwardSnapshot; note: string }> | undefined {
  if (event.kind !== 9) return;
  const tags = event.tags.filter(([name]) => name === FORWARD_TAG);
  if (tags.length !== 1) return;
  const tag = tags[0];
  if (tag?.length !== 3 || tag[1] !== "1" || !tag[2] || tag[2].length > 32768)
    return;
  try {
    const value = JSON.parse(tag[2]);
    if (
      !value ||
      typeof value.id !== "string" ||
      !hex.test(value.id) ||
      typeof value.authorId !== "string" ||
      !hex.test(value.authorId) ||
      typeof value.channelId !== "string" ||
      !value.channelId ||
      value.channelId.length > 256 ||
      typeof value.authorName !== "string" ||
      !value.authorName.trim() ||
      value.authorName.length > 500 ||
      typeof value.content !== "string" ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt < 0 ||
      value.createdAt > 8640000000000 ||
      (value.workflow !== undefined && typeof value.workflow !== "boolean")
    )
      return;
    if (
      value.mentionLabels !== undefined &&
      (!Array.isArray(value.mentionLabels) ||
        value.mentionLabels.length > 256 ||
        !value.mentionLabels.every(
          (item: { id?: unknown; names?: unknown }) =>
            item &&
            typeof item.id === "string" &&
            hex.test(item.id) &&
            Array.isArray(item.names) &&
            item.names.length <= 16 &&
            item.names.every(
              (name: unknown) =>
                typeof name === "string" &&
                name.length <= 500 &&
                !/[\r\n]/.test(name),
            ),
        ))
    )
      return;
    if (
      value.emoji !== undefined &&
      (!Array.isArray(value.emoji) ||
        value.emoji.length > 256 ||
        !value.emoji.every(
          (item: { shortcode?: unknown; url?: unknown }) =>
            item &&
            typeof item.shortcode === "string" &&
            /^[a-z0-9_-]{1,64}$/i.test(item.shortcode) &&
            typeof item.url === "string" &&
            item.url.length <= 4096 &&
            /^(https?:\/\/|\/media\/)/.test(item.url),
        ))
    )
      return;
    if (
      value.attachmentUrls !== undefined &&
      (!Array.isArray(value.attachmentUrls) ||
        value.attachmentUrls.length > 256 ||
        !value.attachmentUrls.every(
          (url: unknown) => typeof url === "string" && url.length <= 4096,
        ))
    )
      return;
    const snapshot: ForwardSnapshot = {
      id: value.id,
      channelId: value.channelId,
      authorId: value.authorId,
      authorName: value.authorName,
      createdAt: value.createdAt,
      content: value.content,
      ...(value.attachmentUrls ? { attachmentUrls: value.attachmentUrls } : {}),
      mentionLabels: value.mentionLabels,
      emoji: value.emoji,
      ...(value.workflow ? { workflow: true } : {}),
    };
    const quote = forwardQuote(snapshot);
    if (event.content !== quote && !event.content.endsWith(`\n\n${quote}`))
      return;
    return {
      snapshot,
      note:
        event.content === quote
          ? ""
          : event.content.slice(0, -quote.length - 2),
    };
  } catch {
    return;
  }
}
