import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { generateSecretKey } from "nostr-tools";
import { channelUnread } from "./unread-state.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  exactMessages: true,
  pluginFixtures: true,
  historyCounts: { alpha: 80, beta: 1 },
});

const activity = (kind, messageId) => ({
  kind,
  seq: 1,
  timestamp: new Date().toISOString(),
  channelId: "alpha",
  sessionId: "S",
  turnId: "focus-test",
  ...(messageId ? { payload: { triggeringEventIds: [messageId] } } : {}),
});

test("mark-read retains focus through a gated storage failure, working transitions, and last-item retry", async ({
  page,
  app,
}) => {
  await open(page, app);
  const row = page.locator('button[data-channel-id="alpha"]');
  const popup = page.getByRole("dialog", { name: "Activity in Alpha" });
  // The open channel's row is quiet; its activity popup still lists threads.
  await expect
    .poll(async () => (await channelUnread(page, "alpha")).threads)
    .toBeGreaterThan(0);
  await expect(row.getByRole("img", { name: /unread threads?/ })).toHaveCount(
    0,
  );
  await row.focus();
  const originalRow = await row.elementHandle();
  await row.press("Enter");
  await expect(popup).toBeVisible();
  const markRead = popup.getByRole("button", {
    name: /Mark thread from .+ as read/,
  });
  await expect(markRead).toHaveCount(1);
  await markRead.focus();
  const originalAction = await markRead.elementHandle();
  // Keep the real IndexedDB transaction alive until the test aborts it.
  const unreadRoot = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  await page.evaluate((rootId) => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      const request = put.call(this, value, ...args);
      const tx = this.transaction;
      // Background channel receipts also write this store. Gate the actual
      // thread mark, so aborting it exercises the action's recovery contract.
      if (
        tx.db.name === "buzz-read-state-v1" &&
        value?.state?.frontiers?.[`thread:${rootId}`]
      ) {
        IDBObjectStore.prototype.put = put;
        let held = true;
        const keepAlive = () => {
          if (held) this.get("focus-test-gate").onsuccess = keepAlive;
        };
        keepAlive();
        window.abortFocusWrite = () => {
          held = false;
          window.abortFocusWrite = undefined;
          tx.abort();
        };
      }
      return request;
    };
  }, unreadRoot.id);
  try {
    await markRead.press("Enter");
    await expect
      .poll(() => page.evaluate(() => !!window.abortFocusWrite))
      .toBe(true);
    await expect(markRead).toHaveAttribute("aria-disabled", "true");
    await expect(markRead).toBeFocused();
  } finally {
    await page.evaluate(() => window.abortFocusWrite?.());
  }
  await expect(popup.getByRole("alert")).toContainText("Try again");
  await expect(markRead).toBeFocused();

  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  app.observer(activity("turn_started"), key);
  await expect(
    row.getByRole("img", { name: /working in Alpha/ }),
  ).toBeVisible();
  await expect(popup.getByRole("alert")).toBeVisible();
  await expect(markRead).toBeFocused();
  app.observer(activity("turn_completed"), key);
  await expect(row.getByRole("img", { name: /working in Alpha/ })).toHaveCount(
    0,
  );
  await expect(popup.getByRole("alert")).toBeVisible();
  await expect(markRead).toBeFocused();
  expect(await originalAction.evaluate((node) => node.isConnected)).toBe(true);
  await markRead.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(await originalRow.evaluate((node) => node.isConnected)).toBe(true);
});

for (const destination of ["reply", "off-window root"]) {
  test(`working ${destination} returns focus to the originating sidebar row`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const target = destination === "reply" ? app.exact.target : app.exact.root;
    await expect(
      page.locator(`[data-channel-timeline] [data-message-id="${target.id}"]`),
    ).toHaveCount(0);
    const key = generateSecretKey();
    app.observer(activity("turn_started", target.id), key);
    const row = page.locator('button[data-channel-id="alpha"]');
    await expect(
      row.getByRole("img", { name: /working in Alpha/ }),
    ).toBeVisible();
    await row.focus();
    await row.press("Enter");
    const popup = page.getByRole("dialog", { name: "Activity in Alpha" });
    const action = popup.getByRole("button", { name: /Open thread for/ });
    await action.focus();
    await action.press("Enter");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(panel).toBeVisible();
    // A repeat activity intent must reveal its retained thread, including when
    // another tab is selected or the entire pane is collapsed.
    const workspace = page.locator("[data-panel-workspace]");
    for (const hiddenBy of ["settings", "collapsed"]) {
      await openChannelDetails(page);
      await expect(panel).toBeHidden();
      if (hiddenBy === "collapsed")
        await workspace
          .getByRole("button", { name: "Toggle tab pane", exact: true })
          .click();
      // This journey tests focus, not activity expiry. A slow runner can spend
      // most of the 30 s activity window above, and the popover only opens and
      // stays open while the turn is fresh. Renew it as a live agent would,
      // keeping the browser clock aligned with relay timestamps, and wait for
      // the badge that shares the popover's working-agent state before Enter.
      app.observer(activity("turn_liveness", target.id), key);
      await expect(
        row.getByRole("img", { name: /working in Alpha/ }),
      ).toBeVisible();
      await row.focus();
      await row.press("Enter");
      await expect(popup).toBeVisible();
      await popup.getByRole("button", { name: /Open thread for/ }).click();
      await expect(panel).toBeVisible();
      await expect(
        page.locator(
          '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
        ),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("tab", { name: "Channel settings", exact: true }),
      ).toHaveCount(1);
    }
    await page
      .getByRole("button", { name: "Close Channel settings tab", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "Channel settings", exact: true }),
    ).toHaveCount(0);
    const close = page.locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    );
    await close.focus();
    await close.press(destination === "reply" ? "Escape" : "Enter");
    await expect(panel).toHaveCount(0);
    await expect(row).toBeFocused();
  });
}
