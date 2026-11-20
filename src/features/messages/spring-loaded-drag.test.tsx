// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SPRING_LOAD_ATTRIBUTE,
  SPRING_LOAD_BLINK_MS,
  SPRING_LOAD_GRACE_MS,
  SPRING_LOAD_DELAY_MS,
  SPRING_LOAD_STALE_MS,
  useSpringLoaded,
} from "./spring-loaded-drag";
import { useRejectUnclaimedDrops } from "./use-file-drop";

// Where the drag is. Events report it, and only `move` and `nudge` change it.
// Each test is a new drag that comes in somewhere else.
let pointer = { x: 0, y: 0 };
beforeEach(() => {
  vi.useFakeTimers();
  pointer = { x: 10, y: pointer.y + 100 };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Target({
  name,
  open,
  active,
}: {
  name: string;
  open(name: string): void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={name}
      {...useSpringLoaded(() => open(name), active)}
    >
      <span>{name} icon</span>
      <span>{name} label</span>
    </button>
  );
}
function Targets({
  open,
  active,
  names = ["General", "Random"],
}: {
  open(name: string): void;
  active?: string;
  names?: string[];
}) {
  useRejectUnclaimedDrops();
  return (
    <StrictMode>
      {names.map((name) => (
        <Target key={name} name={name} open={open} active={active === name} />
      ))}
      <p>Elsewhere</p>
    </StrictMode>
  );
}

function drag(
  target: Element | Window,
  kind: "dragEnter" | "dragOver" | "dragLeave" | "drop" | "dragEnd",
  type = "Files",
) {
  const event = createEvent[kind](target, {
    dataTransfer: { types: [type], files: [], dropEffect: "uninitialized" },
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(event, {
    clientX: { value: pointer.x },
    clientY: { value: pointer.y },
  });
  fireEvent(target, event);
  return event as Event & { dataTransfer: { dropEffect: string } };
}
const nudge = () => {
  pointer = { x: pointer.x + 1, y: pointer.y };
};
/** Browsers report the node entered before the node left. */
function move(from: Element, to: Element) {
  nudge();
  drag(to, "dragEnter");
  drag(from, "dragLeave");
  drag(to, "dragOver");
}
const row = (name: string) => screen.getByRole("button", { name });
const state = (name: string) => row(name).getAttribute(SPRING_LOAD_ATTRIBUTE);
const rest = (ms: number) => vi.advanceTimersByTime(ms);
/** A webview repeats dragover while the drag rests, here every 50 ms. */
function hold(target: Element, ms: number) {
  for (let left = ms; left > 0; left -= 50) {
    rest(Math.min(left, 50));
    drag(target, "dragOver");
  }
}
const beforeBlink = SPRING_LOAD_DELAY_MS - SPRING_LOAD_BLINK_MS;

it("highlights after the grace period, blinks twice, then opens once on the next dragover", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  rest(SPRING_LOAD_GRACE_MS - 1);
  expect(state("General")).toBeNull();
  rest(1);
  expect(state("General")).toBe("on");
  rest(beforeBlink - SPRING_LOAD_GRACE_MS - 1);
  expect(state("General")).toBe("on");
  rest(1);
  drag(row("General"), "dragOver");
  const phase = SPRING_LOAD_BLINK_MS / 4;
  for (const expected of ["off", "on", "off", "on"]) {
    expect(state("General")).toBe(expected);
    rest(phase - 1);
    expect(state("General")).toBe(expected);
    drag(row("General"), "dragOver");
    expect(open).not.toHaveBeenCalled();
    rest(1);
  }
  // The delay is over. The timer opens nothing; the next dragover does.
  rest(1);
  expect(open).not.toHaveBeenCalled();
  expect(state("General")).toBe("on");
  drag(row("General"), "dragOver");
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
  expect(state("General")).toBeNull();
  // The drag keeps resting there without opening it again.
  hold(row("General"), SPRING_LOAD_DELAY_MS * 2);
  expect(open).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("reduced motion keeps the highlight and skips the blink", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
  }));
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  expect(state("General")).toBeNull();
  hold(row("General"), SPRING_LOAD_DELAY_MS - 1);
  expect(state("General")).toBe("on");
  expect(open).not.toHaveBeenCalled();
  rest(1);
  drag(row("General"), "dragOver");
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
});

it("moving within one target neither restarts nor cancels the delay", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  const icon = screen.getByText("General icon");
  const label = screen.getByText("General label");
  drag(row("General"), "dragEnter");
  hold(row("General"), 200);
  move(row("General"), icon);
  hold(icon, 200);
  move(icon, label);
  expect(open).not.toHaveBeenCalled();
  hold(label, SPRING_LOAD_DELAY_MS - 400);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
});

