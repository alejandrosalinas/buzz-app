import { useEffect, useRef, useCallback } from "react";
import type { ComputeActivityData } from "./ComputeActivity";
import styles from "./Compute.module.css";

/** Reuses the floating widget's renderer with the settings owner's status feed. */
export function EmbeddedActivity({
  data,
  sharing,
  state,
}: {
  data: ComputeActivityData | null;
  sharing: boolean;
  state: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const send = useCallback(() => {
    const status = {
      available: data !== null,
      sharing,
      state: sharing ? state : "off",
      generation: sharing,
      usage:
        sharing && data?.outputTokens != null && data.activeRequests != null
          ? {
              tokensServed: data.outputTokens,
              inflight: data.activeRequests,
              tokensPerSecond: data.tokensPerSecond,
              peers: data.otherNodes,
            }
          : null,
    };
    frame.current?.contentWindow?.postMessage(
      { type: "compute-activity", status },
      window.location.origin === "null" ? "*" : window.location.origin,
    );
  }, [data, sharing, state]);
  useEffect(send, [send]);
  return (
    <iframe
      ref={frame}
      className={styles.embeddedWidget}
      title="Live compute activity"
      src="/compute-widget.html?embedded=true"
      onLoad={send}
    />
  );
}
