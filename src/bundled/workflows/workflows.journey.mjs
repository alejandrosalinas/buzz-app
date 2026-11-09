import { test, expect } from "../../../tests/browser/playwright-test.mjs";
import { createServer } from "../../../tests/browser/vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { watchPageErrors } from "../../../tests/browser/page-errors.mjs";
import { settleDialogMotion } from "../../../tests/browser/navigation.mjs";

let server;
let url;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/src/bundled/workflows/fixture.html`;
});
test.afterAll(async () => {
  await server?.close();
});

// The landing status is empty only after every visible channel read settles.
const landingStatus = (page) => page.locator(".workflow-page-status");

// The editor dialog is titled by the workflow name, so find it by its region.
const editorDialog = (page) =>
  page
    .getByRole("dialog")
    .filter({ has: page.getByRole("region", { name: "Workflow editor" }) });

// The editor is a modal Dialog. Its focused inspector is an aside in wide
// containers and a nested sheet in narrow ones (including the 1000px default),
// so helpers use only controls reachable from the current layer.
function editorControls(page) {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const region = page.getByRole("region", { name: "Workflow editor" });
  const sequence = page.getByRole("list", { name: "Workflow sequence" });
  return {
    button,
    region,
    yaml: page.getByLabel("Workflow YAML", { exact: true }),
    message: page.getByLabel("Message text", { exact: true }),
    tab: (name) => page.getByRole("tab", { name, exact: true }),
    // Zero-step drafts show "Add step" in both the sequence and the footer.
    primary: (name) =>
      page.getByRole("contentinfo").getByRole("button", { name, exact: true }),
    // The name is a field in the workflow inspector, shown with no selection.
    expectName: (name) =>
      expect(
        region.getByRole("textbox", { name: "Workflow name", exact: true }),
      ).toHaveValue(name),
    async closeInspector() {
      const close = button("Close inspector");
      if (await close.count()) await close.click();
      await expect(close).toHaveCount(0);
    },
    async rename(name) {
      await this.closeInspector();
      const input = region.getByRole("textbox", {
        name: "Workflow name",
        exact: true,
      });
      await input.fill(name);
      await expect(input).toHaveValue(name);
    },
    openStep: (index, action = "Send Message") =>
      button(`Edit step ${index}: ${action}`).click(),
    async addStep(after, action) {
      await sequence
        .getByRole("button", {
          name: after ? `Add after Step ${after}` : "Add step",
          exact: true,
        })
        .click();
      await page
        .getByRole("menuitem", { name: `Add ${action}`, exact: true })
        .click();
    },
    async disclose(title) {
      const trigger = page.getByRole("button", {
        name: new RegExp(`^${title}`),
      });
      if ((await trigger.getAttribute("aria-expanded")) !== "true")
        await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
    },
    async action(name) {
      await button("Workflow actions").click();
      const item = page.getByRole("menuitem", { name, exact: true });
      await item.click();
      // Wait for Base UI's exit presence before reopening the same menu.
      // Otherwise the next assertion can target the previous, closing popup.
      await expect(page.getByRole("menu")).toHaveCount(0);
    },
    // Run now is a header button; one click publishes without confirmation.
    run: editorDialog(page).getByRole("button", {
      name: "Run now",
      exact: true,
    }),
    // Landing cards select on Open; the card overflow opens the editor.
    async open(name) {
      await page
        .getByRole("article")
        .getByRole("button", { name: `Actions for ${name}`, exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: /^(Edit|View) workflow$/ })
        .click();
      await expect(page.getByRole("menu")).toHaveCount(0);
    },
  };
}

test("workflow editor preserves YAML, resolves exact saves, retains conflicts and purges access", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(url);
  const editor = editorControls(page);
  const { button, yaml, tab } = editor;
  const finish = (...args) =>
    page.evaluate((args) => window.workflowFixture.finish(...args), args);
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowFixture.definitions.active()),
    )
    .toBe(1);
  await editor.open("Message helper");
  await tab("YAML").click();
  await expect
    .poll(() => yaml.inputValue())
    .toContain("# Keep this comment on opening");
  await tab("Form").click();
  await tab("YAML").click();
  await expect
    .poll(() => yaml.inputValue())
    .toContain("# Keep this comment on opening");
  await yaml.fill(
    (await yaml.inputValue()).replace("Hello from a fixture", "Edited text"),
  );
  await button("Save changes").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(1);
  // The fixture toolbar sits beneath the modal; call its controls directly.
  await finish("succeeded", false);
  await expect
    .poll(() => page.getByText(/waiting for a readback/).count())
    .toBe(1);
  expect(await button("Save changes").isDisabled()).toBe(true);
  expect(await yaml.inputValue()).toContain("Edited text");
  await finish("succeeded");
  await expect.poll(() => button("Save changes").isEnabled()).toBe(true);
  await tab("YAML").click();
  await yaml.fill(
    (await yaml.inputValue()).replace("Edited text", "Rejected draft"),
  );
  await button("Save changes").click();
  await finish("rejected");
  await expect
    .poll(() => page.getByText("Fixture conflict", { exact: true }).count())
    .toBe(1);
  expect(await yaml.inputValue()).toContain("Rejected draft");
  await button("Continue editing retained draft").click();
  expect(await button("Save changes").isEnabled()).toBe(true);
  await button("Close editor").click();
  await expect(
    page.getByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeVisible();
  await expect(button("Keep editing")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(button("Close editor")).toBeFocused();
  expect(await yaml.inputValue()).toContain("Rejected draft");
  await page.evaluate(() => window.workflowFixture.revoke());
  await expect
    .poll(() => page.getByRole("region", { name: "Workflow editor" }).count())
    .toBe(0);
  expect(await page.getByText("Rejected draft", { exact: false }).count()).toBe(
    0,
  );
  await page.reload();
  await page.evaluate(() =>
    window.workflowFixture.definitions.update({
      status: "ready",
      data: { items: [], partial: false },
    }),
  );
  const empty = page.locator(".buzz-empty-state");
  await expect(
    empty.getByText("Automations that keep your community moving."),
  ).toBeVisible();
  await expect(
    page.getByText(/Creating and saving workflows is unavailable/),
  ).toHaveCount(0);
  await empty.getByRole("button", { name: "New workflow" }).click();
  // Creation opens on the trigger; dismiss it to reach the editor header.
  await editor.closeInspector();
  expect(
    await page
      .getByRole("switch", { name: /^Enabled in configuration$/ })
      .getAttribute("aria-checked"),
  ).toBe("false");
  await editor.rename("Incomplete editor");
  await editor.primary("Add step").click();
  await editor.message.fill("Keyboard-created text");
  await editor.closeInspector();
  await expect.poll(() => button("Create workflow").isEnabled()).toBe(true);
  await tab("YAML").click();
  expect(await yaml.inputValue()).toContain("enabled: false");
  await yaml.fill(
    (await yaml.inputValue()).replace("on: message_posted", "on: webhook"),
  );
  // Webhook drafts save like any other; the relay issues the secret on the first save.
  await expect(button("Create workflow")).toBeEnabled();
  await expect(
    page.getByText(/Webhook-trigger saves are unavailable/),
  ).toHaveCount(0);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  // Dialog actions use the floating control recipe, distinct from their surface.
  await expect(
    page.getByRole("dialog", { name: "Create workflow", exact: true }),
  ).toHaveCSS("background-color", "rgb(40, 40, 40)");
  await expect(
    page.getByRole("dialog", { name: "Create workflow", exact: true }),
  ).toHaveCSS("backdrop-filter", "none");
  // Wait for the shared control transition before checking its final paint.
  await expect(button("Cancel")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(button("Cancel")).toHaveCSS(
    "background-color",
    "rgb(64, 64, 64)",
  );
  await yaml.focus();
  await page.keyboard.press("ArrowLeft");
  // DESIGN.md's temporary global no-outline policy owns the ring; this
  // journey only checks keyboard interaction keeps focus in the editor.
  await expect(yaml).toBeFocused();
  // Unmount with the unsaved draft still open.
  await page.evaluate(() => window.workflowFixture.unmount());
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowFixture.definitions.disposed()),
    )
    .toBe(true);
  expect(errors.unexplained()).toEqual([]);
});

// Real layout and native menu focus cannot be established by jsdom.
test("existing workflow enablement uses the inspector switch beside header actions", async ({
  page,
}, testInfo) => {
  await page.goto(url);
  await editorControls(page).open("Message helper");
  const dialog = page.getByRole("dialog", {
    name: "Message helper",
    exact: true,
  });
  const run = dialog.getByRole("button", { name: "Run now", exact: true });
  const actions = dialog.getByRole("button", { name: "Workflow actions" });
  const close = dialog.getByRole("button", { name: "Close editor" });
  const enable = dialog
    .getByRole("complementary", { name: "Workflow settings" })
    .getByRole("switch", { name: "Enabled in configuration", exact: true });
  // Compare header controls in the settled frame, not during entrance motion.
  await settleDialogMotion(dialog);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const runBox = await run.boundingBox();
    const actionBox = await actions.boundingBox();
    const closeBox = await close.boundingBox();
    expect(runBox.x + runBox.width).toBeLessThanOrEqual(actionBox.x);
    expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(closeBox.x);
    expect(Math.abs(actionBox.y - closeBox.y)).toBeLessThan(10);
    expect(
      Math.abs(
        runBox.y + runBox.height / 2 - (closeBox.y + closeBox.height / 2),
      ),
    ).toBeLessThan(10);
    await actions.focus();
    await page.keyboard.press("Enter");
    const remove = page.getByRole("menuitem", {
      name: "Delete workflow",
      exact: true,
    });
    // Opening the popup does not finish its initial keyboard-focus handoff.
    await expect(remove).toBeFocused();
    await page.keyboard.press("Home");
    await expect(remove).toBeFocused();
    const menuBox = await page.getByRole("menu").boundingBox();
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`header-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(actions).toBeFocused();
    await expect(dialog).toBeVisible();
    await enable.focus();
    await expect(enable).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(enable).toBeChecked();
    expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(
      0,
    );
    await page.keyboard.press("Space");
    await expect(enable).not.toBeChecked();
    await expect(dialog).toBeVisible();
  }
  // Enlarged text wraps the title instead of running under header actions.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "150%";
  });
  const titleRight = await dialog
    .getByRole("heading", { name: "Message helper", exact: true })
    .evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return Math.max(...[...range.getClientRects()].map((rect) => rect.right));
    });
  expect(titleRight).toBeLessThanOrEqual((await run.boundingBox()).x);
});

