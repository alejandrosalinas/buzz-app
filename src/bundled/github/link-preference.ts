import { useSyncExternalStore } from "react";

const key = "buzz.github.open-links-in-buzz.v1";
const changed = "buzz-github-link-preference-changed";

/** Device-local preference, read again for each panel opening. */
export function openGitHubLinksInBuzz(): boolean {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

export function setOpenGitHubLinksInBuzz(enabled: boolean): void {
  // Do not show the choice as changed if it could not be saved.
  localStorage.setItem(key, enabled ? "on" : "off");
  if (typeof window !== "undefined") window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener();
  };
  window.addEventListener(changed, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener("storage", storage);
  };
}

export function useOpenGitHubLinksInBuzz() {
  return useSyncExternalStore(subscribe, openGitHubLinksInBuzz);
}
