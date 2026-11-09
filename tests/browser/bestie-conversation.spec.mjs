import { test, expect } from "./source-fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { clickRow } from "./timeline.mjs";

// Browser-only integration: native layout, split geometry, retained DOM while
// dragging a thread between panes, focus, and responsive/theme/text-size treatment.
test("Bestie uses the conversation split workspace and retains both drafts", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/bestie-conversation.html");
  const composer = page.getByRole("textbox", { name: "Message Bestie" });
  await composer.fill("Main draft");
  const handle = await composer.elementHandle();
  await page
    .getByRole("button", { name: "View thread: 1 reply" })
    .first()
    .click();
  const thread = page.getByLabel("Thread", { exact: true });
  await expect(thread).toBeVisible();
  await expect(composer).toBeVisible();
  const reply = page.getByRole("textbox", { name: "Reply to thread" });
  await reply.fill("Reply draft");
  const replyHandle = await reply.elementHandle();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.dataset.colorMode = theme;
    }, theme);
    for (const width of [1440, 800, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(thread).toBeVisible();
      expect(
        await page
          .locator("body")
          .evaluate((el) => el.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expect
        .poll(async () => {
          const box = await page.locator("[data-panel-dock]").boundingBox();
          return box ? Math.round(box.x + box.width) : 0;
        })
        .toBe(width);
      if (
        process.env.BESTIE_SHOTS &&
        testInfo.project.name === "chromium" &&
        (width === 1440 || (width === 480 && theme === "dark"))
      ) {
        await page.screenshot({
          path: `${process.env.BESTIE_SHOTS}/final-${theme}-${width}-thread.png`,
        });
      }
      if (width === 1440) {
        const chatBox = await composer.boundingBox(),
          threadBox = await thread.boundingBox();
        expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(threadBox.x);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await expect(thread).toBeVisible();
  await page.getByRole("button", { name: "Toggle tab pane" }).click();
  await expect(thread).not.toBeVisible();
  await expect(composer).toHaveText("Main draft");
  await page.getByRole("button", { name: "Toggle tab pane" }).click();
  await expect(reply).toHaveText("Reply draft");
  expect(await replyHandle.evaluate((el) => el.isConnected)).toBe(true);
  expect(await handle.evaluate((el) => el.isConnected)).toBe(true);
  const tab = page.getByRole("tab", { name: "Planning the day", exact: true });
  await tab.focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(
    page
      .locator("[data-main-workspace]")
      .getByRole("tab", { name: "Planning the day", exact: true }),
  ).toBeVisible();
  await expect(reply).toHaveText("Reply draft");
  await page
    .getByRole("button", { name: "Close Planning the day tab" })
    .click();
  await expect(composer).toBeVisible();
  await expect(composer).toHaveText("Main draft");
});

test("Bestie retains multiple threads and closes inactive tabs without stealing reply focus", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/bestie-conversation.html");
  const buttons = page.getByRole("button", { name: "View thread: 1 reply" });
  await buttons.nth(0).click();
  await expect(
    page.getByRole("tab", { name: "Planning the day", exact: true }),
  ).toBeVisible();
  await buttons.nth(1).click();
  const reply = page.getByRole("textbox", { name: "Reply to thread" });
  await reply.fill("Keep typing here");
  await page
    .getByRole("button", { name: "Close Planning the day tab" })
    .click();
  await expect(reply).toHaveText("Keep typing here");
  await expect(
    page.getByRole("tab", { name: "A second conversation", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  // Keyboard Close from the inactive tab exercises removal while its neighbour
  // remains selected, without a pointer deliberately moving focus elsewhere.
  await buttons.nth(0).click();
  await page
    .getByRole("tab", { name: "A second conversation", exact: true })
    .click();
  await reply.focus();
  await expect(reply).toBeFocused();
  await page.evaluate(() => {
    document.querySelector('[aria-label="Close Planning the day tab"]').click();
  });
  await expect(reply).toBeFocused();
  const target = await page.evaluate(() => window.bestieFixture.target());
  await page.evaluate(() => {
    void window.bestieFixture.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.bestie",
      pageId: "bestie",
    });
  });
  await page.getByRole("textbox", { name: "Message Bestie" }).focus();
  await page.evaluate((target) => {
    void window.bestieFixture.open(target);
  }, target);
  await expect(
    page.locator("[data-panel-workspace] [data-message-id]").first(),
  ).toBeFocused();
});

test("Bestie profile tabs restore with history and explicit Close retires their visits", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/bestie-conversation.html");
  await page.getByRole("link", { name: "View profile" }).click();
  await expect(
    page.getByRole("tab", { name: "Profile", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Fixture profile", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.bestieFixture.back());
  await expect
    .poll(() => page.evaluate(() => window.bestieFixture.target().route))
    .toBeUndefined();
  await page.evaluate(() => window.bestieFixture.forward());
  await expect(
    page.getByText("Fixture profile", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close Profile tab" }).click();
  await expect(
    page.getByRole("tab", { name: "Profile", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.bestieFixture.back());
  await page.evaluate(() => window.bestieFixture.forward());
  await expect(
    page.getByRole("tab", { name: "Profile", exact: true }),
  ).toHaveCount(0);
});

test("Bestie stays within a block host with multiline history at narrow widths", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 950 });
  await page.goto("/tests/fixtures/bestie-conversation.html?long");
  const composer = page.getByRole("textbox", { name: "Message Bestie" });
  await expect(composer).toBeInViewport();
  // The timeline opens at its latest message, and clickRow does not scroll.
  await clickRow(
    page,
    page.getByRole("button", { name: "View thread: 1 reply" }).last(),
  );
  await expect(
    page.getByRole("textbox", { name: "Reply to thread" }),
  ).toBeInViewport();
  expect(
    await page
      .getByRole("region", { name: "Chat with Bestie" })
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(884);
  await expect
    .poll(() =>
      page
        .locator("[data-panel-dock]")
        .evaluate((el) => el.getAnimations().length),
    )
    .toBe(0);
  await expect
    .poll(async () =>
      Math.round((await page.locator("[data-panel-dock]").boundingBox()).x),
    )
    .toBe(0);
  await expect(
    page.getByRole("textbox", { name: "Reply to thread" }),
  ).toBeInViewport({ ratio: 1 });
  if (process.env.BESTIE_SHOTS && testInfo.project.name === "chromium")
    await page.screenshot({
      path: `${process.env.BESTIE_SHOTS}/p2-block-host-long-thread-settled.png`,
    });
});

test("the agent tabs API and Bestie operate on the same workspace", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/bestie-conversation.html");
  await expect(
    page.getByRole("textbox", { name: "Message Bestie" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const f = window.bestieFixture;
    f.tabs.open(f.channelId, f.rootIds[0]);
    f.tabs.rename(f.channelId, f.rootIds[0], "Agent-opened thread");
  });
  await page.getByRole("button", { name: "Toggle tab pane" }).click();
  const tab = page.getByRole("tab", {
    name: "Agent-opened thread",
    exact: true,
  });
  await expect(tab).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const f = window.bestieFixture;
        return f.tabs.list(f.channelId).map((item) => item.name);
      }),
    )
    .toContain("Agent-opened thread");
  await page.getByRole("button", { name: "Toggle tab pane" }).click();
  await page.evaluate(() => {
    const f = window.bestieFixture;
    f.tabs.close(f.channelId, f.rootIds[0]);
  });
  await expect(tab).toHaveCount(0);
});

test("collapsing the pane preserves inline panel state", async ({ page }) => {
  await page.goto("/tests/fixtures/bestie-conversation.html");
  await page
    .getByRole("button", { name: "View thread: 1 reply" })
    .first()
    .click();
  await page.getByRole("link", { name: "View profile" }).click();
  const note = page.getByRole("textbox", { name: "Profile note" });
  await note.fill("Keep this panel state");
  const handle = await note.elementHandle();
  await page.getByRole("button", { name: "Toggle tab pane" }).click();
  await expect(note).not.toBeVisible();
  await expect(page.locator("[data-panel-dock]:not([hidden])")).toHaveCount(0);
  expect(await handle.evaluate((el) => el.isConnected)).toBe(true);
  await page.getByRole("button", { name: "Toggle tab pane" }).click();
  await expect(note).toHaveValue("Keep this panel state");
  expect(await handle.evaluate((el) => el.isConnected)).toBe(true);
});

test("application Close All closes Bestie tabs but leaves modal ownership intact", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/bestie-conversation.html");
  await page
    .getByRole("button", { name: "View thread: 1 reply" })
    .first()
    .click();
  await page.getByRole("link", { name: "View profile" }).click();
  const note = page.getByRole("textbox", { name: "Profile note" });
  await expect(note).toBeVisible();
  await note.focus();
  // A modal must retain ownership of the application command.
  expect(
    await page.evaluate(() => {
      const modal = document.createElement("div");
      modal.setAttribute("aria-modal", "true");
      document.body.append(modal);
      const event = new Event("buzz:close-all-tabs", { cancelable: true });
      window.dispatchEvent(event);
      modal.remove();
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await expect(note).toBeVisible();
  expect(
    await page.evaluate(() => {
      const event = new Event("buzz:close-all-tabs", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await expect(
    page.getByRole("tab", { name: "Profile", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Planning the day", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message Bestie" }),
  ).toBeInViewport();
  const conversation = page
    .locator("[data-main-workspace]")
    .getByRole("tab", { name: "Bestie", exact: true });
  await expect(page.locator("[data-main-workspace] :focus")).toHaveCount(1);
  // The context-menu action must make the same focus handoff.
  await page
    .getByRole("button", { name: "View thread: 1 reply" })
    .first()
    .click();
  await page
    .getByRole("tab", { name: "Planning the day", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close all tabs", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Planning the day", exact: true }),
  ).toHaveCount(0);
  await expect(conversation).toBeFocused();
  // Closing the remaining tabs from the application command keeps typing focus
  // and selection when its main composer survives.
  await page
    .getByRole("button", { name: "View thread: 1 reply" })
    .first()
    .click();
  const composer = page.getByRole("textbox", { name: "Message Bestie" });
  await composer.fill("Keep typing");
  await page.evaluate(() => {
    window.dispatchEvent(
      new Event("buzz:close-all-tabs", { cancelable: true }),
    );
  });
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText("Keep typing");
});

test("pointer pane moves show the shared drag preview and drop indicator", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/bestie-conversation.html");
  await page
    .getByRole("button", { name: "View thread: 1 reply" })
    .first()
    .click();
  const tab = page.getByRole("tab", { name: "Planning the day", exact: true });
  // The entering pane moves the tab; begin the gesture only at its settled geometry.
  await expect
    .poll(async () => {
      const dock = await page.locator("[data-panel-dock]").boundingBox();
      return Math.round(dock.x + dock.width);
    })
    .toBe(page.viewportSize().width);
  const start = await tab.boundingBox();
  const main = await page.locator("[data-main-workspace]").boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(main.x + 200, main.y + 20, { steps: 10 });
    await expect(page.locator(".buzz-tab-drag-title")).toBeVisible();
    await expect(page.locator(".buzz-tab-drag-insertion")).toBeVisible();
    if (process.env.BESTIE_SHOTS && testInfo.project.name === "chromium")
      await page.screenshot({
        path: `${process.env.BESTIE_SHOTS}/p2-tab-drag-feedback.png`,
      });
  } finally {
    await page.mouse.up();
  }
  await expect(
    page
      .locator("[data-main-workspace]")
      .getByRole("tab", { name: "Planning the day", exact: true }),
  ).toBeVisible();
});

// Browser integration: the floating action/menu must route from Bestie to the
// separate dialog owner, including messages rendered through thread portals.
test("Bestie main and thread messages open the shared forwarding dialog", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/bestie-conversation.html");
  const root = page
    .locator("[data-main-workspace] [data-message-id]")
    .filter({ hasText: "Planning the day" })
    .first();
  const rootId = await root.getAttribute("data-message-id");
  await hoverMessage(root);
  await root
    .getByRole("button", { name: "Forward message", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Forward message",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(() => window.bestieFixture.target()),
  ).toMatchObject({ kind: "conversation", forward: rootId });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "View thread: 1 reply" })
    .first()
    .click();
  const reply = page
    .getByLabel("Thread", { exact: true })
    .locator("[data-message-id]")
    .filter({ hasText: "Reply 1" })
    .first();
  const replyId = await reply.getAttribute("data-message-id");
  await hoverMessage(reply);
  await reply
    .getByRole("button", { name: "More message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Forward message", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(() => window.bestieFixture.target()),
  ).toMatchObject({ kind: "conversation", forward: replyId });
});
