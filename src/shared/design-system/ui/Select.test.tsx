// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { Select } from "./Select";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

it("separates groups without adding a keyboard selection stop", async () => {
  const user = userEvent.setup();
  function Grouped() {
    const [value, setValue] = useState("public");
    return (
      <Select
        label="Access"
        value={value}
        onValueChange={setValue}
        groups={[
          { label: "", options: [{ value: "public", label: "Public" }] },
          {
            label: "",
            separator: true,
            options: [{ value: "private", label: "Private" }],
          },
        ]}
      />
    );
  }
  render(<Grouped />);
  const trigger = screen.getByRole("combobox", { name: "Access" });
  await user.click(trigger);
  const listbox = await screen.findByRole("listbox");
  expect(listbox.querySelector(".buzz-select-separator")).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Public" })).toHaveFocus(),
  );
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Private" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  expect(trigger).toHaveTextContent("Private");
  expect(trigger).toHaveFocus();
});

function Late({ variant }: { variant: "inline" | "compact" | "field" }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void Promise.resolve().then(() => setReady(true));
  }, []);
  return ready ? (
    <Select
      label="Retention"
      variant={variant}
      value="1"
      groups={[{ label: "", options: [{ value: "1", label: "1 day" }] }]}
      onValueChange={() => {}}
    />
  ) : null;
}

for (const variant of ["inline", "compact", "field"] as const) {
  it(`${variant} trigger is named in the commit that inserts it`, async () => {
    const env = globalThis as {
      IS_REACT_ACT_ENVIRONMENT?: boolean | undefined;
    };
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    let observer: MutationObserver | undefined;
    // Resolves in the first DOM change that contains the trigger, with
    // whether it was already named at that moment.
    const firstSeen = new Promise<boolean>((resolve) => {
      observer = new MutationObserver(() => {
        if (!screen.queryByRole("combobox")) return;
        observer?.disconnect();
        resolve(screen.queryByRole("combobox", { name: "Retention" }) !== null);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    let named: boolean;
    try {
      render(<Late variant={variant} />);
      // Outside act, React commits the late update and runs passive effects
      // in a later scheduler task, as it does when a host read resolves.
      env.IS_REACT_ACT_ENVIRONMENT = false;
      named = await firstSeen;
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previous;
      observer?.disconnect();
    }
    expect(named).toBe(true);
    expect(screen.getByRole("combobox", { name: "Retention" })).toBeVisible();
  });
}

it.each(["inline", "compact", "preference"] as const)(
  "keeps the intended button shape for %s selects",
  (variant) => {
    render(
      <Select
        label="Model"
        variant={variant}
        value="one"
        groups={[{ label: "", options: [{ value: "one", label: "One" }] }]}
        onValueChange={() => {}}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
      "data-button-shape",
      variant === "preference" ? "control" : "capsule",
    );
  },
);

it("keeps the setting label available while disabling a preference control", () => {
  render(
    <Select
      label="Model"
      variant="preference"
      value="one"
      disabled
      groups={[{ label: "", options: [{ value: "one", label: "One" }] }]}
      onValueChange={() => {}}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Model" });
  expect(trigger).toBeDisabled();
  const row = trigger.closest(".buzz-preference-row");
  expect(row).not.toBeNull();
  expect(row).not.toHaveAttribute("data-disabled");
  expect(row?.querySelector(".buzz-preference-row-label")).toBeVisible();
});

it("keeps a controlled replacement when its previous option is removed, and still supports typeahead", async () => {
  const user = userEvent.setup();
  function Choices() {
    const [value, setValue] = useState("");
    return (
      <>
        <button type="button" onClick={() => setValue("custom")}>
          Use custom
        </button>
        <button type="button" onClick={() => setValue("new")}>
          Use saved
        </button>
        <Select
          label="Model"
          value={value}
          onValueChange={setValue}
          groups={[
            {
              label: "",
              options: [
                { value: "", label: "Default" },
                { value: "new", label: "New model" },
                ...(value === "custom"
                  ? [{ value: "custom", label: "Custom model" }]
                  : []),
              ],
            },
          ]}
        />
        <output aria-label="Selected model">{value || "default"}</output>
      </>
    );
  }
  render(<Choices />);
  const trigger = screen.getByRole("combobox", { name: "Model" });
  await user.click(trigger);
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Default" })).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(trigger).toHaveAttribute("aria-expanded", "false"),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(screen.getByRole("button", { name: "Use custom" }));
  expect(trigger).toHaveTextContent("Custom model");
  await user.click(trigger);
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Custom model" })).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(trigger).toHaveAttribute("aria-expanded", "false"),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(screen.getByRole("button", { name: "Use saved" }));
  expect(trigger).toHaveTextContent("New model");
  expect(screen.getByLabelText("Selected model")).toHaveTextContent("new");
  expect(screen.getByRole("button", { name: "Use saved" })).toHaveFocus();
  await user.tab();
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.keyboard("d");
  await waitFor(() => expect(trigger).toHaveTextContent("Default"));
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: "New model" }));
  expect(trigger).toHaveTextContent("New model");
});
