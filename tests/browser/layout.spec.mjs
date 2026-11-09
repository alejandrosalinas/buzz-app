import { pluginAction } from "./plugin-settings.mjs";
import { selectCommunity, openCommunityPicker } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";
import {
  closeSettings,
  openPage,
  openSettings,
  pageChoices,
  pageChoice,
  selectSettingsSection,
  settingsDialog,
  settingsSections,
  settleDialogMotion,
  settleShellToggle,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

import { finalizeEvent, generateSecretKey } from "nostr-tools";
import {
  wheel,
  anchor,
  frames,
  settle,
  upper,
  expectAnchor,
  keyScroll,
} from "./timeline.mjs";

// These layout/navigation journeys exercise opt-in page surfaces.
test.use({
  enabledPlugins: ["buzz.bestie", "buzz.workflows", "buzz.drafts-and-sent"],
});

const scroll = test.extend({ historyCounts: { alpha: 20, beta: 1 } });
const companionTest = test.extend({ companionFixture: true });
// Resize tests must not enter the fixture’s deliberately held paging path.
const readingTest = test.extend({
  tallMessages: true,
  // Keep the old restored row visible when wheel input selects another row.
  historyCounts: { alpha: 24, beta: 1 },
});
async function expectNonPaging(page, app) {
  expect(
    await page
      .getByRole("region", { name: "Channel message history" })
      .evaluate((el) => el.scrollTop - Math.max(3000, el.clientHeight * 4)),
    "resize reading position stays outside older-page prefetch",
  ).toBeGreaterThan(0);
  expect(
    app.report.queries.filter(({ filter }) => filter.until !== undefined),
  ).toHaveLength(0);
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
const companionLauncher = (page, name) =>
  button(page, name).and(page.locator("button[aria-expanded]"));
// Global destinations live in the dock independently of the Messages sidebar.
const destinationTitles = ["Bestie", "Activity"];
const dockDestinations = (page, options = {}) =>
  page
    .getByRole("navigation", { name: "Apps dock", ...options })
    .getByRole("tab", { name: /^(Bestie|Activity)$/, ...options });
const companionReadingTest = readingTest.extend({ companionFixture: true });
const box = async (locator) => {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds;
};
const near = (a, b) => expect(Math.abs(a - b)).toBeLessThan(2);
// Read the shared spacing decision independently of measured panel geometry.
const panelGap = (page) =>
  page
    .locator(".shell-content")
    .evaluate(
      (element) =>
        Number.parseFloat(
          getComputedStyle(element).getPropertyValue("--space-panel-gap"),
        ) *
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
const panel = (page) =>
  page.getByRole("complementary", { name: "GitHub", exact: true });

async function open(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
}
// A pasted pull request link is named for it, with the title `link` reads.
const opener = (page, target) => {
  const [, , repo, , number] = new URL(target).pathname.split("/");
  return page.getByRole("link", {
    name: `${repo}#${number} · A useful change`,
    exact: true,
  });
};
async function link(page, app, target) {
  await page.route("https://api.github.com/repos/block/buzz/pulls/*", (route) =>
    route.fulfill({
      json: {
        title: "A useful change",
        state: "open",
        user: { login: "Fixture Reader" },
        body: "Public fixture content.\n".repeat(100),
      },
    }),
  );
  // A return from a compose route can still be restoring the timeline.
  await settle(page);
  app.append("primary", "alpha", `Please review ${target}`);
  const trigger = opener(page, target);
  await expect(trigger).toBeVisible();
  await settle(page);
  await trigger.scrollIntoViewIfNeeded();
  // Appending and bringing an offscreen link into view can both scroll Virtua.
  // These are panel-layout checks, not clicks during an in-flight correction.
  await settle(page);
  await expect(
    page.getByRole("region", { name: "Channel message history" }).locator("ol"),
  ).toHaveCSS("pointer-events", "auto");
  await trigger.click();
  await expect(
    panel(page).getByRole("heading", {
      name: `A useful change #${new URL(target).pathname.split("/").at(-1)}`,
    }),
  ).toBeVisible();
  // Geometry assertions observe the settled overlay, not an entrance frame.
  await panel(page).evaluate(async (element) => {
    await Promise.allSettled(
      element
        .closest("[data-panel-dock]")
        .getAnimations()
        .map((animation) => animation.finished),
    );
  });
}
async function shellFits(page, width) {
  // The Workflows page renders no toggle at wide widths, so settle only when
  // the drawer is in play.
  if (width <= 650) await settleShellToggle(page);
  const disclosure = button(page, "Show navigation");
  const collapsed = await disclosure.isVisible();
  if (collapsed) await disclosure.click();
  // Settings is a modal with its own navigation; the shell is measured with
  // Settings closed.
  const destinations = dockDestinations(page);
  await expect(destinations).toHaveText(destinationTitles);
  const dock = await box(page.getByRole("navigation", { name: "Apps dock" }));
  for (const destination of [destinations.first(), destinations.last()]) {
    await destination.scrollIntoViewIfNeeded();
    await expect(destination).toBeInViewport();
    const bounds = await box(destination);
    expect(bounds.x).toBeGreaterThanOrEqual(dock.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(dock.x + dock.width);
  }
  // Sidebar pages, such as the bundled Drafts & sent, stay in the Messages
  // sidebar instead of the dock. Its draft count may follow the label.
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const drafts = sidebar
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: /^Drafts & sent/ });
  await expect(drafts).toHaveText(/^Drafts & sent(?:\d+)?$/);
  await drafts.scrollIntoViewIfNeeded();
  const sidebarBounds = await box(sidebar);
  const draftsBounds = await box(drafts);
  expect(draftsBounds.x).toBeGreaterThanOrEqual(sidebarBounds.x);
  expect(draftsBounds.x + draftsBounds.width).toBeLessThanOrEqual(
    sidebarBounds.x + sidebarBounds.width,
  );
  await expect(
    page
      .getByRole("navigation", { name: "Apps dock" })
      .getByRole("tab", { name: /Drafts & sent/ }),
  ).toHaveCount(0);
  const actions = await box(page.locator(".shell-actions"));
  const communities = await box(
    page.getByRole("navigation", { name: "Communities", exact: true }),
  );
  expect(actions.x + actions.width).toBeLessThanOrEqual(width);
  const profile = await box(button(page, "Your profile"));
  // Account controls remain reachable below the independently scrolling apps.
  for (const control of [communities, profile]) {
    expect(control.x).toBeGreaterThanOrEqual(dock.x);
    expect(control.x + control.width).toBeLessThanOrEqual(dock.x + dock.width);
    expect(control.y).toBeGreaterThanOrEqual(dock.y);
    expect(control.y + control.height).toBeLessThanOrEqual(
      dock.y + dock.height,
    );
  }
  expect(communities.y + communities.height).toBeLessThanOrEqual(profile.y);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(width);
  if (collapsed) await button(page, "Hide navigation").click();
}

scroll(
  "page overscroll is disabled while message history still scrolls",
  async ({ page, app }) => {
    await open(page, app);
    // Headless wheel input does not reproduce macOS trackpad rubber-banding.
    // Check the viewport policy as well as real panel scrolling and shell bounds.
    await expect(page.locator("html")).toHaveCSS("overscroll-behavior", "none");
    const shell = page.locator(".shell-background");
    const bounds = await box(shell);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await settle(page);
    const initialOffset = await history.evaluate((el) => el.scrollTop);
    await history.hover();
    await wheel(page, -300);
    await expect
      .poll(() => history.evaluate((el) => el.scrollTop))
      .toBeLessThan(initialOffset - 100);
    await settle(page);
    expect(await box(shell)).toEqual(bounds);

    // Workflows has no overflowing content: gestures must leave the shell in place.
    await openPage(page, "Workflows");
    await page.getByRole("heading", { name: "Workflows", exact: true }).hover();
    for (const [x, y] of [
      [0, -600],
      [0, 600],
      [-600, 0],
      [600, 0],
    ]) {
      await page.mouse.wheel(x, y);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await box(shell)).toEqual(bounds);
      expect(
        await page.evaluate(() => [window.scrollX, window.scrollY]),
      ).toEqual([0, 0]);
    }
  },
);

test("joined sidebar and workspace surface, real link panel and compact community navigation", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await open(page, app);
  await shellFits(page, 1280);
  const sidebar = await box(
    page.getByRole("complementary", { name: "Sidebar", exact: true }),
  );
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  // The sidebar and main are flush regions inside one outer panel.
  const mainPanel = page.locator("#main-content > [data-joined]");
  const gap = await panelGap(page);
  near((await box(mainPanel)).x, sidebar.x + sidebar.width);
  const seam = page.locator("#shell-navigation");
  await expect
    .poll(() =>
      seam.evaluate((element) => {
        const style = getComputedStyle(element, "::after");
        return (
          style.content !== "none" &&
          Number.parseFloat(style.width) > 0 &&
          style.backgroundColor !== "rgba(0, 0, 0, 0)"
        );
      }),
    )
    .toBe(true);
  const sidebarHandle = page.getByRole("separator", {
    name: "Resize sidebar",
  });
  const gripTarget = await box(sidebarHandle);
  near(gripTarget.width, 8);
  // The hit target starts at the seam so it cannot block sidebar controls.
  near(gripTarget.x, sidebar.x + sidebar.width);
  await sidebarHandle.hover();
  await expect
    .poll(() =>
      sidebarHandle.evaluate(
        (element) => getComputedStyle(element, "::after").opacity,
      ),
    )
    .toBe("0.5");
  await expect
    .poll(() =>
      sidebarHandle.evaluate(
        (element) => getComputedStyle(element, "::after").left,
      ),
    )
    .toBe("0px");
  await page.mouse.move(0, 0);
  await expect(conversation).toHaveCSS("border-radius", "0px");
  await expect(conversation).toHaveCSS("border-top-width", "0px");
  await expect(conversation).toHaveCSS("box-shadow", "none");
  const before = await box(conversation);
  const rail = await box(
    page.getByRole("navigation", { name: "Communities", exact: true }),
  );
  const appDock = await box(
    page.getByRole("navigation", { name: "Apps dock" }),
  );
  near(sidebar.x, appDock.x + appDock.width + 1);
  const profile = await box(button(page, "Your profile"));
  near(rail.x + rail.width / 2, profile.x + profile.width / 2);
  near(before.x, sidebar.x + sidebar.width);
  near(
    before.y,
    (await box(page.locator(".shell-header"))).y +
      (await box(page.locator(".shell-header"))).height +
      1,
  );
  const background = await page
    .locator(".shell-background")
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(background).toContain("radial-gradient");
  // The opaque shell color and the decorative dot texture are separate.
  const shellColor = await page.locator(".shell-background").evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--bg-app)";
    el.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await expect(page.locator(".shell-background")).toHaveCSS(
    "background-color",
    shellColor,
  );
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Layout draft");
  await page.screenshot({ path: testInfo.outputPath("joined-no-panel.png") });
  await link(page, app, "https://github.com/block/buzz/pull/1");
  const main = await box(conversation);
  const dock = await box(page.locator("[data-panel-workspace]"));
  near(dock.y, main.y);
  near(dock.height, main.height);
  near(dock.x - main.x - main.width, 1);
  near(dock.x + dock.width, page.viewportSize().width - gap - 1);
  await expect(composer).toHaveJSProperty("value", "Layout draft");
  await expect(composer).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("joined-one-panel.png") });
  const timeline = page.getByRole("region", {
    name: "Channel message history",
  });
  const offset = await timeline.evaluate((el) => el.scrollTop);
  // Wait for the description to overflow before testing scroll ownership.
  await expect
    .poll(() =>
      panel(page)
        .locator("[class*='root']")
        .evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBeGreaterThan(1000);
  await panel(page)
    .getByRole("heading", { name: "A useful change #1" })
    .hover();
  await page.mouse.wheel(0, 1000);
  await expect
    .poll(() =>
      panel(page)
        .locator("[class*='root']")
        .evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(100);
  near(await timeline.evaluate((el) => el.scrollTop), offset);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
    )
    .click();
  await expect(panel(page)).toHaveCount(0);
  // Inert content leaves the accessibility tree before its visual exit finishes.
  await expect(page.locator("[data-panel-dock]")).toHaveCount(0);
  near((await box(conversation)).width, before.width);
  await link(page, app, "https://github.com/block/buzz/pull/2");
  await button(page, "Beta").click();
  await expect(panel(page)).toHaveCount(0);
  await button(page, "Alpha").click();
  await expect(composer).toHaveJSProperty("value", "Layout draft");
  const picker = await openCommunityPicker(page);
  await expect(
    picker.getByRole("button", { name: "Personal space", exact: true }),
  ).toBeVisible();
  await picker
    .getByRole("button", { name: "Join a community", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Join a community", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Community switcher: Primary",
      exact: true,
    }),
  ).toBeFocused();
  await selectCommunity(page, "Secondary");
  await expect(composer).toHaveJSProperty("value", "");
  await selectCommunity(page, "Primary");
  await expect(composer).toHaveJSProperty("value", "Layout draft");
  for (const [width, height] of [
    [1200, 800],
    [800, 600],
    [480, 400],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await shellFits(page, width);
    await expect(composer).toBeInViewport();
    // Settings is a modal over the retained conversation at every width; narrow
    // modals stack their own navigation above the detail.
    await openSettings(page);
    const modal = await box(settingsDialog(page));
    expect(modal.x).toBeGreaterThanOrEqual(0);
    expect(modal.x + modal.width).toBeLessThanOrEqual(width);
    await expect(settingsSections(page)).toBeInViewport();
    await closeSettings(page);
    await expect(composer).toHaveJSProperty("value", "Layout draft");
    await expect(page.locator("[data-message-id]").last()).toBeInViewport();
  }
  await expect(panel(page)).toBeVisible();
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
    )
    .click();
  await expect(panel(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("bento-narrow.png") });
  await link(page, app, "https://github.com/block/buzz/pull/3");
  await expect(
    page.locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
    ),
  ).toBeInViewport();
  const narrow = await box(page.locator("[data-panel-workspace]"));
  const narrowConversation = await box(conversation);
  near(narrow.x, narrowConversation.x);
  near(narrow.width, narrowConversation.width);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
    )
    .click();
  await expect(composer).toBeInViewport();
  await openPage(page, "Workflows");
  // Search selection and the header share page state, so Workflows is current.
  // The host focuses main when the independent page opens.
  await expect(page.getByRole("main")).toBeFocused();
  const hiddenDestinations = dockDestinations(page, { includeHidden: true });
  await expect(hiddenDestinations).toHaveText(destinationTitles);
  await expect(
    hiddenDestinations.and(page.locator("[aria-current]")),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Apps dock", includeHidden: true })
      .getByRole("tab", {
        name: "Workflows",
        exact: true,
        includeHidden: true,
      }),
  ).toHaveAttribute("aria-selected", "true");
  await openSettings(page);
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Fixture Reader");
  // Settings is the only open dialog.
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await selectSettingsSection(page, "Manage plugins");
  // Channels is required; use another page to exercise UI activation.
  const projects = pluginAction(page, "Workflows");
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  // Header search is inert behind Settings; close it to read the palette.
  const expectWorkflowsChoice = async (count) => {
    await closeSettings(page);
    const choices = await pageChoices(page, "Messages");
    // Messages proves the Pages group rendered before counting Workflows.
    await expect(pageChoice(choices, "Messages")).toBeVisible();
    await page
      .getByRole("combobox", { name: "Search Buzz", exact: true })
      .fill("Workflows");
    await expect(pageChoice(choices, "Workflows")).toHaveCount(count);
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
  };
  await projects.click();
  await expect(projects).toHaveAccessibleName(/^Enable /);
  await expectWorkflowsChoice(0);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await projects.click();
  await expect(projects).toHaveAccessibleName(/^Disable /);
  await expectWorkflowsChoice(1);
});

