import { test as base, expect } from "../fixture.mjs";
import { openPage } from "../navigation.mjs";
import { settle, virtuaIdle } from "../timeline.mjs";
import { loafBlocking } from "./blocking.mjs";

export { expect };
export const timeline = (id) => `section[data-channel-timeline="${id}"]`;
export const sidebar = (id) => `button[data-channel-id="${id}"]`;
export const repeats = Number(process.env.PERF_REPEAT ?? 1);
export const heads = (app, id) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter?.["#h"]?.includes(id) &&
      filter.top_level &&
      filter.until === undefined,
  ).length;

// One observer per operation, owned by its JSHandle. No global recorder or
// surviving animation-frame loop. Geometry reads are included in browser costs.
function observe({ selector, ids, click, hoverMs, timeoutMs, chromium }) {
  const allowed = new Set(ids);
  const frames = [];
  const longAnimationFrames = [];
  let start,
    end,
    done = false,
    firstRowsMs,
    previous,
    quietSince,
    raf,
    timer,
    resolve;
  let loafObserver, drainRaf, drainTimer;
  const collect = (entries) => {
    for (const entry of entries)
      longAnimationFrames.push({
        startMs: entry.startTime - start,
        durationMs: entry.duration,
        blockingDurationMs: entry.blockingDuration,
      });
  };
  let wheels = 0;
  let inputAt, hoverAt;
  let gestureStartMs, gestureEndMs;
  const hovered = (event) => {
    if (hoverMs && event.target.closest(click)) hoverAt ??= performance.now();
  };
  const clicked = (event) => {
    if (click && event.target.closest(click)) inputAt = performance.now();
  };
  const result = new Promise((r) => {
    resolve = r;
  });
  const wheel = (event) => {
    if (event.target.closest(selector)) {
      wheels++;
      gestureStartMs ??= performance.now() - start;
    }
  };
  document.addEventListener("wheel", wheel, { passive: true });
  document.addEventListener("click", clicked, true);
  document.addEventListener("pointerover", hovered, true);
  function stop(error) {
    if (end !== undefined) return;
    end = performance.now();
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    document.removeEventListener("wheel", wheel);
    document.removeEventListener("click", clicked, true);
    document.removeEventListener("pointerover", hovered, true);
    resolve({
      error,
      frames,
      wheels,
      gestureStartMs,
      gestureEndMs,
      firstRowsMs,
      hoverLeadMs:
        hoverAt === undefined || inputAt === undefined
          ? undefined
          : inputAt - hoverAt,
      inputDelayMs: inputAt === undefined ? undefined : inputAt - start,
      durationMs: end - start,
    });
  }
  function sample() {
    const now = performance.now();
    const element = document.querySelector(selector);
    const bounds = element?.getBoundingClientRect();
    const rows = element
      ? [...element.querySelectorAll("[data-message-id]")].flatMap((row) => {
          if (
            !allowed.has(row.dataset.messageId) ||
            !row.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            })
          )
            return [];
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom
            ? [[row.dataset.messageId, rect.y, rect.height]]
            : [];
        })
      : [];
    const frame = {
      t: now - start,
      top: element?.scrollTop ?? null,
      height: element?.scrollHeight ?? null,
      rows,
    };
    frames.push(frame);
    // rAF is before paint: require visible rows in two successive rendering
    // updates, providing a paint opportunity, not proof of compositor pixels.
    if (
      firstRowsMs === undefined &&
      rows.length &&
      frames.at(-2)?.rows.length &&
      (!click || inputAt !== undefined)
    )
      firstRowsMs = now - (inputAt ?? start);
    const signature = JSON.stringify([frame.top, frame.height, rows]);
    if (signature !== previous || !rows.length) quietSince = now;
    previous = signature;
    if (
      done &&
      firstRowsMs !== undefined &&
      now - quietSince >= 200 &&
      frames.length >= 3
    )
      stop();
    else raf = requestAnimationFrame(sample);
  }
  return {
    waitForHover() {
      if (hoverAt === undefined)
        throw new Error("Hover did not reach the target");
      return new Promise((r) =>
        setTimeout(
          r,
          Math.ceil(Math.max(0, hoverMs - (performance.now() - hoverAt))),
        ),
      );
    },
    start() {
      const loaf = PerformanceObserver.supportedEntryTypes.includes(
        "long-animation-frame",
      );
      if (chromium && !loaf)
        throw new Error(
          "Chromium does not support long-animation-frame entries",
        );
      start = performance.now();
      if (loaf) {
        loafObserver = new PerformanceObserver((list) =>
          collect(list.getEntries()),
        );
        loafObserver.observe({ type: "long-animation-frame", buffered: false });
      }
      quietSince = start;
      timer = setTimeout(
        () => stop(`Timeline did not settle within ${timeoutMs}ms`),
        timeoutMs,
      );
      raf = requestAnimationFrame(sample);
    },
    done() {
      // The scrolling action resolves after Chromium's synthetic gesture does.
      // This existing browser marker includes the completion protocol dispatch.
      if (gestureStartMs !== undefined)
        gestureEndMs = performance.now() - start;
      done = true;
    },
    result: () => result,
    async longFrames() {
      // stop() runs inside rAF, before Chromium finalizes that frame's entry.
      // Allow two rendering opportunities plus a task for presentation-delayed
      // delivery, outside the pinned duration and CDP counters. This is bounded,
      // not an acknowledgement of compositor presentation (see performance.md).
      await new Promise((r) => {
        drainRaf = requestAnimationFrame(() => {
          drainRaf = requestAnimationFrame(() => {
            drainTimer = setTimeout(r, 0);
          });
        });
      });
      if (loafObserver) {
        collect(loafObserver.takeRecords());
        loafObserver.disconnect();
      }
      return longAnimationFrames.filter(
        (entry) =>
          entry.startMs < end - start && entry.startMs + entry.durationMs > 0,
      );
    },
    stop() {
      stop("Measurement interrupted");
      cancelAnimationFrame(drainRaf);
      clearTimeout(drainTimer);
      loafObserver?.disconnect();
    },
  };
}

