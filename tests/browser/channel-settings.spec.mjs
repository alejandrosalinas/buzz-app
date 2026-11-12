import { openChannelDetails } from "./channel-details.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { openPage, settlePanelMotion } from "./navigation.mjs";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test("channel settings owns its responsive side panel and returns keyboard focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const conversation = page.getByRole("article", { name: "Conversation" });
  await expect(
    conversation.getByRole("button", {
      name: "Manage members of Alpha",
      exact: true,
    }),
  ).toBeVisible();
  const trigger = page.getByRole("button", {
    name: "Channel actions",
    exact: true,
  });
  const workspace = page.locator("[data-panel-workspace]");
  const panel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await openChannelDetails(page);
  await expect(panel).toBeVisible();
  // Joined panels share the workspace frame and keep a token-based header divider.
  const tokens = await page.addStyleTag({
    content: `:root, :root[data-color-mode] {
      --surface-panel: rgb(23, 45, 67);
      --border-standard: rgb(45, 67, 89);
      --radius-panel: 19px;
    }`,
  });
  try {
    await expect(panel).toHaveCSS("background-color", "rgb(23, 45, 67)");
    await expect(panel).toHaveCSS("border-top-width", "0px");
    await expect(panel).toHaveCSS("border-radius", "0px");
    expect(
      await workspace
        .locator("header.panel-header")
        .evaluate((header) => getComputedStyle(header).borderBottomColor),
    ).toBe("rgb(45, 67, 89)");
  } finally {
    await tokens.evaluate((node) => node.remove());
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.mouse.move(0, 0);
  await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const settingsTab = workspace.getByRole("tab", {
    name: "Channel settings",
    exact: true,
  });
  await expect(settingsTab).toHaveClass(/navigation-item/);
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
  await workspace
    .getByRole("button", { name: "Toggle tab pane", exact: true })
    .click();
  await expect(workspace).toBeHidden();
  await openChannelDetails(page);
  await expect(settingsTab).toBeFocused();
  expect(
    await settingsTab.evaluate(
      (tab) =>
        tab.parentElement.getBoundingClientRect().width /
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
  ).toBeLessThanOrEqual(12);
  const close = workspace.getByRole("button", {
    name: "Close Channel settings tab",
  });
  await expect(
    workspace.getByRole("tab", { name: "Channel settings", exact: true }),
  ).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "Refresh channels", exact: true }),
  ).toBeHidden();
  await panel.getByText("Diagnostics", { exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Refresh channels", exact: true }),
  ).toBeVisible();
  const conversationBox = await conversation.boundingBox();
  const panelBox = await panel.boundingBox();
  expect(panelBox.x).toBeGreaterThanOrEqual(
    conversationBox.x + conversationBox.width,
  );
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await openChannelDetails(page);
  await expect(
    panel.getByRole("button", { name: "Refresh channels", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(panel).toBeVisible();
  await settlePanelMotion(page);
  await close.click();
  await expect(panel).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 800 });
  await openChannelDetails(page);
  await expect(
    workspace.getByRole("tab", { name: "Channel settings", exact: true }),
  ).toBeFocused();
  // Focus moves before the panel finishes entering; wait for its visible geometry.
  await expect(panel).toBeInViewport({ ratio: 1 });
  const narrow = await panel.boundingBox();
  expect(narrow.x).toBeGreaterThanOrEqual(0);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(600);
  expect(narrow.y + narrow.height).toBeLessThanOrEqual(800);
  await settlePanelMotion(page);
  await close.click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 950 });
  await openChannelDetails(page);
  await expect(panel).toBeVisible();
  const messages = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator("summary")
    .filter({ hasText: /^Direct messages$/ });
  await messages.hover();
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "New message", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
  await expect(panel).toHaveCount(0);
});

