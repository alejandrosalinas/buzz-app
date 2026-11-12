import { test, expect } from "./playwright-test.mjs";
import { readFile } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import { createServer } from "./vite-server.mjs";

// The preparation journeys import their modules into a bare same-origin page.
// The app's index.html would boot the whole app, and its first load
// transforms over a thousand modules inside the navigation timeout.
async function openPreparationDocument(page, server) {
  const url = `http://127.0.0.1:${server.httpServer.address().port}/attachment-preparation`;
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Attachment preparation</title>",
    }),
  );
  await page.goto(url);
}

// Browser-only boundary: actual File/DataTransfer delivery, editor capture and page wiring.
test("picker, pane drop and clipboard files use the same attachment draft and existing Send", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [
      react(),
      {
        name: "attachment-download-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === "/api/relay/upload" && req.method === "POST") {
              res.writeHead(204, { "X-Content-Type-Options": "nosniff" });
              res.end();
              return;
            }
            if (!req.url?.startsWith("/api/relay/media?")) return next();
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": "attachment",
              "X-Content-Type-Options": "nosniff",
            });
            res.end("fixture document");
          });
        },
      },
    ],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    const uploadRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/relay/upload")
        uploadRequests.push(request);
    });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/relay-composer.html?attachments&uploadRequests`,
    );
    const form = page.getByRole("form", {
      name: "Send a message to General",
      exact: true,
    });
    await expect(
      form.getByRole("button", { name: "Attach files", exact: true }),
    ).toBeEnabled();
    // Rejected selections must announce via the host toast, not stretch the form.
    await form.getByRole("textbox").evaluate((input) => {
      const file = new File(["oversized"], "large.pdf", {
        type: "application/pdf",
      });
      Object.defineProperty(file, "size", { value: 501 * 1024 * 1024 });
      const data = new DataTransfer();
      data.items.add(file);
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    });
    const notices = page.getByRole("region", { name: "App notifications" });
    await expect(
      notices.getByText("Could not attach file", { exact: true }),
    ).toBeVisible();
    await expect(form.getByRole("alert")).toHaveCount(0);
    await notices.getByRole("button", { name: "Dismiss notification" }).click();
    await form.getByLabel("Choose attachments").setInputFiles({
      name: "picked.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("picked"),
    });
    await expect(form.getByText(/Ready$/)).toHaveCount(1);
    expect(uploadRequests).toHaveLength(1);
    await expect(form.locator("video")).toHaveCount(0);
    const remove = form.getByRole("button", {
      name: "Remove picked.txt",
      exact: true,
    });
    await expect(remove).toHaveCSS("width", "20px");
    await expect(remove).toHaveCSS("height", "20px");
    await expect(remove.locator("svg").last()).toHaveCSS("width", "12px");
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(
        new File(["dropped"], "dropped.txt", { type: "text/plain" }),
      );
      return data;
    });
    try {
      const zone = page.locator("[data-attachment-drop-zone]").first();
      await zone.dispatchEvent("dragenter", { dataTransfer: transfer });
      await expect(form).toHaveAttribute("data-file-drag", "true");
      const hint = page
        .getByRole("status")
        .filter({ hasText: "Drop files into this conversation" });
      await expect(hint).toBeVisible();
      const hintBox = await hint.boundingBox();
      const formBox = await form.boundingBox();
      expect(hintBox.height).toBeGreaterThan(formBox.height);
      expect(hintBox.y).toBeLessThan(formBox.y);
      await zone.dispatchEvent("drop", { dataTransfer: transfer });
      await expect(form.getByText(/Ready$/)).toHaveCount(2);
      await expect(form).not.toHaveAttribute("data-file-drag", "true");
    } finally {
      await transfer.dispose();
    }
    await form.getByRole("textbox").evaluate((input) => {
      const data = new DataTransfer();
      data.items.add(
        new File(["pasted"], "pasted.txt", { type: "text/plain" }),
      );
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    });
    await expect(form.getByText(/Ready$/)).toHaveCount(3);
    expect(uploadRequests).toHaveLength(3);
    // Real modal focus returns to the navigated generic preview, not its opener.
    await form.getByRole("button", { name: "Preview picked.txt" }).click();
    const preview = page.getByRole("dialog", { name: "Attachment preview" });
    await preview.getByRole("button", { name: "Next attachment" }).click();
    await expect(
      preview.getByText("dropped.txt", { exact: true }).first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(
      form.getByRole("button", { name: "Preview dropped.txt" }),
    ).toBeFocused();
    // Completed eager uploads leave the remove control available.
    await expect(form.locator("[data-uploading]")).toHaveCount(0);
    await expect(remove.locator("svg")).toHaveCount(1);
    // Real layout proves attachment cards stay in one horizontal lane.
    // Offsets ignore the entrance transform still running on the newest card.
    const cards = form
      .getByRole("region", { name: "Attachments", exact: true })
      .getByRole("listitem");
    const boxes = await cards.evaluateAll((items) =>
      items.map((item) => ({ top: item.offsetTop, left: item.offsetLeft })),
    );
    expect(boxes.every((box) => box.top === boxes[0].top)).toBe(true);
    expect(boxes[1].left).toBeGreaterThan(boxes[0].left);
    await form.screenshot({
      path: test.info().outputPath("compact-attachments.png"),
    });

    await form.getByRole("button", { name: "Remove dropped.txt" }).click();
    await expect(form.getByText(/Ready$/)).toHaveCount(2);
    expect(uploadRequests).toHaveLength(3);
    await form.getByRole("textbox").press("Enter");
    await expect.poll(() => uploadRequests.length).toBe(3);
    await expect(
      form.getByRole("button", { name: "Remove picked.txt" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: /picked.txt/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /pasted.txt/ })).toBeVisible();
    const downloadEvent = page.waitForEvent("download");
    await page
      .getByRole("link", { name: "Download picked.txt", exact: true })
      .click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("picked.txt");
    expect(await readFile(await download.path(), "utf8")).toBe(
      "fixture document",
    );
  } finally {
    await server.close();
  }
});

// Browser-only boundary: a held upload outlives its composer across real navigation.
test("a sent attachment keeps uploading after navigation and publishes to its original channel", async ({
  page,
}) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [
      react(),
      {
        name: "held-upload-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/api/relay/upload" || req.method !== "POST")
              return next();
            req.resume();
            void held.then(() => {
              res.writeHead(204, { "X-Content-Type-Options": "nosniff" });
              res.end();
            });
          });
        },
      },
    ],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    const uploadRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/relay/upload")
        uploadRequests.push(request);
    });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/relay-composer.html?attachments&uploadRequests&random`,
    );
    const general = page.getByRole("form", {
      name: "Send a message to General",
      exact: true,
    });
    await expect(
      general.getByRole("button", { name: "Attach files", exact: true }),
    ).toBeEnabled();
    await general.getByLabel("Choose attachments").setInputFiles({
      name: "held.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("held"),
    });
    await general.getByRole("textbox").fill("background caption");
    await general.getByRole("textbox").press("Enter");
    await expect.poll(() => uploadRequests.length).toBe(1);
    await expect(
      page.getByRole("status").filter({ hasText: /^Uploading to #General$/ }),
    ).toBeVisible();
    // The broker reports no bytes: an indeterminate bar, never a number.
    await expect(
      page.getByRole("progressbar", {
        name: "Uploading to #General",
        exact: true,
      }),
    ).not.toHaveAttribute("aria-valuenow");
    // Browser-only geometry: Cancel ends the row whatever the text's length,
    // so it stays put as the text changes.
    const cancel = general.getByRole("button", {
      name: "Cancel upload to #General",
      exact: true,
    });
    const [row, button] = await Promise.all([
      cancel.locator("xpath=..").boundingBox(),
      cancel.boundingBox(),
    ]);
    expect(row.x + row.width - (button.x + button.width)).toBeCloseTo(0, 0);
    await expect(general.getByRole("textbox")).toHaveText("");
    await expect(general.getByText("held.txt")).toHaveCount(0);

    await page.getByRole("button", { name: "Random", exact: true }).click();
    const random = page.getByRole("form", {
      name: "Send a message to Random",
      exact: true,
    });
    await expect(general).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: /^Uploading to #General$/ }),
    ).toBeVisible();
    await random.getByRole("textbox").fill("still composing");
    expect(
      await page.evaluate(() => window.composerFixture.published()),
    ).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("background-upload-navigated.png"),
    });

    release();
    await expect(
      page.getByRole("status").filter({ hasText: "Uploading" }),
    ).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.composerFixture.published()))
      .toEqual([
        {
          content: expect.stringContaining("background caption"),
          channel: "general",
        },
      ]);
    await expect(random.getByRole("textbox")).toHaveText("still composing");
    await expect(page.getByText("background caption")).toHaveCount(0);

    await page.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.getByText("background caption")).toBeVisible();
    await expect(page.getByRole("link", { name: /held.txt/ })).toBeVisible();
    expect(uploadRequests).toHaveLength(1);
  } finally {
    release();
    await server.close();
  }
});

