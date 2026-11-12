// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import type { HuddleView } from "../../features/huddle/window";
import { HuddleWindowView } from "./HuddleWindowView";

stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows and clears the connected call's voice error alongside window errors", () => {
  const view: HuddleView = {
    id: "call",
    title: "Huddle",
    phase: "connected",
    muted: false,
    level: 0,
    dark: false,
    participants: [],
    error: "Codex: Voice disconnected. Leave and rejoin the Huddle to retry.",
  };
  const act = vi.fn();
  const mounted = render(<HuddleWindowView view={view} act={act} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Codex: Voice disconnected.",
  );
  mounted.rerender(
    <HuddleWindowView
      view={view}
      act={act}
      error="Couldn’t update the call."
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn’t update the call.",
  );
  mounted.rerender(<HuddleWindowView view={view} act={act} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Codex: Voice disconnected.",
  );
  mounted.rerender(
    <HuddleWindowView view={{ ...view, error: undefined }} act={act} />,
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("starts normally, listens while you talk, thinks, and pulses like a human", () => {
  const agent = {
    key: "agent",
    name: "Agent",
    picture: null,
    own: false,
    listening: true,
    level: 0,
  };
  const human = {
    key: "human",
    name: "Human",
    picture: null,
    own: true,
    level: 0,
  };
  const view: HuddleView = {
    id: "call",
    title: "Huddle",
    phase: "connected",
    muted: false,
    level: 0,
    dark: false,
    participants: [human, agent],
  };
  const mounted = render(<HuddleWindowView view={view} act={vi.fn()} />);
  const art = (key = "agent") =>
    mounted.container.querySelector<HTMLElement>(
      `${key === "human" ? "[data-self]" : '[data-participant="agent"]'} [class*="bubbleArtwork"]`,
    );
  const scale = (key = "agent") =>
    art(key)?.style.getPropertyValue("--voice-scale");
  const update = (
    changes: Partial<typeof agent> & { thinking?: boolean } = {},
    humanLevel = 0,
    muted = false,
  ) =>
    mounted.rerender(
      <HuddleWindowView
        view={{
          ...view,
          muted,
          participants: [
            { ...human, level: humanLevel },
            { ...agent, ...changes },
          ],
        }}
        act={vi.fn()}
      />,
    );

  expect(scale()).toBe("1");
  expect(scale()).toBe(scale("human"));
  expect(screen.queryByRole("img", { name: /listening to you/ })).toBeNull();
  update({}, 0.3);
  expect(scale()).toBe("0.8");
  expect(Number(scale("human"))).toBeGreaterThan(1);
  expect(
    screen.getByRole("img", { name: "Agent, listening to you" }),
  ).toBeInTheDocument();
  update({}, 0.3, true);
  expect(scale()).toBe("1");
  update({ listening: false }, 0.3);
  expect(scale()).toBe("1");
  update({ thinking: true });
  expect(scale()).toBe("0.8");
  expect(art()?.hasAttribute("data-thinking")).toBe(true);
  update({ thinking: true, level: 0.3 });
  expect(Number(scale())).toBeGreaterThan(1);
  expect(art()?.hasAttribute("data-thinking")).toBe(false);
  // Speech and the gaps between words use the same range as a human.
  for (const level of [0.2, 0.6, 0, 1, 0.4, 0]) {
    update({ level }, level);
    if (level === 0) expect(scale()).toBe("1");
    expect(scale()).toBe(scale("human"));
  }
});
