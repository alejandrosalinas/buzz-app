import type { HostRequest, HostResponse } from "../../host/service";
import type { AgentKey } from "../membership";
import {
  discoveryBundle,
  type GatewayIdentity,
  type GatewayProfile,
  identityErrors,
} from "./contract";
import { gatewayDescriptor, type GatewayDescriptor } from "./descriptor";

// One owner decides, per local agent membership, whether its inference goes
// through the agent gateway. Only an origin the descriptor doesn't name
// is external. A named community stays blocked until its exact NIP-11 ID,
// the agent's identity and the access check are all confirmed, and goes back
// to pending on any change, so the route itself never reads as external or
// as a stale eligible route on the way.
//
// What a turn does with a blocked route is the runner's policy, decided
// before dispatch: `auth` (a 401 or 403) fails the turn, and so does a route
// still pending after the bounded wait (`TURN_READINESS_WAIT_MS`), since its
// access decision could yet be a denial. Every other reason runs the turn on
// the harness's own configuration (direct providers) with a notice. An
// invalid runtime descriptor gives no upstream, so its turns run unchanged
// with no notice: that fails open, and the build-time descriptor checks keep
// it rare.
//
// Every route carries the membership's eligibility revision. It rises
// synchronously whenever the route returns to pending (a membership change,
// removal, a 401/403, a retried failure), before any probe starts, and once
// more when a probe started at the current revision publishes its result. A
// probe that settles after the revision moved is discarded. So an answer is
// only ever valid at one revision, and native admission (which owns the
// handles and generations) can apply the highest revision it has seen and
// terminally revoke what opened under an older one. Nothing here re-probes
// on a schedule: a re-probe revokes the turns running under the old revision.

export type BlockedReason =
  | "readiness_pending"
  | "descriptor_invalid"
  | "community_id_missing"
  | "community_id_mismatch"
  | "identity_invalid"
  | "auth"
  | "network"
  | "gateway_error";
export type EligibleRoute = Readonly<{
  kind: "eligible";
  revision: number;
  gatewayOrigin: string;
  identity: GatewayIdentity;
  /** The build's context header profile, for the adapter's composer. */
  profile: GatewayProfile;
  /** The harnesses the gateway enables for this membership (its rollout
   * flag); a harness not listed keeps its existing behavior. */
  harnesses: readonly string[];
}>;
export type BlockedRoute = Readonly<{
  kind: "blocked";
  revision: number;
  gatewayOrigin: string;
  reason: BlockedReason;
  message: string;
}>;
export type GatewayRoute =
  | Readonly<{ kind: "external"; revision: number }>
  | EligibleRoute
  | BlockedRoute;

/** A local agent membership as Agents knows it. `community` is undefined
 * while the community has no live relay session, then what that session's
 * transport read from NIP-11 `read_state_snapshot.community_id` when it was
 * created (undefined id: none), with the session it came from. A socket
 * reconnect keeps the session, so it changes nothing; a replaced session is
 * new evidence and returns the route to pending, even with the same ID. An
 * older session's ID never stands in for a new one's. */
export type GatewayMembership = Readonly<{
  key: AgentKey;
  origin: string;
  owner: string;
  pubkey: string;
  community?: Readonly<{ id: string | undefined; session: object }> | undefined;
}>;
/** Sends one GET through a native grant for the gateway origin. */
export type GatewayRequest = (request: HostRequest) => Promise<HostResponse>;

const MESSAGES: Record<BlockedReason, string> = {
  readiness_pending:
    "Buzz is still checking this agent's gateway access. Try again in a moment.",
  descriptor_invalid:
    "This build's agent gateway configuration is invalid, so its agents can't run.",
  community_id_missing:
    "This community didn't identify itself, so its agents can't use the agent gateway. Try again once it reconnects.",
  community_id_mismatch:
    "This community's ID doesn't match this build's agent gateway configuration, so its agents can't run.",
  identity_invalid:
    "This agent's owner or key isn't valid for gateway routing.",
  auth: "The agent gateway didn't accept your sign-in or denied this agent. Sign in again, then retry.",
  network:
    "Buzz couldn't reach the agent gateway. Check your network connection, then try again.",
  gateway_error:
    "The agent gateway couldn't confirm model access. Try again shortly.",
};

