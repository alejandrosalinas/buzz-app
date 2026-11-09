import { expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import {
  continuedMention,
  continuingNames,
  exactMention,
  matchingMentions,
  rankMentions,
  type MentionChoice,
} from "./mention-ranking";
import { fixtureChoice, mentionConformance } from "./mention-rules.conformance";
import { matchPerson, nameStarts } from "../../features/search/person-match";
const choice = (
  key: string,
  name: string,
  extra: Partial<MentionChoice> = {},
): MentionChoice => ({
  recipient: { pubkey: key.repeat(64), name },
  label: name,
  aliases: [name],
  member: true,
  agent: false,
  managed: false,
  owned: false,
  ...extra,
});
it("breaks visible match ties by base-name quality, then the full displayed label", () => {
  const rows = [
    choice("3", "Fast Fizz", { agent: true }),
    choice("0", "Fizz", { agent: true, label: "baxen’s Fizz · oncp" }),
    choice("4", "Fizz", { agent: true, label: "baxen’s Fizz · s03j" }),
    choice("5", "Fizz", { agent: true, label: "Kenny Lopez’s Fizz" }),
    choice("b", "Fizz", { agent: true, label: "baxen’s Fizz · 4prr" }),
    choice("c", "Fizz", { agent: true, label: "baxen’s Fizz · 06pl" }),
  ];
  const expected = [rows[5], rows[4], rows[1], rows[2], rows[3], rows[0]];
  expect(rankMentions(rows, "fizz")).toEqual(expected);
  expect(rankMentions([...rows].reverse(), "FIZZ")).toEqual(expected);
  const alias = choice("d", "Another name", {
    label: "Other Fizz",
    aliases: ["Another name", "Fizz"],
  });
  expect(rankMentions([choice("3", "Fast Fizz"), alias], "fizz")[0]).toBe(
    alias,
  );
});
it("sorts equal matches by case-insensitive displayed labels and only then keys", () => {
  const a = choice("a", "Hidden A", { label: "Zoe", aliases: ["common"] });
  const b = choice("b", "Hidden B", { label: "amy", aliases: ["common"] });
  const c = choice("c", "Hidden C", { label: "Amy", aliases: ["common"] });
  expect(rankMentions([c, a, b], "common")).toEqual([b, c, a]);
  expect(rankMentions([c, a, b], "")).toEqual([b, c, a]);
});

it("matches a complete key only to its owner, never partial keys or key text in a name", () => {
  const key =
    "150b20bdf6130418df9239dd1bd082c71612c8d653b47c277200365b9be215dc";
  const row = choice("a", "Bad Janet", {
    recipient: { pubkey: key, name: "Bad Janet" },
  });
  const npub = npubEncode(key);
  const namesake = choice("b", "Bad Janet");
  const impostor = choice("c", npub);
  for (const query of [
    "h",
    key.slice(0, 12),
    key.slice(-8),
    npub.slice(0, 15),
    npub.slice(-6),
    // Mixed case is not bech32, and a 20-byte payload is not a public key.
    `NPUB1${npub.slice(5)}`,
    "npub1qurswpc8qurswpc8qurswpc8qurswpc86nz8sw",
  ]) {
    expect(rankMentions([row], query), query).toEqual([]);
    expect(exactMention([row], query), query).toBeUndefined();
  }
  const unnamed = { ...row, label: "npub…15dc", aliases: [] };
  for (const query of [
    key,
    key.toUpperCase(),
    npub,
    `nostr:${npub}`,
    npub.toUpperCase(),
    ` ${npub} `,
  ]) {
    expect(rankMentions([row, impostor], query), query).toEqual([row]);
    expect(exactMention([row, namesake, impostor], query), query).toBe(key);
    expect(matchingMentions([row, namesake, impostor], query), query).toEqual([
      row,
    ]);
    expect(rankMentions([unnamed], query), query).toEqual([unnamed]);
    expect(exactMention([unnamed], query), query).toBe(key);
  }
  expect(rankMentions([row], "jan")).toEqual([row]);
});

it("ranks outside humans and agents in one relevance group", () => {
  const human = choice("a", "Honey", { member: false });
  const agent = choice("b", "Honey Bee", {
    member: false,
    agent: true,
    owned: true,
  });
  const member = choice("c", "A Honey");
  expect(rankMentions([agent, human, member], "honey")).toEqual([
    member,
    human,
    agent,
  ]);
});
const permutations = <T>(items: readonly T[]): T[][] =>
  items.length < 2
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(
          (rest) => [item, ...rest],
        ),
      );
