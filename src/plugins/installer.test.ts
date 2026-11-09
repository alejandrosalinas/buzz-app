import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import {
  createPluginInstallCore,
  createPluginInstallRequests,
  parsePluginInstallSource,
  createPluginInstallerService,
  type PluginInstaller,
  type PluginInstallOrigin,
} from "./installer";
import type { ConfigurationState, PluginInfo } from "./types";

const commit = "0123456789abcdef0123456789abcdef01234567";
const base = {
  repository: "https://example.com/team/plugins.git",
  reference: "main",
};

it("accepts HTTPS, SSH and scp-style repositories and normalizes the commit", () => {
  for (const repository of [
    "https://example.com/team/plugins.git",
    "ssh://git@example.com/team/plugins.git",
    "git@example.com:team/plugins.git",
    "https://github.com/owner/repository",
    "git@github.com:owner/repository.git",
    "ssh://org-1234@github.com/owner/repository.git",
    "org-1234@github.com:owner/repository.git",
  ])
    expect(parsePluginInstallSource({ ...base, repository })).toEqual({
      ...base,
      repository,
    });
  expect(
    parsePluginInstallSource({
      ...base,
      path: "dist/plugin",
      commit: commit.toUpperCase(),
    }),
  ).toEqual({ ...base, path: "dist/plugin", commit });
  expect(
    parsePluginInstallSource({ ...base, commit: "a".repeat(64) }),
  ).toMatchObject({ commit: "a".repeat(64) });
  expect(parsePluginInstallSource({ ...base, path: "." })).toMatchObject({
    path: ".",
  });
});

it("accepts a plugin artifact pinned by id and SHA-256", () => {
  const source = {
    id: "example.plugin",
    url: "https://artifacts.example.com/plugins/a.json",
    sha256: "AB".repeat(32),
  };
  expect(parsePluginInstallSource(source)).toEqual({
    ...source,
    sha256: "ab".repeat(32),
  });
  for (const invalid of [
    { ...source, url: "http://artifacts.example.com/a.json" },
    { ...source, url: "https://artifacts.example.com/a.json?token=x" },
    { ...source, sha256: "ab".repeat(20) },
    { ...source, id: "Example" },
    { ...source, reference: "main" },
    { url: source.url, sha256: source.sha256 },
  ])
    expect(parsePluginInstallSource(invalid)).toBeNull();
});

it.each([
  ["http transport", { repository: "http://example.com/team/plugins.git" }],
  ["file transport", { repository: "file:///tmp/plugins" }],
  ["bare GitHub shorthand", { repository: "owner/repository" }],
  ["a local path", { repository: "/tmp/plugins" }],
  ["a password", { repository: "https://user:secret@example.com/a.git" }],
  ["HTTPS credentials", { repository: "https://user@example.com/a.git" }],
  ["a query", { repository: "https://example.com/a.git?x=1" }],
  ["a fragment", { repository: "https://example.com/a.git#x" }],
  ["no repository path", { repository: "https://example.com/" }],
  ["whitespace", { repository: "https://example.com/a b.git" }],
  ["a non-string repository", { repository: 4 }],
  ["an empty reference", { reference: "" }],
  ["an option-like reference", { reference: "--upload-pack=x" }],
  ["a reference with spaces", { reference: "my branch" }],
  ["a reference with a parent segment", { reference: "a..b" }],
  ["a reference ending in a slash", { reference: "a/" }],
  ["an overlong reference", { reference: "a".repeat(201) }],
  ["an absolute path", { path: "/etc" }],
  ["a parent path", { path: "../x" }],
  ["an embedded parent path", { path: "a/../x" }],
  ["a backslash path", { path: "a\\b" }],
  ["a drive path", { path: "C:/x" }],
  ["an empty path segment", { path: "a//b" }],
  ["a trailing slash path", { path: "a/" }],
  ["an empty path", { path: "" }],
  [
    "an option-like ssh user",
    { repository: "ssh://-oProxyCommand@example.com/a.git" },
  ],
  [
    "an ssh user with unusual characters",
    { repository: "ssh://de%3Bploy@example.com/a.git" },
  ],
  ["an option-like scp user", { repository: "-oProxy@example.com:team/a.git" }],
  [
    "an option-like https host",
    { repository: "https://-oProxy.example/a.git" },
  ],
  ["an option-like scp host", { repository: "git@-oProxy:team/a.git" }],
  ["a non-ASCII host", { repository: "https://exаmple.com/a.git" }],
  ["a format character", { repository: "https://example.com/a\u202e.git" }],
  [
    "a GitHub tree URL",
    { repository: "https://github.com/owner/repo/tree/main" },
  ],
  ["a GitHub owner only", { repository: "https://github.com/owner" }],
  [
    "a GitHub tree URL on www",
    { repository: "https://www.github.com/owner/repo/tree/main" },
  ],
  [
    "a GitHub tree URL on a rooted host",
    { repository: "https://github.com./owner/repo/tree/main" },
  ],
  ["a percent-encoded host", { repository: "https://git%68ub.com/o/r.git" }],
  ["a percent in an ssh host", { repository: "ssh://git@exa%6dple.com/o/r" }],
  ["a short commit", { commit: "abc1234" }],
  ["a non-hex commit", { commit: "g".repeat(40) }],
  ["a 41-character commit", { commit: "a".repeat(41) }],
  ["a non-string commit", { commit: 1 }],
])("rejects %s", (_name, change) => {
  expect(parsePluginInstallSource({ ...base, ...change })).toBeNull();
});

