import { expect, it, vi } from "vitest";
import { federatedFixture } from "../../features/federated-identity/testing";
import { createNativeSession } from "./session";

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
