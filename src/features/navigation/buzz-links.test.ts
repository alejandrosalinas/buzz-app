import { expect, it } from "vitest";
import {
  buzzLinkKind,
  buzzLinkTarget,
  isBuzzLink,
  parseBuzzLink,
} from "./buzz-links";
import { deepLinkStep } from "./deep-links";

const scope = {
  viewer: "a".repeat(64),
  communityOrigin: "https://community.example",
};
const example =
  "buzz://message?channel=c89a3185-29c5-40db-8284-054536d98b09&id=9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b";
it("resolves the desktop channel/message alias, including UUID v7 and uppercase event IDs", () => {
  const channelId = "018fdb5d-3a64-7c35-b5f9-4a23e1f9d2d9";
  const href = `buzz://channel/${channelId}/${"B".repeat(64)}`;
  expect(buzzLinkKind(href)).toBe("message");
  expect(buzzLinkTarget(href, scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId,
    messageId: "b".repeat(64),
  });
  expect(
    deepLinkStep(href, {
      viewer: scope.viewer,
      selected: scope.communityOrigin,
    }),
  ).toEqual({ open: buzzLinkTarget(href, scope) });
});
it("recognizes the reported message link and binds it to the receiving community and viewer", () => {
  expect(buzzLinkKind(example)).toBe("message");
  expect(buzzLinkTarget(example, scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "c89a3185-29c5-40db-8284-054536d98b09",
    messageId:
      "9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b",
  });
  expect(buzzLinkKind(`${example}&thread=${"b".repeat(64)}`)).toBe("thread");
});
it("supports channel links and binds them to the receiving community", () => {
  expect(buzzLinkKind("buzz://channel/general")).toBe("channel");
  expect(buzzLinkTarget("buzz://channel/general", scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "general",
  });
});
it("does not treat the retired buzz://open locator as a Buzz link, however well-formed", () => {
  // A JSON navigation target behind `buzz://open?target=` was this app's own
  // in-app locator. It is not a Buzz link form and is now an unknown host.
  const home =
    "buzz://open?target=%7B%22version%22%3A1%2C%22kind%22%3A%22home%22%7D";
  const scoped = `buzz://open?target=%7B%22version%22%3A1%2C%22kind%22%3A%22conversation%22%2C%22scope%22%3A%7B%22communityOrigin%22%3A%22https%3A%2F%2Fother.example%22%7D%2C%22channelId%22%3A%22design%22%2C%22messageId%22%3A%22${"b".repeat(64)}%22%7D`;
  for (const href of [home, scoped]) {
    expect(isBuzzLink(href)).toBe(true);
    expect(parseBuzzLink(href)).toBeNull();
    expect(buzzLinkKind(href)).toBeNull();
    expect(buzzLinkTarget(href, scope)).toBeNull();
  }
});
it("ignores query parameters outside the Buzz link grammar, as the original desktop client does", () => {
  const thread = "b".repeat(64);
  const parsed = {
    format: "legacy",
    channelId: "c89a3185-29c5-40db-8284-054536d98b09",
    messageId:
      "9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b",
  };
  const withUnknown = `${example}&thread=${thread}&foo=bar`;
  expect(parseBuzzLink(withUnknown)).toEqual({
    ...parsed,
    threadRootId: thread,
  });
  expect(buzzLinkKind(withUnknown)).toBe("thread");
  expect(
    deepLinkStep(withUnknown, {
      viewer: scope.viewer,
      selected: scope.communityOrigin,
    }),
  ).toEqual({
    open: {
      version: 1,
      kind: "conversation",
      scope,
      channelId: parsed.channelId,
      messageId: parsed.messageId,
      threadRootId: thread,
    },
  });
  // Unknown keys are dropped with their values and repeats, wherever they sit.
  expect(parseBuzzLink(`${example}&foo=1&foo=2`)).toEqual(parsed);
  expect(parseBuzzLink(`${example}&viewer=${"b".repeat(64)}`)).toEqual(parsed);
  expect(
    parseBuzzLink(
      `buzz://message?foo=bar&channel=${parsed.channelId}&relay=evil&id=${parsed.messageId}`,
    ),
  ).toEqual(parsed);
  // The channel forms carry everything in the path and ignore any query.
  expect(parseBuzzLink("buzz://channel/general?relay=evil")).toEqual({
    format: "legacy",
    channelId: "general",
  });
  expect(parseBuzzLink(`buzz://channel/general/${thread}?foo=bar`)).toEqual({
    format: "legacy",
    channelId: "general",
    messageId: thread,
  });
  // A duplicated known key is ambiguous and still rejects.
  expect(
    parseBuzzLink(`buzz://message?channel=a&channel=b&id=${parsed.messageId}`),
  ).toBeNull();
  expect(parseBuzzLink(`${example}&thread=${thread}&thread=${thread}`)).toBe(
    null,
  );
});
it.each([
  "buzz://channel/",
  "buzz://channel/general/extra",
  "buzz://channel/general/",
  `buzz://channel/general/${"a".repeat(64)}/extra`,
  `buzz://channel/general%2F${"a".repeat(64)}`,
  "buzz://channel/%2Fprivate",
  "buzz://channel/%ZZ",
  "buzz://user@channel/general",
  "buzz://channel:443/general",
  "buzz://join?relay=example",
  "javascript:alert(1)",
])("leaves unsupported or malformed links inert: %s", (href) => {
  expect(parseBuzzLink(href)).toBeNull();
});
it("classifies the buzz scheme case-insensitively, matching URL normalization", () => {
  // The activation boundaries must agree with parseBuzzLink, which normalizes
  // the scheme via `new URL`; a mixed-case link must not fall through to
  // external `_blank` handling.
  expect(isBuzzLink("buzz://channel/general")).toBe(true);
  expect(isBuzzLink("BUZZ://channel/general")).toBe(true);
  expect(isBuzzLink("Buzz://message?channel=general&id=x")).toBe(true);
  expect(isBuzzLink(example)).toBe(true);
  expect(isBuzzLink("https://example.com")).toBe(false);
  expect(isBuzzLink("javascript:alert(1)")).toBe(false);
  expect(isBuzzLink("not a url")).toBe(false);
});

