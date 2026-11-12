import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import {
  anchor,
  expectAnchor,
  open,
  settle,
  upper,
  wheel,
} from "./timeline.mjs";

test.use({
  enabledPlugins: ["buzz.workflows"],
  productionBroker: true,
  historyCounts: { alpha: 640, beta: 20 },
});
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

const tall = test.extend({ tallMessages: true });

tall(
  "automatic history starts before the top in a production broker session",
  async ({ page, app }) => {
    await open(page, app);
    await expect(
      page.getByRole("dialog", {
        name: "Buzz is having trouble connecting",
        exact: true,
      }),
    ).toHaveCount(0);
    await history(page).hover();
    for (let i = 0; i < 100 && !app.pending.length; i++) {
      const before = await history(page).evaluate((e) => e.scrollTop);
      await page.mouse.wheel(0, -450);
      // Each wheel step must land (scroll moves or the older page is
      // requested) before the next one.
      await expect
        .poll(
          async () =>
            app.pending.length > 0 ||
            (await history(page).evaluate((e) => e.scrollTop)) < before,
        )
        .toBe(true);
      if (
        await history(page)
          .getByRole("button", { name: "Loading older…", exact: true })
          .count()
      )
        break;
    }
    await expect.poll(() => app.pending.length).toBe(1);
    const top = await history(page).evaluate((e) => e.scrollTop);
    app.report.measurements.push({ automaticRequestTop: top });
    expect(top).toBeGreaterThan(1000);
    app.pending.shift().release();
    await settle(page);
  },
);

test("returning to the top continues history loading on wheel without a button", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("dialog", {
      name: "Buzz is having trouble connecting",
      exact: true,
    }),
  ).toHaveCount(0);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  await settle(page);
  // Navigate away while a real cursor request is in flight, then return to the
  // saved top before releasing it; this must remain an ordinary scroll journey.
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  app.pending.shift().release();
  await settle(page);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  app.pending.shift().release();
});

test("saved top resumes automatic history on an upward gesture after remount", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("dialog", {
      name: "Buzz is having trouble connecting",
      exact: true,
    }),
  ).toHaveCount(0);
  await history(page).hover();
  // Establish the saved top with real input; remeasurement can consume part
  // of a gesture. Each settled gesture must make progress toward the top.
  while (true) {
    const before = await history(page).evaluate((e) => e.scrollTop);
    if (before <= 0) break;
    await wheel(page, -before);
    expect(
      await history(page).evaluate((e) => e.scrollTop),
      "saved-top setup retains upward progress",
    ).toBeLessThan(before);
  }
  await expect.poll(() => app.pending.length).toBe(1);
  await settle(page);
  await expect.poll(() => history(page).evaluate((e) => e.scrollTop)).toBe(0);
  await openPage(page, "Workflows");
  // Remounting Channels captures the normal reading anchor in localStorage.
  // Reload gives a new session/finite head but preserves that user-owned anchor.
  await page.reload();
  app.pending.shift().release();
  await openPage(page, "Messages");
  await expect(history(page)).toBeVisible();
  await expect(
    page.getByRole("dialog", {
      name: "Buzz is having trouble connecting",
      exact: true,
    }),
  ).toHaveCount(0);
  await settle(page);
  await expect.poll(() => history(page).evaluate((e) => e.scrollTop)).toBe(0);
  expect(app.pending).toHaveLength(0);
  await history(page).hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => app.pending.length).toBe(1);
  app.pending.shift().release();
});

