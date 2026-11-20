import { expect, test } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  savedSidebar: [{ id: "laptop", name: "Laptop", order: 1 }],
});

test("workspace headings remember their own creation action", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const work = page.locator('[data-sidebar-section="group:work"]');
  const initial = work.getByRole("button", {
    name: "New chat in Work",
    exact: true,
  });
  await initial.focus();
  await expect(initial).toBeVisible();
  await initial.hover();
  const arrow = work.getByRole("button", {
    name: "New options in Work",
    exact: true,
  });
  await expect(
    page.getByRole("tooltip").filter({ hasText: /^New chat in Work$/ }),
  ).toBeVisible();
  await arrow.click();
  await expect(
    page.getByRole("menuitem", { name: "New channel", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("workspace-new-options.png"),
    animations: "disabled",
    clip: { x: 55, y: 44, width: 470, height: 380 },
  });
  await page.getByRole("menuitem", { name: "New DM", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();

  await page.reload();
  await openPage(page, "Messages");
  const planning = page.locator('[data-sidebar-section="group:laptop"]');
  await expect(
    planning.getByRole("button", { name: "New chat in Laptop", exact: true }),
  ).toBeAttached();
  const remembered = work.getByRole("button", {
    name: "New DM in Work",
    exact: true,
  });
  await remembered.focus();
  await expect(remembered).toBeVisible();
  await page.locator('[data-sidebar-section="group:laptop"]').hover();
  await page.screenshot({
    path: testInfo.outputPath("workspace-new-remembered.png"),
    animations: "disabled",
    clip: { x: 55, y: 44, width: 267, height: 360 },
  });
  await remembered.press("Enter");
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
});
