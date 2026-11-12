import { createHuddles } from "./service";
import type { HuddleUpdate, HuddleBridge } from "./bridge";
import type { OpenHuddleAudio } from "./audio";
import { assert, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import type { RelayData } from "../relay/service";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { matchesEvent } from "../relay/projection";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { createHuddleRequests, type HuddleRequest } from "./requests";
import { createHuddleDiscussion } from "./discussion";
import { huddleDescription } from "./lifecycle";

it("adds a room member, recovers the signed invitation after discovery, and keeps the original DM private", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const inviter = keypair(),
    guest = keypair(),
    authority = keypair();
  const parent = "00000000-0000-4000-8000-000000000001";
  const room = "00000000-0000-4000-8000-000000000002";
  let clock = Math.floor(Date.now() / 1000);
  let members = [inviter.pubkey];
  const notices: RelayEvent[] = [],
    writes: RelayEvent[] = [];
  const guestReads: (readonly ReadFilter[])[] = [];
  const live = new Map<string, LiveCallbacks>();
  const owner = (key: typeof inviter) =>
    createRelaySession(
      {
        viewer: key.pubkey,
        relayAuthor: authority.pubkey,
        media: () => undefined,
        subscribe(callbacks) {
          live.set(key.pubkey, callbacks);
          return { update() {}, prioritize() {}, retry() {}, dispose() {} };
        },
        writer: {
          kinds: [9000],
          sign: async (template) => signed(key, template),
          publish: async (event) => {
            expect(event.kind).toBe(9000);
            expect(event.tags).toContainEqual(["h", room]);
            expect(event.tags).toContainEqual(["p", guest.pubkey]);
            writes.push(event);
            members = [inviter.pubkey, guest.pubkey];
            clock++;
            notices.push(
              signed(authority, {
                kind: 44100,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                  ["h", room],
                  ["p", guest.pubkey],
                ],
                content: JSON.stringify({
                  type: "member_added",
                  channel_id: room,
                  actor: inviter.pubkey,
                }),
              }),
            );
          },
        },
        query: async (filters) => {
          if (key === guest) guestReads.push(filters);
          const events = [
            metadata(authority, parent, "Private DM", clock, [
              ["t", "dm"],
              ["private"],
            ]),
            roster(authority, parent, [inviter.pubkey], clock),
            metadata(authority, room, "Huddle", clock, [
              ["t", "stream"],
              ["private"],
              ["about", huddleDescription(parent)],
              ["P", inviter.pubkey],
              ["ttl", "3600"],
            ]),
            roster(authority, room, members, clock),
            signed(inviter, {
              kind: 9007,
              created_at: clock - 1,
              content: "",
              tags: [
                ["h", room],
                ["visibility", "private"],
                ["channel_type", "stream"],
                ["about", huddleDescription(parent)],
              ],
            }),
            ...notices,
          ];
          return events.filter((event) => {
            const id = event.tags.find(([tag]) => tag === "d")?.[1];
            if (id === parent && key === guest) return false;
            if (id === room && !members.includes(key.pubkey)) return false;
            // Match the relay's global storage: #h SQL queries cannot find 44100.
            return filters.some(
              (filter) =>
                !(event.kind === 44100 && filter["#h"]) &&
                // The replica has not replayed the new creation receipt yet.
                !(event.kind === 9007 && filter.consistency !== "strong") &&
                matchesEvent(event, filter),
            );
          });
        },
      },
      { outboxStorage: { load: () => [], save: () => {} } },
    );
  const sender = owner(inviter),
    recipient = owner(guest);
  const connection = {
    status: "ready" as const,
    generation: 1,
    viewer: guest.pubkey,
    scope: `https://example.test:${guest.pubkey}`,
    session: recipient.session,
  };
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  let request: HuddleRequest | undefined;
  const requests = createHuddleRequests(
    relay,
    () => true,
    (next) => {
      request = next;
    },
  );
  const audio = {
    close: vi.fn(),
    mute: vi.fn(),
    play: vi.fn(),
    participants: vi.fn(),
  };
  const openAudio = vi.fn<OpenHuddleAudio>(async () => audio);
  let receive = (_event: HuddleUpdate) => {};
  const bridge: HuddleBridge = {
    available: true,
    open: vi.fn(async (_id, _destination, _room, listener) => {
      receive = listener;
    }),
    close: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
  let calls: ReturnType<typeof createHuddles> | undefined;
  let discussion: ReturnType<typeof createHuddleDiscussion> | undefined;
  try {
    await sender.session.channels.resolve?.([parent, room]);
    await sender.session.memberAdditions.add(room, guest.pubkey);
    expect(writes).toHaveLength(1);
    // The live notification precedes room discovery and is filtered out of
    // content views. Its roster hint must lead to a successful finite recovery.
    live.get(guest.pubkey)?.receive(notices);
    await vi.waitFor(() => expect(request?.room).toBe(room));
    expect(request?.creator).toBe(inviter.pubkey);
    expect(recipient.session.channels.list().channels.map((c) => c.id)).toEqual(
      [room],
    );
    expect(
      guestReads.flat().some((filter) => filter["#h"]?.includes(parent)),
    ).toBe(false);
    calls = createHuddles(relay, bridge, openAudio);
    await vi.waitFor(() => expect(calls?.snapshot().phase).toBe("incoming"));
    const destination = calls.snapshot().destination;
    assert(destination);
    // An unrelated inactive failure must not suppress the pending invitation.
    await calls.start({ ...destination, scope: "stale" });
    expect(calls.snapshot().phase).toBe("incoming");
    openAudio.mockRejectedValueOnce(new Error("Unrelated microphone failure"));
    await calls.join({ ...destination, channelId: room });
    expect(calls.snapshot().phase).toBe("incoming");
    expect(calls.snapshot().error).toBeUndefined();
    openAudio.mockRejectedValueOnce(new Error("Microphone denied"));
    await calls.join(destination, room);
    await vi.waitFor(() => expect(calls?.snapshot().phase).toBe("incoming"));
    expect(calls.snapshot().error).toBe("Microphone denied");
    vi.mocked(bridge.open).mockRejectedValueOnce(new Error("Admission failed"));
    await calls.join(destination, room);
    await vi.waitFor(() => expect(calls?.snapshot().phase).toBe("incoming"));
    expect(calls.snapshot().error).toBe("Admission failed");
    await calls.join(destination, room);
    expect(calls.snapshot().error).toBeUndefined();
    receive({
      type: "connected",
      room,
      participants: [guest.pubkey, inviter.pubkey],
    });
    expect(calls.snapshot().phase).toBe("connected");
    await calls.leave();
    expect(calls.snapshot().phase).toBe("idle");
    // A new local owner sees the still-live remote room. Cancelling admission
    // must dismiss it even though bridge.close does not end the caller's room.
    await calls.dispose();
    calls = createHuddles(relay, bridge, openAudio);
    await vi.waitFor(() => expect(calls?.snapshot().phase).toBe("incoming"));
    await calls.join(destination, room);
    expect(calls.snapshot().phase).toBe("connecting");
    await calls.leave();
    expect(calls.snapshot().phase).toBe("idle");
    expect(recipient.session.channels.get?.(room)?.archived).not.toBe(true);
    await calls.dispose();
    calls = createHuddles(relay, bridge, openAudio);
    await vi.waitFor(() => expect(calls?.snapshot().phase).toBe("incoming"));
    let releaseAudio!: (value: typeof audio) => void;
    openAudio.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAudio = resolve;
        }),
    );
    const joining = calls.join(destination, room);
    await calls.leave();
    releaseAudio(audio);
    await joining;
    expect(calls.snapshot().phase).toBe("idle");
    for (const error of [
      "not a member",
      "huddle has ended",
      "channel is archived",
    ]) {
      await calls.dispose();
      calls = createHuddles(relay, bridge, openAudio);
      await vi.waitFor(() => expect(calls?.snapshot().phase).toBe("incoming"));
      await calls.join(destination, room);
      receive({ type: "ended", error });
      await vi.waitFor(() => expect(calls?.snapshot().phase).toBe("error"));
      expect(calls.canJoin(destination.scope, room)).toBe(false);
      // Re-discovery of the unchanged invitation must not restore Join.
      live.get(guest.pubkey)?.receive(notices);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(calls.snapshot().phase).toBe("error");
    }
    discussion = createHuddleDiscussion(
      recipient.session,
      room,
      parent,
      () => {},
    );
    await vi.waitFor(() => expect(discussion?.available()).toBe(true));
    expect(discussion.snapshot().writable).toBe(true);
    expect(sender.session.channels.get?.(parent)?.members).toEqual([
      inviter.pubkey,
    ]);
  } finally {
    await calls?.dispose();
    discussion?.dispose();
    requests.dispose();
    recipient.dispose();
    sender.dispose();
    now.mockRestore();
  }
});
