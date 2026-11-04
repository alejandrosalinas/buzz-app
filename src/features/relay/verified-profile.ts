import { PROFILE_CACHE_MAX } from "./budget.ts";
import { hasEventProof, type RelayEvent } from "./events.ts";

export const VERIFIED_PROFILE_KIND = 30382;
export const VERIFIED_PROFILE_BATCH = 128;
/** Live verified-profile syncs one connection admits: enough batches for the
 * largest profile directory, in their own pool so artifact syncs keep theirs. */
export const VERIFIED_PROFILE_MAX_SYNCS = Math.ceil(
  PROFILE_CACHE_MAX / VERIFIED_PROFILE_BATCH,
);
const key = /^[0-9a-f]{64}$/;

/** Explicit NIP-11 capability, bound to this community's stable signing key. */
export type VerifiedProfileAuthority = Readonly<{
  pubkey: string;
  multipleIssuers: boolean;
  /** People search also returns each found person's head (NIP-11
   * `public_profile.searchable`), so a missing one means there is none. */
  searchable?: true;
}>;

export type VerifiedProfile = Readonly<{
  displayName: string;
  username: string;
  fullName?: string;
  issuerLabel: string;
  verifiedAt: number;
  /** Observed on a completed current subscription, or retained while unreconciled. */
  status: "checked" | "cached";
  multipleIssuers: boolean;
}>;

export function verifiedProfileAuthority(
  info: Record<string, unknown>,
): VerifiedProfileAuthority | undefined {
  try {
    return verifiedProfileDiscovery(info) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A valid omission disables marks. Malformed discovery preserves prior state. */
export function verifiedProfileDiscovery(
  info: Record<string, unknown>,
): VerifiedProfileAuthority | null {
  const fi = info.federated_identity;
  if (fi === undefined) return null;
  if (!fi || typeof fi !== "object" || Array.isArray(fi))
    throw new Error("Malformed profile discovery");
  const profile = (fi as Record<string, unknown>).public_profile;
  if (profile === undefined) return null;
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    throw new Error("Malformed profile discovery");
  const fields = profile as Record<string, unknown>;
  if (
    typeof info.self !== "string" ||
    !key.test(info.self) ||
    fields.kind !== VERIFIED_PROFILE_KIND ||
    typeof fields.multiple_issuers !== "boolean"
  )
    throw new Error("Malformed profile discovery");
  return Object.freeze({
    pubkey: info.self,
    multipleIssuers: fields.multiple_issuers,
    ...(fields.searchable === true ? { searchable: true as const } : {}),
  });
}

export function validVerifiedName(value: string): boolean {
  return (
    [...value].length >= 1 &&
    [...value].length <= 64 &&
    value.normalize("NFC") === value &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(value) &&
    !/^\p{White_Space}|\p{White_Space}$/u.test(value)
  );
}

/** A signed newer malformed assertion invalidates the old name at its address. */
export function verifiedProfileSubject(
  event: RelayEvent,
  authority: VerifiedProfileAuthority,
): string | undefined {
  if (
    !hasEventProof(event) ||
    event.kind !== VERIFIED_PROFILE_KIND ||
    event.pubkey !== authority.pubkey
  )
    return;
  const tags = event.tags.filter(([name]) => name === "d");
  const subject = tags[0]?.[1];
  // NIP-01 addresses use the first d tag; duplicate d tags invalidate the
  // projection at that address instead of preserving an older verified name.
  return subject && key.test(subject) ? subject : undefined;
}

/** Strict output-only projection. Kind 0 and NIP-05 never establish verification. */
export function verifiedProfile(
  event: RelayEvent,
  authority: VerifiedProfileAuthority,
  checked: boolean,
): VerifiedProfile | undefined {
  const subject = verifiedProfileSubject(event, authority);
  if (
    !subject ||
    event.content !== "" ||
    (event.tags.length !== 7 && event.tags.length !== 8)
  )
    return;
  const tags = new Map<string, string>();
  for (const entry of event.tags) {
    if (entry.length !== 2 || tags.has(entry[0] as string)) return;
    tags.set(entry[0] as string, entry[1] as string);
  }
  if (tags.size !== 7 + Number(tags.has("full_name"))) return;
  const fullName = tags.get("full_name");
  const displayName = tags.get("display_name");
  const username = tags.get("username");
  const issuerLabel = tags.get("issuer_label");
  const rawTime = tags.get("verified_at");
  const verifiedAt = Number(rawTime);
  if (
    tags.get("p") !== subject ||
    tags.get("active") !== "true" ||
    (fullName !== undefined && !validVerifiedName(fullName)) ||
    !displayName ||
    !validVerifiedName(displayName) ||
    !username ||
    !/^[a-z0-9._-]{1,64}$/.test(username) ||
    !issuerLabel ||
    !validVerifiedName(issuerLabel) ||
    !rawTime ||
    !/^[0-9]+$/.test(rawTime) ||
    !Number.isSafeInteger(verifiedAt) ||
    verifiedAt > event.created_at
  )
    return;
  return Object.freeze({
    displayName,
    username,
    ...(fullName !== undefined ? { fullName } : {}),
    issuerLabel,
    verifiedAt,
    status: checked ? "checked" : "cached",
    multipleIssuers: authority.multipleIssuers,
  });
}

export type VerifiedProfileFilter = Readonly<{
  kinds: readonly [30382];
  authors: readonly [string];
  "#d": readonly string[];
  limit: number;
}>;
export type VerifiedProfileSink = {
  event(event: RelayEvent): void;
  eose(): void;
  closed(reason: string): void;
};

export function verifiedProfileFilter(
  authority: string,
  subjects: readonly string[],
): VerifiedProfileFilter {
  const unique = [...new Set(subjects)];
  if (
    !key.test(authority) ||
    !unique.length ||
    unique.length > VERIFIED_PROFILE_BATCH ||
    unique.some((id) => !key.test(id))
  )
    throw new Error("Invalid verified-profile subscription");
  return {
    kinds: [VERIFIED_PROFILE_KIND],
    authors: [authority],
    "#d": unique,
    limit: unique.length,
  };
}
