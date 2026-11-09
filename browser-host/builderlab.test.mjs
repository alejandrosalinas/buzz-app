import { expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { controlPlane } from "../src/bundled/builderlab/apps/environment";
import {
  BUILDERLAB_ORIGIN,
  bindingEvent,
  builderlabResponseStatus,
  createBuilderlab,
} from "./builderlab.mjs";

const challenge = {
  challenge_id: "0b7e3c1e-7a51-4c4a-9d3e-2f0b8a6c1d22",
  nonce: "a".repeat(43),
  verification_code: "123456",
  origin: BUILDERLAB_ORIGIN,
  expires_at: "2030-01-01T00:00:00Z",
};
const now = Date.parse("2029-12-31T23:59:00Z");

it("signs the kind 24243 binding challenge with the desktop tag set", () => {
  const key = generateSecretKey();
  const event = bindingEvent(key, challenge, now);
  expect(verifyEvent(event)).toBe(true);
  expect(event).toMatchObject({
    kind: 24243,
    content: "",
    pubkey: getPublicKey(key),
    created_at: Math.floor(now / 1000),
  });
  expect(event.tags).toEqual([
    ["challenge_id", challenge.challenge_id],
    ["nonce", challenge.nonce],
    ["verification_code", "123456"],
    ["audience", "buzz:nostr-identity"],
    ["action", "bind_nostr_identity"],
    ["protocol", "buzz-nostr-identity"],
    ["version", "1"],
    ["origin", BUILDERLAB_ORIGIN],
    ["expires_at", challenge.expires_at],
  ]);
});

it.each([
  ["challenge id", { challenge_id: "not-a-uuid" }],
  ["nonce", { nonce: "short" }],
  ["verification code", { verification_code: "12345a" }],
  ["origin", { origin: "https://evil.example" }],
  ["expiry", { expires_at: "2029-12-31T23:00:00Z" }],
])("refuses to sign a challenge with an invalid %s", (_label, patch) => {
  expect(() =>
    bindingEvent(generateSecretKey(), { ...challenge, ...patch }, now),
  ).toThrow("Invalid Nostr identity challenge");
});

function account(responses = {}) {
  const requests = [];
  let opened;
  let didOpen;
  const openedReady = new Promise((resolve) => {
    didOpen = resolve;
  });
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace("/api/goose", "");
    requests.push({ path, url: new URL(url), init });
    const reply = responses[path];
    if (reply) return reply(init);
    if (path === "/v1/auth/login/exchange")
      return Response.json({
        session_credential: "secret",
        expires_at: "2030",
      });
    if (path === "/v1/auth/me")
      return Response.json({
        subject: "auth0|owner",
        email: "a@example.com",
        name: "A",
        expires_at: "2030",
      });
    return Response.json({ ok: true });
  };
  const key = generateSecretKey();
  let signs = 0;
  const builderlab = createBuilderlab({
    key: () => {
      signs += 1;
      return key;
    },
    fetch,
    appsBase: controlPlane(BUILDERLAB_ORIGIN),
    open: async (url) => {
      opened = new URL(url);
      didOpen(opened);
    },
  });
  return {
    builderlab,
    requests,
    key,
    opened: () => opened,
    openedReady,
    signs: () => signs,
  };
}
async function signIn(h) {
  const previous = h.opened();
  // Observe rejection before the callback's network round trip; still propagate it to the caller.
  const pending = h.builderlab.login(new AbortController().signal).then(
    (auth) => ({ auth }),
    (error) => ({ error }),
  );
  await vi.waitFor(() => {
    expect(h.opened()).toBeDefined();
    expect(h.opened()).not.toBe(previous);
  });
  const returnTo = h.opened().searchParams.get("redirect_uri");
  expect(new URL(returnTo).hostname).toBe("127.0.0.1");
  await globalThis.fetch(
    `${returnTo}?state=${h.opened().searchParams.get("state")}&code=one-time`,
  );
  const result = await pending;
  if ("error" in result) throw result.error;
  return result.auth;
}

