// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SettingsGroup, SettingsGroupExpand } from "./SettingsGroup";
import { ValueChip } from "./ValueChip";

afterEach(cleanup);

it("mounts rows when first opened, then keeps them out of reach while closed", () => {
  const view = (open: boolean) => (
    <SettingsGroup>
      <SettingsGroupExpand open={open}>
        <input aria-label="Draft" defaultValue="kept" />
      </SettingsGroupExpand>
    </SettingsGroup>
  );
  const { container, rerender } = render(view(false));
  const expand = container.querySelector(".buzz-settings-group-expand");
  expect(expand).toHaveAttribute("inert");
  expect(expand).not.toHaveAttribute("data-open");
  // Never opened, its rows do no work.
  expect(screen.queryByLabelText("Draft")).toBeNull();
  rerender(view(true));
  expect(expand).not.toHaveAttribute("inert");
  expect(expand).toHaveAttribute("data-open");
  const draft = screen.getByLabelText("Draft");
  rerender(view(false));
  expect(expand).toHaveAttribute("inert");
  // The same element, so a draft typed while open survives closing.
  expect(screen.getByLabelText("Draft")).toBe(draft);
  expect(draft).toHaveValue("kept");
});

it("names a chip's value for assistive technology beside its mark", () => {
  render(
    <ValueChip icon={<svg />} label="Example harness">
      Model A · High
    </ValueChip>,
  );
  expect(screen.getByText("Example harness:")).toHaveClass("sr-only");
  expect(screen.getByText("Model A · High")).toBeInTheDocument();
});
