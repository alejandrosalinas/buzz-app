import { describe, expect, it, vi } from "vitest";
import type { HostResponse } from "../../features/host/service";
import { GatewayRoutes } from "../../features/agents/gateway/route";
import { PI_UPSTREAM, piGatewayDescriptor } from "./pi-testing";
import {
  ADMITS_VECTORS,
  INFERENCE_VECTORS,
  VECTOR_BINDING,
  VECTOR_IDENTITY,
  VECTOR_PROFILE,
} from "../../features/agents/gateway/vectors";
import {
  answerGateway,
  GATEWAY_SEAM,
  type GatewayRoute,
  type GatewaySeam,
} from "./gateway";

const agent = VECTOR_IDENTITY.agent_pubkey;
const eligible: GatewayRoute = {
  kind: "eligible",
  revision: 1,
  gatewayOrigin: "https://gateway.test",
  identity: VECTOR_IDENTITY,
  profile: VECTOR_PROFILE,
  harnesses: ["pi"],
};
const blocked: GatewayRoute = {
  kind: "blocked",
  revision: 2,
  gatewayOrigin: "https://gateway.test",
  reason: "auth",
  message: "Sign in again to use the gateway's models.",
};
const external: GatewayRoute = { kind: "external", revision: 3 };
const message = INFERENCE_VECTORS[0] as (typeof INFERENCE_VECTORS)[number];

/** The shared gateway module's own functions, with only the route this test gives. */
function seam(
  route: unknown,
  upstream: Readonly<{ base: string }> = PI_UPSTREAM,
): GatewaySeam {
  const found = route as GatewayRoute;
  return {
    ...GATEWAY_SEAM,
    routeReady: async () => found,
    routeFor: () => found,
    subscribeRoute: () => () => {},
    invalidateRoute: vi.fn(),
    upstreamFor: (harness) => (harness === "pi" ? upstream : undefined),
  };
}

