import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { manifestProcesses } from "./claude-testing";
import manifest from "./manifest.json";
import type { EventData } from "../../features/relay/events";
import { localStore } from "../../features/agents/state";
import type { TranscriptTurn } from "../../features/agents/activity-transcript";
import { sessionPrompts } from "../../features/agents/session-prompts";
import { steerPrompt, turnPrompt } from "./prompt";
import { ClaudeRuntime } from "./runtime";
import {
  claudeTurns,
  projectName,
  OVERSIZED_READ_MS,
  readLatestTurns,
  readTranscript,
  TURN_LIMIT,
} from "./transcript";

const root = "c".repeat(64);
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const agent = "a".repeat(64);
const conversation = {
  agent,
  sessionId: "session-1",
  channelId: "channel",
  root,
};
const prompt = (content: string) =>
  `<context>\nScope: thread\n</context>\n\n<buzz-event type="mention">\nEvent ID: e\nFrom: Sam (npub: npub1x, hex: ${"a".repeat(64)})\nContent: ${content}\nTags: []\n</buzz-event>`;
let clock = 0;
const line = (type: string, content: unknown, extra = {}) =>
  JSON.stringify({
    type,
    uuid: `u${++clock}`,
    timestamp: new Date(clock * 1000).toISOString(),
    message: { role: type, content },
    ...extra,
  });
const file = () => {
  clock = 0;
  return [
    JSON.stringify({ type: "queue-operation" }),
    line("user", prompt("fix the tests")),
    line("assistant", [{ type: "thinking", thinking: "Run them first" }]),
    line("assistant", [
      {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "pnpm test" },
      },
    ]),
    line("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "1 failed",
        is_error: true,
      },
    ]),
    line("user", "<command-caveat>", { isMeta: true }),
    line("assistant", [{ type: "text", text: "from a subagent" }], {
      isSidechain: true,
    }),
    line(
      "user",
      `<new-message-arrived-while-you-were-working>\n${prompt("also lint")}\n</new-message-arrived-while-you-were-working>\n\nNote: A new message arrived.`,
    ),
    line("assistant", [
      {
        type: "tool_use",
        id: "t2",
        name: "Edit",
        input: { file_path: "/w/a.ts" },
      },
      { type: "text", text: "Fixed." },
    ]),
    "not json",
    line("user", [{ type: "text", text: prompt("thanks") }]),
    line("assistant", [{ type: "text", text: "Any time." }]),
  ].join("\n");
};

it("groups a session file into prompted turns with steering, tools and replies", () => {
  const turns = claudeTurns(file(), conversation, false);
  expect(turns.map((turn) => turn.items.map((item) => item.type))).toEqual([
    ["prompt", "thought", "tool", "prompt", "tool", "message"],
    ["prompt", "message"],
  ]);
  const [first, second] = turns;
  expect(first).toMatchObject({
    turnId: "u1",
    channelId: "channel",
    threadRootId: root,
    sessionId: "session-1",
    startedAt: 1000,
    endedAt: 8000,
    partial: false,
  });
  expect(first?.items[0]).toMatchObject({
    text: "fix the tests",
    author: "Sam",
    steer: false,
  });
  expect(first?.items[2]).toMatchObject({
    title: "pnpm test",
    kind: "execute",
    status: "failed",
    output: "1 failed",
    completedAt: 4000,
  });
  expect(first?.items[3]).toMatchObject({ text: "also lint", steer: true });
  expect(first?.items[4]).toMatchObject({
    title: "Edit",
    kind: "edit",
    status: "in_progress",
    paths: ["/w/a.ts"],
  });
  expect(second).toMatchObject({
    turnId: "u9",
    startedAt: 9000,
    endedAt: 10_000,
  });
  // A working session's last turn has not ended.
  expect(claudeTurns(file(), conversation, true).at(-1)).not.toHaveProperty(
    "endedAt",
  );
});

