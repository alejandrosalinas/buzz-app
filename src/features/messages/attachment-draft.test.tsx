// @vitest-environment jsdom
import { File } from "node:buffer";
import {
  act,
  cleanup,
  renderHook,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { assert, afterEach, expect, it, vi } from "vitest";
import { ComposerAttachments } from "./ComposerAttachments";
import type { RelaySession } from "../relay/session";
import type { UploadedAttachment } from "../relay/attachments";
import {
  useAttachmentDraft,
  attachmentDraft,
  transferAttachmentDraft,
} from "./attachment-draft";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const file = (name = "notes.txt", size = 5) =>
  Object.defineProperty(new File(["notes"], name), "size", {
    value: size,
  }) as unknown as globalThis.File;
function fixture() {
  const calls: {
    file: globalThis.File;
    channel: string;
    signal: AbortSignal;
    progress: ((sent: number, total: number) => void) | undefined;
    result: ReturnType<typeof deferred<UploadedAttachment>>;
  }[] = [];
  const upload = vi.fn(
    (
      file: globalThis.File,
      channel: string,
      signal: AbortSignal,
      progress?: (sent: number, total: number) => void,
    ) => {
      const result = deferred<UploadedAttachment>();
      calls.push({ file, channel, signal, progress, result });
      return result.promise;
    },
  );
  return {
    session: { attachments: { upload } } as unknown as RelaySession,
    calls,
    upload,
  };
}
function uploaded(name = "notes.txt"): UploadedAttachment {
  return {
    name,
    url: `https://relay.test/media/${"a".repeat(64)}.txt`,
    type: "text/plain",
    size: 5,
    sha256: "a".repeat(64),
  };
}
afterEach(cleanup);

it("starts uploading on add and send preparation reuses the in-flight upload", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() => draft.result.current.store.add([file()]));
  await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
  expect(draft.result.current.items[0]?.status).toBe("uploading");
  expect(draft.result.current.blocked).toBe(false);

  const send = new AbortController();
  let work: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    work = draft.result.current.store.prepareForSend(send.signal);
  });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.channel).toBe("one");
  expect(draft.result.current.items[0]?.status).toBe("uploading");
  await act(async () => {
    h.calls[0]?.result.resolve(uploaded());
    expect(await work).toEqual([uploaded()]);
  });
  expect(draft.result.current.items[0]?.status).toBe("ready");
});

it.each(["preparing", "uploading"] as const)(
  "resumes %s and queued files after navigation and sends without Retry",
  async (phase) => {
    const h = fixture();
    const first = renderHook(() =>
      useAttachmentDraft(h.session, "channel-one", "one"),
    );
    act(() => first.result.current.store.add([file("1.txt"), file("2.txt")]));
    if (phase === "uploading")
      await waitFor(() => expect(h.calls).toHaveLength(1));
    else expect(h.calls).toHaveLength(0);
    const interrupted = h.calls.length;
    first.unmount();
    if (interrupted) expect(h.calls[0]?.signal.aborted).toBe(true);
    expect(
      first.result.current.store.snapshot().map((item) => item.status),
    ).toEqual(["queued", "queued"]);
    const returned = renderHook(() =>
      useAttachmentDraft(h.session, "channel-one", "one"),
    );
    expect(returned.result.current.blocked).toBe(false);
    await waitFor(() => expect(h.calls).toHaveLength(interrupted + 1));
    let work!: Promise<readonly UploadedAttachment[]>;
    await act(async () => {
      work = returned.result.current.store.prepareForSend(
        new AbortController().signal,
      );
    });
    expect(h.calls).toHaveLength(interrupted + 1);
    // A late result from the aborted owner must not replace resumed work.
    if (interrupted)
      await act(async () => h.calls[0]?.result.resolve(uploaded("stale.txt")));
    expect(returned.result.current.items[0]?.uploaded).toBeUndefined();
    await act(async () =>
      h.calls[interrupted]?.result.resolve(uploaded("1.txt")),
    );
    await waitFor(() => expect(h.calls).toHaveLength(interrupted + 2));
    await act(async () => {
      h.calls[interrupted + 1]?.result.resolve(uploaded("2.txt"));
      expect(await work).toEqual([uploaded("1.txt"), uploaded("2.txt")]);
    });
    expect(returned.result.current.blocked).toBe(false);
  },
);

