// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import closeRequest from "../../../src-tauri/src/close-request.js?raw";
import switchTabRequest from "../../../src-tauri/src/switch-tab-request.js?raw";
import { PanelWorkspace, usePanelTabTitle } from "./PanelWorkspace";
import { PanelSubview } from "./PanelSubview";
import { PanelDock } from "./PanelDock";

afterEach(() => {
  delete document.documentElement.dataset.keyboardNavigation;
  cleanup();
  vi.restoreAllMocks();
});
function Profile({ authorized }: { authorized: boolean }) {
  usePanelTabTitle("Ada");
  const [log, setLog] = useState(false);
  return (
    <>
      <input aria-label="Profile draft" />
      <button type="button" onClick={() => setLog(true)}>
        Open log
      </button>
      {log && authorized && (
        <PanelSubview
          title="Harness log"
          backLabel="Back to profile"
          onBack={() => setLog(false)}
        >
          <input aria-label="Log filter" />
        </PanelSubview>
      )}
    </>
  );
}
function Fixture({
  authorized = true,
  focusOnMount = true,
  menuScope,
  initial = ["Thread", "Profile"],
}: {
  authorized?: boolean;
  focusOnMount?: boolean;
  menuScope?: string;
  initial?: string[];
}) {
  const [ids, setIds] = useState(initial);
  const [value, select] = useState(initial[0] ?? "");
  return ids.length ? (
    <PanelWorkspace
      focusOnMount={focusOnMount}
      tabMenu={
        menuScope
          ? {
              key: menuScope,
              closeAll: () => {
                setIds([]);
                return true;
              },
              // Like the channel store, which knows nothing of local details.
              closeOthers: (id: string) => {
                if (!ids.some((item) => item !== id)) return false;
                setIds([id]);
                select(id);
                return true;
              },
            }
          : undefined
      }
      value={value}
      select={select}
      items={ids.map((id) => ({
        id,
        label: id,
        close() {
          const next = ids.filter((item) => item !== id);
          setIds(next);
          if (id === value) select(next[0] ?? "");
        },
        content:
          id === "Thread" ? (
            <input aria-label="Thread draft" />
          ) : (
            <Profile authorized={authorized} />
          ),
      }))}
    />
  ) : (
    <p>No open panels</p>
  );
}
const tabs = () => screen.getByRole("tablist", { name: "Panel tabs" });
const tab = (name: string) => within(tabs()).getByRole("tab", { name });

test("switches retained panels, associates their tabs, and closes inactive or active tabs with focus recovery", async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  const draft = screen.getByRole("textbox", { name: "Thread draft" });
  await user.type(draft, "Keep this draft");
  expect(screen.getByRole("tabpanel", { name: "Thread" })).toContainElement(
    draft,
  );
  await user.click(tab("Ada"));
  expect(screen.queryByRole("textbox", { name: "Thread draft" })).toBeNull();
  expect(draft).toBeInTheDocument();
  await user.click(tab("Thread"));
  expect(screen.getByRole("textbox", { name: "Thread draft" })).toBe(draft);
  expect(draft).toHaveValue("Keep this draft");
  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(tab("Thread")).toHaveFocus();
  await user.keyboard("{Delete}");
  expect(screen.getByText("No open panels")).toBeVisible();
});

test("middle-click closes inactive tabs without taking draft focus", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  const draft = screen.getByRole("textbox", { name: "Thread draft" });
  await user.type(draft, "Keep this draft");

  await user.pointer({ target: tab("Ada"), keys: "[MouseRight]" });
  expect(tab("Ada")).toBeInTheDocument();
  draft.focus();
  await user.pointer({ target: tab("Ada"), keys: "[MouseMiddle]" });
  expect(within(tabs()).queryByRole("tab", { name: "Ada" })).toBeNull();
  expect(draft).toHaveFocus();
  expect(draft).toHaveValue("Keep this draft");

  await user.pointer({ target: tab("Thread"), keys: "[MouseMiddle]" });
  expect(screen.getByText("No open panels")).toBeVisible();
});

test("middle-clicking the active tab recovers focus to its selected neighbor", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(tab("Ada"));
  await user.pointer({ target: tab("Ada"), keys: "[MouseMiddle]" });
  expect(within(tabs()).queryByRole("tab", { name: "Ada" })).toBeNull();
  expect(tab("Thread")).toHaveAttribute("aria-selected", "true");
  expect(tab("Thread")).toHaveFocus();
});

