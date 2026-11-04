import { pluginAction } from "./plugin-settings.mjs";
import {
  closeSettings,
  openPage,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { npubEncode } from "nostr-tools/nip19";
import { verifyEvent } from "nostr-tools";
import { test, expect } from "./fixture.mjs";

// These layout/navigation journeys exercise the opt-in Bestie surface.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const key = "buzzodz.plugins.v1";
    if (localStorage.getItem(key) === null)
      localStorage.setItem(
        key,
        JSON.stringify({ version: 2, enabled: { "buzz.bestie": true } }),
      );
  });
});

// Configure the modeled session at its HTTP owner instead of proxying it through
// route.fetch(), so session setup needs only the browser's original request.
test.use({ channelWriteKinds: [9, 9007, 40100] });

// Browser-only boundary: real plugin Settings/launcher/panel wiring, Canvas
// outbox -> signed HTTP receipt -> readback, native focus and drawer geometry.
// Markdown/recovery permutations belong in colocated Vitest tests.
test("opt-in Todos saves ordinary Canvas and disabling leaves it editable", async ({
  page,
  app,
}) => {
  const original =
    "# Notes\nKeep this prose.\n\n## Todos\n\n- [ ] First\n    - [ ] Build\n        - [/] Review\n    - [ ] **Read** [guide](https://example.com) [Beta](buzz://channel/beta)\n- [ ] Legacy · Assignee: John\n\n## Decisions\nKeep these too.\n";
  let head = app.sign({
    kind: 40100,
    content: original,
    tags: [["h", "alpha"]],
    created_at: 1700000000,
  });
  const writes = [];
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.every((f) => f.kinds?.includes(40100) || f.ids?.includes(head.id))
    )
      return route.fulfill({ json: [head] });
    return route.continue();
  });
  await page.route("**/api/relay/primary/sign", async (route) => {
    const template = route.request().postDataJSON();
    expect(template.kind).toBe(40100);
    await route.fulfill({ json: app.sign(template) });
  });
  await page.route("**/api/relay/primary/publish", async (route) => {
    const event = route.request().postDataJSON();
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(40100);
    expect(event.pubkey).toBe(app.viewer);
    expect(event.tags).toContainEqual(["h", "alpha"]);
    head = event;
    writes.push(event);
    await route.fulfill({ json: { accepted: true, event_id: event.id } });
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const plugins = async () => {
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
  };
  const messages = async () => {
    await openPage(page, "Messages");
    await expect(
      page
        .getByRole("article", { name: "Conversation" })
        .getByRole("tab", { name: "Alpha", exact: true }),
    ).toBeVisible();
  };
  await page.goto(app.origin);
  await messages();
  const launcher = button("Toggle channel todos");
  await expect(launcher).toHaveCount(0);
  await plugins();
  const enabled = pluginAction(page, "Todos");
  await expect(enabled).toHaveAccessibleName(/^Enable /);
  await enabled.click();
  await expect(enabled).toHaveAccessibleName(/^Disable /);
  await closeSettings(page);
  await messages();
  await launcher.click();
  const drawer = page.getByRole("region", {
    name: "Todos panel",
    exact: true,
  });
  const input = drawer.getByRole("textbox", { name: "New todo" });
  const nested = drawer.getByRole("checkbox", { name: "Review", exact: true });
  await expect(nested).toBeVisible();
  const first = drawer.getByRole("checkbox", { name: "First", exact: true });
  const build = drawer.getByRole("checkbox", { name: "Build", exact: true });
  // The drawer can still be moving. Compare indentation in one layout sample.
  const positions = await page.evaluate(
    (elements) => elements.map((element) => element.getBoundingClientRect().x),
    [
      await first.elementHandle(),
      await build.elementHandle(),
      await nested.elementHandle(),
    ],
  );
  expect(positions[1]).toBeGreaterThan(positions[0]);
  expect(positions[2]).toBeGreaterThan(positions[1]);
  await expect(drawer.getByText("First / Build", { exact: true })).toHaveCount(
    0,
  );
  await drawer
    .getByRole("button", { name: "Collapse First", exact: true })
    .click();
  await expect(nested).toBeHidden();
  await drawer
    .getByRole("button", { name: "Expand First", exact: true })
    .click();
  await expect(nested).toBeVisible();
  await expect(
    drawer.getByRole("link", { name: "guide", exact: true }),
  ).toHaveAttribute("href", "https://example.com/");
  await expect(drawer.locator("strong", { hasText: "Read" })).toBeVisible();
  await expect(
    drawer.getByRole("button", {
      name: "Assignee for Legacy: John",
      exact: true,
    }),
  ).toHaveAttribute(
    "aria-description",
    "John (from Canvas; choose a member to link)",
  );
  await input.fill("Ship it");
  await input.press("Enter");
  await expect(drawer.getByRole("status")).toHaveText("Saved in Canvas");
  const todo = drawer.getByRole("checkbox", { name: "Ship it", exact: true });
  await todo.focus();
  await todo.press("Space");
  await expect(todo).toBeChecked();
  await expect(drawer.getByRole("status")).toHaveText("Saved in Canvas");
  await expect(todo).toBeFocused();
  const assignee = drawer
    .getByRole("group", { name: "Assignee for Ship it", exact: true })
    .getByRole("button");
  await assignee.click();
  await page.getByRole("menuitemradio", { name: /Fixture Reader/ }).click();
  await expect(
    drawer.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await expect(drawer.getByRole("status")).toHaveText("Saved in Canvas");
  expect(writes).toHaveLength(3);
  expect(head.content).toBe(
    original.replace(
      "## Todos",
      `## Todos\n\n- [x] Ship it · Assignee: [Fixture Reader](nostr:${npubEncode(app.viewer)})\n`,
    ),
  );
  const beforeChildEdit = head.content;
  const child = drawer.getByRole("checkbox", { name: "Build", exact: true });
  await child.focus();
  await child.press("Space");
  await expect(child).toBeChecked();
  await expect(drawer.getByRole("status")).toHaveText("Saved in Canvas");
  expect(writes).toHaveLength(4);
  expect(head.content).toBe(beforeChildEdit.replace("[ ] Build", "[x] Build"));
  const conversation = await page
    .getByRole("article", { name: "Conversation", exact: true })
    .boundingBox();
  const bounds = await drawer.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(conversation.x + conversation.width);
  expect(Math.abs(bounds.y - conversation.y)).toBeLessThan(2);
  const dock = page
    .getByRole("region", { name: "Channels", exact: true })
    .locator("[data-panel-dock]:not([hidden])");
  await drawer.getByRole("button", { name: "Hide todos" }).click();
  // The closing dock still owns a grid column. Wait for its removal before
  // clicking the launcher, which moves when the conversation expands.
  await expect(dock).toHaveCount(0);
  await launcher.click();
  await expect(child).toBeChecked();
  await expect(assignee).toHaveAttribute("aria-description", /Fixture Reader/);
  await assignee.click();
  await page
    .getByRole("menuitemradio", { name: "Unassigned", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(assignee).toBeFocused();
  await assignee.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(launcher).toBeFocused();
  await expect(dock).toHaveCount(0);
  await launcher.click();
  await expect(assignee).toHaveAttribute("aria-description", /Fixture Reader/);
  const expectCompactRow = async () => {
    // Reopening and resizing animate both the dock and its parent grid.
    await dock.evaluate(async (element) => {
      await Promise.all(
        [
          ...element.getAnimations(),
          ...element.parentElement.getAnimations(),
        ].map((animation) => animation.finished),
      );
    });
    const row = assignee.locator("xpath=ancestor::li");
    const label = row.getByRole("checkbox").locator("..");
    // Opening the dock moves every row. Observe the completed animation, then
    // sample all geometry in one browser task so coordinates share a frame.
    await dock.evaluate(async (element) => {
      await Promise.all(
        [element, element.parentElement]
          .flatMap((node) => node?.getAnimations() ?? [])
          .map((animation) => animation.finished),
      );
    });
    const status = row.getByRole("button", { name: "Status for Ship it" });
    const { rowBounds, labelBounds, triggerBounds, statusBounds, fits } =
      await row.evaluate(
        (element, { label, trigger, status }) => ({
          rowBounds: element.getBoundingClientRect().toJSON(),
          labelBounds: label.getBoundingClientRect().toJSON(),
          triggerBounds: trigger.getBoundingClientRect().toJSON(),
          statusBounds: status.getBoundingClientRect().toJSON(),
          fits: element.scrollWidth <= element.clientWidth,
        }),
        {
          label: await label.elementHandle(),
          trigger: await assignee.elementHandle(),
          status: await status.elementHandle(),
        },
      );
    expect(triggerBounds.x).toBeGreaterThanOrEqual(
      labelBounds.x + labelBounds.width,
    );
    expect(triggerBounds.y + triggerBounds.height / 2).toBeGreaterThanOrEqual(
      labelBounds.y,
    );
    expect(triggerBounds.y + triggerBounds.height / 2).toBeLessThanOrEqual(
      labelBounds.y + labelBounds.height,
    );
    expect(triggerBounds.x).toBeGreaterThanOrEqual(
      statusBounds.x + statusBounds.width,
    );
    expect(triggerBounds.x + triggerBounds.width).toBeLessThanOrEqual(
      rowBounds.x + rowBounds.width + 1,
    );
    expect(fits).toBe(true);
    await expect(assignee).toHaveAttribute("data-size", "sm");
    await expect(assignee).toContainText("Fixture Reader");
  };
  // Channel-specific drawers stay off other pages, but returning to the same
  // channel can reopen its Canvas-backed content with a live launcher.
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const pages = sidebar.getByRole("navigation", { name: "Pages" });
  for (const destination of ["Activity", "Bestie"]) {
    await pages.getByRole("button", { name: destination, exact: true }).click();
    await expect(
      page.getByRole("region", { name: destination, exact: true }),
    ).toBeVisible();
    await expect(drawer).toHaveCount(0);
    await expect(launcher).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    await launcher.click();
    await expect(drawer).toBeVisible();
    await expect(todo).toBeChecked();
    await expect(assignee).toHaveAttribute(
      "aria-description",
      /Fixture Reader/,
    );
  }
  await expectCompactRow();
  await page.screenshot({
    path: test.info().outputPath("todos-light-wide.png"),
  });
  // Existing side-panel responsive placement with enlarged text.
  await page.setViewportSize({ width: 600, height: 800 });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
    document.documentElement.style.setProperty("--buzz-text-scale", "1.25");
  });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Add", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    drawer.getByRole("checkbox", { name: "First", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    drawer.getByRole("button", { name: "Refresh" }),
  ).toBeInViewport();
  await expect(
    drawer.getByRole("button", { name: "About todos" }),
  ).toBeInViewport();
  expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await expectCompactRow();
  await page.screenshot({
    path: test.info().outputPath("todos-dark-narrow.png"),
  });
  // Removing the tab picker leaves the ordinary tool launcher available.
  await page.setViewportSize({ width: 1440, height: 950 });
  await drawer.getByRole("button", { name: "Hide todos", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await launcher.click();
  await expect(
    drawer.getByRole("checkbox", { name: "Ship it", exact: true }),
  ).toBeChecked();
  await drawer.getByRole("link", { name: "Beta", exact: true }).click();
  await expect(
    page
      .getByRole("article", { name: "Conversation" })
      .getByRole("tab", { name: "Beta", exact: true }),
  ).toBeVisible();
  await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(
    page
      .getByRole("article", { name: "Conversation" })
      .getByRole("tab", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await plugins();
  await enabled.click();
  await expect(enabled).toHaveAccessibleName(/^Enable /);
  await closeSettings(page);
  await messages();
  await expect(launcher).toHaveCount(0);
  await expect(drawer).toHaveCount(0);
  await button("Channel actions").click();
  await page
    .getByRole("menuitem", { name: "View canvas", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Saved Canvas" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  const canvas = page.getByRole("textbox", {
    name: "Canvas Markdown",
    exact: true,
  });
  await expect(canvas).toHaveValue(head.content);
  await expect(canvas).toBeEditable();
});
