// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { setClockPreference } from "../../shared/clock-preference";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import type { RelaySession } from "../../features/relay/session";
import { type PeekFollow, SearchPreview } from "./SearchPreview";

stubAvatarBrowserApis();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const list = { channels: [] };
const noProfiles = new Map();

const event = (id: string, createdAt: number, content: string) => ({
  id,
  kind: 9,
  pubkey: "author",
  created_at: createdAt,
  content,
  tags: [["h", "channel"]],
});

it("holds room for a message's earlier neighbours, so the hit stays put as they load", async () => {
  vi.useFakeTimers();
  const pages: ((events: unknown[]) => void)[] = [];
  const profiles = new Map();
  const session = {
    readPage: vi.fn(
      () =>
        new Promise((resolve) => {
          pages.push((events) => resolve({ events }));
        }),
    ),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: () => Promise.resolve(),
    },
    channels: {
      get: () => ({}),
      list: () => list,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const lines = () => [...document.querySelectorAll(".search-peek-line")];
  const hitIndex = () =>
    lines().findIndex((line) => line.matches("[data-hit]"));
  render(
    <SearchPreview
      session={session}
      cache={new Map()}
      row={{
        key: "m:hit",
        label: "the hit",
        icon: ChatCircleIcon,
        run: () => {},
        peek: {
          kind: "message",
          channelId: "channel",
          messageId: "hit",
          createdAt: 1000,
          authorId: "author",
          text: "the hit",
          mentioned: { content: "the hit", mentions: [] },
        },
      }}
      tone="message"
      terms={[]}
      nameOf={() => "Author"}
      whereOf={() => "#channel"}
    />,
  );
  // Two hidden slots hold the earlier lines' room before any read.
  expect(hitIndex()).toBe(2);
  expect(lines()[0]).toHaveAttribute("aria-hidden", "true");
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  expect(pages).toHaveLength(2);
  expect(hitIndex()).toBe(2);
  await act(async () => {
    pages[0]?.([event("a", 900, "first"), event("b", 950, "second")]);
    pages[1]?.([event("c", 1010, "after")]);
  });
  // One message in the minute after: the next read looks an hour ahead.
  expect(session.readPage).toHaveBeenLastCalledWith(
    [expect.objectContaining({ since: 1000, until: 4600 })],
    expect.anything(),
  );
  await act(async () => {
    pages[2]?.([event("d", 2000, "later"), event("c", 1010, "after")]);
  });
  // The neighbours take the slots' place: the hit is still third.
  expect(document.querySelector("[data-slot]")).toBeNull();
  expect(hitIndex()).toBe(2);
  expect(lines().map((line) => line.textContent)).toEqual([
    expect.stringContaining("first"),
    expect.stringContaining("second"),
    expect.stringContaining("the hit"),
    expect.stringContaining("after"),
    expect.stringContaining("later"),
  ]);
});

function messagePreview(session: RelaySession, cache = new Map()) {
  return (
    <SearchPreview
      session={session}
      cache={cache}
      row={{
        key: "m:hit",
        label: "the hit",
        icon: ChatCircleIcon,
        run: () => {},
        peek: {
          kind: "message",
          channelId: "channel",
          messageId: "hit",
          createdAt: 1000,
          authorId: "author",
          text: "the hit",
          mentioned: { content: "the hit", mentions: [] },
        },
      }}
      tone="message"
      terms={[]}
      nameOf={() => "Author"}
      whereOf={() => "#channel"}
    />
  );
}

it("shows no later neighbours from a window cut off at a full page", async () => {
  vi.useFakeTimers();
  const replies = Array.from({ length: 20 }, (_, index) =>
    event(`r${index}`, 2000 + index, `reply ${index}`),
  );
  const pages = [[], [event("c", 1010, "after")], replies];
  const session = {
    readPage: vi.fn(async () => ({ events: pages.shift() ?? [] })),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => noProfiles,
      ensure: () => Promise.resolve(),
    },
    channels: {
      get: () => ({}),
      list: () => list,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  render(messagePreview(session));
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  // The hour's page is full, so its earliest replies may not be the next
  // ones: the preview keeps the minute's whole answer instead.
  expect(session.readPage).toHaveBeenCalledTimes(3);
  expect(
    [...document.querySelectorAll(".search-peek-line")].map(
      (line) => line.textContent,
    ),
  ).toEqual([
    expect.stringContaining("the hit"),
    expect.stringContaining("after"),
  ]);
});

it("drops a held preview once its channel can no longer be read", async () => {
  vi.useFakeTimers();
  let readable = true;
  let channels = { channels: [] };
  const listeners = new Set<() => void>();
  const readPage = vi.fn(async () => ({
    events: [event("a", 900, "private words")],
  }));
  const session = {
    readPage,
    profiles: {
      subscribe: () => () => {},
      snapshot: () => noProfiles,
      ensure: () => Promise.resolve(),
    },
    channels: {
      get: () => (readable ? {} : undefined),
      list: () => channels,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const cache = new Map();
  const { unmount } = render(messagePreview(session, cache));
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  expect(document.body).toHaveTextContent("private words");
  act(() => {
    // As the session does: losing access publishes a new channel list.
    readable = false;
    channels = { channels: [] };
    for (const listener of listeners) listener();
  });
  expect(document.body).not.toHaveTextContent("private words");
  expect(document.body).not.toHaveTextContent("the hit");
  // Highlighting it again shows nothing from the cache, without a read.
  unmount();
  const reads = readPage.mock.calls.length;
  render(messagePreview(session, cache));
  expect(document.body).not.toHaveTextContent("private words");
  expect(session.readPage).toHaveBeenCalledTimes(reads);
});

const plainSession = (readPage: unknown) =>
  ({
    readPage,
    profiles: {
      subscribe: () => () => {},
      snapshot: () => noProfiles,
      ensure: () => Promise.resolve(),
    },
    channels: {
      get: () => ({}),
      list: () => list,
      subscribeList: () => () => {},
    },
  }) as unknown as RelaySession;
const shownLines = () =>
  [...document.querySelectorAll(".search-peek-line")].map(
    (line) => line.textContent,
  );

it("shows a message sent in the hit's second once, on its side of the hit", async () => {
  vi.useFakeTimers();
  // Both reads include the hit's second, so both answer with it.
  const same = [event("hit", 1000, "the hit"), event("s", 1000, "same second")];
  const pages = [
    [event("a", 900, "before"), ...same],
    [...same, event("z", 1001, "next")],
  ];
  render(
    messagePreview(
      plainSession(vi.fn(async () => ({ events: pages.shift() ?? [] }))),
    ),
  );
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  expect(shownLines()).toEqual([
    expect.stringContaining("before"),
    expect.stringContaining("the hit"),
    expect.stringContaining("same second"),
    expect.stringContaining("next"),
  ]);
});

it("reads a preview again in a new search, not again in the same one", async () => {
  vi.useFakeTimers();
  const readPage = vi.fn(async () => ({ events: [] }));
  const session = plainSession(readPage);
  const settle = () =>
    act(async () => {
      vi.advanceTimersByTime(150);
    });
  const search = new Map();
  const first = render(messagePreview(session, search));
  await settle();
  const once = readPage.mock.calls.length;
  expect(once).toBeGreaterThan(0);
  first.unmount();
  // The same search returns to the row: its lines are held.
  const again = render(messagePreview(session, search));
  await settle();
  expect(readPage).toHaveBeenCalledTimes(once);
  again.unmount();
  // Search opened again makes a new cache, so later activity shows.
  render(messagePreview(session, new Map()));
  await settle();
  expect(readPage.mock.calls.length).toBeGreaterThan(once);
});

it("reads for a highlight nobody moved only once typing pauses and results settle", async () => {
  vi.useFakeTimers();
  const profiles = new Map();
  const session = {
    readPage: vi.fn(() => Promise.resolve({ events: [] })),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: () => Promise.resolve(),
    },
    channels: {
      get: () => ({}),
      list: () => list,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const cache = new Map();
  const preview = (follow: PeekFollow) => (
    <SearchPreview
      session={session}
      cache={cache}
      row={{
        key: "channel:design",
        label: "design",
        icon: ChatCircleIcon,
        run: () => {},
        peek: { kind: "channel", channelId: "design" },
      }}
      tone="channel"
      terms={[]}
      nameOf={() => "Author"}
      whereOf={() => "#design"}
      follow={follow}
    />
  );
  const wait = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });
  // Each key restarts the pause, so a row first while someone types is not
  // read even when typing is slower than the pause on a moved highlight.
  const { rerender } = render(preview({ text: "d", busy: false }));
  await wait(250);
  rerender(preview({ text: "de", busy: false }));
  await wait(250);
  expect(session.readPage).not.toHaveBeenCalled();
  // Results that may lead are still arriving.
  rerender(preview({ text: "des", busy: true }));
  await wait(1000);
  expect(session.readPage).not.toHaveBeenCalled();
  rerender(preview({ text: "des", busy: false }));
  await wait(299);
  expect(session.readPage).not.toHaveBeenCalled();
  await wait(1);
  expect(session.readPage).toHaveBeenCalledTimes(1);
});

it.each([
  ["ordinary prose", "Find the needle here", "needle"],
  ["a Solo link", "buzz://channel/channel", "buzz"],
  [
    "prose with a Solo link",
    "See buzz://channel/channel for release notes",
    "release",
  ],
  ["a time-prefixed comment", "⏱ 0:42 — Check the release", "release"],
])(
  "keeps %s and highlights intact with live timestamp preferences",
  async (_case, content, term) => {
    vi.useFakeTimers();
    const noon = new Date(2026, 10, 13, 12, 0, 0);
    vi.setSystemTime(noon);
    const profiles = new Map();
    const channel = { id: "channel", name: "Solo", channelType: "solo" };
    const list = { status: "ready", channels: [channel] };
    const session = {
      viewer: "viewer",
      media: () => undefined,
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: async () => {},
      },
      channels: {
        get: () => channel,
        list: () => list,
        subscribeList: () => () => {},
      },
      readPage: async () => ({
        events: [
          {
            id: "message",
            kind: 9,
            pubkey: "author",
            created_at: noon.getTime() / 1000,
            content,
            tags: [["h", "channel"]],
          },
        ],
      }),
    } as unknown as RelaySession;
    try {
      setClockPreference({
        hourCycle: "h12",
        seconds: false,
        messageTimestamps: "show",
      });
      render(
        <SearchPreview
          session={session}
          cache={new Map()}
          row={{
            key: "channel",
            label: "Solo",
            icon: ChatCircleIcon,
            peek: { kind: "channel", channelId: "channel" },
            run() {},
          }}
          tone="chat"
          terms={[term]}
          nameOf={() => "Alex"}
          whereOf={() => "Solo"}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(screen.getByText(/^12:00\s?PM$/)).toBeVisible();
      expect(screen.getByText(term, { selector: "mark" })).toBeVisible();
      expect(document.querySelector(".search-peek-text")?.textContent).toBe(
        content,
      );
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      if (content.startsWith("⏱")) {
        expect(
          screen.getByRole("listitem").textContent?.match(/0:42/g),
        ).toHaveLength(1);
      }
      act(() => setClockPreference({ messageTimestamps: "hide-solo" }));
      expect(screen.queryByText(/^12:00\s?PM$/)).not.toBeInTheDocument();
      expect(document.querySelector("time")).toHaveTextContent("2026");
      act(() => setClockPreference({ messageTimestamps: "show" }));
      expect(screen.getByText(/^12:00\s?PM$/)).toBeVisible();
    } finally {
      cleanup();
      setClockPreference({
        hourCycle: "system",
        seconds: false,
        messageTimestamps: "show",
      });
      vi.useRealTimers();
    }
  },
);

it("shows each line's resolved mentions as chips, keeping the hit's highlight", async () => {
  vi.useFakeTimers();
  const tomb = "c".repeat(64);
  const profiles = new Map([[tomb, { name: "tomb" }]]);
  const pages = [
    [
      {
        ...event("a", 900, "ping @tomb"),
        tags: [
          ["h", "channel"],
          ["p", tomb],
        ],
      },
    ],
    [],
  ];
  const session = {
    readPage: vi.fn(async () => ({ events: pages.shift() ?? [] })),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: vi.fn(() => Promise.resolve()),
    },
    channels: {
      get: () => ({}),
      list: () => list,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  render(
    <SearchPreview
      session={session}
      cache={new Map()}
      row={{
        key: "m:hit",
        label: "@tomb the hit",
        icon: ChatCircleIcon,
        run: () => {},
        peek: {
          kind: "message",
          channelId: "channel",
          messageId: "hit",
          createdAt: 1000,
          authorId: "author",
          text: "@tomb the hit",
          mentioned: { content: "@tomb the hit", mentions: [tomb] },
        },
      }}
      tone="message"
      terms={["hit"]}
      nameOf={() => "Author"}
      whereOf={() => "#channel"}
    />,
  );
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  const lines = [...document.querySelectorAll(".search-peek-text")];
  expect(lines.map((line) => line.textContent)).toEqual([
    "ping tomb",
    "tomb the hit",
  ]);
  expect(
    lines.map((line) => line.querySelector("[data-mention-kind]")?.textContent),
  ).toEqual(["tomb", "tomb"]);
  expect(lines[1]?.querySelector("mark.search-match")).toHaveTextContent("hit");
  expect(session.profiles.ensure).toHaveBeenCalledWith(
    expect.arrayContaining(["author", tomb]),
    "background",
  );
});
