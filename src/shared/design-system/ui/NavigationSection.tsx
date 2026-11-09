import type { ReactNode } from "react";

export function NavigationSection({
  label,
  action,
  children,
}: {
  label?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-buzz-ui=""
      className="navigation-section"
      data-headingless={!label || undefined}
    >
      {(label || action) && (
        <NavigationSectionHeading actions={action}>
          {label && <h2 className="navigation-section-label">{label}</h2>}
        </NavigationSectionHeading>
      )}
      <div className="navigation-section-rows">{children}</div>
    </section>
  );
}

/**
 * One heading row: the label fills the available width and the actions hug the
 * trailing edge, so neither overlays nor reserves space for the other.
 *
 * `disclosure` headings collapse their section. Their label is the feature's
 * own disclosure trigger, which keeps the row's inset as its hit area and
 * focus ring. Quiet parts, `revealActions` or any descendant marked
 * `data-navigation-reveal` such as a chevron, appear on hover, keyboard focus,
 * while a menu from the heading is open or one of them has focus, and always
 * on touch. Hidden
 * actions take no width, so the label uses that space until they appear.
 */
export function NavigationSectionHeading({
  actions,
  disclosure = false,
  revealActions = false,
  children,
}: {
  actions?: ReactNode;
  disclosure?: boolean;
  revealActions?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className="navigation-section-heading"
      data-disclosure={disclosure || undefined}
    >
      <div className="navigation-section-heading-label">{children}</div>
      {actions && (
        <div
          className="navigation-section-heading-actions"
          data-navigation-reveal={revealActions || undefined}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
