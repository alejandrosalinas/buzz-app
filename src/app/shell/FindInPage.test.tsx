// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createShortcutBindings } from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { FindInPage } from "./FindInPage";

// jsdom has neither the Custom Highlight API nor layout.
class FakeHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges);
  }
}
const highlights = new Map<string, FakeHighlight>();
const scrolled = vi.fn();
const painted = (name: string) =>
  [...(highlights.get(name) ?? [])].map((range) => ({
    text: range.toString(),
    in: range.startContainer.parentElement?.id,
  }));

let dispose: () => Promise<void>;
beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", FakeHighlight);
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrolled,
  });
});
afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  await dispose();
  highlights.clear();
  scrolled.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(content: React.ReactNode) {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(ctx, window, bindings);
  dispose = async () => {
    bindings.dispose();
    await ctx.fiber.dispose();
  };
  const user = userEvent.setup();
  const view = render(
    <>
      {content}
      <FindInPage shortcuts={shortcuts} />
    </>,
  );
  return { user, view, shortcuts };
}
// jsdom maps no implicit role to <search>, so query the element itself.
const findBar = () => document.querySelector("search");
const field = () => screen.getByRole("searchbox", { name: "Find on screen" });

it("finds as you type, steps with Enter and Shift+Enter, and Escape restores focus", async () => {
  const { user, shortcuts } = setup(
    <main>
      <p id="one">buzz and Buzz</p>
      <p id="two">more buzz</p>
      <textarea aria-label="Message" defaultValue="buzz draft" />
    </main>,
  );
  expect(
    shortcuts.hostSnapshot().find((entry) => entry.id === "find-in-page"),
  ).toMatchObject({ title: "Find on screen" });
  const composer = screen.getByRole("textbox", { name: "Message" });
  await user.click(composer);
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  expect(field()).toHaveFocus();

  // One input event: no intermediate search to race the assertions.
  await user.paste("BUZZ");
  // The composer's draft is not on-screen text to find.
  expect(await screen.findByText("1 of 3")).toBeInTheDocument();
  expect(painted("buzz-find-active")).toEqual([{ text: "buzz", in: "one" }]);
  expect(painted("buzz-find")).toEqual([
    { text: "Buzz", in: "one" },
    { text: "buzz", in: "two" },
  ]);
  // The highlight styles apply only under this attribute.
  expect(document.documentElement).toHaveAttribute("data-find-on-screen");

  await user.keyboard("{Enter}");
  expect(screen.getByText("2 of 3")).toBeInTheDocument();
  expect(painted("buzz-find-active")).toEqual([{ text: "Buzz", in: "one" }]);
  await user.keyboard("{Enter}{Enter}");
  expect(screen.getByText("1 of 3")).toBeInTheDocument();
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(screen.getByText("3 of 3")).toBeInTheDocument();
  expect(painted("buzz-find-active")).toEqual([{ text: "buzz", in: "two" }]);
  expect(scrolled).toHaveBeenLastCalledWith({
    block: "center",
    inline: "nearest",
  });

  await user.keyboard("{Escape}");
  expect(findBar()).not.toBeInTheDocument();
  expect(highlights.size).toBe(0);
  expect(document.documentElement).not.toHaveAttribute("data-find-on-screen");
  expect(composer).toHaveFocus();
});

it("reports no results, recounts as content arrives, and reopening selects the query", async () => {
  const { user } = setup(
    <main id="timeline">
      <p>hello</p>
    </main>,
  );
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  await user.paste("relay");
  expect(await screen.findByText("No results")).toBeInTheDocument();

  const arrived = document.createElement("p");
  arrived.textContent = "relay message";
  act(() => screen.getByRole("main").append(arrived));
  expect(await screen.findByText("1 of 1")).toBeInTheDocument();
  // New messages recount without pulling the reader's scroll.
  expect(scrolled).not.toHaveBeenCalled();

  field().blur();
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  const input = field() as HTMLInputElement;
  expect(input).toHaveFocus();
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
});

it("searches inside an open dialog, and Escape leaves the dialog open", async () => {
  const onOpenChange = vi.fn();
  const { user } = setup(
    <>
      <p>behind the dialog: topic</p>
      <Dialog open title="Members" onOpenChange={onOpenChange}>
        <p id="inside">dialog topic</p>
      </Dialog>
    </>,
  );
  const dialog = await screen.findByRole("dialog", { name: "Members" });
  await waitFor(() =>
    expect(dialog).toContainElement(document.activeElement as HTMLElement),
  );
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  expect(dialog).toContainElement(findBar() as HTMLElement | null);
  expect(findBar()).toBeInTheDocument();
  expect(field()).toHaveFocus();

  await user.paste("topic");
  expect(await screen.findByText("1 of 1")).toBeInTheDocument();
  expect(painted("buzz-find-active")).toEqual([
    { text: "topic", in: "inside" },
  ]);

  await user.keyboard("{Escape}");
  expect(findBar()).not.toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(dialog).toBeInTheDocument();
});

