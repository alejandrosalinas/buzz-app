import type { ReactNode } from "react";

/**
 * A short, read-only value in running text, such as the model a setting
 * chose. `label` names the value for assistive technology when the icon
 * carries meaning the text doesn't repeat.
 */
export function ValueChip({
  icon,
  label,
  title,
  children,
}: {
  /** A decorative 14px mark shown before the value. */
  icon?: ReactNode;
  label?: string;
  /** The full value, shown on hover when it is cut short. */
  title?: string;
  children: ReactNode;
}) {
  return (
    <span data-buzz-ui="" className="buzz-value-chip">
      {icon && (
        <span className="buzz-value-chip-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {label && <span className="sr-only">{label}: </span>}
      <span className="buzz-value-chip-text" title={title}>
        {children}
      </span>
    </span>
  );
}
