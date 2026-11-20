import { pauseClock } from "./clock.mjs";
import { pluginAction } from "./plugin-settings.mjs";
import { test, expect } from "./fixture.mjs";
import { end, open, settle } from "./timeline.mjs";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 1 },
});

// Only the browser's OS boundary is replaced. The built host, session,
// verified WS → broker → SSE and navigation/Channels consumers are production.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.notificationEvents = [];
    window.notificationRequests = 0;
    window.Notification = class {
      static permission = "granted";
      static async requestPermission() {
        window.notificationRequests++;
        window.Notification.permission = "granted";
        return window.Notification.permission;
      }
      constructor(title, options) {
        this.title = title;
        this.options = options;
        this.closed = false;
        window.notificationEvents.push(this);
      }
      close() {
        this.closed = true;
        this.onclose?.();
      }
    };
  });
});
const systemCount = (page) =>
  page.evaluate(() => window.notificationEvents.length);
async function settings(page) {
  expect(
    await page.evaluate(() =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "settings",
        section: "notifications",
      }),
    ),
  ).toEqual({ status: "opened" });
  await expect(
    page.getByRole("heading", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await page.getByRole("switch", { name: "Sound", exact: true }).uncheck();
}
async function ready(page, app) {
  await open(page, app);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = window.fixtureRelay.snapshot().session;
        return (
          session.live
            .snapshot()
            .routes.some(
              (r) => r.channelId === "beta" && r.status === "live",
            ) && session.unread.sync().completeness === "snapshot"
        );
      }),
    )
    .toBe(true);
  await settings(page);
}
function liveMessage(
  app,
  content,
  {
    age = 0,
    createdAt = Math.floor(Date.now() / 1000) - age,
    replyTo,
    mentioned = true,
  } = {},
) {
  const event = finalizeEvent(
    {
      kind: 9,
      content,
      created_at: createdAt,
      tags: [
        ["h", "beta"],
        ...(mentioned ? [["p", app.viewer]] : []),
        ...(replyTo ? [["e", replyTo, "", "reply"]] : []),
      ],
    },
    generateSecretKey(),
  );
  app.histories.get("primary/beta").push(event);
  app.relay.publish("primary", event);
  return event;
}

async function observed(page, id) {
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("beta", id)
            .status,
        id,
      ),
    )
    .toBe("eligible");
  // Fresh attention is installed in the same synchronous receive turn as
  // notification admission. Run the actual presentation deadline and its
  // immediate browser-permission continuation, rather than sleeping on wall time.
  await page.clock.runFor(100);
}

test("workflow ownership stays quiet while an explicit owner mention alerts", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await ready(page, app);
  const publish = (explicit) => {
    const event = app.signRelay({
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: explicit ? "@Owner review the result" : "@Agent do the work",
      tags: [
        ["h", "beta"],
        ["p", app.viewer],
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", app.viewer],
        ...(explicit ? [["buzz:workflow-mention", app.viewer]] : []),
      ],
    });
    app.histories.get("primary/beta").push(event);
    app.relay.publish("primary", event);
    return event;
  };
  const ownerOnly = publish(false);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("beta", id)
            .status,
        ownerOnly.id,
      ),
    )
    .toBe("ineligible");
  // Verified receive/admission is synchronous; drain the presentation deadline.
  await page.clock.runFor(100);
  expect(await systemCount(page)).toBe(0);
  const explicit = publish(true);
  await observed(page, explicit.id);
  await expect.poll(() => systemCount(page)).toBe(1);
  expect(
    await page.evaluate(() => window.notificationEvents[0].options.body),
  ).toBe("@Owner review the result");
});

