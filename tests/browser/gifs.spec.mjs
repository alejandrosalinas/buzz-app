import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

const gifResult = (id, title, height) => ({
  id,
  type: "gif",
  slug: title.toLowerCase(),
  title,
  file: {
    md: {
      gif: {
        url: `https://gif.fixture.invalid/${id}.gif`,
        width: 320,
        height,
        size: 1200,
      },
    },
    sm: {
      webp: {
        url: `https://gif.fixture.invalid/${id}.webp`,
        width: 160,
        height: height / 2,
        size: 600,
      },
    },
  },
});

const fulfillGifInfo = (route) =>
  route.fulfill({
    json: {
      policy: null,
      supported_extensions: ["buzz-gif"],
      gif: { provider: "klipy", search: "/gifs/search" },
    },
  });

const fulfillGifImage = (route) =>
  route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#8aa6b4"/></svg>',
  });

// Settled bounds miss a one-frame overlap of outgoing and incoming panels.
// Samples run in requestAnimationFrame, which precedes every rendering update,
// so each frame the browser can paint is recorded. A busy WebKit renderer can
// skip every update while the switch settles; stop() therefore waits for the
// next update and records the settled frame instead of reading a lone sample.
const watchPickerLayout = (picker) =>
  picker.evaluateHandle((popup) => {
    const frames = [];
    let finish;
    const sample = () => {
      const bounds = popup.getBoundingClientRect();
      frames.push({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        visiblePanels: [...popup.querySelectorAll('[role="tabpanel"]')].filter(
          (panel) => panel.getBoundingClientRect().height > 0,
        ).length,
      });
      if (finish) finish(frames);
      else requestAnimationFrame(sample);
    };
    sample();
    return {
      stop() {
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    };
  });

const expectStablePickerLayout = async (watch) => {
  const frames = await watch.evaluate((observer) => observer.stop());
  await watch.dispose();
  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames) {
    expect(frame.visiblePanels).toBe(1);
    for (const dimension of ["x", "y", "width", "height"])
      expect(frame[dimension]).toBeCloseTo(frames[0][dimension], 0);
  }
};

