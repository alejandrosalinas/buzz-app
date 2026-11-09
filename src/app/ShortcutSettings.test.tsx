// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { isTauri } from "@tauri-apps/api/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ShortcutSettings } from "./ShortcutSettings";
import type { Shortcut } from "../features/shortcuts/bindings";
import {
  createShortcutBindings,
  SHORTCUT_BINDINGS_KEY,
} from "../features/shortcuts/preferences";
import { ShortcutsService } from "../features/shortcuts/service";
import type { PluginManager } from "../plugins/manager";
import type { PluginInfo } from "../plugins/types";
import { createAppearance } from "../shared/theme/service";
import { createNavigationController } from "../features/navigation/controller";
import { createMemoryHistory } from "../features/navigation/history";
import { registerAppShortcuts, registerNavigationShortcuts } from "./shortcuts";
import { PageSearch, type SearchServices } from "./shell/PageSearch";
import { setSendWithModEnterPreference } from "../features/messages/send-key-preference";
import { setEditWithUpArrowPreference } from "../features/messages/edit-key-preference";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setEditWithUpArrowPreference(false);
  setSendWithModEnterPreference(false);
  vi.mocked(isTauri).mockReturnValue(false);
  localStorage.clear();
});

const info = (id: string, name: string): PluginInfo => ({
  manifest: { id, name, apiVersion: 1 },
  source: "external",
  enabled: true,
  revision: "one",
  previous: null,
  reloadable: false,
  error: null,
});
const catalog = (
  plugins: PluginInfo[],
): Pick<PluginManager, "subscribe" | "snapshot"> => {
  const snapshot = {
    configuration: {
      status: "ready" as const,
      catalog: { profile: "", location: "", plugins },
      externalPluginsPaused: false,
    },
    activation: {},
    busy: false,
    error: null,
    refreshError: null,
  };
  return { subscribe: () => () => {}, snapshot: () => snapshot };
};

// jsdom reports an empty platform, so the real dispatcher on `window` treats
// Control as Mod; the page follows the same test unless told otherwise.
async function harness() {
  const root = new Context();
  const inactive = new Set<string>();
  const statusListeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: (id: string) => !inactive.has(id),
    subscribe: (listener: () => void) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const runs = {
    settings: vi.fn(),
    search: vi.fn(),
    grow: vi.fn(),
    increment: vi.fn(),
    terminal: vi.fn(),
  };
  shortcuts.registerHost({
    id: "settings",
    title: "Open Settings",
    binding: { key: ",", mod: true },
    order: 80,
    run: runs.settings,
  });
  shortcuts.registerHost({
    id: "global-search",
    title: "Search Buzz",
    binding: [
      { key: "k", mod: true },
      { key: "t", mod: true },
    ],
    order: 70,
    run: runs.search,
  });
  shortcuts.registerHost({
    id: "font-increase",
    title: "Increase interface size",
    binding: [
      { key: "=", mod: true },
      { key: "+", mod: true },
      { key: "=", mod: true, shift: true },
      { key: "+", mod: true, shift: true },
    ],
    order: 41,
    run: runs.grow,
  });
  const contribute = (id: string, shortcut: Shortcut) =>
    root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => {
        ctx.shortcuts.register(shortcut);
      })
      .await();
  await contribute("example.counter", {
    id: "increment",
    title: "Increment shortcut counter",
    binding: { key: "k", mod: true, shift: true },
    order: 10,
    run: runs.increment,
  });
  await contribute("example.counter", {
    id: "first",
    title: "First action",
    binding: { key: "l", mod: true, shift: true },
    order: -10,
    run: vi.fn(),
  });
  await contribute("buzz.terminal", {
    id: "toggle",
    title: "Toggle channel terminal",
    binding: { key: "j", mod: true },
    run: runs.terminal,
  });
  return {
    runs,
    bindings,
    shortcuts,
    contribute,
    plugins: catalog([
      info("example.counter", "Shortcut counter"),
      info("buzz.terminal", "Terminal"),
    ]),
    setActive(id: string, active: boolean) {
      if (active) inactive.delete(id);
      else inactive.add(id);
      for (const listener of statusListeners) listener();
    },
    /** Dispatch to the window listener from a non-editable target. */
    press: (key: string, init: KeyboardEventInit = {}) =>
      fireEvent.keyDown(document.body, { key, ctrlKey: true, ...init }),
    async dispose() {
      bindings.dispose();
      await root.fiber.dispose();
    },
  };
}
const row = (title: string) => screen.getByRole("article", { name: title });
/** Rebindable rows: everything outside the read-only Message formatting group. */
const appRows = () =>
  screen
    .getAllByRole("article")
    .filter(
      (article) =>
        article.closest("section")?.querySelector("h3")?.textContent !==
        "Message formatting",
    );
