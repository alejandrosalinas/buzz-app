import { invoke, isTauri } from "@tauri-apps/api/core";

export type PresencePreference = "auto" | "online" | "away" | "offline";
const preference = (value: unknown): PresencePreference =>
  value === "away" || value === "offline" ? value : "auto";

/** One app input/preference source shared by retained community publishers. */
export function createPresenceActivity(
  readIdle: (() => Promise<number | null>) | undefined = isTauri()
    ? () => invoke<number | null>("get_os_idle_seconds")
    : undefined,
) {
  const listeners = new Set<() => void>();
  let last = Date.now(),
    sharedAt = 0;
  let away = false;
  let viewer: string | undefined;
  let choice: PresencePreference = "auto";
  let error: string | undefined;
  let command = 0;
  const status = (): "online" | "away" | "offline" =>
    choice === "auto" ? (away ? "away" : "online") : choice;
  let snapshot: {
    status: ReturnType<typeof status>;
    preference: PresencePreference;
    error: string | undefined;
  } = { status: status(), preference: choice, error };
  const emit = () => {
    snapshot = { status: status(), preference: choice, error };
    for (const listener of listeners) listener();
  };
  const storageKey = () => `buzz-presence.v1:${viewer}`;
  const restore = () => {
    try {
      const restored = preference(localStorage.getItem(storageKey()));
      if (restored !== choice) command++;
      choice = restored;
      error = undefined;
    } catch {
      error =
        "Could not read your saved availability. Changes apply to this window.";
    }
    emit();
  };
  const stored = (event: StorageEvent) => {
    if (viewer && (event.key === null || event.key === storageKey())) restore();
  };
  const visible = () =>
    typeof document !== "undefined" && document.visibilityState === "visible";
  let shown = visible();
  const channel =
    typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("buzz-presence-input")
      : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  async function sampleIdle() {
    try {
      const seconds = await readIdle?.();
      if (disposed) return;
      if (
        typeof seconds === "number" &&
        Number.isFinite(seconds) &&
        seconds >= 0
      ) {
        last = Math.max(last, Date.now() - seconds * 1000);
      }
    } catch {
      // Unsupported/failed native sensing falls back to captured Buzz input.
    }
    if (disposed) return;
    update();
    idleTimer = setTimeout(() => void sampleIdle(), 30000);
  }
  function update() {
    clearTimeout(timer);
    const nextAway = Date.now() - last >= 600000;
    const nextShown = visible();
    if (nextAway !== away || nextShown !== shown) {
      away = nextAway;
      shown = nextShown;
      emit();
    }
    if (!away)
      timer = setTimeout(update, Math.max(1, last + 600000 - Date.now()));
  }
  const input = () => {
    last = Date.now();
    if (last - sharedAt >= 1000) {
      sharedAt = last;
      channel?.postMessage(last);
    }
    update();
  };
  if (channel)
    channel.onmessage = ({ data }) => {
      if (viewer && data?.viewer === viewer && data?.preference === choice) {
        command++;
        emit();
        return;
      }
      if (
        typeof data === "number" &&
        Number.isFinite(data) &&
        data > last &&
        data <= Date.now()
      ) {
        last = data;
        update();
      }
    };
  const activate = () => {
    if (visible()) input();
    else update();
  };
  const events = [
    "pointerdown",
    "pointermove",
    "keydown",
    "wheel",
    "touchstart",
    "input",
  ];
  if (typeof document !== "undefined") {
    // Editors and menus may stop bubbling. Activity is observation, not a
    // shortcut: capture it before a control handles the event.
    for (const event of events)
      document.addEventListener(event, input, { passive: true, capture: true });
    document.addEventListener("visibilitychange", activate);
    update();
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", activate);
    window.addEventListener("storage", stored);
  }
  if (readIdle) void sampleIdle();
  return {
    status,
    command: () => command,
    snapshot: () => snapshot,
    setViewer(value: string) {
      if (value === viewer) return;
      viewer = value;
      choice = "auto";
      restore();
    },
    setPreference(value: PresencePreference) {
      if (!viewer) return;
      const previous = choice;
      choice = preference(value);
      command++;
      try {
        localStorage.setItem(storageKey(), choice);
        // Same-value writes emit no storage event in the window holding the lock.
        if (previous === choice)
          channel?.postMessage({ viewer, preference: choice });
        error = undefined;
      } catch {
        error =
          "Could not save your availability. It applies to this window until you close it.";
      }
      if (choice === "auto") input();
      emit();
    },
    visible: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      channel?.close();
      listeners.clear();
      if (typeof document !== "undefined") {
        for (const event of events)
          document.removeEventListener(event, input, true);
        document.removeEventListener("visibilitychange", activate);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", activate);
        window.removeEventListener("storage", stored);
      }
    },
  };
}
export type PresenceActivity = Pick<
  ReturnType<typeof createPresenceActivity>,
  "status" | "visible" | "subscribe" | "dispose"
> & { command?: () => number };
