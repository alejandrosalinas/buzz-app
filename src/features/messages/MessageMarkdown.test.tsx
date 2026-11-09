// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { renderToStaticMarkup } from "react-dom/server";
import { LockIcon, RobotIcon } from "../../shared/design-system/icons/index";
import referenceStyles from "../../shared/InlineReference.module.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type {
  CodeBlockRenderer,
  ConversationExtensions,
  InlineRenderer,
} from "../conversation/contracts";
import type { Contribution } from "../../plugins/contributions";
import { CustomEmoji } from "../../bundled/emoji/CustomEmoji";
import { emojiMatches } from "../relay/emoji";
import { profileKey, profileTarget } from "../profiles/target";
import { parseBuzzLink } from "../navigation/buzz-links";
import styles from "./Messages.module.css";
import { LinkLabel } from "../../bundled/links/InlineLink";
import { MessageMarkdown } from "./MessageMarkdown";
import { serializeSelection } from "./selection-copy";
import { buzzCopyDocument } from "./composer-clipboard";
import { projectComposerDocument } from "./composer-document";
import { createRelaySession } from "../relay/session";
import { createAgentDirectory } from "../identity-names/testing";
import { bindNames } from "../identity-names/service";
import {
  MAX_MARKDOWN_LENGTH,
  safeLinkUrl,
  safeMessageUrl,
} from "../relay/message-content";
import type { ChannelMessage, Profile } from "../relay/contracts";

const markdownRenders = vi.hoisted(() => vi.fn());
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    // Hook-free, so the returned elements are the parse a caller keeps.
    default: (properties: ComponentProps<typeof actual.default>) => {
      markdownRenders();
      return actual.default(properties);
    },
  };
});

const mic = "b".repeat(64),
  smith = "a".repeat(64),
  other = "c".repeat(64);
const profiles = new Map([
  [mic, { name: "Mic" }],
  [smith, { name: "Mic Smith" }],
  [other, { name: "Other" }],
]);
type RenderOptions = Partial<
  Omit<ComponentProps<typeof MessageMarkdown>, "row">
