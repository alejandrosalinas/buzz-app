import { selectSettingsSection, settingsSections } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

// Browser boundary: the opt-in Mesh plugin, once enabled, must expose its consumer view in Settings → Compute.
test("Mesh compute is off by default and can be enabled and disabled", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Manage plugins");
  // Main's plugin manager exposes Enable/Disable action buttons rather than switches.
  await expect(button("Enable Shared compute")).toBeVisible();
  await expect(
    settingsSections(page).getByRole("button", {
      name: "Shared compute",
      exact: true,
    }),
  ).toHaveCount(0);
  await button("Enable Shared compute").click();
  await expect(button("Disable Shared compute")).toBeVisible();
  // Contributed cards own their region label rather than the built-in section wrapper.
  await settingsSections(page)
    .getByRole("button", { name: "Shared compute", exact: true })
    .click();
  const compute = settingsSections(page).getByRole("button", {
    name: "Shared compute",
    exact: true,
  });
  await expect(compute.locator("xpath=ancestor::section[1]")).toContainText(
    "Community",
  );
  await expect(
    settingsSections(page).getByText("Shared compute", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Shared compute", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Compute consumer", exact: true })
      .getByRole("status")
      .filter({ hasText: "Open Buzz desktop to use shared compute." }),
  ).toHaveText("Open Buzz desktop to use shared compute.");
  await expect(
    page.getByText("Shared compute for Primary", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Community mesh", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Compute connected in/)).toHaveCount(0);
  await expect(button("Connect to community compute")).toHaveCount(0);
  await expect(page.getByText("This destination couldn’t open")).toHaveCount(0);
  await selectSettingsSection(page, "Manage plugins");
  await button("Disable Shared compute").click();
  await expect(button("Enable Shared compute")).toBeVisible();
  await expect(
    settingsSections(page).getByRole("button", {
      name: "Shared compute",
      exact: true,
    }),
  ).toHaveCount(0);
});
