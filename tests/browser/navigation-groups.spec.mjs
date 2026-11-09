import { openChannelDetails } from "./channel-details.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { holdReadingFocus } from "./reading.mjs";

test.use({
  enabledPlugins: ["buzz.workflows"],
  productionBroker: true,
  savedSidebar: true,
  developmentReact: true,
  historyCounts: { alpha: 1, beta: 1 },
});

async function openMove(page, row, channelName = "Beta") {
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const parent = page.getByRole("menuitem", {
    name: "Move channel",
    exact: true,
  });
  await expect(parent).toBeVisible();
  await parent.focus();
  await page.keyboard.press("ArrowRight");
  const menu = page.getByRole("menu", {
    name: `Move ${channelName} to section`,
    exact: true,
  });
  await expect(menu).toBeVisible();
  return menu;
}
const rowIn = (page, section) =>
  page.locator(`[data-sidebar-section="${section}"] [data-channel-id="beta"]`);
const sidebar = (page) =>
  page.getByRole("navigation", { name: "Subscribed channels" });
// Hold a real pointer drag over a section header; the caller releases it.
async function pull(page, row, section) {
  await row.hover();
  const from = await row.boundingBox();
  const destination = page.locator(
    `[data-sidebar-section="${section}"] summary`,
  );
  const to = await destination.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 8,
  });
  // Crossing the creation gap can expand it and shift this header. Follow the
  // actual destination after its layout settles rather than its old centre.
  // The drag overlay owns pointer events, so use the stable layout check rather
  // than hover's hit-target check, then move the real pointer to that rectangle.
  await destination.scrollIntoViewIfNeeded();
  const current = await destination.boundingBox();
  await page.mouse.move(
    current.x + current.width / 2,
    current.y + current.height / 2,
  );
}
// No saving UI is a completion signal: wait for the final confirmed Star command
// of each move (including no-op Star writes), not merely relay publication.
const confirmations = new WeakMap();
test.beforeEach(async ({ page }) => {
  const state = { completed: 0, expected: 0 };
  confirmations.set(page, state);
  page.on("requestfinished", async (request) => {
    if (
      new URL(request.url()).pathname.endsWith("/sidebar-star") &&
      (await request.response())?.ok()
    )
      state.completed++;
  });
});
async function saved(page, app, publications, moves = 1) {
  const state = confirmations.get(page);
  state.expected += moves;
  await expect.poll(() => state.completed).toBe(state.expected);
  await expect
    .poll(() => app.report.sidebarPublications?.length ?? 0)
    .toBe(publications);
  await expect(
    page.getByText("Saving sidebar changes…", { exact: true }),
  ).toHaveCount(0);
}
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Browser-owned keyboard nesting, portal geometry, and exclusive row/focus relocation.
// Record ordering, concurrency, bounds and cancellation matrices stay in Vitest.
test("row menu moves and removes a channel optimistically, retaining keyboard navigation and confirmed reload", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = rowIn(page, "group:work");
  await expect(beta).toBeVisible();
  await beta.click({ button: "right" });
  const actions = page.getByRole("menu", { name: "Actions for Beta" });
  await expect(
    actions.getByRole("menuitem", { name: "Move channel", exact: true }),
  ).toBeVisible();
  await expect(
    actions.getByRole("menuitem", { name: "Mute", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const menu = page.getByRole("menu", {
    name: "Move Beta to section",
    exact: true,
  });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitemradio", { name: "Starred", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("menuitem", { name: "Move channel", exact: true }),
  ).toBeFocused();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(
    menu.getByRole("menuitemradio", { name: "Work" }),
  ).toHaveAttribute("aria-checked", "true");
  // Checked state renders before Base UI transfers focus into the reopened
  // submenu. Establish keyboard ownership before sending its next command.
  await expect(
    menu.getByRole("menuitemradio", { name: "Starred", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Remove from Work" }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    menu.getByRole("menuitemradio", { name: "Starred", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Work" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Create new…" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(rowIn(page, "channels")).toBeFocused();
  await expect(beta).toHaveCount(0);
  await saved(page, app, 1);
  expect(app.report.sidebarPublications[0].blob.assignments).toEqual({});
  await openMove(page, rowIn(page, "channels"));
  await menu.getByRole("menuitemradio", { name: "Work" }).click();
  await expect(beta).toBeFocused();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
  await saved(page, app, 2);
  expect(app.report.sidebarPublications[1].blob.assignments).toEqual({
    beta: "work",
  });
  await page.reload();
  await expect(beta).toBeVisible();

  // Clicking the checked group is the same remove intent, including rollback.
  await openMove(page, beta);
  const selected = menu.getByRole("menuitemradio", {
    name: "Work",
    exact: true,
  });
  await expect(selected).toHaveAttribute("aria-checked", "true");
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-assignment", async (route) => {
    started.resolve();
    await held.promise;
    app.report.sidebarAssignmentFailures ??= [];
    app.report.sidebarAssignmentFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Group removal failed; retry" }),
    });
  });
  try {
    await selected.click();
    await expect(rowIn(page, "channels")).toBeFocused();
    await started.promise;
    await expect(menu).toHaveCount(0);
    await expect(beta).toHaveCount(0);
    await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
      1,
    );
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(beta).toBeVisible();
  await expect(rowIn(page, "channels")).toHaveCount(0);
  await page.unroute("**/sidebar-assignment");
  await error.getByRole("button", { name: "Retry move" }).click();
  await expect(rowIn(page, "channels")).toBeFocused();
  await expect(error).toHaveCount(0);
  await saved(page, app, 3);
  expect(app.report.sidebarPublications.at(-1).blob.assignments).toEqual({});
  await page.reload();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(beta).toHaveCount(0);

  // The built sidebar and broker share one queue: a pending section sort must
  // not conceal an optimistic Move, and both must survive confirmed reload.
  // Open from the keyboard, like openMove. The menu opens on mousedown and a
  // mouseup off the trigger cancels it, so a pointer click races startup
  // notices (Loading conversations…) that shift the sidebar after a reload.
  // Pointer opening is covered by navigation-sorting.
  const openSort = async () => {
    await page
      .getByRole("button", { name: "More actions for Channels" })
      .focus();
    await page.keyboard.press("Enter");
    // Opening during a preference refresh can skip the disabled Create item.
    // Establish keyboard ownership before moving to Sort in either case.
    await expect(
      page
        .getByRole("menu", { name: "More actions for Channels", exact: true })
        .locator('[role="menuitem"][data-highlighted]'),
    ).toBeVisible();
    const sort = page.getByRole("menuitem", { name: "Sort", exact: true });
    await sort.focus();
    await page.keyboard.press("ArrowRight");
    return page.getByRole("menu", { name: "Sort Channels", exact: true });
  };
  const sortHeld = gate(),
    sortStarted = gate();
  await page.route("**/sidebar-sort", async (route) => {
    sortStarted.resolve();
    await sortHeld.promise;
    await route.continue();
  });
  let sorted, moved;
  try {
    const sortMenu = await openSort();
    await sortMenu.getByRole("menuitemradio", { name: "Recent" }).click();
    await sortStarted.promise;
    const moveMenu = await openMove(page, rowIn(page, "channels"));
    await moveMenu
      .getByRole("menuitemradio", { name: "Work", exact: true })
      .click();
    await expect(beta).toBeFocused();
    await expect(rowIn(page, "channels")).toHaveCount(0);
    const pendingSort = await openSort();
    await expect(
      pendingSort.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  } finally {
    // Both writes are held behind the sort gate. Start their response waits
    // immediately before release, not before the pending UI interactions.
    sorted = page.waitForResponse("**/sidebar-sort");
    moved = page.waitForResponse("**/sidebar-star");
    sortHeld.resolve();
  }
  for (const response of [await sorted, await moved]) {
    expect(response.ok()).toBe(true);
    await response.finished();
  }
  expect(
    app.report.sidebarPublications.find(
      ({ coordinate }) => coordinate === "channel-sort",
    ).blob.groups,
  ).toEqual({ channels: "recent" });
  await page.unroute("**/sidebar-sort");
  await page.reload();
  await expect(beta).toBeVisible();
  const restoredSort = await openSort();
  await expect(
    restoredSort.getByRole("menuitemradio", { name: "Recent" }),
  ).toHaveAttribute("aria-checked", "true");
});

// A real pointer owns the activation distance, hit testing and click suppression;
// the saved move itself is the row menu's.
test("dragging a channel between a group and Channels saves, reloads, and rolls back like the row menu", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = rowIn(page, "group:work");
  const ungrouped = rowIn(page, "channels");
  async function drag(row, section) {
    await pull(page, row, section);
    await expect(
      page.locator(`[data-sidebar-section="${section}"][data-drop-target]`),
    ).toBeVisible();
    await page.mouse.up();
  }
  await expect(beta).toBeVisible();

  await drag(beta, "channels");
  await expect(ungrouped).toBeFocused();
  await expect(beta).toHaveCount(0);
  await saved(page, app, 1);
  expect(app.report.sidebarPublications[0].blob.assignments).toEqual({});

  await drag(ungrouped, "group:work");
  await expect(beta).toBeFocused();
  await expect(ungrouped).toHaveCount(0);
  await saved(page, app, 2);
  expect(app.report.sidebarPublications[1].blob.assignments).toEqual({
    beta: "work",
  });
  await page.reload();
  await expect(beta).toBeVisible();
  // Like the Move menu, dragging waits for the confirmed preference read.
  await expect(
    page.getByRole("complementary", { name: "Sidebar", exact: true }),
  ).not.toHaveAttribute("aria-busy");

  // Dropping back on the row's own section is not a move.
  await pull(page, beta, "group:work");
  await expect(page.locator("[data-channel-dragging]")).toBeVisible();
  await expect(page.locator("[data-drop-target]")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator("[data-channel-dragging]")).toHaveCount(0);
  await expect(beta).toBeVisible();
  expect(app.report.sidebarPublications).toHaveLength(2);

  await page.route("**/sidebar-assignment", async (route) => {
    app.report.sidebarAssignmentFailures ??= [];
    app.report.sidebarAssignmentFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Group removal failed; retry" }),
    });
  });
  await drag(beta, "channels");
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(beta).toBeVisible();
  await expect(ungrouped).toHaveCount(0);
  await page.unroute("**/sidebar-assignment");
  await error.getByRole("button", { name: "Retry move" }).click();
  await expect(ungrouped).toBeFocused();
  await saved(page, app, 3);
  await page.reload();
  await expect(ungrouped).toBeVisible();
  await expect(beta).toHaveCount(0);
});

