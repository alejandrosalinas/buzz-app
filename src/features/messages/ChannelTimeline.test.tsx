import { Button } from "../../shared/design-system/ui/Button";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Virtualizer } from "virtua";
import { ChannelTimeline } from "./ChannelTimeline";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { createAgentLibrary } from "../agents/library";
import { createRelaySession } from "../relay/session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
} from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import type { RelaySession } from "../relay/session";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";

// Boundary test, not a browser renderer. Capture this production component's
// effects/refs and invoke its returned DOM handlers. Deliberately stale Virtua
// metrics reproduce the event ordering measured separately in Chromium/WebKit.
// Reading geometry/dwell has its own real-hook boundary suite. This fixture
// deliberately supplies only the DOM shape needed for positioning.
// Activity rendering/subscriptions have their own mounted integration suite.
vi.mock("./TypingIndicator", () => ({
  TypingIndicator: () => null,
  useLiveConversationAgents: () => [],
}));
vi.mock("./use-reading", () => ({
  useReading: vi.fn(),
  readingPositioned: vi.fn(),
}));
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  memos: [] as { deps: readonly unknown[]; value: unknown }[],
  effects: [] as {
    deps: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }[],
  pending: [] as (() => void)[],
  ref: 0,
  state: 0,
  memo: 0,
  effect: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef(value: unknown) {
    const index = hooks.ref++;
    hooks.refs[index] ??= { current: value };
    return hooks.refs[index];
  },
  useState(initial: unknown) {
    const index = hooks.state++;
    if (!(index in hooks.states))
      hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] = value;
      },
    ];
  },
  useCallback(value: unknown, deps: readonly unknown[]) {
    const index = hooks.memo++;
    const old = hooks.memos[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.memos[index] = { deps, value };
    return hooks.memos[index]?.value;
  },
  useMemo(factory: () => unknown, deps: readonly unknown[]) {
    const index = hooks.memo++;
    const old = hooks.memos[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.memos[index] = { deps, value: factory() };
    return hooks.memos[index]?.value;
  },
  useEffect(create: () => (() => void) | undefined, deps: readonly unknown[]) {
    const index = hooks.effect++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.pending.push(() => {
        old?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: create() };
      });
  },
  useLayoutEffect(
    create: () => (() => void) | undefined,
    deps: readonly unknown[],
  ) {
    const index = hooks.effect++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) {
      hooks.pending.push(() => {
        old?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: create() };
      });
    }
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
  // Rendered outside a provider, as the timeline's direct calls are.
  useContext: () => undefined,
}));
vi.mock("../relay/react", () => ({
  useRowProfiles: () => new Map(),
}));
afterEach(() => vi.unstubAllGlobals());

const timelineMessage = (id: string): ChannelMessage => ({
  id,
  channelId: "channel",
  authorId: "author",
  content: "",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
});

