import { pauseClock } from "./clock.mjs";
import { chromium } from "@playwright/test";
import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { animationsSettled } from "./animations.mjs";

let server, origin;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    envDir: false,
    root: fileURLToPath(new URL("../../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
});
test.afterAll(async () => {
  await server?.close();
});

test("the header cancels a pending Huddle and ignores late connection events", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?deferConnection`);
  const header = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  await header
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
    .toBe(1);
  await header
    .getByRole("button", { name: "Cancel Huddle connection" })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.audioClosed))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.closes))
    .toBe(1);
  await expect(
    header.getByRole("button", { name: "Start or join a huddle" }),
  ).toBeVisible();
  await page.evaluate(() => window.huddleFixture.connect());
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Huddle window preview" }),
  ).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "Start or join a huddle" }),
  ).toBeVisible();
  await header.getByRole("button", { name: "Start or join a huddle" }).click();
  await page.getByRole("button", { name: "Start huddle" }).click();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
    .toBe(2);
  await page.evaluate(() => window.huddleFixture.connect());
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toBeVisible();
});

test("connected Huddles keep compact controls beside the default window", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?deferConnection`);
  const header = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  await header
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
    .toBe(1);
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Huddle window preview" }),
  ).toHaveCount(0);
  await expect(page.getByText(/Connecting…|Opening Huddle…/)).toHaveCount(0);
  await page.evaluate(() => window.huddleFixture.connect());
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
  });
  await expect(
    companion.getByRole("img", { name: "Alex", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  const capsule = page.getByRole("group", {
    name: "Active Huddle",
    exact: true,
  });
  await expect(capsule).toBeVisible();
  const launcher = header.getByRole("button", {
    name: "Leave huddle",
    exact: true,
  });
  await expect(launcher).toHaveAttribute("data-icon-variant", "ghost");
  await expect(launcher).not.toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("region", { name: "Huddles", exact: true }),
  ).toHaveCount(0);
  const capsuleHeight = await capsule.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  const searchHeight = await page
    .getByRole("button", { name: "Search Buzz" })
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(capsuleHeight).toBe(searchHeight);
  expect(capsuleHeight).toBe(32);
  const material = (el) => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.backdropFilter, style.boxShadow];
  };
  // The capsule uses the shared glass material; shell icons now use ghost.
  await page.mouse.move(0, 0);
  expect(await capsule.evaluate(material)).toEqual(
    await page.evaluate(() => {
      const reference = document.createElement("div");
      reference.className = "glass-primary";
      document.body.append(reference);
      const style = getComputedStyle(reference);
      const values = [
        style.backgroundColor,
        style.backdropFilter,
        style.boxShadow,
      ];
      reference.remove();
      return values;
    }),
  );
  for (const name of ["Search Buzz", "Mute"]) {
    expect(
      await (name === "Search Buzz" ? page : capsule)
        .getByRole("button", { name, exact: true })
        .locator("svg")
        .evaluate((el) => {
          const box = el.getBoundingClientRect();
          return [box.width, box.height];
        }),
    ).toEqual([16, 16]);
  }

  for (const name of ["Go back", "Go forward", "Your profile"]) {
    expect(
      await page
        .getByRole("button", { name, exact: true })
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(capsuleHeight);
  }
  for (const control of await capsule.getByRole("button").all()) {
    expect(
      await control.evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(32);
  }
  const geometry = await capsule.evaluate((el) => {
    const first = el.querySelector("button");
    const last = el.querySelector("button:last-child");
    const box = el.getBoundingClientRect();
    const padding = getComputedStyle(first);
    return {
      left: first.getBoundingClientRect().left - box.left,
      right: box.right - last.getBoundingClientRect().right,
      gaps: [...el.children]
        .slice(1)
        .map(
          (button) =>
            button.getBoundingClientRect().left -
            button.previousElementSibling.getBoundingClientRect().right,
        ),
      inset: [
        padding.paddingTop,
        padding.paddingRight,
        padding.paddingBottom,
        padding.paddingLeft,
      ],
    };
  });
  expect(geometry).toEqual({
    left: 0,
    right: 0,
    inset: ["4px", "4px", "4px", "8px"],
    gaps: [4, 0, 0, 0],
  });
  const leaveButton = capsule.getByRole("button", {
    name: "Leave huddle",
    exact: true,
  });
  await expect(leaveButton.locator("svg")).toHaveCount(0);
  await expect(leaveButton).toHaveAttribute("data-variant", "destructive");
  await capsule.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(
    capsule.getByRole("button", { name: "Unmute", exact: true }),
  ).toHaveAttribute("data-icon-variant", "ghost");
  await expect(capsule.getByRole("button")).toHaveCount(4);
  await expect(
    capsule.getByRole("button", { name: "Microphone options" }),
  ).toHaveCount(0);
  await expect(
    capsule.getByRole("button", { name: "Leave huddle", exact: true }),
  ).toHaveText("Leave");
  await capsule.getByRole("button", { name: "Unmute", exact: true }).click();
  await expect(
    capsule.getByRole("button", { name: "Mute", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(capsule).toBeVisible();
  expect(await page.evaluate(() => window.huddleFixture.stats.closes)).toBe(0);
  await header.getByRole("button", { name: "Show active Huddle" }).click();
  await expect(capsule).toBeFocused();
  await capsule
    .getByRole("button", { name: "Leave huddle", exact: true })
    .click();
  await expect(capsule).toHaveCount(0);
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioClosed),
  ).toBe(1);
  await header.getByRole("button", { name: "Start or join a huddle" }).click();
  await page.getByRole("button", { name: "Start huddle" }).click();
  await page.evaluate(() => window.huddleFixture.disconnect());
  const notifications = page.getByRole("region", { name: "App notifications" });
  await expect(notifications).toContainText("Huddle disconnected");
  await expect(capsule).toHaveCount(0);
  await notifications
    .getByRole("button", { name: "Dismiss Huddle error" })
    .click();
  await expect(notifications.getByRole("dialog")).toHaveCount(0);
  await header.getByRole("button", { name: "Start or join a huddle" }).click();
  await page.getByRole("button", { name: "Start huddle" }).click();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
    .toBe(3);
  await page.evaluate(() =>
    window.huddleFixture.disconnect(
      "huddle audio unavailable in this deployment",
    ),
  );
  await expect(notifications).toContainText(
    "A relay administrator needs to check its configuration.",
  );
  await expect(notifications).not.toContainText(
    "Try the headphone button again",
  );
  await expect(
    page.getByRole("group", { name: "Huddle error", exact: true }),
  ).toHaveCount(0);
  await expect(notifications).toContainText("Huddle audio unavailable");
  await expect(capsule).toHaveCount(0);
  await notifications
    .getByRole("button", { name: "Dismiss Huddle error" })
    .click();
  await expect(
    notifications.getByText("Huddle audio unavailable", { exact: true }),
  ).toHaveCount(0);
});

test("real capture emits 20ms frames and stops on mute and plugin disposal", async ({
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Chromium supplies a deterministic synthetic microphone",
  );
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (...args) => {
        const stream = await capture(...args);
        window.captureTracks = stream.getAudioTracks();
        return stream;
      };
    });
    await page.goto(`${origin}/tests/fixtures/huddles.html?audio`);
    await page
      .getByRole("button", {
        name: /Start or join a huddle|Join active huddle/,
        exact: true,
      })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.huddleFixture.stats.frames))
      .toBeGreaterThan(5);
    expect(
      await page.evaluate(() => window.huddleFixture.stats.lastFrameLength),
    ).toBe(960);
    const controls = page.getByRole("group", {
      name: "Active Huddle",
      exact: true,
    });
    await controls.getByRole("button", { name: "Mute", exact: true }).click();
    const before = await page.evaluate(() => window.huddleFixture.stats.frames);
    expect(
      await page.evaluate(() =>
        window.captureTracks.every((track) => !track.enabled),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.huddleFixture.stats.frames)).toBe(
      before,
    );
    await controls.getByRole("button", { name: "Unmute", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.huddleFixture.stats.frames))
      .toBeGreaterThan(before);
    await page.evaluate(() => window.huddleFixture.dispose());
    const stopped = await page.evaluate(
      () => window.huddleFixture.stats.frames,
    );
    expect(
      await page.evaluate(() =>
        window.captureTracks.every((track) => track.readyState === "ended"),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.huddleFixture.stats.frames)).toBe(
      stopped,
    );
    expect(
      await page.evaluate(() => window.huddleFixture.stats.audioClosed),
    ).toBe(1);
  } finally {
    await browser.close();
  }
});