it("rejects a missing or non-object request", () => {
  expect(parsePluginInstallSource(undefined)).toBeNull();
  expect(parsePluginInstallSource("https://example.com/a.git")).toBeNull();
  expect(parsePluginInstallSource({ repository: base.repository })).toBeNull();
});

const origin: PluginInstallOrigin = { id: "example.market", name: "Market" };

it("holds one request at a time and resolves it with the user's outcome", async () => {
  const requests = createPluginInstallRequests();
  const listener = vi.fn();
  requests.subscribe(listener);
  const first = requests.request(base, origin);
  const pending = requests.snapshot();
  expect(pending).toMatchObject({ source: base, origin });
  await expect(
    requests.request({ ...base, reference: "other" }, origin),
  ).resolves.toBe("unavailable");
  expect(requests.snapshot()).toBe(pending);
  requests.settle((pending?.id ?? 0) + 1, "installed");
  expect(requests.snapshot()).toBe(pending);
  requests.settle(pending?.id ?? 0, "updated");
  await expect(first).resolves.toBe("updated");
  expect(requests.snapshot()).toBeUndefined();
  requests.settle(pending?.id ?? 0, "installed");
  expect(listener).toHaveBeenCalledTimes(2);
  const next = requests.request(base, origin);
  expect(requests.snapshot()?.id).not.toBe(pending?.id);
  requests.settle(requests.snapshot()?.id ?? 0, "cancelled");
  await expect(next).resolves.toBe("cancelled");
});

it("refuses to claim a request while a review dialog is open and settles it unavailable", async () => {
  const requests = createPluginInstallRequests();
  const waiting = requests.request(base, origin);
  const id = requests.snapshot()?.id ?? 0;
  const release = requests.holdReview();
  expect(requests.claim(id)).toBe(false);
  await expect(waiting).resolves.toBe("unavailable");
  expect(requests.snapshot()).toBeUndefined();
  release();
  const next = requests.request(base, origin);
  expect(requests.claim(requests.snapshot()?.id ?? 0)).toBe(true);
  expect(requests.claim(id)).toBe(false);
  requests.settle(requests.snapshot()?.id ?? 0, "cancelled");
  await next;
});

it("cancels an unclaimed request after its time to live and keeps a claimed one", async () => {
  vi.useFakeTimers();
  try {
    const requests = createPluginInstallRequests({ ttlMs: 1000 });
    const unclaimed = requests.request(base, origin);
    vi.advanceTimersByTime(999);
    expect(requests.snapshot()).toBeDefined();
    vi.advanceTimersByTime(1);
    await expect(unclaimed).resolves.toBe("cancelled");
    expect(requests.snapshot()).toBeUndefined();

    const claimed = requests.request(base, origin);
    requests.claim(requests.snapshot()?.id ?? 0);
    vi.advanceTimersByTime(60_000);
    expect(requests.snapshot()).toBeDefined();
    requests.settle(requests.snapshot()?.id ?? 0, "installed");
    await expect(claimed).resolves.toBe("installed");
  } finally {
    vi.useRealTimers();
  }
});

it("lets a confirmed install outlive its requester and cancels once it is released", async () => {
  const requests = createPluginInstallRequests();
  const kept = requests.request(base, origin);
  const keptId = requests.snapshot()?.id ?? 0;
  requests.confirm(keptId);
  requests.end(keptId);
  expect(requests.snapshot()?.id).toBe(keptId);
  expect(requests.claim(keptId)).toBe(false);
  requests.settle(keptId, "updated");
  await expect(kept).resolves.toBe("updated");

  const failed = requests.request(base, origin);
  const failedId = requests.snapshot()?.id ?? 0;
  const release = requests.confirm(failedId);
  requests.end(failedId);
  release();
  await expect(failed).resolves.toBe("cancelled");

  const plain = requests.request(base, origin);
  requests.end(requests.snapshot()?.id ?? 0);
  await expect(plain).resolves.toBe("cancelled");
});

