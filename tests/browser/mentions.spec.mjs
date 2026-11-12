import { npubEncode } from "nostr-tools/nip19";
import { test, expect } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";
import { animationsSettled } from "./animations.mjs";

let server, directory, fixture;
// A dev server serves this fixture as about 1,600 modules, and each test
// started its own. On a busy runner the first navigation took longer than the
// navigation timeout to load them, so build the page once and serve the bundle.
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-mentions-"));
  const config = {
    root,
    configFile: false,
    envDir: false,
    logLevel: "error",
    plugins: [react()],
    // Development React, as the dev server served, keeps StrictMode's checks.
    define: {
      "import.meta.env.DEV": "true",
      "process.env.NODE_ENV": '"development"',
    },
    build: {
      rollupOptions: { input: join(root, "tests/fixtures/mentions.html") },
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
  fixture = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("settings-enabled mentions fixture renders the composer and preference", async ({
  page,
}) => {
  // This optional fixture mode mounts the real Vite entry point, not an exported component.
  const errors = watchPageErrors(page);
  await page.goto(`${fixture}?settings`);
  await expect(page.getByRole("textbox")).toBeVisible();
  await expect(page.getByText("Remember mentioned agents")).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});

test("actual composer selects namesakes by exact key, publishes channel/reply tags, and asks before mentioning removed members", async ({
  page,
}) => {
  // This journey exercises one-message recipients; prefill-on has separate coverage.
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  const errors = watchPageErrors(page);
  await page.goto(`${fixture}?test-controls`);
  await expect(page.getByRole("textbox")).toBeVisible();
  const keys = await page.evaluate(() => ({
    first: window.mentionFixture.first,
    second: window.mentionFixture.second,
  }));
  // Real layout is required: the popup follows the whole composer, including
  // multiple lines of text, rather than the trigger's toolbar position.
  const expectComposerAnchor = async (popup) => {
    await expect(popup).toHaveClass(/buzz-popover/);
    expect(
      await popup.evaluate((element) => element.closest("form") === null),
    ).toBe(true);
    await expect(popup).toHaveCSS("border-radius", "24px");
    await expect
      .poll(() =>
        popup.evaluate((element) => {
          const composer = document.querySelector("form");
          return (
            composer.getBoundingClientRect().top -
            element.getBoundingClientRect().bottom
          );
        }),
      )
      .toBe(4);
  };
  const choose = async (key) => {
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Mention a member or agent",
    });
    const search = picker.getByRole("searchbox");
    // Both fixture keys are Honey namesakes.
    await search.fill("Honey");
    // Rows no longer spell out their key; each carries it instead.
    const row = picker
      .getByRole("button")
      .and(page.locator(`[data-mention-choice="${key}"]`));
    await expect(row).toBeVisible();
    await expect(search).toBeFocused();
    await expectComposerAnchor(picker);
    await expect(picker).toHaveCSS("width", "380px");
    expect((await picker.boundingBox()).height).toBeLessThanOrEqual(360);
    await search.fill("");
    const choice = row;
    const index = await choice.evaluate((node) =>
      [...node.parentElement.querySelectorAll("[data-mention-choice]")].indexOf(
        node,
      ),
    );
    // Focus stays in search; the first row starts highlighted.
    for (let step = 0; step < index; step++) await search.press("ArrowDown");
    await expect(choice).toHaveAttribute("data-selected", "true");
    await expect(search).toBeFocused();
    await expect(choice).toHaveCSS("padding", "8px");
    await expect(choice.locator(".buzz-avatar")).toHaveCSS("width", "40px");
    await search.press("ArrowUp");
    await search.press("ArrowDown");
    await expect(choice).toHaveAttribute("data-selected", "true");
    await search.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole("textbox")).toBeFocused();
  };
  const order = () =>
    page
      .getByRole("button", { name: /^(Mention a member|Emoji and GIFS)$/ })
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      );
  await expect.poll(order).toEqual(["Mention a member", "Emoji and GIFS"]);
  // Browser-only contract: native shadow search and React search share their
  // shape, typography, clear target and alignment in both appearance modes.
  const searchAppearance = async (field) => {
    // Main animates field focus; compare settled appearance, not an arbitrary frame.
    await animationsSettled(field, { subtree: true });
    return field.evaluate((element) => {
      const nativeInput = element.querySelector("input");
      // Both the React and vendor search use the shared field boundary.
      const style = getComputedStyle(
        element.matches(".search-field") ? element : nativeInput,
      );
      const input = getComputedStyle(nativeInput);
      const clear = element.querySelector("button");
      return {
        height: style.height,
        radius: style.borderRadius,
        background: style.backgroundColor,
        border: style.border,
        color: input.color,
        font: input.font,
        clear: clear && {
          width: getComputedStyle(clear).width,
          height: getComputedStyle(clear).height,
          radius: getComputedStyle(clear).borderRadius,
          color: getComputedStyle(clear).color,
        },
      };
    });
  };
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    const mention = page.getByRole("dialog", {
      name: "Mention a member or agent",
    });
    const row = mention
      .getByRole("button")
      .and(page.locator(`[data-mention-choice="${keys.first}"]`));
    await expect(row).toHaveCSS("padding", "8px");
    // The first row opens highlighted, so Enter picks it.
    const highlighted = mention.locator("[data-mention-choice][data-selected]");
    await expect(highlighted).toHaveCount(1);
    await expect(
      mention.locator("[data-mention-choice]").first(),
    ).toHaveAttribute("data-selected", "true");
    await expect(highlighted).toHaveCSS(
      "background-color",
      mode === "light" ? "rgb(218, 218, 218)" : "rgb(64, 64, 64)",
    );
    await mention.getByRole("searchbox").fill("");
    const empty = await searchAppearance(mention.locator(".search-field"));
    await mention.getByRole("searchbox").fill("Honey");
    const filled = await searchAppearance(mention.locator(".search-field"));
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    const emojiField = page.locator("em-emoji-picker .search");
    await expect(emojiField.getByRole("searchbox")).toBeFocused();
    expect(await searchAppearance(emojiField)).toEqual(empty);
    const emojiSearch = emojiField.getByRole("searchbox");
    await emojiSearch.fill("face");
    await expect(
      emojiField.getByRole("button", { name: "Clear", exact: true }),
    ).toBeVisible();
    expect(await searchAppearance(emojiField)).toEqual(filled);
    await emojiField
      .getByRole("button", { name: "Clear", exact: true })
      .click();
    await expect(emojiSearch).toHaveValue("");
    await expect(emojiSearch).toBeFocused();
    await emojiSearch.press("Escape");
  }
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "light";
  });
  const input = page.getByRole("textbox", { name: "Message #General" });
  await choose(keys.first);
  await expect(input.locator(".inline-chip")).toHaveText("@Honey");
  await choose(keys.second);
  const labels = ["@Honey", "@Honey (agent)"];
  await expect(input.locator(".inline-chip")).toHaveText(labels);
  // The complete choice set already qualifies the agent before selection.
  await expect(input.locator("[data-reveal]")).toHaveCount(0);
  // Copy serializes authored source, not the visible namesake qualifiers;
  // the HTML flavor carries each identity.
  await input.focus();
  await input.press("ControlOrMeta+a");
  await expect(input.locator("[data-editor-selected]")).toHaveCount(2);
  const copied = await input.evaluate((element) => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
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
  expect(copied).toEqual({
    text: "@Honey @Honey ",
    html: `<div data-buzz-copy="composer"><p><a href="nostr:${npubEncode(keys.first)}">@Honey</a> <a href="nostr:${npubEncode(keys.second)}">@Honey</a> </p></div>`,
  });
  await input.press("ArrowRight");
  // Typing can rebuild editor portals; it must not replay the reveal.
  await input.press("x");
  await expect(input).toHaveJSProperty("value", "@Honey @Honey x");
  await expect(input.locator("[data-reveal]")).toHaveCount(0);
  await input.press("Backspace");
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The first chip's visual expansion must not change native source offsets.
  await input.focus();
  await input.evaluate((element) => element.setSelectionRange(7, 13));
  await input.press("Backspace");
  await expect(input).toHaveJSProperty("value", "@Honey  ");
  await expect(input.locator(".inline-chip")).toHaveText("@Honey");
  await input.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(input).toHaveJSProperty("value", "@Honey @Honey ");
  await expect(input.locator(".inline-chip")).toHaveText(labels);
  await expect(input.locator("[data-reveal]")).toHaveCount(0);
  // Undo restores the former selected range. Continue the original typing journey at its end.
  await input.evaluate((element) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  // The merged toolbar must preserve exact recipients while the new picker
  // inserts Unicode and follows the host mode without recreating the draft.
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await page
    .getByRole("button", { name: "Emoji and GIFS", exact: true })
    .click();
  const search = page.getByRole("searchbox", { name: "Search" });
  await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  await expectComposerAnchor(
    page.getByRole("dialog", { name: "Emoji picker" }),
  );
  await search.fill("grinning");
  await page.getByRole("button", { name: "😀", exact: true }).click();
  await expect(input).toHaveJSProperty("value", "@Honey @Honey 😀");
  await expect(page.getByRole("textbox").locator(".inline-chip")).toHaveCount(
    2,
  );
  const chip = input.locator(".inline-chip").first();
  const recipients = page.getByRole("region", {
    name: "Explicit mentions",
  });
  await expect(recipients.getByRole("button")).toHaveCount(2);
  await expect(
    recipients.locator('.buzz-avatar[data-avatar-shape="circle"]'),
  ).toHaveCount(1);
  await expect(
    recipients.locator('.buzz-avatar[data-avatar-shape="squircle"]'),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      recipients
        .locator("img")
        .evaluateAll(
          (images) =>
            images.length === 2 &&
            images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true);
  const mentionTool = page.getByRole("button", {
    name: "Mention a member",
    exact: true,
  });
  const emojiTool = page.getByRole("button", {
    name: "Emoji and GIFS",
    exact: true,
  });
  await mentionTool.focus();
  for (const recipient of await recipients.getByRole("button").all()) {
    await page.keyboard.press("Tab");
    await expect(recipient).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(emojiTool).toBeFocused();
  const chipRoles = await chip.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--affordance-subtle)";
    probe.style.color = "var(--text-standard)";
    element.append(probe);
    const style = getComputedStyle(probe);
    const roles = { background: style.backgroundColor, text: style.color };
    probe.remove();
    return roles;
  });
  await expect(chip).toHaveCSS("background-color", chipRoles.background);
  await expect(chip).toHaveCSS("color", chipRoles.text);
  // Browser-only: shared chip geometry across themes/widths, without a
  // nested focus target or hover preview competing with native editing.
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const width of [360, 768, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      const bounds = await input.boundingBox();
      for (const item of await input.locator(".inline-chip").all()) {
        const box = await item.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      }
      // Avatars stay beside @, before Emoji, even on the narrow composer.
      const mentionBox = await mentionTool.boundingBox();
      const recipientsBox = await recipients.boundingBox();
      const emojiBox = await emojiTool.boundingBox();
      expect(recipientsBox.x).toBeGreaterThanOrEqual(
        mentionBox.x + mentionBox.width,
      );
      expect(recipientsBox.x + recipientsBox.width).toBeLessThanOrEqual(
        emojiBox.x,
      );
      expect(Math.abs(recipientsBox.y - mentionBox.y)).toBeLessThanOrEqual(2);
      await expect(input).toHaveJSProperty("value", "@Honey @Honey 😀");
    }
  }
  await chip.hover();
  await chip.click();
  await expect(input.locator("button, a, [tabindex], [title]")).toHaveCount(0);
  await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
  await input.press("Escape");
  await page.screenshot({
    path: test.info().outputPath("mention-recipients.png"),
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mentionFixture.publications.length ||
          window.mentionFixture
            .outbox()
            .map((item) => ({ state: item.delivery, error: item.error })),
      ),
    )
    .toBe(1);
  const first = await page.evaluate(
    () => window.mentionFixture.publications[0],
  );
  expect(first.content).toBe("@Honey @Honey 😀");
  expect(first.tags.filter(([tag]) => tag === "p")).toEqual([
    ["p", keys.first],
    ["p", keys.second],
  ]);
  expect(first.tags.filter(([tag]) => tag === "h")).toEqual([["h", "c"]]);
  await page.getByRole("button", { name: "Toggle thread" }).click();
  await choose(keys.second);
  await page.evaluate(() =>
    window.mentionFixture.change("disable", "buzz.mentions"),
  );
  await expect(
    page.getByRole("button", { name: "Mention a member", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox").locator(".inline-chip")).toHaveCount(
    1,
  );
  await expect(recipients.getByRole("button")).toHaveCount(1);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(2);
  const reply = await page.evaluate(
    () => window.mentionFixture.publications[1],
  );
  expect(reply.tags).toContainEqual(["e", "a".repeat(64), "", "reply"]);
  expect(reply.tags.filter(([tag]) => tag === "p")).toEqual([
    ["p", keys.second],
  ]);
  await page.evaluate(() =>
    window.mentionFixture.change("enable", "buzz.mentions"),
  );
  await expect.poll(order).toEqual(["Mention a member", "Emoji and GIFS"]);
  await choose(keys.first);
  await page
    .getByRole("button", { name: "Remove first Honey", exact: true })
    .click();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  // An untyped channel is an ordinary channel: the removed member is now
  // outside it, so the sender chooses. Closing keeps the draft unsent.
  const outside = page.getByRole("dialog", {
    name: "Mention people outside this channel?",
  });
  await expect(outside).toContainText("Honey is not in this channel.");
  await outside.getByRole("button", { name: "Close" }).click();
  await expect(outside).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Reply to thread" }),
  ).toHaveJSProperty("value", "@Honey ");
  expect(
    await page.evaluate(() => window.mentionFixture.publications.length),
  ).toBe(2);
  // A child layout effect sees disabled DOM before parent command props refresh.
  // Both commands must fail, even with the previous render's enabled closures.
  // The outside-person prompt above also disabled the composer once.
  const before = await page.evaluate(
    () => window.mentionFixture.disabledCalls.length,
  );
  await page
    .getByRole("button", { name: "Toggle disabled", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Reply to thread" }),
  ).toBeDisabled();
  await expect(recipients.getByRole("button")).toBeDisabled();
  expect(
    await page.evaluate(() => window.mentionFixture.disabledCalls),
  ).toEqual(
    Array(before + 1).fill({
      inputDisabled: true,
      text: false,
      mention: false,
    }),
  );
  await expect(
    page.getByRole("textbox", { name: "Reply to thread" }),
  ).toHaveJSProperty("value", "@Honey ");
  await expect(page.getByRole("textbox").locator(".inline-chip")).toHaveCount(
    1,
  );
  await expect(recipients.getByRole("button")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Toggle disabled", exact: true })
    .click();
  await choose(keys.second);
  await expect(
    page.getByRole("textbox", { name: "Reply to thread" }),
  ).toHaveJSProperty("value", "@Honey @Honey ");
  await recipients
    .getByRole("button", {
      name: `Remove mention Honey ${keys.first}`,
      exact: true,
    })
    .click();
  await expect(page.getByRole("textbox")).toHaveJSProperty(
    "value",
    "@Honey @Honey ",
  );
  await expect(recipients.getByRole("button")).toHaveCount(1);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(3);
  const afterRemoval = await page.evaluate(() =>
    window.mentionFixture.publications.at(-1),
  );
  expect(afterRemoval.content).toBe("@Honey @Honey");
  expect(afterRemoval.tags.filter(([tag]) => tag === "p")).toEqual([
    ["p", keys.second],
  ]);
  expect(errors.unexplained()).toEqual([]);
});

test("selected mentions inside code remain visible through draft restore and channel/reply publication", async ({
  page,
}) => {
  // Browser-only boundary: real picker insertion and source selection in a code literal.
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  await page.goto(`${fixture}?test-controls`);
  await expect(page.getByRole("textbox")).toBeVisible();
  const keys = await page.evaluate(() => [
    window.mentionFixture.first,
    window.mentionFixture.second,
  ]);
  const input = page.getByRole("textbox");
  const labels = ["@Honey", "@Honey (agent)"];
  for (const reply of [false, true]) {
    await input.fill("` `");
    await input.evaluate((element) => element.setSelectionRange(1, 1));
    for (const key of keys) {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Mention a member or agent" })
        .getByRole("button")
        .and(page.locator(`[data-mention-choice="${key}"]`))
        .click();
    }
    const source = "`@Honey @Honey  `";
    await expect(input).toHaveJSProperty("value", source);
    await expect(input.locator(".inline-chip")).toHaveText(labels);
    // Retargeting unmounts the destination's composer and restores its saved draft.
    await page.getByRole("button", { name: "Toggle thread" }).click();
    await expect(input).toHaveJSProperty("value", "");
    await page.getByRole("button", { name: "Toggle thread" }).click();
    await expect(input).toHaveJSProperty("value", source);
    await expect(input.locator(".inline-chip")).toHaveText(labels);
    await input.focus();
    await input.press("ControlOrMeta+a");
    const copied = await input.evaluate((element) => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return clipboardData.getData("text/plain");
    });
    expect(copied).toBe(source);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(reply ? 2 : 1);
    const sent = await page.evaluate(() =>
      window.mentionFixture.publications.at(-1),
    );
    expect(sent.content).toBe(source);
    expect(sent.tags.filter(([tag]) => tag === "p")).toEqual(
      keys.map((key) => ["p", key]),
    );
    expect(sent.tags.filter(([tag]) => tag === "h")).toEqual([["h", "c"]]);
    expect(sent.tags.filter(([tag]) => tag === "e")).toEqual(
      reply ? [["e", "a".repeat(64), "", "reply"]] : [],
    );
    if (!reply)
      await page.getByRole("button", { name: "Toggle thread" }).click();
  }
});

