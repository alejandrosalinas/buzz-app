// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { isTauri } from "@tauri-apps/api/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PanelWorkspace } from "../features/panels/PanelWorkspace";
import { ShortcutsService } from "../features/shortcuts/service";
import { forwardTerminalKey } from "../features/shortcuts/terminal-key-event";
import { createShortcutBindings } from "../features/shortcuts/preferences";
import { createNavigationController } from "../features/navigation/controller";
import { createMemoryHistory } from "../features/navigation/history";
import { createAppearance } from "../shared/theme/service";
import { registerAppShortcuts, registerNavigationShortcuts } from "./shortcuts";
import userEvent from "@testing-library/user-event";
import { Dialog } from "../shared/design-system/ui/Dialog";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../shared/design-system/ui/Menu";
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTrigger,
} from "../shared/design-system/ui/Popover";
import historyRequest from "../../src-tauri/src/history-request.js?raw";

const close = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close }),
}));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  localStorage.clear();
  delete document.documentElement.dataset.keyboardNavigation;
  vi.restoreAllMocks();
  close.mockClear();
  vi.mocked(isTauri).mockReturnValue(true);
});

function harness(platform = "Win32") {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(ctx, window, bindings);
  const appearance = createAppearance(window);
  const openSettings = vi.fn();
  const remove = registerAppShortcuts(
    shortcuts,
    appearance,
    openSettings,
    true,
  );
  return {
    ctx,
    shortcuts,
    openSettings,
    bindings,
    remove,
    async dispose() {
      remove();
      appearance.dispose();
      bindings.dispose();
      await ctx.fiber.dispose();
    },
  };
}

function Tabs() {
  const [ids, setIds] = useState(["First", "Second"]);
  const [value, select] = useState("First");
  return ids.length ? (
    <PanelWorkspace
      value={value}
      select={select}
      items={ids.map((id) => ({
        id,
        label: id,
        content: <input aria-label={`${id} draft`} />,
        close() {
          const next = ids.filter((item) => item !== id);
          setIds(next);
          select(next[0] ?? "");
        },
      }))}
    />
  ) : null;
}

