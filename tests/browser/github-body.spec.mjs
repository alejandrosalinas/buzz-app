import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
const target = "https://github.com/block/buzz-app/pull/327";
const before =
  "https://github.com/user-attachments/assets/81e77cff-0e61-4694-9a88-add0c1f997e4";
const after =
  "https://github.com/user-attachments/assets/dd1f7e4f-e2a4-4aec-b661-cb45032f29c5";
const picture =
  "https://github.com/user-attachments/assets/cd0773ee-9861-46d9-8a0f-352ae951ec7f";
// GitHub media downloads redirect to the objects CDN; the packaged media
// policy must allow the redirect origin, not only the original URL.
const redirected =
  "https://objects.githubusercontent.com/github-production-user-asset-6210df/659873452-after.mp4";
const videoPath = fileURLToPath(
  new URL("../fixtures/github-body.mp4", import.meta.url),
);
const imagePath = fileURLToPath(
  new URL("../fixtures/attachment-media/still.png", import.meta.url),
);
const details = {
  title: "Render PR descriptions with inline media",
  state: "open",
  body: `## Before\n\nThe description was **plain text**.\n\n${before}\n\n## After\n\nReview **formatted sections** and recordings in place.\n\n${after}\n\n### Checklist\n\n- [x] Preserve document order\n- [x] Keep original attachment links\n\n### Attachments\n\n- Video\n- Image\n\n1. Review\n2. Compare\n\n| Media | Result |\n| --- | --- |\n| Recordings | Inline players |\n\n<details><summary>Supporting evidence</summary><p>Captured after the change.</p><img src="${picture}" alt="Example attachment"><p><a href="https://github.com/user-attachments/files/99/source.zip">Source archive</a></p></details>`,
  body_html: `<video src="https://private-user-images.githubusercontent.com/1888043/659873452-81e77cff-0e61-4694-9a88-add0c1f997e4.mp4?jwt=expired"></video><video src="${after}"></video>`,
};

