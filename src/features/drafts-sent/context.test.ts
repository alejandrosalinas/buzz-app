import { expect, it } from "vitest";
import {
  activityOf,
  contextFilters,
  coverageFloor,
  deletionFilters,
  indexContext,
  retentionFloor,
} from "./context";
import { sentEntries, type ReadEvent } from "./model";

const viewer = "a".repeat(64);
const root = "b".repeat(64);
const id = "c".repeat(64);
const friend = "e".repeat(64);
const scout = "5".repeat(64);
const relay = "7".repeat(64);
const team = ["h", "team"];
const inThread = [team, ["e", root, "", "reply"]];
const event = (overrides: Partial<ReadEvent> = {}) =>
  ({
    id,
    pubkey: viewer,
    kind: 9,
    created_at: 1000,
    content: "Recently shipped",
    tags: [team],
    ...overrides,
  }) as ReadEvent;
const first = <T>(items: readonly T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error("expected an item");
  return item;
};

it("finds who's in each conversation and what others said after your message", () => {
  const other = (key: string, at: number, over: Partial<ReadEvent> = {}) =>
    event({ id: `${key}${at}`, pubkey: key, created_at: at, ...over });
  const p1 = "8".repeat(64);
  const sent = sentEntries(
    [
      event({ id: "t1", tags: inThread }),
      event({ id: p1, created_at: 900 }),
      event({ id: "r1", tags: [["h", "solo"]], created_at: 950 }),
    ],
    viewer,
  );
  const { threads, rooms } = contextFilters(
    sent,
    (channel) => channel === "solo",
  );
  expect(threads).toEqual([
    { kinds: [9, 40002, 40008], "#e": [p1, root].sort(), limit: 500 },
    { kinds: [9, 40002, 40008], ids: [root], limit: 1 },
  ]);
  expect(rooms).toEqual([
    [{ kinds: [9, 40002, 40008], "#h": ["solo"], since: 950, limit: 100 }],
  ]);
  const index = indexContext([
    other(friend, 500, { id: root, tags: [team] }),
    other(scout, 990, { tags: inThread }),
    other(friend, 1100, { tags: inThread }),
    other(scout, 1200, { tags: inThread }),
    other(scout, 960, { tags: [["h", "solo"]] }),
    other(friend, 905, { tags: [team, ["e", p1, "", "reply"]] }),
  ]);
  const byId = new Map(sent.map((entry) => [entry.id, entry]));
  const t1 = byId.get("t1");
  const r1 = byId.get("r1");
  const post = byId.get(p1);
  if (!t1 || !r1 || !post) throw new Error("expected sent entries");
  const thread = activityOf(t1, "thread", index, viewer);
  expect(thread.people).toEqual([scout, friend]);
  expect(thread.after.map((e) => e.created_at)).toEqual([1100, 1200]);
  const room = activityOf(r1, "room", index, viewer, [scout, "9".repeat(64)]);
  expect(room.people).toEqual([scout, "9".repeat(64)]);
  expect(room.after).toHaveLength(1);
  expect(activityOf(post, "post", index, viewer)).toMatchObject({
    people: [friend],
    replies: 1,
  });
  // Nothing after it: you're the last one.
  expect(
    activityOf(
      { ...t1, createdAt: 1300, createdAtMs: 1300000 },
      "thread",
      index,
      viewer,
    ).after,
  ).toEqual([]);
});

it("counts agent replies and patches, and leaves out replies their author deleted", () => {
  const mine = first(sentEntries([event({ tags: inThread })], viewer));
  const agentReply = event({
    id: "1".repeat(64),
    pubkey: scout,
    kind: 40002,
    created_at: 1100,
    tags: inThread,
  });
  const patch = event({
    id: "2".repeat(64),
    pubkey: scout,
    kind: 40008,
    created_at: 1200,
    tags: inThread,
  });
  const deleted = event({
    id: "3".repeat(64),
    pubkey: friend,
    created_at: 1300,
    tags: inThread,
  });
  const ownerDeleted = event({
    id: "4".repeat(64),
    pubkey: scout,
    kind: 40002,
    created_at: 1400,
    tags: inThread,
  });
  const kept = event({
    id: "6".repeat(64),
    pubkey: friend,
    created_at: 1500,
    tags: inThread,
  });
  const reaction = event({
    id: "7".repeat(64),
    pubkey: friend,
    kind: 7,
    created_at: 1600,
    tags: inThread,
  });
  const index = indexContext(
    [agentReply, patch, deleted, ownerDeleted, kept, reaction],
    [
      // The author's own deletion, and an agent owner's relay-checked one naming the kind.
      event({
        id: "8".repeat(64),
        pubkey: friend,
        kind: 5,
        created_at: 1700,
        tags: [team, ["e", deleted.id], ["k", "9"]],
      }),
      event({
        id: "9".repeat(64),
        pubkey: viewer,
        kind: 5,
        created_at: 1700,
        tags: [team, ["e", ownerDeleted.id], ["k", "40002"]],
      }),
      // Someone else can't delete it; neither can an unconfirmed send.
      event({
        id: "0".repeat(64),
        pubkey: scout,
        kind: 9005,
        created_at: 1700,
        tags: [team, ["e", kept.id]],
      }),
      event({
        id: "a".repeat(64),
        pubkey: friend,
        kind: 5,
        created_at: 1700,
        tags: [["e", kept.id]],
        delivery: "sending",
      }),
    ],
  );
  expect(
    activityOf(mine, "thread", index, viewer).after.map((e) => e.id),
  ).toEqual([agentReply.id, patch.id, kept.id]);
});