it("still counts and scrolls without the Custom Highlight API", async () => {
  vi.stubGlobal("CSS", {});
  const { user } = setup(<p>one match</p>);
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  await user.paste("match");
  expect(await screen.findByText("1 of 1")).toBeInTheDocument();
  expect(scrolled).toHaveBeenCalled();
});

it("follows a dialog that opens and closes while it is open", async () => {
  function Page() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open members
        </button>
        <p id="page">page topic</p>
        <Dialog open={open} title="Members" onOpenChange={setOpen}>
          <p id="inside">dialog topic</p>
        </Dialog>
      </>
    );
  }
  const { user } = setup(<Page />);
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  await user.paste("topic");
  expect(await screen.findByText("1 of 1")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Open members" }));
  const dialog = await screen.findByRole("dialog", { name: "Members" });
  // The bar moves into the modal, where it stays reachable, and searches it.
  await waitFor(() => expect(dialog).toContainElement(findBar()));
  await waitFor(() =>
    expect(painted("buzz-find-active")).toEqual([
      { text: "topic", in: "inside" },
    ]),
  );

  await user.keyboard("{Escape}");
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(findBar()).toBeInTheDocument();
  await waitFor(() =>
    expect(painted("buzz-find-active")).toEqual([
      { text: "topic", in: "page" },
    ]),
  );
});

it("leaves Enter and Escape to an input method while composing", async () => {
  const { user } = setup(<p>one two one</p>);
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  await user.paste("one");
  expect(await screen.findByText("1 of 2")).toBeInTheDocument();
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    expect(fireEvent.keyDown(field(), { key: "Enter", ...init })).toBe(true);
    expect(fireEvent.keyDown(field(), { key: "Escape", ...init })).toBe(true);
  }
  expect(screen.getByText("1 of 2")).toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(screen.getByText("2 of 2")).toBeInTheDocument();
});

it("recounts when a retained panel is covered or uncovered", async () => {
  const { user } = setup(
    <>
      <section id="one-panel">
        <p id="one">panequery and panequery</p>
      </section>
      <section id="two-panel" inert>
        <p id="two">panequery</p>
      </section>
    </>,
  );
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  await user.paste("panequery");
  expect(await screen.findByText("1 of 2")).toBeInTheDocument();

  // Switching tabs changes only attributes; the text stays mounted.
  act(() => {
    document.getElementById("one-panel")?.setAttribute("inert", "");
    document.getElementById("two-panel")?.removeAttribute("inert");
  });
  expect(await screen.findByText("1 of 1")).toBeInTheDocument();
  expect(painted("buzz-find-active")).toEqual([
    { text: "panequery", in: "two" },
  ]);
});

it("recounts at least once a second while content keeps changing", async () => {
  const { user } = setup(
    <main>
      <p>tick</p>
    </main>,
  );
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  await user.paste("tick");
  expect(await screen.findByText("1 of 1")).toBeInTheDocument();

  vi.useFakeTimers();
  const main = screen.getByRole("main");
  // A streaming reply: an update every 50 ms never leaves a quiet pause.
  for (let tick = 0; tick < 30; tick++)
    await act(async () => {
      const line = document.createElement("p");
      line.textContent = "tick";
      main.append(line);
      await vi.advanceTimersByTimeAsync(50);
    });
  expect(findBar()).not.toHaveTextContent("1 of 1");
});

it("repaints through one registered highlight per name as the query and match change", async () => {
  // Older WebKit doesn't repaint when CSS.highlights.set() replaces a
  // registered highlight, and never paints a range another highlight placed.
  const set = vi.spyOn(highlights, "set");
  const { user } = setup(
    <main>
      <p id="one">No channels yet.</p>
      <p id="two">No messages yet. Join channel to send messages</p>
    </main>,
  );
  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  const steps: [string, string, number][] = [
    ["n", "1 of 8", 7],
    ["o", "1 of 2", 1],
    [" messageskkkk", "No results", 0],
  ];
  for (const [text, status, others] of steps) {
    await user.paste(text);
    expect(await screen.findByText(status)).toBeInTheDocument();
    expect(highlights.get("buzz-find")?.size).toBe(others);
    expect(highlights.get("buzz-find-active")?.size).toBe(others ? 1 : 0);
  }
  await user.clear(field());
  await waitFor(() => expect(highlights.get("buzz-find")?.size).toBe(0));
  expect(highlights.get("buzz-find-active")?.size).toBe(0);

  await user.paste("no");
  expect(await screen.findByText("1 of 2")).toBeInTheDocument();
  const before = painted("buzz-find-active");
  await user.keyboard("{Enter}");
  expect(screen.getByText("2 of 2")).toBeInTheDocument();
  expect(painted("buzz-find-active")).not.toEqual(before);
  expect(painted("buzz-find")).toEqual(before);
  // Every change above went through the two highlights registered first.
  expect(set.mock.calls.map(([name]) => name)).toEqual([
    "buzz-find",
    "buzz-find-active",
  ]);
  const active = [...(highlights.get("buzz-find-active") ?? [])];
  const others = [...(highlights.get("buzz-find") ?? [])];
  expect(active.some((range) => others.includes(range))).toBe(false);

  await user.keyboard("{Escape}");
  expect(highlights.size).toBe(0);
});
