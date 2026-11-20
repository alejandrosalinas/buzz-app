/** The smallest context size, in tokens, an agent's session can compact at:
 * Claude Code's minimum, applied to every harness so they behave alike. */
export const MIN_COMPACT_AT = 100_000;

/** `value` as a token count an agent compacts at, or undefined for its
 * harness's own default. Valid sizes are whole thousands from the minimum, and safe integers so
 * every harness can read them. */
export const compactAt = (value: unknown) => {
  const tokens =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(tokens) &&
    tokens >= MIN_COMPACT_AT &&
    tokens % 1000 === 0
    ? tokens
    : undefined;
};

/** `config` with `compactAt` set to `value`, or without it for the
 * harness's own default. */
export const withCompactAt = <C extends { compactAt?: string }>(
  config: C,
  value: string,
): C => {
  const { compactAt: _, ...rest } = config;
  return (compactAt(value) ? { ...rest, compactAt: value } : rest) as C;
};
