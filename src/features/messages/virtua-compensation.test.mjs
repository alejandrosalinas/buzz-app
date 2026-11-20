import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Exercise the installed React ESM's actual store, observer and element driver.
// Names are deliberately version-coupled: review this extraction on upgrade.
const source = readFileSync(
  fileURLToPath(import.meta.resolve("virtua")),
  "utf8",
);
const start = source.indexOf("var a, u = [], {min:");
const end = source.indexOf("}, D = (e, t, o) => {");
if (start < 0 || end < 0)
  throw new Error("Review Virtua driver extraction after version change");
const helperStart = source.indexOf("const isMacWebKit =");
const helper = helperStart >= 0 ? source.slice(helperStart, start) : "";
const core = source.slice(start, end + 1);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup({
  platform = "MacIntel",
  vendor = "Apple Computer, Inc.",
  touch = 0,
  agent = "Macintosh",
  horizontal = false,
  direction = "ltr",
  offset = 1300,
} = {}) {
  const {
    store: createStore,
    layout,
    driver: createDriver,
  } = new Function(
    "navigator",
    "getComputedStyle",
    `${helper}${core};return {store:b,layout:k,driver:G};`,
  )({ platform, vendor, maxTouchPoints: touch, userAgent: agent }, () => ({
    direction,
  }));
  const sizes = layout(20, 100);
  const store = createStore(sizes);
  const declarations = new Map();
  const style = {
    getPropertyValue: (name) => declarations.get(name)?.[0] ?? "",
    getPropertyPriority: (name) => declarations.get(name)?.[1] ?? "",
    setProperty: (name, value, priority = "") =>
      declarations.set(name, [value, priority]),
    removeProperty: (name) => declarations.delete(name),
  };
  const viewport = new EventTarget();
  const calls = [];
  let resize;
  const axis = horizontal ? "overflow-x" : "overflow-y";
  const key = horizontal ? "scrollLeft" : "scrollTop";
  const option = horizontal ? "left" : "top";
  Object.assign(viewport, {
    style,
    offsetParent: {},
    scrollTop: 0,
    scrollLeft: 0,
    ownerDocument: {
      defaultView: {
        ResizeObserver: class {
          constructor(callback) {
            resize = callback;
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      },
    },
  });
  viewport[key] = direction === "rtl" ? -offset : offset;
  // With a range set, act like a browser after a shrink: layout clamps the
  // current offset before a relative scroll reads it, and the result is an
  // integer inside the range, as WebKit reports it.
  const clamp = (value) =>
    viewport.max === undefined
      ? value
      : Math.trunc(Math.min(value, viewport.max));
  for (const method of ["scrollTo", "scrollBy"])
    viewport[method] = (options) => {
      calls.push({
        method,
        options,
        overflow: style.getPropertyValue(axis),
        priority: style.getPropertyPriority(axis),
      });
      viewport[key] = clamp(
        (method === "scrollBy" ? clamp(viewport[key]) : 0) + options[option],
      );
    };
  store.h(4, 500); // measured viewport
  store.h(1, offset); // observed native scrolling
  const driver = createDriver(store, sizes, horizontal);
  driver.U({}, viewport);
  return {
    store,
    sizes,
    driver,
    viewport,
    style,
    axis,
    calls,
    resize: (entries) => resize(entries),
    // Render computes the mounted range between the length change and the
    // layout effect that flushes the jump; ChannelTimeline's buffer is 1600.
    prepend(length = 40, buffer = 1600) {
      store.h(5, length, true);
      store.$(buffer);
      driver.te();
    },
  };
}

it("interrupts the actual correction before its relative DOM write, even after inferred idle", () => {
  const c = setup();
  c.store.h(2); // observer idle is NOT native momentum completion
  c.prepend();
  expect(c.calls).toEqual([
    {
      method: "scrollBy",
      options: { top: 2000, behavior: "instant" },
      overflow: "hidden",
      priority: "important",
    },
  ]);
  expect(c.viewport.scrollTop).toBe(3300);
  expect(c.store.t()).toBe(4000); // no deferred extent/store policy
  expect(c.store.i(39)).toBe(3900);
  c.driver.te();
  expect(c.calls).toHaveLength(1);
  vi.runAllTimers();
  expect(c.style.getPropertyValue(c.axis)).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

it("does not defer while scrolling or interrupt without a correction", () => {
  const c = setup();
  c.driver.te();
  expect(c.calls).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  c.prepend();
  expect(c.calls).toHaveLength(1);
  expect(c.store.t()).toBe(4000);
  expect(c.store.M()[0]).toBe(0);
});

it("buffers both sides while a shift freezes the scroll direction", () => {
  const c = setup({ offset: 500 }); // native downward scrolling
  c.prepend();
  c.store.h(1, 2500); // compensated offset
  c.store.h(1, 2400); // upward movement cannot update the frozen direction
  expect(c.store.$(200)).toEqual([22, 31]);
  c.store.h(2); // inferred idle restores native direction tracking
  c.store.h(1, 2300);
  expect(c.store.$(200)).toEqual([21, 28]);
});

it("buffers below a shift frozen upward without letting those rows move the reading position", () => {
  for (const [row, size, top] of [
    [32, 150, null], // wholly below the 2500–3000 viewport
    [32, 60, null],
    [23, 150, 50], // above it, as prepended rows are
    [29, 150, 50], // visible rows are still corrected
    [30, 150, null], // starts exactly at the viewport end
  ]) {
    const c = setup({ offset: 500 });
    c.store.h(1, 400); // native upward scrolling
    c.prepend();
    c.store.h(1, 2400); // compensated offset
    c.store.h(1, 2500); // downward movement cannot update the frozen direction
    expect(c.store.$(200)).toEqual([23, 32]);
    c.calls.length = 0;
    c.store.h(3, [[row, size]]);
    c.driver.te();
    expect(c.calls.map((call) => call.options.top ?? null)).toEqual(
      top === null ? [] : [top],
    );
    c.driver.R();
  }
});

it("preserves absolute edge correction and RTL axis normalization", () => {
  for (const config of [
    { offset: 1500 },
    { horizontal: true, direction: "rtl", offset: 1500 },
  ]) {
    const c = setup(config);
    c.prepend();
    expect(c.calls).toEqual([
      {
        method: "scrollTo",
        options: {
          [config.horizontal ? "left" : "top"]: config.horizontal
            ? -3500
            : 3500,
          behavior: "instant",
        },
        overflow: "hidden",
        priority: "important",
      },
    ]);
    c.driver.R();
  }
});

it.each(["MacIntel", "Linux x86_64"])(
  "rounds fractional end corrections outward on %s, including RTL",
  (platform) => {
    for (const horizontal of [false, true]) {
      const c = setup({
        platform,
        horizontal,
        direction: horizontal ? "rtl" : "ltr",
        offset: 1500,
      });
      c.store.h(3, [[0, 100.75]]);
      c.driver.te();
      expect(c.calls.at(-1)).toMatchObject({
        method: "scrollTo",
        options: {
          [horizontal ? "left" : "top"]: horizontal ? -1501 : 1501,
          behavior: "instant",
        },
      });
      c.driver.R();
    }
  },
);

it("rounds imperative end targets without rounding interior reading positions", async () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  c.store.h(
    3,
    Array.from({ length: 20 }, (_, index) => [index, index ? 100 : 100.75]),
  );
  for (const [target, expected] of [
    [900.25, 900.25],
    [1500.75, 1501],
  ]) {
    await c.driver.ee(null, { offset: target });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls.at(-1).options).toEqual({
      top: expected,
      behavior: "instant",
    });
  }
  c.driver.R();
});

it("restores exact value and priority after overlapping corrections without touching the other axis", () => {
  const c = setup();
  c.style.setProperty("overflow-y", "scroll", "important");
  c.style.setProperty("overflow-x", "clip", "");
  c.prepend();
  c.prepend(60);
  expect(c.calls.map((call) => call.overflow)).toEqual(["hidden", "hidden"]);
  expect(vi.getTimerCount()).toBe(1);
  expect(c.style.getPropertyValue("overflow-x")).toBe("clip");
  vi.runAllTimers();
  expect(c.style.getPropertyValue("overflow-y")).toBe("scroll");
  expect(c.style.getPropertyPriority("overflow-y")).toBe("important");
});

it("restores immediately on dispose and permits a fresh lifecycle", () => {
  const c = setup();
  c.style.setProperty(c.axis, "auto");
  c.prepend();
  c.driver.R();
  expect(c.style.getPropertyValue(c.axis)).toBe("auto");
  expect(c.style.getPropertyPriority(c.axis)).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  c.driver.U({}, c.viewport);
  c.prepend(60);
  expect(c.calls.at(-1).overflow).toBe("hidden");
  c.driver.R();
  expect(c.style.getPropertyValue(c.axis)).toBe("auto");
});

it("does not overwrite a later style owner", () => {
  const c = setup();
  c.prepend();
  c.style.setProperty(c.axis, "clip", "important");
  vi.runAllTimers();
  expect(c.style.getPropertyValue(c.axis)).toBe("clip");
  expect(c.style.getPropertyPriority(c.axis)).toBe("important");
});

it("interrupts positive and negative resize compensation at the same production driver", () => {
  for (const size of [50, 150]) {
    const c = setup();
    c.store.h(3, [[0, size]]);
    c.driver.te();
    expect(c.calls).toEqual([
      {
        method: "scrollBy",
        options: { top: size - 100, behavior: "instant" },
        overflow: "hidden",
        priority: "important",
      },
    ]);
    c.driver.R();
  }
});

it("does not change the imperative scheduler's smooth or instant scrolling policy", async () => {
  for (const smooth of [false, true]) {
    const c = setup();
    c.store.h(
      3,
      Array.from({ length: 20 }, (_, index) => [index, 100]),
    );
    await c.driver.ee(null, { offset: 900, smooth });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls.at(-1).overflow).toBe("");
    expect(c.calls.at(-1).options).toEqual({
      top: 900,
      behavior: smooth ? "smooth" : "instant",
    });
    c.driver.R();
    vi.clearAllTimers();
  }
});

it("takes the absolute path for an integer offset at a fractional end when rows above shrink", () => {
  const c = setup({ platform: "Linux x86_64", offset: 1500 });
  // The last row wraps to a fractional height: the end is 1500.17, and WebKit
  // reports the reader at that bottom as 1500. Nothing above moved yet.
  c.store.h(3, [[19, 100.17]]);
  c.driver.te();
  expect(c.calls).toHaveLength(0);
  // Two rows above the viewport shrink by 80 in total. The browser's integer
  // range ends at 1420; Virtua's fractional end is 1420.17, and the stale
  // 1500 minus 80 falls 0.17 short of it.
  c.viewport.max = 1420;
  c.store.h(3, [
    [1, 60],
    [2, 60],
  ]);
  c.driver.te();
  expect(c.calls).toEqual([
    {
      method: "scrollTo",
      options: { top: 1421, behavior: "instant" },
      overflow: "",
      priority: "",
    },
  ]);
  expect(c.viewport.scrollTop).toBe(1420); // not the clamp plus the shrink again
  c.driver.R();
});

it.each([
  ["larger than the reader's gap to the end", 1490, "scrollTo", 1410],
  ["smaller than that gap", 1300, "scrollBy", -80],
])(
  "a shrink %s keeps the reader's content in place",
  (_, offset, method, top) => {
    const c = setup({ platform: "Linux x86_64", offset });
    c.viewport.max = 1420;
    c.store.h(3, [
      [1, 60],
      [2, 60],
    ]);
    c.driver.te();
    expect(c.calls).toEqual([
      {
        method,
        options: { top, behavior: "instant" },
        overflow: "",
        priority: "",
      },
    ]);
    expect(c.viewport.scrollTop).toBe(offset - 80);
    c.driver.R();
  },
);

// Twenty measured rows; the first carries 88px of day divider and author
// header above its paragraph, the content a reader at the top of history is
// looking at. Returns that paragraph's viewport position for a row and header.
function openHistory(c) {
  c.store.h(
    3,
    Array.from({ length: 20 }, (_, index) => [index, index ? 100 : 188]),
  );
  c.driver.te();
  expect(c.calls).toEqual([]);
  return (index, header) => c.store.i(index) + header - c.viewport.scrollTop;
}

// A shift compensates every resize until scroll-end, a 150ms timer from its
// jump's own scroll event, but the rows it prepended measure in the frame after
// that jump, together with the former first row, which the same render turned
// into a continuation without its day divider and author header. A late frame
// lets the timer fire first, and native policy keeps the viewport start: the
// former first row sits at that start, so its shrink is dropped, and so is the
// growth of a prepended row whose estimated bottom WebKit's integer offset
// reads short of. live.spec.mjs:194 lost 76px this way on Linux WebKit.
it("a prepend whose rows measure after scroll-end still keeps the former first row's content in place", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const paragraph = openHistory(c);
  expect(paragraph(0, 88)).toBe(88);
  c.prepend(40); // 20 older rows at the 100px estimate: the shift jumps 2000
  expect(c.viewport.scrollTop).toBe(2000);
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  // The frame measures the prepended rows at 110 (+200 in total) and the former
  // first row, index 20 now, without its header (188 → 100).
  c.store.h(3, [
    ...Array.from({ length: 20 }, (_, index) => [index, 110]),
    [20, 100],
  ]);
  c.driver.te();
  expect(c.calls).toEqual([
    {
      method: "scrollBy",
      options: { top: 112, behavior: "instant" },
      overflow: "",
      priority: "",
    },
  ]);
  expect(paragraph(20, 0)).toBe(88);
  // That batch ended the shift. A visible row growing afterwards (an image
  // loading) keeps the viewport start as before; a row above it is compensated.
  c.calls.length = 0;
  c.store.h(3, [[21, 150]]);
  c.driver.te();
  expect(c.calls).toEqual([]);
  c.store.h(3, [[3, 120]]);
  c.driver.te();
  expect(c.calls.at(-1).options).toEqual({ top: 10, behavior: "instant" });
  c.driver.R();
});