/** A blocked reason a turn falls back on; `auth` and an unresolved
 * `readiness_pending` fail the turn instead. */
export type FallbackReason = Exclude<
  BlockedReason,
  "auth" | "readiness_pending"
>;
/** Why a turn ran without the gateway, as its per-turn notice says. */
const FALLBACK: Record<FallbackReason, string> = {
  descriptor_invalid: "this build's agent gateway configuration is invalid",
  community_id_missing: "this community didn't identify itself",
  community_id_mismatch:
    "this community doesn't match this build's agent gateway configuration",
  identity_invalid: "this agent's owner or key isn't valid for the gateway",
  network: "Buzz couldn't reach the gateway",
  gateway_error: "the gateway couldn't confirm model access",
};
/** The notice on a turn that a blocked route sent to the harness's own
 * configuration before dispatch, instead of failing it. */
export const fallbackNotice = (reason: FallbackReason) =>
  `Ran without the agent gateway: ${FALLBACK[reason]}.`;
/** Why an attribution-only turn ran unattributed: every blocked reason,
 * since attribution never stops a turn. */
const UNATTRIBUTED: Record<BlockedReason, string> = {
  ...FALLBACK,
  auth: "the agent gateway didn't accept your sign-in or denied this agent",
  readiness_pending: "Buzz was still checking this agent's gateway access",
};
/** The notice on an attribution-only turn that a blocked route left
 * unattributed. Its harness runs on its own configuration, which may still
 * point at the gateway, so this says nothing about where inference went. */
export const unattributedNotice = (reason: BlockedReason) =>
  `Ran without gateway attribution: ${UNATTRIBUTED[reason]}.`;

/** How long a turn waits for an access check in flight, such as the first
 * one at cold start, before it fails as still pending. Below the probe's own
 * request timeout, so a hung gateway delays a turn by this much at most. */
export const TURN_READINESS_WAIT_MS = 5_000;
/** The pause before a failed access check (anything but a 401 or 403) is
 * tried once more. */
export const PROBE_RETRY_DELAY_MS = 500;

type Readiness =
  | Readonly<{ status: "probing"; settled: Promise<void> }>
  | Readonly<{ status: "ready"; answer: AccessAnswer }>
  | Readonly<{ status: "failed"; reason: BlockedReason }>;
type AccessAnswer = Readonly<{ harnesses: readonly string[] }>;

export class GatewayRoutes {
  private readonly members = new Map<AgentKey, GatewayMembership>();
  /** By (AgentKey, gateway origin, community ID): the app doesn't know the
   * signed-in principal, so the agent binding is the cache boundary. */
  private readonly readiness = new Map<string, Readiness>();
  /** A recheck's progress or failure cannot erase a known 401/403. Only a
   * successful check or a membership context reset clears the refusal. */
  private readonly authRefusals = new Set<string>();
  /** Kept after a membership is removed, so a membership that comes back
   * never reuses a revision. */
  private readonly revisions = new Map<AgentKey, number>();
  private readonly listeners = new Map<AgentKey, Set<() => void>>();
  private request: GatewayRequest | undefined;
  private readonly descriptor: GatewayDescriptor | null | "invalid";
  private readonly profile: GatewayProfile | undefined;

  constructor(descriptor: () => GatewayDescriptor | null) {
    let parsed: GatewayDescriptor | null | "invalid";
    try {
      parsed = descriptor();
    } catch {
      parsed = "invalid";
    }
    this.descriptor = parsed;
    if (parsed !== null && parsed !== "invalid")
      this.profile = Object.freeze({
        launcher_client: parsed.launcher_client,
        headers: parsed.headers,
        reserved_prefixes: parsed.reserved_prefixes,
      });
  }

  /** Whether any membership could route through the gateway in this build. */
  get configured() {
    return this.descriptor !== null;
  }

  /** The upstream base this build configures for `harness`, or undefined
   * when it has none: an unconfigured harness keeps the user's own
   * configuration, without a fallback notice. */
  upstream(harness: string): Readonly<{ base: string }> | undefined {
    const descriptor = this.descriptor;
    if (descriptor === null || descriptor === "invalid") return;
    return Object.hasOwn(descriptor.upstreams, harness)
      ? descriptor.upstreams[harness as keyof typeof descriptor.upstreams]
      : undefined;
  }

