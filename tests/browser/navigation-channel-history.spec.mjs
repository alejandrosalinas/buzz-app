import { test, expect } from "./fixture.mjs";
import { anchor, end, expectAnchor, open, settle, upper } from "./timeline.mjs";

// A link stays in the channel timeline only for a top-level message without
// replies inside the latest 20 rows; any other link opens a thread, whose
// Back/Forward behaviour navigation-thread-history.spec.mjs covers.
test.use({
  productionBroker: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 1 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });
const sidebar = (page, id) =>
  page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator(`button[data-channel-id="${id}"]`);
const alphaMessage = (app, n) =>
  app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith(`primary alpha message ${n}\n`));
const opened = (page) =>
  expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
// Keyboard activation: Virtua's pointer hold cannot intercept it.
async function follow(page, link) {
  await expect(link).toBeVisible();
  await link.focus();
  await link.press("Enter");
  await opened(page);
  await settle(page);
}
const focusedRow = (page) =>
  page.evaluate(
    () =>
      document.activeElement?.closest("[data-message-id]")?.dataset.messageId ??
      null,
  );
const gap = (page) =>
  history(page).evaluate(
    (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
  );
// A reveal puts its row at the top of the timeline and focuses it.
async function expectRevealed(page, id) {
  const row = history(page).locator(`[data-message-id="${id}"]`);
  await expect(row).toBeFocused();
  expect(
    await history(page).evaluate(
      (node, id) =>
        node.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect()
          .top - node.getBoundingClientRect().top,
      id,
    ),
  ).toBeLessThan(4);
}
// Each link opening re-runs ChannelsPage's placement, which keeps the message
// in the timeline only while #Alpha's window is ready and verified. The relay
// fixture holds older pages until the test releases them; a held page times out
// in the reader after 10 s and marks the window cached, and every later opening
// then shows a thread. So check the window and that no older page is held.
// With #Alpha's whole history loaded (no more), none can be requested later.
async function expectVerifiedAlpha(page, app) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const view = window.fixtureRelay
          .snapshot()
          .session.channels.window("alpha");
        return {
          status: view.status,
          freshness: view.freshness,
          loadingOlder: view.loadingOlder,
          hasMore: view.hasMore,
          error: view.error ?? null,
        };
      }),
    )
    .toEqual({
      status: "ready",
      freshness: "verified",
      loadingOlder: false,
      hasMore: false,
      error: null,
    });
  expect(app.pending).toHaveLength(0);
}
// From before a traversal until read, record each painted frame in which #Alpha
// shows rows: its first visible row, whether the linked row is in view, and the
// distance to the end.
const sampleFrames = (page, linked) =>
  page.evaluate((linked) => {
    const frames = [];
    window.channelFrames = frames;
    // A task queued from a frame callback runs after that frame paints.
    const next = () => requestAnimationFrame(() => setTimeout(sample));
    const sample = () => {
      if (window.channelFrames !== frames) return;
      const node = document.querySelector(
        '[data-channel-timeline="alpha"][aria-label="Channel message history"]',
      );
      const view = node?.getBoundingClientRect();
      const rows = node ? [...node.querySelectorAll("[data-message-id]")] : [];
      const inView = (row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > view.top + 1 && rect.top < view.bottom - 1;
      };
      const first = rows.find(inView);
      if (first)
        frames.push({
          id: first.dataset.messageId,
          linked: rows.some(
            (row) => row.dataset.messageId === linked && inView(row),
          ),
          gap: Math.round(
            node.scrollHeight - node.clientHeight - node.scrollTop,
          ),
        });
      next();
    };
    next();
  }, linked);
const sampledFrames = (page) =>
  page.evaluate(() => {
    const frames = window.channelFrames;
    window.channelFrames = undefined;
    return frames;
  });

