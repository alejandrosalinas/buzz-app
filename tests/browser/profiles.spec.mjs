import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test("transient profiles replace without retiring Back/Forward return paths", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html");
  await page.waitForFunction(() => !!window.profilesFixture);
  const read = () =>
    page.evaluate(() => window.profilesFixture.navigation.snapshot());
  const channel = (await read()).entry.id;
  const view = async (name) => {
    await page
      .getByRole("button", { name: `View ${name} profile`, exact: true })
      .click();
    await expect(
      page
        .getByRole("complementary", { name: "Profile", exact: true })
        .getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    return (await read()).entry.id;
  };
  const viewer = await view("Viewer");
  const mic = await view("Mic");
  const tabs = page.getByRole("tablist", { name: "Panel tabs" });
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(viewer);
  await expect(
    tabs.getByRole("tab", { name: "Viewer", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await page.goForward();
  await expect.poll(async () => (await read()).entry.id).toBe(mic);
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await tabs
    .getByRole("tab", { name: "Mic", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close all tabs", exact: true })
    .click();
  await expect
    .poll(async () => (await read()).entry.target.detail)
    .toBeUndefined();
  const closed = (await read()).entry.id;
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(viewer);
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(channel);
  await page.goForward();
  await expect.poll(async () => (await read()).entry.id).toBe(viewer);
  await page.goForward();
  await expect.poll(async () => (await read()).entry.id).toBe(closed);
  expect((await read()).canGoForward).toBe(false);
});

// Real relay-session replacement and native history traversal exercise the
// page's close wiring; retirement identity partitions are covered by owner tests.
test("Close after same-scope replacement retires earlier profile visits through Back/Forward", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html");
  await page.waitForFunction(() => !!window.profilesFixture);
  const read = () =>
    page.evaluate(() => window.profilesFixture.navigation.snapshot());
  const channel = (await read()).entry.id;
  const view = async (name) => {
    await page
      .getByRole("button", { name: `View ${name} profile`, exact: true })
      .click();
    await expect(
      page
        .getByRole("complementary", { name: "Profile", exact: true })
        .getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    return (await read()).entry.id;
  };
  await view("Viewer");
  const other = await view("Mic");
  const current = await view("Viewer");
  await page.evaluate(() => window.profilesFixture.replace());
  const tabs = page.getByRole("tablist", { name: "Panel tabs" });
  const viewer = tabs.getByRole("tab", { name: "Viewer", exact: true });
  await expect(viewer).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await read()).entry.id).toBe(current);
  // Rebuild the neighbouring Q tab through passive traversal. #1767 restores
  // only the current address on replacement; #1793 also keeps the tab strip.
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(other);
  await expect(
    tabs.getByRole("tab", { name: "Mic", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect.poll(async () => (await read()).entry.id).toBe(current);
  await expect(viewer).toHaveAttribute("aria-selected", "true");
  await viewer
    .locator("..")
    .getByRole("button", { name: /^Close / })
    .click();
  await expect
    .poll(async () => (await read()).entry.target.detail)
    .toBeUndefined();
  const closed = (await read()).entry.id;
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(other);
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(channel);
  await expect(viewer).toHaveCount(0);
  await page.goForward();
  await expect.poll(async () => (await read()).entry.id).toBe(other);
  await expect(viewer).toHaveCount(0);
  await page.goForward();
  await expect.poll(async () => (await read()).entry.id).toBe(closed);
  expect((await read()).canGoForward).toBe(false);
  // A deliberate reopening gets a fresh visit and remains possible.
  expect(await view("Viewer")).not.toBe(current);
});

// Native traversal and the real page close callback must use inherited identity
// while the successor's exact-message lookup is explicitly held.
test("Close before successor reply resolution retires the inherited verified thread", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html");
  await page.waitForFunction(() => !!window.profilesFixture);
  const read = () =>
    page.evaluate(() => window.profilesFixture.navigation.snapshot());
  const initial = (await read()).entry.target;
  await page.evaluate(
    (target) => window.profilesFixture.navigation.open(target),
    {
      ...initial,
      channelId: "two",
    },
  );
  const before = (await read()).entry;
  await page.evaluate(
    (target) => window.profilesFixture.navigation.open(target),
    initial,
  );
  const channel = (await read()).entry;
  await page
    .getByRole("button", { name: "View thread: 1 reply", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "View Pinky profile", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const fixture = window.profilesFixture;
    const target = fixture.navigation.snapshot().entry.target;
    return fixture.navigation.open({
      ...target,
      messageId: fixture.messages.reply,
      threadRootId: undefined,
    });
  });
  const tabs = page.locator(
    '[data-panel-workspace] [role="tab"][data-tab-value^="thread:"]',
  );
  const root = await page.evaluate(() => window.profilesFixture.messages.root);
  await expect(tabs).toHaveCount(1); // The reply reader verified and merged into R.
  await expect(tabs).toHaveAttribute("data-tab-value", `thread:one:${root}`);
  await page.evaluate(() => {
    window.profilesFixture.holdReply();
    window.profilesFixture.replace();
  });
  try {
    await expect
      .poll(() => page.evaluate(() => window.profilesFixture.replyPending()))
      .toBe(true);
    await expect(tabs).toHaveCount(1);
    await tabs
      .locator("..")
      .getByRole("button", { name: /^Close / })
      .click();
    await expect.poll(async () => (await read()).entry).toEqual(channel);
    await expect(tabs).toHaveCount(0);
    expect((await read()).canGoBack).toBe(true);
    expect((await read()).canGoForward).toBe(false);
    await page.goBack();
    await expect.poll(async () => (await read()).entry).toEqual(before);
    await page.goForward();
    await expect.poll(async () => (await read()).entry).toEqual(channel);
  } finally {
    await page.evaluate(() => window.profilesFixture.releaseReply());
  }
  await expect(tabs).toHaveCount(0);
});

// Browser history must restore the selected profile and skip an explicitly
// dismissed inactive tab; hook tests cannot establish native event traversal.
test("profile visits survive passive traversal and X retires active and inactive visits", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html");
  await page.waitForFunction(() => !!window.profilesFixture);
  const read = () =>
    page.evaluate(() => window.profilesFixture.navigation.snapshot());
  const avatar = page.getByRole("button", {
    name: "View Viewer profile",
    exact: true,
  });
  await expect(avatar).toBeVisible();
  const channel = (await read()).entry.id;
  await avatar.click();
  const viewer = (await read()).entry.id;
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "Viewer", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(channel);
  await expect(panel).toBeHidden();
  await page.goForward();
  await expect.poll(async () => (await read()).entry.id).toBe(viewer);
  await expect(
    panel.getByRole("heading", { name: "Viewer", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View Mic profile", exact: true })
    .click();
  await expect(
    panel.getByRole("heading", { name: "Mic", exact: true }),
  ).toBeVisible();
  const mic = (await read()).entry.id;
  const tabs = page.getByRole("tablist", { name: "Panel tabs" });
  await expect(
    tabs.getByRole("tab", { name: "Viewer", exact: true }),
  ).toHaveCount(0);
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(viewer);
  await page.goForward();
  await expect.poll(async () => (await read()).entry.id).toBe(mic);
  await tabs
    .getByRole("tab", { name: "Mic", exact: true })
    .locator("..")
    .getByRole("button", { name: /^Close / })
    .click();
  await expect
    .poll(async () => (await read()).entry.target.detail)
    .toBeUndefined();
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(viewer);
  await tabs
    .getByRole("tab", { name: "Viewer", exact: true })
    .locator("..")
    .getByRole("button", { name: /^Close / })
    .click();
  await expect.poll(async () => (await read()).entry.id).toBe(channel);
  await avatar.click();
  await expect(
    panel.getByRole("heading", { name: "Viewer", exact: true }),
  ).toBeVisible();
  // Members composes above a content visit without replacing that content.
  const reopened = (await read()).entry.id;
  await page
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
  const members = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  await expect(members).toBeVisible();
  await page.goBack();
  await expect.poll(async () => (await read()).entry.id).toBe(reopened);
  await expect(members).toBeHidden();
  await expect(panel).toBeVisible();
  await page.goForward();
  await expect(members).toBeVisible();
  await members.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(async () => (await read()).entry.id).toBe(reopened);
  await expect(members).toBeHidden();
  await expect(panel).toBeVisible();
});

test("closing a profile beside a main thread preserves the thread destination", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-thread-placement.v1", "main"),
  );
  await page.goto("/tests/fixtures/profiles.html");
  await page
    .getByRole("button", { name: "View thread: 1 reply", exact: true })
    .click();
  const main = page.locator("[data-main-workspace]");
  const thread = main.locator('[role="tab"][data-tab-value^="thread:"]');
  await expect(thread).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "View Pinky profile", exact: true })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "Pinky", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("tablist", { name: "Panel tabs" })
    .getByRole("button", { name: "Close Pinky tab", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(thread).toHaveAttribute("aria-selected", "true");
  await expect(
    main.getByRole("button", { name: "View Pinky profile", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!window.profilesFixture.navigation.snapshot().entry.target.messageId,
      ),
    )
    .toBe(true);
});

test("profile plumbing: exact avatar/mention targets, thread enrichment, lifecycle and recovery", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/profiles.html");
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await page.waitForFunction(() => !!window.profilesFixture);
  const npubs = await page.evaluate(() => window.profilesFixture.npubs);
  const key = page
    .getByRole("complementary", { name: "Profile", exact: true })
    .locator("code");
  const avatar = page.getByRole("button", {
    name: "View Viewer profile",
    exact: true,
  });
  await expect(avatar).toHaveCount(1);
  await expect(avatar.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  await avatar.focus();
  await avatar.press("Enter");
  await expect(key).toHaveText(npubs.viewer);
  const viewerTab = page
    .getByRole("tablist", { name: "Panel tabs" })
    .getByRole("tab", { name: "Viewer", exact: true });
  await expect(viewerTab.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  await expect(viewerTab.locator("img")).toHaveCount(1);

  const portrait = panel.getByRole("img", { name: "Viewer avatar" });
  await expect(portrait).toBeVisible();
  const name = panel.getByRole("heading", { name: "Viewer", exact: true });
  const portraitWidth = await portrait.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(portraitWidth).toBeCloseTo(80, 0);
  expect(
    await portrait.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBeCloseTo(portraitWidth, 0);
  expect(
    await name.evaluate(
      (element, portrait) =>
        element.getBoundingClientRect().top >=
        portrait.getBoundingClientRect().bottom,
      await portrait.elementHandle(),
    ),
  ).toBe(true);
  await expect
    .poll(async () => {
      const heading = await name.boundingBox();
      const image = await portrait.boundingBox();
      return Math.abs(
        heading.x + heading.width / 2 - image.x - image.width / 2,
      );
    })
    .toBeLessThan(1);
  expect(
    await page.evaluate(() => window.profilesFixture.report.media),
  ).toContainEqual(["https://images.test/avatar.png", "small"]);
  await expect(panel.getByText("Human profile", { exact: true })).toBeVisible();
  // Stub clipboard at the browser boundary: test the UI's exact key and
  // recovery, without relying on OS permission/pasteboard behavior in CI.
  await page.evaluate(() => {
    window.profileCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => window.profileCopies.push(value) },
    });
  });
  await panel.getByRole("button", { name: "Copy npub" }).click();
  await expect(panel.getByRole("status")).toHaveText("Public key copied.");
  expect(await page.evaluate(() => window.profileCopies)).toEqual([
    npubs.viewer,
  ]);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("denied");
    };
  });
  await panel.getByRole("button", { name: "Copy npub" }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "Could not copy. Select the public key above to copy it.",
  );
  await expect(key).toHaveText(npubs.viewer);
  await page.clock.install();
  await page.getByRole("region", { name: "Profile details" }).press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(avatar).toBeFocused();
  // Settle the preview's timer before testing the one-Escape handoff.
  await page.clock.runFor(600);
  const preview = page.getByRole("dialog", { name: "Viewer profile preview" });
  await expect(preview).toBeHidden();
  // Cover both a stationary pointer and an exit while Profile obscures the
  // avatar. Returning focus stays quiet; a fresh hover visit still works.
  for (const pointerVisit of ["stationary", "away", "back"]) {
    await page.mouse.move(0, 0);
    await avatar.hover();
    // Previews open once the pointer rests (DESIGN.md "Hover timing").
    await page.clock.runFor(600);
    await expect(preview).toBeVisible();
    await avatar.click();
    await expect(key).toHaveText(npubs.viewer);
    if (pointerVisit !== "stationary") await page.mouse.move(0, 0);
    if (pointerVisit === "back") {
      // Profile pushes the avatar aside. Hover waits for it to settle, so the
      // pointer rests on the pushed avatar, not where Escape puts it back.
      await avatar.hover();
      // Complete this hover while Profile is still open. Otherwise its timer
      // can fire after Escape and legitimately count as a fresh hover visit.
      await page.clock.runFor(300);
      await expect(preview).toBeHidden();
    }
    await page.getByRole("region", { name: "Profile details" }).press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(avatar).toBeFocused();
    if (pointerVisit === "stationary") {
      const rect = await avatar.boundingBox();
      await page.mouse.move(
        rect.x + rect.width / 2 + 1,
        rect.y + rect.height / 2,
      );
    }
    await page.clock.runFor(600);
    await expect(preview).toBeHidden();
  }
  await page.clock.resume();
  // A deliberate new hover visit still opens the avatar preview after return.
  await page.mouse.move(0, 0);
  await avatar.hover();
  await expect(preview).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(preview).toBeHidden();
  const mention = page.getByRole("button", {
    name: "View Mic profile",
    exact: true,
  });
  await mention.click();
  await expect(key).toHaveText(npubs.mic);
  await expect(panel.getByText("📅 In a meeting")).toBeVisible();
  await expect(panel.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await expect(mention).toBeFocused();
  await mention.press("Space");
  await expect(key).toHaveText(npubs.mic);
  await page.evaluate(() =>
    window.profilesFixture.change("disable", "buzz.profiles"),
  );
  await expect(panel).toHaveCount(0);
  await expect(mention).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Channel message history" })
      .locator('span[data-mention-kind="person"][data-mention-name="Mic"]'),
  ).toBeVisible();
  await page.evaluate(() =>
    window.profilesFixture.change("enable", "buzz.profiles"),
  );
  await expect(mention).toHaveCount(1);
  await expect(panel).toHaveCount(0);
  await page
    .getByRole("button", { name: "View thread: 1 reply", exact: true })
    .click();
  const threadMention = page.getByRole("button", {
    name: "View Pinky profile",
    exact: true,
  });
  await expect(threadMention).toBeVisible();
  await threadMention.click();
  await expect(key).toHaveText(npubs.pinky);
  await expect(panel.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await expect(
    panel.getByRole("img", { name: "Pinky avatar" }),
  ).toHaveAttribute("data-size", "fill");
  await expect(panel.getByText("Agent profile", { exact: true })).toBeVisible();
  const identity = panel.getByRole("region", { name: "Agent identity" });
  await expect(identity).toContainText("Managed by");
  await expect(
    identity.getByRole("button", { name: "Open owner profile: Viewer (you)" }),
  ).toBeVisible();
  // Existing navigation journey also proves keyboard copy and host toast wiring.
  await expect(panel.getByRole("tab", { name: "Memories" })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "Runtime" })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /^Copy Agent type:/ }),
  ).toHaveCount(0);
  const nip05 = panel.getByRole("button", { name: /^Copy NIP-05:/ });
  await expect(
    panel.getByText("pinky@example.test", { exact: true }),
  ).toBeVisible();
  await expect(nip05).toHaveText("Copy");
  // The explicit copy action remains keyboard reachable.
  await nip05.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(nip05).toBeFocused();
  await expect(nip05).toBeVisible();
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (value) =>
      window.profileCopies.push(value);
  });
  await nip05.press("Enter");
  await expect(page.getByText("Copied nip-05", { exact: true })).toBeVisible();
  await expect(nip05).toHaveText("Copied");
  expect(await page.evaluate(() => window.profileCopies.slice(-1))).toEqual([
    "pinky@example.test",
  ]);

  await panel.getByRole("tab", { name: "Channels" }).click();
  await expect(panel.getByRole("region", { name: "Channels" })).toContainText(
    "One",
  );
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await expect(
    page.locator(
      '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
    ),
  ).toBeFocused();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  const missingKey = await page.evaluate(
    () => window.profilesFixture.keys.missing,
  );
  const unknownAvatar = page.getByRole("button", {
    name: `View ${missingKey.slice(0, 10)} profile`,
  });
  await expect(unknownAvatar.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await unknownAvatar.click();
  await expect(key).toHaveText(npubs.missing);
  await expect(panel.getByText("Could not load this profile.")).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Unknown agent", exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("img", { name: "Unknown agent avatar" })
      .locator("[data-avatar-shape]"),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  await expect(panel.getByRole("tab", { name: "Runtime" })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "Memories" })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /^(Start|Stop|Restart|Delete agent)$/ }),
  ).toHaveCount(0);
  await page.evaluate(() => window.profilesFixture.recover());
  await panel.getByRole("button", { name: "Retry profile" }).click();
  await expect(panel.getByText("Recovered biography")).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Recovered", exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("img", { name: "Recovered avatar" })
      .locator("[data-avatar-shape]"),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  for (const mode of ["light", "dark"]) {
    if (mode === "dark")
      await page.getByRole("button", { name: "Toggle appearance" }).click();
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(key).toBeVisible();
      const layout = await panel.evaluate((element) => {
        const region = element.querySelector('[aria-label="Profile details"]');
        const key = element.querySelector("code");
        return {
          padding: parseFloat(getComputedStyle(region).paddingLeft),
          overflow: element.scrollWidth > element.clientWidth,
          keyOverflow: key.scrollWidth > key.clientWidth,
        };
      });
      expect(layout.padding).toBeGreaterThanOrEqual(16);
      expect(layout.overflow).toBe(false);
      expect(layout.keyOverflow).toBe(false);
      await panel.screenshot({
        path: testInfo.outputPath(`profile-${mode}-${width}.png`),
      });
    }
  }
  const visit = await page.evaluate(() => {
    const visit = window.profilesFixture.navigation.snapshot().entry;
    window.profilesFixture.replace();
    return visit;
  });
  // Same-account/community replacement reconstructs the read-only address;
  // it does not keep the old live session or its callbacks.
  await expect(
    panel.getByRole("heading", { name: "Recovered", exact: true }),
  ).toBeVisible();
  const current = () =>
    page.evaluate(() => window.profilesFixture.navigation.snapshot().entry);
  await expect.poll(current).toEqual(visit);
  await page.goBack();
  // Earlier visits in this journey can themselves be Profiles.
  await expect.poll(async () => (await current()).id).not.toBe(visit.id);
  await page.goForward();
  await expect.poll(current).toEqual(visit);
  await expect(
    panel.getByRole("heading", { name: "Recovered", exact: true }),
  ).toBeVisible();
  const reads = await page.evaluate(() => ({
    reads: window.profilesFixture.report.profileReads,
    key: window.profilesFixture.keys.pinky,
  }));
  expect(reads.reads.some((batch) => batch.includes(reads.key))).toBe(true);
  expect(errors.unexplained()).toEqual([]);
});