// Pointer hit testing, drag-time section visibility and focus relocation need a layout engine.
test("dragging keeps empty Starred hidden and visible Starred moves save and reload", async ({
  page,
  app,
}) => {
  await open(page, app);
  const stars = page.locator('[data-sidebar-section="starred"]');
  const beta = rowIn(page, "group:work");
  const starred = rowIn(page, "starred");
  const alpha = stars.locator('[data-channel-id="alpha"]');
  const menu = await openMove(page, alpha, "Alpha");
  await menu.getByRole("menuitem", { name: "Remove from Starred" }).click();
  await saved(page, app, 1);
  await expect(stars).toHaveCount(0);

  // Starting a drag must not reveal a hidden empty Starred section.
  await pull(page, beta, "channels");
  await expect(page.locator("[data-channel-dragging]")).toBeVisible();
  await expect(stars).toHaveCount(0);
  // Cancelling never publishes a move.
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("[data-channel-dragging]")).toHaveCount(0);
  await expect(stars).toHaveCount(0);
  expect(app.report.sidebarPublications).toHaveLength(1);

  // The row menu can star the first channel; only an already-visible section
  // accepts a drag. Keep Alpha starred while moving Beta into and out of it.
  const alphaInChannels = page.locator(
    '[data-sidebar-section="channels"] [data-channel-id="alpha"]',
  );
  await openMove(page, alphaInChannels, "Alpha");
  await menu
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await saved(page, app, 2);
  await expect(alpha).toBeVisible();

  async function drag(row, section) {
    await pull(page, row, section);
    await expect(
      page.locator(`[data-sidebar-section="${section}"][data-drop-target]`),
    ).toBeVisible();
    await page.mouse.up();
  }

  await drag(beta, "starred");
  await expect(starred).toBeFocused();
  await expect(beta).toHaveCount(0);
  await saved(page, app, 3);
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { beta: { starred: true } } },
  });
  await page.reload();
  await expect(starred).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Sidebar", exact: true }),
  ).not.toHaveAttribute("aria-busy");
  await pull(page, starred, "starred");
  await expect(page.locator("[data-channel-dragging]")).toBeVisible();
  await expect(page.locator("[data-drop-target]")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator("[data-channel-dragging]")).toHaveCount(0);
  expect(app.report.sidebarPublications).toHaveLength(3);

  await drag(starred, "group:work");
  await expect(beta).toBeFocused();
  await saved(page, app, 4); // Assignment already Work; only unstar publishes.
  await expect(alpha).toBeVisible();
  await drag(beta, "starred");
  await expect(starred).toBeFocused();
  await saved(page, app, 5);
  await drag(starred, "channels");
  await expect(rowIn(page, "channels")).toBeFocused();
  await saved(page, app, 7);
  expect(app.report.sidebarPublications.at(-2)).toMatchObject({
    coordinate: "channel-sections",
    blob: { assignments: {} },
  });
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { beta: { starred: false } } },
  });
  await page.reload();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(beta).toHaveCount(0);
  await expect(alpha).toBeVisible();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
});

