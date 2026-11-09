// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Node as EditorNode } from "prosemirror-model";
import { MessageMarkdown } from "./MessageMarkdown";
import {
  EditableInput,
  type EditableInputProps,
  type EditorDecoration,
} from "./EditableInput";
import type { ComposerFormat, ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";
import { composerMarkdown } from "./composer-markdown";
import {
  followupDraft,
  mentionDraft,
  type MentionDraft,
} from "./mention-draft";
import { messageLinkParts } from "./message-link-parts";
import { setMessageAutocorrectPreference } from "./autocorrect-preference";
import { profileMentionParts } from "./profile-mentions";
import {
  serializeNode,
  serializeSelection,
  spoilerDelimiter,
} from "./selection-copy";
import { profileKey, profileTarget } from "../profiles/target";
import { scanMarkdown } from "../relay/message-content";

composerDOMFixture();
afterEach(cleanup);

/** The editor's paste handler, not the insertText API. */
function paste(input: ComposerInputElement, text: string, html = "") {
  act(() => {
    input.focus();
    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        getData: (type: string) =>
          type === "text/plain" ? text : type === "text/html" ? html : "",
      },
    });
  });
}

/** Identity and web links paint as editable chips, as in RichComposerInput. */
function linkDecorations(text: string): EditorDecoration[] {
  const ranges: EditorDecoration[] = [];
  for (const link of scanMarkdown(text).links) {
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    if (
      link.url &&
      profileKey(link.url) &&
      start !== undefined &&
      end !== undefined
    )
      ranges.push({
        start,
        end,
        editAsText: true,
        content: <span data-identity />,
      });
  }
  messageLinkParts(text, undefined, (start, end) =>
    ranges.push({ start, end, editAsText: true, content: <span data-link /> }),
  );
  return ranges;
}

function mount(
  initial: string | MentionDraft = "",
  options: {
    maxLength?: number;
    onPasteTooLong?: () => void;
    links?: boolean;
    acceptRecipient?: EditableInputProps["acceptRecipient"];
  } = {},
) {
  const ref = createRef<ComposerInputElement>();
  let draft: MentionDraft = mentionDraft(initial);
  let formats: readonly ComposerFormat[] = [];
  const text = draft.text;
  function Editor() {
    const [value, setValue] = useState(draft);
    return (
      <EditableInput
        ref={ref}
        draft={value}
        value={value.text}
        disabled={false}
        placeholder="Draft"
        maxLength={options.maxLength ?? 16000}
        {...(options.onPasteTooLong
          ? { onPasteTooLong: options.onPasteTooLong }
          : {})}
        // Explicit recipients render as mention tokens, as in RichComposerInput.
        decorationsFor={(current) =>
          [
            ...current.recipients.map(({ start, end, name }) => ({
              start,
              end,
              content: <span data-mention>@{name}</span>,
            })),
            ...(options.links ? linkDecorations(current.text) : []),
          ].sort((a, b) => a.start - b.start)
        }
        {...(options.acceptRecipient
          ? { acceptRecipient: options.acceptRecipient }
          : {})}
        onFormatsChange={(active) => {
          formats = active;
        }}
        onDraftChange={(next) => {
          draft = next;
          setValue(next);
        }}
      />
    );
  }
  render(<Editor />, { reactStrictMode: true });
  const input = ref.current;
  if (!input) throw new Error("Editor did not mount");
  act(() => {
    input.focus();
    input.setSelectionRange(text.length, text.length);
    // jsdom's focus() collapses the selection onto the focused element after
    // its focus events, where a browser keeps the caret the editor placed, and
    // reports that in a later task; ProseMirror puts its caret back on that
    // selectionchange. Deliver it now: an empty draft moves no selection above,
    // so a key typed before the task would land outside the paragraph.
    document.dispatchEvent(new Event("selectionchange"));
  });
  return {
    input,
    user: userEvent.setup(),
    markdown: () => composerMarkdown(draft),
    draft: () => draft,
    /** The formats last reported to the toolbar. */
    formats: () => formats,
  };
}

it("types the first character into the empty paragraph with no task between focus and the key", async () => {
  const h = mount();
  // The ordering a loaded runner produces: user-event's wait before the key
  // fires before jsdom's queued selectionchange. With no delay, nothing runs
  // between mount and the keystroke at all.
  await userEvent.setup({ delay: null }).keyboard("`");
  expect(h.input.innerHTML).toBe("<p>`</p>");
  expect(h.draft().text).toBe("`");
});

it("refuses a closing-colon conversion when its literal undo source exceeds the limit", () => {
  const h = mount(":-1", { maxLength: 3 });
  act(() =>
    expect(h.input.insertText("👎", undefined, { start: 0, end: 3 }, ":")).toBe(
      false,
    ),
  );
  expect(h.input).toHaveValue(":-1");
  expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([3, 3]);
});

it("keeps exactly one typed colon when the conversion exceeds the limit", () => {
  const h = mount(":x", { maxLength: 3 });
  act(() =>
    expect(
      h.input.insertText("too long", undefined, { start: 0, end: 2 }, ":"),
    ).toBe(true),
  );
  expect(h.input).toHaveValue(":x:");
  expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([3, 3]);
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue(":x");
});

it("keeps native autocorrection off until this device opts in, then follows the choice live", async () => {
  try {
    const h = mount("teh");
    expect(h.input).toHaveAttribute("spellcheck", "true");
    expect(h.input).toHaveAttribute("autocorrect", "off");
    act(() => setMessageAutocorrectPreference(true));
    expect(h.input).toHaveAttribute("autocorrect", "on");
    expect(h.input).toHaveAttribute("spellcheck", "true");
    expect(h.input.selectionStart).toBe(3);
    await h.user.keyboard("!");
    expect(h.markdown()).toBe("teh!");
    act(() => setMessageAutocorrectPreference(false));
    expect(h.input).toHaveAttribute("autocorrect", "off");
  } finally {
    act(() => setMessageAutocorrectPreference(false));
    localStorage.removeItem("buzz-message-autocorrect.v1");
  }
});

it("reads value and selection from one projection per document", async () => {
  const h = mount("alpha beta");
  const read = () => [
    h.input.value,
    h.input.selectionStart,
    h.input.selectionEnd,
  ];
  read();
  // Each projection snapshots the document once; reads reuse it until it changes.
  const snapshots = vi.spyOn(EditorNode.prototype, "toJSON");
  const projections = () =>
    snapshots.mock.contexts.filter(
      (node) => (node as EditorNode).type.name === "doc",
    ).length;
  const reads = (expected: unknown[]) => {
    snapshots.mockClear();
    for (let i = 0; i < 3; i++) expect(read()).toEqual(expected);
    expect(projections()).toBeLessThanOrEqual(1);
  };
  try {
    act(() => h.input.setSelectionRange(2, 5));
    snapshots.mockClear();
    expect(read()).toEqual(["alpha beta", 2, 5]);
    act(() => h.input.setSelectionRange(10, 10));
    expect(read()).toEqual(["alpha beta", 10, 10]);
    // Selection-only transactions keep the document's projection.
    expect(projections()).toBe(0);
    await h.user.keyboard("!");
    reads(["alpha beta!", 11, 11]);
    act(() => h.input.undo(false));
    reads(["alpha beta", 10, 10]);
    act(() => h.input.undo(true));
    reads(["alpha beta!", 11, 11]);
    act(() => h.input.reset(mentionDraft("replaced")));
    reads(["replaced", 0, 0]);
    act(() => {
      h.input.value = "set";
    });
    reads(["set", 3, 3]);
  } finally {
    snapshots.mockRestore();
  }
});

describe("blurred native selection", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["MacIntel", "Linux x86_64"])(
    "releases a WebKit caret while retaining its last native position on %s",
    (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      vi.spyOn(navigator, "vendor", "get").mockReturnValue(
        "Apple Computer, Inc.",
      );
      const h = mount("message");
      const node = h.input.querySelector("p")?.firstChild;
      if (!node) throw new Error("Editor text unavailable");
      // Blur can precede the selectionchange which would adopt this caret.
      document.getSelection()?.collapse(node, 2);
      act(() => fireEvent.blur(h.input));
      expect(document.getSelection()?.rangeCount).toBe(0);
      expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([2, 2]);
      act(() => h.input.focus());
      expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([2, 2]);
    },
  );

  it("keeps a selected WebKit range available after blur", () => {
    vi.spyOn(navigator, "vendor", "get").mockReturnValue(
      "Apple Computer, Inc.",
    );
    const h = mount("message");
    act(() => h.input.setSelectionRange(1, 4));
    act(() => fireEvent.blur(h.input));
    expect(document.getSelection()?.toString()).toBe("ess");
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([1, 4]);
  });

  it("leaves a caret owned by another surface alone", () => {
    vi.spyOn(navigator, "vendor", "get").mockReturnValue(
      "Apple Computer, Inc.",
    );
    const h = mount("message");
    const other = document.createTextNode("other surface");
    document.body.append(other);
    document.getSelection()?.collapse(other, 2);
    act(() => fireEvent.blur(h.input));
    expect(document.getSelection()?.anchorNode).toBe(other);
    expect(document.getSelection()?.anchorOffset).toBe(2);
    other.remove();
  });

  it("leaves Chromium's native caret alone", () => {
    vi.spyOn(navigator, "vendor", "get").mockReturnValue("Google Inc.");
    const h = mount("message");
    act(() => h.input.setSelectionRange(2, 2));
    act(() => fireEvent.blur(h.input));
    expect(document.getSelection()?.rangeCount).toBe(1);
  });
});

describe("Mac WebKit line breaks", () => {
  let clear: MockInstance<Selection["removeAllRanges"]>;
  beforeEach(() => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    clear = vi.spyOn(Selection.prototype, "removeAllRanges");
  });
  afterEach(() => vi.restoreAllMocks());
  /** The native caret ProseMirror wrote back. */
  const native = () => {
    const selection = document.getSelection();
    return [
      selection?.rangeCount,
      selection?.isCollapsed,
      selection?.anchorNode?.textContent,
      selection?.anchorOffset,
    ];
  };

  it.each([false, true])(
    "refreshes an accepted collapsed caret and restores it natively (code block: %s)",
    (code) => {
      const h = mount("ab");
      if (code) act(() => h.input.toggleFormat("code_block"));
      act(() => h.input.setSelectionRange(1, 1));
      clear.mockClear();
      act(() => expect(h.input.insertLineBreak()).toBe(true));
      expect(clear).toHaveBeenCalledTimes(1);
      expect(h.input).toHaveValue("a\nb");
      expect(h.input.selectionStart).toBe(2);
      expect(h.input.selectionEnd).toBe(2);
      expect(native()).toEqual([1, true, "a\nb", 2]);
    },
  );

  it.each([
    ["paragraph", 2],
    ["code block", "```\nab\n```".length],
  ] as const)(
    "restores the caret after a rejected %s line break",
    (kind, maxLength) => {
      const h = mount("ab", { maxLength });
      if (kind === "code block") act(() => h.input.toggleFormat("code_block"));
      act(() => h.input.setSelectionRange(1, 1));
      clear.mockClear();
      act(() => h.input.insertLineBreak());
      expect(clear).toHaveBeenCalledTimes(1);
      expect(h.input).toHaveValue("ab");
      expect(native()).toEqual([1, true, "ab", 1]);
    },
  );

  it("leaves a range selection alone", () => {
    const h = mount("ab");
    act(() => h.input.setSelectionRange(0, 2));
    clear.mockClear();
    act(() => expect(h.input.insertLineBreak()).toBe(true));
    expect(clear).not.toHaveBeenCalled();
  });

  it("returning focus resumes and repaints the editor's caret; a pointer places its own", () => {
    const text = "here is a message";
    const h = mount(text);
    act(() => h.input.setSelectionRange(2, 2));
    const stale = () => {
      act(() => h.input.blur());
      // While hidden, the native caret drifted from the editor's caret.
      const node = h.input.querySelector("p")?.firstChild;
      if (!node) throw new Error("Editor text unavailable");
      document.getSelection()?.collapse(node, 0);
      clear.mockClear();
    };
    // Browsers keep a selection already inside the focused editing root;
    // jsdom then collapses it to the start regardless, so observe it here.
    let painted: unknown[] = [];
    const observe = () => {
      painted = native();
    };
    document.addEventListener("focusin", observe);
    stale();
    act(() => h.input.focus());
    document.removeEventListener("focusin", observe);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.input.selectionStart).toBe(2);
    expect(painted).toEqual([1, true, text, 2]);

    stale();
    act(() => {
      fireEvent.pointerDown(h.input);
      h.input.focus();
      fireEvent.pointerUp(h.input);
    });
    expect(clear).not.toHaveBeenCalled();
  });

  it.each(["pointerUp", "pointerCancel"] as const)(
    "%s outside the editor retires pointer placement before returning focus",
    (release) => {
      const h = mount("message");
      act(() => h.input.setSelectionRange(2, 2));
      act(() => {
        fireEvent.pointerDown(h.input);
        fireEvent[release](document.body);
        h.input.blur();
      });
      clear.mockClear();
      act(() => h.input.focus());
      expect(clear).toHaveBeenCalledOnce();
      expect(h.input.selectionStart).toBe(2);
    },
  );

  it("leaves Chromium alone", () => {
    vi.spyOn(navigator, "vendor", "get").mockReturnValue("Google Inc.");
    const h = mount("ab");
    act(() => h.input.setSelectionRange(1, 1));
    clear.mockClear();
    act(() => expect(h.input.insertLineBreak()).toBe(true));
    expect(clear).not.toHaveBeenCalled();
  });

  it("preserves inline Markdown when a line break reaches the length limit", async () => {
    const h = mount("_abcd_", { maxLength: 11 });
    act(() => {
      h.input.setSelectionRange(0, 6);
      h.input.toggleFormat("bold");
      h.input.setSelectionRange(3, 3);
    });
    clear.mockClear();
    await h.user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.input.querySelectorAll(":scope > p")).toHaveLength(1);
    expect(h.input).toHaveValue("_ab\ncd_");
    expect(h.markdown()).toBe("**_ab\ncd_**");
  });

  it("preserves formatted pasted link source across a line break", async () => {
    const h = mount();
    const source = "[label](https://example.com)";
    paste(h.input, source);
    act(() => {
      h.input.setSelectionRange(0, source.length);
      h.input.toggleFormat("bold");
      h.input.setSelectionRange(4, 4);
    });
    clear.mockClear();
    await h.user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.input.querySelectorAll(":scope > p")).toHaveLength(1);
    expect(h.input).toHaveValue("[lab\nel](https://example.com) ");
    expect(h.markdown()).toBe("**[lab\nel](https://example.com)** ");
  });
});

/** Exercise ProseMirror's actual MutationObserver/readDOMChange seam, including
 * marksAcross on deletion. This is not a claim about native WebKit keystrokes. */
async function deleteCodeTail(input: ComposerInputElement, count = 1) {
  const previous = input.value;
  act(() => {
    input.focus();
    fireEvent(
      input,
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    const text = input.querySelector("code")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Code text did not mount");
    const selection = document.getSelection();
    if (!selection) throw new Error("DOM selection unavailable");
    const end = text.length - count;
    if (end) {
      text.deleteData(end, count);
      selection.collapse(text, end);
    } else {
      const paragraph = input.querySelector("p");
      if (!paragraph) throw new Error("Paragraph did not mount");
      paragraph.replaceChildren(document.createElement("br"));
      selection.collapse(paragraph, 0);
    }
  });
  await waitFor(() => expect(input).toHaveValue(previous.slice(0, -count)));
}

it("keeps explicit code mode through DOM deletions, but clears it after the last character", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("abc");
  await deleteCodeTail(h.input);
  await h.user.keyboard("d");
  expect(h.markdown()).toBe("`abd`");
  await deleteCodeTail(h.input);
  expect(h.markdown()).toBe("`ab`");
  act(() => h.input.undo(false));
  expect(h.markdown()).toBe("`abd`");
  act(() => h.input.undo(true));
  expect(h.markdown()).toBe("`ab`");
  await deleteCodeTail(h.input, 2);
  await h.user.keyboard("plain");
  expect(h.markdown()).toBe("plain");
});

it.each(["typed", "explicit-off"])(
  "does not reenable code after deletion in %s mode",
  async (mode) => {
    const h = mount();
    if (mode === "typed") await h.user.keyboard("`abc`");
    else {
      act(() => h.input.toggleFormat("code"));
      await h.user.keyboard("abc");
      act(() => h.input.toggleFormat("code"));
    }
    await deleteCodeTail(h.input);
    await h.user.keyboard("d");
    expect(h.markdown()).toBe("`ab`d");
  },
);

it("does not borrow backticks inside existing rich code for a newly typed span", async () => {
  const h = mount("`");
  act(() => {
    h.input.setSelectionRange(0, 1);
    h.input.toggleFormat("code");
    h.input.setSelectionRange(1, 1);
  });
  await h.user.keyboard(" `next`!");
  expect(h.input.querySelectorAll("code")).toHaveLength(2);
  expect(h.input.querySelectorAll("code")[1]).toHaveTextContent("next");
  expect(h.input).toHaveValue("` next!");
  expect(h.markdown()).toBe("`` ` `` `next`!");
});

it("clearing all code and reentering a code edge leaves subsequent prose unmarked", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("abc");
  act(() => h.input.setSelectionRange(3, 3));
  await h.user.keyboard("plain");
  expect(h.markdown()).toBe("`abc`plain");
  act(() => {
    h.input.setSelectionRange(0, h.input.value.length);
    h.input.insertText("");
  });
  await h.user.keyboard("outside");
  expect(h.markdown()).toBe("outside");
});

it("converts typed **Hello** on the closing delimiter, keeps later typing plain and undoes in one step", async () => {
  const h = mount();
  await h.user.keyboard("**Hello**");
  expect(h.input.querySelector("strong")).toHaveTextContent("Hello");
  expect(h.input).toHaveValue("Hello");
  expect(h.markdown()).toBe("**Hello**");
  await h.user.keyboard(" world");
  expect(h.input.querySelector("strong")).toHaveTextContent("Hello");
  expect(h.markdown()).toBe("**Hello** world");
  // The prose typed next is its own step; one more undo restores the source.
  act(() => h.input.undo(false));
  expect(h.markdown()).toBe("**Hello**");
  act(() => h.input.undo(false));
  expect(h.input.querySelector("strong")).toBeNull();
  expect(h.input).toHaveValue("**Hello**");
  act(() => h.input.undo(true));
  expect(h.input.querySelector("strong")).toHaveTextContent("Hello");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.input.querySelector("strong")).toHaveTextContent("Hello");
  expect(h.markdown()).toBe("**Hello**");
});

it("one undo after a typed code span restores the closing backtick too", async () => {
  const h = mount();
  await h.user.keyboard("`abc`");
  expect(h.markdown()).toBe("`abc`");
  act(() => h.input.undo(false));
  expect(h.input.querySelector("code")).toBeNull();
  expect(h.input).toHaveValue("`abc`");
});

it.each([
  ["__x__", "strong", "**x**"],
  ["*x*", "em", "_x_"],
  ["_x_", "em", "_x_"],
  ["~~x~~", "s", "~~x~~"],
])(
  "converts typed %s and sends the serializer's canonical delimiters",
  async (typed, tag, wire) => {
    const h = mount();
    await h.user.keyboard(typed);
    expect(h.input.querySelector(tag)).toHaveTextContent("x");
    expect(h.input).toHaveValue("x");
    expect(h.markdown()).toBe(wire);
  },
);

it("adds both marks for ***x*** and leaves ~x~ literal", async () => {
  const h = mount();
  await h.user.keyboard("***x***");
  expect(h.input.querySelector("em strong, strong em")).toHaveTextContent("x");
  expect(h.input).toHaveValue("x");
  expect(h.markdown()).toBe("**_x_**");
  await h.user.keyboard(" ~y~");
  expect(h.input.querySelector("s")).toBeNull();
  expect(h.input).toHaveValue("x ~y~");
  expect(h.markdown()).toBe("**_x_** ~y~");
});

it("waits for the whole closing run instead of italicising midway through **a** or ***b***", async () => {
  const h = mount();
  await h.user.keyboard("**a*");
  expect(h.input.querySelector("em, strong")).toBeNull();
  expect(h.input).toHaveValue("**a*");
  await h.user.keyboard("*");
  expect(h.input.querySelector("strong")).toHaveTextContent("a");
  expect(h.input.querySelector("em")).toBeNull();
  expect(h.markdown()).toBe("**a**");
  // A run touching the span's opener is unfinished whichever of its
  // characters sits beside the span.
  await h.user.keyboard(" ***b*");
  expect(h.input).toHaveValue("a ***b*");
  expect(h.input.querySelector("em")).toBeNull();
  await h.user.keyboard("*");
  expect(h.input).toHaveValue("a ***b**");
  expect(h.input.querySelectorAll("strong")).toHaveLength(1);
  await h.user.keyboard("*");
  expect(h.input).toHaveValue("a b");
  expect(h.markdown()).toBe("**a** **_b_**");
});

it.each([
  ["snake_case _x_", "snake_case ", "x"],
  ["file_name and _important_", "file_name and ", "important"],
  ["5 * 3 is *great*", "5 * 3 is ", "great"],
])(
  "converts %s: an earlier literal delimiter blocks only a span it touches",
  async (typed, before, inner) => {
    const h = mount();
    await h.user.keyboard(typed);
    expect(h.input.querySelectorAll("em")).toHaveLength(1);
    expect(h.input.querySelector("em")).toHaveTextContent(inner);
    expect(h.input).toHaveValue(before + inner);
    expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: before },
        { type: "emphasis", children: [{ type: "text", value: inner }] },
      ],
    });
  },
);

it("follows the parser for intraword delimiters: snake_case stays literal, 5*3*2 italicises 3", async () => {
  const h = mount();
  await h.user.keyboard("snake_case_more 5*3*2");
  expect(h.input.querySelectorAll("em")).toHaveLength(1);
  expect(h.input.querySelector("em")).toHaveTextContent("3");
  expect(h.input).toHaveValue("snake_case_more 532");
  // The wire keeps the typed asterisks, which form intraword where _ would
  // need its neighbours encoded, so raw readers see the source as typed.
  expect(h.markdown()).toBe("snake_case_more 5*3*2");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "snake_case_more 5" },
      { type: "emphasis", children: [{ type: "text", value: "3" }] },
      { type: "text", value: "2" },
    ],
  });
  act(() => h.input.setSelectionRange(0, h.input.value.length));
  const copied = clipboard(h.input, "copy");
  const target = mount();
  paste(target.input, copied.text ?? "", copied.html);
  expect(target.markdown()).toBe(h.markdown());
});

