// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import styles from "./Messages.module.css";
import { HIGHLIGHT_MAX_WAIT_MS, HIGHLIGHT_QUIET_MS } from "./message-highlight";
import { useMessageReveal } from "./use-message-reveal";

// Control frame/mutation ordering; browser journeys own real layout and inert focus.
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    left: 0,
    bottom: 100,
    right: 100,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON() {},
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
// Each frame is a whole settle window, so a still row is marked on the
// frame after the one that first measures it.
let clock = 0;
async function frame() {
  clock += HIGHLIGHT_QUIET_MS;
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      if (!frames.delete(id)) continue;
      callback(clock);
    }
  });
}
/** Run frames until nothing is pending, such as an arrival cue's settle wait. */
async function idle() {
  for (let i = 0; frames.size && i < 20; i++) await frame();
}
function mount(
  hold?: () => boolean,
  { focus, mark }: { focus?: boolean; mark?: boolean } = {},
) {
  const request = new AbortController();
  const complete = vi.fn();
  function Surface({
    signal = request.signal,
    prepare = undefined,
    rowKey = 0,
    messageId = "target",
  }: {
    signal?: AbortSignal;
    prepare?: () => void;
    rowKey?: number;
    messageId?: string;
  }) {
    const scroller = useRef<HTMLDivElement>(null);
    const settled = useRef(false);
    useMessageReveal({
      scroller,
      settled,
      messageId,
      signal,
      ready: true,
      complete,
      ...(focus === undefined ? {} : { focus }),
      ...(mark === undefined ? {} : { mark }),
      ...(prepare ? { prepare } : {}),
      ...(hold ? { hold } : {}),
    });
    return (
      <>
        <div ref={scroller}>
          <div key={rowKey} data-message-id="target">
            Target
            <div data-highlight-surface="" />
          </div>
          <div data-message-id="other">
            Other
            <div data-highlight-surface="" />
          </div>
        </div>
        <button type="button">Elsewhere</button>
      </>
    );
  }
  const result = render(<Surface />);
  const row = screen.getByText("Target");
  const outside = screen.getByRole("button", { name: "Elsewhere" });
  return {
    ...result,
    request,
    complete,
    row,
    outside,
    restart: () => result.rerender(<Surface prepare={() => {}} />),
    remountRow: () => result.rerender(<Surface rowKey={1} />),
    next: () =>
      result.rerender(<Surface signal={new AbortController().signal} />),
    other: () =>
      result.rerender(
        <Surface signal={new AbortController().signal} messageId="other" />,
      ),
  };
}
async function mutate(row: HTMLElement) {
  await act(async () => {
    row.style.paddingBottom = "1px";
  });
}

it("notifies reading after the revealed row is verified", async () => {
  const { row, complete } = mount();
  const positioned = vi.fn();
  row.parentElement?.addEventListener("reading-positioned", positioned);
  await frame(); // Attach observers.
  await frame(); // Reveal, but do not verify yet.
  expect(positioned).not.toHaveBeenCalled();
  await frame();
  expect(positioned).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledOnce();
});

function highlighted(row: HTMLElement) {
  return !!row
    .querySelector(":scope > [data-highlight-surface]")
    ?.classList.contains(styles.messageHighlight ?? "");
}

it("marks the arrival once the revealed row is verified", async () => {
  const { row, request, unmount } = mount();
  await frame(); // Attach observers.
  await frame(); // Reveal, but do not verify yet.
  expect(highlighted(row)).toBe(false);
  await frame(); // Verify; the cue waits for the row to hold still.
  await frame(); // First measure.
  expect(highlighted(row)).toBe(false);
  await frame(); // Unmoved for a whole quiet window.
  expect(highlighted(row)).toBe(true);
  request.abort();
  expect(highlighted(row)).toBe(true);
  unmount();
  expect(highlighted(row)).toBe(false);
});

it("moves the arrival mark to the next revealed message", async () => {
  const { row, other } = mount();
  await idle();
  expect(highlighted(row)).toBe(true);
  other();
  await idle();
  expect(highlighted(row)).toBe(false);
  expect(highlighted(screen.getByText("Other"))).toBe(true);
});

it("does not mark a row that fails verification", async () => {
  const { row, complete } = mount();
  await frame();
  await frame();
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
    ...row.getBoundingClientRect(),
    height: 0,
  });
  await frame();
  expect(complete).not.toHaveBeenCalled();
  expect(highlighted(row)).toBe(false);
});

