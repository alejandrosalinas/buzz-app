import { openChannelDetails } from "./channel-details.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { animationsSettled } from "./animations.mjs";

const channelId = "11111111-1111-4111-8111-111111111111";
const panelFor = (page) =>
  page.getByRole("complementary", { name: "Channel settings", exact: true });

test.use({
  productionBroker: true,
  channelLifecycle: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Two distinct browser boundaries: archive changes visibility while retaining
// membership; delete purges access while the pane unmounts. Both reuse the shared
// modal/focus handoff. Permission and recovery matrices stay below the browser.
for (const action of ["archive", "delete"]) {
  test.describe(`management ${action}`, () => {
    const label = action === "archive" ? "Archive channel" : "Delete channel";
    if (action === "delete")
      test.use({
        lifecycleVisibility: {
          archived: ["alpha", "beta"],
          hidden: ["22222222-2222-4222-8222-222222222222"],
        },
      });
    test("cancels to its pane trigger, reports pending in a toast, and preserves the confirmed destination on reload", async ({
      page,
      app,
    }, testInfo) => {
      await page.addInitScript(() => {
        localStorage.setItem("buzz-appearance.v1", "dark");
      });
      const presenceAccepted = () =>
        page.waitForResponse(
          async (response) =>
            response.url().endsWith("/stream-presence") &&
            (await response.json()).accepted === true,
        );
      // Establish startup before observing the publication restarted by deletion.
      const initialPresence = presenceAccepted();
      await page.goto(app.origin);
      await initialPresence;
      await openPage(page, "Messages");
      const sidebar = page.getByRole("navigation", {
        name: "Subscribed channels",
      });
      const row = sidebar.locator(`[data-channel-id="${channelId}"]`);
      await row.click();
      const composer = page.getByRole("textbox", {
        name: "Message #Lifecycle channel",
        exact: true,
      });
      await expect(composer).toBeVisible();
      const draft = "Keep this draft through archive and restore";
      if (action === "archive") await composer.fill(draft);
      const conversationUrl = page.url();
      const panel = panelFor(page);
      // Hold the real permission read to verify #482's loading contract:
      // a busy region without an action or status row before authority arrives.
      const permissionSeen = Promise.withResolvers();
      const permissionRelease = Promise.withResolvers();
      const holdPermissions = async (route) => {
        const filters = route.request().postDataJSON();
        if (
          filters.some(
            (filter) =>
              filter.kinds?.includes(39000) &&
              filter["#d"]?.includes(channelId) &&
              filter.limit === 1,
          )
        ) {
          permissionSeen.resolve();
          await permissionRelease.promise;
        }
        return route.continue();
      };
      if (action === "archive")
        await page.route("**/api/relay/**/query", holdPermissions);
      try {
        await openChannelDetails(page);
        if (action === "archive") {
          await permissionSeen.promise;
          await expect(panel).toHaveAttribute("aria-busy", "true");
          await expect(
            panel.getByRole("button", { name: /^Edit / }),
          ).toHaveCount(0);
          await expect(
            panel.getByText(/Checking channel permissions/),
          ).toHaveCount(0);
          await panel.screenshot({
            path: testInfo.outputPath("details-permission-loading.png"),
          });
        }
      } finally {
        permissionRelease.resolve();
      }
      await expect(
        panel.getByRole("button", { name: "Edit description", exact: true }),
      ).toBeEnabled();
      if (action === "archive")
        await page.unroute("**/api/relay/**/query", holdPermissions);
      const trigger = panel.getByRole("button", { name: label, exact: true });
      await expect(trigger).toBeVisible();
      const variant = action === "delete" ? "destructive" : "subtle";
      await expect(trigger).toHaveAttribute("data-variant", variant);
      await expect(
        panel.getByRole("button", { name: "Leave channel", exact: true }),
      ).toHaveCount(0);
      await panel.screenshot({
        path: testInfo.outputPath("management-actions.png"),
      });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name:
          action === "delete"
            ? "Delete Lifecycle channel?"
            : `${label}: Lifecycle channel`,
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: label, exact: true }),
      ).toHaveAttribute(
        "data-variant",
        action === "delete" ? "destructive" : "prominent",
      );
      await expect(
        dialog.getByRole("button", {
          name: "Cancel",
          exact: true,
        }),
      ).toBeFocused();
      await dialog.screenshot({
        path: testInfo.outputPath(`${action}-confirmation.png`),
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
      await trigger.click();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(trigger).toBeFocused();

      let release;
      let intercepted;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const seen = new Promise((resolve) => {
        intercepted = resolve;
      });
      await page.route(
        "**/api/relay/**/channel-lifecycle-sign",
        async (route) => {
          intercepted();
          await held;
          await route.continue();
        },
      );
      const republished = action === "delete" ? presenceAccepted() : undefined;
      try {
        await trigger.click();
        const confirm = dialog.getByRole("button", {
          name: label,
          exact: true,
        });
        await expect(confirm).toBeEnabled();
        await expect(dialog.getByRole("textbox")).toHaveCount(0);
        await confirm.click();
        await seen;
        await expect(dialog).toHaveCount(0);
        const pending = page.getByRole("dialog", {
          name:
            action === "archive" ? "Archiving channel…" : "Deleting channel…",
          exact: true,
        });
        await expect(pending).toBeVisible();
        await expect(pending).not.toHaveAttribute("aria-modal", "true");
        await expect(panel).toBeVisible();
        await expect(
          page.locator(`[data-channel-id="${channelId}"]`),
        ).toBeVisible();
        expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
      } finally {
        release();
      }
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("dialog", {
          name: `${action === "archive" ? "Channel archived" : "Channel deleted"}: Lifecycle channel`,
          exact: true,
        }),
      ).toBeVisible();
      await expect(row).toHaveCount(0);
      const destination =
        action === "archive"
          ? page.getByRole("complementary", {
              name: "Channel settings",
              exact: true,
            })
          : page.getByText("Select a channel to read it.", { exact: true });
      await expect(destination).toBeVisible();
      if (action === "archive") {
        await expect(page).toHaveURL(conversationUrl);
        await expect(
          panel.getByRole("button", { name: "Unarchive channel", exact: true }),
        ).toBeVisible();
        await expect(
          panel.getByRole("button", { name: "Archive channel", exact: true }),
        ).toHaveCount(0);
        await expect(
          panel.getByRole("button", { name: "Delete channel", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: "Close Channel settings tab",
            exact: true,
          }),
        ).toBeFocused();
        await expect(composer).toHaveCount(0);
        await expect(
          page.getByRole("region", { name: "Archived channel", exact: true }),
        ).toHaveText("This channel is archived");
        await expect(
          page.getByRole("button", { name: "Send message", exact: true }),
        ).toHaveCount(0);
      } else {
        await expect(panel).toHaveCount(0);
        await expect(sidebar.locator("button[data-channel-id]")).toHaveCount(0);
        await expect(
          page.getByRole("textbox", { name: /^Message #/ }),
        ).toHaveCount(0);
      }
      // Revocation restarts presence asynchronously. Wait through any admission
      // retry until accepted before reloading; visible UI is not that boundary.
      await republished;
      await page.reload();
      if (action === "archive") {
        await expect(page).toHaveURL(conversationUrl);
        await openChannelDetails(page);
        await expect(
          panel.getByRole("button", { name: "Unarchive channel", exact: true }),
        ).toBeVisible();
        await expect(composer).toHaveCount(0);
        await expect(
          page.getByRole("region", { name: "Archived channel", exact: true }),
        ).toHaveText("This channel is archived");
        await expect(
          page.getByRole("button", { name: "Send message", exact: true }),
        ).toHaveCount(0);
        await page
          .getByRole("button", {
            name: "Close Channel settings tab",
            exact: true,
          })
          .click();
        // Leave intentionally, then prove the explicit search return path.
        await sidebar
          .getByRole("button", { name: "Alpha", exact: true })
          .click();
      } else await expect(destination).toBeVisible();
      await expect(row).toHaveCount(0);
      expect(
        app.report.lifecyclePublications.map((event) => event.kind),
      ).toEqual([action === "archive" ? 9002 : 9008]);
      if (action === "archive") {
        // Complete the round trip through real search/navigation, not a synthetic
        // exact route: the archived row must remain reachable after reload.
        await page
          .getByRole("button", { name: "Search Buzz", exact: true })
          .click();
        const search = page.getByRole("dialog", {
          name: "Search Buzz",
          exact: true,
        });
        await expect(
          search
            .getByRole("group", { name: "Recent activity" })
            .getByRole("option", { name: /Lifecycle channel/ }),
        ).toHaveCount(0);
        await search.getByRole("combobox").fill("Lifecycle channel");
        await search
          .getByRole("option", {
            name: "Lifecycle channel Archived channel · 1 member",
            exact: true,
          })
          .click();
        await openChannelDetails(page);
        const restore = panel.getByRole("button", {
          name: "Unarchive channel",
          exact: true,
        });
        await expect(restore).toBeVisible();
        await expect(composer).toHaveCount(0);
        await expect(
          page.getByRole("region", { name: "Archived channel", exact: true }),
        ).toHaveText("This channel is archived");
        await expect(
          panel.getByRole("button", { name: "Archive channel", exact: true }),
        ).toHaveCount(0);
        await expect(
          panel.getByRole("button", { name: "Delete channel", exact: true }),
        ).toHaveCount(0);
        await panel.screenshot({
          path: testInfo.outputPath("unarchive-settings.png"),
        });
        await restore.click();
        const unarchive = page.getByRole("dialog", {
          name: "Unarchive channel: Lifecycle channel",
          exact: true,
        });
        await expect(
          unarchive.getByRole("button", {
            name: "Unarchive channel",
            exact: true,
          }),
        ).toHaveAttribute("data-variant", "prominent");
        await unarchive.screenshot({
          path: testInfo.outputPath("unarchive-confirmation.png"),
        });
        await page.keyboard.press("Escape");
        await expect(restore).toBeFocused();
        await restore.click();
        await expect(
          unarchive.getByRole("button", {
            name: "Unarchive channel",
            exact: true,
          }),
        ).toBeFocused();
        await page.mouse.click(8, 8);
        await expect(unarchive).toHaveCount(0);
        await expect(restore).toBeFocused();
        expect(app.report.lifecyclePublications).toHaveLength(1);
        await restore.click();
        await animationsSettled(unarchive);
        // Force the operation to finish before the confirmation's exit does.
        const exitGate = await unarchive.evaluateHandle((element) => {
          const state = { held: false, animations: [] };
          const observer = new MutationObserver(() => {
            if (!element.hasAttribute("data-ending-style")) return;
            for (const animation of element.getAnimations()) {
              animation.pause();
              state.animations.push(animation);
              state.held = true;
            }
          });
          observer.observe(element, {
            attributes: true,
            attributeFilter: ["data-ending-style"],
          });
          return {
            state,
            release() {
              observer.disconnect();
              for (const animation of state.animations) animation.finish();
            },
          };
        });
        try {
          await unarchive
            .getByRole("button", { name: "Unarchive channel", exact: true })
            .click();
          await expect
            .poll(() => exitGate.evaluate(({ state }) => state.held))
            .toBe(true);
          await expect(row).toBeVisible();
        } finally {
          await exitGate.evaluate((gate) => gate.release());
          await exitGate.dispose();
        }
        await expect(unarchive).toHaveCount(0);
        await expect(panel).toBeVisible();
        await expect(
          panel.getByRole("button", { name: "Archive channel", exact: true }),
        ).toBeVisible();
        await expect(
          panel.getByRole("button", { name: "Delete channel", exact: true }),
        ).toBeVisible();
        await expect(restore).toHaveCount(0);
        await expect(row).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Close Channel settings tab",
            exact: true,
          }),
        ).toBeFocused();
        await expect(composer).toBeVisible();
        await expect(composer).toBeEditable();
        await expect(composer).toHaveJSProperty("value", draft);
        await expect(
          page.getByRole("button", { name: "Send message", exact: true }),
        ).toBeEnabled();
        await page.reload();
        await expect(row).toBeVisible();
        await expect(composer).toBeVisible();
        await expect(composer).toBeEditable();
        await expect(composer).toHaveJSProperty("value", draft);
        await expect(
          page.getByRole("button", { name: "Send message", exact: true }),
        ).toBeEnabled();
        expect(
          app.report.lifecyclePublications.map((event) => event.tags),
        ).toEqual([
          [
            ["h", channelId],
            ["archived", "true"],
          ],
          [
            ["h", channelId],
            ["archived", "false"],
          ],
        ]);
      }
      expect(app.report.unexpected).toEqual([]);
    });
  });
}

