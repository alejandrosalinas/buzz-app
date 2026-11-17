import { expect, it, vi } from "vitest";
import { exactEmoji, searchEmoji, searchCustomEmoji } from "./emoji-search";

it("verifies one exact shortcode for the closing colon, not ranking ties or namesakes", async () => {
  const party = [{ shortcode: "party", url: "https://a.test/party.png" }];
  const smile = [{ shortcode: "smile", url: "https://a.test/smile.png" }];
  for (const [query, id] of [
    ["-1", "unicode/-1"],
    ["+1", "unicode/+1"],
    ["SMILE", "unicode/smile"],
    ["party", "custom/party"],
  ] as const)
    expect(exactEmoji(query, await searchEmoji(query, party))).toBe(id);
  // Separator-insensitive search ranks -1 first for "1", but the name differs.
  const one = await searchEmoji("1", []);
  expect(one[0]?.shortcode).toBe("-1");
  expect(exactEmoji("1", one)).toBeUndefined();
  expect(exactEmoji("smil", await searchEmoji("smil", []))).toBeUndefined();
  expect(
    exactEmoji("smile", await searchEmoji("smile", smile)),
  ).toBeUndefined();
  expect(exactEmoji("smile", searchCustomEmoji("smile", smile))).toBe(
    "custom/smile",
  );
});

it("searches native names, aliases and separator-insensitive shortcodes", async () => {
  expect((await searchEmoji("smile", []))[0]?.shortcode).toBe("smile");
  expect(
    (await searchEmoji("thumbsup", [])).some((item) => item.text === "👍"),
  ).toBe(true);
  expect(
    (await searchEmoji("pointup", [])).some(
      (item) => item.shortcode === "point_up",
    ),
  ).toBe(true);
  expect(
    (await searchEmoji("pntup", [])).some(
      (item) => item.shortcode === "point_up",
    ),
  ).toBe(true);
});
it("keeps current custom catalogs separate and ranks exact shortcodes first", async () => {
  const a = [
    { shortcode: "smile", url: "https://a.test/a.png" },
    { shortcode: "bufo_smile", url: "https://a.test/b.png" },
  ];
  const b = [{ shortcode: "smile", url: "https://b.test/a.png" }];
  const [first, second] = await Promise.all([
    searchEmoji("smile", a),
    searchEmoji("smile", b),
  ]);
  expect(
    first
      .slice(0, 2)
      .map((item) => item.id)
      .sort(),
  ).toEqual(["custom/smile", "unicode/smile"]);
  expect(second.find((item) => item.id === "custom/smile")?.url).toBe(
    b[0]?.url,
  );
  expect(second.flatMap((item) => (item.url ? [item.url] : []))).toEqual([
    b[0]?.url,
  ]);
  expect((await searchEmoji("smile", [])).every((item) => !item.url)).toBe(
    true,
  );
  expect(
    searchCustomEmoji("partyparrot", [
      { shortcode: "party-parrot", url: "https://a.test" },
    ])[0]?.text,
  ).toBe(":party-parrot:");
});
it("returns every match by default while retaining an explicit limit", async () => {
  const custom = Array.from({ length: 75 }, (_, index) => ({
    shortcode: `smile_${index}`,
    url: `https://a.test/${index}.png`,
  }));
  expect(searchCustomEmoji("smile", custom)).toHaveLength(75);
  expect(
    (await searchEmoji("smile", custom)).filter((item) => item.url),
  ).toHaveLength(75);
  expect(searchCustomEmoji("smile", custom, 12)).toHaveLength(12);
  expect(await searchEmoji("", [])).toEqual([]);
});
it("keeps semantic results ahead of loose shortcode matches", async () => {
  const results = await searchEmoji("sad", [
    { shortcode: "sandwich", url: "https://a.test/sandwich.png" },
  ]);
  expect(results[0]?.id).not.toBe("custom/sandwich");
  expect(
    results.findIndex((item) => item.id === "custom/sandwich"),
  ).toBeGreaterThan(0);
});
it("copies native primitives even when Mart previously mutated the shared dictionary", async () => {
  const { vi } = await import("vitest");
  vi.resetModules();
  const raw = (await import("@emoji-mart/data"))
    .default as unknown as import("@emoji-mart/data").EmojiMartData;
  const smile = raw.emojis.smile;
  if (!smile) throw new Error("Missing pinned fixture emoji");
  const originalName = smile.name;
  const originalKeywords = [...smile.keywords];
  const customId = "buzz-custom/other-community/alien";
  try {
    // Mart's custom entries have an image source, not a native Unicode skin.
    raw.emojis[customId] = {
      id: customId,
      name: "Other community alien",
      keywords: ["smile"],
      version: 1,
      skins: [{ unified: "", native: "" }],
    };
    const isolated = await import("./emoji-search");
    expect(
      (await isolated.searchEmoji("smile", [])).some((item) =>
        item.id.includes(customId),
      ),
    ).toBe(false);
    smile.name = "MUTATED PICKER RECORD";
    smile.keywords.push("contamination");
    expect(
      (await isolated.searchEmoji("smile", [])).find(
        (item) => item.shortcode === "smile",
      )?.name,
    ).toBe(originalName);
    expect(
      (await isolated.searchEmoji("contamination", [])).some(
        (item) => item.shortcode === "smile",
      ),
    ).toBe(false);
  } finally {
    smile.name = originalName;
    smile.keywords = originalKeywords;
    delete raw.emojis[customId];
  }
});

it("Unicode completions use the picker's saved default skin tone", async () => {
  const [hand] = await searchEmoji("call_me_hand", [], 1, 4);
  expect(hand?.text).toBe("🤙🏽");
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "emoji-mart.skin" ? "6" : null),
  });
  try {
    const [saved] = await searchEmoji("call_me_hand", [], 1);
    expect(saved?.text).toBe("🤙🏿");
    // Emoji without tones keep their only form.
    const [rocket] = await searchEmoji("rocket", [], 1);
    expect(rocket?.text).toBe("🚀");
  } finally {
    vi.unstubAllGlobals();
  }
});
