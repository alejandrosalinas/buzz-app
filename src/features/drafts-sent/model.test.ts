import { expect, it } from "vitest";
import { activityOf, indexContext } from "./context";
import {
  dayLabel,
  matches,
  preview,
  sentEntries,
  type ReadEvent,
} from "./model";

const viewer = "a".repeat(64);
const root = "b".repeat(64);
const id = "c".repeat(64);
const friend = "e".repeat(64);
const scout = "5".repeat(64);
const NOW = Date.UTC(2026, 10, 4, 18, 0, 0);
const event = (overrides: Partial<ReadEvent> = {}) =>
  ({
    id,
    pubkey: viewer,
    kind: 9,
    created_at: NOW / 1000 - 600,
    content: "Recently shipped",
    tags: [["h", "team"]],
    ...overrides,
  }) as ReadEvent;

it("sent keeps own accepted messages, newest first, and finds each thread's root", () => {
  const parent = "f".repeat(64);
  const events = [
    event(),
    event(),
    event({
      id: "2",
      created_at: 4567,
      tags: [
        ["h", "dm"],
        ["e", root, "", "reply"],
      ],
      delivery: "seen",
    }),
    event({
      id: "3",
      created_at: 4000,
      tags: [
        ["h", "dm"],
        ["e", root, "", "root"],
        ["e", parent, "", "reply"],
      ],
    }),
    event({ id: "other", pubkey: "other" }),
    event({ id: "reaction", kind: 7 }),
    ...(["sending", "failed", "unknown"] as const).map((delivery) =>
      event({ id: delivery, delivery }),
    ),
  ];
  const sent = sentEntries(events, viewer);
  expect(sent.map((entry) => entry.id)).toEqual([id, "2", "3"]);
  expect(sent[1]?.threadRootId).toBe(root);
  expect(sent[2]?.threadRootId).toBe(root);
  expect(
    sentEntries(
      Array.from({ length: 110 }, (_, i) =>
        event({ id: String(i), created_at: i }),
      ),
      viewer,
    ),
  ).toHaveLength(100);
});

it("follows Buzz's thread-reference rule: last marked root and reply win, and a lone root is top-level", () => {
  const parent = "f".repeat(64);
  const other = "9".repeat(64);
  const sent = sentEntries(
    [
      event({
        id: "1".repeat(64),
        created_at: 3000,
        tags: [
          ["h", "team"],
          ["e", root, "", "root"],
        ],
      }),
      event({
        id: "2".repeat(64),
        created_at: 2000,
        tags: [
          ["h", "team"],
          ["e", other, "", "root"],
          ["e", root, "", "root"],
          ["e", parent, "", "reply"],
        ],
      }),
      event({
        id: "3".repeat(64),
        created_at: 1000,
        tags: [
          ["h", "team"],
          ["e", "not-hex", "", "reply"],
          ["e", root.toUpperCase(), "", "reply"],
        ],
      }),
    ],
    viewer,
  );
  expect(sent.map((entry) => entry.threadRootId)).toEqual([
    undefined,
    root,
    root,
  ]);
  // A lone root isn't a reply, so it isn't counted in that post's thread.
  const index = indexContext([
    event({
      id: "4".repeat(64),
      pubkey: friend,
      tags: [
        ["h", "team"],
        ["e", root, "", "root"],
      ],
    }),
  ]);
  expect(index.byThread.get(root)).toBeUndefined();
});

it("shows sent messages as they read now: latest edit, deletions dropped, in Buzz's millisecond order", () => {
  const at = 5000;
  const a = "1".repeat(64);
  const b = "2".repeat(64);
  const gone = "3".repeat(64);
  const edit1 = "4".repeat(64);
  const edit2 = "6".repeat(64);
  const undone = "7".repeat(64);
  const team = ["h", "team"];
  const sent = sentEntries(
    [
      // Same second: `ms` decides, not the id.
      event({
        id: a,
        created_at: at,
        content: "First",
        tags: [team, ["ms", "900"]],
      }),
      event({
        id: b,
        created_at: at,
        content: "Second",
        tags: [team, ["ms", "100"]],
      }),
      event({ id: gone, created_at: at - 1, content: "Removed", tags: [team] }),
      event({
        id: edit1,
        kind: 40003,
        created_at: at + 10,
        content: "First, edited",
        tags: [team, ["e", a]],
      }),
      event({
        id: edit2,
        kind: 40003,
        created_at: at + 20,
        content: "First, edited again",
        tags: [team, ["e", a]],
      }),
      event({
        id: undone,
        kind: 5,
        created_at: at + 30,
        content: "",
        tags: [["e", edit2]],
      }),
      event({
        id: "8".repeat(64),
        kind: 5,
        created_at: at + 30,
        content: "",
        tags: [["e", gone]],
      }),
      // Someone else can't edit or delete your message.
      event({
        id: "9".repeat(64),
        pubkey: friend,
        kind: 40003,
        created_at: at + 40,
        content: "Hijacked",
        tags: [["e", b]],
      }),
      event({
        id: "0".repeat(64),
        pubkey: friend,
        kind: 5,
        created_at: at + 40,
        content: "",
        tags: [["e", b]],
      }),
    ],
    viewer,
  );
  expect(sent.map((entry) => [entry.id, entry.text])).toEqual([
    [a, "First, edited"],
    [b, "Second"],
  ]);
  expect(sent.map((entry) => entry.createdAtMs)).toEqual([
    at * 1000 + 900,
    at * 1000 + 100,
  ]);
  // A reply in the same second but earlier by `ms` isn't after yours; a later one is.
  const inThread = [team, ["e", root, "", "reply"]];
  const mine = sentEntries(
    [event({ id: a, created_at: at, tags: [...inThread, ["ms", "500"]] })],
    viewer,
  )[0];
  if (!mine) throw new Error("expected a sent entry");
  const index = indexContext([
    event({
      id: "f".repeat(64),
      pubkey: friend,
      created_at: at,
      tags: [...inThread, ["ms", "499"]],
    }),
    event({
      id: "0".repeat(64),
      pubkey: scout,
      created_at: at,
      tags: [...inThread, ["ms", "501"]],
    }),
  ]);
  expect(
    activityOf(mine, "thread", index, viewer).after.map((e) => e.pubkey),
  ).toEqual([scout]);
  expect(index.byThread.get(root)?.map((e) => e.pubkey)).toEqual([
    friend,
    scout,
  ]);
});

it("previews are one bounded line of words, with spoilers hidden from display and search", () => {
  expect(preview("hello ||secret|| world", "Attachment")).toBe(
    "hello [Spoiler] world",
  );
  expect(
    preview(
      "**Ship** it: see [the notes](<https://x.test/a>)\n\n- `v2` later",
      "Attachment",
    ),
  ).toBe("Ship it: see the notes v2 later");
  expect(preview("![image.png](<https://x.test/i.png>)", "Attachment")).toBe(
    "[Image]",
  );
  expect(preview("", "Attachment")).toBe("Attachment");
  expect(Array.from(preview("a".repeat(2000), ""))).toHaveLength(200);
  expect(matches(preview("||secret||", ""), "Research", "research")).toBe(true);
  expect(matches(preview("||secret||", ""), "Team", "secret")).toBe(false);
});

it("labels days", () => {
  const at = (minutesAgo: number) => (NOW - minutesAgo * 60000) / 1000;
  expect(dayLabel(at(5), NOW)).toBe("Today");
  expect(dayLabel(at(60 * 26), NOW)).toBe("Yesterday");
});
