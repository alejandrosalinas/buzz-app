// Combining marks (the vowel sign in "की") belong to the letter before them.
const isWordChar = (char: string | undefined) =>
  /[\p{L}\p{M}\p{N}]/u.test(char ?? "");

/** How well a label matches typed text, best first. Ranks are whole numbers,
 * so callers can order them and add fractional tie-breaks. */
export const MatchRank = {
  exact: 0,
  prefix: 1,
  /** The text starts a later word. */
  wordStart: 2,
  substring: 3,
  /** Each letter continues a run that began at a word start ("tlp" in
   * "team-launch-planning"). */
  wordRuns: 4,
  /** Each typed word appears in the name, in any order ("team buzz" in
   * "buzz-hive-team"). Words split on spaces and punctuation. */
  words: 5,
} as const;
export type MatchRank = (typeof MatchRank)[keyof typeof MatchRank];

/** How well a label matches typed text (`MatchRank`), or undefined for no
 * match. `positions` are the matched code points of the label, for
 * underlining. */
export function matchName(
  label: string,
  needle: string,
): { rank: MatchRank; positions: number[] } | undefined {
  const text = label.toLowerCase();
  const chars = [...text];
  // Lowercasing can change a label's length (İ → i̇). Rank it, but do not
  // underline positions that would land on the wrong letters.
  const aligned = chars.length === [...label].length;
  const found = (rank: MatchRank, positions: number[]) => ({
    rank,
    positions: aligned ? positions : [],
  });
  const run = (at: number, typed = needle) => {
    const from = [...text.slice(0, at)].length;
    return Array.from({ length: [...typed].length }, (_, n) => from + n);
  };
  if (text === needle) return found(MatchRank.exact, run(0));
  let substring: number | undefined;
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + 1)
  ) {
    if (at === 0) return found(MatchRank.prefix, run(0));
    if (!isWordChar(text[at - 1])) return found(MatchRank.wordStart, run(at));
    substring ??= at;
  }
  if (substring !== undefined)
    return found(MatchRank.substring, run(substring));
  // Spaces in typed text only separate words; they need not match.
  const letters = [...needle.replace(/\s+/g, "")];
  if (!letters.length) return undefined;
  // Word runs need the letters in order, so a name without them skips the
  // word-run search.
  let inOrder = 0;
  for (const char of chars) if (char === letters[inOrder]) inOrder += 1;
  // Can letters[i..] match chars[j..] with every run starting at a word start?
  // `inRun` means the previous letter matched chars[j - 1].
  const memo = new Map<number, boolean>();
  const takes = (i: number, j: number, inRun: boolean) =>
    chars[j] === letters[i] &&
    (inRun || !isWordChar(chars[j - 1])) &&
    wordRuns(i + 1, j + 1, true);
  const wordRuns = (i: number, j: number, inRun: boolean): boolean => {
    if (i === letters.length) return true;
    if (j === chars.length) return false;
    const key = (i * (chars.length + 1) + j) * 2 + (inRun ? 1 : 0);
    const known = memo.get(key);
    if (known !== undefined) return known;
    const result = takes(i, j, inRun) || wordRuns(i, j + 1, false);
    memo.set(key, result);
    return result;
  };
  if (inOrder === letters.length && wordRuns(0, 0, false)) {
    // Replay the same choices the search made: take a letter when it leads
    // to a full match, otherwise skip the character.
    const positions: number[] = [];
    for (let i = 0, j = 0, inRun = false; i < letters.length; j += 1) {
      inRun = takes(i, j, inRun);
      if (inRun) {
        positions.push(j);
        i += 1;
      }
    }
    return found(MatchRank.wordRuns, positions);
  }
  // Last, each typed word must appear whole, preferably where a word starts.
  // Scattered single letters never match.
  const words = needle.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  if (!words.length) return undefined;
  const positions = new Set<number>();
  for (const word of words) {
    // A one-letter word ("q" in "q&a", or "की" with its vowel sign) matches
    // only a one-letter word, so it cannot land inside a longer one.
    const single = [...word.replace(/\p{M}/gu, "")].length === 1;
    const whole = (at: number) =>
      !isWordChar(text[at - 1]) &&
      (!single || !isWordChar(text[at + word.length]));
    let at = text.indexOf(word);
    const inside = single ? -1 : at;
    while (at >= 0 && !whole(at)) at = text.indexOf(word, at + 1);
    if (at < 0) at = inside;
    if (at < 0) return undefined;
    for (const position of run(at, word)) positions.add(position);
  }
  return found(
    MatchRank.words,
    [...positions].sort((a, b) => a - b),
  );
}

export const matchRank = (label: string, needle: string) =>
  matchName(label, needle)?.rank;
