import { setPluginEnabled } from "./plugin-settings.mjs";
import {
  closeSettings,
  openCommunityPicker,
  openSettings,
  selectSettingsSection,
  settingsDialog,
  settingsSections,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });

test("Settings opens over the retained workspace and closing restores the prior view", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Alpha").click();
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  const communityRail = page.getByRole("navigation", { name: "Communities" });
  await expect(communityRail).toBeVisible();
  const channels = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });

  await openSettings(page);
  const sections = settingsSections(page);
  await expect(sections).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1, exact: true }),
  ).toHaveCount(0);
  // The workspace stays mounted behind the modal but cannot be reached.
  for (const name of ["Sidebar", "Communities"]) {
    const role = name === "Communities" ? "navigation" : "complementary";
    await expect(page.getByRole(role, { name, exact: true })).toHaveCount(0);
    await expect(
      page.getByRole(role, { name, exact: true, includeHidden: true }),
    ).toHaveCount(1);
  }
  await expect(composer).toHaveCount(0);

  const notifications = sections.getByRole("button", {
    name: "Notifications",
    exact: true,
  });
  await notifications.click();
  await expect(notifications).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await closeSettings(page);
  await expect(composer).toBeVisible();
  await expect(channels).toBeVisible();
  await expect(communityRail).toBeVisible();
  await expect(button(page, "Your profile")).toBeFocused();
});

test("long Settings sections end with the dialog padding at every width", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Profile");
  const content = page.getByRole("region", { name: "Profile", exact: true });
  // Measure the gap between the section's end and the end of whichever pane
  // scrolls it: the detail beside the navigation, or the stacked layout.
  const endGap = () =>
    content.evaluate((section) => {
      let port = section.parentElement;
      while (
        !/auto|scroll/.test(getComputedStyle(port).overflowY) ||
        port.scrollHeight <= port.clientHeight
      )
        port = port.parentElement;
      port.scrollTop = port.scrollHeight;
      const padding = Number.parseFloat(
        getComputedStyle(section.closest(".buzz-dialog-navigation-detail"))
          .paddingBottom,
      );
      const gap =
        port.getBoundingClientRect().top +
        port.clientTop +
        port.clientHeight -
        section.getBoundingClientRect().bottom;
      return { padding, gap: Math.round(gap) };
    });
  await expect.poll(endGap).toEqual({ padding: 32, gap: 32 });
  await page.setViewportSize({ width: 480, height: 600 });
  await expect.poll(endGap).toEqual({ padding: 16, gap: 16 });
});

