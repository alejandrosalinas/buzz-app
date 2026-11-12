import { test, expect } from "./source-fixture.mjs";

test.afterEach(async ({ context }, testInfo) => {
  if (
    testInfo.status === testInfo.expectedStatus ||
    !testInfo.title.includes("shares storage and lock ownership")
  )
    return;
  for (const [index, page] of context.pages().entries()) {
    const snapshot = await page.evaluate(async () => ({
      picks: await (
        await import("/src/features/messages/solo-model-picks.ts")
      ).readSoloModelPicks(
        "composer-models-fixture",
        "solo:model-picks:fixture",
      ),
      models: [
        ...document.querySelectorAll('button[aria-label^="Model for"]'),
      ].map((button) => ({
        name: button.getAttribute("aria-label"),
        text: button.textContent,
      })),
      locks: await navigator.locks.query(),
    }));
    await testInfo.attach(`model-persistence-page-${index}.json`, {
      body: JSON.stringify(snapshot, null, 2),
      contentType: "application/json",
    });
  }
});

// Capture transitions at the DOM-change boundary. transitionrun is queued and
// can arrive after a busy renderer has already finished the entrance.
async function holdPickerMotion(page) {
  await page.evaluate(() => {
    new MutationObserver(() => {
      for (const root of document.querySelectorAll(
        '[role="dialog"] [role="group"]',
      )) {
        for (const animation of root.getAnimations({ subtree: true })) {
          animation.pause();
        }
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-starting-style"],
    });
  });
}

// Browser-only: the real portal, Base UI focus handling and CSS Modules.
// The composer unit tests own model discovery and sending the chosen effort.
test("effort picker opens, follows the keyboard and returns focus", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/composer-models.html");
  const trigger = page.getByRole("button", {
    name: "Model and effort for the next run",
  });
  await trigger.click();
  const slider = page.getByRole("slider", {
    name: "Effort for Honey's next run",
  });
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await page.getByRole("dialog").screenshot({
    path: testInfo.outputPath("effort.png"),
  });
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("Solo first-send choices stay selected until explicit reset", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/composer-models.html?solo");
  const trigger = page.getByRole("button", {
    name: "Model and effort for this chat",
  });
  await expect(trigger).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("solo-model-picker-before-selection.png"),
  });
  await trigger.click();
  await page
    .getByRole("button", { name: "Model for Honey in this chat" })
    .click();
  await page.getByRole("menuitemradio", { name: "Alternate model" }).click();
  const effort = page.getByRole("slider", {
    name: "Effort for Honey in this chat",
  });
  await expect(effort).toHaveAttribute("aria-valuetext", "Medium");
  await effort.focus();
  await page.keyboard.press("ArrowRight");
  await expect(effort).toHaveAttribute("aria-valuetext", "High");
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("data-selected", "");

  await trigger.click();
  const popup = page.getByRole("dialog");
  await expect(
    popup.getByRole("button", { name: "Model for Honey in this chat" }),
  ).toContainText("Alternate model");
  await expect(effort).toHaveAttribute("aria-valuetext", "High");
  await expect(
    popup.getByRole("button", { name: "Reset model and effort" }),
  ).toBeVisible();
  await popup.screenshot({ path: testInfo.outputPath("solo-first-send.png") });

  await popup.getByRole("button", { name: "Reset model and effort" }).click();
  await expect(trigger).not.toHaveAttribute("data-selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

// Browser-only: a real reload with a changed catalog must preserve IndexedDB
// picks; a DOM mount cannot prove that persistence or the portaled popup's geometry.
// The mounted tests own disclosure copy, fallback resolution and send payload.
test("Solo shows removed model and effort fallbacks until Reset", async ({
  page,
}, testInfo) => {
  const readSavedPick = async () => {
    const revision = await page.evaluate(async () => {
      const { readSoloModelPicks } = await import(
        "/src/features/messages/solo-model-picks.ts"
      );
      return (
        await readSoloModelPicks(
          "composer-models-fixture",
          "solo:model-picks:fixture",
        )
      ).revision;
    });
    return revision ? (Object.values(JSON.parse(revision))[0] ?? null) : null;
  };

  await page.goto("/tests/fixtures/composer-models.html?solo&persist");
  const trigger = page.getByRole("button", {
    name: "Model and effort for this chat",
  });
  await trigger.click();
  await page
    .getByRole("button", { name: "Model for Honey in this chat" })
    .click();
  await page.getByRole("menuitemradio", { name: "Alternate model" }).click();
  const effort = page.getByRole("slider", {
    name: "Effort for Honey in this chat",
  });
  await effort.focus();
  await page.keyboard.press("ArrowRight");
  await expect(effort).toHaveAttribute("aria-valuetext", "High");
  await page.keyboard.press("Escape");
  await expect.poll(readSavedPick).toMatchObject({
    model: "alternate",
    effort: "high",
  });

  await page.goto(
    "/tests/fixtures/composer-models.html?solo&persist&removed-model",
  );
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("data-selected", "");
  await expect(trigger).toHaveAccessibleDescription(
    /Saved model is unavailable\. Using Fixture model with its default effort \(Medium\)/,
  );
  await trigger.click();
  const popup = page.getByRole("dialog");
  const expectVisibleNoticeInsidePopup = async (notice, container) => {
    await expect(notice).toBeVisible();
    const [noticeBounds, popupBounds] = await Promise.all([
      notice.boundingBox(),
      container.boundingBox(),
    ]);
    expect(noticeBounds).not.toBeNull();
    expect(popupBounds).not.toBeNull();
    expect(noticeBounds.x).toBeGreaterThanOrEqual(popupBounds.x);
    expect(noticeBounds.y).toBeGreaterThanOrEqual(popupBounds.y);
    expect(noticeBounds.x + noticeBounds.width).toBeLessThanOrEqual(
      popupBounds.x + popupBounds.width,
    );
    expect(noticeBounds.y + noticeBounds.height).toBeLessThanOrEqual(
      popupBounds.y + popupBounds.height,
    );
  };
  const visibleModelNotice = popup
    .locator("[data-agent-model-card]")
    .getByText(
      "Saved model is unavailable. Using Fixture model with its default effort (Medium). Your saved choice is retained until you reset it.",
      { exact: true },
    );
  await expectVisibleNoticeInsidePopup(visibleModelNotice, popup);
  await expect(
    popup.getByRole("slider", { name: "Effort for Honey in this chat" }),
  ).toHaveAttribute("aria-valuetext", "Medium");
  await expect.poll(readSavedPick).toMatchObject({
    model: "alternate",
    effort: "high",
  });
  await popup.screenshot({
    path: testInfo.outputPath("unavailable-model-after-catalog-change.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("html").evaluate((root) => {
    root.dataset.colorMode = "dark";
    root.style.setProperty("--buzz-text-scale", "2");
  });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await expectVisibleNoticeInsidePopup(visibleModelNotice, popup);
  const narrowPopup = await popup.boundingBox();
  expect(narrowPopup).not.toBeNull();
  expect(narrowPopup.x).toBeGreaterThanOrEqual(0);
  expect(narrowPopup.x + narrowPopup.width).toBeLessThanOrEqual(390);
  await popup.screenshot({
    path: testInfo.outputPath("unavailable-model-dark-narrow.png"),
  });

  await page.goto("/tests/fixtures/composer-models.html?solo&persist");
  await trigger.click();
  const recovered = page.getByRole("dialog");
  await expect.poll(readSavedPick).toMatchObject({
    model: "alternate",
    effort: "high",
  });
  await expect(recovered.getByText(/Saved model is unavailable/)).toHaveCount(
    0,
  );
  await expect(
    recovered.getByRole("button", { name: "Model for Honey in this chat" }),
  ).toContainText("Alternate model");
  await expect(
    recovered.getByRole("slider", { name: "Effort for Honey in this chat" }),
  ).toHaveAttribute("aria-valuetext", "High");
  await page.keyboard.press("Escape");

  await page.goto(
    "/tests/fixtures/composer-models.html?solo&persist&removed-model",
  );
  await trigger.click();
  const resetModel = page.getByRole("dialog");
  await resetModel
    .getByRole("button", { name: "Reset model and effort" })
    .click();
  await expect.poll(readSavedPick).toBeNull();
  await expect(trigger).not.toHaveAttribute("data-selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto("/tests/fixtures/composer-models.html?solo&persist");
  await trigger.click();
  const modelControl = page.getByRole("button", {
    name: "Model for Honey in this chat",
  });
  await modelControl.click();
  await page.getByRole("menuitemradio", { name: "Alternate model" }).click();
  await modelControl.click();
  await page.getByRole("menuitemradio", { name: "Fixture model" }).click();
  const reselectedEffort = page.getByRole("slider", {
    name: "Effort for Honey in this chat",
  });
  await reselectedEffort.focus();
  await page.keyboard.press("ArrowRight");
  await expect(reselectedEffort).toHaveAttribute("aria-valuetext", "High");
  await page.keyboard.press("Escape");
  await expect.poll(readSavedPick).toMatchObject({
    model: "fixture",
    effort: "high",
  });
  await page.goto(
    "/tests/fixtures/composer-models.html?solo&persist&removed-effort",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await trigger.click();
  const resetEffort = page.getByRole("dialog");
  const visibleEffortNotice = resetEffort
    .locator("[data-agent-model-card]")
    .getByText(
      "Saved effort is unavailable for Fixture model. Using Fixture model with its default effort (Medium). Your saved choice is retained until you reset it.",
      { exact: true },
    );
  await expectVisibleNoticeInsidePopup(visibleEffortNotice, resetEffort);
  await expect(
    resetEffort.getByRole("slider", { name: "Effort for Honey in this chat" }),
  ).toHaveAttribute("aria-valuetext", "Medium");
  await expect.poll(readSavedPick).toMatchObject({
    model: "fixture",
    effort: "high",
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-mode",
    "light",
  );
  await resetEffort.screenshot({
    path: testInfo.outputPath("unavailable-effort-after-catalog-change.png"),
  });
  await resetEffort
    .getByRole("button", { name: "Reset model and effort" })
    .click();
  await expect.poll(readSavedPick).toBeNull();
  await expect(trigger).not.toHaveAttribute("data-selected");
});

// Browser-only: inherited animated progress, real track geometry and label clamping.
// A DOM emulator cannot catch the fill jumping ahead or the label moving backwards.
test("entrance keeps the fill and delayed model button attached to the handle", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/composer-models.html");
  await holdPickerMotion(page);
  await page
    .getByRole("button", { name: "Model and effort for the next run" })
    .click();
  const slider = page.getByRole("dialog").getByRole("group");
  await expect(page.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "Medium",
  );
  const { duration, revealDelay } = await slider.evaluate((root) => {
    const animation = root.getAnimations()[0];
    const reveal = root
      .getAnimations({ subtree: true })
      .find((item) => item.effect.getTiming().delay > 0);
    return {
      duration: animation ? Number(animation.effect.getTiming().duration) : 0,
      revealDelay: reveal?.effect.getTiming().delay ?? 0,
    };
  });
  expect(
    duration,
    "the handle should have an entrance to sample",
  ).toBeGreaterThan(0);
  expect(duration, "the picker should settle promptly").toBeLessThan(300);
  expect(revealDelay).toBeGreaterThan(0);
  expect(revealDelay).toBeLessThan(duration);
  const sample = async (elapsed) =>
    slider.evaluate((root, time) => {
      for (const animation of root.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = time;
      }
      const thumb = root
        .querySelector("[data-rubber-thumb]")
        .getBoundingClientRect();
      const fill = root
        .querySelector("[data-base-ui-slider-indicator]")
        .getBoundingClientRect();
      const track = root
        .querySelector("[data-base-ui-slider-control]")
        .getBoundingClientRect();
      const button = root.querySelector("button");
      const anchor = button.closest('[class*="tetherAnchor"]');
      const label = anchor.getBoundingClientRect();
      return {
        handle: thumb.x + thumb.width / 2,
        handleRight: thumb.right,
        fillRight: fill.right,
        trackLeft: track.left,
        trackRight: track.right,
        thumbWidth: thumb.width,
        labelCenter: label.x + label.width / 2,
        labelWidth: label.width,
        opacity: Number(getComputedStyle(anchor.firstElementChild).opacity),
      };
    }, elapsed);
  const start = await sample(0);
  expect(start.handle - start.trackLeft).toBeCloseTo(start.thumbWidth / 2, 0);
  const beforeReveal = await sample(revealDelay - 1);
  expect(beforeReveal.opacity).toBe(0);
  const moving = await sample((revealDelay + duration) / 2);
  expect(moving.opacity).toBeGreaterThan(0);
  expect(moving.handle).toBeGreaterThan(start.handle);
  for (const frame of [start, beforeReveal, moving]) {
    expect(Math.abs(frame.fillRight - frame.handleRight)).toBeLessThan(1);
    const attached = Math.min(
      frame.trackRight - frame.labelWidth / 2,
      Math.max(frame.trackLeft + frame.labelWidth / 2, frame.handle),
    );
    expect(Math.abs(frame.labelCenter - attached)).toBeLessThan(1);
  }
  await page
    .getByRole("dialog")
    .screenshot({ path: testInfo.outputPath("entrance.png") });
  // Keyboard input interrupts the entrance and immediately shows the selected value.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
  await expect
    .poll(async () =>
      slider.evaluate((root) => {
        const thumb = root
          .querySelector("[data-rubber-thumb]")
          .getBoundingClientRect();
        const track = root
          .querySelector("[data-base-ui-slider-control]")
          .getBoundingClientRect();
        return Math.abs(thumb.right - track.right);
      }),
    )
    .toBeLessThan(1);
  await expect(
    page.getByRole("button", { name: "Model for Honey's next run" }),
  ).toBeVisible();
  // Reduced motion has the complete control immediately, even at narrow widths
  // and enlarged interface text; no delayed button or offscreen label.
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 700 });
  await page.addStyleTag({ content: ":root { font-size: 20px; }" });
  await expect(page.locator("html")).toHaveCSS("font-size", "20px");
  await page
    .getByRole("button", { name: "Model and effort for the next run" })
    .click();
  await expect(page.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
  const reduced = await sample(0);
  expect(reduced.opacity).toBe(1);
  expect(Math.abs(reduced.fillRight - reduced.handleRight)).toBeLessThan(1);
  expect(reduced.labelCenter - reduced.labelWidth / 2).toBeGreaterThanOrEqual(
    reduced.trackLeft - 1,
  );
  expect(reduced.labelCenter + reduced.labelWidth / 2).toBeLessThanOrEqual(
    reduced.trackRight + 1,
  );
  await page.getByRole("dialog").screenshot({
    path: testInfo.outputPath("reduced-motion-narrow.png"),
  });
});

// Switching input modality inside an open popup must not restart its entrance.
test("keyboard-opened picker stays settled when switching to the pointer", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/composer-models.html");
  await holdPickerMotion(page);
  const trigger = page.getByRole("button", {
    name: "Model and effort for the next run",
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const slider = page.getByRole("dialog").getByRole("group");
  await expect(page.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "Medium",
  );
  const before = await page.getByRole("slider").locator("..").boundingBox();
  await page.getByRole("heading", { name: "Honey", exact: true }).click();
  // Two frames establish that the modality change has been styled and painted.
  const after = await slider.evaluate(
    (root) =>
      new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const thumb = root
              .querySelector("[data-rubber-thumb]")
              .getBoundingClientRect();
            const label = root
              .querySelector("button")
              .closest('[class*="tetherSway"]');
            resolve({
              x: thumb.x,
              opacity: Number(getComputedStyle(label).opacity),
            });
          }),
        );
      }),
  );
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.opacity).toBe(1);
});

