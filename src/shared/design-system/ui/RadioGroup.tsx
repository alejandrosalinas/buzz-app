import { Field as BaseField } from "@base-ui/react/field";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { useId, type ComponentProps, type ReactNode } from "react";
import { CheckIcon } from "../icons";

/** Compose inside Field so each Radio has its own labelled Field.Item. */
export function RadioGroup<Value>({
  children,
  size = "md",
  ...props
}: Omit<BaseRadioGroup.Props<Value>, "className"> & { size?: "sm" | "md" }) {
  return (
    <BaseRadioGroup
      {...props}
      data-buzz-ui=""
      data-size={size}
      className="buzz-radio-group"
    >
      {children}
    </BaseRadioGroup>
  );
}

export function Radio({
  label,
  description,
  variant = "default",
  size = "md",
  id,
  ...props
}: Omit<ComponentProps<typeof BaseRadio.Root>, "className" | "children"> & {
  label: ReactNode;
  description?: ReactNode;
  variant?: "default" | "card" | "tile" | "row";
  size?: "sm" | "md";
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = `${controlId}-description`;
  return (
    <BaseField.Item>
      <label
        className="buzz-choice"
        data-variant={variant}
        data-size={size}
        htmlFor={controlId}
      >
        <BaseRadio.Root
          {...props}
          id={controlId}
          aria-labelledby={props["aria-labelledby"] ?? `${controlId}-label`}
          aria-describedby={
            [props["aria-describedby"], description ? descriptionId : undefined]
              .filter(Boolean)
              .join(" ") || undefined
          }
          data-buzz-ui=""
          className="buzz-radio"
          data-variant={variant}
          data-size={size}
        >
          {variant === "row" ? (
            <BaseRadio.Indicator className="buzz-radio-check">
              <CheckIcon aria-hidden="true" />
            </BaseRadio.Indicator>
          ) : (
            variant !== "tile" && (
              <BaseRadio.Indicator className="buzz-radio-indicator" />
            )
          )}
        </BaseRadio.Root>
        <span>
          <span id={`${controlId}-label`} className="buzz-choice-label">
            {label}
          </span>
          {description && (
            <span id={descriptionId} className="buzz-choice-description">
              {description}
            </span>
          )}
        </span>
      </label>
    </BaseField.Item>
  );
}
