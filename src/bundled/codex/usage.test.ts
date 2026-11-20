import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import manifest from "./manifest.json";
import type { Wire } from "./rpc";
import { readUsage, rolloutUsage } from "./usage";

const agent = "a".repeat(64);
/** The agent in its home community, where its key is its pubkey. */
const sol = { key: agent, pubkey: agent };
const other = "b".repeat(64);
const root = "c".repeat(64);
const HOUR = 3_600_000;
const hour = Date.UTC(2026, 9, 16, 9);
const line = (ms: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: new Date(hour + ms).toISOString(),
    type,
    payload,
  });
const message = (ms: number, role: string, text: string) =>
  line(ms, "response_item", {
    type: "message",
    role,
    content: [{ type: "input_text", text }],
  });
const instructions = (who = agent, teammate = other) =>
  message(
    0,
    "developer",
    `You are Sol (pubkey ${who}), a coding agent in Buzz.\nTeam:\n- Relay (pubkey ${teammate})`,
  );
const prompt = message(
  1,
  "user",
  `<context>\n{"channel_id":"chan","session_scope":"thread","session_thread":"${root}"}\n</context>\n<buzz-event>\n{"id":"e"}\nRequest: "fix the \\u003ctests\\u003e\\nand lint"\n</buzz-event>`,
);
const model = (ms: number, name: string) =>
  line(ms, "turn_context", { model: name });
const record = (ms: number, input: number, cached: number, output: number) =>
  line(ms, "token_usage_record", {
    response_id: `resp-${ms}`,
    usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 1,
      total_tokens: input + output,
    },
  });

const subagent = [
  line(1500, "session_meta", { id: "review" }),
  model(1500, "gpt-6-luna"),
  record(1500, 20, 10, 2),
].join("\n");

it("observes each model response once, its input less the cached part, with its subagents", () => {
  const file = [
    line(0, "session_meta", { id: "t" }),
    instructions(),
    model(2, "gpt-6.1-sol"),
    prompt,
    record(1000, 100, 0, 10),
    // Running totals restate the record; they are not counted again.
    line(1001, "event_msg", {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 100 } },
    }),
    record(2000, 300, 250, 20),
    model(HOUR, "gpt-6-luna"),
    // Without the cache write count, the uncached input is unknown.
    line(HOUR + 5, "token_usage_record", {
      usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5 },
    }),
    '{"partial',
  ].join("\n");
  expect(rolloutUsage("t", file, [subagent], sol)).toEqual({
    id: "t",
    channelId: "chan",
    root,
    title: "fix the <tests>",
    startedAt: hour,
    lastAt: hour + HOUR + 5,
    gaps: [],
    observations: [
      {
        requestId: "resp-1000",
        at: hour + 1000,
        model: "gpt-6.1-sol",
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      },
      {
        requestId: "resp-2000",
        at: hour + 2000,
        model: "gpt-6.1-sol",
        tokens: { input: 50, output: 20, cacheRead: 250, cacheWrite: 0 },
      },
      {
        at: hour + HOUR + 5,
        model: "gpt-6-luna",
        tokens: { output: 5, cacheRead: 40 },
      },
      // The review subagent Codex spawned for the thread.
      {
        requestId: "resp-1500",
        at: hour + 1500,
        model: "gpt-6-luna",
        tokens: { input: 10, output: 2, cacheRead: 10, cacheWrite: 0 },
      },
    ],
  });
  // A subagent's rollout gone, or a finished line unreadable, is a gap.
  expect(
    rolloutUsage("t", file.replace(prompt, `{x\n${prompt}`), [undefined], sol)
      ?.gaps,
  ).toEqual(["A subagent’s rollout is gone", "1 rollout line unreadable"]);
});

it("keeps only threads Buzz started for this agent", () => {
  const work = record(1000, 1, 0, 1);
  // A teammate's thread names the agent only in its team section.
  expect(
    rolloutUsage(
      "t",
      [instructions(other, agent), prompt, work].join("\n"),
      [],
      sol,
    ),
  ).toBeUndefined();
  // The person's own Codex thread has no Buzz context.
  expect(
    rolloutUsage(
      "t",
      [instructions(), message(1, "user", "hi"), work].join("\n"),
      [],
      sol,
    ),
  ).toBeUndefined();
  // Each community's threads are its membership's; one from before agents
  // joined several communities is its home's.
  const there = { key: `${agent}@other.example`, pubkey: agent };
  const scoped = [
    instructions(),
    message(
      1,
      "user",
      `<context>\n{"agent":"${there.key}","channel_id":"chan"}\n</context>\nRequest: "hi"`,
    ),
    work,
  ].join("\n");
  const unscoped = [instructions(), prompt, work].join("\n");
  expect(rolloutUsage("t", scoped, [], there)?.channelId).toBe("chan");
  expect(rolloutUsage("t", scoped, [], sol)).toBeUndefined();
  expect(rolloutUsage("t", unscoped, [], sol)?.channelId).toBe("chan");
  expect(rolloutUsage("t", unscoped, [], there)).toBeUndefined();
});

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

