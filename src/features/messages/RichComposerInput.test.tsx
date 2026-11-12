// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useLayoutEffect, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComposerFormat, ComposerInputElement } from "./composer-dom";
import { composerMarkdown } from "./composer-markdown";
import type { ComposerSession } from "./composer-session";
import {
  composerDOMFixture,
  longMentionDraft,
  longRichDraft,
  pasteRichDraft,
  placeholderPeople,
} from "./composer-testing";
import { mentionDraft, type MentionDraft } from "./mention-draft";
import { MessageMarkdown } from "./MessageMarkdown";
import { RichComposerInput } from "./RichComposerInput";
import { bindNames } from "../identity-names/service";
import type { Profile } from "../relay/contracts";
import type { CustomEmoji } from "../relay/emoji";
import { scanMarkdown } from "../relay/message-content";
import { InlineChip } from "../../shared/design-system/ui/InlineChip";

// Pass-through spies: the real renderer and parser run; the test counts them.
vi.mock("./MessageMarkdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MessageMarkdown")>();
  return { ...actual, MessageMarkdown: vi.fn(actual.MessageMarkdown) };
});
vi.mock("../../shared/design-system/ui/InlineChip", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../shared/design-system/ui/InlineChip")
    >();
  return { ...actual, InlineChip: vi.fn(actual.InlineChip) };
});
vi.mock("../relay/message-content", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../relay/message-content")>();
  return { ...actual, scanMarkdown: vi.fn(actual.scanMarkdown) };
});

composerDOMFixture();
afterEach(cleanup);

