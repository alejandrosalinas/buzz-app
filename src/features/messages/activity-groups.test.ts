import { expect, it } from "vitest";
import { activityPresentation } from "./activity-presentation";
import { activityRuns } from "./activity-groups";
import type { ChannelMessage } from "../relay/contracts";

const activity = (
  id: string,
  patch: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id,
  channelId: "solo",
  authorId: "agent",
  audience: "agents",
  createdAt: 100,
  content: id,
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
  ...patch,
});
const publicMessage = (id: string, patch: Partial<ChannelMessage> = {}) => {
  const { audience: _audience, ...row } = activity(id, patch);
  return row;
};
const run = (prefix: string, count = 6) =>
  Array.from({ length: count }, (_, index) => activity(`${prefix}${index}`));

it("retires superseded tool updates while the steered request keeps working", () => {
  const { audience: _audience, ...request } = activity("request", {
    authorId: "human",
  });
  const steer = { ...request, id: "steer" };
  const oldStep = activity("old-step", { replyParentId: request.id });
  const newStep = activity("new-step", { replyParentId: steer.id });
  const rows = [request, oldStep, steer, newStep];
  const presentation = activityPresentation(
    rows,
    {
      status: "listening",
      typing: [],
      records: [],
      turns: [],
      trimmed: 0,
      local: [
        {
          scope: "test",
          agent: "agent",
          channelId: "solo",
          threadRootId: "request",
          messageId: "request",
          startedAt: 1,
          state: "superseded",
        },
        {
          scope: "test",
          agent: "agent",
          channelId: "solo",
          threadRootId: "request",
          messageId: "steer",
          startedAt: 2,
          state: "working",
        },
      ],
    },
    new Set(["agent"]),
  );
  expect(presentation.groups[0]?.retired).toBe(true);
  expect(presentation.groups[0]?.history).toEqual([oldStep]);
  expect(presentation.groups[1]?.retired).toBe(false);
  expect(presentation.byRow.get(newStep.id)?.active).toBe(true);
});

it("folds consecutive activity into one preview and includes different agents in a run", () => {
  const single = run("a", 1);
  expect(activityRuns(single)).toEqual([single]);
  const rows = run("a");
  rows[2] = activity("other-agent", { authorId: "other" });
  expect(activityRuns(rows)).toEqual([rows]);
});

it.each(["human", "agent", "membership"])(
  "keeps ordinary messages and membership notices outside groups: %s",
  (kind) => {
    const before = run("before"),
      after = run("after");
    const { audience: _audience, ...ordinary } = activity("separator");
    const separator =
      kind === "membership"
        ? {
            ...ordinary,
            membership: {
              type: "member_joined" as const,
              actor: "human",
              target: "human",
            },
          }
        : { ...ordinary, authorId: kind };
    expect(activityRuns([...before, separator, ...after])).toEqual([
      before,
      after,
    ]);
  },
);

it("splits groups across local days and channels", () => {
  const today = run("today");
  const tomorrow = run("tomorrow").map((row) => ({
    ...row,
    createdAt: 100 + 86400,
  }));
  const elsewhere = run("elsewhere").map((row) => ({
    ...row,
    channelId: "other",
  }));
  expect(activityRuns([...today, ...tomorrow, ...elsewhere])).toEqual([
    today,
    tomorrow,
    elsewhere,
  ]);
});

it.each([1, 2])(
  "retires the live treatment of %i historical steps without losing their history",
  (count) => {
    const history = run("step", count);
    const { audience: _, ...reply } = activity("reply");
    const rows = [...history, reply];
    const completed = activityPresentation(rows, undefined, new Set(["agent"]));
    expect(completed.groups[0]?.retired).toBe(true);
    expect(completed.groups[0]?.history).toEqual(history);
    const otherReply = { ...reply, authorId: "human" };
    const pending = [...history, otherReply];
    expect(
      activityPresentation(pending, undefined, new Set(["agent"])).groups[0]
        ?.retired,
    ).toBe(false);
  },
);

