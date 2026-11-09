import { afterEach, expect, it, vi } from "vitest";
import { createDevSession, brokerBuilderlab } from "./dev-session";
import { createAgentClient } from "./agents/client";
import { createAppsClient } from "./apps/client";
import { applyApps } from "./apps";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { deferred } from "./test-helpers";
import type { BuilderlabSession } from "./session";

const fresh = (session: BuilderlabSession) =>
  session.freshCredential(new AbortController().signal).then(
    () => {},
    () => {},
  );

class Events {
  static all: Events[] = [];
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  close = vi.fn();
  constructor(readonly url: string) {
    Events.all.push(this);
  }
  emit(
    revision: string,
    subject: string | null,
    pending = false,
    error?: string,
  ) {
    this.onmessage?.({
      data: JSON.stringify({
        revision,
        pending,
        ...(error ? { error } : {}),
        auth: subject
          ? {
              subject,
              email: `${subject}@example.com`,
              expiresAt: "2030",
              capabilities: { can_use_remote_agents: true },
            }
          : null,
      }),
    });
  }
}
function setup() {
  vi.stubGlobal("EventSource", Events);
  vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:1430" } });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ status: 200, headers: {}, body: "{}" }),
  );
  vi.stubGlobal("fetch", fetch);
  const dev = createDevSession();
  const events = Events.all.at(-1);
  if (!events) throw new Error("Missing server event stream");
  return { ...dev, events, fetch };
}
async function signedIn(
  session: ReturnType<typeof createDevSession>["session"],
) {
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Events.all = [];
});

it("uses the broker only in its development mode, leaving FI and production on their existing owner", () => {
  for (const [dev, live, fi, expected] of [
    [true, "1", "0", true],
    [true, "0", "0", false],
    [true, "1", "1", false],
    [false, "1", "0", false],
  ] as const) {
    vi.stubEnv("DEV", dev);
    vi.stubEnv("VITE_BUZZ_LIVE", live);
    vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", fi);
    expect(brokerBuilderlab()).toBe(expected);
  }
});

it("reloads its public session projection without starting or ending the server login", async () => {
  const h = setup();
  h.events.emit("one", "A");
  await signedIn(h.session);
  expect(h.session.credential()).toEqual({
    revision: "one",
    account: expect.objectContaining({ subject: "A" }),
  });
  expect(h.session.viewerSession()).toMatchObject({
    broker: { origin: "http://127.0.0.1:1430", revision: "one" },
  });
  const viewer = h.session.viewerSession();
  h.session.dispose();
  expect(viewer.signal.aborted).toBe(true);
  expect(h.events.close).toHaveBeenCalled();
  const second = createDevSession();
  const events = Events.all.at(-1);
  if (!events) throw new Error("Missing restored event stream");
  events.emit("one", "A");
  await signedIn(second.session);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(second.session.snapshot().account?.subject).toBe("A");
  second.session.dispose();
});

it("shares agent and Apps transport without an app-held credential and refuses stale operation results", async () => {
  const h = setup();
  h.events.emit("one", "A");
  await signedIn(h.session);
  h.fetch.mockResolvedValueOnce(
    Response.json({
      status: 200,
      headers: {},
      body: JSON.stringify({ status: 1, agents: [] }),
    }),
  );
  await expect(
    createAgentClient(h.session, null).list(new AbortController().signal),
  ).resolves.toEqual([]);
  const owner = h.session.credential();
  const apps = createAppsClient(
    h.session,
    "https://compose-ctrl.builderlab.xyz",
    h.apps,
  );
  h.fetch.mockResolvedValueOnce(
    Response.json({
      status: 200,
      headers: {},
      body: JSON.stringify({ apps: [] }),
    }),
  );
  await apps.list();
  expect(
    h.fetch.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string),
    ),
  ).toMatchObject([
    { revision: "one", path: "/v3/beekeeper/list-agents", method: "POST" },
    { revision: "one", target: "apps", path: "/v1/agent/apps?scope=owned" },
  ]);
  const held = deferred<Response>();
  h.fetch.mockImplementationOnce(() => held.promise);
  const pending = h.session.request(owner, {
    path: "/v3/beekeeper/list-agents",
  });
  const rejected = expect(pending).rejects.toThrow("session changed");
  const oldViewer = h.session.viewerSession();
  h.events.emit("two", "B");
  await signedIn(h.session);
  expect(oldViewer.signal.aborted).toBe(true);
  held.resolve(Response.json({ status: 200, headers: {}, body: "{}" }));
  await rejected;
  await expect(apps.list()).rejects.toThrow("sign-in changed");
  expect(h.session.snapshot().account?.subject).toBe("B");
  h.events.emit("three", null);
  expect(h.session.snapshot().status).toBe("signed-out");
  h.session.dispose();
});

