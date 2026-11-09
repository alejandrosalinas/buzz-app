import { describe, expect, it } from "vitest";
import type { EventData } from "../../features/relay/events";
import { steerPrompt, turnPrompt } from "../claude-code/prompt";
import { type FakeSession, fakeSpawn } from "./goose-testing";
import { GooseHistory, gooseTurns, startedFor } from "./transcript";

const alice = "a".repeat(64);
const agent = "c".repeat(64);
const other = "d".repeat(64);
const CHANNEL = "chan";
const event = (id: string, content: string, extra: Partial<EventData> = {}) =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey: alice,
    kind: 9,
    created_at: 1_800_000_000,
    content,
    tags: [["h", CHANNEL]],
    sig: "",
    ...extra,
  }) as EventData;
const root = event("1", "@Gander what's up?");
const ask = (pubkey = agent, mention = root) =>
  turnPrompt({
    agent: pubkey,
    event: mention,
    channel: { id: CHANNEL, name: "general" },
    scope: "thread",
    context: [],
    total: 1,
  });
const name = (key: string) => (key === alice ? "Alice" : undefined);

let created = 1_800_000_000;
const user = (content: Record<string, unknown>[], metadata = {}) => ({
  id: `u${created}`,
  role: "user",
  created: created++,
  content,
  metadata: { userVisible: true, agentVisible: true, ...metadata },
});
const assistant = (content: Record<string, unknown>[]) => ({
  id: `a${created}`,
  role: "assistant",
  created: created++,
  content,
  metadata: { userVisible: true, agentVisible: true },
});
const text = (value: string) => ({ type: "text", text: value });
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "toolRequest",
  id,
  toolCall: { status: "success", value: { name, arguments: args } },
});
const answer = (id: string, value: string, isError = false) => ({
  type: "toolResponse",
  id,
  toolResult: {
    status: "success",
    value: { content: [text(value)], ...(isError ? { isError } : {}) },
  },
});

/** A session as goose saves a Buzz turn: the prompt, its hidden turn
 * context, a shell call, then the reply sent with buzz__send. */
const conversation = () => [
  user([text(ask())]),
  user([text("<turn-context>…</turn-context>")], {
    userVisible: false,
    turnContext: true,
  }),
  assistant([
    { type: "thinking", thinking: "Check the date first.", signature: "" },
    call("t1", "shell", { command: "date" }),
  ]),
  user([answer("t1", "Tue Oct 13")]),
  assistant([call("t2", "buzz__send", { text: "Hi Alice!", final: true })]),
  user([answer("t2", "sent abc")]),
  assistant([text("Replied in the thread.")]),
];

describe("gooseTurns", () => {
  it("reads a Buzz turn's prompt, tools and sent reply", () => {
    const [turn, ...rest] = gooseTurns(
      conversation(),
      { sessionId: "s1", channelId: CHANNEL, root: root.id },
      false,
      name,
    );
    expect(rest).toEqual([]);
    expect(turn).toMatchObject({
      sessionId: "s1",
      channelId: CHANNEL,
      threadRootId: root.id,
      partial: false,
    });
    expect(turn?.endedAt).toBeGreaterThan(turn?.startedAt ?? 0);
    expect(
      turn?.items.map((item) =>
        item.type === "tool"
          ? [item.type, item.title, item.kind, item.status, item.output]
          : item.type === "prompt"
            ? [item.type, item.text, item.author, item.steer]
            : [item.type, "text" in item ? item.text : ""],
      ),
    ).toEqual([
      ["prompt", "@Gander what's up?", "Alice", false],
      ["thought", "Check the date first."],
      ["tool", "date", "execute", "completed", "Tue Oct 13"],
      ["message", "Hi Alice!"],
      ["message", "Replied in the thread."],
    ]);
    expect(turn?.items[3]).toMatchObject({ posted: true });
  });

  it("keeps a steer in its turn, and marks a failed send and tool", () => {
    const [turn] = gooseTurns(
      [
        user([text(ask())]),
        assistant([call("t1", "buzz__read", { channel: CHANNEL })]),
        user([text(steerPrompt(ask(agent, event("2", "also this"))))], {
          steer: true,
        }),
        user([answer("t1", "denied", true)]),
        assistant([call("t2", "buzz__send", { text: "Done" })]),
        user([
          {
            type: "toolResponse",
            id: "t2",
            toolResult: { status: "error", error: "relay closed" },
          },
        ]),
      ],
      { sessionId: "s1", channelId: CHANNEL },
      true,
    );
    expect(turn?.endedAt).toBeUndefined();
    expect(turn?.items.map((item) => item.type)).toEqual([
      "prompt",
      "tool",
      "prompt",
      "message",
      "status",
    ]);
    expect(turn?.items[1]).toMatchObject({
      title: "buzz.read",
      status: "failed",
      output: "denied",
    });
    expect(turn?.items[2]).toMatchObject({ text: "also this", steer: true });
    expect(turn?.items[4]).toMatchObject({
      text: "The message above was not posted: relay closed",
    });
  });

  it("shows a reply in a subthread as a message, posted or not", () => {
    const nested = (id: string) =>
      assistant([
        call(id, "buzz__reply_in_subthread", { parent: CHANNEL, text: id }),
      ]);
    const [turn] = gooseTurns(
      [
        user([text(ask())]),
        nested("n1"),
        user([answer("n1", "sent")]),
        nested("n2"),
        user([answer("n2", "relay closed", true)]),
      ],
      { sessionId: "s1", channelId: CHANNEL },
      false,
    );
    expect(turn?.items.slice(1)).toEqual([
      expect.objectContaining({ type: "message", text: "n1", posted: true }),
      expect.not.objectContaining({ posted: true }),
      expect.objectContaining({
        type: "status",
        text: "The message above was not posted: relay closed",
      }),
    ]);
  });

  it("shows a turn that failed with goose's error, and its lasting notices", () => {
    const [turn] = gooseTurns(
      [
        user([text(ask())]),
        assistant([
          {
            type: "systemNotification",
            notificationType: "thinkingMessage",
            msg: "Thinking…",
          },
          {
            type: "systemNotification",
            notificationType: "creditsExhausted",
            msg: "Out of credits",
          },
          {
            type: "error",
            kind: "providerError",
            message: "Authentication failed: invalid API key",
          },
        ]),
      ],
      { sessionId: "s1", channelId: CHANNEL },
      false,
    );
    expect(turn?.error).toBe("Authentication failed: invalid API key");
    expect(
      turn?.items.map((item) => [item.type, "text" in item ? item.text : ""]),
    ).toEqual([
      ["prompt", "@Gander what's up?"],
      ["status", "Out of credits"],
      ["status", "Authentication failed: invalid API key"],
    ]);
  });
});

