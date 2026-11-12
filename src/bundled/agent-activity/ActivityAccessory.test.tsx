import { ActivityGroupPreview } from "../../features/messages/ActivityGroupPreview";
// @vitest-environment jsdom
import {
  activityPresentation,
  useActivityPresentation,
  type ActivityPresentation,
  type ActivityRowPresentation,
} from "../../features/messages/activity-presentation";
import { MessageRow } from "../../features/messages/MessageRow";
import { createRelaySession } from "../../features/relay/session";
import { createLocalAgentActivity } from "../../features/agents/local-activity";
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import { Profiler } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ActivityAccessory,
  ActivityTypingReplacement,
} from "./ActivityAccessory";
import {
  ActivityIndicatorPresentation,
  TypingPresentation,
} from "../../features/conversation/typing-presentation";
import { TypingIndicator } from "../../features/messages/TypingIndicator";
import {
  claimProfileTranscript,
  profileTranscriptRequest,
} from "../../features/profiles/target";
import { createAgentActivity } from "../../features/agents/activity";
import { requestWork } from "../../features/agents/request-work";
import { createAgentLibrary } from "../../features/agents/library";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";

// Stop's results are host toasts; the shared Toast owns how they show.
const notify = vi.hoisted(() => vi.fn());
vi.mock("../../shared/design-system/ui/Toast", async (original) => ({
  ...(await original<typeof import("../../shared/design-system/ui/Toast")>()),
  useToastNotification: () => notify,
}));

afterEach(() => {
  cleanup();
  notify.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Transcript requests live in a module-level map; each test starts clean.
  for (const agent of [A, B])
    claimProfileTranscript(`buzz:profile?agent=${agent}&tab=activity`);
});
const A = "b".repeat(64),
  B = "c".repeat(64),
  viewer = "a".repeat(64),
  root = "1".repeat(64),
  next = "2".repeat(64);
function fixture(local?: ReturnType<typeof createLocalAgentActivity>) {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  let generation = 0,
    serial = 0;
  const activity = createAgentActivity(
    true,
    (g) => {
      generation = g ?? 0;
    },
    () => true,
    undefined,
    undefined,
    local ? { source: local.reader, scope: "test" } : undefined,
  );
  const release = activity.queries.activate();
  const live = {
    status: "connected" as const,
    routes: [
      { id: "observer", status: "live" as const, replay: "unknown" as const },
    ],
  };
  activity.state(live);
  const profiles = new Map([
    [A, { name: "Blossom", isAgent: true as const }],
    [B, { name: "Bubbles", isAgent: true as const }],
  ]);
  const session = {
    viewer,
    presence: {
      subscribe: () => () => {},
      status: () => "online",
      limited: () => false,
    },
    agentActivity: activity.queries,
    agentChoices: createAgentLibrary(undefined).queries,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    live: { retry: () => activity.state(live) },
    media: () => undefined,
  } as unknown as RelaySession;
  const send = (
    agent: string,
    turnId: string,
    seq: number,
    kind: string,
    payload: unknown = {},
  ) =>
    act(() => {
      activity.receive(
        {
          id: (++serial).toString(16).padStart(64, "0"),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind,
            turnId,
            channelId: "c",
            sessionId: "S",
            seq,
            timestamp: new Date().toISOString(),
            payload,
          }),
        },
        generation,
      );
    });
  const open = vi.fn(() => true);
  const props = {
    session,
    scope: "test",
    channelId: "c",
    threadRootId: root,
    message: {
      id: root,
      channelId: "c",
      authorId: viewer,
      createdAt: 1,
      content: "Request",
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    },
    canOpen: () => true,
    open,
  };
  return {
    activity,
    release,
    send,
    props,
    live,
    profiles,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}