it("completes browser sign-in through a loopback callback without exposing the credential", async () => {
  const h = account();
  const auth = await signIn(h);
  expect(auth).toEqual({
    subject: "auth0|owner",
    email: "a@example.com",
    name: "A",
    expiresAt: "2030",
    capabilities: {
      can_delete_buzz_communities: false,
      can_use_remote_agents: false,
      can_use_builderlab_decisions: false,
    },
  });
  expect(JSON.stringify(auth)).not.toContain("secret");
  expect(h.opened().pathname).toBe("/api/goose/v1/auth/login");
  expect(h.opened().searchParams.get("product")).toBe("buzz");
  const exchange = JSON.parse(h.requests[0].init.body);
  expect(exchange.code).toBe("one-time");
  const { createHash } = await import("node:crypto");
  expect(
    createHash("sha256").update(exchange.code_verifier).digest("base64url"),
  ).toBe(h.opened().searchParams.get("code_challenge"));
  await h.builderlab.call("list", {});
  expect(h.requests.at(-1).init.headers).toMatchObject({
    "X-BB-Session-Credential": "secret",
    Origin: BUILDERLAB_ORIGIN,
  });
  h.builderlab.signOut();
  expect(await h.builderlab.auth()).toBeNull();
  await expect(h.builderlab.call("list", {})).rejects.toThrow(
    "Sign in to Builderlab first",
  );
});

it("cancels a pending sign-in", async () => {
  const h = account();
  const abort = new AbortController();
  const pending = h.builderlab.login(abort.signal);
  while (!h.opened()) await new Promise((resolve) => setTimeout(resolve, 5));
  abort.abort();
  await expect(pending).rejects.toThrow("canceled");
});

it("forwards only allowlisted fields and ignores unknown actions", async () => {
  const h = account();
  await signIn(h);
  await h.builderlab.call("transfer", {
    communityId: "c1",
    transfereeNpub: "npub1x",
    extra: "dropped",
  });
  expect(h.requests.at(-1).path).toBe("/v1/buzz/communities/transfer");
  expect(JSON.parse(h.requests.at(-1).init.body)).toEqual({
    communityId: "c1",
    transfereeNpub: "npub1x",
  });
  await expect(h.builderlab.call("archive", {})).rejects.toThrow(
    "Missing community_id",
  );
  expect(await h.builderlab.call("toString", {})).toBeUndefined();
  expect(await h.builderlab.call("../auth/me", {})).toBeUndefined();
});

it("forwards the exact deletion tuple for both admission and same-UUID replay", async () => {
  const h = account({
    "/v1/buzz/communities/delete": () =>
      Response.json({ status: "submitted" }, { status: 202 }),
  });
  await signIn(h);
  const request = {
    community_id: "community",
    host: "North.communities.buzz.xyz",
    request_id: "11111111-1111-4111-8111-111111111111",
    acknowledgement_version: 1,
    owner_pubkey: "must-not-pass",
    extra: "dropped",
  };
  const admitted = await h.builderlab.call("delete", request);
  expect(builderlabResponseStatus(admitted)).toBe(202);
  expect(h.requests.at(-1).path).toBe("/v1/buzz/communities/delete");
  expect(JSON.parse(h.requests.at(-1).init.body)).toEqual({
    community_id: request.community_id,
    host: request.host,
    request_id: request.request_id,
    acknowledgement_version: 1,
  });
  const replay = await h.builderlab.call("delete", request);
  expect(builderlabResponseStatus(replay)).toBe(202);
  expect(h.requests.at(-1).path).toBe("/v1/buzz/communities/delete");
  expect(JSON.parse(h.requests.at(-1).init.body)).toEqual({
    community_id: request.community_id,
    host: request.host,
    request_id: request.request_id,
    acknowledgement_version: 1,
  });
  expect(
    h.requests.filter((item) => item.path === "/v1/buzz/communities/delete"),
  ).toHaveLength(2);
});

it("does not expose a removed deletion receipt action", async () => {
  const h = account({});
  expect(await h.builderlab.call("delete-receipt", {})).toBeUndefined();
  expect(h.requests).toHaveLength(0);
});

it.each([
  [true, true],
  ["true", false],
  [1, false],
  [undefined, false],
])("maps delete capability %j to literal true=%s", async (value, expected) => {
  const h = account({
    "/v1/auth/me": () =>
      Response.json({
        subject: "auth0|owner",
        email: "a@example.com",
        expires_at: "2030",
        capabilities: { can_delete_buzz_communities: value },
      }),
  });
  expect((await signIn(h)).capabilities).toEqual({
    can_delete_buzz_communities: expected,
    can_use_remote_agents: false,
    can_use_builderlab_decisions: false,
  });
});

