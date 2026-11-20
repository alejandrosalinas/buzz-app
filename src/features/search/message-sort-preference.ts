import { useSyncExternalStore } from "react";
import type { SearchSort } from "../../app/shell/useSearchMessages";

const preferenceKey = "buzz-search-message-sort.v1";
const changedEvent = "buzz-search-message-sort-changed";
let unsavedPreference: SearchSort | undefined;

/** Device-local order each new search starts with, where it offers a choice. */
export function messageSortPreference(): SearchSort {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "newest"
      ? "newest"
      : "relevance";
  } catch {
    return "relevance";
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
export function useMessageSortPreference() {
  const sort = useSyncExternalStore(subscribe, messageSortPreference);
  // Saving the same active choice changes recovery state, not its order.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { sort, unsaved };
}
export function setMessageSortPreference(value: SearchSort): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}
