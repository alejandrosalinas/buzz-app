import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke }));

const { createPluginStorage } = await import("./storage");

it("passes the pinned commit to the native Git import and the policy through the catalog", async () => {
  const storage = createPluginStorage(() => []);
  await storage.imports?.git("https://example.com/plugins", "v1", undefined, {
    commit: "a".repeat(40),
  });
  expect(invoke).toHaveBeenLastCalledWith("plugin_import_git", {
    repository: "https://example.com/plugins",
    reference: "v1",
    authorization: undefined,
    commit: "a".repeat(40),
  });
  await storage.imports?.checkGit("https://example.com/plugins", "v1");
  expect(invoke).toHaveBeenLastCalledWith("plugin_import_git", {
    repository: "https://example.com/plugins",
    reference: "v1",
    authorization: undefined,
    checkOnly: true,
  });
  const ready = {
    status: "ready",
    catalog: { profile: "p", location: "l", plugins: [] },
    externalPluginsPaused: false,
    managed: {
      status: "ready",
      path: "/m.json",
      source: "Org",
      plugins: [],
      problems: [],
    },
  };
  invoke.mockResolvedValueOnce(ready as never);
  await expect(storage.getCatalog()).resolves.toEqual(ready);
});
