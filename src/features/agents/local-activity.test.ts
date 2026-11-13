import { expect, it, vi } from "vitest";
import {
  createLocalAgentActivity,
  localActivity,
  localWorkLabel,
  stepText,
} from "./local-activity";
import { createAgentActivity } from "./activity";
import { messageActivity } from "../../bundled/agent-activity/message-activity";
import { workingAgents } from "../../bundled/channels/working-agents";
import { threadWorkingAgents } from "./thread-working";

type Work = ReturnType<ReturnType<typeof createLocalAgentActivity>["begin"]>;
const scope = "https://relay.test:viewer",
  agent = "a".repeat(64),
  root = "b".repeat(64),
  reply = "c".repeat(64);
it.each([false, true])(
  "keeps source history across initial and threaded input (flat: %s)",
  (flat) => {
    const local = createLocalAgentActivity();
    const input = {
      scope,
      agent,
      channelId: "channel",
      ...(flat ? { sourceRootId: null } : {}),
    };
    const a = local.begin(
      { ...input, messageId: root, threadRootId: root },
      undefined,
      { author: "owner", text: "Request A" },
    );
    a.acknowledged();
    a.sending("Reply A")(true);
    a.finish({ ok: true });
    const b = local.begin(
      { ...input, messageId: reply, threadRootId: reply },
      undefined,
      { author: "owner", text: "Request B" },
    );
    b.acknowledged();
    expect(
      local.reader.work()[1]?.evidence?.messages.map(({ text }) => text),
    ).toEqual(flat ? ["Request A", "Reply A", "Request B"] : ["Request B"]);
    const followUp = local.begin(
      { ...input, messageId: "d".repeat(64), threadRootId: root, thread: true },
      undefined,
      { author: "owner", text: "Follow up A" },
    );
    followUp.acknowledged();
    expect(
      local.reader.work()[2]?.evidence?.messages.map(({ text }) => text),
    ).toEqual(
      flat
        ? ["Request A", "Reply A", "Request B", "Follow up A"]
        : ["Request A", "Reply A", "Follow up A"],
    );
  },
);

it("captures accepted boundaries independently of steps and publication, rejecting stale callbacks", () => {
  const local = createLocalAgentActivity();
  const input = {
    scope,
    agent,
    channelId: "channel",
    threadRootId: root,
    messageId: root,
  };
  const first = local.begin(input, undefined, {
    author: "owner",
    text: "Can you test it?",
  });
  first.started();
  expect(local.reader.work()[0]?.evidence).toBeNull();
  first.acknowledged();
  const wake = local.reader.work()[0]?.evidence;
  expect(wake?.lifecycle.phase).toBe("wake");
  first.acknowledged({ steering: true });
  first.step("Read", "private-path");
  const sent = first.sending("Please choose a scope");
  expect(local.reader.work()[0]?.evidence).toBe(wake);
  first.finish({ ok: true });
  const handoff = local.reader.work()[0]?.evidence;
  expect(local.reader.work()[0]?.publishing).toBe(1);
  expect(handoff?.lifecycle.phase).toBe("handoff");
  expect(handoff?.lifecycle.revision).toBeGreaterThan(
    wake?.lifecycle.revision ?? 0,
  );
  expect(
    handoff?.messages.map(({ role, text, delivery }) => ({
      role,
      text,
      delivery,
    })),
  ).toEqual([
    { role: "user", text: "Can you test it?", delivery: undefined },
    { role: "assistant", text: "Please choose a scope", delivery: "pending" },
  ]);
  sent(true);
  first.finish({ ok: true });
  expect(local.reader.work()[0]?.evidence).toBe(handoff);
  const next = local.begin({ ...input, messageId: reply }, undefined, {
    author: "owner",
    text: "Use staging",
  });
  next.acknowledged({ steering: true });
  const steer = local.reader.work()[1]?.evidence;
  expect(steer?.lifecycle.phase).toBe("steer");
  expect(steer?.messages.map(({ text }) => text)).toEqual([
    "Can you test it?",
    "Please choose a scope",
    "Use staging",
  ]);
  expect(steer?.messages[1]?.delivery).toBe("published");
  next.started();
  const failed = next.sending("An undelivered answer");
  failed(false);
  expect(local.reader.work()[1]?.evidence).toBe(steer);
  expect(local.reader.work()[1]?.state).toBe("working");
  next.finish({ ok: false, error: "Publication failed" });
  expect(local.reader.work()[1]?.state).toBe("error");
  expect(local.reader.work()[1]?.evidence?.messages.at(-1)).toMatchObject({
    text: "An undelivered answer",
    delivery: "failed",
  });
  const replaced = local.begin({ ...input, messageId: reply });
  next.finish({ ok: true });
  expect(local.reader.work()[1]?.evidence).toBeNull();
  replaced.acknowledged();
  expect(local.reader.work()[1]?.evidence?.lifecycle.id).not.toBe(
    steer?.lifecycle.id,
  );
  local.clear();
  replaced.acknowledged();
  replaced.finish({ ok: true });
  expect(local.reader.work()).toEqual([]);
});