// Sizes apply as each observer delivery arrives, so a second correction can
// flush before the first jump's scroll event updates the store's offset.
it("a correction before the previous jump's scroll event includes that jump", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  openHistory(c);
  c.prepend(40);
  expect(c.viewport.scrollTop).toBe(2000);
  c.calls.length = 0;
  c.store.h(3, [[2, 90]]); // a prepended row above the viewport measures short
  c.driver.te();
  expect(c.calls.map((call) => call.options)).toEqual([
    { top: -10, behavior: "instant" },
  ]);
  expect(c.viewport.scrollTop).toBe(1990);
  c.driver.R();
});

it("a correction after a clamp and before the previous jump's scroll event lands once", () => {
  const c = setup({ platform: "Linux x86_64", offset: 1500 });
  c.prepend(40); // the shift reaches the end: absolute 3500
  expect(c.viewport.scrollTop).toBe(3500);
  c.calls.length = 0;
  // A prepended row measures 50px short; layout clamps the offset to the new
  // end before the correction runs.
  c.viewport.max = 3450;
  c.viewport.scrollTop = 3450;
  c.store.h(3, [[5, 50]]);
  c.driver.te();
  expect(c.calls.map((call) => call.options)).toEqual([
    { top: 3450, behavior: "instant" },
  ]);
  expect(c.viewport.scrollTop).toBe(3450);
  c.driver.R();
});