function mount(initial?: MentionDraft) {
  const ref = createRef<ComposerInputElement>();
  let draft = initial ?? mentionDraft("");
  let commits = 0;
  let profiles: ReadonlyMap<string, Profile> = new Map();
  const profileListeners = new Set<() => void>();
  let channels: { status: string; channels: { id: string; name: string }[] } = {
    status: "ready",
    channels: [],
  };
  const channelListeners = new Set<() => void>();
  const library = { status: "ready", identities: [], definitions: [] };
  // A catalog snapshot, as MessageComposer passes it.
  const emoji: readonly CustomEmoji[] = [];
  const source = {
    media: (url: string) => url,
    profiles: {
      snapshot: () => profiles,
      subscribe: (listener: () => void) => {
        profileListeners.add(listener);
        return () => profileListeners.delete(listener);
      },
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
    channels: {
      list: () => channels,
      subscribeList: (listener: () => void) => {
        channelListeners.add(listener);
        return () => channelListeners.delete(listener);
      },
    },
  };
  const session = {
    ...source,
    names: bindNames(source as never),
  } as unknown as ComposerSession;
  // Stands in for MessageComposer, which re-renders whenever the editor
  // reports a draft or a toolbar state.
  function Host() {
    const [value, setValue] = useState<MentionDraft>(draft);
    const [, setFormats] = useState<readonly ComposerFormat[]>([]);
    useLayoutEffect(() => {
      commits++;
    });
    return (
      <RichComposerInput
        ref={ref}
        draft={value}
        value={value.text}
        disabled={false}
        placeholder="Message"
        maxLength={16000}
        session={session}
        scope="scope"
        channelId="channel"
        extensions={undefined}
        emoji={emoji}
        onDraftChange={(next) => {
          draft = next;
          setValue(next);
        }}
        onFormatsChange={setFormats}
      />
    );
  }
  render(<Host />, { reactStrictMode: true });
  const input = ref.current;
  if (!input) throw new Error("Editor did not mount");
  if (!initial) {
    pasteRichDraft(input, longRichDraft());
    expect(input.querySelectorAll("[data-source]")).toHaveLength(45);
    expect(input.querySelectorAll("strong")).toHaveLength(9);
    expect(input.querySelectorAll("li")).toHaveLength(38);
  }
  return {
    input,
    draft: () => draft,
    commits: () => commits,
    pasted: composerMarkdown(draft),
    /** Each chip's artwork, as its link label. */
    chips: () =>
      [...input.querySelectorAll<HTMLElement>("[data-source]")].map(
        (chip) => [chip.dataset.source, chip.textContent] as const,
      ),
    /** Each identity chip, as its kind and accessible name. */
    identities: () =>
      [
        ...input.querySelectorAll<HTMLElement>("[data-source] .inline-chip"),
      ].map(
        (chip) => `${chip.dataset.kind}: ${chip.getAttribute("aria-label")}`,
      ),
    setChannels(names: string[]) {
      act(() => {
        channels = {
          status: "ready",
          channels: names.map((name) => ({ id: name, name })),
        };
        for (const listener of channelListeners) listener();
      });
    },
    setProfiles(next: ReadonlyMap<string, Profile>) {
      act(() => {
        profiles = next;
        for (const listener of profileListeners) listener();
      });
    },
  };
}

it("decorates a channel reference once its channel arrives or leaves, not from a stale scan", () => {
  const h = mount(mentionDraft("see #general now"));
  expect(h.chips()).toEqual([]);
  h.setChannels(["general"]);
  expect(h.chips().map(([source]) => source)).toEqual(["#general"]);
  h.setChannels([]);
  expect(h.chips()).toEqual([]);
});

const label = (source = "") => source.match(/^\[(.*)\]\(/)?.[1];

it("types into a long rich draft without redrawing its link tokens or reparsing per pass", async () => {
  const h = mount();
  const text = h.draft().text;
  // Prose with later tokens, whose offsets every keystroke shifts.
  const middle = text.indexOf(" bravo", text.length / 2) + 1;
  act(() => h.input.setSelectionRange(middle, middle));
  const user = userEvent.setup();
  const renders = vi.mocked(MessageMarkdown);
  const parses = vi.mocked(scanMarkdown);
  // Whole-draft parses, not a token's own source.
  const draftParses = () =>
    parses.mock.calls.filter(([text]) => text.length > h.pasted.length / 2)
      .length;
  for (const key of "xyz") {
    renders.mockClear();
    parses.mockClear();
    const commits = h.commits();
    await user.keyboard(key);
    // One host commit per keystroke: an unchanged toolbar state re-renders
    // nothing, and unchanged tokens keep their artwork.
    expect(h.commits() - commits).toBe(1);
    expect(renders).not.toHaveBeenCalled();
    expect(draftParses()).toBe(1);
  }
  expect(h.input.querySelectorAll("[data-source]")).toHaveLength(45);
  expect(h.draft().text).toBe(
    `${text.slice(0, middle)}xyz${text.slice(middle)}`,
  );
  const sent = composerMarkdown(h.draft());
  expect(sent.split("xyz")).toHaveLength(2);
  expect(sent.replace("xyz", "")).toBe(h.pasted);
  act(() => h.input.undo(false));
  expect(composerMarkdown(h.draft())).toBe(h.pasted);
  expect(h.input.querySelectorAll("[data-source]")).toHaveLength(45);
});

it("deletes a chip without redrawing the chips after it, and restores it on undo", async () => {
  const h = mount();
  const chips = h.chips();
  const [first] = chips;
  if (!first?.[0]) throw new Error("No chip pasted");
  for (const [source, artwork] of chips) expect(artwork).toBe(label(source));
  const text = h.draft().text;
  const start = text.indexOf(first[0]);
  const end = start + first[0].length;
  act(() => h.input.setSelectionRange(start, end));
  const user = userEvent.setup();
  const renders = vi.mocked(MessageMarkdown);
  renders.mockClear();
  await user.keyboard("{Backspace}");
  // The first host leaves; every later host stays mounted with its artwork.
  expect(h.chips()).toEqual(chips.slice(1));
  expect(renders).not.toHaveBeenCalled();
  expect(h.draft().text).toBe(`${text.slice(0, start)}${text.slice(end)}`);
  renders.mockClear();
  act(() => h.input.undo(false));
  expect(h.chips()).toEqual(chips);
  expect(composerMarkdown(h.draft())).toBe(h.pasted);
  // Only the restored chip drew.
  expect(
    new Set(renders.mock.calls.map(([props]) => props.row.content)),
  ).toEqual(new Set([first[0]]));
});

it("types into a mention-heavy draft without redrawing its chips, which still follow profile changes", async () => {
  const people = placeholderPeople(20);
  const h = mount(longMentionDraft(people));
  expect(h.identities()).toEqual(
    people.map((person) => `person: Person ${person.name}`),
  );
  const text = h.draft().text;
  act(() => {
    h.input.focus();
    h.input.setSelectionRange(text.length, text.length);
  });
  const user = userEvent.setup();
  const renders = vi.mocked(InlineChip);
  renders.mockClear();
  for (const key of "xyz") {
    const commits = h.commits();
    await user.keyboard(key);
    expect(h.commits() - commits).toBe(1);
    expect(renders).not.toHaveBeenCalled();
  }
  expect(h.draft().text).toBe(`${text}xyz`);
  expect(h.draft().recipients).toHaveLength(20);
  // A profile's name and kind reach the chip, which redraws for them alone.
  const [first] = people;
  if (!first) throw new Error("No people");
  renders.mockClear();
  h.setProfiles(new Map([[first.pubkey, { name: "Renamed", isAgent: true }]]));
  expect(h.identities()).toEqual([
    "agent: Agent Renamed",
    ...people.slice(1).map((person) => `person: Person ${person.name}`),
  ]);
  // Only the renamed chip drew (twice, under StrictMode).
  expect(
    new Set(renders.mock.calls.map(([props]) => props.address.id)),
  ).toEqual(new Set([first.pubkey]));
});

it("edits a channel link as one chip: Backspace, Delete and typing remove it whole, arrows step over it, undo restores it", async () => {
  const link = "[\\#general](buzz://channel/general)";
  const text = `see ${link} now`;
  const start = 4,
    end = start + link.length;
  const h = mount(mentionDraft(text));
  expect(h.chips()).toEqual([[link, "#general"]]);
  const user = userEvent.setup();
  act(() => {
    h.input.focus();
    h.input.setSelectionRange(end, end);
  });
  await user.keyboard("{ArrowLeft}");
  expect(h.input.selectionStart).toBe(start);
  expect(h.chips()).toEqual([[link, "#general"]]);
  await user.keyboard("{ArrowRight}{Backspace}");
  expect(h.draft().text).toBe("see  now");
  expect(h.chips()).toEqual([]);
  act(() => h.input.undo(false));
  expect(composerMarkdown(h.draft())).toBe(text);
  expect(h.chips()).toEqual([[link, "#general"]]);
  act(() => h.input.setSelectionRange(start, start));
  await user.keyboard("{Delete}");
  expect(h.draft().text).toBe("see  now");
  act(() => h.input.undo(false));
  act(() => h.input.setSelectionRange(start - 1, end + 1));
  await user.keyboard("x");
  expect(h.draft().text).toBe("seexnow");
  act(() => h.input.undo(false));
  expect(composerMarkdown(h.draft())).toBe(text);
  act(() => h.input.undo(true));
  expect(h.draft().text).toBe("seexnow");
});

it("restores a channel link saved as editable text as one chip", async () => {
  const link = "[\\#general](buzz://channel/general)";
  const end = 4 + link.length;
  const h = mount(
    mentionDraft({
      text: `see ${link} now`,
      recipients: [],
      document: {
        version: 1,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "see " },
                { type: "token", attrs: { source: link, editAsText: true } },
                { type: "text", text: " now" },
              ],
            },
          ],
        },
      },
    }),
  );
  act(() => {
    h.input.focus();
    h.input.setSelectionRange(end, end);
  });
  await userEvent.setup().keyboard("{Backspace}");
  expect(h.draft().text).toBe("see  now");
});

