import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  generateKeyPairSync,
  sign as signEd25519,
  createHash,
} from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const script = fileURLToPath(
  new URL("../../scripts/preview-feed.mjs", import.meta.url),
);

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

const endpoint =
  "https://github.com/block/buzz-app/releases/download/preview-feed/latest.json";
const publicKeyBase64 =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJDQjQ2RDZFMUEwOERFMTEKUldRUjNnZ2FibTIwTE10QkVaMzFyYkZlY0R4ajhmbFBjdncvNVRCYnNpSm9kaFNBaHQzemZlZHkK";
// Inject a disposable public key into a copy of the promotion script, never into production.
function fixture(dir, version = "0.0.0-preview.22.1") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("12345678");
  const keyRecord = Buffer.concat([
    Buffer.from("Ed"),
    keyId,
    publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  ]);
  const encodedKey = Buffer.from(
    `untrusted comment: test public key\n${keyRecord.toString("base64")}\n`,
  ).toString("base64");
  const localScript = join(dir, "preview-feed.mjs");
  writeFileSync(
    localScript,
    readFileSync(script, "utf8").replace(publicKeyBase64, encodedKey),
  );
  const assetDir = join(dir, "assets");
  mkdirSync(assetDir);
  const installers = [
    `Buzz_${version}_aarch64.app.tar.gz`,
    `Buzz_${version}_x64.app.tar.gz`,
    `Buzz_${version}_x64_unsigned.exe`,
    `Buzz_${version}_amd64.deb`,
    `Buzz_${version}_x86_64.AppImage`,
  ].map((name) => join(assetDir, name));
  const [archive] = installers;
  const binary = join(dir, "buzz-foundation");
  const sig = `${archive}.sig`;
  const manifest = join(dir, "manifest.json");
  function signFile(file, versionField = "", signingKey = privateKey) {
    const record = Buffer.concat([
      Buffer.from("ED"),
      keyId,
      signEd25519(
        null,
        createHash("blake2b512").update(readFileSync(file)).digest(),
        signingKey,
      ),
    ]);
    const comment = `timestamp:1\tfile:archive.tar.gz${versionField ? `\tversion:${versionField}` : ""}`;
    const global = signEd25519(
      null,
      Buffer.concat([record.subarray(10), Buffer.from(comment)]),
      signingKey,
    );
    const text = `untrusted comment: test signature\n${record.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
    writeFileSync(`${file}.sig`, `${Buffer.from(text).toString("base64")}\n`);
  }
  for (const installer of installers) {
    writeFileSync(installer, `fixture bytes: ${installer}`);
    signFile(installer);
  }
  writeFileSync(binary, `compiled: ${endpoint} ${encodedKey}`);
  const sign = (...options) => signFile(archive, ...options);
  const args = (action, current) => [
    localScript,
    action,
    version,
    assetDir,
    manifest,
    binary,
    ...(current ? [current] : []),
  ];
  const execute = (action, current) =>
    spawnSync(process.execPath, args(action, current), { encoding: "utf8" });
  return {
    assetDir,
    installers,
    archive,
    binary,
    sig,
    manifest,
    sign,
    execute,
  };
}

test("preview candidate requires verified archive and updater-enabled binary with CLI 2.11.x signatures", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "preview-feed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { assetDir, archive, binary, sig, manifest, sign, execute } =
    fixture(dir);
  const archiveBytes = readFileSync(archive);
  const validSignature = readFileSync(sig, "utf8").trim();
  assert.equal(execute("generate").status, 0);
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(data.platforms["darwin-aarch64"].signature, validSignature);
  assert.equal(
    data.platforms["darwin-aarch64"].url,
    "https://github.com/block/buzz-app/releases/download/v0.0.0-preview.22.1/Buzz_0.0.0-preview.22.1_aarch64.app.tar.gz",
  );
  assert.equal(execute("verify").status, 0);
  const older = join(dir, "older.json");
  writeFileSync(
    older,
    JSON.stringify({ ...data, version: "0.0.0-preview.23.1" }),
  );
  assert.match(execute("verify", older).stderr, /rollback/);
  writeFileSync(
    older,
    JSON.stringify({ ...data, version: "0.0.0-preview.22.1" }),
  );
  assert.match(execute("verify", older).stderr, /differs/);
  data.platforms["darwin-aarch64"].url = "https://example.com/wrong";
  writeFileSync(manifest, JSON.stringify(data));
  assert.notEqual(execute("verify").status, 0);
  assert.notEqual(
    run("generate", "0.0.0-preview.bad", assetDir, manifest, binary).status,
    0,
  );
  writeFileSync(archive, "tampered archive");
  assert.match(execute("verify").stderr, /Archive signature invalid/);
  writeFileSync(archive, archiveBytes);
  const otherKey = generateKeyPairSync("ed25519").privateKey;
  sign(undefined, otherKey);
  assert.match(execute("verify").stderr, /Archive signature invalid/);
  // A signed archive can be replayed under another advertised version until
  // the signer and updater both enforce version binding in 2.12.x.
  sign("99.0.0-preview.999.1");
  assert.equal(execute("generate").status, 0);
  sign();
  const modifiedComment = Buffer.from(
    readFileSync(sig, "utf8").trim(),
    "base64",
  )
    .toString("utf8")
    .replace("trusted comment: timestamp:1", "trusted comment: timestamp:2");
  writeFileSync(sig, `${Buffer.from(modifiedComment).toString("base64")}\n`);
  assert.match(execute("verify").stderr, /Trusted comment signature invalid/);
  sign();
  writeFileSync(sig, "YWJjZA==\n");
  assert.notEqual(execute("verify").status, 0);
  sign();
  writeFileSync(binary, `compiled: ${endpoint}`);
  assert.match(execute("verify").stderr, /updater public key/);
});

test("preview feed signs every desktop installer into its updater target", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "preview-platforms-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { installers, manifest, execute } = fixture(dir);
  assert.equal(execute("generate").status, 0, execute("generate").stderr);
  const { platforms } = JSON.parse(readFileSync(manifest, "utf8"));
  const targets = [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
    "linux-x86_64-deb",
    "linux-x86_64-appimage",
  ];
  // Linux has no generic target, so a deb install cannot select the AppImage.
  assert.deepEqual(Object.keys(platforms), targets);
  targets.forEach((target, index) => {
    const name = installers[index].split("/").at(-1);
    assert.deepEqual(platforms[target], {
      signature: readFileSync(`${installers[index]}.sig`, "utf8").trim(),
      url: `https://github.com/block/buzz-app/releases/download/v0.0.0-preview.22.1/${name}`,
    });
  });
  const [, , windows, deb] = installers;
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  delete data.platforms["windows-x86_64"];
  writeFileSync(manifest, JSON.stringify(data));
  assert.notEqual(execute("verify").status, 0);
  writeFileSync(deb, "tampered deb");
  assert.match(execute("generate").stderr, /Archive signature invalid/);
  rmSync(`${windows}.sig`);
  assert.match(execute("generate").stderr, /ENOENT/);
});

