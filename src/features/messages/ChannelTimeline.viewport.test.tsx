import { cloneElement, type ReactNode } from "react";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import { ChannelTimeline } from "./ChannelTimeline";
import styles from "./Messages.module.css";
import { createRelaySession } from "../relay/session";
import { writeView } from "../../shared/view-state";
import { foldMessages } from "../relay/fold";
import { keypair, message } from "../relay/testing";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";
import {
  ActivityIndicatorPresentation,
  TypingPresentation,
  useActivityTypingReplacement,
  useTypingReplacement,
} from "../conversation/typing-presentation";
import type { RelaySession } from "../relay/session";

function RecordedTyping({ session }: { session: RelaySession }) {
  useTypingReplacement(
    { session, channelId: "alpha", threadRootId: undefined, pubkey: "agent" },
    true,
  );
  return null;
}
/** A message's live bubble registers presence in the conversation's store. */
function LiveBubble({ session }: { session: RelaySession }) {
  useActivityTypingReplacement(
    {
      session,
      channelId: "alpha",
      threadRootId: undefined,
      pubkey: "agent",
      presence: true,
    },
    true,
  );
  return null;
}

const viewport = vi.hoisted(() => ({
  size: 0,
  start: 0,
  caches: [] as unknown[],
  scrollToIndex: vi.fn(),
}));
// Control the independent virtualizer's public measurement/shift contract.
// React itself owns the real timeline's refs, render and effect ordering.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      {
        children,
        shift,
        cache,
      }: {
        children: import("react").ReactNode;
        shift: boolean;
        cache?: unknown;
      },
      ref,
    ) {
      viewport.caches.push(cache);
      useImperativeHandle(
        ref,
        () => ({
          get viewportSize() {
            return viewport.size;
          },
          cache: [[], 40],
          findItemIndex: () => viewport.start,
          getItemOffset: () => 0,
          scrollTo: vi.fn(),
          scrollToIndex: viewport.scrollToIndex,
        }),
        [],
      );
      return (
        <ol aria-label="Virtualized messages" data-shift={shift}>
          {children}
        </ol>
      );
    }),
  };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({
    row,
    stackPrevious,
    stackNext,
    keepMounted,
    repliedAgents,
    stoppedRequest,
  }: {
    row: ChannelMessage;
    stackPrevious: boolean;
    stackNext: boolean;
    keepMounted: (id: string) => () => void;
    repliedAgents?: readonly string[];
    stoppedRequest?: ChannelMessage;
  }) => (
    <li
      data-message-id={row.id}
      data-replied-agents={repliedAgents?.join(",")}
      data-stopped-request={stoppedRequest?.id}
      data-stacked={stackPrevious}
      data-stack-next={stackNext}
    >
      {row.content}
      <button type="button" onClick={() => keepMounted(row.id)}>
        Retain {row.id}
      </button>
    </li>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function activityFixture() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const updates = (count: number): ChannelMessage[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `activity-${index}`,
      channelId: "alpha",
      authorId: "agent",
      audience: "agents",
      createdAt: 100 + index,
      content: `Update ${index}`,
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    }));
  const content = (
    rows: ChannelMessage[],
    inlineTarget?: { messageId: string; signal: AbortSignal },
    chatPresentation = true,
    queries = owner.session,
  ) => (
    <ChannelTimeline
      channelId="alpha"
      scope="activity-folding"
      queries={queries}
      chatPresentation={chatPresentation}
      inlineTarget={inlineTarget}
      window={{
        channelId: "alpha",
        rows,
        status: "ready",
        hasMore: false,
        loadingOlder: false,
        freshness: "verified",
        error: undefined,
      }}
      onOpenLink={() => false}
    />
  );
  return { owner, updates, content };
}

