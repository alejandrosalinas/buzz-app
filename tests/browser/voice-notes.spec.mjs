import { watchPageErrors } from "./page-errors.mjs";
import { test, expect } from "./playwright-test.mjs";
import { previewFixtures } from "./vite-server.mjs";
let fixtures;
// A dev server serves this fixture as about 800 modules, and WebKit's first
// navigation outlasted the navigation timeout on a busy runner.
test.beforeAll(async () => {
  fixtures = await previewFixtures(["tests/fixtures/voice-notes.html"]);
});
test.afterAll(() => fixtures?.close());
test.beforeEach(async ({ page }) => {
  await page.route("**/api/relay/media?*", async (route) => {
    const url = new URL(route.request().url()).searchParams.get("url");
    const bytes = await page.evaluate(async (url) => {
      const source = window.voiceFixture.media(url);
      return Array.from(
        new Uint8Array(await (await fetch(source)).arrayBuffer()),
      );
    }, url);
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: Buffer.from(bytes),
    });
  });
  await page.goto(`${fixtures.origin}/tests/fixtures/voice-notes.html`);
  await page.evaluate(() => {
    const mic = {
      mode: "allow",
      stopped: 0,
      started: 0,
      release: () => {},
    };
    window.voiceMic = mic;
    let captureContext;
    const microphones = new Map();
    const stopTrack = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      microphones.get(this.id)?.();
      microphones.delete(this.id);
      stopTrack.call(this);
    };
    document.addEventListener(
      "click",
      (event) => {
        if (
          event.target.closest?.('[aria-label="Record voice note"]') &&
          mic.mode !== "denied"
        ) {
          captureContext = new AudioContext();
          void captureContext.resume();
        }
      },
      true,
    );
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
      configurable: true,
      value: async () => {
        if (mic.mode === "denied")
          throw new DOMException("Denied", "NotAllowedError");
        const context = captureContext ?? new AudioContext();
        mic.context = context;
        void context.resume();
        const source = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.2;
        const destination = context.createMediaStreamDestination();
        source.connect(gain);
        gain.connect(destination);
        source.start();
        mic.started++;
        for (const track of destination.stream.getTracks()) {
          microphones.set(track.id, () => {
            mic.stopped++;
            source.stop();
            void context.close();
          });
        }
        if (mic.mode === "delay")
          await new Promise((resolve) => {
            mic.release = resolve;
          });
        return destination.stream;
      },
    });
  });

  await expect(
    page.getByRole("button", { name: "Play voice note", exact: true }),
  ).toBeVisible();
});
test.afterEach(async ({ page }) => {
  // Media routes evaluate in the page; finish them before its fixture closes.
  await page.unrouteAll({ behavior: "wait" });
});

