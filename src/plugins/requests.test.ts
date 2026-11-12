import { describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "./api";
import { createPluginRequests } from "./requests";
import type {
  Catalog,
  ImportPreview,
  ManagedPlugins,
  PluginImports,
  PluginInfo,
} from "./types";

const AGENT = { pubkey: "a".repeat(64), name: "Builder" };
const COMMIT = "c".repeat(40);
const manifest = (id: string, extra: Partial<PluginManifest> = {}) =>
  ({ id, name: id.toUpperCase(), apiVersion: 1, ...extra }) as PluginManifest;
const plugin = (id: string, extra: Partial<PluginInfo> = {}): PluginInfo => ({
  manifest: manifest(id),
  source: "external",
  enabled: true,
  revision: `${id}-1`,
  previous: null,
  reloadable: false,
  error: null,
  ...extra,
});
const catalog = (...plugins: PluginInfo[]): Catalog => ({
  profile: "test",
  location: "test",
  plugins,
});
const preview = (
  ...candidates: Array<{ path: string; id: string; revision?: string }>
): ImportPreview => ({
  token: "",
  source: "https://example.com/plugins.git",
  commit: COMMIT,
  candidates: candidates.map(({ path, id, revision = `${id}-2` }) => ({
    path,
    manifest: manifest(id, { host: { networkOrigins: ["https://x.test"] } }),
    revision,
  })),
  warnings: [],
});

function harness(
  current: Catalog = catalog(
    plugin("buzz.channels", { source: "bundled", revision: "bundled" }),
    plugin("example.notes", {
      updateSource: {
        repository: "https://example.com/plugins.git",
        reference: "main",
        path: "notes",
      },
    }),
  ),
  checked: ImportPreview | null = preview(
    { path: "notes", id: "example.notes" },
    { path: "tasks", id: "example.tasks" },
  ),
  managed?: ManagedPlugins,
) {
  let shown = current;
  const checkGit = vi.fn<PluginImports["checkGit"]>(async () => checked);
  const change = vi.fn(async () => true);
  const requests = createPluginRequests({
    catalog: () => shown,
    imports: { checkGit } as unknown as PluginImports,
    change,
    error: () => null,
    managed: () => managed,
  });
  return {
    requests,
    agent: requests.forAgent(AGENT),
    checkGit,
    change,
    show: (next: Catalog) => {
      shown = next;
    },
  };
}

describe("list", () => {
  it("reports each plugin's state and source", async () => {
    const { agent } = harness();
    expect(await agent.list()).toEqual({
      plugins: [
        {
          id: "buzz.channels",
          name: "BUZZ.CHANNELS",
          enabled: true,
          bundled: true,
          revision: "bundled",
          source: { kind: "bundled" },
        },
        {
          id: "example.notes",
          name: "EXAMPLE.NOTES",
          enabled: true,
          bundled: false,
          revision: "example.notes-1",
          source: {
            kind: "git",
            repository: "https://example.com/plugins.git",
            reference: "main",
          },
        },
      ],
    });
  });

  it("refuses while plugin settings are unreadable", async () => {
    const requests = createPluginRequests({
      catalog: () => undefined,
      imports: undefined,
      change: vi.fn(),
      error: () => null,
    });
    await expect(requests.forAgent(AGENT).list()).rejects.toThrow(
      "Plugin settings are not ready",
    );
  });
});

describe("discover", () => {
  it("lists every candidate without taking the install preview", async () => {
    const { agent, checkGit } = harness();
    expect(await agent.discover("owner/plugins")).toEqual({
      commit: COMMIT,
      candidates: [
        {
          path: "notes",
          id: "example.notes",
          name: "EXAMPLE.NOTES",
          apiVersion: 1,
          host: { networkOrigins: ["https://x.test"] },
          alreadyInstalled: true,
        },
        {
          path: "tasks",
          id: "example.tasks",
          name: "EXAMPLE.TASKS",
          apiVersion: 1,
          host: { networkOrigins: ["https://x.test"] },
          alreadyInstalled: false,
        },
      ],
    });
    expect(checkGit).toHaveBeenCalledWith("owner/plugins", "");
  });

  it("explains a repository with no built plugins", async () => {
    const { agent } = harness(undefined, {
      ...preview(),
      warnings: ["src: no dist/plugin.js"],
    });
    await expect(agent.discover("owner/plugins", "main")).rejects.toThrow(
      "No built plugins found. src: no dist/plugin.js",
    );
  });

  it("needs the desktop app", async () => {
    const requests = createPluginRequests({
      catalog: () => catalog(),
      imports: undefined,
      change: vi.fn(),
      error: () => null,
    });
    await expect(requests.forAgent(AGENT).discover("owner/x")).rejects.toThrow(
      "Plugin installs require the desktop app",
    );
  });
});

describe("disable", () => {
  it("turns an installed plugin off at once", async () => {
    const { agent, change } = harness();
    expect(await agent.disable("example.notes")).toEqual({
      id: "example.notes",
      enabled: false,
    });
    expect(change).toHaveBeenCalledWith("disable", "example.notes");
  });

  it("refuses Channels and unknown plugins", async () => {
    const { agent, change } = harness();
    await expect(agent.disable("buzz.channels")).rejects.toThrow(
      "Channels is required and cannot be disabled",
    );
    await expect(agent.disable("example.missing")).rejects.toThrow(
      "No plugin example.missing is installed",
    );
    expect(change).not.toHaveBeenCalled();
  });

  it("reports a change storage did not confirm", async () => {
    const requests = createPluginRequests({
      catalog: () => catalog(plugin("example.notes")),
      imports: undefined,
      change: vi.fn(async () => false),
      error: () => "Plugin storage is busy",
    });
    await expect(
      requests.forAgent(AGENT).disable("example.notes"),
    ).rejects.toThrow("Plugin storage is busy");
  });
});

describe("install requests", () => {
  const install = (extra = {}) => ({
    action: "install" as const,
    repository: "owner/plugins",
    path: "tasks",
    reason: "Tracks the sprint board",
    ...extra,
  });

  it("queue the exact commit for the owner and apply nothing", async () => {
    const { requests, agent, change } = harness();
    const listener = vi.fn();
    requests.subscribe(listener);
    const { requestId, applied, action, pluginName } = await agent.request(
      install(),
    );
    expect(applied).toBe(false);
    // What the agent's announcement in the conversation names.
    expect([action, pluginName]).toEqual(["install", "EXAMPLE.TASKS"]);
    expect(change).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(requests.pending()).toEqual([
      {
        id: requestId,
        requester: { pubkey: AGENT.pubkey, name: AGENT.name },
        action: "install",
        pluginId: "example.tasks",
        pluginName: "EXAMPLE.TASKS",
        source: {
          repository: "owner/plugins",
          reference: "",
          path: "tasks",
          commit: COMMIT,
        },
        reason: "Tracks the sprint board",
      },
    ]);
    expect(agent.status(requestId)).toEqual({
      state: "pending",
      action: "install",
      pluginId: "example.tasks",
    });
  });

  it("keep a decided request for the owner's card, as one object", async () => {
    const { requests, agent } = harness();
    const { requestId } = await agent.request(install());
    expect(requests.decided(requestId)).toBeUndefined();
    requests.settle(requestId, "declined");
    expect(requests.decided(requestId)).toMatchObject({
      id: requestId,
      pluginId: "example.tasks",
      state: "declined",
    });
    expect(requests.decided(requestId)).toBe(requests.decided(requestId));
    expect(requests.decided("unknown")).toBeUndefined();
  });

  it("report the owner's decision only to the agent that asked", async () => {
    const { requests, agent } = harness();
    const first = await agent.request(install());
    requests.settle(first.requestId, "approved");
    expect(requests.pending()).toEqual([]);
    expect(agent.status(first.requestId).state).toBe("approved");
    const second = await agent.request(install());
    requests.settle(second.requestId, "declined");
    expect(agent.status(second.requestId).state).toBe("declined");
    const other = requests.forAgent({ pubkey: "b".repeat(64), name: "Other" });
    expect(other.status(first.requestId)).toEqual({ state: "expired" });
    expect(agent.status("unknown")).toEqual({ state: "expired" });
  });

  it.each([
    [{ path: undefined }, "Choose a path: notes, tasks"],
    [{ path: "other" }, "No built plugin at other. Found: notes, tasks"],
    [
      { id: "example.notes" },
      "The plugin at tasks is example.tasks, not example.notes",
    ],
    [
      { path: "notes" },
      "example.notes is already installed; request an update",
    ],
    [
      { commit: "d".repeat(40) },
      `The repository is at ${COMMIT}, not ${"d".repeat(40)}`,
    ],
    [{ repository: undefined }, "repository is required to install"],
    [{ reason: "  " }, "reason is required"],
    [{ reason: "x".repeat(501) }, "reason must be at most 500 characters"],
  ])("refuse %o", async (extra, message) => {
    const { requests, agent } = harness();
    await expect(agent.request(install(extra))).rejects.toThrow(message);
    expect(requests.pending()).toEqual([]);
  });

  it("refuse a bundled id", async () => {
    const { agent } = harness(
      undefined,
      preview({ path: ".", id: "buzz.channels" }),
    );
    await expect(agent.request(install({ path: "." }))).rejects.toThrow(
      "That plugin id is reserved",
    );
  });

  it("refuse a second request for the same plugin", async () => {
    const { agent } = harness();
    await agent.request(install());
    await expect(agent.request(install())).rejects.toThrow(
      "A request for example.tasks is already pending",
    );
  });

  it("stop at 16 pending requests", async () => {
    const paths = Array.from({ length: 17 }, (_, index) => `p${index}`);
    const { agent } = harness(
      catalog(),
      preview(...paths.map((path) => ({ path, id: `example.${path}` }))),
    );
    for (const path of paths.slice(0, 16))
      await agent.request(install({ path }));
    await expect(agent.request(install({ path: "p16" }))).rejects.toThrow(
      "Review the pending plugin requests first",
    );
  });

  it("refuse an agent that is no longer available", async () => {
    const { requests } = harness();
    const gone = requests.forAgent({ ...AGENT, live: () => false });
    await expect(gone.request(install())).rejects.toThrow(
      "The requesting agent is no longer available",
    );
  });
});

describe("update, enable and remove requests", () => {
  const disabled = catalog(
    plugin("buzz.channels", { source: "bundled", revision: "bundled" }),
    plugin("example.notes", {
      enabled: false,
      updateSource: {
        repository: "https://example.com/plugins.git",
        reference: "main",
        path: "notes",
      },
    }),
    plugin("example.local", { updateSource: { root: "/src", path: "." } }),
  );
  const reason = "Needed for the board";

  it("pin an update to the plugin's recorded source", async () => {
    const { requests, agent, checkGit } = harness(disabled);
    const { requestId } = await agent.request({
      action: "update",
      id: "example.notes",
      reason,
    });
    expect(checkGit).toHaveBeenCalledWith(
      "https://example.com/plugins.git",
      "main",
      undefined,
      { path: "notes" },
    );
    expect(requests.pending()[0]).toMatchObject({
      id: requestId,
      action: "update",
      pluginId: "example.notes",
      pluginName: "EXAMPLE.NOTES",
      source: {
        repository: "https://example.com/plugins.git",
        reference: "main",
        path: "notes",
        commit: COMMIT,
      },
    });
    expect(await agent.list()).toMatchObject({
      plugins: [
        {},
        {
          id: "example.notes",
          pendingRequest: { id: requestId, action: "update" },
        },
        {},
      ],
    });
  });

  it("queue enable and remove without reading a repository", async () => {
    const { requests, agent, checkGit } = harness(disabled);
    await agent.request({ action: "enable", id: "example.notes", reason });
    await agent.request({ action: "remove", id: "example.local", reason });
    expect(
      requests
        .pending()
        .map(({ action, pluginId, source }) => [action, pluginId, source]),
    ).toEqual([
      ["enable", "example.notes", undefined],
      ["remove", "example.local", undefined],
    ]);
    expect(checkGit).not.toHaveBeenCalled();
  });

  it.each([
    [
      { action: "update", id: "example.local" },
      "example.local was not installed from Git",
    ],
    [
      { action: "update", id: "buzz.channels" },
      "Bundled plugins update with Buzz",
    ],
    [
      { action: "update", id: "example.missing" },
      "No plugin example.missing is installed",
    ],
    [
      { action: "enable", id: "example.local" },
      "example.local is already enabled",
    ],
    [
      { action: "remove", id: "buzz.channels" },
      "Bundled plugins cannot be removed",
    ],
    [{ action: "remove" }, "id is required to remove"],
  ] as const)("refuse %o", async (input, message) => {
    const { requests, agent } = harness(disabled);
    await expect(agent.request({ ...input, reason })).rejects.toThrow(message);
    expect(requests.pending()).toEqual([]);
  });

  it.each([false, true])(
    "requests a same-revision update only for a new signature (%s)",
    async (signed) => {
      const checked = preview({
        path: "notes",
        id: "example.notes",
        revision: "example.notes-1",
      });
      checked.candidates = checked.candidates.map((candidate) => ({
        ...candidate,
        publisher: signed ? "a".repeat(64) : null,
      }));
      const { agent, requests, change } = harness(disabled, checked);
      const request = agent.request({
        action: "update",
        id: "example.notes",
        reason,
      });
      if (signed) {
        await expect(request).resolves.toMatchObject({
          applied: false,
          action: "update",
        });
        expect(requests.pending()).toHaveLength(1);
        expect(change).not.toHaveBeenCalled();
      } else {
        await expect(request).rejects.toThrow(
          "example.notes is already at main's version",
        );
      }
    },
  );

  it("refuse an update when the plugin left its recorded path", async () => {
    const { agent } = harness(
      disabled,
      preview({ path: "tasks", id: "example.tasks" }),
    );
    await expect(
      agent.request({ action: "update", id: "example.notes", reason }),
    ).rejects.toThrow("main has no example.notes at notes");
  });
});

describe("owner-held boundaries", () => {
  const reason = "Needed for the board";
  const policy = (id: string): ManagedPlugins => ({
    status: "ready",
    path: "/data/managed-plugins.json",
    source: "Example Org",
    problems: [],
    plugins: [
      {
        id,
        repository: "https://example.com/plugins.git",
        reference: "main",
        commit: "e".repeat(40),
        path: "notes",
        state: "outdated",
      },
    ],
  });

  it.each([
    "https://relay.example.com/git/" + "f".repeat(64) + "/plugins",
    "https://relay.example.com/git/" + "F".repeat(64) + "/plugins.git",
  ])("never read a Buzz-hosted repository as the owner: %s", async (url) => {
    const { agent, checkGit } = harness();
    const message =
      "Ask your owner to add plugins from Buzz-hosted repositories";
    await expect(agent.discover(url)).rejects.toThrow(message);
    await expect(
      agent.request({ action: "install", repository: url, reason }),
    ).rejects.toThrow(message);
    expect(checkGit).not.toHaveBeenCalled();
  });

  // Native code trims Unicode whitespace that JavaScript's URL parser does not,
  // so a URL this side cannot read as Buzz-hosted may be one there.
  it.each(["\u0085", "\u00a0", "\u2028", "\n", "\0"])(
    "refuse a repository with surrounding whitespace or control characters: %j",
    async (edge) => {
      const { agent, checkGit } = harness();
      const url = `${edge}https://relay.example.com/git/${"f".repeat(64)}/plugins`;
      const message = "repository must not contain whitespace";
      await expect(agent.discover(url)).rejects.toThrow(message);
      await expect(
        agent.request({
          action: "install",
          repository: `${url}${edge}`,
          reason,
        }),
      ).rejects.toThrow(message);
      expect(checkGit).not.toHaveBeenCalled();
    },
  );

  it("refuse to update or install around the organization's recommendation", async () => {
    const { agent, checkGit } = harness(
      undefined,
      undefined,
      policy("example.notes"),
    );
    await expect(
      agent.request({ action: "update", id: "example.notes", reason }),
    ).rejects.toThrow(
      "example.notes follows Example Org's recommendation; install or update it from the recommendation in Settings",
    );
    const missing = harness(catalog(), undefined, policy("example.tasks"));
    await expect(
      missing.agent.request({
        action: "install",
        repository: "owner/plugins",
        path: "tasks",
        reason,
      }),
    ).rejects.toThrow(
      "example.tasks follows Example Org's recommendation; install or update it from the recommendation in Settings",
    );
    expect(checkGit).not.toHaveBeenCalled();
  });

  it("refuse to enable plugins that need admin access", async () => {
    const { agent } = harness(
      catalog(plugin("buzz.moderation", { source: "bundled", enabled: false })),
    );
    await expect(
      agent.request({ action: "enable", id: "buzz.moderation", reason }),
    ).rejects.toThrow(
      "buzz.moderation needs admin access; enable it in Settings",
    );
  });
});
