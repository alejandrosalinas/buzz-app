import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { anchor, expectAnchor, settle, wheel } from "./timeline.mjs";

// Setup only: callers hold image responses until navigation has finished, then
// release them and assert stability without any corrective scrolling.
async function navigate(page, direction) {
  const feed = page.getByRole("region", { name: "Channel message history" });
  const remaining = () =>
    feed.evaluate(
      (el, direction) =>
        direction < 0
          ? el.scrollTop - (el.scrollHeight - el.clientHeight) / 3
          : el.scrollHeight - el.clientHeight - el.scrollTop,
      direction,
    );
  await feed.hover();
  // Read inside the current scroll extent, clear of both clamped edges.
  // Traverse to the setup condition, not a fixed wheel-count budget. WebKit and
  // virtualized remeasurement can apply only part of a requested displacement.
  // The existing test deadline bounds traversal; every gesture must make settled
  // progress. This runs only while image responses are held, never during the
  // preservation assertions that follow their release.
  while (true) {
    const before = await remaining();
    if (before < 4) break;
    // Virtual measurements change the estimated extent. Compare the reader's
    // position in these numbered fixture messages instead of scrollTop.
    const position = () =>
      feed.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll("[data-message-id]")].find(
          (row) => row.getBoundingClientRect().bottom > top,
        );
        if (!row) return { index: 0, offset: element.scrollTop };
        const number = row.textContent.match(/Message (\d+)\./);
        if (!number) throw new Error("Missing numbered image fixture message");
        return {
          index: Number(number[1]),
          offset: top - row.getBoundingClientRect().top,
        };
      });
    const start = await position();
    await wheel(page, direction * Math.min(2000, before));
    const end = await position();
    expect(
      direction *
        (end.index === start.index
          ? end.offset - start.offset
          : end.index - start.index),
      "image navigation retains progress after settling",
    ).toBeGreaterThan(0);
  }
  expect(await remaining(), "image navigation reaches its setup").toBeLessThan(
    4,
  );
}

async function fixtureServer() {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  return server;
}

// Isolate the setup helper from image loading: partial input must converge, but
// blocked input must fail instead of turning the preservation checks into retries.
test("image navigation handles partial gestures and rejects blocked input", async ({
  page,
}) => {
  await page.setContent(`
    <section role="region" aria-label="Channel message history"
      style="height:700px;overflow:auto"><div style="height:14000px"></div></section>
  `);
  // Install the fixture's input policy before hover commits WebKit's wheel
  // event regions; adding the first listener immediately before input can lose it.
  await page.getByRole("region").evaluate((element) => {
    element.addEventListener(
      "wheel",
      (event) => {
        if (element.hasAttribute("data-block-wheel")) event.preventDefault();
      },
      { passive: false },
    );
  });
  const wheel = page.mouse.wheel.bind(page.mouse);
  let gestures = 0;
  page.mouse.wheel = (x, y) => {
    gestures++;
    return wheel(x, Math.sign(y) * Math.min(400, Math.abs(y)));
  };
  try {
    await navigate(page, 1);
    expect(gestures).toBeGreaterThan(8);
    gestures = 0;
    await navigate(page, -1);
    expect(gestures).toBeGreaterThan(8);
    await page.getByRole("region").evaluate((element) => {
      element.setAttribute("data-block-wheel", "");
    });
    gestures = 0;
    await expect(navigate(page, 1)).rejects.toThrow(
      "timeline wheel gesture completes",
    );
    expect(gestures).toBe(1);
  } finally {
    page.mouse.wheel = wheel;
  }
});

