import { test, expect } from "./source-fixture.mjs";
import { settleDialogMotion } from "./navigation.mjs";

// Browser-only: CSS hit testing, native selection, wheel scrolling and focus reveal.
const fixture = "/tests/fixtures/dialog-footer.html";
const scroller = (dialog) =>
  dialog.locator(".buzz-dialog-action-row").filter({ visible: true });

async function settledDialog(page, role = "dialog") {
  const dialog = page.getByRole(role);
  await expect(dialog).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await settleDialogMotion(dialog);
  return dialog;
}

for (const layout of ["flow", "padded", "compact", "wide"]) {
  test(`${layout} footer passes only its gradient gutter through`, async ({
    page,
  }) => {
    for (const theme of ["light", "dark"]) {
      for (const [width, scale] of [
        [1280, 1],
        [800, 1],
        [390, 2],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `${fixture}?layout=${layout}&theme=${theme}&scale=${scale}`,
        );
        const dialog = await settledDialog(page);
        const footer = dialog.locator(".buzz-dialog-actions");
        const input = dialog.getByRole("textbox", {
          name: "Field 8",
          exact: true,
        });
        await expect(
          dialog.getByRole("button", { name: "Save", exact: true }),
        ).toBeVisible();
        // Place a real body input beneath each part of the sticky footer.
        for (const region of ["gutter", "beside", "below"]) {
          const point = await input.evaluate((field, region) => {
            const popup = field.closest(".buzz-dialog");
            const footer = popup.querySelector(".buzz-dialog-actions");
            const bounds = footer.getBoundingClientRect();
            const style = getComputedStyle(footer);
            const save = [...footer.querySelectorAll("button")].find(
              (b) => b.textContent === "Save",
            );
            const button = save.getBoundingClientRect();
            const y =
              region === "gutter"
                ? bounds.top + parseFloat(style.paddingTop) / 2
                : region === "beside"
                  ? button.top + button.height / 2
                  : button.bottom + 6;
            popup.scrollTop +=
              field.getBoundingClientRect().top + field.clientHeight / 2 - y;
            return {
              x:
                bounds.left +
                (region === "beside"
                  ? 6
                  : parseFloat(getComputedStyle(popup).paddingLeft) + 8),
              y,
            };
          }, region);
          await expect
            .poll(() =>
              input.evaluate((field, p) => {
                const hit = document.elementFromPoint(p.x, p.y);
                return {
                  input: hit === field,
                  footer: !!hit?.closest(".buzz-dialog-actions"),
                };
              }, point),
            )
            .toEqual({
              input: region === "gutter",
              footer: region !== "gutter",
            });
          await page.mouse.click(point.x, point.y);
          if (region === "gutter") await expect(input).toBeFocused();
          else await expect(page.getByLabel("Saved count")).toHaveText("0");
        }
        await expect(footer.locator(".buzz-dialog-bar-material")).toHaveCSS(
          "pointer-events",
          "none",
        );
      }
    }
  });
}

