import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("editable composer renders links and mentions while preserving source and notification intent", async ({
  page,
  browserName,
}) => {
  // Keep the empty-after-send contract under test; agent-prefill behavior has
  // separate coverage in mention-edit.spec.mjs.
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/link-messages.html`,
    );
    const input = page.getByRole("textbox", {
      name: "Message #design",
      exact: true,
    });
    const preview = input;
    await expect(
      page.getByRole("region", { name: "Draft preview" }),
    ).toHaveCount(0);
    await expect(preview.locator('[data-link-kind="github"]')).toHaveCount(7);
    await expect(
      preview.locator('.inline-chip[data-kind="person"]'),
    ).toHaveText("@Alex Chen");
    await expect(preview.locator('.inline-chip[data-kind="agent"]')).toHaveText(
      "@Build Bot",
    );
    const delivered = page.locator('[data-message-id="link-row"]');
    const deliveredLink = delivered
      .locator('a:has([data-link-kind="github"])')
      .first();
    const deliveredMentions = delivered.locator("[data-mention-kind]");
    // Match the app's bundled typeface before comparing native font boxes.
    // document.fonts.ready alone cannot detect a missing @font-face import.
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() =>
        Array.from(document.fonts).some(
          (font) =>
            font.family.includes("Inter Variable") && font.status === "loaded",
        ),
      ),
    ).toBe(true);
    const inlineStyles = await Promise.all(
      [deliveredLink, deliveredMentions.nth(0), deliveredMentions.nth(1)].map(
        (locator) =>
          locator.evaluate((element) => {
            const style = getComputedStyle(element);
            const role = (value, property) => {
              const probe = document.createElement("span");
              probe.style[property] = value;
              element.parentElement?.append(probe);
              const resolved = getComputedStyle(probe)[property];
              probe.remove();
              return resolved;
            };
            return {
              color: style.color,
              background: style.backgroundColor,
              ink: role("var(--text-mention)", "color"),
              tint: role("var(--affordance-mention)", "backgroundColor"),
              paddingBlock: [style.paddingTop, style.paddingBottom],
              height: element.getBoundingClientRect().height,
            };
          }),
      ),
    );
    // Mentions are people, not destinations: ink on a neutral chip, with the
    // same inline geometry as the link beside them.
    for (const mentionStyle of inlineStyles.slice(1)) {
      expect(mentionStyle.color).toBe(mentionStyle.ink);
      expect(mentionStyle.background).toBe(mentionStyle.tint);
      expect(mentionStyle.color).not.toBe(inlineStyles[0].color);
      expect(mentionStyle.paddingBlock).toEqual(inlineStyles[0].paddingBlock);
      expect(
        Math.abs(mentionStyle.height - inlineStyles[0].height),
      ).toBeLessThan(1);
    }
    // The resting chip fill must not mask the shared hover fill.
    const hovered = deliveredMentions.nth(0);
    const hoverFill = await hovered.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--affordance-mention-hover)";
      element.parentElement?.append(probe);
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return resolved;
    });
    expect(hoverFill).not.toBe(inlineStyles[1].background);
    await hovered.hover();
    await expect(hovered).toHaveCSS("background-color", hoverFill);
    await page.mouse.move(0, 0);
    await expect(preview.getByRole("link")).toHaveCount(0);
    await expect(preview.getByRole("button")).toHaveCount(0);

    // Select-all includes the full painted token, not only its text label.
    const initialSource = await input.evaluate((el) => el.value);
    const tokenCount = await input.locator("[data-source]").count();
    await input.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(input.locator("[data-editor-selected]")).toHaveCount(
      tokenCount,
    );
    const selectedSource = await input.evaluate((el) => {
      const clipboardData = new DataTransfer();
      el.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return clipboardData.getData("text/plain");
    });
    expect(selectedSource).toBe(initialSource);
    await page.keyboard.press("ArrowRight");
    await expect(input.locator("[data-editor-selected]")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+a");
    await expect(input.locator("[data-editor-selected]")).toHaveCount(
      tokenCount,
    );
    await page.keyboard.type("Replaced selection");
    await expect(input).toHaveJSProperty("value", "Replaced selection");
    await expect(input.locator("[data-editor-selected]")).toHaveCount(0);

    const mouseSource = "Before https://github.com/block/buzz-app/pulls after";
    await input.fill(mouseSource);
    for (const target of [input, input.locator("[data-source]")]) {
      await page.keyboard.press("ArrowRight");
      await target.click({ clickCount: 3, position: { x: 4, y: 8 } });
      await expect(input.locator("[data-editor-selected]")).toHaveCount(1);
      expect(
        await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
      ).toEqual([0, mouseSource.length]);
      await expect(input).toHaveJSProperty("value", mouseSource);
    }
    await page.keyboard.press("ArrowRight");
    const drag = await input.evaluate((el) => {
      const range = document.createRange();
      // The editor now contains block paragraphs. Selecting the outer editor
      // measures their full width, not the painted text; WebKit will not start
      // a text drag at that outside edge. Use the actual paragraph contents.
      range.selectNodeContents(el.querySelector("p"));
      const end = range.getBoundingClientRect();
      return {
        start: el.getBoundingClientRect().left,
        end: end.right,
        y: end.top + end.height / 2,
      };
    });
    await page.mouse.move(drag.end, drag.y);
    await page.mouse.down();
    await page.mouse.move(drag.start, drag.y, { steps: 12 });
    await page.mouse.up();
    await expect(input.locator("[data-editor-selected]")).toHaveCount(1);
    expect(
      await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([0, mouseSource.length]);

    const text =
      "Review [**GitHub**](https://github.com/block/buzz-app) in #design with ";
    await input.fill(text);
    await input.press("End");
    await page
      .getByRole("button", { name: "Mention Alex Chen", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Mention Build Bot", exact: true })
      .click();
    const expected = `${text}@Alex Chen @Build Bot `;
    await expect(input).toHaveJSProperty("value", expected);
    await expect(input).toBeFocused();
    expect(await input.evaluate((el) => el.selectionStart)).toBe(
      expected.length,
    );
    await expect(preview.locator("strong")).toHaveText("GitHub");
    await expect(preview.locator('.inline-chip[data-kind="agent"]')).toHaveText(
      "@Build Bot",
    );
    await input.press("Enter");
    expect(await page.evaluate(() => window.linkComposerFixture.sent)).toEqual([
      { text: expected, mentions: ["a".repeat(64), "b".repeat(64)] },
    ]);
    await expect(input).toHaveJSProperty("value", "");
    await expect(preview.locator("[data-source]")).toHaveCount(0);

    // Empty editors still need a real text caret after send, refocus and delete.
    for (const state of ["sent", "refocused", "deleted"]) {
      if (state === "refocused") {
        await input.evaluate((el) => el.blur());
        await input.focus();
      } else if (state === "deleted") {
        await input.pressSequentially("x");
        await input.press("Backspace");
      } else await input.focus();
      await expect(input).toHaveJSProperty("value", "");
      const emptyCaret = await input.evaluate((el) => {
        const selection = getSelection().getRangeAt(0);
        // ProseMirror uses an empty paragraph + BR, not a zero-width source
        // character. A collapsed element Range has no rect in Chromium; its
        // BR supplies the same native caret line box.
        const caretRange = selection.cloneRange();
        if (
          !caretRange.getBoundingClientRect().height &&
          selection.startContainer instanceof Element &&
          selection.startContainer.childNodes[selection.startOffset]
            ?.nodeName === "BR"
        )
          caretRange.selectNode(
            selection.startContainer.childNodes[selection.startOffset],
          );
        const caret = caretRange.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return {
          height: caret.height,
          left: caret.left - box.left,
          top: caret.top - box.top,
          bottom: box.bottom - caret.bottom,
          selection: [el.selectionStart, el.selectionEnd],
        };
      });
      expect(emptyCaret.height, state).toBeGreaterThan(10);
      expect(Math.abs(emptyCaret.left), state).toBeLessThan(2);
      expect(emptyCaret.top, state).toBeGreaterThanOrEqual(0);
      expect(emptyCaret.bottom, state).toBeGreaterThanOrEqual(0);
      expect(emptyCaret.selection, state).toEqual([0, 0]);
    }

    const pasted = "@Alex Chen [Drive](https://drive.google.com/file/example)";
    await input.fill(pasted);
    await expect(preview.locator(".inline-chip")).toHaveCount(0);
    await expect(preview.locator('[data-link-kind="drive"]')).toHaveText(
      "Drive",
    );
    await page.reload();
    await expect(input).toHaveJSProperty("value", pasted);
    await expect(preview.locator(".inline-chip")).toHaveCount(0);
    // A rendered item at the end must have a real caret box after its label.
    const linkSource = "See https://github.com/block/buzz-app";
    await input.fill(linkSource);
    const caretBox = await input.evaluate((el) => {
      const range = getSelection().getRangeAt(0).cloneRange();
      if (
        !range.getBoundingClientRect().height &&
        range.startContainer instanceof Element
      ) {
        const child = range.startContainer.childNodes[range.startOffset];
        const boundary = child?.nodeName === "IMG" ? child.nextSibling : child;
        if (boundary?.nodeName === "BR") range.selectNode(boundary);
      }
      const caret = range.getBoundingClientRect();
      const link = el.querySelector("[data-source]").getBoundingClientRect();
      return {
        x: caret.x,
        y: caret.y,
        height: caret.height,
        right: link.right,
        top: link.top,
      };
    });
    expect(caretBox.height).toBeGreaterThan(10);
    expect(Math.abs(caretBox.x - caretBox.right)).toBeLessThan(2);
    expect(Math.abs(caretBox.y - caretBox.top)).toBeLessThan(2);
    await input.press("Backspace");
    await expect(input).toHaveJSProperty("value", linkSource.slice(0, -1));
    await expect(input.locator("[data-source]")).toHaveCount(0);
    await input.pressSequentially("p after");
    await expect(input).toHaveJSProperty("value", `${linkSource} after`);
    await expect(input.locator("[data-source]")).toHaveCount(0);

    const secondLink = "https://drive.google.com/file/example";
    await input.fill("");
    await input.fill(`${linkSource} ${secondLink}`);
    await input.evaluate(
      (el, end) => el.setSelectionRange(end, end),
      linkSource.length,
    );
    await page.keyboard.press("Backspace");
    await expect(input.locator("[data-source]")).toHaveCount(1);
    await expect(input.locator('[data-link-kind="drive"]')).toHaveCount(1);
    await input.evaluate((el) => el.setSelectionRange(0, 0));
    await page.keyboard.type("Note: ");
    await expect(input.locator("[data-source]")).toHaveCount(1);
    await input.evaluate((el) => el.blur());
    await input.focus();
    await expect(input.locator("[data-source]")).toHaveCount(1);

    await input.fill("");
    await input.fill(`${linkSource} after`);
    await input.locator("[data-source]").click();
    await input.pressSequentially("!");
    await expect(input).toHaveJSProperty("value", `${linkSource}! after`);
    await input.fill(linkSource);
    await input.press("ArrowLeft");
    expect(await input.evaluate((el) => el.selectionStart)).toBe(
      linkSource.length - 1,
    );
    await input.press("Delete");
    await expect(input).toHaveJSProperty("value", linkSource.slice(0, -1));
    await input.pressSequentially("p");
    const copied = await input.evaluate((el) => {
      el.setSelectionRange(0, el.value.length);
      const clipboardData = new DataTransfer();
      el.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return {
        text: clipboardData.getData("text/plain"),
        html: clipboardData.getData("text/html"),
      };
    });
    // The edit left the URL plain, so neither flavor links it.
    expect(copied).toEqual({
      text: linkSource,
      html: `<div data-buzz-copy="composer"><p>${linkSource}</p></div>`,
    });

    // Paste, Space and continued typing must not require refocusing the field.
    const pastedUrl = "https://github.com/block/buzz-app/pulls";
    // Delete at a rendered boundary is a text edit, including native commands
    // without keydown. It must not consume only the invisible caret marker.
    for (const nativeCommand of browserName === "webkit"
      ? [false, true]
      : [false]) {
      await input.fill(pastedUrl);
      for (let count = 1; count <= 3; count++) {
        if (nativeCommand)
          await input.evaluate(() => document.execCommand("delete"));
        else await page.keyboard.press("Backspace");
        await expect(input).toHaveJSProperty(
          "value",
          pastedUrl.slice(0, -count),
        );
        expect(await input.evaluate((el) => el.selectionStart)).toBe(
          pastedUrl.length - count,
        );
      }
      await page.keyboard.press("ControlOrMeta+z");
      await expect(input).toHaveJSProperty("value", pastedUrl.slice(0, -2));
    }
    await input.fill(pastedUrl);
    await input.evaluate((el) => el.setSelectionRange(0, 0));
    await page.keyboard.press("Delete");
    await expect(input).toHaveJSProperty("value", pastedUrl.slice(1));

    for (const source of [pastedUrl, `[${pastedUrl}](${pastedUrl})`]) {
      for (const restoredInsideLabel of [false, true]) {
        await input.fill("");
        await expect(input).toHaveJSProperty("value", "");
        await input.evaluate((el, source) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", source);
          el.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData,
            }),
          );
        }, source);
        await expect(input.locator("[data-source]")).toHaveCount(1);
        await expect(input).toHaveJSProperty("value", `${source} `);
        if (restoredInsideLabel) {
          // Some native WebKit selection restorations land inside the uneditable
          // label even though its logical offset is the end of the pasted URL.
          await input.evaluate((el) => {
            const token = el.querySelector("[data-source]");
            getSelection().setBaseAndExtent(
              token,
              token.childNodes.length,
              token,
              token.childNodes.length,
            );
            // Exercise the key path before a queued selectionchange can repair it.
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: " ",
                bubbles: true,
                cancelable: true,
              }),
            );
          });
          await page.keyboard.press("Space");
        }
        await expect(input).toBeFocused();
        // Use the keyboard directly: locator.press would refocus and hide this bug.
        await page.keyboard.type("next thought");
        await expect(input).toHaveJSProperty(
          "value",
          `${source} next thought${restoredInsideLabel ? " " : ""}`,
        );
        await expect(input).toBeFocused();
        expect(await input.evaluate((el) => el.selectionStart)).toBe(
          `${source} next thought`.length,
        );
      }
    }

    for (const { source, initial, expected, caret = 0 } of [
      {
        source: pastedUrl,
        initial: "[First](https://example.com)  after",
        caret: "[First](https://example.com) ".length,
        expected: `[First](https://example.com) ${pastedUrl} next after`,
      },
      {
        source: pastedUrl,
        initial: " after",
        expected: `${pastedUrl} next after`,
      },
      { source: `${pastedUrl} `, initial: "", expected: `${pastedUrl} next ` },
      { source: "plain", initial: "", expected: "plainnext " },
      {
        source: `\`${pastedUrl}\``,
        initial: "",
        expected: `\`${pastedUrl}\`next `,
      },
    ]) {
      await input.fill(initial);
      await expect(input).toHaveJSProperty("value", initial);
      await input.evaluate(
        (el, { source, caret }) => {
          el.setSelectionRange(caret, caret);
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", source);
          el.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData,
            }),
          );
        },
        { source, caret },
      );
      await page.keyboard.type("next ");
      await expect(input).toHaveJSProperty("value", expected);
    }

    // Markdown titles stay in the authored source while the composer decorates
    // only the destination and label, matching the delivered message renderer.
    const titledSource = '[Docs](https://example.com "Guide")';
    await input.fill(titledSource);
    await expect(input.locator("[data-source]")).toHaveText("Docs");
    await expect(input).toHaveJSProperty("value", titledSource);
    await input.press("Enter");
    expect(
      (await page.evaluate(() => window.linkComposerFixture.sent)).at(-1),
    ).toEqual({ text: titledSource, mentions: [] });

    // A compact label still copies, edits, and sends the full destination.
    const longUrl =
      "https://www.figma.com/design/example/Builderlab-Café-Branding?node-id=1119-21207";
    for (const source of [longUrl, `[${longUrl}](${longUrl})`]) {
      await input.fill("");
      await input.fill(source);
      await expect(input.locator("[data-link-kind=figma]")).toHaveText(
        `${longUrl.slice(0, 34)}…${longUrl.slice(-10)}`,
      );
      const longCopy = await input.evaluate((el) => {
        el.setSelectionRange(0, el.value.length);
        const clipboardData = new DataTransfer();
        el.dispatchEvent(
          new ClipboardEvent("copy", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
        return clipboardData.getData("text/plain");
      });
      expect(longCopy).toBe(source);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Backspace");
      await expect(input).toHaveJSProperty("value", source.slice(0, -1));
      await expect(input.locator("[data-source]")).toHaveCount(0);
      await input.fill("");
      await input.fill(source);
      await page.keyboard.press("Enter");
      expect(
        (await page.evaluate(() => window.linkComposerFixture.sent)).at(-1),
      ).toEqual({ text: source, mentions: [] });
    }

    // Undo restores the pre-edit caret, including edits before rendered tokens.
    await input.fill("ABC");
    await input.evaluate((el) => el.setSelectionRange(1, 1));
    await input.pressSequentially("X");
    await input.press("ControlOrMeta+z");
    await expect(input).toHaveJSProperty("value", "ABC");
    expect(await input.evaluate((el) => el.selectionStart)).toBe(1);
    await input.pressSequentially("Y");
    await expect(input).toHaveJSProperty("value", "AYBC");
    await input.press("Shift+Enter");
    await input.pressSequentially("next");
    await expect(input).toHaveJSProperty("value", "AY\nnextBC");

    await input.fill("");
    await input.pressSequentially("https://github.com/block/buzz-app");
    await expect(input.locator('[data-link-kind="github"]')).toHaveCount(1);
    await input.pressSequentially(" after");
    await expect(input).toHaveJSProperty(
      "value",
      "https://github.com/block/buzz-app after",
    );
    await input.locator("[data-source]").dblclick();
    await input.pressSequentially("https://drive.google.com/file/edited");
    await expect(input).toHaveJSProperty(
      "value",
      "https://drive.google.com/file/edited after",
    );
    await expect(input.locator('[data-link-kind="drive"]')).toHaveCount(1);

    await input.fill("Before ");
    await input.press("End");
    await page
      .getByRole("button", { name: "Mention Alex Chen", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Mention Build Bot", exact: true })
      .click();
    await input.evaluate((el) => el.setSelectionRange(7, 17));
    await input.press("Backspace");
    await expect(input.locator('.inline-chip[data-kind="person"]')).toHaveCount(
      0,
    );
    await expect(input.locator('.inline-chip[data-kind="agent"]')).toHaveCount(
      1,
    );
    await input.press("ControlOrMeta+z");
    await expect(input.locator('.inline-chip[data-kind="person"]')).toHaveCount(
      1,
    );
    expect(
      await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([7, 17]);
    await input.press("ControlOrMeta+Shift+z");
    await expect(input.locator('.inline-chip[data-kind="person"]')).toHaveCount(
      0,
    );
    await input.press("Enter");
    expect(
      (await page.evaluate(() => window.linkComposerFixture.sent)).at(-1),
    ).toEqual({ text: "Before  @Build Bot ", mentions: ["b".repeat(64)] });

    await input.fill("IME");
    const compositionKeys = await input.evaluate((el) => {
      el.setSelectionRange(1, 1);
      el.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      const results = ["Home", "End", "Enter"].map((key) => {
        const event = new KeyboardEvent("keydown", {
          key,
          isComposing: true,
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
        return { prevented: event.defaultPrevented, caret: el.selectionStart };
      });
      el.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      return results;
    });
    expect(compositionKeys).toEqual(
      Array(3).fill({ prevented: false, caret: 1 }),
    );

    // IME input can be noncancelable; enforce the source limit when it commits.
    await input.fill("A".repeat(16000));
    await input.evaluate((el) => {
      el.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: false,
          inputType: "insertCompositionText",
          data: "你",
          isComposing: true,
        }),
      );
      el.value += "你";
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "你",
          isComposing: true,
        }),
      );
      el.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "你" }),
      );
    });
    await expect(input).toHaveJSProperty("value", "A".repeat(16000));

    await input.fill(pasted);
    await page.getByRole("button", { name: "Plugin off", exact: true }).click();
    await expect(preview.locator("[data-link-renderer]")).toHaveCount(0);
    await expect(preview).toContainText("Drive");
    await expect(input).toHaveJSProperty("value", pasted);
  } finally {
    await server.close();
  }
});

