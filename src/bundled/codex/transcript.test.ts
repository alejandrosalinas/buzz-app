import { expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import type { Wire } from "./rpc";
import { sessionTag } from "./prompt";
import {
  codexTurns,
  findConversation,
  readTranscript,
  shellCommand,
  TURN_LIMIT,
} from "./transcript";

const root = "c".repeat(64);
const conversation = { channelId: "channel", root };
const input = `<context>\n{"channel_id":"channel"}\n</context>\n<buzz-event>\n{"id":"e","pubkey":"sam"}\nRequest: "fix the \\u003ctests\\u003e"\n</buzz-event>`;
const turn = (patch: Record<string, unknown> = {}) => ({
  id: "turn-1",
  status: "completed",
  error: null,
  startedAt: 100,
  completedAt: 160,
  items: [
    {
      type: "userMessage",
      id: "u1",
      content: [{ type: "text", text: input }],
    },
    { type: "reasoning", id: "r1", summary: ["Looking at tests"] },
    {
      type: "commandExecution",
      id: "c1",
      command: "/bin/zsh -lc 'pnpm test'",
      aggregatedOutput: "1 failed",
      status: "failed",
      durationMs: 2000,
    },
    {
      type: "userMessage",
      id: "u2",
      content: [
        {
          type: "text",
          text: '<new-message-arrived-while-you-were-working>\n{}\nRequest: "also lint"\n</new-message-arrived-while-you-were-working>',
        },
      ],
    },
    {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [{ path: "a.ts", kind: "update", diff: "-a\n+b" }],
    },
    {
      type: "dynamicToolCall",
      id: "d1",
      namespace: "buzz",
      tool: "send",
      arguments: { text: "Done" },
      status: "completed",
      contentItems: [{ type: "inputText", text: "sent" }],
      success: true,
    },
    { type: "agentMessage", id: "a1", text: "Fixed." },
    { type: "contextCompaction", id: "x1" },
    // A final answer after the reply went through send.
    { type: "agentMessage", id: "a2", text: "" },
  ],
  ...patch,
});

it("shows a Codex turn's request, steering, tools and reply in the shared transcript model", () => {
  const [mapped] = codexTurns([turn()], conversation, (pubkey) =>
    pubkey === "sam" ? "Sam" : undefined,
  );
  expect(mapped).toMatchObject({
    turnId: "turn-1",
    channelId: "channel",
    threadRootId: root,
    startedAt: 100_000,
    endedAt: 160_000,
  });
  expect(mapped?.items).toEqual([
    expect.objectContaining({
      type: "prompt",
      text: "fix the <tests>",
      author: "Sam",
      authorPubkey: "sam",
      steer: false,
      sections: [
        expect.objectContaining({ tag: "context" }),
        expect.objectContaining({ tag: "buzz-event" }),
      ],
    }),
    expect.objectContaining({ type: "thought", text: "Looking at tests" }),
    expect.objectContaining({
      type: "tool",
      title: "pnpm test",
      kind: "execute",
      status: "failed",
      output: "1 failed",
      completedAt: 102_000,
    }),
    expect.objectContaining({ type: "prompt", text: "also lint", steer: true }),
    expect.objectContaining({
      type: "tool",
      kind: "edit",
      paths: ["a.ts"],
      output: "-a\n+b",
    }),
    expect.objectContaining({ type: "message", text: "Done", posted: true }),
    expect.objectContaining({ type: "message", text: "Fixed." }),
    expect.objectContaining({ type: "status", text: "Context compaction" }),
  ]);
  const [channelTurn] = codexTurns(
    [turn({ status: "interrupted", completedAt: null, items: [] })],
    { channelId: "channel" },
  );
  expect(channelTurn).toMatchObject({
    threadRootId: null,
    stopReason: "interrupted",
  });
  expect(channelTurn).not.toHaveProperty("endedAt");
});

const agent = { key: "a".repeat(64), name: "Sol" };
const lookup = { agent, channelId: "channel", name: "dev", root };

it.each([
  ["summary only", { summary: ["Plan"] }, "Plan"],
  ["content only", { content: ["Raw"] }, "Raw"],
  ["both", { summary: ["Plan"], content: ["Raw"] }, "Plan\n\nRaw"],
  ["both, repeated", { summary: ["Same"], content: ["Same"] }, "Same"],
  [
    "summary with its own repeat",
    { summary: ["check", "retry", "check"], content: ["retry", "Raw"] },
    "check\n\nretry\n\ncheck\n\nRaw",
  ],
])("shows Codex reasoning from its %s", (_, reasoning, text) => {
  const [mapped] = codexTurns(
    [turn({ items: [{ type: "reasoning", id: "r1", ...reasoning }] })],
    conversation,
  );
  expect(mapped?.items).toEqual([
    expect.objectContaining({ type: "thought", text }),
  ]);
});
it("shows the command the model wrote, not the login shell running it", () => {
  expect(shellCommand("/bin/zsh -lc 'git diff --stat'")).toBe(
    "git diff --stat",
  );
  expect(shellCommand(`/bin/bash -lc 'echo '"'"'hi'"'"''`)).toBe("echo 'hi'");
  expect(shellCommand(`/bin/zsh -lc "sed -n '1,9p' a | grep \\"\\$x\\""`)).toBe(
    `sed -n '1,9p' a | grep "$x"`,
  );
  expect(shellCommand("pnpm test")).toBe("pnpm test");
});

it("shows a reply posted in a subthread as the agent's message", () => {
  const [mapped] = codexTurns(
    [
      turn({
        items: [
          {
            type: "dynamicToolCall",
            id: "d1",
            namespace: "buzz",
            tool: "reply_in_subthread",
            arguments: { parent: root, text: "Nested" },
            status: "completed",
            contentItems: [{ type: "inputText", text: "sent" }],
            success: true,
          },
        ],
      }),
    ],
    conversation,
  );
  expect(mapped?.items).toEqual([
    expect.objectContaining({ type: "message", text: "Nested", posted: true }),
  ]);
});

it("keeps a send that failed or has not finished as a tool call", () => {
  const send = (id: string, patch: Record<string, unknown>) => ({
    type: "dynamicToolCall",
    id,
    namespace: "buzz",
    tool: "send",
    arguments: { text: "Done" },
    ...patch,
  });
  const [mapped] = codexTurns(
    [
      turn({
        items: [
          send("d1", {
            status: "completed",
            contentItems: [{ type: "inputText", text: "channel not found" }],
            success: false,
          }),
          send("d2", {
            status: "inProgress",
            contentItems: null,
            success: null,
          }),
        ],
      }),
    ],
    conversation,
  );
  expect(mapped?.items).toEqual([
    expect.objectContaining({
      type: "tool",
      title: "buzz.send",
      status: "failed",
      output: "channel not found",
    }),
    expect.objectContaining({
      type: "tool",
      title: "buzz.send",
      status: "in_progress",
    }),
  ]);
});

/** An app-server answering `thread/turns/list` as the test says, with the
 * turns' items through `thread/items/list` when listed without them, and
 * `thread/list` from `threads` as Codex searches names: only the default
 * provider's threads, here none, unless asked for every provider's. */
function server(
  list: (params: Record<string, unknown>) => Wire,
  threads: { id: string; name: string; updatedAt: number }[] = [],
  rollout?: string | (() => string),
  path = "/sessions/rollout.jsonl",
) {
  const sent: Wire[] = [];
  const items = new Map<string, unknown[]>();
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    if (_id === "read" || _id === "read-from") {
      // Match the desktop host's process-directory contract.
      if (options?.cwd && !options.cwd.startsWith("/"))
        throw new Error("The process directory must be absolute");
      const file = typeof rollout === "function" ? rollout() : rollout;
      // `read-from` is `tail -c +N`: from byte N, counting from 1.
      const from = _id === "read" ? 0 : Number(options?.args?.[1]) - 1;
      const shrank = file !== undefined && from > file.length;
      if (file === undefined) options?.onStderr?.("file unavailable");
      else if (shrank) options?.onStderr?.(`${path} shrank`);
      else options?.onStdout?.(btoa(file.slice(from)));
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(file === undefined ? 1 : shrank ? 3 : 0),
      };
    }
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    return {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        sent.push(wire);
        if (wire.id == null) return;
        const params = wire.params as Record<string, unknown>;
        const reply =
          wire.method === "thread/turns/list"
            ? unloaded(list(params), params, items)
            : wire.method === "thread/items/list"
              ? itemPage(items, params)
              : wire.method === "thread/read"
                ? { result: { thread: { path } } }
                : wire.method === "thread/list"
                  ? {
                      result: {
                        data: threads.filter(
                          (thread) =>
                            Array.isArray(params.modelProviders) &&
                            !params.modelProviders.length &&
                            thread.name.includes(String(params.searchTerm)),
                        ),
                      },
                    }
                  : { result: {} };
        options?.onStdout?.(`${JSON.stringify({ id: wire.id, ...reply })}\n`);
      },
      end: async () => exit(0),
      kill: async () => exit(1),
      exited,
    };
  });
  return { spawn, sent };
}