test("local details are retained sibling tabs and close without dismissing the profile", async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  expect(tab("Harness log")).toHaveFocus();
  const filter = screen.getByRole("textbox", { name: "Log filter" });
  await user.type(filter, "warning");
  await user.click(tab("Ada"));
  expect(screen.getByRole("textbox", { name: "Profile draft" })).toBeVisible();
  expect(filter).toBeInTheDocument();
  await user.click(tab("Harness log"));
  expect(screen.getByRole("textbox", { name: "Log filter" })).toBe(filter);
  expect(filter).toHaveValue("warning");
  await user.keyboard("{Escape}");
  expect(within(tabs()).queryByRole("tab", { name: "Harness log" })).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  expect(filter).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open log" }));
  await user.click(tab("Ada"));
  await user.click(
    screen.getByRole("button", { name: "Close Harness log tab" }),
  );
  expect(tab("Ada")).toHaveFocus();
  expect(within(tabs()).queryByRole("tab", { name: "Harness log" })).toBeNull();
});

test("revoking access removes the local tab; closing its owner also removes retained local content", async () => {
  const user = userEvent.setup();
  const view = render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  view.rerender(
    <StrictMode>
      <Fixture authorized={false} />
    </StrictMode>,
  );
  expect(
    screen.queryByRole("textbox", { name: "Log filter", hidden: true }),
  ).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  view.rerender(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Thread"));
  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(
    screen.queryByRole("textbox", { name: "Log filter", hidden: true }),
  ).toBeNull();
  expect(within(tabs()).getAllByRole("tab")).toHaveLength(1);
  expect(tab("Thread")).toHaveFocus();
});

for (const action of ["close", "escape"]) {
  test(`reopening the last tab during its ${action} exit restores focus`, async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = HTMLElement.prototype.getAnimations;
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      writable: true,
      value: () => [{ finished }],
    });
    function Host() {
      const [opening, setOpening] = useState<object | null>(null);
      const open = !!opening;
      const trigger = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={trigger} type="button" onClick={() => setOpening({})}>
            Open profile
          </button>
          <PanelDock open={open} className="">
            {opening && (
              <PanelWorkspace
                value="profile"
                select={() => {}}
                items={[
                  {
                    id: "profile",
                    instance: opening,
                    label: "Profile",
                    content: <input aria-label="Profile draft" />,
                    close() {
                      setOpening(null);
                      trigger.current?.focus();
                    },
                  },
                ]}
              />
            )}
          </PanelDock>
        </>
      );
    }
    try {
      render(<Host />);
      const trigger = screen.getByRole("button", { name: "Open profile" });
      fireEvent.click(trigger);
      expect(tab("Profile")).toHaveFocus();
      if (action === "close")
        fireEvent.click(
          screen.getByRole("button", { name: "Close Profile tab" }),
        );
      else fireEvent.keyDown(tab("Profile"), { key: "Escape" });
      expect(trigger).toHaveFocus();
      expect(
        screen
          .getByRole("textbox", { name: "Profile draft", hidden: true })
          .closest("[inert]"),
      ).not.toBeNull();
      fireEvent.click(trigger);
      expect(tab("Profile")).toHaveFocus();
      await act(async () => finish());
      expect(tab("Profile")).toHaveFocus();
    } finally {
      finish();
      if (original) HTMLElement.prototype.getAnimations = original;
      else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    }
  });
}

test("a restored workspace leaves existing focus alone but fresh selections and local details take focus", async () => {
  const user = userEvent.setup();
  const view = render(<input aria-label="Main draft" />);
  const main = screen.getByRole("textbox", { name: "Main draft" });
  main.focus();
  view.rerender(
    <>
      <input aria-label="Main draft" />
      <StrictMode>
        <Fixture focusOnMount={false} />
      </StrictMode>
    </>,
  );
  expect(main).toHaveFocus();
  await user.click(tab("Ada"));
  expect(tab("Ada")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Open log" }));
  expect(tab("Harness log")).toHaveFocus();
});

test("choosing a tab with the pointer resumes its composer; the keyboard stays in the tabs", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [value, select] = useState("One");
    return (
      <PanelWorkspace
        value={value}
        select={select}
        items={["One", "Two"].map((id) => ({
          id,
          label: id,
          content: (
            <>
              <button type="button">{`${id} action`}</button>
              <input aria-label={`${id} reply`} data-tab-focus="" />
            </>
          ),
        }))}
      />
    );
  }
  render(<Harness />);
  await user.click(tab("Two"));
  expect(screen.getByRole("textbox", { name: "Two reply" })).toHaveFocus();
  await user.click(tab("One"));
  expect(screen.getByRole("textbox", { name: "One reply" })).toHaveFocus();
  act(() => tab("One").focus());
  await user.keyboard("{ArrowRight}{Enter}");
  expect(tab("Two")).toHaveFocus();
});