test("Up and Down move one line at a time through links that wrap", async ({
  page,
}) => {
  // A line that holds only part of a wrapped link has no caret position of its
  // own: left to the browser, Up and Down stall there in WebKit and jump to the
  // document edge in Chromium. Layout decides where a link wraps, so this needs
  // a real browser at a width where both links wrap.
  await page.setViewportSize({ width: 480, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/link-messages.html`,
    );
    const input = page.getByRole("textbox", {
      name: "Message #design",
      exact: true,
    });
    await page.evaluate(() => document.fonts.ready);
    const title =
      "Add fully custom Auth0 login screens with staging and production rollout tooling";
    const link = (label, pull) =>
      `[${label}](https://github.com/block/buzz/pull/${pull})`;
    // The first link starts its paragraph, so its first line holds only link
    // text. The second wraps twice, so its middle line does too.
    const first = link(title, 1);
    const second = link(`${title} plus a long tail that wraps again`, 2);
    const [lead, firstTail, secondTail] = [
      "Words before ",
      ": wraps once.",
      " after it.",
    ];
    const text = [
      "Plain words above the links.",
      `${first}${firstTail}`,
      `${lead}${second}${secondTail}`,
      // Enough lines that the composer scrolls the links out of view.
      ...Array.from({ length: 5 }, (_, line) => `Plain line ${line} below.`),
    ].join("\n");
    await input.fill("");
    await input.fill(text);
    const links = input.locator('[data-link-kind="github"]');
    await expect(links).toHaveCount(2);
    // How many rects each link draws, more than one where it wraps.
    const rects = () =>
      input
        .locator("[data-source]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getClientRects().length),
        );
    const lines = await rects();
    expect(lines[0]).toBeGreaterThanOrEqual(2);
    expect(lines[1]).toBeGreaterThanOrEqual(3);
    expect(
      await input.evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);

    const firstFrom = text.indexOf(first);
    const firstTo = firstFrom + first.length;
    const secondFrom = text.indexOf(second);
    const secondTo = secondFrom + second.length;
    const caret = () =>
      input.evaluate((el) =>
        el.selectionDirection === "backward"
          ? { head: el.selectionStart, anchor: el.selectionEnd }
          : { head: el.selectionEnd, anchor: el.selectionStart },
      );
    // WebKit settles a caret beside a link when it draws it, and a press
    // before then can move where a person's press would stall.
    const rendered = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    // An empty line holds nothing but its break, so a press onto or off one
    // can cross the break alone.
    const empty = (value, pos) =>
      [value[pos - 1], value[pos]].every((char) => (char ?? "\n") === "\n");
    // Presses `key` from a head at `start`, with a Shift selection's anchor
    // at `anchor`, until the head reaches `stop`, returning where each press
    // lands. A press that leaves the head in place fails the poll, and so does
    // one that crosses nothing but a line break, unless onto or off an empty
    // line: the caret jumps to the far end of a line, and a Shift selection
    // grows by the break alone, which looks like no move at all.
    const walk = async (key, start, stop, anchor = start) => {
      const value = await input.evaluate((el) => el.value);
      await input.evaluate(
        (el, [anchor, head]) =>
          el.setSelectionRange(
            Math.min(anchor, head),
            Math.max(anchor, head),
            head < anchor ? "backward" : "forward",
          ),
        [anchor, start],
      );
      await rendered();
      const heads = [];
      let head = start;
      while (head !== stop && heads.length < 12) {
        const previous = head;
        await page.keyboard.press(key);
        await expect
          .poll(async () => (head = (await caret()).head))
          .not.toBe(previous);
        expect(Math.sign(head - previous)).toBe(key.endsWith("Up") ? -1 : 1);
        if (!empty(value, previous) && !empty(value, head))
          expect(
            value.slice(Math.min(previous, head), Math.max(previous, head)),
          ).toMatch(/[^\n]/);
        expect((await caret()).anchor).toBe(
          key.startsWith("Shift+") ? anchor : head,
        );
        heads.push(head);
        await rendered();
      }
      return heads;
    };
    for (const shift of ["", "Shift+"]) {
      const down = await walk(`${shift}ArrowDown`, 0, secondTo);
      // Onto the first link's own line at its start, then across the link.
      expect(down.slice(0, 2)).toEqual([firstFrom, firstTo]);
      // One line down: the words before the second link.
      expect(down[2]).toBeGreaterThanOrEqual(secondFrom - lead.length);
      expect(down[2]).toBeLessThanOrEqual(secondFrom);
      // Across the second link's middle line.
      expect(down.slice(3)).toEqual([secondTo]);

      const up = await walk(`${shift}ArrowUp`, text.length, 0);
      const [afterSecond, beforeSecond, afterFirst, ...rest] = up.slice(-5);
      // The line holding the end of the second link and the words after it.
      expect(afterSecond).toBeGreaterThanOrEqual(secondTo);
      expect(afterSecond).toBeLessThanOrEqual(secondTo + secondTail.length);
      // Across the second link's middle line, then up to the first link's end
      // line, onto its own first line, and off it to the line above at the
      // caret's column, its start.
      expect(beforeSecond).toBe(secondFrom);
      expect(afterFirst).toBeGreaterThanOrEqual(firstTo);
      expect(afterFirst).toBeLessThanOrEqual(firstTo + firstTail.length);
      expect(rest).toEqual([firstFrom, 0]);
    }

    // A typed line break after the first link leaves its end line to it too.
    await input.evaluate((el, at) => el.setSelectionRange(at, at), firstTo);
    await input.press("Shift+Enter");
    await expect(input).toHaveJSProperty(
      "value",
      `${text.slice(0, firstTo)}\n${text.slice(firstTo)}`,
    );
    for (const shift of ["", "Shift+"])
      expect(
        await walk(
          `${shift}ArrowUp`,
          firstTo + 1 + firstTail.length,
          firstFrom,
        ),
      ).toEqual([firstTo, firstFrom]);

    // WebKit can report a caret key as a control character; that path moves
    // across a link line the same way.
    await input.evaluate((el, at) => el.setSelectionRange(at, at), firstFrom);
    await input.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "\u001F",
          code: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect((await caret()).head).toBe(firstTo);

    // Stepping off a link that starts or ends its paragraph keeps the caret's
    // column on the neighbouring line, even where that line starts with the
    // tail of another link.
    const edges = [
      "Plain words above.",
      `${link(title, 3)} ends here.`,
      link(title, 4),
      "Plain words below, longer than the link's last line.",
    ];
    const draft = edges.join("\n");
    await input.fill("");
    await input.fill(draft);
    await expect(links).toHaveCount(2);
    for (const count of await rects()) expect(count).toBeGreaterThanOrEqual(2);
    const thirdFrom = draft.indexOf(link(title, 3));
    const thirdTo = thirdFrom + link(title, 3).length;
    const fourthFrom = draft.indexOf(link(title, 4));
    const fourthTo = fourthFrom + link(title, 4).length;
    for (const shift of ["", "Shift+"]) {
      const down = await walk(`${shift}ArrowDown`, 0, draft.length);
      expect(down.slice(0, 4)).toEqual([
        thirdFrom,
        thirdTo,
        fourthFrom,
        fourthTo,
      ]);
      // Off the fourth link's last line to the line below, under its end.
      const [column, ...end] = down.slice(4);
      expect(column).toBeGreaterThan(fourthTo + 1);
      expect(end).toEqual([draft.length]);
      const { x, edge, em } = await input.evaluate((el, at) => {
        el.setSelectionRange(at, at);
        const fourth = [...el.querySelectorAll("[data-source]")].at(-1);
        return {
          x: getSelection().getRangeAt(0).getClientRects()[0].left,
          edge: [...fourth.getClientRects()].at(-1).right,
          em: Number.parseFloat(getComputedStyle(el).fontSize),
        };
      }, column);
      // The nearest position is within half a glyph, so half an em.
      expect(Math.abs(x - edge)).toBeLessThanOrEqual(em / 2);
      // Off the fourth link's first line to the third link's end, which is
      // where the line above starts.
      expect(await walk(`${shift}ArrowUp`, draft.length, 0)).toEqual([
        fourthTo,
        fourthFrom,
        thirdTo,
        thirdFrom,
        0,
      ]);
    }

    // Entering a line that only a link holds stops at the edge it holds, which
    // has no position at the caret's column. From just past the line break
    // beside the link, a Shift selection would grow by the break alone, so it
    // takes the whole link instead, and the next press goes on from there.
    for (const [key, start, near, shifted] of [
      [
        "ArrowDown",
        edges[0].length,
        thirdFrom,
        [thirdTo, fourthFrom, fourthTo],
      ],
      ["ArrowUp", fourthTo + 1, fourthTo, [fourthFrom, thirdTo, thirdFrom, 0]],
    ]) {
      await input.evaluate((el, at) => el.setSelectionRange(at, at), start);
      await rendered();
      await page.keyboard.press(key);
      await expect.poll(caret).toEqual({ head: near, anchor: near });
      const heads = await walk(
        `Shift+${key}`,
        start,
        key === "ArrowUp" ? 0 : draft.length,
      );
      expect(heads.slice(0, shifted.length)).toEqual(shifted);
    }

    // So does a link on its own line between two lines of text.
    const own = ["Please review", link(title, 5), "Thanks"];
    const ownDraft = own.join("\n");
    await input.fill("");
    await input.fill(ownDraft);
    await expect(links).toHaveCount(1);
    expect((await rects())[0]).toBeGreaterThanOrEqual(2);
    const ownFrom = own[0].length + 1;
    const ownTo = ownFrom + own[1].length;
    expect(await walk("Shift+ArrowUp", ownTo + 1, 0)).toEqual([ownFrom, 0]);
    const [ownDown] = await walk(
      "Shift+ArrowDown",
      own[0].length,
      ownDraft.length,
    );
    expect(ownDown).toBe(ownTo);

    // The draft's links, and the visual line of a head: the newlines before
    // it, plus the lines each link before it wraps onto. A head past a link's
    // start is at or past its end, on its last line.
    const layout = async () => {
      const value = await input.evaluate((el) => el.value);
      const counts = await rects();
      const links = [...value.matchAll(/\[[^\]]*\]\([^)]*\)/g)].map(
        (match, index) => ({
          from: match.index,
          to: match.index + match[0].length,
          count: counts[index],
        }),
      );
      const visual = (head) =>
        value.slice(0, head).split("\n").length -
        1 +
        links.reduce(
          (lines, { from, count }) => lines + (head > from ? count - 1 : 0),
          0,
        );
      return { value, links, visual };
    };
    // Presses `key` and returns the caret once its head leaves `head`.
    const press = async (key, head, message) => {
      await page.keyboard.press(key);
      let now;
      await expect
        .poll(
          async () => {
            now = await caret();
            return now.head;
          },
          { message },
        )
        .not.toBe(head);
      return now;
    };
    // From either end of each line and link, a plain press moves exactly one
    // visual line. A Shift press and then the opposite one keep the anchor,
    // never carry the head past it, and never leave a lone line break
    // selected. Most return to the start, but entering a line that only a
    // link holds stops at an edge chosen by direction, not by the caret's
    // column, so the second press can stop short of it.
    const moves = async ({ value, links, visual }) => {
      const ends = new Set([0, value.length]);
      for (const { index } of value.matchAll(/\n/g))
        ends.add(index).add(index + 1);
      for (const { from, to } of links) ends.add(from).add(to);
      for (const at of ends)
        for (const [key, back, step] of [
          ["ArrowUp", "ArrowDown", -1],
          ["ArrowDown", "ArrowUp", 1],
        ]) {
          const target = visual(at) + step;
          if (target < 0 || target > visual(value.length)) continue;
          const message = `${key} from ${at}`;
          await input.evaluate((el, at) => el.setSelectionRange(at, at), at);
          await rendered();
          await page.keyboard.press(key);
          await expect
            .poll(async () => visual((await caret()).head), { message })
            .toBe(target);
          await input.evaluate((el, at) => el.setSelectionRange(at, at), at);
          await rendered();
          const there = await press(`Shift+${key}`, at, `Shift+${message}`);
          expect(there.anchor, `Shift+${message}`).toBe(at);
          if (!empty(value, at) && !empty(value, there.head))
            expect(
              value.slice(Math.min(at, there.head), Math.max(at, there.head)),
              `Shift+${message}`,
            ).toMatch(/[^\n]/);
          await rendered();
          const backMessage = `Shift+${key} then Shift+${back} from ${at}`;
          const { head, anchor } = await press(
            `Shift+${back}`,
            there.head,
            backMessage,
          );
          expect(anchor, backMessage).toBe(at);
          expect(Math.sign(head - at), backMessage).not.toBe(-step);
          if (head !== at)
            expect(
              value.slice(Math.min(at, head), Math.max(at, head)),
              backMessage,
            ).toMatch(/[^\n]/);
        }
    };
    await moves(await layout());

    // fill() makes a paragraph of each line, but a text/plain paste, like
    // Shift+Enter, puts newline characters in one paragraph. A newline is
    // drawn at the end of its line, apart from a caret just past it.
    const pasted = link(title, 6);
    const paste = async (lines) => {
      const value = lines.join("\n");
      await input.fill("");
      await input.evaluate((el, value) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", value);
        el.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      }, value);
      await expect(input).toHaveJSProperty("value", value);
      await expect(input.locator(":scope > p")).toHaveCount(1);
      const draft = await layout();
      // Links titled `title` wrap, and shorter ones do not.
      for (const { from, to, count } of draft.links)
        expect(count > 1).toBe(value.slice(from, to).includes(title));
      await moves(draft);
      return draft;
    };
    {
      const lines = ["Please review", pasted, "X line", "Thanks"];
      const {
        value,
        links: [{ from, to }],
      } = await paste(lines);
      const thanks = value.length - lines.at(-1).length;
      expect(await walk("Shift+ArrowUp", thanks, 0)).toEqual([to + 1, from, 0]);
      const down = await walk("Shift+ArrowDown", 0, value.length);
      expect(down.slice(0, 2)).toEqual([from, to]);
    }
    {
      // An empty line beside the link is a line of its own.
      const {
        value,
        links: [{ from, to }],
      } = await paste(["Please review", "", pasted, "", "Thanks"]);
      expect(await walk("Shift+ArrowDown", 0, value.length)).toEqual([
        from - 1,
        to,
        to + 1,
        to + 2,
        value.length,
      ]);
      expect(await walk("Shift+ArrowUp", value.length, 0)).toEqual([
        to + 1,
        from,
        from - 1,
        0,
      ]);
    }
    {
      // With an empty line below the link alone, three Shift presses down
      // from the line above and three back retrace each other, collapsing at
      // the start rather than undoing two presses at once.
      const {
        links: [{ from, to }],
      } = await paste(["Please review", pasted, "", "Thanks"]);
      expect(await walk("Shift+ArrowDown", from - 1, to + 2)).toEqual([
        to,
        to + 1,
        to + 2,
      ]);
      expect(await walk("Shift+ArrowUp", to + 2, from - 1, from - 1)).toEqual([
        to + 1,
        to,
        from - 1,
      ]);
    }
    // A link short enough not to wrap still holds its line alone.
    await paste(["Please review", link("PR 7", 7), "Thanks"]);
    {
      // On consecutive lines, each Shift press across two links takes a whole
      // one, rather than the line break between them.
      const {
        value,
        links: [first, second],
      } = await paste(["PRs:", link(title, 8), link(title, 9), "Thanks"]);
      expect(
        (await walk("Shift+ArrowDown", 0, value.length)).slice(0, 3),
      ).toEqual([first.from, first.to, second.to]);
      expect(await walk("Shift+ArrowUp", value.length, 0)).toEqual([
        second.to,
        second.from,
        first.from,
        0,
      ]);
    }
    // A draft that starts with an empty line: Chromium draws no rect before
    // its leading newline.
    await paste(["", pasted, ""]);

    // The nearest position on the neighbouring line is a character boundary,
    // never inside an emoji or a cluster, where a caret is drawn at the glyph
    // and a Shift selection would split the character.
    const thumb = "👍🏽";
    const emoji = ["😀😀😀 words above", link(title, 1), thumb.repeat(20)];
    const emojiDraft = emoji.join("\n");
    await input.fill("");
    await input.fill(emojiDraft);
    await expect(links).toHaveCount(1);
    expect((await rects())[0]).toBeGreaterThanOrEqual(2);
    const emojiFrom = emoji[0].length + 1;
    const emojiTo = emojiFrom + emoji[1].length;
    for (const shift of ["", "Shift+"]) {
      const [below] = await walk(
        `${shift}ArrowDown`,
        emojiTo,
        emojiDraft.length,
      );
      expect((below - emojiTo - 1) % thumb.length).toBe(0);
      expect(await walk(`${shift}ArrowUp`, emojiFrom, 0)).toEqual([0]);
    }
    // Deleting that Shift selection leaves no half of the first emoji behind.
    await page.keyboard.press("Backspace");
    await expect(input).toHaveJSProperty("value", emojiDraft.slice(emojiFrom));

    // WebKit splits this link into two rects on one line, reordering its
    // Hebrew with the text after it. That is still one line, and native Down
    // onto the link stalls there, so each press must still move one line.
    const bidi = [
      "First line.",
      `${link("PR שלום עולם", 1)} שלום עולם`,
      "Last line.",
    ];
    await input.fill("");
    await input.fill(bidi.join("\n"));
    await expect(links).toHaveCount(1);
    const starts = [0, bidi[0].length + 1, bidi[0].length + bidi[1].length + 2];
    const line = (head) => starts.findLastIndex((start) => head >= start);
    for (const shift of ["", "Shift+"])
      for (const [key, start, expected] of [
        ["ArrowDown", 0, [1, 2]],
        ["ArrowUp", bidi.join("\n").length, [1, 0]],
      ]) {
        await input.evaluate((el, at) => el.setSelectionRange(at, at), start);
        await rendered();
        for (const index of expected) {
          await page.keyboard.press(`${shift}${key}`);
          await expect.poll(async () => line((await caret()).head)).toBe(index);
          const { head, anchor } = await caret();
          expect(anchor).toBe(shift ? start : head);
          await rendered();
        }
      }
  } finally {
    await server.close();
  }
});

