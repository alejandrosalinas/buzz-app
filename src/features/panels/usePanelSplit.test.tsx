// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { clearView, writeView } from "../../shared/view-state";
import { usePanelSplit } from "./usePanelSplit";
import { Context } from "@deepseek-ai/cordis";
import { PanelsService } from "./service";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("plugin split names cannot read, overwrite or reset host widths", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(960);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const panels = new PanelsService(root);
  function Host() {
    const split = usePanelSplit("one", "notes", 448, 320);
    return (
      <div ref={split.ref} data-testid="host">
        {split.handle}
      </div>
    );
  }
  function Plugin() {
    const split = panels.ui.useSplit("one", "notes", 448, 320);
    return (
      <div ref={split.ref} data-testid="plugin">
        {split.handle}
      </div>
    );
  }
  try {
    act(() => writeView("one", "panel-split:notes", 500));
    const view = render(
      <>
        <Host />
        <Plugin />
      </>,
    );
    const width = (name: string) =>
      screen
        .getByTestId(name)
        .style.getPropertyValue("--secondary-panel-width");
    const [, plugin] = screen.getAllByRole("separator");
    if (!plugin) throw new Error("missing plugin split handle");
    expect(width("host")).toBe("500px");
    expect(width("plugin")).toBe("");
    fireEvent.keyDown(plugin, { key: "End" });
    expect(width("plugin")).toBe("640px");
    expect(width("host")).toBe("500px");
    view.unmount();
    render(
      <>
        <Host />
        <Plugin />
      </>,
    );
    const [, againPlugin] = screen.getAllByRole("separator");
    if (!againPlugin) throw new Error("missing restored plugin split handle");
    expect(width("plugin")).toBe("640px");
    fireEvent.doubleClick(againPlugin);
    expect(width("plugin")).toBe("");
    expect(width("host")).toBe("500px");
  } finally {
    cleanup();
    await root.fiber.dispose();
  }
});

// Controlled container measurements exercise the hook's clamp and observer
// lifecycle. Pointer hit targets and actual grid geometry stay in browser tests.
test.each([undefined, { defaultWidth: 420, maxRatio: 0.5 }])(
  "optional primary sizing %s preserves widths and existing defaults",
  (primary) => {
    let available = 960;
    let measure = () => {};
    const disconnect = vi.fn();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => available,
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        // The handle observes its own panel; track only the container.
        observe(element: HTMLElement) {
          if (element.dataset.testid !== "workspace") return;
          measure = this.callback;
          this.disconnect = disconnect;
        }
        disconnect() {}
      },
    );
    const renders = vi.fn();
    function Workspace({ open = true }: { open?: boolean }) {
      renders();
      const split = usePanelSplit(undefined, "test", undefined, 316, primary);
      return (
        <div ref={split.ref} style={split.style} data-testid="workspace">
          <section>{open && split.handle}</section>
        </div>
      );
    }
    const view = render(
      <StrictMode>
        <Workspace />
      </StrictMode>,
    );
    const handle = screen.getByRole("separator");
    const workspace = screen.getByTestId("workspace");
    const width = () =>
      workspace.style.getPropertyValue("--secondary-panel-width");
    expect(width()).toBe(primary ? "540px" : "");
    expect(handle).toHaveAttribute("aria-valuemin", primary ? "480" : "316");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(width()).toBe(primary ? "480px" : "316px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(width()).toBe("640px");
    available = 720;
    const beforeResize = renders.mock.calls.length;
    act(measure);
    expect(renders).toHaveBeenCalledTimes(beforeResize);
    expect(width()).toBe("400px");
    view.rerender(
      <StrictMode>
        <Workspace open={false} />
      </StrictMode>,
    );
    available = 800;
    view.rerender(
      <StrictMode>
        <Workspace />
      </StrictMode>,
    );
    expect(width()).toBe("480px");
    available = 720;
    act(measure);
    const reopenedHandle = screen.getByRole("separator");
    fireEvent.keyDown(reopenedHandle, { key: "Home" });
    expect(width()).toBe(primary ? "360px" : "316px");
    fireEvent.doubleClick(reopenedHandle);
    expect(width()).toBe(primary ? "360px" : "");
    available = 1200;
    act(measure);
    expect(width()).toBe(primary ? "780px" : "");
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(4);
  },
);

