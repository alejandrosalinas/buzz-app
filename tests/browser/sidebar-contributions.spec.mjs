import { test as appTest } from "./fixture.mjs";
import { test, expect } from "./playwright-test.mjs";
import {
  closeSettings,
  openPage,
  openSettings,
  selectSettingsSection,
  settleShellToggle,
} from "./navigation.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";

appTest.use({ pluginFixtures: true });

test.describe("plugin sidebar contributions", () => {
  appTest(
    "stay inside the unified Messages sidebar",
    async ({ page, app }, testInfo) => {
      const title = "Sidebar section fixture";
      const section = page.locator(
        '[data-sidebar-section="plugin:fixture.sidebar-sections/work"]',
      );
      const toggle = page.locator("[data-shell-sidebar-toggle]");
      const openSidebar = async () => {
        await settleShellToggle(page);
        if ((await toggle.getAttribute("aria-label"))?.startsWith("Show"))
          await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
      };
      await page.goto(app.origin);
      await openPage(page, "Messages");

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
        await openSidebar();
        await expect(
          page.locator('[data-sidebar-section="solo"]'),
        ).toBeVisible();

        await openSettings(page);
        await selectSettingsSection(page, "Manage plugins");
        await setPluginEnabled(page, title, false);
        await closeSettings(page);
        await openSidebar();
        await expect(section).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(
            `sidebar-contribution-before-${width}-${mode}-${fontSize}-${testInfo.project.name}.png`,
          ),
        });

        await openSettings(page);
        await selectSettingsSection(page, "Manage plugins");
        await setPluginEnabled(page, title, true);
        await closeSettings(page);
        await openSidebar();
        await expect(section).toBeVisible();
        await expect(
          section.getByRole("button", { name: "Queue" }),
        ).toBeVisible();
        if (width === 390) {
          const label = section
            .getByRole("button", { name: "Queue" })
            .locator(".navigation-item-label");
          await expect
            .poll(() =>
              label.evaluate(
                (element) => element.scrollWidth <= element.clientWidth,
              ),
            )
            .toBe(true);
        }
        const sectionHeader = section.locator("summary");
        await sectionHeader.focus();
        await page.keyboard.press("Space");
        await expect(
          section.getByRole("button", { name: "Queue" }),
        ).toBeHidden();
        await page.keyboard.press("Space");
        await expect(
          section.getByRole("button", { name: "Queue" }),
        ).toBeVisible();
        await sectionHeader.evaluate((element) => element.blur());
        await sectionHeader.click();
        await expect(
          section.getByRole("button", { name: "Queue" }),
        ).toBeHidden();
        await sectionHeader.click();
        await expect(
          section.getByRole("button", { name: "Queue" }),
        ).toBeVisible();
        const sidebar = page.getByRole("complementary", {
          name: "Sidebar",
          exact: true,
        });
        await expect(
          sidebar.locator('[data-sidebar-section="solo"]'),
        ).toBeVisible();
        await expect(
          sidebar.locator('[data-sidebar-section="channels"]'),
        ).toBeVisible();
        await expect(
          page.locator('button[data-channel-id="alpha"]'),
        ).toBeVisible();

        const geometry = await sidebar.evaluate((panel) => {
          const shell = panel.closest(".shell-sidebar");
          const group = panel.querySelector(
            '[data-sidebar-section="plugin:fixture.sidebar-sections/work"]',
          );
          if (
            !(shell instanceof HTMLElement) ||
            !(group instanceof HTMLElement)
          )
            throw new Error("Sidebar contribution geometry is unavailable");
          const shellBox = shell.getBoundingClientRect();
          const groupBox = group.getBoundingClientRect();
          return {
            noHorizontalOverflow: shell.scrollWidth <= shell.clientWidth,
            contained:
              groupBox.left >= shellBox.left &&
              groupBox.right <= shellBox.right,
          };
        });
        expect(geometry).toEqual({
          noHorizontalOverflow: true,
          contained: true,
        });
        await page.screenshot({
          path: testInfo.outputPath(
            `sidebar-contribution-after-${width}-${mode}-${fontSize}-${testInfo.project.name}.png`,
          ),
        });
      }
    },
  );

  appTest(
    "shows a drag preview for contributed sections",
    async ({ page, app }) => {
      await page.goto(app.origin);
      await openPage(page, "Messages");

      const section = page.locator(
        '[data-sidebar-section="plugin:fixture.sidebar-sections/work"]',
      );
      const header = section.locator("summary");
      await expect(section).toBeVisible();
      const bounds = await header.boundingBox();
      if (!bounds)
        throw new Error("Sidebar contribution header is unavailable");

      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 12, y + 12, { steps: 3 });

      await expect(section).toHaveAttribute("data-section-dragging");
      await expect(page.getByText("Workspace", { exact: true })).toHaveCount(2);

      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(page.locator("[data-section-dragging]")).toHaveCount(0);
    },
  );

  appTest.describe("failed section icon recovery", () => {
    appTest.use({ expectedSidebarIconFailure: true });

    appTest(
      "contains a failed contributed icon while dragging its fallback section",
      async ({ page, app }) => {
        await page.addInitScript(() => {
          window.fixtureSidebarWorkIconThrows = true;
        });
        await page.goto(app.origin);
        await openPage(page, "Messages");

        const sidebar = page.getByRole("complementary", {
          name: "Sidebar",
          exact: true,
        });
        const section = page.locator(
          '[data-sidebar-section="plugin:fixture.sidebar-sections/work"]',
        );
        await expect(section).toContainText("Workspace is unavailable.");
        await expect(
          sidebar.locator('[data-sidebar-section="solo"]'),
        ).toBeVisible();

        const failureCountBeforeDrag = app.report.consoleErrors.filter(
          (message) => message.includes("Fixture sidebar icon failure"),
        ).length;
        const header = section.locator("summary");
        const bounds = await header.boundingBox();
        if (!bounds)
          throw new Error("Failed contribution header is unavailable");

        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 12, y + 12, { steps: 3 });

        await expect(section).toHaveAttribute("data-section-dragging");
        await expect(
          sidebar.locator('[data-sidebar-section="solo"]'),
        ).toBeVisible();
        await expect(
          sidebar.getByText("Conversations couldn’t open."),
        ).toHaveCount(0);
        await expect
          .poll(
            () =>
              app.report.consoleErrors.filter((message) =>
                message.includes("Fixture sidebar icon failure"),
              ).length,
          )
          .toBeGreaterThan(failureCountBeforeDrag);

        await page.keyboard.press("Escape");
        await page.mouse.up();
        await expect(page.locator("[data-section-dragging]")).toHaveCount(0);
      },
    );
  });
});

