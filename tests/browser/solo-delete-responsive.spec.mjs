import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const id = "11111111-1111-4111-8111-111111111111";
test.use({
  productionBroker: true,
  channelLifecycle: true,
  soloChannels: [id],
  historyCounts: { alpha: 2, beta: 1 },
});

test("deleting the selected Solo chat leaves it while signing is pending", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.getByRole("button", {
    name: "Lifecycle channel",
    exact: true,
  });
  await row.click();
  await expect(
    page.getByRole("button", { name: "Chat actions", exact: true }),
  ).toBeVisible();
  const original = page.url();
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Delete chat", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete Lifecycle channel?",
  });
  await expect(dialog).toBeVisible();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const signing = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/api/relay/**/channel-lifecycle-sign", async (route) => {
    started();
    await gate;
    await route.continue();
  });
  try {
    await dialog
      .getByRole("button", { name: "Delete chat", exact: true })
      .click();
    await signing;
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(original);
    await expect(row).toBeVisible();
    expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
    // The real router retires the deleted chat's visit. Its cancellation must
    // not abort the session-owned write; the new composer remains usable.
    const composer = page.getByRole("textbox", { name: "Message your agents" });
    await composer.fill("Continue while deletion finishes");
    await expect(composer).toHaveText("Continue while deletion finishes");
    // Reopening the still-listed chat creates a new visit while its old
    // session-owned deletion is pending. Completion must retire this visit too.
    await row.click();
    await expect(page).toHaveURL(original);
  } finally {
    release();
  }
  await expect(
    page.getByRole("dialog", { name: "Chat deleted: Lifecycle channel" }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page).not.toHaveURL(original);
  await expect(
    page.getByRole("textbox", { name: "Message your agents" }),
  ).toHaveText("Continue while deletion finishes");
  await page.reload();
  await expect(
    sidebar.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual([
    9008,
  ]);
  expect(app.report.unexpected).toEqual([]);
});
