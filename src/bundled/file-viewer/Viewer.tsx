import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { FileTextIcon } from "../../shared/design-system/icons";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import type { RelaySession } from "../../features/relay/session";
import { CopyText } from "./CopyText";
import { DocumentView } from "./DocumentView";
import type { MediaSource } from "./PartMarkdown";
import { type FileFormat, formatLabel, maxBytes } from "./formats";
import { decodeText, LoadError, readBytes } from "./load";
import { parseTable } from "./table";
import type { FileTarget } from "./target";
import styles from "./FileViewer.module.css";

const PdfView = lazy(() => import("./PdfView"));

export type ViewerProps = Readonly<{
  file: FileTarget;
  source: string | undefined;
  session?: RelaySession | undefined;
  openLink(url: string): boolean;
  /** Where a Markdown image may be drawn from; without it, images are alt text. */
  media?: MediaSource | undefined;
  fetcher?: typeof fetch;
}>;

type Loaded =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; bytes: Uint8Array };

function failureMessage(error: unknown, format: FileFormat): string {
  const limit = Math.round(maxBytes(format) / (1024 * 1024));
  if (error instanceof LoadError && error.reason === "too-large")
    return `${formatLabel(format)} files open up to ${limit} MB. Download it to read it.`;
  if (error instanceof LoadError && error.reason === "not-text")
    return "This file isn't text. Download it to open it in another app.";
  return "This file couldn't be loaded. Check your connection and try again.";
}

function useBytes(
  format: FileFormat,
  source: string | undefined,
  fetcher: typeof fetch | undefined,
): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    setLoaded({ state: "loading" });
    readBytes(source, maxBytes(format), controller.signal, fetcher).then(
      (bytes) => setLoaded({ state: "ready", bytes }),
      (error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({
            state: "failed",
            message: failureMessage(error, format),
          });
      },
    );
    return () => controller.abort();
  }, [format, source, fetcher]);
  return loaded;
}

function Unavailable({ title, message }: { title: string; message: string }) {
  return (
    <div className={styles.status}>
      <EmptyState icon={<FileTextIcon />} title={title} description={message} />
    </div>
  );
}

export function Viewer({
  file,
  source,
  session,
  openLink,
  media,
  fetcher,
}: ViewerProps) {
  const loaded = useBytes(file.format, source, fetcher);
  if (!source)
    return (
      <Unavailable
        title="Can't open this file"
        message="Only files shared in this community open here."
      />
    );
  return (
    <div className={styles.viewer}>
      {loaded.state === "failed" ? (
        <Unavailable title="Can't open this file" message={loaded.message} />
      ) : loaded.state === "loading" ? (
        <LoadingRegion pending label={`Loading ${file.name}`}>
          {null}
        </LoadingRegion>
      ) : (
        <Contents
          file={file}
          bytes={loaded.bytes}
          session={session}
          openLink={openLink}
          media={media}
        />
      )}
    </div>
  );
}

function Contents({
  file,
  bytes,
  session,
  openLink,
  media,
}: {
  file: FileTarget;
  bytes: Uint8Array;
  session: RelaySession | undefined;
  openLink(url: string): boolean;
  media: MediaSource | undefined;
}) {
  const text = useMemo(() => {
    if (file.format === "pdf") return undefined;
    try {
      return decodeText(bytes);
    } catch {
      return null;
    }
  }, [file.format, bytes]);
  if (file.format === "pdf")
    return (
      <Suspense
        fallback={
          <LoadingRegion pending label={`Loading ${file.name}`}>
            {null}
          </LoadingRegion>
        }
      >
        <PdfView bytes={bytes} name={file.name} />
      </Suspense>
    );
  if (text === null || text === undefined)
    return (
      <Unavailable
        title="Can't open this file"
        message="This file isn't text. Download it to open it in another app."
      />
    );
  if (file.format !== "csv" && file.format !== "tsv")
    return (
      <DocumentView
        file={file}
        text={text}
        session={session}
        openLink={openLink}
        media={media}
      />
    );
  return (
    <>
      <InlineHeader
        title={file.name}
        subtitle={formatLabel(file.format)}
        actions={<CopyText read={() => text} />}
      />
      <section
        className={styles.scroll}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard scrolling of the file.
        tabIndex={0}
        aria-label={file.name}
      >
        <TableView text={text} delimiter={file.format === "csv" ? "," : "\t"} />
      </section>
    </>
  );
}

function TableView({
  text,
  delimiter,
}: {
  text: string;
  delimiter: "," | "\t";
}) {
  const table = useMemo(() => parseTable(text, delimiter), [text, delimiter]);
  const [head, ...body] = table.rows;
  const left = [
    table.omittedRows > 0 && `${table.omittedRows.toLocaleString()} more rows`,
    table.omittedColumns > 0 &&
      `${table.omittedColumns.toLocaleString()} more columns`,
  ].filter(Boolean);
  return (
    <>
      <table className={styles.table}>
        {head && (
          <thead>
            <tr>
              {head.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Columns are positional and never reorder.
                <th key={index} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Rows are positional and never reorder.
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Columns are positional and never reorder.
                <td key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {left.length > 0 && (
        <p className={styles.note} role="note">
          Not shown: {left.join(" and ")}. Download the file to see everything.
        </p>
      )}
    </>
  );
}