test("contextual panel callbacks retire with opening, channel, contribution and session", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html?context-probe");
  const avatar = page.getByRole("button", {
    name: "View Viewer profile",
    exact: true,
  });
  const panel = page.getByRole("complementary", {
    name: "Context probe",
    exact: true,
  });
  const capture = async () => {
    await avatar.click();
    await expect(panel).toBeVisible();
    await page.evaluate(() => {
      window.oldPanelContext = window.profilesFixture.contexts.at(-1);
    });
  };
  const invoke = () =>
    page.evaluate(() =>
      window.oldPanelContext.open(window.profilesFixture.targets.mic),
    );
  await capture();
  expect(await page.evaluate(() => window.oldPanelContext.channelId)).toBe(
    "one",
  );
  expect(await invoke()).toBe(true);
  // A second synchronous use of the old opening must not replace its successor.
  expect(await invoke()).toBe(false);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await capture();
  await page.locator('[data-channel-id="two"]').click();
  await expect(panel).toHaveCount(0);
  expect(await invoke()).toBe(false);
  await page.locator('[data-channel-id="one"]').click();
  await capture();
  await page.evaluate(() =>
    window.profilesFixture.change("disable", "context.probe"),
  );
  expect(await invoke()).toBe(false);
  await expect(panel).toHaveCount(0);
  await page.evaluate(() =>
    window.profilesFixture.change("enable", "context.probe"),
  );
  await expect(avatar).toBeVisible();
  expect(await invoke()).toBe(false);
  await capture();
  await page.evaluate(() => window.profilesFixture.replace());
  expect(await invoke()).toBe(false);
  await expect(panel).toHaveCount(0);
  await capture();
  await page.evaluate(() => window.profilesFixture.disconnect());
  expect(await invoke()).toBe(false);
  await expect(panel).toHaveCount(0);
});

