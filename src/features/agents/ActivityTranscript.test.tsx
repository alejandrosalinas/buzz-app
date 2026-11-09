// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentsContext } from "./react";
import type { Agents } from "./service";
import { ActivityTranscript } from "./ActivityTranscript";
import type { TranscriptTurn } from "./activity-transcript";
import { activityTranscript } from "./activity-transcript";
import { withSessionPrompts } from "./session-prompts";
import { codexTurns } from "../../bundled/codex/transcript";
import { restoreRecordedTools } from "../../bundled/codex/recorded-tools";
import {
  clockPreference,
  setClockPreference,
} from "../../shared/clock-preference";
import { formatTime } from "../../shared/datetime";

afterEach(cleanup);

it.each([
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["terminated", "Failed"],
  ["cancelled", "Stopped"],
  ["future-outcome", "Status unknown"],
])("shows the remote turn outcome %s in the Activity tab", (outcome, label) => {
  const at = new Date("2026-11-04T12:00:00Z");
  const transcript = activityTranscript(
    [
      {
        id: "remote",
        agent: "a".repeat(64),
        receivedAt: at.getTime(),
        plaintext: JSON.stringify({
          kind: "turn_completed",
          turnId: "task",
          timestamp: at.toISOString(),
          payload: { outcome },
        }),
      },
    ],
    { agent: "a".repeat(64) },
  );
  render(
    <ActivityTranscript
      transcript={transcript}
      agentName="Remote helper"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText(label, { exact: true })).toBeVisible();
  if (label === "Failed")
    expect(screen.getByText(label).closest("header")).toHaveAttribute(
      "data-status",
      "failed",
    );
});

it.each([
  ["failed", "Failed"],
  ["terminated", "Terminated"],
])("shows %s script status before opening its output", (status, label) => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [],
      },
    ],
    { channelId: "channel" },
  );
  turns[0]?.items.push({
    id: "script",
    toolCallId: "script",
    at: 1000,
    type: "tool",
    title: "exec",
    kind: "execute",
    status,
    input: "throw new Error('failed')",
    output: `Script ${status}\nOutput:\nError`,
    paths: [],
    diffs: [],
    truncated: false,
  });
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText(label, { exact: true })).toBeVisible();
  expect(
    screen.getByText("exec", { exact: true }).closest("details"),
  ).not.toHaveAttribute("open");
});

it("shows the recorded tool name, highlights tool calls, and keeps script text intact without raw details", async () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [],
      },
    ],
    { channelId: "channel" },
  );
  const script =
    "text(await tools.buzz__channels({all:true}));\ntext(await tools.clock__curr_time({}));";
  restoreRecordedTools(
    turns,
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "script",
          name: "exec",
          input: script,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "script",
          output: [
            {
              type: "input_text",
              text: "Script completed\nOutput:\nchannel list",
            },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  await user.click(screen.getByText("exec", { exact: true }));
  const channels = screen.getByText("tools.buzz__channels", { exact: true });
  expect(channels).toBeVisible();
  expect(channels).toHaveClass("text-accent");
  expect(
    screen.getByText("tools.clock__curr_time", { exact: true }),
  ).toHaveClass("text-accent");
  expect(channels.closest("pre")?.textContent).toBe(script);
  expect(
    screen.getByText(/^Script completed Output: channel list$/),
  ).toBeVisible();
  expect(screen.queryByText("Raw details")).not.toBeInTheDocument();
});

it("shows a failed nested call on the collapsed script while preserving the script's status", () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            type: "commandExecution",
            id: "failed",
            command: "false",
            status: "failed",
            aggregatedOutput: "exit 1",
          },
        ],
      },
    ],
    { channelId: "channel" },
  );
  const turn = turns[0];
  const failed = turn?.items[0];
  if (!turn || failed?.type !== "tool") throw new Error("Missing failed tool");
  turn.items = [
    {
      ...failed,
      id: "script",
      toolCallId: "script",
      title: "exec",
      status: "completed",
      children: [failed],
    },
  ];
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText("· 1 failed call")).toBeVisible();
  const script = screen.getByText("exec", { exact: true }).closest("details");
  expect(script).not.toHaveAttribute("open");
  expect(script).toHaveAttribute("data-status", "completed");
  // The script and its nested call each carry their own time.
  expect(script?.querySelectorAll("time")).toHaveLength(2);
  expect(script?.parentElement?.querySelectorAll("time")).toHaveLength(2);
});

