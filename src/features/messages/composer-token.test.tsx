// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { EditableInput } from "./EditableInput";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";
import { composerClipboard } from "./composer-clipboard";
import {
  composerChips,
  readComposerDocument,
  readComposerSnapshot,
} from "./composer-document";
import {
  composerToken,
  composerTokenName,
  type ComposerToken,
} from "./composer-token";
import { mentionDraft, type MentionDraft } from "./mention-draft";

composerDOMFixture();
afterEach(cleanup);

const folder: ComposerToken = {
  kind: "folder",
  id: "/Development/notes",
  label: "@notes",
  executionHost: "82e43596-21a8-43c2-afb3-a9d8f2b4bf85",
};

it("bounds token JSON by UTF-8 bytes, including multibyte identities", () => {
  const template = { kind: "folder", id: "", label: "Folder" };
  const overhead = new TextEncoder().encode(JSON.stringify(template)).length;
  const count = Math.floor((8192 - overhead) / 3);
  const fitting = { ...template, id: "界".repeat(count) };
  expect(composerToken(fitting)).toEqual(fitting);
  expect(composerToken({ ...fitting, id: `${fitting.id}界` })).toBeUndefined();
});

it("copies a bounded, frozen token of a known kind and nothing else", () => {
  const nested = { ...folder, extra: { preserve: true } };
  const copied = composerToken(nested);
  expect(copied).toEqual(nested);
  expect(copied).not.toBe(nested);
  expect(Object.isFrozen(copied)).toBe(true);
  expect(Object.isFrozen(copied?.extra)).toBe(true);
  expect(composerTokenName(folder)).toBe("Folder @notes");
  for (const valid of [
    { kind: "skill", id: "s", label: "/s", target: "a".repeat(64) },
  ])
    expect(composerToken(valid)).toEqual(valid);
  for (const invalid of [
    { ...folder, id: "" },
    { ...folder, id: "x".repeat(4097) },
    { ...folder, id: "/path\u0000" },
    { ...folder, label: " " },
    { ...folder, label: "x".repeat(257) },
    { ...folder, label: "@\u202enotes" },
    { ...folder, extra: "界".repeat(3000) },
    { ...folder, kind: "nexus.unknown" },
    // Kinds name what a chip is, not the product that made it.
    { ...folder, kind: "nexus.folder" },
    { kind: "skill", id: "s", label: "/s", target: "bad" },
    [folder],
  ])
    expect(composerToken(invalid)).toBeUndefined();
});

const chips = (draft: MentionDraft) =>
  composerChips(readComposerSnapshot(draft.document));