it("fractional corrections on an integer scroll offset do not accumulate drift", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  openHistory(c);
  c.prepend(40);
  c.viewport.dispatchEvent(new Event("scroll"));
  c.viewport.max = 10000; // WebKit truncates each scroll write
  for (const index of [2, 3, 4]) {
    c.store.h(3, [[index, 100.75]]); // a row above the reader grows
    c.driver.te();
    c.viewport.dispatchEvent(new Event("scroll"));
  }
  expect(c.viewport.scrollTop).toBe(2002);
  c.driver.R();
});

it("a deferred shift waits through unrelated and partial measurement batches", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  openHistory(c);
  c.prepend(40);
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  // An unrelated visible row does not satisfy the prepended measurement debt.
  c.store.h(3, [[21, 150]]);
  c.driver.te();
  expect(c.calls.at(-1).options).toEqual({ top: 50, behavior: "instant" });
  // Only part of the mounted prepend measures; visible growth still shifts.
  c.store.h(3, [
    ...Array.from({ length: 19 }, (_, index) => [index, 110]),
    [21, 170],
  ]);
  c.driver.te();
  expect(c.calls.at(-1).options).toEqual({ top: 210, behavior: "instant" });
  // The completing batch must itself receive shift policy, then retire it.
  c.store.h(3, [
    [19, 110],
    [21, 190],
  ]);
  c.driver.te();
  expect(c.calls.at(-1).options).toEqual({ top: 30, behavior: "instant" });
  c.calls.length = 0;
  c.store.h(3, [[22, 150]]);
  c.driver.te();
  expect(c.calls).toEqual([]);
  c.driver.R();
});

