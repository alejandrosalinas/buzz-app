import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";
import { pauseClock } from "./clock.mjs";

const chats = ["alpha", "beta", "gamma", "delta", "echo"];
test.use({
  productionBroker: true,
  reducedMotion: "no-preference",
  channelIds: chats,
  channelNames: {
    alpha: "Alpha",
    beta: "Beta",
    gamma: "Gamma",
    delta: "Delta",
    echo: "Echo",
  },
  soloChannels: chats,
  ownSoloChannels: chats,
  historyCounts: Object.fromEntries(chats.map((id) => [id, 1])),
});

// Native transforms, endpoint geometry and media-query delivery require a
// browser; batching and the two Solo host variants stay in component tests.
test("slides nearby activity, fades distant activity and honors live reduced motion", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const rows = sidebar.locator("button[data-solo-channel-id]:not([inert] *)");
  await expect(rows).toHaveCount(5);
  const original = await rows.evaluateAll((rows) =>
    rows.map((row) => row.dataset.soloChannelId),
  );
  const nearby = original[1];
  const distant = original.at(-1);
  const row = sidebar.locator(`[data-solo-channel-id="${nearby}"]`);
  await row.focus();
  const control = await row.evaluateHandle((element) => {
    const animate = Element.prototype.animate;
    const animations = [];
    const state = { element, animations, animate, hold: true };
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (
        this.firstElementChild?.hasAttribute("data-solo-menu-id") &&
        animation.effect.getKeyframes().some((frame) => "transform" in frame)
      ) {
        animations.push(animation);
        if (state.hold)
          queueMicrotask(() => {
            animation.pause();
            animation.currentTime = 0;
          });
      }
      return animation;
    };
    return state;
  });
  try {
    app.activity({ channel: nearby, kind: 45003, age: 2 });
    await expect(rows.first()).toHaveAttribute("data-solo-channel-id", nearby);
    await expect
      .poll(() => control.evaluate(({ animations }) => animations.length))
      .toBeGreaterThan(0);
    const geometry = await row.evaluate((element) => {
      const wrapper = element.closest("[data-solo-menu-id]").parentElement;
      const transform = new DOMMatrixReadOnly(
        getComputedStyle(wrapper).transform,
      );
      return {
        delta: transform.m42,
        scale: transform.a,
        opacity: Number(getComputedStyle(wrapper).opacity),
      };
    });
    expect(geometry.delta).toBeGreaterThan(1);
    expect(geometry.scale).toBe(1);
    expect(geometry.opacity).toBe(1);
    expect(
      await control.evaluate(
        ({ element }) => element === document.activeElement,
      ),
    ).toBe(true);
    await control.evaluate((state) => {
      state.hold = false;
      for (const animation of state.animations)
        if (animation.playState === "paused") animation.finish();
    });
    await expect(sidebar.locator("[data-moving]")).toHaveCount(0);
    const far = sidebar.locator(`[data-solo-channel-id="${distant}"]`);
    await far.focus();
    await far.evaluate((element) => {
      const wrapper = element.closest("[data-solo-menu-id]").parentElement;
      window.soloMotion = { element, frames: [], done: false };
      const sample = () => {
        const state = window.soloMotion;
        state.frames.push({
          y: element.getBoundingClientRect().y,
          opacity: Number(getComputedStyle(wrapper).opacity),
          translation: new DOMMatrixReadOnly(
            getComputedStyle(wrapper).transform,
          ).m42,
        });
        if (!state.done) requestAnimationFrame(sample);
      };
      sample();
    });
    app.activity({ channel: distant, kind: 45003, age: 1 });
    await expect(rows.first()).toHaveAttribute("data-solo-channel-id", distant);
    await expect(
      sidebar.locator(`[data-solo-menu-id="${distant}"]`).locator(".."),
    ).toHaveCSS("opacity", "1");
    const result = await far.evaluate((element) => {
      const state = window.soloMotion;
      state.done = true;
      const endpoints = [state.frames[0].y, element.getBoundingClientRect().y];
      return {
        same: state.element === element,
        faded: state.frames.some((frame) => frame.opacity < 1),
        endpointsOnly: state.frames.every(
          (frame) =>
            frame.translation === 0 &&
            endpoints.some((y) => Math.abs(frame.y - y) < 0.5),
        ),
      };
    });
    expect(result).toEqual({ same: true, faded: true, endpointsOnly: true });
    await expect(sidebar.locator("[data-moving]")).toHaveCount(0);
    await expect(far).toBeFocused();

    // Freeze timers so a delayed/faded reorder cannot masquerade as immediate.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pauseClock(page);
    const animationCount = await control.evaluate(
      ({ animations }) => animations.length,
    );
    const immediate = sidebar.locator(
      `[data-solo-channel-id="${original[0]}"]`,
    );
    await immediate.focus();
    app.activity({ channel: original[0], kind: 45003 });
    await expect(rows.first()).toHaveAttribute(
      "data-solo-channel-id",
      original[0],
    );
    expect(await control.evaluate(({ animations }) => animations.length)).toBe(
      animationCount,
    );
    await expect(sidebar.locator("[data-moving]")).toHaveCount(0);
    await expect(immediate).toBeFocused();
    await expect(
      sidebar.locator(`[data-solo-menu-id="${original[0]}"]`).locator(".."),
    ).toHaveCSS("opacity", "1");
  } finally {
    await control.evaluate(({ animate, animations }) => {
      Element.prototype.animate = animate;
      for (const animation of animations)
        if (animation.playState === "paused") animation.finish();
    });
  }
});
