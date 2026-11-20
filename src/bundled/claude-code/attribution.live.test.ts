// @vitest-environment node
// Drives a real `claude` against a loopback Anthropic stand-in, with a fake
// key and an isolated config folder: run with CLAUDE_LIVE_BIN=/path/to/claude.
// It proves what reaches the endpoint, not real sign-in or gateway delivery.
import { spawn as spawnChild } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inferenceBundle } from "../../features/agents/gateway/contract";
import {
  VECTOR_BINDING,
  VECTOR_PROFILE,
} from "../../features/agents/gateway/vectors";
import type { HostProcessOptions } from "../../features/host/service";
import { ELSEWHERE, INHERITED } from "./attribution";
import { ClaudeProcess, type Spawn } from "./claude";
import script from "./claude.sh?raw";

const BIN = process.env.CLAUDE_LIVE_BIN;
const MODEL = "claude-sonnet-4-6";
const { headers: roles } = VECTOR_PROFILE;
/** Each model request's headers, in order, and its body by headers. */
const requests: IncomingHttpHeaders[] = [];
const bodies = new WeakMap<IncomingHttpHeaders, string>();
/** Which stand-in each request reached. */
const reached = new WeakMap<IncomingHttpHeaders, string>();
const handler =
  (name: string) =>
  async (request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!request.url?.startsWith("/v1/messages"))
      return void response.end("{}");
    if (request.url.includes("count_tokens"))
      return void response.end('{"input_tokens":1}');
    requests.push(request.headers);
    bodies.set(request.headers, body);
    reached.set(request.headers, name);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const message = {
      id: "msg",
      type: "message",
      role: "assistant",
      model: MODEL,
    };
    for (const [type, payload] of [
      [
        "message_start",
        {
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        { index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { index: 0, delta: { type: "text_delta", text: "ok" } },
      ],
      ["content_block_stop", { index: 0 }],
      [
        "message_delta",
        { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ],
      ["message_stop", {}],
    ] as const)
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`,
      );
    response.end();
  };
const server = createServer(handler("gateway"));
/** Another origin Claude's settings may move to. */
const other = createServer(handler("other"));
let origin = "";
let otherOrigin = "";
/** The effort a model request ran at, from its body. */
const effortOf = (headers: IncomingHttpHeaders) =>
  JSON.stringify(
    (JSON.parse(bodies.get(headers) ?? "{}") as Record<string, unknown>)
      .output_config ?? null,
  );
const folders: string[] = [];
let lastHome = "";
/** Rewrites the latest isolated folder's settings, as a gateway app might
 * while Claude runs, and waits for Claude to reload them. */
async function rewrite(env: Record<string, string>) {
  writeFileSync(join(lastHome, "settings.json"), JSON.stringify({ env }));
  await new Promise((resolve) => setTimeout(resolve, RELOAD_MS));
}
/** How long Claude 2.1.325 takes to reload a rewritten settings file, with
 * margin (Researcher saw it within 3s). */
const RELOAD_MS = 4_000;

/** A spawn of the real binary in an isolated config folder whose settings
 * point it at the stand-in, as a person's gateway setup does, with
 * `inherited` in its env as from the app's. `claude.sh`'s inherited-headers
 * check runs as itself, in the same env. */
function isolated(
  settings: Record<string, string>,
  inherited: Record<string, string> = {},
): Spawn {
  const home = mkdtempSync(join(tmpdir(), "buzz-attribution-"));
  folders.push(home);
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: origin, ...settings } }),
  );
  lastHome = home;
  return async (_id, options: HostProcessOptions = {}) => {
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      ...inherited,
    };
    for (const [key, value] of Object.entries(options.env ?? {}))
      if (value !== null) env[key] = value;
    Object.assign(env, {
      HOME: home,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: "fake-fixture-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    });
    const [program, args] =
      _id === "inherited-headers"
        ? ["bash", ["-c", script, "claude.sh", "inherited-headers"]]
        : [BIN ?? "claude", options.args ?? []];
    const child = spawnChild(program, args, {
      cwd: home,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      options.onStdout?.(data);
    });
    child.stderr.setEncoding("utf8").on("data", options.onStderr ?? (() => {}));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    return {
      write: (data) =>
        new Promise<void>((resolve, reject) =>
          child.stdin.write(data, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      end: async (data) => void child.stdin.end(data),
      kill: async () => void child.kill(),
      exited,
    };
  };
}
const attribution = (message: string) => {
  const bundle = inferenceBundle(VECTOR_PROFILE, VECTOR_BINDING, {
    channel_id: null,
    message_id: message,
    thread_id: null,
  });
  if (!bundle.ok) throw new Error(bundle.message);
  return { origin, profile: VECTOR_PROFILE, headers: bundle.value };
};
/** The requests a turn sent, after `from`. */
async function turn(claude: ClaudeProcess, text: string, effort?: string) {
  const from = requests.length;
  await expect(
    claude.send(text, effort ? { effort } : {}),
  ).resolves.toMatchObject({ ok: true });
  return requests.slice(from);
}

describe.skipIf(!BIN)("claude attribution", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    for (const stand of [server, other]) {
      stand.closeAllConnections();
      stand.close();
    }
    for (const folder of folders)
      rmSync(folder, { recursive: true, force: true });
  });

  it("updates and removes Buzz's headers in one process, keeping the person's", {
    timeout: 120_000,
  }, async () => {
    const claude = await ClaudeProcess.start(
      isolated({
        ANTHROPIC_CUSTOM_HEADERS: `x-keep-live: configured\n${roles.message_id}: user-config`,
      }),
      { cwd: "/", systemPrompt: "Answer in one word.", model: MODEL },
    );
    try {
      const m1 = "1".repeat(64);
      const m2 = "2".repeat(64);
      await expect(claude.attribute(attribution(m1))).resolves.toBeUndefined();
      const first = await turn(claude, "Reply with one word.");
      await expect(claude.attribute(attribution(m2))).resolves.toBeUndefined();
      const second = await turn(claude, "Reply again.");
      await expect(claude.attribute(undefined)).resolves.toBeUndefined();
      const third = await turn(claude, "Reply once more.");
      for (const requests of [first, second, third]) {
        expect(requests.length).toBeGreaterThan(0);
        for (const headers of requests)
          expect(headers["x-keep-live"]).toBe("configured");
      }
      expect(first.map((headers) => headers[roles.message_id])).toContain(m1);
      expect(first.every((headers) => headers[roles.launcher_session])).toBe(
        true,
      );
      expect(second.map((headers) => headers[roles.message_id])).toContain(m2);
      // Restored: the person's own value again, and no Buzz session.
      for (const headers of third) {
        expect(headers[roles.message_id]).toBe("user-config");
        expect(headers[roles.launcher_session]).toBeUndefined();
      }
    } finally {
      await claude.kill();
    }
  });

  it("leaves headers only the inherited env sets, and prefers settings over them", {
    timeout: 120_000,
  }, async () => {
    const launch = {
      cwd: "/",
      systemPrompt: "Answer in one word.",
      model: MODEL,
    };
    const own = { ANTHROPIC_CUSTOM_HEADERS: "x-inherited-live: env" };
    const only = await ClaudeProcess.start(isolated({}, own), launch);
    try {
      await expect(only.attribute(attribution("4".repeat(64)))).resolves.toBe(
        INHERITED,
      );
      const kept = await turn(only, "Reply with one word.");
      await expect(only.attribute(undefined)).resolves.toBeUndefined();
      const after = [...kept, ...(await turn(only, "Reply again."))];
      expect(after.length).toBeGreaterThan(1);
      for (const headers of after) {
        expect(headers["x-inherited-live"]).toBe("env");
        expect(headers[roles.launcher_session]).toBeUndefined();
      }
    } finally {
      await only.kill();
    }
    // A settings value outranks the inherited one, so it is the baseline.
    const both = await ClaudeProcess.start(
      isolated({ ANTHROPIC_CUSTOM_HEADERS: "x-keep-live: configured" }, own),
      launch,
    );
    try {
      await expect(
        both.attribute(attribution("5".repeat(64))),
      ).resolves.toBeUndefined();
      const attributed = await turn(both, "Reply with one word.");
      await both.attribute(undefined);
      const restored = await turn(both, "Reply again.");
      expect(attributed.map((headers) => headers[roles.message_id])).toContain(
        "5".repeat(64),
      );
      for (const headers of [...attributed, ...restored]) {
        expect(headers["x-keep-live"]).toBe("configured");
        expect(headers["x-inherited-live"]).toBeUndefined();
      }
      for (const headers of restored)
        expect(headers[roles.launcher_session]).toBeUndefined();
    } finally {
      await both.kill();
    }
  });

  it("follows a reloaded settings file: rotated headers, then another origin", {
    timeout: 120_000,
  }, async () => {
    const claude = await ClaudeProcess.start(
      isolated({ ANTHROPIC_CUSTOM_HEADERS: "x-keep-live: v1" }),
      { cwd: "/", systemPrompt: "Answer in one word.", model: MODEL },
    );
    try {
      await claude.attribute(attribution("6".repeat(64)));
      const first = await turn(claude, "Reply with one word.", "low");
      await rewrite({
        ANTHROPIC_BASE_URL: origin,
        ANTHROPIC_CUSTOM_HEADERS: "x-keep-live: v2",
      });
      await expect(
        claude.attribute(attribution("7".repeat(64))),
      ).resolves.toBeUndefined();
      const rotated = await turn(claude, "Reply again.", "low");
      await rewrite({
        ANTHROPIC_BASE_URL: otherOrigin,
        ANTHROPIC_CUSTOM_HEADERS: "x-keep-live: v3",
      });
      await expect(claude.attribute(attribution("8".repeat(64)))).resolves.toBe(
        ELSEWHERE,
      );
      const moved = await turn(claude, "Reply once more.", "low");
      for (const headers of first) expect(headers["x-keep-live"]).toBe("v1");
      expect(rotated.map((headers) => headers[roles.message_id])).toContain(
        "7".repeat(64),
      );
      for (const headers of rotated) {
        expect(reached.get(headers)).toBe("gateway");
        expect(headers["x-keep-live"]).toBe("v2");
      }
      // The new origin gets the person's own headers and none of Buzz's.
      expect(moved.length).toBeGreaterThan(0);
      for (const headers of moved) {
        expect(reached.get(headers)).toBe("other");
        expect(headers["x-keep-live"]).toBe("v3");
        expect(
          Object.keys(headers).filter((name) => name.startsWith("x-gw-")),
        ).toEqual([]);
      }
      // Removing Buzz's headers left the turn's effort as it was.
      for (const headers of [...rotated, ...moved])
        expect(effortOf(headers)).toBe(effortOf(first[0] ?? {}));
    } finally {
      await claude.kill();
    }
  });

  it("removes Buzz's headers where the person set none", {
    timeout: 120_000,
  }, async () => {
    const claude = await ClaudeProcess.start(isolated({}), {
      cwd: "/",
      systemPrompt: "Answer in one word.",
      model: MODEL,
    });
    try {
      await claude.attribute(attribution("3".repeat(64)));
      const attributed = await turn(claude, "Reply with one word.");
      expect(attributed.some((headers) => headers[roles.launcher_client])).toBe(
        true,
      );
      await claude.attribute(undefined);
      const restored = await turn(claude, "Reply again.");
      expect(restored.length).toBeGreaterThan(0);
      for (const headers of restored)
        expect(
          Object.keys(headers).filter((name) => name.startsWith("x-gw-")),
        ).toEqual([]);
      // A header the person adds afterwards reaches the endpoint.
      await rewrite({
        ANTHROPIC_BASE_URL: origin,
        ANTHROPIC_CUSTOM_HEADERS: "x-added-live: later",
      });
      const added = await turn(claude, "Reply once more.");
      expect(added.length).toBeGreaterThan(0);
      for (const headers of added)
        expect(headers["x-added-live"]).toBe("later");
    } finally {
      await claude.kill();
    }
  });
});