it("a prepend measured inside the scroll-end window keeps stock shift policy and then returns to native policy", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const paragraph = openHistory(c);
  c.prepend(40);
  c.viewport.dispatchEvent(new Event("scroll"));
  c.calls.length = 0;
  c.store.h(3, [
    ...Array.from({ length: 20 }, (_, index) => [index, 110]),
    [20, 100],
  ]);
  c.driver.te();
  expect(c.calls.at(-1).options).toEqual({ top: 112, behavior: "instant" });
  expect(paragraph(20, 0)).toBe(88);
  // Still shifting until scroll-end: a visible row's growth is compensated.
  c.store.h(3, [[21, 150]]);
  c.driver.te();
  expect(c.calls.at(-1).options).toEqual({ top: 50, behavior: "instant" });
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  c.store.h(3, [[22, 150]]);
  c.driver.te();
  expect(c.calls).toEqual([]);
  c.driver.R();
});

it("a prepend whose rows are not mounted ends its shift at scroll-end as before", () => {
  const c = setup({ platform: "Linux x86_64", offset: 1500 });
  c.store.h(
    3,
    Array.from({ length: 20 }, (_, index) => [index, 100]),
  );
  c.driver.te();
  // Virtua's default 200px buffer starts inside the old rows, so no prepended
  // row is mounted and nothing is awaited.
  c.prepend(40, 200);
  expect(c.viewport.scrollTop).toBe(3500);
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  c.store.h(3, [[35, 150]]);
  c.driver.te();
  expect(c.calls).toEqual([]);
  // Prepended rows measured later, above the viewport, follow native policy.
  c.store.h(3, [[19, 110]]);
  c.driver.te();
  expect(c.calls.at(-1).options).toEqual({ top: 10, behavior: "instant" });
  c.driver.R();
});

