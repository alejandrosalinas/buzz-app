import { describe, expect, it, vi } from "vitest";
import { noteEncode, npubEncode, nsecEncode } from "nostr-tools/nip19";
import { hexToBytes } from "nostr-tools/utils";
import {
  canonicalPublicKey,
  formatPublicKey,
  publicKeyLabels,
  typedPublicKey,
} from "./public-key";

vi.mock("nostr-tools/nip19", async (actual) => {
  const module = await actual<typeof import("nostr-tools/nip19")>();
  return { ...module, npubEncode: vi.fn(module.npubEncode) };
});

const first = "a".repeat(64);
const second = "b".repeat(64);

describe("public-key display", () => {
  it("uses canonical npub endings, not hex endings, and normalizes case", () => {
    expect(formatPublicKey(first)).toBe("npub…caj");
    expect(formatPublicKey(first.toUpperCase())).toBe("npub…caj");
    expect(formatPublicKey(second, 4)).toBe("npub…04hu");
  });

  it.each([
    "",
    "not-a-key",
    "a".repeat(63),
    "g".repeat(64),
    "nsec1secret",
    "npub1broken",
  ])("does not echo invalid input: %s", (input) => {
    expect(formatPublicKey(input)).toBeUndefined();
    expect(publicKeyLabels([input]).size).toBe(0);
  });

  it("bounds requested lengths and never drops the public-key prefix", () => {
    for (const length of [-1, 0, 2, NaN, Infinity, 3.5])
      expect(formatPublicKey(first, length)).toBe("npub…caj");
    expect(formatPublicKey(first, 999)).toMatch(/^npub…[a-z0-9]{58}$/);
  });

  it("encodes each key once across repeated roster labels, within a bound", () => {
    const roster = Array.from({ length: 50 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    );
    vi.mocked(npubEncode).mockClear();
    for (let render = 0; render < 3; render++) {
      for (const key of roster) formatPublicKey(key.toUpperCase());
      publicKeyLabels(roster);
    }
    expect(npubEncode).toHaveBeenCalledTimes(roster.length);
    const filler = (index: number) =>
      `e${index.toString(16).padStart(63, "0")}`;
    for (let index = 0; index < 8192; index++)
      canonicalPublicKey(filler(index));
    // All 8,192 most recent keys stay cached.
    vi.mocked(npubEncode).mockClear();
    canonicalPublicKey(filler(0));
    expect(npubEncode).not.toHaveBeenCalled();
    // The oldest keys were evicted and are encoded again.
    const npub = canonicalPublicKey(roster[0] as string);
    expect(npubEncode).toHaveBeenCalledTimes(1);
    expect(npub).toMatch(/^npub1/);
  });

  it("deduplicates exact identities and uses stable labels independent of order", () => {
    const labels = publicKeyLabels([first, second, first.toUpperCase()]);
    expect([...labels]).toEqual([
      [first, "npub…caj"],
      [second, "npub…4hu"],
    ]);
    expect(publicKeyLabels([second, first])).toEqual(labels);
  });

  it("extends all labels in a group when three ending characters collide", () => {
    // Fixed canonical npubs ending 7c8a32 and 8mga32.
    const a = "08c5".padStart(64, "0");
    const b = "4000".padStart(64, "0");
    expect(formatPublicKey(a)).toBe("npub…a32");
    expect(formatPublicKey(b)).toBe("npub…a32");
    expect([...publicKeyLabels([a, b, first]).values()]).toEqual([
      "npub…8a32",
      "npub…ga32",
      "npub…rcaj",
    ]);
    expect(publicKeyLabels([]).size).toBe(0);
  });
});

describe("typed public keys", () => {
  const npub = npubEncode(first);
  it.each([
    ["lowercase hex", first],
    ["uppercase hex", first.toUpperCase()],
    ["an npub", npub],
    ["a nostr: npub", `nostr:${npub}`],
    ["an uppercase npub", npub.toUpperCase()],
    ["an uppercase nostr: npub", `NOSTR:${npub.toUpperCase()}`],
    ["text padded with spaces", `  ${npub} `],
  ])("reads %s as the hex key", (_case, text) => {
    expect(typedPublicKey(text)).toBe(first);
  });

  it.each([
    ["a partly typed npub", npub.slice(0, 12)],
    ["a mixed-case npub", `NPUB1${npub.slice(5)}`],
    ["the nsec with the same key bytes", nsecEncode(hexToBytes(first))],
    ["a note", noteEncode(first)],
    ["an npub of 20 bytes", "npub1qurswpc8qurswpc8qurswpc8qurswpc86nz8sw"],
    ["63 hex characters", first.slice(1)],
    ["65 hex characters", `${first}a`],
    ["a name", "Sam Rivera"],
  ])("does not read %s as a key", (_case, text) => {
    expect(typedPublicKey(text)).toBeUndefined();
  });
});
