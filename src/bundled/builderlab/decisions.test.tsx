// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { DecisionsSettings } from "../../app/DecisionsSettings";
import { federatedFixture } from "../../features/federated-identity/testing";
import { createNativeSession } from "./session";
import { createTestSession } from "./test-helpers";
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
import type { Credential } from "./session";
import type { BuilderlabSession } from "./session";

const credential = (revision: string): Credential => ({
  revision,
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
  cleanup();
  vi.unstubAllEnvs();
  tauri.isTauri.mockReturnValue(false);
});

it("names the native session by its revision, never a token", async () => {
  tauri.isTauri.mockReturnValue(true);
  await nativeBuilderlabDecide()?.(request, credential("fi-revision"));
  expect(tauri.invoke).toHaveBeenLastCalledWith("decide", {
    backend: "builderlab",
    request,
    federated: "fi-revision",
  });
});

it("needs a sign-in, then sends it to native with each call", async () => {
  const session = createTestSession(async () => credential("first"));
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

it("never ends an FI session for a decisions 401", async () => {
  const signOut = vi.fn();
  const fi = {
    revision: "fi-revision",
    storage: "",
    account: credential("x").account,
  };
  const session = {
    snapshot: () => ({ status: "signed-in", account: fi.account }),
    subscribe: () => () => {},
    credential: () => fi,
    signOut,
    freshCredential: async () => fi,
  } as unknown as BuilderlabSession;
  const provider = builderlabProvider(session, true, async () => ({
    outcome: "failed",
    backend: "builderlab",
    reason: "session_expired",
  }));
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(signOut).not.toHaveBeenCalled();
});

it("keeps the shared sign-in when only decisions are refused", async () => {
  const session = createTestSession(async () => credential("first"));
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
  const session = createTestSession(async () => credential("first"));
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
  const session = createTestSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, false, undefined);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unavailable",
  });
});

it("sends nothing to Builderlab unless the account may use decisions", async () => {
  const session = createTestSession(async () => ({
    revision: "first",
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

it("offers Builderlab while signed in, ready only while the account may use decisions", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  let allowed = false;
  const session = createTestSession(async () => ({
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
  expect(keys()).toEqual(["block.builderlab/builderlab"]);
  expect(decisions.status()).toBe("needs-setup");
  session.signOut();
  allowed = true;
  await session.signIn();
  expect(keys()).toEqual(["block.builderlab/builderlab"]);
  expect(decisions.backend()).toBe("block.builderlab/builderlab");
  expect(decisions.status()).toBe("ready");
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

it.each(["settings", "request", "settings-with-choice"] as const)(
  "picks up newly granted Decisions access through %s without signing in again",
  async (entry) => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let allowed = false;
    const identity = federatedFixture();
    identity.request.mockImplementation(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        subject: "user",
        email: "a@example.com",
        capabilities: { can_use_builderlab_decisions: allowed },
      }),
    }));
    const session = createNativeSession(identity.service);
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const decisions = new DecisionsService(root, {
      getItem: () => null,
      setItem: () => {},
    } as unknown as Storage);
    const answered = {
      outcome: "answered" as const,
      model: "test",
      answers: { a: { type: "yes_no" as const, probability: 0.7 } },
    };
    const fallback = vi.fn(async () => answered);
    const native = vi.fn<BuilderlabDecide>(async () => answered);
    const chosen = vi.fn(async () => answered);
    const fallbackPlugin = root
      .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
      .plugin((ctx) =>
        ctx.decisions.registerProvider({
          id: "typesafe",
          label: "TypeSafe",
          description: "Fallback",
          status: () => "ready",
          subscribe: () => () => {},
          decide: fallback,
        }),
      );
    const builderlab = root
      .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
      .plugin((ctx) => offerBuilderlabDecisions(ctx, session, true, native));
    try {
      await Promise.all([fallbackPlugin.await(), builderlab.await()]);
      if (entry === "settings-with-choice") {
        const custom = root
          .extend({ pluginOwner: { id: "example.provider", revision: "one" } })
          .plugin((ctx) =>
            ctx.decisions.registerProvider({
              id: "custom",
              label: "Custom",
              description: "Chosen",
              status: () => "ready",
              subscribe: () => () => {},
              decide: chosen,
            }),
          );
        await custom.await();
        await flush();
        decisions.setBackend("example.provider/custom");
      }
      await session.signIn();
      await expect.poll(() => session.snapshot().status).toBe("signed-in");
      await flush();
      // Signed in without access: listed, but defaults fall through to TypeSafe.
      expect(
        decisions
          .providers()
          .some((p) => p.key === "block.builderlab/builderlab"),
      ).toBe(true);
      const beforeBackend =
        entry === "settings-with-choice"
          ? "example.provider/custom"
          : "buzz.typesafe/typesafe";
      await expect(decisions.decide(request)).resolves.toMatchObject({
        backend: beforeBackend,
      });
      const owner = session.credential();
      expect(identity.request).toHaveBeenCalledOnce();
      const settings = entry.startsWith("settings")
        ? render(
            <DecisionsSettings decisions={decisions} active={() => false} />,
          )
        : undefined;
      expect(identity.request).toHaveBeenCalledOnce();
      allowed = true;
      now += 60_000;
      if (entry.startsWith("settings")) {
        settings?.rerender(
          <DecisionsSettings decisions={decisions} active={() => true} />,
        );
        expect(
          await screen.findByRole("radio", { name: /Builderlab/ }),
        ).toBeVisible();
        if (entry === "settings-with-choice") {
          // Another provider is chosen, so nothing reads Builderlab's
          // permissions until the user picks it.
          expect(identity.request).toHaveBeenCalledOnce();
          await act(async () =>
            screen.getByRole("radio", { name: /Builderlab/ }).click(),
          );
        }
        await expect
          .poll(() => decisions.backend())
          .toBe("block.builderlab/builderlab");
      } else {
        // TypeSafe can answer now, so the request that notices stale
        // permissions does not wait for them; the re-read it starts makes
        // Builderlab the default for the next one.
        await expect(decisions.decide(request)).resolves.toMatchObject({
          backend: "buzz.typesafe/typesafe",
        });
        await expect
          .poll(() => decisions.backend())
          .toBe("block.builderlab/builderlab");
      }
      expect(
        decisions
          .providers()
          .some((p) => p.key === "block.builderlab/builderlab"),
      ).toBe(true);
      expect(decisions.backend()).toBe("block.builderlab/builderlab");
      expect(fallback).toHaveBeenCalledTimes(
        { settings: 1, request: 2, "settings-with-choice": 0 }[entry],
      );
      if (entry === "settings-with-choice")
        expect(native).not.toHaveBeenCalled();
      expect(identity.request).toHaveBeenCalledTimes(2);
      await act(async () => {
        await decisions.decide(request);
      });
      expect(identity.request).toHaveBeenCalledTimes(2);
      expect(session.credential()).toBe(owner);
      expect(identity.service.signIn).toHaveBeenCalledOnce();
      expect(identity.service.signOut).not.toHaveBeenCalled();
    } finally {
      cleanup();
      await root.fiber.dispose();
      session.dispose();
      clock.mockRestore();
    }
  },
);
