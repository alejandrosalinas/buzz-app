// Serves the long-thread mock workload to the native macOS app. The browser
// fixture provides the mock relay and broker; this host builds one frontend per
// revision under comparison and serves the selected build through a loopback
// proxy that injects agent.js. Started by run.mjs; see docs/performance.md.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../../tests/browser/vite-server.mjs";
import { buildApp } from "../../../tests/browser/build.mjs";
import { test as base, expect } from "../../../tests/browser/fixture.mjs";
import {
  populateThread,
  THREAD_CHANNEL,
  THREAD_REPLIES,
} from "../../../tests/browser/perf/thread-corpus.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.THREAD_NATIVE_PORT ?? 1460);
// name=revision pairs; "worktree" builds the current files.
const arms = (process.env.THREAD_NATIVE_ARMS ?? "head=worktree")
  .split(",")
  .map((pair) => pair.split("="));
const buildDir = process.env.THREAD_NATIVE_BUILDS;

// Swap in a revision's version of every source file that differs from the
// working tree, by module id, so one checkout builds both sides of a comparison.
// Only modified files can be swapped: added, removed or renamed modules would
// need the revision's whole tree.
function revisionPlugin(revision) {
  const entries = execFileSync(
    "git",
    ["diff", "--name-status", revision, "--", "src", "browser-host"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const unsupported = entries.filter(([status]) => status !== "M");
  if (unsupported.length)
    throw new Error(
      `${revision} differs by more than modified files: ${unsupported.map((entry) => entry.join(" ")).join(", ")}`,
    );
  const changed = new Set(entries.map(([, path]) => path));
  return {
    name: "thread-native-revision",
    enforce: "pre",
    load(id) {
      const path = relative(root, id.split("?")[0]);
      if (!changed.has(path)) return;
      return execFileSync("git", ["show", `${revision}:${path}`], {
        cwd: root,
        encoding: "utf8",
      });
    },
  };
}

const test = base.extend({
  compiledApp: [
    async (
      {
        developmentReact,
        builderlabLogin,
        pluginFixtures,
        companionFixture,
        localAgentActivity,
        pairingFixture,
      },
      use,
    ) =>
      buildApp(
        {
          developmentReact,
          builderlabLogin,
          pluginFixtures,
          companionFixture,
          localAgentActivity,
          pairingFixture,
        },
        async (compiled) => {
          for (const [name, revision] of arms) {
            const outDir = join(buildDir, name);
            await build({
              ...compiled.config,
              plugins: [
                ...(revision === "worktree" ? [] : [revisionPlugin(revision)]),
                ...compiled.config.plugins,
              ],
              build: { outDir, emptyOutDir: true },
            });
            console.log(`built ${name} (${revision}) into ${outDir}`);
          }
          await use(compiled);
        },
      ),
    { scope: "worker", timeout: 600_000 },
  ],
});

test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  channelIds: ["alpha", THREAD_CHANNEL],
  historyCounts: { alpha: 1, [THREAD_CHANNEL]: 0 },
});

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