const change = (title: string) =>
  screen.getByRole("button", { name: `Change shortcut for ${title}` });
const capture = (title: string) =>
  screen.getByRole("textbox", { name: `New shortcut for ${title}` });

it("lists live host and plugin shortcuts without search or intro text and follows plugin state", async () => {
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
        apple
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Shortcuts", level: 2 }),
    ).toBeVisible();
    const groups = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(groups).toEqual([
      "Sending messages",
      "Editing messages",
      "Buzz",
      "Shortcut counter",
      "Terminal",
      "Message formatting",
    ]);
    expect(
      appRows().map(
        (article) =>
          within(article).getByRole("heading", { level: 4 }).textContent,
      ),
    ).toEqual([
      "Increase interface size",
      "Search Buzz",
      "Open Settings",
      "First action",
      "Increment shortcut counter",
      "Toggle channel terminal",
    ]);
    // One capsule shows the whole first alias; the label reads as words.
    const grow = row("Increase interface size");
    expect(within(grow).getByText("Command =")).toHaveClass("sr-only");
    expect(within(grow).getByText("⌘=")).toHaveAttribute("aria-hidden", "true");
    expect(grow.querySelector(".buzz-keyboard-shortcut")).toHaveAttribute(
      "data-binding",
      "⌘=",
    );
    // Layout aliases of one key (⌘= ⌘+ ⇧⌘= ⇧⌘+) show once.
    expect(grow.querySelectorAll(".buzz-keyboard-shortcut")).toHaveLength(1);
    // Distinct chords each show, in order.
    const search = row("Search Buzz");
    expect(
      [...search.querySelectorAll(".buzz-keyboard-shortcut")].map((chord) =>
        chord.getAttribute("data-binding"),
      ),
    ).toEqual(["⌘K", "⌘T"]);
    expect(within(search).getByText("or")).toBeInTheDocument();
    expect(
      within(row("Increment shortcut counter")).getByText("Shift Command K"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Modified")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset all shortcuts" }),
    ).toBeDisabled();

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Every shortcut from Buzz and your enabled plugins. Choose Change, then press the new keys; Escape cancels. Saved on this device.",
      ),
    ).not.toBeInTheDocument();

    act(() => h.setActive("buzz.terminal", false));
    expect(
      screen.queryByRole("heading", { name: "Terminal" }),
    ).not.toBeInTheDocument();
    expect(appRows()).toHaveLength(5);
    act(() => h.setActive("buzz.terminal", true));
    expect(row("Toggle channel terminal")).toBeInTheDocument();
  } finally {
    await h.dispose();
  }
});

