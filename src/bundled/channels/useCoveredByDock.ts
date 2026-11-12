import { useLayoutEffect, useState, type RefObject } from "react";

const live = (element: HTMLElement) =>
  !element.closest("[hidden], [inert]") && element.getClientRects().length > 0;

/**
 * Focus the board's dock where Space and Enter do nothing: the first live, in
 * document order, of a panel's own landing (as PanelCard's when it opened) or
 * a selected tab, so a stacked dock starts at its top pane. The tab is a Base
 * UI `<button role="tab">`; Delete closes it when it can close. Never a plain
 * button, which Space or Enter would press.
 */
export function focusDock(board: Element | null | undefined) {
  Array.from(
    board?.querySelectorAll<HTMLElement>(
      ':scope > [data-panel-dock] > * > [tabindex="-1"][aria-label], :scope > [data-panel-dock] [role="tab"][aria-selected="true"]',
    ) ?? [],
  )
    .find(live)
    ?.focus({ preventScroll: true });
}

/**
 * Whether the board's open dock floats over `content`, as a card or at full
 * width. A media and a container query decide that, so CSS stays the only
 * owner of the breakpoints: this reads the dock's computed position.
 */
export function useCoveredByDock(
  board: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  open: boolean,
) {
  const [overlay, setOverlay] = useState(false);
  useLayoutEffect(() => {
    const element = board.current;
    if (!open || !element) return;
    const dock = element.querySelector<HTMLElement>(
      ":scope > [data-panel-dock]",
    );
    const measure = () => {
      const covering = !!dock && getComputedStyle(dock).position === "absolute";
      // Inert content would drop focus to the page, so hand it to the dock
      // first, as narrow Settings hands it to its details.
      if (covering && content.current?.contains(document.activeElement))
        focusDock(element);
      setOverlay(covering);
    };
    measure();
    // Either query flips with the board's or the dock's size.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (dock) observer.observe(dock);
    return () => {
      observer.disconnect();
      // A reopened dock never covers from a stale width.
      setOverlay(false);
    };
  }, [board, content, open]);
  // Derived while rendering, so closing the dock uncovers in the same commit.
  return open && overlay;
}