it("shows what the agent posted as its reply once sent, and names Buzz tools as Codex does", () => {
  clock = 0;
  const send = (id: string, text: string, tool = "send") =>
    line("assistant", [
      { type: "tool_use", id, name: `mcp__buzz__${tool}`, input: { text } },
    ]);
  const result = (id: string, content: string, is_error = false) =>
    line("user", [{ type: "tool_result", tool_use_id: id, content, is_error }]);
  const [turn] = claudeTurns(
    [
      line("user", prompt("review it")),
      line("assistant", [
        {
          type: "tool_use",
          id: "r",
          name: "mcp__buzz__read",
          input: { thread: root },
        },
      ]),
      result("r", "3 messages"),
      send("s1", "Looks good."),
      result("s1", "sent"),
      send("n1", "Nested.", "reply_in_subthread"),
      result("n1", "sent"),
      send("s2", "One more thing."),
      result("s2", "channel not found", true),
      // Not finished when the session was read, or never: it ended mid-send.
      send("s3", "Still sending."),
    ].join("\n"),
    conversation,
    false,
  );
  expect(turn?.items).toEqual([
    expect.objectContaining({ type: "prompt", text: "review it" }),
    expect.objectContaining({ type: "tool", title: "buzz.read" }),
    expect.objectContaining({
      type: "message",
      text: "Looks good.",
      posted: true,
    }),
    expect.objectContaining({ type: "message", text: "Nested.", posted: true }),
    expect.not.objectContaining({ posted: true }),
    expect.objectContaining({
      type: "status",
      text: "The message above was not posted: channel not found",
    }),
    expect.not.objectContaining({ posted: true }),
  ]);
});

it("leaves a bare send or reply_in_subthread, outside Buzz, as an ordinary tool", () => {
  clock = 0;
  const [turn] = claudeTurns(
    [
      line("user", prompt("go")),
      ...["send", "reply_in_subthread"].flatMap((name) => [
        line("assistant", [
          { type: "tool_use", id: name, name, input: { text: "Hi." } },
        ]),
        line("user", [
          {
            type: "tool_result",
            tool_use_id: name,
            content: "ok",
            is_error: false,
          },
        ]),
      ]),
    ].join("\n"),
    conversation,
    false,
  );
  expect(turn?.items).toEqual([
    expect.objectContaining({ type: "prompt" }),
    expect.objectContaining({ type: "tool" }),
    expect.objectContaining({ type: "tool" }),
  ]);
});

it("keeps steps before the first loaded prompt as a partial turn", () => {
  clock = 0;
  const [turn] = claudeTurns(
    line("assistant", [{ type: "text", text: "resumed" }]),
    { sessionId: "s", channelId: "dm" },
    false,
  );
  expect(turn).toMatchObject({ partial: true, threadRootId: null });
});

it("names projects as Claude Code does", () => {
  expect(projectName("/Users/me/.buzz")).toBe("-Users-me--buzz");
  expect(projectName("/Users/me/my_repo")).toBe("-Users-me-my-repo");
});

const sam = "b".repeat(64);
const message = (id: string, content: string): EventData => ({
  id: id.repeat(64),
  pubkey: sam,
  kind: 9,
  created_at: 1_800_000_000,
  content,
  tags: [["h", "channel"]],
});
/** A turn as the runtime prompts it now: exact records. */
const turn = (content: string, context: readonly EventData[] = []) =>
  turnPrompt({
    agent,
    event: message("e", content),
    channel: { id: "channel", name: "dev" },
    scope: "thread",
    thread: { rootId: root, parentId: root },
    context,
    total: context.length + 1,
  });

it("reads a prompt and a steer sent as exact records, naming the sender", () => {
  clock = 0;
  const file = [
    line("user", turn("fix the tests", [message("1", "it is red")])),
    line("user", steerPrompt(`${turn("also lint")}\n\nA plugin's note`)),
    line("assistant", [{ type: "text", text: "Fixed." }]),
  ].join("\n");
  const name = (pubkey: string) => (pubkey === sam ? "Sam" : undefined);
  const [first, ...rest] = claudeTurns(file, conversation, false, name);
  expect(rest).toEqual([]);
  expect(first?.items).toMatchObject([
    { type: "prompt", text: "fix the tests", author: "Sam", steer: false },
    { type: "prompt", text: "also lint", author: "Sam", steer: true },
    { type: "message", text: "Fixed." },
  ]);
  // Unnamed, the request still shows.
  expect(claudeTurns(file, conversation, false)[0]?.items[0]).toMatchObject({
    text: "fix the tests",
  });
});

/** `workspace` prints the resolved folder and `read` serves `files` as
 * base64; the manifest's other processes run for real on a copy of them. */
