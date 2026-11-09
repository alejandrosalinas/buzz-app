/**
 * Hover opens only once the pointer rests on a trigger, so a pointer crossing
 * it on the way elsewhere opens nothing. Any movement restarts the wait.
 * DESIGN.md "Hover timing" assigns each surface to one of these buckets.
 */
/** Hints that add information or name an unfamiliar icon. */
export const HELPFUL_HINT_REST_MS = 250;
/** Hints naming an icon whose meaning is already obvious. */
export const FAMILIAR_HINT_REST_MS = 500;
/** Labels for the app dock's icon-only tiles: the label is their only visible
 * name, so it appears as soon as the pointer reaches a tile. */
export const DOCK_LABEL_REST_MS = 0;
/** Rich previews cover more of the page, so they wait longer than a hint. */
export const PREVIEW_REST_MS = 300;
/** Controls that expand in place under the pointer, such as video volume. */
export const HOVER_CONTROL_REST_MS = 50;

/** A bucket for a popover or menu that opens on hover. */
export type HoverOpen = "preview" | "control";

/** Rest before opening and grace before closing, per hover-opening bucket. */
export const hoverOpenTiming = {
  preview: { delay: PREVIEW_REST_MS, closeDelay: 75 },
  control: { delay: HOVER_CONTROL_REST_MS, closeDelay: 50 },
} satisfies Record<HoverOpen, { delay: number; closeDelay: number }>;
