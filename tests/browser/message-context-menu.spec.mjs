import { test, expect } from "./fixture.mjs";
import { expectMessageActionsHidden } from "./message-actions.mjs";
import { clickRow, hoverRow, open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 3, beta: 1 },
});

test.describe("touch selection menus", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 900, height: 950 },
  });

  test("touch ⋯ quotes the highlight; Chromium long presses stay native", async ({
    page,
    app,
    browserName,
  }) => {
    await open(page, app);
    const message = app.append("primary", "alpha", "Touch context target");
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${message.id}"]`,
    );
    const prose = row.locator("[data-message-action-anchor] p");
    await expect(prose).toBeVisible();
    await prose.selectText();
    // Trusted long-press synthesis needs CDP; both engines exercise the ⋯ tap.
    if (browserName === "chromium") {
      const box = await prose.boundingBox();
      const nativeMenu = () =>
        expect
          .poll(() =>
            page.evaluate(() =>
              window.contextMenus.map((event) => ({
                trusted: event.isTrusted,
                pointerType: event.pointerType,
                prevented: event.defaultPrevented,
              })),
            ),
          )
          .toEqual([{ trusted: true, pointerType: "touch", prevented: false }]);
      const cdp = await page.context().newCDPSession(page);
      try {
        if (process.platform === "linux") {
          // Aura's synthesizeTapGesture route bypasses long-press recognition.
          // Mouse-to-touch emulation still generates real trusted touch input.
          const point = {
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
            button: "left",
            clickCount: 1,
          };
          const released = await page.evaluateHandle(() => {
            const state = { ended: false };
            window.addEventListener(
              "touchend",
              () => {
                state.ended = true;
              },
              {
                once: true,
                capture: true,
              },
            );
            return state;
          });
          await cdp.send("Emulation.setEmitTouchEventsForMouse", {
            enabled: true,
            configuration: "mobile",
          });
          try {
            await cdp.send("Input.emulateTouchFromMouseEvent", {
              type: "mousePressed",
              ...point,
            });
            await nativeMenu();
          } finally {
            await cdp.send("Input.emulateTouchFromMouseEvent", {
              type: "mouseReleased",
              ...point,
            });
            try {
              // Release is forwarded asynchronously; do not disable it early.
              await expect
                .poll(() => released.evaluate((state) => state.ended))
                .toBe(true);
            } finally {
              await cdp.send("Emulation.setEmitTouchEventsForMouse", {
                enabled: false,
              });
              await released.dispose();
            }
          }
        } else {
          await cdp.send("Input.synthesizeTapGesture", {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
            duration: 1000,
            gestureSourceType: "touch",
          });
        }
      } finally {
        await cdp.detach();
      }
      await nativeMenu();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await prose.selectText();
    await row.getByRole("button", { name: "More message actions" }).tap();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem").nth(0)).toHaveText(
      "Copy highlight",
    );
    await expect(menu.getByRole("menuitem").nth(1)).toHaveText(
      "Quote highlight",
    );
    // Touch focus may clear the live range; the captured content must survive.
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await menu.getByRole("menuitem", { name: "Quote highlight" }).tap();
    const input = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await expect(input.locator("blockquote")).toHaveText(
      "Touch context target",
    );
    await expect(
      input.locator(":scope > p:first-child [data-source]"),
    ).toHaveAttribute(
      "data-source",
      `buzz://message?channel=alpha&id=${message.id}`,
    );
    await expect(input).toBeFocused();
  });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.copied = [];
    window.contextMenus = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => window.copied.push(value) },
    });
    // Read after dispatch: an unprevented event shows the browser menu.
    window.addEventListener(
      "contextmenu",
      (event) => window.contextMenus.push(event),
      true,
    );
  });
});

const prevented = (page) =>
  page.evaluate(() =>
    window.contextMenus.map((event) => event.defaultPrevented),
  );
const items = (page) => page.getByRole("menu").getByRole("menuitem");
// Right-click once the target hit-tests, with no retrying scroll in between.
const rightClick = async (page, locator) => {
  await hoverRow(page, locator);
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
    button: "right",
  });
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

