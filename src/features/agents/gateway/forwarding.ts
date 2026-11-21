// One forwarded turn's gateway generation: a native forwarding handle opened
// at the route revision the turn was dispatched with, with the turn's frozen
// headers, given to exactly one harness process, and never rebound. Native
// owns admission (`host_forward.rs`); this owns the caller's side of it:
// pushing the revision, opening only while it is still the route's, and
// sealing and closing. A route change pushes the new revision, which revokes
// the generation natively, and ends its process. Nothing here waits on
// readiness or re-reads a route to retry; only a native side that can't be
// reached is tried again, briefly, at the same revision.
import {
  associateForward,
  closeForward,
  openForward,
  pushForwardAdmission,
  registerForwardChild,
  sealForward,
  type ForwardChildRegistered,
  type ForwardEvent,
  type ForwardHarness,
  type ForwardOpened,
  type ForwardOwner,
} from "../../host/forward";
import type { AgentKey } from "../membership";
import type { SessionPlace } from "../service";
import {
  bindingAdmits,
  discoveryBundle,
  inferenceBundle,
  isBuzzUuid,
  isHex64,
  type GatewayBinding,
  type TurnContext,
} from "./contract";
import {
  type EligibleRoute,
  excludesHarness,
  type GatewayRoute,
  invalidateRoute,
  routeFor,
  subscribeRoute,
} from "./route";

/** A forwarding harness: the name it declares to the gateway (its
 * descriptor upstream key), and native's name for it. */
export type ForwardingHarness = Readonly<{
  upstream: string;
  native: ForwardHarness;
}>;

export type ForwardNative = Readonly<{
  push: typeof pushForwardAdmission;
  open: typeof openForward;
  associate: typeof associateForward;
  register: typeof registerForwardChild;
  seal: typeof sealForward;
  close: typeof closeForward;
}>;
export type ForwardRoutes = Readonly<{
  routeFor(key: AgentKey): GatewayRoute;
  subscribeRoute(key: AgentKey, listener: () => void): () => void;
  /** Drops `revision`'s access, as a gateway 401 or 403 says it ended. */
  invalidateRoute?(key: AgentKey, revision?: number): void;
  /** Whether this launch's plugin list leaves `harness` out. */
  excludes?(harness: string): boolean;
}>;
/** The waits before each further try at an open that couldn't reach native
 * or its local proxy: bounded, so a turn still fails visibly soon. */
export type ForwardRetry = Readonly<{ delays: readonly number[] }>;
/** NO_PROXY and no_proxy as the harness's processes inherit them from the
 * app, and whether they inherit a proxy, whose value (it may hold a
 * password) is never read. */
export type Inherited = Readonly<{
  lists: readonly string[];
  proxied: boolean;
}>;
/** A harness's own check before anything is pushed or opened, which throws
 * the turn's error when the harness's requests could go around the gateway. */
export type ForwardPreflight = (inherited: Inherited) => Promise<void>;

/** A generation's caller side. `seal` ends admission for good, at the
 * qualifying idle; `close` forgets it once its process has exited, and
 * resolves on native `closed`, after which nothing of it follows, or
 * rejects when native could not close it, which is no clean retirement.
 * Both are idempotent. */
export type Generation = Readonly<{
  url: string;
  /** The route revision it was opened at, which a steer must share. */
  revision: number;
  /** Sealed: it admits no further model request, so nothing joins it. */
  isSealed(): boolean;
  /** Whether native admitted any model request on it: one that never did,
   * once a turn has run, means the harness's requests went somewhere else. */
  admitted(): boolean;
  /** Its process's NO_PROXY and no_proxy: the inherited ones with the
   * generation's loopback address added, so a proxy never gets its
   * requests. */
  noProxy: string;
  seal(): void;
  close(): Promise<void>;
  /** Settles once the route moves on, which revokes the generation
   * natively: its process must end. Recorded from before the open, so an
   * owner attaching late still sees it. */
  revoked: Promise<void>;
  isRevoked(): boolean;
  /** goose: names its session, once, before its first prompt. */
  associate(session: string): Promise<void>;
  /** goose: registers the child a live delegate `call` named. */
  registerChild(call: string, child: string): Promise<ForwardChildRegistered>;
}>;

const NATIVE: ForwardNative = {
  push: pushForwardAdmission,
  open: openForward,
  associate: associateForward,
  register: registerForwardChild,
  seal: sealForward,
  close: closeForward,
};
const ROUTES: ForwardRoutes = {
  routeFor,
  subscribeRoute,
  invalidateRoute,
  excludes: excludesHarness,
};
const RETRY: ForwardRetry = { delays: [250, 1_000, 2_500] };
/** Native route keys, short and opaque, for the page's life: a key is never
 * given to another agent, even by a later instance after a re-enable. */
const KEYS = new Map<AgentKey, string>();
export const CHANGED =
  "This agent's gateway access changed as the turn started, so it didn't run. Try again.";
