// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { provideNavigation } from "../features/navigation/service";
import { NotificationsService } from "../features/notifications/service";
import { DEFAULT_SOUND } from "../features/notifications/sound";
import { NotificationSettings } from "./NotificationSettings";
import { PluginRuntime } from "../plugins/runtime";

const contexts: Context[] = [];
afterEach(async () => {
  cleanup();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "represents development pause=%s without changing saved preferences",
  async (paused) => {
    vi.stubEnv("VITE_BUZZ_NOTIFICATIONS_PAUSED", paused ? "1" : "0");
    const ctx = new Context();
    contexts.push(ctx);
    const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
    ctx.effect(() => () => runtime.dispose());
    let permission: "default" | "granted" = "default";
    const platform = {
      label: "Browser",
      permission: vi.fn(async () => permission),
      requestPermission: vi.fn(async () => {
        permission = "granted";
        return permission;
      }),
      show: vi.fn(async () => {}),
      dispose() {},
    };
    const service = new NotificationsService(
      ctx,
      provideNavigation(ctx).navigation,
      platform,
    );
    service.selectViewer("a".repeat(64));
    service.updatePreferences({ enabled: true });
    const saved = localStorage.getItem(
      `buzz-notification-preferences.v1:${"a".repeat(64)}`,
    );
    render(<NotificationSettings notifications={service} />, {
      wrapper: ToastProvider,
    });
    const toggle = screen.getByRole("switch", { name: "Desktop alerts" });
    const preferences = service.snapshot().preferences;
    if (paused) {
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      await userEvent.setup().click(toggle);
      expect(service.snapshot().preferences.enabled).toBe(true);
      expect(toggle).not.toBeChecked();
      expect(
        screen.queryByRole("switch", { name: "Notify while viewing" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("switch", { name: "Sound" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Remove BUZZ_DEV_NOTIFICATIONS=0",
      );
      expect(
        screen.queryByRole("button", { name: "Allow notifications" }),
      ).not.toBeInTheDocument();
    } else {
      expect(toggle).not.toHaveAttribute("aria-disabled", "true");
      expect(toggle).toBeChecked();
      expect(
        screen.getByRole("switch", { name: "Notify while viewing" }),
      ).toBeVisible();
      expect(
        screen.getByRole("combobox", { name: "Direct messages" }),
      ).toBeVisible();
      await userEvent
        .setup()
        .click(screen.getByText("Desktop alerts", { selector: "label" }));
      expect(toggle).not.toBeChecked();
      expect(service.snapshot().preferences).toEqual({
        ...preferences,
        enabled: false,
      });
      expect(
        screen.queryByRole("switch", { name: "Notify while viewing" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("switch", { name: "Sound" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("combobox", { name: "Direct messages" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Allow notifications" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Check permission" }),
      ).not.toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByText("Desktop alerts", { selector: "label" }));
      expect(toggle).toBeChecked();
      expect(service.snapshot().preferences).toEqual(preferences);
      expect(
        screen.getByRole("switch", { name: "Notify while viewing" }),
      ).toBeVisible();
      expect(screen.getByRole("switch", { name: "Sound" })).toBeChecked();
      expect(
        screen.getByRole("combobox", { name: "Direct messages" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Allow notifications" }),
      ).toBeEnabled();
    }
    cleanup();
    await service.requestPermission();
    expect(platform.requestPermission).toHaveBeenCalledTimes(paused ? 0 : 1);
    const accepted = await service.admit(
      "mention",
      "Mentions",
      {
        sourceKey: "test-event",
        target: { version: 1, kind: "settings" },
      },
      () => true,
    );
    expect(accepted).toBe(!paused);
    if (paused) expect(platform.show).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(platform.show).toHaveBeenCalledOnce());
    expect(service.snapshot().preferences.enabled).toBe(true);
    service.reloadPreferences();
    expect(service.snapshot().preferences.enabled).toBe(true);
    expect(
      localStorage.getItem(
        `buzz-notification-preferences.v1:${"a".repeat(64)}`,
      ),
    ).toBe(saved);
  },
);

it("keeps both preference recovery paths scoped to the visible section", async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Browser",
      permission: async () => "default",
      requestPermission: async () => "default",
      show: async () => {},
      dispose() {},
    },
  );
  service.selectViewer("a".repeat(64));
  service.updatePreferences({ enabled: false });
  const fail = () =>
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
  const write = fail();
  act(() => {
    service.updatePreferences({ enabled: true });
  });
  const view = render(
    <ToastProvider>
      <NotificationSettings notifications={service} active={false} />
    </ToastProvider>,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(
    <ToastProvider>
      <NotificationSettings notifications={service} />
    </ToastProvider>,
  );
  expect(
    await screen.findByRole("button", { name: "Retry saving choices" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Reload saved choices" }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved choices" }));
  expect(service.snapshot().preferences.enabled).toBe(false);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => {
    service.updatePreferences({ enabled: true });
  });
  write.mockRestore();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry saving choices" }),
  );
  expect(service.snapshot().preferencesError).toBeNull();
  expect(service.snapshot().preferences.enabled).toBe(true);
});

async function chooseSound(label: string, name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name }));
}

it("owns one preview and stops it across replacement, disablement, inactivity, errors, and unmount", async () => {
  const audios: FakeAudio[] = [];
  class FakeAudio {
    currentTime = 0;
    onended: (() => void) | null = null;
    onpause: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = vi.fn();
    play = vi.fn(() => Promise.resolve());
    constructor(public src: string) {
      audios.push(this);
    }
  }
  vi.stubGlobal("Audio", FakeAudio);
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Browser",
      permission: async () => "granted",
      requestPermission: async () => "granted",
      show: async () => {},
      dispose() {},
    },
  );
  service.selectViewer("a".repeat(64));
  const view = render(<NotificationSettings notifications={service} />);
  expect(audios).toHaveLength(0);
  expect(
    screen.queryByRole("button", { name: /Preview|Pause/ }),
  ).not.toBeInTheDocument();
  await chooseSound("Direct messages", "ping");
  expect(audios[0]?.src).toBe("/sounds/ping.mp3");
  expect(audios[0]?.play).toHaveBeenCalledOnce();
  await chooseSound("@Mentions", "boo");
  expect(audios[0]?.pause).toHaveBeenCalledOnce();
  expect(audios[0]?.onended).toBeNull();
  expect(audios).toHaveLength(2);
  act(() => service.updatePreferences({ categories: { mention: false } }));
  expect(audios[1]?.pause).toHaveBeenCalledOnce();
  act(() => service.updatePreferences({ categories: { mention: true } }));
  await chooseSound("@Mentions", "doo");
  view.rerender(
    <NotificationSettings notifications={service} active={false} />,
  );
  expect(audios[2]?.pause).toHaveBeenCalledOnce();
  view.rerender(<NotificationSettings notifications={service} />);
  expect(audios).toHaveLength(3);
  await chooseSound("@Mentions", "boo");
  act(() => audios[3]?.onerror?.());
  expect(audios[3]?.pause).toHaveBeenCalledOnce();
  await chooseSound("@Mentions", "doo");
  act(() => service.updatePreferences({ sound: false }));
  expect(audios[4]?.pause).toHaveBeenCalledOnce();
  act(() => service.updatePreferences({ sound: true }));
  await chooseSound("@Mentions", "boo");
  fireEvent.click(screen.getByRole("switch", { name: "Desktop alerts" }));
  expect(audios[5]?.pause).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("switch", { name: "Desktop alerts" }));
  await chooseSound("@Mentions", "doo");
  view.unmount();
  expect(audios[6]?.pause).toHaveBeenCalledOnce();
  expect(audios[6]?.onerror).toBeNull();
});

