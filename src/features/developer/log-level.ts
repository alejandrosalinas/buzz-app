// Shared capture/logging contract; keep host logging and HMR out of author types.
export const LOG_LEVELS = {
  silent: -999,
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
  trace: 5,
} as const;
export type LogLevel = keyof typeof LOG_LEVELS;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.hasOwn(LOG_LEVELS, value);
}
