import { describe, expect, it } from "vitest";
import { inlineCut } from "./markdown-inline-cut";

const cut = (text: string, max: number, min = 0) =>
  inlineCut(text, 0, min, max, text.length);

describe("inlineCut", () => {
  it("cuts before a code span that reaches the limit", () => {
    const text = "one two `three four five` six";
    expect(cut(text, text.indexOf("four"))).toBe(text.indexOf("two"));
    expect(cut(text, text.length - 1)).toBe(text.indexOf("six"));
  });

  it("keeps link text and destinations whole", () => {
    const text = "one two [three four](a (b) c) five";
    expect(cut(text, text.indexOf("four"))).toBe(text.indexOf("two"));
    expect(cut(text, text.indexOf("c)"))).toBe(text.indexOf("two"));
    expect(cut(text, text.length - 1)).toBe(text.indexOf("five"));
  });

  it("keeps emphasis and strikethrough whole", () => {
    for (const mark of ["*", "**", "_", "~~"]) {
      const text = `one two ${mark}three four${mark} five`;
      expect(cut(text, text.indexOf("four"))).toBe(text.indexOf("two"));
      expect(cut(text, text.length - 1)).toBe(text.indexOf("five"));
    }
  });

  it("treats unmatched and intraword delimiters as literal", () => {
    expect(cut("one ` two three", 14)).toBe(10);
    expect(cut("snake_case and 2 * 3 here", 24)).toBe(21);
    expect(cut("a [ b c", 6)).toBe(6);
    expect(cut("one \\`two three` four", 20)).toBe(17);
  });

  it("falls back to the limit itself only when nothing is open there", () => {
    expect(cut("a".repeat(100), 50)).toBe(50);
    expect(cut(`\`${"a".repeat(100)}\``, 50)).toBeUndefined();
    expect(cut(`one \`${"two ".repeat(20)}\``, 60, 10)).toBeUndefined();
  });
});
