import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { jobs } = parse(
  readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
);
const baseVersion = JSON.parse(
  readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
).version.split("-")[0];
const version = `${baseVersion}-preview.42.2`;
const sha = "a".repeat(40);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assets = {
  "macos-aarch64": [
    `Buzz_${version}_aarch64.dmg`,
    `Buzz_${version}_aarch64.app.tar.gz`,
    `Buzz_${version}_aarch64.app.tar.gz.sig`,
  ],
  "macos-x64": [
    `Buzz_${version}_x64.dmg`,
    `Buzz_${version}_x64.app.tar.gz`,
    `Buzz_${version}_x64.app.tar.gz.sig`,
  ],
  windows: [`Buzz_${version}_x64_unsigned.exe`],
  linux: [`Buzz_${version}_amd64.deb`, `Buzz_${version}_x86_64.AppImage`],
  signatures: [
    `Buzz_${version}_x64_unsigned.exe.sig`,
    `Buzz_${version}_amd64.deb.sig`,
    `Buzz_${version}_x86_64.AppImage.sig`,
  ],
};
const assembly = jobs.publish.steps.find((step) =>
  step.run?.includes("sha256sum --check"),
).run;

test("Tauri and the release signer use microphone entitlements and verify the signed app", () => {
  const config = JSON.parse(
    readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const signing = jobs.build.steps.find((step) => step.id === "codesign");
  const path = `src-tauri/${config.bundle.macOS.entitlements}`;
  assert.equal(signing.with["entitlements-plist-path"], path);
  assert.match(
    readFileSync(join(root, path), "utf8"),
    /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/,
  );
  const verify = jobs.build.steps.find(
    (step) => step.name === "Verify release DMG",
  );
  assert.ok(
    verify.run.includes(
      'codesign --display --entitlements :- "$app" > "$RUNNER_TEMP/signed-entitlements.plist"',
    ),
  );
  assert.ok(
    verify.run.includes(
      `test "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.device.audio-input' "$RUNNER_TEMP/signed-entitlements.plist")" = true ||`,
    ),
  );
  assert.ok(
    jobs.build.steps.indexOf(verify) <
      jobs.build.steps.findIndex(
        (step) => step.name === "Stage release assets and checksums",
      ),
  );
});

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("existing platform version generators agree for the same run and attempt", (t) => {
  const dir = temp(t);
  const env = {
    ...process.env,
    GITHUB_RUN_NUMBER: "42",
    GITHUB_RUN_ATTEMPT: "2",
    RUNNER_TEMP: dir,
    GITHUB_ENV: join(dir, "env"),
    GITHUB_OUTPUT: join(dir, "outputs"),
    BUZZ_UPDATER_PUBLIC_KEY: "fixture-key",
    BUZZ_UPDATER_ENDPOINT: "https://example.com/feed",
  };
  const macos = jobs.build.steps.find((step) => step.id === "version").run;
  for (const command of [macos, "node scripts/candidate-version.mjs"]) {
    const result = spawnSync("bash", ["-e", "-c", command], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const name of ["release.json", "candidate.json"]) {
    const config = JSON.parse(readFileSync(join(dir, name), "utf8"));
    assert.equal(config.version, version);
    assert.equal(config.bundle.createUpdaterArtifacts, false);
    assert.deepEqual(config.plugins.updater, {
      pubkey: "fixture-key",
      endpoints: ["https://example.com/feed"],
    });
  }
  assert.equal(readFileSync(env.GITHUB_ENV, "utf8"), `VERSION=${version}\n`);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), `version=${version}\n`);
});

function fixture(t) {
  const dir = temp(t);
  for (const [platform, files] of Object.entries(assets)) {
    const path = join(dir, "build-assets", platform);
    mkdirSync(path, { recursive: true });
    for (const file of files) writeFileSync(join(path, file), file);
    if (platform === "signatures") continue;
    writeFileSync(join(path, "SOURCE_COMMIT"), `${sha}\n`);
    writeFileSync(
      join(path, "SHA256SUMS"),
      files
        .filter((file) => !file.endsWith(".sig"))
        .map((file) => `${hash(file)}  ./${file}\n`)
        .join(""),
    );
  }
  return {
    dir,
    run: () =>
      spawnSync("bash", ["-e", "-c", assembly], {
        cwd: dir,
        env: { ...process.env, VERSION: version, SOURCE_SHA: sha },
        encoding: "utf8",
      }),
  };
}