it("bounds visible history, marks synthetic input, and isolates logical sessions and sources", () => {
  const local = createLocalAgentActivity();
  const input = {
    scope,
    agent,
    channelId: "channel",
    threadRootId: root,
    messageId: root,
    syntheticMessage: true as const,
    requestText: "Wake now",
  };
  const first = local.begin(input);
  first.associate({ sessionKey: "one", router: "router", association: null });
  first.acknowledged();
  expect(local.reader.work()[0]?.evidence?.messages[0]).toMatchObject({
    author: "host",
    text: "Wake now",
    synthetic: true,
  });
  for (let i = 0; i < 65; i++) first.sending(String(i))(true);
  first.finish({ ok: true });
  const bounded = local.reader.work()[0]?.evidence;
  expect(bounded?.messages).toHaveLength(64);
  expect(bounded?.messages[0]?.text).toBe("1");
  expect(bounded?.omitted.messages).toBe(2);
  for (const [messageId, patch, sessionKey] of [
    ["new-session", {}, "two"],
    ["other-thread", { thread: true as const }, "one"],
    ["other-agent", { agent: "other" }, "one"],
    ["other-scope", { scope: "other" }, "one"],
  ] as const) {
    const work = local.begin({
      ...input,
      messageId,
      ...patch,
      requestText: messageId,
    });
    work.associate({ sessionKey, router: "router", association: null });
    work.acknowledged();
    expect(
      local.reader
        .work()
        .at(-1)
        ?.evidence?.messages.map(({ text }) => text),
    ).toEqual([messageId]);
  }
  const large = local.begin({
    ...input,
    messageId: "large",
    requestText: "x".repeat(65_540),
  });
  large.acknowledged();
  expect(local.reader.work().at(-1)?.evidence?.messages[0]?.text).toHaveLength(
    65_536,
  );
  expect(local.reader.work().at(-1)?.evidence?.omitted.characters).toBe(4);
});

it("projects one local source into channel, exact thread and message without needing observer telemetry", () => {
  const local = createLocalAgentActivity();
  let allowed = true;
  const activity = createAgentActivity(
    false,
    () => {},
    (channel) => allowed && channel === "channel",
    undefined,
    undefined,
    { source: local.reader, scope },
  );
  const snapshot = activity.queries.snapshot;
  try {
    local.begin({
      scope: "other",
      agent,
      channelId: "channel",
      threadRootId: root,
      messageId: root,
    });
    expect(snapshot().local).toEqual([]);
    const work = local.begin({
      scope,
      agent,
      channelId: "channel",
      threadRootId: root,
      messageId: reply,
    });
    expect(localActivity(snapshot(), "channel").get(agent)?.state).toBe(
      "waiting",
    );
    expect(workingAgents(snapshot(), "channel")).toEqual([agent]);
    expect(threadWorkingAgents(snapshot(), [], "channel", root)).toEqual([
      agent,
    ]);
    expect(threadWorkingAgents(snapshot(), [], "channel", reply)).toEqual([]);
    expect(messageActivity(snapshot(), "channel", reply)[0]?.state).toBe(
      "waiting",
    );
    expect(messageActivity(snapshot(), "channel", root)).toEqual([]);
    work.started();
    expect(messageActivity(snapshot(), "channel", reply)[0]?.working).toBe(
      true,
    );
    work.finish({ ok: false, error: "Provider unavailable" });
    expect(workingAgents(snapshot(), "channel")).toEqual([]);
    expect(threadWorkingAgents(snapshot(), [agent], "channel", root)).toEqual(
      [],
    );
    expect(messageActivity(snapshot(), "channel", reply)[0]).toMatchObject({
      state: "error",
      reason: "Provider unavailable",
    });
    const next = local.begin({
      scope,
      agent,
      channelId: "channel",
      threadRootId: root,
      messageId: reply,
    });
    work.finish({ ok: true });
    expect(messageActivity(snapshot(), "channel", reply)[0]?.state).toBe(
      "waiting",
    );
    next.started();
    next.finish({ ok: true });
    expect(messageActivity(snapshot(), "channel", reply)).toEqual([]);
    allowed = false;
    activity.accessChanged();
    expect(snapshot().local).toEqual([]);
  } finally {
    activity.dispose();
  }
});

