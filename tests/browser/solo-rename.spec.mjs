import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";
import { animationsSettled } from "./animations.mjs";

const alpha = "33333333-3333-4333-8333-333333333333";
const beta = "44444444-4444-4444-8444-444444444444";
test.use({
  pluginFixtures: true,
  productionBroker: true,
  hasTouch: true,
  channelIds: [alpha, beta],
  channelNames: { [alpha]: "Alpha", [beta]: "Beta" },
  soloChannels: [alpha, beta],
  ownSoloChannels: [alpha, beta],
  historyCounts: { [alpha]: 1, [beta]: 1 },
});

const sidebar = (page) =>
  page.getByRole("navigation", { name: "Subscribed channels" });
const rowCopies = (page, id) =>
  sidebar(page).locator(`[data-solo-destination-id="${id}"]`);
const row = (page, id) =>
  sidebar(page).locator(`[data-solo-destination-id="${id}"]:not([inert] *)`);
const input = (page) =>
  sidebar(page).getByRole("textbox", { name: "Chat name", exact: true });
const composer = (page) =>
  page.getByRole("textbox", { name: "Message your agents", exact: true });

async function settledError(page) {
  const alert = sidebar(page).getByRole("alert");
  await expect(alert).toBeVisible();
  // The Field error grows above Reload. Visibility alone admits a click while
  // its hit target is still moving; wait for the actual opening to finish.
  await animationsSettled(alert.locator(".."), { subtree: true });
}

// Real hit testing proves the stretched primary target excludes sibling controls.
// jsdom cannot establish this geometry or the positioned buttons' stacking order.
for (const variant of [
  { name: "light-wide", theme: "light", width: 1280, scale: 1 },
  { name: "dark-narrow", theme: "dark", width: 640, scale: 2 },
])
  test(`workspace blank space selects independently of its controls ${variant.name}`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: variant.width, height: 1000 });
    await page.addInitScript(({ theme, scale }) => {
      localStorage.setItem("buzz-appearance.v1", theme);
      localStorage.setItem("buzz-font-scale.v1", String(scale));
    }, variant);
    await page.goto(
      `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets`,
    );
    await newChat(page);
    await page.evaluate(() => window.fixtureSoloRegion.createWorkspace());
    const show = page.getByRole("button", {
      name: "Show navigation",
      exact: true,
    });
    if (await show.isVisible()) await show.click();
    const title = sidebar(page).getByRole("button", {
      name: "Work",
      exact: true,
    });
    await expect(title).toBeVisible();
    const header = title.locator("xpath=ancestor::*[@data-solo-menu-id][1]");
    await header
      .getByRole("button", { name: "Hide tasks and chats in Work" })
      .click();
    await expect(title).not.toHaveAttribute("aria-current", "page");
    await expect(
      sidebar(page).getByRole("button", { name: "Workspace task" }),
    ).toBeHidden();
    await header.scrollIntoViewIfNeeded();
    const toggle = header.getByRole("button", {
      name: "Show tasks and chats in Work",
    });
    const newTask = header.getByRole("button", { name: "New task in Work" });
    const point = await header.evaluate((row) => {
      const bounds = row.getBoundingClientRect();
      const buttons = [...row.querySelectorAll("button")].map((button) =>
        button.getBoundingClientRect(),
      );
      const xs = [
        ...new Set([
          bounds.left,
          bounds.right,
          ...buttons.flatMap((box) => [box.left, box.right]),
        ]),
      ].sort((a, b) => a - b);
      const ys = [
        ...new Set([
          bounds.top,
          bounds.bottom,
          ...buttons.flatMap((box) => [box.top, box.bottom]),
        ]),
      ].sort((a, b) => a - b);
      const points = xs.slice(1).flatMap((x, i) =>
        ys.slice(1).map((y, j) => ({
          x: Math.round((xs[i] + x) / 2),
          y: Math.round((ys[j] + y) / 2),
          clearance: Math.min(x - xs[i], y - ys[j]) / 2,
        })),
      );
      // Use an interior CSS pixel. A fractional midpoint on a one-pixel edge
      // can hit the header during hit testing and miss it on pointer dispatch.
      return points
        .sort((a, b) => b.clearance - a.clearance)
        .find(
          (p) =>
            p.clearance >= 2 &&
            !buttons.some(
              (b) =>
                p.x >= b.left &&
                p.x <= b.right &&
                p.y >= b.top &&
                p.y <= b.bottom,
            ) &&
            row.contains(document.elementFromPoint(p.x, p.y)),
        );
    });
    if (!point)
      throw new Error("Workspace header must have visible blank space");
    await page.mouse.click(point.x, point.y);
    await expect(title).toHaveAttribute("aria-current", "page");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const actions = header.getByRole("button", { name: "Actions for Work" });
    const newTaskItem = page.getByRole("menuitem", { name: "New task" });
    if (variant.name === "dark-narrow") {
      // Without room for both controls, New task is reached through Actions.
      await expect(newTask).toBeHidden();
      await actions.focus();
      await page.keyboard.press("Enter");
      await expect(newTaskItem).toBeFocused();
      await page.keyboard.press("Enter");
    } else {
      await newTask.click();
    }
    await expect(title).not.toHaveAttribute("aria-current", "page");
    await toggle.click();
    await expect(
      sidebar(page).getByRole("button", { name: "Workspace task" }),
    ).toBeVisible();
    await expect(title).not.toHaveAttribute("aria-current", "page");
    await actions.click();
    await expect(
      page.getByRole("menuitem", { name: "Workspace settings" }),
    ).toBeVisible();
    // The menu offers New task at each width.
    await expect(newTaskItem).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(title).not.toHaveAttribute("aria-current", "page");
    await title.focus();
    await page.keyboard.press("Enter");
    await expect(title).toHaveAttribute("aria-current", "page");
    expect(app.report.unexpected).toEqual([]);
  });

