import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

// Browser-only: real same-origin storage events must carry the registered
// Settings card's changes to another mounted xterm, without replacing it.
test("terminal settings apply, persist and reset across windows", async ({
  page,
  context,
}) => {
  const server = await createServer({
    configFile: false,
    envDir: false,
    server: { host: "127.0.0.1", port: 0 },
  });
  await context.addInitScript(() => {
    document.fonts.add(
      new FontFace(
        "Buzz Terminal Settings Test",
        'url("/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2")',
      ),
    );
  });
  const second = await context.newPage();
  const errors = [watchPageErrors(page), watchPageErrors(second)];
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-panel.html`;
    for (const target of [page, second]) {
      await target.goto(url);
      await target
        .getByRole("button", { name: "Toggle channel terminal", exact: true })
        .click();
      await expect(target.locator(".xterm-rows")).toContainText(
        "FIXTURE_SHELL_READY",
      );
      await target.evaluate(() => {
        window.retainedTerminal = document.querySelector(".xterm");
      });
    }
    await page
      .getByRole("button", { name: "Terminal font settings", exact: true })
      .click();
    const input = page.getByRole("textbox", { name: "Font family" });
    const size = page.getByRole("spinbutton", { name: "Font size (px)" });
    await input.fill("ASDF Buzz Missing Font");
    await input.blur();
    await expect(page.getByRole("alert")).toContainText("Couldn’t load");
    await expect(
      page.getByRole("button", { name: "Apply", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".xterm-rows")).toHaveCSS(
      "font-family",
      /^"?JetBrains Mono"?,/,
    );
    await input.fill("Buzz Terminal Settings Test");
    await size.fill("18");
    await expect(
      page.getByRole("button", { name: "Apply", exact: true }),
    ).toBeEnabled();
    await input.press("Enter");
    await expect(second.locator(".xterm-rows")).toHaveCSS("font-size", "18px");
    await expect(second.locator(".xterm-rows")).toHaveCSS(
      "font-family",
      /^"?Buzz Terminal Settings Test"?,/,
    );
    await expect(second.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    expect(
      await second.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);
    await second.reload();
    await second
      .getByRole("button", { name: "Toggle channel terminal", exact: true })
      .click();
    await expect(second.locator(".xterm-rows")).toHaveCSS(
      "font-family",
      /^"?Buzz Terminal Settings Test"?,/,
    );
    await expect(second.locator(".xterm-rows")).toHaveCSS("font-size", "18px");
    await page.setViewportSize({ width: 390, height: 950 });
    await page
      .getByRole("button", { name: "Enlarge text", exact: true })
      .click();
    const section = page.getByRole("region", { name: "Terminal", exact: true });
    expect(
      await section.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Use default", exact: true })
      .click();
    await expect(input).toHaveValue("");
    await expect(size).toHaveValue("12");
    await expect(second.locator(".xterm-rows")).toHaveCSS(
      "font-family",
      /^"?JetBrains Mono"?,/,
    );
    await expect(second.locator(".xterm-rows")).toHaveCSS("font-size", "12px");
    expect(errors.flatMap((error) => error.unexplained())).toEqual([]);
  } finally {
    await server.close();
  }
});

// Browser-only: CSS font resolution, xterm cell measurement and FitAddon must
// cooperate on a live font swap. A DOM emulator cannot establish that boundary.
test("terminal font changes refit the retained emulator and restore the default", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envDir: false,
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  let fontGate = Promise.withResolvers();
  let fontRequest = Promise.withResolvers();
  const startupFont = Promise.withResolvers();
  const startupRequest = Promise.withResolvers();
  try {
    await server.listen();
    await page.route(
      "**/jetbrains-mono-latin-400-normal.woff2",
      async (route) => {
        startupRequest.resolve();
        await startupFont.promise;
        await route.continue();
      },
    );
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal.html`,
      { waitUntil: "domcontentloaded" },
    );
    const rows = page.locator(".xterm-rows");
    await startupRequest.promise;
    // Theme must be present even while the initial font metrics are pending.
    const background = await page
      .locator(".xterm")
      .locator("..")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(page.locator(".xterm-scrollable-element")).toHaveCSS(
      "background-color",
      background,
    );
    startupFont.resolve();
    // Terminal ANSI styles must work even if an installed family has one face.
    // The surrounding app disables font synthesis for its own bundled fonts.
    await expect(rows).toHaveCSS("font-synthesis-weight", "auto");
    await expect(rows).toHaveCSS("font-synthesis-style", "auto");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await page.route("**/terminal-delayed.woff2*", async (route) => {
      fontRequest.resolve();
      await fontGate.promise;
      await route.fulfill({
        response: await route.fetch({
          url: new URL(
            "/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
            page.url(),
          ).href,
        }),
      });
    });
    await page.evaluate(async () => {
      // Use a deliberately wider face from the pinned font asset, independent
      // of whichever system fonts happen to be installed on a CI machine.
      const face = new FontFace(
        "Buzz Terminal Test",
        'url("/terminal-delayed.woff2")',
        { sizeAdjust: "150%" },
      );
      document.fonts.add(face);
      await document.fonts.load('12px "JetBrains Mono"');
      await document.fonts.ready;
    });
    await page.evaluate(async () => {
      await window.terminalRenderer.output("FONT_SWAP_RETAINS_OUTPUT");
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await expect(rows).toContainText("FONT_SWAP_RETAINS_OUTPUT");
    const dimensions = page.getByLabel("Dimensions", { exact: true });
    await expect(dimensions).not.toBeEmpty();
    const original = await dimensions.textContent();
    await page.evaluate(() =>
      window.terminalRenderer.font.set("Buzz Terminal Test"),
    );
    await fontRequest.promise;
    await expect(dimensions).toHaveText(original);
    fontGate.resolve();
    await page.evaluate(() => document.fonts.load('12px "Buzz Terminal Test"'));
    await expect(rows).toHaveCSS("font-family", /^"?Buzz Terminal Test"?,/);
    await expect(dimensions).not.toHaveText(original);
    await page.evaluate(() => window.terminalRenderer.font.reset());
    await expect(rows).toHaveCSS("font-family", /^"?JetBrains Mono"?,/);
    await expect(dimensions).toHaveText(original);
    // A slower, older choice must not overwrite a newer reset.
    fontGate = Promise.withResolvers();
    fontRequest = Promise.withResolvers();
    await page.evaluate(() => {
      document.fonts.add(
        new FontFace(
          "Buzz Terminal Stale",
          'url("/terminal-delayed.woff2?stale")',
          { sizeAdjust: "200%" },
        ),
      );
      window.terminalRenderer.font.set("Buzz Terminal Stale");
    });
    await fontRequest.promise;
    await page.evaluate(() => window.terminalRenderer.font.reset());
    await expect(rows).toHaveCSS("font-family", /^"?JetBrains Mono"?,/);
    fontGate.resolve();
    await page.evaluate(async () => {
      await document.fonts.load('12px "Buzz Terminal Stale"');
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await expect(rows).toHaveCSS("font-family", /^"?JetBrains Mono"?,/);
    await expect(dimensions).toHaveText(original);
    // Same face, different size: real cell dimensions and PTY resize must follow.
    await page.evaluate(() => window.terminalRenderer.font.set(null, 18));
    await expect(rows).toHaveCSS("font-size", "18px");
    await expect(page.locator(".xterm").locator("..")).toHaveCSS(
      "line-height",
      "18px",
    );
    // Engines serialize zero tracking as either "normal" or "0px".
    expect(
      await page
        .locator(".xterm")
        .locator("..")
        .evaluate(
          (element) =>
            Number.parseFloat(getComputedStyle(element).letterSpacing) || 0,
        ),
    ).toBe(0);
    await expect(dimensions).not.toHaveText(original);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("still typing");
    await expect(page.getByLabel("Input", { exact: true })).toHaveText(
      '"still typing"',
    );
    await page.evaluate(() => window.terminalRenderer.font.reset());
    await expect(dimensions).toHaveText(original);
    expect(
      await page.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);
    // Detached screens take the latest choice when reattached.
    await page
      .getByRole("button", { name: "Toggle mount", exact: true })
      .click();
    await page.evaluate(() =>
      window.terminalRenderer.font.set("Buzz Terminal Test"),
    );
    await page
      .getByRole("button", { name: "Toggle mount", exact: true })
      .click();
    await expect(rows).toHaveCSS("font-family", /^"?Buzz Terminal Test"?,/);
    await expect(rows).toContainText("FONT_SWAP_RETAINS_OUTPUT");
    await page.evaluate(() =>
      window.terminalRenderer.font.set("Nonexistent Buzz Font"),
    );
    await expect(dimensions).toHaveText(original);
    expect(errors.unexplained()).toEqual([]);
  } finally {
    startupFont.resolve();
    fontGate.resolve();
    await server.close();
  }
});

// Real keyboard, paste and parser events must cross the renderer's provenance
// seam. A DOM emulator or mocked Terminal cannot establish that contract.
for (const platform of ["MacIntel", "Linux x86_64"]) {
  test(`real xterm preserves navigation and input provenance on ${platform}`, async ({
    page,
  }) => {
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, "platform", { value: platform });
    }, platform);
    const server = await createServer({
      configFile: false,
      envDir: false,
      server: { host: "127.0.0.1", port: 0 },
    });
    const errors = watchPageErrors(page);
    try {
      await server.listen();
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal.html`,
      );
      await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
      const apple = platform === "MacIntel";
      const generated = () =>
        page.evaluate(() => window.terminalRenderer.generated);
      const expected = [];
      for (const [key, data] of [
        ["ArrowLeft", "\x1b[D"],
        ["Control+ArrowRight", "\x1b[1;5C"],
        ["Alt+ArrowLeft", apple ? "\x1bb" : "\x1b[1;5D"],
        ["Alt+ArrowRight", apple ? "\x1bf" : "\x1b[1;5C"],
        ["Alt+ArrowUp", apple ? "\x1b[1;3A" : "\x1b[1;5A"],
        ["Alt+ArrowDown", apple ? "\x1b[1;3B" : "\x1b[1;5B"],
        ["Alt+Shift+ArrowLeft", "\x1b[1;4D"],
        ["Alt+Control+ArrowRight", "\x1b[1;7C"],
      ]) {
        await page.keyboard.press(key);
        expected.push({ data, source: "user" });
        await expect.poll(generated).toEqual(expected);
      }
      if (apple) {
        // Off, xterm leaves Option to the keyboard layout and sends no Meta.
        // Turning the setting on makes the open terminal send Meta-B; that
        // single Meta-B also proves the first press sent nothing.
        await page.keyboard.press("Alt+KeyB");
        await page.evaluate((key) => {
          localStorage.setItem(key, "on");
          window.dispatchEvent(new StorageEvent("storage", { key }));
        }, "buzz-terminal-option-meta.v1");
        await page.keyboard.press("Alt+KeyB");
        expected.push({ data: "\x1bb", source: "user" });
        await expect.poll(generated).toEqual(expected);
      }
      await page.evaluate(() =>
        window.terminalRenderer.output("\x1b[?1h\x1b[?2004h"),
      );
      await page.keyboard.press("ArrowUp");
      expected.push({ data: "\x1bOA", source: "user" });
      await page.keyboard.press("Alt+ArrowLeft");
      expected.push({
        data: apple ? "\x1bb" : "\x1b[1;5D",
        source: "user",
      });
      await page.locator(".xterm-helper-textarea").evaluate((textarea) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "first\nsecond");
        textarea.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expected.push({
        data: "\x1b[200~first\rsecond\x1b[201~",
        source: "user",
      });
      await page.evaluate(() =>
        window.terminalRenderer.output("\x1b[5n\x1b[6n"),
      );
      expected.push(
        { data: "\x1b[0n", source: "reply" },
        { data: "\x1b[1;1R", source: "reply" },
      );
      await expect.poll(generated).toEqual(expected);
      expect(errors.unexplained()).toEqual([]);
    } finally {
      await server.close();
    }
  });
}

// A hidden screen parses in slices; only the real parser can show that a
// split character or escape sequence survives the boundary.
test("real xterm parses a large hidden output completely and in order", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envDir: false,
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal.html`,
    );
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(
      page.getByLabel("Dimensions", { exact: true }),
    ).not.toBeEmpty();
    await page
      .getByRole("button", { name: "Toggle mount", exact: true })
      .click();
    await expect(page.locator(".xterm")).toHaveCount(0);
    // Each segment starts at its own column and reports where it ended. At 76
    // bytes, the 16 KiB slice boundaries fall inside a CJK character, an SGR
    // sequence, an emoji and a two-byte letter.
    const segment = (i) =>
      `\x1b[1;${10 + (i % 50)}H\x1b[1;31m${"é中😀".repeat(6)}\x1b[0m\x1b[6n`;
    const output = (data) =>
      page.evaluate((data) => window.terminalRenderer.output(data), data);
    const generated = () =>
      page.evaluate(() =>
        window.terminalRenderer.generated.map(({ data }) => data),
      );
    await output(segment(0));
    const width = Number((await generated())[0].match(/;(\d+)R$/)[1]) - 10;
    await output(Array.from({ length: 1000 }, (_, i) => segment(i)).join(""));
    expect((await generated()).slice(1)).toEqual(
      Array.from(
        { length: 1000 },
        (_, i) => `\x1b[1;${10 + (i % 50) + width}R`,
      ),
    );
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

// Rendering barriers and wheel scrolling require the real xterm renderer and
// browser layout. Hold the clock to observe an incomplete synchronized frame.
test("real xterm batches synchronized redraws, recovers an unfinished frame and retains scrollback", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envDir: false,
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal.html`,
    );
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await page.evaluate(() => document.fonts.ready);
    await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
    const rows = page.locator(".xterm-rows");
    const output = async (data) => {
      await page.evaluate((data) => {
        window.terminalOutputParsed = false;
        void window.terminalRenderer.output(data).then(() => {
          window.terminalOutputParsed = true;
        });
      }, data);
      await page.clock.runFor(50);
      await expect
        .poll(() => page.evaluate(() => window.terminalOutputParsed))
        .toBe(true);
    };
    await output("\x1b[2J\x1b[HBEFORE_FRAME");
    await expect(rows).toContainText("BEFORE_FRAME");
    await output("\x1b[?2026h\x1b[HINTERMEDIATE_FRAME");
    await expect(rows).toContainText("BEFORE_FRAME");
    await expect(rows).not.toContainText("INTERMEDIATE_FRAME");
    await output("\x1b[HAFTER_FRAME\x1b[K\x1b[?2026l");
    await expect(rows).toContainText("AFTER_FRAME");
    await expect(rows).not.toContainText("INTERMEDIATE_FRAME");
    await output("\x1b[?2026h\x1b[HRECOVERED_FRAME");
    await page.clock.runFor(800);
    await expect(rows).toContainText("AFTER_FRAME");
    await page.clock.runFor(300);
    await expect(rows).toContainText("RECOVERED_FRAME");
    await page.clock.resume();

    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Shift"); // Dismiss the welcome before wheel input.

    await page.evaluate(() =>
      window.terminalRenderer.output(
        "\x1b[2J\x1b[H" +
          Array.from({ length: 80 }, (_, i) => `SCROLL_LINE_${i}`).join("\r\n"),
      ),
    );
    await expect(rows).toContainText("SCROLL_LINE_79");
    const screen = page.locator(".xterm-screen");
    await screen.hover();
    await page.mouse.wheel(0, -120);
    await expect(rows).not.toContainText("SCROLL_LINE_79");
    const dragScrollbar = async (bottom) => {
      const track = await page
        .locator(".xterm-scrollable-element > .scrollbar.vertical")
        .boundingBox();
      const thumb = await page
        .locator(".xterm-scrollable-element > .scrollbar.vertical > .slider")
        .boundingBox();
      if (!track || !thumb) throw new Error("Missing terminal scrollbar");
      const x = thumb.x + thumb.width / 2;
      await page.mouse.move(x, thumb.y + thumb.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, bottom ? track.y + track.height : track.y);
      await page.mouse.up();
    };
    await dragScrollbar(false);
    await expect(rows).toContainText("SCROLL_LINE_0");
    const scrolled = await rows.textContent();
    await page.evaluate(() =>
      window.terminalRenderer.output("\x1b[?1049h\x1b[2J\x1b[HFULL_SCREEN"),
    );
    await expect(rows).toContainText("FULL_SCREEN");
    await page.mouse.wheel(0, -1000);
    await page.evaluate(() => window.terminalRenderer.output("\x1b[?1049l"));
    await expect(rows).toHaveText(scrolled);
    await page
      .getByRole("button", { name: "Toggle mount", exact: true })
      .click();
    await expect(page.locator(".xterm")).toHaveCount(0);
    await page.evaluate(() =>
      window.terminalRenderer.output("\r\nHIDDEN_OUTPUT"),
    );
    await page
      .getByRole("button", { name: "Toggle mount", exact: true })
      .click();
    await expect(rows).toHaveText(scrolled);
    await screen.hover();
    await page.mouse.wheel(0, 120);
    await expect(rows).not.toContainText("SCROLL_LINE_0");
    await dragScrollbar(true);
    await expect(rows).toContainText("HIDDEN_OUTPUT");
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("real xterm retains output across detach, handles input and resize, and does not reserve absent shortcuts", async ({
  page,
}) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal.html`,
    );
    const button = (name) => page.getByRole("button", { name, exact: true });
    const input = page.getByLabel("Input", { exact: true });
    const splash = page.locator("[data-terminal-splash]");
    await expect(splash).toHaveCount(0); // Wait for actual shell output.
    await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
    await button("Paint terminal").click();
    await page.clock.runFor(50); // Let xterm parse/paint, then hold the welcome open.
    await expect(splash).toBeVisible();
    const art = splash.locator("canvas");
    await expect(art).toBeVisible();
    // Canvas rendering and CSS color resolution require real browser engines.
    const assertArtColors = async () => {
      const pixels = await art.evaluate((canvas) => {
        const { data } = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height);
        let warm = 0,
          neutral = 0,
          coloredOutsideWord = 0;
        const colors = new Set();
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b] = data.slice(i, i + 3);
          const y = Math.floor(i / 4 / canvas.width);
          if (r - b > 10) {
            warm++;
            colors.add(`${r},${g},${b}`);
            if (y < canvas.height * 0.1 || y > canvas.height * 0.9)
              coloredOutsideWord++;
          } else if (r === g && g === b && r > 40 && r < 240) neutral++;
        }
        return { warm, neutral, coloredOutsideWord, colors: colors.size };
      });
      expect(pixels.warm).toBeGreaterThan(100);
      expect(pixels.colors).toBeGreaterThan(8);
      expect(pixels.coloredOutsideWord).toBe(0);
    };
    await assertArtColors();
    await expect(splash).toHaveCSS("--splash-field-opacity", "0.15");
    const beforeMotion = await art.evaluate((canvas) => canvas.toDataURL());
    await page.clock.runFor(100);
    expect(await art.evaluate((canvas) => canvas.toDataURL())).not.toBe(
      beforeMotion,
    );
    await button("Paint terminal").focus();
    await splash.click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(splash).toBeVisible();
    await expect(input).toHaveText('""');
    await page.screenshot({
      path: test.info().outputPath("buzzterm-light.png"),
    });
    const xterm = page.locator(".xterm-scrollable-element");
    const assertAnsiContrast = async () => {
      for (const text of [
        "ANSI_WHITE_ON_BLACK",
        "ANSI_WHITE_ON_GRAY",
        "ANSI_WHITE_ON_DEFAULT",
        "ANSI_BLACK_ON_DEFAULT",
      ]) {
        const ratio = await page
          .getByText(text, { exact: true })
          .evaluate((el) => {
            // xterm can split one ANSI run across several glyph spans.
            const css = getComputedStyle(el.querySelector("span") ?? el);
            const luminance = (color) => {
              const rgb = color
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number)
                .map((v) => {
                  const s = v / 255;
                  return s <= 0.04045
                    ? s / 12.92
                    : ((s + 0.055) / 1.055) ** 2.4;
                });
              return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
            };
            const fg = luminance(css.color);
            const background =
              css.backgroundColor === "rgba(0, 0, 0, 0)"
                ? getComputedStyle(
                    document.querySelector(".xterm-scrollable-element"),
                  ).backgroundColor
                : css.backgroundColor;
            const bg = luminance(background);
            return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
          });
        expect(ratio, `${text} foreground/background contrast`).toBeGreaterThan(
          4.5,
        );
      }
    };
    await assertAnsiContrast();
    const assertSystemAppearance = async () => {
      const actual = await xterm.evaluate((viewport) => {
        const element = viewport.closest("[data-buzz-ui]");
        const css = getComputedStyle(element);
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--bg-panel)";
        element.append(probe);
        const background = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          background: getComputedStyle(viewport).backgroundColor,
          expectedBackground: background,
          font: css.fontFamily,
          size: css.fontSize,
          renderedSize: getComputedStyle(document.querySelector(".xterm-rows"))
            .fontSize,
        };
      });
      expect(actual.background).toBe(actual.expectedBackground);
      expect(actual.font).toContain("JetBrains Mono");
      expect(actual.renderedSize).toBe(actual.size);
      return Number.parseFloat(actual.size);
    };
    expect(await assertSystemAppearance()).toBe(12);
    const lightBackground = await xterm.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await button("Toggle theme").click();
    await page.clock.runFor(50); // Flush xterm's theme repaint under the held clock.
    await expect
      .poll(() => xterm.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(lightBackground);
    await expect(splash).toHaveCSS("--splash-field-opacity", "0.25");
    await assertArtColors();
    await assertAnsiContrast();
    expect(await assertSystemAppearance()).toBe(12);
    await page.screenshot({
      path: test.info().outputPath("buzzterm-dark.png"),
    });
    expect(
      await page.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);

    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("hello");
    await expect(splash).toHaveCount(0);
    await page.clock.resume();

    await page.keyboard.press("Control+c");
    await expect(input).toHaveText('"hello\\u0003"');
    await button("Alternate screen").click();
    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    await button("Enlarge text").click();
    await expect(page.locator("html")).toHaveCSS("font-size", "24px");
    expect(await assertSystemAppearance()).toBe(12);
    const dimensions = await page.getByLabel("Dimensions").textContent();
    await page.setViewportSize({ width: 800, height: 600 });
    await expect(page.getByLabel("Dimensions")).not.toHaveText(dimensions);
    await button("Toggle mount").click();
    await expect(page.locator(".xterm")).toHaveCount(0);
    await button("Paint terminal").click(); // Parse output while detached.
    await button("Toggle theme").click(); // Reopen must pick up hidden appearance changes.
    await button("Toggle mount").click();
    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    await expect(splash).toHaveCount(0);
    await expect
      .poll(() => xterm.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(lightBackground);
    await page.locator(".xterm-helper-textarea").focus();
    // With no dispatcher/registration, even the old toggle chord belongs to
    // the terminal. The plugin/dispatcher handoff is covered below.
    await page.keyboard.press("Control+j");
    await expect(input).toHaveText('"hello\\u0003\\n"');
    // Fresh dark startup, bounded static splash (including reduced motion).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await page.clock.pauseAt(new Date("2026-01-01T02:00:00Z"));
    await button("Toggle theme").click();
    await button("Paint terminal").click();
    await page.clock.runFor(50);
    await expect(splash).toBeVisible();
    const reducedFrame = await art.evaluate((canvas) => canvas.toDataURL());
    await splash.click();
    await page.clock.runFor(2000);
    expect(await art.evaluate((canvas) => canvas.toDataURL())).toBe(
      reducedFrame,
    );
    await expect(splash).toBeVisible();
    await page.clock.runFor(1000);
    await expect(splash).toHaveCount(0); // 3s, not the old 4.5s.
    await page.clock.resume();
    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    // Small terminals retain readable branding instead of clipped block art.
    await page.setViewportSize({ width: 400, height: 600 });
    await page.reload();
    await page.clock.pauseAt(new Date("2026-01-01T03:00:00Z"));
    await button("Paint terminal").click();
    await page.clock.runFor(50);
    await expect(art).toBeVisible();
    await assertArtColors();
    await button("Toggle mount").click();
    await button("Toggle theme").click();
    await button("Toggle mount").click();
    await expect(splash).toHaveCount(0);
    await page.clock.resume();
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("terminal shared controls keep focus, recovery and layout in both modes", async ({
  page,
}) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-panel.html`,
    );
    const button = (name) => page.getByRole("button", { name, exact: true });
    const launcher = button("Toggle channel terminal");
    await expect(launcher).toHaveAttribute("data-buzz-ui", "");
    await expect(launcher).toHaveCSS("padding-left", "0px");
    await expect(launcher).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await launcher.hover();
    await expect(launcher).toHaveCSS("background-color", "rgb(241, 241, 242)");
    await launcher.click();
    const drawer = page.getByRole("region", { name: "Terminal drawer" });
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await expect(launcher).toHaveAttribute("aria-expanded", "true");
    await expect(launcher).toHaveAttribute("data-icon-variant", "ghost");
    await page.mouse.move(0, 0);
    const expectToken = async (node, property, token) => {
      const value = await node.evaluate(
        (el, { property, token }) => {
          const probe = document.createElement("span");
          probe.style.setProperty(property, `var(${token})`);
          el.append(probe);
          const value = getComputedStyle(probe).getPropertyValue(property);
          probe.remove();
          return value;
        },
        { property, token },
      );
      await expect(node).toHaveCSS(property, value);
    };
    await expectToken(launcher, "color", "--text-standard");
    await expectToken(launcher, "background-color", "--interaction-pressed");
    const restart = button("Restart");
    await expect(restart).toHaveClass("buzz-button");
    await expect(restart).toHaveCSS("border-top-width", "0px");
    const hide = button("Hide terminal");
    // Pointer focus is quiet; keyboard navigation paints the actual control.
    await button("Enlarge text").click();
    // The shared small-button label role is 14px, scaled to 150%.
    await expect(restart).toHaveCSS("font-size", "21px");
    // Keep the operation pending while its disabled color finishes animating.
    // A short fixture delay can expire between Playwright's assertion samples.
    await page.evaluate(() => window.terminalPanel.holdClose());
    try {
      await restart.click();
      await expect
        .poll(() => page.evaluate(() => window.terminalPanel.closePending()))
        .toBe(true);
      await expect(restart).toBeDisabled();
      await expectToken(restart, "color", "--text-disabled");
      await expect(restart).toHaveCSS("outline-style", "none");
    } finally {
      await page.evaluate(() => window.terminalPanel.releaseClose());
    }
    await expect(restart).toBeEnabled();
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await button("End session").focus();
    await page.keyboard.press("Tab");
    await expect(hide).toBeFocused();
    await expect(hide).toHaveCSS("outline-style", "solid");
    await expect(hide).toHaveCSS("outline-width", "2px");
    for (const mode of ["light", "dark"]) {
      if (mode === "dark") await button("Toggle theme").click();
      await expectToken(launcher, "color", "--text-standard");
      await expectToken(launcher, "background-color", "--interaction-pressed");
      for (const width of [1280, 800, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(hide).toBeInViewport();
        await expectToken(
          drawer.locator("[data-terminal-version]"),
          "background-color",
          "--bg-panel",
        );
        if (width === 1280) {
          const splash = drawer.locator("[data-terminal-splash]");
          const spawns = await page.evaluate(() =>
            window.terminalPanel.spawns(),
          );
          await page.evaluate(() => window.terminalPanel.holdClose());
          try {
            await restart.click();
            await expect
              .poll(() =>
                page.evaluate(() => window.terminalPanel.closePending()),
              )
              .toBe(true);
            await page.clock.pauseAt(
              new Date(`2026-01-01T0${mode === "light" ? 1 : 2}:00:00Z`),
            );
          } finally {
            await page.evaluate(() => window.terminalPanel.releaseClose());
          }
          // The restarted shell queues its first write on the paused clock
          // right after it spawns; run the clock only once that spawn is seen.
          await expect
            .poll(() => page.evaluate(() => window.terminalPanel.spawns()))
            .toBe(spawns + 1);
          await page.clock.runFor(50);
          await expect(splash.locator("canvas")).toBeVisible();
          const bounds = await splash.evaluate((el) => {
            const frame = el.getBoundingClientRect();
            const art = el.querySelector("canvas").getBoundingClientRect();
            return (
              art.top >= frame.top - 1 &&
              art.bottom <= frame.bottom + 1 &&
              art.left >= frame.left - 1 &&
              art.right <= frame.right + 1
            );
          });
          expect(bounds).toBe(true);
          await page.clock.resume();
        }
        await expect(restart).toBeInViewport();
        expect(
          await drawer.evaluate((el) => el.scrollWidth),
        ).toBeLessThanOrEqual(width);
        const header = drawer.locator(".panel-header");
        expect(
          await header.evaluate((el) => el.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: test.info().outputPath(`terminal-panel-${mode}-${width}.png`),
        });
      }
    }
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await hide.click();
    await expect(drawer).toHaveCount(0);
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    await expect(launcher).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await launcher.click();
    expect(
      await page.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);
    await button("Toggle close failure").click();
    await button("End session").click();
    await expect(page.getByRole("alert")).toContainText("Fixture close failed");
    await button("Toggle close failure").click();
    await button("End session").focus();
    await page.keyboard.press("Enter");
    await expect(button("Start session")).toBeVisible();
    await expect(hide).toBeFocused();
    await button("Start session").click();
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await page.evaluate(() => window.terminalPanel.holdClose());
    await button("End session").focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.terminalPanel.closePending()))
      .toBe(true);
    await button("Toggle theme").focus(); // The user leaves while close is pending.
    await page.evaluate(() => window.terminalPanel.releaseClose());
    await expect(button("Start session")).toBeVisible();
    await expect(button("Toggle theme")).toBeFocused();
    await button("Start session").click();
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-panel.html?short`,
    );
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "2"),
    );
    await launcher.click();
    await expect(drawer.locator(".xterm-rows")).toContainText("FIXTURE");
    await expect(hide).toBeInViewport();
    await expect(restart).toBeInViewport();
    await expect(button("End session")).toBeInViewport();
    expect(
      await drawer
        .locator(".xterm-scrollable-element")
        .evaluate((el) => el.clientHeight),
    ).toBeGreaterThanOrEqual(78); // two 26px mono lines at 1.5 leading
    expect(
      await drawer.locator(".panel-header").evaluate((el) => el.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: test.info().outputPath("terminal-short-200.png"),
    });
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("real xterm replies survive scope switches while stale input and retired writes are fenced", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-session.html`;
    const open = async () => {
      await page.goto(url);
      await expect
        .poll(() => page.evaluate(() => window.terminalSession?.ready()))
        .toBe(true);
      await page.evaluate(() => window.terminalSession.mount());
    };
    const generated = () =>
      page.evaluate(() => window.terminalSession.generated);
    const writes = () => page.evaluate(() => window.terminalSession.writes);
    const reply = (data) => ({ owner: "retained-owner", id: "pty-1", data });
    const output = async (data) => {
      await expect
        .poll(() => page.evaluate(() => window.terminalSession.reading()))
        .toBe(true);
      await page.evaluate((data) => window.terminalSession.output(data), data);
    };
    await open();
    await page.evaluate(() => window.terminalSession.holdWrites());
    await page.keyboard.type("a");
    await expect.poll(writes).toEqual([reply("a")]);
    await page.keyboard.type("b"); // Queued user input must be rechecked at dispatch.
    await output("\x1b[6n");
    await expect
      .poll(generated)
      .toContainEqual({ data: "\x1b[1;1R", source: "reply" });
    await page.evaluate(() => {
      window.terminalSession.switchScope();
      window.terminalSession.releaseWrites();
    });
    await expect.poll(writes).toEqual([reply("a"), reply("\x1b[1;1R")]);
    // The old view can still receive events before React unmounts it.
    await page.keyboard.type("x");
    await page.evaluate(() => window.terminalSession.staleInput());
    await expect
      .poll(generated)
      .toContainEqual({ data: "STALE_PASTE", source: "user" });
    await page.evaluate(() => window.terminalSession.detach());
    await output("\x1b[5n\x1b[6n");
    await expect
      .poll(writes)
      .toEqual([
        reply("a"),
        reply("\x1b[1;1R"),
        reply("\x1b[0n"),
        reply("\x1b[1;1R"),
      ]);
    const before = await generated();
    await page.evaluate(() => window.terminalSession.staleInput());
    expect(await generated()).toEqual(before); // Detached keyboard/paste never enters the session.
    await page.evaluate(() => window.terminalSession.dispose());

    // Receipt and dispatch are distinct fences: returning to A must not revive
    // input received in B. A real parser reply behind it proves the queue drained.
    await open();
    await page.evaluate(() => window.terminalSession.holdWrites());
    await page.keyboard.type("a");
    await expect.poll(writes).toEqual([reply("a")]);
    await page.evaluate(() => window.terminalSession.switchScope());
    await page.keyboard.type("x");
    await page.evaluate(() => window.terminalSession.staleInput());
    await expect
      .poll(generated)
      .toContainEqual({ data: "STALE_PASTE", source: "user" });
    await page.evaluate(() => window.terminalSession.restoreScope());
    await output("\x1b[5n");
    await expect
      .poll(generated)
      .toContainEqual({ data: "\x1b[0n", source: "reply" });
    await page.evaluate(() => window.terminalSession.releaseWrites());
    await expect.poll(writes).toEqual([reply("a"), reply("\x1b[0n")]);
    await page.evaluate(() => window.terminalSession.dispose());

    for (const operation of ["end", "dispose"]) {
      await open();
      await page.evaluate(() => window.terminalSession.holdWrites());
      await page.keyboard.type("a");
      await expect.poll(writes).toEqual([reply("a")]);
      await output("\x1b[6n");
      await expect
        .poll(generated)
        .toContainEqual({ data: "\x1b[1;1R", source: "reply" });
      await page.evaluate(async (operation) => {
        const ending = window.terminalSession[operation]();
        window.terminalSession.releaseWrites();
        await ending;
      }, operation);
      expect(await writes()).toEqual([reply("a")]);
      if (operation === "end")
        await page.evaluate(() => window.terminalSession.dispose());
    }
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

// Browser-only: real xterm's capture-phase handler can write PTY bytes and stop
// propagation. Exercise the actual bundled registration, store and dispatcher.
test("focused terminal follows rebind, restore and reset without swallowing the chord or writing it to the shell", async ({
  page,
}) => {
  // Force the non-Apple mapping even on macOS: Ctrl+U is xterm's line kill.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", {
      value: "Linux x86_64",
      configurable: true,
    }),
  );
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-panel.html`,
    );
    const launcher = page.getByRole("button", {
      name: "Toggle channel terminal",
      exact: true,
    });
    const drawer = page.getByRole("region", { name: "Terminal drawer" });
    const textarea = drawer.locator(".xterm-helper-textarea");
    const settings = page.getByRole("button", {
      name: "Shortcut settings",
      exact: true,
    });
    const row = page.getByRole("article", {
      name: "Toggle channel terminal",
      exact: true,
    });
    await settings.click();
    await row
      .getByRole("button", {
        name: "Change shortcut for Toggle channel terminal",
        exact: true,
      })
      .click();
    await page.keyboard.press("Control+u");
    await expect(row.getByText("Modified")).toBeVisible();
    await launcher.click();
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await expect(textarea).toBeFocused();
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => window.terminalPanel.written()))
      .toBe("hello\u0003");
    const toggles = await page.evaluate(() => window.terminalPanel.toggles());
    await page.keyboard.press("Control+u");
    await expect(drawer).toHaveCount(0);
    expect(await page.evaluate(() => window.terminalPanel.toggles())).toBe(
      toggles + 1,
    );
    expect(await page.evaluate(() => window.terminalPanel.written())).toBe(
      "hello\u0003",
    );
    await launcher.click();
    await expect(textarea).toBeFocused();
    expect(
      await page.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);
    await page.keyboard.press("Control+j"); // Old binding now reaches the shell.
    await expect
      .poll(() => page.evaluate(() => window.terminalPanel.written()))
      .toBe("hello\u0003\n");
    await row
      .getByRole("button", {
        name: "Reset shortcut for Toggle channel terminal",
        exact: true,
      })
      .click();
    await textarea.focus();
    await page.keyboard.press("Control+u"); // Reset releases Ctrl+U again.
    await expect
      .poll(() => page.evaluate(() => window.terminalPanel.written()))
      .toBe("hello\u0003\n\u0015");
    await page.keyboard.press("Control+j");
    await expect(drawer).toHaveCount(0);
    // Restore from device storage; modified Enter would otherwise write CR.
    await row
      .getByRole("button", {
        name: "Change shortcut for Toggle channel terminal",
        exact: true,
      })
      .click();
    await page.keyboard.press("Control+Enter");
    await expect(row.getByRole("alert")).toContainText("Saved");
    await page.reload();
    await launcher.click();
    await expect(textarea).toBeFocused();
    await page.keyboard.press("Control+Enter");
    await expect(drawer).toHaveCount(0);
    expect(await page.evaluate(() => window.terminalPanel.toggles())).toBe(2);
    expect(await page.evaluate(() => window.terminalPanel.written())).toBe("");
    // Compatibility mappings must still yield to a live app binding.
    await settings.click();
    await row
      .getByRole("button", {
        name: "Change shortcut for Toggle channel terminal",
        exact: true,
      })
      .click();
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(row.locator("kbd")).toHaveAttribute("data-binding", "Alt+←");
    await launcher.click();
    await expect(textarea).toBeFocused();
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(drawer).toHaveCount(0);
    expect(await page.evaluate(() => window.terminalPanel.written())).toBe("");
    await page.evaluate(() => window.terminalPanel.dispose());
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
