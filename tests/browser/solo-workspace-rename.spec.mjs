import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

const chat = "33333333-3333-4333-8333-333333333333";
test.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [chat],
  channelNames: { [chat]: "Alpha" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  historyCounts: { [chat]: 1 },
});

// Menu/dialog handoff, responsive drawer and signed readback after reload
// need the shell. Validation and legacy dirty-state cases stay in Vitest.
test("workspace settings rename preserves filing in ordinary and composed headings", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await sidebar.getByRole("button", { name: "Alpha", exact: true }).hover();
  await sidebar.getByRole("button", { name: "Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Move to…", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("menuitem", { name: "Create new…", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "Move to new workspace" });
  await create.getByRole("textbox", { name: "Name", exact: true }).fill("Work");
  await create.getByRole("button", { name: "Create and move" }).click();
  await expect(sidebar.locator('summary[aria-label="Work"]')).toBeVisible();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  const initial = app.report.sidebarPublications[0].blob;
  const id = initial.sections[0].id;
  const createdAt = app.report.sidebarPublications[0].event.created_at * 1000;
  const header = sidebar.locator(`[data-sidebar-section="group:${id}"]`);
  let name = "Work";
  for (const composed of [false, true]) {
    if (composed) {
      await page.setViewportSize({ width: 480, height: 900 });
      await page.goto(
        `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets`,
      );
      await newChat(page);
      await page.evaluate(() => {
        document.documentElement.dataset.colorMode = "dark";
        document.documentElement.style.fontSize = "200%";
      });
    }
    await page.clock.setFixedTime(createdAt + (composed ? 3000 : 0));
    const show = page.getByRole("button", {
      name: "Show navigation",
      exact: true,
    });
    if (await show.isVisible()) await show.click();
    const title = () =>
      composed
        ? sidebar.getByRole("button", { name, exact: true })
        : header.locator("summary");
    await expect(title()).toBeVisible();
    const open = async () => {
      if (composed) {
        await title().focus();
        await page.keyboard.press("Shift+F10");
      } else {
        await header
          .getByRole("button", { name: `More actions for ${name}` })
          .click();
      }
      const settings = page.getByRole("menuitem", {
        name: "Workspace settings",
        exact: true,
      });
      await expect(settings).toBeVisible();
      await expect(
        page.getByRole("menuitem", {
          name: "Archive inactive chats",
          exact: true,
        }),
      ).toHaveCount(0);
      if (!composed)
        await expect(
          page.getByRole("menuitem", { name: "Filter", exact: true }),
        ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Rename workspace", exact: true }),
      ).toHaveCount(0);
      await settings.click();
      const dialog = page.getByRole("dialog", { name: "Workspace settings" });
      await expect(
        dialog.getByRole("textbox", { name: "Workspace name" }),
      ).toBeEnabled();
      return dialog;
    };
    // Untouched settings close directly; reopening begins a fresh edit.
    let settings = await open();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(
      page.getByRole("alertdialog", { name: "Discard changes?" }),
    ).toHaveCount(0);
    settings = await open();
    const field = settings.getByRole("textbox", { name: "Workspace name" });
    await expect(field).toHaveValue(name);
    name = composed ? "Weekend work" : "Project plans";
    await field.fill(name);
    await settings
      .getByRole("textbox", { name: /^Instructions/ })
      .fill("Keep the workspace context");
    if (!composed)
      await page.route("**/sidebar-section-rename", (route) => {
        app.report.sidebarPreferenceFailures ??= [];
        app.report.sidebarPreferenceFailures.push(route.request().url());
        return route.fulfill({ status: 502, json: { error: "Rename failed" } });
      });
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    if (!composed) {
      await expect(settings.getByRole("alert")).toContainText("502");
      await expect(field).toHaveValue(name);
      await expect(
        settings.getByRole("textbox", { name: /^Instructions/ }),
      ).toHaveValue("Keep the workspace context");
      await page.unroute("**/sidebar-section-rename");
      await page.clock.setFixedTime(createdAt + 1000);
      await settings
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
    }
    await expect(settings).toHaveCount(0);
    await expect
      .poll(() => app.report.sidebarPublications.length)
      .toBe(composed ? 4 : 3);
    const saved = app.report.sidebarPublications
      .slice(composed ? -1 : -2)
      .map(({ blob, coordinate }) =>
        coordinate === "channel-workspaces" ? blob : blob.value,
      );
    expect(saved).toEqual([
      { ...initial, sections: [{ ...initial.sections[0], name }] },
      ...(!composed
        ? [
            expect.objectContaining({
              type: "template",
              name: `${name} chats`,
              canvas: "Keep the workspace context",
            }),
          ]
        : []),
    ]);
    await page.reload();
    if (composed) await show.click();
    await expect(title()).toBeVisible();
    await expect(
      sidebar
        .locator(`[data-sidebar-section="group:${id}"]`)
        .getByRole("button", { name: "Alpha", exact: true }),
    ).toBeVisible();
  }
  expect(app.report.unexpected).toEqual([]);
});
