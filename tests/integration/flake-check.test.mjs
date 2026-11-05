import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bestRoute,
  browserLaneSeconds,
  browserShards,
  classify,
  costModel,
  costTable,
  hunkRanges,
  LANE_BUDGET_MINUTES,
  listBrowser,
  listVitest,
  moduleGraph,
  moduleName,
  namesake,
  patchedPackage,
  reachesTests,
  repeatableLines,
  selectTests,
  takeRelated,
  testBodies,
  testCalls,
  vitestFilters,
  vitestLaneSeconds,
} from "../../scripts/flake-check.mjs";

// A hunk writing new-side lines start..end; by default it removed nothing.
const hunk = (start, end, removed = { start: start + 1, end: start }) => ({
  start,
  end,
  removed,
});

test("classification follows the Vitest include globs and the Playwright spec directory", () => {
  for (const file of [
    "src/shared/theme/service.test.ts",
    "src/App.test.tsx",
    "src/plugins/x/y.test.mjs",
    "browser-host/runtime.test.mjs",
    "scripts/ci-test-report.test.ts",
    "scripts/nested/tool.test.mjs",
    "tests/fixtures/design-system/tokens.test.tsx",
  ])
    assert.equal(classify(file), "vitest", file);
  assert.equal(classify("tests/browser/layout.spec.mjs"), "browser");
  for (const file of [
    "src/shared/theme/service.ts",
    "src/shared/theme/service.spec.ts",
    "scripts/flake-check.mjs",
    "tests/integration/flake-check.test.mjs",
    "tests/browser/fixtures/helper.spec.mjs",
    "tests/browser/layout.spec.ts",
    "crates/foo/src/lib.rs",
    // Selections are shell-split downstream; refuse unusual names.
    "src/odd name.test.ts",
    "src/$(id).test.ts",
  ])
    assert.equal(classify(file), undefined, file);
});

test("-U0 hunks map to new-side ranges, with deletions attached to the preceding line and their old-side lines kept", () => {
  const diff = [
    "diff --git a/x.test.ts b/x.test.ts",
    "--- a/x.test.ts",
    "+++ b/x.test.ts",
    "@@ -1 +1 @@",
    '-import { it } from "vitest";',
    '+import { expect, it } from "vitest";',
    "@@ -12,0 +13,3 @@ it('a', () => {",
    "+  const x = 1;",
    "+  const y = 2;",
    "+  expect(x).toBe(y - 1);",
    "@@ -30,2 +33,0 @@ it('b', () => {",
    "-  removed();",
    "-  alsoRemoved();",
    "@@ -1,3 +0,0 @@",
    "-gone",
    "",
  ].join("\n");
  assert.deepEqual(hunkRanges(diff), [
    { start: 1, end: 1, removed: { start: 1, end: 1 } },
    { start: 13, end: 15, removed: { start: 12, end: 11 } },
    { start: 33, end: 33, removed: { start: 30, end: 31 } },
    { start: 0, end: 0, removed: { start: 1, end: 3 } },
  ]);
  assert.deepEqual(hunkRanges(""), []);
});

