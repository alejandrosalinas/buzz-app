import {
  ACCENT_KEY,
  CONTRAST_KEY,
  parseContrast,
  type Contrast,
  DEFAULT_ACCENT,
  LEGACY_BUBBLE_KEY,
  parseAccent,
  parseLegacyBubbleColor,
  type Accent,
} from "./accent";
/** Host-owned, device-local appearance. Never depends on plugin/relay readiness. */
export type ColorMode = "light" | "dark";
export type ColorModePreference = ColorMode | "system";
export const APPEARANCE_KEY = "buzz-appearance.v1";
export type MessageWidth = "narrow" | "wide";
export const MESSAGE_WIDTH_KEY = "buzz-message-width.v1";
export const parseMessageWidth = (value: unknown): MessageWidth =>
  value === "wide" ? "wide" : "narrow";
export const FONT_SCALE_KEY = "buzz-font-scale.v1";
export const MIN_FONT_SCALE = 0.8;
export const MAX_FONT_SCALE = 2;
export function parseFontScale(value: unknown): number {
  const number =
    typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" &&
    Number.isFinite(number) &&
    number >= MIN_FONT_SCALE &&
    number <= MAX_FONT_SCALE
    ? Math.round(number * 10) / 10
    : 1;
}
export const parseColorMode = (value: unknown): ColorMode =>
  value === "dark" ? "dark" : "light";
export const parseColorModePreference = (
  value: unknown,
): ColorModePreference =>
  value === "light" || value === "dark" ? value : "system";
/** Vertical rhythm of conversation rows; text size stays with the font scale. */
export type MessageDensity = "default" | "compact";
export const DENSITY_KEY = "buzz-message-density.v1";
export const parseMessageDensity = (value: unknown): MessageDensity =>
  value === "compact" ? "compact" : "default";

export interface AppearanceSnapshot {
  readonly preference: ColorModePreference;
  readonly mode: ColorMode;
  readonly messageWidth: MessageWidth;
  readonly messageWidthError: string | null;
  readonly fontScale: number;
  readonly fontError: string | null;
  readonly accent: Accent;
  readonly accentError: string | null;
  readonly contrast: Contrast;
  readonly contrastError: string | null;
  readonly density: MessageDensity;
  readonly densityError: string | null;
  readonly error: string | null;
}

