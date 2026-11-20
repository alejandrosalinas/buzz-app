import { expect, test, type Locator } from "@playwright/test";

const viewer = "/tests/fixtures/design-system.html";

const expectKeyboardRing = async (control: Locator, offset = "2px") => {
  await expect(control).toHaveCSS("outline-style", "solid");
  await expect(control).toHaveCSS("outline-width", "2px");
  await expect(control).toHaveCSS("outline-offset", offset);
};

const divider = (row: Locator) =>
  row.evaluate((node) => {
    const style = getComputedStyle(node, "::after");
    const bounds = node.getBoundingClientRect();
    const label = node
      .querySelector(".buzz-accordion-trigger > span")
      ?.getBoundingClientRect();
    const start = Number.parseFloat(style.insetInlineStart);
    const end = Number.parseFloat(style.insetInlineEnd);
    return {
      visible:
        style.content !== "none" && style.borderBlockStartWidth === "1px",
      aligned:
        !!label &&
        start > 0 &&
        start === end &&
        Math.abs(bounds.left + start - label.left) < 1,
    };
  });

test("popout works as a standalone list and allows multiple open rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${viewer}#/design/components/accordion`);
  const list = page.getByRole("region", {
    name: "Popout accordion in a long list",
  });
  await expect(list.getByRole("button")).toHaveCount(12);
  const materials = list.getByRole("button", {
    name: "Materials",
    exact: true,
  });
  const access = list.getByRole("button", { name: "Access", exact: true });
  const accessRow = list.locator(".buzz-accordion-item").filter({
    has: page.getByRole("button", { name: "Access", exact: true }),
  });
  await expect
    .poll(() => divider(accessRow))
    .toEqual({
      visible: true,
      aligned: true,
    });
  await materials.click();
  await expect.poll(async () => (await divider(accessRow)).visible).toBe(false);
  await access.click();
  await expect(materials).toHaveAttribute("aria-expanded", "true");
  await expect(access).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      accessRow.evaluate((row) => {
        const trigger = row.querySelector(".buzz-accordion-trigger");
        const body = row.querySelector(".buzz-accordion-content p");
        if (!trigger || !body) return false;
        const textEdges = (element: Element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            left: bounds.left + Number.parseFloat(style.paddingLeft),
            right: bounds.right - Number.parseFloat(style.paddingRight),
          };
        };
        const heading = textEdges(trigger);
        const paragraph = textEdges(body);
        return (
          Math.abs(heading.left - paragraph.left) < 1 &&
          Math.abs(heading.right - paragraph.right) < 1
        );
      }),
    )
    .toBe(true);
  const expanded = list.locator(".buzz-accordion-item[data-open]");
  await expect(expanded).toHaveCount(2);
  const longContent = expanded.first().locator(".buzz-accordion-content");
  await expect
    .poll(() =>
      longContent.evaluate((node) => node.scrollWidth <= node.clientWidth),
    )
    .toBe(true);
  await expect
    .poll(() =>
      expanded.first().evaluate((item) => {
        const root = item.parentElement;
        if (!root) return false;
        const row = item.getBoundingClientRect();
        const frame = root.getBoundingClientRect();
        const backdrop = getComputedStyle(item, "::before");
        const left = row.left + Number.parseFloat(backdrop.left);
        const right = row.right - Number.parseFloat(backdrop.right);
        return (
          backdrop.opacity === "1" &&
          left >= frame.left - 1 &&
          right <= frame.right + 1 &&
          left < row.left
        );
      }),
    )
    .toBe(true);
});

test("expanded Settings cards own adjacent borders and support caller-owned scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${viewer}#/design/components/accordion`);
  const example = page.getByRole("region", {
    name: "Popout accordion in Settings",
  });
  const publishing = example.getByRole("button", { name: "Publishing" });
  const notes = example.locator(".buzz-accordion").filter({
    has: page.getByRole("button", { name: "Working notes" }),
  });
  const card = example.locator(".buzz-accordion-item").filter({
    has: page.getByRole("button", { name: "Publishing" }),
  });
  const cardStyle = (property: string) =>
    card.evaluate(
      (item, name) => getComputedStyle(item, "::before").getPropertyValue(name),
      property,
    );

  await expect(publishing).toHaveAccessibleDescription("Default instructions");
  await expect.poll(() => cardStyle("opacity")).toBe("0");
  await expect
    .poll(() => divider(notes))
    .toEqual({
      visible: true,
      aligned: true,
    });

  await publishing.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(publishing).toBeFocused();
  await publishing.press("Enter");
  await expect(publishing).toHaveAttribute("aria-expanded", "true");
  await expectKeyboardRing(publishing, "-2px");
  await expect.poll(() => cardStyle("opacity")).toBe("1");
  expect(Number.parseFloat(await cardStyle("inset-inline-start"))).toBeLessThan(
    0,
  );
  await expect.poll(async () => (await divider(card)).visible).toBe(false);
  await expect.poll(async () => (await divider(notes)).visible).toBe(false);

  const readingArea = card.getByRole("region", {
    name: "Publishing instructions",
  });
  const standard = notes.getByRole("button", { name: "Working notes" });
  const readingWidth = (await readingArea.boundingBox())?.width ?? 0;
  await page.keyboard.press("Tab");
  await expect(readingArea).toBeFocused();
  await page.keyboard.press("End");
  await expect
    .poll(() => readingArea.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Tab");
  await expect(
    card.getByRole("button", { name: "Restore default" }),
  ).toBeFocused();

  await publishing.press("Space");
  await expect(publishing).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => cardStyle("opacity")).toBe("0");
  await expect.poll(async () => (await divider(notes)).visible).toBe(true);

  await standard.click();
  const standardContent = notes.getByText(
    "Keep decisions next to the work they affect.",
  );
  await expect(standardContent).toBeVisible();
  expect(readingWidth).toBeGreaterThan(
    (await standardContent.boundingBox())?.width ?? Infinity,
  );

  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator("html").evaluate((root) => {
    root.style.fontSize = "32px";
  });
  await publishing.press("Enter");
  await expect(publishing).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      readingArea.evaluate((area) => {
        const panel = area.closest(".buzz-accordion-panel");
        if (!panel) return false;
        const bounds = area.getBoundingClientRect();
        const clip = panel.getBoundingClientRect();
        return (
          area.scrollWidth <= area.clientWidth &&
          bounds.left >= Math.max(0, clip.left) &&
          bounds.right <= Math.min(window.innerWidth, clip.right)
        );
      }),
    )
    .toBe(true);
});