it("refuses a request while any review dialog is open", async () => {
  const requests = createPluginInstallRequests();
  const release = requests.holdReview();
  const second = requests.holdReview();
  await expect(requests.request(base, origin)).resolves.toBe("unavailable");
  release();
  release();
  await expect(requests.request(base, origin)).resolves.toBe("unavailable");
  second();
  const allowed = requests.request(base, origin);
  expect(requests.snapshot()).toBeDefined();
  requests.settle(requests.snapshot()?.id ?? 0, "cancelled");
  await expect(allowed).resolves.toBe("cancelled");
});

const info = (id: string, name = id): PluginInfo => ({
  manifest: { id, name, apiVersion: 1 },
  source: "external",
  enabled: true,
  revision: "r1",
  previous: null,
  reloadable: true,
  error: null,
});
const ready = (plugins: PluginInfo[]) =>
  ({
    status: "ready",
    externalPluginsPaused: false,
    catalog: { profile: "test", location: "test", plugins },
  }) as ConfigurationState;

function setup({
  imports = {} as object | null,
  open = vi.fn(async () => ({ status: "opened" })),
  plugins = [info("example.market", "Market")],
}: {
  imports?: object | null;
  open?: () => Promise<{ status: string }>;
  plugins?: PluginInfo[];
} = {}) {
  let configuration: ConfigurationState = ready(plugins);
  const managerListeners = new Set<() => void>();
  const manager = {
    imports: imports ?? undefined,
    snapshot: () => ({ configuration }),
    subscribe(listener: () => void) {
      managerListeners.add(listener);
      return () => managerListeners.delete(listener);
    },
  };
  const requests = createPluginInstallRequests();
  const core = createPluginInstallCore({
    plugins: manager as never,
    requests,
    openPlugins: open as never,
  });
  const root = new Context();
  const service = createPluginInstallerService(root, { core });
  const fibers: { dispose(): Promise<void> }[] = [];
  return {
    service,
    requests,
    core,
    manager,
    open,
    managerListenerCount: () => managerListeners.size,
    as(id: string) {
      let installer: PluginInstaller | undefined;
      const fiber = root
        .extend({ pluginOwner: { id, revision: "one" } })
        .plugin((ctx) => {
          installer = ctx.reflect.get("pluginInstaller");
        });
      fibers.push(fiber);
      return fiber.await().then(() => installer as PluginInstaller);
    },
    fibers,
    set(next: ConfigurationState) {
      configuration = next;
      for (const listener of managerListeners) listener();
    },
  };
}
const settleRequest = (
  requests: ReturnType<typeof createPluginInstallRequests>,
  outcome: "installed" | "updated" | "cancelled",
) => requests.settle(requests.snapshot()?.id ?? 0, outcome);

it("checks installed ids even when disabled, source-backed, or contribution-free", async () => {
  const folder = info("example.folder");
  folder.enabled = false;
  folder.updateSource = { root: "/plugins/example-folder", path: "." };
  const git = info("example.git");
  git.updateSource = {
    repository: "https://example.com/plugins.git",
    reference: "main",
    path: "example-git",
  };
  const contributionFree = info("example.contributionless");
  const { as } = setup({ plugins: [folder, git, contributionFree] });
  const installer = await as("example.market");

  expect(installer.getInstallationStatus("example.folder")).toBe("installed");
  expect(installer.getInstallationStatus("example.git")).toBe("installed");
  expect(installer.getInstallationStatus("example.contributionless")).toBe(
    "installed",
  );
  expect(installer.getInstallationStatus("example.missing")).toBe("absent");
});

it("keeps unavailable configuration distinct from absence and emits presence changes", async () => {
  const { as, set } = setup({ plugins: [] });
  const installer = await as("example.market");
  const changes: string[] = [];
  const stop = installer.subscribeInstallationStatus(
    "example.plugin",
    (status) => {
      changes.push(status);
    },
  );

  expect(installer.getInstallationStatus("example.plugin")).toBe("absent");
  set({ status: "loading" });
  expect(installer.getInstallationStatus("example.plugin")).toBe("unavailable");
  set({
    status: "recovery",
    reason: "settings need recovery",
    canReset: false,
  });
  expect(installer.getInstallationStatus("example.plugin")).toBe("unavailable");

  const installed = info("example.plugin");
  installed.enabled = false;
  set(ready([installed]));
  expect(installer.getInstallationStatus("example.plugin")).toBe("installed");
  set(ready([]));
  expect(installer.getInstallationStatus("example.plugin")).toBe("absent");
  expect(changes).toEqual(["unavailable", "installed", "absent"]);
  stop();
});