it("accepts the Windows root slash without changing message or thread targets", () => {
  for (const suffix of ["", `&thread=${"b".repeat(64)}`]) {
    const canonical = `${example}${suffix}`;
    const windows = canonical.replace("message?", "message/?");
    expect(parseBuzzLink(windows)).toEqual(parseBuzzLink(canonical));
    expect(buzzLinkTarget(windows, scope)).toEqual(
      buzzLinkTarget(canonical, scope),
    );
    expect(buzzLinkKind(windows)).toBe(suffix ? "thread" : "message");
    expect(parseBuzzLink(windows.replace("buzz:", "BUZZ:"))).toEqual(
      parseBuzzLink(canonical),
    );
  }
});
it.each(["", "/"])("keeps message validation with path %j", (path) => {
  const query = `channel=general&id=${"a".repeat(64)}`;
  for (const url of [
    `buzz://message${path}?${query}&id=${"b".repeat(64)}`,
    `buzz://message${path}?${query}&channel=other`,
    `buzz://message${path}?${query}&thread=${"b".repeat(64)}&thread=${"b".repeat(64)}`,
    `buzz://message${path}?${query}#fragment`,
    `buzz://message:443${path}?${query}`,
    `buzz://user@message${path}?${query}`,
    `buzz://message${path}?channel=general&id=bad`,
    `buzz://message${path}?id=${"a".repeat(64)}`,
    `buzz://message${path}?${query}&thread=bad`,
  ])
    expect(parseBuzzLink(url), url).toBeNull();
});
it.each(["//", "/extra", "/%2F", "/./", "/extra/..", "/%2e/"])(
  "rejects non-root message path %j",
  (path) => {
    expect(
      parseBuzzLink(example.replace("message?", `message${path}?`)),
    ).toBeNull();
  },
);

