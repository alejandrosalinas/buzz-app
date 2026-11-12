import { assert, describe, expect, it } from "vitest";
import { shareMessageRows } from "../relay/row-identity";
import { foldMessages } from "../relay/fold";
import { profileTarget } from "../profiles/target";
import { messageEditText, validateMessageEdit } from "./message-edit";
import type { EventData } from "../relay/events";

const author = "a".repeat(64),
  person = "b".repeat(64);
const original: EventData = {
  id: "c".repeat(64),
  pubkey: author,
  kind: 9,
  created_at: 1,
  content: "Hello @Sam\n\n![photo](https://example.com/photo.png)",
  tags: [
    ["h", "room"],
    ["p", person],
    ["imeta", "url https://example.com/photo.png", "m image/png"],
  ],
};
function firstRow(events: EventData[]) {
  const row = foldMessages("room", author, events)[0];
  assert.exists(row);
  return row;
}
const profiles = new Map([[person, { id: person, name: "Sam" }]]);

describe("message edit round trips", () => {
  it("retains attachment Markdown and binds existing exact mention identities", () => {
    const row = firstRow([original]);
    expect(row.content).not.toContain("![photo]");
    const draft = messageEditText(row, profiles);
    expect(draft).toContain(`[@Sam](${profileTarget(person)})`);
    expect(draft).toContain("![photo](https://example.com/photo.png)");
    const edit = {
      ...original,
      id: "d".repeat(64),
      kind: 40003,
      created_at: 2,
      content: draft.replace("Hello", "Hi"),
      tags: [
        ["h", "room"],
        ["e", original.id],
      ],
    };
    const edited = firstRow([original, edit]);
    expect(edited.attachments).toEqual(row.attachments);
    expect(edited.mentions).toEqual([person]);
    expect(messageEditText(edited, profiles)).toBe(edit.content);
  });
  it("starts from the latest edit rather than the original body", () => {
    const edit = {
      ...original,
      id: "d".repeat(64),
      kind: 40003,
      created_at: 2,
      content: "New text",
      tags: [
        ["h", "room"],
        ["e", original.id],
      ],
    };
    expect(messageEditText(firstRow([original, edit]), profiles)).toBe(
      "New text",
    );
  });
  it("never binds names in an old edit using original recipients", () => {
    const row = firstRow([original]);
    expect(messageEditText({ ...row, edited: true }, profiles)).toBe(
      original.content,
    );
  });
  it("never infers a recipient from unbound prose", () => {
    const row = firstRow([{ ...original, tags: [["h", "room"]] }]);
    expect(messageEditText(row, profiles)).toBe(original.content);
  });
  it.each([
    "[ref]: <https://example.com/a @Sam>",
    '[ref]: https://example.com "Ask @Sam"',
    "<!-- @Sam -->",
    '<span title="@Sam">Hi</span>',
    '[[a]](https://example.com "See @Sam")',
    '[a](https://example.com\n "See @Sam")',
    "[hello\n@Sam](https://example.com)",
    ">     @Sam",
  ])("links a name beside literal Markdown, not inside it: %s", (literal) => {
    const content = `<b>@Sam</b>\n\n${literal}`;
    const tags = [
      ["h", "room"],
      ["p", person],
    ];
    expect(
      messageEditText(firstRow([{ ...original, content, tags }]), profiles),
    ).toBe(`<b>[@Sam](${profileTarget(person)})</b>\n\n${literal}`);
  });
});

it("rejects changed attachment links while allowing text-only edits", () => {
  const row = firstRow([original]);
  assert.exists(row);
  const initial = row.sourceContent ?? row.content;
  expect(
    validateMessageEdit(row, initial, initial.replace("Hello", "Corrected")),
  ).toContain("Corrected");
  expect(() => validateMessageEdit(row, initial, "Removed the image")).toThrow(
    "Keep attachment links unchanged",
  );
  expect(() =>
    validateMessageEdit(
      row,
      initial,
      initial.replace("photo.png", "other.png"),
    ),
  ).toThrow("Keep attachment links unchanged");
});

it("row sharing retains latest editable source even when attachment rendering is unchanged", () => {
  const edit = {
    ...original,
    id: "d".repeat(64),
    kind: 40003,
    created_at: 2,
    tags: [
      ["h", "room"],
      ["e", original.id],
    ],
    content: "Updated ![photo](https://example.com/photo.png)",
  };
  const previous = foldMessages("room", author, [original, edit]);
  const next = foldMessages("room", author, [
    original,
    {
      ...edit,
      id: "e".repeat(64),
      created_at: 3,
      content: "Updated ![photo](<https://example.com/photo.png>)",
    },
  ]);
  const shared = shareMessageRows(previous, next);
  assert.exists(shared[0]);
  expect(messageEditText(shared[0], profiles)).toBe(
    "Updated ![photo](<https://example.com/photo.png>)",
  );
  expect(shareMessageRows(next, next)[0]).toBe(next[0]);
});
