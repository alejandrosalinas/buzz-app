import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps } from "react";
import { useFinalFocusUnlessMoved } from "./finalFocus";
import { hoverOpenTiming, type HoverOpen } from "./hoverIntent";

export const PopoverRoot = BasePopover.Root;

type PopoverTriggerProps<Payload> = Omit<
  BasePopover.Trigger.Props<Payload>,
  "openOnHover" | "delay" | "closeDelay"
> & {
  /** Opening on hover takes its timing from a DESIGN.md "Hover timing" bucket. */
  openOnHover?: HoverOpen | false | undefined;
};

export function PopoverTrigger<Payload>({
  openOnHover,
  ...props
}: PopoverTriggerProps<Payload>) {
  return (
    <BasePopover.Trigger
      {...props}
      {...(openOnHover && {
        openOnHover: true,
        ...hoverOpenTiming[openOnHover],
      })}
    />
  );
}
export const PopoverClose = BasePopover.Close;

// The feature retains its content and state; this frame owns material, motion,
// viewport constraints and stacking. Base UI owns focus, dismissal and placement.
type PopoverPopupProps = Omit<
  ComponentProps<typeof BasePopover.Popup>,
  "className"
> &
  Pick<
    ComponentProps<typeof BasePopover.Positioner>,
    | "side"
    | "align"
    | "sideOffset"
    | "alignOffset"
    | "collisionBoundary"
    | "collisionPadding"
    | "collisionAvoidance"
    | "anchor"
    | "sticky"
  > & {
    /** Preserve an explicitly themed surface across the portal. */
    colorMode?: "light" | "dark" | undefined;
    /** Compact account/action surfaces use 8px corners as well as a narrower width. */
    size?: "compact" | "default" | "wide";
    /** Embedded pickers own their internal spacing. */
    padding?: "content" | "list" | "none";
  };

export function PopoverPopup({
  side = "bottom",
  align = "start",
  sideOffset = 8,
  alignOffset,
  collisionBoundary,
  collisionPadding = 8,
  collisionAvoidance,
  anchor,
  sticky,
  size = "default",
  padding = "content",
  colorMode,
  finalFocus,
  ref,
  ...props
}: PopoverPopupProps) {
  const focus = useFinalFocusUnlessMoved(finalFocus, ref);
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        className="buzz-popover-positioner"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance}
        anchor={anchor}
        sticky={sticky}
      >
        <BasePopover.Popup
          {...props}
          ref={focus.ref}
          finalFocus={focus.finalFocus}
          data-buzz-ui=""
          data-size={size}
          data-padding={padding}
          data-color-mode={colorMode}
          className={`buzz-popover-popup text-body ${colorMode ?? ""}`}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

export function PopoverTitle(
  props: Omit<ComponentProps<typeof BasePopover.Title>, "className">,
) {
  return (
    <BasePopover.Title {...props} className="buzz-popover-title text-label" />
  );
}

export function PopoverDescription(
  props: Omit<ComponentProps<typeof BasePopover.Description>, "className">,
) {
  return (
    <BasePopover.Description
      {...props}
      className="buzz-popover-description text-body-sm"
    />
  );
}