function host(files: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "claude-transcript-"));
  homes.push(home);
  for (const [path, content] of Object.entries(files)) {
    const copy = join(home, ".claude/projects", path);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, content);
    // Written an hour ago, so a later listing finds it unchanged.
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(copy, hourAgo, hourAgo);
  }
  const listed = manifestProcesses(home);
  const reads: HostProcessOptions[] = [];
  const spawn = vi.fn(async (id: string, options: HostProcessOptions = {}) => {
    if (["list", "starts", "size", "read-page"].includes(id))
      return listed(id, options);
    let code = 0;
    if (id === "workspace") options.onStdout?.("/Users/me/.buzz\n");
    if (id === "read") {
      reads.push(options);
      const path = options.args?.[0] ?? "";
      const content = files[path];
      if (content === undefined) {
        options.onStderr?.(`base64: ${path}: No such file or directory\n`);
        code = 1;
      } else options.onStdout?.(Buffer.from(content).toString("base64"));
    }
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(code),
    };
  });
  return { spawn, reads, home };
}

it("reads the session file from the project of the agent's workspace", async () => {
  const { spawn, reads } = host({
    "./-Users-me--buzz/session-1.jsonl": file(),
  });
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  expect(spawn).toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({ cwd: "~/.buzz" }),
  );
  expect(reads[0]).toMatchObject({
    cwd: "~/.claude/projects",
    args: ["./-Users-me--buzz/session-1.jsonl"],
  });
  expect(read).toMatchObject({ more: false });
  expect(read?.turns).toHaveLength(2);
});

