import { openChannelDetails } from "./channel-details.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

const channelId = "11111111-1111-4111-8111-111111111111";
const panelFor = (page) =>
  page.getByRole("complementary", { name: "Channel settings", exact: true });
const dialogFor = (page) =>
  page.getByRole("dialog", {
    name: "Leave channel: Lifecycle channel",
    exact: true,
  });
async function openSettings(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await sidebar.locator(`[data-channel-id="${channelId}"]`).click();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toBeVisible();
  await openChannelDetails(page);
  await expect(panelFor(page)).toBeVisible();
  return sidebar;
}

test.use({
  productionBroker: true,
  channelLifecycle: true,
  leaveRosterBeforeAck: true,
  lifecycleRole: "member",
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only boundary: real Settings -> shared native modal, focus, and
// membership purge crossing the sidebar/page owners. Permission/recovery matrices
// remain in mounted and lifecycle domain tests; no live community writes.
test("management Leave restores focus on cancel, holds pending, and completes through the shared sidebar owner", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  const sidebar = await openSettings(page, app);
  const panel = panelFor(page);
  const leave = panel.getByRole("button", {
    name: "Leave channel",
    exact: true,
  });
  await expect(leave).toBeVisible();
  await expect(leave).toHaveAttribute("data-variant", "subtle");
  await leave.focus();
  await page.keyboard.press("Enter");
  const dialog = dialogFor(page);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Leave channel", exact: true }),
  ).toHaveAttribute("data-variant", "subtle");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveAttribute("data-variant", "subtle");
  await dialog.screenshot({
    path: testInfo.outputPath("leave-confirmation.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(leave).toBeFocused();
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  await leave.click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(leave).toBeFocused();

  let release;
  let intercepted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  // Hold signing before publication: the real lifecycle operation stays pending.
  const routePattern = "**/api/relay/**/channel-lifecycle-sign";
  await page.route(routePattern, async (route) => {
    intercepted();
    await held;
    await route.continue();
  });
  let releaseAck;
  const ackHeld = new Promise((resolve) => {
    releaseAck = resolve;
  });
  let publicationSeen;
  const published = new Promise((resolve) => {
    publicationSeen = resolve;
  });
  await page.route(
    "**/api/relay/**/channel-lifecycle-publish",
    async (route) => {
      const response = await route.fetch();
      publicationSeen();
      await ackHeld;
      await route.fulfill({ response });
    },
  );
  const pending = page.getByRole("dialog", {
    name: "Leaving channel…",
    exact: true,
  });
  try {
    try {
      await leave.click();
      await dialog
        .getByRole("button", { name: "Leave channel", exact: true })
        .click();
      await seen;
      await expect(dialog).toHaveCount(0);

      await expect(pending).toBeVisible();
      await expect(pending).not.toHaveAttribute("aria-modal", "true");
      await page.keyboard.press("Escape");
      await expect(pending).toBeVisible();
      await expect(
        page.locator(`[data-channel-id="${channelId}"]`),
      ).toBeVisible();
      expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
    } finally {
      release();
    }
    // The signed roster has removed membership while the actual publication
    // response is still withheld. Content cleanup must not fail the dialog.
    await published;
    await expect(
      sidebar.locator(`[data-channel-id="${channelId}"]`),
    ).toHaveCount(0);
    await expect(pending).toBeVisible();
    // The dropped row is the barrier: own Leave is not reported as removal.
    await expect(
      page.getByRole("region", { name: /^You’re no longer a member of/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Leave channel failed", exact: true }),
    ).toHaveCount(0);
  } finally {
    releaseAck();
  }
  await expect(pending).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Leave channel failed", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Channel left: Lifecycle channel", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await expect(sidebar.locator(`[data-channel-id="${channelId}"]`)).toHaveCount(
    0,
  );
  // Its sidebar neighbor opens as it does from its row.
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("region", { name: /^You’re no longer a member of/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect(sidebar.locator(`[data-channel-id="${channelId}"]`)).toHaveCount(
    0,
  );
  expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual([
    9022,
  ]);
  expect(app.report.unexpected).toEqual([]);
});

// Browser-only boundary: a relay-signed roster without the viewer arrives live
// through discovery while the channel is open, the public preview resolves
// through real relay reads, a real browser drops focus from what the loss
// unmounts, and the sidebar owner chooses where Back lands. Copy, suppression
// and degraded-roster matrices remain in mounted tests.
const focusOrigins = {
  composer: async (page, name) => {
    const composer = page.getByRole("textbox", {
      name: `Message ${name}`,
      exact: true,
    });
    await composer.click();
    return composer;
  },
  "header's Channel actions": async (page) => {
    const actions = page.getByRole("button", {
      name: "Channel actions",
      exact: true,
    });
    await actions.focus();
    return actions;
  },
  "history scroller": async (page) => {
    const scroller = page.locator(
      "[data-channel-history] [data-message-scroller]",
    );
    await scroller.focus();
    return scroller;
  },
};
for (const [origin, focusIn] of Object.entries(focusOrigins))
  test(`a live removal names the open channel and leads to its sidebar neighbor, with focus in the ${origin}`, async ({
    page,
    app,
  }) => {
    app.setChannelMetadata("alpha", [
      ["name", "Alpha"],
      ["t", "stream"],
      ["private"],
    ]);
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Message Alpha", exact: true }),
    ).toBeVisible();
    await expect(await focusIn(page, "Alpha")).toBeFocused();
    app.removeViewer("alpha");
    // A private channel leaves nothing to read: the notice replaces the pane,
    // and focus the conversation held moves to its only action.
    const alphaLost = page.getByRole("region", {
      name: "You’re no longer a member of Alpha",
      exact: true,
    });
    await expect(alphaLost).toBeVisible();
    await expect(alphaLost.locator("xpath=..")).toHaveAttribute(
      "role",
      "status",
    );
    await expect(
      alphaLost.getByRole("button", { name: "Back to channels", exact: true }),
    ).toBeFocused();
    await expect(
      sidebar.getByRole("button", { name: "Alpha", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message Alpha", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Select a channel to read it.", { exact: true }),
    ).toHaveCount(0);

    await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await expect(await focusIn(page, "#Beta")).toBeFocused();
    app.removeViewer("beta");
    const removed = page.getByRole("region", {
      name: "You’re no longer a member of #Beta",
      exact: true,
    });
    // A public channel stays readable as a preview, Join below its history.
    const preview = page.getByRole("region", {
      name: "Channel preview",
      exact: true,
    });
    await expect(preview).toContainText("Join channel to send messages");
    await expect(removed).toBeVisible();
    const history = page.locator("[data-channel-history]");
    const [notice, list, join] = await Promise.all([
      removed.boundingBox(),
      history.boundingBox(),
      preview.boundingBox(),
    ]);
    expect(notice.y + notice.height).toBeLessThanOrEqual(list.y);
    expect(notice.y + notice.height).toBeLessThanOrEqual(join.y);
    // The conversation's focus moves to the preview's readable history.
    await expect
      .poll(() =>
        history.evaluate((node) => node.contains(document.activeElement)),
      )
      .toBe(true);
    // The status follows the header in the keyboard order.
    await page
      .getByRole("button", { name: "Channel actions", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(
      removed.getByRole("button", { name: "Back to channels", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    // Beta's nearest remaining row, as Leave would choose.
    await expect(
      sidebar.locator(`[data-channel-id="${channelId}"]`),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("textbox", {
        name: "Message #Lifecycle channel",
        exact: true,
      }),
    ).toBeVisible();
    await expect(removed).toHaveCount(0);
    expect(app.report.lifecyclePublications ?? []).toEqual([]);
    expect(app.report.unexpected).toEqual([]);
  });

test.describe("last visible channel", () => {
  test.use({
    lifecycleVisibility: {
      archived: ["alpha", "beta"],
      hidden: ["22222222-2222-4222-8222-222222222222"],
    },
  });
  test("management completion selects the explicit empty route, not retained membership", async ({
    page,
    app,
  }) => {
    const sidebar = await openSettings(page, app);
    await panelFor(page)
      .getByRole("button", { name: "Leave channel", exact: true })
      .click();
    await dialogFor(page)
      .getByRole("button", { name: "Leave channel", exact: true })
      .click();
    await expect(dialogFor(page)).toHaveCount(0);
    await expect(panelFor(page)).toHaveCount(0);
    await expect(
      page.getByText("Select a channel to read it.", { exact: true }),
    ).toBeVisible();
    await expect(sidebar.locator("button[data-channel-id]")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /^Message #/ })).toHaveCount(
      0,
    );
    // Roster revocation can render the empty page before Leave is confirmed.
    // Its completion hands focus back through the sidebar owner.
    await expect(
      page.getByText("Channel left: Lifecycle channel", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement?.closest('[aria-label="Sidebar"]') !== null,
        ),
      )
      .toBe(true);
    await page.reload();
    await expect(
      page.getByText("Select a channel to read it.", { exact: true }),
    ).toBeVisible();
    await expect(sidebar.locator("button[data-channel-id]")).toHaveCount(0);
    expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual(
      [9022],
    );
    expect(app.report.unexpected).toEqual([]);
  });
});