test("a rejected drag into collapsed Starred rolls back and retries the same move", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = rowIn(page, "group:work");
  const starred = rowIn(page, "starred");
  await page.locator('[data-sidebar-section="starred"] summary').click();
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-star", async (route) => {
    started.resolve();
    await held.promise;
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  try {
    await pull(page, beta, "starred");
    await expect(
      page.locator('[data-sidebar-section="starred"][data-drop-target]'),
    ).toBeVisible();
    await page.mouse.up();
    await started.promise;
    await expect(starred).toBeFocused();
    await expect(beta).toHaveCount(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(beta).toBeVisible();
  await expect(starred).toHaveCount(0);
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await page.unroute("**/sidebar-star");
  await error.getByRole("button", { name: "Retry move" }).click();
  await expect(starred).toBeFocused();
  await saved(page, app, 1);
  await page.reload();
  await expect(starred).toBeVisible();
  await expect(beta).toHaveCount(0);
});

test("optimistic Star moves close the menu before the write, roll back with visible retry, and remove to Channels after reload", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const beta = rowIn(page, "group:work");
  const starred = rowIn(page, "starred");
  await expect(beta).toBeVisible();
  await page.locator('[data-sidebar-section="starred"] summary').click();
  const menu = await openMove(page, beta);
  await expect(menu).toHaveCSS("opacity", "1");
  await expect(
    page.getByRole("menu", { name: "Actions for Beta", exact: true }),
  ).toHaveCSS("opacity", "1");
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({
    path: testInfo.outputPath("move-channel-menu.png"),
    clip: { x: 10, y: 50, width: 470, height: 470 },
  });
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("menuitem", { name: "Move channel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
  await page.keyboard.press("ContextMenu");
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-star", async (route) => {
    started.resolve();
    await held.promise;
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  try {
    await menu
      .getByRole("menuitemradio", { name: "Starred", exact: true })
      .click();
    await started.promise;
    await expect(menu).toHaveCount(0);
    await expect(starred).toBeFocused();
    await expect(beta).toHaveCount(0);
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(beta).toBeVisible();
  await expect(starred).toHaveCount(0);
  await page.unroute("**/sidebar-star");
  // Failures live in the session, not in a menu or mounted Messages page.
  await openPage(page, "Workflows");
  await openPage(page, "Messages");
  await error.getByRole("button", { name: "Retry move" }).click();
  await expect(starred).toBeFocused();
  await expect(error).toHaveCount(0);
  await saved(page, app, 1);
  await openMove(page, starred);
  await menu
    .getByRole("menuitem", { name: "Remove from Starred", exact: true })
    .click();
  await expect(rowIn(page, "channels")).toBeFocused();
  await saved(page, app, 3);
  expect(
    app.report.sidebarPublications.slice(1).map(({ coordinate }) => coordinate),
  ).toEqual(["channel-sections", "channel-stars"]);
  await page.reload();
  await expect(
    page.locator('[data-sidebar-section="starred"] [data-channel-id="alpha"]'),
  ).toBeVisible();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(beta).toHaveCount(0);
  await openMove(page, rowIn(page, "channels"));
  await menu
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await expect(starred).toBeFocused();
  await saved(page, app, 4);
  await openMove(page, starred);
  await menu.getByRole("menuitemradio", { name: "Work", exact: true }).click();
  await expect(beta).toBeFocused();
  await saved(page, app, 6);
  expect(app.report.sidebarPublications.at(-2)).toMatchObject({
    coordinate: "channel-sections",
    blob: { assignments: { beta: "work" } },
  });
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { beta: { starred: false } } },
  });
  await openMove(page, beta);
  await menu
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await expect(starred).toBeFocused();
  await saved(page, app, 7);
  await openMove(page, starred);
  const selected = menu.getByRole("menuitemradio", {
    name: "Starred",
    exact: true,
  });
  await expect(selected).toHaveAttribute("aria-checked", "true");
  await selected.focus();
  await page.keyboard.press("Enter");
  await expect(rowIn(page, "channels")).toBeFocused();
  await expect(menu).toHaveCount(0);
  await expect(starred).toHaveCount(0);
  await saved(page, app, 9);
  expect(app.report.sidebarPublications.at(-2)).toMatchObject({
    coordinate: "channel-sections",
    blob: { assignments: {} },
  });
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { beta: { starred: false } } },
  });
  await page.reload();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
  await expect(beta).toHaveCount(0); // Never restore the remembered Work assignment.
});