it("finds the agent's threads by name, reads their rollouts, and later only those Codex updated", async () => {
  home = mkdtempSync(join(tmpdir(), "codex-usage-"));
  const rollout = (
    name: string,
    who: string,
    content = [
      instructions(who),
      model(2, "gpt-6.1-sol"),
      prompt,
      record(1000, 4, 0, 2),
    ].join("\n"),
  ) => {
    const path = join(home ?? "", `${name}.jsonl`);
    writeFileSync(path, content);
    return path;
  };
  const updatedAt = (hour + 1000) / 1000;
  const threads = [
    {
      id: "mine",
      name: "Buzz #dev · Sol · buzz:1",
      path: rollout("mine", agent),
      updatedAt,
    },
    // Another agent named Sol, in another build.
    {
      id: "theirs",
      name: "Buzz #dev · Sol",
      path: rollout("theirs", other),
      updatedAt,
    },
    {
      id: "gone",
      name: "Buzz #dev · Sol",
      path: join(home, "gone.jsonl"),
      updatedAt,
    },
    {
      id: "old",
      name: "Buzz #old · Sol",
      path: rollout("old", agent),
      updatedAt: updatedAt - 86_400,
    },
    {
      id: "unrelated",
      name: "Fix the build",
      path: rollout("unrelated", agent),
      updatedAt,
    },
    // Subagents the thread spawned, unnamed, and one of theirs.
    {
      id: "review",
      parentThreadId: "mine",
      name: "",
      path: rollout("review", agent, subagent),
      updatedAt,
    },
    {
      id: "nested",
      parentThreadId: "review",
      name: "",
      path: rollout("nested", agent, subagent),
      updatedAt,
    },
  ];
  const searches: unknown[] = [];
  let scans = 0;
  const spawn = processes((params) => {
    // As Codex does, list only the default provider's threads, here none,
    // unless asked for every provider's.
    const every =
      Array.isArray(params.modelProviders) && !params.modelProviders.length;
    if (!every) return { data: [], nextCursor: null };
    searches.push(params.searchTerm ?? params.parentThreadId);
    // Answered from Codex's thread database, not a scan of every rollout.
    if (params.useStateDbOnly !== true) scans += 1;
    // One thread a page.
    const start = Number(params.cursor ?? 0);
    const found = threads.filter((thread) =>
      params.parentThreadId
        ? thread.parentThreadId === params.parentThreadId
        : thread.name.includes(String(params.searchTerm)),
    );
    return {
      data: found.slice(start, start + 1),
      nextCursor: start + 1 < found.length ? String(start + 1) : null,
    };
  });
  const reads: string[] = [];
  const host = {
    spawn,
    readFile: async (path: string) => {
      reads.push(path.slice(path.lastIndexOf("/") + 1));
      return new Uint8Array(await readFile(path));
    },
  };
  const read = () =>
    readUsage(
      host,
      { ...sol, name: "Sol" },
      hour - HOUR,
      new AbortController().signal,
    );
  const sessions = await read();
  expect(sessions.map((session) => session.id)).toEqual(["mine"]);
  expect(scans).toBe(0);
  // The thread's own response, and one from each of its subagents.
  expect(
    sessions[0]?.observations.map((entry) => [entry.model, entry.tokens]),
  ).toEqual([
    ["gpt-6.1-sol", { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }],
    ["gpt-6-luna", { input: 10, output: 2, cacheRead: 10, cacheWrite: 0 }],
    ["gpt-6-luna", { input: 10, output: 2, cacheRead: 10, cacheWrite: 0 }],
  ]);
  // Each name match in the period, and each subagent, is asked for its own.
  expect(searches.sort()).toEqual(
    [
      "· Sol",
      "· Sol",
      "· Sol",
      "· Sol",
      "gone",
      "mine",
      "nested",
      "review",
      "theirs",
    ].sort(),
  );
  expect(reads.sort()).toEqual(
    ["gone", "mine", "nested", "review", "theirs"].map(
      (name) => `${name}.jsonl`,
    ),
  );

  // Again: only the thread whose subagent Codex updated is read, and the one
  // whose rollout was gone.
  reads.length = 0;
  const review = threads.find((thread) => thread.id === "review");
  if (review) review.updatedAt += 60;
  expect((await read()).map((session) => session.id)).toEqual(["mine"]);
  expect(reads.sort()).toEqual(
    ["gone", "mine", "nested", "review"].map((name) => `${name}.jsonl`),
  );
  reads.length = 0;
  await read();
  expect(reads).toEqual(["gone.jsonl"]);
});