it("shows one latest-agent preview, retains expanded history through appends, and folds back", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const view = render(content(updates(9)));
    expect(screen.queryByText("Update 3")).toBeNull();
    expect(screen.getByText("Update 8")).toBeVisible();
    let toggle = screen.getByRole("button", {
      name: /Show activity history/,
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Update 0")).toBeVisible();
    view.rerender(content(updates(11)));
    toggle = screen.getByRole("button", { name: /Collapse activity history/ });
    expect(toggle).toHaveFocus();
    expect(screen.getByText("Update 0")).toBeVisible();
    expect(screen.getAllByText("Update 10")).toHaveLength(1);
    expect(
      screen.getByText("Update 0").compareDocumentPosition(toggle) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText("Update 5")).toBeNull();
    expect(screen.getByText("Update 10")).toBeVisible();
    expect(toggle).toHaveTextContent("Update 10");
    expect(toggle).toHaveFocus();
    view.rerender(
      content(
        updates(12).map((row, index) =>
          index === 11 ? { ...row, authorId: "reviewer" } : row,
        ),
      ),
    );
    toggle = screen.getByRole("button", { name: /Show activity history/ });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveTextContent("Update 11");
    expect(
      within(screen.getByRole("img", { name: "agent, reviewer" })).getByTitle(
        "reviewer",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Update 10")).toBeNull();
  } finally {
    owner.dispose();
  }
});

it("shows the first three distinct agents in the visible identity cluster while retaining its full label", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const authors = ["one", "two", "three", "four"];
    render(
      content(
        updates(9).map((row, index) => ({
          ...row,
          authorId: authors[index % authors.length] ?? "one",
        })),
      ),
    );
    const compact = within(
      screen.getByRole("img", { name: "one, two, three, four" }),
    );
    expect(compact.queryByText("+1")).toBeNull();
    expect(compact.getAllByTitle("one")).toHaveLength(1);
    expect(compact.getByTitle("two")).toBeVisible();
    expect(compact.getByTitle("three")).toBeVisible();
    expect(compact.queryByTitle("four")).toBeNull();
    const compactAvatar = compact.getAllByTitle("one")[0];
    if (!compactAvatar) throw new Error("Missing compact agent avatar");
    expect(
      compactAvatar.compareDocumentPosition(compact.getByTitle("two")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      compact
        .getByTitle("two")
        .compareDocumentPosition(compact.getByTitle("three")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Show activity history/ }),
    );
    expect(screen.queryByText("+1")).toBeNull();
    expect(screen.getByText("Update 8")).toBeVisible();
    const collapse = screen.getByRole("button", {
      name: /Collapse activity history/,
    });
    expect(collapse).toHaveTextContent("Collapse");
    expect(
      screen.getByText("Update 8").compareDocumentPosition(collapse) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(screen.getByText("Update 0")).toBeVisible();
  } finally {
    owner.dispose();
  }
});

it("reveals an older folded message for an exact visit, then permits folding it again", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const rows = updates(9);
    const view = render(content(rows));
    expect(screen.queryByText("Update 0")).toBeNull();
    view.rerender(
      content(rows, {
        messageId: "activity-0",
        signal: new AbortController().signal,
      }),
    );
    expect(screen.getByText("Update 0")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse activity history/ }),
    );
    expect(screen.queryByText("Update 0")).toBeNull();
  } finally {
    owner.dispose();
  }
});

it.each([1, 4])(
  "keeps a %i-step historical run expandable alongside subsequent work in channels",
  (count) => {
    const { owner, updates, content } = activityFixture();
    try {
      const rows = updates(count * 2 + 1);
      const view = render(content(rows, undefined, false));
      expect(screen.queryByText("Update 0")).toBeNull();
      expect(screen.getByText(`Update ${count * 2}`)).toBeVisible();
      const middle = rows[count];
      if (!middle) throw new Error("Missing fixture reply");
      const { audience: _audience, ...publicReply } = middle;
      view.rerender(
        content([
          ...rows.slice(0, count),
          { ...publicReply, content: "Main reply" },
          ...rows.slice(count + 1),
        ]),
      );
      if (count === 1) expect(screen.getByText("Update 0")).toBeVisible();
      else expect(screen.queryByText("Update 0")).toBeNull();
      const label = `${count} completed ${count === 1 ? "step" : "steps"}`;
      expect(screen.queryByText(label)).toBeNull();
      const reply = screen.getByText("Main reply");
      expect(reply).toBeVisible();
      expect(screen.getByText(`Update ${count * 2}`)).toBeVisible();
      expect(
        screen.getAllByRole("button", { name: /Show activity history/ }),
      ).toHaveLength(2);
    } finally {
      owner.dispose();
    }
  },
);

