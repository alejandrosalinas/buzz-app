import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { Server as HttpServer } from "node:http";
import { Server, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  build,
  createServer,
  prepareFixtureDependencies,
  preview,
} from "../browser/vite-server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = {
  configFile: false,
  envDir: false,
  logLevel: "silent",
  server: { middlewareMode: true, ws: false, watch: null },
};
let release, seed, nodeEnvBefore, nodeEnvAfter;
before(async () => {
  nodeEnvBefore = process.env.NODE_ENV;
  release = await prepareFixtureDependencies();
  nodeEnvAfter = process.env.NODE_ENV;
  seed = process.env.BUZZ_FIXTURE_VITE_DEPS;
});
after(() => release?.());

test("preparing dependencies leaves NODE_ENV for production app builds", () => {
  // Workers inherit the runner's environment; a leaked "development" turns
  // import.meta.env.DEV on in the built app.
  assert.equal(nodeEnvAfter, nodeEnvBefore);
});

// Vite deletes the deps directory before it optimizes again, so a marker
// placed in the prepared cache survives only if the server reuses it.
async function placeMarker() {
  await writeFile(
    join(seed, "deps", "prepared-marker.js"),
    "export default 1;",
  );
}
async function assertReusesPreparedCache(server) {
  const optimizer = server.environments.client.depsOptimizer;
  await optimizer.init();
  assert.ok(optimizer.metadata.optimized.react);
  assert.notEqual(server.config.cacheDir, seed);
  await stat(join(server.config.cacheDir, "deps", "prepared-marker.js"));
}

