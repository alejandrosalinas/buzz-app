import { afterEach, expect, it, vi } from "vitest";
import { createHuddleRequests, type HuddleRequest } from "./requests";
import { recentHuddles } from "./discovery";
import { createRelaySession } from "../relay/session";
import type { RelaySnapshot, RelayData } from "../relay/service";
import type { ChannelSummary } from "../relay/contracts";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { keypair, signed } from "../relay/testing";

const authority = keypair();
const self = keypair(),
  peer = keypair();
const dm = "00000000-0000-4000-8000-000000000001";
const room = "00000000-0000-4000-8000-000000000002";
const stream = "00000000-0000-4000-8000-000000000003";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.useRealTimers();
});
function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T15:00:00Z"));
  const store = createRelaySession(null);
  let events: RelayEvent[] = [];
  let allowed = true;
  let status: "ready" | "error" = "ready";
  const listeners = new Set<() => void>(),
    listListeners = new Set<() => void>(),
    connectionListeners = new Set<() => void>();
  const channel = {
    id: dm,
    name: "Private conversation",
    channelType: "dm" as const,
    members: [self.pubkey, peer.pubkey],
  };
  let channels: ChannelSummary[] = [
    channel,
    { ...channel, id: stream, channelType: "stream" as const },
  ];
  const views = new Set<object>();
  const resolve = vi.fn(async () => {});
  const session = {
    ...store.session,
    viewer: self.pubkey,
    relayAuthor: authority.pubkey,
    channels: {
      ...store.session.channels,
      resolve,
      list: () => ({ status: "ready" as const, channels }),
      subscribeList: (fn: () => void) => {
        listListeners.add(fn);
        return () => {
          listListeners.delete(fn);
        };
      },
    },
    observe: (filters: readonly ReadFilter[]) => {
      const view = {
        snapshot: () => ({
          status,
          events: events.filter((e) =>
            filters.some(
              (f) =>
                f.kinds?.includes(e.kind) &&
                (e.kind === 44100
                  ? !f["#h"]
                  : e.tags.some(
                      (t) => t[0] === "h" && f["#h"]?.includes(t[1] ?? ""),
                    )) &&
                e.created_at >= (f.since ?? 0),
            ),
          ),
        }),
        refresh: async () => {},
        subscribe: (fn: () => void) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        dispose: () => {
          views.delete(view);
        },
      };
      views.add(view);
      return view;
    },
  };
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: `https://example.test:${self.pubkey}`,
    viewer: self.pubkey,
    session,
  };
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe: (fn) => {
      connectionListeners.add(fn);
      return () => {
        connectionListeners.delete(fn);
      };
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  let latest: HuddleRequest | undefined;
  const requests = createHuddleRequests(
    relay,
    () => allowed,
    (r) => {
      latest = r;
    },
  );
  const publish = (...next: RelayEvent[]) => {
    events = [...events, ...next];
    for (const fn of listeners) fn();
  };
  cleanup.push(
    () => store.dispose(),
    () => requests.dispose(),
  );
  return {
    resolve,
    requests,
    publish,
    get: () => latest,
    busy: () => {
      allowed = false;
      requests.refresh();
    },
    idle: () => {
      allowed = true;
      requests.refresh();
    },
    rooms: (next: ChannelSummary[]) => {
      channels = next;
      for (const fn of listListeners) fn();
    },
    revoke: () => {
      channels = [];
      for (const fn of listListeners) fn();
    },
    replace: () => {
      connection = { ...connection, status: "disconnected" };
      for (const fn of connectionListeners) fn();
    },
    failRead: () => {
      status = "error";
      for (const fn of listeners) fn();
    },
    views,
    listeners,
  };
}
function event(
  kind: number,
  parent = dm,
  author = peer,
  time = Math.floor(Date.now() / 1000),
  id = room,
) {
  return signed(author, {
    kind,
    created_at: time,
    tags: [["h", parent]],
    content: JSON.stringify({ ephemeral_channel_id: id }),
  });
}
it("only requests new DMs started by another member and dismisses each room locally", () => {
  const h = harness();
  h.publish(
    event(48100, stream),
    event(48100, dm, self),
    event(48100, dm, peer, Math.floor(Date.now() / 1000) - 10),
  );
  expect(h.get()).toBeUndefined();
  // A distinct room avoids a valid earlier self-authored announcement owning its identity.
  const id = "00000000-0000-4000-8000-000000000004";
  h.publish(event(48100, dm, peer, undefined, id));
  expect(h.get()).toMatchObject({
    room: id,
    creator: peer.pubkey,
    destination: { channelId: dm },
  });
  h.requests.dismiss(id);
  expect(h.get()).toBeUndefined();
  h.requests.refresh();
  expect(h.get()).toBeUndefined();
});
it("does not interrupt calls and retires ended or inaccessible requests", () => {
  const h = harness();
  h.busy();
  h.publish(event(48100));
  expect(h.get()).toBeUndefined();
  h.idle();
  expect(h.get()?.room).toBe(room);
  h.publish(event(48103, dm, keypair()));
  expect(h.get()?.room).toBe(room);
  h.publish(event(48103));
  expect(h.get()).toBeUndefined();
  h.publish(
    event(48100, dm, peer, undefined, "00000000-0000-4000-8000-000000000004"),
  );
  expect(h.get()).toBeDefined();
  h.revoke();
  expect(h.get()).toBeUndefined();
  expect(h.views.size).toBe(1);
});
it("expires requests and disposes observers on connection replacement", () => {
  const h = harness();
  const start = event(48100);
  h.publish(start);
  expect(h.get()).toBeDefined();
  vi.advanceTimersByTime(59_999);
  expect(h.get()?.room).toBe(room);
  vi.advanceTimersByTime(1);
  expect(h.get()).toBeUndefined();
  // Expiring an abandoned call prompt does not end or hide its joinable room.
  expect(recentHuddles([start], dm, authority.pubkey)[0]?.id).toBe(room);
  h.requests.refresh();
  expect(h.get()).toBeUndefined();
  h.replace();
  expect(h.views.size).toBe(0);
  expect(h.listeners.size).toBe(0);
});

