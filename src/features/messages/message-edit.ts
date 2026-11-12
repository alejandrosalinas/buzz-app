import {
  projectMarkdownAttachments,
  scanMarkdown,
} from "../relay/message-content";
import type { AgentLibrary } from "../agents/library";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { npubEncode } from "nostr-tools/nip19";
import { literalRanges } from "./markdown-preparation";
import type { MentionRecipient } from "./mention-draft";
import { profileMentionParts } from "./profile-mentions";

/** Display-only identity link: literal one-line label, exact profile target, no
 * recipient. CommonMark unescapes every ASCII punctuation mark, so escaping all
 * of them keeps a name from authoring emphasis, code, entities or links. */
export function profileMentionLink(label: string, target: string) {
  const text = label
    .replace(/[\r\n]+/g, " ")
    .replace(/[!-/:-?[-`{-~]/g, "\\$&");
  return `[${text}](${target})`;
}

/** Picker selection during an edit becomes the same link as a preserved
 * mention, followed by the key that ended the name or a space. */
export const editMentionText = (
  { pubkey, name }: MentionRecipient,
  after = " ",
) => `${profileMentionLink(`@${name}`, `nostr:${npubEncode(pubkey)}`)}${after}`;

/** Keep attachment Markdown and turn already-bound names into explicit identities.
 * Edited legacy prose remains unbound; the editor never invents recipients. */
export function messageEditText(
  row: ChannelMessage,
  profiles: ReadonlyMap<string, Profile>,
  agents: AgentLibrary["identities"] = [],
) {
  const { attachmentSeams: _seams, ...source } = row;
  const content = row.sourceContent ?? row.content;
  const ranges = literalRanges(scanMarkdown(content).tree, true);
  let offset = 0;
  let next = 0;
  return profileMentionParts({ ...source, content }, profiles, agents)
    .map(({ text, target }) => {
      const start = offset;
      offset += text.length;
      while ((ranges[next]?.end ?? Infinity) <= start) next++;
      return target && (ranges[next]?.start ?? Infinity) >= offset
        ? profileMentionLink(text, target)
        : text;
    })
    .join("");
}

/** Attachments are not editable in this surface; original metadata stays signed. */
export function validateMessageEdit(
  row: ChannelMessage,
  initial: string,
  content: string,
) {
  const urls = new Set(row.attachments.map((attachment) => attachment.url));
  const before = projectMarkdownAttachments(initial, urls);
  const after = projectMarkdownAttachments(content, urls);
  if (
    [...urls].some(
      (url) => initial.split(url).length !== content.split(url).length,
    ) ||
    JSON.stringify([before.urls, before.names]) !==
      JSON.stringify([after.urls, after.names])
  )
    throw new Error(
      "Keep attachment links unchanged. Only message text can be edited here.",
    );
  return content;
}
