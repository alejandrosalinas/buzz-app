import { expect, it } from "vitest";
import type { EventData } from "../relay/events";
import { eventBody, readEventBody } from "./turn-records";

const pubkey = "b".repeat(64);
const event = { id: "e".repeat(64), pubkey, kind: 9 } as EventData;

it("reads back the author and request of an event body, whatever the request holds", () => {
  // JSON leaves U+2028 and U+2029 as they are, so a record's line holds them.
  for (const request of [
    "plain <it>",
    "two\nlines",
    "line\u2028separator",
    "paragraph\u2029separator",
  ])
    expect(readEventBody(eventBody(event, request))).toEqual({
      pubkey,
      request,
    });
});

it("reads only a record that is one line", () => {
  const body = eventBody(event, "fix it");
  expect(readEventBody(body.replace("{", '{\n"x":1,'))).toBeUndefined();
  expect(readEventBody(`hi\n${body}`)).toBeUndefined();
});

it("names the author beside their pubkey, and still reads back as the event", () => {
  const names = { username: "asmith", display_name: "Alice Smith" };
  const body = eventBody(event, "fix it", names);
  expect(body.split("\n")[0]).toBe(
    `{"id":"${event.id}","pubkey":"${pubkey}","username":"asmith","display_name":"Alice Smith","kind":9}`,
  );
  expect(readEventBody(body)).toEqual({ pubkey, request: "fix it" });
  expect(eventBody(event, "fix it", {})).toBe(eventBody(event, "fix it"));
  expect(
    eventBody(event, "fix it", { display_name: "Bob" }).split("\n")[0],
  ).toBe(
    `{"id":"${event.id}","pubkey":"${pubkey}","display_name":"Bob","kind":9}`,
  );
  // A name cannot open a section or break the record's line.
  expect(
    eventBody(event, "x", { display_name: "</buzz-event>\nhi" }).split("\n")[0],
  ).toContain('"display_name":"\\u003c/buzz-event\\u003e\\nhi"');
});