it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  "keeps ongoing typing in the reply group after completed history (replaced=%s, presented=%s)",
  (replaced, presented) => {
    const { owner, updates, content } = activityFixture();
    try {
      const history = updates(2);
      const last = history.at(-1);
      if (!last) throw new Error("Missing activity");
      const { audience: _audience, ...reply } = last;
      const activity = owner.session.agentActivity.snapshot();
      const snapshot = {
        ...activity,
        local: [
          {
            scope: "test",
            agent: reply.authorId,
            channelId: "alpha",
            messageId: "request",
            threadRootId: "request",
            state: "working" as const,
            startedAt: 1,
          },
        ],
      };
      const queries = {
        ...owner.session,
        agentActivity: {
          ...owner.session.agentActivity,
          snapshot: () => snapshot,
        },
      };
      const view = render(
        <ActivityIndicatorPresentation>
          <TypingPresentation active>
            {replaced && !presented && <RecordedTyping session={queries} />}
            {presented && <LiveBubble session={queries} />}
            {content(
              [...history, { ...reply, id: "reply", content: "Main reply" }],
              undefined,
              true,
              queries,
            )}
          </TypingPresentation>
        </ActivityIndicatorPresentation>,
      );
      expect(screen.queryByText("2 completed steps")).toBeNull();
      if (presented) {
        // A live bubble elsewhere shows the agent: no conversation cue, and
        // the reply does not join one.
        expect(
          screen.queryByRole("button", { name: /Activity: .*working/ }),
        ).toBeNull();
        expect(
          screen.getByText("Main reply").closest("li"),
        ).not.toHaveAttribute("data-stack-next", "true");
        return;
      }
      expect(
        screen.getByRole("button", { name: /Activity: .*working/ }),
      ).toBeVisible();
      expect(
        view.container.querySelector(
          "[data-conversation-activity] [data-agent-response-preview]",
        ),
      ).toHaveAttribute("data-stack-previous", "true");
      expect(screen.getByText("Main reply").closest("li")).toHaveAttribute(
        "data-stack-next",
        "true",
      );
    } finally {
      owner.dispose();
    }
  },
);

it.each([
  { anchor: "activity-8", expanded: true },
  { anchor: "activity-0", expanded: true },
])(
  "restores exact activity $anchor by revealing its history",
  ({ anchor, expanded }) => {
    const { owner, updates, content } = activityFixture();
    writeView("activity-folding", "scroll:alpha", {
      offset: 0,
      bottom: false,
      anchor: { id: anchor, y: 0 },
    });
    try {
      render(content(updates(9)));
      const toggle = screen.getByRole("button", {
        name: expanded ? /Collapse activity history/ : /Show activity history/,
      });
      expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
      if (expanded) expect(screen.getByText("Update 0")).toBeVisible();
      else expect(screen.queryByText("Update 0")).toBeNull();
    } finally {
      owner.dispose();
    }
  },
);

it("starts visible and retained steps with author artwork after a hidden predecessor", () => {
  const { owner, updates, content } = activityFixture();
  try {
    render(content(updates(9)));
    expect(screen.queryByText("Update 4")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Show activity history/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retain activity-2" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse activity history/ }),
    );
    expect(screen.getByText("Update 2")).toHaveAttribute(
      "data-stacked",
      "false",
    );
    expect(screen.getByText("Update 2")).toHaveAttribute(
      "data-stack-next",
      "false",
    );
  } finally {
    owner.dispose();
  }
});

it("retains an explicitly revealed step through later appends", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const target = {
      messageId: "activity-4",
      signal: new AbortController().signal,
    };
    const view = render(content(updates(9), target));
    expect(
      screen.getByRole("button", { name: /activity history/ }),
    ).toHaveAttribute("aria-expanded", "true");
    view.rerender(content(updates(10), target));
    expect(
      screen.getByRole("button", { name: /activity history/ }),
    ).toHaveAttribute("aria-expanded", "true");
  } finally {
    owner.dispose();
  }
});

it("does not expand history when visiting a retained visible step", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const rows = updates(9);
    const view = render(content(rows));
    fireEvent.click(
      screen.getByRole("button", { name: /Show activity history/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retain activity-2" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse activity history/ }),
    );
    expect(screen.getByText("Update 2")).toBeVisible();
    view.rerender(
      content(rows, {
        messageId: "activity-2",
        signal: new AbortController().signal,
      }),
    );
    expect(
      screen.getByRole("button", { name: /activity history/ }),
    ).toHaveAttribute("aria-expanded", "false");
  } finally {
    owner.dispose();
  }
});

it.each([false, true])(
  "preserves the initial restore expansion decision after append (bottom: %s)",
  (bottom) => {
    const { owner, updates, content } = activityFixture();
    writeView("activity-folding", "scroll:alpha", {
      offset: 0,
      bottom,
      anchor: { id: "activity-4", y: 0 },
    });
    try {
      const view = render(content(updates(9)));
      view.rerender(content(updates(10)));
      expect(
        screen.getByRole("button", { name: /activity history/ }),
      ).toHaveAttribute("aria-expanded", String(!bottom));
    } finally {
      owner.dispose();
    }
  },
);