for (const layout of [
  "flow",
  "padded",
  "compact",
  "wide",
  "header-only",
  "stable",
  "stable-tall",
  "flex",
  "right",
  "expanded",
  "stepped",
  "search",
  "navigation",
  "alert",
]) {
  test(`${layout} footer retains controls, text and keyboard access`, async ({
    page,
  }) => {
    for (const [width, scale, theme] of [
      [1280, 1, "light"],
      [800, 1, "dark"],
      [390, 2, "dark"],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `${fixture}?layout=${layout}&content=mixed&theme=${theme}&scale=${scale}`,
      );
      const dialog = await settledDialog(
        page,
        layout === "alert" ? "alertdialog" : "dialog",
      );
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      await expect(save).toBeEnabled();
      await expect(
        dialog.getByRole("button", { name: "Unavailable" }),
      ).toBeDisabled();
      if (layout !== "alert") {
        const toggle = dialog.getByRole("switch", { name: "Enable plugin" });
        await toggle.click();
        await expect(toggle).toBeChecked();
        await toggle.focus();
        await page.keyboard.press("Space");
        await expect(toggle).not.toBeChecked();
        await dialog.getByRole("combobox", { name: "Footer choice" }).click();
        await page.getByRole("option", { name: "Two", exact: true }).click();
        await expect(
          dialog.getByRole("combobox", { name: "Footer choice" }),
        ).toContainText("Two");
        const text = dialog.getByText("Footer status", { exact: true });
        await text.scrollIntoViewIfNeeded();
        const box = await text.boundingBox();
        await page.mouse.move(box.x + 1, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
          steps: 8,
        });
        await page.mouse.up();
        expect(await page.evaluate(() => getSelection()?.toString())).toContain(
          "Footer statu",
        );
        await dialog.getByRole("link", { name: "Details" }).click();
        await expect(page).toHaveURL(/#details$/);
      }
      // Tab skips the disabled action and reaches the save control.
      await save.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(save).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Saved count")).toHaveText("1");
      await save.click();
      await expect(page.getByLabel("Saved count")).toHaveText("2");
    }
  });
}

for (const content of ["wrapped", "portal", "leading-only"]) {
  test(`${content} footer content remains clickable`, async ({ page }) => {
    for (const layout of ["flow", "stable", "stepped"]) {
      for (const [width, scale] of [
        [1280, 1],
        [390, 2],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `${fixture}?content=${content}&layout=${layout}&scale=${scale}`,
        );
        const button = page.getByRole("button", {
          name: content === "leading-only" ? "Leading action" : "Save",
          exact: true,
        });
        await button.click();
        await expect(page.getByLabel("Saved count")).toHaveText("1");
      }
    }
  });
}

for (const feature of ["forced-colors", "prefers-reduced-transparency"]) {
  test(`${feature} keeps the opaque gutter from reaching hidden content`, async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "WebKit does not expose these media emulations",
    );
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        {
          name: feature,
          value: feature === "forced-colors" ? "active" : "reduce",
        },
      ],
    });
    await page.goto(fixture);
    expect(
      await page.evaluate(
        (feature) =>
          matchMedia(
            `(${feature}: ${feature === "forced-colors" ? "active" : "reduce"})`,
          ).matches,
        feature,
      ),
    ).toBe(true);
    const footer = page.locator(".buzz-dialog-actions");
    await expect(footer).toHaveCSS("pointer-events", "auto");
    const point = await footer.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        x: box.left + box.width / 2,
        y: box.top + parseFloat(getComputedStyle(node).paddingTop) / 2,
      };
    });
    expect(
      await page.evaluate(
        (p) =>
          !!document
            .elementFromPoint(p.x, p.y)
            ?.closest(".buzz-dialog-actions"),
        point,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByLabel("Saved count")).toHaveText("1");
  });
}

test("overflowing sticky footer accepts wheel input over gaps and reveals keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`${fixture}?content=overflow&scale=2`);
  const dialog = await settledDialog(page);
  const row = scroller(dialog);
  await expect
    .poll(() => row.evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  const point = await row.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.bottom - 6 };
  });
  expect(
    await page.evaluate(
      (p) =>
        document
          .elementFromPoint(p.x, p.y)
          ?.classList.contains("buzz-dialog-action-row"),
      point,
    ),
  ).toBe(true);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(200, 0);
  await expect
    .poll(() => row.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await row.evaluate((el) => {
    el.scrollLeft = 0;
  });
  const save = dialog.getByRole("button", {
    name: "Publish profile & open",
    exact: true,
  });
  await dialog.getByRole("textbox", { name: "Field 16", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  await expect
    .poll(() =>
      save.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const row = button
          .closest(".buzz-dialog-action-row")
          .getBoundingClientRect();
        return (
          box.right > row.left &&
          box.left < row.right &&
          box.top >= 0 &&
          box.bottom <= innerHeight
        );
      }),
    )
    .toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Saved count")).toHaveText("1");
});
