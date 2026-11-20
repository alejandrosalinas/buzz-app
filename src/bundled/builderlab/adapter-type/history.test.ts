import { npubEncode } from "nostr-tools/nip19";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptTurn } from "../../../features/agents/activity-transcript";
import type { AgentClient, AgentSession } from "../agents/client";
import type { BuilderlabSession } from "../session";
import { listSessions, readSession, sessionTurns, TURN_LIMIT } from "./history";

const mention = "e".repeat(64);
const session: AgentSession = {
  sessionId: "s1",
  channelId: "alpha",
  threadRootId: "r".repeat(64),
  updatedAt: 0,
};
const prompt = [
  "<context>",
  "Scope: thread",
  "</context>",
  "",
  '<buzz-event type="@mention">',
  `Event ID: ${mention}`,
  "Channel: alpha",
  "From: Ada. This sender is your owner.",
  "Content: fix &lt;this&gt; &amp; ship",
  "</buzz-event>",
].join("\n");
const text = (value: string) => ({
  type: "MESSAGE_TYPE_TEXT",
  text: { text: value },
});
const request = (id: string, name: string, args: unknown) => ({
  type: "MESSAGE_TYPE_TOOL_REQUEST",
  tool_request: {
    id,
    status: "success",
    value: { name, arguments: JSON.stringify(args) },
  },
});
const result = (id: string, output: string, status = "success") => ({
  type: "MESSAGE_TYPE_TOOL_RESPONSE",
  tool_response: { id, status, results: [{ text: { text: output } }] },
});

// Milliseconds after a fixed time, as the server stamps them.
const at = (offset: number) => Date.UTC(2026, 0, 1) + offset;

it("groups stored messages into the turns that started before them", () => {
  const turns = sessionTurns(session, {
    turns: [
      {
        turn_id: "t2",
        mention_event_id: "f".repeat(64),
        status: "TASK_STATUS_IN_PROGRESS",
        created_at: String(at(2000)),
        updated_at: String(at(2000)),
      },
      {
        turn_id: "t1",
        mention_event_id: mention,
        status: "TASK_STATUS_COMPLETED",
        created_at: at(1000),
        updated_at: at(1900),
      },
    ],
    messages: [
      {
        id: "m1",
        role: "ROLE_USER",
        created: at(1001),
        content: [text(prompt)],
      },
      {
        id: "m2",
        role: "ROLE_ASSISTANT",
        created: at(1100),
        content: [
          { type: "MESSAGE_TYPE_THINKING", thinking: { thinking: "Plan" } },
          request("c1", "developer__shell", { command: "ls" }),
          request("c2", "buzz__send", { text: "Shipped" }),
        ],
      },
      {
        id: "m3",
        role: "ROLE_USER",
        created: at(1200),
        content: [result("c1", "README.md"), result("c2", "sent")],
      },
      { id: "gone", role: 2, created: at(1300), deleted: true, content: [] },
      {
        id: "m4",
        role: 2,
        created: at(2100),
        content: [text("Working on it")],
      },
    ],
    prompts: [
      {
        message_id: "m1",
        events: [{ event_id: mention, sender_label: "Ada" }],
      },
    ],
  });
  expect(turns.map((turn) => [turn.turnId, turn.outcome])).toEqual([
    ["t1", "ended"],
    ["t2", undefined],
  ]);
  const [first, second] = turns as [TranscriptTurn, TranscriptTurn];
  expect(first).toMatchObject({
    channelId: "alpha",
    threadRootId: session.threadRootId,
    sessionId: "s1",
    triggeringEventIds: [mention],
    newSession: true,
    startedAt: at(1000),
    endedAt: at(1900),
    partial: false,
  });
  expect(first.items).toMatchObject([
    { type: "prompt", text: "fix <this> & ship", author: "Ada", steer: false },
    { type: "thought", text: "Plan" },
    {
      type: "tool",
      title: "developer__shell",
      status: "completed",
      output: "README.md",
      completedAt: at(1200),
    },
    { type: "message", text: "Shipped", posted: true },
  ]);
  expect(second.newSession).toBe(false);
  expect(second).not.toHaveProperty("endedAt");
  expect(second.items).toMatchObject([
    { type: "message", text: "Working on it" },
  ]);
});

it("maps stored terminal statuses, by name or number", () => {
  const outcomes = [
    4,
    5,
    7,
    8,
    "TASK_STATUS_CANCELLED",
    "TASK_STATUS_TERMINATED",
    2,
    3,
    6,
    9,
    "TASK_STATUS_INITIALIZED",
  ].map(
    (status) =>
      sessionTurns(session, {
        turns: [{ turn_id: "t", status, created_at: 1 }],
      })[0]?.outcome,
  );
  expect(outcomes).toEqual([
    "ended",
    "error",
    "stopped",
    "error",
    "stopped",
    "error",
    ...Array(5).fill(undefined),
  ]);
});

