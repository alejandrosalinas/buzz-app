import { npubEncode } from "nostr-tools/nip19";
import { test, expect } from "./fixture.mjs";

test.use({ searchAuthor: true });

// Native input editing and flex layout cannot be established by jsdom.
test("selected author remains a removable chip through typing and date completion", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  await input.fill("from:@fixture");
  await dialog
    .getByRole("group", { name: "People" })
    .getByRole("option", { name: /Fixture Reader/ })
    .click();
  const chip = dialog.getByRole("button", {
    name: "Remove author Fixture Reader",
  });
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("title", npubEncode(app.viewer));
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(
    chip.locator("xpath=ancestor::*[contains(@class,'search-field')]"),
  ).toContainText("from:@Fixture Reader");
  const verifyLayout = async () => {
    const bounds = await Promise.all(
      [chip, input].map((item) => item.boundingBox()),
    );
    expect(bounds[0].width).toBeGreaterThan(25);
    expect(bounds[1].width).toBeGreaterThan(60);
    expect(bounds[0].x + bounds[0].width).toBeLessThan(bounds[1].x + 2);
  };
  await verifyLayout();
  await input.pressSequentially("deploy before:");
  await expect(input).toHaveValue("deploy before:");
  await dialog
    .getByRole("group", { name: "Dates" })
    .getByRole("option", { name: /Yesterday/ })
    .click();
  await expect(chip).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: /^Remove date before:\d{4}-\d{2}-\d{2}$/,
    }),
  ).toBeVisible();
  await expect(input).toHaveValue("deploy ");
  await expect
    .poll(() =>
      app.report.queries.some(
        ({ filter }) =>
          filter.kinds?.includes(9) &&
          filter.authors?.[0] === app.viewer &&
          filter.search === "deploy" &&
          filter.until !== undefined,
      ),
    )
    .toBe(true);
  await input.fill("deploy");
  await expect(chip).toBeVisible();
  await expect(input).toHaveValue("deploy");
  await verifyLayout();
  await page.setViewportSize({ width: 380, height: 720 });
  await verifyLayout();
  await page.emulateMedia({ colorScheme: "dark" });
  await verifyLayout();
  await chip.hover();
  await expect(chip).toHaveAttribute("title", npubEncode(app.viewer));
  await chip.click();
  await expect(chip).toHaveCount(0);
  await expect(input).toHaveValue("deploy");
  await expect(input).toBeFocused();
  await expect
    .poll(() =>
      app.report.queries.some(
        ({ filter }) =>
          filter.kinds?.includes(9) &&
          filter.search === "deploy" &&
          !filter.authors,
      ),
    )
    .toBe(true);
});

// The chip's trailing separator is also the next prompt's leading separator.
// This ordering needs a rendered input: a stale hidden operand can survive
// despite the replacement chip looking correct.
test("replacing a standalone author chip leaves no hidden operand", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  const person = dialog
    .getByRole("group", { name: "People" })
    .getByRole("option", { name: /Fixture Reader/ });
  await input.fill("from:@fixture");
  await person.click();
  await expect(input).toHaveValue("");
  await input.fill("from:fixture");
  await person.click();
  const chip = dialog.getByRole("button", {
    name: "Remove author Fixture Reader",
  });
  await expect(chip).toHaveCount(1);
  await expect(input).toHaveValue("");
  await chip.click();
  await expect(input).toHaveValue("");
  await expect(chip).toHaveCount(0);
});