it("orders mixed people and agents the same way from every input order", () => {
  // Review case: owned Zed, unowned Alpha, human Mary. A pairwise agent-only
  // ownership rule made Zed < Alpha < Mary < Zed, a cycle.
  const zed = choice("a", "Zed", { agent: true, owned: true });
  const alpha = choice("b", "Alpha", { agent: true });
  const mary = choice("c", "Mary");
  for (const rows of permutations([zed, alpha, mary]))
    expect(rankMentions(rows, "")).toEqual([zed, alpha, mary]);
  // Same-name agents stay one block at its first label. Recency, managed and
  // presence order only that block, never a person or another name between.
  const recent = choice("d", "Honey", { agent: true, label: "Honey · zz" });
  const managed = choice("e", "Honey", {
    agent: true,
    managed: true,
    label: "Wes’s Honey",
  });
  const online = choice("f", "Honey", { agent: true, label: "Honey · aa" });
  const human = choice("1", "Honey · b");
  const other = choice("2", "Honey Bee", { agent: true, label: "Honey · c" });
  const history = new Map([[recent.recipient.pubkey, 2]]);
  const presence = (key: string) =>
    key === online.recipient.pubkey ? "online" : "unknown";
  for (const rows of permutations([recent, managed, online, human, other]))
    expect(rankMentions(rows, "", history, presence)).toEqual([
      recent,
      managed,
      online,
      human,
      other,
    ]);
});

it("a limit keeps the first rows of the full order", () => {
  // Namesake agents, people, members, outsiders and equal labels, so every
  // ranking key decides some pair.
  const names = ["Honey", "Honey Bee", "honey", "Hank", "Bea", "Zed"];
  const rows = Array.from({ length: 240 }, (_, i) => {
    const name = names[i % names.length] ?? "";
    const key = i.toString(16).padStart(64, "0");
    return {
      ...choice("0", name, {
        agent: i % 3 === 0,
        owned: i % 5 === 0,
        managed: i % 7 === 0,
        member: i % 4 !== 0,
        ...(i % 11 ? {} : { elsewhere: "Other" }),
        label: i % 2 ? `${name} · ${key.slice(-4)}` : name,
        aliases: i % 13 ? [name] : [],
      }),
      recipient: { pubkey: key, name },
    };
  });
  const history = new Map(
    rows.flatMap((c, i) => (i % 9 ? [] : [[c.recipient.pubkey, i]])),
  );
  const presence = (key: string) =>
    ["online", "away", "unknown"][Number.parseInt(key.slice(-1), 16) % 3] ??
    "unknown";
  for (const query of ["", "h", "honey", "honey b", "bea", "nobody"]) {
    const full = rankMentions(rows, query, history, presence);
    for (const limit of [0, 1, 7, 50, full.length, full.length + 1])
      expect(rankMentions(rows, query, history, presence, limit)).toEqual(
        full.slice(0, limit),
      );
  }
  // A bare `@` has no exact or continuing name.
  expect(continuingNames(rows, " ")).toEqual([]);
  expect(exactMention(rows, "")).toBeUndefined();
});
it("a known longer name continues the query, except an identity's own beside its exact name", () => {
  const longer = choice("1", "Mira Example");
  expect(continuedMention([longer], "mira")).toBe(true);
  expect(continuedMention([longer], "Mira Example")).toBe(false);
  // The continuing names, each once, for a pending mention to extend over.
  expect(
    continuingNames(
      [longer, choice("5", "Mira Example"), choice("6", "Mira Example Two")],
      "mira",
    ),
  ).toEqual(["Mira Example", "Mira Example Two"]);
  expect(continuingNames([longer], "Mira Example")).toEqual([]);
  // Section 5's exception: `Example Agent` is another name of the `Example`
  // agent, not a namesake, so it neither continues nor blocks `example`.
  const self = choice("2", "Example", {
    agent: true,
    aliases: ["Example Agent", "Example"],
    label: "Example Agent",
  });
  expect(continuedMention([self], "example")).toBe(false);
  expect(exactMention([self], "example")).toBe(self.recipient.pubkey);
  // A key qualifier or generated `(agent)` suffix is not a longer name.
  expect(
    continuedMention(
      [
        choice("3", "Mira", { label: "Mira · 4prr", qualifier: "4prr" }),
        choice("4", "Mira", { agent: true, label: "Mira (agent)" }),
      ],
      "mira",
    ),
  ).toBe(false);
});
it("validates the portable mention fixture version and case lists", () => {
  expect(mentionConformance.version).toBe(3);
  expect(mentionConformance.matching.length).toBeGreaterThan(0);
  expect(mentionConformance.ranking.length).toBeGreaterThan(0);
  expect(mentionConformance.space.length).toBeGreaterThan(0);
});
it.each(mentionConformance.matching)(
  "conforms to the portable matching contract: $name",
  (fixture) => {
    expect(matchPerson(fixture.label, fixture.query)?.tier ?? null).toBe(
      fixture.expected,
    );
  },
);
it.each(mentionConformance.ranking)(
  "conforms to the portable ranking contract: $name",
  (fixture) => {
    const ranked = rankMentions(
      fixture.choices.map(fixtureChoice),
      fixture.query,
      new Map(Object.entries(fixture.history ?? {})),
      (key) => fixture.presence?.[key] ?? "unknown",
    );
    expect(ranked.map((c) => c.recipient.pubkey)).toEqual(fixture.expected);
  },
);
it.each(mentionConformance.space)(
  "conforms to the portable Space contract: $name",
  (fixture) => {
    expect(
      exactMention(fixture.choices.map(fixtureChoice), fixture.query) ?? null,
    ).toBe(fixture.expected);
  },
);

