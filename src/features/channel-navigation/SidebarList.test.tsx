// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SidebarList } from "./SidebarList";

test("the sidebar list fades only the edges with rows scrolled past them", () => {
  const ref = createRef<HTMLElement>();
  render(
    <SidebarList navigation={{ label: "Conversations", ref }}>
      <span>Row</span>
    </SidebarList>,
  );
  const list = screen.getByRole("navigation", { name: "Conversations" });
  expect(ref.current).toBe(list);
  expect(list).toHaveAttribute("data-scroll-fade", "scrolled");
  // At rest with nothing past either edge, the list stays crisp.
  expect(list).not.toHaveAttribute("data-overflow-start");
  expect(list).not.toHaveAttribute("data-overflow-end");
  Object.defineProperty(list, "scrollHeight", { value: 300 });
  Object.defineProperty(list, "clientHeight", { value: 100 });
  fireEvent.scroll(list);
  expect(list).not.toHaveAttribute("data-overflow-start");
  expect(list).toHaveAttribute("data-overflow-end");
  list.scrollTop = 200;
  fireEvent.scroll(list);
  expect(list).toHaveAttribute("data-overflow-start");
  expect(list).not.toHaveAttribute("data-overflow-end");
});
