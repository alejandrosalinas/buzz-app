// @vitest-environment node
// Drives a real `goose-acp` with the owner's goose config: run with
// GOOSE_ACP_BIN=/path/to/goose-acp. The Buzz tools are listed as the app lists
// them, from a loopback HTTP MCP server that follows the app's native one;
// their calls are recorded, not sent to a relay.
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { respond } from "../../buzz-mcp/rpc";
import {
  answerMcp,
  type HostProcessOptions,
} from "../../features/host/service";
import { systemPrompt } from "../claude-code/prompt";
import {
  GooseProcess,
  type Choice,
  type ServeMcp,
  type Spawn,
  type ToolServer,
} from "./goose";
import { GooseSetup } from "./setup";
import { GooseHistory, sessionTags } from "./transcript";

const BIN = process.env.GOOSE_ACP_BIN;

const spawn: Spawn = async (_id, options: HostProcessOptions = {}) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {}))
    if (value === null) delete env[key];
    else env[key] = value;
  const child = spawnChild(BIN ?? "goose-acp", [], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (data) => {
    if (process.env.GOOSE_ACP_DEBUG) process.stderr.write(`<< ${data}`);
    options.onStdout?.(data);
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    if (process.env.GOOSE_ACP_DEBUG) process.stderr.write(data);
    options.onStderr?.(data);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      ),
    end: async (data) => {
      child.stdin.end(data);
    },
    kill: async () => {
      child.kill();
    },
    exited,
  };
};

/** The HTTP requests the MCP servers received, by method and status. */
const hits: { method: string; status: number }[] = [];

const method = (body: string): unknown => {
  try {
    return (JSON.parse(body) as { method?: unknown } | null)?.method;
  } catch {
    return undefined;
  }
};

/** What the app's native listener does: a token per server, 404 for a wrong
 * one, 405 for `GET`, and a JSON reply or 202 for each `POST /mcp`. An
 * `initialize` that succeeds claims the server's one session, and later
 * requests must name it; before it, only discovery and `ping` are answered. A
 * second `initialize` stops the server. */
const serve: ServeMcp = async (handler) => {
  const token = randomBytes(32).toString("base64url");
  const session = randomBytes(32).toString("base64url");
  let claim: "unclaimed" | "claiming" | "claimed" = "unclaimed";
  const server = createServer((request, response) => {
    let joined = false;
    const end = (status: number, body?: string) => {
      hits.push({ method: request.method ?? "", status });
      response.writeHead(status, {
        ...(joined && (status === 200 || status === 202)
          ? { "Mcp-Session-Id": session }
          : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      });
      response.end(body);
    };
    if (
      request.url?.split("?")[0] !== "/mcp" ||
      request.headers.authorization !== `Bearer ${token}`
    )
      return end(404);
    if (request.method !== "POST") return end(405);
    const named = request.headers["mcp-session-id"];
    if (named !== undefined && (named !== session || claim !== "claimed"))
      return end(404);
    let body = "";
    request.setEncoding("utf8").on("data", (data) => (body += data));
    request.on("end", async () => {
      const kind = method(body);
      const claiming = named === undefined && kind === "initialize";
      if (claiming) {
        if (claim !== "unclaimed") {
          server.close();
          return end(404);
        }
        claim = "claiming";
      } else if (named === undefined) {
        // goose first asks `server/discover`.
        if (
          claim === "claimed" ||
          (kind !== "server/discover" && kind !== "ping")
        )
          return end(404);
      } else joined = true;
      const reply = await answerMcp(handler, body);
      if (claiming) {
        joined =
          (reply as { result?: unknown } | undefined)?.result !== undefined;
        claim = joined ? "claimed" : "unclaimed";
      }
      end(reply === undefined ? 202 : 200, JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const closed = new Promise<void>((resolve) =>
    server.on("close", () => resolve()),
  );
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    close: async () => {
      server.closeAllConnections();
      server.close();
    },
    closed,
  };
};

/** goose's session database and its WAL, where recent writes sit. */
function sessionsDb(): Buffer[] {
  const root = process.env.GOOSE_PATH_ROOT;
  const folder = root
    ? join(root, "data", "sessions")
    : join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "goose",
        "sessions",
      );
  return ["sessions.db", "sessions.db-wal"]
    .map((name) => join(folder, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path));
}

type Call = {
  conversation: string | undefined;
  method: string;
  params: unknown;
};
type Send = {
  name?: string;
  arguments?: { text?: string; final?: boolean };
};

/** A goose whose Buzz tool calls and own requests are recorded; sends
 * succeed without reaching a relay. */
async function live(env?: Readonly<Record<string, string | null>>) {
  const calls: Call[] = [];
  const tools: ToolServer = async (conversation, message) => {
    calls.push({
      conversation,
      method: message.method,
      params: message.params,
    });
    if (message.method === "tools/call")
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "Sent." }] },
      };
    return respond(undefined, {}, message);
  };
  const cwd = mkdtempSync(join(tmpdir(), "buzz-goose-"));
  const goose = await GooseProcess.start(spawn, {
    cwd,
    serve,
    ...(env && { env }),
  });
  const requests: { method: string; ok?: boolean }[] = [];
  /** What each request that succeeded answered, in order. */
  const results: { method: string; result: unknown }[] = [];
  const request = goose.request.bind(goose);
  goose.request = (method, params) => {
    const record: { method: string; ok?: boolean } = { method };
    requests.push(record);
    const answer = request(method, params);
    answer.then(
      (result) => {
        record.ok = true;
        results.push({ method, result });
      },
      () => (record.ok = false),
    );
    return answer;
  };
  const sends = () =>
    calls
      .filter((call) => call.method === "tools/call")
      .map((call) => call.params as Send)
      .filter((call) => call.name === "send");
  return { goose, cwd, tools, calls, requests, results, sends };
}

