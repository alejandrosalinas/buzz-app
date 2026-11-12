// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import type { PageNavigation } from "../../features/navigation/service";
import type { OpenTarget } from "../../features/navigation/targets";
import type { Panels } from "../../features/panels/service";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import type { ReadTransport } from "../../features/relay/transport";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  type Key,
} from "../../features/relay/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChannelsPage } from "./ChannelsPage";

// Open in channel: whether the page holds its channel list while it seeks the
// thread's root, and what it asks the list to reveal. The real body renders;
// each render's props are recorded. Browser journeys own the reveal itself.
type Body = ComponentProps<typeof import("./ChannelBody").ChannelBody> & {
  channelId: string;
};
const bodies = vi.hoisted(() => [] as Body[]);
vi.mock("./ChannelBody", async (original) => {
  const actual = await original<typeof import("./ChannelBody")>();
  const { useConversation } = await import(
    "../../features/conversation/Conversation"
  );
  return {
    ...actual,
    ChannelBody(props: ComponentProps<typeof actual.ChannelBody>) {
      bodies.push({ ...props, channelId: useConversation().channelId });
      return <actual.ChannelBody {...props} />;
    },
  };
});

composerDOMFixture();

let fixture: {
  viewer: Key;
  authority: Key;
  root: RelayEvent;
  reply: RelayEvent;
  /** Top-level rows after the root: more than the head page holds. */
  newer: RelayEvent[];
  channels: RelayEvent[];
};
beforeAll(() => {
  const viewer = keypair(),
    authority = keypair(),
    peer = keypair();
  const root = message(peer, "alpha", "Thread root", 1_700_000_100);
  fixture = {
    viewer,
    authority,
    root,
    reply: message(peer, "alpha", "Thread reply", 1_700_000_110, [
      ["e", root.id, "", "reply"],
    ]),
    newer: Array.from({ length: 25 }, (_, index) =>
      message(peer, "alpha", `Newer ${index}`, 1_700_000_200 + index),
    ),
    channels: ["alpha", "beta", "gamma", "delta"].flatMap((id) => [
      roster(authority, id, [viewer.pubkey]),
      metadata(authority, id, id, undefined, [["t", "stream"]]),
    ]),
  };
});
const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  bodies.length = 0;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

/** The relay's window pages: newest first, `limit` rows below the cursor. */
function page(filter: ReadFilter, history: readonly RelayEvent[]) {
  const channelId = filter["#h"]?.[0] ?? "";
  const rows = history
    .filter((event) => matchesEvent(event, filter))
    .sort((a, b) => b.created_at - a.created_at);
  const served = rows.slice(0, filter.limit);
  const last = served.at(-1);
  const more = rows.length > served.length;
  return [
    ...served,
    bounds(
      fixture.authority,
      channelId,
      filter.until === undefined
        ? "head"
        : `${filter.until}:${filter.before_id}`,
      {
        has_more: more,
        next_cursor:
          more && last ? { created_at: last.created_at, id: last.id } : null,
      },
    ),
  ];
}

/** Channels with alpha's thread root beyond its head page, or, with
 * `root: false`, absent from its history. Alpha's older pages wait for
 * `release()`. A `cached` session has only alpha's saved head until
 * `connect()`. */
