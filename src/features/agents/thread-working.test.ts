import { afterEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "./activity";
import { threadWorkingAgents } from "./thread-working";
import { messageActivity } from "../../bundled/agent-activity/message-activity";
import { requestWork } from "./request-work";

const agent = "a".repeat(64),
  root = "b".repeat(64),
  request = "c".repeat(64),
  sibling = "d".repeat(64);
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  let generation = 0,
    seq = 0;
  const messages = new Map<
    string,
    {
      id: string;
      pubkey: string;
      kind: number;
      created_at: number;
      content: string;
      tags: string[][];
    }
  >();
  const activity = createAgentActivity(
    true,
    (g) => {
      generation = g ?? 0;
    },
    () => true,
    undefined,
    (id) => messages.get(id),
  );
  activity.queries.activate();
  const connected = {
    status: "connected" as const,
    routes: [
      { id: "observer", status: "live" as const, replay: "unknown" as const },
    ],
  };
  activity.state(connected);
  const send = (kind: string, turnId = "one", trigger = request, extra = {}) =>
    activity.receive(
      {
        id: (++seq).toString(16).padStart(64, "0"),
        agent,
        createdAt: Date.now() / 1000,
        plaintext: JSON.stringify({
          kind,
          turnId,
          seq,
          channelId: "channel",
          timestamp: new Date().toISOString(),
          payload: { triggeringEventIds: [trigger] },
          ...extra,
        }),
      },
      generation,
    );
  const message = (id = request, thread = root) => {
    const event = {
      id,
      pubkey: agent,
      kind: 9,
      created_at: Date.now() / 1000,
      content: "work",
      tags: [
        ["h", "channel"],
        ["e", thread, "", "reply"],
      ],
    };
    messages.set(id, event);
    activity.messagesChanged([event]);
  };
  const snapshot = activity.queries.snapshot;
  return {
    activity,
    connected,
    send,
    message,
    snapshot,
    thread: (typing: string[] = [agent]) =>
      threadWorkingAgents(snapshot(), typing, "channel", root),
    bubble: (id = request) => messageActivity(snapshot(), "channel", id),
  };
}
it("uses one request status for both surfaces through tools, thinking, overlapping work and completion", () => {
  const f = fixture();
  f.message();
  f.message(sibling);
  f.send("turn_started");
  f.send("turn_started", "two", sibling);
  for (const update of [
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
  ]) {
    f.send("acp_read", "one", request, {
      payload: {
        method: "session/update",
        params: { update: { sessionUpdate: update } },
      },
    });
    expect(f.bubble()[0]?.working).toBe(true);
    expect(f.thread([])).toEqual([agent]);
  }
  f.send("turn_completed");
  expect(f.bubble()).toEqual([]);
  expect(f.bubble(sibling)[0]?.working).toBe(true);
  expect(f.thread()).toEqual([agent]);
  f.send("turn_completed", "two");
  expect(f.bubble(sibling)).toEqual([]);
  expect(f.thread([agent, "pulse-only"])).toEqual(["pulse-only"]);
  f.send("turn_liveness"); // Cannot revive a settled request.
  expect(f.thread()).toEqual([]);
  f.send("turn_started", "three");
  expect(f.thread()).toEqual([agent]);
  expect(f.bubble()[0]?.working).toBe(true);
  f.activity.dispose();
});
it("associates late trigger content immediately, even after completion, without another heartbeat", () => {
  const f = fixture();
  f.send("turn_started");
  f.send("turn_completed");
  expect(f.bubble()).toEqual([]);
  expect(f.thread()).toEqual([agent]); // No thread evidence yet.
  f.message(); // No clock advancement, observer heartbeat or timer required.
  expect(f.thread()).toEqual([]);
  expect(f.snapshot().turns[0]?.requests).toEqual([
    { messageId: request, threadRootId: root },
  ]);
  f.activity.dispose();
});
it("keeps pulse-only and other-thread agents without animating stale known requests", async () => {
  const f = fixture();
  expect(f.thread()).toEqual([agent]);
  f.message(request, sibling);
  f.send("turn_started");
  expect(f.thread()).toEqual([agent]); // Work in another thread is not authority here.
  f.message(sibling);
  f.send("turn_started", "two", sibling);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(f.bubble(sibling)).toEqual([]);
  expect(requestWork(f.snapshot(), "channel", sibling)[0]?.state).toBe(
    "unknown",
  );
  expect(f.thread()).toEqual([]);
  f.send("turn_liveness", "two");
  expect(f.thread()).toEqual([agent]);
  f.activity.state({ status: "retrying", routes: [] });
  expect(f.bubble(sibling)).toEqual([]);
  f.activity.state(f.connected);
  expect(f.thread()).toEqual([]);
  f.activity.dispose();
});
it("does not let ambiguous duplicate starts produce a thread animation absent from the message bubble", () => {
  const f = fixture();
  f.message();
  f.send("turn_started");
  f.send("turn_started");
  expect(f.bubble()).toEqual([]);
  expect(f.thread()).toEqual([]);
  // Evict the first start, then both: retained associations must not revive it.
  for (let i = 0; i < 199; i++) f.send("acp_read", "other", sibling);
  expect(f.bubble()).toEqual([]);
  expect(f.thread()).toEqual([]);
  f.send("acp_read", "other", sibling);
  f.send("turn_completed");
  expect(f.bubble()).toEqual([]);
  expect(f.thread()).toEqual([]);
  f.activity.dispose();
});
it("keeps the public indicator when the activity plugin is unavailable", () => {
  expect(threadWorkingAgents(undefined, [agent], "channel", root)).toEqual([
    agent,
  ]);
});
