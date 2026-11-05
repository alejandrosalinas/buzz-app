// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { behindActiveOverlay, observeOverlays } from "./overlayLayer";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "./ui/Menu";
import { PopoverRoot, PopoverTrigger, PopoverPopup } from "./ui/Popover";
import { Select } from "./ui/Select";

function Background({ children }: { children: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const update = () => {
      if (surface.current) setCovered(behindActiveOverlay(surface.current));
    };
    update();
    return observeOverlays(update);
  }, []);
  return (
    <>
      <div ref={surface}>
        Background controls
        <output aria-label="Covered">{String(covered)}</output>
      </div>
      {children}
    </>
  );
}

afterEach(cleanup);

it.each(["menu", "popover", "select", "context menu"])(
  "background controls yield to a real %s until dismissal",
  async (kind) => {
    const user = userEvent.setup();
    render(
      <Background>
        {kind === "menu" ? (
          <MenuRoot>
            <MenuTrigger>Open layer</MenuTrigger>
            <MenuPopup>
              <MenuItem>Action</MenuItem>
            </MenuPopup>
          </MenuRoot>
        ) : kind === "popover" ? (
          <PopoverRoot>
            <PopoverTrigger>Open layer</PopoverTrigger>
            <PopoverPopup aria-label="Layer">
              <button type="button">Action</button>
            </PopoverPopup>
          </PopoverRoot>
        ) : kind === "select" ? (
          <Select
            label="Open layer"
            value="one"
            groups={[{ label: "", options: [{ value: "one", label: "One" }] }]}
            onValueChange={() => {}}
          />
        ) : (
          <ContextMenuRoot>
            <ContextMenuTrigger>
              <button type="button">Open layer</button>
            </ContextMenuTrigger>
            <MenuPopup>
              <MenuItem>Action</MenuItem>
            </MenuPopup>
          </ContextMenuRoot>
        )}
      </Background>,
    );
    expect(screen.getByLabelText("Covered").textContent).toBe("false");
    if (kind === "context menu")
      await user.pointer({
        target: screen.getByText("Open layer"),
        keys: "[MouseRight]",
      });
    else
      await user.click(
        screen.getByRole(kind === "select" ? "combobox" : "button", {
          name: "Open layer",
        }),
      );
    await screen.findByRole(
      kind === "popover" ? "dialog" : kind === "select" ? "listbox" : "menu",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Covered").textContent).toBe("true"),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByLabelText("Covered").textContent).toBe("false"),
    );
  },
);

it("permits a surface inside a nested menu while covering background controls", async () => {
  const user = userEvent.setup();
  render(
    <Background>
      <MenuRoot>
        <MenuTrigger>Open layer</MenuTrigger>
        <MenuPopup>
          <MenuSubmenu>
            <MenuSubmenuTrigger>More</MenuSubmenuTrigger>
            <MenuSubmenuPopup>
              <MenuItem>Nested action</MenuItem>
            </MenuSubmenuPopup>
          </MenuSubmenu>
        </MenuPopup>
      </MenuRoot>
    </Background>,
  );
  const trigger = screen.getByRole("button", { name: "Open layer" });
  await user.click(trigger);
  const more = await screen.findByRole("menuitem", { name: "More" });
  more.focus();
  await user.keyboard("{ArrowRight}");
  const nested = await screen.findByRole("menuitem", { name: "Nested action" });
  expect(behindActiveOverlay(nested)).toBe(false);
  await waitFor(() =>
    expect(screen.getByLabelText("Covered").textContent).toBe("true"),
  );
  // The menu's opener is not covered by its own menu or nested menus.
  expect(behindActiveOverlay(trigger)).toBe(true);
  expect(behindActiveOverlay(trigger, more.closest('[role="menu"]'))).toBe(
    false,
  );
});

it("ignores inline lists, notifications and hover previews", () => {
  render(
    <Background>
      <div role="listbox" aria-label="Inline choices">
        <div role="option" aria-selected="true" tabIndex={-1}>
          One
        </div>
      </div>
      <div role="dialog" aria-label="Notification">
        Saved
      </div>
      <div popover="manual">
        <div role="dialog" data-open="">
          Hover preview
        </div>
      </div>
    </Background>,
  );
  expect(screen.getByLabelText("Covered").textContent).toBe("false");
});

it("recognizes editor-owned suggestions without treating every inline list as a popup", async () => {
  const view = render(
    <Background>
      <textarea
        aria-label="Composer"
        aria-haspopup="listbox"
        aria-controls="suggestions"
      />
      <div role="listbox" id="suggestions">
        <div role="option" aria-selected="true" tabIndex={-1}>
          Suggestion
        </div>
      </div>
    </Background>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Covered").textContent).toBe("true"),
  );
  view.rerender(
    <Background>
      <textarea aria-label="Composer" />
      <div role="listbox" id="suggestions">
        <div role="option" aria-selected="true" tabIndex={-1}>
          Suggestion
        </div>
      </div>
    </Background>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Covered").textContent).toBe("false"),
  );
});

it("ignores hidden retained popups and yields to the active nested modal", () => {
  render(
    <>
      <div hidden>
        <div role="menu" data-closed="">
          Retained menu
        </div>
      </div>
      <div role="dialog" aria-modal="true" inert>
        <button type="button">Parent action</button>
      </div>
      <div role="alertdialog" aria-modal="true">
        <button type="button">Confirm</button>
      </div>
    </>,
  );
  expect(
    behindActiveOverlay(screen.getByRole("button", { name: "Confirm" })),
  ).toBe(false);
  expect(behindActiveOverlay(document.body)).toBe(true);
});
