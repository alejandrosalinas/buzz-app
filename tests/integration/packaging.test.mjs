import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "buzz-packaging-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("candidate version embeds the updater only when both values are set, never changes product identity", (t) => {
  for (const [updater, plugins] of [
    [{ BUZZ_UPDATER_PUBLIC_KEY: "", BUZZ_UPDATER_ENDPOINT: "" }, undefined],
    [{ BUZZ_UPDATER_PUBLIC_KEY: "key", BUZZ_UPDATER_ENDPOINT: "" }, undefined],
    [
      { BUZZ_UPDATER_PUBLIC_KEY: "key", BUZZ_UPDATER_ENDPOINT: "https://feed" },
      { updater: { pubkey: "key", endpoints: ["https://feed"] } },
    ],
  ]) {
    const directory = temporary(t);
    const output = join(directory, "env");
    const result = spawnSync(
      process.execPath,
      ["scripts/candidate-version.mjs"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...updater,
          RUNNER_TEMP: directory,
          GITHUB_ENV: output,
          GITHUB_OUTPUT: join(directory, "outputs"),
          GITHUB_RUN_NUMBER: "42",
          GITHUB_RUN_ATTEMPT: "2",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "candidate.json"))),
      {
        version: "0.7.0-preview.42.2",
        bundle: { createUpdaterArtifacts: false },
        ...(plugins && { plugins }),
      },
    );
    assert.equal(readFileSync(output, "utf8"), "VERSION=0.7.0-preview.42.2\n");
  }
});

// These job guards use the common Actions/JavaScript boolean-expression subset.
const format = (template, ...values) =>
  template.replace(/\{(\d+)\}/g, (_, index) => values[index]);
function selected(
  job,
  inputs = {},
  ref = "refs/heads/main",
  repository = "block/buzz-app",
) {
  return new Function("github", "inputs", "format", `return (${job.if})`)(
    { ref, repository },
    inputs,
    format,
  );
}

