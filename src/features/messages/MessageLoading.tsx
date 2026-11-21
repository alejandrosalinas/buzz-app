import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import styles from "./Messages.module.css";

/** Shared message-read feedback; LoadingRegion delays feedback, never the result. */
export function MessageLoading({
  label = "Loading messages…",
}: {
  label?: string;
}) {
  return (
    <div className={styles.threadLoading}>
      <LoadingRegion
        pending
        label={
          <>
            <TypingDots size="small" />
            <span className="sr-only">{label}</span>
          </>
        }
      >
        {null}
      </LoadingRegion>
    </div>
  );
}
