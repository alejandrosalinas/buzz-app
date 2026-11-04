import { test, expect, repeats, timeline } from "./runner.mjs";
import { scrollCadence } from "./cadence.mjs";
import {
  populateThread,
  THREAD_CHANNEL,
  THREAD_REPLIES,
} from "./thread-corpus.mjs";
import { hoverMessage } from "../message-actions.mjs";
import { settle } from "../timeline.mjs";

// Browser-only: scrolling the thread history once every reply the strict window
// holds is loaded (docs/channels.md#scrolling-long-threads). Rendering and
// scroll cost at that scale need a real engine; frame intervals reproduce the
// compositing stalls only in WebKit (docs/performance.md#thread-scrolling).
test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  channelIds: ["alpha", THREAD_CHANNEL],
  historyCounts: { alpha: 1, [THREAD_CHANNEL]: 0 },
});

const historySelector = '[aria-label="Thread messages"]';
const topLevel = ":scope > [data-thread-rows] > ol > li[data-layout]";
// Upward is positive in Chromium's gesture distance, negative in wheel deltas.
const gestures = {
  "thread-scroll-fling": [[6000, 6000]],
  "thread-scroll-reverse": [
    [6000, 6000],
    [-3000, 6000],
    [3500, 8000],
  ],
};

async function openThread(page, app, perf) {
  const root = populateThread(app);
  const ids = [root.id, ...app.inboxWindow.replies.map((event) => event.id)];
  await perf.setup(THREAD_CHANNEL);
  const row = page
    .locator(timeline(THREAD_CHANNEL))
    .locator(`[data-message-id="${root.id}"]`);
  // Closed bars are laid out at opacity 0; click only the revealed one.
  await hoverMessage(row);
  const reply = page
    .locator('[role="group"][aria-label="Message actions"]:popover-open')
    .getByRole("button", { name: "Reply", exact: true });
  await expect(reply).toBeVisible();
  return { root, ids, row, reply };
}

const history = (page) =>
  page.getByRole("region", { name: "Thread messages", exact: true });

// Every older page is requested by upward wheel input at the top and held by
// the fixture until released, so each step waits for its request and rows.
async function loadHistory(page, app) {
  const element = history(page);
  const expected =
    THREAD_REPLIES - app.inboxWindow.replies.filter(isNested).length;
  const box = await element.boundingBox();
  await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2);
  let released = app.pending.length;
  for (let page_ = 0; page_ < 9; page_++) {
    const before = await element.locator(topLevel).count();
    await element.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.mouse.wheel(0, -400);
    await expect
      .poll(() => app.pending.length, { message: "older page requested" })
      .toBeGreaterThan(released);
    while (released < app.pending.length) app.pending[released++].release();
    await expect
      .poll(() => element.locator(topLevel).count(), {
        message: "older page rendered",
      })
      .toBeGreaterThan(before);
  }
  await expect(element.locator(topLevel)).toHaveCount(expected);
  await settle(page, element);
  return expected;
}
const isNested = (event) =>
  event.tags.some(([name, , , marker]) => name === "e" && marker === "root");

for (const name of ["thread-scroll-open", ...Object.keys(gestures)])
  for (let i = 1; i <= repeats; i++)
    test(`${name} sample ${i}`, async ({ page, app, perf, browserName }) => {
      test.setTimeout(180_000);
      const { ids, reply } = await openThread(page, app, perf);
      if (name === "thread-scroll-open") {
        const sample = await perf.measure(THREAD_CHANNEL, {
          click:
            '[role="group"][aria-label="Message actions"]:popover-open button[aria-label="Reply"]',
          selector: historySelector,
          ids,
          timeoutMs: 30_000,
          work: { replies: THREAD_REPLIES },
        });
        await perf.save(sample);
        return;
      }
      await reply.click();
      const element = history(page);
      await expect(element).not.toHaveAttribute("data-positioning");
      const loaded = await loadHistory(page, app);
      await element.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await settle(page, element);
      // A press in the empty right gutter sets pointer modality, as clicking
      // into a conversation does; the wheel then runs mid-pane, over replies.
      const box = await element.boundingBox();
      await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2);
      const point = {
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2),
      };
      await page.mouse.move(point.x, point.y);
      expect(
        await page.evaluate(() =>
          document.documentElement.hasAttribute("data-keyboard-navigation"),
        ),
        "pointer modality",
      ).toBe(false);
      // Untraced warm-up: the first synthetic gesture waits for the main thread.
      await perf.cdp?.send("Input.synthesizeScrollGesture", {
        ...point,
        yDistance: 1,
        speed: 1000,
      });
      await settle(page, element);
      const requestsBefore = app.pending.length;
      const before = await element.evaluate((node) => node.scrollTop);
      const sample = await perf.measure(THREAD_CHANNEL, {
        selector: historySelector,
        ids,
        timeoutMs: 60_000,
        act: async () => {
          for (const [distance, speed] of gestures[name])
            if (perf.cdp)
              await perf.cdp.send("Input.synthesizeScrollGesture", {
                ...point,
                yDistance: distance,
                speed,
                gestureSourceType: "mouse",
              });
            // WebKit has no gesture synthesis: a train of wheel events, each
            // delivered after the previous rendering update. Trust its frame
            // intervals, not its duration or frame count.
            else
              for (let step = 0; step < Math.abs(distance) / 240; step++)
                await page.mouse.wheel(0, distance > 0 ? -240 : 240);
        },
        work: {
          engine: browserName,
          gestures: gestures[name],
          topLevelReplies: loaded,
          scrollTopBefore: before,
        },
      });
      const { frames, wheels } = sample.recording;
      const tops = frames.map((frame) => frame.top);
      const inside = frames.filter(
        (frame) =>
          frame.t > sample.recording.gestureStartMs &&
          frame.t < sample.recording.gestureEndMs,
      );
      Object.assign(sample.metrics, scrollCadence(sample.recording), {
        // Sampled DOM evidence, not painted pixels: no loaded reply intersects
        // the viewport. See the native harness for blank frames.
        domGapFrames: inside.filter((frame) => !frame.rows.length).length,
        scrollTopRangePx: Math.max(before, ...tops) - Math.min(before, ...tops),
      });
      Object.assign(sample.work, {
        wheels,
        mountedRows: await element.locator("[data-message-id]").count(),
        olderReadsDuring: app.pending.length - requestsBefore,
      });
      await perf.save(sample);
      expect(wheels, "real wheel input").toBeGreaterThan(0);
      expect(sample.work.olderReadsDuring, "history was already loaded").toBe(
        0,
      );
      expect(
        sample.metrics.scrollTopRangePx,
        "the gestures traverse history",
      ).toBeGreaterThan(5000);
    });