// Production composition must apply owner-agent eligibility in both surfaces.
// Profile/role permutations and signing races stay in the lifecycle unit tests.
test.describe("owner-role agent without direct ownership", () => {
  // A plain member: Archive and Delete come only from owning the agent.
  test.use({ lifecycleRole: "member", lifecycleOwnerAgent: true });
  test("offers Archive and Delete in both surfaces, retains a rejected channel, then confirms removal", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const row = sidebar.getByRole("button", {
      name: "Lifecycle channel",
      exact: true,
    });
    await row.click();
    await expect(
      page.getByRole("textbox", {
        name: "Message #Lifecycle channel",
        exact: true,
      }),
    ).toBeVisible();
    await row.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", {
      name: "Actions for Lifecycle channel",
    });
    // Visible permitted actions are the completion barrier for negative assertions.
    await expect(
      menu.getByRole("menuitem", { name: "Archive channel", exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Leave channel", exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
    ).toBeVisible();
    await menu
      .getByRole("menuitem", { name: "Delete channel", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Delete Lifecycle channel?",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await openChannelDetails(page);
    const panel = panelFor(page);
    await expect(
      panel.getByRole("button", { name: "Archive channel", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Leave channel", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Delete channel", exact: true }),
    ).toBeVisible();
    const trigger = panel.getByRole("button", {
      name: "Delete channel",
      exact: true,
    });
    await trigger.click();
    // A signed profile and the relay's persisted ownership may disagree. Model
    // the exact negative delivery receipt at the host boundary, not a UI error.
    await page.route(
      "**/api/relay/**/channel-lifecycle-publish",
      async (route) => {
        const event = route.request().postDataJSON();
        expect(event.kind).toBe(9008);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            accepted: false,
            event_id: event.id,
            message: "Only the channel owner can delete",
          }),
        });
      },
      { times: 1 },
    );
    await dialog
      .getByRole("button", { name: "Delete channel", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const failure = page.getByRole("dialog", {
      name: "Delete channel failed",
      exact: true,
    });
    await expect(failure).toContainText("Only the channel owner can delete");
    await expect(
      page.locator(`[data-channel-id="${channelId}"]`),
    ).toBeVisible();
    expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
    await failure.getByRole("button", { name: "Dismiss notification" }).click();
    await trigger.click();
    await dialog
      .getByRole("button", { name: "Delete channel", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual(
      [9008],
    );
    expect(app.report.unexpected).toEqual([]);
  });
});