it("marks a failed tool call and a model error", () => {
  const [turn] = sessionTurns(session, {
    turns: [{ turn_id: "t", status: "TASK_STATUS_FAILED", created_at: 1 }],
    messages: [
      {
        id: "a",
        role: "ROLE_ASSISTANT",
        created: 2,
        content: [request("c", "developer__shell", { command: "false" })],
        llm_call_error_info: { is_error: true, cause: "Rate limited" },
      },
      {
        id: "b",
        role: "ROLE_USER",
        created: 3,
        content: [result("c", "exit 1", "error")],
      },
    ],
  });
  expect(turn?.error).toBe("Rate limited");
  expect(turn?.items).toMatchObject([
    { type: "tool", status: "failed", output: "exit 1" },
  ]);
});

const signal = new AbortController().signal;
const missing = () => Object.assign(new Error("missing"), { status: 404 });
const signedIn = {
  snapshot: () => ({
    status: "signed-in",
    account: { canUseRemoteAgents: true },
  }),
} as unknown as BuilderlabSession;
function client(overrides: Partial<Record<keyof AgentClient, unknown>> = {}) {
  return {
    list: vi.fn(async () => [{ id: "agent-1", pubkey: "a".repeat(64) }]),
    sessions: vi.fn(async () => ({ sessions: [session] })),
    sessionMessages: vi.fn(async () => ({ turns: [], messages: [] })),
    ...overrides,
  } as unknown as AgentClient;
}

it("lists the signed-in owner's stored sessions of an agent", async () => {
  const reader = client();
  expect(await listSessions(reader, signedIn, "a".repeat(64), signal)).toEqual({
    status: "loaded",
    agentId: "agent-1",
    sessions: [session],
    more: false,
  });
  expect(reader.sessions).toHaveBeenCalledExactlyOnceWith(
    "agent-1",
    signal,
    undefined,
    undefined,
  );
});

it("lists nothing for an agent outside the signed-in account", async () => {
  const reader = client({ list: vi.fn(async () => []) });
  expect(await listSessions(reader, signedIn, "a".repeat(64), signal)).toEqual({
    status: "loaded",
    sessions: [],
    more: false,
  });
  expect(reader.sessions).not.toHaveBeenCalled();
});

it("treats a Builderlab without stored sessions as unsupported", async () => {
  const reader = client({
    sessions: vi.fn(async () => {
      throw missing();
    }),
  });
  expect(await listSessions(reader, signedIn, "a".repeat(64), signal)).toEqual({
    status: "unsupported",
  });
});

it("lists nothing before the owner signs in with remote agents", async () => {
  const reader = client();
  for (const snapshot of [
    { status: "signed-out" },
    { status: "signed-in", account: { canUseRemoteAgents: false } },
  ])
    expect(
      await listSessions(
        reader,
        { snapshot: () => snapshot } as unknown as BuilderlabSession,
        "a".repeat(64),
        signal,
      ),
    ).toEqual({ status: "signed-out" });
  expect(reader.list).not.toHaveBeenCalled();
});

it("reads a session's latest turns, and says when earlier ones exist", async () => {
  const turns = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      turn_id: `t${index}`,
      created_at: index + 1,
    }));
  const read = async (response: unknown) =>
    readSession(
      client({ sessionMessages: vi.fn(async () => response) }),
      session,
      signal,
    );
  expect(await read({ turns: turns(2), messages: [] })).toMatchObject({
    turns: [{ turnId: "t0" }, { turnId: "t1" }],
    more: false,
  });
  expect(
    await read({ turns: turns(2), messages: [], has_earlier_turns: true }),
  ).toMatchObject({ more: true });
  const many = await read({ turns: turns(TURN_LIMIT + 1), messages: [] });
  expect(many?.turns).toHaveLength(TURN_LIMIT);
  expect(many?.turns[0]?.turnId).toBe("t1");
  expect(many?.more).toBe(true);
});

it("reads no transcript for a session Builderlab no longer has", async () => {
  const gone = client({
    sessionMessages: vi.fn(async () => {
      throw missing();
    }),
  });
  expect(await readSession(gone, session, signal)).toBeUndefined();
  const removed = client({
    sessionMessages: vi.fn(async () => ({ removal_state: 1 })),
  });
  expect(await readSession(removed, session, signal)).toBeUndefined();
});

