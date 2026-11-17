import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Resolves `decode-named-character-reference` to its table entry instead of
 * the browser entry, which needs `document` and so fails in a Worker. The
 * File viewer indexes large Markdown in a worker, and the app and its workers
 * should decode entities the same way. */
export const entityDecoderAlias = {
  find: /^decode-named-character-reference$/,
  replacement: createRequire(
    require.resolve("micromark-util-decode-string"),
  ).resolve("decode-named-character-reference"),
};
