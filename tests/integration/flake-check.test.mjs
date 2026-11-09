import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  addRelated,
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
  RELATED_VITEST_FILES,
  reachesTests,
  repeatableLines,
  routes,
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

test("source, helper, fixture and patch changes can reach tests; configuration and docs cannot", () => {
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
    // Vitest's default forceRerunTriggers would relate every Vitest file.
    "src/bundled/pi/deps/package.json",
    "tests/fixtures/conversation-consumer/package.json",
    "tests/fixtures/app/vite.config.mjs",
    "scripts/tool/vitest.config.ts",
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
  const route = (test, changed) =>
    routes(graph, [reactions, overlays], changed).get(test);
  for (const changed of [
    "src/bundled/emoji/CustomEmoji.tsx",
    // emoji.tsx imports globals.css, which @imports the tokens.
    "src/shared/design-system/styles/tokens.css",
    "npm:@base-ui/react",
  ]) {
    assert.equal(
      route(reactions, [changed])?.via,
      "tests/fixtures/emoji.html",
      changed,
    );
    assert.deepEqual(route(reactions, [changed]).files, [changed]);
  }
  // A helper reaches the specs importing it through their own graph.
  assert.equal(route(overlays, ["tests/browser/timeline.mjs"])?.via, overlays);
  assert.equal(route(reactions, ["docs/buzz-help.md"]), undefined);
});

test("a route is as specific as the most widely shared module on it, then the changed file's reach, then its graph's size", () => {
  // hub.mjs stands in for fixture.mjs: three of four specs import it. a also
  // reaches it through a helper of its own.
  const graph = {
    edges: new Map([
      ["a", new Set(["own.mjs"])],
      ["own.mjs", new Set(["hub.mjs"])],
      ["b", new Set(["hub.mjs", "common"])],
      ["c", new Set(["hub.mjs", "page.html"])],
      ["d", new Set(["rare", "page.html", "common"])],
      ["hub.mjs", new Set(["x"])],
      ["page", new Set(["m1", "m2", "m3", "x"])],
    ]),
    pages: new Map([["page.html", "page"]]),
  };
  const tests = ["a", "b", "c", "d"];
  const found = routes(graph, tests, ["x"]);
  // A helper only a imports does not narrow a route that continues through
  // hub.mjs.
  assert.deepEqual(found.get("a"), {
    files: ["x"],
    via: "a",
    spread: 3,
    reach: 4,
    size: 4,
  });
  assert.equal(found.get("b").spread, 3);
  // Two specs open page.html, so its route is more specific than hub.mjs,
  // though its graph is larger.
  assert.deepEqual(found.get("c"), {
    files: ["x"],
    via: "page.html",
    spread: 2,
    reach: 4,
    size: 6,
  });
  // A direct import passes through nothing.
  assert.deepEqual(routes(graph, tests, ["x", "rare"]).get("d"), {
    files: ["rare"],
    via: "d",
    spread: 0,
    reach: 1,
    size: 4,
  });
  // Among equal spreads, the changed file fewer tests reach wins.
  assert.deepEqual(routes(graph, tests, ["common", "rare"]).get("d"), {
    files: ["common", "rare"],
    via: "d",
    spread: 0,
    reach: 1,
    size: 4,
  });
  // With equal spread and reach, the smaller graph wins.
  const sized = {
    edges: new Map([
      ["s", new Set(["small.html", "large.html"])],
      ["small", new Set(["y"])],
      ["large", new Set(["y", "z"])],
    ]),
    pages: new Map([
      ["small.html", "small"],
      ["large.html", "large"],
    ]),
  };
  assert.deepEqual(routes(sized, ["s"], ["y"]).get("s"), {
    files: ["y"],
    via: "small.html",
    spread: 1,
    reach: 1,
    size: 3,
  });
  assert.equal(routes(graph, tests, ["nowhere"]).size, 0);
});

