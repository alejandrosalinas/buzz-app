// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createAgentActivity } from "../agents/activity";
import type { ChannelMessage } from "../relay/contracts";
import {
  activityPresentation,
  useActivityPresentation,
  useStableRowActivity,
  type ActivityRowPresentation,
} from "./activity-presentation";
import { useActivityIndicator } from "./use-activity-indicator";
import { useLiveConversationAgents } from "./TypingIndicator";
import { agent, entry, fixture, root } from "./typing-indicator-testing";

afterEach(cleanup);

it("keeps row activity props identical while each projection's values are equal", () => {
  const { result } = renderHook(() => useStableRowActivity());
  const row = (active: boolean): ActivityRowPresentation => ({
    requestId: root,
    active,
    ownsLive: true,
    container: "bubble",
  });
  const first = result.current.activity("row", row(false), "history");
  expect(first).toEqual({ ...row(false), container: "history" });
  expect(result.current.activity("row", row(false), "history")).toBe(first);
  const changed = result.current.activity("row", row(true), "history");
  expect(changed).not.toBe(first);
  expect(changed?.active).toBe(true);
  expect(result.current.activity("row", row(true))).toEqual(row(true));
  expect(result.current.activity("row", undefined, "history")).toBeUndefined();

  const agents = result.current.agents("row", [agent]);
  expect(result.current.agents("row", [agent])).toBe(agents);
  expect(result.current.agents("row", [agent, "other"])).not.toBe(agents);
});

it("forgets row activity props for rows that left the timeline", () => {
  const row: ActivityRowPresentation = {
    requestId: root,
    active: false,
    ownsLive: true,
    container: "history",
  };
  const { result, rerender } = renderHook(
    ({ rows }: { rows: readonly { id: string }[] }) =>
      useStableRowActivity(rows),
    { initialProps: { rows: [{ id: "row" }, { id: "kept" }] } },
  );
  const first = result.current.activity("row", row);
  const replied = result.current.agents("replied:row", [agent]);
  const kept = result.current.activity("kept", row);
  // Trimmed from history, then loaded again as an older page.
  rerender({ rows: [{ id: "kept" }] });
  rerender({ rows: [{ id: "row" }, { id: "kept" }] });
  expect(result.current.activity("row", row)).not.toBe(first);
  expect(result.current.agents("replied:row", [agent])).not.toBe(replied);
  expect(result.current.activity("kept", row)).toBe(kept);
});

it("re-renders on typing and activity only for the row that owns the live signal", () => {
  const live = fixture();
  const row = {
    id: "update",
    channelId: "channel",
    threadRootId: root,
    authorId: agent,
  } as ChannelMessage;
  let renders = 0;
  const { rerender } = renderHook(
    ({ eligible }: { eligible: boolean }) => {
      renders++;
      return useActivityIndicator(live.session, row, eligible);
    },
    { initialProps: { eligible: false } },
  );
  const quiet = renders;
  live.update([entry()]);
  live.update([], { trimmed: 1 });
  expect(renders).toBe(quiet);

  rerender({ eligible: true });
  const owner = renders;
  live.update([entry()]);
  expect(renders).toBeGreaterThan(owner);
});

it("re-renders a live-agents host only when its working agents change", () => {
  const live = fixture();
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useLiveConversationAgents(live.session, "channel", root);
  });
  expect(result.current).toEqual([]);
  const idle = renders;
  live.update([{ pubkey: agent, channelId: "elsewhere", threadRootId: root }]);
  live.update([], { trimmed: 1 });
  expect(renders).toBe(idle);
  live.update([entry()]);
  expect(result.current).toEqual([agent]);
});

