import { useId, type ReactNode } from "react";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import styles from "./ManagementRow.module.css";

/** Like member identities, readable details sit outside the navigation target. */
export function ManagementRow({
  icon,
  title,
  detail,
  status,
  actions,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  status?: string | undefined;
  actions?: ReactNode;
  onOpen?: (() => void) | undefined;
}) {
  const description = useId();
  return (
    <NavigationCard>
      <div className={styles.identity}>
        {onOpen && (
          <div className={styles.primary}>
            <NavigationItem
              label=""
              aria-label={`View ${title}`}
              aria-describedby={detail ? description : undefined}
              onClick={onOpen}
            />
          </div>
        )}
        <div className={styles.row} data-navigable={!!onOpen || undefined}>
          <span className={styles.icon} aria-hidden="true">
            {icon}
          </span>
          <div className={styles.content}>
            <ChoiceRow
              label={<span className="block text-body-sm">{title}</span>}
              description={
                detail && (
                  <span
                    id={description}
                    className="block text-caption"
                    title={typeof detail === "string" ? detail : undefined}
                  >
                    {detail}
                  </span>
                )
              }
            />
            {status && (
              <span className="text-caption text-secondary">{status}</span>
            )}
          </div>
        </div>
      </div>
      <div className={styles.actions}>{actions}</div>
    </NavigationCard>
  );
}
