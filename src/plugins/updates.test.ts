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
    manifest: {
      id: "example.notes",
      name: "Notes",
      apiVersion: 1,
      updates: { defaultEnabled: true },
    },
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

it.each([
  [undefined, undefined, false],
  [undefined, true, false],
  [{ defaultEnabled: false }, undefined, false],
  [{ defaultEnabled: false }, true, true],
  [{ defaultEnabled: true }, undefined, true],
  [{ defaultEnabled: true }, false, false],
] as const)(
  "checks only when the installed plugin and user policy allow it (%j, %j)",
  async (policy, choice, expected) => {
    const f = fixture();
    const manifest = { ...f.plugin.manifest };
    delete manifest.updates;
    f.plugin.manifest = policy ? { ...manifest, updates: policy } : manifest;
    f.plugin.updateChecks = choice ?? null;
    const updates = createPluginUpdates(f.manager, f.authorize);
    await updates.check();
    expect(f.checkGit).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(f.authorize).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(updates.snapshot()).toHaveLength(expected ? 1 : 0);
    updates.dispose();
  },
);

it("retires a notice on opt-out and checks immediately on opt-in", async () => {
  const f = fixture();
  f.plugin.updateChecks = false;
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  f.plugin.updateChecks = true;
  f.set(f.get());
  await updates.check();
  expect(updates.snapshot()).toHaveLength(1);
  f.plugin.updateChecks = false;
  f.set(f.get());
  expect(updates.snapshot()).toEqual([]);
  await updates.check(true);
  expect(f.checkGit).toHaveBeenCalledTimes(1);
  updates.dispose();
});

it.each([false, true])(
  "rechecks opt-out after Git authorization; shared request needed: %s",
  async (shared) => {
    const f = fixture();
    const configuration = f.get();
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    if (shared) {
      f.set({
        ...configuration,
        catalog: {
          ...configuration.catalog,
          plugins: [
            f.plugin,
            {
              ...f.plugin,
              manifest: { ...f.plugin.manifest, id: "example.other" },
            },
          ],
        },
      });
    }
    let finish!: (value: null) => void;
    f.authorize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const updates = createPluginUpdates(f.manager, f.authorize);
    const pending = updates.check();
    expect(f.authorize).toHaveBeenCalledTimes(1);
    f.plugin.updateChecks = false;
    f.set(f.get());
    finish(null);
    await pending;
    expect(f.checkGit).toHaveBeenCalledTimes(shared ? 1 : 0);
    expect(
      updates.snapshot().some((update) => update.id === f.plugin.manifest.id),
    ).toBe(false);
    updates.dispose();
  },
);

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

it("retains an explicit retry while another repository is pending", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const other = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other" },
    updateSource: {
      repository: "https://example.com/other.git",
      reference: "main",
      path: ".",
    },
  };
  f.preview.candidates.push({
    path: ".",
    manifest: other.manifest,
    revision: "new",
  });
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [f.plugin, other] },
  });
  f.authorize.mockRejectedValueOnce(new Error("SSH authentication failed"));
  let started!: () => void;
  const discovery = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  const running = updates.check();
  await discovery;
  let retried: ReturnType<typeof updates.check> | undefined;
  try {
    expect(updates.snapshot()[0]?.error).toBe("SSH authentication failed");
    retried = updates.check(true);
    expect(f.checkGit).toHaveBeenCalledTimes(1);
  } finally {
    finish(f.preview);
    await running;
    await retried;
    updates.dispose();
  }
  expect(f.checkGit).toHaveBeenCalledTimes(3);
  const retriedUpdate = updates
    .snapshot()
    .find((update) => update.id === f.plugin.manifest.id);
  expect(retriedUpdate?.candidate?.revision).toBe("new");
  expect(retriedUpdate?.error).toBeUndefined();
  expect(f.imports.install).not.toHaveBeenCalled();
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
  const retried = updates.check(true);
  expect(f.checkGit).toHaveBeenCalledTimes(1);
  updates.dispose();
  resolve(f.preview);
  await pending;
  await retried;
  expect(updates.snapshot()).toEqual([]);
});

it("checks a saved Git source after its recommendation is removed", async () => {
  const f = fixture();
  const source = f.plugin.updateSource;
  if (!source || !("repository" in source))
    throw new Error("Expected Git source");
  f.plugin.updateSource = { ...source, commit: "b".repeat(40) };
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(updates.snapshot()[0]?.candidate?.revision).toBe("new");
  expect(updates.snapshot()[0]?.source.commit).toBeUndefined();
  updates.dispose();
});

it("reuses discovery for plugins in the same repository and reference", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const source = f.plugin.updateSource;
  if (!source || !("repository" in source))
    throw new Error("Expected Git source");
  const other = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other" },
    updateSource: { ...source, path: "other" },
  };
  const stable = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.stable" },
    updateSource: { ...source, reference: "stable" },
  };
  f.preview.candidates.push(
    { path: "other", manifest: other.manifest, revision: "other-new" },
    { path: ".", manifest: stable.manifest, revision: "stable-new" },
  );
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [f.plugin, other, stable] },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(
    updates.snapshot().map((update) => update.candidate?.revision),
  ).toEqual(["new", "other-new", "stable-new"]);
  expect(f.checkGit).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  updates.dispose();
});
