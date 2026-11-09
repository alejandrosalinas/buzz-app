import { setPluginEnabled } from "./plugin-settings.mjs";
import {
  closeSettings,
  openPage,
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { frames, hoverRow, open, virtuaIdle } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  // Keep the viewer's profile off the startup path: the test holds it until
  // the viewer's linked message is focused.
  threadUnreadOwnedRoot: false,
  pluginFixtures: true,
  historyCounts: { alpha: 640, beta: 1 },
});
const button = (page, name) => page.getByRole("button", { name, exact: true });
const state = (page) =>
  page.evaluate(() => window.fixtureNavigation.snapshot());

test("Buzz channel and message links render, reveal verified targets, and preserve navigation history", async ({
  page,
  app,
}) => {
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Broadcast reply");
  // The linked author stays unnamed until the link is focused, too.
  app.relay.holdProfiles([app.viewer, target.pubkey]);
  await open(page, app);
  const libraryReads = () =>
    app.report.brokerRequests.filter(({ url }) =>
      url.endsWith("/agent-library"),
    ).length;
  // Owner inventory survives the startup roster; previews add no further read.
  await expect.poll(libraryReads).toBe(1);
  const href = `buzz://message?channel=alpha&id=${target.id}`;
  const message = app.append(
    "primary",
    "alpha",
    `Open <${href}> or <buzz://channel/beta>.`,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  // A message link names its channel until its author has a name.
  const unnamed = row.getByRole("link", { name: "Alpha", exact: true });
  await expect(unnamed).toBeVisible();
  await expect(
    row.getByRole("link", { name: "#Beta", exact: true }),
  ).toBeVisible();
  await expect(row).not.toContainText("<buzz:");
  const link = row.getByRole("link", {
    name: "Alice Fixture in #Alpha",
    exact: true,
  });
  await expect(unnamed).toHaveCSS("text-decoration-line", "underline");
  // Received-bubble links use the message-specific accent role.
  await expect(unnamed).toHaveCSS(
    "color",
    await unnamed.evaluate((node) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-message-link)";
      node.parentElement?.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }),
  );
  // Release the held profiles while the link is focused, before the navigation
  // below: profile reads give up after 10s, and a loaded engine can spend that
  // long on navigation, leaving nothing pending to release.
  const preview = page.getByLabel("Message preview", { exact: true });
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await row.getByRole("link", { name: "#Beta", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  // WebKit follows macOS's tab-to-links preference; retain keyboard modality
  // while focusing the specific trigger under test.
  await unnamed.focus();
  await expect(unnamed).toBeFocused();
  expect(
    await unnamed.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  const focusedTrigger = await unnamed.elementHandle();
  app.relay.releaseProfiles();
  await expect(
    row.getByRole("button", {
      name: "View Fixture Reader profile",
      exact: true,
    }),
  ).toBeVisible();
  // Naming the author relabels the focused anchor in place.
  await expect(link).toBeFocused();
  expect(await focusedTrigger.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect(preview).toBeVisible();
  expect(libraryReads()).toBe(1);
  await link.press("Tab");
  await expect(preview).toBeFocused();
  await preview.press("Enter");
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(link).toBeFocused();
  // Closing the thread widens the timeline. Its rows re-measure, and the
  // scroller compensates over several scroll events, longer on a slow runner.
  // Virtua holds the list's pointer events off for 150ms after each one, so a
  // still pointer leaves the link and nothing re-enters it. Let late size
  // updates reach Virtua, then wait for the link's centre to hit-test before
  // one raw move: locator.hover() can scroll again during a retry.
  await virtuaIdle(page);
  await frames(page);
  await virtuaIdle(page);
  await hoverRow(page, link);
  await expect(
    preview.getByText("Broadcast reply", { exact: true }),
  ).toBeVisible();
  await expect(preview).toHaveClass(/buzz-preview-card/);
  await expect(preview.getByRole("img")).toHaveClass(/buzz-avatar/);
  await expect(preview).toHaveCSS("font-size", "14px");
  await expect(preview.locator("strong")).not.toBeEmpty();
  await expect(preview.locator("time")).toHaveAttribute(
    "datetime",
    new Date(target.created_at * 1000).toISOString(),
  );
  await expect(preview).toHaveRole("link");
  await expect(preview).toHaveAttribute("href", href);
  // Crossing the trigger-to-card gap must keep the destination clickable.
  await preview.hover();
  await expect(preview).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("buzz-link-preview.png"),
  });
  await preview.click();
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.messageId).toBe(target.id);
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(panel).toHaveCount(0);
  await button(page, "Go back").click();
  // X retires this thread's visits; Back skips them. Passive restoration was
  // exercised above, before explicit dismissal.
  await expect(panel).toHaveCount(0);
  await expect(button(page, "Go forward")).toBeEnabled();
  await button(page, "Go forward").click();
  await expect(panel).toHaveCount(0);
  expect(libraryReads()).toBe(1);
  await row.getByRole("link", { name: "#Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
});

test("activating a panel from a linked thread retires the navigation-owned thread instead of splitting the rail", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Broadcast reply");
  const href = `buzz://message?channel=alpha&id=${target.id}`;
  const message = app.append("primary", "alpha", `Open <${href}>.`);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const link = row.getByRole("link", {
    name: "Alice Fixture in #Alpha",
    exact: true,
  });
  await expect(link).toBeVisible();
  // Virtua holds the list's pointer events off for 150ms after every scroll
  // event, and a late scroll can land after the timeline looks settled. A click
  // whose release falls in that hold reaches the scroller, not the link, and
  // Playwright's retries scroll the list again. This test is about activation,
  // not hit testing: activate by keyboard, which no scroll can intercept.
  await link.focus();
  await expect(link).toBeFocused();
  await link.press("Enter");
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  // Open a panel while the linked thread is showing. Navigation still owns the
  // thread target, so it must be retired rather than share the rail slot with
  // the newly activated panel. (The fixture registers a catch-all panel.)
  await row
    .getByRole("button", { name: "View Fixture Reader profile", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Wrong panel", exact: true }),
  ).toBeVisible();
  await expect(thread).toHaveCount(0);
  // Exactly the sidebar plus one panel: the thread does not survive alongside it.
  await expect(page.getByRole("complementary")).toHaveCount(2);
});

// The context menu shares its trigger with the hover preview and the page's
// tab owner; that composition needs the real page in a browser.
test("a message link's context menu opens its thread as a tab without leaving the channel", async ({
  page,
  app,
}) => {
  await open(page, app);
  const [target] = app.histories.get("primary/beta");
  const href = `buzz://message?channel=beta&id=${target.id}`;
  const message = app.append("primary", "alpha", `Open <${href}>.`);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const link = row.getByRole("link", {
    name: "Alice Fixture in #Beta",
    exact: true,
  });
  await expect(link).toBeVisible();
  await virtuaIdle(page);
  const before = (await state(page)).entry;
  // A right-click that meets Virtua's 150ms pointer-event hold is intercepted by
  // the scroller; Playwright's retry scrolls the list, restarting the hold, and
  // the contextmenu event can then reach the scroller instead of the link. This
  // test is about the link's composed context-menu owner, not hit testing: open
  // it by keyboard, which no scroll can intercept.
  await link.focus();
  await expect(link).toBeFocused();
  await link.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Open link",
    "Copy link",
  ]);
  await expect(
    page.getByLabel("Message preview", { exact: true }),
  ).toBeHidden();
  await menu.getByRole("menuitem", { name: "Open link", exact: true }).click();
  await expect(menu).toHaveCount(0);
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${target.id}"]`),
  ).toBeVisible();
  await expect(
    page
      .getByRole("tablist", { name: "Panel tabs" })
      .locator('[role="tab"][data-tab-value^="thread:beta:"]'),
  ).toHaveAttribute("aria-selected", "true");
  // The tab opens in this channel's workspace; nothing navigates.
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect((await state(page)).entry).toEqual(before);
  // Closing the tab returns focus to the link that opened it.
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:beta:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(thread).toHaveCount(0);
  await expect(link).toBeFocused();
});