test("a pointer-chosen tab's composer takes focus when it mounts later, unless the user acts first", async () => {
  const user = userEvent.setup();
  let ready: (id: string) => void = () => {};
  function Harness() {
    const [value, select] = useState("One");
    const [mounted, setMounted] = useState(["One"]);
    ready = (id) => setMounted((ids) => [...ids, id]);
    return (
      <>
        <input aria-label="Search" />
        <PanelWorkspace
          value={value}
          select={select}
          items={["One", "Two", "Three", "Four"].map((id) => ({
            id,
            label: id,
            content: mounted.includes(id) && (
              <input aria-label={`${id} reply`} data-tab-focus="" />
            ),
          }))}
        />
      </>
    );
  }
  render(<Harness />);
  await user.click(tab("Two"));
  expect(tab("Two")).toHaveFocus();
  await act(async () => ready("Two"));
  expect(screen.getByRole("textbox", { name: "Two reply" })).toHaveFocus();
  await user.click(tab("Three"));
  await user.keyboard("{ArrowLeft}");
  await act(async () => ready("Three"));
  expect(tab("Two")).toHaveFocus();
  // Leaving the tab and returning before the composer mounts keeps it there.
  await user.click(tab("Four"));
  act(() => screen.getByRole("textbox", { name: "Search" }).focus());
  act(() => tab("Four").focus());
  await act(async () => ready("Four"));
  expect(tab("Four")).toHaveFocus();
});

test("Escape cancelling IME composition does not close the tab", () => {
  render(<Fixture />);
  const draft = screen.getByRole("textbox", { name: "Thread draft" });
  draft.focus();
  fireEvent.keyDown(draft, { key: "Escape", isComposing: true });
  expect(draft).toHaveFocus();
  fireEvent.keyDown(draft, { key: "Escape", keyCode: 229 });
  expect(draft).toHaveFocus();
  fireEvent.keyDown(draft, { key: "Escape" });
  expect(draft).not.toBeInTheDocument();
  expect(tab("Ada")).toHaveFocus();
});

// Exercise the exact script evaluated by the native menu, not a second shortcut
// implementation. Geometry is the only browser-only boundary stubbed in jsdom.
const requestClose = (
  tabEvent = "buzz:close-active-tab",
  browserSessionId: string | null = null,
) =>
  new Function(
    "window",
    "document",
    "Event",
    "tabEvent",
    "browserSessionId",
    "script",
    "return eval(script)",
  )(window, document, Event, tabEvent, browserSessionId, closeRequest) as
    | "handled"
    | "unhandled";
const visibleWorkspace = () =>
  vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue([{ width: 500, height: 500 }] as unknown as DOMRectList);

test("native Close closes the active tab from outside the pane, commits each request, and reports when no tab is left", () => {
  visibleWorkspace();
  render(
    <StrictMode>
      <input aria-label="Main composer" />
      <Fixture />
    </StrictMode>,
  );
  screen.getByRole("textbox", { name: "Main composer" }).focus();
  act(() => {
    expect(requestClose()).toBe("handled");
    expect(within(tabs()).queryByRole("tab", { name: "Thread" })).toBeNull();
    expect(tab("Ada")).toHaveFocus();
    // No async yield: a held native accelerator must see the next selection.
    expect(requestClose()).toBe("handled");
    expect(screen.getByText("No open panels")).toBeVisible();
    expect(requestClose()).toBe("unhandled");
  });
});

test("native Close uses the selected local detail, not its parent tab", async () => {
  visibleWorkspace();
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  screen.getByRole("textbox", { name: "Log filter" }).focus();
  act(() => expect(requestClose()).toBe("handled"));
  expect(within(tabs()).queryByRole("tab", { name: "Harness log" })).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  expect(tab("Thread")).toBeInTheDocument();
});

for (const hiddenProps of [
  { hidden: true },
  { inert: true },
  { "aria-hidden": true as const },
]) {
  test(`native Close preserves retained tabs under ${Object.keys(hiddenProps)[0]}`, () => {
    visibleWorkspace();
    const view = render(
      <div {...hiddenProps}>
        <Fixture />
      </div>,
    );
    act(() => expect(requestClose()).toBe("unhandled"));
    view.rerender(
      <div>
        <Fixture />
      </div>,
    );
    expect(tab("Thread")).toBeInTheDocument();
    expect(tab("Ada")).toBeInTheDocument();
  });
}

