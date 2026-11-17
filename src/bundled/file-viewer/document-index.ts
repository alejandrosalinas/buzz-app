import { useEffect, useMemo, useState } from "react";
import {
  type IndexData,
  type DocumentKind,
  type DocumentParts,
  documentParts,
  indexDocument,
  SYNC_INDEX_CHARS,
} from "./document-parts";

/** How long a large Markdown file may take to index before it shows as text. */
const INDEX_DEADLINE_MS = 10_000;

/** Indexes `text` in a worker, so a large file never blocks the app. One
 * worker per file: cancelling, or the deadline, terminates it mid-index. */
export function indexInWorker(
  text: string,
  kind: DocumentKind,
  signal: AbortSignal,
): Promise<IndexData> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./document-index.worker.ts", import.meta.url),
      { type: "module" },
    );
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(INDEX_DEADLINE_MS),
    ]);
    const cleanup = () => {
      worker.terminate();
      bounded.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(bounded.reason);
    };
    bounded.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ data?: IndexData; error?: string }>,
    ) => {
      cleanup();
      if (event.data.data) resolve(event.data.data);
      else reject(new Error(event.data.error || "Indexing failed."));
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("The indexer could not load."));
    };
    worker.postMessage({ text, kind });
  });
}

export type DocumentIndex =
  | { state: "indexing" }
  /** `plain`: the file took too long or failed to index, so it shows as text. */
  | { state: "ready"; doc: DocumentParts; plain: boolean };

/** The parts of `text`. Code, text and small Markdown index at once; larger
 * Markdown indexes in a worker meanwhile. A new file or leaving this one
 * cancels the worker, and its result is dropped. */
export function useDocumentIndex(
  text: string,
  kind: DocumentKind,
): DocumentIndex {
  const now = useMemo(
    () =>
      kind !== "markdown" || text.length <= SYNC_INDEX_CHARS
        ? indexDocument(text, kind)
        : undefined,
    [text, kind],
  );
  const [later, setLater] = useState<{
    text: string;
    doc: DocumentParts;
    plain: boolean;
  }>();
  useEffect(() => {
    if (now) return;
    const controller = new AbortController();
    indexInWorker(text, kind, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted)
          setLater({ text, doc: documentParts(text, data), plain: false });
      },
      () => {
        if (!controller.signal.aborted)
          setLater({ text, doc: indexDocument(text, "text"), plain: true });
      },
    );
    return () => controller.abort();
  }, [now, text, kind]);
  if (now) return { state: "ready", doc: now, plain: false };
  return later?.text === text
    ? { state: "ready", doc: later.doc, plain: later.plain }
    : { state: "indexing" };
}
