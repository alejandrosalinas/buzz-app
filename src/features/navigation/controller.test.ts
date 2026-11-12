import { afterEach, describe, expect, it, vi } from "vitest";
import { createNavigationController, NAVIGATION_ABORTED } from "./controller";
import { createMemoryHistory, homeTarget } from "./history";
import type { OpenTarget } from "./targets";
const settings: OpenTarget = {
  version: 1,
  kind: "settings",
  section: "appearance",
};
const page: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: "test",
  pageId: "board",
};
const cleanups: (() => void)[] = [];
function setup(capacity = 100, presenter = true) {
  const history = createMemoryHistory(homeTarget, capacity);
  const host = createNavigationController(history);
  cleanups.push(host.dispose);
  // The deadline measures a presenter; the app's attaches on mount.
  if (presenter) cleanups.push(host.attach());
  return { host, navigation: host.navigation, history };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("navigation attempts over one history driver", () => {
  it("keeps sidebar intent through resolution and retry, and clears it for an explicit open or history", async () => {
    const { host, navigation: nav } = setup();
    void nav.open(page, { sidebar: "preserve" });
    expect(nav.snapshot().attempt.sidebar).toBe("preserve");
    expect(host.resolve(nav.snapshot().attempt, settings)).toBe(true);
    expect(nav.snapshot().attempt.sidebar).toBe("preserve");
    const retry = nav.retry();
    expect(nav.snapshot().attempt.sidebar).toBe("preserve");
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(retry).resolves.toEqual({ status: "opened" });
    void nav.open(settings);
    expect(nav.snapshot().attempt.sidebar).toBeUndefined();
    void nav.open(page, { sidebar: "preserve" });
    nav.back();
    expect(nav.snapshot().attempt.sidebar).toBeUndefined();
    nav.forward();
    expect(nav.snapshot().attempt.sidebar).toBeUndefined();
  });
  it("dismissing an inactive visit preserves the selected attempt and its signal", () => {
    const { navigation: nav } = setup();
    void nav.open(settings);
    const dismissed = nav.snapshot().entry.id;
    void nav.open(page);
    const attempt = nav.snapshot().attempt;
    nav.dismiss([dismissed], homeTarget);
    expect(nav.snapshot().attempt).toBe(attempt);
    expect(attempt.signal.aborted).toBe(false);
    nav.back();
    expect(nav.snapshot().entry.target).toEqual(homeTarget);
  });
  it("keeps Members through passive traversal but retires an explicit dismissal", async () => {
    const { host, navigation: nav } = setup();
    const conversation: OpenTarget = {
      version: 1,
      kind: "conversation",
      scope: {
        viewer: "a".repeat(64),
        communityOrigin: "https://relay.example",
      },
      channelId: "alpha",
    };
    const members: OpenTarget = { ...conversation, panel: "members" };
    void nav.open(settings);
    void nav.open(conversation);
    const channel = nav.snapshot().entry;
    // Opening is a visit: Back closes Members on the same channel.
    const opened = nav.open(members, { replace: false });
    expect(nav.snapshot().entry.target).toEqual(members);
    expect(nav.snapshot().entry.id).not.toBe(channel.id);
    const membersId = nav.snapshot().entry.id;
    expect(nav.snapshot().canGoForward).toBe(false);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(opened).resolves.toEqual({ status: "opened" });
    nav.back();
    expect(nav.snapshot().entry).toEqual(channel);
    expect(nav.snapshot().canGoForward).toBe(true);
    nav.forward();
    expect(nav.snapshot().entry.target).toEqual(members);
    // X removes the return path without adding a closed-dialog visit.
    nav.dismiss([membersId], conversation);
    expect(nav.snapshot().entry).toEqual(channel);
    expect(nav.snapshot().entry.target).toEqual(conversation);
    expect(nav.snapshot().canGoForward).toBe(false);
    nav.back();
    expect(nav.snapshot().entry.target).toEqual(settings);
    nav.forward();
    expect(nav.snapshot().entry.target).toEqual(conversation);
    expect(nav.snapshot().canGoForward).toBe(false);
    // Explicitly reopening remains possible, including over an exact message.
    void nav.open({ ...members, messageId: "b".repeat(64) });
    nav.back();
    expect(nav.snapshot().entry.target).toEqual(conversation);
  });
  it.each([true, false])(
    "keeps one channel visit beneath a Members handoff (warm: %s)",
    (warm) => {
      const { navigation: nav } = setup();
      const conversation: OpenTarget = {
        version: 1,
        kind: "conversation",
        scope: {
          viewer: "a".repeat(64),
          communityOrigin: "https://relay.example",
        },
        channelId: "alpha",
      };
      if (warm) void nav.open(conversation);
      void nav.open({ ...conversation, panel: "members" });
      void nav.open({ ...conversation, channelId: "dm" });
      nav.back();
      expect(nav.snapshot().entry.target).toEqual(conversation);
      nav.back();
      expect(nav.snapshot().entry.target).toEqual(homeTarget);
    },
  );

  it("pushes, traverses without a push, preserves forward on retry, and truncates new branches", async () => {
    const { host, navigation: nav } = setup();
    const initial = nav.snapshot().entry;
    const first = nav.open(settings);
    const settingsEntry = nav.snapshot().entry;
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(first).resolves.toEqual({ status: "opened" });
    void nav.open(page);
    expect(nav.snapshot().attempt.traversal).toBeUndefined();
    nav.back();
    expect(nav.snapshot().entry).toBe(settingsEntry);
    expect(nav.snapshot().canGoForward).toBe(true);
    // Traversal returns to a visit; retry and a same-target open open it again.
    expect(nav.snapshot().attempt.traversal).toBe(true);
    const retry = nav.retry();
    expect(nav.snapshot().entry).toBe(settingsEntry);
    expect(nav.snapshot().canGoForward).toBe(true);
    expect(nav.snapshot().attempt.traversal).toBeUndefined();
    const same = nav.open(settings);
    await expect(retry).resolves.toEqual({ status: "superseded" });
    expect(nav.snapshot().entry).toBe(settingsEntry);
    expect(nav.snapshot().canGoForward).toBe(true);
    expect(nav.snapshot().attempt.traversal).toBeUndefined();
    nav.forward();
    await expect(same).resolves.toEqual({ status: "superseded" });
    expect(nav.snapshot().entry.target).toEqual(page);
    expect(nav.snapshot().attempt.traversal).toBe(true);
    nav.back();
    nav.back();
    expect(nav.snapshot().entry).toBe(initial);
    void nav.open({ version: 1, kind: "settings", section: "plugins" });
    expect(nav.snapshot().canGoForward).toBe(false);
  });
  it("dismisses a modal visit back to its opener, or replaces it, without adding a visit", () => {
    const { navigation: nav } = setup();
    void nav.open(page);
    const opener = nav.snapshot().entry;
    void nav.open(settings);
    void nav.open(page, { dismiss: true });
    expect(nav.snapshot().entry).toBe(opener);
    expect(nav.snapshot().canGoForward).toBe(true);
    nav.forward();
    const other: OpenTarget = { ...page, pageId: "other" };
    void nav.open(other, { dismiss: true });
    expect(nav.snapshot().entry.target).toEqual(other);
    expect(nav.snapshot().canGoForward).toBe(false);
    nav.back();
    expect(nav.snapshot().entry).toBe(opener);
  });
  it("counts a return to a visit history held as traversal, not a dismissal's new fallback", () => {
    const { navigation: nav } = setup();
    void nav.open(page);
    const opener = nav.snapshot().entry;
    void nav.open(settings);
    nav.dismiss([nav.snapshot().entry.id], page);
    expect(nav.snapshot().entry).toBe(opener);
    expect(nav.snapshot().attempt.traversal).toBe(true);
    void nav.open(settings);
    const dialog = nav.snapshot().entry.id;
    // The fallback isn't the preceding visit, so it replaces the dialog anew.
    nav.dismiss([dialog], homeTarget);
    expect(nav.snapshot().entry.target).toEqual(homeTarget);
    expect(nav.snapshot().entry.id).not.toBe(dialog);
    expect(nav.snapshot().attempt.traversal).toBeUndefined();
  });
  it("rejects late acknowledgments and aborts obsolete work even after successful reveal", async () => {
    const { host, navigation: nav } = setup();
    const first = nav.open(settings),
      old = nav.snapshot().attempt;
    const second = nav.open(page),
      current = nav.snapshot().attempt;
    expect(old.signal.aborted).toBe(true);
    expect(host.complete(old, { status: "opened" })).toBe(false);
    expect(nav.snapshot().status).toBe("opening");
    expect(host.complete({ ...current }, { status: "opened" })).toBe(false);
    expect(host.complete(current, { status: "opened" })).toBe(true);
    expect(host.complete(current, { status: "opened" })).toBe(false);
    await expect(first).resolves.toEqual({ status: "superseded" });
    await expect(second).resolves.toEqual({ status: "opened" });
    void nav.retry();
    expect(current.signal.aborted).toBe(true);
    // One shared reason: a fresh DOMException per abort would carry a stack
    // that pins the next attempt and the opening click's target DOM.
    expect(old.signal.reason).toBeInstanceOf(DOMException);
    expect(old.signal.reason.name).toBe("AbortError");
    expect(current.signal.reason).toBe(old.signal.reason);
    expect(nav.snapshot().attempt.id).not.toBe(current.id);
  });
  it("reports truthful failure, timeout and cancellation and keeps the original target retryable", async () => {
    vi.useFakeTimers();
    const { host, navigation: nav } = setup();
    const first = nav.open(settings);
    host.complete(nav.snapshot().attempt, {
      status: "failed",
      reason: "unavailable",
    });
    await expect(first).resolves.toEqual({
      status: "failed",
      reason: "unavailable",
    });
    expect(nav.snapshot().entry.target).toEqual(settings);
    expect(nav.snapshot().attempt.signal.aborted).toBe(true);
    expect(nav.snapshot().attempt.signal.reason).toBe(NAVIGATION_ABORTED);
    const retry = nav.retry();
    expect(nav.snapshot().reason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(retry).resolves.toEqual({
      status: "failed",
      reason: "timeout",
    });
    const cancelled = nav.retry();
    const attempt = nav.snapshot().attempt;
    host.cancel();
    expect(attempt.signal.reason).toBe(NAVIGATION_ABORTED);
    await expect(cancelled).resolves.toEqual({ status: "cancelled" });
    expect(nav.snapshot().entry.target).toEqual(settings);
  });
  it("keeps a failure presented in place authoritative until its visit is left", async () => {
    const { host, navigation: nav } = setup();
    const opened = nav.open(settings);
    const attempt = nav.snapshot().attempt;
    host.complete(attempt, {
      status: "failed",
      reason: "unavailable",
      presented: true,
    });
    await expect(opened).resolves.toMatchObject({ status: "failed" });
    expect(nav.snapshot()).toMatchObject({ status: "failed", presented: true });
    expect(attempt.signal.aborted).toBe(false);
    expect(host.complete(attempt, { status: "opened" })).toBe(false);
    void nav.open(page);
    expect(attempt.signal.reason).toBe(NAVIGATION_ABORTED);
    expect(nav.snapshot().presented).toBeUndefined();
  });
  it("keeps a shown page when a later attempt on its visit times out", async () => {
    vi.useFakeTimers();
    const { host, navigation: nav } = setup();
    void nav.open(page);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    // A background retry times out: the page stays, with its authority.
    const retry = nav.retry();
    const retried = nav.snapshot().attempt;
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(retry).resolves.toEqual({
      status: "failed",
      reason: "timeout",
      presented: true,
    });
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "timeout",
      presented: true,
    });
    expect(retried.signal.aborted).toBe(false);
    // The page answers late: its visit is open again, once.
    expect(host.complete(retried, { status: "opened" })).toBe(true);
    expect(nav.snapshot().status).toBe("opened");
    expect(nav.snapshot().reason).toBeUndefined();
    expect(nav.snapshot().presented).toBeUndefined();
    expect(host.complete(retried, { status: "opened" })).toBe(false);
    // A late failure the page reports itself replaces it, as an early one does.
    void nav.retry();
    const slow = nav.snapshot().attempt;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(nav.snapshot()).toMatchObject({ status: "failed", presented: true });
    expect(
      host.complete(slow, { status: "failed", reason: "unavailable" }),
    ).toBe(true);
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "unavailable",
    });
    expect(nav.snapshot().presented).toBeUndefined();
    expect(slow.signal.aborted).toBe(true);
    // The card now covers the page, so this visit opens afresh.
    void nav.retry();
    host.complete(nav.snapshot().attempt, { status: "opened" });
    // A same-target open that times out keeps it too.
    void nav.open(page);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(nav.snapshot()).toMatchObject({ status: "failed", presented: true });
    // A failure the page reports itself still replaces it, a timeout included:
    // only this controller's own deadline keeps the page.
    for (const reason of ["unavailable", "denied", "timeout"] as const) {
      void nav.retry();
      host.complete(nav.snapshot().attempt, { status: "opened" });
      void nav.retry();
      host.complete(nav.snapshot().attempt, { status: "failed", reason });
      expect(nav.snapshot()).toMatchObject({ status: "failed", reason });
      expect(nav.snapshot().presented).toBeUndefined();
      // The reported failure covered the page: a later timeout shows the card.
      void nav.retry();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(nav.snapshot().presented).toBeUndefined();
    }
  });
  it("lets a kept page normalize its address before its late answer", async () => {
    vi.useFakeTimers();
    const { host, navigation: nav } = setup();
    void nav.open(page);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    void nav.retry();
    const kept = nav.snapshot().attempt;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(nav.snapshot()).toMatchObject({ status: "failed", presented: true });
    // The page learns its address only after the deadline, then answers.
    const routed: OpenTarget = { ...page, route: { version: 1, params: "a" } };
    expect(host.resolve(kept, routed)).toBe(true);
    const current = nav.snapshot().attempt;
    expect(current.entry.id).toBe(kept.entry.id);
    expect(current.entry.target).toEqual(routed);
    expect(host.complete(kept, { status: "opened" })).toBe(false);
    expect(host.complete(current, { status: "opened" })).toBe(true);
    expect(nav.snapshot().status).toBe("opened");
    // Once answered, the attempt no longer accepts a late address.
    expect(host.resolve(current, page)).toBe(false);
  });
  it("lets the host replace a kept page whose deadline passed while it was not drawn", async () => {
    vi.useFakeTimers();
    const { host, navigation: nav } = setup();
    void nav.open(page);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    void nav.retry();
    const kept = nav.snapshot().attempt;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(nav.snapshot()).toMatchObject({ status: "failed", presented: true });
    // The host was drawing its loading state, so its failure covers the page.
    expect(host.complete(kept, { status: "failed", reason: "timeout" })).toBe(
      true,
    );
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "timeout",
    });
    expect(nav.snapshot().presented).toBeUndefined();
    expect(kept.signal.aborted).toBe(true);
    // Its card covers the page, so a later timeout on this visit shows it too.
    void nav.retry();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(nav.snapshot().presented).toBeUndefined();
  });
  it("replaces a page with a failure once another visit was opened over it", async () => {
    vi.useFakeTimers();
    const { host, navigation: nav } = setup();
    void nav.open(page);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    void nav.open(settings);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "timeout",
    });
    expect(nav.snapshot().presented).toBeUndefined();
    // Back to the page: its content is no longer what is shown.
    nav.back();
    expect(nav.snapshot().entry.target).toEqual(page);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "timeout",
    });
    expect(nav.snapshot().presented).toBeUndefined();
  });
  it("still shows an incoming link's failure over a shown page", async () => {
    const { host, navigation: nav } = setup();
    void nav.open(page);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    host.fail("unavailable", () => Promise.resolve({ status: "cancelled" }));
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "unavailable",
      ingress: true,
    });
    expect(nav.snapshot().presented).toBeUndefined();
    // Its card covers the page: reopening the page and timing out shows the
    // card, not a page that never answered.
    vi.useFakeTimers();
    void nav.open(page);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "timeout",
    });
    expect(nav.snapshot().presented).toBeUndefined();
  });
  it("rejects invalid targets before cancelling or moving the current intent", async () => {
    const { navigation: nav } = setup();
    void nav.open(settings);
    const before = nav.snapshot();
    await expect(
      nav.open({ version: 42 } as unknown as OpenTarget),
    ).resolves.toEqual({ status: "failed", reason: "invalid-target" });
    expect(nav.snapshot()).toBe(before);
    expect(before.attempt.signal.aborted).toBe(false);
  });
  it("records a host ingress failure against the current visit without moving or inventing one", async () => {
    const { host, navigation: nav } = setup();
    const opened = nav.open(settings);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(opened).resolves.toEqual({ status: "opened" });
    const entry = nav.snapshot().entry;
    const listener = vi.fn();
    nav.subscribe(listener);
    host.fail("invalid-target");
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "invalid-target",
      entry,
      canGoBack: true,
    });
    expect(nav.snapshot().attempt.signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalled();
    // An invalid incoming URL cannot accidentally retry the previous visit.
    await expect(nav.retry()).resolves.toEqual({
      status: "failed",
      reason: "invalid-target",
    });
    expect(nav.snapshot().status).toBe("failed");
    expect(nav.snapshot().retryable).toBe(false);
    expect(nav.snapshot().entry).toBe(entry);
    // A failure while another open is pending supersedes it like any new intent.
    const pending = nav.open(page);
    host.fail("unavailable");
    await expect(pending).resolves.toEqual({ status: "superseded" });
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "unavailable",
    });
    expect(nav.snapshot().entry.target).toEqual(page);
    const settled = nav.snapshot();
    host.dispose();
    host.fail("unavailable");
    expect(nav.snapshot()).toBe(settled);
  });
  it("keeps separate visit identities for the same destination; replace doesn't push", () => {
    const { navigation: nav } = setup();
    void nav.open(settings);
    const first = nav.snapshot().entry;
    void nav.open(page);
    void nav.open(settings);
    expect(nav.snapshot().entry.id).not.toBe(first.id);
    nav.back();
    expect(nav.snapshot().entry.target).toEqual(page);
    void nav.open(homeTarget, { replace: true });
    nav.back();
    expect(nav.snapshot().entry).toBe(first);
    nav.forward();
    expect(nav.snapshot().entry.target).toEqual(homeTarget);
    nav.forward();
    expect(nav.snapshot().entry.target).toEqual(settings);
  });
  describe("a visit whose page passes through", () => {
    const draft: OpenTarget = { ...page, pageId: "draft" };
    const other: OpenTarget = { ...page, pageId: "other" };
    function onDraft(passes: () => boolean) {
      const t = setup();
      void t.navigation.open(page);
      void t.navigation.open(draft);
      const stop = t.host.passThrough(t.navigation.snapshot().entry.id, passes);
      return { ...t, stop };
    }
    it("is replaced by the next page while it holds nothing", () => {
      const { navigation: nav } = onDraft(() => true);
      void nav.open(other);
      nav.back();
      expect(nav.snapshot().entry.target).toEqual(page);
    });
    it("returns to its opener when that page opens again", () => {
      const t = setup();
      const nav = t.navigation;
      void nav.open(page);
      const opener = nav.snapshot().entry;
      void nav.open(draft);
      t.host.passThrough(nav.snapshot().entry.id, () => true);
      void nav.open(page);
      expect(nav.snapshot().entry).toBe(opener);
      nav.back();
      expect(nav.snapshot().entry.target).not.toEqual(page);
    });
    it("stays a Back stop while it holds something", () => {
      const { navigation: nav } = onDraft(() => false);
      void nav.open(other);
      nav.back();
      expect(nav.snapshot().entry.target).toEqual(draft);
    });
    it("stays under Settings, which returns to it", () => {
      const { navigation: nav } = onDraft(() => true);
      void nav.open(settings);
      nav.back();
      expect(nav.snapshot().entry.target).toEqual(draft);
    });
    it("is still replaced after returning from Settings", () => {
      const { navigation: nav } = onDraft(() => true);
      void nav.open(settings);
      nav.back();
      expect(nav.snapshot().canGoForward).toBe(true);
      void nav.open(other);
      nav.back();
      expect(nav.snapshot().entry.target).toEqual(page);
    });
    it("stays when its page cannot answer", () => {
      const { navigation: nav } = onDraft(() => {
        throw new Error("unavailable");
      });
      void nav.open(other);
      expect(nav.snapshot().entry.target).toEqual(other);
      nav.back();
      expect(nav.snapshot().entry.target).toEqual(draft);
    });
    it("stays once its page stops reporting", () => {
      const { navigation: nav, stop } = onDraft(() => true);
      stop();
      void nav.open(other);
      nav.back();
      expect(nav.snapshot().entry.target).toEqual(draft);
    });
  });
  it("uses driver-initiated traversal and bounds the memory driver without inventing history", () => {
    const { navigation: nav, history } = setup(2);
    void nav.open(settings);
    void nav.open(page);
    history.back();
    expect(nav.snapshot().entry.target).toEqual(settings);
    expect(nav.snapshot().canGoBack).toBe(false);
    expect(nav.snapshot().attempt.traversal).toBe(true);
    history.back();
    expect(nav.snapshot().entry.target).toEqual(settings);
    history.forward();
    expect(nav.snapshot().entry.target).toEqual(page);
  });
  it("disposes owned work and listeners and cannot reopen afterward", async () => {
    const { host, navigation: nav } = setup();
    const pending = nav.open(page),
      attempt = nav.snapshot().attempt;
    host.dispose();
    expect(attempt.signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    const listener = vi.fn();
    nav.subscribe(listener);
    await expect(nav.open(settings)).resolves.toEqual({ status: "cancelled" });
    nav.back();
    nav.forward();
    expect(listener).not.toHaveBeenCalled();
    expect(host.complete(attempt, { status: "opened" })).toBe(false);
  });
});

