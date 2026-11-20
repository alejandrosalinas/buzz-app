import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import {
  activate,
  wheel,
  open,
  settle,
  anchor,
  expectAnchor,
} from "./timeline.mjs";

test.use({
  enabledPlugins: ["buzz.workflows"],
  productionBroker: true,
  developmentReact: true,
});
const sized = test.extend({ historyCounts: { alpha: 20, beta: 20 } });
const short = test.extend({ historyCounts: { alpha: 20, beta: 1 } });
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
async function bottom(page, app, label) {
  // Quiet geometry can precede Virtua's deferred initial positioning. Observe
  // that positioning first, then verify it remains settled without user input.
  await expect
    .poll(
      () =>
        history(page).evaluate(
          (e) => e.scrollHeight - e.clientHeight - e.scrollTop,
        ),
      { message: label },
    )
    .toBeLessThan(4);
  await settle(page);
  const metrics = await history(page).evaluate((e) => ({
    top: e.scrollTop,
    height: e.scrollHeight,
    viewport: e.clientHeight,
    gap: e.scrollHeight - e.clientHeight - e.scrollTop,
  }));
  app.report.measurements.push({
    label,
    ...metrics,
    saved: await page.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([key]) =>
          key.startsWith("buzz-view.v1:"),
        ),
      ),
    ),
  });
  expect(metrics.gap, label).toBeLessThan(4);
}
async function select(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: `Message #${name}`, exact: true }),
  ).toBeVisible();
  await expect(
    history(page).locator("[data-message-id]").first(),
  ).toBeVisible();
}

sized(
  "cold and warm sidebar entries start at bottom without scrolling",
  async ({ page, app }) => {
    await open(page, app);
    await bottom(page, app, "cold Alpha");
    await select(page, "Beta");
    await bottom(page, app, "cold Beta");
    await select(page, "Alpha");
    await bottom(page, app, "warm Alpha");
    await openPage(page, "Workflows");
    await page.reload();
    await openPage(page, "Messages");
    await bottom(page, app, "persisted bottom Alpha");
    await select(page, "Beta");
    await bottom(page, app, "persisted bottom Beta");
  },
);

short(
  "short channel with tall messages opens at the actual bottom",
  async ({ page, app }) => {
    expect(app.histories.get("primary/beta")).toHaveLength(1);
    app.append("primary", "beta", "Tall message\n".repeat(70), false);
    app.append("primary", "beta", "Last message\n".repeat(25), false);
    await open(page, app);
    await bottom(page, app, "cold Alpha control");
    await select(page, "Beta");
    await bottom(page, app, "cold tall Beta");
    await select(page, "Alpha");
    await select(page, "Beta");
    await bottom(page, app, "warm tall Beta");
  },
);

// Browser-only: a transitioning split gives the entering timeline a passing
// width, so it misses saved geometry and paints unmeasured rows mid-history.
const threaded = test.extend({
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 60, beta: 20 },
});
threaded(
  "entering a channel with or without its thread dock paints only the bottom",
  async ({ page, app }) => {
    await page.addInitScript(() =>
      localStorage.setItem("buzz-thread-placement.v1", "side"),
    );
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .filter((row) => row.content.startsWith("Thread root"))
      .at(-1);
    await activate(
      history(page)
        .locator(`[data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ }),
    );
    await expect(
      page.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeVisible();
    await history(page).evaluate((e) => {
      e.scrollTop = e.scrollHeight;
    });
    await bottom(page, app, "threaded Alpha");
    // Read state adds unread counts to the sidebar entries' names.
    const enter = async (name) => {
      await page
        .getByRole("button", { name: new RegExp(`^${name}\\b`) })
        .first()
        .click();
      await expect(
        page.getByRole("textbox", { name: `Message #${name}`, exact: true }),
      ).toBeVisible();
      await bottom(page, app, `entered ${name}`);
    };
    // Warm both channels' saved geometry before observing entries.
    await enter("Beta");
    await enter("Alpha");
    for (const name of ["Beta", "Alpha"]) {
      await page.evaluate((name) => {
        const frames = [];
        window.entryFrames = frames;
        const next = new MessageChannel();
        // Sample after each rendering update, what that frame presented.
        next.port1.onmessage = () => {
          const feed = document.querySelector(
            '[aria-label="Channel message history"]',
          );
          const entered = document.querySelector(
            `[aria-label="Message #${name}"]`,
          );
          if (feed && entered && feed.querySelector("[data-message-id]"))
            frames.push({
              gap: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
              splitMotion: !!document
                .querySelector("[data-channel-workspace]")
                ?.getAnimations()
                .some(
                  (animation) =>
                    animation.transitionProperty === "grid-template-columns",
                ),
            });
          if (frames.length < 10)
            requestAnimationFrame(() => next.port2.postMessage(0));
        };
        requestAnimationFrame(() => next.port2.postMessage(0));
      }, name);
      await enter(name);
      const frames = await page.evaluate(() => window.entryFrames);
      expect(frames.length, `${name} entry frames`).toBe(10);
      for (const [index, frame] of frames.entries()) {
        expect(frame.splitMotion, `${name} frame ${index} split`).toBe(false);
        expect(frame.gap, `${name} frame ${index} gap`).toBeLessThan(4);
      }
    }
  },
);

