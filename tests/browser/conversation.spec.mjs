import { test, expect } from "./playwright-test.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { run } from "./run-command.mjs";
import { nativeFixture } from "./native-fixture.mjs";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchPageErrors } from "./page-errors.mjs";
import { createServer, warmUp } from "./vite-server.mjs";
import { expectMessageActionsHidden } from "./message-actions.mjs";
import { hoverRow, settle } from "./timeline.mjs";
import { signPackage } from "../fixtures/plugin-release.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("independent packed author consumer and native-installed contribution survive removal, replacement and retarget", async ({
  page,
}) => {
  test.setTimeout(240000);
  const temp = await mkdtemp(join(tmpdir(), "buzz-conversation-proof-"));
  let server;
  try {
    const author = join(temp, "author");
    run("pnpm", ["author:build", author]);
    run("pnpm", ["pack", "--pack-destination", temp], author);
    const source = join(temp, "consumer");
    await cp(join(root, "tests/fixtures/conversation-consumer"), source, {
      recursive: true,
    });
    run(
      "pnpm",
      ["add", "-D", join(temp, "buzz-author-0.0.0-preview.1.tgz")],
      source,
    );
    run("pnpm", ["build"], source);
    // The global producer is a separate test-only artifact, never part of the consumer.
    const toolSource = join(temp, "timestamp-tool");
    await cp(source, toolSource, { recursive: true });
    await cp(
      join(root, "tests/fixtures/timestamp-tool.ts"),
      join(toolSource, "plugin.ts"),
    );
    await writeFile(
      join(toolSource, "manifest.json"),
      JSON.stringify({
        id: "test.timestamp",
        name: "Test timestamp tool",
        apiVersion: 1,
      }),
    );
    run("pnpm", ["build"], toolSource);
    const toolCode = await readFile(join(toolSource, "dist/plugin.js"), "utf8");
    // The build must be possible after removing the unpacked producer tree.
    await rm(author, { recursive: true });
    run("pnpm", ["build"], source);
    const code = await readFile(join(source, "dist/plugin.js"), "utf8");
    expect(code).not.toMatch(/^import\s|^export.*from\s/m);
    const binary = nativeFixture();
    const home = join(temp, "home");
    const native = (op, ...args) =>
      JSON.parse(run(binary, [home, op, ...args]));
    await signPackage(join(source, "dist"));
    await signPackage(join(toolSource, "dist"));
    const installed = native("install", join(source, "dist"));
    expect(
      installed.catalog.plugins.find(
        (p) => p.manifest.id === "test.conversation-consumer",
      ).enabled,
    ).toBe(false);
    native("change", "enable", "test.conversation-consumer");
    const id = "test.timestamp";
    const toolInstalled = native("install", join(toolSource, "dist"));
    const firstRevision = toolInstalled.catalog.plugins.find(
      (p) => p.manifest.id === id,
    ).revision;
    expect(
      toolInstalled.catalog.plugins.find((p) => p.manifest.id === id).enabled,
    ).toBe(false);
    server = await createServer({
      root,
      configFile: false,
      envFile: false,
      plugins: [
        react(),
        {
          name: "isolated-native-manager-bridge",
          configureServer(server) {
            server.middlewares.use("/__proof", async (req, res) => {
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const body = chunks.length
                  ? JSON.parse(Buffer.concat(chunks).toString())
                  : {};
                let result;
                switch (req.url) {
                  case "/catalog":
                    result = native("catalog");
                    break;
                  case "/module":
                    result = native("module", body.id, body.revision);
                    break;
                  case "/change":
                    result = native("change", body.action, body.id);
                    break;
                  case "/update":
                    await writeFile(
                      join(toolSource, "dist/plugin.js"),
                      toolCode.replaceAll(
                        "Insert timestamp",
                        "Insert updated timestamp",
                      ),
                    );
                    await signPackage(join(toolSource, "dist"));
                    result = native("install", join(toolSource, "dist"));
                    break;
                  default:
                    throw new Error("Unsupported proof route");
                }
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(result));
              } catch (error) {
                res.statusCode = 500;
                res.end(String(error));
              }
            });
          },
        },
      ],
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    // The fixture loads every bundled plugin; compile it outside the
    // navigation budget, which parallel CI builds can otherwise exhaust.
    await warmUp(server, "/tests/fixtures/conversation.tsx");
    const errors = watchPageErrors(page);
    await page.route("**/proof-media/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="9" fill="purple"/></svg>',
      }),
    );
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/conversation.html`,
    );
    const draft = page.getByRole("textbox", { name: /Message #General/ });
    await expect(draft).toBeVisible();
    // Browser-only: host toolbar paint, focus, and panel integration must keep
    // the conversation's real editor and scroll position.
    const row = page
      .locator("[data-channel-timeline] [data-message-id]")
      .filter({ hasText: "History" })
      .first();
    const actions = row.getByRole("group", {
      name: "Message actions",
      includeHidden: true,
    });
    await draft.fill("Panel draft");
    const scroll = page.locator("[data-channel-timeline]");
    for (const mode of ["light", "dark"]) {
      await page.setViewportSize({
        width: mode === "light" ? 1440 : 800,
        height: 950,
      });
      await page.locator("html").evaluate((node, mode) => {
        node.style.fontSize = mode === "dark" ? "20px" : "";
      }, mode);
      await page.locator("html").evaluate((node, mode) => {
        node.dataset.colorMode = mode;
      }, mode);
      await scroll.hover();
      await page.mouse.wheel(0, -500);
      await settle(page, scroll);
      await row.evaluate((node) => node.scrollIntoView({ block: "center" }));
      await settle(page, scroll);
      await draft.focus();
      // Hover must not scroll the reading position on a hit-test retry.
      await hoverRow(
        page,
        row.locator("[data-message-action-anchor] p").first(),
        scroll,
      );
      const inspect = row.getByRole("button", { name: "Inspect message" });
      await expect(inspect).toBeVisible();
      await page.mouse.move(0, 0);
      await expectMessageActionsHidden(actions);
      await inspect.focus();
      await expect(inspect).toBeVisible();
      await settle(page, scroll);
      const before = await scroll.evaluate((node) => node.scrollTop);
      expect(before).toBeGreaterThan(0);
      await page.keyboard.press("Enter");
      await expect(
        page.getByText("Consumer message panel", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`plugin-panel-${mode}.png`),
      });
      await page.keyboard.press("Escape");
      await expect(
        page.getByText("Consumer message panel", { exact: true }),
      ).toHaveCount(0);
      await settle(page, scroll);
      await expect(draft).toHaveJSProperty("value", "Panel draft");
      expect(await scroll.evaluate((node) => node.scrollTop)).toBe(before);
      await row.getByRole("link", { name: "Inspect fixture" }).click();
      await expect(
        page.getByText("Consumer message panel", { exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.locator("html").evaluate((node) => {
      node.style.fontSize = "";
    });
    await draft.fill("");
    await expect(
      page
        .getByRole("navigation", { name: "Proof pages" })
        .getByRole("button", { name: "Test conversation consumer" }),
    ).toBeVisible();
    const editor = await draft.elementHandle();
    const tools = await page.evaluate(() => window.conversationFixture.tools());
    expect(
      tools.some((tool) => tool.startsWith("test.conversation-consumer/")),
    ).toBe(false);
    await expect(
      page.getByRole("button", { name: "Insert timestamp", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() =>
      window.conversationFixture.change(
        "disable",
        "test.conversation-consumer",
      ),
    );
    await expect(
      page
        .getByRole("navigation", { name: "Proof pages" })
        .getByRole("button", { name: "Test conversation consumer" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => window.conversationFixture.tools()),
    ).toEqual(tools);
    await page.evaluate(() =>
      window.conversationFixture.change("enable", "test.conversation-consumer"),
    );
    await expect(
      page
        .getByRole("navigation", { name: "Proof pages" })
        .getByRole("button", { name: "Test conversation consumer" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.conversationFixture.tools()),
    ).toEqual(tools);
    expect(await editor.evaluate((el) => el.isConnected)).toBe(true);
    await expect(
      page.getByRole("button", { name: "Insert timestamp", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() =>
      window.conversationFixture.change("enable", "test.timestamp"),
    );
    await expect(
      page.getByRole("button", { name: "Insert timestamp", exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "Insert timestamp", exact: true })
      .click();
    await expect
      .poll(() => draft.evaluate((element) => element.value))
      .toMatch(/T.*Z/);
    // Select through the editor after plugin insertion; WebKit fill can retain
    // the inserted content when its DOM selection has been lost.
    await draft.press("ControlOrMeta+A");
    await draft.pressSequentially("base");
    await expect(draft).toHaveJSProperty("value", "base");
    await draft.evaluate((el) => el.setSelectionRange(1, 3));
    await page
      .getByRole("button", { name: "Insert twice", exact: true })
      .click();
    await expect(draft).toHaveJSProperty("value", "bONETWOe");
    await expect(draft).toBeFocused();
    expect(await draft.evaluate((el) => el.selectionStart)).toBe(7);
    // Clear through the editor's keyboard contract. WebKit's fill("") can lose
    // its DOM selection after plugin insertion and delete only the next character.
    await draft.press("ControlOrMeta+A");
    await draft.press("Backspace");
    await expect(draft).toHaveJSProperty("value", "");
    await page
      .getByRole("button", { name: "Insert mixed", exact: true })
      .click();
    await expect(draft).toHaveJSProperty("value", "Hi @Member and @Member ");
    // Two authored spans preserve one exact notification identity.
    const member = await page.evaluate(() => window.conversationFixture.member);
    await expect(draft.locator(".inline-chip")).toHaveCount(2);
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(
            localStorage.getItem('buzz-view.v1:["a","draft:general"]'),
          ),
        ),
      )
      .toEqual({
        // The editor now persists its versioned document alongside the exact
        // text/recipient projection consumed by independently built plugins.
        document: {
          version: 1,
          content: expect.objectContaining({ type: "doc" }),
        },
        text: "Hi @Member and @Member ",
        recipients: [
          { pubkey: member, name: "Member", start: 3, end: 10 },
          { pubkey: member, name: "Member", start: 15, end: 22 },
        ],
      });
    await page.evaluate(() => window.conversationFixture.saveEdit());
    await page.evaluate(() => window.conversationFixture.removeProbe());
    expect(
      await page.evaluate(() => window.conversationFixture.removedResult()),
    ).toBe(false);
    expect(
      await page.evaluate(() =>
        window.conversationFixture.removedMentionResult(),
      ),
    ).toBe(false);
    await expect(draft).toHaveJSProperty("value", "Hi @Member and @Member ");
    await page.evaluate(() => window.conversationFixture.enableProbe());
    await expect(
      page.getByRole("button", { name: "Insert twice", exact: true }),
    ).toHaveCount(1);
    expect(
      await page.evaluate(() => window.conversationFixture.callSaved()),
    ).toBe(false);
    expect(
      await page.evaluate(() => window.conversationFixture.callSavedMention()),
    ).toBe(false);
    await draft.fill("Channels draft");
    await page
      .getByRole("navigation", { name: "Proof pages" })
      .getByRole("button", { name: "Test conversation consumer" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Test conversation consumer" }),
    ).toBeVisible();
    await expect(draft).toHaveJSProperty("value", "Channels draft");
    // The packed external consumer must reach native grouping and focus behavior,
    // not just compile declarations. Editor checks are composition smoke coverage.
    const groupingEditor = await draft.elementHandle();
    const replySummary = page.getByRole("button", {
      name: "View 1 reply",
    });
    await expect(replySummary).toHaveText("1 reply");
    await replySummary.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Example reply", { exact: true }),
    ).toBeFocused();
    expect(await groupingEditor.evaluate((el) => el.isConnected)).toBe(true);
    await page.getByRole("button", { name: "Collapse example reply" }).focus();
    await page.keyboard.press("Enter");
    await expect(replySummary).toBeFocused();
    await expect(page.getByText("Example reply", { exact: true })).toBeHidden();
    await expect(draft).toHaveJSProperty("value", "Channels draft");
    expect(await groupingEditor.evaluate((el) => el.isConnected)).toBe(true);
    // The independently built page uses the host's date labels.
    await expect(
      page.getByText("Consumer dates Today, Yesterday, 5 minutes ago", {
        exact: true,
      }),
    ).toBeVisible();
    // The independently built page consumes the host's registered Mentions tool.
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page
      .getByRole("button")
      .and(page.locator(`[data-mention-choice="${member}"]`))
      .click();
    const recipients = draft.locator(".inline-chip");
    await expect(recipients).toHaveCount(1);
    const withMention = await draft.evaluate((element) => element.value);
    const textarea = await draft.elementHandle();
    expect(
      await page.evaluate(() =>
        window.conversationFixture.change("disable", "buzz.mentions"),
      ),
    ).toBe(false);
    await expect(
      page.getByRole("button", { name: "Mention a member", exact: true }),
    ).toHaveCount(1);
    await expect(draft).toHaveJSProperty("value", withMention);
    await expect(recipients).toHaveCount(1);
    expect(await textarea.evaluate((el) => el.isConnected)).toBe(true);
    await draft.focus();
    await draft.evaluate((element) => {
      const start = element.value.indexOf("@Member");
      element.setSelectionRange(start, start + "@Member".length);
    });
    await draft.press("Backspace");
    await expect(recipients).toHaveCount(0);
    await expect(draft).toHaveJSProperty(
      "value",
      withMention.replace("@Member", ""),
    );
    await draft.fill("Channels draft");
    await draft.focus();
    await draft.evaluate((el) => el.setSelectionRange(2, 5));
    // Request a render without a click outside the picker (which dismisses it).
    await page.evaluate(() =>
      window.dispatchEvent(new Event("conversation-fixture-rerender")),
    );
    await expect(
      page.getByRole("button", { name: "Rerender consumer 1" }),
    ).toBeVisible();
    expect(await textarea.evaluate((el) => el.isConnected)).toBe(true);
    await expect(draft).toBeFocused();
    expect(
      await draft.evaluate((el) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([2, 5]);
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    const search = page.getByRole("searchbox", { name: "Search" });
    await search.fill("party");
    const picker = await page.locator("em-emoji-picker").elementHandle();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("conversation-fixture-rerender")),
    );
    await expect(
      page.getByRole("button", { name: "Rerender consumer 2" }),
    ).toBeVisible();
    expect(await picker.evaluate((el) => el.isConnected)).toBe(true);
    await expect(search).toHaveValue("party");
    await expect(search).toBeFocused();
    const historic = page.locator('img[src*="history.png"]');
    await expect(historic).toHaveCount(1);
    await expect(page.locator('img[src*="reaction.png"]')).toHaveCount(1);
    expect(
      await page.evaluate(() =>
        window.conversationFixture.change("disable", "buzz.emoji"),
      ),
    ).toBe(false);
    await expect(
      page.getByRole("button", { name: "Emoji and GIFS", exact: true }),
    ).toHaveCount(1);
    await expect(page.locator("em-emoji-picker")).toHaveCount(1);
    await expect(historic).toHaveCount(1);
    await expect(page.locator('img[src*="reaction.png"]')).toHaveCount(1);
    await page.keyboard.press("Escape");
    expect(await textarea.evaluate((el) => el.isConnected)).toBe(true);
    await expect(draft).toHaveJSProperty("value", "Channels draft");
    // A failed refresh keeps the loaded catalog; plugin-independent sends
    // still resolve its tags without asking for message preparation retry.
    await page.evaluate(() => window.conversationFixture.fail(true));
    await draft.fill(":party:");
    await draft.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.conversationFixture.report.published.length),
      )
      .toBe(1);
    expect(
      await page.evaluate(
        () => window.conversationFixture.report.signed[0].tags,
      ),
    ).toContainEqual(["emoji", "party", "https://a.test/media/current.png"]);
    await expect(
      page.getByRole("button", { name: "Retry message preparation" }),
    ).toHaveCount(0);
    await page.evaluate(() => window.conversationFixture.fail(false));
    await expect(
      page.getByRole("button", { name: "Emoji and GIFS", exact: true }),
    ).toHaveCount(1);
    await expect(historic).toHaveCount(1);
    await draft.fill("reject :party:");
    await draft.press("Enter");
    // Delivery feedback intentionally waits 10 seconds; leave time for the UI timer.
    const retryDelivery = page.getByRole("button", {
      name: "Retry",
      exact: true,
    });
    await expect(retryDelivery).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => window.conversationFixture.replace());
    await retryDelivery.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.conversationFixture.report.published.length),
      )
      .toBe(3);
    const report = await page.evaluate(() => window.conversationFixture.report);
    expect(report.published[1]).toEqual(report.published[2]);
    expect(report.signed).toHaveLength(2);
    expect(report.published[0].tags).toContainEqual([
      "emoji",
      "party",
      "https://a.test/media/current.png",
    ]);
    await expect(historic).toHaveAttribute("src", /a.test.*history.png/);
    await draft.fill("A-only draft");
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    await search.fill("party");
    await page.evaluate(() => window.conversationFixture.saveEdit());
    await page.evaluate(() => window.conversationFixture.switch());
    await expect(draft).toHaveJSProperty("value", "");
    await expect(page.locator("em-emoji-picker")).toHaveCount(0);
    await draft.fill("B draft");
    expect(
      await page.evaluate(() => window.conversationFixture.callSaved()),
    ).toBe(false);
    expect(
      await page.evaluate(() => window.conversationFixture.callSavedMention()),
    ).toBe(false);
    await expect(draft).toHaveJSProperty("value", "B draft");
    await page.evaluate(() => window.conversationFixture.update());
    await expect(
      page.getByRole("button", {
        name: "Insert updated timestamp",
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(draft).toHaveJSProperty("value", "B draft");
    const updated = native("catalog").catalog.plugins.find(
      (p) => p.manifest.id === id,
    );
    expect(updated.revision).not.toBe(firstRevision);
    expect(updated.previous).toBe(firstRevision);
    await page.evaluate(() =>
      window.conversationFixture.change("rollback", "test.timestamp"),
    );
    await expect(
      page.getByRole("button", { name: "Insert timestamp", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", {
        name: "Insert updated timestamp",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(draft).toHaveJSProperty("value", "B draft");
    await page.evaluate(() =>
      window.conversationFixture.change("disable", "test.timestamp"),
    );
    await expect(
      page.getByRole("button", { name: "Insert timestamp", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Test conversation consumer" }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.conversationFixture.change(
        "disable",
        "test.conversation-consumer",
      ),
    );
    await expect(
      page.getByRole("heading", { name: "Test conversation consumer" }),
    ).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "Proof pages" })
      .getByRole("button", { name: "Channels" })
      .click();
    await expect(draft).toHaveJSProperty("value", "B draft");
    expect(errors.unexplained()).toEqual([]);
    await writeFile(
      test.info().outputPath("boundary-proof.json"),
      JSON.stringify(
        { firstRevision, updatedRevision: updated.revision, report },
        null,
        2,
      ),
    );
  } finally {
    await server?.close();
    await rm(temp, { recursive: true, force: true });
  }
});