/** A `thread/turns/list` answer without its turns' items, as Codex gives for
 * `itemsView: "notLoaded"`, keeping them for `thread/items/list`. */
function unloaded(
  reply: Wire,
  { itemsView }: Record<string, unknown>,
  items: Map<string, unknown[]>,
): Wire {
  const result = reply.result as
    | { data?: Record<string, unknown>[] }
    | undefined;
  if (itemsView !== "notLoaded" || !result?.data) return reply;
  const data = result.data.map(({ items: all, ...turn }) => {
    items.set(String(turn.id), all as unknown[]);
    return { ...turn, items: [] };
  });
  return { result: { ...result, data } };
}

/** `thread/items/list` over a turn's items, oldest first, a page at a time. */
function itemPage(
  items: Map<string, unknown[]>,
  { turnId, limit, cursor }: Record<string, unknown>,
): Wire {
  const all = items.get(String(turnId)) ?? [];
  const start = Number(cursor ?? 0);
  const end = start + Number(limit);
  return {
    result: {
      data: all.slice(start, end).map((item) => ({ item, turnId })),
      nextCursor: end < all.length ? String(end) : null,
    },
  };
}

/** `thread/turns/list` over a thread's turns, newest first, a page at a time. */
const paged =
  (newest: unknown[]) =>
  ({ limit, cursor }: Record<string, unknown>): Wire => {
    const start = Number(cursor ?? 0);
    const end = start + Number(limit);
    return {
      result: {
        data: newest.slice(start, end),
        nextCursor: end < newest.length ? String(end) : null,
      },
    };
  };

