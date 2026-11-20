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
import { UpdateSettings } from "./UpdateSettings";
import { createUpdates, type UpdatePlatform, type Updates } from "./updates";

const native = vi.hoisted(() => ({
  getVersion: vi.fn(async () => "1.2.3"),
  isTauri: vi.fn(() => false),
  invoke: vi.fn(
    async (): Promise<{ revision: string | null; state: string }> => ({
      revision: null,
      state: "unknown",
    }),
  ),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: native.getVersion }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: native.isTauri,
}));

let updates: Updates | undefined;
afterEach(() => {
  cleanup();
  updates?.dispose();
  vi.unstubAllEnvs();
  native.isTauri.mockReturnValue(false);
  native.invoke.mockReset().mockResolvedValue({
    revision: null,
    state: "unknown",
  });
});

/** Reactions run in registration order, so the owner finishes its check first. */
async function afterBackgroundCheck(check: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
  await Promise.resolve(check.mock.results[0]?.value).catch(() => {});
}

function renderSettings(platform: Partial<UpdatePlatform>) {
  updates = createUpdates({
    desktop: true,
    check: async () => null,
    relaunch: async () => {},
    ...platform,
  });
  render(<UpdateSettings updates={updates} active />);
  return updates;
}

it("checks on request and checks again from the latest version", async () => {
  const check = vi.fn(async () => null);
  renderSettings({ check });
  await afterBackgroundCheck(check);
  expect(
    screen.getByRole("heading", { name: "Software updates" }),
  ).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Update status", level: 3 }),
  ).toBeVisible();
  expect(screen.queryByText(/Native image source:/)).toBeNull();
  expect(screen.queryByText(/Loaded frontend source:/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Build details" })).toBeNull();
  expect(
    screen.getByText("Check if a new version is available."),
  ).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(
    await screen.findByText("You're on the latest version."),
  ).toBeVisible();
  expect(check).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(3));
});

it("shows progress, then applies a downloaded update", async () => {
  let finishDownload!: () => void;
  const relaunch = vi.fn(async () => {});
  const update = {
    version: "1.2.3",
    download: () =>
      new Promise<void>((resolve) => {
        finishDownload = resolve;
      }),
    install: async () => {},
    close: async () => {},
  };
  renderSettings({ check: async () => update, relaunch });
  expect(await screen.findByText("Downloading update…")).toBeVisible();
  finishDownload();
  expect(
    await screen.findByText("Ready to install. Buzz will restart."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
});

it("reports failures and retries", async () => {
  const check = vi
    .fn<UpdatePlatform["check"]>()
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("network down"))
    .mockResolvedValue(null);
  renderSettings({ check });
  await afterBackgroundCheck(check);
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText("Update failed: network down")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("You're on the latest version."),
  ).toBeVisible();
});

