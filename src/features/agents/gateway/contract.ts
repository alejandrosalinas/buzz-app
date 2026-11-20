// Buzz's side of the agent gateway's Buzz context contract. Everything here is
// pure: harness adapters persist what it returns and apply what it composes,
// and every check happens app-side before a request leaves Buzz. A value
// that fails a check fails the whole bundle; a partial bundle is never sent.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const HEX64 = /^[0-9a-f]{64}$/;
/** The whole header block, counted as `name: value\r\n` lines. */
export const GATEWAY_HEADER_BUDGET = 2048;

export const isBuzzUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value) && value !== NIL_UUID;
export const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

/** A membership's immutable provenance within one Buzz session: the agent's
 * owner (never the triggering author), the agent's own hex pubkey (never an
 * AgentKey) and the relay's canonical NIP-11 community UUID. Client-asserted
 * provenance, not authentication: the gateway's ingress owns the principal. */
export type GatewayIdentity = Readonly<{
  community_id: string;
  human_pubkey: string;
  agent_pubkey: string;
}>;
/** Where one native turn happened and the signed event that caused it, if
 * any, frozen when it was dispatched. Tool calls, continuations, retries and
 * steering within the turn keep it. */
export type TurnContext = Readonly<{
  channel_id: string | null;
  message_id: string | null;
  thread_id: string | null;
}>;
/** The Buzz product session saved beside a harness session: its UUID and the
 * identity it was minted for. Distinct from every native session id. */
export type GatewayBinding = Readonly<{
  v: 1;
  client_session_id: string;
  identity: GatewayIdentity;
}>;
export type SessionEvent = "resume" | "reset" | "new_generation" | "standalone";
export type GatewayHeaders = Readonly<Record<Lowercase<string>, string>>;
export type Checked<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>;

/** The eight context roles, in wire order. The build's descriptor names
 * each one's header; a bundle may set only these, and omits a role with no
 * value. */
export const GATEWAY_ROLES = Object.freeze([
  "launcher_client",
  "launcher_session",
  "human_pubkey",
  "agent_pubkey",
  "community_id",
  "channel_id",
  "message_id",
  "thread_id",
] as const);
export type GatewayRole = (typeof GATEWAY_ROLES)[number];
/** The build's context header profile: the launcher value, each role's
 * header name and the prefixes reserved to Buzz. Deployed values come only
 * from the build's descriptor; this code has none. */
export type GatewayProfile = Readonly<{
  launcher_client: string;
  headers: Readonly<Record<GatewayRole, string>>;
  reserved_prefixes: readonly string[];
}>;

/** A header name folded for comparison: ASCII lowercase, `_` as `-`. */
export const foldHeader = (name: string) =>
  name.toLowerCase().replaceAll("_", "-");
/** Whether only Buzz may set `name`: a profile header or a name under one of
 * its reserved prefixes, in any case and with `_` for `-`. Any other header,
 * such as one the gateway or a client library owns, is not Buzz's to
 * remove. */
export const isReservedHeader = (profile: GatewayProfile, name: string) => {
  const folded = foldHeader(name);
  return (
    Object.values(profile.headers).includes(folded) ||
    profile.reserved_prefixes.some((prefix) => folded.startsWith(prefix))
  );
};

export function identityErrors(identity: unknown): string | undefined {
  if (!record(identity) || !exactKeys(identity, IDENTITY_KEYS))
    return "Gateway identity is malformed";
  if (!isBuzzUuid(identity.community_id))
    return "The community's ID isn't a canonical UUID";
  if (!isHex64(identity.human_pubkey))
    return "The agent owner's pubkey isn't 64 lowercase hex";
  if (!isHex64(identity.agent_pubkey))
    return "The agent's pubkey isn't 64 lowercase hex";
}

export function turnErrors(turn: unknown): string | undefined {
  if (!record(turn) || !exactKeys(turn, TURN_KEYS))
    return "Turn context is malformed";
  const nullable = (value: unknown, valid: (value: unknown) => boolean) =>
    value === null || valid(value);
  if (!nullable(turn.channel_id, isBuzzUuid))
    return "The turn's channel ID isn't a canonical UUID";
  if (!nullable(turn.message_id, isHex64))
    return "The turn's message ID isn't 64 lowercase hex";
  if (!nullable(turn.thread_id, isHex64))
    return "The turn's thread ID isn't 64 lowercase hex";
}

/** A new Buzz session UUID: lowercase, hyphenated, version 4. */
export const newBuzzSession = () => crypto.randomUUID().toLowerCase();

