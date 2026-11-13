// @vitest-environment jsdom
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  setClockPreference,
  useClockFormat,
  useClockPreference,
} from "./clock-preference";
import { formatFullTimestamp, formatTime } from "./datetime";

const native = vi.hoisted(() => ({ cycle: "h23" as string | null }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async (command: string) =>
    command === "system_hour_cycle" ? native.cycle : undefined,
  ),
}));
vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });

const afternoon = new Date(2026, 6, 30, 14, 5, 9).getTime() / 1_000;

afterEach(() => {
  setClockPreference({ hourCycle: "system", seconds: false });
  native.cycle = "h23";
});

it("System follows the macOS 24-hour setting and re-reads it on focus", async () => {
  const hook = renderHook(() => useClockPreference());
  await waitFor(() => expect(formatTime(afternoon)).toBe("14:05"));
  native.cycle = "h12";
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(formatTime(afternoon)).toMatch(/^2:05\sPM$/));
  hook.unmount();
});

it("re-renders a choice that matches the system's cycle", async () => {
  const hook = renderHook(() => useClockPreference());
  await waitFor(() => expect(formatTime(afternoon)).toBe("14:05"));
  act(() => setClockPreference({ hourCycle: "h23" }));
  expect(hook.result.current.hourCycle).toBe("h23");
  act(() => setClockPreference({ hourCycle: "system" }));
  expect(hook.result.current.hourCycle).toBe("system");
  hook.unmount();
});

it("an explicit clock overrides the system and can show seconds", async () => {
  const hook = renderHook(() => useClockPreference());
  await waitFor(() => expect(formatTime(afternoon)).toBe("14:05"));
  act(() => setClockPreference({ hourCycle: "h12", seconds: true }));
  expect(hook.result.current).toMatchObject({
    hourCycle: "h12",
    seconds: true,
  });
  expect(formatTime(afternoon)).toMatch(/^2:05:09\sPM$/);
  expect(formatFullTimestamp(afternoon)).toMatch(/2:05:09\sPM/);
  expect(JSON.parse(localStorage.getItem("buzz-clock.v1") ?? "")).toEqual({
    hourCycle: "h12",
    seconds: true,
    messageTimestamps: "show",
    localTimeDetails: true,
  });
  hook.unmount();
});

it("re-renders a formatted time when the clock changes", async () => {
  function Stamp() {
    useClockFormat();
    return <time>{formatTime(afternoon)}</time>;
  }
  render(<Stamp />);
  await waitFor(() => expect(screen.getByText("14:05")).toBeTruthy());
  act(() => setClockPreference({ hourCycle: "h12" }));
  expect(screen.getByText(/^2:05\sPM$/)).toBeTruthy();
});
