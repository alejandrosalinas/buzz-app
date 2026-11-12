import { test as appTest } from "./fixture.mjs";
import { expect } from "./playwright-test.mjs";
import {
  openPage,
  openSettings,
  closeSettings,
  selectSettingsSection,
  settleShellToggle,
} from "./navigation.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";
import { animationsSettled } from "./animations.mjs";

appTest.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: ["alpha", "beta", "gamma"],
  channelNames: { alpha: "Alpha", beta: "Beta", gamma: "Gamma" },
  historyCounts: { alpha: 1, beta: 0, gamma: 0 },
});

// Real menu hit targets and encrypted preference readback survive a full reload.
appTest(
  "plugins decorate live rows and persist a custom section sort",
  async ({ page, app }, testInfo) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const section = page.locator('[data-sidebar-section="channels"]');
    const rows = section.locator("[data-channel-id]");
    const expectOrder = (ids) =>
      expect
        .poll(() =>
          rows.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-channel-id")),
          ),
        )
        .toEqual(ids);
    await expectOrder(["alpha", "beta", "gamma"]);
    await page.screenshot({
      path: testInfo.outputPath("sidebar-rows-before.png"),
    });
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    await setPluginEnabled(page, "Host row fixture", true);
    await closeSettings(page);
    await expect(
      section.locator('[data-plugin-row="decorated"] [data-channel-id="beta"]'),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "More actions for Channels" })
      .click();
    await page.getByRole("menuitem", { name: "Sort", exact: true }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "Reverse name" }),
    ).toBeVisible();
    await animationsSettled(
      page.getByRole("menu", { name: "Sort Channels", exact: true }),
      { subtree: true },
    );
    await page.screenshot({
      path: testInfo.outputPath("sidebar-rows-sort-menu.png"),
    });
    const saved = page.waitForResponse("**/sidebar-sort");
    await page.getByRole("menuitemradio", { name: "Reverse name" }).click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    await response.finished();
    await expectOrder(["gamma", "beta", "alpha"]);
    await page.reload();
    await expectOrder(["gamma", "beta", "alpha"]);
    for (const [width, mode, fontSize] of [
      [1440, "light", "16px"],
      [1440, "dark", "20px"],
      [390, "light", "20px"],
      [390, "dark", "16px"],
    ]) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(
        ({ mode, fontSize }) => {
          document.documentElement.setAttribute("data-color-mode", mode);
          document.documentElement.style.fontSize = fontSize;
        },
        { mode, fontSize },
      );
      await settleShellToggle(page);
      const toggle = page.locator("[data-shell-sidebar-toggle]");
      if ((await toggle.getAttribute("aria-label"))?.startsWith("Show"))
        await toggle.click();
      const beta = section.locator('[data-channel-id="beta"]');
      await expect(beta).toBeVisible();
      await beta.focus();
      await expect(beta).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(beta).toHaveAttribute("aria-current", "page");
      if (width <= 650)
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
      if ((await toggle.getAttribute("aria-label"))?.startsWith("Show"))
        await toggle.click();
      await expect(beta).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`sidebar-rows-after-${width}-${mode}.png`),
      });
    }
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    await setPluginEnabled(page, "Host row fixture", false);
    await closeSettings(page);
    await expectOrder(["alpha", "beta", "gamma"]);
    await expect(section.locator("[data-plugin-row]")).toHaveCount(0);
  },
);

appTest.describe("ordinary Solo rows", () => {
  appTest.use({ soloChannels: ["beta"], ownSoloChannels: ["beta"] });

  // Browser seam: the installed contribution wraps the actual shell row, with
  // its menu hit target and keyboard focus, rather than a substitute component.
  appTest(
    "decorates the complete Solo entry without replacing its host interactions",
    async ({ page, app }, info) => {
      await page.goto(app.origin);
      await openPage(page, "Messages");
      const row = page.locator('[data-solo-channel-id="beta"]');
      await expect(row).toBeVisible();
      await openSettings(page);
      await selectSettingsSection(page, "Manage plugins");
      await setPluginEnabled(page, "Host row fixture", true);
      await closeSettings(page);
      const decorated = page
        .locator('[data-plugin-row="decorated"]')
        .filter({ has: row });
      await expect(decorated).toBeVisible();
      const actions = decorated.getByRole("button", {
        name: "Actions for Beta",
        exact: true,
      });
      await row.focus();
      await page.keyboard.press("Enter");
      await expect(row).toHaveAttribute("aria-current", "page");
      await row.press("Shift+F10");
      await expect(
        page.getByRole("menuitem", { name: "Rename", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(row).toBeFocused();
      await actions.click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: "Chat name", exact: true }),
      ).toHaveValue("Beta");
      await page.keyboard.press("Escape");
      await expect(row).toBeFocused();
      for (const [width, mode, fontSize] of [
        [1440, "light", "16px"],
        [390, "dark", "20px"],
      ]) {
        await page.setViewportSize({ width, height: 850 });
        await page.evaluate(
          ({ mode, fontSize }) => {
            document.documentElement.setAttribute("data-color-mode", mode);
            document.documentElement.style.fontSize = fontSize;
          },
          { mode, fontSize },
        );
        await settleShellToggle(page);
        const toggle = page.locator("[data-shell-sidebar-toggle]");
        if ((await toggle.getAttribute("aria-label"))?.startsWith("Show"))
          await toggle.click();
        await expect(row).toBeVisible();
        await row.hover();
        await expect(actions).toBeVisible();
        await page.screenshot({
          path: info.outputPath(`solo-plugin-row-${width}-${mode}.png`),
        });
      }
      await openSettings(page);
      await selectSettingsSection(page, "Manage plugins");
      await setPluginEnabled(page, "Host row fixture", false);
      await closeSettings(page);
      await expect(decorated).toHaveCount(0);
      await expect(row).toBeAttached();
    },
  );
});