it("loads the recorded script through the declared file reader, and reports unavailable details", async () => {
  const rollout = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "script",
        name: "exec",
        input: "text(42)",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "script",
        output: "42",
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  const { spawn } = server(paged([turn({ items: [] })]), [], rollout);
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(spawn).toHaveBeenCalledWith(
    "read",
    expect.objectContaining({ args: ["/sessions/rollout.jsonl"] }),
  );
  expect(read?.turns[0]?.items).toMatchObject([
    { title: "exec", input: "text(42)", output: "42" },
  ]);
  const unavailable = server(paged([turn()]));
  const fallback = await readTranscript(
    unavailable.spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(fallback?.turns[0]?.items[0]).toMatchObject({
    type: "status",
    text: expect.stringContaining("CodeMode scripts could not be loaded"),
  });
  expect(fallback?.turns[0]?.items).toContainEqual(
    expect.objectContaining({ title: "pnpm test" }),
  );
});

it("reads only what a rollout appended since its last read, showing the same recorded tools", async () => {
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "script",
        name: "exec",
        input: "text(42)",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "script",
        output: "42",
      },
    },
  ].map((record) => JSON.stringify(record));
  // The first read ends partway through the output record.
  const cut = `${records.slice(0, 2).join("\n")}\n${records[2]?.slice(0, 20)}`;
  let file = cut;
  const path = "/sessions/appended.jsonl";
  // While its turn works, the rollout is remembered between reads.
  const working = () =>
    paged([turn({ items: [], status: "inProgress", completedAt: null })]);
  const { spawn } = server(working(), [], () => file, path);
  const lookupOne = { ...lookup, threadId: "thread-1" };
  const first = await readTranscript(
    spawn,
    lookupOne,
    new AbortController().signal,
  );
  expect(first?.turns[0]?.items).toMatchObject([
    { title: "exec", input: "text(42)" },
  ]);
  file = records.join("\n");
  const second = await readTranscript(
    spawn,
    lookupOne,
    new AbortController().signal,
  );
  // From the partial line on, not the whole file again.
  const whole = records.slice(0, 2).join("\n").length + 1;
  expect(spawn).toHaveBeenLastCalledWith(
    "read-from",
    expect.objectContaining({ args: [path, String(whole + 1)] }),
  );
  const fresh = await readTranscript(
    server(working(), [], file, "/sessions/fresh.jsonl").spawn,
    lookupOne,
    new AbortController().signal,
  );
  expect(second?.turns).toEqual(fresh?.turns);
  // A file that shrank is read whole again, not from the old text.
  file = records.slice(0, 2).join("\n");
  const shrunk = await readTranscript(
    spawn,
    lookupOne,
    new AbortController().signal,
  );
  expect(
    spawn.mock.calls.filter(
      ([id, options]) => id === "read" && options?.args?.[0] === path,
    ),
  ).toHaveLength(2);
  expect(shrunk?.turns).toEqual(
    (
      await readTranscript(
        server(working(), [], file, "/sessions/shrunk.jsonl").spawn,
        lookupOne,
        new AbortController().signal,
      )
    )?.turns,
  );
  expect(second?.turns[0]?.items).toMatchObject([
    { title: "exec", input: "text(42)", output: "42" },
  ]);
});

