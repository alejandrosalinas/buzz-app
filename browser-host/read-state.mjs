import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";
import { eventDto } from "../src/features/relay/events.ts";
import {
  parseReadBlob,
  readCoordinate,
  unreadCoordinate,
  READ_STATE_EVENT_BYTES,
  READ_STATE_PLAINTEXT_BYTES,
  record,
  slotId,
  uint32,
} from "../src/features/relay/read-state-model.ts";
import {
  FOLLOW_PLAINTEXT_BYTES,
  parseFollowPayload,
} from "../src/features/relay/follow-sync.ts";

export const READ_STATE_DECODE_BYTES = 512 * 1024;
// Original NIP-44 can expand 65,535 plaintext bytes to 87,472 base64 characters.
// Receive old client records without raising our 64 KiB publication event cap.
const READ_STATE_RECEIVE_EVENT_BYTES = 96 * 1024;
/** Validate and copy wire bytes: never trust nostr-tools' cached verification symbol. */
export function validReadStateEvent(
  raw,
  secret,
  maxBytes = READ_STATE_EVENT_BYTES,
) {
  const event = eventDto(raw);
  if (
    event.pubkey !== getPublicKey(secret) ||
    !readCoordinate(event) ||
    Buffer.byteLength(JSON.stringify(event)) > maxBytes
  )
    throw new Error("Invalid read-state event");
  return event;
}
export function decodeReadState(
  events,
  secret,
  maxEventBytes = READ_STATE_RECEIVE_EVENT_BYTES,
) {
  if (
    !Array.isArray(events) ||
    events.length > 16 ||
    Buffer.byteLength(JSON.stringify(events)) > READ_STATE_DECODE_BYTES
  )
    throw new Error("Read-state decode capacity exceeded");
  const verified = events.map((event) =>
    validReadStateEvent(event, secret, maxEventBytes),
  );
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return verified.map((event) => {
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (Buffer.byteLength(plaintext) > 128 * 1024)
        throw new Error("Read-state plaintext capacity exceeded");
      const blob = JSON.parse(plaintext);
      parseReadBlob(blob);
      if ((blob.v === 2) !== !!unreadCoordinate(event))
        throw new Error("Read-state version does not match its coordinate");
      return { eventId: event.id, blob };
    });
  } finally {
    key.fill(0);
  }
}
export function signReadState(
  raw,
  secret,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    !record(raw) ||
    !slotId(raw.slot) ||
    !uint32(raw.createdAt) ||
    Math.abs(raw.createdAt - now) > 60
  )
    throw new Error("Invalid read-state signing intent");
  parseReadBlob(raw.blob);
  const plaintext = JSON.stringify(raw.blob);
  if (Buffer.byteLength(plaintext) > READ_STATE_PLAINTEXT_BYTES)
    throw new Error("Read-state publication capacity exceeded");
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    const event = finalizeEvent(
      {
        kind: 30078,
        created_at: raw.createdAt,
        tags:
          raw.blob.v === 2
            ? [
                ["d", `read-state-unread-v2:${raw.slot}`],
                ["t", "read-state-unread-v2"],
              ]
            : [
                ["d", `read-state:${raw.slot}`],
                ["t", "read-state"],
              ],
        content: nip44.v2.encrypt(plaintext, key),
      },
      secret,
    );
    return validReadStateEvent(event, secret);
  } finally {
    key.fill(0);
  }
}

// Buzz Thread Follow Choices: a second, separately validated own-slot shape.
// It shares nothing with the read-state checks above, so neither loosens the other.
const FOLLOW_COORDINATE = /^thread-follows:[0-9a-f]{32}$/;
function followCoordinate(event) {
  if (event.kind !== 30078) return;
  const ds = event.tags.filter(([name]) => name === "d");
  const ts = event.tags.filter(
    ([name, value]) => name === "t" && value === "thread-follows",
  );
  return ds.length === 1 && ts.length === 1 && FOLLOW_COORDINATE.test(ds[0][1])
    ? ds[0][1]
    : undefined;
}
export function validThreadFollowsEvent(
  raw,
  secret,
  maxBytes = READ_STATE_EVENT_BYTES,
) {
  const event = eventDto(raw);
  if (
    event.pubkey !== getPublicKey(secret) ||
    !followCoordinate(event) ||
    Buffer.byteLength(JSON.stringify(event)) > maxBytes
  )
    throw new Error("Invalid thread-follows event");
  return event;
}
/** A verified own event whose payload can't be read decodes to `payload: null`
 * (its entries are unknown, not absent); a foreign or malformed event throws. */
export function decodeThreadFollows(
  events,
  secret,
  maxEventBytes = READ_STATE_RECEIVE_EVENT_BYTES,
) {
  if (
    !Array.isArray(events) ||
    events.length > 16 ||
    Buffer.byteLength(JSON.stringify(events)) > READ_STATE_DECODE_BYTES
  )
    throw new Error("Thread-follows decode capacity exceeded");
  const verified = events.map((event) =>
    validThreadFollowsEvent(event, secret, maxEventBytes),
  );
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return verified.map((event) => {
      try {
        const text = nip44.v2.decrypt(event.content, key);
        if (Buffer.byteLength(text) > FOLLOW_PLAINTEXT_BYTES) throw new Error();
        const payload = JSON.parse(text);
        parseFollowPayload(payload);
        return { eventId: event.id, payload };
      } catch {
        return { eventId: event.id, payload: null };
      }
    });
  } finally {
    key.fill(0);
  }
}
export function signThreadFollows(
  raw,
  secret,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    !record(raw) ||
    !slotId(raw.slot) ||
    !uint32(raw.createdAt) ||
    Math.abs(raw.createdAt - now) > 60
  )
    throw new Error("Invalid thread-follows signing intent");
  parseFollowPayload(raw.payload);
  const text = JSON.stringify(raw.payload);
  if (Buffer.byteLength(text) > FOLLOW_PLAINTEXT_BYTES)
    throw new Error("Thread-follows publication capacity exceeded");
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    const event = finalizeEvent(
      {
        kind: 30078,
        created_at: raw.createdAt,
        tags: [
          ["d", `thread-follows:${raw.slot}`],
          ["t", "thread-follows"],
        ],
        content: nip44.v2.encrypt(text, key),
      },
      secret,
    );
    return validThreadFollowsEvent(event, secret);
  } finally {
    key.fill(0);
  }
}