it.each(["a*b**", "a*b**c"])(
  "preserves displayed emphasis when sending %s",
  async (typed) => {
    const h = mount();
    await h.user.keyboard(typed);
    expect(h.input.querySelector("em")).toHaveTextContent("b");
    expect(h.markdown()).toBe(`a*b*\\${typed.slice(4)}`);
    expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "a" },
        { type: "emphasis", children: [{ type: "text", value: "b" }] },
        { type: "text", value: typed.slice(4) },
      ],
    });
  },
);

it("preserves toolbar italics after a typed literal asterisk", async () => {
  const h = mount();
  await h.user.keyboard("5*");
  act(() => h.input.toggleFormat("italic"));
  await h.user.keyboard("x");
  act(() => h.input.toggleFormat("italic"));
  await h.user.keyboard("y");
  expect(h.input.querySelector("em")).toHaveTextContent("x");
  expect(h.markdown()).toBe("5\\**x*y");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "5*" },
      { type: "emphasis", children: [{ type: "text", value: "x" }] },
      { type: "text", value: "y" },
    ],
  });
});

it.each(["paste", "restore"])(
  "preserves toolbar italics after an unmatched authored asterisk run arrived by %s",
  async (mode) => {
    const h = mount(mode === "restore" ? "a*b**" : "");
    if (mode === "paste") paste(h.input, "a*b**");
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard("x");
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard("y");
    expect(h.input).toHaveValue("a*b**xy");
    expect(h.input.querySelector("em")).toHaveTextContent("x");
    // The literal run after a can open emphasis, so with only the trailing
    // run escaped the parser read a*b\*\**x*y as emphasis("b**") then x*y.
    expect(h.markdown()).toBe("a\\*b\\*\\**x*y");
    expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "a*b**" },
        { type: "emphasis", children: [{ type: "text", value: "x" }] },
        { type: "text", value: "y" },
      ],
    });
  },
);

it("keeps an unmatched asterisk run pasted after generated italics literal", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("italic"));
  await h.user.keyboard("x");
  act(() => h.input.toggleFormat("italic"));
  paste(h.input, "**b*c");
  expect(h.input).toHaveValue("x**b*c");
  expect(h.input.querySelectorAll("em")).toHaveLength(1);
  expect(h.markdown()).toBe("_x_**b*c");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "emphasis", children: [{ type: "text", value: "x" }] },
      { type: "text", value: "**b*c" },
    ],
  });
});

/** Render the actual send payload, including signed recipients, through the timeline. */
function renderDraft(draft: MentionDraft) {
  const open = vi.fn(() => true);
  const view = render(
    <MessageMarkdown
      row={{
        id: "sent",
        channelId: "channel",
        authorId: "author",
        createdAt: 1,
        content: composerMarkdown(draft),
        mentions: draft.recipients.map(({ pubkey }) => pubkey),
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      participantProfiles={
        new Map(draft.recipients.map(({ pubkey, name }) => [pubkey, { name }]))
      }
      media={() => undefined}
      onOpenLink={open}
      canOpenLink={() => true}
    />,
  );
  return { ...view, open };
}

it.each([
  ["paste", "`a*b`", "inlineCode"],
  ["restore", "`a*b`", "inlineCode"],
  ["paste", "<https://example.com/a*b>", "link"],
  ["restore", "<https://example.com/a*b>", "link"],
])(
  "preserves %s authored %s before toolbar bold",
  async (mode, authored, type) => {
    const source = `${authored} then `;
    const h = mount(mode === "restore" ? source : "");
    if (mode === "paste") paste(h.input, source);
    act(() => h.input.toggleFormat("bold"));
    await h.user.keyboard("c");
    expect(h.input.querySelector("strong")).toHaveTextContent("c");
    expect(h.markdown()).toBe(`${source}**c**`);
    expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        type === "inlineCode"
          ? { type, value: "a*b" }
          : { type, url: "https://example.com/a*b" },
        { type: "text", value: " then " },
        { type: "strong", children: [{ type: "text", value: "c" }] },
      ],
    });
    const sent = renderDraft(h.draft());
    if (type === "inlineCode")
      expect(sent.container.querySelector("code")?.textContent).toBe("a*b");
    else
      expect(sent.container.querySelector("a")).toHaveAttribute(
        "href",
        "https://example.com/a*b",
      );
    expect(sent.container.querySelector("strong")?.textContent).toBe("c");
  },
);

it.each([
  ["paste", "**Note**", "strong"],
  ["restore", "**Note**", "strong"],
  ["paste", "*Note*", "em"],
  ["restore", "*Note*", "em"],
])(
  "preserves %s authored %s on both sides of generated italics",
  async (mode, source, tag) => {
    const h = mount(mode === "restore" ? source : "");
    if (mode === "paste") paste(h.input, source);
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard("x");
    expect(h.markdown()).toBe(`${source}_x_`);
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard("y");
    const after = renderDraft(h.draft());
    expect(after.container.querySelector(tag)).toHaveTextContent("Note");
    expect(after.container.querySelector("em:last-child")).toHaveTextContent(
      "x",
    );
    expect(after.container).toHaveTextContent("Notexy");
    const type = tag === "em" ? "emphasis" : tag;
    expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type, children: [{ type: "text", value: "Note" }] },
        { type: "emphasis", children: [{ type: "text", value: "x" }] },
        { type: "text", value: "y" },
      ],
    });
    after.unmount();
    act(() => {
      h.input.reset(mentionDraft(mode === "restore" ? source : ""));
    });
    if (mode === "paste") paste(h.input, source);
    act(() => h.input.setSelectionRange(0, 0));
    await h.user.keyboard("a");
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard("x");
    const before = renderDraft(h.draft());
    expect(
      before.container.querySelector(`${tag}:last-child`),
    ).toHaveTextContent("Note");
    expect(before.container.querySelector("em")).toHaveTextContent("x");
    expect(before.container).toHaveTextContent("axNote");
    expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "a" },
        { type: "emphasis", children: [{ type: "text", value: "x" }] },
        { type, children: [{ type: "text", value: "Note" }] },
      ],
    });
  },
);

it.each([
  [false, "c "],
  [true, "c "],
  [false, " "],
  [true, " "],
])(
  "preserves star-suffixed recipient identity beside italic punctuation (prefix collision=%s, suffix=%s)",
  async (collision, suffix) => {
    const h = mount();
    const starred = { pubkey: "a".repeat(64), name: "Honey*" };
    const shorter = { pubkey: "b".repeat(64), name: "Honey" };
    act(() => {
      h.input.insertText("", starred);
      h.input.setSelectionRange(7, 8);
      h.input.insertText("");
      h.input.toggleFormat("italic");
    });
    await h.user.keyboard("!");
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard(suffix);
    if (collision) act(() => h.input.insertText("", shorter));
    expect(h.draft().recipients.map(({ pubkey }) => pubkey)).toEqual(
      collision ? [starred.pubkey, shorter.pubkey] : [starred.pubkey],
    );
    const sent = renderDraft(h.draft());
    const starButton = sent.getByRole("button", {
      name: "View Honey* profile",
    });
    fireEvent.click(starButton);
    expect(sent.open).toHaveBeenLastCalledWith(profileTarget(starred.pubkey));
    if (collision) {
      fireEvent.click(sent.getByRole("button", { name: "View Honey profile" }));
      expect(sent.open).toHaveBeenLastCalledWith(profileTarget(shorter.pubkey));
    }
    expect(sent.container.querySelectorAll("button")).toHaveLength(
      collision ? 2 : 1,
    );
    expect(sent.container.querySelector("em")).toHaveTextContent("!");
    expect(sent.container).toHaveTextContent(
      `Honey*!${suffix}${collision ? "Honey" : ""}`.trim(),
    );
  },
);

it("keeps source offsets when a raw span has both a leading star and a star-suffixed recipient", async () => {
  const h = mount();
  const starred = { pubkey: "a".repeat(64), name: "Honey*" };
  const shorter = { pubkey: "b".repeat(64), name: "Honey" };
  await h.user.keyboard("a*b** see ");
  act(() => {
    h.input.insertText("", starred);
    h.input.setSelectionRange(h.input.value.length - 1, h.input.value.length);
    h.input.insertText("");
    h.input.toggleFormat("italic");
  });
  await h.user.keyboard("!");
  act(() => h.input.toggleFormat("italic"));
  await h.user.keyboard("c ");
  act(() => h.input.insertText("", shorter));
  const sent = renderDraft(h.draft());
  fireEvent.click(sent.getByRole("button", { name: "View Honey* profile" }));
  expect(sent.open).toHaveBeenLastCalledWith(profileTarget(starred.pubkey));
  fireEvent.click(sent.getByRole("button", { name: "View Honey profile" }));
  expect(sent.open).toHaveBeenLastCalledWith(profileTarget(shorter.pubkey));
  expect(
    [...sent.container.querySelectorAll("em")].map((el) => el.textContent),
  ).toEqual(["b", "!"]);
  expect(sent.container).toHaveTextContent("ab* see Honey*!c Honey");
});

it("preserves italic punctuation immediately before a signed mention", async () => {
  const h = mount("a");
  const honey = { pubkey: "a".repeat(64), name: "Honey" };
  act(() => h.input.toggleFormat("italic"));
  await h.user.keyboard("!");
  act(() => {
    h.input.toggleFormat("italic");
    h.input.insertText("", honey);
  });
  const sent = renderDraft(h.draft());
  expect(sent.container.querySelector("em")).toHaveTextContent("!");
  fireEvent.click(sent.getByRole("button", { name: "View Honey profile" }));
  expect(sent.open).toHaveBeenLastCalledWith(profileTarget(honey.pubkey));
  expect(sent.container).toHaveTextContent("a!Honey");
});

it("converts a span typed on a heading line, which the timeline renders as a heading", async () => {
  const h = mount();
  await h.user.keyboard("# Title **bold**");
  expect(h.input.querySelector("strong")).toHaveTextContent("bold");
  expect(h.input).toHaveValue("# Title bold");
  expect(h.markdown()).toBe("# Title **bold**");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "heading",
    depth: 1,
    children: [
      { type: "text", value: "Title " },
      { type: "strong", children: [{ type: "text", value: "bold" }] },
    ],
  });
});

it("leaves delimiters typed inside inline code or a code block literal", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("**x**");
  act(() => h.input.toggleFormat("code"));
  expect(h.input.querySelector("strong")).toBeNull();
  expect(h.input.querySelector("code")).toHaveTextContent("**x**");
  expect(h.markdown()).toBe("`**x**`");
  const block = mount();
  act(() => block.input.toggleFormat("code_block"));
  await block.user.keyboard("_y_ ~~z~~");
  expect(block.input.querySelector("em, s")).toBeNull();
  expect(block.markdown()).toBe("```\n_y_ ~~z~~\n```");
});

it.each([true, false])(
  "leaves delimiters around a link label (linked=%s) and pasted delimiters literal",
  async (linked) => {
    const h = mount("**label");
    act(() => {
      h.input.setSelectionRange(2, 7);
      const edit = h.input.editLink();
      if (!edit) throw new Error("Link editing unavailable");
      if (linked) edit.save("label", "https://example.com");
      else edit.remove();
      h.input.setSelectionRange(7, 7);
    });
    await h.user.keyboard("**");
    expect(h.input.querySelector("strong")).toBeNull();
    expect(h.input).toHaveValue("**label**");
    expect(h.markdown()).toBe(
      linked ? "**[label](https://example.com/)**" : "**label**",
    );
    act(() => {
      h.input.setSelectionRange(0, h.input.value.length);
      h.input.insertText("**pasted** _source_");
    });
    expect(h.input.querySelector("strong, em")).toBeNull();
    expect(h.markdown()).toBe("**pasted** _source_");
  },
);

it("adds and edits HTTP links through the composer, but rejects credentialed URLs", () => {
  const h = mount("docs", { links: true });
  act(() => h.input.setSelectionRange(0, 4));
  const add = h.input.editLink();
  expect(add?.existing).toBe(false);
  act(() => expect(add?.save("docs", "http://example.com/docs")).toBe(true));
  expect(h.markdown()).toBe("[docs](http://example.com/docs)");

  act(() => h.input.setSelectionRange(1, 1));
  const edit = h.input.editLink();
  expect(edit).toMatchObject({
    existing: true,
    href: "http://example.com/docs",
  });
  act(() => expect(edit?.save("guide", "http://localhost:3000")).toBe(true));
  expect(h.markdown()).toBe("[guide](http://localhost:3000/)");

  act(() => h.input.setSelectionRange(1, 1));
  const unsafe = h.input.editLink();
  act(() =>
    expect(unsafe?.save("guide", "http://user:pw@example.com")).toBe(false),
  );
  expect(h.markdown()).toBe("[guide](http://localhost:3000/)");
});

it("edits a detected plain HTTP link", () => {
  const h = mount("See http://localhost:3000", { links: true });
  act(() => h.input.setSelectionRange(8, 8));
  const edit = h.input.editLink();
  expect(edit).toMatchObject({ existing: true, href: "http://localhost:3000" });
  act(() => expect(edit?.save("local", "http://localhost:3000")).toBe(true));
  expect(h.markdown()).toBe("See [local](http://localhost:3000/)");
});

describe("pasting a bare URL over a selection", () => {
  const url = "https://example.com/release-notes";
  const linked = `Check the [release notes](${url}) before Friday`;
  /** Mount the sample sentence with "release notes" selected. */
  function selectNotes(text = "Check the release notes before Friday") {
    const h = mount(text);
    act(() => h.input.setSelectionRange(10, 23));
    return h;
  }

  it("links the selection as one undo step and leaves the caret unlinked", async () => {
    const h = selectNotes();
    paste(h.input, url);
    expect(h.markdown()).toBe(linked);
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([23, 23]);
    await h.user.keyboard("!");
    expect(h.markdown()).toBe(
      `Check the [release notes](${url})! before Friday`,
    );
    act(() => h.input.undo(false));
    expect(h.markdown()).toBe(linked);
    act(() => h.input.undo(false));
    expect(h.markdown()).toBe("Check the release notes before Friday");
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([10, 23]);
  });

  it.each([
    ["a trailing newline", `${url}\n`, ""],
    ["a trailing space", `${url} `, ""],
    ["the <autolink> form", `<${url}>`, ""],
    ["an HTML anchor labelled by its URL", url, `<a href="${url}">${url}</a>`],
  ])("links the selection from a clipboard with %s", (_name, text, html) => {
    const h = selectNotes();
    paste(h.input, text, html);
    expect(h.markdown()).toBe(linked);
  });

  it("still pastes an HTML anchor with its own label over the selection", () => {
    const h = selectNotes();
    paste(h.input, "Release notes", `<a href="${url}">Release notes</a>`);
    expect(h.markdown()).toBe(
      `Check the [Release notes](${url}) before Friday`,
    );
  });

  it("keeps bold and mention tokens inside the new link", () => {
    const bold = selectNotes();
    act(() => {
      bold.input.setSelectionRange(10, 17);
      bold.input.toggleFormat("bold");
      bold.input.setSelectionRange(10, 23);
    });
    paste(bold.input, url);
    expect(bold.markdown()).toBe(
      `Check the [**release** notes](${url}) before Friday`,
    );

    const h = mount("Check the ");
    const honey = { pubkey: "a".repeat(64), name: "Honey" };
    act(() => h.input.insertText("", honey));
    act(() => h.input.insertText("notes before Friday"));
    const recipients = h.draft().recipients;
    expect(recipients).toEqual([{ ...honey, start: 10, end: 16 }]);
    act(() => h.input.setSelectionRange(10, 22));
    paste(h.input, url);
    expect(h.markdown()).toBe(`Check the [@Honey notes](${url}) before Friday`);
    expect(h.draft().recipients).toEqual(recipients);
  });

  it("re-targets a fully selected link and splits a partially selected one", () => {
    const old = "https://old.example/x";
    const whole = selectNotes();
    act(() => whole.input.editLink()?.save("release notes", old));
    act(() => whole.input.setSelectionRange(10, 23));
    paste(whole.input, url);
    expect(whole.markdown()).toBe(linked);

    // A selection inside the link widens to the whole link, as the Link dialog
    // does, and leaves the caret after it.
    const inside = selectNotes();
    act(() => inside.input.editLink()?.save("release notes", old));
    act(() => inside.input.setSelectionRange(10, 17));
    paste(inside.input, url);
    expect(inside.markdown()).toBe(linked);
    expect([inside.input.selectionStart, inside.input.selectionEnd]).toEqual([
      23, 23,
    ]);

    // The selected part follows the pasted URL; the rest keeps its destination.
    const partial = selectNotes();
    act(() => partial.input.editLink()?.save("release notes", old));
    act(() => partial.input.setSelectionRange(6, 17));
    paste(partial.input, url);
    expect(partial.markdown()).toBe(
      `Check [the release](${url})[ notes](${old}) before Friday`,
    );
  });

  it("swaps a selected URL instead of labelling it", () => {
    const old = "https://old.example/x";
    const raw = mount(`Check ${old} before Friday`);
    act(() => raw.input.setSelectionRange(6, 27));
    paste(raw.input, url);
    expect(raw.markdown()).toBe(`Check ${url} before Friday`);

    const labelled = mount(`Check ${old} before Friday`);
    act(() => labelled.input.setSelectionRange(6, 27));
    act(() => labelled.input.editLink()?.save(old, "https://other.example/"));
    act(() => labelled.input.setSelectionRange(6, 27));
    paste(labelled.input, url);
    expect(labelled.markdown()).toBe(`Check ${url} before Friday`);
  });

  it.each([
    ["other text", "changelog", "Check the changelog before Friday"],
    [
      "a credentialed URL",
      "http://user:pw@example.com",
      "Check the http://user:pw@example.com before Friday",
    ],
  ])("replaces the selection with %s", (_name, text, expected) => {
    const h = selectNotes();
    paste(h.input, text);
    expect(h.markdown()).toBe(expected);
  });

  it("replaces a multi-line or whitespace-only selection", () => {
    const lines = mount("Check the\nrelease notes");
    act(() => lines.input.setSelectionRange(6, 17));
    paste(lines.input, url);
    expect(lines.markdown()).toBe(`Check ${url} notes`);

    const space = mount("Check the release notes before Friday");
    act(() => space.input.setSelectionRange(9, 10));
    paste(space.input, url);
    expect(space.markdown()).toBe(
      `Check the${url} release notes before Friday`,
    );
  });

  it("pastes verbatim inside code", () => {
    const block = mount("```\nrelease notes\n```");
    act(() => block.input.setSelectionRange(4, 17));
    paste(block.input, url);
    expect(block.markdown()).toBe(`\`\`\`\n${url} \n\`\`\``);

    const inline = mount("Check the `release notes` before");
    act(() => inline.input.setSelectionRange(11, 24));
    paste(inline.input, url);
    expect(inline.markdown()).toBe(`Check the \`${url} \` before`);
  });

  it("falls back to the limit check when the link would exceed maxLength", () => {
    const h = mount("Check the release notes before Friday", { maxLength: 60 });
    act(() => h.input.setSelectionRange(10, 23));
    paste(h.input, url);
    expect(h.markdown()).toBe(`Check the ${url} before Friday`);
  });

  it("keeps inserting a URL at a collapsed caret with the trailing space", () => {
    const h = mount("Check the release notes before Friday");
    act(() => h.input.setSelectionRange(10, 10));
    paste(h.input, url);
    expect(h.markdown()).toBe(`Check the ${url} release notes before Friday`);
    expect(h.input.selectionStart).toBe(44);
    act(() => h.input.setSelectionRange(9, 9));
    paste(h.input, url);
    expect(h.markdown()).toBe(
      `Check the${url} ${url} release notes before Friday`,
    );
  });
});

/** Mod+Shift+V: the chord's keydown, then the paste event its native command fires. */
function pasteRaw(
  input: ComposerInputElement,
  text: string,
  html = "",
  chord: Partial<KeyboardEventInit> = { key: "V", ctrlKey: true },
) {
  act(() => {
    input.focus();
    fireEvent.keyDown(input, { code: "KeyV", shiftKey: true, ...chord });
  });
  paste(input, text, html);
}

