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
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  await sidebar.getByRole("button", { name: "Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Move to", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("menuitem", { name: "New workspace", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "Create new workspace" });
  await create.getByRole("textbox", { name: "Workspace name" }).fill("Work");
  await create.getByRole("button", { name: "Create and move" }).click();
  await expect(
    sidebar.getByRole("button", { name: "Work", exact: true }),
  ).toBeVisible();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  const initial = app.report.sidebarPublications[0].blob.value;
  const id = initial.groups[0].id;
  const createdAt = app.report.sidebarPublications[0].event.created_at * 1000;
  const header = sidebar.locator(`[data-solo-menu-id="project-${id}"]`);
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
    const title = sidebar.getByRole("button", { name, exact: true });
    await expect(title).toBeVisible();
    const open = async () => {
      if (composed) {
        await title.focus();
        await page.keyboard.press("Shift+F10");
      } else {
        await header
          .getByRole("button", { name: `Actions for ${name}` })
          .click();
      }
      const settings = page.getByRole("menuitem", {
        name: "Workspace settings",
        exact: true,
      });
      await expect(settings).toBeVisible();
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
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    if (!composed) {
      // Existing same-second replacement refusal keeps both inputs for retry.
      await expect(settings.getByRole("alert")).toContainText("wait a second");
      await expect(field).toHaveValue(name);
      await page.clock.setFixedTime(createdAt + 1000);
      await settings
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
    }
    await expect(settings).toHaveCount(0);
    await expect
      .poll(() => app.report.sidebarPublications.length)
      .toBe(composed ? 5 : 3);
    const saved = app.report.sidebarPublications
      .slice(-2)
      .map(({ blob }) => blob.value);
    expect(saved).toEqual([
      { ...initial, groups: [{ ...initial.groups[0], name }] },
      expect.objectContaining({
        type: "template",
        name: `${name} chats`,
        canvas: "Keep the workspace context",
      }),
    ]);
    await page.reload();
    if (composed) await show.click();
    await expect(
      sidebar.getByRole("button", { name, exact: true }),
    ).toBeVisible();
    await expect(
      sidebar
        .locator(`[data-solo-project="${id}"]`)
        .getByRole("button", { name: "Alpha", exact: true }),
    ).toBeVisible();
  }
  expect(app.report.unexpected).toEqual([]);
});