const counters = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};
export const test = base.extend({
  // Chromium adds DevTools counters, CPU throttling and long-animation-frame
  // blocking; WebKit samples (PERF_BROWSER=webkit) record frames only.
  perf: async ({ page, app, browserName }, use, testInfo) => {
    const cdp =
      browserName === "chromium"
        ? await page.context().newCDPSession(page)
        : null;
    await cdp?.send("Performance.enable");
    const read = async () => {
      if (!cdp) return {};
      const { metrics } = await cdp.send("Performance.getMetrics");
      return Object.fromEntries(
        Object.entries(counters).map(([key, name]) => {
          const value = metrics.find((m) => m.name === name)?.value;
          if (!Number.isFinite(value))
            throw new Error(`Missing browser counter ${name}`);
          return [key, value * 1000];
        }),
      );
    };
    const perf = {
      cdp,
      async setup(id) {
        await page.goto(app.origin);
        await openPage(page, "Messages");
        await page.evaluate(async () => {
          await Promise.all([...document.fonts].map((font) => font.load()));
        });
        await perf.open(id);
      },
      async open(id) {
        await page.locator(sidebar(id)).evaluate((row) => row.click());
        await expect(
          page.locator(`${timeline(id)} [data-message-id]`).first(),
        ).toBeVisible();
        await virtuaIdle(page, page.locator(timeline(id)));
      },
      // Wheel input uses the timeline gutter, avoiding message hover. Pointer
      // modality ends setup with a real press there, which focuses the list as
      // clicking into a conversation does. Keyboard modality keeps the palette's
      // arrow-key state, with focus outside the list.
      async gutter(id, modality) {
        const scroller = page.locator(timeline(id));
        const point = await scroller.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const list = element.querySelector("ol").getBoundingClientRect();
          return {
            x: Math.round((box.left + list.left) / 2),
            y: Math.round(box.top + box.height / 2),
          };
        });
        for (const type of modality === "pointer"
          ? ["mouseMoved", "mousePressed", "mouseReleased"]
          : ["mouseMoved"])
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: type === "mouseMoved" ? "none" : "left",
            clickCount: 1,
          });
        expect(
          await scroller.evaluate(
            (element, { x, y }) => ({
              inside: element.contains(document.elementFromPoint(x, y)),
              keyboard: document.documentElement.hasAttribute(
                "data-keyboard-navigation",
              ),
              listFocused: element.contains(document.activeElement),
            }),
            point,
          ),
          `pointer inside the timeline, ${modality} modality`,
        ).toEqual({
          inside: true,
          keyboard: modality === "keyboard",
          listFocused: modality === "pointer",
        });
        return point;
      },
      // `selector` and `ids` measure another surface than the channel
      // timeline, such as the thread history.
      async measure(
        id,
        {
          click,
          hoverMs = 0,
          act,
          work = {},
          timeoutMs = 10_000,
          selector = timeline(id),
          ids = app.histories.get(`primary/${id}`).map((event) => event.id),
        },
      ) {
        const box = click ? await page.locator(click).boundingBox() : null;
        if (click && !box) throw new Error(`Missing click target: ${click}`);
        const point = box
          ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          : null;
        let observer, recording;
        const sample = { state: app.report.state, work, metrics: {} };
        try {
          await cdp?.send("Emulation.setCPUThrottlingRate", {
            rate: Number(process.env.PERF_CPU),
          });
          observer = await page.evaluateHandle(observe, {
            selector,
            ids,
            click,
            hoverMs,
            timeoutMs,
            chromium: !!cdp,
          });
          if (hoverMs) {
            await cdp?.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...point,
            });
            await observer.evaluate((o) => o.waitForHover());
          }
          if (click) sample.work.headReadsBefore = heads(app, id);
          const before = await read();
          await observer.evaluate((o) => o.start());
          if (click && !cdp) await page.mouse.click(point.x, point.y);
          else if (click) {
            // Browser input counts synchronous handlers in ScriptDuration.
            // evaluate(() => element.click()) does not. Only the hover case
            // moves the pointer first; cold preparation starts in this window.
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              ...point,
              button: "left",
              clickCount: 1,
            });
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              ...point,
              button: "left",
              clickCount: 1,
            });
          }
          if (act) await act();
          await observer.evaluate((o) => o.done());
          recording = await observer.evaluate((o) => o.result());
          const after = await read();
          recording.longAnimationFrames = await observer.evaluate((o) =>
            o.longFrames(),
          );
          for (const key of Object.keys(after)) {
            sample.metrics[key] = after[key] - before[key];
            expect(sample.metrics[key], key).toBeGreaterThanOrEqual(0);
          }
          sample.recording = recording;
          sample.metrics.durationMs = recording.durationMs;
          if (cdp) sample.metrics.loafBlockingMs = loafBlocking(recording);
          if (click) {
            sample.metrics.firstRowsMs = recording.firstRowsMs;
            sample.work.headReadsDuring =
              heads(app, id) - sample.work.headReadsBefore;
          }
          expect(recording.error).toBeUndefined();
          return sample;
        } finally {
          if (observer) {
            await observer.evaluate((o) => o.stop());
            sample.recording ??= await observer.evaluate((o) => o.result());
            await observer.dispose();
          }
          await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          // The scenario may add work assertions afterwards. Reporter includes
          // this sample in summaries only if the whole test/fixture passed.
          app.report.measurements.push(sample);
        }
      },
      async save(sample) {
        await testInfo.attach("perf-sample", {
          body: JSON.stringify(sample),
          contentType: "application/json",
        });
      },
      settle: (id) => settle(page, page.locator(timeline(id))),
    };
    try {
      await use(perf);
    } finally {
      await cdp?.detach();
    }
  },
});