describe("Mod+Shift+V pastes plain text verbatim", () => {
  const url = "https://example.com/release-notes";
  const chord = { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true };

  it("ignores rich flavors, this app's included, and keeps Markdown and line breaks literal", () => {
    const h = mount("", { links: true });
    const text =
      "**bold** and [docs](https://example.com/)\n\n> quote\n- one\n- two";
    pasteRaw(
      h.input,
      text,
      copyHtml(
        '<p><strong>bold</strong> and <a href="https://example.com/">docs</a></p><blockquote><p>quote</p></blockquote><ul><li><p>one</p></li><li><p>two</p></li></ul>',
      ),
    );
    expect(h.markdown()).toBe(text);
    expect(h.input.querySelector("strong, blockquote, ul")).toBeNull();
    const external = mount();
    pasteRaw(
      external.input,
      "Read the guide",
      '<p>Read <a href="https://example.com/guide"><b>the guide</b></a></p>',
    );
    expect(external.markdown()).toBe("Read the guide");
  });

  it("replaces a selection with a URL as text in one undo step", () => {
    const h = mount("Check the release notes before Friday");
    act(() => h.input.setSelectionRange(10, 23));
    pasteRaw(h.input, url);
    expect(h.markdown()).toBe(`Check the ${url} before Friday`);
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([43, 43]);
    act(() => h.input.undo(false));
    expect(h.markdown()).toBe("Check the release notes before Friday");
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([10, 23]);
    act(() => h.input.undo(true));
    expect(h.markdown()).toBe(`Check the ${url} before Friday`);
  });

  it("takes the caret's formatting and leaves identity links as source", () => {
    const accept = vi.fn((pubkey: string) => ({ pubkey, name: "Mic" }));
    const h = mount("", { links: true, acceptRecipient: accept });
    act(() => h.input.toggleFormat("bold"));
    pasteRaw(h.input, `Ping ${micLink}`);
    expect(h.markdown()).toBe(`**Ping ${micLink}**`);
    expect(h.draft().recipients).toEqual([]);
    expect(accept).not.toHaveBeenCalled();
  });

  it("inserts nothing for a clipboard without text", () => {
    const h = mount("draft");
    pasteRaw(h.input, "");
    expect(h.markdown()).toBe("draft");
    act(() => {
      fireEvent.keyDown(h.input, chord);
      fireEvent.paste(h.input, {
        clipboardData: {
          items: [{ kind: "file" }],
          getData: (type: string) => (type === "text/plain" ? "name.png" : ""),
        },
      });
    });
    expect(h.markdown()).toBe("draft");
  });

  it("takes Apple chords on Apple platforms only", () => {
    const platform = vi.spyOn(navigator, "platform", "get");
    try {
      platform.mockReturnValue("MacIntel");
      for (const apple of [
        { key: "V", metaKey: true },
        // Option+Shift+V types ◊; the physical key still names the chord.
        { key: "◊", metaKey: true, altKey: true },
      ]) {
        const h = mount("Check the release notes");
        act(() => h.input.setSelectionRange(10, 23));
        pasteRaw(h.input, url, "", apple);
        expect(h.markdown()).toBe(`Check the ${url}`);
      }
      const control = mount("Check the release notes");
      act(() => control.input.setSelectionRange(10, 23));
      pasteRaw(control.input, url);
      expect(control.markdown()).toBe(`Check the [release notes](${url})`);
    } finally {
      platform.mockRestore();
    }
  });

  it("pastes verbatim after the desktop menu's request without a key", () => {
    const h = mount("Check the release notes");
    act(() => h.input.setSelectionRange(10, 23));
    act(() => {
      h.input.focus();
      h.input.dispatchEvent(new Event("buzz:paste-plain"));
    });
    paste(h.input, url);
    expect(h.markdown()).toBe(`Check the ${url}`);
    // The request covers one paste.
    act(() => h.input.setSelectionRange(0, 5));
    paste(h.input, url);
    expect(h.markdown()).toBe(`[Check](${url}) the ${url}`);
  });

  it.each([
    [
      "the chord is released",
      (input: Element) => fireEvent.keyUp(input, { key: "Shift" }),
    ],
    ["the pointer goes down", (input: Element) => fireEvent.mouseDown(input)],
    [
      "another key goes down",
      (input: Element) =>
        fireEvent.keyDown(input, { key: "v", code: "KeyV", ctrlKey: true }),
    ],
  ])("leaves a later paste ordinary once %s", (_name, after) => {
    const h = mount("Check the release notes");
    act(() => {
      fireEvent.keyDown(h.input, chord);
      after(h.input);
    });
    act(() => h.input.setSelectionRange(10, 23));
    paste(h.input, url);
    expect(h.markdown()).toBe(`Check the [release notes](${url})`);
  });
});

it("bolds a mention typed between delimiters and keeps its chip and recipient", async () => {
  const h = mount();
  const honey = { pubkey: "a".repeat(64), name: "Honey" };
  await h.user.keyboard("**");
  act(() => h.input.insertText("", honey));
  expect(h.input).toHaveValue("**@Honey ");
  act(() => h.input.setSelectionRange(8, 8));
  await h.user.keyboard("**");
  expect(h.input).toHaveValue("@Honey ");
  expect(h.input.querySelector('strong [data-source="@Honey"]')).not.toBeNull();
  expect(h.draft().recipients).toEqual([{ ...honey, start: 0, end: 6 }]);
  expect(h.markdown()).toBe("**@Honey** ");
});

it("italicises a mention typed between asterisks and sends a form the timeline still binds", async () => {
  const h = mount();
  const honey = { pubkey: "a".repeat(64), name: "Honey" };
  await h.user.keyboard("*");
  act(() => h.input.insertText("", honey));
  expect(h.input).toHaveValue("*@Honey ");
  act(() => h.input.setSelectionRange(7, 7));
  await h.user.keyboard("*");
  expect(h.input).toHaveValue("@Honey ");
  expect(h.input.querySelector('em [data-source="@Honey"]')).not.toBeNull();
  expect(h.draft().recipients).toEqual([{ ...honey, start: 0, end: 6 }]);
  // _@Honey_ would render italic but never bind: _ is a name character.
  expect(h.markdown()).toBe("*@Honey* ");
  expect(
    profileMentionParts(
      { content: h.markdown(), mentions: [honey.pubkey] },
      new Map([[honey.pubkey, { name: honey.name }]]),
    ),
  ).toEqual([
    { text: "*" },
    { text: "@Honey", target: profileTarget(honey.pubkey) },
    { text: "* " },
  ]);
});

it("keeps an italic mention bound after a literal asterisk", async () => {
  const h = mount();
  const honey = { pubkey: "a".repeat(64), name: "Honey" };
  await h.user.keyboard("a*");
  act(() => {
    h.input.insertText("", honey);
    h.input.setSelectionRange(2, 8);
    h.input.toggleFormat("italic");
  });
  expect(h.input.querySelector('em [data-source="@Honey"]')).not.toBeNull();
  expect(h.draft().recipients).toEqual([{ ...honey, start: 2, end: 8 }]);
  expect(h.markdown()).toBe("a\\**@Honey* ");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "a*" },
      { type: "emphasis", children: [{ type: "text", value: "@Honey" }] },
    ],
  });
  expect(
    profileMentionParts(
      { content: h.markdown(), mentions: [honey.pubkey] },
      new Map([[honey.pubkey, { name: honey.name }]]),
    ),
  ).toEqual([
    { text: "a\\**" },
    { text: "@Honey", target: profileTarget(honey.pubkey) },
    { text: "* " },
  ]);
});

it.each([
  ["bullet_list", "ul", "-"],
  ["ordered_list", "ol", "1."],
] as const)(
  "edits %s through continuation, indent/outdent, exit, undo and persistence",
  async (format, tag, marker) => {
    const h = mount("one\ntwo");
    act(() => {
      h.input.setSelectionRange(0, 7);
      h.input.toggleFormat(format);
    });
    expect(h.input.querySelectorAll(`${tag} > li`)).toHaveLength(2);
    act(() => h.input.setSelectionRange(7, 7));
    await h.user.keyboard("{Shift>}{Enter}{/Shift}three");
    expect(h.input.querySelectorAll(`${tag} > li`)).toHaveLength(3);
    await h.user.keyboard("{Tab}");
    expect(h.input.querySelector(`${tag} ${tag}`)).not.toBeNull();
    await h.user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(h.input.querySelector(`${tag} ${tag}`)).toBeNull();
    await h.user.keyboard("{Shift>}{Enter}{Enter}{/Shift}outside");
    expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
    const wire =
      marker === "-"
        ? "- one\n- two\n- three\n\noutside"
        : "1. one\n2. two\n3. three\n\noutside";
    expect(h.markdown()).toBe(wire);
    const saved = JSON.parse(JSON.stringify(h.draft()));
    act(() => h.input.reset(saved));
    expect(h.input.querySelectorAll(`${tag} > li`)).toHaveLength(3);
    expect(h.markdown()).toBe(wire);
  },
);

it("switches an existing list in place, including a nested list's first item", async () => {
  const h = mount("one\ntwo\nthree");
  act(() => {
    h.input.setSelectionRange(0, 13);
    h.input.toggleFormat("bullet_list");
    h.input.setSelectionRange(7, 7);
  });
  await h.user.keyboard("{Tab}");
  expect(h.input.querySelector("ul ul")).not.toBeNull();
  act(() => h.input.toggleFormat("ordered_list"));
  expect(h.input.querySelector("ul > li > ol > li")).toHaveTextContent("two");
  expect(h.input.querySelectorAll(":scope > ul > li")).toHaveLength(2);
  act(() => h.input.undo(false));
  expect(h.input.querySelector("ul ul")).not.toBeNull();
  act(() => h.input.undo(true));
  expect(h.input.querySelector("ul > li > ol > li")).toHaveTextContent("two");
});

it.each(["blockquote", "code_block"] as const)(
  "exits %s and clears its structure with select-all deletion",
  async (format) => {
    const h = mount("one");
    act(() => h.input.toggleFormat(format));
    await h.user.keyboard(
      "{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{Enter}{/Shift}outside",
    );
    expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
    expect(h.markdown()).toBe(
      format === "blockquote"
        ? "> one\n> two\n\noutside"
        : "```\none\ntwo\n```\n\noutside",
    );
    await h.user.keyboard("{Control>}a{/Control}{Backspace}");
    expect(h.input).toHaveValue("");
    expect(h.input.querySelector("pre, blockquote")).toBeNull();
    await h.user.keyboard("plain");
    expect(h.markdown()).toBe("plain");
  },
);

it("opens a code block as the third backtick is typed, with one undo restoring the source", async () => {
  const h = mount();
  await h.user.keyboard("``");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("``");
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre > code")).not.toBeNull();
  expect(h.input).toHaveValue("");
  act(() => h.input.undo(false));
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```");
  act(() => h.input.undo(true));
  expect(h.input.querySelector("pre > code")).not.toBeNull();
  await h.user.keyboard("code{Shift>}{Enter}{/Shift}more");
  expect(h.input).toHaveValue("code\nmore");
  expect(h.markdown()).toBe("```\ncode\nmore\n```");
  // The typed text is its own undo step; it never merges into the conversion.
  act(() => h.input.undo(false));
  expect(h.input.querySelector("pre > code")).not.toBeNull();
  expect(h.input).not.toHaveValue("```");
  act(() => h.input.undo(true));
  await h.user.keyboard("{Shift>}{Enter}{Enter}{/Shift}outside");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
  expect(h.markdown()).toBe("```\ncode\nmore\n```\n\noutside");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.input.querySelectorAll("pre > code")).toHaveLength(1);
  expect(h.markdown()).toBe("```\ncode\nmore\n```\n\noutside");
});

it("keeps the line literal after undoing the conversion, including a fourth backtick", async () => {
  const h = mount();
  await h.user.keyboard("```");
  expect(h.input.querySelector("pre")).not.toBeNull();
  act(() => h.input.undo(false));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("````");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}x");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("````\nx");
  expect(h.markdown()).toBe("````\nx");
});

it("opens a code block from a typed ~~~ line and sends it fenced", async () => {
  const h = mount();
  await h.user.keyboard("~~~x");
  const pre = h.input.querySelector("pre");
  if (!pre) throw new Error("Fence did not open a code block");
  expect(pre).not.toHaveAttribute("data-language");
  expect(pre.querySelector("code")).toHaveTextContent("x");
  expect(h.input).toHaveValue("x");
  expect(h.markdown()).toBe("```\nx\n```");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.markdown()).toBe("```\nx\n```");
});

it("keeps a restored block language through send and persistence", () => {
  const h = mount({
    text: "x",
    recipients: [],
    document: {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "code_block",
            attrs: { language: "ts" },
            content: [{ type: "text", text: "x" }],
          },
        ],
      },
    },
  });
  expect(h.input.querySelector("pre")).toHaveAttribute("data-language", "ts");
  expect(h.markdown()).toBe("```ts\nx\n```");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.input.querySelector("pre")).toHaveAttribute("data-language", "ts");
  expect(h.markdown()).toBe("```ts\nx\n```");
});

it("opens a fence typed after existing prose as a separate block", async () => {
  const h = mount("intro");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}```x");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("intro");
  expect(h.input.querySelector(":scope > pre > code")).toHaveTextContent("x");
  expect(h.input).toHaveValue("intro\nx");
  expect(h.markdown()).toBe("intro\n\n```\nx\n```");
});

it("opens a block between prose lines when the fence is typed on an empty middle line", async () => {
  const h = mount("intro\n\noutro");
  act(() => h.input.setSelectionRange(6, 6));
  await h.user.keyboard("```x");
  const paragraphs = h.input.querySelectorAll(":scope > p");
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs[0]).toHaveTextContent("intro");
  expect(paragraphs[1]).toHaveTextContent("outro");
  expect(h.input.querySelector(":scope > pre > code")).toHaveTextContent("x");
  expect(h.input).toHaveValue("intro\nx\noutro");
  expect(h.markdown()).toBe("intro\n\n```\nx\n```\n\noutro");
});

it.each(["a```", "``", "`` `", "``~", "~~`"])(
  "leaves typed %s as paragraph text",
  async (line) => {
    const h = mount();
    await h.user.keyboard(`${line}{Shift>}{Enter}{/Shift}x`);
    expect(h.input.querySelector("pre")).toBeNull();
    expect(h.input).toHaveValue(`${line}\nx`);
    expect(h.markdown()).toBe(`${line}\nx`);
  },
);

it("does not convert a fence completed away from the end of its line", async () => {
  const h = mount("``");
  act(() => h.input.setSelectionRange(0, 0));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```");
  act(() => h.input.setSelectionRange(1, 1));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("````");
});

it("keeps a fence typed inside an existing code block literal", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code_block"));
  await h.user.keyboard("```{Shift>}{Enter}{/Shift}x");
  expect(h.input.querySelectorAll("pre")).toHaveLength(1);
  expect(h.input).toHaveValue("```\nx");
  expect(h.markdown()).toBe("````\n```\nx\n````");
});

it("does not convert a fence carrying inline code or pasted source", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("```");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input.querySelector("code")).toHaveTextContent("```");
  act(() => {
    h.input.setSelectionRange(0, h.input.value.length);
    h.input.insertText("```\ncode\n```");
  });
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
});

it("keeps a typed backtick that closes a pasted fence literal, then opens a new block from a fence typed below it", async () => {
  const h = mount();
  paste(h.input, "```\ncode\n``");
  expect(h.input).toHaveValue("```\ncode\n``");
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
  // The pasted block is closed, so a fence typed under it opens a new one.
  await h.user.keyboard("{Shift>}{Enter}{/Shift}```more");
  expect(h.input.querySelectorAll("pre")).toHaveLength(1);
  expect(h.input.querySelector("pre > code")).toHaveTextContent("more");
  expect(h.input).toHaveValue("```\ncode\n```\nmore");
  expect(h.markdown()).toBe("```\ncode\n```\n\n```\nmore\n```");
});

it.each(["```js\ncode\n``", "~~~\ncode\n``", "````\n``"])(
  "keeps a backtick completing the closing or inner fence line of restored source %j literal",
  async (source) => {
    const h = mount(source);
    await h.user.keyboard("`");
    expect(h.input.querySelector("pre")).toBeNull();
    expect(h.input).toHaveValue(`${source}\``);
    expect(h.markdown()).toBe(`${source}\``);
  },
);

it("keeps a typed opening fence literal when a later line already closes it", async () => {
  const h = mount("``\ncode\n```");
  act(() => h.input.setSelectionRange(2, 2));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
});

/** Split the caret's empty last line into its own paragraph with the toolbar's
 * quote toggle and its lift, which leaves the split in place. Sibling paragraphs
 * send joined by one newline, so the wire is unchanged. */
function splitLastLine(h: ReturnType<typeof mount>, paragraphs: number) {
  act(() => h.input.toggleFormat("blockquote"));
  act(() => h.input.toggleFormat("blockquote"));
  expect(h.input.querySelector("blockquote")).toBeNull();
  expect(h.input.querySelectorAll(":scope > p")).toHaveLength(paragraphs);
}

it("keeps a fence literal that closes a block an earlier sibling paragraph opened, then converts below the closed block", async () => {
  const h = mount();
  await h.user.keyboard("```");
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue("```");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}code{Shift>}{Enter}{/Shift}");
  splitLastLine(h, 2);
  expect(h.markdown()).toBe("```\ncode\n");
  // The line closes the fence the first paragraph opened; on the wire the two
  // paragraphs are one fenced block, so the third backtick stays literal.
  await h.user.keyboard("```");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    { type: "code", value: "code" },
  ]);
  // Below the closed block, a fence in a further split paragraph opens one.
  await h.user.keyboard("{Shift>}{Enter}{/Shift}");
  splitLastLine(h, 3);
  await h.user.keyboard("```more");
  expect(h.input.querySelectorAll("pre")).toHaveLength(1);
  expect(h.input.querySelector("pre > code")).toHaveTextContent("more");
  expect(h.input).toHaveValue("```\ncode\n```\nmore");
  expect(h.markdown()).toBe("```\ncode\n```\n\n```\nmore\n```");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    { type: "code", value: "code" },
    { type: "code", value: "more" },
  ]);
});

it("keeps a typed opening fence literal when a later sibling paragraph closes it", async () => {
  const h = mount("``");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}");
  splitLastLine(h, 2);
  act(() => h.input.insertText("code\n```"));
  expect(h.input).toHaveValue("``\ncode\n```");
  act(() => h.input.setSelectionRange(2, 2));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input.querySelectorAll(":scope > p")).toHaveLength(2);
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    { type: "code", value: "code" },
  ]);
});

it.each([
  ["- ", "ul", "- "],
  ["* ", "ul", "- "],
  ["1. ", "ol", "1. "],
  ["> ", "blockquote", "> "],
] as const)(
  "opens a block as the space of %j is typed, with one undo restoring the prefix",
  async (prefix, tag, wire) => {
    const h = mount();
    await h.user.keyboard(prefix.slice(0, -1));
    expect(h.input.querySelector(tag)).toBeNull();
    expect(h.input).toHaveValue(prefix.slice(0, -1));
    await h.user.keyboard(" ");
    expect(h.input.querySelector(`:scope > ${tag}`)).not.toBeNull();
    expect(h.input).toHaveValue("");
    act(() => h.input.undo(false));
    expect(h.input.querySelector(tag)).toBeNull();
    expect(h.input).toHaveValue(prefix);
    act(() => h.input.undo(true));
    expect(h.input.querySelector(`:scope > ${tag}`)).not.toBeNull();
    await h.user.keyboard("item");
    expect(h.input).toHaveValue("item");
    expect(h.markdown()).toBe(`${wire}item`);
    // The typed text is its own undo step; it never merges into the conversion.
    act(() => h.input.undo(false));
    expect(h.input.querySelector(`:scope > ${tag}`)).not.toBeNull();
    expect(h.input).toHaveValue("");
    act(() => h.input.undo(true));
    expect(h.markdown()).toBe(`${wire}item`);
    const saved = JSON.parse(JSON.stringify(h.draft()));
    act(() => h.input.reset(saved));
    expect(h.input.querySelector(`:scope > ${tag}`)).not.toBeNull();
    expect(h.markdown()).toBe(`${wire}item`);
  },
);

it.each(["1. ", "• "])(
  "hides the placeholder in an empty %j list and restores it after exit",
  async (prefix) => {
    const h = mount();
    expect(h.input.querySelector("[data-placeholder]")).toHaveAttribute(
      "data-placeholder",
      "Draft",
    );
    await h.user.keyboard(prefix);
    expect(h.input.querySelector("li")).not.toBeNull();
    expect(h.input.querySelector("[data-placeholder]")).toBeNull();
    act(() => h.input.insertLineBreak());
    expect(h.input.querySelector("ul, ol")).toBeNull();
    expect(h.input.querySelector(":scope > p")).toHaveAttribute(
      "data-placeholder",
      "Draft",
    );
  },
);

it("starts an ordered list at the typed number and continues it with Shift+Enter", async () => {
  const h = mount();
  await h.user.keyboard("3. third{Shift>}{Enter}{/Shift}fourth");
  expect(h.input.querySelector(":scope > ol")).toHaveAttribute("start", "3");
  expect(h.input.querySelectorAll("ol > li")).toHaveLength(2);
  expect(h.input).toHaveValue("third\nfourth");
  expect(h.markdown()).toBe("3. third\n4. fourth");
  await h.user.keyboard("{Tab}");
  expect(h.input.querySelector("ol ol > li")).toHaveTextContent("fourth");
  await h.user.keyboard("{Shift>}{Tab}{Enter}{Enter}{/Shift}outside");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
  expect(h.markdown()).toBe("3. third\n4. fourth\n\noutside");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.input.querySelector(":scope > ol")).toHaveAttribute("start", "3");
  expect(h.markdown()).toBe("3. third\n4. fourth\n\noutside");
});

it("opens a list from a marker typed on the second line, after the first line's paragraph", async () => {
  const h = mount("intro");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}- item");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("intro");
  expect(h.input.querySelector(":scope > ul > li")).toHaveTextContent("item");
  expect(h.input).toHaveValue("intro\nitem");
  expect(h.markdown()).toBe("intro\n\n- item");
});

it("quotes the rest of the line when the marker is typed before existing prose", async () => {
  const h = mount("quoted\nplain");
  act(() => h.input.setSelectionRange(0, 0));
  await h.user.keyboard("> ");
  expect(h.input.querySelector(":scope > blockquote > p")).toHaveTextContent(
    "quoted",
  );
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("plain");
  expect(h.input).toHaveValue("quoted\nplain");
  expect(h.markdown()).toBe("> quoted\n\nplain");
});

