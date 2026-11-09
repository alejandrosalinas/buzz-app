import { useLayoutEffect, useState } from "react";

/**
 * Marks a scroller's edges that have content past them, with
 * `data-overflow-start` and `data-overflow-end`, for its edge fade. `inline`
 * follows horizontal scrolling, `block` vertical. Returns the scroller's ref.
 */
export function useScrollEdges(axis: "inline" | "block") {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!scroller) return;
    const update = () => {
      // Right-to-left scroll offsets are negative.
      const scrolled = Math.abs(
        axis === "inline" ? scroller.scrollLeft : scroller.scrollTop,
      );
      const hidden =
        axis === "inline"
          ? scroller.scrollWidth - scroller.clientWidth
          : scroller.scrollHeight - scroller.clientHeight;
      scroller.toggleAttribute("data-overflow-start", scrolled > 1);
      scroller.toggleAttribute("data-overflow-end", hidden - scrolled > 1);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    // Content added, removed or renamed changes the scroller without resizing it.
    const content = new MutationObserver(update);
    content.observe(scroller, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const size =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    // Its own size, and its children's: a collapsing group changes the
    // scrolled extent without a mutation the observer above sees.
    for (const box of [scroller, ...scroller.children]) size?.observe(box);
    return () => {
      scroller.removeEventListener("scroll", update);
      content.disconnect();
      size?.disconnect();
    };
  }, [axis, scroller]);
  return setScroller;
}
