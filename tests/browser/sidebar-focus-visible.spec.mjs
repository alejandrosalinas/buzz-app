import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  pluginFixtures: true,
  productionBroker: true,
  savedSidebar: true,
  sidebarIcons: true,
});

// The fixture groups use custom-emoji icons; serve every one as a plain image.
test.beforeEach(({ page }) =>
  page.route("**/media?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
    }),
  ),
);

// Why the focused element can't be seen, or "" when it can: every ancestor's
// opacity multiplies, and a point at its center has to land on it, which
// catches clipping, zero size and anything covering it.
function unseen(element) {
  if (!element || element === document.body) return "nothing focused";
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return "no size";
  if (getComputedStyle(element).visibility !== "visible") return "hidden";
  let opacity = 1;
  for (let node = element; node; node = node.parentElement)
    opacity *= parseFloat(getComputedStyle(node).opacity);
  if (opacity < 1) return `opacity ${opacity}`;
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  return hit && element.contains(hit) ? "" : "covered or clipped";
}

// Anything focusable has to be visible while it has focus. Tabbing through
// the unified sidebar reaches every control, whichever component draws it and
// however it hides at rest, so a control revealed by a rule that can't match
// fails here.
test("every control Tab reaches in the sidebar is visible while focused", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(
    sidebar.getByRole("tablist", { name: "Navigation scope" }),
  ).toHaveCount(0);
  await page.mouse.move(0, 0);
  await sidebar
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button")
    .first()
    .focus();
  let quiet = 0;
  const seen = new Set();
  for (let stop = 0; stop < 400; stop += 1) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      const aside = element?.closest('aside[aria-label="Sidebar"]');
      if (!aside) return null;
      return {
        key: [...aside.querySelectorAll("*")].indexOf(element),
        label:
          element.getAttribute("aria-label") ||
          element.textContent.trim().slice(0, 40),
        quiet: !!element.closest("[data-navigation-reveal]"),
      };
    });
    // Focus left the sidebar, or wrapped back to where it started.
    if (!focus || seen.has(focus.key)) break;
    seen.add(focus.key);
    if (focus.quiet) quiet += 1;
    await expect
      .poll(() => page.locator(":focus").evaluate(unseen), {
        message: `Focused "${focus.label}" can't be seen`,
      })
      .toBe("");
  }
  // Heading actions that hide at rest were among the stops.
  expect(quiet).toBeGreaterThan(0);
});

