// Buzz's attribution on a Claude process's own gateway connection: the
// person's settings choose the endpoint and sign-in, and Buzz only adds its
// context headers to `ANTHROPIC_CUSTOM_HEADERS` through Claude's flag
// settings, between turns. Composition and eligibility are pure; the
// process (`claude.ts`) reads its settings and applies the result. Nothing
// here logs a setting's value, which may hold a credential.
import {
  type GatewayHeaders,
  type GatewayProfile,
  isReservedHeader,
} from "../../features/agents/gateway/contract";

/** The harness Claude declares to the gateway, its descriptor upstream key. */
export const HARNESS = "claude-code";

/** What has Claude (2.1.323's strings) send its requests to a provider other
 * than Anthropic's API: on only for "1", "true", "yes" or "on". Read only,
 * so a person's Bedrock or Vertex setup never carries Buzz's context. */
export const PROVIDERS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
] as const;
const ON = new Set(["1", "true", "yes", "on"]);
/** Claude's `account.apiProvider` for Anthropic's own API (2.1.325). */
const FIRST_PARTY = "firstParty";

/** One turn's attribution: the build's gateway origin, which Claude's own
 * endpoint must be on, and the shared contract's validated bundle. */
export type Attribution = Readonly<{
  origin: string;
  profile: GatewayProfile;
  headers: GatewayHeaders;
}>;

/** Claude's settings sources, lowest precedence first (Claude Code's
 * documented order: managed policy, command line, local, project, user).
 * Buzz's apply writes the flag layer; nothing else launches with one. */
const SOURCES = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
] as const;
const FLAG = "flagSettings";
const POLICY = "policySettings";
/** The one flag env key Buzz writes. */
export const HEADERS = "ANTHROPIC_CUSTOM_HEADERS";

/** What a process's settings say now, read at each new turn. */
export type Settings = Readonly<{
  /** The person's own custom headers: the highest source but Buzz's flag
   * layer (and a policy) that sets them, as Claude's newline-separated text. */
  headers: string | undefined;
  endpoint: string | undefined;
  /** It selects a provider other than Anthropic's API. */
  provider: boolean;
  /** A managed policy sets custom headers, which outrank Buzz's. */
  policy: boolean;
  /** The flag layer's env holds any key, or any but Buzz's one. Replacing
   * it drops every other key, so Buzz writes it only when it holds none
   * before Buzz's first write, and none but Buzz's after. */
  flag: Readonly<{ any: boolean; others: boolean }>;
  /** Claude's inherited env sets custom headers, which its settings don't
   * report; undefined when that couldn't be checked. */
  inherited?: boolean | undefined;
}>;

const NOTICE = "Not attributed in the agent gateway";
export const UNREADABLE = `${NOTICE}: Claude didn't report its settings.`;
export const UNAPPLIED = `${NOTICE}: Claude didn't confirm Buzz's header change, so it may send either the earlier or the new headers.`;
export const STALE = `${NOTICE}: Claude didn't report its settings, so it may still send Buzz's earlier headers.`;
export const MASKED = `${NOTICE}: Buzz removed its headers, but until the next turn Claude keeps its current custom headers even if its settings change.`;
export const SHARED = `${NOTICE}: another flag setting now shares Claude's env with Buzz's headers, so Buzz left them rather than erase it.`;
export const PROVIDER = `${NOTICE}: Claude is set to use another provider.`;
export const ELSEWHERE = `${NOTICE}: Claude's own endpoint isn't the agent gateway.`;
export const POLICY_HEADERS = `${NOTICE}: a managed Claude policy sets its custom headers.`;
export const FOREIGN = `${NOTICE}: something other than Buzz set Claude's flag settings env, which Buzz's headers would replace.`;
export const INHERITED = `${NOTICE}: Claude's custom headers come from the app's environment, which Buzz can't read to keep them.`;
export const PROTECTED = `${NOTICE}: protected Claude agents keep their own pinned launch.`;
/** A shared-contract refusal (binding or context) as this turn's notice. */
export const refused = (message: string) => `${NOTICE}: ${message}`;

/** Claude's `get_settings` answer, read by source; undefined when it failed,
 * isn't shaped as expected or names a source whose rank isn't known. */
export function readSettings(answer: unknown): Settings | undefined {
  const response = field(answer, "response");
  const effective = field(field(response, "effective"), "env") ?? {};
  const sources = field(response, "sources");
  if (field(answer, "subtype") !== "success" || !Array.isArray(sources)) return;
  const envs = new Map<string, Record<string, unknown>>();
  for (const entry of sources) {
    const name = String(field(entry, "source"));
    const settings = field(entry, "settings");
    const env = field(settings, "env") ?? {};
    const known = (SOURCES as readonly string[]).includes(name);
    if (!known || envs.has(name) || !record(settings) || !record(env)) return;
    envs.set(name, env);
  }
  if (!record(effective)) return;
  const text = (env: unknown, name: string) => {
    const value = field(env, name);
    return typeof value === "string" ? value : undefined;
  };
  const own = SOURCES.filter((name) => name !== FLAG && name !== POLICY)
    .map((name) => text(envs.get(name), HEADERS))
    .filter((value) => value !== undefined);
  return {
    headers: own.at(-1),
    endpoint: text(effective, "ANTHROPIC_BASE_URL"),
    provider: PROVIDERS.some((name) =>
      ON.has((text(effective, name) ?? "").trim().toLowerCase()),
    ),
    policy: text(envs.get(POLICY), HEADERS) !== undefined,
    flag: {
      any: Object.keys(envs.get(FLAG) ?? {}).length > 0,
      others: Object.keys(envs.get(FLAG) ?? {}).some(
        (name) => name !== HEADERS,
      ),
    },
  };
}

/** Why `settings` can't carry attribution for `origin`, as a notice. The
 * origin is compared (scheme, host and port), never the mode path, and
 * headers only Claude's inherited env sets are never replaced.
 * `provider` is what Claude's `initialize` resolved, which also sees a
 * selector in its process env; only Anthropic's API ("firstParty") or an
 * older Claude that reports none passes. */
export function ineligible(
  settings: Settings,
  origin: string,
  provider?: string,
) {
  if (settings.provider || (provider !== undefined && provider !== FIRST_PARTY))
    return PROVIDER;
  if (originOf(settings.endpoint) !== originOf(origin)) return ELSEWHERE;
  if (settings.policy) return POLICY_HEADERS;
  // A settings value outranks the inherited one, which then never reaches
  // the endpoint; without one, applying ours would replace it for good.
  if (settings.headers === undefined && settings.inherited !== false)
    return settings.inherited ? INHERITED : UNREADABLE;
}

/** `own`'s lines without any header reserved to Buzz, whatever its case
 * or `_`/`-` spelling, then `bundle`'s: other headers pass through as the
 * person wrote them. */
export function customHeaders(
  profile: GatewayProfile,
  own: string | undefined,
  bundle: GatewayHeaders,
) {
  const kept = (own ?? "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() !== "" &&
        !isReservedHeader(profile, line.split(":", 1)[0]?.trim() ?? ""),
    );
  const added = Object.entries(bundle).map(
    ([name, value]) => `${name}: ${value}`,
  );
  return [...kept, ...added].join("\n");
}

const originOf = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, name: string) =>
  record(value) ? value[name] : undefined;
