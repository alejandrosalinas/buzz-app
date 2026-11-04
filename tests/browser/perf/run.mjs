import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cases = [
  "channel-open-cold",
  "channel-open-hover",
  "channel-open-cold-markdown",
  "scroll-short",
  "scroll-long",
  "scroll-paging-fast",
  "scroll-paging-delayed",
  "scroll-paging-fast-keyboard",
  "scroll-paging-fast-markdown",
  "scroll-paging-fast-first-seen",
  "thread-open-rich",
  "thread-close-rich",
  "thread-reopen-rich",
  "thread-scroll-open",
  "thread-scroll-fling",
  "thread-scroll-reverse",
];
// A case name selects only that case; a group selects every case it prefixes.
const groups = [
  "all",
  "channel-open",
  "scroll-paging",
  "thread",
  "thread-scroll",
];
const scenarios = [...groups, ...cases];
try {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg, i) => i !== 0 || arg !== "--"),
    options: {
      scenario: { type: "string", default: "all" },
      repeat: { type: "string", default: "5" },
      cpu: { type: "string", default: "4" },
      browser: { type: "string", default: "chromium" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(`Usage: bin/pnpm perf [--scenario ${scenarios.join("|")}] [--repeat 5] [--cpu 4] [--browser chromium|webkit] [--out results.json]
Runs a production build serially, with fresh state per sample.
CPU is Chromium's slowdown factor (>=1); repeat is a positive integer.
WebKit samples record frames only; only thread-scroll cases support it.
Results and evidence default to a unique test-results/perf/ directory.
See docs/performance.md for measurement definitions and limitations.`);
  } else {
    const repeat = Number(values.repeat);
    const cpu = Number(values.cpu);
    if (!scenarios.includes(values.scenario))
      throw new Error(`Unknown scenario: ${values.scenario}`);
    const selected = cases.filter(
      (name) =>
        values.scenario === "all" ||
        name === values.scenario ||
        (groups.includes(values.scenario) &&
          name.startsWith(`${values.scenario}-`)),
    );
    if (!Number.isSafeInteger(repeat) || repeat < 1)
      throw new Error("--repeat must be a positive integer");
    if (!["chromium", "webkit"].includes(values.browser))
      throw new Error("--browser must be chromium or webkit");
    if (
      values.browser === "webkit" &&
      selected.some((name) => !name.startsWith("thread-scroll-"))
    )
      throw new Error("WebKit runs only the thread-scroll cases");
    if (values.browser === "webkit" && cpu !== 4 && cpu !== 1)
      throw new Error("--cpu applies to Chromium only");
    if (!Number.isFinite(cpu) || cpu < 1)
      throw new Error("--cpu must be a finite number >= 1");
    if (values.out !== undefined && !values.out.trim())
      throw new Error("--out must name a JSON file");
    const parent = resolve(root, "test-results/perf");
    mkdirSync(parent, { recursive: true });
    const runDir = mkdtempSync(`${parent}/run-`);
    const out = resolve(values.out ?? `${runDir}/results.json`);
    mkdirSync(dirname(out), { recursive: true });
    // A killed runner or reporter failure must not leave an old successful
    // summary at an explicitly reused output path.
    writeFileSync(
      out,
      `${JSON.stringify({ schemaVersion: 1, status: "running", evidenceDir: runDir })}\n`,
    );
    console.log(`Performance results: ${out}\nEvidence: ${runDir}`);
    const child = spawnSync(
      process.execPath,
      [
        createRequire(import.meta.url).resolve("@playwright/test/cli"),
        "test",
        "--config",
        "tests/browser/perf.config.mjs",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          PERF_SCENARIO: values.scenario,
          PERF_CASES: selected.join(","),
          PERF_REPEAT: String(repeat),
          // WebKit has no CPU throttling; record what actually ran.
          PERF_CPU: String(values.browser === "webkit" ? 1 : cpu),
          PERF_BROWSER: values.browser,
          PERF_RUN_DIR: runDir,
          PERF_OUT: out,
        },
      },
    );
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    if (process.exitCode === 0) {
      const result = JSON.parse(readFileSync(out, "utf8"));
      if (result.status !== "passed" || result.evidenceDir !== runDir)
        throw new Error("Run finished without a successful results file");
    }
  }
} catch (error) {
  console.error(`perf: ${error.message}`);
  process.exitCode = 1;
}