it("does not mark a reveal behind a covering panel", async () => {
  const { row, complete } = mount(undefined, { focus: false });
  await frame();
  await frame();
  await frame();
  expect(complete).toHaveBeenCalledOnce();
  expect(highlighted(row)).toBe(false);
});

it("marks a reveal beside the reader that owns focus, without taking it", async () => {
  const { row, outside, complete } = mount(undefined, {
    focus: false,
    mark: true,
  });
  outside.focus();
  await idle();
  expect(complete).toHaveBeenCalledOnce();
  expect(highlighted(row)).toBe(true);
  expect(document.activeElement).toBe(outside);
});

it("marks a reveal beside the reader only once its row is uncovered", async () => {
  const { row, outside, complete } = mount(undefined, {
    focus: false,
    mark: true,
  });
  outside.focus();
  await frame(); // Attach observers.
  await frame(); // Reveal, but do not verify yet.
  row.setAttribute("inert", "");
  await idle();
  expect(complete).not.toHaveBeenCalled();
  expect(highlighted(row)).toBe(false);
  row.removeAttribute("inert");
  await mutate(row);
  await idle();
  expect(complete).toHaveBeenCalledOnce();
  expect(highlighted(row)).toBe(true);
  expect(document.activeElement).toBe(outside);
});

it.each([false, true])(
  "preserves moved focus before verification (mutation: %s)",
  async (mutation) => {
    const { row, outside, complete } = mount();
    await frame(); // Attach observers.
    await frame(); // Reveal, but do not verify yet.
    expect(document.activeElement).toBe(row);
    outside.focus();
    if (mutation) await mutate(row); // Cancel verification and schedule another reveal.
    await frame();
    await frame();
    expect(document.activeElement).toBe(outside);
    expect(complete).toHaveBeenCalledOnce();
    await idle();
    await mutate(row);
    expect(frames.size).toBe(0);
  },
);

it("preserves focus ownership through an effect restart, but a new request can focus", async () => {
  const { row, outside, complete, restart, next } = mount();
  await frame();
  await frame();
  expect(document.activeElement).toBe(row);
  outside.focus();
  restart();
  await frame();
  await frame();
  await frame();
  expect(document.activeElement).toBe(outside);
  expect(complete).toHaveBeenCalledOnce();
  next();
  await frame();
  await frame();
  await frame();
  expect(document.activeElement).toBe(row);
  expect(complete).toHaveBeenCalledTimes(2);
});

it("retries a focus attempt that did not acquire ownership", async () => {
  const { row, complete } = mount();
  const blocked = vi.spyOn(row, "focus").mockImplementation(() => {});
  await frame();
  await frame();
  await frame();
  expect(complete).not.toHaveBeenCalled();
  blocked.mockRestore();
  await mutate(row);
  await frame();
  await frame();
  expect(document.activeElement).toBe(row);
  expect(complete).toHaveBeenCalledOnce();
});

it.each(["inert", "hidden"])(
  "still requires visibility and admission after acquiring focus: %s",
  async (mode) => {
    const { row, outside, complete } = mount();
    await frame();
    await frame();
    outside.focus();
    const bounds = row.getBoundingClientRect();
    if (mode === "inert") row.setAttribute("inert", "");
    else
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        ...bounds,
        height: 0,
      });
    await frame();
    expect(complete).not.toHaveBeenCalled();
    row.removeAttribute("inert");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(bounds);
    await mutate(row);
    await frame();
    await frame();
    expect(document.activeElement).toBe(outside);
    expect(complete).toHaveBeenCalledOnce();
  },
);

it("cancels pending verification when the request is aborted", async () => {
  const { request, complete } = mount();
  await frame();
  await frame();
  request.abort();
  await frame();
  expect(frames.size).toBe(0);
  expect(complete).not.toHaveBeenCalled();
});

it.each([false, true])(
  "replaces the row without stealing moved focus (moved: %s)",
  async (moved) => {
    const { row, outside, complete, remountRow } = mount();
    await frame();
    await frame();
    expect(document.activeElement).toBe(row);
    if (moved) outside.focus();
    await act(async () => remountRow());
    const replacement = screen.getByText("Target");
    expect(replacement).not.toBe(row);
    expect(document.activeElement).toBe(moved ? outside : document.body);
    const focus = vi.spyOn(replacement, "focus");
    await frame();
    await frame();
    expect(document.activeElement).toBe(moved ? outside : replacement);
    expect(focus).toHaveBeenCalledTimes(moved ? 0 : 1);
    expect(complete).toHaveBeenCalledOnce();
    await idle();
    await mutate(replacement);
    expect(frames.size).toBe(0);
  },
);

