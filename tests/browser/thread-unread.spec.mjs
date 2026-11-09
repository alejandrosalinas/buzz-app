import { pauseClock } from "./clock.mjs";
import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { clickRow, open, virtuaIdle } from "./timeline.mjs";
import {
  holdReadingFocus,
  readJournal,
  releaseReadingFocus,
} from "./reading.mjs";
import { openPage } from "./navigation.mjs";
import { channelUnread } from "./unread-state.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  // The viewer joined the peer's thread outside the loaded window, so its
  // replies count only after the membership lookup.
  threadUnreadJoined: true,
  historyCounts: { alpha: 20, beta: 1 },
  largeSidebar: true,
  pluginFixtures: true, // Observe the real navigation completion, not reply mount timing.
});
test.describe("mentioned reply priority", () => {
  test.use({ threadUnreadMentions: true });

  test("a mention and broadcast remain distinguishable in Activity", async ({
    page,
    app,
  }) => {
    await holdReadingFocus(page);
    await open(page, app);
    const alpha = page.locator('button[data-channel-id="alpha"]');
    // The open channel's row is quiet; its activity popover still lists threads.
    await expect
      .poll(async () => (await channelUnread(page, "alpha")).threads)
      .toBe(2);
    await alpha.hover();
    const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
    await expect(popover).toBeVisible();
    const items = popover.getByRole("button", {
      name: /Open unread thread from/,
    });
    await expect(items).toHaveCount(2);
    const names = await items.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("aria-label")),
    );

    expect(
      names.every((name) => name?.startsWith("Open unread thread from ")),
    ).toBe(true);
    // Each thread previews its latest relevant reply: the nested mention in
    // the broadcast thread, and the direct mention in the other.
    expect(new Set(names.map((name) => name?.split(": ").at(-1)))).toEqual(
      new Set(["Broadcast descendant", "Unread reply 1"]),
    );
  });

  test("opening an already-open thread from Activity reads it", async ({
    page,
    app,
  }) => {
    // Reading needs a 300ms dwell (use-reading.ts); hold the clock so the
    // thread cannot earn it while it opens.
    await page.clock.install();
    await holdReadingFocus(page);
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    const alpha = page.locator('button[data-channel-id="alpha"]');
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const unread = () =>
      page.evaluate(
        (rootId) =>
          window.fixtureRelay.snapshot().session.unread.snapshot({
            kind: "thread",
            channelId: "alpha",
            rootId,
          }),
        root.id,
      );
    await pauseClock(page, 1000);
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    await expect(panel).toBeVisible();
    // The reader is looking elsewhere: the open thread stays unread.
    await page.evaluate(() => document.activeElement?.blur());
    await page.clock.resume();
    expect((await unread()).observedCount).toBeGreaterThan(0);
    await alpha.hover();
    const item = page
      .getByRole("dialog", { name: "Activity in Alpha" })
      .getByRole("button", { name: /Open unread thread from/ })
      .filter({ hasText: "Unread reply 1" });
    await expect(item).toBeVisible();
    await releaseReadingFocus(page);
    const previousAttempt = await page.evaluate(
      () => window.fixtureNavigation.snapshot().attempt.id,
    );
    // Activity opens the thread that is already selected.
    await item.click();
    // The thread is already on screen, so its visibility proves nothing. Wait
    // for the click's own navigation, so a failure below means the thread was
    // opened and still not read, never that the click missed.
    await expect
      .poll(() =>
        page.evaluate((previous) => {
          const { status, attempt } = window.fixtureNavigation.snapshot();
          return { status, freshAttempt: attempt.id !== previous };
        }, previousAttempt),
      )
      .toEqual({ status: "opened", freshAttempt: true });
    try {
      await expect.poll(async () => (await unread()).observedCount).toBe(0);
    } catch (error) {
      // Reading needs focus inside the thread; say where it actually was.
      const focus = await page.evaluate(() => ({
        active:
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.tagName,
        inThread: !!document.activeElement?.closest("[data-reading-surface]"),
        windowFocused: document.hasFocus(),
      }));
      throw new Error(
        `The thread opened but stayed unread. Focus: ${JSON.stringify(focus)}`,
        { cause: error },
      );
    }
  });

  test("opening a thread from Activity reads it when its channel's pane was collapsed", async ({
    page,
    app,
  }) => {
    // Hold the clock so the thread cannot be read before Activity opens it.
    await page.clock.install();
    await holdReadingFocus(page);
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const unread = () =>
      page.evaluate(
        (rootId) =>
          window.fixtureRelay.snapshot().session.unread.snapshot({
            kind: "thread",
            channelId: "alpha",
            rootId,
          }),
        root.id,
      );
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    await expect(panel).toBeVisible();
    await page.clock.runFor(1000);
    // Collapse Alpha's pane around its selected thread, then leave the channel.
    await page
      .getByRole("button", { name: "Toggle tab pane", exact: true })
      .click();
    await page.locator("button[data-channel-id=beta]").click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    expect((await unread()).observedCount).toBeGreaterThan(0);
    await page.locator('button[data-channel-id="alpha"]').hover();
    const item = page
      .getByRole("dialog", { name: "Activity in Alpha" })
      .getByRole("button", { name: /Open unread thread from/ })
      .filter({ hasText: "Unread reply 1" });
    await expect(item).toBeVisible();
    await releaseReadingFocus(page);
    await item.click();
    await expect(panel).toBeVisible();
    await page.clock.runFor(1000);
    try {
      await expect.poll(async () => (await unread()).observedCount).toBe(0);
    } catch (error) {
      const focus = await page.evaluate(() => ({
        active:
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.tagName,
        inThread: !!document.activeElement?.closest("[data-reading-surface]"),
      }));
      throw new Error(
        `The thread opened but stayed unread. Focus: ${JSON.stringify(focus)}`,
        { cause: error },
      );
    }
  });

  test("opening a main-pane thread from Activity reads it, not the side-pane thread", async ({
    page,
    app,
  }) => {
    await page.clock.install();
    await holdReadingFocus(page);
    await open(page, app);
    const rows = app.histories.get("primary/alpha");
    const [x, t] = ["Thread root 1", "Thread root 0"].map((content) =>
      rows.find((row) => row.content === content),
    );
    for (const root of [x, t]) {
      await clickRow(
        page,
        page
          .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
          .getByRole("button", { name: /^View thread:/ }),
      );
      await expect(
        page.getByRole("complementary", { name: "Thread", exact: true }),
      ).toBeVisible();
    }
    const side = page.locator("[data-panel-workspace]");
    const main = page.locator("[data-main-workspace]");
    const tabs = (host) =>
      host.locator('[role="tab"][data-tab-value^="thread:"]');
    const unread = (rootId) =>
      page.evaluate(
        (rootId) =>
          window.fixtureRelay.snapshot().session.unread.snapshot({
            kind: "thread",
            channelId: "alpha",
            rootId,
          }).observedCount,
        rootId,
      );
    // Move X's tab (the first opened) to the main pane, leaving T in the side.
    const [id] = await tabs(side).evaluateAll((all) =>
      all.map((tab) => tab.dataset.tabValue),
    );
    const from = await page
      .locator(`[role="tab"][data-tab-value="${id}"]`)
      .boundingBox();
    const header = await main.locator("header").first().boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      header.x + header.width / 2,
      header.y + header.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect(tabs(main)).toHaveCount(1);
    await expect(tabs(side)).toHaveCount(1);
    await page.clock.runFor(1000);
    expect(await unread(x.id)).toBeGreaterThan(0);
    expect(await unread(t.id)).toBeGreaterThan(0);

    // Activity reopens X, already selected in the main pane.
    await page.locator('button[data-channel-id="alpha"]').hover();
    const item = page
      .getByRole("dialog", { name: "Activity in Alpha" })
      .getByRole("button", { name: /Open unread thread from/ })
      .filter({ hasText: "Unread reply 1" });
    await expect(item).toBeVisible();
    await releaseReadingFocus(page);
    await item.click();
    await expect(item).toBeHidden();
    await page.clock.runFor(1000);
    await expect.poll(() => unread(x.id)).toBe(0);
    expect(await unread(t.id)).toBeGreaterThan(0);
  });

  test("an Activity reopening leaves focus the person moved meanwhile", async ({
    page,
    app,
  }) => {
    // As above, hold the clock so the thread cannot be read while it opens.
    await page.clock.install();
    await holdReadingFocus(page);
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await pauseClock(page, 1000);
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    await expect(panel).toBeVisible();
    await page.evaluate(() => document.activeElement?.blur());
    await page.clock.resume();
    await page.locator('button[data-channel-id="alpha"]').hover();
    const item = page
      .getByRole("dialog", { name: "Activity in Alpha" })
      .getByRole("button", { name: /Open unread thread from/ })
      .filter({ hasText: "Unread reply 1" });
    await expect(item).toBeVisible();
    await releaseReadingFocus(page);
    const previousAttempt = await page.evaluate(
      () => window.fixtureNavigation.snapshot().attempt.id,
    );
    // Hold the reopening's reads so the person can move focus before the
    // thread receives its request.
    let held = false;
    let release;
    let sawRead;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const read = new Promise((resolve) => {
      sawRead = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      if (held) {
        sawRead();
        await gate;
      }
      await route.continue().catch(() => {});
    });
    held = true;
    try {
      await item.click();
      await read;
      await composer.click();
      await page.keyboard.type("Still typing");
    } finally {
      held = false;
      release();
    }
    await expect
      .poll(() =>
        page.evaluate((previous) => {
          const { status, attempt } = window.fixtureNavigation.snapshot();
          return { status, freshAttempt: attempt.id !== previous };
        }, previousAttempt),
      )
      .toEqual({ status: "opened", freshAttempt: true });
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText("Still typing");
  });

  test("search's Unread row opens the previewed thread reply with focus, and reading it updates the row", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const unread = () =>
      page.evaluate(() => {
        const { unread } = window.fixtureRelay.snapshot().session;
        return {
          count: unread.snapshot({ kind: "channel", channelId: "alpha" })
            .observedCount,
          items: unread.activity("alpha").items ?? [],
        };
      });
    // Reading the channel leaves Alpha unread only through its threads.
    await page
      .getByRole("textbox", { name: "Message #Alpha", exact: true })
      .focus();
    await expect
      .poll(async () => {
        const { count, items } = await unread();
        return (
          items.length === 2 &&
          items[0].unreadCount + items[1].unreadCount === count
        );
      })
      .toBe(true);
    await page.locator('button[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    const [newest, other] = (await unread()).items;
    const dialog = page.getByRole("dialog", { name: "Search Buzz" });
    const row = dialog
      .getByRole("group", { name: "Unread" })
      .getByRole("option")
      .filter({ hasText: /^Alpha/ });
    await page.keyboard.press("ControlOrMeta+k");
    await dialog.getByRole("combobox", { name: "Search Buzz" }).fill("");
    await expect(row).toContainText(`Alice Fixture: ${newest.preview}`);
    await expect(row).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(
      thread.locator(`[data-message-id="${newest.latestMessageId}"]`),
    ).toBeVisible();
    // The thread takes focus from search, so it reads without another gesture.
    await expect
      .poll(() =>
        page.evaluate(
          () => !!document.activeElement?.closest("[data-reading-surface]"),
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => (await unread()).items.map(({ rootId }) => rootId))
      .toEqual([other.rootId]);
    await page.locator('button[data-channel-id="beta"]').click();
    await page.keyboard.press("ControlOrMeta+k");
    await dialog.getByRole("combobox", { name: "Search Buzz" }).fill("");
    await expect(row).toContainText(`Alice Fixture: ${other.preview}`);
  });
});

