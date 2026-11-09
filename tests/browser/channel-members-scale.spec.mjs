import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

const members = Array.from({ length: 2525 }, (_, i) =>
  (i + 10000).toString(16).padStart(64, "0"),
);
const channelId = "11111111-1111-4111-8111-111111111111";
test.use({
  pluginFixtures: true,
  channelIds: [channelId, "beta"],
  channelNames: { [channelId]: "Large channel" },
  sessionMembers: { [channelId]: members },
});

// Real DOM/layout contract: opening a large roster must bound mounted rows.
test("large channel members stays usable while browsing and searching the roster", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page.locator(`button[data-channel-id="${channelId}"]`).click();
  const trigger = page
    .getByRole("article", { name: "Conversation" })
    .getByRole("button", { name: /^Manage members of /, exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  const list = dialog.getByRole("region", { name: "Member list", exact: true });
  await expect(dialog.getByText("Loading members…")).toHaveCount(0);
  await expect(list.getByRole("listitem").first()).toBeVisible();
  await expect(
    list.getByRole("heading", { name: "People · 2526" }),
  ).toBeVisible();
  expect(await list.getByRole("listitem").count()).toBeLessThan(100);
  const pages = list.getByRole("navigation", { name: "People member pages" });
  await pages.getByRole("button", { name: "Next" }).click();
  await expect(pages.getByText("2 of 51")).toBeVisible();
  await expect(
    list.getByRole("heading", { name: "People · 2526" }),
  ).toBeFocused();
  await expect(list.getByRole("listitem").first()).toBeInViewport();
  await pages.getByRole("button", { name: "Previous" }).click();
  await expect(pages.getByText("1 of 51")).toBeVisible();
  await expect(list.getByRole("listitem").first()).toBeInViewport();
  await pages.getByRole("button", { name: "Next" }).click();
  await expect(pages.getByText("2 of 51")).toBeVisible();
  await expect(list.getByRole("listitem").first()).toBeInViewport();
  await pages.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("large-members-light.png"),
  });
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-color-mode", "dark");
    document.documentElement.style.fontSize = "130%";
  });
  await pages.scrollIntoViewIfNeeded();
  await expect(pages.getByRole("button", { name: "Next" })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("large-members-dark-narrow.png"),
  });
  await expect(list.getByRole("listitem")).toHaveCount(50);
  await dialog.getByRole("searchbox").fill(members.at(-1));
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await dialog.getByRole("searchbox").fill("");
  await expect(pages.getByText("1 of 51")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