it("runs the attempt deadline only while a presenter is attached", async () => {
  vi.useFakeTimers();
  const { host, navigation: nav } = setup(100, false);
  // The startup visit exists before any presenter; its deadline is not running.
  const { attempt } = nav.snapshot();
  expect(nav.snapshot()).toMatchObject({ status: "opening", attempt });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nav.snapshot()).toMatchObject({ status: "opening", attempt });
  // The deadline starts when a presenter attaches and stops when the last leaves.
  const first = host.attach();
  await vi.advanceTimersByTimeAsync(14_999);
  const second = host.attach();
  first();
  await vi.advanceTimersByTimeAsync(1);
  // One presenter remains, so the running deadline stands.
  expect(nav.snapshot()).toMatchObject({
    status: "failed",
    reason: "timeout",
    attempt,
  });
  const pending = nav.retry();
  await vi.advanceTimersByTimeAsync(14_999);
  second();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nav.snapshot().status).toBe("opening");
  // A presenter attaching later is measured from its own start.
  cleanups.push(host.attach());
  await vi.advanceTimersByTimeAsync(14_999);
  expect(nav.snapshot().status).toBe("opening");
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual({
    status: "failed",
    reason: "timeout",
  });
});

it("default resolution preserves visit, promise, signal and deadline while revoking the old completion token", async () => {
  vi.useFakeTimers();
  const { host, navigation: nav } = setup();
  const pending = nav.open(page);
  const old = nav.snapshot().attempt;
  await vi.advanceTimersByTimeAsync(14_000);
  expect(host.resolve(old, settings)).toBe(true);
  const current = nav.snapshot().attempt;
  expect(current.entry.id).toBe(old.entry.id);
  expect(current.signal).toBe(old.signal);
  expect(old.signal.aborted).toBe(false);
  expect(current.entry.target).toEqual(settings);
  expect(host.complete(old, { status: "opened" })).toBe(false);
  expect(host.resolve(old, page)).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(pending).resolves.toEqual({
    status: "failed",
    reason: "timeout",
  });
  expect(host.resolve(current, page)).toBe(false);
});

