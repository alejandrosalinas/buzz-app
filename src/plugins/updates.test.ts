import { afterEach, expect, it, vi } from "vitest";
import type { PluginInstaller } from "./author";
import type { PluginManager } from "./manager";
import type { ImportPreview, PluginInfo, StorageResult } from "./types";
import {
  createPluginUpdateCapabilityBridge,
  createPluginUpdates,
  updateFailure,
} from "./updates";

type PluginUpdateCapability = NonNullable<PluginInstaller["updates"]>;

afterEach(() => vi.useRealTimers());

function startReview(updates: ReturnType<typeof createPluginUpdates>) {
  return updates.startNextReview(() => () => {});
}

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
  let activation: ReturnType<PluginManager["snapshot"]>["activation"] = {};
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
    snapshot: () => ({ configuration, activation }),
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
    setActivation(next: typeof activation) {
      activation = next;
      for (const listener of listeners) listener();
    },
    get: () => configuration,
  };
}

function gitUpdateSource(plugin: PluginInfo) {
  const source = plugin.updateSource;
  if (!source || !("repository" in source))
    throw new Error("Expected a Git update source");
  return source;
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

it("offers a signature-only repair and retires its notice after installation", async () => {
  const f = fixture();
  f.preview.candidates = [
    { ...f.candidate, revision: f.plugin.revision, publisher: "a".repeat(64) },
  ];
  const updates = createPluginUpdates(f.manager, f.authorize);
  try {
    await updates.check();
    expect(updates.snapshot()[0]?.candidate?.publisher).toBe("a".repeat(64));
    expect(f.imports.install).not.toHaveBeenCalled();
    f.plugin.publisher = "a".repeat(64);
    f.plugin.hasSignature = true;
    f.set(f.get());
    expect(updates.snapshot()).toEqual([]);
    await updates.check(true);
    expect(updates.snapshot()).toEqual([]);
  } finally {
    updates.dispose();
  }
});

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
    // The changed eligible-source generation gets one coalesced follow-up.
    expect(f.checkGit).toHaveBeenCalledTimes(shared ? 2 : 0);
    expect(
      updates.snapshot().some((update) => update.id === f.plugin.manifest.id),
    ).toBe(false);
    updates.dispose();
  },
);

it("rechecks the newest source when a non-forced check joins changed in-flight discovery", async () => {
  const f = fixture();
  let finish!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const updates = createPluginUpdates(f.manager, f.authorize);
  const checking = updates.check();
  try {
    await vi.waitFor(() => expect(f.checkGit).toHaveBeenCalledOnce());
    f.plugin.updateSource = {
      ...gitUpdateSource(f.plugin),
      reference: "stable",
    };
    f.set(f.get());
    const joined = updates.check();
    expect(joined).toBe(checking);
    finish(f.preview);
    await joined;
    expect(f.checkGit).toHaveBeenCalledTimes(2);
    expect(f.checkGit).toHaveBeenLastCalledWith(
      gitUpdateSource(f.plugin).repository,
      "stable",
      undefined,
    );
    expect(updates.capability.getSnapshot().status).toBe("fresh");
    const token = updates.capability.getSnapshot().candidates[0]?.token;
    if (!token) throw new Error("Expected a fresh candidate");
    expect(updates.capability.queueUpdates([token])).toBeDefined();
  } finally {
    finish?.(f.preview);
    await checking;
    updates.dispose();
  }
});

it("does not notify update subscribers for unchanged manager publications", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  const snapshot = updates.capability.getSnapshot();
  const changed = vi.fn();
  updates.capability.subscribe(changed);
  f.set(f.get());
  f.setActivation({});
  expect(changed).not.toHaveBeenCalled();
  expect(updates.capability.getSnapshot()).toBe(snapshot);
  updates.dispose();
});

it("notifies subscribers when freshness expires without fetching or installing", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  const changed = vi.fn();
  updates.capability.subscribe(changed);
  vi.advanceTimersByTime(3_599_999);
  expect(changed).not.toHaveBeenCalled();
  expect(updates.capability.getSnapshot().status).toBe("fresh");
  vi.advanceTimersByTime(1);
  expect(changed).toHaveBeenCalledOnce();
  expect(updates.capability.getSnapshot().status).toBe("stale");
  expect(f.checkGit).toHaveBeenCalledOnce();
  expect(f.imports.install).not.toHaveBeenCalled();
  updates.dispose();
});

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
  expect(f.checkGit).toHaveBeenCalledWith(
    "https://example.com/plugins.git",
    "release",
    undefined,
    { commit: "b".repeat(40) },
  );
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

it("reuses discovery only for plugins with the same repository, reference and folder", async () => {
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
  const twin = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.twin" },
  };
  const stable = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.stable" },
    updateSource: { ...source, reference: "stable" },
  };
  f.preview.candidates.push(
    { path: "other", manifest: other.manifest, revision: "other-new" },
    { path: ".", manifest: twin.manifest, revision: "twin-new" },
    { path: ".", manifest: stable.manifest, revision: "stable-new" },
  );
  f.set({
    ...configuration,
    catalog: {
      ...configuration.catalog,
      plugins: [f.plugin, other, twin, stable],
    },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(
    updates.snapshot().map((update) => update.candidate?.revision),
  ).toEqual(["new", "other-new", "twin-new", "stable-new"]);
  expect(f.checkGit).toHaveBeenCalledTimes(3);
  expect(f.authorize).toHaveBeenCalledTimes(3);
  expect(f.checkGit).toHaveBeenCalledWith(
    source.repository,
    source.reference,
    undefined,
    { path: "other" },
  );
  updates.dispose();
});

const OFFLINE =
  "Git could not read this repository: fatal: unable to access 'https://example.com/plugins.git/': Could not resolve host: example.com";

