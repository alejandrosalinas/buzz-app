import { expect, it } from "vitest";
import { foldMessages } from "../../features/relay/fold";
import { keypair, message, signed } from "../../features/relay/testing";
import type { InboxReaction } from "../../features/relay/inbox-reactions";
import { reactionRows } from "./reaction-rows";

const alice = keypair(),
  bob = keypair(),
  viewer = keypair();
const target = message(viewer, "room", "My message", 1);
const folded = foldMessages("room", viewer.pubkey, [target])[0];
function item(spec: ["Alice" | "Bob", string][]): InboxReaction {
  if (!folded) throw new Error("Missing fixture message");
  return {
    id: `reaction:${target.id}`,
    channelId: "room",
    message: folded,
    createdAt: 100,
    events: spec
      .map(([person, content], index) =>
        signed(person === "Alice" ? alice : bob, {
          kind: 7,
          content,
          created_at: 10 + index,
          tags: [["e", target.id]],
        }),
      )
      .reverse(),
  };
}
const describeRows = (rows: InboxReaction[]) =>
  rows.map((row) => ({
    people: [
      ...new Set(
        row.events.map((event) =>
          event.pubkey === alice.pubkey ? "Alice" : "Bob",
        ),
      ),
    ],
    emoji: [...new Set(row.events.map((event) => event.content))],
  }));
it.each([
  {
    spec: [
      ["Alice", "❤️"],
      ["Alice", "👍"],
      ["Alice", "🎉"],
    ],
    expected: [{ people: ["Alice"], emoji: ["🎉", "👍", "❤️"] }],
  },
  {
    spec: [
      ["Alice", "❤️"],
      ["Bob", "❤️"],
    ],
    expected: [{ people: ["Bob", "Alice"], emoji: ["❤️"] }],
  },
  {
    spec: [
      ["Alice", "❤️"],
      ["Alice", "👍"],
      ["Bob", "❤️"],
    ],
    expected: [
      { people: ["Bob", "Alice"], emoji: ["❤️"] },
      { people: ["Alice"], emoji: ["👍"] },
    ],
  },
  {
    spec: [
      ["Alice", "❤️"],
      ["Bob", "👍"],
    ],
    expected: [
      { people: ["Bob"], emoji: ["👍"] },
      { people: ["Alice"], emoji: ["❤️"] },
    ],
  },
])("groups shared and solo emoji: $spec", ({ spec, expected }) => {
  expect(
    describeRows(reactionRows([item(spec as ["Alice" | "Bob", string][])])),
  ).toEqual(expected);
});
it("regroups after removal and filtering, preserving newest time and distinct people", () => {
  const source = item([
    ["Alice", "❤️"],
    ["Alice", "👍"],
    ["Bob", "❤️"],
    ["Bob", "❤️"],
  ]);
  expect(reactionRows([source]).map((row) => row.createdAt)).toEqual([13, 11]);
  const filtered = reactionRows([source], (id) => id === alice.pubkey);
  const removed = reactionRows([
    {
      ...source,
      events: source.events.filter((event) => event.pubkey !== bob.pubkey),
    },
  ]);
  expect(describeRows(filtered)).toEqual([
    { people: ["Alice"], emoji: ["👍", "❤️"] },
  ]);
  expect(removed).toEqual(filtered);
  expect(filtered[0]?.createdAt).toBe(11);
  expect(reactionRows([{ ...source, events: [] }])).toEqual([]);
});
it("keeps custom emoji with different URLs separate", () => {
  const source = item([
    ["Alice", ":done:"],
    ["Bob", ":done:"],
  ]);
  const events = source.events.map((event, index) => ({
    ...event,
    tags: [
      ...event.tags,
      ["emoji", "done", `https://example.com/${index}.png`],
    ],
  }));
  expect(reactionRows([{ ...source, events }])).toHaveLength(2);
  const shared = events.map((event) => ({
    ...event,
    tags: [["emoji", "done", "https://example.com/shared.png"]],
  }));
  expect(reactionRows([{ ...source, events: shared }])).toHaveLength(1);
});
