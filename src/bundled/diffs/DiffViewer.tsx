import { useEffect, useMemo, useState } from "react";
import {
  getFiletypeFromFileName,
  getHighlighterIfLoaded,
  parsePatchFiles,
  preloadHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { FileDiff as ReactFileDiff } from "@pierre/diffs/react";
import { bundledLanguages } from "./grammars";
import { gitPatch, type FileData } from "./parse";
import styles from "./Diffs.module.css";

const theme = { light: "pierre-light", dark: "pierre-dark" } as const;

/** The grammar that highlights a file: "text" keeps the diff view without
 * tokens. @pierre/diffs stores partial patches compactly, so absolute line
 * numbers do not measure highlighting cost; bound the supplied content. */
function languageFor(file: FileData, name: string) {
  const changes = file.hunks.flatMap((hunk) => hunk.changes);
  if (
    changes.length > 500 ||
    changes.reduce((size, change) => size + change.content.length, 0) > 12_000
  )
    return "text";
  const language = getFiletypeFromFileName(name);
  return Object.hasOwn(bundledLanguages, language) ? language : "text";
}

const languages = (files: FileDiffMetadata[]) => [
  ...new Set(files.map((file) => file.lang ?? "text")),
];

function RawDiff({ content }: { content: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: Preserve keyboard-scrollable literal diff fallback.
    <pre
      className={styles.raw}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The raw scrollport needs keyboard panning.
      tabIndex={0}
      role="region"
      aria-label="Raw diff"
    >
      {content}
    </pre>
  );
}

/** All three diff callers share this strict parse gate and readable fallback. */
export function DiffViewer({
  content,
  files,
  filePath,
  viewType = "unified",
}: {
  content: string;
  files: FileData[] | undefined;
  filePath?: string | undefined;
  viewType?: "unified" | "split";
}) {
  if (!files) return <RawDiff content={content} />;
  if (!files.length) return <p className="text-body-sm">No diff content</p>;
  if (files.some((file) => file.isBinary || !file.hunks.length))
    return <RawDiff content={content} />;
  return (
    <ParsedDiff
      key={content}
      content={content}
      files={files}
      filePath={filePath}
      viewType={viewType}
    />
  );
}

function ParsedDiff({
  content,
  files,
  filePath,
  viewType,
}: {
  content: string;
  files: FileData[];
  filePath?: string | undefined;
  viewType: "unified" | "split";
}) {
  const parsed = useMemo(() => {
    try {
      // Both parsers read the same Git-headed text, so their names agree.
      const entries = parsePatchFiles(gitPatch(content)).flatMap(
        (patch) => patch.files,
      );
      if (
        entries.length !== files.length ||
        entries.some(
          (entry, index) =>
            entry.name !==
            (files[index]?.newPath === "/dev/null"
              ? files[index]?.oldPath
              : files[index]?.newPath),
        )
      )
        return undefined;
      return entries.map((entry, index) => ({
        ...entry,
        lang: languageFor(files[index] as FileData, entry.name),
      }));
    } catch {
      return undefined;
    }
  }, [content, files]);
  // A highlighter that already holds these grammars renders at once.
  const [ready, setReady] = useState(
    () =>
      !!parsed && !!getHighlighterIfLoaded({ theme, langs: languages(parsed) }),
  );
  const [failed, setFailed] = useState(false);
  const [themeType, setThemeType] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.colorMode === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    if (!parsed) return;
    let active = true;
    void preloadHighlighter({
      themes: [theme.light, theme.dark],
      langs: languages(parsed),
      preferredHighlighter: "shiki-js",
    }).then(
      () => {
        if (active) setReady(true);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [parsed]);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() =>
      setThemeType(root.dataset.colorMode === "dark" ? "dark" : "light"),
    );
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-color-mode"],
    });
    return () => observer.disconnect();
  }, []);
  if (!parsed || failed || !ready) return <RawDiff content={content} />;
  return (
    <div className={styles.viewer}>
      {parsed.map((file, index) => (
        <PierreFile
          // biome-ignore lint/suspicious/noArrayIndexKey: A path may repeat across commits; its position is stable in this patch.
          key={`${file.prevName ?? ""}:${file.name}:${index}`}
          file={file}
          filePath={filePath}
          hideHeader={
            parsed.length === 1 &&
            filePath === file.name &&
            file.type === "change"
          }
          onFailure={() => setFailed(true)}
          themeType={themeType}
          viewType={viewType}
        />
      ))}
    </div>
  );
}

function PierreFile({
  file,
  filePath,
  hideHeader,
  onFailure,
  themeType,
  viewType,
}: {
  file: FileDiffMetadata;
  filePath?: string | undefined;
  hideHeader: boolean;
  onFailure: () => void;
  themeType: "light" | "dark";
  viewType: "unified" | "split";
}) {
  return (
    <section
      className={styles.file}
      aria-label={filePath || file.name}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: File-level keyboard focus precedes inner code scrollports.
      tabIndex={0}
    >
      <ReactFileDiff
        fileDiff={file}
        options={{
          theme,
          themeType,
          diffStyle: viewType,
          diffIndicators: "classic",
          disableFileHeader: hideHeader,
          overflow: "scroll",
          tokenizeMaxLineLength: 2_000,
          onPostRender: (node) => {
            if (node.shadowRoot?.querySelector("[data-error-wrapper]"))
              onFailure();
            // Split code columns own their horizontal scrollports.
            const columns = node.shadowRoot?.querySelectorAll("code") ?? [];
            for (const [index, code] of Array.from(columns).entries()) {
              code.tabIndex = 0;
              code.setAttribute("role", "region");
              code.setAttribute(
                "aria-label",
                `${file.name} ${viewType === "split" ? (index === 0 ? "old code" : "new code") : "code"}`,
              );
            }
          },
        }}
      />
    </section>
  );
}