it("continues receiving verified live requests after the initial finite read fails", () => {
  const h = harness();
  h.failRead();
  expect(h.get()).toBeUndefined();
  h.publish(event(48100));
  expect(h.get()?.room).toBe(room);
  h.publish(event(48103));
  expect(h.get()).toBeUndefined();
});

const invitedRoom: ChannelSummary = {
  id: room,
  name: "Huddle",
  channelType: "stream",
  visibility: "private",
  huddle: true,
  parentChannelId: dm,
  members: [self.pubkey, peer.pubkey],
};
function invitation(
  author = authority,
  actor = peer.pubkey,
  target = self.pubkey,
  time = Math.floor(Date.now() / 1000),
) {
  return signed(author, {
    kind: 44100,
    created_at: time,
    tags: [
      ["h", room],
      ["p", target],
    ],
    content: JSON.stringify({ type: "member_added", channel_id: room, actor }),
  });
}
it("offers a room invitation without reading or joining the original DM and revokes it with room access", () => {
  const h = harness();
  h.rooms([invitedRoom]);
  h.publish(invitation());
  expect(h.get()).toMatchObject({
    room,
    creator: peer.pubkey,
    destination: { channelId: dm, channelName: "Huddle" },
  });
  h.rooms([{ ...invitedRoom, archived: true }]);
  expect(h.get()).toBeUndefined();
});
it("never treats untrusted notices, self-adds, old notices, or ordinary channels as invitations", () => {
  const h = harness();
  h.rooms([invitedRoom]);
  h.publish(
    invitation(peer),
    invitation(authority, self.pubkey),
    invitation(authority, peer.pubkey, peer.pubkey),
    invitation(
      authority,
      peer.pubkey,
      self.pubkey,
      Math.floor(Date.now() / 1000) - 1,
    ),
  );
  expect(h.get()).toBeUndefined();
  h.rooms([
    { id: room, name: "Ordinary channel", members: [self.pubkey, peer.pubkey] },
  ]);
  h.publish(invitation());
  expect(h.get()).toBeUndefined();
});
it("waits for current membership and metadata, dismisses locally, and never resurrects a declined invite", () => {
  const h = harness();
  h.rooms([]);
  h.publish(invitation());
  expect(h.get()).toBeUndefined();
  h.rooms([invitedRoom]);
  expect(h.get()?.room).toBe(room);
  h.requests.dismiss(room);
  expect(h.get()).toBeUndefined();
  h.rooms([invitedRoom]);
  expect(h.get()).toBeUndefined();
});

