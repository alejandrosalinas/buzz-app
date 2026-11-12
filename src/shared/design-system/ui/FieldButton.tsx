import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps, ReactNode } from "react";
import { CaretDownIcon } from "../icons";

/** A picker trigger with the same perimeter and inset as a text field. */
export function FieldButton({
  children,
  type = "button",
  dropdown = true,
  appearance = "field",
  prefix,
  ...props
}: Omit<ComponentProps<typeof BaseButton>, "className"> & {
  /** Show the dropdown chevron; omit it for triggers that open a system picker. */
  dropdown?: boolean;
  appearance?: "field" | "masked";
  /** Fixed text before a masked value, kept at ordinary text size. */
  prefix?: string;
  children?: ReactNode;
}) {
  return (
    <BaseButton
      {...props}
      type={type}
      data-buzz-ui=""
      data-appearance={appearance === "field" ? undefined : appearance}
      className="buzz-input buzz-select-trigger"
    >
      <span className="buzz-select-value">
        {prefix && <span className="buzz-select-prefix">{prefix}</span>}
        {children}
      </span>
      {dropdown && (
        <CaretDownIcon
          size={16}
          className="buzz-dropdown-chevron"
          aria-hidden="true"
        />
      )}
    </BaseButton>
  );
}