// These exercise native focus loss, actual drawer hit targets and signed live
// metadata. DOM-only tests cannot establish these browser/host contracts.
async function holdDetails(page) {
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  let holding = true;
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      holding &&
      filters.some(
        (filter) =>
          filter.kinds?.includes(39000) && filter["#d"]?.includes(alpha),
      )
    ) {
      holding = false;
      started();
      await gate;
    }
    await route.continue();
  });
  return { requested, release };
}

test("a delayed initial name read keeps focus on a different chat", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  await row(page, alpha).click();
  await expect(composer(page)).toBeVisible();
  const held = await holdDetails(page);
  try {
    await row(page, alpha).dblclick();
    await held.requested;
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveAttribute("readonly");
    await row(page, beta).click();
    await expect(row(page, beta)).toHaveAttribute("aria-current", "page");
    await composer(page).focus();
    held.release();
    await expect(input(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await row(page, beta).dblclick();
    await expect(input(page)).toHaveValue("Beta");
    await input(page).press("Escape");
  } finally {
    held.release();
  }
});

test("failed Enter-save and explicit reload retain keyboard control", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  await row(page, alpha).click();
  await expect(composer(page)).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    for (const size of ["100%", "150%"]) {
      await page.evaluate((value) => {
        document.documentElement.style.fontSize = value;
      }, size);
      const glyphOffset = (element) =>
        element.evaluate((glyph) => {
          const row = glyph.closest("button[data-solo-destination-id], form");
          const icon = glyph.getBoundingClientRect();
          const frame = row.getBoundingClientRect();
          return { x: icon.x - frame.x, y: icon.y - frame.y };
        });
      const before = await glyphOffset(row(page, alpha).locator("svg").first());
      await row(page, alpha).dblclick();
      await expect(input(page)).toHaveAttribute("aria-disabled", "false");
      const glyph = sidebar(page).getByRole("form").locator("svg").first();
      const after = await glyphOffset(glyph);
      expect(after.x).toBeCloseTo(before.x, 0);
      expect(after.y).toBeCloseTo(before.y, 0);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`editor-${mode}-${size.replace("%", "")}.png`),
      });
      await input(page).press("Escape");
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "100%";
    document.documentElement.dataset.colorMode = "light";
  });
  await row(page, alpha).dblclick();
  await expect(input(page)).toHaveAttribute("aria-disabled", "false");
  let refused = false;
  await page.route("**/api/relay/**/channel-details-sign", async (route) => {
    if (!refused) {
      refused = true;
      return route.fulfill({ json: {} });
    }
    return route.continue();
  });
  await input(page).fill("Keep this draft");
  await input(page).press("Enter");
  await settledError(page);
  const recovery = await sidebar(page)
    .getByRole("button", { name: "Reload chat details" })
    .boundingBox();
  const field = await input(page).boundingBox();
  expect(recovery.x).toBeCloseTo(field.x, 0);
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("Keep this draft");
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  // Refreshing the base must preserve the native caret in the retained draft.
  await input(page).evaluate((field) => field.setSelectionRange(4, 4));
  await sidebar(page)
    .getByRole("button", { name: "Reload chat details" })
    .click();
  await expect(input(page)).toHaveAttribute("aria-disabled", "false");
  await expect(input(page)).toBeFocused();
  await expect
    .poll(() =>
      input(page).evaluate((field) => [
        field.selectionStart,
        field.selectionEnd,
      ]),
    )
    .toEqual([4, 4]);
  await input(page).press("x");
  await expect(input(page)).toHaveValue("Keepx this draft");
  await input(page).fill("Keep this draft");
  refused = false;
  await input(page).press("Enter");
  await settledError(page);
  const held = await holdDetails(page);
  try {
    await sidebar(page)
      .getByRole("button", { name: "Reload chat details" })
      .click();
    // Prove Reload activated before awaiting the held network operation.
    await expect(input(page)).toHaveAttribute("readonly");
    await held.requested;
    await expect(input(page)).toBeFocused();
    await input(page).press("Enter");
    await expect(input(page)).toHaveValue("Keep this draft");
    await composer(page).focus();
    await expect(input(page)).toHaveValue("Keep this draft");
    await expect(input(page)).toHaveAttribute("readonly");
    held.release();
    await expect(input(page)).toHaveAttribute("aria-disabled", "false");
    await expect(composer(page)).toBeFocused();
    await expect(input(page)).toHaveValue("Keep this draft");
    expect(app.report.detailsPublications ?? []).toHaveLength(0);
    await input(page).focus();
    await input(page).press("Enter");
    await expect(input(page)).toHaveCount(0);
    await expect(row(page, alpha)).toContainText("Keep this draft");
    expect(app.report.detailsPublications).toHaveLength(1);
    // The new name sorts this chat below Beta, and the rows trade places after
    // a quiet period. A double-click during that slide can land its second
    // press on Beta and open the wrong editor; wait for the rows to stop.
    await expect
      .poll(() =>
        sidebar(page)
          .locator("[data-solo-destination-id]:not([inert] *)")
          .evaluateAll((rows) =>
            rows.map((item) => item.dataset.soloDestinationId),
          ),
      )
      .toEqual([beta, alpha]);
    await expect(sidebar(page).locator("[data-moving]")).toHaveCount(0);
    await row(page, alpha).dblclick();
    await expect(input(page)).toBeFocused();
    await expect(sidebar(page).getByRole("form")).toHaveAccessibleName(
      "Rename Keep this draft",
    );
    await input(page).press("Escape");
    await expect(row(page, alpha)).toBeFocused();
  } finally {
    held.release();
  }
});

