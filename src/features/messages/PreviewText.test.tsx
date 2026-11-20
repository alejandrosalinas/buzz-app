// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { afterEach, expect, it, vi } from "vitest";
import { eventMentions, searchText } from "../../app/shell/useSearchMessages";
import { messagePreview, plainText } from "../notifications/content";
import { profileTarget } from "../profiles/target";
import type { Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { snippet } from "../search/snippet";
import {
  type PreviewMentions,
  PreviewText,
  withMentionedIds,
} from "./PreviewText";
import { preparedMarkdown } from "./markdown-preparation";
import { renderedProfileMentionParts } from "./profile-mentions";

vi.mock("./profile-mentions", async (original) => {
  const actual = await original<typeof import("./profile-mentions")>();
  return {
    ...actual,
    renderedProfileMentionParts: vi.fn(actual.renderedProfileMentionParts),
  };
});

vi.mock("mdast-util-from-markdown", async (original) => {
  const actual = await original<typeof import("mdast-util-from-markdown")>();
  return { ...actual, fromMarkdown: vi.fn(actual.fromMarkdown) };
});

afterEach(cleanup);

const tomb = "a".repeat(64);
const viewer = "b".repeat(64);
const stranger = "c".repeat(64);
const riley = "d".repeat(64);
const short = "e".repeat(64);
const mic = "f".repeat(64);
const crane = "1".repeat(64);
const wes = "2".repeat(64);
const kalvin = "3".repeat(64);
const starred = "4".repeat(64);
const ann = "5".repeat(64);
const annLee = "6".repeat(64);
const jo = "7".repeat(64);
const list = { channels: [] };
const profiles = new Map<string, Profile>([
  [tomb, { name: "tomb" } as Profile],
  [viewer, { name: "me" } as Profile],
  [short, { name: "Riley" } as Profile],
  [mic, { name: "Mic" } as Profile],
  [crane, { name: "Riley Crane" } as Profile],
  [wes, { name: "Wes" } as Profile],
  [kalvin, { name: "kalvin" } as Profile],
  [starred, { name: "Mi*c*" } as Profile],
  [ann, { name: "Ann" } as Profile],
  [annLee, { name: "Ann Lee" } as Profile],
  [jo, { name: "Jo  Doe" } as Profile],
  [
    riley,
    {
      name: "rcrane",
      verified: { displayName: "Riley", fullName: "Riley Crane" },
    } as unknown as Profile,
  ],
]);
const session = {
  viewer,
  profiles: { subscribe: () => () => {}, snapshot: () => profiles },
  channels: { list: () => list, subscribeList: () => () => {} },
} as unknown as RelaySession;
type Signed = Omit<PreviewMentions, "content">;
/** `body`'s preview; `text` shows `full` (the body by default) from `start`. */
const preview = (
  body: string,
  signed: Signed,
  shown: {
    text?: string;
    full?: string;
    start?: number;
    matches?: readonly number[];
  } = {},
) =>
  render(
    <PreviewText
      text={shown.text ?? body}
      full={shown.full}
      start={shown.start}
      mentions={{ ...signed, content: body }}
      matches={shown.matches}
      session={session}
      channelId="room"
    />,
  ).container;
const chips = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-mention-kind]")].map(
    (chip) => chip.textContent,
  );
const targets = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-profile-target]")].map((chip) =>
    chip.getAttribute("data-profile-target"),
  );
const namesakes = { mentions: [crane, short] };

it("shows signed mentions as message chips and leaves unresolved ones as text", () => {
  const view = preview("ugh @tomb and @me, not @stranger", {
    mentions: [tomb, viewer, stranger],
  });
  expect(chips(view)).toEqual(["tomb", "me"]);
  const [first, self] = view.querySelectorAll("[data-mention-kind]");
  expect(first).toHaveAttribute("data-mention-kind", "person");
  expect(first).not.toHaveAttribute("data-mention-self");
  expect(self).toHaveAttribute("data-mention-self", "");
  expect(view).toHaveTextContent("ugh tomb and me, not @stranger");
});

it.each([
  ["that @tomb's change will fix it"],
  ['said "@tomb" twice'],
  ["thanks @tomb…"],
  ["@tomb—done"],
])("binds a mention by the message's own boundary rules: %s", (text) => {
  expect(chips(preview(text, { mentions: [tomb] }))).toEqual(["tomb"]);
});