// Browser-only geometry and shared controls; native window IPC is covered separately.
test("capsule and companion presentation share mute and leave", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  const panel = page.getByRole("region", { name: "Conversation", exact: true });
  await panel
    .getByRole("button", {
      name: /Start or join a huddle|Join active huddle/,
      exact: true,
    })
    .click();
  const capsule = page.getByRole("group", {
    name: "Active Huddle",
    exact: true,
  });
  await expect(capsule).toBeVisible();
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
  });
  await expect(companion.getByText("Huddle", { exact: true })).toHaveCount(0);
  // Avatar positioning, entry motion, and containment require a rendering engine.
  const roster = companion.getByRole("region", { name: "Huddle participants" });
  const expectNamesClear = async () => {
    await expect
      .poll(() =>
        roster.evaluate((el) => {
          const boxes = [
            ...el.querySelectorAll("[data-self], [data-participant]"),
          ].map((person) => ({
            avatar: person.getBoundingClientRect(),
            name: person.querySelector("[data-name]").getBoundingClientRect(),
            shown: person.dataset.nameActive === "true",
          }));
          const overlaps = (a, b) =>
            a.left < b.right &&
            a.right > b.left &&
            a.top < b.bottom &&
            a.bottom > b.top;
          const touchesAvatar = (name, avatar) => {
            const x = avatar.left + avatar.width / 2;
            const y = avatar.top + avatar.height / 2;
            const dx = x - Math.max(name.left, Math.min(name.right, x));
            const dy = y - Math.max(name.top, Math.min(name.bottom, y));
            return Math.hypot(dx, dy) < avatar.width / 2;
          };
          return boxes
            .flatMap((a, i) =>
              boxes.flatMap((b, j) =>
                i === j || !a.shown
                  ? []
                  : [
                      touchesAvatar(a.name, b.avatar),
                      b.shown && overlaps(a.name, b.name),
                    ],
              ),
            )
            .filter(Boolean).length;
        }),
      )
      .toBe(0);
  };

  const keys = ["ab", "cd", "de", "ef", "fa", "bc"].map((key) =>
    key.repeat(32),
  );
  for (const count of [1, 2, 3, 6]) {
    await page.evaluate(
      (keys) => window.huddleFixture.participants(keys),
      keys.slice(0, count),
    );
    await expect(roster.locator("[data-participant]")).toHaveCount(count - 1);
    // Motion cancels an animation it replaces, which rejects its finished
    // promise; wait until none is still running.
    await roster.evaluate(async (el) => {
      const running = () =>
        el
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running");
      while (running().length)
        await Promise.allSettled(
          running().map((animation) => animation.finished),
        );
    });
    // A spring can briefly cross its final size before overshooting, and
    // Motion can put a sub-pixel transform back on a settled avatar for a
    // frame or two. Measure in the frame that shows no avatar transform, not
    // a later one; a separate poll could pass and the snapshot still land on
    // such a frame.
    let geometry;
    await expect
      .poll(
        async () => {
          geometry = await roster.evaluate((el) => {
            if (
              [...el.querySelectorAll("[data-huddle-avatar]")].some(
                (avatar) => getComputedStyle(avatar).transform !== "none",
              )
            )
              return null;
            const area = el.getBoundingClientRect();
            const bounds = (node) => {
              const rect = node.getBoundingClientRect();
              return {
                left: rect.left - area.left,
                top: rect.top - area.top,
                right: rect.right - area.left,
                bottom: rect.bottom - area.top,
                center: rect.left + rect.width / 2 - area.left,
              };
            };
            return {
              width: area.width,
              height: area.height,
              self: bounds(el.querySelector("[data-self]")),
              portraitGaps: [
                ...el.querySelectorAll("[data-self], [data-participant]"),
              ].map((person) =>
                Math.abs(
                  person.getBoundingClientRect().height -
                    person
                      .querySelector("[data-huddle-avatar]")
                      .getBoundingClientRect().height,
                ),
              ),
              peers: [...el.querySelectorAll("[data-participant]")].map(bounds),
            };
          });
          return geometry !== null;
        },
        { message: "every huddle avatar settles with no transform" },
      )
      .toBe(true);
    const portraits = [geometry.self, ...geometry.peers];
    if (portraits.length > 3) {
      expect(geometry.self.center).toBeCloseTo(geometry.width / 2, 0);
      expect((geometry.self.top + geometry.self.bottom) / 2).toBeCloseTo(
        geometry.height / 2,
        0,
      );
    } else {
      expect(
        (Math.min(...portraits.map((p) => p.left)) +
          Math.max(...portraits.map((p) => p.right))) /
          2,
      ).toBeCloseTo(geometry.width / 2, 0);
      expect(
        (Math.min(...portraits.map((p) => p.top)) +
          Math.max(...portraits.map((p) => p.bottom))) /
          2,
      ).toBeCloseTo(geometry.height / 2, 0);
    }
    expect(geometry.portraitGaps.every((gap) => gap < 0.1)).toBe(true);
    await expectNamesClear();
    for (const bubble of [geometry.self, ...geometry.peers]) {
      expect(bubble.left).toBeGreaterThanOrEqual(0);
      expect(bubble.top).toBeGreaterThanOrEqual(0);
      expect(bubble.right).toBeLessThanOrEqual(geometry.width);
      expect(bubble.bottom).toBeLessThanOrEqual(geometry.height);
    }
  }
  await expect(
    roster.getByRole("img", { name: "Alex", exact: true }).locator("img"),
  ).toHaveAttribute("data-loaded", "true");
  await expect(roster.locator('[data-name-active="true"]')).toHaveCount(0);
  const alex = roster.locator(`[data-participant="${keys[1]}"]`);
  const jo = roster.locator(`[data-participant="${keys[3]}"]`);
  const original = await alex.boundingBox();
  const neighbor = await jo.boundingBox();
  await alex.hover();
  await expect(alex.locator("[data-name]")).toHaveCSS("opacity", "1");
  await expect(roster.locator('[data-name-active="true"]')).toHaveCount(1);
  await expectNamesClear();
  await expect
    .poll(async () => (await jo.boundingBox()).y)
    .toBeCloseTo(neighbor.y, 0);
  expect((await alex.boundingBox()).y).toBeCloseTo(original.y, 0);
  await page.mouse.move(0, 0);
  await expect(alex.locator("[data-name]")).toHaveCSS("opacity", "0");
  await jo.focus();
  await expect(jo.locator("[data-name]")).toHaveCSS("opacity", "1");
  await expectNamesClear();
  await page.keyboard.press("Escape");
  await expect(jo.locator("[data-name]")).toHaveCSS("opacity", "0");

  await roster.evaluate((el) => {
    el.addEventListener("transitionrun", (event) => {
      if (event.propertyName === "opacity")
        el.setAttribute("data-arrival-motion", "true");
    });
  });
  const largeRoster = [
    ...keys,
    ...["01", "02", "03", "04", "05", "06"].map((key) => key.repeat(32)),
  ];
  await page.evaluate(
    (keys) => window.huddleFixture.participants(keys),
    largeRoster,
  );
  await expect(roster.locator("[data-participant]")).toHaveCount(10);
  await expect(
    roster.getByRole("img", { name: /^1 more participants:/ }),
  ).toBeVisible();
  // Hold the 220ms speaking lifetime while checking its rendered contract.
  await pauseClock(page, 1000);
  await page.evaluate(() => window.huddleFixture.speak("cd".repeat(32)));
  const speaker = roster.locator(`[data-participant="${"cd".repeat(32)}"]`);
  const speakerHalo = roster.locator(`[data-speaker="${"cd".repeat(32)}"]`);
  await expect(speakerHalo).toHaveAttribute("data-speaking", "true");
  // The glow reuses the actual portrait, including the shared image loader.
  await expect(speakerHalo.locator("img")).toHaveAttribute(
    "data-loaded",
    "true",
  );
  expect(await speakerHalo.locator("img").getAttribute("src")).toBe(
    await speaker.getByRole("img").locator("img").getAttribute("src"),
  );
  await expect(roster.locator('[data-speaking="true"]')).toHaveCount(1);
  await expect(
    speaker.getByRole("img", { name: "Alex, speaking", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(300);
  await expect(speakerHalo).toHaveAttribute("data-speaking", "false");
  await page.clock.resume();
  await expect(roster).toHaveAttribute("data-arrival-motion", "true");
  await expectNamesClear();
  await companion.evaluate((el) => {
    el.style.width = "360px";
    el.style.height = "400px";
  });
  await expectNamesClear();
  // At the narrow host size, all five controls remain aligned and inside padding.
  const controls = await companion
    .locator("footer button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          centerY: rect.top + rect.height / 2,
        };
      }),
    );
  const shell = await companion.locator("main").boundingBox();
  expect(controls).toHaveLength(5);
  for (const control of controls) {
    expect(control.left).toBeGreaterThan(shell.x);
    expect(control.right).toBeLessThan(shell.x + shell.width);
    expect(Math.abs(control.centerY - controls[2].centerY)).toBeLessThan(1);
  }
  for (let i = 1; i < controls.length; i++)
    expect(controls[i].left).toBeGreaterThanOrEqual(controls[i - 1].right);
  for (const person of await roster.locator("[data-participant]").all()) {
    await person.hover();
    await expect(person.locator("[data-name]")).toHaveCSS("opacity", "1");
    await expectNamesClear();
    await page.mouse.move(0, 0);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.huddleFixture.speak("cd".repeat(32)));
  await expect(speakerHalo).toHaveCSS("transform", "none");
  await page.evaluate(
    (keys) => window.huddleFixture.participants(keys),
    keys.slice(0, 1),
  );
  await expect(roster.locator("[data-participant]")).toHaveCount(0);
  await page.evaluate((keys) => window.huddleFixture.participants(keys), keys);
  await expect(roster.locator("[data-participant]")).toHaveCount(5);
  expect(
    await roster.evaluate((el) => el.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await companion.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(
    capsule.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await companion
    .getByRole("button", { name: "Minimize Huddle to compact controls" })
    .click();
  await expect(companion).toHaveCount(0);
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioClosed),
  ).toBe(0);
  await capsule
    .getByRole("button", { name: "Open Huddle window for Design" })
    .click();
  await expect(capsule).toBeVisible();
  await expect(
    companion.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  await expect(
    capsule.getByRole("button", { name: "Unmute", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(capsule).toBeVisible();
  await page.setViewportSize({ width: 480, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capsule
    .getByRole("button", { name: "Leave huddle", exact: true })
    .click();
  await expect(capsule).toHaveCount(0);
  await expect(companion).toHaveCount(0);
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioClosed),
  ).toBe(1);
});

// Real CSS transitions, overlap, and shell geometry need a rendering engine.
test("live participant avatars enter on top and reflow without growing the shell", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  const capsule = page.getByRole("group", {
    name: "Active Huddle",
    exact: true,
  });
  const stack = capsule.getByRole("img", {
    name: "In this Huddle: Kenneth, Alex",
  });
  await expect(stack).toBeVisible();
  expect(
    await stack.evaluate(
      (el) =>
        el.getBoundingClientRect().left -
        el.previousElementSibling.getBoundingClientRect().right,
    ),
  ).toBe(8);
  await expect(capsule.getByText("Design", { exact: true })).toHaveCount(0);
  await expect(stack.locator("img")).toHaveAttribute("data-loaded", "true");
  await stack.evaluate((el) => {
    el.addEventListener("transitionrun", (event) => {
      if (event.propertyName === "transform")
        el.setAttribute("data-arrival-motion", "true");
    });
  });
  await page.getByRole("button", { name: "Simulate someone joining" }).click();
  const updated = capsule.getByRole("img", {
    name: "In this Huddle: Kenneth, Alex, Sam",
  });
  await expect(updated).toHaveAttribute("data-arrival-motion", "true");
  const avatars = updated.locator("[data-participant]");
  await expect(avatars).toHaveCount(3);
  // Wait for the actual transition lifecycle, not an arbitrary sleep.
  await animationsSettled(updated, { subtree: true });
  const positions = await avatars.evaluateAll((elements) =>
    elements.map((el) => ({
      left: el.getBoundingClientRect().left,
      right: el.getBoundingClientRect().right,
      z: Number(getComputedStyle(el).zIndex),
      opacity: getComputedStyle(el).opacity,
    })),
  );
  expect(positions[2].left).toBeLessThan(positions[1].right);
  expect(positions[2].z).toBeGreaterThan(positions[1].z);
  expect(positions[2].opacity).toBe("1");
  for (let i = 0; i < 3; i++)
    await page
      .getByRole("button", { name: "Simulate someone joining" })
      .click();
  const overflow = capsule.locator("[data-avatar-overflow]");
  await expect(overflow).toHaveText("+2");
  await expect(overflow).toBeVisible();
  expect(
    await overflow.evaluate((el) => {
      const avatar = el.previousElementSibling;
      return {
        rightmost:
          el.getBoundingClientRect().right ===
          el.parentElement.getBoundingClientRect().right,
        inFront:
          Number(getComputedStyle(el).zIndex) >
          Number(getComputedStyle(avatar).zIndex),
      };
    }),
  ).toEqual({ rightmost: true, inFront: true });
  const avatarStyle = (el) => {
    const style = getComputedStyle(el.querySelector(".buzz-avatar"));
    return [style.backgroundColor, style.color, style.borderRadius];
  };
  expect(await overflow.evaluate(avatarStyle)).toEqual(
    await capsule.locator("[data-participant]").last().evaluate(avatarStyle),
  );
  await expect(capsule.locator("[data-participant]")).toHaveCount(4);
  expect(
    await capsule.evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(32);
  await page.getByRole("button", { name: "Simulate someone leaving" }).click();
  await expect(capsule.getByText("+1", { exact: true })).toBeVisible();
  await expect(
    capsule.locator(`[data-participant="${"bc".repeat(32)}"]`),
  ).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Simulate someone joining" }).click();
  const newest = capsule.locator(`[data-participant="${"bc".repeat(32)}"]`);
  await expect(newest).toBeVisible();
  expect(
    await newest.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
  await page.setViewportSize({ width: 480, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

// Covers portal focus, split-control hit targets and channel-scoped presentation.
test("active chat has a split Huddle menu for members and a join-path link", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          document.documentElement.dataset.copiedLink = text;
        },
      },
    });
  });
  await page
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  const active = page.getByRole("group", {
    name: "Active Huddle in this chat",
    exact: true,
  });
  await expect(active).toBeVisible();
  await active.getByRole("button", { name: "Huddle options" }).click();
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Link copied" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.dataset.copiedLink),
  ).toBe("buzz://channel/00000000-0000-4000-8000-000000000001");
  await page.getByRole("menuitem", { name: "Add someone" }).click();
  await expect(
    page.getByRole("dialog", { name: "Huddle members" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(
    page.getByRole("heading", { name: "Alex", exact: true }),
  ).toBeVisible();
  await expect(active).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await active.getByRole("button", { name: "Huddle options" }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }),
  );
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t copy");
  await page.keyboard.press("Escape");
  await expect(
    active.getByRole("button", { name: "Huddle options" }),
  ).toBeFocused();
  const leave = active.getByRole("button", {
    name: "Leave huddle",
    exact: true,
  });
  await page.mouse.move(0, 0);
  await expect(leave.locator("svg").first()).toHaveCSS("opacity", "1");
  await expect(leave.locator("svg").last()).toHaveCSS("opacity", "0");
  await leave.hover();
  await expect(leave.locator("svg").first()).toHaveCSS("opacity", "0");
  await expect(leave.locator("svg").last()).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await leave.focus();
  await expect(leave.locator("svg").last()).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(active).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioClosed),
  ).toBe(1);
  // A DM call opens the room picker, leaving DM membership unchanged.
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await page.getByRole("button", { name: "Start or join a huddle" }).click();
  await page.getByRole("button", { name: "Start huddle" }).click();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  await active.getByRole("button", { name: "Huddle options" }).click();
  await page.getByRole("menuitem", { name: "Add someone" }).click();
  await expect(
    page.getByRole("dialog", { name: "Huddle members" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog", { name: "Huddle members" })
      .getByRole("banner")
      .getByText(
        "People added here can join this Huddle and its thread. The original chat stays private.",
      ),
  ).toBeVisible();
  await expect(
    page.getByText("DM membership cannot be changed here."),
  ).toHaveCount(0);
});

// Browser integration: a failed lifecycle read still permits the card-to-call
// journey, and leaving that call opens the same room in the saved panel.
test("lifecycle read errors preserve Join and later View for active calls", async ({
  page,
}) => {
  await page.goto(
    `${origin}/tests/fixtures/huddles.html?chrome&lifecycleReadError`,
  );
  const card = page.getByRole("region", { name: "Huddle", exact: true });
  await card.getByRole("button", { name: "Join", exact: true }).click();
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
    exact: true,
  });
  await expect(companion).toBeVisible();
  await companion
    .getByRole("button", { name: "Leave huddle", exact: true })
    .click();
  const ended = page.getByRole("region", { name: "Huddle ended", exact: true });
  await expect(ended).toHaveCount(1);
  await ended.getByRole("button", { name: "View", exact: true }).click();
  await expect(
    page
      .getByRole("complementary", { name: "Saved Huddle conversation" })
      .getByText("Let’s keep our notes here while we talk."),
  ).toBeVisible();
});