it("restores a contained activity step at its saved offset rather than the group start", () => {
  const { owner, updates, content } = activityFixture();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        top: this.dataset.messageId === "activity-4" ? 240 : 0,
        left: 0,
        right: 800,
        bottom: 0,
        width: 800,
        height: 0,
        x: 0,
        y: 0,
        toJSON() {},
      };
    },
  );
  writeView("activity-folding", "scroll:alpha", {
    offset: 220,
    bottom: false,
    anchor: { id: "activity-4", y: 20 },
  });
  try {
    render(content(updates(9)));
    viewport.scrollToIndex.mockClear();
    act(() => {
      for (const callback of frames.splice(0)) callback(0);
    });
    expect(viewport.scrollToIndex).toHaveBeenCalledWith(0, {
      align: "start",
      offset: 220,
    });
  } finally {
    owner.dispose();
  }
});

it("waits for the first non-empty window to resolve a hidden saved activity anchor", () => {
  const { owner, updates, content } = activityFixture();
  writeView("activity-folding", "scroll:alpha", {
    offset: 0,
    bottom: false,
    anchor: { id: "activity-0", y: 0 },
  });
  try {
    const view = render(content([]));
    view.rerender(content(updates(9)));
    expect(
      screen.getByRole("button", { name: /Collapse activity history/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Update 0")).toBeVisible();
  } finally {
    owner.dispose();
  }
});

it.each(["collapse", "wheel"])(
  "settles an absent saved activity anchor before later history arrives (%s)",
  (intent) => {
    const { owner, updates, content } = activityFixture();
    writeView("activity-folding", "scroll:alpha", {
      offset: 0,
      bottom: false,
      anchor: { id: "activity-0", y: 0 },
    });
    try {
      const rows = updates(14);
      const view = render(content(rows.slice(5)));
      if (intent === "collapse") {
        fireEvent.click(
          screen.getByRole("button", { name: /Show activity history/ }),
        );
        fireEvent.click(
          screen.getByRole("button", { name: /Collapse activity history/ }),
        );
      } else {
        const timeline = view.container.querySelector(
          "[data-channel-timeline]",
        );
        if (!timeline) throw new Error("Missing timeline");
        fireEvent.wheel(timeline, { deltaY: -80 });
      }
      view.rerender(content(rows));
      expect(
        screen.getByRole("button", { name: /Show activity history/ }),
      ).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("Update 0")).toBeNull();
    } finally {
      owner.dispose();
    }
  },
);

it("ignores a hidden reading anchor when restoring the bottom", () => {
  const { owner, updates, content } = activityFixture();
  writeView("activity-folding", "scroll:alpha", {
    offset: 0,
    bottom: true,
    anchor: { id: "activity-0", y: 0 },
  });
  try {
    render(content(updates(9)));
    expect(
      screen.getByRole("button", { name: /activity history/ }),
    ).toHaveAttribute("aria-expanded", "false");
  } finally {
    owner.dispose();
  }
});

it.each([
  {
    solo: false,
    bottom: false,
    firstAnchor: "activity-0",
    nextAnchor: "activity-1",
  },
  {
    solo: true,
    bottom: false,
    firstAnchor: "activity-0",
    nextAnchor: "activity-1",
  },
  {
    solo: true,
    bottom: true,
    firstAnchor: "activity-4",
    nextAnchor: "activity-5",
  },
])(
  "reuses unchanged geometry across saved anchors (Solo: $solo, bottom: $bottom)",
  ({ solo, bottom, firstAnchor, nextAnchor }) => {
    const { owner, updates, content } = activityFixture();
    const rows = updates(9);
    // Observe the actual session-owned cache, not serialized reading state.
    try {
      writeView("activity-folding", "scroll:alpha", {
        offset: 0,
        bottom,
        anchor: { id: firstAnchor, y: 0 },
      });
      const first = render(content(rows, undefined, solo));
      first.unmount();
      writeView("activity-folding", "scroll:alpha", {
        offset: 0,
        bottom,
        anchor: { id: nextAnchor, y: 0 },
      });
      render(content(rows, undefined, solo));
      expect(viewport.caches.at(-1)).toEqual([[], 40]);
    } finally {
      owner.dispose();
    }
  },
);

it("shows only explicit additions and removals in personal chats", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const actor = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const row: ChannelMessage = {
    id: "joined",
    channelId: "alpha",
    authorId: viewer.pubkey,
    content: "",
    createdAt: 1,
    membership: {
      type: "member_joined",
      actor: viewer.pubkey,
      target: viewer.pubkey,
    },
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const window: ChannelWindow = {
    channelId: "alpha",
    rows: [row],
    status: "ready",
    hasMore: false,
    loadingOlder: false,
    freshness: "verified",
    error: undefined,
  };
  try {
    const view = render(
      <ChannelTimeline
        channelId="alpha"
        scope="membership"
        viewer={viewer.pubkey}
        queries={owner.session}
        window={window}
        chatPresentation
        onOpenLink={() => false}
      />,
    );
    expect(view.container.querySelector("[data-membership-row]")).toBeNull();
    for (const [type, actorId, expected] of [
      ["member_joined", actor.pubkey, "You were added by"],
      ["member_removed", actor.pubkey, "You were removed by"],
      ["member_left", viewer.pubkey, undefined],
    ] as const) {
      view.rerender(
        <ChannelTimeline
          channelId="alpha"
          scope="membership"
          viewer={viewer.pubkey}
          queries={owner.session}
          window={{
            ...window,
            rows: [
              {
                ...row,
                id: type,
                membership: { type, actor: actorId, target: viewer.pubkey },
              },
            ],
          }}
          chatPresentation
          onOpenLink={() => false}
        />,
      );
      if (expected) {
        const notice = view.container.querySelector("[data-membership-row]");
        expect(notice).toBeVisible();
        expect(notice).toHaveTextContent(expected);
      } else {
        expect(
          view.container.querySelector("[data-membership-row]"),
        ).toBeNull();
      }
    }
    view.unmount();
  } finally {
    owner.dispose();
  }
});

it("hides the owner's starting agents only in a complete personal chat", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const viewer = keypair(),
    agent = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const choices = owner.session.agentChoices;
  const library = {
    ...choices.snapshot(),
    identities: [{ pubkey: agent.pubkey }],
  } as unknown as ReturnType<typeof choices.snapshot>;
  const queries = {
    ...owner.session,
    agentChoices: { ...choices, snapshot: () => library },
  };
  const row = (
    id: string,
    content: string,
    createdAt: number,
  ): ChannelMessage => ({
    id,
    channelId: "alpha",
    authorId: viewer.pubkey,
    content,
    createdAt,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  });
  const added: ChannelMessage = {
    ...row("added", "", 1),
    membership: {
      type: "member_joined",
      actor: viewer.pubkey,
      target: agent.pubkey,
    },
  };
  const window: ChannelWindow = {
    channelId: "alpha",
    rows: [added, row("first", "First message", 2)],
    status: "ready",
    hasMore: false,
    loadingOlder: false,
    freshness: "verified",
    error: undefined,
  };
  const timeline = (
    chatPresentation: boolean,
    hasMore = false,
    historyLimited = false,
  ) => (
    <ChannelTimeline
      channelId="alpha"
      scope="starting-agents"
      viewer={viewer.pubkey}
      queries={queries}
      window={{ ...window, hasMore, historyLimited }}
      chatPresentation={chatPresentation}
      onOpenLink={() => false}
    />
  );
  const notice = () => document.querySelector("[data-membership-row]");
  try {
    const view = render(timeline(true));
    expect(screen.getByText("First message")).toBeVisible();
    expect(notice()).toBeNull();
    // Partial history cannot prove the addition started the chat.
    view.rerender(timeline(true, true));
    expect(notice()).not.toBeNull();
    // Nor can a live window whose older rows were trimmed after reaching it.
    view.rerender(timeline(true, false, true));
    expect(notice()).not.toBeNull();
    // Team channels keep every notice.
    view.rerender(timeline(false));
    expect(notice()).not.toBeNull();
    view.unmount();
  } finally {
    owner.dispose();
  }
});

it("offline, says older messages can be loaded once Buzz reconnects instead of offering an inert Load older", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const viewer = keypair(),
    relay = keypair();
  // The relay service's saved-conversations session and the connected
  // session that replaces it share one identity and scope.
  const transport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async () => [],
  };
  const offline = createRelaySession(transport, { cachedOnly: true });
  const online = createRelaySession(transport);
  // One saved page of a longer history.
  const window: ChannelWindow = {
    channelId: "alpha",
    rows: foldMessages("alpha", relay.pubkey, [
      message(viewer, "alpha", "Saved message", 100),
    ]),
    status: "ready",
    hasMore: true,
    loadingOlder: false,
    freshness: "cached",
    error: undefined,
  };
  const timeline = (
    owner: typeof offline,
    historyControl: "button" | "scroll" = "button",
  ) => (
    <ChannelTimeline
      channelId="alpha"
      scope="offline-history"
      continuityKey="relay:1"
      queries={owner.session}
      window={window}
      historyControl={historyControl}
      onOpenLink={() => false}
    />
  );
  const waiting = "You can load older messages once Buzz reconnects.";
  try {
    const view = render(timeline(offline));
    expect(screen.getByText(waiting)).toBeVisible();
    expect(screen.queryByRole("button", { name: /older messages/ })).toBeNull();
    // Solo chats page on scroll, which reads nothing offline either.
    view.rerender(timeline(offline, "scroll"));
    expect(screen.getByText(waiting)).toBeVisible();
    // The connected session replaces it without remounting the timeline.
    const history = screen.getByRole("region", {
      name: "Channel message history",
    });
    view.rerender(timeline(online));
    expect(
      screen.getByRole("region", { name: "Channel message history" }),
    ).toBe(history);
    expect(
      screen.getByRole("button", { name: "Load older messages" }),
    ).toBeEnabled();
    expect(screen.queryByText(waiting)).toBeNull();
    view.unmount();
  } finally {
    offline.dispose();
    online.dispose();
  }
});

