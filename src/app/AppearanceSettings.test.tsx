// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { createAppearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import {
  setUnreadFirstPreference,
  unreadFirstPreference,
} from "../features/search/unread-first-preference";

import {
  setThreadPlacementPreference,
  threadPlacementPreference,
} from "../features/messages/thread-preferences";

import {
  namePreference,
  setNamePreference,
} from "../features/profiles/name-preference";
import {
  followUpBehaviorPreference,
  setFollowUpBehaviorPreference,
} from "../features/messages/follow-up-preference";
import {
  messageAutocorrectPreference,
  setMessageAutocorrectPreference,
} from "../features/messages/autocorrect-preference";
import {
  clockPreference,
  setClockPreference,
} from "../shared/clock-preference";

const preferenceAppearances: ReturnType<typeof createAppearance>[] = [];
function preferencesPage() {
  const appearance = createAppearance();
  preferenceAppearances.push(appearance);
  return <AppearanceSettings appearance={appearance} />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const appearance of preferenceAppearances.splice(0))
    appearance.dispose();
  setThreadPlacementPreference("side");
  setFollowUpBehaviorPreference("immediate");
  setMessageAutocorrectPreference(false);
  setUnreadFirstPreference(true);
  setClockPreference({
    hourCycle: "system",
    seconds: false,
    messageTimestamps: "show",
  });
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("hidden settings do not portal errors; returning retains both save recovery actions", async () => {
  const appearance = createAppearance();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("denied");
    });
  act(() => {
    appearance.setMode("dark");
    appearance.setFontScale(1.2);
  });
  const content = (active: boolean) => (
    <ToastProvider>
      <AppearanceSettings appearance={appearance} active={active} />
    </ToastProvider>
  );
  const view = render(content(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(content(true));
  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2));
  view.rerender(content(false));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(appearance.snapshot().error).not.toBeNull();
  view.rerender(content(true));
  write.mockRestore();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry saving appearance" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry saving interface size" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(localStorage.getItem("buzz-appearance.v1")).toBe("dark");
  expect(localStorage.getItem("buzz-font-scale.v1")).toBe("1.2");
  appearance.dispose();
});

it("retry saves the System choice even when its current palette is light", async () => {
  const appearance = createAppearance();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("denied");
    });
  act(() => appearance.setMode("system"));
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  expect(screen.getByRole("combobox", { name: "Mode" })).toHaveTextContent(
    "System",
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry saving appearance" }),
  );
  expect(write).toHaveBeenLastCalledWith("buzz-appearance.v1", "system");
  expect(localStorage.getItem("buzz-appearance.v1")).toBe("system");
  appearance.dispose();
});

it("shows reset only away from the default size and hides it after reset", () => {
  const appearance = createAppearance();
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  expect(
    screen.queryByRole("button", { name: "Reset interface size" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Increase interface size" }),
  );
  expect(
    screen.getByRole("status", { name: "Interface size" }),
  ).toHaveTextContent("110%");
  fireEvent.click(screen.getByRole("button", { name: "Reset interface size" }));
  expect(
    screen.getByRole("status", { name: "Interface size" }),
  ).toHaveTextContent("100%");
  expect(
    screen.queryByRole("button", { name: "Reset interface size" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Decrease interface size" }),
  );
  expect(
    screen.getByRole("button", { name: "Reset interface size" }),
  ).toBeVisible();
  appearance.dispose();
});

it.each([1.1, 2])(
  "returns focused Reset from %s to Increase, including storage failure",
  async (scale) => {
    const user = userEvent.setup();
    const appearance = createAppearance();
    render(
      <ToastProvider>
        <AppearanceSettings appearance={appearance} />
      </ToastProvider>,
    );
    const increase = screen.getByRole("button", {
      name: "Increase interface size",
    });
    act(() => appearance.setFontScale(scale));
    screen.getByRole("button", { name: "Reset interface size" }).focus();
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("denied");
    });
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("button", { name: "Reset interface size" }),
    ).not.toBeInTheDocument();
    expect(increase).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Retry saving interface size" }),
    ).toBeVisible();
    appearance.dispose();
  },
);

