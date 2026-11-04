import { defineConfig } from "@playwright/test";
import gate from "../../../tests/browser/playwright.config.mjs";

// Hosts the native long-thread workload; run.mjs starts it. One test, no
// timeout: it serves until run.mjs requests /__perf/stop.
export default defineConfig({
  testDir: ".",
  testMatch: "host.spec.mjs",
  globalSetup: "../../../tests/browser/vite-server.mjs",
  outputDir: "../../../test-results/perf-native/host",
  workers: 1,
  retries: 0,
  timeout: 0,
  reporter: [["list"]],
  use: { ...gate.use, browserName: "chromium", trace: "off", video: "off" },
});
