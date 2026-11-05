import { createTestSession } from "./test-helpers";
import { expect, it, vi } from "vitest";
import type { AgentClient } from "./agents/client";
import type { Credential } from "./session";
import { hostedAgentSettings } from "./service";

const signedIn = (revision: string): Credential => ({
  revision,
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: false,
  },
});

it("shares hosted-agent settings without the credential or the Beekeeper client", async () => {
  const acquire = vi
    .fn<() => Promise<Credential>>()
    .mockResolvedValueOnce(signedIn("first-token"))
    .mockResolvedValueOnce(signedIn("second-token"));
  const session = createTestSession(acquire);
  const list = vi.fn(async () => []);
  const service = hostedAgentSettings(session, {
    list,
    delete: vi.fn(),
  } as unknown as AgentClient);
  expect(Object.keys(service).sort()).toEqual([
    "account",
    "ensureSignedIn",
    "list",
    "modelCatalog",
    "updateInstructions",
    "updateModel",
  ]);
  expect(() => service.account()).toThrow("Sign in");

  await service.ensureSignedIn(new AbortController().signal);
  const first = service.account();
  expect(first).toEqual({ subject: "user" });
  expect(service.account()).toBe(first);
  expect(JSON.stringify(first)).not.toContain("token");
  await service.list(new AbortController().signal);
  expect(list).toHaveBeenCalledOnce();

  // Signing in again, even as the same account, is a different login.
  session.signOut();
  await session.signIn();
  expect(service.account()).not.toBe(first);
});