test("narrow mouse double-click renames while single-click and keyboard still navigate", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 600, height: 850 });
  await page.goto(app.origin);
  await newChat(page);
  const show = page.getByRole("button", {
    name: "Show navigation",
    exact: true,
  });
  await show.click();
  await expect(row(page, alpha)).toBeVisible();
  // Anchor both calls to the same clock: runner/browser wall clocks can differ.
  const clockStart = Date.now();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart + 60_000);
  await row(page, alpha).dblclick();
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveAttribute("aria-disabled", "false");
  await page.clock.runFor(501);
  await expect(input(page)).toBeVisible();
  await input(page).press("Escape");
  await row(page, beta).click();
  await page.clock.runFor(400);
  await expect(row(page, beta)).toBeVisible();
  await page.clock.runFor(100);
  await expect(sidebar(page)).not.toBeVisible();
  await expect(composer(page)).toBeVisible();
  await show.click();
  await row(page, alpha).focus();
  await row(page, alpha).press("Enter");
  await expect(sidebar(page)).not.toBeVisible();
  await show.click();
  await row(page, beta).tap();
  await expect(sidebar(page)).not.toBeVisible();
  for (const activation of ["keyboard", "touch", "mouse"]) {
    await test.step(activation, async () => {
      // Opening by touch starts a fresh tap target before the row tap.
      await show.tap();
      await row(page, alpha).click();
      if (activation === "keyboard") {
        await row(page, beta).focus();
        await row(page, beta).press("Enter");
      } else if (activation === "touch") await row(page, beta).tap();
      else {
        await row(page, beta).click();
        await page.clock.runFor(500);
      }
      await expect(sidebar(page)).not.toBeVisible();
      await page.clock.runFor(501);
      await expect(
        page.locator(`[data-solo-destination-id="${beta}"]`),
      ).toHaveAttribute("aria-current", "page");
    });
  }
  await page.evaluate(() =>
    window.fixtureNavigation.open({
      version: 1,
      kind: "page",
      pluginId: "fixture.absent",
      pageId: "missing",
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const snapshot = window.fixtureNavigation.snapshot();
        return {
          status: snapshot.status,
          aborted: snapshot.attempt.signal.aborted,
        };
      }),
    )
    .toEqual({ status: "failed", aborted: true });
  await page
    .getByRole("navigation", { name: "Apps dock" })
    .getByRole("tab", { name: "Messages", exact: true })
    .click();
  await show.tap();
  await row(page, alpha).click();
  await page.clock.runFor(501);
  await expect(sidebar(page)).not.toBeVisible();
  await expect(composer(page)).toBeVisible();
  await expect(
    page.locator(`[data-solo-destination-id="${alpha}"]`),
  ).toHaveAttribute("aria-current", "page");
  let releaseSave;
  let startSave;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const saveStarted = new Promise((resolve) => {
    startSave = resolve;
  });
  await page.route("**/api/relay/**/channel-details-sign", async (route) => {
    startSave();
    await saveGate;
    await route.continue();
  });
  try {
    await show.tap();
    await row(page, alpha).dblclick();
    await expect(input(page)).toHaveAttribute("aria-disabled", "false");
    await input(page).fill("Pending narrow rename");
    await input(page).press("Enter");
    await saveStarted;
    // Another active editor makes Beta navigation-only, even on double-click.
    await row(page, beta).dblclick();
    await expect(sidebar(page)).not.toBeVisible();
    await expect(
      page.locator(`[data-solo-destination-id="${beta}"]`),
    ).toHaveAttribute("aria-current", "page");
  } finally {
    releaseSave();
  }
});

