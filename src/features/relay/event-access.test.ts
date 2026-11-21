import { expect, it, vi } from "vitest";
import { accessOnce, eventVisibility } from "./event-access";
import { type EventData, eventDto } from "./events";
import { keypair, signed } from "./testing";

const event = (id: string, channelId: string): EventData => ({
  id,
  pubkey: "a".repeat(64),
  kind: 40099,
  created_at: 1,
  content: "",
  tags: [["h", channelId]],
});

it("accessOnce reads each channel's access once for a batch", () => {
  const canAccess = vi.fn((channelId: string) => channelId === "open");
  const visible = eventVisibility(accessOnce(canAccess), () => undefined);
  const events = Array.from({ length: 1000 }, (_, i) =>
    event(`e${i}`, i % 2 ? "open" : "closed"),
  );
  expect(events.filter(visible)).toHaveLength(500);
  expect(canAccess).toHaveBeenCalledTimes(2);
});

it("ignores a stray h tag on a kind 0 profile, as the relay does", () => {
  const visible = eventVisibility(
    () => false,
    () => undefined,
  );
  expect(visible({ ...event("profile", "closed"), kind: 0 })).toBe(true);
  expect(visible(event("content", "closed"))).toBe(false);
});

it("admits visibility only for rows with one accessible channel tag", () => {
  const author = keypair();
  const visible = eventVisibility(
    (channel) => channel === "open",
    () => undefined,
  );
  const cases: [tags: string[][], allowed: boolean][] = [
    [[["h", "open"]], true],
    [[["h", "closed"]], false],
    [
      [
        ["h", ""],
        ["h", "open"],
      ],
      false,
    ],
    [
      [
        ["h", "open"],
        ["h", "open"],
      ],
      false,
    ],
    [[["h"]], false],
    [[], false],
  ];
  for (const [tags, allowed] of cases) {
    const row = eventDto(signed(author, { kind: 9, content: "", tags }));
    expect(visible(row), JSON.stringify(tags)).toBe(allowed);
  }
});
