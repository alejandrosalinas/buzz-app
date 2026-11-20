import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import { anchor, expectAnchor, settle, wheel, edge } from "./timeline.mjs";

// Real layout/virtualizer measurements are needed: history is inserted after
// a retained opening row, and the identified reader must keep its viewport Y.
let server;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});

async function open(page) {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/history-prefix.html`,
  );
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  await settle(page);
}
async function prepend(page, start) {
  await page.evaluate(() => window.prependHistory());
  await expect(page.locator("[data-history-start]")).toHaveAttribute(
    "data-history-start",
    String(start),
  );
  await settle(page);
}

test("older pages behind a retained first row preserve reading and are not new arrivals", async ({
  page,
}) => {
  await open(page);
  await page.locator("[data-message-scroller]").hover();
  // Linux WebKit animates a wheel scroll, and a row measurement's scroll
  // correction can stop it short. Read beyond the timeline's follow threshold.
  const fromEnd = () =>
    page
      .locator("[data-message-scroller]")
      .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  for (let i = 0; i < 4 && (await fromEnd()) < 200; i++)
    await wheel(page, -300);
  expect(await fromEnd()).toBeGreaterThanOrEqual(200);
  const reading = await anchor(page);
  for (const start of [61, 41, 21]) {
    await prepend(page, start);
    await expectAnchor(page, reading);
    await expect(
      page.getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeVisible();
  }
  // A reader on the unchanged prefix must not be shifted past newly added rows.
  await edge(page, -1);
  const opening = await anchor(page);
  await prepend(page, 1);
  await expectAnchor(page, opening);
});

test("older pages behind a retained first row preserve bottom following", async ({
  page,
}) => {
  await open(page);
  const reading = await anchor(page);
  await prepend(page, 61);
  await expectAnchor(page, reading);
  await expect
    .poll(() =>
      page
        .locator("[data-message-scroller]")
        .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(2);
});