// Control decode completion rather than just HTTP completion: an original must
// not cover the preview until decoded, and retired promises must do nothing.
async function holdDecodes(page, holdVisibility = false) {
  await page.addInitScript(
    ({ holdVisibility }) => {
      const realDecode = HTMLImageElement.prototype.decode;
      const pending = new Map();
      const completed = new Map();
      const released = new Set();
      const rejected = new Map();
      const paints = [];
      const realPaint = CanvasRenderingContext2D.prototype.putImageData;
      CanvasRenderingContext2D.prototype.putImageData = function (...args) {
        paints.push({ width: args[0].width, height: args[0].height });
        return realPaint.apply(this, args);
      };
      HTMLImageElement.prototype.decode = async function () {
        await realDecode.call(this);
        if (!this.src.startsWith("https://image.test/")) return;
        const key = this.src;
        try {
          await new Promise((resolve, reject) => {
            if (released.has(key)) {
              resolve();
              return;
            }
            const list = pending.get(key) ?? [];
            list.push({ resolve, reject });
            pending.set(key, list);
          });
        } catch (error) {
          rejected.set(key, (rejected.get(key) ?? 0) + 1);
          throw error;
        }
        completed.set(key, (completed.get(key) ?? 0) + 1);
      };
      const observers = [];
      // Record native observe() calls on canvases so a test can wait for the
      // product's passive effect to register before adding its own observer.
      const observedCanvases = new WeakSet();
      const realObserve = IntersectionObserver.prototype.observe;
      IntersectionObserver.prototype.observe = function (target) {
        if (target instanceof HTMLCanvasElement) observedCanvases.add(target);
        return realObserve.call(this, target);
      };
      if (holdVisibility) {
        window.IntersectionObserver = class {
          constructor(callback) {
            this.callback = callback;
            observers.push(this);
          }
          observe(target) {
            this.target = target;
          }
          disconnect() {}
        };
      }
      window.imageTest = {
        paints,
        completed: (name) =>
          completed.get(`https://image.test/${name}.svg`) ?? 0,
        rejected: (name) => rejected.get(`https://image.test/${name}.svg`) ?? 0,
        observed: (canvas) => observedCanvases.has(canvas),
        waiting: (name) => pending.has(`https://image.test/${name}.svg`),
        release(name, includingRemounts = false) {
          const key = `https://image.test/${name}.svg`;
          if (includingRemounts) released.add(key);
          for (const item of pending.get(key) ?? []) item.resolve();
          pending.delete(key);
        },
        reject(name) {
          const key = `https://image.test/${name}.svg`;
          for (const item of pending.get(key) ?? [])
            item.reject(new Error("held decode rejected"));
          pending.delete(key);
        },
        intersect() {
          for (const observer of observers)
            observer.callback([
              { isIntersecting: true, target: observer.target },
            ]);
        },
      };
    },
    { holdVisibility },
  );
}

const frame = (page) =>
  page.getByRole("link", { name: "Open image attachment" });
const shown = (page) =>
  expect(frame(page).locator("img")).toHaveCSS("visibility", "visible");
const waiting = (page, name) =>
  expect
    .poll(() => page.evaluate((name) => window.imageTest.waiting(name), name))
    .toBe(true);
const releaseDecode = (page, name) =>
  page.evaluate((name) => window.imageTest.release(name), name);

async function routeOriginals(page, requests) {
  await page.route("https://image.test/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill(
      route.request().url().endsWith("/failed.svg")
        ? { status: 404, body: "missing" }
        : {
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="10" height="10" fill="orange"/></svg>',
          },
    );
  });
}

