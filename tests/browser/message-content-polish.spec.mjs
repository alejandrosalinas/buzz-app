import { test, expect } from "./source-fixture.mjs";
import { ACCENTS } from "../../src/shared/theme/accent.ts";
import { apcaContrast, wcagRatio } from "../../scripts/design-system/apca.mjs";
import { animationsSettled } from "./animations.mjs";

const specimen = (page, id) => page.locator(`[aria-labelledby="label-${id}"]`);
// macOS WebKit follows the host preference: Option-Tab includes every control.
const tabKey = (browserName) =>
  browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";

// Browser-only: composite translucent fills to check text contrast, and check
// overflow. A DOM emulator cannot prove these bubble contracts.
async function paint(locator) {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const hex = () =>
      `#${[...context.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`;
    const parents = [];
    for (let node = element; node; node = node.parentElement)
      parents.push(node);
    for (const node of parents.reverse()) {
      context.fillStyle = getComputedStyle(node).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const background = hex();
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    return { background, ink: hex() };
  });
}
async function expectReadable(locator) {
  const { background, ink } = await paint(locator);
  expect(
    wcagRatio(background, ink),
    `${ink} on ${background}`,
  ).toBeGreaterThanOrEqual(4.5);
}

// An own table-only message drops its bubble fill but keeps its reactions in
// the bubble, so the grouped count must take the panel's ink, not the bubble's.
test("reactions under an unboxed own table stay contained and readable", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&table-reactions");
  const row = page
    .locator("[data-message-id]")
    .filter({ has: page.getByRole("table") });
  const count = row.getByRole("button", { name: "👍: 9 people" });
  await expect(count).toContainText("9");
  // Browser layout: an unboxed table has no padding for a reaction outdent.
  await expect
    .poll(async () => {
      const table = await row.getByRole("table").boundingBox();
      const strip = await row
        .getByRole("group", { name: "Reactions", exact: true })
        .boundingBox();
      return (
        !!table &&
        !!strip &&
        strip.x >= table.x &&
        strip.x + strip.width <= table.x + table.width
      );
    })
    .toBe(true);

  for (const theme of ["light", "dark"])
    for (const level of ["touch", "high"])
      for (const color of ACCENTS) {
        await page.locator("html").evaluate(
          (element, { theme, level, color }) => {
            Object.assign(element.dataset, {
              colorMode: theme,
              colorLevel: level,
              accent: color,
            });
          },
          { theme, level, color },
        );
        // Theme changes fade the chip's colors; measure the settled pair.
        await animationsSettled(page.locator("html"), { subtree: true });
        await expectReadable(count);
      }
});

