// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeFence } from "./code-blocks";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("updates code Tab eligibility as layout and content change, and cleans up", async () => {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  const draw = (text: string, focusable = true) => (
    <CodeFence copy={false} registry={undefined} focusable={focusable}>
      <code>{text}</code>
    </CodeFence>
  );
  const view = render(draw("short"));
  const code = view.getByText("short");
  let height = 100;
  Object.defineProperties(code, {
    clientHeight: { get: () => 100 },
    scrollHeight: { get: () => height },
  });
  expect(code).toHaveAttribute("tabindex", "-1");

  // Narrowing the pane can wrap a previously short block past its cap.
  height = 200;
  act(resize);
  expect(code).toHaveAttribute("tabindex", "0");
  code.focus();
  // Enlarging the pane removes the stop without moving existing focus.
  height = 100;
  act(resize);
  expect(code).toHaveAttribute("tabindex", "-1");
  expect(code).toHaveFocus();

  // Content updates must be measured even if the capped box stays the same size.
  height = 200;
  view.rerender(draw("longer"));
  await waitFor(() => expect(code).toHaveAttribute("tabindex", "0"));
  height = 100;
  view.rerender(draw("short again"));
  await waitFor(() => expect(code).toHaveAttribute("tabindex", "-1"));

  view.rerender(draw("preview", false));
  expect(disconnect).toHaveBeenCalledTimes(1);
  height = 200;
  await act(async () => view.rerender(draw("preview changed", false)));
  expect(code).not.toHaveAttribute("tabindex");
  view.unmount();
  expect(disconnect).toHaveBeenCalledTimes(1);
});
