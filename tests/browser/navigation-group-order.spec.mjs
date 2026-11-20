import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Pointer hit testing, drop-edge geometry and header click suppression need a
// layout engine. Record edits and store supersession stay in Vitest.
test.use({ productionBroker: true, savedSidebar: true, sidebarIcons: true });

const groups = (page) =>
  page
    .locator('[data-sidebar-section^="group:"]')
    .evaluateAll((sections) =>
      sections.map((section) => section.dataset.sidebarSection),
    );
const header = (page, id) =>
  page.locator(`[data-sidebar-section="group:${id}"] summary`);
const orders = (app) => {
  const { blob } = app.report.sidebarPublications.at(-1);
  return Object.fromEntries(
    blob.sectionOrder
      .filter((key) => key.startsWith("group:"))
      .map((key, index) => [key.slice("group:".length), index]),
  );
};
// Hold a real pointer drag over another group's header; the caller releases it.
async function pull(page, from, to) {
  const start = await header(page, from).boundingBox();
  const end = await header(page, to).boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 8,
  });
}

// The fixture groups use custom-emoji icons; serve every one as a plain image.
test.beforeEach(({ page }) =>
  page.route("**/media?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
    }),
  ),
);

test("dragging a group header moves the whole group, keeps its state, and persists", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect
    .poll(() => groups(page))
    .toEqual(["group:work", "group:missing", "group:laptop"]);
  const work = page.locator('[data-sidebar-section="group:work"]');
  const laptop = page.locator('[data-sidebar-section="group:laptop"]');
  await header(page, "laptop").click();
  await expect(laptop.locator("details")).not.toHaveAttribute("open");

  // A cancelled drag shows its landing edge, then leaves everything unchanged.
  await pull(page, "laptop", "work");
  await expect(laptop).toHaveAttribute("data-section-dragging");
  await expect(page.locator('[class*="channelDragOverlay"]')).toHaveCSS(
    "translate",
    "none",
  );
  await expect(work).toHaveAttribute("data-drop-edge", "before");
  await expect(work).not.toHaveAttribute("data-drop-target");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("[data-drop-edge]")).toHaveCount(0);
  await expect(page.locator("[data-section-dragging]")).toHaveCount(0);
  await page.clock.fastForward(51);
  await header(page, "laptop").dispatchEvent("click", { detail: 1 });
  await expect(laptop.locator("details")).not.toHaveAttribute("open");
  // Dropping a group on itself is not a move, and its header click is not a toggle.
  const own = await header(page, "laptop").boundingBox();
  const x = own.x + own.width / 2;
  const y = own.y + own.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 40, { steps: 4 });
  await expect(laptop).toHaveAttribute("data-section-dragging");
  await expect(
    page.locator('[data-sidebar-section="group:missing"]'),
  ).toHaveAttribute("data-drop-edge", "before");
  await page.mouse.move(x, y, { steps: 4 });
  // Deliver a click in the drop's event turn, before dnd-kit can remove its
  // document guard. stopPropagation alone must not toggle the native summary.
  await header(page, "laptop").evaluate((element) => {
    element.ownerDocument.addEventListener(
      "pointerup",
      () =>
        element.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            detail: 1,
          }),
        ),
      { once: true },
    );
  });
  // Returning the pointer does not mean dnd-kit has rendered its new target.
  // Release only after the old neighbour's insertion edge is gone.
  await expect(page.locator("[data-drop-edge]")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator("[data-section-dragging]")).toHaveCount(0);
  await expect(laptop.locator("details")).not.toHaveAttribute("open");
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);

  // A delayed post-drag click must remain suppressed after dnd-kit's cleanup.
  await page.clock.fastForward(51);
  await header(page, "laptop").dispatchEvent("click", { detail: 1 });
  await expect(laptop.locator("details")).not.toHaveAttribute("open");
  // Keyboard and assistive activation remain usable without a pointerdown.
  await header(page, "laptop").focus();
  await page.keyboard.press("Enter");
  await expect(laptop.locator("details")).toHaveAttribute("open");
  await header(page, "laptop").dispatchEvent("click", { detail: 0 });
  await expect(laptop.locator("details")).not.toHaveAttribute("open");
  // The next deliberate pointer action must still toggle normally.
  await header(page, "laptop").click();
  await expect(laptop.locator("details")).toHaveAttribute("open");
  await header(page, "laptop").click();
  await expect(laptop.locator("details")).not.toHaveAttribute("open");

  // Built-in sections are valid reorder targets. Escape cancels the move.
  const channels = await page
    .locator('[data-sidebar-section="channels"] summary')
    .boundingBox();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    channels.x + channels.width / 2,
    channels.y + channels.height / 2,
    { steps: 8 },
  );
  await expect(laptop).toHaveAttribute("data-section-dragging");
  await expect(
    page.locator('[data-sidebar-section="channels"]'),
  ).toHaveAttribute("data-drop-edge", "after");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect
    .poll(() => groups(page))
    .toEqual(["group:work", "group:missing", "group:laptop"]);
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);

  // Collapsed last group upward to first. dnd-kit drops on the target it last
  // rendered, so release only after the pointer's target is shown.
  await pull(page, "laptop", "work");
  await expect(work).toHaveAttribute("data-drop-edge", "before");
  await page.mouse.up();
  await expect
    .poll(() => groups(page))
    .toEqual(["group:laptop", "group:work", "group:missing"]);
  await expect(laptop.locator("details")).not.toHaveAttribute("open");
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  expect(orders(app)).toEqual({ laptop: 0, work: 1, missing: 2 });

  // Expanded group with its channel downward to last.
  await pull(page, "work", "missing");
  await expect(
    page.locator('[data-sidebar-section="group:missing"]'),
  ).toHaveAttribute("data-drop-edge", "after");
  await page.mouse.up();
  await expect
    .poll(() => groups(page))
    .toEqual(["group:laptop", "group:missing", "group:work"]);
  await expect(work.locator("details")).toHaveAttribute("open");
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(2);
  expect(orders(app)).toEqual({ laptop: 0, missing: 1, work: 2 });

  // The section menu is the single-pointer and keyboard path.
  await page.getByRole("button", { name: "More actions for Work" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Move down", exact: true }),
  ).toBeEnabled();
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect
    .poll(() => groups(page))
    .toEqual(["group:laptop", "group:work", "group:missing"]);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(3);

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.reload();
  await openPage(page, "Messages");
  await expect
    .poll(() => groups(page))
    .toEqual(["group:laptop", "group:work", "group:missing"]);
  await expect(laptop.locator("details")).not.toHaveAttribute("open");
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
});

