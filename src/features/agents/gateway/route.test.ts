import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRequest, HostResponse } from "../../host/service";
import type { AgentKey } from "../membership";
import {
  GatewayRoutes,
  PROBE_RETRY_DELAY_MS,
  type GatewayMembership,
} from "./route";
import type { GatewayDescriptor } from "./descriptor";
import { VECTOR_PROFILE } from "./vectors";

const GATEWAY = "https://gateway.example";
const LISTED = {
  id: "22222222-2222-4222-8222-222222222222",
  origin: "https://relay.example",
};
const OTHER = {
  id: "44444444-4444-4444-8444-444444444444",
  origin: "https://other.example",
};
const ACCESS_PATH = "/v9/access";
const DESCRIPTOR: GatewayDescriptor = {
  version: 2,
  gateway: GATEWAY,
  communities: [LISTED, OTHER],
  access_path: ACCESS_PATH,
  ...VECTOR_PROFILE,
  upstreams: { pi: { base: "/upstream/pi" } },
};
const OWNER = "a".repeat(64);
const key = (name: string) => name as AgentKey;

/** A request function whose responses the test settles one by one. */
function gateway() {
  const pending: {
    request: HostRequest;
    respond: (response: HostResponse | Error) => void;
  }[] = [];
  const request = vi.fn(
    (request: HostRequest) =>
      new Promise<HostResponse>((resolve, reject) =>
        pending.push({
          request,
          respond: (response) =>
            response instanceof Error ? reject(response) : resolve(response),
        }),
      ),
  );
  const answer = async (body: string, status = 200, index = 0) => {
    const [next] = pending.splice(index, 1);
    if (!next) throw new Error("No request pending");
    next.respond({ status, headers: {}, body });
    await Promise.resolve();
    await Promise.resolve();
    return next.request;
  };
  return { request, pending, answer };
}

function member(
  name: string,
  session: object | undefined,
  overrides: Partial<GatewayMembership> = {},
): GatewayMembership {
  return {
    key: key(name),
    origin: LISTED.origin,
    owner: OWNER,
    pubkey: name.padEnd(64, "0").replace(/[^0-9a-f]/g, "0"),
    community: session && { id: LISTED.id, session },
    ...overrides,
  };
}

function setup(descriptor: GatewayDescriptor | null = DESCRIPTOR) {
  const routes = new GatewayRoutes(() => descriptor);
  const net = gateway();
  routes.bindRequest(net.request);
  return { routes, ...net };
}

/** Fakes the probe's retry pause; `retry()` lets it pass. */
function retryClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return () => vi.advanceTimersByTimeAsync(PROBE_RETRY_DELAY_MS);
}

