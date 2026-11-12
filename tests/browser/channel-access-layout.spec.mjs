import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { animationsSettled } from "./animations.mjs";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  lifecycleRole: "owner",
  sessionMembers: {
    "11111111-1111-4111-8111-111111111111": ["a".repeat(64)],
  },
  historyCounts: { alpha: 1, beta: 1 },
});

// Browser-only: nested scrolling, text reflow and clipping need the real dialog
// and CSS layout engine. Role/recovery matrices stay in component/session tests.
test("general access starts the member list and footer actions stay reachable with enlarged text", async ({
  page,
  app,
}, testInfo) => {
  // Read a signed View only policy without publishing a metadata change.
  await page.route("**/query", async (route) => {
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      response,
      json: events.map((event) =>
        event.kind === 39000 &&
        event.tags.some(
          ([key, id]) =>
            key === "d" && id === "11111111-1111-4111-8111-111111111111",
        )
          ? app.signRelay({
              kind: event.kind,
              created_at: event.created_at,
              content: event.content,
              tags: [
                ...event.tags.filter(([key]) => key !== "join_role"),
                ["join_role", "guest"],
              ],
            })
          : event,
      ),
    });
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Lifecycle channel", exact: true })
    .click();
  await page
    .getByRole("button", { name: /^Manage members of /, exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  const general = dialog.getByRole("region", {
    name: "General access",
    exact: true,
  });
  const list = dialog.getByRole("region", { name: "Member list", exact: true });
  const audience = general.getByRole("combobox", { name: "General access" });
  await expect(audience).toBeEnabled();
  expect(
    await list.evaluate((node) =>
      node.firstElementChild?.getAttribute("aria-label"),
    ),
  ).toBe("General access");
  await expect(audience).toHaveText("View only");
  await expect(audience).toHaveAttribute("data-size", "sm");
  await expect(audience.locator(".buzz-select-leading")).toHaveCount(0);
  expect(await audience.evaluate((node) => !!node.closest("header"))).toBe(
    false,
  );
  await animationsSettled(dialog);
  for (const [width, height, scale, theme] of [
    [1440, 950, 1, "light"],
    [1440, 950, 1, "dark"],
    [1440, 950, 2, "dark"],
    [700, 900, 2, "light"],
    [390, 900, 2, "dark"],
    [390, 720, 1, "dark"],
    [390, 720, 1.5, "light"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      ({ scale, theme }) => {
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        );
        document.documentElement.setAttribute("data-color-mode", theme);
      },
      { scale, theme },
    );
    if (width < 480) {
      // The fixed chrome and enlarged controls cannot all fit at this width.
      // Preserve the bounded whole-body fallback and prove keyboard reachability.
      await dialog.getByRole("searchbox").focus();
      await page.keyboard.press("Tab");
      await expect(audience).toBeFocused();
      await expect(audience).toBeInViewport({ ratio: 1 });
    } else {
      await expect
        .poll(() =>
          list.evaluate((node) => {
            const layout = node.parentElement;
            const dialog = layout.closest('[role="dialog"]');
            const general = dialog.querySelector(
              '[aria-label="General access"]',
            );
            const control = general.querySelector('[role="combobox"]');
            const header = dialog.querySelector("header");
            const row = general.parentElement;
            return {
              verticalOverflow: layout.scrollHeight > layout.clientHeight + 1,
              horizontalOverflow:
                layout.scrollWidth > layout.clientWidth + 1 ||
                control.scrollWidth > control.clientWidth + 1,
              headerOverflow: header.scrollWidth > header.clientWidth + 1,
              accessOutsideRow:
                general.getBoundingClientRect().bottom >
                row.getBoundingClientRect().bottom + 1,
            };
          }),
        )
        .toEqual({
          verticalOverflow: false,
          horizontalOverflow: false,
          headerOverflow: false,
          accessOutsideRow: false,
        });
      const before = await general.boundingBox();
      await list.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const offset = await list.evaluate((node) => node.scrollTop);
      expect((await general.boundingBox()).y).toBeCloseTo(before.y - offset, 0);
      await list.evaluate((node) => {
        node.scrollTop = 0;
      });
    }
    await expect
      .poll(() =>
        dialog.locator("footer").evaluate((footer) => ({
          horizontal: footer.scrollWidth > footer.clientWidth + 1,
          vertical: footer.scrollHeight > footer.clientHeight + 1,
        })),
      )
      .toEqual({ horizontal: false, vertical: false });
    await expect
      .poll(() =>
        dialog
          .locator("header")
          .evaluate((header) => header.scrollWidth <= header.clientWidth + 1),
      )
      .toBe(true);
    const done = dialog.getByRole("button", { name: "Done", exact: true });
    const copy = dialog.getByRole("button", { name: "Copy link", exact: true });
    for (const action of [audience, copy, done]) {
      await action.focus();
      await expect(action).toBeFocused();
      expect(
        await dialog.locator("footer").evaluate((footer) => {
          footer.scrollTop = 100;
          footer.scrollLeft = 100;
          return [footer.scrollTop, footer.scrollLeft];
        }),
      ).toEqual([0, 0]);
    }
    const accessBox = await audience.boundingBox();
    const doneBox = await done.boundingBox();
    const searchBox = await dialog
      .getByRole("searchbox")
      .evaluate((node) =>
        node.closest(".buzz-input-group").getBoundingClientRect().toJSON(),
      );
    await expect(
      general.locator('[role="status"][aria-atomic="true"]'),
    ).toHaveCSS("margin-block-start", "-1px");
    await expect(
      dialog.getByRole("button", { name: "Refresh member data" }),
    ).toHaveCount(0);
    expect(await audience.evaluate((node) => !!node.closest("footer"))).toBe(
      false,
    );
    expect(await copy.evaluate((node) => !!node.closest("footer"))).toBe(true);
    expect(accessBox.y).toBeGreaterThanOrEqual(searchBox.y + searchBox.height);
    expect(
      await audience.evaluate(
        (node) => !!node.closest('[aria-label="Member list"]'),
      ),
    ).toBe(true);
    if (width >= 700 && scale === 1) {
      const copyBox = await copy.boundingBox();
      expect(copyBox.y).toBeCloseTo(doneBox.y, 0);
      expect(copyBox.x + copyBox.width).toBeLessThan(doneBox.x);
      expect(doneBox.y).toBeGreaterThan(searchBox.y);
    }
    const insets = await audience.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.paddingInlineStart, style.paddingInlineEnd];
    });
    expect(parseFloat(insets[0])).toBe(16 * scale);
    expect(parseFloat(insets[1])).toBe(16 * scale);
    await audience.click();
    const options = page.getByRole("listbox");
    await expect(options).toBeVisible();
    if (width >= 700 && scale === 1) {
      await expect
        .poll(async () => {
          const popup = await page.locator(".buzz-select-popup").boundingBox();
          const trigger = await audience.boundingBox();
          return Math.abs(popup.x + popup.width - trigger.x - trigger.width);
        })
        .toBeLessThan(1);
    }
    await expect(options.getByRole("option")).toHaveText([
      /Public/,
      /View only/,
      /Private/,
    ]);
    await expect(options.locator(".buzz-select-separator")).toBeVisible();
    for (const name of ["Public", "View only", "Private"]) {
      const option = options.getByRole("option", { name, exact: true });
      await option.scrollIntoViewIfNeeded();
      await expect(option).toBeInViewport({ ratio: 1 });
    }
    await page.keyboard.press("Escape");
    await expect(audience).toBeFocused();
    await dialog.screenshot({
      path: testInfo.outputPath(
        `access-${width}-${height}-${scale}-${theme}.png`,
      ),
    });
  }
  await audience.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(audience).toBeFocused();
  await audience.click();
  await page.getByRole("option", { name: "Private", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(audience).toBeFocused();
  const memberActions = dialog.getByRole("button", { name: /^Actions for / });
  await expect(memberActions).toHaveCount(2);
  await memberActions.nth(1).click();
  await page
    .getByRole("menuitemradio", { name: "Viewing only", exact: true })
    .click();
  const roleConfirmation = page.getByRole("dialog", {
    name: "Change access to Viewing only?",
    exact: true,
  });
  await expect(roleConfirmation).toContainText(
    "Change access from Participating to Viewing only.",
  );
  await expect(
    roleConfirmation.getByRole("button", {
      name: "Set to viewing only",
      exact: true,
    }),
  ).toBeVisible();
  await roleConfirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(app.report.lifecyclePublications ?? []).toEqual([]);
  expect(app.report.unexpected).toEqual([]);
});

// A real rejected/unbound receipt drives the editor's own recovery state. Only
// the browser can prove its feedback does not displace the adjacent controls.
for (const outcome of ["rejected", "uncertain"]) {
  test(`access ${outcome} feedback stays full-width below the policy row`, async ({
    page,
    app,
  }, testInfo) => {
    let publications = 0;
    await page.route(
      "**/api/relay/**/channel-details-publish",
      async (route) => {
        const event = route.request().postDataJSON();
        publications++;
        // Do not forward this disposable write to the fixture relay.
        await route.fulfill({
          json:
            outcome === "rejected"
              ? {
                  accepted: false,
                  event_id: event.id,
                  message:
                    "Access update was rejected. Reload the latest channel access before trying again.",
                }
              : { accepted: true, event_id: "unbound-receipt" },
        });
      },
    );
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page
      .getByRole("navigation", { name: "Subscribed channels" })
      .getByRole("button", { name: "Lifecycle channel", exact: true })
      .click();
    const manage = page.getByRole("button", {
      name: /^Manage members of /,
      exact: true,
    });
    await manage.click();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const general = dialog.getByRole("region", {
      name: "General access",
      exact: true,
    });
    const access = general.getByRole("combobox", { name: "General access" });
    await expect(access).toBeEnabled();
    await access.click();
    await page.getByRole("option", { name: "Private", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Change access", exact: true })
      .click();
    const feedbackGroup = dialog.getByRole("group", {
      name: "General access recovery",
      exact: true,
    });
    const recovery = feedbackGroup.getByRole("button", {
      name: outcome === "rejected" ? "Reload access" : "Check save status",
      exact: true,
    });
    await expect(recovery).toBeEnabled();
    await expect(feedbackGroup.getByRole("alert")).toBeVisible();
    if (outcome === "uncertain") {
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await manage.click();
      await expect(recovery).toBeEnabled();
      await expect(
        feedbackGroup.getByText(/Checking never resends it/),
      ).toBeVisible();
    }
    for (const [width, height, scale, theme] of [
      [1440, 950, 1, "light"],
      [1440, 950, 1, "dark"],
      [390, 900, 1.5, "dark"],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(
        ({ scale, theme }) => {
          document.documentElement.style.setProperty(
            "--buzz-text-scale",
            String(scale),
          );
          document.documentElement.dataset.colorMode = theme;
        },
        { scale, theme },
      );
      const search = await dialog
        .getByRole("searchbox")
        .evaluate((node) =>
          node.closest(".buzz-input-group").getBoundingClientRect().toJSON(),
        );
      const choice = await access.boundingBox();
      if (width > 480) {
        expect(choice.y).toBeGreaterThanOrEqual(search.bottom);
      }
      const feedback =
        outcome === "rejected"
          ? feedbackGroup.getByRole("alert")
          : feedbackGroup.getByText(/Checking never resends it/);
      const alert = await feedback.boundingBox();
      const action = await recovery.boundingBox();
      expect(alert.y).toBeGreaterThanOrEqual(
        Math.max(search.bottom, choice.y + choice.height),
      );
      expect(action.y).toBeGreaterThanOrEqual(alert.y + alert.height);
      const bounds = await general.boundingBox();
      const inset = await feedbackGroup.evaluate((node) =>
        parseFloat(getComputedStyle(node).paddingInlineStart),
      );
      expect(alert.x).toBeCloseTo(bounds.x + inset, 0);
      expect(alert.width).toBeCloseTo(bounds.width - 2 * inset, 0);
      await recovery.focus();
      await expect(recovery).toBeInViewport({ ratio: 1 });
      expect(
        await dialog
          .locator("footer")
          .evaluate((node) => [
            node.scrollWidth - node.clientWidth,
            node.scrollHeight - node.clientHeight,
          ]),
      ).toEqual([0, 0]);
      await dialog.screenshot({
        path: testInfo.outputPath(`access-${outcome}-${theme}-${scale}.png`),
      });
    }
    expect(publications).toBe(1);
    expect(app.report.lifecyclePublications ?? []).toEqual([]);
    expect(app.report.unexpected).toEqual([]);
  });
}
