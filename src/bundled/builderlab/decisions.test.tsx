// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { DecisionsService } from "../../features/decisions/service";
import { flush } from "../../features/relay/testing";
import {
  builderlabProvider,
  nativeBuilderlabDecide,
  offerBuilderlabDecisions,
  type BuilderlabDecide,
} from "./decisions";
import type { Credential } from "./oauth/browser";
import { createOAuthSession } from "./oauth/session";

const credential = (value: string): Credential => ({
  value,
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: true,
  },
});
const request = {
  state: "x",
  questions: { a: { type: "yes_no" as const, instructions: "y" } },
  timeoutMs: 30_000,
};
const signal = new AbortController().signal;
const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(async () => ({})),
}));
vi.mock("@tauri-apps/api/core", () => tauri);
afterEach(() => {
  vi.unstubAllEnvs();
  tauri.isTauri.mockReturnValue(false);
});

it("sends a legacy sign-in itself, and names an FI session by its revision", async () => {
  tauri.isTauri.mockReturnValue(true);
  const legacy = credential("legacy-secret");
  vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "0");
  await nativeBuilderlabDecide()?.(request, legacy);
  expect(tauri.invoke).toHaveBeenLastCalledWith("decide", {
    backend: "builderlab",
    request,
    session: "legacy-secret",
  });
  vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "1");
  const federated = { account: legacy.account, revision: "fi-revision" };
  await nativeBuilderlabDecide()?.(request, federated);
  expect(tauri.invoke).toHaveBeenLastCalledWith("decide", {
    backend: "builderlab",
    request,
    federated: "fi-revision",
  });
});

it("needs a sign-in, then sends it to native with each call", async () => {
  const session = createOAuthSession(async () => credential("first"));
  const decide = vi.fn<BuilderlabDecide>(async () => ({
    outcome: "answered",
    backend: "builderlab",
    model: "builderlab-1",
    answers: { a: { type: "yes_no", probability: 0.7 } },
  }));
  const provider = builderlabProvider(session, true, decide);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "missing_credentials",
  });
  expect(decide).not.toHaveBeenCalled();
  await session.signIn();
  expect(provider.status()).toBe("ready");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "answered",
    model: "builderlab-1",
    answers: { a: { type: "yes_no", probability: 0.7 } },
  });
  expect(decide).toHaveBeenCalledWith(request, session.credential());
});

it("signs out only the sign-in Builderlab refused", async () => {
  let next = "first";
  const session = createOAuthSession(async () => credential(next));
  await session.signIn();
  let reply!: (value: unknown) => void;
  const provider = builderlabProvider(
    session,
    true,
    () => new Promise((resolve) => (reply = resolve)),
  );
  const expired = {
    outcome: "failed",
    backend: "builderlab",
    reason: "session_expired",
  };
  // A newer sign-in replaces the refused one while the call is out.
  const refusedOld = provider.decide(request, { signal });
  next = "second";
  session.signOut();
  await session.signIn();
  reply(expired);
  await expect(refusedOld).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(session.snapshot().status).toBe("signed-in");
  const refused = provider.decide(request, { signal });
  reply(expired);
  await expect(refused).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(session.snapshot().status).toBe("signed-out");
  expect(provider.status()).toBe("needs-setup");
});

it("never ends an FI session for a decisions 401", async () => {
  vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "1");
  const session = createOAuthSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, true, async () => ({
    outcome: "failed",
    backend: "builderlab",
    reason: "session_expired",
  }));
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(session.snapshot().status).toBe("signed-in");
});

it("keeps the shared sign-in when only decisions are refused", async () => {
  const session = createOAuthSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, true, async () => ({
    outcome: "failed",
    backend: "builderlab",
    reason: "unauthorized",
  }));
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(session.snapshot().status).toBe("signed-in");
});

it.each([
  ["invalid args `request` for command `decide`", "invalid_request"],
  ["decide not allowed", "service_error"],
])("reports a native rejection (%s) as %s", async (message, reason) => {
  const session = createOAuthSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, true, async () => {
    throw message;
  });
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason,
  });
});

it("is unavailable outside the desktop app", async () => {
  const session = createOAuthSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, false, undefined);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unavailable",
  });
});

it("sends nothing to Builderlab unless the account may use decisions", async () => {
  const session = createOAuthSession(async () => ({
    value: "first",
    account: {
      subject: "user",
      email: "a@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  await session.signIn();
  const decide = vi.fn<BuilderlabDecide>();
  const provider = builderlabProvider(session, true, decide);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(decide).not.toHaveBeenCalled();
});

it("offers Builderlab only while the signed-in account may use decisions", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  let allowed = false;
  const session = createOAuthSession(async () => ({
    ...credential("first"),
    account: {
      ...credential("first").account,
      canUseBuilderlabDecisions: allowed,
    },
  }));
  const decide = vi.fn<BuilderlabDecide>();
  const offer = (native: BuilderlabDecide | undefined) =>
    root
      .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
      .plugin((ctx) => offerBuilderlabDecisions(ctx, session, true, native));
  const fiber = offer(decide);
  await fiber.await();
  await flush();
  const keys = () => decisions.providers().map((provider) => provider.key);
  expect(keys()).toEqual([]);
  await session.signIn();
  expect(keys()).toEqual([]);
  session.signOut();
  allowed = true;
  await session.signIn();
  expect(keys()).toEqual(["block.builderlab/builderlab"]);
  expect(decisions.backend()).toBe("block.builderlab/builderlab");
  session.signOut();
  expect(keys()).toEqual([]);
  await session.signIn();
  expect(keys()).toEqual(["block.builderlab/builderlab"]);
  // Turning the plugin off removes it, and a build without native calls
  // never offers it.
  await fiber.dispose();
  expect(keys()).toEqual([]);
  const browser = offer(undefined);
  await browser.await();
  await flush();
  expect(keys()).toEqual([]);
  expect(decide).not.toHaveBeenCalled();
});
