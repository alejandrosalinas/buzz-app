import { expect, it } from "vitest";
import type { SessionSnapshot } from "../federated-identity/service";
import { accountConsents } from "./account-consent";

const session = (status: SessionSnapshot["status"]): SessionSnapshot => ({
  status,
  authority: {
    id: "bb-public",
    identityOrigin: "https://builderlab.example",
    apiBasePath: "/api/goose/",
    signIn: "on-demand",
    organization: null,
    communityHosts: ["*.communities.example.org", "communities.example.org"],
  },
  revision: "r1",
  email: "a@example.com",
  failure: null,
  expiresAt: null,
  expiring: false,
  cleanup: false,
});
const identity = (status: SessionSnapshot["status"]) => ({
  snapshot: () => session(status),
});

it("covers a community the signed-in account's server hosts", () => {
  expect(
    accountConsents(
      identity("signed-in"),
      "https://team.communities.example.org",
    ),
  ).toBe(true);
  expect(
    accountConsents(identity("signed-in"), "wss://communities.example.org"),
  ).toBe(true);
});

it("covers nothing without a signed-in session, or for a community its server does not host", () => {
  expect(accountConsents(undefined, "https://communities.example.org")).toBe(
    false,
  );
  for (const status of [
    "signed-out",
    "signing-in",
    "restoring",
    "reauthentication-required",
    "unavailable",
  ] as const)
    expect(
      accountConsents(identity(status), "https://communities.example.org"),
    ).toBe(false);
  expect(
    accountConsents(identity("signed-in"), "https://relay.example.com"),
  ).toBe(false);
  expect(
    accountConsents(
      identity("signed-in"),
      "https://a.b.communities.example.org",
    ),
  ).toBe(false);
});
