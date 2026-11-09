import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import type { ReactNode } from "react";
import styles from "./ActivityStepPreview.module.css";

/** The request's typing footprint opens into its real current step. */
export function ActivityStepPreview({
  text,
  state,
  icon,
}: {
  text?: string | undefined;
  state: "waiting" | "working";
  icon?: ReactNode;
}) {
  const label = activityStepLabel(text);
  return (
    <span className={styles.stepPreview}>
      {icon}
      <TypingDots size="message" state={state} />
      {label && (
        <span className={styles.stepText}>
          <ShimmerText active={state === "working"}>{label}</ShimmerText>
        </span>
      )}
    </span>
  );
}

/** The same readable step names both the preview and its trigger. */
export function activityStepLabel(text?: string): string {
  const characters = Array.from(text?.replace(/\s+/g, " ").trim() ?? "");
  const label =
    characters.length > 280
      ? `${characters.slice(0, 279).join("")}…`
      : characters.join("");
  return label === "Sending a message" ? "" : label;
}
