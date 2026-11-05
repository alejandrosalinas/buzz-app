import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

const preferenceKey = "buzz-search-unread-first.v1";
const changedEvent = "buzz-search-unread-first-changed";
let unsavedPreference: boolean | undefined;

/** Device-local choice to lead an empty search with unread conversations. */
export function unreadFirstPreference(): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) !== "off";
  } catch {
    return true;
  }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    unsavedPreference = undefined;
    listener();
  };
  window.addEventListener(changedEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changedEvent, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useUnreadFirstPreference() {
  const enabled = useSyncExternalStore(subscribe, unreadFirstPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { enabled, unsaved };
}
export function setUnreadFirstPreference(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Leading an empty search with unread conversations as a device setting. */
export const unreadFirstSetting: DeviceSetting = {
  key: "search.unread_first",
  description:
    "With nothing typed, search leads with unread channels and DMs and selects the newest.",
  schema: { type: "boolean" },
  read: () => ({
    value: unreadFirstPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This choice is active, but could not be saved on this device.",
  }),
  write: (value) => setUnreadFirstPreference(value as boolean),
};