function setup({
  freshness = "verified" as NonNullable<ChannelWindow["freshness"]>,
  status = "ready" as ChannelWindow["status"],
  blocked = undefined as boolean | undefined,
  session = undefined as RelaySession | undefined,
  continuityKey = undefined as string | undefined,
  historyControl = "button" as "button" | "scroll",
  hasMore = false,
  loadingOlder = false,
  historyLimited = false,
  error = undefined as string | undefined,
  recovering = false,
  initial = undefined as unknown,
  mounted = [] as { id: string; y: number }[],
  initialRows = undefined as ChannelMessage[] | undefined,
} = {}) {
  Object.assign(hooks, {
    refs: [],
    states: [],
    memos: [],
    effects: [],
    pending: [],
    ref: 0,
    state: 0,
    memo: 0,
    effect: 0,
  });
  const data = new Map<string, string>();
  if (initial !== undefined)
    data.set(
      'buzz-view.v1:["scope","scroll:channel"]',
      JSON.stringify(initial),
    );
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const observers = new Map<() => void, Set<unknown>>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<unknown>();
      constructor(callback: () => void) {
        observers.set(callback, this.targets);
      }
      observe(target: unknown) {
        this.targets.add(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  const resized = (target: unknown) => {
    for (const [callback, targets] of observers)
      if (targets.has(target)) callback();
  };
  const mutations = new Map<
    (records: MutationRecord[]) => void,
    Map<unknown, MutationObserverInit>
  >();
  vi.stubGlobal(
    "MutationObserver",
    class {
      targets = new Map<unknown, MutationObserverInit>();
      constructor(callback: (records: MutationRecord[]) => void) {
        mutations.set(callback, this.targets);
      }
      observe(target: unknown, options: MutationObserverInit) {
        this.targets.set(target, options);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  const list = { style: { height: "3706px", pointerEvents: "" } };
  const styleChanged = () => {
    for (const [callback, targets] of mutations) {
      const options = targets.get(list);
      if (options?.attributes && options.attributeFilter?.includes("style"))
        callback([
          { type: "attributes", attributeName: "style" } as MutationRecord,
        ]);
    }
  };
  const element = {
    clientWidth: 1124,
    clientHeight: 668,
    scrollHeight: 3706,
    scrollTop: 2388,
    ownerDocument: Object.assign(new EventTarget(), {
      defaultView: new EventTarget(),
    }),
    focus: vi.fn(),
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => list,
    querySelectorAll: () =>
      mounted.map(({ id, y }) => ({
        dataset: { messageId: id },
        getBoundingClientRect: () => ({ top: y, bottom: y + 100 }),
        querySelector: () => ({
          getBoundingClientRect: () => ({ top: y + 32, bottom: y + 80 }),
        }),
      })),
  };
  const handle = {
    scrollOffset: 3038,
    scrollSize: 3649.5,
    viewportSize: 668,
    cache: [],
    findItemIndex: () => 0,
    getItemOffset: () => 0,
    scrollTo: vi.fn(),
    scrollToIndex: vi.fn(),
  };
  blocked ??= freshness === "cached";
  let accepted = false;
  const olderReads = vi.fn();
  const snapshot = (): ChannelWindow => ({
    channelId: "channel",
    status,
    freshness,
    rows,
    hasMore,
    loadingOlder: loadingOlder || accepted,
    historyLimited,
    error,
  });
  const loadOlder = vi.fn(() => {
    if (!blocked && !accepted && !loadingOlder) {
      accepted = true;
      olderReads();
    }
  });
  let queries =
    session ??
    ({
      channels: { loadOlder, window: snapshot },
      profiles: {},
      agentChoices: createAgentLibrary(undefined).queries,
      // Geometry fixtures are read-only; reading behavior has its own boundary tests.
      unread: { sync: () => ({ capability: "unsupported" }) },
      media: () => undefined,
      recovery: {
        snapshot: () => ({
          recovering,
          attempt: 0,
          shown: false,
          reauthorized: 0,
        }),
        subscribe: () => () => {},
      },
    } as unknown as RelaySession);
  let rows = initialRows ?? [timelineMessage("first"), timelineMessage("last")];
  type Section = ReactElement<{
    ref: { current: unknown };
    "data-jump-visible": true | undefined;
    children: unknown[];
    onScroll: (event: unknown) => void;
    onScrollEnd: (event: unknown) => void;
    onPointerDown: () => void;
    onPointerUp: () => void;
    onWheel: (event: { deltaY: number; ctrlKey: boolean }) => void;
    onFocus: (event: unknown) => void;
    onBlur: (event: unknown) => void;
  }>;
  let section: Section;
  let channelId = "channel";
  let revealMessageId: string | undefined;
  let key: string | null = null;
  const flush = () => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  };
  function render(runFrames = true) {
    hooks.ref = hooks.state = hooks.memo = hooks.effect = 0;
    const scoped = ChannelTimeline({
      channelId,
      historyControl,
      scope: "scope",
      queries,
      continuityKey,
      window: session?.channels.window(channelId) ?? {
        channelId,
        status,
        freshness,
        error,
        rows,
        hasMore,
        loadingOlder,
        historyLimited,
      },
      onOpenLink: () => false,
      revealMessageId,
    });
    if (key !== null && key !== scoped.key) {
      for (const effect of hooks.effects) effect.cleanup?.();
      Object.assign(hooks, {
        refs: [],
        states: [],
        memos: [],
        effects: [],
        pending: [],
      });
    }
    key = scoped.key;
    section = (scoped.type as (props: typeof scoped.props) => Section)(
      scoped.props,
    );
    section.props.ref.current = element;
    const edge = section.props.children[0] as ReactElement<{
      ref: { current: unknown };
    }>;
    edge.props.ref.current = {
      get clientWidth() {
        return element.clientWidth;
      },
      getBoundingClientRect: () => ({ height: 0 }),
    };
    const virtualizer = section.props.children.find(
      (child) =>
        !!child &&
        typeof child === "object" &&
        "type" in child &&
        child.type === Virtualizer,
    ) as ReactElement<{ ref: { current: unknown } }>;
    if (virtualizer) virtualizer.props.ref.current = handle;
    for (const effect of hooks.pending.splice(0)) effect();
    if (runFrames) flush();
  }
  render(); // Mount/measure through the production layout effect.
  render(); // Apply its setWidth before attaching the virtualizer.
  return {
    element,
    handle,
    focus(id?: string) {
      section.props.onFocus({
        target: { closest: () => (id ? { dataset: { messageId: id } } : null) },
      });
      render();
    },
    blur(inside: boolean) {
      section.props.onBlur({
        currentTarget: { contains: () => inside },
        relatedTarget: null,
      });
      render();
    },
    pinned() {
      const virtualizer = section.props.children.find(
        (child) =>
          !!child &&
          typeof child === "object" &&
          "type" in child &&
          child.type === Virtualizer,
      ) as ReactElement<{ keepMounted: number[] }>;
      return virtualizer.props.keepMounted;
    },
    loadOlder,
    olderReads,
    flush,
    render,
    unblock() {
      blocked = false;
    },
    reveal(id: string) {
      revealMessageId = id;
      render();
    },
    navigate(next: string) {
      channelId = next;
      render();
      render();
    },
    update(patch: Partial<ChannelWindow>) {
      accepted = false;
      if (patch.freshness) freshness = patch.freshness;
      if (patch.freshness === "verified") blocked = false;
      if ("status" in patch && patch.status) status = patch.status;
      if ("error" in patch) error = patch.error;
      if ("loadingOlder" in patch) loadingOlder = !!patch.loadingOlder;
      if ("hasMore" in patch) hasMore = !!patch.hasMore;
      if ("historyLimited" in patch) historyLimited = !!patch.historyLimited;
      render();
    },
    hasHistoryButton() {
      const edge = section.props.children[0] as ReactElement<{
        children: ReactElement[];
      }>;
      return edge.props.children.some((child) => child?.type === Button);
    },
    /** The edge's alert text, if any. */
    alert() {
      const edge = section.props.children[0] as ReactElement<{
        children: ReactElement<{ role?: string; children: unknown }>[];
      }>;
      return edge.props.children.find(
        (child) => child?.type === "span" && child.props.role === "alert",
      )?.props.children;
    },
    /** The edge's history button label, if any. */
    historyButton() {
      const edge = section.props.children[0] as ReactElement<{
        children: ReactElement<{ children: unknown }>[];
      }>;
      return edge.props.children.find((child) => child?.type === Button)?.props
        .children;
    },
    /** The edge's plain caption text, if any (not its alert or status). */
    caption() {
      const edge = section.props.children[0] as ReactElement<{
        children: ReactElement<{ role?: string; children: unknown }>[];
      }>;
      return edge.props.children.find(
        (child) => child?.type === "span" && !child.props.role,
      )?.props.children;
    },
    /** Replaces the session, as reconnecting does under a stable continuityKey. */
    swap(next: RelaySession) {
      session = next;
      queries = next;
      render();
    },
    retry() {
      const edge = section.props.children[0] as ReactElement<{
        children: ReactElement[];
      }>;
      const button = edge.props.children.find(
        (child) => child?.type === Button,
      ) as ReactElement<{ onClick(): void }>;
      button.props.onClick();
    },
    resize(runFrames = true) {
      resized(element);
      render(runFrames);
    },
    measureRows(runFrames = true) {
      list.style.height = `${Number.parseFloat(list.style.height) + 100}px`;
      styleChanged();
      if (runFrames) flush();
    },
    scrollStyle() {
      list.style.pointerEvents = list.style.pointerEvents ? "" : "none";
      styleChanged();
      flush();
    },
    gesture(upward = false) {
      if (upward) section.props.onWheel({ deltaY: -300, ctrlKey: false });
      else section.props.onPointerDown();
    },
    dispatchScroll() {
      section.props.onScroll({ currentTarget: element });
    },
    scrollEnd() {
      section.props.onScrollEnd({ currentTarget: element });
    },
    scroll(user = true) {
      resized(element);
      render();
      if (user) section.props.onPointerDown();
      section.props.onScroll({ currentTarget: element });
      if (user) section.props.onPointerUp();
    },
    edit(runFrames = true) {
      rows = rows.map((row) =>
        row.id === "last" ? { ...row, content: "Longer edited message" } : row,
      );
      render(runFrames);
    },
    setRows(next: ChannelMessage[], runFrames = true) {
      rows = next;
      render(runFrames);
    },
    prepend() {
      rows = [timelineMessage("older"), ...rows];
      render();
    },
    append() {
      rows = [...rows, timelineMessage("appended")];
      render();
    },
    jumpToLatest() {
      const button = section.props.children.find(
        (child) =>
          !!child &&
          typeof child === "object" &&
          "type" in child &&
          child.type === JumpToLatestButton &&
          (child as ReactElement<{ visible: boolean }>).props.visible,
      ) as ReactElement<{ onClick(): void }> | undefined;
      button?.props.onClick();
    },
    hasJumpToLatest() {
      const visible = section.props.children.some(
        (child) =>
          !!child &&
          typeof child === "object" &&
          "type" in child &&
          child.type === JumpToLatestButton &&
          (child as ReactElement<{ visible: boolean }>).props.visible,
      );
      // The feed carries the same state for the composer-context edge.
      expect(section.props["data-jump-visible"]).toBe(visible || undefined);
      return visible;
    },
    unmount() {
      for (const effect of hooks.effects) effect.cleanup?.();
    },
    saved() {
      const raw = data.get('buzz-view.v1:["scope","scroll:channel"]');
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

it("pins only the focused message by identity across prepend and releases on focus exit", () => {
  const h = setup();
  expect(h.pinned()).toEqual([]);
  h.focus("last");
  expect(h.pinned()).toEqual([1]);
  h.prepend();
  expect(h.pinned()).toEqual([2]);
  h.blur(true);
  expect(h.pinned()).toEqual([2]);
  h.focus("first");
  expect(h.pinned()).toEqual([1]);
  h.blur(false);
  expect(h.pinned()).toEqual([]);
  h.focus("last");
  h.focus(); // The history region itself is not a message row.
  expect(h.pinned()).toEqual([]);
  h.focus("last");
  h.setRows([]);
  expect(h.pinned()).toEqual([]);
  h.unmount();
});

it("persists the event target's reading position at real component cleanup, not the previous virtualizer offset", () => {
  const h = setup();
  h.scroll();
  h.unmount();
  expect(h.saved()).toEqual({ bottom: false });
});
it("a bottom-position event persists bottom intent even when the virtualizer still reports zero", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.handle.scrollOffset = 0;
  h.scroll(false);
  h.unmount();
  expect(h.saved()).toEqual({ bottom: true });
});
// A following reader's place is written once: the row under their viewport
// changes with every live message, but a bottom place restores without it.
it("writes a following reader's place once across live messages, and again when their place changes", () => {
  const mounted = [{ id: "last", y: 42 }];
  const h = setup({ mounted });
  const setItem = vi.spyOn(localStorage, "setItem");
  h.element.scrollTop = 3038;
  h.scroll(false);
  h.scrollEnd();
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(h.saved()).toEqual({ bottom: true });
  for (const y of [60, 75]) {
    h.append();
    mounted.splice(0, 1, { id: "appended", y });
    h.element.scrollHeight += 100;
    h.element.scrollTop += 100;
    h.dispatchScroll();
    h.scrollEnd();
  }
  expect(setItem).toHaveBeenCalledTimes(1);
  // Reading back up is a new place.
  h.element.scrollTop = 2388;
  h.scroll();
  h.scrollEnd();
  expect(setItem).toHaveBeenCalledTimes(2);
  expect(h.saved()).toMatchObject({
    bottom: false,
    anchor: { id: "appended" },
  });
  h.unmount();
  expect(setItem).toHaveBeenCalledTimes(2);
});
it("retries a place whose write failed", () => {
  const h = setup();
  const setItem = vi
    .spyOn(localStorage, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("quota");
    });
  h.element.scrollTop = 3038;
  h.scroll(false);
  h.scrollEnd();
  expect(h.saved()).toBeUndefined();
  h.unmount();
  expect(setItem).toHaveBeenCalledTimes(2);
  expect(h.saved()).toEqual({ bottom: true });
});
it("an append follows the actual bottom position, not stale virtualizer position", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.handle.scrollOffset = 0;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.append();
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(2, { align: "end" });
  h.unmount();
});
it("an append does not steal a reading position when virtualizer still reports bottom", () => {
  const h = setup();
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.append();
  h.render();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  expect(h.hasJumpToLatest()).toBe(true);
  h.jumpToLatest();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.render();
  expect(h.hasJumpToLatest()).toBe(false);
  h.unmount();
});
it("reader input retires a pending jump so a live append cannot pull the reader back", () => {
  const h = setup();
  h.scroll();
  h.render();
  expect(h.hasJumpToLatest()).toBe(true);
  h.handle.scrollToIndex.mockClear();
  h.jumpToLatest();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.element.scrollTop = 3038;
  h.dispatchScroll();
  // The reader wheels back up while Virtua could still re-apply the jump.
  h.element.scrollTop = 2538;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.append();
  h.render();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  expect(h.hasJumpToLatest()).toBe(true);
  h.unmount();
});
it("loads older rows at the current DOM threshold despite a stale far-away virtualizer offset", () => {
  const h = setup({ hasMore: true });
  h.handle.scrollOffset = 3300;
  h.scroll();
  expect(h.loadOlder).toHaveBeenCalledExactlyOnceWith("channel");
  h.unmount();
});
it("does not load older rows when only the old virtualizer position is inside the threshold", () => {
  const h = setup({ hasMore: true });
  h.element.scrollHeight = 8000;
  h.element.scrollTop = 3300;
  h.handle.scrollOffset = 2388;
  h.scroll();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});
it.each([
  { hasMore: false },
  { hasMore: true, loadingOlder: true },
  { hasMore: true, historyLimited: true },
  { hasMore: true, error: "Relay requests paused" },
])("keeps the existing paging guard %j", (options) => {
  const h = setup(options);
  h.scroll();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});
it("programmatic scroll does not page before a user gesture", () => {
  const h = setup({ hasMore: true });
  h.scroll(false);
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});

it.each([
  { height: 668, gap: 79, bottom: true },
  { height: 668, gap: 80, bottom: false },
  { height: 1000, gap: 79, bottom: true },
  { height: 1000, gap: 80, bottom: false },
])(
  "uses current geometry for the strict bottom threshold: $height/$gap",
  ({ height, gap, bottom }) => {
    const h = setup();
    h.element.clientHeight = height;
    h.element.scrollTop = h.element.scrollHeight - h.element.clientHeight - gap;
    h.scroll();
    h.unmount();
    expect(h.saved()).toEqual({ bottom });
  },
);
it.each([
  { height: 668, offset: 2999, calls: 1 },
  { height: 668, offset: 3000, calls: 0 },
  { height: 1000, offset: 3999, calls: 1 },
  { height: 1000, offset: 4000, calls: 0 },
])(
  "uses current viewport for the strict max(3000, 4×height) paging boundary: $height/$offset",
  ({ height, offset, calls }) => {
    const h = setup({ hasMore: true });
    Object.assign(h.element, {
      clientHeight: height,
      scrollHeight: 8000,
      scrollTop: offset,
    });
    h.scroll();
    expect(h.loadOlder).toHaveBeenCalledTimes(calls);
    h.unmount();
  },
);

it("restores a saved message anchor instead of an unreachable cold pixel offset", () => {
  const h = setup({
    initial: { offset: 80851, bottom: false, anchor: { id: "last", y: 42 } },
  });
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(1, {
    align: "start",
    offset: -42,
  });
  expect(h.handle.scrollTo).not.toHaveBeenCalled();
  h.unmount();
});
it("a restoration scroll through unmeasured rows does not become bottom follow", () => {
  const h = setup({
    mounted: [{ id: "last", y: 42 }],
    initial: { offset: 80851, bottom: false, anchor: { id: "last", y: 42 } },
  });
  // Virtua's scroll event lands at the estimated bottom before rows measure.
  h.element.scrollTop = 3038;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.setRows([timelineMessage("first"), timelineMessage("last")]);
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalledWith(1, { align: "end" });
  h.unmount();
  expect(h.saved()).toMatchObject({
    bottom: false,
    anchor: { id: "last" },
  });
});
it("opens a legacy position without an anchor at the latest message, not a pixel offset", () => {
  const h = setup({ initial: { offset: 1234, bottom: false } });
  expect(h.handle.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  expect(h.handle.scrollTo).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved()).toEqual({ bottom: true });
});
// On reload the saved IndexedDB head mounts first; the network head and notice
// rows that may hold the saved row arrive in later rows.
it("follows the latest message while a saved row is still loading, then restores it when it arrives", () => {
  const h = setup({
    initialRows: [timelineMessage("old")],
    initial: { bottom: false, anchor: { id: "anchor", y: 42 } },
  });
  expect(h.handle.scrollToIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  expect(h.handle.scrollTo).not.toHaveBeenCalled();
  // The timeline's own end scroll must not replace the pending place.
  h.scroll(false);
  expect(h.handle.scrollToIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  h.setRows([
    timelineMessage("old"),
    timelineMessage("anchor"),
    timelineMessage("new"),
  ]);
  expect(h.handle.scrollToIndex).toHaveBeenLastCalledWith(1, {
    align: "start",
    offset: -42,
  });
  h.unmount();
  expect(h.saved()).toMatchObject({
    bottom: false,
    anchor: { id: "anchor", y: 42 },
  });
});
// Notice rows fill in after each head, above the messages already shown.
it("restores a saved row on the render that inserts it above the loaded rows", () => {
  const h = setup({
    initialRows: [timelineMessage("old")],
    initial: { bottom: false, anchor: { id: "anchor", y: 42 } },
  });
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.setRows([timelineMessage("anchor"), timelineMessage("old")]);
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(0, {
    align: "start",
    offset: -42,
  });
  h.unmount();
  expect(h.saved()).toMatchObject({
    bottom: false,
    anchor: { id: "anchor", y: 42 },
  });
});
it.each(["wheel", "pointer"])(
  "%s reader input while a saved row is loading retires it, so its arrival does not move the reader",
  (input) => {
    const h = setup({
      initialRows: [timelineMessage("old")],
      initial: { bottom: false, anchor: { id: "anchor", y: 42 } },
    });
    h.scroll(false);
    h.gesture(input === "wheel");
    h.handle.scrollToIndex.mockClear();
    h.setRows([timelineMessage("old"), timelineMessage("anchor")]);
    expect(h.handle.scrollToIndex).not.toHaveBeenCalledWith(1, {
      align: "start",
      offset: -42,
    });
    h.unmount();
    expect(h.saved()).not.toMatchObject({ anchor: { id: "anchor" } });
  },
);
it("keeps a placed reader in place when a resize finds their saved row gone", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.setRows([timelineMessage("first")]);
  h.handle.scrollToIndex.mockClear();
  h.element.clientWidth = 650;
  h.resize();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  expect(h.handle.scrollTo).not.toHaveBeenCalled();
});
it("captures the mounted message at cleanup and restores that anchor after resize", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.element.clientWidth = 650;
  h.resize();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "start",
    offset: -42,
  });
  h.unmount();
  expect(h.saved()).toEqual({
    bottom: false,
    anchor: { id: "last", y: 42 },
  });
});
it("resize-generated scroll retains the restored message when its paragraph no longer fits", () => {
  const mounted = [{ id: "last", y: 42 }];
  const h = setup({ mounted });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  // The preferred row remains visible, but no longer wholly fits. A preceding
  // clipped row would otherwise replace it during restoration-generated scroll.
  h.element.clientHeight = 100;
  mounted.unshift({ id: "first", y: -20 });
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.element.clientWidth = 1124;
  h.resize();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "start",
    offset: -42,
  });
  h.unmount();
  expect(h.saved().anchor).toEqual({ id: "last", y: 42 });
});
it("a new gesture can replace the restored anchor", () => {
  const mounted = [{ id: "last", y: 42 }];
  const h = setup({ mounted });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  mounted.unshift({ id: "first", y: 0 });
  h.scroll();
  h.unmount();
  expect(h.saved().anchor).toEqual({ id: "first", y: 0 });
});
it("local-send navigation releases the restored anchor", () => {
  const mounted = [{ id: "last", y: 42 }];
  const h = setup({ mounted });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  mounted.unshift({ id: "first", y: 0 });
  h.reveal("first");
  // At the bottom, a retained anchor would still hold the place above it.
  h.element.scrollTop = 3038;
  h.scroll(false);
  h.unmount();
  expect(h.saved()).toEqual({ bottom: true });
});
it.each([-200, 800])(
  "a restored row outside the viewport (%s) is not preferred",
  (y) => {
    const mounted = [{ id: "last", y: 42 }];
    const h = setup({ mounted });
    h.scroll();
    h.element.clientWidth = 650;
    h.resize();
    mounted.splice(0, 1, { id: "last", y });
    mounted.push({ id: "first", y: 0 });
    h.scroll(false);
    h.unmount();
    expect(h.saved().anchor).toEqual({ id: "first", y: 0 });
  },
);
it("an unmounted restored anchor falls back to a visible message", () => {
  const mounted = [{ id: "last", y: 42 }];
  const h = setup({ mounted });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  mounted.splice(0, 1, { id: "first", y: 0 });
  h.scroll(false);
  h.unmount();
  expect(h.saved().anchor).toEqual({ id: "first", y: 0 });
});
it("a gesture after resize cancels queued restoration instead of fighting the reader", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.element.clientWidth = 650;
  h.resize(false);
  h.gesture();
  h.flush();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});