test("actual assembly command collects all twelve assets and emits one complete checksum file", (t) => {
  const { dir, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const output = join(dir, "release-assets");
  const files = Object.values(assets).flat();
  assert.deepEqual(
    readdirSync(output).sort(),
    [...files, "SHA256SUMS", "SOURCE_COMMIT"].sort(),
  );
  for (const file of files)
    assert.equal(readFileSync(join(output, file), "utf8"), file);
  assert.equal(readFileSync(join(output, "SOURCE_COMMIT"), "utf8"), `${sha}\n`);
  const checksums = readFileSync(join(output, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(
    checksums.sort(),
    files.map((file) => `${hash(file)}  ./${file}`).sort(),
  );
});

for (const failure of [
  "corrupt",
  "mixed version",
  "missing platform",
  "missing Intel macOS",
  "missing signature",
]) {
  test(`actual assembly refuses ${failure} before publication`, (t) => {
    const { dir, run } = fixture(t);
    const windows = join(dir, "build-assets/windows");
    const file = assets.windows[0];
    if (failure === "corrupt") writeFileSync(join(windows, file), "corrupted");
    if (failure === "mixed version") {
      const older = file.replace("42.2", "42.1");
      renameSync(join(windows, file), join(windows, older));
      writeFileSync(join(windows, "SHA256SUMS"), `${hash(file)}  ./${older}\n`);
    }
    if (failure === "missing platform") rmSync(windows, { recursive: true });
    if (failure === "missing Intel macOS")
      rmSync(join(dir, "build-assets/macos-x64"), { recursive: true });
    if (failure === "missing signature")
      rmSync(join(dir, "build-assets/signatures", assets.signatures[2]));
    assert.notEqual(run().status, 0);
  });
}

test("actual publication retries a failed create, deleting only a draft it left", (t) => {
  const publication = jobs.publish.steps.find(
    (step) => step.name === "Publish desktop previews",
  ).run;
  const tag = `v${version}`;
  // Fake gh fails `release create` until its SUCCEED_ON-th call and reports
  // LEFT ("true" for a draft, "false" for a published release, empty for
  // none) as the release's isDraft; the fakes log every call so the test sees
  // what ran between tries.
  const publish = (succeedOn, left = "", deleteStatus = 0) => {
    const dir = temp(t);
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "release-assets"));
    writeFileSync(join(dir, "release-assets", "SHA256SUMS"), "");
    writeFileSync(
      join(dir, "bin", "gh"),
      `#!/bin/bash
case "$1 $2" in
  "release create")
    echo "create $3" >> "$DIR/calls"
    n=$(grep -c ^create "$DIR/calls")
    [ "$n" -ge "$SUCCEED_ON" ] ;;
  "release view")
    echo "view \${*:3}" >> "$DIR/calls"
    [ -n "$LEFT" ] || { echo "release not found" >&2; exit 1; }
    echo "$LEFT" ;;
  "release delete")
    echo "delete \${*:3}" >> "$DIR/calls"
    exit "$DELETE_STATUS" ;;
  *) exit 64 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "bin", "sleep"),
      '#!/bin/sh\necho "sleep $1" >> "$DIR/calls"\n',
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", publication], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        DIR: dir,
        SUCCEED_ON: String(succeedOn),
        LEFT: left,
        DELETE_STATUS: String(deleteStatus),
        VERSION: version,
        SOURCE_SHA: sha,
        GITHUB_RUN_ID: "42",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    return { status: result.status, calls };
  };
  const create = `create ${tag}`;
  const view = `view ${tag} --json isDraft --jq .isDraft`;

  assert.deepEqual(publish(1), { status: 0, calls: [create] });
  // A failed try may leave nothing to delete; that must not stop the retry.
  assert.deepEqual(publish(3), {
    status: 0,
    calls: [create, view, "sleep 15", create, view, "sleep 30", create],
  });
  // A draft is deleted before the next try, which runs even if that fails.
  assert.deepEqual(publish(2, "true", 1), {
    status: 0,
    calls: [create, view, `delete ${tag} --yes`, "sleep 15", create],
  });
  assert.deepEqual(publish(4), {
    status: 1,
    calls: [create, view, "sleep 15", create, view, "sleep 30", create],
  });
  // A published release, as a publish-only re-run finds, stays in place.
  assert.deepEqual(publish(4, "false"), { status: 1, calls: [create, view] });
});
