import { test, expect } from "./fixture.mjs";
import {
  expectMessageActionsHidden as hidden,
  hoverMessage,
} from "./message-actions.mjs";
import { open, settle, virtuaIdle, wheel } from "./timeline.mjs";
import { animationsSettled } from "./animations.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 3, beta: 1 },
});

const actionsFor = (row) =>
  row.getByRole("group", { name: "Message actions", includeHidden: true });
const shown = (actions) =>
  expect
    .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
    .toBe(true);
// The bar sits above its bubble, inside the page.
const above = (actions) =>
  expect
    .poll(() =>
      actions.evaluate((bar) => {
        const bubble = bar
          .closest("[data-layout]")
          .querySelector("[data-message-action-anchor]")
          .getBoundingClientRect();
        const rect = bar.getBoundingClientRect();
        return (
          rect.top < bubble.top &&
          rect.bottom < bubble.bottom &&
          rect.left >= 0 &&
          rect.right <= document.documentElement.clientWidth
        );
      }),
    )
    .toBe(true);
// Browser-only: measured space, real top-layer hit testing, and responsive
// placement cannot be established in a DOM emulator.
for (const own of [true, false]) {
  test(`actions stay above ${own ? "own" : "received"} bubbles across pane sizes`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const first = app.append("primary", "alpha", "Short", true, own);
    const event = app.append("primary", "alpha", "Hi", true, own);
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"]`,
    );
    const actions = actionsFor(row);
    await expect(row.locator("[data-stack-previous]")).toBeVisible();
    await settle(page);
    // Enter the row's empty side before any bubble hover, then after reveal.
    const whitespace = await row.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const bubble = node
        .querySelector("[data-message-action-anchor]")
        .getBoundingClientRect();
      return {
        x:
          bubble.left - rect.left > rect.right - bubble.right
            ? (rect.left + bubble.left) / 2
            : (bubble.right + rect.right) / 2,
        y: bubble.top + bubble.height / 2,
      };
    });
    await page.mouse.move(whitespace.x, whitespace.y);
    await hidden(actions);
    await hoverMessage(row);
    await shown(actions);
    await page.mouse.move(whitespace.x, whitespace.y);
    await hidden(actions);
    // The first row's wider byline must not pull its short bubble off the
    // continuation's edge. This needs rendered layout, not DOM-only coverage.
    await expect
      .poll(async () => {
        const firstBubble = await page
          .locator(
            `[data-channel-timeline] [data-message-id="${first.id}"] [data-message-action-anchor]`,
          )
          .boundingBox();
        const nextBubble = await row
          .locator("[data-message-action-anchor]")
          .boundingBox();
        return Math.abs(
          own
            ? firstBubble.x +
                firstBubble.width -
                nextBubble.x -
                nextBubble.width
            : firstBubble.x - nextBubble.x,
        );
      })
      .toBeLessThan(1);
    for (const mode of ["light", "dark"]) {
      await page.locator("html").evaluate((node, mode) => {
        node.dataset.colorMode = mode;
      }, mode);
      for (const direction of ["ltr", "rtl"]) {
        await row.evaluate((node, direction) => {
          node.dir = direction;
        }, direction);
        await page.mouse.move(0, 0);
        await hidden(actions);
        await expect(row.locator("[data-layout]")).not.toHaveAttribute(
          "data-actions-revealed",
          "",
        );
        const bubble = row.locator("[data-message-action-anchor]");
        const restingFill = await bubble.evaluate(
          (node) => getComputedStyle(node).backgroundColor,
        );
        await row.getByText("Hi", { exact: true }).hover();
        await above(actions);
        await expect(bubble).not.toHaveCSS("background-color", restingFill);
        await animationsSettled(actions);
        // A slow diagonal from a short bubble must reach both toolbar ends.
        for (const label of ["Add reaction", "More message actions"]) {
          await hoverMessage(row);
          const button = await actions
            .getByRole("button", { name: label, exact: true })
            .boundingBox();
          await page.mouse.move(
            button.x + button.width / 2,
            button.y + button.height / 2,
            { steps: 30 },
          );
          await shown(actions);
        }
        // The route to a wider toolbar retains an active hover only. It must
        // neither summon actions on its own nor catch clicks beneath it.
        const path = await actions.evaluate((bar) => {
          const bubble = bar
            .closest("[data-layout]")
            .querySelector("[data-message-action-anchor]")
            .getBoundingClientRect();
          const toolbar = bar.getBoundingClientRect();
          const row = bar.closest("[data-layout]").getBoundingClientRect();
          const y = bubble.top + bubble.height / 2;
          const fraction =
            (y - toolbar.bottom) / (bubble.bottom - toolbar.bottom);
          const left = toolbar.left + (bubble.left - toolbar.left) * fraction;
          const right =
            toolbar.right + (bubble.right - toolbar.right) * fraction;
          return {
            x:
              toolbar.left < bubble.left
                ? (Math.max(left, row.left) + bubble.left) / 2
                : (bubble.right + Math.min(right, row.right)) / 2,
            y,
          };
        });
        await page.mouse.move(0, 0);
        await hidden(actions);
        await page.mouse.move(path.x, path.y);
        await hidden(actions);
        // This point can also cross an avatar. Leave its preview before
        // targeting the bubble beneath the interactive portal.
        await page.mouse.move(0, 0);
        await expect(
          page.getByRole("dialog", { name: /profile preview$/ }),
        ).toBeHidden();
        await hoverMessage(row);
        await shown(actions);
        await page.mouse.move(path.x, path.y, { steps: 10 });
        await shown(actions);
        expect(
          await actions.evaluate(
            (bar, point) =>
              bar.contains(document.elementFromPoint(point.x, point.y)),
            path,
          ),
        ).toBe(false);
        if (direction === "ltr")
          await page.screenshot({
            path: test.info().outputPath(`message-actions-above-${mode}.png`),
          });
      }
    }
    await row.evaluate((node) => {
      node.dir = "ltr";
    });
    await page.setViewportSize({ width: 390, height: 950 });
    await settle(page);
    await row.getByText("Hi", { exact: true }).hover();
    await above(actions);
    await expect(actions).not.toHaveCSS("box-shadow", "none");
    await expect(actions).not.toHaveCSS("backdrop-filter", "none");
    // Park the pointer first: after the resize, its narrow-pane position can
    // land on a sidebar activity badge whose hover popover covers the row.
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width: 1000, height: 1200 });
    await page.locator("html").evaluate((node) => {
      node.style.setProperty("--buzz-text-scale", "2");
    });
    await settle(page);
    await row.getByText("Hi", { exact: true }).hover();
    await above(actions);
    const menu = actions.getByRole("button", { name: "More message actions" });
    await menu.focus();
    await menu.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath("message-actions-raised-enlarged.png"),
    });
    await page.locator("html").evaluate((node) => {
      node.style.removeProperty("--buzz-text-scale");
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await above(actions);
  });
}