test("keyboard switches feed enabled-save confirmation and disabled readback", async ({
  page,
  browserName,
}) => {
  const errors = watchPageErrors(page);
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // Wide layout: the inspector sits beside the flow, so its controls and the
  // footer share one keyboard layer.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  const editor = editorControls(page);
  const { button } = editor;
  const enabled = page.getByRole("switch", {
    name: /^Enabled in configuration$/,
  });
  const reply = page.getByRole("switch", {
    name: "Reply in the triggering thread",
  });
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const focusByTab = async (control) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await control.evaluate((node) => node === document.activeElement))
        return;
      await page.keyboard.press(tab);
    }
    await expect(control).toBeFocused();
  };
  // Create and edit both keep enablement in the workflow inspector.
  const focusEnabled = async () => {
    await editor.closeInspector();
    await focusByTab(enabled);
  };
  // Reply lives in step 1's Run controls disclosure.
  const openReply = async () => {
    await editor.openStep(1);
    await editor.disclose("Run controls");
  };
  const saves = () => page.evaluate(() => window.workflowFixture.calls.save);
  const savedYaml = async () =>
    parseYaml(await page.evaluate(() => window.workflowFixture.input().yaml));

  await button("New workflow").click();
  await editor.rename("Keyboard workflow");
  await editor.primary("Add step").click();
  await editor.message.fill("Offline only");
  await focusEnabled();
  await expect(enabled).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(enabled).toBeChecked();
  await page.keyboard.press("Enter");
  await expect(enabled).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(enabled).toBeChecked();

  await openReply();
  await focusByTab(reply);
  await page.keyboard.press("Enter");
  await expect(reply).toBeChecked();
  await page.keyboard.press("Space");
  await expect(reply).not.toBeChecked();
  await page.keyboard.press("Enter");
  await expect(reply).toBeChecked();
  await focusByTab(button("Create workflow"));
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("It will run for every new message");
  await expect(button("Save enabled workflow")).toBeFocused();
  expect(await saves()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button("Create workflow")).toBeFocused();
  expect(await saves()).toBe(0);
  await page.keyboard.press("Space");
  await expect(button("Save enabled workflow")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(saves).toBe(1);
  expect((await savedYaml()).enabled).not.toBe(false);
  expect((await savedYaml()).steps[0].reply_in_thread).toBe(true);
  await expect(reply).toBeDisabled();
  await reply.press("Enter");
  await expect(reply).toBeChecked();
  await editor.closeInspector();
  await expect(enabled).toBeDisabled();
  await enabled.click({ force: true });
  await enabled.press("Space");
  await expect(enabled).toBeChecked();
  expect(await saves()).toBe(1);

  // The offline capability supplies the exact asynchronous receipt/readback.
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(button("Save changes")).toBeEnabled();
  await focusEnabled();
  await expect(enabled).toBeChecked();
  await openReply();
  await expect(reply).toBeChecked();
  await editor.message.fill("Ordinary enabled edit");
  await button("Save changes").click();
  await expect.poll(saves).toBe(2);
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(button("Save changes")).toBeEnabled();
  await focusEnabled();
  await page.keyboard.press("Enter");
  await expect(enabled).not.toBeChecked();
  await openReply();
  await focusByTab(reply);
  await page.keyboard.press("Space");
  await expect(reply).not.toBeChecked();
  await focusByTab(button("Save changes"));
  await page.keyboard.press("Enter");
  await expect.poll(saves).toBe(3);
  await expect(dialog).toHaveCount(0);
  expect((await savedYaml()).enabled).toBe(false);
  expect((await savedYaml()).steps[0].reply_in_thread).not.toBe(true);
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await focusEnabled();
  await expect(enabled).toBeEnabled();
  await expect(enabled).not.toBeChecked();
  await openReply();
  await expect(reply).not.toBeChecked();
  await focusEnabled();
  await enabled.click();
  await button("Save changes").click();
  await expect(dialog).toContainText("It will run for every new message");
  expect(await saves()).toBe(3);
  await page.keyboard.press("Escape");
  expect([...errors.unexplained(), ...consoleErrors]).toEqual([]);
});

test("history stays lazy and paged; an unknown run never repeats or locks", async ({
  page,
}) => {
  await page.goto(url);
  const editor = editorControls(page);
  const { button } = editor;
  await editor.open("Message helper");
  expect(await page.evaluate(() => window.workflowFixture.calls.runs)).toBe(0);
  await editor.tab("Runs").click();
  await expect(page.getByText("Current step: 1")).toBeVisible();
  await button("Older runs").click();
  await expect(page.getByText("No runs returned on this page.")).toBeVisible();
  expect(await page.evaluate(() => window.workflowFixture.runCursor())).toEqual(
    {
      before: "2026-09-12T12:00:00.123456Z",
      beforeId: "77777777-7777-4777-8777-777777777777",
    },
  );
  expect(
    await page.evaluate(() =>
      window.workflowFixture.runViews
        .slice(0, -1)
        .every((view) => view.disposed()),
    ),
  ).toBe(true);
  await editor.tab("Form").click();
  expect(
    await page.evaluate(() =>
      window.workflowFixture.runViews.every((view) => view.disposed()),
    ),
  ).toBe(true);
  await editor.run.click();
  // No confirmation: one click is exactly one trigger.
  expect(await page.evaluate(() => window.workflowFixture.calls.trigger)).toBe(
    1,
  );
  await page.evaluate(() => window.workflowFixture.finish("unknown"));
  // Like base Buzz, a lost run receipt informs but never locks the workflow.
  await expect(editor.run).toBeEnabled();
  await expect(page.getByText(/The run may have started/)).toBeVisible();
  await button("Close editor").click();
  await editor.open("Message helper");
  await expect(editor.run).toBeEnabled();
  await expect(button("Save changes")).toBeEnabled();
  expect(await page.evaluate(() => window.workflowFixture.calls.trigger)).toBe(
    1,
  );
});

