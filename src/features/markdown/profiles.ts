import type { Options, UrlTransform } from "react-markdown";

type Pluggable = NonNullable<Options["remarkPlugins"]>[number];

/** How a screen treats raw HTML: shown as its source text, omitted, or
 * converted by the profile's own transform (GitHub bodies). */
export type HtmlPolicy = "literal" | "omit" | "convert";

/** A screen's Markdown pipeline. Profiles are module constants. */
export type MarkdownProfile = Readonly<{
  /** Syntax only: run by the renderer and by the guard parse. */
  syntax: readonly Pluggable[];
  /** AST transforms after syntax; the renderer runs them once guards pass. */
  transforms: readonly Pluggable[];
  html: HtmlPolicy;
  /** The URL policy for screens whose policy needs no instance context. */
  urlTransform?: UrlTransform | undefined;
}>;