// Hints, not verdicts: "not found" also answers a repository that denies
// access, and a missing username means this check sent no credentials.
const NOT_FOUND =
  "Git couldn’t find this plugin’s repository. It may have moved, been removed, or need access you don’t have.";
const NO_SIGN_IN =
  "Git needs a sign-in for this repository that Buzz couldn’t provide.";
it.each([
  [
    "https://github.com/acme/notes",
    "Git could not read this repository: remote: Repository not found.\nfatal: repository 'https://github.com/acme/notes/' not found",
    NOT_FOUND,
  ],
  [
    "git@github.com:acme/notes.git",
    "Git could not read this repository: ERROR: Repository not found.\nfatal: Could not read from remote repository.",
    NOT_FOUND,
  ],
  [
    "https://github.com/acme/notes",
    "Git could not read this repository: fatal: could not read Username for 'https://github.com': terminal prompts disabled Private repositories need an SSH URL, such as git@github.com:owner/repo.git.",
    NO_SIGN_IN,
  ],
  [
    "git@github.com:acme/notes.git",
    "Git could not read this repository: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    undefined,
  ],
  // A repository Buzz authorizes over HTTPS fails this way when its token
  // expired or was revoked; the generic sentence fits.
  [
    "https://github.com/acme/notes",
    "Git could not read this repository: remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/acme/notes/'",
    undefined,
  ],
  ["https://example.com/plugins.git", OFFLINE, undefined],
  [
    "https://example.com/plugins.git",
    "The repository does not match the managed commit. Try again after the recommendation is corrected.",
    "The repository does not match the managed commit. Try again after the recommendation is corrected.",
  ],
] as const)(
  "names what Buzz knows about a failed check (%s, case %#)",
  (repository, error, expected) => {
    expect(
      updateFailure({
        error,
        source: { repository, reference: "main", path: "." },
      }),
    ).toEqual(expected);
  },
);

it("publishes retained freshness and opaque candidate tokens without installing", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const capability = updates.capability;

  expect(capability.getSnapshot().status).toBe("stale");
  const snapshot = await capability.refresh();
  expect(snapshot.status).toBe("fresh");
  expect(snapshot.checkedAt).toEqual(expect.any(Number));
  expect(snapshot.candidates).toMatchObject([
    {
      id: "example.notes",
      name: "Notes",
      installedRevision: "old",
      candidateRevision: "new",
    },
  ]);
  const token = snapshot.candidates[0]?.token;
  expect(token).toEqual(expect.any(String));
  const refreshed = await capability.refresh();
  expect(refreshed.candidates[0]?.token).toBe(token);
  expect(capability.queueUpdates(token ? [token] : [])?.status).toBe("queued");
  expect(f.imports.install).not.toHaveBeenCalled();
  updates.dispose();
});

it("keeps disabled and unavailable discovery distinct from a fresh empty result", async () => {
  const f = fixture();
  const disabled = createPluginUpdates(f.manager, f.authorize);
  f.plugin.updateChecks = false;
  f.set(f.get());
  expect(disabled.capability.getSnapshot().status).toBe("disabled");
  expect((await disabled.capability.refresh()).status).toBe("disabled");
  expect(disabled.capability.getSnapshot().candidates).toEqual([]);
  expect(disabled.capability.queueUpdates([])).toBeUndefined();
  disabled.dispose();

  const withoutImports = {
    ...f.manager,
    imports: undefined,
  } as unknown as PluginManager;
  const unavailable = createPluginUpdates(withoutImports, f.authorize);
  expect(unavailable.capability.getSnapshot().status).toBe("unavailable");
  expect((await unavailable.capability.refresh()).status).toBe("unavailable");
  unavailable.dispose();
});

it("keeps fresh aggregate status separate from opted-out and no-source plugins", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const source = gitUpdateSource(f.plugin);
  const optedOut: PluginInfo = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.opted-out" },
    updateSource: {
      ...source,
      repository: "https://example.com/opted-out.git",
      path: "opted-out",
    },
    updateChecks: false,
  };
  const noSource: PluginInfo = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.no-source" },
    updateSource: null,
  };
  f.preview.candidates = [f.candidate];
  f.set({
    ...configuration,
    catalog: {
      ...configuration.catalog,
      plugins: [f.plugin, optedOut, noSource],
    },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);

  const snapshot = await updates.capability.refresh();

  expect(snapshot.status).toBe("fresh");
  expect(snapshot.checkedAt).toEqual(expect.any(Number));
  expect(
    snapshot.candidates.map(({ id, candidateRevision }) => [
      id,
      candidateRevision,
    ]),
  ).toEqual([[f.plugin.manifest.id, f.candidate.revision]]);
  expect(snapshot.errors).toEqual([]);
  expect(f.checkGit).toHaveBeenCalledTimes(1);
  expect(f.authorize).toHaveBeenCalledTimes(1);
  expect(f.authorize).toHaveBeenCalledWith(source.repository);
  updates.dispose();
});

it("bounds retained terminal queue history and keeps pending queues schedulable", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const token = (await updates.capability.refresh()).candidates[0]?.token;
  if (!token) throw new Error("Expected a retained update token");
  const ownerId = updates.capability.ownerId;
  if (!ownerId) throw new Error("Expected a retained queue provider");

  const queues = [];
  for (let index = 0; index < 51; index++) {
    const request = { ownerId, requestId: `request-${index}` };
    const queue = updates.capability.queueUpdates([token], request);
    if (!queue)
      throw new Error("Expected a queue within the host retention cap");
    queues.push(queue.id);
    expect(startReview(updates)?.queueId).toBe(queue.id);
    expect(updates.beginOperation(queue.id, token)).toEqual(
      expect.any(Function),
    );
    expect(updates.finishReview(queue.id, token, "updated")).toBe(true);
  }

  expect(updates.capability.getQueue(queues[0] ?? "")).toBeUndefined();
  expect(updates.capability.getQueue(queues.at(-1) ?? "")?.status).toBe(
    "completed",
  );
  expect(
    updates.capability.queueUpdates([token], {
      ownerId,
      requestId: "request-0",
    }),
  ).toBeUndefined();
  expect(
    updates.capability.getQueueRequest({
      ownerId,
      requestId: "request-0",
      tokens: [token],
    }),
  ).toEqual({ status: "unknown" });
  const pending = updates.capability.queueUpdates([token]);
  if (!pending)
    throw new Error("Expected a pending queue after history pruning");
  expect(startReview(updates)?.queueId).toBe(pending.id);
  updates.dispose();
});

