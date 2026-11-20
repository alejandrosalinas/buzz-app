// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { TranscriptTurn } from "../../features/agents/activity-transcript";
import { steerPrompt } from "../claude-code/prompt";
import {
  type PiEntry,
  piTurns,
  readTranscript,
  TURN_LIMIT,
} from "./transcript";

const PLACE = { conversation: 2, channelId: "chan", root: "root" };
const event = (text: string) =>
  `<buzz-event>\nFrom: Sal (npub1x)\nContent: ${text}\nTags: []\n</buzz-event>`;
const user = (id: number, text: string, timestamp = id): PiEntry => ({
  id,
  kind: "pi.user",
  model: [{ role: "user", content: text, timestamp }],
});
const assistant = (
  id: number,
  content: NonNullable<NonNullable<PiEntry["model"]>[number]["content"]>,
  more: Record<string, unknown> = {},
): PiEntry => ({
  id,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content,
      timestamp: id,
      model: "claude-x",
      ...more,
    },
  ],
});
const result = (id: number, call: string, text: string, isError = false) => ({
  id,
  kind: "pi.tool-result",
  model: [
    {
      role: "toolResult",
      toolCallId: call,
      content: [{ type: "text", text }],
      isError,
      timestamp: id,
    },
  ],
});

it("shows a turn's prompt, thinking, tools, sends and answer, steers included", () => {
  const [turn, ...others] = piTurns(
    [
      user(1, event("write a file")),
      { id: 2, kind: "pi.system" },
      assistant(3, [
        { type: "thinking", thinking: "Let me write it" },
        {
          type: "toolCall",
          id: "c1",
          name: "write",
          arguments: { path: "a.txt", content: "hi" },
        },
      ]),
      result(4, "c1", "Wrote a.txt"),
      user(5, steerPrompt(event("and read it"))),
      assistant(6, [
        {
          type: "toolCall",
          id: "c2",
          name: "buzz_send",
          arguments: { text: "On it" },
        },
        {
          type: "toolCall",
          id: "c3",
          name: "buzz_send",
          arguments: { text: "Lost" },
        },
        { type: "toolCall", id: "c4", name: "buzz_read", arguments: {} },
      ]),
      result(7, "c2", `sent ${"c".repeat(64)}`),
      result(8, "c3", "Not allowed", true),
      result(9, "c4", "messages"),
      assistant(10, [{ type: "text", text: "Done" }]),
    ],
    PLACE,
    false,
  );
  expect(others).toEqual([]);
  expect(turn).toMatchObject({
    turnId: "1:0",
    channelId: "chan",
    threadRootId: "root",
    sessionId: "2",
    config: ["claude-x"],
    startedAt: 1,
    endedAt: 10,
    partial: false,
  });
  expect(
    turn?.items.map((item) =>
      item.type === "prompt"
        ? ["prompt", item.text, item.author, item.steer]
        : item.type === "tool"
          ? [
              "tool",
              item.title,
              item.kind,
              item.status,
              item.output,
              item.paths,
            ]
          : item.type === "message"
            ? ["message", item.text, item.posted, item.messageId]
            : [item.type, "text" in item ? item.text : ""],
    ),
  ).toEqual([
    ["prompt", "write a file", "Sal", false],
    ["thought", "Let me write it"],
    ["tool", "write", "edit", "completed", "Wrote a.txt", ["a.txt"]],
    ["prompt", "and read it", "Sal", true],
    ["message", "On it", true, "c".repeat(64)],
    ["message", "Lost", undefined, undefined],
    ["tool", "buzz.read", "other", "completed", "messages", []],
    ["status", "The message above was not posted: Not allowed"],
    ["message", "Done", undefined, undefined],
  ]);
});

it("shows a reply in a subthread as a message, posted or not", () => {
  const nested = (id: string) => ({
    type: "toolCall",
    id,
    name: "buzz_reply_in_subthread",
    arguments: { parent: "root", text: id },
  });
  const [turn] = piTurns(
    [
      user(1, event("review it")),
      assistant(2, [nested("n1"), nested("n2")]),
      result(3, "n1", "sent"),
      result(4, "n2", "Not allowed", true),
    ],
    PLACE,
    false,
  );
  expect(turn?.items.slice(1)).toEqual([
    expect.objectContaining({ type: "message", text: "n1", posted: true }),
    expect.not.objectContaining({ posted: true }),
    expect.objectContaining({
      type: "status",
      text: "The message above was not posted: Not allowed",
    }),
  ]);
});

