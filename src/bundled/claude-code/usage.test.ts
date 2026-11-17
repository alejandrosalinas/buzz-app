import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionUsage } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import { manifestProcesses } from "./claude-testing";
import { readUsage, sessionUsage } from "./usage";

// A line larger than this is left unread; small enough for test files.
vi.mock("../../buzz-mcp/app-client", async (original) => ({
  ...(await original<typeof import("../../buzz-mcp/app-client")>()),
  READ_LIMIT: 12 << 20,
}));

const agent = "a".repeat(64);
const other = "b".repeat(64);
const root = "c".repeat(64);
const HOUR = 3_600_000;
const at = (ms: number) =>
  new Date(Date.UTC(2026, 9, 16, 9) + ms).toISOString();
const context = (lines: string[]) =>
  JSON.stringify({
    type: "user",
    timestamp: at(0),
    message: {
      role: "user",
      content: `<context>\n${lines.join("\n")}\n</context>\n\n<buzz-event type="mention">\nContent: hi\n</buzz-event>`,
    },
  });
const threadPrompt = (who = agent) =>
  context([
    "Scope: thread",
    "Session scope: thread",
    "Channel: buzz-app (#chan)",
    `Thread root: ${root}`,
    `Agent: ${who}`,
  ]);
const reply = (
  ms: number,
  id: string,
  usage: Record<string, unknown>,
  model = "claude-opus-5-5",
  extra = {},
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(ms),
    requestId: `req-${id}`,
    message: { id, model, role: "assistant", content: [], usage },
    ...extra,
  });
const usage = (input: number, output: number, read = 0, write = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});
const hourWrites = (counts: ReturnType<typeof usage>, hour: number) => ({
  ...counts,
  cache_creation: {
    ephemeral_1h_input_tokens: hour,
    ephemeral_5m_input_tokens: counts.cache_creation_input_tokens - hour,
  },
});

it("observes each streamed request once, with its subagents, unknown counts left out", () => {
  const file = [
    threadPrompt(),
    // Claude Code repeats a response's usage on each content block's line.
    reply(1000, "m1", hourWrites(usage(2, 10, 100, 50), 40)),
    reply(1001, "m1", hourWrites(usage(2, 10, 100, 50), 40)),
    reply(2000, "m2", { input_tokens: 3, output_tokens: 20 }),
    reply(HOUR + 5, "m3", usage(1, 5, 300, 0), "claude-sonnet-5-5"),
    reply(HOUR + 6, "m4", usage(9, 9), "<synthetic>"),
    JSON.stringify({ type: "ai-title", aiTitle: "Port the scroll patch" }),
  ].join("\n");
  const subagent = reply(1500, "s1", usage(4, 40, 400, 0), "claude-haiku-5-5", {
    isSidechain: true,
  });
  const session = sessionUsage(
    "s",
    `${file}\n{"partial`,
    new Map([["agent-s", subagent]]),
    agent,
    false,
  );
  const hour = Date.UTC(2026, 9, 16, 9);
  expect(session).toEqual({
    id: "s",
    channelId: "chan",
    root,
    title: "Port the scroll patch",
    startedAt: hour,
    lastAt: hour + HOUR + 6,
    // The partial last line is still being written: no gap.
    gaps: [],
    observations: [
      {
        requestId: "req-m1",
        at: hour + 1001,
        model: "claude-opus-5-5",
        tokens: {
          input: 2,
          output: 10,
          cacheRead: 100,
          cacheWrite: 50,
          cacheWrite1h: 40,
        },
      },
      // Its cache counts were not recorded, so are unknown.
      {
        requestId: "req-m2",
        at: hour + 2000,
        model: "claude-opus-5-5",
        tokens: { input: 3, output: 20 },
      },
      {
        requestId: "req-m3",
        at: hour + HOUR + 5,
        model: "claude-sonnet-5-5",
        tokens: { input: 1, output: 5, cacheRead: 300, cacheWrite: 0 },
      },
      {
        requestId: "req-s1",
        at: hour + 1500,
        model: "claude-haiku-5-5",
        tokens: { input: 4, output: 40, cacheRead: 400, cacheWrite: 0 },
      },
    ],
  });
});