it("refuses new identified submissions after bounded request history fills", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const token = (await updates.capability.refresh()).candidates[0]?.token;
  if (!token) throw new Error("Expected a retained update token");
  const caller = updates.forCaller("example.market");
  const ownerId = caller.ownerId;
  if (!ownerId) throw new Error("Expected a retained queue provider");

  for (let index = 0; index < 1024; index++) {
    const request = { ownerId, requestId: `request-${index}` };
    const queue = caller.queueUpdates([token], request);
    if (!queue)
      throw new Error("Expected an identified queue within the retention cap");
    expect(startReview(updates)?.queueId).toBe(queue.id);
    expect(updates.finishReview(queue.id, token, "cancelled")).toBe(true);
  }

  const refused = {
    ownerId,
    requestId: "request-after-cap",
    tokens: [token],
  };
  expect(
    caller.queueUpdates([token], {
      ownerId,
      requestId: refused.requestId,
    }),
  ).toBeUndefined();
  expect(caller.getQueueRequest(refused)).toEqual({
    status: "not-admitted",
  });
  const other = updates.forCaller("example.other");
  expect(other.queueUpdates([token], refused)).toBeDefined();
  expect(other.getQueueRequest(refused).status).toBe("admitted");
  updates.dispose();
});

it.each(["exception", "undefined"] as const)(
  "recovers an admitted queue after a lost %s result and consumer remount",
  async (lostResult) => {
    const f = fixture();
    const configuration = f.get();
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    const second = {
      ...f.plugin,
      manifest: { ...f.plugin.manifest, id: "example.other", name: "Other" },
      updateSource: { ...gitUpdateSource(f.plugin), path: "other" },
    };
    f.preview.candidates.push({
      path: "other",
      manifest: second.manifest,
      revision: "other-new",
    });
    f.set({
      ...configuration,
      catalog: { ...configuration.catalog, plugins: [f.plugin, second] },
    });
    const bridge = createPluginUpdateCapabilityBridge();
    const updates = createPluginUpdates(f.manager, f.authorize);
    let loseFirstResponse = true;
    let admittedQueueId: string | undefined;
    const submit = vi.fn(
      (
        tokens: Parameters<typeof updates.capability.queueUpdates>[0],
        request?: Parameters<typeof updates.capability.queueUpdates>[1],
      ) => updates.capability.queueUpdates(tokens, request),
    );
    const provider = {
      ...updates.capability,
      queueUpdates(
        tokens: Parameters<typeof updates.capability.queueUpdates>[0],
        request?: Parameters<typeof updates.capability.queueUpdates>[1],
      ) {
        const accepted = submit(tokens, request);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          admittedQueueId = accepted?.id;
          if (lostResult === "exception")
            throw new Error("The submission response was lost after admission");
          return undefined;
        }
        return accepted;
      },
    };
    const unregister = bridge.register({ ...updates, capability: provider });
    const snapshot = await bridge.capability.refresh();
    const first = snapshot.candidates.find(
      (candidate) => candidate.id === f.plugin.manifest.id,
    );
    const conflicting = snapshot.candidates.find(
      (candidate) => candidate.id === second.manifest.id,
    );
    if (!first || !conflicting)
      throw new Error("Expected both current update tokens");

    const requestId = "marketplace-update-request";
    const ownerId = bridge.capability.ownerId;
    if (!ownerId) throw new Error("Expected a retained queue provider");
    const capability: PluginUpdateCapability = bridge.capability;
    const requestIdentity: NonNullable<
      Parameters<PluginUpdateCapability["queueUpdates"]>[1]
    > = {
      ownerId,
      requestId,
    };
    const request: Parameters<PluginUpdateCapability["getQueueRequest"]>[0] = {
      ...requestIdentity,
      tokens: [first.token],
    };
    const firstMountChanged = vi.fn();
    const unmount = bridge.capability.subscribe(firstMountChanged);
    if (lostResult === "exception") {
      expect(() =>
        bridge.capability.queueUpdates([first.token], requestIdentity),
      ).toThrow("The submission response was lost after admission");
    } else {
      expect(
        bridge.capability.queueUpdates([first.token], requestIdentity),
      ).toBeUndefined();
    }
    expect(firstMountChanged).toHaveBeenCalledOnce();
    const recoveredStatus: ReturnType<
      PluginUpdateCapability["getQueueRequest"]
    > = capability.getQueueRequest(request);
    expect(recoveredStatus).toMatchObject({
      status: "admitted",
      queue: { id: admittedQueueId },
    });
    unmount();

    const recovered = bridge.capability.queueUpdates(
      [first.token],
      requestIdentity,
    );
    if (!recovered) throw new Error("Expected to recover the retained queue");
    expect(recovered.id).toBe(admittedQueueId);
    const remountedChanged = vi.fn();
    const unmountRemounted = bridge.capability.subscribeQueue(
      recovered.id,
      remountedChanged,
    );

    expect(
      bridge.capability.queueUpdates([conflicting.token], requestIdentity),
    ).toBeUndefined();
    expect(
      bridge.capability.getQueueRequest({
        ...request,
        tokens: [conflicting.token],
      }),
    ).toEqual({ status: "conflict" });
    expect(startReview(updates)?.queueId).toBe(recovered.id);
    expect(remountedChanged).toHaveBeenCalledOnce();
    expect(updates.finishReview(recovered.id, first.token, "cancelled")).toBe(
      true,
    );
    expect(startReview(updates)).toBeUndefined();
    unmountRemounted();
    unregister();
    updates.dispose();
  },
);

