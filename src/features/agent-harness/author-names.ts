// The names a turn's prompt shows beside each message's pubkey.
import type { AgentReads } from "../agents/reads";
import type { EventData } from "../relay/events";
import { messageAuthor } from "../relay/fold";
import type { AuthorNames } from "./turn-records";

/** How long a turn waits for profiles before naming whom it can. */
export const AUTHOR_NAMES_TIMEOUT_MS = 2_000;

/** Reads the profiles of these messages' authors, for at most
 * `AUTHOR_NAMES_TIMEOUT_MS`, and gives each author's names once known. A
 * message the signing authority posted for someone is theirs. A turn without
 * the reads names no one. */
export async function readAuthorNames(
  reads: Pick<AgentReads, "profiles" | "authorNames"> | undefined,
  messages: readonly EventData[],
  signingAuthority?: string,
): Promise<(pubkey: string) => AuthorNames | undefined> {
  const names = reads?.authorNames?.bind(reads);
  if (!reads || !names) return () => undefined;
  const pubkeys = [
    ...new Set(
      messages.map((message) => messageAuthor(message, signingAuthority)),
    ),
  ];
  if (pubkeys.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      reads.profiles(pubkeys).catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, AUTHOR_NAMES_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  return names;
}