it.each([0, 600])(
  "prepend compensation requires a measured virtualizer viewport (%s)",
  (size) => {
    viewport.size = size;
    // The outer timeline can have layout before Virtua's own observer delivers.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // Leave positioning frames queued: this case controls the premeasurement boundary.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const viewer = keypair(),
      relay = keypair();
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
      subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
    });
    const older = message(viewer, "alpha", "Older finite message", 1);
    const live = message(viewer, "alpha", "Live message", 2);
    const snapshot = (
      events: Parameters<typeof foldMessages>[2],
    ): ChannelWindow => ({
      channelId: "alpha",
      rows: foldMessages("alpha", relay.pubkey, events),
      status: "ready",
      hasMore: false,
      loadingOlder: false,
      freshness: "verified",
      error: undefined,
    });
    const content = (window: ChannelWindow) => (
      <ChannelTimeline
        channelId="alpha"
        scope="viewport-regression"
        queries={owner.session}
        window={window}
        onOpenLink={() => false}
      />
    );
    try {
      const view = render(content(snapshot([live])));
      const boundary = screen.getByRole("list", {
        name: "Virtualized messages",
      });
      expect(boundary).toHaveAttribute("data-shift", "false");
      expect(screen.getByText("Live message")).toBeVisible();
      view.rerender(content(snapshot([older, live])));
      expect(screen.getByRole("list", { name: "Virtualized messages" })).toBe(
        boundary,
      );
      expect(boundary).toHaveAttribute("data-shift", size ? "true" : "false");
      expect(screen.getByText("Older finite message")).toBeVisible();
      view.unmount();
    } finally {
      owner.dispose();
    }
  },
);