it("distinguishes no admission from unknown or conflicting queue requests", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const second = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other", name: "Other" },
    updateSource: { ...gitUpdateSource(f.plugin), path: "other" },
  };
  f.preview.candidates.push({
    path: "other",
    manifest: second.manifest,
    revision: "other-new",
  });
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [f.plugin, second] },
  });
  const bridge = createPluginUpdateCapabilityBridge();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const unregister = bridge.register(updates);
  const snapshot = await bridge.capability.refresh();
  const first = snapshot.candidates.find(
    (candidate) => candidate.id === f.plugin.manifest.id,
  );
  const conflicting = snapshot.candidates.find(
    (candidate) => candidate.id === second.manifest.id,
  );
  if (!first || !conflicting)
    throw new Error("Expected both current update tokens");
  const ownerId = bridge.capability.ownerId;
  if (!ownerId) throw new Error("Expected a retained queue provider");
  const requestIdentity = {
    ownerId,
    requestId: "marketplace-update-request",
  } as const;
  const request = {
    ...requestIdentity,
    tokens: [first.token],
  } as const;

  expect(bridge.capability.getQueueRequest(request)).toEqual({
    status: "not-admitted",
  });
  expect(
    bridge.capability.getQueueRequest({
      ...request,
      ownerId: "another-provider" as typeof request.ownerId,
    }),
  ).toEqual({ status: "unknown" });

  const accepted = bridge.capability.queueUpdates(
    request.tokens,
    requestIdentity,
  );
  if (!accepted) throw new Error("Expected queue admission");
  expect(bridge.capability.getQueueRequest(request)).toMatchObject({
    status: "admitted",
    queue: { id: accepted.id },
  });
  expect(
    bridge.capability.getQueueRequest({
      ...request,
      tokens: [conflicting.token],
    }),
  ).toEqual({ status: "conflict" });

  unregister();
  expect(bridge.capability.getQueueRequest(request)).toEqual({
    status: "unknown",
  });
  updates.dispose();
});

it("returns unknown when a queue request's provider is replaced", async () => {
  const f = fixture();
  const bridge = createPluginUpdateCapabilityBridge();
  const original = createPluginUpdates(f.manager, f.authorize);
  bridge.register(original);
  const token = (await bridge.capability.refresh()).candidates[0]?.token;
  if (!token) throw new Error("Expected a retained update token");
  const ownerId = bridge.capability.ownerId;
  if (!ownerId) throw new Error("Expected a retained queue provider");
  const requestIdentity = { ownerId, requestId: "replacement-request" };
  const request = { ...requestIdentity, tokens: [token] };
  const admitted = bridge.capability.queueUpdates([token], requestIdentity);
  if (!admitted) throw new Error("Expected the host to admit the request");

  const replacement = createPluginUpdates(f.manager, f.authorize);
  const unregisterReplacement = bridge.register(replacement);

  expect(bridge.capability.ownerId).not.toBe(ownerId);
  expect(bridge.capability.getQueueRequest(request)).toEqual({
    status: "unknown",
  });
  expect(
    bridge.capability.queueUpdates([token], requestIdentity),
  ).toBeUndefined();
  expect(bridge.capability.getQueue(admitted.id)).toBeUndefined();

  unregisterReplacement();
  original.dispose();
  replacement.dispose();
});

it("reports a replaced provider retired only after disposal ends its queued and unopened reviews", async () => {
  const f = fixture();
  const bridge = createPluginUpdateCapabilityBridge();
  const original = createPluginUpdates(f.manager, f.authorize);
  bridge.register(original);
  const token = (await bridge.capability.refresh()).candidates[0]?.token;
  const ownerId = bridge.capability.ownerId;
  if (!token || !ownerId) throw new Error("Expected a retained provider");
  const reviewing = bridge.capability.queueUpdates([token]);
  const queued = bridge.capability.queueUpdates([token]);
  const review = startReview(original);
  if (!reviewing || !queued || !review) throw new Error("Expected a review");

  const replacement = createPluginUpdates(f.manager, f.authorize);
  const unregisterReplacement = bridge.register(replacement);
  const nextOwnerId = bridge.capability.ownerId;
  if (!nextOwnerId) throw new Error("Expected a replacement provider");
  expect(original.capability.getQueue(reviewing.id)?.status).toBe("reviewing");
  expect(original.capability.getQueue(queued.id)?.status).toBe("queued");
  for (const id of [ownerId, nextOwnerId, "unseen" as typeof ownerId])
    expect(bridge.capability.getOwnerStatus?.(id)).toBe("unknown");

  original.dispose();
  expect(original.capability.getQueue(reviewing.id)?.status).toBe("cancelled");
  expect(original.capability.getQueue(queued.id)?.status).toBe("cancelled");
  for (let query = 0; query < 3; query++)
    expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("retired");
  expect(bridge.forCaller("example.market").getOwnerStatus?.(ownerId)).toBe(
    "retired",
  );
  expect(original.beginOperation(review.queueId, review.token)).toBeUndefined();
  expect(startReview(original)).toBeUndefined();
  expect(original.capability.queueUpdates([token])).toBeUndefined();
  expect(bridge.capability.getOwnerStatus?.(nextOwnerId)).toBe("unknown");
  expect(
    bridge.capability.getQueueRequest({
      ownerId,
      requestId: "historical-request",
      tokens: [token],
    }),
  ).toEqual({ status: "unknown" });

  unregisterReplacement();
  replacement.dispose();
});

