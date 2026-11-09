import { ACCENTS, ACCENT_KEY, LEGACY_BUBBLE_KEY } from "./accent";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import {
  APPEARANCE_KEY,
  FONT_SCALE_KEY,
  MESSAGE_WIDTH_KEY,
  createAppearance,
  parseColorMode,
  parseColorModePreference,
  parseFontScale,
} from "./service";

function browser(stored: string | null = null, systemDark = false) {
  const values = new Map(stored === null ? [] : [[APPEARANCE_KEY, stored]]);
  const listeners = new Set<(event: StorageEvent) => void>();
  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty: vi.fn() },
  };
  const meta = { setAttribute: vi.fn() };
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
  let frames: (() => void)[] = [];
  let dark = systemDark;
  const schemeListeners = new Set<() => void>();
  const scheme = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, fn: () => void) => schemeListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) =>
      schemeListeners.delete(fn),
  };
  const host = {
    localStorage: storage,
    matchMedia: () => scheme,
    document: {
      documentElement: root,
      querySelector: () => meta,
    },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    getComputedStyle: () => ({
      getPropertyValue: (name: string) =>
        name === "--bg-app"
          ? root.dataset.colorMode === "dark"
            ? " #11181d "
            : " #e7f0ef "
          : "",
    }),
    addEventListener: (_: string, fn: (event: StorageEvent) => void) =>
      listeners.add(fn),
    removeEventListener: (_: string, fn: (event: StorageEvent) => void) =>
      listeners.delete(fn),
  } as unknown as Window;
  return {
    host,
    root,
    meta,
    storage,
    listeners,
    schemeListeners,
    values,
    frame() {
      const pending = frames;
      frames = [];
      for (const callback of pending) callback();
    },
    systemDark(value: boolean) {
      dark = value;
      for (const fn of schemeListeners) fn();
    },
    change(
      key: string | null = APPEARANCE_KEY,
      storageArea: unknown = storage,
    ) {
      for (const fn of listeners) fn({ key, storageArea } as StorageEvent);
    },
  };
}

it.each([
  [null, false],
  ["", false],
  ["LIGHT", false],
  ['{"mode":"dark"}', false],
  ["light", false],
  ["dark", false],
  ["system", false],
  ["system", true],
] as const)(
  "bootstrap and service agree for stored %j with system dark %j",
  (value, systemDark) => {
    const b = browser(value, systemDark);
    runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
      localStorage: b.storage,
      document: b.host.document,
      matchMedia: b.host.matchMedia,
    });
    const preference = parseColorModePreference(value);
    const mode =
      preference === "system" && systemDark ? "dark" : parseColorMode(value);
    expect(b.root.dataset.colorMode).toBe(mode);
    const app = createAppearance(b.host);
    expect(app.snapshot()).toEqual({
      preference: parseColorModePreference(value),
      mode,
      error: null,
      messageWidth: "narrow",
      messageWidthError: null,
      fontScale: 1,
      fontError: null,
      accent: "citrus",
      accentError: null,
      contrast: "low",
      contrastError: null,
      density: "default",
      densityError: null,
    });
    expect(b.root.dataset.colorMode).toBe(app.snapshot().mode);
    expect(b.meta.setAttribute).toHaveBeenLastCalledWith(
      "content",
      mode === "dark" ? "#11181d" : "#e7f0ef",
    );
    app.dispose();
  },
);

it("persists a choice, applies the document, notifies, and restores on a new lifetime", () => {
  const b = browser();
  const app = createAppearance(b.host);
  const changed = vi.fn();
  const unsubscribe = app.subscribe(changed);
  app.setMode("dark");
  expect(b.storage.setItem).toHaveBeenCalledWith(APPEARANCE_KEY, "dark");
  expect(b.root.dataset.colorMode).toBe("dark");
  expect(b.meta.setAttribute).toHaveBeenLastCalledWith("content", "#11181d");
  expect(changed).toHaveBeenCalledOnce();
  unsubscribe();
  app.setMode("light");
  expect(changed).toHaveBeenCalledOnce();
  app.dispose();
  const next = createAppearance(b.host);
  expect(next.snapshot().mode).toBe("light");
  next.dispose();
});