it("a same-ID content update follows bottom without waiting for another message", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.edit();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.unmount();
});
it("same-ID content updates leave an above-bottom reader to virtualizer anchoring", () => {
  const h = setup();
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.edit();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("prepending history does not become a follow-to-bottom command", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.prepend();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("a new gesture wins over content-follow scheduled by an edit", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.edit(false);
  h.gesture();
  h.flush();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});

it("a user gesture at a restored top pages without needing a DOM scroll event", () => {
  const h = setup({ hasMore: true, initial: { offset: 0, bottom: false } });
  h.element.scrollTop = 0;
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.gesture();
  expect(h.loadOlder).toHaveBeenCalledExactlyOnceWith("channel");
  h.unmount();
});

it.each([{ hasMore: false }])(
  "a boundary gesture preserves the history guard %j",
  (options) => {
    const h = setup(options);
    h.element.scrollTop = 0;
    h.gesture();
    expect(h.loadOlder).not.toHaveBeenCalled();
    h.unmount();
  },
);

it("keeps bottom restoration through repeated late list measurements without another viewport resize", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  // The viewport and rows are unchanged; only Virtua's measured list reflows.
  h.measureRows();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledTimes(2);
  expect(h.handle.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  h.unmount();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
});
it("ignores non-height list styles and coalesces measured height changes", () => {
  const h = setup();
  h.handle.scrollToIndex.mockClear();
  h.scrollStyle();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.measureRows(false);
  h.measureRows(false);
  h.flush();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.handle.scrollToIndex.mockClear();
  h.scrollStyle(); // The new height has already been consumed.
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.measureRows(false);
  h.unmount();
  h.flush();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
});
it.each([false, true])(
  "a new gesture cancels late bottom reflow, including queued=%s",
  (queued) => {
    const h = setup();
    h.element.scrollTop = 3038;
    h.scroll();
    h.element.clientWidth = 650;
    h.resize();
    h.handle.scrollToIndex.mockClear();
    if (queued) h.measureRows(false);
    h.gesture();
    if (queued) h.flush();
    else h.measureRows();
    expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
    h.unmount();
  },
);
it("late measurements restore the reading anchor instead of converting it to bottom follow", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "start",
    offset: -42,
  });
  h.handle.scrollToIndex.mockClear();
  h.measureRows(false);
  h.gesture();
  h.flush();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("prepending retires the preceding bottom-reflow observer and its queued frame", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  h.measureRows(false);
  h.prepend();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});

