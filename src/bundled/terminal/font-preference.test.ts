// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  createTerminalFontPreference,
  parseFontFamily,
  parseFontSize,
  TERMINAL_FONT_KEY,
} from "./font-preference";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("bounds font sizes and defaults malformed saved sizes", () => {
  for (const size of [8, 12, 17.5, 32]) expect(parseFontSize(size)).toBe(size);
  for (const size of [null, "16", NaN, Infinity, 0, 7.9, 32.1])
    expect(parseFontSize(size)).toBeNull();
  for (const raw of ['{"family":"MesloLGS NF","size":100}', "{broken"]) {
    localStorage.setItem(TERMINAL_FONT_KEY, raw);
    const font = createTerminalFontPreference();
    expect(font.snapshot().size).toBe(12);
    font.dispose();
  }
});

it("saves family and size together, retains size on a family change, and resets both", () => {
  const font = createTerminalFontPreference();
  font.set(null, 17.5);
  expect(JSON.parse(localStorage.getItem(TERMINAL_FONT_KEY) ?? "null")).toEqual(
    {
      family: null,
      size: 17.5,
    },
  );
  font.set("MesloLGS NF");
  const restored = createTerminalFontPreference();
  expect(restored.snapshot()).toEqual({
    family: "MesloLGS NF",
    size: 17.5,
    error: null,
  });
  expect(() => font.set("Other", 100)).toThrow("Invalid font size");
  expect(font.snapshot().size).toBe(17.5);
  font.reset();
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: TERMINAL_FONT_KEY,
      storageArea: localStorage,
    }),
  );
  expect(restored.snapshot()).toEqual({ family: null, size: 12, error: null });
  font.dispose();
  restored.dispose();
});

it("retries a failed read without deleting either saved choice", () => {
  localStorage.setItem(
    TERMINAL_FONT_KEY,
    JSON.stringify({ family: "MesloLGS NF", size: 18 }),
  );
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  const restored = createTerminalFontPreference();
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  restored.retry();
  expect(remove).not.toHaveBeenCalled();
  read.mockRestore();
  restored.retry();
  expect(restored.snapshot()).toEqual({
    family: "MesloLGS NF",
    size: 18,
    error: null,
  });
  restored.dispose();
});

it("accepts a trimmed family name and rejects stacks, paths and CSS syntax", () => {
  expect(parseFontFamily("  JetBrainsMono Nerd Font Mono  ")).toBe(
    "JetBrainsMono Nerd Font Mono",
  );
  expect(parseFontFamily("日本語 Mono")).toBe("日本語 Mono");
  expect(parseFontFamily("a".repeat(64))).toBe("a".repeat(64));
  for (const value of [
    null,
    42,
    "",
    " ",
    "a".repeat(65),
    "A,B",
    '"A"',
    "A'B",
    "A;B",
    "A{B}",
    "A(B)",
    "A\\B",
    "A:B",
    "A/B",
    "<A>",
    "A\n",
    "A\x7f",
  ])
    expect(parseFontFamily(value)).toBeNull();
});

it("defaults, restores valid values, and ignores invalid stored values", () => {
  const empty = createTerminalFontPreference();
  expect(empty.snapshot()).toEqual({ family: null, size: 12, error: null });
  empty.dispose();
  localStorage.setItem(TERMINAL_FONT_KEY, "  MesloLGS NF  ");
  const restored = createTerminalFontPreference();
  expect(restored.snapshot().family).toBe("MesloLGS NF");
  expect(() => restored.set("A, B")).toThrow("Invalid font family");
  expect(restored.snapshot().family).toBe("MesloLGS NF");
  restored.dispose();
  localStorage.setItem(TERMINAL_FONT_KEY, "A, B");
  const invalid = createTerminalFontPreference();
  expect(invalid.snapshot()).toEqual({ family: null, size: 12, error: null });
  invalid.dispose();
});

it("reports restore failure and recovers by saving a choice", () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  const font = createTerminalFontPreference();
  expect(font.snapshot().family).toBeNull();
  expect(font.snapshot().error).toContain("could not be restored");
  read.mockRestore();
  font.set("MesloLGS NF");
  expect(font.snapshot().error).toBeNull();
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBe("MesloLGS NF");
  font.dispose();
});

it("applies in memory on save failure, retries, and resets even when removal fails", () => {
  const font = createTerminalFontPreference();
  const changed = vi.fn();
  const unsubscribe = font.subscribe(changed);
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Unavailable");
    });
  font.set(" MesloLGS NF ", 18);
  expect(font.snapshot()).toMatchObject({ family: "MesloLGS NF", size: 18 });
  expect(font.snapshot().error).toContain("could not be saved");
  expect(changed).toHaveBeenCalledTimes(1);
  write.mockRestore();
  font.retry();
  expect(font.snapshot().error).toBeNull();
  expect(JSON.parse(localStorage.getItem(TERMINAL_FONT_KEY) ?? "null")).toEqual(
    { family: "MesloLGS NF", size: 18 },
  );
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("Unavailable");
    });
  font.reset();
  expect(font.snapshot().family).toBeNull();
  expect(font.snapshot().error).toContain("could not be saved");
  expect(font.snapshot().error).toContain("may return after restarting");
  remove.mockRestore();
  font.retry();
  expect(font.snapshot().error).toBeNull();
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
  unsubscribe();
  const calls = changed.mock.calls.length;
  font.set("MesloLGS NF");
  expect(changed).toHaveBeenCalledTimes(calls);
  font.dispose();
});

it("re-reads current storage, ignores other areas and keys, and disposes its listeners", () => {
  const font = createTerminalFontPreference();
  const changed = vi.fn();
  font.subscribe(changed);
  localStorage.setItem(TERMINAL_FONT_KEY, "MesloLGS NF");
  const event = (key: string | null, storageArea = localStorage) =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        storageArea,
        newValue: "stale value",
      }),
    );
  event("unrelated");
  event(TERMINAL_FONT_KEY, sessionStorage);
  expect(changed).not.toHaveBeenCalled();
  event(TERMINAL_FONT_KEY);
  expect(font.snapshot().family).toBe("MesloLGS NF");
  localStorage.clear();
  event(null);
  expect(font.snapshot().family).toBeNull();
  font.dispose();
  font.set("Ignored");
  font.reset();
  font.retry();
  localStorage.setItem(TERMINAL_FONT_KEY, "Ignored");
  event(TERMINAL_FONT_KEY);
  font.subscribe(changed);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(font.snapshot().family).toBeNull();
});
