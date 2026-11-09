import { describe, expect, it } from "vitest";
import {
  parseGitPluginSource,
  parseOpenTarget,
  targetKey,
  type OpenTarget,
} from "./targets";
const viewer = "a".repeat(64);
const conversation = {
  version: 1,
  kind: "conversation",
  scope: { viewer, communityOrigin: "wss://RELAY.example.:443/" },
  channelId: "channel-123",
  messageId: "B".repeat(64),
} as const;

describe("open target boundary", () => {
  it("bounds a scoped forwarding presentation independently of its underlying message", () => {
    const target = parseOpenTarget({
      ...conversation,
      forward: "D".repeat(64),
    });
    expect(target).toEqual({
      ...parseOpenTarget(conversation),
      forward: "d".repeat(64),
    });
    expect(targetKey(target)).not.toBe(targetKey(conversation));
    expect(() =>
      parseOpenTarget({ ...conversation, forward: "invalid" }),
    ).toThrow();
  });
  it("bounds nested provider addresses to Agent setup and keeps their scope", () => {
    const target = {
      version: 1,
      kind: "settings",
      section: "agents",
      provider: "buzz.codex/codex",
      scope: { viewer, communityOrigin: "https://relay.example" },
    } as const;
    expect(parseOpenTarget(target)).toEqual(target);
    expect(targetKey(target)).not.toBe(
      targetKey({
        version: 1,
        kind: "settings",
        section: "agents",
        scope: target.scope,
      }),
    );
    for (const invalid of [
      { ...target, section: "appearance" },
      { ...target, provider: "invalid" },
      { ...target, provider: `plugin/${"a".repeat(129)}` },
    ])
      expect(() => parseOpenTarget(invalid)).toThrow();
  });
  it("canonicalizes and freezes a detached, bounded identity-scoped target", () => {
    const input = {
      ...conversation,
      scope: {
        ...conversation.scope,
        communityOrigin: String(conversation.scope.communityOrigin),
      },
    };
    const target = parseOpenTarget(input);
    input.scope.communityOrigin = "wss://other.example";
    expect(target).toEqual({
      ...conversation,
      scope: { viewer, communityOrigin: "https://relay.example" },
      messageId: "b".repeat(64),
    });
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen("scope" in target && target.scope)).toBe(true);
  });
  it("gives Members its own scoped visit without losing the conversation or message", () => {
    const target = parseOpenTarget({ ...conversation, panel: "members" });
    expect(target).toEqual({
      ...parseOpenTarget(conversation),
      panel: "members",
    });
    expect(targetKey(target)).not.toBe(targetKey(conversation));
    expect(Object.isFrozen(target)).toBe(true);
    expect(() => parseOpenTarget({ ...target, scope: undefined })).toThrow();
  });
  it("keeps Open in channel's thread context as its own visit", () => {
    const thread = { ...conversation, threadRootId: "C".repeat(64) };
    const target = parseOpenTarget({ ...thread, context: "channel" });
    expect(target).toEqual({ ...parseOpenTarget(thread), context: "channel" });
    expect(targetKey(target)).not.toBe(targetKey(thread));
  });
  it("opens a saved Shared sessions target as its conversation", () => {
    const target = parseOpenTarget({
      ...conversation,
      panel: "shared-sessions",
    });
    expect(target).toEqual(parseOpenTarget(conversation));
  });
  it("copies and bounds a read-only detail address independently of Members", () => {
    const detail = { target: "nostr:npub1example", rootId: "C".repeat(64) };
    const target = parseOpenTarget({ ...conversation, detail });
    detail.target = "changed";
    expect(target.kind === "conversation" && target.detail).toEqual({
      target: "nostr:npub1example",
      rootId: "c".repeat(64),
    });
    expect(
      Object.isFrozen(target.kind === "conversation" && target.detail),
    ).toBe(true);
    expect(targetKey(target)).not.toBe(targetKey(conversation));
    for (const detail of [
      null,
      {},
      { target: "with space" },
      { target: "x".repeat(4097) },
      { target: "profile:x", rootId: "invalid" },
      { target: "profile:x", action: "delete" },
    ])
      expect(() => parseOpenTarget({ ...conversation, detail })).toThrow();
  });
  it("supports local targets without account or relay and gives routes stable identity", () => {
    for (const target of [
      { version: 1, kind: "home" },
      { version: 1, kind: "settings", section: "appearance" },
      { version: 1, kind: "settings", section: "org.example/card" },
    ] as const)
      expect(parseOpenTarget(target)).toEqual(target);
    const a: OpenTarget = {
      version: 1,
      kind: "page",
      pluginId: "org.example",
      pageId: "board",
      route: { version: 2, params: { b: 1, a: [true, null] } },
    };
    const b: OpenTarget = {
      ...a,
      route: { version: 2, params: { a: [true, null], b: 1 } },
    };
    expect(targetKey(a)).toBe(targetKey(b));
    expect(parseOpenTarget(a)).toEqual(a);
  });
  it.each([
    null,
    [],
    {},
    { version: 2, kind: "home" },
    { version: 1, kind: "home", command: "sign" },
    {
      ...conversation,
      scope: { viewer, communityOrigin: "https://secret@relay.example" },
    },
    // A scope is always bound to a viewer; there is no viewer-less locator form.
    { ...conversation, scope: { communityOrigin: "https://relay.example" } },
    {
      ...conversation,
      scope: { viewer: "npub1wrong", communityOrigin: "https://relay.example" },
    },
    { ...conversation, messageId: "not-an-id" },
    { ...conversation, panel: "settings" },
    { ...conversation, panel: { kind: "members", remove: "someone" } },
    { ...conversation, panel: null },
    { ...conversation, messageId: undefined, threadRootId: "b".repeat(64) },
    // Context names where a thread's root shows; it needs that root.
    { ...conversation, context: "channel" },
    { ...conversation, threadRootId: "b".repeat(64), context: "timeline" },
    { ...conversation, channelId: "../../other" },
    { version: 1, kind: "page", pluginId: "a/b", pageId: "board" },
    {
      version: 1,
      kind: "page",
      pluginId: "a",
      pageId: "board",
      route: { version: 0, params: null },
    },
  ])(
    "rejects malformed/unsupported targets without echoing input: %j",
    (input) => {
      expect(() => parseOpenTarget(input)).toThrow(
        "Invalid or unsupported navigation target",
      );
    },
  );
  it("bounds JSON bytes, depth, entries and non-JSON values; copies nested values", () => {
    const page = (params: unknown) => ({
      version: 1,
      kind: "page",
      pluginId: "a",
      pageId: "b",
      route: { version: 1, params },
    });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const params of [
      cycle,
      () => {},
      undefined,
      NaN,
      Infinity,
      new Date(),
      Array(257).fill(1),
      "🐭".repeat(3000),
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, 0])),
    ])
      expect(() => parseOpenTarget(page(params))).toThrow();
    const child = { y: "value" };
    const params = { x: [child] };
    const target = parseOpenTarget(page(params));
    child.y = "changed";
    expect(target.kind === "page" && target.route?.params).toEqual({
      x: [{ y: "value" }],
    });
    expect(() =>
      parseOpenTarget(
        page({
          get secret() {
            throw new Error("SECRET");
          },
        }),
      ),
    ).toThrow("Invalid or unsupported navigation target");
  });
});
it("copies dense arrays without calling caller map/iterator and rejects sparse/getter data", () => {
  const page = (params: unknown) => ({
    version: 1,
    kind: "page",
    pluginId: "a",
    pageId: "b",
    route: { version: 1, params },
  });
  const child = { value: "original" };
  const array = [child];
  Object.defineProperty(array, "map", { value: () => [child] });
  Object.defineProperty(array, Symbol.iterator, {
    value: () => {
      throw new Error("do not call");
    },
  });
  const parsed = parseOpenTarget(page(array));
  child.value = "mutated";
  expect(parsed.kind === "page" && parsed.route?.params).toEqual([
    { value: "original" },
  ]);
  expect(Object.isFrozen(parsed.kind === "page" && parsed.route?.params)).toBe(
    true,
  );
  expect(() => parseOpenTarget(page(Array(1)))).toThrow();
  let getterCalls = 0;
  expect(() =>
    parseOpenTarget({
      get version() {
        getterCalls++;
        return 1;
      },
      kind: "home",
    }),
  ).toThrow();
  expect(() =>
    parseOpenTarget(
      page({
        get value() {
          getterCalls++;
          return "no";
        },
      }),
    ),
  ).toThrow();
  const getterArray = [0];
  Object.defineProperty(getterArray, "0", {
    get() {
      getterCalls++;
      return 1;
    },
  });
  expect(() => parseOpenTarget(page(getterArray))).toThrow();
  expect(getterCalls).toBe(0);
});

