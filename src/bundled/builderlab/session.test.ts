import { expect, it, vi } from "vitest";
import { federatedFixture } from "../../features/federated-identity/testing";
import { deferred } from "./test-helpers";
import type { HostResponse } from "../../features/host/service";
import {
  createNativeSession,
  followCommunity,
  sessionSite,
  type BuilderlabSession,
} from "./session";

const fresh = (session: BuilderlabSession) =>
  session.freshCredential(new AbortController().signal).then(
    () => {},
    () => {},
  );

const me = (subject: string) => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    subject,
    email: ` ${subject}@example.com `,
    capabilities: { can_use_remote_agents: true },
  }),
});

it("reads each native session's account once and fences requests and viewers to it", async () => {
  const h = federatedFixture();
  h.request.mockResolvedValueOnce(me("first"));
  const session = createNativeSession(h.service);
  expect(session.providerName).toBe("builderlab.example");
  expect(session.snapshot().status).toBe("signed-out");
  await session.signIn();
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  expect(session.snapshot().account).toEqual({
    subject: "first",
    email: "first@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: false,
  });
  expect(h.request).toHaveBeenLastCalledWith({
    path: "/api/goose/v1/auth/me",
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const first = session.credential();
  const viewer = session.viewerSession();
  expect(viewer).toMatchObject({ federated: "user:1" });
  expect(viewer.storage).toMatch(/^builderlab-[0-9a-f]{32}$/);
  h.request.mockResolvedValueOnce({ status: 200, headers: {}, body: "{}" });
  await session.request(first, { path: "/v1/buzz/communities/list" });
  expect(h.request).toHaveBeenLastCalledWith({
    path: "/api/goose/v1/buzz/communities/list",
  });

  h.request.mockResolvedValueOnce(me("second"));
  h.publish({ revision: "user:2" });
  expect(viewer.signal.aborted).toBe(true);
  await expect.poll(() => session.snapshot().account?.subject).toBe("second");
  await expect(session.request(first, { path: "/v1/auth/me" })).rejects.toThrow(
    "session changed",
  );
  expect(session.viewerSession()).toMatchObject({ federated: "user:2" });
  session.signOut();
  await expect.poll(() => session.snapshot().status).toBe("signed-out");
  expect(() => session.credential()).toThrow("Sign in to Builderlab first.");
  expect(h.request).toHaveBeenCalledTimes(3);
  session.dispose();
});

it("fails closed when the account cannot be read and retries on sign-in", async () => {
  const h = federatedFixture();
  h.request.mockResolvedValueOnce({ status: 403, headers: {}, body: "{}" });
  h.publish({ status: "signed-in", revision: "user:1" });
  const session = createNativeSession(h.service);
  await expect
    .poll(() => session.snapshot())
    .toEqual({
      status: "signed-out",
      error: "Could not load your Builderlab account. Try again.",
    });
  h.request.mockResolvedValueOnce(me("user"));
  await session.signIn();
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  expect(h.service.signIn).not.toHaveBeenCalled();
  session.dispose();
});

it("joins the shared native sign-in and leaves it running when a view closes", async () => {
  const h = federatedFixture();
  h.publish({ status: "signing-in" });
  const session = createNativeSession(h.service);
  expect(session.snapshot().status).toBe("pending");
  const joined = session.ensureSignedIn(new AbortController().signal);
  session.abandon();
  expect(h.service.cancelSignIn).not.toHaveBeenCalled();
  h.request.mockResolvedValueOnce(me("user"));
  h.publish({ status: "signed-in", revision: "user:1" });
  await expect(joined).resolves.toBeUndefined();
  expect(h.service.signIn).not.toHaveBeenCalled();
  session.cancel();
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  session.dispose();
});

it("settles a sign-in wait when native sign-in leaves the session unchanged", async () => {
  const h = federatedFixture();
  h.publish({ status: "unavailable", failure: "native-unavailable" });
  // Native returns the same snapshot, as it does before restore finishes.
  vi.mocked(h.service.signIn).mockImplementationOnce(async () =>
    h.service.snapshot(),
  );
  const session = createNativeSession(h.service);
  await expect(
    session.ensureSignedIn(new AbortController().signal),
  ).rejects.toThrow("Builderlab sign-in did not finish. Try again.");
  expect(h.service.signIn).toHaveBeenCalledOnce();
  session.dispose();
});

it("shows a session the adapter ended as signed out, asking to sign in again", async () => {
  const h = federatedFixture();
  h.request.mockResolvedValueOnce(me("user"));
  h.publish({ status: "signed-in", revision: "user:1" });
  const session = createNativeSession(h.service);
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  h.publish({
    status: "reauthentication-required",
    revision: "user:2",
    failure: "reauthentication-required",
  });
  expect(session.snapshot()).toEqual({
    status: "signed-out",
    error: "Your Builderlab sign-in ended. Sign in again.",
  });
  session.dispose();
});

it("keeps permissions at most a minute old as the session is read, without retiring the sign-in", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const h = federatedFixture();
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  h.request.mockResolvedValueOnce({
    ...me("user"),
    body: JSON.stringify({
      ...JSON.parse(me("user").body),
      name: "Original",
      expires_at: "2030",
    }),
  });
  const session = createNativeSession(h.service);
  try {
    await session.signIn();
    await expect.poll(() => session.snapshot().status).toBe("signed-in");
    const credential = session.credential();
    const viewer = session.viewerSession();
    const notifications = vi.fn();
    session.subscribe(notifications);
    now += 59_999;
    expect(session.snapshot().checkingPermissions).toBeUndefined();
    await fresh(session);
    expect(h.request).toHaveBeenCalledTimes(1);
    now += 1;
    const held = deferred<HostResponse>();
    h.request.mockReturnValueOnce(held.promise);
    // Reading starts the check; acting waits for it. Both share one request.
    expect(session.snapshot()).toMatchObject({
      checkingPermissions: true,
      account: { canUseRemoteAgents: true },
    });
    const acting = session.freshCredential(new AbortController().signal);
    expect(h.request).toHaveBeenCalledTimes(2);
    await expect.poll(() => notifications.mock.calls.length).toBe(1);
    held.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({
        subject: "different",
        email: "changed@example.org",
        name: "Changed",
        expires_at: "2040",
        capabilities: {
          can_use_remote_agents: false,
          can_use_builderlab_decisions: true,
          can_delete_buzz_communities: true,
        },
      }),
    });
    await expect(acting).resolves.toBe(credential);
    expect(session.snapshot()).toEqual({
      status: "signed-in",
      account: {
        name: "Original",
        expiresAt: "2030",
        subject: "user",
        email: "user@example.com",
        canUseRemoteAgents: false,
        canUseBuilderlabDecisions: true,
      },
    });
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(credential.account).toBe(session.snapshot().account);
    expect(session.viewerSession()).toBe(viewer);
    expect(viewer.signal.aborted).toBe(false);
    expect(notifications).toHaveBeenCalledTimes(2);
  } finally {
    session.dispose();
    clock.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("rejects a wait for fresh permissions when its signal aborts, leaving the check running", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const h = federatedFixture();
  h.request.mockResolvedValueOnce(me("user"));
  const session = createNativeSession(h.service);
  try {
    await session.signIn();
    await expect.poll(() => session.snapshot().status).toBe("signed-in");
    now += 60_000;
    const held = deferred<HostResponse>();
    h.request.mockReturnValueOnce(held.promise);
    const abort = new AbortController();
    const waiting = session.freshCredential(abort.signal);
    abort.abort(new DOMException("Stopped", "AbortError"));
    await expect(waiting).rejects.toThrow("Stopped");
    expect(session.snapshot().checkingPermissions).toBe(true);
    held.resolve(me("user"));
    await expect
      .poll(() => session.snapshot().checkingPermissions)
      .toBeUndefined();
  } finally {
    session.dispose();
    clock.mockRestore();
  }
});

it.each(["HTTP 401", "HTTP 503", "network", "JSON", "shape"])(
  "keeps cached permissions after a failed %s refresh and waits a minute before retrying",
  async (failure) => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = federatedFixture();
    h.request.mockResolvedValueOnce(me("user"));
    const session = createNativeSession(h.service);
    try {
      await session.signIn();
      await expect.poll(() => session.snapshot().status).toBe("signed-in");
      const previous = session.snapshot();
      now += 60_000;
      if (failure === "network")
        h.request.mockRejectedValueOnce(new Error("Offline"));
      else
        h.request.mockResolvedValueOnce({
          status:
            failure === "HTTP 401" ? 401 : failure === "HTTP 503" ? 503 : 200,
          headers: {},
          body:
            failure === "JSON"
              ? "{"
              : failure === "shape"
                ? '{"capabilities":[]}'
                : "{}",
        });
      await fresh(session);
      expect(session.snapshot()).toEqual(previous);
      now += 59_999;
      await fresh(session);
      expect(h.request).toHaveBeenCalledTimes(2);
      now += 1;
      h.request.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: '{"capabilities":{"can_use_remote_agents":false}}',
      });
      await fresh(session);
      expect(h.request).toHaveBeenCalledTimes(3);
      expect(session.snapshot().account?.canUseRemoteAgents).toBe(false);
    } finally {
      session.dispose();
      clock.mockRestore();
    }
  },
);

