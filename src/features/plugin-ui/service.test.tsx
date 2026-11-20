// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement as h, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginUi } from "./contract";
import { pluginUi } from "./service";

afterEach(cleanup);

/** Reads `ui` the way a plugin does: optionally, from its own context. */
async function readUi(host: Context) {
  let ui: PluginUi | undefined;
  await host
    .plugin((ctx) => {
      ui = ctx.reflect.get("ui");
    })
    .await();
  return ui;
}

it("is absent on a host without it, so plugins can fall back", async () => {
  expect(await readUi(new Context())).toBeUndefined();
});

it("lets a plugin build a form in a dialog from host controls", async () => {
  const host = new Context();
  host.provide("ui", pluginUi);
  const ui = await readUi(host);
  if (!ui) throw new Error("ui was not provided");
  // React keys components by identity; a fresh one per read would remount.
  expect(ui.Dialog).toBe((await readUi(host))?.Dialog);
  const saved = vi.fn();
  const user = userEvent.setup();

  // Plain JS without the author types, passing props outside the contract.
  const loose = ui as unknown as Record<
    keyof PluginUi,
    (props: Record<string, unknown>) => ReturnType<PluginUi["Button"]>
  >;
  const { Button, Field, Switch } = ui;
  function Page() {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [attempted, setAttempted] = useState(false);
    const [alerts, setAlerts] = useState(false);
    const save = (event: { preventDefault(): void }) => {
      event.preventDefault();
      setAttempted(true);
      if (!name) return;
      saved(name);
      setOpen(false);
    };
    return h(
      "section",
      null,
      // A Switch applies at once, so it lives on the page, not behind Save.
      h(Switch, {
        label: "Desktop alerts",
        checked: alerts,
        onCheckedChange: setAlerts,
      }),
      h(
        loose.Button,
        {
          variant: "glass",
          className: "plugin-chrome",
          onClick: () => setOpen(true),
        },
        "Edit profile",
      ),
      h(
        loose.Dialog,
        {
          open,
          onOpenChange: setOpen,
          title: "Profile",
          description: "Shown to people in this community.",
          dismissOnOutsideClick: false,
          // Host-owned options are not part of the contract.
          visit: true,
          // The footer sits outside the body, so Save names the form it submits.
          actions: h(
            Button,
            { variant: "prominent", type: "submit", form: "profile" },
            "Save",
          ),
        },
        // Fields that cannot take focus come first; the dialog skips them.
        h(
          "fieldset",
          { disabled: true },
          h(loose.Input, { "aria-label": "Locked" }),
        ),
        h(
          "div",
          { style: { display: "none" } },
          h(loose.Input, { "aria-label": "Later" }),
        ),
        h(
          "details",
          null,
          h("summary", { tabIndex: -1 }, "More"),
          h(loose.Input, { "aria-label": "Folded" }),
        ),
        h(
          "form",
          { id: "profile", onSubmit: save },
          h(
            Field,
            {
              label: "Display name",
              error: attempted && !name ? "Required" : "",
            },
            h(loose.Input, {
              value: name,
              onValueChange: (...args: unknown[]) => setName(args.join("|")),
            }),
          ),
        ),
      ),
    );
  }

  const view = render(h(Page));
  const alerts = screen.getByRole("switch", { name: "Desktop alerts" });
  await user.click(alerts);
  expect(alerts).toBeChecked();
  const trigger = screen.getByRole("button", { name: "Edit profile" });
  expect(trigger).toHaveAttribute("data-variant", "subtle");
  expect(trigger).not.toHaveClass("plugin-chrome");

  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Profile" });
  expect(dialog).toHaveAccessibleDescription(
    "Shown to people in this community.",
  );
  const input = screen.getByRole("textbox", { name: "Display name" });
  // Opens on the field, not on header Close, where Enter would discard it.
  await vi.waitFor(() => expect(input).toHaveFocus());
  expect(input).not.toHaveAttribute("aria-invalid");
  // The footer Save submits the body's form.
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("alert")).toHaveTextContent("Required");
  await user.type(input, "Ada");
  // Only the value reaches the plugin, never Base UI's event details.
  expect(input).toHaveValue("Ada");
  expect(input).not.toHaveAttribute("aria-invalid");
  await user.type(input, "{Enter}");
  expect(saved).toHaveBeenCalledExactlyOnceWith("Ada");
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Escape returns focus. Then unmount the page with the dialog open; this is
  // component cleanup only, not the plugin runtime's disable path.
  await user.click(trigger);
  await screen.findByRole("dialog", { name: "Profile" });
  await user.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await screen.findByRole("dialog", { name: "Profile" });
  view.unmount();
  // No leftover portal, inert siblings or scroll lock.
  expect(document.body.innerHTML).toBe("<div></div>");
  await vi.waitFor(() => expect(document.body.style.overflowY).toBe(""));
});

it("treats plain-JS values of the wrong type as absent", async () => {
  const loose = pluginUi as unknown as Record<
    keyof PluginUi,
    (props: Record<string, unknown>) => ReturnType<PluginUi["Button"]>
  >;
  const user = userEvent.setup();
  render(
    h(
      "div",
      null,
      h(loose.Button, { disabled: 1, onClick: "x" }, "Go"),
      h(loose.Input, { "aria-label": "Name", disabled: 1, maxLength: "4" }),
      h(loose.Switch, { label: "Alerts", disabled: 1, checked: "yes" }),
      h(loose.Switch, { label: null, "aria-label": "Sync" }),
    ),
  );
  const go = screen.getByRole("button", { name: "Go" });
  expect(go).toBeEnabled();
  await user.click(go);
  const name = screen.getByRole("textbox", { name: "Name" });
  expect(name).toBeEnabled();
  expect(name).not.toHaveAttribute("maxlength");
  const alerts = screen.getByRole("switch", { name: "Alerts" });
  expect(alerts).not.toHaveAttribute("aria-disabled");
  expect(alerts).not.toBeChecked();
  expect(screen.getByRole("switch", { name: "Sync" })).toBeInTheDocument();
});