it("explains builds without automatic updates", async () => {
  renderSettings({ desktop: false });
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(
    await screen.findByText(
      "Automatic updates aren't available on this build. Download the latest release manually.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
});

it("uses the installed version as the card title without a separate description", async () => {
  native.isTauri.mockReturnValue(true);
  try {
    renderSettings({});
    expect(
      await screen.findByRole("heading", { name: "Version 1.2.3", level: 3 }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Update status" })).toBeNull();
    expect(
      screen.queryByText(
        "Keep Buzz up to date with the latest features and fixes.",
      ),
    ).toBeNull();
    expect(native.getVersion).toHaveBeenCalledOnce();
  } finally {
    native.isTauri.mockReturnValue(false);
  }
});

it("discloses separate build identities without separating update status and action", async () => {
  const user = userEvent.setup();
  native.isTauri.mockReturnValue(true);
  native.invoke.mockResolvedValue({
    revision: "b".repeat(40),
    state: "clean",
  });
  vi.stubEnv("VITE_BUZZ_FRONTEND_SOURCE_REVISION", "a".repeat(40));
  vi.stubEnv("VITE_BUZZ_FRONTEND_SOURCE_STATE", "dirty");
  try {
    renderSettings({});
    const disclosure = screen.getByRole("button", { name: "Build details" });
    const action = screen.getByRole("button", { name: "Check for updates" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Native image source:/)).toBeNull();
    expect(screen.queryByText(/Loaded frontend source:/)).toBeNull();
    await user.tab();
    expect(action).toHaveFocus();
    await user.tab();
    expect(disclosure).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByText(`Native image source: ${"b".repeat(40)} · clean`),
    ).toBeVisible();
    expect(
      screen.getByText(`Loaded frontend source: ${"a".repeat(40)} · dirty`),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Check if a new version is available.",
    );
    expect(action).toBeVisible();
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveFocus();
    expect(screen.queryByText(/Native image source:/)).toBeNull();
  } finally {
    native.isTauri.mockReturnValue(false);
  }
});

it.each([
  { revision: null, state: "clean", description: "unknown", rejected: false },
  {
    revision: "d".repeat(40),
    state: "invalid",
    description: `${"d".repeat(40)} · unknown`,
    rejected: false,
  },
  { revision: null, state: "unknown", description: "unknown", rejected: true },
])(
  "shows dirty and unknown honestly for an incomplete identity ($state)",
  async ({ revision, state, description, rejected }) => {
    native.isTauri.mockReturnValue(true);
    const response = deferred<{ revision: string | null; state: string }>();
    native.invoke.mockReturnValue(response.promise);
    vi.stubEnv("VITE_BUZZ_FRONTEND_SOURCE_REVISION", "c".repeat(40));
    vi.stubEnv("VITE_BUZZ_FRONTEND_SOURCE_STATE", "dirty");
    try {
      renderSettings({});
      expect(native.invoke).toHaveBeenCalledWith("get_build_identity");
      fireEvent.click(screen.getByRole("button", { name: "Build details" }));
      expect(screen.getByText("Native image source: unknown")).toBeVisible();
      await act(async () => {
        if (rejected) response.reject(new Error("unknown native command"));
        else response.resolve({ revision, state });
      });
      expect(
        screen.getByText(`Native image source: ${description}`),
      ).toBeVisible();
      expect(
        screen.getByText(`Loaded frontend source: ${"c".repeat(40)} · dirty`),
      ).toBeVisible();
      expect(screen.queryByText(/Native image source: .* · clean/)).toBeNull();
    } finally {
      native.isTauri.mockReturnValue(false);
    }
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("preserves the focused action and status through held check, failure, retry and result", async () => {
  const user = userEvent.setup();
  const first = deferred<null>();
  const retry = deferred<null>();
  const again = deferred<null>();
  const check = vi
    .fn<UpdatePlatform["check"]>()
    .mockResolvedValueOnce(null)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(retry.promise)
    .mockReturnValueOnce(again.promise);
  renderSettings({ check });
  await afterBackgroundCheck(check);
  const action = screen.getByRole("button", { name: "Check for updates" });
  const status = screen.getByRole("status");
  await user.tab();
  expect(action).toHaveFocus();
  try {
    await user.keyboard("{Enter}");
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(action).toHaveFocus();
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Checking for updates…");
    await user.keyboard("{Enter}");
    expect(check).toHaveBeenCalledTimes(2);
    await act(async () => first.reject(new Error("offline")));
    expect(screen.getByRole("button", { name: "Retry" })).toBe(action);
    expect(action).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(check).toHaveBeenCalledTimes(3));
    expect(action).toHaveFocus();
    await act(async () => retry.resolve(null));
    expect(screen.getByRole("button", { name: "Check again" })).toBe(action);
    expect(action).toHaveFocus();
    expect(screen.getByRole("status")).toBe(status);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(check).toHaveBeenCalledTimes(4));
    await user.tab();
    expect(action).not.toHaveFocus();
    await act(async () => again.resolve(null));
    expect(action).not.toHaveFocus();
  } finally {
    await act(async () => {
      first.resolve(null);
      retry.resolve(null);
      again.resolve(null);
    });
  }
});

it("keeps focus through download, install and refused restart", async () => {
  const user = userEvent.setup();
  const download = deferred<void>();
  const install = deferred<void>();
  const update = {
    version: "1.2.3",
    download: () => download.promise,
    install: () => install.promise,
    close: async () => {},
  };
  const check = vi
    .fn<UpdatePlatform["check"]>()
    .mockResolvedValueOnce(null)
    .mockResolvedValue(update);
  renderSettings({
    check,
    relaunch: async () => {
      throw new Error("shutdown refused");
    },
  });
  await afterBackgroundCheck(check);
  const action = screen.getByRole("button", { name: "Check for updates" });
  await user.tab();
  try {
    await user.keyboard("{Enter}");
    await screen.findByText("Downloading update…");
    expect(action).toHaveFocus();
    await act(async () => download.resolve());
    expect(screen.getByRole("button", { name: "Update now" })).toBe(action);
    await user.keyboard("{Enter}");
    expect(screen.getByText("Installing update…")).toBeVisible();
    expect(action).toHaveFocus();
    expect(action).toHaveAttribute("aria-busy", "true");
    await act(async () => install.resolve());
    expect(screen.getByText("Update failed: shutdown refused")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBe(action);
    expect(action).toHaveFocus();
  } finally {
    await act(async () => {
      download.resolve();
      install.resolve();
    });
  }
});