it("finds every ranked and Space choice through the name index", () => {
  // The index is a prefilter: every portable fixture must rank, and choose on
  // Space, exactly as it does when ranking reads the whole choice list.
  for (const { query, choices } of [
    ...mentionConformance.ranking,
    ...mentionConformance.space,
  ]) {
    const rows = choices.map(fixtureChoice);
    const found = matchingMentions(rows, query);
    expect(rankMentions(found, query)).toEqual(rankMentions(rows, query));
    expect(exactMention(found, query)).toBe(exactMention(rows, query));
  }
  for (const { name, label, query, expected } of mentionConformance.matching) {
    const row = choice("a", label, { label, aliases: [label] });
    if (expected !== null)
      expect(matchingMentions([row], query), name).toEqual([row]);
  }
});

it("returns index matches in list order and skips names that cannot match", () => {
  const rows = [
    choice("1", "Mary-Jane Watson"),
    choice("2", "Honey"),
    choice("3", "Jane Doe"),
    choice("4", "Agent", { label: "Agent · jane" }),
  ];
  expect(matchingMentions(rows, "jane")).toEqual([rows[0], rows[2], rows[3]]);
  expect(matchingMentions(rows, "oney")).toEqual([]);
  expect(matchingMentions(rows, "jane d")).toEqual([rows[2]]);
  expect(matchingMentions(rows, "")).toBe(rows);
  // A repeated query reuses its matches; another query is matched afresh.
  const jane = matchingMentions(rows, "Jane");
  expect(matchingMentions(rows, "jane")).toBe(jane);
  expect(matchingMentions(rows, "hon")).toEqual([rows[1]]);
  expect(matchingMentions(rows, "jane")).toEqual(jane);
});

it("bounds index work for long profile names and still matches them", () => {
  // Profile names are member input of any length.
  const words = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ");
  const long = `${"x".repeat(4000)}-tail`;
  const starts = nameStarts(words);
  expect(starts.complete).toBe(false);
  expect(starts.starts).toHaveLength(16);
  for (const name of [words, long])
    for (const start of nameStarts(name).starts)
      expect([...start].length).toBeLessThanOrEqual(32);
  const rows = [
    choice("1", words),
    choice("2", long),
    choice("3", "Wanda"),
    choice("4", "Xavier"),
  ];
  // Late words and queries longer than a key still rank as without the index.
  for (const query of [
    "w3999",
    "w39",
    "tail",
    "w",
    "x".repeat(40),
    `${"x".repeat(4000)}-t`,
    "wanda",
  ]) {
    const found = matchingMentions(rows, query);
    expect(rankMentions(found, query), query).toEqual(
      rankMentions(rows, query),
    );
    expect(exactMention(found, query), query).toBe(exactMention(rows, query));
  }
  expect(matchingMentions(rows, "w3999")).toContain(rows[0]);
  expect(matchingMentions(rows, "tail")).toContain(rows[1]);
});