// Browser boundary: the separate presentation expands without crowding the call,
// retains its draft across tab switching, and shares the room with the saved panel.
test("Huddle chat expands beside the call and stays separate from Live transcript", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome&legacyRoom`);
  const card = page.getByRole("region", { name: "Huddle", exact: true });
  await expect(
    card.getByRole("button", { name: "Join", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "View", exact: true }),
  ).toHaveCount(0);
  await card.getByRole("button", { name: "Join", exact: true }).click();
  await expect(
    card.getByRole("img", {
      name: "In this Huddle: Kenneth, Alex",
      exact: true,
    }),
  ).toBeVisible();
  await expect(card.getByText(/\d+ participants?/)).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Open", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "View", exact: true }),
  ).toHaveCount(0);
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
    exact: true,
  });
  await companion
    .getByRole("button", { name: "Huddle chat", exact: true })
    .click();
  const panel = companion.getByRole("complementary", {
    name: "Huddle chat panel",
    exact: true,
  });
  await expect(
    panel.getByText("Let’s keep our notes here while we talk."),
  ).toBeVisible();
  const portrait = await panel.locator("img").boundingBox();
  expect(portrait.width).toBeLessThanOrEqual(32);
  const composer = panel.getByRole("textbox", { name: "Message this Huddle" });
  await composer.fill("Follow up after this call");
  await panel
    .getByRole("tab", { name: "Live transcript", exact: true })
    .click();
  await expect(
    panel.getByRole("heading", { name: "No live transcript", exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveCount(0);
  await panel.getByRole("tab", { name: "Thread", exact: true }).click();
  await expect(composer).toHaveText("Follow up after this call");
  await composer.press("Enter");
  await expect(
    panel
      .getByRole("log", { name: "Huddle messages" })
      .getByText("Follow up after this call", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveText("");
  const callBounds = await companion.getByRole("main").boundingBox();
  const panelBounds = await panel.boundingBox();
  expect(panelBounds.x).toBeGreaterThanOrEqual(
    callBounds.x + callBounds.width - 1,
  );
  const inputBounds = await composer.boundingBox();
  expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(
    panelBounds.y + panelBounds.height,
  );
  await expect(
    panel.getByRole("button", { name: "Close Huddle chat" }),
  ).toHaveCount(0);
  expect(
    await panel.evaluate((el) => {
      const style = getComputedStyle(el);
      return { corners: style.borderRadius, shadow: style.boxShadow };
    }),
  ).toEqual({ corners: "0px", shadow: "none" });
  await companion
    .getByRole("button", { name: "Huddle chat", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(companion).toBeVisible();
  await companion
    .getByRole("button", { name: "Leave huddle", exact: true })
    .click();
  await expect(companion).toHaveCount(0);
  await expect(page.getByText("Huddle ended", { exact: true })).toBeVisible();
  const endedCard = page.getByRole("region", {
    name: "Huddle ended",
    exact: true,
  });
  await expect(endedCard).toHaveCount(1);
  await expect(
    endedCard.getByRole("button", { name: "Join", exact: true }),
  ).toHaveCount(0);
  await expect(
    endedCard.getByRole("button", { name: "Open", exact: true }),
  ).toHaveCount(0);
  await endedCard.getByRole("button", { name: "View", exact: true }).click();
  const saved = page.getByRole("complementary", {
    name: "Saved Huddle conversation",
  });
  await expect(
    saved.getByText("Follow up after this call", { exact: true }),
  ).toBeVisible();
  await expect(
    saved.getByText("This Huddle conversation is read-only."),
  ).toBeVisible();
});

test("incoming Huddles appear without joining and follow the viewed conversation", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await expect(
    page.getByRole("button", {
      name: "Join active huddle (1 participant)",
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.huddleFixture.stats.opens)).toBe(0);
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(
    page.getByRole("button", {
      name: "Join active huddle (1 participant)",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start or join a huddle", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await page
    .getByRole("button", {
      name: "Join active huddle (1 participant)",
      exact: true,
    })
    .click();
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
    exact: true,
  });
  await companion
    .getByRole("button", { name: "Leave huddle", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start or join a huddle", exact: true }),
  ).toBeVisible();
});

test("detached regular composer keeps failed drafts, uploads real file bytes and preserves duplicate attachments", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const scope = `https://fixture.example:${"ab".repeat(32)}`;
    const key = `buzz-view.v1:${JSON.stringify([scope, "draft:00000000-0000-4000-8000-000000000002"])}`;
    localStorage.setItem(
      key,
      JSON.stringify({ text: "Draft from the main panel", recipients: [] }),
    );
  });
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
    exact: true,
  });
  await companion
    .getByRole("button", { name: "Huddle chat", exact: true })
    .click();
  const editor = companion.getByRole("textbox", {
    name: "Message this Huddle",
  });
  await expect(editor).toHaveText("Draft from the main panel");
  await editor.fill("reject this message");
  await editor.press("Enter");
  await expect(
    page.getByText("Fixture rejected this message. Your draft is kept.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(editor).toHaveText("reject this message");
  await expect(editor).toBeFocused();
  await editor.fill("With attachments");
  const file = {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Huddle attachment bytes"),
  };
  await companion
    .getByLabel("Choose attachments")
    .setInputFiles([file, file, { ...file, name: "renamed.txt" }]);
  await expect(
    companion
      .getByRole("region", { name: "Attachments" })
      .getByRole("listitem"),
  ).toHaveCount(3);
  // Main now uploads eagerly; observe completion before removing one duplicate.
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.uploads.length))
    .toBe(3);
  await companion
    .getByRole("button", { name: "Remove notes.txt", exact: true })
    .first()
    .click();
  await editor.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const scope = `https://fixture.example:${"ab".repeat(32)}`;
        return JSON.parse(
          localStorage.getItem(
            `buzz-view.v1:${JSON.stringify([scope, "draft:00000000-0000-4000-8000-000000000002"])}`,
          ),
        );
      }),
    )
    .toEqual({ text: "", recipients: [] });
  await expect(editor).toHaveText("");
  await expect(editor).toBeFocused();
  const sent = await page.evaluate(() => window.huddleFixture.stats.sent);
  expect(sent.at(-1).attachments.map((file) => file.name)).toEqual([
    "notes.txt",
    "renamed.txt",
  ]);
  expect(await page.evaluate(() => window.huddleFixture.stats.uploads)).toEqual(
    [
      { name: "notes.txt", text: "Huddle attachment bytes" },
      { name: "notes.txt", text: "Huddle attachment bytes" },
      { name: "renamed.txt", text: "Huddle attachment bytes" },
    ],
  );
  await editor.fill("**Shared image**");
  await companion.getByLabel("Choose attachments").setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: await readFile(
      new URL("../fixtures/design-system/assets/avatar.png", import.meta.url),
    ),
  });
  await expect(
    companion
      .getByRole("region", { name: "Attachments" })
      .getByRole("listitem"),
  ).toHaveCount(1);
  await editor.press("Enter");
  const expectAttachments = async (surface) => {
    await expect(
      surface.getByRole("link", { name: "Open notes.txt", exact: true }),
    ).toHaveAttribute("href", /https:\/\/fixture.example\/media\//);
    await expect(
      surface.getByRole("link", { name: "Open renamed.txt", exact: true }),
    ).toBeVisible();
    await expect(
      surface.locator("strong", { hasText: "Shared image" }),
    ).toBeVisible();
    const image = surface.getByRole("link", {
      name: "Open image attachment",
      exact: true,
    });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image
          .locator("img")
          .evaluate((img) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    await image.focus();
    await image.press("Enter");
    const preview = page.getByRole("dialog", {
      name: "photo.png",
      exact: true,
    });
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        preview
          .locator("img[data-review-media]")
          .evaluate((img) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    await preview.getByRole("button", { name: "Close", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(image).toBeFocused();
  };
  await expectAttachments(companion);
  await companion
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  // This offline fixture cannot search the community directory. Wait for its
  // terminal state so the error row cannot shift the target during the click.
  await expect(
    page.getByText("Could not search community people. Retry to refresh.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button")
    .and(page.locator(`[data-mention-choice="${"cd".repeat(32)}"]`))
    .click();
  // The host picker delivers the selection to the companion asynchronously.
  await expect(
    companion.getByRole("button", {
      name: `Remove mention Alex ${"cd".repeat(32)}`,
      exact: true,
    }),
  ).toBeVisible();
  await editor.press("End");
  await editor.pressSequentially(" hello");
  await editor.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => window.huddleFixture.stats.sent.at(-1).mentions),
    )
    .toEqual(["cd".repeat(32)]);
  await companion
    .getByRole("button", { name: "Emoji and GIFS", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Emoji picker" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await companion
    .getByRole("button", { name: "Leave huddle", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Huddle ended", exact: true })
    .getByRole("button", { name: "View", exact: true })
    .click();
  await expectAttachments(
    page.getByRole("complementary", { name: "Saved Huddle conversation" }),
  );
});

test("drawer resize before its view update keeps avatars stationary and unchanged window sizes remain toggleable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
    exact: true,
  });
  const avatar = companion.getByRole("img", { name: "Alex", exact: true });
  const chat = companion.getByRole("button", {
    name: "Huddle chat",
    exact: true,
  });
  await expect(avatar).toBeVisible();
  await expect
    .poll(async () => (await avatar.boundingBox()).width)
    .toBeGreaterThan(50);

  const original = await avatar.boundingBox();
  for (let toggle = 1; toggle <= 2; toggle++) {
    await page.evaluate(() => window.huddleFixture.holdLayout());
    await chat.click();
    await expect
      .poll(() => page.evaluate(() => window.huddleFixture.stats.layoutWaiting))
      .toBe(toggle);
    const during = await avatar.boundingBox();
    expect(Math.abs(during.x - original.x)).toBeLessThan(1);
    expect(Math.abs(during.y - original.y)).toBeLessThan(1);
    await page.evaluate(() => window.huddleFixture.releaseLayout());
    await expect(chat).toHaveAttribute("aria-expanded", String(toggle === 1));
    const after = await avatar.boundingBox();
    expect(Math.abs(after.x - original.x)).toBeLessThan(1);
    expect(Math.abs(after.y - original.y)).toBeLessThan(1);
  }
  await page.evaluate(() => window.huddleFixture.fixedWindow(true));
  await chat.click();
  await expect(chat).toHaveAttribute("aria-expanded", "true");
  await chat.click();
  await expect(chat).toHaveAttribute("aria-expanded", "false");
});

test("DM requests share window and capsule controls without capturing audio until Join", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page
    .getByRole("button", { name: "Simulate incoming DM Huddle" })
    .click();
  const capsule = page.getByRole("group", {
    name: "Huddle request",
    exact: true,
  });
  const request = page.getByRole("main", {
    name: "Incoming Huddle request",
    exact: true,
  });
  await expect(capsule).toBeVisible();
  await expect(request).toBeVisible();
  await expect(
    request.getByRole("img", { name: "Alex", exact: true }),
  ).toBeVisible();
  await expect(
    capsule.getByRole("img", { name: "In this Huddle: Alex", exact: true }),
  ).toBeVisible();
  await expect(
    request.getByRole("button", { name: "Join", exact: true }),
  ).toBeVisible();
  await expect(
    capsule.getByRole("button", { name: "Decline", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioOpened),
  ).toBe(0);
  await expect(
    capsule.getByText("Alex calling", { exact: true }),
  ).toBeVisible();
  expect(
    await capsule
      .getByRole("button", { name: "Open Huddle request" })
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return [style.paddingLeft, style.paddingTop, style.paddingBottom];
      }),
  ).toEqual(["4px", "4px", "4px"]);
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const surface of [request, capsule]) {
      const join = await surface
        .getByRole("button", { name: "Join", exact: true })
        .boundingBox();
      const decline = await surface
        .getByRole("button", { name: "Decline", exact: true })
        .boundingBox();
      expect(Math.abs(join.width - decline.width)).toBeLessThan(1);
      // The compact prompt retains solid call colors; the window uses glass icons.
      if (surface === request) continue;
      for (const [name, tone] of [
        ["Join", "join"],
        ["Decline", "decline"],
      ]) {
        const colors = () =>
          surface
            .getByRole("button", { name, exact: true })
            .evaluate((el, tone) => {
              const actual = getComputedStyle(el);
              const probe = document.createElement("span");
              probe.style.backgroundColor = `var(--affordance-call-${tone})`;
              probe.style.color = "var(--text-inverse)";
              el.append(probe);
              const expected = getComputedStyle(probe);
              const result = [
                actual.backgroundColor,
                expected.backgroundColor,
                actual.color,
                expected.color,
              ];
              probe.remove();
              return result;
            }, tone);
        await expect
          .poll(async () => {
            const [fill, expectedFill, text, expectedText] = await colors();
            return fill === expectedFill && text === expectedText;
          })
          .toBe(true);
        expect((await colors())[0]).toMatch(/^rgb\(/); // Opaque even over glass.
      }
    }
  }
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "light";
  });
  await expect(
    request.getByText("Alex is calling", { exact: true }),
  ).toBeVisible();
  await expect(
    request.getByText("Huddle request", { exact: true }),
  ).toHaveCount(0);
  await request
    .getByRole("button", { name: "Minimize Huddle request" })
    .click();
  await expect(request).toHaveCount(0);
  await expect(capsule).toBeVisible();
  await capsule.getByRole("button", { name: "Open Huddle request" }).click();
  await expect(request).toBeVisible();
  await request.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(capsule).toHaveCount(0);
  await expect(request).toHaveCount(0);
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioOpened),
  ).toBe(0);
  // A fresh renderer is a new local request lifetime; join from its compact prompt.
  await page.reload();
  await page
    .getByRole("button", { name: "Simulate incoming DM Huddle" })
    .click();
  await expect(request).toBeVisible();
  await capsule.getByRole("button", { name: "Join", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toBeVisible();
  await expect(request).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "Active Huddle", exact: true })
      .getByRole("button", { name: "Mute", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioOpened),
  ).toBe(1);
});