export const UNAVAILABLE =
  "Buzz couldn't start forwarding to the agent gateway on this device, so the turn didn't run.";
/** Native's answer when its local proxy can't listen: the only open or push
 * failure (`host_forward.rs`) worth trying again. Every other is decided
 * before native makes a generation, and fails the same way each time. */
const UNREACHABLE = "Could not start forwarding";
export const NO_PROXY_UNREADABLE =
  "Buzz couldn't read this device's proxy exceptions to keep this agent's requests off a proxy, so the turn didn't run.";
/** Before the harness's own error, for a forwarded turn that failed with no
 * model request admitted: not necessarily a routing failure. */
export const UNREACHED = "No model request reached the agent gateway.";

/** Where every generation is, which a proxy must never be sent. */
const LOOPBACK = ["127.0.0.1", "localhost"];
const hosts = (list: string) => list.split(/[\s,]+/).filter(Boolean);
/** `lists`' hosts once each, with loopback added: what a forwarded process
 * reaches without a proxy, set as both of its names. */
export const noProxy = (lists: readonly string[]) =>
  [...new Set([...lists.flatMap(hosts), ...LOOPBACK])].join(",");
/** `Inherited` from a reader's output: NO_PROXY, then no_proxy, base64, one
 * per line, then `proxied` or `direct`. */
export function parseInherited(stdout: string): Inherited {
  const [upper, lower, proxy] = stdout.split("\n");
  if (
    upper === undefined ||
    lower === undefined ||
    (proxy !== "proxied" && proxy !== "direct")
  )
    throw new Error("The proxy exceptions are unreadable");
  return {
    lists: [decode(upper), decode(lower)],
    proxied: proxy === "proxied",
  };
}
const decode = (line: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(line), (char) => char.charCodeAt(0)),
  );

export const FORWARDING_PROTECTED =
  "Protected agents can't run through the agent gateway yet, so this turn didn't run.";

/** A control's error for a fallback notice: it never runs unforwarded. */
export const compactRefusal = (notice: string) =>
  notice.replace(
    /^Ran without the agent gateway: /,
    "Couldn't compact through the agent gateway: ",
  );
/** A session control's own context: its channel, and its thread only for a
 * thread's session; it carries no message. */
export const controlTurn = (place: SessionPlace, scope: string): TurnContext =>
  Object.freeze({
    channel_id: isBuzzUuid(place.channelId) ? place.channelId : null,
    message_id: null,
    thread_id: scope !== "channel" && isHex64(place.root) ? place.root : null,
  });

export class GatewayForwarding {
  constructor(
    private readonly owner: ForwardOwner,
    private readonly harness: ForwardingHarness,
    /** NO_PROXY and no_proxy as the harness's processes inherit them, and
     * whether they inherit a proxy: required, so every forwarded process
     * keeps the person's own exceptions; without a host to read them,
     * nothing opens. */
    private readonly inherited: () => Promise<Inherited>,
    private readonly native: ForwardNative = NATIVE,
    private readonly routes: ForwardRoutes = ROUTES,
    private readonly retry: ForwardRetry = RETRY,
    private readonly preflight?: ForwardPreflight,
  ) {}

  /** The route a session control with no turn of its own (compaction) goes
   * by, read now without waiting: undefined where the runner wouldn't send
   * the agent's turns to the gateway, so it runs on the harness's own
   * configuration; else the eligible route that enables the harness, or the
   * blocked one its turns would fall back from. A control acts on a saved
   * session a forwarded turn left, so one this launch's plugin list leaves
   * out (`excludes`) still goes by the eligible route: the session keeps the
   * gateway it ran through, whose own check still decides. */
  control(
    agent: AgentKey,
  ): EligibleRoute | Extract<GatewayRoute, { kind: "blocked" }> | undefined {
    const route = this.routes.routeFor(agent);
    if (route.kind === "blocked") return route;
    const { upstream } = this.harness;
    return route.kind === "eligible" &&
      (route.harnesses.includes(upstream) ||
        this.routes.excludes?.(upstream) === true)
      ? route
      : undefined;
  }

