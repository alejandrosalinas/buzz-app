import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { NAVIGATION_ABORTED } from "./controller";
import { provideNavigation, type PresentationOwner } from "./service";
import { provideRelay } from "../relay/service";
const target = {
  version: 1,
  kind: "page",
  pluginId: "test.page",
  pageId: "pending",
} as const;
const settings = {
  version: 1,
  kind: "settings",
  section: "appearance",
} as const;
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
});
function setup(retain = false) {
  vi.useFakeTimers();
  const ctx = new Context();
  contexts.push(ctx);
  const host = provideNavigation(ctx);
  // The visit deadline runs only while a presenter is attached, as the app's is.
  host.attach();
  let live = true;
  const listeners = new Set<() => void>();
  const owner: PresentationOwner = {
    valid: () => live,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const promise = host.navigation.open(target);
  const attempt = host.navigation.snapshot().attempt;
  const presentation = host.request(attempt, owner, retain);
  return {
    ctx,
    host,
    promise,
    attempt,
    presentation,
    owner,
    listeners,
    change(next: boolean, notify = true) {
      live = next;
      if (notify) for (const fn of listeners) fn();
    },
  };
}
it.each(["complete", "resolve"] as const)(
  "revalidates owner at %s even before subscription notification",
  async (operation) => {
    const t = setup();
    t.change(false, false);
    const request = t.presentation.request;
    expect(
      operation === "complete"
        ? request.complete({ status: "opened" })
        : request.resolve(settings),
    ).toBe(false);
    expect(request.signal.aborted).toBe(true);
    // The visit is still live, so revocation falls back to the shared reason.
    expect(request.signal.reason).toBe(NAVIGATION_ABORTED);
    t.change(true);
    expect(request.complete({ status: "opened" })).toBe(false);
    expect(request.resolve(settings)).toBe(false);
    expect(t.attempt.signal.aborted).toBe(false);
    expect(
      t.host.request(t.attempt, t.owner).request.complete({ status: "opened" }),
    ).toBe(true);
    expect(await t.promise).toEqual({ status: "opened" });
  },
);
it("revocation is synchronous, irreversible through ABA, and preserves the original deadline", async () => {
  const t = setup();
  await vi.advanceTimersByTimeAsync(10_000);
  t.change(false);
  expect(t.presentation.request.signal.aborted).toBe(true);
  expect(t.listeners.size).toBe(0);
  t.change(true);
  const next = t.host.request(t.attempt, t.owner).request;
  expect(next.entryId).toBe(t.presentation.request.entryId);
  expect(next.signal.aborted).toBe(false);
  expect(t.host.navigation.snapshot().attempt).toBe(t.attempt);
  expect(t.presentation.request.resolve(settings)).toBe(false);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(t.host.navigation.snapshot().status).toBe("opening");
  await vi.advanceTimersByTimeAsync(1);
  expect(await t.promise).toEqual({ status: "failed", reason: "timeout" });
  expect(next.signal.aborted).toBe(true);
  // Revocation forwards the visit's shared reason rather than minting its own.
  expect(next.signal.reason).toBe(t.attempt.signal.reason);
  expect(next.complete({ status: "opened" })).toBe(false);
});
it("session replacement revokes only bound authority, not static pages or the visit", async () => {
  const t = setup();
  const relay = provideRelay(t.ctx);
  const parent = t.presentation.request;
  const old = relay.snapshot();
  const bound = parent.forSession(relay, old);
  expect(parent.forSession(relay, old)).toBe(bound);
  relay.disconnect();
  expect(bound.signal.aborted).toBe(true);
  expect(bound.complete({ status: "opened" })).toBe(false);
  expect(bound.resolve(settings)).toBe(false);
  expect(parent.signal.aborted).toBe(false);
  expect(t.attempt.signal.aborted).toBe(false);
  const current = parent.forSession(relay, relay.snapshot());
  expect(current.signal.aborted).toBe(false);
  expect(current.entryId).toBe(parent.entryId);
  expect(current.complete({ status: "opened" })).toBe(true);
  expect(await t.promise).toEqual({ status: "opened" });
});
it("normalization revokes the old presentation but not its caller, and disposal removes observers", async () => {
  const t = setup();
  const relay = provideRelay(t.ctx);
  const bound = t.presentation.request.forSession(relay, relay.snapshot());
  expect(bound.resolve(settings)).toBe(true);
  expect(bound.signal.aborted).toBe(true);
  expect(t.presentation.request.signal.aborted).toBe(true);
  expect(t.attempt.signal.aborted).toBe(false);
  const next = t.host.request(t.host.navigation.snapshot().attempt, t.owner);
  expect(next.request.complete({ status: "opened" })).toBe(true);
  expect(await t.promise).toEqual({ status: "opened" });
  expect(t.listeners.size).toBe(1);
  next.dispose();
  expect(t.listeners.size).toBe(0);
  expect(next.request.signal.aborted).toBe(true);
});

it("preserves opening focus through session binding, resolution and retry, not later openings or history", async () => {
  const t = setup();
  const nav = t.host.navigation;
  void nav.open(target, { focus: "preserve" });
  const relay = provideRelay(t.ctx);
  const request = () => t.host.request(nav.snapshot().attempt, t.owner).request;
  const bound = request().forSession(relay, relay.snapshot());
  expect(bound.focus).toBe("preserve");
  expect(bound.resolve(settings)).toBe(true);
  expect(request().focus).toBe("preserve");
  const retry = nav.retry();
  expect(request().forSession(relay, relay.snapshot()).focus).toBe("preserve");
  expect(request().complete({ status: "opened" })).toBe(true);
  await expect(retry).resolves.toEqual({ status: "opened" });
  // Explicit New conversation can open the same target but requests content focus.
  const explicit = nav.open(settings);
  expect(request().focus).toBe("content");
  expect(request().complete({ status: "opened" })).toBe(true);
  await expect(explicit).resolves.toEqual({ status: "opened" });
  void nav.open(target, { focus: "preserve" });
  expect(request().focus).toBe("preserve");
  nav.back();
  expect(request().focus).toBe("content");
  nav.forward();
  expect(request().focus).toBe("content");
});

it("exposes Back/Forward through session binding, not openings or retry, and keeps each visit's positions", async () => {
  const t = setup();
  const nav = t.host.navigation;
  const relay = provideRelay(t.ctx);
  const request = () => t.host.request(nav.snapshot().attempt, t.owner).request;
  const first = t.presentation.request.forSession(relay, relay.snapshot());
  expect(first.traversal).toBeUndefined();
  expect(first.complete({ status: "opened" })).toBe(true);
  await t.promise;
  void nav.open(settings);
  // Leaving revokes the visit's presentation, which can still record its place.
  expect(first.signal.aborted).toBe(true);
  first.savePosition("thread", { top: 1 });
  const other = request();
  expect(other.traversal).toBeUndefined();
  expect(other.position("thread")).toBeUndefined();
  other.savePosition("thread", { top: 2 });
  nav.back();
  const returned = request().forSession(relay, relay.snapshot());
  expect(returned.entryId).toBe(first.entryId);
  expect(returned.traversal).toBe(true);
  expect(returned.position("thread")).toEqual({ top: 1 });
  expect(returned.position("timeline")).toBeUndefined();
  void nav.retry();
  expect(
    request().forSession(relay, relay.snapshot()).traversal,
  ).toBeUndefined();
  void nav.open(target);
  expect(request().traversal).toBeUndefined();
});

it("returning to a retained connection mints fresh authority without reviving its old request", async () => {
  const t = setup();
  const source = provideRelay(t.ctx);
  const first = source.snapshot();
  source.disconnect();
  const second = source.snapshot();
  let selected = first;
  const listeners = new Set<() => void>();
  const relay = {
    ...source,
    snapshot: () => selected,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const parent = t.presentation.request;
  const old = parent.forSession(relay, first);
  selected = second;
  for (const fn of listeners) fn();
  expect(old.signal.aborted).toBe(true);
  selected = first;
  for (const fn of listeners) fn();
  const fresh = parent.forSession(relay, first);
  expect(fresh).not.toBe(old);
  expect(old.complete({ status: "opened" })).toBe(false);
  expect(fresh.complete({ status: "opened" })).toBe(true);
  expect(await t.promise).toEqual({ status: "opened" });
});

it("keeps a workspace alive under Settings without letting it complete or redirect Settings, then resumes its original visit", async () => {
  const t = setup(true);
  const relay = provideRelay(t.ctx);
  const bound = t.presentation.request.forSession(relay, relay.snapshot());
  expect(bound.complete({ status: "opened" })).toBe(true);
  await expect(t.promise).resolves.toEqual({ status: "opened" });
  const request = t.presentation.request;
  void t.host.navigation.open(settings);
  expect(t.attempt.signal.aborted).toBe(true);
  expect(request.signal.aborted).toBe(false);
  expect(bound.signal.aborted).toBe(false);
  expect(bound.complete({ status: "opened" })).toBe(false);
  expect(t.host.navigation.snapshot().status).toBe("opening");
  void t.host.navigation.open({ ...settings, section: "profile" });
  expect(t.host.returnTo(request.entryId)).toBe(true);
  const returned = t.host.navigation.snapshot().attempt;
  expect(returned.entry.id).toBe(request.entryId);
  expect(t.presentation.resume(returned)).toBe(true);
  expect(request.forSession(relay, relay.snapshot())).toBe(bound);
  expect(bound.focus).toBe("preserve");
  expect(t.host.navigation.snapshot().status).toBe("opened");
  expect(bound.complete({ status: "opened" })).toBe(false);
  void t.host.navigation.open({ ...target, pageId: "other" });
  expect(request.signal.aborted).toBe(true);
  expect(bound.signal.aborted).toBe(true);
});
it.each(["owner", "ingress"])(
  "revokes the retained workspace on %s failure even under Settings",
  (failure) => {
    const t = setup(true);
    void t.host.navigation.open(settings);
    if (failure === "owner") t.change(false);
    else t.host.fail("invalid-target");
    expect(t.presentation.request.signal.aborted).toBe(true);
    expect(t.presentation.resume(t.attempt)).toBe(false);
  },
);

it.each(["opened", "failed"] as const)(
  "replays a workspace's %s result completed behind Settings on resume, never into Settings",
  (status) => {
    const t = setup(true);
    const request = t.presentation.request;
    void t.host.navigation.open(settings);
    const result =
      status === "opened"
        ? { status }
        : { status, reason: "unavailable" as const };
    expect(request.complete(result)).toBe(false);
    expect(t.host.navigation.snapshot().status).toBe("opening");
    expect(t.host.returnTo(request.entryId)).toBe(true);
    expect(t.presentation.resume(t.host.navigation.snapshot().attempt)).toBe(
      true,
    );
    expect(t.host.navigation.snapshot().status).toBe(status);
  },
);
it("does not resume a retained workspace on an ordinary retry", () => {
  const t = setup(true);
  void t.host.navigation.retry();
  expect(t.presentation.request.signal.aborted).toBe(true);
  expect(t.presentation.resume(t.host.navigation.snapshot().attempt)).toBe(
    false,
  );
});

it("defers workspace normalization until Settings closes", () => {
  const t = setup(true);
  void t.host.navigation.open(settings);
  const destination = { ...target, route: { version: 1, params: "default" } };
  expect(t.presentation.request.resolve(destination)).toBe(false);
  expect(t.host.navigation.snapshot().entry.target).toEqual(settings);
  expect(t.host.returnTo(t.attempt.entry.id)).toBe(true);
  expect(t.presentation.resume(t.host.navigation.snapshot().attempt)).toBe(
    true,
  );
  expect(t.host.navigation.snapshot().entry.target).toEqual(destination);
  expect(t.host.navigation.snapshot().entry.id).toBe(t.attempt.entry.id);
});

it("keeps Settings alive under a join dialog over it, not under another Settings visit", () => {
  const t = setup();
  void t.host.navigation.open(settings);
  const shown = t.host.request(
    t.host.navigation.snapshot().attempt,
    t.owner,
    true,
  );
  const request = shown.request;
  expect(request.complete({ status: "opened" })).toBe(true);
  void t.host.navigation.open({
    ...settings,
    join: { viewer: "a".repeat(64), visit: "v1" },
  });
  expect(request.signal.aborted).toBe(false);
  // Settings beneath cannot acknowledge the dialog's visit.
  expect(request.complete({ status: "opened" })).toBe(false);
  t.host.navigation.back();
  void t.host.navigation.open({ ...settings, section: "profile" });
  expect(request.signal.aborted).toBe(true);
});
