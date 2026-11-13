import { npubEncode } from "nostr-tools/nip19";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true });

// The timeline shows a raw message link under its channel's name, but only an
// authored label copies.
const link = `buzz://message?channel=alpha&id=${"b".repeat(64)}`;
const linkHtml = link.replace("&", "&amp;");
const anchors = (viewer) =>
  `Ping <a href="nostr:${npubEncode(viewer)}">@Fixture Reader</a> about <a href="buzz://channel/beta">#Beta</a>, <a href="${linkHtml}">${linkHtml}</a> and <a href="${linkHtml}">Alpha</a>`;

/** Deliver both flavors at once, as a real clipboard does. */
const pasteInto = (input, payload) =>
  input.evaluate((element, { text, html }) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    clipboardData.setData("text/html", html);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, payload);

// Browser-only contract: an engine-native pointer selection copied from the
// timeline reaches the composer through real clipboard flavors, DOMParser and
// the live session's mention candidates, then round-trips composer → composer.
// A `> ` typed with native keys then quotes the line with its link-renderer
// chips. Serializer, promotion and marker cases live in the colocated Vitest
// files.
test("pasting copied messages into the composer restores chips, the recipient and links", async ({
  page,
  app,
  browserName,
}) => {
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    `Ping @Fixture Reader about #Beta, ${link} and [Alpha](${link})`,
    true,
    true,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(
    row
      .locator("p")
      .getByRole("button", { name: "View Fixture Reader profile" }),
  ).toBeVisible();
  await expect(row.getByRole("link", { name: "#Beta" })).toBeVisible();
  await expect(row.getByRole("link", { name: "Alpha" })).toHaveCount(2);
  const paragraph = row.locator("p").first();
  const box = await paragraph.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await page.evaluate(() => {
    window.__copyPayload = undefined;
    document.addEventListener(
      "copy",
      (event) => {
        window.__copyPayload = {
          text: event.clipboardData?.getData("text/plain"),
          html: event.clipboardData?.getData("text/html"),
        };
      },
      { once: true },
    );
  });
  // See timeline-copy.spec.mjs for the WebKit copy command.
  if (browserName === "webkit")
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  else await page.keyboard.press("ControlOrMeta+c");
  const timeline = {
    text: `Ping @Fixture Reader about #Beta, ${link} and Alpha (${link})`,
    html: `<div data-buzz-copy="timeline"><p>${anchors(app.viewer)}</p></div>`,
  };
  await expect
    .poll(() => page.evaluate(() => window.__copyPayload))
    .toEqual(timeline);

  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const recipients = page.getByRole("region", { name: "Explicit mentions" });
  const source = `Ping @Fixture Reader about [#Beta](buzz://channel/beta), ${link} and [Alpha](${link})`;
  await input.click();
  await pasteInto(input, timeline);
  await expect(input).toHaveJSProperty("value", source);
  await expect(input.locator("[data-source]")).toHaveCount(4);
  await expect(input.locator(".inline-chip").first()).toHaveText(
    "@Fixture Reader",
  );
  await expect(recipients).toBeVisible();

  // Composer → composer keeps the recipient through the composer's own flavors.
  const composer = await input.evaluate((element) => {
    element.setSelectionRange(0, element.value.length);
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
  // text/plain stays Markdown source except for identity and channel locators.
  expect(composer).toEqual({
    text: `Ping @Fixture Reader about #Beta, ${link} and [Alpha](${link})`,
    html: `<div data-buzz-copy="composer"><p>${anchors(app.viewer)}</p></div>`,
  });
  await input.fill("");
  await expect(recipients).toBeHidden();
  await pasteInto(input, composer);
  await expect(input).toHaveJSProperty("value", source);
  await expect(recipients).toBeVisible();

  // Native `> ` typed before the pasted line quotes it, chips and all.
  await input.evaluate((element) => element.setSelectionRange(0, 0));
  await input.pressSequentially("> ");
  const quote = input.locator(":scope > blockquote");
  await expect(quote.locator("[data-source]")).toHaveCount(4);
  await expect(quote.locator("[data-link-renderer]").first()).toBeVisible();
  await expect(input).toHaveJSProperty("value", source);
  await expect(recipients).toBeVisible();

  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  const published = app.report.publications[0].event;
  expect(published.content).toBe(`> ${source}`);
  expect(published.tags).toContainEqual(["p", app.viewer]);

  // One representative renderer → clipboard → editor → signed-send round trip.
  // The detailed syntax matrix belongs to the colocated component tests.
  const blocks =
    "- one\n- two\n\n3. first\n\n> quoted\n\na ||secret|| b\n\n```sh\necho hi\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |";
  const structured = app.append("primary", "alpha", blocks);
  const structuredRow = page.locator(
    `[data-channel-timeline] [data-message-id="${structured.id}"]`,
  );
  await expect(structuredRow.locator("table")).toBeVisible();
  // The spoiler stays masked: its inert content must still copy.
  await expect(
    structuredRow.getByRole("button", { name: "Reveal spoiler" }),
  ).toBeVisible();
  const payload = await structuredRow.locator("ul").evaluate((list) => {
    const content = list.parentElement;
    const range = document.createRange();
    range.selectNodeContents(content);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    content.dispatchEvent(
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
  expect(payload.text).toBe(
    "one\ntwo\n\nfirst\n\nquoted\n\na ||secret|| b\n\necho hi\n\na\tb\n1\t2",
  );
  await expect(input).toHaveJSProperty("value", "");
  await pasteInto(input, payload);
  // The engine's DOMParser hands the composer its own blocks, not their source.
  await expect(input.locator("ul li")).toHaveCount(2);
  await expect(input.locator('ol[start="3"] li, blockquote, pre')).toHaveCount(
    3,
  );
  await expect(input.locator("[data-spoiler]")).toHaveText("secret");
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(2);
  expect(app.report.publications[1].event.content).toBe(
    blocks.replace(/\| a \| b \|[\s\S]*$/, "a\tb\n1\t2"),
  );

  // A real picker-produced token carries Markdown escapes, unlike timeline HTML.
  await expect(input).toHaveJSProperty("value", "");
  await input.pressSequentially("#Bet");
  await page
    .getByRole("listbox", { name: "Channel suggestions" })
    .getByRole("option", { name: "Beta", exact: true })
    .click();
  const channelCopy = await input.evaluate((element) => {
    element.setSelectionRange(0, element.value.length);
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
  expect(channelCopy.text).toBe("#Beta ");
  await input.fill("");
  await pasteInto(input, channelCopy);
  await expect(input.locator("[data-link-renderer]")).toHaveText("Beta");
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(3);
  expect(app.report.publications[2].event.content).toBe(
    "[#Beta](buzz://channel/beta)",
  );
});

// Browser-only contract: each engine's native triple-click range. On a
// one-heading message it ends in the next row, past the empty reaction row,
// yet copies the heading alone, which pastes into the current line. The range
// shapes this crosses are modelled in selection-copy.test.tsx.
test("a triple-clicked heading message pastes into the current line", async ({
  page,
  app,
  browserName,
}) => {
  await open(page, app);
  const event = app.append("primary", "alpha", "## Title");
  app.append("primary", "alpha", "next");
  const heading = page
    .locator(`[data-channel-timeline] [data-message-id="${event.id}"]`)
    .getByRole("heading", { name: "Title" });
  await expect(page.getByText("next", { exact: true })).toBeVisible();
  await heading.click({ clickCount: 3 });
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("Title");
  await page.evaluate(() => {
    window.__copyPayload = undefined;
    document.addEventListener(
      "copy",
      (event) => {
        window.__copyPayload = {
          text: event.clipboardData?.getData("text/plain"),
          html: event.clipboardData?.getData("text/html"),
        };
      },
      { once: true },
    );
  });
  // See timeline-copy.spec.mjs for the WebKit copy command.
  if (browserName === "webkit")
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  else await page.keyboard.press("ControlOrMeta+c");
  const copied = {
    text: "Title",
    html: '<div data-buzz-copy="timeline"><h2>Title</h2></div>',
  };
  await expect
    .poll(() => page.evaluate(() => window.__copyPayload))
    .toEqual(copied);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.click();
  await input.pressSequentially("foo");
  await pasteInto(input, copied);
  await expect(input).toHaveJSProperty("value", "foo## Title");
});

// Browser integration: external clipboard HTML paints a labelled link in the
// actual composer and survives publication through the session.
test("external linked text stays linked in the composer and sent message", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.click();
  await pasteInto(input, {
    text: "Read :wave: the guide",
    html: '<p>Read <img alt=":wave:" src="https://example.com/emoji.png"> <a href="https://example.com/guide">the guide</a></p>',
  });
  await expect(input).toHaveJSProperty(
    "value",
    "Read :wave: [the guide](https://example.com/guide)",
  );
  await expect(input.locator("[data-link-renderer]")).toHaveText("the guide");
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  expect(app.report.publications[0].event.content).toBe(
    "Read :wave: [the guide](https://example.com/guide)",
  );
});

// Browser integration: WebKit offers the picture office apps copy beside
// text as an image file. The form's attachment capture and the editor must
// both read it as the text's rendering on the prose, raw and code paths.
// Keeping it when no plain text could replace it, and other file pastes, are
// covered in composer-clipboard.test.ts and composer-attachments.spec.mjs.
test("copied office text pastes as text, not its picture", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const attachments = page.getByRole("region", {
    name: "Attachments",
    exact: true,
  });
  const cells = "Q3\t12\nQ4\t15";
  const paste = (raw = false) =>
    input.evaluate(
      (element, { cells, raw }) => {
        if (raw) element.dispatchEvent(new Event("buzz:paste-plain"));
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", cells);
        clipboardData.setData(
          "text/html",
          "<table><tr><td>Q3</td><td>12</td></tr><tr><td>Q4</td><td>15</td></tr></table>",
        );
        clipboardData.items.add(
          new File(["png"], "image.png", { type: "image/png" }),
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      },
      { cells, raw },
    );
  await input.click();
  await paste();
  await expect(input).toHaveJSProperty("value", cells);
  await input.fill("");
  await paste(true);
  await expect(input).toHaveJSProperty("value", cells);
  await input.fill("");
  await input.pressSequentially("```");
  await expect(input.locator("pre code")).toHaveCount(1);
  await paste();
  await expect(input.locator("pre code")).toHaveText(cells);
  await expect(attachments).toHaveCount(0);
});

// A long paste paints as text before its links become chips, then keeps
// one undo step for the whole paste.
test("a long pasted text with links shows before its chips", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const text = Array.from(
    { length: 40 },
    (_, line) =>
      `Line ${line} of the notes links https://example.com/notes/${line} for review.`,
  ).join("\n");
  await input.click();
  await input.pressSequentially("Notes: ");
  const pasted = await input.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return {
      value: element.value,
      chips: element.querySelectorAll("[data-source]").length,
    };
  }, text);
  expect(pasted).toEqual({ value: `Notes: ${text}`, chips: 0 });
  await expect(input.locator("[data-source]")).toHaveCount(40);
  await expect(input).toHaveJSProperty("value", `Notes: ${text}`);
  // The caret stays after the pasted text once its chips render.
  expect(
    await input.evaluate((element) => {
      const caret = getSelection()?.getRangeAt(0);
      const after = document.createRange();
      after.setStart(caret.endContainer, caret.endOffset);
      after.setEnd(element, element.childNodes.length);
      return caret.collapsed && after.toString();
    }),
  ).toBe("");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "Notes: ");
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveJSProperty("value", `Notes: ${text}`);
  await expect(input.locator("[data-source]")).toHaveCount(40);
});

// Pasted identity links become recipients in the paste's own transaction,
// in a long paste and while an earlier long paste's chips are still pending.
test("a long paste keeps identity links as recipients", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const recipients = page.getByRole("region", { name: "Explicit mentions" });
  const filler = Array.from(
    { length: 20 },
    (_, line) =>
      `Line ${line} of the notes links https://example.com/notes/${line} for review.`,
  ).join("\n");
  const identity = `[@Fixture Reader](nostr:${npubEncode(app.viewer)}) `;
  const paste = (texts) =>
    input.evaluate((element, texts) => {
      for (const text of texts) {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", text);
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      }
      // A promoted recipient's token carries the mention as its source.
      return !!element.querySelector('[data-source="@Fixture Reader"]');
    }, texts);
  await input.click();
  expect(await paste([`${filler}\n${identity}`])).toBe(true);
  await expect(recipients).toBeVisible();
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "");
  await expect(recipients).toBeHidden();

  // The second paste lands before the first one's deferred chips.
  expect(await paste([filler, identity])).toBe(true);
  await expect(input.locator("[data-source]")).toHaveCount(21);
  await expect(recipients).toBeVisible();
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", filler);
  await expect(recipients).toBeHidden();
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "");
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveJSProperty("value", filler);
  await input.press("ControlOrMeta+Shift+z");
  await expect(input.locator(".inline-chip")).toHaveText("@Fixture Reader");
  await expect(recipients).toBeVisible();
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  expect(app.report.publications[0].event.tags).toContainEqual([
    "p",
    app.viewer,
  ]);
});