it("ends each turn at the next prompt, and keeps a working one open", () => {
  const turns = piTurns(
    [
      user(1, event("first")),
      assistant(2, [], { stopReason: "error", errorMessage: "Rate limited" }),
      user(3, event("second")),
      assistant(4, [{ type: "text", text: "Working on it" }], {
        stopReason: "aborted",
      }),
    ],
    PLACE,
    true,
  );
  expect(
    turns.map(({ endedAt, error, stopReason }) => ({
      endedAt,
      error,
      stopReason,
    })),
  ).toEqual([
    { endedAt: 2, error: "Rate limited", stopReason: undefined },
    { endedAt: undefined, error: undefined, stopReason: "stopped" },
  ]);
});

it("counts only the last attempt of a turn Pi retried", () => {
  const [turn] = piTurns(
    [
      user(1, event("first")),
      assistant(2, [], { stopReason: "error", errorMessage: "Overloaded" }),
      assistant(3, [{ type: "text", text: "Done" }], { stopReason: "stop" }),
    ],
    PLACE,
    false,
  );
  expect(turn?.endedAt).toBe(3);
  expect(turn?.error).toBeUndefined();
});

it("replaces an interrupted run's partial answer with the one that continues it, and keeps a stopped one", () => {
  const texts = (turn?: TranscriptTurn) =>
    turn?.items.flatMap((item) => (item.type === "message" ? [item.text] : []));
  const partial = assistant(2, [{ type: "text", text: "Working on" }], {
    stopReason: "aborted",
  });
  const [resumed] = piTurns(
    [
      user(1, event("first")),
      partial,
      assistant(3, [{ type: "text", text: "Working on it. Done." }], {
        stopReason: "stop",
      }),
    ],
    PLACE,
    false,
  );
  expect(resumed?.stopReason).toBeUndefined();
  expect(texts(resumed)).toEqual(["Working on it. Done."]);
  const [stopped, next] = piTurns(
    [
      user(1, event("first")),
      partial,
      user(3, event("second")),
      assistant(4, [{ type: "text", text: "Done" }], { stopReason: "stop" }),
    ],
    PLACE,
    false,
  );
  expect(stopped?.stopReason).toBe("stopped");
  expect(texts(stopped)).toEqual(["Working on"]);
  expect(next?.stopReason).toBeUndefined();
});

it("shows a Stop during a tool call as stopped, unless the run went on", () => {
  const call = (id: number, name: string) =>
    assistant(
      id,
      [{ type: "toolCall", id: `c${id}`, name, arguments: { command: name } }],
      { stopReason: "toolUse" },
    );
  const cut = (id: number, call: string) => ({
    ...result(id, call, "[error] Tool bash was aborted", true),
    aborted: true,
  });
  const tool = (turn?: TranscriptTurn) =>
    turn?.items.flatMap((item) => (item.type === "tool" ? [item.status] : []));
  const [stopped, failed] = piTurns(
    [
      user(1, event("first")),
      call(2, "bash"),
      cut(3, "c2"),
      user(4, event("second")),
      call(5, "ls"),
      result(6, "c5", "No such file", true),
      assistant(7, [{ type: "text", text: "It failed" }], {
        stopReason: "stop",
      }),
    ],
    PLACE,
    false,
  );
  expect(stopped?.stopReason).toBe("stopped");
  expect(tool(stopped)).toEqual(["terminated"]);
  expect(failed?.stopReason).toBeUndefined();
  expect(tool(failed)).toEqual(["failed"]);
  // Aborting one call alone lets the run answer after it.
  const [continued] = piTurns(
    [
      user(1, event("first")),
      call(2, "bash"),
      cut(3, "c2"),
      assistant(4, [{ type: "text", text: "Done" }], { stopReason: "stop" }),
    ],
    PLACE,
    false,
  );
  expect(continued?.stopReason).toBeUndefined();
  expect(tool(continued)).toEqual(["terminated"]);
});

