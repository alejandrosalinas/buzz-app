import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { imageEngines } from "../../scripts/check-browser-image.mjs";
import ciConfig from "../browser/playwright.ci.config.mjs";
import config from "../browser/playwright.config.mjs";
import { run } from "../browser/run-command.mjs";

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/ci.yml");
// These guards intentionally follow this workflow's small, literal job matrix.
// Unsupported YAML shapes fail rather than silently selecting fewer jobs.
const job = (name) => {
  const body = workflow.match(
    new RegExp(`^ {2}${name}:\n([\\s\\S]*?)(?=^ {2}\\w+:|$(?![\\s\\S]))`, "m"),
  )?.[1];
  assert.ok(body, `${name} job must exist`);
  return body;
};
const browser = job("browser");
// Expand the browser matrix the way Actions does: engine × shard, minus
// exclusions, with each engine's include supplying its shard denominator.
const browserJobs = () => {
  const {
    engine,
    shard,
    exclude = [],
    include = [],
  } = parse(workflow).jobs.browser.strategy.matrix;
  return engine.flatMap((name) => {
    const { shards } = include.find((entry) => entry.engine === name) ?? {};
    assert.ok(Number.isInteger(shards), `${name} must declare its shard total`);
    const selected = shard.filter(
      (n) =>
        !exclude.some((entry) => entry.engine === name && entry.shard === n),
    );
    assert.deepEqual(
      selected,
      Array.from({ length: shards }, (_, i) => i + 1),
      `${name} must run shards 1..${shards}`,
    );
    return selected.map((n) => ({ engine: name, shard: n, shards }));
  });
};