it("treats a missing session file as no transcript, not a failure", async () => {
  const { spawn } = host({});
  await expect(
    readTranscript(
      spawn,
      "~/.buzz",
      conversation,
      false,
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
});

/** A session for the thread that is not the saved one, so its start must say
 * it is the thread's, with `turns` after it. */
const large = (...turns: string[]) => {
  clock = 0;
  const thread = `Session scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent}`;
  return {
    "./-Users-me--buzz/large.jsonl": [
      line(
        "user",
        prompt("first").replace("Scope: thread", `Scope: thread\n${thread}`),
      ),
      ...turns,
    ].join("\n"),
  };
};
const long = "x".repeat(55 * 1024 * 1024);

it("reads a session too large to read whole a page at a time", async () => {
  const { spawn } = host(
    large(
      line("assistant", [{ type: "text", text: long }]),
      line("user", prompt("latest")),
      line("assistant", [{ type: "text", text: "re: latest" }]),
    ),
  );
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  expect(read?.more).toBe(false);
  // The reply that spans two pages is read whole.
  expect(read?.turns.map((turn) => turn.items)).toEqual([
    [
      expect.objectContaining({ text: "first" }),
      expect.objectContaining({ text: long }),
    ],
    [
      expect.objectContaining({ text: "latest" }),
      expect.objectContaining({ text: "re: latest" }),
    ],
  ]);
});

it("stops reading a large session once it has its latest turns", async () => {
  const { spawn } = host(
    large(
      line("assistant", [{ type: "text", text: long }]),
      ...Array.from({ length: TURN_LIMIT + 1 }, (_, turn) =>
        line("user", prompt(`turn ${turn}`)),
      ),
    ),
  );
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  expect(read?.more).toBe(true);
  expect(read?.turns.map((turn) => turn.items[0])).toEqual(
    Array.from({ length: TURN_LIMIT }, (_, turn) =>
      expect.objectContaining({ text: `turn ${turn + 1}` }),
    ),
  );
  // Only its last page and its start were read.
  expect(
    spawn.mock.calls
      .filter(([id]) => id === "read-page")
      .map(([, options]) => options?.args?.slice(1)),
  ).toEqual([
    ["32", "32"],
    ["0", "4"],
  ]);
});

it("reads no more than two pages of a large session with few turns", async () => {
  const third = "x".repeat(30 * 1024 * 1024);
  const { spawn } = host(
    large(
      ...[1, 2, 3].map(() =>
        line("assistant", [{ type: "text", text: third }]),
      ),
      line("user", prompt("latest")),
    ),
  );
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  expect(read?.more).toBe(true);
  expect(read?.turns.at(-1)?.items[0]).toEqual(
    expect.objectContaining({ text: "latest" }),
  );
  // Its last two pages and its start; the first page's turns are left.
  expect(
    spawn.mock.calls
      .filter(([id]) => id === "read-page")
      .map(([, options]) => options?.args?.slice(1)),
  ).toEqual([
    ["64", "32"],
    ["32", "32"],
    ["0", "4"],
  ]);
});

it("leaves other sessions' turns from before a large session's kept ones", async () => {
  const third = "x".repeat(30 * 1024 * 1024);
  const files = large(
    line("user", prompt("newer")),
    ...[1, 2, 3].map(() => line("assistant", [{ type: "text", text: third }])),
    line("user", prompt("latest")),
  );
  clock = -10;
  const { spawn } = host({
    ...files,
    "./-Users-me--buzz/session-1.jsonl": line("user", prompt("old")),
  });
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  // "newer" was in the page left, so "old" before it would hide the gap.
  expect(read?.more).toBe(true);
  expect(read?.turns.map((turn) => turn.items[0])).not.toContainEqual(
    expect.objectContaining({ text: "old" }),
  );
  expect(read?.turns.at(-1)?.items[0]).toEqual(
    expect.objectContaining({ text: "latest" }),
  );
});

it("labels no turn of a cut session as its start", async () => {
  const reply = (mib: number) =>
    line("assistant", [{ type: "text", text: "x".repeat(mib << 20) }]);
  const { spawn } = host(
    large(
      reply(40),
      line("user", prompt("mid")),
      reply(30),
      line("user", prompt("latest")),
    ),
  );
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  expect(read?.more).toBe(true);
  expect(read?.turns[0]?.items[0]).toEqual(
    expect.objectContaining({ text: "mid" }),
  );
  expect(read?.turns.some((turn) => turn.newSession)).toBe(false);
});

it("keeps no older sessions' turns when a cut session kept none", async () => {
  const files = large(
    line("user", prompt("huge")),
    line("assistant", [{ type: "text", text: "x".repeat(70 << 20) }]),
  );
  clock = -10;
  const { spawn } = host({
    ...files,
    "./-Users-me--buzz/session-1.jsonl": line("user", prompt("old")),
  });
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  expect(read).toEqual(expect.objectContaining({ more: true, turns: [] }));
});

it("merges the agent's other sessions for the thread, oldest turn first", async () => {
  const session = (start: number, context: string, content: string) => {
    clock = start;
    return [
      line(
        "user",
        prompt(content).replace("Scope: thread", `Scope: thread\n${context}`),
      ),
      line("assistant", [{ type: "text", text: `re: ${content}` }]),
    ].join("\n");
  };
  const thread = `Session scope: thread\nChannel: dev (#channel)\nThread root: ${root}`;
  const { spawn } = host({
    "./-Users-me--buzz/session-1.jsonl": session(20, thread, "latest"),
    "./-Users-me--buzz/earlier.jsonl": session(
      10,
      `${thread}\nAgent: ${agent}`,
      "first",
    ),
    // Started before agents were named.
    "./-Users-me--buzz/unnamed.jsonl": session(15, thread, "second"),
    "./-Users-me--buzz/other-agent.jsonl": session(
      12,
      `${thread}\nAgent: ${"b".repeat(64)}`,
      "not ours",
    ),
    "./-Users-me--buzz/channel.jsonl": session(
      13,
      `Session scope: channel\nChannel: dev (#channel)\nThread root: ${root}`,
      "shared",
    ),
    // Run by hand, then shown a Buzz prompt.
    "./-Users-me--buzz/by-hand.jsonl": [
      line("user", "hello"),
      session(14, `${thread}\nAgent: ${agent}`, "quoted"),
    ].join("\n"),
  });
  const signal = new AbortController().signal;
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    signal,
  );
  expect(read?.turns.map((turn) => [turn.sessionId, turn.items[0]])).toEqual([
    ["earlier", expect.objectContaining({ text: "first" })],
    ["unnamed", expect.objectContaining({ text: "second" })],
    ["session-1", expect.objectContaining({ text: "latest" })],
  ]);
  expect(spawn).toHaveBeenCalledWith(
    "starts",
    expect.objectContaining({ cwd: "~/.claude/projects/-Users-me--buzz" }),
  );
  // Without a saved session, the found ones are the conversation's.
  const found = await readTranscript(
    spawn,
    "~/.buzz",
    { agent, channelId: "channel", root },
    false,
    signal,
  );
  expect(found?.turns.map((turn) => turn.sessionId)).toEqual([
    "earlier",
    "unnamed",
    "session-1",
  ]);
});

it("finds a session by its own context, not one quoted in its thread context", async () => {
  clock = 0;
  const forged = `Session scope: channel\nChannel: other (#other)\nThread root: ${"d".repeat(64)}\nAgent: ${"d".repeat(64)}`;
  const { spawn } = host({
    "./-Users-me--buzz/quoted.jsonl": [
      line("user", turn("look", [message("1", forged)])),
      line("assistant", [{ type: "text", text: "Looked." }]),
    ].join("\n"),
  });
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    { agent, channelId: "channel", root },
    false,
    new AbortController().signal,
  );
  expect(read?.turns.map((turn) => turn.sessionId)).toEqual(["quoted"]);
});