it("resolved presentation settles the original caller and cannot outlive new intent or cancellation", async () => {
  const { host, navigation: nav } = setup();
  const first = nav.open(page);
  host.resolve(nav.snapshot().attempt, settings);
  host.complete(nav.snapshot().attempt, { status: "opened" });
  await expect(first).resolves.toEqual({ status: "opened" });
  const second = nav.open(page);
  host.resolve(nav.snapshot().attempt, settings);
  const retired = nav.snapshot().attempt;
  const next = nav.open(homeTarget);
  await expect(second).resolves.toEqual({ status: "superseded" });
  expect(retired.signal.aborted).toBe(true);
  expect(host.resolve(retired, page)).toBe(false);
  expect(host.complete(retired, { status: "opened" })).toBe(false);
  const cancelled = nav.snapshot().attempt;
  host.cancel();
  await expect(next).resolves.toEqual({ status: "cancelled" });
  expect(host.resolve(cancelled, page)).toBe(false);
});

it("resolution observers may introduce real competing intent without capturing the original promise", async () => {
  const { host, navigation: nav } = setup();
  const first = nav.open(page);
  let next: ReturnType<typeof nav.open> | undefined;
  const off = nav.subscribe(() => {
    if (nav.snapshot().entry.target.kind === "settings")
      next = nav.open(homeTarget);
  });
  host.resolve(nav.snapshot().attempt, settings);
  expect(nav.snapshot().entry.target).toEqual(homeTarget);
  host.complete(nav.snapshot().attempt, { status: "opened" });
  await expect(first).resolves.toEqual({ status: "superseded" });
  await expect(next).resolves.toEqual({ status: "opened" });
  off();
});

