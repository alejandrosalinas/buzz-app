import { expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import type { Outbox } from "./outbox";
import type { ProfileQueries } from "./profile-directory";

const viewer = "1".repeat(64);
const agent = "2".repeat(64);
const human = "3".repeat(64);
const third = "4".repeat(64);
const root = "f".repeat(64);

function setup(members: readonly string[], channelType = "dm") {
  const send = vi.fn((_template: { tags: string[][] }) => "id");
  const outbox = { supports: () => true, send } as unknown as Outbox;
  const profiles = {
    snapshot: () =>
      new Map([
        [agent, { name: "Agent", isAgent: true }],
        [human, { name: "Human" }],
        [third, { name: "Third", isAgent: true }],
      ]),
  } as unknown as ProfileQueries;
  const messages = createMessages(
    outbox,
    viewer,
    () => undefined,
    () => [],
    () => {},
    () => true,
    undefined,
    undefined,
    undefined,
    profiles,
    // Mirrors the session: only a two-member DM names its other member.
    () =>
      channelType === "dm" && members.length === 2
        ? members.filter((key) => key !== viewer)
        : [],
  );
  const tags = () => send.mock.calls.at(-1)?.[0].tags ?? [];
  return { messages, tags };
}

it.each(["send", "reply"] as const)(
  "tags a one-to-one DM's agent partner without a mention, %s",
  (verb) => {
    const { messages, tags } = setup([viewer, agent]);
    if (verb === "send") messages.send("c", "hello");
    else messages.reply("c", root, "hello");
    expect(tags()).toContainEqual(["p", agent]);
  },
);

it("does not tag a human DM partner, which would bypass their mute", () => {
  const { messages, tags } = setup([viewer, human]);
  messages.send("c", "hello");
  messages.reply("c", root, "hello");
  expect(tags().some(([name]) => name === "p")).toBe(false);
});

it.each(["send", "reply"] as const)(
  "does not duplicate an explicit mention of the DM agent, %s",
  (verb) => {
    const { messages, tags } = setup([viewer, agent]);
    if (verb === "send") messages.send("c", "@Agent", [agent]);
    else messages.reply("c", root, "@Agent", [agent]);
    expect(tags().filter(([name]) => name === "p")).toEqual([["p", agent]]);
  },
);

it("leaves group DMs and other channels unchanged", () => {
  for (const [members, type] of [
    [[viewer, agent, third], "dm"],
    [[viewer, agent], "stream"],
  ] as const) {
    const { messages, tags } = setup(members, type);
    messages.send("c", "hello");
    messages.reply("c", root, "hello");
    expect(tags().some(([name]) => name === "p")).toBe(false);
  }
});

it("still rejects more than 32 recipients", () => {
  const { messages } = setup([viewer, agent]);
  const many = Array.from({ length: 33 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  expect(() => messages.send("c", "hello", many)).toThrow(/at most 32/);
});
