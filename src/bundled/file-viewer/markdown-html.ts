import { required } from "./markdown-limits";
// Shared CommonMark blank-terminated HTML block recognition. Closing raw
// script/style/pre/textarea, comments and other explicit closers stay with callers.
const blockNames = new Set(
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(
    " ",
  ),
);

/** CommonMark HTML-block condition 6, matching pinned micromark's tag list. */
export function startsBlankHtmlBlock(line: string): boolean {
  const tag = line.match(/^ {0,3}<\/?([a-z][a-z\d-]*)(?=[\t >]|\/>|$)/i);
  return tag !== null && blockNames.has(required(tag[1]).toLowerCase());
}

/** Condition 7: callers decide whether a paragraph can be interrupted. */
export function isStandaloneHtmlTag(line: string): boolean {
  return /^ {0,3}(?:<\/[a-z][a-z\d-]*[\t ]*>|<[a-z][a-z\d-]*(?:[\t ]+[a-z_:][a-z\d_.:-]*(?:[\t ]*=[\t ]*(?:[^\s"'=<>`]+|"[^"]*"|'[^']*'))?)*[\t ]*\/?>)[\t ]*$/i.test(
    line,
  );
}
