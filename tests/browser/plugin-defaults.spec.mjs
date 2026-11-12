import { pluginAction } from "./plugin-settings.mjs";
import { openCommunityPicker } from "./navigation.mjs";
import {
  closeSettings,
  openSettings,
  openPage,
  selectSettingsSection,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function plugins(page) {
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
}

// An unseeded page exercises startup ordering: plugin storage must commit its
// fresh defaults before community initialization can create an install marker.
test("cold app startup pins fresh defaults and activates opt-in Bestie setup", async ({
  context,
  app,
}) => {
  const fresh = await context.newPage();
  app.watchPageErrors(fresh);
  const choices = () =>
    fresh.evaluate(() => {
      const raw = localStorage.getItem("buzzodz.plugins.v1");
      return raw ? JSON.parse(raw).enabled : null;
    });
  await fresh.goto(app.origin);
  await expect.poll(choices).toMatchObject({
    "buzz.reminders": false,
    "buzz.workflows": false,
    "buzz.bestie": true,
  });
  // Add the account only after first-run defaults are durable. This exercises
  // real plugin activation after community setup without pre-seeding preferences.
  await fresh.evaluate((viewer) => {
    localStorage.setItem(
      `buzz-client.v1:${viewer}`,
      JSON.stringify({
        profile: { name: "Fresh install" },
        memberships: [{ id: "primary", name: "Primary" }],
        selected: "primary",
      }),
    );
  }, app.viewer);
  await fresh.reload();
  await expect.poll(choices).toMatchObject({
    "buzz.reminders": false,
    "buzz.workflows": false,
    "buzz.bestie": true,
  });
  await openPage(fresh, "Messages");
  const destination = fresh
    .getByRole("navigation", { name: "Apps dock" })
    .getByRole("tab", { name: "Create an agent", exact: true });
  await expect(destination).toBeVisible();
  await destination.click();
  const setup = fresh.getByRole("region", { name: "Bestie" });
  await expect(
    setup.getByRole("heading", { name: "Create your first agent" }),
  ).toBeVisible();
  await expect(
    setup.getByRole("button", { name: "Create an agent", exact: true }),
  ).toBeVisible();
});

// Exercise the client-record heuristic before any plugin settings exist,
// without the shared page's init script manufacturing explicit preferences.
test("an untouched client profile keeps its previous plugin defaults across reopen", async ({
  context,
  app,
}) => {
  const upgraded = await context.newPage();
  await upgraded.route(
    new URL("/", app.origin).href,
    (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    { times: 1 },
  );
  await upgraded.goto(app.origin);
  await upgraded.evaluate((viewer) => {
    localStorage.setItem(
      `buzz-client.v1:${viewer}`,
      JSON.stringify({
        profile: { name: "Untouched upgrade" },
        memberships: [{ id: "primary", name: "Primary" }],
        selected: "primary",
      }),
    );
  }, app.viewer);
  expect(await upgraded.evaluate(() => Object.keys(localStorage))).toEqual([
    `buzz-client.v1:${app.viewer}`,
  ]);
  for (let launch = 0; launch < 2; launch++) {
    await upgraded.reload();
    await plugins(upgraded);
    for (const name of ["Reminders", "Workflows"])
      await expect(pluginAction(upgraded, name)).toHaveAccessibleName(
        /^Disable /,
      );
    await expect(pluginAction(upgraded, "Bestie")).toHaveAccessibleName(
      /^Enable /,
    );
    expect(
      await upgraded.evaluate(
        () => JSON.parse(localStorage.getItem("buzzodz.plugins.v1")).enabled,
      ),
    ).toMatchObject({
      "buzz.reminders": true,
      "buzz.workflows": true,
      "buzz.bestie": false,
    });
    await closeSettings(upgraded);
  }
});

// The shared fixture has partial settings and models an existing installation.
// Representative app wiring: real catalogs -> Settings actions -> sidebar page,
// across reload. Choice permutations live in storage unit tests.
test("an existing profile can opt in to Bestie and keep its choice across reload", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page
      .getByRole("navigation", { name: "Apps dock" })
      .getByRole("tab", { name: "Create an agent", exact: true }),
  ).toHaveCount(0);
  await plugins(page);
  const bestie = pluginAction(page, "Bestie");
  await expect(bestie).toHaveAccessibleName(/^Enable /);
  for (const name of ["GitHub", "Terminal", "Builderlab", "Attention"])
    await expect(pluginAction(page, name)).toHaveAccessibleName(/^Disable /);
  for (const name of ["Reminders", "Workflows"])
    await expect(pluginAction(page, name)).toHaveAccessibleName(/^Enable /);
  await bestie.click();
  await expect(bestie).toHaveAccessibleName(/^Disable /);
  await page.reload();
  await expect(bestie).toHaveAccessibleName(/^Disable /);
  await closeSettings(page);
  await openPage(page, "Messages");
  await expect(
    page
      .locator(".shell-header")
      .getByRole("button", { name: "Create an agent", exact: true }),
  ).toHaveCount(0);
  const destination = page
    .getByRole("navigation", { name: "Apps dock" })
    .getByRole("tab", { name: "Create an agent", exact: true });
  await expect(destination).toBeVisible();
  await destination.click();
  const bestiePage = page.getByRole("region", { name: "Bestie" });
  await expect(bestiePage).toBeVisible();
  await expect(
    bestiePage.getByRole("heading", { name: "Create your first agent" }),
  ).toBeVisible();
  const createAgent = bestiePage.getByRole("button", {
    name: "Create an agent",
  });
  await expect(createAgent).toBeVisible();
  await plugins(page);
  await bestie.click();
  await expect(bestie).toHaveAccessibleName(/^Enable /);
  await page.reload();
  await expect(bestie).toHaveAccessibleName(/^Enable /);
  // The workspace behind Settings is hidden from the accessibility tree.
  await closeSettings(page);
  await expect(
    page
      .getByRole("navigation", { name: "Apps dock" })
      .getByRole("tab", { name: "Create an agent", exact: true }),
  ).toHaveCount(0);
});

