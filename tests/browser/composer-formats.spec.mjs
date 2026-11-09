import { test, expect } from "./source-fixture.mjs";

// Browser contracts: native caret/keystrokes, toolbar focus, DOM deletion and
// hidden spoiler paint/hit testing. Format/serialization matrices stay in Vitest.
async function composer(page) {
  await page.goto("/tests/fixtures/link-messages.html");
  const input = page.getByRole("textbox", {
    name: "Message #design",
    exact: true,
  });
  await input.fill("");
  await page
    .getByRole("button", { name: "Toggle formatting", exact: true })
    .click();
  return input;
}

test("native code corrections preserve explicit mode but clearing the span exits it", async ({
  page,
}) => {
  const input = await composer(page);
  const toggle = page.getByRole("button", {
    name: "Toggle formatting",
    exact: true,
  });
  const close = page.getByRole("button", {
    name: "Close formatting",
    exact: true,
  });
  await expect(toggle).toHaveCount(0);
  // Real rendered sizes must match the close control, not compact attachment actions.
  for (const button of [
    close,
    page.getByRole("button", { name: "Bold", exact: true }),
  ]) {
    await expect(button).toHaveCSS("width", "32px");
    await expect(button).toHaveCSS("height", "32px");
    await expect(button.locator("svg")).toHaveCSS("width", "16px");
  }
  await close.press("Enter");
  await expect(toggle).toBeFocused();
  await toggle.press("Enter");
  await expect(close).toBeFocused();
  await expect(toggle).toHaveCount(0);

  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.keyboard.type("abc");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("d");
  await expect(input.locator("code")).toHaveText("abd");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input.locator("code")).toHaveText("abd");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(input.locator("code")).toHaveText("ab");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("plain");
  await expect(input.locator("code")).toHaveCount(0);
  await input.press("Enter");
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.at(-1).text),
  ).toBe("plain");
});

test("list toolbar, native item splitting and indentation survive reload and send", async ({
  page,
}) => {
  const input = await composer(page);
  await input.fill("one\ntwo");
  await input.evaluate((el) => el.setSelectionRange(0, 7));
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  await input.evaluate((el) => el.setSelectionRange(7, 7));
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("three");
  await page.keyboard.press("Tab");
  await expect(input.locator("ul ul > li")).toHaveText("three");
  await page.getByRole("button", { name: "Ordered list", exact: true }).click();
  await expect(input.locator("ul ol > li")).toHaveText("three");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("outside");
  await expect(input.locator(":scope > p")).toHaveText("outside");
  await page.reload();
  await expect(input.locator("ul > li")).toHaveCount(3);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.at(-1).text),
  ).toBe("- one\n- two\n- three\n\noutside");
});

// Native text input, caret selection and history are browser-owned; the marker
// matrix and completion/IME guards remain in the component tests.
test("typed lists use Enter to split and exit, preserve mentions and send by button", async ({
  page,
}) => {
  const input = await composer(page);
  await expect(input.locator("[data-placeholder]")).toHaveCount(1);
  await input.pressSequentially("3. ");
  await expect(input.locator("ol")).toHaveAttribute("start", "3");
  await expect(input.locator("[data-placeholder]")).toHaveCount(0);
  await input.press("Enter");
  await expect(input.locator("ol")).toHaveCount(0);
  await expect(input.locator("[data-placeholder]")).toHaveCount(1);
  await input.pressSequentially("3. ");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input.locator("ol")).toHaveCount(0);
  await expect.poll(() => input.evaluate((el) => el.value)).toBe("3. ");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await input.pressSequentially("first second");
  await input.evaluate((el) => el.setSelectionRange(6, 6));
  await input.press("Enter");
  await expect(input.locator("ol > li")).toHaveText(["first ", "second"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input.locator("ol > li")).toHaveText("first second");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await input.evaluate((el) =>
    el.setSelectionRange(el.value.length, el.value.length),
  );
  await input.press("Enter");
  await input.press("Enter");
  await expect(input.locator(":scope > p")).toHaveCount(1);
  await input.pressSequentially("• ");
  await expect(input.locator("ul > li")).toHaveCount(1);
  await expect(input.locator("[data-placeholder]")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close formatting", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mention Alex Chen", exact: true })
    .click();
  await input.press("Enter");
  await input.pressSequentially("follow up");
  await expect(input.locator("ul > li")).toHaveCount(2);
  // Both Enter presses finished synchronously without submitting the form.
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.length),
  ).toBe(0);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.linkComposerFixture.sent.at(-1)))
    .toEqual({
      text: "3. first \n4. second\n\n- @Alex Chen \n- follow up",
      mentions: ["a".repeat(64)],
    });
});

