import { Button } from "../../shared/design-system/ui/Button";
import { ArrowsClockwiseIcon } from "../../shared/design-system/icons";
import { useEffect, useState } from "react";
import type { ChannelMessage } from "../relay/contracts";
import { DELIVERY_GRACE_MS, deliveryFeedback } from "./delivery";
import styles from "./Messages.module.css";

export function DeliveryNotice({
  row,
  retry,
}: {
  row: ChannelMessage;
  retry?: ((id: string) => void) | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!row.delivery || row.delivery === "seen") return;
    setNow(Date.now());
    const remaining = row.createdAt * 1000 + DELIVERY_GRACE_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [row.createdAt, row.delivery]);
  // A refused retry explains itself until the delivery changes.
  const [refusal, setRefusal] = useState<{
    delivery: ChannelMessage["delivery"];
    reason: string;
  }>();
  const refused =
    refusal && refusal.delivery === row.delivery ? refusal.reason : undefined;
  const status = deliveryFeedback(row, now);
  const feedback = status && refused ? `${status} ${refused}` : status;
  if (!feedback) return null;
  const canRetry =
    !refused &&
    (row.delivery === "failed" || row.delivery === "unknown") &&
    retry;
  return (
    <div className={styles.delivery}>
      <span role="status" className={canRetry ? "sr-only" : undefined}>
        {feedback}
      </span>
      {canRetry && (
        <Button
          size="inline"
          variant="ghost"
          title={feedback}
          onClick={() => {
            try {
              retry(row.id);
            } catch (error) {
              setRefusal({
                delivery: row.delivery,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }}
        >
          <ArrowsClockwiseIcon size={12} aria-hidden="true" /> Retry
        </Button>
      )}
    </div>
  );
}