it("reads the latest turns oldest first, and closes its app-server", async () => {
  const { spawn, sent } = server(
    paged([
      turn({ id: "turn-2", status: "inProgress", completedAt: null }),
      turn(),
      ...Array.from({ length: TURN_LIMIT }, (_, index) =>
        turn({ id: `earlier-${index}`, startedAt: 99 - index }),
      ),
    ]),
  );
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(spawn).toHaveBeenCalledWith("app-server", expect.anything());
  expect(
    sent.filter((w) => w.method === "thread/turns/list").map((w) => w.params),
  ).toEqual([
    {
      threadId: "thread-1",
      limit: TURN_LIMIT,
      sortDirection: "desc",
      itemsView: "notLoaded",
    },
  ]);
  expect(read?.turns).toHaveLength(TURN_LIMIT);
  expect(read?.turns.slice(-2).map((t) => t.turnId)).toEqual([
    "turn-1",
    "turn-2",
  ]);
  expect(read).toMatchObject({ more: true, working: true });
});

it("reads turns that each fit app-server's output frame but together do not", async () => {
  // Three turns of 1.5 MiB: one per frame fits the 4 MiB bound, all three not.
  const big = (id: string) =>
    turn({
      id,
      items: [
        {
          type: "commandExecution",
          id: "c",
          command: "cat log",
          aggregatedOutput: "x".repeat(1.5 * 1024 * 1024),
          status: "completed",
        },
      ],
    });
  const { spawn } = server(paged([big("c"), big("b"), big("a")]));
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(read?.turns.map((t) => t.turnId)).toEqual(["a", "b", "c"]);
  expect(read?.more).toBe(false);
});

it("reads a turn whose items together exceed app-server's output frame", async () => {
  // A long turn of 100 small commands: 4.4 MiB as one frame, over the 4 MiB
  // bound, while each page of its items fits.
  const commands = Array.from({ length: 100 }, (_, index) => ({
    type: "commandExecution",
    id: `c${index}`,
    command: "cat log",
    aggregatedOutput: "x".repeat(45 * 1024),
    status: "completed",
  }));
  const { spawn, sent } = server(paged([turn({ items: commands })]));
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(
    read?.turns[0]?.items.filter((item) => item.type === "tool"),
  ).toHaveLength(100);
  expect(
    sent.filter((w) => w.method === "thread/items/list").map((w) => w.params),
  ).toEqual([
    { threadId: "thread-1", turnId: "turn-1", limit: 50 },
    { threadId: "thread-1", turnId: "turn-1", limit: 50, cursor: "50" },
  ]);
});

it("reads a page over app-server's output frame again on a fresh connection, at half the size", async () => {
  // 40 items of 200 KiB: a page of 50 or 25 is over the 4 MiB bound, 13 fit.
  const commands = Array.from({ length: 40 }, (_, index) => ({
    type: "commandExecution",
    id: `c${index}`,
    command: "cat log",
    aggregatedOutput: "x".repeat(200 * 1024),
    status: "completed",
  }));
  const { spawn, sent } = server(paged([turn({ items: commands })]));
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(
    read?.turns[0]?.items.filter((item) => item.type === "tool"),
  ).toHaveLength(40);
  const page = (limit: number, cursor?: string) => ({
    threadId: "thread-1",
    turnId: "turn-1",
    limit,
    ...(cursor ? { cursor } : {}),
  });
  expect(
    sent.filter((w) => w.method === "thread/items/list").map((w) => w.params),
  ).toEqual([
    page(50),
    page(25),
    page(13),
    page(13, "13"),
    page(13, "26"),
    page(13, "39"),
  ]);
  expect(spawn.mock.calls.filter(([id]) => id === "app-server")).toHaveLength(
    3,
  );
});

