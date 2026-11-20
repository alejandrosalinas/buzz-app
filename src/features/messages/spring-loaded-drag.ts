import { useEffect, useRef, type DragEvent } from "react";

/** How long a file drag rests on a target before it opens, as in Finder. */
export const SPRING_LOAD_DELAY_MS = 700;
/** The highlight waits this long, inside the delay, so a drag that only
 * passes over a target does not flash it. */
export const SPRING_LOAD_GRACE_MS = 80;
/** The double blink fills the end of the delay: off, on, off, on in equal
 * phases of 75 ms, as in Finder. Reduced motion skips it. */
export const SPRING_LOAD_BLINK_MS = 300;
const BLINK_PHASES = ["off", "on", "off", "on"] as const;
/** A webview repeats dragover while a drag rests on a target. With none for
 * this long, the drag ended without a leave. A target whose delay is over
 * loses its highlight, and a quiet one treats the next drag event as a new
 * drag. */
export const SPRING_LOAD_STALE_MS = 1000;

/** Set on the hovered target once the grace period is over: "on" while it is
 * highlighted and "off" in the gaps of the blink. globals.css paints it. */
export const SPRING_LOAD_ATTRIBUTE = "data-spring-loaded";

type Hover = {
  owner: object;
  element: HTMLElement;
  /** The node under the drag, which tells a real leave from a child boundary. */
  under: EventTarget | null;
  open: () => void;
  /** Where the drag was last reported over the target. */
  x: number;
  y: number;
  /** When the drag was last reported over the target. */
  seen: number;
  /** Counting down, then waiting for the next dragover, then quiet once opened. */
  phase: "armed" | "due" | "quiet";
  timer: ReturnType<typeof setTimeout> | undefined;
};

// One drag hovers one target, so every target shares this state and its timer.
let hover: Hover | undefined;
// Where the drag was when a target last opened. Opening can shift the layout
// and put another target under a drag that has not moved; that one stays shut.
let sprungAt: { x: number; y: number } | undefined;

const carriesFiles = (event: DragEvent) =>
  !!event.dataTransfer?.types.includes("Files");

function paint(element: HTMLElement, state?: "on" | "off") {
  if (state) element.setAttribute(SPRING_LOAD_ATTRIBUTE, state);
  else element.removeAttribute(SPRING_LOAD_ATTRIBUTE);
}

/** Leaving the target, a drag seen elsewhere, or its unmount ends the hover. */
function cancel() {
  if (hover) {
    clearTimeout(hover.timer);
    paint(hover.element);
    hover = undefined;
  }
  listen();
}

/** A drop or the end of the drag: the next drag starts with no guard. */
function end() {
  sprungAt = undefined;
  cancel();
}

/** Every file drag event in the window, ahead of the targets' own handlers. */
function watch(event: globalThis.DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  if (
    sprungAt &&
    (sprungAt.x !== event.clientX || sprungAt.y !== event.clientY)
  ) {
    sprungAt = undefined;
    listen();
  }
  // A webview may skip the leave. A drag reported anywhere else has left.
  const { target } = event;
  if (hover && !(target instanceof Node && hover.element.contains(target)))
    cancel();
}

/** Listen at the window for as long as there is a hover or a guard to clear.
 * A drop is stopped by the zone that claims it, so listen ahead of it. */
function listen() {
  const wanted = !!hover || !!sprungAt;
  for (const [type, listener] of [
    ["dragenter", watch],
    ["dragover", watch],
    ["drop", end],
    ["dragend", end],
  ] as const) {
    if (wanted) window.addEventListener(type, listener, true);
    else window.removeEventListener(type, listener, true);
  }
}

function spring(current: Hover) {
  clearTimeout(current.timer);
  current.timer = undefined;
  // The hover stays until the drag leaves, so a resting drag opens once.
  current.phase = "quiet";
  paint(current.element);
  sprungAt = { x: current.x, y: current.y };
  if (current.element.isConnected) current.open();
}

/** The delay is over. No drag event says a file drag was cancelled or where
 * it went, so the timer opens nothing: the target's next dragover does, which
 * proves the drag is still on it. Without one the highlight is dropped. */
function due(current: Hover) {
  current.phase = "due";
  paint(current.element, "on");
  current.timer = setTimeout(cancel, SPRING_LOAD_STALE_MS);
}

function arm(current: Hover) {
  const reducedMotion = !!window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  // Each step is a painted state and how long it lasts; then the delay is over.
  const steps: [state: "on" | "off" | undefined, ms: number][] = [
    [undefined, SPRING_LOAD_GRACE_MS],
    [
      "on",
      SPRING_LOAD_DELAY_MS -
        SPRING_LOAD_GRACE_MS -
        (reducedMotion ? 0 : SPRING_LOAD_BLINK_MS),
    ],
    ...(reducedMotion
      ? []
      : BLINK_PHASES.map(
          (state) =>
            [state, SPRING_LOAD_BLINK_MS / BLINK_PHASES.length] as [
              typeof state,
              number,
            ],
        )),
  ];
  // Each step is timed from the start, so a late timer does not add up.
  const start = Date.now();
  let elapsed = 0;
  const step = (index: number) => {
    const [state, ms] = steps[index] ?? [];
    if (ms === undefined) return due(current);
    paint(current.element, state);
    elapsed += ms;
    current.timer = setTimeout(
      () => step(index + 1),
      start + elapsed - Date.now(),
    );
  };
  current.phase = "armed";
  step(0);
}

/**
 * Open a navigation target when a drag carrying files rests on it, so the drag
 * can carry on into the destination's drop zone. That is a file dragged in
 * from the OS, and also an image dragged from a message, which the webview
 * offers as a file. `active` marks the target already open. Spread the result
 * onto the element a click would activate.
 *
 * The target never claims the drag: a drop on it attaches nothing, so the
 * cursor is left to whatever owns the drop there. The window's handler in
 * `useRejectUnclaimedDrops` cancels each dragover, which keeps them coming.
 */
export function useSpringLoaded(open: () => void, active = false) {
  const owner = useRef({}).current;
  useEffect(
    () => () => {
      if (hover?.owner === owner) cancel();
    },
    [owner],
  );
  const over = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    const { clientX: x, clientY: y } = event;
    const seen = Date.now();
    let current =
      hover?.owner === owner && hover.element === event.currentTarget
        ? hover
        : undefined;
    // A quiet hover has no timer to end it. One left behind by a drag that
    // ended without a leave must not keep the next drag shut. The guard is
    // kept, so a drag still resting where the target opened stays shut.
    if (
      current?.phase === "quiet" &&
      seen - current.seen > SPRING_LOAD_STALE_MS
    ) {
      cancel();
      current = undefined;
    }
    if (!current) {
      if (sprungAt) return;
      cancel();
      current = hover = {
        owner,
        element: event.currentTarget,
        under: event.target,
        open,
        x,
        y,
        seen,
        phase: "quiet",
        timer: undefined,
      };
      listen();
      if (!active) arm(current);
    }
    Object.assign(current, { under: event.target, open, x, y, seen });
    if (current.phase === "due") spring(current);
  };
  return {
    onDragEnter: over,
    onDragOver: over,
    onDragLeave(event: DragEvent<HTMLElement>) {
      // Entering a child reports the child first, then this leave of its parent.
      // Leaving the target, the window or a cancelled drag reports only a leave.
      if (hover?.owner === owner && hover.under === event.target) cancel();
    },
  };
}