test("real live traffic alerts once; replay/reload stay quiet and choices persist", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await ready(page, app);
  expect(await systemCount(page)).toBe(0);
  const row = liveMessage(app, "Fresh mention");
  await expect.poll(() => systemCount(page)).toBe(1);
  app.relay.publish("primary", row);
  // The replay already has attention, so that alone is not a receive barrier.
  // A later fresh row on the same ordered stream proves replay consumption.
  const sentinel = liveMessage(app, "Replay consumption sentinel", {
    mentioned: false,
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("beta", id)
            .status,
        sentinel.id,
      ),
    )
    .toBe("ineligible");
  await page.clock.runFor(100);
  expect(await systemCount(page)).toBe(1);
  await page.getByRole("switch", { name: "Mentions", exact: true }).uncheck();
  const muted = liveMessage(app, "Muted mention");
  await observed(page, muted.id);
  expect(await systemCount(page)).toBe(1);
  await page.reload();
  await settings(page);
  await expect(
    page.getByRole("switch", { name: "Mentions", exact: true }),
  ).not.toBeChecked();
  expect(await systemCount(page)).toBe(0);
  expect(await page.evaluate(() => window.notificationRequests)).toBe(0);
  await expect(
    page.getByRole("heading", { name: "Recent notifications" }),
  ).toHaveCount(0);
});

test("explicit Allow releases the first fresh alert; master off preserves categories", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await ready(page, app);
  await page.evaluate(() => {
    window.Notification.permission = "default";
  });
  await page
    .getByRole("button", { name: "Check permission", exact: true })
    .click();
  const row = liveMessage(app, "Permission wait");
  await observed(page, row.id);
  expect(await systemCount(page)).toBe(0);
  expect(await page.evaluate(() => window.notificationRequests)).toBe(0);
  await page
    .getByRole("button", { name: "Allow notifications", exact: true })
    .click();
  await expect.poll(() => systemCount(page)).toBe(1);
  await page.getByRole("switch", { name: "Mentions", exact: true }).uncheck();
  await page
    .getByRole("switch", { name: "Desktop alerts", exact: true })
    .uncheck();
  await page
    .getByRole("switch", { name: "Desktop alerts", exact: true })
    .check();
  await expect(
    page.getByRole("switch", { name: "Mentions", exact: true }),
  ).not.toBeChecked();
  const muted = liveMessage(app, "Disabled category");
  await observed(page, muted.id);
  expect(await systemCount(page)).toBe(1);
});

// Layout and real focus retention need an engine; Vitest covers check ordering.
test("keyboard permission check keeps focus and geometry while busy", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await ready(page, app);
  const status = page.locator("#setting-delivery").getByRole("status");
  await expect(status).toHaveCount(0);
  const button = page.getByRole("button", {
    name: "Check permission",
    exact: true,
  });
  const before = await button.boundingBox();
  await page.evaluate(() => {
    window.Notification.permission = "denied";
  });
  await button.focus();
  await pauseClock(page, 1_000);
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-busy", "true");
  await page.clock.runFor(100);
  // A screenshot crosses a real rendered frame, where a disabled control blurs.
  await button.screenshot();
  await expect(button).toBeFocused();
  expect(await button.boundingBox()).toEqual(before);
  await expect(button).toHaveAttribute("aria-busy", "true");
  await page.clock.runFor(400);
  await expect(button).not.toHaveAttribute("aria-busy", "true");
  await expect(button).toBeFocused();
  await expect(status).toHaveText(
    "Notifications are off. Turn them on in your browser or system settings.",
  );
});

