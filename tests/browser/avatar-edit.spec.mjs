import { test, expect } from "./source-fixture.mjs";
import { readFile } from "node:fs/promises";
import { watchPageErrors } from "./page-errors.mjs";

const maskedAncestors = (element) => {
  const masked = [];
  for (let node = element; node; node = node.parentElement)
    if (getComputedStyle(node).maskImage !== "none")
      masked.push(node.className || node.tagName);
  return masked;
};

test("avatar image controls retain their hover fill and accessible URL label", async ({
  page,
}) => {
  await page.route("**/api/relay/**", (route) => route.abort());
  await page.goto("/tests/fixtures/profile-settings.html");
  await page
    .getByRole("button", { name: "Edit human profile", exact: true })
    .click();
  const editAvatar = page.getByRole("button", {
    name: "Edit avatar",
    exact: true,
  });
  // The badge owns its outer box; opting into medium preserves the artwork
  // without replacing that human/agent geometry with the new compact default.
  await expect(editAvatar).toHaveCSS("width", "32px");
  await expect(editAvatar).toHaveCSS("height", "32px");
  await expect(editAvatar.locator("svg")).toHaveCSS("width", "24px");
  await editAvatar.click();
  const dropzone = page.getByRole("button", {
    name: "Drop or browse",
    exact: true,
  });
  const url = page.getByRole("textbox", {
    name: "Picture URL (optional)",
    exact: true,
  });
  await expect(url).toBeVisible();
  await expect(url.locator("..")).toHaveClass("buzz-input-group");
  for (const dark of [false, true]) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      dark,
    );
    await dropzone.hover();
    await expect(dropzone).toHaveCSS(
      "background-color",
      dark ? "rgb(46, 46, 46)" : "rgb(241, 241, 242)",
    );
    await expect(dropzone).toBeVisible();
    // Opening scale must not leave the animated height clipping the footer.
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "Done", exact: true })
          .evaluate((button) => {
            const viewport = button.closest("fieldset").parentElement;
            return (
              viewport.getBoundingClientRect().bottom -
              button.getBoundingClientRect().bottom
            );
          }),
      )
      .toBeGreaterThanOrEqual(0);
    await page.screenshot({
      path: test
        .info()
        .outputPath(`avatar-image-${dark ? "dark" : "light"}.png`),
    });
  }
});