it("preserves real upload errors while resuming unfinished siblings on return", async () => {
  const h = fixture();
  const first = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() =>
    first.result.current.store.add([file("failed.txt"), file("pending.txt")]),
  );
  await waitFor(() => expect(h.calls).toHaveLength(1));
  await act(async () => h.calls[0]?.result.reject(new Error("relay down")));
  await waitFor(() => expect(h.calls).toHaveLength(2));
  first.unmount();
  const returned = renderHook(() =>
    useAttachmentDraft(h.session, "one", "one"),
  );
  await waitFor(() => expect(h.calls).toHaveLength(3));
  expect(returned.result.current.items[0]?.error).toBe("relay down");
  expect(returned.result.current.items[0]?.status).toBe("error");
  expect(returned.result.current.blocked).toBe(true);
  expect(h.calls[2]?.file.name).toBe("pending.txt");
});

it("ignores a host progress report after an upload fails", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() => draft.result.current.store.add([file()]));
  const send = new AbortController();
  let work!: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    work = draft.result.current.store.prepareForSend(send.signal);
  });
  const call = h.calls[0];
  assert.exists(call);
  act(() => call.progress?.(2, 5));
  expect(draft.result.current.items[0]?.transfer).toEqual({
    sent: 2,
    total: 5,
  });
  await act(async () => {
    call.result.reject(new Error("relay down"));
    await expect(work).rejects.toThrow("relay down");
  });
  expect(draft.result.current.items[0]?.status).toBe("error");
  expect(draft.result.current.items[0]?.transfer).toBeUndefined();
  act(() => call.progress?.(5, 5));
  expect(draft.result.current.items[0]?.transfer).toBeUndefined();
});

it("reuses successful descriptors after a partial upload failure", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() => draft.result.current.store.add([file("1.txt"), file("2.txt")]));
  const first = new AbortController();
  let firstWork: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    firstWork = draft.result.current.store.prepareForSend(first.signal);
  });
  expect(h.calls).toHaveLength(1);
  await act(async () => {
    h.calls[0]?.result.resolve(uploaded("1.txt"));
  });
  expect(h.calls).toHaveLength(2);
  await act(async () => {
    h.calls[1]?.result.reject(new Error("relay down"));
    await expect(firstWork).rejects.toThrow("relay down");
  });
  expect(draft.result.current.items.map((item) => item.status)).toEqual([
    "ready",
    "error",
  ]);
  expect(draft.result.current.blocked).toBe(true);

  act(() =>
    draft.result.current.store.retry(draft.result.current.items[1]?.id ?? ""),
  );
  expect(draft.result.current.blocked).toBe(false);
  const retry = new AbortController();
  let retryWork: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    retryWork = draft.result.current.store.prepareForSend(retry.signal);
  });
  expect(h.calls).toHaveLength(3);
  expect(h.calls[2]?.file.name).toBe("2.txt");
  await act(async () => {
    h.calls[2]?.result.resolve(uploaded("2.txt"));
    expect(await retryWork).toEqual([uploaded("1.txt"), uploaded("2.txt")]);
  });
});

it("aborting a send cancels eager uploads and retains ready descriptors", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() =>
    draft.result.current.store.add([file("ready.txt"), file("paused.txt")]),
  );
  const send = new AbortController();
  let work: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    work = draft.result.current.store.prepareForSend(send.signal);
  });
  await act(async () => {
    h.calls[0]?.result.resolve(uploaded("ready.txt"));
  });
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]?.file.name).toBe("paused.txt");

  send.abort();
  await act(async () => {
    await expect(work).rejects.toThrow();
  });
  expect(draft.result.current.items.map((item) => item.status)).toEqual([
    "ready",
    "error",
  ]);
  expect(draft.result.current.blocked).toBe(true);

  act(() =>
    draft.result.current.store.retry(draft.result.current.items[1]?.id ?? ""),
  );
  const retry = new AbortController();
  let retryWork: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    retryWork = draft.result.current.store.prepareForSend(retry.signal);
  });
  expect(h.calls).toHaveLength(3);
  expect(h.calls[2]?.file.name).toBe("paused.txt");
  await act(async () => {
    h.calls[2]?.result.resolve(uploaded("paused.txt"));
    expect(await retryWork).toEqual([
      uploaded("ready.txt"),
      uploaded("paused.txt"),
    ]);
  });
});