// Browser-only: real decoding/playback, fullscreen controls and seeking, CSS
// containment, CSP media enforcement, and the production message-to-panel path.
// Classification, failures and navigation races live in the colocated RTL tests.
test("PR media plays under the packaged media policy in a narrow GitHub panel", async ({
  page,
  context,
  app,
}, testInfo) => {
  const config = JSON.parse(
    await readFile(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  const mediaPolicy = config.app.security.csp
    .split(";")
    .filter((directive) => /^\s*(img|media)-src /.test(directive))
    .join(";")
    .trim();
  await page.route(`${app.origin}/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy": mediaPolicy,
      },
    });
  });
  await page.route(
    "https://api.github.com/repos/block/buzz-app/pulls/327",
    (route) => route.fulfill({ json: details }),
  );
  await page.route(
    /https:\/\/api\.github\.com\/repos\/.*\/(?:comments|reviews)\?/,
    (route) => route.fulfill({ json: [] }),
  );
  for (const [url, path, contentType] of [
    [before, videoPath, "video/mp4"],
    [after, videoPath, "video/mp4"],
    [redirected, videoPath, "video/mp4"],
    [picture, imagePath, "image/png"],
  ]) {
    const bytes = await readFile(path);
    await context.route(url, (route) => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(
        route.request().headers().range ?? "",
      );
      if (!range)
        return route.fulfill({
          body: bytes,
          contentType,
          headers: { "accept-ranges": "bytes" },
        });
      const start = Number(range[1]);
      const last = range[2]
        ? Math.min(Number(range[2]), bytes.length - 1)
        : bytes.length - 1;
      return route.fulfill({
        status: 206,
        contentType,
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${last}/${bytes.length}`,
        },
        body: bytes.subarray(start, last + 1),
      });
    });
  }
  const response = await page.goto(app.origin);
  expect(response.headers()["content-security-policy"]).toBe(mediaPolicy);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  app.append("primary", "alpha", target);
  const link = page.locator(`a[href="${target}"]`);
  await expect(link).toBeAttached();
  await end(page);
  await link.click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "Before", exact: true }),
  ).toBeVisible();
  const videos = panel.locator("video");
  await expect(videos).toHaveCount(2);
  await expect(panel.locator("ol")).toHaveCSS("list-style-type", "decimal");
  await expect(
    panel.locator("ul:not(.contains-task-list):not([aria-label])"),
  ).toHaveCSS("list-style-type", "disc");
  for (let index = 0; index < 2; index++) {
    const video = videos.nth(index);
    const preview = video.locator("..");
    // The two-second fixture must not end while a slow runner prepares Pause.
    await video.evaluate((element) => {
      element.loop = true;
    });
    await preview
      .getByRole("button", { name: "Play video", exact: true })
      .click();
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBeGreaterThan(0.2);
    await expect
      .poll(() => video.evaluate((element) => element.videoWidth))
      .toBeGreaterThan(0);
    await preview
      .getByRole("button", { name: "Pause video", exact: true })
      .click();
    await expect
      .poll(() => video.evaluate((element) => element.paused))
      .toBe(true);
    await expect(
      preview.getByRole("button", { name: "Play video", exact: true }),
    ).toBeVisible();
  }
  for (const source of [before, after])
    await expect(panel.locator(`a[href="${source}"]`)).toHaveCount(0);
  // WebKit can finish a seek issued just after playback pauses without moving:
  // seeked fires and currentTime stays where playback paused. Keep the
  // fullscreen video from autoplaying, so the seek below follows no pause, and
  // seek only after its initial-position restore has landed.
  await page.evaluate(() => {
    window.fullscreenRestored = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const video = document.querySelector(
          '[role="dialog"][aria-label="Video attachment"] video',
        );
        if (!video) return;
        observer.disconnect();
        video.pause();
        video.addEventListener("seeked", resolve, { once: true });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  });
  await panel
    .getByRole("button", { name: "Open video fullscreen" })
    .nth(1)
    .click();
  const viewer = page.getByRole("dialog", { name: "Video attachment" });
  await expect(viewer).toBeVisible();
  const fullscreen = viewer.locator("video");
  // The shared VideoPlayer supplies custom controls instead of native ones.
  await expect(
    viewer.getByRole("slider", { name: "Video timeline" }),
  ).toBeVisible();
  await expect
    .poll(() => fullscreen.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() =>
      fullscreen.evaluate(
        (element) =>
          element.seekable.length > 0 &&
          element.seekable.end(element.seekable.length - 1) >=
            element.duration / 2,
      ),
    )
    .toBe(true);
  await page.evaluate(() => window.fullscreenRestored);
  // Native seek controls are browser-owned; observe the real media seek boundary.
  const seek = await fullscreen.evaluate(async (element) => {
    const seconds = element.duration / 2;
    const completed = new Promise((resolve) =>
      element.addEventListener("seeked", resolve, { once: true }),
    );
    element.currentTime = seconds;
    await completed;
    return { actual: element.currentTime, expected: seconds };
  });
  expect(seek.actual).toBeCloseTo(seek.expected, 1);
  await page.screenshot({ path: testInfo.outputPath("fullscreen.png") });
  await page.getByRole("button", { name: "Close fullscreen viewer" }).click();
  await expect(viewer).toHaveCount(0);
  // Supported file downloads redirect to the objects CDN. Neither engine can
  // synthesize a redirect through routing, so exercise the redirect origin
  // directly under the enforced packaged media policy: removing it from
  // media-src makes this probe fail with a CSP media error.
  const redirectReady = await panel.evaluate(async (element, source) => {
    const probe = document.createElement("video");
    probe.muted = true;
    probe.preload = "metadata";
    probe.src = source;
    element.append(probe);
    try {
      await new Promise((resolve, reject) => {
        probe.addEventListener("loadedmetadata", resolve, { once: true });
        probe.addEventListener(
          "error",
          () => reject(new Error("blocked by media policy")),
          { once: true },
        );
      });
      return probe.readyState;
    } finally {
      probe.remove();
    }
  }, redirected);
  expect(redirectReady).toBeGreaterThanOrEqual(1);
  for (const width of [800, 480]) {
    await page.setViewportSize({ width, height: 850 });
    await panel
      .getByRole("heading", { name: "After", exact: true })
      .scrollIntoViewIfNeeded();
    const overflow = await panel.evaluate((element) =>
      [...element.querySelectorAll("video, table, img")]
        // Only rendered media have bounds to compare with the panel.
        .filter((media) => media.getClientRects().length > 0)
        .map((media) => {
          const outer = element.getBoundingClientRect(),
            inner = media.getBoundingClientRect();
          return {
            left: inner.left >= outer.left - 1,
            right: inner.right <= outer.right + 1,
          };
        }),
    );
    // Two videos, the table and the expanded image must all be measured.
    expect(overflow).toHaveLength(4);
    expect(overflow.every(({ left, right }) => left && right)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`panel-${width}.png`) });
  }
  const image = panel.getByRole("img", {
    name: "Example attachment",
    exact: true,
  });
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(() => image.evaluate((element) => element.naturalWidth))
    .toBeGreaterThan(0);
  await expect(panel).toContainText("Supporting evidence");
  await expect(panel).toContainText("Captured after the change.");
  await expect(
    panel.getByRole("link", { name: "Source archive" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/user-attachments/files/99/source.zip",
  );
  await page.screenshot({ path: testInfo.outputPath("html-evidence.png") });
  await panel.getByRole("button", { name: "Open image fullscreen" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Image attachment" })
      .getByAltText("Example attachment"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close fullscreen viewer" }).click();
});

// Browser-only: a real failed media read of a private repository's sign-in-only
// link, then its signed link decoding under the enforced packaged media policy.
// The link order, renewal and no-loop rules live in the colocated RTL tests.
test.describe("private repository media", () => {
  // Their own links are not found without a GitHub sign-in; only each of
  // those responses' own console error passes.
  test.use({
    expectedStartupLoadFailure: "https://github.com/user-attachments/assets/",
  });
  test("private PR media falls back to its signed links under the packaged media policy", async ({
    page,
    context,
    app,
  }) => {
    const config = JSON.parse(
      await readFile(
        new URL("../../src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
      ),
    );
    const mediaPolicy = config.app.security.csp
      .split(";")
      .filter((directive) => /^\s*(img|media)-src /.test(directive))
      .join(";")
      .trim();
    await page.route(`${app.origin}/`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": mediaPolicy,
        },
      });
    });
    const privateTarget = "https://github.com/block/buzz-app/pull/328";
    const id = (uuid) => `https://github.com/user-attachments/assets/${uuid}`;
    const signed = (uuid, file) =>
      `https://private-user-images.githubusercontent.com/1/2-${uuid}.${file}?jwt=fresh`;
    const imageId = "3f2a9c1e-7b4d-4e8a-9c61-2d5b8e0f4a17";
    const videoId = "6c1d0b7e-2f3a-4d5e-8b9c-0a1b2c3d4e5f";
    await page.route(
      "https://api.github.com/repos/block/buzz-app/pulls/328",
      (route) =>
        route.fulfill({
          json: {
            title: "Show the order total before paying",
            state: "open",
            body: `![Checkout screen](${id(imageId)})\n\n${id(videoId)}`,
            body_html: `<p><a href="${signed(imageId, "png")}"><img src="${signed(imageId, "png")}" data-canonical-src="${id(imageId)}" alt="Checkout screen"></a></p><video src="${signed(videoId, "mp4")}"></video>`,
          },
        }),
    );
    await page.route(
      /https:\/\/api\.github\.com\/repos\/.*\/(?:comments|reviews)\?/,
      (route) => route.fulfill({ json: [] }),
    );
    // Without a GitHub sign-in, a private repository's own links are not found.
    const unsigned = [];
    for (const uuid of [imageId, videoId])
      await context.route(id(uuid), (route) => {
        unsigned.push(uuid);
        return route.fulfill({ status: 404 });
      });
    for (const [url, path, contentType] of [
      [signed(imageId, "png"), imagePath, "image/png"],
      [signed(videoId, "mp4"), videoPath, "video/mp4"],
    ]) {
      const bytes = await readFile(path);
      await context.route(url, (route) => {
        const range = /^bytes=(\d+)-(\d*)$/.exec(
          route.request().headers().range ?? "",
        );
        if (!range)
          return route.fulfill({
            body: bytes,
            contentType,
            headers: { "accept-ranges": "bytes" },
          });
        const start = Number(range[1]);
        const last = range[2]
          ? Math.min(Number(range[2]), bytes.length - 1)
          : bytes.length - 1;
        return route.fulfill({
          status: 206,
          contentType,
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${last}/${bytes.length}`,
          },
          body: bytes.subarray(start, last + 1),
        });
      });
    }
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page
      .getByRole("textbox", { name: "Message #Alpha", exact: true })
      .waitFor();
    await settle(page);
    app.append("primary", "alpha", privateTarget);
    const link = page.locator(`a[href="${privateTarget}"]`);
    await expect(link).toBeAttached();
    await end(page);
    await link.click();
    const panel = page.getByRole("complementary", {
      name: "GitHub",
      exact: true,
    });
    const image = panel.getByAltText("Checkout screen");
    await expect(image).toHaveAttribute("src", signed(imageId, "png"));
    await expect
      .poll(() => image.evaluate((element) => element.naturalWidth))
      .toBeGreaterThan(0);
    const video = panel.locator("video");
    await expect(video).toHaveAttribute("src", signed(videoId, "mp4"));
    await expect
      .poll(() => video.evaluate((element) => element.videoWidth))
      .toBeGreaterThan(0);
    await expect(panel.getByRole("status")).toHaveCount(0);
    expect([...new Set(unsigned)].sort()).toEqual([imageId, videoId].sort());
  });
});