it("leaving the target cancels the delay and the highlight", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  const label = screen.getByText("General label");
  drag(row("General"), "dragEnter");
  move(row("General"), label);
  hold(label, beforeBlink);
  expect(state("General")).toBe("off");
  move(label, screen.getByText("Elsewhere"));
  expect(state("General")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("leaving the window or cancelling the drag reports only a leave", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  drag(row("General"), "dragLeave");
  expect(state("General")).toBeNull();
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("a drag that only passes over a target does not highlight it", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  const seen: (string | null)[] = [];
  drag(row("General"), "dragEnter");
  for (const [from, to] of [
    ["General", "Random"],
    ["Random", "General"],
  ] as const) {
    rest(SPRING_LOAD_GRACE_MS - 1);
    seen.push(state(from));
    move(row(from), row(to));
    seen.push(state(from), state(to));
  }
  move(row("General"), screen.getByText("Elsewhere"));
  rest(SPRING_LOAD_DELAY_MS);
  expect(seen).toEqual([null, null, null, null, null, null]);
  expect(open).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("moving to another target restarts the delay there", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  hold(row("General"), SPRING_LOAD_DELAY_MS - 1);
  move(row("General"), row("Random"));
  expect(state("General")).toBeNull();
  expect(state("Random")).toBeNull();
  hold(row("Random"), SPRING_LOAD_DELAY_MS - 1);
  expect(open).not.toHaveBeenCalled();
  rest(1);
  drag(row("Random"), "dragOver");
  expect(open).toHaveBeenCalledExactlyOnceWith("Random");
});

it.each(["drop", "dragEnd"] as const)(
  "%s ends the delay without opening or navigating",
  (kind) => {
    const open = vi.fn();
    render(<Targets open={open} />);
    drag(row("General"), "dragEnter");
    drag(row("General"), "dragOver");
    const end = drag(kind === "drop" ? row("General") : window, kind);
    if (kind === "drop") expect(end.defaultPrevented).toBe(true);
    expect(state("General")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    rest(SPRING_LOAD_DELAY_MS);
    expect(open).not.toHaveBeenCalled();
  },
);

it("a drop claimed and stopped by a drop zone still ends the delay", () => {
  const open = vi.fn();
  const view = render(<Targets open={open} />);
  view.container.addEventListener("drop", (event) => event.stopPropagation());
  drag(row("General"), "dragEnter");
  drag(row("General"), "drop");
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("ignores drags that carry no files", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  for (const type of ["text/plain", "text/uri-list"]) {
    drag(row("General"), "dragEnter", type);
    drag(row("General"), "dragOver", type);
    expect(state("General")).toBeNull();
  }
  expect(vi.getTimerCount()).toBe(0);
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("does nothing on the target that is already open", () => {
  const open = vi.fn();
  render(<Targets open={open} active="General" />);
  drag(row("General"), "dragEnter");
  const over = drag(row("General"), "dragOver");
  expect(over.dataTransfer.dropEffect).toBe("none");
  expect(state("General")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("the same drag opens one target after another", () => {
  const open = vi.fn();
  const view = render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  view.rerender(<Targets open={open} active="General" />);
  move(row("General"), row("Random"));
  hold(row("Random"), SPRING_LOAD_DELAY_MS);
  view.rerender(<Targets open={open} active="Random" />);
  // Leaving and coming back arms the first target again.
  move(row("Random"), row("General"));
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  expect(open.mock.calls).toEqual([["General"], ["Random"], ["General"]]);
});

it("opens with the latest callback", () => {
  const first = vi.fn();
  const latest = vi.fn();
  const view = render(<Targets open={first} />);
  drag(row("General"), "dragEnter");
  view.rerender(<Targets open={latest} />);
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledExactlyOnceWith("General");
});

it("unmounting the hovered target leaves no timer or listener behind", () => {
  const open = vi.fn();
  const remove = vi.spyOn(window, "removeEventListener");
  const view = render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  expect(vi.getTimerCount()).toBe(1);
  view.rerender(<Targets open={open} names={["Random"]} />);
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith("drop", expect.any(Function), true);
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
  // Another target's unmount leaves the hovered one armed.
  drag(row("Random"), "dragEnter");
  view.rerender(<Targets open={open} names={["Random"]} />);
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  remove.mockRestore();
});

it("a drag that ended without a leave opens nothing and loses its highlight", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  hold(row("General"), 100);
  // Escape, with no leave reported: the dragovers simply stop.
  rest(SPRING_LOAD_DELAY_MS - 100);
  expect(open).not.toHaveBeenCalled();
  expect(state("General")).toBe("on");
  rest(SPRING_LOAD_STALE_MS - 1);
  expect(state("General")).toBe("on");
  rest(1);
  expect(state("General")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  expect(open).not.toHaveBeenCalled();
  // A later drag starts over.
  drag(row("General"), "dragEnter");
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
});

it("a webview that repeats dragover slowly opens on its next one", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  rest(SPRING_LOAD_DELAY_MS + SPRING_LOAD_STALE_MS - 1);
  expect(open).not.toHaveBeenCalled();
  drag(row("General"), "dragOver");
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
  expect(state("General")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("a drag cancelled just before the delay ends opens nothing", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  // Escape right after a dragover, with no leave reported.
  hold(row("General"), SPRING_LOAD_DELAY_MS - 50);
  rest(50 + SPRING_LOAD_STALE_MS);
  expect(open).not.toHaveBeenCalled();
  expect(state("General")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["dragEnter", "dragOver"] as const)(
  "a %s elsewhere with no leave cancels, before or after the delay ends",
  (kind) => {
    const open = vi.fn();
    render(<Targets open={open} />);
    const elsewhere = screen.getByText("Elsewhere");
    for (const held of [SPRING_LOAD_DELAY_MS - 50, SPRING_LOAD_DELAY_MS + 50]) {
      drag(row("General"), "dragEnter");
      hold(row("General"), SPRING_LOAD_DELAY_MS - 50);
      rest(held - (SPRING_LOAD_DELAY_MS - 50));
      nudge();
      drag(elsewhere, kind);
      expect(state("General")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      rest(SPRING_LOAD_DELAY_MS + SPRING_LOAD_STALE_MS);
    }
    // A drag that carries no files says nothing about the file drag.
    drag(row("General"), "dragEnter");
    drag(elsewhere, "dragOver", "text/plain");
    expect(vi.getTimerCount()).toBe(1);
    drag(row("General"), "dragLeave");
    expect(open).not.toHaveBeenCalled();
  },
);

it("never claims the drag, counting down, due or opened", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  // Unclaimed, the window's handler rejects it: the row attaches nothing.
  const unclaimed = (kind: "dragEnter" | "dragOver") => {
    const event = drag(row("General"), kind);
    expect(event.dataTransfer.dropEffect).toBe(
      kind === "dragOver" ? "none" : "uninitialized",
    );
  };
  unclaimed("dragEnter");
  unclaimed("dragOver");
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
  unclaimed("dragOver");
  expect(open).toHaveBeenCalledOnce();
  unclaimed("dragOver");
  const drop = drag(row("General"), "drop");
  expect(drop.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledOnce();
});

it("a target that slides under a resting drag waits for the drag to move", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
  // Opening shifted the layout: another target is now under the same point.
  drag(row("Random"), "dragEnter");
  drag(row("General"), "dragLeave");
  hold(row("Random"), SPRING_LOAD_DELAY_MS * 2);
  expect(state("Random")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  expect(open).toHaveBeenCalledTimes(1);
  nudge();
  drag(row("Random"), "dragOver");
  rest(SPRING_LOAD_GRACE_MS);
  expect(state("Random")).toBe("on");
  hold(row("Random"), SPRING_LOAD_DELAY_MS - SPRING_LOAD_GRACE_MS);
  expect(open).toHaveBeenLastCalledWith("Random");
  expect(open).toHaveBeenCalledTimes(2);
});

it.each(["drop", "dragEnd"] as const)(
  "after a %s, the next drag arms at the point where the last one opened",
  (kind) => {
    const open = vi.fn();
    const remove = vi.spyOn(window, "removeEventListener");
    render(<Targets open={open} />);
    drag(row("General"), "dragEnter");
    hold(row("General"), SPRING_LOAD_DELAY_MS);
    expect(open).toHaveBeenCalledExactlyOnceWith("General");
    // The drag leaves the row and ends elsewhere, reporting no other point.
    drag(row("General"), "dragLeave");
    remove.mockClear();
    drag(kind === "drop" ? screen.getByText("Elsewhere") : window, kind);
    expect(remove).toHaveBeenCalledWith(
      kind.toLowerCase(),
      expect.any(Function),
      true,
    );
    remove.mockRestore();
    drag(row("Random"), "dragEnter");
    hold(row("Random"), SPRING_LOAD_DELAY_MS);
    expect(open).toHaveBeenLastCalledWith("Random");
    expect(open).toHaveBeenCalledTimes(2);
  },
);

// The reviewer's sequence: the drag ends with no leave, drop or dragend, and
// a later drag comes over the same row.
it("a new drag arms a row whose active-row hover was left behind", () => {
  const open = vi.fn();
  const { rerender } = render(<Targets open={open} active="General" />);
  drag(row("General"), "dragEnter");
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
  // The drag is cancelled unreported, and a click opens another row.
  rerender(<Targets open={open} active="Random" />);
  rest(5000);
  nudge();
  drag(row("General"), "dragEnter");
  rest(SPRING_LOAD_GRACE_MS);
  expect(state("General")).toBe("on");
  hold(row("General"), SPRING_LOAD_DELAY_MS - SPRING_LOAD_GRACE_MS);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
});

it("a new drag arms a row whose already-opened hover was left behind", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
  rest(5000);
  // Where the row opened, the guard still holds: the drag may only be resting.
  drag(row("General"), "dragEnter");
  hold(row("General"), SPRING_LOAD_DELAY_MS * 2);
  expect(state("General")).toBeNull();
  expect(open).toHaveBeenCalledTimes(1);
  rest(5000);
  nudge();
  drag(row("General"), "dragOver");
  rest(SPRING_LOAD_GRACE_MS);
  expect(state("General")).toBe("on");
  hold(row("General"), SPRING_LOAD_DELAY_MS - SPRING_LOAD_GRACE_MS);
  expect(open).toHaveBeenCalledTimes(2);
});

it("a drag resting on an opened row stays shut however slowly dragover repeats", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
  for (let repeat = 0; repeat < 4; repeat++) {
    rest(SPRING_LOAD_STALE_MS * 2);
    drag(row("General"), "dragOver");
    expect(state("General")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  }
  expect(open).toHaveBeenCalledTimes(1);
});

it("a drag that moves along an opened row stays shut", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  hold(row("General"), SPRING_LOAD_DELAY_MS);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
  hold(row("General"), SPRING_LOAD_STALE_MS * 2);
  nudge();
  hold(row("General"), SPRING_LOAD_DELAY_MS * 2);
  expect(state("General")).toBeNull();
  expect(open).toHaveBeenCalledTimes(1);
});
