import { test, expect } from "./fixture.mjs";
import { stopRoutes } from "./playwright-test.mjs";
import { open } from "./timeline.mjs";
import {
  closeSettings,
  openSettings,
  selectSettingsSection,
  settingsDialog,
  settingsSections,
} from "./navigation.mjs";

// The shell owns the divider; the inner aside excludes its 1px border.
const sidebarWidth = (sidebar) =>
  sidebar.evaluate(
    (element) =>
      element
        .closest(".shell-sidebar, .shell-sidebar-default")
        .getBoundingClientRect().width,
  );

// Settings is a modal over the retained workspace: the channel sidebar stays
// mounted behind it but is hidden from the accessibility tree while it is open.
const retainedChannels = (page) =>
  page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
    includeHidden: true,
  });

// Real shell layout and route remounts must preserve the user's resized width.
test("Settings keeps the channel sidebar width across navigation and reload", async ({
  page,
  app,
}) => {
  await open(page, app);
  const channels = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const retained = retainedChannels(page);
  const handle = page.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  for (const [key, width] of [
    ["Home", 220],
    ["End", 520],
  ]) {
    await handle.press(key);
    await expect.poll(() => sidebarWidth(channels)).toBe(width);
    await openSettings(page);
    await expect(channels).toHaveCount(0);
    await expect.poll(() => sidebarWidth(retained)).toBe(width);
    await selectSettingsSection(page, "Notifications");
    await page.reload();
    await expect(settingsDialog(page)).toBeVisible();
    await expect(channels).toHaveCount(0);
    await expect(retained).toBeHidden();
    await closeSettings(page);
    await expect.poll(() => sidebarWidth(channels)).toBe(width);
  }
});

// Settings has no drawer of its own; at narrow widths its modal stacks its
// navigation, and the channel drawer behind it keeps the clamped width.
test("narrow Settings keeps the clamped channel drawer behind its modal", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.getByRole("separator", { name: "Resize sidebar" }).press("End");
  await page.setViewportSize({ width: 600, height: 950 });
  await expect(
    page.getByRole("complementary", { name: "Sidebar", exact: true }),
  ).not.toBeVisible();
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const contentWidth = (await conversation.boundingBox()).width;
  const showNavigation = page.getByRole("button", {
    name: "Show navigation",
    exact: true,
  });
  await showNavigation.click();
  expect((await conversation.boundingBox()).width).toBe(contentWidth);
  const channels = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  await expect.poll(() => sidebarWidth(channels)).toBe(220);
  await channels
    .getByRole("button", { name: "Beta", exact: true })
    .press("Enter");
  await expect(channels).toBeHidden();
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(composer).toBeFocused();
  await page.keyboard.type("Usable destination");
  await expect(composer).toHaveText("Usable destination");
  await composer.fill("");
  await openSettings(page);
  // The workspace's drawer toggle is behind the modal; Settings keeps its own
  // section navigation in view instead of a drawer.
  await expect(showNavigation).toHaveCount(0);
  const sections = settingsSections(page);
  await expect(sections).toBeInViewport();
  const notifications = sections.getByRole("button", {
    name: "Notifications",
    exact: true,
  });
  await notifications.press("Enter");
  await expect(notifications).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Notifications", exact: true }),
  ).toBeVisible();
  // Selecting the current section is a new attempt, not a new history visit.
  await notifications.press("Enter");
  await expect(notifications).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await closeSettings(page);
  await expect(composer).toBeVisible();
  await showNavigation.click();
  await expect.poll(() => sidebarWidth(channels)).toBe(220);
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect.poll(() => sidebarWidth(channels)).toBe(520);
});

test("sidebar width survives route remounts when saving it fails", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith("buzz-view.v1:") &&
        key.includes('"channel-sidebar"')
      ) {
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
  await page.getByRole("separator", { name: "Resize sidebar" }).press("End");
  const channels = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  await expect.poll(() => sidebarWidth(channels)).toBe(520);
  await openSettings(page);
  await expect.poll(() => sidebarWidth(retainedChannels(page))).toBe(520);
  // Section changes are route changes; the retained sidebar keeps its width.
  await selectSettingsSection(page, "Notifications");
  await expect.poll(() => sidebarWidth(retainedChannels(page))).toBe(520);
  await closeSettings(page);
  await expect.poll(() => sidebarWidth(channels)).toBe(520);
});

// Native storage delivery and rendered width across two real documents are not
// established by the component's synthetic StorageEvent tests.
test("sidebar width updates across open windows without losing a draft", async ({
  page,
  context,
  app,
}) => {
  await open(page, app);
  const channels = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const resize = page.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Keep this draft while another window resizes");
  await resize.press("End");
  await expect.poll(() => sidebarWidth(channels)).toBe(520);
  const other = await context.newPage();
  app.watchPageErrors(other);
  try {
    await open(other, app);
    await openSettings(other);
    const retained = retainedChannels(other);
    await expect.poll(() => sidebarWidth(retained)).toBe(520);
    // The resize handle is behind the modal; resize from the restored workspace.
    await closeSettings(other);
    await other
      .getByRole("separator", { name: "Resize sidebar", exact: true })
      .press("Home");
    await expect.poll(() => sidebarWidth(channels)).toBe(220);
    await expect(composer).toHaveText(
      "Keep this draft while another window resizes",
    );
    await openSettings(other);
    await resize.press("ArrowRight");
    await expect.poll(() => sidebarWidth(retained)).toBe(236);
    await other.reload();
    await expect(settingsDialog(other)).toBeVisible();
    await expect(retained).toBeHidden();
    await closeSettings(other);
    await expect.poll(() => sidebarWidth(retainedChannels(other))).toBe(236);
  } finally {
    await stopRoutes(context);
    await other.close();
  }
});