> & {
  emoji?: ChannelMessage["emoji"];
  patch?: Partial<ChannelMessage>;
};
function props(
  content: string,
  { emoji = [], patch, ...options }: RenderOptions = {},
): ComponentProps<typeof MessageMarkdown> {
  return {
    row: {
      id: "message",
      channelId: "channel",
      authorId: "author",
      content,
      createdAt: 1,
      mentions: [mic, smith],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      emoji,
      ...patch,
    },
    media: () => undefined,
    onOpenLink: () => false,
    canOpenLink: (target) => !!profileKey(target) || !!parseBuzzLink(target),
    participantProfiles: profiles,
    ...options,
  };
}
function render(content: string, options: RenderOptions = {}) {
  return renderToStaticMarkup(<MessageMarkdown {...props(content, options)} />);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("admits registered panel links from cached Markdown and rechecks activation", () => {
  const target = "example-plugin://task/123";
  let installed = false;
  const onOpenLink = vi.fn(() => true);
  const canOpenLink = (value: string) => installed && value === target;
  const content = `[Task](${target}) [Unsafe](https://user:secret@example.test)`;
  const draw = () => (
    <MessageMarkdown {...props(content, { canOpenLink, onOpenLink })} />
  );
  const view = renderDom(draw());
  expect(screen.queryByRole("link")).toBeNull();
  installed = true;
  view.rerender(draw());
  const link = screen.getByRole("link", { name: "Task" });
  expect(link).toHaveAttribute("href", target);
  const selection = document.getSelection() as Selection;
  const range = document.createRange();
  range.selectNodeContents(link);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(serializeSelection(selection, "text")).toBe(`Task (${target})`);
  expect(serializeSelection(selection, "markdown")).toBe(`[Task](${target})`);
  const pasted = buzzCopyDocument(
    `<div data-buzz-copy="timeline">${serializeSelection(selection, "html")}</div>`,
  );
  expect(pasted && projectComposerDocument(pasted).draft.text).toBe(
    `[Task](${target})`,
  );
  selection.removeAllRanges();
  fireEvent.click(link, { ctrlKey: true });
  expect(onOpenLink).toHaveBeenCalledWith(target);
  expect(link).toHaveFocus();
  onOpenLink.mockClear();
  installed = false;
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(onOpenLink).not.toHaveBeenCalled();
  view.rerender(draw());
  expect(screen.queryByRole("link")).toBeNull();
  installed = true;
  view.rerender(draw());
  fireEvent.click(screen.getByRole("link", { name: "Task" }));
  expect(onOpenLink).toHaveBeenCalledOnce();
});

const party = {
  shortcode: "party_parrot",
  url: "https://emoji.test/party.png",
};
const emojiRenderer: Contribution<InlineRenderer> = {
  id: "emoji",
  key: "test/emoji",
  pluginId: "test",
  revision: "1",
  title: "Emoji",
  matches: ({ text, message }) => [...emojiMatches(text, message.emoji ?? [])],
  component: ({ media }) => <CustomEmoji emoji={party} media={media} />,
};
const pluginRenderer: Contribution<InlineRenderer> = {
  id: "word",
  key: "test/word",
  pluginId: "test",
  revision: "1",
  title: "Word",
  matches: ({ text }) =>
    [...text.matchAll(/PLUGIN/g)].map((match) => ({
      start: match.index,
      end: match.index + 6,
    })),
  component: ({ text }) => <mark>{text}</mark>,
};
const inlineRenderers = [emojiRenderer, pluginRenderer] as const;
const extensions: ConversationExtensions = {
  tools: { snapshot: () => [], subscribe: () => () => {} },
  inline: {
    snapshot: () => inlineRenderers,
    subscribe: () => () => {},
  },
};

describe("MessageMarkdown", () => {
  it("renders compact CommonMark and GFM structure with chat line breaks", () => {
    const html = render(`# Heading
first
second

- one
- two

~~done~~

> quote

| A | B |
| - | - |
| 1 | 2 |

- [x] checked`);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("first<br/>\nsecond");
    expect(html).toContain("<ul>");
    expect(html).toContain("<del>done</del>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox" disabled="" checked=""');
  });

  it("renders inline and fenced code without parsing markdown inside it", () => {
    const html = render("`**literal** :party:`\n\n```ts\nconst x = 1\n```");
    expect(html).toContain("<code>**literal** :party:</code>");
    expect(html).toContain('<code class="language-ts">const x = 1');
    expect(html).not.toContain("<strong>literal</strong>");
  });

  it("keeps raw HTML inert and never renders markdown images", () => {
    const html = render(
      '<script>alert("x")</script>\n\nbefore <b>raw</b> ![remote alt](https://images.test/a.png)',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("before &lt;b&gt;raw&lt;/b&gt;");
    expect(html).toContain("remote alt");
  });

  it("shows angle-bracket prose as the exact typed text", () => {
    expect(render("<harness stuff goes here>")).toContain(
      "<p>&lt;harness stuff goes here&gt;</p>",
    );
    expect(render("run the <harness> now")).toContain(
      "<p>run the &lt;harness&gt; now</p>",
    );
    expect(render("**<harness>** and _<b>x</b>_")).toContain(
      "<strong>&lt;harness&gt;</strong> and <em>&lt;b&gt;x&lt;/b&gt;</em>",
    );
    const block = render(
      '<div onclick="x()">\n**not bold** :party:\n</div>\n\n<!-- note -->',
    );
    expect(block).toContain(
      "<p>&lt;div onclick=&quot;x()&quot;&gt;<br/>\n**not bold** :party:<br/>\n&lt;/div&gt;</p>",
    );
    expect(block).not.toContain("note");
    expect(block).not.toContain("<div onclick");
    expect(block).not.toContain("<strong>");
  });

  it("hides complete HTML comments, such as Buzz Desktop's wave marker", () => {
    const wave = render("<!-- buzz:wave:v1 -->\nLogan waved at you.");
    expect(wave).toContain("<p>Logan waved at you.</p>");
    expect(wave).not.toContain("buzz:wave");
    expect(render("a <!-- hidden --> b")).toContain("<p>a  b</p>");
    expect(render("<!-- x --> <harness>")).toContain("<p> &lt;harness&gt;</p>");
    expect(render("an <!-- unclosed comment")).toContain(
      "<p>an &lt;!-- unclosed comment</p>",
    );
  });

  it.each([
    [
      "<div><!<!-- hidden -->-- visible --></div>",
      "<div><!-- visible --></div>",
    ],
    [
      "<div><scr<!-- hidden -->ipt>alert(1)</script></div>",
      "<div><script>alert(1)</script></div>",
    ],
  ])(
    "renders syntax joined by comment removal as literal text: %s",
    (source, text) => {
      const { container } = renderDom(<MessageMarkdown {...props(source)} />);
      expect(container.textContent).toBe(text);
      expect(container.querySelector("script")).toBeNull();
    },
  );

  it("allows credential-free HTTP(S) links and makes other destinations non-clickable", () => {
    expect(safeLinkUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
    expect(safeLinkUrl("http://example.com")).toBe("http://example.com/");
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///tmp/x",
      "/relative",
      "https://user:secret@example.com",
      "http://user:secret@example.com",
    ])
      expect(safeLinkUrl(url)).toBeUndefined();
    // Projected attachments keep the stricter HTTPS-only rule.
    expect(safeMessageUrl("https://example.com")).toBe("https://example.com/");
    expect(safeMessageUrl("http://example.com")).toBeUndefined();

    const safe = render("[Example](https://example.com/path)");
    expect(safe).toContain('href="https://example.com/path"');
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener noreferrer"');
    expect(safe).toContain('title="https://example.com/path"');

    const unsafe = render("[bad](javascript:alert(1)) [local](/relative)");
    expect(unsafe).not.toContain("<a");
    expect(unsafe).toContain("bad");
    expect(unsafe).toContain("local");
  });

  it("links plain HTTP URLs with sentence punctuation left outside the anchor", () => {
    expect(render("See http://localhost:3000 now")).toContain(
      '<a href="http://localhost:3000/"',
    );
    const sentence = render("see http://localhost:3000.");
    expect(sentence).toContain('href="http://localhost:3000/"');
    expect(sentence).toContain(">http://localhost:3000</a>.");
  });

  it("falls back to literal text before recursively rendering deeply nested inbound content", () => {
    const html = render(`${"> ".repeat(20_000)}**literal deep message**`);
    expect(html).toContain("**literal deep message**");
    expect(html).not.toContain("<blockquote>");
    expect(html).not.toContain("<strong>");
  });

  it("falls back to literal text for exceptionally large inbound content", () => {
    const html = render(`${"a".repeat(100_001)} **not parsed**`);
    expect(html).toContain("**not parsed**");
    expect(html).not.toContain("<strong>");
  });
});

describe("mounted Markdown preparation", () => {
  it("updates live plugin, media, directory, and interactivity inputs without reparsing", () => {
    const metadataRenderer: Contribution<InlineRenderer> = {
      id: "metadata",
      key: "test/metadata",
      pluginId: "test",
      revision: "1",
      title: "Metadata",
      matches: ({ text }) =>
        text === "PLUGIN" ? [{ start: 0, end: text.length }] : [],
      component: ({ content, media }) => (
        <mark>{`${content.message.replyCount}:${media("asset") ?? "none"}`}</mark>
      ),
    };
    const metadataRenderers = [metadataRenderer] as const;
    const liveExtensions: ConversationExtensions = {
      ...extensions,
      inline: {
        snapshot: () => metadataRenderers,
        subscribe: () => () => {},
      },
    };
    const url = "buzz://channel/design";
    const initial = props(`<${url}>\n\nPLUGIN`, {
      extensions: liveExtensions,
      media: () => "first-media",
      directory: {
        profiles: new Map(),
        agents: [],
        named: [],
        channels: [{ id: "design", name: "first", channelType: "forum" }],
      },
    });
    const view = renderDom(<MessageMarkdown {...initial} />);
    const initialRenders = markdownRenders.mock.calls.length;
    expect(screen.getByRole("link", { name: "#first" })).toBeInTheDocument();
    expect(screen.getByText("0:first-media")).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, replyCount: 7 }}
        media={() => "second-media"}
        interactive={false}
        directory={{
          profiles: new Map(),
          agents: [],
          named: [],
          channels: [{ id: "design", name: "second", channelType: "forum" }],
        }}
      />,
    );
    expect(markdownRenders).toHaveBeenCalledTimes(initialRenders);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("#second")).toBeInTheDocument();
    expect(screen.getByText("7:second-media")).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, replyCount: 8 }}
        extensions={undefined}
      />,
    );
    expect(markdownRenders).toHaveBeenCalledTimes(initialRenders);
    expect(screen.queryByText("7:second-media")).not.toBeInTheDocument();
    expect(screen.getByText("PLUGIN")).toBeInTheDocument();
  });

  it("invalidates protected prose when live identity and security inputs change", () => {
    const initial = props("@Mic and @Renamed", {
      patch: { mentions: [mic] },
      participantProfiles: new Map([[mic, { name: "Mic" }]]),
    });
    const view = renderDom(<MessageMarkdown {...initial} />);
    expect(
      screen.getByRole("button", { name: "View Mic profile" }),
    ).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        participantProfiles={new Map([[mic, { name: "Renamed" }]])}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "View Mic profile" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View Renamed profile" }),
    ).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, edited: true }}
        participantProfiles={new Map([[mic, { name: "Renamed" }]])}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, attachmentSeams: [12] }}
        participantProfiles={new Map([[mic, { name: "Renamed" }]])}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("invalidates event-local emoji bindings without retaining stale media", () => {
    const initial = props(":party_parrot:", {
      emoji: [party],
      extensions,
      media: () => "https://media.test/first.png",
    });
    const view = renderDom(<MessageMarkdown {...initial} />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://media.test/first.png",
    );

    view.rerender(
      <MessageMarkdown
        {...initial}
        row={{ ...initial.row, emoji: [] }}
        media={() => "https://media.test/stale.png"}
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(":party_parrot:")).toBeInTheDocument();
  });

  it("reuses a remounted body's parse while each row reads its own inputs", () => {
    const directory = (name: string) => ({
      profiles: new Map(),
      agents: [],
      named: [],
      channels: [{ id: "design", name, channelType: "forum" as const }],
    });
    const content = "<buzz://channel/design> **revisited**";
    const first = renderDom(
      <MessageMarkdown
        {...props(content, { directory: directory("first") })}
      />,
    );
    const parses = markdownRenders.mock.calls.length;
    first.unmount();

    renderDom(
      <>
        <MessageMarkdown
          {...props(content, { directory: directory("second") })}
        />
        <MessageMarkdown
          {...props(content, { directory: directory("third") })}
        />
      </>,
    );
    expect(markdownRenders).toHaveBeenCalledTimes(parses);
    expect(screen.getByRole("link", { name: "#second" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#third" })).toBeInTheDocument();
    expect(screen.getAllByText("revisited")[0]?.tagName).toBe("STRONG");
  });

  it("parses a body again once many newer bodies have replaced it", () => {
    render("**evicted**");
    const parses = markdownRenders.mock.calls.length;
    render("**evicted**");
    expect(markdownRenders).toHaveBeenCalledTimes(parses);

    for (let index = 0; index < 100; index++)
      render(`${index} ${"*newer* ".repeat(40)}`);
    const newer = markdownRenders.mock.calls.length;
    expect(render("**evicted**")).toContain("<strong>evicted</strong>");
    expect(markdownRenders).toHaveBeenCalledTimes(newer + 1);
  });

  it("weighs long bodies by their length, not only their elements", () => {
    render("**evicted**");
    const words = "word ".repeat(19_000);
    for (let index = 0; index < 25; index++) render(`${index} ${words}`);
    const newer = markdownRenders.mock.calls.length;
    render("**evicted**");
    expect(markdownRenders).toHaveBeenCalledTimes(newer + 1);
  }, 20_000);

  it("does not keep a body heavier than the whole cache", () => {
    render("**kept**");
    const huge = "*dense* ".repeat(5_000);
    render(huge);
    const parses = markdownRenders.mock.calls.length;
    render("**kept**");
    expect(markdownRenders).toHaveBeenCalledTimes(parses);
    render(huge);
    expect(markdownRenders).toHaveBeenCalledTimes(parses + 1);
  });

  it("crosses long and deep fallback boundaries after mount", () => {
    const view = renderDom(<MessageMarkdown {...props("**parsed**")} />);
    expect(screen.getByText("parsed").tagName).toBe("STRONG");

    view.rerender(
      <MessageMarkdown
        {...props(`${"a".repeat(MAX_MARKDOWN_LENGTH + 1)} **literal**`)}
      />,
    );
    expect(screen.getByText(/\*\*literal\*\*/)).toBeInTheDocument();

    view.rerender(
      <MessageMarkdown {...props(`${"> ".repeat(20_000)}**deep**`)} />,
    );
    expect(screen.getByText(/\*\*deep\*\*/)).toBeInTheDocument();

    view.rerender(<MessageMarkdown {...props("**parsed again**")} />);
    expect(screen.getByText("parsed again").tagName).toBe("STRONG");
  });
});

describe("Markdown profile mentions", () => {
  it("rebinds mounted prose when a verified alias changes under the same name", () => {
    const person = (fullName: string) =>
      new Map([
        [
          mic,
          {
            name: "reader",
            verified: { displayName: "reader", fullName },
          } as Profile,
        ],
      ]);
    const initial = props("@Reader Example and @Reader Updated", {
      participantProfiles: person("Reader Example"),
    });
    const view = renderDom(<MessageMarkdown {...initial} />);
    const bound = () =>
      screen.queryAllByRole("button").map((button) => button.textContent);
    expect(bound()).toEqual(["Reader Example"]);
    view.rerender(
      <MessageMarkdown
        {...initial}
        participantProfiles={person("Reader Updated")}
      />,
    );
    expect(bound()).toEqual(["Reader Updated"]);
  });

  it("binds exact signed names longest-first through surrounding emphasis", () => {
    const html = render("**@Mic Smith**, _@Mic_! @Other @Missing @Microscopic");
    expect(html).toContain("<strong><button");
    expect(html).toContain('aria-label="View Mic Smith profile"');
    expect(html).toContain("</svg>M</span>ic Smith</button></strong>");
    // The raw helper conservatively treats trailing underscore as a name suffix.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("<em>@Mic</em>");
    const emphasized = render("*@Mic* ~~@Mic Smith~~");
    expect(emphasized).toContain("<em><button");
    expect(emphasized).toContain("<del><button");
  });

  it("keeps Markdown punctuation within a signed display name exact", () => {
    const name = "M*ic* _Smith_ :party_parrot:";
    const html = render(`**@${name}**`, {
      participantProfiles: new Map([[mic, { name }]]),
      emoji: [party],
      extensions,
    });
    expect(html).toContain(`aria-label="View ${name} profile"`);
    expect(html).toContain(`</svg>M</span>${name.slice(1)}</button></strong>`);
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<img");
  });

  it.each(["Mic `code`", "Mic [link](https://example.test)"])(
    "never lets a matching profile name consume non-prose: %s",
    (name) => {
      const html = render(`@${name}`, {
        participantProfiles: new Map([[mic, { name }]]),
      });
      expect(html).not.toContain("<button");
      expect(html).toMatch(/<code>|<a /);
    },
  );

  it("focuses the clicked mention before opening its exact profile target", () => {
    const calls: string[] = [];
    const canOpenLink = vi.fn((_target: string) => true);
    renderDom(
      <MessageMarkdown
        {...props("**@Mic Smith** then @Mic", {
          canOpenLink,
          onOpenLink: (target) => {
            expect(document.activeElement).toBe(
              target === profileTarget(smith) ? buttons[0] : buttons[1],
            );
            calls.push(target);
            return true;
          },
        })}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      const focus = button.focus.bind(button);
      vi.spyOn(button, "focus").mockImplementation(() => {
        calls.push("focus");
        focus();
      });
      fireEvent.click(button);
    }
    expect(calls).toEqual([
      "focus",
      profileTarget(smith),
      "focus",
      profileTarget(mic),
    ]);
    expect(canOpenLink.mock.calls.map(([target]) => target)).toEqual([
      profileTarget(smith),
      profileTarget(mic),
    ]);
  });

  it.each([
    "`https://example.test @Mic`",
    "`` a ` @Mic ``",
    "```ts\n@Mic\n```",
    "~~~\n@Mic\n~~~",
    "`unfinished @Mic",
    "```\n@Mic",
    "    @Mic",
    "\t@Mic",
    "intro\n    @Mic",
    "email@Mic",
    "https://example.test/@Mic",
    "http://example.test/@Mic",
    "[label @Mic](https://example.test)",
    "![alt @Mic](https://example.test)",
    "[@Mic][reference]\n\n[reference]: https://example.test",
    "[@Mic][]\n\n[@Mic]: https://example.test",
    "[@Mic]\n\n[@Mic]: https://example.test",
    "[**@Mic**](https://example.test)",
    "<https://example.test/@Mic>",
    "www.example.test/@Mic",
    "\\@Mic",
    "&#64;Mic",
    "@M&#105;c",
    "@Mic_foo",
    "@Micé",
    `@Mic (${other})`,
  ])(
    "does not create profile controls from excluded raw context: %s",
    (content) => {
      const html = render(content);
      expect(html).not.toContain("data-mention-kind");
      expect(html).not.toMatch(/[\uE000-\uE002]/);
    },
  );

  it.each([
    "`https://example.test @Mic` then @Mic",
    "    @Mic\n\nOutside @Mic",
    "intro\n    @Mic\nOutside @Mic",
    '```js\nconst marker = "```";\n@Mic\n```\nOutside @Mic',
    "````\n```\n@Mic\n````\nOutside @Mic",
  ])(
    "evaluates full-body exclusions while retaining subsequent prose: %s",
    (content) => {
      const html = render(content);
      expect(html.match(/aria-label="View Mic profile"/g)).toHaveLength(1);
      expect(html.lastIndexOf("<button")).toBeGreaterThan(html.indexOf("@Mic"));
    },
  );

  it.each<[string, RenderOptions]>([
    ["no opener", { canOpenLink: undefined }],
    ["a refusing opener", { canOpenLink: () => false }],
  ])("renders mentions as inert names with %s", (_, options) => {
    const html = render("**@Mic**", options);
    expect(html).not.toContain("<button");
    expect(html).toContain('data-mention-kind="person"');
    expect(html).toContain('data-mention-name="Mic"');
  });

  it("does not rebind edited, untagged, unknown or ambiguous names", () => {
    const unavailable: RenderOptions[] = [
      { patch: { edited: true } },
      { patch: { mentions: [] } },
      { participantProfiles: undefined },
      {
        patch: { mentions: [mic, other] },
        participantProfiles: new Map([
          [mic, { name: "Mic" }],
          [other, { name: "Mic" }],
        ]),
      },
    ];
    for (const options of unavailable) {
      const html = render("**@Mic**", options);
      expect(html).not.toContain("<button");
      expect(html).toContain("<strong>@Mic</strong>");
    }
    const html = render("@Mic Smith and @Mic", {
      patch: { mentions: [smith, mic, other] },
      participantProfiles: new Map([
        [smith, { name: "Mic Smith" }],
        [mic, { name: "Mic" }],
        [other, { name: "Mic Smith" }],
      ]),
    });
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("@Mic Smith and <button");
  });

  it("updates a mounted mention label without changing signed binding or profile target", () => {
    const owned = createRelaySession(null);
    const session = owned.session;
    const listeners = new Set<() => void>();
    let localName = "Local Mic";
    const provider = createAgentDirectory();
    const names = bindNames(
      {
        profiles: session.profiles,
        agentLibrary: {
          snapshot: () => ({
            status: "ready",
            definitions: [],
            identities: [{ id: "mic", pubkey: mic, name: localName }],
          }),
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          refresh: async () => {},
          retain: () => () => {},
        },
      },
      { snapshot: () => [provider], subscribe: () => () => {} },
    );
    const open = vi.fn(() => true);
    const mounted = renderDom(
      <MessageMarkdown
        {...props("@Mic and @Local Mic", {
          session: { ...session, names },
          onOpenLink: open,
        })}
      />,
    );
    const button = mounted.getByRole("button", {
      name: "View Local Mic profile",
    });
    expect(mounted.getAllByRole("button")).toHaveLength(1);
    act(() => {
      localName = "Renamed Mic";
      for (const notify of listeners) notify();
    });
    expect(
      mounted.getByRole("button", { name: "View Renamed Mic profile" }),
    ).toBe(button);
    expect(button.textContent).toBe("Renamed Mic");
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith(profileTarget(mic));
    expect(profiles.get(mic)?.name).toBe("Mic");
    mounted.unmount();
    names.dispose();
    owned.dispose();
  });

  it("preserves authored punctuation markers without creating extra profile controls", () => {
    const literal = "\uFFFC0\uE0010\uFFFC";
    const encoded = "&#65532;1&#57345;0&#65532;";
    const html = render(literal + " " + encoded + " then @Mic");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(
      "\uFFFC0\uE0010\uFFFC \uFFFC1\uE0010\uFFFC then <button",
    );
    expect(render(literal + " " + encoded)).not.toContain("<button");
  });

  it("cannot fabricate profile controls with literal, entity-encoded or legacy markers", () => {
    const spoof =
      "\uE0000\uE0010\uE002 &#57344;&#49;&#57345;0&#57346; \uE000&#x32;\uE0010\uE002 \uE0000\uE001";
    const html = render(`${spoof} then @Mic`);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(
      "\uE0000\uE0010\uE002 \uE0001\uE0010\uE002 \uE0002\uE0010\uE002 \uE0000\uE001 then <button",
    );
    expect(render(spoof)).not.toContain("<button");
    expect(
      render(
        `<span data-inline-text="@Mic" data-profile-target="${profileTarget(mic)}">spoof</span>`,
      ),
    ).not.toContain("<button");
  });
});

describe("Markdown inline extensions", () => {
  it("preserves custom emoji and plugin prose alongside profile mentions", () => {
    const html = render("**:party_parrot:** PLUGIN @Mic", {
      emoji: [party],
      extensions,
      media: () => "https://media.test/emoji.png",
    });
    expect(html).toContain("<strong><img");
    expect(html).toContain('src="https://media.test/emoji.png"');
    expect(html).toContain('alt=":party_parrot:"');
    expect(html).toContain("<mark>PLUGIN</mark>");
    expect(html).toContain('aria-label="View Mic profile"');
  });

  it("keeps links, code, reference labels and image alt text out of inline plugins", () => {
    const html = render(
      "`:party_parrot: PLUGIN @Mic`\n\n```\n:party_parrot: PLUGIN @Mic\n```\n\n[:party_parrot: PLUGIN @Mic](https://example.test)\n\n[:party_parrot: PLUGIN @Mic]\n\n[:party_parrot: PLUGIN @Mic]: https://example.test/ref\n\n![PLUGIN :party_parrot: @Mic](https://example.test/image)",
      {
        emoji: [party],
        extensions,
        media: () => "https://media.test/emoji.png",
      },
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<mark");
    expect(html).not.toContain("data-mention-kind");
    expect(html).not.toMatch(/[\uE000-\uE002]/);
    expect(html).toContain('href="https://example.test/ref"');
    expect(html).toContain(":party_parrot: PLUGIN @Mic</code>");
    expect(html).toContain("PLUGIN :party_parrot: @Mic</span>");
  });

  it("renders a message ending in a bare Buzz link without duplicate React keys", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const content = "see buzz://channel/x";
    const { container } = renderDom(
      <MessageMarkdown {...props(content, { extensions })} />,
    );
    expect(container.textContent).toBe(content);
    expect(
      error.mock.calls.filter((call) => String(call[0]).includes("same key")),
    ).toEqual([]);
  });

  it.each(["http", "https"])(
    "keeps emoji shortcodes and encoded punctuation verbatim inside bare %s links",
    (scheme) => {
      const url = `${scheme}://a.test/:party_parrot:/&#58;x`;
      const html = render(url, {
        emoji: [party],
        extensions,
        media: () => "https://media.test/emoji.png",
      });
      expect(html).not.toContain("<img");
      expect(html).toContain(`>${url.replaceAll("&", "&amp;")}</a>`);
    },
  );

  it.each([
    [
      "https://github.com/block/buzz-app。",
      "https://github.com/block/buzz-app",
    ],
    ["看这个 https://example.com/spec，大家看一下", "https://example.com/spec"],
    ["（https://example.com）", "https://example.com/"],
    ["他说“https://example.com/a”。", "https://example.com/a"],
    [
      "https://github。com/block/buzz-app。",
      "https://github.com/block/buzz-app",
    ],
    ["http://localhost:3000。OK", "http://localhost:3000/"],
    [
      "https://zh.wikipedia.org/wiki/中文 ok",
      "https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87",
    ],
    ["<https://example.com/a。>", "https://example.com/a%E3%80%82"],
    [
      "https://a.com，https://zh.wikipedia.org/wiki/中文",
      "https://a.com/",
      "https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87",
    ],
  ])("ends a bare link at fullwidth punctuation: %s", (content, ...hrefs) => {
    const html = render(content);
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(
      hrefs,
    );
    expect(html.replace(/<[^>]*>/g, "")).toBe(
      content.replace(/^<(.*)>$/, "$1"),
    );
  });

  it("keeps emoji-only sizing and readable fallback when media or extensions are unavailable", () => {
    const options = { emoji: [party], extensions, largeEmoji: true };
    const html = render(":party_parrot:", {
      ...options,
      media: () => "https://media.test/emoji.png",
    });
    expect(html).toContain(
      `class="${styles.text}" data-single-emoji="true"><img`,
    );
    expect(html).not.toContain("<div");
    expect(render(":party_parrot:", options)).toContain(
      'data-single-emoji="true">:party_parrot:</p>',
    );
    expect(
      render(":party_parrot:", { ...options, extensions: undefined }),
    ).toContain('data-single-emoji="true">:party_parrot:</p>');
    expect(render("😀", { largeEmoji: true })).toContain(
      'data-single-emoji="true">😀</p>',
    );
  });
});

it.each([false, true])(
  "retains formatting inside labeled links (plugin enabled: %s)",
  (enabled) => {
    const links = {
      snapshot: () =>
        enabled
          ? [
              {
                id: "link",
                title: "Links",
                key: "links/link",
                pluginId: "links",
                revision: "one",
                matches: () => true,
                component: ({ url }: { url: string }) => (
                  <LinkLabel href={url} />
                ),
              },
            ]
          : [],
      subscribe: () => () => {},
    };
    const html = render(
      "[**Important** or `code`](https://github.com/block/buzz-app)",
      { extensions: { ...extensions, links } },
    );
    expect(html).toContain("<strong>Important</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://github.com/block/buzz-app"');
    expect(html.includes('data-link-kind="github"')).toBe(enabled);
  },
);

it("keeps resolved private channel labels and lock icons for Buzz links", () => {
  const entry = {
    id: "link",
    title: "Links",
    key: "links/link",
    pluginId: "links",
    revision: "one",
    matches: () => true,
    component: ({ url }: { url: string }) => <LinkLabel href={url} />,
  };
  const href = `buzz://message?channel=design&id=${"a".repeat(64)}`;
  const channels = [
    { id: "design", name: "design", channelType: "forum", private: true },
  ] as const;
  const html = render(`<${href}> <buzz://channel/design> #design`, {
    directory: { profiles: new Map(), agents: [], channels, named: channels },
    extensions: {
      ...extensions,
      links: { snapshot: () => [entry], subscribe: () => () => {} },
    },
  });
  expect(html).toContain('data-link-kind="message"');
  expect(html).toContain('data-link-kind="channel"');
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(container.textContent).toContain("design");
  expect(container.textContent).not.toContain("buzz://");
  const lock = renderToStaticMarkup(
    <LockIcon className={`${referenceStyles.icon} ${referenceStyles.snug}`} />,
  );
  expect(html.split(lock)).toHaveLength(3);
});

it("renders tagged agent library names and profile names with the same agent icon", () => {
  const directory = {
    profiles: new Map([[mic, { name: "Fizz" }]]),
    channels: [],
    named: [],
    agents: [{ pubkey: mic, name: "Fast Fizz" }],
  };
  const options = {
    directory,
    participantProfiles: directory.profiles,
    patch: { mentions: [mic] },
  };
  for (const name of ["Fast Fizz", "Fizz"]) {
    const html = render(`@${name} can you also join`, options);
    expect(html).toContain('data-mention-kind="agent"');
    expect(html).toContain(`aria-label="View ${name} profile"`);
    expect(html).toContain(
      renderToStaticMarkup(<RobotIcon className={referenceStyles.icon} />),
    );
  }
  expect(
    render("@Fast Fizz", { ...options, participantProfiles: new Map() }),
  ).toContain('data-mention-kind="agent"');
  for (const patch of [
    { mentions: [] },
    { edited: true as const },
    { attachmentSeams: [3] },
  ])
    expect(
      render("@Fast Fizz", {
        ...options,
        patch: { ...options.patch, ...patch },
      }),
    ).not.toContain("data-mention-kind=");
  expect(render("`@Fast Fizz`", options)).not.toContain("data-mention-kind=");
  expect(
    render("@Fast Fizz", {
      ...options,
      participantProfiles: new Map([[other, { name: "Fast Fizz" }]]),
      patch: { mentions: [mic, other] },
    }),
  ).not.toContain("data-mention-kind=");
});

it.each(["@Mic", `[@Mic](${profileTarget(mic)})`])(
  "keeps the %s chip icon on the line with the first character",
  (mention) => {
    const view = renderDom(<MessageMarkdown {...props(`Hello ${mention}`)} />);
    const chip = view.container.querySelector("[data-mention-kind]");
    const lead = chip?.firstElementChild;
    expect(lead).toHaveClass(referenceStyles.lead ?? "");
    expect(lead?.querySelector("svg")).not.toBeNull();
    expect(lead?.textContent).toBe("M");
    expect(chip?.textContent).toBe("Mic");
  },
);

it.each<[string, RenderOptions]>([
  ["a refusing opener", { canOpenLink: () => false }],
  ["no opener", { canOpenLink: undefined }],
  ["a preview", { interactive: false }],
])("renders explicit profile links as inert chips with %s", (_, options) => {
  const target = profileTarget(mic);
  const view = renderDom(
    <MessageMarkdown
      {...props(`[@Mic](${target})`, { patch: { mentions: [] }, ...options })}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  const chip = view.container.querySelector("[data-mention-kind]");
  expect(chip?.tagName).toBe("SPAN");
  expect(chip).toHaveAttribute("data-profile-target", target);
  expect(view.container.textContent).toBe("Mic");
});

it.each([
  "nostr:npub1invalid",
  "nostr:nsec1invalid",
  "nostr:note1invalid",
  `buzz:agent-profile:${mic}`,
  `${profileTarget(mic)}?relay=https://example.test`,
  "javascript:alert%281%29",
  "data:text/html,hello",
])(
  "does not open unsupported or malformed identity destinations: %s",
  (target) => {
    const html = render(`[@Mic](${target})`, { patch: { mentions: [] } });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("href=");
    expect(html).toContain("@Mic");
  },
);

it("keeps explicit profile links literal inside code", () => {
  const link = `[@Mic](${profileTarget(mic)})`;
  const html = render(`\`${link}\``, { patch: { mentions: [] } });
  expect(html).not.toContain("<button");
  expect(html).not.toContain("href=");
  expect(html).toContain(link);
});

it.each([
  `buzz:agent-profile:${mic}`,
  `buzz:profile?agent=${mic}&tab=activity`,
  `${profileTarget(mic)}#version=1`,
])(
  "rejects app-local profile targets even when a panel matches: %s",
  (target) => {
    const html = render(`[Person](${target})`, { canOpenLink: () => true });
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<button");
  },
);

describe("text spoilers", () => {
  it("hides formatted content and link controls until reveal, and resets after edits", () => {
    const view = renderDom(
      <MessageMarkdown
        {...props("Before ||**secret** [link](https://example.com)|| after")}
      />,
    );
    const reveal = screen.getByRole("button", { name: "Reveal spoiler" });
    const content = view.container.querySelector("[inert]");
    expect(content).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(reveal);
    expect(
      screen.getByRole("button", { name: "Hide spoiler" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelector("strong")).toHaveTextContent("secret");
    expect(screen.getByRole("link", { name: "link" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide spoiler" }));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reveal spoiler" }));
    view.rerender(<MessageMarkdown {...props("Before ||changed|| after")} />);
    expect(
      screen.getByRole("button", { name: "Reveal spoiler" }),
    ).toBeInTheDocument();
    expect(view.container.querySelector("[inert]")).toHaveTextContent(
      "changed",
    );
  });

  it("keeps angle-bracket text inline inside a spoiler through reveal and hide", () => {
    expect(render("Before ||<harness>|| after").match(/<p[\s>]/g)).toHaveLength(
      1,
    );
    const view = renderDom(
      <MessageMarkdown {...props("Before ||<harness>|| after")} />,
    );
    const paragraph = () => view.container.querySelectorAll("p");
    expect(paragraph()).toHaveLength(1);
    expect(paragraph()[0]).toHaveTextContent("Before <harness> after");
    expect(view.container.querySelector("[inert]")).toHaveTextContent(
      "<harness>",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal spoiler" }));
    expect(paragraph()).toHaveLength(1);
    expect(paragraph()[0]).toHaveTextContent("Before <harness> after");
    fireEvent.click(screen.getByRole("button", { name: "Hide spoiler" }));
    expect(paragraph()).toHaveLength(1);
  });

  it.each([
    "`||code||`",
    "```\n||code||\n```",
    "\\|\\|escaped\\|\\|",
    "&#124;&#124;entity&#124;&#124;",
    '<span title="||attribute||">raw</span>',
    "![||alt||](https://image.test/a.png)",
    "[link](https://example.com/||path||)",
    "||unclosed",
    "||||",
    "| a | b |\n| - | - |\n| || | cell |",
  ])("does not turn literal syntax into a reveal control: %s", (content) => {
    expect(render(content)).not.toContain('aria-label="Reveal spoiler"');
  });

  it("keeps spoilers inert in noninteractive previews", () => {
    const html = render("||secret [link](https://example.com)||", {
      interactive: false,
    });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
  });
});

describe("code block copy", () => {
  const fenced = "Before\n\n```ts\nconst x = 1\n\nreturn x\n```";

  it("copies only the code, reports failure, and allows retry", async () => {
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce();
    const view = renderDom(<MessageMarkdown {...props(fenced)} />, {
      wrapper: ToastProvider,
    });
    // Native and timeline selection copy read the block's text unchanged.
    expect(view.container.querySelector("pre")?.textContent).toBe(
      "const x = 1\n\nreturn x\n",
    );
    const copy = screen.getByRole("button", { name: "Copy code block" });
    await user.click(copy);
    await screen.findByText("Failed to copy code");
    await user.click(copy);
    await screen.findByText("Copied code to clipboard");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith("const x = 1\n\nreturn x");
  });

  it("blocks repeat copies until the first settles", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderDom(<MessageMarkdown {...props(fenced)} />, {
      wrapper: ToastProvider,
    });
    const copy = screen.getByRole("button", { name: "Copy code block" });
    await user.click(copy);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    try {
      expect(copy).toHaveAttribute("aria-disabled", "true");
      await user.click(copy);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      finish();
    }
    await screen.findByText("Copied code to clipboard");
    expect(copy).not.toHaveAttribute("aria-disabled", "true");
  });

  it("omits the copy action in noninteractive previews", () => {
    expect(render(fenced, { interactive: false })).not.toContain("<button");
  });
});

describe("code block renderers", () => {
  const fenced =
    "Before\n\n```Mermaid\nflowchart LR\n  A --> B\n```\n\n```ts\nconst x = 1\n```";
  const diagram = (
    component: CodeBlockRenderer["component"],
  ): Contribution<CodeBlockRenderer> => ({
    id: "diagram",
    key: "test/diagram",
    pluginId: "test",
    revision: "1",
    title: "Diagram",
    matches: (language) => language === "Mermaid",
    component,
  });
  const drawn = diagram(({ code, language }) => (
    <figure data-language={language}>{code}</figure>
  ));
  function store(initial: readonly Contribution<CodeBlockRenderer>[]) {
    let entries = initial;
    const listeners = new Set<() => void>();
    return {
      snapshot: () => entries,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      swap(next: readonly Contribution<CodeBlockRenderer>[]) {
        entries = next;
        act(() => {
          for (const listener of listeners) listener();
        });
      },
    };
  }

  it("presents matching blocks with the host copy action and leaves other languages", async () => {
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    const codeBlocks = store([drawn]);
    const view = renderDom(
      <MessageMarkdown
        {...props(fenced, { extensions: { ...extensions, codeBlocks } })}
      />,
      { wrapper: ToastProvider },
    );
    const figure = view.container.querySelector("figure");
    expect(figure).toHaveAttribute("data-language", "Mermaid");
    expect(figure?.textContent).toBe("flowchart LR\n  A --> B");
    expect(view.container.querySelectorAll("pre")).toHaveLength(1);
    expect(view.container.querySelector("pre")?.textContent).toContain(
      "const x = 1",
    );
    const copy = screen.getAllByRole("button", { name: "Copy code block" });
    // The presented block precedes the plain one.
    await user.click(copy[0] as HTMLElement);
    expect(write).toHaveBeenCalledWith("flowchart LR\n  A --> B");

    // Removing the plugin restores the plain block.
    codeBlocks.swap([]);
    expect(view.container.querySelector("figure")).toBeNull();
    expect(view.container.querySelectorAll("pre")).toHaveLength(2);
  });

  it("restores the plain block when the renderer fails, and retries on re-enable", () => {
    const codeBlocks = store([
      diagram(() => {
        throw new Error("broken renderer");
      }),
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = renderDom(
        <MessageMarkdown
          {...props(fenced, { extensions: { ...extensions, codeBlocks } })}
        />,
        { wrapper: ToastProvider },
      );
      expect(view.container.querySelectorAll("pre")).toHaveLength(2);
      expect(
        screen.getAllByRole("button", { name: "Copy code block" }),
      ).toHaveLength(2);
      codeBlocks.swap([drawn]);
      expect(view.container.querySelector("figure")).not.toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  // A drawing whose text is not the source, as an SVG diagram's labels are.
  const labels = diagram(() => (
    <svg aria-hidden="true">
      <text>A</text>
      <text>B</text>
    </svg>
  ));
  function copy(
    source: string,
    codeBlocks: ReturnType<typeof store>,
    select: (container: HTMLElement, range: Range) => void,
  ) {
    const view = renderDom(
      <MessageMarkdown
        {...props(source, { extensions: { ...extensions, codeBlocks } })}
      />,
      { wrapper: ToastProvider },
    );
    const range = document.createRange();
    select(view.container, range);
    const selection = document.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    const copied = Object.fromEntries(
      (["text", "markdown", "html"] as const).map((format) => [
        format,
        serializeSelection(selection, format),
      ]),
    );
    view.unmount();
    return copied;
  }

  it("copies a presented block in a selection exactly as the plain block", () => {
    // A blank line before the closing fence is source the paste must keep.
    const source =
      "Before\n\n```Mermaid\nflowchart LR\n  A --> B\n\n```\n\nAfter";
    const all = (container: HTMLElement, range: Range) =>
      range.selectNodeContents(container);
    const presented = copy(source, store([labels]), all);
    expect(presented).toEqual(copy(source, store([]), all));
    expect(presented.markdown).toBe(
      "Before\n\n```Mermaid\nflowchart LR\n  A --> B\n\n```\n\nAfter",
    );
    expect(presented.text).toBe("Before\n\nflowchart LR\n  A --> B\n\nAfter");
  });

  it("leaves out a presented block that a paragraph selection only ends in", () => {
    // A triple-click on the paragraph ends the range at the next block's first text.
    const copied = copy(fenced, store([labels]), (container, range) => {
      const paragraph = container.querySelector("p") as Node;
      const label = container.querySelector("svg text")?.firstChild as Node;
      range.setStart(paragraph, 0);
      range.setEnd(label, 0);
    });
    expect(copied).toEqual({
      text: "Before",
      markdown: "Before",
      html: "<p>Before</p>",
    });
  });

  it("retries the renderer when an edit changes a block it failed on", () => {
    const codeBlocks = store([
      diagram(({ code }) => {
        if (code.includes("(")) throw new Error("unsupported source");
        return <figure>{code}</figure>;
      }),
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const block = (source: string) => (
        <MessageMarkdown
          {...props(`\`\`\`Mermaid\n${source}\n\`\`\``, {
            extensions: { ...extensions, codeBlocks },
          })}
        />
      );
      const view = renderDom(block("A --> ("), { wrapper: ToastProvider });
      expect(view.container.querySelector("figure")).toBeNull();
      expect(view.container.querySelector("pre")?.textContent).toContain(
        "A --> (",
      );
      view.rerender(block("A --> B"));
      expect(view.container.querySelector("figure")?.textContent).toBe(
        "A --> B",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("keeps plain code in noninteractive previews", () => {
    const html = render(fenced, {
      interactive: false,
      extensions: { ...extensions, codeBlocks: store([drawn]) },
    });
    expect(html).not.toContain("<figure");
    expect(html).toContain('<code class="language-Mermaid">');
  });
});

it.each(["one\n\ntwo", "https://example.com/path"])(
  "hides serialized spoiler content before reveal: %s",
  async (text) => {
    const { composerSchema: schema, projectComposerDocument } = await import(
      "./composer-document"
    );
    const { composerMarkdown } = await import("./composer-markdown");
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(
        null,
        schema.text(text, [schema.marks.spoiler.create()]),
      ),
    );
    const wire = composerMarkdown(projectComposerDocument(doc).draft);
    const view = renderDom(<MessageMarkdown {...props(wire)} />);
    expect(
      screen.getAllByRole("button", { name: "Reveal spoiler" }),
    ).toHaveLength(text.includes("\n\n") ? 2 : 1);
    const visibleText = [...view.container.querySelectorAll("p")]
      .map((paragraph) => {
        const clone = paragraph.cloneNode(true) as Element;
        for (const hidden of clone.querySelectorAll('[aria-hidden="true"]'))
          hidden.remove();
        return clone.textContent?.trim();
      })
      .join("");
    expect(visibleText).toBe("");
    for (const button of screen.getAllByRole("button", {
      name: "Reveal spoiler",
    }))
      fireEvent.click(button);
    expect(view.container.textContent).toContain(
      text.includes("\n") ? "one" : text,
    );
    if (!text.includes("\n"))
      expect(screen.getByRole("link")).toHaveAttribute("href", text);
  },
);

it("preserves a GFM table with adjacent pipes and an empty middle cell", () => {
  const html = render("| A || C |\n| - | - | - |\n| a || c |");
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(
    [...container.querySelectorAll("th")].map((cell) => cell.textContent),
  ).toEqual(["A", "", "C"]);
  expect(
    [...container.querySelectorAll("td")].map((cell) => cell.textContent),
  ).toEqual(["a", "", "c"]);
  expect(html).not.toContain("Reveal spoiler");
});

it.each([
  ["**||secret||**", "strong"],
  ["_||secret||_", "em"],
  ["~~||secret||~~", "del"],
])("preserves authored formatting outside a spoiler: %s", (source, tag) => {
  const view = renderDom(<MessageMarkdown {...props(source)} />);
  const formatted = view.container.querySelector(tag);
  expect(formatted).toHaveTextContent("secret");
  expect(formatted?.querySelector("[inert]")).toHaveTextContent("secret");
  expect(view.container.textContent).toBe("secret");
  fireEvent.click(screen.getByRole("button", { name: "Reveal spoiler" }));
  expect(formatted?.querySelector('[aria-hidden="false"]')).toHaveTextContent(
    "secret",
  );
});

it("keeps one channel Larry plain despite global namesakes and follows membership changes", () => {
  const owned = createRelaySession(null);
  const listeners = new Set<() => void>();
  const people = new Map(
    [mic, smith, other].map((key) => [
      key,
      { name: "Larry", isAgent: true as const },
    ]),
  );
  let list = {
    status: "ready" as const,
    channels: [{ id: "channel", name: "Here", members: [mic] }],
  };
  const session = {
    ...owned.session,
    profiles: { ...owned.session.profiles, snapshot: () => people },
    channels: {
      ...owned.session.channels,
      list: () => list,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const provider = createAgentDirectory();
  const names = bindNames(
    { profiles: session.profiles, agentLibrary: session.agentLibrary },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const open = vi.fn(() => true);
  const mounted = renderDom(
    <MessageMarkdown
      {...props("@Larry", {
        session: { ...session, names },
        participantProfiles: people,
        patch: { mentions: [mic] },
        onOpenLink: open,
      })}
    />,
  );
  expect(names.resolve(mic)).not.toBe("Larry");
  const button = mounted.getByRole("button", { name: "View Larry profile" });
  fireEvent.click(button);
  expect(open).toHaveBeenCalledWith(profileTarget(mic));
  act(() => {
    list = {
      ...list,
      channels: [{ id: "channel", name: "Here", members: [mic, smith] }],
    };
    for (const listener of listeners) listener();
  });
  expect(button.textContent).toMatch(/^Larry · /);
  act(() => {
    list = {
      ...list,
      channels: [{ id: "channel", name: "Here", members: [mic] }],
    };
    for (const listener of listeners) listener();
  });
  expect(button.textContent).toBe("Larry");
  mounted.unmount();
  names.dispose();
  owned.dispose();
});

it("marks only a mention of the viewer as a mention of you", () => {
  const session = { ...createRelaySession(null).session, viewer: smith };
  const view = renderDom(
    <MessageMarkdown {...props("@Mic Smith and @Mic", { session })} />,
  );
  expect(
    view.getByRole("button", { name: "View Mic Smith profile" }),
  ).toHaveAttribute("data-mention-self", "");
  expect(
    view.getByRole("button", { name: "View Mic profile" }),
  ).not.toHaveAttribute("data-mention-self");
});

it("opens a plugin page link in message content through the host opener", () => {
  const href =
    "buzz://plugin?id=com.example.catalog&page=detail&route.slug=hello";
  const onOpenLink = vi.fn(() => true);
  renderDom(
    <ToastProvider>
      <MessageMarkdown {...props(`See [the entry](${href})`, { onOpenLink })} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("link", { name: "the entry" }));
  expect(onOpenLink).toHaveBeenCalledWith(href);
});