// Browser startup must migrate a pre-snapshot profile before activating plugins.
// This also checks that a later deliberate disable survives the refresh loop.
test("an existing profile keeps Reminders and Workflows until deliberately disabled", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page.evaluate(() => {
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({ version: 3, enabled: {} }),
    );
  });
  await page.reload();
  await plugins(page);
  for (const name of ["Reminders", "Workflows"])
    await expect(pluginAction(page, name)).toHaveAccessibleName(/^Disable /);
  await closeSettings(page);
  await openPage(page, "Workflows");
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await plugins(page);
  for (const name of ["Reminders", "Workflows"])
    await pluginAction(page, name).click();
  await page.reload();
  for (const name of ["Reminders", "Workflows"])
    await expect(pluginAction(page, name)).toHaveAccessibleName(/^Enable /);
});

// Real App -> shell -> rail Settings-registry wiring, including the scoped
// destination. Role and contribution-removal permutations stay in jsdom.
test("Membership action removes and restores the working Invite destination", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (filters.every((filter) => filter.kinds?.includes(13534)))
      return route.fulfill({ json: [app.membershipSnapshot("owner")] });
    return route.continue();
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const invite = page.getByRole("menuitem", {
    name: "Invite to community",
    exact: true,
  });
  const menu = async () => {
    await openCommunityPicker(page);
    await button(page, "Switch to Primary").click({ button: "right" });
    await expect(
      page.getByRole("menu", { name: "Actions for Primary" }),
    ).toBeVisible();
  };
  await plugins(page);
  const admin = pluginAction(page, "Membership");
  await expect(admin).toHaveAccessibleName(/^Disable /);
  const moderation = pluginAction(page, "Moderation");
  await expect(moderation).toHaveAccessibleName("Disable Moderation");
  await expect(moderation).toHaveAccessibleDescription(
    "Access is unavailable in this build or on this relay.",
  );
  await expect(moderation).not.toHaveAttribute("aria-disabled", "true");
  await moderation.click();
  await expect(moderation).toHaveAccessibleName("Unavailable Moderation");
  await page.reload();
  await expect(moderation).toHaveAccessibleName("Unavailable Moderation");
  await expect(admin).toHaveAccessibleName(/^Disable /);
  await closeSettings(page);
  await menu();
  await expect(invite).toBeVisible();
  await page.keyboard.press("Escape");
  await plugins(page);
  await admin.click();
  await expect(admin).toHaveAccessibleName(/^Enable /);
  await closeSettings(page);
  await menu();
  await expect(invite).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Leave community", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await plugins(page);
  await admin.click();
  await expect(admin).toHaveAccessibleName(/^Disable /);
  await closeSettings(page);
  await menu();
  await invite.click();
  await expect(
    page.getByRole("heading", { name: "Membership", exact: true }),
  ).toBeVisible();
});
