// Which developer instructions a resumed Codex thread runs on. Real Codex
// app-server, disposable home, synthetic sign-in and a loopback model that
// records what it is sent; no external model or relay.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await realpath(
  await mkdtemp(join(tmpdir(), "buzz-codex-resume-")),
);
/** The body of each request Codex made to the model, oldest first. */
const asked = [];
const model = createServer((request, response) => {
  let body = "";
  request.on("data", (data) => {
    body += data;
  });
  request.on("end", () => {
    asked.push(body);
    const item = {
      type: "message",
      id: "fixture-message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done.", annotations: [] }],
    };
    const result = {
      id: "fixture-response",
      object: "response",
      created_at: 1,
      model: "fixture-model",
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      {
        type: "response.created",
        response: { ...result, status: "in_progress", output: [] },
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result },
    ])
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
});
const servers = new Set();
/** A Codex app-server on the disposable home, as a JSONL request client. */
function open() {
  const child = spawn("codex", ["app-server"], {
    env: { ...process.env, HOME: root, CODEX_HOME: root },
    stdio: ["pipe", "pipe", "inherit"],
  });
  servers.add(child);
  const waiting = new Map();
  const listeners = new Set();
  let buffer = "";
  let next = 0;
  child.stdout.on("data", (data) => {
    buffer += data;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const wire = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (wire.id != null && !wire.method) {
        const { resolve, reject } = waiting.get(wire.id) ?? {};
        waiting.delete(wire.id);
        if (wire.error) reject?.(new Error(wire.error.message));
        else resolve?.(wire.result);
      } else for (const listener of listeners) listener(wire);
    }
  });
  const send = (wire) => child.stdin.write(`${JSON.stringify(wire)}\n`);
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      send({ id, method, params });
    });
  return {
    request,
    async initialize() {
      await request("initialize", {
        clientInfo: { name: "buzz_resume_check", title: "Buzz", version: "0" },
        capabilities: { experimentalApi: true },
      });
      send({ method: "initialized" });
      return this;
    },
    /** One completed turn; returns the request the model got for it. */
    async turn(threadId, text) {
      const before = asked.length;
      const completed = new Promise((resolve) => {
        const listener = (wire) => {
          if (
            wire.method === "turn/completed" &&
            wire.params.threadId === threadId
          ) {
            listeners.delete(listener);
            resolve(wire.params.turn);
          }
        };
        listeners.add(listener);
      });
      await request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      assert.equal((await completed).status, "completed");
      return asked.slice(before).join("\n");
    },
    close() {
      servers.delete(child);
      child.kill("SIGKILL");
    },
  };
}

const MARKS = ["BUZZ-START", "BUZZ-JOINED", "BUZZ-RELEASED", "BUZZ-RESTARTED"];
const seen = (body) => MARKS.filter((mark) => body.includes(mark)).join(" + ");
try {
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(root, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "synthetic-resume-fixture" }),
  );
  await writeFile(
    join(root, "config.toml"),
    `[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
`,
  );
  const thread = (developerInstructions) => ({
    cwd: root,
    model: "fixture-model",
    modelProvider: "fixture",
    approvalPolicy: "never",
    developerInstructions,
  });
  const first = await open().initialize();
  const { thread: started } = await first.request(
    "thread/start",
    thread(MARKS[0]),
  );
  const id = started.id;
  const results = [["thread/start", seen(await first.turn(id, "one"))]];
  assert.equal(results[0][1], MARKS[0]);
  // As a voice seat does: the client is still subscribed to the thread.
  await first.request("thread/resume", { ...thread(MARKS[1]), threadId: id });
  results.push([
    "thread/resume while subscribed",
    seen(await first.turn(id, "two")),
  ]);
  // As a text turn does: the subscription is released first.
  await first.request("thread/unsubscribe", { threadId: id });
  await first.request("thread/resume", { ...thread(MARKS[2]), threadId: id });
  results.push([
    "thread/resume after thread/unsubscribe",
    seen(await first.turn(id, "three")),
  ]);
  first.close();
  const second = await open().initialize();
  await second.request("thread/resume", { ...thread(MARKS[3]), threadId: id });
  results.push([
    "thread/resume in a new app-server",
    seen(await second.turn(id, "four")),
  ]);
  second.close();
  for (const [step, marks] of results)
    console.log(`${step}: the model was sent ${marks || "no instructions"}`);
  console.log(
    "PASS: every turn completed; local fixture model only; no external model or relay calls",
  );
} finally {
  for (const child of servers) child.kill("SIGKILL");
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