// Native keyboard activation and focus after disclosure/roster changes need a browser.
test("dismissing a failed move restores keyboard focus to its placement or a surviving row", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = rowIn(page, "group:work");
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move" });
  await page.route("**/sidebar-star", async (route) => {
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  const failMove = async () => {
    const menu = await openMove(page, beta);
    await menu
      .getByRole("menuitemradio", { name: "Starred", exact: true })
      .click();
    await expect(error).toContainText("Relay request failed (502)");
    // The alert arrives with the rollback, but the optimistic Starred copy of
    // the row stays laid out while it fades out, and its removal moves every
    // section below it. Wait for the exit, or a press on Work's header can
    // finish on the row that slid under it, which is no click.
    await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
      1,
    );
    await expect(beta).toBeVisible();
  };
  const dismiss = async () => {
    await error.getByRole("button", { name: "Dismiss", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(error).toHaveCount(0);
  };
  await failMove();
  await page.locator('[data-sidebar-section="group:work"] summary').click();
  await expect(beta).toBeHidden();
  await dismiss();
  await expect(beta).toBeFocused();
  await expect(beta).toBeVisible();

  await failMove();
  // Upstream roster omission, not direct client-state injection.
  app.omitChannel("beta");
  await openChannelDetails(page);
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh channels", exact: true })
    .click();
  await expect(beta).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await dismiss();
  await expect(
    sidebar(page).locator('[data-channel-id="alpha"]'),
  ).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
});

// Menu → native dialog → optimistic new-section focus must be checked in browsers.
test("Create new supports cancel, moves before publication, and retries the same section after partial failure", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const beta = rowIn(page, "group:work");
  await expect(beta).toBeVisible();
  await openMove(page, beta);
  await page.getByRole("menuitem", { name: "Create new…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to new section" });
  const field = dialog.getByRole("textbox", { name: "Section name" });
  await expect(dialog).not.toHaveAttribute("aria-describedby");
  await expect(dialog.locator("label")).toHaveCount(0);
  await expect(field).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Create and move" }),
  ).toBeDisabled();
  await field.fill("Cancelled");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(beta).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await openMove(page, beta);
  await page
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await expect(rowIn(page, "starred")).toBeFocused();
  await saved(page, app, 1);
  await openMove(page, rowIn(page, "starred"));
  await page.getByRole("menuitem", { name: "Create new…" }).click();
  await expect(field).toBeFocused();
  await field.fill("Launch");
  await dialog.screenshot({ path: testInfo.outputPath("create-section.png") });
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-assignment", async (route) => {
    started.resolve();
    await held.promise;
    await route.continue();
  });
  await page.route("**/sidebar-star", async (route) => {
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  let sectionId;
  try {
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await started.promise;
    await expect(dialog).toHaveCount(0);
    const createdGroup = sidebar(page)
      .locator('[data-sidebar-section^="group:"]')
      .filter({ has: page.locator("summary", { hasText: /^Launch$/ }) });
    await expect(
      createdGroup.locator('[data-channel-id="beta"]'),
    ).toBeFocused();
    sectionId = (await createdGroup.getAttribute("data-sidebar-section")).slice(
      "group:".length,
    );
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    expect(app.report.sidebarPublications).toHaveLength(1); // No section write yet.
    await expect(rowIn(page, "starred")).toHaveCount(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(rowIn(page, "starred")).toBeVisible();
  await expect(rowIn(page, `group:${sectionId}`)).toHaveCount(0);
  await page.unroute("**/sidebar-star");
  await page.unroute("**/sidebar-assignment");
  await error.getByRole("button", { name: "Retry move" }).click();
  const destination = rowIn(page, `group:${sectionId}`);
  await expect(destination).toBeFocused();
  await saved(page, app, 3);
  expect(
    app.report.sidebarPublications.filter(
      ({ coordinate }) => coordinate === "channel-sections",
    ),
  ).toHaveLength(1);
  await page.reload();
  await expect(destination).toBeVisible();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
  await sidebar(page).screenshot({
    path: testInfo.outputPath("created-section-reloaded.png"),
  });

  // A saved-group row can create another group directly; while that save is
  // held, the moved row can immediately move again to a different saved group.
  const nextHeld = gate(),
    nextStarted = gate();
  await page.route("**/sidebar-assignment", async (route) => {
    nextStarted.resolve();
    await nextHeld.promise;
    await route.continue();
  });
  let followup;
  try {
    await openMove(page, destination);
    await page.getByRole("menuitem", { name: "Create new…" }).click();
    await field.fill("Follow-up");
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await nextStarted.promise;
    const nextGroup = sidebar(page)
      .locator('[data-sidebar-section^="group:"]')
      .filter({
        has: page.locator("summary", { hasText: /^Follow-up$/ }),
      });
    followup = rowIn(
      page,
      await nextGroup.getAttribute("data-sidebar-section"),
    );
    await expect(followup).toBeFocused();
    await expect(destination).toHaveCount(0);
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    const moving = await openMove(page, followup);
    await moving
      .getByRole("menuitemradio", { name: "Work", exact: true })
      .click();
    await expect(beta).toBeFocused();
    await expect(followup).toHaveCount(0);
    await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
      1,
    );
    expect(app.report.sidebarPublications).toHaveLength(3);
  } finally {
    nextHeld.resolve();
  }
  await saved(page, app, 5, 2);
  await page.unroute("**/sidebar-assignment");
  await page.reload();
  await expect(beta).toBeVisible();
  // Existing group → another existing group needs no intermediate removal.
  const moving = await openMove(page, beta);
  await moving
    .getByRole("menuitemradio", { name: "Follow-up", exact: true })
    .click();
  await expect(followup).toBeFocused();
  await saved(page, app, 6);
  await page.reload();
  await expect(followup).toBeVisible();
  await expect(beta).toHaveCount(0);
});

// A modal can outlive the preference snapshot that admitted its launching menu.
// Real focus/modal behavior and retained user input need a browser regression.
test("Create new retains its draft when preferences fail before submission and recovers in place", async ({
  page,
  app,
}) => {
  // This is a sidebar/modal journey, not reading intent. Keep incidental
  // timeline dwell from starting a read-state publication across the reload.
  await holdReadingFocus(page);
  await open(page, app);
  const beta = rowIn(page, "group:work");
  await beta.click();
  await openChannelDetails(page);
  await page.getByText("Diagnostics", { exact: true }).click();
  const held = gate(),
    started = gate();
  // Transient at first, so relay recovery owns the failure and shows its notice.
  let status = 502;
  const failLegacy = async (route) => {
    started.resolve();
    await held.promise;
    const failed = status;
    const failures =
      failed === 502 ? "sidebarPreferenceFailures" : "relayFailures";
    app.report[failures] ??= [];
    app.report[failures].push(route.request().url());
    await route.fulfill({
      status: failed,
      contentType: "application/json",
      body: JSON.stringify({ error: "Preferences unavailable" }),
    });
  };
  await page.route("**/sidebar-preferences", failLegacy);
  try {
    await page
      .getByRole("button", { name: "Refresh groups and stars", exact: true })
      .click();
    await started.promise;
    await openMove(page, beta);
    await page.getByRole("menuitem", { name: "Create new…" }).click();
    const dialog = page.getByRole("dialog", { name: "Move to new section" });
    const field = dialog.getByRole("textbox", { name: "Section name" });
    // The menu-to-dialog handoff owns initial focus; mounting alone does not
    // mean WebKit's keyboard insertion has its final destination.
    await expect(field).toBeFocused();
    await field.fill("Retained launch");
    await expect(field).toHaveValue("Retained launch");
    const failed = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith("/sidebar-preferences") &&
        r.status() === 502,
    );
    held.resolve();
    await failed;
    await expect(
      dialog.getByRole("button", { name: "Create and move" }),
    ).toBeDisabled();
    await expect(dialog).toBeVisible();
    await expect(field).toHaveValue("Retained launch");
    await expect(dialog.getByRole("alert")).toContainText("Retry preferences");
    // Relay recovery owns the transient failure: it stays quiet through its
    // delay, and there is no separate preferences toast.
    await expect(page.locator(".buzz-toast")).toHaveCount(0);
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
    // Another failed recovery must keep both the draft and recovery action.
    // Recovery would retry a transient failure on its own seconds later, and
    // after the unroute below that read could remove Retry preferences while
    // the final click is still landing. A 4xx is not transient, so recovery
    // leaves it alone and the dialog's Retry is the only way out. The test
    // flips the status here, not the click, so a recovery read that lands
    // first also gets a 403 and can satisfy the response wait. Reads
    // serialize behind the disabled Retry, so toBeEnabled still waits for the
    // manual read.
    status = 403;
    const retryFailed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/sidebar-preferences") &&
        response.status() === 403,
    );
    await dialog
      .getByRole("button", { name: "Retry preferences", exact: true })
      .click();
    await retryFailed;
    await expect(
      dialog.getByRole("button", { name: "Retry preferences", exact: true }),
    ).toBeEnabled();
    await expect(field).toHaveValue("Retained launch");
    await page.unroute("**/sidebar-preferences", failLegacy);
    // The modal covers the recovery notice, so it keeps its own Retry.
    await dialog
      .getByRole("button", { name: "Retry preferences", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(field).toHaveValue("Retained launch");
    await expect(field).toBeFocused();
    await expect(
      dialog.getByRole("button", { name: "Create and move" }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await expect(dialog).toHaveCount(0);
    const destination = sidebar(page)
      .locator('[data-sidebar-section^="group:"]')
      .filter({
        has: page.locator("summary", { hasText: /^Retained launch$/ }),
      })
      .locator('[data-channel-id="beta"]');
    await expect(destination).toBeFocused();
    await saved(page, app, 1);
    await page.reload();
    await expect(destination).toBeVisible();
    await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
      1,
    );
    // Reload retires the old document: no incidental publisher crossed it.
    expect(
      app.report.brokerRequests.filter(({ url }) =>
        /\/read-state-(sign|publish)$/.test(url),
      ),
    ).toEqual([]);
  } finally {
    held.resolve();
    await page.unroute("**/sidebar-preferences", failLegacy);
  }
});

// Keep the scroll workload local: test.use at file scope would also give every
// pointer-move journey this long, independently scrolling sidebar.
const scrollTest = test.extend({
  largeSidebar: true,
});
scrollTest(
  "Workflows → Messages keeps saved groups, selected channel, and a visible entry's scroll on every frame without re-decoding",
  async ({ page, app }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    await expect(
      sidebar.locator("summary", { hasText: /^Work$/ }),
    ).toBeVisible();
    await expect(
      sidebar.locator("summary", { hasText: /Starred$/ }),
    ).toBeVisible();
    await sidebar.locator('button[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    // Navigation reveals the current entry; keep Beta in view at a nonzero
    // offset so the warm return has no reason to move the list.
    const scroll = await sidebar.evaluate((element) => {
      element.scrollTop = 0;
      const row = element.querySelector('button[data-channel-id="beta"]');
      element.scrollTop =
        row.getBoundingClientRect().top - element.getBoundingClientRect().top;
      return element.scrollTop;
    });
    expect(scroll).toBeGreaterThan(100);
    await openPage(page, "Workflows");
    await expect(sidebar).toBeHidden();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let decodes = 0;
    await page.route("**/sidebar-preferences", async (route) => {
      decodes++;
      await held;
      await route.continue();
    });
    await page.evaluate(() => {
      window.sidebarFrames = [];
      window.captureSidebar = true;
      const frame = () => {
        const list = document.querySelector(
          'nav[aria-label="Subscribed channels"]',
        );
        if (list?.checkVisibility())
          window.sidebarFrames.push({
            top: list.scrollTop,
            groups: Array.from(list.querySelectorAll("summary"), (el) =>
              el.textContent.replace("★", "").trim(),
            ),
          });
        if (window.captureSidebar) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    try {
      await openPage(page, "Messages");
      await expect(sidebar).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message #Beta", exact: true }),
      ).toBeVisible();
      // Wall time does not guarantee RAF callbacks on a busy runner. Wait for
      // samples, not correct samples: every earlier frame stays in the assertion.
      // The decode path stays held until finally, across all sampled frames.
      await page.waitForFunction(() => window.sidebarFrames.length > 3);
      const frames = await page.evaluate(() => {
        window.captureSidebar = false;
        return window.sidebarFrames;
      });
      expect(frames.length).toBeGreaterThan(3);
      expect(
        frames.filter(
          (frame) =>
            !frame.groups.includes("Work") ||
            !frame.groups.includes("Starred") ||
            Math.abs(frame.top - scroll) > 1,
        ),
        "No fallback grouping or top-of-list frame on warm return",
      ).toEqual([]);
      expect(
        decodes,
        "Page return must reuse the engine snapshot, not fetch/decode again",
      ).toBe(0);
    } finally {
      release();
      await page.unroute("**/sidebar-preferences");
    }
  },
);

// Browser-owned integration: menu/dialog portals, encrypted saves, and
// retained sidebar placement across app changes and reload.
test("Move and Create persist across apps without a sidebar", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openPage(page, "Workflows");
  const projects = page.getByRole("heading", {
    name: "Workflows",
    exact: true,
  });
  await expect(projects).toBeVisible();
  await expect(sidebar(page)).toBeHidden();
  await openPage(page, "Messages");
  const node = await sidebar(page).elementHandle();
  const menu = await openMove(page, rowIn(page, "group:work"));
  const actions = page.getByRole("menu", {
    name: "Actions for Beta",
    exact: true,
  });
  await expect(
    actions.getByRole("menuitem", { name: "Mute", exact: true }),
  ).toBeVisible();
  await menu
    .getByRole("menuitem", { name: "Create new…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Move to new section" });
  await dialog.getByRole("textbox").fill("Off-page group");
  await dialog
    .getByRole("button", { name: "Create and move", exact: true })
    .click();
  await saved(page, app, 1);
  const section = app.report.sidebarPublications[0].blob.sections.find(
    ({ name }) => name === "Off-page group",
  );
  await expect(rowIn(page, `group:${section.id}`)).toBeFocused();
  await openPage(page, "Workflows");
  await expect(projects).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await page.reload();
  await expect(projects).toBeVisible();
  await expect(sidebar(page)).toBeHidden();
  await openPage(page, "Messages");
  await expect(rowIn(page, `group:${section.id}`)).toBeVisible();
});