// Browser-only: caption and attachment content share one raised action position
// while retaining native hit testing and an uninterrupted pointer path.
// A first-of-group received message's name opens the sender's profile, so the
// bar moves off it. Browser-only: whether a bar beside the bubble still meets
// a slow diagonal, and whether the name beneath takes the click, are top-layer
// hit tests on measured geometry.
test("actions clear a short received message's name and stay reachable beside it", async ({
  page,
  app,
}) => {
  await open(page, app);
  // An own message first, so the received "ok" starts a group with a byline.
  app.append("primary", "alpha", "Mine", true, true);
  const event = app.append("primary", "alpha", "ok", true, false);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const actions = actionsFor(row);
  const name = row.locator("strong > [role='button']");
  await expect(name).toBeVisible();
  await settle(page);
  await hoverMessage(row);
  await shown(actions);
  await animationsSettled(actions);
  const [nameBox, bar] = await Promise.all([
    name.boundingBox(),
    actions.boundingBox(),
  ]);
  // The bar is at the name's height but entirely beside it.
  expect(bar.y + bar.height).toBeGreaterThan(nameBox.y);
  expect(bar.x).toBeGreaterThan(nameBox.x + nameBox.width);
  // A slow diagonal from the bubble crosses the byline to either end.
  for (const label of ["Add reaction", "More message actions"]) {
    await hoverMessage(row);
    const button = await actions
      .getByRole("button", { name: label, exact: true })
      .boundingBox();
    await page.mouse.move(
      button.x + button.width / 2,
      button.y + button.height / 2,
      { steps: 30 },
    );
    await shown(actions);
  }
  // The byline keeps the hover only: with the bar shown, the name itself
  // still takes the click and opens the profile.
  await hoverMessage(row);
  await name.hover();
  await shown(actions);
  const author = await name.innerText();
  await name.click();
  await expect(
    page
      .getByRole("complementary", { name: "Profile", exact: true })
      .getByRole("heading", { name: author, exact: true }),
  ).toBeVisible();
});

