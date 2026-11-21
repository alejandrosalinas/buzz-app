import type { ContributionReader, SendGate } from "../conversation/contracts";
import type { UploadedAttachment } from "../relay/attachments";
import type { MentionPicks } from "../relay/messages";
import type { RelaySession } from "../relay/session";
import { composerToken } from "./composer-token";
import { signMessageTokens } from "./message-tokens";

/** A message the composer is about to publish, after its prompts and uploads.
 * Plain JSON, so a send gate can save it and hand it to `publish` later.
 * Gates get a deeply frozen copy, so one gate cannot change what another
 * holds. `attachments`, `picks` and `tokens` are host data to keep unchanged. */
export type OutgoingMessage = Readonly<{
  channelId: string;
  /** A thread reply's root, and the reply it answers when not the root. */
  threadRootId?: string;
  parentId?: string;
  text: string;
  /** Who it notifies; people sent as references are in `references`. */
  recipients: readonly string[];
  references: readonly string[];
  attachments: readonly UploadedAttachment[];
  picks: MentionPicks;
  mediaTarget?: string;
  tokens?: readonly unknown[];
}>;

const freeze = <T extends object>(item: T) => {
  for (const nested of Object.values(item))
    if (nested && typeof nested === "object") freeze(nested);
  return Object.freeze(item);
};

/** The first gate answer other than false: true when a gate keeps the
 * message, `{ refuse }` when one refuses it. Gates are asked by contribution
 * key; a throwing gate, or a refusal without a reason, is skipped, so the host
 * publishes as before. */
export function heldBySendGate(
  gates: ContributionReader<SendGate> | undefined,
  message: OutgoingMessage,
  session: RelaySession,
) {
  const entries = [...(gates?.snapshot() ?? [])].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  if (!entries.length) return false;
  const frozen = freeze(structuredClone(message));
  for (const gate of entries) {
    try {
      const answer = gate.hold(frozen, session);
      if (answer === true) return true;
      if (
        typeof answer === "object" &&
        typeof answer?.refuse === "string" &&
        answer.refuse.trim()
      )
        return { refuse: answer.refuse };
    } catch (error) {
      console.warn(`Send gate ${gate.key} failed`, error);
    }
  }
  return false;
}

/** Publishes a held message as the event the composer would have sent, chips
 * included, without repeating the composer's checks. */
export async function publishOutgoing(
  session: RelaySession,
  message: OutgoingMessage,
) {
  const tokens = (message.tokens ?? []).map((token) => {
    const valid = composerToken(token);
    if (!valid) throw new Error("This message has an invalid chip.");
    return valid;
  });
  const publish = () =>
    message.threadRootId
      ? session.messages.reply(
          message.channelId,
          message.threadRootId,
          message.text,
          message.recipients,
          message.attachments,
          message.parentId,
          message.references,
          message.picks,
          message.mediaTarget,
        )
      : session.messages.send(
          message.channelId,
          message.text,
          message.recipients,
          message.attachments,
          undefined,
          message.references,
          message.picks,
        );
  return tokens.length ? signMessageTokens(tokens, publish) : publish();
}
