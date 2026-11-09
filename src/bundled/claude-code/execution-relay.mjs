import { spawn, spawnSync } from "node:child_process";

const version = spawnSync("claude", ["--version"], { encoding: "utf8" });
const found = /^(\d+)\.(\d+)\.(\d+)/.exec(version.stdout ?? "");
const minimum = CLAUDE_MIN_VERSION.split(".").map(Number);
const compatible =
  found &&
  found
    .slice(1)
    .map(Number)
    .reduce((order, part, i) => order || part - minimum[i], 0) >= 0;
if (version.status !== 0 || !compatible) {
  process.stderr.write(
    `Remote Claude needs Claude Code ${CLAUDE_MIN_VERSION} or later on PATH.\n`,
  );
  process.exit(1);
}
const env = { ...process.env };
for (const key of [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
])
  delete env[key];
Object.assign(env, {
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  DISABLE_AUTOUPDATER: "1",
});
const child = spawn("claude", CLAUDE_ARGS, {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
  process.stderr.write(error.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => child.kill());