for (const [name, config, deferred] of [
  ["macOS Chrome", { vendor: "Google Inc." }, false],
  ["macOS Firefox", { vendor: "" }, false],
  ["Linux WebKit", { platform: "Linux x86_64" }, false],
  ["desktop-mode iPad", { touch: 5 }, true],
  ["iPhone", { platform: "iPhone", agent: "iPhone", touch: 5 }, true],
]) {
  it(`preserves existing ${name} policy`, () => {
    const c = setup(config);
    c.prepend();
    expect(c.calls).toHaveLength(deferred ? 0 : 1);
    if (deferred) {
      c.store.h(2);
      c.driver.te();
    }
    expect(c.calls.at(-1).overflow).toBe("");
    expect(c.store.t()).toBe(4000);
    c.driver.R();
  });
}

// Paging history prepends a page, jumps once, and measures the prepended rows
// in the next frame's observer batch. The pending jump is flushed only by the
// Virtualizer layout effect, which every store update commits: scroll events
// and repeated flushes must not re-apply it, and a batch is one correction.
it("applies one correction per shift jump and per measurement batch, none from scroll events", () => {
  const c = setup({ vendor: "Google Inc.", offset: 400 }); // Chromium
  const corrections = () =>
    c.calls.map(({ method, options, overflow }) => [
      method,
      options.top,
      overflow,
    ]);
  c.store.h(1, 300); // native upward scrolling, as when paging history
  c.prepend(40); // 20 older rows at the 100px estimate: one 2000px jump
  expect(corrections()).toEqual([["scrollBy", 2000, ""]]);
  c.driver.te(); // another commit's layout effect
  c.store.h(1, 2300); // the jump's own scroll event, rendered through flushSync
  c.driver.te();
  expect(c.calls).toHaveLength(1);
  // The prepended rows measure together: one correction for the whole batch.
  c.store.h(
    3,
    Array.from({ length: 20 }, (_, index) => [index, 110]),
  );
  c.driver.te();
  c.driver.te();
  expect(corrections()).toEqual([
    ["scrollBy", 2000, ""],
    ["scrollBy", 200, ""],
  ]);
  // Its scroll event and an unchanged measurement add nothing.
  c.store.h(1, 2500);
  c.driver.te();
  c.store.h(3, [[0, 110]]);
  c.driver.te();
  expect(c.calls).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0); // no Chromium overflow toggle to restore
  c.driver.R();
});

