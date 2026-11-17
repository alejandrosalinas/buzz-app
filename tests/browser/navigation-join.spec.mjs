import { selectCommunity, openCommunityPicker } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 640, beta: 1 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const entry = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry);

for (const startingScope of ["Primary", "Personal space"]) {
  test(`successful community setup navigates from ${startingScope} Messages and restores both visits`, async ({
    page,
    app,
  }) => {
    await page.route("**/api/relay/secondary/info", (route) =>
      route.fulfill({ json: { name: "Secondary", policy: null } }),
    );
    await open(page, app);
    const rail = page.getByRole("navigation", { name: "Communities" });
    if (startingScope === "Personal space") {
      await selectCommunity(page, "Personal space");
      await expect(
        page.getByRole("heading", { name: "Your channels, one conversation." }),
      ).toBeVisible();
    }
    const before = await entry(page);
    await (await openCommunityPicker(page))
      .getByRole("button", { name: "Join a community", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Community URL", exact: true })
      .fill("wss://secondary.example");
    await button(page, "Continue").click();
    await expect(
      page.getByRole("heading", {
        name: "Your profile",
        exact: true,
      }),
    ).toBeVisible();
    await button(page, "Continue").click();
    await expect(
      rail.getByRole("button", { name: "Community switcher: Secondary" }),
    ).toBeVisible({ timeout: 1500 });
    const secondaryMessage = page.getByText("secondary alpha message 639", {
      exact: false,
    });
    await expect(secondaryMessage).toBeVisible();
    const joined = await entry(page);
    expect(joined.id).not.toBe(before.id);
    expect(joined.target.scope).toEqual({
      viewer: app.viewer,
      communityOrigin: "https://secondary.example",
    });

    await button(page, "Go back").click();
    await expect(
      rail.getByRole("button", {
        name: `Community switcher: ${startingScope}`,
      }),
    ).toBeVisible();
    expect(await entry(page)).toEqual(before);
    if (startingScope === "Primary")
      await expect(
        page.getByText("primary alpha message 639", { exact: false }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("heading", { name: "Your channels, one conversation." }),
      ).toBeVisible();
    await button(page, "Go forward").click();
    await expect(
      rail.getByRole("button", { name: "Community switcher: Secondary" }),
    ).toBeVisible();
    await expect(secondaryMessage).toBeVisible();
    expect(await entry(page)).toEqual(joined);
  });
}

test("Join a community is a visit: Go back closes it, Go forward reopens it with the typed address, Close retires it", async ({
  page,
  app,
}) => {
  await open(page, app);
  const before = await entry(page);
  const dialog = page.getByRole("dialog", { name: "Join a community" });
  await (await openCommunityPicker(page))
    .getByRole("button", { name: "Join a community", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  const joining = await entry(page);
  expect(joining.id).not.toBe(before.id);
  expect(joining.target).toEqual({
    ...before.target,
    join: { viewer: app.viewer, visit: expect.any(String) },
  });
  const field = dialog.getByRole("textbox", {
    name: "Community URL",
    exact: true,
  });
  await field.fill("wss://typed.example");

  // Real browser traversal: the dialog closes over the same visit beneath.
  await page.goBack();
  await expect(dialog).toBeHidden();
  expect(await entry(page)).toEqual(before);
  await expect(
    page.getByText("primary alpha message 639", { exact: false }),
  ).toBeVisible();
  await page.goForward();
  await expect(dialog).toBeVisible();
  expect(await entry(page)).toEqual(joining);
  // The running app keeps what was typed; it is not looked up by itself.
  await expect(field).toHaveValue("wss://typed.example");

  // Reload restores the dialog, but a draft lives in memory only.
  await page.reload();
  await expect(dialog).toBeVisible();
  expect(await entry(page)).toEqual(joining);
  await expect(field).toHaveValue("");

  // Close retires the visit: Go forward no longer reaches it.
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await entry(page)).toEqual(before);
  await expect(button(page, "Go forward")).toBeDisabled();
});