it("keeps storage bounded and prevents evicted or removed callbacks from recreating state", () => {
  const local = createLocalAgentActivity();
  const old = local.begin({
    scope,
    agent,
    channelId: "channel",
    messageId: "old",
    threadRootId: root,
  });
  for (let i = 0; i < 520; i++)
    local.begin({
      scope,
      agent,
      channelId: "channel",
      messageId: String(i),
      threadRootId: root,
    });
  expect(local.reader.work()).toHaveLength(512);
  old.finish({ ok: false, error: "Late error" });
  expect(local.reader.work().some((row) => row.messageId === "old")).toBe(
    false,
  );
  const pending = local.begin({
    scope,
    agent,
    channelId: "channel",
    messageId: reply,
    threadRootId: root,
  });
  local.clear(scope, agent);
  pending.started();
  pending.finish({ ok: true });
  expect(local.reader.work()).toEqual([]);
});

it("expires reply correlations after the notification freshness window", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_780_000_000_000);
  try {
    const activity = createLocalAgentActivity();
    const work = activity.begin(request());
    work.reply(reply);
    expect(activity.reader.work()[0]?.replyMessages).toHaveLength(1);
    vi.advanceTimersByTime(120_001);
    expect(activity.reader.work()[0]).not.toHaveProperty("replyMessages");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps fresh reply correlations when retry replaces the failed attempt", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_780_000_000_000);
  try {
    const activity = createLocalAgentActivity();
    const first = activity.begin(request(), () => {});
    first.reply(reply);
    first.finish({ ok: false, error: "Provider unavailable" });
    vi.advanceTimersByTime(1);
    activity.begin(request(), () => {});
    expect(activity.reader.work()[0]?.replyMessages).toEqual([
      expect.objectContaining({ id: reply }),
    ]);
    vi.advanceTimersByTime(120_000);
    expect(activity.reader.work()[0]).not.toHaveProperty("replyMessages");
  } finally {
    vi.useRealTimers();
  }
});

it("shows the latest live step while working and drops it once settled", () => {
  const activity = createLocalAgentActivity();
  const work = activity.begin({
    scope: "s",
    agent: "a",
    channelId: "c",
    messageId: "m",
    threadRootId: "m",
  });
  const row = () => {
    const current = activity.reader.work()[0];
    if (!current) throw new Error("Expected local work");
    return current;
  };
  work.step("Read", "  notes.txt ");
  expect(row()).toMatchObject({
    state: "working",
    step: { tool: "Read", target: "notes.txt" },
  });
  expect(localWorkLabel(row())).toBe("Reading notes.txt");
  work.step("   ");
  expect(row()?.step?.tool).toBe("Read");
  work.finish({ ok: true });
  expect(row()?.step).toBeUndefined();
  work.step("Late");
  expect(row()).toMatchObject({ state: "done" });
  expect(localWorkLabel(row())).toBe("Finished");
});

