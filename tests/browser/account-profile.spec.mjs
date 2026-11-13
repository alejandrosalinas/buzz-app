import { test, expect } from "./fixture.mjs";
import {
  closeSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

// Settings stays usable without a relay session. The account menu is covered
// below; behind the modal it would race the reconnecting launch surface.
test("profile Settings opens after a failed connection", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/session", (route) => {
    app.report.startupFailures ??= [];
    app.report.startupFailures.push(route.request().url());
    return route.fulfill({
      status: 502,
      json: { error: "Connection unavailable" },
    });
  });
  await page.clock.install();
  await page.goto(app.origin);
  // Messages waits out its opening deadline while the connection retries.
  await page.clock.runFor(15_000);
  await expect(
    page.getByRole("heading", { name: "Can’t connect", exact: true }),
  ).toBeVisible();
  // The card offers only Try again; the account menu still reaches Settings.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page
    .locator("[data-profile-menu]")
    .getByRole("menuitem", { name: /, edit profile$/ })
    .click();
  await selectSettingsSection(page, "Appearance");
  await selectSettingsSection(page, "Profile");
  await expect(
    page.getByRole("region", { name: "Profile", exact: true }),
  ).toBeVisible();
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
});

// Portaled submenus need real hit testing, collision handling and keyboard focus.
test("account menu choices remain reachable across themes, widths and enlarged text", async ({
  page,
  app,
}, testInfo) => {
  // Boot in Light instead of reloading over a booting app, which WebKit can
  // fail with an internal error.
  await page.addInitScript(() => {
    if (!localStorage.getItem("buzz-appearance.v1"))
      localStorage.setItem("buzz-appearance.v1", "light");
  });
  await page.goto(app.origin);
  const trigger = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  const menu = page.locator("[data-profile-menu]");
  const appearance = menu.getByRole("menuitem", {
    name: "Appearance",
    exact: true,
  });
  const choices = page.getByRole("menu", { name: "Appearance", exact: true });
  for (const mode of ["light", "dark"]) {
    if (mode === "dark") {
      await page.evaluate(() =>
        localStorage.setItem("buzz-appearance.v1", "dark"),
      );
      await page.reload();
    }
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const width of [1280, 800, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await trigger.click();
      await expect(menu).toBeInViewport({ ratio: 1 });
      await appearance.hover();
      await expect(choices).toBeInViewport({ ratio: 1 });
      await expect(
        choices.getByRole("menuitemradio", {
          name: mode === "light" ? "Light" : "Dark",
          exact: true,
        }),
      ).toBeChecked();
      await choices.evaluate(async (element) => {
        await Promise.allSettled(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      await page.screenshot({
        path: testInfo.outputPath(`appearance-${mode}-${width}.png`),
      });
      await choices
        .getByRole("menuitemradio", { name: "System", exact: true })
        .click();
      await expect(
        choices.getByRole("menuitemradio", { name: "System", exact: true }),
      ).toBeChecked();
      await choices
        .getByRole("menuitemradio", {
          name: mode === "light" ? "Light" : "Dark",
          exact: true,
        })
        .click();
      await page.keyboard.press("Escape");
      await expect(choices).toHaveCount(0);
      await expect(appearance).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
  });
  await page.reload();
  await trigger.focus();
  await trigger.press("Enter");
  await expect(menu).toBeInViewport({ ratio: 1 });
  await appearance.focus();
  await appearance.press("ArrowRight");
  await expect(choices).toBeInViewport({ ratio: 1 });
  await choices
    .getByRole("menuitemradio", { name: "Light", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    choices.getByRole("menuitemradio", { name: "Dark", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page.screenshot({
    path: testInfo.outputPath("appearance-enlarged.png"),
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Plugins", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "Manage plugins", exact: true }),
  ).toBeVisible();
  await closeSettings(page);
  await trigger.click();
  await menu.getByRole("menuitem", { name: /, edit profile$/ }).click();
  await expect(
    page.getByRole("region", { name: "Profile", exact: true }),
  ).toBeVisible();
});

// Sharing by default crosses the profile button's fresh read and the strong
// read before publishing, then the fixture's merging profile writer (not the
// browser host's); unit tests stub each read.
test.describe("local time shared by default", () => {
  test.use({ profileTimeZone: null, timezoneId: "Europe/Paris" });

  test("launch shares the browser's time zone into a profile without one", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await expect
      .poll(() => app.ownProfile("primary"))
      .toEqual({
        name: "Fixture Reader",
        display_name: "Fixture Reader",
        picture: "",
        about: "",
        tz: "Europe/Paris",
      });
  });
});