it("cancels local viewers on sign-out and reconnects to the authoritative state after a stream interruption", async () => {
  const h = setup();
  h.events.emit("one", "A");
  await signedIn(h.session);
  const viewer = h.session.viewerSession();
  h.events.onerror?.();
  expect(viewer.signal.aborted).toBe(true);
  expect(h.session.snapshot()).toMatchObject({
    status: "pending",
    checking: true,
  });
  h.events.emit("one", "A");
  await signedIn(h.session);
  h.session.signOut();
  expect(h.fetch).toHaveBeenCalledWith(
    "/api/builderlab/sign-out",
    expect.objectContaining({ body: JSON.stringify({ revision: "one" }) }),
  );
  h.events.emit("two", null);
  expect(h.session.snapshot()).toEqual({ status: "signed-out" });
  h.session.dispose();
});

it("returns accepted deployment IDs without checking readiness under a replacement dev account", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://app.builderlabstaging.xyz");
  const h = setup();
  const tools = new Map<string, AddedTool>();
  const ctx = {
    panels: { register() {} },
    browser: { available: true, View: () => null },
    host: {},
    agents: { addTool: (tool: AddedTool) => tools.set(tool.name, tool) },
  };
  applyApps(ctx as never, h.session, true, h.apps);
  h.events.emit("one", "A");
  await signedIn(h.session);
  const accepted = deferred<void>();
  const receipt = deferred<Response>();
  h.fetch.mockResolvedValueOnce(
    Response.json({
      status: 200,
      headers: {},
      body: JSON.stringify({ minimum_client_version: "0.2.0" }),
    }),
  );
  h.fetch.mockImplementationOnce(() => {
    accepted.resolve();
    return receipt.promise;
  });
  const tool = tools.get("apps_deploy");
  if (!tool) throw new Error("Missing apps_deploy tool");
  const pending = tool.call(
    {} as never,
    {},
    {
      app_id: "demo",
      artifact: "/Users/me/artifact.tar.gz",
    },
  );
  try {
    await accepted.promise;
    h.events.emit("two", "B");
    await signedIn(h.session);
  } finally {
    receipt.resolve(
      Response.json({
        status: 201,
        headers: {},
        body: JSON.stringify({ version_id: "v1", deployment_id: "d1" }),
      }),
    );
  }
  expect(JSON.parse(String(await pending))).toMatchObject({
    app_id: "demo",
    version_id: "v1",
    deployment_id: "d1",
    ready: false,
    readiness_error: expect.stringMatching(/sign-in changed/),
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.session.snapshot().account?.subject).toBe("B");
  h.session.dispose();
});

type LoginCase = {
  outcome: "HTTP" | "network" | "broker";
  lifecycle: "current" | "canceled" | "replaced" | "disposed";
  fresh?: "pending" | "signed-in" | "failed" | "same-owner";
  after?: "snapshot";
  local?: true;
};
const loginCases: LoginCase[] = [
  ...(["HTTP", "network", "broker"] as const).flatMap((outcome) =>
    (["current", "canceled", "replaced", "disposed"] as const).map(
      (lifecycle) => ({ outcome, lifecycle }),
    ),
  ),
  ...(["pending", "signed-in", "failed", "same-owner"] as const).map(
    (fresh) => ({
      outcome: "network" as const,
      lifecycle: "current" as const,
      fresh,
    }),
  ),
  { outcome: "broker", lifecycle: "replaced", local: true },
  { outcome: "network", lifecycle: "canceled", after: "snapshot" },
  { outcome: "network", lifecycle: "disposed", after: "snapshot" },
];

