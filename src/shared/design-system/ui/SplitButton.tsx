import { CaretDownIcon } from "../icons/index";
import type { ReactNode } from "react";
import { Button, type ButtonProps } from "./Button";
import { MenuPopup, MenuRoot, MenuTrigger } from "./Menu";

export type SplitButtonProps = Pick<
  ButtonProps,
  "onClick" | "onBlur" | "aria-label" | "aria-disabled"
> & {
  /** The main action's label, which names the menu's current choice. */
  children: ReactNode;
  /** Names the menu button, such as "Choose agent type". */
  menuLabel: string;
  /** The menu's items: option choices or related actions. */
  menu: ReactNode;
  /** `ghost` suits icon-only actions in dense toolbars and section headings. */
  variant?: "subtle" | "outline" | "prominent" | "ghost";
  size?: "xs" | "sm" | "md";
  menuDisabled?: boolean | undefined;
  loading?: boolean | undefined;
  disabled?: boolean | undefined;
  /** An icon-only action; `aria-label` names it. */
  icon?: boolean;
};

/** An action joined to a separately named menu of options or related actions. */
export function SplitButton({
  children,
  menuLabel,
  menu,
  menuDisabled,
  variant = "subtle",
  size = "md",
  loading = false,
  disabled = false,
  icon = false,
  ...props
}: SplitButtonProps) {
  return (
    <div data-buzz-ui="" className="buzz-split-button" data-variant={variant}>
      {icon ? (
        <Button
          {...props}
          aria-label={props["aria-label"] ?? ""}
          shape="icon"
          variant={variant}
          size={size}
          loading={loading}
          disabled={disabled}
        >
          {children}
        </Button>
      ) : (
        <Button
          {...props}
          variant={variant}
          size={size}
          loading={loading}
          disabled={disabled}
        >
          {children}
        </Button>
      )}
      <MenuRoot>
        <MenuTrigger
          disabled={disabled || loading || menuDisabled}
          render={
            <Button
              variant={variant}
              size={size}
              shape="icon"
              aria-label={menuLabel}
              // A choice made while the action runs would not be the one it used.
              disabled={disabled || loading || menuDisabled}
            >
              <CaretDownIcon aria-hidden="true" />
            </Button>
          }
        />
        <MenuPopup align="end">{menu}</MenuPopup>
      </MenuRoot>
    </div>
  );
}
