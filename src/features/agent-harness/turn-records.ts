// Buzz messages in a turn's prompt as exact JSON records, the same for every
// runtime. A protection plugin re-encodes them exactly, which is how it finds
// each message to check, and remember, on its own.
import type { EventData } from "../relay/events";

/** JSON with `<` and `>` escaped, so no text in it opens or closes a section. */
export const quoted = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

/** The names a message's record shows for its author. `pubkey` stays the
 * author's identity; these are for reading and tagging them. */
export type AuthorNames = Readonly<{
  /** The author's verified username, when the community verified one: what
   * an agent writes after `@` to tag them. */
  username?: string;
  /** The author's display name, for addressing them in prose. */
  display_name?: string;
}>;

/** A message with its author's names beside its pubkey. A protection plugin
 * checks them with the rest of the text; they are not part of the signed
 * event. */
export function withNames<T extends { id: string; pubkey: string }>(
  message: T,
  names: AuthorNames | undefined,
) {
  const { username, display_name } = names ?? {};
  if (!username && !display_name) return message;
  const { id, pubkey, ...rest } = message;
  return {
    id,
    pubkey,
    ...(username ? { username } : {}),
    ...(display_name ? { display_name } : {}),
    ...rest,
  };
}

/** Tags that say what a message means: who it mentions, what it quotes or
 * refers to, the thread it came from, the message it answers, its files,
 * topics and custom emoji. Transport and runtime bookkeeping stays out. */
const READABLE = new Set([
  "p",
  "q",
  "e",
  "buzz:request",
  "buzz:sent-from-thread",
  "imeta",
  "t",
  "emoji",
]);

/** A message's tags for an agent to read. */
export const readableTags = (tags: readonly (readonly string[])[]) =>
  tags.filter(([name]) => READABLE.has(name ?? ""));

/** A message's tags with the files and custom emoji an edit may have
 * replaced, as its timeline shows them. */
export const editedTags = (
  tags: readonly (readonly string[])[],
  files: readonly (readonly string[])[],
  emoji: readonly (readonly string[])[],
) => [
  ...tags.filter(([name]) => name !== "imeta" && name !== "emoji"),
  ...files.filter(([name]) => name === "imeta"),
  ...emoji.filter(([name]) => name === "emoji"),
];

/** The characters a context record's content and tags may take together. */
export const CONTENT_LIMIT = 4000;

/** A context record's content and the tags that fit beside it in
 * CONTENT_LIMIT, saying when some didn't. */
export const contentFields = (
  content: string,
  tags: readonly (readonly string[])[],
) => {
  const text = content.slice(0, CONTENT_LIMIT);
  const readable = readableTags(tags);
  const fit: (readonly string[])[] = [];
  let room = CONTENT_LIMIT - text.length;
  for (const tag of readable) {
    const size = JSON.stringify(tag).length;
    if (size > room) continue;
    room -= size;
    fit.push(tag);
  }
  return {
    content: text,
    ...(fit.length ? { tags: fit } : {}),
    ...(fit.length < readable.length ? { tags_omitted: true } : {}),
  };
};

/** The event a turn is for, then what it asks of the agent. */
export const eventBody = (
  event: EventData,
  request: string,
  names?: AuthorNames,
) => `${quoted(withNames(event, names))}\nRequest: ${quoted(request)}`;

/** Who sent the event in an `eventBody`, and its request; undefined for any
 * other text. */
export function readEventBody(body: string) {
  const match = /^(\{[^\n]*\})\nRequest: ("[^\n]*")$/.exec(body);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    const event: unknown = JSON.parse(match[1]);
    const request: unknown = JSON.parse(match[2]);
    const pubkey = (event as { pubkey?: unknown } | null)?.pubkey;
    return typeof pubkey === "string" && typeof request === "string"
      ? { pubkey, request }
      : undefined;
  } catch {
    return undefined;
  }
}
