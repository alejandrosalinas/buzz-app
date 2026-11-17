export const statusDurations = [
  ["3600", "1 hour"],
  ["28800", "8 hours"],
  ["today", "Today"],
  ["week", "This week"],
  ["custom", "Custom"],
  ["never", "Don’t clear"],
] as const;

export function statusDeadline(duration: string, now: number) {
  const date = new Date(now * 1000);
  if (duration === "today") date.setHours(24, 0, 0, 0);
  else if (duration === "week") {
    date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
    date.setHours(0, 0, 0, 0);
  } else return now + Number(duration);
  return Math.floor(date.getTime() / 1000);
}

/** Presets are not saved, so infer the one whose deadline is closest to the
 * saved expiry. Near 16:00 both "8 hours" and "Today" fall within tolerance;
 * at 16:00 exactly they end at the same midnight, as "This week" does on a
 * Sunday, and Today wins the tie. */
export function statusDuration(
  expiresAt: number | undefined,
  updatedAt: number,
) {
  if (expiresAt === undefined) return "never";
  let best: string = "custom";
  let bestDistance = 121;
  for (const [value] of statusDurations) {
    if (value === "custom" || value === "never") continue;
    const distance = Math.abs(statusDeadline(value, updatedAt) - expiresAt);
    if (
      distance < bestDistance ||
      (distance === bestDistance && value === "today" && best !== "custom")
    ) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}