// Browser-only: real scroll events and real layout under a still pointer.
test("a hovered message preview survives scroll anchoring and closes when its link scrolls away", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Broadcast reply");
  const message = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${target.id}>.`,
  );
  const link = page
    .locator(`[data-channel-timeline] [data-message-id="${message.id}"]`)
    .getByRole("link", { name: "Alice Fixture in #Alpha", exact: true });
  await expect(link).toBeInViewport();
  await virtuaIdle(page);
  const preview = page.getByLabel("Message preview", { exact: true });
  await hoverRow(page, link);
  await expect(
    preview.getByText("Broadcast reply", { exact: true }),
  ).toBeVisible();
  const scroller = page.locator('[data-channel-timeline="alpha"]');
  // Each change ends with its real scroll event and the next frame.
  const scroll = (change) =>
    scroller.evaluate(
      (element, change) =>
        new Promise((resolve) => {
          element.addEventListener(
            "scroll",
            () => requestAnimationFrame(resolve),
            { once: true },
          );
          if (change === "anchor") {
            // Content above the link grows and the scroller compensates, as
            // when rows are re-measured after the thread pane closes.
            element.style.paddingTop = "40px";
            element.scrollTop += 40;
          } else element.scrollTop -= 40;
        }),
      change,
    );
  // Record any dismissal: a browser can reopen the preview from its own
  // pointer update after the scroll, which would hide a close here.
  const closed = await preview.evaluateHandle((popup) => {
    const seen = { closed: false };
    new MutationObserver(() => {
      if (!popup.isConnected || !popup.hasAttribute("data-open"))
        seen.closed = true;
    }).observe(popup, { attributes: true });
    return seen;
  });
  const before = await link.boundingBox();
  await scroll("anchor");
  expect(await link.boundingBox()).toEqual(before);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  expect(await closed.evaluate(({ closed }) => closed)).toBe(false);
  await expect(preview).toHaveAttribute("data-open", "");
  // A still pointer cannot report that its link scrolled away from it.
  await scroll("away");
  await expect(preview).toHaveCount(0);
});

// Browser-only: real hit-testing and boundary events under a still pointer.
test("a hovered message preview survives the timeline's scroll-time pointer-events and closes when the pointer leaves", async ({
  page,
  app,
}) => {
  await open(page, app);
  const target = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Broadcast reply");
  const message = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${target.id}>.`,
  );
  const link = page
    .locator(`[data-channel-timeline] [data-message-id="${message.id}"]`)
    .getByRole("link", { name: "Alice Fixture in #Alpha", exact: true });
  await expect(link).toBeInViewport();
  await virtuaIdle(page);
  const preview = page.getByLabel("Message preview", { exact: true });
  await hoverRow(page, link);
  await expect(
    preview.getByText("Broadcast reply", { exact: true }),
  ).toBeVisible();
  // Opening the preview can re-measure rows and scroll the list. WebKit can
  // then take the link out of its hover state although the pointer stays on
  // it, and the probe below would wait for a mouseleave that cannot happen.
  // After the list settles, move onto the link again (1px aside, as WebKit
  // can ignore a move to the unchanged position) and prove it is hovered.
  await virtuaIdle(page);
  const box = await link.boundingBox();
  const point = { x: box.x + box.width / 2 - 1, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await expect
    .poll(() => link.evaluate((element) => element.matches(":hover")))
    .toBe(true);
  const closed = await preview.evaluateHandle((popup) => {
    const seen = { closed: false };
    new MutationObserver(() => {
      if (!popup.isConnected || !popup.hasAttribute("data-open"))
        seen.closed = true;
    }).observe(popup, { attributes: true });
    return seen;
  });
  // Virtua stops the list hit-testing until 150ms after each scroll. When
  // the browser hit-tests the still pointer in that time, as WebKit does
  // after a scroll, it reports a mouseleave from the link. A 1px move that
  // stays on the link makes that hit-test happen now.
  const list = page.locator('[data-channel-timeline="alpha"] ol');
  const hitTest = async (pointerEvents) => {
    await list.evaluate((element, value) => {
      element.style.pointerEvents = value;
    }, pointerEvents);
    point.x += pointerEvents ? 1 : -1;
    await page.mouse.move(point.x, point.y);
  };
  // Listen at the document so a re-rendered link is still heard.
  const boundary = await page.evaluateHandle((id) => {
    const seen = { closeDelayEnded: false, enter: false };
    const isLink = (target) =>
      target instanceof Element &&
      target.matches(`[data-message-id="${id}"] a`);
    document.addEventListener(
      "mouseleave",
      ({ target }) => {
        if (!isLink(target)) return;
        // Added now, this listener runs after the preview's own one on the
        // link. Its timer starts after the preview's 150ms close delay and,
        // being no shorter, fires after it.
        target.addEventListener(
          "mouseleave",
          () => {
            setTimeout(() => {
              seen.closeDelayEnded = true;
            }, 150);
          },
          { once: true },
        );
      },
      true,
    );
    document.addEventListener(
      "mouseenter",
      ({ target }) => {
        if (isLink(target)) seen.enter = true;
      },
      true,
    );
    return seen;
  }, message.id);
  const saw = (key) =>
    boundary.evaluate(
      (seen, { key, id, point }) => {
        const link = document.querySelector(`[data-message-id="${id}"] a`);
        const hit = document.elementFromPoint(point.x, point.y);
        return {
          [key]: seen[key],
          hit: hit && `${hit.tagName}.${hit.className}`,
          onLink: !!link?.contains(hit),
          list: getComputedStyle(link?.closest("ol") ?? document.body)
            .pointerEvents,
        };
      },
      { key, id: message.id, point },
    );
  await hitTest("none");
  await expect
    .poll(() => saw("closeDelayEnded"))
    .toMatchObject({ closeDelayEnded: true });
  await hitTest("");
  await expect.poll(() => saw("enter")).toMatchObject({ enter: true });
  expect(await closed.evaluate(({ closed }) => closed)).toBe(false);
  await expect(preview).toHaveAttribute("data-open", "");
  // The link cannot hear a real leave while the list ignores the pointer.
  await hitTest("none");
  // Leave sideways: the preview sits above the message.
  await page.mouse.move(box.x - 200, point.y, { steps: 4 });
  await expect(preview).toHaveCount(0);
});

