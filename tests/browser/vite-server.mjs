import react from "@vitejs/plugin-react";
import {
  build as viteBuild,
  createServer as createViteServer,
  optimizeDeps,
  preview as vitePreview,
  resolveConfig,
} from "vite";
import { constants } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const seedVariable = "BUZZ_FIXTURE_VITE_DEPS";
// Every fixture page is in this scan. Add a dependency here only when a test
// imports it outside these pages, for example from page.evaluate.
const fixtureOptimizeDeps = {
  entries: ["index.html", "tests/**/*.html", "src/**/*.html"],
  include: ["@jsquash/webp/encode.js"],
};
// Fixture plugins may only add server middleware or rewrite index HTML. Neither
// changes optimized dependencies, so they all run as one stable plugin.
const fixtureHooks = new Set(["name", "configureServer", "transformIndexHtml"]);

// Vite reuses a dependency cache only when its config hash matches. Fixtures
// leave the other hashed settings at their defaults; fixing the root, plugin
// names and optimizeDeps lets every fixture server reuse one prepared cache.
function fixtureConfig({ plugins = [], optimizeDeps: custom, css, ...config }) {
  if (css)
    throw new Error(
      "Fixture servers own their CSS pipeline; see fixtureConfig in vite-server.mjs",
    );
  if (custom)
    throw new Error(
      "Fixture servers share one dependency optimizer; add dependencies to fixtureOptimizeDeps in vite-server.mjs",
    );
  if (config.root !== undefined && resolve(config.root) !== resolve(root))
    throw new Error(
      `Fixture servers serve the repository root, not ${config.root}`,
    );
  const flat = plugins.flat(Infinity).filter(Boolean);
  const isReact = (plugin) => plugin.name.startsWith("vite:react");
  const framework = flat.filter(isReact);
  return {
    ...config,
    root,
    plugins: [
      ...(framework.length ? framework : react()),
      fixturePlugin(flat.filter((plugin) => !isReact(plugin))),
    ],
    optimizeDeps: fixtureOptimizeDeps,
  };
}

function fixturePlugin(plugins) {
  for (const plugin of plugins)
    for (const [key, value] of Object.entries(plugin))
      if (
        !fixtureHooks.has(key) ||
        (key !== "name" && typeof value !== "function")
      )
        throw new Error(
          `Fixture plugin ${plugin.name} uses ${key}; fixture plugins may only define configureServer and transformIndexHtml functions`,
        );
  return {
    name: "buzz-fixture-server",
    async configureServer(server) {
      // Here rather than after creation: server.restart() builds a new HTTP
      // server and binds it to the number Vite probed for the first one.
      if (server.httpServer && server.config.server.port === 0)
        bindAssignedPort(server.httpServer);
      const after = [];
      for (const plugin of plugins) {
        const result = await plugin.configureServer?.(server);
        if (typeof result === "function") after.push(result);
      }
      return async () => {
        for (const run of after) await run();
      };
    },
    async transformIndexHtml(html, context) {
      for (const plugin of plugins) {
        if (!plugin.transformIndexHtml) continue;
        html = await plugin.transformIndexHtml(html, context);
        if (typeof html !== "string")
          throw new Error(`Fixture plugin ${plugin.name} must return HTML`);
      }
      return html;
    },
  };
}