// Chips still pending from a long paste stay out of the next edit's undo
// step, so undo and redo walk both pastes in order.
test("undo and redo walk pastes made before deferred chips render", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const long = (name) =>
    Array.from(
      { length: 20 },
      (_, line) =>
        `${name} line ${line} links https://example.com/${name}/${line} for review.`,
    ).join("\n");
  const first = long("first");
  await input.click();
  for (const second of [`\n${long("second")}`, " https://example.com/short"]) {
    await input.evaluate(
      (element, texts) => {
        for (const text of texts) {
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", text);
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData,
            }),
          );
        }
      },
      [first, second],
    );
    const chips = second.length > 100 ? 40 : 21;
    await expect(input.locator("[data-source]")).toHaveCount(chips);
    await input.press("ControlOrMeta+z");
    await expect(input).toHaveJSProperty("value", first);
    await input.press("ControlOrMeta+z");
    await expect(input).toHaveJSProperty("value", "");
    await input.press("ControlOrMeta+Shift+z");
    await expect(input).toHaveJSProperty("value", first);
    await input.press("ControlOrMeta+Shift+z");
    await expect(input).toHaveJSProperty("value", `${first}${second}`);
    await expect(input.locator("[data-source]")).toHaveCount(chips);
    await input.fill("");
  }
});

