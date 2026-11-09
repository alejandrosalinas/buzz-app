// Sets up the macOS Keychain helper `just desktop me` uses, once per Mac, and
// reuses it afterward. Keychain approvals belong to the program that asks, and a
// debug build is a different program after every rebuild; the helper is installed
// outside the repository and kept, so an approval given to it lasts. Debug builds
// are signed with a local certificate so the helper can tell them from other code.
// See docs/identity.md, "Local credential helper on macOS".
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// The code identifier `dev-sign-run.sh` signs debug builds with.
export const IDENTIFIER = "xyz.block.buzz.desktop.dev";
const CERTIFICATE = "Buzz Dev Signing";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

// The protocol this checkout's helper speaks. Each protocol has its own installed
// helper, so worktrees on different protocols never replace each other's.
function protocol(root) {
  const source = readFileSync(
    join(root, "crates/dev-credential-helper/src/policy.rs"),
    "utf8",
  );
  const match = /pub const PROTOCOL: u32 = (\d+);/.exec(source);
  if (!match) throw new Error("could not read the helper protocol");
  return Number(match[1]);
}

function installedProtocol(helper) {
  if (!existsSync(helper)) return 0;
  const result = spawnSync(helper, ["--version"], { encoding: "utf8" });
  const match =
    result.status === 0 &&
    /^buzz-dev-credential-helper protocol (\d+)$/m.exec(result.stdout);
  return match ? Number(match[1]) : 0;
}

function install(root, helper) {
  const target = join(root, "target");
  const cargo = existsSync(join(root, "bin/cargo"))
    ? join(root, "bin/cargo")
    : "cargo";
  const build = run(
    cargo,
    ["build", "--release", "--locked", "-p", "buzz-dev-credential-helper"],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CARGO_TARGET_DIR: target },
    },
  );
  if (build.status !== 0) throw new Error("could not build the helper");
  // Replace atomically: a running app may start the helper at any moment.
  const staged = `${helper}.${process.pid}`;
  copyFileSync(join(target, "release/buzz-dev-credential-helper"), staged);
  chmodSync(staged, 0o755);
  renameSync(staged, helper);
}

function login() {
  return join(userInfo().homedir, "Library/Keychains/login.keychain-db");
}

// The SHA-1 of the local signing identity, if its certificate and key are both
// in the login Keychain.
function findIdentity() {
  const result = run("/usr/bin/security", ["find-identity", login()]);
  const match = new RegExp(`\\b([0-9A-F]{40}) "${CERTIFICATE}"`).exec(
    result.stdout,
  );
  return match?.[1];
}

// A self-signed code-signing certificate, made with the system LibreSSL: the
// PKCS#12 files OpenSSL 3 writes by default are refused by `security import`.
function createIdentity() {
  const directory = mkdtempSync(join(tmpdir(), "buzz-dev-signing-"));
  try {
    const config = join(directory, "certificate.cnf");
    writeFileSync(
      config,
      [
        "[req]",
        "distinguished_name=dn",
        "x509_extensions=ext",
        "prompt=no",
        "[dn]",
        `CN=${CERTIFICATE}`,
        "[ext]",
        "basicConstraints=critical,CA:false",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=critical,codeSigning",
        "",
      ].join("\n"),
    );
    const key = join(directory, "key.pem");
    const certificate = join(directory, "certificate.pem");
    const bundle = join(directory, "identity.p12");
    const password = randomBytes(24).toString("hex");
    const env = { ...process.env, BUZZ_DEV_SIGNING_PASSWORD: password };
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650"],
      ["pkcs12", "-export", "-passout", "env:BUZZ_DEV_SIGNING_PASSWORD"],
    ]) {
      const files =
        args[0] === "req"
          ? ["-config", config, "-keyout", key, "-out", certificate]
          : ["-inkey", key, "-in", certificate, "-out", bundle];
      const result = run("/usr/bin/openssl", [...args, ...files], { env });
      if (result.status !== 0)
        throw new Error("could not create a signing certificate");
    }
    // Only codesign may use the key without asking.
    const imported = run("/usr/bin/security", [
      "import",
      bundle,
      "-k",
      login(),
      "-P",
      password,
      "-T",
      "/usr/bin/codesign",
    ]);
    if (imported.status !== 0)
      throw new Error("could not import the signing certificate");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const identity = findIdentity();
  if (!identity) throw new Error("the signing certificate is not usable");
  return identity;
}

// Install or reuse the helper and the local signing identity, and record the
// code requirement the helper checks callers against.
export function prepareCredentialHelper(root) {
  const directory = join(
    userInfo().homedir,
    ".buzz-foundation/dev-credential-helper",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const needed = protocol(root);
  const helper = join(directory, `buzz-dev-credential-helper-v${needed}`);
  if (installedProtocol(helper) !== needed) {
    install(root, helper);
    if (installedProtocol(helper) !== needed)
      throw new Error("the installed helper did not start");
    console.log(
      "Installed the Keychain helper. Click Always Allow on each Keychain dialog this launch; later launches won't ask.",
    );
  }
  const identity = findIdentity() ?? createIdentity();
  const requirement = join(directory, "requirement");
  const text = `identifier "${IDENTIFIER}" and certificate leaf = H"${identity.toLowerCase()}"\n`;
  if (!existsSync(requirement) || readFileSync(requirement, "utf8") !== text) {
    writeFileSync(`${requirement}.${process.pid}`, text, { mode: 0o600 });
    renameSync(`${requirement}.${process.pid}`, requirement);
  }
  return { helper, identity };
}
