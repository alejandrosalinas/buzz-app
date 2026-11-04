import { afterEach, expect, it, vi } from "vitest";
import type { PluginManager } from "./manager";
import type { ImportPreview, PluginInfo, StorageResult } from "./types";
import { createPluginUpdates } from "./updates";

afterEach(() => vi.useRealTimers());

function fixture() {
  const source = {
    repository: "https://example.com/plugins.git",
    reference: "main",
    path: ".",
  };
  const plugin: PluginInfo = {
    manifest: { id: "example.notes", name: "Notes", apiVersion: 1 },
    source: "external",
    enabled: true,
    revision: "old",
    previous: null,
    reloadable: true,
    error: null,
    updateSource: source,
  };
  let configuration: StorageResult = {
    status: "ready",
    externalPluginsPaused: false,
    catalog: { profile: "test", location: "test", plugins: [plugin] },
  };
  const listeners = new Set<() => void>();
  const candidate = { path: ".", manifest: plugin.manifest, revision: "new" };
  const preview: ImportPreview = {
    token: "",
    source: source.repository,
    commit: "a".repeat(40),
    candidates: [candidate],
    warnings: [],
  };
  const checkGit = vi.fn(async () => preview);
  const imports = {
    checkGit,
    git: vi.fn(),
    install: vi.fn(),
    discard: vi.fn(),
  };
  const manager = {
    imports,
    snapshot: () => ({ configuration }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as PluginManager;
  const authorize = vi.fn(async () => null);
  return {
    plugin,
    candidate,
    preview,
    checkGit,
    imports,
    manager,
    authorize,
    set(next: StorageResult) {
      configuration = next;
      for (const listener of listeners) listener();
    },
    get: () => configuration,
  };
}

it("discovers without acquiring a preview or installing; Later lasts for the candidate and run", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  const first = updates.snapshot()[0];
  expect(first?.candidate?.revision).toBe("new");
  expect(f.imports.git).not.toHaveBeenCalled();
  expect(f.imports.install).not.toHaveBeenCalled();
  expect(f.imports.discard).not.toHaveBeenCalled();
  if (!first) throw new Error("Expected update");
  updates.later(first);
  expect(updates.hidden(first)).toBe(true);
  await updates.check();
  expect(f.checkGit).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3_600_000);
  await updates.check();
  expect(updates.snapshot().map(updates.hidden)).toEqual([true]);
  f.candidate.revision = "newer";
  await updates.check(true);
  expect(updates.snapshot().map(updates.hidden)).toEqual([false]);
  updates.dispose();
  const nextRun = createPluginUpdates(f.manager, f.authorize);
  await nextRun.check();
  expect(nextRun.snapshot().map(nextRun.hidden)).toEqual([false]);
  nextRun.dispose();
});

it("keeps a useful authentication error and retries discovery without installation", async () => {
  const f = fixture();
  f.authorize.mockRejectedValueOnce(new Error("SSH authentication failed"));
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(updates.snapshot()[0]?.error).toBe("SSH authentication failed");
  await updates.check(true);
  expect(updates.snapshot()[0]?.candidate?.revision).toBe("new");
  expect(f.imports.install).not.toHaveBeenCalled();
  updates.dispose();
});

it("requires the managed commit and removes a candidate when its source changes", async () => {
  const f = fixture();
  const config = f.get();
  if (config.status !== "ready") throw new Error("Expected catalog");
  f.set({
    ...config,
    managed: {
      status: "ready",
      path: "policy",
      source: "Example",
      plugins: [
        {
          id: f.plugin.manifest.id,
          repository: "https://example.com/plugins.git",
          reference: "release",
          path: ".",
          commit: "b".repeat(40),
          state: "outdated",
        },
      ],
      problems: [],
    },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(updates.snapshot()[0]?.error).toContain("managed commit");
  expect(f.imports.install).not.toHaveBeenCalled();
  f.preview.commit = "b".repeat(40);
  await updates.check(true);
  expect(updates.snapshot()[0]?.source.commit).toBe("b".repeat(40));
  f.set({
    ...config,
    catalog: {
      ...config.catalog,
      plugins: [
        {
          ...f.plugin,
          updateSource: {
            repository: "https://example.com/other.git",
            reference: "main",
            path: ".",
          },
        },
      ],
    },
  });
  expect(updates.snapshot()).toEqual([]);
  updates.dispose();
});

it("discards late discovery after disposal or removal and prevents overlapping checks", async () => {
  const f = fixture();
  let resolve!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const updates = createPluginUpdates(f.manager, f.authorize);
  const pending = updates.check();
  await Promise.resolve();
  await updates.check(true);
  expect(f.checkGit).toHaveBeenCalledTimes(1);
  updates.dispose();
  resolve(f.preview);
  await pending;
  expect(updates.snapshot()).toEqual([]);
});
