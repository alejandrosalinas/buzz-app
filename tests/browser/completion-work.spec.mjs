import { test, expect } from "./source-fixture.mjs";

// Browser boundary: real contenteditable typing and transient portal/layout work.
// The real relay session runs against a counted, gated transport (not live traffic).
test("mention typing does not repeat cold reads or create phantom popup layout after acceptance", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/mentions.html?delayed-profiles");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.list().status))
    .toBe("ready");
  await input.evaluate((element) => {
    const anchor = element.closest("form");
    const original = anchor.getBoundingClientRect;
    const sample = { popups: 0, geometryReads: 0 };
    anchor.getBoundingClientRect = function (...args) {
      // ProseMirror also measures ancestors to keep the caret visible. This
      // assertion owns completion positioning, not the editor's native scrolling.
      if (new Error().stack?.includes("useCompletionPosition.ts"))
        sample.geometryReads++;
      return original.apply(this, args);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          sample.popups += Number(
            node.matches('section[aria-label="Mention suggestions"]'),
          );
          sample.popups += node.querySelectorAll(
            'section[aria-label="Mention suggestions"]',
          ).length;
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.suggestionWork = {
      sample,
      stop() {
        observer.disconnect();
        anchor.getBoundingClientRect = original;
      },
    };
  });
  await input.fill("@M");
  const reads = () => page.evaluate(() => window.mentionFixture.reads());
  // General is untyped, so the community directory also searches each new
  // query after its debounce. Those reads belong to the query, not cold work,
  // so the baseline holds when the first search starts before or after it.
  const session = ({ kinds, queries }) =>
    kinds.filter((_, index) => !queries[index]);
  await expect
    .poll(
      async () =>
        session(await reads()).filter((kinds) => kinds.includes(0)).length,
    )
    .toBeGreaterThan(0);
  const cold = session(await reads());
  const coldLibraryReads = await page.evaluate(() =>
    window.mentionFixture.libraryReads(),
  );
  try {
    await input.pressSequentially("ary J");
    await expect(input).toHaveJSProperty("value", "@Mary J");
    // Wait for the final query's search; any other read added by typing
    // would repeat cold work.
    await expect.poll(async () => (await reads()).searches).toContain("Mary J");
    expect(session(await reads())).toEqual(cold);
    expect(
      await page.evaluate(() => window.mentionFixture.libraryReads()),
    ).toBe(coldLibraryReads);
  } finally {
    await page.evaluate(() => window.mentionFixture.releaseProfiles());
  }
  const choice = page.getByRole("option", { name: "Mary Jane", exact: true });
  await expect(choice).toBeVisible();
  await expect.poll(async () => (await reads()).pending).toBe(0);
  await choice.click();
  await expect(input).toHaveJSProperty("value", "@Mary Jane ");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  const warm = await reads();
  const warmLibraryReads = await page.evaluate(() =>
    window.mentionFixture.libraryReads(),
  );
  // Calibrate the probe against the real popup, then measure only post-acceptance work.
  await expect
    .poll(() => page.evaluate(() => window.suggestionWork.sample.geometryReads))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    window.suggestionWork.sample.popups = 0;
    window.suggestionWork.sample.geometryReads = 0;
  });
  const prose = "this looks weird while typing";
  let sample;
  try {
    await input.pressSequentially(prose);
    await expect(input).toHaveJSProperty("value", `@Mary Jane ${prose}`);
    // Drain effects/DOM mutations and the subsequent paint opportunity, not a sleep.
    sample = await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(window.suggestionWork.sample)),
          );
        }),
    );
  } finally {
    await page.evaluate(() => window.suggestionWork.stop());
  }
  const after = await reads();
  const report = {
    characters: prose.length,
    coldReads: cold,
    warmAdditionalReads: after.kinds.length - warm.kinds.length,
    libraryReads: await page.evaluate(() =>
      window.mentionFixture.libraryReads(),
    ),
    ...sample,
  };
  await testInfo.attach("suggestion-work.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  expect(after.kinds).toEqual(warm.kinds);
  expect(report.libraryReads).toBe(warmLibraryReads);
  expect(sample).toEqual({ popups: 0, geometryReads: 0 });
  await expect(input.locator(".inline-chip")).toHaveCount(1);
  await expect(
    input.getByRole("img", { name: "Person Mary Jane" }),
  ).toBeVisible();
  await expect(input).not.toHaveAttribute("aria-controls");
});