test("narrow link panels begin after the rendered sidebar", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await open(page, app);
  await page.getByRole("separator", { name: "Resize sidebar" }).press("End");
  await page.setViewportSize({ width: 800, height: 600 });
  await link(page, app, "https://github.com/block/buzz/pull/7");

  const sidebar = await box(
    page.getByRole("complementary", { name: "Sidebar", exact: true }),
  );
  const conversation = await box(
    page.getByRole("article", { name: "Conversation", exact: true }),
  );
  const dock = await box(page.locator("[data-panel-workspace]"));
  near(conversation.x, sidebar.x + sidebar.width);
  near(dock.x, conversation.x);
  expect(dock.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
  // Separate stacking contexts: assert actual hit testing, not unrelated z-index numbers.
  const close = page.locator(
    '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
  );
  expect(
    await close.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await close.click();
  await expect(panel(page)).toHaveCount(0);
});

test("composer stays docked while a cold channel loads", async ({
  page,
  app,
}) => {
  // Hold Beta's head read so its loading placeholder stays rendered.
  const beta = Promise.withResolvers();
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON() ?? [];
    if (filters.some((filter) => filter["#h"]?.includes("beta")))
      await beta.promise;
    await route.fallback();
  });
  const composer = (name) =>
    page.getByRole("textbox", { name: `Message #${name}`, exact: true });
  let docked;
  try {
    await open(page, app);
    docked = await box(composer("Alpha"));
    await button(page, "Beta").click();
    await expect(
      page.getByRole("status").filter({ hasText: "Loading messages…" }),
    ).toBeVisible();
    near((await box(composer("Beta"))).y, docked.y);
  } finally {
    beta.resolve();
  }
  await expect(
    page.locator('[data-channel-timeline="beta"] [data-message-id]').first(),
  ).toBeVisible();
  near((await box(composer("Beta"))).y, docked.y);
});