it("initial bottom and ordinary appends follow late measured list reflow", () => {
  const h = setup();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
});

it("keeps bottom follow through an upward virtualizer correction during late growth", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 1400;
  h.resize();
  h.element.scrollHeight += 120;
  h.element.scrollTop -= 3;
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  h.dispatchScroll();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("keeps bottom follow when the virtualizer correction scrolls after its height commit", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 1400;
  h.resize();
  h.element.scrollHeight += 120;
  h.handle.scrollToIndex.mockClear();
  h.measureRows(false);
  // The browser delivers the correction's scroll before the restore frame.
  h.element.scrollTop -= 1;
  h.dispatchScroll();
  h.flush();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("a reader drag after a height commit still stops bottom follow", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.element.scrollHeight += 120;
  h.measureRows(false);
  h.element.scrollTop -= 200;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.flush();
  h.append();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("keeps bottom follow when a rows change lands between the height commit and its correction scroll", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 1400;
  h.resize();
  h.element.scrollHeight += 120;
  h.handle.scrollToIndex.mockClear();
  h.measureRows(false);
  h.edit(false);
  h.element.scrollTop -= 1;
  h.dispatchScroll();
  h.flush();
  expect(h.handle.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("keeps bottom follow when a measured correction scrolls before its height commit", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 1400;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  // Virtua's scrollBy correction lands before the committed list height.
  h.handle.scrollSize -= 118;
  h.element.scrollTop -= 118;
  h.dispatchScroll();
  // Rows below grew in the same measurement, so only a restore reaches bottom.
  h.element.scrollHeight += 200;
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("honors one cached top-edge gesture when the replacement head becomes verified", () => {
  const h = setup({
    hasMore: true,
    freshness: "cached",
    initial: { offset: 0, bottom: false },
  });
  h.element.scrollTop = 0;
  h.gesture();
  h.gesture();
  h.update({ freshness: "cached" }); // A handoff is not successful revalidation.
  expect(h.olderReads).not.toHaveBeenCalled();
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.update({ freshness: "cached" });
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});
it("verification alone never pages a restored top", () => {
  const h = setup({
    hasMore: true,
    freshness: "cached",
    initial: { offset: 0, bottom: false },
  });
  h.element.scrollTop = 0;
  h.scroll(false);
  h.update({ freshness: "verified" });
  expect(h.olderReads).not.toHaveBeenCalled();
  h.unmount();
});
it.each([
  { error: "Head revalidation failed" },
  { error: "Access denied", status: "error" as const },
  { loadingOlder: true },
  { hasMore: false },
  { historyLimited: true },
])("retires cached paging demand on %j, including later recovery", (patch) => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.update(patch);
  h.update({
    freshness: "verified",
    status: "ready",
    error: undefined,
    loadingOlder: false,
    hasMore: true,
    historyLimited: false,
  });
  expect(h.olderReads).not.toHaveBeenCalled();
  h.unmount();
});
it("rechecks current geometry before honoring the cached gesture", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.element.scrollTop = 4000;
  h.update({ freshness: "verified" });
  h.element.scrollTop = 0;
  h.update({ freshness: "verified" });
  expect(h.olderReads).not.toHaveBeenCalled();
  h.unmount();
});
it("gestures during an older read do not queue a following page", () => {
  const h = setup({ hasMore: true });
  h.element.scrollTop = 0;
  h.gesture();
  h.update({ loadingOlder: true });
  h.gesture();
  h.gesture();
  h.update({ loadingOlder: false });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});
it("a manual retry with more history does not revive automatic paging", () => {
  const h = setup({ hasMore: true });
  h.element.scrollTop = 0;
  h.gesture();
  h.update({ loadingOlder: true });
  h.update({ loadingOlder: false, error: "rate-limited", freshness: "cached" });
  h.gesture();
  h.retry();
  h.update({ loadingOlder: true, error: undefined });
  h.gesture();
  h.update({ loadingOlder: false, freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(2);
  h.unmount();
});
it("a blocked button preserves cached gesture until verification accepts one older read", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.retry();
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});
it("unmount drops cached intent before a late successful head", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.unmount();
  h.update({ freshness: "verified" }); // Probe retired refs as well as keyed remount.
  expect(h.olderReads).not.toHaveBeenCalled();
});

it("a switch away and back cannot inherit the first mount's cached gesture", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.navigate("other");
  h.navigate("channel");
  h.update({ freshness: "verified" });
  expect(h.olderReads).not.toHaveBeenCalled();
  h.gesture();
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});

it("cached rows without a head owner page immediately over the normal read path", () => {
  const h = setup({ hasMore: true, freshness: "cached", blocked: false });
  h.element.scrollTop = 0;
  h.gesture();
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});

it.each(["held head", "live handoff", "disconnected"])(
  "real store accepts one older page after cached input: %s",
  async (mode) => {
    const relay = keypair(),
      viewer = keypair();
    const event = message(viewer, "channel", "cached", 20);
    const head = [
      event,
      bounds(relay, "channel", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: event.id },
      }),
    ];
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...scripted.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      {
        prepared: true,
        persistence: {
          read: async () => [
            {
              channelId: "channel",
              savedAt: Date.now(),
              events: head,
              profiles: [],
            },
          ],
          write: async () => {},
          retain: async () => {},
          remove: async () => {},
          clear: async () => {},
          close: () => {},
        },
      },
    );
    const channels = owner.session.channels;
    channels.ensureList();
    scripted
      .next()
      .respond([
        roster(relay, "channel", [viewer.pubkey]),
        metadata(relay, "channel", "Channel"),
      ]);
    await flush();
    channels.ensure("channel");
    await vi.waitFor(() =>
      expect(channels.window("channel").freshness).toBe("cached"),
    );
    const held = scripted.next();
    if (mode === "disconnected") {
      held.respond(head);
      await vi.waitFor(() =>
        expect(channels.window("channel").freshness).toBe("verified"),
      );
      live.state({ status: "connected", routes: [] });
      live.state({ status: "retrying", routes: [] });
      expect(channels.window("channel").freshness).toBe("cached");
    }
    const h = setup({
      session: owner.session,
      initial: { offset: 0, bottom: false },
    });
    h.element.scrollTop = 0;
    try {
      h.gesture();
      h.retry();
      if (mode !== "disconnected") {
        expect(channels.window("channel").loadingOlder).toBe(false);
        expect(scripted.pending).toHaveLength(0);
        let completing = held;
        if (mode === "live handoff") {
          live.established("channel");
          await vi.waitFor(() => expect(held.signal?.aborted).toBe(true));
          completing = scripted.next();
        }
        completing.respond(head);
        await vi.waitFor(() =>
          expect(channels.window("channel").freshness).toBe("verified"),
        );
      }
      h.render();
      expect(channels.window("channel").loadingOlder).toBe(true);
      const older = () =>
        scripted.pending.filter((read) => read.filters[0]?.until !== undefined);
      await vi.waitFor(() => expect(older()).toHaveLength(1));
      expect(older()[0]?.filters[0]).toMatchObject({
        until: 20,
        before_id: event.id,
      });
      h.render();
      expect(older()).toHaveLength(1);
    } finally {
      h.unmount();
      owner.dispose();
    }
  },
);