test("differently configured fixture servers start from the prepared dependencies", async () => {
  await placeMarker();
  const servers = [];
  try {
    for (const variant of [
      {},
      { plugins: [{ name: "middleware", configureServer() {} }] },
      {
        define: { "import.meta.env.VITE_BUZZ_LIVE": '"0"' },
        plugins: [{ name: "html", transformIndexHtml: (html) => html }],
      },
    ]) {
      const server = await createServer({ ...config, ...variant });
      servers.push(server);
      await assertReusesPreparedCache(server);
    }
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("app builds, previews and fixture servers in one worker do not change each other's mode", async () => {
  // Vite's dependency hash includes NODE_ENV. Unwrapped build() and preview()
  // leave it as production, and the next fixture server optimizes again.
  await placeMarker();
  const directory = await mkdtemp(join(tmpdir(), "buzz-fixture-build-"));
  let server, previewServer;
  try {
    const entry = join(directory, "entry.js");
    await writeFile(
      entry,
      `import ${JSON.stringify(join(root, "src/shared/styles/globals.css"))};`,
    );
    const app = {
      root,
      configFile: false,
      envFile: false,
      logLevel: "silent",
      build: {
        outDir: join(directory, "dist"),
        rollupOptions: { input: entry },
      },
    };
    await build(app);
    assert.equal(process.env.NODE_ENV, nodeEnvBefore);
    previewServer = await preview({
      ...app,
      preview: { host: "127.0.0.1", port: 0 },
    });
    assert.equal(process.env.NODE_ENV, nodeEnvBefore);
    server = await createServer(config);
    assert.equal(process.env.NODE_ENV, nodeEnvBefore);
    await assertReusesPreparedCache(server);
    // postcss.config.js keeps Tailwind's in-process cache apart per mode.
    const css = await server.transformRequest("/src/shared/styles/globals.css");
    assert.match(css.code, /--duration-panel-enter/);
    // A fixture server leaves NODE_ENV=development without the helper; a later
    // app build must still be a production build.
    const later = join(directory, "later.js");
    await writeFile(later, "globalThis.dev = import.meta.env.DEV;");
    const result = await build({
      root,
      configFile: false,
      envFile: false,
      logLevel: "silent",
      build: { write: false, rollupOptions: { input: later } },
    });
    const [chunk] = [result].flat()[0].output;
    assert.match(chunk.code, /globalThis\.dev\s*=\s*(!1|false)/);
  } finally {
    await server?.close();
    await previewServer?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("port 0 servers, restarts and previews bind where the OS assigns, not a probed port", async () => {
  // Vite probes for a free port, closes the probe and binds that number later.
  // Take each such port just before its bind, as a concurrent process can.
  const listen = Server.prototype.listen;
  const blockers = [];
  Server.prototype.listen = function (port, ...args) {
    if (!(this instanceof HttpServer) || !port)
      return listen.call(this, port, ...args);
    const blocker = createNetServer();
    blockers.push(blocker);
    blocker.listen(port, "127.0.0.1", () => listen.call(this, port, ...args));
    return this;
  };
  const bound = (server) => {
    const { port } = server.httpServer.address();
    assert.equal(server.resolvedUrls.local[0], `http://127.0.0.1:${port}/`);
  };
  let server, previewServer;
  try {
    server = await createServer({
      configFile: false,
      envDir: false,
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
        ws: false,
        watch: null,
      },
    });
    await server.listen();
    bound(server);
    const { cacheDir } = server.config;
    // A restart binds a new HTTP server to the port Vite recorded at start.
    await server.restart();
    bound(server);
    // It also replaces the server's members, and close must still remove the
    // cache the restarted server kept using.
    assert.equal(server.config.cacheDir, cacheDir);
    await server.close();
    await assert.rejects(stat(cacheDir), { code: "ENOENT" });
    previewServer = await preview({
      root,
      configFile: false,
      envFile: false,
      logLevel: "silent",
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    bound(previewServer);
  } finally {
    Server.prototype.listen = listen;
    await server?.close();
    await previewServer?.close();
    for (const blocker of blockers) blocker.close();
  }
});

test("fixture and preview servers never close an idle keep-alive connection", async () => {
  // Node's 5 s default raced a browser reusing the connection for a lazy
  // import; that request fails and no module script is retried.
  const idle = (server) => assert.equal(server.httpServer.keepAliveTimeout, 0);
  let server, previewServer;
  try {
    server = await createServer({
      configFile: false,
      envDir: false,
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
        ws: false,
        watch: null,
      },
    });
    await server.listen();
    idle(server);
    // A restart builds a new HTTP server.
    await server.restart();
    idle(server);
    previewServer = await preview({
      root,
      configFile: false,
      envFile: false,
      logLevel: "silent",
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    idle(previewServer);
  } finally {
    await server?.close();
    await previewServer?.close();
  }
});

test("fixture servers reject configuration that would change dependency optimization", async () => {
  await assert.rejects(
    createServer({ ...config, optimizeDeps: { include: ["yaml"] } }),
    /share one dependency optimizer/,
  );
  await assert.rejects(
    createServer({
      ...config,
      plugins: [{ name: "resolver", resolveId: () => null }],
    }),
    /resolver uses resolveId/,
  );
});

test("concurrent fixture servers own distinct optimizer caches and retire only their own files", async () => {
  const servers = [];
  try {
    servers.push(await createServer(config));
    servers.push(await createServer(config));
    const [first, second] = servers;
    assert.notEqual(first.config.cacheDir, second.config.cacheDir);
    assert.notEqual(first.config.cacheDir, join(root, "node_modules/.vite"));
    const retained = join(second.config.cacheDir, "retained-dependency.js");
    await writeFile(retained, "export default 1;");
    await first.close();
    await assert.rejects(stat(first.config.cacheDir), { code: "ENOENT" });
    assert.equal(await readFile(retained, "utf8"), "export default 1;");
    await second.close();
    await assert.rejects(stat(second.config.cacheDir), { code: "ENOENT" });
    await stat(join(seed, "deps"));
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("failed fixture creation cleans its owned cache and preserves the error", async () => {
  let cacheDir;
  const failure = new Error("fixture configuration failed");
  await assert.rejects(
    createServer({
      ...config,
      plugins: [
        {
          name: "fail-fixture-configuration",
          configureServer(server) {
            cacheDir = server.config.cacheDir;
            throw failure;
          },
        },
      ],
    }),
    (error) => error === failure,
  );
  assert.ok(cacheDir);
  await assert.rejects(stat(cacheDir), { code: "ENOENT" });
});

test("browser fixture call sites cannot fall back to Vite's shared default cache", async () => {
  const browser = join(root, "tests/browser");
  for (const name of await readdir(browser)) {
    if (!name.endsWith(".mjs") || name === "vite-server.mjs") continue;
    const source = await readFile(join(browser, name), "utf8");
    for (const [, names] of source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"vite"/g,
    )) {
      // The helper restores NODE_ENV after build and preview (keepNodeEnv),
      // and gives each server its own cache and an OS-assigned port 0
      // (bindAssignedPort).
      assert.doesNotMatch(
        names,
        /\b(build|preview|createServer)\b/,
        `${name} must import build, preview and createServer from vite-server.mjs`,
      );
    }
  }
});