it("discloses tool arguments and results without raw details, including a posted send", async () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            type: "dynamicToolCall",
            id: "read",
            namespace: "buzz",
            tool: "read",
            arguments: { limit: 2 },
            status: "completed",
            contentItems: [{ type: "inputText", text: "two messages" }],
            success: true,
          },
          {
            type: "dynamicToolCall",
            id: "send",
            namespace: "buzz",
            tool: "send",
            arguments: { text: "Done" },
            status: "completed",
            contentItems: [{ type: "inputText", text: "sent" }],
            success: true,
          },
        ],
      },
    ],
    { channelId: "channel" },
  );
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  const tool = screen.getByText("buzz.read").closest("details");
  expect(tool).not.toHaveAttribute("open");
  await user.click(screen.getByText("buzz.read"));
  expect(tool).toHaveAttribute("open");
  expect(screen.getByText('{ "limit": 2 }')).toBeVisible();
  expect(screen.getByText("two messages")).toBeVisible();
  expect(screen.getByText("Done", { selector: "summary span" })).toBeVisible();
  expect(screen.queryByText("Raw details")).not.toBeInTheDocument();
});

it("renders thought formatting and keeps entry times available, except the prompt", () => {
  const at = Date.UTC(2026, 9, 20, 20, 1, 28);
  const { container } = render(
    <ActivityTranscript
      transcript={{
        turns: [
          {
            turnId: "t",
            startedAt: at,
            endedAt: at + 9000,
            threadRootId: null,
            config: [],
            items: [
              { id: "prompt", at, type: "prompt", text: "hi", sections: [] },
              {
                id: "thought",
                at: at + 3000,
                type: "thought",
                text: "**Inspecting the bootstrap script**\n\nChecking **formatting**.",
              },
              { id: "reply", at: at + 70_000, type: "message", text: "done" },
            ],
          } as never,
        ],
      }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText("formatting", { selector: "strong" }).tagName).toBe(
    "STRONG",
  );
  expect(container.querySelectorAll("time")).toHaveLength(3);
  for (const text of ["Inspecting the bootstrap script", "done"]) {
    expect(
      screen
        .getByText(text, { selector: "summary span" })
        .closest("details")
        ?.querySelector("time")
        ?.getAttribute("title"),
    ).toContain("2026");
  }
});

it("updates mounted transcript clocks while keeping elapsed time and navigation", () => {
  const previous = { ...clockPreference() };
  const at = new Date(2026, 9, 20, 14, 1, 28).getTime();
  const openConversation = vi.fn();
  setClockPreference({ hourCycle: "h12", seconds: false });
  try {
    const { container } = render(
      <ActivityTranscript
        transcript={{
          turns: [
            {
              turnId: "clock",
              triggeringEventIds: [],
              newSession: false,
              partial: false,
              startedAt: at,
              endedAt: at + 9000,
              channelId: "channel",
              threadRootId: null,
              config: [],
              items: [
                {
                  id: "thought",
                  at: at + 3000,
                  type: "thought",
                  text: "Checking the clock",
                },
              ],
            },
          ],
        }}
        agentName="Sol"
        state={() => "ended"}
        openConversation={openConversation}
      />,
    );
    const clocks = Array.from(container.querySelectorAll("time"));
    expect(clocks).toHaveLength(2);
    const before = clocks.map((clock) => clock.textContent);
    act(() => setClockPreference({ hourCycle: "h23", seconds: true }));
    expect(clocks.map((clock) => clock.textContent)).toEqual([
      formatTime((at + 9000) / 1000),
      formatTime((at + 3000) / 1000),
    ]);
    expect(clocks.map((clock) => clock.textContent)).not.toEqual(before);
    expect(container.querySelector("header")).toHaveTextContent("9.0s");
    fireEvent.click(screen.getByRole("button", { name: "Channel" }));
    expect(openConversation).toHaveBeenCalledWith("channel", undefined);
  } finally {
    act(() => setClockPreference(previous));
  }
});

it("shows no time for an entry with a zero, non-finite or invalid time", () => {
  const { container } = render(
    <ActivityTranscript
      transcript={{
        turns: [
          {
            turnId: "t",
            startedAt: 0,
            endedAt: 0,
            threadRootId: null,
            config: [],
            items: [
              { id: "zero", at: 0, type: "thought", text: "a" },
              { id: "inf", at: Infinity, type: "thought", text: "b" },
              { id: "nan", at: NaN, type: "message", text: "c" },
              {
                id: "script",
                at: 0,
                type: "tool",
                title: "exec",
                status: "completed",
                paths: [],
                diffs: [],
                children: [
                  { id: "child", at: 1e20, type: "message", text: "d" },
                ],
              },
            ],
          } as never,
        ],
      }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(container.querySelectorAll("time")).toHaveLength(0);
});

it.each([
  ["ended", 2000, undefined, "Completed"],
  ["working", undefined, undefined, "Working"],
  ["ended", 2000, "Command failed", "Failed"],
  ["unknown", undefined, undefined, "Status unknown"],
] as const)(
  "shows only the turn status for %s/%s/%s",
  (state, endedAt, error, label) => {
    const turn = {
      turnId: "status",
      startedAt: 1000,
      endedAt,
      error,
      channelId: "channel",
      threadRootId: "a".repeat(64),
      config: ["gpt-6"],
      source: "heartbeat",
      stopReason: "stop",
      items: [],
    } as unknown as TranscriptTurn;
    const { container } = render(
      <ActivityTranscript
        transcript={{ turns: [turn] }}
        agentName="Agent"
        state={() => state}
      />,
    );
    if (state === "working") {
      expect(container.querySelector("header")).toBeNull();
      expect(screen.getAllByText("Working")).toHaveLength(1);
    } else {
      expect(container.querySelector("header")).toHaveTextContent(label);
      expect(container.querySelector("header time") !== null).toBe(!!endedAt);
    }
  },
);

it("opens at the latest turn and follows new ones until the reader scrolls up", () => {
  const turn = (id: string, at: number): TranscriptTurn => ({
    turnId: id,
    channelId: "channel",
    threadRootId: null,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    startedAt: at,
    endedAt: at + 1000,
    partial: false,
    items: [],
  });
  let height = 1000;
  const scrolling = () => {
    const view = document.createElement("div");
    view.style.overflowY = "auto";
    Object.defineProperty(view, "scrollHeight", { get: () => height });
    Object.defineProperty(view, "clientHeight", { get: () => 200 });
    return document.body.appendChild(view);
  };
  const view = scrolling();
  const show = (turns: TranscriptTurn[], follow?: boolean) => (
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
      {...(follow === undefined ? {} : { follow })}
    />
  );
  const { rerender, unmount } = render(show([turn("a", 1)]), {
    container: view,
  });
  expect(view.scrollTop).toBe(1000);
  height = 1400;
  rerender(show([turn("a", 1), turn("b", 2)]));
  expect(view.scrollTop).toBe(1400);
  view.scrollTop = 100;
  fireEvent.scroll(view);
  height = 1800;
  rerender(show([turn("a", 1), turn("b", 2), turn("c", 3)]));
  expect(view.scrollTop).toBe(100);
  unmount();
  const shared = scrolling();
  render(show([turn("a", 1)], false), { container: shared });
  expect(shared.scrollTop).toBe(0);
  view.remove();
  shared.remove();
});

it("divides sessions, and shows each one's prompt once at its top", () => {
  const turn = (
    turnId: string,
    sessionId: string,
    newSession: boolean,
  ): TranscriptTurn => ({
    turnId,
    channelId: "channel",
    threadRootId: null,
    triggeringEventIds: [],
    sessionId,
    newSession,
    config: [],
    startedAt: 1,
    endedAt: 2,
    partial: false,
    items: [],
  });
  const turns = withSessionPrompts(
    [turn("1", "old", false), turn("2", "new", true), turn("3", "new", false)],
    (session) =>
      session === "new"
        ? [
            {
              label: "",
              text: "<agent-instructions>\nBe kind\n</agent-instructions>",
            },
          ]
        : undefined,
  );
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Agent"
      state={() => "ended"}
    />,
  );
  expect(
    screen
      .getAllByText(/^(New session|Session continued)/)
      .map((line) => line.textContent),
  ).toEqual(["Session continued; earlier turns not shown", "New session"]);
  expect(screen.getAllByText(/System prompt/)).toHaveLength(1);
  expect(screen.getByText("Agent instructions")).toBeInTheDocument();
});

it("keeps the conversation readable while disclosing work and showing the current step", async () => {
  const at = Date.UTC(2026, 10, 2, 17);
  const turn: TranscriptTurn = {
    turnId: "turn",
    channelId: null,
    threadRootId: null,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    startedAt: at,
    partial: false,
    items: [
      {
        id: "prompt",
        at,
        type: "prompt",
        text: "Fix the preview",
        sections: [],
        steer: false,
      },
      { id: "thought", at, type: "thought", text: "Inspecting the renderer" },
      {
        id: "tool",
        at,
        type: "tool",
        toolCallId: "tool",
        title: "Read renderer",
        kind: "read",
        status: "completed",
        input: "renderer.tsx",
        output: "source",
        paths: [],
        diffs: [],
        truncated: false,
      },
      { id: "reply", at, type: "message", text: "Found the layout problem" },
      { id: "latest", at, type: "thought", text: "Applying the fix" },
    ],
  };
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns: [turn] }}
      agentName="Sol"
      state={() => "working"}
    />,
  );
  expect(
    screen.getByText("Fix the preview", { selector: "summary span" }),
  ).toBeVisible();
  expect(
    screen.getByText("Found the layout problem", { selector: "summary span" }),
  ).toBeVisible();
  expect(
    screen
      .getAllByText("Applying the fix")
      .some((element) => !element.closest("[hidden]")),
  ).toBe(true);
  expect(
    screen.getByText("Inspecting the renderer", { selector: "summary span" }),
  ).toBeVisible();
  expect(screen.getByText("renderer")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "2 activity steps" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("source")).not.toBeVisible();
  await user.click(screen.getByText("renderer"));
  expect(screen.getByText("source")).toBeVisible();
  await user.click(screen.getByText("renderer"));
  expect(screen.getByText("source")).not.toBeVisible();
});