it("suppresses transitions until two frames after the latest palette change", () => {
  const b = browser();
  const app = createAppearance(b.host);
  expect(b.root.dataset.paletteChanging).toBeUndefined();
  app.setMode("dark");
  expect(b.root.dataset.paletteChanging).toBe("");
  b.frame();
  app.setAccent("cobalt");
  b.frame();
  expect(b.root.dataset.paletteChanging).toBe("");
  b.frame();
  expect(b.root.dataset.paletteChanging).toBeUndefined();
  app.dispose();
});

it("denied reads do not crash either startup path; writes can fail visibly and retry", () => {
  const b = browser();
  b.storage.getItem.mockImplementation(() => {
    throw new Error("denied");
  });
  runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
    get localStorage() {
      throw new Error("denied");
    },
    document: b.host.document,
  });
  expect(b.root.dataset.colorMode).toBe("light");
  const app = createAppearance(b.host);
  expect(app.snapshot().error).toContain("could not be restored");
  b.storage.setItem.mockImplementationOnce(() => {
    throw new Error("full");
  });
  app.setMode("dark");
  expect(app.snapshot().error).toContain("could not be saved");
  expect(b.root.dataset.colorMode).toBe("dark");
  expect(b.values.has(APPEARANCE_KEY)).toBe(false);
  app.setMode("dark");
  expect(app.snapshot().error).toBeNull();
  expect(b.values.get(APPEARANCE_KEY)).toBe("dark");
  app.dispose();
});

it("cross-window updates re-read current storage, ignore other stores, and dispose", () => {
  const b = browser();
  const app = createAppearance(b.host);
  b.values.set(APPEARANCE_KEY, "dark");
  b.change("another-key");
  b.change(APPEARANCE_KEY, {});
  expect(app.snapshot().mode).toBe("light");
  b.change();
  expect(app.snapshot().mode).toBe("dark");
  expect(b.storage.setItem).not.toHaveBeenCalled();
  b.values.clear();
  b.change(null);
  expect(app.snapshot().mode).toBe("light");
  app.dispose();
  app.dispose();
  expect(b.listeners.size).toBe(0);
  app.setMode("dark");
  expect(app.snapshot().mode).toBe("light");
});

it("System follows computer changes, manual choices override it, and disposal stops updates", () => {
  const b = browser();
  const app = createAppearance(b.host);
  const changed = vi.fn();
  app.subscribe(changed);
  app.setMode("system");
  expect(b.values.get(APPEARANCE_KEY)).toBe("system");
  expect(app.snapshot().preference).toBe("system");
  expect(app.snapshot().mode).toBe("light");
  b.systemDark(true);
  expect(app.snapshot().mode).toBe("dark");
  expect(b.root.dataset.colorMode).toBe("dark");
  expect(b.meta.setAttribute).toHaveBeenLastCalledWith("content", "#11181d");
  expect(changed).toHaveBeenCalledTimes(2);
  app.setMode("light");
  b.systemDark(false);
  b.systemDark(true);
  expect(app.snapshot().mode).toBe("light");
  expect(changed).toHaveBeenCalledTimes(3);
  b.values.set(APPEARANCE_KEY, "system");
  b.change();
  expect(app.snapshot().mode).toBe("dark");
  app.dispose();
  expect(b.schemeListeners.size).toBe(0);
  b.systemDark(false);
  expect(app.snapshot().mode).toBe("dark");
});

it("rejects an invalid runtime write without saving it", () => {
  const b = browser("dark");
  const app = createAppearance(b.host);
  // External JS callers do not have TypeScript's union guarantee.
  app.setMode("unknown" as "light");
  expect(app.snapshot().mode).toBe("dark");
  expect(b.storage.setItem).not.toHaveBeenCalled();
  app.dispose();
});