test("native protection produces upload evidence and preserves a failed test status", (t) => {
  if (process.platform === "win32") return t.skip("macOS shell step");
  const step = parse(workflow).jobs.agent_protection.steps.find(
    (step) => step.name === "Native approval-state and window-state tests",
  );
  const root = mkdtempSync(join(tmpdir(), "buzz-native-evidence-"));
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(
      join(root, "bin/cargo"),
      '#!/bin/sh\nprintf "kernel stdout\\n"\nprintf "kernel stderr\\n" >&2\nexit "$FIXTURE_CARGO_STATUS"\n',
      { mode: 0o755 },
    );
    for (const code of [0, 19]) {
      const result = spawnSync("/bin/bash", ["-e", "-c", step.run], {
        cwd: root,
        env: { ...process.env, FIXTURE_CARGO_STATUS: String(code) },
      });
      assert.equal(result.status, code, result.stderr?.toString());
      assert.equal(
        readFileSync(join(root, "test-results/protection/native.log"), "utf8"),
        "kernel stdout\nkernel stderr\n",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux shards and macOS recording discover every CI functional test/project exactly once", (t) => {
  const command = browser.match(
    /^ {8}run: .+ -- (\.\/bin\/pnpm test:browser:ci .+)$/m,
  )?.[1];
  assert.ok(command, "functional invocation must exist");
  const discover = (args) => {
    const report = JSON.parse(
      run("pnpm", ["--silent", ...args, "--list", "--reporter=json"]),
    );
    assert.deepEqual(report.errors, []);
    const collect = (suites) =>
      suites.flatMap((suite) => [
        ...suite.specs.flatMap((spec) =>
          spec.tests.map((entry) => {
            assert.ok(
              ["chromium", "webkit"].includes(entry.projectName),
              "no measurements on functional runners",
            );
            return `${entry.projectName}:${spec.id}`;
          }),
        ),
        ...collect(suite.suites ?? []),
      ]);
    return collect(report.suites);
  };
  const expected = discover([
    "test:browser",
    "--project",
    "chromium",
    "--project",
    "webkit",
    "--no-deps",
    "--grep-invert",
    "@classic-scrollbars|@local-only",
  ]);
  assert.ok(expected.length > 0);
  const actual = [];
  for (const { engine, shard, shards } of browserJobs()) {
    // Exercise the actual workflow command, including its shard denominator.
    const expanded = command
      .replaceAll(/\$\{\{ matrix\.engine \}\}/g, engine)
      .replaceAll(/\$\{\{ matrix\.shard \}\}/g, shard)
      .replaceAll(/\$\{\{ matrix\.shards \}\}/g, shards);
    const selected = discover(
      expanded.replace(/^\.\/bin\/pnpm /, "").split(/\s+/),
    );
    assert.ok(selected.length > 0, `${engine}/${shard} must select tests`);
    assert.ok(selected.every((id) => id.startsWith(`${engine}:`)));
    actual.push(...selected);
    t.diagnostic(`${engine}/${shard}: ${selected.length} functional tests`);
  }
  const recording = parse(workflow).jobs.media_recorder.steps.find(
    (step) => step.name === "Recording journeys",
  );
  assert.equal(recording.if, undefined);
  assert.equal(recording["continue-on-error"], undefined);
  const recordingCommand = recording.run.match(
    / -- (\.\/bin\/pnpm test:browser .+)$/,
  )?.[1];
  assert.ok(recordingCommand, "macOS must execute the recording cases");
  const mac = discover(
    recordingCommand.replace(/^\.\/bin\/pnpm /, "").split(/\s+/),
  );
  assert.ok(mac.length > 0, "macOS recording must select tests");
  assert.ok(mac.every((id) => id.startsWith("webkit:")));
  actual.push(...mac);
  t.diagnostic(`macOS WebKit: ${mac.length} recording tests`);
  assert.equal(
    new Set(actual).size,
    actual.length,
    "no duplicate test/project across Linux shards and macOS",
  );
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    "Linux and macOS must cover functional discovery without local-only cases",
  );
});

test("classic-scrollbar cases run exactly once, after the measurements, without clearing their evidence", () => {
  const { steps } = parse(workflow).jobs.measurements;
  const serial = steps.findIndex(
    (step) => step.name === "Serial Chromium and WebKit measurements",
  );
  const classic = steps.find(
    (step) => step.name === "Chromium classic-scrollbar layout",
  );
  assert.ok(serial >= 0 && classic, "both Playwright steps must exist");
  assert.ok(steps.indexOf(classic) > serial, "classic cases run afterwards");
  assert.equal(classic.if, undefined);
  assert.equal(classic["continue-on-error"], undefined);
  const command = classic.run.match(
    /^\.\/bin\/node scripts\/ci-test-report\.mjs kind=playwright report=(\S+) evidence=(\S+) title="[^"]+" -- (\.\/bin\/pnpm test:browser:ci --project chromium-classic-scrollbars --no-deps --reporter=list,json)$/,
  );
  assert.ok(command, "classic step must report through ci-test-report");
  const [, report, evidence, invocation] = command;
  assert.equal(classic.env.PLAYWRIGHT_JSON_OUTPUT_FILE, report);
  // A Playwright run clears the outputDir of every project it selects. The
  // second run must therefore own a directory the measurement report and the
  // per-test evidence never live in, and the artifact must upload both. The
  // step runs the CI config, so resolve the project there and require the
  // local config to agree: a CI-only override of the launch arguments or the
  // output directory would otherwise pass this gate unnoticed.
  const classicProject = (candidate) =>
    candidate.name === "chromium-classic-scrollbars";
  const project = ciConfig.projects.find(classicProject);
  assert.ok(project, "chromium-classic-scrollbars project must exist in CI");
  assert.deepEqual(
    project,
    config.projects.find(classicProject),
    "CI must run the classic project exactly as the local gate defines it",
  );
  assert.equal(ciConfig.outputDir, config.outputDir);
  assert.equal(project.use.browserName, "chromium");
  assert.deepEqual(project.use.launchOptions.ignoreDefaultArgs, [
    "--hide-scrollbars",
  ]);
  const outputDir = (dir) => posix.normalize(posix.join("tests/browser", dir));
  const measurementDir = outputDir(ciConfig.outputDir);
  const classicDir = outputDir(project.outputDir);
  assert.notEqual(classicDir, measurementDir);
  assert.ok(!classicDir.startsWith(`${measurementDir}/`));
  assert.ok(!measurementDir.startsWith(`${classicDir}/`));
  assert.ok(
    steps[serial].env.PLAYWRIGHT_JSON_OUTPUT_FILE.startsWith(
      `${measurementDir}/`,
    ),
  );
  for (const path of [report, evidence])
    assert.ok(
      path.startsWith(`${classicDir}/`),
      `${path} stays in its own dir`,
    );
  const upload = steps.find((step) => step.name === "Measurement evidence");
  assert.deepEqual(
    upload.with.path
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .sort(),
    [
      measurementDir,
      classicDir,
      "test-results/perf",
      "test-results/broker-scale",
    ].sort(),
  );
  // The tagged cases belong to this project alone: the engine shards above
  // exclude the tag, and this project selects nothing else.
  const list = (args) => {
    const listed = JSON.parse(
      run("pnpm", ["--silent", ...args, "--list", "--reporter=json"]),
    );
    assert.deepEqual(listed.errors, []);
    const collect = (suites) =>
      suites.flatMap((suite) => [
        ...(suite.specs ?? []),
        ...collect(suite.suites ?? []),
      ]);
    return collect(listed.suites);
  };
  const selected = list(invocation.replace(/^\.\/bin\/pnpm /, "").split(/\s+/));
  assert.ok(selected.length > 0, "the classic project must select tests");
  for (const spec of selected) {
    assert.ok(spec.tags.includes("classic-scrollbars"), spec.title);
    for (const entry of spec.tests)
      assert.equal(entry.projectName, "chromium-classic-scrollbars");
  }
  const functional = list([
    "test:browser:ci",
    "--project",
    "chromium",
    "--project",
    "webkit",
    "--no-deps",
  ]);
  assert.ok(functional.length > 0);
  for (const spec of functional)
    assert.ok(!spec.tags.includes("classic-scrollbars"), spec.title);
});

