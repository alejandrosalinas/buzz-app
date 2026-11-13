// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TimeZoneField } from "./TimeZoneField";

afterEach(cleanup);

// Engines list one spelling of a renamed zone: V8 (these tests) lists only
// Asia/Calcutta and Europe/Kiev, and none list UTC by that name.
const listed = (current: string, old: string) =>
  Intl.supportedValuesOf("timeZone").includes(current) ? current : old;

it.each([
  ["Kolkata", listed("Asia/Kolkata", "Asia/Calcutta")],
  ["Kyiv", listed("Europe/Kyiv", "Europe/Kiev")],
  ["UTC", "UTC"],
])("finds %s and writes the zone as listed", async (query, zone) => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<TimeZoneField value="America/Los_Angeles" onChange={onChange} />);
  await user.click(screen.getByRole("combobox", { name: "Time zone" }));
  await user.type(
    await screen.findByRole("combobox", { name: "Search" }),
    query,
  );
  await user.click(
    await screen.findByRole("option", {
      name: new RegExp(`^${zone.replaceAll("_", " ")}`),
    }),
  );
  expect(onChange).toHaveBeenCalledWith(zone);
});
