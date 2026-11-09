import { generateSecretKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

const solo = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  channelIds: [solo, "beta"],
  channelNames: { [solo]: "Alpha", beta: "Beta" },
  soloChannels: [solo],
  ownSoloChannels: [solo],
  dmLabels: true,
  historyCounts: { [solo]: 1, beta: 1 },
  enabledPlugins: ["buzz.drafts-and-sent"],
});

// Real paint geometry: DOM emulators cannot detect padding or baseline drift.
test("Team and Solo working badges share the painted row inset", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  for (const channelId of [solo, "beta"]) {
    app.observer(
      {
        kind: "turn_liveness",
        seq: 1,
        timestamp: new Date().toISOString(),
        channelId,
        sessionId: "S",
        turnId: channelId,
      },
      generateSecretKey(),
    );
  }
  const soloRow = page.locator(`[data-solo-menu-id="${solo}"]`);
  const teamRow = page
    .locator("[data-channel-sidebar-row]")
    .filter({ has: page.locator('[data-channel-id="beta"]') });
  for (const row of [soloRow, teamRow]) {
    await expect(row.locator("[data-channel-working]")).toBeVisible();
  }
  await page.mouse.move(0, 0);
  for (const [mode, width, fontSize] of [
    ["light", 1440, ""],
    ["dark", 900, "larger"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ mode, fontSize }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.dataset.fontSize = fontSize;
      },
      { mode, fontSize },
    );
    for (const row of [soloRow, teamRow]) {
      await expect
        .poll(() =>
          row.evaluate((element) => {
            const marker = element
              .querySelector("[data-channel-working]")
              .getBoundingClientRect();
            const rect = element.getBoundingClientRect();
            // The end token is a calc expression; resolve it through the painted pseudo-element.
            const fillEnd = parseFloat(
              getComputedStyle(element, "::before").right,
            );
            const root = parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            );
            return {
              center:
                Math.round(
                  (marker.y + marker.height / 2 - rect.y - rect.height / 2) *
                    100,
                ) / 100,
              inset:
                Math.round(
                  ((rect.right - fillEnd - marker.right) / root) * 100,
                ) / 100,
            };
          }),
        )
        .toEqual({ center: 0, inset: 0.5 });
    }
  }
});

// Leaves a draft so the Drafts & sent row shows its trailing count.
async function draftsWithCount(page) {
  await page.locator('button[data-channel-id="beta"]').click();
  await page
    .getByRole("textbox", { name: "Message #Beta", exact: true })
    .fill("Keep this draft");
  const drafts = page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: /^Drafts & sent/ });
  await expect(
    drafts.getByRole("img", { name: "1 draft", exact: true }),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  return drafts;
}

// Page rows paint on the navigation item itself; channel rows paint a fill
// inside their wrapper, beside the channel list's scrollbar gutter.
function columnsAgainstChannelRow(row) {
  const item = document.querySelector('button[data-channel-id="beta"]');
  const wrapper = item.closest("[data-channel-sidebar-row]");
  const fill = getComputedStyle(wrapper, "::before");
  const rect = (element, selector) =>
    element.querySelector(selector).getBoundingClientRect();
  // At fractional root sizes, layout snaps these edges to 1/64px units that
  // differ by a unit between rows; quarter pixels absorb that, and +0 drops -0.
  const round = (value) => Math.round(value * 4) / 4 + 0;
  const pill = row.getBoundingClientRect();
  const count = rect(row, '.navigation-item-trailing [role="img"]');
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const offset = (selector, side) =>
    round(rect(row, selector)[side] - rect(item, selector)[side]);
  // Glyph sizes may differ; the shared icon column is their center.
  const iconCenter = (element) => {
    const glyph = rect(element, "svg");
    return glyph.left + glyph.width / 2;
  };
  return {
    // WebKit places the count's text box in 1/64px layout units; 1/64rem
    // steps absorb that at every Interface size.
    inset: Math.round(((pill.right - count.right) / root) * 64) / 64,
    start: round(
      pill.left - wrapper.getBoundingClientRect().left - parseFloat(fill.left),
    ),
    icon: round(iconCenter(row) - iconCenter(item)),
    label: offset(".navigation-item-label", "left"),
    trailing: offset(".navigation-item-trailing", "right"),
    end: round(
      pill.right -
        wrapper.getBoundingClientRect().right +
        parseFloat(fill.right),
    ),
  };
}