it("keeps explicit Personal space distinct from an unspecified page scope", () => {
  const page = {
    version: 1,
    kind: "page",
    pluginId: "a",
    pageId: "b",
  } as const;
  const personal = { ...page, scope: null };
  expect(parseOpenTarget(personal)).toEqual(personal);
  expect(targetKey(personal)).not.toBe(targetKey(page));
  expect(() => parseOpenTarget({ ...conversation, scope: null })).toThrow();
});

it("addresses one installed plugin only within Plugins settings", () => {
  const target = {
    version: 1,
    kind: "settings",
    section: "plugins",
    pluginId: "example.notes",
  };
  expect(parseOpenTarget(target)).toEqual(target);
  expect(() => parseOpenTarget({ ...target, section: "profile" })).toThrow();
  expect(() => parseOpenTarget({ ...target, pluginId: "../bad" })).toThrow();
  expect(() =>
    parseOpenTarget({
      ...target,
      pluginImport: {
        repository: "https://example.com/repo",
        reference: "main",
      },
    }),
  ).toThrow();
});

it("retains copied Git source fields only on the Plugins settings destination", () => {
  const source = {
    repository: "https://github.com/example/plugin",
    reference: "release",
  };
  const target = parseOpenTarget({
    version: 1,
    kind: "settings",
    section: "plugins",
    pluginImport: source,
  });
  source.reference = "changed";
  expect(target).toMatchObject({ pluginImport: { reference: "release" } });
  expect(() => parseOpenTarget({ ...target, section: "profile" })).toThrow();
  expect(() =>
    parseOpenTarget({ ...target, pluginImport: { ...source, enable: true } }),
  ).toThrow();
  const pinned = {
    ...source,
    path: "plugins/one",
    commit: "a".repeat(40),
  };
  expect(parseOpenTarget({ ...target, pluginImport: pinned })).toMatchObject({
    pluginImport: pinned,
  });
  expect(() =>
    parseOpenTarget({ ...target, pluginImport: { ...pinned, path: "../x" } }),
  ).toThrow();
});

