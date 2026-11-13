#!/usr/bin/env node
// Prints the preview version for a commit: one patch above the highest stable
// vX.Y.Z tag in its history, then -preview.<N>, where N is one above the highest
// existing v<base>-preview.<N> tag (1 if none). Betas and previews' own tags
// never set the base. Runs are serialized (release.yml's concurrency group) and
// a failed run publishes no tag, so a re-run gets the same N. release.yml runs it once and passes the result to every
// platform job, so a tag pushed mid-run cannot split their versions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [commit = "HEAD"] = process.argv.slice(2);
const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releases = execFileSync(
  "git",
  ["tag", "--merged", commit, "--list", "v*"],
  { encoding: "utf8" },
)
  .split("\n")
  .map((tag) => stable.exec(tag)?.slice(1).map(BigInt))
  .filter(Boolean);
assert.ok(releases.length, `No stable vX.Y.Z tag is reachable from ${commit}`);
const [major, minor, patch] = releases.reduce((highest, release) => {
  for (let i = 0; i < 3; i++)
    if (release[i] !== highest[i])
      return release[i] > highest[i] ? release : highest;
  return highest;
});
const base = `${major}.${minor}.${patch + 1n}`;
// Every tag, not only those reachable from the commit: previews of other
// commits share the base's counter.
const previewTag = new RegExp(
  `^v${base.replaceAll(".", "\\.")}-preview\\.([1-9]\\d*)$`,
);
const latest = execFileSync("git", ["tag", "--list", `v${base}-preview.*`], {
  encoding: "utf8",
})
  .split("\n")
  .map((tag) => previewTag.exec(tag)?.[1])
  .filter(Boolean)
  .map(BigInt)
  .reduce((highest, n) => (n > highest ? n : highest), 0n);
const version = `${base}-preview.${latest + 1n}`;
console.log(version);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
