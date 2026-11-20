import { test, expect } from "./fixture.mjs";
import { open, upper } from "./timeline.mjs";

// The vendored Virtua patch flips the feed to `overflow-y: hidden !important`
// on every nonzero size correction on Mac WebKit. With classic scrollbars that
// removes the scrollbar for a frame, widens the content box, re-wraps rows
// above the viewport, and their new heights feed the next correction. The feed
// must keep the same inline size in both overflow states.
//
// Chromium never runs interruptMomentum (its MacIntel/Apple vendor predicate is
// false there), so this spec does not exercise the loop. It proves the CSS
// invariant the fix depends on by replaying the patch's exact inline toggle and
// restore. That proof needs a scrollbar that takes space, so the width case is
// tagged @classic-scrollbars and runs only in the chromium-classic-scrollbars
// project, which launches Chromium without its default --hide-scrollbars.
// Linux Chromium always draws classic scrollbars, so there the case requires a
// nonzero scrollbar width and CI runs it on the measurements runner. Chromium
// on macOS follows the system "Show scroll bars" setting, so the case is opt-in
// there: set BUZZ_CLASSIC_SCROLLBARS=1 on a Mac that resolves to classic
// scrollbars, otherwise it skips and says why. The chromium and webkit projects
// exclude the tag and run only the toHaveCSS guard (Playwright's WebKit uses
// overlay scrollbars on macOS). The native manual check on a legacy-scrollbar
// Mac remains the definitive one for the loop itself.
test.use({ historyCounts: { alpha: 640, beta: 20 } });
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

test("feed reserves a stable scrollbar gutter", async ({ page, app }) => {
  await open(page, app);
  await expect(history(page)).toHaveCSS("scrollbar-gutter", "stable");
});

test("feed width survives the Virtua overflow toggle", {
  tag: "@classic-scrollbars",
}, async ({ page, app }) => {
  test.skip(
    process.platform !== "linux" && !process.env.BUZZ_CLASSIC_SCROLLBARS,
    "Only Linux guarantees classic scrollbars; set BUZZ_CLASSIC_SCROLLBARS=1 on a Mac whose scrollbars take space",
  );
  await open(page, app);
  // 640 rows already overflow at the bottom, so check the premise before
  // paying for the wheel-gesture detach.
  const space = await history(page).evaluate(
    (element) => element.offsetWidth - element.clientWidth,
  );
  app.report.measurements.push({ scenario: "scrollbar-space", space });
  expect(
    space,
    "the feed scrollbar must take space: this project launches Chromium without --hide-scrollbars and expects classic, not overlay, scrollbars",
  ).toBeGreaterThan(0);
  await upper(page);
  const readings = await history(page).evaluate((element) => {
    // Pick the measured paragraph once so all three reads compare the same
    // node even if a state re-wraps enough to change which paragraph fits.
    const bounds = element.getBoundingClientRect();
    const paragraph = Array.from(
      element.querySelectorAll("[data-message-id] p"),
    ).find((p) => {
      const rect = p.getBoundingClientRect();
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    });
    if (!paragraph) throw new Error("No fully visible message paragraph");
    const read = () => ({
      clientWidth: element.clientWidth,
      paragraphWidth: paragraph.getBoundingClientRect().width,
    });
    const before = read();
    // Mirror patches/virtua@0.54.2.patch interruptMomentum() and its restore.
    const style = element.style;
    const property = "overflow-y";
    const value = style.getPropertyValue(property);
    const priority = style.getPropertyPriority(property);
    style.setProperty(property, "hidden", "important");
    const hidden = read(); // clientWidth forces layout in the hidden state.
    if (value) style.setProperty(property, value, priority);
    else style.removeProperty(property);
    const restored = read();
    return { before, hidden, restored };
  });
  expect(readings.hidden, "hidden overflow keeps the feed width").toEqual(
    readings.before,
  );
  expect(readings.restored, "restored overflow keeps the feed width").toEqual(
    readings.before,
  );
});