// Messaging an agent needs this machine's own agent for this community, taken
// from the LocalAgents snapshot; a profile's agent hint alone never grants it.
for (const local of [false, true]) {
  test(`profile Message for humans and agents ${local ? "kept" : "not kept"} on this machine`, async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    await page.goto(
      `/tests/fixtures/profiles.html?member-message${local ? "&local-agent" : ""}`,
    );
    const panel = page.getByRole("complementary", {
      name: "Profile",
      exact: true,
    });
    const message = panel.getByRole("button", { name: "Message", exact: true });
    await page
      .getByRole("button", { name: "View Mic profile", exact: true })
      .click();
    await expect(message).toBeVisible();
    await page
      .getByRole("button", { name: /^Close (?!Thread).* tab$/ })
      .click();
    await page
      .getByRole("button", { name: "View thread: 1 reply", exact: true })
      .click();
    await page
      .getByRole("button", { name: "View Pinky profile", exact: true })
      .click();
    await expect(
      panel.getByText("Agent profile", { exact: true }),
    ).toBeVisible();
    if (!local) {
      await expect(message).toHaveCount(0);
      expect(await page.evaluate(() => window.profilesFixture.dmOpens)).toEqual(
        [],
      );
    } else {
      await message.click();
      await expect
        .poll(() => page.evaluate(() => window.profilesFixture.dmOpens))
        .toEqual([
          [await page.evaluate(() => window.profilesFixture.keys.pinky)],
        ]);
    }
    expect(errors.unexplained()).toEqual([]);
  });
}