it("opens a list inside a quote but keeps a quote marker typed inside a list item literal, where the sent text still nests", async () => {
  const h = mount();
  await h.user.keyboard("> quote{Shift>}{Enter}{/Shift}- item");
  expect(
    h.input.querySelector(":scope > blockquote > ul > li"),
  ).toHaveTextContent("item");
  expect(h.markdown()).toBe("> quote\n>\n> - item");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}> not nested");
  expect(h.input.querySelectorAll("blockquote")).toHaveLength(1);
  expect(h.input.querySelectorAll("ul > li")).toHaveLength(2);
  expect(h.input).toHaveValue("quote\nitem\n> not nested");
  expect(h.markdown()).toBe("> quote\n>\n> - item\n> - > not nested");
  // The composer shows the marker; the timeline reads a quote inside the item,
  // a shape the schema cannot hold because an item starts with a paragraph.
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "blockquote",
    children: [
      { type: "paragraph" },
      {
        type: "list",
        ordered: false,
        children: [
          { type: "listItem", children: [{ type: "paragraph" }] },
          {
            type: "listItem",
            children: [
              {
                type: "blockquote",
                children: [
                  {
                    type: "paragraph",
                    children: [{ type: "text", value: "not nested" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
});

it("nests a second quote as `> ` is typed inside a quote, with the toolbar, Shift+Enter and undo following the nesting", async () => {
  const h = mount();
  await h.user.keyboard("> outer{Shift>}{Enter}{/Shift}> inner");
  expect(
    h.input.querySelector(":scope > blockquote > blockquote > p"),
  ).toHaveTextContent("inner");
  expect(h.input.querySelectorAll("blockquote")).toHaveLength(2);
  expect(h.input).toHaveValue("outer\ninner");
  expect(h.markdown()).toBe("> outer\n>\n> > inner");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    {
      type: "blockquote",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "outer" }] },
        {
          type: "blockquote",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "inner" }] },
          ],
        },
      ],
    },
  ]);
  // The toolbar reports one quote format, as it does for a single quote.
  expect(h.formats()).toEqual(["blockquote"]);
  // Shift+Enter continues the inner quote; an empty last line leaves it for
  // the outer quote, and once more leaves that.
  await h.user.keyboard(
    "{Shift>}{Enter}{/Shift}more{Shift>}{Enter}{Enter}{/Shift}back",
  );
  expect(
    h.input.querySelectorAll(":scope > blockquote > blockquote > p"),
  ).toHaveLength(2);
  expect(
    h.input.querySelector(":scope > blockquote > p:last-child"),
  ).toHaveTextContent("back");
  expect(h.formats()).toEqual(["blockquote"]);
  // Adjacent paragraphs send as lines of one paragraph, as in a single quote.
  expect(h.markdown()).toBe("> outer\n>\n> > inner\n> > more\n>\n> back");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "blockquote",
    children: [
      { type: "paragraph" },
      {
        type: "blockquote",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: "inner\nmore" }],
          },
        ],
      },
      { type: "paragraph", children: [{ type: "text", value: "back" }] },
    ],
  });
  await h.user.keyboard("{Shift>}{Enter}{Enter}{/Shift}outside");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
  expect(h.formats()).toEqual([]);
  // The toolbar's quote toggle lifts the caret's paragraph out of the inner
  // quote, one level at a time.
  act(() => h.input.setSelectionRange(8, 8));
  expect(h.formats()).toEqual(["blockquote"]);
  act(() => h.input.toggleFormat("blockquote"));
  expect(
    h.input.querySelectorAll(":scope > blockquote > blockquote > p"),
  ).toHaveLength(1);
  expect(
    h.input.querySelectorAll(":scope > blockquote > p")[1],
  ).toHaveTextContent("inner");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.markdown()).toBe(
    "> outer\n> inner\n>\n> > more\n>\n> back\n\noutside",
  );
});

it("restores the typed `> ` in one undo step when it nested a quote", async () => {
  const h = mount();
  await h.user.keyboard("> outer{Shift>}{Enter}{/Shift}> ");
  expect(h.input.querySelectorAll("blockquote")).toHaveLength(2);
  expect(h.input).toHaveValue("outer\n");
  act(() => h.input.undo(false));
  expect(h.input.querySelectorAll("blockquote")).toHaveLength(1);
  expect(h.input).toHaveValue("outer\n> ");
  act(() => h.input.undo(true));
  expect(
    h.input.querySelector(":scope > blockquote > blockquote > p"),
  ).not.toBeNull();
  await h.user.keyboard("inner");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(
    h.input.querySelector(":scope > blockquote > blockquote > p"),
  ).toHaveTextContent("inner");
  expect(h.markdown()).toBe("> outer\n>\n> > inner");
});