// Retained DOM, scroll geometry, focus, and CSS motion need a real browser.
test("thread and detail tabs preserve drafts, scroll, focus and local-detail lifetime", async ({
  page,
  app,
}) => {
  await open(page, app);
  const target = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Broadcast reply");
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    channelId: "alpha",
    messageId: target.id,
    threadRootId: target.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "root",
    )?.[1],
    scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
  });
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  const history = thread.getByRole("region", { name: "Thread messages" });
  const editor = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await editor.fill("Keep this thread draft");
  const trigger = thread
    .getByRole("button", { name: /^View .+ profile$/ })
    .first();
  await trigger.scrollIntoViewIfNeeded();
  const originalHistory = await history.elementHandle();
  const top = await history.evaluate((el) => el.scrollTop);
  await trigger.click();
  const dock = page.locator("[data-panel-dock]");
  const tablist = page.getByRole("tablist", { name: "Panel tabs" });
  const threadTab = tablist.locator('[role="tab"][data-tab-value^="thread:"]');
  const details = tablist.getByRole("tab", {
    name: "Wrong panel",
    exact: true,
  });
  await expect(threadTab).toHaveClass(/navigation-item/);
  await expect(threadTab.locator("svg")).toHaveCount(1);
  await expect(details).toHaveCount(1);
  await expect(details).toBeFocused();
  await expect(thread).toHaveCount(0);
  expect(await originalHistory.evaluate((el) => el.isConnected)).toBe(true);
  const header = dock.locator("header.panel-header");
  expect((await header.boundingBox()).height).toBe(40);
  const profileDraft = page.getByRole("textbox", { name: "Panel draft" });
  await profileDraft.fill("Keep profile state");
  const profileInput = await profileDraft.elementHandle();
  await button(page, "Open child detail").click();
  await expect(details).toHaveCount(2);
  await profileDraft.fill("Keep instance state");
  const instanceInput = await profileDraft.elementHandle();
  await details.nth(0).click();
  await expect(profileDraft).toHaveValue("Keep profile state");
  await button(page, "Open child detail").click();
  await expect(details).toHaveCount(2); // Reopening selects the retained target.
  await expect(profileDraft).toHaveValue("Keep instance state");

  await button(page, "Open local log").click();
  const log = page.getByRole("region", { name: "Fixture log", exact: true });
  const logTab = tablist.getByRole("tab", { name: "Fixture log", exact: true });
  await expect(log).toBeVisible();
  await expect(logTab).toBeFocused();
  await expect(dock.locator("header.panel-header:visible")).toHaveCount(1);
  await details.nth(1).click();
  await expect(profileDraft).toHaveValue("Keep instance state");
  await logTab.click();
  await logTab.press("Escape");
  await expect(log).toHaveCount(0);
  await expect(details.nth(1)).toBeFocused();
  expect(await instanceInput.evaluate((el) => el.isConnected)).toBe(true);
  await threadTab.click();
  await expect(thread).toBeVisible();
  expect(await originalHistory.evaluate((el) => el.scrollTop)).toBe(top);
  await expect(editor).toHaveText("Keep this thread draft");
  expect((await state(page)).entry.target.messageId).toBe(target.id);
  await trigger.press("Enter");
  await expect(details).toHaveCount(2);
  await expect(profileDraft).toHaveValue("Keep profile state");
  expect(await profileInput.evaluate((el) => el.isConnected)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("retained-panel-tabs.png"),
  });

  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await threadTab.click();
    await expect(threadTab).toBeInViewport();
    await details.nth(1).click();
    await expect(details.nth(1)).toBeInViewport();
    expect((await header.boundingBox()).height).toBe(40);
  }
  // A newly opened tab and its close control must reveal themselves in an overflowing strip.
  await button(page, "Open child detail").click();
  await expect(details).toHaveCount(3);
  await expect(details.nth(2)).toBeInViewport();
  await expect(button(page, "Close Wrong panel tab").nth(2)).toBeInViewport();
  // Native horizontal scrolling reaches both ends without changing selection.
  await tablist.hover();
  await page.mouse.wheel(-1000, 0);
  await expect(threadTab).toBeInViewport();
  await page.mouse.wheel(1000, 0);
  await expect(details.nth(2)).toBeInViewport();
  await details.nth(2).press("Delete");
  await button(page, "Close Wrong panel tab").nth(0).click();
  await expect(profileDraft).toHaveValue("Keep instance state");
  // Settings covers the same routed thread: its profile/detail tabs stay
  // mounted behind the modal, inert, and are restored when Settings closes.
  await openPage(page, "Settings");
  await expect(settingsDialog(page)).toBeVisible();
  await expect(dock).toHaveCount(1);
  expect(
    await dock.evaluate((el) => !!el.closest('[aria-hidden="true"], [inert]')),
  ).toBe(true);
  await expect(details).toHaveCount(0);
  expect(await instanceInput.evaluate((el) => el.isConnected)).toBe(true);
  await closeSettings(page);
  await expect(details).toHaveCount(1);
  await expect(profileDraft).toHaveValue("Keep instance state");
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  await expect(details).toHaveAttribute("aria-selected", "true");
  await expect(threadTab).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Sidebar navigation must preserve the complete set, including the routed thread.
  await page.locator('button[data-channel-id="beta"]').click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(details).toHaveCount(1);
  await expect(threadTab).toHaveCount(1);
  await expect(details).toHaveAttribute("aria-selected", "true");
  await details.press("Delete");
  await expect(threadTab).toBeFocused();
  await expect(editor).toHaveText("Keep this thread draft");
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(dock).toHaveCount(0);
});

