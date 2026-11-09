import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { eventDto } from "./events";
import { keypair, metadata, signed } from "./testing";
import { SOLO_LABEL } from "../solo/labels";

const relay = keypair(),
  viewer = keypair();
const id = "permissions";
const roster = (role: string, time: number) =>
  signed(relay, {
    kind: 39002,
    content: "",
    created_at: time,
    tags: [
      ["d", id],
      ["p", viewer.pubkey, "", role],
    ],
  });
const details = (role: string, time: number) =>
  metadata(relay, id, "Updates", time, [
    ["public"],
    ["t", "stream"],
    ["join_role", role],
  ]);

it("keeps public Solo visitors read-only without membership and revokes their access when made private", () => {
  const owner = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  const chat = (visibility: "public" | "private", time: number) =>
    metadata(relay, id, "Planning", time, [
      [visibility],
      ["t", "stream"],
      ["t", SOLO_LABEL],
      ["P", owner.pubkey],
      ["join_role", "guest"],
    ]);
  state.accept(chat("private", 1));
  expect(state.get(id)).toBeUndefined();
  state.accept(chat("public", 2));
  expect(state.get(id)).toMatchObject({
    channelType: "solo",
    readOnly: true,
    joinRole: "guest",
    creator: owner.pubkey,
  });
  expect(state.canAccess(id)).toBe(true);
  expect(state.canWrite(id)).toBe(false);
  expect(state.canParticipate(id)).toBe(false);
  expect(state.channels()).toEqual([]);
  state.accept(chat("private", 3));
  expect(state.canAccess(id)).toBe(false);
  expect(state.get(id)).toBeUndefined();
  state.accept(chat("public", 2));
  expect(state.canAccess(id)).toBe(false);
});

it("keeps a guest joined and readable across admission-default changes until explicitly promoted", () => {
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(details("guest", 10));
  state.accept(roster("guest", 10));
  expect(state.channels()).toHaveLength(1);
  expect(state.get(id)).toMatchObject({
    viewerRole: "guest",
    joinRole: "guest",
    readOnly: true,
  });
  expect(state.canAccess(id)).toBe(true);
  expect(state.canParticipate(id)).toBe(true);
  expect(state.canWrite(id)).toBe(false);
  expect(state.suspend(id)).toBe(false);
  state.accept(details("member", 20));
  expect(state.get(id)).toMatchObject({
    viewerRole: "guest",
    joinRole: "member",
    readOnly: true,
  });
  expect(state.canWrite(id)).toBe(false);
  state.accept(roster("member", 20));
  expect(state.get(id)?.readOnly).toBeUndefined();
  expect(state.canWrite(id)).toBe(true);
  state.accept(roster("guest", 30));
  expect(state.canWrite(id)).toBe(false);
  state.accept(roster("member", 20));
  expect(state.canWrite(id)).toBe(false);
});

it.each(["owner", "admin", "member", "bot"])(
  "preserves an existing %s's writing access when the default becomes guest",
  (role) => {
    const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
    state.accept(details("member", 10));
    state.accept(roster(role, 10));
    state.accept(details("guest", 20));
    expect(state.get(id)).toMatchObject({
      viewerRole: role,
      joinRole: "guest",
    });
    expect(state.get(id)?.readOnly).toBeUndefined();
    expect(state.canWrite(id)).toBe(true);
  },
);

it("does not turn a public nonmember or cached guest into a writer", () => {
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(details("member", 10));
  expect(state.canWrite(id)).toBe(false);
  state.accept(roster("guest", 10), true);
  expect(state.canWrite(id)).toBe(false);
  expect(state.get(id)).toMatchObject({
    cached: true,
    readOnly: true,
    viewerRole: "guest",
  });
  state.accept(roster("guest", 10));
  expect(state.get(id)?.cached).toBeUndefined();
  expect(state.canWrite(id)).toBe(false);
});

it.each(["guest", "member"])(
  "restores only public reading after a %s leaves, requiring fresh metadata without restoring membership",
  (role) => {
    const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
    const publicMetadata = details("guest", 10);
    const membership = roster(role, 10);
    state.accept(publicMetadata);
    state.accept(membership);
    state.deny(id);
    expect(state.canAccess(id)).toBe(false);
    const fresh = eventDto(publicMetadata);
    expect(fresh).not.toBe(publicMetadata);
    expect(fresh.id).toBe(publicMetadata.id);
    state.resume(id, fresh);
    expect(state.canAccess(id)).toBe(true);
    expect(state.canParticipate(id)).toBe(false);
    expect(state.canWrite(id)).toBe(false);
    state.accept(membership); // Replaying the retained roster is not a promotion.
    expect(state.canParticipate(id)).toBe(false);
    state.accept(
      metadata(relay, id, "Private", 20, [["private"], ["t", "stream"]]),
    );
    expect(state.canAccess(id)).toBe(false);
    state.resume(id, publicMetadata); // An older public snapshot cannot reopen it.
    expect(state.canAccess(id)).toBe(false);
    state.resume(
      id,
      metadata(viewer, id, "Forged", 30, [["public"], ["t", "stream"]]),
    );
    expect(state.canAccess(id)).toBe(false);
    const reopened = details("guest", 30);
    state.accept(reopened);
    state.resume(id, reopened);
    expect(state.canAccess(id)).toBe(true);
    expect(state.canParticipate(id)).toBe(false);
    state.deny(id);
    expect(state.canAccess(id)).toBe(false);
    state.resume(id, reopened);
    state.denyAll();
    expect(state.canAccess(id)).toBe(false);
    state.accept(roster("member", 40));
    expect(state.canWrite(id)).toBe(true);
  },
);

it("does not grant writing through a contradictory duplicate guest entry", () => {
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(details("member", 10));
  state.accept(
    signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", id],
        ["p", viewer.pubkey, "", "member"],
        ["p", viewer.pubkey, "", "guest"],
      ],
    }),
  );
  expect(state.get(id)).toMatchObject({ viewerRole: "guest", readOnly: true });
  expect(state.canWrite(id)).toBe(false);
});

it("reads a roster once across gets and afresh when it is replaced", () => {
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(details("member", 10));
  state.accept(roster("member", 10));
  const members = state.get(id)?.members;
  expect(members).toEqual([viewer.pubkey]);
  expect(state.get(id)?.members).toBe(members);
  const other = keypair().pubkey;
  state.accept(
    signed(relay, {
      kind: 39002,
      content: "",
      created_at: 20,
      tags: [
        ["d", id],
        ["p", viewer.pubkey, "", "admin"],
        ["p", other, "", "member"],
      ],
    }),
  );
  expect(state.get(id)).toMatchObject({
    members: [viewer.pubkey, other].sort(),
    viewerRole: "admin",
  });
});

it("lists roster owners from the signed role hints", () => {
  const owner = keypair(),
    admin = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(details("member", 10));
  state.accept(
    signed(relay, {
      kind: 39002,
      content: "",
      created_at: 10,
      tags: [
        ["d", id],
        ["p", owner.pubkey, "", "owner"],
        ["p", admin.pubkey, "", "admin"],
        ["p", "not-a-key", "", "owner"],
        ["p", viewer.pubkey, "", "owner"],
      ],
    }),
  );
  expect(state.get(id)?.owners).toEqual([owner.pubkey, viewer.pubkey].sort());
});
