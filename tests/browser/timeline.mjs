import { expect } from "@playwright/test";
import { openPage } from "./navigation.mjs";
const rowSelector = "[data-message-id]";
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });

export async function settle(page, scroller = history(page)) {
  // Wait for geometry to stop moving, rather than assuming a fixed animation delay.
  // Each read follows two rendering updates: a DOM write lands before the
  // frame whose ResizeObserver measures it, and Linux WebKit can go longer
  // than the stable window without rendering, so unpaced reads can mistake an
  // unmeasured estimate for settled geometry. Playwright's clock fakes
  // requestAnimationFrame, so a paused clock would stop rAF pacing; a new
  // ResizeObserver's first notification comes from the real rendering update.
  let previous;
  let stable = 0;
  await expect
    .poll(
      async () => {
        const value = await scroller.evaluate(async (element) => {
          const rendered = () =>
            new Promise((resolve) => {
              const observer = new ResizeObserver(() => {
                observer.disconnect();
                // Leave the delivery loop before observing again; a same-depth
                // observation added inside it is skipped and reported as a loop error.
                const channel = new MessageChannel();
                channel.port1.onmessage = () => {
                  channel.port1.close();
                  resolve();
                };
                channel.port2.postMessage(null);
              });
              observer.observe(document.documentElement);
            });
          await rendered();
          await rendered();
          return JSON.stringify([
            element.scrollTop,
            element.scrollHeight,
            element.clientHeight,
            ...Array.from(element.querySelectorAll("[data-message-id]")).map(
              (row) => [row.dataset.messageId, row.getBoundingClientRect().y],
            ),
          ]);
        });
        stable = value === previous ? stable + 1 : 0;
        previous = value;
        return stable;
      },
      { intervals: [50], message: "timeline geometry settles" },
    )
    .toBeGreaterThanOrEqual(3);
}
// Use for gestures that must move before capturing a reading baseline. Geometry
// can pause mid-gesture in Linux WebKit; only scrollend closes native input.
// `input` is the event the gesture raises on the scroller before it moves, so a
// scrollend left over from earlier movement cannot stand in for this one.
async function gesture(page, scroller, input, act) {
  const completion = await scroller.evaluateHandle((element, input) => {
    const state = { started: false, done: false };
    const started = () => {
      state.started = true;
    };
    const ended = (event) => {
      if (event.target === element && state.started) state.done = true;
    };
    element.addEventListener(input, started, { once: true, passive: true });
    element.addEventListener("scrollend", ended);
    return {
      state,
      dispose() {
        element.removeEventListener(input, started);
        element.removeEventListener("scrollend", ended);
      },
    };
  }, input);
  let pendingRead;
  try {
    await act();
    await expect
      .poll(
        () => (pendingRead = completion.evaluate(({ state }) => state.done)),
        {
          message: `timeline ${input} gesture completes`,
        },
      )
      .toBe(true);
    await settle(page, scroller);
  } finally {
    // expect.poll does not cancel a DOM read when its deadline expires.
    await pendingRead;
    await completion.evaluate((observer) => observer.dispose());
    await completion.dispose();
  }
}
export async function wheel(page, deltaY, scroller = history(page)) {
  await gesture(page, scroller, "wheel", () => page.mouse.wheel(0, deltaY));
}
// Keyboard scrolling (PageUp, PageDown, arrows, Home, End, Space) animates like
// a wheel and ends the same way. Focus must be on or inside the scroller so its
// keydown marks the gesture's start.
export async function keyScroll(page, key, scroller = history(page)) {
  await gesture(page, scroller, "keydown", () => page.keyboard.press(key));
}

