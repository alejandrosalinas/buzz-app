import { defineConfig } from "@playwright/test";
import gate from "./playwright.config.mjs";

if (!process.env.PERF_RUN_DIR) throw new Error("Run with bin/pnpm perf");
export default defineConfig({
  testDir: "./perf",
  testMatch: "*.perf.mjs",
  // Titles end in "<case> sample <n>"; never match a longer variant's name.
  grep:
    process.env.PERF_SCENARIO === "all"
      ? undefined
      : new RegExp(
          `(?:^| )(?:${process.env.PERF_CASES.replaceAll(",", "|")}) sample \\d+$`,
        ),
  outputDir: `${process.env.PERF_RUN_DIR}/browser`,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["./perf/reporter.mjs"]],
  use: {
    ...gate.use,
    browserName: process.env.PERF_BROWSER ?? "chromium",
    trace: "off",
    video: "off",
  },
});
