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

appTest.describe("sidebar refresh", () => {
  const soloChannels = Array.from(
    { length: 16 },
    (_, i) => `60000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  appTest.use({
    productionBroker: true,
    channelIds: soloChannels,
    soloChannels,
    ownSoloChannels: soloChannels,
    viewport: { width: 1100, height: 375 },
  });

  // A repaint can change visible rows while scrollTop stays the same.
  appTest(
    "keeps visible Solo rows in place when a task moves above them",
    async ({ page, app }) => {
      await page.goto(`${app.origin}/?solo-region-fixture`);
      await openPage(page, "Messages");
      const viewport = page.getByRole("navigation", {
        name: "Subscribed channels",
      });
      const lastSoloRow = viewport.locator(
        `[data-solo-destination-id="${soloChannels.at(-1)}"]`,
      );
      const showMore = viewport.getByRole("button", {
        name: "Show more in Solo",
      });
      // The roster can be ready while the Solo section lists only its first rows.
      await expect(lastSoloRow.or(showMore).first()).toBeVisible();
      if (await showMore.isVisible()) await showMore.click();
      await expect(lastSoloRow).toBeVisible();
      await page.evaluate(async (ids) => {
        for (const id of ids) await window.fixtureSoloRegion.classify(id);
      }, soloChannels);
      const rowSelector =
        '[data-sidebar-section^="solo-region:"] [data-solo-destination-id]';
      const rows = viewport.locator(rowSelector);
      await expect(rows).toHaveCount(soloChannels.length);
      // Finish moving the original Solo rows before measuring the anchor.
      await expect(
        viewport.locator(
          '[data-sidebar-section="solo"] [data-solo-destination-id]',
        ),
      ).toHaveCount(0);
      // A contributed task can have a compact link inside its full-width row.
      await rows.evaluateAll((links) => {
        for (const link of links)
          link.style.clipPath = "inset(0 calc(100% - 72px) 0 0)";
      });
      const anchor = rows.nth(6);
      const anchorId = await anchor.getAttribute("data-solo-destination-id");
      const promotedId = await rows
        .nth(12)
        .getAttribute("data-solo-destination-id");
      const position = (id = anchorId) =>
        rows
          .and(page.locator(`[data-solo-destination-id="${id}"]`))
          .evaluate((row) => {
            const port = row.closest('nav[aria-label="Subscribed channels"]');
            return (
              row.getBoundingClientRect().top - port.getBoundingClientRect().top
            );
          });
      await viewport.evaluate(
        async (port, offset) => {
          port.scrollTop += offset - 12;
          // Let the scroll event record this position before publishing rows.
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        },
        await position(),
      );
      const before = await position();
      expect(before).toBeGreaterThanOrEqual(0);
      expect(before).toBeLessThan(
        await viewport.evaluate((port) => port.clientHeight),
      );

      const order = await rows.evaluateAll((elements) =>
        elements.map((element) => element.dataset.soloDestinationId),
      );
      const index = order.indexOf(anchorId);
      const neighbor = order[index + 1];
      const removed = order[index + 2];
      const neighborBefore = await position(neighbor);
      const afterFirst = await viewport.evaluate(
        (port, { rowSelector, promotedId, removed, anchorId }) =>
          new Promise((resolve) => {
            const observer = new MutationObserver(() => {
              const rows = port.querySelectorAll(rowSelector);
              if (rows[0]?.dataset.soloDestinationId !== promotedId) return;
              observer.disconnect();
              const anchor = [...rows].find(
                (row) => row.dataset.soloDestinationId === anchorId,
              );
              resolve(
                anchor.getBoundingClientRect().top -
                  port.getBoundingClientRect().top,
              );
              // Publish again before the browser dispatches the scroll event
              // for the first correction. Keep the surviving neighbor in place.
              window.fixtureSoloRegion.present([removed], [], anchorId);
            });
            observer.observe(port, { childList: true, subtree: true });
            window.fixtureSoloRegion.present([], [], promotedId);
          }),
        { rowSelector, promotedId, removed, anchorId },
      );
      expect(afterFirst).toBe(before);
      await expect(rows.first()).toHaveAttribute(
        "data-solo-destination-id",
        anchorId,
      );
      await expect(rows).toHaveCount(soloChannels.length - 1);
      await expect.poll(() => position(neighbor)).toBe(neighborBefore);

      const focusOrder = await rows.evaluateAll((elements) =>
        elements.map((element) => element.dataset.soloDestinationId),
      );
      const focusedId = focusOrder[3];
      const next = focusOrder[4];
      await viewport.evaluate(
        async (port, offset) => {
          port.scrollTop += offset;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        },
        await position(focusOrder[0]),
      );
      const focused = rows.and(
        page.locator(`[data-solo-destination-id="${focusedId}"]`),
      );
      await focused.evaluate((row) => row.focus({ preventScroll: true }));
      await expect(focused).toBeFocused();
      await page.evaluate(
        ({ removed, focusedId, next }) =>
          window.fixtureSoloRegion.present([removed, focusedId], [], next),
        { removed, focusedId, next },
      );
      await expect(rows.first()).toHaveAttribute(
        "data-solo-destination-id",
        next,
      );
      await expect(focused).toHaveCount(0);
      await expect
        .poll(() =>
          viewport.evaluate((port) => {
            const focus = document.activeElement;
            if (
              !port.contains(focus) ||
              !focus.hasAttribute("data-solo-destination-id")
            )
              return false;
            const frame = port.getBoundingClientRect();
            const box = focus.getBoundingClientRect();
            return box.top >= frame.top && box.bottom <= frame.bottom;
          }),
        )
        .toBe(true);
    },
  );
});

appTest.describe("Solo header accessories", () => {
  appTest.use({
    productionBroker: true,
    savedSidebar: [{ id: "other", name: "Other", order: 1 }],
    channelIds: ["alpha", "beta", "gamma"],
    channelNames: { alpha: "Alpha", beta: "Beta", gamma: "Gamma" },
    soloChannels: ["beta"],
    ownSoloChannels: ["beta"],
    historyCounts: { alpha: 0, beta: 0, gamma: 0 },
  });

  const admitNewTask = async (page) => {
    await page.route("**/api/relay/*/session", async (route) => {
      const response = await route.fetch();
      const session = await response.json();
      await route.fulfill({
        response,
        json: { ...session, writeKinds: [...session.writeKinds, 9007] },
      });
    });
  };

  // Real hit testing catches an accessory covered by the workspace selection
  // target. Text truncation, the trailing swap and focus use browser layout.
  appTest(
    "keeps optional controls usable in collapsed headings",
    async ({ page, app }) => {
      // The layout must fit the New task button when the relay admits chat starts.
      await admitNewTask(page);
      await page.goto(
        `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets&header-accessories`,
      );
      await openPage(page, "Messages");
      const sidebar = page.getByRole("complementary", { name: "Sidebar" });
      const resize = page.getByRole("separator", { name: "Resize sidebar" });
      await resize.dblclick();
      await expect(resize).toHaveAttribute("aria-valuenow", "260");
      for (const [selector, title] of [
        ['[data-solo-workspace="other"]', "Other"],
        ['[data-solo-channel-group="gamma"]', "Gamma"],
      ]) {
        const group = sidebar.locator(selector);
        const heading = group.getByRole("button", { name: title, exact: true });
        const disclosure = group.getByRole("button", { name: /tasks/i });
        await heading.hover();
        expect((await heading.boundingBox())?.x).toBeLessThan(
          (await disclosure.boundingBox())?.x,
        );
        await heading.focus();
        await page.keyboard.press("Tab");
        await expect(disclosure).toBeFocused();
        if (title === "Other") {
          await expect(heading.locator("svg")).toHaveCount(0);
          const actions = group.getByRole("button", {
            name: "Actions for Other",
          });
          const pencil = group.getByRole("button", {
            name: "New task in Other",
          });
          expect((await actions.boundingBox())?.x).toBeLessThan(
            (await pencil.boundingBox())?.x,
          );
        }
      }
      const headers = [
        {
          group: sidebar.locator('[data-solo-workspace="work"]'),
          title: "Work",
          accessory: "Mark Work workspace",
          activity: "3m",
          task: "Workspace task",
        },
        {
          group: sidebar.locator('[data-solo-channel-group="alpha"]'),
          title: "Alpha",
          accessory: "Mark Alpha channel",
          activity: "1d",
          task: "Channel task",
        },
      ];

      const workspaceDisclosure = headers[0].group.getByRole("button", {
        name: "Hide tasks and chats in Work",
      });
      await workspaceDisclosure.click();
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-color-mode",
          theme,
        );
        for (const { group, title, accessory, activity, task } of headers) {
          const disclosure = group.getByRole("button", { name: /tasks/i });
          const action = group.getByRole("button", { name: accessory });
          const heading = group.getByRole("button", {
            name: title,
            exact: true,
          });
          const nativeMenu = group.getByRole("button", {
            name: `Actions for ${title}`,
            exact: true,
          });
          const pencil = group.getByRole("button", {
            name: `New task in ${title}`,
            exact: true,
          });
          const metadata = group.getByText(activity, { exact: true });
          const name = heading.getByText(title, { exact: true });
          const actionPositions = async () =>
            Promise.all(
              [name, action, nativeMenu].map(
                async (button) => (await button.boundingBox())?.x,
              ),
            );
          await expect(disclosure).toHaveAttribute("aria-expanded", "false");
          await expect(group.getByRole("button", { name: task })).toBeHidden();
          await action.scrollIntoViewIfNeeded();
          await page.mouse.move(0, 0);
          await resize.focus();
          await expect(metadata).toBeVisible();
          await expect(nativeMenu.locator("..")).toHaveCSS("opacity", "0");
          const activityBox = await metadata.boundingBox();
          const menuBox = await nativeMenu.boundingBox();
          expect(activityBox).not.toBeNull();
          expect(menuBox).not.toBeNull();
          expect(menuBox.x + menuBox.width).toBeGreaterThanOrEqual(
            activityBox.x + activityBox.width,
          );
          const restingPositions = await actionPositions();
          expect(restingPositions).toEqual([
            expect.any(Number),
            expect.any(Number),
            expect.any(Number),
          ]);
          await expect
            .poll(() =>
              name.evaluate((label) => label.clientWidth >= label.scrollWidth),
            )
            .toBe(true);
          expect((await heading.boundingBox())?.x).toBeLessThan(
            (await disclosure.boundingBox())?.x,
          );
          await heading.hover();
          await expect(metadata).toBeVisible();
          await expect(nativeMenu.locator("..")).toHaveCSS("opacity", "0");
          await page.mouse.move(
            activityBox.x + activityBox.width / 2,
            activityBox.y + activityBox.height / 2,
          );
          await expect(nativeMenu.locator("..")).toHaveCSS("opacity", "1");
          await expect(metadata).toBeHidden();
          await expect(pencil).toBeVisible();
          await expect.poll(actionPositions).toEqual(restingPositions);

          await heading.click();
          await expect(heading).toHaveAttribute("data-selected");
          await page.mouse.move(
            activityBox.x + activityBox.width / 2,
            activityBox.y + activityBox.height / 2,
          );
          await pencil.click();
          await expect(heading).not.toHaveAttribute("data-selected");
          await resize.focus();
          await heading.hover();
          await expect(metadata).toBeVisible();
          await expect(nativeMenu.locator("..")).toHaveCSS("opacity", "0");

          await page.mouse.move(0, 0);
          await action.focus();
          await page.keyboard.press("Shift+Tab");
          await expect(action).not.toBeFocused();
          await page.keyboard.press("Tab");
          await expect(action).toBeFocused();
          await expect(action).toHaveCSS("outline-style", "solid");
          await expect(metadata).toBeVisible();
          await expect.poll(actionPositions).toEqual(restingPositions);
          await page.keyboard.press("Shift+F10");
          await expect(page.getByRole("menu")).toHaveCount(0);
          await page.keyboard.press("Enter");
          await expect(action).toHaveAttribute("aria-pressed", "true");
          await action.click();
          await expect(action).toHaveAttribute("aria-pressed", "false");
          await expect(disclosure).toHaveAttribute("aria-expanded", "false");
          await expect(heading).not.toHaveAttribute("aria-current");
          await expect(page.getByRole("menu")).toHaveCount(0);
          await disclosure.press("Enter");
          await expect(disclosure).toHaveAttribute("aria-expanded", "true");
          await expect.poll(actionPositions).toEqual(restingPositions);
          await disclosure.press("Enter");
          await expect(disclosure).toHaveAttribute("aria-expanded", "false");
          await action.focus();
          await page.keyboard.press("Tab");
          await expect(pencil).toBeFocused();
          await expect(metadata).toBeHidden();
          await page.keyboard.press("Tab");
          await expect(nativeMenu).toBeFocused();
        }
      }
      await expect(sidebar.getByRole("button", { name: /^Mark / })).toHaveCount(
        2,
      );
      for (const { group, title, accessory, activity } of headers) {
        const mark = group.getByRole("button", { name: accessory });
        const actions = group.getByRole("button", {
          name: `Actions for ${title}`,
        });
        const time = group.getByText(activity, { exact: true });
        await mark.press("Enter");
        await expect(mark).toHaveAttribute("aria-pressed", "true");
        await actions.focus();
        await page.evaluate(() =>
          window.fixtureSoloRegion.showHeaderMetadata(false),
        );
        await expect(time).toHaveCount(0);
        await expect.soft(actions).toBeFocused();
        await expect.soft(mark).toHaveAttribute("aria-pressed", "true");
        await actions.focus();
        await page.evaluate(() =>
          window.fixtureSoloRegion.showHeaderMetadata(true),
        );
        await expect(time).toHaveCount(1);
        await expect(actions).toBeFocused();
        await expect(mark).toHaveAttribute("aria-pressed", "true");
        await actions.press("Enter");
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        await page.evaluate(() =>
          window.fixtureSoloRegion.showHeaderMetadata(false),
        );
        await expect(time).toHaveCount(0);
        await expect(menu).toBeVisible();
        await page.evaluate(() =>
          window.fixtureSoloRegion.showHeaderMetadata(true),
        );
        await expect(time).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      }
      await headers[0].group
        .getByRole("button", { name: "Actions for Work" })
        .press("Enter");
      await expect(
        page.getByRole("menuitem", { name: "New task" }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "New chat" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      const channelGroup = headers[1].group;
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "24px";
      });
      await channelGroup
        .getByRole("button", { name: "Alpha", exact: true })
        .hover();
      await channelGroup
        .getByRole("button", { name: "Actions for Alpha" })
        .press("Enter");
      await expect(
        page.getByRole("menuitem", { name: "New task" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      const channelTitle = channelGroup.getByText("Alpha", { exact: true });
      await expect
        .poll(() =>
          channelTitle.evaluate(
            (label) => label.clientWidth >= label.scrollWidth,
          ),
        )
        .toBe(true);
      await resize.press("ArrowRight");
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      for (const { group, title, accessory, activity } of headers) {
        const label = group.getByText(title, { exact: true });
        await label.hover();
        await expect
          .poll(() =>
            label.evaluate((item) => item.clientWidth >= item.scrollWidth),
          )
          .toBe(true);
        const signal = await group
          .getByRole("button", { name: accessory })
          .boundingBox();
        const time = await group
          .getByText(activity, { exact: true })
          .boundingBox();
        expect(
          Math.abs(signal.y + signal.height / 2 - time.y - time.height / 2),
        ).toBeLessThan(1);
        const pencil = group.getByRole("button", {
          name: `New task in ${title}`,
        });
        await pencil.focus();
        await page.evaluate(() =>
          window.fixtureSoloRegion.showHeaderMetadata(false),
        );
        await expect(group.getByText(activity, { exact: true })).toHaveCount(0);
        await expect(pencil).toBeFocused();
        await resize.focus();
        await expect(pencil).toBeHidden();
        await page.evaluate(() =>
          window.fixtureSoloRegion.showHeaderMetadata(true),
        );
        await expect(group.getByText(activity, { exact: true })).toHaveCount(1);
      }
    },
  );

  appTest(
    "keeps the Actions trigger visible after closing channel creation",
    async ({ page, app }) => {
      await admitNewTask(page);
      await page.goto(
        `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets&header-accessories&leading-header`,
      );
      await openPage(page, "Messages");
      const workspace = page.locator('[data-solo-workspace="work"]');
      const time = workspace.getByText("3m", { exact: true });
      const actions = workspace.getByRole("button", {
        name: "Actions for Work",
      });
      const timing = await time.boundingBox();
      await page.mouse.move(
        timing.x + timing.width / 2,
        timing.y + timing.height / 2,
      );
      await actions.click();
      await page
        .getByRole("menuitem", { name: "New channel", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create a channel in Work",
      });
      await dialog
        .getByRole("button", { name: "Close channel creation" })
        .click();
      await page.mouse.move(0, 0);
      await expect(dialog).toBeHidden();
      await expect(actions).toBeFocused();
      await expect(time).toBeHidden();
      await expect(actions.locator("..")).toHaveCSS("opacity", "1");
    },
  );

  for (const hasTouch of [false, true]) {
    appTest.describe(hasTouch ? "touch metadata" : "pointer metadata", () => {
      const workspaceTitle = "Workspace planning and weekly status";
      const channelTitle = "channel-planning-and-weekly-status";
      appTest.use({
        hasTouch,
        savedSidebar: [{ id: "other", name: workspaceTitle, order: 1 }],
        channelNames: { alpha: "Alpha", beta: "Beta", gamma: channelTitle },
      });

      if (hasTouch) {
        // A real tap detects an always-visible action stealing the accessory's hit target.
        appTest(
          "keeps accessories and Actions tappable beside header activity",
          async ({ page, app }) => {
            await admitNewTask(page);
            await page.goto(
              `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets&header-accessories`,
            );
            await openPage(page, "Messages");
            for (const [selector, title, accessory] of [
              ['[data-solo-workspace="work"]', "Work", "Mark Work workspace"],
              [
                '[data-solo-channel-group="alpha"]',
                "Alpha",
                "Mark Alpha channel",
              ],
            ]) {
              const group = page.locator(selector);
              const mark = group.getByRole("button", { name: accessory });
              await expect(
                group.getByRole("button", { name: `New task in ${title}` }),
              ).toBeVisible();
              await mark.scrollIntoViewIfNeeded();
              const box = await mark.boundingBox();
              await page.touchscreen.tap(
                box.x + box.width / 2,
                box.y + box.height / 2,
              );
              await expect.soft(mark).toHaveAttribute("aria-pressed", "true");
              const actions = group.getByRole("button", {
                name: `Actions for ${title}`,
              });
              const actionsBox = await actions.boundingBox();
              await page.touchscreen.tap(
                actionsBox.x + actionsBox.width / 2,
                actionsBox.y + actionsBox.height / 2,
              );
              await expect(actions).toHaveAttribute("aria-expanded", "true");
              await page.keyboard.press("Escape");
            }
          },
        );
      }

      appTest(
        "keeps both actions clear of long metadata-only titles",
        async ({ page, app }) => {
          await admitNewTask(page);
          await page.goto(
            `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets&header-accessories&leading-header`,
          );
          await openPage(page, "Messages");
          const resize = page.getByRole("separator", {
            name: "Resize sidebar",
          });
          await resize.dblclick();
          await expect(resize).toHaveAttribute("aria-valuenow", "260");
          for (const [selector, title, activity, fontSize] of [
            ['[data-solo-workspace="other"]', workspaceTitle, "3m", "16px"],
            ['[data-solo-channel-group="gamma"]', channelTitle, "1d", "19px"],
          ]) {
            await page.evaluate((fontSize) => {
              document.documentElement.style.fontSize = fontSize;
            }, fontSize);
            const group = page.locator(selector);
            const heading = group.getByRole("button", {
              name: title,
              exact: true,
            });
            const label = heading.getByText(title, { exact: true });
            const time = group.getByText(activity, { exact: true });
            const pencil = group.getByRole("button", {
              name: `New task in ${title}`,
            });
            const actions = group.getByRole("button", {
              name: `Actions for ${title}`,
            });
            await heading.scrollIntoViewIfNeeded();
            const rest = await label.boundingBox();
            if (!hasTouch) {
              await expect(time).toBeVisible();
              const timing = await time.boundingBox();
              await page.mouse.move(
                timing.x + timing.width / 2,
                timing.y + timing.height / 2,
              );
            }
            await expect(time).toBeHidden();
            await expect(actions.locator("..")).toHaveCSS("opacity", "1");
            expect(await label.boundingBox()).toEqual(rest);
            const button = await pencil.boundingBox();
            expect
              .soft(rest.x + rest.width, title)
              .toBeLessThanOrEqual(button.x);
          }
        },
      );
    });
  }
  appTest(
    "shares the leading slot between a header action and disclosure",
    async ({ page, app }) => {
      await page.clock.install();
      await page.goto(
        `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets&header-accessories&leading-header`,
      );
      await openPage(page, "Messages");
      const sidebar = page.getByRole("complementary", { name: "Sidebar" });
      const resize = page.getByRole("separator", { name: "Resize sidebar" });
      await resize.dblclick();
      for (const [selector, title, icon] of [
        ['[data-solo-workspace="work"]', "Work", "cube-3d-sphere"],
        ['[data-solo-channel-group="alpha"]', "Alpha", "hash"],
      ]) {
        const group = sidebar.locator(selector);
        const heading = group.getByRole("button", { name: title, exact: true });
        const action = group.getByRole("button", { name: /open .* summary/i });
        const disclosure = group.getByRole("button", { name: /tasks/i });
        const marker = heading.locator(`:scope > svg.tabler-icon-${icon}`);
        await expect(marker).toHaveCount(1);
        await expect(marker).toBeVisible();
        await expect(heading).toHaveText(title);
        if ((await disclosure.getAttribute("aria-expanded")) === "true") {
          await disclosure.click();
        }
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await heading.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await resize.focus();
        await expect(action).toHaveCSS("opacity", "1");
        await expect(disclosure).toHaveCSS("opacity", "0");
        const titleBox = await heading.boundingBox();
        const leadingBox = await action.boundingBox();
        await heading.hover();
        await expect(action).toHaveCSS("opacity", "0");
        await expect(disclosure).toHaveCSS("opacity", "1");
        await expect(marker).toBeVisible();
        expect(await disclosure.boundingBox()).toEqual(leadingBox);
        expect(await heading.boundingBox()).toEqual(titleBox);
        const anchor = group.locator("[data-fixture-summary-anchor]");
        await expect(anchor).toHaveCount(1);
        await expect(anchor.getByRole("button")).toHaveCount(2);
        await disclosure.hover();
        await expect(anchor).toHaveAttribute("data-hovered", "true");
        await page.clock.runFor(1_000);
        await expect(
          page.getByRole("tooltip").filter({
            hasText: await disclosure.getAttribute("aria-label"),
          }),
        ).toHaveCount(0);
        await heading.hover();
        await expect(anchor).not.toHaveAttribute("data-hovered");
        await disclosure.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
        await disclosure.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");

        await page.mouse.move(0, 0);
        await heading.focus();
        await page.keyboard.press("Shift+Tab");
        await expect(disclosure).toBeFocused();
        await expect(disclosure).toHaveCSS("opacity", "1");
        await page.keyboard.press("Shift+Tab");
        await expect(action).toBeFocused();
        await expect(action).toHaveCSS("opacity", "1");
        await expect(disclosure).toHaveCSS("opacity", "0");
        await page.keyboard.press("Enter");
        await expect(action).toHaveAccessibleName(`Reopen ${title} summary`);
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");

        await group
          .getByRole("button", { name: `Actions for ${title}` })
          .press("Enter");
        await page
          .getByRole("menuitem", { name: `Reopen ${title} summary` })
          .click();
        await expect(action).toHaveAccessibleName(`Open ${title} summary`);
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await expect(heading).not.toHaveAttribute("data-selected");
      }
      for (const [selector, title, icon] of [
        ['[data-solo-workspace="other"]', "Other", undefined],
        ['[data-solo-channel-group="gamma"]', "Gamma", "hash"],
      ]) {
        const heading = sidebar
          .locator(selector)
          .getByRole("button", { name: title, exact: true });
        const marker = heading.locator(":scope > svg");
        await heading.hover();
        if (icon) {
          await expect(marker).toHaveClass(new RegExp(`tabler-icon-${icon}`));
          await expect(marker).toBeVisible();
        } else {
          await expect(marker).toHaveCount(0);
        }
        await expect(heading).toHaveText(title);
      }
      await expect(resize).toHaveAttribute("aria-valuenow", "260");
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      const workspaceTitle = sidebar
        .getByRole("button", { name: "Work", exact: true })
        .getByText("Work", { exact: true });
      await expect
        .poll(() =>
          workspaceTitle.evaluate(
            (label) => label.clientWidth >= label.scrollWidth,
          ),
        )
        .toBe(true);
    },
  );

  appTest.describe("touch workspace header", () => {
    appTest.use({ hasTouch: true });

    appTest(
      "opens the leading action after a workspace drag",
      async ({ page, app }) => {
        await page.goto(
          `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets&header-accessories&leading-header`,
        );
        await openPage(page, "Messages");
        const workspace = page.locator('[data-solo-workspace="work"]');
        const title = workspace.getByRole("button", {
          name: "Work",
          exact: true,
        });
        const leading = workspace.getByRole("button", {
          name: /open work summary/i,
        });
        await title.scrollIntoViewIfNeeded();
        const box = await title.boundingBox();
        if (!box) throw new Error("Workspace title is missing");
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 40, y);
        await expect(page.locator("[data-section-dragging]")).toHaveCount(1);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await expect(page.locator("[data-section-dragging]")).toHaveCount(0);
        await leading.tap();
        await expect(leading).toHaveAccessibleName("Reopen Work summary");
        await expect(title).not.toHaveAttribute("data-selected");
      },
    );
  });

  appTest.describe("workspace move focus", () => {
    appTest.use({
      soloChannels: ["beta", "gamma"],
      ownSoloChannels: ["beta", "gamma"],
    });

    appTest(
      "shows the focused disclosure after a pointer move into a closed workspace",
      async ({ page, app }) => {
        await page.goto(
          `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets&leading-header`,
        );
        await openPage(page, "Messages");
        const sidebar = page.getByRole("complementary", { name: "Sidebar" });
        const workspace = sidebar.locator('[data-solo-workspace="work"]');
        const disclosure = workspace.getByRole("button", {
          name: /tasks and chats in Work/,
        });
        const chat = sidebar.getByRole("button", {
          name: "Gamma",
          exact: true,
        });
        await expect(
          workspace.getByRole("button", { name: /open work summary/i }),
        ).toHaveCount(1);
        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
        await disclosure.click();
        await chat.click({ button: "right" });
        await page
          .getByRole("menuitem", { name: "Move to", exact: true })
          .hover();
        await page.getByRole("menuitem", { name: "Work", exact: true }).click();
        await page.mouse.move(0, 0);
        await expect(disclosure).toBeFocused();
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await expect(disclosure).toHaveCSS("opacity", "1");
        await expect(chat).toBeHidden();
        await page.keyboard.press("Enter");
        await expect(
          workspace.getByRole("button", { name: "Gamma", exact: true }),
        ).toBeVisible();
      },
    );
  });
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
