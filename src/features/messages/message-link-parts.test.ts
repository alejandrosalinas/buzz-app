import { expect, it } from "vitest";
import { messageLinkParts } from "./message-link-parts";

it("recognizes bare and wrapped Buzz channel, message and thread links", () => {
  const urls = [
    "buzz://channel/general",
    `buzz://message?channel=general&id=${"a".repeat(64)}`,
    `buzz://message?channel=general&id=${"a".repeat(64)}&thread=${"b".repeat(64)}`,
  ];
  for (const url of urls) {
    for (const text of [url, `<${url}>`]) {
      const parts = messageLinkParts(`See ${text}.`);
      expect(parts.filter((part) => part.url)).toEqual([{ text: url, url }]);
      expect(parts.map((part) => part.text).join("")).toBe(`See ${url}.`);
    }
  }
});
it("leaves the retired buzz://open locator as plain text, bare or wrapped", () => {
  const locator =
    "buzz://open?target=%7B%22version%22%3A1%2C%22kind%22%3A%22home%22%7D";
  for (const content of [
    `See ${locator}.`,
    `See <${locator}>.`,
    `See [home](${locator}).`,
  ]) {
    const parts = messageLinkParts(content);
    expect(parts.some((part) => part.url)).toBe(false);
    expect(parts.map((part) => part.text).join("")).toBe(content);
  }
});
it("keeps Buzz links with unknown query parameters as links rather than plain text", () => {
  const url = `buzz://message?channel=general&id=${"a".repeat(64)}&foo=bar`;
  for (const text of [url, `<${url}>`, `[Reply](${url})`]) {
    const parts = messageLinkParts(`See ${text}.`);
    expect(parts.filter((part) => part.url).map((part) => part.url)).toEqual([
      url,
    ]);
  }
  expect(
    messageLinkParts("See buzz://channel/general?relay=evil.").filter(
      (part) => part.url,
    ),
  ).toEqual([
    {
      text: "buzz://channel/general?relay=evil",
      url: "buzz://channel/general?relay=evil",
    },
  ]);
});
it("does not turn malformed Buzz addresses into links", () => {
  const content = "<buzz://message?channel=general&id=bad>";
  expect(messageLinkParts(content).some((part) => part.url)).toBe(false);
  expect(
    messageLinkParts(content)
      .map((part) => part.text)
      .join(""),
  ).toBe(content);
});

it("recognizes bare and wrapped URL schemes case-insensitively", () => {
  const urls = ["BUZZ://channel/general", "HTTPS://example.com/docs"];
  for (const url of urls) {
    for (const text of [url, `<${url}>`]) {
      const parts = messageLinkParts(`See ${text}.`);
      expect(parts.filter((part) => part.url)).toEqual([{ text: url, url }]);
      expect(parts.map((part) => part.text).join("")).toBe(`See ${url}.`);
    }
  }
});

it("recognizes credential-free HTTP links for any host shape, but still requires a scheme", () => {
  for (const url of [
    "http://localhost:3000",
    "http://localhost",
    "http://localhost:3000/path",
    "http://127.0.0.1:8080",
    "http://my-host:3000",
    "http://example.com/path",
  ]) {
    const parts = messageLinkParts(`See ${url}.`);
    expect(parts.filter((part) => part.url)).toEqual([{ text: url, url }]);
    expect(parts.map((part) => part.text).join("")).toBe(`See ${url}.`);
  }
  for (const content of [
    "See localhost:3000.",
    "See http://user:pw@localhost:3000/.",
  ]) {
    const parts = messageLinkParts(content);
    expect(parts.some((part) => part.url)).toBe(false);
    expect(parts.map((part) => part.text).join("")).toBe(content);
  }
});

it("removes only paired autolink brackets and preserves surrounding punctuation", () => {
  const parts = messageLinkParts(
    "See <https://drive.google.com/file/d/example>, then <https://example.com/path?q=hello!>.",
  );
  expect(parts.filter((part) => part.url).map((part) => part.url)).toEqual([
    "https://drive.google.com/file/d/example",
    "https://example.com/path?q=hello!",
  ]);
  expect(parts.map((part) => part.text).join("")).toBe(
    "See https://drive.google.com/file/d/example, then https://example.com/path?q=hello!.",
  );
});