it("words readable steps from the harness's own tool names and targets", () => {
  const text = (tool: string, target?: string) =>
    stepText(target ? { tool, target } : { tool });
  expect(text("Bash", "Custom harness catalog build")).toBe(
    "Custom harness catalog build",
  );
  expect(text("Shell", "ls")).toBe("Running ls");
  expect(text("Shell")).toBe("Running a command");
  expect(text("Edit", "discovery.rs")).toBe("Editing discovery.rs");
  expect(text("Agent", "Find harness")).toBe("Subagent · Find harness");
  expect(text("send")).toBe("Sending a message");
  expect(text("Bash")).toBe("Running a command");
  expect(text("custom_tool", "x")).toBe("custom_tool · x");
  expect(text("custom_tool")).toBe("custom_tool");
});

const request = (messageId = "m") => ({
  scope: "s",
  agent: "a",
  channelId: "c",
  messageId,
  threadRootId: "m",
});
const target = { scope: "s", agent: "a", messageId: "m" };

it("stops a stoppable request through its harness and shows it stopped", async () => {
  const activity = createLocalAgentActivity();
  const work = activity.begin(request());
  const stop = vi.fn(async () => {});
  const row = () => {
    const current = activity.reader.work()[0];
    if (!current) throw new Error("Expected local work");
    return current;
  };
  expect(row().stoppable).toBeUndefined();
  work.step("Read", "notes.txt");
  work.interruptible(stop);
  expect(row()).toMatchObject({ state: "working", stoppable: true });
  work.step("Edit", "other.txt");
  expect(row().stoppable).toBe(true);
  await activity.reader.interrupt?.(target);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(row()).toMatchObject({ state: "stopped" });
  expect(row().step).toBeUndefined();
  expect(row().stoppable).toBeUndefined();
  expect(localWorkLabel(row())).toBe("Stopped");
  // A late outcome from the cancelled turn cannot reopen or relabel the row.
  work.finish({ ok: false, error: "Cancelled" });
  work.finish({ ok: true });
  work.step("Late");
  expect(row()).toMatchObject({ state: "stopped" });
  expect(row().error).toBeUndefined();
  await activity.reader.interrupt?.(target);
  expect(stop).toHaveBeenCalledTimes(1);
});

it("shows a request stopped when its harness reports the stop ended the turn", () => {
  const activity = createLocalAgentActivity();
  const work = activity.begin(request());
  work.step("Read", "notes.txt");
  work.interruptible(async () => {});
  work.finish({ ok: true, stopped: true });
  const row = activity.reader.work()[0];
  expect(row).toMatchObject({ state: "stopped" });
  expect(row?.step).toBeUndefined();
  expect(row?.stoppable).toBeUndefined();
});

it("ranks stopped work as settled, below any live request of the same agent", async () => {
  const activity = createLocalAgentActivity();
  const stopped = activity.begin(request("one"));
  stopped.interruptible(async () => {});
  activity.begin(request("two")).started();
  await activity.reader.interrupt?.({ ...target, messageId: "one" });
  const snapshot = { local: activity.reader.work() };
  expect(snapshot.local[0]?.state).toBe("stopped");
  expect(localActivity(snapshot, "c").get("a")?.messageId).toBe("two");
});

it.each([
  ["finish", (work: Work) => work.finish({ ok: true })],
  ["fail", (work: Work) => work.finish({ ok: false, error: "Broke" })],
  ["supersede", (work: Work) => work.supersede()],
  ["remove", (work: Work) => work.remove()],
])("loses its stopper once it settles by %s", async (_name, settle) => {
  const activity = createLocalAgentActivity();
  const work = activity.begin(request());
  const stop = vi.fn(async () => {});
  work.interruptible(stop);
  settle(work);
  expect(activity.reader.work()[0]?.stoppable).toBeUndefined();
  await activity.reader.interrupt?.(target);
  expect(stop).not.toHaveBeenCalled();
  expect(activity.reader.work()[0]?.state).not.toBe("stopped");
});

it("ignores a stopper registered after the request settled", async () => {
  const activity = createLocalAgentActivity();
  const work = activity.begin(request());
  const stop = vi.fn(async () => {});
  work.finish({ ok: true });
  work.interruptible(stop);
  expect(activity.reader.work()[0]).toMatchObject({ state: "done" });
  expect(activity.reader.work()[0]?.stoppable).toBeUndefined();
  await activity.reader.interrupt?.(target);
  expect(stop).not.toHaveBeenCalled();
});