test("a fully visible incoming row stays quiet without publishing read intent", async ({
  page,
  app,
}) => {
  // Own the reader's timers from startup so pausing also holds existing dwell.
  await page.clock.install();
  const following = finalizeEvent(
    {
      kind: 9,
      content: "Following row",
      created_at: Math.floor(Date.now() / 1000) + 20,
      tags: [["h", "beta"]],
    },
    generateSecretKey(),
  );
  // Keep both rows wholly inside the viewport. A long virtualized history can
  // leave its last row fractionally clipped in WebKit, which is not "viewing".
  app.histories.set("primary/beta", [following]);
  await ready(page, app);
  await page.evaluate(
    (viewer) =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "conversation",
        channelId: "beta",
        scope: { viewer, communityOrigin: "https://primary.example" },
      }),
    app.viewer,
  );
  const history = page.getByRole("region", {
    name: "Channel message history",
    exact: true,
  });
  await settle(page);
  await page.bringToFront();
  await history.focus();
  // Establish the real reading lease before publishing: mounted DOM alone does
  // not prove that the document is focused and the timeline is ready to observe.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("beta", id)
            .viewing,
        following.id,
      ),
    )
    .toBe(true);
  // Controlled policy/dwell ordering, not evidence about native frame scheduling.
  // Exact-row navigation and reflow journeys below retain native rAF.
  await pauseClock(page, 30_000);
  // The earlier row can finish its dwell as the clock advances. Publish
  // after its read frontier so this live mention starts unread.
  const row = liveMessage(app, "Visible mention", {
    createdAt: following.created_at + 1,
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("beta", id)
            .status,
        row.id,
      ),
    )
    .toBe("eligible");
  // The paused clock must not run presentation's deadline ahead of the new
  // row's commit/positioning. Pump frames until viewing is established, yielding
  // between steps for native ResizeObserver and React work. Cap clock progress
  // below presentation's 100ms fallback and reading's 300ms dwell.
  let positioningTime = 0;
  await expect
    .poll(async () => {
      if (positioningTime < 96) {
        await page.clock.runFor(16);
        positioningTime += 16;
      }
      if (!(await history.locator(`[data-message-id="${row.id}"]`).isVisible()))
        return false;
      return page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("beta", id)
            .viewing,
        row.id,
      );
    })
    .toBe(true);
  await page.clock.runFor(100);
  expect(await systemCount(page)).toBe(0);
  expect(
    await page.evaluate(
      (id) =>
        window.fixtureRelay.snapshot().session.unread.attention("beta", id)
          .unread,
      row.id,
    ),
  ).toBe(true);
  await page.clock.resume();
  // The paused clock also owned requestAnimationFrame, so the frames that
  // re-pin the bottom after an append ran in the explicit clock steps above.
  // Check the row's full visibility on the running clock, while it is mounted.
  await expect(history.locator(`[data-message-id="${row.id}"]`)).toBeInViewport(
    { ratio: 1 },
  );
  await settings(page);
  await page
    .getByRole("switch", { name: "Notify while viewing", exact: true })
    .check();
  await page.evaluate(
    (viewer) =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "conversation",
        channelId: "beta",
        scope: { viewer, communityOrigin: "https://primary.example" },
      }),
    app.viewer,
  );
  await settle(page);
  await history.focus();
  liveMessage(app, "Allowed visible mention", {
    createdAt: row.created_at + 1,
  });
  await expect.poll(() => systemCount(page)).toBe(1);
});

