// Advisory pull-request flake check. `select` maps a diff to the Vitest tests
// and Playwright journeys it changed, plus the test files its other changes
// reach through imports while the lanes' predicted time allows; `vitest`
// repeats a selection and reports every iteration. Playwright repeats natively
// with --repeat-each. `costs` regenerates the test durations the prediction
// reads from green `main` runs.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
} from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { parseAst } from "rolldown/parseAst";
import { parseVitest } from "./ci-test-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pnpm = `${root}bin/pnpm`;
export const ITERATIONS = 10;
// Repetitions spread across shards, so a whole-file selection stays inside
// the flake lane's job timeout. Small selections keep a single runner.
const JOURNEYS_PER_SHARD = 5;
// Broad selector migrations can select 180+ journeys (1,800 repetitions).
// Eight lanes exceeded the unchanged 30-minute deadline in both engines.
const MAX_SHARDS = 16;
export const browserShards = (journeys) =>
  Math.min(MAX_SHARDS, Math.max(1, Math.ceil(journeys / JOURNEYS_PER_SHARD)));
// Journeys that need their own project or platform: the measurements job and
// the macOS recorder own them, so the engine lanes never repeat them.
const excludedTags = ["classic-scrollbars", "local-webkit", "media-recorder"];
// Test files a pull request reaches without editing run whole, most specific
// first, while each flake lane's predicted wall time stays inside the budget.
// Tests the pull request edited always run, even past it. The budget bounds
// wall time, and shards grow with the selection, so these caps still bound
// runner time: about eight shards of journeys, and few Vitest files.
export const LANE_BUDGET_MINUTES = 9;
export const RELATED_JOURNEYS = 40;
export const RELATED_VITEST_FILES = 20;

// Mirrors vitest.config.ts `include` and the Playwright testDir/testMatch.
// Paths are later split on whitespace in a shell, so admit only plain names.
export function classify(file) {
  if (!/^[\w./@-]+$/.test(file)) return undefined;
  if (
    /^(?:src\/.*\.test\.(?:ts|tsx|mjs)|browser-host\/.*\.test\.mjs|scripts\/.*\.test\.(?:ts|mjs)|tests\/fixtures\/design-system\/.*\.test\.(?:ts|tsx))$/.test(
      file,
    )
  )
    return "vitest";
  if (/^tests\/browser\/[^/]+\.spec\.mjs$/.test(file)) return "browser";
  return undefined;
}

// Line ranges of a -U0 diff: the new-side lines each hunk writes and the
// old-side lines it removes (empty, end < start, for a pure insertion). A pure
// deletion writes no lines and attaches to the line before it (0 at the top of
// the file); `removed` keeps what it took out, since that line cannot tell.
export function hunkRanges(diff) {
  return [
    ...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm),
  ].map(([, oldStart, oldCount = "1", start, count = "1"]) => ({
    start: Number(start),
    end: Number(start) + Math.max(Number(count), 1) - 1,
    removed: {
      start: Number(oldStart),
      end: Number(oldStart) + Number(oldCount) - 1,
    },
  }));
}

// Members that keep a `test`/`it` chain a test declaration. Anything else on
// the chain is a group (`describe`), a hook (`test.beforeEach`), configuration
// (`test.use`) or a harness object that happens to be named `test`.
const declaring = [
  "only",
  "skip",
  "fixme",
  "fails",
  "todo",
  "concurrent",
  "sequential",
  "each",
  "for",
  "runIf",
  "skipIf",
];

// Line spans of every test declaration, from its first line to its closing
// parenthesis. Tests registered through a wrapper have no enclosing call.
export function testCalls(source, lang) {
  const lineAt = (offset) => source.slice(0, offset).split("\n").length;
  const names = (callee) =>
    callee.type === "Identifier"
      ? [callee.name]
      : callee.type === "MemberExpression"
        ? names(callee.object)?.concat(callee.property.name ?? "")
        : callee.type === "CallExpression"
          ? names(callee.callee)
          : undefined;
  const calls = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const chain = node.type === "CallExpression" ? names(node.callee) : null;
    if (
      chain &&
      ["test", "it"].includes(chain[0]) &&
      chain.slice(1).every((member) => declaring.includes(member))
    ) {
      calls.push({ start: lineAt(node.start), end: lineAt(node.end - 1) });
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parseAst(source, { lang }));
  return calls;
}

// Bodies of the listed tests: their calls, keyed by the line the runner
// listed. Runners only report a call-site line, which may sit inside the call
// (`it.each([…])(` lists at the second parenthesis), so each listed line is
// owned by the enclosing test call; a listed line outside every call leaves
// its lines to the whole-file rule.
export function testBodies(source, lang, lines) {
  const calls = testCalls(source, lang);
  const bodies = new Map();
  for (const line of [...lines].sort((a, b) => a - b)) {
    const call = calls.find(({ start, end }) => start <= line && line <= end);
    if (call && !bodies.has(call)) bodies.set(call, { ...call, line });
  }
  return [...bodies.values()].sort((a, b) => a.start - b.start);
}

// Runtime collection and execution use the same Vitest call-site locations.
// Keep those locations: a parameterized call's AST start may not be runnable.
export const vitestFilters = (file, selection) =>
  selection.whole ? [file] : selection.lines.map((line) => `${file}:${line}`);