test("native Close ignores a CSS-hidden workspace and disposes its consumer on unmount", () => {
  const rects = visibleWorkspace();
  const view = render(<Fixture />);
  rects.mockReturnValue([] as unknown as DOMRectList);
  act(() => expect(requestClose()).toBe("unhandled"));
  expect(tab("Thread")).toBeInTheDocument();
  view.unmount();
  act(() => expect(requestClose()).toBe("unhandled"));
});

test("native Close is consumed by a modal even without tabs, and never closes behind it", () => {
  visibleWorkspace();
  const view = render(
    <>
      <dialog open aria-label="Dialog" />
      <Fixture />
    </>,
  );
  act(() => expect(requestClose()).toBe("handled"));
  expect(tab("Thread")).toBeInTheDocument();
  view.rerender(<div role="dialog" aria-modal="true" />);
  act(() => expect(requestClose()).toBe("handled"));
  view.unmount();
  expect(requestClose()).toBe("unhandled");
});

test("a consumed native Close request cannot close another workspace", () => {
  visibleWorkspace();
  render(
    <>
      <Fixture />
      <Fixture />
    </>,
  );
  act(() => expect(requestClose()).toBe("handled"));
  expect(screen.getAllByRole("tab", { name: "Thread" })).toHaveLength(1);
  expect(screen.getAllByRole("tab", { name: "Ada" })).toHaveLength(2);
});

// The exact script the native Show Next/Previous Tab items evaluate; Windows
// and Linux shortcuts dispatch the same events.
const switchTab = (
  tabEvent: "buzz:next-tab" | "buzz:previous-tab",
  browserSessionId: string | null = null,
) =>
  new Function(
    "window",
    "document",
    "Event",
    "tabEvent",
    "browserSessionId",
    "script",
    "return eval(script)",
  )(window, document, Event, tabEvent, browserSessionId, switchTabRequest);

function NativePanes({
  close,
  select,
}: {
  close: (pane: string) => void;
  select: (pane: string, id: string) => void;
}) {
  return (
    <>
      {["main", "side"].map((pane) => (
        <PanelWorkspace
          key={pane}
          main={pane === "main"}
          label={`${pane} tabs`}
          value={`${pane}-one`}
          select={(id) => select(pane, id)}
          items={["one", "two", "three"].map((id) => ({
            id: `${pane}-${id}`,
            label: `${pane} ${id}`,
            close: () => close(pane),
            content: (
              <div data-browser-session={`${pane}-${id}`}>
                <input aria-label={`${pane} ${id} draft`} />
              </div>
            ),
          }))}
        />
      ))}
    </>
  );
}

test.each(["main", "side"])(
  "native Close belongs to the %s guest despite DOM focus in the other pane",
  (pane) => {
    visibleWorkspace();
    const close = vi.fn();
    render(<NativePanes close={close} select={() => {}} />);
    screen
      .getByRole("textbox", {
        name: `${pane === "main" ? "side" : "main"} one draft`,
      })
      .focus();
    act(() =>
      expect(requestClose("buzz:close-active-tab", `${pane}-one`)).toBe(
        "handled",
      ),
    );
    expect(close).toHaveBeenCalledExactlyOnceWith(pane);
  },
);

test.each(["main", "side"])(
  "native tab cycling follows the %s guest instead of stale DOM focus",
  (pane) => {
    visibleWorkspace();
    const select = vi.fn();
    render(<NativePanes close={() => {}} select={select} />);
    for (const [event, target] of [
      ["buzz:next-tab", "two"],
      ["buzz:previous-tab", "three"],
    ] as const) {
      screen
        .getByRole("textbox", {
          name: `${pane === "main" ? "side" : "main"} one draft`,
        })
        .focus();
      act(() => switchTab(event, `${pane}-one`));
      expect(select).toHaveBeenLastCalledWith(pane, `${pane}-${target}`);
    }
    expect(select).toHaveBeenCalledTimes(2);
  },
);

