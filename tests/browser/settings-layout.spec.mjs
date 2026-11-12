import {
  chooseColorMode,
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { npubEncode } from "nostr-tools/nip19";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

// Column sizing and control containment depend on browser layout/font metrics.
// Service persistence, errors, and draft transitions stay in the component tests.
test("settings share a centered, bounded column and keep controls contained across themes and widths", async ({
  page,
  app,
}, info) => {
  await page.goto(app.origin);
  await openSettings(page);
  // A desktop Settings surface stays bounded instead of filling the workspace.
  await expect
    .poll(() =>
      settingsDialog(page).evaluate((root) => {
        const { width, height } = root.getBoundingClientRect();
        return { width, height };
      }),
    )
    .toEqual({ width: 1152, height: 768 });
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
  await selectSettingsSection(page, "Identity");
  // Copy failure must leave the entire value selectable as ordinary text.
  const identity = page.getByRole("region", {
    name: "Identity",
    exact: true,
  });
  const copyId = identity.getByRole("button", {
    name: "Copy Buzz ID",
    exact: true,
  });
  await expect(copyId).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard unavailable");
        },
      },
    });
  });
  await copyId.click();
  await expect(page.getByText(/Select it and copy manually/)).toBeVisible();
  // The card abbreviates the ID; clipboard failure exposes the full value below it.
  const publicKey = identity.getByText(/^Full Buzz ID:/).locator("code");
  const key = npubEncode(app.viewer);
  await expect(publicKey).toHaveText(key);
  await publicKey.click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe(key);
  await copyId.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    identity.getByRole("button", { name: "More options", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("dialog", { name: "Identity wasn’t copied" })
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Identity wasn’t copied" }),
  ).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, mode === "light" ? "Light" : "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of [
        "Profile",
        "Local settings",
        "Identity",
        "Appearance",
        "Notifications",
        "Shortcuts",
        "Agent setup",
        "Decisions API",
        "Manage plugins",
        "Software updates",
      ]) {
        await selectSettingsSection(page, name);
        const section = page.getByRole("region", {
          name,
          exact: true,
        });
        if (name === "Profile") {
          await expect(
            section.getByRole("textbox", { name: "Display name", exact: true }),
          ).toBeEnabled();
        }
        if (name === "Notifications") {
          await expect(
            section.getByRole("combobox", { name: "Direct messages" }),
          ).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(
            () =>
              section.evaluate((root) => {
                const bounds = root.getBoundingClientRect();
                const rem = parseFloat(
                  getComputedStyle(document.documentElement).fontSize,
                );
                const failures = [];
                // The Settings modal's detail scrollport owns the page inset.
                const detailStyle = getComputedStyle(
                  root.closest(".buzz-dialog-navigation-detail"),
                );
                const inset = getComputedStyle(
                  root.closest(".buzz-dialog"),
                ).getPropertyValue("--dialog-padding");
                if (
                  !inset.endsWith("rem") ||
                  parseFloat(detailStyle.paddingTop) !== parseFloat(inset) * rem
                )
                  failures.push("settings page lost its top inset");
                if (bounds.width > 48 * rem)
                  failures.push("content exceeds 48rem");
                if (document.documentElement.scrollWidth > window.innerWidth)
                  failures.push("document overflows");
                for (const control of root.querySelectorAll(
                  'button, code, input:not([type="checkbox"]), textarea, [role="combobox"]',
                )) {
                  if (
                    !control.checkVisibility() ||
                    control.getAttribute("aria-hidden") === "true"
                  )
                    continue;
                  const box = control.getBoundingClientRect();
                  if (box.left < bounds.left || box.right > bounds.right)
                    failures.push(
                      `${control.getAttribute("aria-label") || control.textContent}: control overflows`,
                    );
                }
                return failures;
              }),
            { message: `${name}, ${mode}, ${width}px` },
          )
          .toEqual([]);
        if (width === 1440) {
          await expect
            .poll(() =>
              section.evaluate((root) => root.getBoundingClientRect().width),
            )
            .toBe(768);
          await expect
            .poll(() =>
              section.evaluate((root) => {
                const bounds = root.getBoundingClientRect();
                const panel = root
                  .closest(".buzz-dialog-navigation-detail")
                  .getBoundingClientRect();
                return (
                  bounds.left +
                  bounds.width / 2 -
                  (panel.left + panel.width / 2)
                );
              }),
            )
            .toBe(0);
        }
        await page.screenshot({
          path: info.outputPath(`${name.toLowerCase()}-${mode}-${width}.png`),
        });
      }
    }
  }
  await selectSettingsSection(page, "Appearance");
  for (let step = 0; step < 10; step++) {
    await page.getByRole("button", { name: "Increase interface size" }).click();
  }
  await expect(page.getByRole("status", { name: "Interface size" })).toHaveText(
    "200%",
  );
  for (const name of ["Appearance", "Agent setup", "Local settings"]) {
    await selectSettingsSection(page, name);
    const agents = page.getByRole("region", {
      name,
      exact: true,
    });
    await expect
      .poll(
        () =>
          agents.evaluate((root) => {
            const bounds = root.getBoundingClientRect();
            return [...root.querySelectorAll("*")]
              .filter((node) => {
                // Accent colors intentionally scroll horizontally at large text sizes.
                // Check the scrollport here; exercise each clipped swatch below.
                if (node.parentElement?.closest("[data-accent-colors]"))
                  return false;
                if (
                  !node.checkVisibility() ||
                  node.getAttribute("aria-hidden") === "true"
                )
                  return false;
                const box = node.getBoundingClientRect();
                return box.left < bounds.left || box.right > bounds.right;
              })
              .map((node) => ({
                tag: node.tagName,
                text: node.textContent,
                width: node.getBoundingClientRect().width,
                available: bounds.width,
              }));
          }),
        {
          message:
            "Management headings and actions fit at 200% in a narrow panel",
        },
      )
      .toEqual([]);
    if (name === "Appearance") {
      const swatches = agents.getByRole("button", { name: / accent color$/ });
      await expect(swatches.first()).toBeVisible();
      for (const swatch of await swatches.all()) {
        await swatch.focus();
        await expect(swatch).toBeFocused();
        await expect
          .poll(() =>
            swatch.evaluate((node) => {
              const bounds = node
                .closest("[data-accent-colors]")
                .getBoundingClientRect();
              const box = node.getBoundingClientRect();
              return box.left >= bounds.left && box.right <= bounds.right;
            }),
          )
          .toBe(true);
      }
    }
    await page.screenshot({
      path: info.outputPath(`${name.toLowerCase()}-dark-390-200.png`),
    });
  }
});