it("offline top-edge input reads nothing, and the connected session pages once it verifies", async () => {
  const relay = keypair(),
    viewer = keypair();
  const event = message(viewer, "channel", "saved", 20);
  const head = [
    event,
    bounds(relay, "channel", "head", {
      has_more: true,
      next_cursor: { created_at: 20, id: event.id },
    }),
  ];
  const saved = {
    read: async () => [
      { channelId: "channel", savedAt: Date.now(), events: head, profiles: [] },
    ],
    write: async () => {},
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close: () => {},
  };
  // Both sessions share one transport, so every older read is counted here.
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const older = () =>
    scripted.pending.filter((read) => read.filters[0]?.until !== undefined);
  const offline = createRelaySession(scripted.transport, {
    prepared: true,
    cachedOnly: true,
    persistence: {
      ...saved,
      readStartup: async () => ({
        discovery: {
          savedAt: Date.now(),
          relayAuthor: relay.pubkey,
          events: [
            roster(relay, "channel", [viewer.pubkey]),
            metadata(relay, "channel", "Channel"),
          ],
        },
      }),
    },
  });
  let online: ReturnType<typeof createRelaySession> | undefined;
  await offline.restore();
  offline.session.channels.ensure("channel");
  await vi.waitFor(() =>
    expect(offline.session.channels.window("channel")).toMatchObject({
      status: "ready",
      freshness: "cached",
      hasMore: true,
    }),
  );
  const h = setup({
    session: offline.session,
    continuityKey: "relay:1",
    historyControl: "scroll",
    initial: { offset: 0, bottom: false },
  });
  h.element.scrollTop = 0;
  try {
    h.gesture();
    h.render();
    expect(h.caption()).toBe(
      "You can load older messages once Buzz reconnects.",
    );
    await flush();
    expect(older()).toHaveLength(0);
    online = createRelaySession(
      {
        ...scripted.transport,
        subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
      },
      { prepared: true, persistence: saved },
    );
    const channels = online.session.channels;
    channels.ensureList();
    scripted
      .next()
      .respond([
        roster(relay, "channel", [viewer.pubkey]),
        metadata(relay, "channel", "Channel"),
      ]);
    await flush();
    channels.ensure("channel");
    await vi.waitFor(() =>
      expect(channels.window("channel").freshness).toBe("cached"),
    );
    const held = scripted.next();
    // A handoff to a cached head is not verification: the gesture waits.
    h.swap(online.session);
    expect(h.caption()).toBeUndefined();
    expect(older()).toHaveLength(0);
    held.respond(head);
    await vi.waitFor(() =>
      expect(channels.window("channel").freshness).toBe("verified"),
    );
    h.render();
    await vi.waitFor(() => expect(older()).toHaveLength(1));
    expect(older()[0]?.filters[0]).toMatchObject({
      until: 20,
      before_id: event.id,
    });
    h.render();
    expect(older()).toHaveLength(1);
  } finally {
    h.unmount();
    offline.dispose();
    online?.dispose();
  }
});