// Virtua expires an imperative scroll 150ms after its last size update and
// restores the list's pointer events 150ms after the last scroll event. That
// observable state plus settled geometry replaces a fake clock, which would
// also reorder requestAnimationFrame against the rendering update.
async function virtuaIdle(page) {
  // The scroll event must have reached Virtua before its idle state is read.
  await frames(page);
  await expect(
    page.getByRole("region", { name: "Channel message history" }).locator("ol"),
  ).toHaveCSS("pointer-events", "auto");
  await settle(page);
}

readingTest(
  "simultaneous row shrink above and growth below preserve bottom follow",
  async ({ page, app }) => {
    await open(page, app);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const expectBottom = () =>
      expect
        .poll(() =>
          history.evaluate(
            (element) =>
              element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThan(4);
    // Opening at the bottom ends in a downward scroll. Until Virtua's idle, its
    // buffer covers only the side below, so no row above the viewport is mounted.
    await virtuaIdle(page);
    await expectBottom();
    // Pointer events and stable geometry can precede React's buffered-row
    // commit. Wait for the offscreen row this scenario needs before resizing it.
    let rows;
    await expect
      .poll(
        async () =>
          (rows = await history.evaluate((element) => {
            const top = element.getBoundingClientRect().top;
            const mounted = [...element.querySelectorAll("[data-message-id]")];
            const above = mounted.findLast(
              (row) => row.getBoundingClientRect().bottom <= top,
            );
            const newest = mounted.at(-1);
            if (!above || !newest || above === newest) return null;
            above.style.paddingBottom = "100px";
            return {
              above: above.dataset.messageId,
              newest: newest.dataset.messageId,
            };
          })),
        { message: "an offscreen row is mounted above the bottom viewport" },
      )
      .not.toBeNull();
    await virtuaIdle(page);
    await expectBottom();
    await history.evaluate((element, ids) => {
      const row = (id) =>
        element.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      row(ids.above).style.removeProperty("padding-bottom");
      row(ids.newest).style.paddingBottom = "120px";
    }, rows);
    await settle(page);
    await expectBottom();
  },
);
readingTest(
  "panel resizing preserves bottom follow and the visible reading anchor",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    await link(page, app, "https://github.com/block/buzz/pull/4");
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const expectBottom = () =>
      expect
        .poll(() =>
          history.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        )
        .toBeLessThan(4);
    await settle(page);
    await expectBottom();
    const received = app.append("primary", "alpha");
    await expect(
      page.locator(`[data-message-id="${received.id}"]`),
    ).toBeInViewport();
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
      )
      .click();
    await expect(page.locator("[data-panel-dock][data-closing]")).toHaveCount(
      0,
    );
    await settle(page);
    await expectBottom();
    // Late layout-only reflow must not need another message or viewport resize.
    // Let Virtua's imperative-scroll scheduler expire first. Change actual
    // row layout, not scroll methods/metrics or the production observer callback.
    // Timer expiry can commit another virtualized range; native resize/scroll
    // delivery must finish before the separate late-layout change begins.
    await virtuaIdle(page);
    await expectBottom();
    const lateLayout = await page.addStyleTag({
      content: `[data-message-id="${received.id}"] p { padding-bottom: 120px; }`,
    });
    await settle(page);
    await expectBottom();
    await virtuaIdle(page);
    await expectBottom();
    await lateLayout.evaluate((element) => element.remove());
    await settle(page);
    await expectBottom();
    // Reopen by keyboard without browser click-to-scroll changing the saved position.
    const target = "https://github.com/block/buzz/pull/4";
    // Keep the offscreen opener within the virtualizer's mounted buffer after
    // focus moves to the panel; this tests restoration to a mounted trigger.
    await history.hover();
    await wheel(page, -200);
    const saved = await anchor(page);
    await expectNonPaging(page, app);
    await opener(page, target).evaluate((el) =>
      el.focus({ preventScroll: true }),
    );
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    await settle(page);
    await expectAnchor(page, saved);
    // A panel can return focus to a mounted but offscreen link. Observe the
    // native focus call itself: eventual anchor recovery can hide a scroll jump.
    await opener(page, target).evaluate((el) => {
      const focus = el.focus;
      el.focus = function (options) {
        const history = el.closest("[data-channel-timeline]");
        const before = history.scrollTop;
        focus.call(this, options);
        window.panelFocusScrollDelta = history.scrollTop - before;
      };
    });
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
      )
      .focus();
    await expect(opener(page, target)).not.toBeInViewport();
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
      )
      .click();
    const trigger = opener(page, target);
    await settle(page);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.panelFocusScrollDelta)).toBe(0);
    await expectAnchor(page, saved);
    // Reflow can arrive after Virtua's 150ms imperative-scroll scheduler ends.
    // Keep the selected reading anchor, not the partially clipped row above it.
    await virtuaIdle(page);
    const preceding = await history.evaluate((element, id) => {
      const rows = [...element.querySelectorAll("[data-message-id]")];
      const index = rows.findIndex((row) => row.dataset.messageId === id);
      return rows[index - 1]?.dataset.messageId;
    }, saved.id);
    expect(preceding).toBeTruthy();
    const delayedReflow = await page.addStyleTag({
      content: `[data-message-id="${preceding}"] p { padding-bottom: 52px; }`,
    });
    await settle(page);
    await expectAnchor(page, saved);
    await delayedReflow.evaluate((element) => element.remove());
    await settle(page);
    await expectAnchor(page, saved);
    await page.setViewportSize({ width: 1200, height: 700 });
    await settle(page);
    await expectAnchor(page, saved);
    await expectNonPaging(page, app);
  },
);