it("binds verified names and two-field mention references as messages do", () => {
  const view = preview("@Riley Crane anything? cc @Riley and @tomb", {
    mentions: [riley],
    mentionReferences: [tomb],
  });
  expect(chips(view)).toHaveLength(3);
});

it("does not chip a name the message does not mention, or an edited body", () => {
  expect(chips(preview("ugh @tomb", { mentions: [] }))).toEqual([]);
  const edited = preview("hey @tomb", { mentions: [tomb], edited: true });
  expect(chips(edited)).toEqual([]);
  expect(edited).toHaveTextContent("hey @tomb");
});

it("keeps a mention a search snippet cuts beside as a chip", () => {
  const body = `needle ${"foo ".repeat(42)}@tomb ${"bar ".repeat(30)}`;
  const full = messagePreview(body, { limit: 4000 });
  const tail = snippet(full, ["needle"]);
  expect(tail.text).toMatch(/@tomb…$/);
  const tailView = preview(body, { mentions: [tomb] }, { ...tail, full });
  expect(chips(tailView)).toEqual(["tomb"]);
  expect(tailView).toHaveTextContent(tail.text.replace("@tomb", "tomb"));
  const spaced = `${"foo ".repeat(60)}\n\n@tomb  needle`;
  const flat = messagePreview(spaced, { limit: 4000 });
  const lead = snippet(flat, ["needle"]);
  expect(lead.text).toMatch(/^….*@tomb needle$/);
  const view = preview(spaced, { mentions: [tomb] }, { ...lead, full: flat });
  expect(chips(view)).toEqual(["tomb"]);
  expect(view.querySelector("mark.search-match")).toHaveTextContent("needle");
  expect(view).toHaveTextContent(lead.text.replace("@tomb", "tomb"));
});

it("keeps a name a cut splits literal rather than binding its prefix", () => {
  const body = `needle ${"i ".repeat(82)}@Riley Crane ${"bar ".repeat(30)} cc @Riley`;
  const full = messagePreview(body, { limit: 4000 });
  // Search's snippet.
  const shown = snippet(full, ["needle"]);
  expect(shown.text).toMatch(/@Riley…$/);
  const view = preview(body, namesakes, { ...shown, full });
  expect(targets(view)).toEqual([]);
  expect(view).toHaveTextContent(shown.text);
  // The whole message binds both people.
  expect(targets(preview(body, namesakes, { text: full }))).toEqual([
    profileTarget(crane),
    profileTarget(short),
  ]);
  // Peek's 1600-character cut and Activity's 200-character one.
  const long = `${"i ".repeat(796)}@Riley Crane and cc @Riley`;
  const peek = messagePreview(long, { limit: 4000 }).slice(0, 1600);
  expect(peek).toMatch(/@Riley C$/);
  expect(targets(preview(long, namesakes, { text: peek }))).toEqual([]);
  const activity = messagePreview(
    `${"i ".repeat(96)}@Riley Crane and cc @Riley`,
  );
  expect(activity).toMatch(/@Riley …$/);
  expect(
    targets(
      preview(`${"i ".repeat(96)}@Riley Crane and cc @Riley`, namesakes, {
        text: activity,
      }),
    ),
  ).toEqual([]);
});

/** Each chip's label after the shown text before it. */
const placed = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-mention-kind]")].map((chip) => {
    let before = "";
    for (let node = chip.previousSibling; node; node = node.previousSibling)
      before = (node.textContent ?? "") + before;
    return `${before}|${chip.textContent}`;
  });
const activity = (body: string, signed: Signed) =>
  preview(body, signed, { text: messagePreview(body) });

it("binds each occurrence the conversation binds, through Markdown", () => {
  expect(
    placed(activity("**release** ping @tomb", { mentions: [tomb] })),
  ).toEqual(["release ping |tomb"]);
  // A name joined across a removed attachment, or inside code, stays
  // literal; the real mention after it is the chip.
  const seamed = { mentions: [mic], attachmentSeams: [8] };
  expect(placed(activity("**x** @Mic then @Mic", seamed))).toEqual([
    "x @Mic then |Mic",
  ]);
  expect(placed(activity("Hello @Mic then @Mic", seamed))).toEqual([
    "Hello @Mic then |Mic",
  ]);
  expect(
    placed(activity("`@Mic` then real @Mic", { mentions: [mic] })),
  ).toEqual(["@Mic then real |Mic"]);
  // Markdown that rewrites a reference's own characters leaves it literal.
  const rewritten = activity("ping @Mi*c* now", { mentions: [starred] });
  expect(placed(rewritten)).toEqual([]);
  expect(rewritten).toHaveTextContent("ping @Mic now");
  // A spoiler hides one occurrence; Activity's cut splits another.
  const spoiled = `||@Riley|| @Riley ${"i ".repeat(86)}@Riley Crane then more`;
  const view = activity(spoiled, namesakes);
  expect(messagePreview(spoiled)).toMatch(/@Riley Cra…$/);
  expect(targets(view)).toEqual([profileTarget(short)]);
  expect(placed(view)).toEqual(["[Spoiler] |Riley"]);
});