// Vite sets NODE_ENV when it is unset: build() and preview() to production,
// a dev server to development. The value stays for the rest of the process.
// Dependency cache hashes include NODE_ENV, so a production value left by an
// earlier build makes a later fixture server discard its prepared cache and
// optimize again inside a test. A development value makes a later app build
// report import.meta.env.DEV as true. Browser tests therefore call build,
// preview and fixture servers through this module, which restores NODE_ENV.
async function keepNodeEnv(run) {
  const nodeEnv = process.env.NODE_ENV;
  try {
    return await run();
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
}

// Vite resolves port 0 by probing for a free port, closing the probe and then
// binding that number, so another process can take it in between and the bind
// fails with "Port N is already in use". Bind port 0 itself instead: the OS
// assigns a free port in the same step, and Vite reads the bound address back.
function bindAssignedPort(httpServer) {
  const listen = httpServer.listen;
  httpServer.listen = (_port, ...args) => listen.call(httpServer, 0, ...args);
}

export const build = (config) => keepNodeEnv(() => viteBuild(config));
export const preview = (config) =>
  keepNodeEnv(() =>
    vitePreview({
      ...config,
      plugins: [
        ...(config.plugins ?? []),
        {
          name: "buzz-fixture-assigned-port",
          configurePreviewServer(server) {
            if (server.config.preview.port === 0)
              bindAssignedPort(server.httpServer);
          },
        },
      ],
    }),
  );

// A dev server transforms a page's modules on first request, so a worker's
// first navigation to a large fixture can outlast the navigation timeout on a
// busy runner. This builds the repository-relative pages once and serves the
// bundle. Development React, as a dev server serves, keeps StrictMode's checks.
// close() stops the server and removes the build.
export async function previewFixtures(pages) {
  const directory = await mkdtemp(join(tmpdir(), "buzz-fixture-preview-"));
  try {
    const config = {
      root,
      configFile: false,
      envDir: false,
      logLevel: "error",
      plugins: [react()],
      define: {
        "import.meta.env.DEV": "true",
        "process.env.NODE_ENV": '"development"',
      },
      build: {
        rollupOptions: { input: pages.map((page) => join(root, page)) },
        outDir: join(directory, "dist"),
        emptyOutDir: true,
        target: "esnext",
      },
    };
    await build(config);
    const server = await preview({
      ...config,
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    return {
      origin: `http://127.0.0.1:${server.httpServer.address().port}`,
      async close() {
        await new Promise((resolve) => server.httpServer.close(resolve));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// Run once per test run, before any test: it scans and bundles the fixture
// dependencies so no server does that work inside a navigation budget.
export async function prepareFixtureDependencies() {
  const cacheDir = await mkdtemp(join(tmpdir(), "buzz-fixture-vite-deps-"));
  try {
    await keepNodeEnv(async () => {
      const config = await resolveConfig(
        {
          ...fixtureConfig({ configFile: false, envDir: false }),
          cacheDir,
          logLevel: "error",
        },
        "serve",
      );
      await optimizeDeps(config);
    });
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
  process.env[seedVariable] = cacheDir;
  return async () => {
    delete process.env[seedVariable];
    await rm(cacheDir, { recursive: true, force: true });
  };
}

// Playwright's globalSetup.
export default prepareFixtureDependencies;

// A fixture page that reaches the whole app has over a thousand modules to
// transform on its first load. Transform its static import graph before
// navigating, as prepareFixtureDependencies does for dependencies, so no server
// does that work inside a navigation budget.
export async function warmUp(server, entry) {
  await server.warmupRequest(entry);
  await server.waitForRequestsIdle();
}

// Parallel fixture servers must not invalidate each other's optimized imports,
// so each one gets its own copy of the prepared cache.
export async function createServer(config) {
  const seed = process.env[seedVariable];
  if (!seed && process.env.TEST_WORKER_INDEX !== undefined)
    throw new Error(
      "Fixture dependencies are not prepared; add tests/browser/vite-server.mjs as the Playwright config's globalSetup",
    );
  const fixture = fixtureConfig(config);
  const cacheDir = await mkdtemp(join(tmpdir(), "buzz-fixture-vite-"));
  try {
    if (seed)
      await cp(seed, cacheDir, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
    const server = await keepNodeEnv(() =>
      createViteServer({ ...fixture, cacheDir }),
    );
    // server.restart() copies the new server's members onto this one with
    // Object.assign, which would replace a plain close. An accessor takes the
    // new close as the one it wraps, so a restarted server still removes its
    // cache.
    let close = server.close;
    const owned = async () => {
      try {
        await close.call(server);
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    };
    Object.defineProperty(server, "close", {
      configurable: true,
      enumerable: true,
      get: () => owned,
      set: (next) => {
        close = next;
      },
    });
    return server;
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