test("required gate executes its real shell and rejects every unsuccessful lane", () => {
  const required = job("required");
  const { jobs } = parse(workflow);
  assert.equal(
    jobs.required.name,
    `\${{ github.event_name == 'workflow_dispatch' && 'Automatic CI (not requested)' || 'CI required' }}`,
  );
  assert.equal(
    jobs.required.if,
    "always() && github.event_name != 'workflow_dispatch'",
  );
  assert.doesNotMatch(required, /^ {8}if:/m);
  assert.match(
    required,
    /^ {4}needs: \[javascript, native, measurements, browser_fixture, browser, media_recorder, agent_protection\]$/m,
  );
  assert.doesNotMatch(required, /continue-on-error/);
  const lanes = [
    "JAVASCRIPT",
    "NATIVE",
    "MEASUREMENTS",
    "FIXTURE",
    "BROWSER",
    "MEDIA_RECORDER",
    "AGENT_PROTECTION",
  ];
  for (const lane of lanes)
    assert.ok(
      required.includes(
        `${lane}: \${{ needs.${lane === "FIXTURE" ? "browser_fixture" : lane.toLowerCase()}.result }}`,
      ),
    );
  const script = required.match(/^ {8}run: \|\n((?: {10}.+\n?)+)/m)?.[1];
  assert.ok(script, "required shell must exist");
  const execute = (results) =>
    spawnSync("bash", ["-e", "-c", script], {
      env: { PATH: process.env.PATH, ...results },
      encoding: "utf8",
      timeout: 5000,
    });
  const success = Object.fromEntries(lanes.map((lane) => [lane, "success"]));
  assert.equal(execute(success).status, 0);
  for (const lane of lanes) {
    for (const result of ["failure", "skipped", "cancelled", "", undefined]) {
      const results = { ...success, [lane]: result };
      if (result === undefined) delete results[lane];
      assert.equal(execute(results).status, 1, `${lane}=${result} must fail`);
    }
  }
});

test("image verification rejects version/image mismatch and never silently omits an engine", () => {
  const version = JSON.parse(read("package.json")).devDependencies[
    "@playwright/test"
  ];
  const info = {
    driverVersion: version,
    dockerImageName: `mcr.microsoft.com/playwright:v${version}-noble`,
  };
  assert.deepEqual(imageEngines(info, version, "all"), ["chromium", "webkit"]);
  for (const engine of ["chromium", "webkit"])
    assert.deepEqual(imageEngines(info, version, engine), [engine]);
  for (const engine of [
    "",
    "firefox",
    "chromium webkit",
    "chromium;echo unexpected",
  ])
    assert.throws(() => imageEngines(info, version, engine));
  for (const bad of [
    {},
    { ...info, driverVersion: "0.0.0" },
    { ...info, dockerImageName: "untrusted/image" },
  ])
    assert.throws(() => imageEngines(bad, version, "all"));
});

