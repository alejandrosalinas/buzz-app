import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  behindActiveOverlay,
  observeOverlays,
} from "../../shared/design-system/overlayLayer";

const contentSelector =
  "[data-message-action-anchor], [data-message-attachments] > *";

const floatingQuery = "(hover: hover) and (pointer: fine)";
// One MediaQueryList for every row: `matchMedia` allocates and evaluates the
// query on each call, and these run in every row's first render and every
// external-store snapshot read. The list itself tracks modality changes. Keyed
// on the `matchMedia` function so a replaced implementation is re-queried.
let floatingSource: typeof window.matchMedia | undefined;
let floatingList: MediaQueryList | undefined;
const floating = () => {
  if (floatingSource !== window.matchMedia) {
    floatingSource = window.matchMedia;
    floatingList = floatingSource?.(floatingQuery);
  }
  return floatingList;
};
const subscribe = (notify: () => void) => {
  const query = floating();
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};
const snapshot = () => floating()?.matches ?? false;

const awaitingKeyboard = new Set<() => void>();
const activateKeyboardActions = (event: KeyboardEvent) => {
  if (event.key !== "Tab" || event.metaKey || event.ctrlKey) return;
  // Native Tab must see the real controls before choosing its destination,
  // including continuation rows with no preceding avatar/button to focus.
  flushSync(() => {
    for (const activate of awaitingKeyboard) activate();
  });
};

/** Defer untouched desktop controls, then preserve their state for the row's life. */
export function useMessageActionBarReady(
  rowRef: RefObject<HTMLDivElement | null> | undefined,
) {
  const [ready, setReady] = useState(
    () =>
      !rowRef ||
      !snapshot() ||
      document.documentElement.hasAttribute("data-keyboard-navigation"),
  );
  useEffect(() => {
    // Response activity is a sibling of the painted message. Interaction with
    // either belongs to the same message and must prepare its focus destination.
    const row =
      rowRef?.current?.closest<HTMLElement>("[data-message-id]") ??
      rowRef?.current;
    if (ready || !row) return;
    const activate = () => setReady(true);
    const query = floating();
    const modalityChanged = () => {
      if (!query?.matches) activate();
    };
    if (
      !query?.matches ||
      row.matches(":hover") ||
      row.contains(document.activeElement) ||
      document.documentElement.hasAttribute("data-keyboard-navigation")
    ) {
      activate();
      return;
    }
    row.addEventListener("pointerenter", activate);
    row.addEventListener("focusin", activate);
    query.addEventListener("change", modalityChanged);
    if (awaitingKeyboard.size === 0)
      window.addEventListener("keydown", activateKeyboardActions, true);
    awaitingKeyboard.add(activate);
    return () => {
      row.removeEventListener("pointerenter", activate);
      row.removeEventListener("focusin", activate);
      query.removeEventListener("change", modalityChanged);
      awaitingKeyboard.delete(activate);
      if (awaitingKeyboard.size === 0)
        window.removeEventListener("keydown", activateKeyboardActions, true);
    };
  }, [ready, rowRef]);
  return ready;
}

