// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CountBadge } from "./CountBadge";

afterEach(cleanup);

describe("CountBadge", () => {
  it("shows the count with its spoken label", () => {
    render(<CountBadge count={5} label="5 drafts" />);
    expect(screen.getByRole("img", { name: "5 drafts" }).textContent).toBe("5");
  });

  it("caps the visible number at 99+ while the label keeps the exact count", () => {
    render(<CountBadge count={1200} label="1200 drafts" />);
    expect(screen.getByRole("img", { name: "1200 drafts" }).textContent).toBe(
      "99+",
    );
  });

  it("renders nothing for zero", () => {
    const { container } = render(<CountBadge count={0} label="0 drafts" />);
    expect(container).toBeEmptyDOMElement();
  });
});
