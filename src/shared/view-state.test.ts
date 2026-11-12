// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  clearView,
  clearViewScope,
  draftCoordinates,
  listDraftViews as enumerateDrafts,
  readView,
  replaceView,
  viewRevision,
  subscribeView,
  writeView,
} from "./view-state";

const meaningful = (value: unknown) =>
  typeof value === "string"
    ? !!value.trim()
    : !!value &&
      typeof value === "object" &&
      "text" in value &&
      typeof value.text === "string" &&
      !!value.text.trim();
const listDraftViews = (scope: string) =>
  enumerateDrafts(scope, meaningful).entries;
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("enumerates only this viewer's existing channel/thread composer keys, including punctuated channel IDs", () => {
  const root = "a".repeat(64);
  writeView("relay:alice", "draft:room.with-hyphen", { text: "first" });
  writeView("relay:alice", `draft:room.with-hyphen:thread:${root}`, {
    text: "reply",
  });
  writeView("relay:bob", "draft:room.with-hyphen", { text: "other viewer" });
  writeView("relay:alice", "other:preference", "no");
  expect(listDraftViews("relay:alice")).toEqual([
    { key: "draft:room.with-hyphen", value: { text: "first" } },
    { key: `draft:room.with-hyphen:thread:${root}`, value: { text: "reply" } },
  ]);
  expect(draftCoordinates(`draft:room.with-hyphen:thread:${root}`)).toEqual({
    channelId: "room.with-hyphen",
    threadRootId: root,
  });
  expect(draftCoordinates("draft:../invalid")).toBeUndefined();
});
it("notifies own writes and scoped cross-window storage changes, but stops after unsubscribe", () => {
  const onChange = vi.fn();
  const stop = subscribeView("scope", onChange);
  try {
    writeView("elsewhere", "draft:room", "other");
    expect(onChange).not.toHaveBeenCalled();
    writeView("scope", "draft:room", "hello");
    expect(onChange).toHaveBeenCalledTimes(1);
    window.dispatchEvent(
      new StorageEvent("storage", {
        storageArea: localStorage,
        key: 'buzz-view.v1:["elsewhere","draft:room"]',
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    window.dispatchEvent(
      new StorageEvent("storage", {
        storageArea: localStorage,
        key: 'buzz-view.v1:["scope","draft:room"]',
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(2);
    clearView("scope", "draft:room");
    expect(onChange).toHaveBeenCalledTimes(3);
  } finally {
    stop();
  }
  writeView("scope", "draft:room", "again");
  expect(onChange).toHaveBeenCalledTimes(3);
});
it("ignores malformed/oversized entries and unavailable storage without leaking another scope", () => {
  localStorage.setItem("buzz-view.v1:not json", "hi");
  localStorage.setItem('buzz-view.v1:["scope","draft:room"]', "{bad json");
  const oversizedKey = 'buzz-view.v1:["scope","draft:long"]';
  localStorage.setItem(oversizedKey, '"placeholder"');
  const getItem = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
    this: Storage,
    key,
  ) {
    return key === oversizedKey
      ? `"${"x".repeat(8 * 1024 * 1024)}"`
      : getItem.call(this, key);
  });
  expect(enumerateDrafts("scope", meaningful).unavailable).toBe(1);
  expect(listDraftViews("scope")).toEqual([]);
  const old = Storage.prototype.key;
  vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
    throw Error("denied");
  });
  expect(listDraftViews("scope")).toEqual([]);
  Storage.prototype.key = old;
  expect(readView("scope", "draft:room", "fallback")).toBe("fallback");
});

it("counts meaningful drafts rather than empty history and never reads another scope's values", () => {
  for (let i = 0; i < 510; i++)
    writeView("scope", `draft:empty-${i}`, { text: "  " });
  writeView("other", "draft:sensitive", { text: "private" });
  writeView("scope", "other:secret", { token: "not a draft" });
  writeView("scope", "draft:real", { text: "saved" });
  const reads = vi.spyOn(Storage.prototype, "getItem");
  expect(listDraftViews("scope")).toEqual([
    { key: "draft:real", value: { text: "saved" } },
  ]);
  expect(reads.mock.calls.flat()).not.toContain(
    'buzz-view.v1:["other","draft:sensitive"]',
  );
  expect(reads.mock.calls.flat()).not.toContain(
    'buzz-view.v1:["scope","other:secret"]',
  );
  expect(
    enumerateDrafts("scope", meaningful, "draft:empty-509").entries,
  ).toHaveLength(2);
  for (let i = 0; i < 500; i++)
    writeView("scope", `draft:full-${i}`, { text: "saved" });
  expect(enumerateDrafts("scope", meaningful)).toMatchObject({ limited: true });
  expect(listDraftViews("scope")).toHaveLength(500);
  clearView("scope", "draft:empty-509");
  expect(
    enumerateDrafts("scope", meaningful, "draft:empty-509").entries,
  ).toHaveLength(500);
});

it("community scope cleanup removes only that scope and notifies its same-window draft subscribers", () => {
  const scope = 'relay:alice"quoted';
  writeView(scope, "draft:room", "Leaving draft");
  writeView(scope, "scroll:room", { offset: 42 });
  writeView(`${scope}-other`, "draft:room", "Keep draft");
  const listener = vi.fn();
  const stop = subscribeView(scope, listener);
  try {
    clearViewScope(scope);
    expect(listDraftViews(scope)).toEqual([]);
    expect(readView(scope, "scroll:room", undefined)).toBeUndefined();
    expect(listDraftViews(`${scope}-other`)).toEqual([
      { key: "draft:room", value: "Keep draft" },
    ]);
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it("reports write failures and compares the exact current revision before replacing", () => {
  const scope = "scope",
    key = "draft:room";
  expect(writeView(scope, key, "original")).toBe(true);
  const original = viewRevision(scope, key);
  expect(replaceView(scope, key, original, "next")).toBe("saved");
  expect(replaceView(scope, key, original, "stale")).toBe("changed");
  expect(readView(scope, key, "")).toBe("next");
  const fail = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {});
  expect(writeView(scope, key, "silently rejected")).toBe(false);
  expect(replaceView(scope, key, viewRevision(scope, key), "failed")).toBe(
    "failed",
  );
  fail.mockImplementation(() => {
    throw Error("storage denied");
  });
  expect(writeView(scope, key, "rejected")).toBe(false);
  expect(replaceView(scope, key, viewRevision(scope, key), "failed")).toBe(
    "failed",
  );
  expect(readView(scope, key, "")).toBe("next");
});

it("uses one raw read with unchanged fallback and falsy-value semantics", () => {
  const key = 'buzz-view.v1:["scope","value"]';
  const read = vi.spyOn(Storage.prototype, "getItem");
  for (const [raw, expected] of [
    [null, "fallback"],
    ["{malformed", "fallback"],
    ["null", "fallback"],
    ["false", false],
    ["0", 0],
    ['""', ""],
  ] as const) {
    read.mockReturnValue(raw);
    read.mockClear();
    expect(readView<unknown>("scope", "value", "fallback")).toBe(expected);
    expect(read).toHaveBeenCalledExactlyOnceWith(key);
  }
  read.mockImplementation(() => {
    throw Error("storage unavailable");
  });
  read.mockClear();
  expect(readView("scope", "value", "fallback")).toBe("fallback");
  expect(read).toHaveBeenCalledExactlyOnceWith(key);
});

it("records the write phase when a subscriber fails after storage accepts a draft", async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const stop = subscribeView("scope", () => {
    throw Error("private error");
  });
  try {
    expect(writeView("scope", "draft:room", "private draft")).toBe(false);
    expect(readView("scope", "draft:room", "")).toBe("private draft");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const payload = invoke.mock.calls.at(-1)?.[1];
    expect(payload).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({ operation: "notify-failed" }),
      ]),
    });
    expect(JSON.stringify(payload)).not.toContain("private");
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});