// Real same-origin IDB transactions, notifications and Web Locks span two pages; mounted tests
// own pending intent, resets, Send and refused-start lifecycle permutations.
test("Solo model persistence shares storage and lock ownership across pages", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await Promise.all([
    page.goto("/tests/fixtures/composer-models.html?solo&persist"),
    other.goto("/tests/fixtures/composer-models.html?solo&persist"),
  ]);
  await page.evaluate(async () => {
    const { lockSoloModelPicks } = await import(
      "/src/features/messages/solo-model-picks.ts"
    );
    const gate = new Promise((resolve) => {
      window.releaseModelLock = resolve;
    });
    await new Promise((resolve) => {
      window.modelLock = lockSoloModelPicks("composer-models-fixture", () => {
        resolve();
        return gate;
      });
    });
  });
  const trigger = (page) =>
    page.getByRole("button", { name: "Model and effort for this chat" });
  try {
    for (const [target, name] of [
      [page, "Honey"],
      [other, "Bumble"],
    ]) {
      await trigger(target).click();
      await target
        .getByRole("button", { name: `Model for ${name} in this chat` })
        .click();
      await target
        .getByRole("menuitemradio", { name: "Alternate model" })
        .click();
      await expect(trigger(target)).toHaveAttribute("data-selected", "");
    }
    // Both UI actions completed, but the real lock is still held elsewhere.
    expect(
      await page.evaluate(async () =>
        (await import("/src/features/messages/solo-model-picks.ts"))
          .readSoloModelPicks(
            "composer-models-fixture",
            "solo:model-picks:fixture",
          )
          .then((saved) => saved.revision),
      ),
    ).toBeNull();
  } finally {
    await page.evaluate(async () => {
      window.releaseModelLock();
      await window.modelLock;
    });
  }
  // Each page must observe its peer's edit through a post-commit notification.
  await expect(
    page.getByRole("button", { name: "Model for Bumble in this chat" }),
  ).toContainText("Alternate model");
  await expect(
    other.getByRole("button", { name: "Model for Honey in this chat" }),
  ).toContainText("Alternate model");
  await page.reload();
  await trigger(page).click();
  await expect(
    page.getByRole("button", { name: "Model for Honey in this chat" }),
  ).toContainText("Alternate model");
  await expect(
    page.getByRole("button", { name: "Model for Bumble in this chat" }),
  ).toContainText("Alternate model");
});

