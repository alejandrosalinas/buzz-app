// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  attachmentDraft,
  attachmentDraftCount,
} from "../../features/messages/attachment-draft";
import { viewRevision } from "../../shared/view-state";
import { clearDraft, readDrafts } from "./drafts";

const viewer = "a".repeat(64);
const root = "b".repeat(64);
const scout = "5".repeat(64);
const scope = `https://demo.invalid:${viewer}`;
const session = { scope };
const saved = (key: string, value: unknown, partition = scope) =>
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([partition, key])}`,
    JSON.stringify(value),
  );
const NOW = Date.UTC(2026, 10, 4, 18, 0, 0) / 1000;
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("reads actual scoped drafts without touching any original records", () => {
  saved(`draft:team:thread:${root}`, {
    text: "Unfinished reply",
    recipients: [],
  });
  saved("draft:solo", "Solo prose");
  saved("draft:dm", { text: "", gifs: ["![gif](https://x.test/a.gif)"] });
  saved("draft:empty", { text: " \n" });
  saved("draft:foreign", "Private elsewhere", "other");
  saved("not-a-draft", "Ignored");
  const before = Object.fromEntries(
    Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
  );
  const result = readDrafts(session, NOW);
  expect(
    result.entries
      .map(({ signature: _, ...entry }) => entry)
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual([
    {
      id: "draft:dm",
      channelId: "dm",
      text: "Attached chat or GIF",
      placeholder: true,
      createdAt: NOW,
    },
    { id: "draft:solo", channelId: "solo", text: "Solo prose", createdAt: NOW },
    {
      id: `draft:team:thread:${root}`,
      channelId: "team",
      threadRootId: root,
      text: "Unfinished reply",
      createdAt: NOW,
    },
  ]);
  expect(result.unavailable).toBe(false);
  // Only the plugin's own change record was added; every draft is untouched.
  for (const [key, value] of Object.entries(before))
    expect(localStorage.getItem(key)).toBe(value);
  expect(localStorage.length).toBe(Object.keys(before).length + 1);
});

it("leaves out legacy follow-up seeds that hold only selected recipients", () => {
  const scoutTag = { pubkey: scout, name: "Scout", start: 0, end: 6 };
  saved("draft:seed", { text: "@Scout ", recipients: [scoutTag] });
  // A typed draft carries the editor snapshot, so it stays.
  saved("draft:typed", {
    text: "@Scout ",
    recipients: [scoutTag],
    document: {
      version: 1,
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "@Scout " }] },
        ],
      },
    },
  });
  saved("draft:prose", {
    text: "@Scout can you look?",
    recipients: [scoutTag],
  });
  saved("draft:gif", {
    text: "@Scout ",
    recipients: [scoutTag],
    gifs: ["![gif](https://x.test/a.gif)"],
  });
  // A tag that doesn't match its text isn't a recipient: the text is prose.
  saved("draft:unmatched", { text: "@Sam ", recipients: [scoutTag] });
  expect(
    readDrafts(session, NOW)
      .entries.map((entry) => entry.id)
      .sort(),
  ).toEqual(["draft:gif", "draft:prose", "draft:typed", "draft:unmatched"]);
});

it("bounds drafts and reports unreadable records", () => {
  for (let i = 0; i < 505; i++) saved(`draft:c${i}`, "draft");
  const bounded = readDrafts(session, NOW);
  expect(bounded.entries).toHaveLength(500);
  expect(bounded.limited).toBe(true);
  localStorage.clear();
  // jsdom's storage quota is smaller than the host's 8 MiB per-draft bound.
  const bigKey = `buzz-view.v1:${JSON.stringify([scope, "draft:big"])}`;
  localStorage.setItem(bigKey, '""');
  const getItem = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
    this: Storage,
    key: string,
  ) {
    return key === bigKey
      ? JSON.stringify("x".repeat(8 * 1024 * 1024))
      : getItem.call(this, key);
  });
  expect(readDrafts(session, NOW).unavailable).toBe(true);
});

it("remembers when drafts change, without storing their text", () => {
  saved("draft:team", "Older draft");
  expect(
    readDrafts(session, NOW).entries.map((e) => [e.id, e.createdAt]),
  ).toEqual([["draft:team", NOW]]);
  saved("draft:dm", "Brand new");
  expect(
    readDrafts(session, NOW + 60).entries.map((e) => [e.id, e.createdAt]),
  ).toEqual([
    ["draft:dm", NOW + 60],
    ["draft:team", NOW],
  ]);
  saved("draft:team", "Older draft, edited");
  expect(readDrafts(session, NOW + 120).entries[0]).toMatchObject({
    id: "draft:team",
    createdAt: NOW + 120,
  });
  const activity = Object.keys(localStorage).filter((key) =>
    key.startsWith("buzz-drafts-sent-activity.v1:"),
  );
  expect(activity).toHaveLength(1);
  expect(localStorage.getItem(activity[0] ?? "")).not.toContain("Older draft");
  // A cleared draft leaves the record; the rest keep their times.
  localStorage.removeItem(
    `buzz-view.v1:${JSON.stringify([scope, "draft:dm"])}`,
  );
  expect(
    readDrafts(session, NOW + 999).entries.map((e) => e.createdAt),
  ).toEqual([NOW + 120]);
  expect(localStorage.getItem(activity[0] ?? "")).not.toContain("draft:dm");
});

it("clears one draft's text and files, and keeps both when storage can't forget it", () => {
  const files = {
    scope,
    attachments: { upload: vi.fn(() => new Promise(() => {})) },
  };
  const attach = (key: string) =>
    attachmentDraft(
      files as unknown as Parameters<typeof attachmentDraft>[0],
      `${scope}:${key}`,
      "team",
    ).add([new File(["notes"], "notes.txt")]);
  const count = (key: string) =>
    attachmentDraftCount(
      files as unknown as Parameters<typeof attachmentDraftCount>[0],
      `${scope}:${key}`,
    );
  saved("draft:team", { text: "Caption" });
  saved(`draft:team:thread:${root}`, { text: "Thread caption" });
  attach("draft:team");
  attach(`draft:team:thread:${root}`);

  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {});
  expect(() => clearDraft(files, "draft:team")).toThrow();
  expect(count("draft:team")).toBe(1);
  expect(viewRevision(scope, "draft:team")).not.toBeNull();
  remove.mockRestore();

  clearDraft(files, "draft:team");
  expect(count("draft:team")).toBe(0);
  expect(viewRevision(scope, "draft:team")).toBeNull();
  expect(count(`draft:team:thread:${root}`)).toBe(1);
  expect(viewRevision(scope, `draft:team:thread:${root}`)).not.toBeNull();
});