it("keeps a bare channel URL editable as text", async () => {
  const text = "see buzz://channel/genx";
  const h = mount(mentionDraft(text));
  act(() => {
    h.input.focus();
    h.input.setSelectionRange(text.length, text.length);
  });
  await userEvent.setup().keyboard("{Backspace}");
  expect(h.draft().text).toMatch(/^see buzz:\/\/channel\/genx?$/);
});

it.each(["bold", "italic"])(
  "restores a channel link in %s as one chip without losing its format",
  async (mark) => {
    const link = "[\\#general](buzz://channel/general)";
    const end = 4 + link.length;
    const h = mount(
      mentionDraft({
        text: `see ${link} now`,
        recipients: [],
        document: {
          version: 1,
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "see " },
                  {
                    type: "token",
                    attrs: { source: link, editAsText: true },
                    marks: [{ type: mark }],
                  },
                  { type: "text", text: " now" },
                ],
              },
            ],
          },
        },
      }),
    );
    const formatted = composerMarkdown(h.draft());
    expect(formatted).not.toBe(`see ${link} now`);
    act(() => {
      h.input.focus();
      h.input.setSelectionRange(h.draft().text.length, h.draft().text.length);
    });
    const user = userEvent.setup();
    await user.keyboard("!");
    expect(composerMarkdown(h.draft())).toBe(`${formatted}!`);
    act(() => h.input.setSelectionRange(end, end));
    await user.keyboard("{Backspace}");
    expect(h.draft().text).toBe("see  now!");
  },
);