test("live conversion removes the old editor and permits renaming another Solo chat", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  // Leaving the draft retires its "New chat" row; let the list settle first.
  await row(page, alpha).click();
  await expect(composer(page)).toBeVisible();
  await row(page, alpha).dblclick();
  await expect(input(page)).toHaveValue("Alpha");
  await expect(input(page)).toHaveAttribute("aria-disabled", "false");
  await input(page).fill("Unsubmitted name");
  const signatures = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/channel-details-sign"))
      signatures.push(request.postDataJSON());
  });
  await expect.poll(() => app.relay.hasRoute("primary", alpha)).toBe(true);
  app.relay.publish(
    "primary",
    app.signRelay({
      kind: 39000,
      created_at: Math.floor(Date.now() / 1000) + 10,
      tags: [
        ["d", alpha],
        ["name", "Alpha"],
        ["about", ""],
        ["t", "stream"],
        ["private"],
      ],
      content: "",
    }),
  );
  // Inert exit copies are already absent from role queries but can still move
  // the next row when they unmount. Wait for the actual editor to leave.
  await expect(
    sidebar(page).locator('form[aria-label="Rename Alpha"]'),
  ).toHaveCount(0);
  await expect(input(page)).toHaveCount(0);
  await expect(rowCopies(page, alpha)).toHaveCount(0);
  // Actual unmount retires the editor's save lifetime, including native blur
  // caused by making its retained exit inert. No draft may reach the signer.
  expect(signatures).toEqual([]);
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await row(page, beta).dblclick();
  await expect(input(page)).toHaveValue("Beta");
  await expect(input(page)).toBeFocused();
  await input(page).press("Escape");
});

