import { relayOrigin } from "../../communities/destination.ts";
import {
  foldHeader,
  GATEWAY_ROLES,
  type GatewayRole,
  isBuzzUuid,
} from "./contract.ts";

/** The deployment descriptor `BUZZ_AGENT_GATEWAY`: non-secret routing data
 * for one agent gateway. It names the gateway origin, the exact communities
 * whose local agent memberships route through it, the access check's path,
 * the context header profile and each harness's upstream base. It carries no
 * credential. Values come from the build's input; an omitted launcher_client
 * defaults to "buzz". Compiled into the frontend, and validated independently
 * by native, which compiles only what it enforces. Unset or blank turns
 * gateway routing off everywhere; anything else must be a valid version 2
 * descriptor, or the build fails. */
export type GatewayDescriptor = Readonly<{
  version: 2;
  gateway: string;
  communities: readonly Readonly<{ id: string; origin: string }>[];
  access_path: string;
  launcher_client: string;
  headers: Readonly<Record<GatewayRole, string>>;
  reserved_prefixes: readonly string[];
  upstreams: Readonly<Partial<Record<UpstreamKey, Readonly<{ base: string }>>>>;
}>;

/** Harness names a descriptor may give an upstream base. An absent entry
 * opts that harness out: it keeps the user's own configuration. */
export const UPSTREAM_KEYS = Object.freeze([
  "claude-code",
  "goose",
  "codex",
  "pi",
] as const);
export type UpstreamKey = (typeof UPSTREAM_KEYS)[number];

/** Headers no context name or reserved prefix may touch, compared after
 * folding (ASCII lowercase, `_` to `-`): hop-by-hop and routing headers,
 * credentials, body protocol headers, vendor protocol and SDK headers, and
 * the harnesses' own session headers. Native holds the same list; the shared
 * vectors pin both. */
export const PROTECTED_HEADERS = Object.freeze({
  exact: Object.freeze([
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "host",
    "origin",
    "content-length",
    "content-type",
    "content-encoding",
    "accept-encoding",
    "expect",
    "authorization",
    "x-api-key",
    "cookie",
    "x-goog-api-key",
    "user-agent",
    "anthropic-version",
    "anthropic-beta",
    "x-claude-code-session-id",
    "agent-session-id",
  ]),
  families: Object.freeze([
    "x-amz-",
    "anthropic-",
    "x-stainless-",
    "sec-",
    "proxy-",
    "content-",
  ]),
});

/** Why a descriptor was refused. Messages are fixed per code and never echo
 * the descriptor or any value in it. */
export type DescriptorError =
  | "json"
  | "size"
  | "keys"
  | "version"
  | "gateway"
  | "communities"
  | "path"
  | "launcher_client"
  | "header_name"
  | "header_duplicate"
  | "header_protected"
  | "prefix"
  | "prefix_protected"
  | "upstreams";
const MESSAGES: Record<DescriptorError, string> = {
  json: "it isn't JSON",
  size: "it's larger than 8 KiB",
  keys: "expected version, gateway, communities, access_path, headers, reserved_prefixes and upstreams, with optional launcher_client",
  version: "version must be 2",
  gateway: "gateway must be an https:// origin with no path or credentials",
  communities: `communities must list 1 to 16 unique communities, each exactly a canonical NIP-11 UUID id and a secure origin`,
  path: "access_path and each upstream base must be a plain absolute path",
  launcher_client:
    "launcher_client must be 1 to 64 letters, digits, '.', '_' or '-'",
  header_name:
    "headers must name exactly the eight roles, each a lowercase header name of up to 64 bytes",
  header_duplicate: "header names must be unique",
  header_protected: "a header name collides with a protected header",
  prefix:
    "reserved_prefixes must list up to 4 lowercase prefixes of 4 to 64 bytes ending in '-'",
  prefix_protected: "a reserved prefix overlaps a protected header",
  upstreams: "upstreams may only map known harnesses to exactly { base }",
};

export class GatewayDescriptorError extends Error {
  constructor(readonly code: DescriptorError) {
    super(`BUZZ_AGENT_GATEWAY is invalid: ${MESSAGES[code]}.`);
  }
}

