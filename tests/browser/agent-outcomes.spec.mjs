import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { pauseClock } from "./clock.mjs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  historyCounts: { alpha: 1, beta: 1 },
});

// Host integration: exact signed failure messages fold into one real timeline
// disclosure, preserving their anchors and keyboard focus. jsdom cannot prove
// virtual-list ownership or the resulting bubble and action geometry.
test("a remote failure shares its expandable history and preserves its message anchor", async ({
  page,
  app,
}) => {
  await page.clock.install();
  const key = generateSecretKey();
  const agent = getPublicKey(key);
  app.serveProfile(key, { name: "Remote tester", is_agent: true });
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: [{ pubkey: agent, name: "Remote tester" }],
      },
    }),
  );
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const request = app.append(
    "primary",
    "alpha",
    "Summarize the release notes.",
  );
  const send = (kind, seq, payload) =>
    app.observer(
      {
        kind,
        seq,
        payload,
        channelId: "alpha",
        sessionId: "outcome",
        turnId: "outcome",
        timestamp: new Date().toISOString(),
      },
      key,
    );
  send("turn_started", 1, { triggeringEventIds: [request.id] });
  const history = page.getByRole("region", { name: "Channel message history" });
  await expect(
    history.getByRole("button", { name: /View agent activity:/ }),
  ).toBeVisible();
  await pauseClock(page);
  await page.clock.runFor(31000);
  await expect(
    history.getByRole("button", { name: /View agent activity:/ }),
  ).toHaveCount(0);
  await expect(
    history.getByText("Status unavailable", { exact: true }),
  ).toHaveCount(0);
  await expect(
    history.getByText("Couldn’t finish", { exact: true }),
  ).toHaveCount(0);
  // Freeze wall time after freshness expires: later monotonic advancement must
  // not push signed read-state events beyond the broker's allowed clock skew.
  await page.clock.setFixedTime(await page.evaluate(() => Date.now()));
  send("turn_completed", 2, { outcome: "failed" });
  let toggle = history.getByRole("button", {
    name: /^(Show|Collapse) activity history:/,
  });
  await expect(toggle).toContainText("Couldn’t finish");
  // The task failed without publishing a reply: retiring live progress must
  // leave a persistent explanation, even beyond the former preview timeout.
  await page.clock.runFor(120000);
  await expect(toggle).toContainText("Couldn’t finish");
  await expect(
    history.locator('[data-message-activity] [data-state="working"]'),
  ).toHaveCount(0);
  await page.clock.resume();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    history.getByRole("button", { name: "View activity for Remote tester" }),
  ).toBeVisible();
  await expect(history.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  await toggle.click();
  const publish = (content, tags, offset) => {
    const event = finalizeEvent(
      {
        kind: tags.some(([key]) => key === "audience") ? 40002 : 9,
        content,
        tags: [["h", "alpha"], ["e", request.id, "", "reply"], ...tags],
        created_at: Math.floor(Date.now() / 1000) + offset,
      },
      key,
    );
    app.histories.get("primary/alpha").push(event);
    app.relay.publish("primary", event);
    return event;
  };
  publish(
    "Read the release notes and checked the headings.",
    [["audience", "agents"]],
    0,
  );
  const failure = publish(
    "The selected model could not complete this request.",
    [["buzz:notice", "execution-failure"]],
    1,
  );
  app.threadSummary(request.id, [agent], 2);
  // Explicit reply links put these signed messages in the request's thread.
  const requestRow = history.locator(`[data-message-id="${request.id}"]`);
  await requestRow.hover();
  await requestRow.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  toggle = thread.getByRole("button", {
    name: /^(Show|Collapse) activity history:/,
  });
  await expect(toggle).toHaveCount(1);
  await expect(thread.locator("[data-message-activity]")).toHaveCount(0);
  await expect(toggle).toContainText("Couldn’t finish");
  const group = thread.locator("[data-contained-history]");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((width) => {
        document.documentElement.style.fontSize =
          width === 800 ? "20px" : "16px";
      }, width);
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggle).toBeFocused();
      await expect(
        group.getByText(failure.content, { exact: true }),
      ).toBeVisible();
      await expect(
        group.locator(`[data-message-id="${failure.id}"]`).first(),
      ).toBeVisible();
      await expect(
        group.getByRole("button", { name: "View transcript" }),
      ).toBeVisible();
      const collapseBox = await toggle.boundingBox();
      const outcomeBox = await group
        .getByText("Couldn’t finish", { exact: true })
        .boundingBox();
      expect(outcomeBox.y).toBeGreaterThanOrEqual(
        collapseBox.y + collapseBox.height,
      );
      const box = await group.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await settle(page);
      await toggle.click();
      await expect(
        group.getByText(failure.content, { exact: true }),
      ).toHaveCount(0);
      await expect(toggle).toBeFocused();
    }
  }
  await page.reload();
  await expect(toggle).toContainText("Couldn’t finish");
  await toggle.click();
  await expect(group.getByText(failure.content, { exact: true })).toBeVisible();
});
