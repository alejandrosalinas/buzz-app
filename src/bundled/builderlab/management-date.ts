/** Normalize optional JSON dates before exposing them as epoch milliseconds. */
export function managementTimestamp(value: unknown): number | undefined {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  )
    return undefined;
  const numeric = Number(value);
  // Contemporary Unix seconds have fewer than 12 digits; milliseconds have 13.
  const timestamp = Number.isFinite(numeric)
    ? numeric < 100_000_000_000
      ? numeric * 1_000
      : numeric
    : typeof value === "string"
      ? Date.parse(value)
      : NaN;
  return timestamp > 0 && Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : undefined;
}

export function managementDate(value: unknown): string | undefined {
  const timestamp = managementTimestamp(value);
  return timestamp === undefined
    ? undefined
    : new Date(timestamp).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}
