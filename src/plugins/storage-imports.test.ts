import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));

it("sends a required commit to the native Git import only when one is given", async () => {
  const { createPluginStorage } = await import("./storage");
  const { imports } = createPluginStorage(() => []);
  await imports?.git("https://example.com/a.git", "v1", "token");
  expect(invoke).toHaveBeenLastCalledWith("plugin_import_git", {
    repository: "https://example.com/a.git",
    reference: "v1",
    authorization: "token",
  });
  const commit = "0123456789abcdef0123456789abcdef01234567";
  await imports?.git("https://example.com/a.git", "v1", undefined, { commit });
  expect(invoke).toHaveBeenLastCalledWith("plugin_import_git", {
    repository: "https://example.com/a.git",
    reference: "v1",
    authorization: undefined,
    commit,
  });
});

it("sends a folder to the native Git import, for installs and for update checks", async () => {
  const { createPluginStorage } = await import("./storage");
  const { imports } = createPluginStorage(() => []);
  const path = "plugins/one";
  await imports?.git("https://example.com/a.git", "v1", undefined, { path });
  expect(invoke).toHaveBeenLastCalledWith("plugin_import_git", {
    repository: "https://example.com/a.git",
    reference: "v1",
    authorization: undefined,
    path,
  });
  const commit = "0123456789abcdef0123456789abcdef01234567";
  await imports?.checkGit("https://example.com/a.git", "v1", "token", {
    commit,
    path,
  });
  expect(invoke).toHaveBeenLastCalledWith("plugin_import_git", {
    repository: "https://example.com/a.git",
    reference: "v1",
    authorization: "token",
    commit,
    path,
    checkOnly: true,
  });
});