test("a typed fence opens a code block at once, and the block sends fenced", async ({
  page,
}) => {
  const input = await composer(page);
  await input.pressSequentially("``");
  await expect(input.locator("pre")).toHaveCount(0);
  await input.pressSequentially("`");
  await expect(input.locator("pre code")).toHaveCount(1);
  const value = () => input.evaluate((el) => el.value);
  expect(await value()).toBe("");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input.locator("pre")).toHaveCount(0);
  await expect.poll(value).toBe("```");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(input.locator("pre code")).toHaveCount(1);
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.length),
  ).toBe(0);
  await page.keyboard.type("const answer = 42;");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("answer");
  await expect(input.locator("pre code")).toContainText("answer");
  await input.press("Enter");
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.at(-1).text),
  ).toBe("```\nconst answer = 42;\nanswer\n```");
  await expect(input.locator("pre")).toHaveCount(0);
});

test("caret keys at the end of a composed message never insert a character", async ({
  page,
}) => {
  const input = await composer(page);
  await input.pressSequentially("```");
  await expect(input.locator("pre code")).toHaveCount(1);
  await page.keyboard.type("Hello!");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("acascac");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("a**a** _a_");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("- acacs");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(input.locator("strong")).toHaveText("a");
  await expect(input.locator("em")).toHaveText("a");
  await expect(input.locator("ul > li")).toHaveText("acacs");
  const state = () =>
    input.evaluate((el) => ({
      value: el.value,
      codes: [...el.value].map((c) => c.codePointAt(0).toString(16)),
      html: el.innerHTML,
    }));
  const before = await state();
  expect(before.value).toBe("Hello!\nacascac\naa a\nacacs\n");
  for (let i = 0; i < 11; i++) await page.keyboard.press("ArrowRight");
  for (const key of [
    "ArrowLeft",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "Escape",
  ])
    await page.keyboard.press(key);
  await page.keyboard.press("Shift");
  await page.keyboard.press("Meta");
  expect(await state()).toEqual(before);
  // The platform's own text-insertion path (WebKit's insertTextAsync, Chromium's
  // IME commit) handing the composer Right Arrow's raw keyboard-layout
  // translation U+001D, the character the desktop build committed on every
  // press, or AppKit's function-key character for the key U+F703, is refused
  // before the DOM changes, and typing continues as before.
  await input.evaluate((el) =>
    el.setSelectionRange(el.value.length, el.value.length),
  );
  for (const character of ["\u001D", "\uF703"]) {
    await page.keyboard.insertText(character);
    expect(await state(), JSON.stringify(character)).toEqual(before);
  }
  await page.keyboard.type("!");
  await expect
    .poll(() => input.evaluate((el) => el.value))
    .toBe(`${before.value}!`);
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.length),
  ).toBe(0);
});

test("sent spoilers hide content and links behind a keyboard-accessible reduced-motion sparkle", async ({
  page,
}) => {
  const input = await composer(page);
  await input.fill("secret https://example.com/path");
  // Collapsed selection means the entire draft, including the URL, becomes a spoiler.
  await page.getByRole("button", { name: "Spoiler", exact: true }).click();
  await input.press("Enter");
  const preview = page.getByRole("region", { name: "Sent message preview" });
  const reveal = preview.getByRole("button", {
    name: "Reveal spoiler",
    exact: true,
  });
  await expect(reveal).toBeVisible();
  await expect(preview.locator("[inert]")).not.toBeVisible();
  await expect(preview.getByRole("link")).toHaveCount(0);
  expect(
    await reveal.evaluate(
      (el) => getComputedStyle(el, "::before").animationName,
    ),
  ).toMatch(/spoiler-twinkle/);
  const transform = () =>
    reveal.evaluate((el) => getComputedStyle(el, "::before").transform);
  const initialTransform = await transform();
  expect(initialTransform).not.toBe("none");
  await expect.poll(transform).not.toBe(initialTransform);
  await reveal.focus();
  await page.keyboard.press("Space");
  await expect(preview.getByRole("link")).toBeVisible();
  await expect(preview.getByText("secret", { exact: false })).toBeVisible();
  await preview
    .getByRole("button", { name: "Hide spoiler", exact: true })
    .click({ position: { x: 3, y: 3 } });
  await expect(preview.getByRole("link")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await reveal.evaluate(
      (el) => getComputedStyle(el, "::before").animationName,
    ),
  ).toBe("none");
  expect(await transform()).toBe("none");
});

