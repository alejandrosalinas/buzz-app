import { createTestSession } from "../test-helpers";
import { expect, it, vi } from "vitest";
import type {
  HostRequest,
  HostResponse,
  HostUpload,
} from "../../../features/host/service";
import { createAppsClient } from "./client";
import { controlPlane, isAppUrl } from "./environment";

const BASE = "https://compose-ctrl.builderlabstaging.xyz";
const json = (status: number, body: unknown): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});
const contract = (profiles = ["static", "fetch-js"], minimum = "0.2.0") =>
  json(200, {
    minimum_client_version: minimum,
    runtime_info: {
      supported_runtime_profiles: profiles.map((profile) => ({ profile })),
    },
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["create", "community"] as const)(
  "stops %s after the owner changes during its first request",
  async (operation) => {
    let owner = "A";
    const session = createTestSession(async () => ({
      revision: owner,
      account: {
        subject: owner,
        email: "",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    }));
    await session.signIn();
    const held = deferred<HostResponse>();
    const request = vi.fn(() => held.promise);
    const client = createAppsClient(session, BASE, { request });
    const pending =
      operation === "create"
        ? client.create("Demo")
        : client.community("demo", "buzz-alpha", "grant");
    const rejected = expect(pending).rejects.toThrow(/sign-in changed/);
    session.signOut();
    owner = "B";
    await session.signIn();
    held.resolve(
      operation === "create"
        ? contract()
        : json(200, { lifecycle_id: "life", community_grant_revision: 1 }),
    );
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("preserves the reserved app ID when sign-out interrupts initialization", async () => {
  const session = createTestSession(async () => ({
    revision: "A",
    account: {
      subject: "A",
      email: "",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  await session.signIn();
  const held = deferred<HostResponse>();
  const started = deferred<void>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(contract())
    .mockResolvedValueOnce(
      json(200, {
        app_id: "demo",
        initialize: { required: true, recommended: true },
      }),
    )
    .mockImplementationOnce(() => {
      started.resolve();
      return held.promise;
    });
  const client = createAppsClient(session, BASE, { request });
  const pending = client.create("Demo");
  const rejected = expect(pending).rejects.toThrow(
    /app_id=demo.*not signed in/,
  );
  await started.promise;
  session.signOut();
  held.resolve(json(201, { app_id: "demo" }));
  await rejected;
  expect(request).toHaveBeenCalledTimes(3);
});

async function setup(responses: HostResponse[], signedIn = true) {
  const session = createTestSession(async () => ({
    revision: "revision-1",
    account: {
      subject: "auth0|owner",
      email: "",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  if (signedIn) await session.signIn();
  const requests: (HostRequest | HostUpload)[] = [];
  const next = async (input: HostRequest | HostUpload) => {
    requests.push(input);
    const response = responses.shift();
    if (!response) throw new Error("No response left");
    return response;
  };
  return {
    client: createAppsClient(session, BASE, {
      request: vi.fn(next),
      upload: vi.fn(next),
    }),
    requests,
  };
}

it("plans and reserves a static app, leaving the session to the transport", async () => {
  const { client, requests } = await setup([
    contract(),
    json(200, {
      app_id: "demo-1a2b",
      display_name: "Demo",
      environment: "production",
      initialize: { required: false, recommended: false },
      external_url: "https://demo-1a2b--bpsites.apps.builderlabstaging.xyz/",
    }),
    json(200, { ok: true, app_id: "demo-1a2b" }),
  ]);
  await expect(client.create("Demo")).resolves.toEqual({
    app_id: "demo-1a2b",
    external_url: "https://demo-1a2b--bpsites.apps.builderlabstaging.xyz/",
  });
  expect(requests).toMatchObject([
    { url: `${BASE}/v1/agent/contract`, method: "GET" },
    {
      url: `${BASE}/v1/agent/apps/plan`,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Hotpod-Agent-Client-Version": "0.2.0",
      },
    },
    { url: `${BASE}/v1/agent/apps/demo-1a2b/reserve`, method: "POST" },
  ]);
  expect((requests[1] as HostRequest).headers).not.toHaveProperty(
    "Authorization",
  );
  const [, plan, reserve] = requests as HostRequest[];
  expect(JSON.parse(plan?.body ?? "")).toEqual({
    name: "Demo",
    runtime_profile: "static",
    client_version: "0.2.0",
  });
  expect(JSON.parse(reserve?.body ?? "")).toEqual({
    runtime_profile: "static",
    environment: "production",
    name: "Demo",
  });
});

it("keeps permission failures distinct from expired sign-in", async () => {
  const { client } = await setup([
    json(403, {
      error: {
        code: "publisher_not_approved",
        message: "Workspace is not enabled",
      },
      next_action: "Ask an owner",
    }),
  ]);
  await expect(client.list()).rejects.toThrow(
    "Listing apps failed (HTTP 403): publisher_not_approved: Workspace is not enabled: next_action: Ask an owner",
  );
});

it("rejects unsupported runtimes and newer minimum clients before mutations", async () => {
  for (const response of [
    contract(["fetch-js"]),
    contract(["static"], "0.3.0"),
  ]) {
    const { client, requests } = await setup([response]);
    await expect(client.create("Demo")).rejects.toThrow(
      /does not advertise static|requires client 0.3.0/,
    );
    expect(requests).toHaveLength(1);
    expect((requests[0] as HostRequest).method).toBe("GET");
  }
});

it("copies the executable plan into reserve and initialize", async () => {
  const { client, requests } = await setup([
    contract(["fetch-js"]),
    json(200, {
      app_id: "demo",
      runtime_profile: "fetch-js",
      environment: "production",
      initialize: { required: true, recommended: true },
    }),
    json(201, { app_id: "demo" }),
    json(200, { app_id: "demo", external_url: "https://demo.example/" }),
  ]);
  await expect(client.create("Demo", "fetch-js")).resolves.toMatchObject({
    app_id: "demo",
  });
  for (const request of requests.slice(2) as HostRequest[])
    expect(JSON.parse(request.body ?? "")).toMatchObject({
      runtime_profile: "fetch-js",
      environment: "production",
    });
  expect((requests[3] as HostRequest).timeoutMs).toBe(180_000);
  expect((requests[2] as HostRequest).timeoutMs).toBeUndefined();
});

it("refuses incomplete initialization decisions before reserving", async () => {
  const { client, requests } = await setup([
    contract(),
    json(200, { app_id: "demo", initialize: { required: false } }),
  ]);
  await expect(client.create("Demo")).rejects.toThrow(
    /no complete initialization decision/,
  );
  expect(requests).toHaveLength(2);
});

it("preserves the planned app ID when reservation is ambiguous", async () => {
  const { client } = await setup([
    contract(),
    json(200, {
      app_id: "demo",
      initialize: { required: false, recommended: false },
    }),
    json(502, { error: { message: "upstream unavailable" } }),
  ]);
  await expect(client.create("Demo")).rejects.toThrow(
    /during reserve for app_id=demo.*reservation may already exist/,
  );
});

it("preserves the reservation when initialization fails or substitutes an app", async () => {
  for (const response of [
    json(503, { error: { message: "rollout failed" } }),
    json(200, { app_id: "other" }),
  ]) {
    const { client } = await setup([
      contract(),
      json(200, {
        app_id: "demo",
        initialize: { required: true, recommended: false },
      }),
      json(201, { app_id: "demo" }),
      response,
    ]);
    await expect(client.create("Demo")).rejects.toThrow(
      /during initialize for app_id=demo.*inspect or resume/,
    );
  }
});

it("pins readiness to version, deployment and rollout IDs", async () => {
  const { client, requests } = await setup([json(200, { ready: true })]);
  await client.ready("demo", "v1", "d1", "r1");
  expect(requests[0]?.url).toBe(
    `${BASE}/v1/agent/apps/demo/ready?version_id=v1&deployment_id=d1&rollout_id=r1`,
  );
});

it("uploads the artifact to the app's deploy endpoint", async () => {
  const { client, requests } = await setup([
    json(200, { ok: true, version_id: "ver-1" }),
  ]);
  await expect(
    client.deploy("demo", "/Users/me/demo/artifact.tar.gz"),
  ).resolves.toEqual({ ok: true, version_id: "ver-1" });
  expect(requests).toEqual([
    {
      url: `${BASE}/v1/agent/apps/demo/deploy`,
      headers: {
        Accept: "application/json",
        "X-Hotpod-Agent-Client-Version": "0.2.0",
      },
      file: {
        field: "artifact",
        path: "/Users/me/demo/artifact.tar.gz",
        name: "artifact.tar.gz",
        contentType: "application/gzip",
      },
    },
  ]);
});

it("points the agent at Settings when signed out or refused", async () => {
  const signedOut = await setup([], false);
  await expect(signedOut.client.list()).rejects.toThrow(
    /not signed in.*Settings → Plugins → Builderlab, then/,
  );
  expect(signedOut.requests).toEqual([]);
  const refused = await setup([json(401, {})]);
  await expect(refused.client.list()).rejects.toThrow(
    /refused the sign-in for .* \(HTTP 401\)\. Try again\. If it keeps happening, ask your owner to check their Builderlab sign-in at Settings/,
  );
});

it("switches visibility without sending viewers", async () => {
  const { client, requests } = await setup([
    json(200, { ok: true, app_id: "demo", visibility: "restricted" }),
    json(200, { ok: true, app_id: "demo", visibility: "restricted" }),
  ]);
  await client.visibility("demo", "only_you");
  expect(requests[0]).toMatchObject({
    url: `${BASE}/v1/agent/apps/demo/visibility`,
    method: "PUT",
    body: JSON.stringify({ visibility: "restricted" }),
  });
  await expect(client.visibility("demo", "workspace")).rejects.toThrow(
    "Apps Platform reported demo as restricted, not demo as organization. Ask your owner to check who can open it in Share & manage before retrying",
  );
  const other = await setup([
    json(200, { ok: true, app_id: "other", visibility: "organization" }),
  ]);
  await expect(other.client.visibility("demo", "workspace")).rejects.toThrow(
    /reported other as organization, not demo as organization/,
  );
});

it.each([
  ["grant", "POST"],
  ["revoke", "DELETE"],
] as const)(
  "%ss a community at the grant revision it just read",
  async (action, method) => {
    const { client, requests } = await setup([
      json(200, { lifecycle_id: "life-1", community_grant_revision: 7 }),
      json(200, { ok: true, community_grant_revision: 8 }),
    ]);
    await client.community("demo", "buzz/alpha", action);
    const path = `${BASE}/v1/agent/apps/demo/sharing/communities/buzz%2Falpha`;
    expect(requests).toMatchObject([
      { url: path, method: "GET" },
      {
        url: path,
        method,
        body: JSON.stringify({ lifecycle_id: "life-1", expected_revision: 7 }),
      },
    ]);
  },
);

it("tells the agent to deploy before sharing an app with no sharing lifecycle", async () => {
  for (const response of [
    json(409, {
      error: {
        code: "community_grant_conflict",
        message: "app sharing state changed; read access and retry",
      },
    }),
  ]) {
    const { client, requests } = await setup([response]);
    await expect(
      client.community("demo", "buzz-alpha", "grant"),
    ).rejects.toThrow(
      "This app isn't set up for sharing yet. Deploy it with apps_deploy, then try again.",
    );
    expect(requests).toHaveLength(1);
  }
});

it("changes nothing when the sharing read has no valid revision", async () => {
  for (const body of [
    { community_grant_revision: 0 },
    { lifecycle_id: "life-1" },
    { lifecycle_id: "life-1", community_grant_revision: -1 },
    { lifecycle_id: "life-1", community_grant_revision: 1.5 },
  ]) {
    const { client, requests } = await setup([json(200, body)]);
    await expect(
      client.community("demo", "buzz-alpha", "grant"),
    ).rejects.toThrow(/no valid sharing revision.*nothing was changed/);
    expect(requests).toHaveLength(1);
  }
});

it("passes a conflicting community change through unchanged", async () => {
  const { client } = await setup([
    json(200, { lifecycle_id: "life-1", community_grant_revision: 7 }),
    json(409, {
      error: {
        code: "community_grant_conflict",
        message: "app sharing state changed; read access and retry",
      },
    }),
  ]);
  await expect(
    client.community("demo", "buzz-alpha", "revoke"),
  ).rejects.toThrow(
    "Revoking the community failed (HTTP 409): community_grant_conflict: app sharing state changed; read access and retry",
  );
});

it("deploys to the sign-in's own tenant", () => {
  expect(controlPlane("https://app.builderlabstaging.xyz")).toBe(BASE);
  expect(
    controlPlane(
      "https://login.example/",
      "https://login.example",
      "https://ctrl.example",
    ),
  ).toBe("https://ctrl.example");
  expect(
    controlPlane(
      "https://other.example",
      "https://login.example",
      "https://ctrl.example",
    ),
  ).toBeUndefined();
  expect(controlPlane("https://app.builderlab.xyz")).toBe(
    "https://compose-ctrl.builderlab.xyz",
  );
  expect(controlPlane("https://builderlab.example")).toBeUndefined();
  expect(controlPlane("")).toBeUndefined();
});

it("recognizes deployed app hosts across tenants", () => {
  for (const url of [
    "https://tiny-counter--bpsites.apps.builderlab.xyz/",
    "https://demo--bpsites.apps.example-tenant.builderlab.xyz/",
    "https://demo--bpsites.apps.builderlabstaging.xyz/path?x=1",
    "https://demo--workspace.apps.acme.builderlab.xyz/",
    "https://demo--workspace.apps.acme.builderlabstaging.xyz/",
    "https://demo.apps.acme-2.builderlab.xyz/",
    "https://demo.apps.7.builderlabstaging.xyz/",
    "https://nested.demo.apps.builderlab.xyz/",
    "https://nested.demo.apps.acme.builderlabstaging.xyz/",
    "https://DEMO.APPS.ACME.BUILDERLABSTAGING.XYZ:8443/path?x=1#section",
    `https://${"a".repeat(63)}.apps.${"b".repeat(63)}.builderlab.xyz/`,
  ])
    expect(isAppUrl(url), url).toBe(true);
});

it("rejects URLs outside the deployed app hostname shapes", () => {
  for (const url of [
    "http://demo--bpsites.apps.builderlab.xyz/",
    "https://apps.builderlab.xyz/",
    "https://demo--bpsites.apps.builderlab.xyz.example.org/",
    "https://evilapps.builderlab.xyz/",
    "https://user:pass@demo--bpsites.apps.builderlab.xyz/",
    "http://demo.apps.example-tenant.builderlab.xyz/",
    "https://apps.example-tenant.builderlab.xyz/",
    "https://demo.apps.example-tenant.builderlab.xyz.example.org/",
    "https://evilapps.example-tenant.builderlab.xyz/",
    "https://user:pass@demo.apps.example-tenant.builderlab.xyz/",
    "http://demo.apps.acme.builderlabstaging.xyz/",
    "https://user@demo.apps.acme.builderlab.xyz/",
    "https://:pass@demo.apps.acme.builderlabstaging.xyz/",
    "https://demo.apps.acme.builderlab.xyz@evil.example/",
    "https://apps.builderlabstaging.xyz/",
    "https://apps.acme.builderlab.xyz/",
    "https://apps.acme.builderlabstaging.xyz/",
    "https://demo.apps.acme.builderlabstaging.xyz.example.org/",
    "https://demo.evilapps.acme.builderlab.xyz/",
    "https://demo.apps.acme.builderlabstaging-evil.xyz/",
    "https://demo.apps.acme.builderlab.xyz.evil/",
    "https://demo.apps.acme.other.builderlab.xyz/",
    "https://apps.demo.acme.builderlabstaging.xyz/",
    "https://demo.acme.builderlab.xyz/",
    "https://demo.apps.builderlab.example/",
    "https://demo.apps.acme.builderlab.example/",
    "https://demo.apps..builderlab.xyz/",
    "https://demo.apps.-acme.builderlab.xyz/",
    "https://demo.apps.acme-.builderlabstaging.xyz/",
    "https://demo.apps.ac_me.builderlab.xyz/",
    "https://.demo.apps.builderlab.xyz/",
    "https://demo..apps.acme.builderlabstaging.xyz/",
    "https://-demo.apps.builderlab.xyz/",
    "https://demo-.apps.acme.builderlabstaging.xyz/",
    "https://de_mo.apps.builderlab.xyz/",
    "https://demo.apps.builderlab.xyz./",
    `https://${"a".repeat(64)}.apps.builderlab.xyz/`,
    `https://demo.apps.${"a".repeat(64)}.builderlabstaging.xyz/`,
    "https://",
    "",
    "not a url",
  ])
    expect(isAppUrl(url), url).toBe(false);
});

it.each(["reserve", "initialize"] as const)(
  "keeps create errors and the recovery app ID readable after %s fails",
  async (step) => {
    const { client, requests } = await setup([
      contract(),
      json(200, {
        app_id: "recovery-app",
        initialize: { required: true, recommended: true },
      }),
      ...(step === "initialize" ? [json(200, { app_id: "recovery-app" })] : []),
      json(503, { error: { message: "gateway unavailable" } }),
    ]);
    await expect(client.create("Demo")).rejects.toThrow(
      `Create stopped during ${step} for app_id=recovery-app: ${step === "reserve" ? "Reserving" : "Initializing"} failed (HTTP 503): gateway unavailable. The reservation may already exist; inspect or resume this exact app before creating a replacement.`,
    );
    expect(requests).toHaveLength(step === "reserve" ? 3 : 4);
  },
);
