import { expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import { currentActivity, workingRequests } from "./current-activity";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
const agent = "a".repeat(64),
  root = "b".repeat(64),
  otherRoot = "c".repeat(64);
const now = Date.parse("2026-10-08T12:00:00Z");
const base: Snapshot = {
  status: "listening",
  typing: [],
  records: [],
  turns: [],
  trimmed: 0,
};
function snapshot(
  tool: object = {},
  threadRootEventId: string | null = root,
): Snapshot {
  const events = [
    { kind: "turn_started", payload: { threadRootEventId } },
    {
      kind: "acp_read",
      payload: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "S",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call",
            title: "buzz-dev-mcp__str_replace",
            kind: "other",
            status: "in_progress",
            rawInput: { path: "/private/work/index.html", old_str: "secret" },
            ...tool,
          },
        },
      },
    },
  ].map((frame, seq) => ({
    ...frame,
    seq,
    timestamp: new Date(now + seq).toISOString(),
    channelId: "channel",
    turnId: "turn",
    sessionId: "S",
  }));
  return {
    ...base,
    turns: [
      {
        agent,
        channelId: "channel",
        turnId: "turn",
        timestamp: now,
        state: "working",
      },
    ],
    records: [
      {
        id: "d".repeat(64),
        agent,
        createdAt: now / 1000,
        receivedAt: now + 100,
        kind: "batch",
        channelIds: ["channel"],
        plaintext: JSON.stringify({ kind: "batch", payload: { events } }),
      },
    ],
  };
}
const project = (value: Snapshot, scope?: string) =>
  currentActivity(value, [], new Set(), "channel", scope);

it("projects safe brief tool status from exact current owner-visible work only", () => {
  const live = snapshot();
  expect(project(live).get(agent)).toEqual({
    label: "Editing index.html",
    detailAvailability: "available",
    roots: [root],
  });
  expect(project(live, root).get(agent)?.label).toBe("Editing index.html");
  expect(project(live, otherRoot).size).toBe(0);
  expect(currentActivity(live, [], new Set(), "elsewhere").size).toBe(0);
  expect(project({ ...live, turns: [] }).size).toBe(0);
  expect(project({ ...live, records: [] }, root).size).toBe(0);
});

it("drops owner-only work when not listening without hiding valid public typing", () => {
  const live = { ...snapshot(), status: "disabled" as const };
  expect(project(live).size).toBe(0);
  const entries = [{ pubkey: agent, channelId: "channel", threadRootId: root }];
  expect(
    currentActivity(live, entries, new Set([agent]), "channel", root).get(
      agent,
    ),
  ).toEqual({
    label: "Working",
    detailAvailability: "typing-only",
    roots: [root],
  });
  expect(currentActivity(live, entries, new Set(), "channel").size).toBe(0);
});

it.each([
  [
    { title: "arbitrary command with secrets", kind: "execute" },
    "Running a command",
  ],
  [{ title: "unknown", kind: "other" }, "Running a tool"],
  [{ status: "pending" }, "Preparing a tool"],
  [{ status: "completed" }, "Working", "no-current-step"],
  [
    { rawInput: { path: "C:\\private\\report\u202e.txt" } },
    "Editing report.txt",
  ],
  [
    {
      title: "read",
      kind: "read",
      locations: [{ path: "/private/report.txt" }],
    },
    "Reading report.txt",
  ],
])(
  "keeps compact labels safe: %j",
  (tool, expected, unavailable = "available") => {
    expect(project(snapshot(tool)).get(agent)).toMatchObject({
      label: expected,
      detailAvailability: unavailable,
    });
  },
);

it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
  "treats inherited dictionary key %s as telemetry, not a label mapping",
  (key) => {
    expect(
      project(snapshot({ title: "unknown", kind: key })).get(agent)?.label,
    ).toBe("Running a tool");
    expect(
      project(snapshot({ title: key, kind: "other" })).get(agent)?.label,
    ).toBe("Running a tool");
    // Only an exact local tool name may decode rawInput.path.
    expect(
      project(snapshot({ title: key, kind: "read" })).get(agent)?.label,
    ).toBe("Reading");
    expect(project(snapshot({ kind: key })).get(agent)?.label).toBe(
      "Editing index.html",
    );
  },
);

it("does not merge labels or ownership across roots or expired turns", () => {
  const live = snapshot();
  const entries = [
    { pubkey: agent, channelId: "channel", threadRootId: otherRoot },
  ];
  expect(
    currentActivity(live, entries, new Set([agent]), "channel", otherRoot).get(
      agent,
    ),
  ).toEqual({
    label: "Working",
    detailAvailability: "typing-only",
    roots: [otherRoot],
  });
  expect(
    project({
      ...live,
      turns: live.turns.map((turn) => ({ ...turn, state: "ended" })),
    }).size,
  ).toBe(0);
  expect(
    project({
      ...live,
      turns: live.turns.map((turn) => ({ ...turn, state: "unknown" })),
    }).size,
  ).toBe(0);
});

