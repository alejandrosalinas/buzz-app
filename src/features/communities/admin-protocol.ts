// Owner/admin community commands shared by the development broker and the
// native adapter. Dependency-free so the Node broker can import it. The relay
// decides authority; this only bounds shape.
const MIN_TTL = 60;
const MAX_TTL = 30 * 24 * 60 * 60;
const MAX_USES = 10_000;
const ROLES = ["admin", "member"];
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KINDS: Record<string, number> = { add: 9030, remove: 9031, role: 9032 };

/** Normalized `POST /api/invites` body; unknown fields are dropped. */
export function inviteRequest(value: unknown) {
  const { ttl_secs: ttl, max_uses: uses = null } = (value ?? {}) as {
    ttl_secs?: unknown;
    max_uses?: unknown;
  };
  if (
    typeof ttl !== "number" ||
    !Number.isSafeInteger(ttl) ||
    ttl < MIN_TTL ||
    ttl > MAX_TTL
  )
    throw new Error("Invalid invite expiry");
  if (
    uses !== null &&
    (typeof uses !== "number" ||
      !Number.isSafeInteger(uses) ||
      uses < 1 ||
      uses > MAX_USES)
  )
    throw new Error("Invalid invite use limit");
  return { ttl_secs: ttl, max_uses: uses };
}

/** `GET /api/invites` path for one page; `before` is the relay's opaque cursor. */
export function inviteListPath(value: unknown) {
  const { before, ...rest } = (value ?? {}) as { before?: unknown };
  if (
    Object.keys(rest).length ||
    (before !== undefined &&
      (typeof before !== "string" ||
        !new RegExp(`^\\d{1,20}_${UUID}$`).test(before)))
  )
    throw new Error("Invalid invite list request");
  return before === undefined
    ? "/api/invites"
    : `/api/invites?before=${before}`;
}

/** Normalized `POST /api/invites/revoke` body: exactly one of `id` or `code`. */
export function revokeRequest(value: unknown) {
  const { id, code, ...rest } = (value ?? {}) as {
    id?: unknown;
    code?: unknown;
  };
  if (Object.keys(rest).length === 0) {
    if (
      typeof id === "string" &&
      code === undefined &&
      new RegExp(`^${UUID}$`).test(id)
    )
      return { id };
    if (
      typeof code === "string" &&
      id === undefined &&
      /^[a-zA-Z0-9._-]{1,256}$/.test(code)
    )
      return { code };
  }
  throw new Error("Invalid revoke request");
}

/** Unsigned NIP-43 add/remove/role command for one member. */
export function memberCommand(
  value: unknown,
  now = Math.floor(Date.now() / 1000),
) {
  const { action, pubkey, role } = (value ?? {}) as {
    action?: unknown;
    pubkey?: unknown;
    role?: unknown;
  };
  const kind =
    typeof action === "string" && Object.hasOwn(KINDS, action)
      ? KINDS[action]
      : undefined;
  if (!kind || typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey))
    throw new Error("Invalid member change");
  if (
    action === "remove"
      ? role !== undefined
      : typeof role !== "string" || !ROLES.includes(role)
  )
    throw new Error("Invalid member role");
  return {
    kind,
    content: "",
    created_at: now,
    tags: [
      ["p", pubkey],
      ...(typeof role === "string" ? [["role", role]] : []),
    ],
  };
}

// Exact relay refusals (buzz-relay relay_admin.rs, ingest.rs, api/invites.rs).
// Anything else, including database/internal text, stays a generic summary.
const REASONS = new Set([
  "invalid: actor not authorized: must be admin or owner",
  "invalid: actor not authorized: must be owner",
  "invalid: actor not authorized: only owner can grant admin role",
  "invalid: actor not authorized: admins can only remove members",
  "invalid: cannot remove yourself",
  "invalid: cannot remove the relay owner",
  "invalid: cannot change your own role",
  "invalid: cannot change the relay owner's role",
  "invalid: cannot set role to owner",
  "blocked: you are banned from this community",
  "only relay owners and admins can create invites",
  "only relay owners and admins can list invites",
  "only relay owners, admins or the invite's creator can revoke it",
  "invite_not_revocable",
  "invite_not_found",
  "invite_restricted",
  "community writes are temporarily unavailable",
]);

/** Relay-authored refusal worth showing verbatim; anything else stays generic. */
export function adminReason(body: unknown): string | undefined {
  const reason = (body as { error?: unknown } | null)?.error;
  if (typeof reason !== "string") return undefined;
  return REASONS.has(reason) ||
    /^invalid: member not found: [0-9a-f]{64}$/.test(reason) ||
    /^(?:ttl_secs|max_uses) must be between \d{1,8} and \d{1,8}$/.test(reason)
    ? reason
    : undefined;
}

// Exact invite-claim refusal codes (buzz-relay api/invites.rs claim_invite).
const CLAIM_REASONS = new Set([
  "invite_expired",
  "invite_exhausted",
  "invite_invalid",
]);

/** Exact relay claim refusal code; anything else stays generic. */
export function claimReason(body: unknown): string | undefined {
  const reason = (body as { error?: unknown } | null)?.error;
  return typeof reason === "string" && CLAIM_REASONS.has(reason)
    ? reason
    : undefined;
}