test("member rows hand off to Profiles without trapping or losing keyboard focus", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/profiles.html");
  const members = page.getByRole("button", {
    name: "Manage members",
    exact: true,
  });
  await members.click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
    includeHidden: true,
  });
  // The popup owns modal semantics; the active step owns the visible card.
  const surface = dialog.locator(".buzz-dialog-step:not([inert])");
  const body = dialog.locator(".buzz-dialog-body");
  const group = dialog.getByRole("region", { name: "People", exact: true });
  const list = dialog.getByRole("region", { name: "Member list", exact: true });
  const search = dialog.getByRole("searchbox");
  // Browser-only: one flexing list owns scrolling; title and search
  // remain fixed across themes and viewport widths.
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 320 });
      await expect(surface).toBeInViewport({ ratio: 1 });
      // Measure the settled layout, not the open or resize transition.
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished),
        );
      });
      await expect(surface).toHaveCSS(
        "background-color",
        mode === "light" ? "rgb(255, 255, 255)" : "rgb(40, 40, 40)",
      );
      await expect(surface).toHaveCSS("backdrop-filter", "none");
      await expect(body).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(body).toHaveCSS("border-top-width", "0px");
      await expect(body).toHaveCSS("overflow-y", "hidden");
      const bodyBounds = await list.locator("..").boundingBox();
      const footerBounds = await dialog
        .locator(".buzz-dialog-actions")
        .boundingBox();
      // The roster scrolls inside the body, above the Copy link / Done footer.
      expect(bodyBounds.y + bodyBounds.height).toBeLessThanOrEqual(
        footerBounds.y + 1,
      );
      await expect(list).toHaveCSS("overflow-y", "auto");
      await expect(list).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      // The unframed roster scrolls to the dialog edge with a thin scrollbar.
      for (const edge of ["top", "right", "bottom", "left"]) {
        await expect(list).toHaveCSS(`border-${edge}-width`, "0px");
      }
      await expect(list).toHaveCSS("scrollbar-width", "thin");
      await expect(group).toHaveCSS("border-top-width", "0px");
      await expect(group).toHaveCSS("overflow-y", "visible");
      const member = group.getByRole("listitem").first();
      await expect(member).toHaveCSS("padding-inline-end", "0px");
      const header = dialog.locator(".buzz-dialog-header");
      await expect(
        dialog.getByRole("button", { name: "Refresh member data" }),
      ).toHaveCount(0);
      const close = header.getByRole("button", { name: "Close" });
      await expect(close.locator("svg")).toHaveCSS("width", "16px");
      await expect(close.locator("svg")).toHaveCSS("height", "16px");
      expect(await body.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        false,
      );
      const headerBounds = await header.boundingBox();
      const searchBounds = await search.boundingBox();
      const listBounds = await list.boundingBox();
      const groupBounds = await group.boundingBox();
      expect(await list.evaluate((el) => el.clientTop)).toBe(0);
      expect(await list.evaluate((el) => el.clientLeft)).toBe(0);
      expect(await list.evaluate((el) => el.clientHeight)).toBe(
        Math.round(listBounds.height),
      );
      expect(await list.evaluate((el) => el.clientWidth)).toBe(
        Math.round(listBounds.width),
      );
      expect(await list.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        false,
      );
      // Short result viewports let headings scroll away so they cannot cover
      // actions. This read-only fixture has a notice before the first group.
      await expect(list).toHaveCSS("padding-top", "0px");
      const firstHeading = list.getByRole("heading").first();
      await expect(firstHeading).toHaveCSS("position", "static");
      const headingBounds = await firstHeading.boundingBox();
      const leadingContent = Math.round(headingBounds.y - listBounds.y);
      for (const scrollTop of [0, 1, 8, 16]) {
        await list.evaluate((el, top) => {
          el.scrollTop = top;
        }, leadingContent + scrollTop);
        await expect
          .poll(() => list.evaluate((el) => el.scrollTop))
          .toBe(leadingContent + scrollTop);
        await expect
          .poll(async () => Math.round((await firstHeading.boundingBox()).y))
          .toBe(Math.round(headingBounds.y) - leadingContent - scrollTop);
      }
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(() => list.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      expect(await header.boundingBox()).toEqual(headerBounds);
      expect(await search.boundingBox()).toEqual(searchBounds);
      expect(await list.boundingBox()).toEqual(listBounds);
      expect((await group.boundingBox()).y).toBeLessThan(groupBounds.y);
      expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
      expect(await dialog.evaluate((el) => el.scrollTop)).toBe(0);
      // The list owns scrolling. At this short frame, its parent layout is the
      // only other scroller, a fallback that keeps one row reachable.
      expect(
        await dialog.evaluate((el) =>
          [...el.querySelectorAll("*")]
            .filter(
              (child) =>
                /^(auto|scroll)$/.test(getComputedStyle(child).overflowY) &&
                child.scrollHeight > child.clientHeight,
            )
            .map(
              (child) =>
                child.getAttribute("aria-label") ??
                (child.querySelector(':scope > [aria-label="Member list"]')
                  ? "layout"
                  : "unexpected"),
            )
            .filter((label) => label !== "layout"),
        ),
      ).toEqual(["Member list"]);
      await list.evaluate((el) => {
        el.scrollTop = 0;
      });
      // With room for a heading and its rows, the heading still pins as soon
      // as the preceding notice scrolls out, without an extra padding slide.
      await page.setViewportSize({ width, height: 530 });
      // Give the collection 9rem: above the 8rem sticky-heading threshold,
      // while retaining scroll range past its notice. Derive viewport height
      // from native layout so wrapped recovery content cannot change the state.
      const contentHeight = () =>
        list.evaluate((el) => {
          const style = getComputedStyle(el);
          return (
            el.clientHeight -
            parseFloat(style.paddingTop) -
            parseFloat(style.paddingBottom)
          );
        });
      const measuredHeight = await contentHeight();
      await page.setViewportSize({ width, height: 530 + 144 - measuredHeight });
      await expect.poll(contentHeight).toBe(144);
      await expect(firstHeading).toHaveCSS("position", "sticky");
      const roomyListBounds = await list.boundingBox();
      const roomyHeadingBounds = await firstHeading.boundingBox();
      const roomyLeadingContent = Math.round(
        roomyHeadingBounds.y - roomyListBounds.y,
      );
      // Prove the fixture can scroll past its notice and exercise pinning.
      expect(
        await list.evaluate((el) => el.scrollHeight - el.clientHeight),
      ).toBeGreaterThanOrEqual(roomyLeadingContent + 16);
      for (const scrollTop of [0, 1, 8, 16]) {
        await list.evaluate((el, top) => {
          el.scrollTop = top;
        }, roomyLeadingContent + scrollTop);
        await expect
          .poll(() => list.evaluate((el) => el.scrollTop))
          .toBe(roomyLeadingContent + scrollTop);
        // Sticky headings snap to whole pixels inside a fractional frame.
        await expect
          .poll(async () => Math.round((await firstHeading.boundingBox()).y))
          .toBe(Math.round(roomyListBounds.y));
      }
      await list.evaluate((el) => {
        el.scrollTop = 0;
      });
      // The viewport fills spare height, not the Members group. Search results
      // and recovery content must follow the short roster without a flex spacer.
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => list.evaluate((el) => el.clientHeight))
        .toBeGreaterThan(roomyListBounds.height);
      await expect(group).toHaveCSS("flex-grow", "0");
      expect((await group.boundingBox()).height).toBeLessThan(
        (await list.boundingBox()).height,
      );
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  const row = dialog.getByRole("button", {
    name: /^Open profile for Viewer/,
    includeHidden: true,
  });
  const memberRow = row.locator("xpath=ancestor::li[1]");
  const name = memberRow.getByText("Viewer (you)", { exact: true });
  await expect(name).toBeVisible();
  await search.hover();
  const nameAtRest = await name.boundingBox();
  const rowAtRest = await row.boundingBox();
  // Hover never reveals a second line or moves the identity.
  await row.hover();
  await expect(name).toBeVisible();
  await expect(name.locator("..")).toHaveCSS("opacity", "1");
  expect(await name.boundingBox()).toEqual(nameAtRest);
  expect(await row.boundingBox()).toEqual(rowAtRest);
  await row.locator("[data-avatar-shape]").click();
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  // Mainline panel navigation focuses the selected tab, not the details body.
  const profileTab = page
    .getByRole("tablist", { name: "Panel tabs" })
    .getByRole("tab", { name: "Viewer", exact: true });
  await expect(dialog).toHaveCount(0);
  await expect(profileTab).toBeFocused();
  await expect(
    panel.getByRole("heading", { name: "Viewer", exact: true }),
  ).toBeVisible();
  await profileTab.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(members).toBeFocused();
  await members.press("Enter");
  await row.focus();
  await row.press("Enter");
  await expect(profileTab).toBeFocused();
  await profileTab.press("Escape");
  await expect(members).toBeFocused();
  // Every row, including the viewer and protected identities, has one
  // always-visible action slot. Hover/focus never changes row geometry.
  await members.click();
  const actions = memberRow.getByRole("button", {
    name: "Actions for Viewer",
    includeHidden: true,
  });
  const actionSlot = actions.locator("..");
  await search.focus();
  await search.hover();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
  });
  const restingBounds = await row.boundingBox();
  await memberRow.hover();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  expect(await row.boundingBox()).toEqual(restingBounds);
  await actions.click();
  const menu = page.getByRole("menu", { name: "Actions for Viewer" });
  await expect(menu.getByRole("menuitem")).toHaveText(["View profile"]);
  await expect(menu).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(actions).toBeFocused();
  await expect(dialog).toBeVisible();
  await row.focus();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(actions).toBeFocused();
  await actions.press("Enter");
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await expect(dialog).toBeVisible();

  // Browser-only: portal menus inside a modal must hand focus to the profile
  // panel, or restore the correct row control on Escape, without closing both.
  for (const entry of ["ellipsis", "right-click", "Shift+F10", "ContextMenu"]) {
    if (entry === "ellipsis") await actions.press("Enter");
    else if (entry === "right-click") await row.click({ button: "right" });
    else await row.press(entry);
    await expect(menu.getByRole("menuitem")).toHaveText(["View profile"]);
    if (entry === "right-click") {
      await expect(menu).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(row).toBeFocused();
      await row.click({ button: "right" });
    }
    await menu.getByRole("menuitem", { name: "View profile" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(profileTab).toBeFocused();
    await profileTab.press("Escape");
    await expect(members).toBeFocused();
    await members.press("Enter");
  }
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.evaluate(() =>
    window.profilesFixture.change("disable", "buzz.profiles"),
  );
  await members.click();
  await expect(
    dialog.getByRole("button", { name: /^Open profile for/ }),
  ).toHaveCount(0);
  await expect(dialog.getByText("Viewer (you)", { exact: true })).toBeVisible();
  const staticActions = dialog.getByRole("button", {
    name: "Actions for Viewer",
  });
  const staticMember = staticActions.locator("xpath=ancestor::li");
  await staticMember.hover();
  await staticActions.click();
  await expect(
    menu.getByRole("menuitem", { name: "View profile" }),
  ).toBeDisabled();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(staticActions).toBeFocused();
  expect(errors.unexplained()).toEqual([]);
});

