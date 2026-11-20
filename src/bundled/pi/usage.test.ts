// @vitest-environment node
import { expect, it, vi } from "vitest";
import { turnPrompt } from "../claude-code/prompt";
import type { PiEntry } from "./transcript";
import { conversationUsage, readUsage } from "./usage";

const PLACE = { conversation: 2, channelId: "chan", root: "root" };
const ask = (id: number, text: string, json = false): PiEntry => ({
  id,
  kind: "pi.user",
  model: [
    {
      role: "user",
      content: json
        ? `<context>\nChannel: general (#chan)\n</context>\n\n<buzz-event type="@mention">\n${JSON.stringify({ id: "e".repeat(64), pubkey: "a".repeat(64), author: "Sal", content: text, tags: [] })}\n</buzz-event>`
        : `<context>\nChannel: general (#chan)\n</context>\n\n<buzz-event type="@mention">\nFrom: Sal (npub1x)\nContent: ${text}\nTags: []\n</buzz-event>`,
      timestamp: id * 1000,
    },
  ],
});
const record = (id: number, text: string): PiEntry => ({
  id,
  kind: "pi.user",
  model: [
    {
      role: "user",
      content: turnPrompt({
        agent: "c".repeat(64),
        event: {
          id: "1".repeat(64),
          pubkey: "a".repeat(64),
          kind: 9,
          created_at: id,
          content: text,
          tags: [["h", "chan"]],
        },
        channel: { id: "chan", name: "general" },
        scope: "thread",
        context: [],
        total: 1,
      }),
      timestamp: id * 1000,
    },
  ],
});
const answer = (id: number, usage: Record<string, unknown>, more = {}) => ({
  id,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      timestamp: id * 1000,
      model: "claude-x",
      responseId: `resp-${id}`,
      usage,
      ...more,
    },
  ],
});
const usage = (cost: number, more = {}) => ({
  input: 100,
  output: 10,
  cacheRead: 50,
  cacheWrite: 5,
  totalTokens: 165,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  ...more,
});

it.each([false, true])(
  "reports each answer's tokens and cost, where and what was asked (json=%s)",
  (json) => {
    expect(
      conversationUsage(
        [
          ask(1, "fix the build\nwith more detail", json),
          answer(2, usage(0.25, { cacheWrite1h: 5 })),
          {
            id: 3,
            kind: "pi.tool-result",
            model: [{ role: "toolResult", timestamp: 3000 }],
          },
          // A model pi-ai has no rates for is priced at 0: the cost is unknown.
          answer(4, usage(0), { model: "local-y", responseId: undefined }),
        ],
        PLACE,
      ),
    ).toEqual({
      id: "2",
      channelId: "chan",
      root: "root",
      title: "fix the build",
      startedAt: 1000,
      lastAt: 4000,
      gaps: [],
      observations: [
        {
          requestId: "resp-2",
          at: 2000,
          model: "claude-x",
          tokens: {
            input: 100,
            output: 10,
            cacheRead: 50,
            cacheWrite: 5,
            cacheWrite1h: 5,
          },
          cost: { usd: 0.25, source: "pi" },
        },
        {
          at: 4000,
          model: "local-y",
          tokens: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5 },
        },
      ],
    });
  },
);

it("titles a conversation whose prompt is sent as exact records", () => {
  expect(
    conversationUsage([record(1, "fix the build\nand lint")], PLACE)?.title,
  ).toBe("fix the build");
});

it("leaves out counts pi-ai did not record, and a conversation with no messages", () => {
  const session = conversationUsage(
    [ask(1, "hi"), answer(2, { output: 3, input: -1, cacheRead: "x" })],
    { conversation: 5, channelId: "chan" },
  );
  expect(session?.root).toBeUndefined();
  expect(session?.observations).toEqual([
    { requestId: "resp-2", at: 2000, model: "claude-x", tokens: { output: 3 } },
  ]);
  expect(conversationUsage([], PLACE)).toBeUndefined();
});

