import { describe, expect, it } from "vitest";
import { gooseTurns } from "./meshTranscript";

const place = { channelId: "channel", root: "thread" };
const title = "Inline run";
const row = { ...place, sessionId: "saved", title, at: 0 };
const text = (text: string) => ({ type: "text", text });
const conversation = [
  { role: "user", created: 1, content: [text("question")] },
  {
    role: "user",
    created: 1,
    content: [text("hidden context")],
    metadata: { userVisible: false },
  },
  {
    role: "assistant",
    created: 2,
    content: [
      {
        type: "toolRequest",
        id: "call",
        toolCall: {
          status: "success",
          value: { name: "developer__shell", arguments: { command: "pwd" } },
        },
      },
    ],
  },
  {
    role: "user",
    created: 3,
    content: [
      {
        type: "toolResponse",
        id: "call",
        toolResult: {
          status: "success",
          value: { content: [text("/workspace")] },
        },
      },
    ],
  },
  {
    role: "user",
    created: 4,
    content: [
      text(
        "<new-message-arrived-while-you-were-working>\nnew instruction\n</new-message-arrived-while-you-were-working>",
      ),
    ],
  },
  { role: "assistant", created: 5, content: [text("answer")] },
];

describe("Mesh transcripts", () => {
  it("projects tools, results and steering without showing hidden context", () => {
    const turns = gooseTurns(conversation, row, true);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.endedAt).toBeUndefined();
    expect(turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool",
          status: "completed",
          output: "/workspace",
        }),
        expect.objectContaining({
          type: "prompt",
          text: "new instruction",
          steer: true,
        }),
        expect.objectContaining({ type: "message", text: "answer" }),
      ]),
    );
    expect(JSON.stringify(turns)).not.toContain("hidden context");
  });
});