// Input before a long paste's chips render adopts them first, so editing,
// pasting an identity inside the pasted text, and undo and redo behave as
// they do once the chips have rendered.
test("input before deferred chips render edits and undoes as usual", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const recipients = page.getByRole("region", { name: "Explicit mentions" });
  const long = Array.from(
    { length: 20 },
    (_, line) =>
      `Line ${line} links https://example.com/review/${line} for notes.`,
  ).join("\n");
  const identity = `[@Fixture Reader](nostr:${npubEncode(app.viewer)}) `;
  // Paste with the paint that renders the chips held until `release`.
  const paste = (texts) =>
    input.evaluate((element, texts) => {
      if (!window.heldFrames) {
        window.heldFrames = [];
        window.paintFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = (callback) =>
          window.heldFrames.push(callback);
      }
      for (const text of texts) {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", text);
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      }
    }, texts);
  const release = () =>
    page.evaluate(() => {
      window.requestAnimationFrame = window.paintFrame;
      for (const callback of window.heldFrames) callback(0);
      window.heldFrames = undefined;
    });
  const pending = () => expect(input.locator("[data-source]")).toHaveCount(0);
  await input.click();

  // Replace the last link and the text after it.
  await paste([long]);
  await pending();
  for (let key = 0; key < 12; key++) await input.press("Shift+ArrowLeft");
  await page.keyboard.type("changed");
  await release();
  const changed = long.replace(
    "https://example.com/review/19 for notes.",
    "changed",
  );
  await expect(input).toHaveJSProperty("value", changed);
  await expect(input.locator("[data-source]")).toHaveCount(19);
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", long);
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "");
  await input.press("ControlOrMeta+Shift+z");
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveJSProperty("value", changed);
  await input.fill("");

  // Delete inside the pasted text.
  await paste([long]);
  await pending();
  await input.press("ArrowUp");
  await input.press("Backspace");
  await release();
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", long);
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "");
  await input.fill("");

  // Undo and redo both pastes before either renders its chips.
  await paste([long, " https://example.com/short"]);
  await input.press("ControlOrMeta+z");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "");
  await input.press("ControlOrMeta+Shift+z");
  await input.press("ControlOrMeta+Shift+z");
  await release();
  await expect(input).toHaveJSProperty(
    "value",
    `${long} https://example.com/short`,
  );
  await expect(input.locator("[data-source]")).toHaveCount(21);
  await input.press("ControlOrMeta+z");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "");

  // Complete a link before the pasted text; its chip shortens the document.
  await input.fill(`[${"a".repeat(2000)}](`);
  await input.press("End");
  await paste([`https://example.com) ${"https://example.org/x ".repeat(60)}`]);
  await expect(input.locator("[data-source]")).toHaveCount(1);
  await release();
  await expect(input.locator("[data-source]")).toHaveCount(61);
  await input.fill("");

  // Paste an identity inside the pasted text.
  await paste([long]);
  await pending();
  await input.press("ArrowUp");
  await paste([identity]);
  await release();
  await expect(
    input.locator(".inline-chip", { hasText: "@Fixture Reader" }),
  ).toHaveCount(1);
  await expect(recipients).toBeVisible();
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  expect(app.report.publications[0].event.tags).toContainEqual([
    "p",
    app.viewer,
  ]);
});

