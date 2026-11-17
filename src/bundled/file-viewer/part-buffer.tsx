import {
  type ReactNode,
  type RefObject,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { useNear, useSize } from "./layout";
import styles from "./FileViewer.module.css";

// A long file reads as one document, buffered like a stream: the consecutive
// parts around the reader's place are on screen, the next part each way is
// prepared ahead in idle time, coming within a screen of either end adds the
// part there, a part at an end more than two screens away goes, and what's in
// view stays put as parts come and go. A seek shows one part alone.

/** Prepared parts kept, so scrolling back, or on to a part prepared ahead,
 * doesn't prepare it again. */
const KEPT_PARTS = 6;
/** An end part this many screens from view goes: twice an edge's reach, so a
 * part that goes is never in reach again at once and short parts can't trade
 * back and forth between the ends. */
const DROP_SCREENS = 2;
/** The part ahead (then behind) is prepared this long after the parts on screen change. */
const READ_AHEAD_MS = 250;
/** How deep into the parts the element at the top of the view is looked for:
 * a part, its blocks, and a list's or table's rows. A table's own wrappers
 * don't count: its top stays put when an earlier row grows, a row's doesn't. */
const ANCHOR_DEPTH = 4;
const TABLE_WRAPPERS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT"]);

export type BufferedPart<T> = Readonly<{ index: number; prepared: T }>;
export type BufferEvent<T> =
  /** A seek: part `index` alone. */
  | Readonly<{ type: "seek"; index: number; prepared: T }>
  /** A scroll: the part just before or after those on screen. */
  | Readonly<{ type: "extend"; index: number; prepared: T }>
  /** A scroll: the part at an end, far from view. */
  | Readonly<{ type: "drop"; index: number }>;

/**
 * shown --seek(i)--> [i], unless i is alone on screen already
 * shown --extend(i)--> shown + i, only for first - 1 or last + 1
 * shown --drop(i)--> shown - i, only for first or last, never the only part
 * Anything else returns `shown` itself.
 */
export function reduceBuffer<T>(
  shown: readonly BufferedPart<T>[],
  event: BufferEvent<T>,
  count: number,
): readonly BufferedPart<T>[] {
  const first = shown[0]?.index;
  const last = shown.at(-1)?.index;
  if (
    first === undefined ||
    last === undefined ||
    !Number.isInteger(event.index) ||
    event.index < 0 ||
    event.index >= count
  )
    return shown;
  if (event.type === "drop") {
    if (shown.length === 1) return shown;
    if (event.index === first) return shown.slice(1);
    if (event.index === last) return shown.slice(0, -1);
    return shown;
  }
  const part = { index: event.index, prepared: event.prepared };
  if (event.type === "seek")
    return shown.length === 1 && first === event.index ? shown : [part];
  if (event.index === last + 1) return [...shown, part];
  if (event.index === first - 1) return [part, ...shown];
  return shown;
}

/** A pane kept in the background (`content-visibility: hidden` or
 * `display: none`) lays nothing out: every part reads as out of view and
 * every size as 0. */
const isShown = (node: HTMLElement) =>
  node.checkVisibility
    ? node.checkVisibility()
    : node.getClientRects().length > 0;

export type BufferControl = {
  /** Shows part `index` alone, then calls `then` once it is on screen. */
  seek(index: number, then: () => void): void;
};

export type PartBufferProps<T> = {
  count: number;
  /** The element that scrolls the parts. */
  scroller: HTMLElement | null;
  /** Part i's content, made once while kept. */
  prepare(index: number): T;
  /** Keep it stable: a new one renders every part on screen again. */
  render(index: number, prepared: T): ReactNode;
  control?: RefObject<BufferControl | null>;
};

/** The edge above or below the parts on screen: within a screen of view, it adds part `index`. */
function Edge({
  index,
  scroller,
  screen,
  reach,
}: {
  index: number;
  scroller: HTMLElement | null;
  screen: number;
  reach(index: number): void;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const near = useNear(node, scroller, screen);
  useEffect(() => {
    if (near) reach(index);
  }, [near, index, reach]);
  return <div ref={setNode} className={styles.edge} aria-hidden="true" />;
}

/** Rendered again only when its part or `render` changes, not when the parts
 * around it do. */
const Content = memo(function Content<T>({
  index,
  prepared,
  render,
}: {
  index: number;
  prepared: T;
  render: PartBufferProps<T>["render"];
}) {
  return <>{render(index, prepared)}</>;
}) as <T>(props: {
  index: number;
  prepared: T;
  render: PartBufferProps<T>["render"];
}) => ReactNode;

/** A part on screen; at an end, more than DROP_SCREENS from view, it goes. A
 * part that renders nothing (blank lines, link definitions) takes a line:
 * distance needs height, or a run of such parts would all come on screen.
 * Nothing goes while the pane is hidden. */
function Part({
  index,
  end,
  scroller,
  screen,
  drop,
  children,
}: {
  index: number;
  end: boolean;
  scroller: HTMLElement | null;
  screen: number;
  drop(index: number): void;
  children: ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (node.current?.offsetHeight === 0) node.current.dataset.blank = "";
  }, []);
  useEffect(() => {
    if (!end || !scroller || !node.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (isShown(scroller) && !entries.some((entry) => entry.isIntersecting))
          drop(index);
      },
      { root: scroller, rootMargin: `${DROP_SCREENS * screen}px 0px` },
    );
    observer.observe(node.current);
    return () => observer.disconnect();
  }, [end, scroller, screen, index, drop]);
  return (
    <div ref={node} className={styles.part} data-part={index}>
      {children}
    </div>
  );
}

