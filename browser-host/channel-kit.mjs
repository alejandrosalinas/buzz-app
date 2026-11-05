import { getPublicKey, nip44 } from "nostr-tools";
import { eventDto } from "../src/features/relay/events.ts";
import {
  CANVAS_MAX_EVENT_BYTES,
  LIVE_CANVAS_BYTES,
} from "../src/features/channel-templates/canvas-limits.ts";
import {
  privateCoordinate,
  privateTag,
  parsePrivateRecord,
} from "../src/features/channel-templates/model.ts";

export function prepareChannelKit(raw, secret, community) {
  const record = parsePrivateRecord(raw, community);
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return nip44.v2.encrypt(JSON.stringify(record), key);
  } finally {
    key.fill(0);
  }
}
/** Validate narrow ciphertext intent both before signing and before publishing. */
export function admitChannelKit(event, secret, community) {
  if (
    event?.kind !== 30078 ||
    typeof event.content !== "string" ||
    event.content.length > 64 * 1024 ||
    !Array.isArray(event.tags)
  )
    throw new Error("Invalid private recipe event");
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    const record = parsePrivateRecord(
      JSON.parse(nip44.v2.decrypt(event.content, key)),
      community,
    );
    const boundOwner =
      record.value.type === "team-payload"
        ? record.value.owner
        : record.value.type === "team-text"
          ? record.value.owner
          : record.version === 2
            ? record.value.portable?.owner
            : undefined;
    if (boundOwner !== undefined && boundOwner !== getPublicKey(secret))
      throw new Error("Portable team belongs to another viewer");
    const ds = event.tags.filter((t) => t[0] === "d"),
      ts = event.tags.filter((t) => t[0] === "t");
    // Same tag rules as native admission: every tag is a pair, and a
    // client id is at most 128 UTF-8 bytes.
    if (
      ds.length !== 1 ||
      ds[0][1] !== privateCoordinate(record) ||
      ts.length !== 1 ||
      ts[0][1] !== privateTag(record) ||
      event.tags.some(
        (t) =>
          !Array.isArray(t) ||
          t.length !== 2 ||
          !["d", "t", "client-id"].includes(t[0]) ||
          (t[0] === "client-id" &&
            (typeof t[1] !== "string" || Buffer.byteLength(t[1]) > 128)),
      )
    )
      throw new Error("Invalid private recipe coordinate");
    return record;
  } finally {
    key.fill(0);
  }
}
export function decodeChannelKit(raw, secret, community) {
  if (
    !Array.isArray(raw) ||
    raw.length > 16 ||
    Buffer.byteLength(JSON.stringify(raw)) > 1024 * 1024
  )
    throw new Error("Recipe decode capacity exceeded");
  return raw.map((value) => {
    const event = eventDto(value);
    if (event.pubkey !== getPublicKey(secret))
      throw new Error("Recipe belongs to another viewer");
    return {
      eventId: event.id,
      record: admitChannelKit(event, secret, community),
    };
  });
}
export const canvasEventFits = (event) =>
  Buffer.byteLength(JSON.stringify(event)) <= CANVAS_MAX_EVENT_BYTES;
export function validCanvas(event) {
  return (
    event?.kind === 40100 &&
    typeof event.content === "string" &&
    Buffer.byteLength(event.content) <= LIVE_CANVAS_BYTES &&
    Array.isArray(event.tags) &&
    event.tags.filter((t) => t?.[0] === "h").length === 1 &&
    event.tags.filter((t) => t?.[0] === "expected-revision").length <= 1 &&
    event.tags.filter((t) => t?.[0] === "canvas-instructions").length <= 1 &&
    event.tags.every(
      (t) =>
        Array.isArray(t) &&
        t.length === 2 &&
        (t[0] === "h"
          ? /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(t[1])
          : t[0] === "expected-revision"
            ? typeof t[1] === "string" &&
              (t[1] === "none" || /^[0-9a-f]{64}$/.test(t[1]))
            : t[0] === "canvas-instructions"
              ? t[1] === "unapproved"
              : t[0] === "client-id" &&
                typeof t[1] === "string" &&
                t[1].length <= 128),
    )
  );
}
