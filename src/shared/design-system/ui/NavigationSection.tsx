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

export type NavigationSectionTrailing = {
  accessory?: ReactNode;
  metadata?: ReactNode;
};

/**
 * The label fills the available width and the actions hug the trailing edge.
 *
 * `disclosure` headings collapse their section. Their label is the feature's
 * own disclosure trigger, which keeps the row's inset as its hit area and
 * focus ring. Quiet parts, `revealActions` or any descendant marked
 * `data-navigation-reveal` such as a chevron, appear on hover, keyboard focus,
 * while a menu from the heading is open or one of them has focus, and always
 * on touch. A heading with an accessory keeps the action space so its controls
 * stay in place. A stable `trailing` config keeps the contributed controls
 * mounted as metadata changes. Metadata sets the trailing hover target's
 * footprint. On pointer devices, quiet actions can overlay an adjacent accessory.
 * On touch and when there is no accessory, the slot fits the full action strip.
 * Other headings give that space to the label until actions appear.
 */
export function NavigationSectionHeading({
  actions,
  disclosure = false,
  revealActions = false,
  trailing,
  children,
}: {
  actions?: ReactNode;
  disclosure?: boolean;
  revealActions?: boolean;
  trailing?: NavigationSectionTrailing | undefined;
  children?: ReactNode;
}) {
  const { accessory, metadata } = trailing ?? {};
  const hasMetadata = metadata != null && typeof metadata !== "boolean";
  const reserveSpace =
    hasMetadata || (accessory != null && typeof accessory !== "boolean");
  const swap = hasMetadata && !!actions && revealActions;
  return (
    <div
      className="navigation-section-heading"
      data-disclosure={disclosure || undefined}
    >
      <div className="navigation-section-heading-label">{children}</div>
      {!trailing && actions && (
        <div
          className="navigation-section-heading-actions"
          data-navigation-reveal={revealActions || undefined}
        >
          {actions}
        </div>
      )}
      {trailing && (reserveSpace || actions) && (
        <div
          className="navigation-section-heading-trailing"
          data-reserve-space={reserveSpace || undefined}
          data-has-metadata={hasMetadata || undefined}
        >
          {accessory}
          {(hasMetadata || actions) && (
            <div
              className="navigation-section-heading-actions"
              data-has-metadata={hasMetadata || undefined}
              data-navigation-reveal={
                (!reserveSpace && revealActions) || undefined
              }
            >
              {hasMetadata && (
                <div
                  className="navigation-section-heading-metadata"
                  data-navigation-reveal-rest={swap || undefined}
                >
                  {metadata}
                </div>
              )}
              {actions && (
                <div
                  className="navigation-section-heading-buttons"
                  data-navigation-reveal={
                    (reserveSpace && revealActions) || undefined
                  }
                >
                  {actions}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
