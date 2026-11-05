import { afterEach, expect, it, vi } from "vitest";
import { oauthTarget } from "./browser";

afterEach(() => vi.unstubAllEnvs());

it("uses the configured public URL without a deployment default", () => {
  expect(oauthTarget("https://builderlab.example/")).toBe(
    "https://builderlab.example/api/goose",
  );
  expect(oauthTarget("https://builderlab.example/deployment/")).toBe(
    "https://builderlab.example/deployment/api/goose",
  );
  expect(oauthTarget("https://login.example:8443/deployment/")).toBe(
    "https://login.example:8443/deployment/api/goose",
  );
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "");
  expect(() => oauthTarget()).toThrow("not configured");
});
it.each([
  "http://builderlab.example",
  "https://user:secret@builderlab.example",
  "https://builderlab.example/?query=x",
  "https://builderlab.example/#x",
])("refuses unsafe configuration %s", (value) => {
  expect(() => oauthTarget(value)).toThrow("does not support");
});