const pluginRepository = "ssh://git@github.com/example/plugin.git";
const pluginLink = `buzz://plugin-install?repository=${encodeURIComponent(pluginRepository)}&ref=release%2Fstable`;
it("opens Git plugin links in Settings without a community or account", () => {
  const target = {
    version: 1,
    kind: "settings",
    section: "plugins",
    pluginImport: { repository: pluginRepository, reference: "release/stable" },
  };
  expect(buzzLinkKind(pluginLink)).toBe("buzz");
  expect(buzzLinkTarget(pluginLink, scope)).toEqual(target);
  expect(deepLinkStep(pluginLink, { selected: null })).toEqual({
    open: target,
  });
  expect(
    buzzLinkTarget(
      pluginLink.replace("plugin-install?", "plugin-install/?"),
      scope,
    ),
  ).toEqual(target);
  expect(
    buzzLinkTarget(`${pluginLink}&enable=true&enable=false`, scope),
  ).toEqual(target);
});
it.each([
  "buzz://plugin-install",
  `${pluginLink}&ref=other`,
  `${pluginLink}&repository=https://example.com/plugin`,
  pluginLink.replace("plugin-install?", "plugin-install/other?"),
  pluginLink.replace("plugin-install?", "plugin-install/other/../?"),
  ...[
    "file:///tmp/plugin",
    "http://example.com/plugin",
    "https://user:secret@example.com/plugin",
    "https://example.com/plugin?token=secret",
    "https://example.com/plugin#fragment",
  ].map(
    (repository) =>
      `buzz://plugin-install?repository=${encodeURIComponent(repository)}`,
  ),
])("rejects invalid or ambiguous plugin import links: %s", (href) => {
  expect(parseBuzzLink(href)).toBeNull();
  expect(deepLinkStep(href, clientForPluginLink)).toEqual({
    fail: "invalid-target",
  });
});
it("opens Settings links, an agent type's setup included, without a community", () => {
  const link =
    "buzz://settings?section=agents&provider=buzz.claude-code%2Fclaude-code";
  const target = {
    version: 1,
    kind: "settings",
    section: "agents",
    provider: "buzz.claude-code/claude-code",
  };
  expect(buzzLinkKind(link)).toBe("buzz");
  expect(buzzLinkTarget(link, scope)).toEqual(target);
  expect(deepLinkStep(link, { selected: null })).toEqual({ open: target });
  expect(buzzLinkTarget("buzz://settings", scope)).toEqual({
    version: 1,
    kind: "settings",
  });
  expect(buzzLinkTarget("buzz://settings/?section=plugins", scope)).toEqual({
    version: 1,
    kind: "settings",
    section: "plugins",
  });
});
it.each([
  "buzz://settings?provider=buzz.claude-code%2Fclaude-code",
  "buzz://settings?section=agents&section=plugins",
  "buzz://settings?section=Agents!",
  "buzz://settings/other?section=agents",
])("rejects invalid or ambiguous Settings links: %s", (href) => {
  expect(parseBuzzLink(href)).toBeNull();
});
const artifactUrl = "https://artifacts.example.com/plugins/a.json";
const artifactHash = "ab".repeat(32);
const artifactLink = `buzz://plugin-install?id=example.plugin&url=${encodeURIComponent(artifactUrl)}&sha256=${artifactHash.toUpperCase()}`;
it("opens plugin artifact links pinned by SHA-256 in Settings", () => {
  const target = {
    version: 1,
    kind: "settings",
    section: "plugins",
    pluginImport: {
      id: "example.plugin",
      url: artifactUrl,
      sha256: artifactHash,
    },
  };
  expect(buzzLinkTarget(artifactLink, scope)).toEqual(target);
  expect(deepLinkStep(artifactLink, { selected: null })).toEqual({
    open: target,
  });
});
it.each([
  artifactLink.replace(/&sha256=[^&]+/, ""),
  artifactLink.replace(/id=[^&]+&/, ""),
  artifactLink.replace("sha256=", "sha256=00"),
  artifactLink.replace("https%3A", "http%3A"),
  `${artifactLink}&ref=main`,
  `${artifactLink}&url=${encodeURIComponent(artifactUrl)}`,
  `${pluginLink}&sha256=${artifactHash}`,
  `buzz://plugin-install?id=example.plugin&sha256=${artifactHash}&url=${encodeURIComponent(`${artifactUrl}?token=secret`)}`,
])("rejects invalid or ambiguous plugin artifact links: %s", (href) => {
  expect(parseBuzzLink(href)).toBeNull();
});
const commit = "0123456789abcdef0123456789abcdef01234567";
it("carries an optional plugin folder and pinned commit in plugin links", () => {
  const pinned = `${pluginLink}&path=plugins%2Fone&commit=${commit.toUpperCase()}`;
  const target = {
    version: 1,
    kind: "settings",
    section: "plugins",
    pluginImport: {
      repository: pluginRepository,
      reference: "release/stable",
      path: "plugins/one",
      commit,
    },
  };
  expect(buzzLinkTarget(pinned, scope)).toEqual(target);
  expect(deepLinkStep(pinned, { selected: null })).toEqual({ open: target });
  expect(buzzLinkTarget(`${pluginLink}&path=`, scope)).toMatchObject({
    pluginImport: { path: "." },
  });
  expect(buzzLinkTarget(`${pluginLink}&path=.`, scope)).toMatchObject({
    pluginImport: { path: "." },
  });
});
it.each([
  "path=a&path=b",
  `commit=${"a".repeat(40)}&commit=${"b".repeat(40)}`,
  "path=%2Fetc",
  "path=..%2Fx",
  "path=a%2F..%2Fb",
  "path=a%5Cb",
  "path=a%00b",
  "commit=",
  "commit=abc123",
  `commit=${"a".repeat(41)}`,
  `commit=${"g".repeat(40)}`,
])("rejects a plugin link with %s", (query) => {
  const href = `${pluginLink}&${query}`;
  expect(parseBuzzLink(href)).toBeNull();
  expect(deepLinkStep(href, clientForPluginLink)).toEqual({
    fail: "invalid-target",
  });
});
const clientForPluginLink = {
  selected: scope.communityOrigin,
  viewer: scope.viewer,
};