  /** Lets readiness probes go out through `request` until the returned
   * function is called. Pending memberships are probed at once. */
  bindRequest(request: GatewayRequest) {
    this.request = request;
    for (const key of this.members.keys()) this.probe(key);
    return () => {
      if (this.request === request) this.request = undefined;
    };
  }

  /** Records `member`'s current state. Any change to what decides its route
   * returns it to pending and probes it again. */
  setMembership(member: GatewayMembership) {
    const prior = this.members.get(member.key);
    if (
      prior &&
      prior.origin === member.origin &&
      prior.owner === member.owner &&
      prior.pubkey === member.pubkey &&
      prior.community?.session === member.community?.session &&
      prior.community?.id === member.community?.id
    )
      return;
    if (prior) this.forget(prior);
    this.members.set(member.key, member);
    this.bump(member.key);
    this.probe(member.key);
    this.notify(member.key);
  }

  removeMembership(key: AgentKey) {
    const prior = this.members.get(key);
    if (!prior) return;
    this.forget(prior);
    this.members.delete(key);
    this.bump(key);
    this.notify(key);
  }

  /** The membership's route now. An unknown membership is external only when
   * this build has no gateway configuration; otherwise it is pending. */
  routeFor(key: AgentKey): GatewayRoute {
    const decided = this.decide(key);
    if (decided.kind !== "pending") return decided.route;
    if (this.authRefusals.has(decided.cache))
      return blocked(decided.gateway, "auth", this.revision(key));
    const state = this.readiness.get(decided.cache);
    return state?.status === "ready"
      ? Object.freeze({
          kind: "eligible",
          revision: this.revision(key),
          gatewayOrigin: decided.gateway,
          identity: decided.identity,
          profile: decided.profile,
          ...state.answer,
        })
      : blocked(
          decided.gateway,
          state?.status === "failed" ? state.reason : "readiness_pending",
          this.revision(key),
        );
  }

  /** The membership's route for a turn starting now. While an access check
   * is in flight (pending at cold start, or after `invalidate`), the turn
   * waits for it until `wait` aborts, then takes the route as it stands, so
   * a check that outlasts the wait leaves it pending. With no request bound
   * or nothing in flight it doesn't wait at all. A failed route is checked
   * again, so a turn can route after a network blip; the turn waits for that
   * recheck like any other, since its answer could be a denial, except that
   * a failed check's auth refusal is returned at once. A known auth refusal
   * remains effective throughout rechecks, even when they fail or outlast
   * the wait. The caller owns the
   * wait's cap and any cancellation, and checks its own signal afterwards. */
  async routeForTurn(key: AgentKey, wait?: AbortSignal): Promise<GatewayRoute> {
    const route = this.routeFor(key);
    const decided = this.decide(key);
    if (decided.kind !== "pending") return route;
    const state = this.readiness.get(decided.cache);
    if (state?.status === "failed") {
      if (!this.request) return route;
      // Nothing is admitted at a failed revision, so retrying revokes nothing.
      this.readiness.delete(decided.cache);
      this.bump(key);
      this.probe(key);
      this.notify(key);
      // Auth refusals stand independently of the recheck's readiness.
      if (route.kind === "blocked" && route.reason === "auth") return route;
    }
    if (!wait) return this.routeFor(key);
    // A probe discarded because the membership changed meanwhile leaves a
    // newer one in flight: wait for that too, under the same cap.
    for (
      let probing = this.inFlight(key);
      probing && !wait.aborted;
      probing = this.inFlight(key)
    )
      await settledOrAborted(probing, wait);
    return this.routeFor(key);
  }

