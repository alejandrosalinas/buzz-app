import { expect, it, vi } from "vitest";
import { attestedOwner, authTagOwner } from "./owner-attestation";

// NIP-OA test vector: owner secret 1, agent secret 2.
const owner =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const agent =
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const conditions = "kind=1&created_at<1713957000";
const sig =
  "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";
const event = (tags: string[][], overrides = {}) => ({
  pubkey: agent,
  kind: 1,
  created_at: 1713956400,
  tags,
  ...overrides,
});

it("returns the owner for the NIP-OA vector", async () => {
  expect(await attestedOwner(event([["auth", owner, conditions, sig]]))).toBe(
    owner,
  );
});

it.each([
  ["no tag", []],
  [
    "two tags",
    [
      ["auth", owner, conditions, sig],
      ["auth", owner, conditions, sig],
    ],
  ],
  ["five elements", [["auth", owner, conditions, sig, "x"]]],
  ["trailing delimiter", [["auth", owner, `${conditions}&`, sig]]],
  ["leading zero", [["auth", owner, "kind=01", sig]]],
  [
    "reordered conditions",
    [["auth", owner, "created_at<1713957000&kind=1", sig]],
  ],
  ["tampered signature", [["auth", owner, conditions, `${sig.slice(0, -1)}8`]]],
  ["uppercase owner", [["auth", owner.toUpperCase(), conditions, sig]]],
])("rejects %s", async (_name, tags) => {
  expect(await attestedOwner(event(tags))).toBeUndefined();
});

it("evaluates conditions against the event", async () => {
  const tag = [["auth", owner, conditions, sig]];
  expect(await attestedOwner(event(tag, { kind: 0 }))).toBeUndefined();
  expect(
    await attestedOwner(event(tag, { created_at: 1713957000 })),
  ).toBeUndefined();
});

it("rejects self-attestation and another agent key", async () => {
  expect(
    await attestedOwner(
      event([["auth", owner, conditions, sig]], { pubkey: owner }),
    ),
  ).toBeUndefined();
  expect(
    await attestedOwner(
      event([["auth", owner, conditions, sig]], { pubkey: "b".repeat(64) }),
    ),
  ).toBeUndefined();
});

it("reuses the check for a repeated auth tag", async () => {
  const tag = ["auth", owner, conditions, sig];
  const target = "d".repeat(64);
  const digest = vi.spyOn(crypto.subtle, "digest");
  try {
    await authTagOwner(target, tag);
    await authTagOwner(target, [...tag]);
    expect(digest).toHaveBeenCalledOnce();
  } finally {
    digest.mockRestore();
  }
});

it("verifies an oversized auth tag without keeping it", async () => {
  const tag = ["auth", owner, `kind=1${"&kind=1".repeat(100)}`, sig];
  const target = "e".repeat(64);
  const digest = vi.spyOn(crypto.subtle, "digest");
  try {
    await authTagOwner(target, tag);
    await authTagOwner(target, tag);
    expect(digest).toHaveBeenCalledTimes(2);
  } finally {
    digest.mockRestore();
  }
});

it("retries a check that failed instead of keeping the failure", async () => {
  const tag = ["auth", owner, conditions, sig];
  const target = "f".repeat(64);
  const digest = vi
    .spyOn(crypto.subtle, "digest")
    .mockRejectedValueOnce(new DOMException("failed", "OperationError"));
  try {
    expect(await authTagOwner(target, tag)).toBeUndefined();
    await authTagOwner(target, tag);
    expect(digest).toHaveBeenCalledTimes(2);
  } finally {
    digest.mockRestore();
  }
});