it("cached rerenders do not reissue a blocked attempt", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  expect(h.loadOlder).toHaveBeenCalledTimes(1);
  h.update({ freshness: "cached" });
  h.update({ freshness: "cached" });
  expect(h.loadOlder).toHaveBeenCalledTimes(1);
  h.unmount();
});
it("an accepted button read retires earlier blocked gesture before verification", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.unblock();
  h.retry();
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});

const membershipRow = (id: string, time: number): ChannelMessage => ({
  id,
  channelId: "channel",
  authorId: "relay",
  createdAt: time,
  content: "",
  membership: { type: "member_joined", actor: "viewer", target: id },
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
});
it("restores an anchor inside a membership group after history joins across a page seam", () => {
  const h = setup({
    initialRows: [
      membershipRow("older", 1),
      membershipRow("anchor", 2),
      membershipRow("newer", 3),
    ],
    initial: { offset: 80851, bottom: false, anchor: { id: "anchor", y: 42 } },
  });
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(0, {
    align: "start",
    offset: -42,
  });
  expect(h.handle.scrollTo).not.toHaveBeenCalled();
  h.handle.scrollToIndex.mockClear();
  h.setRows([
    membershipRow("oldest", 0),
    membershipRow("older", 1),
    membershipRow("anchor", 2),
    membershipRow("newer", 3),
  ]);
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "start",
    offset: -42,
  });
  h.unmount();
});
it("live group growth follows the displayed group index rather than a hidden raw row", () => {
  const first = membershipRow("first", 1),
    second = membershipRow("second", 2);
  const h = setup({ initialRows: [first, second] });
  h.element.scrollTop = 3038;
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.setRows([first, second, membershipRow("third", 3)]);
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(0, { align: "end" });
  h.unmount();
});

