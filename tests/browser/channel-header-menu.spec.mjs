import { checkDurationConsumer } from "./duration-layout.mjs";
import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

const channelId = "11111111-1111-4111-8111-111111111111";
const channelName = "channel-management-and-collaboration-with-a-long-name";

test.use({
  productionBroker: true,
  developmentReact: true,
  channelLifecycle: true,
  channelNames: { [channelId]: channelName },
  historyCounts: { alpha: 2, beta: 1 },
});

// The production header, portal, management pane and persistent sidebar dialog
// share real browser focus/geometry. Permission permutations stay in Vitest.
test("header actions use the full-size menu and retain pane/dialog focus owners", async ({
  page,
  app,
  browserName,
  context,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .locator('button[data-channel-id="11111111-1111-4111-8111-111111111111"]')
    .click();
  // The header identity fills the title slot: a long name truncates only when
  // the header runs out of room, not at the tab strip's 12rem cap.
  const heading = page.getByRole("button", {
    name: `Manage members of ${channelName}`,
    exact: true,
  });
  await expect(heading).toBeVisible();
  await expect
    .poll(
      () =>
        heading
          .getByText(channelName, { exact: true })
          .evaluate((label) => label.scrollWidth <= label.clientWidth),
      "the header title shows the whole channel name",
    )
    .toBe(true);
  const trigger = page.getByRole("button", {
    name: "Channel actions",
    exact: true,
  });
  const menu = page.getByRole("menu", { name: "Channel actions", exact: true });
  const settings = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(menu).toHaveAttribute("data-size", "default");
  await expect(menu.getByRole("menuitem").first()).toHaveText(
    "View channel details",
  );
  await expect(
    menu.getByRole("menuitem", { name: "View channel details", exact: true }),
  ).toBeFocused();
  await expect(
    menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Leave channel", exact: true }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
  ).toHaveAttribute("data-tone", "danger");
  await expect(
    menu.getByRole("menuitem", { name: /Edit details|Review pending changes/ }),
  ).toHaveCount(0);
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  await menu.screenshot({
    path: testInfo.outputPath("channel-header-menu.png"),
  });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu).toBeVisible();
  // Click the real outside-dismiss layer, not a covered underlying control.
  await page.mouse.click(4, 4);
  await expect(menu).toHaveCount(0);
  await trigger.click();
  for (const label of [
    "View channel details",
    "View canvas",

    "Archive channel",
    "Delete channel",
  ]) {
    const item = menu.getByRole("menuitem", { name: label, exact: true });
    await expect(item).toBeEnabled();
    const box = await item.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 5,
    });
    if (browserName === "webkit") {
      // Playwright WebKit reports zero movementX/Y even when client coordinates
      // change. Base UI intentionally ignores those events (stationary scrolling).
      // Supply the missing delta to exercise the real handler, not a CSS/focus shim.
      await item.dispatchEvent("mousemove", { movementX: 1, movementY: 1 });
    }
    await expect(item).toHaveAttribute("data-highlighted", "");
    await expect(menu.locator("[data-highlighted]")).toHaveCount(1);
  }
  await page.keyboard.press("Escape");
  await openChannelDetails(page);
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Canvas", exact: true }),
  ).toHaveCount(0);
  await openChannelDetails(page);
  await expect(settings).toBeVisible();
  await expect(
    page
      .locator("[data-panel-workspace]")
      .getByRole("tab", { name: "Channel settings", exact: true }),
  ).toBeFocused();
  await expect(settings.getByText("Channel type", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    settings.getByRole("button", { name: "Edit details", exact: true }),
  ).toHaveCount(0);
  const checkInlineIcon = async (action, { wholeRow = true } = {}) => {
    const row = action.locator("xpath=../..");
    const icon = action.locator("svg");
    const affordance = icon.locator("..");
    await action.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expect(affordance).toHaveCSS("opacity", "0");
    await expect(affordance).toHaveCSS(
      "transform",
      "matrix(1, 0, 0, 1, -4, 0)",
    );
    await expect(affordance).toHaveAttribute("aria-hidden", "true");
    await expect(icon).toHaveAttribute("width", "0.875rem");
    await expect(action.getByText(/^(Edit|Copy)$/)).toHaveCount(0);
    const before = await row.boundingBox();
    // A whole-row action reveals from the value/padding, not just its label.
    if (wholeRow)
      await page.mouse.move(
        before.x + before.width / 2,
        before.y + before.height - 8,
      );
    else await action.hover();
    await expect(affordance).toHaveCSS("opacity", "1");
    await expect(affordance).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    expect(await row.boundingBox()).toEqual(before);
    const geometry = await action.evaluate((node) => {
      // Measure the flex item's box, not a text Range's engine-specific glyph bounds.
      const label =
        node.firstElementChild.firstElementChild.getBoundingClientRect();
      const artwork = node.querySelector("svg").getBoundingClientRect();
      return {
        gap: artwork.left - label.right,
        centerOffset:
          artwork.y + artwork.height / 2 - (label.y + label.height / 2),
      };
    });
    expect(geometry.gap).toBe(8);
    expect(Math.abs(geometry.centerOffset)).toBeLessThan(2);
    await page.mouse.move(0, 0);
    await expect(affordance).toHaveCSS("opacity", "0");
    // Establish keyboard modality without assuming macOS WebKit's Tab policy.
    await page.keyboard.press("Tab");
    await action.focus();
    await expect(action).toBeFocused();
    await expect(affordance).toHaveCSS("opacity", "1");
    await expect(row).toHaveCSS("outline-style", "none");
    await row.screenshot({
      path: testInfo.outputPath("metadata-keyboard-focus.png"),
    });
  };
  for (const label of ["Edit description", "View members"]) {
    const action = settings.getByRole("button", { name: label, exact: true });
    const row = action.locator("xpath=../..");
    // The description's value holds its own links, so only its label edits.
    const wholeRow = label === "View members";
    await action.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const resting = await row.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    const box = await row.boundingBox();
    const background = () =>
      row.evaluate((node) => getComputedStyle(node).backgroundColor);
    if (wholeRow) {
      // Hit the value/padding below the text control, not just its label.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
      await expect.poll(background).not.toBe(resting);
    } else {
      // Hover the value text. The revealed pencil proves the row is hovered,
      // but only the label takes the click, so the row stays unpainted.
      const value = await row.locator("dd").boundingBox();
      await page.mouse.move(value.x + 4, value.y + value.height / 2);
      await expect(action.locator("svg").locator("..")).toHaveCSS(
        "opacity",
        "1",
      );
      expect(await background()).toBe(resting);
      // Hovering the label itself doesn't paint the whole row either.
      await action.hover();
      await expect
        .poll(() => action.evaluate((node) => node.matches(":hover")))
        .toBe(true);
      expect(await background()).toBe(resting);
    }
    await expect(action).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(action).toHaveCSS("padding", "0px");
    if (label === "View members") {
      await expect(action.getByText("Edit", { exact: true })).toHaveCount(0);
      await expect(action.locator("svg")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    } else {
      await checkInlineIcon(action, { wholeRow });
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
    const dialog = page.getByRole("dialog", {
      name:
        label === "View members" ? "Manage members" : "Edit channel details",
      exact: true,
    });
    if (!wholeRow) {
      await expect(dialog).toHaveCount(0);
      await action.click();
    }
    await expect(dialog).toBeVisible();
    await expect(
      label === "View members"
        ? dialog.getByRole("searchbox")
        : dialog.getByRole("textbox", {
            name: label === "Edit description" ? "Description" : "Name",
            exact: true,
          }),
    ).toBeFocused();
    if (label === "Edit description") {
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    } else {
      await page.keyboard.press("Escape");
    }
    await expect(dialog).toHaveCount(0);
    await expect(action).toBeFocused();
    await expect(settings).toBeVisible();
  }
  const title = settings.getByRole("button", {
    name: "Edit channel name",
    exact: true,
  });
  const pencil = title.locator("svg").locator("..");
  await page.mouse.move(0, 0);
  await expect(pencil).toHaveCSS("opacity", "0");
  await expect(pencil).toHaveCSS("transform", "matrix(1, 0, 0, 1, -4, 0)");
  const titleBefore = await title.boundingBox();
  await title.hover();
  await expect(pencil).toHaveCSS("opacity", "1");
  await expect(pencil).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  expect(await title.boundingBox()).toEqual(titleBefore);
  const checkTitleGeometry = async () => {
    const geometry = await title.evaluate((node) => {
      const textNode = node.querySelector("span");
      const range = document.createRange();
      range.selectNodeContents(textNode.firstChild);
      const lines = [...range.getClientRects()].filter(
        (rect) => rect.width > 0,
      );
      const text = range.getBoundingClientRect();
      const last = lines.at(-1);
      const icon = node.querySelector("svg").getBoundingClientRect();
      const parent = node.parentElement.parentElement.getBoundingClientRect();
      return {
        textCenter: text.x + text.width / 2,
        center: parent.x + parent.width / 2,
        textHeight: text.height,
        lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
        iconRight: icon.right,
        iconLeft: icon.left,
        iconCenterY: icon.y + icon.height / 2,
        lastRight: last.right,
        lastTop: last.top,
        lastBottom: last.bottom,
        parentRight: parent.right,
      };
    });
    expect(Math.abs(geometry.textCenter - geometry.center)).toBeLessThan(1);
    expect(geometry.iconRight).toBeLessThanOrEqual(geometry.parentRight);
    expect(geometry.iconLeft - geometry.lastRight).toBeGreaterThan(0);
    expect(geometry.iconLeft - geometry.lastRight).toBeLessThan(12);
    expect(geometry.iconCenterY).toBeGreaterThan(geometry.lastTop);
    expect(geometry.iconCenterY).toBeLessThan(geometry.lastBottom);
    return geometry;
  };
  await checkTitleGeometry();
  await page.mouse.move(0, 0);
  await title.focus();
  await expect(pencil).toHaveCSS("opacity", "1");
  await title.press("Enter");
  const nameEditor = page.getByRole("dialog", {
    name: "Edit channel details",
    exact: true,
  });
  await expect(
    nameEditor.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeFocused();
  await nameEditor
    .getByRole("radio", { name: "Temporary", exact: true })
    .click();
  await checkDurationConsumer(page, nameEditor, "edit-duration", testInfo, {
    nextControl: nameEditor.getByRole("button", {
      name: "Cancel",
      exact: true,
    }),
  });
  await nameEditor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(title).toBeFocused();
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  const copy = settings.getByRole("button", {
    name: "Copy channel id",
    exact: true,
  });
  await checkInlineIcon(copy);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const idRow = copy.locator("xpath=../..");
  const rowHeight = (await idRow.boundingBox()).height;
  const idBox = await idRow.boundingBox();
  await page.mouse.click(idBox.x + idBox.width / 2, idBox.y + idBox.height - 8);
  await expect(page.getByRole("tooltip")).toHaveText("Channel ID copied");
  expect((await idRow.boundingBox()).height).toBe(rowHeight);
  await expect(settings.getByText("Channel ID copied")).toHaveCount(0);
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      channelId,
    );
  }
  // Once dismissed, a previous copy result must not reopen on hover/focus.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await copy.hover();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const descriptionAction = settings.getByRole("button", {
    name: "Edit description",
    exact: true,
  });
  await descriptionAction.hover();
  await expect(descriptionAction.locator("svg").locator("..")).toHaveCSS(
    "opacity",
    "1",
  );
  await settings.screenshot({
    path: testInfo.outputPath("channel-details-actions.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await title.hover();
  const narrow = await checkTitleGeometry();
  expect(narrow.textHeight).toBeGreaterThan(narrow.lineHeight);
  await settings.screenshot({
    path: testInfo.outputPath("channel-details-title-narrow.png"),
  });
  // Reduced-motion users get immediate reveal without translation or fading.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const descriptionIcon = descriptionAction.locator("svg").locator("..");
  await expect(descriptionIcon).toHaveCSS("transition-duration", "0s");
  await expect(descriptionIcon).toHaveCSS("transform", "none");
  await descriptionAction.hover();
  await expect(descriptionIcon).toHaveCSS("opacity", "1");
  await expect(descriptionIcon).toHaveCSS("transform", "none");
  await expect(pencil).toHaveCSS("transition-duration", "0s");
  await expect(pencil).toHaveCSS("transform", "none");
  await title.hover();
  await expect(pencil).toHaveCSS("opacity", "1");
  await expect(pencil).toHaveCSS("transform", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 950 });
  await page
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu
    .getByRole("menuitem", { name: "View canvas", exact: true })
    .click();
  const canvas = page.getByRole("region", {
    name: "Channel Canvas",
    exact: true,
  });
  await expect(canvas).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close Canvas tab", exact: true }),
  ).toBeEnabled();
  await expect(
    canvas.getByRole("article", { name: "Saved Canvas" }),
  ).toBeVisible();
  await canvas.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(
    canvas.getByRole("textbox", { name: "Canvas Markdown", exact: true }),
  ).toBeEnabled();
  await expect(menu).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close Canvas tab", exact: true })
    .click();
  await expect(canvas).toHaveCount(0);
  await expect(trigger).toBeFocused();
  for (const label of ["Archive channel", "Delete channel"]) {
    await trigger.click();
    await menu.getByRole("menuitem", { name: label, exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name:
        label === "Delete channel"
          ? `Delete ${channelName}?`
          : `${label}: ${channelName}`,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(menu).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(
    menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
  ).toBeVisible();
  await expect(menu).toBeInViewport({ ratio: 1 });
  await menu.screenshot({
    path: testInfo.outputPath("channel-header-menu-narrow.png"),
  });
  await page.keyboard.press("Escape");
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  expect(app.report.unexpected).toEqual([]);
});

// Browser seam: sidebar-owned actions render under the header portal, move rows
// without stealing header focus, and hand modal/session focus to the existing owners.
test.describe("sidebar actions in the header", () => {
  test.use({ channelLifecycle: false, savedSidebar: true, readState: true });
  test("shares move, mute and read actions without transferring focus to the sidebar", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page.locator('button[data-channel-id="beta"]').click();
    const trigger = page.getByRole("button", {
      name: "Channel actions",
      exact: true,
    });
    const menu = page.getByRole("menu", {
      name: "Channel actions",
      exact: true,
    });
    const openMove = async () => {
      await trigger.click();
      const move = menu.getByRole("menuitem", {
        name: "Move channel",
        exact: true,
      });
      await move.focus();
      await page.keyboard.press("ArrowRight");
      return page.getByRole("menu", {
        name: "Move Beta to section",
        exact: true,
      });
    };
    let move = await openMove();
    await expect(move).toHaveAttribute("data-size", "default");
    await expect(
      move.getByRole("menuitemradio", { name: "Work", exact: true }),
    ).toBeChecked();
    await move
      .getByRole("menuitem", { name: "Create new…", exact: true })
      .click();
    const create = page.getByRole("dialog", {
      name: "Move to new section",
      exact: true,
    });
    await expect(
      create.getByRole("textbox", { name: "Section name" }),
    ).toBeFocused();
    await expect(menu).toHaveCount(0);
    await create.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
    move = await openMove();
    const saved = page.waitForResponse("**/sidebar-star");
    await move
      .getByRole("menuitemradio", { name: "Starred", exact: true })
      .click();
    await saved;
    await expect(menu).toHaveCount(0);
    await expect(
      page.locator(
        '[data-sidebar-section="starred"] button[data-channel-id="beta"]',
      ),
    ).toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    const muted = page.waitForResponse("**/sidebar-mute");
    await menu.getByRole("menuitem", { name: "Mute", exact: true }).click();
    await muted;
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(
      menu.getByRole("menuitem", { name: "Unmute", exact: true }),
    ).toBeVisible();
    await menu
      .getByRole("menuitem", { name: /^Mark as (read|unread)$/ })
      .click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(menu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    expect(app.report.unexpected).toEqual([]);
  });
});

// Browser history changes the page while native/portaled dialogs make the
// background inert. DOM-only navigation cannot prove this app ownership seam.
test.describe("dialog origin retirement", () => {
  test.use({ savedSidebar: true });
  async function start(page, app) {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page.locator('button[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("button", { name: "Manage members of Beta", exact: true }),
    ).toBeVisible();
    await page.locator(`button[data-channel-id="${channelId}"]`).click();
    await expect(
      page.getByRole("button", {
        name: `Manage members of ${channelName}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  async function back(page) {
    await page.goBack();
    // Sidebar-origin dialogs keep the workspace inert on Back; inspect its retained identity.
    await expect(
      page
        .getByRole("article", {
          name: "Conversation",
          exact: true,
          includeHidden: true,
        })
        .getByRole("button", {
          name: "Manage members of Beta",
          exact: true,
          includeHidden: true,
        }),
    ).toBeVisible();
  }
  test("Canvas stays open for its channel until closed, without reading the next channel", async ({
    page,
    app,
  }) => {
    await start(page, app);
    await page
      .getByRole("button", { name: "Channel actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "View canvas", exact: true })
      .click();
    const canvas = page.getByRole("region", {
      name: "Channel Canvas",
      exact: true,
    });
    const editor = canvas.getByRole("textbox", {
      name: "Canvas Markdown",
      exact: true,
    });
    const view = canvas.getByRole("article", { name: "Saved Canvas" });
    const edit = canvas.getByRole("tab", { name: "Edit", exact: true });
    await expect(view).toBeVisible();
    await edit.click();
    await expect(editor).toBeEnabled();
    await editor.fill("Draft belongs to the original channel");
    const canvasReads = () =>
      app.report.queries.filter(({ filter }) => filter.kinds?.includes(40100));
    const before = canvasReads();
    expect(before.length).toBeGreaterThan(0);
    await back(page);
    await expect(canvas).toHaveCount(0);
    expect(canvasReads()).toEqual(before);
    await page.goForward();
    await expect(
      page.getByRole("button", {
        name: `Manage members of ${channelName}`,
        exact: true,
      }),
    ).toBeVisible();
    // Returning shows the open Canvas; Edit still holds the channel's draft.
    await expect(canvas).toBeVisible();
    await edit.click();
    await expect(editor).toHaveValue("Draft belongs to the original channel");
    // Choosing channels from the sidebar keeps the tab the same way.
    await page.locator('button[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("button", { name: "Manage members of Beta", exact: true }),
    ).toBeVisible();
    await expect(canvas).toHaveCount(0);
    await page.locator(`button[data-channel-id="${channelId}"]`).click();
    await expect(canvas).toBeVisible();
    await edit.click();
    await expect(editor).toHaveValue("Draft belongs to the original channel");
    await page
      .getByRole("button", { name: "Close Canvas tab", exact: true })
      .click();
    await expect(canvas).toHaveCount(0);
    // Close is the end: returning to the channel does not reopen it.
    await page.locator('button[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("button", { name: "Manage members of Beta", exact: true }),
    ).toBeVisible();
    await page.locator(`button[data-channel-id="${channelId}"]`).click();
    await expect(
      page.getByRole("button", {
        name: `Manage members of ${channelName}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(canvas).toHaveCount(0);
    expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  });
  for (const entrance of ["header", "sidebar"]) {
    for (const action of ["create", "delete"]) {
      test(`${entrance} ${action} keeps only sidebar-origin dialogs on browser Back`, async ({
        page,
        app,
      }) => {
        await start(page, app);
        if (entrance === "header")
          await page
            .getByRole("button", { name: "Channel actions", exact: true })
            .click();
        else
          await page
            .locator(`button[data-channel-id="${channelId}"]`)
            .click({ button: "right" });
        if (action === "create") {
          await page
            .getByRole("menuitem", { name: "Move channel", exact: true })
            .focus();
          await page.keyboard.press("ArrowRight");
          await page
            .getByRole("menuitem", { name: "Create new…", exact: true })
            .click();
        } else
          await page
            .getByRole("menuitem", { name: "Delete channel", exact: true })
            .click();
        const dialog = page.getByRole("dialog", {
          name: action === "create" ? "Move to new section" : /^Delete .+\?$/,
        });
        await expect(dialog).toBeVisible();
        await back(page);
        if (entrance === "header") {
          await expect(dialog).toHaveCount(0);
          await page.goForward();
          await expect(
            page.getByRole("button", {
              name: `Manage members of ${channelName}`,
              exact: true,
            }),
          ).toBeVisible();
          await expect(dialog).toHaveCount(0);
        } else {
          await expect(dialog).toBeVisible();
          await dialog
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
        }
        expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
        expect(app.report.unexpected).toEqual([]);
      });
    }
  }
});