it.each([
  ["finished", "installed"],
  ["ended", "failed"],
  ["cancelled", "cancelled"],
  ["reconfirmed", "failed"],
] as const)(
  "keeps a confirmed operation's provider unknown past disposal until it is %s",
  async (completion, itemStatus) => {
    const f = fixture();
    const bridge = createPluginUpdateCapabilityBridge();
    const original = createPluginUpdates(f.manager, f.authorize);
    bridge.register(original);
    const token = (await bridge.capability.refresh()).candidates[0]?.token;
    const ownerId = bridge.capability.ownerId;
    if (!token || !ownerId) throw new Error("Expected a retained provider");
    const queue = bridge.capability.queueUpdates([token]);
    let held = false;
    const statusAtRelease = vi.fn(() =>
      bridge.capability.getOwnerStatus?.(ownerId),
    );
    const hold = () => {
      held = true;
      return () => {
        statusAtRelease();
        held = false;
      };
    };
    const review = original.startNextReview(hold);
    if (!queue || !review) throw new Error("Expected a review");
    const unconfirm = original.beginOperation(queue.id, review.token);
    expect(unconfirm).toEqual(expect.any(Function));

    const replacement = createPluginUpdates(f.manager, f.authorize);
    const unregisterReplacement = bridge.register(replacement);
    original.dispose();
    if (completion === "finished" || completion === "ended")
      expect(original.capability.cancelQueue(queue.id)).toBe(true);
    expect(original.getActiveReview()).toBeDefined();
    expect(held).toBe(true);
    expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("unknown");
    if (completion === "finished") {
      expect(original.finishReview(queue.id, review.token, "updated")).toBe(
        true,
      );
    } else {
      unconfirm?.();
      expect(original.getActiveReview()).toBeDefined();
      expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("unknown");
      if (completion === "ended")
        expect(
          original.endReview(queue.id, review.token, "install failed"),
        ).toBe(true);
      else if (completion === "cancelled")
        expect(original.capability.cancelQueue(queue.id)).toBe(true);
      else
        expect(original.beginOperation(queue.id, review.token)).toBeUndefined();
    }

    expect(statusAtRelease).toHaveReturnedWith("unknown");
    expect(held).toBe(false);
    expect(original.getActiveReview()).toBeUndefined();
    expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("retired");
    expect(original.capability.getQueue(queue.id)?.items[0]?.status).toBe(
      itemStatus,
    );
    expect(original.capability.queueUpdates([token])).toBeUndefined();
    expect(original.startNextReview(hold)).toBeUndefined();
    expect(held).toBe(false);
    unregisterReplacement();
    replacement.dispose();
  },
);

it("keeps live, unregistered, evicted and restarted provider lifetimes unknown", async () => {
  const f = fixture();
  const bridge = createPluginUpdateCapabilityBridge();
  const original = createPluginUpdates(f.manager, f.authorize);
  const ownerId = original.capability.ownerId;
  if (!ownerId) throw new Error("Expected a provider identity");
  expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("unknown");
  const unregister = bridge.register(original);
  expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("unknown");
  unregister();
  expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("unknown");
  original.dispose();
  expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("retired");
  expect(
    createPluginUpdateCapabilityBridge().capability.getOwnerStatus?.(ownerId),
  ).toBe("unknown");

  const later: ReturnType<typeof createPluginUpdates>[] = [];
  for (let index = 0; index < 15; index++) {
    const next = createPluginUpdates(f.manager, f.authorize);
    bridge.register(next)();
    next.dispose();
    later.push(next);
  }
  expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("retired");
  const newest = createPluginUpdates(f.manager, f.authorize);
  const unregisterNewest = bridge.register(newest);
  expect(bridge.capability.getOwnerStatus?.(ownerId)).toBe("unknown");
  const laterIds = later.map((next) => next.capability.ownerId);
  expect(laterIds).not.toContain(undefined);
  for (const id of laterIds)
    if (id) expect(bridge.capability.getOwnerStatus?.(id)).toBe("retired");
  unregisterNewest();
  newest.dispose();
});

it("does not replay an ambiguous update request across checker lifetimes", async () => {
  const f = fixture();
  const first = createPluginUpdates(f.manager, f.authorize);
  const oldToken = (await first.capability.refresh()).candidates[0]?.token;
  if (!oldToken) throw new Error("Expected an old retained update token");

  const oldOwnerId = first.capability.ownerId;
  if (!oldOwnerId) throw new Error("Expected an old queue provider");
  const requestIdentity = { ownerId: oldOwnerId, requestId: "restart-request" };
  const admitted = first.capability.queueUpdates([oldToken], requestIdentity);
  if (!admitted) throw new Error("Expected the host to admit the request");
  first.dispose();

  const restarted = createPluginUpdates(f.manager, f.authorize);
  expect(restarted.capability.ownerId).not.toBe(oldOwnerId);
  const current = (await restarted.capability.refresh()).candidates[0];
  if (!current) throw new Error("Expected a current update token");

  expect(restarted.capability.getQueue(admitted.id)).toBeUndefined();
  expect(
    restarted.capability.queueUpdates([oldToken], requestIdentity),
  ).toBeUndefined();
  expect(
    restarted.capability.getQueueRequest({
      ownerId: oldOwnerId,
      requestId: "restart-request",
      tokens: [oldToken],
    }),
  ).toEqual({ status: "unknown" });
  expect(current.token).not.toBe(oldToken);
  restarted.dispose();
});

it("refuses more than 50 concurrently pending update queues", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const token = (await updates.capability.refresh()).candidates[0]?.token;
  if (!token) throw new Error("Expected a retained update token");

  const ids: string[] = [];
  for (let index = 0; index < 50; index++) {
    const queue = updates.capability.queueUpdates([token]);
    if (!queue)
      throw new Error("Expected queue admission under the active cap");
    ids.push(queue.id);
  }

  expect(updates.capability.queueUpdates([token])).toBeUndefined();
  expect(updates.capability.getQueue(ids[0] ?? "")?.status).toBe("queued");
  for (const id of ids) expect(updates.capability.cancelQueue(id)).toBe(true);
  updates.dispose();
});