it("membership append retains bottom intent across intermediate scroll geometry and another append", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.setRows([first, membershipRow("second", 2)]);
  // List measurements change after the end-scroll. No reader gesture occurred.
  h.element.scrollHeight += 200;
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "end",
  });
  h.handle.scrollToIndex.mockClear();
  h.setRows([first, membershipRow("second", 2), membershipRow("third", 3)]);
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "a reader gesture cancels membership late-follow, queued=%s",
  (queued) => {
    const first = membershipRow("first", 1);
    const h = setup({ initialRows: [first] });
    h.element.scrollTop = 3038;
    h.scroll();
    h.setRows([first, membershipRow("second", 2)]);
    h.handle.scrollToIndex.mockClear();
    if (queued) h.measureRows(false);
    h.gesture();
    h.element.scrollTop = 2000;
    h.scroll();
    h.measureRows();
    h.setRows([first, membershipRow("second", 2), membershipRow("third", 3)]);
    expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
    h.unmount();
    expect(h.saved().bottom).toBe(false);
  },
);

it.each([false, true])(
  "a restored membership anchor survives delayed group growth until a gesture=%s",
  (gesture) => {
    const { membership: _membership, ...preceding } = membershipRow(
      "preceding",
      0,
    );
    const later = { ...preceding, id: "later", createdAt: 4 };
    const rows = [
      preceding,
      membershipRow("anchor", 1),
      membershipRow("representative", 2),
      later,
    ];
    const mounted = [
      { id: "preceding", y: -20 },
      { id: "representative", y: 42 },
    ];
    const h = setup({
      initialRows: rows,
      mounted,
      initial: {
        offset: 80851,
        bottom: false,
        anchor: { id: "anchor", y: 42 },
      },
    });
    expect(h.handle.scrollToIndex).toHaveBeenCalledWith(1, {
      align: "start",
      offset: -42,
    });
    h.scroll(false);
    // A delayed activity row lands inside history, not at the loaded tail.
    // It replaces B's rendered identity with C while retaining A/B as members.
    h.setRows([...rows.slice(0, -1), membershipRow("grown", 3), later]);
    mounted[1] = { id: "grown", y: 42 };
    h.dispatchScroll(); // Reflow, with no reader gesture.
    h.handle.scrollToIndex.mockClear();
    h.element.clientWidth = 650;
    h.resize();
    expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
      align: "start",
      offset: -42,
    });
    h.scroll(gesture);
    h.handle.scrollToIndex.mockClear();
    h.element.clientWidth = 1124;
    h.resize();
    expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(
      gesture ? 0 : 1,
      {
        align: "start",
        offset: gesture ? 20 : -42,
      },
    );
    h.unmount();
    expect(h.saved().anchor).toEqual(
      gesture ? { id: "preceding", y: -20 } : { id: "grown", y: 42 },
    );
  },
);

