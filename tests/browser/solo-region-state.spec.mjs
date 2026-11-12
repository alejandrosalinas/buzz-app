import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

test.use({ pluginFixtures: true, historyCounts: { alpha: 0, beta: 0 } });

// Real storage events between windows and app startup are outside jsdom's boundary.
test("region state reaches the component after a headless write and a write in another window", async ({
  page,
  app,
  context,
}) => {
  const url = `${app.origin}/?solo-region-fixture&region-state-fixture`;
  await page.goto(url);
  await newChat(page);
  await page.evaluate(() => {
    const fixture = window.fixtureSoloRegion;
    if (!fixture.state().set({ filter: "running" }))
      throw new Error("Write failed");
    fixture.status("ready");
  });
  const output = page.getByLabel("Region state");
  await expect(output).toHaveText('{"filter":"running"}');
  const other = await context.newPage();
  await other.goto(url);
  await newChat(other);
  await other.evaluate(() => {
    const fixture = window.fixtureSoloRegion;
    if (!fixture.state().set({ filter: "needs-you" }))
      throw new Error("Write failed");
  });
  await expect(output).toHaveText('{"filter":"needs-you"}');
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => {
        try {
          return window.fixtureSoloRegion?.state().get();
        } catch {
          return undefined;
        }
      }),
    )
    .toEqual({ filter: "needs-you" });
  await page.evaluate(() => window.fixtureSoloRegion.status("ready"));
  await expect(output).toHaveText('{"filter":"needs-you"}');
});
