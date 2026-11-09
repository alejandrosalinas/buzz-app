import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

test.use({ productionBroker: true, savedSidebar: true, sortingSidebar: true });

// Pause real WAAPI animations at creation, before a busy renderer can finish
// them. Seeking still exercises the browser's actual keyframes and geometry.
async function holdSidebarMotion(page) {
  const control = await page.evaluateHandle(() => {
    const animate = Element.prototype.animate;
    const animations = [];
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (
        this.closest("[data-sidebar-section]") &&
        this.firstElementChild?.matches("[data-channel-sidebar-row]")
      ) {
        animations.push(animation);
        // Motion assigns startTime after animate(), which resumes playback.
        queueMicrotask(() => {
          animation.pause();
          animation.currentTime = 0;
        });
      }
      return animation;
    };
    return {
      animations,
      finish() {
        for (const animation of animations)
          if (animation.playState === "paused") animation.finish();
      },
      release() {
        Element.prototype.animate = animate;
        this.finish();
      },
    };
  });
  return {
    async seek(property, count = 1) {
      await expect
        .poll(() =>
          control.evaluate(
            ({ animations }, property) =>
              animations.filter((animation) =>
                animation.effect
                  .getKeyframes()
                  .some((frame) => property in frame),
              ).length,
            property,
          ),
        )
        .toBeGreaterThanOrEqual(count);
      await control.evaluate(async ({ animations }) => {
        for (const fraction of [0, 0.25, 0.5, 0.75]) {
          for (const animation of animations)
            if (animation.playState === "paused")
              animation.currentTime =
                Number(animation.effect.getTiming().duration) * fraction;
          await new Promise(requestAnimationFrame);
        }
      });
    },
    finish: () => control.evaluate((state) => state.finish()),
    release: () => control.evaluate((state) => state.release()),
  };
}

// Real layout/paint and focus retention while live activity reorders keyed DOM
// cannot be established in jsdom. The same flow exercises reduced motion.
for (const reducedMotion of ["no-preference", "reduce"]) {
  test.describe(`live sidebar motion: ${reducedMotion}`, () => {
    test.use({ reducedMotion, initialSidebarSort: { channels: "recent" } });
    test("slides a live reorder without replacing the focused row", async ({
      page,
      app,
    }) => {
      await open(page, app);
      const section = page.locator('[data-sidebar-section="channels"]');
      const rows = section.locator("[data-channel-id]");
      await expect(rows.first()).toHaveAttribute("data-channel-id", "willow");
      const cedar = section.locator('[data-channel-id="cedar"]');
      await cedar.focus();
      await cedar.evaluate((element) => {
        window.sidebarMotion = {
          element,
          opacities: [],
          transforms: [],
          ys: [],
          baselineY: element.getBoundingClientRect().y,
          done: false,
        };
        const sample = () => {
          const state = window.sidebarMotion;
          state.opacities.push(
            getComputedStyle(element.closest("[data-channel-sidebar-row]"))
              .opacity,
          );
          const transform = getComputedStyle(
            element.closest("[data-channel-sidebar-row]").parentElement,
          ).transform;
          state.transforms.push(transform);
          state.ys.push(element.getBoundingClientRect().y);
          if (!state.done) requestAnimationFrame(sample);
        };
        sample();
      });
      const motion = await holdSidebarMotion(page);
      try {
        app.activity({ channel: "cedar", kind: 45003 });
        await expect(rows.first()).toHaveAttribute("data-channel-id", "cedar");
        if (reducedMotion === "no-preference") await motion.seek("transform");
      } finally {
        await motion.release();
      }
      await expect
        .poll(() =>
          cedar.evaluate((element) =>
            element
              .closest("[data-channel-sidebar-row]")
              .parentElement.getAnimations()
              .every((animation) => animation.playState !== "running"),
          ),
        )
        .toBe(true);
      await expect(cedar).toBeFocused();
      const result = await cedar.evaluate((element) => {
        window.sidebarMotion.done = true;
        return {
          same: element === window.sidebarMotion.element,
          faded: window.sidebarMotion.opacities.some(
            (value) => Number(value) < 1,
          ),
          scales: window.sidebarMotion.transforms.map((value) =>
            value === "none" ? 1 : new DOMMatrixReadOnly(value).a,
          ),
          translations: window.sidebarMotion.transforms.map((value) =>
            value === "none" ? 0 : new DOMMatrixReadOnly(value).m42,
          ),
          opacities: window.sidebarMotion.opacities.map(Number),
          intermediate: window.sidebarMotion.ys.some(
            (y) =>
              y < window.sidebarMotion.baselineY - 1 &&
              y > element.getBoundingClientRect().y + 1,
          ),
        };
      });
      expect(result.same).toBe(true);
      expect(result.faded).toBe(false);
      expect(result.intermediate).toBe(reducedMotion === "no-preference");
      expect(result.scales.every((value) => value === 1)).toBe(true);
      expect(result.translations.some((value) => Math.abs(value) > 1)).toBe(
        reducedMotion === "no-preference",
      );
      expect(Math.min(...result.scales)).toBe(1);
      expect(Math.min(...result.opacities)).toBe(1);
    });
  });
}