test("a mixed-case Buzz scheme activates in-app instead of falling through to an external tab", async ({
  page,
  app,
}) => {
  await open(page, app);
  // parseBuzzLink normalizes the scheme via URL, so a BUZZ:// link is a valid
  // internal destination; activation must classify it the same way rather than
  // treating it as an external _blank link.
  const message = app.append(
    "primary",
    "alpha",
    "Jump to <BUZZ://channel/beta>.",
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const link = row.getByRole("link", { name: "#Beta", exact: true });
  await expect(link).toBeVisible();
  // Same post-append activation as above: keyboard, not a pointer click.
  await link.focus();
  await expect(link).toBeFocused();
  await link.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
});

test("unavailable messages fail honestly and legacy links still open when Links is disabled", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Thread root 0");
  const plain = history.find((row) =>
    row.content.startsWith("primary alpha message 637\n"),
  );
  const href = `buzz://message?channel=alpha&id=${target.id}&thread=${"f".repeat(64)}`;
  const message = app.append(
    "primary",
    "alpha",
    `<${href}> <buzz://message?channel=alpha&id=${plain.id}> <buzz://message?channel=alpha&id=${"0".repeat(64)}>`,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  await expect(
    row.getByRole("link", { name: "Alpha", exact: true }).first(),
  ).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await setPluginEnabled(page, "Links", false);
  await closeSettings(page);
  // Activate by keyboard: revealing one target can reposition the timeline
  // under the next click.
  const activate = async (index) => {
    const link = row.locator("a").nth(index);
    await link.focus();
    await expect(link).toBeFocused();
    await link.press("Enter");
  };
  await activate(0);
  // A root with replies opens its own thread. The deliberately wrong hint must
  // not select a different root.
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect(
    thread.getByText("Thread root 0", { exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  // A root without replies stays in the ordinary timeline.
  await activate(1);
  const plainRow = page.locator(
    `[data-channel-timeline] [data-message-id="${plain.id}"]`,
  );
  await expect(plainRow).toBeFocused();
  await expect(plainRow).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  await activate(2);
  await expect
    .poll(async () => (await state(page)).entry.target.messageId)
    .toBe("0".repeat(64));
  await expect(button(page, "Try again")).toBeVisible();
  expect((await state(page)).status).toBe("failed");
});

test.describe("links to channels the reader hasn't joined", () => {
  test.use({ openSearch: true });
  test("name an open channel with a hover card, preview its messages and lock a withheld one", async ({
    page,
    app,
  }) => {
    await open(page, app);
    // Before any channel link looks it up, a message card does, as a click
    // does, and only then reads the message.
    const [openRoot] = app.histories.get(`primary/${app.openChannelId}`);
    const href = `buzz://message?channel=${app.openChannelId}&id=${openRoot.id}`;
    const linking = app.append("primary", "alpha", `Read <${href}>.`);
    const messageLink = page.locator(
      `[data-channel-timeline] [data-message-id="${linking.id}"] a[href="${href}"]`,
    );
    await expect(messageLink).toBeVisible();
    await virtuaIdle(page);
    await messageLink.hover();
    const preview = page.getByLabel("Message preview", { exact: true });
    await expect(
      preview.getByText("Public conversation root", { exact: true }),
    ).toBeVisible();
    await expect(preview.getByText("open", { exact: true })).toBeVisible();
    await expect(preview).toHaveAttribute("href", href);
    const secret = "5ec2e700-0000-4000-8000-000000000001";
    const message = app.append(
      "primary",
      "alpha",
      `See <buzz://channel/${app.openChannelId}>, <buzz://channel/${secret}> and [#launch-plans](buzz://channel/${secret}).`,
    );
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${message.id}"]`,
    );
    const named = row.getByRole("link", { name: "#open", exact: true });
    await expect(named).toBeVisible();
    const locked = row.getByRole("link", {
      name: "Private channel",
      exact: true,
    });
    // Links don't record their community: one from another community is
    // withheld here too, so the explanation covers it.
    await expect(locked).toHaveAttribute(
      "title",
      "Private channel. You aren’t a member, it no longer exists, or the link is from another community.",
    );
    // The authored label is message text; it stays beside the lock.
    const authored = row.getByRole("link", {
      name: "#launch-plans",
      exact: true,
    });
    await expect(authored).toHaveAttribute("title", /aren’t a member/);
    await virtuaIdle(page);
    await named.hover();
    const card = page.getByLabel("Channel preview", { exact: true });
    await expect(card).toContainText("Public channel · Not joined");
  });

  test("link previews open above the message's hover actions", async ({
    page,
    app,
  }) => {
    await open(page, app);
    // A link below the first line puts its preview's default place over the
    // actions above the message.
    const message = app.append(
      "primary",
      "alpha",
      `Release notes:\nsee <buzz://channel/${app.openChannelId}>`,
    );
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${message.id}"]`,
    );
    const channel = row.getByRole("link", { name: "#open", exact: true });
    await expect(channel).toBeVisible();
    await virtuaIdle(page);
    await channel.hover();
    const card = page.getByRole("link", {
      name: "Channel preview",
      exact: true,
    });
    await expect(card).toContainText("Public channel · Not joined");
    const actions = row.getByRole("group", { name: "Message actions" });
    await expect(actions).toBeVisible();
    // A trial click fails while the preview covers the action.
    for (const control of await actions.getByRole("button").all())
      await control.click({ trial: true });
  });
});
