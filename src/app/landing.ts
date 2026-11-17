import { useCallback, useEffect, useRef, type RefCallback } from "react";
import { scrollport } from "./scrollport";

/** Input on a scrollport by which the user scrolls it, or may be about to. */
const SCROLLING = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
/** Keys that scroll the scrollport around whatever holds focus. */
const SCROLL_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  " ",
]);
/** How long the layout must hold still before a landing stops following it. */
export const SETTLED_MS = 5000;
/** The longest a landing follows the layout after it first lands. Every
 * change restarts the wait for it to settle, the landing's own scroll too. */
export const FOLLOW_MS = 12_000;

/**
 * Lands `visit` on what `selector` finds in the section the returned ref is
 * attached to: in view and focused. A section that replaces it in the same
 * commit, while the replaced one still held focus, takes the focus back and
 * lands again; one that goes with none in its place ends the landing. Until
 * the layout settles, as lists load and siblings re-render, and for at most
 * FOLLOW_MS, the landing follows it, and lands again whenever the layout moved
 * the target or cut off the section where scrolling could still show it. Only
 * the user scrolling the scrollport stops it scrolling, and focus moving on
 * ends it.
 */
export function useLanding(
  visit: string | undefined,
  selector: string,
): RefCallback<HTMLElement> {
  const landing = useRef<Landing>(undefined);
  // The visit ended, or what owns the section unmounted.
  useEffect(
    () => () => {
      if (!landing.current || landing.current.visit !== visit) return;
      landing.current.end();
      landing.current = undefined;
    },
    [visit],
  );
  return useCallback(
    (section: HTMLElement | null) => {
      if (landing.current && landing.current.visit !== visit) {
        landing.current.end();
        landing.current = undefined;
      }
      const target = section?.querySelector<HTMLElement>(selector);
      if (!visit || !section || !target) return;
      landing.current ??= new Landing(visit);
      const current = landing.current;
      current.attach(section, target);
      // React detaches the ref before removing the node.
      return () => current.detach(target);
    },
    [visit, selector],
  );
}

class Landing {
  /** The user scrolled the scrollport; no landing scrolls again. */
  private away = false;
  /** Focus moved on, or the visit ended; nothing lands again. */
  private done = false;
  /** FOLLOW_MS passed; only a replacement lands again. */
  private expired = false;
  private section: HTMLElement | undefined;
  private target: HTMLElement | undefined;
  private port: Element | null = null;
  /** The target's offset from the scrollport's top, as it last landed. */
  private placed = 0;
  private scrolls: Element | Document | undefined;
  private observer: ResizeObserver | undefined;
  private settling: ReturnType<typeof setTimeout> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly visit: string) {}

  attach(section: HTMLElement, target: HTMLElement) {
    if (this.done) return;
    this.target?.removeEventListener("focusout", this.left);
    this.section = section;
    this.target = target;
    this.listen(scrollport(target) ?? document.scrollingElement ?? null);
    target.tabIndex = -1;
    if (!this.away) this.land();
    target.focus({ preventScroll: true });
    target.addEventListener("focusout", this.left);
    this.expiry ??= setTimeout(() => {
      this.expired = true;
      this.unfollow();
    }, FOLLOW_MS);
    this.follow();
  }

  detach(target: HTMLElement) {
    target.removeEventListener("focusout", this.left);
    if (this.target !== target) return;
    this.section = this.target = undefined;
    this.unfollow();
    // A replacement takes the focus back only while this target held it,
    // and attaches in the same commit. A section gone with none in its place
    // took the focus with it.
    if (document.activeElement !== target) this.end();
    else
      queueMicrotask(() => {
        if (!this.target && !this.done) this.end();
      });
  }

  end() {
    this.done = true;
    this.target?.removeEventListener("focusout", this.left);
    this.section = this.target = undefined;
    this.unfollow();
    clearTimeout(this.expiry);
    this.listen(null);
  }

  private land() {
    this.target?.scrollIntoView({ block: "start", behavior: "instant" });
    this.placed = this.offset();
  }

  /** Where the scrollport shows content, in viewport coordinates. */
  private view() {
    const port = this.port;
    if (!port || port === document.scrollingElement)
      return { top: 0, bottom: document.documentElement.clientHeight };
    const top = port.getBoundingClientRect().top + port.clientTop;
    return { top, bottom: top + port.clientHeight };
  }

  private offset() {
    return (this.target?.getBoundingClientRect().top ?? 0) - this.view().top;
  }

  /** The layout changed, or something other than the user scrolled. */
  private check = () => {
    const { port, section } = this;
    if (this.away || this.done || !port || !section) return;
    const moved = Math.abs(this.offset() - this.placed) >= 1;
    const cut =
      section.getBoundingClientRect().bottom > this.view().bottom + 1 &&
      port.scrollTop < port.scrollHeight - port.clientHeight - 1;
    if (moved || cut) this.land();
    this.settle();
  };

  private follow() {
    this.unfollow();
    const { port, section } = this;
    if (this.away || this.done || this.expired || !port || !section) return;
    // A clamp moves scrollTop without resizing anything it observes.
    this.scrolls = port === document.scrollingElement ? document : port;
    this.scrolls.addEventListener("scroll", this.check, { passive: true });
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(this.check);
      // Content-sized ancestors change height with whatever loads above or
      // below the target; the scrollport's own children may be fixed.
      for (
        let node: Element | null = section;
        node && node !== port;
        node = node.parentElement
      )
        observer.observe(node);
      this.observer = observer;
    }
    this.settle();
  }

  private unfollow() {
    this.scrolls?.removeEventListener("scroll", this.check);
    this.scrolls = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    clearTimeout(this.settling);
    this.settling = undefined;
  }

  private settle() {
    clearTimeout(this.settling);
    this.settling = setTimeout(() => this.unfollow(), SETTLED_MS);
  }

  private listen(port: Element | null) {
    if (port === this.port) return;
    this.unlisten();
    this.port = port;
    if (this.away || this.done) return;
    for (const type of SCROLLING)
      port?.addEventListener(type, this.scrolling, {
        capture: true,
        passive: true,
      });
  }

  private unlisten() {
    for (const type of SCROLLING)
      this.port?.removeEventListener(type, this.scrolling, { capture: true });
  }

  private scrolling = (event: Event) => {
    if (
      event.type === "keydown" &&
      !SCROLL_KEYS.has((event as KeyboardEvent).key)
    )
      return;
    this.away = true;
    this.unfollow();
    this.unlisten();
  };

  /** Focus left the target for good once it settles somewhere else; a window
   * that lost focus keeps it on the target. */
  private left = () => {
    const target = this.target;
    queueMicrotask(() => {
      if (target && this.target === target && document.activeElement !== target)
        this.end();
    });
  };
}