it.each([
  ["above the reader's rows", 1, "true"],
  ["among the reader's rows", 2, "false"],
])("rows added below the first row shift only %s", (_, start, shift) => {
  viewport.size = 600;
  viewport.start = start;
  const { owner, updates, content } = activityFixture();
  // Relay pages break same-second ties by id, so a page can sort below the
  // loaded first row. Only Virtua's first visible item and below must stay.
  const rows = updates(5);
  const loaded = rows.slice(0, 4);
  const at = start === 1 ? 1 : 3;
  try {
    const view = render(content(loaded, undefined, false));
    const boundary = screen.getByRole("list", {
      name: "Virtualized messages",
    });
    expect(boundary).toHaveAttribute("data-shift", "false");
    view.rerender(
      content(
        [...loaded.slice(0, at), ...rows.slice(4), ...loaded.slice(at)],
        undefined,
        false,
      ),
    );
    expect(boundary).toHaveAttribute("data-shift", shift);
    view.unmount();
  } finally {
    viewport.start = 0;
    owner.dispose();
  }
});

it("keeps historical steps expandable after a public reply without live completion state", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const rows = updates(3);
    const last = rows[2];
    if (!last) throw new Error("Missing fixture activity");
    const { audience: _audience, ...base } = last;
    const response = {
      ...base,
      id: "public-response",
      createdAt: 110,
      content: "Here is the result.",
    };
    const view = render(content([...rows, { ...response, authorId: "human" }]));
    expect(screen.queryByText("3 completed steps")).toBeNull();
    view.rerender(content([...rows, response]));
    expect(screen.queryByText("3 completed steps")).toBeNull();
    expect(screen.getByText("Update 2")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: /Show activity history/ }),
    );
    expect(screen.getByText("Update 0")).toBeVisible();
    expect(screen.getByText("Here is the result.")).toBeVisible();
  } finally {
    owner.dispose();
  }
});