// Browser-only contract: qualifiers remain visible without hover at touch width.
test("namesake recipient qualifiers remain visible on touch after live name changes", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${fixture}?identity-names`);
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    const keys = await page.evaluate(() => [
      window.mentionFixture.first,
      window.mentionFixture.second,
    ]);
    const choose = async (key) => {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .tap();
      await page
        .getByRole("dialog", { name: "Mention a member or agent" })
        .getByRole("button")
        .and(page.locator(`[data-mention-choice="${key}"]`))
        .tap();
    };
    await page.evaluate(() => window.mentionFixture.collide(false));
    await choose(keys[0]);
    await choose(keys[1]);
    const input = page.getByRole("textbox");
    const chips = input.locator(".inline-chip");
    const labels = keys.map((key) => `@Honey · ${npubEncode(key).slice(-4)}`);
    await expect(chips).toHaveText(["@Honey", "@Other Honey"]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Hold each reveal when its qualifier renders, before any frame. WebKit can
    // dispatch animationstart after the 220ms reveal has already finished.
    await page.evaluate(() => {
      window.qualifierReveals = [];
      new MutationObserver(() => {
        for (const element of document.querySelectorAll(
          ".inline-chip-qualifier[data-reveal]",
        )) {
          if (window.qualifierReveals.includes(element)) continue;
          // getAnimations() flushes style, so the reveal animation exists.
          const reveals = element
            .getAnimations()
            .filter(
              (animation) =>
                animation.animationName === "inline-chip-qualifier-reveal",
            );
          if (!reveals.length) continue;
          window.qualifierReveals.push(element);
          for (const animation of reveals) {
            animation.pause();
            animation.currentTime = 0;
          }
        }
      }).observe(document.body, {
        attributes: true,
        attributeFilter: ["data-reveal"],
        childList: true,
        subtree: true,
      });
    });
    await page.evaluate(() => window.mentionFixture.collide(true));
    await expect
      .poll(() => page.evaluate(() => window.qualifierReveals.length))
      .toBe(2);
    const widths = await input
      .locator(".inline-chip-qualifier")
      .first()
      .evaluate((element) => {
        const animation = element.getAnimations()[0];
        const start = element.getBoundingClientRect().width;
        const duration = animation.effect.getTiming().duration;
        animation.currentTime = duration / 2;
        const middle = element.getBoundingClientRect().width;
        animation.finish();
        return { start, middle, end: element.getBoundingClientRect().width };
      });
    expect(widths.start).toBeLessThan(widths.middle);
    expect(widths.middle).toBeLessThan(widths.end);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(input.locator(".inline-chip-qualifier").first()).toHaveCSS(
      "animation-name",
      "none",
    );
    await expect(chips).toHaveText(labels);
    for (const chip of await chips.all()) {
      await expect(chip).toBeVisible();
      expect(
        await chip.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth;
        }),
      ).toBe(true);
    }
    await page.screenshot({
      path: test.info().outputPath("recipient-qualifiers-touch.png"),
    });
    await input.evaluate((el) =>
      el.setSelectionRange(el.value.indexOf("@", 1), el.value.trimEnd().length),
    );
    await input.press("Backspace");
    await expect(chips).toHaveText([labels[0]]);
    await choose(keys[1]);
    await expect(chips).toHaveText(labels);
    await page.evaluate(() => window.mentionFixture.collide(false));
    await expect(chips).toHaveText(["@Honey", "@Other Honey"]);
    await expect(input).toHaveJSProperty("value", "@Honey @Honey  ");
    await page.getByRole("button", { name: "Send message", exact: true }).tap();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(1);
    const notified = await page.evaluate(() =>
      window.mentionFixture.publications[0].tags
        .filter((tag) => tag[0] === "p")
        .map((tag) => tag[1]),
    );
    expect(notified.sort()).toEqual(keys.sort());
  } finally {
    await context.close();
  }
});