it.each([
  null,
  "",
  "garbage",
  "0",
  "Infinity",
  "0.7",
  "2.1",
  "1.3",
  "2",
  "0.8",
])("bootstrap and font preference agree for %j", (value) => {
  const b = browser("dark");
  if (value !== null) b.values.set(FONT_SCALE_KEY, value);
  runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
    localStorage: b.storage,
    document: b.host.document,
  });
  expect(b.root.style.setProperty).toHaveBeenLastCalledWith(
    "--buzz-text-scale",
    String(parseFontScale(value)),
  );
  const app = createAppearance(b.host);
  expect(app.snapshot().fontScale).toBe(parseFontScale(value));
  expect(app.snapshot().mode).toBe("dark");
  app.dispose();
});
it("font writes clamp, round, recover from failure, sync and preserve color storage", () => {
  const b = browser("dark");
  const app = createAppearance(b.host);
  app.setFontScale(1.1 + 0.1);
  expect(b.values.get(FONT_SCALE_KEY)).toBe("1.2");
  expect(b.values.get(APPEARANCE_KEY)).toBe("dark");
  app.setFontScale(100);
  expect(app.snapshot().fontScale).toBe(2);
  app.setFontScale(0);
  expect(app.snapshot().fontScale).toBe(0.8);
  app.setFontScale(NaN);
  expect(app.snapshot().fontScale).toBe(0.8);
  b.storage.setItem.mockImplementationOnce(() => {
    throw new Error("full");
  });
  app.setFontScale(1.4);
  expect(app.snapshot().fontError).toContain("could not be saved");
  expect(b.root.style.setProperty).toHaveBeenLastCalledWith(
    "--buzz-text-scale",
    "1.4",
  );
  app.setFontScale(1.4);
  expect(app.snapshot().fontError).toBeNull();
  b.values.set(FONT_SCALE_KEY, "1.6");
  b.change(FONT_SCALE_KEY);
  expect(app.snapshot().fontScale).toBe(1.6);
  b.values.delete(FONT_SCALE_KEY);
  b.change(null);
  expect(app.snapshot().fontScale).toBe(1);
  app.dispose();
  app.setFontScale(2);
  expect(app.snapshot().fontScale).toBe(1);
});

it.each<[string, string | null, string]>([
  ...ACCENTS.map((color): [string, null, string] => [color, null, color]),
  ["chartreuse", null, "citrus"],
  ["lime", null, "citrus"],
  ["invalid", null, "citrus"],
  ["citron", null, "citrus"],
  ["gray", null, "mono"],
  ["pear", null, "citrus"],
  ["jade", null, "citrus"],
  ["flame", null, "bee"],
  ["purple", null, "citrus"],
  ["neutral", null, "citrus"],
  // The saved accent wins over the former bubble color.
  ["iris", "blue", "iris"],
])(
  "restores accent %s (bubble %s) as %s before and after startup",
  (value, bubble, expected) => {
    const b = browser();
    b.values.set(ACCENT_KEY, value);
    if (bubble) b.values.set(LEGACY_BUBBLE_KEY, bubble);
    runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
      localStorage: b.storage,
      document: b.host.document,
      matchMedia: b.host.matchMedia,
    });
    const initial = b.root.dataset.accent;
    const app = createAppearance(b.host);
    expect(initial).toBe(expected);
    expect(app.snapshot().accent).toBe(expected);
    expect(b.root.dataset.accent).toBe(initial);
    app.dispose();
  },
);
it.each<[string | null, string]>([
  [null, "citrus"],
  ["blue", "cobalt"],
  ["cyan", "cobalt"],
  ["indigo", "cobalt"],
  ["green", "citrus"],
  ["orange", "bee"],
  ["pink", "magenta"],
  ["red", "magenta"],
  ["lilac", "iris"],
  ["purple", "iris"],
  // The former "Default" bubble now means the new default accent.
  ["neutral", "citrus"],
  ["#ffffff", "citrus"],
])("carries a former bubble color %s over as accent %s", (bubble, expected) => {
  const b = browser();
  if (bubble) b.values.set(LEGACY_BUBBLE_KEY, bubble);
  runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
    localStorage: b.storage,
    document: b.host.document,
    matchMedia: b.host.matchMedia,
  });
  const initial = b.root.dataset.accent;
  const app = createAppearance(b.host);
  expect(initial).toBe(expected);
  expect(app.snapshot().accent).toBe(expected);
  app.dispose();
});
it("saves the accent, recovers from denied storage, synchronizes reset, and disposes", () => {
  const b = browser();
  const app = createAppearance(b.host);
  b.storage.setItem.mockImplementationOnce(() => {
    throw new Error("denied");
  });
  app.setAccent("cobalt");
  expect(b.root.dataset.accent).toBe("cobalt");
  expect(app.snapshot().accentError).not.toBeNull();
  app.setAccent("cobalt");
  expect(b.values.get(ACCENT_KEY)).toBe("cobalt");
  expect(app.snapshot().accentError).toBeNull();
  b.values.set(ACCENT_KEY, "iris");
  b.change(ACCENT_KEY);
  expect(app.snapshot().accent).toBe("iris");
  b.values.delete(ACCENT_KEY);
  b.change(null);
  expect(app.snapshot().accent).toBe("citrus");
  app.dispose();
  app.setAccent("magenta");
  expect(b.root.dataset.accent).toBe("citrus");
});