// The calls owning every line of a range, or undefined once a line lies
// outside them all.
function owners(calls, { start, end }) {
  const found = [];
  for (let line = start; line <= end; ) {
    const call = calls.find((c) => c.start <= line && line <= c.end);
    if (!call) return undefined;
    found.push(call);
    line = call.end + 1;
  }
  return found;
}

// A hunk whose every line lies in a test body selects those tests. A changed
// line outside every body (imports, helpers, hooks or constants before,
// between or after tests) can change every test, so it, a new file, or a file
// with no listed tests selects the whole file. Removed lines are judged by the
// old file's calls (`previous`): a deletion attaches to its preceding line,
// which belongs to the test before a removed hook, not to the hook.
export function selectTests(
  ranges,
  bodies,
  { added = false, previous = [] } = {},
) {
  if (added) return { whole: true, reason: "new file" };
  if (bodies.length === 0) return { whole: true, reason: "no tests listed" };
  const selected = new Set();
  for (const { start, end, removed } of ranges) {
    if (!owners(previous, removed))
      return { whole: true, reason: "shared code removed" };
    const current = owners(bodies, { start, end });
    if (!current) return { whole: true, reason: "shared code changed" };
    for (const body of current) selected.add(body.line);
  }
  return { lines: [...selected].sort((a, b) => a - b) };
}

export const repeatableLines = (specs) =>
  specs
    .filter((spec) => !spec.tags.some((tag) => excludedTags.includes(tag)))
    .map((spec) => spec.line);

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
};
const git = (...args) => {
  const result = run("git", args);
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout;
};
const summarize = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
};
const cell = (value) => String(value).replaceAll("|", "\\|");

// Test start lines per file. Vitest filters are substrings, so an argument may
// list neighbouring files too; those drop out of the map.
export function listVitest(files) {
  const result = run(pnpm, [
    "--silent",
    "exec",
    "vitest",
    "list",
    "--json",
    "--includeTaskLocation",
    // Runtime collection and run filters must use the same call-site locations.
    // Static collection can map parameterized tests to a different source line.
    "--staticParse=false",
    ...files,
  ]);
  if (result.status !== 0) throw new Error(`vitest list: ${result.stderr}`);
  const starts = new Map(files.map((file) => [file, []]));
  for (const { file, location } of JSON.parse(result.stdout))
    starts.get(relative(root, file))?.push(location.line);
  return starts;
}

// Every spec of a Playwright JSON report, titled by its describe groups and
// its own title. The top-level suites are files; Playwright requires titles to
// be unique within one.
function* reportSpecs(suites, groups) {
  for (const suite of suites) {
    const path = groups ? [...groups, suite.title] : [];
    for (const spec of suite.specs ?? [])
      yield { spec, title: [...path, spec.title].join(" › ") };
    yield* reportSpecs(suite.suites ?? [], path);
  }
}

// Specs per file as the CI engine project lists them. The engine projects
// ignore measurement files, and Playwright reports a run selecting nothing as
// an error, so a selection of only measurement files lists no specs.
export function listBrowser(files) {
  const result = run(pnpm, [
    "--silent",
    "test:browser:ci",
    "--project",
    "chromium",
    "--no-deps",
    "--list",
    "--reporter=json",
    ...files,
  ]);
  const report = JSON.parse(result.stdout);
  const empty =
    report.errors.length === 1 &&
    /No tests found/.test(report.errors[0].message);
  if (result.status !== 0 && !empty)
    throw new Error(
      `playwright --list: ${report.errors.map((error) => error.message).join("\n")}`,
    );
  const specs = new Map(files.map((file) => [file, []]));
  for (const { spec, title } of reportSpecs(empty ? [] : report.suites))
    if (spec.tests?.length)
      specs
        .get(`tests/browser/${spec.file}`)
        ?.push({ line: spec.line, tags: spec.tags, title });
  return specs;
}

const ENGINES = ["chromium", "webkit"];
const costsFile = `${root}scripts/flake-check-costs.json`;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return undefined;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

// The cost table `costs` writes: the median passing seconds of each journey,
// as [Chromium, WebKit] by spec file and title, and of each Vitest file, over
// the required lanes of green `main` runs. Vitest reports absolute paths under
// the CI checkout.
export function costTable({ playwright = [], vitest = [] }) {
  const samples = { browser: {}, vitest: {} };
  for (const report of playwright)
    for (const { spec, title } of reportSpecs(report.suites))
      for (const { projectName, results } of spec.tests ?? []) {
        const engine = ENGINES.indexOf(projectName);
        const passed = results.find(({ status }) => status === "passed");
        const file = `tests/browser/${spec.file}`;
        if (engine < 0 || !passed || classify(file) !== "browser") continue;
        samples.browser[file] ??= {};
        samples.browser[file][title] ??= ENGINES.map(() => []);
        samples.browser[file][title][engine].push(passed.duration / 1000);
      }
  for (const report of vitest)
    for (const { name, status, startTime, endTime } of report.testResults) {
      const parts = name.split("/");
      const file = parts
        .map((_, i) => parts.slice(i).join("/"))
        .find((path) => classify(path) === "vitest");
      if (!file || status !== "passed") continue;
      samples.vitest[file] ??= [];
      samples.vitest[file].push((endTime - startTime) / 1000);
    }
  const seconds = (values) =>
    values.length ? Math.round(median(values) * 10) / 10 : null;
  const sorted = (entries, value) =>
    Object.fromEntries(
      Object.keys(entries)
        .sort()
        .map((key) => [key, value(entries[key])]),
    );
  return {
    browser: sorted(samples.browser, (titles) =>
      sorted(titles, (engines) => engines.map(seconds)),
    ),
    vitest: sorted(samples.vitest, seconds),
  };
}