it("queues a current known candidate when another plugin's check fails", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const other = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other" },
    updateSource: {
      ...gitUpdateSource(f.plugin),
      repository: "https://example.com/other.git",
    },
  };
  f.authorize.mockRejectedValueOnce(new Error("SSH authentication failed"));
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [other, f.plugin] },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);

  const snapshot = await updates.capability.refresh();

  expect(snapshot.status).toBe("error");
  expect(snapshot.errors).toEqual([
    { id: "example.other", message: "SSH authentication failed" },
  ]);
  const token = snapshot.candidates.find(
    (candidate) => candidate.id === f.plugin.manifest.id,
  )?.token;
  if (!token) throw new Error("Expected a known update token");
  const queue = updates.capability.queueUpdates([token]);
  expect(queue?.items[0]?.id).toBe(f.plugin.manifest.id);
  expect(startReview(updates)?.token).toBe(token);
  expect(f.imports.install).not.toHaveBeenCalled();
  updates.dispose();
});

it("coalesces concurrent explicit refreshes and reports stale after the freshness window", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let started!: () => void;
  const checking = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  );
  const updates = createPluginUpdates(f.manager, f.authorize);
  const first = updates.capability.refresh();
  const second = updates.capability.refresh();
  await checking;
  expect(updates.capability.getSnapshot().status).toBe("checking");
  finish(f.preview);
  await Promise.all([first, second]);
  expect(f.checkGit).toHaveBeenCalledOnce();
  const token = updates.capability.getSnapshot().candidates[0]?.token;
  expect(updates.capability.getSnapshot().status).toBe("fresh");
  vi.advanceTimersByTime(3_600_000);
  expect(updates.capability.getSnapshot().status).toBe("stale");
  expect(updates.capability.queueUpdates(token ? [token] : [])).toBeUndefined();
  updates.dispose();
});

it("forces one refresh after a retained check is already in progress", async () => {
  const f = fixture();
  let started!: () => void;
  const checking = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  );
  const updates = createPluginUpdates(f.manager, f.authorize);
  const scheduled = updates.check();

  try {
    await checking;
    const first = updates.capability.refresh();
    const second = updates.capability.refresh();
    expect(second).toBe(first);
    finish(f.preview);
    const snapshot = await first;
    await scheduled;
    expect(snapshot.status).toBe("fresh");
    expect(f.checkGit).toHaveBeenCalledTimes(2);
  } finally {
    finish?.(f.preview);
    updates.dispose();
  }
});

it("refuses queued confirmation while a retained refresh is checking", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const token = (await updates.capability.refresh()).candidates[0]?.token;
  if (!token) throw new Error("Expected a retained update token");
  const queue = updates.capability.queueUpdates([token]);
  if (!queue) throw new Error("Expected an accepted fresh queue");
  expect(startReview(updates)?.token).toBe(token);

  let started!: () => void;
  let finish!: (preview: ImportPreview) => void;
  const checking = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.checkGit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  );
  const refresh = updates.capability.refresh();
  try {
    await checking;
    expect(updates.capability.getSnapshot().status).toBe("checking");
    expect(updates.isCurrentToken(token)).toBe(false);
    expect(updates.beginOperation(queue.id, token)).toBeUndefined();
  } finally {
    finish(f.preview);
  }
  await refresh;
  expect(updates.capability.getQueue(queue.id)).toMatchObject({
    status: "failed",
    items: [{ status: "failed" }],
  });
  expect(f.imports.install).not.toHaveBeenCalled();
  updates.dispose();
});

it.each(["revision", "publisher", "enabled", "source", "choice"] as const)(
  "rejects a candidate token after installed %s drift",
  async (field) => {
    const f = fixture();
    const updates = createPluginUpdates(f.manager, f.authorize);
    const { candidates } = await updates.capability.refresh();
    const token = candidates[0]?.token;
    if (!token) throw new Error("Expected a retained update token");

    if (field === "revision") f.plugin.revision = "newer-installed";
    if (field === "publisher") f.plugin.publisher = "changed-publisher";
    if (field === "enabled") f.plugin.enabled = false;
    if (field === "source")
      f.plugin.updateSource = {
        ...gitUpdateSource(f.plugin),
        reference: "stable",
      };
    if (field === "choice") f.plugin.updateChecks = false;
    f.set(f.get());

    expect(updates.capability.getSnapshot().status).toBe(
      field === "choice" ? "disabled" : "stale",
    );
    expect(updates.capability.queueUpdates([token])).toBeUndefined();
    expect(updates.capability.getSnapshot().candidates).toEqual([]);
    expect(f.imports.install).not.toHaveBeenCalled();
    updates.dispose();
  },
);

it("serializes queue reviews and preserves a confirmed operation when cancelling pending items", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const second = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other", name: "Other" },
    updateSource: { ...gitUpdateSource(f.plugin), path: "other" },
  };
  f.preview.candidates.push({
    path: "other",
    manifest: second.manifest,
    revision: "other-new",
  });
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [f.plugin, second] },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  const { candidates } = await updates.capability.refresh();
  const queue = updates.capability.queueUpdates(
    candidates.map((candidate) => candidate.token),
  );
  if (!queue) throw new Error("Expected an accepted fresh queue");
  const queueListener = vi.fn();
  const unsubscribeQueue = updates.capability.subscribeQueue(
    queue.id,
    queueListener,
  );

  const first = startReview(updates);
  if (!first) throw new Error("Expected the first item to start reviewing");
  expect(
    updates.capability.getQueue(queue.id)?.items.map((item) => item.status),
  ).toEqual(["reviewing", "queued"]);
  expect(startReview(updates)).toBeUndefined();
  const unconfirm = updates.beginOperation(queue.id, first.token);
  expect(unconfirm).toEqual(expect.any(Function));
  expect(queueListener).toHaveBeenCalledOnce();

  expect(updates.capability.cancelQueue(queue.id)).toBe(true);
  expect(
    updates.capability.getQueue(queue.id)?.items.map((item) => item.status),
  ).toEqual(["reviewing", "cancelled"]);
  expect(f.imports.install).not.toHaveBeenCalled();
  updates.finishReview(queue.id, first.token, "updated");
  unconfirm?.();
  expect(updates.capability.getQueue(queue.id)).toMatchObject({
    status: "partial",
    items: [{ status: "installed" }, { status: "cancelled" }],
  });
  unsubscribeQueue();
  updates.dispose();
});

