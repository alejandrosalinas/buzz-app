import parser, {
  type File as FileData,
  type FileType as DiffType,
} from "gitdiff-parser";
export type { File as FileData } from "gitdiff-parser";

/** A path from a `---`/`+++` line without its timestamp or a/, b/ prefix. */
function headerPath(line: string): string {
  const path = (line.slice(4).split("\t")[0] ?? "").replace(
    / \d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? [+-]\d{4}$/,
    "",
  );
  return path === "/dev/null" ? path : path.replace(/^[ab]\//, "");
}

/** The patch with a Git header. A plain unified patch (bare `---`/`+++`, with
 * or without timestamps) gains one, so every parser reads the same paths. */
export function gitPatch(text: string): string {
  const source = text.trimStart();
  if (source.startsWith("diff --git")) return source;
  const lines = source.split("\n");
  const oldPath = headerPath(lines[0] ?? "");
  const newPath = headerPath(lines[1] ?? "");
  const added = oldPath === "/dev/null";
  const deleted = newPath === "/dev/null";
  return [
    `diff --git a/${added ? newPath : oldPath} b/${deleted ? oldPath : newPath}`,
    ...(added ? ["new file mode 100644"] : []),
    ...(deleted ? ["deleted file mode 100644"] : []),
    added ? "--- /dev/null" : `--- a/${oldPath}`,
    deleted ? "+++ /dev/null" : `+++ b/${newPath}`,
    ...lines.slice(2),
  ].join("\n");
}

export function parsePatch(content: string): FileData[] | undefined {
  // Legacy send-diff caps UTF-8 payloads at 60 KiB. Unbounded relay content
  // stays readable without allocating a diff table.
  if (content.length > 100_000) return undefined;
  if (!content.trim()) return [];
  try {
    const files = parser
      .parse(gitPatch(content))
      .filter((file) => file.hunks.length || file.oldPath || file.newPath);
    // The parser accepts incomplete hunks. Do not present a cut-off patch as a
    // complete change; the raw fallback preserves even its final partial line.
    const complete = files.every((file) =>
      file.hunks.every((hunk) => {
        // gitdiff-parser 0.3.1 treats explicit ,0 as the omitted-count default
        // of 1. Restore header counts before validating or rendering the hunk.
        const counts = /^@@\s+-\d+(?:,(\d+))?\s+\+\d+(?:,(\d+))?\s+@@/.exec(
          hunk.content,
        );
        if (!counts) return false;
        hunk.oldLines = Number(counts[1] ?? 1);
        hunk.newLines = Number(counts[2] ?? 1);
        return (
          hunk.changes.filter((change) => change.type !== "insert").length ===
            hunk.oldLines &&
          hunk.changes.filter((change) => change.type !== "delete").length ===
            hunk.newLines
        );
      }),
    );
    return files.length && complete && consumesPatch(content, files)
      ? files
      : undefined;
  } catch {
    return undefined;
  }
}
// gitdiff-parser silently skips unknown input. Match each hunk against the
// changes it actually returned; only Git's known file headers may sit outside
// hunks. Unsupported formats (including binary payloads) stay readable as raw.
function consumesPatch(content: string, files: FileData[]): boolean {
  const hunks = files.flatMap((file) => file.hunks);
  let hunkIndex = 0;
  let changes: string[] | undefined;
  let changeIndex = 0;
  let canMarkNewline = false;
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (changes && changeIndex !== changes.length) return false;
      changes = undefined;
    } else if (line.startsWith("@@")) {
      if (changes && changeIndex !== changes.length) return false;
      const hunk = hunks[hunkIndex++];
      if (!hunk || line !== hunk.content) return false;
      changes = hunk.changes.map(
        (change) =>
          `${change.type === "insert" ? "+" : change.type === "delete" ? "-" : " "}${change.content}`,
      );
      changeIndex = 0;
    } else if (changes) {
      if (line === "\\ No newline at end of file" && canMarkNewline) {
        canMarkNewline = false;
        continue;
      }
      if (line !== changes[changeIndex++]) return false;
      canMarkNewline = true;
      continue;
    } else if (
      !/^(?:--- |\+\+\+ |index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$|(?:old|new|deleted file|new file) mode \d+$|(?:dis)?similarity index \d+%$|(?:rename|copy) (?:from|to) |Binary files .+ differ$)/.test(
        line,
      )
    ) {
      return false;
    }
    canMarkNewline = false;
  }
  return (
    hunkIndex === hunks.length && (!changes || changeIndex === changes.length)
  );
}

export function fileLabel(file: FileData, fallback?: string): string {
  const oldPath = file.oldPath === "/dev/null" ? undefined : file.oldPath;
  const newPath = file.newPath === "/dev/null" ? undefined : file.newPath;
  return oldPath && newPath && oldPath !== newPath
    ? `${oldPath} → ${newPath}`
    : newPath || oldPath || fallback || "diff";
}
export function diffType(file: FileData): DiffType {
  return ["add", "copy", "delete", "rename"].includes(file.type)
    ? file.type
    : "modify";
}
export const labels: Record<DiffType, string> = {
  add: "New file",
  copy: "Copied",
  delete: "Deleted",
  modify: "Modified",
  rename: "Renamed",
};