test("Apple paragraph commands cross a link instead of stopping at it", async ({
  page,
}) => {
  // Native paragraph commands stop at an uneditable link chip: WebKit's
  // Control-A, Control-E and Option-Up/Down, and Control-K in both engines.
  // Only a real browser runs the native commands the editor must replace.
  test.skip(process.platform !== "darwin", "Apple key bindings");
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/link-messages.html`,
    );
    const input = page.getByRole("textbox", {
      name: "Message #design",
      exact: true,
    });
    const link = "https://github.com/block/buzz/pull/117/changes";
    const text = `top line\nbefore ${link} after\nend line`;
    const start = text.indexOf("before");
    const end = text.indexOf("\nend");
    await input.fill(text);
    await expect(input.locator("[data-source]")).toHaveCount(1);
    // Presses `keys` from a caret at `from`, returning the selection. WebKit
    // settles a caret beside a link when it draws it, so a press waits for that.
    const press = async (from, ...keys) => {
      await input.evaluate((el, at) => el.setSelectionRange(at, at), from);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      for (const key of keys) await page.keyboard.press(key);
      return input.evaluate((el) => [el.selectionStart, el.selectionEnd]);
    };
    expect(await press(end, "Control+a")).toEqual([start, start]);
    expect(await press(start, "Control+e")).toEqual([end, end]);
    expect(await press(end, "Shift+Control+a")).toEqual([start, end]);
    expect(await press(end, "Alt+ArrowUp")).toEqual([start, start]);
    expect(await press(end, "Alt+ArrowUp", "Alt+ArrowUp")).toEqual([0, 0]);
    expect(await press(start, "Alt+ArrowDown")).toEqual([end, end]);
    expect(await press(start, "Control+k")).toEqual([start, start]);
    await expect(input).toHaveJSProperty("value", "top line\n\nend line");
  } finally {
    await server.close();
  }
});