it("presents actual host registrations in navigation, interface sizing, search/settings, then development order", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const appearance = createAppearance(window);
  const navigation = createNavigationController(createMemoryHistory());
  const removeApp = registerAppShortcuts(shortcuts, appearance, vi.fn(), true);
  const removeNavigation = registerNavigationShortcuts(
    shortcuts,
    navigation.navigation,
  );
  try {
    render(
      <>
        <PageSearch
          pages={[]}
          onSelect={vi.fn()}
          // Only shortcuts and bindings are read while Search is closed.
          services={
            {
              shortcuts,
              shortcutBindings: bindings,
            } as unknown as SearchServices
          }
        />
        <ShortcutSettings
          shortcuts={shortcuts}
          bindings={bindings}
          plugins={catalog([])}
        />
      </>,
    );
    expect(
      appRows().map(
        (article) =>
          within(article).getByRole("heading", { level: 4 }).textContent,
      ),
    ).toEqual([
      "Home",
      "Go back",
      "Go forward",
      "Increase interface size",
      "Decrease interface size",
      "Reset interface size",
      "Search Buzz",
      "Search this conversation",
      "Open Settings",
      "Show keyboard shortcuts",
      "Set a status",
      "Focus message box",
      "Focus next pane",
      "Edit selected message",
      "React to selected message",
      "React to latest message",
      "Reply in thread to selected message",
      "Mark unread from selected message",
      "Delete selected message",
      "Reload Buzz",
    ]);
  } finally {
    cleanup();
    removeNavigation();
    removeApp();
    navigation.dispose();
    appearance.dispose();
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("orders plugin rows by metadata then contribution key without merging duplicate titles", async () => {
  const h = await harness();
  try {
    await h.contribute("example.counter", {
      id: "aaa",
      title: "Increment shortcut counter",
      binding: { key: "l", mod: true },
      order: 10,
      run: vi.fn(),
    });
    await h.contribute("example.counter", {
      id: "zzz",
      title: "Zed action",
      binding: { key: "m", mod: true },
      order: 10,
      run: vi.fn(),
    });
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
    expect(
      appRows().map(
        (article) =>
          within(article).getByRole("heading", { level: 4 }).textContent,
      ),
    ).toEqual([
      "Increase interface size",
      "Search Buzz",
      "Open Settings",
      "First action",
      "Increment shortcut counter",
      "Increment shortcut counter",
      "Zed action",
      "Toggle channel terminal",
    ]);
    const duplicates = screen.getAllByRole("article", {
      name: "Increment shortcut counter",
    });
    const [firstDuplicate, secondDuplicate] = duplicates;
    if (!firstDuplicate || !secondDuplicate)
      throw new Error("Missing duplicate row");
    expect(within(firstDuplicate).getByText("Control L")).toBeInTheDocument();
    expect(
      within(secondDuplicate).getByText("Control Shift K"),
    ).toBeInTheDocument();
  } finally {
    await h.dispose();
  }
});

it("captures a chord, refuses conflicts and bare keys, applies overrides to the dispatcher, and resets", async () => {
  const user = userEvent.setup();
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
    const title = "Increment shortcut counter";
    expect(within(row(title)).getByText("Control Shift K")).toBeInTheDocument();
    await user.click(change(title));
    const input = capture(title);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Press a shortcut…");
    expect(input).toHaveAttribute("data-state", "listening");
    expect(input).toHaveAttribute("data-size", "sm");
    expect(
      screen.getByRole("button", { name: `Cancel changing ${title}` }),
    ).toBeInTheDocument();
    // IME, bare modifiers and unmodified keys never become bindings.
    fireEvent.keyDown(input, { key: "k", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: "k", ctrlKey: true, keyCode: 229 });
    fireEvent.keyDown(input, { key: "Control", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Shift", shiftKey: true });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(capture(title)).toBe(input);
    fireEvent.keyDown(input, { key: "k", shiftKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Include Control or Alt so ordinary typing keeps working.",
    );
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The Windows/Command key isn’t used for shortcuts on this device.",
    );
    // Dead and unidentified keys, and the chords copy, paste and select all need.
    fireEvent.keyDown(input, { key: "Dead", altKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That key can’t be used for a shortcut. Try another.",
    );
    fireEvent.keyDown(input, { key: "Unidentified", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That key can’t be used for a shortcut. Try another.",
    );
    for (const key of ["c", "v", "x", "a"]) {
      fireEvent.keyDown(input, { key, ctrlKey: true });
      expect(screen.getByRole("alert")).toHaveTextContent(
        `Ctrl+${key.toUpperCase()} is reserved for copy, cut, paste and select all. Try another.`,
      );
    }
    fireEvent.keyDown(input, { key: "V", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ctrl+Shift+V is reserved for copy, cut, paste and select all. Try another.",
    );
    // Conflicts are reported by title and owner; nothing is saved or fired.
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ctrl+K is already used by Search Buzz (Buzz).",
    );
    expect(screen.getByRole("alert")).toHaveClass("text-standard");
    expect(input).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining(screen.getByRole("alert").id),
    );
    fireEvent.keyDown(input, { key: "j", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ctrl+J is already used by Toggle channel terminal (Terminal).",
    );
    expect(h.runs.search).not.toHaveBeenCalled();
    expect(h.runs.terminal).not.toHaveBeenCalled();
    expect(h.bindings.snapshot().overrides).toEqual({});
    expect(capture(title)).toBe(input);

    await user.keyboard("{Control>}{Shift>}j{/Shift}{/Control}");
    expect(screen.queryByRole("textbox", { name: /New shortcut/ })).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(row(title)).getByText("Modified")).toBeInTheDocument();
    expect(within(row(title)).getByText("Control Shift J")).toBeInTheDocument();
    expect(change(title)).toHaveFocus();
    expect(h.bindings.snapshot().overrides).toEqual({
      "example.counter/increment": { key: "j", mod: true, shift: true },
    });
    expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBe(
      JSON.stringify({
        "example.counter/increment": { key: "j", mod: true, shift: true },
      }),
    );
    expect(h.press("k", { shiftKey: true })).toBe(true);
    expect(h.runs.increment).not.toHaveBeenCalled();
    expect(h.press("j", { shiftKey: true })).toBe(false);
    expect(h.runs.increment).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: `Reset shortcut for ${title}` }),
    );
    expect(within(row(title)).queryByText("Modified")).toBeNull();
    // Reset unmounts its own button; keyboard focus stays anchored in the row.
    expect(change(title)).toHaveFocus();
    expect(h.bindings.resolve("example.counter/increment")).toBeUndefined();
    h.press("k", { shiftKey: true });
    expect(h.runs.increment).toHaveBeenCalledTimes(2);

    // Escape cancels whatever else is held, as does blur; nothing is saved and
    // focus returns to the row action.
    for (const held of [
      {},
      { shiftKey: true },
      { ctrlKey: true },
      { metaKey: true, altKey: true },
    ]) {
      await user.click(change("Open Settings"));
      fireEvent.keyDown(capture("Open Settings"), { key: "Escape", ...held });
      expect(
        screen.queryByRole("textbox", { name: /New shortcut/ }),
      ).toBeNull();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(change("Open Settings")).toHaveFocus();
    }
    await user.click(change("Open Settings"));
    await user.click(document.body);
    expect(screen.queryByRole("textbox", { name: /New shortcut/ })).toBeNull();
    expect(h.bindings.snapshot().overrides).toEqual({});

    // Editor-local chords save with a warning; the freed chord becomes usable.
    await user.click(change("Open Settings"));
    fireEvent.keyDown(capture("Open Settings"), { key: "z", ctrlKey: true });
    const warning = within(row("Open Settings")).getByRole("alert");
    expect(warning).toHaveTextContent("message editor handles Ctrl+Z");
    expect(warning).toHaveClass("text-standard");
    expect(h.bindings.resolve("settings")).toEqual([{ key: "z", mod: true }]);
    for (const [key, chord] of [
      ["y", "Ctrl+Shift+Y"],
      ["End", "Ctrl+Shift+End"],
    ] as const) {
      await user.click(change("Open Settings"));
      fireEvent.keyDown(capture("Open Settings"), {
        key,
        ctrlKey: true,
        shiftKey: true,
      });
      expect(within(row("Open Settings")).getByRole("alert")).toHaveTextContent(
        `message editor handles ${chord}`,
      );
    }
    await user.click(change("Toggle channel terminal"));
    fireEvent.keyDown(capture("Toggle channel terminal"), {
      key: ",",
      ctrlKey: true,
    });
    expect(
      within(row("Toggle channel terminal")).getByText("Modified"),
    ).toBeInTheDocument();
    h.press(",");
    expect(h.runs.terminal).toHaveBeenCalledTimes(1);
    expect(h.runs.settings).not.toHaveBeenCalled();
    // Choosing a shortcut's own default clears its override instead.
    await user.click(change("Toggle channel terminal"));
    fireEvent.keyDown(capture("Toggle channel terminal"), {
      key: "j",
      ctrlKey: true,
    });
    expect(within(row("Toggle channel terminal")).queryByText("Modified")).toBe(
      null,
    );
    expect(h.bindings.resolve("buzz.terminal/toggle")).toBeUndefined();

    // Rebinding an alias set replaces the whole set; reset restores it.
    await user.click(change("Increase interface size"));
    fireEvent.keyDown(capture("Increase interface size"), {
      key: "=",
      ctrlKey: true,
      altKey: true,
    });
    expect(
      within(row("Increase interface size")).getByText("Control Alt ="),
    ).toBeInTheDocument();
    h.press("=");
    h.press("+", { shiftKey: true });
    expect(h.runs.grow).not.toHaveBeenCalled();
    h.press("=", { altKey: true });
    expect(h.runs.grow).toHaveBeenCalledTimes(1);
    const resetAll = screen.getByRole("button", {
      name: "Reset all shortcuts",
    });
    expect(resetAll).toBeEnabled();
    await user.click(resetAll);
    expect(screen.queryByText("Modified")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(resetAll).toBeDisabled();
    expect(h.bindings.snapshot().overrides).toEqual({});
    expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBeNull();
    h.press("+", { shiftKey: true });
    expect(h.runs.grow).toHaveBeenCalledTimes(2);
    h.press(",");
    expect(h.runs.settings).toHaveBeenCalledTimes(1);
  } finally {
    await h.dispose();
  }
});

it.each([true, false])(
  "warns for every accepted Enter modifier combination but still dispatches outside the editor (Apple=%s)",
  async (apple) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(
      apple ? "MacIntel" : "Win32",
    );
    const user = userEvent.setup();
    const h = await harness();
    try {
      render(
        <ShortcutSettings
          shortcuts={h.shortcuts}
          bindings={h.bindings}
          plugins={h.plugins}
          apple={apple}
        />,
      );
      const title = "Open Settings";
      await user.click(change(title));
      for (const shiftKey of [false, true]) {
        fireEvent.keyDown(capture(title), { key: "Enter", shiftKey });
        expect(screen.getByRole("alert")).toHaveTextContent("Include");
        expect(h.bindings.resolve("settings")).toBeUndefined();
      }
      let dispatched = 0;
      for (const modifiers of [
        { mod: true },
        { mod: true, shift: true },
        { alt: true },
        { alt: true, shift: true },
        { mod: true, alt: true },
        { mod: true, alt: true, shift: true },
      ]) {
        if (dispatched) await user.click(change(title));
        const event = {
          key: "Enter",
          ctrlKey: !apple && !!modifiers.mod,
          metaKey: apple && !!modifiers.mod,
          altKey: !!modifiers.alt,
          shiftKey: !!modifiers.shift,
        };
        fireEvent.keyDown(capture(title), event);
        expect(within(row(title)).getByRole("alert")).toHaveTextContent(
          "Saved. The message editor handles",
        );
        expect(within(row(title)).getByRole("alert")).toHaveClass(
          "text-standard",
        );
        expect(h.bindings.resolve("settings")).toEqual([
          { key: "Enter", ...modifiers },
        ]);
        expect(change(title)).toHaveFocus();
        expect(h.runs.settings).toHaveBeenCalledTimes(dispatched);
        expect(fireEvent.keyDown(document.body, event)).toBe(false);
        expect(h.runs.settings).toHaveBeenCalledTimes(++dispatched);
      }
    } finally {
      await h.dispose();
    }
  },
);

it("records Control beside Command on Apple platforms, saves it and dispatches it", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const user = userEvent.setup();
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
        apple
      />,
    );
    const title = "Open Settings";
    await user.click(change(title));
    fireEvent.keyDown(capture(title), { key: "a", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Include Command or Option so ordinary typing keeps working.",
    );
    // ⌥⇧⌘V is the browser plain paste; Option makes the key ◊ on Apple layouts.
    fireEvent.keyDown(capture(title), {
      key: "◊",
      code: "KeyV",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "is reserved for copy, cut, paste and select all. Try another.",
    );
    expect(h.bindings.resolve("settings")).toBeUndefined();
    const chord = { key: "u", ctrlKey: true, metaKey: true };
    fireEvent.keyDown(capture(title), chord);
    expect(h.bindings.resolve("settings")).toEqual([
      { key: "u", mod: true, ctrl: true },
    ]);
    expect(
      JSON.parse(localStorage.getItem(SHORTCUT_BINDINGS_KEY) ?? "null"),
    ).toEqual({ settings: { key: "u", mod: true, ctrl: true } });
    expect(
      within(row(title)).getByText("Control Command U"),
    ).toBeInTheDocument();
    expect(fireEvent.keyDown(document.body, { key: "u", metaKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(document.body, chord)).toBe(false);
    expect(h.runs.settings).toHaveBeenCalledOnce();
  } finally {
    await h.dispose();
  }
});

it("ignores AltGraph capture without changing a saved override, then captures and dispatches a non-AltGraph chord", async () => {
  const user = userEvent.setup();
  const h = await harness();
  try {
    h.bindings.set("settings", { key: "u", mod: true });
    const saved = localStorage.getItem(SHORTCUT_BINDINGS_KEY);
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
    const title = "Open Settings";
    await user.click(change(title));
    const input = capture(title);
    // Windows German AltGr+Q reports @ with Control and Alt held.
    const chord = { key: "@", ctrlKey: true, altKey: true };
    const altGraph = () =>
      new KeyboardEvent("keydown", {
        ...chord,
        modifierAltGraph: true,
        bubbles: true,
        cancelable: true,
      });
    const event = altGraph();
    expect(event.getModifierState("AltGraph")).toBe(true);
    fireEvent(input, event);
    expect(capture(title)).toBe(input);
    expect(input).toHaveFocus();
    expect(h.bindings.resolve("settings")).toEqual([{ key: "u", mod: true }]);
    expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBe(saved);
    expect(h.runs.settings).not.toHaveBeenCalled();

    // Control+Alt is still usable when the event is not AltGraph.
    fireEvent.keyDown(input, chord);
    expect(change(title)).toHaveFocus();
    expect(h.bindings.resolve("settings")).toEqual([
      { key: "@", mod: true, alt: true },
    ]);
    expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBe(
      JSON.stringify({ settings: { key: "@", mod: true, alt: true } }),
    );
    // The original dispatcher safety guard must still ignore AltGraph even
    // when its key and modifier flags match a valid saved override exactly.
    expect(fireEvent(document.body, altGraph())).toBe(true);
    expect(h.press("u")).toBe(true);
    expect(h.runs.settings).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(document.body, chord)).toBe(false);
    expect(h.runs.settings).toHaveBeenCalledTimes(1);
  } finally {
    await h.dispose();
  }
});

it("keeps a change active when saving fails and offers a retry", async () => {
  const user = userEvent.setup();
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    await user.click(change("Toggle channel terminal"));
    fireEvent.keyDown(capture("Toggle channel terminal"), {
      key: "u",
      ctrlKey: true,
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("could not be saved on this device");
    expect(alert).toHaveClass("text-standard");
    expect(
      within(row("Toggle channel terminal")).getByText("Modified"),
    ).toBeInTheDocument();
    h.press("u");
    expect(h.runs.terminal).toHaveBeenCalledTimes(1);
    write.mockRestore();
    await user.click(
      within(alert).getByRole("button", { name: "Retry saving shortcuts" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem(SHORTCUT_BINDINGS_KEY)).toBe(
      JSON.stringify({ "buzz.terminal/toggle": { key: "u", mod: true } }),
    );
  } finally {
    await h.dispose();
  }
});

it("stores Option and Shift chords as the composed key on Apple platforms (known limitation)", async () => {
  const user = userEvent.setup();
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
        apple
      />,
    );
    // macOS reports the composed character for Option chords: Option+K is "˚".
    // Capture and dispatch both read event.key, so the chord fires but is
    // layout-dependent and displays as the composed character.
    const terminal = "Toggle channel terminal";
    await user.click(change(terminal));
    fireEvent.keyDown(capture(terminal), { key: "˚", altKey: true });
    expect(within(row(terminal)).getByText("Option ˚")).toBeInTheDocument();
    expect(
      row(terminal).querySelector(".buzz-keyboard-shortcut"),
    ).toHaveAttribute("data-binding", "⌥˚");
    expect(h.bindings.resolve("buzz.terminal/toggle")).toEqual([
      { key: "˚", alt: true },
    ]);
    expect(fireEvent.keyDown(document.body, { key: "˚", altKey: true })).toBe(
      false,
    );
    expect(h.runs.terminal).toHaveBeenCalledTimes(1);
    // Shift+digit likewise stores the punctuation the layout produced.
    const settings = "Open Settings";
    await user.click(change(settings));
    fireEvent.keyDown(capture(settings), {
      key: "!",
      metaKey: true,
      shiftKey: true,
    });
    expect(
      within(row(settings)).getByText("Shift Command !"),
    ).toBeInTheDocument();
    expect(h.bindings.resolve("settings")).toEqual([
      { key: "!", mod: true, shift: true },
    ]);
    expect(h.press("!", { shiftKey: true })).toBe(false);
    expect(h.runs.settings).toHaveBeenCalledTimes(1);
  } finally {
    await h.dispose();
  }
});

it("refuses close and quit chords only in the desktop build", async () => {
  const user = userEvent.setup();
  const h = await harness();
  try {
    const desktop = render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
        apple
        desktop
      />,
    );
    const title = "Open Settings";
    await user.click(change(title));
    for (const key of ["q", "w"]) {
      fireEvent.keyDown(capture(title), { key, metaKey: true });
      expect(screen.getByRole("alert")).toHaveTextContent(
        `⌘${key.toUpperCase()} is reserved for switching or closing tabs and quitting Buzz. Try another.`,
      );
    }
    expect(h.bindings.snapshot().overrides).toEqual({});
    desktop.unmount();
    // A browser tab handles these before the page sees them, so nothing is lost.
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
        apple
      />,
    );
    await user.click(change(title));
    fireEvent.keyDown(capture(title), { key: "w", metaKey: true });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(row(title)).getByText("Command W")).toBeInTheDocument();
  } finally {
    await h.dispose();
  }
});