it("keeps message history stable while an agent starts and stops typing", () => {
  const live = fixture();
  const rows: ChannelMessage[] = [
    {
      id: root,
      channelId: "channel",
      authorId: agent,
      createdAt: 1,
      content: "Update",
      mentions: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      participants: [],
      audience: "agents",
    },
  ];
  const agents = new Set([agent]);
  let renders = 0;
  renderHook(() => {
    renders++;
    return useActivityPresentation(rows, live.session.agentActivity, agents);
  });
  const initial = renders;
  live.update([], {
    local: [],
    turnsTrimmed: false,
    typing: [
      {
        agent,
        channelId: "channel",
        threadRootId: root,
        startedAt: 1,
        working: true,
      },
    ],
  });
  live.update([], { typing: [] });
  expect(renders).toBe(initial);

  live.update([], { trimmed: 1 });
  expect(renders).toBeGreaterThan(initial);
  const afterTrim = renders;
  live.update([], { turnsTrimmed: true });
  expect(renders).toBeGreaterThan(afterTrim);
});

it("only updates mounted activity rows in the channel that received a tool step", () => {
  const live = fixture();
  let generation: number | null = null;
  const activity = createAgentActivity(
    true,
    (value) => {
      generation = value;
    },
    () => true,
  );
  activity.queries.activate();
  activity.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  const session = { ...live.session, agentActivity: activity.queries };
  const mountRow = (channelId: string) => {
    const row = { id: root, authorId: agent, channelId } as ChannelMessage;
    let renders = 0;
    const view = renderHook(() => {
      renders++;
      return useActivityIndicator(session, row, true);
    });
    return { result: view.result, renders: () => renders };
  };
  let seq = 0;
  const receive = (kind: string, channelId: string, payload: unknown = {}) => {
    const now = Date.now();
    if (generation === null) throw new Error("Observer is not active");
    activity.receive(
      {
        id: (++seq).toString(16).padStart(64, "0"),
        agent,
        createdAt: Math.floor(now / 1000),
        plaintext: JSON.stringify({
          kind,
          channelId,
          turnId: channelId,
          seq,
          timestamp: new Date(now).toISOString(),
          payload,
        }),
      },
      generation,
    );
  };
  try {
    receive("turn_started", "channel");
    receive("turn_started", "other");
    live.update([
      { pubkey: agent, channelId: "channel" },
      { pubkey: agent, channelId: "other" },
    ]);
    const here = mountRow("channel");
    const there = mountRow("other");
    expect(here.result.current).toBe(true);
    expect(there.result.current).toBe(true);
    const hereBefore = here.renders();
    const thereBefore = there.renders();
    act(() =>
      receive("acp_read", "channel", {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "read",
            title: "Read",
            kind: "read",
            status: "in_progress",
          },
        },
      }),
    );
    expect(here.renders()).toBeGreaterThan(hereBefore);
    expect(there.renders()).toBe(thereBefore);
  } finally {
    act(() => activity.dispose());
  }
});

it("maps each request to its agents' latest public replies", () => {
  const message = (
    id: string,
    authorId: string,
    extra: Partial<ChannelMessage> = {},
  ) =>
    ({
      id,
      channelId: "channel",
      authorId,
      createdAt: 1,
      content: id,
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
      ...extra,
    }) as ChannelMessage;
  const human = "h".repeat(64);
  const { repliedAgents, replyRequests } = activityPresentation(
    [
      message("request", human),
      message("first", agent),
      message("update", agent, { audience: "agents" }),
      message("latest", agent),
      message("later", human),
    ],
    undefined,
    new Set([agent]),
  );
  expect(repliedAgents.get("request")).toEqual([agent]);
  expect(replyRequests.get("latest")).toBe("request");
  expect(replyRequests.has("first")).toBe(false);
  expect(replyRequests.has("update")).toBe(false);
  expect(repliedAgents.has("later")).toBe(false);
});

