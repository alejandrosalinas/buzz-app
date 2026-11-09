import { openChannelDetails } from "./channel-details.mjs";
import { openPage, settlePanelMotion } from "./navigation.mjs";
import { frames } from "./timeline.mjs";
import { test, expect } from "./fixture.mjs";
async function openLifecycle(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
}

test.use({
  enabledPlugins: ["buzz.workflows"],
  productionBroker: true,
  channelLifecycle: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Shared modal focus/escape and real menu -> modal handoff require a browser.
// Role/type/signing/cancellation matrices remain in domain and mounted tests.
test("archive confirmation returns focus on cancel and retains the conversation on completion", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await openLifecycle(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
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
  // Lifecycle actions come from the live roster, so the composed row menu is
  // complete when it opens and opening it reads no channel permissions.
  const permissionReads = [];
  const permissionRoute = async (route) => {
    const filters = route.request().postDataJSON();
    if (filters.some((filter) => filter.kinds?.includes(39001)))
      permissionReads.push(filters);
    await route.continue();
  };
  await page.route("**/api/relay/**/query", permissionRoute);
  const menu = page.getByRole("menu", {
    name: "Actions for Lifecycle channel",
  });
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Move channel",
    "Mute",
    "Mark as unread",
    "Copy link",
    "Archive channel",
    "Delete channel",
  ]);
  await expect(menu.getByRole("separator")).toHaveCount(0);
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  // The rendered lifecycle items are the barrier: a read would precede them.
  expect(permissionReads).toEqual([]);
  await expect(
    page.getByRole("button", { name: /More options for/ }),
  ).toHaveCount(0);
  for (const name of ["Archive channel", "Delete channel"]) {
    await expect(
      menu
        .getByRole("menuitem", { name, exact: true })
        .locator(".buzz-menu-icon svg"),
    ).toHaveCount(1);
  }
  await page.unroute("**/api/relay/**/query", permissionRoute);
  await expect(
    menu.getByRole("menuitem", { name: /^Leave channel/ }),
  ).toHaveCount(0);
  await expect(
    menu.getByText("Transfer ownership before leaving the channel."),
  ).toHaveCount(0);
  await menu.screenshot({ path: testInfo.outputPath("lifecycle-menu.png") });
  await menu
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Archive channel: Lifecycle channel",
  });
  await expect(dialog).toBeVisible();
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  // Pointer entry still shows what Enter will activate without swapping emphasis.
  await expect(cancel).toHaveCSS("outline-style", "solid");
  await expect(cancel).toHaveCSS("outline-width", "2px");
  await expect(cancel).toHaveAttribute("data-variant", "subtle");
  await expect(
    dialog.getByRole("button", { name: "Archive channel", exact: true }),
  ).toHaveAttribute("data-variant", "prominent");
  await dialog.screenshot({
    path: testInfo.outputPath("lifecycle-confirmation.png"),
  });
  await dialog.getByRole("heading").click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
  await row.click({ button: "right" });
  await menu
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await row.click();
  await row.click({ button: "right" });
  await menu
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  const conversationUrl = page.url();
  await dialog
    .getByRole("button", { name: "Archive channel", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(page).toHaveURL(conversationUrl);
  await openChannelDetails(page);
  await expect(
    page.getByRole("button", { name: "Unarchive channel", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(app.report.lifecyclePublications).toHaveLength(1);
  expect(app.report.lifecyclePublications[0].kind).toBe(9002);
  expect(app.report.unexpected).toEqual([]);
});

// The production page must project the separate per-viewer visibility snapshot
// after remount/reload, while membership/authorized channel reads remain intact.
test("DM hide is per-viewer visibility, survives reload and never sends Leave or Delete", async ({
  page,
  app,
}) => {
  await openLifecycle(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.locator(
    '[data-channel-id="22222222-2222-4222-8222-222222222222"]',
  );
  await expect(row).toBeVisible();
  await row.click();
  const composer = page.getByRole("textbox", { name: /^Message #/ });
  await expect(composer).toBeVisible();
  const composerName = await composer.getAttribute("aria-label");
  const conversationUrl = page.url();
  await row.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Hide conversation", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Leave channel", exact: true }),
  ).toHaveCount(0);
  await menu
    .getByRole("menuitem", { name: "Hide conversation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Hide conversation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(
    sidebar.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeVisible();
  // Wait for the actual visibility read to complete before asserting absence.
  await expect
    .poll(
      () =>
        app.report.queries.filter((query) =>
          JSON.stringify(query).includes("30622"),
        ).length,
    )
    .toBeGreaterThan(1);
  await expect(row).toHaveCount(0);
  // A hidden row is not an access denial. Exact navigation still opens its messages.
  await page.goto(conversationUrl);
  await expect(
    page.getByRole("textbox", { name: composerName, exact: true }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual([
    41012,
  ]);
  expect(app.report.unexpected).toEqual([]);
});

// Delete takes the access-purge route (archive does not), across the real broker,
// session, native dialog and navigation. Role permutations remain below the browser.
test("delete confirmation without typing purges the selected channel and survives reload", async ({
  page,
  app,
}) => {
  await openLifecycle(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
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
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete Lifecycle channel?",
  });
  const confirm = dialog.getByRole("button", {
    name: "Delete channel",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(confirm).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  // Its neighbor (not the sidebar's first row) takes its place, so a long
  // sidebar does not scroll away from where the channel was. It opens as it
  // does from its row: current, with its composer focused.
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeFocused();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual([
    9008,
  ]);
  expect(app.report.unexpected).toEqual([]);
});

// Last-row removal crosses sidebar/page ownership. Keep retained membership in
// the fixture so an ordinary saved/first-channel fallback cannot look correct.
for (const action of ["archive", "hide"]) {
  test.describe(`last visible row: ${action}`, () => {
    const channel = "11111111-1111-4111-8111-111111111111";
    const dm = "22222222-2222-4222-8222-222222222222";
    const id = action === "archive" ? channel : dm;
    const label =
      action === "archive" ? "Archive channel" : "Hide conversation";
    test.use({
      lifecycleVisibility: {
        archived: ["alpha", "beta", ...(action === "hide" ? [channel] : [])],
        hidden: action === "archive" ? [dm] : [],
      },
    });
    test("completion preserves the appropriate destination with no visible rows, including reload", async ({
      page,
      app,
    }) => {
      await page.goto(app.origin);
      await openPage(page, "Messages");
      const sidebar = page.getByRole("navigation", {
        name: "Subscribed channels",
      });
      const rows = sidebar.locator("button[data-channel-id]");
      await expect(rows).toHaveCount(1);
      const row = sidebar.locator(`button[data-channel-id="${id}"]`);
      await row.click();
      const composer = page.getByRole("textbox", { name: /^Message #/ });
      await expect(composer).toBeVisible();
      const composerName = await composer.getAttribute("aria-label");
      const exactUrl = page.url();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: label, exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const destination =
        action === "archive"
          ? page.getByRole("button", { name: "Channel actions", exact: true })
          : page.getByText("Select a channel to read it.", { exact: true });
      await expect(destination).toBeVisible();
      if (action === "archive") await expect(page).toHaveURL(exactUrl);
      await expect(rows).toHaveCount(0);
      if (action === "archive") {
        await expect(composer).toHaveCount(0);
        await expect(
          page.getByRole("region", { name: "Archived channel", exact: true }),
        ).toHaveText("This channel is archived");
      } else await expect(composer).toHaveCount(0);
      await page.reload();
      await expect(destination).toBeVisible();
      if (action === "archive") {
        await expect(page).toHaveURL(exactUrl);
        await openChannelDetails(page);
        await expect(
          page.getByRole("button", { name: "Unarchive channel", exact: true }),
        ).toBeVisible();
      }
      await expect(rows).toHaveCount(0);
      if (action === "archive") {
        await expect(composer).toHaveCount(0);
        await expect(
          page.getByRole("region", { name: "Archived channel", exact: true }),
        ).toHaveText("This channel is archived");
      } else await expect(composer).toHaveCount(0);
      expect(
        app.report.lifecyclePublications.map((event) => event.kind),
      ).toEqual([action === "archive" ? 9002 : 41012]);
      if (action === "hide") {
        // Empty intent must not turn visibility into an access restriction.
        await page.goto(exactUrl);
        await expect(
          page.getByRole("textbox", { name: composerName, exact: true }),
        ).toBeVisible();
        await expect(rows).toHaveCount(0);
      }
      expect(app.report.unexpected).toEqual([]);
    });
  });
}

// Pending actions release the modal without blocking narrow navigation.
// A browser proves the page remains usable after an uncertain result.
test("pending toast in narrow navigation preserves visible recovery after uncertainty", async ({
  page,
  app,
}) => {
  await openLifecycle(page, app);
  await page.setViewportSize({ width: 600, height: 800 });
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  const row = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Lifecycle channel", exact: true });
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Archive channel: Lifecycle channel",
  });
  const { promise: held, resolve: release } = Promise.withResolvers();
  const { promise: seen, resolve: intercepted } = Promise.withResolvers();
  await page.route(
    "**/api/relay/**/channel-lifecycle-publish",
    async (route) => {
      intercepted();
      await held;
      // An unbound receipt is uncertain. Do not publish to the fixture relay.
      await route.fulfill({
        json: { accepted: true, event_id: "wrong-event" },
      });
    },
  );
  try {
    await dialog
      .getByRole("button", { name: "Archive channel", exact: true })
      .click();
    await seen;
    await expect(dialog).toHaveCount(0);
    const pending = page.getByRole("dialog", {
      name: "Archiving channel…",
      exact: true,
    });
    await expect(pending).toBeVisible();
    await expect(pending).not.toHaveAttribute("aria-modal", "true");
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeEnabled();
  } finally {
    release();
  }
  const failure = page.getByRole("dialog", {
    name: "Archive channel failed",
    exact: true,
  });
  await expect(failure).toContainText("The request may have taken effect.");
  await expect(
    failure.getByRole("button", { name: "Archive channel", exact: true }),
  ).toHaveCount(0);
  await failure.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(failure).toHaveCount(0);
  // Recovery must leave the page usable, not silently inert under a hidden modal.
  await page
    .getByRole("button", { name: "Hide navigation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Show navigation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  expect(app.report.unexpected).toEqual([]);
});

// Browser-only: recover an archived Solo chat after leaving its URL via the real
// search -> header -> Settings route. The empty Solo chat has no message fallback.
test.describe("Solo chat lifecycle", () => {
  test.use({ soloChannels: ["11111111-1111-4111-8111-111111111111"] });

  test("sidebar and header manage a Solo chat and recover it through name search", async ({
    page,
    app,
  }) => {
    await openLifecycle(page, app);
    const row = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .getByRole("button", { name: "Lifecycle channel", exact: true });
    await row.click();
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
    });
    await expect(composer).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Share access to /, exact: true }),
    ).toBeVisible();
    const url = page.url();
    await row.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", {
      name: "Actions for Lifecycle channel",
    });
    await menu
      .getByRole("menuitem", { name: "Delete chat", exact: true })
      .click();
    const deletion = page.getByRole("dialog", {
      name: "Delete Lifecycle channel?",
    });
    await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(deletion).toHaveCount(0);
    await expect(row).toBeFocused();
    expect(app.report.lifecyclePublications ?? []).toHaveLength(0);

    const header = page.getByRole("button", {
      name: "Chat actions",
      exact: true,
    });
    await header.click();
    await page
      .getByRole("menuitem", { name: "Archive chat", exact: true })
      .click();
    // Archiving a chat needs no confirmation; its result toast offers Undo.
    await expect(
      page.getByRole("dialog", { name: "Chat archived: Lifecycle channel" }),
    ).toBeVisible();
    await expect(row).toHaveCount(0);
    // Archiving an open Solo conversation now hands off to a new Solo draft.
    await expect(page).not.toHaveURL(url);
    // The retained address must still support archived-history recovery.
    await page.goto(url);
    await expect(
      page.getByRole("region", { name: "Archived chat", exact: true }),
    ).toHaveText("This chat is archived");
    await expect(composer).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Share access to /, exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Archived chat", exact: true }),
    ).toHaveText("This chat is archived");
    await expect(composer).toHaveCount(0);
    await expect(page).toHaveURL(url);
    await page
      .getByRole("navigation", { name: "Subscribed channels" })
      .getByRole("button", { name: "Alpha", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(url);
    await page
      .getByRole("button", { name: "Search Buzz", exact: true })
      .click();
    const search = page.getByRole("dialog", { name: "Search Buzz" });
    await search
      .getByRole("combobox", { name: "Search Buzz" })
      .fill("Lifecycle channel");
    const result = search
      .getByRole("group", { name: "Chats" })
      .getByRole("option", { name: /Lifecycle channel/ });
    await expect(result).toContainText("Archived chat");
    await result.click();
    await expect(search).toHaveCount(0);
    await expect(page).toHaveURL(url);
    await expect(
      page.getByRole("region", { name: "Archived chat", exact: true }),
    ).toHaveText("This chat is archived");
    await expect(composer).toHaveCount(0);
    await header.click();
    await expect(
      page.getByRole("button", { name: "View members" }),
    ).toHaveCount(0);
    await page
      .getByRole("menuitem", { name: "Unarchive chat", exact: true })
      .click();
    const restore = page.getByRole("dialog", {
      name: "Unarchive chat: Lifecycle channel",
    });
    await restore
      .getByRole("button", { name: "Unarchive chat", exact: true })
      .click();
    await expect(restore).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(composer).toBeEnabled();
    await expect(
      page.getByRole("button", { name: /^Share access to /, exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(url);
    await header.click();
    await page
      .getByRole("menuitem", { name: "Delete chat", exact: true })
      .click();
    await deletion
      .getByRole("button", { name: "Delete chat", exact: true })
      .click();
    await expect(deletion).toHaveCount(0);
    await expect(row).toHaveCount(0);
    expect(
      app.report.lifecyclePublications.map((event) => [event.kind, event.tags]),
    ).toEqual([
      [
        9002,
        [
          ["h", "11111111-1111-4111-8111-111111111111"],
          ["archived", "true"],
        ],
      ],
      [
        9002,
        [
          ["h", "11111111-1111-4111-8111-111111111111"],
          ["archived", "false"],
        ],
      ],
      [9008, [["h", "11111111-1111-4111-8111-111111111111"]]],
    ]);
    expect(app.report.unexpected).toEqual([]);
  });
});

// Native focus after a signed remote update removes a form is a browser contract.
// Each surface exercises editor, toolbar and unrelated focus in one lifecycle.
test.describe("remote archive focus", () => {
  test.use({ readState: true, threadUnread: true });
  for (const surface of ["channel", "thread"]) {
    test(`remote archive preserves ${surface} focus and offers active unsent text for copying`, async ({
      page,
      app,
    }, testInfo) => {
      // Intercept only the OS clipboard boundary; the app uses its shared owner.
      await page.addInitScript(() => {
        window.copiedArchiveText = [];
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text) => window.copiedArchiveText.push(text),
          },
        });
      });
      await page.goto(app.origin);
      await openPage(page, "Messages");
      await page
        .getByRole("navigation", { name: "Subscribed channels" })
        .locator('button[data-channel-id="alpha"]')
        .click();
      const panel = page.getByRole("complementary", {
        name: "Thread",
        exact: true,
      });
      if (surface === "thread") {
        const root = app.histories
          .get("primary/alpha")
          .find((event) => event.content === "Thread root 0");
        await page
          .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
          .getByRole("button", { name: /^View thread:/ })
          .click();
      }
      const owner =
        surface === "thread" ? panel : page.locator("[data-channel-history]");
      const history = owner.getByRole("region", {
        name:
          surface === "thread" ? "Thread messages" : "Channel message history",
        exact: true,
      });
      const editor =
        surface === "thread"
          ? panel.getByRole("textbox", { name: "Reply to thread", exact: true })
          : page.getByRole("textbox", { name: "Message #Alpha", exact: true });
      const form = (surface === "thread" ? panel : page).locator(
        "[data-composer-surface]",
      );
      const notice = owner.getByRole("region", {
        name: "Archived channel",
        exact: true,
      });
      const elsewhere = page.getByRole("button", {
        name: "Search Buzz",
        exact: true,
      });
      if (surface === "thread") {
        await settlePanelMotion(page);
        await expect(history).toHaveAttribute("aria-busy", "false");
      }
      let timestamp = Math.floor(Date.now() / 1000);
      for (const focus of ["editor", "toolbar", "empty", "elsewhere"]) {
        await expect(editor).toBeVisible();
        const draft =
          focus === "empty" ? "" : `Unsent ${surface} **${focus}** text`;
        await editor.fill(draft);
        await expect(editor).toHaveJSProperty("value", draft);
        const target =
          focus === "elsewhere"
            ? elsewhere
            : focus === "toolbar"
              ? form.getByRole("button", { name: "Attach files", exact: true })
              : editor;
        await target.focus();
        await expect(target).toBeFocused();
        app.relay.publish(
          "primary",
          app.signRelay({
            kind: 39000,
            tags: [
              ["d", "alpha"],
              ["name", "Alpha"],
              ["t", "stream"],
              ["archived", "true"],
            ],
            content: "",
            created_at: ++timestamp,
          }),
        );
        await expect(notice).toHaveText("This channel is archived");
        await expect(editor).toHaveCount(0);
        await frames(page);
        await expect(focus === "elsewhere" ? elsewhere : history).toBeFocused();
        const copy = page.getByRole("button", {
          name: "Copy text",
          exact: true,
        });
        if (draft && focus !== "elsewhere") {
          await expect(copy).toBeInViewport({ ratio: 1 });
          if (focus === "editor") {
            const toast = page
              .locator("[data-sonner-toast]")
              .filter({ has: copy });
            await expect(toast).toHaveAttribute("data-mounted", "true");
            await toast.evaluate((node) =>
              Promise.all(
                node
                  .getAnimations({ subtree: true })
                  .map((animation) => animation.finished.catch(() => {})),
              ),
            );
            await page.screenshot({
              path: testInfo.outputPath(`${surface}-archive-copy.png`),
            });
            // The toast action remains reachable with the keyboard after handoff.
            await copy.focus();
            await copy.press("Enter");
          } else {
            await copy.click();
          }
          await expect
            .poll(() => page.evaluate(() => window.copiedArchiveText.at(-1)))
            .toBe(draft);
          const success = page.getByRole("dialog", {
            name: "Text copied",
            exact: true,
          });
          await expect(success).toBeVisible();
          await success
            .getByRole("button", { name: "Dismiss notification", exact: true })
            .click();
        } else {
          await expect(copy).toHaveCount(0);
        }
        const retainedFocus = focus === "elsewhere" ? elsewhere : history;
        await retainedFocus.focus();
        await expect(retainedFocus).toBeFocused();
        app.relay.publish(
          "primary",
          app.signRelay({
            kind: 39000,
            tags: [
              ["d", "alpha"],
              ["name", "Alpha"],
              ["t", "stream"],
            ],
            content: "",
            created_at: ++timestamp,
          }),
        );
        await expect(notice).toHaveCount(0);
        await expect(editor).toHaveJSProperty("value", draft);
        await frames(page);
        await expect(retainedFocus).toBeFocused();
      }
      expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
      expect(app.report.unexpected).toEqual([]);
    });
  }
});

// A fresh composer must not override native focus in an already-open archived Solo visit.
test.describe("remote Solo unarchive", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  test.use({
    soloChannels: [id],
    lifecycleVisibility: { archived: [id], hidden: [] },
  });
  test("retains history and outside focus when remote unarchive restores composition", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page
      .getByRole("button", { name: "Search Buzz", exact: true })
      .click();
    const search = page.getByRole("dialog", {
      name: "Search Buzz",
      exact: true,
    });
    await search
      .getByRole("combobox", { name: "Search Buzz" })
      .fill("Lifecycle channel");
    await search
      .getByRole("group", { name: "Chats" })
      .getByRole("option", { name: /Lifecycle channel/ })
      .click();
    const notice = page.getByRole("region", {
      name: "Archived chat",
      exact: true,
    });
    await expect(notice).toHaveText("This chat is archived");
    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    // This minimal archived chat is empty; its settled empty state ends startup.
    await expect(
      history.getByRole("heading", { name: "No messages yet.", exact: true }),
    ).toBeVisible();
    await expect(history).not.toHaveAttribute(
      "data-buzz-launch-pending",
      "settling",
    );
    const outside = page.getByRole("button", {
      name: "Search Buzz",
      exact: true,
    });
    const editor = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    const tags = [
      ["d", id],
      ["name", "Lifecycle channel"],
      ["t", "stream"],
      ["t", "buzz.solo"],
      ["private"],
      ["P", app.channelMetadata(id, []).pubkey],
    ];
    let timestamp = Math.floor(Date.now() / 1000);
    for (const target of [history, outside]) {
      await target.focus();
      await expect(target).toBeFocused();
      app.relay.publish(
        "primary",
        app.signRelay({
          kind: 39000,
          tags,
          content: "",
          created_at: ++timestamp,
        }),
      );
      await expect(notice).toHaveCount(0);
      await expect(editor).toBeVisible();
      await frames(page);
      await expect(target).toBeFocused();
      await outside.focus();
      app.relay.publish(
        "primary",
        app.signRelay({
          kind: 39000,
          tags: [...tags, ["archived", "true"]],
          content: "",
          created_at: ++timestamp,
        }),
      );
      await expect(notice).toHaveText("This chat is archived");
    }
    expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
    expect(app.report.unexpected).toEqual([]);
  });
});

// Browser-only: Playwright clicks scroll items into view, so only layout shows
// whether the shared menu clips a permitted action behind a hidden scrollbar.
test.describe("Solo chat owned through its agent", () => {
  test.use({
    soloChannels: ["11111111-1111-4111-8111-111111111111"],
    lifecycleRole: "member",
    lifecycleOwnerAgent: true,
    readState: true,
  });
  test("shows every lifecycle action without scrolling the menu", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const row = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .getByRole("button", { name: "Lifecycle channel", exact: true });
    await row.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", {
      name: "Actions for Lifecycle channel",
    });
    // The owner-agent grant offers all three to a plain member.
    for (const name of ["Leave chat", "Archive chat", "Delete chat"])
      await expect(
        menu.getByRole("menuitem", { name, exact: true }),
      ).toBeInViewport({ ratio: 1 });
    // At the default text scale, the old 24rem cap clipped this menu by its
    // fixed-pixel parts; larger text grows rows and a rem cap alike.
    expect(
      await menu.evaluate((popup) => popup.scrollHeight - popup.clientHeight),
    ).toBe(0);
    expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
    expect(app.report.unexpected).toEqual([]);
  });
});