it("reads ISO, second and millisecond times alike, and drops an empty one", () => {
  const turns = sessionTurns(session, {
    turns: [
      { turn_id: "iso", created_at: "2026-01-01T00:00:00Z" },
      { turn_id: "seconds", created_at: at(60_000) / 1000 },
      { turn_id: "empty", created_at: "" },
    ],
    messages: [
      { id: "a", role: 2, created: at(1000), content: [text("first")] },
      { id: "b", role: 2, created: at(61_000), content: [text("second")] },
    ],
  });
  expect(
    turns.map((turn) => [turn.turnId, turn.startedAt, turn.items.length]),
  ).toEqual([
    ["iso", at(0), 1],
    ["seconds", at(60_000), 1],
  ]);
});

it("pairs a tool's result that arrives before its request", () => {
  const [turn] = sessionTurns(session, {
    turns: [{ turn_id: "t", created_at: at(0) }],
    messages: [
      { id: "b", role: 1, created: at(20), content: [result("c", "done")] },
      {
        id: "a",
        role: 2,
        created: at(10),
        content: [request("c", "developer__shell", {})],
      },
    ],
  });
  expect(turn?.items).toMatchObject([
    { type: "tool", status: "completed", output: "done" },
  ]);
});

it("keeps tool calls without an id apart", () => {
  const [turn] = sessionTurns(session, {
    turns: [{ turn_id: "t", created_at: at(0) }],
    messages: [
      {
        id: "a",
        role: 2,
        created: at(10),
        content: [
          request("", "developer__shell", { command: "ls" }),
          request("", "developer__shell", { command: "pwd" }),
        ],
      },
      { id: "b", role: 1, created: at(20), content: [result("", "out")] },
    ],
  });
  expect(turn?.items).toMatchObject([
    { type: "tool", status: "in_progress", output: "" },
    { type: "tool", status: "in_progress", output: "" },
  ]);
});

it("puts each message in the turn that lists it, even stamped before it", () => {
  const turns = sessionTurns(session, {
    turns: [
      { turn_id: "t1", created_at: at(0), message_ids: ["a"] },
      { turn_id: "t2", created_at: at(10_000), message_ids: ["p", "b"] },
    ],
    messages: [
      { id: "a", role: 2, created: at(1000), content: [text("one")] },
      { id: "p", role: 1, created: at(9_500), content: [text(prompt)] },
      { id: "b", role: 2, created: at(9_800), content: [text("two")] },
      { id: "c", role: 2, created: at(10_500), content: [text("three")] },
    ],
  });
  expect(
    turns.map((turn) => [turn.turnId, turn.items.map((item) => item.id)]),
  ).toEqual([
    ["t1", ["a:0"]],
    ["t2", ["p:0", "b:0", "c:0"]],
  ]);
});

it("names every sender of a batched prompt the server read", () => {
  const ada = "a".repeat(64);
  const bob = "b".repeat(64);
  const carol = "c".repeat(64);
  const read = (name?: (pubkey: string) => string | undefined) =>
    sessionTurns(
      session,
      {
        turns: [{ turn_id: "t", created_at: at(0), message_ids: ["p"] }],
        messages: [
          { id: "p", role: 1, created: at(1), content: [text(prompt)] },
        ],
        prompts: [
          {
            message_id: "p",
            events: [
              { event_id: "1", sender_pubkey: ada, sender_label: "Ada" },
              { event_id: "2", sender_pubkey: bob, sender_label: "Bob" },
              { event_id: "3", sender_pubkey: carol },
              { event_id: "4" },
              { event_id: "5", sender_pubkey: "npub1forged" },
            ],
          },
        ],
      },
      name,
    )[0]?.items[0];
  expect(read()).toMatchObject({
    author: `Ada, Bob, ${npubEncode(carol)}`,
  });
  expect(read()).not.toHaveProperty("authorPubkey");
  expect(
    read((pubkey) => (pubkey === bob ? "Bob B." : undefined)),
  ).toMatchObject({ author: `Ada, Bob B., ${npubEncode(carol)}` });
});

it("reads a session whose removal state is unspecified", async () => {
  const read = async (removal_state: unknown) =>
    readSession(
      client({
        sessionMessages: vi.fn(async () => ({
          removal_state,
          turns: [{ turn_id: "t", created_at: at(0) }],
        })),
      }),
      session,
      signal,
    );
  expect(await read("SESSION_REMOVAL_STATE_UNSPECIFIED")).toMatchObject({
    turns: [{ turnId: "t" }],
  });
  expect(await read(0)).toMatchObject({ turns: [{ turnId: "t" }] });
  expect(await read("SESSION_REMOVAL_STATE_REMOVED")).toBeUndefined();
});

it("names a single sender by key, and no sender the server did not read", () => {
  const hex = "c".repeat(64);
  const read = (prompts?: unknown) =>
    sessionTurns(session, {
      turns: [{ turn_id: "t", created_at: at(0) }],
      messages: [{ id: "p", role: 1, created: at(1), content: [text(prompt)] }],
      prompts,
    })[0]?.items[0];
  expect(
    read([
      {
        message_id: "p",
        events: [{ sender_pubkey: hex, sender_label: "Ada" }],
      },
    ]),
  ).toMatchObject({ author: "Ada", authorPubkey: hex });
  const unread = read();
  expect(unread).toMatchObject({ type: "prompt", text: "fix <this> & ship" });
  expect(unread).not.toHaveProperty("author");
});