it("removal and cancellation abort in-flight send preparation", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() => draft.result.current.store.add([file()]));
  const send = new AbortController();
  let work = Promise.reject<readonly UploadedAttachment[]>(
    new Error("prepare did not start"),
  );
  work.catch(() => {});
  await act(async () => {
    work = draft.result.current.store.prepareForSend(send.signal);
  });
  const call = h.calls[0];
  assert.exists(call);
  const item = draft.result.current.items[0];
  assert.exists(item);
  act(() => draft.result.current.store.remove(item.id));
  expect(call.signal.aborted).toBe(true);
  await expect(work).rejects.toThrow();
  expect(draft.result.current.items).toEqual([]);
  await act(async () => {
    call.progress?.(5, 5);
    call.result.resolve(uploaded());
    await call.result.promise;
  });
  expect(draft.result.current.items).toEqual([]);

  act(() => draft.result.current.store.add([file("cancel.txt")]));
  const second = new AbortController();
  await act(async () => {
    work = draft.result.current.store.prepareForSend(second.signal);
  });
  const secondCall = h.calls[1];
  assert.exists(secondCall);
  act(() => draft.result.current.store.cancel());
  expect(secondCall.signal.aborted).toBe(true);
  await expect(work).rejects.toThrow();
  expect(draft.result.current.items.map((item) => item.status)).toEqual([
    "error",
  ]);
});

it("accepts the 500 MiB source and 1,000 MiB shared retention boundaries, not cap+1", () => {
  const h = fixture();
  const a = renderHook(() => useAttachmentDraft(h.session, "a", "a"));
  const b = renderHook(() => useAttachmentDraft(h.session, "b", "b"));
  const cap = 500 * 1024 * 1024;
  act(() => a.result.current.store.add([file("a.bin", cap)]));
  act(() => b.result.current.store.add([file("b.bin", cap)]));
  expect(h.upload).not.toHaveBeenCalled();
  expect(() => b.result.current.store.add([file("overflow.bin", 1)])).toThrow(
    /drafts are full/,
  );
  act(() => a.result.current.store.clear());
  expect(() =>
    a.result.current.store.add([file("over-source.bin", cap + 1)]),
  ).toThrow(/limit/);
  act(() =>
    a.result.current.store.add(
      Array.from({ length: 10 }, (_, i) => file(`${i}.txt`)),
    ),
  );
  expect(() => a.result.current.store.add([file()])).toThrow(/at most 10/);
  expect(a.result.current.items).toHaveLength(10);
});

it("admits a batch's files that fit in pick order and names the rest by reason", () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  const names = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `${from + i}.txt`);
  act(() => draft.result.current.store.add(names(1, 3).map((n) => file(n))));
  let left: readonly string[] = [];
  act(() => {
    left = draft.result.current.store.add([
      file("4.txt"),
      file("empty.txt", 0),
      file("big.bin", 500 * 1024 * 1024 + 1),
      ...names(5, 12).map((n) => file(n)),
    ]);
  });
  // The ten-file limit counts attached chips and admitted files, not refused ones.
  expect(draft.result.current.items.map((item) => item.file.name)).toEqual(
    names(1, 10),
  );
  expect(left).toEqual([
    "empty.txt is empty.",
    "big.bin: File exceeds the supported limit: images 50 MiB, GIFs 10 MiB, documents 100 MiB, videos 500 MiB. The relay may enforce a lower limit.",
    "11.txt, 12.txt: Attach at most 10 files per message.",
  ]);
  act(() => {
    left = draft.result.current.store.add([file("13.txt"), file("14.txt")]);
  });
  expect(left).toEqual([
    "13.txt, 14.txt: Attach at most 10 files per message.",
  ]);
  expect(draft.result.current.items).toHaveLength(10);
});

it("names three files per reason, counts the rest and gives empty files one sentence", () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  let left: readonly string[] = [];
  act(() => {
    left = draft.result.current.store.add([
      file("a.png", 0),
      ...Array.from({ length: 15 }, (_, i) => file(`${i + 1}.txt`)),
      file("b.png", 0),
      file("c.png", 0),
    ]);
  });
  expect(draft.result.current.items).toHaveLength(10);
  expect(left).toEqual([
    "a.png, b.png, c.png are empty.",
    "11.txt, 12.txt, 13.txt and 2 more: Attach at most 10 files per message.",
  ]);
});

