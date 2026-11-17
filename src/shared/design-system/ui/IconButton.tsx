import type { ComponentProps, ReactElement } from "react";
import { Button, type ButtonProps } from "./Button";

type IconButtonVariant =
  | NonNullable<ButtonProps["variant"]>
  | "destructive-quiet"
  | "solid"
  | "inset"
  | "tint"
  | "chrome"
  | "avatar"
  | "media"
  | "bare";
type IconButtonSize =
  | NonNullable<ButtonProps["size"]>
  | "xs"
  | "toolbar"
  | "large";
type IconButtonShape = "inset" | "control" | "round" | "row-end" | "squircle";

export type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "size" | "variant" | "shape"
> & {
  "aria-label": string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  shape?: IconButtonShape;
} & (
    | { icon: ReactElement; emoji?: never }
    /** A glyph in place of an icon, such as a hand in the chosen skin tone. */
    | { emoji: string; icon?: never }
  );

export function IconButton({
  icon,
  emoji,
  variant = "ghost",
  size = "sm",
  shape = variant === "avatar" ? "round" : "control",
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      variant={
        variant === "destructive-quiet"
          ? "destructive"
          : variant === "solid"
            ? "prominent"
            : variant === "inset"
              ? "subtle"
              : variant === "tint" ||
                  variant === "chrome" ||
                  variant === "avatar" ||
                  variant === "media" ||
                  variant === "bare"
                ? "ghost"
                : variant
      }
      size={
        size === "xs" || size === "toolbar"
          ? "sm"
          : size === "large"
            ? "lg"
            : size
      }
      data-icon-variant={variant}
      data-icon-size={size}
      data-icon-shape={shape}
    >
      {emoji === undefined ? (
        icon
      ) : (
        <span className="buzz-icon-button-emoji" aria-hidden="true">
          {emoji}
        </span>
      )}
    </Button>
  );
}