it("keeps the same rows mounted when a page lands before a flushed correction's scroll event", () => {
  const c = setup({ vendor: "Google Inc.", offset: 400 }); // Chromium
  c.store.h(1, 300); // native upward scrolling, as when paging history
  c.prepend(40);
  c.store.h(1, c.viewport.scrollTop); // the jump's own scroll event
  // The prepended rows measure in the next frame: their correction is flushed
  // and the range is held until that correction's scroll event arrives.
  c.store.h(
    3,
    Array.from({ length: 20 }, (_, index) => [index, 110]),
  );
  c.driver.te();
  expect(c.store.$(1600)).toEqual([7, 39]);
  // The next page lands first. Its 20 rows go in front of every held row, so
  // the held range must move with them: [7, 39] would mount the new rows and
  // unmount the rows just below the viewport, to be remounted one frame later.
  c.store.h(5, 60, true);
  expect(c.store.$(1600)).toEqual([27, 59]);
  c.driver.te();
  c.store.h(1, c.viewport.scrollTop); // the scroll event: the range is live again
  // Inside the held range: the rows it kept mounted stay, nothing remounts.
  expect(c.store.$(1600)).toEqual([29, 59]);
  c.driver.R();
});

it("holds the top rows when a removal past the held range lands before a flushed correction's scroll event", () => {
  const c = setup({ vendor: "Google Inc.", offset: 400 }); // Chromium
  c.store.h(5, 60, false); // 40 newer rows below the viewport
  c.store.h(1, 300); // native upward scrolling, as when paging history
  c.prepend(80);
  c.store.h(1, c.viewport.scrollTop); // the jump's own scroll event
  c.store.h(
    3,
    Array.from({ length: 20 }, (_, index) => [index, 110]),
  );
  c.driver.te(); // the measurement's correction is flushed: the range is held
  expect(c.store.$(1600)).toEqual([7, 44]);
  // A head removal past every held row lands first. Moved by its delta the
  // range would name rows above the list, an inverted range that renders no
  // row for a frame; the rows it keeps are the top ones the offset lands on.
  c.store.h(5, 30, true);
  expect(c.store.$(1600)).toEqual([0, 29]);
  c.driver.te();
  // Its scroll event: nothing is left above the viewport, so layout clamps
  // the corrected offset to the top and the live range lies in the held one.
  c.store.h(1, 0);
  expect(c.store.$(1600)).toEqual([0, 21]);
  c.driver.R();
});