test("window Join and compact Decline operate on the same incoming request", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  const trigger = page.getByRole("button", {
    name: "Simulate incoming DM Huddle",
  });
  const capsule = page.getByRole("group", {
    name: "Huddle request",
    exact: true,
  });
  const request = page.getByRole("main", {
    name: "Incoming Huddle request",
    exact: true,
  });
  await trigger.click();
  await expect(request).toBeVisible();
  await capsule.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(request).toHaveCount(0);
  await expect(capsule).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Search Buzz", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioOpened),
  ).toBe(0);
  await page.reload();
  await trigger.click();
  await request.getByRole("button", { name: "Join", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toBeVisible();
  await expect(request).toHaveCount(0);
  await expect(
    page
      .getByRole("complementary", { name: "Huddle window preview" })
      .getByRole("button", { name: "Mute", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioOpened),
  ).toBe(1);
  // Real focus teardown: both request surfaces must retain a usable target when
  // a pending microphone connection is cancelled or fails.
  for (const surface of [request, capsule]) {
    for (const outcome of ["cancel", "error"]) {
      await page.goto(
        `${origin}/tests/fixtures/huddles.html?chrome&deferConnection`,
      );
      await trigger.click();
      await surface
        .getByRole("button", { name: "Join", exact: true })
        .press("Enter");
      const cancel = surface.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      await expect(cancel).toBeFocused();
      await expect
        .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
        .toBe(1);
      if (outcome === "cancel") await cancel.press("Enter");
      else
        await page.evaluate(() =>
          window.huddleFixture.disconnect("Microphone disconnected"),
        );
      if (outcome === "cancel") {
        await expect(request).toHaveCount(0);
        await expect(capsule).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Search Buzz", exact: true }),
        ).toBeFocused();
      } else {
        await expect(request.getByRole("alert")).toHaveText(
          "Microphone disconnected",
        );
        await expect(capsule.getByRole("alert")).toHaveText(
          "Microphone disconnected",
        );
        // Both views remain retryable; the companion owns focus after reopening.
        await expect(
          request.getByRole("button", { name: "Join", exact: true }),
        ).toBeFocused();
      }
    }
  }
  // A pending request no longer owns keyboard focus after the user moves away.
  await page.goto(
    `${origin}/tests/fixtures/huddles.html?chrome&deferConnection`,
  );
  await trigger.click();
  await request
    .getByRole("button", { name: "Minimize Huddle request" })
    .click();
  await capsule
    .getByRole("button", { name: "Join", exact: true })
    .press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
    .toBe(1);
  const elsewhere = page.getByRole("button", {
    name: "Search Buzz",
    exact: true,
  });
  await elsewhere.focus();
  await page.evaluate(() =>
    window.huddleFixture.disconnect("Microphone disconnected"),
  );
  await expect(capsule.getByRole("alert")).toHaveText(
    "Microphone disconnected",
  );
  await expect(elsewhere).toBeFocused();
  await expect(request).toHaveCount(0);
});