readingTest(
  "a focused message stays mounted until focus leaves the timeline",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const target = "https://example.com/focused-message";
    const previous = await page
      .locator("[data-message-id]")
      .last()
      .getAttribute("data-message-id");
    const message = app.append("primary", "alpha", `Keep focus on ${target}`);
    const trigger = page.getByRole("link", { name: target, exact: true });
    await expect(trigger).toBeInViewport();
    await settle(page);
    await trigger.evaluate((el) => el.focus({ preventScroll: true }));
    await expect(trigger).toBeFocused();
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await history.hover();
    await page.mouse.wheel(0, -3500);
    // The adjacent unpinned row proves that real virtualization has evicted this
    // range; a timeout or a mocked virtualizer would not establish that boundary.
    await expect(page.locator(`[data-message-id="${previous}"]`)).toHaveCount(
      0,
    );
    await settle(page);
    await expect(trigger).toBeFocused();
    await expect(trigger).not.toBeInViewport();
    await history.evaluate((el) => el.focus({ preventScroll: true }));
    await expect(history).toBeFocused();
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(
      0,
    );
  },
);

companionTest(
  "A plugin owns the launcher and the reusable companion card across pages and disable",
  async ({ page, app }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 832 });
    await page.goto(app.origin);
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    const launch = companionLauncher(page, "Companion fixture");
    await expect(launch).toBeVisible();
    await expect(companion).toHaveCount(0);
    await launch.click();
    await expect(companion).toBeVisible();
    await expect(companion).toContainText("Companion fixture content");
    await expect(launch).toHaveAttribute("aria-expanded", "true");
    await launch.click();
    await expect(companion).toHaveCount(0);
    await expect(launch).toHaveAttribute("aria-expanded", "false");
    await expect(launch).toBeFocused();
    await launch.click();
    await button(page, "Close Companion fixture panel").click();
    await expect(launch).toBeFocused();
    await launch.click();
    // Settings is a modal over the retained workspace: the companion and its
    // launcher stay mounted behind it, hidden from assistive technology.
    const retainedCompanion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
      includeHidden: true,
    });
    const retainedLaunch = page
      .getByRole("button", {
        name: "Companion fixture",
        exact: true,
        includeHidden: true,
      })
      .and(page.locator("button[aria-expanded]"));
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    await expect(companion).toHaveCount(0);
    await expect(retainedCompanion).toHaveCount(1);
    await expect(retainedLaunch).toHaveCount(1);
    const enabled = pluginAction(page, "Companion fixture");
    await enabled.click();
    await expect(retainedLaunch).toHaveCount(0);
    await expect(retainedCompanion).toHaveCount(0);
    await expect(enabled).toBeFocused();
    // Wait for the closing dock's removal before the next click.
    await expect(page.locator("[data-panel-dock]")).toHaveCount(0);
    await enabled.click();
    await expect(retainedLaunch).toHaveCount(1);
    await expect(retainedCompanion).toHaveCount(0);
    await closeSettings(page);
    await expect(launch).toBeVisible();
    await expect(companion).toHaveCount(0);
    await launch.click();
    // The companion keeps one default, minimum, saved width and reset as it
    // moves between PanelFrame and Messages' dock.
    await openPage(page, "Activity");
    await expect(companion).toBeVisible();
    const resize = page.getByRole("separator", {
      name: "Resize main and secondary panels",
    });
    const resizedWidth = async () =>
      Number(await resize.getAttribute("aria-valuenow"));
    // Visibility can precede PanelFrame measurement; its initial minimum is 300.
    const defaultWidth = 420;
    await expect.poll(resizedWidth).toBe(defaultWidth);
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    const visitMessages = async () => {
      await openPage(page, "Messages");
      await expect(composer).toBeVisible();
    };
    await visitMessages();
    await expect.poll(resizedWidth).toBe(defaultWidth);
    await openPage(page, "Activity");
    await resize.focus();
    await resize.press("Home");
    await expect.poll(resizedWidth).toBeLessThan(defaultWidth);
    const minimumWidth = await resizedWidth();
    await visitMessages();
    await expect.poll(resizedWidth).toBe(minimumWidth);
    await openPage(page, "Activity");
    await resize.focus();
    await resize.press("Shift+ArrowLeft");
    await expect.poll(resizedWidth).toBeGreaterThan(minimumWidth + 40);
    const companionWidth = await resizedWidth();
    await visitMessages();
    await expect.poll(resizedWidth).toBe(companionWidth);
    await resize.dblclick();
    await expect.poll(resizedWidth).toBe(defaultWidth);
    await openPage(page, "Activity");
    await expect.poll(resizedWidth).toBe(defaultWidth);
    await visitMessages();
    await composer.fill("Companion draft");
    const conversation = page.getByRole("article", {
      name: "Conversation",
      exact: true,
    });
    near((await box(companion)).height, (await box(conversation)).height);
    await link(page, app, "https://github.com/block/buzz/pull/5");
    const top = await box(page.locator("[data-panel-workspace]")),
      bottom = await box(companion),
      main = await box(conversation);
    near(top.height, bottom.height);
    near(top.y, main.y);
    near(bottom.y - top.y - top.height, 1);
    near(bottom.y + bottom.height, main.y + main.height);
    near(top.x, bottom.x);
    await page.screenshot({
      path: testInfo.outputPath("companion-two-panels.png"),
    });
    // Simulate a management update observed while Messages remains mounted.
    await page.evaluate(() => {
      const key = "buzzodz.plugins.v1";
      const settings = JSON.parse(localStorage.getItem(key));
      settings.enabled["fixture.companion"] = false;
      localStorage.setItem(key, JSON.stringify(settings));
    });
    await expect(launch).toHaveCount(0);
    await expect(companion).toHaveCount(0);
    await expect(panel(page)).toHaveCount(1);
    near(
      (await box(page.locator("[data-panel-workspace]"))).height,
      (await box(conversation)).height,
    );
    await page.evaluate(() => {
      const key = "buzzodz.plugins.v1";
      const settings = JSON.parse(localStorage.getItem(key));
      settings.enabled["fixture.companion"] = true;
      localStorage.setItem(key, JSON.stringify(settings));
    });
    await expect(launch).toBeVisible();
    await expect(companion).toHaveCount(0);
    await launch.click();
    await expect(composer).toHaveJSProperty("value", "Companion draft");
    await button(page, "Close Companion fixture panel").click();
    near(
      (await box(page.locator("[data-panel-workspace]"))).height,
      (await box(conversation)).height,
    );
    await launch.click();
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
      )
      .click();
    near((await box(companion)).height, (await box(conversation)).height);
    await button(page, "Beta").click();
    await expect(companion).toHaveCount(1);
    await button(page, "Alpha").click();
    await expect(composer).toHaveJSProperty("value", "Companion draft");
    await selectCommunity(page, "Personal space");
    await expect(
      page.getByRole("heading", { name: "Your channels, one conversation." }),
    ).toBeVisible();
    await expect(companion).toHaveCount(1);
    await button(page, "Close Companion fixture panel").click();
    await launch.click();
    await expect(companion).toHaveCount(1);
    for (const [width, height] of [
      [800, 600],
      [480, 400],
      [390, 844],
      [390, 400],
    ]) {
      await page.setViewportSize({ width, height });
      await shellFits(page, width);
      await expect(
        button(page, "Close Companion fixture panel"),
      ).toBeInViewport();
      // The Settings modal fits each width over the retained, inert companion.
      await openSettings(page);
      // Observe the settled frame, not its upward entrance motion.
      await settleDialogMotion(settingsDialog(page));
      const modal = await box(settingsDialog(page));
      expect(modal.x).toBeGreaterThanOrEqual(0);
      expect(modal.y).toBeGreaterThanOrEqual(0);
      expect(modal.x + modal.width).toBeLessThanOrEqual(width);
      expect(modal.y + modal.height).toBeLessThanOrEqual(height);
      await expect(companion).toHaveCount(0);
      await expect(retainedCompanion).toHaveCount(1);
      await closeSettings(page);
      await expect(
        button(page, "Close Companion fixture panel"),
      ).toBeInViewport();
    }
    await button(page, "Close Companion fixture panel").click();
    await expect(companion).toHaveCount(0);
    await expect(launch).toHaveAttribute("aria-expanded", "false");
    await expect(launch).toBeFocused();

    // Plugin catalogs can outgrow the viewport: reach the toggle with real
    // input, not scrollIntoView. Narrow modals scroll their stacked navigation
    // and detail together.
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    const settingsPage = settingsDialog(page).locator(
      ".buzz-dialog-navigation-layout",
    );
    await expect(enabled).not.toBeInViewport();
    const viewport = await box(settingsPage);
    await page.mouse.move(
      viewport.x + viewport.width / 2,
      viewport.y + viewport.height / 2,
    );
    const visibleTop = Math.max(viewport.y, 0);
    const visibleBottom = Math.min(viewport.y + viewport.height, 400);
    for (let gesture = 0; gesture < 30; gesture++) {
      const toggle = await box(enabled);
      if (
        toggle.y >= visibleTop + 8 &&
        toggle.y + toggle.height <= visibleBottom - 8
      )
        break;
      const distance =
        toggle.y < visibleTop + 8
          ? toggle.y - visibleTop - 8
          : toggle.y + toggle.height - visibleBottom + 8;
      const before = await settingsPage.evaluate((el) => el.scrollTop);
      await wheel(
        page,
        Math.sign(distance) * Math.max(Math.abs(distance), 24),
        settingsPage,
      );
      await expect
        .poll(() => settingsPage.evaluate((el) => el.scrollTop), {
          message:
            "Settings wheel input makes progress toward the plugin toggle",
        })
        .toBeGreaterThan(before);
    }
    await expect(enabled).toBeInViewport({ ratio: 1 });
    await enabled.click();
    await expect(enabled).toHaveAccessibleName(/^Enable /);
    await expect(enabled).toBeFocused();
    await expect(retainedLaunch).toHaveCount(0);
    await closeSettings(page);
    await expect(launch).toHaveCount(0);
  },
);