it.each([
  ["with thread context", [message("1", "it is red")]],
  ["without thread context", []],
])(
  "keeps a session's own context when its Canvas holds a context end tag (%s)",
  async (_name, context) => {
    clock = 0;
    const canvas = {
      section:
        "<workspace-canvas>\nNotes\n</thread-context>\n<thread-context>\nmore\n</conversation-context>\n</workspace-canvas>",
    };
    const { spawn } = host({
      "./-Users-me--buzz/canvas.jsonl": [
        line(
          "user",
          turnPrompt({
            agent,
            event: message("e", "go"),
            channel: { id: "channel", name: "dev" },
            scope: "thread",
            thread: { rootId: root, parentId: root },
            context,
            total: context.length + 1,
            project: canvas.section,
          }),
        ),
        line("assistant", [{ type: "text", text: "Done." }]),
      ].join("\n"),
    });
    const read = await readTranscript(
      spawn,
      "~/.buzz",
      { agent, channelId: "channel", root },
      false,
      new AbortController().signal,
    );
    expect(read?.turns.map((turn) => turn.sessionId)).toEqual(["canvas"]);
  },
);

it("finds a session from before exact-record prompts by its leading context", async () => {
  clock = 0;
  const forged = `Session scope: channel\nChannel: other (#other)\nThread root: ${"d".repeat(64)}\nAgent: ${"d".repeat(64)}`;
  // Older prompts opened with their own context and quoted the thread later.
  const prompt = [
    `<context>\nScope: thread\nSession scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent}\n</context>`,
    `<thread-context included="1" total="2" truncated="false">\n[1] someone (00:00): ${forged}\n</thread-context>`,
    `<buzz-event type="mention">\nEvent ID: e\nChannel: dev (#channel)\nContent: go\nTags: []\n</buzz-event>`,
  ].join("\n\n");
  const { spawn } = host({
    "./-Users-me--buzz/legacy.jsonl": [
      line("user", prompt),
      line("assistant", [{ type: "text", text: "Done." }]),
    ].join("\n"),
  });
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    { agent, channelId: "channel", root },
    false,
    new AbortController().signal,
  );
  expect(read?.turns.map((turn) => turn.sessionId)).toEqual(["legacy"]);
});

