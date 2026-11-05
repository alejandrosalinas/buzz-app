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