it("starts each turn's items at the page size the previous turn ended on", async () => {
  // 40 items of 200 KiB per turn: 13 fit a frame, so only the first turn
  // halves its page down to them.
  const big = (id: string) =>
    turn({
      id,
      items: Array.from({ length: 40 }, (_, index) => ({
        type: "commandExecution",
        id: `c${index}`,
        command: "cat log",
        aggregatedOutput: "x".repeat(200 * 1024),
        status: "completed",
      })),
    });
  const { spawn, sent } = server(paged([big("b"), big("a")]));
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(
    read?.turns.map((t) => t.items.filter((i) => i.type === "tool").length),
  ).toEqual([40, 40]);
  expect(
    sent
      .filter((w) => w.method === "thread/items/list")
      .map((w) => (w.params as { limit: number }).limit),
  ).toEqual([50, 25, 13, 13, 13, 13, 13, 13, 13, 13]);
  expect(spawn.mock.calls.filter(([id]) => id === "app-server")).toHaveLength(
    3,
  );
});

it("stops a transcript aborted while reopening after an oversized page", async () => {
  const commands = Array.from({ length: 40 }, (_, index) => ({
    type: "commandExecution",
    id: `c${index}`,
    command: "cat log",
    aggregatedOutput: "x".repeat(200 * 1024),
    status: "completed",
  }));
  const { spawn, sent } = server(paged([turn({ items: commands })]));
  const controller = new AbortController();
  let opened = 0;
  const aborting: typeof spawn = vi.fn(async (id, options) => {
    const process = await spawn(id, options);
    if (id !== "app-server") return process;
    const n = ++opened;
    return {
      ...process,
      end: async () => {
        // The transcript is closed while the oversized connection is closing.
        if (n === 1) controller.abort();
        await process.end();
      },
    };
  });
  await expect(
    readTranscript(
      aborting,
      { ...lookup, threadId: "thread-1" },
      controller.signal,
    ),
  ).rejects.toThrow(/abort/i);
  expect(
    sent
      .filter((w) => w.method === "thread/items/list")
      .map((w) => (w.params as { limit: number }).limit),
  ).toEqual([50]);
  // No fresh app-server is opened for the aborted transcript.
  expect(opened).toBe(1);
});