it("moves a request's stopped note to its agent's latest public reply", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const step = updates(1)[0];
    if (!step) throw new Error("Missing fixture activity");
    const { audience: _audience, ...base } = step;
    const message = (id: string, authorId: string, createdAt: number) => ({
      ...base,
      id,
      authorId,
      createdAt,
      content: id,
    });
    render(
      content([
        message("request", "human", 90),
        message("first", "agent", 91),
        step,
        message("latest", "agent", 110),
      ]),
    );
    const row = (id: string) =>
      document.querySelector(`[data-message-id="${id}"]`);
    expect(row("request")).toHaveAttribute("data-replied-agents", "agent");
    expect(row("latest")).toHaveAttribute("data-stopped-request", "request");
    expect(row("first")).not.toHaveAttribute("data-stopped-request");
  } finally {
    owner.dispose();
  }
});

it("opens the preserved history for a directly linked completed step", () => {
  const f = activityFixture();
  const steps = f.updates(2);
  const first = steps[0];
  if (!first) throw new Error("Missing step");
  const { audience: _audience, ...publicRow } = first;
  const rows = [
    ...steps,
    {
      ...publicRow,
      id: "reply",
      content: "Finished",
      createdAt: 110,
    },
  ];
  const view = render(f.content(rows));
  expect(
    screen.getByRole("button", { name: /Show activity history/ }),
  ).toBeVisible();
  view.rerender(
    f.content(rows, {
      messageId: "activity-1",
      signal: new AbortController().signal,
    }),
  );
  expect(screen.getByText("Update 1")).toBeVisible();
  expect(screen.getByText("Update 0")).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Collapse activity history/ }),
  ).toBeVisible();
  view.unmount();
  f.owner.dispose();
});

it.each([0, 1])(
  "includes the measured activity tail only when sent row %s is last",
  (sentIndex) => {
    const { owner, updates, content } = activityFixture();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const height = this.querySelector(`:scope > .${styles.timelineEnd}`)
          ? 75
          : 0;
        return {
          top: 0,
          left: 0,
          right: 800,
          bottom: height,
          width: 800,
          height,
          x: 0,
          y: 0,
          toJSON() {},
        };
      },
    );
    const rows = updates(2).map(({ audience: _audience, ...row }) => row);
    try {
      render(
        cloneElement(content(rows), { revealMessageId: rows[sentIndex]?.id }),
      );
      viewport.scrollToIndex.mockClear();
      act(() => {
        for (const frame of frames.splice(0)) frame(0);
      });
      expect(viewport.scrollToIndex).toHaveBeenCalledWith(sentIndex, {
        align: "end",
        ...(sentIndex === 1 ? { offset: 75 } : {}),
      });
    } finally {
      owner.dispose();
    }
  },
);

it("keeps positioning idle when an unrelated activity update leaves the shown rows unchanged", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const history = updates(2);
    const last = history.at(-1);
    if (!last) throw new Error("Missing activity");
    const { audience: _audience, ...reply } = last;
    const listeners = new Set<() => void>();
    let snapshot = owner.session.agentActivity.snapshot();
    const queries = {
      ...owner.session,
      agentActivity: {
        ...owner.session.agentActivity,
        snapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
    render(
      content(
        [...history, { ...reply, id: "reply", content: "Main reply" }],
        undefined,
        true,
        queries,
      ),
    );
    expect(screen.queryByText("Update 0")).toBeNull();
    const positioned = vi.mocked(requestAnimationFrame).mock.calls.length;
    act(() => {
      snapshot = { ...snapshot, records: Object.freeze([]) };
      for (const listener of listeners) listener();
    });
    expect(screen.queryByText("Update 0")).toBeNull();
    expect(vi.mocked(requestAnimationFrame).mock.calls.length).toBe(positioned);
  } finally {
    owner.dispose();
  }
});

