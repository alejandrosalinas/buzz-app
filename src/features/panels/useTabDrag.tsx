import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type PointerEvent,
} from "react";
import { TabDragFeedback } from "../../shared/design-system/ui/TabDragFeedback";

export type DragPane = "main" | "side";
export type TabDragHost = {
  attach(element: HTMLDivElement | null): void;
  begin(event: PointerEvent<HTMLDivElement>): void;
  click(event: React.MouseEvent<HTMLDivElement>): void;
};
type Target = {
  edge?: boolean | undefined;
  pane: DragPane;
  index: number;
  x: number;
  y: number;
  height: number;
};
type Gesture = {
  id: string;
  label: string;
  pane: DragPane;
  pointer: number;
  handle: HTMLDivElement;
  startX: number;
  startY: number;
  grabX: number;
  grabY: number;
  width: number;
  height: number;
  moved: boolean;
  target?: Target | undefined;
};

type Feedback = {
  label: string;
  ghost: { x: number; y: number; width: number; height: number };
  insertion?: Target | undefined;
  edge?: { x: number; y: number } | undefined;
};
function createFeedback() {
  let value: Feedback | undefined;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next: Feedback | undefined) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}
/** Pointer frames only redraw the cue, not every retained conversation. */
function DragPreview({ store }: { store: ReturnType<typeof createFeedback> }) {
  const paint = useSyncExternalStore(store.subscribe, store.snapshot);
  return paint ? <TabDragFeedback {...paint} /> : null;
}