it("reads pages, newest first, until one turn more than it shows", async () => {
  // Two entries a turn, a page of three entries at a time.
  const entries = Array.from({ length: (TURN_LIMIT + 5) * 2 }, (_, index) =>
    index % 2
      ? assistant(index, [{ type: "text", text: `answer ${index}` }])
      : user(index, event(`prompt ${index}`)),
  ).reverse();
  const request = vi.fn(
    async (_method: string, params: Record<string, unknown>) => {
      const from = Number(params.cursor ?? 0);
      return {
        entries: entries.slice(from, from + 3),
        ...(from + 3 < entries.length ? { next: String(from + 3) } : {}),
      };
    },
  );
  const read = await readTranscript(
    { request } as never,
    "agent",
    PLACE,
    false,
    new AbortController().signal,
  );
  expect(read.more).toBe(true);
  expect(read.turns).toHaveLength(TURN_LIMIT);
  expect(read.turns.at(-1)?.items.at(-1)).toMatchObject({
    text: `answer ${(TURN_LIMIT + 5) * 2 - 1}`,
  });
  expect(read.turns.every((turn) => !turn.partial)).toBe(true);
  // 51 prompts, newest first, are within the first 102 entries: 34 pages.
  expect(request).toHaveBeenCalledTimes(34);
  expect(request).toHaveBeenCalledWith("entries", {
    agent: "agent",
    conversation: 2,
  });
});

it("counts a noted turn that failed before Pi had its prompt as a turn when it reads pages", async () => {
  // Only such turns, a page of three entries at a time.
  const entries: PiEntry[] = Array.from(
    { length: TURN_LIMIT + 5 },
    (_, index) => ({
      id: index,
      kind: "buzz.notice",
      notice: "Ran without the agent gateway.",
      error: `failure ${index}`,
      at: index,
    }),
  ).reverse();
  const request = vi.fn(
    async (_method: string, params: Record<string, unknown>) => {
      const from = Number(params.cursor ?? 0);
      return {
        entries: entries.slice(from, from + 3),
        ...(from + 3 < entries.length ? { next: String(from + 3) } : {}),
      };
    },
  );
  const read = await readTranscript(
    { request } as never,
    "agent",
    PLACE,
    false,
    new AbortController().signal,
  );
  expect(read.more).toBe(true);
  expect(read.turns).toHaveLength(TURN_LIMIT);
  expect(read.turns.at(-1)).toMatchObject({
    error: `failure ${TURN_LIMIT + 4}`,
  });
  // 51 turns, newest first, are the first 51 entries: 17 pages, not all 19.
  expect(request).toHaveBeenCalledTimes(17);
});

it("names each session by the reset that began it, however old", async () => {
  // The window starts after older resets; one more is inside it.
  const entries = [
    user(10, event("older")),
    assistant(11, [{ type: "text", text: "a" }]),
    { id: 12, kind: "pi.reset" },
    user(13, event("newer")),
    assistant(14, [{ type: "text", text: "b" }]),
  ];
  // The host reads each page's oldest entry's session from Pi's own head
  // markers; the oldest page read names where the shown entries begin.
  const pages = [
    { entries: entries.slice(2).reverse(), next: "older", session: 12 },
    { entries: entries.slice(0, 2).reverse(), session: 7 },
  ];
  const request = vi.fn(async () => pages.shift());
  const read = await readTranscript(
    { request } as never,
    "agent",
    PLACE,
    false,
    new AbortController().signal,
  );
  expect(read.turns.map((turn) => [turn.sessionId, turn.newSession])).toEqual([
    ["2:7", true],
    ["2:12", true],
  ]);
  // A window that misses session 7's start shows none there.
  expect(
    piTurns(entries, PLACE, false, { session: 7, start: false }).map((turn) => [
      turn.sessionId,
      turn.newSession,
    ]),
  ).toEqual([
    ["2:7", false],
    ["2:12", true],
  ]);
});

