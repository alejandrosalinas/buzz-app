// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SoloChatTitle } from "./SoloChatTitle";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("replaces the visible and accessible title immediately with reduced motion", () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", () => media);
  const { rerender } = render(<SoloChatTitle title="First" />, {
    wrapper: ({ children }) => <button type="button">{children}</button>,
  });
  rerender(<SoloChatTitle title="Renamed" />);

  expect(screen.queryByText("First")).toBeNull();
  expect(
    screen.getByText("Renamed", { selector: '[aria-hidden="true"]' }),
  ).toBeVisible();
  expect(screen.getByRole("button")).toHaveAccessibleName("Renamed");
});
