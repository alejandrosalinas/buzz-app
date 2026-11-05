import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, assert, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { Plugin, UserConfigFnPromise, ViteDevServer } from "vite";
import type { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import viteConfig from "../../../vite.config";
import { relayBrokerPlugin } from "../../../browser-host/relay-broker.mjs";

// Mock only the OS credential readers; every other execFileSync reaches the
// real binary, so readCredential's call log is exactly the credential reads.
const readCredential = vi.hoisted(() => vi.fn<typeof execFileSync>());
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...call: Parameters<typeof actual.execFileSync>) =>
      call[0] === "/usr/bin/security" || call[0] === "secret-tool"
        ? readCredential(...call)
        : actual.execFileSync(...call),
  };
});
vi.mock("undici", async (original) => ({
  ...(await original<typeof import("undici")>()),
  fetch: vi.fn(),
}));
import { fetch as upstreamFetch } from "undici";
const upstream = vi.mocked(upstreamFetch);
const key = generateSecretKey();
const viewer = getPublicKey(key);
const config = viteConfig as UserConfigFnPromise;
const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

async function startup(relayUrl = "", aliases = "") {
  vi.stubEnv("BUZZ_RELAY_URL", relayUrl);
  vi.stubEnv("BUZZ_COMMUNITY_ALIASES", aliases);
  vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
  // Neutralize the seed too: loadEnv would otherwise mix a developer's
  // .env.local into what these tests assert.
  vi.stubEnv("BUZZ_DEV_OPEN_RELAY", "");
  readCredential.mockReturnValue(
    Buffer.from(JSON.stringify({ identity: nip19.nsecEncode(key) })),
  );
  const resolved = await config({ command: "serve", mode: "development" });
  const plugin = (resolved.plugins as Plugin[]).find(
    (entry) => entry.name === "buzz-relay-broker",
  );
  assert.exists(plugin);
  let handler: RequestListener | undefined;
  const server = createServer((req, res) => handler?.(req, res));
  closes.push(async () => {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    else server.emit("close");
  });
  await (plugin.configureServer as (server: ViteDevServer) => Promise<void>)({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(cb: RequestListener) {
        handler = cb;
      },
    },
  } as unknown as ViteDevServer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    resolved,
    get: (path: string) => fetch(`${base}/api/relay/${path}`),
  };
}

it("serves identity with no configured communities and rejects unscoped relay access without networking", async () => {
  const app = await startup();
  expect(await (await app.get("identity")).json()).toEqual({ viewer });
  expect((await app.get("session")).status).toBe(400);
  expect((await app.get("unknown/session")).status).toBe(400);
  expect(
    (
      await fetch(`${app.base}/api/relay/identity`, {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
  expect(
    app.resolved.define?.["import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES"],
  ).toBe('""');
});

it("carries deployment config through Vite to the real broker and keeps default and scoped communities separate", async () => {
  upstream.mockImplementation(
    async () => Response.json({ self: viewer }) as never,
  );
  const aliases = '{"old":"wss://OLD.example:443/"}';
  const app = await startup(" WSS://DEFAULT.example:443/ ", aliases);
  expect(upstream).not.toHaveBeenCalled();
  expect(await (await app.get("session")).json()).toMatchObject({
    relayUrl: "https://default.example",
  });
  expect(await (await app.get("old/session")).json()).toMatchObject({
    relayUrl: "https://old.example",
  });
  expect(upstream.mock.calls.map(([url]) => String(url))).toEqual([
    "https://default.example",
    "https://old.example",
  ]);
  const registered = await fetch(`${app.base}/api/relay/register`, {
    method: "POST",
    headers: { Origin: app.base, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "wss://OLD.example:443/" }),
  });
  expect(await registered.json()).toEqual({
    id: "old",
    url: "https://old.example",
    name: "old.example",
  });
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(
    app.resolved.define?.["import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES"],
  ).toBe(JSON.stringify(aliases));
  expect(JSON.stringify(app.resolved.define)).not.toContain(viewer);
  expect(JSON.stringify(app.resolved.define)).not.toContain("BUZZ_RELAY_URL");
});

it.each([
  ["https://user:password@relay.example", ""],
  ["http://relay.example", ""],
  ["", '{"old":"https://relay.example/path"}'],
  ["", "not-json"],
])(
  "rejects invalid deployment routing before credential access (%#)",
  async (relay, aliases) => {
    await expect(startup(relay, aliases)).rejects.toThrow();
    expect(readCredential).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  },
);

it("keeps the development broker's Builderlab sign-in for a pinned viewer without FI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-fi-default-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    vi.stubEnv("BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG", undefined);
    vi.stubEnv("BUZZ_BUILDERLAB_URL", undefined);
    vi.stubEnv("BUZZ_DEV_OPEN_RELAY", "");
    const define = async (viewer: string, command: "serve" | "build") => {
      vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
      const { define } = await config({ command, mode: "development" });
      return [
        define?.["import.meta.env.VITE_BUZZ_LIVE"],
        define?.["import.meta.env.VITE_BUZZ_FEDERATED_IDENTITY"],
      ];
    };
    // Pinned dev server: broker live, native NIP-FI off, as on main.
    expect(await define(viewer, "serve")).toEqual(['"1"', '"0"']);
    // Unpinned dev server and any build: the built-in NIP-FI server.
    expect(await define("", "serve")).toEqual(['"0"', '"1"']);
    expect(await define(viewer, "build")).toEqual(['"0"', '"1"']);
    // An added server wins over the broker.
    vi.stubEnv(
      "BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG",
      '{"identityOrigin":"https://block.builderlab.xyz","apiBasePath":"/api/goose/"}',
    );
    expect(await define(viewer, "serve")).toEqual(['"1"', '"1"']);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("loads ignored local deployment config and lets process env override it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-routing-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    vi.stubEnv("BUZZ_DEV_VIEWER", "");
    vi.stubEnv("BUZZ_RELAY_URL", undefined);
    vi.stubEnv("BUZZ_COMMUNITY_ALIASES", undefined);
    writeFileSync(
      join(dir, ".env.local"),
      'BUZZ_RELAY_URL=wss://local.example\nBUZZ_COMMUNITY_ALIASES=\'{"saved":"wss://local.example"}\'\n',
    );
    const resolved = await config({ command: "serve", mode: "development" });
    expect(
      resolved.define?.["import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES"],
    ).toBe(JSON.stringify('{"saved":"wss://local.example"}'));
    vi.stubEnv(
      "BUZZ_COMMUNITY_ALIASES",
      '{"override":"https://override.example"}',
    );
    const overridden = await config({ command: "serve", mode: "development" });
    expect(
      overridden.define?.["import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES"],
    ).toBe(JSON.stringify('{"override":"https://override.example"}'));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  ["http://relay.example", ""],
  ["https://user:password@relay.example", ""],
  ["", '{"saved":"https://relay.example/path"}'],
  ["", "not-json"],
])(
  "validates routing even when the development broker is disabled (%#)",
  async (relayUrl, communityAliases) => {
    // A configured pin does not enable the broker for production builds.
    vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
    vi.stubEnv("BUZZ_RELAY_URL", relayUrl);
    vi.stubEnv("BUZZ_COMMUNITY_ALIASES", communityAliases);
    await expect(
      config({ command: "build", mode: "production" }),
    ).rejects.toThrow();
    expect(readCredential).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    // Direct broker users cannot bypass validation by avoiding the Vite entry.
    expect(() =>
      relayBrokerPlugin({
        archiveFile: ":memory:",
        relayUrl,
        communityAliases,
      }),
    ).toThrow();
  },
);
