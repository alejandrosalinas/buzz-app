// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import {
  SearchChoices,
  SearchStepsContext,
  type SearchDestination,
  type SearchSteps,
  type SearchViews,
} from "./SearchChoices";

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
      unobserve() {}
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
    views={{ resultsLabel: "Channels", place }}
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

it("keeps Peek's group order once the highlight moves, adding late groups at the end", () => {
  const row = (key: string) => ({ key, label: key, icon: ChatCircleIcon, run });
  const peek = { ranked: true, preview: () => null };
  const palette = (groups: { label: string; rows: string[] }[]) => (
    <SearchChoices
      query="lau"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      peek={peek}
      groups={groups.map(({ label, rows }) => ({
        label,
        destinations: rows.map(row),
      }))}
    />
  );
  const order = () =>
    within(screen.getByRole("listbox"))
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
  const { rerender } = render(
    palette([
      { label: "Chats", rows: ["chat"] },
      { label: "People", rows: ["lau"] },
    ]),
  );
  // Untouched, an arrival re-ranks every group.
  rerender(
    palette([
      { label: "People", rows: ["lau"] },
      { label: "Chats", rows: ["chat"] },
    ]),
  );
  expect(order()).toEqual(["People", "Chats"]);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  // Moved, groups shown keep their places and a late one goes last.
  rerender(
    palette([
      { label: "Messages", rows: ["message"] },
      { label: "Chats", rows: ["chat"] },
      { label: "People", rows: ["lau"] },
    ]),
  );
  expect(order()).toEqual(["People", "Chats", "Messages"]);
});

it("puts a group that was still empty when the order froze after the ones shown", () => {
  const row = (key: string) => ({ key, label: key, icon: ChatCircleIcon, run });
  const palette = (groups: { label: string; rows: string[] }[]) => (
    <SearchChoices
      query="lau"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      peek={{ ranked: true, preview: () => null }}
      groups={groups.map(({ label, rows }) => ({
        label,
        destinations: rows.map(row),
      }))}
    />
  );
  const order = () =>
    within(screen.getByRole("listbox"))
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
  // People is still looking: an empty group, not drawn.
  const { rerender } = render(
    palette([
      { label: "Channels", rows: ["channel"] },
      { label: "People", rows: [] },
      { label: "Messages", rows: ["message"] },
    ]),
  );
  expect(order()).toEqual(["Channels", "Messages"]);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  rerender(
    palette([
      { label: "Channels", rows: ["channel"] },
      { label: "People", rows: ["lau"] },
      { label: "Messages", rows: ["message"] },
    ]),
  );
  expect(order()).toEqual(["Channels", "Messages", "People"]);
});

it.each([true, false])(
  "keeps Tab in the field while Peek's groups are landing (busy: %s), and lets it move on once none came",
  (busy) => {
    const action = {
      key: "scope:a",
      label: "Search in Alpha",
      icon: ChatCircleIcon,
      run,
    };
    render(
      <SearchChoices
        query="release plan"
        onQueryChange={() => {}}
        input={createRef<HTMLElement>()}
        isAction={(key) => key.startsWith("scope:")}
        peek={{ ranked: true, busy, preview: () => null }}
        groups={[{ label: "This conversation", destinations: [action] }]}
      />,
    );
    const field = screen.getByRole("combobox");
    // fireEvent returns false when the default (moving focus) was prevented.
    expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(!busy);
    expect(fireEvent.keyDown(field, { key: "Tab", shiftKey: true })).toBe(
      !busy,
    );
  },
);

