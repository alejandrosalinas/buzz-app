import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { CheckIcon, CaretRightIcon } from "../icons/index";
import { useFinalFocusUnlessMoved } from "./finalFocus";
import { hoverOpenTiming, type HoverOpen } from "./hoverIntent";
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

// null is an ordinary menu; a boolean is a context menu's visible lifetime.
const ContextMenuPresence = createContext<boolean | null>(null);

export type MenuHandle<Payload = unknown> = BaseMenu.Handle<Payload>;
/** Connects one MenuRoot to detached MenuTriggers, such as a list's rows. */
export const createMenuHandle = BaseMenu.createHandle;

export function MenuRoot<Payload>(props: BaseMenu.Root.Props<Payload>) {
  return (
    <ContextMenuPresence value={null}>
      <BaseMenu.Root {...props} />
    </ContextMenuPresence>
  );
}

type MenuTriggerProps<Payload> = Omit<
  BaseMenu.Trigger.Props<Payload>,
  "openOnHover" | "delay" | "closeDelay"
> & {
  /** Opening on hover takes its timing from a DESIGN.md "Hover timing" bucket. */
  openOnHover?: HoverOpen | false | undefined;
};

export function MenuTrigger<Payload>({
  openOnHover,
  ...props
}: MenuTriggerProps<Payload>) {
  return (
    <BaseMenu.Trigger
      {...props}
      {...(openOnHover && {
        openOnHover: true,
        ...hoverOpenTiming[openOnHover],
      })}
    />
  );
}

export function ContextMenuRoot({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: ComponentProps<typeof BaseContextMenu.Root>) {
  const [present, setPresent] = useState(open ?? defaultOpen ?? false);
  // Controlled opens can come from the keyboard without a trigger event.
  if (open && !present) setPresent(true);
  return (
    <ContextMenuPresence value={present}>
      <BaseContextMenu.Root
        {...props}
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={(next, details) => {
          onOpenChange?.(next, details);
          if (next && open === undefined && !details.isCanceled)
            setPresent(true);
        }}
        onOpenChangeComplete={(next) => {
          if (!next) setPresent(false);
          onOpenChangeComplete?.(next);
        }}
      />
    </ContextMenuPresence>
  );
}

export function ContextMenuTrigger(
  props: ComponentProps<typeof BaseContextMenu.Trigger>,
) {
  const present = useContext(ContextMenuPresence);
  return (
    <BaseContextMenu.Trigger
      {...props}
      data-context-menu-present={present || undefined}
    />
  );
}
export const MenuGroup = BaseMenu.Group;
export const MenuRadioGroup = BaseMenu.RadioGroup;

export type MenuPosition = Pick<
  ComponentProps<typeof BaseMenu.Positioner>,
  | "align"
  | "alignOffset"
  | "anchor"
  | "collisionPadding"
  | "collisionAvoidance"
  | "side"
  | "sideOffset"
  | "sticky"
>;

type PopupProps = Omit<ComponentProps<typeof BaseMenu.Popup>, "className"> &
  MenuPosition & {
    children: ReactNode;
    /** Compact is for short action lists; larger choices retain panel corners. */
    size?: "compact" | "default" | "wide";
  };

function PositionedPopup({
  align = "start",
  alignOffset,
  anchor,
  children,
  collisionAvoidance,
  collisionPadding = 8,
  size = "default",
  side = "bottom",
  sideOffset = 4,
  sticky,
  finalFocus,
  ref,
  ...props
}: PopupProps) {
  const focus = useFinalFocusUnlessMoved(finalFocus, ref);
  const contextMenu = useContext(ContextMenuPresence) !== null;
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        className="buzz-menu-positioner"
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding}
        side={side}
        sideOffset={sideOffset}
        sticky={sticky}
      >
        <BaseMenu.Popup
          {...props}
          ref={focus.ref}
          finalFocus={focus.finalFocus}
          data-buzz-ui=""
          data-size={size}
          data-context-menu={contextMenu || undefined}
          className="buzz-menu-popup text-body-sm"
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

/** An anchored action menu with collision handling and shared floating-surface styling. */
export function MenuPopup(props: PopupProps) {
  return <PositionedPopup {...props} />;
}

export function MenuSubmenu(
  props: ComponentProps<typeof BaseMenu.SubmenuRoot>,
) {
  return (
    <ContextMenuPresence value={null}>
      <BaseMenu.SubmenuRoot {...props} />
    </ContextMenuPresence>
  );
}

export function MenuSubmenuPopup(props: PopupProps) {
  return <PositionedPopup side="right" align="start" {...props} />;
}

type ItemProps = Omit<ComponentProps<typeof BaseMenu.Item>, "className"> & {
  tone?: "default" | "danger";
};

export function MenuItem({ tone = "default", ...props }: ItemProps) {
  return (
    <BaseMenu.Item {...props} data-tone={tone} className="buzz-menu-item" />
  );
}

type LinkItemProps = Omit<
  ComponentProps<typeof BaseMenu.LinkItem>,
  "className"
>;

export function MenuLinkItem(props: LinkItemProps) {
  return <BaseMenu.LinkItem {...props} className="buzz-menu-item" />;
}

type SubmenuTriggerProps = Omit<
  ComponentProps<typeof BaseMenu.SubmenuTrigger>,
  "className"
>;

export function MenuSubmenuTrigger({
  children,
  ...props
}: SubmenuTriggerProps) {
  return (
    <BaseMenu.SubmenuTrigger delay={0} {...props} className="buzz-menu-item">
      {children}
      <CaretRightIcon
        className="buzz-menu-submenu-arrow"
        size={16}
        aria-hidden="true"
      />
    </BaseMenu.SubmenuTrigger>
  );
}

type CheckboxItemProps = Omit<
  ComponentProps<typeof BaseMenu.CheckboxItem>,
  "className"
>;

export function MenuCheckboxItem({ children, ...props }: CheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem {...props} className="buzz-menu-item">
      <span className="buzz-menu-choice-label">{children}</span>
      <BaseMenu.CheckboxItemIndicator
        className="buzz-menu-item-indicator"
        keepMounted
      >
        <CheckIcon size={16} aria-hidden="true" />
      </BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>
  );
}