  /** Opens the turn's generation for harness session `session` at `route`,
   * the revision it was dispatched with. A failed preflight, a route that
   * moved on, a refusal or a native error throw at once, before anything is
   * spawned; only a local proxy that can't listen is tried again after each
   * of the retry's delays while the route and `signal` hold. A generation
   * opened after `signal` aborted is closed. */
  async open(
    agent: AgentKey,
    route: EligibleRoute,
    turn: Readonly<{
      binding: GatewayBinding;
      context: TurnContext;
    }>,
    signal: AbortSignal,
  ): Promise<Generation> {
    const inference = inferenceBundle(
      route.profile,
      turn.binding,
      turn.context,
    );
    if (!inference.ok) throw new Error(inference.message);
    if (!bindingAdmits(route, turn.binding).ok) throw new Error(CHANGED);
    const discovery = discoveryBundle(route.profile, route, turn.binding);
    if (!discovery.ok) throw new Error(discovery.message);
    let inherited: Inherited;
    try {
      inherited = await this.inherited();
    } catch (error) {
      console.warn("The proxy exceptions are unreadable", error);
      throw new Error(NO_PROXY_UNREADABLE);
    }
    await this.preflight?.(inherited);
    signal.throwIfAborted();
    // Watched from before the push: a change during it, the open or the
    // process's startup is pushed (native revokes on it) and recorded.
    let revoked = false;
    let revoke!: () => void;
    const revocation = new Promise<void>((resolve) => {
      revoke = resolve;
    });
    const moved = () =>
      revoked || this.routes.routeFor(agent).revision !== route.revision;
    const unsubscribe = this.routes.subscribeRoute(agent, () => {
      const now = this.routes.routeFor(agent);
      if (revoked || now.revision === route.revision) return;
      revoked = true;
      void this.push(agent, now).catch(() => undefined);
      revoke();
    });
    let closed!: () => void;
    const ended = new Promise<void>((resolve) => {
      closed = resolve;
    });
    let admitted = false;
    const onEvent = (event: ForwardEvent) => {
      if (event.type === "closed") closed();
      // Model requests: discovery alone isn't the harness's turn reaching it.
      if (event.type === "admitted" && event.class === "inference")
        admitted = true;
      // The gateway ended this revision's access: the next turn reads the
      // route again. The turn fails as its process ends on the revocation.
      if (
        event.type === "finished" &&
        (event.status === 401 || event.status === 403)
      )
        this.routes.invalidateRoute?.(agent, route.revision);
    };
    let opened: ForwardOpened | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        if (moved()) throw new Error(CHANGED);
        await this.push(agent, route);
        signal.throwIfAborted();
        // Open only at the acknowledged revision.
        if (!moved())
          opened = await this.native.open(this.owner, {
            route: this.key(agent),
            routeRevision: route.revision,
            harness: this.harness.native,
            inference: inference.value,
            discovery: discovery.value,
            onEvent,
          });
        break;
      } catch (error) {
        const changed = error instanceof Error && error.message === CHANGED;
        const unreachable =
          (error instanceof Error ? error.message : String(error)) ===
          UNREACHABLE;
        const delay = this.retry.delays[attempt];
        if (!signal.aborted && unreachable && delay !== undefined) {
          console.warn("Gateway forwarding is unavailable; retrying", error);
          if (await wait(delay, signal)) continue;
        }
        unsubscribe();
        if (signal.aborted) throw signal.reason;
        if (changed) throw error;
        console.warn("Gateway forwarding is unavailable", error);
        throw new Error(UNAVAILABLE);
      }
    }
    if (opened?.type !== "opened") {
      unsubscribe();
      throw new Error(CHANGED);
    }
    const generation = this.generation(opened, ended, unsubscribe, {
      revision: route.revision,
      revocation,
      isRevoked: () => revoked,
      admitted: () => admitted,
      noProxy: noProxy(inherited.lists),
    });
    if (signal.aborted || revoked) {
      await generation.close().catch(() => undefined);
      signal.throwIfAborted();
      throw new Error(CHANGED);
    }
    return generation;
  }

  private generation(
    { id, url }: Readonly<{ id: number; url: string }>,
    ended: Promise<void>,
    unsubscribe: () => void,
    {
      revision,
      revocation,
      isRevoked,
      admitted,
      noProxy,
    }: Readonly<{
      revision: number;
      revocation: Promise<void>;
      isRevoked: () => boolean;
      admitted: () => boolean;
      noProxy: string;
    }>,
  ): Generation {
    let sealed = false;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      url,
      revision,
      isSealed: () => sealed || closing !== undefined,
      admitted,
      noProxy,
      revoked: revocation,
      isRevoked,
      seal: () => {
        if (sealed || closing) return;
        sealed = true;
        void this.native.seal(this.owner, id).catch(() => undefined);
      },
      close: () => {
        if (closing) return closing;
        unsubscribe();
        closing = this.native.close(this.owner, id).then(() => ended);
        return closing;
      },
      associate: (session) => this.native.associate(this.owner, id, session),
      registerChild: (call, child) =>
        this.native.register(this.owner, id, call, child),
    });
  }

  private push(agent: AgentKey, route: GatewayRoute) {
    return this.native.push(
      this.owner,
      this.key(agent),
      route.revision,
      route.kind === "eligible",
    );
  }

  private key(agent: AgentKey) {
    let key = KEYS.get(agent);
    if (!key) {
      key = `route-${KEYS.size + 1}`;
      KEYS.set(agent, key);
    }
    return key;
  }
}

/** Waits `ms`, resolving false at once if `signal` aborts first. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
