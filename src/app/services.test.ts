import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Host } from "../features/host/service";
import { createServices, type AppServices } from "./services";

const plugin = vi.hoisted(() => ({
  cleanup: vi.fn<() => void | Promise<void>>(),
  host: undefined as Host | undefined,
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
  Channel: class {
    id = 1;
    onmessage = () => {};
  },
}));
// Only the plugin module is a fixture. Exercise the real app composition,
// manager, runtime, Cordis root and community/relay services.
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.page", name: "Test", apiVersion: 1 },
      module: {
        inject: ["pages", "host"],
        apply(ctx: Context) {
          plugin.host = ctx.host;
          ctx.pages.register({
            id: "main",
            title: "Test",
            component: () => null,
          });
          ctx.effect(() => () => plugin.cleanup());
        },
      },
    },
  ],
}));

let services: AppServices;
let release: (() => void) | undefined;
const viewer = "a".repeat(64);
const signals: AbortSignal[] = [];
const streams: { url: string; close: ReturnType<typeof vi.fn> }[] = [];
let storageReads: ReturnType<typeof vi.fn>;
let values: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  plugin.cleanup.mockReset();
  plugin.host = undefined;
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(invoke).mockReset();
  values = new Map<string, string>();
  storageReads = vi.fn((key: string) => values.get(key) ?? null);
  vi.stubGlobal("localStorage", {
    getItem: storageReads,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (options.signal) signals.push(options.signal);
      if (url.endsWith("/stream")) {
        const close = vi.fn();
        streams.push({ url, close });
        const body = new ReadableStream({
          start(controller) {
            options.signal?.addEventListener(
              "abort",
              () => {
                close();
                controller.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/register")) return Response.json({});
      if (url.endsWith("/session"))
        return Response.json({
          viewer,
          relayAuthor: "b".repeat(64),
          relayUrl: url.includes("/primary/")
            ? "https://primary.test"
            : "https://other.test",
          live: true,
        });
      // Pending reads deliberately ignore abort; shutdown must still abort their
      // signals and fence their continuations rather than wait for the transport.
      return new Promise<Response>(() => {});
    }),
  );
  services = createServices();
});
afterEach(async () => {
  release?.();
  release = undefined;
  await services.dispose().catch(() => {});
  streams.length = 0;
  signals.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function openCommunities() {
  await vi.advanceTimersByTimeAsync(0);
  expect(services.pages.snapshot()).toHaveLength(1);
  services.communities.joined(
    { id: "primary", name: "Primary" },
    { name: "Test", picture: "" },
  );
  await vi.advanceTimersByTimeAsync(0);
  services.communities.joined(
    { id: "secondary", name: "Other" },
    { name: "Test", picture: "" },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(services.relay.snapshot().status).toBe("ready");
  expect(streams).toHaveLength(2);
  expect(signals.length).toBeGreaterThanOrEqual(5);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
}
function expectHostStopped() {
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  for (const stream of streams) expect(stream.close).toHaveBeenCalledTimes(1);
  const added = vi.mocked(document.addEventListener).mock.calls;
  const removed = vi.mocked(document.removeEventListener).mock.calls;
  expect(added).toHaveLength(11); // Host/presence listeners plus built-in emoji copy.
  expect(removed).toHaveLength(added.length);
  const capture = (options?: boolean | EventListenerOptions) =>
    typeof options === "boolean" ? options : !!options?.capture;
  for (const [type, listener, options] of added)
    expect(
      removed.filter(
        ([event, callback, removalOptions]) =>
          event === type &&
          callback === listener &&
          capture(removalOptions) === capture(options),
      ),
    ).toHaveLength(1);
  expect(services.pages.snapshot()).toHaveLength(0);
}

it("provides the host command service to plugins", async () => {
  await vi.advanceTimersByTimeAsync(0);
  expect(plugin.host).toBeDefined();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue("sample-output\n");
  await expect(plugin.host?.runCommand("token")).resolves.toBe(
    "sample-output\n",
  );
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "test.page",
    revision: expect.any(String),
    commandId: "token",
  });
});

it.each([
  JSON.stringify({
    version: 3,
    enabled: { "buzz.emoji": false, "buzz.mentions": false },
  }),
  "invalid saved plugin settings",
])(
  "keeps conversation features available independently of saved plugin settings: %s",
  async (saved) => {
    await services.dispose();
    values.set("buzzodz.plugins.v1", saved);
    services = createServices();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      services.conversation.tools.snapshot().map(({ key }) => key),
    ).toEqual(["buzz.emoji/picker", "buzz.mentions/picker"]);
    expect(
      services.conversation.completions.snapshot().map(({ key }) => key),
    ).toEqual([
      "buzz.emoji/typeahead",
      "buzz.mentions/typeahead",
      "buzz.mentions/folders",
      "buzz.mentions/skills",
    ]);
    expect(
      services.conversation.inline.snapshot().map(({ key }) => key),
    ).toEqual(["buzz.emoji/custom"]);
    expect(services.settingsCards.has("buzz.emoji/custom-emoji")).toBe(true);
    const tools = services.conversation.tools.snapshot();
    await services.plugins.change("disable", "buzz.emoji");
    await services.plugins.change("disable", "buzz.mentions");
    expect(services.conversation.tools.snapshot()).toBe(tools);
    await services.dispose();
    expect(services.conversation.tools.snapshot()).toEqual([]);
    expect(services.conversation.completions.snapshot()).toEqual([]);
    expect(services.conversation.inline.snapshot()).toEqual([]);
    expect(services.settingsCards.has("buzz.emoji/custom-emoji")).toBe(false);
  },
);

it("disposes the real host services and plugins once", async () => {
  await openCommunities();
  const appearanceDisposal = vi.spyOn(services.appearance, "dispose");
  const disposal = services.dispose();
  expect(services.dispose()).toBe(disposal);
  await disposal;
  expectHostStopped();
  expect(appearanceDisposal).toHaveBeenCalled();
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
});

it("cancels every retained community while plugin cleanup hangs, then reports timeout", async () => {
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  plugin.cleanup.mockReturnValue(cleanup);
  await openCommunities();
  const reads = storageReads.mock.calls.length;
  let outcome: unknown = "pending";
  const disposal = services.dispose();
  void disposal.then(
    () => {
      outcome = "resolved";
    },
    (error) => {
      outcome = error;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
  expectHostStopped();
  expect(outcome).toBe("pending");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).toContain("App cleanup timed out");
  expect(services.dispose()).toBe(disposal);
  release?.();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(storageReads).toHaveBeenCalledTimes(reads);
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
  expectHostStopped();
});

it("waits for genuine cleanup completion before reporting successful shutdown", async () => {
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  plugin.cleanup.mockReturnValue(cleanup);
  await openCommunities();
  let finished = false;
  const disposal = services.dispose().then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expectHostStopped();
  expect(finished).toBe(false);
  release?.();
  await disposal;
  expect(finished).toBe(true);
});

it("still cancels the host and reports an unexpected manager-disposal failure", async () => {
  await openCommunities();
  const disposePlugins = services.plugins.dispose;
  vi.spyOn(services.plugins, "dispose").mockImplementation(async () => {
    await disposePlugins();
    throw new Error("Manager cleanup failed");
  });
  await expect(services.dispose()).rejects.toThrow("Manager cleanup failed");
  expectHostStopped();
});

it("seeds and persists the configured relay through the real app composition", async () => {
  await services.dispose();
  vi.stubEnv("VITE_BUZZ_OPEN_RELAY", "https://third.example");
  services = createServices();
  await vi.advanceTimersByTimeAsync(0);
  const membership = { id: "https://third.example", name: "third.example" };
  expect(services.communities.snapshot()).toMatchObject({
    status: "ready",
    memberships: [membership],
    selected: membership.id,
  });
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain(
    "/api/relay/https%3A%2F%2Fthird.example/session",
  );
  expect(JSON.parse(values.get(`buzz-client.v1:${viewer}`) ?? "null")).toEqual({
    profile: { name: "", picture: "", about: "" },
    memberships: [membership],
    selected: membership.id,
    sync: { known: [], outbox: [] },
  });
});

it("joins cleanup already started by disabling a plugin", async () => {
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  plugin.cleanup.mockReturnValue(cleanup);
  await openCommunities();
  await services.plugins.change("disable", "test.page");
  await vi.advanceTimersByTimeAsync(0);
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
  let finished = false;
  const disposal = services.dispose().then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expectHostStopped();
  expect(finished).toBe(false);
  release?.();
  await disposal;
  expect(finished).toBe(true);
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
});

it.each(["MacIntel", "Linux x86_64", "Win32"])(
  "composes the packaged %s connection without opening a community or contacting the broker",
  async (platform) => {
    await services.dispose();
    vi.stubEnv("VITE_BUZZ_LIVE", "0");
    vi.stubGlobal("navigator", { platform });
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(fetch).mockClear();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "identity_restore") return viewer;
      if (command === "deep_link_take") return [];
      if (command === "deep_link_watch") return null;
      // Other native owners may initialize, but no actual native operations run.
      throw new Error("Fixture native capability unavailable");
    });
    services = createServices();
    await vi.advanceTimersByTimeAsync(0);
    expect(services.identity?.snapshot()).toEqual({ status: "ready", viewer });
    expect(services.communities.snapshot()).toMatchObject({
      status: "ready",
      relayAvailable: true,
      viewer,
      selected: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(services.relay.snapshot().status).not.toBe("ready");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "identity_restore"),
    ).toHaveLength(1);
  },
);

it.each(["Linux x86_64", "Win32"])(
  "keeps %s storage failures distinct from first-run onboarding without a broker fallback",
  async (platform) => {
    await services.dispose();
    vi.stubEnv("VITE_BUZZ_LIVE", "0");
    vi.stubGlobal("navigator", { platform });
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(fetch).mockClear();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "deep_link_take") return [];
      if (command === "deep_link_watch") return null;
      throw new Error("Fixture native capability unavailable");
    });
    services = createServices();
    await vi.advanceTimersByTimeAsync(0);
    expect(services.identity?.snapshot()).toEqual({
      status: "error",
      error: "Fixture native capability unavailable",
    });
    // Transport capability exists, but a failed identity cannot start a session.
    expect(services.communities.snapshot()).toMatchObject({
      status: "loading",
      relayAvailable: true,
      selected: null,
    });
    expect(services.communities.snapshot().viewer).toBeUndefined();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "relay_http"),
    ).toBe(false);
    expect(services.pages.snapshot()).toHaveLength(1);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command.startsWith("identity_"))
        .map(([command]) => command),
    ).toEqual(["identity_restore"]);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("restores the selected native community and recovers discovery failure without a broker fallback", async () => {
  vi.stubEnv("VITE_BUZZ_OPEN_RELAY", "https://ignored-default.test");
  await services.dispose();
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(fetch).mockClear();
  const community = "https://restored-native.test";
  values.set(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Native", picture: "" },
      memberships: [
        { id: community, name: "Selected" },
        { id: "https://unopened.test", name: "Unopened" },
      ],
      selected: community,
    }),
  );
  let unavailable = true;
  const destinations: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return viewer;
    if (command === "deep_link_take") return [];
    if (command === "deep_link_watch") return null;
    if (command === "relay_http") {
      const request = args as { community: string; path: string };
      destinations.push(request.community);
      if (unavailable) throw new Error("Discovery offline");
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          request.path === "/" ? { self: "b".repeat(64) } : [],
        ),
      };
    }
    throw new Error("Fixture native capability unavailable");
  });
  services = createServices();
  await vi.advanceTimersByTimeAsync(0);
  expect(services.relay.snapshot()).toMatchObject({
    status: "error",
    error: expect.stringContaining("Discovery offline"),
  });
  unavailable = false;
  services.relay.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(services.relay.snapshot()).toMatchObject({
    status: "ready",
    viewer,
    scope: `${community}:${viewer}`,
  });
  expect(new Set(destinations)).toEqual(new Set([community]));
  expect(fetch).not.toHaveBeenCalled();
});

