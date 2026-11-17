import { type ReactNode, useState } from "react";

/** A quiet boundary for related settings; children own controls and state. */
export function SettingsGroup({
  children,
  layout = "rows",
}: {
  children: ReactNode;
  /** `cards` gives each child its own bordered card instead of dividers. */
  layout?: "rows" | "form" | "cards";
}) {
  return (
    <div data-buzz-ui="" className="buzz-settings-group" data-layout={layout}>
      {children}
    </div>
  );
}

/**
 * Rows that a choice in the row above reveals in place, inside a `rows`
 * group. They line up with that row's title, after its icon. They mount
 * when first opened, so their work waits for the choice that shows them;
 * closed again, they leave the tab order and the accessibility tree, and
 * keep their state.
 */
export function SettingsGroupExpand({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return (
    <div
      data-buzz-ui=""
      className="buzz-settings-group-expand"
      data-open={open || undefined}
      inert={!open}
    >
      <div className="buzz-settings-group-expand-rows">
        {opened && children}
      </div>
    </div>
  );
}