// Native inert focus loss and the handoff across the presence exit require a
// browser. Reuse one app for both motion preferences and the no-steal guard.
test("passive conversion hands off row focus without stealing it elsewhere", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  await row(page, beta).click();
  await expect(composer(page)).toBeVisible();
  await expect.poll(() => app.relay.hasRoute("primary", alpha)).toBe(true);
  const metadata = [
    ["name", "Alpha"],
    ["about", ""],
    ["t", "stream"],
    ["private"],
    ["P", app.viewer],
  ];
  for (const reducedMotion of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion });
    for (const movedElsewhere of [false, true]) {
      await test.step(`${reducedMotion}, focus moved: ${movedElsewhere}`, async () => {
        app.setChannelMetadata(alpha, [...metadata, ["t", "buzz.solo"]]);
        await expect(row(page, alpha)).toBeVisible();
        await animationsSettled(sidebar(page), { subtree: true });
        await row(page, alpha).focus();
        await expect(row(page, alpha)).toBeFocused();
        await expect(row(page, beta)).toHaveAttribute("aria-current", "page");
        if (movedElsewhere) await composer(page).focus();
        app.setChannelMetadata(alpha, metadata);
        await expect(rowCopies(page, alpha)).toHaveCount(0);
        await expect(
          movedElsewhere ? composer(page) : row(page, beta),
        ).toBeFocused();
        await expect(row(page, beta)).toHaveAttribute("aria-current", "page");
      });
    }
  }
});

// A DOM emulator cannot establish Collapsible's real hide/unmount transition
// while the production signer owns a pending save.
test("collapsing a workspace waits for its rename save before hiding the editor", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  await row(page, alpha).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "Create new…", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  // Wait until the exiting menus are gone and the dialog's initial focus has
  // settled on the field. The modal hides the menus from role queries.
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  const field = dialog.getByRole("textbox", { name: "Name", exact: true });
  await expect(field).toBeFocused();
  await field.fill("Work");
  await expect(field).toHaveValue("Work");
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(dialog).not.toBeVisible();
  const work = sidebar(page).locator('summary[aria-label="Work"]');
  const workspace = work.locator("..");
  await expect(workspace).toHaveAttribute("open");
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/api/relay/**/channel-details-sign", async (route) => {
    started();
    await gate;
    await route.continue();
  });
  try {
    await row(page, alpha).dblclick();
    await expect(input(page)).toHaveAttribute("aria-disabled", "false");
    await input(page).fill("Saved through collapse");
    await input(page).press("Enter");
    await requested;
    await work.click();
    await expect(input(page)).toBeVisible();
    await expect(workspace).toHaveAttribute("open");
    await row(page, beta).dblclick();
    await expect(input(page)).toHaveValue("Saved through collapse");
    release();
    await expect(workspace).not.toHaveAttribute("open");
    await expect(input(page)).toHaveCount(0);
    // The editor closes before its panel finishes collapsing. Wait for the
    // panel's unmount so the next double-click has a stationary target.
    await expect(row(page, alpha)).toBeHidden();
    await expect(row(page, beta)).toBeFocused();
    await row(page, beta).dblclick();
    await expect(input(page)).toHaveValue("Beta");
    await input(page).press("Escape");
    await work.click();
    await expect(row(page, alpha)).toContainText("Saved through collapse");
    expect(app.report.detailsPublications).toHaveLength(1);
    await page.unroute("**/api/relay/**/channel-details-sign");
    await page.route("**/api/relay/**/channel-details-sign", (route) =>
      route.fulfill({ json: {} }),
    );
    for (const cancellation of ["Escape", "Cancel rename"]) {
      await row(page, alpha).dblclick();
      await expect(input(page)).toHaveAttribute("aria-disabled", "false");
      await input(page).fill("Retain until cancelled");
      await input(page).press("Enter");
      await expect(sidebar(page).getByRole("alert")).toBeVisible();
      await work.click();
      await expect(workspace).toHaveAttribute("open");
      await input(page).focus();
      if (cancellation === "Escape") await input(page).press("Escape");
      else
        await sidebar(page)
          .getByRole("button", { name: cancellation, exact: true })
          .click();
      // Wait for the closing transition's actual unmount, not just aria-expanded.
      await expect(row(page, alpha)).toBeHidden();
      await expect(work).toBeFocused();
      await work.click();
      await expect(row(page, alpha)).toBeVisible();
    }
    await page.unroute("**/api/relay/**/channel-details-sign");
    let finishSave;
    let startSave;
    const pendingSave = new Promise((resolve) => {
      finishSave = resolve;
    });
    const saveStarted = new Promise((resolve) => {
      startSave = resolve;
    });
    await page.route("**/api/relay/**/channel-details-sign", async (route) => {
      startSave();
      await pendingSave;
      await route.continue();
    });
    try {
      await row(page, alpha).dblclick();
      await expect(input(page)).toHaveAttribute("aria-disabled", "false");
      await input(page).fill("Focused save through collapse");
      await input(page).press("Enter");
      await saveStarted;
      await work.click();
      await input(page).focus();
      await expect(input(page)).toBeFocused();
      finishSave();
      await expect(row(page, alpha)).toBeHidden();
      await expect(work).toBeFocused();
    } finally {
      finishSave();
    }
  } finally {
    release();
  }
});

