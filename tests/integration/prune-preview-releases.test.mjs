import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../scripts/prune-preview-releases.mjs", import.meta.url),
);
const repository = "block/buzz-app";
const now = Date.parse("2026-10-15T12:00:00Z");
const day = 24 * 60 * 60 * 1000;
const listArgs = [
  "api",
  "--paginate",
  "--slurp",
  `repos/${repository}/releases?per_page=100`,
];
const feedArgs = [
  "release",
  "download",
  "preview-feed",
  "--repo",
  repository,
  "--pattern",
  "latest.json",
  "--output",
  "-",
];
const tag = (run) => `v0.0.0-preview.${run}.1`;
const deleteArgs = (name) => [
  "release",
  "delete",
  name,
  "--repo",
  repository,
  "--yes",
  "--cleanup-tag",
];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "prune-previews-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const releases = Array.from({ length: 13 }, (_, index) => ({
    tag_name: tag(index + 1),
    draft: false,
    prerelease: true,
    published_at: new Date(now - (30 - index) * day).toISOString(),
    // Creation/commit order is not publication order.
    created_at: new Date(now - index * day).toISOString(),
  }));
  const manifest = {
    version: "0.0.0-preview.1.1",
    platforms: Object.fromEntries(
      Object.entries({
        "darwin-aarch64": "aarch64.app.tar.gz",
        "darwin-x86_64": "x64.app.tar.gz",
        "windows-x86_64": "x64_unsigned.exe",
        "linux-x86_64-deb": "amd64.deb",
        "linux-x86_64-appimage": "x86_64.AppImage",
      }).map(([target, asset]) => [
        target,
        {
          url: `https://github.com/${repository}/releases/download/${tag(1)}/Buzz_0.0.0-preview.1.1_${asset}`,
        },
      ]),
    ),
  };
  writeFileSync(join(directory, "clock.mjs"), `Date.now = () => ${now};\n`);
  writeFileSync(
    join(directory, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
const data = JSON.parse(fs.readFileSync(process.env.FIXTURE_DATA, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  assert.deepEqual(args, ${JSON.stringify(listArgs)});
  if (data.failList) process.exit(1);
  process.stdout.write(JSON.stringify(data.pages));
} else if (args[1] === "download") {
  assert.deepEqual(args, ${JSON.stringify(feedArgs)});
  if (data.failFeed) process.exit(1);
  process.stdout.write(JSON.stringify(data.manifest));
} else {
  assert.deepEqual(args, ["release", "delete", args[2], "--repo", "${repository}", "--yes", "--cleanup-tag"]);
  if (args[2] === data.failDelete) process.exit(1);
}
`,
    { mode: 0o755 },
  );
  function run({ args = [], repo = repository, pages, ...overrides } = {}) {
    const calls = join(directory, "calls.jsonl");
    const data = join(directory, "data.json");
    writeFileSync(calls, "");
    writeFileSync(
      data,
      JSON.stringify({
        manifest,
        // Two pages keep the pagination contract cheap to exercise.
        pages: pages ?? [releases.slice(0, 7), releases.slice(7)],
        ...overrides,
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", join(directory, "clock.mjs"), script, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_REPO: repo,
          PATH: `${directory}:${process.env.PATH}`,
          FIXTURE_DATA: data,
          FIXTURE_CALLS: calls,
        },
      },
    );
    return {
      ...result,
      calls: readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  }
  return { run, releases, manifest };
}

test("dry run reads all pages and preserves the newest ten plus the feed target", (t) => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [feedArgs, listArgs]);
  assert.match(result.stdout, /Would delete v0\.0\.0-preview\.3\.1/);
  assert.match(result.stdout, /Would delete v0\.0\.0-preview\.2\.1/);
  assert.match(result.stdout, /Dry run: 2/);
});

test("apply deletes only eligible preview releases and their tags, leaving other releases untouched", (t) => {
  const { run, releases } = fixture(t);
  for (const [name, prerelease, draft] of [
    ["v1.0.0", false, false],
    [tag(30), false, false],
    [tag(40), true, true],
    ["v0.0.0-preview.19.1-windows-linux", true, false],
    ["preview-feed", true, false],
  ]) {
    releases.push({
      tag_name: name,
      prerelease,
      draft,
      published_at: new Date(now - 40 * day).toISOString(),
    });
  }
  const result = run({ args: ["--apply"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    feedArgs,
    listArgs,
    deleteArgs(tag(3)),
    deleteArgs(tag(2)),
  ]);
  assert.match(result.stdout, /Deleted 2/);
});

test("seven-day retention is inclusive and independent of the newest-ten floor", (t) => {
  const { run, releases } = fixture(t);
  for (const release of releases.slice(3)) {
    release.published_at = new Date(now - day).toISOString();
  }
  releases[1].published_at = new Date(now - 7 * day).toISOString();
  releases[2].published_at = new Date(now - 7 * day - 1).toISOString();
  releases.push({
    ...releases[1],
    tag_name: tag(14),
    published_at: new Date(now - 7 * day + 1).toISOString(),
  });
  const result = run({ args: ["--apply"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [feedArgs, listArgs, deleteArgs(tag(3))]);
});

test("unavailable or invalid feed/listing aborts before any deletion", (t) => {
  const { run, manifest, releases } = fixture(t);
  for (const overrides of [
    { failFeed: true },
    { failList: true },
    { pages: [releases.slice(1)] },
    {
      manifest: {
        ...manifest,
        platforms: { ...manifest.platforms, "linux-aarch64": {} },
      },
    },
    {
      manifest: {
        ...manifest,
        platforms: {
          ...manifest.platforms,
          "linux-x86_64-deb": { url: "https://example.com/archive" },
        },
      },
    },
    {
      manifest: {
        ...manifest,
        platforms: {
          "darwin-aarch64": manifest.platforms["darwin-aarch64"],
        },
      },
    },
    { pages: [[...releases, { ...releases[2], published_at: null }]] },
  ]) {
    const result = run({ args: ["--apply"], ...overrides });
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.ok(result.calls.every((args) => args[1] !== "delete"));
  }
});

test("an unknown argument or an unexpected repository aborts without GitHub calls", (t) => {
  const { run } = fixture(t);
  for (const options of [
    { args: ["--aplpy"] },
    { args: ["--apply"], repo: "someone/other" },
  ]) {
    const result = run(options);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  }
});

test("deletion failure stops cleanup and fails the run", (t) => {
  const { run } = fixture(t);
  const failed = run({ args: ["--apply"], failDelete: tag(3) });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(failed.calls, [feedArgs, listArgs, deleteArgs(tag(3))]);
});