// An IDB transaction alone cannot order a purge behind a save waiting on a Web Lock.
test("Solo choice purge waits for already queued saves", async ({ page }) => {
  await page.goto("/tests/fixtures/composer-models.html");
  await page.evaluate(async () => {
    const { lockSoloModelPicks, updateSoloModelPicks } = await import(
      "/src/features/messages/solo-model-picks.ts"
    );
    const { purgeSoloModelPicks } = await import(
      "/src/features/messages/solo-model-picks-storage.ts"
    );
    const gate = new Promise((resolve) => {
      window.releaseModelLock = resolve;
    });
    await new Promise((resolve) => {
      window.modelLock = lockSoloModelPicks("purge", () => {
        resolve();
        return gate;
      });
    });
    window.queuedModelSave = updateSoloModelPicks(
      "purge",
      "solo:model-picks:fixture",
      new Map([["a".repeat(64), { model: "fixture" }]]),
    );
    window.modelPurge = purgeSoloModelPicks("purge").then(() => {
      window.modelPurgeFinished = true;
    });
  });
  try {
    // Both implementations reach a boundary: an unlocked purge completes,
    // while a locked one waits behind the save. Neither depends on runner speed.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { pending } = await navigator.locks.query();
          return (
            window.modelPurgeFinished === true ||
            pending.filter(
              (lock) => lock.name === "buzz-solo-model-picks:purge",
            ).length === 2
          );
        }),
      )
      .toBe(true);
  } finally {
    await page.evaluate(async () => {
      window.releaseModelLock();
      await Promise.all([
        window.modelLock,
        window.queuedModelSave,
        window.modelPurge,
      ]);
    });
  }
  expect(
    await page.evaluate(async () => {
      const { readSoloModelPicks } = await import(
        "/src/features/messages/solo-model-picks.ts"
      );
      return (await readSoloModelPicks("purge", "solo:model-picks:fixture"))
        .revision;
    }),
  ).toBeNull();
});