// Touch has no hover discovery. The action must be visible and operable at rest,
// with the real Base UI menu/modal focus layers rather than a DOM-only substitute.
test.describe("touch member actions", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("keeps the ellipsis available without hover", async ({ page }) => {
    await page.goto("/tests/fixtures/profiles.html");
    const members = page.getByRole("button", {
      name: "Manage members",
      exact: true,
    });
    await members.tap();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const actions = dialog.getByRole("button", { name: "Actions for Viewer" });
    await expect(actions.locator("..")).toHaveCSS("opacity", "1");
    await actions.tap();
    await page.getByRole("menuitem", { name: "View profile" }).tap();
    await expect(dialog).toHaveCount(0);
    const profileTab = page
      .getByRole("tablist", { name: "Panel tabs" })
      .getByRole("tab", { name: "Viewer", exact: true });
    await expect(profileTab).toBeFocused();
    await profileTab.press("Escape");
    await expect(members).toBeFocused();
  });
});

// Real Members -> verified session DM -> ChannelsPage navigation/focus handoff.
// Only the relay transport is synthetic; this must never send a live message.
test("member Send message navigates a human DM without sending or returning focus to Members", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/profiles.html?member-message");
  await page
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  const actions = dialog.getByRole("button", {
    name: "Actions for Mic",
    exact: true,
  });
  await actions.locator("xpath=ancestor::li").hover();
  await actions.click();
  const menu = page.getByRole("menu", { name: "Actions for Mic", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "View profile",
    "Send message",
  ]);
  await menu
    .getByRole("menuitem", { name: "Send message", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.profilesFixture.dmOpens))
    .toEqual([[await page.evaluate(() => window.profilesFixture.keys.mic)]]);
  await expect(
    page.getByRole("tab", { name: "Mic", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Mic", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Manage members", exact: true }),
  ).not.toBeFocused();
  expect(
    await page.evaluate(() => window.profilesFixture.report.publications),
  ).toBe(0);
  // The handoff retires Members; Back returns to the channel without replaying
  // the DM open or send.
  await page.evaluate(() => window.profilesFixture.navigation.back());
  await expect(
    page.getByRole("button", { name: "Manage members", exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.profilesFixture.navigation.snapshot().entry.target.panel,
    ),
  ).toBeUndefined();
  await page.evaluate(() => window.profilesFixture.navigation.forward());
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Mic", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.profilesFixture.dmOpens)).toEqual([
    [await page.evaluate(() => window.profilesFixture.keys.mic)],
  ]);
  expect(
    await page.evaluate(() => window.profilesFixture.report.publications),
  ).toBe(0);
  expect(errors.unexplained()).toEqual([]);
});

