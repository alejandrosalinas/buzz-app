// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuzzLinkPreview, previewFailures } from "./BuzzLinkPreview";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import type {
  ChannelList,
  ChannelMessage,
  ChannelReference,
} from "../relay/contracts";
import { mediaUrl } from "../relay/transport";

afterEach(cleanup);
const text = (tree: HTMLElement) =>
  tree.querySelector('[role="status"]')?.textContent;
const root: ChannelMessage = {
  id: "a".repeat(64),
  channelId: "channel",
  authorId: "b".repeat(64),
  content: "reconciled body",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
/** Without a `reference`, the session offers no channel lookup, as a
 * cached-only one doesn't. Each read starts at the next of `snapshots`; the
 * last repeats. */
function setup(
  snapshots: ThreadSnapshot | readonly ThreadSnapshot[],
  messageId = root.id,
  profiles = new Map<string, { name?: string; picture?: string }>(),
  reference?: ChannelReference,
  status: ChannelList["status"] = "ready",
) {
  const views: { view: ThreadView; publish(next: ThreadSnapshot): void }[] = [];
  const starts = [snapshots].flat();
  const thread = vi.fn(() => {
    let current = starts[Math.min(views.length, starts.length - 1)] ?? base;
    const listeners = new Set<() => void>();
    const view = {
      snapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      refresh: vi.fn(async () => {}),
      loadMore: vi.fn(async () => {}),
      retarget: vi.fn<ThreadView["retarget"]>(async () => "selected"),
      dispose: vi.fn(),
    } satisfies ThreadView;
    views.push({
      view,
      publish(next) {
        current = next;
        act(() => {
          for (const listener of listeners) listener();
        });
      },
    });
    return view;
  });
  let list = {
    status,
    channels: [{ id: "channel", name: "General" }],
  };
  let described = reference;
  const listListeners = new Set<() => void>();
  // As in the store, a demanded lookup is on the way at once, and its batch
  // tells list subscribers from a microtask. A found channel keeps its name;
  // a readable one is not looked up.
  let lookups = 0;
  const refer = vi.fn(() => {
    if (described?.state === "found" && described.readable !== false)
      return () => {};
    lookups++;
    described =
      described?.state === "found"
        ? { ...described, looking: true }
        : { state: "looking" };
    queueMicrotask(() => {
      for (const listener of listListeners) listener();
    });
    return () => {};
  });
  const session = {
    thread,
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: vi.fn(async () => {}),
    },
    channels: {
      subscribeList: (listener: () => void) => {
        listListeners.add(listener);
        return () => listListeners.delete(listener);
      },
      list: () => list,
      ...(reference && {
        describe: () => described,
        refer,
      }),
    },
    // The real sizing rewrite behind a pass-through proxy, as the session applies it.
    media: (url: string, size?: "small") =>
      mediaUrl(url, (proxied) => proxied, "https://relay.test", size),
  } as unknown as RelaySession;
  const mounted = render(
    <BuzzLinkPreview
      session={session}
      channelId="channel"
      messageId={messageId}
    />,
  );
  return {
    tree: mounted.container,
    thread,
    views,
    refer,
    lookups: () => lookups,
    /** The channel lookup answers, or discovery moves the list on, as the
     * store notifies list subscribers. */
    answer(next: ChannelReference, nextStatus = list.status) {
      described = next;
      list = { ...list, status: nextStatus };
      act(() => {
        for (const listener of listListeners) listener();
      });
    },
  };
}
const base: ThreadSnapshot = {
  status: "idle",
  root: undefined,
  replies: [],
  error: undefined,
  canLoadMore: false,
  limited: false,
};
it("does not paint the seed root until the snapshot reconciles edits and deletions", () => {
  // A seeded but still-loading view exposes the raw root; a cached deletion or
  // edit is a different event that only folds in once the read reaches "ready".
  const seeded = setup({
    ...base,
    status: "loading",
    root,
    canLoadMore: true,
  }).tree;
  expect(text(seeded)).toBe("Loading message…");
  expect(seeded.querySelector("strong")).toBeNull();
  const idleSeed = setup({ ...base, status: "idle", root }).tree;
  expect(text(idleSeed)).toBe("Loading message…");
  const ready = setup({ ...base, status: "ready", root }).tree;
  expect(ready.querySelector("strong")).not.toBeNull();
});
const open: ChannelReference = {
  state: "found",
  name: "open",
  channelType: "stream",
  private: false,
  hidden: false,
  archived: false,
  joined: false,
};
const purged: ThreadSnapshot = {
  ...base,
  status: "idle",
  error: "This channel is no longer available.",
};
it("says why each stopped read fails instead of loading forever, and that the card opens", () => {
  const failed = setup({ ...base, status: "error", error: "read failed" });
  expect(text(failed.tree)).toBe(previewFailures.unavailable);
  expect(failed.tree.textContent).toContain("Open link");
  // purge() on a denied or revoked channel publishes idle + an error string,
  // never status "error". With no lookup to wait for, the card still stops.
  expect(text(setup(purged).tree)).toBe(previewFailures.unavailable);
  const exhausted = setup({ ...base, status: "ready", root: undefined });
  expect(text(exhausted.tree)).toBe(previewFailures["not-found"]);
  // A readable channel without the message names the channel. An empty exact
  // read isn't evidence of a deletion, so the card doesn't claim one.
  const missing = setup(
    { ...base, status: "ready", targetStatus: "unavailable" },
    root.id,
    undefined,
    open,
  );
  expect(text(missing.tree)).toBe(
    "This message isn’t available. It may have been deleted.",
  );
  expect(missing.tree.querySelector("strong")?.textContent).toBe("open");
  expect(missing.tree.textContent).toContain("Public channel · Not joined");
  expect(missing.tree.textContent).toContain("Open link");
  const withheld = setup(base, root.id, undefined, { state: "withheld" });
  expect(text(withheld.tree)).toBe(previewFailures.withheld);
  expect(withheld.tree.textContent).toContain("Open link");
  expect(withheld.thread).not.toHaveBeenCalled();
});
it("waits for the channel lookup before trusting a refused read, then reads again", () => {
  const h = setup([purged, base], root.id, undefined, { state: "looking" });
  expect(text(h.tree)).toBe("Loading message…");
  // Nothing the answer paints, even before the fresh read, is the refusal.
  const painted: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        painted.push(node.textContent ?? "");
  });
  observer.observe(h.tree, { childList: true, subtree: true });
  h.answer(open);
  for (const record of observer.takeRecords())
    for (const node of record.addedNodes) painted.push(node.textContent ?? "");
  observer.disconnect();
  expect(painted.join(" ")).not.toContain(previewFailures.unavailable);
  expect(h.thread).toHaveBeenCalledTimes(2);
  expect(h.views[0]?.view.dispose).toHaveBeenCalledOnce();
  expect(h.views[1]?.view.refresh).toHaveBeenCalledOnce();
  expect(text(h.tree)).toBe("Loading message…");
  h.views[1]?.publish({ ...base, status: "ready", root });
  expect(h.tree.textContent).toContain("reconciled body");
});
it("never shows a read that started before the lookup found the channel", () => {
  const h = setup(
    [{ ...base, status: "loading", canLoadMore: true }, base],
    root.id,
    undefined,
    { state: "looking" },
  );
  h.answer(open);
  // The first read's later refusal belongs to a disposed view.
  h.views[0]?.publish(purged);
  expect(text(h.tree)).toBe("Loading message…");
  h.views[1]?.publish({ ...base, status: "ready", root });
  expect(h.tree.textContent).toContain("reconciled body");
});
it("stops reading a channel the lookup withholds", () => {
  const h = setup(purged, root.id, undefined, { state: "looking" });
  h.answer({ state: "withheld" });
  expect(text(h.tree)).toBe(previewFailures.withheld);
  expect(h.thread).toHaveBeenCalledOnce();
  expect(h.views[0]?.view.dispose).toHaveBeenCalledOnce();
});
it("stops waiting when the channel lookup fails while the read is refused", () => {
  const h = setup(purged, root.id, undefined, { state: "looking" });
  expect(text(h.tree)).toBe("Loading message…");
  // The store backs off after a failed lookup, so none is on the way.
  h.answer({ state: "unknown" });
  expect(text(h.tree)).toBe(previewFailures.unavailable);
  expect(h.tree.textContent).toContain("Open link");
  expect(h.thread).toHaveBeenCalledOnce();
});
it("waits while the channel list loads, and trusts a refused read once it errors", () => {
  const h = setup(purged, root.id, undefined, { state: "unknown" }, "loading");
  // A ready list would look the channel up, so the refusal isn't shown yet.
  expect(text(h.tree)).toBe("Loading message…");
  expect(h.refer).not.toHaveBeenCalled();
  h.answer({ state: "unknown" }, "error");
  expect(text(h.tree)).toBe(previewFailures.unavailable);
  expect(h.tree.textContent).toContain("Open link");
  expect(h.refer).not.toHaveBeenCalled();
  expect(h.thread).toHaveBeenCalledOnce();
});
it("waits for the lookup a ready list starts, then reads again", async () => {
  const h = setup(
    [purged, base],
    root.id,
    undefined,
    { state: "unknown" },
    "loading",
  );
  expect(text(h.tree)).toBe("Loading message…");
  // The ready list demands the lookup, and its batch says it is on the way.
  await act(async () => h.answer({ state: "unknown" }, "ready"));
  expect(text(h.tree)).toBe("Loading message…");
  expect(h.refer).toHaveBeenCalledOnce();
  expect(h.thread).toHaveBeenCalledOnce();
  h.answer(open);
  expect(h.thread).toHaveBeenCalledTimes(2);
  expect(h.views[0]?.view.dispose).toHaveBeenCalledOnce();
  expect(h.views[1]?.view.refresh).toHaveBeenCalledOnce();
  expect(text(h.tree)).toBe("Loading message…");
  h.views[1]?.publish({ ...base, status: "ready", root });
  expect(h.tree.textContent).toContain("reconciled body");
});
it("looks up a channel the viewer left before trusting a refused read, then reads again", async () => {
  // Discovery stopped admitting it, though its open metadata still names it.
  const h = setup([purged, base], root.id, undefined, {
    ...(open as Extract<ChannelReference, { state: "found" }>),
    readable: false,
  });
  await act(async () => {});
  expect(h.refer).toHaveBeenCalledOnce();
  expect(text(h.tree)).toBe("Loading message…");
  expect(h.thread).toHaveBeenCalledOnce();
  // The lookup admits it again with the same metadata.
  h.answer(open);
  expect(h.thread).toHaveBeenCalledTimes(2);
  expect(h.views[0]?.view.dispose).toHaveBeenCalledOnce();
  expect(h.views[1]?.view.refresh).toHaveBeenCalledOnce();
  expect(text(h.tree)).toBe("Loading message…");
  h.views[1]?.publish({ ...base, status: "ready", root });
  expect(h.tree.textContent).toContain("reconciled body");
  // The readable answer still holds the link's demand, without a lookup.
  expect(h.lookups()).toBe(1);
});
it("keeps loading while a read is genuinely in flight", () => {
  const loading = setup({
    ...base,
    status: "loading",
    canLoadMore: true,
  }).tree;
  expect(text(loading)).toBe("Loading message…");
});
it("renders the exact target independently of bounded thread replies", () => {
  const target = {
    ...root,
    id: "c".repeat(64),
    content: "reply beyond bounded traversal",
    threadRootId: root.id,
  };
  const result = setup(
    {
      ...base,
      status: "ready",
      root,
      target,
      targetStatus: "ready",
    },
    target.id,
  );
  expect(result.thread).toHaveBeenCalledWith("channel", target.id, {
    exact: true,
  });
  expect(result.tree.textContent).toContain("reply beyond bounded traversal");
});
it("renders a reconciled exact target when its thread root is unavailable", () => {
  const target = {
    ...root,
    id: "c".repeat(64),
    content: "reply with unavailable root",
    threadRootId: root.id,
  };
  const result = setup(
    {
      ...base,
      status: "error",
      error: "Thread root is unavailable.",
      target,
      targetStatus: "ready",
    },
    target.id,
  );
  expect(result.tree.textContent).toContain("reply with unavailable root");
});
it("fails safely when an exact target timestamp is outside Date range", () => {
  const target = { ...root, createdAt: 8_640_000_000_001 };
  const result = setup({
    ...base,
    status: "ready",
    root,
    target,
    targetStatus: "ready",
  });
  expect(text(result.tree)).toBe(previewFailures.unavailable);
});

it("labels a workflow preview as automation, with an owner fallback instead of a signer avatar", () => {
  const workflow = { ...root, workflowOwnerId: "c".repeat(64) };
  const { tree } = setup({ ...base, status: "ready", root: workflow });
  expect(tree.querySelector("strong")?.textContent).toBe(
    "Workflow · owned by cccccccccc",
  );
  expect(tree.querySelector("img")).toBeNull();
});

it("asks for the relay thumbnail of the author's picture, as message rows do", () => {
  const sha = "d".repeat(64);
  const { tree } = setup(
    { ...base, status: "ready", root },
    root.id,
    new Map([
      [
        root.authorId,
        { name: "Bea", picture: `https://relay.test/media/${sha}.png` },
      ],
    ]),
  );
  expect(tree.querySelector("img")?.getAttribute("src")).toBe(
    `https://relay.test/media/${sha}.thumb.webp`,
  );
});