test("test bodies span the listed test's call; groups, hooks and helpers are outside", () => {
  const source = [
    'import { afterAll, beforeEach, describe, expect, it } from "vitest";',
    "const shared = 1;",
    "function mount(props: { x?: number } = {}) {",
    "  return <div>{props.x ?? shared}</div>;",
    "}",
    'it("first", () => {',
    "  expect(mount()).toMatch(/a\\/b/);",
    "});",
    "function helper() {",
    '  return ")" + shared;',
    "}",
    'describe("group", () => {',
    "  beforeEach(() => {",
    "    helper();",
    "  });",
    "  it.each([",
    "    [1],",
    "    [2],",
    '  ])("case %s", (n) => {',
    "    expect(n).toBe(n);",
    "  });",
    '  it.skip("later", async () => {',
    "    await Promise.resolve();",
    "  });",
    "});",
    "afterAll(() => {",
    "  helper();",
    "});",
    "",
  ].join("\n");
  // Vitest lists the `it.each` cases at the second parenthesis (line 19).
  const listed = [19, 19, 22, 6];
  const bodies = testBodies(source, "tsx", listed);
  assert.deepEqual(bodies, [
    { start: 6, end: 8, line: 6 },
    { start: 16, end: 21, line: 19 },
    { start: 22, end: 24, line: 22 },
  ]);
  const select = (ranges) => selectTests(ranges, bodies);
  // Inside a body, including its closing line, selects only that test.
  assert.deepEqual(select([hunk(7, 7)]), { lines: [6] });
  assert.deepEqual(select([hunk(21, 21)]), { lines: [19] });
  assert.deepEqual(select([hunk(23, 24)]), { lines: [22] });
  // Filters preserve runtime-listed locations, including parameterized calls.
  assert.deepEqual(vitestFilters("cases.test.tsx", { lines: [6, 19, 22] }), [
    "cases.test.tsx:6",
    "cases.test.tsx:19",
    "cases.test.tsx:22",
  ]);
  assert.deepEqual(vitestFilters("cases.test.tsx", { whole: true }), [
    "cases.test.tsx",
  ]);
  // A helper between tests, a hook inside the group, and a hook after the
  // last test are shared code.
  for (const range of [hunk(10, 10), hunk(14, 14), hunk(27, 27), hunk(2, 2)])
    assert.deepEqual(select([range]), {
      whole: true,
      reason: "shared code changed",
    });
  // A test the runner lists outside any `test`/`it` call has no body.
  assert.deepEqual(testBodies(source, "tsx", [10]), []);
  assert.deepEqual(testCalls(source, "tsx"), [
    { start: 6, end: 8 },
    { start: 16, end: 21 },
    { start: 22, end: 24 },
  ]);
  // Playwright: `test.use` is configuration, `test.describe` a group and
  // `test.beforeEach` a hook; none is a test call, listed or not.
  const spec = [
    'import { test } from "@playwright/test";',
    "test.use({ viewport: { width: 800, height: 600 } });",
    'test.describe("suite", () => {',
    "  test.beforeEach(async ({ page }) => {",
    '    await page.goto("/");',
    "  });",
    '  test("journey", { tag: ["@local-webkit"] }, async ({ page }) => {',
    '    await page.click("text=Go");',
    "  });",
    "});",
    "",
  ].join("\n");
  assert.deepEqual(testCalls(spec, "js"), [{ start: 7, end: 9 }]);
  assert.deepEqual(testBodies(spec, "js", [7]), [
    { start: 7, end: 9, line: 7 },
  ]);
});