it.each([false, true])(
  "external reset hands off only the retiring control's focus (%s)",
  (focusReset) => {
    const appearance = createAppearance();
    appearance.setFontScale(1.2);
    render(
      <ToastProvider>
        <AppearanceSettings appearance={appearance} />
      </ToastProvider>,
    );
    const colorMode = screen.getByRole("combobox", { name: "Mode" });
    (focusReset
      ? screen.getByRole("button", { name: "Reset interface size" })
      : colorMode
    ).focus();
    act(() => appearance.setFontScale(1.3));
    expect(
      focusReset
        ? screen.getByRole("button", { name: "Reset interface size" })
        : colorMode,
    ).toHaveFocus();
    act(() => {
      localStorage.setItem("buzz-font-scale.v1", "1");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "buzz-font-scale.v1",
          newValue: "1",
          storageArea: localStorage,
        }),
      );
    });
    expect(
      screen.queryByRole("button", { name: "Reset interface size" }),
    ).not.toBeInTheDocument();
    expect(
      focusReset
        ? screen.getByRole("button", { name: "Increase interface size" })
        : colorMode,
    ).toHaveFocus();
    appearance.dispose();
  },
);

it("does not hand off Reset focus when the settings form unmounts", () => {
  const appearance = createAppearance();
  appearance.setFontScale(2);
  const view = render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  const increase = screen.getByRole("button", {
    name: "Increase interface size",
  });
  screen.getByRole("button", { name: "Reset interface size" }).focus();
  const focus = vi.spyOn(increase, "focus");
  view.unmount();
  expect(focus).not.toHaveBeenCalled();
  appearance.dispose();
});

it("selects and saves color mode through the Mode dropdown", async () => {
  const appearance = createAppearance();
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  expect(screen.getByRole("combobox", { name: "Mode" })).toHaveTextContent(
    "System",
  );
  for (const [label, value] of [
    ["Dark", "dark"],
    ["Light", "light"],
    ["System", "system"],
  ] as const) {
    const choice = screen.getByRole("combobox", { name: "Mode" });
    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: label }));
    expect(choice).toHaveTextContent(label);
    expect(appearance.snapshot().preference).toBe(value);
    expect(localStorage.getItem("buzz-appearance.v1")).toBe(value);
  }
  appearance.dispose();
});

it("selects and restores an accent color, including retry after a failed save", async () => {
  const appearance = createAppearance();
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  expect(
    screen.getAllByRole("button", { name: / accent color$/ }),
  ).toHaveLength(6);

  expect(
    screen.getByRole("button", { name: "Citrus accent color" }),
  ).toHaveAttribute("aria-pressed", "true");
  const save = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("denied");
    });
  fireEvent.click(screen.getByRole("button", { name: "Mono accent color" }));
  expect(
    screen.getByRole("button", { name: "Mono accent color" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement.dataset.accent).toBe("mono");
  // Each swatch previews its own family in the current mode.
  expect(
    screen.getByRole("button", { name: "Magenta accent color" }),
  ).toHaveAttribute("data-color-mode", appearance.snapshot().mode);
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry saving accent color" }),
  );
  expect(localStorage.getItem("buzz-accent.v1")).toBe("mono");
  save.mockRestore();
  appearance.dispose();
  const restored = createAppearance();
  expect(restored.snapshot().accent).toBe("mono");
  restored.dispose();
});

it("saves new-thread placement, restores it, and follows another window", async () => {
  const user = userEvent.setup();
  render(preferencesPage(), {
    wrapper: ToastProvider,
  });
  const choice = () =>
    screen.getByRole("combobox", { name: "Open threads in" });
  expect(
    screen.getByText(
      "New threads open here. Already-open threads stay where you placed them.",
    ),
  ).toBeVisible();
  expect(choice()).toHaveTextContent("Side pane");
  await user.click(choice());
  await user.click(await screen.findByRole("option", { name: "Main pane" }));
  expect(threadPlacementPreference()).toBe("main");
  cleanup();
  render(preferencesPage(), {
    wrapper: ToastProvider,
  });
  expect(choice()).toHaveTextContent("Main pane");
  act(() => {
    localStorage.setItem("buzz-thread-placement.v1", "side");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-thread-placement.v1" }),
    );
  });
  expect(choice()).toHaveTextContent("Side pane");
});

