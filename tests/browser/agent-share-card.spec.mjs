import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-agent-share-card-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/agent-share-card.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/agent-share-card.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Layout only a browser can show: the card fits whole in the preview, from a
// roomy window down to a short one at enlarged text, and while a wrapping save
// error sits above it. The preview uses the same roomy frame as Share.
for (const { width, height, large, failed } of [
  { width: 1280, height: 900, large: false, failed: false },
  { width: 480, height: 640, large: false, failed: false },
  { width: 600, height: 600, large: true, failed: false },
  { width: 600, height: 600, large: true, failed: true },
]) {
  test(`the export card fits whole at ${width}×${height}${large ? " with enlarged text" : ""}${failed ? " after a save fails" : ""}`, async ({
    page,
  }) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width, height });
    await page.goto(large ? `${url}?large` : url);
    const share = page.getByRole("dialog", { name: "Share Ada" });
    const shareBox = await share
      .locator(".buzz-dialog-step:not([inert])")
      .boundingBox();
    await share
      .getByRole("button", { name: "Export Ada as an agent card" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Export Ada" });
    const card = dialog.getByRole("img", { name: "Ada’s agent card" });
    await expect(card).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Save card" }),
    ).toBeEnabled();
    if (failed) {
      // The card's own link is made; the saved file's then can't be.
      await page.evaluate(() => {
        URL.createObjectURL = () => {
          throw new Error(
            "The browser refused to make a download link for this card, so nothing was saved.",
          );
        };
      });
      await dialog.getByRole("button", { name: "Save card" }).click();
      const alert = dialog.getByRole("alert");
      await expect(alert).toContainText("Couldn’t export Ada.");
      // Enlarged text wraps it past the one row reserved for feedback.
      expect((await alert.boundingBox()).height).toBeGreaterThan(60);
    }
    const step = dialog.locator(".buzz-dialog-step:not([inert])");
    // Wait out the step crossfade before measuring.
    await expect(step).not.toHaveAttribute("data-starting-style");
    await expect(step).not.toHaveAttribute("data-ending-style");
    await expect(dialog.locator(".buzz-dialog-step")).toHaveCount(1);
    await card.evaluate((image) =>
      Promise.all(
        image
          .closest("[data-ready]")
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    );
    const geometry = await step.evaluate((element) => {
      const box = (node) => {
        const rect = node.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        };
      };
      const body = element.querySelector(".buzz-dialog-body");
      const image = element.querySelector("img");
      return {
        step: box(element),
        stepScrolls: element.scrollHeight - element.clientHeight,
        body: box(body),
        bodyScrolls: body.scrollHeight - body.clientHeight,
        card: box(image),
        save: box(element.querySelector(".buzz-dialog-actions")),
      };
    });
    expect(geometry.stepScrolls, "the step doesn't scroll").toBeLessThanOrEqual(
      0,
    );
    expect(geometry.bodyScrolls, "the body doesn't scroll").toBeLessThanOrEqual(
      0,
    );
    // Whole, inside the body and above the actions.
    expect(geometry.card.top).toBeGreaterThanOrEqual(geometry.body.top - 0.5);
    expect(geometry.card.bottom).toBeLessThanOrEqual(
      geometry.body.bottom + 0.5,
    );
    expect(geometry.card.left).toBeGreaterThanOrEqual(geometry.body.left - 0.5);
    expect(geometry.card.right).toBeLessThanOrEqual(geometry.body.right + 0.5);
    expect(geometry.card.bottom).toBeLessThanOrEqual(geometry.save.top);
    expect(geometry.step.bottom).toBeLessThanOrEqual(height);
    // Still a card, not a sliver.
    expect(geometry.card.bottom - geometry.card.top).toBeGreaterThan(100);
    // Standard modal placement stays inside the window.
    expect(geometry.step.top).toBeGreaterThanOrEqual(0);
    expect(geometry.step.bottom - geometry.step.top).toBeCloseTo(
      shareBox.height,
      0,
    );
    expect(geometry.step.right - geometry.step.left).toBeCloseTo(
      shareBox.width,
      0,
    );
    expect(errors).toEqual([]);
  });
}