// Real media-query delivery and canceling native playback require a browser.
test.describe("live reduced-motion preference", () => {
  test.use({
    reducedMotion: "no-preference",
    initialSidebarSort: { channels: "recent" },
  });
  test("updates an already-mounted list when reduced motion changes", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const section = page.locator('[data-sidebar-section="channels"]');
    const rows = section.locator("[data-channel-id]");
    const cedar = section.locator('[data-channel-id="cedar"]');
    await expect(rows.first()).toHaveAttribute("data-channel-id", "willow");
    await cedar.focus();
    const held = await holdSidebarMotion(page);
    try {
      app.activity({ channel: "cedar", kind: 45003, age: 30 });
      await expect(rows.first()).toHaveAttribute("data-channel-id", "cedar");
      await held.seek("transform");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(section.locator("[data-moving]")).toHaveCount(0);
      expect(
        await rows.evaluateAll((elements) =>
          elements.every((element) => {
            const row = element.closest(
              "[data-channel-sidebar-row]",
            ).parentElement;
            const transform = new DOMMatrixReadOnly(
              getComputedStyle(row).transform,
            );
            return (
              transform.m42 === 0 &&
              row
                .getAnimations()
                .every(
                  (animation) =>
                    animation.playState !== "running" &&
                    animation.playState !== "paused",
                )
            );
          }),
        ),
      ).toBe(true);
    } finally {
      await held.release();
    }
    // Record actual native animation creation without pausing or seeking it.
    const observed = await page.evaluateHandle(() => {
      const animate = Element.prototype.animate;
      const slides = [];
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (
          this.closest('[data-sidebar-section="channels"]') &&
          animation.effect.getKeyframes().some((frame) => "transform" in frame)
        )
          slides.push(animation);
        return animation;
      };
      return {
        slides,
        restore() {
          Element.prototype.animate = animate;
        },
      };
    });
    try {
      app.activity({ channel: "willow", kind: 45003, age: 29 });
      await expect(rows.first()).toHaveAttribute("data-channel-id", "willow");
      expect(await observed.evaluate(({ slides }) => slides.length)).toBe(0);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      app.activity({ channel: "cedar", kind: 45003, age: 28 });
      await expect(rows.first()).toHaveAttribute("data-channel-id", "cedar");
      expect(
        await observed.evaluate(({ slides }) => slides.length),
      ).toBeGreaterThan(0);
      await expect(cedar).toBeFocused();
    } finally {
      await observed.evaluate((state) => state.restore());
    }
  });
});

// Hidden layout and rem-based row positions require the actual sidebar/browser.
test.describe("nearby motion after layout changes", () => {
  test.use({ initialSidebarSort: { channels: "recent" } });
  for (const change of ["Solo to Team", "interface text size"]) {
    test(`starts a nearby reorder at the live positions after ${change}`, async ({
      page,
      app,
    }) => {
      await open(page, app);
      const section = page.locator('[data-sidebar-section="channels"]');
      const rows = section.locator("[data-channel-id]");
      await expect(rows.first()).toHaveAttribute("data-channel-id", "willow");
      let promoted = "cedar";
      if (change === "Solo to Team") {
        await page.getByRole("tab", { name: "Solo", exact: true }).click();
        await expect(section).toBeHidden();
        app.activity({ channel: "cedar", kind: 45003, age: 30 });
        await expect(rows.first()).toHaveAttribute("data-channel-id", "cedar");
        await page.getByRole("tab", { name: "Team", exact: true }).click();
        await expect(section).toBeVisible();
        promoted = "willow";
      } else {
        const modifier = await page.evaluate(() =>
          /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
        );
        for (let step = 0; step < 3; step++)
          await page.keyboard.press(`${modifier}+=`);
        await expect(page.locator("html")).toHaveCSS(
          "--buzz-text-scale",
          "1.3",
        );
      }
      const target = section.locator(`[data-channel-id="${promoted}"]`);
      await target.focus();
      const before = await rows.evaluateAll((elements) =>
        elements.map((element) => ({
          id: element.dataset.channelId,
          y: element.getBoundingClientRect().y,
        })),
      );
      const motion = await holdSidebarMotion(page);
      try {
        app.activity({ channel: promoted, kind: 45003, age: 29 });
        await expect(rows.first()).toHaveAttribute("data-channel-id", promoted);
        await motion.seek("transform");
        const start = await rows.evaluateAll((elements) => {
          for (const element of elements) {
            const row = element.closest(
              "[data-channel-sidebar-row]",
            ).parentElement;
            for (const animation of row.getAnimations())
              animation.currentTime = 0;
          }
          return elements.map((element) => ({
            id: element.dataset.channelId,
            y: element.getBoundingClientRect().y,
          }));
        });
        for (const row of before)
          expect(
            Math.abs(start.find((item) => item.id === row.id).y - row.y),
          ).toBeLessThan(0.5);
      } finally {
        await motion.release();
      }
      await expect(section.locator("[data-moving]")).toHaveCount(0);
      await expect(target).toBeFocused();
    });
  }
});

