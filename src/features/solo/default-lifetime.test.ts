// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { writeView } from "../../shared/view-state";
import {
  draftLifetime,
  readDefaultLifetime,
  writeDefaultLifetime,
} from "./default-lifetime";

afterEach(() => localStorage.clear());

it("reads a saved default and treats a malformed one as ongoing", () => {
  expect(readDefaultLifetime("s")).toBeUndefined();
  expect(writeDefaultLifetime("s", 604800)).toBe(true);
  expect(readDefaultLifetime("s")).toBe(604800);
  expect(readDefaultLifetime("other")).toBeUndefined();
  for (const bad of [-1, 0, 600, 1.5, "604800", 2147483648]) {
    writeView("s", "solo:default-lifetime", bad);
    expect(readDefaultLifetime("s")).toBeUndefined();
  }
  expect(writeDefaultLifetime("s", undefined)).toBe(true);
  expect(readDefaultLifetime("s")).toBeUndefined();
});

it("a draft follows the default only when its settings chose no lifetime", () => {
  writeDefaultLifetime("s", 86400);
  expect(draftLifetime("s", {})).toBe(86400);
  expect(draftLifetime("s", { lifetimeChosen: true })).toBeUndefined();
  expect(draftLifetime("s", { ttlSeconds: 600 })).toBe(600);
  expect(draftLifetime("s", { ttlSeconds: 600, lifetimeChosen: true })).toBe(
    600,
  );
});