// Native Enter/Tab must not turn a completed plain-text name into a recipient.
test("qualified names preserve keyboard selection and completed-name dismissal", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  await page.goto("/tests/fixtures/mentions.html?identity-names");
  const input = page.getByRole("textbox", { name: "Message #General" });
  const options = page.getByRole("option");
  const chips = input.locator(".inline-chip");
  const publications = () =>
    page.evaluate(() => window.mentionFixture.publications);
  const keys = await page.evaluate(() => [
    window.mentionFixture.first,
    window.mentionFixture.second,
  ]);

  // A multi-word display name still completes even when its source name differs.
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.list().status))
    .toBe("ready");
  await page.evaluate(() => window.mentionFixture.collide(false));
  await input.fill("@Other");
  await expect(options).toHaveCount(1);
  await input.pressSequentially(" H");
  await expect(options).toHaveCount(1);
  await expect(options).toContainText("Other Honey");
  await input.press("Tab");
  await expect(chips).toHaveText("@Other Honey");
  await input.press("Enter");
  await expect.poll(publications).toHaveLength(1);
  expect((await publications())[0].tags.filter(([tag]) => tag === "p")).toEqual(
    [["p", keys[1]]],
  );

  await page.evaluate(() => window.mentionFixture.collide(true));
  for (const accept of ["Enter", "Tab"]) {
    await input.fill("@Hon");
    await expect(options).toHaveCount(2);
    await expect(options.first()).toContainText("Honey · ");
    const selectedKey = (await options.first().innerText()).includes(keys[0])
      ? keys[0]
      : keys[1];
    const qualifier = await page.evaluate(
      (key) => window.mentionFixture.qualifier(key),
      selectedKey,
    );
    await input.press(accept);
    await expect(chips).toHaveText(`@Honey · ${qualifier}`);
    await expect(input).toHaveJSProperty("value", "@Honey ");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    const count = (await publications()).length;
    await input.press("Enter");
    await expect.poll(publications).toHaveLength(count + 1);
    expect(
      (await publications())[count].tags.filter(([tag]) => tag === "p"),
    ).toEqual([["p", selectedKey]]);
  }

  // Typing a completed name dismisses the same real producer; Tab must not select.
  await input.fill("@Honey");
  await expect(options).toHaveCount(2);
  await input.press("Space");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.press("Tab");
  await expect(chips).toHaveCount(0);
  await expect(input).toHaveJSProperty("value", "@Honey ");
  const count = (await publications()).length;
  await input.focus();
  await input.press("Enter");
  await expect.poll(publications).toHaveLength(count + 1);
  const plain = (await publications())[count];
  expect(plain.content).toBe("@Honey");
  expect(plain.tags.filter(([tag]) => tag === "p")).toEqual([]);
});

test("completed, dismissed and refuted mention searches stay closed while fresh triggers search", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html?stream");
  const input = page.getByRole("textbox", { name: "Message #General" });
  const options = page.getByRole("option");
  const listbox = page.getByRole("listbox");
  const chips = input.locator(".inline-chip");
  const searches = () => page.evaluate(() => window.mentionFixture.searches());
  const held = () => page.evaluate(() => window.mentionFixture.heldSearches());
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.list().status))
    .toBe("ready");
  async function freshSearch(before) {
    await input.press("End");
    await input.pressSequentially(" @Hon");
    await expect(options).toHaveCount(2);
    // The fresh trigger gets "Hon" directory evidence after the typing pause:
    // a new read, or the session's settled page for the same query.
    await expect
      .poll(async () => {
        const all = await searches();
        return (
          all.slice(before.length).at(-1) ??
          all.findLast((search) => search === "Hon")
        );
      })
      .toBe("Hon");
    const added = (await searches()).slice(before.length);
    expect(added.filter((search) => !"Hon".startsWith(search))).toEqual([]);
    await input.press("Escape");
    await expect(listbox).toHaveCount(0);
  }

  await input.fill("");
  await page.evaluate(() => window.mentionFixture.holdSearches());
  try {
    // An uncached query, so a directory read is in flight when dismissed. It
    // goes first: once a complete page for a prefix of `Hone` is cached, the
    // chooser answers the query from it and reads nothing.
    await input.pressSequentially("@Hone");
    await expect(options).toHaveCount(2);
    await expect.poll(held).toContain("Hone");
    await input.press("Escape");
    await expect(listbox).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.mentionFixture.releaseSearches());
  }
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.mentionFixture.reads())).pending,
    )
    .toBe(0);
  await expect(listbox).toHaveCount(0);

  await input.fill("@Hon");
  await expect(options).toHaveCount(2);
  await input.press("Tab");
  await expect(chips).toHaveCount(1);
  await expect(input).toHaveJSProperty("value", "@Honey ");
  let before = await searches();
  await input.pressSequentially("asdfkjdsfkl");
  await expect(input).toHaveJSProperty("value", "@Honey asdfkjdsfkl");
  for (let i = 0; i < "asdfkjdsfkl".length + 1; i++)
    await input.press("ArrowLeft");
  await expect(input).toHaveJSProperty("selectionStart", "@Honey".length);
  await expect(listbox).toHaveCount(0);
  await freshSearch(before);
  expect(await searches()).not.toContainEqual(expect.stringContaining("asdf"));

  await input.fill("");
  await page.evaluate(() => window.mentionFixture.holdSearches());
  try {
    await input.pressSequentially("@Ho");
    await expect(options).toHaveCount(2);
    await expect.poll(held).toContain("Ho");
    await input.press("Tab");
    await expect(chips).toHaveCount(1);
    await input.pressSequentially("later");
  } finally {
    await page.evaluate(() => window.mentionFixture.releaseSearches());
  }
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.mentionFixture.reads())).pending,
    )
    .toBe(0);
  await expect(listbox).toHaveCount(0);

  await input.fill("@Zed");
  await expect.poll(searches).toContain("Zed");
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.mentionFixture.reads())).pending,
    )
    .toBe(0);
  before = await searches();
  await input.pressSequentially(" is typing prose");
  await expect(input).toHaveJSProperty("value", "@Zed is typing prose");
  await expect(listbox).toHaveCount(0);
  await freshSearch(before);
  expect(await searches()).not.toContainEqual(expect.stringContaining("Zed "));
});