// Composable source rows must retain native drawer hit targets and focus rules.
// Real browser focus refusal for display:none cannot be established in jsdom.
const regionRow = (page, id) =>
  sidebar(page).locator(
    `[data-sidebar-section^="solo-region:"] [data-solo-destination-id="${id}"]:not([inert] *)`,
  );
// Classify refuses a chat the roster has not loaded, so wait for its row first.
async function regionFixture(page, app, ids = [alpha, beta]) {
  await page.goto(`${app.origin}/?solo-region-fixture`);
  await newChat(page);
  await expect(row(page, ids[0])).toBeVisible();
  await page.evaluate(async (ids) => {
    for (const id of ids) await window.fixtureSoloRegion.classify(id);
  }, ids);
  await expect(regionRow(page, ids[0])).toBeVisible();
}

test("composable rows retain narrow rename and immediate keyboard/touch activation", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await regionFixture(page, app, [alpha]);
  await page.setViewportSize({ width: 600, height: 950 });
  const show = page.getByRole("button", {
    name: "Show navigation",
    exact: true,
  });
  await show.click();
  await expect(regionRow(page, alpha)).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
      document.documentElement.style.fontSize = "150%";
    }, mode);
    await regionRow(page, alpha).dblclick();
    await expect(input(page)).toHaveValue("Alpha");
    await expect(input(page)).toBeFocused();
    await input(page).press("Escape");
    await expect(regionRow(page, alpha)).toBeFocused();
  }
  // The ordinary row and source row share the same pending mouse selection.
  // Freeze wall time before pausing timers so protocol latency cannot overtake it.
  const pausedAt = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(pausedAt);
  await page.clock.pauseAt(pausedAt);
  await page.clock.setSystemTime(pausedAt);
  await regionRow(page, alpha).click();
  await row(page, beta).click();
  await page.clock.runFor(500);
  await expect(composer(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Share access to Beta", exact: true }),
  ).toBeVisible();
  await expect(sidebar(page)).not.toBeVisible();
  await page.clock.resume();
  await show.click();
  await regionRow(page, alpha).press("Enter");
  await expect(
    page.getByRole("button", { name: "Share access to Alpha", exact: true }),
  ).toBeVisible();
  await expect(sidebar(page)).not.toBeVisible();
  await show.click();
  await regionRow(page, alpha).tap();
  await expect(sidebar(page)).not.toBeVisible();
});