// A long paste joined onto a link or a mention changes them in its own undo
// step, even though its inner chips render after the next paint.
test("undoing a long paste restores the link and mention it joined", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const recipients = page.getByRole("region", { name: "Explicit mentions" });
  const tail = ` and ${"more notes ".repeat(110)}`;
  const paste = (text) =>
    input.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    }, text);
  await input.click();
  await input.pressSequentially("see https://exa");
  await paste(`mple.com${tail}`);
  await expect(input).toHaveJSProperty(
    "value",
    `see https://example.com${tail}`,
  );
  await expect(input.locator("[data-source]")).toHaveCount(1);
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "see https://exa");
  await expect(input.locator("[data-source]")).toHaveCount(0);
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveJSProperty(
    "value",
    `see https://example.com${tail}`,
  );

  await input.fill("");
  await paste(`[@Fixture Reader](nostr:${npubEncode(app.viewer)})`);
  await expect(recipients).toBeVisible();
  // Text joined onto the name ends the mention.
  await paste(`s${tail}`);
  await expect(recipients).toBeHidden();
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "@Fixture Reader");
  await expect(recipients).toBeVisible();
  await input.press("ControlOrMeta+Shift+z");
  await expect(recipients).toBeHidden();
  await input.press("ControlOrMeta+z");
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  expect(app.report.publications[0].event.tags).toContainEqual([
    "p",
    app.viewer,
  ]);
});