test("Back and Forward return a link-opened channel to the reader's place; a fresh link reveals it again", async ({
  page,
  app,
}) => {
  const target = alphaMessage(app, 3);
  const opener = app.append(
    "primary",
    "beta",
    `Older decision: <buzz://message?channel=alpha&id=${target.id}>`,
    false,
    false,
  );
  await open(page, app);
  const link = page
    .locator(`[data-channel-timeline] [data-message-id="${opener.id}"]`)
    .getByRole("link", { name: /in #Alpha$/ });
  const leaveForBeta = async () => {
    await sidebar(page, "beta").click();
    await expect(composer(page, "Beta")).toBeVisible();
    await opened(page);
  };
  await leaveForBeta();
  await follow(page, link);
  await expectRevealed(page, target.id);
  await end(page);
  await leaveForBeta();

  // Back remounts #Alpha where it was left, the end, with no frame of the
  // link's row and without focusing it.
  await sampleFrames(page, target.id);
  await page.goBack();
  await expect(composer(page, "Alpha")).toBeVisible();
  await opened(page);
  await settle(page);
  expect(await gap(page)).toBeLessThan(4);
  const atEnd = await sampledFrames(page);
  expect(atEnd.length).toBeGreaterThan(0);
  expect(atEnd.filter((frame) => frame.linked || frame.gap >= 4)).toEqual([]);
  expect(await focusedRow(page)).toBeNull();

  // A place within the channel survives Forward then Back.
  const saved = await upper(page);
  await page.goForward();
  await expect(composer(page, "Beta")).toBeVisible();
  await opened(page);
  await sampleFrames(page, target.id);
  await page.goBack();
  await expect(composer(page, "Alpha")).toBeVisible();
  await opened(page);
  await settle(page);
  await expectAnchor(page, saved);
  const midway = await sampledFrames(page);
  expect(midway.length).toBeGreaterThan(0);
  expect(midway.filter((frame) => frame.linked)).toEqual([]);
  expect(await focusedRow(page)).toBeNull();

  // A later sidebar visit opens where the reader left, not at the link.
  await leaveForBeta();
  await sidebar(page, "alpha").click();
  await expect(composer(page, "Alpha")).toBeVisible();
  await opened(page);
  await settle(page);
  await expectAnchor(page, saved);

  // Following the link again is a new opening: it reveals the message.
  await leaveForBeta();
  await expectVerifiedAlpha(page, app);
  await follow(page, link);
  await expectRevealed(page, target.id);
});

test("Back between two links in one channel returns to the reader's place; the same link reveals it again", async ({
  page,
  app,
}) => {
  const [first, second] = [3, 8].map((n) => alphaMessage(app, n));
  const opener = app.append(
    "primary",
    "alpha",
    `See <buzz://message?channel=alpha&id=${first.id}> and <buzz://message?channel=alpha&id=${second.id}>`,
    false,
    false,
  );
  await open(page, app);
  const link = (index) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${opener.id}"]`)
      .getByRole("link", { name: /in #Alpha$/ })
      .nth(index);
  await follow(page, link(0));
  await expectRevealed(page, first.id);
  // Enter on the link is reading input in #Alpha's own timeline, so the
  // reveal's scroll asks for the one older page beyond its 20-row head. Answer
  // it, so no held read can time out under a later opening.
  await expect.poll(() => app.pending.length).toBe(1);
  app.pending.shift().release();
  await expectVerifiedAlpha(page, app);
  await settle(page);
  await end(page);
  await follow(page, link(1));
  await expectRevealed(page, second.id);
  const revealed = await anchor(page);

  // The mounted timeline returns to the end. Until Back lands it still shows
  // the second link's place; no frame goes back to the first link's row.
  await sampleFrames(page, first.id);
  await page.goBack();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.fixtureNavigation.snapshot().entry.target.messageId,
      ),
    )
    .toBe(first.id);
  await opened(page);
  await settle(page);
  expect(await gap(page)).toBeLessThan(4);
  const frames = await sampledFrames(page);
  expect(frames.length).toBeGreaterThan(0);
  expect(
    frames.filter(
      (frame) => frame.linked || (frame.id !== second.id && frame.gap >= 4),
    ),
  ).toEqual([]);
  // Focus left on the second link's row moves to the restored reading.
  await expect(history(page)).toBeFocused();

  // Forward returns to the second link's place without revealing it again.
  await page.goForward();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.fixtureNavigation.snapshot().entry.target.messageId,
      ),
    )
    .toBe(second.id);
  await opened(page);
  await settle(page);
  await expect(history(page)).toBeFocused();
  await expectAnchor(page, revealed);

  // Following the first link while Back shows its visit opens that same visit
  // again, and a same-target opening reveals the message.
  await page.goBack();
  await opened(page);
  await settle(page);
  expect(await gap(page)).toBeLessThan(4);
  const entry = () =>
    page.evaluate(() => window.fixtureNavigation.snapshot().entry.id);
  const returned = await entry();
  await expectVerifiedAlpha(page, app);
  await follow(page, link(0));
  await expectRevealed(page, first.id);
  expect(await entry()).toBe(returned);
});