test("real session page under StrictMode fences community changes, warns before discarding a dirty draft and purges access", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(url.replace("/fixture.html", "/session-fixture.html"));
  const editor = editorControls(page);
  const { button } = editor;
  const choose = async (name) => {
    await page.getByRole("button", { name: /^Channels(?::|$)/ }).click();
    await page.getByRole("checkbox", { name, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Channels" })).toHaveCount(0);
  };
  // The modal hides the fixture toolbar; call its closures directly.
  const fixture = (name) =>
    page.evaluate((name) => window.workflowSessionFixture[name](), name);
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await expect(button("New workflow")).toBeDisabled();
  await expect(button(/^Open Fixture A helper:/)).toBeVisible();
  await expect(
    page.getByRole("switch", {
      name: "Enabled in configuration: Fixture A helper",
      exact: true,
    }),
  ).toBeDisabled();
  await editor.open("Fixture A helper");
  await expect(editor.region).toBeVisible();
  await button("Close editor").click();
  await expect(button(/^Open Fixture A helper:/)).toBeVisible();
  await choose("First channel");
  await expect(button("New workflow")).toBeDisabled();
  await editor.open("Fixture A helper");
  await expect(
    editorDialog(page)
      .getByRole("status")
      .getByText("Saving is unavailable from this host.", { exact: true }),
  ).toBeVisible();
  await expect(button("Save changes")).toBeDisabled();
  await editor.rename("Unsaved private text");
  await button("Close editor").click();
  const leave = page.getByRole("alertdialog", { name: "Leave this draft?" });
  await expect(leave).toBeVisible();
  await button("Keep editing").click();
  await editor.expectName("Unsaved private text");
  await button("Close editor").click();
  await leave.getByRole("button", { name: "Leave draft", exact: true }).click();
  await expect(editor.region).toHaveCount(0);
  await page.getByRole("button", { name: /^Channels(?::|$)/ }).click();
  await expect(
    page.getByRole("checkbox", { name: "First channel", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Second channel", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Channels" })).toHaveCount(0);
  await choose("First channel");
  await editor.open("Fixture A helper");
  await fixture("switchCommunity");
  await expect(editor.region).toHaveCount(0);
  await choose("First channel");
  await editor.open("Fixture B helper");
  await fixture("switchCommunity");
  await choose("First channel");
  await editor.open("Fixture A helper");
  await editor.rename("Revoked private text");
  await fixture("revokeSelectedChannel");
  await expect(editor.region).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(
    "Revoked private text",
  );
  expect(errors.unexplained()).toEqual([]);
});

test("an empty read-only landing keeps only the disabled header create action", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?empty"));
  await expect(
    page.getByText("Automations that keep your community moving.", {
      exact: true,
    }),
  ).toBeVisible();
  const create = page.getByRole("button", {
    name: "New workflow",
    exact: true,
  });
  await expect(create).toHaveCount(1);
  await expect(create).toBeDisabled();
});

test("landing batches 129 channels into two workflow reads", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?many"));
  await expect(
    page.getByRole("button", { name: /^Open Fixture A helper:/, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.definitionQueries()),
    )
    .toBe(2);
  expect(errors.unexplained()).toEqual([]);
});

// Real keyboard focus and portal identity need the browser, beyond the DOM test.
test("unrelated channel membership preserves the focused workflow detail", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  await expect(landingStatus(page)).toHaveText("");
  await page.getByRole("button", { name: /^Open Fixture A helper:/ }).click();
  const detail = page.getByRole("region", {
    name: "Fixture A helper",
    exact: true,
  });
  const original = await detail.elementHandle();
  const run = detail.getByRole("button", { name: "Run now", exact: true });
  await run.focus();
  await page.keyboard.press("ArrowRight");
  await expect(run).toBeFocused();
  await page.evaluate(() =>
    window.workflowSessionFixture.joinUnrelatedChannel(),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workflowSessionFixture.definitionChannelCount(),
      ),
    )
    .toBe(3);
  await expect(landingStatus(page)).toHaveText("");
  expect(await original.evaluate((element) => element.isConnected)).toBe(true);
  expect(
    await detail.evaluate(
      (element, previous) => element === previous,
      original,
    ),
  ).toBe(true);
  await expect(run).toBeFocused();
});

test("landing scan survives channel presentation churn without restarting", async ({
  page,
}) => {
  await page.goto(
    url.replace("/fixture.html", "/session-fixture.html?many&hold"),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.definitionReadHeld()),
    )
    .toBe(true);
  const startedReads = await page.evaluate(() =>
    window.workflowSessionFixture.definitionQueries(),
  );
  const create = page.getByRole("button", {
    name: "New workflow",
    exact: true,
  });
  const open = page.getByRole("button", {
    name: /^Open Fixture A helper:/,
    exact: true,
  });
  await expect(open).toBeVisible();
  // Browser-only boundary: progressive empty results must not move either
  // actionable card under the pointer. Reads remain held until after metadata.
  // Visibility can arrive during the group's entrance scale; capture its
  // baseline only once that real animation has reached the resting geometry.
  const group = page.locator(".workflow-list-transition").filter({ has: open });
  await expect(group).toHaveCSS("opacity", "1");
  await expect(group).toHaveCSS("transform", "none");
  const createBounds = await create.boundingBox();
  const openBounds = await open.boundingBox();
  try {
    await expect(page.getByRole("status")).toHaveText("Reading workflows…");
    for (let index = 1; index <= 8; index++) {
      await page.evaluate(() =>
        window.workflowSessionFixture.renameFirstChannel(),
      );
      await expect(
        page.getByRole("heading", {
          name: `${index % 2 ? "Z-last" : "A-first"} channel ${index}`,
          exact: true,
        }),
      ).toBeVisible();
    }
    expect(
      await page.evaluate(() =>
        window.workflowSessionFixture.definitionQueries(),
      ),
    ).toBe(startedReads);
    expect(await create.boundingBox()).toEqual(createBounds);
    expect(await open.boundingBox()).toEqual(openBounds);
  } finally {
    await page.evaluate(() =>
      window.workflowSessionFixture.releaseDefinitionRead(),
    );
  }
  await expect(landingStatus(page)).toHaveText("");
  expect(
    await page.evaluate(() =>
      window.workflowSessionFixture.definitionChannelCount(),
    ),
  ).toBe(129);
  expect(
    await page.evaluate(() =>
      window.workflowSessionFixture.definitionQueries(),
    ),
  ).toBe(2);
  expect(await create.boundingBox()).toEqual(createBounds);
  expect(await open.boundingBox()).toEqual(openBounds);
});

test("a failed landing scan shows one recovery action instead of an error-card grid", async ({
  page,
}) => {
  await page.goto(
    url.replace("/fixture.html", "/session-fixture.html?many&hold"),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.definitionReadHeld()),
    )
    .toBe(true);
  const open = page.getByRole("button", {
    name: /^Open Fixture A helper:/,
    exact: true,
  });
  await expect(open).toBeVisible();
  await page.evaluate(() => window.workflowSessionFixture.failDefinitionRead());
  await expect(page.getByRole("status")).toContainText(
    "Workflow discovery paused.",
  );
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toHaveCount(1);
  await expect(page.locator(".workflow-collection > *")).toHaveCount(1);
  // Browser-only acceptance: the real card stays onscreen, not buried beneath
  // per-channel failure tiles. Recovery uses the real session/reader boundary.
  await expect(open).toBeInViewport();
  await expect(retry).toBeInViewport();
  expect(
    await page.evaluate(() =>
      window.workflowSessionFixture.definitionQueries(),
    ),
  ).toBe(2);
  await retry.click();
  await expect(landingStatus(page)).toHaveText("");
  await expect(retry).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.workflowSessionFixture.definitionQueries(),
    ),
  ).toBe(3);
  expect(
    await page.evaluate(() =>
      window.workflowSessionFixture.definitionChannelCount(),
    ),
  ).toBe(129);
  await expect(open).toBeInViewport();
});