// Browser-only: the real modal, the dock hidden and inert under it, and the
// portaled thread slot must hold together across one review. Vitest can
// mount the pane or the viewer, not both with focus and portals intact.
test("an image review keeps Channel settings open and hands the thread draft to the viewer", async ({
  page,
  app,
  context,
}) => {
  await context.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL("../../public/shell-gradient.png", import.meta.url),
      ),
      contentType: "image/png",
    }),
  );
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Reviewed beside settings",
    true,
    true,
    undefined,
    undefined,
    [["imeta", "url https://primary.example/media/photo.png", "m image/png"]],
  );
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator(`[data-message-id="${event.id}"]`);
  const tile = row.getByRole("link", {
    name: "Open image attachment",
    exact: true,
  });
  const viewer = page.getByRole("dialog", {
    name: "Image viewer",
    exact: true,
  });
  const workspace = page.locator("[data-panel-workspace]");
  const panel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  // Role queries skip hidden elements; this one tells hidden from unmounted.
  const retainedPanel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
    includeHidden: true,
  });
  const settingsTab = workspace.getByRole("tab", {
    name: "Channel settings",
    exact: true,
  });
  await openChannelDetails(page);
  await expect(panel).toBeVisible();
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
  await tile.click();
  await expect(viewer).toBeVisible();
  // The pane waits under the modal: hidden once its closing motion ends, and
  // out of reach of focus and assistive technology throughout. A dock that
  // only outlives its closing motion is never hidden; it unmounts instead.
  const dock = page.locator("[data-panel-dock]", { has: retainedPanel });
  await expect(dock).toHaveAttribute("hidden", "");
  await expect(dock).toHaveAttribute("inert", "");
  await expect(dock).toHaveAttribute("aria-hidden", "true");
  await expect(panel).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
  await expect(tile).toBeFocused();

  // Side thread tabs leave while the viewer is up: the viewer's comment
  // composer reads the saved draft when it mounts, and the thread composer
  // reads the viewer's edits back when it returns. Reply closes settings today.
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const hiddenThread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
    includeHidden: true,
  });
  const threadDraft = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await threadDraft.fill("Handoff draft");
  await tile.click();
  await expect(viewer).toBeVisible();
  await expect(hiddenThread).toHaveCount(0);
  await viewer
    .getByRole("button", { name: "Show comments", exact: true })
    .click();
  const reviewDraft = viewer
    .getByRole("complementary", { name: "Media comments", exact: true })
    .getByRole("textbox", { name: "Reply to thread", exact: true });
  await expect(reviewDraft).toHaveText("Handoff draft");
  await reviewDraft.fill("Handoff draft, edited in the viewer");
  await viewer
    .getByRole("button", { name: "Close fullscreen viewer", exact: true })
    .click();
  await expect(viewer).toHaveCount(0);
  await expect(threadDraft).toHaveText("Handoff draft, edited in the viewer");
  await expect(tile).toBeFocused();

  // A thread in the main pane is not under the dock and keeps its place
  // through a review: the same composer stays mounted, never leaving the DOM.
  const main = page.locator("[data-main-workspace]");
  const threadTabs = (host) =>
    host.locator('[role="tab"][data-tab-value^="thread:"]');
  await threadTabs(workspace).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(threadTabs(main)).toHaveCount(1);
  const mainDraft = main.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(mainDraft).toHaveText("Handoff draft, edited in the viewer");
  const mainEditor = await mainDraft.elementHandle();
  await main.getByRole("tab", { name: "Alpha", exact: true }).click();
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(viewer).toBeVisible();
  await expect(hiddenThread).toHaveCount(1);
  expect(await mainEditor.evaluate((node) => node.isConnected)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  expect(await mainEditor.evaluate((node) => node.isConnected)).toBe(true);
  await expect(threadTabs(main)).toHaveCount(1);
  await expect(tile).toBeFocused();
});

test.describe("description links", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const runbook = "https://example.test/r2-runbook";
  test.use({
    productionBroker: true,
    channelLifecycle: true,
    channelNames: { [id]: "R2 ops" },
  });
  // Browser-only: whether a click reaches a link or the row's Edit action is
  // layout hit-testing. Role and empty-value permutations stay in Vitest.
  test("an owner's description links open their targets, not the editor", async ({
    page,
    context,
    app,
  }) => {
    await context.route(runbook, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Runbook</title>",
      }),
    );
    app.setChannelMetadata(id, [
      ["name", "R2 ops"],
      ["t", "stream"],
      ["public"],
      ["about", `R2 runbook: ${runbook} · see #Beta`],
    ]);
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page.locator(`button[data-channel-id="${id}"]`).click();
    await openChannelDetails(page);
    const panel = page.getByRole("complementary", {
      name: "Channel settings",
      exact: true,
    });
    const edit = panel.getByRole("button", {
      name: "Edit description",
      exact: true,
    });
    const editor = page.getByRole("dialog", {
      name: "Edit channel details",
      exact: true,
    });
    // Permissions have loaded, so a click that reached Edit would open it.
    await expect(edit).toBeEnabled();
    // The label is now the only pointer target for editing.
    expect((await edit.boundingBox()).height).toBeGreaterThanOrEqual(24);
    // Its target overhangs the label's line box, so the value sits where
    // Members' does. The dt can't show this: the margins collapse through it.
    // Measure inside each row's top border, which only later rows have.
    const valueOffset = (name) =>
      panel.getByRole("button", { name, exact: true }).evaluate((button) => {
        const row = button.closest("dt").parentElement;
        return (
          row.querySelector("dd").getBoundingClientRect().top -
          row.getBoundingClientRect().top -
          row.clientTop
        );
      });
    expect(await valueOffset("Edit description")).toBeCloseTo(
      await valueOffset("View members"),
      0,
    );
    const opened = page.waitForEvent("popup");
    await panel.getByRole("link", { name: runbook, exact: true }).click();
    const external = await opened;
    expect(external.url()).toBe(runbook);
    await external.close();
    await expect(editor).toHaveCount(0);
    await edit.click();
    await expect(
      editor.getByRole("textbox", { name: "Description", exact: true }),
    ).toBeFocused();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await panel.getByRole("link", { name: "#Beta", exact: true }).click();
    await expect(
      page
        .getByRole("article", { name: "Conversation" })
        .getByRole("button", { name: "Manage members of Beta", exact: true }),
    ).toBeVisible();
    await expect(editor).toHaveCount(0);
  });
});