it.each([
  ["git@github.com:org/repo.git", "ssh://git@github.com/org/repo.git"],
  ["github.com/org/repo", "https://github.com/org/repo"],
  ["org/repo", "https://github.com/org/repo"],
])(
  "normalizes a Settings repository address in a plugin link: %s",
  (input, repository) => {
    const href = `buzz://plugin-install?repository=${encodeURIComponent(input)}`;
    const target = {
      version: 1,
      kind: "settings",
      section: "plugins",
      pluginImport: { repository, reference: "" },
    };
    expect(buzzLinkTarget(href, scope)).toEqual(target);
    expect(deepLinkStep(href, { selected: null })).toEqual({ open: target });
  },
);

const plugin = "buzz://plugin?id=com.example.catalog";
it("parses plugin page links into a plugin target bound to the receiving community", () => {
  expect(parseBuzzLink(plugin)).toEqual({
    format: "plugin",
    pluginId: "com.example.catalog",
  });
  expect(buzzLinkKind(plugin)).toBe("buzz");
  expect(buzzLinkTarget(plugin, scope)).toEqual({
    version: 1,
    kind: "plugin",
    pluginId: "com.example.catalog",
    scope,
  });
  const full = `${plugin}&page=detail&route.slug=hello%20world&route.tab=notes`;
  expect(parseBuzzLink(full)).toEqual({
    format: "plugin",
    pluginId: "com.example.catalog",
    pageId: "detail",
    params: { slug: "hello world", tab: "notes" },
  });
  expect(buzzLinkTarget(full, scope)).toEqual({
    version: 1,
    kind: "plugin",
    pluginId: "com.example.catalog",
    pageId: "detail",
    params: { slug: "hello world", tab: "notes" },
    scope,
  });
});
it("treats a plugin link that only overflows once scoped as unopenable", () => {
  const params = (last: number) =>
    [...Array(7)].map((_, i) => `&route.p${i}=${"a".repeat(1024)}`).join("") +
    `&route.last=${"a".repeat(last)}`;
  let last = 1024;
  while (!buzzLinkTarget(plugin + params(last), scope)) last -= 1;
  const link = plugin + params(last);
  expect(buzzLinkTarget(link, scope)).not.toBeNull();
  const wide = {
    ...scope,
    communityOrigin: `https://${"c".repeat(200)}.example`,
  };
  expect(() => buzzLinkTarget(link, wide)).not.toThrow();
  expect(buzzLinkTarget(link, wide)).toBeNull();
});

