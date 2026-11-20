// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarActiveDialog } from "./SidebarActiveDialog";

afterEach(cleanup);

it("starts with the saved preset and cancels without writing", async () => {
  const apply = vi.fn(),
    close = vi.fn();
  render(
    <SidebarActiveDialog
      seconds={7 * 86400}
      apply={apply}
      close={close}
      finalFocus={{ current: null }}
    />,
  );
  expect(screen.getByRole("radio", { name: "7 days" })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it("retains a preset after failed confirmation and prevents closing while saving", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const apply = vi
    .fn()
    .mockImplementationOnce(() => gate)
    .mockResolvedValue(undefined);
  const close = vi.fn();
  render(
    <SidebarActiveDialog
      apply={apply}
      close={close}
      finalFocus={{ current: null }}
    />,
  );
  await user.click(screen.getByRole("radio", { name: "90 days" }));
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(apply).toHaveBeenCalledExactlyOnceWith(90 * 86400);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("radio", { name: "7 days" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error("Duration not confirmed")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Duration not confirmed",
  );
  expect(screen.getByRole("radio", { name: "90 days" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(apply).toHaveBeenLastCalledWith(90 * 86400);
});

it("offers five presets and opens an older custom value as a 30-day draft", async () => {
  const user = userEvent.setup();
  const apply = vi.fn();
  render(
    <SidebarActiveDialog
      seconds={14 * 86400}
      apply={apply}
      close={vi.fn()}
      finalFocus={{ current: null }}
    />,
  );
  expect(
    screen.getAllByRole("radio").map((radio) => radio.textContent),
  ).toHaveLength(5);
  expect(screen.queryByRole("radio", { name: "Custom" })).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.getByRole("radio", { name: "30 days" })).toBeChecked();
  expect(apply).not.toHaveBeenCalled();
  await user.click(screen.getByRole("radio", { name: "1 day" }));
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(apply).toHaveBeenCalledExactlyOnceWith(86400);
});

it("applies the 3-day preset as 72 hours", async () => {
  const user = userEvent.setup();
  const apply = vi.fn();
  render(
    <SidebarActiveDialog
      seconds={3 * 86400}
      apply={apply}
      close={vi.fn()}
      finalFocus={{ current: null }}
    />,
  );
  expect(screen.getByRole("radio", { name: "3 days" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(apply).toHaveBeenCalledExactlyOnceWith(72 * 3600);
});
