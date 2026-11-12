// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { readView } from "../../shared/view-state";
import { useSidebarView } from "./useSidebarView";

stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
it("keeps the viewport when a child retries a pending reveal during a preserved open", () => {
  function Rows({
    retryReveal,
    current,
  }: {
    retryReveal(): void;
    current: boolean;
  }) {
    const [visible, setVisible] = useState(true);
    useLayoutEffect(() => retryReveal());
    return (
      <>
        <button type="button" onClick={() => setVisible(!visible)}>
          Toggle source
        </button>
        {current && visible && (
          <button type="button" aria-current="page">
            Source
          </button>
        )}
      </>
    );
  }
  function View({ current = false }: { current?: boolean }) {
    const sidebar = useSidebarView(
      "fixture",
      true,
      current ? "source" : "activity",
      current,
    );
    return (
      <>
        <button type="button" onClick={sidebar.revealAgain}>
          Reveal current
        </button>
        <nav ref={sidebar.list} data-testid="viewport">
          <Rows current={current} retryReveal={sidebar.retryReveal} />
        </nav>
      </>
    );
  }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.tagName === "BUTTON"
        ? ({ top: 200, bottom: 220, height: 20 } as DOMRect)
        : ({ top: 0, bottom: 100, height: 100 } as DOMRect);
    },
  );
  const view = render(<View />);
  const viewport = screen.getByTestId("viewport");
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  view.rerender(<View current />);
  expect(viewport.scrollTop).toBe(0);
  fireEvent.click(screen.getByText("Reveal current"));
  expect(viewport.scrollTop).toBe(160);
  fireEvent.click(screen.getByText("Toggle source"));
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  fireEvent.click(screen.getByText("Reveal current"));
  expect(viewport.scrollTop).toBe(0);
  fireEvent.click(screen.getByText("Toggle source"));
  expect(viewport.scrollTop).toBe(160);
});
it("re-arms only explicit current reveals using the latest location and preserves manual scrolling otherwise", () => {
  let sidebar: ReturnType<typeof useSidebarView> | undefined;
  function View({
    location,
    ready,
    preserve = false,
  }: {
    location?: string;
    ready: boolean;
    preserve?: boolean;
  }) {
    sidebar = useSidebarView("fixture", ready, location, preserve);
    return (
      <>
        <button type="button" onClick={sidebar.revealAgain}>
          Reveal current
        </button>
        <nav ref={sidebar.list} data-testid="viewport">
          <button type="button" aria-current="page">
            Current
          </button>
        </nav>
      </>
    );
  }
  const view = render(<View location="X" ready />);
  const viewport = screen.getByTestId("viewport");
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 100,
    height: 100,
  } as DOMRect);
  vi.spyOn(
    screen.getByText("Current"),
    "getBoundingClientRect",
  ).mockReturnValue({ top: 200, bottom: 220, height: 20 } as DOMRect);
  sidebar?.retryReveal();
  expect(viewport.scrollTop).toBe(160);
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  sidebar?.retryReveal();
  expect(viewport.scrollTop).toBe(0);
  fireEvent.click(screen.getByText("Reveal current"));
  expect(viewport.scrollTop).toBe(160);
  view.rerender(<View location="Y" ready={false} />);
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  fireEvent.click(screen.getByText("Reveal current"));
  expect(viewport.scrollTop).toBe(0);
  view.rerender(<View location="Y" ready />);
  fireEvent(window, new Event("pagehide"));
  expect(
    readView<{ location: string }>("fixture", "channel-sidebar", {
      location: "",
    }).location,
  ).toBe("Y");
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  view.rerender(<View ready />);
  fireEvent.click(screen.getByText("Reveal current"));
  expect(viewport.scrollTop).toBe(0);
  view.rerender(<View location="source" ready preserve />);
  sidebar?.retryReveal();
  expect(viewport.scrollTop).toBe(0);
  view.rerender(<View location="source" ready />);
  expect(viewport.scrollTop).toBe(160);
});