for (const own of [false, true]) {
  test(`captioned ${own ? "own" : "received"} attachments keep their actions reachable`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const event = app.append(
      "primary",
      "alpha",
      "A caption\nwith three lines\n[Caption reference](https://example.com/caption)",
      true,
      own,
      undefined,
      undefined,
      [
        [
          "imeta",
          "url https://fixture.test/report.pdf",
          "m application/pdf",
          "filename report.pdf",
        ],
      ],
    );
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"]`,
    );
    const attachment = row.locator("[data-message-attachments] > *").first();
    const caption = row.locator("[data-message-action-anchor]").first();
    const actions = actionsFor(row);
    await expect(attachment).toBeVisible();
    await settle(page);
    await attachment.hover();
    await shown(actions);
    await above(actions);
    await animationsSettled(actions);
    const target = actions.getByRole("button", {
      name: "More message actions",
    });
    const button = await target.boundingBox();
    // Travel from the attachment through its caption to the shared toolbar.
    await page.mouse.move(
      button.x + button.width / 2,
      button.y + button.height / 2,
      { steps: 30 },
    );
    await shown(actions);
    const anchored = await actions.evaluate((bar) =>
      bar.getBoundingClientRect().toJSON(),
    );
    await target.click();
    await expect(page.getByRole("menu")).toBeVisible();
    // Opening the menu replays the bar's entry animation, which animates its
    // gap; the bar returns to its resting width and place a frame after it.
    await expect
      .poll(() =>
        actions.evaluate((bar) => bar.getBoundingClientRect().toJSON()),
      )
      .toEqual(anchored);
    // The open menu's backdrop owns this point; use real pointer travel rather
    // than asking Playwright to hover the intentionally covered caption.
    const coveredCaption = await caption.boundingBox();
    await page.mouse.move(
      coveredCaption.x + coveredCaption.width / 2,
      coveredCaption.y + coveredCaption.height / 2,
    );
    expect(
      await actions.evaluate((bar) => bar.getBoundingClientRect().toJSON()),
    ).toEqual(anchored);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    // Caption and attachment hover share one stable above-message location.
    await page.mouse.click(0, 0);
    await caption.hover();
    await shown(actions);
    await above(actions);
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width: 390, height: 950 });
    await settle(page);
    await attachment.hover();
    await shown(actions);
    await above(actions);
    await animationsSettled(actions);
    const reference = row.getByRole("link", { name: "Caption reference" });
    // The hovered media's toolbar must not take hits from the caption above it.
    expect(
      await reference.evaluate((node) => {
        const rect = node.getClientRects()[0];
        return node.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      }),
    ).toBe(true);
    await reference.evaluate((node) =>
      node.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          node.dataset.clicked = "true";
        },
        { once: true },
      ),
    );
    await reference.click();
    await expect(reference).toHaveAttribute("data-clicked", "true");
    await page
      .getByRole("textbox", { name: "Message #Alpha", exact: true })
      .click();
    const captionBox = await caption.boundingBox();
    const attachmentBox = await attachment.boundingBox();
    // Use the interior beside the shorter caption, clear of Chromium's
    // fractional hit-test expansion at the tiny inter-block margin.
    const contentGap = {
      x: own
        ? (attachmentBox.x + captionBox.x) / 2
        : (captionBox.x +
            captionBox.width +
            attachmentBox.x +
            attachmentBox.width) /
          2,
      y: captionBox.y + captionBox.height / 2,
    };
    expect(
      await row.evaluate((node, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return (
          node.contains(hit) &&
          !!hit?.closest("[data-message-payload]") &&
          !hit.closest(
            "[data-message-action-anchor], [data-message-attachments] > *",
          )
        );
      }, contentGap),
    ).toBe(true);
    // A gap cannot activate actions, but must retain them after media hover.
    await page.mouse.move(contentGap.x, contentGap.y);
    await hidden(actions);
    await attachment.hover();
    await shown(actions);
    await page.mouse.move(contentGap.x, contentGap.y, { steps: 10 });
    await shown(actions);
    // Leave both the content and its route to the wider toolbar. Returning to
    // the content gap alone must not reactivate actions.
    const raised = await actions.boundingBox();
    const outside = {
      x: own
        ? Math.min(captionBox.x, attachmentBox.x, raised.x) - 4
        : Math.max(
            captionBox.x + captionBox.width,
            attachmentBox.x + attachmentBox.width,
            raised.x + raised.width,
          ) + 4,
      y: contentGap.y,
    };
    await page.mouse.move(outside.x, outside.y, { steps: 10 });
    await hidden(actions);
    await page.mouse.move(contentGap.x, contentGap.y);
    await hidden(actions);
    await attachment.hover();
    await shown(actions);
    await page.mouse.move(contentGap.x, contentGap.y, { steps: 10 });
    await shown(actions);
    const raisedButton = await target.boundingBox();
    await page.mouse.move(
      raisedButton.x + raisedButton.width / 2,
      raisedButton.y + raisedButton.height / 2,
      { steps: 30 },
    );
    await shown(actions);
    await target.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.mouse.move(contentGap.x, contentGap.y);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(target).toBeFocused();
    await shown(actions);
    await page.mouse.move(contentGap.x, contentGap.y + 1);
    await shown(actions);
  });
}