test("stale guest requests and guest shortcuts under a modal leave both panes alone", () => {
  visibleWorkspace();
  const close = vi.fn(),
    select = vi.fn();
  render(<NativePanes close={close} select={select} />);
  screen.getByRole("textbox", { name: "side one draft" }).focus();
  act(() => {
    expect(requestClose("buzz:close-active-tab", "retired")).toBe("handled");
    switchTab("buzz:next-tab", "retired");
  });
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  act(() => {
    expect(requestClose("buzz:close-active-tab", "main-one")).toBe("handled");
    switchTab("buzz:next-tab", "main-one");
  });
  dialog.remove();
  expect(close).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});
const selectedTab = () =>
  within(tabs()).getByRole("tab", { selected: true }).textContent;

test("next and previous tab requests cycle tabs, wrapping, including local details", async () => {
  visibleWorkspace();
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  await user.click(tab("Thread"));
  expect(selectedTab()).toBe("Thread");
  expect(document.documentElement.dataset.keyboardNavigation).toBeUndefined();
  act(() => {
    // No async yield: a held accelerator must see the previous selection.
    switchTab("buzz:next-tab");
    expect(selectedTab()).toBe("Ada");
    switchTab("buzz:next-tab");
    expect(selectedTab()).toBe("Harness log");
    switchTab("buzz:next-tab");
    expect(selectedTab()).toBe("Thread");
    switchTab("buzz:previous-tab");
    expect(selectedTab()).toBe("Harness log");
    switchTab("buzz:previous-tab");
    expect(selectedTab()).toBe("Ada");
  });
  // Without a main-document keydown, the request itself marks keyboard
  // navigation so the focused fallback tab shows its ring.
  expect(document.documentElement.dataset.keyboardNavigation).toBe("");
});

test("tab switching does nothing behind a modal or with a single tab", () => {
  visibleWorkspace();
  const view = render(
    <>
      <dialog open aria-label="Dialog" />
      <Fixture />
    </>,
  );
  act(() => switchTab("buzz:next-tab"));
  expect(tab("Thread")).toHaveAttribute("aria-selected", "true");
  expect(document.documentElement.dataset.keyboardNavigation).toBeUndefined();
  view.rerender(
    <PanelWorkspace
      value="one"
      select={() => {}}
      items={[{ id: "one", label: "One", content: null }]}
    />,
  );
  const request = new Event("buzz:next-tab", { cancelable: true });
  act(() => {
    window.dispatchEvent(request);
  });
  expect(request.defaultPrevented).toBe(false);
});

test("a modal with its own tabs takes the request at its focused control, not the tabs behind it", () => {
  visibleWorkspace();
  const received: string[] = [];
  render(
    <>
      <div role="dialog" aria-modal="true">
        <div
          data-modal-tab-switch=""
          ref={(element) => {
            element?.addEventListener("buzz:previous-tab", (event) => {
              event.preventDefault();
              received.push(event.type);
            });
          }}
        >
          <input aria-label="Search" />
        </div>
        <input aria-label="Other field" />
      </div>
      <Fixture />
    </>,
  );
  screen.getByRole("textbox", { name: "Search" }).focus();
  act(() => switchTab("buzz:previous-tab"));
  expect(received).toEqual(["buzz:previous-tab"]);
  expect(tab("Thread")).toHaveAttribute("aria-selected", "true");
  // Outside the tabbed region, the modal still keeps the request.
  screen.getByRole("textbox", { name: "Other field" }).focus();
  act(() => switchTab("buzz:previous-tab"));
  expect(received).toHaveLength(1);
  expect(tab("Thread")).toHaveAttribute("aria-selected", "true");
});

test("a consumed tab switch request cannot switch another workspace", () => {
  visibleWorkspace();
  render(
    <>
      <Fixture />
      <Fixture />
    </>,
  );
  act(() => switchTab("buzz:next-tab"));
  expect(
    screen
      .getAllByRole("tab", { name: "Thread" })
      .map((tab) => tab.getAttribute("aria-selected"))
      .sort(),
  ).toEqual(["false", "true"]);
});

test("background tab selection does not take focus from a modal", () => {
  const view = render(
    <>
      <div role="dialog" aria-modal="true">
        <input aria-label="Modal search" />
      </div>
      <PanelWorkspace
        value="one"
        select={() => {}}
        focusOnMount={false}
        items={["one", "two"].map((id) => ({
          id,
          label: id,
          content: <p>{id} body</p>,
        }))}
      />
    </>,
  );
  const search = screen.getByRole("textbox", { name: "Modal search" });
  act(() => search.focus());
  view.rerender(
    <>
      <div role="dialog" aria-modal="true">
        <input aria-label="Modal search" />
      </div>
      <PanelWorkspace
        value="two"
        select={() => {}}
        focusOnMount={false}
        items={["one", "two"].map((id) => ({
          id,
          label: id,
          content: <p>{id} body</p>,
        }))}
      />
    </>,
  );
  expect(search).toHaveFocus();
  expect(tab("two")).toHaveAttribute("aria-selected", "true");
});