it("uses the author Buzz shows for relay-signed messages, and keeps the signer for deletions", () => {
  const mine = first(sentEntries([event({ tags: inThread })], viewer));
  const yours = event({
    id: "1".repeat(64),
    pubkey: relay,
    created_at: 1100,
    tags: [...inThread, ["actor", viewer]],
  });
  const scouts = event({
    id: "2".repeat(64),
    pubkey: relay,
    created_at: 1200,
    tags: [["p", scout], ...inThread],
  });
  const friends = event({
    id: "3".repeat(64),
    pubkey: relay,
    created_at: 1300,
    tags: [...inThread, ["actor", friend]],
  });
  const relays = event({
    id: "4".repeat(64),
    pubkey: relay,
    created_at: 1400,
    tags: inThread,
  });
  const index = indexContext(
    [yours, scouts, friends, relays],
    // Its displayed author removes it, as Buzz allows.
    [
      event({
        id: "6".repeat(64),
        pubkey: friend,
        kind: 5,
        created_at: 1500,
        tags: [["e", friends.id]],
      }),
    ],
    relay,
  );
  const activity = activityOf(mine, "thread", index, viewer);
  expect(activity.after.map((e) => [e.id, e.author, e.pubkey])).toEqual([
    [scouts.id, scout, relay],
    [relays.id, relay, relay],
  ]);
  expect(activity.people).toEqual([relay, scout]);
  // Without a known relay authority, the signer is the author.
  expect(
    activityOf(mine, "thread", indexContext([yours]), viewer).after.map(
      (e) => e.author,
    ),
  ).toEqual([relay]);
});

it("settles a conversation when the relay posts your answer in your name", () => {
  const mine = first(sentEntries([event({ tags: inThread })], viewer));
  const question = event({
    id: "1".repeat(64),
    pubkey: friend,
    created_at: 1100,
    tags: inThread,
  });
  const answer = event({
    id: "2".repeat(64),
    pubkey: relay,
    created_at: 1200,
    tags: [...inThread, ["actor", viewer]],
  });
  expect(
    activityOf(
      mine,
      "thread",
      indexContext([question, answer], [], relay),
      viewer,
    ).after,
  ).toEqual([]);
  const followUp = event({
    id: "3".repeat(64),
    pubkey: friend,
    created_at: 1300,
    tags: inThread,
  });
  expect(
    activityOf(
      mine,
      "thread",
      indexContext([question, answer, followUp], [], relay),
      viewer,
    ).after.map((e) => e.id),
  ).toEqual([followUp.id]);
  // A post keeps its reply count, but your answer in its thread settles it.
  const post = first(
    sentEntries([event({ id: root, created_at: 900 })], viewer),
  );
  expect(
    activityOf(
      post,
      "post",
      indexContext([question, answer], [], relay),
      viewer,
    ),
  ).toMatchObject({ after: [], replies: 2 });
});

it("treats a view near the host's retention caps as cut off at its oldest event", () => {
  const at = (created_at: number, content = "") =>
    event({ id: String(created_at).padStart(64, "0"), created_at, content });
  expect(retentionFloor([])).toBe(-Infinity);
  expect(retentionFloor([at(5), at(3)])).toBe(-Infinity);
  // Large agent replies: the host may have evicted older ones to stay under 8 MiB.
  const big = "x".repeat(2.5 * 1024 * 1024);
  expect(retentionFloor([at(9, big), at(7, big), at(6, big)])).toBe(6);
  // Or its 2,000-event cap.
  expect(
    retentionFloor(Array.from({ length: 2000 }, (_, i) => at(100 + i))),
  ).toBe(100);
});

it("reads deletions next to their targets, newest messages first, within a bound", () => {
  const ids = Array.from({ length: 1100 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const views = deletionFilters(ids);
  expect(views).toHaveLength(4);
  // The host refuses a read over 4 filters or 64 KB.
  for (const filters of views) {
    expect(filters.length).toBeLessThanOrEqual(4);
    expect(
      new TextEncoder().encode(JSON.stringify(filters)).byteLength,
    ).toBeLessThan(64 * 1024);
  }
  expect(first(first(views))).toEqual({
    kinds: [9, 40002, 40008],
    ids: ids.slice(0, 250),
    limit: 250,
  });
  expect(first(views)[1]).toEqual({
    kinds: [5, 9005],
    "#e": ids.slice(0, 250),
    limit: 500,
  });
  expect(views.flat().flatMap((filter) => filter.ids ?? [])).toEqual(
    ids.slice(0, 1000),
  );
  expect(deletionFilters([])).toEqual([]);
});

it("knows how far back a bounded read is complete", () => {
  const at = (created_at: number) =>
    event({ id: String(created_at), created_at });
  expect(coverageFloor([at(5), at(3)], 3)).toBe(-Infinity);
  expect(coverageFloor([at(5), at(3), at(9), at(1)], 3)).toBe(3);
});
