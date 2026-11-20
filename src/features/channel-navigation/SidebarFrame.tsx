import { SidebarNavigation } from "../../shared/design-system/ui/SidebarNavigation";
import type { ReactNode } from "react";
import { Panel } from "../../shared/design-system/ui/Panel";
import styles from "./SidebarFrame.module.css";

/** Shared sidebar surface; callers own its contents, data and scroll behavior. */
export function SidebarFrame({
  label,
  busy,
  launchPending,
  children,
  header,
  footer,
  panelId,
}: {
  label: string;
  header?: ReactNode;
  /** Floats over the list's end and follows it in tab order. */
  footer?: ReactNode;
  panelId?: string | undefined;
  busy?: boolean | undefined;
  launchPending?: "required" | "settling" | undefined;
  children?: ReactNode;
}) {
  return (
    <Panel
      as="aside"
      aria-label={label}
      aria-busy={busy}
      data-buzz-launch-pending={launchPending}
    >
      <div className={styles.sidebar}>
        <SidebarNavigation>
          {header && <div className={styles.sidebarFilter}>{header}</div>}
          <div
            className={styles.sidebarBody}
            id={panelId}
            {...(panelId
              ? { role: "tabpanel", "aria-labelledby": `${panelId}-tab` }
              : {})}
          >
            {children}
          </div>
        </SidebarNavigation>
        {footer}
      </div>
    </Panel>
  );
}