test("group move recovery keeps keyboard focus on the group header", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect
    .poll(() => groups(page))
    .toEqual(["group:work", "group:missing", "group:laptop"]);
  await page.route("**/sidebar-section-order", (route) => {
    app.report.sidebarPreferenceFailures ??= [];
    app.report.sidebarPreferenceFailures.push(route.request().url());
    return route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Order save failed; retry" }),
    });
  });
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Work" });
  const failMove = async () => {
    await page.getByRole("button", { name: "More actions for Work" }).click();
    await page
      .getByRole("menuitem", { name: "Move down", exact: true })
      .click();
    await expect(error).toBeVisible();
    await expect
      .poll(() => groups(page))
      .toEqual(["group:work", "group:missing", "group:laptop"]);
  };
  const press = async (name) => {
    await error.getByRole("button", { name, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(error).toHaveCount(0);
    await expect(header(page, "work")).toBeFocused();
  };

  await failMove();
  await press("Dismiss");
  await failMove();
  await page.unroute("**/sidebar-section-order");
  await press("Retry move");
  await expect
    .poll(() => groups(page))
    .toEqual(["group:missing", "group:work", "group:laptop"]);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  await expect(header(page, "work")).toBeFocused();
});

test("saved groups accept gap drops in both directions", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect
    .poll(() => groups(page))
    .toEqual(["group:work", "group:missing", "group:laptop"]);
  const dropInGap = async (from, above, below, edge, expected) => {
    const target = edge === "before" ? below : above;
    await pull(page, from, target);
    const top = await page
      .locator(`[data-sidebar-section="group:${above}"]`)
      .boundingBox();
    const bottom = await page
      .locator(`[data-sidebar-section="group:${below}"]`)
      .boundingBox();
    expect(bottom.y).toBeGreaterThan(top.y + top.height);
    const gap = bottom.y - top.y - top.height;
    const middle = top.y + top.height + gap / 2;
    // Outside the saved groups horizontally is still not a target.
    await page.mouse.move(top.x + top.width + 10, middle);
    await expect(page.locator("[data-drop-edge]")).toHaveCount(0);
    for (const offset of [1, gap / 2 - 1, gap / 2, gap / 2 + 1, gap - 1]) {
      await page.mouse.move(top.x + top.width / 2, top.y + top.height + offset);
      await expect(
        page.locator(`[data-sidebar-section="group:${target}"]`),
      ).toHaveAttribute("data-drop-edge", edge);
    }
    await page.mouse.up();
    await expect.poll(() => groups(page)).toEqual(expected);
  };
  await dropInGap("laptop", "work", "missing", "before", [
    "group:work",
    "group:laptop",
    "group:missing",
  ]);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  await dropInGap("work", "laptop", "missing", "after", [
    "group:laptop",
    "group:work",
    "group:missing",
  ]);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(2);
  expect(orders(app)).toEqual({ laptop: 0, work: 1, missing: 2 });

  for (const id of ["work", "missing", "laptop"]) {
    await header(page, id).click();
    await expect(
      page.locator(`[data-sidebar-section="group:${id}"] details`),
    ).not.toHaveAttribute("open");
  }
  await dropInGap("missing", "laptop", "work", "before", [
    "group:laptop",
    "group:missing",
    "group:work",
  ]);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(3);
  await dropInGap("laptop", "missing", "work", "after", [
    "group:missing",
    "group:laptop",
    "group:work",
  ]);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(4);
  expect(orders(app)).toEqual({ missing: 0, laptop: 1, work: 2 });
});

