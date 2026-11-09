import { openPage, openSettings, settingsDialog } from "./navigation.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { upper, settle } from "./timeline.mjs";
import { test as base, expect } from "./playwright-test.mjs";
import { preview } from "./vite-server.mjs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { relayBrokerPlugin } from "../../browser-host/relay-broker.mjs";
import { brokerSocket } from "../broker-socket.mjs";
import { fixtureAliases, fixtureRelayUrl } from "../relay-config.ts";
import { buildApp } from "./build.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Actual app, composer, session and broker; only the upstream relay is modeled.
// Ephemeral identities and a network fence prevent any live message or profile write.
const test = base.extend({
  developmentReact: [false, { scope: "worker" }],
  builderlabLogin: [false, { scope: "worker" }],
  federatedIdentity: [false, { scope: "worker" }],
  pluginFixtures: [false, { scope: "worker" }],
  companionFixture: [false, { scope: "worker" }],
  pairingFixture: [false, { scope: "worker" }],
  localAgentActivity: [false, { scope: "worker" }],
  compiledApp: [buildApp, { scope: "worker" }],
  directorySize: [35, { option: true }],
  app: async ({ compiledApp, page, context, directorySize }, use) => {
    const key = generateSecretKey(),
      relay = generateSecretKey();
    const viewer = getPublicKey(key),
      author = getPublicKey(relay);
    const sign = (secret, kind, tags, body = "") =>
      finalizeEvent(
        {
          kind,
          tags,
          content: body,
          created_at: Math.floor(Date.now() / 1000),
        },
        secret,
      );
    const secrets = Array.from({ length: directorySize }, () =>
      generateSecretKey(),
    );
    const people = secrets.map((secret, i) => {
      return sign(
        secret,
        0,
        [],
        JSON.stringify({
          name:
            i === 0
              ? "Avery Chen"
              : i === 1
                ? "Build Agent"
                : `Person ${String(i + 1).padStart(2, "0")}`,
          is_agent: i === 1,
        }),
      );
    });
    const channel = "11111111-1111-4111-8111-111111111111";
    const events = [
      sign(key, 0, [], JSON.stringify({ name: "Browser Fixture" })),
      ...people,
    ];
    const commands = [],
      reads = [];
    let failOpen = false,
      hold = false,
      release = () => {};
    let directoryReady = Promise.resolve(),
      releaseDirectory = () => {};
    let backgroundReady = Promise.resolve(),
      releaseBackground = () => {};
    let backgroundPage = 1;
    let historyReady = Promise.resolve(),
      releaseHistory = () => {},
      failHistory = false;
    const publish = async (event) => {
      // Only hold messages: presence/read-state writes must not replace the gate.
      if (hold && event.kind === 9)
        await new Promise((resolve) => {
          release = resolve;
        });
      events.push(event);
      return "saved";
    };
    const socket = brokerSocket(publish);
    const broker = relayBrokerPlugin({
      archiveFile: ":memory:",
      relayUrl: fixtureRelayUrl,
      communityAliases: fixtureAliases,
      identity: () => key,
      agentLibrary: () => ({ definitions: [], identities: [] }),
      authority: async () => ({ relayAuthor: author }),
      socketFactory: socket.factory,
      upstreamFetch: async (url, init) => {
        let body = init?.body ? JSON.parse(init.body) : undefined;
        if (String(url).endsWith("/events")) {
          commands.push(body);
          if (failOpen) {
            failOpen = false;
            return new Response("offline", { status: 503 });
          }
          const members = [
            viewer,
            ...body.tags
              .filter(([tag]) => tag === "p")
              .map(([, pubkey]) => pubkey),
          ];
          events.push(
            sign(
              relay,
              39000,
              [
                ["d", channel],
                ["t", "dm"],
              ],
              JSON.stringify({ name: "Avery Chen", channel_type: "dm" }),
            ),
          );
          events.push(
            sign(relay, 39002, [
              ["d", channel],
              ...members.map((pubkey) => ["p", pubkey]),
            ]),
          );
          return Response.json({
            accepted: true,
            event_id: body.id,
            message: `response:${JSON.stringify({ channel_id: channel })}`,
          });
        }
        // Relay name search: record and answer it as the equivalent kind:0
        // search read, so the people gates and read counts cover both.
        const profileSearch = String(url).endsWith("/profiles/search");
        if (profileSearch || String(url).endsWith("/query")) {
          if (profileSearch)
            body = [
              {
                kinds: [0],
                search: body.query,
                limit: body.limit,
                page: body.page ?? 1,
              },
            ];
          reads.push(...body);
          if (body.some((filter) => filter.top_level)) await historyReady;
          if (body.some((filter) => filter.kinds?.includes(0) && filter.page))
            await directoryReady;
          if (
            body.some(
              (filter) =>
                filter.kinds?.includes(0) &&
                filter.limit === 30 &&
                filter.page >= backgroundPage,
            )
          )
            await backgroundReady;
          const result = new Map();
          for (const filter of body) {
            let rows = events.filter(
              (event) =>
                (!filter.kinds || filter.kinds.includes(event.kind)) &&
                (!filter.authors || filter.authors.includes(event.pubkey)) &&
                (!filter.ids || filter.ids.includes(event.id)) &&
                Object.entries(filter).every(
                  ([tag, values]) =>
                    !tag.startsWith("#") ||
                    event.tags.some(
                      ([key, value]) =>
                        key === tag.slice(1) && values.includes(value),
                    ),
                ) &&
                (!filter.search ||
                  JSON.parse(event.content)
                    .name.toLowerCase()
                    .includes(filter.search.toLowerCase())),
            );
            if (filter.page)
              rows = rows.slice(
                (filter.page - 1) * filter.limit,
                filter.page * filter.limit,
              );
            else if (filter.limit) rows = rows.slice(0, filter.limit);
            for (const row of rows) result.set(row.id, row);
            if (filter.top_level && !failHistory) {
              const id = filter["#h"][0];
              const bounds = sign(
                relay,
                39006,
                [
                  ["h", id],
                  ["d", `${id}:head`],
                ],
                JSON.stringify({ has_more: false, next_cursor: null }),
              );
              result.set(bounds.id, bounds);
            }
          }
          return Response.json([...result.values()]);
        }
        return Response.json({});
      },
    });
    const server = await preview({
      ...compiledApp.config,
      plugins: [
        {
          name: "direct-message-fixture",
          configurePreviewServer: (server) => broker.configureServer(server),
        },
      ],
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const errors = watchPageErrors(page);
    await page.addInitScript(
      ({ viewer }) => {
        if (!localStorage.getItem("buzzodz.plugins.v1"))
          localStorage.setItem(
            "buzzodz.plugins.v1",
            JSON.stringify({ version: 3, enabled: { "buzz.workflows": true } }),
          );
        const key = `buzz-client.v1:${viewer}`;
        if (!localStorage.getItem(key))
          localStorage.setItem(
            key,
            JSON.stringify({
              profile: { name: "Browser Fixture", picture: "" },
              memberships: [{ id: "primary", name: "Primary" }],
              selected: "primary",
            }),
          );
        window.removalSounds = 0;
        HTMLMediaElement.prototype.play = async function () {
          if (this.src.includes("plop.m4a")) window.removalSounds++;
        };
      },
      { viewer },
    );
    try {
      await use({
        origin,
        reads,
        commands,
        publications: socket.publications,
        errors,
        failHistory: () => {
          failHistory = true;
        },
        holdHistory: () => {
          failHistory = false;
          historyReady = new Promise((resolve) => {
            releaseHistory = resolve;
          });
        },
        showHistory: () => releaseHistory(),
        holdPeople: () => {
          directoryReady = new Promise((resolve) => {
            releaseDirectory = resolve;
          });
        },
        showPeople: () => releaseDirectory(),
        // A shared stream where Avery has spoken, so the profile is reachable.
        seedChannel: (id, text, channelType = "stream") => {
          const avery = getPublicKey(secrets[0]);
          events.push(
            sign(
              relay,
              39000,
              [
                ["d", id],
                ["t", channelType],
              ],
              JSON.stringify({ name: "general", channel_type: channelType }),
            ),
            sign(relay, 39002, [
              ["d", id],
              ["p", viewer],
              ["p", avery],
            ]),
            sign(secrets[0], 9, [["h", id]], text),
          );
        },
        holdBackground: (page = 1) => {
          backgroundPage = page;
          backgroundReady = new Promise((resolve) => {
            releaseBackground = resolve;
          });
        },
        showBackground: () => releaseBackground(),
        failOpening: () => {
          failOpen = true;
        },
        holdDelivery: () => {
          hold = true;
        },
        publishReadState: () =>
          publish(sign(key, 30078, [["d", "fixture-read-state"]])),
        confirm: () => {
          hold = false;
          release();
        },
      });
    } finally {
      releaseDirectory();
      releaseBackground();
      releaseHistory();
      release();
      server.httpServer.closeAllConnections();
      await new Promise((resolve) => server.httpServer.close(resolve));
    }
  },
});
async function startNewMessage(page) {
  await openPage(page, "Messages");
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const messages = sidebar.locator('[data-sidebar-section="dms"] summary');
  await messages.hover();
  await sidebar
    .getByRole("button", { name: "New message", exact: true })
    .click();
  await expect(messages.locator("..")).toHaveAttribute("open", "");
}

async function open(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Workflows");
  await startNewMessage(page);
}

test("empty compose, keyboard selection, pagination, removal effects, retry, then confirmed normal timeline", async ({
  page,
  app,
}, info) => {
  app.holdPeople();
  app.holdBackground();
  await open(page, app);
  const loading = page.getByRole("status", { name: "Loading people" });
  await expect(loading).toBeVisible();
  await expect(loading.locator('[class*="loadingRow"]')).toHaveCount(10);
  const picker = page.getByRole("listbox", { name: "People" });
  const pickerHeight = await picker.evaluate(
    (element) => element.parentElement.getBoundingClientRect().height,
  );
  const expectStablePicker = () =>
    expect
      .poll(() =>
        picker.evaluate(
          (element) => element.parentElement.getBoundingClientRect().height,
        ),
      )
      .toBe(pickerHeight);
  const shimmer = loading.locator('[class*="loadingAvatar"]').first();
  await expect
    .poll(() =>
      shimmer.evaluate(
        (element) => getComputedStyle(element, "::after").animationName,
      ),
    )
    .toContain("peopleShimmer");
  await page.screenshot({ path: info.outputPath("new-message-loading.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      shimmer.evaluate(
        (element) => getComputedStyle(element, "::after").animationName,
      ),
    )
    .toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  app.showPeople();
  await expect(
    page.getByRole("option", { name: "Avery Chen", exact: true }),
  ).toBeVisible();
  // Fifteen profiles include the viewer and an uncontrolled agent; thirteen rows paint first.
  await expect(page.getByRole("option")).toHaveCount(13);
  const initialPeople = await page.getByRole("option").allTextContents();
  await expect
    .poll(() =>
      app.reads.some(
        (filter) => filter.kinds?.includes(0) && filter.limit === 30,
      ),
    )
    .toBe(true);
  // Background discovery starts without scrolling and preserves the preview's order.
  app.showBackground();
  await expect(page.getByRole("option").first()).toHaveAttribute(
    "aria-setsize",
    "34",
  );
  await expect(
    page.getByRole("option", { name: "Build Agent, Agent", exact: true }),
  ).toHaveCount(0);
  expect(
    (await page.getByRole("option").allTextContents()).slice(
      0,
      initialPeople.length,
    ),
  ).toEqual(initialPeople);
  await expect(loading).toHaveCount(0);
  await expectStablePicker();
  const input = page.getByRole("combobox", { name: "Message recipients" });
  await expect(input).toBeFocused();
  // Shared popover portals out of the header and dismisses without stealing focus.
  await expect(
    page.getByRole("group", { name: "Recipients" }).getByRole("listbox"),
  ).toHaveCount(0);
  await page.locator("[data-new-message-body]").click();
  await expect(picker).toHaveCount(0);
  await input.click();
  await expect(picker).toBeVisible();
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(picker).toHaveCount(0);
  await page.getByText("To:", { exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("option", { name: "Avery Chen", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-new-message-body]")).toBeEmpty();
  await expect(
    page.getByRole("textbox", {
      name: "New message",
    }),
  ).toHaveAttribute("contenteditable", "false");
  await expect(
    page
      .getByRole("textbox", { name: "New message", exact: true })
      .locator("[data-placeholder]"),
  ).toHaveAttribute("data-placeholder", "");
  for (const name of ["Mention a member", "Emoji and GIFS"]) {
    const tool = page.getByRole("button", { name, exact: true });
    await expect(tool).toBeDisabled();
    await expect(tool).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
  await expect(page.locator("[data-message-id]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("new-message-empty.png") });
  const loadedPeople = await page
    .getByRole("option")
    .evaluateAll((rows) =>
      Object.fromEntries(
        rows.map((row) => [row.getAttribute("aria-posinset"), row.textContent]),
      ),
    );
  const directoryReads = () =>
    app.reads.filter(
      (filter) => filter.kinds?.includes(0) && filter.page && !filter.search,
    ).length;
  const beforeReopen = directoryReads();
  await openPage(page, "Workflows");
  await openPage(page, "Messages");
  await startNewMessage(page);
  await expect(page.getByRole("option").first()).toHaveAttribute(
    "aria-setsize",
    "34",
  );
  // Overscan can mount a different range after reopening; each retained
  // position must still represent the same person.
  const reopenedPeople = await page
    .getByRole("option")
    .evaluateAll((rows) =>
      Object.fromEntries(
        rows.map((row) => [row.getAttribute("aria-posinset"), row.textContent]),
      ),
    );
  expect(
    Object.keys(reopenedPeople).some((position) => position in loadedPeople),
  ).toBe(true);
  for (const [position, person] of Object.entries(loadedPeople)) {
    if (position in reopenedPeople)
      expect(reopenedPeople[position]).toBe(person);
  }
  expect(directoryReads()).toBe(beforeReopen);
  // Virtualized offscreen choices mount when the scrollport reveals them.
  await picker.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(
    page.getByRole("option", { name: "Person 35", exact: true }),
  ).toBeAttached();
  // A partly visible row under the pointer must not snap fully into view.
  const partial = page.getByRole("option", { name: "Person 34", exact: true });
  const scrollTop = await partial.evaluate((row) => {
    const list = row.closest('[role="listbox"]');
    list.scrollTop +=
      row.getBoundingClientRect().bottom -
      list.getBoundingClientRect().bottom -
      16;
    return list.scrollTop;
  });
  // Only a real pointer move highlights a row, so move between two points.
  await partial.dispatchEvent("pointermove", {
    pointerType: "mouse",
    clientX: 20,
    clientY: 20,
  });
  await partial.dispatchEvent("pointermove", {
    pointerType: "mouse",
    clientX: 21,
    clientY: 20,
  });
  await expect(partial).toHaveAttribute("aria-selected", "true");
  // Scrubbing must paint the active row immediately, without a hover fade.
  await expect(partial).toHaveCSS("transition-duration", "0s");
  await expect
    .poll(() => picker.evaluate((element) => element.scrollTop))
    .toBe(scrollTop);
  // Keyboard navigation still brings the next row into view without moving focus.
  await input.press("ArrowDown");
  const last = page.getByRole("option", { name: "Person 35", exact: true });
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      last.evaluate(
        (row) =>
          row.getBoundingClientRect().bottom <=
          row.closest('[role="listbox"]').getBoundingClientRect().bottom + 1,
      ),
    )
    .toBe(true);
  await expect(input).toBeFocused();
  await input.fill("Person 0");
  await expect(page.getByRole("option")).toHaveCount(7);
  await expect
    .poll(() => picker.evaluate((element) => element.clientHeight))
    .toBe(336);
  await expect
    .poll(() => picker.evaluate((element) => element.scrollHeight))
    .toBe(336);
  await page.screenshot({
    path: info.outputPath("new-message-short-results.png"),
  });
  await input.fill("Person");
  await expect(page.getByRole("option").first()).toHaveAttribute(
    "aria-setsize",
    "33",
  );
  await expectStablePicker();
  await input.fill("Nobody matches this name");
  await expect(
    page.getByText("No matching people.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => picker.evaluate((element) => element.clientHeight))
    .toBeLessThan(100);
  app.holdPeople();
  const searchReads = app.reads.filter((filter) => filter.search).length;
  await input.fill("Avery");
  await expect(loading).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "Avery Chen", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => picker.evaluate((element) => element.clientHeight))
    .toBe(48);
  await page.screenshot({
    path: info.outputPath("new-message-one-result.png"),
  });
  // The reopened picker searches the relay again behind the local match.
  await expect
    .poll(() => app.reads.filter((filter) => filter.search).length)
    .toBe(searchReads + 1);
  await expect(loading).toHaveCount(0);
  app.showPeople();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Remove Avery Chen" }),
  ).toBeVisible();
  await page.getByRole("option", { name: "Person 03", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("new-message-recipients.png"),
  });
  // Record the short-lived effect before input. The browser can complete its
  // entire animation while Playwright is waiting for the audio assertion.
  const removal = await page.evaluateHandle(() => {
    const selector = 'img[src$="poof1@3x.png"]';
    const events = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const [nodes, type] of [
          [record.addedNodes, "added"],
          [record.removedNodes, "removed"],
        ]) {
          for (const node of nodes) {
            const image = node.querySelector?.(selector);
            if (image)
              events.push({
                type,
                display:
                  type === "added" ? getComputedStyle(image).display : null,
              });
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return { events, disconnect: () => observer.disconnect() };
  });
  try {
    await page.getByRole("button", { name: "Remove Person 03" }).click();
    await expect.poll(() => page.evaluate(() => window.removalSounds)).toBe(1);
    // Deliberately inspect creation only after cleanup: slow automation must not
    // miss coverage of either lifecycle boundary.
    await expect
      .poll(() =>
        removal.evaluate(({ events }) => events.map(({ type }) => type)),
      )
      .toEqual(["added", "removed"]);
    expect(await removal.evaluate(({ events }) => events[0].display)).not.toBe(
      "none",
    );
    await expect(page.locator('img[src$="poof1@3x.png"]')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await input.press("Backspace");
    await expect.poll(() => page.evaluate(() => window.removalSounds)).toBe(2);
    await expect
      .poll(() =>
        removal.evaluate(({ events }) => events.map(({ type }) => type)),
      )
      .toEqual(["added", "removed", "added", "removed"]);
    expect(await removal.evaluate(({ events }) => events[2].display)).toBe(
      "none",
    );
    await expect(page.locator('img[src$="poof1@3x.png"]')).toHaveCount(0);
  } finally {
    await removal.evaluate((observer) => observer.disconnect());
    await removal.dispose();
  }
  await input.fill("Avery");
  await page.getByRole("option", { name: "Avery Chen", exact: true }).click();
  const composer = page.getByRole("textbox", {
    name: "Message Avery Chen",
    exact: true,
  });
  await input.press("Tab");
  await expect(composer).toBeFocused();
  await expect(picker).toHaveCount(0);
  // Both real extension paths use the selected roster before any DM exists.
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  const mentions = page.getByRole("dialog", {
    name: "Mention a member or agent",
  });
  const averyMention = mentions.getByRole("button", {
    name: "Avery Chen",
    exact: true,
  });
  await expect(mentions.getByRole("button")).toHaveCount(1);
  await averyMention.click();
  await expect(composer).toHaveText("@Avery Chen ");
  // Clear the rich token through the editor's keyboard selection command, not
  // fill()'s synthetic DOM range, before exercising the completion path.
  await composer.press("ControlOrMeta+a");
  await composer.press("Backspace");
  await expect(composer).toHaveText("");
  await composer.pressSequentially("@Av");
  const suggestions = page.getByRole("listbox", {
    name: "Mention suggestions",
  });
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await expect(
    suggestions.getByRole("option", { name: "Avery Chen", exact: true }),
  ).toBeVisible();
  expect(app.commands).toHaveLength(0);
  await composer.press("Enter");
  await composer.pressSequentially("Our first direct message");
  app.failOpening();
  await composer.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(input).not.toBeFocused();
  await expect(picker).not.toBeVisible();
  await expect(composer).toHaveText("@Avery Chen Our first direct message");
  await expect(
    page.getByRole("button", { name: "Remove Avery Chen" }),
  ).toBeVisible();
  app.holdDelivery();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => app.publications.filter((event) => event.kind === 9).length)
    .toBe(1);
  await expect(input).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
  const sidebarDm = page
    .getByRole("complementary", { name: "Sidebar", exact: true })
    .getByRole("button", { name: "Avery Chen", exact: true });
  await expect(sidebarDm).toHaveCount(0);
  const firstSend = app.publications.find((event) => event.kind === 9);
  expect(firstSend.tags.filter(([name]) => name === "p")).toEqual(
    app.commands[0].tags.filter(([name]) => name === "p"),
  );
  app.confirm();
  await expect(sidebarDm).toBeVisible();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toHaveCount(0);
  const message = page.locator("[data-message-id]", {
    hasText: "Our first direct message",
  });
  await expect(message).toHaveCount(1);
  await expect(message).toBeVisible();
  await expect(message.locator("time")).toBeVisible();
  // The first message opens its day with a divider.
  const visibleDay = await message.locator("time").evaluate((time) => {
    const date = new Date(time.dateTime);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((part) => String(part).padStart(2, "0"))
      .join("-");
  });
  await expect(message.locator(`[data-day="${visibleDay}"]`)).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Avery Chen" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("new-message-delivered.png") });
  // Give this DM a real above-bottom reading position. A short timeline masks
  // a lost setSent -> select handoff when New message resolves the selected DM.
  const dmInput = page.getByRole("textbox", { name: "Message #Avery Chen" });
  const readingText = Array.from(
    { length: 40 },
    (_, i) => `Reading paragraph ${i + 1}`,
  ).join("\n\n");
  // Seed the long reading history through the editor's clipboard path. Linux
  // WebKit can insert this text but strand fill()'s Page.insertText response.
  await dmInput.click();
  await dmInput.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, readingText);
  await expect(dmInput).toHaveJSProperty("value", readingText);
  await dmInput.press("Enter");
  await expect
    .poll(() => app.publications.filter((event) => event.kind === 9).length)
    .toBe(2);
  await expect(dmInput).toHaveJSProperty("value", "");
  // A full reload exercises IndexedDB acknowledgement: the recovery association
  // must be gone before another New message starts.
  await page.reload();
  await expect(dmInput).toBeVisible();
  await upper(page);
  await expect(sidebarDm).toHaveAttribute("aria-current", "page");
  // Resolving an existing DM keeps its row visible while the next send is held.
  await startNewMessage(page);
  await page.getByRole("option", { name: "Avery Chen", exact: true }).click();
  // Composing is a separate route, not the previously selected conversation.
  await expect(sidebarDm).toBeVisible();
  await expect(sidebarDm).not.toHaveAttribute("aria-current", "page");
  await page
    .getByRole("textbox", { name: "Message Avery Chen", exact: true })
    .fill("Another message");
  app.holdDelivery();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => app.publications.filter((event) => event.kind === 9).length)
    .toBe(3);
  await expect(sidebarDm).toBeVisible();
  // A concurrent non-message write must not replace the held message's gate.
  await app.publishReadState();
  app.confirm();
  await expect(
    page.locator("[data-message-id]", { hasText: "Another message" }),
  ).toBeInViewport();
  await settle(page);
  await expect
    .poll(() =>
      page
        .getByRole("region", { name: "Channel message history" })
        .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(4);
  await expect(sidebarDm).toHaveAttribute("aria-current", "page");
  expect(app.errors.unexplained()).toEqual([]);
});

test("profile Message opens a fresh DM and restores a hidden one", async ({
  page,
  app,
}) => {
  app.seedChannel("22222222-2222-4222-8222-222222222222", "Hello from Avery");
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const general = sidebar.locator(
    '[data-channel-id="22222222-2222-4222-8222-222222222222"]',
  );
  const sidebarDm = sidebar.getByRole("button", {
    name: "Avery Chen",
    exact: true,
  });
  const openProfileMessage = async () => {
    await general.click();
    await page
      .locator("[data-message-id]", { hasText: "Hello from Avery" })
      .getByRole("button", { name: "View Avery Chen profile" })
      .click();
    const profile = page.getByRole("complementary", {
      name: "Profile",
      exact: true,
    });
    await profile.getByRole("button", { name: "Message", exact: true }).click();
  };
  await expect(sidebarDm).toHaveCount(0);
  await openProfileMessage();
  await expect(sidebarDm).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Avery Chen" }),
  ).toBeVisible();
  expect(app.commands).toHaveLength(1);
  expect(app.commands[0].kind).toBe(41010);
  // A locally hidden DM reappears when the profile opens it again.
  await sidebarDm.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Actions for Avery Chen" })
    .getByRole("menuitem", { name: "Close conversation", exact: true })
    .click();
  await expect(sidebarDm).toHaveCount(0);
  await page.reload();
  await expect(sidebarDm).toHaveCount(0);
  await openProfileMessage();
  await expect(sidebarDm).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Avery Chen" }),
  ).toBeVisible();
  await page.reload();
  await expect(sidebarDm).toBeVisible();
  expect(app.commands).toHaveLength(2);
  expect(app.errors.unexplained()).toEqual([]);
});

test("a send finishing behind Settings keeps Settings and its unsaved edit", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.getByRole("option", { name: "Avery Chen", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message Avery Chen", exact: true })
    .fill("Sent while Settings is open");
  app.holdDelivery();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => app.publications.filter((event) => event.kind === 9).length)
    .toBe(1);
  await openSettings(page);
  const name = settingsDialog(page).getByRole("textbox", {
    name: "Display name",
    exact: true,
  });
  await name.fill("Unsaved name");
  app.confirm();
  // The new DM joins the retained sidebar behind the modal without leaving it.
  await expect(
    page.locator('[aria-label="Sidebar"] button', {
      hasText: "Avery Chen",
    }),
  ).toHaveCount(1);
  // The send has finished once its status clears behind the modal.
  await expect(page.getByText("Sending message…")).toHaveCount(0);
  expect(decodeURIComponent(new URL(page.url()).hash)).toContain(
    '"kind":"settings"',
  );
  await expect(settingsDialog(page)).toBeVisible();
  await expect(name).toHaveValue("Unsaved name");
  // The edit is still unsaved, so closing asks before discarding it.
  await settingsDialog(page)
    .getByRole("button", { name: "Close Settings", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "Discard changes?" })
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(
    page
      .getByRole("complementary", { name: "Sidebar", exact: true })
      .getByRole("button", { name: "Avery Chen", exact: true }),
  ).toBeVisible();
  expect(app.errors.unexplained()).toEqual([]);
});

// Browser-only contract: the inline reader's thread action reaches the actual
// host navigation and mounts its reply editor, preserving the selected target.
// Recovery also checks native button focus and the handoff to the real editor.
test("existing DM previews inline and opens its exact thread", async ({
  page,
  app,
}) => {
  const id = "22222222-2222-4222-8222-222222222222";
  app.seedChannel(id, "Existing DM history", "dm");
  app.failHistory();
  await open(page, app);
  await page.getByRole("option", { name: "Avery Chen", exact: true }).click();
  const body = page.locator("[data-new-message-body]");
  const retry = body.getByRole("button", { name: "Retry messages" });
  await expect(retry).toBeVisible();
  await page
    .getByRole("combobox", { name: "Message recipients" })
    .press("Escape");
  const row = body
    .locator("[data-message-id]")
    .filter({ hasText: "Existing DM history" });
  const composer = page.getByRole("textbox", {
    name: "Message Avery Chen",
    exact: true,
  });
  await composer.fill("Keep this draft");
  app.holdHistory();
  const historyReads = () =>
    app.reads.filter((filter) => filter.top_level).length;
  const beforeRetry = historyReads();
  try {
    await retry.focus();
    await retry.press("Enter");
    await expect.poll(historyReads).toBeGreaterThan(beforeRetry);
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(retry).toBeFocused();
  } finally {
    app.showHistory();
  }
  await expect(
    body.getByText("Existing DM history", { exact: true }),
  ).toBeVisible();
  await expect(composer).toBeFocused();
  const messageId = await row.getAttribute("data-message-id");
  const author = row.getByRole("button", { name: "View Avery Chen profile" });
  await author.click();
  const profile = page.getByRole("dialog", { name: "Profile", exact: true });
  await expect(profile).toBeVisible();
  await profile.getByRole("button", { name: "Close", exact: true }).click();
  await expect(author).toBeFocused();
  await expect(composer).toHaveText("Keep this draft");
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /reply/i })).toBeVisible();
  await expect(page.getByRole("region", { name: "New message" })).toHaveCount(
    0,
  );
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash))
    .toContain(`"messageId":"${messageId}"`);
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash))
    .toContain(`"threadRootId":"${messageId}"`);
  expect(app.commands).toHaveLength(0);
  expect(app.publications.filter((event) => event.kind === 9)).toHaveLength(0);
  expect(app.errors.unexplained()).toEqual([]);
});