test("thread native host", async ({ page, app }) => {
  test.setTimeout(0);
  const rootEvent = populateThread(app);
  const topLevel = app.inboxWindow.replies.filter(
    (event) => !event.tags.some(([, , , marker]) => marker === "root"),
  ).length;
  // Copy the fixture's seeded storage for the native window, which never runs
  // Playwright init scripts. An empty same-origin page runs the init scripts
  // without starting a second app client.
  await page.route(`${app.origin}/__perf/seed`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(`${app.origin}/__perf/seed`);
  const seed = await page.evaluate(() => ({ ...localStorage }));
  expect(Object.keys(seed).length, "fixture storage seed").toBeGreaterThan(0);
  const seedId = randomUUID();
  let arm = arms[0][0];
  const commands = [];
  const waiting = [];
  const results = new Map();
  const releaseTimer = setInterval(() => {
    // Older pages arrive as soon as the app asks; this workload measures
    // rendering, not network time.
    for (const held of app.pending.splice(0)) held.release();
  }, 20);
  const pages = () =>
    app.report.queries.filter(({ filter }) => filter?.thread_window).length;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
    });
    res.end(
      typeof body === "string" || Buffer.isBuffer(body)
        ? body
        : JSON.stringify(body),
    );
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
    });
  const self = `127.0.0.1:${port}`;
  const server = createServer(async (req, res) => {
    // Loopback only, and only for this origin, as the broker checks its own.
    if (
      req.headers.host !== self ||
      (req.headers.origin && req.headers.origin !== `http://${self}`)
    )
      return send(res, 403, "forbidden");
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (
      process.env.THREAD_NATIVE_LOG &&
      !url.pathname.startsWith("/__perf/next")
    )
      console.log(req.method, url.pathname, req.headers.origin ?? "");
    if (url.pathname === "/__perf/log") {
      console.log("agent:", decodeURIComponent(url.search.slice(1)));
      return send(res, 204, "");
    }
    if (url.pathname === "/__perf/agent.js")
      return send(res, 200, readFileSync(join(here, "agent.js")), types[".js"]);
    if (url.pathname === "/__perf/workload")
      return send(res, 200, {
        arm,
        seed,
        seedId,
        channelId: THREAD_CHANNEL,
        rootId: rootEvent.id,
        replies: THREAD_REPLIES,
        topLevel,
        threadPages: pages(),
      });
    if (url.pathname === "/__perf/arm") {
      const name = url.searchParams.get("name");
      if (!arms.some(([known]) => known === name)) return send(res, 400, "arm");
      arm = name;
      return send(res, 200, { arm });
    }
    // Commands from run.mjs; the agent long-polls for them.
    if (url.pathname === "/__perf/command" && req.method === "POST") {
      const command = JSON.parse(await readBody(req));
      results.delete(command.id);
      const listener = waiting.shift();
      if (listener) listener(command);
      else commands.push(command);
      return send(res, 200, { queued: command.id });
    }
    if (url.pathname === "/__perf/next") {
      const command = commands.shift();
      if (command) return send(res, 200, command);
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(listener), 1);
        res.writeHead(204).end();
      }, 25_000);
      const listener = (next) => {
        clearTimeout(timer);
        send(res, 200, next);
      };
      waiting.push(listener);
      // A reload abandons the poll; never hand a command to a closed page.
      res.on("close", () => {
        clearTimeout(timer);
        const at = waiting.indexOf(listener);
        if (at >= 0) waiting.splice(at, 1);
      });
      return;
    }
    if (url.pathname === "/__perf/result" && req.method === "POST") {
      const result = JSON.parse(await readBody(req));
      results.set(result.id, result);
      return send(res, 200, "ok");
    }
    if (url.pathname === "/__perf/result")
      return send(res, 200, results.get(url.searchParams.get("id")) ?? null);
    if (url.pathname === "/__perf/stop") {
      send(res, 200, "stopping");
      return finish();
    }
    // The selected build's static files; everything else (broker, media,
    // relay streams) goes to the fixture with the Host header unchanged, so
    // the broker's same-origin check sees this origin.
    const dist = join(buildDir, arm);
    const file = join(
      dist,
      url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname),
    );
    if (
      req.method === "GET" &&
      file.startsWith(dist) &&
      existsSync(file) &&
      statSync(file).isFile()
    ) {
      let body = readFileSync(file);
      if (file.endsWith("index.html"))
        body = body
          .toString()
          .replace("<head>", '<head><script src="/__perf/agent.js"></script>');
      return send(
        res,
        200,
        body,
        types[extname(file)] ?? "application/octet-stream",
      );
    }
    const upstream = new URL(app.origin);
    const proxied = request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    proxied.on("error", () => res.destroy());
    // A reload closes the page's live stream; close it upstream too, or the
    // broker keeps counting it against its stream limit.
    res.on("close", () => proxied.destroy());
    req.pipe(proxied);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`thread native host ready on http://127.0.0.1:${port}`);
  try {
    await finished;
  } finally {
    clearInterval(releaseTimer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  // The desktop app also reads features the fixture does not model (huddles,
  // plugins, agent activity). Print them for review, then clear them so the
  // fixture's teardown does not fail the host; they do not touch the thread.
  for (const entry of new Set(app.report.unexpected))
    console.log(`unmodeled: ${String(entry).slice(0, 200)}`);
  app.report.unexpected.length = 0;
  expect(pages(), "the thread was read through strict windows").toBeGreaterThan(
    0,
  );
});