// With `scrollBy`, scroll by that many px and read at the resulting scroll
// event, before rows measure: the timeline's held reader re-reads its row then.
export async function anchor(page, held, scrollBy = 0) {
  return history(page).evaluate(
    (element, [held, scrollBy]) => {
      const read = () => {
        const bounds = element.getBoundingClientRect();
        const rows = Array.from(element.querySelectorAll("[data-message-id]"));
        const inView = (row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        };
        // A held reader keeps its row while any part of it is in view, as the
        // timeline does across a drag. Otherwise prefer a whole paragraph, but
        // tall messages can leave only clipped rows. Track the first
        // intersecting row in that case, as the reader does. The same-ID/Y
        // assertion below still detects displacement after a resize.
        const row =
          rows.find((row) => row.dataset.messageId === held && inView(row)) ??
          rows.find((row) => {
            const rect = row.querySelector("p").getBoundingClientRect();
            return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
          }) ??
          rows.find(inView);
        if (!row) throw new Error("No visible message anchor");
        return {
          id: row.dataset.messageId,
          y: row.querySelector("p").getBoundingClientRect().top - bounds.top,
        };
      };
      if (!scrollBy) return read();
      const scrolled = new Promise((resolve) =>
        element.addEventListener("scroll", resolve, { once: true }),
      );
      element.scrollTop += scrollBy;
      return scrolled.then(read);
    },
    [held, scrollBy],
  );
}
export async function expectAnchor(page, expected) {
  await expect
    .poll(
      async () =>
        history(page).evaluate((element, expected) => {
          const row = element.querySelector(
            `[data-message-id="${expected.id}"]`,
          );
          return row
            ? Math.abs(
                row.querySelector("p").getBoundingClientRect().top -
                  element.getBoundingClientRect().top -
                  expected.y,
              )
            : Infinity;
        }, expected),
      { message: `same visible message ${expected.id} at same viewport Y` },
    )
    .toBeLessThan(4);
}
export async function edge(page, direction, scroller = history(page)) {
  const distance = () =>
    scroller.evaluate(
      (element, direction) =>
        direction < 0
          ? element.scrollTop
          : element.scrollHeight - element.scrollTop - element.clientHeight,
      direction,
    );
  await scroller.hover();
  // Send real gestures for the actual distance, not an arbitrary 100,000px
  // overshoot. At the boundary, retain input so production can initiate paging.
  let remaining = await distance();
  if (remaining < 4)
    await page.mouse.wheel(0, direction * Math.max(1, remaining));
  // A gesture can end short of the edge, as one did 199px from the top in
  // Linux WebKit (see upper). Each further gesture must make real progress,
  // so an immobile timeline still fails.
  for (let gesture = 0; remaining >= 4 && gesture < 4; gesture++) {
    await wheel(page, direction * remaining, scroller);
    const before = remaining;
    remaining = await distance();
    if (remaining >= 4)
      expect(remaining, "edge gesture moves toward the edge").toBeLessThan(
        before,
      );
  }
  await expect
    .poll(distance, { message: "wheel reaches timeline edge" })
    .toBeLessThan(4);
  await settle(page, scroller);
  expect(await distance(), "timeline stays at the requested edge").toBeLessThan(
    4,
  );
}
export async function end(page) {
  await edge(page, 1);
}
export async function open(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await composer(page, "Alpha").waitFor();
  await expect(history(page).locator(rowSelector).first()).toBeVisible();
  await settle(page);
}
export async function upper(page) {
  await end(page);
  const distance = () =>
    history(page).evaluate(
      (element) =>
        element.scrollHeight - element.scrollTop - element.clientHeight,
    );
  await history(page).hover();
  expect(
    await history(page).evaluate((element) => element.scrollTop),
    "history has room for an above-bottom reading position",
  ).toBeGreaterThan(400);
  // This establishes a reading position, not a wheel-delta measurement. A wheel
  // request does not guarantee exact displacement (Linux WebKit stopped short).
  // Each bounded gesture must make real progress; never assign scrollTop or
  // repeat an assertion until an immobile timeline happens to pass.
  for (let gesture = 0; gesture < 4; gesture++) {
    const before = await distance();
    if (before > 400) break;
    await wheel(page, -(650 - before));
    expect(
      await distance(),
      "reading gesture moves away from bottom",
    ).toBeGreaterThan(before);
  }
  expect(await distance(), "reading position is above bottom").toBeGreaterThan(
    400,
  );
  return anchor(page);
}
// Virtua expires an imperative scroll 150ms after its last size update and
// restores the list's pointer events 150ms after the last scroll event. Wait
// for that observable state plus settled geometry before raw pointer input
// (page.mouse.move has no hit-target retry) or a click Playwright would
// otherwise retry through alternate scroll alignments. A fake clock is not a
// substitute: it also reorders requestAnimationFrame against the rendering
// update.
export async function virtuaIdle(page, scroller = history(page)) {
  await expect(scroller.locator("ol")).toHaveCSS("pointer-events", "auto");
  await settle(page, scroller);
}
// Wait `count` rendering updates. An imperative scroll moves the DOM before
// its scroll event, which reaches Virtua in the next rendering update (the one
// after, if issued from a frame callback); until then its pointer events and
// range are still at rest.
export async function frames(page, count = 2) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const next = (left) =>
          left ? requestAnimationFrame(() => next(left - 1)) : resolve();
        next(count);
      }),
    count,
  );
}
// Hover a row's element with one raw pointer move. Locator.hover retries by
// scrolling the timeline, and each scroll restarts Virtua's pointer-event
// hold; a hover rest (Base UI's PreviewCard) starts only on a move over the
// element, so arrive once its centre hit-tests again. Geometry quiescence has
// no terminal signal: a later re-measure can still scroll between this check
// and the move, or after the move. The preview assertion must still catch it.
export async function hoverRow(page, locator, scroller = history(page)) {
  await expect(scroller.locator("ol")).toHaveCSS("pointer-events", "auto");
  await expect(locator).toBeInViewport();
  await expect
    .poll(
      () =>
        locator.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            ),
          );
        }),
      { message: "timeline hover target hit-tests at its centre" },
    )
    .toBe(true);
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}
// Click a control inside a timeline row once the timeline is at rest. Opening
// a panel resizes the timeline, and its rows rewrap and move through scroll
// events. Each scroll event restarts Virtua's pointer-event hold. On Linux
// WebKit CI, a click sent during that movement reached the scroller, and the
// control never saw it. A scroll event reaches Virtua in a later rendering
// update, so wait for those updates, and check pointer events again after the
// geometry settles. Then the control must be fully visible: locator.click()
// scrolls a control into view, and that would hide a reading position the app
// moved during the wait.
export async function clickRow(page, locator, scroller = history(page)) {
  await virtuaIdle(page, scroller);
  await frames(page);
  await virtuaIdle(page, scroller);
  await expect(scroller.locator("ol")).toHaveCSS("pointer-events", "auto");
  await expect(locator).toBeInViewport({ ratio: 1 });
  await locator.click();
}
export { activate } from "./navigation.mjs";