it("keeps thought details collapsed until requested and preserves them across updates", async () => {
  const turn: TranscriptTurn = {
    turnId: "thought-turn",
    channelId: null,
    threadRootId: null,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    startedAt: 1,
    partial: false,
    items: [
      {
        id: "thought",
        at: 1,
        type: "thought",
        text: "**Checking the view**\n\nDetails with **formatting**.",
      },
    ],
  };
  const user = userEvent.setup();
  const { rerender } = render(
    <ActivityTranscript
      transcript={{ turns: [turn] }}
      agentName="Agent"
      state={() => "working"}
    />,
  );
  expect(screen.getByText("formatting")).not.toBeVisible();
  const disclosure = screen
    .getByText("Checking the view", { selector: "summary span" })
    .closest("summary");
  if (!disclosure) throw new Error("Missing thought disclosure");
  await user.click(disclosure);
  expect(screen.getByText("formatting")).toBeVisible();
  expect(screen.getAllByText("Checking the view")).toHaveLength(1);
  rerender(
    <ActivityTranscript
      transcript={{ turns: [{ ...turn, endedAt: 2 }] }}
      agentName="Agent"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText("formatting")).toBeVisible();
  await user.click(disclosure);
  expect(screen.getByText("formatting")).not.toBeVisible();
});

