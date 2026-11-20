// Opt-in real Codex acceptance. Disposable workspace, simulated relay, no messages sent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "rolldown";
import { JSDOM } from "jsdom";
globalThis.document = new JSDOM("").window.document;

const workspace = await mkdtemp(join(tmpdir(), "buzz-codex-agents-"));
await build({
  input: {
    runtime: new URL("./runtime.ts", import.meta.url).pathname,
    rpc: new URL("./rpc.ts", import.meta.url).pathname,
    reads: new URL("../../features/agents/reads.ts", import.meta.url).pathname,
    core: new URL("../../features/agents/core-memory-cache.ts", import.meta.url)
      .pathname,
  },
  output: { dir: workspace, entryFileNames: "[name].mjs", format: "esm" },
  transform: { define: { "import.meta.env": "{}" } },
  // As Vite does, `?raw` imports a file's text.
  plugins: [
    {
      name: "raw",
      load: async (id) =>
        id.endsWith("?raw")
          ? `export default ${JSON.stringify(await readFile(id.slice(0, -4), "utf8"))};`
          : id.includes("?url")
            ? `export default ${JSON.stringify(id.slice(0, id.indexOf("?")))};`
            : null,
    },
  ],
});
const { CodexRuntime } = await import(join(workspace, "runtime.mjs"));
const { AppServer, listModels } = await import(join(workspace, "rpc.mjs"));
const { ownerReads } = await import(join(workspace, "reads.mjs"));
const { CoreMemoryCache } = await import(join(workspace, "core.mjs"));
const children = new Set();
const notices = [];
let servers = 0;
const sent = [];
let acceptedSteers = 0;
const nativeSpawn = async (_id, options = {}) => {
  // This harness runs Codex in the user's own home: no thread to copy there.
  if (_id === "adopt")
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: Promise.resolve(0),
    };
  if (_id === "read") {
    const child = spawn("base64", ["-i", ...(options.args ?? [])], {
      cwd: options.cwd,
    });
    children.add(child);
    child.stdout.on("data", (data) => options.onStdout?.(String(data)));
    child.stderr.on("data", (data) => options.onStderr?.(String(data)));
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        children.delete(child);
        resolve(code);
      });
    });
    return {
      write: async () => {},
      end: async () => child.stdin.end(),
      kill: async () => {
        child.kill("SIGKILL");
      },
      exited,
    };
  }
  servers++;
  const child = spawn(
    "codex",
    [
      "app-server",
      "-c",
      "include_collaboration_mode_instructions=false",
      "-c",
      'web_search="live"',
      "-c",
      `mcp_servers={"fixture.tools"={command="sh",args=["-c",${JSON.stringify(`touch '${join(workspace, "mcp-must-not-start")}'`)}]}}`,
    ],
    {
      // Like the desktop host, expand ~ in a process's working directory.
      cwd: options.cwd?.replace(/^~(?=\/|$)/, homedir()),
      detached: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("BUZZ_") && !key.startsWith("NOSTR_"),
        ),
      ),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(child);
  let buffer = "";
  const requests = new Map();
  child.stdout.on("data", (data) => {
    buffer += data;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const wire = JSON.parse(line);
      if (
        wire.id != null &&
        !wire.method &&
        requests.get(wire.id) === "turn/steer" &&
        !wire.error
      )
        acceptedSteers++;
      // Never retain config/read values, which can contain local credentials.
      if (wire.method) notices.push(wire);
      options.onStdout?.(`${line}\n`);
    }
  });
  child.stderr.on("data", (data) => options.onStderr?.(String(data)));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  return {
    write(data) {
      const wire = JSON.parse(data);
      if (wire.id != null) requests.set(wire.id, wire.method);
      if (wire.method)
        sent.push({ method: wire.method, threadId: wire.params?.threadId });
      return new Promise((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      );
    },
    end: async () => child.stdin.end(),
    kill: async () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    },
    exited,
  };
};
const owner = "a".repeat(64);
const pubkey = "b".repeat(64);
const root = "c".repeat(64);
const published = [];
const events = [];
const memories = [];
const uploads = [];
const storage = new Map();
// Agent storage (features/agents/store.ts `AgentStore`): each write settles
// once saved, as the app's file-backed store does.
const store = {
  keys: () => [...storage.keys()],
  read: async (key) => storage.get(key) ?? null,
  scan: async (prefix) =>
    Object.fromEntries([...storage].filter(([key]) => key.startsWith(prefix))),
  get: (key) => storage.get(key) ?? null,
  set: async (key, value) => {
    if (value === null) storage.delete(key);
    else storage.set(key, value);
  },
  add: async (key, value) => {
    const held = storage.get(key);
    if (held !== undefined) return held;
    storage.set(key, value);
    return value;
  },
};
const scope = "local-acceptance";
const relay = {
  snapshot: () => ({
    status: "ready",
    viewer: owner,
    scope,
    session: {
      channelWrites: { startingCanvas: () => undefined },
      profiles: { ensure: async () => {}, snapshot: () => new Map() },
      names: { resolve: () => undefined },
      agentMemories: {
        read: async () => ({ entries: memories, partial: false }),
        open: () => ({
          refresh: async () => {},
          snapshot: () => ({
            status: "ready",
            listing: { entries: memories, partial: false },
          }),
          dispose() {},
        }),
      },
      channels: {
        list: () => ({
          status: "ready",
          channels: [
            { id: "test-channel", name: "codex-test", channelType: "stream" },
            { id: "other-channel", name: "codex-other", channelType: "stream" },
            {
              id: "solo",
              name: "codex-solo",
              channelType: "solo",
              private: true,
            },
          ],
        }),
      },
      read: async (filters) =>
        filters[0]?.kinds?.includes(9)
          ? [
              {
                id: "e".repeat(64),
                kind: 9,
                pubkey: owner,
                created_at: 1,
                tags: [
                  ["h", "test-channel"],
                  ["e", root, "", "reply"],
                ],
                content:
                  "Context-only fact: the verification word is APRICOT_927.",
              },
            ]
          : [],
    },
  }),
};
const coreMemory = new CoreMemoryCache((key) => ownerReads(relay, key));
const runtime = new CodexRuntime(
  nativeSpawn,
  (key) => ownerReads(relay, key),
  (key, signal) => coreMemory.core(key, signal),
  store,
);
runtime.sync([{ key: pubkey, pubkey }], scope);
let id = 0;
const delivery = (content) => {
  const result = {
    trigger: {
      type: "mention",
      event: {
        id: (++id).toString(16).padStart(64, "0"),
        pubkey: owner,
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        content,
        tags: [
          ["h", "test-channel"],
          ["e", root, "", "reply"],
        ],
      },
    },
    channelId: "test-channel",
    agent: {
      key: pubkey,
      pubkey,
      owner,
      name: "Codex",
      query: async (filters) =>
        events.filter((event) =>
          filters.some(
            (filter) =>
              filter.ids?.includes(event.id) ||
              filter["#e"]?.some((id) =>
                event.tags.some((tag) => tag[0] === "e" && tag[1] === id),
              ),
          ),
        ),
      remember: async (slug, body, after) => {
        const index = memories.findIndex((memory) => memory.slug === slug);
        if (index >= 0) memories.splice(index, 1);
        memories.push({ slug, body, createdAt: after + 1 });
      },
      upload: async (data, type) => {
        uploads.push({ data, type });
        return {
          url: "https://files.test/image.jpg",
          sha256: "d".repeat(64),
          size: Buffer.from(data, "base64").length,
          type,
        };
      },
      publish: async (event) => {
        published.push(event);
        return { ...event, id: "f".repeat(64) };
      },
    },
    config: {
      workspace,
      model: process.env.BUZZ_CODEX_TEST_MODEL ?? "gpt-5.6-luna",
      effort: "low",
      instructions:
        "Follow the test request exactly. Explicit file gates are acceptance fixtures. Do not delegate. During this acceptance test do not post progress. Post one completed answer per request with buzz.send and final:true.",
    },
    signal: new AbortController().signal,
    workingUntil: () => {},
    current: () => true,
  };
  events.push(result.trigger.event);
  return result;
};
async function condition(test, description) {
  const deadline = Date.now() + 180_000;
  while (!(await test())) {
    const failure = published.find((event) =>
      event.content.startsWith("Codex could not finish:"),
    );
    if (failure) throw new Error(failure.content);
    if (Date.now() > deadline)
      throw new Error(
        `Timed out: ${description}; ${JSON.stringify(runtime.sessions(pubkey))}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const exists = (name) =>
  access(join(workspace, name)).then(
    () => true,
    () => false,
  );
const binding = () => Object.values(JSON.parse([...storage.values()][0]))[0];
let inspect;
let communityRuntime;
try {
  if (process.env.BUZZ_CODEX_COMMUNITY_ONLY === "1") {
    inspect = await new AppServer().open(nativeSpawn);
    const models = await listModels(inspect);
    const model =
      process.env.BUZZ_CODEX_TEST_MODEL ??
      models.find((model) => model.isDefault)?.model;
    assert(model, "Codex must recommend a model");
    await inspect.close();
    inspect = undefined;
    const token = `COMMUNITY_${crypto.randomUUID().replaceAll("-", "")}`;
    const shared = (text, channel = "test-channel") => {
      const d = delivery(text);
      d.channelId = channel;
      d.config = { ...d.config, scope: "community", model };
      d.trigger.event.tags = [
        ["h", channel],
        ["e", root, "", "reply"],
      ];
      return d;
    };
    const answered = async (runner, d) => {
      const count = published.length;
      await runner.run(d);
      await condition(
        () =>
          published.length === count + 1 &&
          runner.sessions(d.agent.key)[0]?.status === "Idle",
        "community reply",
      );
      return published.at(-1);
    };
    const stored = await answered(
      runtime,
      shared(
        `Remember the synthetic shared recall marker ${token} for this acceptance test. It is intended to be recalled across this agent's community conversations. Reply exactly STORED. Do not write it to disk or memory. Use only buzz.send.`,
      ),
    );
    assert.match(stored.content, /STORED/);
    const initial = runtime.conversations(pubkey)[0].threadId;
    const across = await answered(
      runtime,
      shared(
        "Reply with the shared acceptance marker I gave you. Use only buzz.send; do not read files, memory or previous relay messages.",
        "other-channel",
      ),
    );
    assert(across.content.includes(token), across.content);
    assert(
      across.tags.some(
        ([name, value]) => name === "h" && value === "other-channel",
      ),
    );
    assert.equal(runtime.conversations(pubkey)[0].threadId, initial);
    const first = shared(
      "Start a shell with yield_time_ms 1000. Run: touch community-started; while [ ! -f community-release ]; do sleep 0.1; done. If the shell is still running, poll it with write_stdin and yield_time_ms 1000. When it finishes, send CHANNEL_DONE to this request's thread.",
    );
    first.config.instructions =
      "During this test a new request may arrive while you work. Use buzz.send with the named request ID for each reply. Answer a steering question immediately with final false and continue the first request. Finish the original work with final true.";
    await runtime.run(first);
    try {
      await condition(
        () => exists("community-started"),
        "community shell started",
      );
      const before = acceptedSteers;
      const solo = shared(
        "Quick question: reply SOLO_NOW here with a non-final Buzz send and then continue the earlier task.",
        "solo",
      );
      await runtime.run(solo);
      await condition(
        () => acceptedSteers > before,
        "Community Solo steer accepted",
      );
      await condition(
        () => published.some((event) => event.content === "SOLO_NOW"),
        "Solo answer while the channel task is still running",
      );
      const quick = published.find((event) => event.content === "SOLO_NOW");
      assert.deepEqual(quick.tags, [
        ["h", "solo"],
        ["buzz:request", solo.trigger.event.id],
      ]);
      assert.equal(await exists("community-release"), false);
    } finally {
      await writeFile(join(workspace, "community-release"), "go");
    }
    await condition(
      () =>
        published.some((event) => event.content === "CHANNEL_DONE") &&
        runtime.sessions(pubkey)[0]?.status === "Idle",
      "original channel task completed",
    );
    const original = published.find(
      (event) => event.content === "CHANNEL_DONE",
    );
    assert.deepEqual(original.tags, [
      ["h", "test-channel"],
      ["e", root, "", "reply"],
      ["buzz:request", first.trigger.event.id],
    ]);
    console.log(
      "PASS Community Solo steering and explicit replies during a live channel turn",
    );
    runtime.dispose();
    await condition(() => children.size === 0, "community runtime shutdown");
    communityRuntime = new CodexRuntime(
      nativeSpawn,
      (key) => ownerReads(relay, key),
      (key, signal) => coreMemory.core(key, signal),
      store,
    );
    const restored = await answered(
      communityRuntime,
      shared(
        "Reply with the shared acceptance marker from this session. Use only buzz.send and do not read files, memory or relay history.",
        "solo",
      ),
    );
    assert(restored.content.includes(token), restored.content);
    assert(!restored.tags.some(([name]) => name === "e"));
    assert.equal(communityRuntime.conversations(pubkey)[0].threadId, initial);
    const isolated = shared(
      "Reply exactly NO_PRIVATE_CONTEXT if this is our first conversation. Use only buzz.send.",
    );
    isolated.agent = { ...isolated.agent, key: `${pubkey}@other.example` };
    const separate = await answered(communityRuntime, isolated);
    assert(separate.content.includes("NO_PRIVATE_CONTEXT"));
    assert(!separate.content.includes(token));
    assert.notEqual(
      communityRuntime.conversations(isolated.agent.key)[0].threadId,
      initial,
    );
    console.log(
      "PASS real Codex community session: cross-channel recall, reply routing, process restart, Solo recall and isolated community membership",
    );
  } else {
    console.log("Disposable workspace:", workspace);
    await runtime.run(
      delivery(
        'Run exactly: touch started; while [ ! -f release ]; do sleep 0.1; done; printf "tool-loop-ok\\n" > seed.txt; cat seed.txt . Afterward use your file edit tool to create original.txt containing ORIGINAL. Read back your files. This wait is an explicit fixture.',
      ),
    );
    await condition(() => exists("started"), "shell gate started");
    await runtime.run(
      delivery(
        "After the shell finishes, use your file editing tool to create steered.txt containing STEERED instead of original.txt. Reply STEERED_OK.",
      ),
    );
    await condition(() => acceptedSteers > 0, "ordinary mention steered");
    await writeFile(join(workspace, "release"), "go");
    await condition(
      () =>
        published.length === 1 &&
        runtime.sessions(pubkey)[0]?.status === "Idle",
      "steered reply",
    );
    await runtime.run(
      delivery(
        "Read seed.txt and steered.txt with a shell tool. Reply FOLLOW_UP_OK, their contents, and the history verification word. Do not edit files.",
      ),
    );
    await condition(
      () =>
        published.length === 2 &&
        runtime.sessions(pubkey)[0]?.status === "Idle",
      "idle follow-up reply",
    );
    assert.match(published[0].content, /STEERED_OK/);
    assert.match(published[1].content, /FOLLOW_UP_OK/);
    assert.match(published[1].content, /APRICOT_927/);
    assert.equal(
      (await readFile(join(workspace, "seed.txt"), "utf8")).trim(),
      "tool-loop-ok",
    );
    assert.equal(
      (await readFile(join(workspace, "steered.txt"), "utf8")).trim(),
      "STEERED",
    );
    assert.equal(await exists("original.txt"), false);
    const saved = binding();
    inspect = await new AppServer().open(nativeSpawn);
    const result = await inspect.request("thread/read", {
      threadId: saved.threadId,
      includeTurns: true,
    });
    // The title, then the conversation's tag (prompt.ts `sessionTag`).
    assert.match(
      result.thread.name,
      /^Buzz #codex-test · thread cccccccc · Codex · buzz:[0-9a-f]{16}$/,
    );
    const rollout = (await readFile(result.thread.path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    assert.match(
      rollout.find((row) => row.type === "session_meta").payload
        .base_instructions.text,
      /apply_patch|apply patch/i,
    );
    assert(
      rollout.some((row) => JSON.stringify(row).includes("<thread-context>")),
    );
    assert(
      !rollout.some(
        (row) =>
          row.type === "response_item" &&
          JSON.stringify(row.payload).includes("<turn_aborted>"),
      ),
    );
    assert(!sent.some((wire) => wire.method === "turn/interrupt"));
    await inspect.close();
    inspect = undefined;
    console.log(
      "PASS native coding prompt and tools, relay context, default steering, idle follow-up and persisted thread",
    );

    const updated = delivery(
      "Briefly acknowledge this request. No coding tools needed. Send the reply with buzz.send.",
    );
    updated.config.instructions =
      "Every final answer MUST contain INSTRUCTIONS_UPDATED. This replaces previous custom instructions.";
    await runtime.run(updated);
    await condition(
      () =>
        published.length === 3 &&
        runtime.sessions(pubkey)[0]?.status === "Idle",
      "edited instructions reply",
    );
    assert.match(published.at(-1).content, /INSTRUCTIONS_UPDATED/);
    const cleared = delivery(
      "Reply exactly SETTINGS_CLEARED. No coding tools needed. Send the reply with buzz.send.",
    );
    cleared.config.instructions = "";
    await runtime.run(cleared);
    await condition(
      () =>
        published.length === 4 &&
        runtime.sessions(pubkey)[0]?.status === "Idle",
      "cleared instructions reply",
    );
    assert.match(published.at(-1).content, /SETTINGS_CLEARED/);
    assert.doesNotMatch(published.at(-1).content, /INSTRUCTIONS_UPDATED/);
    assert.equal(binding().threadId, saved.threadId);
    assert.equal(await exists("mcp-must-not-start"), false);
    assert(!notices.some((wire) => wire.params?.item?.type === "mcpToolCall"));
    assert(!notices.some((wire) => wire.method === "item/agentMessage/delta"));
    assert(sent.some((wire) => wire.method === "thread/unsubscribe"));
    console.log(
      "PASS set and cleared instructions on resume, inherited MCP disabled, response deltas suppressed",
    );
    await runtime.run(
      delivery(
        "Run exactly: touch shutdown-started; while [ ! -f shutdown-release ]; do sleep 0.1; done; touch must-not-exist. Do not run other commands. This is an explicit process-shutdown fixture.",
      ),
    );
    await condition(() => exists("shutdown-started"), "shutdown shell started");
    runtime.dispose();
    await condition(() => children.size === 0, "app-server shutdown");
    await writeFile(
      join(workspace, "shutdown-release"),
      "released after shutdown",
    );
    await runtime.run(
      delivery(
        "Run test ! -e must-not-exist && cat seed.txt . Reply RECOVERED_OK. Do not execute previous requests or wait on gates.",
      ),
    );
    await condition(
      () =>
        published.length === 5 &&
        runtime.sessions(pubkey)[0]?.status === "Idle",
      "reopened reply",
    );
    assert.match(published.at(-1).content, /RECOVERED_OK/);
    assert.equal(await exists("must-not-exist"), false);
    assert.equal(binding().threadId, saved.threadId);
    console.log(
      "PASS process shutdown cleans shells and permits saved-session recovery",
    );
    runtime.dispose();
    await condition(() => children.size === 0, "recovered server shutdown");
    inspect = await new AppServer().open(nativeSpawn);
    const empty = await inspect.request("thread/start", {
      cwd: workspace,
      model: delivery("").config.model,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: {
        web_search: "disabled",
        mcp_servers: { "fixture.tools": { command: "sh", enabled: false } },
      },
    });
    await assert.rejects(
      inspect.request("thread/resume", {
        threadId: empty.thread.id,
        excludeTurns: true,
      }),
      { message: `no rollout found for thread id ${empty.thread.id}` },
    );
    await inspect.close();
    inspect = undefined;
    const [storageKey, bindings] = [...storage][0];
    const bindingKey = Object.keys(JSON.parse(bindings))[0];
    storage.set(
      storageKey,
      JSON.stringify({ [bindingKey]: { ...saved, threadId: empty.thread.id } }),
    );
    await runtime.run(
      delivery(
        "Reply exactly MISSING_THREAD_RECOVERED. No coding tools. Send the reply with buzz.send.",
      ),
    );
    await condition(
      () =>
        published.length === 6 &&
        runtime.sessions(pubkey)[0]?.status === "Idle",
      "missing-thread recovery reply",
    );
    assert.match(published.at(-1).content, /MISSING_THREAD_RECOVERED/);
    assert.notEqual(binding().threadId, empty.thread.id);
    console.log(
      "PASS missing saved thread recovers on the next ordinary mention",
    );
    await writeFile(
      join(workspace, "attachment.jpg"),
      new Uint8Array([255, 216, 255]),
    );
    await runtime.run(
      delivery(
        "Use buzz.read to read this thread. Use buzz.mem_set to save mem/test as DYNAMIC_MEMORY_927, then buzz.mem_get to read mem/test. Use buzz.send with path seed.txt, files [attachment.jpg], and final true. Do not use a shell to read these files.",
      ),
    );
    await condition(
      () =>
        published.length === 7 &&
        runtime.sessions(pubkey)[0]?.status === "Idle",
      "shared Buzz dynamic tools",
    );
    assert.match(published.at(-1).content, /tool-loop-ok/);
    assert.match(published.at(-1).content, /files.test/);
    assert.equal(
      memories.find((memory) => memory.slug === "mem/test")?.body,
      "DYNAMIC_MEMORY_927",
    );
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].type, "image/jpeg");
    const calls = notices.filter((wire) => wire.method === "item/tool/call");
    for (const tool of ["read", "mem_set", "mem_get", "send"])
      assert(
        calls.some(
          (wire) =>
            wire.params.namespace === "buzz" && wire.params.tool === tool,
        ),
      );
    assert.equal(published.length, 7);
    console.log(
      "PASS real dynamic callbacks, resumed tools, shared reads, memory, workspace file read/upload and final send without duplicate replies",
    );
    const other = "9".repeat(64);
    const otherWorkspace = await mkdtemp(join(tmpdir(), "buzz-codex-other-"));
    const otherPublished = [];
    runtime.sync([
      { key: pubkey, pubkey },
      { key: other, pubkey: other },
    ]);
    const before = servers;
    const first = delivery(
      "Reply exactly FIRST_AGENT_OK. No coding tools. Send the reply with buzz.send.",
    );
    const second = delivery(
      "Run pwd, then reply with its output. Send the reply with buzz.send.",
    );
    await runtime.run(first);
    await runtime.run({
      ...second,
      agent: {
        ...second.agent,
        key: other,
        pubkey: other,
        name: "Other",
        publish: async (event) => {
          otherPublished.push(event);
          return { ...event, id: "8".repeat(64) };
        },
      },
      config: {
        ...second.config,
        workspace: otherWorkspace,
        instructions: `${second.config.instructions} Every final answer MUST contain OTHER_AGENT.`,
      },
    });
    await condition(
      () =>
        published.length === 8 &&
        otherPublished.length === 1 &&
        runtime.sessions(pubkey)[0]?.status === "Idle" &&
        runtime.sessions(other)[0]?.status === "Idle",
      "two agents on one server",
    );
    // The previous step's server is still open and serves both agents.
    assert.equal(servers, before);
    assert.match(published.at(-1).content, /FIRST_AGENT_OK/);
    assert.doesNotMatch(published.at(-1).content, /OTHER_AGENT/);
    assert.match(otherPublished[0].content, /OTHER_AGENT/);
    assert(
      otherPublished[0].content.includes(otherWorkspace.split("/").at(-1)),
    );
    console.log(
      "PASS two agents share one server with their own workspace, instructions and replies",
    );
    const stops = [];
    const stopping = delivery(
      "Run exactly: touch stop-started; while [ ! -f stop-release ]; do sleep 0.1; done; touch must-not-finish . This wait is an explicit fixture. Then reply DONE.",
    );
    stopping.interruptible = (stop) => stops.push(stop);
    const beforeStop = published.length;
    await runtime.run(stopping);
    assert.equal(stops.length, 1);
    await condition(() => exists("stop-started"), "stop shell started");
    await stops[0]();
    await condition(
      () => runtime.sessions(pubkey)[0]?.status === "Stopped",
      "stopped turn",
    );
    await writeFile(join(workspace, "stop-release"), "go");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // The shell it waited on is gone, and nothing was posted for it.
    assert.equal(await exists("must-not-finish"), false);
    assert.equal(published.length, beforeStop);
    await runtime.run(
      delivery(
        "Reply exactly AFTER_STOP_OK. No coding tools. Send the reply with buzz.send.",
      ),
    );
    await condition(
      () =>
        published.length === beforeStop + 1 &&
        runtime.sessions(pubkey)[0]?.status === "Idle",
      "reply after stop",
    );
    assert.match(published.at(-1).content, /AFTER_STOP_OK/);
    console.log(
      "PASS stop interrupts the running turn and its shell quietly, and the thread continues",
    );
  }
} finally {
  await inspect?.close();
  communityRuntime?.dispose();
  runtime.dispose();
  await condition(() => children.size === 0, "app-server shutdown").catch(
    (error) => console.error(error.message),
  );
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}