it.each([
  ["malformed", "{"],
  ["oversize", JSON.stringify({ value: "x".repeat(70_000) })],
])("rejects a %s downstream response after dispatch", async (_label, body) => {
  const h = account({
    "/v1/buzz/communities/delete": () =>
      new Response(body, {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
  });
  await signIn(h);
  await expect(
    h.builderlab.call("delete", {
      community_id: "community",
      host: "north.communities.buzz.xyz",
      request_id: "11111111-1111-4111-8111-111111111111",
      acknowledgement_version: 1,
    }),
  ).rejects.toThrow(/invalid response|too large/);
});

it("binds the local key by verifying a signed challenge and passes structured errors through", async () => {
  const h = account({
    "/v1/buzz/nostr-identities/challenge": () =>
      Response.json({ ...challenge, expires_at: "2099-01-01T00:00:00Z" }),
    "/v1/buzz/nostr-identities/verify": () =>
      Response.json({ identity: { pubkey_hex: "ok" } }),
    "/v1/buzz/communities": () =>
      Response.json({ error: { code: "taken" } }, { status: 409 }),
  });
  await signIn(h);
  expect(await h.builderlab.bind()).toEqual({ identity: { pubkey_hex: "ok" } });
  const verify = JSON.parse(h.requests.at(-1).init.body);
  const signed = JSON.parse(verify.signed_payload);
  expect(verifyEvent(signed)).toBe(true);
  expect(signed.pubkey).toBe(getPublicKey(h.key));
  expect(await h.builderlab.call("create", { name: "north" })).toEqual({
    error: { code: "taken" },
  });
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it.each(["held", "rejected"])(
  "logs out a replaced credential without blocking login on a %s upstream logout",
  async (outcome) => {
    const release = deferred();
    const finished = deferred();
    const h = account({
      "/v1/auth/logout": async () => {
        try {
          await release.promise;
          if (outcome === "rejected") throw new Error("Logout unavailable");
          return Response.json({});
        } finally {
          finished.resolve();
        }
      },
    });
    await signIn(h);
    const before = h.opened();
    const states = [];
    const stop = h.builderlab.subscribe((state) => states.push(state));
    const abort = new AbortController();
    const login = h.builderlab.login(abort.signal).catch((error) => error);
    try {
      expect(
        h.requests.filter(({ path }) => path === "/v1/auth/logout"),
      ).toMatchObject([
        {
          init: {
            method: "POST",
            headers: { "X-BB-Session-Credential": "secret" },
            redirect: "error",
          },
        },
      ]);
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({ pending: true, auth: null });
      // Opening the replacement browser does not wait for upstream revocation.
      await vi.waitFor(() => expect(h.opened()).not.toBe(before));
      release.resolve();
      await finished.promise;
      expect(h.builderlab.snapshot()).toMatchObject({
        pending: true,
        auth: null,
      });
      expect(h.builderlab.snapshot()).not.toHaveProperty("error");
    } finally {
      release.resolve();
      abort.abort();
      await login;
      stop();
      h.builderlab.signOut();
    }
  },
);

it.each(["cancel", "sign-out"])(
  "a %s during a held code exchange never restores the session",
  async (mode) => {
    const started = deferred();
    const release = deferred();
    const h = account({
      "/v1/auth/login/exchange": async () => {
        started.resolve();
        await release.promise;
        return Response.json({
          session_credential: "late",
          expires_at: "2030",
        });
      },
    });
    const abort = new AbortController();
    const pending = h.builderlab.login(abort.signal).catch((error) => error);
    while (!h.opened()) await new Promise((resolve) => setTimeout(resolve, 5));
    await globalThis.fetch(
      `${h.opened().searchParams.get("redirect_uri")}?state=${h.opened().searchParams.get("state")}&code=x`,
    );
    await started.promise;
    if (mode === "cancel") abort.abort();
    else h.builderlab.signOut();
    release.resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(h.builderlab.snapshot()).not.toHaveProperty("error");
    expect(await h.builderlab.auth()).toBeNull();
    await expect(h.builderlab.call("list", {})).rejects.toThrow(
      "Sign in to Builderlab first",
    );
  },
);

it.each(["error", "success"])(
  "a stale account check (%s) cannot clear or describe a newer session",
  async (outcome) => {
    const started = deferred();
    const release = deferred();
    let hold = false;
    const h = account({
      "/v1/auth/login/exchange": (init) =>
        Response.json({
          session_credential: JSON.parse(init.body).code,
          expires_at: "2030",
        }),
      "/v1/auth/me": async (init) => {
        const session = init.headers["X-BB-Session-Credential"];
        if (session === "A" && hold) {
          started.resolve();
          await release.promise;
          if (outcome === "error") return Response.json({}, { status: 401 });
        }
        return Response.json({
          subject: session,
          email: session,
          expires_at: "2030",
        });
      },
    });
    const signInAs = async (code) => {
      const before = h.opened();
      const pending = h.builderlab.login(new AbortController().signal);
      while (h.opened() === before)
        await new Promise((resolve) => setTimeout(resolve, 5));
      await globalThis.fetch(
        `${h.opened().searchParams.get("redirect_uri")}?state=${h.opened().searchParams.get("state")}&code=${code}`,
      );
      return pending;
    };
    await signInAs("A");
    hold = true;
    const stale = h.builderlab.auth().catch((error) => error);
    await started.promise;
    h.builderlab.signOut();
    await signInAs("B");
    release.resolve();
    expect(await stale).toBeInstanceOf(Error);
    expect(await h.builderlab.auth()).toMatchObject({ email: "B" });
  },
);

it.each(["sign-out", "new-login"])(
  "a %s during a held binding challenge never signs or verifies",
  async (mode) => {
    const started = deferred();
    const release = deferred();
    const h = account({
      "/v1/buzz/nostr-identities/challenge": async () => {
        started.resolve();
        await release.promise;
        return Response.json({
          ...challenge,
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    });
    await signIn(h);
    const pending = h.builderlab.bind().catch((error) => error);
    await started.promise;
    if (mode === "sign-out") h.builderlab.signOut();
    else h.builderlab.login(new AbortController().signal).catch(() => {});
    release.resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(h.signs()).toBe(0);
    expect(
      h.requests.some(
        ({ path }) => path === "/v1/buzz/nostr-identities/verify",
      ),
    ).toBe(false);
    h.builderlab.signOut();
  },
);

it("rejects malformed and wrong callbacks without ending the listener", async () => {
  const h = account();
  const pending = h.builderlab.login(new AbortController().signal);
  while (!h.opened()) await new Promise((resolve) => setTimeout(resolve, 5));
  const returnTo = new URL(h.opened().searchParams.get("redirect_uri"));
  const { request } = await import("node:http");
  const raw = (path) =>
    new Promise((resolve, reject) =>
      request({ host: "127.0.0.1", port: returnTo.port, path }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
        .on("error", reject)
        .end(),
    );
  expect(await raw("//[")).toBe(400);
  expect(await raw("/callback/wrong?code=x")).toBe(404);
  await globalThis.fetch(
    `${returnTo}?state=${h.opened().searchParams.get("state")}&code=one-time`,
  );
  expect(await pending).toMatchObject({ email: "a@example.com" });
});

it("keeps one public server revision for agents, Apps and reloaded clients, and never forwards caller credentials", async () => {
  const h = account({
    "/v3/beekeeper/list-agents": () => Response.json({ status: 1, agents: [] }),
    "/v1/agent/apps": () => Response.json({ apps: [] }),
  });
  const states = [];
  const stop = h.builderlab.subscribe((state) => states.push(state));
  await signIn(h);
  const signedIn = h.builderlab.snapshot();
  expect(signedIn).toMatchObject({
    pending: false,
    auth: { subject: "auth0|owner" },
  });
  expect(JSON.stringify(states)).not.toContain("secret");
  const revision = signedIn.revision;
  await h.builderlab.request(
    {
      revision,
      path: "/v3/beekeeper/list-agents",
      method: "POST",
      body: "{}",
      headers: { "X-BB-Session-Credential": "untrusted" },
    },
    new AbortController().signal,
  );
  expect(h.requests.at(-1).init.headers["X-BB-Session-Credential"]).toBe(
    "secret",
  );
  await h.builderlab.request(
    { revision, target: "apps", path: "/v1/agent/apps?scope=owned" },
    new AbortController().signal,
  );
  expect(h.requests.at(-1).init.headers.Authorization).toBe(
    "BBIdentity secret",
  );
  await expect(h.builderlab.auth()).resolves.toMatchObject({
    subject: "auth0|owner",
  });
  expect(h.builderlab.snapshot().revision).toBe(revision);
  h.builderlab.signOut();
  await expect(
    h.builderlab.request(
      { revision, path: "/v3/beekeeper/list-agents" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("session changed");
  expect(states.at(-1).auth).toBeNull();
  stop();
});

it("expires every consumer together on 401, while a transient account check preserves the server login", async () => {
  let unavailable = false;
  const h = account({
    "/v1/auth/me": () =>
      unavailable
        ? Promise.reject(new Error("offline"))
        : Response.json({ subject: "owner", expires_at: "2030" }),
    "/v3/beekeeper/list-agents": () => Response.json({}, { status: 401 }),
  });
  await signIn(h);
  const revision = h.builderlab.snapshot().revision;
  unavailable = true;
  await expect(h.builderlab.auth()).rejects.toThrow("offline");
  expect(h.builderlab.snapshot().revision).toBe(revision);
  const reply = await h.builderlab.request(
    { revision, path: "/v3/beekeeper/list-agents", method: "POST", body: "{}" },
    new AbortController().signal,
  );
  expect(reply.status).toBe(401);
  expect(h.builderlab.snapshot()).toMatchObject({ auth: null, pending: false });
});

it("keeps the shared login and agent requests working after an Apps 401", async () => {
  const h = account({
    "/v1/agent/apps": () => Response.json({}, { status: 401 }),
    "/v3/beekeeper/list-agents": () => Response.json({ agents: [] }),
  });
  await signIn(h);
  const before = h.builderlab.snapshot();
  const signal = new AbortController().signal;
  expect(
    await h.builderlab.request(
      { revision: before.revision, target: "apps", path: "/v1/agent/apps" },
      signal,
    ),
  ).toMatchObject({ status: 401 });
  expect(h.builderlab.snapshot()).toEqual(before);
  expect(
    await h.builderlab.request(
      {
        revision: before.revision,
        path: "/v3/beekeeper/list-agents",
        method: "POST",
        body: "{}",
      },
      signal,
    ),
  ).toMatchObject({ status: 200 });
  h.builderlab.signOut();
});

it("preserves encoded Apps IDs and query values after resolving the allowed URL", async () => {
  const h = account();
  await signIn(h);
  const path =
    "/v1/agent/apps/app/communities/" +
    encodeURIComponent("community:id") +
    "?" +
    new URLSearchParams({ version_id: "version/id with spaces" });
  await h.builderlab.request(
    { revision: h.builderlab.snapshot().revision, target: "apps", path },
    new AbortController().signal,
  );
  expect(h.requests.at(-1).url.href).toBe(
    `${controlPlane(BUILDERLAB_ORIGIN)}${path}`,
  );
  h.builderlab.signOut();
});

it.each([
  "/v1/auth/login/exchange",
  "/v1/auth/me",
  "/v1/buzz/communities/list",
  "/v1/buzz/nostr-identities/current",
  "//evil.example/",
  "/v3/beekeeper/../auth/me",
  "/v3/beekeeper/%2e%2e/auth/me",
  "/v1/auth/hosted-site/native-session",
  "/v3/builderlab/decisions",
  "/v3/beekeeper/../../../../v1/auth/me",
])("refuses proxy path %s before dispatch", async (path) => {
  const h = account();
  await signIn(h);
  const count = h.requests.length;
  await expect(
    h.builderlab.request(
      { revision: h.builderlab.snapshot().revision, path },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Unsupported");
  expect(h.requests).toHaveLength(count);
  h.builderlab.signOut();
});

it("ends the shared session at its advertised expiry", async () => {
  const expires = new Date(Date.now() + 60_000).toISOString();
  const h = account({
    "/v1/auth/login/exchange": () =>
      Response.json({ session_credential: "secret", expires_at: expires }),
    "/v1/auth/me": () =>
      Response.json({ subject: "owner", expires_at: expires }),
  });
  const login = h.builderlab.login(new AbortController().signal);
  while (!h.opened()) await new Promise((resolve) => setTimeout(resolve, 5));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    await globalThis.fetch(
      `${h.opened().searchParams.get("redirect_uri")}?state=${h.opened().searchParams.get("state")}&code=expiry`,
    );
    await login;
    expect(h.builderlab.snapshot().auth).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.builderlab.snapshot()).toMatchObject({
      auth: null,
      pending: false,
    });
    expect(await h.builderlab.auth()).toBeNull();
  } finally {
    vi.useRealTimers();
    h.builderlab.signOut();
  }
});

it("forwards native-validated Decisions through the same server session and community", async () => {
  const h = account();
  await signIn(h);
  await h.builderlab.request(
    {
      revision: h.builderlab.snapshot().revision,
      path: "/v3/builderlab/decisions",
      method: "POST",
      community: "buzz.example.com",
      body: "{}",
    },
    new AbortController().signal,
    true,
  );
  expect(h.requests.at(-1).init.headers).toMatchObject({
    "X-BB-Session-Credential": "secret",
    "X-Buzz-Community": "buzz.example.com",
  });
  await expect(
    h.builderlab.request(
      {
        revision: h.builderlab.snapshot().revision,
        path: "/v3/builderlab/decisions",
        method: "POST",
        community: "x\r\nforged",
        body: "{}",
      },
      new AbortController().signal,
      true,
    ),
  ).rejects.toThrow("Invalid decision community");
  h.builderlab.signOut();
});

it("requires the agents OAuth state and reuses their branded callback page", async () => {
  const h = account();
  const login = h.builderlab.login(new AbortController().signal);
  const opened = await h.openedReady;
  const callback = opened.searchParams.get("redirect_uri");
  expect(
    (await globalThis.fetch(`${callback}?state=wrong&code=x`)).status,
  ).toBe(400);
  const response = await globalThis.fetch(
    `${callback}?state=${opened.searchParams.get("state")}&code=x`,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(response.headers.get("content-security-policy")).toContain(
    "script-src 'sha256-",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  await login;
  h.builderlab.signOut();
  expect(body).toContain("Signing you in…");
  expect(body).toContain("<title>Builderlab sign-in</title>");
  expect(body).toContain('data-provider="Builderlab"');
  expect(body).toContain('class="brand" role="img" aria-label="Builderlab"');
  expect(body).toContain('src="data:image/webp;base64,');
  expect(body).toContain('id="closing-hint"');
  expect(body).toContain('id="close-hint">You can close this window.</span>');
  expect(body).not.toContain("{{");
});

it.each(["secret\ncredential", "secret credential"])(
  "refuses unsafe credential bytes before any authenticated request",
  async (session_credential) => {
    const h = account({
      "/v1/auth/login/exchange": () =>
        Response.json({ session_credential, expires_at: "2030" }),
    });
    await expect(signIn(h)).rejects.toThrow("empty credential");
    expect(h.requests.map((entry) => entry.path)).not.toContain("/v1/auth/me");
    expect(h.builderlab.snapshot().auth).toBeNull();
  },
);

it("settles the sign-in identity binding before dispatching remote-agent operations", async () => {
  const started = deferred();
  const release = deferred();
  let released = false;
  const h = account({
    "/v1/buzz/nostr-identities/challenge": async () => {
      started.resolve();
      await release.promise;
      return Response.json({
        ...challenge,
        expires_at: "2099-01-01T00:00:00Z",
      });
    },
    "/v3/beekeeper/list-agents": () => {
      expect(released).toBe(true);
      return Response.json({ status: 1, agents: [] });
    },
  });
  await signIn(h);
  await started.promise;
  const request = h.builderlab.request(
    {
      revision: h.builderlab.snapshot().revision,
      path: "/v3/beekeeper/list-agents",
      method: "POST",
      body: "{}",
    },
    new AbortController().signal,
  );
  released = true;
  release.resolve();
  await expect(request).resolves.toMatchObject({ status: 200 });
  h.builderlab.signOut();
});

it("announces a new sign-in atomically as pending, without canceling observers", async () => {
  const h = account();
  const states = [];
  const stop = h.builderlab.subscribe((state) => states.push(state));
  const login = h.builderlab.login(new AbortController().signal);
  const authorization = await h.openedReady;
  expect(states).toHaveLength(1);
  expect(states[0]).toMatchObject({ pending: true, auth: null });
  await globalThis.fetch(
    `${authorization.searchParams.get("redirect_uri")}?code=fixture&state=${authorization.searchParams.get("state")}`,
  );
  await login;
  expect(states.at(-1)).toMatchObject({
    pending: false,
    auth: { subject: "auth0|owner" },
  });
  stop();
  h.builderlab.signOut();
});

it.each(["sign-out", "account-switch", "disconnect"])(
  "preserves a dispatched Apps upload across %s while retaining disconnect cancellation",
  async (mode) => {
    const directory = await mkdtemp(
      join(await realpath(homedir()), ".buzz-upload-test-"),
    );
    const file = join(directory, "artifact.tar.gz");
    await writeFile(file, "fixture archive");
    const accepted = deferred();
    const release = deferred();
    const receipt = { version_id: "version-A", deployment_id: "deployment-A" };
    const h = account({
      "/v1/agent/apps/demo/deploy": (init) => {
        accepted.resolve(init);
        return {
          status: 201,
          async text() {
            await release.promise;
            init.signal.throwIfAborted();
            return JSON.stringify(receipt);
          },
        };
      },
    });
    const caller = new AbortController();
    try {
      await signIn(h);
      const pending = h.builderlab
        .request(
          {
            revision: h.builderlab.snapshot().revision,
            target: "apps",
            path: "/v1/agent/apps/demo/deploy",
            method: "POST",
            file,
          },
          caller.signal,
        )
        .then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
      const upstream = await accepted.promise;
      expect(upstream.headers.Authorization).toBe("BBIdentity secret");
      if (mode === "disconnect") caller.abort();
      else {
        h.builderlab.signOut();
        if (mode === "account-switch") {
          const before = h.opened();
          const login = h.builderlab.login(new AbortController().signal);
          await vi.waitFor(() => expect(h.opened()).not.toBe(before));
          await globalThis.fetch(
            `${h.opened().searchParams.get("redirect_uri")}?state=${h.opened().searchParams.get("state")}&code=replacement`,
          );
          await login;
        }
      }
      expect(upstream.signal.aborted).toBe(mode === "disconnect");
      release.resolve();
      const outcome = await pending;
      if (mode === "disconnect") expect(outcome.error?.name).toBe("AbortError");
      else {
        expect(outcome.result?.status).toBe(201);
        expect(JSON.parse(outcome.result.body)).toEqual(receipt);
      }
    } finally {
      release.resolve();
      h.builderlab.signOut();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("publishes login failures in the shared revision and clears them on a new attempt or sign-out", async () => {
  const h = account({
    "/v1/auth/login/exchange": () => Response.json({}, { status: 503 }),
  });
  const states = [];
  const stop = h.builderlab.subscribe((state) => states.push(state));
  try {
    await expect(signIn(h)).rejects.toThrow(
      "code exchange failed with HTTP 503",
    );
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({ pending: true, auth: null });
    expect(states[1]).toMatchObject({
      pending: false,
      auth: null,
      error: "Builderlab code exchange failed with HTTP 503",
    });
    expect(states[1].revision).not.toBe(states[0].revision);
    const before = h.opened();
    const replacement = h.builderlab
      .login(new AbortController().signal)
      .catch((error) => error);
    await vi.waitFor(() => expect(h.opened()).not.toBe(before));
    expect(h.builderlab.snapshot()).toMatchObject({
      pending: true,
      auth: null,
    });
    expect(h.builderlab.snapshot()).not.toHaveProperty("error");
    h.builderlab.signOut();
    await replacement;
    expect(h.builderlab.snapshot()).toMatchObject({
      pending: false,
      auth: null,
    });
    expect(h.builderlab.snapshot()).not.toHaveProperty("error");
  } finally {
    stop();
    h.builderlab.signOut();
  }
});

it("redacts the login credential before publishing a shared failure or returning it to HTTP", async () => {
  const h = account({
    "/v1/auth/me": () => {
      throw new Error("Could not check secret");
    },
  });
  try {
    await expect(signIn(h)).rejects.toThrow("Could not check [redacted]");
    expect(h.builderlab.snapshot().error).toBe("Could not check [redacted]");
    expect(JSON.stringify(h.builderlab.snapshot())).not.toContain("secret");
  } finally {
    h.builderlab.signOut();
  }
});

it("keeps the broker sign-in and account projection when a capability-only check is refused", async () => {
  let status = 200;
  let invalid = false;
  const h = account({
    "/v1/auth/me": () =>
      Response.json(
        invalid
          ? []
          : {
              subject: "user",
              email: "a@example.org",
              expires_at: "2030",
              capabilities: { can_use_remote_agents: true },
            },
        { status },
      ),
  });
  await signIn(h);
  const previous = h.builderlab.snapshot();
  status = 401;
  await expect(h.builderlab.capabilities(previous.revision)).rejects.toThrow(
    "HTTP 401",
  );
  expect(h.builderlab.snapshot()).toEqual({
    ...previous,
    capabilitiesCheckedAt: expect.any(Number),
  });
  status = 200;
  invalid = true;
  await expect(h.builderlab.capabilities(previous.revision)).rejects.toThrow(
    "invalid capabilities",
  );
  expect(h.builderlab.snapshot()).toEqual({
    ...previous,
    capabilitiesCheckedAt: expect.any(Number),
  });
  invalid = false;
  await expect(h.builderlab.capabilities(previous.revision)).resolves.toEqual({
    revision: previous.revision,
    capabilities: {
      can_use_remote_agents: true,
      can_use_builderlab_decisions: false,
      can_delete_buzz_communities: false,
    },
  });
  expect(h.builderlab.snapshot()).toEqual({
    ...previous,
    capabilitiesCheckedAt: expect.any(Number),
  });
  h.builderlab.signOut();
});

it("retains refreshed flags and their age for reloaded pages without changing the sign-in profile", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let granted = false;
  const held = Promise.withResolvers();
  const started = Promise.withResolvers();
  let pending;
  let restored;
  const h = account({
    "/v1/auth/me": async () => {
      if (granted) {
        started.resolve();
        await held.promise;
      }
      return Response.json({
        subject: granted ? "replacement-profile" : "original",
        email: granted ? "changed@example.org" : "original@example.org",
        name: granted ? "Changed" : "Original",
        expires_at: "2030",
        capabilities: { can_use_remote_agents: granted },
      });
    },
  });
  try {
    await signIn(h);
    const before = h.builderlab.snapshot();
    granted = true;
    now += 60_000;
    const checkedAt = now;
    pending = h.builderlab.capabilities(before.revision);
    await started.promise;
    // A page restoring mid-read must see an expired cache and join this request.
    expect(h.builderlab.snapshot()).toEqual(before);
    restored = h.builderlab.capabilities(before.revision);
    now += 1_000;
    held.resolve();
    await Promise.all([pending, restored]);
    expect(
      h.requests.filter((request) => request.path === "/v1/auth/me"),
    ).toHaveLength(2);
    expect(h.builderlab.snapshot()).toMatchObject({
      revision: before.revision,
      capabilitiesCheckedAt: checkedAt,
      auth: {
        subject: "original",
        email: "original@example.org",
        name: "Original",
        expiresAt: "2030",
        capabilities: { can_use_remote_agents: true },
      },
    });
  } finally {
    held.resolve();
    await Promise.allSettled([pending, restored]);
    h.builderlab.signOut();
    clock.mockRestore();
  }
});

it("rejects a stale page before joining a replacement account's capability read and fences old cleanup", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let subject = "A";
  let held;
  const first = {
    started: Promise.withResolvers(),
    reply: Promise.withResolvers(),
  };
  const second = {
    started: Promise.withResolvers(),
    reply: Promise.withResolvers(),
  };
  const h = account({
    "/v1/auth/me": () => {
      if (held) {
        const read = held;
        held = undefined;
        read.started.resolve();
        return read.reply.promise;
      }
      return Response.json({ subject, expires_at: "2030" });
    },
  });
  const pending = [];
  try {
    await signIn(h);
    const oldRevision = h.builderlab.snapshot().revision;
    now += 60_000;
    held = first;
    const old = h.builderlab.capabilities(oldRevision);
    const rejected = expect(old).rejects.toThrow("session changed");
    pending.push(rejected);
    await first.started.promise;
    subject = "B";
    now += 1_000;
    await signIn(h);
    const before = h.builderlab.snapshot();
    now += 60_000;
    held = second;
    const current = h.builderlab.capabilities(before.revision);
    pending.push(current);
    await second.started.promise;
    const stale = h.builderlab.capabilities(oldRevision).then(
      () => "accepted",
      (error) => error.message,
    );
    pending.push(stale);
    first.reply.resolve(
      Response.json({ capabilities: { can_use_remote_agents: false } }),
    );
    await rejected;
    expect(h.builderlab.snapshot()).toEqual(before);
    const joined = h.builderlab.capabilities(before.revision);
    pending.push(joined);
    second.reply.resolve(
      Response.json({ capabilities: { can_use_remote_agents: true } }),
    );
    await Promise.all([current, joined]);
    await expect(stale).resolves.toBe("Builderlab session changed");
    expect(
      h.requests.filter((request) => request.path === "/v1/auth/me"),
    ).toHaveLength(4);
    expect(h.builderlab.snapshot()).toMatchObject({
      revision: before.revision,
      auth: { subject: "B", capabilities: { can_use_remote_agents: true } },
    });
  } finally {
    first.reply.resolve(Response.json({}));
    second.reply.resolve(Response.json({}));
    await Promise.allSettled(pending);
    h.builderlab.signOut();
    clock.mockRestore();
  }
});
