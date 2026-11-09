// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ChannelActivityPopover } from "./ChannelActivityPopover";
import { Button } from "../../shared/design-system/ui/Button";
import { ChannelSidebarRows } from "../../features/channel-navigation/ChannelSidebarRows";
import type { RelaySession } from "../../features/relay/session";
import type {
  MentionActivityItem,
  ThreadActivityItem,
  ThreadActivitySnapshot,
} from "../../features/relay/unread";
import { createInboxFeed } from "../../features/relay/inbox-feed";
import type { InboxFeedSnapshot } from "../../features/relay/inbox-feed";
import type { ChannelQueries } from "../../features/relay/contracts";
import type { RelayEvent } from "../../features/relay/events";

afterEach(cleanup);

const settled: InboxFeedSnapshot = { status: "ready", incomplete: [] };
// No message's edits or deletions are still being checked.
const settledFeed = { snapshot: () => settled, subscribe: () => () => {} };

test("closes activity while its row exits and does not reopen on re-entry", async () => {
  const user = userEvent.setup();
  const snapshot: ThreadActivitySnapshot = {
    channelId: "studio",
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  const session = {
    unread: { activity: () => snapshot, subscribeActivity: () => () => {} },
    agentActivity: {
      snapshot: () => ({ records: [], turns: [], typing: [] }),
      subscribe: () => () => {},
    },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const view = (present: boolean) => (
    <ChannelSidebarRows open>
      {present
        ? [
            <ChannelActivityPopover
              key="studio"
              session={session}
              channelId="studio"
              channelName="Studio"
              trigger={<Button>Activity</Button>}
              agents={["a".repeat(64)]}
              onOpenThread={vi.fn()}
              onOpenMention={vi.fn()}
            />,
          ]
        : []}
    </ChannelSidebarRows>
  );
  const mounted = render(view(true));
  const trigger = screen.getByRole("button", { name: "Activity" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Activity in Studio" });
  mounted.rerender(view(false));
  expect(trigger.closest("[inert]")).not.toBeNull();
  expect(
    screen.queryByRole("dialog", { name: "Activity in Studio" }),
  ).toBeNull();
  mounted.rerender(view(true));
  expect(screen.getByRole("button", { name: "Activity" })).toBe(trigger);
  expect(
    screen.queryByRole("dialog", { name: "Activity in Studio" }),
  ).toBeNull();
});

test("mouse presses do not pin the hover preview open, and only hover marks it a preview", async () => {
  const user = userEvent.setup();
  const snapshot: ThreadActivitySnapshot = {
    channelId: "studio",
    items: [
      {
        channelId: "studio",
        rootId: "thread",
        latestMessageId: "message",
        authorId: "alex",
        createdAt: 1,
        preview: "Please review the designs",
        unreadCount: 1,
      },
    ],
    coverage: "observed",
    freshness: "observed",
  };
  const session = {
    unread: { activity: () => snapshot, subscribeActivity: () => () => {} },
    profiles: {
      snapshot: () => new Map(),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentChoices: { snapshot: () => ({ identities: [] }) },
    inboxFeed: settledFeed,
  } as unknown as RelaySession;
  render(
    <ChannelActivityPopover
      session={session}
      channelId="studio"
      channelName="Studio"
      trigger={<Button>Activity</Button>}
      onOpenThread={vi.fn()}
      onOpenMention={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Activity" });
  await user.hover(trigger);
  const preview = await screen.findByRole("dialog", {
    name: "Activity in Studio",
  });
  expect(trigger).toHaveAttribute("data-popup-preview");
  await user.click(trigger);
  expect(preview).toBeVisible();
  expect(trigger).toHaveAttribute("data-popup-preview");
  await user.hover(preview);
  expect(preview).toBeVisible();
  await user.unhover(preview);
  await waitFor(() => expect(preview).not.toBeInTheDocument());
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Activity in Studio" });
  expect(trigger).not.toHaveAttribute("data-popup-preview");
});

test("activity keeps profile loading lazy, explains stale results and opens the selected thread", async () => {
  const user = userEvent.setup();
  const item: ThreadActivityItem = {
    channelId: "studio",
    rootId: "thread",
    latestMessageId: "message",
    authorId: "alex",
    createdAt: 1,
    preview: "Please review the designs",
    unreadCount: 2,
  };
  const snapshot: ThreadActivitySnapshot = {
    channelId: "studio",
    items: [item],
    coverage: "observed",
    freshness: "stale",
  };
  const profiles = new Map([["alex", { name: "Alex" }]]);
  const ensure = vi.fn(async () => {});
  const open = vi.fn();
  const markThrough = vi
    .fn()
    .mockRejectedValueOnce(new Error("Storage unavailable"))
    .mockResolvedValueOnce({ durability: "saved" });
  const session = {
    agentChoices: {
      snapshot: () => ({ identities: [{ pubkey: "alex" }] }),
    },
    unread: {
      activity: () => snapshot,
      subscribeActivity: () => () => {},
      markThrough,
    },
    profiles: { snapshot: () => profiles, subscribe: () => () => {}, ensure },
    inboxFeed: settledFeed,
  } as unknown as RelaySession;
  render(
    <ChannelActivityPopover
      session={session}
      channelId="studio"
      channelName="Studio"
      trigger={<Button>Activity</Button>}
      onOpenThread={open}
      onOpenMention={vi.fn()}
    />,
  );
  expect(ensure).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  screen.getByRole("button", { name: "Activity" }).focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("dialog", { name: "Activity in Studio" }),
  ).toBeVisible();
  expect(ensure).toHaveBeenCalledExactlyOnceWith(["alex"], "background");
  expect(
    screen.queryByRole("heading", { name: "Channel activity" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { level: 2, name: "Unread threads" }),
  ).toBeVisible();
  const unreadRow = screen.getByRole("button", {
    name: "Open unread thread from Alex: Please review the designs",
  });
  expect(
    unreadRow.querySelector('[data-avatar-shape="squircle"]'),
  ).not.toBeNull();
  expect(unreadRow).not.toHaveTextContent(/\bThread\b|2 unread/);
  expect(screen.getByText("May be out of date")).toBeVisible();
  const markRead = screen.getByRole("button", {
    name: "Mark thread from Alex as read",
  });
  expect(markRead.closest(".navigation-item")).toBeNull();
  await user.click(markRead);
  expect(markThrough).toHaveBeenCalledExactlyOnceWith(
    { kind: "thread", channelId: "studio", rootId: "thread" },
    "message",
  );
  expect(open).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not mark this thread as read. Try again.",
  );
  await user.click(markRead);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(markThrough).toHaveBeenCalledTimes(2);
  await user.click(
    screen.getByRole("button", {
      name: "Open unread thread from Alex: Please review the designs",
    }),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(item);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

test("unread mentions open activity alone, list above threads, open by message and read by message", async () => {
  const user = userEvent.setup();
  const mention: MentionActivityItem = {
    channelId: "studio",
    messageId: "mention",
    authorId: "sam",
    createdAt: 2,
    preview: "@you can you sign off?",
  };
  const thread: ThreadActivityItem = {
    channelId: "studio",
    rootId: "thread",
    latestMessageId: "reply",
    authorId: "alex",
    createdAt: 1,
    preview: "Please review the designs",
    unreadCount: 1,
  };
  let snapshot: ThreadActivitySnapshot = {
    channelId: "studio",
    items: [],
    mentions: [mention],
    coverage: "observed",
    freshness: "observed",
  };
  const listeners = new Set<() => void>();
  const profiles = new Map([
    ["sam", { name: "Sam" }],
    ["alex", { name: "Alex" }],
  ]);
  const ensure = vi.fn(async () => {});
  const openMention = vi.fn();
  const openThread = vi.fn();
  const markThrough = vi
    .fn()
    .mockRejectedValueOnce(new Error("Storage unavailable"))
    .mockResolvedValueOnce({ durability: "saved" });
  const session = {
    agentChoices: { snapshot: () => ({ identities: [] }) },
    unread: {
      activity: () => snapshot,
      subscribeActivity: (_: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      markThrough,
    },
    profiles: { snapshot: () => profiles, subscribe: () => () => {}, ensure },
    inboxFeed: settledFeed,
  } as unknown as RelaySession;
  render(
    <ChannelActivityPopover
      session={session}
      channelId="studio"
      channelName="Studio"
      trigger={<Button>Activity</Button>}
      onOpenThread={openThread}
      onOpenMention={openMention}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Activity" });
  await user.hover(trigger);
  const popup = await screen.findByRole("dialog", {
    name: "Activity in Studio",
  });
  expect(
    screen.getByRole("heading", { level: 2, name: "Mentions" }),
  ).toBeVisible();
  expect(screen.queryByRole("region", { name: "Unread threads" })).toBeNull();
  // Revealing the popover reads nothing.
  expect(markThrough).not.toHaveBeenCalled();
  const markRead = screen.getByRole("button", {
    name: "Mark mention from Sam as read",
  });
  await user.click(markRead);
  expect(markThrough).toHaveBeenCalledExactlyOnceWith(
    { kind: "message", channelId: "studio", messageId: "mention" },
    "mention",
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not mark this mention as read. Try again.",
  );
  await user.click(markRead);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  snapshot = { ...snapshot, items: [thread] };
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(
    within(popup)
      .getAllByRole("region")
      .map((section) => section.getAttribute("aria-label")),
  ).toEqual(["Mentions", "Unread threads"]);
  await user.click(
    screen.getByRole("button", {
      name: "Open unread mention from Sam: @you can you sign off?",
    }),
  );
  expect(openMention).toHaveBeenCalledExactlyOnceWith(mention);
  expect(openThread).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Activity in Studio" });
  expect(ensure).toHaveBeenLastCalledWith(["sam", "alex"], "background");
});

test("a mention whose edits or deletions are unchecked shows the Inbox placeholder until they settle", async () => {
  const user = userEvent.setup();
  const body = "@you can you sign off?";
  const mention: MentionActivityItem = {
    channelId: "studio",
    messageId: "mention",
    authorId: "sam",
    createdAt: 2,
    preview: body,
  };
  const snapshot: ThreadActivitySnapshot = {
    channelId: "studio",
    items: [],
    mentions: [mention],
    coverage: "observed",
    freshness: "observed",
  };
  const event = {
    id: mention.messageId,
    kind: 9,
    pubkey: mention.authorId,
    created_at: mention.createdAt,
    content: body,
    tags: [["p", "you"]],
  } as unknown as RelayEvent;
  // Each attempt's edit/deletion read of the mention is held until released.
  const reads: {
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const feed = createInboxFeed({
    viewer: "you",
    channels: {
      list: () => ({ channels: [] }),
      subscribeList: () => () => {},
    } as unknown as ChannelQueries,
    reader: {
      read: ([filter]) =>
        filter?.["#e"]?.includes(event.id)
          ? new Promise((resolve, reject) => reads.push({ resolve, reject }))
          : Promise.resolve([]),
    },
    async addressedRead(_filter, _signal, prepare) {
      prepare([event]);
      return [event];
    },
    retainedEvent: (id) => (id === event.id ? event : undefined),
    retainedEditIds: () => [],
  });
  const profiles = new Map([["sam", { name: "Sam" }]]);
  const session = {
    agentChoices: { snapshot: () => ({ identities: [] }) },
    unread: { activity: () => snapshot, subscribeActivity: () => () => {} },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    inboxFeed: feed,
  } as unknown as RelaySession;
  render(
    <ChannelActivityPopover
      session={session}
      channelId="studio"
      channelName="Studio"
      trigger={<Button>Activity</Button>}
      onOpenThread={vi.fn()}
      onOpenMention={vi.fn()}
    />,
  );
  const row = (preview: string) =>
    screen.getByRole("button", {
      name: `Open unread mention from Sam: ${preview}`,
    });
  try {
    screen.getByRole("button", { name: "Activity" }).focus();
    await user.keyboard("{Enter}");
    const popup = await screen.findByRole("dialog", {
      name: "Activity in Studio",
    });
    expect(row(body)).toHaveTextContent(body);
    let work = Promise.resolve();
    await act(async () => {
      work = feed.ensure();
    });
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(feed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [event.id],
    });
    expect(row("Preview updating…")).toHaveTextContent("Preview updating…");
    expect(popup).not.toHaveTextContent(body);
    await act(async () => {
      reads[0]?.reject(new Error("Edits unavailable"));
      await work;
    });
    expect(feed.snapshot()).toMatchObject({
      status: "error",
      incomplete: [event.id],
    });
    expect(row("Preview unavailable. Retry activity.")).toHaveTextContent(
      "Preview unavailable. Retry activity.",
    );
    expect(popup).not.toHaveTextContent(body);
    await act(async () => {
      work = feed.refresh();
    });
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(row("Preview updating…")).toHaveTextContent("Preview updating…");
    await act(async () => {
      reads[1]?.resolve([]);
      await work;
    });
    expect(feed.snapshot()).toMatchObject({ status: "ready", incomplete: [] });
    expect(row(body)).toHaveTextContent(body);
  } finally {
    for (const read of reads) read.resolve([]);
    feed.dispose();
  }
});

test("working agents open their thread when linked, otherwise the conversation", async () => {
  const user = userEvent.setup();
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const ensure = vi.fn(async () => {});
  const media = vi.fn((url: string) => `media:${url}`);
  const openWorkingAgent = vi.fn();
  const openAgentActivity = vi.fn();
  const messageId = "c".repeat(64);
  const snapshot = {
    channelId: "studio",
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  const startedAt = Date.now() - 125_000;
  const session = {
    agentActivity: {
      snapshot: () => ({
        status: "listening",
        records: [
          {
            id: "d".repeat(64),
            agent: first,
            receivedAt: Date.now(),
            kind: "turn_started",
            plaintext: JSON.stringify({
              kind: "turn_started",
              channelId: "studio",
              turnId: "one",
              timestamp: new Date(startedAt).toISOString(),
              payload: { triggeringEventIds: [messageId] },
            }),
          },
        ],
        turns: [
          {
            agent: first,
            channelId: "studio",
            turnId: "one",
            timestamp: Date.now(),
            state: "working",
          },
        ],
        typing: [],
        trimmed: 0,
      }),
      subscribe: () => () => {},
    },
    unread: {
      activity: () => snapshot,
      subscribeActivity: () => () => {},
    },
    profiles: { ensure },
    media,
  } as unknown as RelaySession;
  render(
    <ChannelActivityPopover
      session={session}
      channelId="studio"
      channelName="Studio"
      trigger={<Button>Activity</Button>}
      agents={[first, second]}
      agentProfiles={
        new Map([[first, { name: "Buzzy", picture: "https://safe/avatar" }]])
      }
      onOpenWorkingAgent={openWorkingAgent}
      onOpenAgentActivity={openAgentActivity}
      onOpenThread={vi.fn()}
      onOpenMention={vi.fn()}
    />,
  );
  screen.getByRole("button", { name: "Activity" }).focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("region", { name: "Agents working now" }),
  ).toBeVisible();
  expect(
    screen.getByRole("heading", { level: 2, name: "Working now" }),
  ).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: /Open (thread|conversation) for/ }),
  ).toHaveLength(2);
  const agents = screen.getByRole("region", { name: "Agents working now" });
  expect(
    agents.querySelectorAll('[data-avatar-shape="squircle"]'),
  ).toHaveLength(2);
  expect(agents.querySelector("img")).toHaveAttribute(
    "src",
    "media:https://safe/avatar",
  );
  expect(agents.querySelectorAll(".buzz-avatar")[1]).toHaveTextContent(/\S/);
  expect(
    agents.querySelectorAll(".buzz-avatar")[1]?.querySelector("img"),
  ).toBeNull();
  expect(media).toHaveBeenCalledExactlyOnceWith("https://safe/avatar", "small");
  expect(ensure).not.toHaveBeenCalled();
  expect(screen.getByText(/2m \d+s/)).toBeVisible();
  expect(agents).toHaveTextContent("Working");
  expect(agents).not.toHaveTextContent("Open thread");
  const activityAction = screen.getByRole("button", {
    name: "View Buzzy activity",
  });
  expect(activityAction.closest(".navigation-item")).toBeNull();
  await user.click(activityAction);
  expect(openAgentActivity).toHaveBeenCalledExactlyOnceWith(
    "studio",
    first,
    messageId,
  );
  expect(openWorkingAgent).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "Activity" }).focus();
  await user.keyboard("{Enter}");
  await user.click(
    screen.getByRole("button", { name: "Open thread for Buzzy in Studio" }),
  );
  expect(openWorkingAgent).toHaveBeenCalledExactlyOnceWith(
    "studio",
    first,
    messageId,
  );
});

test("a typing agent still opens its profile activity while Agent Activity is off", async () => {
  const user = userEvent.setup();
  const agent = "a".repeat(64);
  const openWorkingAgent = vi.fn();
  const openAgentActivity = vi.fn();
  const unread = {
    channelId: "studio",
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  const session = {
    agentActivity: {
      snapshot: () => ({
        status: "disabled",
        records: [],
        turns: [],
        typing: [],
        trimmed: 0,
      }),
      subscribe: () => () => {},
    },
    unread: {
      activity: () => unread,
      subscribeActivity: () => () => {},
    },
    profiles: { ensure: vi.fn(async () => {}) },
    media: vi.fn(),
  } as unknown as RelaySession;
  render(
    <ChannelActivityPopover
      session={session}
      channelId="studio"
      channelName="Studio"
      trigger={<Button>Activity</Button>}
      agents={[agent]}
      agentProfiles={new Map([[agent, { name: "Buzzy" }]])}
      onOpenWorkingAgent={openWorkingAgent}
      onOpenAgentActivity={openAgentActivity}
      onOpenThread={vi.fn()}
      onOpenMention={vi.fn()}
    />,
  );
  screen.getByRole("button", { name: "Activity" }).focus();
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "View Buzzy activity" }));
  expect(openAgentActivity).toHaveBeenCalledExactlyOnceWith(
    "studio",
    agent,
    undefined,
  );
  screen.getByRole("button", { name: "Activity" }).focus();
  await user.keyboard("{Enter}");
  await user.click(
    screen.getByRole("button", {
      name: "Open conversation for Buzzy in Studio",
    }),
  );
  expect(openWorkingAgent).toHaveBeenCalledExactlyOnceWith(
    "studio",
    agent,
    undefined,
  );
});

test("a press while there is no activity does not block the hover preview once activity arrives", async () => {
  const user = userEvent.setup();
  let snapshot: ThreadActivitySnapshot = {
    channelId: "studio",
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  const listeners = new Set<() => void>();
  const session = {
    unread: {
      activity: () => snapshot,
      subscribeActivity: (_: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    profiles: {
      snapshot: () => new Map(),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentChoices: { snapshot: () => ({ identities: [] }) },
    inboxFeed: settledFeed,
  } as unknown as RelaySession;
  render(
    <ChannelActivityPopover
      session={session}
      channelId="studio"
      channelName="Studio"
      trigger={<Button>Activity</Button>}
      onOpenThread={vi.fn()}
      onOpenMention={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Activity" });
  await user.click(trigger);
  await user.unhover(trigger);
  snapshot = {
    ...snapshot,
    items: [
      {
        channelId: "studio",
        rootId: "thread",
        latestMessageId: "message",
        authorId: "alex",
        createdAt: 1,
        preview: "Please review the designs",
        unreadCount: 1,
      },
    ],
  };
  act(() => {
    for (const listener of listeners) listener();
  });
  await user.hover(trigger);
  expect(
    await screen.findByRole("dialog", { name: "Activity in Studio" }),
  ).toBeVisible();
});