const todosOverlapTest = companionTest.extend({
  threadUnread: true,
  readState: true,
  historyCounts: { alpha: 3, beta: 1 },
});
todosOverlapTest(
  "Todos stacks beside threads and linked panels in either opening order",
  async ({ page, app }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await open(page, app);
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    await pluginAction(page, "Todos").click();
    await closeSettings(page);
    await openPage(page, "Messages");
    const todos = page.getByRole("region", {
      name: "Todos panel",
      exact: true,
    });
    const toggle = button(page, "Toggle channel todos");
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const linked = panel(page);
    const settings = page.getByRole("complementary", {
      name: "Channel settings",
      exact: true,
    });
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    const stacked = async (primary) => {
      await expect(primary).toBeVisible();
      await expect(todos).toBeVisible();
      near((await box(todos.locator("header.panel-header"))).height, 40);
      const top = await box(primary);
      const bottom = await box(todos);
      near(top.x, bottom.x);
      near(top.width, bottom.width);
      near(bottom.y - top.y - top.height, 1);
      const conversation = await box(
        page.getByRole("article", {
          name: "Conversation",
          exact: true,
        }),
      );
      near(bottom.y + bottom.height, conversation.y + conversation.height);
    };
    const openThread = async () => {
      const root = app.histories
        .get("primary/alpha")
        .find((event) => event.content === "Thread root 0");
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await expect(thread).toBeVisible();
      await expect(thread).toHaveCSS("border-radius", "0px");
      await expect(thread).toHaveCSS("border-width", "0px");
      await expect(thread).toHaveCSS("box-shadow", "none");
      const threadHeader = await box(
        page.locator("[data-panel-dock] header.panel-header").first(),
      );
      const channelHeader = await box(
        page
          .getByRole("article", { name: "Conversation", exact: true })
          .locator("header.panel-header"),
      );
      expect(threadHeader.height).toBeCloseTo(channelHeader.height, 1);
      near(threadHeader.y, channelHeader.y);
    };

    await toggle.click();
    await openThread();
    await stacked(thread);
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button[aria-label^="Close "]',
      )
      .click();
    await button(page, "Hide todos").click();
    await openThread();
    await toggle.click();
    await stacked(thread);
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button[aria-label^="Close "]',
      )
      .click();

    await link(page, app, "https://github.com/block/buzz/pull/6");
    await stacked(linked);
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
      )
      .click();
    await button(page, "Hide todos").click();
    await link(page, app, "https://github.com/block/buzz/pull/7");
    await toggle.click();
    await stacked(linked);
    await openChannelDetails(page);
    await expect(settings).toBeVisible();
    await expect(todos).toHaveCount(0); // Settings intentionally retires the drawer.
    await button(page, "Close Channel settings tab").click();
    await expect(linked).toBeVisible();
    await companionLauncher(page, "Companion fixture").click();
    await expect(companion).toBeVisible();
    await expect(linked).toBeVisible();
    near(
      (await box(companion)).y -
        (await box(linked)).y -
        (await box(linked)).height,
      1,
    );
    await button(page, "Close Companion fixture panel").click();
  },
);