test("a tab is renamed in place by double-click, F2 or its menu", async () => {
  const user = userEvent.setup();
  const renamed = vi.fn();
  function Renamable() {
    const [name, setName] = useState<string>();
    return (
      <PanelWorkspace
        tabMenu={{ key: "channel", closeAll: () => false }}
        value="thread"
        select={() => {}}
        items={[
          {
            id: "thread",
            label: name ?? "Root text",
            close() {},
            rename(next) {
              renamed(next);
              setName(next.trim() || undefined);
            },
            content: <input aria-label="Thread draft" />,
          },
        ]}
      />
    );
  }
  render(<Renamable />);
  const field = () => screen.getByRole("textbox", { name: "Tab name" });
  await user.dblClick(tab("Root text"));
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue("Root text");
  await user.keyboard("Launch plan{Enter}");
  expect(renamed).toHaveBeenLastCalledWith("Launch plan");
  expect(tab("Launch plan")).toHaveFocus();
  // Escape keeps the name and the tab; keeping the text changes nothing.
  await user.keyboard("{F2}");
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue("Launch plan");
  await user.keyboard("Draft{Escape}");
  expect(tab("Launch plan")).toHaveFocus();
  await user.keyboard("{F2}{Enter}");
  expect(renamed).toHaveBeenCalledTimes(1);
  // The menu opens the same field; leaving it saves, and blank restores.
  await user.pointer({ keys: "[MouseRight]", target: tab("Launch plan") });
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(
    screen.getByRole("menuitem", { name: "Close all tabs" }),
  ).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "Rename tab" }));
  await user.clear(field());
  await user.click(screen.getByRole("textbox", { name: "Thread draft" }));
  expect(renamed).toHaveBeenLastCalledWith("");
  expect(tab("Root text")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Thread draft" })).toHaveFocus();
});

test("the tab name field keeps its keys, ignores IME commits and newer titles, and ends with its tab", async () => {
  const user = userEvent.setup();
  const renamed = vi.fn();
  const closed = vi.fn();
  const workspace = (labels: Record<string, string>) => (
    <PanelWorkspace
      value="a"
      select={() => {}}
      items={Object.entries(labels).map(([id, label]) => ({
        id,
        label,
        close: () => closed(id),
        rename: (name: string) => renamed(id, name),
        content: <input aria-label={`${id} draft`} />,
      }))}
    />
  );
  const field = () => screen.queryByRole("textbox", { name: "Tab name" });
  const view = render(workspace({ a: "Alpha", b: "Beta" }));
  // Arrows at either end of the text stay in the field.
  await user.dblClick(tab("Alpha"));
  await user.keyboard("{End}{ArrowRight}{Home}{ArrowLeft}");
  expect(field()).toHaveFocus();
  // App shortcuts still reach the window from the field.
  const shortcut = vi.fn();
  window.addEventListener("keydown", shortcut);
  fireEvent.keyDown(field() as HTMLElement, { key: "k", metaKey: true });
  window.removeEventListener("keydown", shortcut);
  expect(shortcut).toHaveBeenCalledWith(
    expect.objectContaining({ key: "k", metaKey: true }),
  );
  // Middle-click in the field keeps its paste and does not close the tab.
  expect(fireEvent.mouseDown(field() as HTMLElement, { button: 1 })).toBe(true);
  await user.pointer({ target: field() as HTMLElement, keys: "[MouseMiddle]" });
  expect(closed).not.toHaveBeenCalled();
  expect(field()).toHaveFocus();
  // The Enter that commits an IME composition does not save.
  fireEvent.keyDown(field() as HTMLElement, { key: "Enter", keyCode: 229 });
  expect(field()).toHaveFocus();
  // A title that changed while editing is not overwritten by untouched text,
  // and trailing space alone is no change.
  view.rerender(workspace({ a: "Agent name", b: "Beta" }));
  await user.keyboard("{End} {Enter}");
  expect(renamed).not.toHaveBeenCalled();
  // An editor whose tab closes does not return, or take focus, with the tab.
  await user.pointer({ keys: "[MouseRight]", target: tab("Beta") });
  await user.click(screen.getByRole("menuitem", { name: "Rename tab" }));
  view.rerender(workspace({ a: "Agent name" }));
  screen.getByRole("textbox", { name: "a draft" }).focus();
  view.rerender(workspace({ a: "Agent name", b: "Beta" }));
  expect(field()).toBeNull();
  expect(renamed).not.toHaveBeenCalled();
});