for (const kind of ["mention", "thread reply"]) {
  test(`live ${kind} notification focuses its exact row in the normal conversation, then ordinary dwell reads it`, async ({
    page,
    app,
  }) => {
    // Only this geometry scenario needs an overflowing Beta history.
    if (kind === "mention") {
      for (let i = 0; i < 20; i++) {
        app.append("primary", "beta", `Earlier message ${i}`, false, false);
      }
    }
    // Model a real prior contribution in relay history, not a client-side
    // participation/readiness override. The incoming reply itself has no p tag.
    const root =
      kind === "thread reply"
        ? app.append("primary", "beta", "My prior thread", false)
        : undefined;
    await ready(page, app);
    if (root)
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              window.fixtureRelay
                .snapshot()
                .session.unread.attention("beta", id).status,
            root.id,
          ),
        )
        .toBe("ineligible"); // Own root is verified evidence, never an alert.
    const incoming = liveMessage(app, `Selected **${kind}**`, {
      mentioned: !root,
      replyTo: root?.id,
    });
    await expect.poll(() => systemCount(page)).toBe(1);
    expect(
      await page.evaluate(() => window.notificationEvents[0].options.body),
    ).toBe(`Selected ${kind}`);
    expect(await page.evaluate(() => window.notificationEvents[0].title)).toBe(
      `${incoming.pubkey.slice(0, 10)} ${root ? "replied" : "mentioned you"} in #Beta`,
    );
    const before = app.report.readPublications.length;
    const start = performance.now();
    await page.evaluate(() => window.notificationEvents[0].onclick());
    expect(app.report.readPublications.length).toBe(before);
    const surface = page.getByRole("region", {
      name: root ? "Thread messages" : "Channel message history",
      exact: true,
    });
    const row = surface.locator(`[data-message-id="${incoming.id}"]`);
    await expect(row).toBeFocused();
    await expect(row).toBeVisible();
    await expect(row.locator("strong").filter({ hasText: kind })).toHaveText(
      kind,
    );
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    app.report.measurements.push({
      mode: `live ${kind} click to exact conversation row`,
      clickToOpenedMs: performance.now() - start,
    });
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    if (root) {
      await expect(
        surface.locator(`[data-message-id="${root.id}"]`),
      ).toBeAttached();
      await expect(
        page.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => app.report.queries.some((q) => q.filter.depth_limit))
        .toBe(true);
    } else {
      await expect(
        page.getByRole("region", { name: "Thread messages", exact: true }),
      ).toHaveCount(0);
      expect(
        app.report.queries.filter((q) => q.filter.depth_limit),
      ).toHaveLength(0);
      // A row measuring taller after the reveal must not push the latest row
      // out of view: the reveal left the reader at the bottom, following.
      const height = await surface.evaluate((element) => element.scrollHeight);
      await surface
        .locator("[data-message-id]")
        .filter({ hasText: "Earlier message 19" })
        .evaluate((element) => {
          element.style.paddingBottom = "60px";
        });
      await expect
        .poll(() => surface.evaluate((element) => element.scrollHeight))
        .toBeGreaterThanOrEqual(height + 60);
      await expect(row).toBeInViewport({ ratio: 1 });
    }
    await expect
      .poll(() => app.report.readPublications.length)
      .toBeGreaterThan(before);
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.fixtureRelay.snapshot().session.unread.attention("beta", id)
              .unread,
          incoming.id,
        ),
      )
      .toBe(false);
    if (!root) {
      // Fractional reflow must not leave the last row clipped at maximum scroll.
      await row.evaluate((element) => {
        element.style.paddingBottom = "0.125px";
      });
      // Keep the same small history overflowing with the condensed headers,
      // including when the sidebar disappears at the narrow breakpoint.
      for (const width of [1440, 640]) {
        await page.setViewportSize({ width, height: 650 });
        await expect
          .poll(() =>
            surface.evaluate(
              (element) => element.scrollHeight > element.clientHeight,
            ),
          )
          .toBe(true);
        await end(page);
        await expect(row).toBeInViewport({ ratio: 1 });
      }
    }
  });
}

test("an installed producer shares policy and OS click navigation, including after producer disable", async ({
  page,
  app,
}) => {
  await ready(page, app);
  const input = {
    sourceKey: "plugin-event",
    target: { version: 1, kind: "settings", section: "appearance" },
  };
  expect(
    await page.evaluate((input) => window.fixtureNotify(input), input),
  ).toBe(true);
  await expect.poll(() => systemCount(page)).toBe(1);
  await page.evaluate(() =>
    window.fixtureNavigation.open({
      version: 1,
      kind: "settings",
      section: "plugins",
    }),
  );
  await pluginAction(page, "Notification fixture").click();
  expect(
    await page.evaluate((input) => window.fixtureNotify(input), {
      ...input,
      sourceKey: "stale",
    }),
  ).toBe(false);
  await page.evaluate(() => window.notificationEvents[0].onclick());
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
});

test("asynchronous browser display failure reaches Settings once without redelivery", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await ready(page, app);
  const event = liveMessage(app, "Browser display error");
  await observed(page, event.id);
  await expect.poll(() => systemCount(page)).toBe(1);
  await page.evaluate(() => window.notificationEvents[0].onerror?.());
  await expect(
    page.getByRole("dialog", {
      name: "Buzz couldn’t send the notification",
      exact: true,
    }),
  ).toContainText("The browser could not display a notification.");
  expect(
    await page.evaluate(() => {
      const item = window.notificationEvents[0];
      return {
        closed: item.closed,
        click: item.onclick,
        error: item.onerror,
        close: item.onclose,
      };
    }),
  ).toEqual({ closed: true, click: null, error: null, close: null });
  await page
    .getByRole("button", { name: "Check permission", exact: true })
    .click();
  await page.clock.runFor(100);
  expect(await systemCount(page)).toBe(1);
});
