import { describe, expect, it } from "vitest";
import { noticeFilter, parseWindow, windowFilter } from "./window";
import { bounds, keypair, message } from "./testing";

const relay = keypair(),
  author = keypair(),
  impostor = keypair();
const channel = "chan-1";
const id = "a".repeat(64);

describe("channel window bounds", () => {
  it("requests top-level rows with aux and summaries, and only echoes a full composite cursor", () => {
    expect(windowFilter(channel, null)).toMatchObject({
      kinds: [9, 40002, 40008, 48100, 48103],
      "#h": [channel],
      top_level: true,
      include_aux: true,
      include_summaries: true,
      limit: 20,
    });
    expect(windowFilter(channel, null)).not.toHaveProperty("until");
    expect(
      windowFilter(channel, { createdAt: 5, eventId: id }, 999),
    ).toMatchObject({ until: 5, before_id: id, limit: 200 });
  });
  it("leaves aux and summaries out of bare probe reads", () => {
    const bare = windowFilter(channel, null, 200, false);
    expect(bare).toMatchObject({ top_level: true, limit: 200 });
    expect(bare).not.toHaveProperty("include_aux");
    expect(bare).not.toHaveProperty("include_summaries");
  });
  it("reads the relay's membership notices apart, by the same composite cursor", () => {
    expect(noticeFilter(channel, relay.pubkey, null)).toEqual({
      kinds: [40099],
      "#h": [channel],
      authors: [relay.pubkey],
      limit: 500,
    });
    expect(
      noticeFilter(channel, relay.pubkey, { createdAt: 5, eventId: id }),
    ).toMatchObject({ until: 5, before_id: id });
  });
  it("accepts exactly one relay-signed bound for the requested cursor and strips overlays", () => {
    const row = message(author, channel, "hi", 10);
    const page = parseWindow(channel, null, relay.pubkey, [
      row,
      bounds(relay, channel, "head", {
        has_more: true,
        next_cursor: { created_at: 10, id },
      }),
    ]);
    expect(page.events).toEqual([row]);
    expect(page).toMatchObject({
      hasMore: true,
      cursor: { createdAt: 10, eventId: id },
    });
    const last = parseWindow(
      channel,
      { createdAt: 10, eventId: id },
      relay.pubkey,
      [
        bounds(relay, channel, `10:${id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ],
    );
    expect(last).toMatchObject({ hasMore: false, cursor: null, events: [] });
  });
  it("rejects missing, duplicated, foreign, mismatched or self-contradicting bounds", () => {
    const good = bounds(relay, channel, "head", {
      has_more: false,
      next_cursor: null,
    });
    expect(() => parseWindow(channel, null, relay.pubkey, [])).toThrow(
      /invalid window bounds/,
    );
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [good, good]),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(impostor, channel, "head", {
          has_more: false,
          next_cursor: null,
        }),
      ]),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, `10:${id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ]),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, "other", "head", { has_more: false, next_cursor: null }),
      ]),
    ).toThrow(/invalid window bounds/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, "head", { has_more: true, next_cursor: null }),
      ]),
    ).toThrow(/contradict/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, "head", {
          has_more: true,
          next_cursor: { created_at: 1, id: "nope" },
        }),
      ]),
    ).toThrow(/cursor is malformed/);
    expect(() =>
      parseWindow(channel, null, relay.pubkey, [
        bounds(relay, channel, "head", {
          has_more: "yes" as unknown as boolean,
          next_cursor: null,
        }),
      ]),
    ).toThrow(/omit has_more/);
  });
});

it("advances valid equal-time composite history cursors deterministically", () => {
  const cursor = { createdAt: 10, eventId: "a".repeat(64) };
  const nextId = "b".repeat(64);
  const page = parseWindow(channel, cursor, relay.pubkey, [
    bounds(relay, channel, `10:${cursor.eventId}`, {
      has_more: true,
      next_cursor: { created_at: 10, id: nextId },
    }),
  ]);
  expect(page.cursor).toEqual({ createdAt: 10, eventId: nextId });
});
