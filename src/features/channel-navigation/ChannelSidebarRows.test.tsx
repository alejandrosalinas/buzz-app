// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelSidebarRows } from "./ChannelSidebarRows";

// Motion captures RAF at import; route it through the test-controlled clock.
vi.hoisted(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    window.clearTimeout(id),
  );
});

afterEach(async () => {
  cleanup();
  // Do not strand Motion's captured frame callback when restoring real timers.
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function rows(ids: string[]) {
  return (
    <ChannelSidebarRows open>
      {ids.map((id) => (
        <button type="button" key={id}>
          {id}
        </button>
      ))}
    </ChannelSidebarRows>
  );
}

it("shows initial rows immediately and preserves their nodes and focus on reorder", async () => {
  const view = render(rows(["alpha", "beta"]));
  const alpha = screen.getByRole("button", { name: "alpha" });
  expect(alpha.parentElement).toHaveStyle({ opacity: "1" });
  alpha.focus();
  view.rerender(rows(["beta", "alpha"]));
  await waitFor(() =>
    expect(screen.getAllByRole("button")).toEqual([
      screen.getByRole("button", { name: "beta" }),
      alpha,
    ]),
  );
  expect(alpha).toHaveFocus();
});

it("applies the latest order when more activity arrives during a move", async () => {
  const view = render(rows(["alpha", "beta", "gamma"]));
  view.rerender(rows(["beta", "alpha", "gamma"]));
  view.rerender(rows(["gamma", "beta", "alpha"]));
  await waitFor(() =>
    expect(
      screen.getAllByRole("button").map((node) => node.textContent),
    ).toEqual(["gamma", "beta", "alpha"]),
  );
  await waitFor(() =>
    expect(view.container.firstElementChild).toHaveStyle({ opacity: "1" }),
  );
  expect(screen.getAllByRole("button").map((node) => node.textContent)).toEqual(
    ["gamma", "beta", "alpha"],
  );
});

it("cancels a distant fade when the desired order returns to the displayed order", async () => {
  vi.useFakeTimers();
  const original = ["alpha", "beta", "gamma", "delta", "echo"];
  const view = render(rows(original));
  const order = () =>
    screen.getAllByRole("button").map((node) => node.textContent);
  const echo = screen.getByRole("button", { name: "echo" });
  const promoted = ["echo", "alpha", "beta", "gamma", "delta"];
  echo.focus();
  view.rerender(rows(promoted));
  await act(() => vi.advanceTimersByTimeAsync(200));
  await act(() => vi.advanceTimersByTimeAsync(30));
  expect(order()).toEqual(original);
  expect(Number(echo.parentElement?.style.opacity)).toBeGreaterThan(0);
  expect(Number(echo.parentElement?.style.opacity)).toBeLessThan(1);

  view.rerender(rows(original));
  for (let elapsed = 0; elapsed < 1000; elapsed += 20) {
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(order()).toEqual(original);
  }
  expect(echo.parentElement).toHaveStyle({ opacity: "1" });
  expect(echo).toHaveFocus();

  // Cancellation must leave the next prepared fade free to finish normally.
  view.rerender(rows(promoted));
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(order()).toEqual(original);
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(order()).toEqual(promoted);
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(echo.parentElement).toHaveStyle({ opacity: "1" });
  expect(screen.getByRole("button", { name: "echo" })).toBe(echo);
  expect(echo).toHaveFocus();
});

it("preserves the stationary middle row and its appearance when neighbors swap", async () => {
  const view = render(rows(["alpha", "beta", "gamma"]));
  const beta = screen.getByRole("button", { name: "beta" });
  expect(beta.parentElement).toHaveStyle({ opacity: "1" });
  view.rerender(rows(["gamma", "beta", "alpha"]));
  await waitFor(() =>
    expect(
      screen.getAllByRole("button").map((node) => node.textContent),
    ).toEqual(["gamma", "beta", "alpha"]),
  );
  expect(screen.getAllByRole("button")[1]).toBe(beta);
  expect(beta.parentElement).toHaveStyle({ opacity: "1" });
});

it("retires an exiting row from interaction and accessibility before its fade ends", async () => {
  const view = render(rows(["alpha", "beta"]));
  const alpha = screen.getByRole("button", { name: "alpha" });
  view.rerender(rows(["beta"]));
  expect(alpha.parentElement).toHaveAttribute("inert");
  expect(alpha.parentElement).toHaveAttribute("aria-hidden", "true");
  expect(
    screen.queryByRole("button", { name: "alpha" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(alpha).not.toBeInTheDocument());
});

it("restores a row that reappears during its exit without replacing its node", async () => {
  const view = render(rows(["alpha", "beta"]));
  const alpha = screen.getByRole("button", { name: "alpha" });
  view.rerender(rows(["beta"]));
  expect(alpha.parentElement).toHaveAttribute("inert");
  view.rerender(rows(["beta", "alpha"]));
  expect(screen.getByRole("button", { name: "alpha" })).toBe(alpha);
  expect(alpha.parentElement).not.toHaveAttribute("inert");
  await waitFor(() =>
    expect(alpha.parentElement).toHaveStyle({ opacity: "1" }),
  );
});

it("combines a burst into the latest order after a quiet period", async () => {
  vi.useFakeTimers();
  const view = render(rows(["alpha", "beta", "gamma"]));
  const order = () =>
    screen.getAllByRole("button").map((node) => node.textContent);
  view.rerender(rows(["beta", "alpha", "gamma"]));
  await act(() => vi.advanceTimersByTimeAsync(150));
  view.rerender(rows(["gamma", "alpha", "beta"]));
  await act(() => vi.advanceTimersByTimeAsync(199));
  expect(order()).toEqual(["alpha", "beta", "gamma"]);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(order()).toEqual(["gamma", "alpha", "beta"]);
});

it("bounds batching latency during continuous activity", async () => {
  vi.useFakeTimers();
  const view = render(rows(["alpha", "beta", "gamma"]));
  const targets = [
    ["beta", "alpha", "gamma"],
    ["gamma", "beta", "alpha"],
    ["beta", "gamma", "alpha"],
    ["gamma", "alpha", "beta"],
  ];
  for (const [index, target] of targets.entries()) {
    if (index) await act(() => vi.advanceTimersByTimeAsync(150));
    view.rerender(rows(target));
  }
  await act(() => vi.advanceTimersByTimeAsync(149));
  expect(screen.getAllByRole("button").map((node) => node.textContent)).toEqual(
    ["alpha", "beta", "gamma"],
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.getAllByRole("button").map((node) => node.textContent)).toEqual(
    targets.at(-1),
  );
});

it("follows reduced-motion changes while mounted and removes its subscription", async () => {
  vi.useFakeTimers();
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  const remove = vi.spyOn(media, "removeEventListener");
  const view = render(rows(["alpha", "beta", "gamma"]));
  const order = () =>
    screen.getAllByRole("button").map((node) => node.textContent);
  const preference = (matches: boolean) =>
    act(() => {
      media.matches = matches;
      media.dispatchEvent(new Event("change"));
    });

  view.rerender(rows(["beta", "alpha", "gamma"]));
  expect(order()).toEqual(["alpha", "beta", "gamma"]);
  preference(true);
  expect(order()).toEqual(["beta", "alpha", "gamma"]);
  view.rerender(rows(["gamma", "beta", "alpha"]));
  expect(order()).toEqual(["gamma", "beta", "alpha"]);

  preference(false);
  view.rerender(rows(["alpha", "beta", "gamma"]));
  await act(() => vi.advanceTimersByTimeAsync(199));
  expect(order()).toEqual(["gamma", "beta", "alpha"]);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(order()).toEqual(["alpha", "beta", "gamma"]);
  view.unmount();
  expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
});

it("re-renders only rows whose element props changed", () => {
  const renders = vi.fn();
  function Row({ id, unread }: { id: string; unread: number }) {
    renders(id);
    return <button type="button">{`${id} ${unread}`}</button>;
  }
  const list = (unread: Record<string, number>) => (
    <ChannelSidebarRows open>
      {Object.entries(unread).map(([id, count]) => (
        <Row key={id} id={id} unread={count} />
      ))}
    </ChannelSidebarRows>
  );
  const view = render(list({ alpha: 0, beta: 0 }));
  renders.mockClear();
  view.rerender(list({ alpha: 0, beta: 0 }));
  expect(renders).not.toHaveBeenCalled();
  view.rerender(list({ alpha: 0, beta: 1 }));
  expect(renders.mock.calls).toEqual([["beta"]]);
  expect(screen.getByRole("button", { name: "beta 1" })).toBeInTheDocument();
});