it.each([
  [
    "@Riley Crane Anything blocking here?\n\n- **one** `two`\n- three",
    [crane],
    "|Riley Crane",
  ],
  [
    "@Wes Both points from the [latest review](https://example.org/r) hold; see `fix()`.",
    [wes],
    "|Wes",
  ],
  [
    "@kalvin PR #3747 is rebased on [main](https://example.org/m) and `ci` is green.",
    [kalvin],
    "|kalvin",
  ],
])(
  "keeps a leading mention in a formatted body: %s",
  (body, mentions, chip) => {
    const signed = { mentions };
    const full = messagePreview(body, { limit: 4000 });
    expect(placed(activity(body, signed))).toEqual([chip]);
    expect(placed(preview(body, signed, { text: full }))).toEqual([chip]);
    const shown = snippet(full, ["points", "rebased", "blocking"]);
    expect(placed(preview(body, signed, { ...shown, full }))).toEqual([chip]);
  },
);

it("keeps chips in a body past the flattener's source bound", () => {
  // Marks must not move where flattening cuts the source.
  const dense = `needle ${"@tomb ".repeat(40)}${"i ".repeat(2000)}`;
  const denseFull = messagePreview(dense, { limit: 4000 });
  const signed = { mentions: [tomb] };
  expect(
    chips(
      preview(dense, signed, {
        text: denseFull.slice(0, 1600),
        full: denseFull,
      }),
    ),
  ).toHaveLength(40);
  const shown = snippet(denseFull, ["needle"]);
  expect(
    chips(preview(dense, signed, { ...shown, full: denseFull })).length,
  ).toBeGreaterThan(0);
  // Markdown shortens a long body below the 4000-character cap.
  const long = `@tomb see **this**: ${"[link](https://example.org/x) `code` ".repeat(120)}`;
  expect(long.length).toBeGreaterThan(4096);
  const full = messagePreview(long, { limit: 4000 });
  expect(full.length).toBeLessThan(4000);
  expect(
    placed(preview(long, signed, { text: full.slice(0, 1600), full })),
  ).toEqual(["|tomb"]);
});

it("leaves authored private-use characters as they read", () => {
  const view = preview("@tomb ships \uF8FF today", { mentions: [tomb] });
  expect(chips(view)).toEqual(["tomb"]);
  expect(view).toHaveTextContent("tomb ships \uF8FF today");
});

it("keeps search highlights around chips, counting code points", () => {
  const text = "😀 @tomb now getting";
  const at = (word: string) => [...text.slice(0, text.indexOf(word))].length;
  const positions = (word: string) =>
    [...word].map((_, index) => at(word) + index);
  const view = preview(
    text,
    { mentions: [tomb] },
    { matches: [...positions("tomb"), ...positions("getting")] },
  );
  const marks = [...view.querySelectorAll("mark.search-match")];
  expect(marks.map((mark) => mark.textContent)).toEqual(["tomb", "getting"]);
  expect(marks[0]?.querySelector("[data-mention-kind]")).not.toBeNull();
  expect(view).toHaveTextContent("😀 tomb now getting");
});

it("keeps chips beside a repaired wrapped link", () => {
  const body =
    "[docs]\\(https://example.org/a) @tomb, [@Mic]\\(https://example.org/b) and `[x]\\(https://example.test)` @Wes";
  const text = messagePreview(body);
  const view = preview(body, { mentions: [tomb, mic, wes] }, { text });
  expect(chips(view)).toEqual(["tomb", "Wes"]);
  expect(view).toHaveTextContent(
    text.replace("@tomb", "tomb").replace("@Wes", "Wes"),
  );
});

it("does not prepare a body without signed mentions", () => {
  vi.mocked(renderedProfileMentionParts).mockClear();
  const body = `**${"x ".repeat(5000)}** @tomb`;
  const view = preview(body, { mentions: [] }, { text: messagePreview(body) });
  expect(chips(view)).toEqual([]);
  expect(renderedProfileMentionParts).not.toHaveBeenCalled();
});

