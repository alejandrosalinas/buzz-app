import { createConsola } from "consola";
import type { ViteHotContext } from "vite/types/hot.d.ts";

import {
  DEFAULT_LOG_LEVEL,
  isLogLevel,
  LOG_LEVELS,
  type LogLevel,
} from "./log-level.ts";
export {
  DEFAULT_LOG_LEVEL,
  isLogLevel,
  LOG_LEVELS,
  type LogLevel,
} from "./log-level.ts";

export const DEVELOPER_SETTINGS_PATH = "/api/dev/settings";
export const LOG_LEVEL_EVENT = "buzz:log-level";

let level: LogLevel = DEFAULT_LOG_LEVEL;
const loggers = new Map<string, ReturnType<typeof createConsola>>();
const listeners = new Set<() => void>();
export const logLevel = () => level;
export function subscribeLogLevel(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setLogLevel(next: LogLevel) {
  level = next;
  // Consola's withTag creates independent instances; update every existing tag.
  for (const logger of loggers.values()) logger.level = LOG_LEVELS[next];
  for (const listener of listeners) listener();
}
export function getLogger(tag: string) {
  let logger = loggers.get(tag);
  if (!logger) {
    logger = createConsola({
      defaults: { tag },
      level: LOG_LEVELS[level],
      // Debug is a firehose, including repeated frames. Never coalesce traffic.
      // Consola coalesces when the gap since the last log is below `throttle`,
      // so 0 still coalesces after the clock steps back.
      throttle: Number.NEGATIVE_INFINITY,
    });
    loggers.set(tag, logger);
  }
  return logger;
}

export const hasDeveloperSettings = () =>
  import.meta.env?.DEV && import.meta.env.BUZZ_DEV_SETTINGS === "1";
let revision = -1;
function applySettings(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("logLevel" in value) ||
    !isLogLevel(value.logLevel) ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new Error("Invalid development settings response.");
  if (value.revision > revision) {
    revision = value.revision;
    setLogLevel(value.logLevel);
  }
}
export async function developerSettings(next?: LogLevel): Promise<LogLevel> {
  if (!hasDeveloperSettings())
    throw new Error("Development settings are unavailable.");
  const response = await fetch(DEVELOPER_SETTINGS_PATH, {
    cache: "no-store",
    // Missing APIs must return 404, not Vite's HTML fallback (and its warmup).
    headers: {
      Accept: "application/json",
      ...(next ? { "Content-Type": "application/json" } : {}),
    },
    ...(next
      ? {
          method: "POST",
          body: JSON.stringify({ logLevel: next }),
        }
      : {}),
  });
  if (!response.ok)
    throw new Error(
      "Development settings are unavailable or could not be saved.",
    );
  const value: unknown = await response.json();
  applySettings(value);
  return logLevel();
}

// The serving plugin advertises support; HMR alone does not imply an API exists.
export function connectDeveloperSettings(hot: ViteHotContext) {
  if (!hasDeveloperSettings()) return;
  const changed = (value: unknown) => {
    try {
      applySettings(value);
    } catch {
      /* Ignore malformed custom events. */
    }
  };
  const refresh = () => {
    // Catch saves made before the initial HMR socket opened. Vite reloads the
    // page after a server restart, so a new server gets fresh module state.
    void developerSettings().catch(() => {});
  };
  hot.on(LOG_LEVEL_EVENT, changed);
  hot.on("vite:ws:connect", refresh);
  refresh();
  hot.dispose(() => {
    hot.off(LOG_LEVEL_EVENT, changed);
    hot.off("vite:ws:connect", refresh);
  });
}
if (import.meta.hot) connectDeveloperSettings(import.meta.hot);