test("setup calls pinned entry points and fails before caching an empty pnpm path", (t) => {
  const { steps } = parse(read(".github/actions/setup/action.yml")).runs;
  const verify = steps.find(
    (step) => step.name === "Verify pinned tool entry points",
  );
  const store = steps.find((step) => step.id === "pnpm");
  assert.ok(steps.indexOf(verify) < steps.indexOf(store));
  assert.deepEqual(verify.run.trim().split("\n"), [
    "scripts/ci-retry.sh 3 120 ./bin/node --version",
    "scripts/ci-retry.sh 3 120 ./bin/pnpm --version",
  ]);
  assert.doesNotMatch(
    read(".github/actions/setup/action.yml"),
    /GITHUB_PATH|HERMIT_PREPEND_PATH/,
  );
  const cwd = mkdtempSync(join(tmpdir(), "buzz-pnpm-path-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "bin"));
  writeFileSync(
    join(cwd, "bin", "pnpm"),
    '#!/bin/sh\n[ "$1 $2 $3" = "store path --silent" ] || exit 2\nprintf "%s" "$STORE"\nexit "$RESULT"\n',
    { mode: 0o755 },
  );
  const output = join(cwd, "output");
  const execute = (path, result = "0") => {
    writeFileSync(output, "");
    return spawnSync("bash", ["-eo", "pipefail", "-c", store.run], {
      cwd,
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        STORE: path,
        RESULT: result,
      },
      encoding: "utf8",
      timeout: 5000,
    });
  };
  assert.equal(execute("/pinned store").status, 0);
  assert.equal(readFileSync(output, "utf8"), "path=/pinned store\n");
  assert.notEqual(execute("").status, 0);
  assert.equal(readFileSync(output, "utf8"), "");
  assert.equal(execute("", "7").status, 7);
  assert.equal(readFileSync(output, "utf8"), "");
});

test("tool fetch retry ends stalled tries, retries failures and keeps the last status", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-ci-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Each call of the fake fetch acts out the next line of its plan. A stall
  // leaves a grandchild holding the output pipes, as Hermit's download would.
  const fetch = join(dir, "fetch");
  writeFileSync(
    fetch,
    `#!/bin/bash
n=$(( $(cat "$DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$DIR/count"
case "$(sed -n "\${n}p" "$DIR/plan")" in
  ok) echo fetched ;;
  fail) exit 101 ;;
  stall) sleep 60 & wait ;;
  deaf) trap '' TERM; sleep 60 & wait ;;
  orphan) (trap '' TERM; exec sleep 60) & wait ;;
esac
`,
    { mode: 0o755 },
  );
  const run = (plan, ...args) => {
    writeFileSync(join(dir, "plan"), `${plan.join("\n")}\n`);
    rmSync(join(dir, "count"), { force: true });
    // spawnSync returns only once every holder of its pipes has exited, so a
    // stalled try's grandchild that outlived its deadline would time it out.
    const result = spawnSync(
      "bash",
      [
        fileURLToPath(new URL("../../scripts/ci-retry.sh", import.meta.url)),
        ...args,
      ],
      { env: { ...process.env, DIR: dir }, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.error, undefined);
    let calls = 0;
    try {
      calls = Number(readFileSync(join(dir, "count"), "utf8"));
    } catch {}
    const warnings = result.stdout.match(/^::warning::.*$/gm) ?? [];
    return { ...result, calls, warnings };
  };

  const recovered = run(["fail", "stall", "ok"], "3", "1", fetch);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.calls, 3);
  assert.match(recovered.stdout, /^fetched$/m);
  assert.match(recovered.stderr, /did not finish within 1 s/);
  assert.deepEqual(recovered.warnings, [
    `::warning::${fetch} failed with exit 101; starting try 2 of 3`,
    `::warning::${fetch} failed with exit 124; starting try 3 of 3`,
  ]);

  const first = run(["ok", "fail"], "3", "1", fetch);
  assert.equal(first.status, 0);
  assert.equal(first.calls, 1);
  assert.deepEqual(first.warnings, []);

  const exhausted = run(["fail", "fail", "fail", "ok"], "3", "1", fetch);
  assert.equal(exhausted.status, 101);
  assert.equal(exhausted.calls, 3);
  assert.equal(exhausted.warnings.length, 2);

  // A try that ignores TERM is killed after the grace period.
  const deaf = run(["deaf"], "1", "1", fetch);
  assert.equal(deaf.status, 124);
  assert.equal(deaf.calls, 1);
  // A grandchild that ignores TERM is killed once the command exits on it.
  const orphan = run(["orphan"], "1", "1", fetch);
  assert.equal(orphan.status, 124);
  assert.equal(orphan.calls, 1);

  for (const args of [[], ["3", "1"], ["0", "1", fetch], ["3", "1s", fetch]]) {
    const usage = run(["ok"], ...args);
    assert.equal(usage.status, 2);
    assert.equal(usage.calls, 0);
  }
});
