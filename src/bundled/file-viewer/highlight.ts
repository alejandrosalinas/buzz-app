import type { Element, Root } from "hast";
import type { Plugin } from "unified";
import { createLowlight } from "lowlight";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import ini from "highlight.js/lib/languages/ini";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import makefile from "highlight.js/lib/languages/makefile";

const grammars = createLowlight({
  javascript,
  typescript,
  json,
  bash,
  python,
  yaml,
  diff,
  sql,
  go,
  rust,
  java,
  kotlin,
  xml,
  css,
  scss,
  ini,
  dockerfile,
  makefile,
});
grammars.registerAlias({
  bash: ["sh", "zsh", "shell", "console"],
  javascript: ["js", "jsx", "mjs", "cjs"],
  typescript: ["ts", "tsx"],
  yaml: "yml",
  python: "py",
  xml: ["html", "htm", "svg"],
  ini: ["toml", "cfg", "conf"],
  json: "jsonl",
});

export function highlight(text: string, language?: string): Root {
  if (!language || !grammars.registered(language))
    return { type: "root", children: [{ type: "text", value: text }] };
  return grammars.highlight(language, text);
}

/** The screen is linear even for one unbroken source line. */
function longToken(text: string): boolean {
  let run = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95 ||
      code === 36 ||
      code === 46 ||
      code === 45
    ) {
      if (++run > 1000) return true;
    } else run = 0;
  }
  return false;
}

/** One owner per document. After two calls exceed 50 ms, later parts stay plain. */
export function boundedHighlight(): typeof highlight {
  let slowCalls = 0;
  return (text, language) => {
    if (slowCalls >= 2 || longToken(text))
      return { type: "root", children: [{ type: "text", value: text }] };
    const start = performance.now();
    const result = highlight(text, language);
    if (performance.now() - start > 50) slowCalls++;
    return result;
  };
}

const languages: Readonly<Record<string, string>> = {
  json: "json",
  jsonl: "json",
  ndjson: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  xml: "xml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
};

export function languageFor(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "dockerfile" || base === "makefile") return base;
  const extension = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  return Object.hasOwn(languages, extension) ? languages[extension] : undefined;
}

export const rehypeHighlight: Plugin<
  [{ highlight?: typeof highlight }?],
  Root
> = (options) => (tree) => {
  const stack: (Root | Element)[] = [tree];
  while (stack.length) {
    const parent = stack.pop();
    if (!parent) break;
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      if (
        parent.type === "element" &&
        parent.tagName === "pre" &&
        child.tagName === "code"
      ) {
        const classes = child.properties.className;
        const language = Array.isArray(classes)
          ? classes.find((name) => String(name).startsWith("language-"))
          : undefined;
        if (!language) continue;
        const text = child.children
          .filter((node) => node.type === "text")
          .map((node) => node.value)
          .join("");
        child.children = (options?.highlight ?? highlight)(
          text,
          String(language).slice(9),
        ).children.filter((node) => node.type !== "doctype");
      } else stack.push(child);
    }
  }
};