// Positioning and CSS motion must be checked in rendering engines, including
// the persisted interface scale that changes popup geometry before first open.
test("profile preview stays inside a Solo conversation beside another pane", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html?solo");
  await page.getByRole("button", { name: "One", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "One", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View Viewer profile", exact: true })
    .hover();
  const preview = page.getByRole("dialog", { name: "Viewer profile preview" });
  await expect(preview).toBeVisible();
  const pane = page.getByRole("article", { name: "Conversation" });
  await expect
    .poll(async () => {
      const card = await preview.boundingBox();
      const bounds = await pane.boundingBox();
      return (
        !!card &&
        !!bounds &&
        card.x >= bounds.x &&
        card.x + card.width <= bounds.x + bounds.width
      );
    })
    .toBe(true);
});

test("profile preview fits enlarged text and stops its status with reduced motion", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.addInitScript(() =>
    localStorage.setItem("buzz-font-scale.v1", "2"),
  );
  await page.goto("/tests/fixtures/profiles.html?long-status");
  const avatar = page.getByRole("button", {
    name: "View Viewer profile",
    exact: true,
  });
  await expect(page.locator("html")).toHaveCSS("--buzz-text-scale", "2");
  await expect(avatar).toBeVisible();
  await page.getByRole("button", { name: "Toggle appearance" }).focus();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    if (await avatar.evaluate((node) => node === document.activeElement)) break;
  }
  await expect(avatar).toBeFocused();
  const preview = page.getByRole("dialog", { name: "Viewer profile preview" });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS("transform", "none");
  const ticker = preview.locator('[title="🇺🇸 Working EST hours until Oct 23"]');
  await expect(ticker).toHaveAttribute("data-overflow");
  await expect(preview).toBeInViewport({ ratio: 1 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(ticker.locator(":scope > span")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(ticker.locator(":scope > span")).toHaveCSS("transform", "none");
  await expect(preview).toBeInViewport({ ratio: 1 });
  await preview.screenshot({
    path: testInfo.outputPath("preview-reduced-light.png"),
  });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await preview.screenshot({
    path: testInfo.outputPath("preview-reduced-dark.png"),
  });
  const profileAction = preview.getByRole("button", {
    name: "View profile",
    exact: true,
  });
  await avatar.press("Tab");
  await page.keyboard.press("Tab");
  await expect(profileAction).toBeFocused();
  await expect(profileAction).toBeInViewport({ ratio: 1 });
  await profileAction.click();
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(panel).toBeVisible();
  // At 390 px the hero column fits only the emoji. Widen it so the long status
  // shows and ends in an ellipsis inside the hero.
  await page.setViewportSize({ width: 600, height: 600 });
  const status = panel.getByText("Working EST hours until Oct 23", {
    exact: true,
  });
  const hero = panel
    .getByRole("heading", { name: "Viewer", exact: true })
    .locator("xpath=../..");
  await expect(status).toBeVisible();
  await expect
    .poll(async () =>
      status.evaluate(
        (text, hero) => ({
          inside:
            text.getBoundingClientRect().right <=
            hero.getBoundingClientRect().right,
          truncated: text.scrollWidth > text.clientWidth,
        }),
        await hero.elementHandle(),
      ),
    )
    .toEqual({ inside: true, truncated: true });
});

// Browser-only: the preview paints in the native top layer, above any z-index,
// so only a rendering engine shows whether its hints paint above it.
test("profile preview names its status emoji above the card and stays open over the hint", async ({
  page,
}) => {
  // Hold the status ticker still under the pointer.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/fixtures/profiles.html?long-status");
  const avatar = page.getByRole("button", {
    name: "View Viewer profile",
    exact: true,
  });
  await expect(avatar).toBeVisible();
  await page.clock.install();
  await avatar.hover();
  await page.clock.runFor(600);
  const preview = page.getByRole("dialog", { name: "Viewer profile preview" });
  await expect(preview).toBeVisible();
  await preview.getByText("🇺🇸", { exact: true }).first().hover();
  await page.clock.runFor(300);
  const hint = page.locator(".buzz-tooltip[data-open]");
  await expect(hint).toHaveText(":us:");
  // The hint covers the card's name row. Assert paint order, not visibility:
  // Base UI makes a non-hoverable hint pass the pointer through, so restore
  // hit testing only to ask what is topmost at the hint's center.
  await expect
    .poll(() =>
      hint.evaluate((tip) => {
        const positioner = tip.parentElement;
        const rect = tip.getBoundingClientRect();
        const pointerEvents = positioner.style.pointerEvents;
        positioner.style.pointerEvents = "auto";
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        positioner.style.pointerEvents = pointerEvents;
        return tip.contains(hit);
      }),
    )
    .toBe(true);
  // Moving onto the hint stays over the card, so the preview does not close.
  const box = await hint.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 4,
  });
  await page.clock.runFor(600);
  await expect(preview).toHaveAttribute("data-open", "");
});