it("retires an invitation when the parent end arrives even before archive discovery", () => {
  const h = harness();
  h.rooms([
    {
      id: dm,
      name: "DM",
      channelType: "dm",
      members: [self.pubkey, peer.pubkey],
    },
    invitedRoom,
  ]);
  h.publish(event(48100), invitation());
  expect(h.get()?.room).toBe(room);
  h.publish(event(48103, dm, authority));
  expect(h.get()).toBeUndefined();
});
it("bounds an outsider invitation when only the private parent receives the end", () => {
  const h = harness();
  h.rooms([invitedRoom]);
  h.publish(invitation());
  expect(h.get()?.room).toBe(room);
  vi.advanceTimersByTime(59_999);
  expect(h.get()?.room).toBe(room);
  vi.advanceTimersByTime(1);
  expect(h.get()).toBeUndefined();
  h.requests.refresh();
  expect(h.get()).toBeUndefined();
});

it("recovers an invitation with no classified lifecycle destinations", async () => {
  const h = harness();
  h.rooms([{ id: room, name: room, members: [self.pubkey] }]);
  h.resolve.mockImplementation(async () => {
    h.rooms([invitedRoom]);
  });
  h.publish(invitation());
  await Promise.resolve();
  expect(h.resolve).toHaveBeenCalledWith(
    [room],
    expect.objectContaining({ consistency: "strong" }),
  );
  expect(h.get()?.room).toBe(room);
  expect(h.resolve).toHaveBeenCalledTimes(1);
});

it("rings a slightly future-dated start when the recipient clock catches up", () => {
  const h = harness();
  const start = event(48100);
  h.publish(signed(peer, { ...start, created_at: start.created_at + 2 }));
  expect(h.get()).toBeUndefined();
  vi.advanceTimersByTime(2000);
  expect(h.get()?.room).toBe(room);
});

it("retries transient invitation metadata failures without another relay event", async () => {
  const h = harness();
  h.rooms([]);
  h.resolve.mockRejectedValueOnce(new Error("offline"));
  h.resolve.mockImplementationOnce(async () => {
    h.rooms([invitedRoom]);
  });
  h.publish(invitation());
  await vi.advanceTimersByTimeAsync(999);
  expect(h.resolve).toHaveBeenCalledTimes(1);
  expect(h.get()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.resolve).toHaveBeenCalledTimes(2);
  expect(h.get()?.room).toBe(room);
  h.requests.refresh();
  expect(h.resolve).toHaveBeenCalledTimes(2);
});

it("bounds failed recovery attempts even with repeated refreshes", async () => {
  const h = harness();
  h.rooms([]);
  h.resolve.mockRejectedValue(new Error("offline"));
  h.publish(invitation());
  await vi.advanceTimersByTimeAsync(2999);
  expect(h.resolve).toHaveBeenCalledTimes(2);
  h.requests.refresh();
  expect(h.resolve).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.resolve).toHaveBeenCalledTimes(3);
  h.requests.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.resolve).toHaveBeenCalledTimes(3);
});

it.each(["dispose", "replace", "expire"])(
  "does not retry after %s",
  async (end) => {
    const h = harness();
    h.rooms([]);
    let reject!: (reason: Error) => void;
    h.resolve.mockImplementation(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    h.publish(invitation());
    if (end === "dispose") h.requests.dispose();
    if (end === "replace") h.replace();
    if (end === "expire") await vi.advanceTimersByTimeAsync(60_000);
    reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.get()).toBeUndefined();
  },
);