it("reports what it could not read as the snapshot's gaps", () => {
  const work = reply(1000, "m1", usage(1, 1));
  const session = sessionUsage(
    "s",
    [threadPrompt(), "{broken", work, ""].join("\n"),
    new Map([
      ["agent-a", undefined],
      ["agent-b", `{broken\n${work}`],
    ]),
    agent,
    false,
  );
  expect(session?.gaps).toEqual([
    "A subagent’s transcript is gone",
    "2 transcript lines unreadable",
  ]);
});

it("reports a subagent the session spawned whose transcript is gone", () => {
  const work = reply(1000, "m1", usage(1, 1));
  const spawn = (agentId: string) =>
    JSON.stringify({
      type: "user",
      timestamp: at(500),
      toolUseResult: { agentId },
    });
  const file = [threadPrompt(), spawn("kept"), spawn("gone"), work].join("\n");
  expect(
    sessionUsage("s", file, new Map([["agent-kept", work]]), agent, false)
      ?.gaps,
  ).toEqual(["A subagent’s transcript is gone"]);
  expect(
    sessionUsage(
      "s",
      file,
      new Map([
        ["agent-kept", work],
        ["agent-gone", work],
      ]),
      agent,
      false,
    )?.gaps,
  ).toEqual([]);
});

it("keeps only sessions Buzz started for this agent", () => {
  const channelPrompt = context([
    "Scope: channel",
    "Session scope: channel",
    "Channel: chan",
  ]);
  const work = reply(1000, "m1", usage(1, 1));
  expect(
    sessionUsage(
      "s",
      `${threadPrompt(other)}\n${work}`,
      new Map(),
      agent,
      true,
    ),
  ).toBeUndefined();
  // Not a Buzz prompt: the person's own session in the same workspace.
  expect(
    sessionUsage(
      "s",
      `${JSON.stringify({ type: "user", timestamp: at(0), message: { content: "hi" } })}\n${work}`,
      new Map(),
      agent,
      true,
    ),
  ).toBeUndefined();
  // Prompts from before agents were named count only when saved for it.
  expect(
    sessionUsage("s", `${channelPrompt}\n${work}`, new Map(), agent, false),
  ).toBeUndefined();
  expect(
    sessionUsage("s", `${channelPrompt}\n${work}`, new Map(), agent, true),
  ).toMatchObject({
    channelId: "chan",
  });
  expect(
    sessionUsage("s", `${channelPrompt}\n${work}`, new Map(), agent, true),
  ).not.toHaveProperty("root");
});

/** The first prompt of a watch's or timer's one-off turn: it opens with no
 * context, so nothing in the file says whose it is. */
const timerPrompt = JSON.stringify({
  type: "user",
  timestamp: at(0),
  message: { role: "user", content: "Timer: daily\n\nReport ops in #ops." },
});

it("counts a one-off turn's session only when it is recorded as the agent's", () => {
  const file = `${timerPrompt}\n${reply(1000, "m1", usage(1, 1))}`;
  expect(sessionUsage("s", file, new Map(), agent, false)).toBeUndefined();
  const session = sessionUsage("s", file, new Map(), agent, false, true);
  expect(session).toMatchObject({ id: "s", gaps: [] });
  expect(session).not.toHaveProperty("channelId");
  expect(session?.observations).toHaveLength(1);
});

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