const MAX_BYTES = 8192;
const COMMUNITY_LIMIT = 16;
const PREFIX_LIMIT = 4;
const PATH = /^(?:\/[A-Za-z0-9._-]+)+$/;
const PATH_BYTES = 256;
const HEADER = /^[a-z0-9-]{1,64}$/;
const PREFIX = /^[a-z0-9-]{3,63}-$/;
const LAUNCHER = /^[A-Za-z0-9._-]{1,64}$/;
const KEYS = [
  "access_path",
  "communities",
  "gateway",
  "headers",
  "launcher_client",
  "reserved_prefixes",
  "upstreams",
  "version",
].join();

/** The descriptor in `raw`, canonicalized, or null when `raw` is blank.
 * Throws `GatewayDescriptorError` on anything else. Checks run in a fixed
 * order (size, JSON, version, key shape, then each field) so native, which
 * checks in the same order, refuses with the same code. */
export function parseGatewayDescriptor(raw: string): GatewayDescriptor | null {
  if (!raw.trim()) return null;
  const fail = (code: DescriptorError): never => {
    throw new GatewayDescriptorError(code);
  };
  if (new TextEncoder().encode(raw).length > MAX_BYTES) fail("size");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("json");
  }
  if (!plain(value)) return fail("keys");
  if (value.version !== 2) fail("version");
  if (keys({ launcher_client: "buzz", ...value }) !== KEYS) fail("keys");

  const gateway = typeof value.gateway === "string" ? value.gateway : "";
  const url = URL.canParse(gateway) ? new URL(gateway) : null;
  if (url?.protocol !== "https:" || url.origin !== gateway) fail("gateway");

  const listed = value.communities;
  if (
    !Array.isArray(listed) ||
    listed.length === 0 ||
    listed.length > COMMUNITY_LIMIT
  )
    fail("communities");
  const communities = (listed as unknown[]).map((community) => {
    if (
      !plain(community) ||
      keys(community) !== "id,origin" ||
      !isBuzzUuid(community.id)
    )
      return fail("communities");
    try {
      return Object.freeze({
        id: community.id,
        origin: relayOrigin(String(community.origin)),
      });
    } catch {
      return fail("communities");
    }
  });
  if (
    !unique(communities.map(({ id }) => id)) ||
    !unique(communities.map(({ origin }) => origin))
  )
    fail("communities");

  if (!isPath(value.access_path)) fail("path");

  const launcherClient =
    value.launcher_client === undefined ? "buzz" : value.launcher_client;
  if (typeof launcherClient !== "string" || !LAUNCHER.test(launcherClient))
    fail("launcher_client");

  const headers = value.headers;
  if (
    !plain(headers) ||
    keys(headers) !== [...GATEWAY_ROLES].sort().join() ||
    !GATEWAY_ROLES.every(
      (role) => typeof headers[role] === "string" && HEADER.test(headers[role]),
    )
  )
    return fail("header_name");
  const names = GATEWAY_ROLES.map((role) => headers[role] as string);
  if (names.some(protectedName)) fail("header_protected");
  if (!unique(names)) fail("header_duplicate");

  const prefixes = value.reserved_prefixes;
  if (
    !Array.isArray(prefixes) ||
    prefixes.length > PREFIX_LIMIT ||
    !prefixes.every(
      (prefix) => typeof prefix === "string" && PREFIX.test(prefix),
    ) ||
    !unique(prefixes)
  )
    return fail("prefix");
  if ((prefixes as string[]).some(protectedPrefix)) fail("prefix_protected");

  const upstreams = value.upstreams;
  if (!plain(upstreams)) return fail("upstreams");
  const entries = Object.entries(upstreams);
  if (
    !entries.every(
      ([key, entry]) =>
        (UPSTREAM_KEYS as readonly string[]).includes(key) &&
        plain(entry) &&
        keys(entry) === "base",
    )
  )
    fail("upstreams");
  const bases = new Map(
    entries.map(([key, entry]) => [key, (entry as { base: unknown }).base]),
  );
  if (![...bases.values()].every(isPath)) fail("path");

  return Object.freeze({
    version: 2,
    gateway,
    communities: Object.freeze(communities),
    access_path: value.access_path as string,
    launcher_client: launcherClient as string,
    headers: Object.freeze(
      Object.fromEntries(GATEWAY_ROLES.map((role, i) => [role, names[i]])),
    ) as GatewayDescriptor["headers"],
    reserved_prefixes: Object.freeze([...(prefixes as string[])]),
    upstreams: Object.freeze(
      Object.fromEntries(
        UPSTREAM_KEYS.flatMap((key) =>
          bases.has(key)
            ? [[key, Object.freeze({ base: bases.get(key) as string })]]
            : [],
        ),
      ),
    ),
  });
}