// Seconds a test takes on CI: its own entry in the cost table, else the
// median of its file's journeys on that engine, else the median of every
// journey on that engine or of every Vitest file. New tests and renamed
// journeys take the fallbacks.
export function costModel(table) {
  const medians = new Map();
  const middle = (key, values) => {
    if (!medians.has(key))
      medians.set(key, median(values().filter(Number.isFinite)));
    return medians.get(key);
  };
  return {
    journey: (engine, file, title) => {
      const index = ENGINES.indexOf(engine);
      const timed = (titles = {}) =>
        Object.values(titles).map((engines) => engines[index]);
      return (
        table.browser[file]?.[title]?.[index] ??
        middle(`${engine} ${file}`, () => timed(table.browser[file])) ??
        middle(engine, () => Object.values(table.browser).flatMap(timed))
      );
    },
    vitest: (file) =>
      table.vitest[file] ?? middle("vitest", () => Object.values(table.vitest)),
  };
}

// Predicted browser-lane wall time in seconds, fit to hosted pull-request
// runs of Nov 4–5, 2026 (median predicted ÷ actual 0.95 for the slowest
// shard). ci.yml repeats each journey ITERATIONS
// times per engine, over that engine's own shards; `seconds` holds one
// repetition per engine, as [Chromium, WebKit]. A shard job spends 105 s outside its tests, and its
// two workers take 1.11 × half its summed test time. Playwright splits
// repetitions by count, so the slowest of several shards runs about 1.22 ×
// their mean.
export function browserLaneSeconds(seconds, journeys) {
  if (journeys === 0) return 0;
  const shards = browserShards(journeys);
  const slowest = shards > 1 ? 1.22 : 1;
  return Math.max(
    ...seconds.map(
      (total) => 105 + (1.11 / 2) * slowest * ((total * ITERATIONS) / shards),
    ),
  );
}

// Two Vitest batch jobs each run ITERATIONS / 2 iterations of the selection.
// A job spends 26 s outside them. `files` holds the seconds of each file's
// selected tests, and every file also pays 2.5 s of import and environment
// setup that the cost table's test spans leave out. An iteration takes
// 2.6 s plus 0.74 × the larger of half the files' summed time (two workers)
// and the slowest file. Fit to 163 hosted flake Vitest jobs of Nov 4–5, 2026
// (median predicted ÷ actual 1.05; 1.03 for the 28 jobs of nine or more files,
// which a fit without setup put at 0.86).
export function vitestLaneSeconds(files) {
  if (files.length === 0) return 0;
  const charged = files.map((seconds) => seconds + 2.5);
  const total = charged.reduce((sum, seconds) => sum + seconds, 0);
  return 26 + (ITERATIONS / 2) * (2.6 + 0.74 * Math.max(total / 2, ...charged));
}