// Real layout metrics and Base UI focus handoff need a browser; empty/loading
// conditions are covered by component tests.
test.describe("settings empty collections", () => {
  test.use({ productionBroker: true, channelLifecycle: true });
  test("empty cards fit the settings column and their actions lead to the editor", async ({
    page,
    app,
  }, info) => {
    await page.goto(app.origin);
    // This layout journey starts after the initial reader's focus handoff, not
    // while channel startup can still dismiss the profile menu.
    await expect(
      page.getByRole("textbox", { name: /^Message #/ }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    for (const mode of ["light", "dark"]) {
      await selectSettingsSection(page, "Appearance");
      await chooseColorMode(page, mode === "light" ? "Light" : "Dark");
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      for (const width of [1440, 800, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await selectSettingsSection(page, "Custom emoji");
        await page.getByRole("tab", { name: "Community emoji (0)" }).click();
        const community = page.getByRole("group", {
          name: "Community emoji",
          exact: true,
        });
        const search = community.getByRole("searchbox", { name: "Search" });
        await search.fill("unmatched");
        await expect(
          community.getByRole("heading", { name: "No results" }),
        ).toBeVisible();
        await community.getByRole("button", { name: "Clear search" }).click();
        await expect(search).toBeFocused();
        await expect(search).toHaveValue("");
        await page.evaluate(() => document.fonts.ready);
        // Search shares the title/tab content inset rather than the border edge.
        await expect
          .poll(() =>
            community.evaluate((root) => {
              const section = root.closest("section");
              const title = section.querySelector(".buzz-content-header-title");
              const search = root.querySelector(".buzz-input-group");
              if (!title || !search) return false;
              const left = title.getBoundingClientRect().left;
              return Math.abs(search.getBoundingClientRect().left - left) < 1;
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            community.evaluate(
              (root) =>
                root.scrollWidth <= root.clientWidth &&
                document.documentElement.scrollWidth <= innerWidth,
            ),
          )
          .toBe(true);
        await page.screenshot({
          path: info.outputPath(`emoji-community-${mode}-${width}.png`),
        });
        await page.getByRole("tab", { name: "My emojis", exact: true }).click();
        const card = page.locator(".buzz-empty-state").filter({
          has: page.getByRole("heading", {
            name: "No emojis yet",
            exact: true,
          }),
        });
        await expect(card).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(() =>
            card.evaluate((root) => {
              const bounds = root.getBoundingClientRect();
              return (
                [...root.querySelectorAll("*")].every((node) => {
                  const box = node.getBoundingClientRect();
                  return box.left >= bounds.left && box.right <= bounds.right;
                }) &&
                root.scrollWidth <= root.clientWidth &&
                document.documentElement.scrollWidth <= innerWidth
              );
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            settingsDialog(page).evaluate(
              (root) =>
                root
                  .getAnimations({ subtree: true })
                  .filter((animation) => animation.playState === "running")
                  .length,
            ),
          )
          .toBe(0);
        await page.screenshot({
          path: info.outputPath(`Custom emoji-${mode}-${width}.png`),
        });
        const add = card.getByRole("button", {
          name: "Add emoji",
          exact: true,
        });
        await add.hover();
        await add.focus();
        await add.press("Enter");
        await expect(
          page.getByRole("tab", { name: "Add emoji", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        const uploadCard = page.locator(".buzz-empty-state").filter({
          has: page.getByRole("heading", {
            name: "Upload an image",
            exact: true,
          }),
        });
        await expect(uploadCard.locator("button")).toBeFocused();
        await expect
          .poll(() =>
            uploadCard.evaluate((root) => {
              const bounds = root.getBoundingClientRect();
              return [...root.querySelectorAll("*")].every((node) => {
                const box = node.getBoundingClientRect();
                return box.left >= bounds.left && box.right <= bounds.right;
              });
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            settingsDialog(page).evaluate(
              (root) =>
                root
                  .getAnimations({ subtree: true })
                  .filter((animation) => animation.playState === "running")
                  .length,
            ),
          )
          .toBe(0);
        await page.screenshot({
          path: info.outputPath(`emoji-upload-${mode}-${width}.png`),
        });
      }
    }
  });
});

// The Builderlab section applies only in FI builds. With no native host its
// session stays signed out, and hosted communities use the fixture broker.
const fiBuild = test.extend({ federatedIdentity: true });

// Hosted setup states use the real settings page with isolated account replies;
// account operations and failures are covered by the owning component tests.
fiBuild(
  "hosted settings empty and setup cards fit without covering their actions",
  async ({ page, app }, info) => {
    let signedIn = false;
    await page.route("**/api/builderlab/**", async (route) => {
      const action = new URL(route.request().url()).pathname.split("/").pop();
      const replies = {
        auth: {
          auth: signedIn
            ? { email: "test@example.com", expiresAt: "2030" }
            : null,
        },
        identity: { identity: { pubkey_hex: app.viewer } },
        list: { communities: [] },
      };
      if (!(action in replies))
        throw new Error(`Unexpected account action: ${action}`);
      await route.fulfill({ json: replies[action] });
    });
    for (const state of ["setup", "empty"]) {
      signedIn = state === "empty";
      await page.goto(app.origin);
      await page
        .getByRole("button", { name: "Your profile", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      for (const mode of ["light", "dark"]) {
        await selectSettingsSection(page, "Appearance");
        await chooseColorMode(page, mode === "light" ? "Light" : "Dark");
        for (const width of [1440, 800, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await selectSettingsSection(page, "Builderlab");
          await expect(
            page.getByRole("region", { name: "Builderlab", exact: true }),
          ).toBeVisible();
          const back = page.getByRole("button", { name: "Back to Builderlab" });
          if (await back.isVisible()) await back.click();
          const open = page.getByRole("button", { name: "Open Communities" });
          await open.click();
          const card = signedIn
            ? page.getByRole("region", { name: "Communities", exact: true })
            : page.locator(".buzz-empty-state").filter({
                has: page.getByRole("heading", {
                  name: "Sign in to manage hosted communities",
                }),
              });
          if (signedIn) {
            const create = card.getByRole("button", {
              name: "Create community",
              exact: true,
            });
            await expect(create).toBeEnabled();
          }
          await expect(card).toBeVisible();
          for (const scale of ["100%", "200%"]) {
            await page.evaluate((value) => {
              document.documentElement.style.fontSize = value;
            }, scale);
            await expect
              .poll(
                () =>
                  card.evaluate((root) => {
                    const box = root.getBoundingClientRect();
                    return (
                      [...root.querySelectorAll("*")].every((node) => {
                        if (!node.getClientRects().length) return true;
                        const child = node.getBoundingClientRect();
                        return (
                          child.left >= box.left && child.right <= box.right
                        );
                      }) && root.scrollWidth <= root.clientWidth
                    );
                  }),
                { message: `${state}, ${mode}, ${width}px, ${scale}` },
              )
              .toBe(true);
            if (!signedIn) {
              const action = card.getByRole("button", {
                name: "Sign in with Builderlab",
              });
              await action.scrollIntoViewIfNeeded();
              await expect(action).toBeInViewport({ ratio: 1 });
            }
            if (width === 390 && scale === "200%")
              await page.screenshot({
                path: info.outputPath(`hosted-${state}-${mode}-200.png`),
              });
          }
          await page.evaluate(() => {
            document.documentElement.style.fontSize = "";
          });
        }
      }
    }
  },
);
