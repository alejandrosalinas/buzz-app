import { test, expect, repeats, timeline } from "./runner.mjs";
import { populateThread, THREAD_CHANNEL } from "./thread-corpus.mjs";
import { hoverMessage } from "../message-actions.mjs";

// Opening a thread whose replies are all unread: the reader pages older to the
// first unread reply before it shows anything. Older pages arrive after a
// modeled relay round trip.
const ROUND_TRIP_MS = 150;
const historySelector = '[aria-label="Thread messages"]';
for (const [name, replies] of [
  ["thread-unread-open-60", 60],
  ["thread-unread-open-200", 200],
])
  test.describe(name, () => {
    test.use({
      productionBroker: true,
      readState: true,
      inboxThreadWindow: true,
      olderPageDelayMs: ROUND_TRIP_MS,
      channelIds: ["alpha", THREAD_CHANNEL],
      historyCounts: { alpha: 1, [THREAD_CHANNEL]: 0 },
    });
    for (let i = 1; i <= repeats; i++)
      test(`${name} sample ${i}`, async ({ page, app, perf }) => {
        test.setTimeout(120_000);
        const root = populateThread(app, { replies });
        const ids = [root.id, ...app.inboxWindow.replies.map((e) => e.id)];
        await perf.setup(THREAD_CHANNEL);
        const row = page
          .locator(timeline(THREAD_CHANNEL))
          .locator(`[data-message-id="${root.id}"]`);
        await hoverMessage(row);
        const reads = app.pending.length;
        const sample = await perf.measure(THREAD_CHANNEL, {
          click:
            '[role="group"][aria-label="Message actions"]:popover-open button[aria-label="Reply"]',
          selector: historySelector,
          ids,
          timeoutMs: 30_000,
          work: { replies, roundTripMs: ROUND_TRIP_MS },
        });
        sample.work.olderReads = app.pending.length - reads;
        await expect(page.locator(historySelector)).not.toHaveAttribute(
          "data-positioning",
        );
        await perf.save(sample);
      });
  });
