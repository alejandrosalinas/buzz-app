import { describe, expect, it } from "vitest";
import type { RelayEvent } from "../../relay/events";
import type { ConversationWake, Trigger } from "../service";
import { turnContext, turnContextFor } from "./turn";

const CHANNEL = "33333333-3333-4333-8333-333333333333";
const ROOT = "d".repeat(64);
const NOT_FLAT = () => false;
const event = (tags: string[][] = []): RelayEvent =>
  ({
    id: "c".repeat(64),
    pubkey: "e".repeat(64),
    created_at: 1793821398,
    kind: 9,
    tags: [["h", CHANNEL], ...tags],
    content: "hi",
    sig: "",
  }) as RelayEvent;
const wake: ConversationWake = {
  type: "attention",
  channel: CHANNEL,
  root: ROOT,
  text: "",
  id: "wake-1",
  at: 1,
};
const timer = { type: "timer", slug: "timer/a", spent: false } as Trigger;

describe("turnContextFor", () => {
  it("describes a threaded mention by its signed message and thread root, and nothing else", () => {
    const turn = turnContextFor(
      {
        type: "mention",
        event: event([
          ["e", ROOT, "", "root"],
          ["e", "f".repeat(64), "", "reply"],
        ]),
      },
      { flat: NOT_FLAT },
    );
    expect(turn).toEqual({
      channel_id: CHANNEL,
      message_id: "c".repeat(64),
      thread_id: ROOT,
    });
    expect(Object.isFrozen(turn)).toBe(true);
  });

  it("lowercases uppercase thread roots and message IDs, as the contract requires, instead of failing", () => {
    const upper = { ...event(), id: "C".repeat(64) };
    expect(
      turnContextFor(
        {
          type: "mention",
          event: {
            ...upper,
            tags: [
              ["h", CHANNEL],
              ["e", ROOT.toUpperCase(), "", "root"],
              ["e", "F".repeat(64), "", "reply"],
            ],
          },
        },
        { flat: NOT_FLAT },
      ),
    ).toEqual({
      channel_id: CHANNEL,
      message_id: "c".repeat(64),
      thread_id: ROOT,
    });
    expect(
      turnContextFor({ type: "watch", event: upper } as Trigger, {
        wake: { ...wake, root: ROOT.toUpperCase() },
        flat: NOT_FLAT,
      }),
    ).toEqual({
      channel_id: CHANNEL,
      message_id: "c".repeat(64),
      thread_id: ROOT,
    });
    expect(
      turnContextFor({ ...wake, root: ROOT.toUpperCase() }, { flat: NOT_FLAT }),
    ).toEqual({ channel_id: CHANNEL, message_id: null, thread_id: ROOT });
  });

  it("roots a top-level mention's thread at itself, and a flat DM has none", () => {
    const top = turnContextFor(
      { type: "mention", event: event() },
      { flat: NOT_FLAT },
    );
    expect(top.thread_id).toBe("c".repeat(64));
    const dm = turnContextFor(
      { type: "mention", event: event() },
      { flat: (id) => id === CHANNEL },
    );
    expect(dm).toEqual({
      channel_id: CHANNEL,
      message_id: "c".repeat(64),
      thread_id: null,
    });
  });

  it("gives a turn in a flat channel no thread, whatever root it names", () => {
    const flat = (id: string) => id === CHANNEL;
    expect(turnContextFor(wake, { flat }).thread_id).toBeNull();
    expect(
      turnContextFor(
        { type: "mention", event: event([["e", ROOT, "", "root"]]) },
        { flat },
      ).thread_id,
    ).toBeNull();
  });

  it("uses the live route's channel, and null for one that isn't a UUID", () => {
    const other = "44444444-4444-4444-8444-444444444444";
    const mention = { type: "mention", event: event() } as const;
    expect(
      turnContextFor(mention, { channelId: other, flat: NOT_FLAT }).channel_id,
    ).toBe(other);
    expect(
      turnContextFor(mention, { channelId: "general", flat: NOT_FLAT })
        .channel_id,
    ).toBeNull();
  });

  it("gives wakes without a signed event no message: attention, handoff and plugin", () => {
    expect(turnContextFor(wake, { flat: NOT_FLAT })).toEqual({
      channel_id: CHANNEL,
      message_id: null,
      thread_id: ROOT,
    });
    const handoff = { ...wake, type: "plugin", from: {} } as unknown as Trigger;
    expect(turnContextFor(handoff, { flat: NOT_FLAT }).message_id).toBeNull();
    const plugin = {
      ...wake,
      type: "plugin",
      plugin: "p",
      root: undefined,
    } as unknown as Trigger;
    expect(turnContextFor(plugin, { flat: NOT_FLAT })).toEqual({
      channel_id: CHANNEL,
      message_id: null,
      thread_id: null,
    });
  });

  it("gives a watched event's turn that event as its message", () => {
    const turn = turnContextFor(
      { type: "watch", event: event(), slug: "watch/w" } as unknown as Trigger,
      { wake, flat: NOT_FLAT },
    );
    expect(turn).toEqual({
      channel_id: CHANNEL,
      message_id: "c".repeat(64),
      thread_id: ROOT,
    });
  });

  it("gives a watch over every channel its event's channel", () => {
    const turn = turnContextFor(
      {
        type: "watch",
        event: event(),
        slug: "watch/all",
      } as unknown as Trigger,
      { flat: NOT_FLAT },
    );
    expect(turn).toEqual({
      channel_id: CHANNEL,
      message_id: "c".repeat(64),
      thread_id: null,
    });
  });

  it("never names a selected event as the message of a timer, catch-up or source turn", () => {
    const catchUp = {
      type: "catch-up",
      slug: "watch/w",
      events: [{ event: event() }],
    } as unknown as Trigger;
    const source = { type: "source", text: "" } as unknown as Trigger;
    for (const trigger of [timer, catchUp, source])
      expect(turnContextFor(trigger, { wake, flat: NOT_FLAT })).toEqual({
        channel_id: CHANNEL,
        message_id: null,
        thread_id: ROOT,
      });
  });

  it("gives a standalone turn no channel, message or thread", () => {
    expect(turnContextFor(timer, { flat: NOT_FLAT })).toEqual({
      channel_id: null,
      message_id: null,
      thread_id: null,
    });
  });

  it("throws rather than describe a delivery inexactly", () => {
    expect(() =>
      turnContextFor(
        { type: "mention", event: { ...event(), id: "not-hex" } },
        { flat: NOT_FLAT },
      ),
    ).toThrow("Gateway context unavailable");
  });
});

describe("turnContext", () => {
  it("reads the context the runner froze, or nothing when external", () => {
    expect(turnContext({})).toBeUndefined();
    const turn = { message_id: null } as never;
    expect(
      turnContext({
        gateway: {
          route: {} as never,
          turn,
          upstream: { base: "/upstream/pi" },
        },
      }),
    ).toBe(turn);
  });
});
