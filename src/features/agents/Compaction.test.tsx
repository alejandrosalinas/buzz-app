// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { CompactionField } from "./Compaction";
import { compactAt } from "./compact-at";

afterEach(cleanup);

it("accepts whole thousands from 100K and nothing else", () => {
  expect(compactAt("100000")).toBe(100000);
  expect(compactAt("150000")).toBe(150000);
  for (const value of [
    "99000",
    "150500",
    "1e5",
    "10000000000000000000",
    "",
    undefined,
    150000,
  ])
    expect(compactAt(value)).toBeUndefined();
});

function Harness({ saved }: { saved: string[] }) {
  const [value, setValue] = useState<string | undefined>("200000");
  return (
    <CompactionField
      value={value}
      onChange={(next) => {
        saved.push(next);
        setValue(next || undefined);
      }}
    />
  );
}

it("saves only valid sizes and shows the harness default when blank", async () => {
  const user = userEvent.setup();
  const saved: string[] = [];
  render(<Harness saved={saved} />);
  const field = screen.getByRole("textbox", {
    name: "Auto-compact at (thousands of tokens)",
  });
  expect(field).toHaveValue("200");
  expect(field).toHaveAccessibleDescription(
    "Compacts at this many tokens, or sooner if the model's context window fills first.",
  );

  await user.clear(field);
  expect(field).toHaveAttribute("placeholder", "Harness default");
  expect(saved).toEqual([""]);

  await user.type(field, "50");
  expect(screen.getByRole("alert")).toHaveTextContent("at least 100K");
  // Its error stays, and stops a form saving the blank staged before it.
  await user.tab();
  expect(field).toHaveValue("50");
  expect(field).toBeInvalid();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  // Back on the field, a screen reader hears what is wrong.
  await user.click(field);
  expect(field).toHaveAccessibleDescription(
    "Compacts at this many tokens, or sooner if the model's context window fills first. Enter a whole number of at least 100K, or leave it blank for the harness default.",
  );

  await user.clear(field);
  await user.type(field, "150");
  expect(saved.at(-1)).toBe("150000");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps a form from saving while the size is invalid", async () => {
  const user = userEvent.setup();
  const submitted: string[] = [];
  function Form() {
    const [value, setValue] = useState<string | undefined>("200000");
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted.push(value ?? "");
        }}
      >
        <CompactionField value={value} onChange={setValue} />
        <button type="submit">Save</button>
      </form>
    );
  }
  render(<Form />);
  const field = screen.getByRole("textbox", {
    name: "Auto-compact at (thousands of tokens)",
  });
  await user.clear(field);
  await user.type(field, "50");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(submitted).toEqual([]);

  await user.clear(field);
  await user.type(field, "300");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(submitted).toEqual(["300000"]);
});