// The width a page restores after unmounting (page switch, restart) comes from
// its community/viewer workspace, not from component state.
test("saves each page's width per workspace and reset forgets it", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(960);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  function Page({ scope, name }: { scope: string; name: string }) {
    const split = usePanelSplit(scope, name, 448, 320);
    return (
      <div ref={split.ref} data-testid="workspace">
        {split.handle}
      </div>
    );
  }
  const width = () =>
    screen
      .getByTestId("workspace")
      .style.getPropertyValue("--secondary-panel-width");
  const view = render(<Page scope="one" name="inbox" />);
  expect(width()).toBe("");
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(width()).toBe("640px");
  view.unmount();

  // Returning to the page restores its width; other pages and workspaces keep
  // their own defaults.
  const again = render(<Page scope="one" name="inbox" />);
  expect(width()).toBe("640px");
  again.rerender(<Page scope="two" name="inbox" />);
  expect(width()).toBe("");
  again.rerender(<Page scope="one" name="agents" />);
  expect(width()).toBe("");
  again.rerender(<Page scope="one" name="inbox" />);
  expect(width()).toBe("640px");

  // Double-click returns to the default and clears the saved width.
  fireEvent.doubleClick(screen.getByRole("separator"));
  expect(width()).toBe("");
  again.unmount();
  render(<Page scope="one" name="inbox" />);
  expect(width()).toBe("");
  expect(localStorage.length).toBe(0);
});

test("ignores unusable saved widths and clamps saved ones to the space", () => {
  let available = 960;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => available,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  function Page() {
    const split = usePanelSplit("one", "inbox", 448, 320);
    return (
      <div ref={split.ref} data-testid="workspace">
        {split.handle}
      </div>
    );
  }
  const width = () =>
    screen
      .getByTestId("workspace")
      .style.getPropertyValue("--secondary-panel-width");
  const key = `buzz-view.v1:${JSON.stringify(["one", "panel-split:inbox"])}`;
  localStorage.setItem(key, JSON.stringify("wide"));
  const view = render(<Page />);
  expect(width()).toBe("");
  view.unmount();
  localStorage.setItem(key, JSON.stringify(600));
  available = 720;
  render(<Page />);
  expect(width()).toBe("400px");
});

test("frames sharing a page's width follow each other's saves", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(960);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  function Frame({ id }: { id: string }) {
    const split = usePanelSplit("one", "companion", 420, 300);
    return (
      <div ref={split.ref} data-testid={id}>
        {split.handle}
      </div>
    );
  }
  render(
    <>
      <Frame id="outer" />
      <Frame id="inner" />
    </>,
  );
  const width = (id: string) =>
    screen.getByTestId(id).style.getPropertyValue("--secondary-panel-width");
  const [, inner] = screen.getAllByRole("separator");
  if (!inner) throw new Error("missing handle");
  fireEvent.keyDown(inner, { key: "End" });
  expect(width("outer")).toBe("640px");
  fireEvent.doubleClick(inner);
  expect(width("outer")).toBe("");
});

test("a width that could not be saved survives other saves in its workspace", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(960);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  function Page() {
    const split = usePanelSplit("one", "inbox", 448, 320);
    return (
      <div ref={split.ref} data-testid="workspace">
        {split.handle}
      </div>
    );
  }
  render(<Page />);
  const width = () =>
    screen
      .getByTestId("workspace")
      .style.getPropertyValue("--secondary-panel-width");
  const handle = screen.getByRole("separator");
  fireEvent.keyDown(handle, { key: "End" });
  expect(width()).toBe("640px");
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("quota");
    });
  fireEvent.keyDown(handle, { key: "Home" });
  expect(width()).toBe("320px");
  // An unrelated key in the same workspace notifies without replacing it.
  act(() => clearView("one", "draft:abc"));
  expect(width()).toBe("320px");
  // A newer save of this page's width still applies.
  setItem.mockRestore();
  act(() => {
    writeView("one", "panel-split:inbox", 500);
  });
  expect(width()).toBe("500px");
});