it.each(["neutral", "touch", "more", "full"])(
  "ignores retired vibe preference %s before and after startup",
  (level) => {
    const b = browser();
    b.values.set("buzz-color-level.v1", level);
    b.values.set(ACCENT_KEY, "cobalt");
    runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
      localStorage: b.storage,
      document: b.host.document,
      matchMedia: b.host.matchMedia,
    });
    expect(b.root.dataset.colorLevel).toBe("touch");
    const app = createAppearance(b.host);
    expect(b.root.dataset.colorLevel).toBe("touch");
    expect(app.snapshot().accent).toBe("cobalt");
    b.change("buzz-color-level.v1");
    expect(b.root.dataset.colorLevel).toBe("touch");
    app.dispose();
  },
);

it.each(["quiet", "low", "high"] as const)(
  "restores %s contrast before paint and after startup",
  (contrast) => {
    const b = browser();
    b.values.set("buzz-contrast.v1", contrast);
    runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
      localStorage: b.storage,
      document: b.host.document,
      matchMedia: b.host.matchMedia,
    });
    expect(b.root.dataset.colorLevel).toBe(
      contrast === "high" ? "high" : "touch",
    );
    const app = createAppearance(b.host);
    expect(app.snapshot().contrast).toBe(contrast === "high" ? "high" : "low");
    app.dispose();
  },
);

it("keeps contrast active on storage failure, retries, and follows other windows", () => {
  const b = browser();
  const app = createAppearance(b.host);
  b.storage.setItem.mockImplementationOnce(() => {
    throw new Error("denied");
  });
  app.setContrast("high");
  expect(b.root.dataset.colorLevel).toBe("high");
  expect(app.snapshot().contrastError).not.toBeNull();
  app.setContrast("high");
  expect(b.values.get("buzz-contrast.v1")).toBe("high");
  expect(app.snapshot().contrastError).toBeNull();
  b.values.set("buzz-contrast.v1", "low");
  b.change("buzz-contrast.v1");
  expect(app.snapshot().contrast).toBe("low");
  app.dispose();
  app.setContrast("high");
  expect(b.root.dataset.colorLevel).toBe("touch");
});

