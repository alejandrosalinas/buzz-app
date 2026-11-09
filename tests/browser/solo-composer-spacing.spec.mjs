import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

const channelId = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  channelIds: [channelId],
  channelNames: { [channelId]: "Alpha" },
  soloChannels: [channelId],
  ownSoloChannels: [channelId],
  historyCounts: { [channelId]: 1 },
});

// Real flex geometry: an empty loading wrapper can still add a composer gap.
test("Solo choices preserve composer geometry while settled and refreshing", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  await page
    .getByRole("navigation", { name: "Solo conversations" })
    .locator(`[data-solo-channel-id="${channelId}"]`)
    .click();
  const input = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  const form = page.locator("form").filter({ has: input });
  await expect(form).toBeVisible();
  await expect(form.locator(".buzz-loading-region")).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 950 });
      await page.locator("html").evaluate((root, mode) => {
        root.dataset.colorMode = mode;
      }, mode);
      const geometry = await form.evaluate((element) => {
        const style = getComputedStyle(element);
        const toolbar = element.querySelector('[aria-label="Send message"]')
          .parentElement.parentElement;
        return {
          inset:
            element.getBoundingClientRect().bottom -
            toolbar.getBoundingClientRect().bottom,
          expected:
            parseFloat(style.paddingBottom) +
            parseFloat(style.borderBottomWidth),
        };
      });
      expect(geometry.inset).toBeCloseTo(geometry.expected, 1);
      const before = await form.boundingBox();
      // Model/effort saves notify this same subscription. Hold the resulting
      // IDB read so the pending geometry is observable on fast machines too.
      await page.evaluate(async () => {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open("buzz-solo-model-picks-v1", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const records = await new Promise((resolve, reject) => {
          const request = database
            .transaction("picks")
            .objectStore("picks")
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        database.close();
        const original = indexedDB.open;
        const held = [];
        let released = false;
        indexedDB.open = function (...args) {
          const request = original.apply(this, args);
          if (args[0] === "buzz-solo-model-picks-v1") {
            request.addEventListener(
              "success",
              (event) => {
                if (released) return;
                event.stopImmediatePropagation();
                held.push(request);
              },
              { once: true },
            );
          }
          return request;
        };
        window.releaseChoiceRead = () => {
          released = true;
          indexedDB.open = original;
          for (const request of held)
            request.dispatchEvent(new Event("success"));
        };
        const channel = new BroadcastChannel(
          `buzz-solo-model-picks-v1:${records[0].scope}`,
        );
        channel.postMessage(null);
        channel.close();
      });
      try {
        await expect(
          form.locator('.buzz-loading-region[aria-busy="true"]'),
        ).toHaveCount(1);
        const pending = await form.boundingBox();
        expect(pending.y).toBeCloseTo(before.y, 1);
        expect(pending.height).toBeCloseTo(before.height, 1);
      } finally {
        await page.evaluate(() => window.releaseChoiceRead());
      }
      await expect(form.locator(".buzz-loading-region")).toHaveCount(0);
      await form.screenshot({
        path: test.info().outputPath(`solo-composer-${mode}-${width}.png`),
      });
    }
  }
});
