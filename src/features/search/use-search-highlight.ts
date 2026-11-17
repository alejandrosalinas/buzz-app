import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/** The keyboard highlight of a search picker. Focus stays in the search
 * field: Up and Down move the highlight, and Enter chooses the highlighted
 * row. If Tab moves focus to a row, focus follows the highlight instead, so
 * Enter on the focused row still chooses the highlighted one. Typed text highlights the first row, so Enter chooses it without an
 * arrow key. The highlight follows a row's key, not its position, as late
 * results arrive: a row inserted above cannot redirect Enter. When the
 * highlighted row leaves, the highlight returns to the first row rather than
 * reviving the old one. Enter before any row arrives, while results are
 * pending, chooses the first row once they are not, unless an edit, moving
 * the highlight, a choice, Escape or closing comes first. Enter on an action
 * row waits the same way while no result row has arrived, unless the user
 * highlighted that row. The hook draws nothing; rows keep their own markup. */
export function useSearchHighlight({
  query,
  keys,
  onChoose,
  open = true,
  onOpen,
  highlightEmpty = false,
  wrap = false,
  pending = false,
  isAction,
  initial,
  followFirst = false,
}: {
  query: string;
  /** Row keys, in display order. */
  keys: readonly string[];
  onChoose: (key: string) => void;
  /** Whether the rows are showing, for a picker in a popup. Reopening
   * scrolls the highlighted row back into view. */
  open?: boolean;
  /** Called when Up or Down opens a closed popup. The key highlights the
   * first or last row. */
  onOpen?: () => void;
  /** Highlight the first row before anything is typed, for a picker whose
   * unfiltered list is already the list to choose from. */
  highlightEmpty?: boolean;
  /** Up from the first row goes to the last, and Down from the last row
   * goes to the first. */
  wrap?: boolean;
  /** A row that should lead may still arrive for this text. */
  pending?: boolean;
  /** Whether a row acts on the search, such as narrowing it, rather than
   * being a result. */
  isAction?: ((key: string) => boolean) | undefined;
  /** The row highlighted as the picker mounts, such as the one highlighted
   * when it last closed; "" highlights none until the keyboard, pointer or
   * query does. Read once. */
  initial?: string;
  /** Until the keyboard or pointer moves it, the highlight stays on the
   * first row, whichever row that is as results arrive, rather than on the
   * row that was first. Enter chooses the row highlighted on screen. */
  followFirst?: boolean;
}) {
  const id = useId();
  const [selection, setSelection] = useState(() => ({
    query,
    key: initial ?? "",
    pointer: false,
    /** The row highlighted before the pointer took over, restored when the
     * pointer leaves. */
    resting: "",
    /** The pointer left with no keyboard row to return to: nothing is
     * highlighted until the query, keyboard or pointer says otherwise. */
    cleared: initial === "",
    /** Counts keyboard moves, so each one reveals its row, even the same row
     * after the list was scrolled away from it. */
    moves: 0,
    /** Nothing has moved the highlight for this text, which `followFirst`
     * keeps on the first row. */
    untouched: initial === undefined,
  }));
  const valid =
    selection.query === query &&
    (selection.cleared || keys.includes(selection.key));
  const fallback = highlightEmpty || query.trim() ? (keys[0] ?? "") : "";
  if (!valid && (selection.query !== query || selection.key !== fallback))
    setSelection({
      query,
      key: fallback,
      pointer: false,
      resting: "",
      cleared: false,
      moves: 0,
      untouched: true,
    });
  const active = valid
    ? selection.cleared
      ? ""
      : followFirst && selection.untouched
        ? fallback
        : selection.key
    : fallback;
  /** The text whose Enter waits for its first row. */
  const [awaiting, setAwaiting] = useState<string>();
  if (awaiting !== undefined && awaiting !== query) setAwaiting(undefined);
  const choose = (key: string | undefined) => {
    setAwaiting(undefined);
    if (key) onChoose(key);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: choose calls the latest onChoose.
  useEffect(() => {
    if (open && awaiting === query && !pending) choose(keys[0]);
  }, [open, awaiting, query, keys[0], pending]);
  const rowId = (key: string) => `${id}-${key}`;
  /** Highlights a row for the user, which drops a waiting Enter. */
  const select = (key: string, pointer = false) => {
    setAwaiting(undefined);
    setSelection((previous) => ({
      query,
      key,
      pointer,
      resting: key,
      cleared: false,
      moves: pointer ? previous.moves : previous.moves + 1,
      untouched: false,
    }));
  };
  /** The row an arrow key moves the highlight to. */
  const step = (down: boolean) => {
    const index = keys.indexOf(active);
    const next = index + (down ? 1 : -1);
    return (
      keys[
        index < 0
          ? down
            ? 0
            : keys.length - 1
          : wrap
            ? (next + keys.length) % keys.length
            : Math.max(0, Math.min(keys.length - 1, next))
      ] ?? ""
    );
  };
  // WebKit replays a pointer event when rows move under a resting cursor.
  // Only a real move may highlight a row, or new results would steal Enter.
  // Compare viewport coordinates: Linux WebKit reports screen coordinates
  // that do not change as the pointer moves.
  const pointer = useRef<{ x: number; y: number }>(undefined);
  /** Focus this hook moves to follow the highlight is not the keyboard's. */
  const following = useRef(false);
  const follow = (key: string) => {
    if (!document.activeElement?.id.startsWith(`${id}-`)) return;
    following.current = true;
    try {
      document.getElementById(rowId(key))?.focus({ preventScroll: true });
    } finally {
      following.current = false;
    }
  };
  const pointerMoved = (event: PointerEvent) => {
    const last = pointer.current;
    pointer.current = { x: event.clientX, y: event.clientY };
    return !!last && (last.x !== event.clientX || last.y !== event.clientY);
  };
  // The pointer is on a row it highlights, or just left the list; keep the
  // list still.
  const scroll = open && !(valid && selection.pointer) ? active : "";
  const moves = selection.moves;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each keyboard move reveals its row again.
  useEffect(() => {
    if (!scroll) return;
    const reveal = () =>
      document
        .getElementById(`${id}-${scroll}`)
        ?.scrollIntoView({ block: "nearest" });
    if (document.getElementById(`${id}-${scroll}`)) return void reveal();
    // A popup that just opened can mount its rows after this render.
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [scroll, moves, id]);
  return {
    /** The highlighted row's key, or "" for none. */
    active,
    /** The keyboard, pointer or a choice moved the highlight for this text. */
    moved: selection.query === query && !selection.untouched,
    select,
    choose,
    /** Highlight nothing until the keyboard, pointer or query picks a row. */
    clear: () =>
      setSelection((previous) => ({
        ...previous,
        query,
        key: "",
        pointer: false,
        resting: "",
        cleared: true,
        untouched: false,
      })),
    listId: id,
    rowId,
    /** Spread on the search field. */
    fieldProps: {
      "aria-activedescendant": open && active ? rowId(active) : undefined,
    },
    /** Spread on the element that contains the rows. */
    listProps: {
      onPointerMove(event: PointerEvent) {
        pointer.current = { x: event.clientX, y: event.clientY };
      },
      // A highlight the pointer made does not outlive it: leaving the list
      // returns to the row highlighted before, else to the list's own first
      // highlight, else to none. The list stays where the pointer left it.
      onPointerLeave(event: PointerEvent) {
        if (event.pointerType === "touch" || !selection.pointer) return;
        const key = keys.includes(selection.resting)
          ? selection.resting
          : fallback;
        setSelection((previous) =>
          previous.pointer ? { ...previous, key, cleared: !key } : previous,
        );
        // Focus returns with the highlight, so Enter still chooses it.
        if (key) follow(key);
      },
    },
    /** Spread on each row. */
    rowProps: (key: string) => ({
      id: rowId(key),
      // Tab can focus a row. Enter then chooses that row, so highlight it
      // and announce it. The row is already in view, so do not scroll.
      onFocus() {
        if (!following.current) select(key, true);
      },
      // Up and Down on a focused row move the highlight, and focus with it,
      // so Enter still chooses the highlighted row.
      onKeyDown(event: KeyboardEvent) {
        if (
          (event.key !== "ArrowDown" && event.key !== "ArrowUp") ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey ||
          !keys.length
        )
          return;
        event.preventDefault();
        // Keep the key from the composer behind a popup.
        event.stopPropagation();
        const next = step(event.key === "ArrowDown");
        select(next);
        document.getElementById(rowId(next))?.focus();
      },
      onPointerMove(event: PointerEvent) {
        if (
          event.pointerType !== "touch" &&
          pointerMoved(event) &&
          (active !== key || (followFirst && selection.untouched)) &&
          keys.includes(key)
        ) {
          setAwaiting(undefined);
          setSelection((previous) => ({
            ...previous,
            query,
            key,
            pointer: true,
            untouched: false,
            // The row highlighted before the pointer took over, to return to.
            resting: previous.pointer
              ? previous.resting
              : previous.cleared
                ? ""
                : previous.key,
            cleared: false,
          }));
          // While a row has focus, Enter activates that row, so focus must
          // follow the highlight. The row is under the pointer; do not scroll.
          follow(key);
        }
      },
    }),
    /** Call from the search field's keydown handler. Returns whether the key
     * was handled. Keys during IME composition or with Cmd, Ctrl or Alt are
     * never handled. While closed, only Up and Down are, through `onOpen`. */
    keyDown(event: KeyboardEvent) {
      if (
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return false;
      const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
      const down = event.key === "ArrowDown";
      if (!open) {
        if (!arrow || !keys.length || !onOpen) return false;
        event.preventDefault();
        onOpen();
        select((down ? keys[0] : keys.at(-1)) ?? "");
        return true;
      }
      const index = keys.indexOf(active);
      if (
        event.key === "Enter" &&
        pending &&
        !(valid && (selection.moves || selection.pointer)) &&
        keys.every((key) => isAction?.(key))
      ) {
        event.preventDefault();
        setAwaiting(query);
        return true;
      }
      if (event.key === "Enter" && index >= 0) {
        event.preventDefault();
        choose(active);
        return true;
      }
      if (event.key === "Escape") setAwaiting(undefined);
      if (arrow && keys.length) {
        event.preventDefault();
        select(step(down));
        return true;
      }
      return false;
    },
  };
}