it("shows one bubble with one avatar per agent across multiple turns, removing only the settled agent", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a1", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "a2", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b1", 1, "turn_started", { triggeringEventIds: [root] });
    expect(
      screen.getAllByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history)/,
      }),
    ).toHaveLength(1);
    expect(screen.getAllByTitle("Blossom")).toHaveLength(1);
    expect(screen.getAllByTitle("Bubbles")).toHaveLength(1);
    expect(view.container.querySelector(".buzz-avatar-status-dot")).toBeNull();
    f.send(A, "a1", 2, "turn_completed");
    expect(
      screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history): Blossom/,
      }),
    ).toBeInTheDocument();
    f.send(A, "a2", 2, "turn_completed");
    expect(
      screen.queryByRole("button", { name: /Blossom/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history): Bubbles/,
      }),
    ).toBeInTheDocument();
    f.send(B, "b1", 2, "turn_completed");
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("keeps uncertain work internally without showing a passive error, then resumes on fresh evidence", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "other", 1, "turn_started", { triggeringEventIds: [next] });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    f.send(B, "here", 1, "turn_started", { triggeringEventIds: [root] });
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
    expect(
      requestWork(f.props.session.agentActivity.snapshot(), "c", root)[0]
        ?.state,
    ).toBe("unknown");
    f.send(B, "here", 2, "turn_liveness");
    expect(
      screen.getByLabelText("Agent activity on this message"),
    ).toBeInTheDocument();
    f.send(B, "here", 3, "turn_completed");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("keeps a stopped agent visible beside another agent's persistent failure", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "failed", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "stopped", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "failed", 2, "turn_completed", { outcome: "failed" });
    f.send(B, "stopped", 2, "turn_completed", { outcome: "cancelled" });
    expect(screen.getByText("Couldn’t finish")).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history): Blossom, failed/,
      }),
    );
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(
      screen.getByText(/This request ended before it could finish/),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it.each([
  ["failed", "Couldn’t finish"],
  ["terminated", "Couldn’t finish"],
  ["cancelled", "Stopped"],
])(
  "shows remote %s after stale activity and raw-buffer eviction",
  (outcome, label) => {
    const f = fixture();
    const view = render(<ActivityAccessory {...f.props} />);
    try {
      f.send(A, "remote", 1, "turn_started", { triggeringEventIds: [root] });
      act(() => vi.advanceTimersByTime(31000));
      expect(
        screen.queryByLabelText("Agent activity on this message"),
      ).toBeNull();
      f.send(A, "remote", 2, "turn_completed", { outcome });
      expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
      for (let seq = 1; seq <= 201; seq++)
        f.send(B, "unrelated", seq, "acp_read");
      act(() => vi.advanceTimersByTime(300000));
      expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
      expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
      if (outcome !== "cancelled") {
        fireEvent.click(
          screen.getByRole("button", {
            name: /(?:View agent activity|Show activity history|Collapse activity history): Blossom, failed/,
          }),
        );
        expect(
          screen.getByText(/This request ended before it could finish/),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "View activity for Blossom" }),
        ).toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: /Dismiss error/ }),
        ).not.toBeInTheDocument();
      }
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it.each(["payload", "prompt"])(
  "keeps %s thread scope through partial and full raw-record eviction",
  (scope) => {
    const f = fixture();
    const view = render(<ActivityAccessory {...f.props} />);
    try {
      f.send(A, "thread", 1, "turn_started", {
        triggeringEventIds: [root],
        ...(scope === "payload" ? { threadRootEventId: root } : {}),
      });
      f.send(A, "thread", 2, "acp_write", {
        method: "session/prompt",
        params: {
          prompt: [
            {
              type: "text",
              text: `<context>\nScope: thread\nThread root: ${root}\n</context>`,
            },
          ],
        },
      });
      expect(
        screen.queryByRole("button", {
          name: /(?:View agent activity|Show activity history|Collapse activity history)/,
        }),
      ).not.toBeInTheDocument();
      for (let seq = 1; seq <= 150; seq++)
        f.send(B, "unrelated", seq, "acp_read");
      f.send(A, "thread", 3, "acp_read");
      for (let seq = 151; seq <= 201; seq++)
        f.send(B, "unrelated", seq, "acp_read");
      expect(
        screen.queryByRole("button", {
          name: /(?:View agent activity|Show activity history|Collapse activity history)/,
        }),
      ).not.toBeInTheDocument();
      for (let seq = 202; seq <= 402; seq++)
        f.send(B, "unrelated", seq, "acp_read");
      expect(
        screen.queryByRole("button", {
          name: /(?:View agent activity|Show activity history|Collapse activity history)/,
        }),
      ).not.toBeInTheDocument();
      view.rerender(<ActivityAccessory {...f.props} messageLayout="thread" />);
      expect(
        screen.getByRole("button", {
          name: /(?:View agent activity|Show activity history|Collapse activity history): Blossom/,
        }),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it("keeps namesakes as separate exact identities", () => {
  const f = fixture();
  f.profiles.set(B, { name: "Blossom", isAgent: true as const });
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b", 1, "turn_started", { triggeringEventIds: [root] });
    const avatars = screen.getAllByTitle(/Blossom/);
    expect(avatars).toHaveLength(2);
    expect(avatars[0]?.getAttribute("title")).not.toBe(
      avatars[1]?.getAttribute("title"),
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("previews only live scoped actions for multiple agents and retains profile navigation", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "old", 1, "turn_started", { triggeringEventIds: [root] });
    const thought = (text: string) => ({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        },
      },
    });
    f.send(A, "old", 2, "acp_read", thought("Old thought"));
    f.send(A, "old", 3, "turn_completed");
    f.send(A, "new", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "companion", 1, "turn_started", { triggeringEventIds: [root] });
    fireEvent.click(
      screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history)/,
      }),
    );
    expect(
      within(
        screen.getByRole("button", { name: "View activity for Blossom" }),
      ).getByText("Waiting for activity details"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Old thought")).not.toBeInTheDocument();
    f.send(A, "new", 2, "acp_read", thought("Current thought"));
    expect(screen.getByText("Current thought")).toBeInTheDocument();
    f.send(B, "sibling", 1, "turn_started", { triggeringEventIds: [next] });
    f.send(B, "sibling", 2, "acp_read", thought("Private sibling thought"));
    expect(
      screen.queryByText("Private sibling thought"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    );
    const activity = `buzz:profile?agent=${A}&tab=activity`;
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(activity);
    // It asks that Activity for this message's transcript, once.
    expect(claimProfileTranscript(activity)).toBeDefined();
    f.send(B, "companion", 2, "turn_completed");
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
    f.send(A, "new", 3, "turn_completed", { outcome: "failed" });
    fireEvent.click(
      screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history)/,
      }),
    );
    expect(
      screen.getByText(/This request ended before it could finish/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Current thought")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("removes the whole popup when access is revoked", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b", 1, "turn_started", { triggeringEventIds: [root] });
    fireEvent.click(
      screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history)/,
      }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(<ActivityAccessory {...f.props} canOpen={() => false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("makes the compact avatar and tool preview one action, retaining the popup when opening fails", () => {
  const f = fixture();
  const activity = `buzz:profile?agent=${A}&tab=activity`;
  let asked: number | undefined;
  // Opening fails, after seeing whether a transcript was asked for.
  f.props.open.mockImplementation(() => {
    asked = profileTranscriptRequest(activity);
    return false;
  });
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "a", 2, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read",
          title: "buzz-dev-mcp__read_file",
          status: "in_progress",
          rawInput: { path: "/project/file.ts" },
        },
      },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history)/,
      }),
    );
    const popup = within(
      screen.getByRole("dialog", { name: "Agent activity" }),
    );
    // Each agent has one navigation action; no separate Activity heading.
    expect(popup.getAllByRole("button")).toHaveLength(2);
    for (const text of [
      "Agent activity",
      "Latest reported activity for this message.",
      "Blossom",
      "View activity",
      "Close",
    ])
      expect(popup.queryByText(text, { exact: true })).not.toBeInTheDocument();
    const row = popup.getByRole("button", {
      name: "View activity for Blossom",
    });
    expect(row).toHaveTextContent("Read file · Running");
    expect(row.querySelector(".buzz-avatar")).not.toBeNull();
    fireEvent.click(row);
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(activity);
    expect(asked).toBeDefined();
    // The failed opening leaves no request behind for a later Activity.
    expect(claimProfileTranscript(activity)).toBeUndefined();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(
      <ActivityAccessory
        {...f.props}
        canOpen={(target) => !target.startsWith("buzz:profile?")}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "View activity for Blossom" }),
    ).not.toBeInTheDocument();
    expect(f.props.open).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps conversation dots visible alongside message-linked activity", () => {
  const f = fixture();
  const typing = [{ pubkey: A, channelId: "c", threadRootId: root }];
  const session = {
    ...f.props.session,
    typing: { snapshot: () => typing, subscribe: () => () => {} },
  } as unknown as RelaySession;
  const props = { ...f.props, session };
  const ui = (replacement: boolean) => (
    <TypingPresentation active>
      {/* MessageRow gives each row its own presentation scope. */}
      <TypingPresentation active>
        <ActivityAccessory {...props} />
      </TypingPresentation>
      {replacement && <ActivityTypingReplacement {...props} />}
      <TypingIndicator session={session} channelId="c" threadRootId={root} />
    </TypingPresentation>
  );
  const view = render(ui(true));
  try {
    f.send(A, "unlinked", 1, "turn_liveness");
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
    f.send(A, "sibling", 1, "turn_started", { triggeringEventIds: [next] });
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
    f.send(A, "here", 1, "turn_started", { triggeringEventIds: [root] });
    expect(
      screen.getByRole("button", {
        name: "View agent activity: Blossom, working",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
    view.rerender(ui(false));
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows local receipt and failure without requiring an ACP transcript, and opens the agent profile", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    let work!: ReturnType<typeof local.begin>;
    act(() => {
      work = local.begin({
        scope: "test",
        channelId: "c",
        threadRootId: root,
        messageId: root,
        agent: A,
      });
    });
    const bubble = screen.getByRole("button", {
      name: "View agent activity: Blossom, Received · waiting to start",
    });
    expect(bubble.querySelector('[data-state="waiting"]')).not.toBeNull();
    act(() => work.started());
    expect(bubble).toHaveAccessibleName(
      "View agent activity: Blossom, Starting",
    );
    expect(bubble.querySelector('[data-state="waiting"]')).not.toBeNull();
    act(() => work.step("send_message"));
    expect(bubble).not.toHaveTextContent("Sending a message");
    expect(bubble.querySelector('[data-state="working"]')).not.toBeNull();
    act(() => work.step("Read", "notes.txt"));
    expect(bubble).toHaveAccessibleName(
      "View agent activity: Blossom, Reading notes.txt",
    );
    expect(bubble).toHaveTextContent("Reading notes.txt");
    expect(bubble.querySelector('[data-state="working"]')).not.toBeNull();
    act(() => work.finish({ ok: false, error: "Provider unavailable" }));
    expect(screen.getByText("Couldn’t finish")).toBeInTheDocument();
    const details = screen.getByRole("button", {
      name: /(?:View agent activity|Show activity history|Collapse activity history): Blossom/,
    });
    expect(details.querySelector("[data-state]")).toBeNull();
    fireEvent.click(details);
    expect(screen.getByText("Provider unavailable")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    );
    const activity = `buzz:profile?agent=${A}&tab=activity`;
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(activity);
    expect(claimProfileTranscript(activity)).toBeDefined();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("dismisses only that agent's error on this message, without changing other work", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const onFocusedRemoval = vi.fn();
  const view = render(
    <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />,
  );
  const begin = (agent: string, messageId: string) =>
    local.begin({
      scope: "test",
      channelId: "c",
      threadRootId: root,
      messageId,
      agent,
    });
  try {
    act(() => {
      begin(A, root).finish({
        ok: false,
        error: "Provider unavailable after a long and detailed reason",
      });
      begin(A, next).finish({ ok: false, error: "Elsewhere" });
      begin(B, root).step("Read", "notes.txt");
    });
    const mixed = screen.getByRole("button", {
      name: /(?:View agent activity|Show activity history|Collapse activity history)/,
    });
    expect(mixed).toHaveTextContent("Couldn’t finish");
    const failedBadge = mixed.querySelector("[data-activity-failure]");
    const workingBadge = mixed.querySelector("[data-thread-working]");
    expect(
      screen.getByRole("img", { name: "Blossom, Bubbles" }),
    ).toBeInTheDocument();
    expect(failedBadge?.parentElement).toBe(workingBadge?.parentElement);
    expect(workingBadge).toHaveTextContent("Reading notes.txt");
    fireEvent.click(
      screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history)/,
      }),
    );
    expect(
      screen.getByText("Provider unavailable after a long and detailed reason")
        .parentElement,
    ).toHaveAttribute("data-error");
    expect(
      screen.queryByRole("button", { name: "Dismiss error from Bubbles" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss error from Blossom" }),
    );
    expect(f.props.open).not.toHaveBeenCalled();
    expect(onFocusedRemoval).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /View agent activity: Bubbles/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View activity for Blossom" }),
    ).toBeNull();
    expect(
      local.reader
        .work()
        .filter((row) => row.agent === A)
        .map((row) => [row.messageId, row.state, row.dismissed]),
    ).toEqual([
      // The outcome remains as settled evidence; only its display is hidden.
      [root, "error", true],
      [next, "error", undefined],
    ]);
  } finally {
    view.unmount();
    f.dispose();
  }
});

it.each([false, true])(
  "returns focus after retiring the last error unless focus moved: %s",
  async (moved) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const onFocusedRemoval = vi.fn();
    const view = render(
      <>
        <button type="button">Other task</button>
        <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />
      </>,
    );
    try {
      act(() => {
        local
          .begin({
            scope: "test",
            channelId: "c",
            threadRootId: root,
            messageId: root,
            agent: A,
          })
          .finish({ ok: false, error: "Provider unavailable" });
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: /(?:View agent activity|Show activity history|Collapse activity history)/,
        }),
      );
      const dismiss = screen.getByRole("button", {
        name: "Dismiss error from Blossom",
      });
      act(() => dismiss.focus());
      fireEvent.click(dismiss);
      // The owned clock holds the handoff microtask after React removes the
      // popup, so a deliberate focus move wins before that handoff runs.
      expect(onFocusedRemoval).not.toHaveBeenCalled();
      if (moved)
        act(() => screen.getByRole("button", { name: "Other task" }).focus());
      await act(async () => vi.runAllTicks());
      expect(onFocusedRemoval).toHaveBeenCalledTimes(moved ? 0 : 1);
      expect(screen.queryByText("Provider unavailable")).toBeNull();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it.each([false, true])(
  "keeps live activity after a public reply without hiding other work (thread=%s)",
  async (thread) => {
    const f = fixture();
    const onFocusedRemoval = vi.fn();
    const view = render(
      <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />,
    );
    try {
      expect(
        screen.queryByLabelText("Agent activity on this message"),
      ).toBeNull();
      f.send(A, "here", 1, "turn_started", { triggeringEventIds: [root] });
      f.send(B, "other", 1, "turn_started", { triggeringEventIds: [root] });
      const response = {
        ...f.props.message,
        id: "response",
        authorId: A,
        agentEnvelope: true as const,
        content: "Here is the answer",
        replyParentId: root,
      };
      const rows = [
        f.props.message,
        { ...f.props.message, id: next },
        response,
      ];
      const represented = activityPresentation(
        thread ? rows.slice(1) : rows,
        undefined,
        new Set([A, B]),
        thread ? root : undefined,
      ).representedAgents;
      view.rerender(
        <ActivityAccessory
          {...f.props}
          onFocusedRemoval={onFocusedRemoval}
          representedAgents={represented.get(root)}
        />,
      );
      expect(screen.getByTitle("Blossom")).toBeInTheDocument();
      expect(screen.getByTitle("Bubbles")).toBeInTheDocument();
      expect(represented.get(next)).toBeUndefined();
      act(() =>
        screen
          .getByRole("button", {
            name: /(?:View agent activity|Show activity history|Collapse activity history)/,
          })
          .focus(),
      );
      f.send(B, "other", 2, "turn_completed");
      expect(screen.getByTitle("Blossom")).toBeInTheDocument();
      f.send(A, "here", 2, "turn_completed");
      await act(async () => vi.runAllTicks());
      expect(onFocusedRemoval).toHaveBeenCalledOnce();
      expect(
        screen.queryByLabelText("Agent activity on this message"),
      ).toBeNull();
      view.rerender(
        <ActivityAccessory
          {...f.props}
          onFocusedRemoval={onFocusedRemoval}
          representedAgents={represented.get(root)}
        />,
      );
      expect(screen.queryByTitle("Blossom")).toBeNull();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

const settle = () => act(async () => {});
const openBubble = () =>
  fireEvent.click(
    screen.getByRole("button", {
      name: /(?:View agent activity|Show activity history|Collapse activity history)/,
    }),
  );
const stopButton = () => screen.queryByRole("button", { name: "Stop Blossom" });
// Reopen the popup, if anything closed it, to read the agent's row.
const look = () => {
  const activity = screen.queryByRole("button", {
    name: /(?:View agent activity|Show activity history|Collapse activity history)/,
  });
  if (activity && !screen.queryByRole("dialog")) fireEvent.click(activity);
  return screen;
};
const stopPending = () =>
  expect(stopButton()).toHaveAttribute("aria-disabled", "true");
const stopReady = () =>
  expect(stopButton()).not.toHaveAttribute("aria-disabled");
function hosted(running: boolean | Promise<boolean> = true) {
  return {
    interruptible: vi.fn(() => true),
    interrupt: vi.fn(async () => running),
  };
}

it.each(["waiting", "working"])(
  "stops a local request that is %s through its harness, then notes it stopped",
  async (state) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const queries = f.props.session.agentActivity;
    const interrupt = vi.fn(queries.interrupt);
    const session = {
      ...f.props.session,
      agentActivity: { ...queries, interrupt },
    };
    const stop = vi.fn(async () => {});
    const view = render(<ActivityAccessory {...f.props} session={session} />);
    try {
      act(() => {
        const work = local.begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        });
        work.interruptible(stop);
        if (state === "working") work.started();
      });
      openBubble();
      fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(A, "c", root);
      await settle();
      expect(stop).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "Stopped Blossom",
        "success",
      );
      expect(
        screen.queryByRole("button", { name: "Stop Blossom" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: /activity history: Blossom, Stopped/,
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("Stopped")).toBeInTheDocument();
      // Handling the same message again replaces the note with its live work.
      act(() => {
        local
          .begin({
            scope: "test",
            channelId: "c",
            threadRootId: root,
            messageId: root,
            agent: A,
          })
          .started();
      });
      expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: /(?:View agent activity|Show activity history|Collapse activity history): Blossom/,
        }),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it.each([
  [undefined, "timeline"],
  ["thread", "thread"],
] as const)(
  "notes a stopped request in the response lane (layout %s)",
  async (messageLayout, layout) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const view = render(
      <ActivityAccessory {...f.props} messageLayout={messageLayout} />,
    );
    try {
      act(() => {
        local
          .begin({
            scope: "test",
            channelId: "c",
            threadRootId: root,
            messageId: root,
            agent: A,
          })
          .interruptible(async () => {});
      });
      expect(
        screen.getByRole("button", {
          name: /(?:View agent activity|Show activity history|Collapse activity history): Blossom/,
        }),
      ).toBeInTheDocument();
      // Stop retains its exact request and response-side notice.
      await act(() => f.props.session.agentActivity.interrupt(A, "c", root));
      expect(
        screen.queryByRole("button", { name: /View thread/ }),
      ).not.toBeInTheDocument();
      // The note keeps the incoming message column instead of the list's edge.
      expect(
        screen.getByText("Stopped").closest("[data-layout]"),
      ).toHaveAttribute("data-layout", layout);
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it("moves a stopped note below the agent's latest public reply", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const reply = {
    ...f.props.message,
    id: next,
    authorId: A,
    createdAt: 2,
    content: "On it",
  };
  const view = render(
    <>
      <div data-testid="request">
        <ActivityAccessory {...f.props} repliedAgents={[A]} />
      </div>
      <div data-testid="reply">
        <ActivityAccessory
          {...f.props}
          message={reply}
          stoppedRequest={f.props.message}
        />
      </div>
    </>,
  );
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .interruptible(async () => {});
    });
    // Live work stays on its request; a reply does not take the bubble.
    expect(
      within(screen.getByTestId("request")).getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history): Blossom/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("reply")).toBeEmptyDOMElement();
    await act(() => f.props.session.agentActivity.interrupt(A, "c", root));
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
    expect(
      within(screen.getByTestId("reply")).getByText("Stopped"),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it.each(["failed", "terminated", "unknown"])(
  "places a confirmed remote %s outcome beneath its reply, including after uncertainty",
  (outcome) => {
    const f = fixture();
    const reply = {
      ...f.props.message,
      id: next,
      authorId: A,
      createdAt: 2,
      content: "An agent reply",
    };
    const view = render(
      <>
        <div data-testid="request">
          <ActivityAccessory
            {...f.props}
            messageLayout="thread"
            repliedAgents={[A]}
          />
        </div>
        <div data-testid="reply">
          <ActivityAccessory
            {...f.props}
            message={reply}
            messageLayout="thread"
            stoppedRequest={f.props.message}
          />
        </div>
      </>,
    );
    try {
      f.send(A, "remote", 1, "turn_started", { triggeringEventIds: [root] });
      expect(
        within(screen.getByTestId("request")).getByRole("button", {
          name: /(?:View agent activity|Show activity history|Collapse activity history)/,
        }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("reply")).toBeEmptyDOMElement();
      if (outcome === "unknown") {
        act(() => vi.advanceTimersByTime(31000));
        expect(screen.getByTestId("request")).toBeEmptyDOMElement();
        expect(screen.getByTestId("reply")).toBeEmptyDOMElement();
        expect(
          requestWork(f.props.session.agentActivity.snapshot(), "c", root)[0]
            ?.state,
        ).toBe("unknown");
        f.send(A, "remote", 2, "turn_completed", { outcome: "failed" });
      } else f.send(A, "remote", 2, "turn_completed", { outcome });
      expect(screen.getByTestId("request")).toBeEmptyDOMElement();
      const caption = within(screen.getByTestId("reply"));
      expect(caption.getByText("Couldn’t finish")).toBeInTheDocument();
      expect(caption.getByText("Blossom")).toBeInTheDocument();
      expect(
        screen.getByTestId("reply").querySelector("[data-avatar-stack]"),
      ).toBeNull();
      fireEvent.click(
        caption.getByRole("button", {
          name: /(?:View agent activity|Show activity history|Collapse activity history)/,
        }),
      );
      expect(screen.getByTestId("reply")).toHaveTextContent(
        "This request ended before it could finish",
      );
      expect(f.props.open).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it("does not duplicate a replied thread failure on its channel request", () => {
  const f = fixture();
  const view = render(
    <>
      <div data-testid="request">
        <ActivityAccessory
          {...f.props}
          message={{ ...f.props.message, replyCount: 1 }}
          messageLayout="timeline"
          repliedAgents={[A]}
          representedAgents={[A]}
        />
      </div>
      <div data-testid="sibling">
        <ActivityAccessory
          {...f.props}
          message={{ ...f.props.message, id: next }}
          messageLayout="timeline"
        />
      </div>
    </>,
  );
  try {
    f.send(A, "thread", 1, "turn_started", {
      triggeringEventIds: [root],
      threadRootEventId: root,
    });
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
    f.send(A, "thread", 2, "turn_completed", { outcome: "terminated" });
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
    expect(screen.getByTestId("sibling")).toBeEmptyDOMElement();
    expect(f.props.open).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it.each(["thread", "continuation"] as const)(
  "keeps a thread request's stopped note on a %s reply",
  async (layout) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const reply = {
      ...f.props.message,
      id: next,
      authorId: A,
      threadRootId: root,
      replyParentId: root,
      createdAt: 2,
      content: "On it",
    };
    const view = render(
      <>
        <div data-testid="request">
          <ActivityAccessory
            {...f.props}
            messageLayout="thread"
            repliedAgents={[A]}
          />
        </div>
        <div data-testid="reply">
          <ActivityAccessory
            {...f.props}
            message={reply}
            messageLayout={layout}
            stoppedRequest={f.props.message}
          />
        </div>
      </>,
    );
    try {
      act(() => {
        local
          .begin({
            scope: "test",
            agent: A,
            channelId: "c",
            messageId: root,
            threadRootId: root,
            thread: true,
          })
          .interruptible(async () => {});
      });
      await act(() => f.props.session.agentActivity.interrupt(A, "c", root));
      expect(screen.getByTestId("request")).toBeEmptyDOMElement();
      expect(
        within(screen.getByTestId("reply")).getByText("Stopped"),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it("notes only stopped requests once their work settles", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .finish({ ok: true });
    });
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps focus on the outcome summary when a focused Stop retires", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const onFocusedRemoval = vi.fn();
  const view = render(
    <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />,
  );
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .interruptible(async () => {});
    });
    openBubble();
    await act(async () => vi.advanceTimersToNextFrame());
    const stop = stopButton() as HTMLElement;
    act(() => stop.focus());
    fireEvent.click(stop);
    await settle();
    expect(stop.isConnected).toBe(false);
    await act(async () => vi.runAllTicks());
    expect(onFocusedRemoval).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: /activity history: Blossom, Stopped/,
      }),
    ).toHaveFocus();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows a local request as stopping until its harness has stopped it", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  let release = () => {};
  const stop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .interruptible(stop);
    });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
    fireEvent.click(stopButton() as HTMLElement);
    expect(stop).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    release();
    await settle();
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Stopped Blossom",
      "success",
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers no Stop for a local request that cannot be stopped or has failed", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  const begin = (agent: string) =>
    local.begin({
      scope: "test",
      channelId: "c",
      threadRootId: root,
      messageId: root,
      agent,
    });
  try {
    act(() => {
      begin(A).started();
      const failed = begin(B);
      failed.interruptible(async () => {});
      failed.finish({ ok: false, error: "Provider unavailable" });
    });
    openBubble();
    expect(stopButton()).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop Bubbles" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss error from Bubbles" }),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("retries a failed local request from its row, before Dismiss, which begins it again", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  const retry = vi.fn(() => void begin());
  function begin() {
    return local.begin(
      {
        scope: "test",
        channelId: "c",
        threadRootId: root,
        messageId: root,
        agent: A,
      },
      retry,
    );
  }
  try {
    act(() => begin().finish({ ok: false, error: "Provider unavailable" }));
    openBubble();
    const again = screen.getByRole("button", { name: "Retry Blossom" });
    expect(again).toHaveTextContent("Retry");
    expect(
      again.compareDocumentPosition(
        screen.getByRole("button", { name: "Dismiss error from Blossom" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(again);
    expect(retry).toHaveBeenCalledOnce();
    expect(f.props.open).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "View agent activity: Blossom, Received · waiting to start",
      }),
    ).toBeInTheDocument();
    look();
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(
      `buzz:profile?agent=${A}&tab=activity`,
    );
    expect(
      screen.queryByRole("button", { name: "Retry Blossom" }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("says why a failed request could not be retried, keeping it to try again or dismiss", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  const retry = vi.fn(() => {
    throw new Error("Blossom isn't running here.");
  });
  const begin = (agent: string, again?: () => void) =>
    local.begin(
      {
        scope: "test",
        channelId: "c",
        threadRootId: root,
        messageId: root,
        agent,
      },
      again,
    );
  try {
    act(() => {
      begin(A, retry).finish({ ok: false, error: "Provider unavailable" });
      begin(B).finish({ ok: false, error: "Busy" });
    });
    openBubble();
    // Only a request that can be asked again offers Retry.
    expect(
      screen.queryByRole("button", { name: "Retry Bubbles" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss error from Bubbles" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry Blossom" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Couldn’t retry Blossom. Blossom isn't running here.",
      "error",
    );
    expect(screen.getByText("Provider unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry Blossom" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss error from Blossom" }),
    );
    expect(screen.queryByText("Provider unavailable")).toBeNull();
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("stops a hosted agent's turn through its provider in this thread", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(agents.interruptible).toHaveBeenCalledWith(A);
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(agents.interrupt).toHaveBeenCalledExactlyOnceWith(A, {
      channelId: "c",
      threadRootId: root,
    });
    // Its turn ends when the provider reports it, so it shows as stopping.
    await settle();
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Stopping Blossom",
      "success",
    );
    f.send(A, "t", 2, "turn_completed");
    expect(
      screen.queryByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history)/,
      }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("stops a hosted agent in the thread its message replies to", () => {
  const f = fixture();
  const agents = hosted();
  const reply = { ...f.props.message, id: next, threadRootId: root };
  const view = render(
    <ActivityAccessory {...f.props} message={reply} agents={agents} />,
  );
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [next] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(agents.interrupt).toHaveBeenCalledExactlyOnceWith(A, {
      channelId: "c",
      threadRootId: root,
    });
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("opens a single agent directly and stops it without opening activity", async () => {
  const f = fixture();
  const agents = hosted();
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    const bubble = screen.getByRole("button", { name: /View agent activity:/ });
    expect(bubble).not.toHaveAttribute("aria-haspopup");
    expect(bubble).not.toHaveAttribute("aria-expanded");
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(f.props.open).not.toHaveBeenCalled();
    expect(agents.interrupt).toHaveBeenCalledExactlyOnceWith(A, {
      channelId: "c",
      threadRootId: root,
    });
    await settle();
    expect(bubble).toHaveTextContent("Stopping…");
    expect(bubble).toHaveAccessibleName(/Blossom, Stopping/);
    fireEvent.click(bubble);
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(
      `buzz:profile?agent=${A}&tab=activity`,
    );
    expect(
      claimProfileTranscript(`buzz:profile?agent=${A}&tab=activity`),
    ).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps the focused bubble and pending stop when agents join and leave", async () => {
  const f = fixture();
  const agents = hosted();
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    const bubble = screen.getByRole("button", { name: /View agent activity:/ });
    act(() => screen.getByRole("button", { name: "Stop Blossom" }).focus());
    f.send(B, "u", 1, "turn_started", { triggeringEventIds: [root] });
    expect(bubble).toHaveFocus();
    openBubble();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    stopPending();
    act(() => screen.getByRole("button", { name: "Stop Blossom" }).focus());
    f.send(B, "u", 2, "turn_completed");
    expect(bubble).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
    stopPending();
    expect(bubble).toHaveTextContent("Stopping…");
    expect(bubble).toHaveAccessibleName(/Blossom, Stopping/);
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("does not take focus from elsewhere when agents join and leave", () => {
  const f = fixture();
  const view = render(
    <>
      <button type="button">Elsewhere</button>
      <ActivityAccessory {...f.props} agents={hosted()} />
    </>,
  );
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => elsewhere.focus());
    f.send(B, "u", 1, "turn_started", { triggeringEventIds: [root] });
    expect(elsewhere).toHaveFocus();
    f.send(B, "u", 2, "turn_completed");
    expect(elsewhere).toHaveFocus();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers each agent its own Stop in the activity popup", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "u", 1, "turn_started", { triggeringEventIds: [root] });
    expect(stopButton()).not.toBeInTheDocument();
    openBubble();
    const popup = within(screen.getByRole("dialog"));
    expect(
      popup.getByRole("button", { name: "Stop Blossom" }),
    ).toHaveTextContent("Stop");
    fireEvent.click(popup.getByRole("button", { name: "Stop Bubbles" }));
    expect(agents.interrupt).toHaveBeenCalledExactlyOnceWith(B, {
      channelId: "c",
      threadRootId: root,
    });
    await settle();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Stopping Bubbles",
      "success",
    );
    expect(popup.getByRole("button", { name: "Stop Bubbles" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    stopReady();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("returns a hosted agent to its activity when its provider had nothing running to stop", async () => {
  const f = fixture();
  const view = render(
    <ActivityAccessory {...f.props} agents={hosted(false)} />,
  );
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /View agent activity: Blossom/ }),
    ).toHaveAttribute("data-activity-summary");
    stopReady();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Blossom had nothing running to stop",
      "info",
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("says why a hosted agent could not be stopped and lets the owner try again", async () => {
  const f = fixture();
  const agents = hosted();
  agents.interrupt.mockRejectedValueOnce(new Error("Provider is busy."));
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    await settle();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Couldn’t stop Blossom. Provider is busy.",
      "error",
    );
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    stopReady();
    fireEvent.click(stopButton() as HTMLElement);
    expect(agents.interrupt).toHaveBeenCalledTimes(2);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("forgets a stop once its agent's work here has ended", async () => {
  const f = fixture();
  const agents = hosted();
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    f.send(A, "t", 2, "turn_completed");
    f.send(A, "u", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    stopReady();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers no Stop for a hosted agent that is not interruptible, or whose activity is out of date", () => {
  const f = fixture();
  const agents = hosted();
  agents.interruptible.mockReturnValue(false);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(stopButton()).not.toBeInTheDocument();
    // Interruptible, but no longer known to be working.
    agents.interruptible.mockReturnValue(true);
    view.rerender(<ActivityAccessory {...f.props} agents={agents} />);
    expect(stopButton()).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
    expect(stopButton()).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers no Stop for a hosted agent when the host supplies no agents", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(stopButton()).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows no activity, and so no Stop, without a message", () => {
  const f = fixture();
  const agents = hosted();
  const { message: _message, ...props } = f.props;
  const view = render(<ActivityAccessory {...props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(agents.interruptible).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    f.dispose();
  }
});

const NOT_STOPPED = "Blossom hasn’t stopped yet. Try again.";
const notStopped = () =>
  notify.mock.calls.filter(([title]) => title === NOT_STOPPED).length;
const elapse = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const alive = (f: ReturnType<typeof fixture>, turn: string, seq: number) =>
  f.send(A, turn, seq, "acp_read", {});

it("lets the owner try Stop again when a hosted turn is still working 30 seconds after it was stopped", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
    elapse(15_000);
    alive(f, "t", 2);
    elapse(14_999);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    expect(notStopped()).toBe(0);
    alive(f, "t", 3);
    elapse(1);
    expect(notify).toHaveBeenLastCalledWith(NOT_STOPPED, "error");
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    stopReady();
    fireEvent.click(stopButton() as HTMLElement);
    await settle();
    expect(agents.interrupt).toHaveBeenCalledTimes(2);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("does not let an older stop's timeout overwrite a newer stop of the same agent", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    // The turn ends and the agent starts another before the first timeout.
    elapse(10_000);
    f.send(A, "t", 2, "turn_completed");
    f.send(A, "u", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    fireEvent.click(stopButton() as HTMLElement);
    await settle();
    expect(agents.interrupt).toHaveBeenCalledTimes(2);
    // The first attempt's timeout (30s after it) passes; the second's has not.
    elapse(15_000);
    alive(f, "u", 2);
    elapse(5_000);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    expect(notStopped()).toBe(0);
    stopPending();
    alive(f, "u", 3);
    elapse(10_000);
    expect(notStopped()).toBe(1);
    stopReady();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows nothing later when a stopped hosted turn ends before its 30 seconds", async () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} agents={hosted(true)} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    elapse(10_000);
    f.send(A, "t", 2, "turn_completed");
    elapse(60_000);
    expect(notStopped()).toBe(0);
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "shows one step label through handoff (stoppable=%s, thinking=%s)",
  async (stoppable, thinking) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const typing = [{ pubkey: A, channelId: "c", threadRootId: root }];
    const session = {
      ...f.props.session,
      typing: { snapshot: () => typing, subscribe: () => () => {} },
    } as unknown as RelaySession;
    const props = { ...f.props, session };
    const ui = (representedAgents: string[]) => (
      <ActivityIndicatorPresentation>
        <ActivityAccessory {...props} representedAgents={representedAgents} />
        <TypingPresentation active>
          <ActivityTypingReplacement {...props} />
        </TypingPresentation>
        <TypingIndicator session={session} channelId="c" threadRootId={root} />
      </ActivityIndicatorPresentation>
    );
    const work = local.begin({
      scope: "test",
      agent: A,
      channelId: "c",
      messageId: root,
      threadRootId: root,
    });
    const label = thinking ? "Thinking" : "Reading notes.txt";
    work.step(
      thinking ? "Thinking" : "Read",
      thinking ? undefined : "notes.txt",
    );
    const stop = vi.fn(async () => {});
    if (stoppable) work.interruptible(stop);
    const view = render(ui([]));
    try {
      expect(
        screen.getByRole("button", {
          name: `View agent activity: Blossom, ${label}`,
        }),
      ).toBeVisible();
      // The message bubble is the agent's one working indicator here.
      expect(
        screen.queryByRole("button", { name: /Activity: .*working/ }),
      ).toBeNull();
      expect(screen.getAllByText(label)).toHaveLength(1);
      view.rerender(ui([A]));
      expect(
        screen.getByRole("button", {
          name: `View agent activity: Blossom, ${label}`,
        }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /Activity: .*working/ }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Reading notes.txt" }),
      ).toBeNull();
      openBubble();
      if (stoppable) {
        fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
        await settle();
        expect(stop).toHaveBeenCalledOnce();
        return;
      }
      expect(stopButton()).toBeNull();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it("does not re-render the typing replacement for liveness that leaves its agents unchanged", () => {
  const f = fixture();
  const onRender = vi.fn();
  const view = render(
    <Profiler id="replacement" onRender={onRender}>
      <ActivityTypingReplacement {...f.props} />
    </Profiler>,
  );
  try {
    f.send(A, "here", 1, "turn_started", { triggeringEventIds: [root] });
    const renders = onRender.mock.calls.length;
    f.send(A, "here", 2, "turn_liveness");
    f.send(A, "here", 3, "turn_liveness");
    expect(onRender).toHaveBeenCalledTimes(renders);
    f.send(B, "there", 1, "turn_started", { triggeringEventIds: [root] });
    expect(onRender.mock.calls.length).toBeGreaterThan(renders);
  } finally {
    view.unmount();
    f.dispose();
  }
});

it.each([false, true])(
  "keeps thread request activity in its thread (local=%s)",
  (isLocal) => {
    const local = createLocalAgentActivity();
    const f = fixture(isLocal ? local : undefined);
    if (isLocal)
      local.begin({
        scope: "test",
        agent: A,
        channelId: "c",
        messageId: root,
        threadRootId: root,
        thread: true,
      });
    else
      f.send(A, "turn", 1, "turn_started", {
        triggeringEventIds: [root],
        threadRootEventId: root,
      });
    const view = render(
      <ActivityAccessory {...f.props} messageLayout="timeline" />,
    );
    try {
      expect(
        screen.queryByLabelText("Agent activity on this message"),
      ).toBeNull();
      view.rerender(<ActivityAccessory {...f.props} messageLayout="thread" />);
      expect(
        screen.getByLabelText("Agent activity on this message"),
      ).toBeVisible();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it("lets a thread root's live bubble replace that thread's indicator", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const typing = [{ pubkey: A, channelId: "c", threadRootId: root }];
  const session = {
    ...f.props.session,
    typing: { snapshot: () => typing, subscribe: () => () => {} },
  } as unknown as RelaySession;
  // MessageRow passes the row's own thread root: none for a thread's root row.
  const props = { ...f.props, session, threadRootId: undefined };
  local.begin({
    scope: "test",
    agent: A,
    channelId: "c",
    messageId: root,
    threadRootId: root,
    thread: true,
  });
  const ui = (layout: "thread" | "timeline") => (
    <ActivityIndicatorPresentation>
      <ActivityAccessory {...props} messageLayout={layout} />
      <TypingIndicator
        session={session}
        channelId="c"
        threadRootId={root}
        inFlow
      />
    </ActivityIndicatorPresentation>
  );
  const view = render(ui("thread"));
  try {
    expect(
      screen.getByLabelText("Agent activity on this message"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Activity: .*working/ }),
    ).toBeNull();
    // In the channel timeline the root shows no thread bubble, so the thread
    // keeps its own indicator.
    view.rerender(ui("timeline"));
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Activity: .*working/ }),
    ).toBeVisible();
  } finally {
    view.unmount();
    f.dispose();
  }
});

/** What a thread mounts for agent work, sharing one session. */
function threadParts(f: ReturnType<typeof fixture>) {
  const owner = createRelaySession(null);
  const session = { ...owner.session, ...f.props.session };
  const row = (
    entry: ChannelMessage,
    activity: ActivityRowPresentation | undefined,
  ) => (
    <MessageRow
      key={entry.id}
      row={entry}
      session={session}
      profile={f.profiles.get(A)}
      media={() => undefined}
      onOpenLink={f.props.open}
      day={false}
      retry={undefined}
      recordedActivity={activity}
    />
  );
  return {
    session,
    // An agent's update and the viewer's follow-up, each replying to the root.
    update: {
      ...f.props.message,
      authorId: A,
      threadRootId: root,
      replyParentId: root,
      audience: "agents" as const,
    },
    followUp: {
      ...f.props.message,
      id: next,
      threadRootId: root,
      replyParentId: root,
      content: "Follow-up",
    },
    row,
    accessory: (message = f.props.message) => (
      <ActivityAccessory
        {...f.props}
        session={session}
        message={message}
        messageLayout="thread"
      />
    ),
    // Given its rows' presentations, a group also renders its history rows.
    group: (
      group: ActivityPresentation,
      expanded: boolean,
      byRow?: ReadonlyMap<string, ActivityRowPresentation>,
    ) => (
      <ActivityGroupPreview
        key={group.ids[0]}
        session={session}
        group={group}
        profiles={f.profiles}
        media={() => undefined}
        expanded={expanded}
        onToggle={() => {}}
        openActivity={f.props.open}
        canOpenActivity={f.props.canOpen}
        {...(byRow && {
          renderHistory: (entry: ChannelMessage) => {
            const activity = byRow.get(entry.id);
            if (!activity) throw new Error("Missing recorded activity");
            return row(entry, { ...activity, container: "history" });
          },
        })}
      />
    ),
    tail: (
      <TypingIndicator
        session={session}
        channelId="c"
        threadRootId={root}
        inFlow
      />
    ),
    dispose: () => {
      owner.dispose();
      f.dispose();
    },
  };
}
const workingDots = () => [
  ...document.querySelectorAll('[data-state="working"]'),
];
const dotsOn = (id: string) =>
  workingDots().filter(
    (dot) =>
      dot.closest("[data-message-id]")?.getAttribute("data-message-id") === id,
  );
const workingCue = () =>
  screen.queryByRole("button", { name: /Activity: .*working/ });

it("shows thinking and its dots once, moving from the live bubble into recorded history", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const t = threadParts(f);
  const work = local.begin({
    scope: "test",
    agent: A,
    channelId: "c",
    messageId: root,
    threadRootId: root,
    thread: true,
  });
  work.step("Thinking");
  const row = { ...t.update, id: "thinking-step", content: "Thinking" };
  // A failure the run reported before it was retried, absorbed into history.
  const { audience: _audience, ...reply } = row;
  const failure = {
    ...reply,
    id: "failure",
    notice: "execution-failure" as const,
    content: "Provider unavailable",
  };
  const rows = [row];
  const failed = [row, failure];
  const empty: typeof rows = [];
  const agents = new Set([A]);
  function Flow({
    recorded,
    expanded,
    retried,
  }: {
    recorded: boolean;
    expanded: boolean;
    retried: boolean;
  }) {
    const presentation = useActivityPresentation(
      recorded ? (retried ? failed : rows) : empty,
      t.session.agentActivity,
      agents,
      root,
    );
    const group = presentation.groups[0];
    return (
      <>
        {t.accessory()}
        {group && t.group(group, expanded, presentation.byRow)}
        {t.tail}
      </>
    );
  }
  const ui = (recorded: boolean, expanded = false, retried = false) => (
    <ActivityIndicatorPresentation>
      <Flow recorded={recorded} expanded={expanded} retried={retried} />
    </ActivityIndicatorPresentation>
  );
  const view = render(ui(false));
  try {
    expect(screen.getAllByText("Thinking")).toHaveLength(1);
    // Until history owns the work, the message bubble is its one indicator.
    expect(workingCue()).toBeNull();
    // History then owns the work: one working row, its dots included.
    view.rerender(ui(true));
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
    expect(screen.getAllByText("Thinking")).toHaveLength(1);
    expect(workingCue()).toBeNull();
    expect(workingDots()).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /Show activity history/ }),
    ).toContainElement(workingDots()[0] as HTMLElement);
    view.rerender(ui(true, true));
    expect(screen.getAllByText("Thinking")).toHaveLength(1);
    expect(workingCue()).toBeNull();
    const step = () =>
      screen.getByRole("button", { name: /Blossom: Thinking/ });
    expect(workingDots()).toHaveLength(1);
    expect(step()).toContainElement(workingDots()[0] as HTMLElement);
    // Opening the working step keeps its one set of dots on the step.
    for (const state of ["open", "closed"]) {
      fireEvent.click(step());
      expect(step()).toHaveAttribute("aria-expanded", `${state === "open"}`);
      expect(workingCue()).toBeNull();
      expect(workingDots()).toHaveLength(1);
      expect(step()).toContainElement(workingDots()[0] as HTMLElement);
    }
    // Expanded, a failure row carries no dots, so the conversation keeps
    // the one cue; collapsed, the summary's dots are that cue again.
    view.rerender(ui(true, true, true));
    expect(workingDots()).toHaveLength(1);
    expect(workingCue()).toContainElement(workingDots()[0] as HTMLElement);
    view.rerender(ui(true, false, true));
    expect(workingCue()).toBeNull();
    expect(workingDots()).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /Show activity history/ }),
    ).toContainElement(workingDots()[0] as HTMLElement);
    view.rerender(ui(true, true));
    act(() => work.finish({ ok: true }));
    expect(screen.getByText("Thinking")).not.toHaveAttribute("data-active");
    expect(workingCue()).toBeNull();
    expect(workingDots()).toHaveLength(0);
  } finally {
    view.unmount();
    t.dispose();
  }
});

it("hands live work to only the latest history for each agent and keeps Stop and transcript there", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const stop = vi.fn(async () => {});
  const work = local.begin({
    scope: "test",
    agent: A,
    channelId: "c",
    messageId: root,
    threadRootId: root,
    thread: true,
  });
  work.interruptible(stop);
  work.step("Read", "files");
  const row = {
    ...f.props.message,
    id: "step",
    authorId: A,
    threadRootId: root,
    replyParentId: root,
    audience: "agents" as const,
    content: "Checking the files",
  };
  const { audience: _audience, ...reply } = row;
  const groups = activityPresentation(
    [
      row,
      { ...reply, id: "reply" },
      { ...row, id: "later", content: "Checking more files" },
    ],
    f.props.session.agentActivity.snapshot(),
    new Set([A]),
    root,
  ).groups;
  const ui = (expanded: boolean) => (
    <ActivityIndicatorPresentation>
      <ActivityAccessory {...f.props} messageLayout="thread" />
      {groups.map((group) => (
        <ActivityGroupPreview
          key={group.ids[0]}
          session={f.props.session}
          group={group}
          profiles={f.profiles}
          media={() => undefined}
          expanded={expanded}
          onToggle={() => {}}
          openActivity={f.props.open}
          canOpenActivity={f.props.canOpen}
        />
      ))}
    </ActivityIndicatorPresentation>
  );
  const view = render(ui(false));
  try {
    expect(screen.getByText("Checking the files")).not.toHaveAttribute(
      "data-active",
    );
    expect(screen.getByText("Checking more files")).toHaveAttribute(
      "data-active",
      "true",
    );
    view.rerender(ui(true));
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Stop Blossom" }),
    ).toHaveLength(1);
    const transcript = screen.getAllByRole("button", {
      name: "View transcript",
    })[1];
    if (!transcript)
      throw new Error("Missing latest history transcript control");
    fireEvent.click(transcript);
    const activity = `buzz:profile?agent=${A}&tab=activity`;
    expect(f.props.open).toHaveBeenCalledWith(activity, { rootId: root });
    expect(claimProfileTranscript(activity)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("hands a follow-up's live work to the update its run published to the thread root, never to older root updates", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const t = threadParts(f);
  const first = local.begin({
    scope: "test",
    agent: A,
    channelId: "c",
    messageId: root,
    threadRootId: root,
    thread: true,
  });
  first.reply("old");
  act(() => first.finish({ ok: false, error: "Root failed" }));
  const work = local.begin({
    scope: "test",
    agent: A,
    channelId: "c",
    messageId: next,
    threadRootId: root,
    thread: true,
  });
  work.interruptible(vi.fn(async () => {}));
  work.step("Search", "edit history");
  // Normal sends flatten every thread reply to the root; only the publishing
  // run knows which request each update belongs to.
  work.reply("step");
  const presentation = activityPresentation(
    [
      { ...t.update, id: "old", content: "Checking the root" },
      t.followUp,
      { ...t.update, id: "stray", content: "Unattributed root update" },
      { ...t.update, id: "step", content: "Checking the follow-up" },
    ],
    f.props.session.agentActivity.snapshot(),
    new Set([A]),
    root,
  );
  expect(presentation.byRow.get("old")?.requestId).toBe(root);
  expect(presentation.byRow.get("stray")).toMatchObject({
    requestId: root,
    active: false,
  });
  expect(presentation.byRow.get("step")).toMatchObject({
    requestId: next,
    active: true,
  });
  const ui = (expanded: boolean) => (
    <ActivityIndicatorPresentation>
      {t.accessory(t.followUp)}
      {presentation.groups.map((group) => t.group(group, expanded))}
    </ActivityIndicatorPresentation>
  );
  const view = render(ui(false));
  try {
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
    expect(screen.getByText("Checking the follow-up")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByText("Checking the root")).not.toHaveAttribute(
      "data-active",
    );
    view.rerender(ui(true));
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Stop Blossom" }),
    ).toHaveLength(1);
    // The root's failure stays with the root's latest history.
    expect(screen.getAllByText("Root failed")).toHaveLength(1);
  } finally {
    view.unmount();
    t.dispose();
  }
});

it("hands a remote follow-up's live work to the update that claims it, leaving older root updates as history", () => {
  const f = fixture();
  const t = threadParts(f);
  f.send(A, "t0", 1, "turn_started", { triggeringEventIds: [root] });
  f.send(A, "t0", 2, "turn_completed");
  f.send(A, "t1", 1, "turn_started", {
    triggeringEventIds: [next],
    threadRootEventId: root,
  });
  const rows = [
    f.props.message,
    { ...t.update, id: "old", content: "Checking the root" },
    t.followUp,
    {
      ...t.update,
      id: "step",
      request: next,
      content: "Checking the follow-up",
    },
  ];
  const agents = new Set([A]);
  function Thread() {
    const presentation = useActivityPresentation(
      rows,
      f.props.session.agentActivity,
      agents,
      root,
    );
    return (
      <ActivityIndicatorPresentation>
        {t.accessory(t.followUp)}
        {presentation.groups.map((group) => t.group(group, false))}
        {t.tail}
      </ActivityIndicatorPresentation>
    );
  }
  const view = render(<Thread />);
  try {
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
    expect(screen.getByText("Checking the follow-up")).toHaveAttribute(
      "data-active",
      "true",
    );
    // One working presentation: the history row, its dots included.
    expect(workingCue()).toBeNull();
    expect(workingDots()).toHaveLength(1);
    expect(screen.getByText("Checking the root")).not.toHaveAttribute(
      "data-active",
    );
    f.send(A, "t1", 2, "turn_completed");
    expect(screen.getByText("Checking the follow-up")).not.toHaveAttribute(
      "data-active",
    );
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).toBeNull();
  } finally {
    view.unmount();
    t.dispose();
  }
});

it("keeps a failed request's update from borrowing a nested follow-up's remote work", () => {
  const f = fixture();
  const t = threadParts(f);
  f.send(A, "t0", 1, "turn_started", { triggeringEventIds: [root] });
  f.send(A, "t0", 2, "turn_error");
  f.send(A, "t1", 1, "turn_started", {
    triggeringEventIds: [next],
    threadRootEventId: root,
  });
  const old = { ...t.update, id: "old", content: "Earlier root progress" };
  // The follow-up and its signed update both reply under the older update,
  // which is then the thread's only top-level reply.
  const followUp = { ...t.followUp, replyParentId: old.id };
  const step = {
    ...t.update,
    id: "step",
    replyParentId: old.id,
    request: next,
    content: "Checking current follow-up",
  };
  const agents = new Set([A]);
  let outcomes: string[] = [];
  // As in a thread, each reply level is projected on its own.
  function Thread({ branch }: { branch: boolean }) {
    const top = useActivityPresentation(
      [old],
      f.props.session.agentActivity,
      agents,
      root,
    );
    const nested = useActivityPresentation(
      [followUp, step],
      f.props.session.agentActivity,
      agents,
      old.id,
    );
    outcomes = top.groups.flatMap((group) =>
      group.outcomes.map((entry) => entry.state),
    );
    const current = nested.groups.find((group) => group.ids.includes(step.id));
    if (!current) throw new Error("Missing follow-up activity");
    return (
      <ActivityIndicatorPresentation>
        {/* The root's live bubble shows only the failed request's outcome. */}
        {t.accessory()}
        {t.row(old, top.byRow.get(old.id))}
        {branch && t.group(current, true, nested.byRow)}
        {t.tail}
      </ActivityIndicatorPresentation>
    );
  }
  const check = (branch: boolean, working = true) => {
    expect(
      screen.getByLabelText("Agent activity on this message"),
    ).toBeInTheDocument();
    expect(screen.getByText("Earlier root progress")).not.toHaveAttribute(
      "data-active",
    );
    expect(dotsOn(old.id)).toHaveLength(0);
    // The failed request keeps its own outcome.
    expect(outcomes).toEqual(["error"]);
    // Exactly one working cue: the follow-up's update, or the tail when hidden.
    if (!working) {
      expect(workingCue()).toBeNull();
      expect(workingDots()).toHaveLength(0);
    } else if (branch) {
      expect(workingCue()).toBeNull();
      expect(workingDots()).toHaveLength(1);
      expect(dotsOn(step.id)).toHaveLength(1);
    } else {
      expect(workingDots()).toHaveLength(1);
      expect(workingCue()).toContainElement(workingDots()[0] as HTMLElement);
    }
  };
  let view = render(<Thread branch />);
  try {
    check(true);
    view.rerender(<Thread branch={false} />);
    check(false);
    // Closing and reopening the conversation keeps that one cue.
    view.unmount();
    view = render(<Thread branch={false} />);
    check(false);
    view.rerender(<Thread branch />);
    check(true);
    f.send(A, "t1", 2, "turn_completed");
    check(true, false);
  } finally {
    view.unmount();
    t.dispose();
  }
});

// A row with replies shows in a thread as a standalone row, not a group.
it.each(["grouped", "standalone"])(
  "keeps a failed follow-up's update, replying to the root, from borrowing the root request's remote work: %s",
  (layout) => {
    const f = fixture();
    const t = threadParts(f);
    f.send(A, "t0", 1, "turn_started", {
      triggeringEventIds: [root],
      threadRootEventId: root,
    });
    f.send(A, "t1", 1, "turn_started", {
      triggeringEventIds: [next],
      threadRootEventId: root,
    });
    f.send(A, "t1", 2, "turn_error");
    const old = { ...t.update, id: "old", content: "Checking the root" };
    // Signed for the follow-up, though its reply is flattened to the root.
    const step = {
      ...t.update,
      id: "step",
      request: next,
      content: "Checking the follow-up",
    };
    const rows = [old, t.followUp, step];
    const agents = new Set([A]);
    function Thread() {
      const presentation = useActivityPresentation(
        rows,
        f.props.session.agentActivity,
        agents,
        root,
      );
      return (
        <ActivityIndicatorPresentation>
          {layout === "standalone" &&
            [old, step].map((entry) =>
              t.row(entry, presentation.byRow.get(entry.id)),
            )}
          {layout === "grouped" &&
            presentation.groups.map((group) =>
              t.group(group, true, presentation.byRow),
            )}
          {t.tail}
        </ActivityIndicatorPresentation>
      );
    }
    const view = render(<Thread />);
    try {
      expect(screen.getByText("Checking the follow-up")).not.toHaveAttribute(
        "data-active",
      );
      expect(dotsOn(step.id)).toHaveLength(0);
      // The root request's own update is its one working cue.
      expect(screen.getByText("Checking the root")).toHaveAttribute(
        "data-active",
        "true",
      );
      expect(dotsOn(old.id)).toHaveLength(1);
      // The follow-up below that update keeps the conversation's cue too.
      expect(workingCue()).toBeVisible();
      f.send(A, "t0", 2, "turn_completed");
      expect(screen.getByText("Checking the follow-up")).not.toHaveAttribute(
        "data-active",
      );
      expect(workingDots()).toHaveLength(0);
    } finally {
      view.unmount();
      t.dispose();
    }
  },
);

it.each([
  {
    runtime: "block.builderlab/builderlab",
    fallback: "Running remotely on Builderlab…",
  },
  { runtime: "other/provider", fallback: "Running on a remote machine…" },
])(
  "keeps one byline hint and a remote fallback until current steps arrive: $runtime",
  async ({ runtime, fallback }) => {
    const f = fixture();
    const base = f.props.session.agentChoices;
    const choices = {
      ...base.snapshot(),
      identities: [
        {
          pubkey: B,
          name: "Bubbles",
          managed: false,
          execution: "remote",
          runtime,
        },
      ],
    };
    Object.assign(f.props.session, {
      agentChoices: { ...base, snapshot: () => choices },
    });
    const update = (seq: number, update: unknown) => {
      // The latest step wins, so each one arrives later than the last.
      vi.setSystemTime(Date.now() + 1000);
      f.send(B, "b1", seq, "acp_read", {
        method: "session/update",
        params: { update },
      });
    };
    const hint = () => {
      const bubble = screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history): Bubbles, remote, /,
      });
      const preview = bubble.closest("[data-agent-response-preview]");
      if (!(preview instanceof HTMLElement)) throw new Error("Missing preview");
      const labels = within(preview).getAllByText("Remote");
      expect(labels).toHaveLength(1);
      expect(labels[0]?.closest("strong")).toBeNull();
      expect(labels[0]?.closest("button")).toBeNull();
      expect(within(bubble).queryByText("Remote")).toBeNull();
      return labels[0];
    };
    render(<ActivityAccessory {...f.props} />);
    try {
      f.send(B, "b1", 1, "turn_started", { triggeringEventIds: [root] });
      expect(hint()).toBeVisible();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: /(?:View agent activity|Show activity history|Collapse activity history): Bubbles, remote, /,
          }),
        );
        vi.advanceTimersToNextFrame();
      });
      expect(screen.getByText(fallback)).toBeVisible();
      update(2, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "On it" },
      });
      expect(hint()).toBeVisible();
      expect(screen.queryByText(fallback)).toBeNull();
      update(3, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Checking the row" },
      });
      expect(hint()).toBeVisible();
      update(4, {
        sessionUpdate: "tool_call",
        toolCallId: "read",
        title: "buzz-dev-mcp__read_file",
        status: "in_progress",
        rawInput: { path: "/project/file.ts" },
      });
      expect(hint()).toBeVisible();
      f.send(B, "b1", 5, "turn_completed");
      // A local agent's tool call never shows it.
      f.send(A, "a1", 1, "turn_started", { triggeringEventIds: [root] });
      f.send(A, "a1", 2, "acp_read", {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "read",
            title: "buzz-dev-mcp__read_file",
            status: "in_progress",
            rawInput: { path: "/project/file.ts" },
          },
        },
      });
      const local = screen.getByRole("button", {
        name: /(?:View agent activity|Show activity history|Collapse activity history): Blossom/,
      });
      expect(local).not.toHaveAccessibleName(/remote/);
      expect(within(local).queryByText("Remote")).not.toBeInTheDocument();
    } finally {
      f.dispose();
    }
  },
);
