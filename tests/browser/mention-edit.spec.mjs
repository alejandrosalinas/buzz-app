import { test, expect } from "./source-fixture.mjs";

test("editing selected name plus pasting same name cannot transfer notification to pasted prose", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const first = await page.evaluate(() => window.mentionFixture.first);
  const input = page.getByRole("textbox", { name: "Message #General" });
  const cases = [
    {
      start: 6,
      end: 6,
      inserted: "bee @Honey",
      expected: "@Honeybee @Honey",
      notify: false,
    },
    {
      start: 0,
      end: 6,
      inserted: "@Honey",
      expected: "@Honey",
      notify: false,
    },
    {
      start: 0,
      end: 6,
      inserted: "bee @Honey",
      expected: "bee @Honey",
      notify: false,
    },
    {
      start: 0,
      end: 0,
      inserted: "Hi ",
      expected: "Hi @Honey",
      notify: true,
    },
    {
      start: 7,
      end: 7,
      inserted: "help",
      expected: "@Honey help",
      notify: true,
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page
      .getByRole("button")
      .and(page.locator(`[data-mention-choice="${first}"]`))
      .click();
    await expect(input).toHaveJSProperty("value", "@Honey ");
    // The picker restores focus/caret on the next animation frame. Let that
    // finish before establishing the selection this edit is meant to replace.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(input).toBeFocused();
    await input.evaluate(
      (e, { start, end }) => e.setSelectionRange(start, end),
      scenario,
    );
    await page.keyboard.insertText(scenario.inserted);
    await expect(input).toHaveJSProperty(
      "value",
      scenario.expected + (scenario.expected.endsWith("help") ? "" : " "),
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(index + 1);
    const event = await page.evaluate(
      (index) => window.mentionFixture.publications[index],
      index,
    );
    expect(event.content).toBe(scenario.expected);
    expect(event.tags.filter(([tag]) => tag === "p")).toEqual(
      scenario.notify ? [["p", first]] : [],
    );
  }
});

// Native contenteditable selection and React's no-op render boundary need a browser.
test("typing after an unchanged agent prefill does not consume a stale caret command", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const agent = await page.evaluate(() => window.mentionFixture.second);
  const input = page.getByRole("textbox", { name: "Message #General" });
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await page
    .getByRole("button")
    .and(page.locator(`[data-mention-choice="${agent}"]`))
    .click();
  await expect(input).toHaveJSProperty("value", "@Honey ");
  await expect(input).toBeFocused();
  // Repeat with the exact same next draft. Clicking Send or refocusing the
  // editor would introduce another render and conceal the pending command.
  for (const count of [1, 2]) {
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(count);
    await expect(input).toHaveJSProperty("value", "@Honey ");
  }
  for (const [index, character] of [..."nice"].entries()) {
    await page.keyboard.type(character);
    await expect(input).toHaveJSProperty(
      "value",
      `@Honey ${"nice".slice(0, index + 1)}`,
    );
    await expect(input).toHaveJSProperty("selectionStart", 8 + index);
    await expect(input).toHaveJSProperty("selectionEnd", 8 + index);
  }
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(3);
  const sent = await page.evaluate(() => window.mentionFixture.publications[2]);
  expect(sent.content).toBe("@Honey nice");
  expect(sent.tags.filter(([tag]) => tag === "p")).toEqual([["p", agent]]);
  await expect(input).toHaveJSProperty("value", "@Honey ");
});

// Reproduce focus returning between the native DOM edit and input/selectionchange.
// Normal locator typing focuses first and cannot exercise this browser boundary.
test("focus during the first edit after send preserves the advanced native caret", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const agent = await page.evaluate(() => window.mentionFixture.second);
  const input = page.getByRole("textbox", { name: "Message #General" });
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await page
    .getByRole("button")
    .and(page.locator(`[data-mention-choice="${agent}"]`))
    .click();
  await expect(input).toHaveJSProperty("value", "@Honey ");
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  await expect(input).toHaveJSProperty("value", "@Honey ");

  const firstEdit = await input.evaluate((el) => {
    el.setSelectionRange(el.value.length, el.value.length);
    // Retain the native edit point before blur releases the DOM caret. The
    // modeled insertion below must not depend on a blurred editor owning it.
    const selection = getSelection();
    const node = selection.focusNode;
    const offset = selection.focusOffset;
    if (!(node instanceof Text))
      throw new Error("Expected editable text caret");
    el.blur();
    const focusedBefore = document.activeElement === el;
    const allowed = el.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: "n",
      }),
    );
    if (!allowed) throw new Error("First insertion was prevented");
    // Model the native insertion while unfocused. Advancing the real browser
    // Selection returns focus synchronously, before the queued selectionchange.
    node.insertData(offset, "n");
    selection.setBaseAndExtent(node, offset + 1, node, offset + 1);
    const result = {
      focusedBefore,
      focusedAfter: document.activeElement === el,
      // Native DOM edits reach the transaction model at the mutation-observer
      // boundary. Inspect the native caret here, then the model below.
      caret: [offset + 1, selection.focusOffset],
    };
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "n",
      }),
    );
    return result;
  });
  expect(firstEdit).toEqual({
    focusedBefore: false,
    focusedAfter: true,
    caret: [2, 2],
  });
  await expect(input).toHaveJSProperty("value", "@Honey n");
  await expect(input).toHaveJSProperty("selectionStart", 8);
  // Do not refocus with a locator action: continue from that native selection.
  await page.keyboard.type("ice");
  await expect(input).toHaveJSProperty("value", "@Honey nice");
  await expect(input).toHaveJSProperty("selectionStart", 11);
  await expect(input).toHaveJSProperty("selectionEnd", 11);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(2);
  const sent = await page.evaluate(() => window.mentionFixture.publications[1]);
  expect(sent.content).toBe("@Honey nice");
  expect(sent.tags.filter(([tag]) => tag === "p")).toEqual([["p", agent]]);
  await expect(input).toHaveJSProperty("value", "@Honey ");
});

// A retained editor keeps its native caret when focused again, so the seed
// must leave it after the mention, not where reset() put it.
test("a seed that lands while the composer is unfocused leaves the caret after the mention", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html?test-controls");
  const input = page.getByRole("textbox", { name: "Message #General" });
  // Focused once, the composer keeps its caret when focused again.
  await input.click();
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Load history" }).click();
  await expect(input).toHaveJSProperty("value", "@Honey ");
  await expect(input).not.toBeFocused();
  await page.getByRole("button", { name: "Focus composer" }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("selectionStart", 7);
  await page.keyboard.type("hi");
  await expect(input).toHaveJSProperty("value", "@Honey hi");
});
