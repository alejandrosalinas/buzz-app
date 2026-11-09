import { expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { noSearchUsage, type SearchUsage } from "./usage";
import { personKey, rankPeople, type PersonCandidate } from "./people-rank";

const person = (
  pubkey: string,
  label: string,
  extra: Partial<PersonCandidate> = {},
): PersonCandidate => ({
  pubkey,
  label,
  agent: false,
  relationship: 4,
  usageKeys: [personKey(pubkey)],
  ...extra,
});
const order = (
  people: PersonCandidate[],
  needle: string,
  usage: SearchUsage = noSearchUsage,
  picked?: string,
) =>
  rankPeople(people, needle, usage, picked).map(({ person }) => person.label);

it("matches display names and usernames with the shared name rule", () => {
  const people = [
    person("a", "Alice Chen", { username: "achen" }),
    person("b", "Bob", { username: "bobby" }),
    person("c", "Rachel"),
  ];
  // A username is shown beside the label, so it ranks like the label.
  expect(order(people, "achen")).toEqual(["Alice Chen"]);
  expect(order(people, "chen")).toEqual(["Alice Chen"]);
  expect(order(people, "bob")).toEqual(["Bob"]);
  // Not a word start: the person rule does not match inside a word.
  expect(order(people, "ache")).toEqual(["Alice Chen"]);
  expect(order(people, "hel")).toEqual([]);
});

const sam = "a".repeat(64);
it.each([
  ["hex key", sam],
  ["uppercase hex key", sam.toUpperCase()],
  ["npub", npubEncode(sam)],
  ["nostr: npub", `nostr:${npubEncode(sam)}`],
])(
  "keeps only the person a typed %s names, as an exact match",
  (_case, key) => {
    const people = [
      person("b".repeat(64), "Alex Stone", { relationship: 0 }),
      person(sam, "Sam Rivera"),
    ];
    // Score -2 is an exact match (rank 0), ahead of every other row.
    expect(
      rankPeople(people, key, noSearchUsage, undefined).map(
        ({ person, score }) => [person.label, score],
      ),
    ).toEqual([["Sam Rivera", -2]]);
  },
);

it("ranks an exact name first, then relationship bands, as New message does", () => {
  const people = [
    person("dm", "Sam Ortiz", { relationship: 0 }),
    person("stranger", "Sam", { relationship: 4 }),
    person("shared", "Samantha", { relationship: 3 }),
  ];
  expect(order(people, "sam")).toEqual(["Sam", "Sam Ortiz", "Samantha"]);
  // Without an exact name, the closer relationship leads.
  expect(order(people, "sa")).toEqual(["Sam Ortiz", "Samantha", "Sam"]);
});

it("puts the earlier choice for this text and usage ahead, within the order", () => {
  const people = [person("a", "Dana One"), person("b", "Dana Two")];
  expect(order(people, "dana", noSearchUsage, personKey("b"))).toEqual([
    "Dana Two",
    "Dana One",
  ]);
  const usage: SearchUsage = {
    boost: (...keys) => (keys.includes(personKey("b")) ? 1 : 0),
    pick: () => undefined,
  };
  expect(order(people, "dana", usage)).toEqual(["Dana Two", "Dana One"]);
});

it.each(["", " \t "])(
  "orders idle suggestions by relationship and usage for %j",
  (needle) => {
    const people = [
      person("stranger", "Stranger"),
      person("managed", "Managed", { agent: true, relationship: 2 }),
      person("visited", "Visited", { agent: true, relationship: 2 }),
      person("other-dm", "Other DM", { relationship: 0 }),
      person("dm", "Direct", {
        relationship: 0,
        usageKeys: [personKey("dm"), "channel:dm"],
      }),
    ];
    const usage: SearchUsage = {
      boost: (...keys) =>
        keys.includes(personKey("visited")) || keys.includes("channel:dm")
          ? 1
          : 0,
      pick: () => undefined,
    };
    expect(order(people, needle, usage)).toEqual([
      "Direct",
      "Other DM",
      "Visited",
      "Managed",
      "Stranger",
    ]);
  },
);

it("ranks a hidden agent name after shown names, as mentions do", () => {
  const people = [
    person("agent", "Helper Bot", {
      agent: true,
      agentName: "Robin",
    }),
    person("human", "Robin Wu"),
  ];
  // "Robin Wu" starts with the text (tier 1); the agent's own name is hidden (4).
  expect(order(people, "robin")).toEqual(["Robin Wu", "Helper Bot"]);
});

it("keeps the given order for ties, as New message keeps the directory's", () => {
  const people = [
    person("z", "Zed Agent", { agent: true }),
    person("p", "Kim Park"),
    person("l", "Kim Lee"),
  ];
  expect(order(people, "kim")).toEqual(["Kim Park", "Kim Lee"]);
  expect(order(people, "z")).toEqual(["Zed Agent"]);
  expect(order([...people].reverse(), "kim")).toEqual(["Kim Lee", "Kim Park"]);
});

it("matches a verified full name like the label", () => {
  const people = [
    person("a", "fname", { fullName: "Fake Name" }),
    person("b", "Fake"),
  ];
  expect(order(people, "name")).toEqual(["fname"]);
  expect(order(people, "fake n")).toEqual(["fname"]);
  // An exact shown name still comes first.
  expect(order(people, "fake")).toEqual(["Fake", "fname"]);
});
