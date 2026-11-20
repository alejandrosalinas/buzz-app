import type { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { Plugin, UserConfigFnPromise, ViteDevServer } from "vite";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import viteConfig from "../../../vite.config";
import { getLogger, setLogLevel } from "../developer/logging";

// The broker picks its credential reader from process.platform at call time.
// Every case pins the platform explicitly so the suite proves the same thing
// on the Ubuntu CI runner as on a developer's Mac. Hoisted because the module
// mock below consults this table while vite.config's imports are still loading.
const { readCredential, readers } = vi.hoisted(() => ({
  readCredential: vi.fn<typeof execFileSync>(),
  readers: {
    darwin: {
      command: "/usr/bin/security",
      args: [
        "find-generic-password",
        "-s",
        "buzz-desktop",
        "-a",
        "secrets",
        "-w",
      ],
      failure: "Keychain read unavailable or declined; no credential fallback",
    },
    linux: {
      command: "secret-tool",
      args: ["lookup", "service", "buzz-desktop", "username", "secrets"],
      failure: "Secret service read unavailable",
    },
  } as const,
}));
// Mock only the credential boundary: the OS readers above are routed to
// readCredential, so its call log is exactly the set of Keychain and secret
// service reads. Every other execFileSync reaches the real binary, and the Vite
// config, plugin registration, default identity loader and public-key match
// are the production path.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const commands = new Set<string>(
    Object.values(readers).map((reader) => reader.command),
  );
  return {
    ...actual,
    execFileSync: (...call: Parameters<typeof actual.execFileSync>) =>
      commands.has(call[0])
        ? readCredential(...call)
        : actual.execFileSync(...call),
  };
});
const config = viteConfig as UserConfigFnPromise;
const fixture = generateSecretKey();
const viewer = getPublicKey(fixture);
const credential = JSON.stringify({ identity: nip19.nsecEncode(fixture) });
const servers: ReturnType<typeof createServer>[] = [];

const realPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}
const platforms = Object.keys(readers) as (keyof typeof readers)[];

beforeEach(() => {
  // Neutralize every BUZZ_ input the config reads: loadEnv would otherwise mix
  // a developer's .env.local into what these tests assert.
  vi.stubEnv("BUZZ_RELAY_URL", "");
  vi.stubEnv("BUZZ_COMMUNITY_ALIASES", "");
  vi.stubEnv("BUZZ_DEV_VIEWER", "");
  vi.stubEnv("BUZZ_DEV_OPEN_RELAY", "");
  onPlatform("darwin");
  readCredential.mockReset();
  readCredential.mockReturnValue(Buffer.from(credential));
});
afterEach(() => {
  for (const server of servers.splice(0)) server.emit("close");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setLogLevel("info");
  onPlatform(realPlatform);
});

async function startup(command: "serve" | "build" = "serve") {
  const resolved = await config({
    command,
    mode: command === "serve" ? "development" : "production",
  });
  const plugin = (resolved.plugins as Plugin[]).find(
    (entry) => entry.name === "buzz-relay-broker",
  );
  const server = createServer();
  servers.push(server);
  const use = vi.fn();
  const info = vi
    .spyOn(getLogger("relay-broker"), "info")
    .mockImplementation(() => {});
  const start = () => {
    assert.exists(plugin);
    return (plugin.configureServer as (server: ViteDevServer) => Promise<void>)(
      {
        httpServer: server,
        config: { logger: { info, error: vi.fn() } },
        middlewares: { use },
      } as unknown as ViteDevServer,
    );
  };
  return { resolved, plugin, start, use, info };
}

it.each(["", "  "])(
  "starts without the broker or credential access when no public pin is configured (%#)",
  async (configured) => {
    vi.stubEnv("BUZZ_DEV_VIEWER", configured);
    const app = await startup();
    expect(app.plugin).toBeUndefined();
    expect(app.resolved.define?.["import.meta.env.VITE_BUZZ_LIVE"]).toBe('"0"');
    expect(
      app.resolved.define?.["import.meta.env.VITE_BUZZ_FRONTEND_SOURCE_STATE"],
    ).toBe('"unknown"');
    expect(readCredential).not.toHaveBeenCalled();
  },
);

it("never registers the broker for production builds, even with a configured pin", async () => {
  vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  vi.spyOn(process, "cwd").mockReturnValue(tmpdir());
  const app = await startup("build");
  expect(app.plugin).toBeUndefined();
  expect(app.resolved.define?.["import.meta.env.VITE_BUZZ_LIVE"]).toBe('"0"');
  const revision =
    app.resolved.define?.["import.meta.env.VITE_BUZZ_FRONTEND_SOURCE_REVISION"];
  if (existsSync(join(root, ".git"))) {
    expect(revision).toMatch(/^"(?:[a-f\d]{40}|[a-f\d]{64})"$/i);
  } else {
    expect(revision).toBe('""');
  }
  expect(
    app.resolved.define?.["import.meta.env.VITE_BUZZ_FRONTEND_SOURCE_STATE"],
  ).toMatch(/^"(?:clean|dirty|unknown)"$/);
  expect(readCredential).not.toHaveBeenCalled();
});