/** The binding a harness session should use for `event`, given the identity
 * of an eligible membership and whatever its adapter read back from its own
 * session record (`undefined`/`null` when none). `resume` keeps a saved
 * binding with exactly this identity and creates one when none is saved; a
 * different identity or an unreadable record fails without overwriting it,
 * so only New session (`reset`) or a new native session (`new_generation`)
 * replaces it. `new_generation` is only for an actual harness-session
 * replacement or a confirmed lost session (a resume the harness reports it
 * can't load); a gateway auth, network or readiness failure blocks the
 * route and is never a lost session, so it keeps the saved binding. Starting
 * a new OS process that resumes the same harness session is `resume`.
 * `standalone` is a fresh binding for one turn, never saved.
 * The adapter persists `binding` when `persist` is true, in the same write
 * as its harness session where its storage allows. */
export function bindSession(
  route: Readonly<{ identity: GatewayIdentity }>,
  saved: unknown,
  event: SessionEvent,
):
  | Readonly<{ ok: true; binding: GatewayBinding; persist: boolean }>
  | Readonly<{
      ok: false;
      error: "identity_conflict" | "binding_malformed";
      message: string;
    }> {
  const invalid = identityErrors(route.identity);
  if (invalid) throw new Error(invalid);
  const identity = copyIdentity(route.identity);
  const fresh = (): GatewayBinding =>
    Object.freeze({ v: 1, client_session_id: newBuzzSession(), identity });
  if (event === "standalone")
    return { ok: true, binding: fresh(), persist: false };
  if (event === "reset" || event === "new_generation")
    return { ok: true, binding: fresh(), persist: true };
  if (saved === undefined || saved === null)
    return { ok: true, binding: fresh(), persist: true };
  const binding = parseBinding(saved);
  if (!binding)
    return {
      ok: false,
      error: "binding_malformed",
      message:
        "This conversation's saved Buzz session is unreadable. Start a new session to continue.",
    };
  if (!sameIdentity(binding.identity, identity))
    return {
      ok: false,
      error: "identity_conflict",
      message:
        "This conversation's Buzz session belongs to a different owner, agent or community. Start a new session to continue.",
    };
  return { ok: true, binding, persist: false };
}

/** A saved binding, read strictly: exact keys and canonical values only. */
export function parseBinding(saved: unknown): GatewayBinding | undefined {
  if (
    !record(saved) ||
    !exactKeys(saved, BINDING_KEYS) ||
    saved.v !== 1 ||
    !isBuzzUuid(saved.client_session_id) ||
    identityErrors(saved.identity)
  )
    return;
  return Object.freeze({
    v: 1,
    client_session_id: saved.client_session_id,
    identity: copyIdentity(saved.identity as GatewayIdentity),
  });
}

/** The inference headers for one request of the turn, all or nothing. */
export function inferenceBundle(
  profile: GatewayProfile,
  binding: GatewayBinding,
  turn: TurnContext,
): Checked<GatewayHeaders> {
  const parsed = parseBinding(binding);
  if (!parsed) return failed("The Buzz session binding is malformed");
  const invalid = turnErrors(turn);
  if (invalid) return failed(invalid);
  return bundle(profile, parsed.client_session_id, parsed.identity, turn);
}

/** Discovery headers for a membership: available identity only, with the
 * Buzz session when one already exists. The gateway knows discovery by its
 * endpoint; it carries no channel, message or thread. */
export function discoveryBundle(
  profile: GatewayProfile,
  route: Readonly<{ identity: GatewayIdentity }>,
  binding?: GatewayBinding,
): Checked<GatewayHeaders> {
  const invalid = identityErrors(route.identity);
  if (invalid) return failed(invalid);
  let session: string | null = null;
  if (binding !== undefined) {
    const parsed = parseBinding(binding);
    if (!parsed) return failed("The Buzz session binding is malformed");
    if (!sameIdentity(parsed.identity, route.identity))
      return failed("The Buzz session belongs to a different membership");
    session = parsed.client_session_id;
  }
  return bundle(profile, session, route.identity, {});
}

/** `assembled` with every reserved header removed, whatever its case or
 * `_`/`-` spelling and whether or not the bundle sets it, then `bundle`
 * added: one authoritative set with no stale Buzz provenance. Untrusted
 * headers are stripped first; the bundle itself is never stripped. Other
 * headers pass through unchanged. The bundle may set only the profile's
 * header names, each lowercase, so a stored bundle carrying a retired or
 * unknown name is refused rather than replayed.
 * Adapters that cannot import this (Pi's host) carry a copy checked against
 * `COMPOSE_VECTORS`. */
