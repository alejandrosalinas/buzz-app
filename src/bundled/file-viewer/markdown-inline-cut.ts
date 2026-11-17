// Where a forced cut can split one long source line without breaking inline
// Markdown: each side is parsed alone, so a code span, link or emphasis
// crossing the cut would lose its formatting on both sides.

const punctuation = /[\p{P}\p{S}]/u;
const space = /\s/u;
const wordStart = /[\p{L}\p{N}]/u;

function closes(text: string, from: number, limit: number, size: number) {
  let at = from;
  while (at < limit) {
    if (text.charCodeAt(at) !== 96) {
      at++;
      continue;
    }
    let end = at + 1;
    while (text.charCodeAt(end) === 96) end++;
    if (end - at === size) return end;
    at = end;
  }
  return undefined;
}

function find(text: string, from: number, limit: number, code: number) {
  for (let at = from; at < limit; at++)
    if (text.charCodeAt(at) === code) return at;
  return -1;
}

/** The last offset in [min, max] that starts a word after whitespace with no
 * code span, link or emphasis open, scanning from `from`, where none is; else
 * `max` itself if nothing is open there. Closers are looked for up to
 * `limit`; an opener with none is literal. */
export function inlineCut(
  text: string,
  from: number,
  min: number,
  max: number,
  limit: number,
): number | undefined {
  let found: number | undefined;
  let brackets = 0;
  let destination = 0;
  const open = { "*": 0, _: 0, "~": 0 };
  let bracket = 0;
  let at = from;
  while (at <= max) {
    const char = text.charAt(at);
    if (char === "\\" && punctuation.test(text.charAt(at + 1))) {
      at += 2;
      continue;
    }
    if (char === "`") {
      let end = at + 1;
      while (text.charAt(end) === "`") end++;
      const close = closes(text, end, limit, end - at);
      at = close ?? end;
      continue;
    }
    if (destination) {
      if (char === "(") destination++;
      else if (char === ")") destination--;
      at++;
      continue;
    }
    if (char === "[") {
      if (bracket !== -1 && bracket <= at)
        bracket = find(text, at + 1, limit, 93);
      if (bracket > at) brackets++;
    } else if (char === "]" && brackets) {
      brackets--;
      if (text.charAt(at + 1) === "(") {
        destination = 1;
        at += 2;
        continue;
      }
    } else if (char === "*" || char === "_" || char === "~") {
      let end = at + 1;
      while (text.charAt(end) === char) end++;
      const before = text.charAt(at - 1) || " ",
        after = text.charAt(end) || " ";
      const left =
        !space.test(after) &&
        (!punctuation.test(after) ||
          space.test(before) ||
          punctuation.test(before));
      const right =
        !space.test(before) &&
        (!punctuation.test(before) ||
          space.test(after) ||
          punctuation.test(after));
      const canOpen =
        char === "_" ? left && (!right || punctuation.test(before)) : left;
      const canClose =
        char === "_" ? right && (!left || punctuation.test(after)) : right;
      if (canClose && open[char]) open[char]--;
      else if (canOpen) open[char]++;
      at = end;
      continue;
    }
    if (
      at >= min &&
      at > from &&
      space.test(text.charAt(at - 1)) &&
      wordStart.test(char) &&
      !brackets &&
      !open["*"] &&
      !open._ &&
      !open["~"]
    )
      found = at;
    at++;
  }
  const neutral =
    at === max + 1 && !brackets && !open["*"] && !open._ && !open["~"];
  return found ?? (neutral ? max : undefined);
}
