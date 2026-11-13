import assert from "node:assert/strict";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const {
  RUNNER_TEMP: temp,
  BUZZ_UPDATER_PUBLIC_KEY: pubkey,
  BUZZ_UPDATER_ENDPOINT: endpoint,
  RELEASE_VERSION: release,
  PREVIEW_VERSION: preview,
} = process.env;
let version;
if (release) {
  // A stable or beta version, taken from its tag rather than tauri.conf.json.
  assert.match(
    release,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.[1-9]\d*)?$/,
  );
  version = release;
} else {
  // Computed once per run by scripts/preview-version.mjs.
  assert.match(
    preview ?? "",
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.[1-9]\d*$/,
  );
  version = preview;
}
writeFileSync(
  join(temp, "candidate.json"),
  JSON.stringify({
    version,
    bundle: { createUpdaterArtifacts: false },
    // Matches build.rs: the updater is registered only when both are set.
    ...(pubkey && endpoint
      ? { plugins: { updater: { pubkey, endpoints: [endpoint] } } }
      : {}),
  }),
);
appendFileSync(process.env.GITHUB_ENV, `VERSION=${version}\n`);
// The macOS job publishes it as the build's version output.
appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
