// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let launch: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 0;
  });
  document.body.innerHTML =
    '<div id="buzz-launch"><img src="/buzz-loading-mark.svg"></div><div id="root" inert aria-hidden="true"></div><div id="buzz-toast-root" inert aria-hidden="true"></div>';
  const element = document.getElementById("buzz-launch");
  if (!element) throw new Error("Missing launch fixture");
  launch = element;
  launch.dataset.startedAt = "0";
  const mark = launch.querySelector("img");
  if (!mark) throw new Error("Missing mark fixture");
  Object.defineProperties(mark, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 72 },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.replaceChildren();
});

it("finishes the first cycle before fading when content is ready early", async () => {
  const { setLaunchReady } = await import("./launch");
  vi.advanceTimersByTime(100);
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(1659);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  expect(launch).toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(240);
  expect(launch.isConnected).toBe(false);
  expect(document.getElementById("root")).not.toHaveAttribute("inert");
  expect(document.getElementById("root")).not.toHaveAttribute("aria-hidden");
  expect(document.getElementById("buzz-toast-root")).not.toHaveAttribute(
    "inert",
  );
  expect(document.getElementById("buzz-toast-root")).not.toHaveAttribute(
    "aria-hidden",
  );
});

it("keeps looping while content is pending, then finishes the current cycle", async () => {
  const { setLaunchReady } = await import("./launch");
  vi.advanceTimersByTime(2300);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(1219);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("cancels a planned fade if content becomes pending again", async () => {
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(1000);
  setLaunchReady(false);
  vi.advanceTimersByTime(1000);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(1519);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("does not hold the static mark for a cycle with reduced motion", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  await Promise.resolve();
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("keeps looping until the initial visible data settles", async () => {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing root fixture");
  const pending = document.createElement("div");
  pending.dataset.buzzLaunchPending = "required";
  root.append(pending);
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(4000);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  pending.remove();
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(1279);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("reveals usable cached content after two cycles if refresh stalls", async () => {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing root fixture");
  const pending = document.createElement("div");
  pending.dataset.buzzLaunchPending = "settling";
  root.append(pending);
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(3519);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  await Promise.resolve();
  vi.advanceTimersByTime(0);
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("rearms the settling budget when the mark starts after observation", async () => {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing root fixture");
  const pending = document.createElement("div");
  pending.dataset.buzzLaunchPending = "settling";
  root.append(pending);
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  await Promise.resolve();
  vi.advanceTimersByTime(500);
  launch.dataset.startedAt = "500";
  vi.advanceTimersByTime(3020);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(500);
  await Promise.resolve();
  vi.advanceTimersByTime(0);
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("rearms after a mark load later than the original settling budget", async () => {
  const root = document.getElementById("root");
  const mark = launch.querySelector("img");
  if (!root || !mark) throw new Error("Missing launch fixture");
  Object.defineProperty(mark, "complete", { configurable: true, value: false });
  const pending = document.createElement("div");
  pending.dataset.buzzLaunchPending = "settling";
  root.append(pending);
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  vi.advanceTimersByTime(4000);
  await Promise.resolve();
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  launch.dataset.startedAt = "4000";
  Object.defineProperty(mark, "complete", { configurable: true, value: true });
  mark.dispatchEvent(new Event("load"));
  vi.advanceTimersByTime(3519);
  expect(launch).not.toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(1);
  await Promise.resolve();
  vi.advanceTimersByTime(0);
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("reveals a terminal failure even while content is pending", async () => {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing root fixture");
  const pending = document.createElement("div");
  pending.dataset.buzzLaunchPending = "required";
  root.append(pending);
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true, true);
  await Promise.resolve();
  vi.advanceTimersByTime(1760);
  expect(launch).toHaveClass("buzz-launch--leaving");
  expect(root).toHaveAttribute("inert");
  vi.advanceTimersByTime(240);
  expect(root).not.toHaveAttribute("inert");
});

it("notifies window chrome only when launch releases the inert root", async () => {
  const { launchVisible, subscribeLaunch, setLaunchReady } = await import(
    "./launch"
  );
  const observations: boolean[] = [];
  const unsubscribe = subscribeLaunch(() => {
    observations.push(launchVisible());
    expect(document.getElementById("root")).not.toHaveAttribute("inert");
  });
  const removedListener = vi.fn();
  subscribeLaunch(removedListener)();
  expect(launchVisible()).toBe(true);
  setLaunchReady(false);
  vi.advanceTimersByTime(4000);
  expect(observations).toEqual([]);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  setLaunchReady(true);
  await Promise.resolve();
  expect(launch).toHaveClass("buzz-launch--leaving");
  expect(launchVisible()).toBe(true);
  expect(observations).toEqual([]);
  vi.advanceTimersByTime(240);
  expect(observations).toEqual([false]);
  expect(removedListener).not.toHaveBeenCalled();
  unsubscribe();
});

it("fades when the cycle-boundary timer wakes late", async () => {
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  await Promise.resolve();
  // Throttling delivers the boundary timer a second after its deadline.
  const now = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => now() + 1000);
  vi.advanceTimersByTime(1760);
  expect(launch).toHaveClass("buzz-launch--leaving");
});

it("fades even if animation frames never arrive", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const { setLaunchReady } = await import("./launch");
  setLaunchReady(true);
  // The frame fallback lands on the first boundary, which fades next turn.
  vi.advanceTimersByTime(1761);
  expect(launch).toHaveClass("buzz-launch--leaving");
  vi.advanceTimersByTime(240);
  expect(launch.isConnected).toBe(false);
});

/** Runs public/launch-init.js as index.html does, after the launch markup. */
async function launchInit() {
  const { default: source } = await import("../../public/launch-init.js?raw");
  new Function(source)();
  const startup = window.__buzzStartup;
  if (!startup) throw new Error("launch-init.js installed no startup hook");
  return startup;
}
const failurePage = () => document.getElementById("buzz-startup-failure");

it("shows Buzz couldn’t open in place of the launch, with the error behind Details", async () => {
  const startup = await launchInit();
  const { showStartupFailure } = await import("./launch");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  showStartupFailure(new Error("storage unavailable"), "\n    at App");
  expect(logged).toHaveBeenCalled();
  expect(launch.isConnected).toBe(false);
  expect(document.getElementById("root")).not.toBeVisible();
  const page = failurePage();
  expect(page).toHaveAccessibleName("Buzz couldn’t open");
  expect(page?.querySelector('[role="alert"]')).toHaveTextContent(
    "Buzz couldn’t openSomething went wrong while starting. Your messages and settings are safe.",
  );
  const buttons = [...(page?.querySelectorAll("button") ?? [])];
  // Only the desktop app can restart itself.
  expect(buttons.map((button) => button.textContent)).toEqual(["Reload"]);
  expect(buttons[0]).toHaveFocus();
  const details = page?.querySelector("details");
  expect(details).not.toHaveAttribute("open");
  expect(details?.querySelector("summary")).toHaveTextContent("Details");
  expect(details).toHaveTextContent("Error: storage unavailable");
  expect(details).toHaveTextContent("at App");
  // A later failure adds to Details rather than opening a second page.
  startup.failed(new Error("render failed"));
  expect(document.querySelectorAll("#buzz-startup-failure")).toHaveLength(1);
  expect(details).toHaveTextContent("Error: render failed");
});

it("says Buzz stopped working when React unmounts the app after its launch ended", async () => {
  const startup = await launchInit();
  startup.started();
  // The launch faded out, so the user was using Buzz.
  launch.remove();
  startup.failed(new Error("render failed"), "\n    at Sidebar");
  const page = failurePage();
  expect(page).toHaveAccessibleName("Buzz stopped working");
  expect(page?.querySelector('[role="alert"]')).toHaveTextContent(
    "Buzz stopped workingSomething went wrong. Your messages and settings are safe.",
  );
  expect(document.getElementById("root")).not.toBeVisible();
  const buttons = [...(page?.querySelectorAll("button") ?? [])];
  expect(buttons.map((button) => button.textContent)).toEqual(["Reload"]);
  expect(buttons[0]).toHaveFocus();
  expect(page?.querySelector("details")).toHaveTextContent("at Sidebar");
});

it("still says Buzz couldn’t open when React unmounts the app before its launch ended", async () => {
  const startup = await launchInit();
  startup.started();
  startup.failed(new Error("render failed"));
  expect(launch.isConnected).toBe(false);
  expect(failurePage()).toHaveAccessibleName("Buzz couldn’t open");
});

it("offers Restart Buzz on the desktop, through its native restart", async () => {
  const invoke = vi.fn(async () => {});
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const startup = await launchInit();
  startup.failed(new Error("storage unavailable"));
  const restart = [...(failurePage()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Restart Buzz",
  );
  restart?.click();
  expect(invoke).toHaveBeenCalledWith("update_restart");
});

it("fails startup for an uncaught error until React has the app, and not after", async () => {
  const startup = await launchInit();
  startup.started();
  window.dispatchEvent(
    new ErrorEvent("error", { error: new Error("a handler threw") }),
  );
  expect(failurePage()).toBeNull();
  // A fresh startup, which React doesn't have yet.
  await launchInit();
  window.dispatchEvent(
    new ErrorEvent("error", { error: new Error("module threw") }),
  );
  expect(failurePage()).toHaveTextContent("Error: module threw");
});

it("says a slow launch is taking longer after 20 seconds, and offers Reload", async () => {
  await launchInit();
  vi.advanceTimersByTime(19_999);
  expect(launch).not.toHaveTextContent("taking longer");
  vi.advanceTimersByTime(1);
  expect(launch).toHaveTextContent("This is taking longer than usual.");
  expect(launch.querySelector("button")).toHaveTextContent("Reload");
  expect(failurePage()).toBeNull();
});
