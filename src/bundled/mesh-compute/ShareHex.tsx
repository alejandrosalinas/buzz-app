// Sharing status glyph from block/buzz MeshComputeSettingsCard
// (sandro/shared-compute-fresh). Decorative: the status line owns the words.
import {
  HexagonFilledIcon,
  HexagonIcon,
} from "../../shared/design-system/icons";
import styles from "./Compute.module.css";

export type ShareHexState = "idle" | "working" | "sharing";

const HEX = "16,2 28,9 28,23 16,30 4,23 4,9";

export function ShareHex({ state }: { state: ShareHexState }) {
  return (
    <span
      aria-hidden="true"
      className={styles.hex}
      data-state={state}
      data-testid="share-hex"
    >
      {state === "sharing" ? (
        <>
          <span className={styles.hexPing}>
            <HexagonFilledIcon size={28} />
          </span>
          <HexagonFilledIcon size={28} />
        </>
      ) : state === "working" ? (
        // A fixed outline with a short stroke tracing its edge.
        <svg aria-hidden="true" viewBox="0 0 32 32" width={28} height={28}>
          <polygon className={styles.hexTrack} points={HEX} strokeWidth="2" />
          <polygon
            className={styles.hexTrace}
            pathLength="100"
            points={HEX}
            strokeDasharray="18 82"
            strokeLinecap="round"
            strokeWidth="2.5"
          />
        </svg>
      ) : (
        <HexagonIcon size={24} />
      )}
    </span>
  );
}
