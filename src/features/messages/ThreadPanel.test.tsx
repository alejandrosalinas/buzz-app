// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ThreadPanel, type ThreadPanelProps } from "./ThreadPanel";
import { selectNewestMessage } from "./message-selection";
import type { MessageRowProps } from "./MessageRow";
import type { MessageComposerProps } from "./MessageComposer";
import { createAgentLibrary } from "../agents/library";
import { createRelaySession, type RelaySession } from "../relay/session";
import type { RelayEvent } from "../relay/events";
import type { ReadStateSigning } from "../relay/read-state-host";
import { readJournal, type ReadJournal } from "../relay/read-state-storage";
import { keypair, message, metadata, roster } from "../relay/testing";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Test the production Node codec with disposable identities.
} from "../../../browser-host/read-state.mjs";
import type { PageNavigation } from "../navigation/service";
import type { JsonValue } from "../navigation/targets";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import type {
  ChannelList,
  ChannelMessage,
  ChannelSummary,
} from "../relay/contracts";
import { formatPublicKey } from "../../shared/identity/public-key";

// Real React owns effects, refs and subscriptions. Only independent child UI is
// reduced here; MessageRow/MessageComposer retain their own mounted suites.
// Activity rendering/subscriptions have their own mounted integration suite.
vi.mock("./TypingIndicator", () => ({
  TypingIndicator: () => null,
  useLiveConversationAgents: () => [],
}));
vi.mock("../relay/react", () => {
  const profiles = new Map();
  return { useProfileGeneration: () => 0, useRowProfiles: () => profiles };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({
    row,
    scope,
    retry,
    onOpenMediaReview,
    onMediaPlayback,
  }: MessageRowProps) => (
    <article data-message-id={row.id} data-scope={scope}>
      <span>{row.content}</span>
      {row.attachments
        .filter((attachment) => attachment.kind === "video")
        .flatMap((attachment) =>
          [0, 42].map((seconds) => (
            <button
              key={`${attachment.url}:${seconds}`}
              type="button"
              onClick={() =>
                onMediaPlayback?.({
                  attachmentUrl: attachment.url,
                  seconds,
                })
              }
            >
              Report playback {seconds}
            </button>
          )),
        )}
      <button type="button" onClick={() => retry?.(row.id)}>
        Retry {row.id}
      </button>
      {row.attachments.map((attachment) => (
        <button
          key={attachment.url}
          type="button"
          onClick={() => onOpenMediaReview?.(row.id, attachment, 0)}
        >
          Open {row.content}
        </button>
      ))}
    </article>
  ),
}));
vi.mock("./MessageComposer", () => ({
  MessageComposer: ({
    threadRootId,
    channelId,
    scope,
    onSend,
    ownSoloConversation,
    disabled,
    placeholder,
    focusRequest,
    threadSeed,
  }: MessageComposerProps) => (
    <section
      aria-label="Composer"
      data-root={threadRootId}
      data-seed={threadSeed?.mentions.join(",")}
      data-channel={channelId}
      data-scope={scope}
      data-own-solo={ownSoloConversation}
      data-disabled={disabled}
      data-placeholder={placeholder}
      data-focus-request={focusRequest}
    >
      <button type="button" onClick={() => onSend?.("own-reply")}>
        Send fixture reply
      </button>
    </section>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
});
const row: ChannelMessage = {
  id: "a".repeat(64),
  channelId: "channel",
  authorId: "b".repeat(64),
  content: "root",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 2,
};
const viewer = "c".repeat(64);
function ordinaryNavigation() {
  return {
    entryId: "thread-visit",
    target: {
      version: 1,
      kind: "conversation",
      channelId: "channel",
      messageId: row.id,
      threadRootId: row.id,
      scope: {
        viewer: row.authorId,
        communityOrigin: "https://fixture.invalid",
      },
    },
    signal: new AbortController().signal,
    complete: vi.fn<PageNavigation["complete"]>(() => true),
    resolve: vi.fn(() => true),
    forSession: vi.fn<PageNavigation["forSession"]>(),
    position: vi.fn<PageNavigation["position"]>(),
    savePosition: vi.fn<PageNavigation["savePosition"]>(),
    passThrough: () => () => {},
  } satisfies PageNavigation;
}
function messagesHarness(
  navigation?: PageNavigation,
  onOpenMediaReview?: ThreadPanelProps["onOpenMediaReview"],
) {
  const snapshot: { -readonly [K in keyof ThreadSnapshot]: ThreadSnapshot[K] } =
    {
      status: "ready",
      root: row,
      replies: [],
      error: undefined,
      canLoadMore: false,
      limited: false,
    };
  let published: ThreadSnapshot = { ...snapshot };
  const views: (ThreadView & {
    listeners: Set<() => void>;
    refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
    loadMore: ReturnType<typeof vi.fn<() => Promise<void>>>;
    retarget: ReturnType<typeof vi.fn<ThreadView["retarget"]>>;
    dispose: ReturnType<typeof vi.fn>;
  })[] = [];
  const makeView = () => {
    const listeners = new Set<() => void>();
    const view = {
      snapshot: () => published,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      refresh: vi.fn(async () => {}),
      loadMore: vi.fn(async () => {}),
      retarget: vi.fn<ThreadView["retarget"]>(async () => "selected"),
      dispose: vi.fn(),
      listeners,
    };
    views.push(view);
    return view;
  };
  const first = makeView();
  const thread = vi
    .fn()
    .mockImplementationOnce(() => first)
    .mockImplementation(makeView);
  const ensure = vi.fn(async () => {});
  const profiles = new Map();
  const session = {
    viewer,
    thread,
    profiles: { ensure, snapshot: () => profiles, subscribe: () => () => {} },
    agentChoices: createAgentLibrary(undefined).queries,
    messages: { retry: vi.fn() },
    media: () => undefined,
    unread: {
      sync: () => ({ capability: "unsupported" }),
      snapshot: () => undefined,
      subscribe: () => () => {},
      attention: () => ({ unread: false }),
    },
  } as unknown as RelaySession;
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const resizeObservers = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        resizeObservers.add(this.callback);
      }
      disconnect() {
        resizeObservers.delete(this.callback);
      }
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  // Controlled dimensions exercise positioning policy, not browser layout.
  // Install before mount so the first real layout effect sees the same geometry.
  let height = 4000,
    top = 0;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    () => height,
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => top,
    set(value: number) {
      top = Math.max(0, Math.min(value, height - 600));
    },
  });
  const close = vi.fn(),
    bubble = vi.fn();
  const props = {
    active: true,
    session,
    scope: "scope",
    channelName: "General",
    channelId: "channel",
    messageId: row.id,
    navigation,
    close,
    onOpenLink: () => false,
    ...(onOpenMediaReview ? { onOpenMediaReview } : {}),
  };
  let mounted: ReturnType<typeof render> | undefined;
  let element: HTMLElement;
  return {
    snapshot,
    session,
    views,
    thread,
    ensure,
    close,
    bubble,
    props,
    get view() {
      return views.at(-1) ?? first;
    },
    get listeners() {
      return (views.at(-1) ?? first).listeners;
    },
    get element() {
      return element;
    },
    render(strict = false) {
      act(() => {
        published = { ...snapshot };
        for (const view of views)
          for (const listener of view.listeners) listener();
      });
      if (!mounted) {
        const tree = (
          <div role="application" onKeyDown={bubble}>
            <ThreadPanel {...props} />
          </div>
        );
        mounted = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
      }
      element =
        screen.queryByRole("region", { name: "Thread messages" }) ?? element;
      return element;
    },
    rerenderProps() {
      mounted?.rerender(
        <div role="application" onKeyDown={bubble}>
          <ThreadPanel {...props} />
        </div>,
      );
    },
    resize(value: number) {
      height = value;
    },
    deliverResize() {
      act(() => {
        for (const callback of resizeObservers) callback();
      });
    },
    scroll(value: number) {
      element.scrollTop = value;
      fireEvent.scroll(element);
    },
    unmount() {
      mounted?.unmount();
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
    },
  };
}
it("allocates only after commit and disposes distinct owned views under StrictMode", () => {
  const h = messagesHarness();
  renderToString(<ThreadPanel {...h.props} />);
  expect(h.thread).not.toHaveBeenCalled();
  h.render(true);
  expect(h.thread.mock.calls).toEqual([
    ["channel", row.id],
    ["channel", row.id],
  ]);
  expect(h.views[0]).not.toBe(h.views[1]);
  expect(h.views[0]?.dispose).toHaveBeenCalledOnce();
  expect(h.view.dispose).not.toHaveBeenCalled();
  for (const view of h.views) expect(view.refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
  fireEvent.keyDown(screen.getByRole("complementary", { name: "Thread" }), {
    key: "Escape",
  });
  expect(h.close).toHaveBeenCalledTimes(2);
  expect(h.bubble).not.toHaveBeenCalled();
  h.unmount();
  for (const view of h.views) {
    expect(view.dispose).toHaveBeenCalledOnce();
    expect(view.listeners.size).toBe(0);
  }
});
it("registers its messages for keyboard selection and leaves an Escape the selection handled open", () => {
  const h = messagesHarness();
  h.render();
  const list = screen.getByRole("region", { name: "Thread messages" });
  let selectedNewest = false;
  act(() => {
    selectedNewest = selectNewestMessage(list);
  });
  expect(selectedNewest).toBe(true);
  const selected = document.activeElement;
  expect(selected?.closest("[data-message-id]")).not.toBeNull();
  // Shift+Escape is "Mark all as read", not a dismissal.
  fireEvent.keyDown(selected as Element, { key: "Escape", shiftKey: true });
  expect(h.close).not.toHaveBeenCalled();
  // The mocked composer has no focus target; stand in for selection's handling.
  const handled = (event: Event) => event.preventDefault();
  selected?.addEventListener("keydown", handled);
  fireEvent.keyDown(selected as Element, { key: "Escape" });
  expect(h.close).not.toHaveBeenCalled();
  selected?.removeEventListener("keydown", handled);
  fireEvent.keyDown(selected as Element, { key: "Escape" });
  expect(h.close).toHaveBeenCalledOnce();
  h.unmount();
});
it("allocation failure exposes an effective retry rather than leaving a spinner", () => {
  const h = messagesHarness();
  h.thread
    .mockReset()
    .mockImplementationOnce(() => {
      throw new Error("capacity");
    })
    .mockReturnValue(h.view);
  h.render();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This thread didn’t load.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("root")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(h.thread).toHaveBeenCalledTimes(2);
  expect(h.view.refresh).toHaveBeenCalledOnce();
});
it("loads history automatically with error-only retry and no routine history controls", () => {
  const h = messagesHarness();
  h.render();
  expect(h.ensure).toHaveBeenCalledExactlyOnceWith(
    [row.authorId],
    "background",
  );
  for (const name of ["Refresh thread", "Try again", "Load more replies"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByText(/Existing history may be incomplete/)).toBeNull();
  expect(h.view.loadMore).not.toHaveBeenCalled();
  h.snapshot.canLoadMore = true;
  h.render();
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  h.snapshot.status = "loading";
  h.render();
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  h.snapshot.status = "error";
  h.snapshot.error = "offline";
  h.render();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  expect(h.view.refresh).toHaveBeenCalledTimes(2);
  h.snapshot.status = "ready";
  h.snapshot.error = undefined;
  h.snapshot.canLoadMore = false;
  h.render();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  h.snapshot.limited = true;
  h.render();
  expect(screen.getByText("Thread history limit reached.")).toBeVisible();
  h.snapshot.status = "error";
  h.snapshot.error = "Thread view exceeded its memory limit.";
  h.render();
  expect(screen.queryByText(/appear automatically/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(h.view.refresh).toHaveBeenCalledTimes(3);
  expect(h.ensure).toHaveBeenCalledOnce();
});
it("keeps initial rows pending until positioned, exposes errors, and lets reading interrupt loading", () => {
  const h = messagesHarness(ordinaryNavigation());
  h.snapshot.canLoadMore = true;
  h.render();
  expect(h.element).toHaveAttribute("data-positioning");
  expect(h.element.querySelector("[data-thread-rows]")).toHaveAttribute(
    "inert",
  );
  h.snapshot.status = "error";
  h.snapshot.error = "History unavailable";
  h.render();
  expect(h.element).not.toHaveAttribute("data-positioning");
  expect(
    within(h.element).getByRole("button", { name: "Try again" }),
  ).toBeVisible();
  h.snapshot.status = "loading";
  h.snapshot.error = undefined;
  h.render();
  expect(h.element).toHaveAttribute("data-positioning");
  fireEvent.wheel(h.element);
  expect(h.element).not.toHaveAttribute("data-positioning");
  h.scroll(500);
  h.snapshot.status = "ready";
  h.snapshot.canLoadMore = false;
  h.render();
  expect(h.element.scrollTop).toBe(500);
});
it("starts a single older page after scrolling through 80% of loaded history", () => {
  const h = messagesHarness();
  h.snapshot.direction = "older";
  h.snapshot.canLoadMore = true;
  const section = h.render();
  fireEvent.wheel(section, { deltaY: -1 });
  h.scroll(681); // 20% of the 3,400px scrollable range is 680px.
  expect(h.view.loadMore).not.toHaveBeenCalled();
  h.scroll(680);
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  h.scroll(0);
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  h.snapshot.status = "loading";
  h.render();
  h.scroll(0);
  expect(h.view.loadMore).toHaveBeenCalledOnce();
});
it("keeps initial thread loading until available content has been positioned", () => {
  const h = messagesHarness();
  h.snapshot.status = "loading";
  h.snapshot.root = undefined;
  const section = h.render();
  expect(within(section).getByText("Loading thread…")).toBeVisible();
  expect(
    within(section).queryByText("Original message unavailable."),
  ).toBeNull();
  h.snapshot.root = row;
  h.render();
  expect(section).toHaveAttribute("data-positioning");
  expect(within(section).getByText("Loading thread…")).toBeVisible();
  h.snapshot.status = "ready";
  h.render();
  expect(section).not.toHaveAttribute("data-positioning");
  expect(within(section).getByText("root")).toBeVisible();
  expect(within(section).queryByText("Loading thread…")).toBeNull();
});
it.each([
  ["waits", undefined, "1"],
  ["clicks elsewhere first", "pointerDown", "0"],
  ["types elsewhere first", "keyDown", "0"],
] as const)(
  "a focus request reaches the reply box once its root loads, unless the user %s",
  (_, action, delivered) => {
    const h = messagesHarness();
    h.snapshot.status = "loading";
    h.snapshot.root = undefined;
    Object.assign(h.props, { focusRequest: 1 });
    h.render();
    expect(screen.queryByRole("region", { name: "Composer" })).toBeNull();
    if (action) fireEvent[action](document.body, { key: "a" });
    h.snapshot.root = row;
    h.snapshot.status = "ready";
    h.render();
    expect(screen.getByRole("region", { name: "Composer" })).toHaveAttribute(
      "data-focus-request",
      delivered,
    );
  },
);
it("holds seeded rows behind the loader until the first page, and unread until the legacy walk settles", async () => {
  vi.useFakeTimers();
  const h = messagesHarness(ordinaryNavigation());
  h.resize(600);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  const observe = vi.fn(async () => {});
  const reading = vi.fn(() => ({
    view: vi.fn(),
    observe,
    catchUp: vi.fn(async () => {}),
    dispose: vi.fn(),
  }));
  Object.assign(h.session.unread, {
    sync: () => ({ capability: "frontier-sync" }),
    reading,
  });
  h.snapshot.status = "loading";
  h.snapshot.readKind = "refresh";
  h.render();
  h.element.focus();
  expect(h.element).toHaveAttribute("data-positioning");
  expect(h.element.querySelector("[data-thread-rows]")).toHaveAttribute(
    "inert",
  );
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(reading).not.toHaveBeenCalled();

  h.snapshot.status = "ready";
  h.snapshot.readKind = undefined;
  h.snapshot.direction = "forward";
  h.snapshot.canLoadMore = true;
  h.snapshot.replies = [{ ...row, id: "reply", content: "reply" }];
  h.render();
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  h.snapshot.status = "loading";
  h.snapshot.readKind = "older";
  h.render();
  expect(h.element).not.toHaveAttribute("data-positioning");
  expect(h.element.querySelector("[data-thread-rows]")).not.toHaveAttribute(
    "inert",
  );
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(reading).not.toHaveBeenCalled();

  // The empty continuation changes neither rows nor geometry. Readiness must
  // wake the existing reader, without a new focus or scroll gesture.
  h.snapshot.status = "ready";
  h.snapshot.readKind = undefined;
  h.snapshot.canLoadMore = false;
  h.render();
  expect(h.element).not.toHaveAttribute("data-positioning");
  await act(() => vi.advanceTimersByTimeAsync(299));
  expect(observe).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(observe).toHaveBeenCalledExactlyOnceWith([row.id, "reply"]);
});
it.each([false, true])(
  "reads a background-completed exact thread after fresh dwell (deactivate before reveal=%s)",
  async (deactivateBeforeReveal) => {
    vi.useFakeTimers();
    const navigation = ordinaryNavigation();
    navigation.target.threadRootId = "different-root";
    const h = messagesHarness(navigation);
    h.props.active = deactivateBeforeReveal;
    h.resize(600);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 500, 500),
    ] as unknown as DOMRectList);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 500),
    );
    const observe = vi.fn(async () => {});
    const reading = vi.fn(() => ({
      view: vi.fn(),
      observe,
      catchUp: vi.fn(async () => {}),
      dispose: vi.fn(),
    }));
    Object.assign(h.session.unread, {
      sync: () => ({ capability: "frontier-sync" }),
      reading,
    });
    h.snapshot.status = "loading";
    h.snapshot.targetStatus = "loading";
    h.render();
    // The workspace owns inactive tab inertness and focus, not ThreadPanel.
    const host = screen.getByRole("application");
    host.setAttribute("inert", "");
    (document.activeElement as HTMLElement).blur();
    h.snapshot.targetStatus = "ready";
    h.snapshot.target = row;
    h.render();
    h.snapshot.status = "ready";
    h.render();
    if (deactivateBeforeReveal) {
      expect(navigation.complete).not.toHaveBeenCalled();
      // Props alone complete the background visit; the snapshot is unchanged.
      h.props.active = false;
      h.rerenderProps();
    }
    expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
      status: "opened",
    });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(observe).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

    h.props.active = true;
    h.rerenderProps();
    host.removeAttribute("inert");
    h.element.focus();
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(observe).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(observe).toHaveBeenCalledExactlyOnceWith([row.id]);
    expect(h.element).toHaveFocus();
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  },
);
it("scopes its reading leases to its thread while the original is unavailable", () => {
  const h = messagesHarness();
  h.resize(600);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  const reading = vi.fn((_channelId: string, _rootId?: string) => ({
    view: vi.fn(),
    observe: vi.fn(async () => {}),
    catchUp: vi.fn(async () => {}),
    dispose: vi.fn(),
  }));
  Object.assign(h.session.unread, {
    sync: () => ({ capability: "frontier-sync" }),
    reading,
  });
  h.snapshot.root = undefined;
  h.snapshot.replies = [{ ...row, id: "reply", content: "reply" }];
  h.render();
  expect(screen.getByText("Original message unavailable.")).toBeVisible();
  h.element.focus();
  // In a DM, the thread it opened bounds what its reads may cover.
  expect(reading.mock.calls).not.toHaveLength(0);
  for (const call of reading.mock.calls)
    expect(call).toEqual(["channel", row.id]);
});
it("leaves a sibling reply it hides unread while a DM reply's original is unavailable", async () => {
  // The real unread owner, so a dwell's DM read lands in its journal.
  const self = keypair(),
    relay = keypair(),
    alice = keypair();
  let journal: ReadJournal | undefined;
  let incoming: (events: readonly RelayEvent[]) => void = () => {};
  const owner = createRelaySession(
    {
      viewer: self.pubkey,
      relayAuthor: relay.pubkey,
      query: async () => [],
      media: () => undefined,
      readState: {
        decode: async (events: readonly RelayEvent[]) =>
          decodeReadState(events, self.secret),
        sign: async (intent: ReadStateSigning) =>
          signReadState(intent, self.secret),
        publish: async () => {},
      },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateFloor: () => 0,
      readStateStorage: {
        capture: async () => structuredClone(journal),
        async update(change) {
          journal = readJournal(change(journal), self.pubkey);
          return journal;
        },
        close() {},
      },
      readPublisherLock: async (_signal, work) => work(),
    },
  );
  onTestFinished(owner.dispose);
  const h = messagesHarness();
  const dm = h.props.channelId;
  const unread = owner.session.unread;
  // Neither the thread view nor the unread owner has the original.
  const root = message(self, dm, "Original", 10);
  const reply = (content: string, at: number) =>
    message(alice, dm, content, at, [["e", root.id, "", "reply"]]);
  const target = reply("Opened reply", 20);
  const sibling = reply("Hidden sibling", 30);
  incoming([
    roster(relay, dm, [self.pubkey, alice.pubkey], 1),
    metadata(relay, dm, "DM", 1, [["t", "dm"]]),
    target,
  ]);
  await unread.ensure();
  Object.assign(h.session, { viewer: self.pubkey, unread });
  // What an exact view publishes when it cannot load the original: only its
  // target, never the thread's other replies.
  const shown = {
    ...row,
    id: target.id,
    channelId: dm,
    authorId: alice.pubkey,
    content: target.content,
    createdAt: target.created_at,
    threadRootId: root.id,
    replyParentId: root.id,
    replyCount: 0,
  };
  h.snapshot.status = "error";
  h.snapshot.error = "Error: The original thread message is unavailable.";
  h.snapshot.root = undefined;
  h.snapshot.replies = [shown];
  h.snapshot.target = shown;
  h.snapshot.targetStatus = "ready";
  // Opened at the reply, as a conversation tab opens an exact message.
  Object.assign(h.props as ThreadPanelProps, {
    messageId: target.id,
    retainThread: true,
    revealSelected: true,
    revealRequest: 1,
  });
  h.resize(600);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  // A controlled clock runs the reveal's frames and the dwell.
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  try {
    h.render();
    expect(screen.getByText("Original message unavailable.")).toBeVisible();
    // A sibling reply in the same thread arrives after opening, unread.
    act(() => incoming([sibling]));
    expect(unread.attention(dm, sibling.id).unread).toBe(true);
    // The window gains focus: once revealed, the reader dwells on its reply.
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(async () => h.element.focus());
    for (
      let elapsed = 0;
      (journal?.state.frontiers[dm] ?? -1) < target.created_at;
      elapsed += 50
    ) {
      if (elapsed >= 2000) throw new Error("The dwell never read the reply.");
      await act(() => vi.advanceTimersByTimeAsync(50));
    }
  } finally {
    vi.useRealTimers();
  }
  // It reads the reply, but stops one second before the sibling it hides.
  expect(journal?.state.frontiers[dm]).toBe(sibling.created_at - 1);
  expect(unread.attention(dm, target.id).unread).toBe(false);
  expect(unread.attention(dm, sibling.id).unread).toBe(true);
});
it("renders replies after the original without a reply-count divider", () => {
  const h = messagesHarness();
  h.snapshot.root = { ...row, replyCount: 0 };
  h.snapshot.status = "loading";
  h.render();
  expect(
    screen.queryByText("Replies", { exact: true }),
  ).not.toBeInTheDocument();
  h.snapshot.status = "ready";
  // An unavailable exact target stops the read before any replies are read.
  for (const targetStatus of ["unavailable", "loading", "error"] as const) {
    h.snapshot.targetStatus = targetStatus;
    h.render();
    expect(
      screen.queryByText("Replies", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No replies yet")).not.toBeInTheDocument();
  }
  h.snapshot.targetStatus = "ready";
  h.render();
  expect(
    screen.queryByText("Replies", { exact: true }),
  ).not.toBeInTheDocument();
  h.snapshot.targetStatus = undefined;
  h.render();
  expect(
    screen.queryByText("Replies", { exact: true }),
  ).not.toBeInTheDocument();

  // Empty presentation never proves empty history, including after a repair
  // or selection reset leaves ready with no continuation or error evidence.
  for (const { canLoadMore, limited } of [
    { canLoadMore: true, limited: false },
    { canLoadMore: false, limited: true },
    { canLoadMore: false, limited: false },
  ]) {
    h.snapshot.canLoadMore = canLoadMore;
    h.snapshot.limited = limited;
    h.render();
    expect(
      screen.queryByText("Replies", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No replies yet")).not.toBeInTheDocument();
  }

  // A server total alone is not something to separate from the original.
  h.snapshot.root = { ...row, replyCount: 11 };
  h.render();
  expect(screen.queryByText("11 replies")).not.toBeInTheDocument();
  h.snapshot.root = { ...row, replyCount: 0 };

  // A just-sent reply can arrive before the relay's summary counts it.
  h.snapshot.replies = [{ ...row, id: "reply", content: "first reply" }];
  h.render();
  expect(
    screen.queryByText("Replies", { exact: true }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("No replies yet")).not.toBeInTheDocument();

  // Replies follow the root without a divider, regardless of the relay total.
  h.snapshot.root = { ...row, replyCount: 11 };
  h.render();
  expect(screen.queryByText("11 replies")).not.toBeInTheDocument();
  const root = screen.getByText("root");
  const reply = screen.getByText("first reply");
  expect(
    root.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  h.snapshot.root = { ...row, replyCount: 1 };
  h.render();
  expect(screen.queryByText("1 reply")).not.toBeInTheDocument();
  expect(screen.getByText("first reply")).toBeVisible();

  h.snapshot.replies = [];
  h.render();
  expect(screen.queryByText("1 reply")).not.toBeInTheDocument();
  h.snapshot.replies = [{ ...row, id: "reply", content: "first reply" }];
  h.render();
  expect(screen.queryByText("1 reply")).not.toBeInTheDocument();
  expect(screen.getByText("first reply")).toBeVisible();

  h.snapshot.root = undefined;
  h.render();
  expect(screen.getByText("Original message unavailable.")).toBeVisible();
  expect(screen.queryByText("1 reply")).not.toBeInTheDocument();
});

it("keeps older-page loading quiet and retry between root and replies", () => {
  const h = messagesHarness();
  h.snapshot.direction = "older";
  h.snapshot.canLoadMore = true;
  h.snapshot.replies = [{ ...row, id: "older-reply", content: "older reply" }];
  const section = h.render();
  fireEvent.wheel(section, { deltaY: -1 });
  h.scroll(0);
  expect(h.view.loadMore).toHaveBeenCalledOnce();

  h.snapshot.status = "loading";
  h.snapshot.readKind = "older";
  h.render();
  const root = screen.getByText("root").closest("article");
  const reply = screen.getByText("older reply").closest("article");
  if (!root || !reply) throw new Error("Missing root or older reply");
  expect(within(section).queryByText("Loading older replies…")).toBeNull();
  expect(root).toBeVisible();
  expect(reply).toBeVisible();
  expect(within(section).queryByText("Loading thread…")).toBeNull();

  h.snapshot.status = "error";
  h.snapshot.error = "offline";
  h.render();
  const alert = within(section).getByRole("alert");
  expect(alert).toHaveTextContent("offline");
  expect(
    root.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    alert.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(within(section).getByRole("button", { name: "Try again" }));
  expect(h.view.loadMore).toHaveBeenCalledTimes(2);
  expect(h.view.refresh).toHaveBeenCalledOnce();

  h.snapshot.status = "ready";
  h.snapshot.error = undefined;
  h.render();
  expect(within(section).queryByText("Loading older replies…")).toBeNull();
});
it("keeps retained-range repair quiet and retry after the replies", () => {
  const h = messagesHarness();
  h.snapshot.direction = "older";
  h.snapshot.replies = [
    { ...row, id: "retained-reply", content: "retained reply" },
  ];
  h.snapshot.status = "loading";
  h.snapshot.readKind = "refresh";
  const section = h.render();
  expect(within(section).queryByText("Loading older replies…")).toBeNull();
  expect(within(section).queryByText("Loading thread…")).toBeNull();

  h.snapshot.status = "error";
  h.snapshot.error = "repair failed";
  h.render();
  const reply = screen.getByText("retained reply").closest("article");
  if (!reply) throw new Error("Missing retained reply");
  const alert = within(section).getByRole("alert");
  expect(alert).toHaveTextContent("This thread didn’t load.");
  expect(
    reply.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(within(section).getByRole("button", { name: "Try again" }));
  expect(h.view.refresh).toHaveBeenCalledTimes(2);
  expect(h.view.loadMore).not.toHaveBeenCalled();
});
it("positions after successful history loading, then follows live replies without another read", () => {
  const h = messagesHarness();
  h.snapshot.status = "loading";
  h.render();
  expect(h.element.scrollTop).toBe(0);
  h.snapshot.status = "error";
  h.render();
  expect(h.element.scrollTop).toBe(0);
  h.snapshot.status = "ready";
  h.render();
  expect(h.element.scrollTop).toBe(3400);
  expect(h.element).not.toHaveAttribute("data-positioning");
  expect(h.element.querySelector("[data-thread-rows]")).not.toHaveAttribute(
    "inert",
  );
  h.scroll(3400);
  h.snapshot.replies = [{ ...row, id: "new", content: "live arrival" }];
  h.resize(4800);
  const section = h.render();
  expect(h.element.scrollTop).toBe(4200);
  expect(within(section).getByText("live arrival")).toBeVisible();
  expect(h.view.refresh).toHaveBeenCalledTimes(1); // Initial open only.
  expect(h.view.loadMore).not.toHaveBeenCalled();
});
it("preserves reading above the bottom through live updates and refresh, then resumes following on return", () => {
  const h = messagesHarness();
  h.render();
  h.scroll(500);
  h.snapshot.replies = [{ ...row, id: "new", content: "live arrival" }];
  h.resize(4800);
  h.render();
  expect(h.element.scrollTop).toBe(500);
  h.snapshot.status = "loading";
  h.render();
  h.snapshot.status = "ready";
  h.render();
  expect(h.element.scrollTop).toBe(500);
  h.scroll(4200);
  h.snapshot.replies = [...h.snapshot.replies, { ...row, id: "next" }];
  h.resize(5500);
  h.render();
  expect(h.element.scrollTop).toBe(4900);
});
it("keeps video threads free of the timestamp comment shortcut at any playback position", () => {
  const h = messagesHarness();
  h.snapshot.root = {
    ...row,
    attachments: [{ url: "https://safe/video.mp4", kind: "video" }],
  };
  h.render();
  for (const seconds of [0, 42]) {
    fireEvent.click(
      screen.getByRole("button", { name: `Report playback ${seconds}` }),
    );
    expect(
      screen.queryByRole("button", { name: /^Comment at / }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Composer" })).toBeVisible();
  }
});

it("counts replies recovered after a completed traversal, not initial history pages", () => {
  const h = messagesHarness();
  h.snapshot.canLoadMore = true;
  h.render();
  h.scroll(500);
  h.snapshot.status = "loading";
  h.snapshot.replies = [{ ...row, id: "history", createdAt: 1 }];
  h.render();
  h.snapshot.status = "ready";
  h.snapshot.canLoadMore = false;
  h.render();
  h.scroll(500);
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  h.snapshot.status = "loading";
  h.render();
  h.snapshot.replies = [
    ...h.snapshot.replies,
    { ...row, id: "recovered", createdAt: 2 },
  ];
  h.render();
  h.snapshot.status = "ready";
  h.render();
  expect(screen.getByRole("button", { name: "1 new message" })).toBeVisible();
  h.snapshot.replies = [
    ...h.snapshot.replies,
    { ...row, id: "live", createdAt: 3 },
  ];
  h.render();
  expect(screen.getByRole("button", { name: "2 new messages" })).toBeVisible();
});

it("transfers keyboard focus to the thread history before removing the jump button", () => {
  const h = messagesHarness();
  h.render();
  h.scroll(500);
  const jump = screen.getByRole("button", { name: "Jump to latest" });
  expect(h.element).toHaveAttribute("data-jump-visible");
  jump.focus();
  fireEvent.click(jump);
  expect(h.element).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  expect(h.element).not.toHaveAttribute("data-jump-visible");
});

it("routes media in replies through the resolved root review workspace", () => {
  const open = vi.fn();
  const h = messagesHarness(undefined, open);
  const attachment = { url: "https://safe/image.png", kind: "image" as const };
  h.snapshot.root = { ...row, id: "resolved-root" };
  h.snapshot.replies = [
    { ...row, id: "reply", content: "media reply", attachments: [attachment] },
  ];
  h.render();
  fireEvent.click(screen.getByRole("button", { name: "Open media reply" }));
  expect(open).toHaveBeenCalledExactlyOnceWith(
    "reply",
    attachment,
    0,
    true,
    undefined,
  );
});

it("uses the resolved root with the shared composer and reveals an own send even while reading above", () => {
  const h = messagesHarness();
  h.snapshot.root = { ...row, id: "resolved-root" };
  h.render();
  expect(screen.getByRole("region", { name: "Composer" })).toHaveAttribute(
    "data-root",
    "resolved-root",
  );
  expect(screen.getByRole("region", { name: "Composer" })).toHaveAttribute(
    "data-channel",
    "channel",
  );
  expect(screen.getByRole("region", { name: "Composer" })).toHaveAttribute(
    "data-scope",
    "scope",
  );
  h.scroll(500);
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.snapshot.replies = [{ ...row, id: "own-reply", content: "own reply" }];
  h.resize(4800);
  h.render();
  expect(h.element.scrollTop).toBe(4200);
  const reply = screen.getByText("own reply").closest("article");
  expect(reply).toHaveAttribute("data-scope", "scope");
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  expect(
    vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts,
  ).toContain(reply);
  fireEvent.click(screen.getByRole("button", { name: "Retry own-reply" }));
  expect(h.session.messages.retry).toHaveBeenCalledWith("own-reply");
  h.snapshot.root = undefined;
  h.render();
  expect(screen.queryByRole("region", { name: "Composer" })).toBeNull();
});
it.each([
  {
    author: "another user",
    root: row,
    placeholder: `Reply in thread to ${formatPublicKey(row.authorId)}`,
  },
  {
    author: "the viewer",
    root: { ...row, authorId: viewer },
    placeholder: "Reply in thread",
  },
  {
    author: "a workflow the viewer owns",
    root: { ...row, workflowOwnerId: viewer },
    placeholder: "Reply in thread",
  },
])(
  "names the root author in the composer placeholder unless it is $author",
  ({ root, placeholder }) => {
    const h = messagesHarness();
    h.snapshot.root = root;
    h.render();
    expect(screen.getByRole("region", { name: "Composer" })).toHaveAttribute(
      "data-placeholder",
      placeholder,
    );
  },
);
const composerSeed = () =>
  screen.getByRole("region", { name: "Composer" }).getAttribute("data-seed");
it("passes the viewer's latest message in the thread as the composer seed", () => {
  const h = messagesHarness();
  h.snapshot.root = { ...row, authorId: viewer, mentions: ["d".repeat(64)] };
  h.snapshot.replies = [
    { ...row, id: "r1", createdAt: 2, mentions: ["e".repeat(64)] },
    {
      ...row,
      id: "r2",
      createdAt: 3,
      authorId: viewer,
      mentions: ["f".repeat(64)],
    },
    { ...row, id: "r3", createdAt: 4, mentions: ["g".repeat(64)] },
  ];
  h.render();
  expect(composerSeed()).toBe("f".repeat(64));
});
it("seeds from the viewer's reply in someone else's thread", () => {
  const h = messagesHarness();
  h.snapshot.root = { ...row, mentions: ["d".repeat(64)] };
  h.snapshot.replies = [
    {
      ...row,
      id: "r1",
      createdAt: 2,
      authorId: viewer,
      mentions: ["e".repeat(64)],
    },
  ];
  h.render();
  expect(composerSeed()).toBe("e".repeat(64));
});
it.each([
  {
    author: "a workflow the viewer owns",
    root: { ...row, workflowOwnerId: viewer },
  },
  { author: "another user", root: row },
])(
  "passes no seed for a thread the viewer never wrote in, rooted by $author",
  ({ root }) => {
    const h = messagesHarness();
    h.snapshot.root = { ...root, mentions: ["d".repeat(64)] };
    h.snapshot.replies = [
      { ...row, id: "r1", createdAt: 2, mentions: ["e".repeat(64)] },
    ];
    h.render();
    expect(composerSeed()).toBeNull();
  },
);
it("passes no seed until the first page lands", () => {
  const h = messagesHarness();
  h.snapshot.status = "loading";
  h.snapshot.root = { ...row, authorId: viewer, mentions: ["d".repeat(64)] };
  h.render();
  expect(screen.getByRole("region", { name: "Composer" })).toBeVisible();
  expect(composerSeed()).toBeNull();
  h.snapshot.status = "ready";
  h.render();
  expect(composerSeed()).toBe("d".repeat(64));
});
it.each([
  { gap: 79, follows: true },
  { gap: 80, follows: false },
])(
  "uses the main timeline's near-bottom threshold: gap=$gap",
  ({ gap, follows }) => {
    const h = messagesHarness();
    h.render();
    h.scroll(3400 - gap);
    h.snapshot.replies = [{ ...row, id: "new" }];
    h.resize(4800);
    h.render();
    expect(h.element.scrollTop).toBe(follows ? 4200 : 3400 - gap);
  },
);
it("finishes automatic pages before initial positioning and preserves a reader’s intervening scroll", () => {
  const h = messagesHarness();
  h.snapshot.canLoadMore = true;
  h.render();
  expect(h.view.loadMore).toHaveBeenCalledTimes(1);
  expect(h.element.scrollTop).toBe(0);
  const section = h.render();
  fireEvent.wheel(section, { deltaY: -1 });
  h.scroll(500);
  h.snapshot.status = "loading";
  h.render();
  h.snapshot.status = "ready";
  h.snapshot.canLoadMore = false;
  h.snapshot.replies = [{ ...row, id: "history" }];
  h.resize(4800);
  h.render();
  expect(h.element.scrollTop).toBe(500);
  h.scroll(4200);
  h.snapshot.replies = [...h.snapshot.replies, { ...row, id: "live" }];
  h.resize(5500);
  h.render();
  expect(h.element.scrollTop).toBe(4900);
});
it.each([
  { limited: false, routed: false },
  { limited: false, routed: true },
])(
  "positions after automatic loading stops (limited=$limited, routed=$routed), without restarting pagination",
  ({ limited, routed }) => {
    const navigation = routed ? ordinaryNavigation() : undefined;
    const h = messagesHarness(navigation);
    h.snapshot.canLoadMore = true;
    h.render();
    expect(h.element.scrollTop).toBe(0);
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    if (navigation)
      expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
        status: "opened",
      });
    h.snapshot.status = "loading";
    h.render();
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    h.snapshot.status = "ready";
    h.snapshot.canLoadMore = false;
    h.snapshot.limited = limited;
    h.snapshot.replies = [{ ...row, id: "history" }];
    h.resize(4800);
    h.render();
    expect(h.element.scrollTop).toBe(4200);
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    // A live update follows without completing the same visit twice.
    h.snapshot.replies = [...h.snapshot.replies, { ...row, id: "live" }];
    h.render();
    if (navigation)
      expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
        status: "opened",
      });
  },
);
it.each(
  [false, true].flatMap((routed) =>
    (routed ? ["wheel", "touchMove", "pointerDown", "keyDown"] : ["wheel"]).map(
      (handler) => ({
        routed,
        handler,
      }),
    ),
  ),
)(
  "a user $handler gesture before the page completes wins over initial positioning (routed=$routed)",
  ({ routed, handler }) => {
    const navigation = routed ? ordinaryNavigation() : undefined;
    const h = messagesHarness(navigation);
    h.snapshot.status = "loading";
    const section = h.render();
    fireEvent[handler as "wheel" | "touchMove" | "pointerDown" | "keyDown"](
      section,
      { key: "PageUp" },
    );
    h.snapshot.status = "ready";
    h.render();
    expect(h.element.scrollTop).toBe(0);
    if (navigation)
      expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
        status: "opened",
      });
  },
);
it("ordinary routed loading failure completes as unavailable, never as an opened visit", () => {
  const navigation = ordinaryNavigation();
  const h = messagesHarness(navigation);
  h.snapshot.status = "error";
  h.render();
  expect(h.element.scrollTop).toBe(0);
  expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
    status: "failed",
    reason: "unavailable",
    presented: true,
  });
});
it.each(["ready", "unavailable", "error"] as const)(
  "a restored background thread waits for its verified target (%s)",
  (targetStatus) => {
    const navigation = ordinaryNavigation();
    navigation.target.threadRootId = "different-root";
    const h = messagesHarness(navigation);
    h.props.active = false;
    h.snapshot.targetStatus = "loading";
    h.render();
    expect(navigation.complete).not.toHaveBeenCalled();
    h.snapshot.targetStatus = targetStatus;
    h.snapshot.target = targetStatus === "ready" ? row : undefined;
    h.render();
    expect(navigation.complete).toHaveBeenCalledExactlyOnceWith(
      targetStatus === "ready"
        ? { status: "opened" }
        : {
            status: "failed",
            reason:
              targetStatus === "unavailable" ? "not-found" : "unavailable",
            presented: true,
          },
    );
  },
);
it("a presented ordinary thread survives the real navigation deadline while history is pending", async () => {
  vi.useFakeTimers();
  const controller = createNavigationController(createMemoryHistory());
  // The visit deadline runs only while a presenter is attached, as the app's is.
  controller.attach();
  let release = () => {};
  try {
    const navigation = ordinaryNavigation();
    const result = controller.navigation.open(navigation.target);
    const { attempt } = controller.navigation.snapshot();
    navigation.signal = attempt.signal;
    navigation.complete.mockImplementation((result) =>
      controller.complete(attempt, result),
    );
    const h = messagesHarness(navigation);
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.view.loadMore.mockImplementation(() => held);
    h.snapshot.canLoadMore = true;
    h.render();
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    h.snapshot.status = "loading";
    h.render();
    await act(() => vi.advanceTimersByTimeAsync(16_000));
    expect(controller.navigation.snapshot().status).toBe("opened");
    expect(await result).toEqual({ status: "opened" });
    expect(attempt.signal.aborted).toBe(false);
    expect(h.view.dispose).not.toHaveBeenCalled();
    expect(h.element.scrollTop).toBe(0);
    release();
    await held;
    h.snapshot.status = "ready";
    h.snapshot.canLoadMore = false;
    h.render();
    expect(h.element.scrollTop).toBe(3400);
    expect(navigation.complete).toHaveBeenCalledTimes(1);
    h.unmount();
  } finally {
    release();
    controller.dispose();
    vi.useRealTimers();
  }
});
it("a routed thread that fails in place keeps its reader and recovers through its own Try again", () => {
  const controller = createNavigationController(createMemoryHistory());
  try {
    const navigation = ordinaryNavigation();
    void controller.navigation.open(navigation.target);
    const { attempt } = controller.navigation.snapshot();
    navigation.signal = attempt.signal;
    navigation.complete.mockImplementation((result) =>
      controller.complete(attempt, result),
    );
    const h = messagesHarness(navigation);
    h.snapshot.status = "error";
    h.snapshot.error = "offline";
    h.render();
    expect(controller.navigation.snapshot()).toMatchObject({
      status: "failed",
      presented: true,
    });
    expect(attempt.signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(h.view.refresh).toHaveBeenCalled();
    h.snapshot.status = "ready";
    h.snapshot.error = undefined;
    h.render();
    expect(h.view.dispose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "Thread messages" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(h.element.scrollTop).toBe(3400);
    h.unmount();
  } finally {
    controller.dispose();
  }
});
it("revoked ordinary presentation cannot position or complete after loading", () => {
  const controller = new AbortController();
  const navigation = { ...ordinaryNavigation(), signal: controller.signal };
  const h = messagesHarness(navigation);
  h.snapshot.status = "loading";
  h.snapshot.root = undefined;
  h.render();
  act(() => controller.abort());
  expect(h.view.dispose).toHaveBeenCalledTimes(1);
  expect(h.listeners.size).toBe(0);
  expect(screen.queryByRole("region", { name: "Thread messages" })).toBeNull();
  h.snapshot.status = "ready";
  h.render();
  expect(h.element.scrollTop).toBe(0);
  expect(navigation.complete).not.toHaveBeenCalled();
});

it("retains its owned thread view for renames and remounts for destination, scope and session changes", () => {
  const h = messagesHarness();
  const mounted = render(<ThreadPanel {...h.props} />);
  const history = () => screen.getByRole("region", { name: "Thread messages" });
  const initial = history();
  mounted.rerender(<ThreadPanel {...h.props} />);
  mounted.rerender(<ThreadPanel {...h.props} channelName="Renamed" />);
  expect(history()).toBe(initial);
  expect(h.thread).toHaveBeenCalledTimes(1);
  const changes: Partial<ThreadPanelProps>[] = [
    { channelId: "other" },
    { messageId: "other" },
    { scope: "other" },
    { session: { ...h.session } },
  ];
  for (const change of changes) {
    mounted.rerender(<ThreadPanel {...h.props} />);
    const previous = history();
    const owned = h.view;
    const count = h.thread.mock.calls.length;
    mounted.rerender(<ThreadPanel {...h.props} {...change} />);
    expect(history()).not.toBe(previous);
    expect(owned.dispose).toHaveBeenCalledTimes(1);
    expect(h.thread).toHaveBeenCalledTimes(count + 1);
  }
});

it("without close, the embedded thread keeps its reader but has no close header or Escape dismissal", () => {
  const thread = vi.fn(() => {
    throw new Error("fixture unavailable");
  });
  const session = { thread } as unknown as RelaySession;
  const props = {
    session,
    scope: "test",
    channelId: "c",
    channelName: "Channel",
    messageId: "root",
    onOpenLink: () => false,
  };
  const onEscape = vi.fn();
  document.addEventListener("keydown", onEscape);
  const { rerender } = render(<ThreadPanel {...props} />);
  expect(
    screen.queryByRole("button", { name: "Close thread" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This thread didn’t load.",
  );
  fireEvent.keyDown(screen.getByRole("complementary", { name: "Thread" }), {
    key: "Escape",
  });
  document.removeEventListener("keydown", onEscape);
  expect(onEscape).toHaveBeenCalledOnce();
  const close = vi.fn();
  rerender(<ThreadPanel {...props} close={close} />);
  expect(screen.getByRole("button", { name: "Close thread" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("complementary", { name: "Thread" }), {
    key: "Escape",
  });
  expect(close).toHaveBeenCalledOnce();
});

it("observes a visible reply before its root resolves, then enables thread catch-up", async () => {
  vi.useFakeTimers();
  const h = messagesHarness();
  const reply = {
    ...row,
    id: "c".repeat(64),
    content: "available reply",
    createdAt: 2,
  };
  h.snapshot.root = undefined;
  h.snapshot.replies = [reply];
  h.resize(600);
  const observe = vi.fn(async () => {});
  const catchUp = vi.fn(async (_id: string, rootId?: string) => {
    if (!rootId)
      throw new Error("A thread reply cannot advance the channel frontier");
  });
  h.props.session = {
    ...h.session,
    unread: {
      ...h.session.unread,
      sync: () =>
        ({ capability: "frontier-sync" }) as ReturnType<
          RelaySession["unread"]["sync"]
        >,
      reading: () => ({ view() {}, observe, catchUp, dispose() {} }),
    },
  };
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  h.render();
  screen.getByRole("button", { name: "Close thread" }).focus();
  // Focus rerenders the rows, which measure again in the next frame.
  await act(async () => {});
  await act(() => vi.advanceTimersToNextFrame());
  await act(() => vi.advanceTimersByTimeAsync(299));
  expect(observe).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(observe).toHaveBeenCalledExactlyOnceWith([reply.id]);
  expect(catchUp).not.toHaveBeenCalled();

  h.snapshot.root = row;
  h.render();
  // The rows measure in the next frame. That list mutation restarts dwell,
  // which measures again in the frame after it.
  await act(() => vi.advanceTimersToNextFrame());
  await act(() => vi.advanceTimersToNextFrame());
  await act(() => vi.advanceTimersByTimeAsync(299));
  expect(catchUp).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(catchUp).toHaveBeenCalledExactlyOnceWith(reply.id, row.id);
});

it("inline Inbox reveal opts into exact reader and composes origin action without changing ordinary tab focus", () => {
  const h = messagesHarness();
  const headerAction = <button type="button">Open in channel</button>;
  render(
    <ThreadPanel
      {...h.props}
      navigation={undefined}
      revealSelected
      headerActions={headerAction}
    />,
  );
  expect(h.thread).toHaveBeenCalledWith("channel", row.id, { exact: true });
  const thread = screen.getByRole("complementary", { name: "Thread" });
  expect(
    within(thread).getByRole("button", { name: "Open in channel" }),
  ).toBeInTheDocument();
  expect(
    within(thread).getByRole("button", { name: "Close thread" }),
  ).toHaveFocus();
  expect(
    within(thread).getByRole("region", { name: "Thread messages" }),
  ).not.toHaveAttribute("data-positioning");
});

it("names the conversation a thread lives in as a link, only when its host can open it there", () => {
  const h = messagesHarness();
  const open = vi.fn();
  const view = render(
    <ThreadPanel {...h.props} parent={{ label: "#Alpha", open }} />,
  );
  const thread = screen.getByRole("complementary", { name: "Thread" });
  const link = within(thread).getByRole("button", { name: "#Alpha" });
  expect(link.closest("p")).toHaveTextContent("In #Alpha");
  fireEvent.click(link);
  expect(open).toHaveBeenCalledOnce();
  view.rerender(<ThreadPanel {...h.props} />);
  expect(within(thread).queryByText("#Alpha")).toBeNull();
});

it("passes readiness through to thread composition, and gives a Solo thread none", () => {
  const h = messagesHarness();
  const view = render(<ThreadPanel {...h.props} disabled />);
  const composer = screen.getByRole("region", { name: "Composer" });
  expect(composer).toHaveAttribute("data-disabled", "true");
  view.rerender(<ThreadPanel {...h.props} disabled={false} />);
  expect(composer).toHaveAttribute("data-disabled", "false");
  view.rerender(<ThreadPanel {...h.props} />);
  // Solo agents answer at top level: its threads are read-only.
  view.rerender(<ThreadPanel {...h.props} soloConversation />);
  expect(
    screen.queryByRole("region", { name: "Composer" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Thread messages" }),
  ).toBeInTheDocument();
});

it.each([
  { channelType: "stream" as const, joinable: true },
  { channelType: "forum" as const, joinable: true },
  {
    channelType: "stream" as const,
    joinRole: "guest" as const,
    joinable: true,
  },
  { channelType: "stream" as const, archived: true as const, joinable: false },
  { channelType: "solo" as const, archived: true as const, joinable: false },
  { channelType: "solo" as const, joinRole: "guest" as const, joinable: true },
  {
    channelType: "solo" as const,
    joinRole: "member" as const,
    joinable: false,
  },
  { channelType: "solo" as const, joinable: false },
])(
  "replaces the reply composer for a $channelType preview (joinRole: $joinRole, joinable: $joinable)",
  ({ joinable, ...metadata }) => {
    const h = messagesHarness();
    Object.assign(h.props, {
      soloConversation: metadata.channelType === "solo",
    });
    const channel: ChannelSummary = {
      id: "channel",
      name: "General",
      readOnly: true,
      ...metadata,
    };
    const list: ChannelList = { status: "ready", channels: [] };
    Object.assign(h.session, {
      channels: {
        list: () => list,
        get: () => channel,
        subscribeList: () => () => {},
      },
      channelLifecycle: { available: true, run: vi.fn() },
    });
    h.render();
    expect(
      screen.getByRole("region", {
        name: metadata.archived
          ? metadata.channelType === "solo"
            ? "Archived chat"
            : "Archived channel"
          : metadata.joinRole === "guest"
            ? `Read-only ${metadata.channelType === "solo" ? "chat" : "channel"}`
            : metadata.channelType === "solo"
              ? "Chat preview"
              : "Channel preview",
      }),
    ).toBeVisible();
    if (metadata.archived) {
      expect(
        screen.getByText(
          metadata.channelType === "solo"
            ? "This chat is archived"
            : "This channel is archived",
          { exact: true },
        ),
      ).toBeVisible();
    }
    expect(screen.queryByRole("region", { name: "Composer" })).toBeNull();
    expect(!!screen.queryByRole("button", { name: "Join" })).toBe(joinable);
  },
);

it("replaces an archived member thread composer and restores it on unarchive", () => {
  const h = messagesHarness();
  const channel: ChannelSummary = {
    id: "channel",
    name: "General",
    channelType: "stream",
  };
  let list: ChannelList = { status: "ready", channels: [channel] };
  const listeners = new Set<() => void>();
  Object.assign(h.session, {
    channels: {
      list: () => list,
      get: () => list.channels[0],
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    channelLifecycle: { available: true, run: vi.fn() },
  });
  h.render();
  expect(screen.getByRole("region", { name: "Composer" })).toBeInTheDocument();
  act(() => {
    list = { ...list, channels: [{ ...channel, archived: true }] };
    for (const listener of listeners) listener();
  });
  expect(
    screen.getByRole("region", { name: "Archived channel" }),
  ).toHaveTextContent("This channel is archived");
  expect(screen.queryByRole("region", { name: "Composer" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  act(() => {
    list = { ...list, channels: [channel] };
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole("region", { name: "Composer" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Archived channel" })).toBeNull();
});

it("keeps guest threads readable without a reply composer or Join action across default changes", () => {
  const h = messagesHarness();
  const channel: ChannelSummary = {
    id: "channel",
    name: "General",
    channelType: "stream",
    viewerRole: "guest",
    readOnly: true,
    joinRole: "guest",
  };
  let list: ChannelList = { status: "ready", channels: [channel] };
  const listeners = new Set<() => void>();
  Object.assign(h.session, {
    channels: {
      list: () => list,
      get: () => list.channels[0],
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    channelLifecycle: { available: true, run: vi.fn() },
  });
  h.render();
  expect(
    screen.getByRole("region", { name: "Read-only channel" }),
  ).toHaveTextContent("This channel is read-only");
  expect(
    screen.getByRole("region", { name: "Thread messages" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Composer" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  act(() => {
    list = { ...list, channels: [{ ...channel, joinRole: "member" }] };
    for (const listener of listeners) listener();
  });
  expect(
    screen.getByRole("region", { name: "Read-only channel" }),
  ).toHaveTextContent("Read-only access");
  expect(screen.queryByRole("region", { name: "Composer" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  act(() => {
    const { readOnly: _, ...promoted } = channel;
    list = { ...list, channels: [{ ...promoted, viewerRole: "member" }] };
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole("region", { name: "Composer" })).toBeInTheDocument();
});

it("keeps a thread preview until membership arrives, with failed joins retryable", async () => {
  const h = messagesHarness();
  const channel: ChannelSummary = {
    id: "channel",
    name: "General",
    channelType: "stream",
    readOnly: true,
  };
  let list: ChannelList = { status: "ready", channels: [] };
  const listeners = new Set<() => void>();
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error("Try again."))
    .mockResolvedValue(undefined);
  Object.assign(h.session, {
    channels: {
      list: () => list,
      get: () => channel,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    channelLifecycle: { available: true, run },
  });
  h.render();
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Try again.");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("region", { name: "Composer" })).toBeNull();
  act(() => {
    list = {
      status: "ready",
      channels: [{ id: "channel", name: "General", channelType: "stream" }],
    };
    for (const listener of listeners) listener();
  });
  expect(screen.queryByRole("region", { name: "Channel preview" })).toBeNull();
  expect(screen.getByRole("region", { name: "Composer" })).toBeVisible();
});

it("retained navigation keeps the mounted editor when another message belongs to the open thread", async () => {
  const controller = new AbortController();
  const first = { ...ordinaryNavigation(), signal: controller.signal };
  const h = messagesHarness(first);
  const mounted = render(<ThreadPanel {...h.props} retainThread />);
  const editor = within(mounted.container).getByRole("region", {
    name: "Composer",
  });
  const current = h.view;
  let release!: (value: "selected") => void;
  current.retarget.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const next = {
    ...ordinaryNavigation(),
    entryId: "next",
    signal: new AbortController().signal,
  };
  next.target.messageId = "c".repeat(64);
  act(() => controller.abort());
  mounted.rerender(
    <ThreadPanel
      {...h.props}
      retainThread
      messageId={next.target.messageId}
      navigation={next}
    />,
  );
  expect(
    within(mounted.container).getByRole("region", { name: "Composer" }),
  ).toBe(editor);
  await act(async () => release("selected"));
  expect(
    within(mounted.container).getByRole("region", { name: "Composer" }),
  ).toBe(editor);
  expect(current.dispose).not.toHaveBeenCalled();
  mounted.unmount();
  expect(current.dispose).toHaveBeenCalledOnce();
});

it.each(["unavailable", "error", "cancelled"] as const)(
  "retained target %s keeps the same thread and reply editor",
  async (result) => {
    const h = messagesHarness(ordinaryNavigation());
    const retry = vi.fn();
    const mounted = render(
      <ThreadPanel {...h.props} retainThread onRetryNavigation={retry} />,
    );
    const editor = screen.getByRole("region", { name: "Composer" });
    const reader = h.view;
    reader.retarget.mockResolvedValue(result);
    const next = { ...ordinaryNavigation(), entryId: "next" };
    next.target.messageId = "c".repeat(64);
    await act(async () =>
      mounted.rerender(
        <ThreadPanel
          {...h.props}
          retainThread
          onRetryNavigation={retry}
          messageId={next.target.messageId}
          navigation={next}
        />,
      ),
    );
    expect(screen.getByRole("region", { name: "Composer" })).toBe(editor);
    expect(reader.dispose).not.toHaveBeenCalled();
    expect(h.thread).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      result === "unavailable"
        ? "That message is no longer available."
        : "Couldn’t open that message.",
    );
    expect(next.complete).toHaveBeenCalledWith({
      status: "failed",
      reason: result === "unavailable" ? "not-found" : "unavailable",
      presented: true,
    });
    if (result === "unavailable") {
      // Retrying can't restore a message that no longer exists.
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      return;
    }
    const again = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(again);
    expect(retry).toHaveBeenCalledOnce();
    // The focused control stays mounted while the fresh attempt runs.
    let release!: (value: "selected") => void;
    reader.retarget.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const retried = { ...ordinaryNavigation(), entryId: "retried" };
    retried.target.messageId = next.target.messageId;
    await act(async () =>
      mounted.rerender(
        <ThreadPanel
          {...h.props}
          retainThread
          onRetryNavigation={retry}
          messageId={retried.target.messageId}
          navigation={retried}
        />,
      ),
    );
    try {
      expect(screen.getByRole("button", { name: "Try again" })).toBe(again);
      expect(again).toHaveAttribute("aria-busy", "true");
    } finally {
      await act(async () => release("selected"));
    }
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("region", { name: "Composer" })).toBe(editor);
    expect(reader.dispose).not.toHaveBeenCalled();
  },
);

it("a link into a different thread replaces the reader and its editor", async () => {
  const h = messagesHarness(ordinaryNavigation());
  const mounted = render(<ThreadPanel {...h.props} retainThread />);
  const editor = screen.getByRole("region", { name: "Composer" });
  const previous = h.view;
  previous.retarget.mockResolvedValue("different");
  const next = { ...ordinaryNavigation(), entryId: "other-thread" };
  next.target.messageId = "d".repeat(64);
  await act(async () =>
    mounted.rerender(
      <ThreadPanel
        {...h.props}
        retainThread
        messageId={next.target.messageId}
        navigation={next}
      />,
    ),
  );
  expect(previous.dispose).toHaveBeenCalledOnce();
  expect(h.thread).toHaveBeenCalledTimes(2);
  expect(h.view).not.toBe(previous);
  expect(screen.getByRole("region", { name: "Composer" })).not.toBe(editor);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a workspace diverts a wrong-root link without replacing its confirmed reader or editor", async () => {
  const h = messagesHarness(ordinaryNavigation());
  const divert = vi.fn();
  const mounted = render(
    <ThreadPanel {...h.props} retainThread onDifferentThread={divert} />,
  );
  const editor = screen.getByRole("region", { name: "Composer" });
  const previous = h.view;
  previous.retarget.mockResolvedValue("different");
  const next = { ...ordinaryNavigation(), entryId: "wrong-root" };
  next.target.messageId = "d".repeat(64);
  await act(async () =>
    mounted.rerender(
      <ThreadPanel
        {...h.props}
        retainThread
        onDifferentThread={divert}
        messageId={next.target.messageId}
        navigation={next}
      />,
    ),
  );
  expect(divert).toHaveBeenCalledWith(next.target.messageId, h.props.messageId);
  expect(previous.dispose).not.toHaveBeenCalled();
  expect(h.thread).toHaveBeenCalledOnce();
  expect(screen.getByRole("region", { name: "Composer" })).toBe(editor);
  expect(next.complete).not.toHaveBeenCalled();
});

it("a retained reader reveals its exact selected message, again for each new request", async () => {
  const h = messagesHarness();
  const reply = { ...row, id: "d".repeat(64), content: "the reply" };
  h.snapshot.replies = [reply];
  h.snapshot.target = reply;
  h.snapshot.targetStatus = "ready";
  const props = h.props as ThreadPanelProps;
  Object.assign(props, {
    messageId: reply.id,
    retainThread: true,
    revealSelected: true,
    revealRequest: 1,
  });
  h.render();
  expect(h.thread).toHaveBeenCalledWith("channel", reply.id, { exact: true });
  const revealedReply = () =>
    vi
      .mocked(HTMLElement.prototype.scrollIntoView)
      .mock.contexts.some(
        (context) => (context as HTMLElement).dataset.messageId === reply.id,
      );
  await waitFor(() => expect(revealedReply()).toBe(true));
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  // The same message again: the retained reader selects it and reveals anew.
  props.revealRequest = 2;
  h.rerenderProps();
  await waitFor(() =>
    expect(h.view.retarget).toHaveBeenCalledWith(
      reply.id,
      expect.any(AbortSignal),
    ),
  );
  await waitFor(() => expect(revealedReply()).toBe(true));
  expect(h.thread).toHaveBeenCalledOnce();
  // A rerender without a new request does not reveal again.
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  h.rerenderProps();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(revealedReply()).toBe(false);
});

it("reopens collapsed activity for a new reveal of the same step", async () => {
  const h = messagesHarness();
  const replies = ["d", "e"].map((id, index) => ({
    ...row,
    id: id.repeat(64),
    content: `Agent step ${index}`,
    audience: "agents" as const,
    threadRootId: row.id,
    replyToId: row.id,
    createdAt: 2 + index,
  }));
  const target = replies[1];
  if (!target) throw new Error("Missing activity fixture target");
  h.snapshot.replies = replies;
  h.snapshot.target = target;
  h.snapshot.targetStatus = "ready";
  const props = h.props as ThreadPanelProps;
  Object.assign(props, {
    messageId: target.id,
    retainThread: true,
    revealSelected: true,
    revealRequest: 1,
  });
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Collapse activity history/ }),
  );
  expect(
    screen.getByRole("button", { name: /Show activity history/ }),
  ).toHaveAttribute("aria-expanded", "false");
  props.revealRequest = 2;
  h.rerenderProps();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Collapse activity history/ }),
    ).toHaveAttribute("aria-expanded", "true"),
  );
});

it("a new reveal request reopens a branch the reader collapsed, and live updates leave it closed", async () => {
  const h = messagesHarness();
  const reply = (id: string, content: string, replyParentId: string) => ({
    ...row,
    id: id.repeat(64),
    content,
    replyParentId,
    createdAt: 2,
  });
  const parent = reply("d", "the parent", row.id);
  const first = reply("e", "first child", parent.id);
  const second = reply("f", "second child", parent.id);
  h.snapshot.replies = [parent, first, second];
  h.snapshot.target = first;
  h.snapshot.targetStatus = "ready";
  const props = h.props as ThreadPanelProps;
  Object.assign(props, {
    messageId: first.id,
    retainThread: true,
    revealSelected: true,
    revealRequest: 1,
  });
  h.render();
  const shown = (message: ChannelMessage) =>
    h.element.querySelector(`[data-message-id="${message.id}"]`);
  const collapse = () => {
    fireEvent.click(screen.getByRole("button", { name: "Collapse 2 replies" }));
    expect(shown(first)).toBeNull();
  };
  const revealed = async (message: ChannelMessage) => {
    await waitFor(() => expect(shown(message)).toHaveFocus());
    expect(
      vi
        .mocked(HTMLElement.prototype.scrollIntoView)
        .mock.contexts.some(
          (context) =>
            (context as HTMLElement).dataset.messageId === message.id,
        ),
    ).toBe(true);
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  };
  await revealed(first);
  collapse();
  // An ordinary live update within the same request keeps the branch closed.
  h.snapshot.replies = [parent, first, second, reply("9", "later", row.id)];
  h.render();
  expect(screen.getByText("later")).toBeInTheDocument();
  expect(shown(first)).toBeNull();
  // The same message requested again reopens its branch.
  props.revealRequest = 2;
  h.rerenderProps();
  await revealed(first);
  collapse();
  // So does a request for another reply in that branch.
  h.snapshot.target = second;
  h.render();
  Object.assign(props, { messageId: second.id, revealRequest: 3 });
  h.rerenderProps();
  await revealed(second);
});

/** Visits as navigation keeps them: a visit's place outlives each presentation. */
function visitPlaces() {
  const places = new Map<string, JsonValue>();
  const visit = (entryId: string, traversal?: true) => ({
    ...ordinaryNavigation(),
    entryId,
    ...(traversal && { traversal }),
    position: (key: string) => places.get(`${entryId}:${key}`),
    savePosition(key: string, value: JsonValue) {
      places.set(`${entryId}:${key}`, value);
    },
  });
  /** A link to the root message: an exact reveal, not an ordinary opening. */
  const linked = (
    entryId: string,
    traversal?: true,
    messageId = row.id,
  ): PageNavigation => {
    const navigation = visit(entryId, traversal);
    const { threadRootId: _root, ...target } = navigation.target;
    return { ...navigation, target: { ...target, messageId } };
  };
  return { places, visit, linked };
}
const threadReply = (id: string, replyParentId: string) => ({
  ...row,
  id: id.repeat(64),
  content: `reply ${id}`,
  replyParentId,
  createdAt: 2,
});
/** Lays rows out 2,000 px apart, 500 px tall, scrolling with the reader. */
function layOutRows(ids: readonly string[]) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const index = ids.indexOf(this.dataset.messageId ?? "");
      return index < 0
        ? new DOMRect(0, 0, 500, 600)
        : new DOMRect(0, index * 2000 - this.scrollTop, 500, 500);
    },
  );
}

it.each([
  ["the reply it was left at, reopening its branch", true],
  ["the nearest ancestor of a reply that is gone", false],
])("Back to a thread visit anchors on %s", (_, present) => {
  const { places, visit } = visitPlaces();
  const parent = threadReply("d", row.id);
  const child = threadReply("e", parent.id);
  places.set("thread-visit:thread", {
    anchor: { id: child.id, top: -100, ancestors: [parent.id] },
  });
  const h = messagesHarness(visit("thread-visit", true));
  h.snapshot.replies = present ? [parent, child] : [parent];
  h.render();
  const anchor = present ? child : parent;
  expect(
    h.element.querySelector(`[data-message-id="${anchor.id}"]`),
  ).not.toBeNull();
  // jsdom rows sit at the scroller top, so the row moves back to 100 px above
  // it: the place, not the end of the thread.
  expect(h.element.scrollTop).toBe(100);
  expect(h.element).not.toHaveAttribute("data-positioning");
});

it.each([
  ["reveals its linked message again", true],
  ["opens an ordinary thread at its end again", false],
])("Back to a place no longer loaded %s", async (_, exact) => {
  const { places, visit, linked } = visitPlaces();
  // An older page the reopened thread has not loaded.
  places.set("thread-visit:thread", {
    anchor: { id: "f".repeat(64), top: -100, ancestors: [] },
  });
  const h = messagesHarness(
    exact ? linked("thread-visit", true) : visit("thread-visit", true),
  );
  h.snapshot.replies = [threadReply("d", row.id)];
  h.snapshot.target = row;
  h.snapshot.targetStatus = "ready";
  h.render();
  if (!exact) {
    expect(h.element.scrollTop).toBe(3400);
    return;
  }
  const root = h.element.querySelector(`[data-message-id="${row.id}"]`);
  await waitFor(() => expect(root).toHaveFocus());
  expect(
    vi
      .mocked(HTMLElement.prototype.scrollIntoView)
      .mock.contexts.includes(root),
  ).toBe(true);
});

it("records a visit's place only once that visit was presented", async () => {
  const { places, visit, linked } = visitPlaces();
  const reply = threadReply("d", row.id);
  const h = messagesHarness(visit("thread-visit"));
  h.snapshot.replies = [reply];
  const mounted = render(<ThreadPanel {...h.props} retainThread />);
  // The retained reader is already positioned for the ordinary visit; the
  // linked reply's target is still loading, so its reveal has not run.
  await act(async () =>
    mounted.rerender(
      <ThreadPanel
        {...h.props}
        retainThread
        messageId={reply.id}
        navigation={linked("linked", undefined, reply.id)}
      />,
    ),
  );
  expect(h.view.retarget).toHaveBeenCalledOnce();
  expect(places.get("thread-visit:thread")).toEqual({});
  mounted.unmount();
  expect(places.has("linked:thread")).toBe(false);
});

it("records a visit's place when the reader leaves, not as replies arrive", () => {
  const { places, visit } = visitPlaces();
  // A return with no recorded place opens as it first did.
  const h = messagesHarness(visit("thread-visit", true));
  h.render();
  expect(h.element.scrollTop).toBe(3400);
  h.snapshot.replies = [threadReply("d", row.id)];
  h.render();
  expect(places.has("thread-visit:thread")).toBe(false);
  h.unmount();
  expect(places.has("thread-visit:thread")).toBe(true);
});

it("a reader still shown after its route is withdrawn records its place when it leaves", async () => {
  const { visit } = visitPlaces();
  // Rows sit below the scroller top, so the reader's first row anchors it.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  const h = messagesHarness(visit("thread-visit"));
  h.snapshot.replies = [threadReply("d", row.id)];
  const props = h.props as ThreadPanelProps;
  Object.assign(props, { retainThread: true });
  h.render();
  expect(h.element.scrollTop).toBe(3400);
  // A link in the timeline routes elsewhere; the thread stays open beside it
  // and the reader keeps scrolling.
  Object.assign(props, { navigation: undefined });
  h.rerenderProps();
  h.scroll(1000);
  Object.assign(props, { navigation: visit("thread-visit", true) });
  await act(async () => h.rerenderProps());
  expect(h.view.retarget).toHaveBeenCalledOnce();
  expect(h.element.scrollTop).toBe(1000);
});

it.each([
  ["withdrawn, then hidden", ["navigation", "active"]],
  ["hidden, then withdrawn", ["active", "navigation"]],
] as const)(
  "a reader %s is shown again at its place, which the returning route keeps",
  async (_, order) => {
    const { visit } = visitPlaces();
    const reply = threadReply("d", row.id);
    layOutRows([row.id, reply.id]);
    const h = messagesHarness(visit("thread-visit"));
    h.snapshot.replies = [reply];
    const props = h.props as ThreadPanelProps;
    Object.assign(props, { retainThread: true });
    h.render();
    h.scroll(1000);
    // Back to the channel withdraws the route and closes the pane around it.
    for (const prop of order) {
      Object.assign(props, { [prop]: prop === "active" ? false : undefined });
      h.rerenderProps();
    }
    // WebKit drops the hidden reader's scroll offset.
    h.element.scrollTop = 0;
    // Forward shows it again before the route lands.
    Object.assign(props, { active: true });
    h.rerenderProps();
    expect(h.element.scrollTop).toBe(1000);
    Object.assign(props, { navigation: visit("thread-visit", true) });
    await act(async () => h.rerenderProps());
    expect(h.view.retarget).toHaveBeenCalledOnce();
    expect(h.element.scrollTop).toBe(1000);
  },
);

it("a withdrawn reader shown again records where it then reads", async () => {
  const { visit } = visitPlaces();
  const reply = threadReply("d", row.id);
  layOutRows([row.id, reply.id]);
  const h = messagesHarness(visit("thread-visit"));
  h.snapshot.replies = [reply];
  const props = h.props as ThreadPanelProps;
  Object.assign(props, { retainThread: true });
  h.render();
  h.scroll(1000);
  // A timeline link withdraws the route. The pane is closed and reopened
  // around the thread, and the reader scrolls on before going Back.
  Object.assign(props, { navigation: undefined });
  h.rerenderProps();
  Object.assign(props, { active: false });
  h.rerenderProps();
  Object.assign(props, { active: true });
  h.rerenderProps();
  h.scroll(2000);
  Object.assign(props, { navigation: visit("thread-visit", true) });
  await act(async () => h.rerenderProps());
  expect(h.view.retarget).toHaveBeenCalledOnce();
  expect(h.element.scrollTop).toBe(2000);
});

it("a reader first shown while its route retargets stays hidden until the route restores its place", async () => {
  const { places, visit } = visitPlaces();
  places.set("thread-visit:thread", {
    anchor: { id: row.id, top: 100, ancestors: [] },
  });
  const h = messagesHarness();
  h.snapshot.status = "loading";
  const props = h.props as ThreadPanelProps;
  Object.assign(props, { retainThread: true });
  h.render();
  let release!: (value: "selected") => void;
  h.view.retarget.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  Object.assign(props, { navigation: visit("thread-visit", true) });
  h.rerenderProps();
  try {
    expect(h.view.retarget).toHaveBeenCalledOnce();
    // The first page lands: the reader positions at the end, out of sight.
    h.snapshot.status = "ready";
    h.render();
    expect(h.element.scrollTop).toBe(3400);
    expect(h.element).toHaveAttribute("data-positioning");
  } finally {
    await act(async () => release("selected"));
  }
  expect(h.element).not.toHaveAttribute("data-positioning");
  expect(h.element.scrollTop).toBe(3300);
});

it("a reader hidden while its route retargets reads nothing until the route restores its place", async () => {
  vi.useFakeTimers();
  const { places, visit } = visitPlaces();
  places.set("thread-visit:thread", {
    anchor: { id: row.id, top: 100, ancestors: [] },
  });
  const h = messagesHarness();
  h.snapshot.status = "loading";
  h.snapshot.replies = [threadReply("d", row.id)];
  vi.mocked(document.hasFocus).mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  const observe = vi.fn(async () => {});
  const catchUp = vi.fn(async () => {});
  Object.assign(h.session.unread, {
    sync: () => ({ capability: "frontier-sync" }),
    reading: () => ({ view() {}, observe, catchUp, dispose() {} }),
  });
  const props = h.props as ThreadPanelProps;
  Object.assign(props, { retainThread: true });
  h.render();
  let release!: (value: "selected") => void;
  h.view.retarget.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  Object.assign(props, { navigation: visit("thread-visit", true) });
  h.rerenderProps();
  try {
    // The first page lands at the end behind the loader, with focus inside.
    h.snapshot.status = "ready";
    h.render();
    expect(h.element.scrollTop).toBe(3400);
    h.element.focus();
    await act(() => vi.advanceTimersToNextFrame());
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(catchUp).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  } finally {
    await act(async () => release("selected"));
  }
  // The restored place is read, not the end the reader never saw.
  expect(h.element.scrollTop).toBe(3300);
  await act(() => vi.advanceTimersToNextFrame());
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(observe).toHaveBeenCalled();
  expect(catchUp).not.toHaveBeenCalled();
});

it("an unrouted retained opening retries allocation locally", () => {
  const h = messagesHarness();
  const navigationRetry = vi.fn();
  h.thread
    .mockReset()
    .mockImplementationOnce(() => {
      throw new Error("capacity");
    })
    .mockReturnValue(h.view);
  render(
    <ThreadPanel
      {...h.props}
      retainThread
      onRetryNavigation={navigationRetry}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This thread didn’t load.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("region", { name: "Composer" })).toBeVisible();
  expect(navigationRetry).not.toHaveBeenCalled();
  expect(h.thread).toHaveBeenCalledTimes(2);
});

it("releases bottom following after a jump that included child-only resizing", () => {
  vi.useFakeTimers();
  const h = messagesHarness();
  h.render();
  h.scroll(2000);
  fireEvent.click(screen.getByRole("button", { name: /Jump to latest/ }));
  h.resize(4200);
  h.deliverResize();
  act(() => vi.advanceTimersByTime(1000));
  expect(h.element.scrollTop).toBe(3600);
  // The completed jump must not leave a stale geometry guard swallowing this scroll.
  h.scroll(2000);
  h.resize(4300);
  h.snapshot.replies = [{ ...row, id: "new", content: "new" }];
  h.render();
  expect(h.element.scrollTop).toBe(2000);
});

it("reveals a completed step selected by an exact thread link", async () => {
  const h = messagesHarness();
  const target = {
    ...row,
    id: "d".repeat(64),
    content: "Completed tool result",
    audience: "agents" as const,
    threadRootId: row.id,
    replyParentId: row.id,
    createdAt: 2,
  };
  h.snapshot.replies = [
    target,
    {
      ...row,
      id: "e".repeat(64),
      content: "Final response",
      threadRootId: row.id,
      replyParentId: row.id,
      createdAt: 3,
    },
  ];
  h.snapshot.target = target;
  h.snapshot.targetStatus = "ready";
  Object.assign(h.props, {
    messageId: target.id,
    retainThread: true,
    revealSelected: true,
    revealRequest: 1,
  });
  h.render();
  expect(await screen.findByText("Completed tool result")).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Collapse activity history/ }),
  ).toBeVisible();
});