test("a tab context menu dismisses without closing a tab and supports keyboard cleanup", async () => {
  const user = userEvent.setup();
  render(<Fixture menuScope="alpha" />);
  const thread = tab("Thread");
  await user.pointer({ target: tab("Ada"), keys: "[MouseRight]" });
  await screen.findByRole("menuitem", { name: "Close all tabs" });
  await vi.waitFor(() => expect(screen.getByRole("menu")).toHaveFocus());
  expect(thread).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Escape}");
  expect(await screen.findByRole("tab", { name: "Ada" })).toHaveFocus();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  await user.keyboard("{Shift>}{F10}{/Shift}");
  const action = await screen.findByRole("menuitem", {
    name: "Close all tabs",
  });
  action.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByText("No open panels")).toBeVisible();
});

test.each(["Harness log", "Ada"])(
  "Close other tabs on %s keeps the profile alone, selected and focused, even with nothing else in the store",
  async (chosen) => {
    for (const initial of [["Profile"], ["Thread", "Profile"]]) {
      const user = userEvent.setup();
      const view = render(<Fixture menuScope="alpha" initial={initial} />);
      await user.click(tab("Ada"));
      await user.click(screen.getByRole("button", { name: "Open log" }));
      expect(tab("Harness log")).toHaveAttribute("aria-selected", "true");
      await user.pointer({ target: tab(chosen), keys: "[MouseRight]" });
      await user.click(
        await screen.findByRole("menuitem", { name: "Close other tabs" }),
      );
      expect(
        within(tabs())
          .getAllByRole("tab")
          .map((t) => t.textContent),
      ).toEqual(["Ada"]);
      expect(tab("Ada")).toHaveAttribute("aria-selected", "true");
      await vi.waitFor(() => expect(tab("Ada")).toHaveFocus());
      expect(screen.queryByRole("textbox", { name: "Log filter" })).toBeNull();
      view.unmount();
    }
  },
);

test("a menu opened in the previous channel cannot close the new channel's tabs", async () => {
  const view = render(<Fixture menuScope="alpha" />);
  fireEvent.contextMenu(tab("Thread"));
  const oldAction = await screen.findByRole("menuitem", {
    name: "Close all tabs",
  });
  view.rerender(<Fixture menuScope="beta" />);
  expect(
    screen.queryByRole("menuitem", { name: "Close all tabs" }),
  ).not.toBeInTheDocument();
  fireEvent.click(oldAction);
  expect(screen.getAllByRole("tab")).toHaveLength(2);
});

test("an identity menu opened in the previous channel cannot close the new channel's tabs", async () => {
  const closeAll = vi.fn(() => false);
  const workspace = (scope: string) => (
    <PanelWorkspace
      main
      identity={<button type="button">Channel identity</button>}
      tabMenu={{ key: scope, closeAll }}
      value="conversation"
      select={() => {}}
      items={[
        {
          id: "conversation",
          label: "Channel",
          content: <input aria-label="Channel draft" />,
        },
      ]}
    />
  );
  const view = render(workspace("alpha"));
  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Channel identity" }),
  );
  const oldAction = await screen.findByRole("menuitem", {
    name: "Close all tabs",
  });
  view.rerender(workspace("beta"));
  expect(
    screen.queryByRole("menuitem", { name: "Close all tabs" }),
  ).not.toBeInTheDocument();
  fireEvent.click(oldAction);
  expect(closeAll).not.toHaveBeenCalled();
});