  /** The membership's route once readiness has settled, for an explicit
   * operation that may wait, such as a harness retrying model discovery;
   * turns use `routeForTurn` instead. A failed probe is tried once more
   * here. */
  async routeReady(key: AgentKey, signal: AbortSignal) {
    signal.throwIfAborted();
    const decided = this.decide(key);
    if (decided.kind !== "pending") return decided.route;
    if (this.readiness.get(decided.cache)?.status === "failed") {
      // Nothing is admitted at a failed revision, so retrying revokes nothing.
      this.readiness.delete(decided.cache);
      this.bump(key);
      this.notify(key);
    }
    // A probe discarded because the membership changed meanwhile leaves a
    // newer one in flight: wait for that too.
    for (let probing = this.probe(key); probing; probing = this.probe(key)) {
      await settledOrAborted(probing, signal);
      signal.throwIfAborted();
    }
    return this.routeFor(key);
  }

  subscribeRoute(key: AgentKey, listener: () => void) {
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  /** Revokes the membership's access on a 401 or 403 from discovery or
   * inference: auth-blocked until a new probe succeeds or its context resets.
   * Given the revision the failing request ran under, a late failure from an
   * older revision doesn't discard a newer answer. */
  invalidate(key: AgentKey, revision?: number) {
    if (revision !== undefined && revision !== this.revision(key)) return;
    const decided = this.decide(key);
    if (decided.kind !== "pending") return;
    this.authRefusals.add(decided.cache);
    this.readiness.delete(decided.cache);
    this.bump(key);
    this.probe(key);
    this.notify(key);
  }

  private decide(key: AgentKey):
    | Readonly<{ kind: "decided"; route: GatewayRoute }>
    | Readonly<{
        kind: "pending";
        gateway: string;
        url: string;
        profile: GatewayProfile;
        identity: GatewayIdentity;
        cache: string;
      }> {
    const revision = this.revision(key);
    const decided = (route: GatewayRoute) =>
      ({ kind: "decided", route }) as const;
    const external = decided(Object.freeze({ kind: "external", revision }));
    const descriptor = this.descriptor;
    if (descriptor === null) return external;
    const profile = this.profile;
    if (descriptor === "invalid" || !profile)
      return decided(blocked("", "descriptor_invalid", revision));
    const member = this.members.get(key);
    const community =
      member &&
      descriptor.communities.find(({ origin }) => origin === member.origin);
    // Unknown here means not fed yet or removed: never external while a
    // descriptor is configured, so a stale key can't reach direct providers.
    if (!member) return decided(blocked("", "readiness_pending", revision));
    if (!community) return external;
    const gateway = descriptor.gateway;
    if (!member.community)
      return decided(blocked(gateway, "readiness_pending", revision));
    if (member.community.id === undefined)
      return decided(blocked(gateway, "community_id_missing", revision));
    if (member.community.id !== community.id)
      return decided(blocked(gateway, "community_id_mismatch", revision));
    const identity = Object.freeze({
      community_id: community.id,
      human_pubkey: member.owner,
      agent_pubkey: member.pubkey,
    });
    if (identityErrors(identity))
      return decided(blocked(gateway, "identity_invalid", revision));
    return {
      kind: "pending",
      gateway,
      url: `${gateway}${descriptor.access_path}`,
      profile,
      identity,
      cache: JSON.stringify([key, gateway, community.id]),
    };
  }

  /** The membership's access check in flight, if any, without starting one. */
  private inFlight(key: AgentKey): Promise<void> | undefined {
    const decided = this.decide(key);
    if (decided.kind !== "pending") return;
    const state = this.readiness.get(decided.cache);
    return state?.status === "probing" ? state.settled : undefined;
  }

  /** Starts an access check for the membership when it needs one and a
   * request path is bound; returns the probe in flight, if any. */
  private probe(key: AgentKey): Promise<void> | undefined {
    const decided = this.decide(key);
    if (decided.kind !== "pending") return;
    const state = this.readiness.get(decided.cache);
    if (state?.status === "probing") return state.settled;
    if (state) return;
    const request = this.request;
    if (!request) return;
    const headers = discoveryBundle(decided.profile, {
      identity: decided.identity,
    });
    if (!headers.ok) return;
    const started = this.revision(key);
    const settled = probeAccess(request, decided.url, headers.value).then(
      (result) => {
        if (this.readiness.get(decided.cache) !== probing) return;
        if (this.revision(key) !== started) {
          this.readiness.delete(decided.cache);
          return;
        }
        this.bump(key);
        if (!("reason" in result)) this.authRefusals.delete(decided.cache);
        else if (result.reason === "auth") this.authRefusals.add(decided.cache);
        this.readiness.set(
          decided.cache,
          Object.freeze(
            "reason" in result
              ? { status: "failed", reason: result.reason }
              : { status: "ready", answer: result },
          ),
        );
        this.notify(key);
      },
    );
    const probing: Readiness = Object.freeze({ status: "probing", settled });
    this.readiness.set(decided.cache, probing);
    return settled;
  }

  private forget(member: GatewayMembership) {
    const decided = this.decide(member.key);
    if (decided.kind === "pending") {
      this.readiness.delete(decided.cache);
      this.authRefusals.delete(decided.cache);
    }
  }

  private revision(key: AgentKey) {
    return this.revisions.get(key) ?? 0;
  }

  private bump(key: AgentKey) {
    this.revisions.set(key, this.revision(key) + 1);
  }

  private notify(key: AgentKey) {
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener();
  }
}

/** The gateway's access answer for this caller, or why it failed. A failure
 * other than a 401 or 403 (a network error, another non-200 status, or a
 * malformed body) is tried exactly once more after `PROBE_RETRY_DELAY_MS`,
 * so a blip doesn't fail the route; the second result stands. An absent
 * `harnesses` enables none, so a gateway without the rollout flag leaves
 * every harness on its existing behavior. */
export async function probeAccess(
  request: GatewayRequest,
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<AccessAnswer | Readonly<{ reason: BlockedReason }>> {
  const first = await probeOnce(request, url, headers);
  if (!("reason" in first) || first.reason === "auth") return first;
  await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_DELAY_MS));
  return probeOnce(request, url, headers);
}