// Real IDB commit/abort and storage availability are browser contracts, not jsdom mocks.
test("Solo choice initialization and first-send compare/clear commit atomically", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/composer-models.html");
  const result = await page.evaluate(async () => {
    const { transactModelPicks, purgeSoloModelPicks } = await import(
      "/src/features/messages/solo-model-picks-storage.ts"
    );
    const { readSoloModelPicks } = await import(
      "/src/features/messages/solo-model-picks.ts"
    );
    const { writeView, viewRevision } = await import(
      "/src/shared/view-state.ts"
    );
    const scope = "initialization",
      kept = "initialization-other",
      draft = "solo:model-picks:new",
      chat = "solo:model-picks:chat";
    const original = {
      ["a".repeat(64)]: { model: "alternate", effort: "high" },
    };
    const newer = { ["b".repeat(64)]: { model: "fixture" } };
    writeView(scope, draft, original);
    const read = async (scope, key) =>
      (await readSoloModelPicks(scope, key)).revision;
    const getItem = Storage.prototype.getItem;
    let freshWithoutLocalStorage, savedWithoutLocalStorage;
    Storage.prototype.getItem = function (key) {
      if (key === `buzz-view.v1:${JSON.stringify([scope, draft])}`)
        throw new DOMException("Legacy storage unavailable");
      return getItem.call(this, key);
    };
    try {
      freshWithoutLocalStorage = await read(scope, draft);
      await transactModelPicks(scope, [draft], (tx) =>
        tx.write(draft, original),
      );
      savedWithoutLocalStorage = await read(scope, draft);
    } finally {
      Storage.prototype.getItem = getItem;
    }
    let aborted = false;
    try {
      await transactModelPicks(scope, [draft, chat], (tx) => {
        tx.write(chat, original);
        tx.write(draft, null);
        throw new Error("Simulated failure after both writes were queued");
      });
    } catch {
      aborted = true;
    }
    const afterAbort = [await read(scope, draft), await read(scope, chat)];
    const baseline = (await readSoloModelPicks(scope, draft)).version;
    const cleared = await transactModelPicks(scope, [draft, chat], (tx) => {
      tx.write(chat, original);
      if (tx.version(draft) !== baseline) return false;
      tx.write(draft, null);
      return true;
    });
    const afterTransfer = [await read(scope, draft), await read(scope, chat)];
    const clearedReceipt = (await readSoloModelPicks(scope, draft)).version;
    await transactModelPicks(scope, [draft], (tx) => tx.write(draft, original));
    await transactModelPicks(scope, [draft], (tx) => tx.write(draft, {}));
    const restoredAfterReset = await transactModelPicks(
      scope,
      [draft],
      (tx) => {
        if (tx.version(draft) !== clearedReceipt) return false;
        tx.write(draft, original);
        return true;
      },
    );
    const afterReset = await read(scope, draft);
    await transactModelPicks(scope, [draft], (tx) => tx.write(draft, null));
    // Unrelated view-state bytes cannot resurrect consumed choices.
    const legacy = viewRevision(scope, draft);
    writeView(scope, draft, newer);
    const afterLegacyWrite = await read(scope, draft);
    await transactModelPicks(scope, [draft], (tx) => tx.write(draft, newer));
    const clearedNewer = await transactModelPicks(scope, [draft], (tx) => {
      if (tx.version(draft) !== baseline) return false;
      tx.write(draft, null);
      return true;
    });
    const afterCompare = await read(scope, draft);
    const beforeEqualWrite = (await readSoloModelPicks(scope, draft)).version;
    await transactModelPicks(scope, [draft], (tx) => tx.write(draft, newer));
    const undidEqualWrite = await transactModelPicks(scope, [draft], (tx) => {
      if (tx.version(draft) !== beforeEqualWrite) return false;
      tx.write(draft, null);
      return true;
    });
    const afterStaleUndo = await read(scope, draft);
    await transactModelPicks(kept, [draft], (tx) => tx.write(draft, original));
    // Purge cannot revive view-state bytes and does not touch another scope.
    writeView(scope, "solo:model-picks:unread", original);
    await purgeSoloModelPicks(scope);
    return {
      aborted,
      freshWithoutLocalStorage,
      savedWithoutLocalStorage,
      afterAbort,
      cleared,
      afterTransfer,
      restoredAfterReset,
      afterReset,
      undidEqualWrite,
      afterStaleUndo,
      legacy,
      afterLegacyWrite,
      clearedNewer,
      afterCompare,
      purged: await read(scope, draft),
      purgedUnread: await read(scope, "solo:model-picks:unread"),
      purgedLegacy: viewRevision(scope, draft),
      kept: await read(kept, draft),
    };
  });
  const original = JSON.stringify({
    ["a".repeat(64)]: { model: "alternate", effort: "high" },
  });
  const newer = JSON.stringify({ ["b".repeat(64)]: { model: "fixture" } });
  expect(result).toEqual({
    aborted: true,
    freshWithoutLocalStorage: null,
    savedWithoutLocalStorage: original,
    afterAbort: [original, null],
    cleared: true,
    afterTransfer: [null, original],
    restoredAfterReset: false,
    afterReset: "{}",
    undidEqualWrite: false,
    afterStaleUndo: newer,
    legacy: original,
    afterLegacyWrite: null,
    clearedNewer: false,
    afterCompare: newer,
    purged: null,
    purgedUnread: null,
    purgedLegacy: newer,
    kept: original,
  });
});
