import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";

export type InputProps = Omit<ComponentProps<typeof BaseInput>, "className"> & {
  controlSize?: "sm" | "md";
  /** Larger text for a prominent value such as a composed address. */
  textSize?: "default" | "large";
  /** `title` sets the value as a page title with no field around it. */
  appearance?: "field" | "title" | "heading";
};
export function Input({
  controlSize = "md",
  textSize = "default",
  appearance = "field",
  ...props
}: InputProps) {
  return (
    <BaseInput
      {...props}
      data-buzz-ui=""
      data-size={controlSize}
      data-text-size={textSize === "large" ? "large" : undefined}
      data-appearance={appearance === "field" ? undefined : appearance}
      className="buzz-input"
    />
  );
}