export function createAppearance(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  const systemScheme = host?.matchMedia?.("(prefers-color-scheme: dark)");
  const resolvedMode = (preference: ColorModePreference): ColorMode =>
    preference === "system"
      ? systemScheme?.matches
        ? "dark"
        : "light"
      : preference;
  let state: AppearanceSnapshot = {
    preference: "system",
    mode: "light",
    error: null,
    messageWidth: "narrow",
    messageWidthError: null,
    fontScale: 1,
    fontError: null,
    accent: DEFAULT_ACCENT,
    accentError: null,
    contrast: "low",
    contrastError: null,
    density: "default",
    densityError: null,
  };
  let disposed = false;
  let paletteGuard = 0;
  const listeners = new Set<() => void>();
  const apply = () => {
    if (!host) return;
    const root = host.document.documentElement;
    const changingPalette =
      root.dataset.colorMode &&
      (root.dataset.colorMode !== state.mode ||
        root.dataset.accent !== state.accent ||
        root.dataset.colorLevel !==
          (state.contrast === "low" ? "touch" : state.contrast));
    // A stylesheet removal rebuilds WebKit's style resolver; an attribute only restyles.
    const guard = changingPalette ? ++paletteGuard : undefined;
    if (guard) root.dataset.paletteChanging = "";
    root.dataset.colorMode = state.mode;
    root.dataset.accent = state.accent;
    // Preserve the existing soft-bubble selector for Chillin’.
    root.dataset.colorLevel =
      state.contrast === "low" ? "touch" : state.contrast;
    if (guard) {
      // Commit the new palette before restoring interactive transitions.
      void root.offsetHeight;
      host.requestAnimationFrame(() =>
        host.requestAnimationFrame(() => {
          if (guard === paletteGuard) delete root.dataset.paletteChanging;
        }),
      );
    }
    root.style.setProperty(
      "--buzz-message-width",
      state.messageWidth === "wide" ? "78rem" : "52rem",
    );
    root.dataset.messageDensity = state.density;
    root.style.setProperty("--buzz-text-scale", String(state.fontScale));
    // CSS owns the palette; browser chrome derives from the same canvas token.
    host.document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        host.getComputedStyle(root).getPropertyValue("--bg-app").trim(),
      );
  };
  const notify = () => {
    apply();
    for (const listener of listeners) listener();
  };
  const restore = () => {
    try {
      const preference = parseColorModePreference(
        host?.localStorage.getItem(APPEARANCE_KEY),
      );
      state = {
        ...state,
        preference,
        mode: resolvedMode(preference),
        error: null,
      };
    } catch {
      state = {
        ...state,
        error:
          "Appearance could not be restored. Choose a mode to try saving it again.",
      };
    }
    notify();
  };
  const onSystemSchemeChange = () => {
    if (disposed || state.preference !== "system") return;
    const mode = resolvedMode("system");
    if (mode === state.mode) return;
    state = { ...state, mode };
    notify();
  };
  const restoreFont = () => {
    try {
      state = {
        ...state,
        fontScale: parseFontScale(host?.localStorage.getItem(FONT_SCALE_KEY)),
        fontError: null,
      };
    } catch {
      state = {
        ...state,
        fontError:
          "Interface size could not be restored. Choose a size to try saving it again.",
      };
    }
    notify();
  };
  const restoreMessageWidth = () => {
    try {
      state = {
        ...state,
        messageWidth: parseMessageWidth(
          host?.localStorage.getItem(MESSAGE_WIDTH_KEY),
        ),
        messageWidthError: null,
      };
    } catch {
      state = {
        ...state,
        messageWidthError:
          "Message width could not be restored. Choose a width to try saving it again.",
      };
    }
    notify();
  };
  const restoreAccent = () => {
    try {
      const saved = host?.localStorage.getItem(ACCENT_KEY);
      state = {
        ...state,
        accent:
          saved != null
            ? parseAccent(saved)
            : parseLegacyBubbleColor(
                host?.localStorage.getItem(LEGACY_BUBBLE_KEY),
              ),
        accentError: null,
      };
    } catch {
      state = {
        ...state,
        accentError:
          "Accent color could not be restored. Choose a color to try saving it again.",
      };
    }
    notify();
  };
  const restoreContrast = () => {
    try {
      state = {
        ...state,
        contrast: parseContrast(host?.localStorage.getItem(CONTRAST_KEY)),
        contrastError: null,
      };
    } catch {
      state = {
        ...state,
        contrastError:
          "Vibe level could not be restored. Choose a level to try saving it again.",
      };
    }
    notify();
  };
  const restoreDensity = () => {
    try {
      state = {
        ...state,
        density: parseMessageDensity(host?.localStorage.getItem(DENSITY_KEY)),
        densityError: null,
      };
    } catch {
      state = {
        ...state,
        densityError:
          "Message density could not be restored. Choose a density to try saving it again.",
      };
    }
    notify();
  };
  const onStorage = (event: StorageEvent) => {
    if (
      event.key !== APPEARANCE_KEY &&
      event.key !== FONT_SCALE_KEY &&
      event.key !== MESSAGE_WIDTH_KEY &&
      event.key !== ACCENT_KEY &&
      event.key !== CONTRAST_KEY &&
      event.key !== DENSITY_KEY &&
      event.key !== LEGACY_BUBBLE_KEY &&
      event.key !== null
    )
      return;
    // Re-read the current value: an older queued event must not undo a newer save.
    try {
      if (event.storageArea !== host?.localStorage) return;
      if (event.key === null || event.key === APPEARANCE_KEY) restore();
      if (event.key === null || event.key === FONT_SCALE_KEY) restoreFont();
      if (event.key === null || event.key === MESSAGE_WIDTH_KEY)
        restoreMessageWidth();
      if (event.key === null || event.key === CONTRAST_KEY) restoreContrast();
      if (event.key === null || event.key === DENSITY_KEY) restoreDensity();
      if (
        event.key === null ||
        event.key === ACCENT_KEY ||
        event.key === LEGACY_BUBBLE_KEY
      )
        restoreAccent();
    } catch {
      if (event.key === null || event.key === APPEARANCE_KEY) restore();
      if (event.key === null || event.key === FONT_SCALE_KEY) restoreFont();
      if (event.key === null || event.key === MESSAGE_WIDTH_KEY)
        restoreMessageWidth();
      if (event.key === null || event.key === CONTRAST_KEY) restoreContrast();
      if (event.key === null || event.key === DENSITY_KEY) restoreDensity();
      if (
        event.key === null ||
        event.key === ACCENT_KEY ||
        event.key === LEGACY_BUBBLE_KEY
      )
        restoreAccent();
    }
  };
  restore();
  restoreFont();
  restoreMessageWidth();
  restoreAccent();
  restoreContrast();
  restoreDensity();
  host?.addEventListener("storage", onStorage);
  systemScheme?.addEventListener("change", onSystemSchemeChange);
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setMode(preference: ColorModePreference) {
      if (
        disposed ||
        (preference !== "light" &&
          preference !== "dark" &&
          preference !== "system")
      )
        return;
      let error: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(APPEARANCE_KEY, preference);
      } catch {
        error =
          "This appearance is active, but could not be saved on this device. Try again.";
      }
      state = { ...state, preference, mode: resolvedMode(preference), error };
      notify();
    },
    setFontScale(value: number) {
      if (disposed || !Number.isFinite(value)) return;
      const fontScale = parseFontScale(
        Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value)),
      );
      let fontError: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(FONT_SCALE_KEY, String(fontScale));
      } catch {
        fontError =
          "This interface size is active, but could not be saved on this device. Try again.";
      }
      state = { ...state, fontScale, fontError };
      notify();
    },
    setMessageWidth(value: MessageWidth) {
      if (disposed) return;
      const messageWidth = parseMessageWidth(value);
      let messageWidthError: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(MESSAGE_WIDTH_KEY, messageWidth);
      } catch {
        messageWidthError =
          "This message width is active, but could not be saved on this device. Try again.";
      }
      state = { ...state, messageWidth, messageWidthError };
      notify();
    },
    setAccent(value: Accent) {
      if (disposed) return;
      const accent = parseAccent(value);
      let accentError: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(ACCENT_KEY, accent);
      } catch {
        accentError =
          "This accent color is active, but could not be saved on this device. Try again.";
      }
      state = { ...state, accent, accentError };
      notify();
    },
    setContrast(value: Contrast) {
      if (disposed) return;
      const contrast = parseContrast(value);
      let contrastError: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(CONTRAST_KEY, contrast);
      } catch {
        contrastError =
          "This vibe level is active, but could not be saved on this device. Try again.";
      }
      state = { ...state, contrast, contrastError };
      notify();
    },
    setDensity(value: MessageDensity) {
      if (disposed) return;
      const density = parseMessageDensity(value);
      let densityError: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(DENSITY_KEY, density);
      } catch {
        densityError =
          "This message density is active, but could not be saved on this device. Try again.";
      }
      state = { ...state, density, densityError };
      notify();
    },
    /** After `dispose`, setters change nothing. */
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
      host?.removeEventListener("storage", onStorage);
      systemScheme?.removeEventListener("change", onSystemSchemeChange);
      listeners.clear();
    },
  };
}

export type Appearance = ReturnType<typeof createAppearance>;