for (const row of ["people", "supplement"]) {
  test(`a ${row} row proves the owner's mention only from a person's pick`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
    });
    await page.goto("/tests/fixtures/mentions.html?supplement");
    const input = page.getByRole("textbox", { name: "Message #General" });
    await expect
      .poll(() => page.evaluate(() => window.mentionFixture.list().status))
      .toBe("ready");
    const crew = page.getByRole("option", { name: "Honey crew" });
    const pick =
      row === "people"
        ? page.getByRole("option").filter({ hasNotText: "Honey crew" }).first()
        : crew;
    const proof = () =>
      page.evaluate(() => window.mentionFixture.ownerMention(null));
    for (const trusted of [false, true]) {
      await input.fill("@Hon");
      await expect(crew).toBeVisible();
      if (trusted) await pick.click();
      else await pick.dispatchEvent("click");
      await expect(input.locator(".inline-chip")).toHaveCount(
        row === "people" ? 1 : 2,
      );
      const count = await page.evaluate(
        () => window.mentionFixture.publications.length,
      );
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => window.mentionFixture.publications.length),
        )
        .toBe(count + 1);
      const sent = await page.evaluate(() =>
        window.mentionFixture.publications.at(-1),
      );
      const tagged = sent.tags
        .filter(([tag]) => tag === "p")
        .map(([, key]) => key);
      expect(tagged).toHaveLength(row === "people" ? 1 : 2);
      await expect
        .poll(() =>
          page.evaluate(
            (id) => window.mentionFixture.confirmedOwnerSends(null, [id]),
            sent.id,
          ),
        )
        .toEqual([sent.id]);
      if (!trusted) {
        expect(await proof()).toBeNull();
        continue;
      }
      const latest = await proof();
      expect(latest?.eventId).toBe(sent.id);
      expect([...latest.recipientIds].sort()).toEqual(tagged.sort());
    }
  });
}

for (const mode of ["hold", "silent"]) {
  test(`Space picks an exact person unless a supplement published a hold (${mode})`, async ({
    page,
  }) => {
    await page.goto(
      `/tests/fixtures/mentions.html?delayed-profiles&supplement=${mode}`,
    );
    await page.evaluate(() => window.mentionFixture.releaseProfiles());
    const input = page.getByRole("textbox", { name: "Message #General" });
    await expect
      .poll(() => page.evaluate(() => window.mentionFixture.list().status))
      .toBe("ready");
    await input.pressSequentially("@Mary Jane ");
    if (mode === "silent") {
      await expect(input.locator(".inline-chip")).toHaveText("@Mary Jane");
      return;
    }
    await expect(input).toHaveJSProperty("value", "@Mary Jane ");
    await expect(input.locator(".inline-chip")).toHaveCount(0);
  });
}

for (const key of ["Enter", "Tab"]) {
  test(`${key} takes a supplement row ordered first`, async ({ page }) => {
    await page.goto("/tests/fixtures/mentions.html?supplement=hold");
    const input = page.getByRole("textbox", { name: "Message #General" });
    await expect
      .poll(() => page.evaluate(() => window.mentionFixture.list().status))
      .toBe("ready");
    await input.fill("@Hon");
    await expect(
      page.getByRole("option", { name: "Honey crew", selected: true }),
    ).toBeVisible();
    await input.press(key);
    await expect(input.locator(".inline-chip")).toHaveCount(2);
  });
}
