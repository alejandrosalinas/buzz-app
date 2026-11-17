import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { QuotesIcon } from "../../shared/design-system/icons";
import {
  activeModal,
  behindActiveOverlay,
  observeOverlays,
} from "../../shared/design-system/overlayLayer";
import { Button } from "../../shared/design-system/ui/Button";
import { quotableSelection, quoteSelection } from "./selection-quote";
import styles from "./SelectionQuote.module.css";

type Edges = Readonly<{ top: number; bottom: number; right: number }>;
type Place = Readonly<{ top: number; left: number }>;

const GAP = 6;

/** The selection's first top and last line end, where the pointer finished;
 * null once the list has scrolled that end out of view. */
function edges(ranges: readonly Range[], list: HTMLElement): Edges | null {
  const rects = ranges.flatMap((range) => [...range.getClientRects()]);
  const first = rects[0];
  const last = rects.at(-1);
  const view = list.getBoundingClientRect();
  return first && last && last.bottom > view.top && last.top < view.bottom
    ? { top: first.top, bottom: last.bottom, right: last.right }
    : null;
}

const same = (a: Edges | null, b: Edges | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.right === b.right);

/** Below the selection's end, or above its start when the viewport ends first. */
function place(at: Edges, width: number, height: number): Place {
  const below = at.bottom + GAP;
  return {
    top:
      below + height > window.innerHeight - GAP
        ? Math.max(GAP, at.top - GAP - height)
        : below,
    left: Math.max(
      GAP,
      Math.min(at.right - width / 2, window.innerWidth - GAP - width),
    ),
  };
}

/** Offers to quote message text selected in this list into its own composer.
 * It waits for a pointer selection to finish so it does not chase the drag. */
export function SelectionQuote({
  list,
}: {
  list: RefObject<HTMLElement | null>;
}) {
  const [at, setAt] = useState<Edges | null>(null);
  const [placed, setPlaced] = useState<Place | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    let pressed = false;
    const read = () => {
      frame = 0;
      const element = list.current;
      // Interactive overlays own the page; Quote must not cover their actions.
      const target = pressed || !element ? undefined : quotableSelection();
      const next =
        target &&
        target.element === element &&
        !activeModal(document) &&
        !behindActiveOverlay(element)
          ? edges(target.ranges, element)
          : null;
      setAt((current) => (same(current, next) ? current : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    const press = (event: PointerEvent) => {
      // Pressing Quote itself must keep it mounted until the click lands.
      if (
        event.button !== 0 ||
        surface.current?.contains(event.target as Node | null)
      )
        return;
      pressed = true;
      schedule();
    };
    const release = () => {
      pressed = false;
      schedule();
    };
    const stopObserving = observeOverlays(schedule);
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    // Scrolling moves the selection without changing it.
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      stopObserving();
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [list]);
  // Measured before paint: the label's width follows the text size.
  useLayoutEffect(() => {
    const element = surface.current;
    setPlaced(
      at && element
        ? place(at, element.offsetWidth, element.offsetHeight)
        : null,
    );
  }, [at]);
  if (!at) return null;
  return createPortal(
    <div
      ref={surface}
      className={styles.selectionQuote}
      style={placed ?? { visibility: "hidden" }}
    >
      <Button
        size="sm"
        variant="quiet"
        // Keep the selection through the press so the quote is what is shown.
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (quoteSelection()) setAt(null);
        }}
      >
        <QuotesIcon aria-hidden />
        Quote
      </Button>
    </div>,
    document.body,
  );
}
