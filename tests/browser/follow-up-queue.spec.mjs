import { test, expect } from "./fixture.mjs";
import { openPage, selectSettingsSection, sendOnlyTo } from "./navigation.mjs";

const chat = "33333333-3333-4333-8333-333333333333";
const agent =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
test.use({
  productionBroker: true,
  localAgentActivity: "resumable",
  channelIds: [chat],
  channelNames: { [chat]: "Alpha" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  sessionMembers: { [chat]: [agent] },
  historyCounts: { [chat]: 1 },
});

// Real host wiring, keyboard send, queued-row geometry and native agent completion
// projection. External work and relay identities are controlled test fixtures.
test("Solo queues follow-ups, keeps typing intact, and offers Send now", async ({
  page,
  app,
}, testInfo) => {
  const { editor, first } = await startWorkingAgent(page, app);
  await editor.press("End");
  await editor.pressSequentially("Queued follow-up");
  await editor.press("Enter");
  const queue = page.getByRole("region", { name: "Queued follow-ups" });
  await expect(queue).toContainText("Queued follow-up");
  await editor.press("End");
  await editor.pressSequentially("Keep typing");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      const button = queue.getByRole("button", { name: "Send", exact: true });
      await expect(button).toBeVisible();
      const contrast = () =>
        button.evaluate((element) => {
          const luminance = (color) => {
            const channels = color
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number)
              .map((channel) => {
                const value = channel / 255;
                return value <= 0.04045
                  ? value / 12.92
                  : ((value + 0.055) / 1.055) ** 2.4;
              });
            return (
              channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
            );
          };
          const style = getComputedStyle(element);
          const foreground = luminance(style.color),
            background = luminance(style.backgroundColor);
          return (
            (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05)
          );
        });
      await editor.focus();
      await page.mouse.move(0, 0);
      await expect(
        queue.getByRole("button", { name: "Remove queued message" }),
      ).toHaveCSS("opacity", "1");
      await expect(
        queue.getByRole("button", { name: "Remove queued message" }),
      ).toHaveCSS("pointer-events", "auto");
      await expect(button.locator("svg")).toBeVisible();
      await expect(button).toHaveAttribute("data-icon-shape", "round");
      await expect.poll(contrast).toBeGreaterThanOrEqual(4.5);
      await button.hover();
      await expect.poll(contrast).toBeGreaterThanOrEqual(4.5);
      await page.mouse.move(0, 0);
      await queue
        .getByRole("button", { name: "Remove queued message" })
        .focus();
      await page.keyboard.press("Tab");
      await expect(
        queue.getByRole("button", { name: "Edit queued message" }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await expect.poll(contrast).toBeGreaterThanOrEqual(4.5);
      await editor.focus();
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      const queueBox = await queue.boundingBox();
      const composerBox = await editor
        .locator("xpath=ancestor::form")
        .boundingBox();
      expect(queueBox.x).toBe(composerBox.x);
      expect(queueBox.width).toBe(composerBox.width);
      expect(composerBox.y - queueBox.y - queueBox.height).toBe(8);
      const trashBox = await queue
        .getByRole("button", { name: "Remove queued message" })
        .boundingBox();
      expect(trashBox.x + trashBox.width).toBeLessThan(box.x);
      expect(trashBox.height).toBe(box.height);
      expect(trashBox.width).toBe(box.width);
      await expect(button).toHaveAttribute("data-icon-size", "xs");
      const rowBox = await queue.getByRole("listitem").boundingBox();
      const menuBox = await queue
        .getByRole("button", { name: "Edit queued message" })
        .boundingBox();
      expect(menuBox.x + menuBox.width).toBeLessThan(box.x);
      const endBox = box;
      const composerSend = page.getByRole("button", {
        name: "Send message",
        exact: true,
      });
      const composerSendBox = await composerSend.boundingBox();
      expect(composerSendBox.width).toBe(composerSendBox.height);
      const radius = await queue
        .getByRole("listitem")
        .evaluate((row) =>
          Number.parseFloat(getComputedStyle(row).borderTopRightRadius),
        );
      expect(
        Math.abs(
          rowBox.x + rowBox.width - radius - endBox.x - endBox.width / 2,
        ),
      ).toBeLessThan(0.5);
      expect(
        Math.abs(rowBox.y + radius - endBox.y - endBox.height / 2),
      ).toBeLessThan(0.5);
      expect(rowBox.x).toBeGreaterThan(queueBox.x);
      expect(
        Math.abs(rowBox.x + rowBox.width - queueBox.x - queueBox.width),
      ).toBeLessThan(1);
      await page.screenshot({
        path: testInfo.outputPath(`queue-${colorScheme}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await expect(
    queue.getByRole("button", { name: "Send", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("queue-enlarged.png") });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.evaluate((id) => window.localAgentFixture.finish(id, true), first);
  await expect(queue).toHaveCount(0);
  await expect(editor).toContainText("Keep typing");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  await editor.press("Enter");
  await expect(queue).toContainText("Keep typing");
  await editor.pressSequentially("Next keyboard send");
  await editor.press("Enter");
  await expect(queue).toContainText("Next keyboard send");
  await queue
    .getByRole("button", { name: "Send", exact: true })
    .first()
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    queue.getByRole("button", { name: "Send", exact: true }),
  ).toHaveCount(1);
  await expect(
    queue.getByRole("button", { name: "Send", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(queue).toHaveCount(0);
  await expect(editor).toBeFocused();
  await editor.pressSequentially("Remove this follow-up");
  await editor.press("Enter");
  await expect(queue).toContainText("Remove this follow-up");
  await queue.getByRole("button", { name: "Remove queued message" }).focus();
  await page.keyboard.press("Enter");
  await expect(queue).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 9).length,
    )
    .toBeGreaterThanOrEqual(3);
});

async function startWorkingAgent(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Appearance", "Appearance");
  const preference = page.getByRole("combobox", { name: "Follow-up behavior" });
  await expect(preference).toContainText("Send immediately");
  await preference.click();
  await page.getByRole("option", { name: "Queue", exact: true }).click();
  await page
    .getByRole("button", { name: "Close Settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeHidden();
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Solo conversations" })
    .locator(`[data-solo-channel-id="${chat}"]`)
    .click();
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const editor = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  // Agents-only Solo chats address agents from the composer's pill.
  await sendOnlyTo(
    page,
    page.getByRole("button", { name: /Change agents$|^Choose agent$/ }),
    { name: "Local tester", pubkey: agent },
  );
  await editor.press("End");
  await editor.pressSequentially("First request");
  await editor.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  const first = await page.evaluate(
    () => window.localAgentFixture.pending()[0],
  );
  return { editor, first };
}

// Browser-only: native button-to-editor focus and persisted edits through the real composer.
test("queued message actions edit text without changing the current draft", async ({
  page,
  app,
}, testInfo) => {
  const { editor } = await startWorkingAgent(page, app);
  await page.keyboard.insertText("Original queued text");
  await editor.press("Enter");
  const queue = page.getByRole("region", { name: "Queued follow-ups" });
  await expect(queue).toContainText("Original queued text");
  await editor.fill("Keep my current draft");
  await queue.getByRole("button", { name: "Edit queued message" }).click();
  await page.screenshot({ path: testInfo.outputPath("queue-actions.png") });
  const edit = page.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(edit).toBeFocused();
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await expect(
    page.getByText("Editing message", { exact: true }),
  ).toBeVisible();
  await edit.fill("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Enter a message");
  await edit.fill("Updated queued text");
  await page.screenshot({ path: testInfo.outputPath("queue-editor.png") });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(queue).toContainText("Updated queued text");
  await expect(editor).toContainText("Keep my current draft");
  await queue.getByRole("button", { name: "Edit queued message" }).click();
  await edit.fill("Discard this edit");
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await expect(queue).toContainText("Updated queued text");
  await queue.getByRole("button", { name: "Send", exact: true }).click();
  await expect(queue).toHaveCount(0);
  await expect(
    page.getByText("Updated queued text", { exact: true }),
  ).toBeVisible();
  await expect(editor).toContainText("Keep my current draft");
});

// Browser-only: pointer modality, computed visibility and native focus handoff.
test("queue focus survives preview release and pointer removal", async ({
  page,
  app,
}) => {
  const { editor, first } = await startWorkingAgent(page, app);
  const queue = page.getByRole("region", { name: "Queued follow-ups" });
  await editor.press("End");
  // Seed long content in one input event; this journey tests focus, not typing throughput.
  await page.keyboard.insertText("A long queued request ".repeat(30));
  await editor.press("Enter");
  const preview = queue.locator('[data-queue-action="preview"]');
  await expect(preview).toHaveAttribute("aria-expanded", "false");
  await preview.focus();
  await page.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("aria-expanded", "true");
  await page.evaluate((id) => window.localAgentFixture.finish(id, true), first);
  await expect(queue).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  await editor.press("End");
  await editor.pressSequentially("Keep this row");
  await editor.press("Enter");
  // Admission is asynchronous: settle the first submission before typing into
  // the draft it clears, then establish both rows before testing removal.
  await expect(queue).toContainText("Keep this row");
  await expect(editor).not.toContainText("Keep this row");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.press("End");
  await editor.pressSequentially("Remove last row");
  await editor.press("Enter");
  await expect(queue).toContainText("Remove last row");
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  const remove = queue.getByRole("button", { name: "Remove queued message" });
  await expect(remove).toHaveCount(2);
  await queue.getByRole("listitem").last().hover();
  // WebKit does not focus clicked buttons; focus explicitly to cover the same
  // pointer-modality handoff on both engines.
  await remove.last().focus();
  await remove.last().click();
  await page.mouse.move(0, 0);
  await expect(remove).toHaveCount(1);
  await expect(remove).toBeFocused();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  await expect(remove).toHaveCSS("opacity", "1");
  await expect(remove).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Enter");
  await expect(queue).toHaveCount(0);
  await expect(editor).toBeFocused();
});

// Browser-only: real document reload, persisted view records/Outbox, and restored
// row controls through the production composer and relay session wiring.
test("Solo queued rows survive reload and Send or Remove stays durable", async ({
  page,
  app,
}, testInfo) => {
  const { editor } = await startWorkingAgent(page, app);
  for (const text of ["Keep across restart", "Remove after restart"]) {
    await editor.press("End");
    await page.keyboard.insertText(text);
    await editor.press("Enter");
    await expect(
      page.getByRole("region", { name: "Queued follow-ups" }),
    ).toContainText(text);
  }
  const queue = page.getByRole("region", { name: "Queued follow-ups" });
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  const reopen = async (interrupted = true) => {
    // Sidebar navigation is visible in the wide layout; narrow screenshots
    // exercise the restored rows themselves, not the compact navigation menu.
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.reload();
    if (interrupted) {
      const notice = page.getByRole("dialog", {
        name: "Resume interrupted agent?",
      });
      await expect(notice).toBeVisible();
      await notice
        .getByRole("button", { name: "Don’t resume", exact: true })
        .click();
      await expect(notice).toBeHidden();
    }
    await openPage(page, "Messages");
    await page
      .getByRole("navigation", { name: "Solo conversations" })
      .locator(`[data-solo-channel-id="${chat}"]`)
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message your agents", exact: true }),
    ).toBeVisible();
  };
  await reopen();
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await expect(queue).toContainText("Saved before restart. Send when ready.");
  await expect(queue.getByRole("listitem").first()).toContainText(
    "Keep across restart",
  );
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(
        queue.getByRole("button", { name: "Send", exact: true }).first(),
      ).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath(`restored-queue-${colorScheme}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await expect(
    queue.getByRole("button", { name: "Send", exact: true }).first(),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("restored-queue-enlarged.png"),
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  const sent = () =>
    app.report.publications.filter(
      ({ event }) =>
        event.kind === 9 && event.content.includes("Keep across restart"),
    );
  expect(sent()).toHaveLength(0);
  await queue
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await expect.poll(() => sent().length).toBe(1);
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  await reopen();
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await expect(queue).toContainText("Remove after restart");
  await queue.getByRole("listitem").hover();
  await queue.getByRole("button", { name: "Remove queued message" }).click();
  await expect(queue).toHaveCount(0);
  await reopen(false);
  await expect(queue).toHaveCount(0);
  expect(sent()).toHaveLength(1);
});

// Real restart-decision wiring: persisted native identity stand-in + resumable
// runner type, durable queued rows, modal choice, and local completion signals.
test.describe("resuming saved Solo work", () => {
  for (const resume of [true, false]) {
    test(
      resume
        ? "Resume continues the interrupted turn before draining the queue in order"
        : "Don't resume preserves the queued rows without sending",
      async ({ page, app }) => {
        const { editor, first } = await startWorkingAgent(page, app);
        for (const text of [
          "First saved follow-up",
          "Second saved follow-up",
        ]) {
          await editor.press("End");
          await page.keyboard.insertText(text);
          await editor.press("Enter");
          await expect(
            page.getByRole("region", { name: "Queued follow-ups" }),
          ).toContainText(text);
        }
        const queue = page.getByRole("region", { name: "Queued follow-ups" });
        await expect(queue.getByRole("listitem")).toHaveCount(2);
        await page.reload();
        const notice = page.getByRole("dialog", {
          name: "Resume interrupted agent?",
        });
        await expect(notice).toBeVisible();
        const sent = () =>
          app.report.publications.filter(
            ({ event }) =>
              event.kind === 9 && event.content.includes("saved follow-up"),
          );
        expect(sent()).toHaveLength(0);
        await notice
          .getByRole("button", {
            name: resume ? "Resume" : "Don’t resume",
            exact: true,
          })
          .click();
        await expect(notice).toBeHidden();
        await openPage(page, "Messages");
        await page
          .getByRole("navigation", { name: "Solo conversations" })
          .locator(`[data-solo-channel-id="${chat}"]`)
          .click();
        await expect(queue.getByRole("listitem")).toHaveCount(2);
        if (!resume) {
          await expect(queue).toContainText(
            "Saved before restart. Send when ready.",
          );
          expect(sent()).toHaveLength(0);
          expect(
            await page.evaluate(() => window.localAgentFixture.pending()),
          ).toEqual([]);
          return;
        }
        await expect
          .poll(() => page.evaluate(() => window.localAgentFixture.pending()))
          .toEqual([first]);
        expect(sent()).toHaveLength(0);
        await page.evaluate(
          (id) => window.localAgentFixture.finish(id, true),
          first,
        );
        await expect.poll(() => sent().length).toBe(1);
        await expect(queue.getByRole("listitem")).toHaveCount(1);
        expect(sent()[0].event.content).toContain("First saved follow-up");
        await expect
          .poll(() =>
            page.evaluate(() => window.localAgentFixture.pending().length),
          )
          .toBe(2);
        const next = await page.evaluate(
          () => window.localAgentFixture.pending()[1],
        );
        await page.evaluate(
          (id) => window.localAgentFixture.finish(id, true),
          next,
        );
        await expect.poll(() => sent().length).toBe(2);
        expect(sent()[1].event.content).toContain("Second saved follow-up");
        await expect(queue).toHaveCount(0);
      },
    );
  }
});

// Browser-only boundary: another same-origin document owns the real Web Lock
// and writes the handoff marker. Releasing ownership emits no storage event.
test("an open queue recovers Remove when another window releases an abandoned handoff", async ({
  page,
  context,
  app,
}) => {
  const { editor } = await startWorkingAgent(page, app);
  await editor.press("End");
  await page.keyboard.insertText("Abandoned handoff");
  await editor.press("Enter");
  const queue = page.getByRole("region", { name: "Queued follow-ups" });
  await expect(queue).toContainText("Abandoned handoff");
  const other = await context.newPage();
  await other.route("**/queue-lock-owner", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Queue lock owner</title>",
    }),
  );
  await other.goto(`${app.origin}/queue-lock-owner`);
  try {
    await other.evaluate(async () => {
      const key = Object.keys(localStorage).find((key) => {
        if (!key.startsWith("buzz-view.v1:")) return false;
        return JSON.parse(key.slice("buzz-view.v1:".length))[1].startsWith(
          "follow-up:",
        );
      });
      if (!key) throw new Error("Queued row missing");
      const [scope] = JSON.parse(key.slice("buzz-view.v1:".length));
      const saved = JSON.parse(localStorage.getItem(key));
      let started;
      const acquired = new Promise((resolve) => {
        started = resolve;
      });
      const held = new Promise((resolve) => {
        window.releaseQueueLock = resolve;
      });
      window.queueLockHeld = navigator.locks.request(
        `buzz-follow-up:${scope}:${saved.id}`,
        async () => {
          localStorage.setItem(
            key,
            JSON.stringify({ ...saved, sending: true }),
          );
          started();
          await held;
        },
      );
      await acquired;
    });
    const remove = queue.getByRole("button", { name: "Remove queued message" });
    await expect(remove).toBeDisabled();
    await expect(queue).toContainText("Sending…");
    await other.evaluate(async () => {
      window.releaseQueueLock();
      await window.queueLockHeld;
    });
    await expect(remove).toBeEnabled();
    await editor.press("End");
    await page.keyboard.insertText("Next queued message");
    await editor.press("Enter");
    await expect(queue).toContainText("Next queued message");
    const abandoned = queue
      .getByRole("listitem")
      .filter({ hasText: "Abandoned handoff" });
    const abandonedRemove = abandoned.getByRole("button", {
      name: "Remove queued message",
    });
    await expect(abandonedRemove).toBeEnabled();
    await abandoned.hover();
    await abandonedRemove.click();
    await expect(abandoned).toHaveCount(0);
    await expect(queue).toContainText("Next queued message");
    expect(
      app.report.publications.filter(
        ({ event }) =>
          event.kind === 9 && event.content.includes("Abandoned handoff"),
      ),
    ).toHaveLength(0);
  } finally {
    await other.evaluate(() => window.releaseQueueLock?.());
  }
});

// Real storage-event delivery must preserve earlier work and pause only successors.
test("external removal pauses successors while earlier queued work still drains", async ({
  page,
  context,
  app,
}) => {
  const { editor, first } = await startWorkingAgent(page, app);
  const queue = page.getByRole("region", { name: "Queued follow-ups" });
  for (const text of ["Earlier queued", "Removed middle", "Later queued"]) {
    await editor.press("End");
    await page.keyboard.insertText(text);
    await editor.press("Enter");
    await expect(queue).toContainText(text);
  }
  const other = await context.newPage();
  await other.route("**/queue-removal-owner", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Queue removal owner</title>",
    }),
  );
  await other.goto(`${app.origin}/queue-removal-owner`);
  await other.evaluate(() => {
    const key = Object.keys(localStorage).find(
      (key) =>
        key.startsWith("buzz-view.v1:") &&
        JSON.parse(key.slice("buzz-view.v1:".length))[1].startsWith(
          "follow-up:",
        ) &&
        JSON.parse(localStorage.getItem(key))?.text?.includes("Removed middle"),
    );
    if (!key) throw new Error("Middle queued row missing");
    localStorage.removeItem(key);
  });
  await expect(queue).not.toContainText("Removed middle");
  const later = queue.getByRole("listitem").filter({ hasText: "Later queued" });
  await expect(later).toContainText(
    "Paused because an earlier message was handled in another window. Send when ready.",
  );
  await page.evaluate((id) => window.localAgentFixture.finish(id, true), first);
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) =>
          event.kind === 9 && event.content.includes("Earlier queued"),
      ),
    )
    .toBe(true);
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await expect(later).toBeVisible();
});

// Real IndexedDB is required: a read-only cross-window receipt lookup must not
// move the observer's incremental-write baseline and later delete the receipt.
test("shared receipt inspection cannot delete another window's journal entry", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page.waitForFunction(() => !!window.localAgentFixture);
  const ids = await page.evaluate(async () => {
    const browserOutboxStorage = window.localAgentFixture.outboxStorage;
    const scope = `receipt-inspection:${crypto.randomUUID()}`;
    const sender = browserOutboxStorage(scope);
    const observer = browserOutboxStorage(scope);
    try {
      await sender.load();
      await observer.load();
      const first = {
        event: { id: "first" },
        delivery: "sending",
        recovery: { key: "follow-up:first", value: "first" },
      };
      const second = { event: { id: "second" }, delivery: "sending" };
      await sender.save([first]);
      const inspected = await observer.load({ readOnly: true });
      if (inspected[0]?.event.id !== "first")
        throw new Error("Shared receipt was not visible");
      await observer.save([second]);
      return (await sender.load({ readOnly: true }))
        .map((item) => item.event.id)
        .sort();
    } finally {
      sender.close();
      observer.close();
    }
  });
  expect(ids).toEqual(["first", "second"]);
});
