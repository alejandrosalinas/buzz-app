import { pluginAction } from "./plugin-settings.mjs";
import {
  closeSettings,
  openPage,
  pageChoice,
  pageChoices,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ enabledPlugins: ["buzz.workflows"], pluginFixtures: true });

const home = { version: 1, kind: "home" };
const settings = { version: 1, kind: "settings" };
const address = (origin, target) =>
  `${origin}/#buzz=${encodeURIComponent(JSON.stringify(target))}`;
const messages = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });

// Browser-only contract: startup/hash/history share production composition and
// legacy Home links resolve without flashing the retired page or adding a visit.
test("launch opens Messages without exposing Home across responsive navigation, search and history", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() => {
    window.homeFrames = [];
    function observe() {
      const main = document.getElementById("main-content");
      if (main?.textContent.includes("Make yourself at home."))
        window.homeFrames.push(main.textContent);
      requestAnimationFrame(observe);
    }
    requestAnimationFrame(observe);
  });
  // Hold the metadata read after roster discovery, reproducing a cold start.
  let releaseMetadata;
  const metadataGate = new Promise((resolve) => {
    releaseMetadata = resolve;
  });
  let metadataHeld = false;
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.kinds?.includes(39000))
    ) {
      metadataHeld = true;
      await metadataGate;
    }
    await route.continue();
  });
  await page.goto(app.origin);
  await expect.poll(() => metadataHeld).toBe(true);
  expect(
    await page.evaluate(() => window.fixtureNavigation.snapshot().status),
  ).toBe("opening");
  releaseMetadata();
  await expect(messages(page)).toBeVisible();
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().entry.target),
      )
      .toMatchObject({
        // Local bootstrap now defers mounting ChannelsPage; the old initial
        // disconnected mount could complete this visit before default resolution.
        // The existing resolver keeps the conversation in that same visit.
        kind: "conversation",
        channelId: "alpha",
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      });
    await expect(messages(page)).toBeVisible();
    const choices = await pageChoices(page, "Messages");
    await expect(pageChoice(choices, "Messages")).toBeVisible();
    await page
      .getByRole("combobox", { name: "Search Buzz", exact: true })
      .fill("Home");
    await expect(pageChoice(choices, "Home")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  await page
    .getByRole("button", { name: /^Manage members of /, exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Manage members", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("launch-messages.png") });
  await page.getByRole("button", { name: "Search Buzz" }).click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  await expect(
    dialog.getByRole("group", { name: "This conversation" }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Search Buzz", exact: true })
    .fill("Messages");
  await expect(pageChoice(dialog, "Messages")).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Search Buzz", exact: true })
    .fill("Home");
  await expect(pageChoice(dialog, "Home")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await openPage(page, "Workflows");
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(async (target) => {
    const nav = window.fixtureNavigation;
    const pending = nav.open(target);
    const visit = nav.snapshot().entry.id;
    return { result: await pending, visit, resolved: nav.snapshot().entry.id };
  }, home);
  expect(result.result).toEqual({ status: "opened" });
  expect(result.resolved).toBe(result.visit);
  await expect(messages(page)).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(messages(page)).toBeVisible();
  expect(await page.evaluate(() => window.homeFrames)).toEqual([]);

  await page.goto(address(app.origin, home));
  await expect(messages(page)).toBeVisible();
  await page.reload();
  await expect(messages(page)).toBeVisible();
  expect(await page.evaluate(() => window.homeFrames)).toEqual([]);
});

test("default navigation retries failed metadata and accepts a completed empty lookup", async ({
  page,
  app,
}) => {
  let releaseMetadata;
  const gate = new Promise((resolve) => {
    releaseMetadata = resolve;
  });
  let held = false;
  let failMetadata = true;
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.kinds?.includes(39000))
    ) {
      held = true;
      await gate;
      await route.fulfill(
        failMetadata
          ? { json: { error: "Invalid metadata response" } }
          : { json: [] },
      );
    } else await route.continue();
  });
  await page.goto(app.origin);
  await expect.poll(() => held).toBe(true);
  expect(
    await page.evaluate(() => window.fixtureNavigation.snapshot().status),
  ).toBe("opening");
  releaseMetadata();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  failMetadata = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation.snapshot().entry.target),
    )
    .toMatchObject({ kind: "conversation" });
  await expect(page.getByRole("textbox", { name: /^Message #/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "alpha", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Manage members of /, exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Manage members", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Search Buzz" }).click();
  await expect(
    page.getByRole("group", { name: "This conversation" }),
  ).toBeVisible();
});

test("Channels stays enabled despite saved disabled settings and has no disable action", async ({
  page,
  app,
}) => {
  await page.goto(address(app.origin, settings));
  await page
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Manage plugins", exact: true })
      .getByRole("article")
      .filter({ has: page.getByText("Channels", { exact: true }) })
      .getByText("Required", { exact: true }),
  ).toBeVisible();
  await expect(pluginAction(page, "Channels")).toHaveCount(0);
  await expect(pluginAction(page, "Workflows")).toBeVisible();
  // Older disabled preferences cannot turn off the required launch destination.
  await page.evaluate(() => {
    const key = "buzzodz.plugins.v1";
    const saved = JSON.parse(localStorage.getItem(key)) ?? {
      version: 2,
      enabled: {},
    };
    saved.enabled["buzz.channels"] = false;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.goto(address(app.origin, home));
  await expect(messages(page)).toBeVisible();
  await page.reload();
  await expect(messages(page)).toBeVisible();
  await page.goto(address(app.origin, settings));
  await page
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Manage plugins", exact: true })
      .getByRole("article")
      .filter({ has: page.getByText("Channels", { exact: true }) })
      .getByText("Required", { exact: true }),
  ).toBeVisible();
  await expect(pluginAction(page, "Channels")).toHaveCount(0);
  // The workspace behind Settings is inert; close it before opening a page.
  await closeSettings(page);
  await openPage(page, "Messages");
  await expect(messages(page)).toBeVisible();
});

test("launch retains plugin-configuration recovery without Home", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzzodz.plugins.v1", "invalid"),
  );
  await page.goto(app.origin);
  await expect(
    page.getByRole("heading", { name: "Couldn’t open Buzz", exact: true }),
  ).toBeVisible();
  const recoveryChoices = await pageChoices(page, "Home");
  await expect(pageChoice(recoveryChoices, "Home")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await page
    .getByRole("button", { name: "Back up & reset settings", exact: true })
    .click();
  const recoveredChoices = await pageChoices(page, "Messages");
  await expect(pageChoice(recoveredChoices, "Messages")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(messages(page)).toBeVisible();
});

for (const huddle of [false, true]) {
  test(`exact destinations wait for classification (${huddle ? "unproven legacy Huddle" : "ordinary"})`, async ({
    page,
    app,
  }) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let held = false;
    let failMetadata = !huddle;
    const reads = [];
    await page.route("**/api/relay/**/query", async (route) => {
      const filters = route.request().postDataJSON();
      reads.push(
        ...filters.filter(
          (filter) =>
            filter.kinds?.includes(9) &&
            filter["#h"]?.includes("alpha") &&
            filter.top_level === true,
        ),
      );
      if (filters.some((filter) => filter.kinds?.includes(39000))) {
        held = true;
        await gate;
        if (failMetadata) {
          await route.fulfill({
            json: { error: "Invalid metadata response" },
          });
          return;
        }
        const response = await route.fetch();
        const events = await response.json();
        await route.fulfill({
          json: events.map((event) =>
            huddle &&
            event.kind === 39000 &&
            event.tags.some(([key, value]) => key === "d" && value === "alpha")
              ? app.channelMetadata("alpha", [
                  ["name", "Alpha"],
                  ["t", "stream"],
                  ["private"],
                  [
                    "about",
                    "Buzz Huddle (buzz.huddles/v1)\nparent:00000000-0000-4000-8000-000000000001",
                  ],
                ])
              : event,
          ),
        });
      } else await route.continue();
    });
    await page.goto(
      address(app.origin, {
        version: 1,
        kind: "conversation",
        channelId: "alpha",
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      }),
    );
    await expect.poll(() => held).toBe(true);
    expect(
      await page.evaluate(() => window.fixtureNavigation.snapshot().status),
    ).toBe("opening");
    await expect(
      page.getByRole("textbox", { name: /^Message #?Alpha$/ }),
    ).toHaveCount(0);
    expect(reads).toHaveLength(0);
    release();
    if (huddle) {
      // Mutable metadata without a creation receipt remains an ordinary
      // (private) channel.
      await expect(
        page.getByRole("textbox", { name: "Message Alpha", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
    } else {
      await expect(
        page.getByRole("button", { name: "Try again", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => window.fixtureNavigation.snapshot().status),
      ).toBe("failed");
      await expect(
        page.getByRole("textbox", { name: /^Message #?Alpha$/ }),
      ).toHaveCount(0);
      expect(reads).toHaveLength(0);
      failMetadata = false;
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(messages(page)).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
    }
  });
}
