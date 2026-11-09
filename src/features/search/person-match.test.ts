import { describe, expect, it } from "vitest";
import {
  exactName,
  extendsName,
  foldName,
  matchPerson,
  matchTier,
  normalizeName,
} from "./person-match";

describe("matchPerson", () => {
  it.each([
    ["Honey Bee", "honey b", 1],
    ["Honey Bee", "honey  b", undefined],
  ])("%s for %s is tier %s", (name, query, tier) => {
    expect(matchPerson(name, query)?.tier).toBe(tier);
  });

  it("matches everything for an empty query", () => {
    expect(matchPerson("Anyone", "  ")).toEqual({ tier: 0, positions: [] });
  });

  it("underlines the name's own code points", () => {
    expect(matchPerson("Mary José", "jose")?.positions).toEqual([5, 6, 7, 8]);
    // A decomposed accent folds into its base letter.
    expect(matchPerson("Jose\u0301 Luis", "jose l")?.positions).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    // One ligature code point covers two typed letters.
    expect(matchPerson("ﬁona", "fio")?.positions).toEqual([0, 1]);
    expect(matchPerson("  Honey", "hon")?.positions).toEqual([2, 3, 4]);
  });

  it("gives matchTier the tier of matchPerson, repeated and across queries", () => {
    const names = [
      "Mary José",
      "Jose\u0301 Luis",
      "ﬁona",
      "  Honey ",
      "ΟΔΥΣΣΕΥΣ",
      "a-b",
    ];
    const queries = [
      "jose",
      "jose l",
      "fio",
      "hon",
      "οδυσσευσ",
      "b",
      "",
      "  ",
      "zz",
    ];
    for (const query of queries)
      for (const name of [...names, ...names])
        expect(matchTier(name, [...normalizeName(query)])).toBe(
          matchPerson(name, query)?.tier,
        );
  });

  it("normalizes the way it matches", () => {
    expect(normalizeName("  ÉLODIE ")).toBe("elodie");
    expect(foldName("José ")).toBe("jose ");
    // Cached folds normalize as a fresh fold does, short or long, repeated or not.
    const long = `${"é".repeat(130)} X`;
    // Short, but folds to more than 128 code points, so it is not kept.
    const wide = "ﷺ".repeat(8);
    for (const name of [
      "  José ",
      "ﬁona",
      "ΟΔΥΣΣΕΥΣ",
      "a\u0301",
      long,
      long,
      wide,
      wide,
      "  José ",
    ])
      expect(normalizeName(name)).toBe(foldName(name).trim());
  });

  it("finds a longer name only when it continues with a new word", () => {
    expect(extendsName("José Luis", "jose")).toBe(true);
    expect(extendsName("Jose-Luis", "jose")).toBe(true);
    expect(extendsName("Jose\tLuis", "jose")).toBe(true);
    expect(extendsName("Josefa", "jose")).toBe(false);
    expect(extendsName("Jose", "jose")).toBe(false);
    expect(extendsName("Jose ", "jose")).toBe(false);
    expect(extendsName("Anything", "")).toBe(false);
  });
});

describe("exactName", () => {
  const names = (item: { names: string[] }) => item.names;
  const of = (...list: string[][]) => list.map((n) => ({ names: n }));

  it("finds the one item whose name is the query, without accents or case", () => {
    const people = of(["José"], ["Joseph"]);
    expect(exactName(people, names, " jose ")).toBe(people[0]);
  });

  it("waits for a namesake or a longer name that continues the query", () => {
    expect(exactName(of(["Avery"], ["Avery"]), names, "avery")).toBeUndefined();
    expect(
      exactName(of(["Avery"], ["Avery Chen"]), names, "avery"),
    ).toBeUndefined();
    expect(exactName(of(["Avery"]), names, "")).toBeUndefined();
  });

  it("lets items it cannot choose still block a completion", () => {
    const people = of(["Avery"], ["Avery-Lee"], ["Sam"]);
    const allowed = (item: { names: string[] }) => item !== people[1];
    expect(exactName(people, names, "avery", allowed)).toBeUndefined();
    expect(exactName(people, names, "avery-lee", allowed)).toBeUndefined();
    expect(exactName(people, names, "sam", allowed)).toBe(people[2]);
  });
});