it("guards driver traversal before aborting the current presentation", () => {
  const { host, navigation: nav } = setup();
  void nav.open(page);
  void nav.open(settings);
  const original = nav.snapshot().attempt;
  let decide: ((proceed: boolean) => void) | undefined;
  host.guardDeparture((_next, decision) => {
    decide = decision;
    return true;
  });
  nav.back();
  expect(nav.snapshot().attempt).toBe(original);
  expect(original.signal.aborted).toBe(false);
  decide?.(false);
  expect(nav.snapshot().entry.target).toEqual(settings);
  nav.back();
  decide?.(true);
  expect(nav.snapshot().entry.target).toEqual(page);
  expect(original.signal.aborted).toBe(true);
  nav.forward();
  expect(nav.snapshot().entry.target).toEqual(page);
  decide?.(true);
  expect(nav.snapshot().entry.target).toEqual(settings);
});

it("settles guarded open callers only after the user's decision and destination completion", async () => {
  const { host, navigation: nav } = setup();
  void nav.open(settings);
  host.complete(nav.snapshot().attempt, { status: "opened" });
  let decide: ((proceed: boolean) => void) | undefined;
  host.guardDeparture((_next, decision) => {
    decide = decision;
    return true;
  });
  const retained = nav.snapshot().retainedVisits;
  const cancelled = nav.open(page);
  decide?.(false);
  expect(await cancelled).toEqual({ status: "cancelled" });
  expect(nav.snapshot().retainedVisits).toEqual(retained);
  expect(nav.snapshot().canGoForward).toBe(false);
  const opened = nav.open(page);
  decide?.(true);
  host.complete(nav.snapshot().attempt, { status: "opened" });
  expect(await opened).toEqual({ status: "opened" });
});

