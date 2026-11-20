import { test, expect } from "./fixture.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";
import {
  closeSettings,
  newChat,
  openSettings,
  selectSettingsSection,
  settleShellToggle,
} from "./navigation.mjs";

const alpha = "33333333-3333-4333-8333-333333333333";
const beta = "44444444-4444-4444-8444-444444444444";

test.use({
  pluginFixtures: true,
  historyCounts: { alpha: 0, beta: 0 },
});

// Real storage events between windows and app startup are outside jsdom's boundary.
test("region state reaches the component after a headless write and a write in another window", async ({
  page,
  app,
  context,
}) => {
  const url = `${app.origin}/?solo-region-fixture&region-state-fixture`;
  await page.goto(url);
  await newChat(page);
  await page.evaluate(() => {
    const fixture = window.fixtureSoloRegion;
    if (!fixture.state().set({ filter: "running" }))
      throw new Error("Write failed");
    fixture.status("ready");
  });
  const output = page.getByLabel("Region state");
  await expect(output).toHaveText('{"filter":"running"}');
  const other = await context.newPage();
  await other.goto(url);
  await newChat(other);
  await other.evaluate(() => {
    const fixture = window.fixtureSoloRegion;
    if (!fixture.state().set({ filter: "needs-you" }))
      throw new Error("Write failed");
  });
  await expect(output).toHaveText('{"filter":"needs-you"}');
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => {
        try {
          return window.fixtureSoloRegion?.state().get();
        } catch {
          return undefined;
        }
      }),
    )
    .toEqual({ filter: "needs-you" });
  await page.evaluate(() => window.fixtureSoloRegion.status("ready"));
  await expect(output).toHaveText('{"filter":"needs-you"}');
});

test.describe("disabled plugin chat fallback", () => {
  test.use({
    productionBroker: true,
    channelIds: [alpha, beta],
    channelNames: { [alpha]: "Alpha", [beta]: "Beta" },
    soloChannels: [alpha],
    ownSoloChannels: [alpha],
    historyCounts: { [alpha]: 1, [beta]: 0 },
  });

  test("keeps an existing chat in Solo while its plugin is off, then reclaims it", async ({
    page,
    app,
  }) => {
    await page.clock.install();
    await page.goto(`${app.origin}/?solo-region-fixture`);
    await newChat(page);
    await page.evaluate(async (id) => {
      await window.fixtureSoloRegion.createWorkspace();
      await window.fixtureSoloRegion.classify(id);
    }, alpha);

    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    const ordinary = sidebar.locator(`[data-channel-id="${alpha}"]`);
    const region = sidebar.locator(
      `[data-solo-destination-root="${alpha}"] [data-solo-destination-id="${alpha}"]`,
    );
    await expect(ordinary).toHaveCount(0);
    await expect(region).toHaveCount(1);
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();

    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    await expect(history.locator("[data-message-id]")).toHaveCount(1);
    const messageId = await history
      .locator("[data-message-id]")
      .getAttribute("data-message-id");

    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    await setPluginEnabled(page, "Solo region fixture", false);
    await closeSettings(page);

    await expect(ordinary).toHaveCount(1);
    await expect(region).toHaveCount(0);
    await expect(
      page.getByText("The plugin for these chats is off.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", {
        name: "Open plugin settings",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(history.locator("[data-message-id]")).toHaveAttribute(
      "data-message-id",
      messageId,
    );

    // The fallback row remains selectable while its plugin owns its filing.
    await ordinary.click({ button: "right" });
    const actions = page.getByRole("menu", { name: "Actions for Alpha" });
    await expect(actions).toBeVisible();
    await expect(
      actions.getByRole("menuitem", { name: "Move to…", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(actions).toBeHidden();

    const workspace = sidebar.locator(
      '[data-sidebar-section="group:fixture-workspace"] summary',
    );
    await expect(workspace).toBeVisible();
    const writes = app.report.sidebarPublications.length;
    await ordinary.hover();
    const from = await ordinary.boundingBox();
    const to = await workspace.boundingBox();
    if (!from || !to) throw new Error("Workspace drag target is missing");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 8,
    });
    await expect(sidebar.locator("[data-channel-dragging]")).toHaveCount(0);
    await expect(sidebar.locator("[data-drop-target]")).toHaveCount(0);
    await page.mouse.up();
    expect(app.report.sidebarPublications).toHaveLength(writes);
    await expect(
      sidebar
        .locator('[data-sidebar-section="group:fixture-workspace"]')
        .locator(`[data-solo-destination-id="${alpha}"]`),
    ).toHaveCount(0);

    await newChat(page);
    await expect(sidebar).toBeVisible();
    await expect(ordinary).toBeVisible();
    await ordinary.focus();
    await page.keyboard.press("Enter");
    await expect(history.locator("[data-message-id]")).toHaveAttribute(
      "data-message-id",
      messageId,
    );

    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    await setPluginEnabled(page, "Solo region fixture", true);
    await closeSettings(page);

    await settleShellToggle(page);
    await expect(sidebar).toBeVisible();
    await expect(ordinary).toHaveCount(0);
    await expect(region).toHaveCount(1);
    await expect(region).toBeVisible();
    await expect(history.locator("[data-message-id]")).toHaveAttribute(
      "data-message-id",
      messageId,
    );
  });
});