it("binds an agent update to the request it claims only when that is a loaded human request in its conversation", () => {
  const human = "h".repeat(64);
  const message = (
    id: string,
    authorId: string,
    extra: Partial<ChannelMessage> = {},
  ) =>
    ({
      id,
      channelId: "channel",
      authorId,
      createdAt: 1,
      content: id,
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
      ...extra,
    }) as ChannelMessage;
  // Normal sends reply to the thread root, whichever request they answer.
  const update = (
    id: string,
    request: string | undefined,
    threadRootId = "root",
    extra: Partial<ChannelMessage> = {},
  ) =>
    message(id, agent, {
      audience: "agents",
      threadRootId,
      replyParentId: threadRootId,
      ...(request ? { request } : {}),
      ...extra,
    });
  const { byRow } = activityPresentation(
    [
      message("root", human),
      update("old", undefined),
      // A skewed or tied clock can sort a claim before the request it names.
      update("skewed", "followUp"),
      message("followUp", human, { threadRootId: "root" }),
      message("elsewhere", human, { threadRootId: "otherRoot" }),
      message("otherChannel", human, {
        channelId: "other",
        threadRootId: "root",
      }),
      message("agentRoot", agent),
      message("agentFollowUp", human, { threadRootId: "agentRoot" }),
      update("exact", "followUp"),
      update("toRoot", "root"),
      update("toThreadElsewhere", "elsewhere"),
      update("toOtherChannel", "otherChannel"),
      update("toAgentUpdate", "old"),
      update("toUnloaded", "f".repeat(64)),
      update("toAgentRoot", "agentRoot", "agentRoot", {
        replyParentId: "agentFollowUp",
      }),
    ],
    undefined,
    new Set([agent]),
    "root",
  );
  const request = (id: string) => byRow.get(id)?.requestId;
  expect(request("exact")).toBe("followUp");
  expect(request("skewed")).toBe("followUp");
  expect(request("toRoot")).toBe("root");
  // Untagged history and unverifiable claims keep their reply link.
  for (const id of [
    "old",
    "toThreadElsewhere",
    "toOtherChannel",
    "toAgentUpdate",
    "toUnloaded",
  ])
    expect(request(id)).toBe("root");
  expect(request("toAgentRoot")).toBe("agentFollowUp");

  // A displayed level may claim a request loaded at another level, still
  // within the same conversation.
  const nested = message("nested", human, {
    threadRootId: "root",
    replyParentId: "old",
  });
  const level = [
    update("flattened", "nested"),
    update("toElsewhere", "elsewhere"),
    update("toOtherAgent", "otherAgent"),
  ];
  const levelRequest = (loaded?: ChannelMessage[]) => {
    const { byRow } = activityPresentation(
      level,
      undefined,
      new Set([agent]),
      "root",
      undefined,
      loaded,
    );
    return (id: string) => byRow.get(id)?.requestId;
  };
  const loaded = [
    message("root", human),
    update("old", undefined),
    nested,
    message("elsewhere", human, { threadRootId: "otherRoot" }),
    // An unknown agent's message at another level is not a human request.
    message("otherAgent", "o".repeat(64), {
      threadRootId: "root",
      replyParentId: "old",
      agentEnvelope: true,
    }),
    ...level,
  ];
  expect(levelRequest(loaded)("flattened")).toBe("nested");
  expect(levelRequest(loaded)("toElsewhere")).toBe("root");
  expect(levelRequest(loaded)("toOtherAgent")).toBe("root");
  expect(levelRequest()("flattened")).toBe("root");

  // Top-level conversations claim top-level requests, not thread replies.
  const flat = (id: string, request: string) =>
    message(id, agent, { audience: "agents", request });
  const { byRow: flatRows } = activityPresentation(
    [
      message("first", human),
      message("reply", human, { threadRootId: "first" }),
      message("second", human),
      flat("answersFirst", "first"),
      flat("toThreadReply", "reply"),
    ],
    undefined,
    new Set([agent]),
  );
  expect(flatRows.get("answersFirst")?.requestId).toBe("first");
  expect(flatRows.get("toThreadReply")?.requestId).toBe("second");
});
