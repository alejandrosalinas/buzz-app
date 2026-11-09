// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, useEffect, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageEditScope, useMessageEditScope } from "./MessageEditScope";
import { readingPositioned, useReading } from "./use-reading";
import type { RelaySession } from "../relay/session";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
/** Registers a composer input with its scope, as `MessageComposer` does. */
function Composer({ input }: { input: HTMLElement }) {
  const scope = useMessageEditScope();
  useEffect(() => {
    if (scope) scope.input.current = input;
  }, [scope, input]);
  return null;
}
function setup({
  supported = true,
  focused = true,
  settled = true,
  strict = false,
  latestMessageId = undefined as string | undefined,
  rootId = undefined as string | undefined,
  enabled = true,
  focus = "element" as "element" | "composer" | "parent" | "outside" | "header",
} = {}) {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  const element = document.createElement("div");
  element.tabIndex = 0;
  const outside = document.createElement("button");
  // The list's own composer, and the composer of the surface it is nested in.
  const composer = document.createElement("textarea");
  const parent = document.createElement("textarea");
  // A panel that owns the list: its header control is not inside the list.
  const panel = document.createElement("aside");
  panel.dataset.readingSurface = "";
  const header = document.createElement("button");
  panel.append(header, element);
  document.body.append(panel, composer, parent, outside);
  ({ element, composer, parent, outside, header })[focus].focus();
  vi.spyOn(element, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  element.replaceChildren(
    row("visible", 100, 200),
    row("overscan", 600, 700),
    row("clipped", 450, 550),
  );
  const scroller = { current: element };
  const position = { current: settled };
  let mutation = () => {};
  const disconnected = vi.fn();
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe() {}
      disconnect = disconnected;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect = disconnected;
    },
  );
  const leases: {
    view: ReturnType<typeof vi.fn>;
    observe: ReturnType<typeof vi.fn>;
    catchUp: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    manual: number;
  }[] = [];
  let observe = async () => {};
  // The real lease fences on the manual-unread revision current at creation.
  let manual = 0;
  const reading = vi.fn(() => {
    const lease = {
      manual,
      view: vi.fn(),
      observe: vi.fn(() => observe()),
      catchUp: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    leases.push(lease);
    return lease;
  });
  const session = {
    unread: {
      sync: () => ({ capability: supported ? "frontier-sync" : "unsupported" }),
      reading,
    },
  } as unknown as RelaySession;
  const view = renderHook(useReading, {
    initialProps: {
      session,
      channelId: "room",
      scroller,
      settled: position,
      latestMessageId,
      rootId,
      enabled,
    },
    reactStrictMode: strict,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        MessageEditScope,
        null,
        createElement(Composer, { input: parent }),
        createElement(
          MessageEditScope,
          null,
          createElement(Composer, { input: composer }),
          children,
        ),
      ),
  });
  return {
    element,
    composer,
    parent,
    outside,
    session,
    reading,
    leases,
    position,
    disconnected,
    mutation: () => mutation(),
    /** A completed dwell hands viewing to a fresh view-only lease after it. */
    dwelled: () => leases.at(-2),
    setVisibility: (next: DocumentVisibilityState) => {
      visibility = next;
    },
    setObserve: (next: typeof observe) => {
      observe = next;
    },
    setRows: (next: HTMLElement[]) => element.replaceChildren(...next),
    markUnread: () => {
      manual++;
    },
    /** Leases that were still valid against the latest manual unread. */
    current: () => leases.filter((lease) => lease.manual === manual),
    retarget: (channelId: string, nextSession = session) =>
      view.rerender({
        session: nextSession,
        channelId,
        scroller,
        settled: position,
        latestMessageId,
        rootId,
        enabled,
      }),
    setLatest: (id: string) =>
      view.rerender({
        session,
        channelId: "room",
        scroller,
        settled: position,
        latestMessageId: id,
        rootId,
        enabled,
      }),
    unmount: view.unmount,
  };
}
function row(id: string, top: number, bottom: number) {
  const element = document.createElement("div");
  element.dataset.messageId = id;
  if (id === "membership") element.dataset.membershipRow = "";
  if (id === "huddle") element.dataset.huddleRow = "";
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, top, 400, bottom - top),
  );
  return element;
}
it("reports only fully visible settled evidence after dwell, not mounted overscan", () => {
  const h = setup();
  expect(h.reading).toHaveBeenCalledExactlyOnceWith("room", undefined);
  vi.advanceTimersByTime(299);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
});
it("a row within a pixel of the viewport's edge is fully visible; one clipped further is not", () => {
  const h = setup();
  // Scroll offsets snap to whole pixels but rows sit at fractional offsets, so
  // an exact reveal can leave its row a sliver above the scroller's top.
  h.setRows([
    row("revealed", -0.047, 40),
    row("above", -1.5, 40),
    row("last", 460, 500.5),
    row("below", 460, 501.5),
  ]);
  h.mutation();
  vi.advanceTimersToNextFrame(); // Row changes are measured in the next frame.
  vi.advanceTimersByTime(300);
  expect(h.dwelled()?.observe).toHaveBeenCalledExactlyOnceWith([
    "revealed",
    "last",
  ]);
});
it("a burst of scrolls and row changes cancels dwell at once but measures rows once, in the next frame", () => {
  const h = setup();
  const measured = vi.spyOn(h.element, "getBoundingClientRect");
  measured.mockClear();
  for (let index = 0; index < 10; index++) {
    h.element.dispatchEvent(new Event("scroll"));
    h.mutation();
  }
  expect(h.leases[0]?.dispose).toHaveBeenCalledOnce();
  expect(measured).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  // One visibleIds pass reads the viewport once; the bottom check is skipped.
  expect(measured).toHaveBeenCalledOnce();
  // Each event takes its own lease; only the latest one carries the dwell.
  for (const lease of h.leases.slice(0, -1))
    expect(lease.dispose).toHaveBeenCalledOnce();
  expect(h.leases.at(-1)?.dispose).not.toHaveBeenCalled();
  vi.advanceTimersByTime(300);
  expect(h.dwelled()?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
});
it("a manual unread before the frame invalidates a scroll's deferred dwell", () => {
  const h = setup();
  h.element.dispatchEvent(new Event("scroll"));
  h.mutation();
  h.markUnread();
  vi.advanceTimersToNextFrame();
  // The frame used the lease its events captured; it took no newer one.
  expect(h.current()).toEqual([]);
  vi.advanceTimersByTime(1000);
  // The fenced dwell hands viewing to a view-only lease, which never observes.
  expect(h.current()).toHaveLength(1);
  for (const lease of h.current()) expect(lease.observe).not.toHaveBeenCalled();
  // A reading action after the unread earns a fresh dwell.
  h.element.dispatchEvent(new Event("pointerdown"));
  vi.advanceTimersByTime(300);
  expect(h.current()).toContain(h.dwelled());
  expect(h.dwelled()?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
});
it("a pending frame cannot measure after the list loses focus", () => {
  const h = setup();
  h.mutation();
  window.dispatchEvent(new Event("blur"));
  vi.advanceTimersToNextFrame();
  vi.advanceTimersByTime(1000);
  for (const lease of h.leases) {
    expect(lease.observe).not.toHaveBeenCalled();
    expect(lease.dispose).toHaveBeenCalledOnce();
  }
});
it("a disabled list marks nothing read, not even its visible bottom", async () => {
  const h = setup({ enabled: false, latestMessageId: "visible" });
  h.mutation();
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.reading).not.toHaveBeenCalled();
});
it.each([
  { focused: false },
  { settled: false },
  { focus: "parent" as const },
  { focus: "outside" as const },
])(
  "does not allocate reading from background, unsettled or other-surface views: %j",
  (options) => {
    const h = setup(options);
    vi.advanceTimersByTime(1000);
    expect(h.reading).not.toHaveBeenCalled();
  },
);
it("the list's own composer earns dwell until the window loses focus", () => {
  const h = setup({ focus: "composer" });
  vi.advanceTimersByTime(100);
  window.dispatchEvent(new Event("blur"));
  vi.advanceTimersByTime(1000);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
  expect(h.leases[0]?.dispose).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("focus"));
  vi.advanceTimersByTime(299);
  expect(h.leases[1]?.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.leases[1]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
});
it("focus anywhere in the panel that owns the list earns dwell", () => {
  const h = setup({ focus: "header" });
  vi.advanceTimersByTime(300);
  expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
});
it("only the owning selected tab earns dwell; inactive and restored content does not", () => {
  const h = setup({ focus: "outside" });
  const pane = document.createElement("div");
  pane.setAttribute("role", "tabpanel");
  pane.setAttribute("aria-labelledby", "thread-tab");
  const tab = document.createElement("button");
  tab.id = "thread-tab";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "true");
  const other = document.createElement("button");
  other.setAttribute("role", "tab");
  document.body.append(tab, other, pane);
  const surface = h.element.closest("aside");
  expect(surface).not.toBeNull();
  if (surface) pane.append(surface);
  // Remount after establishing the real tab/content ownership boundary.
  h.retarget("thread-room");
  vi.advanceTimersByTime(300);
  expect(h.reading).not.toHaveBeenCalled();
  other.focus();
  vi.advanceTimersByTime(300);
  expect(h.reading).not.toHaveBeenCalled();
  tab.focus();
  vi.advanceTimersByTime(299);
  expect(h.leases.at(-1)?.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.dwelled()?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
  h.mutation();
  const pending = h.leases.at(-1);
  pane.setAttribute("inert", "");
  tab.setAttribute("aria-selected", "false");
  vi.advanceTimersByTime(300);
  expect(pending?.observe).not.toHaveBeenCalled();
  expect(pending?.dispose).toHaveBeenCalledOnce();
  // Restoring visible content without moving focus back is still not reading.
  other.focus();
  pane.removeAttribute("inert");
  tab.setAttribute("aria-selected", "true");
  h.mutation();
  const count = h.reading.mock.calls.length;
  vi.advanceTimersByTime(300);
  expect(h.reading).toHaveBeenCalledTimes(count);
  // A retained thread moves without changing any hook dependencies. The new
  // pane's selected header must earn dwell; the former header must not.
  const destination = document.createElement("div");
  destination.setAttribute("role", "tabpanel");
  destination.setAttribute("aria-labelledby", "moved-thread-tab");
  const movedTab = document.createElement("button");
  movedTab.id = "moved-thread-tab";
  movedTab.setAttribute("role", "tab");
  movedTab.setAttribute("aria-selected", "true");
  document.body.append(movedTab, destination);
  if (surface) destination.append(surface);
  tab.focus();
  vi.advanceTimersByTime(300);
  expect(h.reading).toHaveBeenCalledTimes(count);
  movedTab.focus();
  const movedLease = h.leases.at(-1);
  expect(h.reading).toHaveBeenCalledTimes(count + 1);
  vi.advanceTimersByTime(299);
  expect(movedLease?.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(movedLease?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
});
it("a panel in a reading-thread workspace reads while focus is elsewhere in that workspace", () => {
  const h = setup({ focus: "outside" });
  const workspace = document.createElement("div");
  const side = document.createElement("div");
  side.setAttribute("data-panel-workspace", "");
  const surface = h.element.closest("aside");
  const unrelated = document.createElement("button");
  expect(surface).not.toBeNull();
  document.body.append(workspace, unrelated);
  if (surface) side.append(surface);
  workspace.append(side, h.outside);
  h.retarget("thread-room");
  h.outside.focus();
  vi.advanceTimersByTime(300);
  expect(h.reading).not.toHaveBeenCalled();
  workspace.setAttribute("data-reading-thread", "");
  h.retarget("thread-room-again");
  h.outside.focus();
  vi.advanceTimersByTime(299);
  expect(h.leases.at(-1)?.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.dwelled()?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
  const count = h.reading.mock.calls.length;
  unrelated.focus();
  vi.advanceTimersByTime(300);
  expect(h.reading).toHaveBeenCalledTimes(count);
  // A thread in the main pane belongs to no side-pane selection: the same
  // workspace focus does not read it.
  side.setAttribute("data-main-workspace", "");
  side.removeAttribute("data-panel-workspace");
  h.retarget("thread-room-main");
  h.outside.focus();
  vi.advanceTimersByTime(300);
  expect(h.reading).toHaveBeenCalledTimes(count);
});
it("focus moving from the list to its composer keeps reading; another surface's composer cancels it", () => {
  const h = setup();
  vi.advanceTimersByTime(100);
  h.composer.focus();
  vi.advanceTimersByTime(300);
  expect(h.dwelled()?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
  h.setRows([row("next", 100, 200)]);
  h.mutation();
  const pending = h.leases.at(-1);
  vi.advanceTimersByTime(100);
  h.parent.focus();
  expect(pending?.dispose).toHaveBeenCalledOnce();
  const allocated = h.reading.mock.calls.length;
  vi.advanceTimersByTime(1000);
  expect(pending?.observe).not.toHaveBeenCalled();
  expect(h.reading).toHaveBeenCalledTimes(allocated);
  h.composer.focus();
  vi.advanceTimersByTime(300);
  expect(h.dwelled()?.observe).toHaveBeenCalledExactlyOnceWith(["next"]);
});
it("captures the cancellable lease before dwell and disposes it on hidden/unmount", () => {
  const h = setup();
  vi.advanceTimersByTime(100);
  h.setVisibility("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(1000);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
  expect(h.leases[0]?.dispose).toHaveBeenCalledTimes(1);
  h.setVisibility("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  h.unmount();
  vi.advanceTimersByTime(1000);
  expect(h.leases[1]?.observe).not.toHaveBeenCalled();
  expect(h.disconnected).toHaveBeenCalled();
});
it("scroll and content changes restart dwell; a row seen only at the end is not read", () => {
  const h = setup();
  vi.advanceTimersByTime(100);
  h.element.dispatchEvent(new Event("scroll"));
  expect(h.leases[0]?.dispose).toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  h.setRows([row("replacement", 100, 200)]);
  h.mutation();
  vi.advanceTimersByTime(299);
  expect(h.leases[2]?.observe).not.toHaveBeenCalled();
  h.setRows([row("new-at-end", 100, 200)]);
  vi.advanceTimersByTime(1);
  expect(h.leases[2]?.observe).not.toHaveBeenCalled();
});
it("before its frame, the deferred lease confirms any row on demand", () => {
  const h = setup();
  // A measured view answers for the rows it measured.
  const measured = h.leases[0]?.view.mock.lastCall;
  expect(measured?.[0]).toEqual(["visible"]);
  expect(measured?.[1]("visible", true)).toBe(true);
  expect(measured?.[1]("overscan", false)).toBe(false);
  // Content changes in place: the deferred lease still sees the row.
  h.mutation();
  const deferred = () => h.leases.at(-1)?.view.mock.lastCall;
  expect(deferred()?.[0]).toEqual([]);
  expect(deferred()?.[1]("visible", false)).toBe(true);
  // A row scrolled into view before the frame is viewed; one scrolled out is not.
  h.setRows([row("visible", 600, 700), row("overscan", 100, 200)]);
  h.element.dispatchEvent(new Event("scroll"));
  expect(deferred()?.[1]("visible", false)).toBe(false);
  expect(deferred()?.[1]("overscan", false)).toBe(true);
  expect(deferred()?.[1]("missing", false)).toBe(false);
  // The frame measures, and the view answers from that measurement again.
  vi.advanceTimersToNextFrame();
  expect(deferred()?.[0]).toEqual(["overscan"]);
  expect(deferred()?.[1]("visible", false)).toBe(false);
});
it("active content reflow cannot revoke dwell already queued for durability", async () => {
  const h = setup();
  let release: (() => void) | undefined;
  h.setObserve(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  try {
    vi.advanceTimersByTime(300);
    expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);

    h.mutation();
    expect(h.leases[0]?.dispose).not.toHaveBeenCalled();
    h.outside.focus();
    expect(h.leases[0]?.dispose).toHaveBeenCalledTimes(1);
  } finally {
    release?.();
    await vi.runAllTimersAsync();
  }
  expect(h.leases[0]?.dispose).toHaveBeenCalledTimes(1);
});
it.each(["blur", "scroll", "unmount"] as const)(
  "rows stay viewed after their dwell read settles until %s",
  async (end) => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(300);
    // The read finished and released its durable lease.
    expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
    expect(h.leases[0]?.dispose).toHaveBeenCalledOnce();
    // Viewing moved off the write lease; only the current handle reports rows.
    expect(h.leases[0]?.view).toHaveBeenLastCalledWith(
      [],
      expect.any(Function),
    );
    expect(h.leases[0]?.view.mock.lastCall?.[1]("visible", true)).toBe(false);
    // A view-only replacement still reports the row, with no timer of its own.
    const viewing = h.leases[1];
    expect(viewing?.view).toHaveBeenCalledExactlyOnceWith(
      ["visible"],
      expect.any(Function),
    );
    expect(viewing?.view.mock.calls[0]?.[1]("visible", true)).toBe(true);
    expect(viewing?.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.leases).toHaveLength(2);
    expect(viewing?.observe).not.toHaveBeenCalled();
    if (end === "blur") window.dispatchEvent(new Event("blur"));
    if (end === "scroll") h.element.dispatchEvent(new Event("scroll"));
    if (end === "unmount") h.unmount();
    expect(viewing?.dispose).toHaveBeenCalledOnce();
  },
);
it("reports qualified viewing even without read sync, but never publishes read intent", () => {
  const h = setup({ supported: false });
  expect(h.leases[0]?.view).toHaveBeenCalledExactlyOnceWith(
    ["visible"],
    expect.any(Function),
  );
  vi.advanceTimersByTime(1000);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
});
it("the viewing validity callback rechecks focus and settled positioning synchronously", () => {
  const h = setup();
  const visible = h.leases[0]?.view.mock.calls[0]?.[1];
  expect(visible("visible", true)).toBe(true);
  h.position.current = false;
  expect(visible("visible", true)).toBe(false);
  h.position.current = true;
  h.outside.focus();
  expect(visible("visible", true)).toBe(false);
  h.unmount();
  expect(visible("visible", true)).toBe(false);
});

it.each(["membership", "huddle"])(
  "%s activity cannot abort acknowledgment of a visible message below it",
  (kind) => {
    const h = setup();
    h.setRows([row(kind, 10, 50), row("conversation", 100, 200)]);
    h.mutation();
    vi.advanceTimersToNextFrame(); // Row changes are measured in the next frame.
    vi.advanceTimersByTime(300);
    expect(h.dwelled()?.observe).toHaveBeenCalledExactlyOnceWith([
      "conversation",
    ]);
  },
);

it("releases the old channel and session on rerender and only observes the current lease", () => {
  const h = setup();
  vi.advanceTimersByTime(100);
  const oldValidity = h.leases[0]?.view.mock.calls[0]?.[1];
  h.retarget("next-room");
  expect(h.leases[0]?.dispose).toHaveBeenCalledOnce();
  expect(oldValidity("visible", true)).toBe(false);
  expect(h.reading).toHaveBeenLastCalledWith("next-room", undefined);
  const nextReading = vi.fn((_channelId: string) => h.reading());
  h.retarget("next-room", {
    ...h.session,
    unread: { ...h.session.unread, reading: nextReading },
  });
  expect(h.leases[1]?.dispose).toHaveBeenCalledOnce();
  expect(nextReading).toHaveBeenCalledExactlyOnceWith("next-room", undefined);
  vi.advanceTimersByTime(299);
  for (const lease of h.leases) expect(lease.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.leases[2]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
  h.unmount();
  expect(h.leases[2]?.dispose).toHaveBeenCalledOnce();
});

it("StrictMode releases its probe lease and disconnects observation on unmount", () => {
  const h = setup({ strict: true });
  expect(h.leases).toHaveLength(2);
  expect(h.leases[0]?.dispose).toHaveBeenCalledOnce();
  expect(h.leases[1]?.dispose).not.toHaveBeenCalled();
  const validity = h.leases[1]?.view.mock.calls[0]?.[1];
  h.unmount();
  expect(validity()).toBe(false);
  for (const lease of h.leases) expect(lease.dispose).toHaveBeenCalledOnce();
  expect(h.disconnected).toHaveBeenCalledTimes(4);
  act(() => {
    elementEvents(h.element);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1000);
  });
  expect(h.reading).toHaveBeenCalledTimes(2);
  for (const lease of h.leases) expect(lease.observe).not.toHaveBeenCalled();
});
function elementEvents(element: HTMLElement) {
  for (const name of ["scroll", "pointerdown", "keydown", "focusin"])
    element.dispatchEvent(new Event(name, { bubbles: true }));
}

it("bottom dwell catches up through the newest row, including a tall clipped row", async () => {
  const h = setup({ latestMessageId: "bottom", rootId: "thread" });
  h.setRows([row("bottom", -200, 500)]);
  h.mutation();
  vi.advanceTimersToNextFrame(); // Row changes are measured in the next frame.
  await vi.advanceTimersByTimeAsync(299);
  expect(h.leases.at(-1)?.catchUp).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.dwelled()?.catchUp).toHaveBeenCalledExactlyOnceWith(
    "bottom",
    "thread",
  );
  // Its leases name the thread, which bounds what a DM read may cover.
  for (const call of h.reading.mock.calls)
    expect(call).toEqual(["room", "thread"]);
});
it("a new latest message keeps observation and catches up after its row is measured", async () => {
  const h = setup({ latestMessageId: "bottom" });
  h.setRows([row("bottom", 100, 200)]);
  h.mutation();
  vi.advanceTimersToNextFrame();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.dwelled()?.catchUp).toHaveBeenCalledExactlyOnceWith(
    "bottom",
    undefined,
  );
  const leases = h.leases.length;
  h.setLatest("newer");
  // Changing only the latest id neither restarts nor takes a lease.
  expect(h.leases).toHaveLength(leases);
  expect(h.leases.at(-1)?.dispose).not.toHaveBeenCalled();
  expect(h.disconnected).not.toHaveBeenCalled();
  h.setRows([row("bottom", 100, 200), row("newer", 200, 300)]);
  h.mutation();
  vi.advanceTimersToNextFrame();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.dwelled()?.catchUp).toHaveBeenCalledExactlyOnceWith(
    "newer",
    undefined,
  );
});
it("a historical viewport or a bottom reached only at dwell end cannot catch up", async () => {
  const h = setup({ latestMessageId: "visible" });
  vi.spyOn(h.element, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(h.element, "clientHeight", "get").mockReturnValue(500);
  h.mutation();
  vi.advanceTimersToNextFrame(); // Row changes are measured in the next frame.
  await vi.advanceTimersByTimeAsync(299);
  h.element.scrollTop = 500;
  await vi.advanceTimersByTimeAsync(1);
  expect(h.dwelled()?.catchUp).not.toHaveBeenCalled();
  h.mutation();
  vi.advanceTimersToNextFrame();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.dwelled()?.catchUp).toHaveBeenCalledExactlyOnceWith(
    "visible",
    undefined,
  );
});

it("settled notification starts dwell without changed rows, focus or geometry", () => {
  const h = setup({ focus: "header", settled: false });
  vi.advanceTimersByTime(300);
  expect(h.reading).not.toHaveBeenCalled();
  h.position.current = true;
  readingPositioned(h.element);
  vi.advanceTimersByTime(299);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
});

it.each(["transitionend", "animationend"])(
  "%s on the containing panel resumes dwell after translated rows enter view",
  (event) => {
    const h = setup({ settled: false });
    h.setRows([row("visible", 600, 700)]);
    h.position.current = true;
    readingPositioned(h.element);
    vi.advanceTimersByTime(300);
    expect(h.reading).not.toHaveBeenCalled();
    // A transform changes viewport geometry without resizing or changing rows.
    h.setRows([row("visible", 100, 200)]);
    h.outside.dispatchEvent(new Event(event, { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(h.reading).not.toHaveBeenCalled();
    h.element.parentElement?.dispatchEvent(new Event(event, { bubbles: true }));
    vi.advanceTimersByTime(299);
    expect(h.leases).toHaveLength(1);
    expect(h.leases[0]?.observe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
  },
);
