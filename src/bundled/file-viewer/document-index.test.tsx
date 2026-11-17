// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { indexInWorker, useDocumentIndex } from "./document-index";
import { indexData, SYNC_INDEX_CHARS } from "./document-parts";

class IndexWorker {
  static latest: IndexWorker | undefined;
  constructor() {
    IndexWorker.latest = this;
  }
  terminate = vi.fn();
  postMessage = vi.fn();
  onmessage?: (event: { data: { data?: unknown; error?: string } }) => void;
  onerror?: () => void;
}
afterEach(() => {
  IndexWorker.latest = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LARGE = `# Large\n\n${"Words in a paragraph. ".repeat(SYNC_INDEX_CHARS / 20)}\n`;

it.each(["done", "cancel", "deadline", "load", "index"])(
  "terminates the worker once it settles: %s",
  async (outcome) => {
    vi.stubGlobal("Worker", IndexWorker);
    const caller = new AbortController();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const result = indexInWorker("# A\n", "markdown", caller.signal);
    const worker = IndexWorker.latest;
    expect(worker?.postMessage).toHaveBeenCalledWith({
      text: "# A\n",
      kind: "markdown",
    });
    const data = indexData("# A\n", "markdown");
    if (outcome === "done") worker?.onmessage?.({ data: { data } });
    if (outcome === "cancel") caller.abort();
    if (outcome === "deadline") deadline.abort();
    if (outcome === "load") worker?.onerror?.();
    if (outcome === "index") worker?.onmessage?.({ data: { error: "x" } });
    if (outcome === "done") await expect(result).resolves.toBe(data);
    else await expect(result).rejects.toThrow();
    expect(worker?.terminate).toHaveBeenCalledTimes(1);
  },
);

it("indexes code, text and small Markdown at once, without a worker", () => {
  vi.stubGlobal("Worker", IndexWorker);
  for (const [text, kind] of [
    ["# Small\n", "markdown"],
    [LARGE, "code"],
    [LARGE, "text"],
  ] as const) {
    const { result } = renderHook(() => useDocumentIndex(text, kind));
    expect(result.current.state).toBe("ready");
  }
  expect(IndexWorker.latest).toBeUndefined();
});

it("indexes large Markdown in a worker, and shows it as text if that fails", async () => {
  vi.stubGlobal("Worker", IndexWorker);
  const { result, unmount } = renderHook(() =>
    useDocumentIndex(LARGE, "markdown"),
  );
  expect(result.current).toEqual({ state: "indexing" });
  await act(async () =>
    IndexWorker.latest?.onmessage?.({
      data: { data: indexData(LARGE, "markdown") },
    }),
  );
  expect(result.current).toMatchObject({ state: "ready", plain: false });
  if (result.current.state === "ready")
    expect(result.current.doc.outline[0]?.text).toBe("Large");
  unmount();

  const failed = renderHook(() => useDocumentIndex(LARGE, "markdown"));
  await act(async () => IndexWorker.latest?.onerror?.());
  expect(failed.result.current).toMatchObject({ state: "ready", plain: true });

  // Leaving the file mid-index stops the worker.
  const left = renderHook(() => useDocumentIndex(LARGE, "markdown"));
  const worker = IndexWorker.latest;
  left.unmount();
  expect(worker?.terminate).toHaveBeenCalledTimes(1);
});