// Breakpoint focus fixup happens only in a real layout engine.
test("keyboard focus follows an open detail into the narrow layout and back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url.replace("/fixture.html", "/session-fixture.html"));
  const open = page.getByRole("button", {
    name: /^Open Fixture A helper:/,
    exact: true,
  });
  const tab = page
    .getByRole("complementary")
    .getByRole("tab", { name: "Fixture A helper", exact: true });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(tab).toBeVisible();
  await expect(open).toBeFocused();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(open).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Fixture A helper details", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("clearing the session cache purges landing workflow definitions", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html"));
  const open = page.getByRole("button", {
    name: /^Open Fixture A helper:/,
    exact: true,
  });
  await expect(open).toBeVisible();
  await page
    .getByRole("button", { name: "Clear session cache", exact: true })
    .click();
  await expect(open).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(
    "Fixture A helper",
  );
});

test("landing discards an opened definition when channel access is revoked", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html"));
  const editor = editorControls(page);
  const { button } = editor;
  await editor.open("Fixture A helper");
  await editor.rename("Revoked landing draft");
  await page.evaluate(() =>
    window.workflowSessionFixture.revokeSelectedChannel(),
  );
  await expect(editor.region).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(
    "Revoked landing draft",
  );
  await page.evaluate(() => window.workflowSessionFixture.restoreAccess());
  await expect(button(/^Open Fixture A helper:/)).toBeVisible();
  await editor.open("Fixture A helper");
  await editor.expectName("Fixture A helper");
});

test("landing activation confirms once and locks while delivery is unresolved", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const enable = page.getByRole("switch", {
    name: "Enabled in configuration: Fixture A helper",
    exact: true,
  });
  await enable.click();
  await expect(
    page.getByRole("alertdialog", { name: "This workflow may run often" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(1);
    await expect(enable).toBeDisabled();
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.reject());
  }
  await expect(enable).toBeEnabled();
  expect(
    await page.evaluate(() => window.workflowSessionFixture.publications()),
  ).toBe(1);
});