function press(
  target: EventTarget = document.body,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key: "w",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

it.each(["Win32"])(
  "%s closes tabs from the composer, never the window; ignores held repeats",
  async (platform) => {
    const h = harness(platform);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    try {
      render(
        <>
          <input aria-label="Main composer" />
          <Tabs />
        </>,
      );
      const composer = screen.getByRole("textbox", { name: "Main composer" });
      composer.focus();
      expect(press(composer).defaultPrevented).toBe(true);
      expect(
        screen.queryByRole("tab", { name: "First" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Second" })).toBeInTheDocument();
      expect(close).not.toHaveBeenCalled();
      expect(press(document.body, { repeat: true }).defaultPrevented).toBe(
        true,
      );
      expect(screen.getByRole("tab", { name: "Second" })).toBeInTheDocument();
      press();
      expect(screen.queryByRole("tab")).not.toBeInTheDocument();
      expect(close).not.toHaveBeenCalled();
      press(document.body, { repeat: true });
      expect(close).not.toHaveBeenCalled();
      press();
      expect(close).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  },
);

it.each(["Win32"])(
  "%s preserves terminal Ctrl+W before PTY translation and blocks competing plugins",
  async (platform) => {
    const h = harness(platform);
    const pluginRun = vi.fn();
    await h.ctx
      .extend({ pluginOwner: { id: "example.keys", revision: "one" } })
      .plugin((ctx) => {
        ctx.shortcuts.register({
          id: "steal-close",
          title: "Competing shortcut",
          binding: { key: "w", mod: true },
          allowInEditable: true,
          run: pluginRun,
        });
      })
      .await();
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const input = document.createElement("textarea");
    terminal.append(input);
    document.body.append(terminal);
    const toPty = vi.fn();
    input.addEventListener("keydown", (event) => {
      if (forwardTerminalKey(window, event)) toPty("\u0017");
    });
    const tabClose = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener("buzz:close-active-tab", tabClose);
    try {
      input.focus();
      expect(press(input).defaultPrevented).toBe(false);
      expect(toPty).toHaveBeenCalledWith("\u0017");
      expect(tabClose).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(pluginRun).not.toHaveBeenCalled();
      input.blur();
      press();
      expect(tabClose).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("buzz:close-active-tab", tabClose);
      await h.dispose();
    }
  },
);

it("does nothing behind a modal, with or without a tab consumer", async () => {
  const h = harness();
  const tabClose = vi.fn((event: Event) => event.preventDefault());
  render(
    <dialog open>
      <input aria-label="Modal input" />
    </dialog>,
  );
  const input = screen.getByRole("textbox");
  input.focus();
  try {
    press(input);
    expect(close).not.toHaveBeenCalled();
    window.addEventListener("buzz:close-active-tab", tabClose);
    press(input);
    expect(tabClose).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("buzz:close-active-tab", tabClose);
    await h.dispose();
  }
});

it("leaves hidden tabs intact and keeps the window open", async () => {
  const h = harness();
  try {
    render(
      <div hidden>
        <Tabs />
      </div>,
    );
    press();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab", { hidden: true })).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});

it.each([
  [false, "Win32"],
  [true, "MacIntel"],
] as const)(
  "does not register a DOM close shortcut for desktop=%s, platform=%s",
  async (desktop, platform) => {
    vi.mocked(isTauri).mockReturnValue(desktop);
    const h = harness(platform);
    try {
      expect(
        h.shortcuts
          .hostSnapshot()
          .some(({ id }) =>
            ["close-tab", "next-tab", "previous-tab"].includes(id),
          ),
      ).toBe(false);
      expect(press().defaultPrevented).toBe(false);
      expect(
        press(document.body, { ctrlKey: false, metaKey: true })
          .defaultPrevented,
      ).toBe(false);
      expect(close).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  },
);

it("respects IME/editor guards, exact modifiers, Alt+F4 and registration disposal", async () => {
  const h = harness();
  const input = document.createElement("input");
  document.body.append(input);
  input.addEventListener("keydown", (event) => event.preventDefault());
  try {
    press(input);
    for (const init of [
      { isComposing: true },
      { keyCode: 229 },
      { modifierAltGraph: true },
      { altKey: true },
      { shiftKey: true },
      { metaKey: true },
      { ctrlKey: false, key: "F4", altKey: true },
    ]) {
      expect(press(document.body, init).defaultPrevented).toBe(false);
    }
    expect(close).not.toHaveBeenCalled();
    h.remove();
    expect(press().defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

it("Win32 Ctrl+Tab and Ctrl+Shift+Tab request the next and previous tab, even while typing", async () => {
  const h = harness();
  const requests: string[] = [];
  const record = (event: Event) => requests.push(event.type);
  window.addEventListener("buzz:next-tab", record);
  window.addEventListener("buzz:previous-tab", record);
  const input = document.createElement("input");
  document.body.append(input);
  try {
    input.focus();
    expect(press(input, { key: "Tab" }).defaultPrevented).toBe(true);
    press(input, { key: "Tab", shiftKey: true });
    press(input, { key: "Tab", repeat: true });
    expect(requests).toEqual([
      "buzz:next-tab",
      "buzz:previous-tab",
      "buzz:next-tab",
    ]);
    expect(press(input, { key: "Tab", ctrlKey: false }).defaultPrevented).toBe(
      false,
    );
    expect(requests).toHaveLength(3);
  } finally {
    window.removeEventListener("buzz:next-tab", record);
    window.removeEventListener("buzz:previous-tab", record);
    await h.dispose();
  }
});

it.each(["MacIntel", "Win32", "Linux x86_64"])(
  "%s focuses destination composers and falls back to tabs for tools",
  async (platform) => {
    vi.mocked(isTauri).mockReturnValue(false);
    const h = harness(platform);
    // jsdom has no layout. Browser journeys verify visibility and native focus.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(
          this.closest("[data-panel-workspace]") ? 200 : 0,
          0,
          100,
          100,
        );
      },
    );
    const notification = document.createElement("div");
    let cover: HTMLElement | undefined;
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (x: number) => {
        const pane = document.querySelector(
          x < 200 ? "[data-main-workspace]" : "[data-panel-workspace]",
        );
        return [notification, cover, pane].filter(Boolean);
      },
    });
    try {
      render(
        <>
          <button type="button">Outside</button>
          <main id="main-content">
            <div data-main-workspace="">
              <button type="button" role="tab" aria-selected="true">
                Main tab
              </button>
              <div inert>
                <input data-tab-focus="" aria-label="Retained draft" />
              </div>
              <input
                data-tab-focus=""
                aria-label="Main draft"
                defaultValue="Keep this draft"
              />
            </div>
            <div data-panel-workspace="">
              <button type="button" role="tab" aria-selected="true">
                Side tab
              </button>
              <input aria-label="Tool filter" />
              <input
                data-tab-focus=""
                aria-label="Side draft"
                defaultValue="Side draft"
              />
            </div>
            <div hidden data-panel-workspace="">
              <button type="button" role="tab" aria-selected="true">
                Hidden tab
              </button>
              <input data-tab-focus="" aria-label="Hidden draft" />
            </div>
          </main>
          <div className="xterm">
            <textarea aria-label="Drawer terminal" />
          </div>
        </>,
      );
      const main = screen.getByRole("textbox", {
        name: "Main draft",
      });
      const side = screen.getByRole("textbox", { name: "Side draft" });
      const outside = screen.getByRole("button", { name: "Outside" });
      const mainTab = screen.getByRole("tab", { name: "Main tab" });
      const sideTab = screen.getByRole("tab", { name: "Side tab" });
      const apple = platform === "MacIntel";
      expect(
        h.shortcuts
          .hostSnapshot()
          .filter(({ id }) => id.startsWith("focus-"))
          .map(({ id, title }) => [id, title]),
      ).toEqual(
        apple
          ? [
              ["focus-composer", "Focus message box"],
              ["focus-main-pane", "Focus main pane"],
              ["focus-side-pane", "Focus side pane"],
            ]
          : [
              ["focus-composer", "Focus message box"],
              ["focus-pane", "Focus next pane"],
            ],
      );
      const chord = {
        key: "l",
        ctrlKey: !apple,
        metaKey: apple,
        shiftKey: false,
        altKey: false,
      };
      outside.focus();
      for (const extra of [
        // Command+Shift+L is the Mac side-pane action, covered below.
        ...(apple ? [] : [{ shiftKey: !chord.shiftKey }]),
        { altKey: !chord.altKey },
        { ctrlKey: !chord.ctrlKey },
        { metaKey: !chord.metaKey },
        { isComposing: true },
      ]) {
        expect(press(outside, { ...chord, ...extra }).defaultPrevented).toBe(
          false,
        );
        expect(outside).toHaveFocus();
      }
      expect(press(outside, chord).defaultPrevented).toBe(true);
      expect(main).toHaveFocus();
      const terminal = screen.getByRole("textbox", { name: "Drawer terminal" });
      terminal.focus();
      const terminalKey = new KeyboardEvent("keydown", {
        ...chord,
        bubbles: true,
        cancelable: true,
      });
      expect(forwardTerminalKey(window, terminalKey)).toBe(true);
      expect(terminalKey.defaultPrevented).toBe(false);
      expect(terminal).toHaveFocus();
      const paneKey = apple
        ? { key: "L", ctrlKey: false, metaKey: true, shiftKey: true }
        : { key: "F8", ctrlKey: false };
      const mainKey = apple
        ? { ...paneKey, key: "H" }
        : { ...paneKey, shiftKey: true };
      // Pane focus is the keyboard escape from xterm, which captures Tab.
      for (const [key, target] of [
        [paneKey, apple ? side : main],
        [mainKey, main],
      ] as const) {
        terminal.focus();
        const event = new KeyboardEvent("keydown", {
          ...key,
          bubbles: true,
          cancelable: true,
        });
        expect(forwardTerminalKey(window, event)).toBe(false);
        expect(event.defaultPrevented).toBe(true);
        expect(target).toHaveFocus();
      }
      main.focus();
      if (apple) {
        // Command+arrows retain native line navigation while typing.
        expect(
          press(main, { key: "ArrowRight", ctrlKey: false, metaKey: true })
            .defaultPrevented,
        ).toBe(false);
        expect(main).toHaveFocus();
      }
      press(main, paneKey);
      expect(side).toHaveFocus();
      expect(document.documentElement.dataset.keyboardNavigation).toBe("");
      if (apple) {
        press(side, paneKey);
        expect(side).toHaveFocus();
      }
      sideTab.focus();
      press(sideTab, chord);
      expect(side).toHaveFocus();
      press(side, mainKey);
      expect(main).toHaveFocus();
      mainTab.focus();
      press(mainTab, chord);
      expect(main).toHaveFocus();

      // A tool's filter is not a composer; disabled editors and hidden tabs
      // must not redirect the request to the main pane.
      side.setAttribute("aria-disabled", "true");
      main.focus();
      press(main, paneKey);
      expect(sideTab).toHaveFocus();
      const filter = screen.getByRole("textbox", { name: "Tool filter" });
      filter.focus();
      expect(press(filter, chord).defaultPrevented).toBe(false);
      expect(filter).toHaveFocus();
      side.removeAttribute("aria-disabled");
      side.setAttribute("readonly", "");
      expect(press(filter, chord).defaultPrevented).toBe(false);
      expect(filter).toHaveFocus();

      // Companion cards and drawer content share the dock without owning a
      // workspace. Their cover must block main targets beneath notifications.
      const sidePane = side.closest<HTMLElement>("[data-panel-workspace]");
      if (!sidePane) throw new Error("Missing side workspace");
      const dock = document.createElement("div");
      dock.dataset.panelDock = "";
      sidePane.before(dock);
      dock.append(sidePane);
      sidePane.hidden = true;
      cover = document.createElement("aside");
      const button = document.createElement("button");
      cover.append(button);
      dock.append(cover);
      for (const start of [outside, button]) {
        start.focus();
        expect(press(start, chord).defaultPrevented).toBe(false);
        expect(press(start, paneKey).defaultPrevented).toBe(false);
        expect(press(start, mainKey).defaultPrevented).toBe(false);
        expect(start).toHaveFocus();
      }
      cover.remove();
      cover = undefined;
      sidePane.hidden = false;
      side.removeAttribute("readonly");
      filter.focus();
      expect(press(filter, chord).defaultPrevented).toBe(true);
      expect(side).toHaveFocus();
      filter.focus();

      const modal = document.createElement("div");
      modal.setAttribute("aria-modal", "true");
      document.body.append(modal);
      expect(press(filter, chord).defaultPrevented).toBe(false);
      expect(press(filter, paneKey).defaultPrevented).toBe(false);
      expect(filter).toHaveFocus();
      modal.remove();
      act(() => h.bindings.set("focus-composer", { key: "u", mod: true }));
      expect(press(filter, chord).defaultPrevented).toBe(false);
      delete document.documentElement.dataset.keyboardNavigation;
      press(filter, { key: "u", ctrlKey: !apple, metaKey: apple });
      expect(side).toHaveFocus();
      expect(document.documentElement.dataset.keyboardNavigation).toBe("");
      act(() => h.bindings.set("focus-composer", null));
      h.remove();
      expect(press(filter, paneKey).defaultPrevented).toBe(false);
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint");
      await h.dispose();
    }
  },
);

it.each([
  ["Win32", { ctrlKey: true }],
  ["MacIntel", { metaKey: true }],
])(
  "%s Mod+/ opens Settings at Shortcuts while typing; Mod+Shift+? stays with the OS",
  async (platform, mod) => {
    const h = harness(platform);
    const controller = createNavigationController(createMemoryHistory());
    const { navigation } = controller;
    const remove = registerNavigationShortcuts(h.shortcuts, navigation);
    const target = () => navigation.snapshot().attempt.entry.target;
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    try {
      expect(
        press(composer, { ctrlKey: false, key: "/", ...mod }).defaultPrevented,
      ).toBe(true);
      expect(target()).toEqual({
        version: 1,
        kind: "settings",
        section: "shortcuts",
      });
      void navigation.open({ version: 1, kind: "home" });
      for (const chord of [
        { key: "?", shiftKey: true, ...mod },
        { key: "/" },
      ]) {
        expect(
          press(composer, { ctrlKey: false, ...chord }).defaultPrevented,
        ).toBe(false);
      }
      expect(target()).toEqual({ version: 1, kind: "home" });
    } finally {
      remove();
      controller.dispose();
      await h.dispose();
    }
  },
);

it("the macOS Settings menu request opens Settings, not behind a modal", async () => {
  const h = harness("MacIntel");
  const request = () => window.dispatchEvent(new Event("buzz:open-settings"));
  const confirmation = document.createElement("div");
  confirmation.setAttribute("role", "alertdialog");
  confirmation.setAttribute("aria-modal", "true");
  try {
    document.body.append(confirmation);
    request();
    expect(h.openSettings).not.toHaveBeenCalled();
    confirmation.remove();
    request();
    expect(h.openSettings).toHaveBeenCalledOnce();
  } finally {
    confirmation.remove();
    await h.dispose();
  }
  request();
  expect(h.openSettings).toHaveBeenCalledOnce();
});

it("mouse back/forward requests run the Back/Forward shortcuts, not behind a modal", async () => {
  const h = harness("MacIntel");
  const controller = createNavigationController(createMemoryHistory());
  const { navigation } = controller;
  const remove = registerNavigationShortcuts(h.shortcuts, navigation);
  const target = () => navigation.snapshot().attempt.entry.target;
  // As the macOS monitor evaluates it in the main view, no browser focused.
  const request = (historyEvent: string) =>
    new Function(
      "window",
      "document",
      "Event",
      "CSS",
      "browserSessionId",
      "historyEvent",
      `return eval(${JSON.stringify(historyRequest)})`,
    )(window, document, Event, CSS, null, historyEvent);
  const confirmation = document.createElement("div");
  confirmation.setAttribute("role", "alertdialog");
  confirmation.setAttribute("aria-modal", "true");
  try {
    void navigation.open({ version: 1, kind: "home" });
    void navigation.open({ version: 1, kind: "settings" });
    await vi.waitFor(() => expect(navigation.snapshot().canGoBack).toBe(true));
    document.body.append(confirmation);
    request("buzz:history-back");
    await Promise.resolve();
    expect(target()).toEqual({ version: 1, kind: "settings" });
    confirmation.remove();
    request("buzz:history-back");
    await vi.waitFor(() =>
      expect(target()).toEqual({ version: 1, kind: "home" }),
    );
    request("buzz:history-forward");
    await vi.waitFor(() =>
      expect(target()).toEqual({ version: 1, kind: "settings" }),
    );
  } finally {
    confirmation.remove();
    remove();
    controller.dispose();
    await h.dispose();
  }
});

it("Back and Forward step through an addressable dialog, not past a confirmation over it", async () => {
  const h = harness("MacIntel");
  const controller = createNavigationController(createMemoryHistory());
  const { navigation } = controller;
  const remove = registerNavigationShortcuts(h.shortcuts, navigation);
  const target = () => navigation.snapshot().attempt.entry.target;
  const keyboard = (key: string) =>
    press(document.body, { ctrlKey: false, metaKey: true, key });
  const mouse = (historyEvent: string) =>
    new Function(
      "window",
      "document",
      "Event",
      "CSS",
      "browserSessionId",
      "historyEvent",
      `return eval(${JSON.stringify(historyRequest)})`,
    )(window, document, Event, CSS, null, historyEvent);
  // As the shared Dialog renders a visit, and an AlertDialog over it.
  const visit = document.createElement("div");
  visit.setAttribute("role", "dialog");
  visit.setAttribute("aria-modal", "true");
  visit.dataset.navigationVisit = "";
  const confirmation = document.createElement("div");
  confirmation.setAttribute("role", "alertdialog");
  confirmation.setAttribute("aria-modal", "true");
  const settings = { version: 1, kind: "settings" } as const;
  const home = { version: 1, kind: "home" } as const;
  try {
    const inputs: [() => void, () => void][] = [
      [() => keyboard("["), () => keyboard("]")],
      [() => mouse("buzz:history-back"), () => mouse("buzz:history-forward")],
    ];
    for (const [back, forward] of inputs) {
      void navigation.open(home);
      void navigation.open(settings);
      await vi.waitFor(() => expect(target()).toEqual(settings));
      document.body.append(visit, confirmation);
      back();
      await Promise.resolve();
      expect(target()).toEqual(settings);
      confirmation.remove();
      back();
      await vi.waitFor(() => expect(target()).toEqual(home));
      forward();
      await vi.waitFor(() => expect(target()).toEqual(settings));
      visit.remove();
    }
  } finally {
    visit.remove();
    confirmation.remove();
    remove();
    controller.dispose();
    await h.dispose();
  }
});

it.each(["menu", "popover"] as const)(
  "Back and Forward stay put while a %s is open over an addressable dialog",
  async (surface) => {
    const h = harness("MacIntel");
    const controller = createNavigationController(createMemoryHistory());
    const { navigation } = controller;
    const remove = registerNavigationShortcuts(h.shortcuts, navigation);
    const target = () => navigation.snapshot().attempt.entry.target;
    const settings = { version: 1, kind: "settings" } as const;
    const user = userEvent.setup();
    render(
      <Dialog open visit title="Visit" onOpenChange={() => {}}>
        {surface === "menu" ? (
          <MenuRoot>
            <MenuTrigger>Open layer</MenuTrigger>
            <MenuPopup>
              <MenuItem>Layer action</MenuItem>
            </MenuPopup>
          </MenuRoot>
        ) : (
          <PopoverRoot>
            <PopoverTrigger>Open layer</PopoverTrigger>
            <PopoverPopup>
              <button type="button">Layer action</button>
            </PopoverPopup>
          </PopoverRoot>
        )}
      </Dialog>,
    );
    try {
      // Settings sits between two visits, so both directions are available.
      const home = { version: 1, kind: "home" } as const;
      void navigation.open(home);
      void navigation.open(settings);
      void navigation.open(home);
      await vi.waitFor(() => expect(target()).toEqual(home));
      navigation.back();
      await vi.waitFor(() => expect(target()).toEqual(settings));
      expect(navigation.snapshot()).toMatchObject({
        canGoBack: true,
        canGoForward: true,
      });
      await user.click(screen.getByRole("button", { name: "Open layer" }));
      const action = await screen.findByText("Layer action");
      for (const [key, historyEvent] of [
        ["[", "buzz:history-back"],
        ["]", "buzz:history-forward"],
      ] as const) {
        press(action, { ctrlKey: false, metaKey: true, key });
        new Function(
          "window",
          "document",
          "Event",
          "CSS",
          "browserSessionId",
          "historyEvent",
          `return eval(${JSON.stringify(historyRequest)})`,
        )(window, document, Event, CSS, null, historyEvent);
        await act(async () => {});
        expect(target()).toEqual(settings);
      }
    } finally {
      remove();
      controller.dispose();
      await h.dispose();
    }
  },
);
