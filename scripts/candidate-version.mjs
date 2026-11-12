import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const {
  GITHUB_RUN_NUMBER: run,
  GITHUB_RUN_ATTEMPT: attempt,
  RUNNER_TEMP: temp,
  BUZZ_UPDATER_PUBLIC_KEY: pubkey,
  BUZZ_UPDATER_ENDPOINT: endpoint,
  RELEASE_VERSION: release,
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
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const base = config.version.split("-")[0];
  assert.match(base, /^\d+\.\d+\.\d+$/);
  assert.match(run ?? "", /^[1-9]\d*$/);
  assert.match(attempt ?? "", /^[1-9]\d*$/);
  version = `${base}-preview.${run}.${attempt}`;
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