test.describe("large recipient directory", () => {
  test.use({ directorySize: 1000 });

  // Browser-only: native scroll offset and the visible row's geometry must
  // survive the page that crosses the former 100-result rendering threshold.
  test("paging past 100 preserves the mounted row and scroll position", async ({
    page,
    app,
  }) => {
    app.holdBackground(4);
    await open(page, app);
    const options = page.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-setsize", "88");
    await expect
      .poll(() =>
        app.reads.some(
          (filter) =>
            filter.kinds?.includes(0) &&
            filter.limit === 30 &&
            filter.page === 4,
        ),
      )
      .toBe(true);
    const picker = page.getByRole("listbox", { name: "People" });
    await picker.evaluate((list) => {
      list.scrollTop = 600;
    });
    await expect
      .poll(() => picker.evaluate((list) => list.scrollTop))
      .toBe(600);
    const visiblePosition = () =>
      picker.evaluate((list) => {
        const top = list.getBoundingClientRect().top;
        return [...list.querySelectorAll('[role="option"]')]
          .find((row) => row.getBoundingClientRect().top >= top)
          ?.getAttribute("aria-posinset");
      });
    await expect.poll(visiblePosition).toBeTruthy();
    const position = await visiblePosition();
    const anchor = page.locator(`[role="option"][aria-posinset="${position}"]`);
    const node = await anchor.elementHandle();
    const top = await anchor.evaluate((row) => row.getBoundingClientRect().top);
    app.showBackground();
    await expect(options.first()).toHaveAttribute("aria-setsize", "999");
    await expect(
      page.getByRole("status", { name: "Loading people" }),
    ).toHaveCount(0);
    expect(await node.evaluate((row) => row.isConnected)).toBe(true);
    expect(await picker.evaluate((list) => list.scrollTop)).toBe(600);
    expect(
      await anchor.evaluate((row) => row.getBoundingClientRect().top),
    ).toBe(top);
  });

  test("reopens a bounded list and reaches offscreen recipients by keyboard and search", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const options = page.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-setsize", "999");
    await expect(
      page.getByRole("status", { name: "Loading people" }),
    ).toHaveCount(0);
    await openPage(page, "Workflows");
    await startNewMessage(page);
    const input = page.getByRole("combobox", { name: "Message recipients" });
    await expect(input).toBeFocused();
    // Cached discovery must not mount a thousand avatars before the pane paints.
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeLessThan(100);
    await input.press("ArrowUp");
    const last = page.locator('[role="option"][aria-posinset="999"]');
    const lastName = await last.getAttribute("aria-label");
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() =>
        last.evaluate((row) => {
          const list = row.closest('[role="listbox"]');
          return (
            row.getBoundingClientRect().bottom <=
            list.getBoundingClientRect().bottom + 1
          );
        }),
      )
      .toBe(true);
    await input.press("Enter");
    await expect(
      page.getByRole("button", { name: `Remove ${lastName}`, exact: true }),
    ).toBeVisible();
    await input.fill("Person 500");
    await expect(
      page.getByRole("option", { name: "Person 500", exact: true }),
    ).toBeVisible();
    await input.press("Enter");
    await expect(
      page.getByRole("button", { name: "Remove Person 500", exact: true }),
    ).toBeVisible();
  });
});