companionReadingTest(
  "companion resize preserves the timeline anchor and both cards at narrow sizes",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const saved = await upper(page);
    await expectNonPaging(page, app);
    await companionLauncher(page, "Companion fixture").click();
    await settle(page);
    await expectAnchor(page, saved);
    await button(page, "Close Companion fixture panel").click();
    await settle(page);
    await expectAnchor(page, saved);
    await link(page, app, "https://github.com/block/buzz/pull/6");
    await companionLauncher(page, "Companion fixture").click();
    for (const [width, height] of [
      [1440, 950],
      [800, 600],
      [480, 400],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      let top;
      let bottom;
      // The resize observer applies panel allocation after viewport resize resolves.
      // Capture the baseline only once both cards have their matching layout.
      await expect(async () => {
        top = await box(page.locator("[data-panel-workspace]"));
        bottom = await box(
          page.getByRole("complementary", {
            name: "Companion fixture",
            exact: true,
          }),
        );
        near(top.height, bottom.height);
        near(bottom.y - top.y - top.height, 1);
      }).toPass({ timeout: 10_000 });
      await expect(
        page.locator(
          '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
        ),
      ).toBeInViewport();
      await expect(
        button(page, "Close Companion fixture panel"),
      ).toBeInViewport();
      await openChannelDetails(page, { programmatic: true });
      const settings = page.getByRole("complementary", {
        name: "Channel settings",
        exact: true,
      });
      await expect(settings).toBeVisible();
      const covered = await box(page.locator("[data-panel-workspace]"));
      const retainedCompanion = await box(
        page.getByRole("complementary", {
          name: "Companion fixture",
          exact: true,
        }),
      );
      near(covered.height, top.height);
      near(retainedCompanion.height, bottom.height);
      near(retainedCompanion.y, bottom.y);
      await button(page, "Close Channel settings tab").click();
      await expect(
        page.locator(
          '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
        ),
      ).toBeInViewport();
    }
  },
);