// CSS transforms and reduced-motion media queries need a real rendering engine.
test("the loaded card reveals once, keeps actions available, and respects reduced motion", async ({
  page,
}) => {
  await page.goto(url);
  await page
    .getByRole("button", { name: "Export Ada as an agent card" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Export Ada" });
  const card = dialog.getByRole("img", { name: "Ada’s agent card" });
  await expect(dialog.locator('[data-ready="true"]')).toBeVisible();
  const turning = await card.evaluate((image) => {
    const turn = image.parentElement.parentElement;
    const animation = turn.getAnimations()[0];
    animation.pause();
    animation.currentTime = 250;
    return getComputedStyle(turn).transform;
  });
  expect(turning).not.toBe("none");
  await expect(dialog.getByRole("button", { name: "Save card" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Back" }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("button", { name: "Export Ada as an agent card" })
    .click();
  await expect(dialog.locator('[data-ready="true"]')).toBeVisible();
  expect(
    await card.evaluate((image) => {
      const turn = image.parentElement.parentElement;
      return {
        transform: getComputedStyle(turn).transform,
        opacity: getComputedStyle(turn).opacity,
        animations: turn.getAnimations().length,
      };
    }),
  ).toEqual({ transform: "none", opacity: "1", animations: 0 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Share Ada" })).toBeVisible();
});

// Canvas sampling, composited border lighting, and pointer geometry are browser behavior.
test("the portrait colors the exported foil and the directional hover light", async ({
  page,
}) => {
  const borderColors = [];
  for (const portrait of ["green", "red"]) {
    await page.goto(`${url}?portrait=${portrait}`);
    await page
      .getByRole("button", { name: "Export Ada as an agent card" })
      .click();
    const reveal = page.locator('[data-ready="true"]');
    await expect(reveal).toBeVisible();
    await reveal.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
    await expect(reveal).toHaveAttribute("data-entered", "true");
    const image = reveal.getByRole("img");
    const palette = await image.evaluate((img) => {
      const stage = img.closest("[data-ready]").parentElement;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return {
        accent: getComputedStyle(stage).getPropertyValue("--card-accent"),
        border: [...ctx.getImageData(10, 615, 1, 1).data],
      };
    });
    const rgb = palette.accent.match(/\d+/g).map(Number);
    if (portrait === "green") expect(rgb[1]).toBeGreaterThan(rgb[0] * 2);
    else expect(rgb[0]).toBeGreaterThan(rgb[1] * 2);
    borderColors.push(palette.border);
    const box = await image.boundingBox();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1);
    const light = image.locator("..").locator("span");
    await expect
      .poll(() =>
        light.evaluate((el) =>
          Number(getComputedStyle(el, "::before").opacity),
        ),
      )
      .toBeGreaterThan(0);
    const pointer = await image.evaluate((img) => ({
      x: Number(img.parentElement.style.getPropertyValue("--card-x")),
      y: Number(img.parentElement.style.getPropertyValue("--card-y")),
    }));
    expect(pointer.x).toBeGreaterThan(0.8);
    expect(pointer.y).toBeLessThan(0.2);
    const tracked = await image.evaluate(async (img) => {
      const plane = img.parentElement;
      const box = img.closest('[data-entered="true"]').getBoundingClientRect();
      plane.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
          clientX: box.left + box.width * 0.2,
          clientY: box.top + box.height * 0.8,
        }),
      );
      await new Promise(requestAnimationFrame);
      const light = getComputedStyle(plane.querySelector("span"));
      return {
        x: Number(light.getPropertyValue("--card-x")),
        y: Number(light.getPropertyValue("--card-y")),
      };
    });
    expect(tracked.x).toBeCloseTo(0.2, 2);
    expect(tracked.y).toBeCloseTo(0.8, 2);
    await expect
      .poll(() =>
        image.evaluate((img) => {
          const plane = img.parentElement;
          const matrix = new DOMMatrixReadOnly(
            getComputedStyle(plane).transform,
          );
          return Math.abs((Math.asin(matrix.m13) * 180) / Math.PI);
        }),
      )
      .toBeGreaterThan(5);
    expect(
      await image.evaluate(
        (img) => getComputedStyle(img.parentElement.parentElement).perspective,
      ),
    ).not.toBe("none");
    const tilted = await image.boundingBox();
    const body = await page.locator(".buzz-dialog-body").boundingBox();
    expect(tilted.y).toBeGreaterThanOrEqual(body.y);
    expect(tilted.y + tilted.height).toBeLessThanOrEqual(body.y + body.height);
  }
  expect(borderColors[0]).not.toEqual(borderColors[1]);
});

test("pack portrait moves independently and respects reduced motion", async ({
  page,
}) => {
  await page.goto(`${url}?pack`);
  await page
    .getByRole("button", { name: "Export Ada as an agent card" })
    .click();
  const image = page.getByRole("img", { name: "Ada’s agent card" });
  await expect(image).toBeVisible();
  const portrait = page.locator('[data-loaded="true"] img');
  await expect(portrait).toBeVisible();
  await expect(page.locator('[data-entered="true"]')).toBeVisible();
  const box = await image.boundingBox();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3);
  await expect
    .poll(() =>
      portrait.evaluate(
        (el) => new DOMMatrix(getComputedStyle(el).transform).m41,
      ),
    )
    .toBeGreaterThan(1);
  await expect
    .poll(() =>
      portrait.evaluate(
        (el) => new DOMMatrix(getComputedStyle(el).transform).m42,
      ),
    )
    .toBeLessThan(-1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(portrait).toHaveCSS("transform", "none");
});

test("hover stays engaged along the stationary card edge", async ({ page }) => {
  await page.goto(`${url}?pack`);
  await page
    .getByRole("button", { name: "Export Ada as an agent card" })
    .click();
  const reveal = page.locator('[data-entered="true"]');
  await expect(reveal).toBeVisible();
  await reveal.evaluate((el) => {
    el.dataset.leaves = "0";
    el.addEventListener("pointerleave", () => {
      el.dataset.leaves = String(Number(el.dataset.leaves) + 1);
    });
  });
  const box = await reveal.boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(
      box.x + box.width - 2,
      box.y + box.height * (0.2 + (0.6 * i) / 40),
    );
  }
  await expect(reveal).toHaveAttribute("data-leaves", "0");
  const x = await reveal.evaluate((el) =>
    Number(
      el.querySelector("img").parentElement.style.getPropertyValue("--card-x"),
    ),
  );
  expect(x).toBeGreaterThan(0.95);
  await page.mouse.move(box.x - 20, box.y - 20);
  await expect(reveal).toHaveAttribute("data-leaves", "1");
});

test("tiny crossings at every card edge keep hover until the buffer is left", async ({
  page,
}) => {
  await page.goto(`${url}?pack`);
  await page
    .getByRole("button", { name: "Export Ada as an agent card" })
    .click();
  const reveal = page.locator('[data-entered="true"]');
  await expect(reveal).toBeVisible();
  const box = await reveal.boundingBox();
  await reveal.evaluate((el) => {
    el.dataset.leaves = "0";
    el.addEventListener("pointerleave", () => {
      el.dataset.leaves = String(Number(el.dataset.leaves) + 1);
    });
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (const side of ["left", "right", "top", "bottom"]) {
    for (let i = 0; i < 12; i++) {
      const offset = i % 2 ? -2 : 2;
      const x =
        side === "left"
          ? box.x + offset
          : side === "right"
            ? box.x + box.width + offset
            : box.x + box.width / 2;
      const y =
        side === "top"
          ? box.y + offset
          : side === "bottom"
            ? box.y + box.height + offset
            : box.y + box.height / 2;
      await page.mouse.move(x, y);
    }
  }
  await expect(reveal).toHaveAttribute("data-leaves", "0");
  await page.mouse.move(box.x - 20, box.y - 20);
  await expect(reveal).toHaveAttribute("data-leaves", "1");
  await expect
    .poll(() =>
      reveal.evaluate(
        (el) =>
          getComputedStyle(el.querySelector("img").parentElement).transform,
      ),
    )
    .toBe("matrix(1, 0, 0, 1, 0, 0)");
});