it.each([
  "a < b > c",
  "<https://>",
  "<https://example.com",
  "https://example.com>",
  "<javascript:alert(1)>",
])("preserves non-autolink brackets: %s", (content) => {
  expect(
    messageLinkParts(content)
      .map((part) => part.text)
      .join(""),
  ).toBe(content);
});

it("keeps ordinary link punctuation outside the destination and leaves prose available to inline renderers", () => {
  const parts = messageLinkParts(":party: https://example.com. After");
  expect(parts.filter((part) => part.url)).toEqual([
    { text: "https://example.com", url: "https://example.com" },
  ]);
  expect(parts.map((part) => part.text).join("")).toBe(
    ":party: https://example.com. After",
  );
});

it("keeps balanced bare URL delimiters in the decorated range and trims only unmatched closers", () => {
  const balanced = "https://en.wikipedia.org/wiki/Function_(mathematics)";
  const unmatched = "https://example.com/docs)";
  const content = `See ${balanced}, then ${unmatched}.`;
  const ranges: { start: number; end: number; url: string }[] = [];
  const parts = messageLinkParts(content, undefined, (start, end, url) =>
    ranges.push({ start, end, url }),
  );
  expect(parts.filter((part) => part.url)).toEqual([
    { text: balanced, url: balanced },
    {
      text: "https://example.com/docs",
      url: "https://example.com/docs",
    },
  ]);
  expect(ranges.map(({ start, end }) => content.slice(start, end))).toEqual([
    balanced,
    "https://example.com/docs",
  ]);
  expect(parts.map((part) => part.text).join("")).toBe(content);
});

it.each([
  ["https://github.com/block/buzz-app。", "https://github.com/block/buzz-app"],
  ["看这个 https://example.com/spec，大家看一下", "https://example.com/spec"],
  ["（https://example.com）", "https://example.com"],
  ["https://example.com/a?b=c。", "https://example.com/a?b=c"],
  ["https://example.com/path．", "https://example.com/path"],
  ["https://example.com/path［注］", "https://example.com/path"],
  ["他说“https://example.com”。", "https://example.com"],
  ["｢https://example.com｣", "https://example.com"],
  ["https://example.com。大家", "https://example.com"],
  ["https://example.com/a。b", "https://example.com/a"],
  ["https://github。com/block/buzz-app", "https://github。com/block/buzz-app"],
  ["https://github．com:8080/x。", "https://github．com:8080/x"],
  ["http://localhost:3000。OK", "http://localhost:3000"],
  ["https://[::1]。OK", "https://[::1]"],
  ["https:///example.com/x。", "https:///example.com/x"],
  [
    "https://github。com:/block/buzz-app",
    "https://github。com:/block/buzz-app",
  ],
  ["https://github｡com/x。", "https://github｡com/x"],
  [
    "见 https://zh.wikipedia.org/wiki/中文",
    "https://zh.wikipedia.org/wiki/中文",
  ],
])(
  "ends a bare URL at fullwidth punctuation but keeps CJK letters: %s",
  (content, url) => {
    const parts = messageLinkParts(content);
    expect(parts.filter((part) => part.url)).toEqual([{ text: url, url }]);
    expect(parts.map((part) => part.text).join("")).toBe(content);
  },
);

it("ends a bare URL at fullwidth punctuation before another scheme", () => {
  expect(
    messageLinkParts("https://a.com。https://b.com").filter((part) => part.url),
  ).toEqual([
    { text: "https://a.com", url: "https://a.com" },
    { text: "https://b.com", url: "https://b.com" },
  ]);
});