test("blurhash visibility, decode swap, failure and retired source lifetimes", async ({
  page,
}, testInfo) => {
  const requests = [];
  await holdDecodes(page);
  await routeOriginals(page, requests);
  const server = await fixtureServer();
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/attachment-image.html`,
    );
    // Mounted but offscreen (as in a long thread) must not spend pixel work.
    // The product observes the canvas in a passive effect, so wait for that
    // registration first. Barrier: an IntersectionObserver created after the
    // product's delivers its first notification in the same or a later task,
    // so the product's initial visibility callback has already run.
    await expect
      .poll(() =>
        frame(page)
          .locator("canvas")
          .evaluate((canvas) => window.imageTest.observed(canvas)),
      )
      .toBe(true);
    await frame(page)
      .locator("canvas")
      .evaluate(
        (canvas) =>
          new Promise((resolve) => {
            const observer = new IntersectionObserver(() => {
              observer.disconnect();
              resolve();
            });
            observer.observe(canvas);
          }),
      );
    expect(await page.evaluate(() => window.imageTest.paints)).toEqual([]);
    await page.getByRole("button", { name: "Reveal", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.imageTest.paints.length))
      .toBe(1);
    const bounds = await frame(page).boundingBox();
    await waiting(page, "first");
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    expect(
      await frame(page)
        .locator("canvas")
        .evaluate((canvas) =>
          [...canvas.getContext("2d").getImageData(0, 0, 1, 1).data].some(
            (x) => x > 0,
          ),
        ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("held-blurhash.png") });
    await releaseDecode(page, "first");
    await shown(page);
    // The decoded original owns its frame; transparency never exposes old colors.
    await expect(frame(page).locator("canvas")).toHaveCount(0);
    await expect(frame(page).locator("img")).toHaveCSS("object-fit", "contain");
    await expect(frame(page)).toHaveCSS("clip-path", "none");
    await expect(frame(page).locator("[data-image-outline]")).toHaveCSS(
      "overflow",
      "visible",
    );
    const decodedBounds = await frame(page).boundingBox();
    expect(decodedBounds.width).toBe(20);
    expect(decodedBounds.height).toBe(10);
    await expect(frame(page).locator("span").first()).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await page.screenshot({
      path: testInfo.outputPath("transparent-original.png"),
    });
    await page.getByRole("button", { name: "Retarget", exact: true }).click();
    await waiting(page, "next");
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    await expect(frame(page).locator("canvas")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Restore original", exact: true })
      .click();
    await waiting(page, "first");
    expect(await frame(page).boundingBox()).toEqual(bounds);
    await expect(frame(page)).not.toHaveAttribute("data-image-ready");
    await page.evaluate(() => window.imageTest.reject("first"));
    await expect
      .poll(() => page.evaluate(() => window.imageTest.rejected("first")))
      .toBeGreaterThan(0);
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    await expect(frame(page).locator("canvas")).toHaveCount(1);
    expect(await frame(page).boundingBox()).toEqual(bounds);
    await expect(frame(page)).not.toHaveAttribute("data-image-ready");
    await page.getByRole("button", { name: "Retarget", exact: true }).click();
    await waiting(page, "next");
    await page
      .getByRole("button", { name: "Fail original", exact: true })
      .click();
    await expect
      .poll(() =>
        frame(page)
          .locator("img")
          .evaluate((img) => img.complete),
      )
      .toBe(true);
    await releaseDecode(page, "next"); // late callback for a retired source
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    await expect(frame(page).locator("canvas")).toHaveCount(1);
    expect(await frame(page).boundingBox()).toEqual(bounds);
    await page.getByRole("button", { name: "Retarget", exact: true }).click();
    await waiting(page, "next");
    await page
      .getByRole("button", { name: "Toggle mount", exact: true })
      .click();
    await releaseDecode(page, "next"); // late callback after unmount
    await expect(frame(page)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle mount", exact: true })
      .click();
    await waiting(page, "next");
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    await releaseDecode(page, "next");
    await shown(page);
    expect(
      await page.evaluate(() =>
        window.imageTest.paints.every((p) => p.width === 32 && p.height === 32),
      ),
    ).toBe(true);
    expect(
      requests.every((url) =>
        /^https:\/\/image.test\/(first|next|failed)\.svg$/.test(url),
      ),
    ).toBe(true);
    await testInfo.attach("original-only-request-ledger", {
      body: JSON.stringify(requests, null, 2),
      contentType: "application/json",
    });
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await server.close();
    }
  }
});

test("original ready first cannot regress on late visibility; missing and invalid hashes still load", async ({
  page,
}) => {
  await holdDecodes(page, true);
  await routeOriginals(page, []);
  const server = await fixtureServer();
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/attachment-image.html`,
    );
    await page.getByRole("button", { name: "Reveal", exact: true }).click();
    await waiting(page, "first");
    await releaseDecode(page, "first");
    await shown(page);
    await page.evaluate(() => window.imageTest.intersect());
    expect(await page.evaluate(() => window.imageTest.paints)).toEqual([]);
    await expect(frame(page).locator("canvas")).toHaveCount(0);
    for (const name of ["No hash", "Invalid hash"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await waiting(page, "first");
      await expect(frame(page).locator("canvas")).toHaveCount(0);
      await releaseDecode(page, "first");
      await shown(page);
    }
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await server.close();
    }
  }
});