test.use({ historyCounts: { alpha: 1, beta: 0 } });
test("relay-backed GIF tab searches KLIPY and inserts URL-only media", async ({
  page,
  app,
}, testInfo) => {
  const requests = [];
  let messageSignRequests = 0;
  await page.route("**/api/relay/*/sign", (route) => {
    if (route.request().postDataJSON().kind === 20002) return route.fallback();
    messageSignRequests += 1;
    return route.abort();
  });
  let releaseInfo = () => {};
  const infoReady = new Promise((resolve) => {
    releaseInfo = resolve;
  });
  let infoRequests = 0;
  await page.route("**/api/relay/*/gif-info", async (route) => {
    infoRequests += 1;
    await infoReady;
    await fulfillGifInfo(route);
  });
  await page.route("**/api/relay/*/gifs", async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    await route.fulfill({
      json: {
        result: true,
        data: {
          data: [
            gifResult(1, request.query ? "Hello" : "Trending Hello", 240),
            gifResult(2, "Celebrate", 320),
          ],
        },
      },
    });
  });
  await page.route("https://gif.fixture.invalid/**", fulfillGifImage);

  await page.goto(app.origin);
  await openPage(page, "Messages");
  const draft = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const emojiTrigger = page.getByRole("button", {
    name: "Emoji and GIFS",
    exact: true,
  });
  await draft.fill("unfinished draft");
  await emojiTrigger.click();
  await expect.poll(() => infoRequests).toBeGreaterThan(0);
  const picker = page.getByRole("dialog", { name: "Emoji picker" });
  await expect(emojiTrigger).toHaveAttribute("aria-busy", "true");
  await expect(picker).toBeVisible();
  await expect(page.getByRole("tab", { name: "GIF", exact: true })).toHaveCount(
    0,
  );
  const initialEmojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await expect(initialEmojiSearch).toBeFocused();
  await initialEmojiSearch.fill("face");
  const initialSearchNode = await initialEmojiSearch.elementHandle();
  const initialScroll = picker.locator("em-emoji-picker .scroll");
  await expect(initialScroll.locator(".category button").first()).toBeVisible();
  const beforeScroll = await initialScroll.evaluate((node) => {
    node.scrollTop = 48;
    return node.scrollTop;
  });
  releaseInfo();
  await expect(emojiTrigger).not.toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("tab", { name: "GIF", exact: true }),
  ).toBeVisible();
  await expect(picker).toBeVisible();
  await expect(picker).toHaveCSS("border-radius", "24px");
  await expect(picker).toHaveCSS("border-top-width", "1px");
  await expect(picker).not.toHaveCSS("box-shadow", "none");
  const emojiTab = page.getByRole("tab", { name: "Emoji", exact: true });
  const gifTab = page.getByRole("tab", { name: "GIF", exact: true });
  const emojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await emojiSearch.press("ArrowLeft");
  await expect(emojiSearch).toBeFocused();
  await expect(emojiSearch.locator("..")).toHaveCSS("outline-style", "none");
  const emojiSearchFrame = await emojiSearch.locator("..").boundingBox();
  const emojiTabsBox = await picker.getByRole("tablist").boundingBox();
  expect(emojiSearchFrame.x).toBeCloseTo(emojiTabsBox.x, 1);
  expect(emojiSearchFrame.y - emojiTabsBox.y - emojiTabsBox.height).toBeCloseTo(
    16,
    1,
  );
  await expect(initialScroll).toHaveCSS(
    "scrollbar-color",
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).scrollbarColor),
  );
  const emojiResultsBox = await picker
    .locator("em-emoji-picker .scroll")
    .boundingBox();
  const emojiPickerBox = await picker.boundingBox();
  const emojiFooterBox = await picker
    .locator("em-emoji-picker #nav")
    .boundingBox();
  expect(
    emojiResultsBox.y - emojiSearchFrame.y - emojiSearchFrame.height,
  ).toBeCloseTo(12, 1);
  expect(emojiFooterBox.height).toBeCloseTo(40, 1);
  await expect(emojiSearch).toBeFocused();
  // Discovering GIF support must not replace the focused vendor search.
  expect(await initialSearchNode.evaluate((node) => node.isConnected)).toBe(
    true,
  );
  await expect(emojiSearch).toHaveValue("face");
  expect(await initialScroll.evaluate((node) => node.scrollTop)).toBe(
    beforeScroll,
  );
  await expect(emojiTab).toHaveAttribute("aria-selected", "true");
  await expect(emojiTab).toHaveAttribute("aria-controls", /.+/);
  await expect(
    picker.getByRole("tabpanel", { name: "Emoji", exact: true }),
  ).toBeVisible();
  await emojiSearch.fill("hello");
  // Base UI owns the tab keyboard model; the selected panel focuses its search.
  await emojiTab.focus();
  await emojiTab.press("ArrowRight");
  await expect(gifTab).toBeFocused();
  const switchingToGifs = await watchPickerLayout(picker);
  await gifTab.press("Enter");
  await expect(gifTab).toHaveAttribute("aria-selected", "true");
  await expect(
    picker.getByRole("tabpanel", { name: "GIF", exact: true }),
  ).toBeVisible();
  await expect(
    picker.getByRole("tabpanel", { name: "Emoji", exact: true }),
  ).toHaveCount(0);
  const tabIndicator = picker.locator(".buzz-tabs-indicator");
  await expect(tabIndicator).toHaveCSS("height", "2px");
  const indicatorColor = await tabIndicator.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--affordance-prominent-mark)";
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(tabIndicator).toHaveCSS("background-color", indicatorColor);
  const search = page.getByRole("searchbox", { name: "Search GIFs" });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("hello");
  await expectStablePickerLayout(switchingToGifs);
  // Observe the real key's browser-default boundary, not a guessed network delay.
  await draft.evaluate((input) => {
    window.gifEnter = { prevented: false, submits: 0 };
    input
      .closest("form")
      .addEventListener("submit", () => window.gifEnter.submits++);
  });
  await search.evaluate((input) => {
    window.addEventListener("keydown", (event) => {
      if (event.target === input && event.key === "Enter")
        window.gifEnter.prevented = event.defaultPrevented;
    });
  });
  await search.press("Enter");
  expect(await page.evaluate(() => window.gifEnter)).toEqual({
    prevented: true,
    submits: 0,
  });
  await expect(draft).toHaveJSProperty("value", "unfinished draft");
  expect(messageSignRequests).toBe(0);
  await draft.evaluate((element) => {
    element.value = "";
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
  });
  await expect(draft).toHaveJSProperty("value", "");
  const composer = draft.locator("xpath=ancestor::form");
  const composerBorder = await composer.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.borderColor = "var(--border-standard)";
    element.append(probe);
    const color = getComputedStyle(probe).borderColor;
    probe.remove();
    return color;
  });
  await expect(composer).toHaveCSS("border-top-color", composerBorder);
  await expect(composer).not.toHaveCSS("box-shadow", "none");
  await expect(search).toHaveAttribute("spellcheck", "false");
  await expect(search).toHaveAttribute("autocorrect", "off");
  await expect(search).toHaveAttribute("autocapitalize", "off");
  const searchFrame = search.locator("..");
  await search.press("ArrowLeft");
  await expect(search).toBeFocused();
  await expect(searchFrame).toHaveCSS("outline-style", "none");
  await expect(searchFrame).toHaveClass(/search-field/);
  await expect(searchFrame).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(searchFrame).toHaveCSS("border-top-color", "rgb(128, 128, 128)");
  await expect(search).toHaveCSS("color", "rgb(15, 15, 15)");
  await expect(search).toHaveCSS("font-family", /Inter Variable/);
  const gifSearchPosition = await searchFrame.boundingBox();
  const tabListBox = await picker.getByRole("tablist").boundingBox();
  expect(gifSearchPosition.x).toBeCloseTo(tabListBox.x, 1);
  expect(gifSearchPosition.y - tabListBox.y - tabListBox.height).toBeCloseTo(
    16,
    1,
  );
  expect(gifSearchPosition.width).toBeGreaterThan(0);
  expect(gifSearchPosition.x).toBeGreaterThanOrEqual(
    (await picker.boundingBox()).x,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(tabIndicator).toHaveCSS("transition-duration", "0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(
    page.getByTestId("klipy-gif-grid").getByRole("button"),
  ).toHaveCount(2);
  const gifGridBox = await page.getByTestId("klipy-gif-grid").boundingBox();
  const gifResultGutters = await page
    .getByTestId("klipy-gif-grid")
    .evaluate((grid) => {
      const results = grid.parentElement;
      const resultsBounds = results.getBoundingClientRect();
      const gridBounds = grid.getBoundingClientRect();
      return {
        left: gridBounds.left - resultsBounds.left,
        right: resultsBounds.left + results.clientWidth - gridBounds.right,
      };
    });
  expect(gifResultGutters.left).toBeCloseTo(gifResultGutters.right, 1);
  expect(gifResultGutters.left).toBeCloseTo(12, 1);
  const gifResults = page.getByTestId("klipy-gif-grid").locator("..");
  const gifResultsBox = await gifResults.boundingBox();
  expect(gifResultsBox.y).toBeCloseTo(emojiResultsBox.y, 1);
  expect(gifResultsBox.height).toBeCloseTo(emojiResultsBox.height, 1);
  expect(await picker.boundingBox()).toEqual(emojiPickerBox);
  await expect(gifResults).toHaveCSS("scrollbar-width", "thin");
  await expect(gifResults).toHaveCSS(
    "scrollbar-color",
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).scrollbarColor),
  );
  expect(gifGridBox.y).toBeGreaterThanOrEqual(
    gifSearchPosition.y + gifSearchPosition.height,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    locale: expect.any(String),
    query: "hello",
  });
  await search.fill("celebrate");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ query: "celebrate" });
  const switchingToEmoji = await watchPickerLayout(picker);
  await emojiTab.click();
  await expect(emojiTab).toHaveAttribute("aria-selected", "true");
  const returningEmojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await expect(returningEmojiSearch).toHaveValue("celebrate");
  await expect(returningEmojiSearch).toBeFocused();
  await expect(
    picker.getByRole("tabpanel", { name: "GIF", exact: true }),
  ).toHaveCount(0);
  await expectStablePickerLayout(switchingToEmoji);
  await expect(returningEmojiSearch).toHaveCSS("animation-name", "none");
  const returningEmojiSearchPosition = await returningEmojiSearch
    .locator("..")
    .boundingBox();
  expect(returningEmojiSearchPosition.x).toBeCloseTo(emojiSearchFrame.x, 1);
  expect(returningEmojiSearchPosition.y).toBeCloseTo(emojiSearchFrame.y, 1);
  expect(returningEmojiSearchPosition.width).toBeCloseTo(
    emojiSearchFrame.width,
    1,
  );
  await gifTab.click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("celebrate");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .click();
  await expect(picker).toHaveCount(0);
  await emojiTrigger.click();
  await gifTab.click();
  await expect(search).toHaveValue("celebrate");
  await expect(
    page.getByTestId("klipy-gif-grid").getByRole("button"),
  ).toHaveCount(2);
  const reopenRequests = requests.length;
  expect(requests.at(-1)).toMatchObject({
    locale: expect.any(String),
    query: "celebrate",
  });
  await search.fill("hello");
  await expect.poll(() => requests.length).toBe(reopenRequests + 1);
  expect(requests.at(-1)).toMatchObject({ query: "hello" });
  const clear = picker.getByRole("button", {
    name: "Clear search gifs",
    exact: true,
  });
  await expect(clear).toHaveCSS("width", "32px");
  await expect(clear).toHaveCSS("height", "32px");
  await clear.focus();
  await expect(clear).toHaveCSS("outline-style", "none");
  await clear.press("Enter");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  // Clearing starts a debounced request. Old results have the same count, so
  // wait for the cleared query's rendered result before clicking its replacement.
  const trending = page.getByRole("button", {
    name: "Choose Trending Hello",
    exact: true,
  });
  await expect(trending).toBeVisible();
  await expect(
    page.getByTestId("klipy-gif-grid").getByRole("button"),
  ).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("gif-picker.png") });

  await trending.click();
  // A picked GIF joins the attachment row, where it sends, not the prose.
  await expect(
    page
      .getByRole("region", { name: "Attachments", exact: true })
      .getByRole("button", { name: "Remove Trending Hello", exact: true }),
  ).toBeAttached();
  await expect(draft).toHaveJSProperty("value", "");
  await expect(
    page.getByRole("searchbox", { name: "Search GIFs" }),
  ).toHaveCount(0);
  expect(app.report.unexpected).toEqual([]);
});