it.each([
  ["- ", "item", "- ", "ul", null, "- item\n  \n  - nested"],
  ["1. ", "one", "3. ", "ol", "3", "1. one\n   \n   3. nested"],
] as const)(
  "nests an empty item after the first as Tab does when %j%j is followed by %j",
  async (prefix, text, marker, tag, start, wire) => {
    const h = mount();
    await h.user.keyboard(`${prefix}${text}{Shift>}{Enter}{/Shift}${marker}`);
    const nested = h.input.querySelector(`:scope > ${tag} > li > ${tag}`);
    expect(nested?.querySelector("li")).not.toBeNull();
    expect(h.input.querySelectorAll("li")).toHaveLength(2);
    if (start) expect(nested).toHaveAttribute("start", start);
    else expect(nested).not.toHaveAttribute("start");
    expect(h.input).toHaveValue(`${text}\n`);
    act(() => h.input.undo(false));
    expect(h.input.querySelector(`${tag} ${tag}`)).toBeNull();
    expect(h.input.querySelectorAll(`:scope > ${tag} > li`)).toHaveLength(2);
    expect(h.input).toHaveValue(`${text}\n${marker}`);
    act(() => h.input.undo(true));
    await h.user.keyboard("nested");
    expect(h.input.querySelector(`${tag} ${tag} > li`)).toHaveTextContent(
      "nested",
    );
    expect(h.markdown()).toBe(wire);
    const ordered = tag === "ol";
    expect(fromMarkdown(wire).children).toMatchObject([
      {
        type: "list",
        ordered,
        children: [
          {
            type: "listItem",
            children: [
              { type: "paragraph", children: [{ type: "text", value: text }] },
              {
                type: "list",
                ordered,
                start: start ? Number(start) : null,
                children: [
                  {
                    type: "listItem",
                    children: [
                      {
                        type: "paragraph",
                        children: [{ type: "text", value: "nested" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const saved = JSON.parse(JSON.stringify(h.draft()));
    act(() => h.input.reset(saved));
    expect(
      h.input.querySelector(`:scope > ${tag} > li > ${tag}`),
    ).not.toBeNull();
    expect(h.markdown()).toBe(wire);
  },
);

it("joins the previous item's nested list as Tab does, so the typed number is a continuation there", async () => {
  const h = mount();
  await h.user.keyboard(
    "1. one{Shift>}{Enter}{/Shift}two{Tab}{Shift>}{Enter}{Enter}{/Shift}",
  );
  expect(h.input.querySelectorAll(":scope > ol > li")).toHaveLength(2);
  expect(h.input.querySelectorAll("ol ol > li")).toHaveLength(1);
  await h.user.keyboard("7. three");
  expect(h.input.querySelectorAll(":scope > ol > li")).toHaveLength(1);
  const nested = h.input.querySelector("ol ol");
  expect(nested).not.toHaveAttribute("start");
  expect(nested?.querySelectorAll("li")).toHaveLength(2);
  expect(h.input).toHaveValue("one\ntwo\nthree");
  expect(h.markdown()).toBe("1. one\n   \n   1. two\n   2. three");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "list",
    start: 1,
    children: [
      {
        type: "listItem",
        children: [
          { type: "paragraph" },
          {
            type: "list",
            start: 1,
            children: [{ type: "listItem" }, { type: "listItem" }],
          },
        ],
      },
    ],
  });
});

it("keeps a marker of the other list kind, one beside an item's prose, and one in a first item literal, where the sent text still nests", async () => {
  const h = mount();
  await h.user.keyboard("- item{Shift>}{Enter}{/Shift}1. num");
  expect(h.input.querySelector("ol")).toBeNull();
  expect(h.input.querySelectorAll("ul > li")).toHaveLength(2);
  expect(h.input).toHaveValue("item\n1. num");
  expect(h.markdown()).toBe("- item\n- 1. num");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "list",
    ordered: false,
    children: [
      { type: "listItem", children: [{ type: "paragraph" }] },
      {
        type: "listItem",
        children: [
          {
            type: "list",
            ordered: true,
            start: 1,
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [{ type: "text", value: "num" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const prose = mount();
  await prose.user.keyboard("- item{Shift>}{Enter}{/Shift}two");
  act(() => prose.input.setSelectionRange(5, 5));
  await prose.user.keyboard("- ");
  expect(prose.input.querySelector("ul ul")).toBeNull();
  expect(prose.input).toHaveValue("item\n- two");
  expect(prose.markdown()).toBe("- item\n- - two");
  const first = mount();
  await first.user.keyboard("- - nested");
  expect(first.input.querySelector("ul ul")).toBeNull();
  expect(first.input.querySelectorAll("li")).toHaveLength(1);
  expect(first.input).toHaveValue("- nested");
  expect(first.markdown()).toBe("- - nested");
  expect(fromMarkdown(first.markdown()).children[0]).toMatchObject({
    type: "list",
    children: [
      {
        type: "listItem",
        children: [
          {
            type: "list",
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [{ type: "text", value: "nested" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
});

it("caps continuation numbers at nine digits so the timeline reads one list", async () => {
  const h = mount();
  await h.user.keyboard("999999999. item{Shift>}{Enter}{/Shift}next");
  expect(h.input.querySelector(":scope > ol")).toHaveAttribute(
    "start",
    "999999999",
  );
  expect(h.input.querySelectorAll("ol > li")).toHaveLength(2);
  expect(h.markdown()).toBe("999999999. item\n999999999. next");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    {
      type: "list",
      ordered: true,
      start: 999999999,
      children: [
        {
          type: "listItem",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "item" }] },
          ],
        },
        {
          type: "listItem",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "next" }] },
          ],
        },
      ],
    },
  ]);
});

it("alternates the marker between adjacent lists of one kind so they stay separate once sent", async () => {
  const h = mount();
  await h.user.keyboard(
    "3. third{Shift>}{Enter}{Enter}{/Shift}1. one{Shift>}{Enter}{/Shift}two",
  );
  expect(h.input.querySelectorAll(":scope > ol")).toHaveLength(2);
  expect(h.markdown()).toBe("3. third\n\n1) one\n2) two");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    { type: "list", ordered: true, start: 3, children: [{ type: "listItem" }] },
    {
      type: "list",
      ordered: true,
      start: 1,
      children: [{ type: "listItem" }, { type: "listItem" }],
    },
  ]);
  const bullets = mount();
  await bullets.user.keyboard(
    "- a{Shift>}{Enter}{Enter}{/Shift}- b{Shift>}{Enter}{Enter}{/Shift}- c{Shift>}{Enter}{Enter}{/Shift}text{Shift>}{Enter}{/Shift}- d",
  );
  expect(bullets.input.querySelectorAll(":scope > ul")).toHaveLength(4);
  expect(bullets.markdown()).toBe("- a\n\n* b\n\n- c\n\ntext\n\n- d");
  expect(
    fromMarkdown(bullets.markdown()).children.map((node) => node.type),
  ).toEqual(["list", "list", "list", "paragraph", "list"]);
});

it.each([
  ["- ", "ul", "- a\n\n* b\n\n\n\n- c"],
  ["1. ", "ol", "1. a\n\n1) b\n\n\n\n1. c"],
] as const)(
  "keeps alternating %j list markers across an empty paragraph so three lists stay three",
  async (marker, tag, wire) => {
    const h = mount();
    // Two Shift+Enters leave the list; a third on the empty paragraph adds a
    // blank line, which the marker's conversion splits into its own paragraph.
    await h.user.keyboard(
      `${marker}a{Shift>}{Enter}{Enter}{/Shift}${marker}b{Shift>}{Enter}{Enter}{Enter}{/Shift}${marker}c`,
    );
    expect(h.input.querySelectorAll(`:scope > ${tag}`)).toHaveLength(3);
    expect(h.input.querySelectorAll(":scope > p")).toHaveLength(1);
    expect(h.markdown()).toBe(wire);
    expect(fromMarkdown(h.markdown()).children).toMatchObject([
      { type: "list", children: [{ type: "listItem" }] },
      { type: "list", children: [{ type: "listItem" }] },
      { type: "list", children: [{ type: "listItem" }] },
    ]);
  },
);

it("leaves a marker typed after prose, and ordinary spaces, as paragraph text", async () => {
  const h = mount();
  await h.user.keyboard("note - one 1. two > three");
  expect(h.input.querySelector("ul, ol, blockquote")).toBeNull();
  expect(h.input).toHaveValue("note - one 1. two > three");
  expect(h.markdown()).toBe("note - one 1. two > three");
});

it.each([" - ", "a- ", "a• ", " • ", "1.5 ", "1234567890. ", "-> ", ">> "])(
  "leaves typed %j as paragraph text",
  async (line) => {
    const h = mount();
    await h.user.keyboard(line);
    expect(h.input.querySelector("ul, ol, blockquote")).toBeNull();
    expect(h.input).toHaveValue(line);
  },
);

it("keeps a marker typed inside a code block or inline code literal", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code_block"));
  await h.user.keyboard("- item");
  expect(h.input.querySelector("ul")).toBeNull();
  expect(h.input.querySelector("pre > code")).toHaveTextContent("- item");
  expect(h.markdown()).toBe("```\n- item\n```");
  const inline = mount();
  act(() => inline.input.toggleFormat("code"));
  await inline.user.keyboard("> quote");
  expect(inline.input.querySelector("blockquote")).toBeNull();
  expect(inline.input.querySelector("code")).toHaveTextContent("> quote");
  expect(inline.markdown()).toBe("`> quote`");
});

it("does not convert an inserted or pasted marker, or one typed inside pasted fenced source", async () => {
  const h = mount();
  act(() => h.input.insertText("- item"));
  expect(h.input.querySelector("ul")).toBeNull();
  expect(h.markdown()).toBe("- item");
  paste(h.input, "\n> quote");
  expect(h.input.querySelector("blockquote")).toBeNull();
  expect(h.markdown()).toBe("- item\n> quote");
  const fenced = mount();
  paste(fenced.input, "```\ncode\n```");
  act(() => fenced.input.setSelectionRange(4, 4));
  await fenced.user.keyboard("- ");
  expect(fenced.input.querySelector("ul, pre")).toBeNull();
  expect(fenced.input).toHaveValue("```\n- code\n```");
  expect(fenced.markdown()).toBe("```\n- code\n```");
  // A fence left open by an earlier sibling paragraph still covers the line.
  const split = mount();
  await split.user.keyboard("```");
  act(() => split.input.undo(false));
  await split.user.keyboard("{Shift>}{Enter}{/Shift}");
  splitLastLine(split, 2);
  await split.user.keyboard("- item");
  expect(split.input.querySelector("ul, pre")).toBeNull();
  expect(split.input).toHaveValue("```\n- item");
  expect(split.markdown()).toBe("```\n- item");
});

it.each([
  ["- ", false, "ul > li > p"],
  ["1. ", false, "ol > li > p"],
  ["> ", false, "blockquote > p"],
  ["- ", true, "ul > li > p"],
  ["1. ", true, "ol > li > p"],
  ["> ", true, "blockquote > p"],
] as const)(
  "converts %j typed before a mention, link chip, link and code, keeping each in the block (next line=%s)",
  async (marker, followed, selector) => {
    const h = mount("", { links: true });
    const honey = { pubkey: "a".repeat(64), name: "Honey" };
    const url = "https://example.com/a";
    act(() => h.input.insertText("", honey));
    paste(h.input, `see ${url} and docs`);
    await h.user.keyboard(" `x`");
    act(() => {
      const at = h.input.value.indexOf("docs");
      h.input.setSelectionRange(at, at + 4);
      h.input.editLink()?.save("docs", "https://example.com/docs");
      h.input.setSelectionRange(h.input.value.length, h.input.value.length);
    });
    // A later line of the same paragraph stays behind when the line converts.
    if (followed) await h.user.keyboard("{Shift>}{Enter}{/Shift}next");
    act(() => h.input.setSelectionRange(0, 0));
    const line = `@Honey see ${url} and [docs](https://example.com/docs) \`x\``;
    const tail = followed ? "\nnext" : "";
    expect(h.markdown()).toBe(`${line}${tail}`);
    const value = h.input.value;
    const converted = () => {
      const block = h.input.querySelector(selector);
      expect(block).not.toBeNull();
      expect(block?.querySelector('[data-source="@Honey"]')).not.toBeNull();
      expect(block?.querySelector(`[data-source="${url}"]`)).not.toBeNull();
      expect(
        block?.querySelector('a[href="https://example.com/docs"]'),
      ).toHaveTextContent("docs");
      expect(block?.querySelector("code")).toHaveTextContent("x");
      expect(h.input.querySelector(":scope > p")?.textContent ?? null).toBe(
        followed ? "next" : null,
      );
      // Only the marker went: every chip and the recipient keep their offsets.
      expect(h.input.value).toBe(value);
      expect(h.draft().recipients).toEqual([{ ...honey, start: 0, end: 6 }]);
      expect(h.markdown()).toBe(
        `${marker}${line}${followed ? "\n\nnext" : ""}`,
      );
    };
    await h.user.keyboard(marker);
    converted();
    act(() => h.input.undo(false));
    expect(h.input.querySelector("ul, ol, blockquote")).toBeNull();
    expect(h.input.value).toBe(`${marker}${value}`);
    expect(h.draft().recipients).toEqual([
      { ...honey, start: marker.length, end: marker.length + 6 },
    ]);
    expect(h.markdown()).toBe(`${marker}${line}${tail}`);
    act(() => h.input.undo(true));
    converted();
  },
);

// The reported flow: a timeline message pastes its bare links as chips, and
// `> ` typed at the start of each pasted paragraph quotes every one of them.
it("quotes every pasted paragraph `> ` is typed before, keeping its link chips", async () => {
  const pr = "https://github.com/example/widgets/pull/318";
  const readme =
    "https://github.com/example/widgets/blob/fix/meter/docs/README.md";
  const paragraphs = [
    `Rebased onto main and pushed. Draft PR: ${pr}`,
    "Folds in #309, #310 and #311 (not #312), so {theme:compact} keeps the team’s (ACUL) banner.",
    "The meter reads Weak / Moderate / Strong, and “Didn’t get the code? Resend” stays.",
    `Rollout notes: ${readme}`,
    "Totals: 1,163 cases; 1,150 passed; 13 skipped.",
  ];
  const linked = (text: string) =>
    text.replace(/https:\S+/, (href) => `<a href="${href}">${href}</a>`);
  const h = mount("", { links: true });
  paste(
    h.input,
    paragraphs.join("\n\n"),
    `<div data-buzz-copy="timeline">${paragraphs.map((text) => `<p>${linked(text)}</p>`).join("")}</div>`,
  );
  expect(h.input.querySelectorAll("[data-link]")).toHaveLength(2);
  act(() => h.input.setSelectionRange(0, 0));
  await h.user.keyboard("From Pip’s agent:{Shift>}{Enter}{/Shift}");
  for (const paragraph of paragraphs) {
    const start = h.input.value.indexOf(paragraph);
    act(() => h.input.setSelectionRange(start, start));
    await h.user.keyboard("> ");
  }
  const quotes = [...h.input.querySelectorAll(":scope > blockquote")];
  expect(quotes).toHaveLength(5);
  expect(quotes[0]?.querySelector(`[data-source="${pr}"]`)).not.toBeNull();
  expect(quotes[3]?.querySelector(`[data-source="${readme}"]`)).not.toBeNull();
  expect(h.input.value).not.toContain(">");
  // The sent text reads as the header and five quotes, each link inside its own.
  const blocks = scanMarkdown(h.markdown()).tree.children ?? [];
  expect(blocks.map((node) => node.type)).toEqual([
    "paragraph",
    ...paragraphs.map(() => "blockquote"),
  ]);
  expect(JSON.stringify(blocks[1])).toContain(pr);
  expect(JSON.stringify(blocks[4])).toContain(readme);
});

it("switches a nested bullet to its ordered ancestor's type without outdenting", async () => {
  const h = mount("one\ntwo\nthree");
  act(() => {
    h.input.setSelectionRange(0, 13);
    h.input.toggleFormat("ordered_list");
    h.input.setSelectionRange(7, 7);
  });
  await h.user.keyboard("{Tab}");
  act(() => h.input.toggleFormat("bullet_list"));
  expect(h.input.querySelector("ol ul")).not.toBeNull();
  act(() => h.input.toggleFormat("ordered_list"));
  expect(h.input.querySelector("ol ol > li")).toHaveTextContent("two");
  expect(h.input.querySelectorAll(":scope > ol > li")).toHaveLength(2);
});

it.each([true, false])(
  "continues a list with explicit Bold=%s typing mode",
  async (enabled) => {
    const h = mount("one");
    act(() => {
      h.input.setSelectionRange(0, 3);
      h.input.toggleFormat("bold");
      h.input.toggleFormat("bullet_list");
      h.input.setSelectionRange(3, 3);
      if (!enabled) h.input.toggleFormat("bold");
    });
    await h.user.keyboard("{Shift>}{Enter}{/Shift}two");
    const item = h.input.querySelectorAll("li")[1];
    if (!item) throw new Error("List did not split");
    expect(!!item.querySelector("strong")).toBe(enabled);
  },
);

const imp = { pubkey: "a".repeat(64), name: "Imp" };
const jitter = { pubkey: "b".repeat(64), name: "Jitter" };
// Display names with a space are one token too; the label never splits.
const maryJane = { pubkey: "c".repeat(64), name: "Mary Jane" };
const mattToohey = { pubkey: "d".repeat(64), name: "Matt Toohey" };
/** Every `@Name` of these people in the text is an explicit, resolved recipient. */
function mentioned(text: string): MentionDraft {
  return {
    text,
    recipients: [imp, jitter, maryJane, mattToohey].flatMap((recipient) => {
      const start = text.indexOf(`@${recipient.name}`);
      return start < 0
        ? []
        : [{ ...recipient, start, end: start + recipient.name.length + 1 }];
    }),
  };
}
const selection = (input: ComposerInputElement) =>
  [input.selectionStart, input.selectionEnd, input.selectionDirection] as const;
/** Arrow keys are deliberately low-level: user-event cannot extend a selection. */
const shiftArrow = (
  input: ComposerInputElement,
  key: "ArrowLeft" | "ArrowRight",
) =>
  act(() => {
    fireEvent.keyDown(input, { key: "Shift", keyCode: 16, shiftKey: true });
    fireEvent.keyDown(input, {
      key,
      code: key,
      keyCode: key === "ArrowLeft" ? 37 : 39,
      shiftKey: true,
    });
  });

it.each([jitter.name, maryJane.name])(
  "extends a backward selection over @%s before it and keeps the anchor",
  (name) => {
    const text = `@Imp say hello to @${name} `;
    const mention = text.lastIndexOf("@");
    const h = mount(mentioned(text));
    expect(h.input.querySelectorAll("[data-mention]")).toHaveLength(2);
    act(() => h.input.setSelectionRange(text.length, text.length));
    // The browser itself answers the first Shift+Left by selecting the trailing
    // space. Model that native result, then let the editor handle the second.
    act(() => {
      const space = h.input.querySelector("p")?.lastChild;
      if (!(space instanceof Text)) throw new Error("Missing trailing text");
      document.getSelection()?.setBaseAndExtent(space, 1, space, 0);
    });
    shiftArrow(h.input, "ArrowLeft");
    expect(selection(h.input)).toEqual([mention, text.length, "backward"]);
    expect(text.slice(mention)).toBe(`@${name} `);
    expect(h.input.selectionEnd - h.input.selectionStart).toBeLessThanOrEqual(
      h.input.value.length,
    );
    shiftArrow(h.input, "ArrowRight");
    expect(selection(h.input)).toEqual([
      text.length - 1,
      text.length,
      "backward",
    ]);
  },
);

it.each([
  [
    "after a mention with no trailing space",
    "@Imp say hello to @Jitter",
    25,
    "ArrowLeft",
    [18, 25, "backward"],
  ],
  [
    "before a mention",
    "@Imp say hello to @Jitter ",
    18,
    "ArrowRight",
    [18, 25, "forward"],
  ],
  [
    "after the mention at the start",
    "@Imp say hello to @Jitter ",
    4,
    "ArrowLeft",
    [0, 4, "backward"],
  ],
  [
    "the document start",
    "@Imp say hello to @Jitter ",
    0,
    "ArrowRight",
    [0, 4, "forward"],
  ],
  ["the document end", "hello @Jitter", 13, "ArrowLeft", [6, 13, "backward"]],
  [
    "after a two-word mention with no trailing space",
    "@Imp say hello to @Mary Jane",
    28,
    "ArrowLeft",
    [18, 28, "backward"],
  ],
] as const)(
  "Shift+Arrow from %s selects the whole mention",
  (_, text, caret, key, expected) => {
    const h = mount(mentioned(text));
    act(() => h.input.setSelectionRange(caret, caret));
    shiftArrow(h.input, key);
    expect(selection(h.input)).toEqual(expected);
  },
);

it.each([
  [
    "extends a forward selection from prose over a mention",
    "@Imp say hello to @Jitter ",
    16,
    18,
    "forward",
    "ArrowRight",
    [16, 25, "forward"],
  ],
  [
    "extends a backward selection from prose over a mention",
    "@Imp say hello to @Jitter ",
    4,
    8,
    "backward",
    "ArrowLeft",
    [0, 8, "backward"],
  ],
  [
    "shrinks a forward selection off a mention",
    "@Imp say hello to @Jitter ",
    18,
    25,
    "forward",
    "ArrowLeft",
    [18, 18, "forward"],
  ],
  [
    "shrinks a backward selection off a mention",
    "@Imp say hello to @Jitter ",
    18,
    26,
    "backward",
    "ArrowRight",
    [25, 26, "backward"],
  ],
  // Two two-word mentions one space apart: the browser selects that space,
  // then the editor extends over the first mention in the same direction.
  [
    "extends a backward selection over the first of two two-word mentions",
    "@Mary Jane @Matt Toohey ",
    10,
    24,
    "backward",
    "ArrowLeft",
    [0, 24, "backward"],
  ],
  [
    "extends a forward selection over the second of two two-word mentions",
    "@Mary Jane @Matt Toohey ",
    0,
    11,
    "forward",
    "ArrowRight",
    [0, 23, "forward"],
  ],
] as const)("%s", (_, text, start, end, direction, key, expected) => {
  const h = mount(mentioned(text));
  act(() => h.input.setSelectionRange(start, end, direction));
  expect(selection(h.input)).toEqual([start, end, direction]);
  shiftArrow(h.input, key);
  expect(selection(h.input)).toEqual(expected);
});

it("retains the native caret after replacing text with an unchanged suffix", async () => {
  const h = mount(":unknown:");
  act(() => {
    const text = h.input.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Missing native text node");
    text.data = ":nosource:";
    document.getSelection()?.collapse(text, text.length);
  });
  await waitFor(() => expect(h.input).toHaveValue(":nosource:"));
  expect(h.input.selectionStart).toBe(10);
  expect(h.input.selectionEnd).toBe(10);
});

/** A character the host's native text-input path can commit as typed text for
 * a caret or function key. The desktop build committed U+001D on a Right
 * Arrow press: a key's raw keyboard-layout translation is a C0 control (the
 * arrows are U+001C through U+001F), which WebKit does not strip from a key
 * event's text. AppKit's own NSEvent carries the private-use function-key
 * character instead (NSUpArrowFunctionKey U+F700 onwards), which WebKit strips
 * and the guard refuses as well. DEL and the C1 controls are as glyphless. */
const controlKeys = [
  ["Right Arrow's layout translation U+001D", "\u001D"],
  ["Home's layout translation U+0001", "\u0001"],
  ["Page Up's layout translation U+000B", "\u000B"],
  ["Page Down's layout translation U+000C", "\u000C"],
  ["DEL U+007F", "\u007F"],
  ["the first C1 control U+0080", "\u0080"],
  ["the last C1 control U+009F", "\u009F"],
  ["Up Arrow's function-key character U+F700", "\uF700"],
  ["Right Arrow's function-key character U+F703", "\uF703"],
  ["Page Down's function-key character U+F72D", "\uF72D"],
] as const;
/** Right Arrow committed as text in both forms the host can produce. Each
 * carries a label because neither character has a glyph: interpolated raw
 * into a case name or an assertion message they read identically. */
const rightArrowCharacters = [
  ["Right Arrow's layout translation U+001D", "\u001D"],
  ["Right Arrow's function-key character U+F703", "\uF703"],
] as const;
const caretKeys = [
  "ArrowRight",
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Shift",
  "Meta",
  "Escape",
] as const;
/** A caret keydown as WebKit reports it when the key event's text is the key's
 * layout translation: `key` is the control character while `code` and the
 * legacy key code still name the key. */
const mangledCaretKeys = {
  ArrowLeft: { key: "\u001C", keyCode: 37 },
  ArrowRight: { key: "\u001D", keyCode: 39 },
  ArrowUp: { key: "\u001E", keyCode: 38 },
  ArrowDown: { key: "\u001F", keyCode: 40 },
  Home: { key: "\u0001", keyCode: 36 },
  End: { key: "\u0004", keyCode: 35 },
  PageUp: { key: "\u000B", keyCode: 33 },
  PageDown: { key: "\u000C", keyCode: 34 },
} as const;
type MangledCaretKey = keyof typeof mangledCaretKeys;
function mangled(
  code: MangledCaretKey,
  init: Omit<KeyboardEventInit, "key" | "code" | "keyCode"> = {},
) {
  return { ...mangledCaretKeys[code], code, ...init };
}

/** Everything the composer persists or shows: the draft with its document
 * snapshot, and the rendered DOM. */
function snapshot(h: ReturnType<typeof mount>) {
  return { draft: JSON.stringify(h.draft()), html: h.input.innerHTML };
}

/** Presses a caret key: through user-event where it models the key, and as a
 * bare keydown/keyup pair for Home and End, whose caret movement jsdom does
 * not implement on a contenteditable element. */
async function press(h: ReturnType<typeof mount>, key: string) {
  if (key !== "Home" && key !== "End") {
    await h.user.keyboard(`{${key}}`);
    return;
  }
  const target = document.activeElement ?? h.input;
  fireEvent.keyDown(target, { key, code: key });
  fireEvent.keyUp(target, { key, code: key });
}

/** The browser's own insertion of text the host committed: a cancelable
 * beforeinput, then the DOM change ProseMirror observes. With `beforeinput`
 * false the change arrives as an uncancelable or unannounced one would.
 * Returns whether the DOM was changed. */
function nativeInsert(
  input: ComposerInputElement,
  text: string,
  beforeinput = true,
) {
  let inserted = false;
  act(() => {
    input.focus();
    if (
      beforeinput &&
      !input.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        }),
      )
    )
      return;
    const selection = document.getSelection();
    const focus = selection?.focusNode;
    if (!selection || !focus) throw new Error("DOM selection unavailable");
    let node: Text;
    let offset = selection.focusOffset;
    if (focus instanceof Text) node = focus;
    else {
      node = document.createTextNode("");
      focus.insertBefore(node, focus.childNodes[offset] ?? null);
      offset = 0;
    }
    node.insertData(offset, text);
    selection.collapse(node, offset + text.length);
    inserted = true;
  });
  return inserted;
}

/** jsdom has no `Selection.modify`. This stand-in records the browser caret
 * motion the composer asks for and performs the moves it can without layout,
 * so the editor's selection sync after the move is exercised too: a character
 * within a text node, a line as the editor's text between newlines at the
 * nearest column (the document's end past the last line, as in a browser),
 * and the document boundaries. A focus at an element boundary, as ProseMirror
 * places it after select-all, first resolves into the text ending there. */
function stubSelectionModify() {
  const texts = (node: Node) => {
    if (node instanceof Text) return [node];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const found: Text[] = [];
    while (walker.nextNode()) found.push(walker.currentNode as Text);
    return found;
  };
  const resolve = (node: Node, offset: number): [Text, number] | null => {
    if (node instanceof Text) return [node, offset];
    const before = node.childNodes[offset - 1];
    const after = node.childNodes[offset];
    const end = before && texts(before).at(-1);
    if (end) return [end, end.length];
    const start = after && texts(after)[0];
    return start ? [start, 0] : null;
  };
  const modify = vi.fn(function (
    this: Selection,
    alter: string,
    direction: string,
    granularity: string,
  ) {
    const focus = this.focusNode && resolve(this.focusNode, this.focusOffset);
    const root = focus?.[0].parentElement?.closest('[role="textbox"]');
    if (!focus || !root) return;
    const [text, offset] = focus;
    const forward = direction === "right" || direction === "forward";
    let target: [Text, number] | undefined;
    if (granularity === "character")
      target = [
        text,
        Math.max(0, Math.min(text.length, offset + (forward ? 1 : -1))),
      ];
    else if (granularity === "line" || granularity === "documentboundary") {
      const all = texts(root);
      const value = all.map((node) => node.data).join("");
      const at = all
        .slice(0, all.indexOf(text))
        .reduce((sum, node) => sum + node.length, offset);
      const lineStart = (pos: number) =>
        pos ? value.lastIndexOf("\n", pos - 1) + 1 : 0;
      const lineEnd = (pos: number) => {
        const end = value.indexOf("\n", pos);
        return end === -1 ? value.length : end;
      };
      let next: number;
      if (granularity === "documentboundary") next = forward ? value.length : 0;
      else {
        const start = lineStart(at);
        const end = lineEnd(at);
        if (forward)
          next =
            end === value.length
              ? end
              : Math.min(end + 1 + (at - start), lineEnd(end + 1));
        else
          next =
            start === 0
              ? 0
              : Math.min(lineStart(start - 1) + (at - start), start - 1);
      }
      for (const node of all) {
        if (next <= node.length) {
          target = [node, next];
          break;
        }
        next -= node.length;
      }
    }
    if (!target) return;
    if (alter === "extend") this.extend(...target);
    else this.collapse(...target);
  });
  Object.defineProperty(Selection.prototype, "modify", {
    configurable: true,
    value: modify,
  });
  return modify;
}
function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: platform,
  });
}
afterEach(() => {
  Reflect.deleteProperty(Selection.prototype, "modify");
  Reflect.deleteProperty(navigator, "platform");
});

it.each(controlKeys)(
  "refuses %s committed as text at both native seams",
  async (_label, character) => {
    const h = mount("abc");
    const before = snapshot(h);
    // The cancelable seam: the DOM never changes.
    expect(nativeInsert(h.input, character)).toBe(false);
    expect(snapshot(h)).toEqual(before);
    // The observed seam: an insertion that arrived anyway is redrawn away.
    expect(nativeInsert(h.input, character, false)).toBe(true);
    await waitFor(() => expect(h.input.textContent).toBe("abc"));
    expect(snapshot(h)).toEqual(before);
    expect(h.input.selectionStart).toBe(3);
    expect(h.input.selectionEnd).toBe(3);
    await h.user.keyboard("d");
    expect(h.input).toHaveValue("abcd");
    expect(h.markdown()).toBe("abcd");
  },
);

it.each([
  ["a tab", "\t", "abc\t"],
  ["a newline", "\n", "abc\n"],
  // ProseMirror's DOM parser reads a carriage return as a newline.
  ["a carriage return", "\r", "abc\n"],
  // No key yields a control character beside real text; such text is left
  // alone rather than reshaped under the native selection that describes it.
  ["a control character beside real text, whole", "a\u001D", "abca\u001D"],
])("still inserts %s committed as text", async (_label, text, value) => {
  const h = mount("abc");
  expect(nativeInsert(h.input, text)).toBe(true);
  await waitFor(() => expect(h.input).toHaveValue(value));
  expect(h.draft().text).toBe(value);
  expect(h.input.selectionStart).toBe(value.length);
  expect(h.input.selectionEnd).toBe(value.length);
});

it.each([
  ["after text", async (h: ReturnType<typeof mount>) => h.input.value],
  [
    "on an empty trailing paragraph",
    async (h: ReturnType<typeof mount>) => {
      await h.user.keyboard("{Shift>}{Enter}{/Shift}");
      expect(h.input).toHaveValue("abc\n");
      return h.input.value;
    },
  ],
  [
    "directly after a mention chip",
    async (h: ReturnType<typeof mount>) => {
      act(() =>
        h.input.insertText("", { pubkey: "a".repeat(64), name: "Honey" }),
      );
      expect(h.input).toHaveValue("abc@Honey ");
      act(() => h.input.setSelectionRange(9, 9));
      return "abc@Honey ";
    },
  ],
  [
    "inside a list item",
    async (h: ReturnType<typeof mount>) => {
      await h.user.keyboard("{Shift>}{Enter}{/Shift}");
      act(() => h.input.toggleFormat("bullet_list"));
      await h.user.keyboard("item");
      expect(h.input.querySelector("ul > li")).toHaveTextContent("item");
      return h.input.value;
    },
  ],
])(
  "keeps the document unchanged by caret keys %s, and by a Right Arrow committed as text in either form",
  async (_context, setup) => {
    const h = mount("abc");
    const value = await setup(h);
    const before = snapshot(h);
    const start = h.input.selectionStart;
    for (const key of caretKeys) {
      await press(h, key);
      expect(snapshot(h), key).toEqual(before);
      expect(h.input.selectionStart, key).toBe(h.input.selectionEnd);
    }
    for (const [label, character] of rightArrowCharacters) {
      act(() => h.input.setSelectionRange(start, start));
      expect(nativeInsert(h.input, character), label).toBe(false);
      expect(snapshot(h), label).toEqual(before);
      expect(nativeInsert(h.input, character, false), label).toBe(true);
      await waitFor(() =>
        expect(h.input.textContent, label).not.toContain(character),
      );
      expect(snapshot(h), label).toEqual(before);
    }
    expect(h.input).toHaveValue(value);
    expect(h.draft().recipients.map((item) => item.name)).toEqual(
      value.includes("@Honey") ? ["Honey"] : [],
    );
  },
);

it.each(rightArrowCharacters)(
  "never runs a typed conversion for %s committed as text",
  async (_label, character) => {
    const h = mount();
    await h.user.keyboard("**a*");
    const before = snapshot(h);
    expect(nativeInsert(h.input, character, false)).toBe(true);
    await waitFor(() => expect(h.input.textContent).toBe("**a*"));
    expect(snapshot(h)).toEqual(before);
    await h.user.keyboard("*");
    expect(h.input.querySelector("strong")).toHaveTextContent("a");
    expect(h.markdown()).toBe("**a**");
  },
);

it("moves the caret for a Right Arrow reported as U+001D instead of typing it", () => {
  const h = mount("abc");
  const modify = stubSelectionModify();
  const before = snapshot(h);
  act(() => h.input.setSelectionRange(1, 1));
  let prevented = false;
  act(() => {
    prevented = !fireEvent.keyDown(h.input, mangled("ArrowRight"));
  });
  expect(prevented).toBe(true);
  expect(modify).toHaveBeenCalledExactlyOnceWith("move", "right", "character");
  expect(h.input.selectionStart).toBe(2);
  expect(h.input.selectionEnd).toBe(2);
  act(() => {
    prevented = !fireEvent.keyDown(h.input, mangled("ArrowLeft"));
  });
  expect(prevented).toBe(true);
  expect(modify).toHaveBeenLastCalledWith("move", "left", "character");
  expect(h.input.selectionStart).toBe(1);
  // Shift extends from the same anchor, as the named key would.
  act(() => {
    fireEvent.keyDown(h.input, mangled("ArrowRight", { shiftKey: true }));
  });
  expect(modify).toHaveBeenLastCalledWith("extend", "right", "character");
  expect(h.input.selectionStart).toBe(1);
  expect(h.input.selectionEnd).toBe(2);
  expect(snapshot(h)).toEqual(before);
});

/** Presses a key chord on the editor, returning the selection and whether the
 * editor handled the key itself. */
function chord(input: ComposerInputElement, init: KeyboardEventInit) {
  let prevented = false;
  act(() => {
    prevented = !fireEvent.keyDown(input, init);
  });
  return [input.selectionStart, input.selectionEnd, prevented] as const;
}
const controlKey = (key: "a" | "e" | "k", shiftKey = false) => ({
  key: shiftKey ? key.toUpperCase() : key,
  code: `Key${key.toUpperCase()}`,
  ctrlKey: true,
  shiftKey,
});
const optionKey = (key: "ArrowUp" | "ArrowDown") => ({
  key,
  code: key,
  // A browser's keyCode, so ProseMirror's own arrow handling runs as well.
  keyCode: key === "ArrowUp" ? 38 : 40,
  altKey: true,
});
const linked = `first\nbefore https://github.com/block/buzz/pull/117/changes after\nlast`;
const linkedLine = linked.indexOf("before");
const linkedEnd = linked.indexOf("\nlast");

/** A collapsed caret at `offset` after a key the editor handled itself. */
const handledAt = (offset: number) => [offset, offset, true] as const;

it("moves Control-A and Control-E to the paragraph edges across a link chip on Apple platforms", () => {
  setPlatform("MacIntel");
  const h = mount(linked, { links: true });
  expect(h.input.querySelectorAll("[data-link]")).toHaveLength(1);
  const before = snapshot(h);
  act(() => h.input.setSelectionRange(linkedEnd, linkedEnd));
  // The paragraph starts after the newline, not at the document start, and a
  // caret already at an edge stays there.
  expect(chord(h.input, controlKey("a"))).toEqual(handledAt(linkedLine));
  expect(chord(h.input, controlKey("a"))).toEqual(handledAt(linkedLine));
  expect(chord(h.input, controlKey("e"))).toEqual(handledAt(linkedEnd));
  chord(h.input, controlKey("a", true));
  expect(selection(h.input)).toEqual([linkedLine, linkedEnd, "backward"]);
  // Without Shift, a selection collapses to the edge beyond its far end.
  expect(chord(h.input, controlKey("e"))).toEqual(handledAt(linkedEnd));
  expect(snapshot(h)).toEqual(before);
});

it("moves Option-Up and Option-Down across a link chip, then on to the neighbouring paragraph", () => {
  setPlatform("MacIntel");
  const h = mount(linked, { links: true });
  const before = snapshot(h);
  act(() => h.input.setSelectionRange(linkedEnd, linkedEnd));
  expect(chord(h.input, optionKey("ArrowUp"))).toEqual(handledAt(linkedLine));
  // The same key reported as a control character takes the same path.
  expect(chord(h.input, mangled("ArrowUp", { altKey: true }))).toEqual(
    handledAt(0),
  );
  expect(chord(h.input, optionKey("ArrowUp"))).toEqual(handledAt(0));
  expect(chord(h.input, optionKey("ArrowDown"))).toEqual(handledAt(5));
  expect(chord(h.input, optionKey("ArrowDown"))).toEqual(handledAt(linkedEnd));
  expect(chord(h.input, optionKey("ArrowDown"))).toEqual(
    handledAt(linked.length),
  );
  expect(snapshot(h)).toEqual(before);
});

it("leaves Option-Up and Option-Down to the conversation shortcuts in an empty draft", () => {
  setPlatform("MacIntel");
  const h = mount("");
  // An unprevented key reaches the window's shortcut dispatcher, which steps
  // to the previous or next conversation while the composer has focus.
  expect(chord(h.input, optionKey("ArrowUp"))).toEqual([0, 0, false]);
  expect(chord(h.input, optionKey("ArrowDown"))).toEqual([0, 0, false]);
});

it("deletes through a link chip for Control-K, leaving plain text to the browser", () => {
  setPlatform("MacIntel");
  const h = mount(linked, { links: true });
  // Plain text to the paragraph's end stays native, for the native kill ring.
  const plain = linkedEnd - 3;
  act(() => h.input.setSelectionRange(plain, plain));
  expect(chord(h.input, controlKey("k"))).toEqual([plain, plain, false]);
  expect(h.input).toHaveValue(linked);
  act(() => h.input.setSelectionRange(linkedLine, linkedLine));
  expect(chord(h.input, controlKey("k"))).toEqual(handledAt(linkedLine));
  expect(h.input).toHaveValue("first\n\nlast");
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue(linked);
  expect(h.input.querySelectorAll("[data-link]")).toHaveLength(1);
});

it("leaves Control-A to select all off Apple platforms", () => {
  setPlatform("Linux x86_64");
  const h = mount("before https://github.com/block/buzz/pull/117 after", {
    links: true,
  });
  act(() => {
    fireEvent.keyDown(h.input, { key: "a", code: "KeyA", ctrlKey: true });
  });
  expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([
    0,
    h.input.value.length,
  ]);
});

it("steps over a mention chip for an arrow reported as a control character, as the named key does", () => {
  const h = mount("abc");
  const modify = stubSelectionModify();
  act(() => h.input.insertText("", { pubkey: "a".repeat(64), name: "Honey" }));
  expect(h.input).toHaveValue("abc@Honey ");
  for (const [code, from, to] of [
    ["ArrowRight", 3, 9],
    ["ArrowLeft", 9, 3],
  ] as const) {
    act(() => h.input.setSelectionRange(from, from));
    let prevented = false;
    act(() => {
      prevented = !fireEvent.keyDown(h.input, mangled(code));
    });
    expect(prevented, code).toBe(true);
    expect(h.input.selectionStart, code).toBe(to);
    expect(h.input.selectionEnd, code).toBe(to);
  }
  expect(modify).not.toHaveBeenCalled();
  expect(h.input).toHaveValue("abc@Honey ");
  expect(h.draft().recipients.map((item) => item.name)).toEqual(["Honey"]);
});

/** The editor selection's anchor and head in source offsets, with the text
 * between them. `selectionDirection` reads the editor's own anchor and head,
 * so a backward range here is a TextSelection that kept its direction: an
 * AllSelection always reports its anchor at the start. */
function range(h: ReturnType<typeof mount>) {
  const { selectionStart: start, selectionEnd: end } = h.input;
  const backward = h.input.selectionDirection === "backward";
  return {
    anchor: backward ? end : start,
    head: backward ? start : end,
    text: h.input.value.slice(start, end),
  };
}

it("keeps a Shift move reported as a control character directional when it reaches both document edges, so reversing it shrinks the selection", () => {
  setPlatform("MacIntel");
  const h = mount("abc\ndef");
  const modify = stubSelectionModify();
  const before = snapshot(h);
  expect(range(h)).toEqual({ anchor: 7, head: 7, text: "" });
  // Cmd+Shift+Up from the end selects everything, anchored at the end: not
  // the AllSelection a DOM select-all becomes, whose anchor is the start.
  act(() => {
    fireEvent.keyDown(
      h.input,
      mangled("ArrowUp", { metaKey: true, shiftKey: true }),
    );
  });
  expect(modify).toHaveBeenLastCalledWith(
    "extend",
    "backward",
    "documentboundary",
  );
  expect(range(h)).toEqual({ anchor: 7, head: 0, text: "abc\ndef" });
  // Shift+Down then shrinks the selection from its head, and again back to
  // the anchor, instead of extending from the start.
  act(() => {
    fireEvent.keyDown(h.input, mangled("ArrowDown", { shiftKey: true }));
  });
  expect(modify).toHaveBeenLastCalledWith("extend", "forward", "line");
  expect(range(h)).toEqual({ anchor: 7, head: 4, text: "def" });
  act(() => {
    fireEvent.keyDown(h.input, mangled("ArrowDown", { shiftKey: true }));
  });
  expect(range(h)).toEqual({ anchor: 7, head: 7, text: "" });
  expect(snapshot(h)).toEqual(before);
});

it("shrinks a select-all by one character for a Shift+Left reported as a control character, instead of collapsing it", () => {
  setPlatform("MacIntel");
  const h = mount("abc");
  const modify = stubSelectionModify();
  const before = snapshot(h);
  act(() => {
    fireEvent.keyDown(h.input, { key: "a", code: "KeyA", metaKey: true });
  });
  expect(range(h)).toEqual({ anchor: 0, head: 3, text: "abc" });
  // The whole-document selection's head sits after the paragraph, not after
  // an inline leaf: the move is the browser's, one character at a time.
  let prevented = false;
  act(() => {
    prevented = !fireEvent.keyDown(
      h.input,
      mangled("ArrowLeft", { shiftKey: true }),
    );
  });
  expect(prevented).toBe(true);
  expect(modify).toHaveBeenCalledExactlyOnceWith("extend", "left", "character");
  expect(range(h)).toEqual({ anchor: 0, head: 2, text: "ab" });
  expect(snapshot(h)).toEqual(before);
});

it.each([
  ["MacIntel", "ArrowRight", { altKey: true }, ["move", "right", "word"]],
  [
    "MacIntel",
    "ArrowLeft",
    { metaKey: true },
    ["move", "left", "lineboundary"],
  ],
  [
    "MacIntel",
    "ArrowLeft",
    { metaKey: true, shiftKey: true },
    ["extend", "left", "lineboundary"],
  ],
  ["MacIntel", "ArrowUp", {}, ["move", "backward", "line"]],
  // Plain Option-Up is a paragraph command the editor runs itself.
  [
    "MacIntel",
    "ArrowUp",
    { altKey: true, shiftKey: true },
    ["extend", "backward", "paragraphboundary"],
  ],
  [
    "MacIntel",
    "ArrowDown",
    { metaKey: true },
    ["move", "forward", "documentboundary"],
  ],
  ["MacIntel", "Home", {}, null],
  [
    "MacIntel",
    "End",
    { shiftKey: true },
    ["extend", "forward", "documentboundary"],
  ],
  ["MacIntel", "PageUp", {}, null],
  ["Win32", "ArrowRight", { ctrlKey: true }, ["move", "right", "lineboundary"]],
  ["Win32", "ArrowRight", { metaKey: true }, ["move", "right", "character"]],
  ["Win32", "Home", {}, ["move", "backward", "lineboundary"]],
  ["Win32", "End", { shiftKey: true }, ["extend", "forward", "lineboundary"]],
] as const)(
  "on %s asks the browser to move the caret for %s reported as a control character with %o",
  (platform, code, init, call) => {
    setPlatform(platform);
    const h = mount("abc");
    const modify = stubSelectionModify();
    const before = snapshot(h);
    act(() => h.input.setSelectionRange(1, 1));
    let prevented = false;
    act(() => {
      prevented = !fireEvent.keyDown(h.input, mangled(code, init));
    });
    expect(prevented).toBe(true);
    if (call) expect(modify).toHaveBeenCalledExactlyOnceWith(...call);
    else expect(modify).not.toHaveBeenCalled();
    expect(snapshot(h)).toEqual(before);
    expect(h.input).toHaveValue("abc");
  },
);

it("leaves a named caret key to the browser", () => {
  const h = mount("abc");
  const modify = stubSelectionModify();
  act(() => h.input.setSelectionRange(1, 1));
  let prevented = true;
  act(() => {
    prevented = !fireEvent.keyDown(h.input, {
      key: "ArrowRight",
      code: "ArrowRight",
      keyCode: 39,
    });
  });
  expect(prevented).toBe(false);
  expect(modify).not.toHaveBeenCalled();
  expect(h.input.selectionStart).toBe(1);
});

it("inserts batch recipients in one transaction and undoes both spans together", () => {
  const h = mount("Before @Court after");
  const people = [
    { pubkey: "a".repeat(64), name: "Carl" },
    { pubkey: "b".repeat(64), name: "Donut" },
  ];
  act(() =>
    expect(
      h.input.insertText("@Carl @Donut ", people, { start: 7, end: 13 }),
    ).toBe(true),
  );
  expect(h.draft().recipients.map(({ pubkey }) => pubkey)).toEqual(
    people.map(({ pubkey }) => pubkey),
  );
  expect(h.input).toHaveValue("Before @Carl @Donut  after");
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue("Before @Court after");
  expect(h.draft().recipients).toEqual([]);
  act(() => h.input.undo(true));
  expect(h.draft().recipients).toHaveLength(2);
});
it("rejects batch overflow without changing text, recipient spans or undo history", () => {
  const h = mount();
  const people = Array.from({ length: 31 }, (_, i) => ({
    pubkey: i.toString(16).padStart(64, "0"),
    name: `Agent ${i}`,
  }));
  act(() => expect(h.input.insertText("", people)).toBe(true));
  const before = h.draft();
  const more = [
    { pubkey: "a".repeat(64), name: "Carl" },
    { pubkey: "b".repeat(64), name: "Donut" },
  ];
  act(() => expect(h.input.insertText("", more)).toBe(false));
  expect(h.draft()).toEqual(before);
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue("");
});
it("rejects a batch that exceeds message length without partial insertion", () => {
  const h = mount("x".repeat(15990));
  const before = h.draft();
  act(() =>
    expect(
      h.input.insertText("", [
        { pubkey: "a".repeat(64), name: "Carl" },
        { pubkey: "b".repeat(64), name: "Donut" },
      ]),
    ).toBe(false),
  );
  expect(h.draft()).toEqual(before);
});

// Pending mentions: Space committed a name before the chooser could decide.
// The host resolves the chip later; the editor owns its undo and persistence.
const example = { pubkey: "a".repeat(64), name: "Example Agent" };
function pendingChip(h: ReturnType<typeof mount>) {
  return h.input.querySelector('[data-state="loading"]');
}
it("inserts a pending chip as one undo step that restores the typed query", () => {
  const h = mount("hi @example");
  let id: string | false = false;
  act(() => {
    id = h.input.insertPendingMention("example", { start: 3, end: 11 });
  });
  expect(id).toMatch(/^pending-/);
  expect(h.input).toHaveValue("hi @example ");
  expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([12, 12]);
  expect(h.draft().recipients).toEqual([]);
  expect(h.draft().pending).toEqual([
    { id, name: "example", start: 3, end: 11 },
  ]);
  expect(pendingChip(h)).toHaveTextContent("@example");
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue("hi @example");
  expect(h.draft().pending).toBeUndefined();
  act(() => h.input.undo(true));
  expect(h.draft().pending?.map((item) => item.id)).toEqual([id]);
});
it("refuses a pending chip away from the caret, over other text, or in code", () => {
  const h = mount("hi @example");
  act(() => h.input.setSelectionRange(5, 5));
  act(() =>
    expect(h.input.insertPendingMention("example", { start: 3, end: 11 })).toBe(
      false,
    ),
  );
  act(() => h.input.setSelectionRange(11, 11));
  act(() =>
    expect(h.input.insertPendingMention("other", { start: 3, end: 11 })).toBe(
      false,
    ),
  );
  act(() => h.input.toggleFormat("code_block"));
  act(() =>
    expect(h.input.insertPendingMention("example", { start: 3, end: 11 })).toBe(
      false,
    ),
  );
  expect(h.input).toHaveValue("hi @example");
  expect(h.draft().pending).toBeUndefined();
});
it("settles a pending chip into its recipient's current name, keeping the caret and the typed text as the undo target", async () => {
  const h = mount("hi @example");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("example", { start: 3, end: 11 }) || "";
  });
  await h.user.type(h.input, "there");
  expect(h.input).toHaveValue("hi @example there");
  act(() => h.input.setSelectionRange(14, 14));
  act(() => expect(h.input.settlePendingMention(id, example)).toBe(true));
  expect(h.input).toHaveValue("hi @Example Agent there");
  expect(h.draft().pending).toBeUndefined();
  expect(h.draft().recipients).toEqual([{ ...example, start: 3, end: 17 }]);
  // The caret kept its place in the prose after the chip.
  expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([20, 20]);
  expect(pendingChip(h)).toBeNull();
  act(() => expect(h.input.settlePendingMention(id, example)).toBe(false));
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue("hi @Example Agent ");
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue("hi @example");
  expect(h.draft().recipients).toEqual([]);
});
it("settles a pending chip back into plain text while the editor is read-only", () => {
  const h = mount("@example");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("example", { start: 0, end: 8 }) || "";
  });
  act(() => {
    h.input.readOnly = true;
  });
  act(() => expect(h.input.settlePendingMention(id, null)).toBe(true));
  expect(h.input).toHaveValue("@example ");
  expect(h.draft().pending).toBeUndefined();
  expect(h.draft().recipients).toEqual([]);
  expect(h.input.querySelector("[data-source]")).toBeNull();
});
it("holds a settle that lands during a composition until the composition ends", async () => {
  const h = mount("hi @example");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("example", { start: 3, end: 11 }) || "";
  });
  act(() => fireEvent.compositionStart(h.input));
  let held: boolean | Promise<boolean> = false;
  act(() => {
    held = h.input.settlePendingMention(id, example);
  });
  expect(held).toBeInstanceOf(Promise);
  expect(h.input).toHaveValue("hi @example ");
  expect(pendingChip(h)).toHaveTextContent("@example");
  expect(h.draft().recipients).toEqual([]);
  await act(async () => fireEvent.compositionEnd(h.input));
  await expect(held).resolves.toBe(true);
  expect(h.input).toHaveValue("hi @Example Agent ");
  expect(h.draft().pending).toBeUndefined();
  expect(h.draft().recipients).toEqual([{ ...example, start: 3, end: 17 }]);
  expect(pendingChip(h)).toBeNull();
});
it("applies a held settle after the composition's final text has been read", async () => {
  const h = mount("hi @example");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("example", { start: 3, end: 11 }) || "";
  });
  act(() => fireEvent.compositionStart(h.input));
  let held: boolean | Promise<boolean> = false;
  act(() => {
    held = h.input.settlePendingMention(id, null);
  });
  const after = h.input.querySelector("[data-source]")?.nextSibling;
  if (!(after instanceof Text)) throw new Error("No text after the chip");
  await act(async () => {
    // The IME commits its text and ends the composition in one task;
    // ProseMirror reads the record only after compositionend.
    after.nodeValue = " ab";
    fireEvent.compositionEnd(h.input);
  });
  await expect(held).resolves.toBe(true);
  expect(h.input).toHaveValue("hi @example ab");
  expect(h.draft().pending).toBeUndefined();
  expect(pendingChip(h)).toBeNull();
});
it("answers a held settle false when its chip is gone by the time the composition ends", async () => {
  const h = mount("hi @example");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("example", { start: 3, end: 11 }) || "";
  });
  act(() => fireEvent.compositionStart(h.input));
  let held: boolean | Promise<boolean> = false;
  act(() => {
    held = h.input.settlePendingMention(id, example);
  });
  await act(async () => {
    h.input.querySelector("[data-source]")?.remove();
    fireEvent.compositionEnd(h.input);
  });
  await expect(held).resolves.toBe(false);
  expect(h.input).toHaveValue("hi  ");
  expect(h.draft().pending).toBeUndefined();
  expect(h.draft().recipients).toEqual([]);
});
it("keeps the typed text when the recipient's name would overrun the limit", () => {
  const h = mount("@example", { maxLength: 12 });
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("example", { start: 0, end: 8 }) || "";
  });
  act(() => expect(h.input.settlePendingMention(id, example)).toBe(true));
  expect(h.input).toHaveValue("@example ");
  expect(h.draft().recipients).toEqual([]);
});
const miraExample = { pubkey: "a".repeat(64), name: "Mira Example" };
it("extends a pending chip over the typed words that complete a longer name, keeping the caret and the typed text as the undo target", async () => {
  const h = mount("hi @mira");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("mira", { start: 3, end: 8 }) || "";
  });
  await h.user.type(h.input, "Example there");
  expect(h.input).toHaveValue("hi @mira Example there");
  act(() => expect(h.input.extendPendingMention(id, " Example")).toBe(true));
  expect(h.input).toHaveValue("hi @mira Example there");
  expect(h.draft().pending).toEqual([
    { id, name: "mira Example", start: 3, end: 16 },
  ]);
  expect(pendingChip(h)).toHaveTextContent("@mira Example");
  expect(h.input.querySelectorAll("[data-source]")).toHaveLength(1);
  // The caret kept its place in the prose after the chip.
  expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([22, 22]);
  act(() => expect(h.input.settlePendingMention(id, miraExample)).toBe(true));
  expect(h.input).toHaveValue("hi @Mira Example there");
  expect(h.draft().pending).toBeUndefined();
  expect(h.draft().recipients).toEqual([{ ...miraExample, start: 3, end: 16 }]);
  // Undo takes the words typed after the chip first, then the chip's own
  // typed query, as it does for a chip that settled unextended.
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue("hi @Mira Example");
  expect(h.draft().recipients).toEqual([{ ...miraExample, start: 3, end: 16 }]);
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue("hi @mira");
  expect(h.draft().recipients).toEqual([]);
  expect(h.draft().pending).toBeUndefined();
  act(() => h.input.undo(true));
  expect(h.input).toHaveValue("hi @Mira Example");
});
it("refuses to extend a pending chip over text that no longer begins with the words, or that is gone", async () => {
  const h = mount("@mira");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("mira", { start: 0, end: 5 }) || "";
  });
  await h.user.type(h.input, "Exam");
  act(() => expect(h.input.extendPendingMention(id, " Example")).toBe(false));
  act(() => expect(h.input.extendPendingMention(id, "")).toBe(false));
  act(() => expect(h.input.extendPendingMention("other", " Exam")).toBe(false));
  expect(h.input).toHaveValue("@mira Exam");
  expect(h.draft().pending).toEqual([{ id, name: "mira", start: 0, end: 5 }]);
  act(() => expect(h.input.settlePendingMention(id, null)).toBe(true));
  act(() => expect(h.input.extendPendingMention(id, " Exam")).toBe(false));
  expect(h.input).toHaveValue("@mira Exam");
});
it("extends a pending chip while the editor is read-only, and settling it to text restores the typed words", async () => {
  const h = mount("@mira");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("mira", { start: 0, end: 5 }) || "";
  });
  await h.user.type(h.input, "Example");
  act(() => {
    h.input.readOnly = true;
  });
  act(() => expect(h.input.extendPendingMention(id, " Example")).toBe(true));
  expect(h.draft().pending).toEqual([
    { id, name: "mira Example", start: 0, end: 13 },
  ]);
  act(() => expect(h.input.settlePendingMention(id, null)).toBe(true));
  expect(h.input).toHaveValue("@mira Example");
  expect(h.draft().pending).toBeUndefined();
  expect(h.input.querySelector("[data-source]")).toBeNull();
});
it("holds an extension that lands during a composition until the composition ends", async () => {
  const h = mount("@mira");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("mira", { start: 0, end: 5 }) || "";
  });
  await h.user.type(h.input, "Example");
  act(() => fireEvent.compositionStart(h.input));
  let held: boolean | Promise<boolean> = false;
  act(() => {
    held = h.input.extendPendingMention(id, " Example");
  });
  expect(held).toBeInstanceOf(Promise);
  expect(h.draft().pending).toEqual([{ id, name: "mira", start: 0, end: 5 }]);
  await act(async () => fireEvent.compositionEnd(h.input));
  await expect(held).resolves.toBe(true);
  expect(h.draft().pending).toEqual([
    { id, name: "mira Example", start: 0, end: 13 },
  ]);
  expect(pendingChip(h)).toHaveTextContent("@mira Example");
});
it("answers a held extension false when the composition committed name characters after the words", async () => {
  const h = mount("@mira");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("mira", { start: 0, end: 5 }) || "";
  });
  await h.user.type(h.input, "Example");
  act(() => fireEvent.compositionStart(h.input));
  let held: boolean | Promise<boolean> = false;
  act(() => {
    held = h.input.extendPendingMention(id, " Example");
  });
  const after = h.input.querySelector("[data-source]")?.nextSibling;
  if (!(after instanceof Text)) throw new Error("No text after the chip");
  await act(async () => {
    // The IME commits a longer word than the host read.
    after.nodeValue = " Examples";
    fireEvent.compositionEnd(h.input);
  });
  await expect(held).resolves.toBe(false);
  expect(h.input).toHaveValue("@mira Examples");
  expect(h.draft().pending).toEqual([{ id, name: "mira", start: 0, end: 5 }]);
});
it("returns a pending chip to its typed query when a name character is typed right after it", async () => {
  const h = mount("@mira");
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("mira", { start: 0, end: 5 }) || "";
  });
  await h.user.keyboard("{Backspace}nda");
  expect(h.input).toHaveValue("@miranda");
  expect(h.draft().pending).toBeUndefined();
  expect(h.input.querySelector("[data-source]")).toBeNull();
  act(() => expect(h.input.settlePendingMention(id, miraExample)).toBe(false));
  expect(h.draft().recipients).toEqual([]);
  act(() => h.input.undo(false));
  expect(h.draft().pending?.map((item) => item.id)).toEqual([id]);
  // Punctuation and quotes are name boundaries and keep the chip, as for a
  // recipient.
  for (const character of [",", "'", "’"]) {
    const p = mount("@mira");
    act(() => {
      p.input.insertPendingMention("mira", { start: 0, end: 5 });
    });
    await p.user.keyboard(`{Backspace}${character}`);
    expect(p.input).toHaveValue(`@mira${character}`);
    expect(p.draft().pending).toHaveLength(1);
  }
});
it("keeps a recipient when a quote or apostrophe follows its chip, however the character arrives", async () => {
  for (const character of ["'", "’", '"', "”"]) {
    const h = mount();
    act(() => h.input.insertText("", miraExample));
    await h.user.keyboard(`{Backspace}${character}s`);
    expect(h.input).toHaveValue(`@Mira Example${character}s`);
    expect(h.draft().recipients).toEqual([
      { ...miraExample, start: 0, end: 13 },
    ]);
  }
  // macOS smart quotes after a picked chip: with no chooser open, the `'`
  // keystroke is typed natively, then the system substitutes `’` for it with
  // no keydown of its own.
  const h = mount();
  act(() => h.input.insertText("", honey));
  await h.user.keyboard("{Backspace}'");
  expect(h.input).toHaveValue("@Honey'");
  const after = h.input.querySelector("[data-source]")?.nextSibling;
  if (!(after instanceof Text)) throw new Error("No text after the chip");
  await act(async () => after.replaceData(0, 1, "’"));
  expect(h.input).toHaveValue("@Honey’");
  expect(h.draft().recipients).toEqual([{ ...honey, start: 0, end: 6 }]);
});
it("leaves a pending chip to the identity link that adopts it, without restoring its typed query", async () => {
  const h = mount("[@honey", { links: true });
  let id = "";
  act(() => {
    id = h.input.insertPendingMention("honey", { start: 1, end: 7 }) || "";
  });
  await h.user.keyboard("{Backspace}");
  const link = `[@honeysuckle](${profileTarget(example.pubkey)})`;
  paste(h.input, link.slice(7));
  expect(h.markdown()).toBe(link);
  expect(h.input.querySelector(`[data-source="${link}"]`)).not.toBeNull();
  expect(h.draft().pending).toBeUndefined();
  act(() => expect(h.input.settlePendingMention(id, example)).toBe(false));
  expect(h.draft().recipients).toEqual([]);
});
it("deletes a pending chip with Backspace like any chip, emptying the projection", () => {
  const h = mount("@example");
  act(() => h.input.insertPendingMention("example", { start: 0, end: 8 }));
  act(() => h.input.setSelectionRange(8, 8));
  act(() => {
    fireEvent.keyDown(h.input, { key: "Backspace" });
  });
  expect(h.input).toHaveValue("@example ");
  expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([0, 8]);
  act(() => {
    fireEvent.keyDown(h.input, { key: "Backspace" });
  });
  expect(h.input).toHaveValue(" ");
  expect(h.draft().pending).toBeUndefined();
});
it("restores a persisted pending chip as plain text and copies it as its text", () => {
  const h = mount("@example");
  act(() => h.input.insertPendingMention("example", { start: 0, end: 8 }));
  act(() => h.input.setSelectionRange(0, 9));
  expect(clipboard(h.input, "copy").text).toBe("@example ");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  expect(saved.pending).toHaveLength(1);
  const restored = mount(saved);
  expect(restored.input).toHaveValue("@example ");
  expect(restored.draft().pending).toBeUndefined();
  expect(restored.input.querySelector("[data-source]")).toBeNull();
});