it("charges a batch's admitted files, not its refused ones, to the shared retention budget", () => {
  const h = fixture();
  const a = renderHook(() => useAttachmentDraft(h.session, "a", "a"));
  const b = renderHook(() => useAttachmentDraft(h.session, "b", "b"));
  const cap = 500 * 1024 * 1024;
  act(() => b.result.current.store.add([file("b.bin", cap)]));
  let left: readonly string[] = [];
  act(() => {
    left = a.result.current.store.add([
      file("a.bin", cap - 5),
      file("over.bin", 6),
      file("last.txt", 5),
    ]);
  });
  expect(a.result.current.items.map((item) => item.file.name)).toEqual([
    "a.bin",
    "last.txt",
  ]);
  expect(left).toEqual([
    "over.bin: Attachment drafts are full (1,000 MiB). Send or remove some files first.",
  ]);
});

it("confirmed scoped cleanup aborts pending uploads and removes only that destination's files", async () => {
  const h = fixture();
  const key = "scope:draft:one";
  const a = renderHook(() => useAttachmentDraft(h.session, key, "one"));
  const sibling = renderHook(() =>
    useAttachmentDraft(h.session, "scope:draft:two", "two"),
  );
  act(() => {
    a.result.current.store.add([file("pending.txt")]);
    sibling.result.current.store.add([file("sibling.txt")]);
  });
  let firstWork: Promise<readonly UploadedAttachment[]> | undefined;
  let secondWork: Promise<readonly UploadedAttachment[]> | undefined;
  await act(async () => {
    firstWork = a.result.current.store.prepareForSend(
      new AbortController().signal,
    );
    secondWork = sibling.result.current.store.prepareForSend(
      new AbortController().signal,
    );
  });
  if (!firstWork || !secondWork) throw new Error("Upload work was not started");
  firstWork.catch(() => {});
  await waitFor(() => expect(h.calls).toHaveLength(2));
  const first = h.calls.find((call) => call.channel === "one");
  const second = h.calls.find((call) => call.channel === "two");
  assert.exists(first);
  assert.exists(second);
  const { clearAttachmentDraft } = await import("./attachment-draft");
  act(() => clearAttachmentDraft(h.session, key));
  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(false);
  expect(a.result.current.items).toEqual([]);
  expect(sibling.result.current.items).toHaveLength(1);
  await expect(firstWork).rejects.toThrow();
  await act(async () => second.result.resolve(uploaded("sibling.txt")));
  await expect(secondWork).resolves.toEqual([uploaded("sibling.txt")]);
  expect(a.result.current.items).toEqual([]);
});

it("confirmed cleanup forgets a ready file after unmount and a reopened scoped draft starts empty", async () => {
  const h = fixture();
  const key = "scope:draft:one";
  const before = renderHook(() => useAttachmentDraft(h.session, key, "one"));
  act(() => before.result.current.store.add([file("ready.txt")]));
  let work: Promise<readonly UploadedAttachment[]> | undefined;
  await act(async () => {
    work = before.result.current.store.prepareForSend(
      new AbortController().signal,
    );
  });
  if (!work) throw new Error("Upload work was not started");
  await waitFor(() => expect(h.calls).toHaveLength(1));
  const upload = h.calls[0];
  assert.exists(upload);
  await act(async () => upload.result.resolve(uploaded("ready.txt")));
  await expect(work).resolves.toEqual([uploaded("ready.txt")]);
  expect(before.result.current.items[0]?.status).toBe("ready");
  before.unmount();
  const { clearAttachmentDraft } = await import("./attachment-draft");
  clearAttachmentDraft(h.session, key);
  const after = renderHook(() => useAttachmentDraft(h.session, key, "one"));
  expect(after.result.current.items).toEqual([]);
  expect(h.calls).toHaveLength(1);
});

it("adds a copied snapshot without reupload, deduplicates and permits removal", async () => {
  const h = fixture();
  const draft = renderHook(() =>
    useAttachmentDraft(h.session, "copied", "one"),
  );
  const descriptor = {
    ...uploaded("helper.agent.png"),
    type: "image/png",
    size: 2048,
  };
  act(() => {
    draft.result.current.store.addUploaded(descriptor);
    draft.result.current.store.addUploaded(descriptor);
  });
  expect(draft.result.current.items).toHaveLength(1);
  expect(draft.result.current.items[0]?.status).toBe("ready");
  expect(
    await draft.result.current.store.prepareForSend(
      new AbortController().signal,
    ),
  ).toEqual([descriptor]);
  expect(h.upload).not.toHaveBeenCalled();
  const item = draft.result.current.items[0];
  assert.exists(item);
  act(() => draft.result.current.store.remove(item.id));
  expect(draft.result.current.items).toHaveLength(0);
});