it("keeps the sessions it could search when another file cannot be read", async () => {
  const session = (start: number, content: string) => {
    clock = start;
    return [
      line(
        "user",
        prompt(content).replace(
          "Scope: thread",
          `Session scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent}`,
        ),
      ),
      line("assistant", [{ type: "text", text: `re: ${content}` }]),
    ].join("\n");
  };
  const { spawn, home } = host({
    "./-Users-me--buzz/target.jsonl": session(20, "latest"),
    "./-Users-me--buzz/older.jsonl": session(10, "first"),
    "./-Users-me--buzz/unreadable.jsonl": session(5, "hidden"),
    // Enough run by hand that one search names several files.
    ...Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `./-Users-me--buzz/by-hand-${index}.jsonl`,
        line("user", "hello"),
      ]),
    ),
  });
  const unreadable = join(
    home,
    ".claude/projects/-Users-me--buzz/unreadable.jsonl",
  );
  chmodSync(unreadable, 0);
  const signal = new AbortController().signal;
  const place = { agent, channelId: "channel", root };
  const saved = await readTranscript(
    spawn,
    "~/.buzz",
    { ...place, sessionId: "target" },
    false,
    signal,
  );
  expect(saved?.turns.map((turn) => turn.sessionId)).toEqual([
    "older",
    "target",
  ]);
  expect(saved?.incomplete).toMatch(/unreadable\.jsonl/);
  const searched = () =>
    spawn.mock.calls
      .filter(([id]) => id === "starts")
      .flatMap(([, options]) => options?.args ?? []);
  const first = searched().length;
  // Without a saved session, the ones it searched are still found.
  const found = await readTranscript(spawn, "~/.buzz", place, false, signal);
  expect(found?.turns.map((turn) => turn.sessionId)).toEqual([
    "older",
    "target",
  ]);
  expect(found?.incomplete).toMatch(/unreadable\.jsonl/);
  // The next read searched again the file it could not read, and only that.
  expect(searched().slice(first)).toEqual(["unreadable.jsonl"]);
  chmodSync(unreadable, 0o644);
  const retried = await readTranscript(spawn, "~/.buzz", place, false, signal);
  expect(retried?.turns.map((turn) => turn.sessionId)).toEqual([
    "unreadable",
    "older",
    "target",
  ]);
  expect(retried?.incomplete).toBeUndefined();
});