function mount(initial: MentionDraft | string, maxLength = 16000) {
  const ref = createRef<ComposerInputElement>();
  let draft = mentionDraft(initial);
  function Editor() {
    const [value, setValue] = useState(draft);
    return (
      <EditableInput
        ref={ref}
        draft={value}
        value={value.text}
        disabled={false}
        placeholder="Draft"
        maxLength={maxLength}
        decorationsFor={() => []}
        onFormatsChange={() => {}}
        onDraftChange={(next) => {
          draft = next;
          setValue(next);
        }}
      />
    );
  }
  const view = render(<Editor />, { reactStrictMode: true });
  const input = ref.current;
  if (!input) throw new Error("Editor did not mount");
  act(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return { input, view, draft: () => draft };
}

it("replaces an open query with one chip: named by its label, written as its text, separate from recipients, one undo step, and restored from a saved draft", () => {
  const f = mount("Use @no");
  const start = f.input.value.indexOf("@no");
  act(() => {
    expect(f.input.insertToken(folder, { start, end: start + 3 })).toBe(true);
  });
  expect(f.input).toHaveValue(`Use ${folder.id} `);
  expect(f.input).toHaveFocus();
  expect(f.input.selectionStart).toBe(`Use ${folder.id} `.length);
  expect(screen.getByRole("img", { name: "Folder @notes" })).toHaveTextContent(
    "@notes",
  );
  expect(chips(f.draft())).toEqual([
    { token: folder, start, end: start + folder.id.length },
  ]);
  expect(f.draft().recipients).toEqual([]);
  // Plugins see MentionDraft; chips stay in the host-owned document.
  expect(Object.keys(f.draft()).sort()).toEqual([
    "document",
    "recipients",
    "text",
  ]);
  act(() => f.input.undo(false));
  expect(f.input).toHaveValue("Use @no");
  expect(chips(f.draft())).toEqual([]);
  act(() => f.input.undo(true));
  expect(f.input).toHaveValue(`Use ${folder.id} `);
  const saved = mentionDraft(JSON.parse(JSON.stringify(f.draft())));
  expect(chips(saved)).toEqual([
    { token: folder, start, end: start + folder.id.length },
  ]);
  f.view.unmount();
  const restored = mount(saved);
  expect(restored.input).toHaveValue(`Use ${folder.id} `);
  expect(
    screen.getByRole("img", { name: "Folder @notes" }),
  ).toBeInTheDocument();
  expect(chips(restored.draft()).map((span) => span.token)).toEqual([folder]);
});

it("writes a skill chip as `$name` and shows the name alone", () => {
  const skill: ComposerToken = {
    kind: "skill",
    id: "/example/skills/review/SKILL.md",
    label: "review",
    target: "a".repeat(64),
  };
  const f = mount("Use /re");
  act(() => {
    expect(f.input.insertToken(skill, { start: 4, end: 7 })).toBe(true);
  });
  expect(f.input).toHaveValue("Use $review ");
  expect(
    screen.getByRole("button", { name: "Skill review" }),
  ).toHaveTextContent(/^review$/);
  expect(chips(f.draft())).toEqual([{ token: skill, start: 4, end: 11 }]);
});

it("refuses an unknown kind, a stale or literal range, and edits beyond the chip or length bounds", () => {
  const f = mount("`@no` @no", 18);
  const before = f.draft();
  const open = f.input.value.lastIndexOf("@no");
  act(() => {
    expect(
      f.input.insertToken(
        { kind: "project", id: "p", label: "Project" } as never,
        { start: open, end: open + 3 },
      ),
    ).toBe(false);
    // Inside inline code, the query is literal text.
    expect(f.input.insertToken(folder, { start: 1, end: 4 })).toBe(false);
    expect(
      f.input.insertToken(
        { ...folder, id: "/a-path-too-long-to-fit" },
        { start: open, end: open + 3 },
      ),
    ).toBe(false);
    expect(
      f.input.insertToken(
        { ...folder, id: "" },
        { start: open, end: open + 3 },
      ),
    ).toBe(false);
  });
  expect(f.draft()).toEqual(before);
  const many = mount(" ".repeat(33));
  act(() => {
    for (let i = 0; i < 32; i++)
      expect(
        many.input.insertToken(
          { ...folder, id: `/${i.toString(36)}` },
          { start: i * 3, end: i * 3 + 1 },
        ),
      ).toBe(true);
    expect(
      many.input.insertToken({ ...folder, id: "/w" }, { start: 96, end: 97 }),
    ).toBe(false);
  });
  expect(chips(many.draft())).toHaveLength(32);
});

it("copies a chip as its text, never as a link its text resembles", () => {
  const link = { ...folder, id: "https://example.com" };
  const f = mount("x");
  act(() => {
    f.input.insertToken(link, { start: 0, end: 1 });
  });
  const clipboard = composerClipboard(
    readComposerDocument(f.draft(), []),
    document,
  );
  expect(clipboard.text).toBe("https://example.com ");
  expect(clipboard.html).not.toContain("<a");
});

it("restores a chip only from chip data its snapshot keeps", () => {
  const token = (
    attrs: Readonly<{ source: string; [key: string]: unknown }>,
    rest: object[] = [],
  ) => ({
    text: attrs.source,
    recipients: [],
    document: {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "token", attrs }, ...rest],
          },
        ],
      },
    },
  });
  const valid = mentionDraft(token({ source: folder.id, semantic: folder }));
  expect(chips(valid).map((span) => span.token)).toEqual([folder]);
  for (const attrs of [
    { source: folder.id, semantic: { ...folder, kind: "nexus.unknown" } },
    { source: "@other", semantic: folder },
    // The label is what the chip shows, not the text it stands for.
    { source: folder.label, semantic: folder },
    {
      source: folder.id,
      semantic: folder,
      recipient: { pubkey: "a".repeat(64), name: "notes" },
    },
    {
      source: folder.id,
      semantic: folder,
      resource: { uri: "buzz://channel/c", label: "@notes" },
    },
    {
      source: folder.id,
      semantic: folder,
      pending: { id: "p", name: "notes" },
    },
  ]) {
    expect(chips(mentionDraft(token(attrs)))).toEqual([]);
  }
  // A supported chip in a snapshot rejected for another reason.
  expect(
    chips(
      mentionDraft(
        token({ source: folder.id, semantic: folder }, [{ type: "text" }]),
      ),
    ),
  ).toEqual([]);
  // Without chip data, the same rejection still restores the saved text alone.
  expect(mentionDraft(token({ source: "@notes" }, [{ type: "text" }]))).toEqual(
    { text: "@notes", recipients: [] },
  );
});
