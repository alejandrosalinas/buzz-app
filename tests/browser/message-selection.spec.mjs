import { test, expect } from "./fixture.mjs";
import { frames, open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 3, beta: 0 } });

// Native selection, portal hit-testing and focus restoration need real engines.
for (const [scheme, width, scale] of [
  ["light", 1440, 1],
  ["dark", 800, 1.25],
]) {
  test(`selected links yield Quote to their context menu (${scheme})`, async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 950 });
    await open(page, app);
    await page.evaluate(
      (scale) =>
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        ),
      scale,
    );
    const message = app.append(
      "primary",
      "alpha",
      "[Example link](https://example.org/pull/1)",
    );
    const link = page
      .locator(`[data-channel-timeline] [data-message-id="${message.id}"]`)
      .getByRole("link", {
        name: "Example link",
        exact: true,
        includeHidden: true,
      });
    await expect(link).toBeVisible();
    const selectLink = () =>
      link.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
    await selectLink();
    const quote = page.getByRole("button", {
      name: "Quote",
      exact: true,
      includeHidden: true,
    });
    await expect(quote).toBeVisible();
    await link.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: "Copy link" }),
    ).toBeVisible();
    // Engines can update the link selection after the menu has taken focus.
    // Keep that ordering explicit instead of relying on a platform's timing.
    await selectLink();
    await expect
      .poll(() => page.evaluate(() => getSelection()?.toString()))
      .toBe("Example link");
    await frames(page);
    await expect(quote).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(quote).toBeVisible();
    await quote.click();
    await expect(
      page
        .getByRole("textbox", { name: "Message #Alpha", exact: true })
        .locator("blockquote"),
    ).toContainText("Example link");
  });
}

// Engines copy Selection.toString(): button labels, hover-only clocks and
// visually hidden text all count unless user-select excludes them. jsdom has
// no layout, so only a real engine proves the row chrome stays out.
test("a selection spanning rows copies only the visible conversation", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = page.getByRole("region", {
    name: "Channel message history",
  });
  const rows = history.locator("[data-message-id]");
  await expect(rows).toHaveCount(3);
  // The author's name opens their profile; engines still copy its text.
  const name = rows.first().locator("strong > [role='button']");
  await expect(name).toHaveCount(1);
  // A drag across rows mounts each row's deferred action bar on the way.
  for (const row of await rows.all()) await row.hover();
  await expect(
    history
      .getByRole("group", { name: "Message actions", includeHidden: true })
      .locator("button"),
  ).toHaveCount(9);
  const { text, author, time } = await history.evaluate((element) => {
    const rows = [...element.querySelectorAll("[data-message-id]")];
    const author = rows[0].querySelector("strong");
    const range = document.createRange();
    range.setStartBefore(author);
    range.setEndAfter(rows.at(-1).querySelector("p:last-of-type"));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return {
      text: selection.toString(),
      author: author.textContent,
      time: rows[0].querySelector("time [aria-hidden]").textContent,
    };
  });
  const body = (count) => "Mixed height message content. ".repeat(count).trim();
  // The visible byline stays; its hidden full date, each continuation's
  // hover-only clock and screen-reader byline, and the action bars do not.
  expect(text.split("\n").filter(Boolean)).toEqual([
    author,
    time,
    "primary alpha message 0",
    body(1),
    "primary alpha message 1",
    body(4),
    "primary alpha message 2",
    body(7),
  ]);
  // A press on the name starts a selection, as on any byline text, rather
  // than opening the profile; the drag carries the name into the copy.
  const [nameBox, bodyBox] = await Promise.all([
    name.boundingBox(),
    rows.first().locator("p").last().boundingBox(),
  ]);
  // A press inside the selection above would drag its text instead.
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.mouse.move(nameBox.x + 1, nameBox.y + nameBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    bodyBox.x + bodyBox.width - 1,
    bodyBox.y + bodyBox.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();
  const dragged = await page.evaluate(() => getSelection()?.toString() ?? "");
  expect(dragged.split("\n").filter(Boolean).slice(0, 3)).toEqual([
    author,
    time,
    "primary alpha message 0",
  ]);
  // A drag that ends inside the name delivers its click to the name with
  // the name selected; that click is the selection, not a profile request.
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.mouse.move(nameBox.x + 1, nameBox.y + nameBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    nameBox.x + nameBox.width - 1,
    nameBox.y + nameBox.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe(
    author,
  );
  // An opened profile renders on a later frame; let two pass before denying it.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(
    page.getByRole("button", { name: /^Close .* tab$/ }),
  ).toHaveCount(0);
});