it("stops notifying when a status subscription is explicitly removed", async () => {
  const { as, set, managerListenerCount } = setup({ plugins: [] });
  const installer = await as("example.market");
  const listener = vi.fn();
  const stop = installer.subscribeInstallationStatus(
    "example.plugin",
    listener,
  );
  expect(managerListenerCount()).toBe(1);

  set(ready([info("example.plugin")]));
  expect(listener).toHaveBeenCalledOnce();
  stop();
  expect(managerListenerCount()).toBe(0);
  set(ready([]));
  set(ready([info("example.plugin")]));
  expect(listener).toHaveBeenCalledOnce();
});

it("stops notifying when the calling plugin is disposed", async () => {
  const { as, set, fibers, managerListenerCount } = setup({ plugins: [] });
  const installer = await as("example.market");
  const listener = vi.fn();
  const stop = installer.subscribeInstallationStatus(
    "example.plugin",
    listener,
  );
  expect(managerListenerCount()).toBe(1);

  set(ready([info("example.plugin")]));
  expect(listener).toHaveBeenCalledOnce();
  await fibers[0]?.dispose();
  expect(managerListenerCount()).toBe(0);
  set(ready([]));
  set(ready([info("example.plugin")]));
  expect(listener).toHaveBeenCalledOnce();
  stop();
});

it("keeps status listener errors from stopping other manager notifications", async () => {
  const { as, set, manager } = setup({ plugins: [] });
  const installer = await as("example.market");
  const listener = vi.fn(() => {
    throw new Error("listener failed");
  });
  const following = vi.fn();
  const stopStatus = installer.subscribeInstallationStatus(
    "example.plugin",
    listener,
  );
  const stopFollowing = manager.subscribe(following);

  expect(() => set(ready([info("example.plugin")]))).not.toThrow();
  expect(listener).toHaveBeenCalledWith("installed");
  expect(following).toHaveBeenCalledOnce();

  stopStatus();
  stopFollowing();
});

it("names the request after the calling plugin and resolves with the user's outcome", async () => {
  const { requests, open, as } = setup({
    plugins: [info("example.market", "  Plugin\n  Market ")],
  });
  const installer = await as("example.market");
  const outcome = installer.requestInstall({ ...base, commit });
  expect(open).toHaveBeenCalledOnce();
  expect(requests.snapshot()).toMatchObject({
    source: { ...base, commit },
    origin: { id: "example.market", name: "Plugin Market" },
  });
  settleRequest(requests, "installed");
  await expect(outcome).resolves.toBe("installed");
});

it("falls back to the plugin id for a blank name and rejects an unattributed call", async () => {
  const { requests, service, as } = setup({
    plugins: [info("example.market", " \t ")],
  });
  const outcome = (await as("example.market")).requestInstall(base);
  expect(requests.snapshot()?.origin).toEqual({
    id: "example.market",
    name: "example.market",
  });
  settleRequest(requests, "cancelled");
  await expect(outcome).resolves.toBe("cancelled");
  await expect(service.requestInstall(base)).rejects.toThrow(
    /installed plugin/,
  );
});

it("is unavailable from a plugin that has already been disposed, without opening a review", async () => {
  const { requests, open, as, fibers } = setup();
  const installer = await as("example.market");
  await fibers[0]?.dispose();
  await expect(installer.requestInstall(base)).resolves.toBe("unavailable");
  expect(open).not.toHaveBeenCalled();
  expect(requests.snapshot()).toBeUndefined();
});