/** A promise and its resolver, for a test to settle when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("dispatches a queued probe through the rebound request", async () => {
  const routes = new GatewayRoutes(() => DESCRIPTOR);
  const selection = deferred<readonly string[]>();
  const old = gateway();
  const replacement = gateway();
  routes.selectHarnesses(selection.promise);
  const unbind = routes.bindRequest(old.request);
  routes.setMembership(member("b1", {}));
  unbind();
  routes.bindRequest(replacement.request);
  selection.resolve(["pi"]);
  await vi.waitFor(() =>
    expect(old.pending.length + replacement.pending.length).toBe(1),
  );
  expect(old.request).not.toHaveBeenCalled();
  expect(replacement.request).toHaveBeenCalledOnce();
});

it("releases a queued probe with no binding so a later bind can retry", async () => {
  const routes = new GatewayRoutes(() => DESCRIPTOR);
  const selection = deferred<readonly string[]>();
  const old = gateway();
  const replacement = gateway();
  routes.selectHarnesses(selection.promise);
  const unbind = routes.bindRequest(old.request);
  routes.setMembership(member("b1", {}));
  unbind();
  const turn = routes.routeForTurn(key("b1"), AbortSignal.timeout(500));
  selection.resolve(["pi"]);
  await expect(turn).resolves.toMatchObject({ reason: "readiness_pending" });
  expect(old.request).not.toHaveBeenCalled();
  routes.bindRequest(replacement.request);
  expect(replacement.request).toHaveBeenCalledOnce();
});

it("tells a turn when the plugin's selection is known, without an access check", async () => {
  const routes = new GatewayRoutes(() => DESCRIPTOR);
  const net = gateway();
  const selection = deferred<readonly string[] | undefined>();
  routes.selectHarnesses(selection.promise);
  routes.bindRequest(net.request);
  routes.setMembership(member("b1", {}));
  expect(routes.selecting).toBe(true);
  expect(routes.excludes("pi")).toBe(false);
  // A wait that ends first leaves it unknown.
  await routes.selectionForTurn(AbortSignal.abort());
  expect(routes.selecting).toBe(true);
  const known = routes.selectionForTurn(AbortSignal.timeout(5_000));
  selection.resolve(["codex"]);
  await known;
  expect(routes.selecting).toBe(false);
  expect(routes.excludes("pi")).toBe(true);
  expect(routes.excludes("codex")).toBe(false);
  // Known already: no wait.
  await routes.selectionForTurn(AbortSignal.timeout(5_000));
  // No selection at all keeps nothing out.
  const none = new GatewayRoutes(() => DESCRIPTOR);
  expect(none.selecting).toBe(false);
  expect(none.excludes("pi")).toBe(false);
  await none.selectionForTurn(AbortSignal.timeout(5_000));
});

describe("GatewayRoutes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is external for every membership without a descriptor", () => {
    const { routes, request } = setup(null);
    routes.setMembership(member("b1", {}));
    expect(routes.configured).toBe(false);
    expect(routes.routeFor(key("b1")).kind).toBe("external");
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks everything when the descriptor is invalid", () => {
    const routes = new GatewayRoutes(() => {
      throw new Error("bad");
    });
    routes.setMembership(member("b1", {}));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      kind: "blocked",
      reason: "descriptor_invalid",
    });
  });

  it("gives only the upstream bases the descriptor configures", () => {
    expect(setup().routes.upstream("pi")).toEqual({ base: "/upstream/pi" });
    for (const harness of ["goose", "codex", "toString", "__proto__"])
      expect(setup().routes.upstream(harness)).toBeUndefined();
    expect(setup(null).routes.upstream("pi")).toBeUndefined();
  });

  it("goes pending, probes with discovery headers, then is eligible at a fresh revision", async () => {
    const { routes, answer } = setup();
    const session = {};
    routes.setMembership(member("b1", session));
    const pending = routes.routeFor(key("b1"));
    expect(pending).toMatchObject({
      kind: "blocked",
      reason: "readiness_pending",
      revision: 1,
    });
    const request = await answer("{}");
    expect(request.url).toBe(`${GATEWAY}${ACCESS_PATH}`);
    expect(request.method).toBe("GET");
    expect(request.headers).toMatchObject({
      "x-gw-ctx-community-id": LISTED.id,
      "x-gw-ctx-human-pubkey": OWNER,
    });
    expect(Object.keys(request.headers ?? {}).sort()).toEqual([
      "accept",
      "x-gw-ctx-agent-pubkey",
      "x-gw-ctx-community-id",
      "x-gw-ctx-human-pubkey",
      "x-gw-launcher-client",
    ]);
    expect(routes.routeFor(key("b1"))).toEqual({
      kind: "eligible",
      revision: 2,
      gatewayOrigin: GATEWAY,
      identity: {
        community_id: LISTED.id,
        human_pubkey: OWNER,
        agent_pubkey: member("b1", session).pubkey,
      },
      profile: VECTOR_PROFILE,
      harnesses: [],
    });
  });

  it.each([
    ['{"harnesses":[]}', 200, { kind: "eligible", harnesses: [] }],
    [
      '{"harnesses":["pi","codex","pi","future"]}',
      200,
      { kind: "eligible", harnesses: ["pi", "codex", "future"] },
    ],
    // Only the harness list is read: other keys, such as a response
    // policy, are the gateway's and are ignored.
    [
      '{"policy":{"x":1},"harnesses":["pi"],"x":1}',
      200,
      { kind: "eligible", harnesses: ["pi"] },
    ],
    ['{"policy":"yes"}', 200, { kind: "eligible", harnesses: [] }],
    ['{"harnesses":"pi"}', 200, { kind: "blocked", reason: "gateway_error" }],
    ['{"harnesses":["Pi"]}', 200, { kind: "blocked", reason: "gateway_error" }],
    ['{"harnesses":[1]}', 200, { kind: "blocked", reason: "gateway_error" }],
    ["[]", 200, { kind: "blocked", reason: "gateway_error" }],
    ["null", 200, { kind: "blocked", reason: "gateway_error" }],
    ['"pi"', 200, { kind: "blocked", reason: "gateway_error" }],
    ["", 401, { kind: "blocked", reason: "auth" }],
    ["", 403, { kind: "blocked", reason: "auth" }],
    ["", 500, { kind: "blocked", reason: "gateway_error" }],
    ["not json", 200, { kind: "blocked", reason: "gateway_error" }],
  ])("maps %s (%i) to its route", async (body, status, route) => {
    const retry = retryClock();
    const { routes, answer, request } = setup();
    routes.setMembership(member("b1", {}));
    await answer(body, status);
    // A failure other than a 401/403 is tried once more; the second stands.
    const retried = "reason" in route && route.reason === "gateway_error";
    if (retried) {
      await retry();
      await answer(body, status);
    }
    expect(request).toHaveBeenCalledTimes(retried ? 2 : 1);
    expect(routes.routeFor(key("b1"))).toMatchObject(route);
  });

  describe("a plugin's harness selection", () => {
    /** A selection the test settles. */
    function selection() {
      let settle!: (list: readonly string[] | undefined) => void;
      let fail!: (error: Error) => void;
      const promise = new Promise<readonly string[] | undefined>(
        (resolve, reject) => {
          settle = resolve;
          fail = reject;
        },
      );
      return { promise, settle, fail };
    }
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    /** Routes whose selection is `chosen`, with a member fed and a request
     * path bound. */
    function selecting(chosen: Promise<readonly string[] | undefined>) {
      const routes = new GatewayRoutes(() => DESCRIPTOR);
      routes.selectHarnesses(chosen);
      const net = gateway();
      routes.bindRequest(net.request);
      const heard = vi.fn();
      routes.subscribeRoute(key("b1"), heard);
      routes.setMembership(member("b1", {}));
      return { routes, heard, ...net };
    }

    it("says which harnesses it leaves out once settled, and none before or without a list", async () => {
      const routes = new GatewayRoutes(() => DESCRIPTOR);
      expect(routes.excludes("goose")).toBe(false);
      const chosen = selection();
      routes.selectHarnesses(chosen.promise);
      expect(routes.excludes("goose")).toBe(false);
      chosen.settle(Object.freeze(["codex"]));
      await flush();
      expect(routes.excludes("codex")).toBe(false);
      expect(routes.excludes("goose")).toBe(true);
      const kept = new GatewayRoutes(() => DESCRIPTOR);
      kept.selectHarnesses(Promise.resolve(undefined));
      await flush();
      expect(kept.excludes("goose")).toBe(false);
      const failed = new GatewayRoutes(() => DESCRIPTOR);
      failed.selectHarnesses(Promise.reject(new Error("no")));
      await flush();
      expect(failed.excludes("goose")).toBe(true);
    });

    it("waits for it before checking access, then uses its list in place of the check's", async () => {
      const chosen = selection();
      const { routes, request, answer } = selecting(chosen.promise);
      await flush();
      // Nothing goes to the gateway before the selection is known.
      expect(request).not.toHaveBeenCalled();
      expect(routes.routeFor(key("b1"))).toMatchObject({
        kind: "blocked",
        reason: "readiness_pending",
      });
      // A turn waits for it like any access check in flight.
      const turn = routes.routeForTurn(key("b1"), new AbortController().signal);
      chosen.settle(["codex", "goose"]);
      await flush();
      expect(request).toHaveBeenCalledTimes(1);
      await answer('{"harnesses":["pi"]}');
      await expect(turn).resolves.toMatchObject({
        kind: "eligible",
        harnesses: ["codex", "goose"],
      });
      // A later check uses the settled list without waiting again.
      routes.invalidate(key("b1"));
      await answer('{"harnesses":["pi"]}');
      expect(routes.routeFor(key("b1"))).toMatchObject({
        kind: "eligible",
        harnesses: ["codex", "goose"],
      });
    });

    it("keeps the access check's list when it settles with none", async () => {
      const { routes, answer } = selecting(Promise.resolve(undefined));
      await flush();
      await answer('{"harnesses":["pi"]}');
      expect(routes.routeFor(key("b1"))).toMatchObject({
        kind: "eligible",
        harnesses: ["pi"],
      });
    });

    it.each([
      ["enables none", () => Promise.resolve([] as readonly string[])],
      ["fails", () => Promise.reject(new Error("unreadable"))],
    ])(
      "sends the gateway nothing when it %s: every route is external",
      async (_, chosen) => {
        const { routes, request, heard } = selecting(chosen());
        await flush();
        expect(request).not.toHaveBeenCalled();
        expect(heard).toHaveBeenCalled();
        expect(routes.routeFor(key("b1")).kind).toBe("external");
        await expect(
          routes.routeForTurn(key("b1"), new AbortController().signal),
        ).resolves.toMatchObject({ kind: "external" });
        // A later membership, or a refusal, changes nothing.
        routes.setMembership(member("b2", {}));
        routes.invalidate(key("b1"));
        await flush();
        expect(request).not.toHaveBeenCalled();
        expect(routes.routeFor(key("b2")).kind).toBe("external");
      },
    );

    it("sends only the newest check when the membership changes while it waits", async () => {
      const chosen = selection();
      const { routes, request, answer } = selecting(chosen.promise);
      routes.invalidate(key("b1"));
      routes.setMembership(member("b1", {}));
      chosen.settle(["pi"]);
      await flush();
      expect(request).toHaveBeenCalledTimes(1);
      await answer('{"harnesses":[]}');
      expect(routes.routeFor(key("b1"))).toMatchObject({
        kind: "eligible",
        harnesses: ["pi"],
      });
    });

    it("tells a key that was never fed when every route turns external", async () => {
      const chosen = selection();
      const routes = new GatewayRoutes(() => DESCRIPTOR);
      routes.selectHarnesses(chosen.promise);
      const heard = vi.fn();
      routes.subscribeRoute(key("ghost"), heard);
      expect(routes.routeFor(key("ghost")).kind).toBe("blocked");
      chosen.settle([]);
      await flush();
      expect(heard).toHaveBeenCalled();
      expect(routes.routeFor(key("ghost")).kind).toBe("external");
    });

    it("never overrides a refusal or a failed check", async () => {
      const retry = retryClock();
      for (const [status, reason] of [
        [403, "auth"],
        [500, "gateway_error"],
      ] as const) {
        const { routes, answer } = selecting(Promise.resolve(["pi"]));
        await flush();
        await answer("", status);
        if (reason === "gateway_error") {
          await retry();
          await answer("", status);
        }
        await flush();
        expect(routes.routeFor(key("b1"))).toMatchObject({
          kind: "blocked",
          reason,
        });
      }
    });
  });

  it("blocks on a network failure that persists through its retry, never external", async () => {
    const retry = retryClock();
    const { routes, pending, request } = setup();
    routes.setMembership(member("b1", {}));
    pending.shift()?.respond(new Error("offline"));
    await retry();
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
    });
    pending.shift()?.respond(new Error("offline"));
    await retry();
    expect(request).toHaveBeenCalledTimes(2);
    expect(routes.routeFor(key("b1"))).toMatchObject({
      kind: "blocked",
      reason: "network",
    });
  });

  it("retries a failed probe exactly once, and never a 401 or 403", async () => {
    const retry = retryClock();
    {
      const { routes, answer, request } = setup();
      routes.setMembership(member("b1", {}));
      await answer("", 500);
      await retry();
      await answer('{"harnesses":["pi"]}');
      expect(request).toHaveBeenCalledTimes(2);
      expect(routes.routeFor(key("b1"))).toMatchObject({
        kind: "eligible",
        revision: 2,
        harnesses: ["pi"],
      });
    }
    {
      const { routes, answer, request, pending } = setup();
      routes.setMembership(member("b1", {}));
      await answer("", 500);
      await retry();
      await answer("", 502);
      await retry();
      expect(request).toHaveBeenCalledTimes(2);
      expect(pending).toHaveLength(0);
      expect(routes.routeFor(key("b1"))).toMatchObject({
        reason: "gateway_error",
      });
    }
    for (const status of [401, 403]) {
      const { routes, answer, request } = setup();
      routes.setMembership(member("b1", {}));
      await answer("", status);
      await retry();
      expect(request).toHaveBeenCalledTimes(1);
      expect(routes.routeFor(key("b1"))).toMatchObject({ reason: "auth" });
    }
  });

  it("discards a retried probe's result when the revision moved during the retry", async () => {
    const retry = retryClock();
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    await answer("", 500);
    routes.setMembership(member("b1", {}, { owner: "c".repeat(64) }));
    await retry();
    // The new membership's probe went out first, then the old one's retry.
    const fresh = await answer('{"harnesses":[]}');
    expect(fresh.headers?.["x-gw-ctx-human-pubkey"]).toBe("c".repeat(64));
    const eligible = routes.routeFor(key("b1"));
    expect(eligible).toMatchObject({ kind: "eligible", revision: 3 });
    const stale = await answer("", 500);
    expect(stale.headers?.["x-gw-ctx-human-pubkey"]).toBe(OWNER);
    await retry();
    expect(routes.routeFor(key("b1"))).toEqual(eligible);
  });

  it("decides each membership on its own: external, mismatched, missing and eligible side by side", async () => {
    const { routes, answer, request } = setup();
    routes.setMembership(
      member("ext", {}, { origin: "https://external.example" }),
    );
    routes.setMembership(
      member("mismatch", {}, { community: { id: OTHER.id, session: {} } }),
    );
    routes.setMembership(
      member("missing", {}, { community: { id: undefined, session: {} } }),
    );
    routes.setMembership(member("offline", undefined));
    routes.setMembership(member("ok", {}));
    routes.setMembership(
      member(
        "other",
        {},
        { origin: OTHER.origin, community: { id: OTHER.id, session: {} } },
      ),
    );
    expect(request).toHaveBeenCalledTimes(2);
    await answer('{"harnesses":[]}');
    await answer("", 401);
    expect(routes.routeFor(key("ext")).kind).toBe("external");
    expect(routes.routeFor(key("mismatch"))).toMatchObject({
      reason: "community_id_mismatch",
    });
    expect(routes.routeFor(key("missing"))).toMatchObject({
      reason: "community_id_missing",
    });
    expect(routes.routeFor(key("offline"))).toMatchObject({
      reason: "readiness_pending",
    });
    expect(routes.routeFor(key("ok")).kind).toBe("eligible");
    expect(routes.routeFor(key("other"))).toMatchObject({ reason: "auth" });
  });

  it("a socket reconnect on the same session changes nothing; a replaced session goes pending even with the same ID", async () => {
    const { routes, answer, request } = setup();
    const session = {};
    routes.setMembership(member("b1", session));
    await answer('{"harnesses":[]}');
    const ready = routes.routeFor(key("b1"));
    const listener = vi.fn();
    routes.subscribeRoute(key("b1"), listener);
    routes.setMembership(member("b1", session));
    expect(routes.routeFor(key("b1"))).toEqual(ready);
    expect(listener).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);

    routes.setMembership(member("b1", undefined));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
      revision: 3,
    });
    routes.setMembership(member("b1", {}));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
      revision: 4,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    await answer('{"harnesses":[]}');
    expect(routes.routeFor(key("b1"))).toMatchObject({
      kind: "eligible",
      revision: 5,
    });
  });

  it("discards a probe that settles after the revision moved", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    // The owner changes while the first probe is out.
    routes.setMembership(member("b1", {}, { owner: "c".repeat(64) }));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
      revision: 2,
    });
    await answer('{"harnesses":[]}');
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
      revision: 2,
    });
    const second = await answer('{"harnesses":[]}');
    expect(second.headers?.["x-gw-ctx-human-pubkey"]).toBe("c".repeat(64));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      kind: "eligible",
      revision: 3,
    });
  });

  it("invalidates on a 401/403 from inference: auth-blocked at a new revision until a successful probe", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    await answer('{"harnesses":[]}');
    routes.invalidate(key("b1"));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "auth",
      revision: 3,
    });
    await answer("", 403);
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "auth",
      revision: 4,
    });
  });

  it("blocks a removed membership, never external, and never reuses its revision", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    await answer('{"harnesses":[]}');
    routes.removeMembership(key("b1"));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      kind: "blocked",
      reason: "readiness_pending",
      revision: 3,
    });
    routes.setMembership(member("b1", {}));
    expect(routes.routeFor(key("b1")).revision).toBe(4);
  });

  it("keeps concurrent agents apart: one's change doesn't touch another's revision or cache", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    routes.setMembership(member("b2", {}));
    await answer('{"harnesses":[]}');
    await answer('{"harnesses":["pi"]}');
    routes.invalidate(key("b1"));
    expect(routes.routeFor(key("b2"))).toMatchObject({
      kind: "eligible",
      revision: 2,
      harnesses: ["pi"],
    });
  });

  it("rechecks a failed route for a turn and waits for that recheck, never returning the cached failure", async () => {
    const retry = retryClock();
    const { routes, answer, pending } = setup();
    routes.setMembership(member("b1", {}));
    // Without a wait signal, a turn takes the route as it stands.
    await expect(routes.routeForTurn(key("b1"))).resolves.toMatchObject({
      kind: "blocked",
      reason: "readiness_pending",
    });
    await answer("", 500);
    await retry();
    await answer("", 500);
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "gateway_error",
    });
    // The wait ends before the recheck answers: pending, so its answer could
    // still be a denial.
    await expect(
      routes.routeForTurn(key("b1"), AbortSignal.abort()),
    ).resolves.toMatchObject({ kind: "blocked", reason: "readiness_pending" });
    expect(pending).toHaveLength(1);
    // A later turn waits for that recheck, which here refuses access.
    const denied = routes.routeForTurn(key("b1"), new AbortController().signal);
    await answer("", 403);
    await expect(denied).resolves.toMatchObject({ reason: "auth" });
    // A known refusal is returned at once while it is checked again.
    await expect(
      routes.routeForTurn(key("b1"), new AbortController().signal),
    ).resolves.toMatchObject({ reason: "auth" });
    expect(pending).toHaveLength(1);
    await answer('{"harnesses":[]}');
    await expect(routes.routeForTurn(key("b1"))).resolves.toMatchObject({
      kind: "eligible",
      harnesses: [],
    });
    expect(pending).toHaveLength(0);
  });

  it("gives a turn its recheck's own failure when that recheck fails again inside the wait", async () => {
    const retry = retryClock();
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    await answer("", 500);
    await retry();
    await answer("", 500);
    const turn = routes.routeForTurn(key("b1"), new AbortController().signal);
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
    });
    await answer("", 503);
    await retry();
    await answer("", 502);
    await expect(turn).resolves.toMatchObject({
      kind: "blocked",
      reason: "gateway_error",
    });
  });

  it("keeps a failed 403 standing for later turns while no request path is bound", async () => {
    const { routes, answer, request } = setup();
    const unbind = routes.bindRequest(request);
    routes.setMembership(member("b1", {}));
    await answer("", 403);
    unbind();
    for (let turn = 0; turn < 2; turn++)
      await expect(
        routes.routeForTurn(key("b1"), new AbortController().signal),
      ).resolves.toMatchObject({ kind: "blocked", reason: "auth" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, "inference"] as const)(
    "preserves a %s refusal across consecutive turns, hung and failed rechecks, until success",
    async (denial) => {
      const retry = retryClock();
      const { routes, answer, pending } = setup();
      routes.setMembership(member("b1", {}));
      if (denial === "inference") {
        await answer('{"harnesses":["pi"]}');
        routes.invalidate(key("b1"));
      } else await answer("", denial);
      const auth = { kind: "blocked", reason: "auth" };
      await expect(routes.routeForTurn(key("b1"))).resolves.toMatchObject(auth);
      expect(pending).toHaveLength(1);
      // A later turn's wait has expired while the recheck is still hung.
      await expect(
        routes.routeForTurn(key("b1"), AbortSignal.abort()),
      ).resolves.toMatchObject(auth);
      pending.shift()?.respond(new Error("offline"));
      await retry();
      await answer("", 503);
      expect(routes.routeFor(key("b1"))).toMatchObject(auth);
      // The failed recheck is retried without forgetting the refusal.
      await expect(routes.routeForTurn(key("b1"))).resolves.toMatchObject(auth);
      await answer('{"harnesses":["pi"]}');
      await expect(routes.routeForTurn(key("b1"))).resolves.toMatchObject({
        kind: "eligible",
        harnesses: ["pi"],
      });
    },
  );

  it("preserves auth refusal while explicit discovery retries and fails", async () => {
    const retry = retryClock();
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    await answer("", 403);
    const ready = routes.routeReady(key("b1"), new AbortController().signal);
    expect(routes.routeFor(key("b1"))).toMatchObject({ reason: "auth" });
    await answer("", 500);
    await retry();
    await answer("", 502);
    await expect(ready).resolves.toMatchObject({ reason: "auth" });
  });

  it("clears a refusal on membership context reset and ignores stale recheck answers", async () => {
    const { routes, answer } = setup();
    const original = member("b1", {});
    routes.setMembership(original);
    await answer("", 403);
    await routes.routeForTurn(key("b1"));
    routes.setMembership({ ...original, owner: "c".repeat(64) });
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
    });
    // Settle the new identity's denial before the old identity's success.
    await answer("", 403, 1);
    await answer('{"harnesses":["pi"]}');
    expect(routes.routeFor(key("b1"))).toMatchObject({ reason: "auth" });
    await routes.routeForTurn(key("b1"));
    routes.removeMembership(key("b1"));
    routes.setMembership(original);
    await answer('{"harnesses":["pi"]}');
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
    });
    await answer('{"harnesses":["pi"]}');
    expect(routes.routeFor(key("b1"))).toMatchObject({ kind: "eligible" });
  });

  it("lets a turn wait for a probe in flight that settles before its wait ends", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    const turn = routes.routeForTurn(key("b1"), new AbortController().signal);
    await answer('{"harnesses":["pi"]}');
    await expect(turn).resolves.toMatchObject({
      kind: "eligible",
      harnesses: ["pi"],
    });
  });

  it("gives a turn the pending route once its wait ends before the probe settles", async () => {
    const { routes, pending } = setup();
    routes.setMembership(member("b1", {}));
    const wait = new AbortController();
    const turn = routes.routeForTurn(key("b1"), wait.signal);
    wait.abort(new Error("cap"));
    await expect(turn).resolves.toMatchObject({
      kind: "blocked",
      reason: "readiness_pending",
    });
    // The probe goes on for later turns.
    expect(pending).toHaveLength(1);
  });

  it("fails the next turn on a 403 re-probe after invalidate, instead of letting it pass while pending", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    await answer('{"harnesses":["pi"]}');
    routes.invalidate(key("b1"));
    const turn = routes.routeForTurn(key("b1"), new AbortController().signal);
    await answer("", 403);
    await expect(turn).resolves.toMatchObject({
      kind: "blocked",
      reason: "auth",
    });
  });

  it("doesn't wait when no probe is in flight, and never starts one to wait on", async () => {
    const routes = new GatewayRoutes(() => DESCRIPTOR);
    routes.setMembership(member("b1", {}));
    // No request bound: nothing is in flight.
    await expect(
      routes.routeForTurn(key("b1"), new AbortController().signal),
    ).resolves.toMatchObject({ reason: "readiness_pending" });
    // No relay session yet: pending without a probe.
    const { routes: bound, request } = setup();
    bound.setMembership(member("b2", undefined));
    await expect(
      bound.routeForTurn(key("b2"), new AbortController().signal),
    ).resolves.toMatchObject({ reason: "readiness_pending" });
    expect(request).not.toHaveBeenCalled();
  });

  it("waits for readiness under an explicit operation's signal and retries a failed probe once", async () => {
    const retry = retryClock();
    const { routes, answer, pending } = setup();
    routes.setMembership(member("b1", {}));
    await answer("", 500);
    await retry();
    await answer("", 500);
    const ready = routes.routeReady(key("b1"), new AbortController().signal);
    expect(pending).toHaveLength(1);
    await answer('{"harnesses":[]}');
    await expect(ready).resolves.toMatchObject({
      kind: "eligible",
      revision: 4,
    });

    routes.invalidate(key("b1"));
    const controller = new AbortController();
    const waiting = routes.routeReady(key("b1"), controller.signal);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
  });

  it("keeps waiting when the membership changes while an operation waits for readiness", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    const ready = routes.routeReady(key("b1"), new AbortController().signal);
    routes.setMembership(member("b1", {}, { owner: "c".repeat(64) }));
    await answer('{"harnesses":[]}');
    await answer('{"harnesses":[]}');
    await expect(ready).resolves.toMatchObject({
      kind: "eligible",
      identity: { human_pubkey: "c".repeat(64) },
    });
  });

  it("blocks a membership it was never told about while a descriptor is configured", () => {
    const { routes } = setup();
    expect(routes.routeFor(key("unknown"))).toMatchObject({
      kind: "blocked",
      reason: "readiness_pending",
    });
  });

  it("ignores a late 401/403 from an older revision", async () => {
    const { routes, answer, request } = setup();
    routes.setMembership(member("b1", {}));
    await answer('{"harnesses":[]}');
    const ready = routes.routeFor(key("b1"));
    routes.invalidate(key("b1"), ready.revision - 1);
    expect(routes.routeFor(key("b1"))).toEqual(ready);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stays pending without a request path, and probes once one is bound", async () => {
    const routes = new GatewayRoutes(() => DESCRIPTOR);
    routes.setMembership(member("b1", {}));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
    });
    const net = gateway();
    const unbind = routes.bindRequest(net.request);
    expect(net.request).toHaveBeenCalledTimes(1);
    await net.answer('{"harnesses":[]}');
    expect(routes.routeFor(key("b1")).kind).toBe("eligible");
    unbind();
    routes.invalidate(key("b1"));
    expect(net.request).toHaveBeenCalledTimes(1);
  });
});