it.each([
  "[this shadcdn/ui clone](https://github.com/duobaseio/forui)",
  "[this shadcdn/ui clone](<https://github.com/duobaseio/forui>)",
  String.raw`[this shadcdn/ui clone]\(https://github.com/duobaseio/forui\)`,
  String.raw`[this shadcdn/ui clone]\([https://github.com/duobaseio/forui](https://github.com/duobaseio/forui))`,
])("renders a labeled link without exposing wrappers: %s", (link) => {
  const parts = messageLinkParts(`See ${link}. Thanks!`);
  expect(parts.filter((part) => part.url)).toEqual([
    {
      text: "this shadcdn/ui clone",
      label: "this shadcdn/ui clone",
      url: "https://github.com/duobaseio/forui",
    },
  ]);
  expect(parts.map((part) => part.text).join("")).toBe(
    "See this shadcdn/ui clone. Thanks!",
  );
});

it("keeps balanced and escaped URL parentheses inside labeled destinations", () => {
  for (const link of [
    "[Docs](https://example.com/wiki/Function_(math))",
    String.raw`[Docs](https://example.com/wiki/Function_\(math\))`,
  ]) {
    expect(messageLinkParts(link).filter((part) => part.url)).toEqual([
      {
        text: "Docs",
        label: "Docs",
        url: "https://example.com/wiki/Function_(math)",
      },
    ]);
  }
});

it.each([
  '[Docs](https://example.com "Guide")',
  "[Docs](https://example.com 'Guide')",
  "[Docs](https://example.com (Guide))",
  '[Docs](<https://example.com> "Guide")',
])(
  "separates a Markdown title from its labeled link destination: %s",
  (link) => {
    const ranges: { start: number; end: number; url: string }[] = [];
    const parts = messageLinkParts(link, undefined, (start, end, url) =>
      ranges.push({ start, end, url }),
    );
    expect(parts.filter((part) => part.url)).toEqual([
      { text: "Docs", label: "Docs", url: "https://example.com" },
    ]);
    expect(ranges).toEqual([
      { start: 0, end: link.length, url: "https://example.com" },
    ]);
  },
);

it("supports Buzz labels, escaped label punctuation, and multiple links in prose", () => {
  const parts = messageLinkParts(
    String.raw`Ask [design](buzz://channel/design), then [Docs \[new\]](https://example.com/docs).`,
  );
  expect(parts.filter((part) => part.url)).toEqual([
    { text: "design", label: "design", url: "buzz://channel/design" },
    {
      text: "Docs [new]",
      label: "Docs [new]",
      url: "https://example.com/docs",
    },
  ]);
  expect(parts.map((part) => part.text).join("")).toBe(
    "Ask design, then Docs [new].",
  );
});

it.each([
  "[unsafe](javascript:alert(1))",
  "[bad](buzz://message?channel=general&id=bad)",
  "[unfinished](https://example.com",
  "[not a link] (just prose)",
])("preserves unsupported or unfinished syntax: %s", (content) => {
  expect(
    messageLinkParts(content)
      .map((part) => part.text)
      .join(""),
  ).toBe(content);
});

it("bounds repeated unfinished wrappers while retaining a later valid link", () => {
  for (const prefix of [
    "[".repeat(80_000),
    String.raw`\[`.repeat(40_000),
    "[x](".repeat(20_000),
    String.raw`[x]\(`.repeat(16_000),
  ]) {
    const parts = messageLinkParts(
      `${prefix} [Docs](https://example.com/docs)`,
    );
    expect(parts.filter((part) => part.url)).toEqual([
      { text: "Docs", label: "Docs", url: "https://example.com/docs" },
    ]);
    expect(parts.map((part) => part.text).join("")).toBe(`${prefix} Docs`);
  }
});

it("recognizes bare, wrapped and labelled plugin page links, and not malformed ones", () => {
  const url =
    "buzz://plugin?id=com.example.catalog&page=detail&route.slug=hello";
  for (const text of [url, `<${url}>`, `[Open](${url})`]) {
    const parts = messageLinkParts(`See ${text}.`);
    expect(parts.filter((part) => part.url).map((part) => part.url)).toEqual([
      url,
    ]);
  }
  const malformed = "<buzz://plugin?id=Not.Valid>";
  expect(messageLinkParts(malformed).some((part) => part.url)).toBe(false);
});