it("keeps unsaved thread placement and recovery through remount, then retries the same choice", async () => {
  const user = userEvent.setup();
  const view = render(preferencesPage(), {
    wrapper: ToastProvider,
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("unavailable");
    });
  await user.click(screen.getByRole("combobox", { name: "Open threads in" }));
  await user.click(await screen.findByRole("option", { name: "Main pane" }));
  expect(threadPlacementPreference()).toBe("main");
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Thread preference wasn’t saved",
  );
  // The app keeps its toast host while the settings destination unmounts.
  view.rerender(null);
  view.rerender(preferencesPage());
  expect(
    screen.getByRole("combobox", { name: "Open threads in" }),
  ).toHaveTextContent("Main pane");
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Thread preference wasn’t saved",
  );
  // Re-enter through the preference before invoking its recovery action.
  screen.getByRole("combobox", { name: "Open threads in" }).focus();
  write.mockRestore();
  await user.click(
    screen.getByRole("button", { name: "Retry saving thread placement" }),
  );
  expect(localStorage.getItem("buzz-thread-placement.v1")).toBe("main");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("preserves follow-up choice and save recovery when Appearance is hidden", async () => {
  const user = userEvent.setup();
  const appearance = createAppearance();
  preferenceAppearances.push(appearance);
  const content = (active: boolean) => (
    <ToastProvider>
      <AppearanceSettings appearance={appearance} active={active} />
    </ToastProvider>
  );
  const view = render(content(true));
  const choice = () =>
    screen.getByRole("combobox", { name: "Follow-up behavior" });
  expect(choice()).toHaveTextContent("Send immediately");
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("unavailable");
    });
  await user.click(choice());
  await user.click(await screen.findByRole("option", { name: "Queue" }));
  expect(followUpBehaviorPreference()).toBe("queue");
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Follow-up preference wasn’t saved",
  );
  view.rerender(content(false));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  view.rerender(content(true));
  expect(choice()).toHaveTextContent("Queue");
  write.mockRestore();
  await user.click(
    await screen.findByRole("button", {
      name: "Retry saving follow-up behavior",
    }),
  );
  expect(localStorage.getItem("buzz-follow-up-behavior.v1")).toBe("queue");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("saves the clock, seconds and message timestamp choices", async () => {
  const user = userEvent.setup();
  render(preferencesPage(), { wrapper: ToastProvider });
  const clock = screen.getByRole("combobox", { name: "Clock" });
  expect(clock).toHaveTextContent("System");
  await user.click(clock);
  await user.click(await screen.findByRole("option", { name: "24-hour" }));
  await user.click(screen.getByRole("switch", { name: "Show seconds" }));
  await user.click(
    screen.getByRole("combobox", { name: "Message timestamps" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "Hide in Solo chats" }),
  );
  expect(clockPreference()).toEqual({
    hourCycle: "h23",
    seconds: true,
    messageTimestamps: "hide-solo",
  });
  expect(JSON.parse(localStorage.getItem("buzz-clock.v1") ?? "")).toEqual(
    clockPreference(),
  );
});

it("switches contrast through the shared select and restores it", async () => {
  const appearance = createAppearance();
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Vibe level" }));
  expect(
    screen.queryByRole("option", { name: "Snoozin’" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Hummin’" }),
  ).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option", { name: "Buzzin’" }));
  expect(appearance.snapshot().contrast).toBe("high");
  expect(localStorage.getItem("buzz-contrast.v1")).toBe("high");
  const restored = createAppearance();
  expect(restored.snapshot().contrast).toBe("high");
  restored.dispose();
  for (const [label, value] of [["Chillin’", "low"]] as const) {
    await user.click(screen.getByRole("combobox", { name: "Vibe level" }));
    await user.click(await screen.findByRole("option", { name: label }));
    expect(localStorage.getItem("buzz-contrast.v1")).toBe(value);
  }
  appearance.dispose();
});

it("switches message density, restores it, and retries a failed save", async () => {
  const appearance = createAppearance();
  preferenceAppearances.push(appearance);
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const density = screen.getByRole("combobox", { name: "Message density" });
  const preview = screen.getByRole("figure", { name: "Appearance preview" });
  expect(preview.querySelector("[data-message-density]")).toHaveAttribute(
    "data-message-density",
    "default",
  );
  expect(density).toHaveTextContent("Default");
  await user.click(density);
  await user.click(await screen.findByRole("option", { name: "Compact" }));
  expect(preview.querySelector("[data-message-density]")).toHaveAttribute(
    "data-message-density",
    "compact",
  );
  expect(preview.querySelector("[data-message-width]")).toHaveAttribute(
    "data-message-width",
    "wide",
  );
  expect(screen.queryByRole("combobox", { name: "Message width" })).toBeNull();
  expect(document.documentElement.dataset.messageDensity).toBe("compact");
  expect(localStorage.getItem("buzz-message-density.v1")).toBe("compact");
  const restored = createAppearance();
  expect(restored.snapshot().density).toBe("compact");
  restored.dispose();

  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("denied");
    });
  await user.click(density);
  await user.click(await screen.findByRole("option", { name: "Default" }));
  expect(document.documentElement.dataset.messageDensity).toBe("default");
  expect(localStorage.getItem("buzz-message-density.v1")).toBe("compact");
  await user.click(
    await screen.findByRole("button", { name: "Retry saving message density" }),
  );
  expect(write).toHaveBeenLastCalledWith("buzz-message-density.v1", "default");
  expect(localStorage.getItem("buzz-message-density.v1")).toBe("default");
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry saving message density" }),
    ).not.toBeInTheDocument(),
  );
});

