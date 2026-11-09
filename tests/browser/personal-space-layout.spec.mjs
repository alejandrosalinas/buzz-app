import { test, expect } from "./fixture.mjs";
import { openPage, selectCommunity } from "./navigation.mjs";

// Browser-only: reflow, the panel frame's clip and wheel scrolling need real
// CSS layout. AppShell.test.tsx covers the action's presence and its switcher.
test("Personal space's Choose a community fits its pane and wheel-scrolls into view with enlarged text", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await selectCommunity(page, "Personal space");
  const pane = page.getByRole("region", { name: "Channels", exact: true });
  const heading = pane.getByRole("heading", {
    name: "Your channels, one conversation.",
    exact: true,
  });
  const choose = pane.getByRole("button", {
    name: "Choose a community",
    exact: true,
  });
  await expect(choose).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--buzz-text-scale", "2");
  });
  // Wait for the enlarged layout: the action starts below the pane, so only
  // scrolling can reveal it, and nothing overflows the pane sideways.
  await expect(async () => {
    const [bounds, title, action, sideways] = await Promise.all([
      pane.boundingBox(),
      heading.boundingBox(),
      choose.boundingBox(),
      heading.evaluate(
        ({ parentElement }) =>
          parentElement.scrollWidth - parentElement.clientWidth,
      ),
    ]);
    expect(title.y).toBeGreaterThanOrEqual(bounds.y);
    expect(action.x).toBeGreaterThanOrEqual(bounds.x);
    expect(action.x + action.width).toBeLessThanOrEqual(
      bounds.x + bounds.width,
    );
    expect(action.y).toBeGreaterThan(bounds.y + bounds.height);
    expect(sideways).toBe(0);
  }).toPass();
  await pane.hover();
  await page.mouse.wheel(0, 2000);
  await expect(choose).toBeInViewport({ ratio: 1 });
  const action = await choose.boundingBox();
  await page.mouse.click(
    action.x + action.width / 2,
    action.y + action.height / 2,
  );
  await expect(
    page.getByRole("dialog", { name: "Switch community", exact: true }),
  ).toBeVisible();
});
