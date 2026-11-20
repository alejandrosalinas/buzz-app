// Gateway mode for Pi: the plugin's side of the host's `gateway` calls and
// the route it opens each agent with. Context validation, serialization and
// session lifecycle belong to the shared gateway module: Pi takes
// them as a `GatewaySeam`, and without one every agent is external.
import {
  bindingAdmits,
  bindSession,
  inferenceBundle,
  type GatewayBinding,
  type TurnContext,
} from "../../features/agents/gateway/contract";
import {
  invalidateRoute,
  routeFor,
  routeReady,
  subscribeRoute,
  type GatewayRoute,
  upstreamFor,
} from "../../features/agents/gateway/route";
import { turnContext } from "../../features/agents/gateway/turn";
import type { PiGatewayAnswer, PiGatewayCall } from "./pi";

export type { GatewayRoute };
/** A route, or external with no seam to ask. */
type Route = GatewayRoute | Readonly<{ kind: "external" }>;

/** Pi's stable harness name, which the gateway enables per membership. */
export const HARNESS = "pi";

/** The route Pi's agent runs on: the gateway's only when it is eligible and
 * enables Pi. Any other, blocked or still checking included, runs Pi's own
 * providers, as the runner sends its turns. */
export const gatewayRoute = (route: Route) =>
  route.kind === "eligible" && route.harnesses.includes(HARNESS)
    ? route
    : undefined;

/** The shared gateway module's functions Pi uses. */
export type GatewaySeam = Readonly<{
  routeReady: typeof routeReady;
  routeFor: typeof routeFor;
  subscribeRoute: typeof subscribeRoute;
  invalidateRoute: typeof invalidateRoute;
  bindSession: typeof bindSession;
  inferenceBundle: typeof inferenceBundle;
  bindingAdmits: typeof bindingAdmits;
  turnContext: typeof turnContext;
  upstreamFor: typeof upstreamFor;
}>;

/** This app's: inactive while its gateway descriptor is empty, when every
 * route is external. */
export const GATEWAY_SEAM: GatewaySeam = Object.freeze({
  routeReady,
  routeFor,
  subscribeRoute,
  invalidateRoute,
  bindSession,
  inferenceBundle,
  bindingAdmits,
  turnContext,
  upstreamFor,
});

const LEFT = "This agent can't use the model gateway now";

/** Answers the host from the agent's latest route: a binding for a run
 * before it is submitted, and before each model request, whether the run's
 * binding is still admitted, at which revision, and where that request
 * goes: the gateway's root for Pi and the build's header profile. Pi
 * sends its own model ID there; the gateway resolves it. A 401 or 403 for a
 * request at a revision drops that revision's access; an older one's
 * changes nothing. Never rebinds a run. */
export function answerGateway(
  seam: GatewaySeam | undefined,
  call: PiGatewayCall,
): PiGatewayAnswer {
  if (!seam)
    return { ok: false, message: "The model gateway is not available here" };
  if (call.op === "deny") {
    // Without a revision it would drop whichever is current.
    if (!Number.isSafeInteger(call.revision))
      return { ok: false, message: "A refusal needs its revision" };
    // Applied, it moved the route on; an older revision's changes nothing.
    const before = seam.routeFor(call.agent).revision;
    seam.invalidateRoute(call.agent, call.revision as number);
    return {
      ok: true,
      applied: seam.routeFor(call.agent).revision !== before,
    };
  }
  const route = seam.routeFor(call.agent);
  if (call.op === "admit") {
    // Only while the gateway still enables Pi, whatever the binding.
    if (route.kind === "eligible" && !gatewayRoute(route))
      return { ok: false, message: LEFT };
    // Read strictly by `bindingAdmits`: a malformed one is never admitted.
    const admitted = seam.bindingAdmits(route, call.binding as GatewayBinding);
    if (!admitted.ok) return { ok: false, message: admitted.message };
    const gateway = gatewayRoute(route);
    const upstream = seam.upstreamFor(HARNESS);
    if (!gateway || !upstream) return { ok: false, message: LEFT };
    return {
      ok: true,
      revision: admitted.revision,
      root: `${gateway.gatewayOrigin}${upstream.base}`,
      profile: gateway.profile,
    };
  }
  // A turn binds only while the gateway's route enables Pi.
  const gateway = gatewayRoute(route);
  if (!gateway)
    return {
      ok: false,
      message: route.kind === "blocked" ? route.message : LEFT,
    };
  if (!call.turn)
    return { ok: false, message: "This turn has no Buzz context" };
  const bound = seam.bindSession(gateway, call.saved, call.event);
  if (!bound.ok) return { ok: false, message: bound.message };
  // Validated by `inferenceBundle`, which refuses any other shape.
  const bundle = seam.inferenceBundle(
    gateway.profile,
    bound.binding,
    call.turn as TurnContext,
  );
  if (!bundle.ok) return { ok: false, message: bundle.message };
  return {
    ok: true,
    binding: bound.binding,
    bundle: bundle.value,
    persist: bound.persist,
  };
}