// Browser-only: flex sizing and native horizontal overflow are not modeled by jsdom.
test("formatting keeps composer and send control geometry stable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 863, height: 863 });
  await page.goto("/tests/fixtures/product-ui.html");
  const playground = page.getByRole("region", { name: "Composer playground" });
  const toggle = playground.getByRole("button", {
    name: "Toggle formatting",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  const form = playground.getByRole("form");
  const send = form.getByRole("button", { name: "Send message", exact: true });
  // The catalogue page itself scrolls when editor focus returns. Compare document
  // coordinates so this assertion measures layout, not that native focus scroll.
  const box = (locator) =>
    locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      };
    });
  const before = await box(form);
  const sendBefore = await box(send);
  await toggle.click();
  const close = playground.getByRole("button", {
    name: "Close formatting",
    exact: true,
  });
  await expect(close).toBeVisible();
  await expect.poll(() => box(form)).toEqual(before);
  await expect.poll(() => box(send)).toEqual(sendBefore);
  await close.click();
  await expect(toggle).toBeVisible();
  await expect.poll(() => box(form)).toEqual(before);
  await expect.poll(() => box(send)).toEqual(sendBefore);
});

test("caret keys at the end of a composed message never insert a character, and a caret key reported as a control character still moves the caret", async ({
  page,
}) => {
  const input = await composer(page);
  await page.keyboard.type("Hello!");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("world");
  const state = () =>
    input.evaluate((el) => ({
      value: el.value,
      codes: [...el.value].map((c) => c.codePointAt(0).toString(16)),
      html: el.innerHTML,
    }));
  const before = await state();
  expect(before.value).toBe("Hello!\nworld");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  for (const key of [
    "ArrowLeft",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "Escape",
  ])
    await page.keyboard.press(key);
  await page.keyboard.press("Shift");
  await page.keyboard.press("Meta");
  expect(await state()).toEqual(before);
  // The platform's own text-insertion path (WebKit's insertTextAsync, Chromium's
  // IME commit) handing the composer Right Arrow's raw keyboard-layout
  // translation U+001D, the character the desktop build committed on every
  // press, or AppKit's function-key character for the key U+F703, is refused
  // before the DOM changes, and typing continues as before.
  await input.evaluate((el) =>
    el.setSelectionRange(el.value.length, el.value.length),
  );
  for (const character of ["\u001D", "\uF703"]) {
    await page.keyboard.insertText(character);
    expect(await state(), JSON.stringify(character)).toEqual(before);
  }
  // The keydown such a press arrives as: `key` is the control character while
  // `code` and the legacy key code still name the key. The composer claims it
  // and moves the caret through the browser's own caret motion.
  const moved = await input.evaluate((el) => {
    el.setSelectionRange(1, 1);
    const prevented = !el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "\u001D",
        code: "ArrowRight",
        keyCode: 39,
        bubbles: true,
        cancelable: true,
      }),
    );
    return { prevented, start: el.selectionStart, end: el.selectionEnd };
  });
  expect(moved).toEqual({ prevented: true, start: 2, end: 2 });
  expect(await state()).toEqual(before);
  const lowered = await input.evaluate((el) => {
    const prevented = !el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "\u001F",
        code: "ArrowDown",
        keyCode: 40,
        bubbles: true,
        cancelable: true,
      }),
    );
    return { prevented, start: el.selectionStart, end: el.selectionEnd };
  });
  expect(lowered.prevented).toBe(true);
  expect(lowered.start).toBe(lowered.end);
  // Down from the first line lands on the second, at the nearest column.
  expect(lowered.start).toBeGreaterThanOrEqual("Hello!\n".length);
  expect(lowered.start).toBeLessThanOrEqual("Hello!\nworld".length);
  expect(await state()).toEqual(before);
  await input.evaluate((el) =>
    el.setSelectionRange(el.value.length, el.value.length),
  );
  await page.keyboard.type("!");
  await expect
    .poll(() => input.evaluate((el) => el.value))
    .toBe("Hello!\nworld!");
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.length),
  ).toBe(0);
});

test("the channel placeholder's icon overlay shows only while the editor is empty", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/link-messages.html");
  const input = page.getByRole("textbox", {
    name: "Message #design",
    exact: true,
  });
  const overlay = page.locator('[aria-hidden="true"][data-name="design"]');
  const nativePlaceholder = () =>
    input.evaluate((node) => {
      const paragraph = node.querySelector("[data-placeholder]");
      return paragraph && getComputedStyle(paragraph, "::before").visibility;
    });
  await input.fill("");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator("svg.tabler-icon-hash")).toBeVisible();
  expect(await nativePlaceholder()).toBe("hidden");
  await input.pressSequentially("hello");
  await expect(overlay).toBeHidden();
  for (let i = 0; i < 5; i++) await input.press("Backspace");
  await expect(input).toHaveText("");
  await expect(overlay).toBeVisible();
  expect(await nativePlaceholder()).toBe("hidden");
});
