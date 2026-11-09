// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import { SearchChoices, type SearchViews } from "./SearchChoices";

const ROW = 40;
const VIEW = 200;
let scrollTop = 0;
// jsdom has no layout: rows stack 40px apart in a 200px scrolled view.
beforeEach(() => {
  scrollTop = 0;
  run.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return this.classList.contains("search-palette-scroll") ? scrollTop : 0;
    },
    set(value: number) {
      if (this.classList.contains("search-palette-scroll")) scrollTop = value;
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const index = [...document.querySelectorAll('[role="option"]')].indexOf(
        this,
      );
      const top = index < 0 ? 0 : index * ROW - scrollTop;
      const height = index < 0 ? VIEW : ROW;
      return DOMRect.fromRect({ x: 0, y: top, width: 300, height });
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
});

const run = vi.fn();
const destinations = Array.from({ length: 20 }, (_, index) => ({
  key: `row-${index}`,
  label: `channel-${index}`,
  icon: ChatCircleIcon,
  run: () => run(index),
}));
const choices = (place: SearchViews["place"], rows = destinations) => (
  <SearchChoices
    query=""
    onQueryChange={() => {}}
    input={createRef<HTMLElement>()}
    highlightEmpty
    views={{
      tabs: null,
      resultsLabel: "Channels",
      panelId: "search-view-channels",
      onSwitch: () => {},
      place,
    }}
    groups={[{ label: "Channels", destinations: rows }]}
  />
);

it("forgets a highlight scrolled out of view, so Enter never opens a hidden row", () => {
  const place = { top: 0, key: "" };
  const first = render(choices(place));
  expect(screen.getByRole("option", { name: "channel-0" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const scroller = document.querySelector(".search-palette-scroll");
  if (!scroller) throw new Error("No results scroller");
  // Scrolled by wheel, then dismissed without choosing.
  fireEvent.wheel(scroller);
  scrollTop = 400;
  fireEvent.scroll(scroller);
  expect(place).toMatchObject({ top: 400, key: "" });
  first.unmount();
  render(choices(place));
  expect(screen.queryByRole("option", { selected: true })).toBeNull();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(run).not.toHaveBeenCalled();
});

it("drops a highlight scrolled out of view while open, and arrows bring one back", () => {
  render(choices({ top: 0, key: "" }));
  const field = screen.getByRole("combobox");
  const scroller = document.querySelector(".search-palette-scroll");
  if (!scroller) throw new Error("No results scroller");
  fireEvent.wheel(scroller);
  scrollTop = 400;
  fireEvent.scroll(scroller);
  expect(screen.queryByRole("option", { selected: true })).toBeNull();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(run).not.toHaveBeenCalled();
  // The keyboard still picks a row, which reveals itself.
  fireEvent.keyDown(field, { key: "ArrowDown" });
  expect(screen.getByRole("option", { selected: true })).toBeVisible();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(run).toHaveBeenCalledTimes(1);
});

it("keeps a highlight still in view at the kept place", () => {
  const place = { top: 0, key: "" };
  const first = render(choices(place));
  const field = screen.getByRole("combobox");
  for (let step = 0; step < 6; step += 1)
    fireEvent.keyDown(field, { key: "ArrowDown" });
  const scroller = document.querySelector(".search-palette-scroll");
  if (!scroller) throw new Error("No results scroller");
  fireEvent.wheel(scroller);
  scrollTop = 160;
  fireEvent.scroll(scroller);
  expect(place).toMatchObject({ top: 160, key: "row-6" });
  first.unmount();
  render(choices(place));
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(run).toHaveBeenCalledWith(6);
});

it("reopens on the same rows when their order changed while closed", () => {
  const place = { top: 0, key: "" };
  const first = render(choices(place));
  const field = screen.getByRole("combobox");
  for (let step = 0; step < 11; step += 1)
    fireEvent.keyDown(field, { key: "ArrowDown" });
  const scroller = document.querySelector(".search-palette-scroll");
  if (!scroller) throw new Error("No results scroller");
  fireEvent.wheel(scroller);
  scrollTop = 400;
  fireEvent.scroll(scroller);
  // row-10 tops the view; row-11, highlighted, is just below it.
  expect(place).toMatchObject({
    key: "row-11",
    anchor: { key: "row-10", offset: 0 },
  });
  first.unmount();
  // Reopened in reverse: row-10 now sits ninth, and row-11 above it.
  render(choices(place, [...destinations].reverse()));
  expect(scrollTop).toBe(360);
  // The highlighted row is above the view now, so Enter picks nothing.
  expect(screen.queryByRole("option", { selected: true })).toBeNull();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(run).not.toHaveBeenCalled();
});

it("keeps a footer below the results, outside their scrollport, so it stays in view", () => {
  render(
    <SearchChoices
      query="beta"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      groups={[{ label: "Channels", destinations }]}
      footer={<p>Only saved conversations are searched.</p>}
    >
      <p>Loading joined conversations…</p>
    </SearchChoices>,
  );
  const footer = screen.getByText("Only saved conversations are searched.");
  const scroll = document.querySelector<HTMLElement>(".search-palette-scroll");
  if (!scroll) throw new Error("no results scrollport");
  // Status that belongs with the rows still scrolls with them.
  expect(scroll).toContainElement(
    screen.getByText("Loading joined conversations…"),
  );
  expect(scroll).not.toContainElement(footer);
  expect(screen.getByRole("listbox")).not.toContainElement(footer);
  // It follows the results in reading order, never as a row.
  expect(
    scroll.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(footer.closest("[data-search-palette]")).toHaveAttribute(
    "data-search-footer",
  );
});