it("seeds a packaged native community after onboarding and preserves the user's selection on restart", async () => {
  await services.dispose();
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubEnv("VITE_BUZZ_OPEN_RELAY", "https://packaged.example");
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(fetch).mockClear();
  let identified = false;
  let unavailable = true;
  const destinations: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return identified ? viewer : null;
    if (command === "identity_import") {
      identified = true;
      return viewer;
    }
    if (command === "deep_link_take") return [];
    if (command === "deep_link_watch") return null;
    if (command === "relay_http") {
      const request = args as { community: string; path: string };
      destinations.push(request.community);
      if (unavailable) throw new Error("Discovery offline");
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          request.path === "/" ? { self: "b".repeat(64) } : [],
        ),
      };
    }
    throw new Error("Fixture native capability unavailable");
  });
  services = createServices();
  await vi.advanceTimersByTimeAsync(0);
  expect(services.identity?.snapshot().status).toBe("missing");
  expect(destinations).toEqual([]);
  expect(values.has(`buzz-client.v1:${viewer}`)).toBe(false);
  await services.identity?.importKey("fixture-key");
  await vi.advanceTimersByTimeAsync(0);
  const membership = {
    id: "https://packaged.example",
    name: "packaged.example",
  };
  expect(services.communities.snapshot()).toMatchObject({
    selected: membership.id,
    memberships: [membership],
  });
  expect(services.relay.snapshot()).toMatchObject({
    status: "error",
    error: expect.stringContaining("Discovery offline"),
  });
  unavailable = false;
  services.relay.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(services.relay.snapshot()).toMatchObject({
    status: "ready",
    viewer,
    scope: `${membership.id}:${viewer}`,
  });
  expect(JSON.parse(values.get(`buzz-client.v1:${viewer}`) ?? "null")).toEqual({
    profile: { name: "", picture: "", about: "" },
    memberships: [membership],
    selected: membership.id,
    sync: { known: [], outbox: [] },
  });
  // A later build's default cannot change the saved selection.
  await services.dispose();
  vi.stubEnv("VITE_BUZZ_OPEN_RELAY", "https://new-default.example");
  services = createServices();
  await vi.advanceTimersByTimeAsync(0);
  expect(services.communities.snapshot().selected).toBe(membership.id);
  expect(services.relay.snapshot().status).toBe("ready");
  // Choosing Personal space also survives restart, without a new relay connection.
  services.communities.select(null);
  await services.dispose();
  destinations.length = 0;
  services = createServices();
  await vi.advanceTimersByTimeAsync(0);
  expect(services.communities.snapshot()).toMatchObject({
    selected: null,
    memberships: [membership],
  });
  expect(destinations).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps pinned macOS desktop development on the broker identity", async () => {
  await services.dispose();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "deep_link_take") return [];
    if (command === "deep_link_watch") return null;
    throw new Error("Fixture native capability unavailable");
  });
  services = createServices();
  await vi.advanceTimersByTimeAsync(0);
  expect(services.identity).toBeUndefined();
  expect(services.communities.snapshot()).toMatchObject({
    status: "ready",
    viewer,
    relayAvailable: true,
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command.startsWith("identity_")),
  ).toBe(false);
});