it("marks rows that share an effective chord once a plugin is re-enabled, and clears the marker on reset", async () => {
  const user = userEvent.setup();
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
    const counter = "Increment shortcut counter";
    const terminal = "Toggle channel terminal";
    expect(screen.queryByText(/Also used by/)).toBeNull();
    // With the terminal disabled its chord is not listed, so Ctrl+J is accepted.
    act(() => h.setActive("buzz.terminal", false));
    await user.click(change(counter));
    fireEvent.keyDown(capture(counter), { key: "j", ctrlKey: true });
    expect(within(row(counter)).getByText("Control J")).toBeInTheDocument();
    expect(screen.queryByText(/Also used by/)).toBeNull();
    // Re-enabling brings the default back; the dispatcher would pick one silently.
    act(() => h.setActive("buzz.terminal", true));
    const marker = within(row(counter)).getByText(
      "Also used by Toggle channel terminal (Terminal)",
    );
    expect(marker).toHaveClass("text-subtle");
    expect(marker).not.toHaveClass("text-danger");
    expect(marker).not.toHaveClass("text-warning");
    expect(marker).not.toHaveAttribute("role");
    expect(
      within(row(terminal)).getByText(
        "Also used by Increment shortcut counter (Shortcut counter)",
      ),
    ).toBeInTheDocument();
    h.press("j");
    expect(h.runs.terminal).toHaveBeenCalledTimes(1);
    expect(h.runs.increment).not.toHaveBeenCalled();
    // A host chord shared with a plugin is marked on both rows as well.
    act(() => h.bindings.set("global-search", { key: "j", mod: true }));
    expect(
      within(row("Search Buzz")).getByText(/^Also used by/),
    ).toHaveTextContent(
      "Also used by Increment shortcut counter (Shortcut counter), Toggle channel terminal (Terminal)",
    );
    act(() => h.bindings.set("global-search", null));
    expect(within(row("Search Buzz")).queryByText(/Also used by/)).toBeNull();
    await user.click(
      screen.getByRole("button", { name: `Reset shortcut for ${counter}` }),
    );
    expect(screen.queryByText(/Also used by/)).toBeNull();
    expect(change(counter)).toHaveFocus();
  } finally {
    await h.dispose();
  }
});

