import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { publisher, signPackage } from "../fixtures/plugin-release.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const compiled = spawnSync(
  "cargo",
  ["build", "--quiet", "--locked", "-p", "buzzodz-plugins", "--bin", "buzzodz"],
  { cwd: root, encoding: "utf8" },
);
assert.equal(compiled.status, 0, compiled.stderr);
const metadata = spawnSync(
  "cargo",
  ["metadata", "--format-version=1", "--no-deps", "--locked"],
  { cwd: root, encoding: "utf8" },
);
assert.equal(metadata.status, 0, metadata.stderr);
const binary = path.join(
  JSON.parse(metadata.stdout).target_directory,
  "debug",
  process.platform === "win32" ? "buzzodz.exe" : "buzzodz",
);
// Without --home the CLI would open this machine's development app storage.
const home = mkdtempSync(path.join(tmpdir(), "buzzodz-home-"));
test.after(() => rmSync(home, { recursive: true, force: true }));
function cli(...args) {
  return spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BUZZODZ_HOME: home,
      BUZZ_REQUIRE_PLUGIN_SIGNATURES: "1",
    },
  });
}
async function project(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "buzzodz-build-"));
  const source = path.join(directory, "page");
  try {
    const initialized = cli("plugin", "init", source, "test.page", "Test page");
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /Created test.page/);
    // A scaffold consumes the same packed declarations as independent plugins.
    const author = path.join(directory, "author");
    const generated = spawnSync("pnpm", ["author:build", author], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    const packed = spawnSync(
      "pnpm",
      ["pack", "--pack-destination", directory],
      { cwd: author, encoding: "utf8" },
    );
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    await rm(author, { recursive: true });
    const scaffold = await readFile(path.join(source, "src/index.tsx"), "utf8");
    assert.match(scaffold, /import type.*@buzz\/author/);
    assert.doesNotMatch(scaffold, /declare module|interface Context/);
    const installed = spawnSync(
      "pnpm",
      [
        "add",
        "-D",
        "--ignore-scripts",
        path.join(directory, "buzz-author-0.0.0-preview.1.tgz"),
      ],
      {
        cwd: source,
        encoding: "utf8",
      },
    );
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    await run(directory, source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("CLI help and errors are readable text with appropriate exit codes", () => {
  const help = cli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^buzzodz .*\n\nCommands:/);
  assert.doesNotMatch(help.stdout, /\\n/);
  assert.match(
    help.stdout,
    /sign DIST_DIRECTORY\s+Sign with your saved Buzz human identity/,
  );
  assert.doesNotMatch(help.stdout, /KEY_FILE/);
  const error = cli("plugin", "unknown");
  assert.equal(error.status, 1);
  assert.match(error.stderr, /^Error: Unknown command/);
  // A subprocess must not read a developer's OS credential. The fake-store Rust
  // test covers successful signing and signed import/load.
  const oldSign = cli(
    "plugin",
    "sign",
    "dist",
    "https://example.test/plugin.artifact.json",
  );
  assert.equal(oldSign.status, 1);
  assert.match(oldSign.stderr, /Usage: buzzodz plugin sign DIST_DIRECTORY/);
});
test("CLI rejects unsigned and invalid releases without changing the installed revision", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "buzzodz-signatures-"));
  const testHome = path.join(directory, "home");
  try {
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({ id: "test.signed", name: "Signed", apiVersion: 1 }),
    );
    await writeFile(
      path.join(directory, "plugin.js"),
      "export function apply() {}",
    );
    const unsigned = cli("--home", testHome, "plugin", "install", directory);
    assert.equal(unsigned.status, 1);
    assert.match(unsigned.stderr, /External plugins require a signed release/);

    await signPackage(directory);
    const signaturePath = path.join(directory, "plugin.signature.json");
    const signature = await readFile(signaturePath, "utf8");
    await writeFile(
      signaturePath,
      JSON.stringify({ ...JSON.parse(signature), sig: "0".repeat(128) }),
    );
    const invalid = cli("--home", testHome, "plugin", "install", directory);
    assert.equal(invalid.status, 1);
    assert.match(
      invalid.stderr,
      /Invalid plugin release event ID or signature/,
    );
    await writeFile(signaturePath, signature);
    const installed = cli("--home", testHome, "plugin", "install", directory);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(
      cli("--home", testHome, "plugin", "enable", "test.signed").status,
      0,
    );

    const registryPath = path.join(testHome, "profiles/default/registry.json");
    const before = await readFile(registryPath, "utf8");
    const artifactPath = path.join(directory, "plugin.artifact.json");
    await writeFile(artifactPath, `${await readFile(artifactPath, "utf8")}\n`);
    const tampered = cli("--home", testHome, "plugin", "reload", "test.signed");
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /Invalid or ambiguous plugin release x tag/);
    assert.equal(await readFile(registryPath, "utf8"), before);

    await rm(artifactPath);
    await rm(signaturePath);
    const unsignedReload = cli(
      "--home",
      testHome,
      "plugin",
      "reload",
      "test.signed",
    );
    assert.equal(unsignedReload.status, 1);
    assert.match(
      unsignedReload.stderr,
      /External plugins require a signed release/,
    );
    assert.equal(await readFile(registryPath, "utf8"), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("scaffold builds through pnpm and installs a usable standalone JSX page", async () => {
  await project(async (directory, source) => {
    const built = cli("plugin", "build", source);
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    assert.match(built.stdout, /Built /);
    const module = await import(
      pathToFileURL(path.join(source, "dist/plugin.js"))
    );
    let Page;
    const root = new Context();
    root.provide("pages", {
      register: ({ component }) => {
        Page = component;
      },
    });
    root.provide("react", {
      useState: () => [0, () => {}],
      createElement: (...args) => args,
    });
    await root.plugin({ inject: module.inject, apply: module.apply });
    assert.equal(Page()[0], "section");
    await root.fiber.dispose();
    await signPackage(path.join(source, "dist"));
    const installed = cli(
      "--home",
      directory,
      "plugin",
      "install",
      path.join(source, "dist"),
    );
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /Installed test.page \(disabled\)/);
    const enabled = cli("--home", directory, "plugin", "enable", "test.page");
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stdout, /Enabled test.page/);
    const listed = cli("--home", directory, "plugin", "list");
    assert.match(listed.stdout, /test.page\s+enabled\s+external\s+Test page/);
    assert.ok(listed.stdout.includes(`Publisher: ${publisher}`));
    const registryPath = path.join(directory, "profiles/default/registry.json");
    const installedPlugin = async () =>
      JSON.parse(await readFile(registryPath, "utf8")).installed["test.page"];
    const first = await installedPlugin();
    await writeFile(
      path.join(source, "src/index.tsx"),
      'export function apply(ctx: any) { ctx.pages.register({id: "main", title: "Reloaded", component: () => null}); }',
    );
    assert.equal(cli("plugin", "build", source).status, 0);
    await signPackage(path.join(source, "dist"));
    const reloaded = cli("--home", directory, "plugin", "reload", "test.page");
    assert.equal(reloaded.status, 0, reloaded.stderr);
    assert.match(reloaded.stdout, /Reloaded test.page/);
    const second = await installedPlugin();
    assert.equal(second.enabled, true);
    assert.notEqual(second.current, first.current);
    assert.equal(second.previous, first.current);
    assert.equal(
      cli("--home", directory, "plugin", "reload", "test.page").status,
      0,
    );
    assert.deepEqual(await installedPlugin(), second);
    const manifestPath = path.join(source, "dist/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host = { processes: [{ id: "extra", program: "echo" }] };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await signPackage(path.join(source, "dist"));
    const accepted = cli("--home", directory, "plugin", "reload", "test.page");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Previous host access/);
    assert.match(accepted.stdout, /Updated host access/);
    assert.match(accepted.stdout, /extra/);
    assert.deepEqual((await installedPlugin()).manifest.host, {
      commands: [],
      networkOrigins: [],
      processes: [{ id: "extra", program: "echo", args: [] }],
    });
    assert.equal((await installedPlugin()).enabled, true);
    assert.equal(
      cli("--home", directory, "plugin", "disable", "test.page").status,
      0,
    );
    delete manifest.host;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await signPackage(path.join(source, "dist"));
    assert.equal(
      cli("--home", directory, "plugin", "reload", "test.page").status,
      0,
    );
    assert.equal((await installedPlugin()).enabled, false);
    const beforeRollback = await installedPlugin();
    const rolledBack = cli(
      "--home",
      directory,
      "plugin",
      "rollback",
      "test.page",
    );
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal((await installedPlugin()).current, beforeRollback.previous);
    assert.equal((await installedPlugin()).enabled, false);
    assert.equal(
      cli("--home", directory, "plugin", "remove", "test.page").status,
      0,
    );
    assert.equal(await installedPlugin(), undefined);
  });
});
test("failed source builds preserve the installed revision", async () => {
  await project(async (directory, source) => {
    assert.equal(cli("plugin", "build", source).status, 0);
    await signPackage(path.join(source, "dist"));
    assert.equal(
      cli("--home", directory, "plugin", "install", path.join(source, "dist"))
        .status,
      0,
    );
    const registryPath = path.join(directory, "profiles/default/registry.json");
    const before = await readFile(registryPath, "utf8");
    for (const invalid of [
      "export const wrong = 1;",
      'import { Context } from "@buzz/author"; export function apply() { new Context(); }',
      "this is not javascript!",
      'import { Context } from "@deepseek-ai/cordis"; export function apply() { new Context(); }',
      'import * as React from "react"; export function apply(_ctx) { _ctx.pages.register({id: "main", title: "Main", component: () => React.createElement("h1")}); }',
    ]) {
      await writeFile(path.join(source, "src/index.tsx"), invalid);
      const built = cli("plugin", "build", source);
      assert.notEqual(built.status, 0);
      assert.match(built.stderr, /Error: Plugin build failed/);
      assert.equal(await readFile(registryPath, "utf8"), before);
    }
  });
});
