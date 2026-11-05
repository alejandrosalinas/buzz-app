import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { ReadError } from "./errors";
import { keypair, profile } from "./testing";
import type { ReadFilter, RelayEvent } from "./events";

const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(options?: Parameters<typeof createRelaySession>[1]) {
  const viewer = keypair(),
    relay = keypair();
  const query = vi.fn(
    async (_filters: readonly ReadFilter[], _signal?: AbortSignal) =>
      [] as RelayEvent[],
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
    },
    options,
  );
  owners.push(owner);
  const filter = [{ kinds: [0], authors: [viewer.pubkey], limit: 1 }];
  return { owner, query, viewer, filter };
}

it("retries a finite public read without changing transport edge classification", async () => {
  const h = setup();
  h.query.mockRejectedValueOnce(new ReadError("unavailable", "edge", 403));
  const pending = h.owner.session.read(h.filter);
  await vi.advanceTimersByTimeAsync(749);
  expect(h.query).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual([]);
  expect(h.query).toHaveBeenCalledTimes(2);
});

it("retains observed data and coalesces refreshes during finite recovery", async () => {
  const h = setup();
  const row = profile(h.viewer, { name: "Kept" });
  h.query.mockResolvedValueOnce([row]);
  const view = h.owner.session.observe(h.filter);
  await view.refresh();
  h.query.mockRejectedValueOnce(new TypeError("offline"));
  const pending = view.refresh();
  await vi.advanceTimersByTimeAsync(0);
  await view.refresh();
  expect(h.query).toHaveBeenCalledTimes(2);
  expect(view.snapshot().status).toBe("loading");
  expect(view.snapshot().events.map((event) => event.id)).toContain(row.id);
  await vi.advanceTimersByTimeAsync(750);
  await pending;
  expect(view.snapshot().status).toBe("ready");
  expect(h.query).toHaveBeenCalledTimes(3);
  view.dispose();
});

it("leaves roster errors transient for their existing recovery owner", async () => {
  const h = setup();
  h.query.mockRejectedValue(new ReadError("unavailable", "offline", 503));
  h.owner.session.channels.refreshList?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.owner.session.live.snapshot().roster).toMatchObject({
    state: "error",
    transient: true,
  });
  expect(h.query).toHaveBeenCalledOnce();
});

/** The full roster scan: every roster naming the viewer, not a system or exact pass. */
const fullRoster = (filters: readonly ReadFilter[]) =>
  !!filters[0]?.kinds?.includes(39002) &&
  !!filters[0]["#p"] &&
  !filters[0]["#t"] &&
  !filters[0]["#d"];
it("lets a slow full roster page finish instead of retrying it forever", async () => {
  const h = setup();
  let respond!: (events: RelayEvent[]) => void;
  h.query.mockImplementation(async (filters) =>
    fullRoster(filters)
      ? new Promise<RelayEvent[]>((resolve) => {
          respond = resolve;
        })
      : [],
  );
  h.owner.session.channels.refreshList?.();
  // Past the ordinary ten-second read deadline: a large roster page is still
  // downloading, not stalled.
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.owner.session.live.snapshot().roster.state).not.toBe("error");
  respond([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
  expect(
    h.query.mock.calls.filter(([filters]) => fullRoster(filters)),
  ).toHaveLength(1);
});

it("still bounds a stalled full roster page", async () => {
  const h = setup();
  h.query.mockImplementation(async (filters, signal) =>
    fullRoster(filters)
      ? new Promise<RelayEvent[]>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        )
      : [],
  );
  h.owner.session.channels.refreshList?.();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(h.owner.session.live.snapshot().roster.state).not.toBe("error");
  await vi.advanceTimersByTimeAsync(1);
  expect(h.owner.session.live.snapshot().roster).toMatchObject({
    state: "error",
    transient: true,
  });
});

it.each(["caller", "clearCache", "dispose"] as const)(
  "%s cancels a finite public read's backoff",
  async (action) => {
    const h = setup();
    const caller = new AbortController();
    h.query.mockRejectedValue(new TypeError("offline"));
    const pending = h.owner.session.read(h.filter, { signal: caller.signal });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    const before = h.query.mock.calls.filter(([filters]) =>
      filters[0]?.kinds?.includes(0),
    ).length;
    if (action === "caller") caller.abort();
    else if (action === "clearCache") await h.owner.clearCache();
    else h.owner.dispose();
    await rejected;
    await vi.advanceTimersByTimeAsync(7000);
    expect(
      h.query.mock.calls.filter(([filters]) => filters[0]?.kinds?.includes(0)),
    ).toHaveLength(before);
  },
);

it("surfaces a cached-only inbox failure without retrying it", async () => {
  const h = setup({ cachedOnly: true });
  await h.owner.session.inboxFeed.ensure();
  expect(h.owner.session.inboxFeed.snapshot().status).toBe("error");
  expect(vi.getTimerCount()).toBe(0);
  expect(h.query).not.toHaveBeenCalled();
});

it("retries a transient inbox read through the session", async () => {
  const h = setup();
  h.query.mockRejectedValueOnce(new TypeError("offline"));
  const pending = h.owner.session.inboxFeed.ensure();
  await vi.advanceTimersByTimeAsync(750);
  await pending;
  expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready");
});
