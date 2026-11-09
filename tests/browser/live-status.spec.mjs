import { openChannelDetails } from "./channel-details.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
test.use({
  productionBroker: true,
  historyCounts: { alpha: 1, beta: 1 },
});
test.describe("held setup", () => {
  // Beta's EOSE stays held through the channel switch and diagnostics. On a
  // slow runner that can pass the broker's real-time 10 s setup deadline,
  // which fails the route and rightly shows recovery. This test is about
  // pending setup, not that deadline.
  test.use({ liveSetupTimeoutMs: 120_000 });
  test("clean pending setup stays in diagnostics and never flashes a warning during channel switches", async ({
    page,
    app,
  }) => {
    app.relay.holdEose("beta");
    await page.goto(app.origin);
    await page.evaluate(() => {
      window.__bannerSeen = [];
      window.__bannerObserver = new MutationObserver(() => {
        for (const status of document.querySelectorAll(
          '[role="status"][aria-label="Live updates limited"], .buzz-toast',
        )) {
          window.__bannerSeen.push(status.textContent);
        }
      });
      window.__bannerObserver.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });

    await openPage(page, "Messages");
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    const warning = page
      .getByRole("status", { name: "Live updates limited" })
      .or(notice(page));
    await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
    await expect(warning).toHaveCount(0);
    const streams = () =>
      app.report.brokerRequests.filter((r) => r.url.endsWith("/stream")).length;
    const before = streams();
    await page.getByRole("button", { name: "Beta", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await expect(warning).toHaveCount(0);
    await openChannelDetails(page);
    await openDiagnostics(page);
    await expect(
      page.getByText("Live updates: connecting", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close Channel settings tab", exact: true })
      .click();
    expect(app.relay.rejected).toHaveLength(0);
    expect(app.report.wireFrames.filter((f) => f[0] === "CLOSED")).toHaveLength(
      0,
    );
    expect(streams()).toBe(before);
    app.relay.releaseEose("beta");
    await expect(warning).toHaveCount(0);
    for (const channel of ["Alpha", "Beta", "Alpha", "Beta"]) {
      await page.getByRole("button", { name: channel, exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: `Message #${channel}`, exact: true }),
      ).toBeVisible();
    }
    const warm = await page.evaluate(() => {
      window.__bannerObserver.disconnect();
      return window.__bannerSeen;
    });
    expect(warm).toEqual([]);
    expect(streams()).toBe(before);
    app.report.measurements.push({
      rejected: app.relay.rejected,
      warmSwitchWarnings: warm,
      streamsBefore: before,
      streamsAfter: streams(),
    });
  });
});

const notice = (page) =>
  page.getByRole("dialog", {
    name: "Buzz is having trouble connecting",
    exact: true,
  });

for (const target of ["alpha", "profiles"]) {
  test(`quota recovery for ${target} stays quiet until attempts exhaust, then keeps retrying automatically until EOSE`, async ({
    page,
    app,
  }, testInfo) => {
    // Count inside the page: fetch settlement and its consumer's continuation
    // drain in one microtask checkpoint, even while the page clock is held.
    await page.addInitScript(() => {
      const native = window.fetch;
      window.retryControls = 0;
      window.fetch = (input, init) => {
        const result = native(input, init);
        if (String(input).endsWith("/stream-retry")) {
          const settled = () => window.retryControls--;
          window.retryControls++;
          result.then(settled, settled);
        }
        return result;
      };
    });
    await page.clock.install();
    if (target === "profiles")
      await page.addInitScript(() =>
        localStorage.setItem("buzz-appearance.v1", "dark"),
      );
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await expect.poll(() => app.relay.hasRoute("primary", target)).toBe(true);
    // Recovery never falls back to the unrecoverable "limited" status.
    const warning = page.getByRole("status", {
      name: "Live updates limited",
      exact: true,
    });
    await expect(warning).toHaveCount(0);
    await openChannelDetails(page);
    await openDiagnostics(page);
    const recovery = page.getByText(
      "Live updates: recovering automatically after rate limiting; awaiting confirmation",
      { exact: true },
    );
    const rejected = "rate-limited: quota exceeded; retry in 0s";
    app.relay.holdEose(target);
    const requests = () =>
      app.relay.requests.filter(
        (r) => r.community === "primary" && r.routes.includes(target),
      );
    const streams = () =>
      app.report.brokerRequests.filter((r) => r.url.endsWith("/stream")).length;
    const streamCount = streams();
    const sockets = app.relay.sockets.length;
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = requests().length;
      app.relay.failRoute("primary", target, rejected);
      if (attempt < 3) {
        await expect(recovery).toBeVisible();
        await expect(warning).toHaveCount(0);
        await expect(notice(page)).toHaveCount(0);
        await expect.poll(() => requests().length).toBeGreaterThan(before);
        // The new REQ exists, but fixture holds EOSE: no false healthy status.
        await expect(recovery).toBeVisible();
        await expect(warning).toHaveCount(0);
      } else {
        // Exhausted stream recovery hands over to session recovery: a new
        // REQ with no click, and one notice once it lasts 30 s. Jump the
        // quiet delay only after that REQ shows the app received the failure.
        await expect.poll(() => requests().length).toBeGreaterThan(before);
        await page.clock.fastForward(30_000);
        await expect(notice(page)).toBeVisible();
        await expect(warning).toHaveCount(0);
      }
    }
    // The notice keeps showing while the retried REQ waits for EOSE, and it
    // floats above the composer without covering Send.
    for (const width of [390, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await page
        .getByRole("button", {
          name: "Close Channel settings tab",
          exact: true,
        })
        .click();
      await page
        .getByRole("textbox", { name: "Message #Alpha", exact: true })
        .fill("Unsent recovery draft");
      await expect(notice(page)).toHaveCount(1); // Diagnostics must not duplicate it.
      await expect(warning).toHaveCount(0);
      await expect(notice(page)).toBeInViewport({ ratio: 1 });
      const composer = page
        .getByRole("textbox", {
          name: "Message #Alpha",
          exact: true,
        })
        .locator("xpath=ancestor::form");
      await expect
        .poll(async () => {
          const box = await notice(page).boundingBox();
          const form = await composer.boundingBox();
          return box && form ? box.y + box.height <= form.y : false;
        })
        .toBe(true);
      await composer
        .getByRole("button", {
          name: "Send message",
          exact: true,
        })
        .click({ trial: true });
      await page.screenshot({
        path: testInfo.outputPath(`recovery-app-${target}-${width}.png`),
      });
      await openChannelDetails(page);
      await openDiagnostics(page);
      await expect(notice(page)).toHaveCount(1);
    }
    // No click: the retried REQ reaching EOSE ends recovery.
    app.relay.releaseEose(target);
    await expect(notice(page)).toHaveCount(0);
    await expect(
      page.getByText("Live updates: stream established", { exact: true }),
    ).toBeVisible();
    await expect(warning).toHaveCount(0);
    expect(streams()).toBe(streamCount);
    expect(app.relay.sockets).toHaveLength(sockets);
  });
}

// Browser layout: a long, unbroken relay reason stays out of the notice,
// which floats above the composer at enlarged text size without covering Send.
test("long recovery stays above the composer at enlarged text size", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.clock.install();
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(input).toBeVisible();
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  app.relay.holdEose("alpha");
  const requests = () =>
    app.relay.requests.filter(
      (r) => r.community === "primary" && r.routes.includes("alpha"),
    ).length;
  const before = requests();
  app.relay.failRoute(
    "primary",
    "alpha",
    `error: ${"Unavailable".repeat(160)}`,
  );
  const warning = notice(page);
  // Jump the quiet delay only once recovery has started: its retry REQ shows
  // the app received the failure.
  await expect.poll(requests).toBeGreaterThan(before);
  await page.clock.fastForward(30_000);
  await expect(warning).toBeVisible();
  await input.fill("Unsent recovery draft");
  const form = input.locator("xpath=ancestor::form");
  await expect
    .poll(async () => {
      const box = await warning.boundingBox();
      const composer = await form.boundingBox();
      return (
        !!box &&
        !!composer &&
        box.y >= 0 &&
        box.y + box.height <= composer.y &&
        composer.y + composer.height <= 600
      );
    })
    .toBe(true);
  await expect(warning).toHaveText(
    /^Buzz is having trouble connectingRetrying automatically\.$/,
  );
  await expect(warning.getByRole("button")).toHaveCount(0);
  await form
    .getByRole("button", { name: "Send message", exact: true })
    .click({ trial: true });
  await page.screenshot({
    path: testInfo.outputPath("recovery-long-enlarged.png"),
  });
  app.relay.releaseEose("alpha");
  await expect(notice(page)).toHaveCount(0);
  await expect(input).toHaveText("Unsent recovery draft");
});

async function openDiagnostics(page) {
  // A quick reopen can retain the outgoing settings DOM during its exit.
  const summary = page.getByText("Diagnostics", { exact: true });
  if ((await summary.locator("..").getAttribute("open")) === null)
    await summary.click();
  await expect(summary.locator("..")).toHaveAttribute("open", "");
}

test.describe("public preview recovery", () => {
  test.use({ openSearch: true });
  // The empty loading/error placeholder is replaced by the real timeline once
  // automatic recovery reads the head again, with no Retry to press.
  test("recovers an empty preview whose catch-up fails before loading rows", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    const originalHistory = app.histories.get(`primary/${app.openChannelId}`);
    app.histories.set(`primary/${app.openChannelId}`, []);
    await page
      .getByRole("button", { name: "Search Buzz", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Search Buzz" }).fill("ope");
    await page
      .locator(
        '[role="group"][aria-label="Channels"], [role="rowgroup"][aria-label="Channels"]',
      )
      .locator("[data-search-result]")
      .filter({ hasText: /^open/ })
      .click();
    await expect(
      page.getByRole("region", {
        name: "Channel message history",
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(() => app.relay.hasRoute("primary", app.openChannelId))
      .toBe(true);
    let failHead = true;
    let retryRequested = false;
    let releaseHead;
    const headGate = new Promise((resolve) => {
      releaseHead = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      const isPreviewHead = route
        .request()
        .postDataJSON()
        .some(
          (filter) =>
            filter.top_level && filter["#h"]?.includes(app.openChannelId),
        );
      if (!isPreviewHead) return route.continue();
      if (failHead) {
        app.report.startupFailures ??= [];
        app.report.startupFailures.push(route.request().url());
        return route.fulfill({
          status: 502,
          json: { error: "Fixture preview head unavailable" },
        });
      }
      retryRequested = true;
      await headGate;
      await route.continue();
    });
    try {
      app.relay.failRoute(
        "primary",
        app.openChannelId,
        "error: Preview stream interrupted",
      );
      // Both failures are outages: recovery owns them, quietly at first, with
      // no per-panel Retry messages.
      const warning = notice(page);
      await expect
        .poll(() => app.report.startupFailures?.length ?? 0)
        .toBeGreaterThan(0);
      await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
      const history = page.locator("[data-channel-history]");
      await expect(history.locator("[data-message-scroller]")).toHaveCount(0);
      failHead = false;
      app.histories.set(`primary/${app.openChannelId}`, originalHistory);
      // No click: a scheduled retry reads the head again.
      await expect.poll(() => retryRequested, { timeout: 20_000 }).toBe(true);
      await expect(
        history.getByText("Loading messages…", { exact: true }),
      ).toBeVisible();
      releaseHead();
      await expect(history.locator("[data-message-scroller]")).toBeVisible();
      await expect(history).toContainText("Public conversation root");
      await expect(warning).toHaveCount(0);
    } finally {
      releaseHead();
    }
  });
  // Real browser geometry: the wrapped notice floats above the invitation and
  // leaves Join usable.
  test("keeps wrapped recovery clear of Join", async ({ page, app }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.clock.install();
    await page.goto(app.origin);
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    await page
      .getByRole("button", { name: "Search Buzz", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Search Buzz" }).fill("ope");
    await page
      .locator(
        '[role="group"][aria-label="Channels"], [role="rowgroup"][aria-label="Channels"]',
      )
      .locator("[data-search-result]")
      .filter({ hasText: /^open/ })
      .click();
    const invitation = page.getByRole("region", {
      name: "Channel preview",
      exact: true,
    });
    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    await expect(invitation).toBeVisible();
    await expect
      .poll(() => app.relay.hasRoute("primary", app.openChannelId))
      .toBe(true);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    // Hold EOSE so automatic recovery cannot settle before the checks.
    app.relay.holdEose(app.openChannelId);
    const warning = notice(page);
    const requests = () =>
      app.relay.requests.filter(
        (r) =>
          r.community === "primary" && r.routes.includes(app.openChannelId),
      ).length;
    const before = requests();
    try {
      app.relay.failRoute(
        "primary",
        app.openChannelId,
        "error: Live updates are temporarily unavailable. Try reconnecting to this channel.",
      );
      // Jump the quiet delay only once recovery has started: its retry REQ
      // shows the app received the failure.
      await expect.poll(requests).toBeGreaterThan(before);
      await page.clock.fastForward(30_000);
      await expect(warning).toBeVisible();
      await expect
        .poll(async () => {
          const capsule = await invitation.boundingBox();
          const recovery = await warning.boundingBox();
          return (
            !!capsule && !!recovery && recovery.y + recovery.height <= capsule.y
          );
        })
        .toBe(true);
      await invitation
        .getByRole("button", { name: "Join", exact: true })
        .click({ trial: true });
    } finally {
      app.relay.releaseEose(app.openChannelId);
    }
    await expect(warning).toHaveCount(0);
    await expect(history).toBeVisible();
    await expect(
      invitation.getByRole("button", { name: "Join", exact: true }),
    ).toBeVisible();
  });
});