test("thread buttons show observed unread independently, clear only after reading, and expose hover/focus affordance", async ({
  page,
  app,
}, testInfo) => {
  // Reading needs a 300ms dwell (use-reading.ts). An installed clock still
  // flows, so pause it wherever an open surface must not earn that dwell, and
  // run the deadline exactly where the test proves reading.
  await page.clock.install();
  await holdReadingFocus(page);
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const button = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const first = button(roots[0]);
  const other = button(roots[1]);
  const broadcast = button(
    app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Broadcast reply"),
  );
  const dot = (control) =>
    control.locator('span[title^="Observed unread replies"]');
  await expect(first).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(other).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(dot(first)).toBeVisible();
  await expect(dot(other)).toBeVisible();
  await expect(broadcast).toHaveAccessibleName(/Observed unread replies/);
  const alpha = page.locator('button[data-channel-id="alpha"]');
  const activity = alpha.getByRole("img", { name: /unread threads?/ });
  // The open channel's row is quiet while its threads stay unread.
  await expect
    .poll(async () => (await channelUnread(page, "alpha")).threads)
    .toBe(2);
  await expect(activity).toHaveCount(0);
  await expect(alpha.getByText("Alpha", { exact: true })).not.toHaveCSS(
    "font-weight",
    "600",
  );
  await openChannelDetails(page);
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", { name: "Mark unread on this device", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect(
    alpha.getByRole("img", { name: /Marked unread on this device only/ }),
  ).toBeAttached();
  // Marking it unread shows the whole row again, its threads included.
  await expect(activity).toHaveAccessibleName(/unread threads?/);
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await alpha.hover();
  const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
  await expect(popover).toBeVisible();
  await expect(
    popover.getByText("Activity in Alpha", { exact: true }),
  ).toHaveCount(0);
  await popover.screenshot({
    path: testInfo.outputPath("activity-popover.png"),
  });
  // The viewer's own thread and the peer thread the viewer joined. Channel
  // evidence never returns the viewer's displaced reply, so only the
  // conversation lookup can make the second thread count.
  await expect(
    popover.getByRole("button", { name: /Open unread thread from/ }),
  ).toHaveCount(2);
  expect(
    app.report.queries.some(
      ({ filter }) =>
        filter.authors?.[0] === app.viewer &&
        filter["#e"]?.includes(roots[1].id),
    ),
  ).toBe(true);
  const queries = () =>
    app.report.queries.filter(({ filter }) => filter.depth_limit);
  expect(queries()).toHaveLength(0); // Merely displaying buttons never fetches threads.
  // The sibling context trigger must not steal the activity button's props or
  // focus. Exercise the real portals while unread activity is still present.
  await alpha.click({ button: "right" });
  const actions = page.getByRole("menu", { name: "Actions for Alpha" });
  await expect(actions).toBeVisible();
  // Leave the hover trigger while the context menu still owns focus. Otherwise
  // its delayed hover close can overlap the later keyboard-open assertion.
  await page.mouse.move(0, 0);
  await expect(popover).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await alpha.press("Shift+F10");
  await expect(actions).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await expect(popover).toHaveCount(0);
  await expect(alpha).toHaveAttribute("aria-expanded", "false");
  await alpha.press("Enter");
  await expect(alpha).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  const item = popover
    .getByRole("button", {
      name: /Open unread thread from/,
    })
    .first();
  await item.focus();
  await expect(item).toBeFocused();
  // This open only proves the handoff. Its thread must stay unread, so a slow
  // close must not let the open panel earn reading dwell. Hold the clock before
  // releasing reading focus, without a sampled-time race during the round trip.
  await pauseClock(page, 1000);
  await releaseReadingFocus(page);
  await item.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  await expect(alpha).toBeFocused();
  await page.clock.resume();
  const beforeRect = await first.boundingBox();
  await first.hover();
  const afterRect = await first.boundingBox();
  expect(afterRect).not.toBeNull();
  expect(beforeRect).not.toBeNull();
  expect(afterRect.width).toBe(beforeRect.width);
  expect(afterRect.height).toBe(beforeRect.height);
  await expect(first).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const hover = await first.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, radius: s.borderTopLeftRadius };
  });
  expect(hover.border).toBe("0px");
  expect(hover.radius).not.toBe("0px");
  await first.screenshot({
    path: testInfo.outputPath("thread-button-hover.png"),
  });
  // WebKit's macOS tab policy skips buttons; keyboard input still selects
  // focus-visible modality, then focus the actual control in both engines.
  await page.keyboard.press("Tab");
  await first.focus();
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("outline-style", "solid");
  await expect(first).toHaveCSS("outline-width", "2px");
  await broadcast.focus();
  const previousAttempt = await page.evaluate(
    () => window.fixtureNavigation.snapshot().attempt.id,
  );
  await broadcast.press("Enter");
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = panel.getByRole("region", { name: "Thread messages" });
  await expect(
    panel.getByText("Unread reply 0", { exact: true }),
  ).toBeVisible();
  // Content visibility precedes the navigation's deferred reveal/focus. Finish
  // that owner before testing composer-only dwell; faster reads expose the race.
  await expect
    .poll(() =>
      page.evaluate((previous) => {
        const { status, entry, attempt } = window.fixtureNavigation.snapshot();
        return {
          status,
          messageId: entry.target.messageId,
          freshAttempt: attempt.id !== previous,
        };
      }, previousAttempt),
    )
    .toEqual({
      status: "opened",
      freshAttempt: true,
      messageId: app.histories
        .get("primary/alpha")
        .find((row) => row.content === "Broadcast reply").id,
    });
  const replyComposer = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  // Own-composer dwell acknowledges the visible reply without list focus;
  // the collapsed descendant and sibling thread remain independent.
  const directId = await panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" })
    .getAttribute("data-message-id");
  await replyComposer.focus();
  await page.clock.runFor(300);
  await expect(replyComposer).toBeFocused();
  // The isolated message read is durable on this device and never published.
  await expect
    .poll(
      async () =>
        Object.hasOwn(
          (await readJournal(page)).state.frontiers,
          `msg:${directId}`,
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  expect(
    app.report.readPublications.some(({ blob }) =>
      Object.hasOwn(blob.contexts, `msg:${directId}`),
    ),
  ).toBe(false);
  await expect(replyComposer).toBeFocused();
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toHaveCount(0);
  await expect(first).toHaveAccessibleName(/Observed unread replies/);
  await panel.getByRole("button", { name: /^View 1 reply/ }).click();
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toBeInViewport();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(broadcast).toHaveAccessibleName("View thread: 23 replies");
  await expect(dot(first)).toHaveCount(0);
  await expect(dot(other)).toBeVisible();
  await expect(other).toHaveAccessibleName(/Observed unread replies/); // No channel-wide shortcut.
  // The close transition owns channel width; unread receipt does not mean its
  // resulting Virtua remeasurement and native scrolling have finished.
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(
    page.locator('[data-panel-dock][data-closing="true"]'),
  ).toHaveCount(0);
  const own = app.reply(roots[0].id, true);
  // Barrier: the session has indexed the reply, so its unread effect is final.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("alpha", id),
        own.id,
      ),
    )
    .toMatchObject({ status: "ineligible", unread: false });
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  app.reply(roots[0].id);
  await expect(first).toHaveAccessibleName(/Observed unread replies/);
  await virtuaIdle(page);
  // Remeasurement while geometry settles may start another native scroll.
  await expect(page.locator("[data-channel-timeline] ol")).toHaveCSS(
    "pointer-events",
    "auto",
  );
  const reopenAttempt = await page.evaluate(
    () => window.fixtureNavigation.snapshot().attempt.id,
  );
  await first.click();
  await expect
    .poll(() =>
      page.evaluate((before) => {
        const { status, entry, attempt } = window.fixtureNavigation.snapshot();
        return {
          status,
          freshAttempt: attempt.id !== before,
          messageId: entry.target.messageId,
        };
      }, reopenAttempt),
    )
    .toEqual({ status: "opened", freshAttempt: true, messageId: roots[0].id });
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  const savedEntry = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry,
  );
  const beforeReload = app.report.queries.length;
  await page.reload();
  // Reload restores this visit itself. Reopening Messages through Search races
  // startup results and could hide a broken restoration by starting a new visit.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const snapshot = window.fixtureNavigation?.snapshot();
        return snapshot && { status: snapshot.status, entry: snapshot.entry };
      }),
    )
    .toEqual({ status: "opened", entry: savedEntry });
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  // Restoring a joined conversation waits for initial membership discovery;
  // it must not publish an early one-channel roster through exact resolution.
  expect(
    app.report.queries
      .slice(beforeReload)
      .filter(
        ({ filter }) =>
          filter.kinds?.includes(39002) && filter["#d"]?.includes("alpha"),
      ),
  ).toEqual([]);
});