/** Keep the controls in DOM/tab order while painting outside list containment. */
export function useFloatingActionBar(
  rowRef: RefObject<HTMLDivElement | null> | undefined,
  barRef: RefObject<HTMLDivElement | null>,
  slotRef: RefObject<HTMLDivElement | null>,
  open: boolean,
) {
  const floating = useSyncExternalStore(subscribe, snapshot, () => false);
  const [revealed, setRevealed] = useState(false);
  const contentBounds = useRef<{
    content: DOMRect;
    toolbar: DOMRect;
    /** Byline band from the content to a bar moved off the author's name. */
    clearance: DOMRect | null;
  } | null>(null);

  useEffect(() => {
    const row = rowRef?.current;
    const bar = barRef.current;
    if (!floating || !row || !bar) return;
    const contentAt = (target: EventTarget | null) =>
      target instanceof Element && row.contains(target)
        ? target.closest(contentSelector)
        : null;
    // The toolbar is clamped to the scroller, not the row, so a short bubble's
    // route can cross the scroller's empty gutter. It never crosses another row.
    const scroller = row.closest("[data-message-scroller]");
    const routeSurface = (target: Element) =>
      row.contains(target) ||
      (!!scroller?.contains(target) && !target.closest("[data-layout]"));
    const hoverTarget = (target: EventTarget | null, event: PointerEvent) => {
      if (
        !(target instanceof Element) ||
        target.closest("[data-media-timecode], [data-message-reactions]")
      )
        return false;
      if (bar.contains(target) || contentAt(target)) return true;
      // Retain only an active hover: content gaps and the tapered route to the
      // toolbar are pass-through geometry, never activation or hit surfaces.
      const bounds = contentBounds.current;
      if (
        !hovered ||
        !bounds ||
        bounds.content.width <= 0 ||
        bounds.content.height <= 0 ||
        bounds.toolbar.width <= 0 ||
        bounds.toolbar.height <= 0 ||
        !routeSurface(target)
      )
        return false;
      const { content, toolbar, clearance } = bounds;
      const { clientX: x, clientY: y } = event;
      if (
        target.closest("[data-message-payload]") &&
        x >= content.left &&
        x <= content.right &&
        y >= content.top &&
        y <= content.bottom
      )
        return true;
      // A bar moved off the author's name no longer meets the content's top
      // edge: the byline band from the content to the bar keeps the hover on
      // the way to either end.
      if (
        clearance &&
        x >= clearance.left &&
        x <= clearance.right &&
        y >= clearance.top &&
        y <= clearance.bottom
      )
        return true;
      // Browser hit testing can round a fractional toolbar edge inward.
      // Keep the active path through that edge pixel until the bar takes over.
      const toolbarBottom = Math.floor(toolbar.bottom);
      if (y < toolbarBottom || y > content.bottom) return false;
      const span = content.bottom - toolbarBottom;
      const fraction = span > 0 ? (y - toolbarBottom) / span : 0;
      const left = Math.min(
        content.left,
        toolbar.left + (content.left - toolbar.left) * fraction,
      );
      const right = Math.max(
        content.right,
        toolbar.right + (content.right - toolbar.right) * fraction,
      );
      return x >= left && x <= right;
    };
    // The row includes empty space, bylines and accessories. Only painted
    // message content and the top-layer toolbar reveal pointer actions.
    const initialContent = row.querySelector(`:is(${contentSelector}):hover`);
    let hovered =
      (!!initialContent &&
        !row.querySelector(
          ":is([data-media-timecode], [data-message-reactions]):hover",
        )) ||
      bar.matches(":hover");
    // Read modality with focus on every update: pointer focus must not pin the
    // bar when hover leaves, including after keyboard-to-pointer transitions.
    const keyboardFocus = () =>
      !document.activeElement?.closest("[data-media-timecode]") &&
      (row.matches(":has(:focus-visible)") ||
        (document.documentElement.hasAttribute("data-keyboard-navigation") &&
          row.contains(document.activeElement)));
    // A preview card joins the top layer after a toolbar that is already
    // shown. Hiding that toolbar while the card is open would show it again
    // above the card on the next hover, so this row's open preview keeps it.
    // The card's close releases it. The selector finds a preview trigger with
    // any popup open, not only its card: MessageLink's context menu shares
    // the link, so that menu holds the toolbar too, hidden behind the menu.
    let shown = false;
    const update = (focused = keyboardFocus()) => {
      const ownsPopup = !!bar.querySelector(
        '[aria-haspopup][aria-expanded="true"]',
      );
      const next =
        hovered ||
        focused ||
        open ||
        ownsPopup ||
        (shown &&
          !!row.querySelector("[data-preview-card-trigger][data-popup-open]"));
      shown = next;
      if (!next) row.removeAttribute("data-actions-revealed");
      setRevealed(next);
    };
    // Pointer events outside the row never reach its listeners. Follow a
    // retained route through the gutter until it re-enters the row or leaves.
    let tracking = false;
    const outside = (event: PointerEvent) => {
      const target =
        event.type === "pointerout" ? event.relatedTarget : event.target;
      if (target instanceof Node && row.contains(target)) return;
      const next = hoverTarget(target, event);
      if (!next) track(false);
      if (hovered === next) return;
      hovered = next;
      update();
    };
    const track = (next: boolean) => {
      if (tracking === next) return;
      tracking = next;
      if (next) {
        document.addEventListener("pointermove", outside, true);
        document.addEventListener("pointerout", outside, true);
      } else {
        document.removeEventListener("pointermove", outside, true);
        document.removeEventListener("pointerout", outside, true);
      }
    };
    const over = (event: PointerEvent) => {
      track(false);
      hovered = hoverTarget(event.target, event);
      update();
    };
    const out = (event: PointerEvent) => {
      hovered = hoverTarget(event.relatedTarget, event);
      track(
        hovered &&
          !(
            event.relatedTarget instanceof Node &&
            row.contains(event.relatedTarget)
          ),
      );
      update();
    };
    const move = (event: PointerEvent) => {
      const next = hoverTarget(event.target, event);
      if (hovered === next) return;
      hovered = next;
      update();
    };
    const focusIn = () => update();
    const focusOut = (event: FocusEvent) => {
      update(
        event.relatedTarget instanceof Node &&
          row.contains(event.relatedTarget) &&
          keyboardFocus(),
      );
    };
    // Delegation also covers content replaced by an edit or attachment load.
    row.addEventListener("pointerover", over);
    row.addEventListener("pointerout", out);
    row.addEventListener("pointermove", move);
    row.addEventListener("focusin", focusIn);
    row.addEventListener("focusout", focusOut);
    const observer = new MutationObserver(() => {
      // Recheck focus if a control is removed without dispatching focusout.
      update();
    });
    observer.observe(row, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "data-popup-open"],
    });
    update();
    return () => {
      row.removeEventListener("pointerover", over);
      row.removeEventListener("pointerout", out);
      row.removeEventListener("pointermove", move);
      row.removeEventListener("focusin", focusIn);
      row.removeEventListener("focusout", focusOut);
      track(false);
      observer.disconnect();
      row.removeAttribute("data-actions-revealed");
    };
  }, [floating, open, rowRef, barRef]);

  useLayoutEffect(() => {
    const row = rowRef?.current;
    const bar = barRef.current;
    const slot = slotRef.current;
    if (!floating || !revealed || !row || !bar || !slot) return;
    const scroller = row.closest<HTMLElement>("[data-message-scroller]");
    const workspaceSelector = "[data-main-workspace], [data-panel-workspace]";
    const workspace = row.closest(workspaceSelector);
    let frame = 0;
    // Returns whether the row shows as revealed. Positioning defers that row
    // write until the bar is placed, so an offscreen frame writes nothing.
    const updateVisibility = (reveal = true) => {
      const trigger = bar.querySelector(
        '[aria-haspopup][aria-expanded="true"]',
      );
      const ownsPopup = !!trigger;
      // The bar's own menu opens beside its trigger, so the bar stays to show
      // what the menu acts on. Pickers, modals and other popups still cover it.
      const menu =
        trigger?.getAttribute("aria-haspopup") === "menu"
          ? document.getElementById(trigger.getAttribute("aria-controls") ?? "")
          : null;
      const blocked = behindActiveOverlay(row, menu);
      // The toolbar yields, but its popup must still identify the target message.
      const revealed = !blocked || ownsPopup;
      if (reveal) row.toggleAttribute("data-actions-revealed", revealed);
      bar.style.visibility = blocked ? "hidden" : "";
      return revealed;
    };
    const hide = () => {
      row.removeAttribute("data-actions-revealed");
      contentBounds.current = null;
      if (bar.hasAttribute("popover")) bar.hidePopover?.();
      // Closed popovers return to their slot's containing block. Viewport offsets
      // there would create invisible overflow and interfere with scrolling.
      bar.style.top = "";
      bar.style.left = "";
      bar.style.right = "";
      bar.style.maxWidth = "";
      bar.style.visibility = "";
      bar.style.clipPath = "";
    };
    // A narrow side pane covers, but does not unmount, the channel. Only a
    // second workspace can cover this one, so skip the hit test without it.
    const covered = (anchor: DOMRect) => {
      if (!workspace) return false;
      const workspaces = document.querySelectorAll(workspaceSelector);
      if (workspaces.length < 2) return false;
      const front = document
        .elementsFromPoint(
          Math.max(
            0,
            Math.min(
              anchor.x + anchor.width / 2,
              document.documentElement.clientWidth - 1,
            ),
          ),
          Math.max(0, Math.min(anchor.top + 1, window.innerHeight - 1)),
        )
        .find(
          (element) =>
            !bar.contains(element) && element.closest(workspaceSelector),
        )
        ?.closest(workspaceSelector);
      return !!front && front !== workspace;
    };
    const position = () => {
      // A frame can outlive the document that held the bar (for example after
      // the page content is replaced). showPopover throws on detached elements.
      if (!bar.isConnected) return;
      // Resolve the painted message again when edits replace text with media.
      const visual =
        row.querySelector<HTMLElement>("[data-message-action-anchor]") ??
        row.querySelector("[data-message-attachments]")?.firstElementChild ??
        slot;
      // Read every rect before writing any style. A write between reads forces
      // a synchronous layout of the whole timeline on each positioning frame.
      const anchor = visual.getBoundingClientRect();
      // The payload wrapper can be full width. Measure only rendered content,
      // excluding bylines, reactions, activity and the row's empty side space.
      let whole = anchor;
      let first = visual;
      for (const element of row.querySelectorAll(contentSelector)) {
        const rect =
          element === visual ? anchor : element.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (rect.top < whole.top) first = element;
        const left = Math.min(whole.left, rect.left);
        const top = Math.min(whole.top, rect.top);
        whole = new DOMRect(
          left,
          top,
          Math.max(whole.right, rect.right) - left,
          Math.max(whole.bottom, rect.bottom) - top,
        );
      }
      // The author's name opens a profile; the bar must not cover it.
      const author = row
        .querySelector("[data-message-author]")
        ?.getBoundingClientRect();
      if (covered(anchor)) {
        hide();
        return;
      }
      // Hide the painting and keyboard controls without moving the anchor of
      // a picker launched from this bar. Base UI owns dismissal/return focus.
      const rowRevealed = updateVisibility(false);
      // Style reads are cheap here: the rect reads above already left layout clean.
      const style = getComputedStyle(bar);
      const overlap = Number.parseFloat(style.scrollMarginBlockStart) || 0;
      const gap = Number.parseFloat(style.scrollMarginInlineEnd) || 0;
      const rtl = getComputedStyle(row).direction === "rtl";
      const viewport = scroller?.getBoundingClientRect();
      const rowBounds = row.getBoundingClientRect();
      const start =
        Math.max(0, viewport?.left ?? rowBounds.left) + (viewport ? gap : 0);
      const end =
        Math.min(
          document.documentElement.clientWidth,
          viewport?.right ?? rowBounds.right,
        ) - (viewport ? gap : 0);
      const maxWidth = `${Math.max(0, end - start)}px`;
      // Update the constraint only when the toolbar layout changes.
      if (bar.style.maxWidth !== maxWidth || !bar.matches(":popover-open")) {
        bar.style.maxWidth = maxWidth;
        bar.showPopover?.();
      }
      const width = bar.offsetWidth;
      // Layout height: an opening scale transition must not move the bar.
      const height = bar.offsetHeight;
      // Keep main's single above location while clearing every part of the
      // message. No attachment-specific placement or pointer anchor is needed.
      bar.style.transformOrigin = rtl ? "left bottom" : "right bottom";
      // Only a text-first message has bubble padding to overlap.
      const aboveOverlap = first.closest("[data-message-attachments]")
        ? 0
        : overlap;
      const top = whole.top + aboveOverlap;
      const paintedTop = top - height;
      if (
        viewport &&
        (whole.top <= viewport.top || paintedTop >= viewport.bottom)
      ) {
        hide();
        return;
      }
      // The row's siblings observer would reschedule on every row write; an
      // unchanged toggle records no mutation.
      row.toggleAttribute("data-actions-revealed", rowRevealed);
      // Keep the pane header clickable as actions scroll beneath its edge.
      const hidden = viewport ? viewport.top - paintedTop : 0;
      bar.style.clipPath =
        hidden > 0 ? `inset(${hidden}px -100vmax -100vmax)` : "";
      const left = rtl ? whole.left - overlap : whole.right - width + overlap;
      // Over a short message the bar would cover the name, so it clears the
      // name on the side with room. A mirrored row keeps its place: its bar
      // already ends at the avatar.
      const cleared =
        author?.width &&
        author.bottom > paintedTop &&
        author.top < top &&
        !row.hasAttribute("data-viewer-message")
          ? rtl
            ? Math.min(left, author.left - gap - width)
            : Math.max(left, author.right + gap)
          : left;
      const placedLeft = Math.max(start, Math.min(cleared, end - width));
      const toolbar = new DOMRect(placedLeft, paintedTop, width, height);
      const clearanceLeft = Math.min(whole.left, toolbar.left);
      contentBounds.current = {
        content: whole,
        toolbar,
        clearance:
          cleared === left
            ? null
            : new DOMRect(
                clearanceLeft,
                paintedTop,
                Math.max(whole.right, toolbar.right) - clearanceLeft,
                height,
              ),
      };
      bar.style.top = `${top}px`;
      bar.style.left = `${placedLeft}px`;
      bar.style.right = "auto";
    };
    // A transition or animation on the slot or an ancestor (such as a sliding
    // drawer) moves it without resizing, mutating or scrolling anything.
    const moving = () => {
      for (let node: Element | null = slot; node; node = node.parentElement)
        for (const animation of node.getAnimations?.() ?? [])
          if (
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime)
          )
            return true;
      return false;
    };
    let following = false;
    // Every move of the slot arrives through an event or observer below. Read
    // its rect once per frame from those, rather than polling it every frame and
    // forcing a layout whenever the timeline is mid-mutation. Only while finite
    // motion is in flight does it follow every frame, ending with a realignment
    // at the resting position.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        position();
        if (following) following = moving();
        if (following) schedule();
      });
    };
    const follow = () => {
      following = true;
      schedule();
    };
    const motion = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(slot)) follow();
    };
    const motionEvents = [
      "transitionrun",
      "transitionend",
      "transitioncancel",
      "animationstart",
      "animationend",
      "animationcancel",
    ];
    // Native top-layer boxes do not participate in their DOM ancestor's wheel
    // scroll chain. Keep scrolling the owning history when actions are under
    // the pointer; leave browser zoom gestures alone.
    const wheel = (event: WheelEvent) => {
      if (!scroller || event.ctrlKey || !bar.matches(":popover-open")) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scroller.clientHeight
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? Number.parseFloat(getComputedStyle(scroller).lineHeight) || 16
            : 1;
      event.preventDefault();
      scroller.scrollBy({
        left: event.deltaX * unit,
        top: event.deltaY * unit,
        behavior: "instant",
      });
    };
    bar.addEventListener("wheel", wheel, { passive: false });
    position();
    if (moving()) follow();
    for (const type of motionEvents)
      document.addEventListener(type, motion, true);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(slot);
    observer.observe(row);
    observer.observe(bar);
    // Sibling edits and media measurements move the slot without resizing any
    // observed node. The toolbar's own positioning writes must not retrigger it.
    const siblings = new MutationObserver((records) => {
      if (records.some((record) => !bar.contains(record.target))) schedule();
    });
    if (scroller) {
      observer.observe(scroller);
      siblings.observe(scroller, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
    // Focus restoration can run before the next animation frame. Release the
    // hidden trigger as soon as its popup closes; coalesce only geometry work.
    const unobserveOverlays = observeOverlays(() => {
      updateVisibility();
      schedule();
    });
    return () => {
      bar.removeEventListener("wheel", wheel);
      cancelAnimationFrame(frame);
      for (const type of motionEvents)
        document.removeEventListener(type, motion, true);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      siblings.disconnect();
      unobserveOverlays();
      hide();
      // An overlay or positioning update can restore this attribute between a
      // hover update removing it and React committing the hidden bar.
      row.removeAttribute("data-actions-revealed");
    };
  }, [floating, revealed, rowRef, barRef, slotRef]);

  return floating;
}