it.each(["sign-out", "new-login", "dispose"])(
  "discards a capability response after %s",
  async (action) => {
    const h = federatedFixture();
    h.request.mockResolvedValueOnce(me("first"));
    const session = createNativeSession(h.service);
    await session.signIn();
    await expect.poll(() => session.snapshot().status).toBe("signed-in");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const held = deferred<HostResponse>();
    h.request.mockReturnValueOnce(held.promise);
    const checking = fresh(session);
    try {
      if (action === "dispose") session.dispose();
      else session.signOut();
      if (action === "new-login") {
        h.request.mockResolvedValueOnce(me("second"));
        await session.signIn();
        await expect
          .poll(() => session.snapshot().account?.subject)
          .toBe("second");
      }
      const previous = session.snapshot();
      held.resolve({
        status: 200,
        headers: {},
        body: '{"capabilities":{"can_use_remote_agents":false,"can_use_builderlab_decisions":true}}',
      });
      await checking;
      expect(session.snapshot()).toBe(previous);
    } finally {
      held.resolve(me("first"));
      await checking;
      session.dispose();
      clock.mockRestore();
    }
  },
);

it("follows the selected community to its own sign-in server, else the build's", async () => {
  const build = federatedFixture("build");
  const peer = federatedFixture("peer");
  const authority = peer.service.snapshot().authority;
  if (!authority) throw new Error("Missing fixture authority");
  // Two servers of one organization.
  build.publish({ authority: { ...authority, organization: "Example" } });
  peer.publish({
    authority: {
      ...authority,
      id: "peer",
      identityOrigin: "https://peer.example",
      apiBasePath: "/goose/",
      organization: "Example",
    },
  });
  const forCommunity = vi.fn((origin: string) =>
    origin === "wss://team.peer.example" ? peer.service : build.service,
  );
  const identity = { ...build.service, forCommunity };
  let selected: string | undefined;
  const listeners = new Set<() => void>();
  const relay = {
    // A connection's origin never decides: the selection does.
    snapshot: () => ({ origin: "wss://team.peer.example" }),
    selected: () => selected,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const select = (next: string | undefined) => {
    selected = next;
    for (const listener of listeners) listener();
  };
  build.request.mockResolvedValue(me("build"));
  build.publish({ status: "signed-in", revision: "build:1" });
  const session = createNativeSession(identity);
  const agents = followCommunity(session, identity, relay);
  const changed = vi.fn();
  agents.subscribe(changed);
  await expect.poll(() => agents.snapshot().account?.subject).toBe("build");
  expect(agents.snapshot()).toBe(session.snapshot());
  expect(agents.target).toBeUndefined();

  peer.request.mockRejectedValue(new Error("not this one"));
  build.request.mockResolvedValue(me("peer"));
  peer.publish({ status: "signed-in", revision: "peer:1" });
  select("wss://team.peer.example");
  expect(changed).toHaveBeenCalled();
  await expect.poll(() => agents.snapshot().account?.subject).toBe("peer");
  expect(agents.target).toBe("https://peer.example/goose");
  // Told apart from the build's by host.
  expect(session.providerName).toBe("Example");
  expect(agents.providerName).toBe("peer.example");
  expect(session.snapshot().account?.subject).toBe("build");
  // Its calls go out through the plugin's own identity, naming the community.
  expect(build.request).toHaveBeenLastCalledWith({
    path: "/goose/v1/auth/me",
    method: "GET",
    headers: { Accept: "application/json" },
    relay: "wss://team.peer.example",
  });
  expect(peer.request).not.toHaveBeenCalled();
  // No community selected, or one the build's server covers: the build's.
  select(undefined);
  expect(agents.snapshot()).toBe(session.snapshot());
  select("wss://other.example");
  expect(agents.snapshot()).toBe(session.snapshot());
  agents.dispose();
  session.dispose();
});

it("moves subscribers to the community's server once the build's authority arrives", async () => {
  const build = federatedFixture("build");
  const peer = federatedFixture("peer");
  const authority = peer.service.snapshot().authority;
  if (!authority) throw new Error("Missing fixture authority");
  build.publish({ authority: null });
  peer.request.mockRejectedValue(new Error("not this one"));
  build.request.mockResolvedValue(me("peer"));
  peer.publish({
    status: "signed-in",
    revision: "peer:1",
    authority: { ...authority, id: "peer" },
  });
  const identity = { ...build.service, forCommunity: () => peer.service };
  const relay = {
    snapshot: () => ({}),
    selected: () => "wss://team.peer.example",
    subscribe: () => () => {},
  };
  const session = createNativeSession(identity);
  const agents = followCommunity(session, identity, relay);
  const seen: string[] = [];
  agents.subscribe(() => seen.push(agents.snapshot().status));
  build.publish({ authority });
  await expect.poll(() => seen.at(-1)).toBe("signed-in");
  expect(agents.snapshot().account?.subject).toBe("peer");
  agents.dispose();
  session.dispose();
});

it("stays with the build's session until the build's server is known, and once disposed", () => {
  const build = federatedFixture("build");
  const peer = federatedFixture("peer");
  const authority = peer.service.snapshot().authority;
  if (!authority) throw new Error("Missing fixture authority");
  peer.publish({ authority: { ...authority, id: "peer" } });
  build.publish({ authority: null });
  const identity = { ...build.service, forCommunity: () => peer.service };
  const relay = {
    snapshot: () => ({ origin: "wss://team.peer.example" }),
    subscribe: () => () => {},
  };
  const session = createNativeSession(identity);
  const agents = followCommunity(session, identity, relay);
  expect(agents.snapshot()).toBe(session.snapshot());
  agents.dispose();
  build.publish({ authority });
  expect(agents.snapshot()).toBe(session.snapshot());
  expect(build.request).not.toHaveBeenCalled();
  session.dispose();
});

it("keeps a community pending, sending nothing, until its server is known", async () => {
  const build = federatedFixture("build");
  const peer = federatedFixture("peer");
  const authority = peer.service.snapshot().authority;
  if (!authority) throw new Error("Missing fixture authority");
  build.request.mockResolvedValue(me("build"));
  build.publish({ status: "signed-in", revision: "build:1" });
  peer.publish({ status: "restoring", authority: null });
  const identity = { ...build.service, forCommunity: () => peer.service };
  const relay = {
    snapshot: () => ({}),
    selected: () => "wss://team.peer.example",
    subscribe: () => () => {},
  };
  const session = createNativeSession(identity);
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  const agents = followCommunity(session, identity, relay);
  const sent = build.request.mock.calls.length;
  expect(agents.snapshot().status).toBe("pending");
  expect(() => agents.credential()).toThrow("still finding");
  await expect(
    agents.ensureSignedIn(new AbortController().signal),
  ).rejects.toThrow("still finding");
  expect(build.request).toHaveBeenCalledTimes(sent);
  // Resolved to the build's own server: the build's session.
  peer.publish({
    status: "signed-in",
    authority: build.service.snapshot().authority,
  });
  expect(agents.snapshot()).toBe(session.snapshot());
  agents.dispose();
  session.dispose();
});

it("names the build's site, else the selected server's origin, for usage and billing", () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example/app/");
  const session = {} as BuilderlabSession;
  expect(sessionSite(session)).toBe("https://builderlab.example/app/");
  expect(sessionSite({ ...session, target: "https://peer.example/api" })).toBe(
    "https://peer.example/",
  );
  vi.unstubAllEnvs();
});