it("shows a sender's label as the server sent it, already unescaped", () => {
  const label = (sender_label: string) =>
    sessionTurns(session, {
      turns: [{ turn_id: "t", created_at: at(0) }],
      messages: [{ id: "p", role: 1, created: at(1), content: [text(prompt)] }],
      prompts: [{ message_id: "p", events: [{ sender_label }] }],
    })[0]?.items[0];
  expect(label("R&D <ops>")).toMatchObject({ author: "R&D <ops>" });
  expect(label("A &amp; B")).toMatchObject({ author: "A &amp; B" });
});

it("names an exact event record's sender when the server read none", () => {
  const ada = "a".repeat(64);
  const record = (pubkey: string) =>
    [
      "<buzz-event>",
      JSON.stringify({ id: mention, pubkey, content: "fix it" }),
      `Request: ${JSON.stringify("fix it")}`,
      "</buzz-event>",
    ].join("\n");
  const read = (raw: string, name?: (pubkey: string) => string | undefined) =>
    sessionTurns(
      session,
      {
        turns: [{ turn_id: "t", created_at: at(0) }],
        messages: [{ id: "p", role: 1, created: at(1), content: [text(raw)] }],
      },
      name,
    )[0]?.items[0];
  expect(read(record(ada), () => "Ada")).toMatchObject({
    text: "fix it",
    author: "Ada",
    authorPubkey: ada,
  });
  expect(read(record(ada))).toMatchObject({ author: npubEncode(ada) });
  expect(read(record("npub1forged"))).not.toHaveProperty("author");
});

describe("paging stored sessions", () => {
  const rows = (count: number, from = 0) =>
    Array.from({ length: count }, (_, index) => ({
      ...session,
      sessionId: `s${from + index}`,
    }));
  const pages = (...sent: { sessions: AgentSession[]; cursor?: string }[]) => {
    const sessions = vi.fn();
    for (const page of sent) sessions.mockResolvedValueOnce(page);
    return client({ sessions });
  };
  const cursors = (reader: AgentClient) =>
    vi.mocked(reader.sessions).mock.calls.map((call) => call[3]);

  it("reads past a short page until enough are listed", async () => {
    const reader = pages(
      { sessions: rows(10), cursor: "p2" },
      { sessions: rows(25, 10), cursor: "p3" },
    );
    const list = await listSessions(reader, signedIn, "a".repeat(64), signal);
    expect(list).toMatchObject({ status: "loaded", more: true });
    expect(list.status === "loaded" && list.sessions).toHaveLength(35);
    expect(cursors(reader)).toEqual([undefined, "p2"]);
  });

  it("reads past an empty page, and stops when no cursor remains", async () => {
    const reader = pages({ sessions: [], cursor: "p2" }, { sessions: rows(3) });
    expect(
      await listSessions(reader, signedIn, "a".repeat(64), signal),
    ).toEqual({
      status: "loaded",
      agentId: "agent-1",
      sessions: rows(3),
      more: false,
    });
    expect(cursors(reader)).toEqual([undefined, "p2"]);
  });

  it("keeps a session sent on two pages once, counting it once", async () => {
    const moved = { ...session, sessionId: "s5", updatedAt: 1 };
    const reader = pages(
      { sessions: rows(20), cursor: "p2" },
      // 30 rows, but 29 sessions: one more page is read.
      { sessions: [moved, ...rows(9, 20)], cursor: "p3" },
      { sessions: rows(10, 29), cursor: "p4" },
    );
    const list = await listSessions(reader, signedIn, "a".repeat(64), signal);
    if (list.status !== "loaded") throw new Error("not loaded");
    const ids = list.sessions.map((row) => row.sessionId);
    expect(ids).toEqual(rows(39).map((row) => row.sessionId));
    expect(list.sessions[5]).toEqual(rows(20)[5]);
    expect(cursors(reader)).toEqual([undefined, "p2", "p3"]);
  });

  it("stops after five pages while a cursor remains", async () => {
    const reader = pages(
      ...Array.from({ length: 6 }, (_, index) => ({
        sessions: rows(1, index),
        cursor: `p${index + 2}`,
      })),
    );
    const list = await listSessions(reader, signedIn, "a".repeat(64), signal);
    expect(list).toMatchObject({ status: "loaded", more: true });
    expect(list.status === "loaded" && list.sessions).toHaveLength(5);
    expect(cursors(reader)).toEqual([undefined, "p2", "p3", "p4", "p5"]);
  });
});