it("finds the agent's sessions with the manifest's processes", async () => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const project = join(home, ".claude/projects/-Users-me--buzz");
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
  };
  const recent = Date.UTC(2026, 9, 16, 9);
  write("named.jsonl", `${threadPrompt()}\n${reply(1000, "m1", usage(1, 2))}`);
  write(
    "named/subagents/agent-x.jsonl",
    reply(1500, "s1", usage(3, 4), "claude-opus-5-5", { isSidechain: true }),
  );
  write(
    "theirs.jsonl",
    `${threadPrompt(other)}\n${reply(1000, "m1", usage(1, 2))}`,
  );
  write(
    "saved.jsonl",
    `${context(["Session scope: channel", "Channel: dm"])}\n${reply(1000, "m1", usage(5, 6))}`,
  );
  const sessions = await readUsage(
    desktop(home),
    "~/.buzz",
    agent,
    ["saved", "gone"],
    recent - HOUR,
    new AbortController().signal,
  );
  expect(sessions.map((session) => session.id).sort()).toEqual([
    "named",
    "saved",
  ]);
  const named = sessions.find((session) => session.id === "named");
  expect(named?.observations.map((entry) => entry.tokens)).toEqual([
    { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
  ]);
  expect(named?.gaps).toEqual([]);
  expect(named?.revision).toMatch(/^[0-9a-f]{64}$/);
  // Activity before `since` is left out.
  expect(
    await readUsage(
      desktop(home),
      "~/.buzz",
      agent,
      [],
      recent + 2 * HOUR,
      new AbortController().signal,
    ),
  ).toEqual([]);
});

it("reads the one-off turns recorded for the agent", async () => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const project = join(home, ".claude/projects/-Users-me--buzz");
  mkdirSync(project, { recursive: true });
  const work = reply(1000, "m1", usage(1, 2));
  writeFileSync(join(project, "once.jsonl"), `${timerPrompt}\n${work}`);
  // Another agent's one-off turn in the same workspace, never recorded here.
  writeFileSync(join(project, "theirs.jsonl"), `${timerPrompt}\n${work}`);
  const sessions = await readUsage(
    desktop(home),
    "~/.buzz",
    agent,
    [],
    0,
    new AbortController().signal,
    ["once", "gone"],
  );
  expect(sessions.map((session) => session.id)).toEqual(["once"]);
  expect(sessions[0]).not.toHaveProperty("channelId");
});

/** A subagent's reply padded with `char` to about `bytes` in its file. */
const padded = (
  ms: number,
  id: string,
  counts: Record<string, unknown>,
  bytes: number,
  char = "x",
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(ms),
    requestId: `req-${id}`,
    isSidechain: true,
    message: {
      id,
      model: "claude-opus-5-5",
      role: "assistant",
      content: [
        { type: "text", text: char.repeat(bytes / Buffer.byteLength(char)) },
      ],
      usage: counts,
    },
  });
const sidechain = (ms: number, id: string, counts: Record<string, unknown>) =>
  reply(ms, id, counts, "claude-opus-5-5", { isSidechain: true });

/** The session with one subagent whose transcript is `text`, read as the app
 * reads, refusing whole files over 1 MiB. */
async function readLarge(text: string) {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const project = join(home, ".claude/projects/-Users-me--buzz");
  mkdirSync(join(project, "one/subagents"), { recursive: true });
  writeFileSync(
    join(project, "one.jsonl"),
    `${threadPrompt()}\n${reply(1000, "m1", usage(1, 2))}`,
  );
  writeFileSync(join(project, "one/subagents/agent-big.jsonl"), text);
  const host = desktop(home);
  const sessions = await readUsage(
    {
      ...host,
      readFile: async (path) => {
        const file = await host.readFile(path);
        if (file.length > 1 << 20)
          throw new Error(`${path} is larger than 50 MB`);
        return file;
      },
    },
    "~/.buzz",
    agent,
    [],
    0,
    new AbortController().signal,
  );
  expect(sessions).toHaveLength(1);
  return sessions[0];
}
const inputs = (session?: SessionUsage) =>
  session?.observations.map((entry) => entry.tokens.input);