it("ignores unknown plugin link parameters and accepts the Windows root slash", () => {
  const expected = { format: "plugin", pluginId: "com.example.catalog" };
  expect(parseBuzzLink(`${plugin}&foo=1&foo=2&route=x`)).toEqual(expected);
  expect(parseBuzzLink(plugin.replace("plugin?", "plugin/?"))).toEqual(
    expected,
  );
  expect(parseBuzzLink(plugin.replace("buzz:", "BUZZ:"))).toEqual(expected);
});
it.each([
  "buzz://plugin",
  "buzz://plugin?page=detail",
  "buzz://plugin?id=",
  `${plugin}&id=other`,
  `${plugin}&page=`,
  `${plugin}&page=a&page=b`,
  `${plugin}&route.slug=a&route.slug=b`,
  `${plugin}&route.=a`,
  `${plugin}&route.bad%20key=a`,
  `${plugin}&route.slug=${"x".repeat(1025)}`,
  `${plugin}&${Array.from({ length: 17 }, (_, i) => `route.k${i}=v`).join("&")}`,
  "buzz://plugin?id=Com.Example",
  "buzz://plugin?id=.hidden",
  "buzz://plugin?id=has%20space",
  "buzz://plugin?id=a/b",
  `buzz://plugin?id=${"a".repeat(129)}`,
  `${plugin}&page=Detail`,
  `${plugin}#fragment`,
  `${plugin}&route.__proto__=x`,
  "buzz://plugin:443?id=com.example.catalog",
  "buzz://user@plugin?id=com.example.catalog",
  "buzz://plugin/extra?id=com.example.catalog",
  "buzz://plugin//?id=com.example.catalog",
  "buzz://plugin/./?id=com.example.catalog",
  "buzz://plugins?id=com.example.catalog",
])("rejects a malformed plugin link: %s", (href) => {
  expect(parseBuzzLink(href), href).toBeNull();
  expect(buzzLinkTarget(href, scope)).toBeNull();
});
it("opens an agent card's link as Create agent on the Agents page in the receiving community", () => {
  const href = "buzz://agent/new?card=tinker&utm=qr";
  expect(buzzLinkKind(href)).toBe("buzz");
  const target = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope,
    route: { version: 1, params: { card: "tinker" } },
  };
  expect(buzzLinkTarget(href, scope)).toEqual(target);
  expect(
    deepLinkStep(href, {
      viewer: scope.viewer,
      selected: scope.communityOrigin,
    }),
  ).toEqual({ open: target });
  expect(deepLinkStep(href, { selected: null })).toEqual({
    fail: "unavailable",
  });
  expect(parseBuzzLink("buzz://agent/new?card=av_Abc-123")).toEqual({
    format: "agent-card",
    card: "av_Abc-123",
  });
  for (const invalid of [
    "buzz://agent/new",
    "buzz://agent/new?card=",
    "buzz://agent/new?card=a&card=b",
    "buzz://agent/new?card=..",
    "buzz://agent/new?card=a%2Fb",
    "buzz://agent/new?card=a.b",
    `buzz://agent/new?card=${"a".repeat(65)}`,
    "buzz://agent/edit?card=tinker",
    "buzz://agent/new/extra?card=tinker",
    "buzz://agent/new?card=tinker#x",
  ])
    expect(parseBuzzLink(invalid), invalid).toBeNull();
});
