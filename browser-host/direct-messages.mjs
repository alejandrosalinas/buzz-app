import { validDirectMessageParticipants } from "../src/features/relay/direct-message-policy.ts";
import { randomUUID } from "node:crypto";
import { finalizeEvent } from "nostr-tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Idempotent participant-set command (kind 41010), or with `channel`, adding
 * people to that DM (kind 41011). Only with `includeHistory` may anyone join
 * an existing DM and read its history; an addition's `"ask"` lets the relay
 * decide whether to ask first. Keys stay in the broker. */
export function directMessageEvent(input, viewer, key) {
  const adding = input?.channel !== undefined;
  if (
    !input ||
    !Array.isArray(input.pubkeys) ||
    input.pubkeys.some((value) => typeof value !== "string") ||
    !validDirectMessageParticipants(input.pubkeys, viewer, adding)
  )
    throw new Error(
      adding
        ? "Choose who to add to this DM."
        : "Choose between one and eight other people.",
    );
  if (
    adding
      ? typeof input.channel !== "string" ||
        !UUID.test(input.channel) ||
        (typeof input.includeHistory !== "boolean" &&
          input.includeHistory !== "ask")
      : input.includeHistory !== undefined &&
        typeof input.includeHistory !== "boolean"
  )
    throw new Error("Choose a direct message to add people to.");
  return finalizeEvent(
    {
      kind: adding ? 41011 : 41010,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ...(adding ? [["h", input.channel]] : []),
        ...input.pubkeys.map((pubkey) => ["p", pubkey]),
        ...(input.includeHistory
          ? [["history", input.includeHistory === "ask" ? "ask" : "include"]]
          : []),
        ["client", randomUUID()],
      ],
    },
    key,
  );
}

export function directMessageReceipt(text, eventId) {
  const receipt = JSON.parse(text);
  if (
    receipt?.event_id !== eventId ||
    receipt.accepted !== true ||
    typeof receipt.message !== "string" ||
    !receipt.message.startsWith("response:")
  )
    throw new Error("The direct message could not be opened. Try again.");
  const result = JSON.parse(receipt.message.slice(9));
  if (typeof result?.channel_id !== "string" || !UUID.test(result.channel_id))
    throw new Error("The relay returned an invalid direct message.");
  return { channelId: result.channel_id };
}