it("keeps the host group distinct from a plugin whose manifest id is buzz", async () => {
  const h = await harness();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await h.contribute("buzz", {
      id: "ping",
      title: "Ping",
      binding: { key: "p", mod: true },
      run: vi.fn(),
    });
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={catalog([
          info("example.counter", "Shortcut counter"),
          info("buzz.terminal", "Terminal"),
          info("buzz", "Buzz plugin"),
        ])}
        apple
      />,
    );
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Sending messages",
      "Editing messages",
      "Buzz",
      "Buzz plugin",
      "Shortcut counter",
      "Terminal",
      "Message formatting",
    ]);
    expect(row("Ping")).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
    await h.dispose();
  }
});

it.each([false, true])(
  "Tab leaves capture without saving (backwards=%s)",
  async (shift) => {
    const h = await harness();
    const user = userEvent.setup();
    try {
      const run = vi.fn();
      await h.contribute("example.tab", {
        id: "tab",
        title: "Plugin Tab",
        binding: { key: "Tab", shift },
        allowInEditable: true,
        run,
      });
      render(
        <ShortcutSettings
          shortcuts={h.shortcuts}
          bindings={h.bindings}
          plugins={h.plugins}
        />,
      );
      await user.click(change("Open Settings"));
      expect(capture("Open Settings")).toHaveAccessibleDescription(
        /Press Escape to cancel, or Tab to leave/,
      );
      await user.tab({ shift });
      expect(
        screen.queryByRole("textbox", { name: /New shortcut/ }),
      ).toBeNull();
      expect(h.bindings.snapshot().overrides).toEqual({});
      expect(h.runs.settings).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(document.body);
    } finally {
      await h.dispose();
    }
  },
);