describe("startedFor", () => {
  it("matches the agent, channel and thread its first prompt names", () => {
    const messages = conversation();
    const place = { channelId: CHANNEL, root: root.id };
    expect(startedFor(messages, agent, place)).toBe(true);
    expect(startedFor(messages, other, place)).toBe(false);
    expect(
      startedFor(messages, agent, { ...place, root: "f".repeat(64) }),
    ).toBe(false);
    expect(startedFor(messages, agent, { channelId: CHANNEL })).toBe(false);
    expect(startedFor([user([text("hi")])], agent, place)).toBe(false);
  });
});

describe("GooseHistory", () => {
  const session = (
    sessionId: string,
    title: string,
    messages: readonly Record<string, unknown>[],
    cwd = "/home/test/.buzz",
  ): FakeSession => ({
    sessionId,
    title,
    cwd,
    updatedAt: "2027-01-15T08:00:00Z",
    conversation: messages,
  });
  const history = (sessions: FakeSession[]) =>
    new GooseHistory(fakeSpawn({ history: sessions, home: "/home/test" }));
  const signal = new AbortController().signal;

  const listed = (fake: ReturnType<typeof fakeSpawn>) =>
    fake.geese
      .flatMap((goose) => goose.received)
      .filter((message) => message.method === "session/list");

  it("reads a place's saved sessions by id, without searching goose", async () => {
    const fake = fakeSpawn({
      home: "/home/test",
      history: [
        session("s1", "Gander · #general", conversation()),
        session("s2", "Gander · #general", conversation()),
        session("unsaved", "Gander · #general", conversation()),
      ],
    });
    const place = { channelId: CHANNEL, root: root.id };
    const read = await new GooseHistory(fake).transcript(
      { agent, workspace: "~/.buzz", place, sessions: ["s2", "s1", "gone"] },
      signal,
    );
    expect(read?.turns.map((turn) => turn.sessionId).sort()).toEqual([
      "s1",
      "s2",
    ]);
    expect(listed(fake)).toEqual([]);
    expect(
      await new GooseHistory(fake).transcript(
        { agent, workspace: "~/.buzz", place },
        signal,
      ),
    ).toBeUndefined();
    expect(listed(fake)).toEqual([]);
  });

  it("searches goose for every session the agent ran for a place only when asked", async () => {
    const fake = fakeSpawn({
      home: "/home/test",
      history: [
        session("theirs", "Goosey · #general", [user([text(ask(other))])]),
        session("s1", "Gander · #general", conversation()),
        session("s2", "Gander · #general", conversation()),
      ],
    });
    const goose = new GooseHistory(fake);
    const place = { channelId: CHANNEL, root: root.id };
    const read = await goose.transcript(
      { agent, workspace: "~/.buzz", place, search: true },
      signal,
    );
    expect(read?.turns.map((turn) => turn.sessionId)).toEqual(["s1", "s2"]);
    expect(listed(fake)).toHaveLength(1);
    expect(
      await goose.transcript(
        {
          agent,
          workspace: "~/.buzz",
          place: { channelId: "elsewhere" },
          search: true,
        },
        signal,
      ),
    ).toBeUndefined();
  });

  it("reuses another session's export only on automatic reads, so a full read shows its final messages", async () => {
    const a = [...conversation()];
    const sessions = [
      session("a", "Gander · DM", a),
      session("b", "Gander · DM", conversation()),
    ];
    const goose = history(sessions);
    const lookup = { agent, workspace: "~/.buzz", sessions: ["a", "b"] };
    await goose.transcript(
      { ...lookup, working: "a" },
      signal,
      undefined,
      true,
    );
    // Session a ends with a last reply, and b starts working.
    a.push(assistant([text("a's final reply")]));
    const shows = (read: unknown) =>
      JSON.stringify(read).includes("a's final reply");
    expect(
      shows(
        await goose.transcript(
          { ...lookup, working: "b" },
          signal,
          undefined,
          true,
        ),
      ),
    ).toBe(false);
    expect(
      shows(await goose.transcript({ ...lookup, working: "b" }, signal)),
    ).toBe(true);
  });

  it("reads one session by its id, and none that goose deleted", async () => {
    const goose = history([session("s1", "Gander · DM", conversation())]);
    const read = await goose.transcript(
      { agent, workspace: "~/.buzz", sessionId: "s1" },
      signal,
    );
    expect(read?.turns).toHaveLength(1);
    expect(read?.more).toBe(false);
    expect(
      await goose.transcript(
        { agent, workspace: "~/.buzz", sessionId: "gone" },
        signal,
      ),
    ).toBeUndefined();
  });
});