async function probeOnce(
  request: GatewayRequest,
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<AccessAnswer | Readonly<{ reason: BlockedReason }>> {
  let response: HostResponse;
  try {
    response = await request({
      url,
      method: "GET",
      headers: { accept: "application/json", ...headers },
      timeoutMs: 15_000,
    });
  } catch {
    return { reason: "network" };
  }
  if (response.status === 401 || response.status === 403)
    return { reason: "auth" };
  if (response.status !== 200) return { reason: "gateway_error" };
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return { reason: "gateway_error" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { reason: "gateway_error" };
  // Any model policy in the answer is the gateway's to enforce, and
  // gateway-filtered discovery lists what the membership may use, so only
  // the harness list is read here.
  const { harnesses = [] } = body as { harnesses?: unknown };
  if (
    !Array.isArray(harnesses) ||
    harnesses.length > 32 ||
    !harnesses.every((name) => typeof name === "string" && HARNESS.test(name))
  )
    return { reason: "gateway_error" };
  return Object.freeze({
    harnesses: Object.freeze([...new Set<string>(harnesses)]),
  });
}
/** A harness name a type declares and the gateway's flag lists. */
export const HARNESS = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Resolves once `settled` does or `signal` aborts, whichever is first. */
const settledOrAborted = (settled: Promise<void>, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    void settled.then(done, done);
  });

const blocked = (
  gatewayOrigin: string,
  reason: BlockedReason,
  revision: number,
): BlockedRoute =>
  Object.freeze({
    kind: "blocked",
    revision,
    gatewayOrigin,
    reason,
    message: MESSAGES[reason],
  });

/** This app's routes, from this build's descriptor. */
export const gatewayRoutes = new GatewayRoutes(gatewayDescriptor);
export const routeFor = (key: AgentKey) => gatewayRoutes.routeFor(key);
export const routeReady = (key: AgentKey, signal: AbortSignal) =>
  gatewayRoutes.routeReady(key, signal);
export const subscribeRoute = (key: AgentKey, listener: () => void) =>
  gatewayRoutes.subscribeRoute(key, listener);
export const invalidateRoute = (key: AgentKey, revision?: number) =>
  gatewayRoutes.invalidate(key, revision);
/** This build's upstream base for `harness`, for work outside a delivery
 * such as model discovery; a delivery carries its own as
 * `gateway.upstream`. */
export const upstreamFor = (harness: string) => gatewayRoutes.upstream(harness);