// Real media decoding and autoplay need a browser; fake-clock unit tests cover the exact gap.
test("incoming ring plays the Pow clip repeatedly and stops on decline", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page
    .getByRole("button", { name: "Simulate incoming DM Huddle" })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.ringPlays))
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.ringEnds))
    .toBeGreaterThanOrEqual(1);
  await page
    .getByRole("group", { name: "Huddle request", exact: true })
    .getByRole("button", { name: "Decline", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.ringPaused))
    .toBeGreaterThanOrEqual(1);
  await expect(
    page.getByRole("main", { name: "Incoming Huddle request" }),
  ).toHaveCount(0);
});

// Shared-layout motion needs real layout and frames across both mounted surfaces.
test("accepting preserves both request avatars until connected, then moves them into the call", async ({
  page,
}) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(
    `${origin}/tests/fixtures/huddles.html?chrome&deferConnection`,
  );
  await page
    .getByRole("button", { name: "Simulate incoming DM Huddle" })
    .click();
  const request = page.getByRole("main", { name: "Incoming Huddle request" });
  const capsule = page.getByRole("group", {
    name: "Huddle request",
    exact: true,
  });
  await expect
    .poll(() =>
      request
        .locator("[data-huddle-avatar]")
        .evaluate((el) => getComputedStyle(el).transform),
    )
    .toBe("none");
  const originBox = await request
    .getByRole("img", { name: "Alex", exact: true })
    .boundingBox();
  await capsule
    .getByRole("button", { name: "Join", exact: true })
    .press("Enter");
  await expect(
    capsule.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await expect(request).toBeVisible();
  await expect(capsule).toBeVisible();
  await expect(
    request.getByRole("button", { name: "Join", exact: true }),
  ).toBeDisabled();
  await expect(
    capsule.getByRole("button", { name: "Join", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
    .toBe(1);
  await pauseClock(page, 1000);
  await page.evaluate(() => {
    window.huddleMotionFrames = [];
    window.huddleFixture.connect();
    const sample = () => {
      const portraits = [
        ...document.querySelectorAll(
          `[data-huddle-avatar="${"cd".repeat(32)}"]`,
        ),
      ];
      const positions = portraits.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          compact: !!el.closest("#huddle-capsule"),
        };
      });
      window.huddleMotionFrames.push(positions);
      if (window.huddleMotionFrames.length < 40) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (let i = 0; i < 40; i++) await page.clock.runFor(16);
  const frames = await page.evaluate(() => window.huddleMotionFrames);
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toBeVisible();
  await expect(request).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "Active Huddle", exact: true })
      .getByRole("button", { name: "Mute", exact: true }),
  ).toBeFocused();
  // The window portrait travels and resizes rather than appearing at its final spot.
  const compactFrames = frames
    .map((frame) => frame.find((r) => r.compact))
    .filter(Boolean);
  expect(
    new Set(compactFrames.map((r) => Math.round(r.x))).size,
  ).toBeGreaterThan(3);
  const windowFrames = frames
    .map((frame) => frame.find((r) => r.width > 40))
    .filter(Boolean);
  expect(
    new Set(windowFrames.map((r) => Math.round(r.x))).size,
  ).toBeGreaterThan(3);
  expect(
    new Set(windowFrames.map((r) => Math.round(r.width))).size,
  ).toBeGreaterThan(3);
  expect(Math.abs(windowFrames[0].x - originBox.x)).toBeLessThan(
    Math.abs(windowFrames.at(-1).x - originBox.x),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.resume();
  await page.reload();
  await page
    .getByRole("button", { name: "Simulate incoming DM Huddle" })
    .click();
  await request.getByRole("button", { name: "Join", exact: true }).click();
  await expect(
    request.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
    .toBe(1);
  await page.evaluate(() => window.huddleFixture.connect());
  await expect(request).toHaveCount(0);
  expect(
    await page
      .locator("[data-huddle-avatar]")
      .evaluateAll((avatars) =>
        avatars.every((el) => getComputedStyle(el).transform === "none"),
      ),
  ).toBe(true);
});

// Browser proof: the shared popover/Select portals work in each surface and
// companion actions update the main-owned selection without moving the call.
test("audio settings mirror device choices between compact and window controls", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html`);
  await page
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  const capsule = page.getByRole("group", {
    name: "Active Huddle",
    exact: true,
  });
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
  });
  await capsule.getByRole("button", { name: "Audio settings" }).click();
  await page.getByRole("combobox", { name: "Microphone", exact: true }).click();
  await page
    .getByRole("option", { name: "USB microphone", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Audio settings", exact: true }),
  ).toHaveCount(0);
  await companion.getByRole("button", { name: "Audio settings" }).click();
  await expect(
    page.getByRole("combobox", { name: "Microphone", exact: true }),
  ).toContainText("USB microphone");
  await page.getByRole("combobox", { name: "Speakers", exact: true }).click();
  // The popup can flip between a pointer pick's press and release, and Base UI
  // ignores that split click. The microphone pick above covers the pointer.
  await expect(
    page.getByRole("option", { name: "System default", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: "Headphones", exact: true }),
  ).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Audio settings", exact: true }),
  ).toHaveCount(0);
  await capsule.getByRole("button", { name: "Audio settings" }).click();
  await expect(
    page.getByRole("combobox", { name: "Speakers", exact: true }),
  ).toContainText("Headphones");
  await page.keyboard.press("Escape");
  await expect(
    capsule.getByRole("button", { name: "Audio settings" }),
  ).toBeFocused();

  // Real layout: the native minimum width must retain all five controls at 125% text.
  await page.setViewportSize({ width: 408, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await expect
    .poll(() =>
      companion.locator("footer button").evaluateAll((buttons) => {
        const shell = buttons[0].closest("main").getBoundingClientRect();
        const boxes = buttons.map((button) => button.getBoundingClientRect());
        return boxes.every(
          (box, i) =>
            box.left >= shell.left &&
            box.right <= shell.right &&
            boxes.every(
              (other, j) =>
                i === j ||
                box.right <= other.left ||
                box.left >= other.right ||
                box.bottom <= other.top ||
                box.top >= other.bottom,
            ),
        );
      }),
    )
    .toBe(true);
  await companion.getByRole("button", { name: "Audio settings" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Audio settings", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await companion
    .getByRole("button", { name: "Minimize Huddle to compact controls" })
    .focus();
  await expect(
    companion.getByRole("button", {
      name: "Minimize Huddle to compact controls",
    }),
  ).toBeFocused();
});

// Browser coverage owns the shell geometry and actual launcher integration.
test("archived conversations do not offer a Huddle launcher", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?archived`);
  const header = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  await expect(header).toBeVisible();
  await expect(
    header.getByRole("button", {
      name: /Start or join a huddle|Join active huddle/,
    }),
  ).toHaveCount(0);
});

