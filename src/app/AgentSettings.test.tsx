// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { AgentSettings } from "./AgentSettings";
import {
  rememberAgentsPreference,
  setRememberAgentsPreference,
} from "../features/messages/mention-preferences";
import { ownerChoices } from "../features/agents/prompt-sections";
import type { Agents } from "../features/agents/service";
import { localStore } from "../features/agents/store";
import {
  bindKeepAwake,
  keepAwakePreference,
  setKeepAwakePreference,
} from "../features/agents/keep-awake";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setRememberAgentsPreference(true);
  setKeepAwakePreference({ mode: "off", after: 60 });
  localStorage.clear();
});

it("offers keeping the Mac awake only where the app can, with a wait after agents finish", async () => {
  const user = userEvent.setup();
  const view = render(<AgentSettings keepAwakeAvailable={false} />, {
    wrapper: ToastProvider,
  });
  expect(
    screen.queryByRole("combobox", { name: "Keep this Mac awake" }),
  ).not.toBeInTheDocument();
  view.rerender(<AgentSettings keepAwakeAvailable />);
  const mode = screen.getByRole("combobox", { name: "Keep this Mac awake" });
  expect(mode).toHaveTextContent("Off");
  await user.click(mode);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Off", "While agents work", "Always"]);
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("combobox", { name: "Stay awake after agents finish" }),
  ).not.toBeInTheDocument();
  await user.click(mode);
  await user.click(
    await screen.findByRole("option", { name: "While agents work" }),
  );
  const after = screen.getByRole("combobox", {
    name: "Stay awake after agents finish",
  });
  expect(after).toHaveTextContent("1 hour");
  await user.click(after);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual([
    "30 minutes",
    "1 hour",
    "2 hours",
    "4 hours",
    "8 hours",
    "12 hours",
  ]);
  await user.click(screen.getByRole("option", { name: "8 hours" }));
  expect(keepAwakePreference()).toEqual({ mode: "auto", after: 480 });
  expect(localStorage.getItem("buzz-keep-awake.v1")).toBe(
    JSON.stringify({ mode: "auto", after: 480 }),
  );
});

it("shows the base instructions, kept in the agents' storage", async () => {
  const user = userEvent.setup();
  const types: never[] = [];
  const storage = localStore();
  render(
    <AgentSettings
      keepAwakeAvailable={false}
      agents={
        {
          subscribe: () => () => {},
          types: () => types,
          storage,
        } as unknown as Agents
      }
    />,
    { wrapper: ToastProvider },
  );
  await user.click(screen.getByRole("combobox", { name: "Progress" }));
  await user.click(await screen.findByRole("option", { name: "Off" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(ownerChoices(storage)).toEqual({ progress: { mode: "off" } }),
  );
});

it("says when the Mac can't be kept awake and retries the same choice", async () => {
  const user = userEvent.setup();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const hold = vi.fn(async (_: boolean) => {});
  const stop = bindKeepAwake(
    { isWorking: () => false, subscribeWorking: () => () => {} },
    hold,
  );
  try {
    render(<AgentSettings keepAwakeAvailable />, { wrapper: ToastProvider });
    hold.mockRejectedValueOnce(new Error("refused"));
    await user.click(
      screen.getByRole("combobox", { name: "Keep this Mac awake" }),
    );
    await user.click(await screen.findByRole("option", { name: "Always" }));
    expect(
      await screen.findByText("Couldn’t keep this Mac awake"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Couldn’t keep this Mac awake"),
      ).not.toBeInTheDocument(),
    );
    expect(hold.mock.calls).toEqual([[false], [true], [true]]);
    expect(keepAwakePreference().mode).toBe("on");
  } finally {
    stop();
  }
});

it("shows one keep-awake notice at a time, the Mac's state first", async () => {
  const user = userEvent.setup();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const hold = vi.fn(async (_: boolean) => {});
  const stop = bindKeepAwake(
    { isWorking: () => false, subscribeWorking: () => () => {} },
    hold,
  );
  try {
    render(<AgentSettings keepAwakeAvailable />, { wrapper: ToastProvider });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("full");
      });
    hold.mockRejectedValueOnce(new Error("refused"));
    await user.click(
      screen.getByRole("combobox", { name: "Keep this Mac awake" }),
    );
    await user.click(await screen.findByRole("option", { name: "Always" }));
    expect(
      await screen.findByText("Couldn’t keep this Mac awake"),
    ).toBeVisible();
    expect(
      screen.queryByText("Keep-awake setting wasn’t saved"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(
      1,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("Keep-awake setting wasn’t saved"),
    ).toBeVisible();
    expect(
      screen.queryByText("Couldn’t keep this Mac awake"),
    ).not.toBeInTheDocument();
    setItem.mockRestore();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Keep-awake setting wasn’t saved"),
      ).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem("buzz-keep-awake.v1")).toBe(
      JSON.stringify({ mode: "on", after: 60 }),
    );
  } finally {
    stop();
  }
});

it("defaults on, persists opt-out, and follows another window's preference", async () => {
  const user = userEvent.setup();
  render(<AgentSettings />, {
    wrapper: ToastProvider,
  });
  const toggle = () =>
    screen.getByRole("switch", { name: "Remember mentioned agents" });
  expect(toggle()).toBeChecked();
  await user.click(toggle());
  expect(rememberAgentsPreference()).toBe(false);
  cleanup();
  render(<AgentSettings />, {
    wrapper: ToastProvider,
  });
  expect(toggle()).not.toBeChecked();
  act(() => {
    localStorage.removeItem("buzz-remember-mentioned-agents.v1");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-remember-mentioned-agents.v1" }),
    );
  });
  expect(toggle()).toBeChecked();
});

it("keeps an unsaved opt-out effective and offers retry without changing the choice", async () => {
  const user = userEvent.setup();
  const view = render(<AgentSettings />, {
    wrapper: ToastProvider,
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage unavailable");
    });
  await user.click(
    screen.getByRole("switch", { name: "Remember mentioned agents" }),
  );
  expect(rememberAgentsPreference()).toBe(false);
  expect(screen.getByRole("dialog")).toHaveTextContent("could not be saved");
  view.rerender(<AgentSettings active={false} />);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  view.rerender(<AgentSettings />);
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "could not be saved",
  );
  write.mockRestore();
  await user.click(
    screen.getByRole("button", { name: "Retry saving mentioned agents" }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(localStorage.getItem("buzz-remember-mentioned-agents.v1")).toBe("off");
});

it("does not prefill when storage cannot be read", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(rememberAgentsPreference()).toBe(false);
});
