import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

const chat = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-8444-4444-444444444444";
const title =
  "Release planning and follow-up for the next workspace review and the upcoming project launch checklist";
const titleSelector = "[data-solo-chat-title] > [aria-hidden]";

test.use({
  reducedMotion: "no-preference",
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [chat, other],
  channelNames: { [chat]: "Alpha", [other]: "Beta" },
  soloChannels: [chat, other],
  ownSoloChannels: [chat, other],
  historyCounts: { [chat]: 0, [other]: 0 },
});

test("Solo rename animates both titles without interrupting typing or overflowing", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.locator(`[data-solo-destination-id="${chat}"]`);
  await row.click();
  const composer = page.getByRole("textbox", { name: "Message your agents" });
  await expect(composer).toBeFocused();
  const header = (name) =>
    page.locator("header").getByRole("button", {
      name: `Share access to ${name}`,
      exact: true,
    });
  // Hold only the title's real browser animations, then release one phase at a time.
  await page.evaluate(() => {
    window.titleAnimations = new WeakMap();
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.closest("[data-solo-chat-title]")) {
        // Motion sets startTime after animate() returns, which resumes a
        // synchronous pause. Hold the track after Motion has initialized it.
        queueMicrotask(() => {
          animation.pause();
          animation.currentTime = 0;
          const animations = window.titleAnimations.get(this) ?? [];
          animations.push(animation);
          window.titleAnimations.set(this, animations);
        });
      }
      return animation;
    };
  });
  const rename = (name) =>
    app.setChannelMetadata(chat, [
      ["name", name],
      ["private"],
      ["t", "stream"],
      ["t", "buzz.solo"],
      ["t", "buzz.session.named"],
    ]);
  const titlesFor = (name) =>
    row.locator(titleSelector).or(header(name).locator(titleSelector));
  const localTitle = "Local planning";
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Chat settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Edit chat", exact: true });
  await settings.getByRole("textbox", { name: /^Chat name/ }).fill(localTitle);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(settings).toBeHidden();
  // A title animation would be held indefinitely on the previous name.
  await expect(titlesFor(localTitle)).toHaveText([localTitle, localTitle]);
  const oldHeader = await header(localTitle).elementHandle();

  rename(title);
  const renamedHeader = header(title);
  await expect(row).toHaveAccessibleName(title);
  expect(
    await renamedHeader.evaluate((node, old) => node === old, oldHeader),
  ).toBe(true);
  await expect(composer).toBeFocused();

  const titles = titlesFor(title);
  await expect(titles).toHaveText([localTitle, localTitle]);
  await expect
    .poll(() =>
      titles.evaluateAll((nodes) =>
        nodes.map((node) => {
          const tracks = window.titleAnimations.get(node) ?? [];
          return {
            ...Object.assign(
              {},
              ...tracks.map(({ effect }) => effect.getKeyframes().at(-1)),
            ),
            held: tracks.every(
              (track) =>
                track.playState === "paused" && track.currentTime === 0,
            ),
          };
        }),
      ),
    )
    .toEqual(
      Array(2).fill(
        expect.objectContaining({
          held: true,
          opacity: "0",
          filter: "blur(3px)",
          transform: expect.stringMatching(/^translateX\(-/),
        }),
      ),
    );
  await page.keyboard.type("Still typing");
  await expect(composer).toHaveText("Still typing");
  const finishPhase = (values) =>
    values.evaluateAll((nodes) => {
      for (const node of nodes.flatMap((node) => [node, ...node.children]))
        for (const animation of window.titleAnimations.get(node) ?? [])
          animation.finish();
    });
  await finishPhase(titles);

  const characters = titles.locator("> span");
  await expect(characters).toHaveCount(title.length * 2);
  await expect
    .poll(() =>
      titles.evaluateAll((nodes) =>
        nodes.map((node) => {
          const delays = [...node.children].map(
            (character) =>
              (window.titleAnimations.get(character) ?? [])
                .find((track) => {
                  const frames = track.effect.getKeyframes();
                  return (
                    track.playState === "paused" &&
                    track.currentTime === 0 &&
                    frames[0]?.filter === "blur(3px)" &&
                    frames.at(-1)?.filter === "blur(0px)"
                  );
                })
                ?.effect.getTiming().delay,
          );
          return delays.every(
            (delay, index) =>
              delay !== undefined && (index === 0 || delay > delays[index - 1]),
          );
        }),
      ),
    )
    .toEqual([true, true]);
  await page.keyboard.type(" through the rename");
  await finishPhase(titles);
  await expect(characters).toHaveCount(0);
  await expect(titles).toHaveText([title, title]);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText("Still typing through the rename");

  for (const [mode, width, scale] of [
    ["light", 1440, 1],
    ["dark", 760, 1.5],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ mode, scale }) => {
        document.documentElement.setAttribute("data-color-mode", mode);
        document.documentElement.style.setProperty("--buzz-text-scale", scale);
      },
      { mode, scale },
    );
    for (const control of [row, renamedHeader]) {
      await expect(control).toBeVisible();
      const value = control.locator(titleSelector);
      await expect(value).toHaveCSS("text-overflow", "ellipsis");
      await expect(value).toHaveCSS("overflow-x", "hidden");
      if (scale > 1)
        expect(
          await value.evaluate((node) => node.scrollWidth > node.clientWidth),
        ).toBe(true);
      expect(
        await value.evaluate(
          (node, owner) => {
            const text = node.getBoundingClientRect();
            const bounds = owner.getBoundingClientRect();
            return text.width > 0 && text.right <= bounds.right + 1;
          },
          await control.elementHandle(),
        ),
      ).toBe(true);
    }
  }
  // Compare glyph positions without clipping the mixed-direction sample.
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("--buzz-text-scale"),
  );
  const mixed = "Release שלום 2026";
  rename(mixed);
  const mixedTitles = titlesFor(mixed);
  const expectOpacityPhase = (from, to) =>
    expect
      .poll(() =>
        mixedTitles.evaluateAll(
          (nodes, { from, to }) =>
            nodes.filter((node) =>
              (window.titleAnimations.get(node) ?? []).some((track) => {
                const frames = track.effect.getKeyframes();
                return (
                  track.playState === "paused" &&
                  frames[0]?.opacity === from &&
                  frames.at(-1)?.opacity === to
                );
              }),
            ).length,
          { from, to },
        ),
      )
      .toBe(2);
  await expect(mixedTitles).toHaveText([title, title]);
  await expectOpacityPhase("1", "0");
  await finishPhase(mixedTitles);
  await expect(mixedTitles).toHaveText([mixed, mixed]);
  await expectOpacityPhase("0", "1");
  const hebrewRunIsRTL = () =>
    mixedTitles.evaluateAll((nodes) =>
      nodes.map((node) => {
        const text = node.firstChild;
        const range = document.createRange();
        const left = (character) => {
          const offset = text.textContent.indexOf(character);
          range.setStart(text, offset);
          range.setEnd(text, offset + 1);
          return range.getBoundingClientRect().left;
        };
        return left("ו") < left("ל");
      }),
    );
  expect(await hebrewRunIsRTL()).toEqual([true, true]);
  await finishPhase(mixedTitles);
  expect(await hebrewRunIsRTL()).toEqual([true, true]);

  // The old local save must not suppress an incoming return to the same name.
  rename(localTitle);
  await expect(
    titlesFor(localTitle).and(page.locator("[data-exiting]")),
  ).toHaveText([mixed, mixed]);
  await row.dblclick();
  const inlineName = sidebar.getByRole("textbox", { name: "Chat name" });
  await inlineName.fill("Handoff notes");
  await inlineName.press("Enter");
  await expect(inlineName).toBeHidden();
  await expect(titlesFor("Handoff notes")).toHaveText([
    "Handoff notes",
    "Handoff notes",
  ]);

  await sidebar.locator(`[data-solo-destination-id="${other}"]`).click();
  const nextTitle = header("Beta").locator(titleSelector);
  await expect(nextTitle).toHaveText("Beta");
  expect(
    await nextTitle.evaluate(
      (node) => node.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
});