test("the selection executes every case of a multiline Vitest parameterized test", (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  // Vitest only collects files its include globs match under the repository,
  // so the fixture cannot live in a temp dir. vitest.config.ts excludes it
  // unless this is set; the Vitest processes below inherit it.
  process.env.BUZZ_FLAKE_CHECK_FIXTURE = "1";
  t.after(() => delete process.env.BUZZ_FLAKE_CHECK_FIXTURE);
  const dir = mkdtempSync(
    join(root, "tests/fixtures/design-system/flake-selection-"),
  );

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "cases.test.tsx");
  const source = [
    'import { expect, it } from "vitest";',
    'const label = "Checking…";',
    'it.each(["archive", "unarchive", "delete"] as const)(',
    '  "%s completion preserves focus moved during pending work and retains required navigation",',
    "  (action) => { expect(action).toBeTruthy(); },",
    ");",
    "",
    "it.for([",
    '  "mouse", "keyboard",',
    "] as const)(",
    '  "supports %s",',
    "  (input) => { expect(input).toBeTruthy(); },",
    ");",
    // Force static collection's transformed source-map path, as in React tests.
    "const sibling = <div />;",
    'it("untouched", () => { throw new Error("outside selection"); });',
    "",
  ].join("\n");
  writeFileSync(file, source);
  const run = (args) =>
    spawnSync(join(root, "bin/pnpm"), ["--silent", "exec", "vitest", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  const locations = listVitest([relative(root, file)]).get(
    relative(root, file),
  );
  assert.equal(
    locations.length,
    6,
    "runtime collection must list every parameterized case and the unrelated test",
  );
  const bodies = testBodies(source, "tsx", locations);
  const selection = selectTests([hunk(5, 5), hunk(12, 12)], bodies);
  assert.equal(
    selection.whole,
    undefined,
    "unrelated tests must not be selected",
  );
  const report = join(dir, "result.json");
  const result = run([
    "run",
    ...vitestFilters(file, selection),
    "--reporter=json",
    `--outputFile=${report}`,
  ]);
  const data = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(
    result.status,
    0,
    result.stdout + result.stderr + JSON.stringify(data),
  );
  const passed = data.testResults
    .flatMap(({ assertionResults }) => assertionResults)
    .filter(({ status }) => status === "passed");
  assert.deepEqual(
    passed.map(({ title }) => title),
    [
      ...["archive", "unarchive", "delete"].map(
        (action) =>
          `${action} completion preserves focus moved during pending work and retains required navigation`,
      ),
      "supports mouse",
      "supports keyboard",
    ],
  );
  assert.deepEqual(
    data.testResults
      .flatMap(({ assertionResults }) => assertionResults)
      .filter(({ status }) => status === "skipped")
      .map(({ title }) => title),
    ["untouched"],
  );
});

test("hunks inside tests select those tests; shared code, new or unlisted files select the whole file", () => {
  const bodies = [
    { start: 10, end: 22, line: 10 },
    { start: 25, end: 37, line: 25 },
    { start: 38, end: 52, line: 40 },
  ];
  // The old file had the same tests, with a hook between the last two.
  const previous = [
    { start: 10, end: 22 },
    { start: 25, end: 37 },
    { start: 41, end: 55 },
  ];
  const select = (ranges, options) =>
    selectTests(ranges, bodies, { previous, ...options });
  // Edit inside one test, including its first and last lines.
  assert.deepEqual(select([hunk(12, 14)]), { lines: [10] });
  assert.deepEqual(select([hunk(10, 10)]), { lines: [10] });
  assert.deepEqual(select([hunk(22, 22)]), { lines: [10] });
  // A hunk across two adjacent bodies selects both, by their listed lines.
  assert.deepEqual(select([hunk(36, 39)]), { lines: [25, 40] });
  // A hunk that also covers the gap between tests, or lines after the last
  // test, touches shared code.
  for (const range of [hunk(22, 25), hunk(52, 53), hunk(400, 405)])
    assert.deepEqual(select([range]), {
      whole: true,
      reason: "shared code changed",
    });
  // Several hunks accumulate distinct tests in file order.
  assert.deepEqual(select([hunk(41, 41), hunk(11, 11), hunk(12, 12)]), {
    lines: [10, 40],
  });
  // Replacing lines inside a test, or deleting some of them (attached to the
  // preceding line), selects that test when the old lines were its own.
  assert.deepEqual(select([hunk(30, 31, { start: 30, end: 32 })]), {
    lines: [25],
  });
  assert.deepEqual(select([hunk(30, 30, { start: 31, end: 32 })]), {
    lines: [25],
  });
  // Deleting the hook that followed the second test attaches to that test's
  // closing line, but the removed lines were never a test's.
  assert.deepEqual(select([hunk(37, 37, { start: 38, end: 40 })]), {
    whole: true,
    reason: "shared code removed",
  });
  // Deletion at the top of the file (line 0) and edits before the first test
  // fall back to the whole file.
  assert.deepEqual(select([hunk(0, 0, { start: 1, end: 1 })]), {
    whole: true,
    reason: "shared code removed",
  });
  assert.deepEqual(select([hunk(12, 12), hunk(3, 3)]), {
    whole: true,
    reason: "shared code changed",
  });
  assert.deepEqual(select([hunk(12, 12)], { added: true }), {
    whole: true,
    reason: "new file",
  });
  assert.deepEqual(selectTests([hunk(12, 12)], []), {
    whole: true,
    reason: "no tests listed",
  });
  // Without old-side calls, every removal is shared code.
  assert.deepEqual(
    selectTests([hunk(30, 30, { start: 31, end: 32 })], bodies),
    {
      whole: true,
      reason: "shared code removed",
    },
  );
});

// A Vitest hook and a Playwright namespaced hook, each directly after test a
// (lines 3-5) and before test b (lines 9-11) with no blank line between.
const hookSources = {
  ts: [
    'import { afterEach, describe, expect, it } from "vitest";',
    'describe("group", () => {',
    '  it("a", () => {',
    "    expect(1).toBe(1);",
    "  });",
    "  afterEach(() => {",
    "    cleanup();",
    "  });",
    '  it("b", () => {',
    "    expect(2).toBe(2);",
    "  });",
    "});",
    "",
  ],
  js: [
    'import { expect, test } from "@playwright/test";',
    'test.describe("suite", () => {',
    '  test("a", async ({ page }) => {',
    "    await expect(page).toHaveTitle(/a/);",
    "  });",
    "  test.afterEach(async ({ page }) => {",
    "    await page.close();",
    "  });",
    '  test("b", async ({ page }) => {',
    "    await expect(page).toHaveTitle(/b/);",
    "  });",
    "});",
    "",
  ],
};

for (const [lang, lines] of Object.entries(hookSources))
  test(`deleting a shared hook after a test selects the whole file through a real diff (${lang})`, () => {
    const previous = testCalls(lines.join("\n"), lang);
    assert.deepEqual(previous, [
      { start: 3, end: 5 },
      { start: 9, end: 11 },
    ]);
    // `git diff -U0` for removing lines 6-8: the hunk attaches to line 5, the
    // closing line of test a, which the old-side range shows was not the
    // hook's.
    const hookDiff = [
      "@@ -6,3 +5,0 @@",
      ...lines.slice(5, 8).map((line) => `-${line}`),
      "",
    ].join("\n");
    assert.deepEqual(
      selectTests(
        hunkRanges(hookDiff),
        testBodies(lines.toSpliced(5, 3).join("\n"), lang, [3, 6]),
        { previous },
      ),
      { whole: true, reason: "shared code removed" },
    );
    // Removing test b's assertion (old line 10) attaches to its first line and
    // selects only test b.
    const bodyDiff = ["@@ -10 +9,0 @@", `-${lines[9]}`, ""].join("\n");
    assert.deepEqual(
      selectTests(
        hunkRanges(bodyDiff),
        testBodies(lines.toSpliced(9, 1).join("\n"), lang, [3, 9]),
        { previous },
      ),
      { lines: [9] },
    );
  });

test("journeys tagged for special projects or platforms are never repeated", () => {
  assert.deepEqual(
    repeatableLines([
      { line: 10, tags: [] },
      { line: 20, tags: ["media-recorder"] },
      { line: 30, tags: ["local-webkit"] },
      { line: 40, tags: ["classic-scrollbars"] },
      { line: 50, tags: ["other"] },
    ]),
    [10, 50],
  );
});

test("measurement specs list no engine journeys, alone or beside functional specs", () => {
  const measurements = [
    "tests/browser/channel-opening.spec.mjs",
    "tests/browser/scroll.spec.mjs",
  ];
  assert.deepEqual(
    listBrowser(measurements),
    new Map(measurements.map((file) => [file, []])),
  );
  const mixed = listBrowser([
    "tests/browser/scroll.spec.mjs",
    "tests/browser/voice-notes.spec.mjs",
  ]);
  assert.deepEqual(mixed.get("tests/browser/scroll.spec.mjs"), []);
  const journeys = mixed.get("tests/browser/voice-notes.spec.mjs");
  assert.ok(journeys.length > 1, "functional spec must list its journeys");
  assert.ok(
    journeys.some((spec) => spec.tags.includes("media-recorder")),
    "the listing keeps tagged journeys so they still own their line ranges",
  );
  assert.ok(repeatableLines(journeys).length < journeys.length);
});

test("browser repetitions get one shard per five journeys, at most sixteen", () => {
  assert.deepEqual(
    [0, 1, 5, 6, 18, 40, 41, 80, 81, 200].map(browserShards),
    [1, 1, 1, 2, 4, 8, 9, 16, 16, 16],
  );
});

test("source, helper, fixture and patch changes can reach tests; root configuration and docs cannot", () => {
  for (const file of [
    "src/bundled/emoji/CustomEmoji.tsx",
    "src/features/messages/Messages.module.css",
    "tests/browser/timeline.mjs",
    "tests/fixtures/emoji.html",
    "browser-host/runtime.mjs",
    "patches/@base-ui__react@1.9.0.patch",
  ])
    assert.equal(reachesTests(file), true, file);
  for (const file of [
    "package.json",
    "vite.config.ts",
    "docs/buzz-help.md",
    // Test files are selected by their own hunks.
    "src/App.test.tsx",
    "tests/browser/layout.spec.mjs",
  ])
    assert.equal(reachesTests(file), false, file);
  assert.equal(
    patchedPackage("patches/@base-ui__react@1.9.0.patch"),
    "@base-ui/react",
  );
  assert.equal(patchedPackage("patches/sonner@2.0.8.patch"), "sonner");
  assert.equal(patchedPackage("patches/README.md"), undefined);
});

test("journeys reach product, stylesheet, package and helper changes through fixture pages and imports", async () => {
  const [reactions, overlays] = [
    "tests/browser/reactions-polish.spec.mjs",
    "tests/browser/message-overlays.spec.mjs",
  ];
  const graph = await moduleGraph([reactions, overlays]);
  // Page scripts resolve relative to the page or, with a leading slash, the
  // repository root.
  assert.equal(
    graph.pages.get("tests/fixtures/emoji.html"),
    "tests/fixtures/emoji.tsx",
  );
  assert.equal(
    graph.pages.get("tests/fixtures/conversation.html"),
    "tests/fixtures/conversation.tsx",
  );
  for (const changed of [
    "src/bundled/emoji/CustomEmoji.tsx",
    // emoji.tsx imports globals.css, which @imports the tokens.
    "src/shared/design-system/styles/tokens.css",
    "npm:@base-ui/react",
  ]) {
    const route = bestRoute(graph, reactions, [changed]);
    assert.equal(route?.via, "tests/fixtures/emoji.html", changed);
    assert.deepEqual(route.files, [changed]);
  }
  // A helper reaches the specs importing it through their own graph.
  assert.equal(
    bestRoute(graph, overlays, ["tests/browser/timeline.mjs"])?.via,
    overlays,
  );
  assert.equal(bestRoute(graph, reactions, ["docs/buzz-help.md"]), undefined);
});

test("the best route is the smallest graph holding a changed file", () => {
  const graph = {
    edges: new Map([
      ["spec", new Set(["helper", "small.html", "large.html"])],
      ["small", new Set(["a"])],
      ["large", new Set(["a", "b", "c"])],
    ]),
    pages: new Map([
      ["small.html", "small"],
      ["large.html", "large"],
    ]),
  };
  // The small page holds less of the change but is more specific to it.
  assert.deepEqual(bestRoute(graph, "spec", ["a", "b"]), {
    files: ["a"],
    size: 3,
    via: "small.html",
  });
  assert.deepEqual(bestRoute(graph, "spec", ["b"]), {
    files: ["b"],
    size: 5,
    via: "large.html",
  });
  assert.deepEqual(bestRoute(graph, "spec", ["helper"]), {
    files: ["helper"],
    size: 4,
    via: "spec",
  });
  assert.equal(bestRoute(graph, "spec", ["d"]), undefined);
});

test("a test is named after a changed module by its whole name or leading words", () => {
  assert.equal(moduleName("src/bundled/emoji/CustomEmoji.tsx"), "custom-emoji");
  assert.equal(
    moduleName("src/features/messages/Messages.module.css"),
    "messages",
  );
  assert.equal(
    moduleName("src/features/messages/use-file-drop.test.tsx"),
    "use-file-drop",
  );
  assert.equal(
    moduleName("tests/browser/custom-emoji-authoring.spec.mjs"),
    "custom-emoji-authoring",
  );
  const changed = [
    "src/features/messages/ComposerAttachments.tsx",
    "src/bundled/emoji/CustomEmoji.tsx",
    "src/features/messages/Messages.module.css",
  ];
  assert.equal(
    namesake("tests/browser/composer-attachments.spec.mjs", changed),
    changed[0],
  );
  assert.equal(
    namesake("tests/browser/custom-emoji-authoring.spec.mjs", changed),
    changed[1],
  );
  assert.equal(
    namesake("tests/browser/messages.spec.mjs", changed),
    changed[2],
  );
  assert.equal(
    namesake("src/bundled/emoji/CustomEmoji.test.tsx", changed),
    changed[1],
  );
  // Leading words only: a shared prefix inside a word is not a name.
  assert.equal(
    namesake("tests/browser/message-overlays.spec.mjs", changed),
    undefined,
  );
  assert.equal(
    namesake("tests/browser/composer-attachments-extra.spec.mjs", changed),
    changed[0],
  );
  assert.equal(namesake("tests/browser/emoji.spec.mjs", changed), undefined);
});

test("related files run whole, named after a changed module first, then smallest route, until the cap; the one crossing it still runs", () => {
  const candidate = (file, size, cost) => ({
    file,
    route: { files: ["x"], size },
    cost,
  });
  const candidates = [
    candidate("wide", 900, 1),
    candidate("mid-cheap", 500, 3),
    candidate("mid", 500, 10),
    candidate("narrow", 100, 2),
    // Vitest relates it, but the static graph found no route.
    { file: "unrouted", cost: 1 },
    // Named after a changed module: a naming heuristic ranks it ahead of
    // every route.
    { ...candidate("named", 700, 2), namesake: "src/Named.tsx" },
  ];
  const order = ({ taken, overBudget, overCap }) => [
    taken.map(({ file }) => file),
    overBudget.map(({ file }) => file),
    overCap.map(({ file }) => file),
  ];
  assert.deepEqual(order(takeRelated(candidates, Infinity)), [
    ["named", "narrow", "mid-cheap", "mid", "wide", "unrouted"],
    [],
    [],
  ]);
  // "mid-cheap" crosses the cap of 6 and runs; nothing after it does, even
  // when it would fit.
  assert.deepEqual(order(takeRelated(candidates, 6)), [
    ["named", "narrow", "mid-cheap"],
    [],
    ["mid", "wide", "unrouted"],
  ]);
  assert.deepEqual(order(takeRelated(candidates, 0)), [
    [],
    [],
    ["named", "narrow", "mid-cheap", "mid", "wide", "unrouted"],
  ]);
});

test("related files run in rank order while their lane fits the budget; edited tests alone never trim", () => {
  const candidate = (file, size, seconds) => ({
    file,
    route: { files: ["x"], size },
    cost: 1,
    seconds,
  });
  const candidates = [
    candidate("first", 100, 30),
    candidate("heavy", 200, 120),
    candidate("light", 300, 10),
    candidate("last", 400, 10),
  ];
  // The lane already spends `edited` seconds on the tests the pull request
  // edited.
  const lane = (edited) => (taken) =>
    taken.reduce((sum, { seconds }) => sum + seconds, edited);
  const order = ({ taken, overBudget, overCap }) => [
    taken.map(({ file }) => file),
    overBudget.map(({ file }) => file),
    overCap.map(({ file }) => file),
  ];
  // "heavy" would end the lane at 550 s. "light" would still fit, but taking
  // it would run a less specific file in place of a more specific one.
  assert.deepEqual(order(takeRelated(candidates, 3, 540, lane(400))), [
    ["first"],
    ["heavy", "light"],
    ["last"],
  ]);
  // Ending exactly at the budget still fits.
  assert.deepEqual(order(takeRelated(candidates, 3, 550, lane(400))), [
    ["first", "heavy"],
    ["light"],
    ["last"],
  ]);
  // Edited tests over the budget run anyway; no related file joins them.
  assert.deepEqual(order(takeRelated(candidates, 3, 540, lane(600))), [
    [],
    ["first", "heavy", "light"],
    ["last"],
  ]);
  // A longer run that adds a shard can fit where a shorter one did not.
  const sharded = (taken) => (taken.length === 1 ? 600 : 500);
  assert.deepEqual(order(takeRelated(candidates, 3, 540, sharded)), [
    ["first", "heavy", "light"],
    [],
    ["last"],
  ]);
});

test("the cost table keeps each journey's and Vitest file's median passing time over the runs", () => {
  const result = (status, duration) => ({ status, duration });
  const spec = (file, title, chromium, webkit) => ({
    file,
    title,
    tests: [
      { projectName: "chromium", results: [chromium] },
      { projectName: "webkit", results: [webkit] },
      // Measurement projects have their own lanes.
      { projectName: "webkit-measurements", results: [result("passed", 1)] },
    ],
  });
  const playwright = (seconds) => ({
    suites: [
      {
        title: "a.spec.mjs",
        file: "a.spec.mjs",
        specs: [
          spec(
            "a.spec.mjs",
            "top",
            result("passed", seconds * 1000),
            result("passed", seconds * 2000),
          ),
        ],
        suites: [
          {
            title: "group",
            file: "a.spec.mjs",
            specs: [
              spec(
                "a.spec.mjs",
                "inner",
                result("passed", 4000),
                // A failed run says nothing about how long the journey takes.
                result(seconds === 3 ? "failed" : "passed", 30_000),
              ),
            ],
          },
        ],
      },
      // A journey outside tests/browser that the flake check never selects.
      {
        title: "../../src/x.journey.mjs",
        file: "../../src/x.journey.mjs",
        specs: [
          spec(
            "../../src/x.journey.mjs",
            "elsewhere",
            result("passed", 1000),
            result("passed", 1000),
          ),
        ],
      },
    ],
  });
  const vitest = (ms) => ({
    testResults: [
      {
        name: "/home/runner/work/buzz-app/buzz-app/src/app/A.test.tsx",
        status: "passed",
        startTime: 100,
        endTime: 100 + ms,
      },
      {
        name: "/home/runner/work/buzz-app/buzz-app/src/app/B.test.tsx",
        status: ms === 3000 ? "passed" : "failed",
        startTime: 0,
        endTime: 9000,
      },
    ],
  });
  const table = costTable({
    playwright: [1, 2, 3].map(playwright),
    vitest: [1000, 3000, 2500].map(vitest),
  });
  assert.deepEqual(table, {
    browser: {
      "tests/browser/a.spec.mjs": {
        "group › inner": [4, 30],
        top: [2, 4],
      },
    },
    vitest: { "src/app/A.test.tsx": 2.5, "src/app/B.test.tsx": 9 },
  });
  // New and renamed tests take their file's median, then the median of every
  // timed test.
  const costs = costModel({
    browser: {
      "tests/browser/a.spec.mjs": { one: [1, 10], two: [3, null] },
      "tests/browser/b.spec.mjs": { three: [5, 30], four: [7, 40] },
    },
    vitest: { "src/A.test.tsx": 1, "src/B.test.tsx": 2, "src/C.test.tsx": 6 },
  });
  const a = "tests/browser/a.spec.mjs";
  assert.equal(costs.journey("webkit", a, "one"), 10);
  assert.equal(costs.journey("chromium", a, "renamed"), 2);
  assert.equal(costs.journey("webkit", a, "two"), 10);
  assert.equal(costs.journey("webkit", "tests/browser/new.spec.mjs", "x"), 30);
  assert.equal(costs.vitest("src/B.test.tsx"), 2);
  assert.equal(costs.vitest("src/New.test.tsx"), 2);
});

test("listed journeys carry the titles the cost table keys them by", () => {
  const file = "tests/browser/buzz-links.spec.mjs";
  const titles = listBrowser([file])
    .get(file)
    .map(({ title }) => title);
  assert.ok(
    titles.some((title) => title.includes(" › ")),
    "describe groups lead the title",
  );
  assert.equal(new Set(titles).size, titles.length);
});

test("predicted browser lane time is the slowest engine's slowest shard, with job overhead", () => {
  const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
  assert.equal(browserLaneSeconds([0, 0], 0), 0);
  // One shard: 105 s, then ten repetitions of 20 s on two workers at 1.11×.
  close(browserLaneSeconds([10, 20], 5), 105 + 1.11 * 100);
  // A sixth journey adds a shard; the slowest runs 1.22× their mean.
  close(browserLaneSeconds([10, 20], 6), 105 + 1.11 * 1.22 * 50);
  // Shards stop at sixteen, so each takes more of a larger selection.
  close(browserLaneSeconds([0, 160], 160), 105 + 1.11 * 1.22 * 50);
});

test("predicted Vitest lane time follows the summed files on two workers or the slowest file", () => {
  const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
  assert.equal(vitestLaneSeconds([]), 0);
  close(vitestLaneSeconds([10, 10, 10, 10]), 26 + 5 * (5.7 + 0.72 * 20));
  close(vitestLaneSeconds([143, 1]), 26 + 5 * (5.7 + 0.72 * 143));
  // One 143 s file, as MessageComposer.test.tsx takes on CI, cannot join as a
  // related pick within the default budget.
  assert.ok(vitestLaneSeconds([143]) > LANE_BUDGET_MINUTES * 60);
});
