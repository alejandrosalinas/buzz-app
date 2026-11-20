// Gateway mode for Codex: the Buzz context on a turn whose membership routes
// through the agent gateway. Routing is the person's own: their Codex
// `config.toml`, which the gateway's setup controls, points a local Codex at
// the gateway, and Buzz never changes it. Every thread start or resume of a
// local agent's gateway turn replaces the active provider's headers with its
// own plus the turn's whole inference bundle. Context validation and session
// lifecycle belong to the shared gateway module.
import type { AgentKey } from "../../features/agents/membership";
import type { Delivery } from "../../features/agents/service";
import {
  composeGatewayHeaders,
  type GatewayHeaders,
} from "../../features/agents/gateway/contract";
import {
  routeFor,
  upstreamFor,
  type GatewayRoute,
} from "../../features/agents/gateway/route";

/** Codex's stable harness name, which the gateway enables per membership. */
export const HARNESS = "codex";

/** A delivery's frozen gateway routing. */
export type CodexGateway = NonNullable<Delivery["gateway"]>;
/** A route and upstream with no turn yet. */
export type CodexRoute = Omit<CodexGateway, "turn">;

/** The shared route functions Codex reads outside a delivery, for
 * compaction's route. A running turn keeps the route it was dispatched with;
 * a change applies from the next one. */
export type CodexRoutes = Readonly<{
  routeFor(key: AgentKey): GatewayRoute;
  upstreamFor(harness: string): Readonly<{ base: string }> | undefined;
}>;
export const CODEX_ROUTES: CodexRoutes = Object.freeze({
  routeFor,
  upstreamFor,
});

/** The route a session control (compaction) goes by, read now, as the
 * runner reads a turn's: undefined with gateway mode off (no routes) or
 * where it wouldn't send the agent's turns to the gateway; else the
 * eligible route that enables Codex with its upstream, or the blocked route
 * compaction must handle. */
export function controlRoute(
  routes: CodexRoutes | undefined,
  agent: AgentKey,
):
  | Readonly<{ kind: "eligible"; gateway: CodexRoute }>
  | Readonly<{
      kind: "blocked";
      route: Extract<GatewayRoute, { kind: "blocked" }>;
    }>
  | undefined {
  if (!routes) return undefined;
  const upstream = routes.upstreamFor(HARNESS);
  if (!upstream) return undefined;
  const route = routes.routeFor(agent);
  if (route.kind === "blocked") return { kind: "blocked", route };
  return route.kind === "eligible" && route.harnesses.includes(HARNESS)
    ? { kind: "eligible", gateway: { route, upstream } }
    : undefined;
}

/** The parts of Codex's normalized configuration (`config/read`) read here. */
export type ProviderConfig = Readonly<{
  model_provider?: string | null;
  model_providers?: Readonly<
    Record<
      string,
      Readonly<{
        base_url?: string | null;
        http_headers?: Readonly<Record<string, string>> | null;
      }>
    >
  > | null;
}>;
/** The person's provider that routes to the gateway. */
export type GatewayProvider = Readonly<{
  id: string;
  /** Its configured headers, which a thread's table keeps. */
  headers: Readonly<Record<string, string>>;
}>;

/** Only an active provider on the configured gateway origin receives Buzz
 * context. Codex still owns the mount path and credentials. */
export function gatewayProvider(
  config: ProviderConfig,
  origin: string,
): GatewayProvider | undefined {
  const id = config.model_provider;
  // This ID becomes one segment of a dotted Codex config key.
  if (!id || id === "openai" || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  const provider = config.model_providers?.[id];
  if (!provider?.base_url || !URL.canParse(provider.base_url)) return undefined;
  const endpoint = new URL(provider.base_url);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== origin ||
    endpoint.username ||
    endpoint.password
  )
    return undefined;
  return { id, headers: { ...provider.http_headers } };
}

/** A thread's config override for `provider`: its whole header table, as the
 * person configured it with every Buzz-reserved header replaced by the
 * turn's bundle. A role with no value is absent, never empty. */
export const threadConfig = (
  gateway: Pick<CodexGateway, "route">,
  provider: GatewayProvider,
  bundle: GatewayHeaders,
) => ({
  [`model_providers.${provider.id}.http_headers`]: composeGatewayHeaders(
    gateway.route.profile,
    provider.headers,
    bundle,
  ),
});

export const ELSEWHERE =
  "Ran without the Buzz context: Codex's model provider isn't on the agent gateway.";
export const REMOTE_UNATTRIBUTED =
  "Ran without the Buzz context: Codex on another machine doesn't send the gateway headers yet.";
/** Why a turn ran without the Buzz context it was routed with. */
export const unattributed = (reason: string) =>
  `Ran without the Buzz context: ${reason}`;