it("starts a session at the conversation's first entry", () => {
  const turns = piTurns([user(1, event("hi"))], PLACE, false, {
    session: 0,
    start: true,
  });
  expect(turns[0]).toMatchObject({ sessionId: "2:0", newSession: true });
  // Without a session from the host, the conversation's own id.
  expect(piTurns([user(1, event("hi"))], PLACE, false)[0]).toMatchObject({
    sessionId: "2",
    newSession: false,
  });
});

it("shows a noted request's notice once, beside its turn's own outcome", () => {
  const NOTICE =
    "Ran without the agent gateway: Buzz couldn't reach the gateway.";
  const noted = (entry: PiEntry): PiEntry => ({ ...entry, notice: NOTICE });
  const steer = steerPrompt(event("and this"));
  const turns = piTurns(
    [
      noted(user(1, event("failed"))),
      assistant(2, [], { stopReason: "error", errorMessage: "Rate limited" }),
      noted(user(3, event("stopped"))),
      assistant(4, [{ type: "text", text: "Partly" }], {
        stopReason: "aborted",
      }),
      user(5, event("done")),
      noted(user(6, steer)),
      assistant(7, [{ type: "text", text: "Done" }], { stopReason: "stop" }),
      user(8, event("unnoted")),
      assistant(9, [{ type: "text", text: "Fine" }], { stopReason: "stop" }),
    ],
    PLACE,
    false,
  );
  expect(
    turns.map(({ items, error, stopReason }) => ({
      notices: items
        .filter((item) => item.type === "status")
        .map((item) => item.type === "status" && item.text),
      error,
      stopReason,
    })),
  ).toEqual([
    { notices: [NOTICE], error: "Rate limited", stopReason: undefined },
    { notices: [NOTICE], error: undefined, stopReason: "stopped" },
    // A steer noted joins the turn it steers.
    { notices: [NOTICE], error: undefined, stopReason: undefined },
    { notices: [], error: undefined, stopReason: undefined },
  ]);
  // Beside the prompt it noted, which still opens its turn.
  expect(turns[0]?.items.map((item) => item.type)).toEqual([
    "prompt",
    "status",
  ]);
});

it("shows a noted turn that failed before Pi had its prompt, with its notice and failure", () => {
  const NOTICE =
    "Ran without the agent gateway: Buzz couldn't reach the gateway.";
  const turns = piTurns(
    [
      user(1, event("earlier")),
      assistant(2, [{ type: "text", text: "Fine" }], { stopReason: "stop" }),
      {
        id: 3,
        kind: "buzz.notice",
        notice: NOTICE,
        error: "This agent has no model.",
        at: 500,
      },
    ],
    PLACE,
    false,
  );
  expect(turns).toHaveLength(2);
  expect(turns[1]).toMatchObject({
    turnId: "3",
    startedAt: 500,
    error: "This agent has no model.",
    items: [{ id: "3:notice", type: "status", text: NOTICE }],
  });
});

it("keeps a run's answers, tools and steers on its own turn when a noted wake fails beside it", () => {
  const NOTICE =
    "Ran without the agent gateway: Buzz couldn't reach the gateway.";
  const ERROR = "This agent has no model.";
  const turns = piTurns(
    [
      user(1, event("first")),
      assistant(
        2,
        [
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        {
          stopReason: "toolUse",
        },
      ),
      { id: 3, kind: "buzz.notice", notice: NOTICE, error: ERROR, at: 3 },
      result(4, "c1", "a b"),
      user(5, steerPrompt(event("and this"))),
      assistant(6, [{ type: "text", text: "first answer" }], {
        stopReason: "stop",
      }),
    ],
    PLACE,
    false,
  );
  expect(
    turns.map((turn) => ({
      turnId: turn.turnId,
      error: turn.error,
      items: turn.items.map((item) =>
        item.type === "tool"
          ? [item.type, item.status]
          : [item.type, "text" in item ? item.text : ""],
      ),
    })),
  ).toEqual([
    {
      turnId: "1:0",
      error: undefined,
      items: [
        ["prompt", expect.any(String)],
        ["tool", "completed"],
        ["prompt", expect.any(String)],
        ["message", "first answer"],
      ],
    },
    { turnId: "3", error: ERROR, items: [["status", NOTICE]] },
  ]);
  expect(turns[0]?.endedAt).toBe(6);
  expect(turns[1]?.endedAt).toBe(3);
});
