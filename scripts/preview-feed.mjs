#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Must match the key and endpoint embedded by the updater-enabled release build (#312).
const publicKeyBase64 =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJDQjQ2RDZFMUEwOERFMTEKUldRUjNnZ2FibTIwTE10QkVaMzFyYkZlY0R4ajhmbFBjdncvNVRCYnNpSm9kaFNBaHQzemZlZHkK";
const endpoint =
  "https://github.com/block/buzz-app/releases/download/preview-feed/latest.json";
const [command, version, assetDir, manifestPath, binaryPath, currentPath] =
  process.argv.slice(2);
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const release = `v${version}`;
// Linux entries are installer-specific: a deb install must never receive an AppImage.
const assets = {
  "darwin-aarch64": `Buzz_${version}_aarch64.app.tar.gz`,
  "darwin-x86_64": `Buzz_${version}_x64.app.tar.gz`,
  "windows-x86_64": `Buzz_${version}_x64_unsigned.exe`,
  "linux-x86_64-deb": `Buzz_${version}_amd64.deb`,
  "linux-x86_64-appimage": `Buzz_${version}_x86_64.AppImage`,
};
const usage =
  "Usage: preview-feed.mjs generate|verify <version> <asset-dir> <manifest-file> <macos-app-binary-file> [current-manifest-file]";

function previewNumber(value) {
  const match = versionPattern.exec(value);
  assert.ok(match, `Invalid preview version: ${value}`);
  return match.slice(1).map(BigInt);
}

function compareVersions(left, right) {
  const a = previewNumber(left);
  const b = previewNumber(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function decodeBase64(value) {
  assert.match(
    value,
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  );
  return Buffer.from(value, "base64");
}

function publicKey() {
  const keyLines = decodeBase64(publicKeyBase64)
    .toString("utf8")
    .trimEnd()
    .split("\n");
  assert.equal(keyLines.length, 2);
  const keyRecord = decodeBase64(keyLines[1]);
  assert.equal(keyRecord.length, 42);
  assert.equal(keyRecord.subarray(0, 2).toString(), "Ed");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      keyRecord.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  return { key, keyId: keyRecord.subarray(2, 10) };
}

function verifySignature({ key, keyId }, archivePath, signaturePath) {
  const signedText = decodeBase64(
    readFileSync(signaturePath, "utf8").trim(),
  ).toString("utf8");
  const lines = signedText.trimEnd().split("\n");
  assert.equal(lines.length, 4, "Expected a complete Minisign signature");
  assert.match(lines[0], /^untrusted comment: /);
  assert.match(lines[2], /^trusted comment: /);
  const record = decodeBase64(lines[1]);
  const global = decodeBase64(lines[3]);
  assert.equal(record.length, 74);
  assert.equal(global.length, 64);
  assert.deepEqual(record.subarray(2, 10), keyId, "Signing key mismatch");
  const message = readFileSync(archivePath);
  const algorithm = record.subarray(0, 2).toString();
  assert.ok(
    algorithm === "ED" || algorithm === "Ed",
    "Unsupported signature algorithm",
  );
  const payload =
    algorithm === "ED"
      ? createHash("blake2b512").update(message).digest()
      : message;
  assert.ok(
    verifyEd25519(null, payload, key, record.subarray(10)),
    "Archive signature invalid",
  );
  const trusted = lines[2].slice("trusted comment: ".length);
  assert.ok(
    verifyEd25519(
      null,
      Buffer.concat([record.subarray(10), Buffer.from(trusted)]),
      key,
      global,
    ),
    "Trusted comment signature invalid",
  );
  // Releases omit --app-version, so their trusted comments have no version field.
  // Version binding remains a separate signer/client/promotion migration.
}

// The Windows and Linux build jobs check their own installed binaries.
function verifyMacosBinary() {
  const binary = readFileSync(binaryPath);
  assert.ok(
    binary.includes(Buffer.from(endpoint)),
    "Candidate does not embed the updater endpoint",
  );
  assert.ok(
    binary.includes(Buffer.from(publicKeyBase64)),
    "Candidate does not embed the updater public key",
  );
}

function validate(manifest, platforms) {
  assert.equal(manifest.version, version);
  assert.deepEqual(manifest.platforms, platforms);
}

previewNumber(version);
if (command !== "generate" && command !== "verify") throw new Error(usage);
assert.ok(assetDir && manifestPath && binaryPath, usage);
const key = publicKey();
const platforms = Object.fromEntries(
  Object.entries(assets).map(([target, asset]) => {
    const path = join(assetDir, asset);
    verifySignature(key, path, `${path}.sig`);
    return [
      target,
      {
        signature: readFileSync(`${path}.sig`, "utf8").trim(),
        url: `https://github.com/block/buzz-app/releases/download/${release}/${asset}`,
      },
    ];
  }),
);
verifyMacosBinary();
if (command === "generate") {
  if (currentPath) {
    const current = JSON.parse(readFileSync(currentPath, "utf8"));
    if (current.version === version) {
      validate(current, platforms);
      writeFileSync(manifestPath, readFileSync(currentPath, "utf8"));
      process.exit(0);
    }
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version,
        notes: `Buzz ${version} desktop preview`,
        pub_date: new Date().toISOString(),
        platforms,
      },
      null,
      2,
    )}\n`,
  );
} else {
  validate(JSON.parse(readFileSync(manifestPath, "utf8")), platforms);
  if (currentPath) {
    const current = JSON.parse(readFileSync(currentPath, "utf8"));
    const order = compareVersions(version, current.version);
    assert.ok(order >= 0, "Refusing preview feed rollback");
    if (order === 0) {
      assert.equal(
        readFileSync(manifestPath, "utf8"),
        readFileSync(currentPath, "utf8"),
        "Same-version manifest differs",
      );
    }
  }
}
