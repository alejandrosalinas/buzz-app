/** How much of a provider's own words a failed turn's reply quotes: as much
 * as a report keeps of any failure. */
const QUOTED = 500;

/** A failed turn's reply once `explanation` (Markdown, such as a sentence
 * that links Settings) explains it: the explanation first, then, after a
 * blank line, what `who` said, quoted on the lines right under it, so the
 * thread keeps the provider's words rather than only the Activity tab. Words
 * cut short end in "…"; with no words, the explanation stands alone. */
export function withProviderWords(
  explanation: string,
  who: string,
  words: string,
) {
  const said = words.trim();
  if (!said) return explanation;
  const kept =
    said.length > QUOTED ? `${said.slice(0, QUOTED).trimEnd()}…` : said;
  const quote = kept
    .split(/\r\n?|\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  return `${explanation}\n\n${who} said:\n${quote}`;
}