// Only the page rows reserve the channel list's gutter. The segmented control
// still starts, and New still ends, the controls row inside the header's
// padding, and the control fills the row up to New. Where New wraps below it,
// the control fills the first line and New starts the second.
function controlsAgainstHeader(tablist) {
  const header = [...tablist.closest(".buzz-sidebar-navigation").children].find(
    (child) => child.contains(tablist),
  );
  const row = [...header.children].find((child) => child.contains(tablist));
  const control = tablist.closest(".buzz-tabs").getBoundingClientRect();
  const create = row
    .querySelector('button[aria-label="New"]')
    .getBoundingClientRect();
  const box = header.getBoundingClientRect();
  const padding = getComputedStyle(header);
  const margin = getComputedStyle(row);
  const start =
    box.left + parseFloat(padding.paddingLeft) + parseFloat(margin.marginLeft);
  const end =
    box.right -
    parseFloat(padding.paddingRight) -
    parseFloat(margin.marginRight);
  const wrapped = create.top >= control.bottom;
  const round = (value) => Math.round(value * 4) / 4 + 0;
  return {
    start: round(control.left - start),
    fill: round(
      (wrapped ? end : create.left - parseFloat(margin.columnGap)) -
        control.right,
    ),
    end: round(wrapped ? create.left - start : end - create.right),
  };
}

// Page rows reserve their gutter in a scroll container, which clips: their
// focus rings must still fit inside it and every other clipping ancestor.
function ringClearance(row) {
  const style = getComputedStyle(row);
  const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
  const box = row.getBoundingClientRect();
  let clearance = Infinity;
  for (let clip = row.parentElement; clip; clip = clip.parentElement) {
    if (getComputedStyle(clip).overflowX === "visible") continue;
    // Client sizes round to whole pixels at fractional root sizes. Borders and
    // scrollbars are whole pixels, so inset the exact box by those instead.
    const port = clip.getBoundingClientRect();
    const end = clip.offsetWidth - clip.clientLeft - clip.clientWidth;
    const bottom = clip.offsetHeight - clip.clientTop - clip.clientHeight;
    clearance = Math.min(
      clearance,
      box.left - ring - port.left - clip.clientLeft,
      box.top - ring - port.top - clip.clientTop,
      port.right - end - box.right - ring,
      port.bottom - bottom - box.bottom - ring,
    );
  }
  return clearance;
}

// Applies the color mode and Interface size settings through their saved
// preferences. The theme service re-applies both whenever it restores either,
// so neither can be set on the root directly.
async function setAppearance(page, mode, scale) {
  await page.evaluate(
    ({ mode, scale }) => {
      localStorage.setItem("buzz-appearance.v1", mode);
      localStorage.setItem("buzz-font-scale.v1", String(scale));
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
      );
    },
    { mode, scale },
  );
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-color-mode", mode);
  await expect(root).toHaveCSS("--buzz-text-scale", String(scale));
}

