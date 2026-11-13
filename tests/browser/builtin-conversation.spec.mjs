import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  closeSettings,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

// Real app wiring and rendered Settings/composer integration: source-only
// provider fixtures deliberately retain optional lifetimes for disposal tests.
test("old disabled flags cannot hide built-in emoji or mentions", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 3,
        enabled: { "buzz.emoji": false, "buzz.mentions": false },
      }),
    );
  });
  await open(page, app);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill(":smile");
  const emoji = page.getByRole("listbox", { name: "Emoji suggestions" });
  await expect(emoji.getByRole("option").first()).toContainText(":smile:");
  await composer.press("Tab");
  await expect(composer).toHaveJSProperty("value", "😄 ");
  await composer.fill("@");
  await expect(
    page.getByRole("listbox", { name: "Mention suggestions" }),
  ).toBeVisible();
  await composer.press("Escape");
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  const mentions = page.getByRole("dialog", {
    name: "Mention a member or agent",
  });
  await expect(mentions).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Emoji and GIFS", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Emoji picker" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  for (const name of ["Emoji", "Mentions"])
    await expect(
      page.getByRole("button", { name: `View ${name} details`, exact: true }),
    ).toHaveCount(0);
  await selectSettingsSection(page, "Custom emoji");
  await expect(
    page.getByRole("heading", { name: "Custom emoji", exact: true }),
  ).toBeVisible();
  await closeSettings(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Mention a member", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Emoji and GIFS", exact: true }),
  ).toBeVisible();
});