const gitSource = {
  repository: "https://github.com/example/plugin",
  reference: "release",
};
it("keeps an optional plugin folder and lowercased commit on a Git source", () => {
  const commit = "A".repeat(40);
  expect(
    parseGitPluginSource({ ...gitSource, path: "plugins/one", commit }),
  ).toEqual({ ...gitSource, path: "plugins/one", commit: "a".repeat(40) });
  expect(
    parseGitPluginSource({ ...gitSource, commit: "b".repeat(64) }),
  ).toEqual({ ...gitSource, commit: "b".repeat(64) });
  expect(parseGitPluginSource(gitSource)).toEqual(gitSource);
  expect(
    Object.isFrozen(parseGitPluginSource({ ...gitSource, path: "x" })),
  ).toBe(true);
  expect(parseGitPluginSource({ ...gitSource, path: "" }).path).toBe(".");
  expect(parseGitPluginSource({ ...gitSource, path: "." }).path).toBe(".");
});

it.each([
  "/abs",
  "../up",
  "a/../b",
  "a/..",
  "a/./b",
  "a//b",
  "a/",
  "a\\b",
  "a\u0000b",
  "a\nb",
  "x".repeat(513),
])("rejects the plugin folder %j", (path) => {
  expect(() => parseGitPluginSource({ ...gitSource, path })).toThrow();
});

it.each([
  "",
  "abc123",
  "a".repeat(39),
  "a".repeat(41),
  "a".repeat(63),
  "g".repeat(40),
  ` ${"a".repeat(40)}`,
])("rejects the pinned commit %j", (commit) => {
  expect(() => parseGitPluginSource({ ...gitSource, commit })).toThrow();
});

it("rejects non-string plugin folders and commits", () => {
  expect(() => parseGitPluginSource({ ...gitSource, path: 1 })).toThrow();
  expect(() => parseGitPluginSource({ ...gitSource, commit: 1 })).toThrow();
  expect(() => parseGitPluginSource({ ...gitSource, path: null })).toThrow();
});

it("bounds plugin link targets to plain string params", () => {
  const link = {
    version: 1,
    kind: "plugin",
    pluginId: "com.example.catalog",
    pageId: "detail",
    params: { slug: "a", tab: "b" },
    scope: { viewer, communityOrigin: "https://relay.example" },
  } as const;
  expect(parseOpenTarget(link)).toEqual(link);
  expect(targetKey({ ...link, params: { tab: "b", slug: "a" } })).toBe(
    targetKey(link),
  );
  const { pageId: _pageId, params: _params, scope: _scope, ...bare } = link;
  expect(parseOpenTarget(bare)).toEqual(bare);
  for (const invalid of [
    { ...bare, pluginId: "Not.Valid" },
    { ...bare, pageId: "" },
    { ...bare, params: { n: 1 } },
    { ...bare, params: { "bad key": "a" } },
    { ...bare, params: { __proto__x: "a" } },
    { ...bare, params: { slug: "x".repeat(1025) } },
    {
      ...bare,
      params: Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"]),
      ),
    },
    { ...bare, params: ["a"] },
    { ...bare, route: { version: 1, params: {} } },
  ])
    expect(() => parseOpenTarget(invalid)).toThrow();
});