for (const initial of ["invalid response", "unsupported relay"]) {
  test(`GIF discovery retries after ${initial}`, async ({ page, app }) => {
    let attempts = 0;
    let releaseFirst;
    const firstResponse = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    await page.route("**/api/relay/*/gif-info", async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await firstResponse;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: initial === "invalid response" ? "{" : "{}",
        });
        return;
      }
      await fulfillGifInfo(route);
    });

    await page.goto(app.origin);
    await openPage(page, "Messages");
    const trigger = page.getByRole("button", {
      name: "Emoji and GIFS",
      exact: true,
    });
    const gifTab = page.getByRole("tab", { name: "GIF", exact: true });

    // Hover/focus may prefetch. Hold that response through the opening click
    // so the click cannot accidentally become a retry of a completed request.
    try {
      await trigger.click();
      await expect.poll(() => attempts).toBe(1);
      await expect(trigger).toHaveAttribute("aria-busy", "true");
    } finally {
      releaseFirst();
    }
    await expect(trigger).not.toHaveAttribute("aria-busy", "true");
    await expect(gifTab).toHaveCount(0);
    await trigger.click();
    await trigger.click();
    await expect.poll(() => attempts).toBe(2);
    await expect(trigger).not.toHaveAttribute("aria-busy", "true");
    await expect(gifTab).toBeVisible();
  });
}

