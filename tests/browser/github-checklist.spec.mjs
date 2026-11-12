import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
// Real browser layout: the public checklist row with linked failing checks
// wraps inside a narrow pane. gh-backed rows and actions stay in Vitest.
test("a PR opens on its checklist, with failing checks linked and wrapping in a narrow pane", async ({
  page,
  app,
}, testInfo) => {
  const target = "https://github.com/sample/project/pull/1";
  const requests = [];
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      return route.fulfill({
        json: path.endsWith("/check-runs")
          ? {
              total_count: 2,
              check_runs: [
                {
                  name: `Browser journeys / ${"long-check-name-".repeat(6)}`,
                  status: "completed",
                  conclusion: "failure",
                  details_url:
                    "https://github.com/sample/project/actions/runs/1",
                },
                {
                  name: "Unit tests",
                  status: "completed",
                  conclusion: "success",
                },
              ],
            }
          : path.endsWith("/status")
            ? { total_count: 0, statuses: [] }
            : {
                title: "First PR",
                state: "open",
                body: "Main description\n\n## Details",
                body_html: "<p>Main description</p><h2>Details</h2>",
                head: { sha: "head-sha" },
              },
      });
    },
  );
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  app.append("primary", "alpha", target);
  const link = page.locator(`[data-message-id] a[href="${target}"]`);
  // The inline link reads its state once before the panel opens.
  await expect(link).toHaveAccessibleDescription("Pull request, open");
  await end(page);
  await link.click();
  // Opening the panel reflows the timeline under the resting pointer, and the
  // viewer's avatar crosses it before the panel covers that point. A slow
  // runner can hold it there past the hover delay, and the opened profile
  // preview then covers the checklist. The next step moves the pointer anyway.
  await page.mouse.move(0, 0);
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const checklist = panel.getByRole("list", {
    name: "Pull request checklist",
  });
  const checks = checklist
    .getByRole("listitem")
    .filter({ has: page.getByText("Checks", { exact: true }) });
  await expect(checks).toHaveText(/1 failed · 1 passed/);
  await expect(
    checks.getByRole("link", { name: /^Browser journeys/ }),
  ).toHaveCount(0);
  await checks.getByRole("button", { name: "1 failed · 1 passed" }).click();
  await expect(checks).toHaveAttribute("data-tone", "failure");
  await expect(
    checks.getByRole("link", { name: /^Browser journeys/ }),
  ).toHaveAttribute("href", "https://github.com/sample/project/actions/runs/1");
  await expect
    .poll(() =>
      checklist.evaluate((node) => node.scrollWidth <= node.clientWidth),
    )
    .toBe(true);
  // The description is readable alongside the checklist without expanding it.
  await expect(panel.getByRole("heading", { name: "Details" })).toBeVisible();
  // The pull request is read for the inline link's state and for the panel.
  expect([...requests].sort()).toEqual([
    "/repos/sample/project/commits/head-sha/check-runs",
    "/repos/sample/project/commits/head-sha/status",
    "/repos/sample/project/pulls/1",
    "/repos/sample/project/pulls/1",
  ]);
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await panel.screenshot({
      path: testInfo.outputPath(`github-checklist-${mode}.png`),
    });
  }
});