// Browser-only: top-layer painting/hit testing across containment, real scrolling,
// and stable header geometry cannot be established in jsdom.
test("thread actions and growing reactions paint beyond the scroller without moving text", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  let last;
  for (let i = 0; i < 7; i++) {
    last = app.append(
      "primary",
      "alpha",
      `Floating reply ${i}\n\nSecond paragraph\n\nThird paragraph`,
      false,
      i === 6,
      root.id,
    );
  }
  await open(page, app);
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const scroller = panel.getByRole("region", { name: "Thread messages" });
  const row = panel.locator(`[data-message-id="${last.id}"]`);
  const actions = actionsFor(row);
  await expect(row).toBeVisible();
  await hoverMessage(row);
  await row.locator("[data-message-action-anchor]").click();
  await settle(page, scroller);
  // Leave the bubble below the bottom edge. Keyboard focus must still expose
  // its toolbar across that edge; whitespace can no longer reveal it.
  await actions.evaluate((bar) => {
    const anchor = bar
      .closest("[data-layout]")
      .querySelector("[data-message-action-anchor]");
    const scroller = bar.closest("[data-message-scroller]");
    scroller.scrollTop +=
      anchor.getBoundingClientRect().top -
      scroller.getBoundingClientRect().bottom +
      -14;
  });
  await settle(page, scroller);
  const restingHeight = (await row.boundingBox()).height;
  const bounds = await scroller.boundingBox();
  await page.keyboard.press("ArrowRight");
  await actions
    .getByRole("button")
    .first()
    .evaluate((button) => button.focus({ preventScroll: true }));
  await shown(actions);
  await expect
    .poll(() =>
      actions.evaluate((bar) => {
        const anchor = bar
          .closest("[data-layout]")
          .querySelector("[data-message-action-anchor]")
          .getBoundingClientRect();
        const rect = bar.getBoundingClientRect();
        const edge = bar
          .closest("[data-message-scroller]")
          .getBoundingClientRect().bottom;
        const button = bar.querySelector("button").getBoundingClientRect();
        return {
          anchored:
            Math.abs(
              anchor.top +
                parseFloat(getComputedStyle(bar).scrollMarginBlockStart) -
                rect.bottom,
            ) < 1,
          crosses: rect.top < edge && rect.bottom > edge + 4,
          hit: bar.contains(
            document.elementFromPoint(button.x + button.width / 2, edge + 4),
          ),
        };
      }),
    )
    .toEqual({ anchored: true, crosses: true, hit: true });
  expect((await row.boundingBox()).height).toBe(restingHeight);
  // Wait for the entrance transform before choosing a pointer hit coordinate.
  await animationsSettled(actions);
  const toolbarBounds = await actions.boundingBox();
  // A real padding click switches to pointer input without invoking an action.
  const padding = {
    x: toolbarBounds.x + toolbarBounds.width / 2,
    y: toolbarBounds.y + toolbarBounds.height - 2,
  };
  await page.mouse.move(padding.x, padding.y);
  await page.mouse.click(padding.x, padding.y);
  await shown(actions);
  // Moving onto the escaped controls must keep the row's reveal state alive.
  const quick = actions.getByRole("button", {
    name: "Add reaction",
    exact: true,
  });
  const quickBox = await quick.boundingBox();
  await page.mouse.move(
    quickBox.x + quickBox.width / 2,
    Math.min(quickBox.y + quickBox.height - 1, bounds.y + bounds.height + 1),
  );
  await shown(actions);
  await page.screenshot({
    path: test.info().outputPath("thread-floating-actions.png"),
  });
  // Native top-layer controls must retain the owning history's wheel behavior.
  const beforeWheel = await scroller.evaluate((node) => node.scrollTop);
  await wheel(page, -100, scroller);
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollTop))
    .toBeLessThan(beforeWheel);
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  // Closed bars stay laid out in every row; only open ones carry the glass.
  await expect(actions).toHaveCSS("backdrop-filter", "none");
});