it("moves Tab through Peek's groups, then on past the last and before the first", () => {
  render(
    <SearchChoices
      query="channel"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      groups={[{ label: "Channels", destinations: destinations.slice(0, 2) }]}
      peek={{ ranked: true, preview: () => null }}
    />,
  );
  const field = screen.getByRole("combobox");
  const shown = () =>
    screen.getByRole("button", { pressed: true }).textContent ?? "";
  expect(shown()).toMatch(/^Top results/);
  // Before the first group, Shift+Tab leaves the field.
  expect(fireEvent.keyDown(field, { key: "Tab", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(false);
  expect(shown()).toMatch(/^Channels/);
  // Past the last group, Tab leaves the field for the controls after it.
  expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(true);
  expect(shown()).toMatch(/^Channels/);
});

it("moves through Peek's groups with Control+L/F and H/B, staying in the field at either end", () => {
  render(
    <SearchChoices
      query="channel"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      groups={[{ label: "Channels", destinations: destinations.slice(0, 2) }]}
      peek={{ ranked: true, preview: () => null }}
    />,
  );
  const field = screen.getByRole("combobox");
  const shown = () =>
    screen.getByRole("button", { pressed: true }).textContent ?? "";
  const control = (key: string) =>
    fireEvent.keyDown(field, { key, ctrlKey: true });
  const pairs = [
    ["l", "h"],
    ["f", "b"],
  ] as const;
  for (const [next, previous] of pairs) {
    expect(control(next)).toBe(false);
    expect(shown()).toMatch(/^Channels/);
    expect(control(next)).toBe(false);
    expect(shown()).toMatch(/^Channels/);
    expect(control(previous)).toBe(false);
    expect(shown()).toMatch(/^Top results/);
    expect(control(previous)).toBe(false);
    expect(shown()).toMatch(/^Top results/);
  }
  // Command and other modifiers keep their own meaning.
  expect(fireEvent.keyDown(field, { key: "l", metaKey: true })).toBe(true);
  expect(
    fireEvent.keyDown(field, { key: "L", ctrlKey: true, shiftKey: true }),
  ).toBe(true);
  expect(shown()).toMatch(/^Top results/);
});

it("leaves Control's group keys to the text without groups to show", () => {
  render(choices({ top: 0, key: "" }));
  const field = screen.getByRole("combobox");
  for (const key of ["l", "f", "h", "b"])
    expect(fireEvent.keyDown(field, { key, ctrlKey: true })).toBe(true);
});

it("keeps an action-only group in place when Peek's order freezes", () => {
  const row = (key: string) => ({ key, label: key, icon: ChatCircleIcon, run });
  const palette = (labels: string[]) => (
    <SearchChoices
      query="a"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      isAction={(key) => key.startsWith("scope:")}
      peek={{ ranked: true, preview: () => null }}
      groups={labels.map((label) => ({
        label,
        destinations: [row(label === "This conversation" ? "scope:a" : label)],
      }))}
    />
  );
  const order = () =>
    within(screen.getByRole("listbox"))
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
  const { rerender } = render(
    palette(["This conversation", "Recent activity"]),
  );
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  rerender(palette(["This conversation", "Recent activity"]));
  expect(order()).toEqual(["This conversation", "Recent activity"]);
});

it("opens an empty Peek on its first group, which Escape leaves search from", () => {
  const row = (key: string) => ({ key, label: key, icon: ChatCircleIcon, run });
  render(
    <SearchChoices
      query=""
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      peek={{ ranked: true, preview: () => null }}
      conversationShortcut={{ key: "f", mod: true }}
      groups={[
        { label: "Unread", destinations: [row("unread")] },
        { label: "Recents", destinations: [row("recent")] },
      ]}
    />,
  );
  const field = screen.getByRole("combobox");
  const shown = () =>
    screen.getByRole("button", { pressed: true }).textContent ?? "";
  // No Top results above it: the first group is the view, shown whole.
  expect(
    screen
      .getAllByRole("button", { pressed: false })
      .map((chip) => chip.textContent),
  ).toEqual([expect.stringMatching(/^Recents/)]);
  expect(shown()).toMatch(/^Unread/);
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual([expect.stringMatching(/^unread/)]);
  // Before the first group, Shift+Tab leaves the field.
  expect(fireEvent.keyDown(field, { key: "Tab", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(false);
  expect(shown()).toMatch(/^Recents/);
  expect(screen.getByText("Back to Unread")).toBeInTheDocument();
  // Escape from another group comes back to the first.
  expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(false);
  expect(shown()).toMatch(/^Unread/);
  // From the first, Escape is left to close search.
  expect(screen.getByText("Close")).toBeInTheDocument();
  expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(true);
  // The chord that searches the current conversation is hinted.
  expect(screen.getByText("This conversation")).toHaveTextContent(
    "Ctrl+F This conversation",
  );
});

it("steps an empty Peek's groups with Control+L and H from its first group, and rows within one with Control+J and K", () => {
  const row = (key: string) => ({ key, label: key, icon: ChatCircleIcon, run });
  render(
    <SearchChoices
      query=""
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      peek={{ ranked: true, preview: () => null }}
      groups={[
        { label: "Unread", destinations: [row("unread-0"), row("unread-1")] },
        { label: "Recents", destinations: [row("recent-0"), row("recent-1")] },
      ]}
    />,
  );
  const field = screen.getByRole("combobox");
  const shown = () =>
    screen.getByRole("button", { pressed: true }).textContent ?? "";
  const highlighted = () =>
    screen.getByRole("option", { selected: true }).textContent;
  const control = (key: string) =>
    fireEvent.keyDown(field, { key, ctrlKey: true });
  // The first group is the view: there is no Top results before it.
  expect(shown()).toMatch(/^Unread/);
  expect(control("h")).toBe(false);
  expect(shown()).toMatch(/^Unread/);
  expect(control("j")).toBe(false);
  expect(highlighted()).toMatch(/^unread-0/);
  expect(control("j")).toBe(false);
  expect(highlighted()).toMatch(/^unread-1/);
  expect(control("l")).toBe(false);
  expect(shown()).toMatch(/^Recents/);
  expect(highlighted()).toMatch(/^recent-0/);
  expect(control("n")).toBe(false);
  expect(highlighted()).toMatch(/^recent-1/);
  expect(control("k")).toBe(false);
  expect(highlighted()).toMatch(/^recent-0/);
  expect(control("f")).toBe(false);
  expect(shown()).toMatch(/^Recents/);
  expect(control("b")).toBe(false);
  expect(shown()).toMatch(/^Unread/);
  expect(highlighted()).toMatch(/^unread-0/);
});

it("draws a long group Peek shows whole near the view, keeping the highlighted row drawn and placed", () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({
    key: `browse:${index}`,
    label: `channel-${index}`,
    icon: ChatCircleIcon,
    run,
  }));
  render(
    <SearchChoices
      query=""
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      peek={{ ranked: true, preview: () => null }}
      groups={[
        {
          label: "Recent activity",
          destinations: [
            { key: "recent", label: "recent", icon: ChatCircleIcon, run },
          ],
        },
        { label: "Channels", browse: true, destinations: rows },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Channels/ }));
  const field = screen.getByRole("combobox");
  for (let press = 0; press < 80; press++)
    fireEvent.keyDown(field, { key: "ArrowDown" });
  // jsdom measures nothing, so virtua leaves the rows it draws hidden: query
  // the DOM. Rows show once measured in a browser.
  const drawn = document.querySelectorAll('[role="option"]');
  expect(drawn.length).toBeLessThan(rows.length);
  const highlighted = document.getElementById(
    field.getAttribute("aria-activedescendant") ?? "",
  );
  expect(highlighted).toHaveTextContent("channel-80");
  expect(highlighted).toHaveAttribute("aria-posinset", "81");
  expect(highlighted).toHaveAttribute("aria-setsize", "120");
});

it("says how much of a group Top results shows and opens the rest from its header", () => {
  render(
    <SearchChoices
      query="channel"
      onQueryChange={() => {}}
      input={createRef<HTMLInputElement>()}
      groups={[
        { label: "Channels", destinations: destinations.slice(0, 6) },
        { label: "Pages", destinations: destinations.slice(6, 8) },
      ]}
      peek={{ ranked: true, preview: () => null }}
    />,
  );
  const field = screen.getByRole("combobox");
  field.focus();
  // Top results counts nothing of its own: it shows only some of each group.
  expect(
    screen.getByRole("button", { name: /^Top results/, pressed: true }),
  ).toHaveTextContent(/^Top results$/);
  const channels = within(screen.getByRole("group", { name: "Channels" }));
  expect(channels.getAllByRole("option")).toHaveLength(5);
  expect(channels.getByRole("heading")).toHaveTextContent(
    "Channels · Top 5 of 6",
  );
  // The heading's cut is hidden from assistive technology; the group says it.
  expect(
    screen.getByRole("group", { name: "Channels" }),
  ).toHaveAccessibleDescription("Top 5 of 6");
  // A group shown whole is not cut, so it has no Show all.
  const pages = within(screen.getByRole("group", { name: "Pages" }));
  expect(pages.getByRole("heading")).toHaveTextContent(/^Pages 2$/);
  expect(
    screen.getByRole("group", { name: "Pages" }),
  ).toHaveAccessibleDescription("");
  expect(pages.queryByRole("button", { name: /^Show all/ })).toBeNull();
  fireEvent.click(channels.getByRole("button", { name: "Show all Channels" }));
  expect(screen.getAllByRole("option")).toHaveLength(6);
  expect(field).toHaveFocus();
});

it("drops a highlight a pinned heading covers, so Enter never opens a hidden row", () => {
  // The cut group's heading is pinned over the first row.
  const box = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
  const rows = box.getMockImplementation();
  box.mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-search-cut")
      ? DOMRect.fromRect({ x: 0, y: 0, width: 300, height: ROW })
      : (rows?.call(this) ?? new DOMRect());
  });
  render(
    <SearchChoices
      query="channel"
      onQueryChange={() => {}}
      input={createRef<HTMLInputElement>()}
      groups={[{ label: "Channels", destinations: destinations.slice(0, 6) }]}
      peek={{ ranked: true, preview: () => null }}
    />,
  );
  expect(screen.getByRole("option", { name: "channel-0" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const scroller = document.querySelector(".search-palette-scroll");
  if (!scroller) throw new Error("No results scroller");
  fireEvent.wheel(scroller);
  fireEvent.scroll(scroller);
  expect(screen.queryByRole("option", { selected: true })).toBeNull();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(run).not.toHaveBeenCalled();
});

it("keeps an attached row with the row above it where Top results cuts a group", () => {
  const attach = (rows: typeof destinations, at: number) =>
    rows.map((row, index) => (index === at ? { ...row, attached: true } : row));
  render(
    <SearchChoices
      query="channel"
      onQueryChange={() => {}}
      input={createRef<HTMLInputElement>()}
      groups={[
        // The lead group shows five rows; the sixth is attached to the fifth.
        { label: "Agents", destinations: attach(destinations.slice(0, 6), 5) },
        // Later groups show three rows; the fourth is attached to the third.
        {
          label: "Channels",
          destinations: attach(destinations.slice(6, 12), 3),
        },
        // Unattached rows past the limit are still cut, here of a group
        // with more to load.
        {
          label: "Pages",
          destinations: destinations.slice(12, 17),
          count: "20+",
        },
      ]}
      peek={{ ranked: true, preview: () => null }}
    />,
  );
  const shown = (label: string) =>
    within(screen.getByRole("group", { name: label }))
      .getAllByRole("option")
      .map((row) => row.textContent);
  expect(shown("Agents")).toEqual(
    destinations.slice(0, 6).map(({ label }) => label),
  );
  expect(
    within(screen.getByRole("group", { name: "Agents" })).queryByRole(
      "button",
      { name: "Show all Agents" },
    ),
  ).toBeNull();
  expect(shown("Channels")).toEqual(
    destinations.slice(6, 10).map(({ label }) => label),
  );
  // The count includes the attached row shown past the cut.
  expect(
    screen.getByRole("group", { name: "Channels" }),
  ).toHaveAccessibleDescription("Top 4 of 6");
  expect(shown("Pages")).toEqual(
    destinations.slice(12, 15).map(({ label }) => label),
  );
  expect(
    within(screen.getByRole("group", { name: "Pages" })).getByRole("heading"),
  ).toHaveTextContent("Pages · Top 3 of 20+");
  expect(
    screen.getByRole("group", { name: "Pages" }),
  ).toHaveAccessibleDescription("Top 3 of 20+");
});

it("still shows an attached row when Top results cuts the row above it", () => {
  // Five rows show; the row above the attached one (index 6) is cut.
  const rows = destinations
    .slice(0, 8)
    .map((row, index) => (index === 6 ? { ...row, attached: true } : row));
  render(
    <SearchChoices
      query="channel"
      onQueryChange={() => {}}
      input={createRef<HTMLInputElement>()}
      groups={[{ label: "Agents", destinations: rows }]}
      peek={{ ranked: true, preview: () => null }}
    />,
  );
  const group = within(screen.getByRole("group", { name: "Agents" }));
  expect(group.getAllByRole("option").map((row) => row.textContent)).toEqual([
    ...destinations.slice(0, 5).map(({ label }) => label),
    "channel-6",
  ]);
  // The rest are still a click away, in their own order.
  fireEvent.click(group.getByRole("button", { name: "Show all Agents" }));
  expect(
    within(screen.getByRole("group", { name: "Agents" }))
      .getAllByRole("option")
      .map((row) => row.textContent),
  ).toEqual(destinations.slice(0, 8).map(({ label }) => label));
});

it("keeps a chosen group while an edited query's results land, and lets it go if they settle without it", () => {
  const peekOf = (query: string, rows: number, busy: boolean) => (
    <SearchChoices
      query={query}
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      groups={[
        { label: "Channels", destinations: destinations.slice(0, 2) },
        { label: "Messages", destinations: destinations.slice(2, 2 + rows) },
      ]}
      peek={{ ranked: true, busy, preview: () => null }}
    />
  );
  const { rerender } = render(peekOf("design", 3, false));
  const shown = () =>
    screen.getByRole("button", { pressed: true }).textContent ?? "";
  fireEvent.click(screen.getByRole("button", { name: /^Messages/ }));
  expect(shown()).toMatch(/^Messages/);
  // Edited, the new text's messages haven't come back yet.
  rerender(peekOf("design crit", 0, true));
  expect(shown()).toMatch(/^Messages/);
  expect(screen.queryByRole("option", { name: "channel-0" })).toBeNull();
  rerender(peekOf("design crit", 2, false));
  expect(shown()).toMatch(/^Messages/);
  expect(screen.getAllByRole("option")).toHaveLength(2);
  // Top results chosen while results land stays chosen once they arrive.
  rerender(peekOf("design critique", 0, true));
  fireEvent.click(screen.getByRole("button", { name: /^Top results/ }));
  rerender(peekOf("design critique", 2, false));
  expect(shown()).toMatch(/^Top results/);
  // A group that settles away is let go, and doesn't come back by itself.
  fireEvent.click(screen.getByRole("button", { name: /^Messages/ }));
  rerender(peekOf("design notes", 0, false));
  expect(shown()).toMatch(/^Top results/);
  rerender(peekOf("design notes", 2, false));
  expect(shown()).toMatch(/^Top results/);
});

it("goes back to Top results on Escape while a chosen group's results land", () => {
  const peekOf = (rows: number, busy: boolean) => (
    <SearchChoices
      query="design"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      groups={[
        { label: "Channels", destinations: destinations.slice(0, 2) },
        { label: "Messages", destinations: destinations.slice(2, 2 + rows) },
      ]}
      peek={{ ranked: true, busy, preview: () => null }}
    />
  );
  const { rerender } = render(peekOf(3, false));
  fireEvent.click(screen.getByRole("button", { name: /^Messages/ }));
  rerender(peekOf(0, true));
  // fireEvent returns false when the default (closing search) was prevented.
  expect(
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" }),
  ).toBe(false);
  rerender(peekOf(3, false));
  expect(
    screen.getByRole("button", { pressed: true }).textContent ?? "",
  ).toMatch(/^Top results/);
});

it("keeps a chosen group while its source hasn't searched the text as typed", () => {
  const peekOf = (rows: number, unsearched?: Record<string, string>) => (
    <SearchChoices
      query="design"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      groups={[
        { label: "Channels", destinations: destinations.slice(0, 2) },
        { label: "Messages", destinations: destinations.slice(2, 2 + rows) },
      ]}
      peek={{ ranked: true, unsearched, preview: () => null }}
    />
  );
  const { rerender } = render(peekOf(3));
  const shown = () =>
    screen.getByRole("button", { pressed: true }).textContent ?? "";
  fireEvent.click(screen.getByRole("button", { name: /^Messages/ }));
  // "design c": the other sources settled, but messages weren't searched.
  rerender(peekOf(0, { Messages: "Type at least 3 characters." }));
  expect(shown()).toMatch(/^Messages/);
  expect(screen.getByText("Type at least 3 characters.")).toBeVisible();
  rerender(peekOf(2));
  expect(shown()).toMatch(/^Messages/);
});

it("lets Escape through once Peek turns off under a chosen group", () => {
  const peekOf = (ranked: boolean, rows: number) => (
    <SearchChoices
      query="design"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      groups={[
        { label: "Channels", destinations: destinations.slice(0, 2) },
        { label: "Messages", destinations: destinations.slice(2, 2 + rows) },
      ]}
      peek={{ ranked, busy: true, preview: () => null }}
    />
  );
  const { rerender } = render(peekOf(true, 3));
  fireEvent.click(screen.getByRole("button", { name: /^Messages/ }));
  // A filter such as `in:` turns Peek off while its results load.
  rerender(peekOf(false, 0));
  expect(screen.queryByRole("group", { name: "Result groups" })).toBeNull();
  // fireEvent returns true when nothing prevented the default (closing).
  expect(
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" }),
  ).toBe(true);
  // Peek back on doesn't bring back the choice it let go.
  rerender(peekOf(true, 3));
  expect(
    screen.getByRole("button", { pressed: true }).textContent ?? "",
  ).toMatch(/^Top results/);
});

it("gives the person's result keys precedence over the field's other keys, consumes them without rows and ignores AltGr", () => {
  const onEditLastChip = vi.fn();
  const field = (
    steps: SearchSteps,
    rows: readonly SearchDestination[] = destinations.slice(0, 3),
  ) => (
    <SearchStepsContext.Provider value={steps}>
      <SearchChoices
        query="channel"
        onQueryChange={() => {}}
        input={createRef<HTMLElement>()}
        chips={[
          {
            operand: "from:ada",
            text: "from:@ada",
            edit: "from:@ada",
            label: "Remove from:@ada",
          },
        ]}
        onEditLastChip={onEditLastChip}
        groups={[{ label: "Channels", destinations: rows }]}
      />
    </SearchStepsContext.Provider>
  );
  const highlighted = () =>
    screen.getByRole("option", { selected: true }).textContent;
  // Ctrl+Shift+1 (⌘⇧1 on a Mac) otherwise opens the first row.
  const view = render(
    field({
      previous: { key: "ArrowUp" },
      next: { key: "!", mod: true, shift: true },
    }),
  );
  const combobox = () => screen.getByRole("combobox");
  expect(highlighted()).toContain("channel-0");
  expect(
    fireEvent.keyDown(combobox(), {
      key: "!",
      code: "Digit1",
      ctrlKey: true,
      shiftKey: true,
    }),
  ).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(highlighted()).toContain("channel-1");
  // Ctrl+Backspace at the start of the text otherwise edits the last chip.
  view.rerender(
    field({
      previous: { key: "Backspace", mod: true },
      next: { key: "ArrowDown" },
    }),
  );
  const input = combobox() as HTMLInputElement;
  input.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: "Backspace", ctrlKey: true });
  expect(onEditLastChip).not.toHaveBeenCalled();
  expect(highlighted()).toContain("channel-0");
  // AltGr can report Control and Alt; it types a character, never a step.
  view.rerender(
    field({
      previous: { key: "ArrowUp" },
      next: { key: "@", mod: true, alt: true },
    }),
  );
  expect(
    fireEvent.keyDown(combobox(), {
      key: "@",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    } as KeyboardEventInit),
  ).toBe(true);
  expect(highlighted()).toContain("channel-0");
  // With no rows, a matched key is still consumed, so it never edits.
  view.rerender(
    field(
      { previous: { key: "k", mod: true }, next: { key: "ArrowDown" } },
      [],
    ),
  );
  expect(fireEvent.keyDown(combobox(), { key: "k", ctrlKey: true })).toBe(
    false,
  );
});

it("steps through results with Control+J/N and K/P after the person's own keys", () => {
  const view = render(choices({ top: 0, key: "" }, destinations.slice(0, 3)));
  const field = () => screen.getByRole("combobox");
  const highlighted = () =>
    screen.getByRole("option", { selected: true }).textContent;
  const control = (key: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(field(), { key, ctrlKey: true, ...init });
  expect(highlighted()).toContain("channel-0");
  expect(control("j")).toBe(false);
  expect(highlighted()).toContain("channel-1");
  expect(control("n")).toBe(false);
  expect(highlighted()).toContain("channel-2");
  expect(control("k")).toBe(false);
  expect(highlighted()).toContain("channel-1");
  expect(control("p")).toBe(false);
  expect(highlighted()).toContain("channel-0");
  // Command, Shift, Alt, AltGr and composition never step.
  for (const init of [
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { modifierAltGraph: true },
    { isComposing: true },
    { keyCode: 229 },
  ] as KeyboardEventInit[])
    expect(control("j", init)).toBe(true);
  expect(highlighted()).toContain("channel-0");
  // A key the person chose for the other step wins (jsdom is not a Mac,
  // so Mod is Control).
  view.rerender(
    <SearchStepsContext.Provider
      value={{ previous: { key: "j", mod: true }, next: { key: "ArrowDown" } }}
    >
      {choices({ top: 0, key: "" }, destinations.slice(0, 3))}
    </SearchStepsContext.Provider>,
  );
  fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(highlighted()).toContain("channel-1");
  expect(control("j")).toBe(false);
  expect(highlighted()).toContain("channel-0");
});

it("reports the first move for each text, with or without a preview", () => {
  const onMove = vi.fn();
  const palette = (query: string) => (
    <SearchChoices
      query={query}
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      peek={{ ranked: false, onMove }}
      groups={[{ label: "Messages", destinations }]}
    />
  );
  const { rerender } = render(palette("deploy"));
  expect(onMove).not.toHaveBeenCalled();
  const field = screen.getByRole("combobox");
  fireEvent.keyDown(field, { key: "ArrowDown" });
  fireEvent.keyDown(field, { key: "ArrowDown" });
  expect(onMove).toHaveBeenCalledOnce();
  rerender(palette("deploys"));
  expect(onMove).toHaveBeenCalledOnce();
  fireEvent.keyDown(field, { key: "ArrowDown" });
  expect(onMove).toHaveBeenCalledTimes(2);
});

it("reports a move before choosing the highlighted row, so the order shown holds", () => {
  const onMove = vi.fn();
  render(
    <SearchChoices
      query="deploy"
      onQueryChange={() => {}}
      input={createRef<HTMLElement>()}
      peek={{ ranked: false, onMove }}
      groups={[{ label: "Messages", destinations }]}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(run).toHaveBeenCalledWith(0);
  expect(onMove).toHaveBeenCalledOnce();
  expect(onMove.mock.invocationCallOrder[0]).toBeLessThan(
    run.mock.invocationCallOrder.at(-1) ?? 0,
  );
});
