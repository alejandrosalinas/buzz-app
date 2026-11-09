import { useSyncExternalStore } from "react";
import type { VerifiedProfile } from "../relay/verified-profile";

/** How this device shows people a community has verified. */
export type NamePreference = "username" | "full-name";
const preferenceKey = "buzz-name-preference.v1";
const changedEvent = "buzz-name-preference-changed";
let unsavedPreference: NamePreference | undefined;

/** Device-local; the community's verified display name (the username) by default. */
export function namePreference(): NamePreference {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "full-name"
      ? "full-name"
      : "username";
  } catch {
    return "username";
  }
}
export function subscribeNamePreference(listener: () => void) {
  if (typeof window === "undefined") return () => {};
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
export function useNamePreference() {
  return useSyncExternalStore(
    subscribeNamePreference,
    namePreference,
    () => "username" as const,
  );
}
export function setNamePreference(value: NamePreference): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice for this session.
  }
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(changedEvent));
}

/** The name a verified person goes by on this device. */
export function verifiedLabel(
  verified: Pick<VerifiedProfile, "displayName" | "fullName">,
  preference: NamePreference = namePreference(),
) {
  return (
    (preference === "full-name" && verified.fullName) || verified.displayName
  );
}

/**
 * Shown beside a verified person's `label` (their name on this device, before
 * any namesake qualifier): whichever verified name it is not, if any.
 */
export function otherVerifiedName(
  label: string,
  verified: { username?: string | undefined; fullName?: string | undefined },
) {
  if (verified.fullName && verified.fullName !== label)
    return verified.fullName;
  if (verified.username && verified.username !== label)
    return `@${verified.username}`;
  return undefined;
}