it("refuses to begin an update operation after its queued review is cancelled", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const token = (await updates.capability.refresh()).candidates[0]?.token;
  if (!token) throw new Error("Expected a retained update token");
  const queue = updates.capability.queueUpdates([token]);
  if (!queue) throw new Error("Expected an accepted fresh queue");
  expect(startReview(updates)?.token).toBe(token);
  expect(updates.capability.cancelQueue(queue.id)).toBe(true);

  expect(updates.beginOperation(queue.id, token)).toBeUndefined();
  expect(updates.capability.getQueue(queue.id)).toMatchObject({
    status: "cancelled",
    items: [{ status: "cancelled" }],
  });
  expect(f.imports.install).not.toHaveBeenCalled();
  updates.dispose();
});

it("continues a serialized queue after a review fails before confirmation", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const second = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other", name: "Other" },
    updateSource: { ...gitUpdateSource(f.plugin), path: "other" },
  };
  f.preview.candidates.push({
    path: "other",
    manifest: second.manifest,
    revision: "other-new",
  });
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [f.plugin, second] },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  const { candidates } = await updates.capability.refresh();
  const queue = updates.capability.queueUpdates(
    candidates.map((candidate) => candidate.token),
  );
  if (!queue) throw new Error("Expected an accepted fresh queue");
  const first = startReview(updates);
  if (!first) throw new Error("Expected the first item to start reviewing");

  expect(
    updates.endReview(queue.id, first.token, "Review source changed"),
  ).toBe(true);
  await updates.check();
  expect(startReview(updates)?.update.id).toBe(second.manifest.id);
  expect(updates.capability.getQueue(queue.id)).toMatchObject({
    status: "reviewing",
    items: [
      { status: "failed", error: "Review source changed" },
      { status: "reviewing" },
    ],
  });
  updates.dispose();
});

it("refuses confirmation when a queued candidate expires after its review opens", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const token = (await updates.capability.refresh()).candidates[0]?.token;
  if (!token) throw new Error("Expected a retained update token");
  const queue = updates.capability.queueUpdates([token]);
  if (!queue) throw new Error("Expected an accepted fresh queue");
  expect(startReview(updates)?.token).toBe(token);

  vi.advanceTimersByTime(3_600_000);

  expect(updates.isCurrentToken(token)).toBe(false);
  expect(updates.beginOperation(queue.id, token)).toBeUndefined();
  expect(updates.capability.getQueue(queue.id)).toMatchObject({
    status: "failed",
    items: [
      {
        status: "failed",
        error: "This update candidate is stale. Refresh and try again.",
      },
    ],
  });
  expect(f.imports.install).not.toHaveBeenCalled();
  updates.dispose();
});

it("serializes review queues submitted by separate callers", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const token = (await updates.capability.refresh()).candidates[0]?.token;
  if (!token) throw new Error("Expected a retained update token");
  const firstQueue = updates.capability.queueUpdates([token]);
  const secondQueue = updates.capability.queueUpdates([token]);
  if (!firstQueue || !secondQueue)
    throw new Error("Expected both fresh queues to be accepted");

  expect(startReview(updates)?.queueId).toBe(firstQueue.id);
  expect(startReview(updates)).toBeUndefined();
  expect(updates.capability.getQueue(secondQueue.id)?.items[0]?.status).toBe(
    "queued",
  );
  updates.finishReview(firstQueue.id, token, "updated");
  expect(startReview(updates)?.queueId).toBe(secondQueue.id);
  updates.dispose();
});

it.each(["failed", "active"] as const)(
  "retains the installed update's first %s activation outcome in queue history",
  async (status) => {
    const f = fixture();
    const updates = createPluginUpdates(f.manager, f.authorize);
    const token = (await updates.capability.refresh()).candidates[0]?.token;
    if (!token) throw new Error("Expected a retained update token");
    const queue = updates.capability.queueUpdates([token]);
    if (!queue) throw new Error("Expected an accepted fresh queue");
    expect(startReview(updates)?.token).toBe(token);
    expect(updates.beginOperation(queue.id, token)).toEqual(
      expect.any(Function),
    );

    const configuration = f.get();
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    f.plugin.revision = "new";
    f.set({
      ...configuration,
      catalog: { ...configuration.catalog, plugins: [f.plugin] },
    });
    f.setActivation({
      "example.notes": {
        revision: "new",
        status: "starting",
        error: null,
      },
    });
    updates.finishReview(queue.id, token, "updated");
    expect(updates.capability.getQueue(queue.id)?.items[0]?.status).toBe(
      "installed",
    );

    f.setActivation({
      "example.notes": {
        revision: "new",
        status,
        error: status === "failed" ? "Activation failed" : null,
      },
    });
    expect(updates.capability.getQueue(queue.id)).toMatchObject({
      status: status === "failed" ? "partial" : "completed",
      items: [
        {
          status: status === "failed" ? "partial" : "installed",
        },
      ],
    });
    const settled = updates.capability.getQueue(queue.id);
    if (status === "failed")
      expect(settled?.items[0]?.error).toBe(
        "The update was installed, but activation failed: Activation failed",
      );
    f.setActivation({
      "example.notes": {
        revision: "new",
        status: status === "failed" ? "active" : "failed",
        error: status === "failed" ? null : "Later crash",
      },
    });
    expect(updates.capability.getQueue(queue.id)).toBe(settled);
    updates.dispose();
  },
);