// Membership updates bypass prepared ordering; real layout and presence fades
// must remain correct after hidden layout or rem-based geometry changes.
test.describe("membership changes after layout changes", () => {
  test.use({ initialSidebarSort: { channels: "recent" } });
  for (const change of ["Solo to Team", "interface text size"]) {
    test(`keeps retained rows still and fades additions/removals after ${change}`, async ({
      page,
      app,
    }) => {
      await open(page, app);
      const section = page.locator('[data-sidebar-section="channels"]');
      const rows = section.locator("button[data-channel-id]:not([inert] *)");
      await expect(rows.first()).toHaveAttribute("data-channel-id", "willow");
      await openChannelDetails(page);
      await page.getByText("Diagnostics", { exact: true }).click();
      const refresh = page.getByRole("button", {
        name: "Refresh groups and stars",
        exact: true,
      });
      let starred = ["alpha"];
      // Model only the host's decoded preferences; its real store drives the rows.
      await page.route("**/sidebar-preferences", (route) =>
        route.fulfill({
          json: {
            sections: [{ id: "work", name: "Work", order: 0 }],
            assignments: { beta: "work" },
            starred,
            muted: [],
            sort: { channels: "recent" },
          },
        }),
      );
      for (const insertion of [false, true]) {
        if (change === "Solo to Team") {
          const channel = insertion
            ? await rows.last().getAttribute("data-channel-id")
            : "cedar";
          await page.getByRole("tab", { name: "Solo", exact: true }).click();
          await expect(section).toBeHidden();
          app.activity({ channel, kind: 45003, age: insertion ? 29 : 30 });
          await expect(rows.first()).toHaveAttribute(
            "data-channel-id",
            channel,
          );
          await page.getByRole("tab", { name: "Team", exact: true }).click();
          await expect(section).toBeVisible();
        } else {
          const modifier = await page.evaluate(() =>
            /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
          );
          for (let step = 0; step < 3; step++)
            await page.keyboard.press(`${modifier}+=`);
          await expect(page.locator("html")).toHaveCSS(
            "--buzz-text-scale",
            insertion ? "1.6" : "1.3",
          );
        }
        if (!insertion)
          starred.push(await rows.first().getAttribute("data-channel-id"));
        const id = starred[1];
        const leaving = !insertion
          ? await rows.first().elementHandle()
          : undefined;
        const motion = await holdSidebarMotion(page);
        try {
          if (insertion) starred = ["alpha"];
          await refresh.click();
          await expect(rows).toHaveCount(insertion ? 3 : 2);
          await motion.seek("opacity");
          expect(
            await rows.evaluateAll(
              (elements, id) =>
                elements
                  .filter((element) => element.dataset.channelId !== id)
                  .every((element) => {
                    const row = element.closest(
                      "[data-channel-sidebar-row]",
                    ).parentElement;
                    return (
                      !row.hasAttribute("data-moving") &&
                      row
                        .getAnimations()
                        .every(
                          (animation) =>
                            !animation.effect
                              .getKeyframes()
                              .some((frame) => "transform" in frame),
                        )
                    );
                  }),
              id,
            ),
          ).toBe(true);
          const fading = insertion
            ? await section
                .locator(`button[data-channel-id="${id}"]:not([inert] *)`)
                .elementHandle()
            : leaving;
          const opacity = await fading.evaluate((element) =>
            Number(
              getComputedStyle(
                element.closest("[data-channel-sidebar-row]").parentElement,
              ).opacity,
            ),
          );
          expect(opacity).toBeGreaterThan(0);
          expect(opacity).toBeLessThan(1);
          if (!insertion)
            expect(
              await leaving.evaluate((element) => !!element.closest("[inert]")),
            ).toBe(true);
        } finally {
          await motion.release();
        }
        await expect(section.locator("[inert] [data-channel-id]")).toHaveCount(
          0,
        );
        await expect(refresh).toBeEnabled();
      }
    });
  }
});

