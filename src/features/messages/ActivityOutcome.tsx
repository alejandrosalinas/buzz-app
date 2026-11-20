import { WarningCircleIcon } from "../../shared/design-system/icons";

export function activityOutcomeLabel(state: string) {
  if (state === "error") return "Couldn’t finish";
  if (state === "stopped") return "Stopped";
  return undefined;
}

export function activityOutcomeReason(state: string, reason?: string) {
  if (state === "error")
    return (
      reason ||
      "This request ended before it could finish. Try again in a new thread, or choose a different model."
    );
  return "This request was stopped.";
}

/** Confirmed failure and cancellation share geometry, with distinct meaning. */
export function ActivityOutcome({
  state,
  name,
  notice,
}: {
  state: string;
  name?: string | undefined;
  /** How the turn ran, such as without its gateway; shown after the label. */
  notice?: string | undefined;
}) {
  const label = activityOutcomeLabel(state);
  return label || notice ? (
    <span
      className={`inline-flex items-center gap-1 ${state === "error" ? "text-danger" : "text-subtle"}`}
    >
      {name && <span className="text-subtle">{name} ·</span>}
      {state === "error" && <WarningCircleIcon size={12} aria-hidden="true" />}
      {label && <span>{label}</span>}
      {notice && <span>{label ? `· ${notice}` : notice}</span>}
    </span>
  ) : null;
}
