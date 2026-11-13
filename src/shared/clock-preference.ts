import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export type HourCycle = "h12" | "h23";
export type ClockPreference = {
  hourCycle: "system" | HourCycle;
  seconds: boolean;
  messageTimestamps: "show" | "hide-solo" | "hide";
  /** Profile local times include how far ahead or behind the viewer they
   * are, and name the zone on a line of its own. */
  localTimeDetails: boolean;
};

const preferenceKey = "buzz-clock.v1";
const listeners = new Set<() => void>();
/** Read once, since every formatted time consults it. */
let current: ClockPreference | undefined;
let unsaved = false;
/** The system's 24-hour setting, which the webview's locale does not reflect. */
let system: HourCycle | undefined;

function read(): ClockPreference {
  let saved: Record<string, unknown> = {};
  try {
    saved = Object(JSON.parse(localStorage.getItem(preferenceKey) ?? "{}"));
  } catch {}
  const { hourCycle, seconds, messageTimestamps, localTimeDetails } = saved;
  return {
    hourCycle:
      hourCycle === "h12" || hourCycle === "h23" ? hourCycle : "system",
    seconds: seconds === true,
    messageTimestamps:
      messageTimestamps === "hide-solo" || messageTimestamps === "hide"
        ? messageTimestamps
        : "show",
    localTimeDetails: localTimeDetails !== false,
  };
}

/** Device-local clock settings. */
export function clockPreference(): ClockPreference {
  current ??= read();
  return current;
}

/** The hour cycle to format with; undefined follows the locale. */
export function clockHourCycle(): HourCycle | undefined {
  const { hourCycle } = clockPreference();
  return hourCycle === "system" ? system : hourCycle;
}

function notify() {
  for (const listener of listeners) listener();
}

function refreshSystem() {
  if (!isTauri()) return;
  invoke<HourCycle | null>("system_hour_cycle").then(
    (cycle) => {
      if ((cycle ?? undefined) === system) return;
      system = cycle ?? undefined;
      notify();
    },
    () => {},
  );
}

function storage(event: StorageEvent) {
  if (event.key !== preferenceKey && event.key !== null) return;
  current = undefined;
  unsaved = false;
  notify();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    // Another window may have saved while nothing here was listening.
    if (!unsaved) current = undefined;
    refreshSystem();
    window.addEventListener("focus", refreshSystem);
    document.addEventListener("visibilitychange", refreshSystem);
    window.addEventListener("storage", storage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("focus", refreshSystem);
      document.removeEventListener("visibilitychange", refreshSystem);
      window.removeEventListener("storage", storage);
    }
  };
}

function key() {
  const { hourCycle, seconds, messageTimestamps, localTimeDetails } =
    clockPreference();
  return `${hourCycle} ${system} ${seconds} ${messageTimestamps} ${localTimeDetails}`;
}
const pending = () => unsaved;

/** Re-renders the caller when a clock setting or the system's 24-hour setting
 * changes, so times from `shared/datetime` stay current; the system setting is
 * re-read when the window regains focus. */
export function useClockFormat(): void {
  useSyncExternalStore(subscribe, key, key);
}

/** The clock settings, re-rendering the caller as `useClockFormat` does. */
export function useClockPreference() {
  useClockFormat();
  return {
    ...clockPreference(),
    unsaved: useSyncExternalStore(subscribe, pending, pending),
  };
}

export function setClockPreference(change: Partial<ClockPreference>): void {
  current = { ...clockPreference(), ...change };
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(current));
    unsaved = false;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
    unsaved = true;
  }
  notify();
}
