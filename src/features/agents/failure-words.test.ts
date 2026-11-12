import { expect, it } from "vitest";
import { withProviderWords } from "./failure-words";

it("follows the explanation with the provider's words, quoted and attributed", () => {
  expect(
    withProviderWords(
      "Head to [Settings](buzz://settings) to sign in.",
      "Codex",
      "unexpected status 401 Unauthorized",
    ),
  ).toBe(
    "Head to [Settings](buzz://settings) to sign in.\n\nCodex said:\n> unexpected status 401 Unauthorized",
  );
});

it("quotes every line of the provider's words, without stray whitespace", () => {
  expect(
    withProviderWords("Explained.", "goose", "  first\r\n\nsecond  \n\n"),
  ).toBe("Explained.\n\ngoose said:\n> first\n>\n> second");
});

it("quotes at most 500 characters of the provider's words, marking the cut", () => {
  expect(withProviderWords("Explained.", "Codex", "a".repeat(501))).toBe(
    `Explained.\n\nCodex said:\n> ${"a".repeat(500)}…`,
  );
  // 500 characters is all of them: nothing is cut.
  expect(withProviderWords("Explained.", "goose", "a".repeat(500))).toBe(
    `Explained.\n\ngoose said:\n> ${"a".repeat(500)}`,
  );
});

it("lets the explanation stand alone when the provider said nothing", () => {
  for (const words of ["", "  \n\t "])
    expect(withProviderWords("Explained.", "Claude", words)).toBe("Explained.");
});