it("reads at most four rollouts at once, across agents and their subagents", async () => {
  const updatedAt = (hour + 1000) / 1000;
  const threads = [
    { who: agent, name: "Sol" },
    { who: other, name: "Ra" },
  ].flatMap(({ who, name }) => [
    {
      id: name,
      parentThreadId: undefined as string | undefined,
      name: `Buzz #dev · ${name}`,
      who,
      updatedAt,
    },
    ...[1, 2, 3].map((index) => ({
      id: `${name}-${index}`,
      parentThreadId: name,
      name: "",
      who,
      updatedAt,
    })),
  ]);
  const spawn = processes((params) => ({
    data: threads
      .filter((thread) =>
        params.parentThreadId
          ? thread.parentThreadId === params.parentThreadId
          : thread.name.includes(String(params.searchTerm)),
      )
      .map((thread) => ({ ...thread, path: `/${thread.id}.jsonl` })),
    nextCursor: null,
  }));
  let open = 0;
  let most = 0;
  const readFile = async (path: string) => {
    const thread = threads.find(({ id }) => path === `/${id}.jsonl`);
    open += 1;
    most = Math.max(most, open);
    await new Promise((resolve) => setTimeout(resolve));
    open -= 1;
    return new TextEncoder().encode(
      thread?.parentThreadId
        ? subagent
        : [instructions(thread?.who), prompt, record(1000, 4, 0, 2)].join("\n"),
    );
  };
  const found = await Promise.all(
    [
      { ...sol, name: "Sol" },
      { key: other, pubkey: other, name: "Ra" },
    ].map((who) =>
      readUsage(
        { spawn, readFile },
        who,
        hour - HOUR,
        new AbortController().signal,
      ),
    ),
  );
  expect(
    found.map((sessions) => sessions.map((session) => session.id)),
  ).toEqual([["Sol"], ["Ra"]]);
  expect(most).toBe(4);
});

/** `thread/list` as `list` answers it, from a fake app-server, and the
 * manifest's `read` for real. */
function processes(list: (params: Record<string, unknown>) => unknown) {
  return async (id: string, options: HostProcessOptions = {}) => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    if (id === "read") {
      const declared = manifest.host.processes.find(
        (process) => process.id === id,
      );
      if (!declared) throw new Error(`undeclared process ${id}`);
      const child = execFile(
        declared.program,
        [...(declared.args ?? []), ...(options.args ?? [])],
        { cwd: options.cwd, maxBuffer: 1 << 26 },
        (error) => exit(error ? Number(error.code) || 1 : 0),
      );
      child.stdout?.on("data", (data) => options.onStdout?.(String(data)));
      child.stderr?.on("data", (data) => options.onStderr?.(String(data)));
    } else if (id !== "app-server") throw new Error(`unexpected process ${id}`);
    return {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        if (wire.id == null) return;
        const result =
          wire.method === "thread/list"
            ? list(wire.params as Record<string, unknown>)
            : {};
        options.onStdout?.(`${JSON.stringify({ id: wire.id, result })}\n`);
      },
      end: async () => exit(0),
      kill: async () => exit(1),
      exited,
    };
  };
}

it("keeps a rootless community wake as the usage origin before later channel work", () => {
  const wake = message(
    1,
    "user",
    `<context>\n${JSON.stringify({ agent, session_scope: "community" })}\n</context>\ncheck`,
  );
  const initial = [instructions(), wake, record(1000, 100, 0, 10)];
  const first = rolloutUsage("shared", initial.join("\n"), [], sol);
  expect(first?.observations).toHaveLength(1);
  expect(first?.channelId).toBeUndefined();
  const later = rolloutUsage(
    "shared",
    [...initial, prompt, record(2000, 100, 0, 10)].join("\n"),
    [],
    sol,
  );
  expect(later?.observations).toHaveLength(2);
  expect(later?.channelId).toBeUndefined();
  expect(later?.root).toBeUndefined();
});
