// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PanelDock } from "../../features/panels/PanelDock";
import { PanelCard } from "../../features/panels/PanelCard";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { usePanelLauncher } from "./usePanelLauncher";

afterEach(cleanup);

test("a fresh opening retires a closed plugin draft even before its exit finishes", async () => {
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
  const closeHandlers: (() => void)[] = [];
  const panel: RegisteredPanel = {
    id: "notes",
    key: "fixture:notes",
    pluginId: "fixture",
    revision: "1",
    title: "Notes",
    matches: () => true,
    launcher: { icon: "note", target: "notes:" },
    component: ({ close }) => {
      closeHandlers.push(close);
      return <input aria-label="Note" />;
    },
  };
  const available = [panel];
  const panels: Panels = {
    ui: { Workspace: () => null, useSplit: vi.fn() },
    register: vi.fn(),
    resolve: () => panel,
    snapshot: () => available,
    subscribe: () => () => {},
    requestOpen: () => false,
    handleOpenRequests: () => () => {},
  };
  function Host() {
    const launcher = usePanelLauncher(panels, true);
    return (
      <>
        <button
          type="button"
          onClick={(event) => launcher.launch(panel, event.currentTarget)}
        >
          Notes
        </button>
        <PanelDock open={!!launcher.selected} className="">
          {launcher.selected && (
            <PanelCard
              key={launcher.openingId}
              panel={launcher.selected}
              target="notes:"
              close={launcher.close}
            />
          )}
        </PanelDock>
      </>
    );
  }
  try {
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "Notes" });
    fireEvent.click(trigger);
    const first = screen.getByRole("textbox", { name: "Note" });
    fireEvent.change(first, { target: { value: "Closed draft" } });
    const oldClose = closeHandlers.at(-1);
    if (!oldClose) throw new Error("Panel did not mount");
    fireEvent.click(screen.getByRole("button", { name: "Close Notes panel" }));
    expect(first).toBeInTheDocument(); // Exit is held, not raced against a timer.
    expect(first.closest("[inert]")).not.toBeNull();
    fireEvent.click(trigger);
    const next = screen.getByRole("textbox", { name: "Note" });
    expect(next).not.toBe(first);
    expect(next).toHaveValue("");
    fireEvent.change(next, { target: { value: "Current draft" } });
    await act(async () => {
      oldClose();
      finish();
    });
    expect(screen.getByRole("textbox", { name: "Note" })).toBe(next);
    expect(next).toHaveValue("Current draft");
  } finally {
    finish();
    if (original) HTMLElement.prototype.getAnimations = original;
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  }
});
