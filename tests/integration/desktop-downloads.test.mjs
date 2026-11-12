import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  buildDownloadManifest,
  installerUrls,
} from "../../scripts/download-manifest.mjs";

const version = "1.0.1";
const previousVersion = "1.0.0";
const repository = "block/buzz-app";
const script = fileURLToPath(
  new URL("../../scripts/publish-desktop-downloads.mjs", import.meta.url),
);
const releaseFor = (value) => ({
  tag_name: `v${value}`,
  draft: false,
  prerelease: false,
  assets: Object.values(installerUrls(value)).map((url) => ({
    name: url.split("/").at(-1),
    browser_download_url: url,
    state: "uploaded",
    size: 42,
  })),
});
const manifestFor = (value) => buildDownloadManifest(value, releaseFor(value));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "desktop-downloads-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  writeFileSync(
    join(directory, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE, "utf8"));
const args = process.argv.slice(2);
const path = args[1]?.replace("repos/${repository}/", "");
const body = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
state.calls.push({ args, body });
const save = () => fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
const fail = (message) => { save(); console.error(message); process.exit(1); };
let output;
if (args[0] === "release") {
  assert.deepEqual(args, ["release", "download", "stable-feed", "--repo", "${repository}", "--pattern", "latest.json", "--output", "-"]);
  output = { version: state.feedVersion };
} else if (path.startsWith("releases/tags/")) {
  output = state.release;
} else if (path === "contents/downloads.json?ref=download-feed") {
  if (state.failRead) fail("HTTP 403");
  if (!state.manifest) fail("HTTP 404");
  const content = JSON.stringify(state.manifest, null, 2) + "\\n";
  output = { sha: "old-file-sha", content: Buffer.from(state.badReadback && state.written ? "{}" : content).toString("base64") };
} else {
  if (state.failWrite) fail("HTTP 409");
  assert.equal(args[2], "--method");
  if (path === "contents/downloads.json") {
    assert.equal(args[3], "PUT");
    assert.equal(body.branch, "download-feed");
    assert.equal(body.sha, "old-file-sha");
    state.manifest = JSON.parse(Buffer.from(body.content, "base64").toString());
    state.written = true;
    output = {};
  } else if (path === "git/trees") {
    assert.equal(args[3], "POST");
    assert.equal(body.tree.length, 1);
    assert.deepEqual(Object.keys(body.tree[0]).sort(), ["content", "mode", "path", "type"]);
    assert.equal(body.tree[0].path, "downloads.json");
    state.pending = JSON.parse(body.tree[0].content);
    output = { sha: "tree-sha" };
  } else if (path === "git/commits") {
    assert.equal(args[3], "POST");
    assert.deepEqual(body.parents, []);
    assert.equal(body.tree, "tree-sha");
    output = { sha: "commit-sha" };
  } else if (path === "git/refs") {
    assert.equal(args[3], "POST");
    assert.deepEqual(body, { ref: "refs/heads/download-feed", sha: "commit-sha" });
    state.manifest = state.pending;
    state.written = true;
    output = {};
  } else fail("Unexpected API call " + JSON.stringify(args));
}
save();
process.stdout.write(JSON.stringify(output));
`,
    { mode: 0o755 },
  );
  return (options = {}) => {
    const {
      args = [version, "--apply"],
      repo = repository,
      ...state
    } = options;
    writeFileSync(
      statePath,
      JSON.stringify({
        calls: [],
        feedVersion: version,
        release: releaseFor(version),
        manifest: manifestFor(previousVersion),
        ...state,
      }),
    );
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_REPO: repo,
        PATH: `${directory}:${process.env.PATH}`,
        TEST_STATE: statePath,
      },
    });
    return { ...result, state: JSON.parse(readFileSync(statePath, "utf8")) };
  };
}

const workflow = (name) =>
  parse(
    readFileSync(
      new URL(`../../.github/workflows/${name}`, import.meta.url),
      "utf8",
    ),
  );

test("manifest publication follows stable feed promotion in the same approved job", () => {
  const { jobs, concurrency } = workflow("desktop-stable-feed.yml");
  const steps = jobs.promote.steps;
  const [promotion, publication] = [
    "promote-updater-feed.sh stable-feed",
    "publish-desktop-downloads.mjs",
  ].map((command) => steps.findIndex((step) => step.run?.includes(command)));
  assert.ok(promotion >= 0 && publication > promotion);
  assert.equal(steps[publication].env.VERSION, steps[promotion].env.VERSION);
  assert.equal(steps[publication].if, undefined);
  assert.equal(jobs.promote.environment, "desktop-stable-feed");
  assert.equal(jobs.promote.permissions.contents, "write");
  assert.equal(concurrency["cancel-in-progress"], false);
  // Previews never move the website catalog.
  const previews = workflow("release.yml").jobs.promote_preview.steps;
  assert.ok(
    previews.every((step) => !step.run?.includes("publish-desktop-downloads")),
  );
});

test("dry run produces all five installers without writes; apply creates an orphan data branch", (t) => {
  const run = fixture(t);
  const dry = run({ args: [version], manifest: null });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), manifestFor(version));
  assert.ok(dry.state.calls.every((call) => call.body === null));
  const created = run({ manifest: null });
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(created.state.manifest, manifestFor(version));
  assert.equal(
    created.state.calls.at(-1).args[1],
    `repos/${repository}/contents/downloads.json?ref=download-feed`,
  );
});

test("updates use the existing file SHA; same-version recovery is read-only", (t) => {
  const run = fixture(t);
  const updated = run();
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(updated.state.manifest, manifestFor(version));
  assert.equal(updated.state.calls.filter((call) => call.body).length, 1);
  const repeated = run({ manifest: manifestFor(version) });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.ok(repeated.state.calls.every((call) => call.body === null));
});

test("rejects incomplete, empty, duplicate, unsafe, draft, prerelease or unpromoted release metadata before writes", (t) => {
  const run = fixture(t);
  const release = releaseFor(version);
  const rejectedWithoutWrites = (overrides) => {
    const result = run(overrides);
    assert.notEqual(result.status, 0);
    assert.ok(result.state.calls.every((call) => call.body === null));
  };
  rejectedWithoutWrites({ feedVersion: previousVersion });
  for (const overrides of [
    { draft: true },
    { prerelease: true },
    { assets: release.assets.slice(1) },
    { assets: [...release.assets, release.assets[0]] },
    { assets: release.assets.map((asset) => ({ ...asset, size: 0 })) },
    {
      assets: release.assets.map((asset) => ({
        ...asset,
        browser_download_url: "https://example.org/installer",
      })),
    },
  ]) {
    rejectedWithoutWrites({ release: { ...release, ...overrides } });
  }
});

test("rollback, invalid current metadata, read failure and write conflicts preserve the current manifest", (t) => {
  const run = fixture(t);
  for (const overrides of [
    { manifest: manifestFor("1.0.2") },
    { manifest: { ...manifestFor(version), channel: "preview" } },
    { failRead: true },
    { failWrite: true },
  ]) {
    const result = run(overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.state.written, undefined);
  }
  const mismatch = run({ badReadback: true });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /read-back differs/);
});

test("wrong repository and invalid arguments fail before GitHub calls", (t) => {
  const run = fixture(t);
  for (const options of [
    { repo: "example-org/other" },
    { args: ["1.0.1-preview.2.1", "--apply"] },
    { args: ["1.0.1-beta.1", "--apply"] },
    { args: [version, "--force"] },
  ]) {
    const result = run(options);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.state.calls, []);
  }
});