// Browser-only: the sticky thread header, native top-layer toolbar and emoji
// picker share viewport geometry that a DOM test cannot exercise. Before this
// regression, the first thread message hid its actions above that header.
test("thread-root actions nest from the message top edge", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  app.append(
    "primary",
    "alpha",
    `First visible reply\n\n${"More reply content.\n\n".repeat(30)}`,
    false,
    false,
    root.id,
  );
  await open(page, app);
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const scroller = panel.getByRole("region", { name: "Thread messages" });
  const row = panel.locator(`[data-message-id="${root.id}"]`);
  const actions = actionsFor(row);
  await expect(row).toBeVisible();
  await settle(page, scroller);
  await hoverMessage(row);
  await shown(actions);
  await expect
    .poll(() =>
      actions.evaluate((bar) => {
        const row = bar.closest("[data-layout]");
        const toolbar = bar.getBoundingClientRect();
        const viewport = bar
          .closest("[data-message-scroller]")
          .getBoundingClientRect();
        return {
          nested:
            Math.abs(toolbar.top - row.getBoundingClientRect().top - 8) < 1,
          visible:
            toolbar.top >= viewport.top && toolbar.bottom <= viewport.bottom,
        };
      }),
    )
    .toEqual({ nested: true, visible: true });
  await actions.getByRole("button", { name: "Add reaction" }).click();
  await expect(page.locator("em-emoji-picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await actions.getByRole("button").first().focus();
  await page.mouse.move(0, 0);
  await row.evaluate((node) => {
    const scroller = node.closest("[data-message-scroller]");
    scroller.scrollTop +=
      node.getBoundingClientRect().bottom -
      scroller.getBoundingClientRect().top +
      8;
  });
  await settle(page, scroller);
  await expect
    .poll(() =>
      row.evaluate(
        (node) =>
          node.getBoundingClientRect().bottom <=
          node.closest("[data-message-scroller]").getBoundingClientRect().top,
      ),
    )
    .toBe(true);
  await hidden(actions);
});

test("compact timeline actions slide under the top edge, track scrolling and preserve keyboard order", async ({
  page,
  app,
  browserName,
}) => {
  // Exercise the raised fallback with a full-width bubble in a compact pane.
  await page.setViewportSize({ width: 1000, height: 850 });
  const target = app.append(
    "primary",
    "alpha",
    `Floating timeline target\n\n${"A longer message fills this reading column. ".repeat(8)}\n\nLast paragraph`,
    false,
    true,
  );
  for (let i = 0; i < 8; i++)
    app.append(
      "primary",
      "alpha",
      `Following ${i}\n\nExtra space\n\nAnother paragraph\n\nLast paragraph`,
      false,
      false,
    );
  await open(page, app);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${target.id}"]`,
  );
  const actions = actionsFor(row);
  const scroller = page.getByRole("region", {
    name: "Channel message history",
  });
  await row.scrollIntoViewIfNeeded();
  await settle(page, scroller);
  if (browserName === "chromium") {
    await page.mouse.move(0, 0);
    const avatar = row
      .getByRole("button", { name: /^View .* profile$/ })
      .first();
    await avatar.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(avatar).toBeFocused();
    const preview = page.getByRole("dialog", { name: /profile preview$/ });
    await expect(preview).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(
      preview.getByRole("button", { name: "View profile", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(avatar).toBeFocused();
    await shown(actions);
    await page.keyboard.press("Tab");
    await expect(actions.getByRole("button").first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(avatar).toBeFocused();
  }
  await actions.evaluate((bar) => {
    const scroller = bar.closest("[data-message-scroller]");
    scroller.scrollTop +=
      bar
        .closest("[data-layout]")
        .querySelector("[data-message-action-anchor]")
        .getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      -10;
  });
  // That assignment is one scroll event, so Virtua holds the list's pointer
  // events at none for 150ms after it. Settled geometry alone can return inside
  // that window, and the raw move below is not retried against a hit target.
  await virtuaIdle(page, scroller);
  const bounds = await scroller.boundingBox();
  const bubbleBounds = await row
    .locator("[data-message-action-anchor]")
    .boundingBox();
  await page.mouse.move(bubbleBounds.x + bubbleBounds.width / 2, bounds.y + 35);
  await shown(actions);
  await expect
    .poll(() =>
      actions.evaluate((bar) => {
        const rect = bar.getBoundingClientRect();
        const edge = bar
          .closest("[data-message-scroller]")
          .getBoundingClientRect().top;
        const x = rect.x + rect.width / 2;
        // The part above the edge is clipped: the header keeps its clicks.
        return (
          rect.top < edge - 2 &&
          bar.contains(document.elementFromPoint(x, rect.bottom - 2)) &&
          !bar.contains(document.elementFromPoint(x, edge - 2))
        );
      }),
    )
    .toBe(true);
  // A focused row that remains mounted must not leave actions over the header.
  await actions.getByRole("button").first().focus();
  await page.mouse.move(0, 0);
  await scroller.evaluate((node) => {
    node.scrollTop += 300;
  });
  await settle(page, scroller);
  await expect(actions).toHaveCSS("opacity", "0");
  await scroller.hover();
  await wheel(page, -300, scroller);
  await row.getByText("Floating timeline target", { exact: true }).hover();
  await shown(actions);
  // RTL follows the bubble's leading edge while retaining the pane gutter.
  await row.evaluate((node) => {
    node.dir = "rtl";
  });
  await page.setViewportSize({ width: 1000, height: 850 });
  await row.getByText("Floating timeline target", { exact: true }).hover();
  await expect
    .poll(() =>
      actions.evaluate((bar) => {
        const row = bar.closest("[data-layout]");
        const bubble = row.querySelector("[data-message-action-anchor]");
        const gap = parseFloat(getComputedStyle(bar).scrollMarginInlineEnd);
        return Math.abs(
          bar.getBoundingClientRect().left -
            Math.max(
              bubble.getBoundingClientRect().left -
                parseFloat(getComputedStyle(bar).scrollMarginBlockStart),
              row.closest("[data-message-scroller]").getBoundingClientRect()
                .left + gap,
            ),
        );
      }),
    )
    .toBeLessThan(1);
});

// Browser-only: Base UI portals, native focus events and top-layer stacking.
test("keyboard search covers a toolbar under the pointer and restores its actions", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append("primary", "alpha", "Hovered Reply modal check");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const actions = actionsFor(row);
  const reply = actions.getByRole("button", { name: "Reply", exact: true });
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  for (const opener of [composer, reply]) {
    await hoverMessage(row);
    await shown(actions);
    await opener.focus();
    await reply.hover();
    const bounds = await reply.boundingBox();
    const point = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    await page.keyboard.press(`${modifier}+k`);
    const dialog = page.getByRole("dialog", {
      name: "Search Buzz",
      exact: true,
    });
    await expect(
      dialog.getByRole("combobox", { name: "Search Buzz" }),
    ).toBeFocused();

    await hidden(actions);
    expect(
      await actions.evaluate(
        (bar, point) =>
          bar.contains(document.elementFromPoint(point.x, point.y)),
        point,
      ),
    ).toBe(false);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await hoverMessage(row);
    await reply.hover();
    await shown(actions);
  }
  await reply.click();
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
});

test("menus keep their actions showing; pickers and dialogs cover them", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Floating portal check",
    true,
    false,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const actions = actionsFor(row);
  await page.mouse.move(0, 0);
  const bubble = row.locator("[data-message-action-anchor]");
  const restingFill = await bubble.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  await hoverMessage(row);
  const trigger = actions.getByRole("button", { name: "More message actions" });
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.hover();
  await expect(bubble).not.toHaveCSS("background-color", restingFill);
  await shown(actions);
  // The bar's own menu opens beside it and leaves it showing.
  await expect(actions).toHaveCSS("visibility", "visible");
  // A modal opened over that menu still covers the bar.
  await page.keyboard.press("ControlOrMeta+k");
  const searchDialog = page.getByRole("dialog", {
    name: "Search Buzz",
    exact: true,
  });
  await expect(searchDialog).toBeVisible();
  // The modal hides the menu from the accessibility tree, not the page.
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await hidden(actions);
  await page.keyboard.press("Escape");
  await expect(searchDialog).toBeHidden();
  await expect(row.locator("[data-layout]")).toHaveAttribute(
    "data-actions-revealed",
    "",
  );
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const composerBox = await composer.boundingBox();
  // The menu's modal overlay receives the outside click before the editor does.
  await page.mouse.click(composerBox.x + 20, composerBox.y + 10);
  await expect(menu).toBeHidden();
  await composer.click();
  await expect(actions).toHaveCSS("opacity", "0");
  await hoverMessage(row);
  await actions
    .getByRole("button", { name: "Add reaction", exact: true })
    .click();
  const search = page.locator('em-emoji-picker input[type="search"]');
  await expect(search).toBeVisible();
  await search.hover();
  await expect(bubble).not.toHaveCSS("background-color", restingFill);
  await shown(actions);
  await hidden(actions);
  await expect(row.locator("[data-layout]")).toHaveAttribute(
    "data-actions-revealed",
    "",
  );
  await page.mouse.click(composerBox.x + 20, composerBox.y + 10);
  await expect(search).toBeHidden();
  await composer.click();
  await expect(actions).toHaveCSS("opacity", "0");
  // The plugin restores the external reaction trigger immediately on Escape;
  // this must not race the toolbar's overlay suppression in either engine.
  await hoverMessage(row);
  const reaction = actions.getByRole("button", {
    name: "Add reaction",
    exact: true,
  });
  await reaction.focus();
  await reaction.press("Enter");
  await expect(search).toBeFocused();
  await hidden(actions);
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(reaction).toBeFocused();
  await expect(actions).toBeVisible();
  // Keep the pointer on the row while invoking the dialog by keyboard.
  await row.hover();
  await trigger.focus();
  await trigger.press("Enter");
  await page
    .getByRole("menuitem", { name: "Report", exact: true })
    .press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Report message",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await hidden(actions);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  // Pointer dismissal restores focus without pinning an unhovered toolbar.
  await expect(actions).toHaveCSS("opacity", "0");
  await trigger.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await shown(actions);
  const own = app.append("primary", "alpha", "Delete confirmation check");
  const ownRow = page.locator(
    `[data-channel-timeline] [data-message-id="${own.id}"]`,
  );
  const ownActions = actionsFor(ownRow);
  await hoverMessage(ownRow);
  await ownActions
    .getByRole("button", { name: "More message actions" })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .press("Enter");
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete message?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await hidden(ownActions);
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
});

// Browser-only: real top-layer visibility and popup interaction through the
// actual shell and emoji plugin, including suppression under a still pointer.
test("profile menus and composer pickers keep message hover actions out of the way", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append("primary", "alpha", "Background hover target");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const actions = actionsFor(row);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const profile = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  for (const [width, mode] of [
    [390, "light"],
    [900, "dark"],
    [1440, "light"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme: mode });
    await settle(page);
    await hoverMessage(row);
    await shown(actions);
    await profile.focus();
    await profile.press("Enter");
    const menu = page.locator("[data-profile-menu]");
    const appearance = menu.getByRole("menuitem", {
      name: "Appearance",
      exact: true,
    });
    await expect(appearance).toBeVisible();
    await hidden(actions);
    await expect(row.locator("[data-layout]")).not.toHaveAttribute(
      "data-actions-revealed",
    );
    const point = await row
      .locator("[data-message-action-anchor]")
      .boundingBox();
    await page.mouse.move(
      point.x + point.width / 2,
      point.y + point.height / 2,
    );
    await appearance.click();
    await expect(
      page.getByRole("menu", { name: "Appearance", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await hoverMessage(row);
    await shown(actions);
    await expect(actions).toHaveCSS("pointer-events", "auto");

    const emoji = page
      .locator("form")
      .filter({ has: composer })
      .getByRole("button", { name: "Emoji and GIFS", exact: true });
    await emoji.focus();
    await emoji.press("Enter");
    const search = page.getByRole("searchbox", { name: "Search emoji" });
    await expect(search).toBeVisible();
    await hidden(actions);
    await page.mouse.move(
      point.x + point.width / 2,
      point.y + point.height / 2,
    );
    await search.fill("thumbsup");
    await page.locator("em-emoji-picker .category button").first().click();
    await expect(search).toBeHidden();
    await expect(composer).toContainText("👍");
    await composer.fill("");
    await hoverMessage(row);
    await shown(actions);
    await expect(actions).toHaveCSS("pointer-events", "auto");
  }
});

// Both speakers must leave the opposite avatar column clear at real pane widths.
test("long bubbles expand to 32px before the opposite avatar", async ({
  page,
  app,
}) => {
  await open(page, app);
  const received = app.append(
    "primary",
    "alpha",
    "Received long message. ".repeat(30),
    true,
    false,
  );
  const sent = app.append(
    "primary",
    "alpha",
    "Sent long message. ".repeat(30),
    true,
    true,
  );
  const bubble = (event) =>
    page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"] [data-message-action-anchor]`,
    );
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1200 });
    await expect(bubble(sent)).toBeVisible();
    await expect(bubble(received)).toBeVisible();
    await settle(page);
    await expect
      .poll(async () => {
        const left = await bubble(received).boundingBox();
        const right = await bubble(sent).boundingBox();
        const receivedAvatar = await page
          .locator(
            `[data-message-id="${received.id}"] [class*="messageAvatar"]`,
          )
          .boundingBox();
        const sentAvatar = await page
          .locator(`[data-message-id="${sent.id}"] [class*="messageAvatar"]`)
          .boundingBox();
        return (
          left !== null &&
          right !== null &&
          receivedAvatar !== null &&
          sentAvatar !== null &&
          Math.abs(sentAvatar.x - (left.x + left.width) - 32) < 1 &&
          Math.abs(right.x - (receivedAvatar.x + receivedAvatar.width) - 32) < 1
        );
      })
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`message-width-${width}.png`),
    });
  }
});

