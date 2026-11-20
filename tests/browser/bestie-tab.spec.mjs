import { test, expect } from "./source-fixture.mjs";

// Real layout is outside jsdom: the tab at the Agents side panel's default and
// narrowest widths, with large text, never runs off the panel.
// With a section edited by hand, its row shows Restore instead of a switch.
for (const [variant, query] of [
  ["bestie", ""],
  ["former", "?former"],
  ["edited", "?edited"],
]) {
  test(`The ${variant} Bestie tab fits the side panel at every width and text size`, async ({
    page,
  }) => {
    await page.goto(`/tests/fixtures/bestie-tab.html${query}`);
    if (variant === "edited")
      await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
    const panel = page.getByRole("complementary", { name: "Agent panel" });
    await expect(
      page.getByText("Private channels", { exact: false }).first(),
    ).toBeVisible();
    // The Cost row has read the week before its width is measured.
    await expect(
      page.getByRole("button", { name: "Open Usage" }),
    ).toBeVisible();
    for (const width of ["28rem", "20rem"]) {
      for (const fontSize of ["16px", "20px"]) {
        await page.evaluate(
          ([width, fontSize]) => {
            document.documentElement.style.setProperty(
              "--secondary-panel-width",
              width,
            );
            document.documentElement.style.fontSize = fontSize;
          },
          [width, fontSize],
        );
        if (process.env.BESTIE_SHOTS)
          await panel.screenshot({
            path: `${process.env.BESTIE_SHOTS}/${variant}-${width}-${fontSize}.png`,
          });
        expect(
          await panel.evaluate((el) => el.scrollWidth <= el.clientWidth),
          `${width} at ${fontSize}`,
        ).toBe(true);
        for (const button of await panel.getByRole("button").all()) {
          const box = await button.boundingBox();
          const bounds = await panel.boundingBox();
          expect(
            box && bounds && box.x + box.width <= bounds.x + bounds.width + 0.5,
            `${await button.textContent()} at ${width} ${fontSize}`,
          ).toBe(true);
        }
      }
    }
  });
}