test("the Drafts & sent row shares channel rows' columns and inset without moving the header controls", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const drafts = await draftsWithCount(page);
  const scope = page.getByRole("tablist", { name: "Navigation scope" });
  const rows = page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button");
  // Keyboard modality draws focus rings.
  await page.keyboard.press("Tab");
  for (const [mode, width, scale] of [
    ["light", 1440, 1],
    ["dark", 900, 0.8],
    ["light", 900, 2],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await setAppearance(page, mode, scale);
    await expect
      .poll(() => drafts.evaluate(columnsAgainstChannelRow))
      .toEqual({
        inset: 0.375,
        start: 0,
        icon: 0,
        label: 0,
        trailing: 0,
        end: 0,
      });
    await expect
      .poll(() => scope.evaluate(controlsAgainstHeader))
      .toEqual({ start: 0, fill: 0, end: 0 });
    for (const row of [rows.first(), rows.last()]) {
      await row.focus();
      await expect(row).toHaveCSS("outline-style", "solid");
      await expect
        .poll(() => row.evaluate(ringClearance))
        .toBeGreaterThanOrEqual(0);
    }
  }
});

// The case above only exercises the scrollbar gutter where the engine happens
// to reserve one. This case runs where scrollbars take space and requires it.
test("beside a classic scrollbar, the Drafts & sent row ends in channel rows' column and the header controls stay put", {
  tag: "@classic-scrollbars",
}, async ({ page, app }) => {
  test.skip(
    process.platform !== "linux" && !process.env.BUZZ_CLASSIC_SCROLLBARS,
    "Set BUZZ_CLASSIC_SCROLLBARS=1 on a Mac whose scrollbars take space",
  );
  await page.goto(app.origin);
  const drafts = await draftsWithCount(page);
  const gutter = await page
    .getByRole("navigation", { name: "Subscribed channels", exact: true })
    .evaluate((list) => list.offsetWidth - list.clientWidth);
  expect(
    gutter,
    "the channel list's scrollbar gutter must take space",
  ).toBeGreaterThan(0);
  await expect
    .poll(() => drafts.evaluate(columnsAgainstChannelRow))
    .toMatchObject({ trailing: 0, end: 0 });
  await expect
    .poll(() =>
      page
        .getByRole("tablist", { name: "Navigation scope" })
        .evaluate(controlsAgainstHeader),
    )
    .toEqual({ start: 0, fill: 0, end: 0 });
});

test("a presence badge preserves the sidebar avatar center and header insets", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const row = page.locator('button[data-channel-id="dm-peer"]');
  await row.click();
  await expect
    .poll(() =>
      app.report.presenceSnapshots.some((snapshot) =>
        snapshot.filter.authors.includes(app.participants[0]),
      ),
    )
    .toBe(true);
  // Snapshot admission precedes the separate live presence REQ.
  await expect
    .poll(() => app.relay.hasPresenceRoute("primary", app.participants[0]))
    .toBe(true);
  app.presence("away");
  const avatar = row.locator(".buzz-avatar-status");
  await expect(avatar).toHaveAttribute("data-status", "away");
  await page
    .getByRole("button", { name: /^Manage members of /, exact: true })
    .click();
  await page
    .getByRole("button", { name: /^Open profile for Alice Fixture/ })
    .click();
  const headers = page.locator("header.panel-header");
  await expect(headers).toHaveCount(2);
  for (const [mode, fontSize] of [
    ["light", ""],
    ["dark", "larger"],
  ]) {
    await page.evaluate(
      ({ mode, fontSize }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.dataset.fontSize = fontSize;
      },
      { mode, fontSize },
    );
    await expect
      .poll(() =>
        avatar.evaluate((element) => {
          const row = element
            .closest("[data-channel-sidebar-row]")
            .getBoundingClientRect();
          const image = element
            .querySelector(".buzz-avatar")
            .getBoundingClientRect();
          const dot = element
            .querySelector(".buzz-avatar-status-dot")
            .getBoundingClientRect();
          return {
            offset: image.y + image.height / 2 - row.y - row.height / 2,
            square: dot.width === dot.height,
          };
        }),
      )
      .toEqual({ offset: 0, square: true });
    for (const header of await headers.all()) {
      await expect
        .poll(() =>
          header.evaluate((element) => {
            const frame = element.getBoundingClientRect();
            const tab = (
              element.querySelector('[role="tab"]') ??
              element.querySelector("[data-workspace-identity] button")
            ).getBoundingClientRect();
            // The joined panel's outer border is outside this header's band.
            const bandTop = frame.top;
            const separator = parseFloat(
              getComputedStyle(element).borderBottomWidth,
            );
            const bandBottom = frame.bottom - separator;
            return Math.abs(tab.top - bandTop - (bandBottom - tab.bottom));
          }),
        )
        .toBeLessThan(1);
    }
  }
  await openChannelDetails(page);
  const detailHeader = headers.last();
  await expect(detailHeader.getByRole("tab")).toHaveCount(2);
  let fittingInset;
  // Keep the desktop split visible; narrower windows use a fixed-width overlay.
  for (const [key, overflowing] of [
    ["End", false],
    ["Home", true],
  ]) {
    await page
      .getByRole("separator", {
        name: "Resize main and secondary panels",
        exact: true,
      })
      .press(key);
    const strip = detailHeader.locator(".buzz-tabs-list");
    await expect
      .poll(() => strip.evaluate((e) => e.scrollWidth > e.clientWidth))
      .toBe(overflowing);
    const inset = await detailHeader.evaluate((e) => {
      const frame = e.getBoundingClientRect();
      return (
        e.querySelector('[role="tab"]').getBoundingClientRect().top - frame.top
      );
    });
    if (fittingInset === undefined) fittingInset = inset;
    expect(inset).toBe(fittingInset);
  }
});

