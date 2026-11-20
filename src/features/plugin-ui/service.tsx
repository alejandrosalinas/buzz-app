// Hands plugins the host's own controls. Each wrapper forwards only the props in
// `contract.ts`, so plugins (usually plain JS) cannot come to depend on internal
// variants or on Base UI's event details.
import { type RefObject, useRef } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Switch } from "../../shared/design-system/ui/Switch";
import type {
  PluginButtonProps,
  PluginDialogProps,
  PluginFieldProps,
  PluginInputProps,
  PluginSwitchProps,
  PluginUi,
} from "./contract";

const tabbable =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Shown on screen. Without `checkVisibility` (before Safari 17.4), check CSS and closed disclosures. */
function rendered(element: HTMLElement) {
  if (element.checkVisibility)
    return element.checkVisibility({ visibilityProperty: true });
  if (getComputedStyle(element).visibility !== "visible") return false;
  for (let node = element; node.parentElement; node = node.parentElement) {
    const parent = node.parentElement;
    if (getComputedStyle(node).display === "none") return false;
    // A closed <details> shows only its summary.
    if (
      parent instanceof HTMLDetailsElement &&
      !parent.open &&
      node !== parent.querySelector(":scope > summary")
    )
      return false;
  }
  return true;
}

/** Not disabled by a fieldset, not inert, and shown on screen. */
function focusable(element: HTMLElement) {
  return (
    !element.matches(":disabled") &&
    !element.closest("[inert]") &&
    rendered(element)
  );
}

/**
 * Plugins cannot pass a focus ref, so start where a form dialog should: on the
 * first body control, else the first action. Header Close gets focus only when
 * there is neither. The title anchor finds this dialog's popup without exposing its ref.
 */
function initialFocus(anchor: RefObject<HTMLSpanElement | null>) {
  return () => {
    const popup = anchor.current?.closest('[role="dialog"]');
    const first = (region: string) =>
      [
        ...(popup
          ?.querySelector(region)
          ?.querySelectorAll<HTMLElement>(tabbable) ?? []),
      ].find(focusable);
    return first(".buzz-dialog-body") ?? first(".buzz-dialog-actions") ?? true;
  };
}

// Plain-JS plugins can pass anything; a value of the wrong type is treated as
// absent, so every control falls back to the same default.
const bool = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const fn = <T,>(value: T) => (typeof value === "function" ? value : undefined);

/** An unsupported value falls back to the default instead of an internal style. */
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((option) => option === value);
}

/**
 * Provided as a plain frozen object, not a Cordis `Service`: a service proxies
 * each function it returns anew, and a component type that changes identity on
 * every read would remount on every render. Keys are the public names.
 */
export const pluginUi: PluginUi = Object.freeze({
  Button: ({ children, ...props }: PluginButtonProps) => {
    const onClick = fn(props.onClick);
    return (
      <Button
        variant={
          oneOf(props.variant, [
            "prominent",
            "subtle",
            "ghost",
            "destructive",
          ]) ?? "subtle"
        }
        size={oneOf(props.size, ["sm", "md"]) ?? "md"}
        loading={props.loading === true}
        disabled={props.disabled === true}
        type={oneOf(props.type, ["button", "submit", "reset"]) ?? "button"}
        form={str(props.form)}
        onClick={onClick && (() => onClick())}
        title={str(props.title)}
        aria-label={str(props["aria-label"])}
      >
        {children}
      </Button>
    );
  },
  Input: (props: PluginInputProps) => {
    const onValueChange = fn(props.onValueChange);
    return (
      <Input
        value={str(props.value)}
        defaultValue={str(props.defaultValue)}
        onValueChange={onValueChange && ((value) => onValueChange(value))}
        type={oneOf(props.type, ["text", "password"])}
        placeholder={str(props.placeholder)}
        name={str(props.name)}
        id={str(props.id)}
        disabled={props.disabled === true}
        readOnly={props.readOnly === true}
        maxLength={
          Number.isInteger(props.maxLength) ? props.maxLength : undefined
        }
        aria-label={str(props["aria-label"])}
      />
    );
  },
  Field: (props: PluginFieldProps) => (
    <Field
      label={props.label}
      description={props.description}
      error={props.error}
      optional={props.optional === true}
    >
      {props.children}
    </Field>
  ),
  Switch: (props: PluginSwitchProps) => {
    const onCheckedChange = fn(props.onCheckedChange);
    const shared = {
      checked: bool(props.checked),
      defaultChecked: bool(props.defaultChecked),
      onCheckedChange:
        onCheckedChange && ((checked: boolean) => onCheckedChange(checked)),
      disabled: props.disabled === true,
      name: str(props.name),
      id: str(props.id),
    };
    const label = str(props.label);
    return label === undefined ? (
      <Switch {...shared} aria-label={str(props["aria-label"]) ?? ""} />
    ) : (
      <Switch {...shared} label={label} />
    );
  },
  Dialog: function PluginDialog(props: PluginDialogProps) {
    const anchor = useRef<HTMLSpanElement>(null);
    return (
      <Dialog
        open={props.open === true}
        onOpenChange={(open) => fn(props.onOpenChange)?.(open)}
        title={<span ref={anchor}>{props.title}</span>}
        initialFocus={initialFocus(anchor)}
        description={props.description}
        actions={props.actions}
        size={oneOf(props.size, ["compact", "default"]) ?? "default"}
        dismissOnOutsideClick={props.dismissOnOutsideClick !== false}
        preventClose={props.preventClose === true}
      >
        {props.children}
      </Dialog>
    );
  },
});