test("composable row removal respects blur and continues past a CSS-hidden neighbor", async ({
  page,
  app,
}) => {
  await regionFixture(page, app);
  const owned = regionRow(page, alpha);
  await owned.focus();
  await owned.evaluate((node) => node.blur());
  await page.evaluate(
    (id) => window.fixtureSoloRegion.present([id], []),
    alpha,
  );
  await expect(owned).toHaveCount(0);
  expect(
    await page.evaluate(() => document.activeElement === document.body),
  ).toBe(true);
  await page.evaluate(() => window.fixtureSoloRegion.present([], []));
  await owned.focus();
  await page.evaluate(
    (ids) => window.fixtureSoloRegion.present([ids[0]], [ids[1]]),
    [alpha, beta],
  );
  await expect(owned).toHaveCount(0);
  await expect(regionRow(page, beta)).toBeHidden();
  await expect(
    sidebar(page).locator(
      '[data-sidebar-section^="solo-region:"] summary[aria-label="Solo"]',
    ),
  ).toBeFocused();
});

// A real browser must move focus off the detached summary to the remaining
// source heading; the ordinary Solo fallback is not mounted in this layout.
test("removing a focused region keeps keyboard focus in the remaining region", async ({
  page,
  app,
}) => {
  await regionFixture(page, app);
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
      document.documentElement.style.fontSize = "150%";
    }, mode);
    await page.evaluate(() => window.fixtureSoloRegion.addTransientRegion());
    const temporary = sidebar(page).locator('summary[aria-label="Temporary"]');
    await temporary.focus();
    await expect(temporary).toBeFocused();
    await page.evaluate(() => window.fixtureSoloRegion.removeTransientRegion());
    await expect(temporary).toHaveCount(0);
    const remaining = sidebar(page).locator(
      '[data-sidebar-section^="solo-region:"] summary[aria-label="Solo"]',
    );
    await expect(remaining).toBeFocused();
    await remaining.press("Enter");
    await expect(regionRow(page, alpha)).toBeHidden();
    await remaining.press("Enter");
    await expect(regionRow(page, alpha)).toBeVisible();
  }
});

// Real shell scope and page fallback after roster removal require app wiring.
// The controlled completion/failure/navigation matrix lives in SoloRegions.test.tsx.
test.describe("plugin-owned Solo lifecycle", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  test.use({
    channelLifecycle: true,
    soloChannels: [id],
    ownSoloChannels: [id],
  });

  test("deleting a plugin-owned chat keeps the shell in Solo", async ({
    page,
    app,
  }) => {
    await regionFixture(page, app, [id]);
    const messages = page.getByRole("tab", { name: "Messages", exact: true });
    await expect(messages).toHaveAttribute("aria-selected", "true");
    const row = regionRow(page, id);
    await expect(row).toBeVisible();
    await row.click();
    await expect(row).toHaveAttribute("aria-current", "page");
    await expect(composer(page)).toBeEnabled();
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Delete chat", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Delete Lifecycle channel?",
    });
    await dialog
      .getByRole("button", { name: "Delete chat", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(messages).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/solo-draft/);
    expect(
      app.report.lifecyclePublications.map((event) => [event.kind, event.tags]),
    ).toEqual([[9008, [["h", id]]]]);
    expect(app.report.unexpected).toEqual([]);
  });
});

// This protects real DOM focus/selection when the source changes an ordinary
// row's placement; React/jsdom can prove retained state but not native blur.
test("task-source recovery retains an ordinary chat editor, caret and unsaved name", async ({
  page,
  app,
}) => {
  await page.goto(`${app.origin}/?solo-region-fixture&compose-workspaces`);
  await newChat(page);
  await row(page, alpha).dblclick();
  await expect(input(page)).toHaveAttribute("aria-disabled", "false");
  await input(page).fill("Keep this unsaved name");
  await input(page).evaluate((field) => field.setSelectionRange(4, 4));
  for (const status of ["loading", "ready"]) {
    await page.evaluate(
      (status) => window.fixtureSoloRegion.status(status),
      status,
    );
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue("Keep this unsaved name");
    await expect
      .poll(() =>
        input(page).evaluate((field) => [
          field.selectionStart,
          field.selectionEnd,
        ]),
      )
      .toEqual([4, 4]);
  }
  await input(page).press("Escape");
  await expect(input(page)).toHaveCount(0);
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
});