it("continues Discard to the preceding eligible visit if its destination was dismissed", () => {
  const { host, navigation: nav } = setup();
  void nav.open(page);
  const closed = nav.snapshot().entry.id;
  void nav.open(settings);
  const original = nav.snapshot().attempt;
  let decide: ((proceed: boolean) => void) | undefined;
  const guard = vi.fn((_next, decision) => {
    decide = decision;
    return true;
  });
  host.guardDeparture(guard);
  nav.back();
  nav.dismiss([closed], homeTarget);
  decide?.(true);
  expect(nav.snapshot().entry.target).toEqual(homeTarget);
  expect(original.signal.aborted).toBe(true);
  expect(guard).toHaveBeenCalledTimes(1);
});

describe("reopening a visit refused for missing sign-in", () => {
  function signIn() {
    let reopen: (() => void) | undefined;
    const cancel = vi.fn();
    const reauthorize = vi.fn((next: () => void) => {
      reopen = next;
      return cancel;
    });
    return { reauthorize, cancel, signedIn: () => reopen?.() };
  }
  it("reopens the failed visit once after sign-in", async () => {
    const { host, navigation: nav } = setup();
    const opened = nav.open(page);
    const failed = nav.snapshot().attempt;
    const auth = signIn();
    host.complete(failed, {
      status: "failed",
      reason: "unavailable",
      reauthorize: auth.reauthorize,
    });
    await opened;
    expect(auth.reauthorize).toHaveBeenCalledOnce();
    const entry = nav.snapshot().entry;
    auth.signedIn();
    expect(nav.snapshot().entry).toBe(entry);
    expect(nav.snapshot().attempt).not.toBe(failed);
    expect(nav.snapshot().entry.target).toEqual(page);
  });
  it("does not reopen a failure that was not a sign-in refusal", async () => {
    const { host, navigation: nav } = setup();
    const opened = nav.open(page);
    const failed = nav.snapshot().attempt;
    host.complete(failed, { status: "failed", reason: "unavailable" });
    await opened;
    expect(nav.snapshot().attempt).toBe(failed);
  });
  it("cancels the reopen when the user navigates elsewhere before sign-in", async () => {
    const { host, navigation: nav } = setup();
    const opened = nav.open(page);
    const auth = signIn();
    host.complete(nav.snapshot().attempt, {
      status: "failed",
      reason: "unavailable",
      reauthorize: auth.reauthorize,
    });
    await opened;
    void nav.open(settings);
    expect(auth.cancel).toHaveBeenCalledOnce();
    const elsewhere = nav.snapshot().attempt;
    auth.signedIn();
    expect(nav.snapshot().attempt).toBe(elsewhere);
    expect(nav.snapshot().entry.target).toEqual(settings);
  });
});