type RadioItemProps = Omit<
  ComponentProps<typeof BaseMenu.RadioItem>,
  "className"
> & { selection?: "check" | "highlight" };

export function MenuRadioItem({
  children,
  selection = "check",
  ...props
}: RadioItemProps) {
  return (
    <BaseMenu.RadioItem
      {...props}
      className="buzz-menu-item"
      data-selection={selection}
    >
      <span className="buzz-menu-choice-label">{children}</span>
      {selection === "check" && (
        <BaseMenu.RadioItemIndicator
          className="buzz-menu-item-indicator"
          keepMounted
        >
          <CheckIcon size={16} aria-hidden="true" />
        </BaseMenu.RadioItemIndicator>
      )}
    </BaseMenu.RadioItem>
  );
}

export function MenuGroupLabel({
  children,
  emphasis = "default",
}: {
  children: ReactNode;
  emphasis?: "default" | "quiet";
}) {
  return (
    <BaseMenu.GroupLabel
      className="buzz-menu-group-label"
      data-emphasis={emphasis}
    >
      {children}
    </BaseMenu.GroupLabel>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="buzz-menu-separator" />;
}

export function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <span className="buzz-menu-icon" aria-hidden="true">
      {children}
    </span>
  );
}

export function MenuTrailing({ children }: { children: ReactNode }) {
  return <span className="buzz-menu-trailing">{children}</span>;
}

/** Supporting context and status text, outside the menu's keyboard item list. */
export function MenuNote(props: Omit<ComponentProps<"p">, "className">) {
  return <p {...props} className="buzz-menu-note text-body-sm" />;
}