it("reads a transcript too large for the app's read a page at a time", async () => {
  const text = [
    sidechain(1500, "s1", usage(3, 4)),
    // Two-byte characters across the first page's end.
    padded(1600, "s2", usage(5, 6), 10 << 20, "é"),
    sidechain(1700, "s3", usage(7, 8)),
    // A streamed response's usage again, on a later page: counted once.
    sidechain(1800, "s1", usage(9, 10)),
  ].join("\n");
  const session = await readLarge(`${text}\n`);
  expect(session?.gaps).toEqual([]);
  expect(session?.observations.map((entry) => entry.tokens)).toEqual([
    { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    { input: 9, output: 10, cacheRead: 0, cacheWrite: 0 },
    { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 },
    { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 },
  ]);
  expect(session?.lastAt).toBe(Date.parse(at(1800)));
});

it("leaves a line larger than the app's read unread, and reads the rest", async () => {
  const unread = ["1 transcript line unreadable"];
  // Completed within a full page, with a full page after it.
  const completed = await readLarge(
    [
      sidechain(1500, "s1", usage(3, 4)),
      padded(1600, "huge", usage(50, 50), 13 << 20),
      padded(1700, "s2", usage(5, 6), 5 << 20),
      sidechain(1800, "s3", usage(7, 8)),
    ].join("\n"),
  );
  expect(completed?.gaps).toEqual(unread);
  expect(inputs(completed)).toEqual([1, 3, 5, 7]);
  // Unfinished at the end of the file.
  const unfinished = await readLarge(
    `${sidechain(1500, "s1", usage(3, 4))}\n${padded(1600, "huge", usage(50, 50), 13 << 20)}`,
  );
  expect(unfinished?.gaps).toEqual(unread);
  expect(inputs(unfinished)).toEqual([1, 3]);
  // Longer than the limit and a page together: dropped as it is read.
  const longer = await readLarge(
    [
      sidechain(1500, "s1", usage(3, 4)),
      padded(1600, "huge", usage(50, 50), 30 << 20),
      sidechain(1800, "s3", usage(7, 8)),
    ].join("\n"),
  );
  expect(longer?.gaps).toEqual(unread);
  expect(inputs(longer)).toEqual([1, 3, 7]);
});

it("reports a too-large transcript gone before its pages are read", async () => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const project = join(home, ".claude/projects/-Users-me--buzz");
  mkdirSync(join(project, "one/subagents"), { recursive: true });
  writeFileSync(
    join(project, "one.jsonl"),
    `${threadPrompt()}\n${reply(1000, "m1", usage(1, 2))}`,
  );
  const big = join(project, "one/subagents/agent-big.jsonl");
  writeFileSync(big, reply(1500, "s1", usage(3, 4)));
  const host = desktop(home);
  const [session] = await readUsage(
    {
      ...host,
      readFile: async (path) => {
        if (!path.includes("/subagents/")) return host.readFile(path);
        rmSync(big);
        throw new Error(`${path} is larger than 50 MB`);
      },
    },
    "~/.buzz",
    agent,
    [],
    0,
    new AbortController().signal,
  );
  expect(session?.gaps).toEqual(["A subagent’s transcript is gone"]);
  expect(session?.observations).toHaveLength(1);
});