// Rewrites the cost table from green `main` CI runs, by default the latest
// three. Artifacts expire after seven days.
function writeCosts(runs) {
  const ids = runs.length
    ? runs
    : JSON.parse(
        run("gh", [
          "run",
          "list",
          "--workflow=ci.yml",
          "--branch=main",
          "--event=push",
          "--status=success",
          "--limit=3",
          "--json=databaseId",
        ]).stdout,
      ).map(({ databaseId }) => String(databaseId));
  const dir = mkdtempSync(join(tmpdir(), "flake-check-costs-"));
  const reports = { playwright: [], vitest: [] };
  try {
    for (const id of ids) {
      const result = run("gh", [
        "run",
        "download",
        id,
        `--dir=${dir}/${id}`,
        "--pattern=browser-journeys-*",
        "--pattern=vitest-timing-*",
      ]);
      if (result.status !== 0)
        throw new Error(`gh run download ${id}: ${result.stderr}`);
      for (const artifact of readdirSync(`${dir}/${id}`)) {
        const [kind, report] = artifact.startsWith("browser-journeys-")
          ? ["playwright", "ci-report.json"]
          : ["vitest", "vitest.json"];
        reports[kind].push(
          JSON.parse(
            readFileSync(`${dir}/${id}/${artifact}/${report}`, "utf8"),
          ),
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const table = { runs: ids, ...costTable(reports) };
  writeFileSync(costsFile, JSON.stringify(table));
  const format = run(pnpm, [
    "--silent",
    "exec",
    "biome",
    "format",
    "--write",
    costsFile,
  ]);
  if (format.status !== 0) throw new Error(`biome format: ${format.stderr}`);
  const journeys = Object.values(table.browser).flatMap(Object.keys).length;
  console.log(
    `flake-check: timed ${journeys} journeys and ${Object.keys(table.vitest).length} Vitest files from runs ${ids.join(", ")}`,
  );
}

// Changed files that can reach a test through imports. Configuration would
// relate every Vitest file and no fixture page loads it; the regular lanes
// cover it. Vitest's default forceRerunTriggers (`**/package.json`,
// `**/{vitest,vite}.config.*`) make `related` return every file, so nested
// package manifests and configs count as configuration too.
export const reachesTests = (file) =>
  /^(?:src|browser-host|scripts|tests|patches)\//.test(file) &&
  !/\/(?:package\.json|vite(?:st)?\.config\.[^/]*)$/.test(file) &&
  !classify(file);

// The package a pnpm patch changes, from its `@scope__name@1.0.0.patch` name.
export const patchedPackage = (file) =>
  /^patches\/(.+)@[^@/]+\.patch$/.exec(file)?.[1].replace("__", "/");

const packageName = (specifier) => {
  const parts = specifier.split("?")[0].split("/");
  return parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/");
};

// Journeys open fixture pages by URL.
const pageUrl = /tests\/fixtures\/[\w-]+\.html/g;

// The import graph of the entry modules and every fixture page, by repository
// path; rolldown builds it and writes nothing. Packages stay external as
// `npm:<name>` nodes, so a patch reaches their importers. Other non-JavaScript
// imports are leaves, except that a stylesheet's @imports are its edges. A
// browser module links to each fixture page it names, and `pages` maps a page
// to its module script.
export async function moduleGraph(entries) {
  const edges = new Map();
  const link = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };
  const file = (id) => relative(root, id.split("?")[0]);
  const pages = new Map();
  for (const page of git("ls-files", "-z", "tests/fixtures/*.html").split("\0"))
    if (page) {
      const src = /<script[^>]*\ssrc="([^"]+)"/.exec(
        readFileSync(`${root}${page}`, "utf8"),
      )?.[1];
      if (src)
        pages.set(
          page,
          src.startsWith("/") ? src.slice(1) : join(dirname(page), src),
        );
    }
  const bundle = await rolldown({
    input: [...new Set([...entries, ...pages.values()])].map(
      (entry) => `${root}${entry}`,
    ),
    cwd: root,
    logLevel: "silent",
    // Stubbed imports export nothing; the graph needs every module.
    shimMissingExports: true,
    treeshake: false,
    plugins: [
      {
        name: "flake-check-graph",
        async resolveId(source, importer) {
          if (!importer) return null;
          if (!/^[./]/.test(source)) {
            link(file(importer), `npm:${packageName(source)}`);
            return { id: source, external: true };
          }
          // Vite serves `/path` from the repository root.
          const [path, query] = source.split("?");
          const resolved = await this.resolve(
            path.startsWith("/") ? join(root, path) : path,
            importer,
            { skipSelf: true },
          );
          if (!resolved) return { id: source, external: true };
          return query === undefined
            ? resolved
            : { id: `${resolved.id}?${query}` };
        },
        load(id) {
          const [path, query] = id.split("?");
          if (query === undefined && /\.(?:[cm]?[jt]sx?|json)$/.test(path))
            return null;
          const imports =
            query === undefined && path.endsWith(".css")
              ? readFileSync(path, "utf8").matchAll(
                  /@import\s+(?:url\()?["']([^"']+)["']/g,
                )
              : [];
          return {
            code: [...imports]
              .map(([, source]) => `import ${JSON.stringify(source)};`)
              .join("\n"),
            moduleType: "js",
          };
        },
        transform(code, id) {
          if (file(id).startsWith("tests/browser/"))
            for (const [page] of code.matchAll(pageUrl))
              if (pages.has(page)) link(file(id), page);
          return null;
        },
        moduleParsed({ id, importedIds, dynamicallyImportedIds }) {
          for (const imported of [...importedIds, ...dynamicallyImportedIds])
            if (isAbsolute(imported)) link(file(id), file(imported));
        },
      },
    ],
  });
  try {
    await bundle.generate();
  } finally {
    await bundle.close();
  }
  return { edges, pages };
}

// Nodes reachable from `start` through `next`.
function reach(next, start) {
  const seen = new Set([start]);
  for (const node of seen) for (const to of next(node)) seen.add(to);
  return seen;
}

// From each seed, the narrowest way to every node it reaches: the most
// tests sharing any one module on the path, the seed included. A seed's
// value is the narrowest way to it.
function widths(next, popularity, seeds) {
  const width = new Map(seeds);
  const work = [...width.keys()];
  while (work.length > 0) {
    const node = work.pop();
    const through = Math.max(width.get(node), popularity.get(node));
    for (const to of next(node))
      if (!(width.get(to) <= through)) {
        width.set(to, through);
        work.push(to);
      }
  }
  return width;
}

// Each test's most specific route to the change, for the tests that have one.
// A route runs through the test's own imports, or through a fixture page it
// opens and that page's script. Its spread counts the tests that reach the
// most widely shared module between the test and the changed file. If A
// imports B, every test that reaches A also reaches B, so that module is
// always the changed file's importer on the route (for a page's script, the
// page): spread is 0 for a direct import and otherwise the popularity of the
// least shared importer of the changed file that the test reaches. A helper
// most journeys import (fixture.mjs) or a page many open says little about
// any one test: specs that only reach src/features/relay/typing-protocol.ts
// through fixture.mjs are 154 of 234. A feature's index module counts every
// test that uses the feature, so a page that imports a module through it has
// a wider route than a page that imports the module directly: emoji.html,
// which 7 specs open, reaches src/bundled/emoji/CustomEmoji.tsx through
// src/bundled/emoji/index.tsx, which 24 specs reach. Routes rank by spread,
// then by how many tests reach the changed file (never fewer than the
// spread), then by the files in the route's graph (the change is a larger
// part of a smaller one), which is why each route keeps its own graph. Every
// route to one changed file shares its reach, so reach only orders tests
// that reach different changed files.
export function routes({ edges, pages }, tests, changed) {
  const imports = (node) => edges.get(node) ?? [];
  const opens = (node) => (pages.has(node) ? [pages.get(node)] : imports(node));
  const popularity = new Map();
  for (const test of tests)
    for (const node of reach(opens, test))
      popularity.set(node, (popularity.get(node) ?? 0) + 1);
  const pageWidths = new Map();
  const found = new Map();
  for (const test of tests) {
    const own = widths(
      imports,
      popularity,
      [...imports(test)].map((node) => [node, 0]),
    );
    const options = [{ via: test, width: own, before: 0 }];
    for (const [page, before] of own)
      if (pages.has(page)) {
        if (!pageWidths.has(page))
          pageWidths.set(
            page,
            widths(imports, popularity, [
              [pages.get(page), popularity.get(page)],
            ]),
          );
        options.push({ via: page, width: pageWidths.get(page), before });
      }
    let best;
    for (const { via, width, before } of options) {
      const files = changed.filter((node) => width.has(node));
      if (files.length === 0) continue;
      // The test itself, or the page, completes the graph.
      const size = width.size + 1;
      for (const file of files) {
        const route = {
          files,
          via,
          spread: Math.max(before, width.get(file)),
          reach: popularity.get(file),
          size,
        };
        if (
          !best ||
          (routeOrder(route, best) || route.via.localeCompare(best.via)) < 0
        )
          best = route;
      }
    }
    if (best) found.set(test, best);
  }
  return found;
}

const routeOrder = (a, b) =>
  a.spread - b.spread || a.reach - b.reach || a.size - b.size;

// The name a test shares with the module it is named after: the basename
// before its first dot, PascalCase split into kebab-case.
export const moduleName = (file) =>
  basename(file)
    .split(".")[0]
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();

// The changed module a test is named after: either name is the other or its
// leading words (`CustomEmoji` names `custom-emoji-authoring`, and `typing`
// names `typing-protocol`). Vitest files sit beside their subject, so a
// Vitest file must also share its directory; journeys share one flat
// directory. A naming convention, not graph evidence: it only reorders tests
// the graph already reaches.
export const namesake = (test, changed) => {
  const name = moduleName(test);
  return changed.find((file) => {
    const named = moduleName(file);
    return (
      (classify(test) !== "vitest" || dirname(test) === dirname(file)) &&
      (name === named ||
        name.startsWith(`${named}-`) ||
        named.startsWith(`${name}-`))
    );
  });
};

// Takes whole candidates, named after a changed module first, then by route
// (a candidate without one last) and cheaper first among equal routes. The
// cost of each candidate taken counts toward the cap, and the one crossing it
// still runs. Picks must keep the lane `lane` predicts inside `budget`
// seconds, and a candidate never loses its place to one ranked after it:
// - A lane that only `grows` with each pick takes each candidate that fits
//   beside the ones before it. One that does not fit never will, so skipping
//   it displaces nothing ranked ahead, and it takes no cap slot.
// - Browser shards grow with the selection, so a longer run can predict a
//   shorter lane than a run it extends. There the longest run of candidates
//   in rank order that fits runs, and nothing ranked after a dropped
//   candidate runs in its place.
export function takeRelated(
  candidates,
  cap,
  budget = Number.POSITIVE_INFINITY,
  lane = () => 0,
  grows = false,
) {
  const named = ({ namesake }) => (namesake ? 0 : 1);
  const routed = (a, b) =>
    a.route && b.route ? routeOrder(a.route, b.route) : !a.route - !b.route;
  const ranked = [...candidates].sort(
    (a, b) =>
      named(a) - named(b) ||
      routed(a, b) ||
      a.cost - b.cost ||
      a.file.localeCompare(b.file),
  );
  if (grows) {
    const taken = [];
    const overBudget = [];
    let next = 0;
    for (let used = 0; next < ranked.length && used < cap; next += 1)
      if (lane([...taken, ranked[next]]) <= budget) {
        taken.push(ranked[next]);
        used += ranked[next].cost;
      } else overBudget.push(ranked[next]);
    return { taken, overBudget, overCap: ranked.slice(next) };
  }
  let used = 0;
  let capped = 0;
  while (capped < ranked.length && used < cap) used += ranked[capped++].cost;
  let end = 0;
  for (let length = 1; length <= capped; length += 1)
    if (lane(ranked.slice(0, length)) <= budget) end = length;
  return {
    taken: ranked.slice(0, end),
    overBudget: ranked.slice(end, capped),
    overCap: ranked.slice(capped),
  };
}

// Why a related file runs, for the step summary.
const reason = ({ file, route, namesake }) =>
  (namesake
    ? `named after ${namesake}, a naming heuristic rather than graph evidence; `
    : "") +
  (route
    ? `${route.files.join(", ")} via ${route.via === file ? "imports" : route.via}, spread ${route.spread}, ${route.size} files`
    : "Vitest module graph");

// Tier 2: adds whole related files to tier 1's selections in takeRelated's
// order while each lane's predicted wall time stays inside `budget` seconds.
// `selected` holds tier 1's selections by runner and file: a Vitest file's
// `share` of its listed tests and a spec's journey `lines`. `specs` lists
// each spec's journeys; `costs` is a costModel. Returns the merged
// selections, what each runner took and dropped (and the related Vitest files
// tier 1 filtered by line that it left unwidened), and each lane's predicted
// seconds as [with tier 2, tier 1 alone].
export function addRelated(selected, related, { specs, costs, budget }) {
  const journeySeconds = (file, lines) =>
    ENGINES.map((engine) =>
      (specs.get(file) ?? [])
        .filter(({ line }) => lines.includes(line))
        .reduce(
          (sum, { title }) => sum + costs.journey(engine, file, title),
          0,
        ),
    );
  const edited = {
    browser: [...selected.browser].map(([file, { lines }]) => ({
      seconds: journeySeconds(file, lines),
      entries: lines.length,
    })),
    vitest: [...selected.vitest].map(([file, { share }]) => [
      file,
      share * costs.vitest(file),
    ]),
  };
  const lane = {
    browser: (taken) => {
      const parts = [...edited.browser, ...taken];
      return browserLaneSeconds(
        ENGINES.map((_, i) =>
          parts.reduce((sum, { seconds }) => sum + seconds[i], 0),
        ),
        parts.reduce((sum, { entries }) => sum + entries, 0),
      );
    },
    // A related file tier 1 filtered by line replaces that filter.
    vitest: (taken) =>
      vitestLaneSeconds([
        ...new Map([
          ...edited.vitest,
          ...taken.map(({ file, seconds }) => [file, seconds]),
        ]).values(),
      ]),
  };
  const take = {
    // Widening a line filter or adding a file only grows the Vitest lane.
    vitest: takeRelated(
      related.vitest
        .filter(({ file }) => !selected.vitest.get(file)?.whole)
        .map((candidate) => ({
          ...candidate,
          cost: 1,
          seconds: costs.vitest(candidate.file),
        })),
      RELATED_VITEST_FILES,
      budget,
      lane.vitest,
      true,
    ),
    // The cap counts journeys tier 1 has not run; shards and the lane count
    // output entries, one per journey, which parameterized journeys sharing
    // a line repeat.
    browser: takeRelated(
      related.browser
        .map((candidate) => {
          const lines = repeatableLines(specs.get(candidate.file) ?? []);
          const done = selected.browser.get(candidate.file)?.lines ?? [];
          const fresh = lines.filter((line) => !done.includes(line));
          return {
            ...candidate,
            lines,
            cost: fresh.length,
            entries: lines.length - done.length,
            seconds: journeySeconds(candidate.file, fresh),
          };
        })
        .filter(({ cost }) => cost > 0),
      RELATED_JOURNEYS,
      budget,
      lane.browser,
    ),
  };
  const merged = {
    vitest: new Map(selected.vitest),
    browser: new Map(selected.browser),
  };
  for (const candidate of take.vitest.taken)
    merged.vitest.set(candidate.file, {
      tier: selected.vitest.has(candidate.file) ? "1, 2" : "2",
      whole: true,
      share: 1,
      entries: [candidate.file],
      note: `whole file (${reason(candidate)})`,
    });
  // A line-filtered edited file that tier 2 could not widen still runs its
  // changed tests, so it is unwidened rather than dropped.
  const filtered = ({ file }) => selected.vitest.has(file);
  const unwidened = [];
  for (const [key, why] of [
    ["overBudget", "time"],
    ["overCap", "the cap"],
  ])
    for (const candidate of take.vitest[key].filter(filtered)) {
      const entry = selected.vitest.get(candidate.file);
      merged.vitest.set(candidate.file, {
        ...entry,
        note: `${entry.note}; also related, not run whole for ${why}`,
      });
      unwidened.push(candidate);
    }
  for (const candidate of take.browser.taken)
    merged.browser.set(candidate.file, {
      tier: selected.browser.has(candidate.file) ? "1, 2" : "2",
      lines: candidate.lines,
      entries: candidate.lines.map((line) => `${candidate.file}:${line}`),
      note: `whole file: ${candidate.lines.length} journey(s) (${reason(candidate)})`,
    });
  return {
    selected: merged,
    take: {
      browser: take.browser,
      vitest: {
        taken: take.vitest.taken,
        overBudget: take.vitest.overBudget.filter((c) => !filtered(c)),
        overCap: take.vitest.overCap.filter((c) => !filtered(c)),
        unwidened,
      },
    },
    lanes: {
      browser: [lane.browser(take.browser.taken), lane.browser([])],
      vitest: [lane.vitest(take.vitest.taken), lane.vitest([])],
    },
  };
}

// Vitest files that import a changed file, by the module graph the pre-push
// hook's `vitest related` walks (scripts/check-push.mjs).
async function relatedVitest(files) {
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", {
    root,
    related: files.map((file) => `${root}${file}`),
    watch: false,
  });
  try {
    const specs = await vitest.getRelevantTestSpecifications();
    return [...new Set(specs.map((spec) => relative(root, spec.moduleId)))];
  } finally {
    await vitest.close();
  }
}