test("long caller names keep compact request controls inside the shell", async ({
  page,
}) => {
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [700, 1200]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(
        `${origin}/tests/fixtures/huddles.html?chrome&longCaller`,
      );
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "125%";
      });
      await page
        .getByRole("button", { name: "Simulate incoming DM Huddle" })
        .click();
      const capsule = page.getByRole("group", {
        name: "Huddle request",
        exact: true,
      });
      await expect(capsule).toBeVisible();
      const name = capsule.getByText(/calling$/);
      expect((await name.textContent()).length).toBeLessThanOrEqual(88);
      expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        true,
      );
      for (const label of ["Join", "Decline"]) {
        const button = capsule.getByRole("button", {
          name: label,
          exact: true,
        });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      await capsule
        .getByRole("button", { name: "Decline", exact: true })
        .click();
      await expect(capsule).toHaveCount(0);
    }
  }
});

test("pending companion attachment send survives a transcript tab switch", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
    exact: true,
  });
  await companion
    .getByRole("button", { name: "Huddle chat", exact: true })
    .click();
  const editor = companion.getByRole("textbox", {
    name: "Message this Huddle",
  });
  await page.evaluate(() => window.huddleFixture.holdUpload());
  try {
    await editor.fill("Pending upload");
    await companion.getByLabel("Choose attachments").setInputFiles({
      name: "held.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("held bytes"),
    });
    await expect
      .poll(() => page.evaluate(() => window.huddleFixture.stats.uploadWaiting))
      .toBe(1);
    await editor.press("Enter");
    await companion
      .getByRole("tab", { name: "Live transcript", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await companion.getByRole("tab", { name: "Thread", exact: true }).click();
  } finally {
    await page.evaluate(() => window.huddleFixture.releaseUpload());
  }
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.sent.length))
    .toBe(1);
  await expect(editor).toBeEmpty();
});