it.each([
  "not-a-key",
  "ab".repeat(31),
  "npub1broken",
  nip19.nsecEncode(fixture),
])(
  "rejects missing/invalid public configuration before Keychain access (%#)",
  async (configured) => {
    vi.stubEnv("BUZZ_DEV_VIEWER", configured);
    const app = await startup();
    await expect(app.start()).rejects.toThrow(
      "Set BUZZ_DEV_VIEWER in .env.local",
    );
    expect(readCredential).not.toHaveBeenCalled();
    expect(app.use).not.toHaveBeenCalled();
    expect(app.info).not.toHaveBeenCalled();
  },
);

it.each(
  platforms.flatMap((platform) =>
    [viewer, nip19.npubEncode(viewer), ` ${viewer.toUpperCase()} `].map(
      (configured) => [platform, configured] as const,
    ),
  ),
)(
  "uses the explicit matching public identity through Vite startup on %s (%#)",
  async (platform, configured) => {
    onPlatform(platform);
    vi.stubEnv("BUZZ_DEV_VIEWER", configured);
    const app = await startup();
    await app.start();
    expect(readCredential).toHaveBeenCalledExactlyOnceWith(
      readers[platform].command,
      readers[platform].args,
      { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 },
    );
    expect(app.use).toHaveBeenCalledOnce();
    expect(app.info).toHaveBeenCalledWith(
      expect.stringContaining(`signing as ${viewer.slice(0, 8)}`),
    );
    expect(app.resolved.define?.["import.meta.env.VITE_BUZZ_LIVE"]).toBe('"1"');
    expect(JSON.stringify(app.resolved.define)).not.toContain(
      "BUZZ_DEV_VIEWER",
    );
    expect(JSON.stringify(app.info.mock.calls)).not.toContain(credential);
  },
);

it.each(["win32", "freebsd"] as const)(
  "refuses an unsupported platform before touching any credential reader (%s)",
  async (platform) => {
    onPlatform(platform);
    vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
    const app = await startup();
    await expect(app.start()).rejects.toThrow(
      `macOS or Linux only (this is ${platform}); no credential fallback`,
    );
    expect(readCredential).not.toHaveBeenCalled();
    expect(app.use).not.toHaveBeenCalled();
    expect(app.info).not.toHaveBeenCalled();
  },
);

it("rejects a different Keychain identity instead of adopting it", async () => {
  vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
  readCredential.mockReturnValue(
    Buffer.from(
      JSON.stringify({ identity: nip19.nsecEncode(generateSecretKey()) }),
    ),
  );
  const app = await startup();
  await expect(app.start()).rejects.toThrow(
    "Keychain identity does not match BUZZ_DEV_VIEWER",
  );
  expect(app.use).not.toHaveBeenCalled();
  expect(app.info).not.toHaveBeenCalled();
});

it.each(platforms)(
  "fails closed when the %s credential read is denied, without leaking command output",
  async (platform) => {
    onPlatform(platform);
    vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
    readCredential.mockImplementation(() => {
      throw new Error(credential);
    });
    const app = await startup();
    const failure = await app.start().then(
      () => assert.fail("startup must fail"),
      (error: unknown) => String(error),
    );
    expect(failure).toContain(readers[platform].failure);
    expect(failure).not.toContain(credential);
    expect(app.use).not.toHaveBeenCalled();
    expect(app.info).not.toHaveBeenCalled();
  },
);

it.each(platforms)(
  "treats an empty %s credential read as unavailable instead of parsing nothing",
  async (platform) => {
    onPlatform(platform);
    vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
    readCredential.mockReturnValue(Buffer.from("\n"));
    const app = await startup();
    await expect(app.start()).rejects.toThrow(readers[platform].failure);
    expect(app.use).not.toHaveBeenCalled();
  },
);

it.each([
  "not-json",
  "{}",
  JSON.stringify({ identity: "not-nip19" }),
  JSON.stringify({ identity: nip19.npubEncode(viewer) }),
])("rejects malformed or non-secret Keychain entries (%#)", async (raw) => {
  vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
  readCredential.mockReturnValue(Buffer.from(raw));
  const app = await startup();
  await expect(app.start()).rejects.toThrow(
    /Keychain identity .*; no credential fallback/,
  );
  expect(app.use).not.toHaveBeenCalled();
  expect(app.info).not.toHaveBeenCalled();
});

it("loads the public pin from .env.local and lets explicit environment override it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-viewer-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    delete process.env.BUZZ_DEV_VIEWER;
    writeFileSync(
      join(dir, ".env.local"),
      `BUZZ_DEV_VIEWER=${nip19.npubEncode(viewer)}\n`,
    );
    const app = await startup();
    await app.start();
    expect(app.use).toHaveBeenCalledOnce();

    vi.stubEnv("BUZZ_DEV_VIEWER", getPublicKey(generateSecretKey()));
    const overridden = await startup();
    await expect(overridden.start()).rejects.toThrow(
      "does not match BUZZ_DEV_VIEWER",
    );
    expect(overridden.use).not.toHaveBeenCalled();
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