it("reads again only the files changed since the last read", async () => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const base = home;
  const project = join(base, ".claude/projects/-Users-me--buzz");
  const write = (path: string, content: string, old = false) => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
    // Older than a listing looks back.
    const then = new Date(Date.now() - 2 * HOUR);
    if (old) utimesSync(join(project, path), then, then);
  };
  const spawned = JSON.stringify({
    type: "user",
    timestamp: at(500),
    toolUseResult: { agentId: "x" },
  });
  write(
    "one.jsonl",
    `${threadPrompt()}\n${spawned}\n${reply(1000, "m1", usage(1, 2))}`,
    true,
  );
  write(
    "one/subagents/agent-x.jsonl",
    reply(1500, "s1", usage(3, 4), "claude-opus-5-5", { isSidechain: true }),
    true,
  );
  write("theirs.jsonl", `${threadPrompt(other)}`, true);
  const reads: string[] = [];
  const host = desktop(base, reads);
  const read = () =>
    readUsage(host, "~/.buzz", agent, [], 0, new AbortController().signal);
  const ids = async () => (await read()).map((session) => session.id);
  expect(await ids()).toEqual(["one"]);
  expect(reads.sort()).toEqual(["one.jsonl", "one/subagents/agent-x.jsonl"]);
  reads.length = 0;
  expect(await ids()).toEqual(["one"]);
  expect(reads).toEqual([]);
  // A session written to since is read again, and only it.
  appendFileSync(
    join(project, "one.jsonl"),
    `\n${reply(2000, "m3", usage(7, 8))}`,
  );
  const [one] = await read();
  expect(reads).toEqual(["one.jsonl"]);
  expect(one?.observations.map((entry) => entry.tokens.input)).toEqual([
    1, 7, 3,
  ]);
  // Until it is older than a listing looks back, it is read on every open.
  const then = new Date(Date.now() - 2 * HOUR);
  utimesSync(join(project, "one.jsonl"), then, then);
  reads.length = 0;
  // Sessions started since: only the agent's own is read.
  write("two.jsonl", `${threadPrompt()}\n${reply(HOUR, "m2", usage(5, 6))}`);
  write("theirs-too.jsonl", threadPrompt(other));
  expect(await ids()).toEqual(["two", "one"]);
  expect(reads).toEqual(["two.jsonl"]);
  // A transcript deleted since is gone, not remembered.
  rmSync(join(project, "one/subagents/agent-x.jsonl"));
  const sessions = await readUsage(
    host,
    "~/.buzz",
    agent,
    [],
    0,
    new AbortController().signal,
  );
  expect(sessions.find((session) => session.id === "one")?.gaps).toEqual([
    "A subagent’s transcript is gone",
  ]);
});

it("reads everything again after the clock is set back", async () => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const file = join(home, ".claude/projects/-Users-me--buzz/one.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const old = (path: string) => {
    const then = new Date(Date.now() - 2 * HOUR);
    utimesSync(path, then, then);
  };
  writeFileSync(file, `${threadPrompt()}\n${reply(1000, "m1", usage(1, 2))}`);
  old(file);
  const reads: string[] = [];
  const host = desktop(home, reads);
  const read = () =>
    readUsage(host, "~/.buzz", agent, [], 0, new AbortController().signal);
  await read();
  // Written while the clock was ahead, so older than any later window.
  appendFileSync(file, `\n${reply(2000, "m2", usage(3, 4))}`);
  old(file);
  reads.length = 0;
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now - HOUR);
  try {
    const [one] = await read();
    expect(reads).toEqual(["one.jsonl"]);
    expect(one?.observations).toHaveLength(2);
  } finally {
    clock.mockRestore();
  }
});

it("files a session under the agent its opening context names", async () => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const project = join(home, ".claude/projects/-Users-me--buzz");
  mkdirSync(project, { recursive: true });
  // The event quotes another agent's context on the same line.
  const opening = context([
    "Session scope: channel",
    "Channel: buzz-app (#chan)",
    `Agent: ${agent}`,
  ]).replace("Content: hi", `Content: see Agent: ${other}`);
  writeFileSync(
    join(project, "q.jsonl"),
    `${opening}\n${reply(1000, "m1", usage(1, 2))}`,
  );
  // The same agent in another community is its membership there.
  const away = `${agent}@other.example%3A8443`;
  writeFileSync(
    join(project, "r.jsonl"),
    `${threadPrompt(away)}\n${reply(1000, "m2", usage(1, 2))}`,
  );
  const host = desktop(home);
  const read = (who: string) =>
    readUsage(host, "~/.buzz", who, [], 0, new AbortController().signal);
  expect((await read(agent)).map((session) => session.id)).toEqual(["q"]);
  expect((await read(away)).map((session) => session.id)).toEqual(["r"]);
  expect(await read(other)).toEqual([]);
});