// Keyboard focus order and the card overlay's pointer targets require browser
// layout/default actions, which jsdom does not implement.
test("restricted cards and read-only editors keep keyboard controls without disclosures", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url.replace("/fixture.html", "/session-fixture.html"));
  // Owner text needs real layout: jsdom cannot detect a zero-width label at
  // narrow widths with enlarged text and fixed artwork/action siblings.
  const ownerLabel = page.locator(".workflow-card-owner");
  for (const theme of ["dark", "light"]) {
    for (const fontSize of [20, 32]) {
      await page.evaluate(
        ({ theme, fontSize }) => {
          document.documentElement.dataset.colorMode = theme;
          document.documentElement.style.fontSize = `${fontSize}px`;
        },
        { theme, fontSize },
      );
      await expect(ownerLabel).toBeVisible();
      await expect
        .poll(() =>
          ownerLabel.evaluate(
            (node) =>
              node.clientWidth > 0 && node.scrollWidth <= node.clientWidth,
          ),
        )
        .toBe(true);
      // A short owner identifier may wrap, but must not become a tall column
      // of single characters when artwork and controls consume its width.
      await expect
        .poll(() =>
          ownerLabel.evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return new Set([...range.getClientRects()].map((rect) => rect.top))
              .size;
          }),
        )
        .toBeLessThanOrEqual(2);
      await page
        .getByRole("button", { name: "Actions for Fixture A helper" })
        .click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Actions for Fixture A helper" }),
      ).toBeFocused();
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const open = page.getByRole("button", {
    name: /^Open Fixture A helper:/,
    exact: true,
  });
  const actions = page.getByRole("button", {
    name: "Actions for Fixture A helper",
  });
  const reason = page.getByText("Saving is unavailable from this host.", {
    exact: true,
  });
  await expect(page.locator(".workflow-card details")).toHaveCount(0);
  await expect(
    page.getByRole("switch", {
      name: "Enabled in configuration: Fixture A helper",
    }),
  ).toHaveAccessibleDescription("Saving is unavailable from this host.");
  await expect(reason).toBeHidden();
  await open.focus();
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.keyboard.press(tab);
    if (await actions.evaluate((node) => node === document.activeElement))
      break;
  }
  await expect(actions).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await actions.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  // Open selects the card; at this width its detail replaces the grid.
  await open.click();
  await page
    .getByRole("region", { name: "Fixture A helper", exact: true })
    .getByRole("button", { name: "Edit workflow", exact: true })
    .click();
  await expect(editorDialog(page)).toBeVisible();

  await page.goto(url);
  await page.evaluate(() => {
    const fixture = window.workflowFixture;
    const view = fixture.capability.definitions(
      "44444444-4444-4444-8444-444444444444",
    );
    const snapshot = view.snapshot();
    view.dispose();
    fixture.definitions.update({
      ...snapshot,
      data: {
        ...snapshot.data,
        items: snapshot.data.items.map((item) => ({
          ...item,
          owner: "22".repeat(32),
        })),
      },
    });
  });
  await page.getByRole("button", { name: "Owner: My workflows" }).click();
  await page.getByRole("radio", { name: "All channel workflows" }).click();
  await editorControls(page).open("Message helper");
  const dialog = page.getByRole("dialog", { name: "Message helper" });
  await expect(dialog.getByText("Read-only", { exact: true })).toHaveCount(0);
  // Read-only editors explain why Delete is unavailable in their actions menu.
  const readOnlyActions = dialog.getByRole("button", {
    name: "Workflow actions",
    exact: true,
  });
  await readOnlyActions.focus();
  await page.keyboard.press("Enter");
  const deleteAction = page.getByRole("menuitem", {
    name: "Delete workflow",
    exact: true,
  });
  await expect(deleteAction).toBeDisabled();
  await expect(deleteAction).toHaveAccessibleDescription(
    "Only the author or their verified agent owner can delete this workflow.",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(readOnlyActions).toBeFocused();
  await expect(dialog.getByRole("tab", { name: "Runs" })).toBeVisible();
  const name = dialog.getByRole("textbox", { name: "Workflow name" });
  await expect(name).toBeDisabled();
  await expect(name).toHaveAccessibleDescription(/Only the author/);
  const enable = dialog.getByRole("switch", {
    name: "Enabled in configuration",
    exact: true,
  });
  await expect(enable).toBeDisabled();
  await expect(enable).toHaveAccessibleDescription(/Only the author/);
  await dialog.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Workflow YAML" }),
  ).toHaveAttribute("readonly", "");
  await expect(dialog.getByRole("contentinfo")).toHaveCount(0);
  await expect(
    dialog.getByRole("tab", { name: "Form", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("tab", { name: "YAML", exact: true }),
  ).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await dialog
    .getByRole("button", { name: "Close editor", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  // Closing returns focus to the card menu that opened the editor.
  const reopen = page.getByRole("button", {
    name: "Actions for Message helper",
    exact: true,
  });
  await expect(reopen).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "View workflow", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(reopen).toBeFocused();
});

test("landing keeps a succeeded toggle locked until its exact revision is read back", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const enable = page.getByRole("switch", {
    name: "Enabled in configuration: Fixture A helper",
    exact: true,
  });
  await enable.click();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(1);
  await page.evaluate(() => window.workflowSessionFixture.settle());
  await expect(enable).toBeDisabled();
  await page.evaluate(() => window.workflowSessionFixture.readback());
  await page
    .getByRole("button", { name: "Refresh workflows", exact: true })
    .click();
  await expect(
    page.getByRole("switch", {
      name: "Enabled in configuration: Fixture A helper",
      exact: true,
    }),
  ).toBeEnabled();
});

for (const from of ["grid", "detail"]) {
  test(`deletion from ${from} stays on the grid while the session reconciles removal`, async ({
    page,
  }) => {
    await page.goto(
      url.replace(
        "/fixture.html",
        `/session-fixture.html?writes${from === "detail" ? "&hold-editor" : ""}`,
      ),
    );
    const editor = editorControls(page);
    const { button } = editor;
    let editorMounted = false;
    if (from === "detail") {
      await expect(landingStatus(page)).toHaveText("");
      await page.evaluate(() =>
        window.workflowSessionFixture.holdNextEditorRead(),
      );
      await editor.open("Fixture A helper");
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.workflowSessionFixture.definitionReadHeld(),
          ),
        )
        .toBe(true);
      await editor.rename("Unsaved name");
      await editor.action("Delete workflow");
    } else {
      // Observe all DOM mutations, including a detail that mounts and closes between assertions.
      await page.evaluate(() => {
        window.deletionEditorMounted = false;
        window.deletionObserver = new MutationObserver((records) => {
          for (const record of records)
            for (const node of record.addedNodes)
              if (
                node instanceof Element &&
                (node.matches('[aria-label="Workflow editor"]') ||
                  node.querySelector('[aria-label="Workflow editor"]'))
              )
                window.deletionEditorMounted = true;
        });
        window.deletionObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
      });
      await button("Actions for Fixture A helper").click();
      await page
        .getByRole("menuitem", { name: "Delete workflow", exact: true })
        .click();
      await expect(editorDialog(page)).toHaveCount(0);
    }
    const confirm = page.getByRole("alertdialog", {
      name: "Delete this workflow?",
    });
    await expect(
      confirm.getByRole("button", { name: "Delete workflow", exact: true }),
    ).toHaveAttribute("data-variant", "destructive");
    await confirm
      .getByRole("button", { name: "Delete workflow", exact: true })
      .click();
    try {
      await expect
        .poll(() =>
          page.evaluate(() => window.workflowSessionFixture.publications()),
        )
        .toBe(1);
      await expect(editorDialog(page)).toHaveCount(0);
      await expect(
        page.getByRole("alertdialog", { name: "Leave this draft?" }),
      ).toHaveCount(0);
      await expect(button(/^Open Fixture A helper:/)).toBeDisabled();
      await expect(page.getByText("Deleting…", { exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => window.workflowSessionFixture.operations().at(-1)?.outcome,
        ),
      ).toBe("pending");
      await button("Actions for Fixture A helper").click();
      await expect(
        page.getByRole("menuitem", { name: "Delete workflow", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
    } finally {
      await page.evaluate(() => {
        window.workflowSessionFixture.releaseDefinitionRead();
        window.workflowSessionFixture.settleDelete(true);
      });
    }
    await expect
      .poll(() =>
        page.evaluate(
          () => window.workflowSessionFixture.operations().at(-1)?.outcome,
        ),
      )
      .toBe("succeeded");
    await expect(button(/^Open Fixture A helper:/)).toHaveCount(0);
    await expect(landingStatus(page)).toHaveText("");
    await expect(page.getByText(/^Couldn't confirm deletion/)).toHaveCount(0);
    if (from === "grid")
      editorMounted = await page.evaluate(() => {
        window.deletionObserver.disconnect();
        return window.deletionEditorMounted;
      });
    expect(editorMounted).toBe(false);
    // The header action; the settled empty state repeats it.
    await button("New workflow").first().click();
    await expect(
      page.getByRole("dialog", { name: "Create workflow" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.workflowSessionFixture.publications()),
    ).toBe(1);
  });
}

test("rejected deletion shows a toast, restores the card, and permits one deliberate retry", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const button = editorControls(page).button;
  const remove = async () => {
    await button("Actions for Fixture A helper").click();
    await page
      .getByRole("menuitem", { name: "Delete workflow", exact: true })
      .click();
    await button("Delete workflow").click();
  };
  await remove();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(1);
  await page.evaluate(() => window.workflowSessionFixture.reject());
  await expect(
    page.getByText("Couldn't delete Fixture A helper", { exact: true }),
  ).toBeVisible();
  await expect(button(/^Open Fixture A helper:/)).toBeEnabled();
  await expect(
    page.getByRole("switch", {
      name: "Enabled in configuration: Fixture A helper",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(editorDialog(page)).toHaveCount(0);
  await remove();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(2);
  await expect(
    page.getByText("Couldn't delete Fixture A helper", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.workflowSessionFixture.echoPublished());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workflowSessionFixture
            .operations()
            .find((operation) => operation.outcome !== "rejected")?.delivery,
      ),
    )
    .toBe("seen");
  await expect(
    page.getByText("Couldn't delete Fixture A helper", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.workflowSessionFixture.settleDelete(true));
  await expect(button(/^Open Fixture A helper:/)).toHaveCount(0);
  await expect(page.getByText(/^Couldn't delete/)).toHaveCount(0);
  expect(
    await page.evaluate(() => window.workflowSessionFixture.publications()),
  ).toBe(2);
});

test("a lost save response can be checked and adopted without resubmitting", async ({
  page,
}) => {
  await page.goto(url);
  const editor = editorControls(page);
  const { button } = editor;
  await editor.open("Message helper");
  await editor.rename("Saved without response");
  await button("Save changes").click();
  const reads = () =>
    page.evaluate(() => window.workflowFixture.definitions.created());
  const before = await reads();
  await page.evaluate(() => window.workflowFixture.finish("unknown"));
  // The landing rereads after an unknown save; the relay has no copy yet,
  // so only the later manual check can find the saved revision.
  await expect.poll(reads).toBeGreaterThan(before);
  await expect(button("Save changes")).toBeDisabled();
  await page.evaluate(() => window.workflowFixture.saveOnServer());
  await button("Check saved configuration").click();
  await expect(button("Save changes")).toBeEnabled();
  await editor.expectName("Saved without response");
  expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(1);
  await editor.openStep(1);
  await editor.message.fill("Edit after recovery");
  await editor.closeInspector();
  await button("Save changes").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(2);
});

test("different-head recovery needs explicit review; failed dismissal keeps the draft locked", async ({
  page,
}) => {
  await page.goto(url);
  const editor = editorControls(page);
  const { button } = editor;
  await editor.open("Message helper");
  await editor.rename("Retained local draft");
  await button("Save changes").click();
  await page.evaluate(() => {
    window.workflowFixture.saveOnServer(false);
    window.workflowFixture.finish("unknown");
  });
  await button("Check saved configuration").click();
  await expect(button("Save changes")).toBeDisabled();
  await expect(button("Review current configuration")).toBeVisible();
  await button("Dismiss notice").click();
  await page.keyboard.press("Escape");
  await expect(button("Save changes")).toBeDisabled();
  expect(
    await page.evaluate(() => window.workflowFixture.calls.dismiss),
  ).toEqual([]);
  await page.evaluate(() =>
    window.workflowFixture.setDismissError("Fixture dismissal failed"),
  );
  await button("Dismiss notice").click();
  await button("Dismiss notice and continue").click();
  await expect(page.getByRole("alert")).toHaveText("Fixture dismissal failed");
  await page.keyboard.press("Escape");
  await expect(button("Save changes")).toBeDisabled();
  await page.evaluate(() => window.workflowFixture.setDismissError());
  await button("Dismiss notice").click();
  await button("Dismiss notice and continue").click();
  await expect(button("Save changes")).toBeEnabled();
  await editor.expectName("Retained local draft");
  expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(1);
  await button("Save changes").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(2);
});

test("durable dismissal keeps confirmation mounted until persistence settles", async ({
  page,
}) => {
  await page.goto(url);
  const editor = editorControls(page);
  const { button } = editor;
  await editor.open("Message helper");
  await editor.rename("Kept draft");
  await button("Save changes").click();
  await page.evaluate(() => window.workflowFixture.finish("unknown"));
  const operationId = await page.evaluate(
    () => window.workflowFixture.capability.operations.snapshot()[0].eventId,
  );
  const dialog = page.getByRole("alertdialog", {
    name: "Dismiss this notice?",
  });
  for (const fail of [true, false]) {
    await page.evaluate((fail) => {
      window.workflowFixture.setDismissError(
        fail ? "Journal unavailable" : undefined,
      );
      window.workflowFixture.holdDismiss();
    }, fail);
    await button("Dismiss notice").click();
    try {
      await button("Dismiss notice and continue").click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.workflowFixture.capability.operations.snapshot().length,
          ),
        )
        .toBe(1);
      await expect(dialog).toBeVisible();
      await expect(button("Dismissing…")).toBeDisabled();
      await expect(button("Keep editing")).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      // The modal must keep navigation/submission inaccessible until persistence completes.
      await expect(button("Close editor")).toHaveCount(0);
      await expect(button("New workflow")).toHaveCount(0);
      expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(
        1,
      );
    } finally {
      await page.evaluate(() => window.workflowFixture.releaseDismiss());
    }
    if (fail) {
      await expect(dialog.getByRole("alert")).toHaveText("Journal unavailable");
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.workflowFixture.capability.operations
              .snapshot()
              .map((op) => op.eventId),
          ),
        )
        .toEqual([operationId]);
      await page.keyboard.press("Escape");
      await expect(button("Save changes")).toBeDisabled();
      await editor.expectName("Kept draft");
    } else {
      await expect(dialog).toHaveCount(0);
      await expect(button("Save changes")).toBeEnabled();
      await editor.expectName("Kept draft");
    }
  }
  expect(
    await page.evaluate(() => window.workflowFixture.calls.dismiss),
  ).toEqual([operationId, operationId]);
  expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(1);
  await button("Save changes").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(2);
});

test("legacy deletion offers durable recovery on the grid without claiming removal", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const button = editorControls(page).button;
  await button("Actions for Fixture A helper").click();
  await page
    .getByRole("menuitem", { name: "Delete workflow", exact: true })
    .click();
  await button("Delete workflow").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(1);
  await page.evaluate(() => window.workflowSessionFixture.settleDelete());
  await expect(
    page.getByText("Couldn't confirm deletion of Fixture A helper", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(button(/^Open Fixture A helper:/)).toBeDisabled();
  await expect(page.getByText(/Saved workflow deleted/)).toHaveCount(0);
  const reads = await page.evaluate(() =>
    window.workflowSessionFixture.definitionQueries(),
  );
  await button("Check saved configuration").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.definitionQueries()),
    )
    .toBeGreaterThan(reads);
  await expect(button("Check saved configuration")).toBeEnabled();
  await button("Dismiss notice").click();
  await button("Dismiss notice and continue").click();
  await expect(button(/^Open Fixture A helper:/)).toBeEnabled();
  await expect(editorDialog(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => window.workflowSessionFixture.publications()),
  ).toBe(1);
});

test("invalid timeout text stays in the draft and blocks saves in both editor modes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  const editor = editorControls(page);
  const { button, yaml, tab } = editor;
  await editor.open("Message helper");
  await editor.openStep(1);
  await editor.disclose("Run controls");
  const timeout = page.getByLabel("Step timeout (optional)", { exact: true });
  for (const input of ["oops", "0s", "1.5", "9007199254740992"]) {
    await timeout.fill(input);
    await expect(timeout).toHaveValue(input);
    await expect(button("Save changes")).toBeDisabled();
    await expect(timeout).toHaveAttribute("aria-invalid", "true");
    await expect(timeout).toHaveAccessibleDescription(/positive whole number/);
    await tab("YAML").click();
    expect(parseYaml(await yaml.inputValue()).steps[0].timeout_secs).toBe(
      input,
    );
    await expect(button("Save changes")).toBeDisabled();
    await expect(yaml).toHaveAttribute("aria-invalid", "true");
    await expect(yaml).toHaveAccessibleDescription(/positive whole number/);
    await tab("Form").click();
    // Mode switches clear the selection, closing the inspector.
    await editor.openStep(1);
    await editor.disclose("Run controls");
    await expect(timeout).toBeVisible();
    await expect(timeout).toHaveValue(input);
  }
  await button("Close editor").click();
  await expect(
    page.getByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeVisible();
  await button("Keep editing").click();
  await expect(timeout).toHaveValue("9007199254740992");
  await timeout.fill("");
  await expect(timeout).toBeVisible();
  await expect(timeout).toBeFocused();
  for (const character of "5m") {
    await page.keyboard.type(character);
    await expect(timeout).toBeVisible();
    await expect(timeout).toBeFocused();
  }
  await expect(timeout).toHaveValue("5m");
  await expect(button("Save changes")).toBeEnabled();
  await button("Save changes").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(1);
  expect(
    parseYaml(await page.evaluate(() => window.workflowFixture.input().yaml))
      .steps[0].timeout_secs,
  ).toBe(300);
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(button("Save changes")).toBeEnabled();
  // Successful save mounts a fresh editor; reopening its optional section is
  // separate from keeping the current draft open throughout validation recovery.
  if (!(await timeout.isVisible())) {
    await editor.openStep(1);
    await editor.disclose("Run controls");
  }
  await timeout.fill(" ");
  await button("Save changes").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(2);
  expect(
    parseYaml(await page.evaluate(() => window.workflowFixture.input().yaml))
      .steps[0],
  ).not.toHaveProperty("timeout_secs");
});

test("schedule presets round-trip into YAML and warn before enabling a frequent one", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  // Wide layout keeps the trigger inspector beside the footer tabs.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  const editor = editorControls(page);
  const { button, yaml, tab } = editor;
  const preset = (name) => page.getByRole("radio", { name, exact: true });
  const pill = (name) => preset(name);
  const reply = page.getByRole("switch", {
    name: "Reply in the triggering thread",
  });
  // Mode switches clear the selection, so return to the trigger inspector.
  const openTrigger = () =>
    page.getByRole("button", { name: /^Edit trigger:/ }).click();
  const savedTrigger = async () => {
    await tab("YAML").click();
    const trigger = parseYaml(await yaml.inputValue()).trigger;
    await tab("Form").click();
    await openTrigger();
    return trigger;
  };

  await button("New workflow").click();
  await editor.primary("Add step").click();
  await editor.message.fill("On a timer");
  await editor.disclose("Run controls");
  await reply.click();
  await expect(reply).toBeChecked();
  await openTrigger();
  await page.getByRole("combobox", { name: "Trigger", exact: true }).click();
  await page.getByRole("option", { name: "Schedule", exact: true }).click();
  await expect(preset("Daily")).toBeChecked();
  await expect(page.getByLabel("Run time (UTC)", { exact: true })).toHaveValue(
    "09:00",
  );
  await expect(page.getByText("Trigger options", { exact: true })).toHaveCount(
    0,
  );
  // Schedule triggers have no thread to reply in.
  await editor.openStep(1);
  await editor.disclose("Run controls");
  await expect(reply).toHaveCount(0);
  await openTrigger();
  const daily = await savedTrigger();
  expect(daily).toEqual({ on: "schedule", cron: "0 9 * * *" });
  await tab("YAML").click();
  expect(parseYaml(await yaml.inputValue()).steps[0]).not.toHaveProperty(
    "reply_in_thread",
  );
  await tab("Form").click();
  await openTrigger();

  await pill("Weekly").click();
  await expect(preset("Weekly")).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Monday" })).toBeChecked();
  await page.locator(".workflow-pill-label", { hasText: /^F$/ }).click();
  await expect(page.getByRole("checkbox", { name: "Friday" })).toBeChecked();
  await page.getByLabel("Run time (UTC)", { exact: true }).fill("14:30");
  expect(await savedTrigger()).toEqual({
    on: "schedule",
    cron: "30 14 * * 2,6",
  });
  await expect(preset("Weekly")).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Friday" })).toBeChecked();

  await pill("Monthly").click();
  await page.getByRole("combobox", { name: "Day of month" }).click();
  await page.getByRole("option", { name: "31", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "won’t run in some months",
  );
  expect(await savedTrigger()).toEqual({
    on: "schedule",
    cron: "30 14 31 * *",
  });

  await pill("Every 15 minutes").click();
  expect(await savedTrigger()).toEqual({ on: "schedule", interval: "15m" });
  await expect(preset("Every 15 minutes")).toBeChecked();
  await expect(page.getByLabel("Run time (UTC)", { exact: true })).toHaveCount(
    0,
  );

  await pill("Custom cron").click();
  const minute = page.getByRole("textbox", { name: "Minute", exact: true });
  await expect(minute).toHaveValue("*/15");
  await minute.focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("textbox", { name: "Hour", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("*/2");
  expect(await savedTrigger()).toEqual({
    on: "schedule",
    cron: "*/15 */2 * * *",
  });
  await expect(preset("Custom cron")).toBeChecked();

  await pill("Every hour").click();
  await editor.closeInspector();
  await page
    .getByRole("switch", { name: /^Enabled in configuration$/ })
    .click();
  await editor.primary("Create workflow").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(
    "It is scheduled to run every 1 hour. Review the schedule before turning it on.",
  );
  expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(0);
  await button("Save enabled workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(1);
  expect(
    parseYaml(await page.evaluate(() => window.workflowFixture.input().yaml))
      .trigger,
  ).toEqual({ on: "schedule", interval: "1h" });
  expect(errors.unexplained()).toEqual([]);
});

test("a webhook save shows its one-time secret once and asks before leaving it behind", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copied.push(text);
        },
      },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  const editor = editorControls(page);
  const { button, yaml, tab } = editor;
  const reply = page.getByRole("switch", {
    name: "Reply in the triggering thread",
  });
  const secretValue = "fixture-webhook-secret-2f6c";
  const hookUrl =
    "https://relay.example.test/hooks/66666666-6666-4666-8666-666666666666";

  await button("New workflow").click();
  await editor.closeInspector();
  await editor.rename("Hook helper");
  await editor.primary("Add step").click();
  await editor.message.fill("Hook received");
  await editor.disclose("Run controls");
  await reply.click();
  await expect(reply).toBeChecked();
  await page.getByRole("button", { name: /^Edit trigger:/ }).click();
  await page.getByRole("combobox", { name: "Trigger", exact: true }).click();
  await page.getByRole("option", { name: "Webhook", exact: true }).click();
  await expect(
    page.getByText(/A unique URL is generated after creation/),
  ).toBeVisible();
  await expect(page.getByText("Trigger options", { exact: true })).toHaveCount(
    0,
  );
  await editor.openStep(1);
  await editor.disclose("Run controls");
  await expect(reply).toHaveCount(0);
  await tab("YAML").click();
  const parsed = parseYaml(await yaml.inputValue());
  expect(parsed.trigger).toEqual({ on: "webhook" });
  expect(parsed.steps[0]).not.toHaveProperty("reply_in_thread");
  await tab("Form").click();
  await editor.primary("Create workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(1);
  // The fixture toolbar sits beneath the modal; call its control directly.
  await page.evaluate(
    (secret) => window.workflowFixture.finish("succeeded", true, secret),
    secretValue,
  );

  const dialog = page.getByRole("dialog", { name: "Webhook ready" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("webhook-url")).toHaveText(hookUrl);
  await expect(dialog.getByTestId("webhook-secret")).toHaveText("•".repeat(24));
  expect(await page.evaluate(() => window.workflowFixture.calls.take)).toBe(1);
  expect(await dialog.textContent()).not.toContain(secretValue);
  // The dialog opens over the still-open editor, and Base UI moves focus into it
  // on the next animation frame. Until then Escape reaches the editor and closes it.
  await expect
    .poll(() =>
      dialog.evaluate((node) => node.contains(document.activeElement)),
    )
    .toBe(true);
  // Dismissing before revealing or copying asks first; going back keeps the dialog.
  await page.keyboard.press("Escape");
  const confirm = page.getByRole("alertdialog", {
    name: "Continue without this secret?",
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Reveal webhook secret" }).click();
  await expect(dialog.getByTestId("webhook-secret")).toHaveText(secretValue);
  await dialog.getByRole("button", { name: "Hide webhook secret" }).click();
  await expect(dialog.getByTestId("webhook-secret")).toHaveText("•".repeat(24));
  await dialog
    .getByRole("button", { name: "Copy secret", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Secret copied.");
  await dialog.getByRole("button", { name: "Copy URL", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("URL copied.");
  expect(await page.evaluate(() => window.__copied)).toEqual([
    secretValue,
    hookUrl,
  ]);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  // The hand-off happened once (StrictMode included) and nothing retains the value.
  expect(await page.evaluate(() => window.workflowFixture.calls.take)).toBe(1);
  const operations = await page.evaluate(() =>
    window.workflowFixture.capability.operations.snapshot(),
  );
  expect(operations.at(-1)).toMatchObject({
    action: "save",
    outcome: "succeeded",
  });
  expect(operations.at(-1)).not.toHaveProperty("secretHeld");
  expect(JSON.stringify(operations)).not.toContain(secretValue);
  expect(
    await page.evaluate(
      (id) => window.workflowFixture.capability.takeWebhookSecret(id),
      operations.at(-1).eventId,
    ),
  ).toBeUndefined();
  await expect(button("Save changes")).toBeEnabled();
  expect(errors.unexplained()).toEqual([]);
});

// Browser boundary: the routed page must deliver a real session's late receipt
// after its editor unmounts, without losing the dialog's focus/masking behavior.
// Receipt and purge permutations belong in session/owner component tests.
test("late webhook receipt survives navigation and exact readback on the landing", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const editor = editorControls(page);
  const { button, yaml } = editor;
  const caveat = page.getByText(
    /Turning off does not confirm runs have stopped/,
  );
  await expect(caveat).toBeVisible();
  await editor.open("Fixture A helper");
  // In the editor the caveat describes the inspector's enable switch.
  await expect(
    editor.region.getByText(/Turning off does not confirm runs have stopped/),
  ).toBeVisible();
  await editor.tab("YAML").click();
  await yaml.fill(
    (await yaml.inputValue()).replace("on: message_posted", "on: webhook"),
  );
  await button("Save changes").click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(1);
    // Leaving the editor is the navigation guard for a pending save.
    await button("Close editor").click();
    await page
      .getByRole("alertdialog", { name: "Leave this draft?" })
      .getByRole("button", { name: "Leave draft", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Workflow editor" }),
    ).toHaveCount(0);
    await page.evaluate(() => window.workflowSessionFixture.readback());
    await button("Refresh workflows").click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.workflowSessionFixture.operations().at(-1)?.outcome,
        ),
      )
      .toBe("succeeded");
    await expect(
      page.getByRole("dialog", { name: "Webhook ready" }),
    ).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.settleSave());
  }
  const dialog = page.getByRole("dialog", { name: "Webhook ready" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("webhook-secret")).toHaveText("•".repeat(24));
  await dialog
    .getByRole("button", { name: "Reveal webhook secret", exact: true })
    .click();
  await expect(dialog.getByTestId("webhook-secret")).toHaveText(
    "fixture-late-webhook-secret",
  );
  await page.evaluate(() => window.workflowSessionFixture.state("retrying"));
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.workflowSessionFixture.state("connected"));
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(button("Refresh workflows")).toBeEnabled();
});

test("both Add actions allocate unused IDs after a very large parsed ID", async ({
  page,
}) => {
  await page.goto(url);
  const editor = editorControls(page);
  const { yaml, tab } = editor;
  await editor.open("Message helper");
  await tab("YAML").click();
  const definition = parseYaml(await yaml.inputValue());
  definition.steps[0].id = "step_9007199254740992";
  // JSON is YAML, and avoids testing a second serializer in this browser fixture.
  await yaml.fill(JSON.stringify(definition));
  await tab("Form").click();
  await editor.addStep(1, "Send Message");
  // Adding selects the new step, so its message is the only one in view.
  await editor.message.fill("Another message");
  await editor.closeInspector();
  await editor.addStep(2, "Delay");
  await editor.closeInspector();
  await tab("YAML").click();
  expect(
    parseYaml(await yaml.inputValue()).steps.map((step) => step.id),
  ).toEqual(["step_9007199254740992", "step_1", "step_2"]);
});

test("real session reconnect retains unsaved YAML and an in-flight run request", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const editor = editorControls(page);
  const { yaml } = editor;
  // Scope notices to the modal: the page behind it is inert.
  const dialog = editorDialog(page);
  await page.getByRole("button", { name: /^Channels(?::|$)/ }).click();
  await page
    .getByRole("checkbox", { name: "First channel", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Channels" })).toHaveCount(0);
  await editor.open("Fixture A helper");
  await editor.tab("YAML").click();
  const original = await yaml.inputValue();
  const edited = original.replace(
    "Hello from a fixture",
    "Unsaved reconnect draft",
  );
  expect(edited).not.toBe(original);
  await yaml.fill(edited);
  await page.evaluate(() => window.workflowSessionFixture.state("retrying"));
  await expect(dialog.getByText(/Connection interrupted/)).toBeVisible();
  await expect(yaml).toHaveValue(edited);
  await page.evaluate(() => window.workflowSessionFixture.state("connected"));
  await dialog.getByRole("button", { name: /^Refresh/ }).click();
  await expect(dialog.getByText(/Connection interrupted/)).toHaveCount(0);
  await expect(yaml).toHaveValue(edited);
  await yaml.fill(original);
  await editor.run.click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(1);
    await page.evaluate(() => window.workflowSessionFixture.state("retrying"));
    await expect(
      page.getByText("Requesting a run…", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.settle());
  }
  await expect(
    page.getByText("Run requested. Inspect run history for its result.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(yaml).toHaveValue(original);
  await page.evaluate(() =>
    window.workflowSessionFixture.revokeSelectedChannel(),
  );
  await expect(yaml).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Workflow operations" }),
  ).toHaveCount(0);
});

test("generic Outbox offers message retry but no workflow replay", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByRole("button", { name: /^Channels(?::|$)/ }).click();
  await page
    .getByRole("checkbox", { name: "First channel", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Channels" })).toHaveCount(0);
  await editorControls(page).open("Fixture A helper");
  await editorControls(page).run.click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(1);
  await page.evaluate(() => window.workflowSessionFixture.reject());
  await expect(
    page.getByText("Failed to trigger workflow", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Workflow command rejected; retain the draft and refresh the saved configuration.",
      { exact: true },
    ),
  ).toBeVisible();
  // The Outbox is page chrome beneath the modal editor.
  await button("Close editor").click();
  await page.getByText("Outbox · 1 items", { exact: true }).click();
  const outbox = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Outbox ·/ }) });
  await expect(outbox.getByText(/Not sent/)).toBeVisible();
  await expect(
    outbox.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.workflowSessionFixture.sendMessage());
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(2);
  await page.evaluate(() => window.workflowSessionFixture.reject());
  const message = outbox
    .getByRole("listitem")
    .filter({ hasText: "Retryable message" });
  await expect(message).toContainText("Not sent");
  await message.getByRole("button", { name: "Retry", exact: true }).click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(3);
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.settle());
  }
  await expect(message).toContainText("Sent");
  await expect(
    outbox.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
});

test("a created workflow saves, reads back exactly and reopens unchanged", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  const editor = editorControls(page);
  const { button, yaml, tab } = editor;
  const saves = () => page.evaluate(() => window.workflowFixture.calls.save);

  await button("New workflow").click();
  await expect(
    page.getByRole("dialog", { name: "Create workflow" }),
  ).toBeVisible();
  await editor.closeInspector();
  await editor.rename("Readback helper");
  await editor.primary("Add step").focus();
  await page.keyboard.press("Enter");
  await expect(button("Edit step 1: Send Message")).toBeFocused();
  await editor.message.fill("Created in the browser");
  await editor.disclose("Run controls");
  await page.getByLabel("Step timeout (optional)", { exact: true }).fill("45s");
  await editor.closeInspector();
  await editor.primary("Create workflow").click();
  await expect(button("Creating…")).toBeDisabled();
  await expect.poll(saves).toBe(1);
  const submitted = await page.evaluate(
    () => window.workflowFixture.input().yaml,
  );
  expect(parseYaml(submitted)).toEqual({
    name: "Readback helper",
    trigger: { on: "message_posted" },
    steps: [
      {
        id: "step_1",
        action: "send_message",
        text: "Created in the browser",
        timeout_secs: 45,
      },
    ],
    enabled: false,
  });

  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  // The exact readback turns the draft into the saved configuration.
  await expect(editorDialog(page)).toBeVisible();
  await expect(button("Save changes")).toBeEnabled();
  await button("Close editor").click();
  await expect(
    page.getByRole("alertdialog", { name: "Leave this draft?" }),
  ).toHaveCount(0);
  await expect(editor.region).toHaveCount(0);

  await editor.open("Readback helper");
  await editor.expectName("Readback helper");
  await expect(button("Edit step 1: Send Message")).toContainText(
    "Created in the browser",
  );
  await tab("YAML").click();
  await expect(yaml).toHaveValue(submitted);
  expect(await saves()).toBe(1);
  expect(errors.unexplained()).toEqual([]);
});

// Browser-only boundary: nested modal hit testing, focus guards and return
// targets cannot be established by jsdom's layout/focus implementation.
test("narrow inspector traps focus and dismisses above its editor", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(url);
  const editor = editorControls(page);
  await editor.open("Message helper");
  await editor.openStep(1);
  const sheet = page.getByRole("dialog", { name: "Step 1 settings" });
  await expect(sheet).toBeVisible();
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  for (let index = 0; index < 16; index++) {
    await page.keyboard.press(tab);
    // Base UI's focus guards return focus on the next animation frame.
    await expect
      .poll(() =>
        sheet.evaluate((node) => node.contains(document.activeElement)),
      )
      .toBe(true);
  }
  await page.mouse.click(100, 600);
  await expect(sheet).toHaveCount(0);
  await expect(editor.button("Edit step 1: Send Message")).toBeFocused();
  await editor.openStep(1);
  await page
    .getByRole("combobox", { name: "Step action", exact: true })
    .click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(editor.button("Edit step 1: Send Message")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editorDialog(page)).toHaveCount(0);
  // The dialog returns focus to the card control that opened it.
  await expect(editor.button("Actions for Message helper")).toBeFocused();
});

// Real session → save outcome → both modal and landing readback owners. The
// receipt and definition can arrive in either order. This exercises the real
// independent read owners plus modal stacking/focus during save recovery.
for (const lateReadback of [false, true]) {
  test(`create readback keeps the secret above the editor and refreshes its landing card (${lateReadback ? "receipt first" : "definition first"})`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      url.replace("/fixture.html", "/session-fixture.html?writes"),
    );
    const editor = editorControls(page);
    const { button } = editor;
    await button(/^Open Fixture A helper:/).waitFor();
    await button("New workflow").click();
    await page
      .getByRole("option", { name: "First channel", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Trigger", exact: true }).click();
    await page.getByRole("option", { name: "Webhook", exact: true }).click();
    await editor.closeInspector();
    await editor.rename("Session readback helper");
    await editor.primary("Add step").click();
    await expect(button("Edit step 1: Send Message")).toBeFocused();
    await editor.message.fill("Created through the real session");
    await editor.closeInspector();
    await editor.tab("YAML").click();
    const submitted = await editor.yaml.inputValue();
    await editor.primary("Create workflow").focus();
    await page.keyboard.press("Enter");
    try {
      await expect
        .poll(() =>
          page.evaluate(() => window.workflowSessionFixture.publications()),
        )
        .toBe(1);
      await expect(button("Creating…")).toBeFocused();
      await expect(button("Creating…")).toBeDisabled();
      if (!lateReadback)
        await page.evaluate(() => window.workflowSessionFixture.readback());
    } finally {
      await page.evaluate(() => window.workflowSessionFixture.settleSave());
    }
    const secret = page.getByRole("dialog", { name: "Webhook ready" });
    await expect(secret).toBeVisible();
    await expect(secret.getByTestId("webhook-secret")).toHaveText(
      "•".repeat(24),
    );
    await expect(
      page.getByRole("dialog", {
        name: lateReadback ? "Create workflow" : "Session readback helper",
        includeHidden: true,
      }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("dialog", {
        name: lateReadback ? "Create workflow" : "Session readback helper",
      }),
    ).toHaveCount(0);
    const tab =
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab";
    await secret.getByRole("button", { name: "Continue", exact: true }).focus();
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press(tab);
      await expect
        .poll(() =>
          secret.evaluate((node) => node.contains(document.activeElement)),
        )
        .toBe(true);
    }
    await secret.getByRole("button", { name: "Reveal webhook secret" }).click();
    await expect(secret.getByTestId("webhook-secret")).toHaveText(
      "fixture-late-webhook-secret",
    );
    await secret.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(secret).toHaveCount(0);
    if (lateReadback) {
      // Drain the receipt-triggered reads while the definition is still absent.
      await expect(
        page.getByText("Reading configurations…", { exact: true }),
      ).toHaveCount(0);
      await expect(landingStatus(page)).toHaveText("");
      await expect(
        page.getByText(/Configuration saved; waiting for a readback/),
      ).toBeVisible();
      await page.evaluate(() => window.workflowSessionFixture.readback());
      await button("Check saved configuration").click();
      await expect(button("Save changes")).toBeEnabled();
      await expect(editorDialog(page)).toBeVisible();
    } else {
      await expect(button("Save changes")).toBeFocused();
    }
    await button("Close editor").click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    // No manual Refresh. A successful save must update the retained landing.
    await editor.open("Session readback helper");
    await editor.tab("YAML").click();
    await expect(editor.yaml).toHaveValue(submitted);
    expect(
      await page.evaluate(() => window.workflowSessionFixture.publications()),
    ).toBe(1);
  });
}