test("preview rollback compares the complete canonical SemVer without number rounding", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "preview-versions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { manifest, execute } = fixture(dir);
  assert.equal(execute("generate").status, 0);
  const current = join(dir, "current.json");
  const candidate = JSON.parse(readFileSync(manifest, "utf8"));
  writeFileSync(
    current,
    JSON.stringify({ ...candidate, version: "1.0.0-preview.21.1" }),
  );
  assert.match(execute("verify", current).stderr, /rollback/);
  writeFileSync(
    current,
    JSON.stringify({ ...candidate, version: "0.0.0-preview.23.1" }),
  );
  assert.match(execute("verify", current).stderr, /rollback/);
  for (const invalid of [
    "01.0.0-preview.22.1",
    "0.0.0-preview.022.1",
    "0.0.0-preview.bad",
  ]) {
    writeFileSync(current, JSON.stringify({ ...candidate, version: invalid }));
    assert.match(execute("verify", current).stderr, /Invalid preview version/);
  }
});

test("successful preview publication promotes automatically; manual recovery bypasses skipped builds", () => {
  const workflow = parse(
    readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    ),
  );
  const { build, publish, promote_preview: promotion } = workflow.jobs;
  assert.match(build.if, /!inputs\.promote_version/);
  assert.deepEqual(publish.needs, [
    "build",
    "windows",
    "linux",
    "updater_signatures",
  ]);
  assert.deepEqual(promotion.needs, ["build", "publish"]);
  assert.match(promotion.if, /!cancelled\(\)/);
  assert.match(promotion.if, /!inputs\.candidates/);
  assert.match(
    promotion.if,
    /inputs\.promote_version == '' && needs\.build\.result == 'success' && needs\.publish\.result == 'success'/,
  );
  assert.match(
    promotion.if,
    /inputs\.promote_version != '' && needs\.build\.result == 'skipped' && needs\.publish\.result == 'skipped'/,
  );
  assert.equal(promotion.permissions.contents, "write");
  const promotionStep = promotion.steps.find((step) =>
    step.run?.includes("scripts/preview-feed.mjs verify"),
  );
  assert.equal(
    promotionStep.env.VERSION,
    `\${{ inputs.promote_version || needs.build.outputs.version }}`,
  );
  assert.ok(
    promotionStep.run.indexOf("scripts/preview-feed.mjs verify") <
      promotionStep.run.indexOf("gh release upload preview-feed"),
  );
  const cleanupStep = promotion.steps.at(-1);
  assert.equal(
    cleanupStep.run,
    "node scripts/prune-preview-releases.mjs --apply",
  );
  assert.equal(cleanupStep.if, "success()");
  assert.equal(cleanupStep.env.GH_REPO, `\${{ github.repository }}`);
  assert.equal(cleanupStep.env.GH_TOKEN, `\${{ github.token }}`);
});
