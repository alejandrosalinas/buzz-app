import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { open } from "./timeline.mjs";
import { createHash } from "node:crypto";

test.use({ productionBroker: true, dmLabels: true, developmentReact: true });

// Browser boundary: the real file chooser and ProseMirror selection must allow
// typing immediately at the retained caret after a successful picker upload.
test("a successful picker image upload returns focus with the existing caret", async ({
  page,
  app,
}) => {
  // A metadata-free GIF keeps the upload bytes identical in both engines.
  const bytes = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let release;
  let started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const uploading = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/api/relay/**/upload", async (route) => {
    started();
    await held;
    await route.fulfill({
      json: {
        name: "pixel.gif",
        url: `https://primary.example/media/${sha256}.gif`,
        sha256,
        type: "image/gif",
        size: bytes.length,
      },
    });
  });
  await page.route("**/api/relay/**/media?**", (route) =>
    route.fulfill({ contentType: "image/gif", body: bytes }),
  );
  try {
    await open(page, app);
    const form = page.getByRole("form", {
      name: "Send a message to Alpha",
      exact: true,
    });
    const input = form.getByRole("textbox");
    await input.fill("hello world");
    await input.press("End");
    for (let i = 0; i < 5; i++) await input.press("ArrowLeft");
    const choosing = page.waitForEvent("filechooser");
    await form
      .getByRole("button", { name: "Attach files", exact: true })
      .click();
    await (await choosing).setFiles({
      name: "pixel.gif",
      mimeType: "image/gif",
      buffer: bytes,
    });
    await uploading;
    release();
    await expect(form.getByText(/Ready$/)).toHaveCount(1);
    await expect(input).toBeFocused();
    await page.keyboard.type("picked ");
    await expect(input).toHaveText("hello picked world");
  } finally {
    release();
  }
});

// Browser boundary: real sidebar navigation must hand focus to the mounted
// ProseMirror editor, including after a warm return; typing must need no click.
test("selecting a channel or DM focuses its composer and retains drafts", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const conversation = page.getByRole("article", { name: "Conversation" });
  const input = conversation.getByRole("textbox");
  for (const [index, name] of [
    "Beta",
    "Alice Fixture",
    "Beta",
    "Alice Fixture",
  ].entries()) {
    await sidebar.getByRole("button", { name, exact: true }).click();
    await expect(input).toBeFocused();
    if (index < 2) {
      await page.keyboard.type(`Draft for ${name}`);
      await expect(input).toHaveText(`Draft for ${name}`);
    } else {
      await expect(input).toHaveText(`Draft for ${name}`);
      await page.keyboard.type(" continued");
      await expect(input).toHaveText(`Draft for ${name} continued`);
    }
  }
  await openChannelDetails(page);
  await expect(
    page.getByRole("tab", { name: "Channel settings", exact: true }),
  ).toBeFocused();
});

// The host can focus the editor while a typed character is in the DOM but not
// yet read by ProseMirror (native typing that refocuses the window does). The
// focus must not restore the caret from before that character.
test("a focus between a keystroke and its read keeps the caret after the typed text", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.click();
  await page.keyboard.type("hello ");
  await expect(input).toHaveText("hello");
  await input.evaluate((element) => {
    window.addEventListener(
      "input",
      () => {
        element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        element.dispatchEvent(new FocusEvent("focus"));
      },
      { capture: true, once: true },
    );
  });
  await page.keyboard.type("any");
  await expect(input).toHaveText("hello any");
  await expect(input).toBeFocused();
});

// Real Base UI menus close when focus leaves them. A conversation that mounts
// while a menu is open, as at startup, must leave focus with that menu.
test("a conversation mounting behind an open menu keeps the menu open", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  // Settings is a modal over the retained conversation, so leave through a
  // page that replaces the conversation instead.
  await openPage(page, "Repository");
  await expect(input).toHaveCount(0);
  const trigger = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  const settings = page.getByRole("menuitem", {
    name: "Settings",
    exact: true,
  });
  for (const owner of [trigger, settings]) {
    await trigger.click();
    await expect(settings).toBeVisible();
    // Base UI places the menu's initial focus after it opens. Let that settle
    // so the explicit focus below is the last focus move before the mount.
    await expect(page.getByRole("menu").locator(":focus")).toHaveCount(1);
    await owner.focus();
    await page.evaluate(() => history.back());
    await expect(input).toBeVisible();
    await expect(owner).toBeFocused();
    await expect(settings).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await page.evaluate(() => history.forward());
    await expect(input).toHaveCount(0);
  }
});