test("all-platform releases preserve candidate isolation and read-only installer jobs", () => {
  const caller = parse(read(".github/workflows/release.yml"));
  assert.equal(caller.on.workflow_dispatch.inputs.candidates.default, false);
  assert.equal(caller.permissions.contents, "read");
  // The preview caller builds main, or Windows/Linux candidates from any branch.
  const { desktop } = caller.jobs;
  assert.equal(desktop.uses, "./.github/workflows/desktop-build.yml");
  assert.equal(desktop.with.candidates, `\${{ inputs.candidates == true }}`);
  assert.equal(selected(desktop), true);
  assert.equal(
    selected(desktop, { candidates: false, promote_version: "" }),
    true,
  );
  assert.equal(
    selected(desktop, { promote_version: "0.0.0-preview.42.2" }),
    false,
  );
  assert.equal(
    selected(desktop, {}, "refs/heads/main", "fork/buzz-app"),
    false,
  );
  assert.equal(
    selected(desktop, { candidates: true }, "refs/heads/feature"),
    true,
  );
  assert.equal(selected(desktop, {}, "refs/heads/feature"), false);

  const workflow = parse(read(".github/workflows/desktop-build.yml"));
  assert.equal(workflow.permissions.contents, "read");
  const { jobs } = workflow;
  for (const job of [
    jobs.build,
    jobs.windows,
    jobs.linux,
    jobs.updater_signatures,
  ]) {
    assert.equal(selected(job), true);
    assert.equal(
      selected(job, { candidates: false, release_version: "" }),
      true,
    );
    assert.equal(
      selected(job, { release_version: "1.0.0" }, "refs/tags/v1.0.0"),
      true,
    );
    assert.equal(selected(job, {}, "refs/heads/main", "fork/buzz-app"), false);
  }
  for (const job of [jobs.build, jobs.updater_signatures])
    assert.equal(selected(job, { candidates: true }), false);
  // The only job holding the updater key signs only main or the release's own tag.
  for (const [inputs, ref] of [
    [{}, "refs/heads/feature"],
    [{}, "refs/tags/v1.0.0"],
    [{ release_version: "1.0.0" }, "refs/heads/main"],
    [{ release_version: "1.0.0" }, "refs/tags/v1.0.1"],
  ])
    assert.equal(selected(jobs.updater_signatures, inputs, ref), false);
  assert.deepEqual(jobs.updater_signatures.needs, ["windows", "linux"]);
  // Candidate-only runs omit the updater; previews check the preview feed and
  // stable or beta releases the stable feed, with the same key.
  const value = (name, inputs) =>
    new Function(
      "inputs",
      `return (${workflow.env[name].replace(/^\$\{\{(.*)\}\}$/s, "$1")})`,
    )(inputs);
  for (const name of ["BUZZ_UPDATER_PUBLIC_KEY", "BUZZ_UPDATER_ENDPOINT"])
    assert.equal(value(name, { candidates: true }), "");
  const key = value("BUZZ_UPDATER_PUBLIC_KEY", {});
  assert.ok(key.startsWith("dW50"));
  assert.equal(
    value("BUZZ_UPDATER_PUBLIC_KEY", { release_version: "1.0.0" }),
    key,
  );
  const feed = (name) =>
    `https://github.com/block/buzz-app/releases/download/${name}/latest.json`;
  assert.equal(value("BUZZ_UPDATER_ENDPOINT", {}), feed("preview-feed"));
  assert.equal(
    value("BUZZ_UPDATER_ENDPOINT", { release_version: "" }),
    feed("preview-feed"),
  );
  for (const release_version of ["1.0.0", "1.0.0-beta.1"])
    assert.equal(
      value("BUZZ_UPDATER_ENDPOINT", { release_version }),
      feed("stable-feed"),
    );
  assert.equal(workflow.env.RELEASE_VERSION, `\${{ inputs.release_version }}`);

  const downloads = jobs.publish.steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.deepEqual(
    downloads.map((step) => step.with.path),
    [
      "build-assets/macos-aarch64",
      "build-assets/macos-x64",
      "build-assets/windows",
      "build-assets/linux",
      "build-assets/signatures",
    ],
  );
  assert.deepEqual(jobs.build.strategy.matrix.include, [
    { target: "aarch64-apple-darwin", arch: "aarch64", lipo: "arm64" },
    { target: "x86_64-apple-darwin", arch: "x64", lipo: "x86_64" },
  ]);
  const build = jobs.build.steps.find(
    (step) => step.name === "Build unsigned app and DMG",
  ).run;
  assert.match(build, /target-libdir --target "\$TARGET"/);
  assert.match(build, /pnpm tauri build .*--target "\$TARGET"/);
  // Each leg checks the app and every bundled helper against its own architecture.
  const verification = jobs.build.steps.find(
    (step) => step.name === "Verify release DMG",
  );
  assert.match(verification.env.LIPO_ARCH, /^\$\{\{ matrix\.lipo \}\}$/);
  for (const binary of [
    "$app/Contents/MacOS/Buzz",
    "$goose",
    "$command",
    "$cli",
  ])
    assert.ok(
      verification.run.includes(
        `test "$(lipo -archs "${binary}")" = "$LIPO_ARCH"`,
      ),
      binary,
    );
  assert.doesNotMatch(verification.run, /arm64|x86_64/);
  const macos = jobs.build.steps.at(-1).with.name;
  assert.deepEqual(
    downloads.map((step) => step.with.name),
    [
      ...jobs.build.strategy.matrix.include.map(({ arch }) =>
        macos.replace(/\$\{\{ matrix\.arch \}\}/, arch),
      ),
      ...[jobs.windows, jobs.linux, jobs.updater_signatures].map(
        (job) => job.steps.at(-1).with.name,
      ),
    ],
  );
  const publication = jobs.publish.steps.at(-1).run;
  assert.match(
    publication,
    /gh release create "v\$VERSION" release-assets\/\*/,
  );
  assert.match(
    publication,
    /--target "\$SOURCE_SHA" --prerelease --latest=false/,
  );

  assert.match(workflow.jobs.build.if, /!inputs\.candidates/);
  assert.deepEqual(workflow.jobs.publish.needs, [
    "build",
    "windows",
    "linux",
    "updater_signatures",
  ]);
  assert.equal(
    workflow.jobs.publish.if,
    undefined,
    "default success dependency must skip publisher when macOS is skipped",
  );
  for (const platform of ["windows", "linux"]) {
    const job = workflow.jobs[platform];
    assert.equal(
      selected(job, { candidates: true }, "refs/heads/feature"),
      true,
    );
    assert.equal(job.permissions, undefined);
    assert.ok(
      job.steps.some((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      ),
    );
    assert.ok(!JSON.stringify(job).includes("secrets."));
  }
});

test("Huddle release provisioning passes microphone entitlements to the actual signer and installs Opus", () => {
  const workflow = parse(read(".github/workflows/desktop-build.yml"));
  const signer = workflow.jobs.build.steps.find((step) =>
    step.uses?.startsWith("block/apple-codesign-action@"),
  );
  assert.equal(
    signer.with["entitlements-plist-path"],
    "src-tauri/entitlements.plist",
  );
  assert.match(
    read(signer.with["entitlements-plist-path"]),
    /<key>com.apple.security.device.audio-input<\/key>\s*<true\/>/,
  );
  const verification = workflow.jobs.build.steps.find(
    (step) => step.name === "Verify release DMG",
  ).run;
  assert.match(verification, /SIGNED_DMG/);
  assert.match(verification, /codesign --display --entitlements/);
  assert.match(verification, /Print :com.apple.security.device.audio-input/);
  const dependencies = workflow.jobs.linux.steps.find(
    (step) => step.name === "Install build and packaging dependencies",
  ).run;
  assert.match(dependencies, /\blibopus-dev\b/);
});