// Browser integration: a native paste event over a selection reaches
// the editor's link path, renders the anchor and publishes the linked label.
test("pasting a URL over selected text links it in the composer and sent message", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.click();
  await input.pressSequentially("Check the release notes before Friday");
  await input.evaluate((element) => element.setSelectionRange(10, 23));
  await expect
    .poll(() =>
      input.evaluate((element) =>
        element.value.slice(element.selectionStart, element.selectionEnd),
      ),
    )
    .toBe("release notes");
  await pasteInto(input, {
    text: "https://example.com/release-notes",
    html: "",
  });
  // The link is an editor mark on the selected words, so the label stays text
  // and the composer renders the anchor itself rather than a source chip.
  await expect(
    input.getByRole("link", { name: "release notes" }),
  ).toHaveAttribute("href", "https://example.com/release-notes");
  await expect(input).toHaveJSProperty(
    "value",
    "Check the release notes before Friday",
  );
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  expect(app.report.publications[0].event.content).toBe(
    "Check the [release notes](https://example.com/release-notes) before Friday",
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${app.report.publications[0].event.id}"]`,
  );
  await expect(row.getByRole("link", { name: "release notes" })).toBeVisible();
});

// Browser-only: the engine's own Ctrl+Shift+V command (Chromium's
// PasteAndMatchStyle, WebKitGTK's PasteAsPlainText) fires a text/plain-only
// paste after the real keydown, which must replace the selection verbatim
// rather than link it, and must not send. macOS engines bind no such key; the
// desktop app's Edit menu supplies it there. The flavor/selection matrix lives
// in EditableInput.test.tsx.
test("Ctrl+Shift+V pastes plain text over the selection without sending", async ({
  page,
  app,
  browserName,
}) => {
  test.skip(
    process.platform === "darwin",
    "macOS engines bind no native Ctrl/Cmd+Shift+V command",
  );
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.click();
  await input.pressSequentially("Check the release notes before Friday");
  await input.evaluate((element) => element.setSelectionRange(10, 23));
  // Ordinary paste would link the selection with this URL and drop the break.
  const text = "https://example.com/release-notes\n";
  // Put both flavors on the engine's clipboard through a native copy command.
  await page.evaluate((text) => {
    document.addEventListener(
      "copy",
      (event) => {
        event.stopImmediatePropagation();
        event.preventDefault();
        event.clipboardData?.setData("text/plain", text);
        event.clipboardData?.setData(
          "text/html",
          '<div data-buzz-copy="timeline"><p><strong>Read</strong> <a href="https://example.com/release-notes">notes</a></p><ul><li><p>first</p></li></ul></div>',
        );
      },
      { once: true, capture: true },
    );
  }, text);
  // See timeline-copy.spec.mjs for the WebKit copy command.
  if (browserName === "webkit")
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  else await page.keyboard.press("Control+c");
  const original = "Check the release notes before Friday";
  const pasted = `Check the ${text} before Friday`;
  await page.keyboard.press("Control+Shift+V");
  await expect(input).toHaveJSProperty("value", pasted);
  await expect(input.locator("strong, ul")).toHaveCount(0);
  expect(app.report.publications).toHaveLength(0);
  await page.keyboard.press("Control+z");
  await expect(input).toHaveJSProperty("value", original);
  await page.keyboard.press("Control+Shift+z");
  await expect(input).toHaveJSProperty("value", pasted);
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  expect(app.report.publications[0].event.content).toBe(pasted);
});
