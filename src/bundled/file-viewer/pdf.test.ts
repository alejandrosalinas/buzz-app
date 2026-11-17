import { afterEach, expect, it, vi } from "vitest";
import { MAX_PDF_TEXT_CHARS, openPdf } from "./pdf";

// Control pdf.js I/O so stalled and failed streams are deterministic. The
// adapter owns cancellation, page rollback, separators and the text budget.
const dependency = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: dependency.getDocument,
  GlobalWorkerOptions: {},
  VerbosityLevel: { ERRORS: 0 },
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: "https://example.org/pdf.worker.mjs",
}));

type Item = { str: string; hasEOL?: boolean };
function textStream(items: Item[]) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ items });
      controller.close();
    },
  });
}
function page(items: Item[] = []) {
  return {
    getViewport: () => ({ width: 612, height: 792 }),
    streamTextContent: vi.fn(() => textStream(items)),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };
}
function loading(pages = [page()]) {
  const document = {
    numPages: pages.length,
    getPage: vi.fn(async (number: number) => pages[number - 1]),
  };
  const task = {
    promise: Promise.resolve(document),
    destroy: vi.fn(async () => {}),
  };
  dependency.getDocument.mockReturnValue(task);
  return { document, task };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const signal = () => new AbortController().signal;

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it.each([false, true])(
  "extracts lazily with page and line spacing (last EOL: %s)",
  async (hasEOL) => {
    const pages = [
      page([{ str: "First" }, { str: " line", hasEOL }]),
      page([{ str: "Second", hasEOL: true }]),
    ];
    const h = loading(pages);
    const pdf = await openPdf(new Uint8Array(), signal());
    try {
      for (const p of pages) expect(p.streamTextContent).not.toHaveBeenCalled();
      const read = pdf.text;
      await expect(read(signal())).resolves.toBe("First line\n\nSecond\n");
      expect(h.task.destroy).not.toHaveBeenCalled();
    } finally {
      await pdf.destroy();
    }
  },
);

it("returns empty for pages with no extractable text", async () => {
  loading([page(), page([{ str: "", hasEOL: true }])]);
  const pdf = await openPdf(new Uint8Array(), signal());
  try {
    await expect(pdf.text(signal())).resolves.toBe("");
  } finally {
    await pdf.destroy();
  }
});

it.each(["string", "line ending", "page separator"] as const)(
  "caps text including the %s and cancels the active stream",
  async (ending) => {
    const first = page();
    const cancelled = vi.fn();
    let pulls = 0;
    first.streamTextContent.mockImplementation(
      () =>
        new ReadableStream(
          {
            pull(controller) {
              pulls++;
              controller.enqueue({
                items: [
                  {
                    str: "x".repeat(
                      ending === "string" ? 5_000_007 : 4_999_999,
                    ),
                    hasEOL: ending === "line ending",
                  },
                ],
              });
            },
            cancel: cancelled,
          },
          { highWaterMark: 0 },
        ),
    );
    // The first page must finish to reach its page separator.
    if (ending === "page separator")
      first.streamTextContent.mockImplementation(() =>
        textStream([{ str: "x".repeat(4_999_999) }]),
      );
    const second = page([{ str: "Must not fit" }]);
    loading([first, second]);
    const pdf = await openPdf(new Uint8Array(), signal());
    try {
      const copied = await pdf.text(signal());
      expect(MAX_PDF_TEXT_CHARS).toBe(5_000_000);
      expect(copied).toHaveLength(5_000_000);
      expect(copied.endsWith(ending === "string" ? "xx" : "x\n")).toBe(true);
      if (ending !== "page separator") {
        expect(pulls).toBe(1);
        expect(cancelled).toHaveBeenCalledOnce();
        expect(second.streamTextContent).not.toHaveBeenCalled();
      }
    } finally {
      await pdf.destroy();
    }
  },
);

it.each([false, true])(
  "rolls back failed pages, separators and budget (blank survivors: %s)",
  async (blank) => {
    const failedPages = [page(), page()] as const;
    const pages = [
      failedPages[0],
      page(blank ? [] : [{ str: "First", hasEOL: true }]),
      failedPages[1],
      page(blank ? [] : [{ str: "Last".repeat(100) }]),
    ];
    for (const failed of failedPages) {
      failed.streamTextContent.mockImplementation(() => {
        let yielded = false;
        return new ReadableStream(
          {
            pull(controller) {
              if (yielded)
                controller.error(
                  new Error("Page failed after its first chunk"),
                );
              else {
                yielded = true;
                controller.enqueue({ items: [{ str: "x".repeat(4_999_950) }] });
              }
            },
          },
          { highWaterMark: 0 },
        );
      });
    }
    loading(pages);
    const pdf = await openPdf(new Uint8Array(), signal());
    try {
      await expect(pdf.text(signal())).resolves.toBe(
        blank ? "" : `First\n\n${"Last".repeat(100)}`,
      );
    } finally {
      await pdf.destroy();
    }
  },
);

it.each([
  ["page", "caller"],
  ["text", "caller"],
  ["page", "destroy"],
  ["text", "destroy"],
] as const)(
  "rejects stalled %s acquisition on %s without waiting for the dependency",
  async (phase, stop) => {
    const h = loading();
    const caller = new AbortController();
    const entered = deferred<void>();
    const pdf = await openPdf(new Uint8Array(), signal());
    const late = page();
    const acquisition = deferred<ReturnType<typeof page>>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    late.streamTextContent.mockImplementation(
      () =>
        new ReadableStream({
          pull() {
            entered.resolve();
            return new Promise<void>(() => {});
          },
          cancel,
        }),
    );
    h.document.getPage.mockImplementationOnce(() => {
      if (phase === "page") {
        entered.resolve();
        return acquisition.promise;
      }
      return Promise.resolve(late);
    });
    const outcome = expect(pdf.text(caller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      await entered.promise;
      if (stop === "caller") caller.abort();
      else await pdf.destroy();
      await outcome;
      acquisition.resolve(late);
      await Promise.resolve();
      if (phase === "page")
        expect(late.streamTextContent).not.toHaveBeenCalled();
      else expect(cancel).toHaveBeenCalledOnce();
      expect(h.task.destroy).toHaveBeenCalledTimes(stop === "destroy" ? 1 : 0);
    } finally {
      if (stop === "caller") await pdf.destroy();
    }
  },
);

it("keeps another caller and rendering usable after cancelling one text reader", async () => {
  const item = page();
  const firstCancel = vi.fn();
  const secondCancel = vi.fn();
  const entered = deferred<void>();
  let calls = 0;
  let finishSecond!: () => void;
  item.streamTextContent.mockImplementation(() => {
    const first = ++calls === 1;
    return new ReadableStream({
      start(controller) {
        if (!first)
          finishSecond = () => {
            controller.enqueue({ items: [{ str: "Still readable" }] });
            controller.close();
          };
      },
      pull() {
        if (!first) entered.resolve();
        return new Promise<void>(() => {});
      },
      cancel: first ? firstCancel : secondCancel,
    });
  });
  const h = loading([item]);
  const opening = new AbortController();
  const caller = new AbortController();
  const pdf = await openPdf(new Uint8Array(), opening.signal);
  try {
    opening.abort();
    const cancelled = expect(pdf.text(caller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const surviving = pdf.text(signal());
    await entered.promise;
    caller.abort();
    await cancelled;
    finishSecond();
    await expect(surviving).resolves.toBe("Still readable");
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).not.toHaveBeenCalled();
    expect(h.task.destroy).not.toHaveBeenCalled();
    const canvas = { style: {} } as HTMLCanvasElement;
    await pdf.render(1, canvas, 1).promise;
    expect(canvas.width).toBe(612);
    expect(item.render).toHaveBeenCalledOnce();
  } finally {
    await pdf.destroy();
  }
});

it("destroy rejects every active reader and rejects later reads", async () => {
  const item = page();
  const entered = deferred<void>();
  let started = 0;
  const cancel = vi.fn();
  item.streamTextContent.mockImplementation(
    () =>
      new ReadableStream({
        pull() {
          if (++started === 2) entered.resolve();
          return new Promise<void>(() => {});
        },
        cancel,
      }),
  );
  const h = loading([item]);
  const pdf = await openPdf(new Uint8Array(), signal());
  const outcomes = [1, 2].map(() =>
    expect(pdf.text(signal())).rejects.toMatchObject({ name: "AbortError" }),
  );
  await entered.promise;
  await pdf.destroy();
  await Promise.all(outcomes);
  expect(cancel).toHaveBeenCalledTimes(2);
  await expect(pdf.text(signal())).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(h.task.destroy).toHaveBeenCalledOnce();
});

it("rejects a pre-aborted read without acquiring a page", async () => {
  const h = loading();
  const pdf = await openPdf(new Uint8Array(), signal());
  const caller = new AbortController();
  caller.abort();
  h.document.getPage.mockClear();
  try {
    await expect(pdf.text(caller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(h.document.getPage).not.toHaveBeenCalled();
    expect(h.task.destroy).not.toHaveBeenCalled();
  } finally {
    await pdf.destroy();
  }
});

it("yields between pages so cancellation can retire its timer without destroying the PDF", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const first = page();
  first.streamTextContent.mockImplementation(() => {
    setTimeout(() => caller.abort(), 0);
    return textStream([{ str: "First" }]);
  });
  const h = loading([first, page()]);
  const pdf = await openPdf(new Uint8Array(), signal());
  h.document.getPage.mockClear();
  try {
    const outcome = expect(pdf.text(caller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.runAllTimersAsync();
    await outcome;
    expect(h.document.getPage.mock.calls).toEqual([[1]]);
    expect(h.task.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await pdf.destroy();
  }
});
