import { decode, npubEncode } from "nostr-tools/nip19";

// Rosters relabel the same keys on every render; bech32 is costly at that scale.
const encoded = new Map<string, string>();

/** The full npub of a hex public key, or undefined for anything else. */
export function canonicalPublicKey(pubkey: string): string | undefined {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return undefined;
  const key = pubkey.toLowerCase();
  let npub = encoded.get(key);
  if (!npub) {
    npub = npubEncode(key);
    if (encoded.size >= 8192) encoded.delete(encoded.keys().next().value ?? "");
    encoded.set(key, npub);
  }
  return npub;
}

/** Display only: never use this abbreviation for copying, storage or routing. */
export function formatPublicKey(
  pubkey: string,
  suffixLength = 3,
): string | undefined {
  const npub = canonicalPublicKey(pubkey);
  if (!npub) return undefined;
  const length = Number.isInteger(suffixLength)
    ? Math.max(3, Math.min(suffixLength, npub.length - 5))
    : 3;
  return `npub…${npub.slice(-length)}`;
}

/** Distinct public identities share the shortest unambiguous suffix, starting at three. */
export function publicKeyLabels(
  pubkeys: Iterable<string>,
): ReadonlyMap<string, string> {
  const encoded = new Map<string, string>();
  for (const pubkey of pubkeys) {
    const npub = canonicalPublicKey(pubkey);
    if (npub) encoded.set(pubkey.toLowerCase(), npub);
  }
  let length = 3;
  const values = [...encoded.values()];
  while (
    length < 58 &&
    new Set(values.map((npub) => npub.slice(-length))).size < values.length
  )
    length++;
  return new Map(
    [...encoded].map(([pubkey, npub]) => [
      pubkey,
      `npub…${npub.slice(-length)}`,
    ]),
  );
}

/** Compact single-line public identity with recognizable leading and trailing characters. */
export function abbreviatedPublicKey(pubkey: string): string | undefined {
  const npub = canonicalPublicKey(pubkey);
  return npub ? `${npub.slice(0, 10)}...${npub.slice(-10)}` : undefined;
}

/** The hex public key that typed text names exactly: 64 hex characters in
 * either case, or a lowercase or uppercase npub with or without `nostr:`.
 * Undefined for anything else, including a key still being typed. */
export function typedPublicKey(text: string): string | undefined {
  const value = text.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  const npub = value.replace(/^nostr:/i, "");
  if (!/^npub1/i.test(npub)) return undefined;
  try {
    const decoded = decode(npub);
    // nip19 does not check an npub's payload length.
    return decoded.type === "npub" && /^[0-9a-f]{64}$/.test(decoded.data)
      ? decoded.data
      : undefined;
  } catch {
    return undefined;
  }
}