test.describe("quota retry without threshold-driven continuation", () => {
  test.use({ tallMessages: true });
  test("older-page quota errors require deliberate retry instead of more scrolling requests", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect(
      page.getByRole("dialog", {
        name: "Buzz is having trouble connecting",
        exact: true,
      }),
    ).toHaveCount(0);
    const olderAlpha = (filter) =>
      filter.until !== undefined &&
      filter["#h"]?.includes("alpha") &&
      filter.kinds?.some((kind) => kind === 9 || kind === 40002);
    // Observe before broker admission: a bad retry may be rejected locally.
    // Unrelated background reads (including unread repair) must not count.
    const browserCursors = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/relay/primary/query"
      ) {
        const filters = request.postDataJSON();
        if (filters.some(olderAlpha)) browserCursors.push(filters);
      }
    });
    // A hint past the first backoff ceiling surfaces instead of retrying quietly.
    app.relay.quotaNextOlder("alpha");
    const cursors = () =>
      app.report.queries.filter(({ filter }) => olderAlpha(filter));
    await history(page).hover();
    await page.mouse.wheel(0, -100000);
    await expect(history(page).getByRole("alert")).toContainText(
      "rate-limited",
    );
    const count = cursors().length;
    expect(count).toBe(1);
    expect(browserCursors).toHaveLength(1);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -500);
    await settle(page);
    expect(cursors()).toHaveLength(count);
    expect(browserCursors).toHaveLength(count);
    // Only the broker lane holds older-page retries; it reopens at this bound.
    await expect.poll(() => app.relay.brokerCooldownOver()).toBe(true);
    await history(page)
      .getByRole("button", { name: "Retry older messages", exact: true })
      .click();
    await expect.poll(() => app.pending.length).toBe(1);
    expect(cursors()).toHaveLength(count + 1);
    expect(browserCursors).toHaveLength(count + 1);
    app.pending.shift().release();
    await expect(history(page).getByRole("alert")).toHaveCount(0);
    await expect(
      history(page).getByRole("button", {
        name: "Load older messages",
        exact: true,
      }),
    ).toBeEnabled(); // Still more history: retry success must not enqueue it.
    await settle(page);
    expect(cursors()).toHaveLength(count + 1);
    expect(browserCursors).toHaveLength(count + 1);
    expect(app.pending).toHaveLength(0);
  });
});