// Close uses focus first, then the visible side pane when the main selection
// is the permanent conversation. Listener registration order must not decide.
test.each([false, true])(
  "native Close falls back from the main conversation but prefers its closable selection (side first=%s)",
  (sideFirst) => {
    visibleWorkspace();
    const closeMain = vi.fn();
    const closeSide = vi.fn();
    function Harness({
      mainSelected = "conversation",
      hideSide = false,
    }: {
      mainSelected?: string;
      hideSide?: boolean;
    }) {
      const main = (
        <PanelWorkspace
          main
          label="Main tabs"
          value={mainSelected}
          select={() => {}}
          items={[
            {
              id: "conversation",
              label: "Channel",
              content: <input aria-label="Channel composer" />,
            },
            {
              id: "main-thread",
              label: "Main thread",
              content: <input aria-label="Main reply" />,
              close: closeMain,
            },
          ]}
        />
      );
      const side = (
        <div hidden={hideSide}>
          <PanelWorkspace
            label="Side tabs"
            value="side-thread"
            select={() => {}}
            items={[
              {
                id: "side-thread",
                label: "Side thread",
                content: <input aria-label="Side reply" />,
                close: closeSide,
              },
            ]}
          />
        </div>
      );
      return sideFirst ? (
        <>
          {side}
          {main}
        </>
      ) : (
        <>
          {main}
          {side}
        </>
      );
    }
    const view = render(<Harness />);
    screen.getByRole("textbox", { name: "Channel composer" }).focus();
    act(() => expect(requestClose()).toBe("handled"));
    expect(closeSide).toHaveBeenCalledTimes(1);
    expect(closeMain).not.toHaveBeenCalled();
    view.rerender(<Harness mainSelected="main-thread" />);
    screen.getByRole("textbox", { name: "Main reply" }).focus();
    act(() => expect(requestClose()).toBe("handled"));
    expect(closeMain).toHaveBeenCalledTimes(1);
    expect(closeSide).toHaveBeenCalledTimes(1);
    view.rerender(<Harness hideSide />);
    screen.getByRole("textbox", { name: "Channel composer" }).focus();
    act(() => expect(requestClose()).toBe("unhandled"));
    expect(closeSide).toHaveBeenCalledTimes(1);
  },
);

test("conversation identity preserves content and focus when the last detail tab closes", async () => {
  const manage = vi.fn();
  function IdentityWorkspace() {
    const [detail, setDetail] = useState(false);
    const [selected, select] = useState("conversation");
    return (
      <PanelWorkspace
        main
        focusOnMount={false}
        identity={
          <button type="button" onClick={manage}>
            Manage Nightriders members
          </button>
        }
        value={selected}
        select={select}
        items={[
          {
            id: "conversation",
            label: "Nightriders",
            content: (
              <>
                <input aria-label="Conversation draft" />
                <button
                  type="button"
                  onClick={() => {
                    setDetail(true);
                    select("detail");
                  }}
                >
                  Open detail
                </button>
              </>
            ),
          },
          ...(detail
            ? [
                {
                  id: "detail",
                  label: "Detail",
                  content: <p>Detail content</p>,
                  close: () => {
                    setDetail(false);
                    select("conversation");
                  },
                },
              ]
            : []),
        ]}
      />
    );
  }
  render(<IdentityWorkspace />);
  expect(screen.getByRole("region", { name: "Nightriders" })).toBeVisible();
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Manage Nightriders members" }),
  );
  expect(manage).toHaveBeenCalledOnce();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Conversation draft" }),
    "Keep this draft",
  );
  await userEvent.click(screen.getByRole("button", { name: "Open detail" }));
  expect(
    screen.getByRole("tab", { name: "Detail", selected: true }),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Close Detail tab" }),
  );
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(
    screen.getByRole("textbox", { name: "Conversation draft" }),
  ).toHaveValue("Keep this draft");
  expect(
    screen.getByRole("button", { name: "Manage Nightriders members" }),
  ).toHaveFocus();
});

test("native Close from the main conversation leaves focus to a side tab that asks first", () => {
  visibleWorkspace();
  // A close that keeps its tab may be asking, and its prompt takes focus.
  let answer: false | undefined = false;
  const close = vi.fn(() => {
    screen.getByRole("button", { name: "Keep editing" }).focus();
    return answer;
  });
  render(
    <>
      <button type="button">Keep editing</button>
      <PanelWorkspace
        main
        label="Main tabs"
        value="conversation"
        select={() => {}}
        items={[
          {
            id: "conversation",
            label: "Channel",
            content: <input aria-label="Channel composer" />,
          },
        ]}
      />
      <PanelWorkspace
        label="Side tabs"
        value="side-thread"
        select={() => {}}
        items={[
          {
            id: "side-thread",
            label: "Side thread",
            content: <input aria-label="Side reply" />,
            close,
          },
        ]}
      />
    </>,
  );
  const composer = screen.getByRole("textbox", { name: "Channel composer" });
  composer.focus();
  act(() => expect(requestClose()).toBe("handled"));
  expect(close).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
  answer = undefined;
  composer.focus();
  act(() => expect(requestClose()).toBe("handled"));
  expect(close).toHaveBeenCalledTimes(2);
  expect(composer).toHaveFocus();
});
