import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

const fixtureImage = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#666"/></svg>`;

function fixtureMediaPlugin() {
  return {
    name: "messages-fixture-media",
    configureServer(server) {
      server.middlewares.use("/api/relay/media", (req, res, next) => {
        if (req.method !== "GET") return next();
        const url = new URL(req.url ?? "", "http://fixture.local");
        const target = url.searchParams.get("url") ?? "";
        if (!target.startsWith("https://fixture.test/media/")) return next();
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Length": Buffer.byteLength(fixtureImage),
        });
        res.end(fixtureImage);
      });
    },
  };
}

function createMessagesServer() {
  return createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [fixtureMediaPlugin(), react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
}

async function withMessagesFixture(page, run, search = "") {
  const server = await createMessagesServer();
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html${search}`,
    );
    await run();
  } finally {
    await server.close();
  }
}

async function visibleBox(locator) {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return box && box.width > 0 && box.height > 0;
    })
    .toBeTruthy();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected nonzero layout box");
  return box;
}

function containedWithin(inner, outer) {
  const epsilon = 1;
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - epsilon);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - epsilon);
  expect(inner.x + inner.width).toBeLessThanOrEqual(
    outer.x + outer.width + epsilon,
  );
  expect(inner.y + inner.height).toBeLessThanOrEqual(
    outer.y + outer.height + epsilon,
  );
}

test("media review stage contains portrait video and image media", async ({
  page,
}) => {
  await withMessagesFixture(page, async () => {
    await page.setViewportSize({ width: 900, height: 700 });
    const fixtureUrl = page.url();
    await page.goto(`${fixtureUrl}?portraitVideo`);
    const stage = page.getByTestId("portrait-video-stage");
    const video = stage.locator("video");
    await video.evaluate((element) => {
      element.style.aspectRatio = "9 / 16";
    });
    containedWithin(await visibleBox(video), await visibleBox(stage));
    await page.goto(fixtureUrl);

    await page
      .getByRole("button", { name: "Review image", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    await expect(dialog).toBeVisible();
    const reviewStage = dialog.locator('[class*="mediaReviewStage"]');
    const imageStage = dialog.locator('[class*="imageReviewStage"]');
    const image = imageStage.locator("img");
    await expect(image).toHaveJSProperty("complete", true);
    containedWithin(
      await visibleBox(imageStage),
      await visibleBox(reviewStage),
    );
    containedWithin(await visibleBox(image), await visibleBox(imageStage));
  });
});

// Browser-only: scoped tokens and inherited aliases resolve at different owners.
// Exercise the production viewer opened from a light host, not a styled stand-in.
test("media review chrome follows host colors while stage controls stay dark", async ({
  page,
}) => {
  await withMessagesFixture(page, async () => {
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.dataset.colorMode = "light";
    });
    await page
      .getByRole("button", { name: "Review image", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    const close = dialog.getByRole("button", {
      name: "Close fullscreen viewer",
    });
    const comments = dialog.getByRole("button", {
      name: /^(Show|Hide) comments$/,
    });
    const stage = dialog.locator("[data-review-stage]");
    const zoom = stage.getByRole("button", { name: "Zoom in", exact: true });
    await expect(stage).toHaveAttribute("data-color-mode", "dark");
    await page.mouse.move(0, 0);
    for (const [button, color] of [
      [close, "rgb(95, 95, 95)"],
      [comments, "rgb(15, 15, 15)"],
    ]) {
      await expect(button).toHaveCSS("color", color);
      await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    await expect(zoom).toHaveCSS("color", "rgb(255, 255, 255)");
    await stage.getByRole("group", { name: "Image gallery" }).hover({
      position: { x: 8, y: 8 },
    });
    await zoom.hover();
    await expect(zoom).toHaveCSS("background-color", "rgb(46, 46, 46)");
    await page.mouse.down();
    try {
      await expect(zoom).toHaveCSS("background-color", "rgb(51, 51, 51)");
    } finally {
      // Inspect :active without also changing the image zoom.
      await page.mouse.move(0, 0);
      await page.mouse.up();
    }
    // Live host changes retint chrome while the media stage stays dark.
    for (const mode of ["dark", "light"]) {
      await page.evaluate((mode) => {
        document.documentElement.classList.toggle("dark", mode === "dark");
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      await expect(close).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      for (const button of [close, comments]) {
        await expect(button).toHaveCSS(
          "color",
          button === close
            ? mode === "light"
              ? "rgb(95, 95, 95)"
              : "rgb(164, 164, 164)"
            : mode === "light"
              ? "rgb(15, 15, 15)"
              : "rgb(255, 255, 255)",
        );
      }
      await expect(stage).toHaveCSS("background-color", "rgb(0, 0, 0)");
      await expect(zoom).toHaveCSS("color", "rgb(255, 255, 255)");
    }
    await close.click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Review image", exact: true }),
    ).toBeFocused();
  });
});

test("inline video controls follow playback, hover and keyboard focus", async ({
  page,
}) => {
  await withMessagesFixture(page, async () => {
    await page.goto(
      new URL("/tests/fixtures/media-review.html", page.url()).href,
    );
    const preview = page.locator("[data-video-preview]").first();
    const video = preview.locator("video");
    const play = preview.getByRole("button", {
      name: "Play video",
      exact: true,
    });
    const expand = preview.getByRole("button", {
      name: "Open video fullscreen",
    });
    const timeline = preview.getByRole("slider", { name: "Video progress" });
    const controlRow = timeline.locator("..").locator("..");
    const controls = () => [
      preview.getByRole("button", { name: /^(Play|Pause) video$/ }),
      controlRow.locator(":scope > span").first(),
      expand,
    ];
    const finePointer = await page.evaluate(
      () => matchMedia("(hover: hover) and (pointer: fine)").matches,
    );
    test.skip(
      !finePointer,
      "Browser project does not expose a hover-capable fine pointer.",
    );
    await expect(timeline).toBeEnabled();
    await page.mouse.move(1, 1);
    await expect(play).toHaveCSS("opacity", "1");
    await expect(expand).toHaveCSS("opacity", "0");
    await preview.hover({ position: { x: 8, y: 8 } });
    await expect(expand).toHaveCSS("opacity", "1");
    await page.mouse.move(1, 1);
    await expect(expand).toHaveCSS("opacity", "0");
    await play.focus();
    await page.keyboard.press("Tab");
    await expect(
      preview.getByRole("button", { name: "Video volume", exact: true }),
    ).toBeFocused();
    await expect(expand).toHaveCSS("opacity", "1");
    await page
      .getByRole("link", { name: "Open image attachment", exact: true })
      .first()
      .focus();
    await expect(expand).toHaveCSS("opacity", "0");
    // Keep playback active throughout the visibility assertions, independent
    // of clip length: a zero rate plays without advancing the clock. Not
    // `loop`: on Linux WebKit, a seek back to 0 during playback leaves this
    // clip re-seeking to 0 and stalling, and in CI the Pause click then left
    // the video playing.
    await video.evaluate((element) => {
      element.playbackRate = 0;
    });
    await play.click();
    await expect(video).toHaveJSProperty("paused", false);
    await page.mouse.move(1, 1);
    for (const control of controls())
      await expect(control).toHaveCSS("opacity", "0");
    await preview.hover({ position: { x: 8, y: 8 } });
    for (const control of controls())
      await expect(control).toHaveCSS("opacity", "1");
    await page.mouse.move(1, 1);
    for (const control of controls())
      await expect(control).toHaveCSS("opacity", "0");
    await preview.getByRole("button", { name: "Pause video" }).focus();
    await page.keyboard.press("Tab");
    await expect(
      preview.getByRole("button", { name: "Video volume", exact: true }),
    ).toBeFocused();
    for (const control of controls())
      await expect(control).toHaveCSS("opacity", "1");
    await page
      .getByRole("link", { name: "Open image attachment", exact: true })
      .first()
      .focus();
    for (const control of controls())
      await expect(control).toHaveCSS("opacity", "0");
    await preview.hover({ position: { x: 8, y: 8 } });
    await preview.getByRole("button", { name: "Pause video" }).click();
    await expect(video).toHaveJSProperty("paused", true);
    await page.mouse.move(1, 1);
    await expect(play).toHaveCSS("opacity", "1");
    await expect(controlRow.locator(":scope > span").first()).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(expand).toHaveCSS("opacity", "0");
  });
});

// Independent source consumer proves safe ordinary-prop reuse, with real React,
// thread reader and durable outbox. No developer env, broker, credentials or relay.
test("media review hands off the thread draft, contains focus and keeps narrow controls reachable", async ({
  page,
}) => {
  const server = await createMessagesServer();
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const draft = thread.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await draft.fill("Draft handoff");
    const trigger = page.getByRole("button", {
      name: "Review image",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    await expect(dialog).toBeVisible();
    await expect(thread).toHaveCount(0);
    const reviewDraft = dialog.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(reviewDraft).toHaveText("Draft handoff");
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(
      dialog.getByRole("button", { name: "Next image" }),
    ).toBeInViewport();
    await expect(
      dialog.getByRole("link", { name: "Download image" }),
    ).toBeInViewport();
    await dialog
      .getByRole("link", { name: "Open image attachment" })
      .last()
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(
      dialog.getByRole("region", { name: "Media comments" }),
    ).toBeVisible();
    const activeDraft = dialog.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await activeDraft.press("Enter");
    await expect(activeDraft).toHaveText("");
    const close = dialog.getByRole("button", {
      name: "Close fullscreen viewer",
    });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(
      page
        .getByRole("complementary", { name: "Thread", exact: true })
        .getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toHaveText("");
  } finally {
    await server.close();
  }
});

test("shared thread UI auto-loads, follows live replies, retries and isolates retargeted drafts", async ({
  page,
}, testInfo) => {
  const server = await createMessagesServer();
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    await page.evaluate(() => window.messagesFixture.activate());
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.extensionsActive()),
      )
      .toContain("custom");
    const feed = page.getByRole("region", { name: "Channel message history" });
    await expect(
      feed.getByRole("heading", { name: "Channel Markdown", level: 2 }),
    ).toBeVisible();
    await expect(
      feed.getByText("Virtualized channel row", { exact: true }),
    ).toHaveCSS("font-weight", /^(650|700)$/);
    const feedIndentation = await feed.evaluate(() => {
      const nested = [...document.querySelectorAll("li")].find(
        (item) => item.textContent?.trim() === "channel nested",
      );
      const outer = nested?.parentElement?.parentElement;
      if (!(outer instanceof HTMLLIElement) || !nested)
        throw new Error("Missing channel nested ordered list");
      return {
        outer: outer.getBoundingClientRect().left,
        nested: nested.getBoundingClientRect().left,
      };
    });
    expect(feedIndentation.nested).toBeGreaterThan(feedIndentation.outer + 8);
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = panel.getByRole("region", { name: "Thread messages" });
    const feedAuthorAvatar = feed.locator(
      '[data-message-id="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"] [data-avatar-shape]',
    );
    await expect(feedAuthorAvatar).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    const draft = panel.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    const choose = (name) =>
      page.getByRole("button", { name, exact: true }).click();
    const gap = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    await expect(history.locator("[data-message-id]")).toHaveCount(62);
    // Loading belongs to history; the composer retains its live region idle.
    await expect(history.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Load more replies", exact: true }),
    ).toHaveCount(0);
    await expect.poll(gap).toBeLessThan(2);
    await expect(
      history.getByRole("heading", { name: "Markdown reply", level: 2 }),
    ).toBeVisible();
    await expect(history.getByText("Bold", { exact: true })).toHaveCSS(
      "font-weight",
      /^(650|700)$/,
    );
    await expect(history.getByText("italic", { exact: true })).toHaveCSS(
      "font-style",
      "italic",
    );
    await expect(history.locator("del")).toHaveText("done");
    await expect(
      history
        .getByText("unordered one", { exact: true })
        .locator("xpath=ancestor::ul[1]"),
    ).toHaveCSS("list-style-type", "disc");
    const indentation = await history.evaluate(() => {
      const nested = [...document.querySelectorAll("li")].find(
        (item) => item.textContent?.trim() === "nested",
      );
      const outer = nested?.parentElement?.parentElement;
      if (!(outer instanceof HTMLLIElement) || !nested)
        throw new Error("Missing nested ordered list");
      if (getComputedStyle(nested.parentElement).listStyleType !== "decimal")
        throw new Error("Nested ordered list lost its marker style");
      return {
        outer: outer.getBoundingClientRect().left,
        nested: nested.getBoundingClientRect().left,
      };
    });
    expect(indentation.nested).toBeGreaterThan(indentation.outer + 8);
    await expect(history.getByAltText(":_lead:")).toBeVisible();
    await expect(history.getByAltText(":trail_:")).toBeVisible();
    await expect(
      history.getByRole("heading", { name: "Agent Markdown", level: 3 }),
    ).toBeVisible();
    const threadAgentAvatar = history
      .getByRole("heading", { name: "Agent Markdown" })
      .locator("xpath=ancestor::*[@data-message-id][1]")
      .locator("[data-avatar-shape]")
      .first();
    await expect(threadAgentAvatar).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
    const threadRoot = history
      .getByText("First root", { exact: true })
      .locator("xpath=ancestor::*[@data-message-id][1]");
    // The divider ends the original's bubble group; it retains its avatar,
    // and the first reply starts a separate group even with the same author.
    await expect(threadRoot.locator("[data-layout]")).not.toHaveAttribute(
      "data-stack-next",
    );
    await expect(threadRoot.locator("[data-avatar-shape]")).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    const firstReply = history
      .getByText("Reply with image", { exact: true })
      .locator("xpath=ancestor::*[@data-message-id][1]");
    await expect(firstReply.locator("[data-layout]")).not.toHaveAttribute(
      "data-stack-previous",
    );
    // Replies still group together, with the avatar on their final human row.
    const threadHumanAvatar = history
      .getByRole("heading", { name: "Markdown reply", level: 2 })
      .locator("xpath=ancestor::*[@data-message-id][1]")
      .locator("[data-avatar-shape]")
      .first();
    await expect(threadHumanAvatar).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    const evidence = testInfo.outputPath("human-agent-thread-avatars.png");
    const humanBox = await threadHumanAvatar.boundingBox();
    const agentBox = await threadAgentAvatar.boundingBox();
    const panelBox = await panel.boundingBox();
    if (!humanBox || !agentBox || !panelBox)
      throw new Error("Missing avatar evidence bounds");
    const top = Math.max(0, Math.min(humanBox.y, agentBox.y) - panelBox.y - 36);
    const bottom =
      Math.max(humanBox.y + humanBox.height, agentBox.y + agentBox.height) -
      panelBox.y +
      72;
    await panel.screenshot({
      path: evidence,
      clip: { x: 0, y: top, width: 440, height: bottom - top },
    });
    await testInfo.attach("human-agent-thread-avatars", {
      path: evidence,
      contentType: "image/png",
    });
    await expect(
      history.getByText("Rendered from an agent envelope", { exact: true }),
    ).toHaveCSS("font-weight", /^(650|700)$/);
    await expect(
      history.locator("code").filter({ hasText: "agent-code" }),
    ).toBeVisible();
    // A <br> count misses a second line box caused by inherited pre-wrap.
    // Measure the actual first/second text baselines in both shared surfaces.
    for (const surface of [feed, history]) {
      const paragraph = surface
        .locator("p")
        .filter({ hasText: /^first\s*second$/ });
      await expect(paragraph.locator("br")).toHaveCount(1);
      const geometry = await paragraph.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const tops = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (const word of ["first", "second"]) {
            const start = node.textContent.indexOf(word);
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + word.length);
            tops.push(range.getBoundingClientRect().top);
          }
        }
        return {
          tops,
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        };
      });
      expect(geometry.tops).toHaveLength(2);
      expect(
        Math.abs(geometry.tops[1] - geometry.tops[0] - geometry.lineHeight),
      ).toBeLessThan(1);
      expect(Math.abs(geometry.height - 2 * geometry.lineHeight)).toBeLessThan(
        1,
      );
    }
    await expect(history.locator("pre code")).toHaveCSS("white-space", "pre");
    await expect(history.locator("table")).toContainText("wide-column-one-");
    await expect(history.locator("pre code")).toContainText("wide-content-");
    // Exercise native popup navigation without depending on a public website.
    await page.context().route("https://example.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<p>External destination</p>",
      }),
    );
    const safeLink = history.getByRole("link", { name: "Safe link" });
    await expect(safeLink).toHaveAttribute("href", "https://example.com/path");
    await expect(safeLink).toHaveAttribute("rel", "noopener noreferrer");
    const pagesBefore = page.context().pages().length;
    await safeLink.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.links.at(-1)),
      )
      .toBe("https://example.com/path");
    expect(page.context().pages()).toHaveLength(pagesBefore);
    const unhandled = history.getByRole("link", { name: "Unhandled link" });
    const popup = page.waitForEvent("popup");
    await unhandled.click();
    const external = await popup;
    await external.waitForLoadState("domcontentloaded");
    expect(external.url()).toBe("https://example.com/unhandled");
    await external.close();
    // Observe after React's delegated handler, then suppress only the browser's
    // cross-origin background tab (which crashes headless Chromium). Native
    // unhandled navigation is exercised above; here we verify modifier ownership.
    const stopObserving = await safeLink.evaluateHandle((link) => {
      const observe = (event) => {
        if (!event.composedPath().includes(link)) return;
        link.dataset.modifiedClick = JSON.stringify({
          prevented: event.defaultPrevented,
          modified: event.ctrlKey || event.metaKey,
        });
        event.preventDefault();
      };
      document.addEventListener("click", observe);
      return () => document.removeEventListener("click", observe);
    });
    try {
      await safeLink.click({ modifiers: ["ControlOrMeta"] });
      await expect(safeLink).toHaveAttribute(
        "data-modified-click",
        JSON.stringify({ prevented: false, modified: true }),
      );
      expect(
        await page.evaluate(() => window.messagesFixture.report.links.length),
      ).toBe(2);
    } finally {
      await stopObserving.evaluate((stop) => stop());
      await stopObserving.dispose();
    }
    await history.evaluate((element) => {
      for (const selector of ["pre code", "table"]) {
        const item = element.querySelector(selector);
        if (!(item instanceof HTMLElement))
          throw new Error(`Missing ${selector}`);
        if (
          item.getBoundingClientRect().right >
          element.getBoundingClientRect().right + 1
        )
          throw new Error(`${selector} overflows the thread`);
        if (item.scrollWidth <= item.clientWidth)
          throw new Error(
            `${selector} does not provide local horizontal scrolling`,
          );
      }
    });
    await history.evaluate((el) => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.evaluate(() => window.messagesFixture.live());
    await expect(history.locator("[data-message-id]")).toHaveCount(63);
    await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(100);
    await draft.fill("keep first draft");
    await choose("Second root");
    await expect(draft).toHaveJSProperty("value", "");
    await expect(history.locator("[data-message-id]")).toHaveCount(61);
    await expect.poll(gap).toBeLessThan(2);
    await draft.fill("reject second reply");
    await draft.press("Enter");
    await expect(draft).toHaveJSProperty("value", "");
    await expect(
      panel.getByText("Couldn’t send this message.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByText("reject second reply", { exact: true }),
    ).toHaveCount(1);
    // Retry removes its control while queued; wait for the actual second publish.
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.publications.length),
      )
      .toBe(2);
    const delivery = await page.evaluate(() => window.messagesFixture.report);
    expect(delivery.signings).toHaveLength(1);
    expect(delivery.publications).toHaveLength(2);
    expect(delivery.publications[0]).toEqual(delivery.publications[1]);
    await choose("First root");
    await expect(draft).toHaveJSProperty("value", "keep first draft");
    await page
      .getByRole("textbox", { name: "Message #one", exact: true })
      .fill("keep channel draft");
    await choose("Other channel root");
    await expect(draft).toHaveJSProperty("value", "");
    await expect(
      page.getByRole("textbox", { name: "Message #two", exact: true }),
    ).toHaveJSProperty("value", "");
    await choose("First root");
    await expect(draft).toHaveJSProperty("value", "keep first draft");
    await expect(
      page.getByRole("textbox", { name: "Message #one", exact: true }),
    ).toHaveJSProperty("value", "keep channel draft");
    await choose("Switch scope");
    await expect(draft).toHaveJSProperty("value", "");
    await choose("Switch scope");
    await expect(draft).toHaveJSProperty("value", "keep first draft");
    for (const [index, kind] of [9, 40002].entries()) {
      await page.evaluate((value) => window.messagesFixture.deep(value), kind);
      await expect(history.locator("[data-message-id]")).toHaveCount(
        64 + index,
      );
      const literal = history
        .getByText("literal deep message", { exact: false })
        .last();
      await expect(literal).toBeVisible();
      await expect(literal).toHaveCSS("white-space", "pre-wrap");
    }
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

// Browser-only: real hit testing must reject suggestions painted behind the modal.
// DOM visibility alone cannot prove the listbox is visible or pointer-accessible.
test("media review completions stay visible and preserve modal keyboard ownership", async ({
  page,
}) => {
  const server = await createMessagesServer();
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    await page.evaluate(() => window.messagesFixture.activate());
    const trigger = page.getByRole("button", {
      name: "Review image",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    const input = dialog.getByRole("textbox", { name: "Reply to thread" });
    const topmost = (option) =>
      option.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      });
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 950 });
      await input.fill("@Fixture");
      const mention = page
        .getByRole("listbox", {
          name: "Mention suggestions",
        })
        .getByRole("option")
        .first();
      await expect(mention).toContainText("Fixture Reader");
      await expect.poll(() => topmost(mention)).toBe(true);
      await mention.click();
      await expect(input).toHaveJSProperty("value", "@Fixture Reader ");
      await expect(input).toBeFocused();
      await expect(input.locator(".inline-chip")).toContainText(
        "Fixture Reader",
      );
      for (const key of ["Enter", "Tab"]) {
        await input.fill(":smile");
        const emoji = page
          .getByRole("listbox", {
            name: "Emoji suggestions",
          })
          .getByRole("option")
          .first();
        await expect(emoji).toContainText(":smile:");
        await expect.poll(() => topmost(emoji)).toBe(true);
        await input.press(key);
        await expect(input).toHaveJSProperty("value", "😄");
        await expect(input).toBeFocused();
        await expect(page.getByRole("listbox")).toHaveCount(0);
      }
    }
    await input.fill(":smile");
    await expect(page.getByRole("option").first()).toBeVisible();
    await input.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    await input.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(
      await page.evaluate(() => window.messagesFixture.report.publications),
    ).toEqual([]);
  } finally {
    await server.close();
  }
});

test("exact reply media keeps its selected attachment and canonical thread", async ({
  page,
}) => {
  const server = await createMessagesServer();
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    await page.evaluate(() => window.messagesFixture.activate());
    await page
      .getByRole("button", { name: "Review exact reply image" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    await expect(dialog).toBeVisible();
    const comments = dialog.getByRole("region", { name: "Media comments" });
    await expect(comments).toContainText("Reply with image");
    const exactReplyId = await page.evaluate(
      () => window.messagesFixture.report.exactReplyId,
    );
    const reply = comments.locator(`[data-message-id="${exactReplyId}"]`);
    // The day divider names the reply's local day ("Today").
    const commentDay = await reply.locator("time").evaluate((time) => {
      const date = new Date(time.dateTime);
      return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((part) => String(part).padStart(2, "0"))
        .join("-");
    });
    await expect(
      comments.locator(`[data-day="${commentDay}"]`).first(),
    ).toBeVisible();
    await reply.hover();
    const addReaction = reply.getByTestId("reaction-row").getByRole("button", {
      name: "Add reaction",
      exact: true,
    });
    await expect(addReaction).toBeVisible();
    await addReaction.click();
    const search = page.locator('em-emoji-picker input[type="search"]');
    await search.fill("grinning");
    await page.getByRole("button", { name: "😀", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.publications.length),
      )
      .toBe(1);
    const reaction = await page.evaluate(
      () => window.messagesFixture.report.publications[0],
    );
    expect(reaction.kind).toBe(7);
    expect(reaction.content).toBe("😀");
    expect(reaction.tags).toContainEqual(["e", exactReplyId]);
    const draft = dialog.getByRole("textbox", { name: "Reply to thread" });
    await draft.fill("Canonical exact feedback");
    await draft.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.publications.length),
      )
      .toBe(2);
    const publication = await page.evaluate(
      () => window.messagesFixture.report.publications[1],
    );
    const rootId = await page.evaluate(
      () => window.messagesFixture.report.rootId,
    );
    expect(publication.tags).toContainEqual(["e", rootId, "", "reply"]);
  } finally {
    await server.close();
  }
});

// Browser-only: WebKit adds an `overflow-x: auto` scrollbar after flex and grid
// ancestors take their heights, so a virtual row keeps its old height: the next
// row overlaps an added scrollbar, and a removed one leaves a gap. Playwright
// WebKit uses overlay scrollbars on macOS, so these rules emulate scrollbars
// that take space; WebKit ignores ::-webkit-scrollbar while the standard
// scrollbar properties are set.
const spaceTakingScrollbars = `* { scrollbar-width: auto !important; scrollbar-color: auto !important; }
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-thumb { background: gray; }`;

test("message tables keep their scrollbar inside the row across resizes and edits", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "chromium",
    "Headless Chromium hides every scrollbar, and lays out an added one with its ancestors",
  );
  await page.addInitScript((css) => {
    const style = document.createElement("style");
    style.textContent = css;
    // Virtua measures a row from its first layout, so record whether each
    // table's message contains it as soon as React inserts it.
    const mounts = [];
    window.tableMounts = mounts;
    new MutationObserver((records) => {
      if (!style.isConnected) document.head?.append(style);
      for (const { addedNodes } of records)
        for (const node of addedNodes) {
          if (!(node instanceof Element)) continue;
          const tables = node.matches("table")
            ? [node]
            : node.querySelectorAll("table");
          for (const table of tables)
            if (table.closest('[aria-label="Channel message history"]'))
              mounts.push(
                Math.abs(
                  table.parentElement.getBoundingClientRect().bottom -
                    table.getBoundingClientRect().bottom,
                ) < 0.5,
              );
        }
    }).observe(document, { childList: true, subtree: true });
  }, spaceTakingScrollbars);
  await withMessagesFixture(page, async () => {
    const feed = page.getByRole("region", { name: "Channel message history" });
    await expect(feed.getByRole("table")).toHaveCount(2);
    // Row ids from the fixture: a wide table, a narrower one, then a follow-up.
    const layout = (id, nextId) =>
      feed.evaluate(
        (root, [id, nextId]) => {
          const table = root.querySelector(`[data-message-id="${id}"] table`);
          const next = root.querySelector(
            `[data-message-id="${nextId}"] [data-message-action-anchor]`,
          );
          const box = table.getBoundingClientRect();
          const style = getComputedStyle(table);
          const borders =
            Number.parseFloat(style.borderTopWidth) +
            Number.parseFloat(style.borderBottomWidth);
          return {
            scrolls: table.scrollWidth > table.clientWidth,
            scrollbar: table.offsetHeight - table.clientHeight > borders,
            // The table is its message's only content, so its box is the row's.
            contained:
              Math.abs(
                table.parentElement.getBoundingClientRect().bottom - box.bottom,
              ) < 0.5,
            clear: next.getBoundingClientRect().top >= box.bottom,
          };
        },
        [id.repeat(64), nextId.repeat(64)],
      );
    const wide = () => layout("c", "d");
    const narrower = () => layout("d", "e");
    const scrolling = {
      scrolls: true,
      scrollbar: true,
      contained: true,
      clear: true,
    };
    const fitting = { ...scrolling, scrolls: false, scrollbar: false };
    const resize = (width) =>
      // The fixture's fixed-width flex host stands in for a resized pane.
      feed.evaluate((element, width) => {
        element.parentElement.style.width = `${width}px`;
      }, width);

    await expect.poll(wide).toEqual(scrolling);
    await expect.poll(narrower).toEqual(fitting);
    // Both tables have mounted; each was contained in its first layout.
    expect(await page.evaluate(() => window.tableMounts)).toEqual([true, true]);
    await resize(400);
    await expect.poll(narrower).toEqual(scrolling);
    await resize(900);
    await expect.poll(narrower).toEqual(fitting);
    await expect.poll(wide).toEqual(scrolling);
    expect(
      await feed.evaluate((root, id) => {
        const table = root.querySelector(`[data-message-id="${id}"] table`);
        table.scrollLeft = table.scrollWidth;
        return table.scrollLeft;
      }, "c".repeat(64)),
    ).toBeGreaterThan(0);

    const editor = page.getByRole("textbox", { name: "Table markdown" });
    const short = "| A |\n| --- |\n| B |";
    await editor.fill(short);
    await expect.poll(narrower).toEqual(fitting);
    const table = feed.getByRole("table").nth(1);
    // Cap the content box at the fitting table's width. Wider text must change
    // scrollWidth without growing the table or replacing its React DOM node.
    const width = await table.evaluate((element) => {
      window.editedTable = element;
      const width = element.getBoundingClientRect().width;
      element.parentElement.style.width = `${width}px`;
      return width;
    });
    const expectSameTable = async () => {
      expect(
        await table.evaluate((element) => element === window.editedTable),
      ).toBe(true);
      expect((await table.boundingBox()).width).toBeCloseTo(width, 1);
    };
    await editor.fill(`| A |\n| --- |\n| ${"wide".repeat(100)} |`);
    await expect.poll(narrower).toEqual(scrolling);
    await expectSameTable();
    expect(
      await table.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        return element.scrollLeft;
      }),
    ).toBeGreaterThan(0);
    await editor.fill(short);
    await expect.poll(narrower).toEqual(fitting);
    await expectSameTable();
  });
});

// Browser-only: the shared Button keeps labels on one line, so only layout
// shows a long conversation name reflowing inside the pane instead of clipping.
test("a thread's long conversation name wraps inside its pane and opens from the keyboard", async ({
  page,
}) => {
  await watchPageErrors(page);
  await withMessagesFixture(
    page,
    async () => {
      // A narrow pane with enlarged text, where the name needs two lines.
      await page.setViewportSize({ width: 820, height: 900 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "150%";
      });
      const thread = page.getByRole("complementary", { name: "Thread" });
      const link = thread.getByRole("button", {
        name: "#release-coordination-for-client-platform-migrations-in-production",
      });
      const linkBox = await visibleBox(link);
      containedWithin(linkBox, await visibleBox(thread));
      const lineHeight = await link.evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).lineHeight),
      );
      expect(linkBox.height).toBeGreaterThan(lineHeight * 1.5);
      await link.focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() =>
          page.evaluate(() => window.messagesFixture.report.parentOpens),
        )
        .toBe(1);
    },
    "?threadParent=1",
  );
});