companionReadingTest(
  "panel restoration yields to a new wheel reading position",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const original = await upper(page);
    await companionLauncher(page, "Companion fixture").click();
    await settle(page);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await history.hover();
    // A tall row above the anchor can exceed one wheel step, and a tall
    // paragraph need not fit wholly in the narrowed viewport. Keep making real
    // progress until the visible reading row (including the production
    // clipped-row fallback) belongs to another message; never repeat a read
    // until an immobile timeline happens to pass.
    let reading = original;
    for (
      let gesture = 0;
      gesture < 6 && reading.id === original.id;
      gesture++
    ) {
      const before = await history.evaluate((el) => el.scrollTop);
      // Keep the old anchor intersecting under the narrower message measure.
      const room = await history
        .locator(`[data-message-id="${original.id}"]`)
        .evaluate((row) => {
          const feed = row.closest("section");
          return (
            feed.getBoundingClientRect().bottom -
            row.getBoundingClientRect().top
          );
        });
      expect(room).toBeGreaterThan(1);
      await wheel(page, -Math.min(300, room / 2));
      await expect
        .poll(() => history.evaluate((el) => el.scrollTop))
        .toBeLessThan(before);
      await settle(page);
      reading = await anchor(page);
    }
    expect(reading.id).not.toBe(original.id);
    // An offscreen restored row is ignored even if gesture() fails to clear it.
    // Keep that row intersecting so the final assertion detects a stale anchor.
    await expect(
      history.locator(`[data-message-id="${original.id}"]`),
    ).toBeInViewport();
    await button(page, "Close Companion fixture panel").click();
    await settle(page);
    await expectAnchor(page, reading);
    await expectNonPaging(page, app);
  },
);

// Real App navigation must retire page-local targets, without closing the
// independently owned companion intent. Each return stays in Channels.
const sidebarActions = companionTest.extend({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  largeSidebar: true,
  historyCounts: { alpha: 20, beta: 1 },
});
sidebarActions(
  "sidebar activity and compose routes restore content history and preserve companion intent",
  async ({ page, app }) => {
    await open(page, app);
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    await companionLauncher(page, "Companion fixture").click();
    await expect(companion).toBeVisible();
    const alpha = page.locator('button[data-channel-id="alpha"]');
    for (const [index, action] of ["activity", "message"].entries()) {
      await link(page, app, `https://github.com/block/buzz/pull/${20 + index}`);
      if (action === "activity") {
        await alpha.hover();
        await page
          .getByRole("dialog", { name: "Activity in Alpha" })
          .getByRole("button", { name: /Open unread thread from/ })
          // Unlike the broadcast row, this reply cannot be marked read by the
          // visible main timeline while Playwright is moving the pointer.
          .filter({ hasText: "Unread reply 1" })
          .click();
        await expect(
          page.getByRole("complementary", { name: "Thread", exact: true }),
        ).toBeVisible();
      } else if (action === "message") {
        const sidebar = page.getByRole("navigation", {
          name: "Subscribed channels",
        });
        await sidebar
          .locator("summary", { hasText: /^Direct messages$/ })
          .hover();
        await sidebar
          .getByRole("button", { name: "New message", exact: true })
          .click();
        await expect(
          page.getByRole("region", { name: "New message", exact: true }),
        ).toBeVisible();
      }
      // Visiting another tab retains the inactive GitHub tab; compose routes
      // withdraw the workspace. Neither presents the GitHub content here.
      if (action === "activity") await expect(panel(page)).toBeHidden();
      else await expect(panel(page)).toHaveCount(0);
      await expect(
        companionLauncher(page, "Companion fixture"),
      ).toHaveAttribute("aria-expanded", "true");
      await button(page, "Go back").click();
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeVisible();
      // Back restores the pre-navigation content address even when New message
      // temporarily withdrew its workspace. Only X retires that return path.
      await expect(panel(page)).toBeVisible();
      await page
        .locator(
          '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
        )
        .click();
      await expect(companion).toBeVisible();
    }
  },
);

// Probe the platform's native default separately from the app: Linux and macOS
// WebKit differ for Control+Home and keyboard chaining through CSS containment.
// The app must preserve native behavior, not invent a cross-platform shortcut.
async function nativeUpwardScroll(context, key, containment) {
  const probe = await context.newPage();
  try {
    await probe.setContent(`
      <div id="outer" style="height:400px;overflow:auto">
        <div style="height:1600px"></div>
        <div id="inner" style="${containment ? `height:160px;overflow:auto;overscroll-behavior-y:${containment}` : ""}">
          <a id="control" href="#">Message link</a>
          ${containment ? '<div style="height:1600px"></div>' : ""}
        </div>
      </div>`);
    const outer = probe.locator("#outer");
    await outer.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await probe
      .locator("#control")
      .evaluate((el) => el.focus({ preventScroll: true }));
    await settle(probe, outer);
    const before = await outer.evaluate((el) => el.scrollTop);
    await probe.keyboard.press(key);
    await settle(probe, outer);
    return await outer.evaluate(
      (el, start) => el.scrollTop < start - 80,
      before,
    );
  } finally {
    await probe.close();
  }
}

