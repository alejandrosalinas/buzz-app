import { openCommunityPicker, settleDialogMotion } from "./navigation.mjs";
import { test as base, expect } from "./fixture.mjs";

const test = base.extend({ federatedIdentity: true });
test.use({ historyCounts: { alpha: 0, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });

// The created community's address is the fixture's second relay, so the join
// that Create community opens runs against a real broker community.
test("creating a hosted community joins it and lists it in the picker", async ({
  page,
  app,
}, info) => {
  const shot = (name) => page.screenshot({ path: info.outputPath(name) });
  const { viewer } = await (
    await page.request.get(`${app.origin}/api/relay/identity`)
  ).json();
  // The fixture saves both communities; drop Secondary, the one to create.
  // Only on the first document, so the app's own saves survive a reload.
  await page.addInitScript((viewer) => {
    if (sessionStorage.getItem("test.seeded-primary-only")) return;
    sessionStorage.setItem("test.seeded-primary-only", "1");
    const key = `buzz-client.v1:${viewer}`;
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(
      key,
      JSON.stringify({
        ...saved,
        memberships: [{ id: "primary", name: "Primary" }],
        selected: "primary",
      }),
    );
  }, viewer);
  const created = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "secondary",
    normalized_host: "secondary.example",
  };
  let communities = [];
  let listStarted = false;
  const listReady = Promise.withResolvers();
  await page.route("**/api/builderlab/**", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (action === "auth")
      return route.fulfill({
        json: { auth: { email: "owner@example.com", expiresAt: "2030" } },
      });
    if (action === "identity")
      return route.fulfill({ json: { identity: { pubkey_hex: viewer } } });
    if (action === "list") {
      listStarted = true;
      await listReady.promise;
      return route.fulfill({
        json: {
          communities,
          quota_used: communities.length,
          quota_limit: 5,
          can_create: true,
        },
      });
    }
    if (action === "availability")
      return route.fulfill({ json: { available: true } });
    if (action === "create") {
      communities = [created];
      return route.fulfill({ json: { community: created } });
    }
    return route.fulfill({ status: 404, json: { error: "unexpected" } });
  });
  await page.route("**/api/relay/secondary/info", (route) =>
    route.fulfill({ json: { name: "Secondary", policy: null } }),
  );
  await page.goto(app.origin);

  const picker = await openCommunityPicker(page);
  await expect(
    picker.getByRole("button", { name: "Switch to Secondary", exact: true }),
  ).toHaveCount(0);
  await settleDialogMotion(picker);
  await shot("1-picker-before.png");
  const address = page.getByPlaceholder("north-star");
  const create = page.getByRole("dialog", {
    name: "Create community",
    exact: true,
  });
  try {
    await picker.getByRole("button", { name: "Create community" }).click();
    await expect.poll(() => listStarted).toBe(true);
    await expect(address).toBeDisabled();
    await settleDialogMotion(create);
  } finally {
    listReady.resolve();
  }
  await expect(address).toBeEnabled();
  await expect(address).toBeFocused();
  await button(page, "Cancel").click();
  await expect(create).toHaveCount(0);
  await page.goBack();
  const settings = page.getByRole("dialog", {
    name: "Settings",
    exact: true,
    includeHidden: true,
  });
  await expect(settings).toHaveCount(0);
  await page.goForward();
  await expect(settings).toBeVisible();
  // Include hidden controls so the readiness barrier works even if the bug
  // reopens Create and makes the parent Settings dialog inert.
  await expect(
    page
      .getByRole("button", {
        name: "Create community",
        exact: true,
        includeHidden: true,
      })
      .first(),
  ).toBeEnabled();
  await expect(create).toHaveCount(0);

  // A fresh picker visit still opens the form after the earlier dismissal.
  await button(page, "Close Settings").click();
  await expect(settings).toHaveCount(0);
  const again = await openCommunityPicker(page);
  await again.getByRole("button", { name: "Create community" }).click();
  await expect(address).toBeEnabled();
  await expect(address).toBeFocused();
  await address.fill("secondary");
  await expect(page.getByText("That address is available.")).toBeVisible();
  await shot("2-create-form.png");
  await button(page, "Create community").click();

  // No Community URL step: the join dialog connects to the new community by
  // itself and stops at the profile step. The fixture relay already holds this
  // viewer's profile, so the step offers Continue rather than Publish.
  const setup = page.getByRole("dialog", { name: "Your profile" });
  await expect(
    setup.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Fixture Reader");
  await expect(
    page.getByRole("textbox", { name: "Community URL", exact: true }),
  ).toHaveCount(0);
  await settleDialogMotion(setup);
  await shot("3-join-profile.png");

  // Reload restores the join over Settings, not the Create form it came from.
  await page.reload();
  const joining = page.getByRole("dialog", { name: "Join a community" });
  await expect(
    joining.getByRole("textbox", { name: "Community URL", exact: true }),
  ).toHaveValue("https://secondary.example");
  await expect(settings).toHaveCount(1);
  await expect(create).toHaveCount(0);
  // Back from the restored join reaches Settings, not the spent Create form.
  await page.goBack();
  await expect(joining).toHaveCount(0);
  await expect(settings).toBeVisible();
  // The card shows its overview, listing the new community, not the form.
  await expect(
    settings.getByText("secondary", { exact: true }).first(),
  ).toBeVisible();
  await expect(create).toHaveCount(0);
  await page.goForward();
  await joining.getByRole("button", { name: "Continue", exact: true }).click();
  const name = setup.getByRole("textbox", {
    name: "Display name",
    exact: true,
  });
  await expect(name).toHaveValue("Fixture Reader");

  // While the profile publishes, Escape cannot close Settings beneath the
  // join: a refusal must leave the join and its draft to retry.
  await name.fill("Fixture Owner");
  const publish = setup.getByRole("button", {
    name: "Publish profile & open",
    exact: true,
  });
  const published = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route("**/api/relay/secondary/profile", async (route) => {
    published.resolve();
    await release.promise;
    // The relay answers but does not accept the profile.
    await route.fulfill({
      json: { accepted: false, event_id: "", message: "Profile refused" },
    });
  });
  try {
    await publish.click();
    await published.promise;
    // Back is refused while the join writes, as its Close is.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          addEventListener("popstate", resolve, { once: true });
          history.back();
        }),
    );
    await expect(name).toHaveValue("Fixture Owner");
    await page.keyboard.press("Escape");
  } finally {
    release.resolve();
  }
  await expect(setup.getByText("Profile refused")).toBeVisible();
  await expect(name).toHaveValue("Fixture Owner");
  await expect(settings).toHaveCount(1);
  await page.unroute("**/api/relay/secondary/profile");
  await publish.click();
  await expect(setup).toHaveCount(0);

  await expect(
    page.getByRole("button", { name: "Community switcher: Secondary" }),
  ).toBeVisible();
  const after = await openCommunityPicker(page);
  await expect(
    after.getByRole("button", { name: "Switch to Secondary", exact: true }),
  ).toBeVisible();
  await settleDialogMotion(after);
  await shot("4-picker-after.png");
});