it("hands unparented thread replies to the latest request without overriding explicit reply links", () => {
  const { audience: _requestAudience, ...request } = activity("request", {
    authorId: "human",
    threadRootId: "root",
  });
  const { audience: _replyAudience, ...reply } = activity("reply", {
    agentEnvelope: true,
    threadRootId: "root",
  });
  const projected = (patch: Partial<ChannelMessage>) =>
    activityPresentation(
      [request, { ...reply, ...patch }],
      undefined,
      new Set(["agent"]),
      "root",
    ).representedAgents;
  expect(projected({}).get("request")).toEqual(["agent"]);
  expect(projected({}).get("root")).toBeUndefined();
  expect(projected({ replyParentId: "root" }).get("root")).toEqual(["agent"]);
  expect(projected({ replyParentId: "root" }).get("request")).toBeUndefined();
});

it.each([
  {
    label: "coordinator",
    authorId: "coordinator",
    replyParentId: "request",
    retired: true,
  },
  {
    label: "unrelated agent",
    authorId: "other",
    replyParentId: "request",
    retired: false,
  },
  {
    label: "human recipient",
    authorId: "human",
    replyParentId: "request",
    retired: false,
  },
  {
    label: "another request",
    authorId: "coordinator",
    replyParentId: "earlier",
    retired: false,
  },
])(
  "only retires the live helper treatment after its coordinator replies: $label",
  ({ authorId, replyParentId, retired }) => {
    const request = publicMessage("request", {
      authorId: "human",
    });
    const earlier = { ...request, id: "earlier" };
    const checking = activity("checking", { replyParentId: "request" });
    const result = activity("result", {
      replyParentId: "request",
      mentions: ["coordinator", "human"],
    });
    const reply = publicMessage("reply", {
      authorId,
      replyParentId,
    });
    const rows = [earlier, request, checking, result, reply];
    const agents = new Set(["agent", "coordinator", "other"]);
    const project = (messages: ChannelMessage[]) =>
      activityPresentation(messages, undefined, agents).groups[0];
    expect(project(rows.slice(0, -1))?.retired).toBe(false);
    expect(project(rows)?.retired).toBe(retired);
    expect(project(rows)?.history).toEqual([checking, result]);
  },
);

it.each([
  "waiting",
  "working",
  "error",
  "stopped",
  "done",
  "superseded",
] as const)(
  "uses explicit helper lifecycle over a public progress reply: %s",
  (state) => {
    const request = publicMessage("request", {
      authorId: "human",
    });
    const step = activity("step", {
      replyParentId: request.id,
      mentions: ["coordinator"],
    });
    const reply = publicMessage("reply", {
      authorId: "coordinator",
      replyParentId: request.id,
    });
    const rows = [request, step, reply];
    const projection = activityPresentation(
      rows,
      {
        status: "listening",
        records: [],
        turns: [],
        typing: [],
        trimmed: 0,
        local: [
          {
            scope: "test",
            agent: "agent",
            channelId: "solo",
            threadRootId: request.id,
            messageId: request.id,
            startedAt: 1,
            state,
          },
        ],
      },
      new Set(["agent", "coordinator"]),
    );
    const settled = ["done", "stopped", "superseded"].includes(state);
    expect(projection.groups[0]?.retired).toBe(settled);
    expect(projection.groups[0]?.history).toEqual([step]);
    expect(projection.byRow.get(step.id)?.active).toBe(state === "working");
  },
);

it("does not borrow completion from a preceding human message without a reply link", () => {
  const request = publicMessage("request", {
    authorId: "human",
  });
  const step = activity("step");
  const rows = [request, step];
  const projection = activityPresentation(
    rows,
    {
      status: "listening",
      records: [],
      turns: [],
      typing: [],
      trimmed: 0,
      local: [
        {
          scope: "test",
          agent: "agent",
          channelId: "solo",
          threadRootId: request.id,
          messageId: request.id,
          startedAt: 1,
          state: "done",
        },
      ],
    },
    new Set(["agent"]),
  );
  expect(projection.groups[0]?.retired).toBe(false);
});

it("keeps interleaved requests separate when one helper finishes", () => {
  const first = publicMessage("first", { authorId: "human" });
  const second = { ...first, id: "second" };
  const firstStep = activity("first-step", { replyParentId: first.id });
  const secondStep = activity("second-step", { replyParentId: second.id });
  const rows = [first, second, firstStep, secondStep];
  const projection = activityPresentation(
    rows,
    {
      status: "listening",
      records: [],
      turns: [],
      typing: [],
      trimmed: 0,
      local: [first, second].map((row) => ({
        scope: "test",
        agent: "agent",
        channelId: "solo",
        threadRootId: row.id,
        messageId: row.id,
        startedAt: 1,
        state: row === first ? ("done" as const) : ("working" as const),
      })),
    },
    new Set(["agent"]),
  );
  expect(projection.groups[0]?.retired).toBe(true);
  expect(projection.groups[1]?.retired).toBe(false);
  expect(projection.byRow.get(secondStep.id)?.active).toBe(true);
});