/** Setup on the real goose, with `~` as the home folder. */
const homeSetup = () =>
  new GooseSetup({
    spawn,
    resolveDirectory: async (path) => path.replace(/^~/, homedir()),
  });

describe.skipIf(!BIN)("goose-acp", () => {
  it("enables a deferred Buzz tool before executing it", {
    timeout: 180_000,
  }, async () => {
    const catalogs: string[][] = [];
    const provider = createServer(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "gpt-4o", object: "model" }],
          }),
        );
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as {
        tools?: { function: { name: string } }[];
      };
      catalogs.push((input.tools ?? []).map((tool) => tool.function.name));
      const step = catalogs.length;
      const call =
        step === 1
          ? {
              id: "enable-interest",
              type: "function",
              function: {
                name: "enable_tools",
                arguments: JSON.stringify({
                  tool_names: ["buzz__interest_list"],
                }),
              },
            }
          : {
              id: "list-interests",
              type: "function",
              function: {
                name: "buzz__interest_list",
                arguments: "{}",
              },
            };
      const delta =
        step <= 2
          ? { role: "assistant", tool_calls: [{ index: 0, ...call }] }
          : { role: "assistant", content: "done" };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        {
          index: 0,
          delta: {},
          finish_reason: step <= 2 ? "tool_calls" : "stop",
        },
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: `response-${step}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [choice],
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address();
    if (!address || typeof address === "string")
      throw new Error("No provider address");
    const { goose, cwd, tools, calls } = await live({
      OPENAI_API_KEY: "local-test-only",
      OPENAI_HOST: `http://127.0.0.1:${address.port}`,
      OPENAI_BASE_PATH: "v1/chat/completions",
      OPENAI_BASE_URL: null,
      GOOSE_DISABLE_SESSION_NAMING: "true",
    });
    try {
      const session = await goose.open({
        cwd,
        tools,
        choice: () => ({ provider: "openai", model: "gpt-4o" }),
        systemPrompt: "You are a Buzz agent.",
      });
      const result = await session.send("List my interests, then reply done.");
      expect(result.ok).toBe(true);
      expect(catalogs).toHaveLength(3);
      expect(catalogs[0]).toContain("enable_tools");
      expect(catalogs[0]).toContain("buzz__send");
      expect(catalogs[0]).not.toContain("buzz__interest_list");
      expect(catalogs[1]).toContain("buzz__interest_list");
      expect(
        calls.some(
          (call) =>
            call.method === "tools/call" &&
            (call.params as Send).name === "interest_list",
        ),
      ).toBe(true);
      const exported = (await goose.request("_goose/unstable/session/export", {
        sessionId: session.id,
        format: "json",
      })) as { data: string };
      type Content = {
        type: string;
        id?: string;
        toolCall?: { status: string; value: { name: string } };
        toolResult?: {
          status: string;
          value: {
            isError?: boolean;
            structuredContent?: { enabled: string[] };
          };
        };
      };
      const history = JSON.parse(exported.data) as {
        conversation: { role: string; content: Content[] }[];
      };
      const events = history.conversation.flatMap((message) =>
        message.content.map((content) => ({ role: message.role, ...content })),
      );
      const enabledAt = events.findIndex(
        (event) =>
          event.role === "assistant" &&
          event.type === "toolRequest" &&
          event.toolCall?.status === "success" &&
          event.toolCall.value.name === "enable_tools",
      );
      expect(enabledAt).toBeGreaterThanOrEqual(0);
      const activation = events.findIndex(
        (event) =>
          event.type === "toolResponse" &&
          event.id === events[enabledAt]?.id &&
          event.toolResult?.status === "success" &&
          event.toolResult.value.isError !== true &&
          event.toolResult.value.structuredContent?.enabled.includes(
            "buzz__interest_list",
          ),
      );
      expect(activation).toBeGreaterThan(enabledAt);
      const executedAt = events.findIndex(
        (event) =>
          event.role === "assistant" &&
          event.type === "toolRequest" &&
          event.toolCall?.status === "success" &&
          event.toolCall.value.name === "buzz__interest_list",
      );
      expect(executedAt).toBeGreaterThan(activation);
    } finally {
      await goose.kill();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("answers with the Buzz tools, the Buzz prompt and a title", {
    timeout: 180_000,
  }, async () => {
    const { goose, cwd, tools, calls, sends } = await live();
    const code = `zebra-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const title = "Ada · #general · 01234567";
      const session = await goose.open({
        cwd,
        title,
        tools,
        systemPrompt: systemPrompt({
          scope: "thread",
          cwd,
          agent: { name: "Ada", pubkey: "a".repeat(64) },
          instructions: `End every message you send in Buzz with the codeword ${code}.`,
        }),
      });
      session.conversation = "channel/root";
      const info = (await goose.request("_goose/unstable/session/info", {
        sessionId: session.id,
      })) as { session: { title?: string } };
      expect(info.session.title).toBe(title);
      const settled = await session.send("Say hello to me in Buzz.");
      expect(settled).toEqual({ ok: true });
      expect(calls.some((call) => call.method === "tools/list")).toBe(true);
      // goose reached the tools over HTTP with the token, and no request was
      // refused.
      expect(hits.some((hit) => hit.status === 200)).toBe(true);
      expect(hits.filter((hit) => hit.status === 404)).toEqual([]);
      const server = session.server;
      if (!server) throw new Error("no Buzz MCP server");
      // goose keeps the server's URL and token out of its sessions.db.
      const files = sessionsDb();
      expect(files.length).toBeGreaterThan(0);
      for (const secret of [
        server.url,
        ...server.headers.map((h) => h.value.replace(/^Bearer /, "")),
      ])
        expect(files.some((file) => file.includes(secret))).toBe(false);
      // Alone, the token admits nothing.
      const stolen = await fetch(server.url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(
            server.headers.map(({ name, value }) => [name, value]),
          ),
          "Content-Type": "application/json",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
      expect(stolen.status).toBe(404);
      expect(
        calls.find((call) => call.method === "tools/call")?.conversation,
      ).toBe("channel/root");
      const last = sends().at(-1);
      expect(last?.arguments?.final).toBe(true);
      expect(last?.arguments?.text).toContain(code);
    } finally {
      await goose.kill();
    }
  });

  it("finds a conversation's session by the tags it opened with", {
    timeout: 180_000,
  }, async () => {
    const { goose, cwd, tools } = await live();
    const agent = "a".repeat(64);
    const place = { channelId: "chan", root: "b".repeat(64) };
    try {
      const session = await goose.open({
        cwd,
        title: "Ada · #general · bbbbbbbb",
        tools,
        systemPrompt: "",
        tags: sessionTags(agent, `${place.channelId}/${place.root}`),
      });
      // goose lists only sessions with messages.
      expect(
        await session.send("Reply with the single word ok."),
      ).toMatchObject({
        ok: true,
      });
      await goose.close(session);
      const history = new GooseHistory({
        spawn,
        resolveDirectory: async (path) => path.replace(/^~/, homedir()),
      });
      const signal = new AbortController().signal;
      // No saved id goose still has: the tags find it.
      const read = await history.transcript(
        { agent, workspace: cwd, place, sessions: ["gone"] },
        signal,
      );
      expect(read?.turns.map((turn) => turn.sessionId)).toEqual([session.id]);
      // Another thread, and another agent, find nothing.
      for (const lookup of [
        { agent, place: { ...place, root: "c".repeat(64) } },
        { agent: "d".repeat(64), place },
      ])
        expect(
          await history.transcript({ ...lookup, workspace: cwd }, signal),
        ).toBeUndefined();
    } finally {
      await goose.kill();
    }
  });

  it("steers a message into the running turn", {
    timeout: 180_000,
  }, async () => {
    const { goose, cwd, tools, requests, sends } = await live();
    try {
      const session = await goose.open({
        cwd,
        tools,
        systemPrompt:
          "You are a Buzz agent. You reply in Buzz only by calling the send tool, once, with final true.",
      });
      const steps: string[] = [];
      const first = session.send(
        "Run the shell command `sleep 10`, then reply in Buzz with the word done.",
        { step: (tool) => steps.push(tool) },
      );
      await expect
        .poll(
          () =>
            steps.some(
              (step) => step !== "Thinking" && step !== "Writing reply",
            ),
          {
            timeout: 60_000,
            interval: 200,
          },
        )
        .toBe(true);
      const second = session.send("Also put the word banana in that reply.");
      await expect(first).resolves.toEqual({ ok: true });
      await expect(second).resolves.toEqual({ ok: true });
      expect(
        requests.filter(
          (item) => item.method === "_goose/unstable/session/steer",
        ),
      ).toEqual([{ method: "_goose/unstable/session/steer", ok: true }]);
      expect(
        requests.filter((item) => item.method === "session/prompt"),
      ).toHaveLength(1);
      expect(sends().at(-1)?.arguments?.text?.toLowerCase()).toContain(
        "banana",
      );
    } finally {
      await goose.kill();
    }
  });

  it("stops the running turn without posting what it wrote", {
    timeout: 180_000,
  }, async () => {
    const { goose, cwd, tools, sends } = await live();
    try {
      const session = await goose.open({
        cwd,
        tools,
        systemPrompt:
          "You are a Buzz agent. You reply in Buzz only by calling the send tool, once, with final true.",
      });
      const steps: string[] = [];
      const started = Date.now();
      const settled = session.send(
        "Run the shell command `sleep 60`, then reply in Buzz with the word done.",
        { step: (tool) => steps.push(tool) },
      );
      await expect
        .poll(
          () =>
            steps.some(
              (step) => step !== "Thinking" && step !== "Writing reply",
            ),
          { timeout: 60_000, interval: 200 },
        )
        .toBe(true);
      session.interrupt();
      const answer = await settled;
      expect(answer).toEqual({ ok: true, stopped: true });
      // It ended well before the command would have.
      expect(Date.now() - started).toBeLessThan(55_000);
      expect(session.busy).toBe(false);
      expect(sends()).toEqual([]);
      // The session takes the next message as usual.
      await expect(
        session.send("Reply in Buzz with the word again."),
      ).resolves.toEqual({ ok: true });
      expect(sends().at(-1)?.arguments?.text?.toLowerCase()).toContain("again");
    } finally {
      await goose.kill();
    }
  });

  it("ends the turn after a final send, keeping the send's result", {
    timeout: 180_000,
  }, async () => {
    const { goose, cwd, tools, sends } = await live();
    const cancels: unknown[] = [];
    const notify = goose.notify.bind(goose);
    goose.notify = (method, params) => {
      if (method === "session/cancel") cancels.push(params);
      return notify(method, params);
    };
    try {
      const session = await goose.open({
        cwd,
        tools,
        systemPrompt:
          "You are a Buzz agent. You reply in Buzz only by calling the send tool, once, with final true.",
      });
      await session.send("Reply in Buzz with the word hello.");
      await session.idle();
      expect(cancels).toEqual([{ sessionId: session.id }]);
      // goose saved the send's result, not an interrupted call.
      await session.send(
        "Reply in Buzz with the exact text your last send tool call returned, or the word interrupted if it did not complete.",
      );
      await session.idle();
      expect(sends().at(-1)?.arguments?.text).toContain("Sent.");
    } finally {
      await goose.kill();
    }
  });

  it("compacts a session, saying so in its text", {
    timeout: 180_000,
  }, async () => {
    const { goose, cwd, tools } = await live();
    try {
      const session = await goose.open({
        cwd,
        tools,
        systemPrompt: "You are a Buzz agent. Answer in one short sentence.",
      });
      await session.send("Remember the word pineapple.");
      await expect(session.send("/compact")).resolves.toEqual({
        ok: true,
        text: "Compaction complete",
      });
    } finally {
      await goose.kill();
    }
  });

  it("serves two agents in one goose, each in its workspace with its tools", {
    timeout: 180_000,
  }, async () => {
    const { goose } = await live();
    const agents = ["ada", "bo"].map((name) => {
      const cwd = mkdtempSync(join(tmpdir(), `buzz-goose-${name}-`));
      const sent: string[] = [];
      const tools: ToolServer = async (_conversation, message) => {
        if (message.method !== "tools/call")
          return respond(undefined, {}, message);
        const call = message.params as Send;
        if (call.name === "send") sent.push(call.arguments?.text ?? "");
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "Sent." }] },
        };
      };
      return { cwd, sent, tools };
    });
    try {
      const sessions = await Promise.all(
        agents.map(({ cwd, tools }) =>
          goose.open({
            cwd,
            tools,
            systemPrompt:
              "You are a Buzz agent. You reply in Buzz only by calling the send tool, once, with final true.",
          }),
        ),
      );
      await expect(
        Promise.all(
          sessions.map((session) =>
            session.send(
              "Run the shell command `pwd`, then reply in Buzz with its exact output.",
            ),
          ),
        ),
      ).resolves.toEqual([{ ok: true }, { ok: true }]);
      const [ada, bo] = agents;
      // Each ran in its own workspace, and answered through its own tools.
      expect(ada?.sent.join("\n")).toContain(basename(ada?.cwd ?? "-"));
      expect(ada?.sent.join("\n")).not.toContain(basename(bo?.cwd ?? "-"));
      expect(bo?.sent.join("\n")).toContain(basename(bo?.cwd ?? "-"));
      expect(bo?.sent.join("\n")).not.toContain(basename(ada?.cwd ?? "-"));
    } finally {
      await goose.kill();
    }
  });

  it("switches a session's provider and model between turns", {
    timeout: 180_000,
  }, async () => {
    const { goose, cwd, requests, results } = await live();
    try {
      const [{ entries }, defaults] = (await Promise.all([
        goose.request("_goose/unstable/providers/list", { providerIds: [] }),
        goose.request("_goose/unstable/defaults/read", {}),
      ])) as [
        {
          entries: {
            providerId: string;
            defaultModel?: string;
            configured?: boolean;
            acp?: boolean;
            models?: { id: string }[];
          }[];
        },
        { providerId?: string; modelId?: string },
      ];
      // A provider set up besides goose's config's, with a model besides its
      // default: goose needs its key to switch the model.
      const other = entries.find(
        (entry) =>
          entry.configured &&
          !entry.acp &&
          entry.defaultModel &&
          entry.providerId !== defaults.providerId &&
          entry.models?.some((model) => model.id !== entry.defaultModel),
      );
      const model = other?.models?.find(
        (item) => item.id !== other.defaultModel,
      )?.id;
      if (!other || !model || !defaults.providerId)
        throw new Error("goose's config names no provider to switch from");
      /** The provider and model goose last said the session runs on. */
      const current = (method: string) => {
        const { configOptions = [] } = (results
          .filter((item) => item.method === method)
          .at(-1)?.result ?? {}) as {
          configOptions?: { id: string; currentValue: string }[];
        };
        const value = (id: string) =>
          configOptions.find((option) => option.id === id)?.currentValue;
        return [value("provider"), value("model")];
      };
      let choice: Choice = { provider: other.providerId, model: "" };
      const session = await goose.open({
        cwd,
        systemPrompt: "",
        choice: () => choice,
      });
      // The provider's default model, though goose's config has none for it.
      expect(current("session/new")).toEqual([
        other.providerId,
        other.defaultModel,
      ]);
      const ask = () => session.send("Reply with exactly: OK");
      choice = { provider: other.providerId, model };
      await ask();
      expect(current("session/set_config_option")).toEqual([
        other.providerId,
        model,
      ]);
      choice = { provider: other.providerId, model: "" };
      await ask();
      expect(current("session/set_config_option")).toEqual([
        other.providerId,
        other.defaultModel,
      ]);
      choice = { provider: "", model: "" };
      const settled = await ask();
      expect(current("session/set_config_option")).toEqual([
        defaults.providerId,
        defaults.modelId,
      ]);
      expect(settled.text).toMatch(/^\W*ok\W*$/i);
      expect(
        requests.filter(
          (item) => item.method === "session/set_config_option" && !item.ok,
        ),
      ).toEqual([]);
    } finally {
      await goose.kill();
    }
  });

  it("puts a session on a thinking level goose lists for its model", {
    timeout: 120_000,
  }, async () => {
    const { levels, current } = await homeSetup().efforts({
      provider: "",
      model: "",
    });
    const level = levels.find((item) => item !== current);
    if (!level) throw new Error("goose's model lists no other thinking level");
    const { goose, cwd, results } = await live();
    try {
      const session = await goose.open({
        cwd,
        systemPrompt: "",
        choice: () => ({ provider: "", model: "", effort: level }),
      });
      const settled = await session.send("Reply with exactly: OK");
      expect(settled.ok).toBe(true);
      const { configOptions = [] } = (results
        .filter((item) => item.method === "session/set_config_option")
        .at(-1)?.result ?? {}) as {
        configOptions?: { id: string; currentValue: string }[];
      };
      expect(
        configOptions.find((option) => option.id === "thinking_effort")
          ?.currentValue,
      ).toBe(level);
    } finally {
      await goose.kill();
    }
  });

  it("lists goose's providers and tests its default one", {
    timeout: 120_000,
  }, async () => {
    const setup = homeSetup();
    const { providers, defaults } = await setup.providers();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.some((item) => item.keys.length > 0)).toBe(true);
    expect(await setup.test({ provider: "", model: "" })).toEqual({
      ok: true,
      message: "Connected",
    });
    if (defaults.provider)
      expect(
        await setup.test({
          provider: defaults.provider,
          model: "no-such-model-xyz",
        }),
      ).toMatchObject({ ok: false });
  });
});