it("adds what Pi recorded beyond the answers, such as a compaction's request", () => {
  const recorded = (input: number, cost: number) => ({
    ...usage(cost),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });
  const compaction = {
    id: 3,
    kind: "pi.compaction",
    model: [{ role: "user", content: "Summary", timestamp: 3000 }],
  };
  const entries = [
    ask(1, "hi"),
    answer(2, usage(0.1), { provider: "anthropic" }),
    compaction,
    answer(4, usage(0.2), { provider: "anthropic" }),
  ];
  const session = conversationUsage(entries, PLACE, {
    // The answers' 200 input and $0.30, and a compaction's 900 and $0.05.
    "anthropic/claude-x": {
      ...recorded(1100, 0.35),
      output: 20,
      cacheRead: 100,
      cacheWrite: 10,
    },
  });
  expect(session?.observations.slice(2)).toEqual([
    {
      requestId: "unanswered:anthropic/claude-x",
      at: 3000,
      model: "claude-x",
      tokens: { input: 900 },
      cost: { usd: expect.closeTo(0.05, 10), source: "pi" },
    },
  ]);
  // Totals the answers account for add nothing.
  expect(
    conversationUsage(entries, PLACE, {
      "anthropic/claude-x": {
        ...recorded(200, 0.1 + 0.2),
        output: 20,
        cacheRead: 100,
        cacheWrite: 10,
      },
    })?.observations,
  ).toHaveLength(2);
});

it("reads every page of the conversations used since `since`, newest first", async () => {
  const pages: Record<string, { entries: PiEntry[]; next?: string }> = {
    "2:": { entries: [answer(4, usage(1)), ask(3, "second")], next: "c" },
    "2:c": { entries: [answer(2, usage(1)), ask(1, "first")] },
    "7:": { entries: [answer(9, usage(1)), ask(8, "later")] },
  };
  const request = vi.fn(
    async (
      method: string,
      params: { conversation: number; cursor?: string },
    ) =>
      method === "recorded"
        ? { models: {} }
        : pages[`${params.conversation}:${params.cursor ?? ""}`],
  );
  const sessions = await readUsage(
    { request } as never,
    "agent",
    [
      { conversation: 2, channelId: "chan", root: "root", at: 3000 },
      { conversation: 7, channelId: "other", at: 8000 },
      // Shown nothing since: not read.
      { conversation: 9, channelId: "old", at: 500 },
    ],
    1500,
    new AbortController().signal,
  );
  expect(request).toHaveBeenCalledTimes(5);
  expect(request).toHaveBeenCalledWith("entries", {
    agent: "agent",
    conversation: 2,
    cursor: "c",
  });
  expect(sessions.map((session) => [session.id, session.title])).toEqual([
    ["7", "later"],
    ["2", "first"],
  ]);
  expect(sessions[1]?.observations).toHaveLength(2);
  expect(sessions[0]?.revision).toMatch(/^[0-9a-f]{64}$/);
});

it("keeps a community usage origin when Activity moves to another source", () => {
  const first = record(1, "first");
  const shared = {
    ...first,
    model: (first.model ?? []).map((message) => ({
      ...message,
      content: String(message.content).replace(
        "Session scope: thread",
        "Session scope: community",
      ),
    })),
  };
  const result = conversationUsage([shared, answer(2, usage(0.1))], {
    conversation: 2,
    channelId: "other",
  });
  expect(result?.channelId).toBe("chan");
  expect(result?.root).toBeUndefined();
});

it("leaves a wake-first community usage origin absent after later channel work", () => {
  const first: PiEntry = {
    id: 1,
    kind: "pi.user",
    model: [{ role: "user", content: "check", timestamp: 1000 }],
  };
  expect(
    conversationUsage([first, answer(2, usage(0.1))], {
      conversation: 2,
      channelId: "latest",
      community: true,
    })?.channelId,
  ).toBeUndefined();
});