// This case tests reading restoration, not cancellation of held older pages.
// Taller rows keep its gesture outside prefetch; paging has separate journeys.
const readingTest = test.extend({
  tallMessages: true,
  historyCounts: { alpha: 20, beta: 1 },
});
readingTest(
  "deliberate reading anchor survives a session reload",
  async ({ page, app }) => {
    await open(page, app);
    await bottom(page, app, "initial bottom");
    await history(page).hover();
    await wheel(page, -650);
    await expect
      .poll(() =>
        history(page).evaluate(
          (e) => e.scrollHeight - e.clientHeight - e.scrollTop,
        ),
      )
      .toBeGreaterThan(400);
    await settle(page);
    expect(
      await history(page).evaluate(
        (el) => el.scrollTop - Math.max(3000, el.clientHeight * 4),
      ),
      "reading gesture stays outside older-page prefetch",
    ).toBeGreaterThan(0);
    expect(app.pending).toHaveLength(0);
    const reading = await anchor(page);
    await openPage(page, "Workflows");
    await page.reload();
    await openPage(page, "Messages");
    await settle(page);
    await expectAnchor(page, reading);
  },
);

for (const count of [1, 3, 5, 7, 9]) {
  const nearFitTest = test.extend({
    historyCounts: { alpha: 1, beta: count },
  });
  nearFitTest(
    `near-fit channel with ${count} mixed-height rows starts at bottom`,
    async ({ page, app }) => {
      await open(page, app);
      expect(app.histories.get("primary/beta")).toHaveLength(count);
      await select(page, "Beta");
      await bottom(page, app, `cold ${count}-row Beta`);
      await select(page, "Alpha");
      await select(page, "Beta");
      await bottom(page, app, `warm ${count}-row Beta`);
    },
  );
}

// Agents-only updates fold into one row, so a head of them paints less than a
// screen and leaves nothing to scroll. Opening fills it without reader input.
const activityHead = test.extend({ historyCounts: { alpha: 30, beta: 1 } });
activityHead(
  "a head of folded agent activity fills the screen at the bottom",
  async ({ page, app }) => {
    // One author's burst, five a second, sent in parallel: ms order is not
    // event-ID order. A newer public message follows it.
    for (let i = 0; i < 23; i++)
      app.append(
        "primary",
        "alpha",
        `Agent update ${i + 1}`,
        false,
        true,
        undefined,
        undefined,
        [
          ["audience", "agents"],
          ["ms", String((i * 397) % 1000)],
        ],
        1700000500 + Math.floor(i / 5),
      );
    app.append("primary", "alpha", "Latest public message", false);
    const latest = history(page).getByText("Latest public message");
    const filled = async (visit) => {
      await expect
        .poll(() =>
          history(page).evaluate((e) => e.scrollHeight - e.clientHeight),
        )
        .toBeGreaterThan(0);
      await bottom(page, app, `${visit} filled activity head`);
      await expect(latest).toBeInViewport();
      expect(
        app.pending,
        `${visit} filled screen reads no further`,
      ).toHaveLength(0);
    };
    for (const visit of ["cold", "reloaded"]) {
      if (visit === "cold") await open(page, app);
      else {
        await page.reload();
        await openPage(page, "Messages");
      }
      await expect(latest).toBeVisible();
      await expect
        .poll(() => app.pending.length, {
          message: `${visit} underfilled head reads older history unasked`,
        })
        .toBe(1);
      const read = app.pending.shift();
      expect(read.channel).toBe("alpha");
      expect(
        await history(page).evaluate((e) => e.scrollHeight - e.clientHeight),
        `${visit} head alone leaves nothing to scroll`,
      ).toBeLessThanOrEqual(0);
      read.release();
      await filled(visit);
      // A return in the same session keeps the filled rows: no page is reread.
      await select(page, "Beta");
      await select(page, "Alpha");
      await filled(`${visit} returned`);
    }
  },
);