appTest.describe("workspace composition", () => {
  appTest.use({
    // Keep the fixture's framed Work and Mixed headings in view together.
    // This journey tests cross-frame collision independently of auto-scroll.
    viewport: { width: 1440, height: 1300 },
    productionBroker: true,
    channelIds: ["alpha", "beta", "gamma"],
    channelNames: { alpha: "Alpha", beta: "Beta", gamma: "Gamma" },
    soloChannels: ["beta"],
    ownSoloChannels: ["beta"],
    savedSidebar: [{ id: "mixed", name: "Mixed", order: 1 }],
  });

  // Real pointer collision across the contribution portal and the host's
  // sidebar slots. A move can switch the destination's rendering owner.
  appTest(
    "drags between framed and mixed workspaces in the same sidebar",
    async ({ page, app }) => {
      await page.goto(
        `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets`,
      );
      await openPage(page, "Messages");
      const work = page.locator('[data-sidebar-section="group:work"]');
      const mixed = page.locator('[data-sidebar-section="group:mixed"]');
      const beta = page.getByRole("button", { name: "Beta", exact: true });
      const gamma = page.getByRole("button", { name: "Gamma", exact: true });
      await expect(work).toHaveCount(1);
      await expect(work.locator('[data-solo-workspace="work"]')).toContainText(
        "Beta",
      );
      await expect(
        mixed.locator('[data-solo-workspace="mixed"]'),
      ).toBeVisible();

      const sidebar = page.getByRole("complementary", {
        name: "Sidebar",
        exact: true,
      });
      const moveToMixed = async (row, header) => {
        await expect(row).toBeInViewport({ ratio: 1 });
        await expect(header).toBeInViewport({ ratio: 1 });
        const start = await row.boundingBox();
        const panel = await sidebar.boundingBox();
        const target = await header.boundingBox();
        if (!start || !panel || !target)
          throw new Error("Workspace drag source or target is missing");
        const outside = panel.x + panel.width + 16;
        const startY = start.y + start.height / 2;
        await page.mouse.move(start.x + start.width / 2, startY);
        await page.mouse.down();
        // Move vertically outside the sidebar so crossing the workspace
        // creation slot cannot expand it and move Mixed during the drag.
        await page.mouse.move(outside, startY);
        await expect(page.locator("[data-channel-dragging]")).toHaveCount(1);
        const targetY = target.y + target.height / 2;
        await page.mouse.move(outside, targetY);
        await page.mouse.move(target.x + target.width / 2, targetY);
        await expect(mixed).toHaveAttribute("data-drop-target");
        await Promise.all([
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname.endsWith("/sidebar-star") &&
              response.ok(),
          ),
          page.mouse.up(),
        ]);
      };

      await moveToMixed(
        gamma,
        mixed.getByRole("button", { name: "Mixed", exact: true }),
      );
      await expect(mixed.locator('[data-solo-workspace="mixed"]')).toHaveCount(
        0,
      );
      await expect(
        mixed.getByRole("button", { name: "Gamma", exact: true }),
      ).toBeVisible();
      await moveToMixed(beta, mixed.locator("summary"));
      await expect(
        mixed.getByRole("button", { name: "Beta", exact: true }),
      ).toBeVisible();
      await expect(
        work.getByRole("button", { name: "Beta", exact: true }),
      ).toHaveCount(0);
    },
  );
});

appTest.describe("Focus", () => {
  appTest.use({
    enabledPlugins: ["buzz.focus"],
    channelWriteKinds: [9],
  });

  // The shell enables its shortcut only while the sidebar's trigger is mounted.
  appTest(
    "keeps the New shortcut when Solo has no rows",
    async ({ page, app }) => {
      await page.goto(app.origin);
      await openPage(page, "Messages");
      const solo = page.locator('[data-sidebar-section="solo"]');
      const team = page.locator('[data-sidebar-section="channels"]');
      await expect(team).toBeVisible();
      await expect(solo.locator("[data-solo-destination-id]")).toHaveCount(0);
      await page.keyboard.press("Alt+f");
      await expect(page.getByText(/^Focusing until/)).toBeVisible();
      await expect(team).toHaveCount(0);
      const modifier = await page.evaluate(() =>
        /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
      );
      await page.keyboard.press(`${modifier}+n`);
      await expect(
        page.getByRole("menuitem", { name: "New chat", exact: true }),
      ).toBeVisible();
    },
  );
});