it("shows desktop Close as reserved and read-only while other actions remain editable", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const appearance = createAppearance(window);
  const remove = registerAppShortcuts(shortcuts, appearance, vi.fn(), true);
  try {
    render(
      <ShortcutSettings
        shortcuts={shortcuts}
        bindings={bindings}
        plugins={catalog([])}
      />,
    );
    const closeRow = within(row("Close tab"));
    expect(closeRow.getByText("Reserved by Buzz")).toBeVisible();
    expect(closeRow.getByText("Control W")).toBeInTheDocument();
    expect(closeRow.queryByRole("button")).not.toBeInTheDocument();
    expect(change("Open Settings")).toBeEnabled();
    fireEvent.click(change("Open Settings"));
    fireEvent.keyDown(capture("Open Settings"), { key: "w", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("reserved");
    expect(bindings.snapshot().overrides).toEqual({});
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel changing Open Settings" }),
    );
    fireEvent.click(change("Open Settings"));
    fireEvent.keyDown(capture("Open Settings"), { key: "p", ctrlKey: true });
    expect(bindings.snapshot().overrides.settings).toEqual({
      key: "p",
      mod: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Reset all shortcuts" }),
    );
    expect(closeRow.queryByRole("button")).not.toBeInTheDocument();
    expect(bindings.snapshot().overrides).toEqual({});
  } finally {
    cleanup();
    remove();
    appearance.dispose();
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("lists the message editor's formatting keys read-only and warns when a shortcut takes one", async () => {
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
    // Said once under the section heading, not on every row.
    expect(
      screen.getByText(
        "Built into the message editor. These work while you type and can't be changed.",
      ),
    ).toBeVisible();
    const code = row("Code");
    expect(within(code).queryByText(/Built into/)).toBeNull();
    expect(
      within(code).queryByRole("button", { name: /Change shortcut/ }),
    ).toBeNull();
    expect(
      [...code.querySelectorAll(".buzz-keyboard-shortcut")].map((chord) =>
        chord.getAttribute("data-binding"),
      ),
    ).toEqual(["Ctrl+E", "Ctrl+Shift+C"]);
    expect(row("Add or edit link")).toBeInTheDocument();
    const user = userEvent.setup();
    const title = "Increment shortcut counter";
    await user.click(change(title));
    await user.keyboard("{Control>}{Shift>}u{/Shift}{/Control}");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The message editor handles Ctrl+Shift+U itself while you are typing",
    );
  } finally {
    await h.dispose();
  }
});

it("switches sending to Ctrl+Enter and shows the editor keys that follow", async () => {
  const h = await harness();
  try {
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
    const chords = (title: string) =>
      [...row(title).querySelectorAll(".buzz-keyboard-shortcut")].map((chord) =>
        chord.getAttribute("data-binding"),
      );
    const toggle = screen.getByRole("switch", { name: "Send with Ctrl+Enter" });
    expect(toggle).not.toBeChecked();
    expect(chords("Send message")).toEqual(["Enter"]);
    expect(chords("New line")).toEqual(["Shift+Enter"]);
    await userEvent.setup().click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("buzz-send-with-mod-enter.v1")).toBe("on");
    expect(chords("Send message")).toEqual(["Ctrl+Enter"]);
    expect(chords("New line")).toEqual(["Enter", "Shift+Enter"]);
  } finally {
    await h.dispose();
  }
});

it("saves the Up Arrow editing choice and restores it when settings remounts", async () => {
  const h = await harness();
  const settings = () =>
    render(
      <ShortcutSettings
        shortcuts={h.shortcuts}
        bindings={h.bindings}
        plugins={h.plugins}
      />,
    );
  try {
    const view = settings();
    const toggle = screen.getByRole("switch", {
      name: "Edit last message with Up Arrow",
    });
    expect(toggle).not.toBeChecked();
    await userEvent.setup().click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("buzz-edit-with-up-arrow.v1")).toBe("on");
    view.unmount();
    settings();
    const restored = screen.getByRole("switch", {
      name: "Edit last message with Up Arrow",
    });
    expect(restored).toBeChecked();
    await userEvent.setup().click(restored);
    expect(restored).not.toBeChecked();
    expect(localStorage.getItem("buzz-edit-with-up-arrow.v1")).toBe("off");
  } finally {
    await h.dispose();
  }
});

it.each([
  ["Edit last message with Up Arrow", "buzz-edit-with-up-arrow.v1"],
  ["Send with Ctrl+Enter", "buzz-send-with-mod-enter.v1"],
])(
  "keeps %s active on a storage failure and retries saving",
  async (label, key) => {
    const h = await harness();
    try {
      render(
        <ShortcutSettings
          shortcuts={h.shortcuts}
          bindings={h.bindings}
          plugins={h.plugins}
        />,
      );
      const storage = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementationOnce(() => {
          throw new Error("full");
        });
      const toggle = screen.getByRole("switch", {
        name: label,
      });
      await userEvent.setup().click(toggle);
      expect(toggle).toBeChecked();
      expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
      storage.mockRestore();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: /^Retry saving$/ }));
      expect(localStorage.getItem(key)).toBe("on");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      await h.dispose();
    }
  },
);
