import { test, expect } from "./playwright-test.mjs";
import react from "@vitejs/plugin-react";
import { createServer } from "./vite-server.mjs";

// Browser boundary: native caret/focus and undo in the real decorated composer,
// plus channel/session wiring and responsive edit-header geometry. State and
// eligibility matrices live in colocated unit/component tests.
test("Cmd+Up edits in the existing composer and restores native focus, draft history and attachments", async ({
  page,
}, testInfo) => {
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
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/relay-composer.html?attachments`,
    );
    const input = page.getByRole("textbox", {
      name: "Message #General",
      exact: true,
    });
    await expect(input).toBeVisible();
    await page.getByLabel("Choose attachments").setInputFiles({
      name: "report.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Report"),
    });
    await expect(page.getByText(/Ready$/)).toBeVisible();
    await input.fill("Original caption");
    await input.press("Enter");
    await expect(
      page.getByRole("link", { name: "Download report.txt", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.composerFixture.pending()))
      .toEqual([]);
    await input.fill("Unsent draft");
    await input.fill("");
    const originalNode = await input.elementHandle();
    // Plain Up selects the newest message, as in Slack (E then edits it; see
    // src/app/message-shortcuts.test.ts). Cmd+Up still edits directly.
    await input.press("Meta+ArrowUp");
    const editor = page.getByRole("textbox", {
      name: "Edit message",
      exact: true,
    });
    await expect(editor).toBeFocused();
    expect(
      await editor.evaluate((el, original) => el === original, originalNode),
    ).toBe(true);
    const source = await editor.evaluate((el) => el.value);
    expect(source).toContain("Original caption");
    expect(source).toContain(
      "[report.txt](<https://attachments.invalid/media/",
    );
    expect(
      await editor.evaluate((el) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([source.length, source.length]);
    await editor.fill("Cancelled changes");
    await editor.press("Escape");
    await expect(input).toBeFocused();
    await expect(input).toHaveJSProperty("value", "");
    await input.press("ControlOrMeta+z");
    await expect(input).toHaveJSProperty("value", "Unsent draft");
    await input.fill("");
    await input.press("Meta+ArrowUp");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveJSProperty("value", source);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.colorMode = theme),
        theme,
      );
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        const form = page.getByRole("form", {
          name: "Edit message",
          exact: true,
        });
        const close = form.getByRole("button", {
          name: "Cancel edit",
          exact: true,
        });
        await expect(close).toBeInViewport();
        await expect(
          form.getByRole("button", { name: "Save changes" }),
        ).toBeInViewport();
        await expect(editor).toBeInViewport();
        const box = await form.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: testInfo.outputPath(`edit-${theme}-${width}.png`),
        });
      }
    }
    await editor.fill(
      source.replace("Original caption", "Revised caption reject"),
    );
    await editor.press("Enter");
    // The editor closes on submit; the rejection is reported outside it.
    await expect(input).toBeFocused();
    await expect(input).toHaveJSProperty("value", "");
    const retry = page.getByRole("button", {
      name: "Retry message update",
      exact: true,
    });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toBeHidden();
    // The applied edit replaces the caption and marks it as edited.
    const revised = page.getByText("Revised caption reject (edited)", {
      exact: true,
    });
    await expect(revised).toBeVisible();
    // The marker is metadata, so a selection of the caption leaves it out.
    expect(
      await revised.evaluate((caption) => {
        const selection = getSelection();
        selection?.selectAllChildren(caption);
        const text = selection?.toString() ?? "";
        selection?.removeAllRanges();
        return text.trim();
      }),
    ).toBe("Revised caption reject");
    await expect(
      page.getByRole("link", { name: "Download report.txt", exact: true }),
    ).toBeVisible();
    // Cmd+Up skips a message whose retried edit is still sending.
    await expect(async () => {
      await input.press("Meta+ArrowUp");
      await expect(editor).toBeVisible({ timeout: 500 });
    }).toPass();
    await expect(editor).toHaveJSProperty(
      "value",
      source.replace("Original caption", "Revised caption reject"),
    );
    await page
      .getByRole("button", { name: "Cancel edit", exact: true })
      .click();
    await expect(input).toBeFocused();
  } finally {
    await server.close();
  }
});