// Browser-only: row-wide hit testing, top-layer placement, and avatar alignment
// need real layout. The existing cases above retain Default's content-only hover.
test("Compact reveals actions from row whitespace and pins them to the trailing edge", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-message-density.v1", "compact"),
  );
  await open(page, app);
  await expect(page.locator("html")).toHaveAttribute(
    "data-message-density",
    "compact",
  );
  app.append("primary", "alpha", "Separate author", true, false);
  const event = app.append("primary", "alpha", "One line", true, true);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  await settle(page);
  // The primary byline is stable metadata; only continuation timestamps wait
  // for hover in Compact.
  await expect(row.locator("[class*='byline'] time")).toHaveCSS("opacity", "1");
  const whitespace = await row.evaluate((node) => {
    const box = node.querySelector("[data-layout]").getBoundingClientRect();
    const text = node
      .querySelector("[data-message-action-anchor] p")
      .getBoundingClientRect();
    return { x: box.right - 2, y: text.top + text.height / 2 };
  });
  await page.mouse.move(whitespace.x, whitespace.y);
  const actions = actionsFor(row);
  await shown(actions);
  await expect
    .poll(() =>
      row.evaluate((node) => {
        const box = node.querySelector("[data-layout]").getBoundingClientRect();
        const scroller = node
          .closest("[data-message-scroller]")
          .getBoundingClientRect();
        const bar = node
          .querySelector("[data-message-actions]")
          .getBoundingClientRect();
        return bar.right >= box.right - 1 && bar.right <= scroller.right + 1;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      row.evaluate((node) => {
        const message = node.querySelector("[data-layout]");
        const fill = getComputedStyle(message, "::before");
        const avatar = node
          .querySelector('[class*="messageAvatar"]')
          .getBoundingClientRect();
        const byline = node
          .querySelector('[class*="byline"]')
          .getBoundingClientRect();
        const text = node
          .querySelector("[data-message-action-anchor] p")
          .getBoundingClientRect();
        return (
          fill.content !== "none" &&
          fill.backgroundColor !== "rgba(0, 0, 0, 0)" &&
          Math.abs(
            avatar.top + avatar.height / 2 - (byline.top + text.bottom) / 2,
          ) < 1
        );
      }),
    )
    .toBe(true);
  const more = row.getByRole("button", { name: "More message actions" });
  await more.click();
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(more).toBeFocused();
  // Escape retains keyboard access; pointer dismissal releases that focus.
  await page.mouse.click(0, 0);
  await hidden(actions);
});
