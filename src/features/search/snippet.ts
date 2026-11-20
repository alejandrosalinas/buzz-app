/**
 * The words a message search looks for, for highlighting: quoted phrases and
 * plain words, without `-` exclusions or `or`. The relay matches the last
 * word as a prefix, so every word highlights as a word start.
 */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  const parts = text.split('"');
  parts.forEach((part, index) => {
    if (index % 2) {
      if (part.trim()) terms.push(part.trim().toLowerCase());
      return;
    }
    for (const word of part.split(/\s+/)) {
      const clean = word.replace(/^[^\p{L}\p{N}-]+|[^\p{L}\p{N}]+$/gu, "");
      if (!clean || clean.startsWith("-") || clean.toLowerCase() === "or")
        continue;
      terms.push(clean.toLowerCase());
    }
  });
  return [...new Set(terms)].sort((a, b) => b.length - a.length);
}

const isWordChar = (char: string | undefined) =>
  !!char && /[\p{L}\p{N}]/u.test(char);

/** Where `terms` start words in `text`, as UTF-16 `[start, end)` ranges. */
function termRanges(text: string, terms: readonly string[]) {
  // Lowercase the whole text, as the terms are, so context-dependent folding
  // ("ΟΔΟΣ" to "οδος") agrees. Where that lengthens a character (as "İ"
  // does), fold each character alone, keeping any that would lengthen, so
  // offsets found here stay offsets in `text`.
  const whole = text.toLowerCase();
  const lower =
    whole.length === text.length
      ? whole
      : Array.from(text, (char) => {
          const folded = char.toLowerCase();
          return folded.length === char.length ? folded : char;
        }).join("");
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      from = at + term.length;
      if (isWordChar(lower[at - 1])) continue;
      if (ranges.some(([start, end]) => at < end && at + term.length > start))
        continue;
      ranges.push([at, at + term.length]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Code point positions in `text` covered by `ranges`, as MatchedLabel takes. */
function codePoints(text: string, ranges: readonly [number, number][]) {
  const positions: number[] = [];
  let point = 0;
  for (let unit = 0; unit < text.length; point++) {
    if (ranges.some(([start, end]) => unit >= start && unit < end))
      positions.push(point);
    unit += (text.codePointAt(unit) ?? 0) > 0xffff ? 2 : 1;
  }
  return positions;
}

/**
 * A window of `text` about `width` characters long, starting a little before
 * the first matched word, with the code points of every match in it, and
 * where the window starts in `text` with whitespace runs collapsed and
 * trimmed.
 */
export function snippet(
  text: string,
  terms: readonly string[],
  width = 180,
): { text: string; matches: number[]; start: number } {
  const flat = text.replace(/\s+/g, " ").trim();
  const ranges = termRanges(flat, terms);
  const first = ranges[0]?.[0] ?? 0;
  let start = first < width / 3 ? 0 : first - Math.floor(width / 3);
  // Start at a word.
  if (start > 0) {
    const space = flat.lastIndexOf(" ", start);
    start = space >= 0 && first - space < width / 2 ? space + 1 : start;
  }
  let end = Math.min(flat.length, start + width);
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > first) end = space;
  }
  const lead = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  const body = flat.slice(start, end);
  const shifted = ranges
    .filter(([s, e]) => s >= start && e <= end)
    .map(([s, e]): [number, number] => [
      s - start + lead.length,
      e - start + lead.length,
    ]);
  const shown = `${lead}${body}${tail}`;
  return { text: shown, matches: codePoints(shown, shifted), start };
}

/** Code points of `text` that match `terms`, for highlighting it whole. */
export function termMatches(text: string, terms: readonly string[]) {
  return codePoints(text, termRanges(text, terms));
}
