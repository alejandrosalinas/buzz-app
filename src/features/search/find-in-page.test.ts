// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { FIND_LIMIT, findRanges } from "./find-in-page";

afterEach(() => {
  document.body.innerHTML = "";
});

const texts = (ranges: Range[]) => ranges.map((range) => range.toString());

it("finds every case-insensitive match, several per text node, in order", () => {
  document.body.innerHTML = "<p>Buzz buzz BUZZ</p><p>a <b>buzz</b>z</p>";
  const ranges = findRanges(document.body, "  bUZz ");
  expect(texts(ranges)).toEqual(["Buzz", "buzz", "BUZZ", "buzz"]);
  expect(ranges[3]?.startContainer.parentElement?.tagName).toBe("B");
});

it("does not overlap matches", () => {
  document.body.innerHTML = "<p>aaaa</p>";
  expect(findRanges(document.body, "aa")).toHaveLength(2);
});

it("returns nothing for an empty or whitespace query", () => {
  document.body.innerHTML = "<p>  text  </p>";
  expect(findRanges(document.body, "")).toEqual([]);
  expect(findRanges(document.body, "   ")).toEqual([]);
});

it("skips the excluded subtree, fields, editors, scripts, hidden labels and unselectable chrome", () => {
  document.body.innerHTML = `
    <p>match</p>
    <div id="bar"><span>match</span></div>
    <input value="match" />
    <textarea>match</textarea>
    <select><option>match</option></select>
    <div contenteditable="true"><p>match</p></div>
    <div contenteditable="false">match</div>
    <label class="sr-only">match</label>
    <button style="user-select: none">match</button>
    <script>match</script>
    <style>.match {}</style>`;
  const ranges = findRanges(
    document.body,
    "match",
    document.getElementById("bar"),
  );
  expect(
    ranges.map((range) => range.startContainer.parentElement?.tagName),
  ).toEqual(["P", "DIV"]);
});

it("skips content the engine reports as not visible", () => {
  document.body.innerHTML =
    '<p id="shown">match</p><section id="covered"><p>match</p></section>';
  // jsdom has no layout; a covered tab's descendants report as not visible.
  const hidden = document.querySelector<HTMLElement>("#covered p");
  if (hidden) hidden.checkVisibility = () => false;
  const ranges = findRanges(document.body, "match");
  expect(ranges).toHaveLength(1);
  expect(ranges[0]?.startContainer.parentElement?.id).toBe("shown");
});

it("skips inert content, which engines treat as unselectable", () => {
  // A collapsed drop target stays rendered and reports selectable text.
  document.body.innerHTML = `
    <p id="shown">match</p>
    <div inert aria-hidden="true" style="height: 0; overflow: hidden">
      <div><span>match</span></div>
    </div>`;
  const ranges = findRanges(document.body, "match");
  expect(ranges).toHaveLength(1);
  expect(ranges[0]?.startContainer.parentElement?.id).toBe("shown");
});

it("stops at the match limit", () => {
  document.body.innerHTML = `<p>${"x ".repeat(FIND_LIMIT + 5)}</p>`;
  expect(findRanges(document.body, "x")).toHaveLength(FIND_LIMIT);
});

it("keeps source offsets when lowercasing changes the text's length", () => {
  document.body.innerHTML = "<p>İstanbul buzz buzz</p><p>İx</p>";
  const offsets = (ranges: Range[]) =>
    ranges.map((range) => [range.startOffset, range.endOffset]);
  const buzz = findRanges(document.body, "buzz");
  expect(texts(buzz)).toEqual(["buzz", "buzz"]);
  expect(offsets(buzz)).toEqual([
    [9, 13],
    [14, 18],
  ]);
  const x = findRanges(document.body, "x");
  expect(texts(x)).toEqual(["x"]);
  expect(offsets(x)).toEqual([[1, 2]]);
  // A query that is itself the expanded character selects that one character.
  expect(texts(findRanges(document.body, "İ"))).toEqual(["İ", "İ"]);
});