// Cedar and Willow exchange indices between A–Z and Recent; Maple keeps its
// index. Real browser frames prove the anchor never dims or shifts.
test("keeps a stationary selected row visible while its neighbors exchange places", async ({
  page,
  app,
}) => {
  await open(page, app);
  const section = page.locator('[data-sidebar-section="channels"]');
  const rows = section.locator("[data-channel-id]");
  const maple = section.locator('[data-channel-id="maple"]');
  await maple.click();
  await maple.evaluate((element) => {
    const moving = element
      .closest("[data-sidebar-section]")
      .querySelector('[data-channel-id="cedar"]');
    const row = element.closest("[data-channel-sidebar-row]").parentElement;
    const movingRow = moving.closest(
      "[data-channel-sidebar-row]",
    ).parentElement;
    const container = row.parentElement;
    const baseline = element.getBoundingClientRect().y;
    window.stationaryMotion = {
      element,
      baseline,
      movingX: movingRow.getBoundingClientRect().x,
      frames: [],
      done: false,
    };
    const sample = () => {
      const state = window.stationaryMotion;
      const opacity = Number(getComputedStyle(container).opacity);
      state.frames.push({
        y: element.getBoundingClientRect().y,
        stationary: Number(getComputedStyle(row).opacity) * opacity,
        moving:
          Number(getComputedStyle(movingRow.firstElementChild).opacity) *
          Number(getComputedStyle(movingRow).opacity) *
          opacity,
        backed:
          movingRow.hasAttribute("data-moving") &&
          getComputedStyle(movingRow).opacity === "1" &&
          !["transparent", "rgba(0, 0, 0, 0)"].includes(
            getComputedStyle(movingRow).backgroundColor,
          ),
        movingX: movingRow.getBoundingClientRect().x,
        stationaryScale:
          getComputedStyle(row).transform === "none"
            ? 1
            : new DOMMatrixReadOnly(getComputedStyle(row).transform).a,
        movingTransform: getComputedStyle(movingRow).transform,
        promotedAbove:
          Number(
            getComputedStyle(
              container
                .querySelector('[data-channel-id="willow"]')
                .closest("[data-channel-sidebar-row]").parentElement,
            ).zIndex,
          ) > Number(getComputedStyle(movingRow).zIndex),
      });
      if (!state.done) requestAnimationFrame(sample);
    };
    sample();
  });
  const motion = await holdSidebarMotion(page);
  try {
    await section
      .getByRole("button", { name: "More actions for Channels" })
      .click();
    await page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await page
      .getByRole("menu", { name: "Sort Channels", exact: true })
      .getByRole("menuitemradio", { name: "Recent", exact: true })
      .click();
    await expect
      .poll(() =>
        rows.evaluateAll((elements) =>
          elements.map((element) => element.dataset.channelId),
        ),
      )
      .toEqual(["willow", "maple", "cedar"]);
    await motion.seek("transform");
  } finally {
    await motion.release();
  }
  await expect
    .poll(() =>
      maple.evaluate(
        (element) =>
          getComputedStyle(
            element.closest("[data-channel-sidebar-row]").parentElement
              .parentElement,
          ).opacity,
      ),
    )
    .toBe("1");
  await expect
    .poll(() =>
      section.locator('[data-channel-id="cedar"]').evaluate((element) =>
        element
          .closest("[data-channel-sidebar-row]")
          .parentElement.getAnimations()
          .every((animation) => animation.playState !== "running"),
      ),
    )
    .toBe(true);
  const result = await maple.evaluate((element) => {
    const state = window.stationaryMotion;
    state.done = true;
    return {
      same: state.element === element,
      fixed: state.frames.every(
        (frame) =>
          frame.y === state.baseline &&
          frame.stationary === 1 &&
          frame.stationaryScale === 1,
      ),
      movingFaded: state.frames.some((frame) => frame.moving < 1),
      crossingIsOpaque: state.frames
        .filter(
          (frame) =>
            frame.movingTransform !== "none" &&
            Math.abs(new DOMMatrixReadOnly(frame.movingTransform).m42) > 1,
        )
        .every((frame) => frame.backed),
      promotedAbove: state.frames.some((frame) => frame.promotedAbove),
      movingTransformed: state.frames.some(
        (frame) => frame.movingTransform !== "none",
      ),
      noLateralDrift: state.frames.every(
        (frame) => frame.movingX === state.movingX,
      ),
    };
  });
  expect(result).toMatchObject({
    same: true,
    fixed: true,
    movingFaded: false,
    crossingIsOpaque: true,
    promotedAbove: true,
    movingTransformed: true,
    noLateralDrift: true,
  });
  await expect(section.locator("[data-moving]")).toHaveCount(0);
  await expect(maple).toHaveAttribute("aria-current", "page");
});
// Real animation progress and retargeted screen positions require a browser.
test("retargets an unfinished slide without jumping or losing focus", async ({
  page,
  app,
}) => {
  await open(page, app);
  const section = page.locator('[data-sidebar-section="channels"]');
  const rows = section.locator("[data-channel-id]");
  await section
    .getByRole("button", { name: "More actions for Channels" })
    .click();
  await page
    .getByRole("menu", { name: "More actions for Channels", exact: true })
    .getByRole("menuitem", { name: "Sort", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("menu", { name: "Sort Channels", exact: true })
    .getByRole("menuitemradio", { name: "Recent", exact: true })
    .click();
  const cedar = section.locator('[data-channel-id="cedar"]');
  const willow = section.locator('[data-channel-id="willow"]');
  const settled = () =>
    expect
      .poll(() =>
        rows.evaluateAll((elements) =>
          elements.every((element) =>
            element
              .closest("[data-channel-sidebar-row]")
              .parentElement.getAnimations()
              .every((animation) => animation.playState !== "running"),
          ),
        ),
      )
      .toBe(true);
  await expect(rows.first()).toHaveAttribute("data-channel-id", "willow");
  await settled();
  await cedar.focus();
  const motion = await holdSidebarMotion(page);
  try {
    app.activity({ channel: "cedar", kind: 45003, age: 30 });
    await expect(rows.first()).toHaveAttribute("data-channel-id", "cedar");
    await expect
      .poll(
        () =>
          willow.evaluate((element) =>
            element
              .closest("[data-channel-sidebar-row]")
              .parentElement.getAnimations()
              .some((animation) =>
                animation.effect
                  .getKeyframes()
                  .some((frame) => "transform" in frame),
              ),
          ),
        { intervals: [10, 20, 50] },
      )
      .toBe(true);
    // Freeze the old slide at its midpoint, then compare with the first frame
    // of its replacement. Elapsed runner time cannot masquerade as a jump.
    const before = await willow.evaluate((element) => {
      const row = element.closest("[data-channel-sidebar-row]").parentElement;
      for (const animation of row.getAnimations()) {
        animation.pause();
        animation.currentTime = 70;
      }
      return element.getBoundingClientRect().y;
    });
    app.activity({ channel: "willow", kind: 45003, age: 29 });
    await expect(rows.first()).toHaveAttribute("data-channel-id", "willow");
    await expect
      .poll(() =>
        willow.evaluate((element) =>
          element
            .closest("[data-channel-sidebar-row]")
            .parentElement.getAnimations()
            .some((animation) =>
              animation.effect
                .getKeyframes()
                .some((frame) => "transform" in frame),
            ),
        ),
      )
      .toBe(true);
    const after = await willow.evaluate((element) => {
      const row = element.closest("[data-channel-sidebar-row]").parentElement;
      for (const animation of row.getAnimations()) {
        animation.pause();
        animation.currentTime = 0;
      }
      const y = element.getBoundingClientRect().y;
      for (const animation of row.getAnimations()) animation.play();
      return y;
    });
    expect(Math.abs(after - before)).toBeLessThan(0.5);
  } finally {
    await motion.release();
  }
  await settled();
  await expect(section.locator("[data-moving]")).toHaveCount(0);
  await expect(cedar).toBeFocused();
  await expect
    .poll(() =>
      willow.evaluate(
        (element) =>
          getComputedStyle(element.closest("[data-channel-sidebar-row]"))
            .opacity,
      ),
    )
    .toBe("1");
  const transform = await willow.evaluate(
    (element) =>
      new DOMMatrixReadOnly(
        getComputedStyle(
          element.closest("[data-channel-sidebar-row]").parentElement,
        ).transform,
      ),
  );
  expect(transform.a).toBe(1);
  expect(transform.m42).toBe(0);
});

// Distance classification and hidden endpoint swaps require real geometry/paint.
test.describe("distant channel motion", () => {
  const channels = [
    "alpha",
    "beta",
    "cedar",
    "elm",
    "maple",
    "oak",
    "pine",
    "willow",
  ];
  test.use({
    channelIds: channels,
    historyCounts: Object.fromEntries(channels.map((id) => [id, 1])),
    initialSidebarSort: { channels: "recent" },
  });
  test("fades a distant jump at its endpoints without a long slide", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const section = page.locator('[data-sidebar-section="channels"]');
    const rows = section.locator("[data-channel-id]");
    await expect(rows).toHaveCount(6);
    const id = await rows.last().getAttribute("data-channel-id");
    const target = section.locator(`[data-channel-id="${id}"]`);
    await target.focus();
    await target.evaluate((element) => {
      const row = element.closest("[data-channel-sidebar-row]").parentElement;
      window.distantMotion = {
        element,
        oldY: element.getBoundingClientRect().y,
        frames: [],
        done: false,
      };
      const sample = () => {
        const state = window.distantMotion;
        const style = getComputedStyle(row);
        const m = new DOMMatrixReadOnly(style.transform);
        state.frames.push({
          y: element.getBoundingClientRect().y,
          opacity: Number(style.opacity),
          scale: m.a,
          translation: m.m42,
        });
        if (!state.done) requestAnimationFrame(sample);
      };
      sample();
    });
    const motion = await holdSidebarMotion(page);
    try {
      app.activity({ channel: id, kind: 45003 });
      await motion.seek("opacity");
      await motion.finish();
      await expect(rows.first()).toHaveAttribute("data-channel-id", id);
      await motion.seek("opacity", 2);
    } finally {
      await motion.release();
    }
    await expect
      .poll(() =>
        target.evaluate(
          (element) =>
            getComputedStyle(
              element.closest("[data-channel-sidebar-row]").parentElement,
            ).opacity,
        ),
      )
      .toBe("1");
    const result = await target.evaluate((element) => {
      const state = window.distantMotion;
      state.done = true;
      const y = element.getBoundingClientRect().y;
      const partial = state.frames.filter(
        (frame) => frame.opacity > 0.05 && frame.opacity < 0.95,
      );
      return {
        same: state.element === element,
        oldFade: partial.some((frame) => Math.abs(frame.y - state.oldY) < 0.5),
        newFade: partial.some((frame) => Math.abs(frame.y - y) < 0.5),
        onlyEndpoints: state.frames.every(
          (frame) =>
            Math.abs(frame.y - state.oldY) < 0.5 || Math.abs(frame.y - y) < 0.5,
        ),
        noScale: state.frames.every((frame) => frame.scale === 1),
        noSlide: state.frames.every(
          (frame) => Math.abs(frame.translation) < 0.5,
        ),
      };
    });
    expect(result).toEqual({
      same: true,
      oldFade: true,
      newFade: true,
      onlyEndpoints: true,
      noScale: true,
      noSlide: true,
    });
    await expect(target).toBeFocused();
  });
});

// Native details/menu nesting, submenu focus/viewport placement and row reorder
// through the built app + real broker are browser contracts. Matrices live below.
test("section sort applies immediately, rolls back on failure, and persists retry independently", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
    includeHidden: true,
  });
  const channels = sidebar.locator('[data-sidebar-section="channels"]');
  const work = sidebar.locator('[data-sidebar-section="group:work"]');
  const trigger = channels.getByRole("button", {
    name: "More actions for Channels",
  });
  const rows = channels.locator("[data-channel-id]");
  const order = () =>
    rows.evaluateAll((elements) => elements.map((el) => el.dataset.channelId));
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(rows.first()).toBeVisible();
  const alphaOrder = await order();
  expect(alphaOrder.length).toBeGreaterThan(2);
  const activity = app.report.queries.filter((q) =>
    q.filter.kinds?.includes(45003),
  );
  expect(activity).toEqual([]);
  async function openSort() {
    await trigger.click();
    await expect(channels.locator("details")).toHaveAttribute("open", "");
    await page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("menu", { name: "Sort Channels", exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({
    path: testInfo.outputPath("sidebar-sort-alpha.png"),
    clip: { x: 0, y: 0, width: 540, height: 460 },
  });
  await openSort();
  const menu = page.getByRole("menu", { name: "Sort Channels", exact: true });
  await expect(
    menu.getByRole("menuitemradio", { name: "A–Z" }),
  ).toHaveAttribute("aria-checked", "true");
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/sidebar-sort", async (route) => {
    started();
    await held;
    app.report.sidebarSortFailures ??= [];
    app.report.sidebarSortFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "sort save failed" }),
    });
  });
  try {
    await menu.getByRole("menuitemradio", { name: "Recent" }).click();
    await requestStarted;
    await expect(menu).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    await openSort();
    await expect(
      menu.getByRole("menuitemradio", { name: "A–Z" }),
    ).toBeEnabled();
    await expect(
      menu.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect.poll(order).not.toEqual(alphaOrder);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  } finally {
    release();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the sort order for Channels" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect.poll(order).toEqual(alphaOrder);
  await page.unroute("**/sidebar-sort");
  // Error ownership is session-scoped, not coupled to the dismissed menu/page.
  await page.getByRole("tab", { name: "Agents", exact: true }).first().click();
  await expect(sidebar).toBeHidden();
  await expect(error).toBeHidden();
  await openPage(page, "Messages");
  await expect(sidebar).toBeVisible();
  await expect(error).toBeVisible();
  async function confirmedSort(action) {
    const response = page.waitForResponse("**/sidebar-sort");
    await action();
    expect((await response).ok()).toBe(true);
    await (await response).finished();
  }
  await confirmedSort(() =>
    error.getByRole("button", { name: "Retry sort" }).click(),
  );
  await expect(error).toHaveCount(0);
  await expect.poll(order).not.toEqual(alphaOrder);
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-sort",
    blob: { groups: { channels: "recent" } },
  });
  const recentOrder = await order();
  // The row menu and section sort share one session preference owner. A mute
  // confirmation must not drop Recent, and later sorting must not drop mute.
  const cedar = channels.locator('[data-channel-id="cedar"]');
  await cedar.click({ button: "right" });
  const rowMenu = page.getByRole("menu", { name: "Actions for Cedar" });
  const muted = page.waitForResponse("**/sidebar-mute");
  await rowMenu.getByRole("menuitem", { name: "Mute", exact: true }).click();
  expect((await muted).ok()).toBe(true);
  await (await muted).finished();
  await expect(rowMenu).toHaveCount(0);
  await expect(cedar).toBeFocused();
  await expect.poll(order).toEqual(recentOrder);
  await openSort();
  await expect(
    menu.getByRole("menuitemradio", { name: "Recent" }),
  ).toHaveAttribute("aria-checked", "true");
  // Real layout verifies that the shared nested-radius recipe reaches both the lone
  // submenu trigger and grouped radio choices, without feature-local corners.
  const sort = page
    .getByRole("menu", { name: "More actions for Channels", exact: true })
    .getByRole("menuitem", { name: "Sort", exact: true });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    for (const width of [720, 1000, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      const radius = await sort.evaluate((element) => {
        const popup = element.closest(".buzz-menu-popup");
        const style = getComputedStyle(popup);
        return `${Math.max(
          0,
          Number.parseFloat(style.borderTopLeftRadius) -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.borderLeftWidth),
        )}px`;
      });
      for (const item of [
        sort,
        menu.getByRole("menuitemradio", { name: "Recent" }),
        menu.getByRole("menuitemradio", { name: "A–Z" }),
      ]) {
        for (const corner of [
          "top-left",
          "top-right",
          "bottom-left",
          "bottom-right",
        ]) {
          await expect(item).toHaveCSS(`border-${corner}-radius`, radius);
        }
      }
    }
  }
  await expect(menu).toHaveCSS("opacity", "1");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("sidebar-sort-menu.png"),
    clip: { x: 0, y: 0, width: 540, height: 460 },
  });
  const box = await menu.boundingBox(),
    viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).not.toBeVisible();
  await work.getByRole("button", { name: "More actions for Work" }).click();
  await page
    .getByRole("menu", { name: "More actions for Work", exact: true })
    .getByRole("menuitem", { name: "Sort", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const workMenu = page.getByRole("menu", { name: "Sort Work", exact: true });
  await expect(
    workMenu.getByRole("menuitemradio", { name: "A–Z" }),
  ).toHaveAttribute("aria-checked", "true");
  await confirmedSort(() =>
    workMenu.getByRole("menuitemradio", { name: "Recent" }).click(),
  );
  await expect(workMenu).not.toBeVisible();
  expect(app.report.sidebarPublications.at(-1).blob.groups).toEqual({
    channels: "recent",
    "section:work": "recent",
  });
  await expect.poll(order).toEqual(recentOrder);
  await openSort();
  await confirmedSort(() =>
    menu.getByRole("menuitemradio", { name: "A–Z" }).click(),
  );
  await expect(menu).not.toBeVisible();
  await expect.poll(order).toEqual(alphaOrder);
  expect(app.report.sidebarPublications.at(-1).blob.groups).toEqual({
    "section:work": "recent",
  });
  await page.reload();
  await expect.poll(order).toEqual(alphaOrder);
  await cedar.click({ button: "right" });
  await expect(
    rowMenu.getByRole("menuitem", { name: "Unmute", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(cedar).toBeFocused();
  await work.getByRole("button", { name: "More actions for Work" }).click();
  await page
    .getByRole("menu", { name: "More actions for Work", exact: true })
    .getByRole("menuitem", { name: "Sort", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    workMenu.getByRole("menuitemradio", { name: "Recent" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(app.report.unexpected).toEqual([]);
});

// The production portal/action wiring and broker retry boundary are browser
// contracts; state-machine ordering remains covered by the session test.
test("retires Recent failures on A–Z and recovers selected ordering on retry", async ({
  page,
  app,
}) => {
  let attempts = 0;
  let releaseFailure;
  let failureGate = new Promise((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/channel-activity", async (route) => {
    attempts++;
    if (attempts <= 3) {
      await failureGate;
      app.report.sidebarActivityFailures ??= [];
      app.report.sidebarActivityFailures.push(route.request().url());
      // A denial: a transient failure would retry quietly first.
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "activity read failed" }),
      });
      return;
    }
    await route.fulfill({ response: await route.fetch() });
  });
  await open(page, app);
  const channels = page.locator('[data-sidebar-section="channels"]');
  const rows = channels.locator("[data-channel-id]");
  const order = () =>
    rows.evaluateAll((elements) => elements.map((el) => el.dataset.channelId));
  await expect(rows.first()).toBeVisible();
  const alphaOrder = await order();
  const menu = page.getByRole("menu", { name: "Sort Channels", exact: true });
  async function openSort() {
    await channels
      .getByRole("button", { name: "More actions for Channels" })
      .click();
    await page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(menu).toBeVisible();
  }
  async function setSort(mode) {
    await openSort();
    const saved = page.waitForResponse("**/sidebar-sort");
    await menu.getByRole("menuitemradio", { name: mode }).click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    await response.finished();
    await expect(menu).not.toBeVisible();
  }
  const notifications = page.getByRole("region", { name: "App notifications" });
  const warning = notifications.getByText("Couldn’t refresh recent activity");
  async function failRecent(expectedAttempts) {
    failureGate = new Promise((resolve) => {
      releaseFailure = resolve;
    });
    await setSort("Recent");
    await expect.poll(() => attempts).toBe(expectedAttempts);
    // Settle the save before rejecting history, so its publication cannot
    // trigger an incidental retry and conceal the explicit recovery boundary.
    releaseFailure();
    await expect(warning).toBeVisible();
  }
  try {
    await failRecent(1);
    await expect(
      notifications.getByText(
        "Activity filters and Recent sorting may be out of date.",
      ),
    ).toBeVisible();
    await setSort("A–Z");
    await expect(warning).toHaveCount(0);
    await expect.poll(order).toEqual(alphaOrder);

    await failRecent(2);
    await notifications
      .getByRole("button", { name: "Dismiss notification" })
      .click();
    await expect(warning).toHaveCount(0);
    await setSort("A–Z");
    await failRecent(3);
    await openSort();
    await expect(
      menu.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await notifications.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => attempts).toBe(4);
    await expect(warning).toHaveCount(0);
    await expect
      .poll(async () => (await order()).slice(0, 3))
      .toEqual(["willow", "maple", "cedar"]);
    await openSort();
    await expect(
      menu.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(app.report.unexpected).toEqual([]);
  } finally {
    releaseFailure();
  }
});

// Cold-start paint is a composition contract: real saved sort, activity response,
// and independent conversation opening. Timer/order permutations live in RTL.
test.describe("cold sidebar presentation", () => {
  test.use({ initialSidebarSort: { channels: "recent" } });
  test("reveals saved placement and Recent together without blocking the conversation", async ({
    page,
    app,
  }, testInfo) => {
    let releasePreferences, releaseActivity;
    const preferences = new Promise((resolve) => {
      releasePreferences = resolve;
    });
    const activity = new Promise((resolve) => {
      releaseActivity = resolve;
    });
    let preferencesStarted, activityStarted;
    const decoding = new Promise((resolve) => {
      preferencesStarted = resolve;
    });
    const ordering = new Promise((resolve) => {
      activityStarted = resolve;
    });
    // The installed clock ticks from injection, so pausing at runner "now"
    // races its first sync. Pause at a fixed instant from the install base;
    // nothing is pending in about:blank for the jump to fire.
    const base = Date.now();
    await page.clock.install({ time: base });
    await page.clock.pauseAt(base + 20_000);
    await page.addInitScript(() =>
      localStorage.setItem("buzz-appearance.v1", "dark"),
    );
    await page.route("**/sidebar-preferences", async (route) => {
      const response = await route.fetch();
      preferencesStarted();
      await preferences;
      await route.fulfill({ response });
    });
    await page.route("**/channel-activity", async (route) => {
      const response = await route.fetch();
      activityStarted();
      await activity;
      await route.fulfill({ response });
    });
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    try {
      await page.goto(app.origin);
      await decoding;
      // Solo history shares this scrollport and reports its own loading.
      await expect(
        sidebar
          .getByRole("status")
          .filter({ hasText: "Loading your sidebar…" }),
      ).toBeVisible();
      await expect(sidebar.locator("[data-channel-id]")).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("sidebar-cold-loading.png"),
        clip: { x: 0, y: 0, width: 540, height: 460 },
      });
      releasePreferences();
      await ordering;
      await expect(sidebar.locator("[data-channel-id]")).toHaveCount(0);
      releaseActivity();
      const rows = sidebar.locator(
        '[data-sidebar-section="channels"] [data-channel-id]',
      );
      await expect(rows.first()).toBeVisible();
      expect(
        await rows.evaluateAll((elements) =>
          elements.slice(0, 3).map((el) => el.dataset.channelId),
        ),
      ).toEqual(["willow", "maple", "cedar"]);
      await expect(
        sidebar.locator(
          '[data-sidebar-section="group:work"] [data-channel-id="beta"]',
        ),
      ).toBeVisible();
      await expect(sidebar.getByRole("status")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("sidebar-cold-revealed.png"),
        clip: { x: 0, y: 0, width: 540, height: 460 },
      });
    } finally {
      releasePreferences();
      releaseActivity();
      // Remove the gates before resumed timers can start a fresh intercepted read.
      await page.unroute("**/sidebar-preferences");
      await page.unroute("**/channel-activity");
      await page.clock.resume();
    }
  });
});

// Browser integration: confirmed lifecycle removal must use the same sorted
// projection, and reload must compose saved sorting with relay DM visibility.
test.describe("sorting with lifecycle visibility", () => {
  test.use({
    channelLifecycle: true,
    initialSidebarSort: { channels: "recent", dms: "recent" },
  });
  test("archive and DM hide preserve Recent ordering through reload", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const channels = sidebar.locator('[data-sidebar-section="channels"]');
    const ids = () =>
      channels
        .locator("[data-channel-id]")
        .evaluateAll((rows) => rows.map((row) => row.dataset.channelId));
    const archivedId = "11111111-1111-4111-8111-111111111111";
    const hiddenId = "22222222-2222-4222-8222-222222222222";
    await expect.poll(ids).toEqual(["willow", "maple", "cedar", archivedId]);
    const channel = channels.locator(`[data-channel-id="${archivedId}"]`);
    await channel.click();
    const composer = page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    });
    await expect(composer).toBeVisible();
    const conversationUrl = page.url();
    await channel.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Archive channel", exact: true })
      .click();
    const archive = page.getByRole("dialog", {
      name: "Archive channel: Lifecycle channel",
    });
    await archive
      .getByRole("button", { name: "Archive channel", exact: true })
      .click();
    await expect(archive).toHaveCount(0);
    await expect.poll(ids).toEqual(["willow", "maple", "cedar"]);
    // Archive removes the sidebar row, not the selected conversation.
    await expect(page).toHaveURL(conversationUrl);
    await expect(
      page.getByRole("region", { name: "Archived channel", exact: true }),
    ).toHaveText("This channel is archived");
    await expect(composer).toHaveCount(0);

    const dm = sidebar.locator(`[data-channel-id="${hiddenId}"]`);
    await dm.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Hide conversation", exact: true })
      .click();
    const hide = page.getByRole("dialog");
    await hide
      .getByRole("button", { name: "Hide conversation", exact: true })
      .click();
    await expect(hide).toHaveCount(0);
    await expect(dm).toHaveCount(0);
    await expect.poll(ids).toEqual(["willow", "maple", "cedar"]);
    await page.reload();
    await expect.poll(ids).toEqual(["willow", "maple", "cedar"]);
    await expect(page).toHaveURL(conversationUrl);
    await expect(
      page.getByRole("region", { name: "Archived channel", exact: true }),
    ).toHaveText("This channel is archived");
    await expect(composer).toHaveCount(0);
    // Opening Sort proves saved preference decoding and sidebar startup settled.
    await channels
      .getByRole("button", { name: "More actions for Channels" })
      .click();
    await page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(
        () =>
          app.report.queries.filter(({ filter }) =>
            filter.kinds?.includes(30622),
          ).length,
      )
      .toBeGreaterThan(1);
    await expect(dm).toHaveCount(0);
    expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual(
      [9002, 41012],
    );
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
    expect(app.report.unexpected).toEqual([]);
  });
});
