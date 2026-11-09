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

it("rests a seated agent smaller, rings it while thinking and restores it for speech", () => {
  const agent = {
    key: "agent",
    name: "Agent",
    picture: null,
    own: false,
    listening: true,
    level: 0,
  };
  const view: HuddleView = {
    id: "call",
    title: "Huddle",
    phase: "connected",
    muted: false,
    level: 0,
    dark: false,
    participants: [agent],
  };
  const mounted = render(<HuddleWindowView view={view} act={vi.fn()} />);
  const art = () =>
    mounted.container.querySelector<HTMLElement>('[class*="bubbleArtwork"]');
  const scale = () => art()?.style.getPropertyValue("--voice-scale");
  const update = (changes: Partial<typeof agent> & { thinking?: boolean }) =>
    mounted.rerender(
      <HuddleWindowView
        view={{ ...view, participants: [{ ...agent, ...changes }] }}
        act={vi.fn()}
      />,
    );
  expect(scale()).toBe("0.8");
  expect(art()?.hasAttribute("data-thinking")).toBe(false);
  update({ thinking: true });
  expect(scale()).toBe("0.8");
  expect(art()?.hasAttribute("data-thinking")).toBe(true);
  update({ thinking: true, level: 0.3 });
  expect(Number(scale())).toBeGreaterThan(1);
  expect(art()?.hasAttribute("data-thinking")).toBe(false);
  update({});
  expect(scale()).toBe("0.8");
  update({ listening: false });
  expect(scale()).toBe("1");
});