// Browser focus plus actual controller/React wiring: a same-target open must not
// leave the timeline's trigger installed merely because the history entry is reused.
test("same-thread sidebar activity replaces timeline focus return", async ({
  page,
  app,
}) => {
  await holdReadingFocus(page);
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const alpha = page.locator('button[data-channel-id="alpha"]');
  // The open channel's row is quiet; its activity popover still lists threads.
  await expect
    .poll(async () => (await channelUnread(page, "alpha")).threads)
    .toBeGreaterThan(0);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit)
    ) {
      requested = true;
      await held;
    }
    await route.continue().catch(() => {});
  });
  try {
    const trigger = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    await virtuaIdle(page);
    await releaseReadingFocus(page);
    await trigger.click();
    await expect.poll(() => requested).toBe(true);
    const before = await page.evaluate(() => {
      const { entry, attempt } = window.fixtureNavigation.snapshot();
      return { entry: entry.id, attempt: attempt.id };
    });
    await alpha.hover();
    const activity = page.getByRole("dialog", { name: "Activity in Alpha" });
    await activity
      .getByRole("button", {
        name: /Open unread thread from.*Broadcast descendant/,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate((before) => {
          const { entry, attempt } = window.fixtureNavigation.snapshot();
          return {
            sameEntry: entry.id === before.entry,
            freshAttempt: attempt.id !== before.attempt,
          };
        }, before),
      )
      .toEqual({ sameEntry: true, freshAttempt: true });
    release();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
      )
      .click();
    await expect(alpha).toBeFocused();
  } finally {
    release();
  }
});