// Browser-only: the native menu's suppression, pointer placement, and the
// pre-press text selection need real input events, layout and selection.
test("right-clicking a message timestamp offers its ⋯ actions and copies its link", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  const reply = app.reply(root.id, false, false);
  await open(page, app);
  const target = app.append("primary", "alpha", "Context target");
  const rowOf = (id) =>
    page.locator(`[data-channel-timeline] [data-message-id="${id}"]`);
  const row = rowOf(target.id);
  const time = row.locator("time").first();
  await expect(time).toBeVisible();

  await hoverRow(page, row.locator("[data-message-action-anchor] p"));
  const dots = row.getByRole("button", { name: "More message actions" });
  await dots.click();
  await expect(items(page).filter({ hasText: "Copy message" })).toBeVisible();
  const more = await items(page).allInnerTexts();
  // A secondary press on the open ⋯ leaves its menu alone, adding none.
  await dots.click({ button: "right" });
  await expect.poll(() => prevented(page)).toEqual([true]);
  await page.evaluate(() => {
    window.contextMenus = [];
  });
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(items(page).filter({ hasText: "Reply" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  // Release ⋯ so its capsule no longer covers the byline.
  await page.mouse.click(1, 1);
  await expectMessageActionsHidden(
    row.getByRole("group", { name: "Message actions", includeHidden: true }),
  );

  const point = await rightClick(page, time);
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  expect(await prevented(page)).toEqual([true]);
  // The same list as ⋯, plus the toolbar's Reply.
  expect(await items(page).allInnerTexts()).toEqual(
    [...more.slice(0, more.indexOf("Copy message") + 1), "Reply"].concat(
      more.slice(more.indexOf("Copy message") + 1),
    ),
  );
  const box = await menu.boundingBox();
  expect(Math.abs(box.x - point.x)).toBeLessThan(16);
  expect(Math.abs(box.y - point.y)).toBeLessThan(16);
  await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.copied))
    .toEqual([`buzz://message?channel=alpha&id=${target.id}`]);

  // Opening another row's menu straight after targets that row.
  const peer = app.histories
    .get("primary/alpha")
    .find((event) => event.content.startsWith("primary alpha message 0"));
  await rightClick(page, rowOf(peer.id).locator("time").first());
  const edit = menu.getByRole("menuitem", { name: "Edit message" });
  await expect(menu).toBeVisible();
  await expect(edit).toHaveCount(0);
  // A is still open: press B where it hit-tested before.
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(edit).toBeVisible();
  await expect(menu).toHaveCount(1);
  await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.copied.at(-1)))
    .toBe(`buzz://message?channel=alpha&id=${target.id}`);

  // Shift+F10 opens it from a focused control; Escape returns focus there.
  const summary = rowOf(root.id).getByRole("button", { name: /^View thread:/ });
  await summary.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(summary).toBeFocused();

  // Escape and an outside press each dismiss it.
  await rightClick(page, time);
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await rightClick(page, time);
  await expect(menu).toBeVisible();
  await page.mouse.click(1, 1);
  await expect(menu).toHaveCount(0);

  // Highlighted prose prepends its actions to the existing message menu.
  const prose = row.locator("[data-message-action-anchor] p");
  await prose.selectText();
  await page.evaluate(() => {
    window.contextMenus = [];
  });
  await rightClick(page, prose);
  expect(await prevented(page)).toEqual([true]);
  await expect(menu).toBeVisible();
  expect((await items(page).allInnerTexts()).slice(0, 2)).toEqual([
    "Copy highlight",
    "Quote highlight",
  ]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // The same selection does not add highlight actions outside its range.
  await prose.selectText();
  await rightClick(
    page,
    rowOf(peer.id).locator("[data-message-action-anchor] p").first(),
  );
  await expect(
    menu.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /highlight/ })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.evaluate(() => document.getSelection()?.removeAllRanges());

  // Editing selections keep the browser menu.
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.fill("Draft context");
  await input.selectText();
  await page.evaluate(() => {
    window.contextMenus = [];
  });
  await input.click({ button: "right" });
  expect(await prevented(page)).toEqual([false]);
  await expect(menu).toHaveCount(0);
  await input.fill("");

  // A thread reply's menu copies the reply's own thread link.
  await clickRow(page, summary);
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const threadReply = thread.locator(`[data-message-id="${reply.id}"]`);
  await expect(threadReply).toBeVisible();
  await threadReply.getByText("New peer reply").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.copied.at(-1)))
    .toBe(`buzz://message?channel=alpha&id=${reply.id}&thread=${root.id}`);
});