export function composeGatewayHeaders(
  profile: GatewayProfile,
  assembled: Readonly<Record<string, string>>,
  bundle: GatewayHeaders,
): Record<string, string> {
  const names: readonly string[] = Object.values(profile.headers);
  for (const name of Object.keys(bundle))
    if (!names.includes(name))
      throw new Error(
        "A gateway bundle may only set the profile's context headers",
      );
  const composed: Record<string, string> = {};
  for (const [name, value] of Object.entries(assembled))
    if (!isReservedHeader(profile, name)) composed[name] = value;
  return Object.assign(composed, bundle);
}

/** Whether a stored binding may still dispatch through `route`: only an
 * eligible route whose identity is exactly the binding's. A run keeps its
 * frozen context, but it stops dispatching once its membership is blocked,
 * pending readiness, external or bound to another identity. The answer holds
 * only at `revision`, the route's eligibility revision: native admission
 * pairs the two, and any later revision supersedes it. */
export function bindingAdmits<Reason extends string>(
  route:
    | Readonly<{ kind: "external"; revision: number }>
    | Readonly<{
        kind: "eligible";
        identity: GatewayIdentity;
        revision: number;
      }>
    | Readonly<{
        kind: "blocked";
        reason: Reason;
        message: string;
        revision: number;
      }>,
  binding: GatewayBinding,
):
  | Readonly<{ ok: true; revision: number }>
  | Readonly<{
      ok: false;
      reason: Reason | "binding_changed";
      message: string;
      revision: number;
    }> {
  const { revision } = route;
  if (route.kind === "blocked")
    return {
      ok: false,
      reason: route.reason,
      message: route.message,
      revision,
    };
  const parsed = parseBinding(binding);
  if (
    route.kind === "eligible" &&
    parsed &&
    sameIdentity(parsed.identity, route.identity)
  )
    return { ok: true, revision };
  return {
    ok: false,
    reason: "binding_changed",
    message:
      "This agent's gateway routing changed during the turn. Send the message again to continue.",
    revision,
  };
}

const IDENTITY_KEYS = ["agent_pubkey", "community_id", "human_pubkey"];
const TURN_KEYS = ["channel_id", "message_id", "thread_id"];
const BINDING_KEYS = ["client_session_id", "identity", "v"];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join() === keys.join();
const copyIdentity = (identity: GatewayIdentity): GatewayIdentity =>
  Object.freeze({
    community_id: identity.community_id,
    human_pubkey: identity.human_pubkey,
    agent_pubkey: identity.agent_pubkey,
  });
const sameIdentity = (a: GatewayIdentity, b: GatewayIdentity) =>
  a.community_id === b.community_id &&
  a.human_pubkey === b.human_pubkey &&
  a.agent_pubkey === b.agent_pubkey;
const failed = (message: string) => ({ ok: false as const, message });

type BundleFields = Readonly<{
  channel_id?: string | null;
  message_id?: string | null;
  thread_id?: string | null;
}>;
/** The wire form: lowercase names, an omitted header for null, the
 * roles' order, and the whole block within its byte budget. */
function bundle(
  profile: GatewayProfile,
  session: string | null,
  identity: GatewayIdentity,
  fields: BundleFields,
): Checked<GatewayHeaders> {
  const values: Record<GatewayRole, string | null | undefined> = {
    launcher_client: profile.launcher_client,
    launcher_session: session,
    human_pubkey: identity.human_pubkey,
    agent_pubkey: identity.agent_pubkey,
    community_id: identity.community_id,
    channel_id: fields.channel_id,
    message_id: fields.message_id,
    thread_id: fields.thread_id,
  };
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const role of GATEWAY_ROLES) {
    const name = profile.headers[role];
    const value = values[role];
    if (value === null || value === undefined) continue;
    const text = String(value);
    // Every value is validated ASCII, so characters are bytes.
    if (!/^[\x21-\x7e]+$/.test(text))
      return failed(`${name} has a non-printable value`);
    headers[name] = text;
    bytes += name.length + 2 + text.length + 2;
  }
  if (bytes > GATEWAY_HEADER_BUDGET)
    return failed("The gateway headers exceed their 2048-byte budget");
  return { ok: true, value: Object.freeze(headers) };
}