test("an inactive call error does not suppress the next incoming call", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  await page.evaluate(() =>
    window.huddleFixture.disconnect("Previous call failed"),
  );
  await expect(
    page.getByRole("region", { name: "App notifications" }),
  ).toContainText("Previous call failed");
  // The real clip may finish while WebKit renders the request. Freeze the
  // repeat timer so the first-play assertion cannot race the next ring.
  await pauseClock(page, 1000);
  await page.evaluate(() =>
    window.huddleFixture.request("00000000-0000-4000-8000-000000000099"),
  );
  await expect(
    page.getByRole("button", { name: "Join", exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.ringPlays))
    .toBe(1);
});

test("huddle panel finishes its exit before resizing and can reverse a pending close", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
    exact: true,
  });
  const chat = companion.getByRole("button", {
    name: "Huddle chat",
    exact: true,
  });
  await chat.click();
  const dock = companion.locator("[data-panel-dock]");
  await expect(
    companion.getByRole("complementary", { name: "Huddle chat panel" }),
  ).toBeVisible();
  // Hold the actual CSS exit, rather than relying on the test runner beating it.
  await page.evaluate(() => {
    window.heldHuddleExits = [];
    const original = Element.prototype.getAnimations;
    window.huddleGetAnimations = original;
    Element.prototype.getAnimations = function (...args) {
      const animations = original.apply(this, args);
      if (this.matches("[data-panel-dock][data-closing]")) {
        for (const animation of animations) animation.pause();
        window.heldHuddleExits.push(...animations);
      }
      return animations;
    };
  });
  const width = (await companion.boundingBox()).width;
  try {
    await chat.click();
    await expect(dock).toHaveAttribute("inert", "");
    await expect
      .poll(() => page.evaluate(() => window.heldHuddleExits.length))
      .toBeGreaterThan(0);
    expect((await companion.boundingBox()).width).toBe(width);
    await chat.click();
    await expect(dock).not.toHaveAttribute("inert", "");
    await expect(chat).toHaveAttribute("aria-expanded", "true");
    await chat.click();
    await expect(dock).toHaveAttribute("inert", "");
  } finally {
    await page.evaluate(() => {
      Element.prototype.getAnimations = window.huddleGetAnimations;
      for (const animation of window.heldHuddleExits) {
        if (animation.playState !== "idle") animation.finish();
      }
    });
  }
  await expect(dock).toHaveCount(0);
  await expect
    .poll(async () => (await companion.boundingBox()).width)
    .toBeLessThan(width);
  await chat.press("Enter");
  await expect(dock).toBeVisible();
  // A dispatched close cannot be canceled locally: delay its host presentation.
  const waiting = await page.evaluate(
    () => window.huddleFixture.stats.layoutWaiting,
  );
  await page.evaluate(() => window.huddleFixture.holdLayout());
  try {
    await chat.click();
    await expect
      .poll(() => page.evaluate(() => window.huddleFixture.stats.layoutWaiting))
      .toBe(waiting + 1);
    await chat.click();
  } finally {
    await page.evaluate(() => window.huddleFixture.releaseLayout());
  }
  await expect
    .poll(async () => (await companion.boundingBox()).width)
    .toBe(width);
  await expect(chat).toHaveAttribute("aria-expanded", "true");
  await expect(dock).toBeVisible();
  await chat.press("Enter");
  await expect(dock).toHaveCount(0);
});