test("related journeys: a module most specs reach through fixture.mjs does not crowd out specific routes", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const specs = spawnSync("git", ["ls-files", "tests/browser"], {
    cwd: root,
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter((file) => classify(file) === "browser");
  const graph = await moduleGraph(specs);
  // Rank order alone, one cost unit per spec: what runs ahead of a spec
  // decides whether the journey cap reaches it.
  const rank = (changed) =>
    takeRelated(
      [...routes(graph, specs, changed)].map(([file, route]) => ({
        file,
        route,
        namesake: namesake(file, changed),
        cost: 1,
      })),
      Infinity,
    ).taken;
  const typing = "src/features/relay/typing-protocol.ts";
  const emoji = "src/bundled/emoji/CustomEmoji.tsx";
  // typing.spec.mjs is named after the module's leading word.
  assert.equal(rank([typing])[0].file, "tests/browser/typing.spec.mjs");
  // Added to a CustomEmoji.tsx change, the module puts only typing.spec.mjs
  // ahead of the last spec routed through the emoji page, so the cap keeps
  // the emoji-page specs it kept for CustomEmoji.tsx alone.
  const throughEmojiPage = (ranked) => {
    const last = ranked.findLastIndex(
      ({ route }) => route.via === "tests/fixtures/emoji.html",
    );
    return ranked.slice(0, last + 1).map(({ file }) => file);
  };
  const before = throughEmojiPage(rank([emoji]));
  assert.ok(before.includes("tests/browser/message-overlays.spec.mjs"));
  assert.ok(before.includes("tests/browser/reactions-polish.spec.mjs"));
  assert.deepEqual(
    throughEmojiPage(rank([typing, emoji])).sort(),
    [...before, "tests/browser/typing.spec.mjs"].sort(),
  );
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
  // Either way round: a test named after the module's leading words.
  const typing = "src/features/relay/typing-protocol.ts";
  assert.equal(namesake("tests/browser/typing.spec.mjs", [typing]), typing);
  assert.equal(
    namesake("tests/browser/typing-dm.spec.mjs", [typing]),
    undefined,
  );
  // A Vitest file sits beside the module it is named after; other features'
  // files of the same name are not named after it.
  const service = "src/features/identity/service.ts";
  assert.equal(
    namesake("src/features/identity/service.test.ts", [service]),
    service,
  );
  assert.equal(
    namesake("src/features/agents/service.test.ts", [service]),
    undefined,
  );
});

test("related files run whole, named after a changed module first, then by route, until the cap; the one crossing it still runs", () => {
  const candidate = (file, [spread, reach, size], cost) => ({
    file,
    route: { files: ["x"], spread, reach, size },
    cost,
  });
  const candidates = [
    // A route more tests share ranks after every narrower one, whatever
    // its size.
    candidate("wide", [5, 30, 100], 1),
    // An equally narrow route to a changed file more tests reach.
    candidate("broad-file", [2, 195, 100], 1),
    candidate("mid-cheap", [2, 30, 500], 3),
    candidate("mid", [2, 30, 500], 10),
    candidate("narrow", [2, 30, 100], 2),
    // Vitest relates it, but the static graph found no route.
    { file: "unrouted", cost: 1 },
    // Named after a changed module: a naming heuristic ranks it ahead of
    // every route.
    { ...candidate("named", [9, 30, 700], 2), namesake: "src/Named.tsx" },
  ];
  const order = ({ taken, overBudget, overCap }) => [
    taken.map(({ file }) => file),
    overBudget.map(({ file }) => file),
    overCap.map(({ file }) => file),
  ];
  const ranked = [
    "named",
    "narrow",
    "mid-cheap",
    "mid",
    "broad-file",
    "wide",
    "unrouted",
  ];
  assert.deepEqual(order(takeRelated(candidates, Infinity)), [ranked, [], []]);
  // "mid-cheap" crosses the cap of 6 and runs; nothing after it does, even
  // when it would fit.
  assert.deepEqual(order(takeRelated(candidates, 6)), [
    ranked.slice(0, 3),
    [],
    ranked.slice(3),
  ]);
  assert.deepEqual(order(takeRelated(candidates, 0)), [[], [], ranked]);
});

test("related files run in rank order while their lane fits the budget, skipping a misfit only where the lane only grows; edited tests alone never trim", () => {
  const candidate = (file, size, seconds) => ({
    file,
    route: { files: ["x"], spread: 0, reach: 1, size },
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
  // A lane that only grows can never fit "heavy" after "first", so it is
  // skipped: "light" displaces nothing ranked ahead of it, and only taken
  // files count toward the cap.
  const grows = (budget, edited, cap = 3) =>
    order(takeRelated(candidates, cap, budget, lane(edited), true));
  assert.deepEqual(grows(540, 400), [
    ["first", "light", "last"],
    ["heavy"],
    [],
  ]);
  assert.deepEqual(grows(540, 400, 2), [
    ["first", "light"],
    ["heavy"],
    ["last"],
  ]);
  assert.deepEqual(grows(550, 400, 2), [
    ["first", "heavy"],
    [],
    ["light", "last"],
  ]);
  // Edited tests over the budget leave nothing to fit, so the cap never
  // ends the walk.
  assert.deepEqual(grows(540, 600), [
    [],
    ["first", "heavy", "light", "last"],
    [],
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
  // Every file pays 2.5 s of setup on top of its tests.
  close(vitestLaneSeconds([10, 10, 10, 10]), 26 + 5 * (2.6 + 0.74 * 25));
  close(vitestLaneSeconds(Array(20).fill(0)), 26 + 5 * (2.6 + 0.74 * 25));
  close(vitestLaneSeconds([143, 1]), 26 + 5 * (2.6 + 0.74 * 145.5));
  // One 143 s file, as MessageComposer.test.tsx takes on CI, cannot join as a
  // related pick within the default budget.
  assert.ok(vitestLaneSeconds([143]) > LANE_BUDGET_MINUTES * 60);
});

// Tier 1 and tier 2 overlap in a file tier 1 filtered by line and that its
// other changes also reach.
test("related files merge into the edited selection: a line filter becomes the whole file, and journeys tier 1 ran cost the cap nothing", () => {
  const spec = (name) => `tests/browser/${name}.spec.mjs`;
  const journey = (line, title, tags = []) => ({ line, title, tags });
  const specs = new Map([
    [
      spec("a"),
      [
        journey(10, "one"),
        journey(20, "two"),
        // Two parameterized journeys share line 30.
        journey(30, "case 1"),
        journey(30, "case 2"),
        journey(40, "mac only", ["local-webkit"]),
      ],
    ],
    [spec("b"), [journey(5, "b")]],
    [spec("c"), [journey(1, "c")]],
  ]);
  const costs = costModel({
    browser: {
      [spec("a")]: {
        one: [1, 2],
        two: [3, 4],
        "case 1": [5, 6],
        "case 2": [7, 8],
      },
      [spec("b")]: { b: [10, 20] },
      [spec("c")]: { c: [1, 1] },
    },
    vitest: { "src/A.test.ts": 100, "src/B.test.ts": 4, "src/C.test.ts": 8 },
  });
  const route = (spread) => ({
    files: ["x"],
    via: "x",
    spread,
    reach: 1,
    size: 1,
  });
  const selected = {
    vitest: new Map([
      // One of a hundred tests is charged a hundredth of the file.
      [
        "src/A.test.ts",
        { tier: "1", whole: false, share: 0.01, entries: ["src/A.test.ts:12"] },
      ],
      [
        "src/B.test.ts",
        { tier: "1", whole: true, share: 1, entries: ["src/B.test.ts"] },
      ],
    ]),
    browser: new Map([
      // Tier 1 runs both journeys on line 30.
      [spec("a"), { tier: "1", lines: [30], entries: [`${spec("a")}:30`] }],
      [spec("c"), { tier: "1", lines: [1], entries: [`${spec("c")}:1`] }],
    ]),
  };
  const before = structuredClone(selected);
  const related = {
    vitest: ["src/A.test.ts", "src/B.test.ts", "src/C.test.ts"].map(
      (file, i) => ({ file, route: route(i) }),
    ),
    browser: ["a", "b", "c"].map((name, i) => ({
      file: spec(name),
      route: route(i),
    })),
  };
  const result = addRelated(selected, related, {
    specs,
    costs,
    budget: Infinity,
  });
  assert.deepEqual(selected, before, "tier 1's selections are not mutated");
  const files = (candidates) => candidates.map(({ file }) => file);
  // B already runs whole; A's filter widens to the whole file.
  assert.deepEqual(files(result.take.vitest.taken), [
    "src/A.test.ts",
    "src/C.test.ts",
  ]);
  const vitest = result.selected.vitest;
  assert.deepEqual(
    [...vitest].map(([file, { tier, whole, share, entries }]) => [
      file,
      tier,
      whole,
      share,
      entries,
    ]),
    [
      ["src/A.test.ts", "1, 2", true, 1, ["src/A.test.ts"]],
      ["src/B.test.ts", "1", true, 1, ["src/B.test.ts"]],
      ["src/C.test.ts", "2", true, 1, ["src/C.test.ts"]],
    ],
  );
  // The widened file is charged whole, in place of its filter.
  assert.deepEqual(result.lanes.vitest, [
    vitestLaneSeconds([100, 4, 8]),
    vitestLaneSeconds([1, 4]),
  ]);
  // Every journey of c already runs, so c is no candidate. a's cap cost is
  // its two fresh journeys; its output gains three entries, since the
  // filter on line 30 becomes one entry per journey there.
  const [a, b] = result.take.browser.taken;
  assert.deepEqual(files(result.take.browser.taken), [spec("a"), spec("b")]);
  assert.deepEqual(
    [a.cost, a.entries, a.seconds, b.cost, b.entries, b.seconds],
    [2, 3, [4, 6], 1, 1, [10, 20]],
  );
  const browser = result.selected.browser;
  assert.deepEqual(
    [...browser].map(([file, { tier, entries }]) => [file, tier, entries]),
    [
      [
        spec("a"),
        "1, 2",
        [10, 20, 30, 30].map((line) => `${spec("a")}:${line}`),
      ],
      [spec("c"), "1", [`${spec("c")}:1`]],
      [spec("b"), "2", [`${spec("b")}:5`]],
    ],
  );
  // The lane counts the output entries the shards split.
  const entries = [...browser.values()].flatMap(({ entries }) => entries);
  assert.deepEqual(result.lanes.browser, [
    browserLaneSeconds(
      [1 + 3 + 5 + 7 + 10 + 1, 2 + 4 + 6 + 8 + 20 + 1],
      entries.length,
    ),
    browserLaneSeconds([5 + 7 + 1, 6 + 8 + 1], 2),
  ]);
});

test("a related file joins only while the edited tests' lane time plus its own fits the budget", () => {
  const costs = costModel({
    browser: {},
    vitest: { "src/B.test.ts": 20, "src/C.test.ts": 8 },
  });
  const selected = {
    vitest: new Map([
      [
        "src/B.test.ts",
        { tier: "1", whole: true, share: 1, entries: ["src/B.test.ts"] },
      ],
    ]),
    browser: new Map(),
  };
  const related = {
    vitest: [
      {
        file: "src/C.test.ts",
        route: { files: ["x"], spread: 0, reach: 1, size: 1 },
      },
    ],
    browser: [],
  };
  const take = (budget) =>
    addRelated(selected, related, { specs: new Map(), costs, budget }).take
      .vitest;
  // C alone would fit; beside the edited B it does not.
  assert.equal(take(vitestLaneSeconds([8])).overBudget.length, 1);
  assert.equal(take(vitestLaneSeconds([20, 8])).taken.length, 1);
});

test("an edited file filtered by line that cannot run whole keeps its filter, is unwidened rather than dropped, and does not stop the related files after it", () => {
  const costs = costModel({
    browser: {},
    vitest: { "src/A.test.ts": 600, "src/C.test.ts": 8 },
  });
  // One of a hundred tests fits; the whole file cannot.
  const filtered = {
    tier: "1",
    whole: false,
    share: 0.01,
    entries: ["src/A.test.ts:12"],
    note: "1 changed test(s)",
  };
  const route = (spread) => ({
    files: ["x"],
    via: "x",
    spread,
    reach: 1,
    size: 1,
  });
  const add = (related, budget) =>
    addRelated(
      { vitest: new Map([["src/A.test.ts", filtered]]), browser: new Map() },
      { vitest: related, browser: [] },
      { specs: new Map(), costs, budget },
    );
  const result = add(
    [
      { file: "src/A.test.ts", route: route(0) },
      { file: "src/C.test.ts", route: route(1) },
    ],
    LANE_BUDGET_MINUTES * 60,
  );
  const files = (candidates) => candidates.map(({ file }) => file);
  assert.deepEqual(files(result.take.vitest.unwidened), ["src/A.test.ts"]);
  assert.deepEqual(result.take.vitest.overBudget, []);
  assert.deepEqual(files(result.take.vitest.taken), ["src/C.test.ts"]);
  assert.deepEqual(
    [...result.selected.vitest].map(([file, { tier, entries }]) => [
      file,
      tier,
      entries,
    ]),
    [
      ["src/A.test.ts", "1", ["src/A.test.ts:12"]],
      ["src/C.test.ts", "2", ["src/C.test.ts"]],
    ],
  );
  assert.equal(
    result.selected.vitest.get("src/A.test.ts").note,
    "1 changed test(s); also related, not run whole for time",
  );
  assert.deepEqual(result.lanes.vitest, [
    vitestLaneSeconds([6, 8]),
    vitestLaneSeconds([6]),
  ]);
  // Ranked after the cap fills, it is unwidened for the cap.
  const capped = add(
    [
      { file: "src/A.test.ts", route: route(1) },
      ...Array.from({ length: RELATED_VITEST_FILES }, (_, i) => ({
        file: `src/F${i}.test.ts`,
        route: route(0),
      })),
    ],
    Number.POSITIVE_INFINITY,
  );
  assert.equal(capped.take.vitest.taken.length, RELATED_VITEST_FILES);
  assert.deepEqual(files(capped.take.vitest.unwidened), ["src/A.test.ts"]);
  assert.deepEqual(capped.take.vitest.overCap, []);
  assert.equal(
    capped.selected.vitest.get("src/A.test.ts").note,
    "1 changed test(s); also related, not run whole for the cap",
  );
});

test("a related Vitest file too slow to fit beside the edited tests alone neither ends the picks after it nor takes a cap slot", () => {
  // MessageComposer.test.tsx takes about 141 s on CI, over the budget even
  // alone, and ranks first for a MessageComposer.tsx change as its namesake.
  const composer = "src/features/messages/MessageComposer.test.tsx";
  const fillers = Array.from(
    { length: RELATED_VITEST_FILES - 1 },
    (_, i) => `src/features/filler/F${String(i).padStart(2, "0")}.test.ts`,
  );
  const costs = costModel({
    browser: {},
    vitest: {
      [composer]: 141.3,
      "src/features/messages/ComposerAttachments.test.tsx": 10,
      "src/features/conversation/service.test.tsx": 8,
      ...Object.fromEntries(fillers.map((file) => [file, 1])),
    },
  });
  const candidate = (file, spread) => ({
    file,
    route: { files: ["x"], via: file, spread, reach: 1, size: 1 },
  });
  const related = (...more) => ({
    vitest: [
      {
        ...candidate(composer, 0),
        namesake: "src/features/messages/MessageComposer.tsx",
      },
      candidate("src/features/messages/ComposerAttachments.test.tsx", 0),
      candidate("src/features/conversation/service.test.tsx", 7),
      ...more,
    ],
    browser: [],
  });
  const take = (candidates) =>
    addRelated({ vitest: new Map(), browser: new Map() }, candidates, {
      specs: new Map(),
      costs,
      budget: LANE_BUDGET_MINUTES * 60,
    }).take.vitest;
  const files = (candidates) => candidates.map(({ file }) => file);
  assert.ok(vitestLaneSeconds([141.3]) > LANE_BUDGET_MINUTES * 60);
  const { taken, overBudget, overCap } = take(related());
  assert.deepEqual(files(taken), [
    "src/features/messages/ComposerAttachments.test.tsx",
    "src/features/conversation/service.test.tsx",
  ]);
  assert.deepEqual(files(overBudget), [composer]);
  assert.deepEqual(overCap, []);
  // The cap of 20 counts only files that can run: with 21 that can, 20 run.
  const capped = take(related(...fillers.map((file) => candidate(file, 9))));
  assert.equal(capped.taken.length, RELATED_VITEST_FILES);
  assert.deepEqual(files(capped.overBudget), [composer]);
  assert.deepEqual(files(capped.overCap), [fillers.at(-1)]);
});
