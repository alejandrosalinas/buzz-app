import { composerChips, readComposerSnapshot } from "./composer-document";
import { composerToken, type ComposerToken } from "./composer-token";
import type { MentionDraft } from "./mention-draft";

/** A message's chips, signed by the author's own composer. Readers trust them
 * only as far as they trust that author. */
export const MESSAGE_TOKENS_TAG = "buzz-tokens-v1";
const MAX_BYTES = 16 * 1024;

function checked(value: unknown): readonly ComposerToken[] {
  if (!Array.isArray(value) || !value.length || value.length > 32)
    throw new Error("Choose between 1 and 32 chips.");
  const tokens = value.map(composerToken);
  if (tokens.some((token) => !token))
    throw new Error("A chip is invalid. Select it again.");
  const keys = new Set(
    tokens.map((token) =>
      JSON.stringify([
        token?.kind,
        token?.id,
        token?.kind === "skill" ? token.target : "",
      ]),
    ),
  );
  if (keys.size !== tokens.length)
    throw new Error("Remove duplicate chips before sending.");
  return tokens as readonly ComposerToken[];
}

export function messageTokenTags(tokens: readonly ComposerToken[]): string[][] {
  if (!tokens.length) return [];
  const json = JSON.stringify(checked(tokens));
  if (new TextEncoder().encode(json).length > MAX_BYTES)
    throw new Error("These chips are too large. Remove some before sending.");
  return [[MESSAGE_TOKENS_TAG, json]];
}

let signing: readonly ComposerToken[] = [];
/** Host composers only: the first message `send` or `reply` that `publish`
 * makes synchronously carries these chips. A send made while it is queued,
 * such as by an outbox subscriber, does not. The public message API cannot
 * add them. */
export function signMessageTokens<T>(
  tokens: readonly ComposerToken[],
  publish: () => T,
): T {
  const previous = signing;
  signing = tokens;
  try {
    return publish();
  } finally {
    signing = previous;
  }
}
/** The tag for the chips `signMessageTokens` is publishing, if any. The first
 * caller takes them. */
export function signedMessageTokenTags() {
  const tokens = signing;
  signing = [];
  return messageTokenTags(tokens);
}

/** Unknown versions are inert. Never recover chips from prose. */
export function readMessageTokens(
  tags: readonly (readonly string[])[],
): readonly ComposerToken[] {
  const found = tags.filter(([name]) => name === MESSAGE_TOKENS_TAG);
  if (!found.length) return [];
  const tag = found[0];
  if (
    found.length !== 1 ||
    tag?.length !== 2 ||
    typeof tag[1] !== "string" ||
    new TextEncoder().encode(tag[1]).length > MAX_BYTES
  )
    throw new Error("This message has invalid chips.");
  try {
    return checked(JSON.parse(tag[1]));
  } catch {
    throw new Error("This message has invalid chips.");
  }
}

/** The chips a draft's message signs. */
export function draftTokens(draft: Pick<MentionDraft, "document">) {
  return composerChips(readComposerSnapshot(draft.document)).map(
    (chip) => chip.token,
  );
}
