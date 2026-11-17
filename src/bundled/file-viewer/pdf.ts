import {
  GlobalWorkerOptions,
  getDocument,
  VerbosityLevel,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export const MAX_PDF_PAGES = 1000;
export const MAX_PDF_TEXT_CHARS = 5_000_000;
const MAX_CANVAS_PIXELS = 16_000_000;

const DATA = {
  cMapUrl: import.meta.glob<string>(
    "../../../node_modules/pdfjs-dist/cmaps/*.bcmap",
    { query: "?url", import: "default" },
  ),
  standardFontDataUrl: import.meta.glob<string>(
    "../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
    { query: "?url", import: "default" },
  ),
  wasmUrl: import.meta.glob<string>(
    "../../../node_modules/pdfjs-dist/wasm/*.wasm",
    { query: "?url", import: "default" },
  ),
};

/** Serves pdf.js its CMaps, standard fonts and image decoders from the
 * app's own bundled assets rather than a directory URL. */
class BundledData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const files = DATA[kind as keyof typeof DATA] ?? {};
    const load = Object.entries(files).find(([path]) =>
      path.endsWith(`/${filename}`),
    )?.[1];
    if (!load) throw new Error(`No bundled PDF data named ${filename}`);
    const response = await fetch(await load());
    if (!response.ok) throw new Error(`PDF data ${filename} didn't load`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

const SIZE_BATCH = 16;

export type PageSize = Readonly<{ width: number; height: number }>;
export type PdfRendering = Readonly<{
  promise: Promise<void>;
  cancel(): void;
}>;
export type PdfDocument = Readonly<{
  /** Every page in the file, including any past `sizes`. */
  pages: number;
  /** The pages laid out, up to `MAX_PDF_PAGES`. */
  sizes: readonly PageSize[];
  text(signal: AbortSignal): Promise<string>;
  render(page: number, canvas: HTMLCanvasElement, scale: number): PdfRendering;
  destroy(): Promise<void>;
}>;
export type PdfOpenError = "password" | "not-pdf";

export class PdfError extends Error {
  constructor(readonly reason: PdfOpenError) {
    super(reason);
  }
}

export async function openPdf(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<PdfDocument> {
  GlobalWorkerOptions.workerSrc ||= workerSrc;
  const loading = getDocument({
    data: bytes,
    BinaryDataFactory: BundledData,
    useWorkerFetch: false,
    cMapPacked: true,
    enableXfa: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  const stop = () => void loading.destroy().catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  try {
    const document = await loading.promise;
    const count = Math.min(document.numPages, MAX_PDF_PAGES);
    const sizes: (PageSize | undefined)[] = [];
    for (let start = 1; start <= count; start += SIZE_BATCH) {
      signal.throwIfAborted();
      const batch = Array.from(
        { length: Math.min(SIZE_BATCH, count - start + 1) },
        async (_, index) => {
          const page = await document.getPage(start + index);
          const { width, height } = page.getViewport({ scale: 1 });
          return { width, height };
        },
      );
      for (const result of await Promise.allSettled(batch))
        sizes.push(result.status === "fulfilled" ? result.value : undefined);
    }
    signal.throwIfAborted();
    const fallback = sizes.find((size) => size !== undefined);
    if (!fallback) throw new PdfError("not-pdf");
    // The document owns all reads; each caller owns only its current stream.
    const closed = new AbortController();
    return {
      pages: document.numPages,
      sizes: sizes.map((size) => size ?? fallback),
      text: async (signal) => {
        const check = () => {
          if (signal.aborted || closed.signal.aborted)
            throw new DOMException("PDF text extraction stopped", "AbortError");
        };
        check();
        // There is one pending acquisition, read or page yield per invocation.
        // Retire its cancellation waiter as soon as it settles: racing every
        // chunk against one pending promise retains all earlier read results.
        let rejectWait: ((error: DOMException) => void) | undefined;
        const wait = <T>(operation: Promise<T>): Promise<T> =>
          new Promise<T>((resolve, reject) => {
            rejectWait = reject;
            operation.then(resolve, reject);
            check();
          }).finally(() => {
            rejectWait = undefined;
          });
        // Each invocation owns only its current page stream. pdf.js awaits
        // backpressure; cancelling that stream stops extraction, not the PDF.
        let reader: ReadableStreamDefaultReader<TextContent> | undefined;
        const stopReader = () => {
          const current = reader;
          if (!current) return;
          reader = undefined;
          // pdf.js requires an Error reason. Never wait for an uncooperative
          // cancellation acknowledgement before rejecting the caller.
          void current
            .cancel(new Error("PDF text extraction stopped"))
            .catch(() => {});
          current.releaseLock();
        };
        const cancel = () => {
          stopReader();
          rejectWait?.(
            new DOMException("PDF text extraction stopped", "AbortError"),
          );
        };
        signal.addEventListener("abort", cancel, { once: true });
        closed.signal.addEventListener("abort", cancel, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const chunks: string[] = [];
          let remaining = MAX_PDF_TEXT_CHARS,
            pages = 0,
            hasText = false,
            endsLine = false;
          const append = (value: string) => {
            const part = value.slice(0, remaining);
            if (part) {
              chunks.push(part);
              remaining -= part.length;
              endsLine = part.endsWith("\n");
            }
          };
          for (let number = 1; number <= count && remaining; number++) {
            check();
            const saved: {
              chunks: number;
              remaining: number;
              pages: number;
              hasText: boolean;
              endsLine: boolean;
            } = { chunks: chunks.length, remaining, pages, hasText, endsLine };
            try {
              const page = await wait(document.getPage(number));
              check();
              reader = page.streamTextContent().getReader();
              check();
              if (pages++) append(endsLine ? "\n" : "\n\n");
              endsLine = false;
              while (remaining) {
                const content = await wait(reader.read());
                check();
                if (content.done) {
                  reader.releaseLock();
                  reader = undefined;
                  break;
                }
                for (const item of content.value.items) {
                  if (!("str" in item)) continue;
                  if (item.str) hasText = true;
                  append(item.str);
                  if (item.hasEOL) append("\n");
                  if (!remaining) break;
                }
              }
            } catch {
              check();
              // A stream may fail after yielding chunks. Match whole-page
              // failure semantics, including its separator and budget usage.
              chunks.length = saved.chunks;
              ({ remaining, pages, hasText, endsLine } = saved);
            } finally {
              stopReader();
            }
            if (number < count && remaining) {
              await wait(
                new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, 0);
                }),
              );
              timer = undefined;
            }
          }
          check();
          return hasText ? chunks.join("") : "";
        } finally {
          stopReader();
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          closed.signal.removeEventListener("abort", cancel);
        }
      },
      render(number, canvas, scale) {
        let task: RenderTask | undefined;
        let cancelled = false;
        const promise = document
          .getPage(number)
          .then(async (page) => {
            if (cancelled) return;
            const base = page.getViewport({ scale: 1 });
            const device = globalThis.devicePixelRatio || 1;
            const area = base.width * scale * base.height * scale;
            const ratio = Math.min(device, Math.sqrt(MAX_CANVAS_PIXELS / area));
            const viewport = page.getViewport({ scale: scale * ratio });
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            canvas.style.width = `${base.width * scale}px`;
            canvas.style.height = `${base.height * scale}px`;
            task = page.render({ canvas, viewport });
            await task.promise;
          })
          .catch((error: unknown) => {
            if (!cancelled) throw error;
          });
        return {
          promise,
          cancel() {
            cancelled = true;
            task?.cancel();
          },
        };
      },
      destroy: () => {
        closed.abort();
        return loading.destroy();
      },
    };
  } catch (error) {
    stop();
    signal.throwIfAborted();
    if (error instanceof PdfError) throw error;
    throw new PdfError(
      error instanceof Error && error.name === "PasswordException"
        ? "password"
        : "not-pdf",
    );
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