// A flushed correction holds the mounted range until its own scroll event. A
// correction that moves nothing, or that another write undoes in the same task,
// raises none. Idle must still buffer both sides, or a held row just below the
// viewport stays unmounted until the next scroll (history-loading.spec.mjs:334).
it("releases a flushed correction's held range at scroll-end when another write undoes it", () => {
  const c = setup({ platform: "Linux x86_64", offset: 1000 });
  c.viewport.scrollTop = 900;
  c.viewport.dispatchEvent(new Event("scroll")); // upward: buffers only above
  expect(c.store.$(200)).toEqual([7, 14]);
  c.store.h(3, [
    [1, 60],
    [2, 60],
  ]); // rows above shrink: one -80 correction
  c.store.$(200);
  c.driver.te();
  expect(c.calls.map(({ options }) => options.top)).toEqual([-80]);
  // Another write restores the offset before the correction's scroll event,
  // so the only event reports the offset the store already holds.
  c.viewport.scrollTop = 900;
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150); // the driver's inferred scroll-end
  expect(c.store.T()).toBe(false);
  expect(c.store.$(200)).toEqual([7, 16]);
  c.driver.R();
});

it("keeps a jump's held range when scroll-end fires before the jump's scroll event", () => {
  const c = setup({ vendor: "Google Inc.", offset: 400 }); // Chromium
  c.viewport.scrollTop = 300;
  c.viewport.dispatchEvent(new Event("scroll")); // arms the 150ms scroll-end
  vi.advanceTimersByTime(140);
  c.prepend(40); // a 2000px shift jump: the viewport is now 2300–2800
  expect(c.store.$(1600)).toEqual([7, 39]);
  // Scroll-end fires before the jump's scroll event. Releasing the hold at the
  // pre-jump offset would mount rows 0–24 and leave most of the viewport blank.
  vi.advanceTimersByTime(10);
  expect(c.store.T()).toBe(false);
  expect(c.store.$(1600)).toEqual([7, 39]);
  c.driver.R();
});

it("re-renders at scroll-end for a held range even when the direction is already idle", () => {
  const c = setup({ platform: "Linux x86_64", offset: 1000 });
  c.store.h(2); // idle before the correction
  c.store.$(200);
  c.store.h(3, [
    [1, 60],
    [2, 60],
  ]);
  c.store.$(200);
  c.driver.te();
  const renders = vi.fn();
  c.store.L(1, renders);
  c.store.h(2);
  expect(renders).toHaveBeenCalledTimes(1);
  c.driver.R();
});

it.each([
  ["ltr", {}],
  ["rtl", { horizontal: true, direction: "rtl" }],
])(
  "renders the first %s viewport range at a scroll that precedes its event",
  (_, config) => {
    const c = setup(config);
    const key = config.horizontal ? "scrollLeft" : "scrollTop";
    const native = config.direction === "rtl" ? -1 : 1;
    // An imperative jump wrote the native offset; its scroll event is queued.
    c.viewport[key] = 1700 * native;
    c.resize([
      { target: c.viewport, contentRect: { height: 600, width: 600 } },
    ]);
    expect(c.store.k()).toBe(1700);
    expect(c.store.o()).toBe(600);
    const [first, last] = c.store.$(0);
    expect(first).toBe(17);
    expect(last).toBeGreaterThanOrEqual(19);
    // The queued event then carries no new offset.
    c.viewport.dispatchEvent(new Event("scroll"));
    expect(c.store.k()).toBe(1700);
    c.driver.R();
  },
);