/** Title-only Panel Swap gesture. The conversation owner alone commits moves. */
export function useTabDrag({
  visit,
  navigationSignal,
  movable,
  order,
  closedSideIndex,
  canMove,
  move,
}: {
  visit: object;
  /** Navigation owns cancellation even between visits in the same channel. */
  navigationSignal?: AbortSignal | undefined;
  movable: ReadonlySet<string>;
  order: ReadonlySet<string>;
  /** Append an edge drop to the retained side inventory when it is closed. */
  closedSideIndex?: number | undefined;
  canMove(id: string, pane: DragPane): boolean;
  move(id: string, pane: DragPane, index: number): void;
}) {
  const hosts = useRef(new Map<DragPane, HTMLDivElement>());
  const gesture = useRef<Gesture | undefined>(undefined);
  const suppressClick = useRef(false);
  const latest = useRef({ movable, order, closedSideIndex, canMove, move });
  latest.current = { movable, order, closedSideIndex, canMove, move };
  const feedback = useRef(createFeedback());
  const setPaint = feedback.current.publish;
  const cancel = useRef<() => void>(() => {});
  useEffect(() => {
    // This effect retires gestures when the channel/session visit changes.
    if (!visit) return;
    let frame = 0;
    let point: { x: number; y: number } | undefined;
    function visible(host: HTMLElement) {
      return (
        host.isConnected &&
        !host.closest('[hidden], [inert], [aria-hidden="true"]') &&
        host.getClientRects().length > 0
      );
    }
    function target(
      active: Gesture,
      x: number,
      y: number,
      front?: HTMLElement,
    ): Target | undefined {
      const main = hosts.current.get("main");
      const side = hosts.current.get("side");
      for (const [pane, host] of hosts.current) {
        if (
          (front && host !== front) ||
          !visible(host) ||
          !latest.current.canMove(active.id, pane)
        )
          continue;
        // The direct header is the pane's semantic chrome, not a nested
        // contribution's header or a style selector. A lone conversation has
        // an identity instead of tabs, but still accepts incoming thread tabs.
        const header = host.querySelector<HTMLElement>(":scope > header");
        const list =
          header?.querySelector<HTMLElement>('[role="tablist"]') ??
          header?.querySelector<HTMLElement>("[data-workspace-identity]");
        if (!list || !header) continue;
        const box = list.getBoundingClientRect();
        const headerBox = header.getBoundingClientRect();
        const tolerance =
          active.target?.pane === pane && !active.target.edge ? 12 : 0;
        if (
          x < headerBox.left - tolerance ||
          x > headerBox.right + tolerance ||
          y < headerBox.top - tolerance ||
          y > headerBox.bottom + Math.max(8, tolerance)
        )
          continue;
        // Only thread/store tabs count toward insertion. Fixed host tabs stay
        // in place; offscreen tabs still count, using their real scroll geometry.
        const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
        const order = tabs.filter((tab) => {
          const id = tab.dataset.tabValue;
          return id !== active.id && !!id && latest.current.order.has(id);
        });
        const before = order.find((tab) => {
          const rect = tab.getBoundingClientRect();
          return x < rect.left + rect.width / 2;
        });
        const index = before ? order.indexOf(before) : order.length;
        const anchor = before ?? order.at(-1) ?? tabs.at(-1);
        const rect = anchor?.getBoundingClientRect() ?? box;
        const boundary = before ? rect.left : rect.right;
        return {
          pane,
          index,
          x: Math.max(box.left, Math.min(box.right, boundary)),
          y: rect.top,
          height: rect.height,
        };
      }
      if (
        active.pane === "main" &&
        main &&
        visible(main) &&
        (!side || !visible(side)) &&
        latest.current.closedSideIndex !== undefined &&
        latest.current.canMove(active.id, "side")
      ) {
        const box = main.getBoundingClientRect();
        const header = main
          .querySelector<HTMLElement>(":scope > header")
          ?.getBoundingClientRect();
        // Header insertion wins. Separate only below its forgiving hit region.
        // Panel Swap's deliberate edge separation uses resting pane bounds.
        const band = Math.min(120, Math.max(48, box.width * 0.22));
        const tolerance = active.target?.edge ? 16 : 0;
        if (
          x - active.startX > 24 &&
          x >= box.right - band - tolerance &&
          x <= box.right + 48 &&
          y > (header?.bottom ?? box.top) + 12 &&
          y <= box.bottom
        ) {
          return {
            pane: "side",
            index: latest.current.closedSideIndex,
            edge: true,
            x: box.right,
            y: box.top + box.height / 2,
            height: 0,
          };
        }
      }
      return undefined;
    }
    function draw() {
      frame = 0;
      const active = gesture.current;
      if (!active?.moved || !point) return;
      if (
        !active.handle.isConnected ||
        !latest.current.movable.has(active.id)
      ) {
        finish(true);
        return;
      }
      // A long strip scrolls while held near its visible edges. One animation
      // frame loop exists only during a drag, never while the workspace is idle.
      // Overlay panes can cover a still-visible main header. Real hit testing
      // chooses the frontmost host; whitespace outside hosts keeps tolerance.
      const hit = document.elementFromPoint(point.x, point.y);
      const front = [...hosts.current.values()].find((host) =>
        host.contains(hit),
      );
      let scrolling = false;
      for (const [pane, host] of hosts.current) {
        if (
          (front && host !== front) ||
          !visible(host) ||
          !latest.current.canMove(active.id, pane)
        )
          continue;
        const list = host.querySelector<HTMLElement>('[role="tablist"]');
        if (!list) continue;
        const box = list.getBoundingClientRect();
        if (
          point.y < box.top ||
          point.y > box.bottom ||
          point.x < box.left ||
          point.x > box.right
        )
          continue;
        const direction =
          point.x < box.left + 24 ? -1 : point.x > box.right - 24 ? 1 : 0;
        const previous = list.scrollLeft;
        if (direction) list.scrollLeft += direction * 8;
        scrolling ||= previous !== list.scrollLeft;
      }
      active.target = target(active, point.x, point.y, front);
      setPaint({
        label: active.label,
        ghost: {
          x: point.x - active.grabX,
          y: point.y - active.grabY,
          width: active.width,
          height: active.height,
        },
        insertion: active.target?.edge ? undefined : active.target,
        edge: active.target?.edge
          ? { x: active.target.x, y: active.target.y }
          : undefined,
      });
      if (scrolling) frame = requestAnimationFrame(draw);
    }
    function finish(cancelled: boolean) {
      const active = gesture.current;
      gesture.current = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
      point = undefined;
      delete document.documentElement.dataset.tabDragging;
      setPaint(undefined);
      if (!active) return;
      if (active.handle.hasPointerCapture(active.pointer))
        active.handle.releasePointerCapture(active.pointer);
      suppressClick.current = active.moved;
      const destination = active.target;
      if (
        !cancelled &&
        active.moved &&
        destination &&
        latest.current.movable.has(active.id) &&
        latest.current.canMove(active.id, destination.pane)
      )
        latest.current.move(active.id, destination.pane, destination.index);
    }
    cancel.current = () => finish(true);
    function pointerMove(event: globalThis.PointerEvent) {
      const active = gesture.current;
      if (!active || active.pointer !== event.pointerId) return;
      if (
        !active.moved &&
        Math.hypot(
          event.clientX - active.startX,
          event.clientY - active.startY,
        ) < 6
      )
        return;
      active.moved = true;
      if (!active.handle.hasPointerCapture(active.pointer))
        active.handle.setPointerCapture(active.pointer);
      document.documentElement.dataset.tabDragging = "";
      event.preventDefault();
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(draw);
    }
    function pointerUp(event: globalThis.PointerEvent) {
      if (gesture.current?.pointer !== event.pointerId) return;
      if (gesture.current.moved) {
        point = { x: event.clientX, y: event.clientY };
        cancelAnimationFrame(frame);
        draw();
      }
      finish(false);
    }
    function pointerCancel(event: globalThis.PointerEvent) {
      if (gesture.current?.pointer === event.pointerId) finish(true);
    }
    function cancelKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || !gesture.current) return;
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    }
    const blur = () => finish(true);
    navigationSignal?.addEventListener("abort", blur);
    document.addEventListener("pointermove", pointerMove, { passive: false });
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", pointerCancel);
    document.addEventListener("lostpointercapture", pointerCancel);
    document.addEventListener("keydown", cancelKey, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      finish(true);
      document.removeEventListener("pointermove", pointerMove);
      document.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("pointercancel", pointerCancel);
      document.removeEventListener("lostpointercapture", pointerCancel);
      document.removeEventListener("keydown", cancelKey, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
      navigationSignal?.removeEventListener("abort", blur);
    };
  }, [visit, navigationSignal, setPaint]);
  function host(pane: DragPane): TabDragHost {
    return {
      attach(element) {
        if (element) hosts.current.set(pane, element);
        else hosts.current.delete(pane);
      },
      begin(event) {
        suppressClick.current = false;
        if (
          navigationSignal?.aborted ||
          event.button !== 0 ||
          !event.isPrimary ||
          event.pointerType === "touch"
        )
          return;
        const tab = (event.target as Element).closest<HTMLElement>(
          '[role="tab"]',
        );
        const id = tab?.dataset.tabValue;
        if (!tab || !id || !latest.current.movable.has(id)) return;
        cancel.current();
        const box = tab.getBoundingClientRect();
        gesture.current = {
          id,
          label: tab.getAttribute("title") ?? tab.textContent ?? "Thread",
          pane,
          pointer: event.pointerId,
          handle: event.currentTarget,
          startX: event.clientX,
          startY: event.clientY,
          grabX: event.clientX - box.left,
          grabY: event.clientY - box.top,
          width: box.width,
          height: box.height,
          moved: false,
        };
      },
      click(event) {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  }
  return {
    main: host("main"),
    side: host("side"),
    feedback: <DragPreview store={feedback.current} />,
  };
}
