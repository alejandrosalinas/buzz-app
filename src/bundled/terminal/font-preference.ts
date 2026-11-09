/** Terminal-owned, device-local installed font preference. */
export const TERMINAL_FONT_KEY = "buzz-terminal-font.v1";
export const DEFAULT_FONT_SIZE = 12;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export type TerminalFontSnapshot = {
  readonly family: string | null;
  readonly size: number;
  readonly error: string | null;
};

export function parseFontSize(raw: unknown): number | null {
  return typeof raw === "number" &&
    Number.isFinite(raw) &&
    raw >= MIN_FONT_SIZE &&
    raw <= MAX_FONT_SIZE
    ? raw
    : null;
}

// Keep reading the original family-only value; store both choices atomically.
function decode(raw: string | null | undefined) {
  if (raw?.startsWith("{")) {
    try {
      const value = JSON.parse(raw);
      return {
        family: parseFontFamily(value.family),
        size: parseFontSize(value.size) ?? DEFAULT_FONT_SIZE,
      };
    } catch {
      /* Invalid saved preferences use defaults. */
    }
  }
  return { family: parseFontFamily(raw), size: DEFAULT_FONT_SIZE };
}

/** Accept one family name, never a CSS stack or a file path. */
export function parseFontFamily(raw: unknown): string | null {
  if (typeof raw !== "string" || /[\p{Cc}"',;{}()\\:/<>]/u.test(raw))
    return null;
  const family = raw.trim();
  return family.length > 0 && family.length <= 64 ? family : null;
}

export function createTerminalFontPreference(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  let state: TerminalFontSnapshot = {
    family: null,
    size: DEFAULT_FONT_SIZE,
    error: null,
  };
  let disposed = false;
  let restoreFailed = false;
  const listeners = new Set<() => void>();
  const publish = (next: TerminalFontSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const restore = () => {
    restoreFailed = false;
    try {
      publish({
        ...decode(host?.localStorage.getItem(TERMINAL_FONT_KEY)),
        error: null,
      });
    } catch {
      restoreFailed = true;
      publish({
        family: null,
        size: DEFAULT_FONT_SIZE,
        error:
          "Your terminal font could not be restored. The default is active.",
      });
    }
  };
  const commit = (family: string | null, size: number) => {
    restoreFailed = false;
    let error: string | null = null;
    try {
      if (!host) throw new Error("No browser storage");
      if (family === null && size === DEFAULT_FONT_SIZE)
        host.localStorage.removeItem(TERMINAL_FONT_KEY);
      else
        host.localStorage.setItem(
          TERMINAL_FONT_KEY,
          size === DEFAULT_FONT_SIZE && family !== null
            ? family
            : JSON.stringify({ family, size }),
        );
    } catch {
      error =
        family === null && size === DEFAULT_FONT_SIZE
          ? "The default terminal font is active, but this reset could not be saved on this device. Your previous font may return after restarting. Try again."
          : "Your terminal font is active, but could not be saved on this device. Try again.";
    }
    publish({ family, size, error });
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== TERMINAL_FONT_KEY && event.key !== null) return;
    try {
      if (event.storageArea !== host?.localStorage) return;
    } catch {
      /* restore reports the failure */
    }
    // Read current storage rather than applying a possibly stale queued event.
    restore();
  };
  restore();
  host?.addEventListener("storage", onStorage);
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(name: string | null, size = state.size) {
      if (disposed) return;
      const family = parseFontFamily(name);
      if (name !== null && family === null)
        throw new Error("Invalid font family");
      if (parseFontSize(size) === null) throw new Error("Invalid font size");
      commit(family, size);
    },
    reset() {
      if (!disposed) commit(null, DEFAULT_FONT_SIZE);
    },
    retry() {
      if (disposed) return;
      // A failed read must never turn Retry into deletion of an unread choice.
      if (restoreFailed) restore();
      else commit(state.family, state.size);
    },
    dispose() {
      disposed = true;
      host?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

export type TerminalFontPreference = ReturnType<
  typeof createTerminalFontPreference
>;
