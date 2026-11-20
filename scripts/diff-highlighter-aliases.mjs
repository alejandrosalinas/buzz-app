import { fileURLToPath } from "node:url";

const local = (name) =>
  fileURLToPath(new URL(`../src/bundled/diffs/${name}`, import.meta.url));

/** Limits what @pierre/diffs can load lazily to what Buzz uses: the grammars
 * in grammars.ts instead of every Shiki grammar, and neither the Oniguruma
 * WASM engine nor the Highlights backend, which only load for a highlighter
 * type other than the "shiki-js" DiffViewer asks for. */
export const diffHighlighterAliases = [
  { find: /^shiki\/langs$/, replacement: local("grammars.ts") },
  {
    find: /^(?:shiki\/(?:engine\/oniguruma|wasm)|@pierre\/highlights(?:\/themes\/loader)?)$/,
    replacement: local("unused-highlighter.ts"),
  },
];