test("original decode rejection retains blur and the next source still recovers", async ({
  page,
}) => {
  await holdDecodes(page);
  await routeOriginals(page, []);
  const server = await fixtureServer();
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/attachment-image.html`,
    );
    await page.getByRole("button", { name: "Reveal", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.imageTest.paints.length))
      .toBe(1);
    await waiting(page, "first");
    await page.evaluate(() => window.imageTest.reject("first"));
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    await expect(frame(page).locator("canvas")).toHaveCount(1);
    await page.getByRole("button", { name: "Retarget", exact: true }).click();
    await waiting(page, "next");
    await releaseDecode(page, "next");
    await shown(page);
    await expect(frame(page).locator("canvas")).toHaveCount(0);
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await server.close();
    }
  }
});

for (const unavailable of ["canvas", "visibility"]) {
  test(`unavailable ${unavailable} keeps the placeholder and original loading`, async ({
    page,
  }) => {
    await holdDecodes(page);
    await page.addInitScript((unavailable) => {
      if (unavailable === "canvas")
        HTMLCanvasElement.prototype.getContext = () => null;
      else window.IntersectionObserver = undefined;
    }, unavailable);
    await routeOriginals(page, []);
    const server = await fixtureServer();
    try {
      await server.listen();
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/attachment-image.html`,
      );
      await page.getByRole("button", { name: "Reveal", exact: true }).click();
      await waiting(page, "first");
      expect(await page.evaluate(() => window.imageTest.paints)).toEqual([]);
      await expect(frame(page).locator("img")).toHaveCSS(
        "visibility",
        "hidden",
      );
      await releaseDecode(page, "first");
      await shown(page);
      await expect(frame(page).locator("canvas")).toHaveCount(0);
    } finally {
      try {
        await page.unrouteAll({ behavior: "wait" });
      } finally {
        await server.close();
      }
    }
  });
}

