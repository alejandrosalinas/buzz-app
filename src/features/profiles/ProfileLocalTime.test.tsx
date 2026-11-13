// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setClockPreference } from "../../shared/clock-preference";
import { ProfileLocalTime } from "./ProfileLocalTime";

afterEach(() => {
  cleanup();
  setClockPreference({ localTimeDetails: true });
  vi.useRealTimers();
});

it("refreshes at each minute boundary and stops when unmounted", () => {
  vi.useFakeTimers({ now: new Date("2026-01-15T15:41:30Z") });
  const view = render(
    <ProfileLocalTime timeZone="UTC" className="local-time" />,
  );
  const time = () => screen.getByText(/local time/).textContent;
  expect(time()).toMatch(/3:41|15:41/);
  act(() => vi.advanceTimersByTime(29_999));
  expect(time()).toMatch(/3:41|15:41/);
  act(() => vi.advanceTimersByTime(1));
  expect(time()).toMatch(/3:42|15:42/);
  act(() => vi.advanceTimersByTime(60_000));
  expect(time()).toMatch(/3:43|15:43/);
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("renders nothing and schedules nothing for an unknown zone", () => {
  vi.useFakeTimers({ now: new Date("2026-01-15T15:41:30Z") });
  const { container } = render(
    <ProfileLocalTime timeZone="Mars/Olympus" className="local-time" />,
  );
  expect(container).toBeEmptyDOMElement();
  expect(vi.getTimerCount()).toBe(0);
});

it("adds the difference and the zone on its own line unless details are off", () => {
  const view = render(
    <ProfileLocalTime timeZone="Pacific/Kiritimati" className="local-time" />,
  );
  expect(screen.getByText("Pacific/Kiritimati")).toBeVisible();
  expect(screen.getByText(/local time/).textContent).toMatch(/ahead$/);
  act(() => setClockPreference({ localTimeDetails: false }));
  expect(screen.queryByText("Pacific/Kiritimati")).toBeNull();
  expect(screen.getByText(/local time/).textContent).toMatch(/local time$/);
  view.unmount();
});

it("catches up when the window returns after sleep", () => {
  vi.useFakeTimers({ now: new Date("2026-01-15T15:41:30Z") });
  render(<ProfileLocalTime timeZone="UTC" className="local-time" />);
  const time = () => screen.getByText(/local time/).textContent;
  expect(time()).toMatch(/3:41|15:41/);
  // Asleep: the clock moves on without the timer firing.
  vi.setSystemTime(new Date("2026-01-15T18:05:10Z"));
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(time()).toMatch(/6:05|18:05/);
  expect(vi.getTimerCount()).toBe(1);
});
