import { pluginAction } from "./plugin-settings.mjs";
import {
  activate,
  closeSettings,
  openPage,
  pageChoice,
  pageChoices,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { frames } from "./timeline.mjs";
import { npubEncode } from "nostr-tools/nip19";
import { verifyEvent } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { animationsSettled } from "./animations.mjs";

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
        .getByRole("button", { name: "Manage members of Alpha", exact: true }),
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
    await Promise.all([
      animationsSettled(dock),
      animationsSettled(dock.locator("..")),
    ]);
    const row = assignee.locator("xpath=ancestor::li");
    const label = row.getByRole("checkbox").locator("..");
    // Opening the dock moves every row. Observe the completed animation, then
    // sample all geometry in one browser task so coordinates share a frame.
    await Promise.all([
      animationsSettled(dock),
      animationsSettled(dock.locator("..")),
    ]);
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
  // Channel-specific drawers stay off other pages; returning to the same
  // channel shows the panel left open there, with a live launcher.
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  for (const destination of ["Activity", "Bestie"]) {
    if (destination === "Bestie") {
      const choices = await pageChoices(page, "Bestie");
      await pageChoice(choices, "Create an agent — Bestie").click();
      await expect(
        page.getByRole("dialog", { name: "Search Buzz" }),
      ).toBeHidden();
    } else await openPage(page, destination);
    await expect(
      page.getByRole("region", { name: destination, exact: true }),
    ).toBeVisible();
    await expect(drawer).toHaveCount(0);
    await expect(launcher).toHaveCount(0);
    await openPage(page, "Messages");
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(drawer).toBeVisible();
    await expect(launcher).toHaveAttribute("aria-expanded", "true");
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
      .getByRole("button", { name: "Manage members of Beta", exact: true }),
  ).toBeVisible();
  await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(
    page
      .getByRole("article", { name: "Conversation" })
      .getByRole("button", { name: "Manage members of Alpha", exact: true }),
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

// Browser-only boundary: Back and Close all tabs move through native history
// visits. Back restores the channel visit's own closed pane, and Close all
// tabs' return to the channel visit must keep the launcher's side panel, or
// keep it hidden in a closed pane even when that visit saved an open one.
// jsdom page tests don't route visits through navigation.
test("Todos isn't a tab: Close all tabs keeps it, and its launcher tracks the pane", async ({
  page,
  app,
}) => {
  // Runs after the file's Bestie default, so Todos is the opted-in plugin.
  await page.addInitScript(() =>
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({ version: 2, enabled: { "buzz.todos": true } }),
    ),
  );
  const history = app.histories.get("primary/alpha");
  const at = history.at(-1).created_at + 60;
  const root = app.sign({
    kind: 9,
    created_at: at,
    tags: [["h", "alpha"]],
    content: "Release checklist",
  });
  history.push(
    root,
    app.sign({
      kind: 9,
      created_at: at + 60,
      tags: [
        ["h", "alpha"],
        ["e", root.id, "", "reply"],
      ],
      content: "Looks good",
    }),
  );
  const second = app.sign({
    kind: 9,
    created_at: at + 120,
    tags: [["h", "alpha"]],
    content: "Retro notes",
  });
  history.push(
    second,
    app.sign({
      kind: 9,
      created_at: at + 180,
      tags: [
        ["h", "alpha"],
        ["e", second.id, "", "reply"],
      ],
      content: "Added",
    }),
  );
  const head = app.sign({
    kind: 40100,
    content: "## Todos\n\n- [ ] First\n",
    tags: [["h", "alpha"]],
    created_at: 1700000000,
  });
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.every((f) => f.kinds?.includes(40100) || f.ids?.includes(head.id))
    )
      return route.fulfill({ json: [head] });
    return route.continue();
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  // The reply chip comes only from the relay's live thread summary.
  app.threadSummary(root.id, [app.viewer], 1);
  app.threadSummary(second.id, [app.viewer], 1);
  const launcher = page.getByRole("button", {
    name: "Toggle channel todos",
    exact: true,
  });
  const todos = page.getByRole("region", {
    name: "Todos panel",
    exact: true,
  });
  await launcher.click();
  await expect(
    todos.getByRole("checkbox", { name: "First", exact: true }),
  ).toBeVisible();
  const viewThreadOf = (id) =>
    page
      .locator(`[data-channel-timeline="alpha"] [data-message-id="${id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const viewThread = viewThreadOf(root.id);
  await activate(viewThread);
  const thread = page.locator(
    '[data-panel-workspace] [role="tab"][data-tab-value^="thread:"]',
  );
  await expect(thread).toHaveAttribute("aria-selected", "true");
  await expect(todos).toBeVisible();
  // Closing the pane keeps Todos for its return; the launcher says it's hidden.
  await page
    .getByRole("button", { name: "Toggle tab pane", expanded: true })
    .click();
  await expect(todos).toBeHidden();
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  await launcher.click();
  await expect(todos).toBeVisible();
  await expect(thread).toBeVisible();
  await thread.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close all tabs", exact: true })
    .click();
  await expect(thread).toHaveCount(0);
  await expect(todos).toBeVisible();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  // Back restores the channel visit's saved pane: open, so Todos shows with
  // the retained thread tab. Hiding the pane there saves it closed, so the
  // next Back hides Todos with the launcher unpressed; one press shows it
  // with the thread tab, and Close all tabs from there keeps it.
  await activate(viewThread);
  await expect(thread).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(todos).toBeVisible();
  await expect(thread).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle tab pane", expanded: true })
    .click();
  await expect(todos).toBeHidden();
  await activate(viewThread);
  await expect(thread).toHaveAttribute("aria-selected", "true");
  await expect(todos).toBeVisible();
  await page.goBack();
  await expect(todos).toBeHidden();
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  await launcher.click();
  await expect(todos).toBeVisible();
  await expect(thread).toBeVisible();
  await thread.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close all tabs", exact: true })
    .click();
  await expect(thread).toHaveCount(0);
  await expect(todos).toBeVisible();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  // From a thread visit in a closed pane, ⌘⇧W returns to the channel without
  // revealing Todos; one press shows it.
  await activate(viewThread);
  await expect(thread).toHaveAttribute("aria-selected", "true");
  const threadVisit = page.url();
  await page
    .getByRole("button", { name: "Toggle tab pane", expanded: true })
    .click();
  await expect(todos).toBeHidden();
  expect(
    await page.evaluate(() => {
      const event = new Event("buzz:close-all-tabs", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await expect(thread).toHaveCount(0);
  // The return lands after the address changes.
  await expect.poll(() => page.url()).not.toBe(threadVisit);
  await frames(page);
  await expect(todos).toBeHidden();
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  await launcher.click();
  await expect(todos).toBeVisible();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  // A channel visit showing Todos beside a thread retained from Back saves
  // an open pane when a second thread opens. Hiding the pane and closing all
  // tabs still returns there with Todos hidden, over that saved open pane.
  await activate(viewThread);
  await expect(thread).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(todos).toBeVisible();
  await expect(thread).toBeVisible();
  await activate(viewThreadOf(second.id));
  await expect(thread).toHaveCount(2);
  const secondVisit = page.url();
  await page
    .getByRole("button", { name: "Toggle tab pane", expanded: true })
    .click();
  await expect(todos).toBeHidden();
  expect(
    await page.evaluate(() => {
      const event = new Event("buzz:close-all-tabs", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await expect(thread).toHaveCount(0);
  await expect.poll(() => page.url()).not.toBe(secondVisit);
  await frames(page);
  await expect(todos).toBeHidden();
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  await launcher.click();
  await expect(todos).toBeVisible();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
});
