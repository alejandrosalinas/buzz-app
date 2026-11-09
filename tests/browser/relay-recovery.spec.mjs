import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 1 } });

// Models a laptop that wakes before its VPN is back: the relay connection
// drops and every relay request gets a non-relay 403 page. When the network
// returns, the app must recover by itself, with no restart and no Retry click.
test("relay reads recover automatically after the network returns", async ({
  page,
  app,
}, testInfo) => {
  let offline = false;
  // This tests reads, not read-state publication. A read-state save that
  // fires after the network returns but before the live socket reattaches is
  // refused by the broker (503), so saves stay behind the edge page from the
  // outage on.
  let slept = false;
  app.report.relayFailures = [];
  await page.route("**/api/relay/**", async (route) => {
    const url = route.request().url();
    const { pathname } = new URL(url);
    const refused =
      offline || (slept && pathname.endsWith("/read-state-publish"));
    if (!refused || pathname.endsWith("/session")) return route.fallback();
    app.report.relayFailures.push(url);
    await route.fulfill({
      status: 403,
      contentType: "text/html",
      body: "<html><body>Forbidden</body></html>",
    });
  });
  // The quiet delay is 30 s; a controlled clock jumps it.
  await page.clock.install();
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();

  offline = true;
  slept = true;
  app.relay.disconnect("primary");
  // A long sleep: the reconnect replay reaches its limit, so the open
  // channel needs a read to catch up, and that read meets the outage.
  const missed = app.append("primary", "alpha", "Missed while asleep", false);
  app.relay.replayNext(
    "primary",
    "alpha",
    Array.from({ length: 500 }, () => missed),
  );
  const notice = page.getByRole("dialog", {
    name: "Buzz is having trouble connecting",
    exact: true,
  });
  // Wait for the channel's catch-up read to meet the outage. An earlier
  // failure, such as presence, can recover once the broker's own relay
  // socket returns, and jumping the clock on it would leave the notice to
  // clear while the network is still down.
  await expect
    .poll(() => app.report.relayFailures.some((url) => url.endsWith("/query")))
    .toBe(true);
  // A short outage, like waking from sleep, says nothing.
  await expect(notice).toHaveCount(0);
  await page.clock.fastForward(30_000);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Retrying automatically.");
  // It is the one report: no button, no strip above the composer and no
  // failed read repeated in the timeline or panels.
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  await expect(
    page.getByRole("status", { name: "Live updates limited" }),
  ).toHaveCount(0);
  await expect(page.getByText(/Relay request failed/)).toHaveCount(0);
  // Loaded messages and channels stay on screen.
  await expect(page.getByText("primary alpha message 0")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  // Fully on screen, after its entrance.
  await expect(notice).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("offline.png") });
  // It leaves the composer and Send usable.
  await composer.fill("Draft while offline");
  await page
    .getByRole("button", { name: "Send message", exact: true })
    .click({ trial: true });
  await composer.fill("");

  offline = false;
  // No click: the next scheduled retry, at most 30 s away, finds the network.
  await page.clock.fastForward(30_000);
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  // Every failed panel clears, including the open timeline.
  await expect(page.getByText(/Relay request failed/)).toHaveCount(0);
  await expect(page.getByText("primary alpha message 0")).toBeVisible();
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("primary beta message 0")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("recovered.png") });
});