it("keeps channel conversation and unconfirmed work distinct and out of thread views", () => {
  const channelTyping = {
    ...base,
    typing: [
      {
        agent,
        channelId: "channel",
        threadRootId: undefined,
        working: true,
        startedAt: now,
        timestamp: now,
        expiresAt: now + 8000,
      },
    ],
  };
  expect(project(channelTyping).get(agent)?.roots).toEqual([null]);
  expect(project(channelTyping, root).size).toBe(0);
  const unknown = { ...snapshot(), records: [] };
  expect(project(unknown).get(agent)?.roots).toEqual([undefined]);
  expect(project(unknown, root).size).toBe(0);
});

it("does not resurrect a transcript's terminal turn from stale working evidence", () => {
  const live = snapshot();
  const record = live.records[0];
  if (!record) throw new Error("Expected a live fixture record");
  const batch = JSON.parse(record.plaintext);
  batch.payload.events.push({
    kind: "turn_completed",
    channelId: "channel",
    turnId: "turn",
    sessionId: "S",
    seq: 2,
    timestamp: new Date(now + 2).toISOString(),
  });
  expect(
    project({
      ...live,
      records: [{ ...record, plaintext: JSON.stringify(batch) }],
    }).size,
  ).toBe(0);
});

it("keeps known thread work out of the channel flow without hiding channel work", () => {
  const thread = snapshot();
  expect(
    currentActivity(thread, [], new Set(), "channel", undefined, false).size,
  ).toBe(0);
  expect(
    currentActivity(thread, [], new Set(), "channel", root, false).has(agent),
  ).toBe(true);
  expect(
    currentActivity(
      snapshot({}, null),
      [],
      new Set(),
      "channel",
      undefined,
      false,
    ).has(agent),
  ).toBe(true);
  const local = {
    scope: "test",
    agent,
    channelId: "channel",
    messageId: root,
    threadRootId: root,
    state: "working" as const,
    startedAt: 1,
  };
  expect(
    currentActivity(
      { ...base, local: [{ ...local, thread: true }] },
      [],
      new Set(),
      "channel",
      undefined,
      false,
    ).size,
  ).toBe(0);
  expect(
    currentActivity(
      { ...base, local: [local] },
      [],
      new Set(),
      "channel",
      undefined,
      false,
    ).has(agent),
  ).toBe(true);
});

it("moves channel-started local work into its observed reply thread", () => {
  const live = {
    ...base,
    local: [
      {
        scope: "test",
        agent,
        channelId: "channel",
        messageId: root,
        threadRootId: root,
        state: "working" as const,
        startedAt: 1,
      },
    ],
  };
  expect(
    currentActivity(
      live,
      [],
      new Set(),
      "channel",
      undefined,
      false,
      new Set([root]),
    ).size,
  ).toBe(0);
  expect(
    currentActivity(
      live,
      [],
      new Set(),
      "channel",
      root,
      false,
      new Set([root]),
    ).has(agent),
  ).toBe(true);
});

it("lists each working request here by its exact triggers, local work superseding remote turns", () => {
  const turn = (turnId: string, triggers: string[], threadRootId = root) => ({
    agent,
    turnId,
    channelId: "channel",
    threadRootId,
    timestamp: now,
    state: "working" as const,
    triggeringEventIds: triggers,
  });
  const remote: Snapshot = {
    ...base,
    turns: [
      // One batched turn answers both of its triggers.
      turn("batch", ["h1", "h2"]),
      turn("next", ["h3"]),
      turn("elsewhere", ["h4"], otherRoot),
      { ...turn("done", ["h5"]), state: "ended" },
    ],
  };
  expect(workingRequests(remote, agent, "channel", root)).toEqual([
    ["h1", "h2"],
    ["h3"],
  ]);
  expect(workingRequests(remote, "other", "channel", root)).toEqual([]);
  expect(
    workingRequests(
      { ...remote, status: "connecting" },
      agent,
      "channel",
      root,
    ),
  ).toEqual([]);
  const local = (messageId: string, state: "working" | "done") => ({
    scope: "test",
    agent,
    channelId: "channel",
    messageId,
    threadRootId: root,
    thread: true as const,
    state,
    startedAt: 1,
  });
  // A settled local request is not resurrected by an older remote turn.
  expect(
    workingRequests(
      { ...remote, local: [local("l1", "done")] },
      agent,
      "channel",
      root,
    ),
  ).toEqual([]);
  expect(
    workingRequests(
      { ...remote, local: [local("l1", "working"), local("l2", "working")] },
      agent,
      "channel",
      root,
    ),
  ).toEqual([["l1"], ["l2"]]);
});