it("a gesture cannot re-arm bottom follow through an intervening membership append", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.handle.scrollToIndex.mockClear();
  h.setRows([first, membershipRow("second", 2)], false);
  h.element.scrollTop = 2000;
  h.scroll(false);
  h.measureRows();
  h.setRows([first, membershipRow("second", 2), membershipRow("third", 3)]);
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("an append before gesture geometry arrives cannot make later reader scroll sticky", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.setRows([first, membershipRow("second", 2)]);
  h.element.scrollTop = 2000;
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  h.setRows([first, membershipRow("second", 2), membershipRow("third", 3)]);
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("a gesture with no movement does not disable the next append's bottom follow", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.handle.scrollToIndex.mockClear();
  h.append();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("a reader scroll handler before the append frame cancels its bottom command", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.handle.scrollToIndex.mockClear();
  h.setRows([first, membershipRow("second", 2)], false);
  h.element.scrollTop = 2000;
  h.dispatchScroll();
  h.flush();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("a no-scroll click followed by a tall append follows without mistaking growth for movement", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.setRows([first, membershipRow("second", 2)], false);
  h.element.scrollHeight += 200;
  h.handle.scrollToIndex.mockClear();
  h.flush();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "end",
  });
  h.element.scrollTop += 200;
  h.dispatchScroll();
  h.element.scrollHeight += 200;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("multiple scroll events from one gesture can leave the near-bottom threshold", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.element.scrollTop -= 40;
  h.dispatchScroll();
  h.element.scrollTop -= 260;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.append();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("cancelled resize settles before later reader scroll/save", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 650;
  h.gesture();
  h.resize(false);
  h.element.scrollTop = 2000;
  h.flush();
  h.element.scrollTop = 1900;
  h.dispatchScroll();
  h.unmount();
  expect(h.saved()).toEqual({ bottom: false });
});

it("list shrinkage clamps the offset without revoking bottom follow", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.element.scrollHeight -= 200;
  h.element.scrollTop -= 200;
  h.dispatchScroll();
  h.element.scrollHeight += 200;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("virtualizer correction plus native shrink clamping retains bottom follow", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture(); // The link-opening click did not scroll the reader.
  h.append();
  // A wider panel layout contracts measured rows. WebKit clamps scrollTop,
  // then Virtua applies its own resize correction before native scroll delivery.
  h.element.scrollHeight -= 640;
  h.element.scrollTop -= 1279;
  h.measureRows(false);
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.flush();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("reader movement after a shrink correction still stops bottom follow", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.element.scrollHeight -= 640;
  h.element.scrollTop -= 1279;
  h.measureRows(false);
  h.gesture();
  h.element.scrollTop -= 200;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.flush();
  h.append();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("input saves pending DOM movement even if navigation precedes its scroll event", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  // A later input/navigation can arrive after movement but before onScroll.
  h.element.scrollTop = 2000;
  h.gesture();
  h.unmount();
  expect(h.saved()).toEqual({ bottom: false });
});

it("growth before a no-scroll click does not revoke the existing bottom intent", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.element.scrollHeight += 200;
  h.gesture();
  h.handle.scrollToIndex.mockClear();
  h.edit();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("estimated list shrinkage can leave an intermediate gap without becoming reader movement", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  // Virtua first overestimates the new rows, then contracts its list before
  // the final end-scroll catches up. Both height and offset drop together.
  h.element.scrollHeight += 400;
  h.dispatchScroll();
  h.element.scrollHeight -= 200;
  h.element.scrollTop -= 200;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("records a measured shrink before an append hides its queued native scroll clamp", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.element.scrollHeight -= 200;
  h.element.scrollTop -= 200;
  h.measureRows(false); // Mutation delivery precedes the queued native scroll.
  h.element.scrollHeight += 300; // A new event arrives before that scroll.
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.flush();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it.each([false, true])(
  "a shrink that carries the offset past its clamp keeps bottom follow unless a gesture preceded it=%s",
  (gesture) => {
    const h = setup();
    h.element.scrollTop = 3038;
    h.scroll();
    // Closing a side panel widens the feed. The re-pin frame re-arms the list
    // height observer before Virtua measures the rows at their new width.
    h.element.clientWidth = 1400;
    h.resize();
    if (gesture) h.gesture(true);
    // Rows above the viewport shrink by 300. The browser clamps to the new
    // bottom before Virtua's relative correction reads the offset, so the
    // shrink lands twice; the height commit is observed before its scroll event.
    h.element.scrollHeight -= 300;
    h.element.scrollTop -= 600;
    h.handle.scrollToIndex.mockClear();
    h.measureRows();
    h.dispatchScroll();
    h.render();
    if (gesture) {
      expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
      expect(h.hasJumpToLatest()).toBe(true);
    } else {
      expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
        align: "end",
      });
      h.element.scrollTop = h.element.scrollHeight - h.element.clientHeight;
      h.dispatchScroll();
      h.render();
      expect(h.hasJumpToLatest()).toBe(false);
    }
    h.unmount();
    expect(h.saved().bottom).toBe(!gesture);
  },
);

it.each([false, true])(
  "a row refresh before the first measured height preserves cold restoration unless the reader intervenes=%s",
  (gesture) => {
    const mountedRow = { id: "last", y: 42 };
    const mounted = [mountedRow];
    const h = setup({
      initial: { offset: 80851, bottom: false, anchor: { id: "last", y: 42 } },
      mounted,
    });
    mountedRow.y = 142; // Native cold layout can report the right ID at the wrong Y.
    h.dispatchScroll();
    if (gesture) h.gesture();
    h.handle.scrollToIndex.mockClear();
    h.edit(); // Refresh cancels the original observer before any height delivery.
    h.handle.scrollToIndex.mockClear();
    h.measureRows();
    if (gesture) expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
    else
      expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
        align: "start",
        offset: -42,
      });
    h.unmount();
  },
);

it.each(["button", "scroll"] as const)(
  "leaves a failed read's reason to the recovery notice but keeps its retry (%s)",
  (historyControl) => {
    const failed = setup({
      hasMore: true,
      historyControl,
      error: "Read failed",
    });
    expect(failed.alert()).toBe("Read failed");
    expect(failed.historyButton()).toBe("Retry older messages");
    failed.unmount();
    // Recovery does not retry older history, and paging stops on a failed
    // read, so hiding Retry would strand paging until recovery settles.
    const recovering = setup({
      hasMore: true,
      historyControl,
      error: "Read failed",
      recovering: true,
    });
    expect(recovering.alert()).toBeUndefined();
    expect(recovering.historyButton()).toBe("Retry older messages");
    recovering.unmount();
  },
);

it("pages Solo chat history on scroll without an initial button and keeps error recovery", () => {
  const h = setup({ hasMore: true, historyControl: "scroll" });
  expect(h.hasHistoryButton()).toBe(false);
  h.scroll();
  expect(h.loadOlder).toHaveBeenCalledExactlyOnceWith("channel");
  h.unmount();
  const failed = setup({
    hasMore: true,
    historyControl: "scroll",
    error: "Read failed",
  });
  expect(failed.hasHistoryButton()).toBe(true);
  failed.retry();
  expect(failed.loadOlder).toHaveBeenCalledExactlyOnceWith("channel");
  failed.unmount();
});
