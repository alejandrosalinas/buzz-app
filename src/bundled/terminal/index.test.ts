// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsCard } from "../../features/settings/service";
import { TERMINAL_FONT_KEY } from "./font-preference";
import { apply } from "./index";
import { nativeBridge } from "./bridge";

vi.mock("./bridge", () => ({ nativeBridge: { available: false } }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  nativeBridge.available = false;
  vi.restoreAllMocks();
});

it("retains registered font drafts across navigation and clears them on Apply/reset", async () => {
  nativeBridge.available = true;
  const ctx = host();
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  const card = ctx.settingsCards.register.mock.calls[0]?.[0] as SettingsCard;
  const open = () =>
    render(createElement(card.component, { active: () => true }));
  const family = () => screen.getByRole("textbox", { name: "Font family" });
  const size = () => screen.getByRole("spinbutton", { name: "Font size (px)" });
  let view = open();
  try {
    fireEvent.change(family(), { target: { value: "A,B" } });
    fireEvent.change(size(), { target: { value: "99" } });
    view.unmount();
    view = open();
    expect(family()).toHaveValue("A,B");
    expect(size()).toHaveValue(99);
    expect(family()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    view.unmount();
    view = open();
    expect(family()).toHaveValue("");
    expect(size()).toHaveValue(12);
    fireEvent.change(size(), { target: { value: "16" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    view.unmount();
    view = open();
    expect(size()).toHaveValue(16);
    act(() => {
      localStorage.setItem(
        TERMINAL_FONT_KEY,
        JSON.stringify({ family: null, size: 20 }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: TERMINAL_FONT_KEY,
          storageArea: localStorage,
        }),
      );
    });
    expect(size()).toHaveValue(20);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  } finally {
    view.unmount();
    await ctx.effect.mock.calls[0]?.[0]()();
  }
});

function host() {
  const panels = { register: vi.fn() };
  const shortcuts = { register: vi.fn() };
  const effect = vi.fn();
  const relay = { snapshot: vi.fn() };
  const settingsCards = { register: vi.fn() };
  return { panels, shortcuts, effect, relay, settingsCards };
}
it("does not register a panel or shortcut without native terminal support", () => {
  const ctx = host();
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  expect(ctx.panels.register).not.toHaveBeenCalled();
  expect(ctx.shortcuts.register).not.toHaveBeenCalled();
  expect(ctx.settingsCards.register).not.toHaveBeenCalled();
  expect(ctx.effect).not.toHaveBeenCalled();
});
it("retains the desktop panel, shortcut and session cleanup", async () => {
  nativeBridge.available = true;
  const subscribe = vi.spyOn(window, "addEventListener");
  const unsubscribe = vi.spyOn(window, "removeEventListener");
  const ctx = host();
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  expect(ctx.panels.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "terminal",
      channelLauncher: expect.any(Function),
      component: expect.any(Function),
    }),
  );
  expect(ctx.shortcuts.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "toggle",
      binding: { key: "j", mod: true },
    }),
  );
  expect(ctx.effect).toHaveBeenCalledTimes(1);
  expect(ctx.settingsCards.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "settings",
      title: "Terminal",
      group: "Plugins",
      component: expect.any(Function),
    }),
  );
  const storageListener = subscribe.mock.calls.find(
    ([event]) => event === "storage",
  )?.[1];
  expect(storageListener).toBeTypeOf("function");
  const effect = ctx.effect.mock.calls[0]?.[0];
  if (!effect) throw new Error("Missing plugin cleanup");
  await effect()();
  expect(unsubscribe).toHaveBeenCalledWith("storage", storageListener);
});