it("completes after focus leaves another control between replacement reveal and verification", async () => {
  const { outside, complete, remountRow } = mount();
  await frame();
  await frame();
  outside.focus();
  await act(async () => remountRow());
  const replacement = screen.getByText("Target");
  const focus = vi.spyOn(replacement, "focus");
  await frame();
  expect(document.activeElement).toBe(outside);
  outside.blur();
  await frame();
  expect(document.activeElement).toBe(document.body);
  expect(focus).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledOnce();
  await idle();
  expect(frames.size).toBe(0);
});

it("retries failed focus recovery on a replacement before completing", async () => {
  const { complete, remountRow } = mount();
  await frame();
  await frame();
  await act(async () => remountRow());
  const replacement = screen.getByText("Target");
  const blocked = vi.spyOn(replacement, "focus").mockImplementation(() => {});
  await frame();
  await frame();
  expect(document.activeElement).toBe(document.body);
  expect(complete).not.toHaveBeenCalled();
  blocked.mockRestore();
  await mutate(replacement);
  await frame();
  await frame();
  expect(document.activeElement).toBe(replacement);
  expect(complete).toHaveBeenCalledOnce();
});

it.each([
  ["before verification", 59, false],
  ["before verification", 159, false],
  ["before verification", 59, true],
  ["after verification", 59, false],
])(
  "holds the revealed row through late layout %s by %spx until released (resized: %s)",
  async (phase, drift, resized) => {
    let holding = true;
    const { row, complete } = mount(() => holding);
    const container = row.parentElement as HTMLElement;
    let scrollTop = 0;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    let rowTop = 0;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function (this: HTMLElement) {
        const top = this === row ? rowTop - scrollTop : 0;
        return {
          top,
          left: 0,
          bottom: top + 100,
          right: 100,
          width: 100,
          height: 100,
          x: 0,
          y: top,
          toJSON() {},
        };
      },
    );
    await frame(); // Attach observers.
    await frame(); // Reveal.
    // Geometry can change before verification without another DOM mutation.
    if (phase === "before verification") rowTop = drift;
    if (resized)
      Object.defineProperty(container, "clientWidth", { value: 200 });
    await frame(); // Verify and start holding.
    expect(complete).toHaveBeenCalledOnce();
    if (phase === "after verification") {
      rowTop = drift;
      await mutate(row);
      await frame();
    }
    expect(scrollTop).toBe(resized ? 0 : drift);
    expect(row.getBoundingClientRect().top).toBe(resized ? drift : 0);
    // Newer reader intent ends the hold; later drift belongs to the reader.
    holding = false;
    rowTop = drift + 100;
    await mutate(row);
    await frame();
    expect(scrollTop).toBe(resized ? 0 : drift);
    await idle();
    await mutate(row);
    expect(frames.size).toBe(0);
  },
);

it("waits to mark the arrival until the row holds still, but not forever", async () => {
  const { row } = mount();
  let top = 0;
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
    function (this: HTMLElement) {
      const at = this.dataset.highlightSurface === "" ? top : 0;
      return {
        top: at,
        left: 0,
        bottom: at + 100,
        right: 100,
        width: 100,
        height: 100,
        x: 0,
        y: at,
        toJSON() {},
      };
    },
  );
  await frame(); // Attach observers.
  await frame(); // Reveal.
  await frame(); // Verify and start waiting.
  await frame(); // First measure.
  // Still loading: the row moves every frame, so the cue holds off.
  for (
    let waited = 0;
    waited < HIGHLIGHT_MAX_WAIT_MS;
    waited += HIGHLIGHT_QUIET_MS
  ) {
    expect(highlighted(row)).toBe(false);
    top += 1;
    await frame();
  }
  // It never settled, so it is marked once the wait runs out.
  expect(highlighted(row)).toBe(true);
});

it("marks the arrival as soon as the row holds still", async () => {
  const { row } = mount();
  let top = 0;
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
    function (this: HTMLElement) {
      const at = this.dataset.highlightSurface === "" ? top : 0;
      return {
        top: at,
        left: 0,
        bottom: at + 100,
        right: 100,
        width: 100,
        height: 100,
        x: 0,
        y: at,
        toJSON() {},
      };
    },
  );
  await frame();
  await frame();
  await frame();
  top = 40; // A row above finishes loading.
  await frame();
  expect(highlighted(row)).toBe(false);
  await frame(); // Held still for a whole quiet window.
  expect(highlighted(row)).toBe(true);
});
