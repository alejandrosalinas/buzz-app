import { useCallback, useSyncExternalStore } from "react";
import { CHANNEL_DURATIONS } from "../../bundled/channels/ChannelDurationField";
import { readView, subscribeView, writeView } from "../../shared/view-state";

// Saved on this device for the account and community (the view scope).
const KEY = "solo:default-lifetime";

/** The lifetime new Solo chats start with: seconds without activity before
 * the chat archives, or undefined for ongoing. Only the durations a person
 * can choose are read; anything else is ongoing. */
export function readDefaultLifetime(scope: string): number | undefined {
  const saved = readView<unknown>(scope, KEY, null);
  return typeof saved === "number" && CHANNEL_DURATIONS.includes(saved)
    ? saved
    : undefined;
}

/** Saves the lifetime new Solo chats start with; false when this device
 * could not save it. */
export function writeDefaultLifetime(
  scope: string,
  ttlSeconds: number | undefined,
) {
  return writeView(scope, KEY, ttlSeconds ?? null);
}

/** A draft's lifetime: the one its settings chose, else the default. */
export function draftLifetime(
  scope: string,
  settings: { ttlSeconds?: number | undefined; lifetimeChosen?: true },
): number | undefined {
  return settings.ttlSeconds !== undefined || settings.lifetimeChosen
    ? settings.ttlSeconds
    : readDefaultLifetime(scope);
}

export function useDefaultLifetime(scope: string) {
  return useSyncExternalStore(
    useCallback((listener) => subscribeView(scope, listener), [scope]),
    () => readDefaultLifetime(scope),
  );
}
