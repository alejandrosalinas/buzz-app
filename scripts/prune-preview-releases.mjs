#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--apply"),
  "Usage: GH_REPO=block/buzz-app node scripts/prune-preview-releases.mjs [--apply]",
);
const apply = args[0] === "--apply";
const repository = process.env.GH_REPO;
assert.equal(repository, "block/buzz-app", "Unexpected cleanup repository");
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const gh = (...arguments_) =>
  execFileSync("gh", arguments_, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

// Read the live feed, not an input version that could differ after a failed promotion.
const manifest = JSON.parse(
  gh(
    "release",
    "download",
    "preview-feed",
    "--repo",
    repository,
    "--pattern",
    "latest.json",
    "--output",
    "-",
  ),
);
assert.match(manifest.version, versionPattern);
const protectedTag = `v${manifest.version}`;
const assets = {
  "darwin-aarch64": "aarch64.app.tar.gz",
  "darwin-x86_64": "x64.app.tar.gz",
  "windows-x86_64": "x64_unsigned.exe",
  "linux-x86_64-deb": "amd64.deb",
  "linux-x86_64-appimage": "x86_64.AppImage",
};
assert.deepEqual(
  Object.keys(manifest.platforms).sort(),
  Object.keys(assets).sort(),
);
for (const [target, asset] of Object.entries(assets)) {
  assert.equal(
    manifest.platforms[target].url,
    `https://github.com/${repository}/releases/download/${protectedTag}/Buzz_${manifest.version}_${asset}`,
    "Unexpected preview feed asset URL",
  );
}
const releases = JSON.parse(
  gh(
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/releases?per_page=100`,
  ),
).flat();
const previews = releases.filter(
  (release) =>
    release.prerelease === true &&
    release.draft === false &&
    typeof release.tag_name === "string" &&
    release.tag_name.startsWith("v") &&
    versionPattern.test(release.tag_name.slice(1)),
);
assert.ok(
  previews.some((release) => release.tag_name === protectedTag),
  "Preview feed target is missing from published previews",
);
for (const release of previews) {
  assert.ok(
    Number.isFinite(Date.parse(release.published_at)),
    `Invalid publication date for ${release.tag_name}`,
  );
}
previews.sort(
  (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
);
const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
const obsolete = previews
  .slice(10)
  .filter(
    (release) =>
      release.tag_name !== protectedTag &&
      Date.parse(release.published_at) < cutoff,
  );
for (const release of obsolete) {
  console.log(`${apply ? "Deleting" : "Would delete"} ${release.tag_name}`);
  if (apply) {
    gh(
      "release",
      "delete",
      release.tag_name,
      "--repo",
      repository,
      "--yes",
      "--cleanup-tag",
    );
  }
}
console.log(
  `${apply ? "Deleted" : "Dry run:"} ${obsolete.length} preview releases and tags; keeping ${previews.length - obsolete.length} previews.`,
);