// Browser boundary: nested overlay hit-testing/focus, canvas image preparation,
// lazy shadow-DOM emoji picker, and narrow viewport geometry in both engines.
test("human avatar upload and scoped save", async ({ page }) => {
  const artwork = await readFile(
    new URL("../fixtures/design-system/assets/avatar.png", import.meta.url),
  );
  const errors = watchPageErrors(page);
  await page.route("**/api/relay/**", (route) => route.abort());
  await page.goto("/tests/fixtures/profile-settings.html");
  await page
    .getByRole("button", { name: "Edit human profile", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Profile to edit", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Fixture human",
  );

  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByLabel("Upload an image", { exact: true }).setInputFiles({
    name: "test.png",
    mimeType: "image/png",
    buffer: artwork,
  });
  await expect(page.getByLabel("Picture URL (optional)")).toHaveValue(
    /https:\/\/relay.example.test\/media\//,
  );
  await expect(
    page
      .getByRole("img", { name: "Avatar preview", exact: true })
      .locator("img"),
  ).toHaveAttribute("data-loaded", "true");
  await page.screenshot({ path: test.info().outputPath("human-avatar.png") });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Profile updated", { exact: true }).waitFor();
  const human = await page.evaluate(() => ({
    saved: JSON.parse(
      window.avatarProfileFixture.profiles.get("https://relay.example.test")
        .content,
    ),
    other: JSON.parse(
      window.avatarProfileFixture.profiles.get("https://other.example.test")
        .content,
    ),
    local: window.avatarProfileFixture.communities.snapshot().profile,
  }));
  expect(human.saved).toMatchObject({
    name: "Fixture human",
    about: "This field must survive avatar editing.",
    picture: expect.stringMatching(/^https:\/\/relay.example.test\/media\//),
  });
  expect(human.other.picture).toBe("");
  expect(human.local).toMatchObject({
    name: human.saved.name,
    // Private community artwork must not become the seed for another community.
    picture: "",
    about: human.saved.about,
  });
  // No live kind-0 transport in this fixture: confirmation must refresh the
  // captured session directory, not depend on an eventual WebSocket echo.
  await expect(
    page
      .getByRole("button", { name: "Your profile", exact: true })
      .locator("img"),
  ).toHaveAttribute("data-loaded", "true");
  expect(errors.unexplained()).toEqual([]);
});

test("avatar custom spectrum supports dragging, keyboard hue and return focus", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profile-settings.html");
  await page
    .getByRole("button", { name: "Edit human profile", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByRole("tab", { name: "Background", exact: true }).click();
  await page
    .getByRole("button", { name: "Custom background color", exact: true })
    .click();
  const spectrum = page.getByRole("slider", {
    name: "Color spectrum",
    exact: true,
  });
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove avatar", exact: true }),
  ).toHaveCount(0);
  const hue = page.getByRole("slider", { name: "Color hue", exact: true });
  await spectrum.press("Home");
  await spectrum.press("ArrowUp");
  await expect(spectrum).toHaveAttribute("aria-valuenow", "0");
  await spectrum.press("End");
  await hue.press("Home");
  // Sample the actual gradient paint before the thumb moves over the target.
  const painted = await spectrum.screenshot();
  const expectedColor = await page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return [
      ...context.getImageData(image.width * 0.773, image.height * 0.317, 1, 1)
        .data,
    ].slice(0, 3);
  }, painted.toString("base64"));
  const box = await spectrum.boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  const target = {
    x: box.x + box.width * 0.773,
    y: box.y + box.height * 0.317,
  };
  await page.mouse.move(target.x, target.y, {
    steps: 5,
  });
  await page.mouse.up();
  const handle = await spectrum.locator("span").boundingBox();
  expect(Math.abs(handle.x + handle.width / 2 - target.x)).toBeLessThan(1);
  expect(Math.abs(handle.y + handle.height / 2 - target.y)).toBeLessThan(1);
  const selectedColor = await spectrum
    .locator("span")
    .evaluate((el) =>
      getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number),
    );
  expectedColor.forEach((channel, index) => {
    expect(Math.abs(selectedColor[index] - channel)).toBeLessThanOrEqual(3);
  });
  await hue.press("Home");
  await hue.press("ArrowRight");
  await expect(hue).toHaveValue("1");
  const color = await spectrum
    .locator("span")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(
    page
      .getByRole("slider", { name: "Emoji position" })
      .locator("[data-avatar-shape]"),
  ).toHaveCSS("background-color", color);
  await page.screenshot({
    path: test.info().outputPath("avatar-custom-color.png"),
  });
  await page.getByRole("button", { name: "Use color", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Background", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove avatar", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Custom background color", exact: true }),
  ).toBeFocused();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await expect(
    page
      .getByRole("slider", { name: "Emoji position" })
      .locator("[data-avatar-shape]"),
  ).toHaveCSS("background-color", color);
  const viewport = page
    .getByRole("tablist", { name: "Avatar source" })
    .locator("../../../..");
  await expect(viewport).toHaveCSS("transition-property", "height");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(viewport).toHaveCSS("transition-duration", "0s");
});

// Real layout is needed to prove a failed lazy mount cannot overlap the footer.
test("emoji picker load failure fits above the footer and retries on reopen", async ({
  page,
}) => {
  await page.route("**/src/bundled/emoji/emoji-mart.ts", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `import { mountEmojiMart as mount } from "/src/bundled/emoji/emoji-mart.ts?retry-fixture";
      let first = true;
      export function mountEmojiMart(options) {
        if (first) { first = false; throw new Error("Fixture picker mount failed"); }
        return mount(options);
      }`,
    }),
  );
  await page.goto("/tests/fixtures/profile-settings.html");
  await page
    .getByRole("button", { name: "Edit human profile", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText(
    "Could not load the emoji picker. Reopen it to retry.",
  );
  await expect
    .poll(() =>
      alert.evaluate((el) => {
        const picker = el.closest("fieldset");
        const done = [...picker.querySelectorAll("button")].find(
          (button) => button.textContent === "Done",
        );
        const bounds = el.getBoundingClientRect();
        return (
          bounds.bottom <= done.getBoundingClientRect().top &&
          bounds.bottom <= picker.parentElement.getBoundingClientRect().bottom
        );
      }),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Edit avatar", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search emoji" }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
});

