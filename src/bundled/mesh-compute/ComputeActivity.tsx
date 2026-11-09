import { CaretRightIcon } from "../../shared/design-system/icons";
import styles from "./Compute.module.css";

export type ComputeActivityData = {
  otherNodes: number | null;
  sharingNodes: number | null;
  outputTokens: number | null;
  completedRequests: number | null;
  finishedRequests: number | null;
  retries: number | null;
  activeRequests: number | null;
  tokensPerSecond: number | null;
};

export function ComputeActivity({
  data,
}: {
  data: ComputeActivityData | null;
}) {
  const format = (value: number | null) =>
    value == null
      ? "—"
      : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return (
    <section aria-label="Shared-compute activity" className={styles.activity}>
      <div className={styles.activityHeader}>
        <h2 className="m-0 text-body">Shared-compute activity</h2>
        <span className={`${styles.sessionStatus} text-caption text-secondary`}>
          <span
            className={styles.statusLight}
            data-active={
              data?.activeRequests != null && data.activeRequests > 0
            }
            aria-hidden="true"
          />
          {data?.activeRequests == null
            ? "This session"
            : data.activeRequests > 0
              ? "Processing"
              : "Standby"}
        </span>
      </div>
      {data ? (
        <dl className={styles.metrics}>
          {(
            [
              ["Output tokens", data.outputTokens],
              ["Completed requests", data.completedRequests],
              ["Other sharing nodes", data.sharingNodes],
              ["Tokens / sec (avg)", data.tokensPerSecond],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className={styles.metric}>
              <dt
                className={`${styles.metricLabel} text-caption text-secondary`}
              >
                {label}
              </dt>
              <dd
                className={`${styles.readout} m-0 text-body`}
                title={value == null ? "Not available" : format(value)}
              >
                {value == null ? (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">Not available</span>
                  </>
                ) : (
                  format(value)
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-body-sm text-secondary">
          Activity is currently unavailable.
        </p>
      )}
      <details className={styles.details}>
        <summary className="text-body-sm text-secondary">
          <CaretRightIcon
            className={styles.detailsArrow}
            size={16}
            aria-hidden="true"
          />
          Details
        </summary>
        {data && (
          <dl className={styles.secondaryMetrics}>
            {(
              [
                ["Other nodes seen", data.otherNodes],
                ["Finished requests", data.finishedRequests],
                ["Active requests", data.activeRequests],
                ["Retries", data.retries],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className={styles.metric}>
                <dt className="text-caption text-secondary">{label}</dt>
                <dd className={`${styles.readout} m-0 text-body`}>
                  {format(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </details>
    </section>
  );
}