/** At most this many descriptors in `src/bundled/org-gateways.json`. */
const ORG_GATEWAY_LIMIT = 8;

/** The build's descriptor: an explicit `BUZZ_AGENT_GATEWAY` when one is
 * set, else the entry of `src/bundled/org-gateways.json` (an organization's
 * packaged descriptors, `[]` in open-source builds) that lists the build's
 * `BUZZ_DEFAULT_COMMUNITY_URL`, else none. Every listed entry is checked
 * even when none is chosen, and no community may be listed twice, so a bad
 * file fails every build that carries it. Native selects the same way
 * (`crates/plugin-manager/src/gateway.rs`); the shared vectors pin both. */
export function selectGatewayDescriptor(
  explicit: string,
  listed: string,
  communityUrl: string,
): GatewayDescriptor | null {
  const fail = (problem: string): never => {
    throw new Error(`src/bundled/org-gateways.json is invalid: ${problem}.`);
  };
  let entries: unknown;
  try {
    entries = JSON.parse(listed);
  } catch {
    fail("it is not JSON");
  }
  if (!Array.isArray(entries) || entries.length > ORG_GATEWAY_LIMIT)
    fail(`it must be a list of at most ${ORG_GATEWAY_LIMIT} descriptors`);
  const descriptors = (entries as unknown[]).map((entry) => {
    if (!plain(entry)) return fail("each entry must be a descriptor");
    try {
      return parseGatewayDescriptor(JSON.stringify(entry)) as GatewayDescriptor;
    } catch (error) {
      if (!(error instanceof GatewayDescriptorError)) throw error;
      return fail(`an entry is invalid (${error.code})`);
    }
  });
  const origins = descriptors.flatMap(({ communities }) =>
    communities.map(({ origin }) => origin),
  );
  if (!unique(origins)) fail("two entries list the same community");
  const chosen = parseGatewayDescriptor(explicit);
  if (chosen) return chosen;
  // A blank or non-secure URL selects nothing rather than failing: dev builds
  // may point at a local ws:// relay, and Vite's build check already refuses a
  // bad URL for packaged frontends.
  let origin: string;
  try {
    origin = relayOrigin(communityUrl);
  } catch {
    return null;
  }
  return (
    descriptors.find(({ communities }) =>
      communities.some((community) => community.origin === origin),
    ) ?? null
  );
}

/** This build's descriptor. Vite validated it, so it parses. */
export function gatewayDescriptor(): GatewayDescriptor | null {
  return parseGatewayDescriptor(import.meta.env.VITE_BUZZ_AGENT_GATEWAY ?? "");
}

/** An absolute path of plain segments: no dot segments, empty segments,
 * trailing slash, escapes, query, fragment or non-ASCII, so joining a fixed
 * route onto it can't leave it or the gateway origin. */
const isPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= PATH_BYTES &&
  PATH.test(value) &&
  !value.split("/").some((segment) => segment === "." || segment === "..");
/** A context header name that is, or falls in a family of, protected
 * headers. */
const protectedName = (name: string) =>
  PROTECTED_HEADERS.exact.includes(foldHeader(name)) ||
  PROTECTED_HEADERS.families.some((family) =>
    foldHeader(name).startsWith(family),
  );
/** A reserved prefix that would strip a protected header, sits inside a
 * protected family, or is broader than one. */
const protectedPrefix = (prefix: string) =>
  PROTECTED_HEADERS.exact.some((name) => name.startsWith(prefix)) ||
  PROTECTED_HEADERS.families.some(
    (family) => prefix.startsWith(family) || family.startsWith(prefix),
  );
const unique = (values: unknown[]) => new Set(values).size === values.length;
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>) =>
  Object.keys(value).sort().join();