it("reads named identities before the optional mentioned ones, within budget", () => {
  const ids = ["a", "b"];
  const mentioned = Array.from({ length: 1100 }, (_, index) => ({
    content: "",
    mentions: [`m${index}`, "a"],
  }));
  const read = withMentionedIds(ids, mentioned);
  expect(read).toHaveLength(1024);
  expect(read.slice(0, 3)).toEqual(["a", "b", "m0"]);
  const many = Array.from({ length: 1030 }, (_, index) => `n${index}`);
  expect(withMentionedIds(many, mentioned)).toEqual(many);
});

it("keeps chips beside authored mark characters and collapsed spaces", () => {
  const marked = "odd \uE011 glyph and \uE010\uE100 then @tomb here";
  expect(
    chips(
      preview(marked, { mentions: [tomb] }, { text: messagePreview(marked) }),
    ),
  ).toEqual(["tomb"]);
  const spaced = "hi @Jo  Doe there";
  const view = preview(
    spaced,
    { mentions: [jo] },
    { text: messagePreview(spaced) },
  );
  expect(targets(view)).toEqual([profileTarget(jo)]);
});

it("binds a preview only once it comes near the screen", () => {
  const binder = vi.mocked(renderedProfileMentionParts);
  binder.mockClear();
  let notify: (entries: Partial<IntersectionObserverEntry>[]) => void =
    () => {};
  const observed: Element[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof notify) {
        notify = callback;
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ top: 5000, bottom: 5020 } as DOMRect);
  try {
    const view = preview("ugh @tomb", { mentions: [tomb] });
    expect(chips(view)).toEqual([]);
    expect(view).toHaveTextContent("ugh @tomb");
    expect(binder).not.toHaveBeenCalled();
    act(() =>
      notify([{ isIntersecting: true, target: observed[0] as Element }]),
    );
    expect(chips(view)).toEqual(["tomb"]);
  } finally {
    rect.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("shares its conversation's preparation and flattens the bound body once", () => {
  const body =
    "once **hey** @tomb, see `code` and [a link](https://example.org)";
  const text = messagePreview(body);
  preparedMarkdown(body);
  const parse = vi.mocked(fromMarkdown);
  parse.mockClear();
  const view = preview(body, { mentions: [tomb] }, { text });
  expect(chips(view)).toEqual(["tomb"]);
  expect(view).toHaveTextContent(text.replace("@", ""));
  expect(parse).toHaveBeenCalledTimes(1);
});

it.each([
  `[Dashboard](https://app.example.com/dash?${"q=1&".repeat(150)})\n\n@tomb can you check this?`,
  `[docs] ping @tomb ${"word ".repeat(740)}\n\n[docs]: https://example.org`,
  `<!-- @tomb ${"word ".repeat(150)}\n\nmore -->\n\nthen @tomb`,
  `[Dashboard](https://app.example.com/dash?${"q=1&".repeat(150)})\r\n\r\n@tomb can you check this?`,
])("chips a name whose source runs far longer than its preview: %#", (body) => {
  const text = messagePreview(body);
  expect(chips(preview(body, { mentions: [tomb] }, { text }))).toEqual([
    "tomb",
  ]);
});
it("leaves a preview text when its body is longer than previews bind", () => {
  const body = `@tomb ${"**word** ".repeat(2_000)}`;
  const text = messagePreview(body);
  const view = preview(body, { mentions: [tomb] }, { text });
  expect(chips(view)).toEqual([]);
  expect(view).toHaveTextContent(text);
});

it.each([
  [
    "inline HTML that closes far past the preview",
    `${"word ".repeat(30)}<span title="@tomb ${"x ".repeat(400)}">hi</span>\n\nmore`,
  ],
  [
    "inline HTML split by a CRLF line break",
    `<span title="@tomb ${"x ".repeat(350)}\r\n${"x ".repeat(300)}">hi</span>\r\n\r\nmore`,
  ],
  [
    "a body nested too deeply far past the preview",
    `@tomb ${"word ".repeat(150)}\n\n${"lorem\n\n".repeat(800)}\n\n${">".repeat(101)} x`,
  ],
  [
    "a reference defined far past the preview",
    `[@tomb] hi ${"word ".repeat(150)}\n\n${"lorem\n\n".repeat(800)}\n\n[@tomb]: https://example.org`,
  ],
])("binds a name in %s as its conversation does", (_, body) => {
  const text = messagePreview(body);
  expect(text).toContain("@tomb");
  expect(chips(preview(body, { mentions: [tomb] }, { text }))).toEqual([]);
});

it("binds a body with attachments and a repaired link past the preview as its conversation does", () => {
  const body = `@tomb ${"word ".repeat(150)}\n\n![i](https://example.org/a.png) after\n\n[docs]\\(https://example.org/a)`;
  const event = { kind: 9, content: body, tags: [["p", tomb]] };
  const full = searchText(event);
  const view = render(
    <PreviewText
      text={full.slice(0, 120)}
      full={full}
      mentions={eventMentions(event)}
      session={session}
      channelId="room"
    />,
  ).container;
  expect(chips(view)).toEqual([]);
});

it("keeps a search hit's attachments in its text, and binds no one in a patch", () => {
  const url = "https://example.org/a.png";
  const image = `Architecture ![diagram](${url}) see @tomb`;
  const tags = [
    ["p", tomb],
    ["imeta", `url ${url}`],
  ];
  expect(searchText({ kind: 9, content: image })).toBe(
    "Architecture [Image] see @tomb",
  );
  const patch = { kind: 40008, content: "+ ping @tomb", tags };
  expect(eventMentions(patch).mentions).toEqual([]);
});

/** A search hit's preview of `body`, read as search reads the event. */
const searched = (body: string, tags: string[][], length: number) => {
  const event = { kind: 9, content: body, tags };
  const full = searchText(event);
  return render(
    <PreviewText
      text={full.slice(0, length)}
      full={full}
      mentions={eventMentions(event)}
      session={session}
      channelId="room"
    />,
  ).container;
};

const attachment = `https://example.org/${"a".repeat(2800)}`;
it.each([
  ["unique @Ann Lee![x](https://example.org/a.png)x", [ann]],
  [
    `${"x ".repeat(1950)}@Ann Lee![x](https://example.org/${"a".repeat(400)}.png)x`,
    [ann],
  ],
  [
    `unique @Ann Lee![a](https://example.org/a.png)![b][late]x\n\n${"some prose here ".repeat(320)}\n\n[late]: https://example.org/b.png`,
    [ann],
  ],
  [
    `unique x![a][late]@Ann\n\n${"some prose here ".repeat(320)}\n\n[late]: https://example.org/a.png`,
    [],
  ],
  [`${"word ".repeat(290)}R and D unique @Ann Lee<${attachment}>x`, [ann]],
  [`${"word ".repeat(290)}R&amp;D unique @Ann Lee<${attachment}>x`, [ann]],
])(
  "binds a search hit's body with its attachments removed, as its conversation does: %#",
  (body, expected) => {
    const tags = [
      ["p", ann],
      ["p", annLee],
      ["imeta", `url ${attachment}`],
    ];
    const view = searched(body, tags, 4000);
    expect(targets(view)).toEqual(expected.map((id) => profileTarget(id)));
  },
);

it("does not bind a preview whose shown text names no one", () => {
  const binder = vi.mocked(renderedProfileMentionParts);
  binder.mockClear();
  const body = `@tomb ${"far away words ".repeat(40)}`;
  const full = plainText(body, { limit: 4000 });
  const view = preview(
    body,
    { mentions: [tomb] },
    { text: `…${full.slice(300, 400)}`, full, start: 300 },
  );
  expect(chips(view)).toEqual([]);
  expect(binder).not.toHaveBeenCalled();
});

it("keeps chips beside text the Markdown decodes", () => {
  const body = "R&amp;D asked @tomb";
  expect(
    chips(preview(body, { mentions: [tomb] }, { text: messagePreview(body) })),
  ).toEqual(["tomb"]);
});

it("waits for a preview to near its scroll pane, not the window", () => {
  let root: Element | null | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(_: unknown, options: IntersectionObserverInit) {
        root = options.root as Element | null;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      // Within half a window of the screen, but far below its pane.
      return (
        this.dataset.pane === ""
          ? { top: 0, bottom: 160 }
          : { top: 700, bottom: 720 }
      ) as DOMRect;
    });
  try {
    const view = render(
      <div data-pane="" style={{ overflowY: "auto" }}>
        <PreviewText
          text="ugh @tomb"
          mentions={{ content: "ugh @tomb", mentions: [tomb] }}
          session={session}
          channelId="room"
        />
      </div>,
    ).container;
    expect(chips(view)).toEqual([]);
    expect(root).toBe(view.querySelector("[data-pane]"));
  } finally {
    rect.mockRestore();
    vi.unstubAllGlobals();
  }
});
