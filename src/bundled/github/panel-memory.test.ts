import { expect, it } from "vitest";
import { createPanelMemory } from "./panel-memory";

const draft = {
  event: "COMMENT",
  body: "Looks right",
  head: "abc123",
} as const;

it("keeps one review per pull request in any casing, and its view per channel", () => {
  const memory = createPanelMemory();
  memory.setReview("https://github.com/Block/Private/pull/9", draft);
  memory.setView("https://github.com/Block/Private/pull/9", "changes", "alpha");
  const pull = "https://github.com/block/private/pull/9";
  expect(memory.get(pull, "alpha")).toEqual({ view: "changes", review: draft });
  expect(memory.get(pull, "beta")).toEqual({ review: draft });
  expect(memory.get(pull)).toEqual({ review: draft });
  memory.setReview(pull, undefined);
  expect(memory.get(pull, "alpha")).toEqual({ view: "changes" });
});

it("keeps nothing for what is not a pull request", () => {
  const memory = createPanelMemory();
  for (const url of [
    "https://github.com/block/private/issues/9",
    "https://github.com/block/private",
    "https://example.com/block/private/pull/9",
  ]) {
    memory.setView(url, "changes");
    memory.setReview(url, draft);
    expect(memory.get(url)).toEqual({});
  }
});
