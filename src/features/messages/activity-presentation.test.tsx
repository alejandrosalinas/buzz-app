// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import {
  activityPresentation,
  useChannelActivitySnapshot,
  useStableRowActivity,
  type ActivityRowPresentation,
} from "./activity-presentation";
import { useActivityIndicator } from "./use-activity-indicator";
import { useLiveConversationAgents } from "./TypingIndicator";
import {
  agent,
  entry,
  fixture,
  root,
  type Snapshot,
} from "./typing-indicator-testing";

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

it("keeps a conversation's activity snapshot through other channels' work", () => {
  const live = fixture();
  const record = (id: string, channelId: string) =>
    Object.freeze({
      id,
      channelIds: Object.freeze([channelId]),
    }) as unknown as Snapshot["records"][number];
  const turn = (channelId: string, timestamp: number) =>
    ({ agent, turnId: "t", channelId, timestamp, state: "working" }) as const;
  const elsewhere = record("elsewhere", "other");
  const here = record("here", "channel");
  const channels = new Set(["channel"]);
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useChannelActivitySnapshot(live.session.agentActivity, channels);
  });
  const initial = result.current;
  const idle = renders;
  live.update([], { records: [elsewhere] });
  live.update([], { records: [elsewhere], turns: [turn("other", 1)] });
  live.update([], { records: [elsewhere], turns: [turn("other", 2)] });
  expect(renders).toBe(idle);
  expect(result.current).toBe(initial);
  live.update([], { records: [elsewhere, here] });
  expect(result.current?.records).toEqual([elsewhere, here]);
  const withRecord = result.current;
  live.update([], { records: [elsewhere, here], turns: [turn("channel", 3)] });
  expect(result.current).not.toBe(withRecord);
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
