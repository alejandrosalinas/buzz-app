// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AgentCardPreview } from "./AgentCardPreview";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-keyboard-navigation");
});

it("waits for each image to load before revealing it", () => {
  const { container, rerender } = render(
    <AgentCardPreview src="blob:first" alt="Ada’s agent card" />,
  );
  expect(container.querySelector("[data-ready]")).toHaveAttribute(
    "data-ready",
    "false",
  );
  fireEvent.load(screen.getByRole("img"));
  expect(container.querySelector("[data-ready]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  rerender(<AgentCardPreview src="blob:second" alt="Ada’s agent card" />);
  expect(container.querySelector("[data-ready]")).toHaveAttribute(
    "data-ready",
    "false",
  );
  fireEvent.load(screen.getByRole("img"));
  expect(container.querySelector("[data-ready]")).toHaveAttribute(
    "data-ready",
    "true",
  );
});

it("leaves the image alternative visible if the preview cannot load", () => {
  const { container } = render(
    <AgentCardPreview src="blob:missing" alt="Ada’s agent card" />,
  );
  fireEvent.error(screen.getByRole("img", { name: "Ada’s agent card" }));
  expect(container.querySelector("[data-ready]")).toHaveAttribute(
    "data-ready",
    "true",
  );
});

it("shows keyboard-opened cards immediately without replaying on pointer use", () => {
  document.documentElement.setAttribute("data-keyboard-navigation", "");
  const { container, rerender } = render(
    <AgentCardPreview src="blob:first" alt="Ada’s agent card" />,
  );
  fireEvent.load(screen.getByRole("img"));
  document.documentElement.removeAttribute("data-keyboard-navigation");
  rerender(<AgentCardPreview src="blob:first" alt="Ada’s agent card" />);
  expect(container.querySelector("[data-ready]")).toHaveAttribute(
    "data-animate",
    "false",
  );
});