// A head of folded agent activity can leave nothing to scroll. Real React
// schedules the fill's layout effect and frames; Virtua is the mocked boundary.
function fillFixture({
  window: patch = {} as Partial<ChannelWindow>,
  cachedOnly = false,
  recovering = false,
  intro = undefined as ReactNode,
} = {}) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  const geometry = { scrollHeight: 600 };
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    () => geometry.scrollHeight,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const flush = () =>
    act(() => {
      for (let round = 0; round < 5 && frames.size; round++)
        for (const [id, callback] of [...frames]) {
          frames.delete(id);
          callback(0);
        }
    });
  viewport.size = 600;
  const viewer = keypair(),
    relay = keypair();
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
    },
    cachedOnly ? { cachedOnly: true } : undefined,
  );
  let events = [message(viewer, "alpha", "Latest public message", 100)];
  let window: ChannelWindow = {
    channelId: "alpha",
    rows: foldMessages("alpha", relay.pubkey, events),
    status: "ready",
    hasMore: true,
    loadingOlder: false,
    freshness: "verified",
    error: undefined,
    ...patch,
  };
  const recovery = { recovering, attempt: 0, shown: false, reauthorized: 0 };
  // The store marks the window loading as it accepts a read.
  const loadOlder = vi.fn(() => {
    if (!window.loadingOlder) window = { ...window, loadingOlder: true };
  });
  const queries = {
    ...owner.session,
    channels: { ...owner.session.channels, loadOlder, window: () => window },
    recovery: {
      snapshot: () => recovery,
      subscribe: () => () => {},
    },
  } as unknown as RelaySession;
  const content = () => (
    <ChannelTimeline
      channelId="alpha"
      scope="fill"
      queries={queries}
      window={window}
      intro={intro}
      onOpenLink={() => false}
    />
  );
  const view = render(content());
  flush();
  return {
    geometry,
    loadOlder,
    /** An older page lands, or a read ends with the given patch. */
    land(next: Partial<ChannelWindow> = {}) {
      events = [
        message(viewer, "alpha", `Older ${events.length}`, 100 - events.length),
        ...events,
      ];
      window = {
        ...window,
        rows: foldMessages("alpha", relay.pubkey, events),
        loadingOlder: false,
        ...next,
      };
      view.rerender(content());
      flush();
    },
    dispose() {
      view.unmount();
      owner.dispose();
      viewport.size = 0;
    },
  };
}

it("a settled reader at the bottom fills a screen with nothing to scroll", () => {
  const h = fillFixture();
  try {
    expect(h.loadOlder).toHaveBeenCalledExactlyOnceWith("alpha");
  } finally {
    h.dispose();
  }
});

it("fills past a pending intro and shows it only when verified history reaches its start", () => {
  const h = fillFixture({
    intro: <article aria-label="Local introduction">Welcome</article>,
  });
  try {
    expect(h.loadOlder).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(
      screen.queryByRole("article", { name: "Local introduction" }),
    ).toBeNull();
    h.land({ hasMore: false });
    expect(
      screen.getByRole("article", { name: "Local introduction" }),
    ).toBeVisible();
    expect(screen.getByText("Latest public message")).toBeVisible();
    expect(screen.getByText("Older 1")).toBeVisible();
    expect(h.loadOlder).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
  }
});

it("filling reads at most five pages a visit", () => {
  const h = fillFixture();
  try {
    for (let page = 0; page < 6; page++) h.land();
    expect(h.loadOlder).toHaveBeenCalledTimes(5);
  } finally {
    h.dispose();
  }
});

it("filling stops once the history can scroll", () => {
  const h = fillFixture();
  try {
    h.geometry.scrollHeight = 601;
    h.land();
    expect(h.loadOlder).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
  }
});

it("a failed fill read is not retried unasked", () => {
  const h = fillFixture();
  try {
    h.land({ error: "Relay requests paused" });
    expect(h.loadOlder).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
  }
});

it.each([
  ["no older history", { window: { hasMore: false } }],
  ["a read in flight", { window: { loadingOlder: true } }],
  ["limited history", { window: { historyLimited: true } }],
  ["a failed read", { window: { error: "Relay requests paused" } }],
  ["an unverified cached head", { window: { freshness: "cached" as const } }],
  ["a cached-only session", { cachedOnly: true }],
  ["a recovering connection", { recovering: true }],
])("does not fill with %s", (_, options) => {
  const h = fillFixture(options);
  try {
    expect(h.loadOlder).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it("does not fill while a saved reading place is restored", () => {
  writeView("fill", "scroll:alpha", {
    bottom: false,
    anchor: { id: "missing", y: 0 },
  });
  const h = fillFixture();
  try {
    expect(h.loadOlder).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it("a filled page keeps the follower at the bottom; a later page is anchored", () => {
  const h = fillFixture();
  try {
    h.geometry.scrollHeight = 2000;
    viewport.scrollToIndex.mockClear();
    h.land();
    expect(viewport.scrollToIndex).toHaveBeenCalledWith(1, { align: "end" });
    viewport.scrollToIndex.mockClear();
    h.land();
    expect(viewport.scrollToIndex).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