test("portraits can be tossed within the stage and return home, with reduced motion immediate", async ({
  page,
}) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${origin}/tests/fixtures/huddles.html`);
  await page
    .getByRole("button", { name: /Start or join a huddle|Join active huddle/ })
    .click();
  await page.evaluate(() =>
    window.huddleFixture.participants(["ab".repeat(32)]),
  );
  const stage = page.getByRole("region", { name: "Huddle participants" });
  // Measure the circular layout, not the rotated artwork's rectangular bounding box.
  const portrait = stage.locator("[data-huddle-avatar]");
  await expect(portrait).toBeVisible();
  await pauseClock(page, 1000);
  await expect
    .poll(async () => {
      await page.clock.runFor(16);
      return portrait.evaluate(
        (element) => getComputedStyle(element).transform,
      );
    })
    .toBe("none");
  await animationsSettled(
    portrait.locator("xpath=ancestor-or-self::*[@data-self][1]"),
    { subtree: true },
  );
  const home = await portrait.boundingBox();
  const area = await stage.boundingBox();
  const start = { x: home.x + home.width / 2, y: home.y + home.height / 2 };
  // Release close to the wall so the gesture exercises a collision at this fixture size.
  const throwDistance = Math.round(
    (area.x + area.width - home.x - home.width) * 0.9,
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 3; i++) {
    await page.mouse.move(start.x + (i * throwDistance) / 3, start.y - i * 6);
    await page.clock.runFor(16);
  }
  const dragged = await portrait.boundingBox();
  expect(dragged.x - home.x).toBeCloseTo(throwDistance, 0);
  await page.mouse.up();
  const frames = [];
  for (let i = 0; i < 120; i++) {
    await page.clock.runFor(16);
    const box = await portrait.boundingBox();
    frames.push(box);
    if (i === 12) {
      // Tapping a returning portrait must resume its spring, not snap home.
      expect(Math.abs(box.x - home.x)).toBeGreaterThan(1);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      await page.clock.runFor(16);
      const resumed = await portrait.boundingBox();
      expect(Math.abs(resumed.x - home.x)).toBeGreaterThan(
        Math.abs(box.x - home.x) / 2,
      );
    }
    if (!(await stage.locator("[data-avatar-moving]").count())) break;
  }
  expect(frames.some((box) => box.x > dragged.x + 5)).toBe(true);
  // The throw reaches the wall before reversing and returning to its layout slot.
  expect(
    frames.some((box) => Math.abs(box.x + box.width - area.x - area.width) < 1),
  ).toBe(true);
  for (const box of frames) {
    expect(box.x).toBeGreaterThanOrEqual(area.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(area.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height + 1);
  }
  await expect(stage.locator("[data-avatar-moving]")).toHaveCount(0);
  const resting = await portrait.boundingBox();
  expect(Math.abs(resting.x - home.x)).toBeLessThan(1);
  expect(Math.abs(resting.y - home.y)).toBeLessThan(1);
  // Motion delivers drag-end in postRender, after React handles pointercancel.
  // A cancelled gesture must stay reset through that callback and later frames.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 3; i++) {
    await page.mouse.move(start.x + (i * throwDistance) / 3, start.y);
    await page.clock.runFor(16);
  }
  expect((await portrait.boundingBox()).x - home.x).toBeCloseTo(
    throwDistance,
    0,
  );
  await stage.locator("[data-avatar-moving]").dispatchEvent("pointercancel", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    bubbles: true,
  });
  for (let i = 0; i < 4; i++) {
    await page.clock.runFor(16);
    expect(Math.abs((await portrait.boundingBox()).x - home.x)).toBeLessThan(1);
  }
  await expect(stage.locator("[data-avatar-moving]")).toHaveCount(0);
  await page.mouse.up();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + throwDistance, start.y + 30);
  await page.clock.runFor(32);
  expect((await portrait.boundingBox()).x - home.x).toBeCloseTo(
    throwDistance,
    0,
  );
  await page.mouse.up();
  await page.clock.runFor(16);
  await expect(stage.locator("[data-avatar-moving]")).toHaveCount(0);
  expect(Math.abs((await portrait.boundingBox()).x - home.x)).toBeLessThan(1);
});
