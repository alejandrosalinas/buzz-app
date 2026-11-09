export type JoinPolicy = {
  version: string;
  terms_markdown?: string | undefined;
  privacy_markdown?: string | undefined;
  age_attestation_required: boolean;
};

/**
 * The consent a join must ask for before `policy`'s community may be joined:
 * none once it is `given` already (`accountConsents`).
 */
export function consentAsked(
  policy: JoinPolicy | null | undefined,
  given: boolean,
) {
  if (given) return { age: false, agreement: false };
  return {
    age: policy?.age_attestation_required === true,
    agreement: Boolean(policy?.terms_markdown || policy?.privacy_markdown),
  };
}

const optionalText = (value: unknown): value is string | null | undefined =>
  value == null || typeof value === "string";

/**
 * The relay's `/api/join-policy` body (buzz-relay api/invites.rs): `{ policy }`,
 * or `{}` / `{ policy: null }` when the deployment has none. Anything else is
 * an error, never "no policy": consent is not waived by a malformed answer.
 */
export function joinPolicy(body: Record<string, unknown>): JoinPolicy | null {
  const raw = body.policy;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid community join policy");
  const {
    version,
    age_attestation_required,
    terms_markdown,
    privacy_markdown,
  } = raw as Record<string, unknown>;
  if (
    typeof version !== "string" ||
    typeof age_attestation_required !== "boolean" ||
    !optionalText(terms_markdown) ||
    !optionalText(privacy_markdown)
  )
    throw new Error("Invalid community join policy");
  return {
    version,
    age_attestation_required,
    terms_markdown: terms_markdown ?? undefined,
    privacy_markdown: privacy_markdown ?? undefined,
  };
}