test("closing a heading's dialog with the mouse leaves its menu button visible", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const more = page.getByRole("button", {
    name: "More actions for Work",
    exact: true,
  });
  await more.click();
  await page.getByRole("menuitem", { name: "Workspace settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Workspace settings" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.mouse.move(0, 0);
  // Focus returns to the menu button, so it has to stay visible.
  await expect(more).toBeFocused();
  await expect.poll(() => more.evaluate(unseen)).toBe("");
});

test.describe("passive channel removal", () => {
  const soloIds = Array.from(
    { length: 16 },
    (_, index) =>
      `c0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );

  test.use({
    sidebarIcons: false,
    channelIds: ["alpha", "beta", ...soloIds],
    ownSoloChannels: soloIds,
    soloChannels: soloIds,
  });

  // Only a browser can show whether recovering focus after a relay update
  // reveals the keyboard focus or displaces the content the user scrolled to.
  for (const { title, keepViewport, soloRemoval } of [
    {
      title:
        "keeps a contributed Solo row in view when a focused channel is archived above it",
      keepViewport: true,
    },
    {
      title:
        "keeps the viewport steady when a focused contributed Solo row disappears above it",
      keepViewport: true,
      soloRemoval: "source",
    },
    {
      title:
        "keeps the viewport steady when a mounted Solo conversation leaves the roster above it",
      keepViewport: true,
      soloRemoval: "roster",
    },
    {
      title: "reveals replacement focus when an in-view channel is archived",
      keepViewport: false,
    },
  ])
    test(title, async ({ page, app }) => {
      await page.setViewportSize({ width: 1100, height: 430 });
      const fixture = soloRemoval
        ? "?solo-region-fixture&compose-workspaces"
        : "?solo-region-fixture";
      await page.goto(keepViewport ? `${app.origin}/${fixture}` : app.origin);
      await openPage(page, "Messages");
      const sidebar = page.getByRole("navigation", {
        name: "Subscribed channels",
      });
      const workspace = sidebar.locator('[data-sidebar-section="group:work"]');
      const heading = workspace.locator("summary");
      const beta = workspace.getByRole("button", { name: "Beta", exact: true });
      if (keepViewport) {
        // Classification needs the roster, even when the ordinary list caps its rows.
        await page.waitForFunction((ids) => {
          const session = window.fixtureRelay?.snapshot().session;
          const channels = session?.channels.list().channels;
          return ids.every((id) =>
            channels?.some(
              (row) => row.id === id && row.channelType === "solo",
            ),
          );
        }, soloIds);
        await page.evaluate(async (ids) => {
          for (const id of ids) await window.fixtureSoloRegion.classify(id);
        }, soloIds);
        await expect(
          sidebar.locator("button[data-channel-id][data-solo-destination-id]"),
        ).toHaveCount(0);
      }
      const anchor = sidebar
        .locator(`[data-solo-destination-root="${soloIds[8]}"]`)
        .locator(`button[data-solo-destination-id="${soloIds[8]}"]`);
      const departing = soloRemoval
        ? sidebar
            .getByRole("navigation", { name: "Solo conversations" })
            .locator(`button[data-solo-destination-id="${soloIds[0]}"]`)
        : beta;
      if (keepViewport) await expect(anchor).toBeVisible();
      if (soloRemoval === "roster")
        await page.evaluate(
          (id) => window.fixtureSoloRegion.present([], [], id),
          soloIds[0],
        );
      if (soloRemoval !== "source")
        await expect
          .poll(() =>
            app.relay.hasRoute("primary", soloRemoval ? soloIds[0] : "beta"),
          )
          .toBe(true);
      await departing.focus();
      // Leave room for an offscreen row to exit while keeping the target in view.
      const inset = keepViewport
        ? await sidebar.evaluate((viewport) => viewport.clientHeight / 3)
        : 10;
      const visibleRow = keepViewport ? anchor : departing;
      await visibleRow.evaluate(async (row, offset) => {
        const viewport = row.closest('nav[aria-label="Subscribed channels"]');
        const previous = viewport.scrollTop;
        const listeners = new AbortController();
        const scrolled = new Promise((resolve) =>
          viewport.addEventListener("scroll", resolve, {
            once: true,
            signal: listeners.signal,
          }),
        );
        viewport.scrollTop +=
          row.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          offset;
        if (viewport.scrollTop !== previous) await scrolled;
        listeners.abort();
      }, inset);
      await expect(departing).toBeFocused();
      if (keepViewport) {
        await expect(departing).not.toBeInViewport();
        await expect(anchor).toBeInViewport({ ratio: 1 });
      } else {
        await expect(departing).toBeInViewport({ ratio: 1 });
        await expect.poll(() => heading.evaluate(unseen)).not.toBe("");
      }
      const offset = (row) =>
        row.getBoundingClientRect().top -
        row
          .closest('nav[aria-label="Subscribed channels"]')
          .getBoundingClientRect().top;
      const before = keepViewport ? await anchor.evaluate(offset) : 0;
      const pluginRow =
        soloRemoval === "roster"
          ? await departing.evaluateHandle(
              (row) =>
                row.closest("[data-solo-destination-root]").parentElement,
            )
          : undefined;
      if (soloRemoval === "source") {
        await page.evaluate(
          (id) => window.fixtureSoloRegion.present([id], []),
          soloIds[0],
        );
      } else if (soloRemoval === "roster") {
        app.setChannelMetadata(soloIds[0], [
          ["name", soloIds[0]],
          ["t", "stream"],
          ["t", "buzz.solo"],
          ["private"],
          ["P", app.viewer],
          ["archived", "true"],
        ]);
      } else {
        app.setChannelMetadata("beta", [
          ["name", "Beta"],
          ["t", "stream"],
          ["public"],
          ["archived", "true"],
        ]);
      }
      await expect(departing).toHaveCount(0);
      if (pluginRow) {
        expect(await pluginRow.evaluate((row) => row.isConnected)).toBe(true);
        await pluginRow.dispose();
      }
      if (keepViewport) {
        await expect(
          sidebar.locator("button[data-solo-destination-id]:focus"),
        ).toBeInViewport({ ratio: 1 });
        await expect(anchor).toBeInViewport({ ratio: 1 });
        expect(
          Math.abs((await anchor.evaluate(offset)) - before),
        ).toBeLessThanOrEqual(1);
      } else {
        await expect(heading).toBeFocused();
        // Browser focus can align the heading to a fractional scroll pixel.
        await expect.poll(() => heading.evaluate(unseen)).toBe("");
      }
    });
});