// A dispatch can fail before admission or after its broker events. Only an
// unaccounted current failure renews the stream; shared state always wins.
it.each(
  loginCases.map((row) => ({
    fresh: "idle" as const,
    after: "response" as const,
    local: false,
    ...row,
  })),
)(
  "projects $outcome failure: $lifecycle, fresh=$fresh, invalidation=$after, local=$local",
  async ({ outcome, lifecycle, fresh, after, local }) => {
    const h = setup();
    h.events.emit("initial", fresh === "same-owner" ? "A" : null);
    if (fresh === "same-owner") await signedIn(h.session);
    const owner = fresh === "same-owner" ? h.session.credential() : undefined;
    const viewer =
      fresh === "same-owner" ? h.session.viewerSession() : undefined;
    const response = deferred<Response>();
    const replacementResponse = deferred<Response>();
    h.fetch.mockImplementationOnce(() => response.promise);
    const login = h.session.signIn();
    let replacement: Promise<void> | undefined;
    const brokerError = "Builderlab code exchange failed with HTTP 503";
    const invalidate = () => {
      if (lifecycle === "canceled") {
        h.session.cancel();
        if (after === "response") h.events.emit("canceled", null);
      } else if (lifecycle === "disposed") h.session.dispose();
      else if (lifecycle === "replaced") {
        if (outcome === "broker")
          h.events.emit("failed-A", null, false, brokerError);
        if (local) {
          h.fetch.mockImplementationOnce(() => replacementResponse.promise);
          replacement = h.session.signIn();
        }
        // Shared replacement rows deliberately have no second local signIn().
        h.events.emit("attempt-B", null, true);
      }
    };
    try {
      if (outcome === "broker") {
        h.events.emit("attempt-A", null, true);
        expect(h.session.snapshot()).toEqual({ status: "pending" });
      }
      if (after === "response") invalidate();
      if (outcome === "broker" && lifecycle !== "replaced")
        h.events.emit(
          "ended-A",
          null,
          false,
          lifecycle === "current" ? brokerError : undefined,
        );
      if (outcome === "network")
        response.reject(new TypeError("Failed to fetch"));
      else
        response.resolve(
          Response.json({ error: brokerError }, { status: 502 }),
        );
      await login;

      const renewed =
        outcome !== "broker" &&
        (lifecycle === "current" || after === "snapshot");
      expect(Events.all).toHaveLength(renewed ? 2 : 1);
      expect(h.events.close).toHaveBeenCalledTimes(
        renewed || lifecycle === "disposed" ? 1 : 0,
      );
      const current = Events.all.at(-1);
      if (!current) throw new Error("Missing broker event stream");
      if (renewed) {
        expect(current).not.toBe(h.events);
        expect(h.session.snapshot()).toEqual({
          status: "pending",
          checking: true,
        });
        // Neither retired callback may mutate the fresh subscription or owner.
        h.events.emit("retired", null, true);
        h.events.onerror?.();
        expect(h.session.snapshot()).toEqual({
          status: "pending",
          checking: true,
        });
        if (after === "snapshot") invalidate();
        current.emit(
          fresh === "same-owner" ? "initial" : "fresh",
          fresh === "same-owner" ? "A" : fresh === "signed-in" ? "B" : null,
          fresh === "pending",
          fresh === "failed" ? "Broker failure" : undefined,
        );
        if (fresh === "signed-in" || fresh === "same-owner")
          await signedIn(h.session);
      }
      const error =
        lifecycle !== "current"
          ? undefined
          : outcome === "broker"
            ? brokerError
            : fresh === "failed"
              ? "Broker failure"
              : fresh === "idle"
                ? "Could not start Builderlab sign-in. Try again."
                : undefined;
      if (fresh === "same-owner") {
        expect(h.session.snapshot()).toEqual({
          status: "signed-in",
          account: owner?.account,
        });
        expect(h.session.credential()).toBe(owner);
        expect(h.session.viewerSession()).toBe(viewer);
        expect(viewer?.signal.aborted).toBe(false);
      } else if (fresh === "signed-in")
        expect(h.session.snapshot()).toMatchObject({
          status: "signed-in",
          account: { subject: "B" },
        });
      else
        expect(h.session.snapshot()).toEqual({
          status:
            lifecycle === "replaced" ||
            (lifecycle === "current" && fresh === "pending")
              ? "pending"
              : "signed-out",
          ...(error ? { error } : {}),
        });
      if (!error) expect(h.session.snapshot()).not.toHaveProperty("error");

      if (lifecycle === "replaced") {
        h.events.emit("failed-B", null, false, "New login failed");
        replacementResponse.resolve(
          Response.json({ error: "New login failed" }, { status: 502 }),
        );
        await replacement;
        expect(h.session.snapshot()).toEqual({
          status: "signed-out",
          error: "New login failed",
        });
        expect(Events.all).toHaveLength(1);
      } else if (fresh === "pending") {
        current.emit("replacement-ended", null);
        expect(h.session.snapshot()).toEqual({ status: "signed-out" });
      } else if (renewed && lifecycle === "current" && fresh === "idle") {
        const retry = h.session.signIn();
        current.emit("retry", null, true);
        await retry;
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.session.snapshot()).toEqual({ status: "pending" });
      }
    } finally {
      h.session.dispose();
      response.resolve(Response.json({}));
      replacementResponse.resolve(Response.json({}));
      await Promise.all([login, replacement]);
    }
    expect(Events.all.at(-1)?.close).toHaveBeenCalled();
  },
);