it("cleans up the preview when playback rejects", async () => {
  const pause = vi.fn();
  let reject!: (error: Error) => void;
  class RejectingAudio {
    onended: (() => void) | null = null;
    onpause: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = pause;
    play = vi.fn(
      () =>
        new Promise<void>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
  }
  vi.stubGlobal("Audio", RejectingAudio);
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Browser",
      permission: async () => "granted",
      requestPermission: async () => "granted",
      show: async () => {},
      dispose() {},
    },
  );
  service.selectViewer("a".repeat(64));
  render(<NotificationSettings notifications={service} />);
  await chooseSound("Direct messages", "ping");
  await act(async () => reject(new Error("blocked")));
  expect(pause).toHaveBeenCalledOnce();
});
it("keeps an explicit permission check focused and busy until the native read finishes", async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const permission = vi.fn(
    async (): Promise<NotificationPermission> => "default",
  );
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Browser",
      permission,
      requestPermission: async () => "default",
      show: async () => {},
      dispose() {},
    },
  );
  await service.refreshPermission();
  vi.useFakeTimers();
  render(<NotificationSettings notifications={service} />, {
    wrapper: ToastProvider,
  });
  let resolve!: (value: NotificationPermission) => void;
  permission.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const calls = permission.mock.calls.length;
  const button = screen.getByRole("button", { name: "Check permission" });
  button.focus();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(permission).toHaveBeenCalledTimes(calls + 1);
  expect(screen.getByRole("button", { name: "Check permission" })).toBe(button);
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).not.toHaveAttribute("disabled");
  expect(button).toHaveFocus();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(button).toHaveAttribute("aria-busy", "true");
  await act(async () => resolve("granted"));
  expect(button).not.toHaveAttribute("aria-busy", "true");
  expect(button).toHaveFocus();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Allow notifications" }),
  ).not.toBeInTheDocument();
});
it("repeated identical permission failures retain feedback without leaving Settings", async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const permission = vi.fn(async () => {
    throw new Error("Permission unavailable");
  });
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Browser",
      permission,
      requestPermission: async () => "default",
      show: async () => {},
      dispose() {},
    },
  );
  await service.refreshPermission();
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  render(<NotificationSettings notifications={service} />, {
    wrapper: ToastProvider,
  });
  await act(() => vi.advanceTimersByTimeAsync(0));
  const notice = () =>
    screen.getByRole("dialog", {
      name: "Buzz couldn’t send the notification",
    });
  expect(notice()).toHaveTextContent("Permission unavailable");
  await act(() => vi.advanceTimersByTimeAsync(9000));
  fireEvent.keyDown(notice(), { key: "Escape" });
  expect(
    screen.queryByRole("button", { name: "Dismiss notification" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check permission" }));
  });
  expect(notice()).toHaveTextContent("Permission unavailable");
});