for (const theme of ["light", "dark"]) {
  test(`standalone table and diff hover stays transparent in ${theme}`, async ({
    page,
  }) => {
    await page.goto(
      `/tests/fixtures/message-gallery.html?group=references&theme=${theme}`,
    );
    for (const id of ["table-received", "table-links", "code-diff"]) {
      const example = specimen(page, id);
      const bubble = example.locator("[data-message-action-anchor]");
      await bubble.hover();
      await expect(example.locator("[data-actions-revealed]")).toBeVisible();
      await expect(bubble).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
  });
}

for (const theme of ["light", "dark"]) {
  test(`message references and inset surfaces remain legible in ${theme}`, async ({
    page,
    browserName,
  }, info) => {
    await page.goto(
      `/tests/fixtures/message-gallery.html?group=references&theme=${theme}`,
    );
    await page.evaluate(() => document.fonts.ready);
    const received = specimen(page, "references-received");
    const own = specimen(page, "references-own");
    const table = specimen(page, "table-links").getByRole("table");
    const receivedLink = received.getByRole("link", {
      name: "the design notes",
      exact: true,
    });
    const ownLink = own.getByRole("link", {
      name: "the design notes",
      exact: true,
    });
    const mention = own.getByRole("button", {
      name: "View Sam Rivera profile",
      exact: true,
    });
    await own
      .getByRole("button", { name: "Reveal spoiler", exact: true })
      .click();
    const spoiler = own.locator('[data-revealed="true"]');
    await expect(
      spoiler.getByRole("link", { name: "release notes", exact: true }),
    ).toBeVisible();

    for (const color of ACCENTS) {
      await page.locator("html").evaluate((element, color) => {
        element.dataset.accent = color;
      }, color);
      await page.mouse.move(0, 0);
      const bubble = own.locator("[data-message-action-anchor][data-own]");
      const bodyPaint = await paint(bubble);
      expect(
        Math.abs(apcaContrast(bodyPaint.ink, bodyPaint.background)),
      ).toBeGreaterThanOrEqual(60);
      await expectReadable(bubble);
      for (const link of [receivedLink, ownLink]) {
        await expectReadable(link);
        await link.hover();
        await expectReadable(link);
      }
      await expectReadable(mention);
      await mention.hover();
      await expectReadable(mention);
      await expectReadable(spoiler);
      await expectReadable(
        spoiler.getByRole("link", { name: "release notes", exact: true }),
      );
      if (color === "chartreuse") {
        await page.mouse.move(0, 0);
        await own.screenshot({
          path: info.outputPath(`chartreuse-message-${theme}.png`),
        });
      }
      await expectReadable(
        table.getByRole("cell", { name: "Ready", exact: true }),
      );
      await expectReadable(
        table.getByRole("link", { name: "Design notes", exact: true }),
      );
      await expectReadable(
        specimen(page, "code-diff").getByText("greeting.ts", { exact: true }),
      );
    }
    // Real keyboard input reaches and activates the link.
    await received.locator('button[data-mention-kind="person"]').focus();
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press(tabKey(browserName));
    await expect(receivedLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(received.getByRole("status")).toContainText(
      "Sample link selected",
    );
    await page
      .getByRole("button", { name: "Narrow preview", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator(".message-gallery-frame")
          .evaluateAll((frames) =>
            frames.every((frame) => frame.scrollWidth <= frame.clientWidth),
          ),
      )
      .toBe(true);
    await received.screenshot({
      path: info.outputPath(`message-references-${theme}.png`),
    });
  });
}

test("long links wrap inside their bubble in a narrow pane", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/tests/fixtures/message-gallery.html?group=references");
  await page.evaluate(() => document.fonts.ready);
  await page
    .getByRole("button", { name: "Narrow preview", exact: true })
    .click();
  const long = specimen(page, "long-links");
  const bubble = long.locator("[data-message-action-anchor]");
  const links = long.getByRole("link");
  await expect(links).toHaveCount(2);
  // Every line box of every link stays within the bubble's edges.
  await expect
    .poll(() =>
      bubble.evaluate((element) => {
        const edge = element.getBoundingClientRect();
        return [...element.querySelectorAll("a")].flatMap((link) =>
          [...link.getClientRects()]
            .filter((line) => line.left < edge.left || line.right > edge.right)
            .map((line) => `${link.textContent}: ${line.left}-${line.right}`),
        );
      }),
    )
    .toEqual([]);
  await long.screenshot({ path: info.outputPath("long-links.png") });
  // A wrapped link still opens its destination.
  await links.first().click();
  await expect(long.getByRole("status")).toContainText("Sample link selected");
});

test("file anchors and native download buttons stay readable and keyboard reachable", async ({
  page,
  browserName,
}) => {
  await page.goto("/tests/fixtures/message-gallery.html?group=attachments");
  const external = specimen(page, "file").getByRole("link", {
    name: "Open design-review-notes.txt",
    exact: true,
  });
  const download = specimen(page, "file-download").getByRole("button", {
    name: "Download review-notes.txt",
    exact: true,
  });
  for (const control of [external, download]) {
    await control.hover();
    await expectReadable(control);
  }
  await specimen(page, "file-download")
    .getByRole("button", { name: "More message actions", exact: true })
    .focus();
  await page.keyboard.press(tabKey(browserName));
  await expect(download).toBeFocused();
  await page
    .getByRole("button", { name: "Narrow preview", exact: true })
    .click();
  await page.getByRole("button", { name: "All messages", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workflow attribution", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".message-gallery-frame")
        .evaluateAll((frames) =>
          frames.every((frame) => frame.scrollWidth <= frame.clientWidth),
        ),
    )
    .toBe(true);
});