// Refocus on each poll so the scroll applies once the panel settles.
const focusedSliderClearsFooter = (done) =>
  done.evaluate((button) => {
    const slider = button
      .closest("fieldset")
      .querySelector('input[type="range"]');
    slider.blur();
    slider.focus();
    const footer = button.parentElement.parentElement;
    return (
      slider.getBoundingClientRect().bottom <=
      footer.getBoundingClientRect().top
    );
  });

test("a short avatar popup keeps Done in view on the Emoji tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.route("**/api/relay/**", (route) => route.abort());
  await page.goto("/tests/fixtures/profile-settings.html");
  await page
    .getByRole("button", { name: "Edit human profile", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search emoji" }),
  ).toBeVisible();
  const done = page.getByRole("button", { name: "Done", exact: true });
  // The popup scrolls beneath its sticky footer instead of hiding Done
  // below the emoji grid, and the picker's own layers stay under it.
  await expect
    .poll(() =>
      done.evaluate((button) => {
        const popup = button.closest(".popover-surface");
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return (
          popup.scrollHeight > popup.clientHeight &&
          bounds.bottom <= popup.getBoundingClientRect().bottom &&
          button.contains(hit)
        );
      }),
    )
    .toBe(true);
  // The action row, not the grid beneath it, owns the gap between actions.
  const remove = page.getByRole("button", {
    name: "Remove avatar",
    exact: true,
  });
  expect(
    await done.evaluate(
      (button, removeBox) => {
        const doneBox = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          (removeBox.x + removeBox.width + doneBox.left) / 2,
          doneBox.top + doneBox.height / 2,
        );
        return button.parentElement.contains(hit);
      },
      await remove.boundingBox(),
    ),
  ).toBe(true);
  // Focus scrolling keeps a control clear of the footer that covers the end.
  await expect.poll(() => focusedSliderClearsFooter(done)).toBe(true);
});

test("a wrapped avatar footer at enlarged text still clears focused controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 600 });
  await page.route("**/api/relay/**", (route) => route.abort());
  await page.goto("/tests/fixtures/profile-settings.html");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page
    .getByRole("button", { name: "Edit human profile", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search emoji" }),
  ).toBeVisible();
  const done = page.getByRole("button", { name: "Done", exact: true });
  const remove = page.getByRole("button", {
    name: "Remove avatar",
    exact: true,
  });
  // The actions wrap onto two rows, so the footer is taller than one control.
  await expect
    .poll(
      async () => (await done.boundingBox()).y > (await remove.boundingBox()).y,
    )
    .toBe(true);
  await expect.poll(() => focusedSliderClearsFooter(done)).toBe(true);
});

test("custom color and footer resize together without reversing direction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await page.goto("/tests/fixtures/profile-settings.html");
  await page
    .getByRole("button", { name: "Edit human profile", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByRole("tab", { name: "Background", exact: true }).click();
  const custom = page.getByRole("button", {
    name: "Custom background color",
    exact: true,
  });
  await custom.waitFor({ state: "visible" });
  // Finish the initial tab transition before measuring the two custom-color states.
  await page
    .locator("[data-buzz-ui].popover-surface")
    .evaluate(async (popup) => {
      await Promise.all(
        popup
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
    });
  for (const name of ["Custom background color", "Use color"]) {
    const frames = await page
      .getByRole("button", { name, exact: true })
      .evaluate(async (button) => {
        const popup = document.querySelector("[data-buzz-ui].popover-surface");
        const picker = popup.querySelector(
          'fieldset[aria-label="Avatar picker"]',
        );
        const viewport = picker.parentElement;
        const frames = [];
        const capture = () => {
          const bounds = popup.getBoundingClientRect();
          frames.push({ height: bounds.height, y: bounds.y });
        };
        capture();
        // Hold the actual CSS transition at the style commit, before a slow
        // runner can finish it. Seek its timeline instead of a wall-clock loop.
        const committed = new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            const transitions = viewport
              .getAnimations()
              .filter((a) => a.transitionProperty === "height");
            if (!transitions.length) return;
            observer.disconnect();
            for (const transition of transitions) transition.pause();
            resolve(transitions);
          });
          observer.observe(viewport, {
            attributes: true,
            attributeFilter: ["style"],
          });
        });
        button.click();
        const transitions = await committed;
        try {
          for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
            for (const transition of transitions)
              transition.currentTime =
                transition.effect.getTiming().duration * progress;
            // Let ResizeObserver and popover positioning catch up at this fixed time.
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            capture();
          }
        } finally {
          for (const transition of transitions) transition.finish();
          await Promise.all(transitions.map((a) => a.finished));
        }
        if (
          Math.abs(
            viewport.getBoundingClientRect().height - picker.offsetHeight,
          ) > 1
        )
          throw new Error("Picker height did not reach its content height");
        return frames;
      });
    const first = frames[0];
    const last = frames.at(-1);
    expect(frames).toHaveLength(7);
    expect(Math.abs(frames[1].height - first.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(last.height - first.height)).toBeGreaterThan(10);
    for (const frame of frames.slice(2, -1)) {
      expect(frame.height).toBeGreaterThan(Math.min(first.height, last.height));
      expect(frame.height).toBeLessThan(Math.max(first.height, last.height));
    }
    for (const axis of ["height", "y"]) {
      const direction = Math.sign(last[axis] - first[axis]);
      for (let i = 1; i < frames.length; i++) {
        expect(
          (frames[i][axis] - frames[i - 1][axis]) * direction,
          `${name} ${axis}`,
        ).toBeGreaterThanOrEqual(-1);
      }
    }
  }
});

test("emoji avatar artwork is centered and sized for faces, symbols, and joined glyphs", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profile-settings.html");
  const centers = await page.evaluate(async () => {
    const { paintEmojiAvatar, emojiAvatarScale } = await import(
      "/src/features/profiles/avatar-upload.ts"
    );
    return ["😀", "❤️", "🧑🏽‍💻", "🐈", "🇬🇧"].map((emoji) => {
      const canvas = document.createElement("canvas");
      paintEmojiAvatar(canvas, emoji);
      const pixels = canvas.getContext("2d").getImageData(0, 0, 512, 512).data;
      let left = 512,
        right = 0,
        top = 512,
        bottom = 0;
      for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) {
          if (pixels[(y * 512 + x) * 4 + 3] < 32) continue;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
      return {
        emoji,
        x: (left + right + 1) / 2,
        y: (top + bottom + 1) / 2,
        size: Math.max(right - left + 1, bottom - top + 1),
        expected: 512 * emojiAvatarScale,
      };
    });
  });
  for (const center of centers) {
    expect(
      Math.abs(center.x - 256),
      `${center.emoji} horizontal center`,
    ).toBeLessThanOrEqual(3);
    expect(
      Math.abs(center.y - 256),
      `${center.emoji} vertical center`,
    ).toBeLessThanOrEqual(3);
    expect(
      Math.abs(center.size - center.expected),
      `${center.emoji} size`,
    ).toBeLessThanOrEqual(4);
  }
});

test("avatar picker previews pointer selections and respects reduced motion", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profile-settings.html");
  await page
    .getByRole("button", { name: "Edit human profile", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Profile", exact: true })
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  await search.fill("grinning");
  const emoji = page.getByRole("button", { name: "😀", exact: true });
  await emoji.click();
  const artwork = page
    .getByRole("slider", { name: "Emoji position" })
    .locator("canvas");
  await expect(artwork).toHaveAttribute("data-animate", "true");
  await emoji.press("Enter");
  await expect(artwork).not.toHaveAttribute("data-animate");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await emoji.click();
  await expect(artwork).not.toHaveAttribute("data-animate");
  await page.getByRole("tab", { name: "Background", exact: true }).click();
  await page
    .getByRole("button", { name: "Use #63C6F2 background", exact: true })
    .click();
  await expect(
    page
      .getByRole("slider", { name: "Emoji position" })
      .locator("[data-avatar-shape]"),
  ).toHaveCSS("background-color", "rgb(99, 198, 242)");
  const position = page.getByRole("slider", { name: "Emoji position" });
  const box = await position.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height, {
    steps: 4,
  });
  await page.mouse.up();
  // Dragging the preview moves the emoji down without closing the editor.
  await expect(position).toHaveAttribute("aria-valuetext", "20% down");
  // The focus ring sits outside the avatar masks, which clip only the artwork.
  await position.press("ArrowUp");
  await expect(position).toHaveCSS("outline-style", "solid");
  expect(await position.evaluate(maskedAncestors)).toEqual([]);
  await expect(
    page.getByRole("tab", { name: "Emoji", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await search.fill("");
  await page.screenshot({
    path: test.info().outputPath("profile-avatar-picker.png"),
  });
  await position.press("Escape");
  await expect(
    page.getByRole("tab", { name: "Emoji", exact: true }),
  ).toHaveCount(0);
});

const onboardingAvatar = async (page) => {
  await page.route("**/api/relay/**", (route) => route.abort());
  await page.goto("/tests/fixtures/onboarding-profile.html");
  const add = page.getByRole("button", { name: "Add avatar", exact: true });
  await add.click();
  const dialog = page.getByRole("dialog", { name: "Edit avatar", exact: true });
  await expect(dialog).toBeVisible();
  return { add, dialog };
};

// Browser boundary: Base UI outside-press and focus-out dismissal, and return
// focus to a trigger that is remounted when the draft preview clears.
test("an unsaved onboarding avatar draft survives an outside press, and closing returns focus", async ({
  page,
}) => {
  const { add, dialog } = await onboardingAvatar(page);
  const heading = page.getByRole("heading", { name: "Set up your profile" });
  // An untouched draft still dismisses on an outside press.
  await heading.click();
  await expect(dialog).toHaveCount(0);
  await add.click();
  const url = page.getByRole("textbox", { name: "Picture URL (optional)" });
  await url.fill("https://images.example/avatar.png");
  // The heading is focusable, but the draft keeps focus as well as the popup.
  await heading.click();
  await page.mouse.click(4, 4);
  // A label focuses its control on click, after the press itself.
  await page
    .getByText("Display name", { exact: true })
    .click({ position: { x: 3, y: 5 } });
  await expect(dialog).toBeVisible();
  await expect(url).toBeFocused();
  await expect(url).toHaveValue("https://images.example/avatar.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();

  // A picked emoji is a draft too, even before any URL exists.
  await add.click();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search emoji" }),
  ).toBeVisible();
  await heading.click();
  await expect(dialog).toBeVisible();
  await page.getByRole("tab", { name: "Emoji", exact: true }).press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();

  // Tabbing out still closes, and focus lands on a control, not a hidden guard.
  await add.click();
  await url.fill("https://images.example/avatar.png");
  await page.getByRole("button", { name: "Done", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
});

// The full validation matrix lives in AvatarEditor.test.tsx; this checks the
// wiring in a real browser, where Tab moves focus out of the field.
test("the picture URL error waits for the field to lose focus", async ({
  page,
}) => {
  await onboardingAvatar(page);
  const url = page.getByRole("textbox", { name: "Picture URL (optional)" });
  const message = /Use an HTTPS image URL/;
  await url.pressSequentially("h");
  await expect(url).not.toHaveAccessibleDescription(message);
  await url.press("Tab");
  await expect(url).toHaveAccessibleDescription(message);
});

test("the onboarding display name keeps nickname autofill without spellcheck", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/onboarding-profile.html");
  const name = page.getByLabel("Display name", { exact: true });
  await expect(name).toHaveAttribute("spellcheck", "false");
  await expect(name).toHaveAttribute("autocomplete", "nickname");
});