export function PartBuffer<T>({
  count,
  scroller,
  prepare,
  render,
  control,
}: PartBufferProps<T>) {
  const kept = useRef(new Map<number, T>());
  const latestPrepare = useRef(prepare);
  latestPrepare.current = prepare;
  const take = useCallback((index: number) => {
    const cache = kept.current;
    const prepared = cache.has(index)
      ? (cache.get(index) as T)
      : latestPrepare.current(index);
    cache.delete(index);
    cache.set(index, prepared);
    for (const oldest of cache.keys()) {
      if (cache.size <= KEPT_PARTS) break;
      cache.delete(oldest);
    }
    return prepared;
  }, []);
  const [shown, dispatch] = useReducer(
    (state: readonly BufferedPart<T>[], event: BufferEvent<T>) =>
      reduceBuffer(state, event, count),
    undefined,
    () => [{ index: 0, prepared: take(0) }],
  );
  /** The parts committed on screen, not a transition's render in progress. */
  const shownNow = useRef(shown);
  const container = useRef<HTMLDivElement>(null);
  const screen = useSize(scroller).height;
  /** While the pane is hidden, parts and edges don't watch the view. Shown
   * again, they watch afresh, so each part's distance is measured again: the
   * browser sends nothing new for a part that was out of reach and still is. */
  const [visible, setVisible] = useState(true);

  useLayoutEffect(() => {
    if (!scroller) return;
    // The buffer keeps the view in place itself; the browser's anchoring would move it twice.
    scroller.style.overflowAnchor = "none";
    return () => {
      scroller.style.overflowAnchor = "";
    };
  }, [scroller]);

  const partNode = (index: number) =>
    container.current?.querySelector<HTMLElement>(
      `:scope > [data-part="${index}"]`,
    ) ?? null;
  /** An element's top in the scroller's content, whatever the scroll position. */
  const contentTop = (node: HTMLElement) =>
    scroller
      ? node.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      : 0;
  /** The tops of the parts on screen, noted before each change and after each
   * commit: the next commit finds the first part still on screen and moves the
   * view by how far that part moved, so what's in view stays put even when a
   * drop commits before an extend that is still rendering. */
  const tops = useRef({ scrollTop: 0, parts: new Map<number, number>() });
  const noteTops = () => {
    tops.current = {
      scrollTop: scroller?.scrollTop ?? 0,
      parts: new Map(
        shownNow.current.flatMap(({ index }) => {
          const node = partNode(index);
          return node ? [[index, contentTop(node)] as const] : [];
        }),
      ),
    };
  };
  /** The element at the top of the view and its top in the content, noted on
   * scroll and after each commit: when something above it changes size on its
   * own (a picture loading), the view moves by as much as that element did.
   * At the very top nothing is kept, so what appears there is seen. While
   * hidden, and once shown until the view is back, it keeps the last one. */
  const anchor = useRef<
    { node: HTMLElement; top: number; scrollTop: number } | undefined
  >(undefined);
  /** Set while the pane is hidden, until keepAnchor puts the view back. */
  const hidden = useRef(false);
  const noteAnchor = () => {
    if (!scroller || !container.current || hidden.current || !isShown(scroller))
      return;
    const line = scroller.getBoundingClientRect().top;
    let node: HTMLElement | undefined;
    for (
      let parent: Element = container.current, depth = 0;
      depth < ANCHOR_DEPTH;
    ) {
      const child = Array.from(parent.children).find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          element.getBoundingClientRect().bottom > line,
      );
      if (!child) break;
      node = parent = child;
      if (!TABLE_WRAPPERS.has(child.tagName)) depth++;
    }
    anchor.current = node && {
      node,
      top: contentTop(node),
      scrollTop: scroller.scrollTop,
    };
  };
  /** Where to move from: the noted position when the content got shorter and
   * the browser has clamped it already, so the move isn't made twice. */
  const from = (target: HTMLElement, noted: number) => {
    const now = target.scrollTop;
    return now < noted && now >= target.scrollHeight - target.clientHeight - 1
      ? noted
      : now;
  };
  /** Shown again, the view goes back first: WebKit forgets the scroll
   * position of an element in `display: none`. */
  const keepAnchor = () => {
    if (!scroller || !isShown(scroller)) return;
    if (hidden.current && anchor.current)
      scroller.scrollTop = anchor.current.scrollTop;
    hidden.current = false;
    const noted = anchor.current;
    const moved =
      scroller.scrollTop > 0 && noted?.node.isConnected
        ? contentTop(noted.node) - noted.top
        : 0;
    if (noted && moved)
      scroller.scrollTop = from(scroller, noted.scrollTop) + moved;
    noteTops();
    noteAnchor();
  };
  /** A seek's follow-up, once its part is on screen. */
  const afterSeek = useRef<(() => void) | undefined>(undefined);
  /** The way the reader last went: prepare ahead that way first. */
  const backward = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: noteTops reads the scroller it closes over.
  const reach = useCallback(
    (index: number) => {
      const current = shownNow.current;
      const first = current[0]?.index ?? 0;
      const last = current.at(-1)?.index ?? 0;
      if (index !== first - 1 && index !== last + 1) return;
      backward.current = index < first;
      noteTops();
      const prepared = take(index);
      // React builds the part's DOM in slices between frames, not in one long task.
      startTransition(() => dispatch({ type: "extend", index, prepared }));
    },
    [scroller, take],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: noteTops reads the scroller it closes over.
  const drop = useCallback(
    (index: number) => {
      if (shownNow.current.length < 2) return;
      noteTops();
      dispatch({ type: "drop", index });
    },
    [scroller],
  );

  useImperativeHandle(
    control,
    () => ({
      seek(index, then) {
        if (!Number.isInteger(index) || index < 0 || index >= count) return;
        const current = shownNow.current;
        if (current.length === 1 && current[0]?.index === index) return then();
        afterSeek.current = then;
        backward.current = false;
        dispatch({ type: "seek", index, prepared: take(index) });
      },
    }),
    [count, take],
  );

  // Keep what's in view where it was, then run a seek's follow-up. A seek
  // keeps no part, so nothing moves: its follow-up scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per change of the parts on screen.
  useLayoutEffect(() => {
    shownNow.current = shown;
    const noted = tops.current;
    const stays = shown.find(({ index }) => noted.parts.has(index));
    const node = stays && partNode(stays.index);
    const was = stays && noted.parts.get(stays.index);
    if (scroller && isShown(scroller) && node && was !== undefined)
      // A part dropped above can leave the content shorter than the old
      // scroll position for a moment, and the browser clamps it.
      scroller.scrollTop =
        from(scroller, noted.scrollTop) + contentTop(node) - was;
    noteTops();
    const then = afterSeek.current;
    afterSeek.current = undefined;
    then?.();
    noteAnchor();
  }, [shown]);
  // Any other commit, such as a notice above the parts: keep what's in view.
  useLayoutEffect(keepAnchor);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listeners read the latest refs.
  useEffect(() => {
    const parts = container.current;
    if (!scroller || !parts) return;
    let frame = 0;
    const onScroll = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        noteAnchor();
      });
    };
    const seen = new IntersectionObserver((entries) => {
      const now = !!entries.at(-1)?.isIntersecting;
      setVisible(now);
      if (now) keepAnchor();
      else hidden.current = true;
    });
    seen.observe(scroller);
    const resized = new ResizeObserver(keepAnchor);
    resized.observe(parts);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      seen.disconnect();
      resized.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scroller]);

  // Prepare the next part the way the reader is going, then the other way,
  // one per turn, so a part is ready before it's reached.
  const first = shown[0]?.index ?? 0;
  const last = shown.at(-1)?.index ?? 0;
  useEffect(() => {
    const ahead = backward.current
      ? [first - 1, last + 1]
      : [last + 1, first - 1];
    const timers = ahead
      .filter(
        (index) => index >= 0 && index < count && !kept.current.has(index),
      )
      .map((index, turn) =>
        setTimeout(() => take(index), READ_AHEAD_MS * (turn + 1)),
      );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [first, last, count, take]);

  const watched = visible ? scroller : null;
  return (
    <div className={styles.parts} ref={container}>
      {first > 0 && (
        <Edge
          key={`before-${first - 1}`}
          index={first - 1}
          scroller={watched}
          screen={screen}
          reach={reach}
        />
      )}
      {shown.map(({ index, prepared }) => (
        <Part
          key={index}
          index={index}
          end={shown.length > 1 && (index === first || index === last)}
          scroller={watched}
          screen={screen}
          drop={drop}
        >
          <Content index={index} prepared={prepared} render={render} />
        </Part>
      ))}
      {last < count - 1 && (
        <Edge
          key={`after-${last + 1}`}
          index={last + 1}
          scroller={watched}
          screen={screen}
          reach={reach}
        />
      )}
    </div>
  );
}