test("short narrow Settings keeps plugin copy and controls reachable at 200% interface size", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 320 });
  await page.addInitScript(() =>
    localStorage.setItem("buzz-font-scale.v1", "2"),
  );
  await page.goto(app.origin);
  await openSettings(page);
  // Settings has no drawer: the workspace toggle is behind the modal.
  const showNavigation = button(page, "Show navigation");
  await expect(showNavigation).toHaveCount(0);
  const sections = settingsSections(page);
  await sections
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  const content = page.getByRole("region", {
    name: "Manage plugins",
    exact: true,
  });
  const row = content.getByRole("article").filter({
    has: page.getByRole("button", { name: "View GitHub details", exact: true }),
  });
  const toggle = row.getByRole("button", {
    name: /^(Enable|Disable) GitHub$/,
  });
  const title = row.getByText("GitHub", { exact: true });
  const description = row.getByText(
    "View GitHub repositories, issues, and commits, and merge pull requests.",
    { exact: true },
  );
  await expect(toggle).toHaveAccessibleName("Disable GitHub");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("html")).toHaveCSS("--buzz-text-scale", "2");
  await title.scrollIntoViewIfNeeded();
  await expect(title).toBeInViewport({ ratio: 1 });
  await description.scrollIntoViewIfNeeded();
  await expect(description).toBeInViewport({ ratio: 1 });
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("settings-short-200-percent.png"),
  });
  await toggle.click();
  await expect(toggle).toHaveAccessibleName("Enable GitHub");
  await expect(toggle).toBeFocused();
  await expect(toggle).toBeEnabled();
  await toggle.press("Space");
  await expect(toggle).toHaveAccessibleName("Disable GitHub");
  // Re-enabling GitHub adds its settings card to the stacked navigation above,
  // which pushes the toggle down.
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeInViewport({ ratio: 1 });
  // Narrow Settings stacks its own navigation above the detail, reachable by
  // scrolling the modal; wide Settings keeps it beside the detail.
  const detail = settingsDialog(page).locator(".buzz-dialog-navigation-detail");
  const stacked = async () => {
    const navigation = await sections.boundingBox();
    const content = await detail.boundingBox();
    return navigation.y + navigation.height <= content.y;
  };
  await expect.poll(stacked).toBe(true);
  const profile = sections.getByRole("button", {
    name: "Profile",
    exact: true,
  });
  await profile.scrollIntoViewIfNeeded();
  await expect(profile).toBeInViewport({ ratio: 1 });
  await profile.click();
  await expect(profile).toHaveAttribute("aria-current", "page");
  // Choosing from the stacked navigation hands focus to the detail it opened.
  await expect(detail).toBeFocused();
  await expect(
    page.getByRole("region", { name: "Profile", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(stacked).toBe(false);
  await expect(sections).toBeInViewport();
  await page.setViewportSize({ width: 480, height: 400 });
  await expect.poll(stacked).toBe(true);
  await closeSettings(page);
  await expect(
    page.getByRole("region", { name: "Channels", exact: true }),
  ).toBeVisible();
  const channelsSidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  await expect(channelsSidebar).toBeHidden();
  await showNavigation.click();
  await expect(channelsSidebar).toBeVisible();
});

for (const action of ["Remove from this device", "Leave community"]) {
  test(`${action} hands keyboard focus to Personal Profile`, async ({
    page,
    app,
  }) => {
    const leaveRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/leave"))
        leaveRequests.push(request.url());
    });
    if (action === "Leave community")
      await page.route("**/api/relay/*/leave", (route) =>
        route.fulfill({ json: { accepted: true, event_id: "f".repeat(64) } }),
      );
    await page.goto(app.origin);
    await openSettings(page);
    await settingsSections(page)
      .getByRole("button", { name: "Leave or remove", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Leave or remove", exact: true }),
    ).toBeVisible();
    const trigger = page.getByRole("button", { name: action, exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    let dialog = page.getByRole("alertdialog");
    // Cancel must still restore the exact trigger rather than focus Profile.
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    dialog = page.getByRole("alertdialog", {
      name:
        action === "Leave community"
          ? "Leave Primary?"
          : "Remove Primary from this device?",
    });
    if (action === "Remove from this device")
      await expect(dialog).toContainText(
        "The community connection and any saved drafts or data will be removed from Buzz on this device.",
      );
    await dialog.getByRole("button", { name: action, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText(
        action === "Leave community"
          ? "Left Primary — https://primary.example."
          : "Primary — https://primary.example was removed from this device. Your membership wasn’t changed. You can add it again later.",
        { exact: true },
      ),
    ).toBeVisible();
    // The community switcher is behind the Settings modal, which stays open.
    await expect(
      page.getByRole("button", {
        name: "Community switcher: Personal space",
        exact: true,
        includeHidden: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Profile", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#settings-content")).toBeFocused();
    await expect(page.locator('.page-status[role="alert"]')).toHaveCount(0);
    expect(leaveRequests).toHaveLength(action === "Leave community" ? 1 : 0);
  });
}

test.describe("community administration permissions", () => {
  test("shows Membership to a verified owner", async ({ page, app }) => {
    let rosterGate;
    let rosterStarted = () => {};
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (filters.some((filter) => filter.kinds?.includes(13534))) {
        rosterStarted();
        await rosterGate;
        return route.fulfill({ json: [app.membershipSnapshot("owner")] });
      }
      return route.continue();
    });
    await page.goto(app.origin);
    await openSettings(page);
    const sections = settingsSections(page);
    // The account menu finishes its focus handoff before testing section focus.
    await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
    await selectSettingsSection(page, "Manage plugins");
    await setPluginEnabled(page, "Membership", true);
    await expect(sections).toContainText("Community admin");
    const membership = sections.getByRole("button", {
      name: "Membership",
      exact: true,
    });
    await membership.focus();
    await membership.press("Enter");
    await expect(membership).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "Membership", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Invite members" }).click();
    const dialog = page.getByRole("dialog", { name: "Add or invite people" });
    await expect(
      dialog.getByRole("heading", { name: "Add directly" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Invite with a link" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("textbox", { name: "Public identity" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("combobox", { name: /Search people/ }),
    ).toHaveCount(0);

    // Keep browser history/reload, real roster verification, and host wiring real.
    // A held response proves this route cannot fall through to Profile or failure.
    await page.keyboard.press("Escape");
    let releaseRoster;
    rosterGate = new Promise((resolve) => {
      releaseRoster = resolve;
    });
    const started = new Promise((resolve) => {
      rosterStarted = resolve;
    });
    try {
      await page.reload();
      await started;
      await expect(page.locator(".page-status").getByRole("status")).toHaveText(
        "Loading…",
      );
      await expect(page.locator('.page-status[role="alert"]')).toHaveCount(0);
      await expect(
        sections.getByRole("button", { name: "Membership", exact: true }),
      ).toHaveCount(0);
    } finally {
      releaseRoster();
    }
    await expect(
      page.getByRole("heading", { name: "Membership", exact: true }),
    ).toBeVisible();
  });
});

// The Builderlab section applies only in FI builds. With no native host its
// session stays signed out, and hosted communities use the fixture broker.
const fiBuild = test.extend({ federatedIdentity: true });

// Only this journey requires a confirmed Online badge/radio. Keep unrelated
// Settings fixtures on their existing synthetic broker.
const confirmedPresence = fiBuild.extend({ productionBroker: true });
confirmedPresence(
  "avatar Settings access dismisses cleanly and exposes Profile and Plugins",
  async ({ page, app, browserName }, testInfo) => {
    // macOS WebKit follows the system's text-fields-only Tab preference. Option+Tab
    // includes native buttons; exercise real key traversal, not programmatic focus.
    const tab = (backwards = false) =>
      page.keyboard.press(
        `${browserName === "webkit" && process.platform === "darwin" ? "Alt+" : ""}${backwards ? "Shift+" : ""}Tab`,
      );
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (filters.some((filter) => filter.kinds?.includes(13534)))
        return route.fulfill({ json: [app.membershipSnapshot("member")] });
      return route.continue();
    });
    await page.goto(app.origin);
    const avatar = button(page, "Your profile");
    const account = page.getByRole("menu", {
      name: "Fixture Reader",
    });
    const settings = account.getByRole("menuitem", {
      name: "Settings",
      exact: true,
    });
    const viewProfile = account.getByRole("menuitem", {
      name: "Fixture Reader, edit profile",
      exact: true,
    });
    const statusEntry = account.getByRole("menuitem", {
      name: "Set a status",
      exact: true,
    });
    const feedback = account.getByRole("menuitem", {
      name: "Send feedback",
      exact: true,
    });
    const availability = account.getByRole("button", {
      name: "Availability: Online",
    });
    await expect(avatar).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("menuitem", { name: "Settings", exact: true }),
    ).toHaveCount(0);
    await expect(avatar.locator(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      "online",
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await avatar.click();
      await expect(account).toBeInViewport();
      await expect(avatar).toHaveAttribute("aria-expanded", "true");
      await expect(availability).toBeFocused();
      await availability.press("Enter");
      await expect(
        page.getByRole("menuitemradio", { name: "Online", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitemradio", { name: "Away", exact: true }),
      ).toBeFocused();
      await expect(
        page.getByRole("menuitemradio", { name: "Automatic", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("menuitemradio", { name: "Online", exact: true }),
      ).toBeChecked();
      await page.keyboard.press("Escape");
      await expect(availability).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(account).toBeHidden();
      await expect(avatar).toBeFocused();
      await avatar.click();
      await avatar.click();
      await expect(account).toBeHidden();
      await avatar.click();
      // The dock account popup opens beside the bottom controls.
      // Click exposed content above it to exercise outside dismissal.
      const main = page.getByRole("main");
      const bounds = await main.boundingBox();
      await main.click({
        position: { x: bounds.width / 2, y: bounds.height / 3 },
      });
      await expect(account).toBeHidden();
      await avatar.focus();
      await page.keyboard.press("Enter");
      await expect(viewProfile).toBeFocused();
      await page.keyboard.press("End");
      await expect(feedback).toBeFocused();
      await page.keyboard.press("Home");
      await expect(viewProfile).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(statusEntry).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        account.getByRole("menuitem", { name: "Appearance", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        account.getByRole("menuitem", { name: "Plugins", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(settings).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(feedback).toBeFocused();
      await page.keyboard.press("Home");
      await expect(viewProfile).toBeFocused();
      await tab(true);
      await expect(account).toBeHidden();
      await expect(avatar).toBeFocused();
      await tab(true);
      await expect(
        page.getByRole("button", { name: /^Community switcher:/ }),
      ).toBeFocused();
      await tab(true);
      await expect(
        page
          .getByRole("navigation", { name: "Apps dock" })
          .getByRole("tab")
          .and(page.locator('[tabindex="0"]')),
      ).toBeFocused();
      await tab(true);
      await expect(button(page, "Search Buzz")).toBeFocused();
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    await avatar.focus();
    await page.keyboard.press("Enter");
    await expect(viewProfile).toBeFocused();
    await settings.focus();
    await expect(settings).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(account).toBeHidden();
    await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
    const sections = settingsSections(page);
    await expect(sections).toBeVisible();
    const detail = settingsDialog(page).locator(
      ".buzz-dialog-navigation-detail",
    );
    const profile = sections.getByRole("button", {
      name: "Profile",
      exact: true,
    });
    const channelTemplates = sections.getByRole("button", {
      name: "Channel templates",
      exact: true,
    });
    const plugins = sections.getByRole("button", {
      name: "Manage plugins",
      exact: true,
    });
    const profileContent = page.getByRole("region", {
      name: "Profile",
      exact: true,
    });
    const pluginContent = page.getByRole("region", {
      name: "Manage plugins",
      exact: true,
    });
    await expect(profile).toHaveAttribute("aria-current", "page");
    await expect(profileContent).toBeVisible();
    await expect(pluginContent).toHaveCount(0);
    await channelTemplates.click();
    await expect(channelTemplates).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: "Channel templates", exact: true }),
    ).toBeVisible();
    await profile.click();
    // Exercise the real shell's destination allowlist, not just the settings component.
    const providers = sections.getByRole("button", {
      name: "Agent setup",
      exact: true,
    });
    await providers.click();
    await expect(providers).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("region", { name: "Agent setup", exact: true }),
    ).toBeVisible();
    const remember = page.getByRole("switch", {
      name: "Remember mentioned agents",
    });
    await expect(remember).toBeChecked();
    await remember.click();
    await expect(remember).not.toBeChecked();
    await profile.click();
    await providers.click();
    await expect(remember).not.toBeChecked();
    const appearance = sections.getByRole("button", {
      name: "Appearance",
      exact: true,
    });
    await appearance.click();
    await expect(remember).toHaveCount(0);
    const placement = page.getByRole("combobox", {
      name: "Open threads in",
      exact: true,
    });
    await placement.click();
    await page.getByRole("option", { name: "Main pane", exact: true }).click();
    await expect(placement).toHaveText("Main pane");
    await profile.click();
    await appearance.click();
    await expect(placement).toHaveText("Main pane");
    await profile.click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      // Settings keeps its own navigation at every width; narrow modals stack it.
      await expect(sections).toBeVisible();
      await profile.focus();
      for (const name of [
        "Local settings",
        "Custom emoji",
        "Pair mobile",
        "Leave or remove",
        "Identity",
        "Appearance",
      ]) {
        await tab();
        await expect(
          sections.getByRole("button", { name, exact: true }),
        ).toBeFocused();
      }
      await plugins.focus();
      await page.keyboard.press("Enter");
      await expect(plugins).toHaveAttribute("aria-current", "page");
      await expect(profile).not.toHaveAttribute("aria-current");
      if (width === 1280) await expect(plugins).toBeFocused();
      else await expect(detail).toBeFocused();
      await expect(profileContent).toHaveCount(0);
      await expect(pluginContent).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Enable Workflows", exact: true }),
      ).toBeVisible();
      const dialog = settingsDialog(page);
      await expect(dialog).toHaveCSS("background-color", "rgb(255, 255, 255)");
      const frame = await dialog.boundingBox();
      expect(frame.height).toBeGreaterThan(700);
      const navigation = await sections.boundingBox();
      const scrollport = await detail.boundingBox();
      expect(navigation).not.toBeNull();
      expect(scrollport).not.toBeNull();
      if (width === 1280) {
        const content = await pluginContent.boundingBox();
        expect(content).not.toBeNull();
        expect(navigation.x + navigation.width).toBeLessThan(content.x);
        // Keyboard focus can scroll this pane; measure its layout inset in
        // scroll-content coordinates rather than assuming scrollTop is zero.
        await expect
          .poll(() =>
            pluginContent.evaluate((element) => {
              const pane = element.closest(".buzz-dialog-navigation-detail");
              return (
                element.getBoundingClientRect().top -
                pane.getBoundingClientRect().top +
                pane.scrollTop
              );
            }),
          )
          .toBe(32);
      } else {
        // Narrow Settings stacks its navigation above the detail.
        expect(navigation.y + navigation.height).toBeLessThanOrEqual(
          scrollport.y,
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
      }
      await page.screenshot({
        path: testInfo.outputPath(`settings-${width}.png`),
      });
      await profile.focus();
      await expect(profile).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(profile).toHaveAttribute("aria-current", "page");
      await expect(profileContent).toBeVisible();
      await expect(pluginContent).toHaveCount(0);
      if (width === 390) {
        await expect(detail).toBeFocused();
        await profile.focus();
      }
      for (const name of [
        "Local settings",
        "Custom emoji",
        "Pair mobile",
        "Leave or remove",
        "Identity",
        "Appearance",
        "Notifications",
        "Shortcuts",
        "Agent setup",
        "Decisions API",
        "Channel templates",
        "Software updates",
        "Manage plugins",
        "Builderlab",
        "GitHub",
      ]) {
        await tab();
        await expect(
          sections.getByRole("button", { name, exact: true }),
        ).toBeFocused();
      }
      await tab();
      // The current profile form begins with its avatar editor before text fields.
      await expect(
        page.getByRole("button", { name: "Edit avatar", exact: true }),
      ).toBeFocused();
    }
  },
);

/** A viewer with no saved community starts on the join screen, not the shell. */
const savedCommunity = (page, viewer) =>
  page.addInitScript((viewer) => {
    const key = `buzz-client.v1:${viewer}`;
    if (!localStorage.getItem(key))
      localStorage.setItem(
        key,
        JSON.stringify({
          profile: { name: "Browser Fixture", picture: "" },
          memberships: [{ id: "primary", name: "Primary" }],
          selected: null,
        }),
      );
  }, viewer);

fiBuild(
  "hosted deletion reload keeps the UUID until an enabled manual replay",
  async ({ page, app }) => {
    const owner = "a".repeat(64);
    const request = {
      community_id: "11111111-1111-4111-8111-111111111111",
      host: "North.communities.buzz.xyz",
      request_id: "22222222-2222-4222-8222-222222222222",
      acknowledgement_version: 1,
    };
    const calls = [];
    const deletionBodies = [];
    let canDelete = false;
    await page.route("**/api/relay/identity", (route) =>
      route.fulfill({ json: { viewer: owner } }),
    );
    await savedCommunity(page, owner);
    await page.route("**/api/builderlab/**", async (route) => {
      const action = new URL(route.request().url()).pathname.split("/").at(-1);
      calls.push(action);
      if (action === "auth")
        return route.fulfill({
          json: {
            auth: {
              email: "owner@example.com",
              expiresAt: "2030",
              capabilities: { can_delete_buzz_communities: canDelete },
            },
          },
        });
      if (action === "identity")
        return route.fulfill({ json: { identity: { pubkey_hex: owner } } });
      if (action === "list")
        return route.fulfill({
          json: {
            communities: [],
            quota_used: 1,
            quota_limit: 5,
            can_create: false,
          },
        });
      if (action === "delete") {
        deletionBodies.push(route.request().postDataJSON());
        return route.fulfill({
          status: 202,
          json: { ...request, status: "submitted" },
        });
      }
      return route.fulfill({ status: 404, json: { error: "unexpected" } });
    });

    // Boot with the saved deletion rather than reloading over a booting app,
    // which WebKit can fail with an internal error. Seed only the first
    // document, so the reload below sees just what the app kept.
    await page.addInitScript(
      ({ owner, request }) => {
        if (sessionStorage.getItem("test.seeded-deletion")) return;
        sessionStorage.setItem("test.seeded-deletion", "1");
        localStorage.setItem(
          "buzz.hosted-community-deletion.v1",
          JSON.stringify({
            version: 1,
            owner_pubkey: owner,
            backend_origin: window.location.origin,
            request,
          }),
        );
      },
      { owner, request },
    );
    await page.goto(app.origin);
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await button(page, "Builderlab").click();
    await expect(
      page.getByText("Deletion status is unknown", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(request.request_id, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/will not check automatically/i)).toBeVisible();
    expect(calls.filter((action) => action === "delete")).toHaveLength(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("buzz.hosted-community-deletion.v1"),
      ),
    ).not.toBeNull();
    await expect(button(page, "Check deletion status")).toBeDisabled();
    canDelete = true;
    // Reload restores the open Settings modal over its workspace.
    await page.reload();
    await expect(settingsDialog(page)).toBeVisible();
    await button(page, "Builderlab").click();
    await expect(button(page, "Check deletion status")).toBeEnabled();
    await button(page, "Check deletion status").click();
    await expect(
      page.getByText("Deletion started", { exact: true }),
    ).toBeVisible();
    expect(calls.filter((action) => action === "delete")).toHaveLength(1);
    expect(deletionBodies).toEqual([request]);
    await expect(button(page, "Delete")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("buzz.hosted-community-deletion.v1"),
      ),
    ).toBeNull();
  },
);

fiBuild(
  "hosted deletion keeps a foreign owner's full npub inside the dialog and notice",
  async ({ page, app }) => {
    const owner = "a".repeat(64);
    const community = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "north",
      normalized_host: "North.communities.buzz.xyz",
      archived_at: "2026-09-24",
    };
    const deletes = [];
    await page.route("**/api/relay/identity", (route) =>
      route.fulfill({ json: { viewer: owner } }),
    );
    await savedCommunity(page, owner);
    await page.route("**/api/builderlab/**", async (route) => {
      const action = new URL(route.request().url()).pathname.split("/").at(-1);
      if (action === "auth")
        return route.fulfill({
          json: {
            auth: {
              email: "owner@example.com",
              expiresAt: "2030",
              capabilities: { can_delete_buzz_communities: true },
            },
          },
        });
      if (action === "identity")
        return route.fulfill({ json: { identity: { pubkey_hex: owner } } });
      if (action === "list")
        return route.fulfill({
          json: {
            communities: [community],
            quota_used: 1,
            quota_limit: 5,
            can_create: true,
          },
        });
      if (action === "delete") deletes.push(route.request().postDataJSON());
      return route.fulfill({ status: 404, json: { error: "unexpected" } });
    });
    const contained = (locator) =>
      locator.evaluate((node) => node.scrollWidth <= node.clientWidth);

    await page.goto(app.origin);
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await button(page, "Builderlab").click();
    await button(page, "Delete").click();
    const dialog = page.getByRole("dialog", {
      name: /Permanently delete north/,
    });
    await dialog
      .getByLabel("Type the exact host")
      .fill(community.normalized_host);
    await dialog
      .getByRole("checkbox", { name: /I understand this cannot be canceled/ })
      .check();
    // Another tab claims the slot while this dialog is open.
    await page.evaluate(
      (community) =>
        localStorage.setItem(
          "buzz.hosted-community-deletion.v1",
          JSON.stringify({
            version: 1,
            owner_pubkey: "b".repeat(64),
            backend_origin: window.location.origin,
            request: {
              community_id: community.id,
              host: community.normalized_host,
              request_id: "33333333-3333-4333-8333-333333333333",
              acknowledgement_version: 1,
            },
          }),
        ),
      community,
    );
    await dialog.getByRole("button", { name: "Start deletion" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("is already pending on this device");
    expect(await contained(dialog)).toBe(true);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // The global paragraph rule already wraps this notice; this guards regressions.
    const notice = page
      .getByRole("status")
      .filter({ hasText: "is still pending" });
    await expect(notice).toBeVisible();
    expect(await contained(notice)).toBe(true);
    expect(deletes).toHaveLength(0);
  },
);

test("Settings loads and publishes the selected community profile", async ({
  page,
  app,
  browserName,
}) => {
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const writes = [];
  const profiles = [];
  let releaseProfile;
  await page.route("**/api/relay/primary/profile", async (route) => {
    const response = await new Promise((resolve) => {
      releaseProfile = resolve;
    });
    releaseProfile = undefined;
    if (response) await route.fulfill(response);
    else await route.continue();
  });
  page.on("request", (request) => {
    if (/\/api\/relay\/.*\/(profile|sign|publish)$/.test(request.url())) {
      writes.push(request.url());
      if (request.url().endsWith("/profile"))
        profiles.push(request.postDataJSON());
    }
  });
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("menu", { name: "Browser Fixture" }),
  ).toBeHidden();
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
  const profileRegion = () =>
    page.getByRole("region", { name: "Profile", exact: true });
  const displayName = () =>
    profileRegion().getByRole("textbox", { name: "Display name", exact: true });
  const name = displayName();
  const save = () =>
    profileRegion().getByRole("button", { name: "Save", exact: true });
  await expect(name).toHaveValue("Fixture Reader");
  // Profile edits inline: Settings itself is the only open dialog.
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(settingsDialog(page)).toBeVisible();
  await expect(button(page, "Edit profile")).toHaveCount(0);
  await name.fill("Do not save");
  await expect(name).toHaveValue("Do not save");
  await button(page, "Manage plugins").click();
  await expect(name).toBeHidden();
  await button(page, "Profile").click();
  await expect(name).toHaveValue("Do not save");
  await button(page, "Cancel").press("Enter");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Fixture Reader");
  await name.fill("Discard when leaving Settings");
  await settingsDialog(page)
    .getByRole("button", { name: "Close Settings", exact: true })
    .click();
  // Unsaved profile edits ask before Settings closes.
  await page
    .getByRole("alertdialog", { name: "Discard changes?" })
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("menu", { name: "Browser Fixture" }),
  ).toBeHidden();
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
  const reopenedName = displayName();
  await expect(reopenedName).toHaveValue("Fixture Reader");
  await reopenedName.fill("   ");
  await expect(save()).toBeDisabled();
  await reopenedName.fill("Updated community profile");
  await profileRegion().getByRole("button", { name: "Edit avatar" }).click();
  const avatarEditor = page.getByRole("dialog", { name: "Edit avatar" });
  const picture = avatarEditor.getByRole("textbox", {
    name: "Picture URL (optional)",
    exact: true,
  });
  await picture.fill("http://example.com/avatar.png");
  // Done reveals the URL error instead of applying it.
  await avatarEditor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(picture).toHaveAccessibleDescription(/Use an HTTPS image URL/);
  await expect(avatarEditor).toBeVisible();
  await picture.fill("");
  await avatarEditor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(avatarEditor).toBeHidden();
  await expect(
    profileRegion().getByRole("button", { name: "Edit avatar", exact: true }),
  ).toBeFocused();
  await expect(save()).toBeEnabled();
  await reopenedName.fill("  Updated community profile  ");
  await save().press("Enter");
  try {
    await expect.poll(() => profiles.length).toBe(1);
    await expect.poll(() => typeof releaseProfile).toBe("function");
    await expect(save()).toHaveAttribute("aria-busy", "true");
    await expect(save()).toBeFocused();
    await expect(reopenedName).toBeDisabled();
    await expect(button(page, "Cancel")).toBeDisabled();
    await page.keyboard.press("Enter");
  } finally {
    releaseProfile?.({
      json: { accepted: false, message: "Publication unavailable" },
    });
  }
  await expect(page.getByRole("alert")).toContainText(
    "Publication unavailable",
  );
  await expect(save()).toBeFocused();
  await expect(save()).toBeEnabled();
  await page.keyboard.press("Enter");
  try {
    await expect.poll(() => profiles.length).toBe(2);
    await expect.poll(() => typeof releaseProfile).toBe("function");
    await expect(save()).toHaveAttribute("aria-busy", "true");
    await expect(save()).toBeFocused();
  } finally {
    releaseProfile?.();
  }
  await expect(reopenedName).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    profileRegion().getByRole("textbox", {
      name: "Profile description (optional)",
    }),
  ).toBeFocused();
  await expect(save()).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Profile updated" }),
  ).toBeVisible();
  await expect(reopenedName).toHaveValue("Updated community profile");
  // The account avatar is behind the modal; check it from the workspace. The
  // pointer left on Close can briefly open a tooltip for the control beneath it.
  await closeSettings(page);
  await button(page, "Your profile").hover();
  await expect(
    page.getByRole("tooltip", {
      name: "Updated community profile",
      exact: true,
    }),
  ).toBeVisible();
  await expect(button(page, "Your profile")).toHaveAccessibleDescription(
    "Updated community profile",
  );
  await openSettings(page);
  await expect(reopenedName).toHaveValue("Updated community profile");
  await reopenedName.fill("Discard after saving");
  await button(page, "Cancel").press("Enter");
  await expect(reopenedName).toBeFocused();
  await expect(reopenedName).toHaveValue("Updated community profile");
  // Reload restores the open Settings modal.
  await page.reload();
  await expect(settingsDialog(page)).toBeVisible();
  // The fixture updates its signed relay profile on publication; reopening proves
  // Settings re-reads that confirmed community state rather than retaining a draft.
  await expect(displayName()).toHaveValue("Updated community profile");
  await closeSettings(page);
  await button(page, "Your profile").hover();
  await expect(
    page.getByRole("tooltip", {
      name: "Updated community profile",
      exact: true,
    }),
  ).toBeVisible();
  expect(writes.filter((url) => url.endsWith("/profile"))).toHaveLength(2);
  expect(profiles).toHaveLength(2);
  for (const profile of profiles)
    expect(profile).toEqual(
      expect.objectContaining({
        name: "Updated community profile",
        picture: "",
        existing: expect.objectContaining({ name: "Fixture Reader" }),
      }),
    );
});

test("discarding community setup leaves the published profile unchanged", async ({
  page,
  app,
}) => {
  const writes = [];
  page.on("request", (request) => {
    if (/\/api\/relay\/.*\/(profile|sign|publish)$/.test(request.url()))
      writes.push(request.url());
  });
  await page.route("**/api/relay/primary/info", (route) =>
    route.fulfill({ json: { name: "Primary", policy: null } }),
  );
  await page.route("https://example.com/avatar.png", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    }),
  );
  await page.goto(app.origin);
  await (await openCommunityPicker(page))
    .getByRole("button", { name: "Join a community", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Community URL", exact: true })
    .fill("wss://primary.example");
  await button(page, "Continue").click();
  await expect(
    page.getByRole("heading", { name: "Your profile", exact: true }),
  ).toBeVisible();
  const setup = page.getByRole("dialog").filter({
    has: page.getByRole("heading", {
      name: "Your profile",
      exact: true,
    }),
  });
  const name = setup.getByRole("textbox", {
    name: "Display name",
    exact: true,
  });
  await expect(name).toHaveValue("Fixture Reader");
  await expect(button(page, "Continue")).toBeEnabled();
  await name.fill("Community-only draft");
  await setup.getByRole("button", { name: "Edit avatar" }).click();
  const avatarEditor = page.getByRole("dialog", { name: "Edit avatar" });
  const picture = avatarEditor.getByRole("textbox", {
    name: "Picture URL (optional)",
    exact: true,
  });
  await picture.fill("http://example.com/avatar.png");
  // Done reveals the URL error instead of applying it.
  await avatarEditor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(picture).toHaveAccessibleDescription(/Use an HTTPS image URL/);
  await expect(avatarEditor).toBeVisible();
  await picture.fill("https://example.com/avatar.png");
  await avatarEditor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(button(page, "Publish profile & open")).toBeEnabled();
  await button(page, "Close").click();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settingsProfile = page.getByRole("region", {
    name: "Profile",
    exact: true,
  });
  await expect(
    settingsProfile.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Fixture Reader");
  await settingsProfile.getByRole("button", { name: "Edit avatar" }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit avatar" }).getByRole("textbox", {
      name: "Picture URL (optional)",
      exact: true,
    }),
  ).toHaveValue("");
  expect(writes).toEqual([]);
});

// Browser-only: container-query hiding must remove covered controls from native Tab navigation.
test("narrow plugin details moves focus, skips covered rows, and restores the trigger on Escape", async ({
  page,
  app,
}, info) => {
  await page.setViewportSize({ width: 480, height: 650 });
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    const trigger = button(page, "View GitHub details");
    await trigger.focus();
    await page.keyboard.press("Enter");
    const pane = page.getByRole("complementary", { name: "GitHub details" });
    await expect(
      pane.getByRole("button", { name: "Close plugin details" }),
    ).toBeFocused();
    await expect(trigger).toBeHidden();
    // The covered catalog is hidden from AT; its live feedback must stay exposed.
    await expect(page.getByRole("alert")).toHaveCSS("visibility", "visible");
    await page.keyboard.press("Tab");
    await expect(
      pane.getByRole("button", { name: "Disable", exact: true }),
    ).toBeFocused();
    await pane.evaluate((element) =>
      Promise.allSettled(
        element
          .getAnimations({ subtree: true })
          .filter(
            (animation) =>
              animation.effect?.getComputedTiming().endTime !== Infinity,
          )
          .map((animation) => animation.finished),
      ),
    );
    await pane.screenshot({
      path: info.outputPath(`plugin-details-${mode}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toBeVisible();
  }
});

// Browser-only: the inspector narrows the catalog beside it, which reflows the
// rows above. The chosen row must stay where it was in the catalog's real
// scrollport on open and close; browser scroll anchoring alone can move it.
test("plugin details preserves the catalog scroll position on open and close", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  const trigger = button(page, "View Usage details");
  await trigger.scrollIntoViewIfNeeded();
  const place = () =>
    trigger.evaluate((row) => {
      const port = row.closest(".buzz-settings-page");
      const offset =
        row.getBoundingClientRect().top - port.getBoundingClientRect().top;
      return { scrolled: port.scrollTop > 0, offset: Math.round(offset) };
    });
  const before = await place();
  expect(before.scrolled).toBe(true);
  await trigger.click();
  const close = button(page, "Close plugin details");
  await expect(close).toBeFocused();
  await expect.poll(place).toEqual(before);
  await close.click();
  await expect(trigger).toBeFocused();
  await expect.poll(place).toEqual(before);
  await expect(button(page, "More actions for Usage")).toHaveCount(0);
});

// Real shell + shared presentation + browser storage across reload. State/error
// permutations stay in the communities and Local settings component tests.
test("Local settings saves a device name without changing the community identity", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/*/icon-info", (route) =>
    route.fulfill({
      json: {
        name: route.request().url().includes("primary")
          ? "Published community"
          : "Buzz Relay",
      },
    }),
  );
  await page.goto(app.origin);
  await expect(
    button(page, "Community switcher: Published community"),
  ).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Local settings");
  const region = page.getByRole("region", {
    name: "Local settings",
    exact: true,
  });
  const name = region.getByLabel("Display name", {
    exact: true,
  });
  await expect(name).toHaveValue("");
  await expect(name).toHaveAttribute("placeholder", "Published community");
  await expect(
    region.getByLabel("Community address", { exact: true }),
  ).toHaveValue("https://primary.example");
  await name.fill("My work");
  await name.press("Enter");
  await expect(region.getByRole("status")).toHaveText(
    "Display name saved on this device.",
  );
  await closeSettings(page);
  await expect(button(page, "Community switcher: My work")).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Local settings");
  await page.reload();
  await expect(name).toHaveValue("My work");
  await selectSettingsSection(page, "Leave or remove");
  await button(page, "Leave community").click();
  const confirm = page.getByRole("alertdialog", {
    name: "Leave Published community?",
    exact: true,
  });
  await expect(
    confirm.getByText("Shown as My work on this device", { exact: true }),
  ).toBeVisible();
  await expect(
    confirm.getByText("https://primary.example", { exact: true }),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await selectSettingsSection(page, "Local settings");
  await region.getByRole("button", { name: "Reset name", exact: true }).click();
  await expect(name).toHaveValue("");
  await closeSettings(page);
  await expect(
    button(page, "Community switcher: Published community"),
  ).toBeVisible();
});

// Native popstate cannot be covered by the controller's memory-driver test.
test("native Back warns before discarding Profile edits and Keep editing retains the draft", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Alpha").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Profile");
  const name = page
    .getByRole("region", { name: "Profile", exact: true })
    .getByRole("textbox", { name: "Display name", exact: true });
  await expect(name).toHaveValue("Fixture Reader");
  await name.fill("Keep this draft");
  // Skip the section-only stops to leave Settings, as a native multi-step Back does.
  await page.evaluate(() => history.go(-2));
  const warning = page.getByRole("alertdialog", {
    name: "Discard changes?",
    exact: true,
  });
  await expect(warning).toBeVisible();
  await warning
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(name).toHaveValue("Keep this draft");
  await page.evaluate(() => history.go(-2));
  await expect(warning).toBeVisible();
  await warning
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await page.goForward();
  await expect(settingsDialog(page)).toBeVisible();
  await selectSettingsSection(page, "Profile");
  await expect(name).toHaveValue("Fixture Reader");
});