it("shares one listing between agents read together", async () => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  mkdirSync(join(home, ".claude/projects/-Users-me--buzz"), {
    recursive: true,
  });
  const host = desktop(home);
  const listings: string[] = [];
  const spawn: typeof host.spawn = (id, options) => {
    if (id === "list") listings.push(id);
    return host.spawn(id, options);
  };
  const signal = new AbortController().signal;
  await Promise.all(
    [agent, other, root].map((who) =>
      readUsage({ ...host, spawn }, "~/.buzz", who, [], 0, signal),
    ),
  );
  expect(listings).toEqual(["list"]);
});

it("starts no more reads once the read is stopped", async () => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const project = join(home, ".claude/projects/-Users-me--buzz");
  mkdirSync(project, { recursive: true });
  for (let index = 0; index < 20; index += 1)
    writeFileSync(
      join(project, `s${index}.jsonl`),
      `${threadPrompt()}\n${reply(1000, `m${index}`, usage(1, 2))}`,
    );
  const reads: string[] = [];
  const host = desktop(home, reads);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const read = readUsage(
    {
      ...host,
      readFile: async (path) => {
        const file = await host.readFile(path);
        await held;
        return file;
      },
    },
    "~/.buzz",
    agent,
    [],
    0,
    controller.signal,
  );
  await vi.waitFor(() => expect(reads).toHaveLength(8));
  controller.abort();
  release();
  await expect(read).rejects.toThrow();
  expect(reads).toHaveLength(8);
});

it("starts no more subagent reads once the read is stopped", async () => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const project = join(home, ".claude/projects/-Users-me--buzz");
  mkdirSync(join(project, "one/subagents"), { recursive: true });
  writeFileSync(
    join(project, "one.jsonl"),
    `${threadPrompt()}\n${reply(1000, "m1", usage(1, 2))}`,
  );
  for (let index = 0; index < 12; index += 1)
    writeFileSync(
      join(project, `one/subagents/agent-${index}.jsonl`),
      reply(1500, `s${index}`, usage(3, 4), "claude-opus-5-5", {
        isSidechain: true,
      }),
    );
  const reads: string[] = [];
  const host = desktop(home, reads);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const read = readUsage(
    {
      ...host,
      // The session's own file reads at once; its subagents' are held.
      readFile: async (path) => {
        const file = await host.readFile(path);
        if (path.includes("/subagents/")) await held;
        return file;
      },
    },
    "~/.buzz",
    agent,
    [],
    0,
    controller.signal,
  );
  await vi.waitFor(() => expect(reads.length).toBeGreaterThan(1));
  const started = reads.length;
  controller.abort();
  release();
  await expect(read).rejects.toThrow();
  expect(reads).toHaveLength(started);
  expect(started).toBeLessThan(13);
});

it("fails rather than undercount when a search fails partway", async () => {
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    if (id === "workspace") options.onStdout?.("/Users/me/.buzz\n");
    if (id === "list") options.onStdout?.("./s.jsonl\n");
    if (id === "starts") {
      options.onStdout?.(`./s.jsonl:Channel: dm\n./s.jsonl:Agent: ${agent}\n`);
      options.onStderr?.("grep: ./t.jsonl: Permission denied\n");
    }
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(id === "starts" ? 2 : 0),
    };
  };
  await expect(
    readUsage(
      { spawn, readFile: async () => new Uint8Array() },
      "~/.buzz",
      agent,
      [],
      0,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Permission denied");
});

/** The manifest's processes and the app's file read, `~` being `home`;
 * `reads` collects the paths read within the project. */
function desktop(home: string, reads: string[] = []) {
  return {
    spawn: manifestProcesses(home),
    readFile: async (path: string) => {
      reads.push(path.replace(/^~\/\.claude\/projects\/[^/]+\//, ""));
      try {
        return readFileSync(path.replace(/^~/, home));
      } catch (error) {
        // The app's wording for a missing file.
        if ((error as { code?: string }).code === "ENOENT")
          throw new Error(`${path}: No such file`);
        throw error;
      }
    },
  };
}
