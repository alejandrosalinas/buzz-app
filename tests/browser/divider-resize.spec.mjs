import { test, expect } from "./fixture.mjs";
import { open, settle, wheel } from "./timeline.mjs";
import { markAllRead } from "./reading.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 64, beta: 1 },
  tallMessages: true,
});

// Browser-only: live CSS widths must reflow real message rows while durable
// sidebar intent stays unchanged until release. Timings are diagnostic, not gates.
for (const name of ["Resize sidebar", "Resize main and secondary panels"]) {
  test(`${name} previews live wrapping and commits on release`, async ({
    page,
    app,
  }, testInfo) => {
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    for (let i = 0; i < 30; i++) app.reply(root.id, false, false);
    await open(page, app);
    await markAllRead(page);
    const channel = page.getByRole("region", {
      name: "Channel message history",
    });
    const rootRow = channel.locator(`[data-message-id="${root.id}"]`);
    await rootRow.hover();
    await rootRow.getByRole("button", { name: /^View thread:/ }).click();
    const thread = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    await expect(thread).toBeVisible();
    await settle(page, channel);
    await settle(page, thread);
    const handle = page.getByRole("separator", { name, exact: true });
    await expect(handle).toBeVisible();
    const results = await handle.evaluate(async (handle) => {
      const sidebar = handle.getAttribute("aria-label") === "Resize sidebar";
      const panel = sidebar
        ? handle.previousElementSibling
        : handle.parentElement;
      const initial = panel.getBoundingClientRect().width;
      const grip = handle.getBoundingClientRect();
      const x = grip.x + grip.width / 2;
      const direction = sidebar ? 1 : -1;
      const saved = Storage.prototype.setItem;
      let writes = 0;
      Storage.prototype.setItem = function (key, value) {
        if (key.includes("channel-sidebar")) writes++;
        return saved.call(this, key, value);
      };
      const pointer = (type, delta) =>
        (type === "pointerdown" ? handle : window).dispatchEvent(
          new PointerEvent(type, {
            pointerId: 97,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: x + direction * delta,
            clientY: grip.y + grip.height / 2,
            bubbles: true,
            cancelable: true,
          }),
        );
      const frame = () =>
        new Promise((resolve) => requestAnimationFrame(resolve));
      const intervals = [],
        dispatch = [],
        widths = [];
      let previous = await frame();
      try {
        pointer("pointerdown", 0);
        for (let i = 0; i < 90; i++) {
          const start = performance.now();
          for (let j = 1; j <= 8; j++)
            pointer("pointermove", 40 + 40 * Math.sin((i + j / 8) / 12));
          dispatch.push(performance.now() - start);
          const time = await frame();
          intervals.push(time - previous);
          previous = time;
          widths.push(panel.getBoundingClientRect().width);
        }
        const during = writes;
        pointer("pointerup", 60);
        await frame();
        await frame();
        const percentile = (values, p) =>
          [...values].sort((a, b) => a - b)[
            Math.floor((values.length - 1) * p)
          ];
        return {
          initial,
          final: panel.getBoundingClientRect().width,
          liveRange: Math.max(...widths) - Math.min(...widths),
          writesDuring: during,
          writesAfter: writes,
          frameP95: percentile(intervals, 0.95),
          frameMax: Math.max(...intervals),
          dispatchP95: percentile(dispatch, 0.95),
        };
      } finally {
        pointer("pointercancel", 0);
        Storage.prototype.setItem = saved;
      }
    });
    await testInfo.attach("divider-drag-metrics", {
      body: JSON.stringify(results, null, 2),
      contentType: "application/json",
    });
    console.log(name, results);
    expect(results.liveRange).toBeGreaterThan(50);
    expect(results.final).toBeCloseTo(results.initial + 60, 0);
    expect(results.writesDuring).toBe(0);
    expect(results.writesAfter).toBe(name === "Resize sidebar" ? 1 : 0);
    await settle(page, thread);
    expect(
      await thread.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    ).toBeLessThan(4);
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-sidebar-resizing",
    );
    await thread.hover({ position: { x: 48, y: 80 } });
    await wheel(page, -350, thread);
    await settle(page, thread);
    const anchor = await thread.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll("[data-message-id]")].find(
        (row) => row.getBoundingClientRect().bottom > top,
      );
      return {
        id: row.dataset.messageId,
        y: row.getBoundingClientRect().top - top,
      };
    });
    await handle.evaluate(async (el) => {
      const grip = el.getBoundingClientRect();
      const init = {
        pointerId: 98,
        button: 0,
        bubbles: true,
        clientX: grip.x + grip.width / 2,
      };
      el.dispatchEvent(new PointerEvent("pointerdown", init));
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          ...init,
          clientX: init.clientX + 32,
        }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      // Cancel also exercises restoring live geometry while reading above the bottom.
      window.dispatchEvent(new PointerEvent("pointercancel", init));
    });
    await settle(page, thread);
    expect(
      await thread.evaluate((el, anchor) => {
        const row = el.querySelector(`[data-message-id="${anchor.id}"]`);
        return Math.abs(
          row.getBoundingClientRect().top -
            el.getBoundingClientRect().top -
            anchor.y,
        );
      }, anchor),
    ).toBeLessThan(4);
    if (name === "Resize sidebar") {
      await page.reload();
      await expect(
        page.getByRole("separator", { name, exact: true }),
      ).toHaveAttribute("aria-valuenow", String(Math.round(results.final)));
    }
  });
}

// Real mouse input and viewport reflow prove a click preserves automatic sizing.
test("clicking the thread divider preserves automatic sizing", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, app);
  const channel = page.getByRole("region", { name: "Channel message history" });
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const row = channel.locator(`[data-message-id="${root.id}"]`);
  await row.hover();
  await row.getByRole("button", { name: /^View thread:/ }).click();
  const handle = page.getByRole("separator", {
    name: "Resize main and secondary panels",
    exact: true,
  });
  await expect(handle).toBeVisible();
  const width = () =>
    handle.evaluate((el) => el.parentElement.getBoundingClientRect().width);
  const initial = await width();
  await page.setViewportSize({ width: 1380, height: 800 });
  await expect.poll(width).toBeGreaterThan(initial + 30);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(width).toBeLessThan(initial + 2);
  const box = await handle.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.setViewportSize({ width: 1380, height: 800 });
  await expect.poll(width).toBeGreaterThan(initial + 30);
});
