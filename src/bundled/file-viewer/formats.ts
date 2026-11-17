export type FileFormat = "pdf" | "markdown" | "csv" | "tsv" | "text";

export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);
const TEXT = new Set([
  "txt",
  "text",
  "log",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "graphql",
  "proto",
  "lua",
  "r",
  "scala",
  "dart",
  "diff",
  "patch",
  "tex",
  "rst",
  "adoc",
  "srt",
  "vtt",
]);
const TEXT_NAMES = new Set([
  "dockerfile",
  "makefile",
  "justfile",
  "license",
  "readme",
  "changelog",
  "gemfile",
  "procfile",
]);

function extension(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

/** By name first, then by type. */
export function fileFormat(
  name: string | undefined,
  mime: string | undefined,
): FileFormat | undefined {
  const ext = name ? extension(name) : undefined;
  if (ext === "pdf") return "pdf";
  if (ext && MARKDOWN.has(ext)) return "markdown";
  if (ext === "csv") return "csv";
  if (ext === "tsv" || ext === "tab") return "tsv";
  if (ext && TEXT.has(ext)) return "text";
  const base = (name?.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!ext && TEXT_NAMES.has(base)) return "text";
  const type = mime?.split(";", 1)[0]?.trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/csv") return "csv";
  if (type === "text/tab-separated-values") return "tsv";
  if (type?.startsWith("text/") || type === "application/json") return "text";
  return undefined;
}

export function maxBytes(format: FileFormat): number {
  return format === "pdf" ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
}

export function formatLabel(format: FileFormat): string {
  switch (format) {
    case "pdf":
      return "PDF";
    case "markdown":
      return "Markdown";
    case "csv":
      return "CSV";
    case "tsv":
      return "TSV";
    case "text":
      return "Text";
  }
}
