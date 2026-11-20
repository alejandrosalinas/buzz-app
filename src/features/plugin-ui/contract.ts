// Shared controls for plugins that cannot import app source. These props are
// the whole contract, kept narrow so the host can restyle and migrate the
// controls underneath without plugins noticing.
import type { ReactElement, ReactNode } from "react";

// `children` is optional so `createElement(type, props, ...children)` type-checks.
export type PluginButtonProps = Readonly<{
  children?: ReactNode;
  /** Default `subtle`. */
  variant?: "prominent" | "subtle" | "ghost" | "destructive" | undefined;
  /** Default `md`. */
  size?: "sm" | "md" | undefined;
  /** Shows a spinner and ignores activation while keeping the button's size. */
  loading?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Default `button`. */
  type?: "button" | "submit" | "reset" | undefined;
  /** The `id` of the form it submits, for a Dialog action outside the body's form. */
  form?: string | undefined;
  onClick?: (() => void) | undefined;
  /** Shown as the host's tooltip. */
  title?: string | undefined;
  "aria-label"?: string | undefined;
}>;

// No `autoFocus`: in a Dialog it focuses the Input before the Dialog records
// the opener, so Escape would lose the way back to it.
export type PluginInputProps = Readonly<{
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  /**
   * Default `text`. No `required`, `email` or `url`: native validation would
   * block the form's submit before the plugin can show its `Field` error.
   */
  type?: "text" | "password" | undefined;
  placeholder?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  maxLength?: number | undefined;
  /** Needed only outside a `Field`, which labels its control. */
  "aria-label"?: string | undefined;
}>;

/** Labels the one Input it contains and announces `error`. A Switch labels itself. */
export type PluginFieldProps = Readonly<{
  label: ReactNode;
  /** Hidden while `error` is shown. */
  description?: ReactNode;
  /** Marks the field invalid. */
  error?: ReactNode;
  /** Adds an "Optional" note to the label. */
  optional?: boolean | undefined;
  children?: ReactNode;
}>;

/** Applies immediately; do not put it behind a Save action. */
export type PluginSwitchProps = Readonly<
  {
    checked?: boolean | undefined;
    defaultChecked?: boolean | undefined;
    onCheckedChange?: ((checked: boolean) => void) | undefined;
    disabled?: boolean | undefined;
    name?: string | undefined;
    id?: string | undefined;
  } & (
    | { label: string; "aria-label"?: undefined }
    | { label?: undefined; "aria-label": string }
  )
>;

/**
 * A modal; the host owns its portal, focus trap, Escape and focus return. It
 * opens on the first control in its body, else its first action.
 */
export type PluginDialogProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Introductory copy under the title, not a body paragraph. */
  description?: ReactNode;
  children?: ReactNode;
  /** Footer buttons: Cancel first, then the completing action. */
  actions?: ReactNode;
  /** Default `default`. */
  size?: "compact" | "default" | undefined;
  /** Default `true`. Set `false` when it holds a draft that a stray click would lose. */
  dismissOnOutsideClick?: boolean | undefined;
  /** Blocks every way of dismissing it, for example while saving. */
  preventClose?: boolean | undefined;
}>;

export type PluginUi = Readonly<{
  Button: (props: PluginButtonProps) => ReactElement;
  Input: (props: PluginInputProps) => ReactElement;
  Field: (props: PluginFieldProps) => ReactElement;
  Switch: (props: PluginSwitchProps) => ReactElement;
  Dialog: (props: PluginDialogProps) => ReactElement;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("ui")` so older hosts return `undefined`. */
    ui?: PluginUi;
  }
}
