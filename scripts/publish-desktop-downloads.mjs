#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  buildDownloadManifest,
  compareStableVersions,
  downloadBranch,
  downloadRepository,
  stableVersionPattern,
  validateDownloadManifest,
} from "./download-manifest.mjs";

const [version, flag, ...extra] = process.argv.slice(2);
assert.ok(
  extra.length === 0 && (flag === undefined || flag === "--apply"),
  "Usage: GH_REPO=block/buzz-app node scripts/publish-desktop-downloads.mjs VERSION [--apply]",
);
assert.equal(
  process.env.GH_REPO,
  downloadRepository,
  "Unexpected publication repository",
);
assert.match(version, stableVersionPattern);
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const api = (path, body, method = "POST") =>
  JSON.parse(
    body === undefined
      ? gh("api", `repos/${downloadRepository}/${path}`)
      : execFileSync(
          "gh",
          [
            "api",
            `repos/${downloadRepository}/${path}`,
            "--method",
            method,
            "--input",
            "-",
          ],
          {
            input: JSON.stringify(body),
            encoding: "utf8",
          },
        ),
  );

// Follow the promoted stable feed, never an arbitrary published release.
const feed = JSON.parse(
  gh(
    "release",
    "download",
    "stable-feed",
    "--repo",
    downloadRepository,
    "--pattern",
    "latest.json",
    "--output",
    "-",
  ),
);
assert.equal(
  feed.version,
  version,
  "Requested version is not the promoted stable release",
);
const manifest = buildDownloadManifest(
  version,
  api(`releases/tags/v${version}`),
);
const content = `${JSON.stringify(manifest, null, 2)}\n`;
if (flag !== "--apply") {
  console.log(content.trimEnd());
  process.exit(0);
}

const contentsPath = `contents/downloads.json?ref=${downloadBranch}`;
const existing = spawnSync(
  "gh",
  ["api", `repos/${downloadRepository}/${contentsPath}`],
  { encoding: "utf8" },
);
let previous;
if (existing.status === 0) {
  previous = JSON.parse(existing.stdout);
  const current = validateDownloadManifest(
    JSON.parse(Buffer.from(previous.content, "base64").toString("utf8")),
  );
  assert.ok(
    compareStableVersions(version, current.version) >= 0,
    "Refusing download manifest rollback",
  );
  if (version === current.version) {
    assert.deepEqual(manifest, current, "Same-version manifest changed");
    console.log(`Download manifest already advertises ${version}.`);
    process.exit(0);
  }
} else {
  assert.match(
    existing.stderr,
    /HTTP 404/,
    "Could not read current download manifest",
  );
}

if (previous) {
  // The file SHA is an optimistic concurrency guard; a concurrent writer fails.
  api(
    "contents/downloads.json",
    {
      message: `chore(downloads): advertise ${version}`,
      branch: downloadBranch,
      sha: previous.sha,
      content: Buffer.from(content).toString("base64"),
    },
    "PUT",
  );
} else {
  // An orphan data branch keeps release data out of application source history.
  const tree = api("git/trees", {
    tree: [{ path: "downloads.json", mode: "100644", type: "blob", content }],
  });
  const commit = api("git/commits", {
    message: `chore(downloads): advertise ${version}`,
    tree: tree.sha,
    parents: [],
  });
  api("git/refs", { ref: `refs/heads/${downloadBranch}`, sha: commit.sha });
}
const served = api(contentsPath);
assert.equal(
  Buffer.from(served.content, "base64").toString("utf8"),
  content,
  "Published manifest read-back differs",
);
console.log(
  `Published ${version}: https://raw.githubusercontent.com/${downloadRepository}/${downloadBranch}/downloads.json`,
);