// Clipboard: composer copy/cut write both flavors; paste reads this app's own
// HTML back through selection-copy.ts and promotes accepted identity links.
const mic = "c".repeat(64);
const micLink = `[@Mic](${profileTarget(mic)})`;
const honey = { pubkey: "a".repeat(64), name: "Honey" };
const honeyLink = `[@Honey](${profileTarget(honey.pubkey)})`;
const copyHtml = (inner: string) =>
  `<div data-buzz-copy="composer">${inner}</div>`;
const timelineHtml = (inner: string) =>
  `<div data-buzz-copy="timeline"><p>${inner}</p></div>`;

function clipboard(input: ComposerInputElement, type: "copy" | "cut") {
  const data = new Map<string, string>();
  act(() => {
    fireEvent[type](input, {
      clipboardData: {
        setData: (flavor: string, value: string) => data.set(flavor, value),
      },
    });
  });
  return { text: data.get("text/plain"), html: data.get("text/html") };
}
/** What the paste side makes of a `text/html` payload. */
function readBack(html: string | undefined) {
  const template = document.createElement("template");
  template.innerHTML = html ?? "";
  return serializeNode(template.content, "markdown");
}

it.each(["First\nSecond", "First\n\nSecond", "  First\t  \n\n\nSecond  "])(
  "preserves composer whitespace %j through rich copy and paste",
  (source) => {
    const h = mount(source);
    act(() => h.input.setSelectionRange(0, h.input.value.length));
    const copied = clipboard(h.input, "copy");
    const target = mount();
    paste(target.input, copied.text ?? "", copied.html);
    expect(target.markdown()).toBe(source);
  },
);