// The timer stays at zero: measurement delivery is explicitly inside the
// retained command's 150ms lifetime, not after an input-settle helper expires it.
it.each(["wheel", "touchmove", "keydown", "pointerdown"])(
  "%s retires a pending imperative target before late measurement",
  async (type) => {
    const c = setup({ platform: "Linux x86_64", offset: 0 });
    c.store.h(
      3,
      Array.from({ length: 20 }, (_, index) => [index, 100]),
    );
    await c.driver.ee(19, { align: "end" });
    expect(c.viewport.scrollTop).toBe(1500);
    c.viewport.dispatchEvent(Object.assign(new Event(type), { deltaY: -500 }));
    c.viewport.scrollTop = 1000;
    c.viewport.dispatchEvent(new Event("scroll"));
    c.calls.length = 0;
    c.store.h(5, 21, false);
    c.store.h(3, [[20, 120]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.viewport.scrollTop).toBe(1000);
    expect(c.calls).toEqual([]);
    // A fresh navigation still owns its target and corrects later measurements.
    await c.driver.ee(20, { align: "end" });
    c.store.h(3, [[20, 140]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.viewport.scrollTop).toBe(1640);
    c.driver.R();
  },
);

it.each(["input", "dispose"])(
  "%s invalidates an already queued imperative measurement replay",
  async (cancel) => {
    const c = setup({ platform: "Linux x86_64", offset: 0 });
    await c.driver.ee(null, { offset: 1500 });
    c.calls.length = 0;
    c.store.h(3, [[19, 120]]); // queue the replay, but do not run it yet
    if (cancel === "input") c.viewport.dispatchEvent(new Event("wheel"));
    else c.driver.R();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toEqual([]);
    if (cancel === "input") c.driver.R();
  },
);

it("removes cancellation listeners on disposal and reattaches on remount", async () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const remove = vi.spyOn(c.viewport, "removeEventListener");
  c.driver.R();
  for (const type of ["wheel", "touchmove", "keydown", "pointerdown"])
    expect(remove).toHaveBeenCalledWith(type, expect.any(Function), true);
  c.driver.U({}, c.viewport);
  await c.driver.ee(null, { offset: 1500 });
  c.viewport.dispatchEvent(new Event("wheel"));
  c.calls.length = 0;
  c.store.h(3, [[19, 120]]);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.calls).toEqual([]);
  c.driver.R();
});

it("reports actual correction writes separately from coalesced reader movement", () => {
  const c = setup({ platform: "Linux x86_64", offset: 1300 });
  const corrections = [];
  c.viewport.addEventListener("virtua-scroll-correction", (event) =>
    corrections.push(event.detail),
  );
  c.viewport.scrollTop -= 50; // wheel before its native scroll notification
  c.prepend();
  expect(corrections).toEqual([{ before: 1250, after: 3250 }]);
  c.viewport.scrollTop -= 40; // wheel after correction, same native event frame
  c.viewport.dispatchEvent(new Event("scroll"));
  expect(c.viewport.scrollTop).toBe(3210);
  c.driver.te();
  expect(corrections).toHaveLength(1);
  c.driver.R();
});

it("reports clamped fractional correction offsets, not requested deltas", () => {
  const c = setup({ platform: "Linux x86_64", offset: 1490 });
  const corrections = [];
  c.viewport.addEventListener("virtua-scroll-correction", (event) =>
    corrections.push(event.detail),
  );
  c.viewport.max = 1420.5;
  c.store.h(3, [
    [1, 60.25],
    [2, 60.25],
  ]);
  c.driver.te();
  expect(corrections).toEqual([{ before: 1490, after: c.viewport.scrollTop }]);
  expect(c.viewport.scrollTop).toBe(1410);
  c.driver.R();
});