// Browser-only boundary: removing the focused Cancel button must hand focus to
// the mounted editor in both engines; DOM emulators cannot model native focus loss.
test.describe("background Cancel focus handoff", () => {
  for (const outcome of ["cancel", "failure", "success", "typing elsewhere"]) {
    test(`focus after ${outcome}`, async ({ page }) => {
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const server = await createServer({
        configFile: false,
        envFile: false,
        plugins: [
          react(),
          {
            name: "held-focus-upload",
            configureServer(server) {
              server.middlewares.use((req, res, next) => {
                if (req.url !== "/api/relay/upload" || req.method !== "POST")
                  return next();
                req.resume();
                void held.then(() => {
                  res.writeHead(outcome === "failure" ? 503 : 204, {
                    "X-Content-Type-Options": "nosniff",
                  });
                  res.end();
                });
              });
            },
          },
        ],
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      try {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/relay-composer.html?attachments&uploadRequests`,
        );
        const form = page.getByRole("form", {
          name: "Send a message to General",
          exact: true,
        });
        await form.getByLabel("Choose attachments").setInputFiles({
          name: "focus.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("focus"),
        });
        await form.getByRole("textbox").fill("focused send");
        await form.getByRole("textbox").press("Enter");
        const cancel = form.getByRole("button", {
          name: "Cancel upload to #General",
          exact: true,
        });
        await expect(cancel).toBeVisible();
        await cancel.focus();
        await expect(cancel).toBeFocused();
        if (outcome === "typing elsewhere") {
          await page.evaluate(() => {
            const input = document.createElement("input");
            input.setAttribute("aria-label", "Other work");
            document.body.append(input);
          });
          const elsewhere = page.getByRole("textbox", { name: "Other work" });
          await elsewhere.fill("later typing");
          await expect(elsewhere).toBeFocused();
        }
        if (outcome === "cancel") await cancel.click();
        else release();
        await expect(cancel).toHaveCount(0);
        if (outcome === "typing elsewhere") {
          await expect(
            page.getByRole("textbox", { name: "Other work" }),
          ).toBeFocused();
          await expect(
            page.getByRole("textbox", { name: "Other work" }),
          ).toHaveValue("later typing");
        } else await expect(form.getByRole("textbox")).toBeFocused();
      } finally {
        release();
        await server.close();
      }
    });
  }
});

// Browser-only boundary: toolbar geometry and keyboard order with real contributed tools.
test("paperclip follows mentions and recipients, before the remaining tools", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?attachments`,
    );
    const mention = page.getByRole("button", {
      name: "Mention a member",
      exact: true,
    });
    const attach = page.getByRole("button", {
      name: "Attach files",
      exact: true,
    });
    const emoji = page.getByRole("button", {
      name: "Emoji and GIFS",
      exact: true,
    });
    await expect(mention).toBeVisible();
    await expect(attach).toBeEnabled();
    await expect(emoji).toBeVisible();
    await mention.click();
    const pubkey = await page.evaluate(() => window.mentionFixture.first);
    await page
      .getByRole("dialog", { name: "Mention a member or agent" })
      .getByRole("button")
      .and(page.locator(`[data-mention-choice="${pubkey}"]`))
      .click();
    const recipient = page
      .getByRole("region", { name: "Explicit mentions" })
      .getByRole("button");
    await expect(recipient).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Mention a member or agent" }),
    ).toHaveCount(0);
    await mention.focus();
    for (const next of [recipient, attach, emoji]) {
      await page.keyboard.press("Tab");
      await expect(next).toBeFocused();
    }
    const recipientBox = await recipient.boundingBox();
    const attachBox = await attach.boundingBox();
    const emojiBox = await emoji.boundingBox();
    expect(attachBox.x).toBeGreaterThanOrEqual(
      recipientBox.x + recipientBox.width,
    );
    expect(emojiBox.x).toBeGreaterThanOrEqual(attachBox.x + attachBox.width);
    expect(
      Math.abs(
        attachBox.y +
          attachBox.height / 2 -
          (recipientBox.y + recipientBox.height / 2),
      ),
    ).toBeLessThanOrEqual(2);
    await page.screenshot({
      path: test.info().outputPath("attachment-toolbar.png"),
    });
    await page.evaluate(() =>
      window.mentionFixture.change("disable", "buzz.mentions"),
    );
    await expect(mention).toHaveCount(0);
    await expect(attach).toBeEnabled();
    await recipient.focus();
    await page.keyboard.press("Tab");
    await expect(attach).toBeFocused();
  } finally {
    await server.close();
  }
});

// Browser-only boundary: real decoders/canvas, module worker/Wasm and browser output MIME.
test("preparation preserves snapshot/animation and uses lossless WebP for pixel cleanup", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await openPreparationDocument(page, server);
    for (const [name, type] of [
      ["still.png", "image/png"],
      ["animated.png", "image/png"],
      ["animated.gif", "image/gif"],
      ["animated.webp", "image/webp"],
      ["profile.webp", "image/webp"],
    ]) {
      const bytes = await readFile(
        new URL(`../fixtures/attachment-media/${name}`, import.meta.url),
      );
      const result = await page.evaluate(
        async ({ name, type, bytes }) => {
          const { prepareAttachment } = await import(
            "/src/features/messages/prepare-attachment.ts"
          );
          const { pngChunks } = await import(
            "/src/features/messages/image-metadata.ts"
          );
          let source = new Uint8Array(bytes);
          let manifest;
          if (name === "still.png") {
            const payload = new TextEncoder().encode(
              "buzz_agent_snapshot\0EXACT_MANIFEST",
            );
            manifest = new Uint8Array(payload.length + 12);
            new DataView(manifest.buffer).setUint32(0, payload.length);
            manifest.set(new TextEncoder().encode("tEXt"), 4);
            manifest.set(payload, 8);
            let crc = 0xffffffff;
            for (const value of manifest.subarray(4, -4)) {
              crc ^= value;
              for (let k = 0; k < 8; k++)
                crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
            }
            new DataView(manifest.buffer).setUint32(
              manifest.length - 4,
              (crc ^ 0xffffffff) >>> 0,
            );
            const copy = new Uint8Array(source.length + manifest.length);
            copy.set(source.subarray(0, 33));
            copy.set(manifest, 33);
            copy.set(source.subarray(33), 33 + manifest.length);
            source = copy;
          }
          const output = await prepareAttachment(
            new File([source], name, { type }),
            new AbortController().signal,
          );
          const bitmap = await createImageBitmap(output);
          const dimensions = [bitmap.width, bitmap.height];
          bitmap.close();
          const prepared = new Uint8Array(await output.arrayBuffer());
          const snapshot = manifest ? pngChunks(prepared)[1].raw : undefined;
          return {
            type: output.type,
            size: output.size,
            dimensions,
            text: new TextDecoder("latin1").decode(prepared),
            snapshot: snapshot && Array.from(snapshot),
            manifest: manifest && Array.from(manifest),
          };
        },
        { name, type, bytes: Array.from(bytes) },
      );
      expect(result.type).toBe(type);
      expect(result.dimensions.every((value) => value > 0)).toBe(true);
      if (name === "still.png")
        expect(result.snapshot).toEqual(result.manifest);
      if (name === "animated.png") {
        expect(result.text).toContain("acTL");
        expect(result.text).toContain("fdAT");
      }
      if (name === "animated.gif") expect(result.text).toContain("NETSCAPE2.0");
      if (name === "animated.webp") {
        expect(result.text).toContain("ANIM");
        expect(result.text).toContain("ANMF");
      }
      if (name === "profile.webp") {
        expect(result.text).toContain("VP8L");
        expect(result.text).not.toContain("ICCP");
      }
    }
  } finally {
    await server.close();
  }
});

// Real media decoding, modal focus and exit/layout geometry require a browser.
test("local previews stay interactive during eager upload and removal collapses the composer", async ({
  page,
}) => {
  let release;
  let requests = 0;
  let releaseRetry;
  const heldRetry = new Promise((resolve) => {
    releaseRetry = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [
      react(),
      {
        name: "held-preview-upload",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/api/relay/upload" || req.method !== "POST")
              return next();
            req.resume();
            const status = [1, 3, 5].includes(++requests) ? 503 : 204;
            void (requests === 3 ? heldRetry : held).then(() => {
              res.writeHead(status);
              res.end();
            });
          });
        },
      },
    ],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/relay-composer.html?attachments&uploadRequests`,
    );
    const form = page.getByRole("form", {
      name: "Send a message to General",
      exact: true,
    });
    const editor = form.getByRole("textbox");
    await editor.fill("Preserve this draft");
    const height = await form.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    await form.getByLabel("Choose attachments").setInputFiles([
      {
        name: "photo.png",
        mimeType: "image/png",
        buffer: await readFile(
          new URL("../fixtures/attachment-media/still.png", import.meta.url),
        ),
      },
      {
        name: "clip.mp4",
        mimeType: "video/mp4",
        buffer: await readFile(
          new URL(
            "../fixtures/message-gallery/assets/sample.mp4",
            import.meta.url,
          ),
        ),
      },
    ]);
    await expect(form.getByRole("progressbar")).toHaveCount(2);
    for (const indicator of await form.getByRole("progressbar").all()) {
      await expect(indicator.locator("svg")).toHaveCSS(
        "animation-duration",
        "0.7s",
      );
      await expect(indicator.locator("[data-upload-progress]")).toHaveAttribute(
        "stroke-dasharray",
        "25 100",
      );
      await expect(indicator).not.toHaveAttribute("aria-valuenow");
    }
    const queuedRing = form.getByRole("progressbar", {
      name: "Queued clip.mp4",
    });
    await expect(queuedRing).toHaveAttribute("aria-valuetext", "Queued");
    await form.getByRole("button", { name: "Preview clip.mp4" }).hover();
    await expect(
      form
        .getByRole("button", { name: "Remove clip.mp4" })
        .locator("[data-upload-cancel]"),
    ).toBeVisible();
    await expect(queuedRing).toHaveCSS("opacity", "0");
    await editor.hover();
    await expect(queuedRing).toHaveCSS("opacity", "1");
    const pendingRing = form.getByRole("progressbar").first();
    await expect(pendingRing.locator("circle").first()).toHaveCSS(
      "opacity",
      "0.5",
    );
    await expect
      .poll(() =>
        pendingRing.locator("svg").evaluate((el) => {
          const bounds = getComputedStyle(el);
          const track = el.querySelector("circle");
          const style = getComputedStyle(track);
          return {
            width: parseFloat(bounds.width),
            height: parseFloat(bounds.height),
            stroke: style.stroke,
            visibility: style.visibility,
          };
        }),
      )
      .toEqual({
        width: 16,
        height: 16,
        stroke: "rgb(255, 255, 255)",
        visibility: "visible",
      });

    // Hover can scroll the entrance's overflow-clipping section as well as the
    // strip. Measure resting alignment with both horizontal offsets cleared.
    await form
      .getByRole("region", { name: "Attachments" })
      .evaluate((section) => {
        section.scrollLeft = 0;
        section.querySelector("ul").scrollLeft = 0;
      });
    await expect
      .poll(() =>
        form.evaluate((el) => {
          const tile = el
            .querySelector('[aria-label="Preview photo.png"]')
            .getBoundingClientRect();
          const toolbar = el
            .querySelector('[aria-label="Attach files"]')
            .getBoundingClientRect();
          const style = getComputedStyle(el);
          const expectedTop =
            el.getBoundingClientRect().top +
            parseFloat(style.borderTopWidth) +
            parseFloat(style.paddingBottom);
          return Math.max(
            Math.abs(tile.left - toolbar.left),
            Math.abs(tile.top - expectedTop),
          );
        }),
      )
      .toBeLessThan(0.5);

    await expect(pendingRing.locator("circle").first()).not.toHaveAttribute(
      "stroke-dasharray",
    );
    const uploadingPreview = form.getByRole("button", {
      name: "Preview photo.png",
    });
    const uploadingCancel = form
      .getByRole("button", { name: "Remove photo.png" })
      .locator("[data-upload-cancel]");
    await uploadingPreview.hover();
    await expect(uploadingCancel).toBeVisible();
    await expect(pendingRing).toHaveCSS("opacity", "0");
    await editor.hover();
    await expect(uploadingCancel).toBeHidden();
    await expect(pendingRing).toHaveCSS("opacity", "1");
    await uploadingPreview.focus();
    await expect(uploadingCancel).toBeVisible();
    await editor.focus();
    await expect(uploadingCancel).toBeHidden();
    for (const percent of [0, 40, 100]) {
      await page.evaluate(
        (percent) =>
          window.composerFixture.reportUploadProgress(
            "photo.png",
            percent,
            100,
          ),
        percent,
      );
      await expect(pendingRing.locator("svg")).toHaveCSS(
        "animation-name",
        "none",
      );
      await expect(queuedRing.locator("svg")).toHaveCSS(
        "animation-duration",
        "0.7s",
      );
      await expect(pendingRing).toHaveAttribute(
        "aria-valuenow",
        String(percent),
      );
      await expect
        .poll(() =>
          pendingRing.locator("[data-upload-progress]").evaluate((el) =>
            getComputedStyle(el)
              .strokeDasharray.match(/[\d.]+/g)
              ?.map(Number),
          ),
        )
        .toEqual([percent, 100]);
      if (percent === 40)
        await page.screenshot({
          path: test.info().outputPath("composer-upload.png"),
        });
      await pendingRing.screenshot({
        path: test.info().outputPath(`upload-ring-${percent}.png`),
      });
    }
    const firstPreview = form.getByRole("button", {
      name: "Preview photo.png",
    });
    await page.keyboard.press("Tab");
    await firstPreview.focus();
    await expect(firstPreview).toBeFocused();
    await expect(firstPreview).toHaveCSS("outline-style", "solid");
    await expect
      .poll(() =>
        firstPreview.evaluate((el) => {
          const tile = el.getBoundingClientRect();
          const row = el.closest("ul").getBoundingClientRect();
          const style = getComputedStyle(el);
          const extent =
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          return Math.min(
            tile.left - extent - row.left,
            tile.top - extent - row.top,
          );
        }),
      )
      .toBeGreaterThanOrEqual(0);
    await form.screenshot({
      path: test.info().outputPath("keyboard-focus-corners.png"),
    });
    const trigger = form.getByRole("button", { name: "Preview clip.mp4" });
    await expect
      .poll(() => trigger.locator("video").evaluate((el) => el.videoWidth))
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        trigger.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const corner = el
            .closest("li")
            .querySelector('[aria-label="Remove clip.mp4"]')
            .getBoundingClientRect();
          return Math.max(
            Math.abs(box.right - corner.right - 4),
            Math.abs(corner.top - box.top - 4),
            Math.abs(box.width - box.height),
          );
        }),
      )
      .toBeLessThan(0.5);
    await expect(trigger.locator("video")).toHaveCSS("object-fit", "cover");
    await page.evaluate(() => {
      window.reviewTransitions = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        if (this.matches("[data-review-media]"))
          window.reviewTransitions.push({
            frames,
            closing: this.closest("[data-review-closing]")?.getAttribute(
              "data-review-closing",
            ),
          });
        return animate.call(this, frames, options);
      };
    });
    const beforeFailure = await form.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Attachment preview" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.reviewTransitions.some(({ frames }) =>
            frames.some(
              (frame) =>
                frame.clipPath?.startsWith("inset(") &&
                frame.clipPath.includes(" round "),
            ),
          ),
        ),
      )
      .toBe(true);
    await expect(dialog).not.toHaveAttribute("data-review-pending", "");
    await expect
      .poll(() =>
        dialog.evaluate(
          (el) =>
            el
              .getAnimations({ subtree: true })
              .filter((animation) => animation.playState === "running").length,
        ),
      )
      .toBe(0);
    await dialog.screenshot({
      path: test.info().outputPath("attachment-viewer.png"),
    });
    const video = dialog.locator("video");
    await expect
      .poll(() => video.evaluate((el) => el.readyState))
      .toBeGreaterThanOrEqual(2);
    // Own the playback boundary; the short fixture's autoplay may still be
    // running or may already have ended when WebKit reaches this assertion.
    await video.evaluate((el) => {
      window.openDraftVideo = el;
      el.loop = true;
      el.pause();
    });
    await dialog
      .getByRole("button", { name: "Play video", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Pause video", exact: true }),
    ).toBeVisible();
    await expect.poll(() => video.evaluate((el) => el.paused)).toBe(false);
    const openedSource = await video.getAttribute("src");
    // Finish the held eager queue while the local video is actually playing.
    release();
    // The modal intentionally hides its background form from accessibility.
    const backgroundForm = page.getByRole("form", {
      name: "Send a message to General",
      exact: true,
      includeHidden: true,
    });
    await expect(backgroundForm.getByText(/Ready$/)).toHaveCount(1);
    expect(await video.evaluate((el) => el === window.openDraftVideo)).toBe(
      true,
    );
    await expect(video).toHaveAttribute("src", openedSource);
    expect(await video.evaluate((el) => el.paused)).toBe(false);
    await expect(
      dialog.getByRole("button", { name: /Playback speed/ }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: /comments/i })).toHaveCount(
      0,
    );
    await dialog.getByRole("button", { name: "Previous attachment" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() =>
        dialog
          .locator("img[data-review-media]")
          .evaluate((el) => el.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.keyboard.press("ArrowRight");
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((el) => el.readyState))
      .toBeGreaterThanOrEqual(2);
    const seek = dialog.getByRole("slider", {
      name: "Video timeline",
      exact: true,
    });
    await seek.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(video).toBeVisible();
    await dialog.getByRole("button", { name: "Previous attachment" }).click();
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.classList.toggle("dark", mode === "dark");
      }, mode);
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(
          dialog.getByRole("button", { name: "Next attachment" }),
        ).toBeInViewport();
        await expect(
          dialog.getByRole("button", { name: "Close fullscreen viewer" }),
        ).toBeInViewport();
      }
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await expect(
      dialog.getByRole("button", { name: "Close fullscreen viewer" }),
    ).toBeInViewport();
    await dialog
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.reviewTransitions.some(({ closing }) => closing === "shared"),
        ),
      )
      .toBe(true);
    await expect(
      form.getByRole("button", { name: "Preview photo.png" }),
    ).toBeFocused();
    await expect(editor).toHaveText("Preserve this draft");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    const retry = form.getByRole("button", { name: "Retry photo.png" });
    await editor.focus();
    await editor.hover();
    const failure = form.getByRole("alert");
    await expect(failure).toHaveText(
      "photo.png: Upload failed. Retry or remove this file.",
    );
    await expect(failure).toBeVisible();
    await expect(failure).toHaveCSS("clip-path", "none");
    // A 1px, clipped ancestor can still satisfy Playwright's toBeVisible.
    await expect(failure.locator("..")).toHaveCSS("clip-path", "none");
    await expect(retry).toHaveText("Retry");
    await expect(retry).toHaveCSS("opacity", "1");
    await expect(
      form.getByRole("button", { name: "Send message" }),
    ).toBeDisabled();
    await expect
      .poll(() => form.evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThan(beforeFailure);
    const failedRemove = form.getByRole("button", { name: "Remove photo.png" });
    await expect(failedRemove).toHaveText("Remove");
    await expect(failedRemove).toHaveCSS("opacity", "1");
    // Both error actions must fit inside the real strip scrollport.
    for (const action of [retry, failedRemove]) {
      expect(
        await action.evaluate((el) => {
          const control = el.getBoundingClientRect();
          const strip = el.closest("ul").getBoundingClientRect();
          return Math.min(
            control.left - strip.left,
            strip.right - control.right,
            control.top - strip.top,
          );
        }),
      ).toBeGreaterThanOrEqual(0);
    }
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (mode) =>
          document.documentElement.classList.toggle("dark", mode === "dark"),
        mode,
      );
      for (const width of [390, 640, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        await editor.focus();
        await editor.hover();
        await expect(retry).toHaveCSS("opacity", "1");
        await expect(failedRemove).toHaveCSS("opacity", "1");
        await expect(failure).toBeInViewport();
        if (width === 640) {
          // A narrow pane must not inherit an 18rem floor at enlarged text sizes.
          expect(
            await failure.evaluate((el) => {
              const item = el.closest("li").getBoundingClientRect();
              const strip = el.closest("ul").getBoundingClientRect();
              return strip.width - item.width;
            }),
          ).toBeGreaterThanOrEqual(0);
        }
        for (const content of [failure, retry, failedRemove]) {
          expect(
            await content.evaluate((el) => {
              const box = el.getBoundingClientRect();
              const item = el.closest("li").getBoundingClientRect();
              return Math.min(
                box.left - item.left,
                item.right - box.right,
                box.top - item.top,
                item.bottom - box.bottom,
              );
            }),
          ).toBeGreaterThanOrEqual(0);
        }
        await retry.click({ trial: true });
        await failedRemove.click({ trial: true });
        await form.screenshot({
          path: test.info().outputPath(`upload-failure-${mode}-${width}.png`),
        });
        // Error actions must stay clear of the following image, at any UI size.
        expect(
          await failedRemove.evaluate((el) => {
            const item = el.closest("li");
            const next = item.nextElementSibling;
            return (
              next.getBoundingClientRect().left -
              el.getBoundingClientRect().right
            );
          }),
        ).toBeGreaterThanOrEqual(0);
      }
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await form.screenshot({
      path: test.info().outputPath("compact-upload-retry.png"),
    });
    // A second rejection must restore the explanation and leave the draft intact.
    const rejectedRetry = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/relay/upload") &&
        response.status() === 503,
    );
    const retryStarted = page.waitForRequest((request) =>
      request.url().endsWith("/api/relay/upload"),
    );
    await retry.focus();
    await page.keyboard.press("Enter");
    await retryStarted;
    await expect(
      form.getByRole("button", { name: "Preview photo.png" }),
    ).toBeFocused();
    await expect(form.getByRole("progressbar")).toBeVisible();
    releaseRetry();
    await rejectedRetry;
    await expect(retry).toBeVisible();
    await expect(
      form.getByRole("button", { name: "Preview photo.png" }),
    ).toBeFocused();
    await expect(failure).toBeVisible();
    await expect(
      form.getByRole("button", { name: "Send message" }),
    ).toBeDisabled();
    await expect(editor).toHaveText("Preserve this draft");
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(form.getByRole("progressbar")).toHaveCount(0);
    await expect(failure).toHaveCount(0);
    await expect(
      form.getByRole("button", { name: "Send message" }),
    ).toBeEnabled();
    await expect(editor).toHaveText("Preserve this draft");
    const failedName = `${"long-attachment-name-".repeat(8)}.txt`;
    await page.setViewportSize({ width: 640, height: 800 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await form.getByLabel("Choose attachments").setInputFiles({
      name: failedName,
      mimeType: "text/plain",
      buffer: Buffer.from("failed"),
    });
    await expect(
      form.getByRole("button", { name: `Retry ${failedName}` }),
    ).toBeVisible();
    expect(
      await failure.evaluate(
        (el) =>
          el.closest("ul").getBoundingClientRect().width -
          el.closest("li").getBoundingClientRect().width,
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(
      await form
        .getByText(failedName, { exact: true })
        .evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    await expect(
      form.getByRole("button", { name: "Send message" }),
    ).toBeDisabled();
    await form.getByRole("button", { name: `Remove ${failedName}` }).focus();
    await page.keyboard.press("Enter");
    await expect(editor).toBeFocused();
    await expect(
      form.getByRole("button", { name: `Retry ${failedName}` }),
    ).toHaveCount(0);
    await expect(
      form.getByRole("button", { name: "Send message" }),
    ).toBeEnabled();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      window.reviewTransitions = [];
    });
    await firstPreview.click();
    await expect(
      dialog.getByRole("img", { name: "Attachment preview", exact: true }),
    ).toBeVisible();
    await expect(dialog).not.toHaveAttribute("data-review-pending");
    expect(await page.evaluate(() => window.reviewTransitions)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const photoRemove = form.getByRole("button", { name: "Remove photo.png" });
    const clipRemove = form.getByRole("button", { name: "Remove clip.mp4" });
    await editor.focus();
    await editor.hover();
    await expect(photoRemove).toHaveCSS("opacity", "0");
    await form.getByRole("button", { name: "Preview photo.png" }).hover();
    await expect(photoRemove).toHaveCSS("opacity", "1");
    await expect(clipRemove).toHaveCSS("opacity", "0");
    await clipRemove.focus();
    await expect(clipRemove).toHaveCSS("opacity", "1");
    const firstSlot = await photoRemove.evaluate(
      (el) => el.getBoundingClientRect().left,
    );
    await photoRemove.click();
    await expect(photoRemove).toHaveCount(0);
    // The removed tile leaves the accessibility tree when its exit starts but
    // keeps its slot until the exit finishes; only then does the clip slide
    // left. Press the clip only once it has settled into the first slot.
    await expect
      .poll(() => clipRemove.evaluate((el) => el.getBoundingClientRect().left))
      .toBe(firstSlot);
    await clipRemove.click();
    await expect(clipRemove).toHaveCount(0);
    await expect(form.getByRole("region", { name: "Attachments" })).toHaveCount(
      0,
    );
    await expect
      .poll(() => form.evaluate((el) => el.getBoundingClientRect().height))
      .toBe(height);
    expect(
      await page.evaluate(() => window.composerFixture.published()),
    ).toEqual([]);
    await expect(editor).toHaveText("Preserve this draft");
  } finally {
    releaseRetry();
    release();
    await server.close();
  }
});

// Canvas encoders add platform-specific metadata; a mock cannot prove cleanup.
test("PNG and JPEG preparation uploads metadata-free browser-encoded bytes", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await openPreparationDocument(page, server);
    const results = await page.evaluate(async () => {
      const { prepareAttachment } = await import(
        "/src/features/messages/prepare-attachment.ts"
      );
      const { hostUpload } = await import("/src/features/relay/attachments.ts");
      const { pngChunks, isPngRenderingChunk } = await import(
        "/src/features/messages/image-metadata.ts"
      );
      const results = [];
      for (const type of ["image/png", "image/jpeg"]) {
        const canvas = document.createElement("canvas");
        canvas.width = 20;
        canvas.height = 10;
        const context = canvas.getContext("2d");
        context.fillStyle = "#de4620";
        context.fillRect(0, 0, 10, 10);
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, type),
        );
        const original = new Uint8Array(await blob.arrayBuffer());
        const file = new File(
          [blob],
          `photo.${type === "image/png" ? "png" : "jpg"}`,
          { type },
        );
        const signal = new AbortController().signal;
        const prepared = await prepareAttachment(file, signal);
        const uploaded = await hostUpload(async (sent) => {
          const bytes = new Uint8Array(await sent.arrayBuffer());
          if (type === "image/png") {
            if (pngChunks(bytes).some(({ kind }) => !isPngRenderingChunk(kind)))
              return new Response("metadata forbidden", { status: 422 });
          } else {
            // Independent relay-style check of JPEG headers before the first scan.
            let offset = 2;
            while (offset < bytes.length) {
              if (bytes[offset++] !== 255) throw new Error("Invalid JPEG");
              const marker = bytes[offset++];
              if (marker === 0xda || marker === 0xd9) break;
              if (
                (marker >= 0xe1 && marker <= 0xed) ||
                marker === 0xef ||
                marker === 0xfe
              )
                return new Response("metadata forbidden", { status: 422 });
              offset += (bytes[offset] << 8) | bytes[offset + 1];
            }
          }
          const hash = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          return Response.json({
            url: `/media/${hash}`,
            sha256: hash,
            size: sent.size,
            type: sent.type,
          });
        }, "https://relay.test")(prepared, signal);
        const bitmap = await createImageBitmap(prepared);
        context.clearRect(0, 0, 20, 10);
        context.drawImage(bitmap, 0, 0);
        const sourceAfter = new Uint8Array(await file.arrayBuffer());
        results.push({
          type: uploaded.type,
          size: uploaded.size,
          preparedSize: prepared.size,
          dimensions: [bitmap.width, bitmap.height],
          alpha: context.getImageData(15, 5, 1, 1).data[3],
          originalUnchanged: original.every(
            (value, i) => value === sourceAfter[i],
          ),
        });
        bitmap.close();
      }
      return results;
    });
    expect(results.map((result) => result.type)).toEqual([
      "image/png",
      "image/jpeg",
    ]);
    for (const result of results) {
      expect(result.dimensions).toEqual([20, 10]);
      expect(result.size).toBe(result.preparedSize);
      expect(result.originalUnchanged).toBe(true);
    }
    expect(results[0].alpha).toBe(0);
  } finally {
    await server.close();
  }
});