it("selects and restores Silent for every category, stops previews, and can restore a sound", async () => {
  const pause = vi.fn();
  const play = vi.fn(async () => {});
  vi.stubGlobal(
    "Audio",
    class {
      currentTime = 0;
      pause = pause;
      play = play;
    },
  );
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Browser",
      permission: async () => "granted",
      requestPermission: async () => "granted",
      show: async () => {},
      dispose() {},
    },
  );
  service.selectViewer("a".repeat(64));
  render(<NotificationSettings notifications={service} />);
  const user = userEvent.setup();
  await chooseSound("Direct messages", "ping");
  for (const [category, label] of [
    ["direct", "Direct messages"],
    ["mention", "@Mentions"],
    ["thread", "Thread replies"],
  ] as const) {
    await user.click(screen.getByRole("combobox", { name: label }));
    await user.click(await screen.findByRole("option", { name: "Silent" }));
    expect(service.snapshot().preferences.sounds[category]).toBe("silent");
    expect(screen.getByRole("combobox", { name: label })).toHaveTextContent(
      "Silent",
    );
  }
  expect(pause).toHaveBeenCalledOnce();
  expect(play).toHaveBeenCalledOnce();
  act(() => service.reloadPreferences());
  expect(service.snapshot().preferences.sounds).toEqual({
    direct: "silent",
    mention: "silent",
    thread: "silent",
    agent: "flutter",
  });
  expect(play).toHaveBeenCalledOnce();
  expect(screen.getByRole("switch", { name: "Desktop alerts" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Sound" })).toBeChecked();
  await user.click(screen.getByRole("combobox", { name: "Direct messages" }));
  await user.click(await screen.findByRole("option", { name: "flutter" }));
  expect(play).toHaveBeenCalledTimes(2);
  expect(service.snapshot().preferences.sounds.direct).toBe("flutter");
});

it("restores a saved sound name this build lacks with alerts on and the default sound", () => {
  // The payload a #2877 build writes, with "klaxon" standing in for its "buzz"
  // default so the seed stays unknown to every build.
  localStorage.setItem(
    `buzz-notification-preferences.v1:${"a".repeat(64)}`,
    JSON.stringify({
      enabled: true,
      notifyWhileViewing: false,
      sound: true,
      sounds: {
        mention: "klaxon",
        direct: "klaxon",
        thread: "klaxon",
        agent: "klaxon",
      },
      categories: { mention: true, direct: true, thread: true, agent: true },
    }),
  );
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Browser",
      permission: async () => "granted",
      requestPermission: async () => "granted",
      show: async () => {},
      dispose() {},
    },
  );
  service.selectViewer("a".repeat(64));
  render(<NotificationSettings notifications={service} />, {
    wrapper: ToastProvider,
  });
  expect(screen.getByRole("switch", { name: "Desktop alerts" })).toBeChecked();
  expect(
    screen.queryByRole("button", { name: "Retry saving choices" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Direct messages" }),
  ).toHaveTextContent(DEFAULT_SOUND);
});