it("Send transfers the eager queue once and cancellation freezes active and queued attachments", async () => {
  const h = fixture();
  const source = renderHook(() =>
    useAttachmentDraft(h.session, "composer", "one"),
  );
  act(() =>
    source.result.current.store.add([
      file("1.txt"),
      file("2.txt"),
      file("3.txt"),
    ]),
  );
  await waitFor(() => expect(h.calls).toHaveLength(1));
  const target = attachmentDraft(h.session, "background", "one");
  const stop = target.subscribe(() => {});
  const send = new AbortController();
  act(() => transferAttachmentDraft(source.result.current.store, target));
  act(() => source.result.current.store.clear());
  source.unmount();
  expect(h.calls[0]?.signal.aborted).toBe(false);
  const work = target.prepareForSend(send.signal);
  h.calls[0]?.result.resolve(uploaded("1.txt"));
  await waitFor(() => expect(h.calls).toHaveLength(2));
  h.calls[1]?.progress?.(3, 5);
  expect(target.snapshot()[1]?.transfer).toEqual({ sent: 3, total: 5 });
  send.abort();
  await expect(work).rejects.toThrow();
  expect(h.calls[1]?.signal.aborted).toBe(true);
  const recovered = target.snapshot();
  expect(recovered.map((item) => item.status)).toEqual([
    "ready",
    "error",
    "error",
  ]);
  h.calls[1]?.result.resolve(uploaded("2.txt"));
  await Promise.all(h.calls.map((call) => call.result.promise));
  expect(target.snapshot()).toBe(recovered);
  expect(h.upload).toHaveBeenCalledTimes(2);
  stop();
});

it("renders real host transfer bytes as a determinate ring through completion", async () => {
  const h = fixture();
  function Draft() {
    const draft = useAttachmentDraft(h.session, "progress-ring", "one");
    return (
      <>
        <button type="button" onClick={() => draft.store.add([file()])}>
          Attach fixture
        </button>
        <ComposerAttachments
          items={draft.items}
          disabled={false}
          remove={draft.store.remove}
          retry={draft.store.retry}
          media={() => undefined}
        />
      </>
    );
  }
  render(<Draft />);
  fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
  await waitFor(() => expect(h.calls).toHaveLength(1));
  const call = h.calls[0];
  assert.exists(call);
  expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(
    false,
  );
  for (const sent of [0, 2, 5]) {
    act(() => call.progress?.(sent, 5));
    const ring = screen.getByRole("progressbar");
    expect(ring.getAttribute("aria-valuenow")).toBe(String(sent * 20));
    expect(
      ring
        .querySelector("[data-upload-progress]")
        ?.getAttribute("stroke-dasharray"),
    ).toBe(`${sent * 20} 100`);
  }
  await act(async () => {
    call.result.resolve(uploaded());
  });
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
});

it("rejects eager upload errors until explicit Retry, including after Send handoff", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() => draft.result.current.store.add([file()]));
  await waitFor(() => expect(h.calls).toHaveLength(1));
  await act(async () => h.calls[0]?.result.reject(new Error("relay down")));
  expect(draft.result.current.blocked).toBe(true);
  const target = attachmentDraft(h.session, "send", "one");
  act(() => transferAttachmentDraft(draft.result.current.store, target));
  await expect(
    target.prepareForSend(new AbortController().signal),
  ).rejects.toThrow("relay down");
  expect(h.calls).toHaveLength(1);
  expect(target.snapshot()[0]?.status).toBe("error");
  target.retry(target.snapshot()[0]?.id ?? "");
  await waitFor(() => expect(h.calls).toHaveLength(2));
  const work = target.prepareForSend(new AbortController().signal);
  h.calls[1]?.result.resolve(uploaded());
  await expect(work).resolves.toEqual([uploaded()]);
});

it("a new chat's draft uploads before its channel exists", async () => {
  const h = fixture();
  const uploadForNewChat = vi.fn(
    async (_file: globalThis.File, _signal: AbortSignal) => uploaded(),
  );
  const session = {
    attachments: { upload: h.upload, uploadForNewChat },
  } as unknown as RelaySession;
  const store = attachmentDraft(session, "new-chat", "draft-id", true);
  store.add([file()]);
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  expect(h.upload).not.toHaveBeenCalled();
  await waitFor(() => expect(store.snapshot()[0]?.status).toBe("ready"));
  await expect(
    store.prepareForSend(new AbortController().signal),
  ).resolves.toEqual([uploaded()]);
});