async function channelsPage({ root = true, cached = false } = {}) {
  const { viewer, authority, reply, newer, channels } = fixture;
  const alpha = [...(root ? [fixture.root] : []), reply, ...newer];
  const held: ((error?: Error) => void)[] = [];
  const transport: ReadTransport = {
    viewer: viewer.pubkey,
    relayAuthor: authority.pubkey,
    media: () => undefined,
    query: async (filters) => {
      const window = filters.find((filter) => filter.top_level);
      if (!window)
        return [...channels, ...alpha].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      const channelId = window["#h"]?.[0];
      if (channelId === "alpha" && window.until !== undefined)
        await new Promise<void>((resolve, reject) =>
          held.push((error) => (error ? reject(error) : resolve())),
        );
      return page(window, channelId === "alpha" ? alpha : []);
    },
  };
  const outboxStorage = { load: () => [], save: () => {} };
  const owner = createRelaySession(transport, {
    outboxStorage,
    ...(cached && {
      prepared: true,
      cachedOnly: true,
      persistence: {
        readStartup: async () => ({
          discovery: {
            savedAt: Date.now(),
            relayAuthor: authority.pubkey,
            events: channels,
          },
        }),
        read: async () => [
          {
            channelId: "alpha",
            savedAt: Date.now(),
            events: page({ "#h": ["alpha"], limit: 20 }, alpha),
            profiles: [],
          },
        ],
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close() {},
      },
    }),
  });
  owners.push(owner);
  if (cached) await owner.restore();
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  const scope = `https://relay.test:${viewer.pubkey}`;
  let snapshot: RelaySnapshot = {
    status: cached ? "connecting" : "ready",
    ...(cached && { cached: true as const }),
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const none: ReturnType<Panels["snapshot"]> = [];
  const panels: Panels = {
    snapshot: () => none,
    subscribe: () => () => {},
    resolve: () => undefined,
    register() {},
    requestOpen: () => false,
    handleOpenRequests: () => () => {},
  };
  const navigator = createNavigationController(
    createMemoryHistory(),
  ).navigation;
  const target = (
    channelId: string,
    extra: Partial<Extract<OpenTarget, { kind: "conversation" }>> = {},
  ): OpenTarget => ({
    version: 1,
    kind: "conversation",
    scope: { viewer: viewer.pubkey, communityOrigin: "https://relay.test" },
    channelId,
    ...extra,
  });
  const attempts = new Map<PageNavigation, AbortController>();
  /** One attempt at a visit; Back to an entry is a new attempt at its id. */
  const visit = (
    to: OpenTarget,
    entryId: string,
    traversal = false,
  ): PageNavigation => {
    const lifetime = new AbortController();
    const navigation: PageNavigation = {
      entryId,
      target: to,
      signal: lifetime.signal,
      ...(traversal && { traversal: true as const }),
      position: () => undefined,
      savePosition() {},
      forSession: () => navigation,
      passThrough: () => () => {},
      resolve: () => true,
      complete: () => true,
    };
    attempts.set(navigation, lifetime);
    return navigation;
  };
  const view = (navigation: PageNavigation) => (
    <ToastProvider>
      <ChannelsPage
        relay={relay}
        panels={panels}
        navigator={navigator}
        navigation={navigation}
      />
    </ToastProvider>
  );
  let shown: PageNavigation | undefined;
  let rerender: ((ui: ReactElement) => void) | undefined;
  return {
    session: owner.session,
    held,
    /** Open in channel from the thread's tab. */
    inChannel: (extra: Parameters<typeof target>[1] = {}) =>
      target("alpha", {
        messageId: reply.id,
        threadRootId: fixture.root.id,
        context: "channel",
        ...extra,
      }),
    target,
    visit,
    /** Show this attempt, revoking the one it replaces. */
    go(navigation: PageNavigation) {
      if (shown) attempts.get(shown)?.abort();
      if (rerender) rerender(view(navigation));
      else ({ rerender } = render(view(navigation)));
      shown = navigation;
    },
    /** Hand off to a live session in the same generation, as reconnecting
     * does once it has loaded the list and alpha's head. */
    async connect() {
      const live = createRelaySession(transport, { outboxStorage });
      owners.push(live);
      live.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(live.session.channels.list().status).toBe("ready"),
      );
      live.session.channels.ensure("alpha");
      await vi.waitFor(() =>
        expect(live.session.channels.window("alpha").status).toBe("ready"),
      );
      const { cached: _cached, ...connecting } = snapshot;
      snapshot = { ...connecting, status: "ready", session: live.session };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    /** Answer the oldest held older-page read, or fail it with `error`. */
    async release(error?: Error) {
      const next = held.shift();
      if (!next) throw new Error("No older page read is waiting");
      await act(async () => {
        next(error);
        await flush();
      });
    },
  };
}
const renders = (channelId: string) =>
  bodies.filter((body) => body.channelId === channelId);
const latest = (channelId: string) => renders(channelId).at(-1);
const timeline = (channelId: string) =>
  document.querySelector(`[data-channel-timeline="${channelId}"]`);

it("holds the list from the visit's start, then reveals the root beside the thread", async () => {
  const h = await channelsPage();
  const first = h.visit(h.inChannel(), "visit");
  h.go(first);
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  try {
    // The head is ready, but it lacks the root: the list never mounted there.
    expect(h.session.channels.window("alpha").status).toBe("ready");
    expect(renders("alpha").length).toBeGreaterThan(0);
    expect(renders("alpha").every((body) => body.holding)).toBe(true);
    expect(timeline("alpha")).toBeNull();
  } finally {
    await h.release();
  }
  await vi.waitFor(() =>
    expect(latest("alpha")).toMatchObject({
      holding: false,
      inlineTarget: {
        messageId: fixture.root.id,
        signal: first.signal,
        focus: false,
      },
    }),
  );
});

it("opens the timeline at its usual place when the root is not in its history", async () => {
  const h = await channelsPage({ root: false });
  h.go(h.visit(h.inChannel(), "visit"));
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  try {
    expect(latest("alpha")?.holding).toBe(true);
  } finally {
    await h.release();
  }
  await vi.waitFor(() => expect(latest("alpha")?.holding).toBe(false));
  expect(latest("alpha")?.inlineTarget).toBeUndefined();
  expect(timeline("alpha")).not.toBeNull();
});

it("opens the timeline at its usual place when an older page fails", async () => {
  const h = await channelsPage();
  h.go(h.visit(h.inChannel(), "visit"));
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  try {
    expect(latest("alpha")?.holding).toBe(true);
  } finally {
    await h.release(new Error("Relay unavailable"));
  }
  await vi.waitFor(() => expect(latest("alpha")?.holding).toBe(false));
  expect(h.session.channels.window("alpha").error).toBeDefined();
  expect(latest("alpha")?.inlineTarget).toBeUndefined();
  expect(timeline("alpha")).not.toBeNull();
});

it("shows a cached session's rows, then seeks beside them once it connects", async () => {
  const h = await channelsPage({ cached: true });
  const first = h.visit(h.inChannel(), "visit");
  h.go(first);
  // Cached rows decide nothing, so the list shows them without seeking.
  await vi.waitFor(() => expect(timeline("alpha")).not.toBeNull());
  expect(h.session.channels.window("alpha").freshness).toBe("cached");
  await act(flush);
  expect(renders("alpha").some((body) => body.holding)).toBe(false);
  expect(latest("alpha")?.inlineTarget).toBeUndefined();
  expect(h.held).toHaveLength(0);
  const list = timeline("alpha");
  const shown = renders("alpha").length;
  await h.connect();
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  await h.release();
  await vi.waitFor(() =>
    expect(latest("alpha")?.inlineTarget).toMatchObject({
      messageId: fixture.root.id,
      signal: first.signal,
      focus: false,
    }),
  );
  expect(
    renders("alpha")
      .slice(shown)
      .some((body) => body.holding),
  ).toBe(false);
  expect(timeline("alpha")).toBe(list);
});

it("seeks nothing and holds nothing under Members", async () => {
  const h = await channelsPage();
  h.go(h.visit(h.inChannel({ panel: "members" }), "visit"));
  await vi.waitFor(() => expect(timeline("alpha")).not.toBeNull());
  await act(flush);
  expect(renders("alpha").some((body) => body.holding)).toBe(false);
  expect(latest("alpha")?.inlineTarget).toBeUndefined();
  expect(h.held).toHaveLength(0);
});

it("closing Members reveals the root again in the list already shown", async () => {
  const h = await channelsPage();
  const first = h.visit(h.inChannel(), "visit");
  h.go(first);
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  await h.release();
  await vi.waitFor(() =>
    expect(latest("alpha")?.inlineTarget?.signal).toBe(first.signal),
  );
  const list = timeline("alpha");
  expect(list).not.toBeNull();
  const shown = renders("alpha").length;
  h.go(h.visit(h.inChannel({ panel: "members" }), "members"));
  await vi.waitFor(() => expect(latest("alpha")?.inlineTarget).toBeUndefined());
  // Closing Members returns to the visit's entry, a new attempt at it.
  const closed = h.visit(h.inChannel(), "visit", true);
  h.go(closed);
  await vi.waitFor(() =>
    expect(latest("alpha")?.inlineTarget).toMatchObject({
      messageId: fixture.root.id,
      signal: closed.signal,
    }),
  );
  expect(
    renders("alpha")
      .slice(shown)
      .some((body) => body.holding),
  ).toBe(false);
  expect(timeline("alpha")).toBe(list);
  expect(h.held).toHaveLength(0);
});

it("a channel the reader moves to during the seek is neither held nor targeted", async () => {
  const h = await channelsPage();
  h.go(h.visit(h.inChannel(), "visit"));
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  try {
    h.go(h.visit(h.target("beta"), "beta"));
    await vi.waitFor(() => expect(timeline("beta")).not.toBeNull());
  } finally {
    await h.release();
  }
  await vi.waitFor(() =>
    expect(
      h.session.channels
        .window("alpha")
        .rows.some((row) => row.id === fixture.root.id),
    ).toBe(true),
  );
  await act(flush);
  expect(renders("beta").some((body) => body.holding)).toBe(false);
  expect(renders("beta").some((body) => body.inlineTarget)).toBe(false);
});

it("another Open in channel during the seek reveals the root for itself", async () => {
  const h = await channelsPage();
  const first = h.visit(h.inChannel(), "visit");
  h.go(first);
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  const second = h.visit(h.inChannel(), "again");
  try {
    h.go(second);
    expect(latest("alpha")?.holding).toBe(true);
    // The read in flight serves the new visit too.
    expect(h.held).toHaveLength(1);
  } finally {
    await h.release();
  }
  await vi.waitFor(() =>
    expect(latest("alpha")?.inlineTarget).toMatchObject({
      messageId: fixture.root.id,
      signal: second.signal,
    }),
  );
  expect(
    renders("alpha").some((body) => body.inlineTarget?.signal === first.signal),
  ).toBe(false);
});

it("Back to the visit seeks again once the channel has dropped the pages it read", async () => {
  const h = await channelsPage();
  h.go(h.visit(h.inChannel(), "visit"));
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  await h.release();
  await vi.waitFor(() => expect(latest("alpha")?.inlineTarget).toBeDefined());
  // Three other channels' windows push alpha's out of the store.
  for (const id of ["beta", "gamma", "delta"]) {
    h.go(h.visit(h.target(id), id));
    await vi.waitFor(() => expect(timeline(id)).not.toBeNull());
  }
  expect(h.session.channels.window("alpha").status).toBe("idle");
  const back = h.visit(h.inChannel(), "visit", true);
  h.go(back);
  expect(latest("alpha")).toMatchObject({ holding: true });
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  try {
    expect(latest("alpha")?.holding).toBe(true);
  } finally {
    await h.release();
  }
  await vi.waitFor(() =>
    expect(latest("alpha")).toMatchObject({
      holding: false,
      inlineTarget: { messageId: fixture.root.id, signal: back.signal },
    }),
  );
});