it.each([null, "narrow", "wide", "invalid"])(
  "bootstraps and restores message width %j consistently",
  (saved) => {
    const b = browser();
    if (saved !== null) b.values.set(MESSAGE_WIDTH_KEY, saved);
    runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
      localStorage: b.storage,
      document: b.host.document,
    });
    const measure = saved === "wide" ? "78rem" : "52rem";
    expect(b.root.style.setProperty).toHaveBeenCalledWith(
      "--buzz-message-width",
      measure,
    );
    b.root.style.setProperty.mockClear();
    const app = createAppearance(b.host);
    expect(app.snapshot().messageWidth).toBe(
      saved === "wide" ? "wide" : "narrow",
    );
    expect(b.root.style.setProperty).toHaveBeenCalledWith(
      "--buzz-message-width",
      measure,
    );
    app.dispose();
  },
);

it("applies message width immediately, persists it, and follows storage changes", () => {
  const b = browser();
  const app = createAppearance(b.host);
  app.setMessageWidth("wide");
  expect(b.values.get(MESSAGE_WIDTH_KEY)).toBe("wide");
  expect(b.root.style.setProperty).toHaveBeenCalledWith(
    "--buzz-message-width",
    "78rem",
  );
  app.dispose();
  const restored = createAppearance(b.host);
  expect(restored.snapshot().messageWidth).toBe("wide");
  b.values.set(MESSAGE_WIDTH_KEY, "narrow");
  b.change(MESSAGE_WIDTH_KEY);
  expect(restored.snapshot().messageWidth).toBe("narrow");
  b.values.set(MESSAGE_WIDTH_KEY, "wide");
  b.change(MESSAGE_WIDTH_KEY);
  b.values.clear();
  b.change(null);
  expect(restored.snapshot().messageWidth).toBe("narrow");
  restored.dispose();
});

it("keeps message width active when saving fails and clears the error on retry", () => {
  const b = browser();
  const app = createAppearance(b.host);
  b.storage.setItem.mockImplementationOnce(() => {
    throw new Error("denied");
  });
  app.setMessageWidth("wide");
  expect(app.snapshot().messageWidth).toBe("wide");
  expect(app.snapshot().messageWidthError).toContain("could not be saved");
  expect(b.root.style.setProperty).toHaveBeenCalledWith(
    "--buzz-message-width",
    "78rem",
  );
  app.setMessageWidth("wide");
  expect(app.snapshot().messageWidthError).toBeNull();
  expect(b.values.get(MESSAGE_WIDTH_KEY)).toBe("wide");
  app.dispose();
});

it.each([
  [null, "default"],
  ["", "default"],
  ["COMPACT", "default"],
  ["default", "default"],
  ["compact", "compact"],
] as const)(
  "bootstrap and service agree on stored density %j",
  (stored, density) => {
    const b = browser();
    if (stored !== null) b.values.set("buzz-message-density.v1", stored);
    runInNewContext(readFileSync("public/appearance-init.js", "utf8"), {
      localStorage: b.storage,
      document: b.host.document,
      matchMedia: b.host.matchMedia,
    });
    expect(b.root.dataset.messageDensity).toBe(density);
    const app = createAppearance(b.host);
    expect(app.snapshot().density).toBe(density);
    expect(b.root.dataset.messageDensity).toBe(density);
    app.dispose();
  },
);

it("keeps density active on storage failure, retries, and follows other windows", () => {
  const b = browser();
  const app = createAppearance(b.host);
  b.storage.setItem.mockImplementationOnce(() => {
    throw new Error("denied");
  });
  app.setDensity("compact");
  expect(b.root.dataset.messageDensity).toBe("compact");
  expect(app.snapshot().densityError).not.toBeNull();
  app.setDensity("compact");
  expect(b.values.get("buzz-message-density.v1")).toBe("compact");
  expect(app.snapshot().densityError).toBeNull();
  b.values.set("buzz-message-density.v1", "default");
  b.change("buzz-message-density.v1");
  expect(b.root.dataset.messageDensity).toBe("default");
  app.dispose();
  app.setDensity("compact");
  expect(b.root.dataset.messageDensity).toBe("default");
});
