// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "../../../features/agents/service";
import type { ChannelLabel } from "../../../features/channels/channel-icon";
import { PanelSubviewHost } from "../../../features/panels/PanelSubview";
import type { AgentClient, AgentSession } from "../agents/client";
import { LIVE_READ_MS } from "../../../features/agents/TranscriptPanel";
import type { AgentActivity } from "./Activity";
import { StoredActivity } from "./StoredActivity";

afterEach(cleanup);

const agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  relay: "wss://relay.example.org",
} as unknown as Agent;
const root = "r".repeat(64);
const dm: AgentSession = { sessionId: "dm", channelId: "dm", updatedAt: 2000 };
const thread: AgentSession = {
  sessionId: "thread",
  channelId: "alpha",
  threadRootId: root,
  updatedAt: 1000,
};
const labels: Record<string, ChannelLabel> = {
  dm: { name: "Sam", channelType: "dm" },
  alpha: { name: "alpha" },
};

function setup({
  listed = [dm, thread],
  more = false,
  conversation,
  lookup = [],
  activity,
}: {
  listed?: AgentSession[];
  more?: boolean;
  conversation?: { channelId: string; rootId?: string };
  lookup?: AgentSession[];
  activity?: AgentActivity;
}) {
  const client = {
    sessions: vi.fn(async () => ({ sessions: lookup })),
    sessionMessages: vi.fn(async () => ({
      turns: [
        { turn_id: "t1", created_at: 1, status: "TASK_STATUS_COMPLETED" },
      ],
      messages: [],
    })),
  } as unknown as AgentClient;
  const openConversation = vi.fn();
  render(
    <PanelSubviewHost close={() => {}}>
      <StoredActivity
        agent={agent}
        {...(conversation && { conversation })}
        openConversation={openConversation}
        client={client}
        listed={Promise.resolve({
          status: "loaded",
          agentId: "agent-1",
          sessions: listed,
          more,
        })}
        activity={activity}
        channelLabel={(id) => labels[id]}
        name={() => undefined}
      />
    </PanelSubviewHost>,
  );
  return { client, openConversation };
}

const section = async (name: string) => {
  const heading = await screen.findByRole("heading", { name });
  return within(heading.closest("section") as HTMLElement);
};

it("counts a DM's one session as the conversation it was opened from", async () => {
  const { client } = setup({ conversation: { channelId: "dm" } });
  const here = await section("This channel");
  expect(
    await here.findByRole("button", { name: "View transcript: Sam" }),
  ).toBeVisible();
  const recent = await section("Recent conversations");
  expect(await recent.findByText("alpha")).toBeVisible();
  expect(recent.queryByText("Sam")).toBeNull();
  expect(client.sessions).not.toHaveBeenCalled();
});

it("asks Builderlab for the opened thread's session when the page lacks it", async () => {
  const shared: AgentSession = {
    sessionId: "shared",
    channelId: "beta",
    updatedAt: 3000,
  };
  const { client } = setup({
    conversation: { channelId: "beta", rootId: "o".repeat(64) },
    lookup: [shared],
  });
  const here = await section("This channel");
  expect(
    await here.findByRole("button", { name: "View transcript: beta" }),
  ).toBeVisible();
  expect(client.sessions).toHaveBeenCalledExactlyOnceWith(
    "agent-1",
    expect.any(AbortSignal),
    {
      community: "wss://relay.example.org",
      channelId: "beta",
      threadRootId: "o".repeat(64),
    },
  );
});

it("reads a transcript only when it opens, and links to its conversation", async () => {
  const { client, openConversation } = setup({});
  const user = userEvent.setup();
  const recent = await section("Recent conversations");
  expect(client.sessionMessages).not.toHaveBeenCalled();
  await user.click(
    await recent.findByRole("button", {
      name: "View transcript: alpha · thread rrrrrrrr",
    }),
  );
  expect(client.sessionMessages).toHaveBeenCalledExactlyOnceWith(
    "thread",
    expect.any(AbortSignal),
  );
  await user.click(
    await screen.findByRole("button", { name: "Open this thread" }),
  );
  expect(openConversation).toHaveBeenCalledWith("alpha", root);
});

it("says older conversations aren't shown when the list is cut", async () => {
  setup({
    listed: Array.from({ length: 31 }, (_, index) => ({
      sessionId: `s${index}`,
      channelId: `c${index}`,
      updatedAt: index,
    })),
  });
  const recent = await section("Recent conversations");
  expect(
    await recent.findAllByRole("button", { name: /View transcript/ }),
  ).toHaveLength(30);
  expect(recent.getByText("Older conversations aren't shown.")).toBeVisible();
});

it("says older conversations exist when the first page has none", async () => {
  setup({ listed: [], more: true });
  const recent = await section("Recent conversations");
  expect(
    await recent.findByText(
      "No recent conversations found. Older ones aren't shown.",
    ),
  ).toBeVisible();
  expect(recent.queryByText("No other conversations stored yet.")).toBeNull();
  expect(recent.queryByText("Older conversations aren't shown.")).toBeNull();
});

it("reads an open transcript again when its turn ends, not while it runs", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let turns = [
      { agent: agent.pubkey, state: "working", sessionId: "thread" },
    ];
    const listeners = new Set<() => void>();
    const activity = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      snapshot: () => ({ turns }),
    } as unknown as AgentActivity;
    const { client } = setup({ activity });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const recent = await section("Recent conversations");
    await user.click(
      recent.getByRole("button", {
        name: "View transcript: alpha · thread rrrrrrrr",
      }),
    );
    await screen.findByRole("button", { name: "Open this thread" });
    await act(async () => vi.advanceTimersByTime(LIVE_READ_MS * 3));
    expect(client.sessionMessages).toHaveBeenCalledOnce();
    turns = [{ agent: agent.pubkey, state: "done", sessionId: "thread" }];
    act(() => {
      for (const listener of listeners) listener();
    });
    await vi.waitFor(() =>
      expect(client.sessionMessages).toHaveBeenCalledTimes(2),
    );
  } finally {
    vi.useRealTimers();
  }
});