it("offers message spelling correction only on Mac WebKit, off until this device opts in", async () => {
  const user = userEvent.setup();
  const appearance = createAppearance();
  preferenceAppearances.push(appearance);
  const page = (autocorrectAvailable: boolean) => (
    <AppearanceSettings
      appearance={appearance}
      autocorrectAvailable={autocorrectAvailable}
    />
  );
  const toggle = () =>
    screen.getByRole("switch", { name: "Allow automatic spelling correction" });
  const view = render(page(false), { wrapper: ToastProvider });
  expect(
    screen.queryByRole("switch", {
      name: "Allow automatic spelling correction",
    }),
  ).not.toBeInTheDocument();
  view.rerender(page(true));
  expect(toggle()).not.toBeChecked();
  await user.click(toggle());
  expect(messageAutocorrectPreference()).toBe(true);
  expect(localStorage.getItem("buzz-message-autocorrect.v1")).toBe("on");
  cleanup();
  render(page(true), { wrapper: ToastProvider });
  expect(toggle()).toBeChecked();
  act(() => {
    localStorage.setItem("buzz-message-autocorrect.v1", "off");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-message-autocorrect.v1" }),
    );
  });
  expect(toggle()).not.toBeChecked();
});

it("keeps an unsaved spelling opt-in active and retries the same choice", async () => {
  const user = userEvent.setup();
  const appearance = createAppearance();
  preferenceAppearances.push(appearance);
  render(<AppearanceSettings appearance={appearance} autocorrectAvailable />, {
    wrapper: ToastProvider,
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("unavailable");
    });
  await user.click(
    screen.getByRole("switch", { name: "Allow automatic spelling correction" }),
  );
  expect(messageAutocorrectPreference()).toBe(true);
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Spelling preference wasn’t saved",
  );
  write.mockRestore();
  await user.click(
    screen.getByRole("button", { name: "Retry saving spelling correction" }),
  );
  expect(localStorage.getItem("buzz-message-autocorrect.v1")).toBe("on");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("leads search with unread until this device turns it off", async () => {
  const user = userEvent.setup();
  const appearance = createAppearance();
  preferenceAppearances.push(appearance);
  const toggle = () =>
    screen.getByRole("switch", { name: "Show unread first in search" });
  render(<AppearanceSettings appearance={appearance} />, {
    wrapper: ToastProvider,
  });
  expect(toggle()).toBeChecked();
  await user.click(toggle());
  expect(unreadFirstPreference()).toBe(false);
  expect(localStorage.getItem("buzz-search-unread-first.v1")).toBe("off");
  cleanup();
  render(<AppearanceSettings appearance={appearance} />, {
    wrapper: ToastProvider,
  });
  expect(toggle()).not.toBeChecked();
  act(() => {
    localStorage.setItem("buzz-search-unread-first.v1", "on");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-search-unread-first.v1" }),
    );
  });
  expect(toggle()).toBeChecked();
});

