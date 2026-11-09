import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { portForPath } from "../../scripts/worktree-port.mjs";

function recipe(name, ...args) {
  const settings = typeof args[0] === "object" ? args.shift() : {};
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-dev-command-"));
  const callsFile = path.join(directory, "calls.jsonl");
  const gooseFile = path.join(directory, "goose.jsonl");
  const commandFile = path.join(directory, "agent-command.jsonl");
  const cliFile = path.join(directory, "buzz-cli.jsonl");
  const openFile = path.join(directory, "open.jsonl");
  try {
    copyFileSync(
      new URL("../../justfile", import.meta.url),
      path.join(directory, "justfile"),
    );
    mkdirSync(path.join(directory, "scripts"));
    for (const file of [
      "desktop-build.mjs",
      "desktop-config.mjs",
      "desktop-dev.mjs",
      "worktree-icon.mjs",
      "worktree-port.mjs",
    ])
      copyFileSync(
        new URL(`../../scripts/${file}`, import.meta.url),
        path.join(directory, "scripts", file),
      );
    // Stand in for the Keychain helper setup: never build it or touch the Keychain.
    writeFileSync(
      path.join(directory, "scripts/dev-credential-helper.mjs"),
      `export function prepareCredentialHelper() {\n  if (process.env.BUZZ_TEST_HELPER_FAILS) throw new Error("no helper");\n  return { helper: "/helper", identity: "IDENTITY" };\n}\n`,
    );
    // Record the bundled goose-acp build instead of compiling it.
    writeFileSync(
      path.join(directory, "scripts/build-goose-acp.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.BUZZ_TEST_GOOSE, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    // Record the bundled command helper build instead of compiling it.
    writeFileSync(
      path.join(directory, "scripts/build-agent-command.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.BUZZ_TEST_AGENT_COMMAND, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    // Record the bundled buzz CLI build instead of compiling it.
    writeFileSync(
      path.join(directory, "scripts/build-buzz-cli.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.BUZZ_TEST_BUZZ_CLI, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    if (settings.local !== undefined)
      writeFileSync(path.join(directory, ".env.local"), settings.local);
    if (settings.mode !== undefined)
      writeFileSync(path.join(directory, ".env.development"), settings.mode);
    const vite = path.join(directory, "node_modules/vite");
    mkdirSync(vite, { recursive: true });
    writeFileSync(
      path.join(vite, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.mjs" }),
    );
    writeFileSync(
      path.join(vite, "index.mjs"),
      `export { loadEnv } from ${JSON.stringify(import.meta.resolve("vite"))};\n`,
    );
    // Run the real recipes and adapter; never open a native app.
    symlinkSync(process.execPath, path.join(directory, "node"));
    writeFileSync(
      path.join(directory, "pnpm"),
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.BUZZ_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "tauri" && process.argv[3] === "dev") console.log("VIEWER:" + JSON.stringify(process.env.BUZZ_DEV_VIEWER));
if (process.argv[2] === "tauri" && process.argv[3] === "dev") console.log("RELEASE_KEY:" + JSON.stringify(process.env.BUZZ_DEV_RELEASE_KEY ?? null));
if (process.argv[2] === "tauri" && process.argv[3] === "dev") console.log("HELPER:" + JSON.stringify([process.env.BUZZ_DEV_CREDENTIAL_HELPER ?? null, process.env.BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE ?? null, process.env.BUZZ_DEV_HELPER_SIGNING ?? null, process.env.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER?.endsWith("/scripts/dev-sign-run.sh") ?? null]));
if (process.argv[2] === "tauri") console.log("ENV:" + JSON.stringify({ fi: process.env.BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG, other: process.env.LOCAL_ONLY_SECRET, updater: process.env.BUZZ_UPDATER_ENDPOINT }));
\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(directory, "open"),
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.BUZZ_TEST_OPEN, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
      { mode: 0o755 },
    );
    // Set PATH inside the recipe shell: Hermit proxies restore their own PATH.
    const result = spawnSync(
      "just",
      [
        "--shell",
        "env",
        "--shell-arg",
        `PATH=${directory}${path.delimiter}${process.env.PATH}`,
        "--shell-arg",
        "sh",
        "--shell-arg",
        "-cu",
        "--justfile",
        "justfile",
        name,
        ...args,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          BUZZ_TEST_CALLS: callsFile,
          BUZZ_TEST_GOOSE: gooseFile,
          BUZZ_TEST_AGENT_COMMAND: commandFile,
          BUZZ_TEST_BUZZ_CLI: cliFile,
          BUZZ_TEST_OPEN: openFile,
          // Do not inherit the operator's public pin in isolated launcher tests.
          BUZZ_DEV_VIEWER: undefined,
          BUZZ_DEV_SIGNING_IDENTITY: undefined,
          BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG: undefined,
          LOCAL_ONLY_SECRET: undefined,
          BUZZ_UPDATER_ENDPOINT: undefined,
          BUZZ_DEV_RELEASE_KEY: undefined,
          BUZZ_DEV_CREDENTIAL_HELPER: undefined,
          BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE: undefined,
          BUZZ_DEV_HELPER_SIGNING: undefined,
          CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER: undefined,
          ...settings.env,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    const goose = existsSync(gooseFile)
      ? readFileSync(gooseFile, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    const command = existsSync(commandFile)
      ? readFileSync(commandFile, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    const cli = existsSync(cliFile)
      ? readFileSync(cliFile, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    const opened = existsSync(openFile)
      ? readFileSync(openFile, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    // The fixture is not a Git checkout, so the launcher hashes its own root for
    // its port; Node resolves that through symlinks when loading the script.
    const root = realpathSync(directory);
    return {
      ...result,
      calls,
      goose,
      command,
      cli,
      opened,
      root,
      port: portForPath(root),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function launched(target, ...args) {
  const result = recipe(target, ...args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls[0], ["install", "--frozen-lockfile"]);
  assert.equal(result.calls.length, 2);
  return { ...result, call: result.calls[1] };
}

const build = (port) => ({
  devUrl: `http://localhost:${port}`,
  beforeDevCommand: `pnpm dev:desktop --port ${port}`,
});

const identifier = "xyz.block.buzz.desktop.dev";

const overlay = (port) => ({
  identifier,
  build: build(port),
});

// Every debug bundle takes the development identifier, and nothing else here.
const bundled = ["--config", JSON.stringify({ identifier })];

const announced = (port, { derived = true } = {}) =>
  new RegExp(
    `^Desktop dev server on http://localhost:${port}` +
      (derived
        ? " \\(derived from the worktree path; pass --port to override\\)"
        : "") +
      "$",
    "m",
  );

test("web preserves the no-argument command", () => {
  assert.deepEqual(launched("web").call, ["dev"]);
});

test("desktop derives a port from the worktree path and leaves the OS scheme alone", () => {
  const { call, port, stdout } = launched("desktop");
  assert.ok(port >= 10010 && port <= 65009, String(port));
  assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.equal(call.length, 4);
  const config = JSON.parse(call[3]);
  assert.deepEqual(config, overlay(port));
  assert.match(stdout, announced(port));
  assert.doesNotMatch(stdout, /deep links open as/);
});

test("desktop builds the dev helpers first, and help does not", () => {
  for (const [target, args, expected] of [
    ["desktop", [], [["--dev"]]],
    ["desktop", ["--help"], []],
    ["desktop-bundle", [], []],
  ]) {
    const result = launched(target, ...args);
    assert.deepEqual(result.goose, expected);
    assert.deepEqual(result.command, expected);
    assert.deepEqual(result.cli, expected);
  }
});

test("stock tauri.conf.json starts Vite on its own devUrl port without the launcher", () => {
  // vite.config.ts defaults to the worktree-derived port, so a plain
  // `pnpm tauri dev` only works if the stock config passes its port explicitly.
  const { build: stock } = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  const port = Number(new URL(stock.devUrl).port);
  assert.ok(port >= 1 && port <= 65535, stock.devUrl);
  assert.deepEqual(stock, { ...stock, ...build(port) });
});

test("web forwards Vite arguments without reinterpreting or splitting them", () => {
  const args = [
    "--port",
    "1431",
    "--host",
    "127.0.0.1",
    "--base",
    "/two words/",
  ];
  assert.deepEqual(launched("web", ...args).call, ["dev", ...args]);
});

for (const value of ["1431", "1", "65535", "01431"]) {
  for (const args of [["--port", value], [`--port=${value}`]]) {
    test(`desktop translates ${args.join(" ")} to matched endpoints`, () => {
      const { call, stdout } = launched("desktop", ...args);
      assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
      assert.equal(call.length, 4);
      assert.deepEqual(JSON.parse(call[3]), overlay(Number(value)));
      // Nothing is derived, so nothing is offered for override.
      assert.match(stdout, announced(Number(value), { derived: false }));
    });
  }
}

for (const args of [["--scheme", "buzz-dev"], ["--scheme=buzz-dev"]]) {
  test(`launchers forward unsupported ${args.join(" ")} without overlaying a scheme`, () => {
    const desktop = launched("desktop", ...args);
    assert.deepEqual(JSON.parse(desktop.call[3]), overlay(desktop.port));
    assert.deepEqual(desktop.call.slice(4), args);
    assert.match(desktop.stdout, announced(desktop.port));
    const bundle = launched("desktop-bundle", ...args);
    assert.deepEqual(bundle.call, [
      "tauri",
      "build",
      "--debug",
      "--bundles",
      "app",
      ...bundled,
      ...args,
    ]);
    assert.doesNotMatch(bundle.stdout, /Bundling with deep links/);
  });
}

test("desktop prepends port config and preserves user config and arguments", () => {
  const config =
    '{"productName":"Two words","build":{"devUrl":"http://localhost:9999"}}';
  const runnerArgs = [
    "--",
    "--features",
    "feature",
    "--",
    "--port",
    "app-port",
    "$(pnpm injected)",
  ];
  const { call } = launched(
    "desktop",
    "--port",
    "1431",
    "--config",
    config,
    "--no-watch",
    "--port=1432",
    ...runnerArgs,
  );
  assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.deepEqual(JSON.parse(call[3]), overlay(1432));
  assert.deepEqual(call.slice(4), [
    "--config",
    config,
    "--no-watch",
    ...runnerArgs,
  ]);
});

test("desktop derives the port for help and runner-only arguments", () => {
  const help = launched("desktop", "--help");
  assert.deepEqual(help.call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.deepEqual(JSON.parse(help.call[3]), overlay(help.port));
  assert.deepEqual(help.call.slice(4), ["--help"]);
  assert.doesNotMatch(help.stdout, /Desktop dev server/, "help starts nothing");
  // Arguments after -- belong to the application, not to the launcher.
  const args = [
    "--no-watch",
    "--",
    "--port",
    "application-port",
    "--scheme",
    "x",
  ];
  const runner = launched("desktop", ...args);
  assert.deepEqual(runner.call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.deepEqual(JSON.parse(runner.call[3]), overlay(runner.port));
  assert.deepEqual(runner.call.slice(4), args);
  assert.match(runner.stdout, announced(runner.port));
});

test("desktop rejects invalid or missing ports before launching Tauri", () => {
  for (const args of [
    ["--port"],
    ["--port", "--no-watch"],
    ["--port="],
    ...[
      "",
      "0",
      "65536",
      "999999999999999999999999999999999999999999999",
      "not-a-port",
      "1431.5",
      " 1431",
      "1431; pnpm injected",
      "1431'",
      '1431"',
      "$(pnpm injected)",
      "1431\npnpm injected",
    ].map((value) => ["--port", value]),
  ]) {
    const result = recipe("desktop", ...args);
    assert.notEqual(result.status, 0, `Accepted ${JSON.stringify(args)}`);
    assert.match(
      result.stderr,
      /--port must be an integer between 1 and 65535/,
    );
    assert.deepEqual(result.calls, [["install", "--frozen-lockfile"]]);
  }
});

test("desktop config precedes Tauri's implicit runner-argument boundary", () => {
  const { call } = launched(
    "desktop",
    "--port",
    "1431",
    "--runner",
    "echo",
    "hello",
  );
  assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.equal(JSON.parse(call[3]).build.devUrl, "http://localhost:1431");
  assert.deepEqual(call.slice(4), ["--runner", "echo", "hello"]);
});

test("desktop-bundle builds a debug app bundle with only the development identifier by default", () => {
  // The fixture is not a linked worktree, so it has no icon to overlay.
  const { call, stdout } = launched("desktop-bundle");
  assert.deepEqual(call, [
    "tauri",
    "build",
    "--debug",
    "--bundles",
    "app",
    ...bundled,
  ]);
  assert.doesNotMatch(stdout, /Bundling with deep links/);
});

test("desktop-bundle --launch builds and opens the macOS app bundle", {
  skip: process.platform !== "darwin",
}, () => {
  const result = launched("desktop-bundle", "--launch");
  assert.deepEqual(result.call, [
    "tauri",
    "build",
    "--debug",
    "--bundles",
    "app",
    ...bundled,
  ]);
  const app = path.join(result.root, "target/debug/bundle/macos/Buzz.app");
  assert.deepEqual(result.opened, [[app]]);
  assert.match(result.stderr, /bundle is ad-hoc signed/);
});

test("desktop-bundle --launch does not warn for configured certificate signing", {
  skip: process.platform !== "darwin",
}, () => {
  const result = launched(
    "desktop-bundle",
    { env: { BUZZ_DEV_SIGNING_IDENTITY: "development-cert" } },
    "--launch",
  );
  assert.equal(
    JSON.parse(result.call[6]).bundle.macOS.signingIdentity,
    "development-cert",
  );
  assert.doesNotMatch(result.stderr, /ad-hoc signed/);
});

test("desktop-bundle --launch rejects bundle and artifact overrides", () => {
  for (const [settings, args, message] of [
    [{}, ["--launch", "--no-bundle"], /bundle flags/],
    [{}, ["--launch", "--bundles", "dmg"], /bundle flags/],
    [
      {},
      ["--launch", "--target", "aarch64-apple-darwin"],
      /custom app artifact from --target/,
    ],
    [
      {},
      ["--launch", "--config", '{"productName":"Other"}'],
      /custom app artifact from --config/,
    ],
    [
      { env: { CARGO_TARGET_DIR: "somewhere-else" } },
      ["--launch"],
      /custom app artifact from CARGO_TARGET_DIR/,
    ],
  ]) {
    const result = recipe("desktop-bundle", settings, ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(result.calls, [["install", "--frozen-lockfile"]]);
    assert.deepEqual(result.opened, []);
  }
});

for (const [name, settings, expected] of [
  [
    "local certificate",
    { local: "BUZZ_DEV_SIGNING_IDENTITY=local-cert\n" },
    "local-cert",
  ],
  [
    "environment precedence",
    {
      local: "BUZZ_DEV_SIGNING_IDENTITY=local-cert\n",
      env: { BUZZ_DEV_SIGNING_IDENTITY: "environment-cert" },
    },
    "environment-cert",
  ],
  [
    "empty environment override",
    {
      local: "BUZZ_DEV_SIGNING_IDENTITY=local-cert\n",
      env: { BUZZ_DEV_SIGNING_IDENTITY: "" },
    },
    undefined,
  ],
]) {
  test(`desktop-bundle signing: ${name}`, () => {
    const explicit = JSON.stringify({
      bundle: { macOS: { signingIdentity: "override-cert" } },
    });
    const { call } = launched("desktop-bundle", settings, "--config", explicit);
    assert.deepEqual(JSON.parse(call[6]), {
      identifier,
      ...(process.platform === "darwin" && expected
        ? { bundle: { macOS: { signingIdentity: expected } } }
        : {}),
    });
    assert.deepEqual(call.slice(7), ["--config", explicit]);
    // The certificate is scoped to bundling, even when it is exported.
    const dev = launched("desktop", settings);
    assert.equal(JSON.parse(dev.call[3]).bundle, undefined);
  });
}

test("desktop-bundle keeps a chosen bundle format and forwards the rest", () => {
  const { call } = launched(
    "desktop-bundle",
    "--bundles",
    "dmg",
    "--verbose",
    "--",
    "--features",
    "feature",
  );
  assert.deepEqual(call, [
    "tauri",
    "build",
    "--debug",
    ...bundled,
    "--bundles",
    "dmg",
    "--verbose",
    "--",
    "--features",
    "feature",
  ]);
});

test("desktop-bundle preserves no-bundle and ignores bundle flags after --", () => {
  assert.deepEqual(launched("desktop-bundle", "--no-bundle").call, [
    "tauri",
    "build",
    "--debug",
    ...bundled,
    "--no-bundle",
  ]);
  assert.deepEqual(launched("desktop-bundle", "--", "--bundles", "dmg").call, [
    "tauri",
    "build",
    "--debug",
    "--bundles",
    "app",
    ...bundled,
    "--",
    "--bundles",
    "dmg",
  ]);
});

for (const [name, settings, expected] of [
  [
    "local pin",
    { local: "BUZZ_DEV_VIEWER=local-public-pin\n" },
    "local-public-pin",
  ],
  [
    "mode precedence",
    { local: "BUZZ_DEV_VIEWER=local\n", mode: "BUZZ_DEV_VIEWER=mode\n" },
    "mode",
  ],
  [
    "process override",
    { local: "BUZZ_DEV_VIEWER=local\n", env: { BUZZ_DEV_VIEWER: "process" } },
    "process",
  ],
  [
    "explicit native override",
    { local: "BUZZ_DEV_VIEWER=local\n", env: { BUZZ_DEV_VIEWER: "" } },
    "",
  ],
  ["no broker", {}, ""],
]) {
  test(`desktop passes Vite's effective viewer to native startup: ${name}`, () => {
    const result = recipe("desktop", settings);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.includes(`VIEWER:${JSON.stringify(expected)}`),
      result.stdout,
    );
  });
}

// Only `just desktop me` reads the release key: never `.env.local` or the
// shell, since `.env.local` is copied into agents' worktrees.
for (const [name, args, settings, expected] of [
  ["me", ["me"], {}, "1"],
  ["me with options", ["me", "--port", "1430"], {}, "1"],
  ["plain", [], {}, null],
  ["from .env.local", [], { local: "BUZZ_DEV_RELEASE_KEY=1\n" }, null],
  ["from the shell", [], { env: { BUZZ_DEV_RELEASE_KEY: "1" } }, null],
]) {
  test(`desktop reads the release key only for me: ${name}`, () => {
    const result = recipe("desktop", settings, ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.includes(`RELEASE_KEY:${JSON.stringify(expected)}`),
      result.stdout,
    );
  });
}

// On macOS `me` also routes Keychain items through the helper and signs the
// build it starts; nothing else turns that on.
const routed = JSON.stringify(["/helper", "1", "IDENTITY", true]);
const direct = JSON.stringify([null, null, null, null]);
for (const [name, args, settings, expected] of [
  ["me", ["me"], {}, process.platform === "darwin" ? routed : direct],
  ["plain", [], {}, direct],
  [
    "from .env.local",
    [],
    {
      local:
        "BUZZ_DEV_CREDENTIAL_HELPER=/other\nBUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE=1\n",
    },
    direct,
  ],
  [
    "from the shell",
    [],
    {
      env: {
        BUZZ_DEV_CREDENTIAL_HELPER: "/other",
        BUZZ_DEV_HELPER_SIGNING: "X",
      },
    },
    direct,
  ],
  [
    "me when setup fails",
    ["me"],
    { env: { BUZZ_TEST_HELPER_FAILS: "1" } },
    direct,
  ],
]) {
  test(`desktop uses the Keychain helper only for me: ${name}`, () => {
    const result = recipe("desktop", settings, ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`HELPER:${expected}`), result.stdout);
    if (name === "me when setup fails" && process.platform === "darwin")
      assert.match(result.stderr, /Keychain helper unavailable \(no helper\)/);
  });
}

// The signed app's agents and plugins inherit its environment, so the runner
// must not leave itself configured there: their own `cargo run` would fail.
test("dev-sign-run.sh signs the app and drops its runner settings", {
  skip: process.platform !== "darwin",
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-dev-sign-run-"));
  try {
    const binary = path.join(directory, "env");
    copyFileSync("/usr/bin/env", binary);
    const runner = fileURLToPath(
      new URL("../../scripts/dev-sign-run.sh", import.meta.url),
    );
    const result = spawnSync(runner, [binary], {
      env: {
        PATH: process.env.PATH,
        // Ad hoc, so the test needs no certificate.
        BUZZ_DEV_HELPER_SIGNING: "-",
        BUZZ_DEV_CREDENTIAL_HELPER: "/helper",
        BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE: "1",
        CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER: runner,
        CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER: runner,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const launched = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    assert.equal(launched.BUZZ_DEV_CREDENTIAL_HELPER, "/helper");
    assert.equal(launched.BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE, "1");
    for (const name of [
      "BUZZ_DEV_HELPER_SIGNING",
      "CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER",
      "CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER",
    ])
      assert.ok(!(name in launched), `${name} reached the app`);
    const signed = spawnSync("/usr/bin/codesign", ["-dv", binary], {
      encoding: "utf8",
    });
    assert.match(signed.stderr, /Identifier=xyz\.block\.buzz\.desktop\.dev/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop refuses me after other arguments", () => {
  const result = recipe("desktop", "--port", "1430", "me");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /just desktop me --port 1430/);
  assert.ok(!result.stdout.includes("RELEASE_KEY:"), result.stdout);
});

// `.env.local` is a launch environment source for `BUZZ_` names, so native
// build inputs such as the FI descriptor can live there.
const descriptor = '{"version":1,"id":"example"}';
for (const target of ["desktop", "desktop-bundle"])
  for (const [name, settings, expected] of [
    [
      "local value",
      {
        local: `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG='${descriptor}'\nLOCAL_ONLY_SECRET=local\nBUZZ_UPDATER_ENDPOINT=https://updates.example\n`,
      },
      { fi: descriptor },
    ],
    [
      "process override",
      {
        local: `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG='${descriptor}'\n`,
        env: { BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG: "process" },
      },
      { fi: "process" },
    ],
    [
      "explicit empty override",
      {
        local: `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG='${descriptor}'\n`,
        env: { BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG: "" },
      },
      { fi: "" },
    ],
    [
      "literal dollar",
      {
        local: `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG='{"organization":"$LOCAL_ONLY_SECRET"}'\nLOCAL_ONLY_SECRET=local\n`,
      },
      { fi: '{"organization":"$LOCAL_ONLY_SECRET"}' },
    ],
    [
      "mode file ignored",
      { mode: `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG='${descriptor}'\n` },
      {},
    ],
    ["unset", {}, {}],
  ])
    test(`${target} passes .env.local BUZZ_ values to Tauri: ${name}`, () => {
      const result = recipe(target, settings);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        result.stdout.includes(`ENV:${JSON.stringify(expected)}`),
        result.stdout,
      );
    });