// The sidebar is fluid, like auto layout: rows and headings fill their list,
// a heading's label fills and its actions hug, and nothing floats over or
// reserves space for anything else. Every tab, at both width limits, has to
// hold that without per-tab adjustments.
test("every sidebar tab fills its rows and keeps heading actions in their row at any width", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const soloRow = page.locator(`[data-solo-menu-id="${solo}"]`);
  // A workspace gives Solo its own collapsible heading with actions.
  await page.getByRole("tab", { name: "Solo" }).click();
  await soloRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "New workspace" }).click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByRole("textbox", { name: "Workspace name" });
  await expect(field).toBeFocused();
  await field.fill("Work");
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(dialog).not.toBeVisible();

  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const layout = () =>
    sidebar.evaluate((aside) => {
      const shown = (element) => element.getClientRects().length > 0;
      const rows = [
        ...aside.querySelectorAll(
          '[data-channel-sidebar-row], [data-solo-menu-id]:not([data-solo-menu-id^="project-"])',
        ),
      ].filter(shown);
      if (!rows.length) return { problems: ["no rows"] };
      let scroller = rows[0];
      while (
        scroller &&
        !/auto|scroll/.test(getComputedStyle(scroller).overflowY)
      )
        scroller = scroller.parentElement;
      const bounds = scroller.getBoundingClientRect();
      const problems = [];
      if (scroller.scrollWidth > scroller.clientWidth)
        problems.push(
          `list scrolls sideways by ${scroller.scrollWidth - scroller.clientWidth}px`,
        );
      // Rows paint their fill on ::before, so its end is the visible edge.
      const spread = (values) => Math.max(...values) - Math.min(...values);
      const ends = rows
        .map((row) => getComputedStyle(row, "::before").right)
        .map((right, index) =>
          right.endsWith("px")
            ? rows[index].getBoundingClientRect().right - parseFloat(right)
            : undefined,
        )
        .filter((end) => end !== undefined);
      if (spread(ends) >= 1) problems.push(`rows end ${spread(ends)}px apart`);
      // Headings share one leading text inset and one trailing action edge.
      const textStarts = [];
      const actionEnds = [];
      for (const box of [
        ...rows,
        ...aside.querySelectorAll(".navigation-section-heading"),
      ].filter(shown)) {
        const rect = box.getBoundingClientRect();
        if (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5)
          problems.push(
            `${box.textContent.trim().slice(0, 24)} leaves the list`,
          );
      }
      const headings = [
        ...aside.querySelectorAll(".navigation-section-heading"),
      ].filter(shown);
      for (const heading of headings) {
        const frame = heading.getBoundingClientRect();
        const name = heading.textContent.trim().slice(0, 24) || "(actions)";
        const actions = heading.querySelector(
          ":scope > .navigation-section-heading-actions",
        );
        // Hidden quiet actions give their width to the label, like a hidden
        // auto layout child; their clipped buttons are not laid out parts.
        const collapsed =
          actions?.hasAttribute("data-navigation-reveal") &&
          getComputedStyle(actions).opacity === "0";
        if (collapsed) {
          const style = getComputedStyle(actions);
          const content =
            actions.clientWidth -
            parseFloat(style.paddingInlineStart) -
            parseFloat(style.paddingInlineEnd);
          if (content > 0.5)
            problems.push(`${name}: hidden actions take space`);
        }
        for (const part of heading.querySelectorAll("*")) {
          if (!shown(part)) continue;
          if (collapsed && actions.contains(part) && part !== actions) continue;
          const rect = part.getBoundingClientRect();
          if (rect.width <= 1 && rect.height <= 1) continue;
          if (/absolute|fixed/.test(getComputedStyle(part).position))
            problems.push(`${name}: a part floats over the row`);
          if (
            rect.left < frame.left - 0.5 ||
            rect.right > frame.right + 0.5 ||
            rect.top < frame.top - 0.5 ||
            rect.bottom > frame.bottom + 0.5
          )
            problems.push(`${name}: a part sits outside its heading`);
        }
        const label = heading.querySelector(
          ":scope > .navigation-section-heading-label",
        );
        // The trigger, inside its <details> when a section collapses natively.
        const trigger = label?.querySelector(
          ":scope > button, :scope > details > summary",
        );
        if (trigger && shown(trigger)) {
          const style = getComputedStyle(trigger);
          // Width kept for actions is a reservation, not an inset.
          if (
            parseFloat(style.paddingInlineEnd) >
            parseFloat(style.paddingInlineStart)
          )
            problems.push(`${name}: reserves trailing space`);
          // Where the title's first glyph paints, whatever wraps it.
          const walker = document.createTreeWalker(
            trigger,
            NodeFilter.SHOW_TEXT,
            {
              // Skip blank and visually hidden text.
              acceptNode: (node) =>
                node.data.trim() &&
                node.parentElement.getBoundingClientRect().width > 1
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_SKIP,
            },
          );
          const text = walker.nextNode();
          if (text) {
            const range = document.createRange();
            range.setStart(text, text.data.search(/\S/));
            range.setEnd(text, text.data.search(/\S/) + 1);
            textStarts.push(range.getBoundingClientRect().left);
          }
        }
        const buttons =
          actions && !collapsed ? [...actions.children].filter(shown) : [];
        buttons.forEach((button, index) => {
          const next = buttons[index + 1];
          if (
            next &&
            button.getBoundingClientRect().right >
              next.getBoundingClientRect().left + 0.5
          )
            problems.push(`${name}: actions overlap`);
        });
        if (buttons.length)
          actionEnds.push(buttons.at(-1).getBoundingClientRect().right);
      }
      if (textStarts.length && spread(textStarts) >= 1)
        problems.push(`heading text starts ${spread(textStarts)}px apart`);
      if (actionEnds.length && spread(actionEnds) >= 1)
        problems.push(`heading actions end ${spread(actionEnds)}px apart`);
      // Where the tab's first row or heading starts: an empty band moves it.
      const start = Math.min(
        ...[...rows, ...headings].map((box) => box.getBoundingClientRect().top),
      );
      return {
        end: ends[0],
        problems,
        rows: rows.length,
        headings: headings.length,
        start: Math.round(start - bounds.top + scroller.scrollTop),
      };
    });
  const separator = page.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  for (const limit of ["Home", "End"]) {
    await separator.focus();
    await separator.press(limit);
    const starts = {};
    const ends = [];
    for (const tab of ["All", "Team", "Solo"]) {
      await page.getByRole("tab", { name: tab }).click();
      await page.mouse.move(0, 0);
      const result = await layout();
      expect(result.problems, `${tab} at ${limit}`).toEqual([]);
      expect(result.rows, `${tab} at ${limit}`).toBeGreaterThan(0);
      expect(result.headings, `${tab} at ${limit}`).toBeGreaterThan(0);
      ends.push(result.end);
      starts[tab] = result.start;
    }
    // Every tab's rows end on the same edge at a given width.
    expect(Math.max(...ends) - Math.min(...ends), limit).toBeLessThan(1);
    // Solo starts its list exactly where Team does.
    expect(starts.Solo, limit).toBe(starts.Team);
  }

  // No heading control is ever invisible: hovering any heading reveals every
  // button in it, so nothing clickable or focusable hides behind a rule that
  // can never switch on.
  for (const tab of ["All", "Team", "Solo"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    // Headings leave creation to New beside the tabs.
    await expect(
      sidebar.getByRole("button", { name: "New chat or workspace" }),
    ).toHaveCount(0);
    const headings = sidebar.locator(".navigation-section-heading");
    for (let index = 0; index < (await headings.count()); index += 1) {
      const heading = headings.nth(index);
      if (!(await heading.isVisible())) continue;
      await heading.hover();
      await expect
        .poll(
          () =>
            heading.evaluate((row) =>
              [...row.querySelectorAll("button")]
                .filter((button) => button.getClientRects().length)
                .filter((button) => {
                  let opacity = 1;
                  for (let node = button; node; node = node.parentElement)
                    opacity *= parseFloat(getComputedStyle(node).opacity);
                  return opacity < 1;
                })
                .map((button) => button.getAttribute("aria-label")),
            ),
          { message: `${tab} heading ${index} hides a control` },
        )
        .toEqual([]);
    }
  }
  await page.getByRole("tab", { name: "Solo", exact: true }).click();

  // A workspace's actions reveal on hover, centered on its own heading.
  const nav = page.getByRole("navigation", { name: "Solo conversations" });
  const work = nav.getByRole("button", { name: "Work", exact: true });
  const create = nav.getByRole("button", { name: "New chat in Work" });
  const options = nav.getByRole("button", { name: "Actions for Work" });
  // What the eye sees: every ancestor's opacity multiplies.
  const seen = (locator) =>
    locator.evaluate((element) => {
      let opacity = 1;
      for (let node = element; node; node = node.parentElement)
        opacity *= parseFloat(getComputedStyle(node).opacity);
      return opacity;
    });
  await page.mouse.move(0, 0);
  for (const action of [create, options])
    await expect.poll(() => seen(action)).toBe(0);
  await work.hover();
  for (const action of [create, options])
    await expect.poll(() => seen(action)).toBe(1);
  const center = (locator) =>
    locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.y + rect.height / 2;
    });
  await expect
    .poll(async () => Math.abs((await center(create)) - (await center(work))))
    .toBeLessThan(1);
  // Revealed, the actions take their width back: after the title, in the row.
  const placed = await options.evaluate((button) => {
    const row = button
      .closest(".navigation-section-heading")
      .getBoundingClientRect();
    const actions = button.parentElement.closest(
      ".navigation-section-heading-actions",
    );
    const title = actions.previousElementSibling.getBoundingClientRect();
    const slot = actions.getBoundingClientRect();
    return (
      title.right <= slot.left + 0.5 &&
      [...actions.querySelectorAll("button")].every((part) => {
        const rect = part.getBoundingClientRect();
        return rect.left >= slot.left - 0.5 && rect.right <= row.right + 0.5;
      })
    );
  });
  expect(placed).toBe(true);
});