// Browser coverage is needed for focus when an activated Retry button unmounts.
test("GIF shortcut retry keeps keyboard focus through repeated discovery failure", async ({
  page,
  app,
}) => {
  let attempts = 0;
  let releaseRetry;
  const retryResponse = new Promise((resolve) => {
    releaseRetry = resolve;
  });
  await page.route("**/api/relay/*/gif-info", async (route) => {
    attempts += 1;
    if (attempts <= 2) {
      if (attempts === 2) await retryResponse;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{",
      });
    } else await fulfillGifInfo(route);
  });
  await page.route("**/api/relay/*/gifs", (route) =>
    route.fulfill({ json: { result: true, data: { data: [] } } }),
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .focus();
  await page.keyboard.press("ControlOrMeta+g");
  const search = page.getByRole("searchbox", { name: "Search GIFs" });
  const retry = page.getByRole("button", { name: "Retry GIF availability" });
  await expect(retry).toBeVisible();
  await expect(search).toHaveAccessibleDescription(
    "Could not check GIF availability.",
  );
  try {
    await retry.focus();
    await retry.press("Enter");
    await expect.poll(() => attempts).toBe(2);
    await expect(retry).toHaveCount(0);
    await expect(search).toBeFocused();
  } finally {
    releaseRetry();
  }
  await expect(retry).toBeVisible();
  await expect(search).toBeFocused();
  await retry.focus();
  await retry.press("Enter");
  await expect(page.getByText("No GIFs found.", { exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  await expect(search).not.toHaveAttribute("aria-describedby");
});

// WebKit sizes the caret from the line box, so an inline GIF stretched the
// caret to GIF height and floated prose beside it. jsdom has no layout.
// Picked GIFs join the attachment row; GIF Markdown typed or pasted into
// prose, or in a message being edited, still previews in place.
test("a GIF draft preview takes its own row so prose and the caret keep text height", async ({
  page,
  app,
}) => {
  await page.route("https://gif.fixture.invalid/**", fulfillGifImage);
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const draft = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await draft.click();
  await page.keyboard.type("before ");
  await page.keyboard.insertText(
    "![Row Gif](https://gif.fixture.invalid/7.gif)",
  );
  await page.keyboard.type(" after");
  await expect(draft).toHaveJSProperty(
    "value",
    "before ![Row Gif](https://gif.fixture.invalid/7.gif) after",
  );
  const preview = draft.getByRole("img", { name: "Row Gif", exact: true });
  await expect(preview).toHaveJSProperty("naturalWidth", 160);
  const layout = await draft.evaluate((input) => {
    const box = (text) => {
      const node = [...input.querySelectorAll("p")]
        .flatMap((p) => [...p.childNodes])
        .find((child) => child.nodeType === 3 && child.data.includes(text));
      const range = input.ownerDocument.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const gif = input
      .querySelector("[data-gif-preview]")
      .getBoundingClientRect();
    const before = box("before");
    const after = box("after");
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight);
    return {
      beforeBottom: before.bottom,
      beforeHeight: before.height,
      gifTop: gif.top,
      gifBottom: gif.bottom,
      gifHeight: gif.height,
      afterTop: after.top,
      afterHeight: after.height,
      lineHeight,
    };
  });
  expect(layout.gifHeight).toBeGreaterThan(layout.lineHeight * 3);
  expect(layout.beforeBottom).toBeLessThanOrEqual(layout.gifTop);
  expect(layout.afterTop).toBeGreaterThanOrEqual(layout.gifBottom);
  expect(layout.beforeHeight).toBeLessThanOrEqual(layout.lineHeight);
  expect(layout.afterHeight).toBeLessThanOrEqual(layout.lineHeight);
});

test.describe("GIF send roundtrip", () => {
  test.use({
    productionBroker: true,
    // The production broker accepts chat publications through the action-profile lane;
    // that fixture expects thread-unread roots in a populated Alpha history.
    actionProfile: true,
    threadUnread: true,
    historyCounts: { alpha: 20, beta: 0 },
  });

  test("chosen GIF sends as an image attachment instead of visible markdown body text", async ({
    page,
    app,
  }, testInfo) => {
    await page.route("**/api/relay/*/gif-info", fulfillGifInfo);
    await page.route("**/api/relay/*/gifs", (route) =>
      route.fulfill({
        json: {
          result: true,
          data: { data: [gifResult(7, "Roundtrip Gif", 240)] },
        },
      }),
    );
    await page.route("https://gif.fixture.invalid/**", fulfillGifImage);
    const publishReceipts = [];
    await page.route("**/api/relay/*/publish", async (route) => {
      const event = route.request().postDataJSON();
      const response = await route.fetch();
      const receipt = await response.json();
      publishReceipts.push({ event, receipt, status: response.status() });
      await route.fulfill({ response, json: receipt });
    });

    await page.goto(app.origin);
    await openPage(page, "Messages");

    const draft = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await page
      .getByRole("region", { name: "Channel message history", exact: true })
      .click({ position: { x: 20, y: 20 } });
    await expect(draft).not.toBeFocused();
    await page.keyboard.press("ControlOrMeta+g");
    await expect(
      page.getByRole("searchbox", { name: "Search GIFs" }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Choose Roundtrip Gif", exact: true })
      .click();
    // The GIF waits in the attachment row, as it will appear once sent:
    // after the caption, never between its words.
    const row = page.getByRole("region", { name: "Attachments", exact: true });
    const preview = row.locator("img");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveJSProperty("naturalWidth", 160);
    await expect(
      row.getByRole("button", { name: "Remove Roundtrip Gif", exact: true }),
    ).toBeAttached();
    await expect(draft).toHaveJSProperty("value", "");
    await expect(draft).toBeFocused();
    await page.keyboard.type("Look at this");
    await page.screenshot({
      path: testInfo.outputPath("gif-draft-preview.png"),
    });
    await draft.press("Enter");
    await expect(row).toHaveCount(0);

    const expectedContent =
      "Look at this\n\n![Roundtrip Gif](https://gif.fixture.invalid/7.gif)";
    const expectedEvent = () =>
      app.report.publications.find(
        ({ event }) =>
          event.kind === 9 &&
          event.content === expectedContent &&
          event.tags.some(([name, value]) => name === "h" && value === "alpha"),
      )?.event;
    await expect.poll(() => expectedEvent()?.id).toBeTruthy();
    const sentEvent = expectedEvent();
    expect(sentEvent).toBeDefined();
    const receiptForSentEvent = () =>
      publishReceipts.find(
        ({ event, receipt }) =>
          event.id === sentEvent.id && receipt.event_id === sentEvent.id,
      );
    await expect.poll(() => receiptForSentEvent()?.receipt.accepted).toBe(true);
    expect(receiptForSentEvent()?.status).toBe(200);

    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    const sent = history.locator(`[data-message-id="${sentEvent.id}"]`);
    await expect(sent).toBeVisible();
    const attachment = sent.getByRole("link", {
      name: "Open image attachment",
      exact: true,
    });
    await expect(attachment).toBeVisible();
    await expect(attachment).toHaveAttribute(
      "href",
      "https://gif.fixture.invalid/7.gif",
    );
    await expect(sent.getByText("Look at this", { exact: true })).toBeVisible();
    await expect(sent.getByText("![Roundtrip Gif]")).toHaveCount(0);
    expect(app.report.unexpected).toEqual([]);
  });
});