// Virtua measurement, native scroll clamping and actual eviction require a browser.
test("decoded image resizing preserves reading and bottom following across remounts", async ({
  page,
}) => {
  await holdDecodes(page);
  await routeOriginals(page, []);
  const server = await fixtureServer();
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/image-scroll.html`,
    );
    const feed = page.getByRole("region", { name: "Channel message history" });
    const latestImage = feed.locator('img[src="https://image.test/58.svg"]');
    const bottomDistance = () =>
      feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await waiting(page, "58");
    await settle(page, feed);
    expect(await bottomDistance()).toBeLessThan(4);
    await releaseDecode(page, "58");
    await expect(latestImage).toHaveCSS("visibility", "visible");
    await settle(page, feed);
    expect(await bottomDistance()).toBeLessThan(4);
    const originalNode = await latestImage.elementHandle();
    try {
      await navigate(page, -1);
      await expect(latestImage).toHaveCount(0);
      expect(await originalNode.evaluate((node) => node.isConnected)).toBe(
        false,
      );
      // A fraction of scroll extent can land on a text-only row. Position a
      // partially visible image while every remaining decode is still held.
      const readingImageId = await feed.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        const image = [
          ...element.querySelectorAll("[data-media-preview] img"),
        ].find((image) => {
          const bounds = image.getBoundingClientRect();
          return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
        });
        if (!image) throw new Error("No image intersects the reading viewport");
        const bounds = image.getBoundingClientRect();
        element.scrollTop += bounds.top + bounds.height / 2 - viewport.top;
        return image.closest("[data-message-id]").dataset.messageId;
      });
      await settle(page, feed);
      const visible = await feed.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll("[data-message-id]")].find(
          (row) => row.getBoundingClientRect().bottom > top,
        );
        const image = row.querySelector("[data-media-preview] img");
        const bounds = image?.getBoundingClientRect();
        return {
          id: row.dataset.messageId,
          top: row.getBoundingClientRect().top,
          name: image ? new URL(image.src).pathname.slice(1, -4) : null,
          imageTop: bounds?.top,
          imageBottom: bounds?.bottom,
          viewportTop: top,
        };
      });
      expect(visible.id).toBe(readingImageId);
      expect(visible.name).not.toBeNull();
      expect(visible.imageTop).toBeLessThan(visible.viewportTop);
      expect(visible.imageBottom).toBeGreaterThan(visible.viewportTop);
      const delayed = await feed
        .locator("[data-media-preview] img")
        .evaluateAll((images) =>
          images
            .filter((image) => {
              const row = image.closest("[data-message-id]");
              const viewport = image.closest(
                '[aria-label="Channel message history"]',
              );
              return (
                image.naturalWidth > 0 &&
                getComputedStyle(image).visibility === "hidden" &&
                row.getBoundingClientRect().bottom <=
                  viewport.getBoundingClientRect().top
              );
            })
            .map((image) => ({
              name: new URL(image.src).pathname.slice(1, -4),
              top: image.getBoundingClientRect().top,
            })),
        );
      expect(delayed.length).toBeGreaterThan(0);
      const names = delayed.map((image) => image.name);
      await expect
        .poll(() =>
          page.evaluate(
            (names) => names.every((name) => window.imageTest.waiting(name)),
            names,
          ),
        )
        .toBe(true);
      await settle(page, feed);
      const reading = await anchor(page);
      const resized = feed.locator(
        `img[src="https://image.test/${names.at(-1)}.svg"]`,
      );
      const beforeHeight = await resized.evaluate(
        (image) => image.getBoundingClientRect().height,
      );
      expect(beforeHeight).toBeGreaterThan(10);
      await page.evaluate((names) => {
        // Resizing this batch can evict and remount another batch member.
        // Keep these sources released so a new node cannot enter a fresh gate
        // after the old node's completion satisfied the barrier below.
        for (const name of names) window.imageTest.release(name, true);
      }, names);
      await expect
        .poll(() =>
          page.evaluate(
            (names) =>
              names.every((name) => window.imageTest.completed(name) > 0),
            names,
          ),
        )
        .toBe(true);
      await settle(page, feed);
      await expect(resized).toHaveCSS("visibility", "visible");
      expect(
        await resized.evaluate((image) => image.getBoundingClientRect().height),
      ).toBe(10);
      await expectAnchor(page, reading);
      expect(await bottomDistance()).toBeGreaterThan(400);

      // A shrinking visible placeholder changes its following content, while
      // Virtua retains the first visible message rather than the next paragraph.
      await waiting(page, visible.name);
      await releaseDecode(page, visible.name);
      await expect(
        feed.locator(`img[src="https://image.test/${visible.name}.svg"]`),
      ).toHaveCSS("visibility", "visible");
      await settle(page, feed);
      const visibleRow = feed.locator(`[data-message-id="${visible.id}"]`);
      await expect
        .poll(() =>
          visibleRow.evaluate(
            (row, top) => Math.abs(row.getBoundingClientRect().top - top),
            visible.top,
          ),
        )
        .toBeLessThan(1);
      expect(await bottomDistance()).toBeGreaterThan(400);

      const completed = await page.evaluate(() =>
        window.imageTest.completed("58"),
      );
      await navigate(page, 1);
      await expect(latestImage).toHaveCount(1);
      // The remount re-adopts the decoded original instead of hiding a new
      // node until it decodes, which flashed an empty frame on every return.
      expect(
        await latestImage.evaluate(
          (node, previous) => node === previous,
          originalNode,
        ),
      ).toBe(true);
      await expect(latestImage).toHaveCSS("visibility", "visible");
      await expect(latestImage).toHaveCSS("height", "10px");
      await settle(page, feed);
      expect(
        await page.evaluate(() => [
          window.imageTest.waiting("58"),
          window.imageTest.completed("58"),
        ]),
      ).toEqual([false, completed]);
      expect(await bottomDistance()).toBeLessThan(4);
    } finally {
      await originalNode.dispose();
    }
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await server.close();
    }
  }
});