// Browser-only contract: fitting rows generate no scroll/resize when an empty
// legacy continuation finishes. Opening alone must still earn reading dwell.
test("opening a fitting thread reads after unchanged-row continuation without another gesture", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  const button = page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await expect(button).toHaveAccessibleName(/Observed unread replies/);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let continuation = false;
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) =>
          filter.depth_limit &&
          filter["#e"]?.[0] === root.id &&
          filter.thread_cursor !== undefined,
      )
    ) {
      continuation = true;
      await gate;
    }
    await route.continue();
  });
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = panel.getByRole("region", { name: "Thread messages" });
  try {
    await button.click();
    await expect.poll(() => continuation).toBe(true);
    await expect(
      panel.getByText("Unread reply 1", { exact: true }),
    ).toBeInViewport();
    await expect(
      panel.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeFocused();
    expect(
      await history.evaluate(
        (element) => element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
    await page.clock.runFor(300);
    await expect(button).toHaveAccessibleName(/Observed unread replies/);
  } finally {
    release();
  }
  await expect(button).not.toHaveAccessibleName(/Observed unread replies/);
  // An explicit retarget of the still-open panel also transfers reading focus.
  const otherRoot = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const other = page
    .locator(`[data-channel-timeline] [data-message-id="${otherRoot.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await other.click();
  await expect(panel).toHaveCount(1);
  await expect(
    panel.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeFocused();
  const reply = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" });
  await expect(reply).toBeInViewport();
  const id = await reply.getAttribute("data-message-id");
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("alpha", id)
            .unread,
        id,
      ),
    )
    .toBe(false);
});

test("channel bottom quiets ordinary replies newer than the latest top-level message without reading their threads", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = page.locator('button[data-channel-id="alpha"]');
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  const button = page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await expect(button).toHaveAccessibleName(/Observed unread replies/);
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .focus();
  await expect(alpha.getByText("Alpha", { exact: true })).toHaveCSS(
    "font-weight",
    "400",
  );
  await expect(button).toHaveAccessibleName(/Observed unread replies/);
});

// Real tab restoration and browser focus must hand an explicit channel visit
// to its already-visible thread; a mounted panel alone is not reading evidence.
for (const { paneOpen, width } of [
  { paneOpen: true, width: 1440 },
  { paneOpen: true, width: 1280 },
  { paneOpen: false, width: 1440 },
])
  test(`returning to a channel ${paneOpen ? "reads it and its already-open thread" : "leaves its hidden thread unread"} at ${width}px`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.clock.install();
    await holdReadingFocus(page);
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    const alpha = page.locator("button[data-channel-id=alpha]");
    const beta = page.locator("button[data-channel-id=beta]");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const otherRoot = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    const observed = (target) =>
      page.evaluate(
        (target) =>
          window.fixtureRelay.snapshot().session.unread.snapshot(target)
            .observedCount,
        target,
      );
    const unread = (rootId = root.id) =>
      observed({ kind: "thread", channelId: "alpha", rootId });
    // The neighboring thread is never opened, so once the channel is read its
    // replies are all that remains unread there.
    const unreadBeyondNeighbor = async () =>
      (await observed({ kind: "channel", channelId: "alpha" })) -
      (await unread(otherRoot.id));
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    await expect(
      panel.getByText("Unread reply 1", { exact: true }),
    ).toBeInViewport();
    // Setup must stay unread even when opening and switching channels is slow.
    await page.clock.runFor(1000);
    if (!paneOpen)
      await page
        .getByRole("button", { name: "Toggle tab pane", exact: true })
        .click();
    await beta.click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    expect(await unread()).toBeGreaterThan(0);
    expect(await unreadBeyondNeighbor()).toBeGreaterThan(0);
    await releaseReadingFocus(page);
    await alpha.click();
    if (!paneOpen) {
      await expect(panel).toBeHidden();
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeFocused();
      await page.clock.runFor(1000);
      expect(await unread()).toBeGreaterThan(0);
      return;
    }
    await expect(
      panel.getByText("Unread reply 1", { exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeFocused();
    await expect.poll(() => unread()).toBe(0);
    // The channel's own conversation is read too.
    await expect.poll(unreadBeyondNeighbor).toBe(0);
    // The other thread was never opened and remains unread.
    await expect(
      page
        .locator(`[data-channel-timeline] [data-message-id="${otherRoot.id}"]`)
        .getByRole("button", { name: /^View thread:/ }),
    ).toHaveAccessibleName(/Observed unread replies/);
  });

// A link to a message reads only the conversation it focuses: the channel's
// already-open thread stays unread until the person goes there.
test("opening a message link reads the channel but not its already-open thread", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await holdReadingFocus(page);
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const root = history.find((row) => row.content === "Thread root 1");
  // An ordinary message, not the open thread's root: a link to the root can
  // open its thread instead, which then takes focus and reads it.
  const message = history.findLast((row) =>
    row.content.startsWith("primary alpha message"),
  );
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const observed = (target) =>
    page.evaluate(
      (target) =>
        window.fixtureRelay.snapshot().session.unread.snapshot(target)
          .observedCount,
      target,
    );
  const unread = () =>
    observed({ kind: "thread", channelId: "alpha", rootId: root.id });
  const channel = () => observed({ kind: "channel", channelId: "alpha" });
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  await expect(
    panel.getByText("Unread reply 1", { exact: true }),
  ).toBeInViewport();
  // Setup must stay unread even when opening and switching channels is slow.
  await page.clock.runFor(1000);
  await page.locator("button[data-channel-id=beta]").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  const before = await channel();
  expect(await unread()).toBeGreaterThan(0);
  await releaseReadingFocus(page);
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    channelId: "alpha",
    messageId: message.id,
    scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
  });
  await expect(
    page.locator(`[data-channel-timeline] [data-message-id="${message.id}"]`),
  ).toBeInViewport();
  await expect(
    panel.getByText("Unread reply 1", { exact: true }),
  ).toBeInViewport();
  // The channel earned its dwell; the thread had the same chance.
  await expect.poll(channel).toBeLessThan(before);
  await page.clock.runFor(1000);
  expect(await unread()).toBeGreaterThan(0);
});

// A thread in the main pane is read only by focus in its own surface: a plain
// visit's workspace-wide grant belongs to the side pane's selected thread, so a
// live reply in main-pane X must stay unread while focus rests in side-pane T.
test("a live reply in a main-pane thread stays unread while focus is in the side-pane thread", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await holdReadingFocus(page);
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  for (const root of roots.slice(0, 2)) {
    await clickRow(
      page,
      page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ }),
    );
    await expect(
      page.getByRole("complementary", { name: "Thread", exact: true }),
    ).toBeVisible();
  }
  const x = roots[1];
  const side = page.locator("[data-panel-workspace]");
  const main = page.locator("[data-main-workspace]");
  const tabs = (host) =>
    host.locator('[role="tab"][data-tab-value^="thread:"]');
  const unread = (rootId) =>
    page.evaluate(
      (rootId) =>
        window.fixtureRelay.snapshot().session.unread.snapshot({
          kind: "thread",
          channelId: "alpha",
          rootId,
        }).observedCount,
      rootId,
    );
  // Move X's tab (the second opened) to the main pane, leaving T in the side.
  const ids = await tabs(side).evaluateAll((all) =>
    all.map((tab) => tab.dataset.tabValue),
  );
  const moving = page.locator(`[role="tab"][data-tab-value="${ids[1]}"]`);
  const from = await moving.boundingBox();
  const header = await main.locator("header").first().boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    header.x + header.width / 2,
    header.y + header.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(tabs(main)).toHaveCount(1);
  await expect(tabs(side)).toHaveCount(1);
  await page.clock.runFor(1000);
  expect(await unread(x.id)).toBeGreaterThan(0);

  // Leave and return by a plain sidebar click.
  await page.locator("button[data-channel-id=beta]").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await releaseReadingFocus(page);
  await page.locator("button[data-channel-id=alpha]").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();

  // Select X (reading its own selected tab is legitimate), then park focus in
  // T's composer.
  await tabs(main).click();
  await expect.poll(() => unread(x.id)).toBe(0);
  await side
    .getByRole("textbox", { name: "Reply to thread", exact: true })
    .focus();
  app.reply(x.id);
  await expect(main.getByText("New peer reply", { exact: true })).toBeVisible();
  await expect.poll(() => unread(x.id)).toBeGreaterThan(0);
  await page.clock.runFor(1000);
  expect(await unread(x.id)).toBeGreaterThan(0);
});

test.describe("top-level mention activity", () => {
  test.use({ historyCounts: { alpha: 20, beta: 0 } });

  // Browser-only: hover opening, the exact opening in the timeline and the
  // visibility read depend on real layout and focus.
  test("a mention-only row opens Activity, and opening its mention reads it", async ({
    page,
    app,
  }) => {
    await open(page, app);
    // Load Beta's window first: an exact opening that arrives while the window
    // is still settling opens the message as its own tab instead.
    const beta = page.locator('button[data-channel-id="beta"]');
    await beta.click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await page.locator('button[data-channel-id="alpha"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    const mention = app.append(
      "primary",
      "beta",
      "Can you sign off on Beta?",
      true,
      false,
      undefined,
      undefined,
      [["p", app.viewer]],
    );
    await openPage(page, "Activity");
    const inbox = page.getByRole("region", { name: "Activity", exact: true });
    const row = inbox
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name: / in #Beta$/ }) });
    await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
    await openPage(page, "Messages");
    // A mention alone keeps the priority dot.
    await expect(beta.locator("[data-channel-priority]")).toBeVisible();
    await expect(beta.locator("[data-channel-activity]")).toHaveCount(0);
    await beta.hover();
    const popover = page.getByRole("dialog", { name: "Activity in Beta" });
    const item = popover
      .getByRole("region", { name: "Mentions" })
      .getByRole("button", {
        name: /^Open unread mention from .+: Can you sign off on Beta\?$/,
      });
    await expect(item).toBeVisible();
    await expect(
      popover.getByRole("region", { name: "Unread threads" }),
    ).toHaveCount(0);
    await item.click();
    const message = page.locator(
      `[data-channel-timeline] [data-message-id="${mention.id}"]`,
    );
    await expect(message).toBeInViewport();
    await expect(message).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.fixtureRelay.snapshot().session.unread.attention("beta", id)
              .unread,
          mention.id,
        ),
      )
      .toBe(false);
    await openPage(page, "Activity");
    await expect(row).toBeVisible();
    await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  });

  // Browser-only: the reveal's fractional scroll position and the visibility
  // read depend on real layout.
  test("opening a mention above the bottom from Activity reads it there", async ({
    page,
    app,
  }) => {
    await open(page, app);
    // Leave Alpha, its window loaded, so its new messages arrive unseen.
    await page.locator('button[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    const mention = app.append(
      "primary",
      "alpha",
      "Can you sign off on Alpha?",
      true,
      false,
      undefined,
      undefined,
      [["p", app.viewer]],
    );
    // Enough later messages that revealing the mention cannot reach the
    // bottom, whose catch-up would read it anyway.
    for (let index = 0; index < 40; index++)
      app.append("primary", "alpha", `Later update ${index}`, true, false);
    await openPage(page, "Activity");
    const row = page
      .getByRole("region", { name: "Activity", exact: true })
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "Can you sign off on Alpha?" });
    await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
    await openPage(page, "Messages");
    const alpha = page.locator('button[data-channel-id="alpha"]');
    await alpha.hover();
    const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
    const mentions = popover.getByRole("region", { name: "Mentions" });
    await mentions
      .getByRole("button", {
        name: /^Open unread mention from .+: Can you sign off on Alpha\?$/,
      })
      .click();
    const message = page.locator(
      `[data-channel-timeline] [data-message-id="${mention.id}"]`,
    );
    await expect(message).toBeInViewport();
    await expect(message).toBeFocused();
    expect(
      await page
        .getByRole("region", { name: "Channel message history" })
        .evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      "the reveal stops above the bottom",
    ).toBeGreaterThan(1);
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.fixtureRelay.snapshot().session.unread.attention("alpha", id)
              .unread,
          mention.id,
        ),
      )
      .toBe(false);
    // Alpha's unread threads keep Activity open; the mention has left it.
    await alpha.hover();
    await expect(
      popover.getByRole("region", { name: "Unread threads" }),
    ).toBeVisible();
    await expect(mentions).toHaveCount(0);
    await openPage(page, "Activity");
    await expect(row).toBeVisible();
    await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  });
});