it("keeps an unsaved unread-first choice active and retries the same choice", async () => {
  const user = userEvent.setup();
  const appearance = createAppearance();
  preferenceAppearances.push(appearance);
  render(<AppearanceSettings appearance={appearance} />, {
    wrapper: ToastProvider,
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("unavailable");
    });
  await user.click(
    screen.getByRole("switch", { name: "Show unread first in search" }),
  );
  expect(unreadFirstPreference()).toBe(false);
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Search preference wasn’t saved",
  );
  write.mockRestore();
  await user.click(
    screen.getByRole("button", { name: "Retry saving search preference" }),
  );
  expect(localStorage.getItem("buzz-search-unread-first.v1")).toBe("off");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it.each([
  ["Mac WebKit", "MacIntel", "Apple Computer, Inc.", 0, true],
  ["desktop-mode iPad", "MacIntel", "Apple Computer, Inc.", 5, false],
  ["Chrome on Mac", "MacIntel", "Google Inc.", 0, false],
  ["Linux WebKitGTK", "Linux x86_64", "Apple Computer, Inc.", 0, false],
] as const)(
  "detects whether %s can offer message spelling correction",
  (_browser, platform, vendor, maxTouchPoints, shown) => {
    vi.stubGlobal("navigator", {
      platform,
      vendor,
      maxTouchPoints,
    });
    render(preferencesPage(), { wrapper: ToastProvider });
    expect(
      screen.queryByRole("switch", {
        name: "Allow automatic spelling correction",
      }) !== null,
    ).toBe(shown);
  },
);

it("changes message width through the shared select and restores the saved choice", async () => {
  const user = userEvent.setup();
  const view = render(preferencesPage(), { wrapper: ToastProvider });
  const choice = () => screen.getByRole("combobox", { name: "Message width" });
  expect(choice()).toHaveTextContent("Narrow");
  const preview = screen.getByRole("figure", { name: "Appearance preview" });
  expect(preview.querySelector("[data-message-width]")).toHaveAttribute(
    "data-message-width",
    "narrow",
  );
  expect(
    screen.queryByText(
      "Wide gives conversations 50% more room when space is available.",
    ),
  ).not.toBeInTheDocument();
  await user.click(choice());
  await user.click(await screen.findByRole("option", { name: "Wide" }));
  expect(choice()).toHaveTextContent("Wide");
  expect(preview.querySelector("[data-message-width]")).toHaveAttribute(
    "data-message-width",
    "wide",
  );
  expect(
    document.documentElement.style.getPropertyValue("--buzz-message-width"),
  ).toBe("78rem");
  expect(localStorage.getItem("buzz-message-width.v1")).toBe("wide");
  view.unmount();
  render(preferencesPage(), { wrapper: ToastProvider });
  expect(choice()).toHaveTextContent("Wide");
  await user.click(choice());
  await user.click(await screen.findByRole("option", { name: "Narrow" }));
  expect(
    document.documentElement.style.getPropertyValue("--buzz-message-width"),
  ).toBe("52rem");
});

it("retries an unsaved message width when returning to Appearance", async () => {
  const user = userEvent.setup();
  const appearance = createAppearance();
  preferenceAppearances.push(appearance);
  const content = (active: boolean) => (
    <ToastProvider>
      <AppearanceSettings appearance={appearance} active={active} />
    </ToastProvider>
  );
  const view = render(content(true));
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("denied");
    });
  await user.click(screen.getByRole("combobox", { name: "Message width" }));
  await user.click(await screen.findByRole("option", { name: "Wide" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Message width wasn’t saved",
  );
  view.rerender(content(false));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  view.rerender(content(true));
  expect(
    screen.getByRole("combobox", { name: "Message width" }),
  ).toHaveTextContent("Wide");
  write.mockRestore();
  await user.click(
    await screen.findByRole("button", { name: "Retry saving message width" }),
  );
  expect(localStorage.getItem("buzz-message-width.v1")).toBe("wide");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("offers a choice between usernames and full names only where the community verifies names", async () => {
  const appearance = createAppearance();
  preferenceAppearances.push(appearance);
  let authority: object | undefined;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const connection = {
    status: "ready",
    session: {
      profiles: { subscribe, verifiedAuthority: () => authority },
    },
  };
  const communities = {
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Parameters<typeof AppearanceSettings>[0]["communities"];
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} communities={communities} />
    </ToastProvider>,
  );
  expect(screen.queryByText("Show people by")).toBeNull();
  act(() => {
    authority = { pubkey: "relay", multipleIssuers: false };
    for (const listener of listeners) listener();
  });
  const choice = screen.getByRole("combobox", { name: "Show people by" });
  expect(choice).toHaveTextContent("Username");
  const user = userEvent.setup();
  await user.click(choice);
  await user.click(await screen.findByRole("option", { name: "Full name" }));
  expect(namePreference()).toBe("full-name");
  setNamePreference("username");
});
