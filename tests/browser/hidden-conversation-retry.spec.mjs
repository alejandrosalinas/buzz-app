import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  pluginFixtures: true,
  historyCounts: { alpha: 1, beta: 1 },
});

// App/session/broker wiring must expose exhausted visibility reads on the
// sidebar and let the existing action recover. Timing/error matrices stay in
// service and mounted component tests.
test("hidden-conversation exhaustion exposes the existing action and manual retry recovers", async ({
  page,
  app,
}) => {
  let failing = true;
  let reads = 0;
  await page.goto(app.origin);
  await openPage(page, "Messages");
  // Startup can supersede visibility reads as roster evidence arrives. Count
  // one explicit visibility refresh after the live roster and visibility settle.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = window.fixtureRelay.snapshot().session;
        return [
          session.live.snapshot().status,
          session.channels.list().status,
          session.channelLifecycle.snapshot().status,
        ];
      }),
    )
    .toEqual(["connected", "ready", "ready"]);
  await page.route("**/api/relay/primary/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter.kinds?.includes(30622))
    )
      return route.continue();
    reads++;
    if (!failing) return route.continue();
    app.report.startupFailures ??= [];
    app.report.startupFailures.push(route.request().url());
    return route.fulfill({
      status: 502,
      json: { error: "Fixture visibility unavailable" },
    });
  });
  await page.evaluate(() =>
    window.fixtureRelay.snapshot().session.channelLifecycle.refreshVisibility(),
  );
  const retry = page.getByRole("button", {
    name: "Retry hidden conversations",
    exact: true,
  });
  await expect(retry).toBeVisible();
  expect(reads).toBe(4);
  await expect(
    page.getByRole("alert").filter({
      hasText: "Hidden conversations could not be refreshed.",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.fixtureRelay.snapshot().session.recovery.snapshot().recovering,
    ),
  ).toBe(false);
  failing = false;
  await retry.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.fixtureRelay.snapshot().session.channelLifecycle.snapshot()
            .status,
      ),
    )
    .toBe("ready");
  await expect(retry).toHaveCount(0);
  expect(reads).toBe(5);
});