async function record(page, { stopWith = "keyboard" } = {}) {
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => window.voiceMic.context.currentTime))
    .toBeGreaterThan(0.6); // Real audio frames, not a timer-only fake.
  await expect(page.getByRole("textbox")).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("voice-recording.png"),
  });
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeFocused();
  if (stopWith === "pointer")
    await page
      .getByRole("button", { name: "Stop recording", exact: true })
      .click();
  else await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Remove voice note", exact: true }),
  ).toBeVisible();
}
test("record, preview, send and play the chat card with speed and seeking", {
  tag: "@media-recorder",
}, async ({ page }) => {
  const errors = watchPageErrors(page);
  const initialCard = page
    .getByRole("group", { name: "Voice note", exact: true })
    .first();
  await expect(initialCard.locator("audio")).toHaveJSProperty("readyState", 0);
  await expect(initialCard.getByRole("slider")).toBeDisabled();
  await record(page);
  await expect(page.getByRole("textbox")).toBeFocused();
  const composer = page.getByRole("form", {
    name: "Send a message to general",
  });
  await expect(
    composer.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  const draftCard = composer.getByRole("group", {
    name: "Voice note",
    exact: true,
  });
  // A finished upload swaps in the sent copy, which remounts the player.
  await expect(draftCard.locator("audio")).toHaveAttribute(
    "src",
    /^\/api\/relay\/media\?/,
  );
  await page.screenshot({ path: test.info().outputPath("voice-cards.png") });
  await composer
    .getByRole("button", { name: "Play voice note", exact: true })
    .click();
  await expect(
    composer.getByRole("button", { name: "Pause voice note", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Play voice note", exact: true })
    .first()
    .click();
  await expect(
    composer.getByRole("button", { name: "Play voice note", exact: true }),
  ).toBeVisible();
  const firstCard = page
    .getByRole("group", { name: "Voice note", exact: true })
    .first();
  await firstCard
    .getByRole("button", { name: /Playback speed 1 times/ })
    .click();
  await expect(firstCard.locator("audio")).toHaveJSProperty(
    "playbackRate",
    1.5,
  );
  await expect(firstCard.getByRole("slider")).toBeEnabled();
  await firstCard.getByRole("slider").fill("1");
  await expect
    .poll(() =>
      firstCard.locator("audio").evaluate((audio) => audio.currentTime),
    )
    .toBeGreaterThanOrEqual(1);
  await composer.getByRole("textbox").fill("Listen to this");
  await composer
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(page.getByText("Listen to this", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove voice note", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.voiceFixture.report.published))
    .toBe(1);
  await expect(
    page.getByRole("group", { name: "Voice note", exact: true }),
  ).toHaveCount(2);
  expect(errors.unexplained()).toEqual([]);
});
test("permission cancellation, denial and plugin removal release microphones", {
  tag: "@media-recorder",
}, async ({ page }) => {
  await page.evaluate(() => {
    window.voiceMic.mode = "delay";
  });
  const recordButton = page.getByRole("button", {
    name: "Record voice note",
    exact: true,
  });
  await recordButton.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting for microphone…" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Discard voice note", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox")).toBeFocused();
  await page.evaluate(() => window.voiceMic.release());
  await expect.poll(() => page.evaluate(() => window.voiceMic.stopped)).toBe(1);
  await page.evaluate(() => {
    window.voiceMic.mode = "denied";
  });
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Allow Buzz");
  await expect(
    page.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox")).toBeFocused();
  await page.evaluate(() => {
    window.voiceMic.mode = "allow";
  });
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Disable Voice Notes", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.voiceMic.stopped)).toBe(2);
  await expect(
    page.getByRole("button", { name: "Enable Voice Notes", exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => window.voiceFixture.report.published)).toBe(
    0,
  );
});
test("failed upload survives disabling the plugin and switching conversations", {
  tag: "@media-recorder",
}, async ({ page }) => {
  await page.evaluate(() => {
    window.voiceFixture.report.failUpload = true;
  });
  await record(page, { stopWith: "pointer" });
  await expect(
    page.getByRole("button", { name: "Retry voice note upload", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Disable Voice Notes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove voice note", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Switch conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove voice note", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Switch conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry voice note upload", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.voiceFixture.report.failUpload = false;
  });
  await page
    .getByRole("button", { name: "Retry voice note upload", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Enable Voice Notes", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Voice note", exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Remove voice note", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record voice note", exact: true }),
  ).toBeEnabled();
});

test("rejected voice messages retry through the outbox without reuploading", {
  tag: "@media-recorder",
}, async ({ page }) => {
  // Keep one clock across recording, attachment entrance, and outbox expiry.
  // Installing it during an entrance changes the animation's time origin.
  await page.clock.install();
  await record(page);
  await page.evaluate(() => {
    window.voiceFixture.report.failSend = true;
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.voiceFixture.report.published))
    .toBe(1);
  await page.clock.runFor(11000);
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.voiceFixture.report.failSend = false;
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.voiceFixture.report.published))
    .toBe(2);
  expect(await page.evaluate(() => window.voiceFixture.report.uploads)).toBe(1);
  await expect(
    page.getByRole("group", { name: "Voice note", exact: true }),
  ).toHaveCount(2);
});

test("rejects a full attachment draft before opening the microphone", async ({
  page,
}) => {
  await page.locator('input[type="file"]').setInputFiles(
    Array.from({ length: 10 }, (_, index) => ({
      name: `file-${index}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("test"),
    })),
  );
  // The attachment rows grow as the draft settles, moving the toolbar under a
  // pointer aimed at its earlier position. Click once every file is Ready.
  await expect(
    page.getByRole("status").filter({ hasText: /· Ready$/ }),
  ).toHaveCount(10);
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(
    page.getByText("Attach at most 10 files per message."),
  ).toBeVisible();
  expect(await page.evaluate(() => window.voiceMic.started)).toBe(0);
  await expect(
    page.getByRole("status").filter({ hasText: /file-\d+\.txt:.*Ready/ }),
  ).toHaveCount(10);
  const uploaded = await page.evaluate(() =>
    window.voiceFixture
      .attachmentDraft("voice-fixture:draft:general", "general")
      .snapshot()
      .map((item) => item.uploaded),
  );
  expect(uploaded.map((item) => item.type)).toEqual(
    Array(10).fill("text/plain"),
  );
  expect(new Set(uploaded.map((item) => item.url)).size).toBe(10);
  expect(uploaded.every((item) => !item.voice)).toBe(true);
});
