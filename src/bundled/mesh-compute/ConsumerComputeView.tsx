// Consumer presentation adapted from feat/community-compute-plugin @ b4a910e.
// Host lifecycle/leases remain owned by this plugin, not the donor's sharing service.
import type { ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import styles from "./Compute.module.css";

export function ConsumerComputeView({
  headerControl,
  children,
  status,
  attention = false,
  error,
  refreshDisabled,
  refresh,
}: {
  headerControl?: ReactNode;
  children?: ReactNode;
  status?: string | undefined;
  attention?: boolean;
  error: string | undefined | null;
  refreshDisabled: boolean;
  refresh: () => void;
}) {
  return (
    <section
      aria-label="Compute consumer"
      className={`${styles.content} text-body`}
    >
      <Header title="Shared compute" actions={headerControl} />
      {children}
      <p
        role="status"
        className={
          attention
            ? "m-0 text-body-sm text-warning"
            : "m-0 text-body-sm text-secondary"
        }
      >
        {status}
      </p>
      {error && (
        <div>
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
          <Button
            variant="subtle"
            size="sm"
            onClick={refresh}
            disabled={refreshDisabled}
          >
            Retry
          </Button>
        </div>
      )}
    </section>
  );
}