test.describe("pages inside one second", () => {
  // More rows share a second than a page holds. Relay pages break ties by id,
  // rows by send time, so the next page lands among the loaded rows of that second.
  test.use({ historyRowsPerSecond: 30 });
  // Hold the next older page while reading `depth` px above the newest rows.
  async function reading(page, app, depth) {
    await open(page, app);
    await history(page).hover();
    await wheel(page, -250);
    await expect.poll(() => app.pending.length).toBe(1);
    if (depth > 250) await wheel(page, 250 - depth);
    const pending = app.pending.shift();
    expect(
      pending.events.every(
        (event) => event.created_at === pending.filter.until,
      ),
    ).toBe(true);
    return pending;
  }
  const latest = (page) =>
    page.getByRole("button", { name: /^(Jump to latest|\d+ new messages?)$/ });
  for (const depth of [250, 1400])
    test(`an older page among the loaded rows keeps a reader ${depth}px up`, async ({
      page,
      app,
    }) => {
      const pending = await reading(page, app, depth);
      const before = await anchor(page);
      const height = await history(page).evaluate((e) => e.scrollHeight);
      // A live append can arrive before the older page's deferred row
      // measurements. Hold that boundary explicitly instead of racing frames.
      const deferred = depth === 1400;
      if (deferred) await holdFrames(page);
      try {
        pending.release();
        await expect
          .poll(() => history(page).evaluate((e) => e.scrollHeight))
          .toBeGreaterThan(height);
        if (!deferred) await settle(page);
        await expectAnchor(page, before);
        // History is not new; a live message still is.
        await expect(latest(page)).toHaveText("Jump to latest");
        app.append("primary", "alpha", undefined, true, false);
        await expect(latest(page)).toHaveText("1 new message");
      } finally {
        if (deferred) await page.evaluate(() => window.releaseFrames());
      }
      await settle(page);
      await expectAnchor(page, before);
    });

  test("input after the page lands starts from the reader's row", async ({
    page,
    app,
  }) => {
    const pending = await reading(page, app, 1400);
    const before = await anchor(page);
    const height = await history(page).evaluate((e) => e.scrollHeight);
    await holdFrames(page);
    try {
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await expectAnchor(page, before);
      const wheeled = await history(page).evaluateHandle((e) => {
        const state = { wheel: false };
        e.addEventListener("wheel", () => (state.wheel = true), {
          once: true,
          passive: true,
        });
        return state;
      });
      await page.mouse.wheel(0, -40);
      await expect
        .poll(() => wheeled.evaluate((state) => state.wheel))
        .toBe(true);
      await expectAnchor(page, { ...before, y: before.y + 40 });
    } finally {
      await page.evaluate(() => window.releaseFrames());
    }
  });

  // Hold every animation frame: input can arrive before any deferred work.
  async function holdFrames(page) {
    await page.evaluate(() => {
      const { requestAnimationFrame: request, cancelAnimationFrame: cancel } =
        window;
      const held = new Map();
      let id = 0;
      window.requestAnimationFrame = (callback) => {
        held.set(--id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) =>
        id < 0 ? held.delete(id) : cancel(id);
      window.releaseFrames = () => {
        Object.assign(window, {
          requestAnimationFrame: request,
          cancelAnimationFrame: cancel,
        });
        for (const callback of held.values()) request(callback);
      };
    });
  }
  // A pause in geometry is not completion of the deferred page measurements.
  // Wait for Virtua's offsets to reflect the mounted rows' actual heights
  // before taking an independent baseline for growth.
  async function measured(page) {
    await expect
      .poll(() =>
        history(page).evaluate((element) => {
          const items = Array.from(element.querySelector("ol").children);
          return items.every((item, index) => {
            const next = items[index + 1];
            return (
              !next ||
              Math.abs(
                next.getBoundingClientRect().top -
                  item.getBoundingClientRect().bottom,
              ) < 1
            );
          });
        }),
      )
      .toBe(true);
    await settle(page);
  }

  test("a held pointer scrolls across the page without being pulled back", async ({
    page,
    app,
  }) => {
    // A shorter scroller lets the drag carry the held row out of view even
    // when the randomized page leaves little loaded history above the reader.
    await page.setViewportSize({ width: 1440, height: 600 });
    const pending = await reading(page, app, 1400);
    const box = await history(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      // The press records the topmost whole paragraph as the reading anchor.
      // The timeline holds that row in place while any part of it stays in
      // view, even as rows above it measure and move.
      let held = await anchor(page);
      const height = await history(page).evaluate((e) => e.scrollHeight);
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await settle(page);
      await expectAnchor(page, held);
      // Keep enough gesture samples even when the randomized page is short.
      const distance = Math.min(
        150,
        Math.floor((await history(page).evaluate((e) => e.scrollTop)) / 12),
      );
      expect(distance).toBeGreaterThan(0);
      // A scrollbar drag moves the scroller with no further input events,
      // into older rows that measure as they mount, short of the loaded top.
      // Once a step carries the held row out of view, the timeline holds the
      // row it reads at that scroll instead. Reading after the step settles
      // could pick another row once rows above it measure.
      let step = 0;
      let handOvers = 0;
      for (
        ;
        step < 10 &&
        (await history(page).evaluate((e) => e.scrollTop)) >= distance;
        step++
      ) {
        const read = await anchor(page, held.id, -distance);
        if (read.id === held.id) held = { ...held, y: held.y + distance };
        else {
          held = read;
          handOvers++;
        }
        await settle(page);
        await expectAnchor(page, held);
      }
      // The drag hands over at least once and keeps asserting after it.
      expect(step).toBeGreaterThanOrEqual(6);
      expect(handOvers).toBeGreaterThan(0);
    } finally {
      await page.mouse.up();
    }
  });

  test("a held pointer keeps its place after the page's reader row unmounts", async ({
    page,
    app,
  }) => {
    // Leave enough loaded history above the reader for an unclamped drag.
    const pending = await reading(page, app, 250);
    const box = await history(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      // The row the page lands around, which the timeline holds while pressed.
      const held = await anchor(page);
      const height = await history(page).evaluate((e) => e.scrollHeight);
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await settle(page);
      await expectAnchor(page, held);
      // Leave the old reader beyond even the idle buffer, so its absence does
      // not depend on observing Virtua's brief directional scrolling range.
      const row = history(page).locator(`[data-message-id="${held.id}"]`);
      await history(page).evaluate((e) => {
        e.scrollTop = 0;
      });
      await expect(row).toHaveCount(0);
      await settle(page);
      // Wait for idle overscan below the viewport and applied row measurements
      // before taking an independent growth baseline.
      await expect
        .poll(() =>
          history(page).evaluate((e) => {
            const items = Array.from(e.querySelector("ol").children);
            return (
              items.some(
                (item) =>
                  item.getBoundingClientRect().top >
                  e.getBoundingClientRect().bottom,
              ) &&
              items.every((item, index) => {
                const next = items[index + 1];
                return (
                  !next ||
                  Math.abs(
                    next.getBoundingClientRect().top -
                      item.getBoundingClientRect().bottom,
                  ) < 1
                );
              })
            );
          }),
        )
        .toBe(true);
      const before = await anchor(page);
      const measuredHeight = await history(page).evaluate(
        (e) => e.scrollHeight,
      );
      // A buffered row below the viewport grows while the original held row is
      // still absent. Growth below the current reader must not move them.
      await history(page).evaluate((e) => {
        const extra = document.createElement("div");
        extra.style.height = "300px";
        const row = [...e.querySelectorAll("[data-message-id]")].find(
          (row) =>
            row.getBoundingClientRect().top > e.getBoundingClientRect().bottom,
        );
        row.querySelector("p").after(extra);
      });
      await settle(page);
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(measuredHeight);
      await expectAnchor(page, before);
      await expect(row).toHaveCount(0);
    } finally {
      await page.mouse.up();
    }
  });

  // Release the held page, read `distance` px further up, then grow the row
  // in view: it grows downward from the reader.
  async function grows(page, pending, distance) {
    const height = await history(page).evaluate((e) => e.scrollHeight);
    pending.release();
    await expect
      .poll(() => history(page).evaluate((e) => e.scrollHeight))
      .toBeGreaterThan(height);
    await settle(page);
    await wheel(page, -distance);
    await grow(page);
  }
  async function grow(page) {
    const before = await anchor(page);
    // An image or embed finishing below the reader's paragraph.
    await history(page).evaluate((e, id) => {
      const extra = document.createElement("div");
      extra.style.height = "300px";
      e.querySelector(`[data-message-id="${id}"] p`).after(extra);
    }, before.id);
    await settle(page);
    await expectAnchor(page, before);
    return before;
  }
  for (const distance of [600, 1200])
    test(`a row in view grows downward ${distance}px above the page's reader`, async ({
      page,
      app,
    }) => {
      await grows(page, await reading(page, app, 1400), distance);
    });
  test("a row in view grows downward above the page's reader in equal-height rows", async ({
    page,
    app,
  }) => {
    // Moved rows that keep their size measure without changing the list height.
    for (const [key, events] of app.histories)
      app.histories.set(
        key,
        events.map(({ kind, created_at, tags }) =>
          app.sign({
            kind,
            created_at,
            tags,
            content: Array.from({ length: 6 }, (_, i) => `Paragraph ${i}`).join(
              "\n\n",
            ),
          }),
        ),
      );
    await open(page, app);
    await history(page).hover();
    for (let step = 0; step < 20 && !app.pending.length; step++)
      await wheel(page, -500);
    await expect.poll(() => app.pending.length).toBe(1);
    if (await history(page).evaluate((e) => e.scrollTop))
      await wheel(page, -100000);
    await wheel(page, 600);
    await grows(page, app.pending.shift(), 600);
  });

  test("a press released outside history leaves no hold behind", async ({
    page,
    app,
  }) => {
    const pending = await reading(page, app, 1400);
    const box = await history(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 30, {
      steps: 5,
    });
    await page.mouse.up();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await history(page).hover();
    await grows(page, pending, 600);
  });

  test("a drag released before the page's rows measure ends the hold", async ({
    page,
    app,
  }) => {
    const pending = await reading(page, app, 1400);
    const box = await history(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const height = await history(page).evaluate((e) => e.scrollHeight);
    await holdFrames(page);
    try {
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await history(page).evaluate(
        (e) =>
          new Promise((resolve) => {
            e.addEventListener("scrollend", resolve, { once: true });
            e.scrollTop -= 600;
          }),
      );
      await page.mouse.up();
    } finally {
      await page.evaluate(() => window.releaseFrames());
    }
    await measured(page);
    const measuredHeight = await history(page).evaluate((e) => e.scrollHeight);
    const beforeGrowth = await grow(page);
    await expect
      .poll(() => history(page).evaluate((e) => e.scrollHeight))
      .toBeGreaterThan(measuredHeight);
    await expectAnchor(page, beforeGrowth);
  });

  test("a drag released before a render that holds its row again ends the hold", async ({
    page,
    app,
  }) => {
    const pending = await reading(page, app, 1400);
    const box = await history(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const height = await history(page).evaluate((e) => e.scrollHeight);
    await holdFrames(page);
    try {
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await history(page).evaluate(
        (e) =>
          new Promise((resolve) => {
            e.addEventListener("scrollend", resolve, { once: true });
            e.scrollTop -= 300;
          }),
      );
      await page.mouse.up();
      // The timeline renders new rows before the page's rows measure, and
      // holds the reader's row again for them.
      app.append("primary", "alpha", undefined, true, false);
      await expect(latest(page)).toHaveText("1 new message");
    } finally {
      await page.evaluate(() => window.releaseFrames());
    }
    await measured(page);
    const before = await anchor(page);
    // The reader's row and the rows after it in view grow below their
    // paragraphs. A hold left on any of them would move the reader's row.
    await history(page).evaluate((e, id) => {
      const bottom = e.getBoundingClientRect().bottom;
      const rows = [...e.querySelectorAll("[data-message-id]")];
      for (const row of rows.slice(
        rows.findIndex((row) => row.dataset.messageId === id),
      )) {
        const paragraph = row.querySelector("p");
        if (paragraph.getBoundingClientRect().bottom > bottom) break;
        const extra = document.createElement("div");
        extra.style.height = "300px";
        paragraph.after(extra);
      }
    }, before.id);
    await settle(page);
    await expectAnchor(page, before);
  });

  test("a cancelled drag ends the hold", async ({ page, app }) => {
    const pending = await reading(page, app, 1400);
    const box = await history(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      const height = await history(page).evaluate((e) => e.scrollHeight);
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await settle(page);
      await history(page).evaluate(
        (e) =>
          new Promise((resolve) => {
            e.addEventListener("scrollend", resolve, { once: true });
            e.scrollTop -= 600;
          }),
      );
      // The browser takes the pointer, for a native drag or touch pan.
      await page.evaluate(() =>
        document.body.dispatchEvent(
          new PointerEvent("pointercancel", {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          }),
        ),
      );
      await settle(page);
      await grow(page);
    } finally {
      await page.mouse.up();
    }
  });

  // A live message sorted among loaded history by a sender clock.
  const publish = (app, second, ms) =>
    app.relay.publish(
      "primary",
      app.sign({
        kind: 9,
        created_at: second,
        tags: [
          ["h", "alpha"],
          ["ms", ms],
        ],
        content: "Delayed live message",
      }),
    );
  // At 0ms it sorts above the reader's rows, at 999ms below them.
  for (const ms of ["0", "999"])
    test(`a live message in the loaded first second at ${ms}ms is new`, async ({
      page,
      app,
    }) => {
      // Recreate the sparse same-second head from CI. The page fills gaps
      // below the reader without changing their initial item offset.
      const events = app.histories.get("primary/alpha");
      const second = events.at(-20).created_at;
      const sameSecond = events.filter((event) => event.created_at === second);
      for (const [index, event] of sameSecond.entries()) {
        let nonce = 0;
        let signed;
        do {
          signed = app.sign({
            ...event,
            tags: [...event.tags, ["fixture-order", String(nonce++)]],
          });
        } while (
          Number.parseInt(signed.id[0], 16) < 8 !==
          [0, 1, 2, 3, 12, 16, 18, 19, 25, 27].includes(index)
        );
        events[events.indexOf(event)] = signed;
      }
      const pending = await reading(page, app, 1550);
      const before = await anchor(page);
      publish(app, pending.filter.until, ms);
      await expect(latest(page)).toHaveText("1 new message");
      const height = await history(page).evaluate((e) => e.scrollHeight);
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await settle(page);
      await expectAnchor(page, before);
      await expect(latest(page)).toHaveText("1 new message");
    });

  test("a live message after a failed older load is new", async ({
    page,
    app,
  }) => {
    await open(page, app);
    app.relay.quotaNextOlder("alpha");
    // The failed load starts within the first pixels of upward scroll, so the
    // alert does not prove the reader left the bottom. upper() does.
    await upper(page);
    await expect(history(page).getByRole("alert")).toContainText(
      "rate-limited",
    );
    await settle(page);
    const { filter } = app.report.queries.find(
      ({ filter }) =>
        filter.until !== undefined && filter["#h"]?.includes("alpha"),
    );
    publish(app, filter.until, "999");
    await expect(latest(page)).toHaveText("1 new message");
  });
});

test("cancelled navigation keeps relay reads usable in the same document", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.evaluate(() => {
    window.addEventListener(
      "beforeunload",
      (event) => {
        event.preventDefault();
        event.returnValue = "";
      },
      { once: true },
    );
  });
  const sessions = app.report.sessions.length;
  const dialog = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => window.location.reload(), 0);
  });
  await (await dialog).dismiss();
  // This must be the same session, not a replacement that bypasses a stuck gate.
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect(history(page)).toContainText("primary beta message");
  expect(app.report.sessions).toHaveLength(sessions);
});