it("resolves author avatars by identity and falls back when that identity is absent", () => {
  const key = "a".repeat(64);
  const listeners = new Set<() => void>();
  let profiles = new Map([
    [key, { name: "Alex", picture: "https://example.com/alex.png" }],
  ]);
  const ensure = vi.fn(async () => {});
  const directory = {
    snapshot: () => profiles,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure,
  };
  const connection = { status: "ready", session: { profiles: directory } };
  const relay = { subscribe: () => () => {}, snapshot: () => connection };
  const agents = {
    subscribe: () => () => {},
    relay: () => relay,
  } as unknown as Agents;
  const turn = {
    turnId: "avatar",
    startedAt: 1,
    config: [],
    items: [
      {
        id: "prompt",
        at: 1,
        type: "prompt",
        author: "Alex",
        authorPubkey: key,
        text: "Hello",
        sections: [],
      },
      {
        id: "unknown",
        at: 1,
        type: "prompt",
        author: "Alex",
        text: "Another person",
        sections: [],
      },
    ],
  } as unknown as TranscriptTurn;
  const { container } = render(
    <AgentsContext.Provider value={agents}>
      <ActivityTranscript
        agentKey="agent"
        agentName="Agent"
        transcript={{ turns: [turn] }}
        state={() => "ended"}
      />
    </AgentsContext.Provider>,
  );
  expect(ensure).toHaveBeenCalledWith([key], "background");
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.com/alex.png",
  );
  act(() => {
    profiles = new Map();
    for (const listener of listeners) listener();
  });
  expect(container.querySelector("img")).toBeNull();
});