it.each(["working", "disconnected", "completed", "failed", "trimmed"] as const)(
  "uses remote turn evidence without treating a reply as completion: %s",
  (phase) => {
    const request = publicMessage("a".repeat(64), {
      authorId: "human",
    });
    const step = activity("step", { replyParentId: request.id });
    const reply = publicMessage("reply", {
      replyParentId: request.id,
    });
    const rows = [request, step, reply];
    const kinds = [
      "turn_started",
      ...(phase === "completed" || phase === "trimmed"
        ? ["turn_completed"]
        : phase === "failed"
          ? ["turn_error"]
          : []),
    ];
    const projection = activityPresentation(
      rows,
      {
        status: phase === "disconnected" ? "interrupted" : "listening",
        typing: [],
        trimmed: phase === "trimmed" ? 1 : 0,
        records: kinds.map((kind, seq) => ({
          id: String(seq),
          agent: "agent",
          createdAt: 100,
          receivedAt: 100000,
          kind,
          channelIds: ["solo"],
          plaintext: JSON.stringify({
            kind,
            turnId: "turn",
            channelId: "solo",
            seq,
            timestamp: new Date(100000).toISOString(),
            payload: { triggeringEventIds: [request.id] },
          }),
        })),
        turns: [
          {
            agent: "agent",
            turnId: "turn",
            channelId: "solo",
            timestamp: 100000,
            state:
              phase === "working"
                ? "working"
                : phase === "disconnected"
                  ? "unknown"
                  : "ended",
          },
        ],
      },
      new Set(["agent"]),
    );
    expect(projection.groups[0]?.retired).toBe(phase === "completed");
    expect(projection.groups[0]?.history).toEqual([step]);
    expect(projection.byRow.get(step.id)?.active).toBe(phase === "working");
  },
);

it("waits for both helpers to finish and keeps their history available", () => {
  const first = activity("one", { replyParentId: "request" });
  const second = activity("two", {
    authorId: "helper",
    replyParentId: "request",
  });
  const rows = [first, second];
  const snapshot = {
    status: "listening" as const,
    records: [],
    turns: [],
    typing: [],
    trimmed: 0,
    local: ["agent", "helper"].map((agent) => ({
      scope: "test",
      agent,
      channelId: "solo",
      threadRootId: "request",
      messageId: "request",
      startedAt: 1,
      state: agent === "agent" ? ("done" as const) : ("working" as const),
    })),
  };
  const agents = new Set(["agent", "helper"]);
  const pending = activityPresentation(rows, snapshot, agents);
  expect(pending.groups[0]?.retired).toBe(false);
  expect(pending.byRow.get(second.id)?.active).toBe(true);
  const finished = activityPresentation(
    rows,
    {
      ...snapshot,
      local: snapshot.local.map((entry) => ({ ...entry, state: "done" })),
    },
    agents,
  );
  expect(finished.groups[0]?.retired).toBe(true);
  expect(finished.groups[0]?.history).toEqual(rows);
  expect(finished.byRow.get(first.id)?.active).toBe(false);
});

it.each(["working", "waiting", "error"] as const)(
  "keeps unlinked %s evidence without borrowing completion",
  (state) => {
    const request = publicMessage("request", { authorId: "human" });
    const step = activity("step");
    const reply = publicMessage("reply");
    const followup = publicMessage("followup", { authorId: "human" });
    const rows = [request, step, reply, followup];
    const projection = activityPresentation(
      rows,
      {
        status: "listening",
        records: [],
        turns: [],
        typing: [],
        trimmed: 0,
        local: [
          {
            scope: "test",
            agent: "agent",
            channelId: "solo",
            threadRootId: request.id,
            messageId: request.id,
            startedAt: 1,
            state,
          },
        ],
      },
      new Set(["agent"]),
    );
    expect(projection.groups[0]?.retired).toBe(false);
    expect(projection.byRow.get(step.id)?.active).toBe(state === "working");
    if (state === "working")
      expect(projection.byRow.get(step.id)?.ownsLive).toBe(true);
  },
);
