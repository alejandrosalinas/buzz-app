import { expect, it } from "vitest";
import { adminReason, inviteListPath, revokeRequest } from "./admin-protocol";

const id = "0b9c8f7e-1d2a-4b3c-9e8f-7a6b5c4d3e2f";

it("pages the invite list only by the relay's cursor", () => {
  expect(inviteListPath({})).toBe("/api/invites");
  expect(inviteListPath({ before: `1795049564000000_${id}` })).toBe(
    `/api/invites?before=1795049564000000_${id}`,
  );
  for (const body of [
    { before: "1&limit=200" },
    { before: `x_${id}` },
    { limit: 200 },
  ])
    expect(() => inviteListPath(body)).toThrow("Invalid invite list request");
});

it("revokes by exactly one of id or code", () => {
  expect(revokeRequest({ id })).toEqual({ id });
  expect(revokeRequest({ code: "v2.abc_-" })).toEqual({ code: "v2.abc_-" });
  for (const body of [
    {},
    { id, code: "v2.abc" },
    { id: "nope" },
    { code: "a b" },
    { code: "v2.abc", extra: 1 },
  ])
    expect(() => revokeRequest(body)).toThrow("Invalid revoke request");
});

it("shows only allowlisted relay refusals, never one carrying a code", () => {
  expect(adminReason({ error: "invite_not_found" })).toBe("invite_not_found");
  expect(adminReason({ error: "v2.leak not found" })).toBeUndefined();
});