it("continues an accepted queue when an earlier update makes the aggregate snapshot stale", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const second = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other", name: "Other" },
    updateSource: { ...gitUpdateSource(f.plugin), path: "other" },
  };
  f.preview.candidates.push({
    path: "other",
    manifest: second.manifest,
    revision: "other-new",
  });
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [f.plugin, second] },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  const { candidates } = await updates.capability.refresh();
  const queue = updates.capability.queueUpdates(
    candidates.map((candidate) => candidate.token),
  );
  if (!queue) throw new Error("Expected an accepted fresh queue");

  const first = startReview(updates);
  if (!first) throw new Error("Expected the first item to start reviewing");
  expect(updates.beginOperation(queue.id, first.token)).toEqual(
    expect.any(Function),
  );
  f.plugin.revision = "new";
  f.set(f.get());
  updates.finishReview(queue.id, first.token, "updated");

  expect(updates.capability.getSnapshot().status).toBe("stale");
  expect(startReview(updates)?.token).toBe(
    candidates.find((candidate) => candidate.id === second.manifest.id)?.token,
  );
  expect(updates.capability.getQueue(queue.id)).toMatchObject({
    status: "reviewing",
    items: [{ status: "installed" }, { status: "reviewing" }],
  });
  updates.dispose();
});

it("distinguishes a dismissed review from a failed confirmed operation", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const { candidates } = await updates.capability.refresh();
  const token = candidates[0]?.token;
  if (!token) throw new Error("Expected a retained update token");

  const rejected = updates.capability.queueUpdates([token]);
  if (!rejected) throw new Error("Expected an accepted fresh queue");
  expect(startReview(updates)?.token).toBe(token);
  expect(updates.endReview(rejected.id, token)).toBe(true);
  expect(updates.capability.getQueue(rejected.id)).toMatchObject({
    status: "cancelled",
    items: [{ status: "cancelled" }],
  });

  const failed = updates.capability.queueUpdates([token]);
  if (!failed)
    throw new Error("Expected the still-current token to be reusable");
  expect(startReview(updates)?.token).toBe(token);
  const unconfirm = updates.beginOperation(failed.id, token);
  expect(unconfirm).toEqual(expect.any(Function));
  unconfirm?.();
  expect(updates.endReview(failed.id, token, "update operation failed")).toBe(
    true,
  );
  expect(updates.capability.getQueue(failed.id)).toMatchObject({
    status: "failed",
    items: [{ status: "failed", error: "update operation failed" }],
  });
  updates.dispose();
});

it("keeps the installer bridge unavailable until the retained checker registers", async () => {
  const f = fixture();
  const bridge = createPluginUpdateCapabilityBridge();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const ownerId = updates.capability.ownerId;
  if (!ownerId) throw new Error("Expected a retained queue provider");
  const request = {
    ownerId,
    requestId: "not-available",
    tokens: [],
  } as const;

  expect(bridge.capability.getSnapshot().status).toBe("unavailable");
  expect(bridge.capability.getQueueRequest(request)).toEqual({
    status: "unknown",
  });
  const unregister = bridge.register(updates);
  expect(bridge.capability.getQueueRequest(request)).toEqual({
    status: "not-admitted",
  });
  await updates.check();
  expect(bridge.capability.getSnapshot().status).toBe("fresh");
  unregister();
  expect(bridge.capability.getSnapshot().status).toBe("unavailable");
  expect(bridge.capability.getQueueRequest(request)).toEqual({
    status: "unknown",
  });
  updates.dispose();
});

it("continues notifying update subscribers after one subscriber throws", async () => {
  const f = fixture();
  const bridge = createPluginUpdateCapabilityBridge();
  const updates = createPluginUpdates(f.manager, f.authorize);
  const broken = vi.fn(() => {
    throw new Error("consumer callback failed");
  });
  const listener = vi.fn();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  bridge.capability.subscribe(broken);
  bridge.capability.subscribe(listener);
  let unregister = () => {};

  try {
    unregister = bridge.register(updates);
    expect(broken).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    await expect(updates.capability.refresh()).resolves.toMatchObject({
      status: "fresh",
    });
    expect(listener.mock.calls.length).toBeGreaterThan(1);
  } finally {
    unregister();
    log.mockRestore();
    updates.dispose();
  }
});

it("keeps public update and queue snapshots from being mutated by consumers", async () => {
  const f = fixture();
  const bridge = createPluginUpdateCapabilityBridge();
  expect(Reflect.set(bridge.capability.getSnapshot(), "status", "fresh")).toBe(
    false,
  );

  const updates = createPluginUpdates(f.manager, f.authorize);
  const unregister = bridge.register(updates);
  const snapshot = await bridge.capability.refresh();
  const candidate = snapshot.candidates[0];
  if (!candidate) throw new Error("Expected a retained candidate");
  expect(Reflect.set(candidate, "candidateRevision", "forged-revision")).toBe(
    false,
  );
  expect(bridge.capability.getSnapshot().candidates[0]?.candidateRevision).toBe(
    "new",
  );

  const queue = bridge.capability.queueUpdates([candidate.token]);
  if (!queue) throw new Error("Expected an accepted fresh queue");
  const item = queue.items[0];
  if (!item) throw new Error("Expected a queued item");
  expect(Reflect.set(item, "status", "installed")).toBe(false);
  expect(bridge.capability.getQueue(queue.id)?.items[0]?.status).toBe("queued");
  unregister();
  updates.dispose();
});
