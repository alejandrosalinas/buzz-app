// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { KeyState } from "./key";
import { TypeSafeSettings } from "./TypeSafeSettings";

afterEach(cleanup);

async function action(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "API key actions" }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

/** The key as the form uses it, with a store that can fail. */
function fake(desktop = true, keyState: KeyState = "missing") {
  const listeners = new Set<() => void>();
  const set = (next: KeyState) => {
    keyState = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => keyState,
    desktop: () => desktop,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    save: vi.fn(async (_key: string) => set("saved")),
    clear: vi.fn(async () => set("missing")),
  };
}

it("asks for the desktop app in the browser", () => {
  render(<TypeSafeSettings typesafe={fake(false)} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("desktop app");
  expect(screen.queryByLabelText("TypeSafe API key")).not.toBeInTheDocument();
});

it("adds, replaces, and confirms removal without revealing a saved key", async () => {
  const user = userEvent.setup();
  const typesafe = fake();
  render(<TypeSafeSettings typesafe={typesafe} active={() => true} apple />);
  const input = screen.getByLabelText("TypeSafe API key");
  const save = screen.getByRole("button", { name: "Save" });
  expect(input).toHaveAttribute("type", "password");
  expect(save).toHaveAttribute("aria-disabled", "true");
  await user.type(input, "tk-draft");
  expect(save).toHaveAttribute("aria-disabled", "false");
  expect(input.closest(".buzz-input-group")).toContainElement(save);
  await user.clear(input);
  expect(save).toHaveAttribute("aria-disabled", "true");
  expect(input).toHaveFocus();
  expect(input.closest(".buzz-settings-group")).toHaveAttribute(
    "data-layout",
    "form",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Your key will be stored securely on this computer.",
  );
  await user.type(input, "  tk-secret  ");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(typesafe.save).toHaveBeenCalledWith("tk-secret");
  expect(screen.getByLabelText("TypeSafe API key")).toHaveAttribute("readonly");
  expect(screen.getByLabelText("TypeSafe API key")).toHaveAttribute(
    "type",
    "password",
  );
  expect(screen.getByLabelText("TypeSafe API key")).not.toHaveValue(
    "tk-secret",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Saved securely on this computer.",
  );
  expect(
    screen.getByRole("status").closest(".buzz-field-description"),
  ).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  await action(user, "Replace");
  const replacement = screen.getByLabelText("TypeSafe API key");
  expect(replacement.closest(".buzz-input-group")).toContainElement(
    screen.getByRole("button", { name: "Cancel" }),
  );
  expect(replacement).toHaveValue("");
  expect(replacement).toHaveAttribute("type", "password");
  expect(screen.queryByRole("button", { name: "API key actions" })).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.type(replacement, "discarded");
  expect(replacement.closest(".buzz-input-group")).toContainElement(
    screen.getByRole("button", { name: "Save" }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(typesafe.save).toHaveBeenCalledTimes(1);
  await action(user, "Replace");
  expect(screen.getByLabelText("TypeSafe API key")).toHaveValue("");
  await user.type(screen.getByLabelText("TypeSafe API key"), "  tk-new  ");
  typesafe.save.mockRejectedValueOnce(new Error("Storage locked"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Storage locked");
  expect(screen.getByLabelText("TypeSafe API key")).toHaveValue("  tk-new  ");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(typesafe.save).toHaveBeenLastCalledWith("tk-new");
  await action(user, "Remove");
  expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
    "This removes the key from this Mac’s Keychain. Add a key again to keep using TypeSafe.",
  );
  expect(typesafe.clear).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "API key actions" }),
    ).toHaveFocus(),
  );
  await action(user, "Remove");
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Remove key",
    }),
  );
  expect(typesafe.clear).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Your key will be stored securely on this computer.",
  );
});

it("keeps a failed removal open and refuses writes after leaving settings", async () => {
  const user = userEvent.setup();
  const typesafe = fake(true, "saved");
  let active = true;
  typesafe.clear.mockRejectedValueOnce("Storage locked");
  render(
    <TypeSafeSettings
      typesafe={typesafe}
      active={() => active}
      apple={false}
    />,
  );
  await action(user, "Remove");
  expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
    "This removes the key from this device’s secure storage. Add a key again to keep using TypeSafe.",
  );
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Storage locked");
  expect(typesafe.snapshot()).toBe("saved");
  active = false;
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(typesafe.clear).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "API key actions" }),
    ).toHaveFocus(),
  );
});

it("keeps the typed key and shows why a save failed", async () => {
  const user = userEvent.setup();
  const typesafe = fake();
  typesafe.save.mockRejectedValueOnce(
    new Error("That does not look like a TypeSafe API key"),
  );
  render(<TypeSafeSettings typesafe={typesafe} active={() => true} />);
  await user.type(screen.getByLabelText("TypeSafe API key"), "bad key");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "does not look like",
  );
  expect(screen.getByLabelText("TypeSafe API key")).toHaveValue("bad key");
});

it("does not call a key missing until its status is read, or when it cannot be", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <TypeSafeSettings typesafe={fake(true, "checking")} active={() => true} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Checking");
  expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  const unreadable = fake(true, "unreadable");
  rerender(<TypeSafeSettings typesafe={unreadable} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("could not read");
  expect(screen.getByLabelText("TypeSafe API key")).toBeVisible();
  await action(user, "Remove");
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(unreadable.clear).toHaveBeenCalledOnce();
  rerender(
    <TypeSafeSettings typesafe={fake(true, "refused")} active={() => true} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "TypeSafe did not accept your key",
  );
  expect(screen.getByLabelText("TypeSafe API key")).toBeVisible();
});

it("warns that other programs can read the key only off Apple platforms", () => {
  const text = /Other programs you run, agent shells included, can read/;
  const { unmount } = render(
    <TypeSafeSettings typesafe={fake()} active={() => true} apple={false} />,
  );
  expect(screen.getByText(text)).toBeVisible();
  unmount();
  render(<TypeSafeSettings typesafe={fake()} active={() => true} apple />);
  expect(screen.queryByText(text)).not.toBeInTheDocument();
});
