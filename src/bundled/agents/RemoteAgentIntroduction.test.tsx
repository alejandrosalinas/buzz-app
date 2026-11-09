// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { RemoteAgentIntroduction } from "./RemoteAgentIntroduction";
import styles from "./AgentCreate.module.css";

// Motion captures RAF at import time; control its real scheduler from the start.
const clock = vi.hoisted(() => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const request = (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  const cancel = (id: number) => frames.delete(id);
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  return { now: 0, reduced: false, frames, request, cancel };
});
vi.mock("motion/react", async (actual) => ({
  ...(await actual<typeof import("motion/react")>()),
  useReducedMotion: () => clock.reduced,
}));

stubAvatarBrowserApis();
beforeEach(() => {
  clock.now = 0;
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  vi.stubGlobal("requestAnimationFrame", clock.request);
  vi.stubGlobal("cancelAnimationFrame", clock.cancel);
});
afterEach(async () => {
  cleanup();
  await frame(clock.now + 10_000);
  clock.frames.clear();
  clock.reduced = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function frame(at: number) {
  clock.now = at;
  // Motion caches a frame's time until its microtask clears it.
  await act(async () => {
    for (const [id, callback] of [...clock.frames]) {
      clock.frames.delete(id);
      callback(at);
    }
  });
}

const introduction = (builderlab = true, name = "Nova") => (
  <RemoteAgentIntroduction
    name={name}
    avatar={{ kind: "image", picture: "https://images.example/nova.png" }}
    builderlab={builderlab}
  />
);

function speechIn(container: HTMLElement) {
  const speech = container.querySelector<HTMLDivElement>(
    `.${styles.remoteSpeech}`,
  );
  if (!speech) throw new Error("Missing speech bubble");
  return speech;
}

it("lays out the full disclosure from the start and staggers real Motion character entrances", async () => {
  const { container } = render(introduction(true, "Nova 👩🏽‍💻"));
  const speech = speechIn(container);
  const portrait = within(container).getByRole("img", {
    name: "Nova 👩🏽‍💻’s avatar",
  });
  const visual = speech.querySelector<HTMLDivElement>(
    `.${styles.remoteSpeechCopy}[aria-hidden]`,
  );
  if (!visual) throw new Error("Missing visual stream");
  const fullText = visual.textContent;
  expect(fullText).toContain("Hi, I’m Nova 👩🏽‍💻.");
  expect(fullText).not.toContain("👋");
  expect(fullText).toContain(
    "Since I’m a remote agent hosted by Builderlab, I’m always ready for you.",
  );
  expect(fullText).toContain("from your phone, even when this computer is off");
  expect(fullText).toContain(
    "I just won’t be able to open files on this computer.",
  );
  expect(fullText).toMatch(/So… what are we getting into\?$/);
  // Assistive technology gets all four paragraphs, with no duplicate stream.
  const paragraphs = within(speech).getAllByRole("paragraph");
  expect(paragraphs).toHaveLength(4);
  expect(paragraphs[1]).toHaveTextContent(
    /^Since I’m a remote agent hosted by Builderlab, I’m always ready for you\.$/,
  );
  expect(paragraphs[2]).toHaveTextContent(
    /^You can chat with me from your phone, even when this computer is off\. I just won’t be able to open files on this computer\.$/,
  );
  const characters = visual.querySelectorAll<HTMLSpanElement>(
    `.${styles.remoteSpeechCharacter}`,
  );
  expect(
    [...characters].some((character) => character.textContent === "👩🏽‍💻"),
  ).toBe(true);
  const first = characters[0];
  const last = characters[characters.length - 1];
  const badge = visual.querySelector(`.${styles.remoteProvider}`);
  if (!first || !last || !badge) throw new Error("Missing characters or badge");
  expect(badge).toHaveTextContent(/^Builderlab$/);
  expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  const providerCharacters = [
    ...badge.querySelectorAll<HTMLSpanElement>(
      `.${styles.remoteSpeechCharacter}`,
    ),
  ].filter((character) => character.textContent);
  expect(providerCharacters.map((character) => character.textContent)).toEqual([
    ..."Builderlab",
  ]);
  expect(first).toHaveStyle({ opacity: "0", filter: "blur(0.5px)" });
  expect(first.style.transform).toContain("scale(1.05)");
  expect(portrait).toHaveStyle({ opacity: "0" });
  expect(portrait.style.transform).toContain("scale(0.75)");
  expect(speech).toHaveStyle({ opacity: "0" });
  // Motion starts animations in its post-render microtask, before the next frame.
  await act(async () => {});
  expect(clock.frames.size).toBeGreaterThan(0);
  await frame(0);
  await frame(16);
  await frame(300);
  expect(portrait).toHaveStyle({ opacity: "1" });
  expect(first).toHaveStyle({ opacity: "0" });
  await frame(550);
  expect(speech).toHaveStyle({ opacity: "1" });
  expect(first).toHaveStyle({ opacity: "0" });
  await frame(800);
  expect(first).toHaveStyle({ opacity: "1", filter: "blur(0px)" });
  expect(last).toHaveStyle({ opacity: "0", filter: "blur(0.5px)" });
  // The provider name joins the same stream, rather than appearing as one badge.
  await frame(560 + (fullText ?? "").indexOf("Builderlab") * 10.7 + 140);
  expect(Number(providerCharacters[0]?.style.opacity)).toBeGreaterThan(
    Number(providerCharacters.at(-1)?.style.opacity),
  );
  await frame(10_000);
  expect(last).toHaveStyle({ opacity: "1", filter: "blur(0px)" });
  expect(last.style.transform).toBe("none");
  expect(visual.textContent).toBe(fullText);
  expect(
    visual.querySelectorAll(`.${styles.remoteSpeechCharacter}`),
  ).toHaveLength(characters.length);
});

it("shows plain full copy with reduced motion, including a preference change mid-stream", () => {
  const { container, rerender } = render(introduction());
  expect(
    container.querySelector(`.${styles.remoteSpeechCharacter}`),
  ).toBeInTheDocument();
  vi.mocked(Math.random).mockReturnValue(0.999);
  clock.reduced = true;
  rerender(introduction());
  const speech = speechIn(container);
  expect(
    speech.querySelector(`.${styles.remoteSpeechCharacter}`),
  ).not.toBeInTheDocument();
  expect(speech).toHaveTextContent("Hi, I’m Nova.");
  expect(speech).toHaveTextContent(
    "Since I’m a remote agent hosted by Builderlab",
  );
  expect(speech).toHaveTextContent(
    "I just won’t be able to open files on this computer.",
  );
  expect(speech).toHaveTextContent("So… what are we getting into?");
  expect(speech).not.toHaveTextContent("All right. What’s the plot?");
  expect(within(speech).getAllByRole("paragraph")).toHaveLength(4);
});

it("chooses a fresh ending when the introduction opens again", () => {
  clock.reduced = true;
  const first = render(introduction());
  expect(speechIn(first.container)).toHaveTextContent(
    "So… what are we getting into?",
  );
  first.unmount();
  vi.mocked(Math.random).mockReturnValue(0.999);
  const next = render(introduction());
  expect(speechIn(next.container)).toHaveTextContent(
    "All right. What’s the plot?",
  );
  expect(speechIn(next.container)).not.toHaveTextContent(
    "So… what are we getting into?",
  );
});

it("describes another remote runtime without promising Builderlab capabilities", () => {
  clock.reduced = true;
  const { container } = render(introduction(false));
  const speech = speechIn(container);
  expect(speech).toHaveTextContent("I work on another computer.");
  expect(speech).toHaveTextContent(
    "My availability and file access depend on that computer’s setup.",
  );
  expect(speech).not.toHaveTextContent("always ready");
  expect(speech).not.toHaveTextContent("from your phone");
  expect(speech).not.toHaveTextContent("won’t be able to open files");
  expect(speech).not.toHaveTextContent("Builderlab");
  expect(speech.querySelector("svg")).not.toBeInTheDocument();
  expect(speech).toHaveStyle({ opacity: "1", transform: "none" });
  expect(
    within(container).getByRole("img", { name: "Nova’s avatar" }),
  ).toHaveStyle({
    opacity: "1",
    transform: "none",
  });
});
