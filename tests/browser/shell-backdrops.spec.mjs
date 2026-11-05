import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only: stacking contexts, painted pixels and media preferences need a
// real engine. The fixture registers a red layer whose content sits at z-index 1,
// then a blue layer at z-index auto. Registration order must decide the paint.
test.use({ pluginFixtures: true, enabledPlugins: ["fixture.backdrops"] });

const red = [255, 0, 0];
const blue = [0, 0, 255];

/** The painted color at each viewport point, read from a real screenshot. */
async function paint(page, points) {
  const png = (await page.screenshot({ scale: "css" })).toString("base64");
  return page.evaluate(
    async ({ png, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return points.map(([x, y]) =>
        [
          ...context.getImageData(Math.round(x), Math.round(y), 1, 1).data,
        ].slice(0, 3),
      );
    },
    { png, points },
  );
}
const near = (actual, expected) =>
  actual.every((value, index) => Math.abs(value - expected[index]) <= 2);

/** Solid `bg-app` resolved to rgb, as the engine paints it. */
const appColor = (page) =>
  page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--bg-app)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color.match(/\d+/g).slice(0, 3).map(Number);
  });

test("registered backdrops paint in order between the shell and its controls, and step aside for user preferences", async ({
  page,
  app,
}) => {
  await open(page, app);
  const layer = page.locator(".shell-backdrop");
  await expect(layer.locator(".shell-backdrop-layer")).toHaveCount(2);
  const points = await page.evaluate(() => {
    const header = document
      .querySelector(".shell-header")
      .getBoundingClientRect();
    const toggle = document
      .querySelector("[data-shell-sidebar-toggle]")
      .getBoundingClientRect();
    const history = document
      .querySelector(".shell-history")
      .getBoundingClientRect();
    const main = document
      .getElementById("main-content")
      .getBoundingClientRect();
    return {
      // Below the header row, beside the bottom of the window: a bare gutter.
      gutter: [2, window.innerHeight - 2],
      // Inside the history group, above its icons, and just outside it: the
      // group's own fill and the floor's spread around it.
      group: [history.left + history.width / 2, history.top + 3],
      floor: [toggle.left - 3, header.top + header.height / 2],
      pane: [main.left + main.width / 2, main.top + main.height / 2],
    };
  });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    const [gutter, group, floor, pane] = await paint(page, [
      points.gutter,
      points.group,
      points.floor,
      points.pane,
    ]);
    expect(near(gutter, blue), `${mode} gutter ${gutter}`).toBe(true);
    const app = await appColor(page);
    expect(near(group, app), `${mode} header group ${group}`).toBe(true);
    expect(near(floor, app), `${mode} header floor ${floor}`).toBe(true);
    expect(near(pane, blue) || near(pane, red), `${mode} pane ${pane}`).toBe(
      false,
    );
  }

  // The sidebar grip appears on hover; its host halo keeps the gutter's
  // backdrop off the pixels beside it.
  const grip = page.getByRole("separator", { name: "Resize sidebar" });
  await grip.hover();
  await expect
    .poll(() => grip.evaluate((el) => getComputedStyle(el, "::after").opacity))
    .toBe("0.5");
  // Beside the 3px grip, against the same column well below it, where the
  // panels' edges and shadows match and only the halo can differ.
  const box = await grip.boundingBox();
  const x = box.x + box.width / 2 + 2.5;
  const [beside, below] = await paint(page, [
    [x, box.y + box.height / 2],
    [x, box.y + box.height / 2 + 100],
  ]);
  expect(near(beside, below), `grip halo ${beside} vs ${below}`).toBe(false);
  await page.mouse.move(0, 0);

  for (const preference of [
    { reducedMotion: "reduce" },
    // Chromium models forced colors; WebKit has no emulation.
    ...(page.context().browser().browserType().name() === "chromium"
      ? [{ forcedColors: "active" }]
      : []),
  ]) {
    await page.emulateMedia(preference);
    await expect(layer).toHaveCount(0);
    // Clear the preference explicitly; null restores the runner's OS setting.
    await page.emulateMedia({
      reducedMotion: "no-preference",
      forcedColors: "none",
    });
    await expect(layer.locator(".shell-backdrop-layer")).toHaveCount(2);
  }
});
