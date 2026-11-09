import { PreferenceRow } from "./PreferenceRow";
import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { Field } from "./Field";
import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, CaretDownIcon } from "../icons/index";
import { Button } from "./Button";

export type SelectGroup = {
  label: string;
  /** Separate this group from the preceding choices. */
  separator?: boolean;
  options: readonly {
    value: string;
    label: string;
    description?: ReactNode;
    /** Decorative 20px icon, avatar, or custom accessory shown before the option's text. */
    leading?: ReactNode;
    disabled?: boolean;
  }[];
};

/** A compact, labelled single-choice control with accessible option groups. */
export function Select({
  label,
  value,
  groups,
  onValueChange,
  variant: requestedVariant = "inline",
  disabled = false,
  description,
  error,
  name,
  required,
  readOnly,
  placeholder,
  valueLabel,
  valueTitle,
  valueSuffix,
  leading,
  align = "start",
  size,
  appearance = "outlined",
}: {
  label: string;
  description?: ReactNode;
  error?: ReactNode;
  name?: string;
  required?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  /** Compact display text; option labels retain their full meaning. */
  valueLabel?: string | undefined;
  valueTitle?: string;
  /** Compact metadata stays visible while the selected value truncates. */
  valueSuffix?: string | undefined;
  /** Decorative 20px icon, avatar, or custom accessory shown before the selected value. */
  leading?: ReactNode;
  /** Anchor the popup to the corresponding trigger edge. */
  align?: "start" | "center" | "end";
  variant?: "inline" | "field" | "compact" | "preference";
  /** Match adjacent controls without changing the selection treatment. */
  size?: "xs" | "sm" | "md";
  appearance?: "outlined" | "glass-ghost" | "inverted" | "link";
  disabled?: boolean;
  value: string;
  groups: readonly SelectGroup[];
  onValueChange: (value: string) => void;
}) {
  const variant =
    requestedVariant === "preference" ? "compact" : requestedVariant;
  const optionDescriptionId = useId();
  const items = groups.flatMap((group) => group.options);
  const selectedValue =
    value === "" && !items.some((option) => option.value === "") ? null : value;
  const choices = JSON.stringify(items.map((item) => item.value));
  const committedChoices = useRef(choices);
  useLayoutEffect(() => {
    committedChoices.current = choices;
  }, [choices]);
  const control = (
    <div
      data-buzz-ui=""
      className="buzz-select text-body"
      data-variant={variant}
      data-appearance={appearance}
    >
      <BaseSelect.Root
        disabled={disabled}
        name={name}
        required={required}
        readOnly={readOnly}
        value={selectedValue}
        items={items}
        onValueChange={(next, details) => {
          // Base UI's item-removal callback can still see the old selection
          // while registering a new list. Keep a valid controlled replacement.
          // Closed-trigger typeahead also uses "none", after this commit.
          if (
            details.reason === "none" &&
            committedChoices.current !== choices &&
            items.some((item) => item.value === value)
          ) {
            details.cancel();
            return;
          }
          if (next !== null) onValueChange(next);
        }}
      >
        {variant !== "field" && (
          <BaseSelect.Label
            className={variant === "compact" ? "sr-only" : "text-primary"}
          >
            {label}
          </BaseSelect.Label>
        )}
        {variant === "field" ? (
          <BaseSelect.Trigger
            data-buzz-ui=""
            className="buzz-input buzz-select-trigger"
          >
            <span className="buzz-select-value-content">
              {leading && (
                <span className="buzz-select-leading" aria-hidden="true">
                  {leading}
                </span>
              )}
              <BaseSelect.Value
                className="buzz-select-value"
                placeholder={selectedValue === null ? placeholder : undefined}
                data-placeholder={selectedValue === null ? "" : undefined}
              >
                {valueLabel}
              </BaseSelect.Value>
            </span>
            <BaseSelect.Icon>
              <CaretDownIcon
                size={16}
                className="buzz-dropdown-chevron"
                aria-hidden="true"
              />
            </BaseSelect.Icon>
          </BaseSelect.Trigger>
        ) : (
          <BaseSelect.Trigger
            // Base UI adds aria-labelledby after the commit that inserts the
            // trigger, so it can be unnamed until a later task. Name it now.
            aria-label={label}
            render={(props) => (
              <Button
                {...props}
                shape={
                  requestedVariant === "preference" ? "control" : "capsule"
                }
                variant={
                  variant === "compact"
                    ? appearance === "outlined"
                      ? "outline"
                      : appearance
                    : "ghost"
                }
                size={size ?? (variant === "compact" ? "sm" : "md")}
              >
                <span className="buzz-select-value-content">
                  {leading && (
                    <span className="buzz-select-leading" aria-hidden="true">
                      {leading}
                    </span>
                  )}
                  <span className="buzz-select-value-text">
                    <BaseSelect.Value
                      className={
                        variant === "compact" ? "buzz-select-value" : undefined
                      }
                      title={
                        variant === "compact"
                          ? (valueTitle ??
                            items.find((item) => item.value === value)?.label)
                          : undefined
                      }
                      placeholder={
                        selectedValue === null ? placeholder : undefined
                      }
                      data-placeholder={selectedValue === null ? "" : undefined}
                    >
                      {valueLabel}
                    </BaseSelect.Value>
                    {variant === "compact" && valueSuffix && (
                      <span className="buzz-select-value-suffix">
                        {valueSuffix}
                      </span>
                    )}
                  </span>
                </span>
                <BaseSelect.Icon>
                  <CaretDownIcon
                    size={14}
                    className="buzz-dropdown-chevron"
                    aria-hidden="true"
                  />
                </BaseSelect.Icon>
              </Button>
            )}
          />
        )}
        <BaseSelect.Portal>
          <BaseSelect.Positioner
            className="buzz-select-positioner"
            sideOffset={4}
            align={align}
            alignItemWithTrigger={false}
          >
            <BaseSelect.Popup
              data-buzz-ui=""
              className="buzz-select-popup text-body"
              data-variant={variant}
            >
              <BaseSelect.List>
                {groups.map((group, groupIndex) => (
                  <Fragment key={group.options[0]?.value ?? group.label}>
                    {groupIndex > 0 && group.separator && (
                      <BaseSelect.Separator className="buzz-select-separator" />
                    )}
                    <BaseSelect.Group>
                      {group.label && (
                        <BaseSelect.GroupLabel className="buzz-select-group-label text-secondary">
                          {group.label}
                        </BaseSelect.GroupLabel>
                      )}
                      {group.options.map((option, optionIndex) => {
                        const descriptionId = `${optionDescriptionId}-${groupIndex}-${optionIndex}`;
                        return (
                          <BaseSelect.Item
                            key={option.value}
                            value={option.value}
                            disabled={option.disabled}
                            aria-label={option.label}
                            aria-describedby={
                              option.description ? descriptionId : undefined
                            }
                            className="buzz-select-option"
                          >
                            <span className="buzz-select-option-main">
                              {option.leading && (
                                <span
                                  className="buzz-select-leading"
                                  aria-hidden="true"
                                >
                                  {option.leading}
                                </span>
                              )}
                              <span className="buzz-select-option-content">
                                <BaseSelect.ItemText>
                                  {option.label}
                                </BaseSelect.ItemText>
                                {option.description && (
                                  <span
                                    id={descriptionId}
                                    className="buzz-select-option-description text-body-sm text-subtle"
                                  >
                                    {option.description}
                                  </span>
                                )}
                              </span>
                            </span>
                            <BaseSelect.ItemIndicator
                              className="buzz-select-indicator"
                              keepMounted={variant === "compact"}
                            >
                              <CheckIcon size={14} aria-hidden="true" />
                            </BaseSelect.ItemIndicator>
                          </BaseSelect.Item>
                        );
                      })}
                    </BaseSelect.Group>
                  </Fragment>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  );
  if (requestedVariant === "preference")
    return (
      <>
        {/* The row names the setting; the trigger carries unavailability. */}
        <PreferenceRow
          title={label}
          subtitle={description}
          trailing={control}
        />
        {error && (
          <p role="alert" className="buzz-field-error">
            {error}
          </p>
        )}
      </>
    );
  return variant === "field" ? (
    <Field
      nativeLabel={false}
      label={label}
      description={description}
      error={error}
      disabled={disabled}
    >
      {control}
    </Field>
  ) : (
    control
  );
}