it("fails a transcript with an item over app-server's output frame", async () => {
  const huge = {
    type: "commandExecution",
    id: "c1",
    command: "cat log",
    aggregatedOutput: "x".repeat(5 * 1024 * 1024),
    status: "completed",
  };
  const { spawn, sent } = server(paged([turn({ items: [huge] })]));
  await expect(
    readTranscript(
      spawn,
      { ...lookup, threadId: "thread-1" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Codex output frame is too large");
  expect(
    sent
      .filter((w) => w.method === "thread/items/list")
      .map((w) => (w.params as { limit: number }).limit),
  ).toEqual([50, 25, 13, 7, 4, 2, 1]);
});

it("refuses a remembered rollout that grew past a full read's limit, without rereading it", async () => {
  const half = `${"x".repeat(30 * 1024 * 1024)}\n`;
  let file = half;
  const path = "/sessions/large.jsonl";
  const { spawn } = server(
    paged([turn({ items: [], status: "inProgress", completedAt: null })]),
    [],
    () => file,
    path,
  );
  const lookupOne = { ...lookup, threadId: "thread-1" };
  const signal = new AbortController().signal;
  await readTranscript(spawn, lookupOne, signal);
  file = half + half;
  for (const more of ["", "y\n", ""]) {
    file += more;
    const grown = await readTranscript(spawn, lookupOne, signal);
    expect(JSON.stringify(grown?.turns)).toContain("larger than 50 MB");
    // Only what was appended is read, not the whole file again.
    expect(spawn).toHaveBeenLastCalledWith("read-from", expect.anything());
  }
  // A file that shrank is read whole again.
  file = '{"type":"event_msg"}\n';
  const fresh = await readTranscript(spawn, lookupOne, signal);
  expect(JSON.stringify(fresh?.turns)).not.toContain("larger than 50 MB");
  expect(spawn).toHaveBeenLastCalledWith(
    "read",
    expect.objectContaining({ args: [path] }),
  );
});

it("remembers a rollout while a thread found by name is in progress", async () => {
  const tag = sessionTag(agent.key, lookup);
  const path = "/sessions/named.jsonl";
  const { spawn } = server(
    paged([turn({ items: [], status: "inProgress", completedAt: null })]),
    [{ id: "tagged", name: `Named · ${tag}`, updatedAt: 1 }],
    '{"type":"event_msg"}\n',
    path,
  );
  const signal = new AbortController().signal;
  expect(lookup).not.toHaveProperty("threadId");
  await readTranscript(spawn, lookup, signal);
  await readTranscript(spawn, lookup, signal);
  expect(spawn).toHaveBeenLastCalledWith("read-from", expect.anything());
});

it("merges the threads other builds started, found by tag or by their earlier name", async () => {
  const tag = sessionTag(agent.key, lookup);
  const title = `Buzz #dev · thread ${root.slice(0, 8)} · Sol`;
  const threads = [
    { id: "tagged", name: `Renamed · ${tag}`, updatedAt: 3 },
    { id: "legacy", name: title, updatedAt: 2 },
    // Same name, from a same-named channel elsewhere.
    { id: "same-name", name: title, updatedAt: 9 },
    {
      id: "other-agent",
      name: `${title} · buzz:0000000000000000`,
      updatedAt: 4,
    },
  ];
  const started: Record<string, [number, string]> = {
    "thread-1": [300, "channel"],
    tagged: [200, "channel"],
    legacy: [100, "channel"],
    "same-name": [400, "elsewhere"],
  };
  const list = ({ threadId }: Record<string, unknown>): Wire => {
    const [startedAt, channel] = started[String(threadId)] ?? [0, ""];
    const text = `<context>\n${JSON.stringify({ channel_id: channel, session_thread: root })}\n</context>\nRequest: "hi"`;
    return {
      result: {
        data: [
          turn({
            id: String(threadId),
            startedAt,
            items: [
              {
                type: "userMessage",
                id: "u",
                content: [{ type: "text", text }],
              },
            ],
          }),
        ],
        nextCursor: null,
      },
    };
  };
  const { spawn, sent } = server(list, threads);
  const signal = new AbortController().signal;
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    signal,
  );
  expect(read?.turns.map((t) => t.turnId)).toEqual([
    "legacy",
    "tagged",
    "thread-1",
  ]);
  expect(
    sent.filter((w) => w.method === "thread/list").map((w) => w.params),
  ).toEqual([
    { searchTerm: tag, modelProviders: [], limit: 50, useStateDbOnly: true },
    { searchTerm: title, modelProviders: [], limit: 50, useStateDbOnly: true },
  ]);
  // With no saved thread, the newest one found for it is the conversation's.
  await expect(
    findConversation(server(list, threads).spawn, lookup, signal),
  ).resolves.toEqual({ threadId: "tagged", at: 3000 });
  await expect(
    findConversation(server(list, threads.slice(1)).spawn, lookup, signal),
  ).resolves.toEqual({ threadId: "legacy", at: 2000 });
  await expect(
    findConversation(
      server(list, []).spawn,
      { agent, channelId: "channel", name: "dev" },
      signal,
    ),
  ).resolves.toBeUndefined();
});

it("treats a thread Codex no longer has as missing, and other failures as errors", async () => {
  const signal = new AbortController().signal;
  const saved = { ...lookup, threadId: "thread-1" };
  const gone = server(() => ({
    error: { code: -32600, message: "thread not loaded: thread-1" },
  }));
  await expect(
    readTranscript(gone.spawn, saved, signal),
  ).resolves.toBeUndefined();
  const broken = server(() => ({
    error: { code: -32603, message: "database is locked" },
  }));
  await expect(readTranscript(broken.spawn, saved, signal)).rejects.toThrow(
    "database is locked",
  );
});
