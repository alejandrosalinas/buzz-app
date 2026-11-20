import { useEffect, useEffectEvent, type RefObject } from "react";
import type { RelaySession } from "../relay/session";
import type { ReadingHandle } from "../relay/unread";
import { useMessageEditScope } from "./MessageEditScope";

// Accessibility isolation, such as a modal menu, pauses reading; the same
// visit resumes once it lifts. Actual concealment also ends the visit.
const CONCEALED = '[inert], [hidden], [aria-hidden="true"]';
/**
 * Whether a pane is concealed rather than isolated: `hidden` anywhere, or
 * `inert` below the body's own children. A modal dialog inerts the body's
 * other children, which only pauses reading.
 */
function departed(element: Element) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return true;
    if (node.hasAttribute("inert") && node.parentElement !== document.body)
      return true;
  }
  return false;
}
/** Shared document attention gate for reading and row visits. */
export function readingDocumentActive() {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Wake dwell after owner-controlled positioning, even when geometry is unchanged. */
export function readingPositioned(element: HTMLElement | null) {
  element?.dispatchEvent(new Event("reading-positioned"));
}

type Reading = {
  session: RelaySession;
  channelId: string;
  latestMessageId?: string | undefined;
  /** The newest row catch-up may read through, when it is not the bottom
   * row (a channel's newest top-level post). Defaults to the bottom row. */
  catchUpMessageId?: string | undefined;
  /** The thread this list shows: its bottom catches up that thread, and its
   * DM reads stop before unread messages it does not show. */
  rootId?: string | undefined;
  scroller: RefObject<HTMLElement | null>;
  settled: RefObject<boolean>;
  /** True while the list shows its latest row in place of the reader's own,
   * still loading: the rows shown are read, but that bottom is not caught up. */
  restoring?: (() => boolean) | undefined;
  /** False: this list marks nothing read; its owner decides what was read, or
   * when reading may start. Turning it on schedules dwell at once. */
  enabled?: boolean | undefined;
};
/** `useReading` for an owner that renders its own `MessageEditScope`. */
export function Reading(props: Reading) {
  useReading(props);
  return null;
}
/**
 * Consumer-owned observation: focused, visible, settled rows, never virtualizer
 * overscan. Call it inside the `MessageEditScope` this message list shares with
 * its composer, so focus in that composer counts and another surface's does not.
 */
export function useReading({
  session,
  channelId,
  latestMessageId,
  catchUpMessageId,
  rootId,
  scroller,
  settled,
  restoring,
  enabled = true,
}: Reading) {
  const composer = useMessageEditScope()?.input;
  // Read at measurement time: a new latest message mutates the list, which
  // already remeasures in the next frame, so it must not restart observation.
  const latestId = useEffectEvent(() => latestMessageId);
  const catchUpId = useEffectEvent(() => catchUpMessageId ?? latestMessageId);
  useEffect(() => {
    if (!enabled || !scroller.current) return;
    const element: HTMLElement = scroller.current;
    let handle: ReadingHandle | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    // A deferred measurement's lease, captured when its event arrived.
    let pending: ReadingHandle | undefined;
    let stopped = false;
    // This reader's stay in the conversation, across its leases: a message
    // marked unread while shown stays unread until a measurement excludes it
    // or the reader departs. Returning is a new visit.
    let visit = {};
    let visited = false;
    // Whether the visit's last completed measurement showed any row.
    let showing = false;
    function depart() {
      if (visited) session.unread.leave(visit);
      visit = {};
      visited = showing = false;
    }
    // A thread shown in its pane is presented for the whole visit, whatever
    // its rows measure: a thread marked unread then stays so until departure.
    function present() {
      if (
        !rootId ||
        visited ||
        document.visibilityState !== "visible" ||
        departed(element)
      )
        return;
      try {
        session.unread.present(channelId, rootId, visit);
        visited = true;
      } catch {
        // Membership may disappear between commit and observation.
      }
    }
    const observing = new Set<ReadingHandle>();
    // The message list or its own composer: typing under a conversation is
    // reading it. A parent scope's composer belongs to another surface. A panel
    // that owns the list opts in whole, so opening it is enough.
    const surface = element.closest("[data-reading-surface]");
    // A tabbed thread's header is outside its content, but aria-labelledby
    // identifies its owning tab. Never borrow focus from a sibling tab.
    const focusedTab = (node: EventTarget | null) => {
      // Retained content can move panes without restarting this observation.
      const tabPanel = surface?.closest('[role="tabpanel"]');
      const label = tabPanel?.getAttribute("aria-labelledby");
      const tab = label ? document.getElementById(label) : null;
      return (
        tab?.getAttribute("role") === "tab" &&
        tab.getAttribute("aria-selected") === "true" &&
        tab.contains(node as Node | null)
      );
    };
    const focused = (node: EventTarget | null) =>
      node instanceof Node &&
      (element.contains(node) ||
        !!surface?.contains(node) ||
        focusedTab(node) ||
        // A plain channel visit also reads the side pane's visible selected
        // thread while focus stays anywhere in that channel's workspace.
        !!surface
          ?.closest("[data-panel-workspace]")
          ?.closest("[data-reading-thread]")
          ?.contains(node) ||
        !!composer?.current?.contains(node));
    // Everything but geometry, so an event can check it without a layout.
    const ready = () =>
      !stopped &&
      element.isConnected &&
      !element.closest(CONCEALED) &&
      settled.current &&
      readingDocumentActive() &&
      focused(document.activeElement);
    const active = () => ready() && element.getClientRects().length > 0;
    function cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      handle?.dispose();
      handle = undefined;
    }
    function unqueue() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      pending?.dispose();
      pending = undefined;
    }
    function stop() {
      unqueue();
      cancel();
      for (const observed of observing) observed.dispose();
      observing.clear();
    }
    // Within a pixel: scroll offsets snap to whole pixels but rows sit at
    // fractional ones, so an exact reveal can leave its row a sliver past an edge.
    function shown(row: HTMLElement, viewport: DOMRect) {
      const bounds = row.getBoundingClientRect();
      return (
        row.dataset.membershipRow === undefined &&
        row.dataset.huddleRow === undefined &&
        bounds.height > 0 &&
        bounds.width > 0 &&
        bounds.top >= Math.max(viewport.top, 0) - 1 &&
        bounds.bottom <= Math.min(viewport.bottom, window.innerHeight) + 1 &&
        bounds.left >= Math.max(viewport.left, 0) - 1 &&
        bounds.right <= Math.min(viewport.right, window.innerWidth) + 1
      );
    }
    function visibleIds() {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
        .flatMap((row) =>
          row.dataset.messageId && shown(row, viewport)
            ? [row.dataset.messageId]
            : [],
        )
        .slice(0, 128);
    }
    // Viewing evidence. A measured view answers for the rows it measured.
    // While a measurement waits for its frame, the last measurement is stale,
    // so any row of this list is checked only when a consumer asks: a frame
    // that has not run yet must not hide a row that is in view, newly or still,
    // or report one that has scrolled away.
    const viewing = (id: string, measured: boolean) => {
      if (!active()) return false;
      if (frame === undefined) return measured;
      const row = [
        ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
      ].find((row) => row.dataset.messageId === id);
      return !!row && shown(row, element.getBoundingClientRect());
    };
    function bottomId() {
      const latest = latestId();
      if (
        !latest ||
        element.scrollHeight - element.clientHeight - element.scrollTop > 1
      )
        return;
      const viewport = element.getBoundingClientRect();
      // A folded preview that shows the latest message stands in for its row
      // here only: what it folds is not observed as individually read.
      const row = [
        ...element.querySelectorAll<HTMLElement>(
          "[data-message-id], [data-preview-message-id]",
        ),
      ].find(
        (row) =>
          (row.dataset.messageId ?? row.dataset.previewMessageId) === latest,
      );
      const bounds = row?.getBoundingClientRect();
      return bounds &&
        bounds.height > 0 &&
        bounds.width > 0 &&
        bounds.bottom > Math.max(viewport.top, 0) &&
        bounds.bottom <= Math.min(viewport.bottom, window.innerHeight) &&
        bounds.left >= Math.max(viewport.left, 0) &&
        bounds.right <= Math.min(viewport.right, window.innerWidth)
        ? latest
        : undefined;
    }
    // A discrete action (focus, pointer, key, visibility, settling) starts
    // dwell at once. Scroll, list mutations and resizes arrive many times per
    // frame: each cancels dwell at once but measures rows only in the next
    // frame, rather than forcing a fresh layout of every row per event. Until
    // then the deferred lease answers for visibility on demand (`viewing`).
    function schedule() {
      unqueue();
      begin();
    }
    function reflow() {
      cancel();
      pending?.dispose();
      pending = undefined;
      if (!ready()) return;
      // The lease is the intent fence, so take it when the event happens: a
      // manual unread before the frame must invalidate this measurement.
      pending = acquire();
      if (!pending) return;
      try {
        pending.view([], viewing, false);
      } catch {
        unqueue();
        return;
      }
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        const lease = pending;
        pending = undefined;
        // No lease at event time means no reading intent to measure.
        if (lease) begin(lease);
      });
    }
    function acquire() {
      try {
        const lease = session.unread.reading(channelId, rootId, visit);
        visited = true;
        return lease;
      } catch {
        return undefined; // Membership may disappear between commit and observation.
      }
    }
    // Capture the lease BEFORE dwell: a newer manual action invalidates it.
    // A deferred measurement brings the lease its event captured.
    function begin(lease?: ReadingHandle) {
      cancel();
      if (!active()) {
        lease?.dispose();
        return;
      }
      const ids = visibleIds();
      const bottom = bottomId();
      if (!ids.length && !bottom) {
        // A completed measurement that shows no row, unlike a handoff's.
        const empty = lease ?? (showing ? acquire() : undefined);
        try {
          empty?.view([], viewing);
          showing = false;
        } finally {
          empty?.dispose();
        }
        return;
      }
      handle = lease ?? acquire();
      if (!handle) return;
      try {
        handle.view(ids, viewing);
        showing = !!ids.length;
      } catch {
        cancel();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (!active()) {
          cancel();
          return;
        }
        const visible = new Set(visibleIds());
        // A row appearing only at the end of the interval has not had a dwell.
        const remained = ids.filter((id) => visible.has(id));
        const caughtUp = bottom && bottom === bottomId() && !restoring?.();
        if (
          (remained.length || caughtUp) &&
          session.unread.sync().capability === "frontier-sync" &&
          handle
        ) {
          // Dwell is already earned. Detach this lease so active-surface reflow
          // can schedule the next interval without revoking queued durability.
          const observed = handle;
          handle = undefined;
          observing.add(observed);
          // Viewing belongs only to the current handle: the write lease keeps
          // its read intent but stops reporting rows that may scroll away.
          // A view-only lease keeps that evidence until the next cancellation.
          observed.view([], () => false, false);
          try {
            handle = session.unread.reading(channelId, rootId, visit);
            handle.view([...visible], viewing);
            showing = !!visible.size;
          } catch {
            handle = undefined;
          }
          const through = caughtUp ? catchUpId() : undefined;
          void (async () => {
            if (through) await observed.catchUp(through, rootId);
            await observed.observe(remained);
          })()
            .catch(() => {})
            .finally(() => {
              if (observing.delete(observed)) observed.dispose();
            });
        }
      }, 300);
    }
    for (const event of ["pointerdown", "keydown", "reading-positioned"])
      element.addEventListener(event, schedule);
    element.addEventListener("scroll", reflow);
    const focus = (event: FocusEvent) =>
      focused(event.type === "focusin" ? event.target : event.relatedTarget)
        ? schedule()
        : stop();
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focus);
    window.addEventListener("blur", stop);
    window.addEventListener("focus", schedule);
    const visibility = () => {
      if (document.visibilityState === "visible") {
        present();
        return schedule();
      }
      stop();
      depart();
    };
    document.addEventListener("visibilitychange", visibility);
    // Pane transforms can bring unchanged rows into view without a resize.
    const motion = (event: Event) => {
      if (event.target instanceof Element && event.target.contains(element))
        schedule();
    };
    document.addEventListener("transitionend", motion);
    document.addEventListener("animationend", motion);
    const mutation = new MutationObserver(reflow);
    mutation.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // A retained pane concealed by an ancestor, even with no transition or
    // focus change, is a departure; layout, focus and blur are not.
    let concealed = !!element.closest(CONCEALED);
    let gone = departed(element);
    const concealment = new MutationObserver((records) => {
      if (
        !records.some(
          (record) =>
            record.target instanceof Element && record.target.contains(element),
        )
      )
        return;
      const now = !!element.closest(CONCEALED);
      const leaving = departed(element);
      if (leaving && !gone) depart();
      if (!leaving && gone) present();
      gone = leaving;
      if (now === concealed) return;
      concealed = now;
      if (!now) return schedule();
      stop();
    });
    concealment.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ["inert", "hidden", "aria-hidden"],
    });
    const resize = new ResizeObserver(reflow);
    resize.observe(element);
    present();
    schedule();
    return () => {
      stopped = true;
      stop();
      depart();
      document.removeEventListener("transitionend", motion);
      document.removeEventListener("animationend", motion);
      mutation.disconnect();
      concealment.disconnect();
      resize.disconnect();
      for (const event of ["pointerdown", "keydown", "reading-positioned"])
        element.removeEventListener(event, schedule);
      element.removeEventListener("scroll", reflow);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", focus);
      window.removeEventListener("blur", stop);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [
    session,
    channelId,
    rootId,
    scroller,
    settled,
    restoring,
    composer,
    enabled,
  ]);
}