async function select(budget, base = "HEAD^1", head = "HEAD") {
  const changed = git(
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    "--diff-filter=AM",
    base,
    head,
    "--",
  ).split("\0");
  const files = { vitest: [], browser: [] };
  const added = new Set();
  const sources = [];
  for (let i = 0; i + 1 < changed.length; i += 2) {
    const [status, file] = [changed[i], changed[i + 1]];
    const runner = classify(file);
    if (runner) files[runner].push(file);
    else if (reachesTests(file)) sources.push(file);
    if (status === "A") added.add(file);
  }
  // Test files the other changes reach. Vitest decides which of its files
  // relate; the static graph finds journeys and ranks both by specificity.
  const related = { vitest: [], browser: [] };
  if (sources.length) {
    const modules = sources.filter((file) => !patchedPackage(file));
    const vitestFiles = modules.length
      ? (await relatedVitest(modules)).filter(
          (file) => classify(file) === "vitest",
        )
      : [];
    const specs = git("ls-files", "-z", "tests/browser")
      .split("\0")
      .filter((file) => classify(file) === "browser");
    const graph = await moduleGraph([...specs, ...vitestFiles]);
    const nodes = sources.map((file) =>
      patchedPackage(file) ? `npm:${patchedPackage(file)}` : file,
    );
    for (const [file, route] of routes(graph, specs, nodes))
      related.browser.push({ file, route, namesake: namesake(file, modules) });
    const vitestRoutes = routes(graph, vitestFiles, nodes);
    for (const file of vitestFiles)
      related.vitest.push({
        file,
        route: vitestRoutes.get(file),
        namesake: namesake(file, modules),
      });
  }
  const vitestStarts = files.vitest.length
    ? listVitest(files.vitest)
    : new Map();
  const listed = [
    ...new Set([...files.browser, ...related.browser.map(({ file }) => file)]),
  ];
  const browserSpecs = listed.length ? listBrowser(listed) : new Map();
  // Selections by runner and file, in summary order.
  const selected = { vitest: new Map(), browser: new Map() };
  for (const runner of ["vitest", "browser"]) {
    for (const file of files[runner]) {
      const specs = browserSpecs.get(file) ?? [];
      const starts =
        runner === "vitest"
          ? vitestStarts.get(file)
          : specs.map((spec) => spec.line);
      const lang = { ".ts": "ts", ".tsx": "tsx" }[extname(file)] ?? "js";
      const bodies = testBodies(
        readFileSync(`${root}${file}`, "utf8"),
        lang,
        starts,
      );
      const selection = selectTests(
        hunkRanges(git("diff", "-U0", "--no-color", base, head, "--", file)),
        bodies,
        {
          added: added.has(file),
          previous: added.has(file)
            ? []
            : testCalls(git("show", `${base}:${file}`), lang),
        },
      );
      if (runner === "vitest") {
        selected.vitest.set(file, {
          tier: "1",
          whole: selection.whole,
          // A line filter is charged its tests' share of the file's time.
          share: selection.whole
            ? 1
            : starts.filter((line) => selection.lines.includes(line)).length /
              starts.length,
          entries: vitestFilters(file, selection),
          note: selection.whole
            ? `whole file (${selection.reason})`
            : `${selection.lines.length} changed test(s)`,
        });
      } else {
        const repeatable = repeatableLines(specs);
        const lines = selection.whole
          ? repeatable
          : selection.lines.filter((line) => repeatable.includes(line));
        selected.browser.set(file, {
          tier: "1",
          lines,
          entries: lines.map((line) => `${file}:${line}`),
          note:
            lines.length === 0
              ? "excluded (measurement or tagged journeys only)"
              : selection.whole
                ? `whole file (${selection.reason}): ${lines.length} journey(s)`
                : `${lines.length} changed journey(s)`,
        });
      }
    }
  }
  const {
    selected: merged,
    take,
    lanes,
  } = addRelated(selected, related, {
    specs: browserSpecs,
    costs: costModel(JSON.parse(readFileSync(costsFile, "utf8"))),
    budget: budget * 60,
  });
  const minutes = (seconds) => `${(seconds / 60).toFixed(1)} min`;
  const predicted = (runner) =>
    `${minutes(lanes[runner][0])} (edited tests alone ${minutes(lanes[runner][1])})`;
  const journeys = (candidates) =>
    candidates.reduce((sum, { cost }) => sum + cost, 0);
  const rows = ["vitest", "browser"].flatMap((runner) =>
    [...merged[runner]].map(
      ([file, { tier, note }]) =>
        `| ${cell(file)} | ${runner} | ${tier} | ${cell(note)} |`,
    ),
  );
  // Once the Vitest lane fills, every later related file is dropped for time,
  // so name only the highest ranked, namesakes first. When the edited tests
  // alone fill it, none can join.
  const { overBudget } = take.vitest;
  const named = overBudget
    .slice(0, 5)
    .map(({ file, namesake }) =>
      namesake ? `${file} (named after ${namesake})` : file,
    );
  const more = overBudget.length - named.length;
  const vitestTotals =
    overBudget.length && lanes.vitest[1] > budget * 60
      ? [
          `Related Vitest files: none of the ${overBudget.length} can join, since the edited tests alone exceed the budget.`,
        ]
      : [
          `Related Vitest files: ${take.vitest.taken.length} selected; dropped ${overBudget.length} for time and ${take.vitest.overCap.length} for the cap of ${RELATED_VITEST_FILES}.`,
          ...(overBudget.length
            ? [
                "",
                `Related Vitest files dropped for time, highest ranked first: ${named.join(", ")}${more ? ` and ${more} more` : ""}.`,
              ]
            : []),
        ];
  const totals = [
    ...(rows.length
      ? [
          `Predicted lane wall time, budget ${budget} min: browser ${predicted("browser")}, Vitest ${predicted("vitest")}.`,
          "",
        ]
      : []),
    ...(sources.length
      ? [
          `Related journeys: ${journeys(take.browser.taken)} selected in ${take.browser.taken.length} spec(s); dropped ${journeys(take.browser.overBudget)} in ${take.browser.overBudget.length} spec(s) for time and ${journeys(take.browser.overCap)} in ${take.browser.overCap.length} spec(s) for the cap of ${RELATED_JOURNEYS}.`,
          "",
          ...vitestTotals,
          "",
        ]
      : []),
  ];
  summarize(
    [
      "## Flake check selection",
      "",
      ...(rows.length
        ? [
            "Tier 1 repeats the tests this pull request edited. Tier 2 adds test files its other changes reach, most specific first, while each lane stays inside the time budget and count cap; a Vitest file that does not fit is skipped. A route's spread counts the tests that reach its most widely shared module; a smaller spread is more specific.",
            "",
            "| File | Runner | Tier | Selection |",
            "| --- | --- | --- | --- |",
            ...rows,
          ]
        : ["No Vitest or Playwright test files changed or reached."]),
      "",
      ...totals,
    ].join("\n"),
  );
  const outputs = Object.fromEntries(
    Object.entries(merged).map(([runner, selections]) => [
      runner,
      [...selections.values()].flatMap(({ entries }) => entries),
    ]),
  );
  const shards = browserShards(outputs.browser.length);
  const text = [
    ...Object.entries(outputs).map(
      ([key, entries]) => `${key}=${entries.join(" ")}\n`,
    ),
    `browser_shards=${JSON.stringify(Array.from({ length: shards }, (_, i) => i + 1))}\n`,
    `browser_shard_total=${shards}\n`,
  ].join("");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

// Vitest has no repeat flag (--retry hides flakes instead), so run the
// selection once per iteration; each run is a fresh worker.
function repeatVitest(filters, iterations) {
  const dir = `${root}test-results/flake/vitest`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const runs = [];
  for (let i = 1; i <= iterations; i += 1) {
    const outputFile = `${dir}/iter-${i}.json`;
    const result = spawnSync(
      pnpm,
      [
        "exec",
        "vitest",
        "run",
        ...filters,
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    const statuses = new Map();
    let ok = false;
    try {
      const source = JSON.parse(readFileSync(outputFile, "utf8"));
      const report = parseVitest(source);
      for (const file of source.testResults)
        for (const test of file.assertionResults ?? [])
          statuses.set(
            `${relative(root, file.name)} › ${test.fullName}`,
            test.status,
          );
      ok = result.status === 0 && report.complete && report.counts.total > 0;
    } catch {
      ok = false;
    }
    runs.push({ ok, statuses });
    console.log(
      `flake-check: iteration ${i}/${iterations} ${ok ? "passed" : "FAILED"}`,
    );
  }
  const columns = runs.map((_, i) => String(i + 1));
  const mark = (status) =>
    ({ passed: "✅", failed: "❌" })[status] ?? (status ? "⏭" : "—");
  // A file:line filter reports the file's other tests as skipped; omit tests
  // that never ran so the table holds only the repeated ones.
  const ran = (status) => status === "passed" || status === "failed";
  const tests = [
    ...new Set(runs.flatMap((run) => [...run.statuses.keys()])),
  ].filter((test) => runs.some((run) => ran(run.statuses.get(test))));
  const failures = runs.filter((run) => !run.ok).length;
  summarize(
    [
      `## Flake check (Vitest): ${failures} of ${runs.length} iterations failed`,
      "",
      `| Test | ${columns.join(" | ")} | Failed |`,
      `| --- | ${columns.map(() => ":-:").join(" | ")} | ---: |`,
      `| **Run** | ${runs.map((run) => (run.ok ? "✅" : "❌")).join(" | ")} | ${failures}/${runs.length} |`,
      ...tests.sort().map((test) => {
        const statuses = runs.map((run) => run.statuses.get(test));
        return `| ${cell(test)} | ${statuses.map(mark).join(" | ")} | ${statuses.filter((status) => status === "failed").length}/${runs.length} |`;
      }),
      "",
      "",
    ].join("\n"),
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const option = (name, fallback) =>
    Number(
      args
        .find((argument) => argument.startsWith(`--${name}=`))
        ?.slice(`--${name}=`.length) ?? fallback,
    );
  const operands = args.filter((argument) => !argument.startsWith("--"));
  if (command === "select") {
    const budget = option("budget", LANE_BUDGET_MINUTES);
    if (budget > 0 && operands.length <= 2) return select(budget, ...operands);
  }
  if (command === "vitest") {
    const iterations = option("iterations", ITERATIONS);
    if (Number.isInteger(iterations) && iterations > 0 && operands.length > 0)
      return repeatVitest(operands, iterations);
  }
  if (command === "costs") return writeCosts(operands);
  throw new Error(
    "usage: flake-check select [--budget=minutes] [base] [head] | vitest [--iterations=N] <file[:line]…> | costs [run-id…]",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
