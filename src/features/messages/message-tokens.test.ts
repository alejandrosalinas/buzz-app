import { expect, it } from "vitest";
import { composerTokenText, type ComposerToken } from "./composer-token";
import {
  MESSAGE_TOKENS_TAG,
  messageTokenTags,
  readMessageTokens,
  signMessageTokens,
  signedMessageTokenTags,
} from "./message-tokens";
import { scanMarkdown } from "../relay/message-content";
import {
  composerChips,
  composerSchema,
  projectComposerDocument,
  readComposerSnapshot,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";

const folder: ComposerToken = {
  kind: "folder",
  id: "/example/repos/buzz-app",
  label: "buzz-app",
};
const skill: ComposerToken = {
  kind: "skill",
  id: "/example/skills/review/SKILL.md",
  label: "review",
  target: "a".repeat(64),
};

it("sends a skill as `$name` and a folder as its path, literally and in authored order", () => {
  const atom = (semantic: ComposerToken) =>
    composerSchema.nodes.token.create({
      source: composerTokenText(semantic),
      semantic,
    });
  const draft = projectComposerDocument(
    composerSchema.nodes.doc.create(
      null,
      composerSchema.nodes.paragraph.create(null, [
        composerSchema.text("Use "),
        atom(skill),
        composerSchema.text(" in "),
        atom(folder),
      ]),
    ),
  ).draft;
  expect(composerMarkdown(draft)).toBe(
    "Use $review in /example/repos/buzz-app",
  );
  expect(
    composerChips(readComposerSnapshot(draft.document)).map(
      ({ token }) => token,
    ),
  ).toEqual([skill, folder]);
});

it("serializes syntax-like chip text literally, including under rich formatting", () => {
  const id = "/example/@Other /run [link](https://example.com) `code` **bold**";
  const selected = { ...folder, id };
  const atom = composerSchema.nodes.token.create(
    { source: id, semantic: selected },
    null,
    [composerSchema.marks.bold.create()],
  );
  const output = composerMarkdown(
    projectComposerDocument(
      composerSchema.nodes.doc.create(
        null,
        composerSchema.nodes.paragraph.create(null, [
          composerSchema.text("Before "),
          atom,
          composerSchema.text(" after"),
        ]),
      ),
    ).draft,
  );
  expect(scanMarkdown(output).links).toEqual([]);
  expect(output).not.toContain("@Other");
  expect(output).toMatch(/^Before \*\*/);
  expect(output).toMatch(/\*\* after$/);
});

it("round-trips exact chips with extra metadata in one tag", () => {
  expect(messageTokenTags([])).toEqual([]);
  const extra = { ...folder, executionHost: "example-host" };
  const tags = messageTokenTags([extra, skill]);
  expect(tags.map(([name]) => name)).toEqual([MESSAGE_TOKENS_TAG]);
  expect(readMessageTokens(tags)).toEqual([extra, skill]);
  expect(readMessageTokens([["buzz-tokens-v2", "future bytes"]])).toEqual([]);
});

it("rejects duplicate tags or chips, malformed shapes and oversized payloads", () => {
  const tag = messageTokenTags([folder])[0];
  if (!tag) throw new Error("Missing tag");
  for (const tags of [
    [tag, tag],
    [[MESSAGE_TOKENS_TAG, "{bad"]],
    [[MESSAGE_TOKENS_TAG, "[]"]],
    [[MESSAGE_TOKENS_TAG, JSON.stringify([{ ...folder, kind: "project" }])]],
    [[MESSAGE_TOKENS_TAG, JSON.stringify([{ ...skill, target: "agent" }])]],
  ])
    expect(() => readMessageTokens(tags)).toThrow();
  expect(() => messageTokenTags([folder, folder])).toThrow("duplicate");
  const large = Array.from({ length: 3 }, (_, i) => ({
    ...folder,
    id: String(i),
    extra: "界".repeat(2300),
  }));
  expect(() => messageTokenTags(large)).toThrow("too large");
  expect(() =>
    readMessageTokens([[MESSAGE_TOKENS_TAG, JSON.stringify(large)]]),
  ).toThrow();
  expect(() =>
    messageTokenTags(
      Array.from({ length: 33 }, (_, i) => ({ ...folder, id: String(i) })),
    ),
  ).toThrow();
});

it("gives the chips being signed only to the first send inside it", () => {
  const seen: string[][][] = [];
  const id = signMessageTokens([folder], () => {
    seen.push(signedMessageTokenTags());
    // A send an outbox subscriber makes meanwhile carries none.
    seen.push(signedMessageTokenTags());
    return "event";
  });
  expect(id).toBe("event");
  expect(seen).toEqual([messageTokenTags([folder]), []]);
  expect(signedMessageTokenTags()).toEqual([]);
  expect(() =>
    signMessageTokens([skill], () => {
      throw new Error("refused");
    }),
  ).toThrow("refused");
  // A refused send leaves nothing for the next one.
  expect(signedMessageTokenTags()).toEqual([]);
});
