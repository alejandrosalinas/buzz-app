import { Button as BaseButton } from "@base-ui/react/button";
import { CircleNotchIcon } from "../icons/index";
import type { ComponentProps, ReactNode } from "react";
import { Tooltip, type HintTiming } from "./Tooltip";

type ButtonVariant =
  | "prominent"
  | "subtle"
  | "glass"
  | "subtle-muted"
  | "ghost"
  | "destructive"
  | "outline"
  | "attention"
  | "glass"
  | "glass-ghost"
  | "glass-clear"
  | "inverted"
  | "link"
  | "plain"
  | "primary"
  | "quiet";
type ButtonSize =
  | "caption"
  | "inline"
  | "row"
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "compact"
  | "default";

export type ButtonProps = Omit<
  ComponentProps<typeof BaseButton>,
  "className"
> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** How long the `title` hint waits; see DESIGN.md "Hover timing". */
  hint?: HintTiming;
} & (
    | { shape?: "capsule" | "control" }
    // Icon geometry has no visible label, so it requires an accessible name.
    | { shape: "icon"; "aria-label": string }
  );

/** Base UI owns activation. Legacy variant/size names remain during migration. */
export function Button({
  children,
  variant = "subtle",
  size = "md",
  shape = "capsule",
  type = "button",
  loading = false,
  disabled,
  onClick,
  title,
  hint,
  ...props
}: ButtonProps) {
  const control = (
    <BaseButton
      {...props}
      {...(shape === "icon"
        ? {
            "data-icon-variant": variant,
            "data-icon-shape": "control",
            "data-icon-size": size,
          }
        : {})}
      type={type}
      disabled={disabled || loading}
      focusableWhenDisabled={
        props.focusableWhenDisabled ?? (loading && !disabled)
      }
      aria-busy={loading || props["aria-busy"]}
      onClick={(event) => {
        if (loading || disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      data-buzz-ui=""
      className="buzz-button"
      data-variant={
        variant === "primary"
          ? "prominent"
          : variant === "quiet" || variant === "subtle-muted"
            ? "subtle"
            : variant
      }
      data-muted={variant === "subtle-muted" || undefined}
      data-size={size === "compact" ? "sm" : size === "default" ? "md" : size}
      data-button-shape={shape}
      data-loading={loading || undefined}
    >
      {variant === "attention" && (
        <svg
          className="buzz-button-attention"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="0.5" y="0.5" />
        </svg>
      )}
      <span className="buzz-button-label">{children}</span>
      {loading && (
        <CircleNotchIcon
          className="buzz-button-spinner"
          size={18}
          aria-hidden="true"
        />
      )}
    </BaseButton>
  );
  // Keep the native title API at call sites, but share the hint's appearance
  // and dismissal behavior. Content titles on non-controls remain native.
  return title ? (
    <Tooltip content={title} hint={hint} disableHoverablePopup>
      {control}
    </Tooltip>
  ) : (
    control
  );
}