// Native default keyboard scrolling from a focused descendant is browser-owned;
// deterministic same-shrink ordering is covered in ChannelTimeline.restore.test.
for (const [control, key] of [
  ["link", "PageUp"],
  ["button", "PageUp"],
  ["link", process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home"],
  ...(process.platform === "darwin" ? [["link", "Alt+ArrowUp"]] : []),
]) {
  readingTest(
    `${key} from a message ${control} preserves native scroll ownership`,
    async ({ page, app, context }) => {
      const nativeScroll = await nativeUpwardScroll(context, key);
      await open(page, app);
      await settle(page);
      const target = "https://example.com/keyboard-reading";
      const added = app.append(
        "primary",
        "alpha",
        `Read ${target}`,
        true,
        false,
      );
      const row = page.locator(`[data-message-id="${added.id}"]`);
      await expect(row).toBeInViewport();
      await settle(page);
      const history = page.getByRole("region", {
        name: "Channel message history",
      });
      const focused =
        control === "link"
          ? row.getByRole("link", { name: target, exact: true })
          : row.getByRole("button", { name: /^View .* profile$/ }).first();
      await focused.evaluate((element) =>
        element.focus({ preventScroll: true }),
      );
      await expect(focused).toBeFocused();
      const before = await history.evaluate((element) => element.scrollTop);
      // Linux WebKit can pause a native keyboard scroll and resume it after the
      // anchor is captured; only the history scrollend completes that gesture.
      if (nativeScroll) await keyScroll(page, key);
      else await page.keyboard.press(key);
      if (!nativeScroll) {
        await settle(page);
        expect(await history.evaluate((element) => element.scrollTop)).toBe(
          before,
        );
        const arrival = app.append(
          "primary",
          "alpha",
          "Still following after a native no-op key",
        );
        await expect(
          page.locator(`[data-message-id="${arrival.id}"]`),
        ).toBeInViewport();
        await settle(page);
        await expect
          .poll(() =>
            history.evaluate(
              (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
            ),
          )
          .toBeLessThan(2);
        return;
      }
      await expect
        .poll(() => history.evaluate((element) => element.scrollTop))
        .toBeLessThan(before - 80);
      await settle(page);
      const reading = await anchor(page);
      app.append("primary", "alpha", "Do not steal the reader's position");
      await expect(
        history.locator("[data-jump-to-latest]"),
      ).toHaveAccessibleName(/new message/i);
      await settle(page);
      await expectAnchor(page, reading);
      await expect(history.locator("[data-jump-to-latest]")).toBeVisible();
    },
  );
}

// Exercise both propagation and no-op lifecycle against the same engine's
// native baseline, rather than imposing macOS behavior on Linux WebKit.
for (const containment of ["auto", "contain"])
  readingTest(
    `Page Up respects the raw diff ${containment} scroll boundary`,
    async ({ page, app, context }) => {
      const nativeScroll = await nativeUpwardScroll(
        context,
        "PageUp",
        containment,
      );
      const historyEvents = app.histories.get("primary/alpha");
      historyEvents.push(
        finalizeEvent(
          {
            kind: 40008,
            created_at: historyEvents.at(-1).created_at + 1,
            tags: [
              ["h", "alpha"],
              ["file", "reading.txt"],
            ],
            content: "Raw, unparseable patch line\n".repeat(100),
          },
          generateSecretKey(),
        ),
      );
      await open(page, app);
      const raw = page.getByRole("region", { name: "Raw diff", exact: true });
      await expect(raw).toBeVisible();
      // The enabled diff renderer owns vertical overflow in its preview wrapper.
      const inner = page.getByRole("region", {
        name: "Diff preview: reading.txt",
      });
      await expect(inner).toBeVisible();
      await settle(page);
      const history = page.getByRole("region", {
        name: "Channel message history",
      });
      const before = await history.evaluate((el) => el.scrollTop);
      await inner.evaluate((el) => {
        el.scrollTop = 100;
      });
      await raw.evaluate((el) => el.focus({ preventScroll: true }));
      await expect(raw).toBeFocused();
      await page.keyboard.press("PageUp");
      await expect.poll(() => inner.evaluate((el) => el.scrollTop)).toBe(0);
      await settle(page);
      expect(await history.evaluate((el) => el.scrollTop)).toBe(before);

      await inner.evaluate((el, value) => {
        el.style.overscrollBehaviorY = value;
      }, containment);
      // Linux WebKit can pause native PageUp and resume it after the anchor is
      // captured; only the history scrollend completes that gesture.
      if (nativeScroll) await keyScroll(page, "PageUp");
      else await page.keyboard.press("PageUp");
      if (nativeScroll) {
        await expect
          .poll(() => history.evaluate((el) => el.scrollTop))
          .toBeLessThan(before - 80);
        await settle(page);
        const reading = await anchor(page);
        app.append("primary", "alpha", "Keep the reader above the diff");
        await expect(
          history.locator("[data-jump-to-latest]"),
        ).toHaveAccessibleName(/new message/i);
        await settle(page);
        await expectAnchor(page, reading);
      } else {
        await settle(page);
        expect(await history.evaluate((el) => el.scrollTop)).toBe(before);
        // No outer scrollend will retire this key. A later real layout contraction
        // must retain bottom follow, including the next incoming message.
        const height = await history.evaluate((el) => el.scrollHeight);
        await inner.evaluate((el) => {
          el.style.maxHeight = "80px";
        });
        await expect
          .poll(() => history.evaluate((el) => el.scrollHeight))
          .toBeLessThan(height);
        await settle(page);
        const arrival = app.append(
          "primary",
          "alpha",
          "Still following after an unconsumed Page Up",
        );
        await expect(
          page.locator(`[data-message-id="${arrival.id}"]`),
        ).toBeInViewport();
        await settle(page);
        await expect
          .poll(() =>
            history.evaluate(
              (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
            ),
          )
          .toBeLessThan(2);
      }
    },
  );