it.each(["italic", "bold", "strike"] as const)(
  "round-trips punctuation-only %s next to letters",
  (format) => {
    const h = mount("x!y");
    act(() => {
      h.input.setSelectionRange(1, 2);
      h.input.toggleFormat(format);
      h.input.setSelectionRange(0, h.input.value.length);
    });
    const copied = clipboard(h.input, "copy");
    const target = mount();
    paste(target.input, copied.text ?? "", copied.html);
    expect(target.markdown()).toBe(h.markdown());
  },
);

it.each([
  ["inline", "`"],
  ["inline", " a`b "],
  ["block", "echo hi\n```\nend"],
  ["block", "echo hi\n\n"],
])("round-trips %s code containing %j", (kind, text) => {
  const h = mount({
    text: "",
    recipients: [],
    document: {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: kind === "block" ? "code_block" : "paragraph",
            ...(kind === "block" ? { attrs: { language: "sh" } } : {}),
            content: [
              {
                type: "text",
                text,
                ...(kind === "inline" ? { marks: [{ type: "code" }] } : {}),
              },
            ],
          },
        ],
      },
    },
  });
  act(() => h.input.setSelectionRange(0, h.input.value.length));
  const copied = clipboard(h.input, "copy");
  const target = mount();
  paste(target.input, copied.text ?? "", copied.html);
  expect(target.markdown()).toBe(h.markdown());
});

it("uses plain text when pasting rich content into an existing code block", async () => {
  const accept = vi.fn();
  const h = mount("", { links: true, acceptRecipient: accept });
  await h.user.keyboard("```x");
  paste(
    h.input,
    "Hi @Mic b",
    timelineHtml(
      `Hi <a href="${profileTarget(mic)}">@Mic</a> <strong>b</strong>`,
    ),
  );
  expect(h.input.querySelector("pre")?.textContent).toBe("xHi @Mic b");
  expect(h.markdown()).toBe("```\nxHi @Mic b\n```");
  expect(accept).not.toHaveBeenCalled();
});