describe("answerGateway", () => {
  const bind = (
    turn: unknown,
    event: "resume" | "reset" | "new_generation" | "standalone" = "resume",
    saved?: unknown,
  ) => ({ op: "bind", agent, event, saved, turn }) as const;

  it.each(INFERENCE_VECTORS)(
    "bundles a run as the shared vector does: $name",
    ({ turn, headers }) => {
      const answer = answerGateway(
        seam(eligible),
        bind(turn, "resume", VECTOR_BINDING),
      );
      expect(answer).toEqual({
        ok: true,
        binding: VECTOR_BINDING,
        bundle: headers,
        persist: false,
      });
    },
  );

  it("mints and persists a binding for a new session, and none standalone", () => {
    for (const event of ["reset", "new_generation"] as const) {
      const answer = answerGateway(
        seam(eligible),
        bind(message.turn, event, VECTOR_BINDING),
      );
      expect(answer).toMatchObject({ ok: true, persist: true });
      if (!answer.ok) throw new Error(answer.message);
      expect(answer.binding).not.toEqual(VECTOR_BINDING);
    }
    expect(
      answerGateway(seam(eligible), bind(message.turn, "standalone")),
    ).toMatchObject({ ok: true, persist: false });
  });

  it("never binds without an eligible route that enables Pi, or a valid turn", () => {
    const turn = message.turn;
    expect(answerGateway(undefined, bind(turn)).ok).toBe(false);
    const disabled = { ...eligible, harnesses: ["goose"] };
    expect(answerGateway(seam(disabled), bind(turn)).ok).toBe(false);
    expect(answerGateway(seam(blocked), bind(turn))).toEqual({
      ok: false,
      message: (blocked as { message: string }).message,
    });
    expect(answerGateway(seam(external), bind(turn)).ok).toBe(false);
    expect(answerGateway(seam(eligible), bind(undefined))).toEqual({
      ok: false,
      message: "This turn has no Buzz context",
    });
    // A removed field, or a missing one, is refused as a whole.
    for (const invalid of [
      { ...turn, trigger_kind: "message" },
      { ...turn, message_created_at: "2026-11-04T00:00:00Z" },
      { channel_id: turn.channel_id, thread_id: turn.thread_id },
      { ...turn, message_id: "" },
    ])
      expect(answerGateway(seam(eligible), bind(invalid)).ok).toBe(false);
    const other = {
      ...VECTOR_BINDING,
      identity: { ...VECTOR_IDENTITY, agent_pubkey: "f".repeat(64) },
    };
    expect(answerGateway(seam(eligible), bind(turn, "resume", other))).toEqual({
      ok: false,
      message: expect.stringContaining("different owner"),
    });
  });

  it.each(ADMITS_VECTORS)(
    "admits a run's binding as the shared vector does: $name",
    ({ route, result }) => {
      // The shared vectors predate harnesses: each enables Pi here.
      const enabled =
        route.kind === "eligible" ? { ...route, harnesses: ["pi"] } : route;
      const answer = answerGateway(seam(enabled as GatewayRoute), {
        op: "admit",
        agent,
        binding: VECTOR_BINDING,
      });
      expect(answer).toEqual(
        result.ok
          ? // The vectors' routes carry no origin or profile to admit to.
            expect.objectContaining({ ok: true, revision: result.revision })
          : { ok: false, message: expect.any(String) },
      );
    },
  );

  it("admits no binding once the gateway stops enabling Pi", () => {
    const binding = VECTOR_BINDING;
    const at = (harnesses: string[]) =>
      answerGateway(
        seam({
          kind: "eligible",
          revision: 8,
          gatewayOrigin: "https://gateway.test",
          identity: VECTOR_IDENTITY,
          profile: VECTOR_PROFILE,
          harnesses,
        }),
        { op: "admit", agent, binding },
      );
    expect(at(["pi"])).toEqual({
      ok: true,
      revision: 8,
      root: `https://gateway.test${PI_UPSTREAM.base}`,
      profile: VECTOR_PROFILE,
    });
    for (const harnesses of [["goose"], []])
      expect(at(harnesses)).toEqual({ ok: false, message: expect.any(String) });
  });

  it("admits a request to the gateway's root for Pi only while this build has a Pi upstream", () => {
    const admit = { op: "admit", agent, binding: VECTOR_BINDING } as const;
    expect(
      answerGateway(seam(eligible, { base: "/ai-gateway" }), admit),
    ).toEqual({
      ok: true,
      revision: 1,
      root: "https://gateway.test/ai-gateway",
      profile: VECTOR_PROFILE,
    });
    expect(
      answerGateway({ ...seam(eligible), upstreamFor: () => undefined }, admit),
    ).toEqual({ ok: false, message: expect.any(String) });
    // Blocked or external: never admitted, whatever the binding.
    for (const route of [blocked, external])
      expect(answerGateway(seam(route), admit).ok).toBe(false);
  });

  it("drops access only at a refused request's revision", () => {
    const stub = seam(eligible);
    expect(answerGateway(stub, { op: "deny", agent, revision: 4 })).toEqual({
      ok: true,
      applied: false,
    });
    expect(stub.invalidateRoute).toHaveBeenCalledWith(agent, 4);
    // Without one, it would drop whatever revision is current.
    for (const revision of [undefined, "4", 1.5])
      expect(answerGateway(stub, { op: "deny", agent, revision }).ok).toBe(
        false,
      );
    expect(stub.invalidateRoute).toHaveBeenCalledTimes(1);
  });

  it("refuses a run's next request after a denial at the revision it was admitted at, not at an older one", async () => {
    const community = VECTOR_IDENTITY.community_id;
    const routes = new GatewayRoutes(() =>
      piGatewayDescriptor(community, "https://relay.example"),
    );
    const probes: ((response: HostResponse) => void)[] = [];
    routes.bindRequest(
      () => new Promise<HostResponse>((resolve) => probes.push(resolve)),
    );
    const allow = async () => {
      probes.shift()?.({
        status: 200,
        headers: {},
        body: '{"harnesses":["pi"]}',
      });
      await vi.waitFor(() =>
        expect(routes.routeFor(agent).kind).toBe("eligible"),
      );
    };
    routes.setMembership({
      key: agent,
      origin: "https://relay.example",
      owner: VECTOR_IDENTITY.human_pubkey,
      pubkey: agent,
      community: { id: community, session: {} },
    });
    const ready = routes.routeReady(agent, AbortSignal.timeout(5_000));
    await allow();
    await ready;
    const stub: GatewaySeam = {
      ...GATEWAY_SEAM,
      routeFor: routes.routeFor.bind(routes),
      invalidateRoute: routes.invalidate.bind(routes),
      upstreamFor: () => PI_UPSTREAM,
    };
    const admit = () =>
      answerGateway(stub, {
        op: "admit",
        agent,
        binding: VECTOR_BINDING,
      });
    const first = admit();
    if (!first.ok || first.revision === undefined) throw new Error("refused");
    // Probed again and ready, the resumed binding is admitted at the newer
    // revision.
    expect(
      answerGateway(stub, {
        op: "deny",
        agent,
        revision: first.revision,
      }),
    ).toEqual({ ok: true, applied: true });
    expect(routes.routeFor(agent).kind).toBe("blocked");
    await allow();
    const resumed = admit();
    if (!resumed.ok || resumed.revision === undefined)
      throw new Error("refused");
    expect(resumed.revision).toBeGreaterThan(first.revision);
    // A late refusal of the first request changes nothing.
    expect(
      answerGateway(stub, {
        op: "deny",
        agent,
        revision: first.revision,
      }),
    ).toEqual({ ok: true, applied: false });
    expect(routes.routeFor(agent)).toMatchObject({
      kind: "eligible",
      revision: resumed.revision,
    });
    expect(probes).toHaveLength(0);
    // One at the admitted revision refuses the next request before any
    // probe settles.
    answerGateway(stub, {
      op: "deny",
      agent,
      revision: resumed.revision,
    });
    expect(admit()).toEqual({ ok: false, message: expect.any(String) });
    expect(probes).toHaveLength(1);
  });

  it("never admits a malformed binding", () => {
    expect(
      answerGateway(seam(eligible), {
        op: "admit",
        agent,
        binding: { ...VECTOR_BINDING, v: 2 },
      }).ok,
    ).toBe(false);
  });
});