test("group landing edge follows list order when text size changes during a drag", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 960, height: 1200 });
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const work = page.locator('[data-sidebar-section="group:work"]');
  const missing = page.locator('[data-sidebar-section="group:missing"]');
  await expect(work).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  const initial = await header(page, "work").boundingBox();
  const enlarged = await header(page, "missing").boundingBox();
  // At enlarged text sizes, grab the header's leading edge, clear of its actions.
  await page.mouse.move(initial.x + 12, initial.y + initial.height / 2);
  await page.mouse.down();
  await page.mouse.move(enlarged.x + 12, enlarged.y + enlarged.height / 2, {
    steps: 8,
  });
  await expect(missing).toHaveAttribute("data-drop-edge", "after");
  // dnd-kit starts each group's ResizeObserver when the drag starts and ignores
  // its first notification as the initial size. Let a rendering update deliver
  // it, so the text change below arrives as a separate resize.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "16px";
  });
  // The pointer is still below the resized groups. Wait for collision geometry
  // to catch up, or the old marker could satisfy the next assertion before the
  // move is processed and let the drop race against remeasurement.
  await expect(missing).not.toHaveAttribute("data-drop-edge");
  const target = await header(page, "missing").boundingBox();
  // The stale initial pixel comparison would now put the line on the wrong side.
  expect(initial.y).toBeGreaterThan(target.y);
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
  );
  await expect(missing).toHaveAttribute("data-drop-edge", "after");
  await page.mouse.up();
  await expect
    .poll(() => groups(page))
    .toEqual(["group:missing", "group:work", "group:laptop"]);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
});