// Real DOM selection and keyboard insertion cannot be proved by jsdom. Use the
// app's development StrictMode so editor teardown/recreation remains covered.
test.describe("retained agent focus", () => {
  test.use({ agentPeers: true });

  test("returning after a send appends after all retained agents with the same recipients", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const input = page
      .getByRole("article", { name: "Conversation" })
      .getByRole("textbox");
    const recipients = app.participants.slice(1);
    const publications = () =>
      app.report.publications.filter(({ event }) => event.kind === 9);
    // Default remembering is enabled. Select identities through the real picker,
    // then let successful delivery create the follow-up draft, rather than seed it.
    for (const pubkey of recipients) {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Mention a member or agent" })
        .getByRole("button")
        .and(page.locator(`[data-mention-choice="${pubkey}"]`))
        .click();
    }
    await page.keyboard.type("First request");
    await page.keyboard.press("Enter");
    await expect.poll(() => publications().length).toBe(1);
    const first = publications()[0].event;
    expect(first.content).toBe("@Bob Fixture @Carol Fixture First request");
    expect(first.tags.filter(([tag]) => tag === "p")).toEqual(
      recipients.map((key) => ["p", key]),
    );
    await expect(page.locator(`[data-message-id="${first.id}"]`)).toBeVisible();
    const retained = "@Bob Fixture @Carol Fixture ";
    await expect(input).toHaveJSProperty("value", retained);
    await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    // No editor click/fill/focus/selection setter or sleep after navigation.
    // Inspect native caret without giving ProseMirror a chance to repair it.
    const caret = await input.evaluate((element) => {
      const selection = document.getSelection();
      const node = selection?.anchorNode;
      return {
        focused: document.activeElement === element,
        collapsed: selection?.isCollapsed,
        trailingSpace:
          node?.nodeType === Node.TEXT_NODE &&
          node.textContent === " " &&
          element.contains(node) &&
          node.parentNode === element.lastChild &&
          !node.nextSibling,
        offset: selection?.anchorOffset,
      };
    });
    await page.keyboard.type("Next request");
    await expect(input).toHaveJSProperty("value", `${retained}Next request`);
    expect(caret).toEqual({
      focused: true,
      collapsed: true,
      trailingSpace: true,
      offset: 1,
    });
    await page.keyboard.press("Enter");
    await expect.poll(() => publications().length).toBe(2);
    expect(publications()[1].event.content).toBe(`${retained}Next request`);
    expect(publications()[1].event.tags.filter(([tag]) => tag === "p")).toEqual(
      first.tags.filter(([tag]) => tag === "p"),
    );
    await expect(input).toHaveJSProperty("value", retained);
  });
});

// Real CSS and :focus-visible/modality switching are browser-owned. Keep the
// shared field exception consistent with the rich editor in the actual app.
test.describe("text field focus appearance", () => {
  test.use({
    historyCounts: { alpha: 1, beta: 0 },
    productionBroker: false,
    channelWriteKinds: [9, 9000, 9007],
  });

  for (const mode of ["light", "dark"]) {
    test(`typing and caret navigation keep the ${mode} composer free of an inner outline`, async ({
      page,
      app,
    }) => {
      await page.emulateMedia({ colorScheme: mode });
      await open(page, app);
      const input = page
        .getByRole("article", { name: "Conversation" })
        .getByRole("textbox");
      await input.click();
      // ProseMirror repairs the DOM selection in a 20 ms timer after focus.
      // A busy renderer can run it after a later caret key has moved the
      // native caret but before the editor observes the move, which puts
      // the caret back. Timers run in deadline order, so one queued now with
      // the same delay resolves after that repair.
      await input.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 20)),
      );
      await page.keyboard.type("A draft");
      await expect(input).toHaveText("A draft");
      const caret = () =>
        input.evaluate((element) => {
          const selection = document.getSelection();
          return selection?.isCollapsed &&
            element.contains(selection.anchorNode)
            ? selection.anchorOffset
            : -1;
        });
      // Observe each native selection move before sending the next key.
      await expect.poll(caret).toBe(7);
      await expect(input).toHaveCSS("outline-style", "none");
      await page.keyboard.press("ArrowLeft");
      await expect.poll(caret).toBe(6);
      await page.keyboard.press("ArrowRight");
      await expect.poll(caret).toBe(7);
      await expect(page.locator("html")).toHaveAttribute(
        "data-keyboard-navigation",
        "",
      );
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("outline-style", "none");
      await page.keyboard.type(" continued");
      await expect(input).toHaveText("A draft continued");
      await page.keyboard.press("Tab");
      const tool = page.locator(":focus");
      await expect(tool).toHaveRole("button");
      await expect(tool).toHaveCSS("outline-style", "solid");
      await expect(tool).toHaveCSS("outline-width", "2px");
      await page.keyboard.press("Shift+Tab");
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("outline-style", "none");
      for (const width of [1440, 800, 390]) {
        await page.setViewportSize({ width, height: 950 });
        await expect(input).toBeFocused();
        await expect(input).toHaveCSS("outline-style", "none");
        await expect(input).toHaveText("A draft continued");
        await input.locator("xpath=ancestor::form").screenshot({
          path: test.info().outputPath(`composer-focus-${mode}-${width}.png`),
        });
      }
      await page.setViewportSize({ width: 1440, height: 950 });

      // The same shared recipe must reach ordinary fields, not just composers.
      await page
        .getByRole("button", { name: "Create channel", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      const name = dialog.getByRole("textbox", { name: "Name", exact: true });
      const description = dialog.getByRole("textbox", {
        name: "Description",
        exact: true,
      });
      for (const field of [name, description]) {
        await field.click();
        await page.keyboard.type("Draft");
        await page.keyboard.press("ArrowLeft");
        await expect(field).toBeFocused();
        await expect(field).toHaveValue("Draft");
        await expect(field).toHaveCSS("outline-style", "none");
        await expect(field).toHaveCSS("border-top-width", "1px");
        await expect(field).toHaveCSS("border-top-style", "solid");
        expect(
          await field.evaluate(
            (element) => getComputedStyle(element).borderTopColor,
          ),
        ).not.toBe("rgba(0, 0, 0, 0)");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(field).toBeFocused();
        await expect(field).toHaveCSS("outline-style", "none");
      }
      await dialog
        .getByRole("button", { name: "Close channel creation" })
        .click();
      await page
        .getByRole("dialog", { name: "Discard changes?" })
        .getByRole("button", { name: "Discard changes" })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(input).toHaveText("A draft continued");
    });
  }
});