it("keeps the request working and reports the failure when its stopper rejects", async () => {
  const activity = createLocalAgentActivity();
  const work = activity.begin(request());
  const stop = vi.fn(async (): Promise<void> => {
    throw new Error("Harness refused");
  });
  work.step("Read", "notes.txt");
  work.interruptible(stop);
  await expect(activity.reader.interrupt?.(target)).rejects.toThrow(
    "Harness refused",
  );
  expect(activity.reader.work()[0]).toMatchObject({
    state: "working",
    stoppable: true,
    step: { tool: "Read", target: "notes.txt" },
  });
  // Stop stays offered, so the owner can try again.
  stop.mockResolvedValueOnce(undefined);
  await activity.reader.interrupt?.(target);
  expect(activity.reader.work()[0]).toMatchObject({ state: "stopped" });
});

it("leaves the outcome alone when the turn settles while its stopper runs", async () => {
  const activity = createLocalAgentActivity();
  const work = activity.begin(request());
  let release!: () => void;
  work.interruptible(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const stopping = activity.reader.interrupt?.(target);
  work.finish({ ok: true });
  release();
  await stopping;
  expect(activity.reader.work()[0]).toMatchObject({ state: "done" });
});

it("stops only the exact request and not an unmatched scope, agent or message", async () => {
  const activity = createLocalAgentActivity();
  const stop = vi.fn(async () => {});
  activity.begin(request()).interruptible(stop);
  await activity.reader.interrupt?.({ ...target, scope: "other" });
  await activity.reader.interrupt?.({ ...target, agent: "b" });
  await activity.reader.interrupt?.({ ...target, messageId: "n" });
  expect(stop).not.toHaveBeenCalled();
  expect(activity.reader.work()[0]).toMatchObject({
    state: "waiting",
    stoppable: true,
  });
});

it("drops a stopper when its request is replaced, evicted or cleared", async () => {
  const activity = createLocalAgentActivity();
  const replaced = vi.fn(async () => {});
  activity.begin(request()).interruptible(replaced);
  const next = activity.begin(request());
  expect(activity.reader.work()[0]?.stoppable).toBeUndefined();
  await activity.reader.interrupt?.(target);
  expect(replaced).not.toHaveBeenCalled();
  const live = vi.fn(async () => {});
  next.interruptible(live);
  await activity.reader.interrupt?.(target);
  expect(live).toHaveBeenCalledTimes(1);

  const bounded = createLocalAgentActivity();
  const evicted = vi.fn(async () => {});
  const settled = bounded.begin(request("settled"));
  settled.interruptible(evicted);
  settled.finish({ ok: true });
  for (let i = 0; i < 520; i++) bounded.begin(request(String(i)));
  await bounded.reader.interrupt?.({ ...target, messageId: "settled" });
  expect(evicted).not.toHaveBeenCalled();

  const cleared = createLocalAgentActivity();
  const stop = vi.fn(async () => {});
  cleared.begin(request()).interruptible(stop);
  cleared.clear("s", "a");
  await cleared.reader.interrupt?.(target);
  expect(stop).not.toHaveBeenCalled();
  expect(cleared.reader.work()).toEqual([]);
});

it("offers Stop through the session only for this scope and accessible channels, and hides stopped bubbles", async () => {
  const local = createLocalAgentActivity();
  let allowed = true;
  const activity = createAgentActivity(
    false,
    () => {},
    (channel) => allowed && channel === "channel",
    undefined,
    undefined,
    { source: local.reader, scope },
  );
  const snapshot = activity.queries.snapshot;
  const stop = vi.fn(async () => {});
  try {
    const work = local.begin({
      scope,
      agent,
      channelId: "channel",
      threadRootId: root,
      messageId: reply,
    });
    work.started();
    work.interruptible(stop);
    expect(messageActivity(snapshot(), "channel", reply)[0]).toMatchObject({
      state: "working",
      stoppable: true,
    });
    allowed = false;
    await expect(
      activity.queries.interrupt(agent, "channel", reply),
    ).rejects.toThrow("This work can't be stopped here");
    expect(stop).not.toHaveBeenCalled();
    allowed = true;
    await activity.queries.interrupt(agent, "channel", reply);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(snapshot().local?.[0]).toMatchObject({ state: "stopped" });
    expect(messageActivity(snapshot(), "channel", reply)).toEqual([]);
    expect(workingAgents(snapshot(), "channel")).toEqual([]);
    expect(threadWorkingAgents(snapshot(), [], "channel", root)).toEqual([]);
  } finally {
    activity.dispose();
  }
  await expect(
    activity.queries.interrupt(agent, "channel", reply),
  ).rejects.toThrow("This work can't be stopped here");
});

it("cannot stop work from a source that has no way to interrupt", async () => {
  const local = createLocalAgentActivity();
  const { interrupt: _interrupt, ...reader } = local.reader;
  const activity = createAgentActivity(
    false,
    () => {},
    () => true,
    undefined,
    undefined,
    { source: reader, scope },
  );
  try {
    await expect(
      activity.queries.interrupt(agent, "channel", reply),
    ).rejects.toThrow("This work can't be stopped here");
  } finally {
    activity.dispose();
  }
  const bare = createAgentActivity(
    false,
    () => {},
    () => true,
  );
  try {
    await expect(
      bare.queries.interrupt(agent, "channel", reply),
    ).rejects.toThrow("This work can't be stopped here");
  } finally {
    bare.dispose();
  }
});

it("retries only the exact failed request, once replaced asking again of its new row", () => {
  const activity = createLocalAgentActivity();
  const retry = vi.fn(() => {
    activity.begin(request(), again);
  });
  const again = vi.fn();
  const work = activity.begin(request(), retry);
  expect(activity.reader.work()[0]).toMatchObject({
    state: "waiting",
    retryable: true,
  });
  // Only a failure is asked again.
  expect(() => activity.reader.retry?.(target)).toThrow(
    "This request can't be retried",
  );
  work.finish({ ok: false, error: "Provider unavailable" });
  for (const other of [
    { ...target, scope: "other" },
    { ...target, agent: "b" },
    { ...target, messageId: "n" },
  ])
    expect(() => activity.reader.retry?.(other)).toThrow();
  expect(retry).not.toHaveBeenCalled();
  activity.reader.retry?.(target);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(activity.reader.work()).toEqual([
    expect.objectContaining({ state: "waiting", retryable: true }),
  ]);
  // A late outcome of the replaced request changes nothing.
  work.finish({ ok: false, error: "Late" });
  expect(() => activity.reader.retry?.(target)).toThrow();
  expect(again).not.toHaveBeenCalled();

  const plain = createLocalAgentActivity();
  plain.begin(request()).finish({ ok: false });
  expect(plain.reader.work()[0]?.retryable).toBeUndefined();
  expect(() => plain.reader.retry?.(target)).toThrow();

  const cleared = createLocalAgentActivity();
  const dropped = vi.fn();
  cleared.begin(request(), dropped).finish({ ok: false });
  cleared.clear("s", "a");
  expect(() => cleared.reader.retry?.(target)).toThrow();
  expect(dropped).not.toHaveBeenCalled();
});

it("retries through the session only for this scope and accessible channels", () => {
  const local = createLocalAgentActivity();
  let allowed = true;
  const activity = createAgentActivity(
    false,
    () => {},
    (channel) => allowed && channel === "channel",
    undefined,
    undefined,
    { source: local.reader, scope },
  );
  const retry = vi.fn();
  try {
    local
      .begin(
        {
          scope,
          agent,
          channelId: "channel",
          threadRootId: root,
          messageId: reply,
        },
        retry,
      )
      .finish({ ok: false, error: "Provider unavailable" });
    expect(
      messageActivity(activity.queries.snapshot(), "channel", reply)[0],
    ).toMatchObject({ state: "error", retryable: true });
    allowed = false;
    expect(() => activity.queries.retry(agent, "channel", reply)).toThrow(
      "This request can't be retried here",
    );
    expect(retry).not.toHaveBeenCalled();
    allowed = true;
    activity.queries.retry(agent, "channel", reply);
    expect(retry).toHaveBeenCalledTimes(1);
  } finally {
    activity.dispose();
  }
  expect(() => activity.queries.retry(agent, "channel", reply)).toThrow(
    "This request can't be retried here",
  );
});
