import remarkGfm from "remark-gfm";
import { parseBuzzLink } from "../navigation/buzz-links";
import { MAX_MARKDOWN_LENGTH, safeLinkUrl } from "../relay/message-content";
import type { MarkdownProfile } from "./profiles";
import { guardDocument } from "./guard";

/** Canvas and Notes: GFM, raw HTML shown as text, and only Buzz or safe links. */
export const DOCUMENT_PROFILE: MarkdownProfile = {
  syntax: [remarkGfm],
  transforms: [],
  html: "literal",
  urlTransform: (url) =>
    parseBuzzLink(url) ? url : (safeLinkUrl(url) ?? null),
};

/** GFM pads every table row to its header's width, so a small sparse table
 * can still expand to many cells. */
export const DOCUMENT_RENDER_CELLS = 10_000;

/** Shared bounds for viewing document Markdown and rendering its editor grids. */
export function fitsDocumentRenderBudget(markdown: string) {
  return guardDocument(markdown, DOCUMENT_PROFILE, {
    chars: MAX_MARKDOWN_LENGTH,
    cells: DOCUMENT_RENDER_CELLS,
  });
}
