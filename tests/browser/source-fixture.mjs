import { test as base, expect } from "./playwright-test.mjs";
import react from "@vitejs/plugin-react";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer, warmUp } from "./vite-server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Only stateless source serving is shared. Playwright still owns a fresh context
// per test; fixtures with mutable server middleware must keep their own server.
export const test = base.extend({
  sourceOrigin: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
    async ({}, use) => {
      const server = await createServer({
        root,
        configFile: false,
        envFile: false,
        plugins: [react()],
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0, strictPort: true },
      });
      try {
        await server.listen();
        // A worker's first fixture page otherwise transforms about 1,700
        // modules inside its navigation timeout, and the failed test's
        // replacement worker starts cold again. The pages share most of that
        // graph, so transform every one of them once, in this fixture's budget.
        const pages = await readdir(new URL("../fixtures/", import.meta.url));
        await warmUp(
          server,
          pages
            .filter((page) => page.endsWith(".html"))
            .map((page) => `/tests/fixtures/${page}`),
        );
        await use(`http://127.0.0.1:${server.httpServer.address().port}`);
      } finally {
        await server.close();
      }
    },
    { scope: "worker", timeout: 60_000 },
  ],
  baseURL: async ({ sourceOrigin }, use) => use(sourceOrigin),
});
export { expect };