it("rejects an invalid request without opening Settings", async () => {
  const { open, requests, as } = setup();
  const installer = await as("example.market");
  await expect(
    installer.requestInstall({
      ...base,
      repository: "http://example.com/a.git",
    }),
  ).rejects.toThrow(/HTTPS, SSH or scp-style/);
  await expect(
    installer.requestInstall({ ...base, path: "../x" }),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(requests.snapshot()).toBeUndefined();
});

it("does not leave a request waiting when Settings cannot open", async () => {
  const failed = setup({ open: vi.fn(async () => ({ status: "failed" })) });
  await expect(
    (await failed.as("example.market")).requestInstall(base),
  ).resolves.toBe("unavailable");
  expect(failed.requests.snapshot()).toBeUndefined();

  const superseded = setup({
    open: vi.fn(async () => ({ status: "superseded" })),
  });
  await expect(
    (await superseded.as("example.market")).requestInstall(base),
  ).resolves.toBe("cancelled");

  const rejected = setup({
    open: vi.fn(async () => {
      throw new Error("no");
    }),
  });
  await expect(
    (await rejected.as("example.market")).requestInstall(base),
  ).resolves.toBe("unavailable");
});

it("keeps host objects out of the handle plugins receive", async () => {
  const { as, service, core, manager } = setup();
  const installer = await as("example.market");
  const reachable = new Set<unknown>();
  for (const handle of [installer, service]) {
    let object: object | null = handle as object;
    while (object && object !== Object.prototype) {
      for (const key of Reflect.ownKeys(object)) {
        if (key === "ctx") continue;
        reachable.add(Reflect.get(object, key, handle));
      }
      object = Object.getPrototypeOf(object);
    }
  }
  expect(reachable).not.toContain(core);
  expect(reachable).not.toContain(manager);
  for (const value of reachable)
    if (typeof value === "object" && value)
      expect(Object.values(value)).not.toContain(core);
  const names = Object.getOwnPropertyNames(installer);
  expect(names).not.toContain("host");
  expect(names).not.toContain("core");
  expect((installer as unknown as { host?: unknown }).host).toBeUndefined();
  expect((installer as unknown as { core?: unknown }).core).toBeUndefined();
});

it("cancels a waiting request when the requesting plugin is disabled", async () => {
  const { requests, open, as, fibers } = setup();
  const installer = await as("example.market");
  const other = await as("example.other");
  const outcome = installer.requestInstall(base);
  expect(requests.snapshot()).toBeDefined();
  await fibers[1]?.dispose();
  expect(requests.snapshot()).toBeDefined();
  await fibers[0]?.dispose();
  await expect(outcome).resolves.toBe("cancelled");
  expect(requests.snapshot()).toBeUndefined();
  expect(open).toHaveBeenCalledOnce();
  void other;
});

it("stops watching the requester once its request has settled", async () => {
  const { requests, as, fibers } = setup();
  const installer = await as("example.market");
  const outcome = installer.requestInstall(base);
  settleRequest(requests, "installed");
  await outcome;
  await fibers[0]?.dispose();
  const next = (await as("example.other")).requestInstall(base);
  expect(requests.snapshot()).toBeDefined();
  settleRequest(requests, "installed");
  await next;
});

it("is unavailable without native imports, before the catalog is ready, or while another request waits", async () => {
  const none = setup({ imports: null });
  await expect(
    (await none.as("example.market")).requestInstall(base),
  ).resolves.toBe("unavailable");
  expect(none.open).not.toHaveBeenCalled();
  expect(none.requests.snapshot()).toBeUndefined();

  const loading = setup();
  loading.set({ status: "loading" });
  await expect(
    (await loading.as("example.market")).requestInstall(base),
  ).resolves.toBe("unavailable");

  const busy = setup();
  const installer = await busy.as("example.market");
  const first = installer.requestInstall(base);
  await expect(
    installer.requestInstall({ ...base, reference: "other" }),
  ).resolves.toBe("unavailable");
  expect(busy.open).toHaveBeenCalledOnce();
  expect(busy.requests.snapshot()?.source).toMatchObject({ reference: "main" });
  settleRequest(busy.requests, "cancelled");
  await expect(first).resolves.toBe("cancelled");
});

it("reports a confirmed self-update as updated even though it replaces the requester", async () => {
  const { requests, as, fibers } = setup();
  const installer = await as("example.market");
  const outcome = installer.requestInstall(base);
  const id = requests.snapshot()?.id ?? 0;
  requests.confirm(id);
  await fibers[0]?.dispose();
  expect(requests.snapshot()?.id).toBe(id);
  requests.settle(id, "updated");
  await expect(outcome).resolves.toBe("updated");
});

it("advertises URL sources and admits a URL request for review", async () => {
  const { as, requests, open } = setup();
  const installer = await as("example.market");
  expect(installer.sources).toEqual(["git", "url"]);
  const source = {
    id: "example.artifact",
    url: "https://cdn.example.com/a.json",
    sha256: "e".repeat(64),
  };
  const outcome = installer.requestInstall(source);
  expect(requests.snapshot()?.source).toEqual(source);
  expect(open).toHaveBeenCalledOnce();
  settleRequest(requests, "cancelled");
  await expect(outcome).resolves.toBe("cancelled");
});
