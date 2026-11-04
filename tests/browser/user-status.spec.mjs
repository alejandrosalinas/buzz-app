import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

test("statuses edit, synchronize, clear, reject stale traffic and retain failed drafts", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, open: false },
    preview: { open: false },
  });
  const errors = watchPageErrors(page);
  try {
    await page.route("https://emoji.test/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9" fill="purple"/></svg>',
      }),
    );
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/user-status.html`,
    );
    const navigation = page.getByRole("region", {
      name: "Navigation",
      exact: true,
    });
    const chat = page.getByRole("region", { name: "Chat", exact: true });
    const second = page.getByRole("region", {
      name: "Second device",
      exact: true,
    });
    const open = async () => {
      await page
        .getByRole("button", { name: "Your profile", exact: true })
        .click();
      await page
        .getByRole("menu", { name: "Alice" })
        .getByRole("menuitem", { name: /^Set a status/ })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Set a status" }),
      ).toBeVisible();
    };
    const editor = page.getByRole("dialog", { name: "Set a status" });
    await open();
    await expect(
      editor.getByRole("button", { name: "Save status", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Duration: Today", exact: true }),
    ).toBeVisible();
    const emojiButton = editor.getByRole("button", {
      name: "Choose a status emoji",
    });
    await editor.getByLabel("Status message").fill("Typing");
    await expect(emojiButton).toHaveText("💬");
    await editor.getByLabel("Status message").fill("   ");
    await expect(emojiButton).not.toHaveText("💬");
    await editor.getByLabel("Status message").fill("Design meeting");
    await expect(emojiButton).toHaveText("💬");
    // This picker shares the external-trigger contract with message reactions.
    // Escape restores its exact trigger without dismissing the status draft.
    await emojiButton.click();
    const emojiSearch = page.getByRole("searchbox", { name: "Search emoji" });
    await expect(emojiSearch).toBeFocused();
    await emojiSearch.press("Escape");
    await expect(emojiSearch).toBeHidden();
    await expect(emojiButton).toBeFocused();
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("Status message")).toHaveValue(
      "Design meeting",
    );
    await page.evaluate(() => window.statusPublication.hold());
    try {
      await editor
        .getByRole("button", { name: "Save status", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.statusPublication.pending()))
        .toBe(true);
      await expect(editor).toBeVisible();
      await expect(
        editor.getByRole("button", { name: "Save status" }),
      ).toBeDisabled();
    } finally {
      await page.evaluate(() => window.statusPublication.release());
    }
    await expect(editor).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Your profile", exact: true }),
    ).toBeFocused();
    await expect(
      chat.locator('[aria-label="💬 Design meeting"]'),
    ).toBeVisible();
    await expect(chat.getByText("Design meeting", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      second.getByText("Design meeting", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reject next save" }).click();
    await open();
    await expect(editor.getByLabel("Status message")).toHaveValue(
      "Design meeting",
    );
    await expect(
      editor.getByRole("button", { name: /^Duration:/ }),
    ).toHaveAttribute("aria-label", "Duration: Today");
    await editor.getByLabel("Status message").fill("Draft retained");
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toContainText(
      "Fixture save rejected",
    );
    await expect(editor.getByLabel("Status message")).toHaveValue(
      "Draft retained",
    );
    await editor.getByRole("button", { name: "Choose a status emoji" }).click();
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("bus");
    await page.getByRole("button", { name: "🚌", exact: true }).click();
    await editor.getByLabel("Status message").fill("");
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await expect(second.getByText("🚌", { exact: true })).toBeVisible();
    await open();
    await editor.getByRole("button", { name: "Choose a status emoji" }).click();
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("party");
    const custom = page.getByRole("button", { name: ":party:", exact: true });
    await expect(custom).toBeVisible();
    await custom.click();
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await expect(
      second.getByRole("img", { name: ":party:", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Profile", exact: true })
        .getByRole("img", { name: ":party:", exact: true }),
    ).toBeVisible();
    await expect(
      chat.getByRole("img", { name: ":party:", exact: true }),
    ).toBeVisible();
    await open();
    await editor.getByRole("button", { name: "Clear status" }).click();
    await expect(editor).toBeHidden();
    await expect(second.getByRole("img")).toHaveCount(0);
    await expect(
      chat.getByRole("img", { name: ":party:", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Update Bob", exact: true }).click();
    await expect(
      navigation.locator('[aria-label="🏠 Working remotely"]'),
    ).toBeVisible();
    const dmName = navigation.locator(
      '[data-channel-id="status-dm"] .navigation-item-label',
    );
    await expect(dmName).toContainText("Bob");
    await expect(
      dmName.locator('[aria-label="🏠 Working remotely"]'),
    ).toBeVisible();
    const dmStatusLayout = await dmName.evaluate((label) => {
      const nameContent = label.firstElementChild;
      const name = nameContent?.firstElementChild;
      const status = label.querySelector('[aria-label="🏠 Working remotely"]');
      if (!(name instanceof HTMLElement) || !(status instanceof HTMLElement))
        throw new Error("Missing DM name or status");
      const nameBounds = name.getBoundingClientRect();
      const statusBounds = status.getBoundingClientRect();
      const contentBounds = nameContent.getBoundingClientRect();
      return {
        hasAccessoryContract: nameContent.hasAttribute("data-name-accessory"),
        nameWidth: nameBounds.width,
        nameScrollWidth: name.scrollWidth,
        nameRight: nameBounds.right,
        statusLeft: statusBounds.left,
        statusRight: statusBounds.right,
        contentRight: contentBounds.right,
        labelRight: label.getBoundingClientRect().right,
      };
    });
    expect(dmStatusLayout.hasAccessoryContract).toBe(true);
    expect(dmStatusLayout.nameWidth).toBeCloseTo(
      dmStatusLayout.nameScrollWidth,
      0,
    );
    expect(dmStatusLayout.statusLeft - dmStatusLayout.nameRight).toBe(8);
    expect(dmStatusLayout.contentRight).toBe(dmStatusLayout.statusRight);
    expect(
      dmStatusLayout.labelRight - dmStatusLayout.statusRight,
    ).toBeGreaterThan(20);
    await expect(dmName.locator("[tabindex]")).toHaveCount(0);
    // Real text geometry catches a full-width label pushing the status away.
    const expectStatusBesideName = async () => {
      await expect
        .poll(() =>
          dmName.evaluate((element) => {
            const label = element.firstElementChild.firstElementChild;
            const status = element.querySelector("[data-compact]");
            const range = document.createRange();
            range.selectNodeContents(label);
            const textRight = Math.min(
              range.getBoundingClientRect().right,
              label.getBoundingClientRect().right,
            );
            return Math.round(status.getBoundingClientRect().left - textRight);
          }),
        )
        .toBe(8);
    };
    await expectStatusBesideName();
    await dmName.locator('[aria-label="🏠 Working remotely"]').hover();
    await expect(page.locator('[role="tooltip"][data-open]')).toContainText(
      "Working remotely",
    );
    const bobByline = chat
      .locator('[data-message-id="Bob"] strong')
      .locator("..");
    await expect(
      bobByline.locator('[aria-label="🏠 Working remotely"]'),
    ).toBeVisible();
    await bobByline.locator('[aria-label="🏠 Working remotely"]').hover();
    await expect(page.locator('[role="tooltip"][data-open]')).toContainText(
      "Working remotely",
    );
    await expect(bobByline.locator("[tabindex]")).toHaveCount(0);
    // Where the full status is shown, hovering the emoji names it, as
    // reaction previews do.
    const profileStatus = page.getByRole("region", {
      name: "Profile",
      exact: true,
    });
    await profileStatus.getByText("🏠", { exact: true }).hover();
    await expect(page.locator('[role="tooltip"][data-open]')).toHaveText(
      ":house:",
    );
    await page.getByRole("button", { name: "Replay older Bob" }).click();
    await expect(
      page
        .getByRole("region", { name: "Profile", exact: true })
        .getByText("Working remotely", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Stale", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Custom Bob", exact: true }).click();
    await expect(
      dmName.getByRole("img", { name: ":party: Celebrating", exact: true }),
    ).toBeVisible();
    await expectStatusBesideName();
    await expect(
      bobByline.getByRole("img", { name: ":party: Celebrating", exact: true }),
    ).toBeVisible();
    await profileStatus
      .getByRole("img", { name: ":party:", exact: true })
      .hover();
    await expect(page.locator('[role="tooltip"][data-open]')).toHaveText(
      ":party:",
    );
    // A code missing from the catalog keeps compact slots at emoji size and
    // reads as status text where the full status is shown.
    await page
      .getByRole("button", { name: "Uncatalogued Bob", exact: true })
      .click();
    const buzzin =
      "Buzzin' between hives all afternoon, so replies may wait until the honey run is done";
    const unresolved = `[aria-label=":bee-intensifies: ${buzzin}"]`;
    await expect(dmName.locator(unresolved)).toHaveText("💬");
    await expectStatusBesideName();
    await expect(bobByline.locator(unresolved)).toHaveText("💬");
    const code = (scope) =>
      scope.getByText(":bee-intensifies:", { exact: true });
    const expectTextSized = async (scope) => {
      const size = (locator) =>
        locator.evaluate((element) => getComputedStyle(element).fontSize);
      expect(await size(code(scope))).toBe(
        await size(scope.getByText(buzzin, { exact: true })),
      );
    };
    await expectTextSized(
      page.getByRole("region", { name: "Profile", exact: true }),
    );
    const unresolvedTip = page.locator('[role="tooltip"][data-open]');
    for (const status of [dmName, bobByline]) {
      await status.locator(unresolved).hover();
      await expect(unresolvedTip).toContainText(":bee-intensifies:");
      await expectTextSized(unresolvedTip);
      // The tooltip is where a compact slot shows the code, so long text
      // beside it must not clip it.
      expect(
        await code(unresolvedTip).evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    // The status's own image URL renders without the catalog listing the code.
    await page
      .getByRole("button", { name: "Uncatalogued Bob with image", exact: true })
      .click();
    for (const status of [dmName, bobByline]) {
      const image = status.locator(
        `[aria-label=":bee-intensifies: Buzzin'"] img`,
      );
      await expect(image).toHaveAttribute(
        "src",
        "https://emoji.test/bee-intensifies.svg",
      );
      await expect
        .poll(() => image.evaluate((element) => element.naturalWidth))
        .toBeGreaterThan(0);
    }
    await page
      .getByRole("button", { name: "Text-only Bob", exact: true })
      .click();
    await expect(dmName.locator('[aria-label="Buzzy"]')).toHaveText("💬");
    await dmName.locator('[aria-label="Buzzy"]').hover();
    await expect(page.locator('[role="tooltip"][data-open]')).toContainText(
      "Buzzy",
    );
    await expect(bobByline.locator('[aria-label="Buzzy"]')).toHaveText("💬");
    await bobByline.locator('[aria-label="Buzzy"]').hover();
    await expect(page.locator('[role="tooltip"][data-open]')).toContainText(
      "Buzzy",
    );
    await expect(navigation.getByText("Buzzy", { exact: true })).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Profile", exact: true })
        .getByText("Buzzy", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear Bob", exact: true }).click();
    await page.getByRole("button", { name: "Replay older Bob" }).click();
    await expect(dmName.locator("[data-compact]")).toHaveCount(0);
    await expect(bobByline.locator("[data-compact]")).toHaveCount(0);
    await expect(page.getByText("Stale", { exact: true })).toHaveCount(0);
    // Text or several emoji in the emoji tag, from another client, use the
    // byline's room, then truncate inside the status before the one-word
    // author gives up any width. Only the inline axis clips, so emoji ink
    // beyond the line box still paints.
    const freeText = "🐝 working from the office Buzzin'";
    for (const [button, label] of [
      ["Free-text Bob", freeText],
      ["Emoji-run Bob", "🐝🏠🎉🚀🌊🔥🍕🎸👩‍💻🏳️‍🌈 Buzzin'"],
    ]) {
      await page.setViewportSize({ width: 1440, height: 950 });
      await page.getByRole("button", { name: button, exact: true }).click();
      const fallback = bobByline.locator(`[aria-label="${label}"]`);
      await expect(fallback).toBeVisible();
      const layout = () =>
        fallback.evaluate((status) => {
          const text = status.firstElementChild;
          const author = status.parentElement.querySelector("strong");
          return {
            clipped: text.scrollWidth > text.clientWidth,
            fits:
              text.getBoundingClientRect().right <=
              status.getBoundingClientRect().right + 0.5,
            ink: getComputedStyle(text).overflowY,
            author: author.scrollWidth > author.clientWidth,
          };
        });
      await expect
        .poll(layout)
        .toEqual({ clipped: false, fits: true, ink: "visible", author: false });
      await page.setViewportSize({ width: 480, height: 950 });
      await expect
        .poll(layout)
        .toEqual({ clipped: true, fits: true, ink: "visible", author: false });
    }
    // A multi-word name wraps at spaces, so it must keep every pixel, staying
    // on one line, while the status is still above its 2.5-emoji floor.
    await page.goto(
      new URL("?name=Alexandra Kowalski-Nguyen", page.url()).href,
    );
    await page.setViewportSize({ width: 1440, height: 950 });
    await page
      .getByRole("button", { name: "Free-text Bob", exact: true })
      .click();
    await expect
      .poll(() =>
        bobByline.locator(`[aria-label="${freeText}"]`).evaluate((status) => {
          const text = status.firstElementChild;
          const author = status.parentElement.querySelector("strong");
          return {
            clipped: text.scrollWidth > text.clientWidth,
            aboveFloor:
              status.getBoundingClientRect().width >
              2.5 * parseFloat(getComputedStyle(text).fontSize) + 1,
            wrapped:
              author.getBoundingClientRect().height >
              1.5 * parseFloat(getComputedStyle(author).lineHeight),
          };
        }),
      )
      .toEqual({ clipped: true, aboveFloor: true, wrapped: false });
    // A long name must still shrink/fade and leave the status visible.
    await page.goto(
      new URL(
        "?name=Bob with a very long display name that needs to fade in the sidebar",
        page.url(),
      ).href,
    );
    await page.getByRole("button", { name: "Update Bob", exact: true }).click();
    for (const width of [1440, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(dmName.locator("[data-overflowing]")).toHaveCount(1);
      await expectStatusBesideName();
      const status = dmName.locator("[data-compact]");
      await expect(status).toBeVisible();
      await expect
        .poll(() =>
          status.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const glyph = element.firstElementChild.getBoundingClientRect();
            const row = element.closest("button").getBoundingClientRect();
            return (
              bounds.width >= 15 &&
              glyph.right <= bounds.right + 0.5 &&
              bounds.right <= row.right
            );
          }),
        )
        .toBe(true);
      await expect(dmName.locator("[data-overflowing]")).toHaveCSS(
        "mask-image",
        /linear-gradient/,
      );
    }
    // When a long byline name runs out of room, the glyph keeps its rendered
    // width instead of shrinking and painting past its box.
    const glyph = bobByline.locator('[aria-label="🏠 Working remotely"]');
    await expect(glyph).toBeVisible();
    await expect
      .poll(() =>
        glyph.evaluate((element) => {
          const author = element.parentElement.querySelector("strong");
          return {
            fits:
              element.firstElementChild.getBoundingClientRect().right <=
              element.getBoundingClientRect().right + 0.5,
            wrapped:
              author.getBoundingClientRect().height >
              1.5 * parseFloat(getComputedStyle(author).lineHeight),
          };
        }),
      )
      .toEqual({ fits: true, wrapped: true });
    // An image keeps its size beside the long name as well.
    await page.getByRole("button", { name: "Custom Bob", exact: true }).click();
    for (const scope of [dmName, bobByline]) {
      const image = scope
        .getByRole("img", { name: ":party: Celebrating", exact: true })
        .locator("img");
      await expect
        .poll(() =>
          image.evaluate((element) => {
            const { width, height } = element.getBoundingClientRect();
            return width > 0 && width === height;
          }),
        )
        .toBe(true);
    }
    // Text yields to the long name only down to its first grapheme and an
    // ellipsis, never a bare ellipsis.
    await page
      .getByRole("button", { name: "Free-text Bob", exact: true })
      .click();
    for (const scope of [dmName, bobByline]) {
      const status = scope.locator(`[aria-label="${freeText}"]`);
      await expect
        .poll(() =>
          status.evaluate((element) => {
            const text = element.firstElementChild;
            const first = document.createRange();
            first.setStart(text.firstChild, 0);
            first.setEnd(text.firstChild, "🐝".length);
            const style = getComputedStyle(text);
            const canvas = document.createElement("canvas").getContext("2d");
            canvas.font = `${style.fontSize} ${style.fontFamily}`;
            const shown = text.getBoundingClientRect();
            return {
              clipped: text.scrollWidth > text.clientWidth,
              floor:
                shown.width + 0.5 >=
                first.getBoundingClientRect().width +
                  canvas.measureText("…").width,
              fits: shown.right <= element.getBoundingClientRect().right + 0.5,
            };
          }),
        )
        .toEqual({ clipped: true, floor: true, fits: true });
    }
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