it("refreshes only capabilities through the broker while preserving its owner and app viewers", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const h = setup();
  try {
    h.events.emit("one", "A");
    await signedIn(h.session);
    const owner = h.session.credential();
    const viewer = h.session.viewerSession();
    await fresh(h.session);
    expect(h.fetch).not.toHaveBeenCalled();
    now += 60_000;
    h.fetch.mockResolvedValueOnce(
      Response.json({
        revision: "one",
        capabilities: {
          can_use_remote_agents: false,
          can_use_builderlab_decisions: true,
          can_delete_buzz_communities: true,
        },
      }),
    );
    await Promise.all([fresh(h.session), fresh(h.session)]);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.session.snapshot().account).toMatchObject({
      subject: "A",
      email: "A@example.com",
      canUseRemoteAgents: false,
      canUseBuilderlabDecisions: true,
    });
    expect(h.session.credential()).toBe(owner);
    expect(h.session.viewerSession()).toBe(viewer);
    expect(viewer.signal.aborted).toBe(false);
    now += 60_000;
    h.fetch.mockRejectedValueOnce(new TypeError("Offline"));
    const previous = h.session.snapshot();
    await fresh(h.session);
    expect(h.session.snapshot().account).toBe(previous.account);
    now += 60_000;
    h.fetch.mockResolvedValueOnce(
      Response.json({
        revision: "replacement",
        capabilities: { can_use_remote_agents: true },
      }),
    );
    await fresh(h.session);
    expect(h.session.snapshot().account).toBe(previous.account);
    expect(h.fetch).toHaveBeenLastCalledWith(
      "/api/builderlab/capabilities?revision=one",
      { signal: viewer.signal },
    );
  } finally {
    h.session.dispose();
    clock.mockRestore();
  }
});

it("restores the broker's capability cache age instead of starting another minute on reload", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const h = setup();
  const checkedAt = now;
  // A reload restores the broker's last projection halfway through its cache lifetime.
  now += 30_000;
  h.events.onmessage?.({
    data: JSON.stringify({
      revision: "one",
      pending: false,
      capabilitiesCheckedAt: checkedAt,
      auth: {
        subject: "A",
        email: "A@example.org",
        expiresAt: "2030",
        capabilities: { can_use_remote_agents: true },
      },
    }),
  });
  try {
    await signedIn(h.session);
    now = checkedAt + 59_999;
    await fresh(h.session);
    expect(h.fetch).not.toHaveBeenCalled();
    now += 1;
    h.fetch.mockResolvedValueOnce(
      Response.json({
        revision: "one",
        capabilities: { can_use_remote_agents: false },
      }),
    );
    await fresh(h.session);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.session.snapshot().account?.canUseRemoteAgents).toBe(false);
  } finally {
    h.session.dispose();
    clock.mockRestore();
  }
});

it.each(["sign-out", "replacement", "disposal"] as const)(
  "cancels a pending capability read on %s without waiting for its response",
  async (end) => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = setup();
    const response = deferred<Response>();
    let refresh: Promise<void> | undefined;
    try {
      h.events.emit("one", "A");
      await signedIn(h.session);
      const viewer = h.session.viewerSession();
      now += 60_000;
      h.fetch.mockImplementationOnce(
        (_url, init) =>
          new Promise((resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
            response.promise.then(resolve, reject);
          }),
      );
      refresh = fresh(h.session);
      await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledOnce());
      const signal = h.fetch.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      if (end === "sign-out") h.session.signOut();
      else if (end === "replacement") h.events.emit("two", "B");
      else h.session.dispose();
      expect(signal?.aborted).toBe(true);
      expect(viewer.signal.aborted).toBe(true);
      await refresh;
      if (end === "replacement") {
        await signedIn(h.session);
        expect(h.session.snapshot().account?.subject).toBe("B");
      } else if (end === "sign-out") {
        expect(h.fetch).toHaveBeenLastCalledWith(
          "/api/builderlab/sign-out",
          expect.anything(),
        );
        h.events.emit("two", null);
        expect(h.session.snapshot().status).toBe("signed-out");
      } else expect(h.session.snapshot().status).toBe("signed-out");
    } finally {
      response.resolve(Response.json({ revision: "one", capabilities: {} }));
      await refresh;
      h.session.dispose();
      clock.mockRestore();
    }
  },
);
