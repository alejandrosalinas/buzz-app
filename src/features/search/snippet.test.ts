import { expect, it } from "vitest";
import { searchTerms, snippet, termMatches } from "./snippet";

const marked = (text: string, positions: readonly number[]) =>
  [...text].filter((_, index) => positions.includes(index)).join("");

it("searches words and phrases, not exclusions or OR", () => {
  expect(searchTerms('remote agent -staging OR "pull request"')).toEqual([
    "pull request",
    "remote",
    "agent",
  ]);
});

it("highlights word starts only", () => {
  const text = "Remote agents, not premote";
  expect(marked(text, termMatches(text, ["remote", "agent"]))).toBe(
    "Remoteagent",
  );
});

it("windows a long message around its first match, on word boundaries", () => {
  const text = `${"early words ".repeat(30)}the remote agent shipped ${"late words ".repeat(30)}`;
  const shown = snippet(text, ["remote"], 80);
  expect(shown.text.startsWith("…")).toBe(true);
  expect(shown.text.endsWith("…")).toBe(true);
  expect(shown.text).toContain("remote agent");
  expect(marked(shown.text, shown.matches)).toBe("remote");
});

it("highlights where the match is when lowercasing lengthens earlier text", () => {
  const text = "İİ remote";
  expect(marked(text, termMatches(text, ["remote"]))).toBe("remote");
});

it.each(["ΟΔΟΣ", "οδος"])(
  "highlights a word ending in a capital sigma when searching %s",
  (query) => {
    const text = "ΟΔΟΣ τώρα";
    expect(marked(text, termMatches(text, searchTerms(query)))).toBe("ΟΔΟΣ");
  },
);