it.each([
  ["First\n\nSecond", "First\n\nSecond", ""],
  ["First\nSecond", "First\nSecond", ""],
  ["> First\n>\n> Second", "First\n\nSecond", "blockquote"],
  ["- one\n- two", "one\ntwo", "ul li + li"],
  ["3. first\n4. second", "first\nsecond", 'ol[start="3"] li + li'],
  ["- one\n  \n  - sub\n- two", "one\n\nsub\ntwo", "ul li ul li"],
  ["> quoted", "quoted", "blockquote"],
  ["```sh\necho hi\n```", "echo hi\n", 'pre[data-language="sh"]'],
  ["```sh\necho hi\n\n```", "echo hi\n\n", 'pre[data-language="sh"]'],
  ["| a | b |\n| - | - |\n| 1 | 2 |", "a\tb\n1\t2", ""],
  ["a ||secret|| b", "a ||secret|| b", "[data-spoiler]"],
  ["para\n\n```sh\necho hi\n```\n\nafter", "para\n\necho hi\n\nafter", "pre"],
  [
    "intro\n\n- one\n- two\n\n> quoted\n\nouter",
    "intro\n\none\ntwo\n\nquoted\n\nouter",
    "ul li + li, blockquote",
  ],
])(
  "copies real timeline structure through the composer: %s",
  (content, plain, shown) => {
    const view = render(
      <MessageMarkdown
        row={{
          id: "m",
          channelId: "general",
          authorId: mic,
          content,
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
        media={() => undefined}
        onOpenLink={() => false}
      />,
    );
    const walker = document.createTreeWalker(
      view.container,
      NodeFilter.SHOW_TEXT,
    );
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (/\S/.test(node.textContent ?? "")) nodes.push(node as Text);
    const range = document.createRange();
    const first = nodes[0],
      last = nodes.at(-1);
    if (!first || !last) throw new Error("Missing rendered text");
    range.setStart(first, 0);
    range.setEnd(last, last.length);
    const copied = {
      text: serializeNode(view.container, "text", range),
      html: `<div data-buzz-copy="timeline">${serializeNode(view.container, "html", range)}</div>`,
    };
    expect(copied.text).toBe(plain);
    const target = mount();
    paste(target.input, copied.text, copied.html);
    expect(target.markdown()).toBe(content.startsWith("|") ? plain : content);
    // The composer shows the copied blocks, not their source.
    for (const selector of shown ? shown.split(", ") : [])
      expect(target.input.querySelector(selector)).not.toBeNull();
  },
);

it.each([
  ["# Title\n\n## Sub", "Title\n\nSub", "p + p + p"],
  ["- [ ] todo\n- [x] done", "[ ] todo\n[x] done", "ul li + li"],
  // A rule's source is respelled: see "pastes a copied rule" below.
  [
    "above\n\n---\n\nbelow",
    "above\n\n---\n\nbelow",
    "p + p + p + p + p",
    "above\n\n***\n\nbelow",
  ],
])(
  "copies %j, which the composer has no node for, as source that sends the same",
  (content, plain, shown, sent = content) => {
    const view = render(
      <MessageMarkdown
        row={{
          id: "m",
          channelId: "general",
          authorId: mic,
          content,
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
        media={() => undefined}
        onOpenLink={() => false}
      />,
    );
    // Select the whole message, as triple-click and select-all do.
    const range = document.createRange();
    range.selectNodeContents(view.container);
    const copied = {
      text: serializeNode(view.container, "text", range),
      html: `<div data-buzz-copy="timeline">${serializeNode(view.container, "html", range)}</div>`,
    };
    expect(copied.text).toBe(plain);
    const target = mount();
    paste(target.input, copied.text, copied.html);
    expect(target.markdown()).toBe(sent);
    expect(target.input.querySelector(shown)).not.toBeNull();
    expect(target.input.querySelector("h1, h2, hr, input")).toBeNull();
  },
);

it("pastes a copied rule after existing text without turning it into a heading", () => {
  // Copied as `<hr><p>after</p>`, the rule's line lands directly under `foo`,
  // where `---` would read as a setext underline; `***` cannot.
  const h = mount("foo");
  act(() => h.input.setSelectionRange(3, 3));
  paste(
    h.input,
    "---\n\nafter",
    '<div data-buzz-copy="timeline"><hr><p>after</p></div>',
  );
  expect(h.markdown()).toBe("foo\n***\n\nafter");
  const sent = render(
    <MessageMarkdown
      row={{
        id: "m",
        channelId: "general",
        authorId: mic,
        content: h.markdown(),
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      media={() => undefined}
      onOpenLink={() => false}
    />,
  );
  expect(sent.container.querySelector("p + hr + p")).not.toBeNull();
  expect(sent.container.querySelector("h1, h2")).toBeNull();
});

it.each([
  ["## Title\n\nbody", "h2", "foo## Title"],
  ["first\n\nbody", "p", "foofirst"],
])(
  "pastes a triple-clicked block of %j into the current line, as when selected exactly",
  (content, block, pasted) => {
    const view = render(
      <MessageMarkdown
        row={{
          id: "m",
          channelId: "general",
          authorId: mic,
          content,
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
        media={() => undefined}
        onOpenLink={() => false}
      />,
    );
    // Chromium and WebKit end a triple-click at the next block's start.
    const range = document.createRange();
    range.setStart(view.container.querySelector(block)?.firstChild as Text, 0);
    range.setEnd(view.container.querySelector(`${block} + p`) as Element, 0);
    const target = mount("foo");
    act(() => target.input.setSelectionRange(3, 3));
    paste(
      target.input,
      serializeNode(view.container, "text", range),
      `<div data-buzz-copy="timeline">${serializeNode(view.container, "html", range)}</div>`,
    );
    expect(target.markdown()).toBe(pasted);
    expect(target.input.querySelector("p > br:only-child")).toBeNull();
  },
);

it.each(["-", "3."])(
  "pastes a phrase selected across formatting in a %s list item as prose",
  (marker) => {
    const content = `${marker} ask **Morgan** about it`;
    const view = render(
      <MessageMarkdown
        row={{
          id: "m",
          channelId: "general",
          authorId: mic,
          content,
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
        media={() => undefined}
        onOpenLink={() => false}
      />,
    );
    const item = view.getByRole("listitem");
    const range = document.createRange();
    range.setStart(item.firstChild as Text, 1);
    range.setEnd(item.lastChild as Text, 3);
    expect(range.commonAncestorContainer).toBe(item);
    const selection = document.getSelection();
    if (!selection) throw new Error("Missing selection");
    selection.removeAllRanges();
    selection.addRange(range);
    const text = serializeSelection(selection, "text");
    const html = `<div data-buzz-copy="timeline">${serializeSelection(selection, "html")}</div>`;
    expect(text).toBe("sk Morgan ab");
    expect(serializeSelection(selection, "markdown")).toBe("sk **Morgan** ab");
    const target = mount();
    paste(target.input, text, html);
    expect(target.markdown()).toBe("sk **Morgan** ab");
    expect(target.input.querySelector("strong")).toHaveTextContent("Morgan");
    expect(target.input.querySelector("ul, ol")).toBeNull();

    // Selecting the enclosing list still keeps its marker and starting number.
    range.selectNodeContents(view.getByRole("list"));
    selection.removeAllRanges();
    selection.addRange(range);
    expect(serializeSelection(selection, "markdown")).toBe(content);
    expect(readBack(serializeSelection(selection, "html"))).toBe(content);
    selection.removeAllRanges();
  },
);

it("copies a selection as humanised text and semantic HTML that reads back as the slice's Markdown", () => {
  const h = mount("", { links: true });
  act(() => {
    h.input.insertText("Ask ");
    h.input.insertText("", honey);
    h.input.insertText(
      `in [#design](buzz://channel/design) or ${micLink} see https://example.com/docs and [docs](https://example.com/docs)`,
    );
    h.input.setSelectionRange(0, 3);
    h.input.toggleFormat("bold");
  });
  const source = `**Ask** @Honey in [#design](buzz://channel/design) or ${micLink} see https://example.com/docs and [docs](https://example.com/docs)`;
  expect(h.markdown()).toBe(source);
  act(() => h.input.setSelectionRange(0, h.input.value.length));
  const copied = clipboard(h.input, "copy");
  expect(copied).toEqual({
    text: "**Ask** @Honey in #design or @Mic see https://example.com/docs and [docs](https://example.com/docs)",
    html: copyHtml(
      `<p><strong>Ask</strong> <a href="${profileTarget(honey.pubkey)}">@Honey</a> in <a href="buzz://channel/design">#design</a> or <a href="${profileTarget(mic)}">@Mic</a> see <a href="https://example.com/docs">https://example.com/docs</a> and <a href="https://example.com/docs">docs</a></p>`,
    ),
  });
  expect(readBack(copied.html)).toBe(source.replace("@Honey", honeyLink));
  // A partial selection copies its slice; ranges are editor text offsets.
  const text = h.draft().text;
  act(() =>
    h.input.setSelectionRange(
      text.indexOf("@Honey"),
      text.indexOf(")", text.indexOf("#design")) + 1,
    ),
  );
  expect(clipboard(h.input, "copy")).toEqual({
    text: "@Honey in #design",
    html: copyHtml(
      `<p><a href="${profileTarget(honey.pubkey)}">@Honey</a> in <a href="buzz://channel/design">#design</a></p>`,
    ),
  });
});

it("cuts with both flavors and removes the selection", () => {
  const h = mount(`Ask ${micLink} now`, { links: true });
  act(() => h.input.setSelectionRange(4, 4 + micLink.length));
  expect(clipboard(h.input, "cut")).toEqual({
    text: "@Mic",
    html: copyHtml(`<p><a href="${profileTarget(mic)}">@Mic</a></p>`),
  });
  expect(h.markdown()).toBe("Ask  now");
});

it("writes blocks, breaks and spoilers as HTML the paste side reads back", async () => {
  const h = mount("first secret");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}next{Enter}```ls");
  act(() => {
    h.input.setSelectionRange(6, 12);
    h.input.toggleFormat("spoiler");
  });
  expect(h.input.querySelector("[data-spoiler]")).not.toBeNull();
  expect(h.markdown()).toBe("first ||secret||\nnext\n\n```\nls\n```");
  act(() => h.input.setSelectionRange(0, h.input.value.length));
  const copied = clipboard(h.input, "copy");
  expect(copied).toEqual({
    text: h.markdown(),
    html: copyHtml(
      `<p>first <span data-spoiler="">${spoilerDelimiter}secret${spoilerDelimiter}</span><br>next</p><pre><code>ls\n</code></pre>`,
    ),
  });
  expect(readBack(copied.html)).toBe(h.markdown());
  // Composer → composer keeps the spoiler a mark, as the timeline flavor does.
  const target = mount();
  paste(target.input, copied.text ?? "", copied.html);
  expect(target.markdown()).toBe(h.markdown());
  expect(target.input.querySelector("[data-spoiler]")).toHaveTextContent(
    "secret",
  );
});

it("copies marked whitespace, lists, a quote and a fence as HTML that reads back as the same Markdown", () => {
  const paragraph = (text: string) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });
  const item = (text: string) => ({
    type: "list_item",
    content: [paragraph(text)],
  });
  const h = mount({
    text: "",
    recipients: [],
    document: {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "a " },
              { type: "text", text: "bold ", marks: [{ type: "bold" }] },
              { type: "text", text: "b" },
            ],
          },
          { type: "bullet_list", content: [item("one"), item("two")] },
          {
            type: "ordered_list",
            attrs: { order: 3 },
            content: [item("first")],
          },
          { type: "blockquote", content: [paragraph("quoted")] },
          {
            type: "code_block",
            attrs: { language: "sh" },
            content: [{ type: "text", text: "ls" }],
          },
        ],
      },
    },
  });
  expect(h.markdown()).toBe(
    "a **bold** b\n\n- one\n- two\n\n3. first\n\n> quoted\n\n```sh\nls\n```",
  );
  act(() => h.input.setSelectionRange(0, h.input.value.length));
  const copied = clipboard(h.input, "copy");
  expect(copied).toEqual({
    text: h.markdown(),
    html: copyHtml(
      '<p>a <strong>bold </strong>b</p><ul><li><p>one</p></li><li><p>two</p></li></ul><ol start="3"><li><p>first</p></li></ol><blockquote><p>quoted</p></blockquote><pre><code class="language-sh">ls\n</code></pre>',
    ),
  });
  expect(readBack(copied.html)).toBe(h.markdown());
  // Pasted into another composer, the message sends with the same source and
  // shows the same blocks and marks.
  const target = mount();
  paste(target.input, copied.text ?? "", copied.html);
  expect(target.markdown()).toBe(h.markdown());
  for (const selector of [
    "strong",
    "ul li + li",
    'ol[start="3"] li',
    "blockquote p",
    'pre[data-language="sh"] code',
  ])
    expect(target.input.querySelector(selector)).not.toBeNull();
});

it("pastes this app's blocks as sibling nodes, one paragraph inline, and undoes as one step", () => {
  const list = copyHtml("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
  const h = mount("intro");
  act(() => h.input.setSelectionRange(5, 5));
  paste(h.input, "one\ntwo", list);
  expect(h.input.querySelectorAll("ul li")).toHaveLength(2);
  expect(h.markdown()).toBe("intro\n\n- one\n- two");
  expect(h.input.selectionStart).toBe(h.input.value.length);
  act(() => h.input.undo(false));
  expect(h.markdown()).toBe("intro");
  expect(h.input.querySelector("ul")).toBeNull();
  // One marked paragraph stays in the sentence; several paragraphs split it.
  const inline = mount("xxyy");
  act(() => inline.input.setSelectionRange(2, 2));
  paste(inline.input, "a b c", copyHtml("<p>a <strong>b</strong> c</p>"));
  expect(inline.markdown()).toBe("xxa **b** cyy");
  expect(inline.input.querySelectorAll("p")).toHaveLength(1);
  expect(inline.input.querySelector("strong")).toHaveTextContent("b");
  const split = mount("xxyy");
  act(() => split.input.setSelectionRange(2, 2));
  paste(
    split.input,
    "First\n\nSecond",
    '<div data-buzz-copy="timeline"><p>First</p><p>Second</p></div>',
  );
  expect(split.markdown()).toBe("xx\nFirst\n\nSecond\nyy");
});

const pastedList = copyHtml("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
const pastedOrdered = copyHtml(
  '<ol start="3"><li><p>one</p></li><li><p>two</p></li></ol>',
);
const pastedQuote = copyHtml("<blockquote><p>quoted</p></blockquote>");

// ProseMirror renders an empty textblock as `<p><br></p>`, which `p:empty`
// never matches; this is the shape an item-start paste must not leave.
const emptyParagraph = "p > br:only-child";

// A list item is `paragraph block*`: blocks cannot precede its first paragraph,
// so at its start a pasted list of the same kind joins the list and other
// blocks, including a list of the other kind, follow the paragraph, with the
// caret at the end of the paste. Elsewhere ProseMirror's placement stands:
// inside the last pasted block after text, before the text when pasting at its
// start.
it.each([
  [
    "bullet_list",
    0,
    pastedList,
    "- one\n- two\n- alpha",
    "ul > li + li + li",
    "\nalpha",
  ],
  [
    "bullet_list",
    5,
    pastedList,
    "- alpha\n  \n  - one\n  - two",
    "ul > li > p + ul > li + li",
    "",
  ],
  [
    "bullet_list",
    0,
    pastedQuote,
    "- alpha\n  \n  > quoted",
    "ul > li > p + blockquote",
    "",
  ],
  [
    "ordered_list",
    0,
    pastedOrdered,
    "1. one\n2. two\n3. alpha",
    "ol > li + li + li",
    "\nalpha",
  ],
  [
    "ordered_list",
    0,
    pastedList,
    "1. alpha\n   \n   - one\n   - two",
    "ol > li > p + ul > li + li",
    "",
  ],
  [
    "bullet_list",
    0,
    pastedOrdered,
    "- alpha\n  \n  3. one\n  4. two",
    'ul > li > p + ol[start="3"] > li + li',
    "",
  ],
  [
    "blockquote",
    0,
    pastedList,
    "> - one\n> - two\n>\n> alpha",
    "blockquote > ul + p",
    "alpha",
  ],
  [
    "blockquote",
    5,
    pastedList,
    "> alpha\n>\n> - one\n> - two",
    "blockquote > p + ul",
    "",
  ],
] as const)(
  "pastes this app's blocks with the caret in a %s at offset %i",
  (format, caret, html, markdown, shown, after) => {
    const h = mount("alpha");
    act(() => h.input.toggleFormat(format));
    act(() => h.input.setSelectionRange(caret, caret));
    const original = h.markdown();
    paste(h.input, "pasted", html);
    expect(h.markdown()).toBe(markdown);
    expect(h.input.querySelector(shown)).not.toBeNull();
    expect(h.input.querySelector(emptyParagraph)).toBeNull();
    expect(h.input.value.slice(h.input.selectionStart ?? 0)).toBe(after);
    act(() => h.input.undo(false));
    expect(h.markdown()).toBe(original);
  },
);

// Deleting the selection first puts a selection from an item's start on the
// same footing as a caret there, so no empty paragraph is left behind; a fully
// selected item text becomes the empty item the pasted items replace.
it.each([
  [[0, 5], pastedList, "- one\n- two\n- beta", "ul > li + li + li"],
  [[0, 3], pastedList, "- one\n- two\n- ha\n- beta", "ul > li + li + li + li"],
  [[0, 8], pastedList, "- one\n- two\n- ta", "ul > li + li + li"],
  [
    [0, 3],
    pastedQuote,
    "- ha\n  \n  > quoted\n- beta",
    "ul > li > p + blockquote",
  ],
  [[6, 10], pastedQuote, "- alpha\n\n> quoted", "ul + blockquote"],
] as const)(
  "pastes this app's blocks over a selection %j from a list item's start",
  async ([from, to], html, markdown, shown) => {
    const h = mount("alpha");
    act(() => h.input.toggleFormat("bullet_list"));
    await h.user.keyboard("{Enter}beta");
    expect(h.markdown()).toBe("- alpha\n- beta");
    act(() => h.input.setSelectionRange(from, to));
    paste(h.input, "pasted", html);
    expect(h.markdown()).toBe(markdown);
    expect(h.input.querySelector(shown)).not.toBeNull();
    expect(h.input.querySelector(emptyParagraph)).toBeNull();
    act(() => h.input.undo(false));
    expect(h.markdown()).toBe("- alpha\n- beta");
  },
);

// A blank item that no same-kind list replaces leaves its list first, as Enter
// there does, so a quote or a list of the other kind never sits beside an empty
// paragraph that sends as `- `; a same-kind list still takes the item's place.
it.each([
  ["bullet_list", pastedQuote, "- alpha\n\n> quoted", "ul + blockquote"],
  [
    "bullet_list",
    pastedOrdered,
    "- alpha\n\n3. one\n4. two",
    'ul + ol[start="3"]',
  ],
  ["bullet_list", pastedList, "- alpha\n- one\n- two", "ul > li + li + li"],
  ["ordered_list", pastedList, "1. alpha\n\n- one\n- two", "ol + ul"],
] as const)(
  "pastes this app's blocks into a blank %s item after the first",
  async (format, html, markdown, shown) => {
    const h = mount("alpha");
    act(() => h.input.toggleFormat(format));
    await h.user.keyboard("{Enter}");
    const original = h.markdown();
    paste(h.input, "pasted", html);
    expect(h.markdown()).toBe(markdown);
    expect(h.input.querySelector(shown)).not.toBeNull();
    expect(h.input.querySelector(emptyParagraph)).toBeNull();
    act(() => h.input.undo(false));
    expect(h.markdown()).toBe(original);
  },
);

it("lifts a blank middle or nested item out of its list before pasting a quote", async () => {
  const h = mount("alpha");
  act(() => h.input.toggleFormat("bullet_list"));
  await h.user.keyboard("{Enter}beta");
  act(() => h.input.setSelectionRange(6, 6));
  await h.user.keyboard("{Enter}");
  expect(h.markdown()).toBe("- alpha\n- \n- beta");
  act(() => h.input.setSelectionRange(6, 6));
  paste(h.input, "pasted", pastedQuote);
  expect(h.markdown()).toBe("- alpha\n\n> quoted\n\n- beta");
  expect(h.input.querySelector("ul + blockquote + ul")).not.toBeNull();
  expect(h.input.querySelector(emptyParagraph)).toBeNull();
  // A nested blank item leaves every list it is in, as Enter twice would.
  const nested = mount("alpha");
  act(() => nested.input.toggleFormat("bullet_list"));
  await nested.user.keyboard("{Enter}{Tab}");
  expect(nested.markdown()).toBe("- alpha\n  \n  - ");
  paste(nested.input, "pasted", pastedQuote);
  expect(nested.markdown()).toBe("- alpha\n\n> quoted");
  expect(nested.input.querySelector(emptyParagraph)).toBeNull();
  // A blank nested item before a sibling leaves both lists too: the first
  // lift moves the sibling under it, and the second takes them both out.
  const sibling = mount("alpha");
  act(() => sibling.input.toggleFormat("bullet_list"));
  await sibling.user.keyboard("{Enter}{Tab}beta");
  act(() => sibling.input.setSelectionRange(6, 6));
  await sibling.user.keyboard("{Enter}");
  expect(sibling.markdown()).toBe("- alpha\n  \n  - \n  - beta");
  act(() => sibling.input.setSelectionRange(6, 6));
  paste(sibling.input, "pasted", pastedQuote);
  expect(sibling.markdown()).toBe("- alpha\n\n> quoted\n\n- beta");
  expect(sibling.input.querySelector("ul + blockquote + ul")).not.toBeNull();
  expect(sibling.input.querySelector(emptyParagraph)).toBeNull();
});

it("joins a pasted list before a later item and keeps empty-item pastes whole", async () => {
  const h = mount("alpha");
  act(() => h.input.toggleFormat("bullet_list"));
  await h.user.keyboard("{Enter}beta");
  expect(h.markdown()).toBe("- alpha\n- beta");
  act(() => h.input.setSelectionRange(6, 6));
  paste(h.input, "pasted", pastedList);
  expect(h.markdown()).toBe("- alpha\n- one\n- two\n- beta");
  // An empty item takes the pasted items' place.
  const empty = mount();
  act(() => empty.input.toggleFormat("bullet_list"));
  paste(empty.input, "pasted", pastedList);
  expect(empty.markdown()).toBe("- one\n- two");
});

it("promotes identity links inside this app's pasted blocks", () => {
  const accept = vi.fn((pubkey: string) => ({ pubkey, name: "Mic" }));
  const h = mount("", { links: true, acceptRecipient: accept });
  paste(
    h.input,
    "Ping @Mic",
    copyHtml(
      `<ul><li><p>Ping <a href="${profileTarget(mic)}">@Mic</a></p></li></ul>`,
    ),
  );
  expect(h.input.querySelector("ul li [data-mention]")).toHaveTextContent(
    "@Mic",
  );
  expect(h.markdown()).toBe("- Ping @Mic");
  expect(h.draft().recipients).toEqual([
    { pubkey: mic, name: "Mic", start: 5, end: 9 },
  ]);
});

it("offers only the pasted content for promotion when it lands after an item's text", () => {
  const accept = vi.fn((pubkey: string) => ({ pubkey, name: "Mic" }));
  const h = mount(`Ping ${micLink}`, { links: true, acceptRecipient: accept });
  act(() => h.input.toggleFormat("bullet_list"));
  expect(h.draft().recipients).toEqual([]);
  // A quote pasted at the item's start follows its text; the display-only
  // link in that text is not part of the paste.
  act(() => h.input.setSelectionRange(0, 0));
  paste(h.input, "quoted", pastedQuote);
  expect(h.markdown()).toBe(`- Ping ${micLink}\n  \n  > quoted`);
  expect(accept).not.toHaveBeenCalled();
  expect(h.draft().recipients).toEqual([]);
  // A link inside the pasted quote is offered, wherever the quote lands.
  act(() => h.input.setSelectionRange(0, 0));
  paste(
    h.input,
    "See @Mic",
    copyHtml(
      `<blockquote><p>See <a href="${profileTarget(mic)}">@Mic</a></p></blockquote>`,
    ),
  );
  const markdown = h.markdown();
  expect(markdown).toBe(`- Ping ${micLink}\n  \n  > See @Mic\n  \n  > quoted`);
  expect(accept).toHaveBeenCalledTimes(1);
  // Recipient offsets index the draft's source text, not the wire Markdown.
  const at = h.draft().text.indexOf("See @Mic") + 4;
  expect(h.draft().recipients).toEqual([
    { pubkey: mic, name: "Mic", start: at, end: at + 4 },
  ]);
});

it("keeps this app's blocks literal in a code block and within the paste limit", () => {
  const list = copyHtml("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
  const h = mount();
  act(() => h.input.toggleFormat("code_block"));
  paste(h.input, "one\ntwo", list);
  expect(h.markdown()).toBe("```\none\ntwo\n```");
  expect(h.input.querySelector("ul")).toBeNull();
  const limited = mount("", { maxLength: 8 });
  paste(limited.input, "one\ntwo", list);
  expect(limited.markdown()).toBe("");
  expect(limited.input.querySelector("ul")).toBeNull();
});

it("pastes this app's HTML as identity Markdown and other HTML as its text/plain", () => {
  const h = mount("", { links: true });
  paste(
    h.input,
    "Ask @Mic in #design",
    timelineHtml(
      `Ask <a href="${profileTarget(mic)}">@Mic</a> in <a href="buzz://channel/design">#design</a>`,
    ),
  );
  expect(h.markdown()).toBe(
    `Ask ${micLink} in [#design](buzz://channel/design)`,
  );
  expect(h.input.querySelector("[data-identity]")).not.toBeNull();
  expect(h.draft().recipients).toEqual([]);
  paste(h.input, " plain", `<p><a href="${profileTarget(mic)}">@Mic</a></p>`);
  expect(h.markdown()).toBe(
    `Ask ${micLink} in [#design](buzz://channel/design) plain`,
  );
});

it("promotes pasted identity links the host accepts and keeps the rest as display chips", () => {
  const accept = vi.fn((pubkey: string) =>
    pubkey === mic ? { pubkey, name: "Mic Current" } : null,
  );
  const h = mount("", { links: true, acceptRecipient: accept });
  paste(h.input, `Ping ${micLink}, ${honeyLink} and @Mic `);
  const promoted = `Ping @Mic Current, ${honeyLink} and @Mic `;
  expect(h.markdown()).toBe(promoted);
  expect(h.draft().recipients).toEqual([
    { pubkey: mic, name: "Mic Current", start: 5, end: 17 },
  ]);
  // Bare @Mic never reaches the host.
  expect(accept).toHaveBeenCalledTimes(2);
  expect(accept).toHaveBeenCalledWith(mic);
  expect(accept).toHaveBeenCalledWith(honey.pubkey);
  expect(h.input.querySelector("[data-mention]")).toHaveTextContent(
    "@Mic Current",
  );
  expect(h.input.querySelectorAll("[data-identity]")).toHaveLength(1);
  // The paste and its promotion undo as one step.
  act(() => h.input.undo(false));
  expect(h.markdown()).toBe("");
  act(() => h.input.undo(true));
  expect(h.markdown()).toBe(promoted);
  expect(h.draft().recipients).toHaveLength(1);
  // This app's HTML promotes too; a later edit revokes like any chip.
  paste(h.input, "x", timelineHtml(`<a href="${profileTarget(mic)}">@Mic</a>`));
  expect(h.draft().recipients).toHaveLength(2);
  act(() => h.input.setSelectionRange(5, 17));
  act(() => h.input.insertText("Mic"));
  const edited = `Ping Mic, ${honeyLink} and @Mic @Mic Current`;
  expect(h.markdown()).toBe(edited);
  expect(h.draft().recipients).toEqual([
    {
      pubkey: mic,
      name: "Mic Current",
      start: edited.lastIndexOf("@"),
      end: edited.length,
    },
  ]);
});

it("promotes only at a mention boundary, under the recipient cap and within maxLength", () => {
  const accept = vi.fn((pubkey: string) => ({ pubkey, name: "Mic" }));
  const h = mount("", { links: true, acceptRecipient: accept });
  paste(h.input, `${micLink}x`);
  expect(h.markdown()).toBe(`${micLink}x`);
  const full = mount(
    followupDraft(
      Array.from({ length: 32 }, (_, index) => ({
        pubkey: index.toString(16).padStart(64, "0"),
        name: `R${index}`,
      })),
    ),
    { links: true, acceptRecipient: accept },
  );
  paste(full.input, `${micLink} `);
  expect(full.markdown()).toContain(`${micLink} `);
  expect(full.draft().recipients).toHaveLength(32);
  expect(accept).not.toHaveBeenCalled();
  const long = mount("", { links: true, acceptRecipient: accept });
  paste(long.input, "x", timelineHtml("y".repeat(16001)));
  expect(long.markdown()).toBe("");
});

it("preserves external linked labels, surrounding text and undo as one paste", () => {
  const h = mount("Before replace after", { links: true });
  act(() => h.input.setSelectionRange(7, 14));
  paste(
    h.input,
    "Read the guide & notes",
    '<p>Read <a href="https://example.com/guide"><b>the guide</b></a> &amp; <a href="https://example.com/notes">notes</a></p>',
  );
  expect(h.markdown()).toBe(
    "Before Read [the guide](https://example.com/guide) & [notes](https://example.com/notes) after",
  );
  act(() => h.input.undo(false));
  expect(h.markdown()).toBe("Before replace after");
});

it("ignores unsafe external destinations and external identity metadata", () => {
  const h = mount();
  paste(
    h.input,
    "unsafe safe",
    '<a href="javascript:alert(1)">unsafe</a> <a data-profile-target="fake" href="https://example.com/">safe</a><script>alert(1)</script>',
  );
  expect(h.markdown()).toBe("unsafe [safe](https://example.com/)");
  expect(h.draft().recipients).toEqual([]);
});

it("falls back to plain text when external HTML has no supported link", () => {
  const h = mount();
  paste(h.input, "original text", '<a href="/relative">different text</a>');
  expect(h.markdown()).toBe("original text");
});

it("keeps external linked text literal in code blocks and enforces the paste limit", () => {
  const html = '<a href="https://example.com/">guide</a>';
  const h = mount();
  act(() => h.input.toggleFormat("code_block"));
  paste(h.input, "guide", html);
  expect(h.markdown()).toBe("```\nguide\n```");
  const limited = mount("", { maxLength: 10 });
  paste(limited.input, "guide", html);
  expect(limited.markdown()).toBe("");
});

it.each(["ul", "ol", "blockquote", "pre", "h1"])(
  "pastes external %s as linked text without importing block formatting",
  (tag) => {
    const h = mount();
    const linked = '<a href="https://example.com/">guide</a>';
    const inner =
      tag === "ul" || tag === "ol"
        ? `<li>${linked}</li><li>notes</li>`
        : `${linked}<br>notes`;
    paste(h.input, "guide\nnotes", `<${tag}>${inner}</${tag}>`);
    expect(h.markdown()).toBe("[guide](https://example.com/)\nnotes");
    expect(h.input.querySelector("ul, ol, blockquote, pre")).toBeNull();
  },
);

it("drops external rules and checkboxes that this app's copies keep as source", () => {
  const h = mount();
  paste(
    h.input,
    "guide\nnotes",
    '<p><input type="checkbox" checked><a href="https://example.com/">guide</a></p><hr><p>notes</p>',
  );
  expect(h.markdown()).toBe("[guide](https://example.com/)\nnotes");
});

it.each([
  [
    "Ship 🚀 guide",
    'Ship <img data-stringify-type="emoji" alt="🚀"> <a href="https://example.com">guide</a>',
    "Ship 🚀 [guide](https://example.com/)",
  ],
  [
    "Hello :wave: Review the pull request",
    'Hello <img alt=":wave:" src="https://example.com/emoji.png"> Review <a href="https://example.com/review">the pull request</a>',
    "Hello :wave: Review [the pull request](https://example.com/review)",
  ],
  [
    "Read 🚀 guide",
    'Read <a href="https://example.com"><img alt="🚀"> guide</a>',
    "Read [🚀 guide](https://example.com/)",
  ],
  [
    "Read 🚀",
    'Read <a href="https://example.com"><img alt="🚀"></a>',
    "Read [🚀](https://example.com/)",
  ],
  [
    "Read guide",
    'Read <img src="https://example.com/image.png"><img alt=""> <a href="https://example.com">guide</a>',
    "Read  [guide](https://example.com/)",
  ],
  [
    "Read <img src=x onerror=alert(1)> guide",
    'Read <img alt="&lt;img src=x onerror=alert(1)&gt;"> <a href="https://example.com">guide</a>',
    "Read <img src=x onerror=alert(1)> [guide](https://example.com/)",
  ],
])(
  "preserves image alt text and safe external links: %s",
  (plain, html, expected) => {
    const h = mount();
    paste(h.input, plain, html);
    expect(h.markdown()).toBe(expected);
    expect(h.input.querySelector("img")).toBeNull();
    act(() => h.input.undo(false));
    expect(h.markdown()).toBe("");
  },
);

it.each([
  [
    "Ship 🚀 guide",
    'Ship <img alt="different"> <a href="https://example.com">guide</a>',
  ],
  [
    "Read guide",
    'Read <img alt="extra"> <a href="https://example.com">guide</a>',
  ],
  [
    "Ship 🚀 guide",
    'Ship <img alt="🚀" onerror="alert(1)"> <a href="javascript:alert(1)">guide</a>',
  ],
  [
    "guide",
    '<span hidden>hidden</span><a href="https://example.com">guide</a>',
  ],
  [
    "guide",
    '<noscript>hidden</noscript><a href="https://example.com">guide</a>',
  ],
])("keeps plain clipboard text authoritative: %s", (plain, html) => {
  const h = mount();
  paste(h.input, plain, html);
  expect(h.markdown()).toBe(plain);
});

it("accepts matching normalized whitespace and HTML without a plain flavor", () => {
  const h = mount();
  paste(
    h.input,
    "Read   guide",
    '<p>Read <a href="https://example.com">guide</a></p>',
  );
  expect(h.markdown()).toBe("Read [guide](https://example.com/)");
  const htmlOnly = mount();
  paste(htmlOnly.input, "", '<a href="https://example.com">guide</a>');
  expect(htmlOnly.markdown()).toBe("[guide](https://example.com/) ");
});

it.each([
  "https://e.com/?q=\\",
  "https://e.com/?q=a\\*b",
  "https://e.com/?q=&lt;",
])("preserves the pasted destination %s through Markdown parsing", (href) => {
  const h = mount();
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = "guide";
  paste(h.input, "guide", anchor.outerHTML);
  expect(scanMarkdown(h.markdown()).links.map((link) => link.url)).toEqual([
    href,
  ]);
});

it.each([
  [
    "Title\nDescription",
    "\n  <div>Title</div>\n\n  <div>Description</div>\n",
    "Title Description",
  ],
  ["safe\n\n# SECRET", "safe\n\n# SECRET", "safe # SECRET"],
  ["first\nsecond", "first<br>second", "first second"],
  ["first\nsecond", "<div>first</div><div>second</div>", "first second"],
])(
  "normalizes external link labels into one Markdown paragraph: %s",
  (plain, inner, label) => {
    for (const text of [plain, ""]) {
      const h = mount();
      paste(h.input, text, `<a href="https://example.com/">${inner}</a>`);
      expect(h.markdown().trim()).toBe(`[${label}](https://example.com/)`);
      expect(scanMarkdown(h.markdown()).links.map((link) => link.url)).toEqual([
        "https://example.com/",
      ]);
      expect(h.input).toHaveTextContent(label);
    }
  },
);

it.each([true, false])(
  "preserves an explicitly %s bold typing format across recipient replacement",
  async (enabled) => {
    const h = mount(enabled ? "" : "bold");
    act(() => {
      if (!enabled) {
        h.input.setSelectionRange(0, 4);
        h.input.toggleFormat("bold");
        h.input.setSelectionRange(2, 2);
      }
      h.input.toggleFormat("bold");
      expect(
        h.input.replaceRecipients([{ pubkey: "a".repeat(64), name: "Honey" }]),
      ).toBe(true);
      h.input.insertText("X");
    });
    expect(
      h.input.querySelector("strong")?.textContent?.includes("X") ?? false,
    ).toBe(enabled);
  },
);

it("leaves duplicate mentions and their positions unchanged for the same recipient set", () => {
  const first = { pubkey: "a".repeat(64), name: "Honey" };
  const second = { pubkey: "b".repeat(64), name: "Mary Jane" };
  const text = "ask @Honey about @Mary Jane and @Honey";
  const h = mount({
    text,
    recipients: [
      { ...first, start: 4, end: 10 },
      { ...second, start: 17, end: 27 },
      { ...first, start: 32, end: 38 },
    ],
  });
  act(() => expect(h.input.replaceRecipients([second, first])).toBe(true));
  expect(h.input).toHaveValue(text);
  expect(h.draft().recipients).toHaveLength(3);
});

it("keeps retained recipients in place while adding and removing others", () => {
  const first = { pubkey: "a".repeat(64), name: "Honey" };
  const second = { pubkey: "b".repeat(64), name: "Mary Jane" };
  const h = mount({
    text: "ask @Honey about X",
    recipients: [{ ...first, start: 4, end: 10 }],
  });
  act(() => expect(h.input.replaceRecipients([first, second])).toBe(true));
  expect(h.input).toHaveValue("@Mary Jane ask @Honey about X");
  act(() => expect(h.input.replaceRecipients([first])).toBe(true));
  expect(h.input).toHaveValue("ask @Honey about X");
});

it("rejects adding a recipient when retained duplicate mentions fill the limit", () => {
  const first = { pubkey: "a".repeat(64), name: "Honey" };
  const text = "@Honey ".repeat(32);
  const h = mount({
    text,
    recipients: Array.from({ length: 32 }, (_, i) => ({
      ...first,
      start: i * 7,
      end: i * 7 + 6,
    })),
  });
  act(() =>
    expect(
      h.input.replaceRecipients([
        first,
        { pubkey: "b".repeat(64), name: "Mary Jane" },
      ]),
    ).toBe(false),
  );
  expect(h.input).toHaveValue(text);
});

it("toggles inline code, quote and code block with Slack's chords as well as Buzz's", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  try {
    const h = mount();
    await h.user.keyboard("{Meta>}{Shift>}c{/Shift}{/Meta}");
    expect(h.formats()).toContain("code");
    await h.user.keyboard("{Meta>}{Shift>}c{/Shift}{/Meta}");
    expect(h.formats()).not.toContain("code");
    fireEvent.keyDown(h.input, {
      key: "(",
      code: "Digit9",
      metaKey: true,
      shiftKey: true,
    });
    expect(h.formats()).toContain("blockquote");
    fireEvent.keyDown(h.input, {
      key: "Ç",
      code: "KeyC",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(h.formats()).toContain("code_block");
  } finally {
    vi.restoreAllMocks();
  }
});

describe("oversized paste feedback", () => {
  it.each([16000, 16001])("checks the %i-character boundary", (length) => {
    const onPasteTooLong = vi.fn();
    const h = mount("", { onPasteTooLong });
    paste(h.input, "x".repeat(length));
    expect(h.markdown()).toBe(length === 16000 ? "x".repeat(length) : "");
    expect(onPasteTooLong).toHaveBeenCalledTimes(length === 16000 ? 0 : 1);
  });

  it("preserves the draft and selection, then accepts a replacement that fits", () => {
    const onPasteTooLong = vi.fn();
    const h = mount("keep replace", { maxLength: 12, onPasteTooLong });
    act(() => h.input.setSelectionRange(5, 12));
    paste(h.input, "abcdefgh");
    expect(onPasteTooLong).toHaveBeenCalledOnce();
    expect(h.markdown()).toBe("keep replace");
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([5, 12]);
    paste(h.input, "abcdefg");
    expect(h.markdown()).toBe("keep abcdefg");
    expect(onPasteTooLong).toHaveBeenCalledOnce();
    act(() => h.input.undo(false));
    expect(h.markdown()).toBe("keep replace");
  });

  it("reports plain-text shortcut pastes without reporting other rejected edits", () => {
    const onPasteTooLong = vi.fn();
    const h = mount("keep", { maxLength: 5, onPasteTooLong });
    act(() => h.input.insertText("too long"));
    expect(onPasteTooLong).not.toHaveBeenCalled();
    pasteRaw(h.input, "xx", "<p>x</p>");
    expect(onPasteTooLong).toHaveBeenCalledOnce();
    expect(h.markdown()).toBe("keep");
  });

  it("uses serialized length for copied blocks and external links", () => {
    const onPasteTooLong = vi.fn();
    const h = mount("", { maxLength: 10, onPasteTooLong });
    paste(
      h.input,
      "abcdefg",
      copyHtml("<blockquote><p>abcdefghi</p></blockquote>"),
    );
    expect(h.markdown()).toBe("");
    expect(onPasteTooLong).toHaveBeenCalledOnce();
    paste(h.input, "Docs", '<a href="https://example.com/docs">Docs</a>');
    expect(h.markdown()).toBe("");
    expect(onPasteTooLong).toHaveBeenCalledTimes(2);
  });
});