it("fails, not reports no transcript, when it found none and could not search everything", async () => {
  const { spawn, home } = host({
    "./-Users-me--buzz/unreadable.jsonl": file(),
  });
  chmodSync(join(home, ".claude/projects/-Users-me--buzz/unreadable.jsonl"), 0);
  await expect(
    readTranscript(
      spawn,
      "~/.buzz",
      { agent, channelId: "channel", root },
      false,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/unreadable\.jsonl/);
});

/** A thread session whose first prompt `host` finds cut off before its
 * thread root, as while Claude Code is still writing it. */
function partlyWritten() {
  clock = 0;
  const whole = [
    line(
      "user",
      prompt("first").replace(
        "Scope: thread",
        `Session scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent}`,
      ),
    ),
    line("assistant", [{ type: "text", text: "re: first" }]),
  ].join("\n");
  const path = "./-Users-me--buzz/writing.jsonl";
  const files = { [path]: whole.slice(0, whole.indexOf("Thread root")) };
  const { spawn, home } = host(files);
  const complete = (at: Date) => {
    files[path] = whole;
    const copy = join(home, ".claude/projects", path);
    writeFileSync(copy, whole);
    utimesSync(copy, at, at);
  };
  return { spawn, complete };
}
const thread = { agent, channelId: "channel", root };

it("searches a session again once its cut-off first prompt is written", async () => {
  const { spawn, complete } = partlyWritten();
  const signal = new AbortController().signal;
  await expect(
    readTranscript(spawn, "~/.buzz", thread, false, signal),
  ).resolves.toBeUndefined();
  complete(new Date());
  const read = await readTranscript(spawn, "~/.buzz", thread, false, signal);
  expect(read?.turns.map((turn) => turn.sessionId)).toEqual(["writing"]);
});

it("searches every session again after the clock is set back", async () => {
  const { spawn, complete } = partlyWritten();
  const signal = new AbortController().signal;
  await expect(
    readTranscript(spawn, "~/.buzz", thread, false, signal),
  ).resolves.toBeUndefined();
  // Written before the clock's new time, so no listing of changes finds it.
  const earlier = Date.now() - 3_600_000;
  complete(new Date(earlier - 60_000));
  const now = vi.spyOn(Date, "now").mockReturnValue(earlier);
  try {
    const read = await readTranscript(spawn, "~/.buzz", thread, false, signal);
    expect(read?.turns.map((turn) => turn.sessionId)).toEqual(["writing"]);
  } finally {
    now.mockRestore();
  }
});

it("passes this platform's base64 a session path it reads as a file", async () => {
  const { spawn, reads } = host({});
  await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  const path = reads[0]?.args?.[0] ?? "";
  const read = manifest.host.processes.find((process) => process.id === "read");
  const root = mkdtempSync(join(tmpdir(), "claude-projects-"));
  try {
    mkdirSync(join(root, "-Users-me--buzz"));
    writeFileSync(join(root, "-Users-me--buzz", "session-1.jsonl"), "{}\n");
    const output = execFileSync(
      read?.program ?? "",
      [...(read?.args ?? []), path],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(atob(output.replace(/\s/g, ""))).toBe("{}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reads a session's latest whole turns from its end", async () => {
  clock = 0;
  const { spawn } = host({
    "./-Users-me--buzz/session-1.jsonl": [
      line("user", prompt("older")),
      line("assistant", [{ type: "text", text: "x".repeat(3 << 20) }]),
      line("assistant", [{ type: "text", text: "older reply" }]),
      line("user", prompt("latest")),
      line("assistant", [{ type: "text", text: "re: latest" }]),
    ].join("\n"),
  });
  const turns = await readLatestTurns(
    spawn,
    "~/.buzz",
    conversation,
    true,
    new AbortController().signal,
  );
  // The chunk starts partway through the long reply: that line and the rest
  // of its turn are left, not read as a turn.
  expect(turns?.map((turn) => turn.items)).toEqual([
    [
      expect.objectContaining({ text: "latest" }),
      expect.objectContaining({ text: "re: latest" }),
    ],
  ]);
  expect(turns?.[0]).toMatchObject({ newSession: false, partial: false });
  expect(
    spawn.mock.calls
      .filter(([id]) => id === "read-page")
      .map(([, options]) => options?.args?.slice(1)),
  ).toEqual([["2", "2"]]);
});

it("reads a turn larger than the chunk in full only every 30 s, keeping what is shown between", async () => {
  clock = 0;
  const { spawn } = host({
    "./-Users-me--buzz/session-1.jsonl": [
      line("user", prompt("only")),
      line("assistant", [{ type: "text", text: "x".repeat(3 << 20) }]),
      line("assistant", [{ type: "text", text: "done" }]),
    ].join("\n"),
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const latest = () =>
    readLatestTurns(
      spawn,
      "~/.buzz",
      conversation,
      true,
      new AbortController().signal,
    );
  // Undefined reads it in full; none keeps what is shown.
  await expect(latest()).resolves.toBeUndefined();
  now.mockReturnValue(1_000_000 + OVERSIZED_READ_MS - 1);
  await expect(latest()).resolves.toEqual([]);
  now.mockReturnValue(1_000_000 + OVERSIZED_READ_MS);
  await expect(latest()).resolves.toBeUndefined();
  await expect(latest()).resolves.toEqual([]);
  now.mockRestore();
});

it("shows a session's prompt once over the latest turns it swaps in", async () => {
  clock = 0;
  const { spawn } = host({
    "./-Users-me--buzz/session-1.jsonl": [
      line("user", prompt("latest")),
      line("assistant", [{ type: "text", text: "re: latest" }]),
    ].join("\n"),
  });
  const items = new Map<string, string>();
  const storage = localStore({
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  });
  const prompts = sessionPrompts(storage, "claude-code", agent);
  await prompts.save("session-1", [{ label: "", text: "be brief" }]);
  // The runtime's own method, with only what it reads.
  const latest = (held: readonly TranscriptTurn[]) =>
    ClaudeRuntime.prototype.latestTurns.call(
      { spawn, reads: () => undefined, prompts: () => prompts } as never,
      conversation,
      "~/.buzz",
      false,
      new AbortController().signal,
      held,
    );
  const shown = (turns: readonly TranscriptTurn[] | undefined) =>
    turns?.map((turn) => ({
      prompts: turn.items.filter((item) => item.type === "system").length,
      continued: Boolean(turn.continued),
    }));
  const earlier = (sessionId: string) =>
    ({
      turnId: "earlier",
      sessionId,
      startedAt: 0,
      items: [],
    }) as unknown as TranscriptTurn;
  const [first] = (await latest([])) ?? [];
  // It replaces the session's first shown turn: one prompt.
  expect(shown(await latest([]))).toEqual([{ prompts: 1, continued: false }]);
  // Earlier turns of that session stay shown: no second prompt or marker.
  expect(
    shown(await latest([earlier("session-1"), ...(first ? [first] : [])])),
  ).toEqual([{ prompts: 0, continued: false }]);
  // Only another session's turns stay: this one shows its own prompt.
  expect(
    shown(await latest([earlier("other"), ...(first ? [first] : [])])),
  ).toEqual([{ prompts: 1, continued: false }]);
});
