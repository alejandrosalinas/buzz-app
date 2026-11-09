// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "./runtime";
import { useSettingsDraft } from "./settings-draft";

afterEach(cleanup);

function editor() {
  return renderHook(
    ({ key, saved, available }) => useSettingsDraft(key, saved, available),
    {
      initialProps: { key: "a", saved: DEFAULT_CONFIG, available: true },
      wrapper: StrictMode,
    },
  );
}

it("merges untouched fields, preserves edits, and clears a reverted edit", () => {
  const f = editor();
  act(() =>
    f.result.current.setDraft({ ...DEFAULT_CONFIG, instructions: "Draft" }),
  );
  const saved: Config = {
    ...DEFAULT_CONFIG,
    model: "opus",
    effort: "high",
    workspace: "/new",
  };
  f.rerender({ key: "a", saved, available: true });
  expect(f.result.current.draft).toEqual({ ...saved, instructions: "Draft" });
  expect(f.result.current.conflicts).toEqual([]);
  expect(f.result.current.changed).toBe(true);
  act(() => f.result.current.setDraft(saved));
  expect(f.result.current.changed).toBe(false);
});

it.each([true, false])(
  "keeps conflicts across unrelated updates until explicit resolution (saved=%s)",
  (useSaved) => {
    const f = editor();
    act(() =>
      f.result.current.setDraft({
        ...DEFAULT_CONFIG,
        model: "mine",
        effort: "high",
      }),
    );
    const saved = { ...DEFAULT_CONFIG, model: "theirs", effort: "low" };
    f.rerender({ key: "a", saved, available: true });
    expect(f.result.current.conflicts).toEqual(["model"]);
    f.rerender({
      key: "a",
      saved: { ...saved, workspace: "/new" },
      available: true,
    });
    expect(f.result.current.conflicts).toEqual(["model"]);
    expect(f.result.current.draft).toMatchObject({
      model: "mine",
      effort: "high",
      workspace: "/new",
    });
    act(() => f.result.current.resolve("model", useSaved));
    expect(f.result.current.conflicts).toEqual([]);
    expect(f.result.current.draft).toMatchObject(
      useSaved
        ? { model: "theirs", effort: "low" }
        : { model: "mine", effort: "high" },
    );
    expect(f.result.current.changed).toBe(!useSaved);
  },
);

it("treats model and thinking as one choice and accepts convergence", () => {
  const f = editor();
  act(() => f.result.current.setDraft({ ...DEFAULT_CONFIG, effort: "high" }));
  f.rerender({
    key: "a",
    saved: { ...DEFAULT_CONFIG, model: "no-thinking" },
    available: true,
  });
  expect(f.result.current.conflicts).toEqual(["model"]);
  expect(f.result.current.draft).toMatchObject({ model: "", effort: "high" });
  f.rerender({
    key: "a",
    saved: { ...DEFAULT_CONFIG, effort: "high" },
    available: true,
  });
  expect(f.result.current.conflicts).toEqual([]);
  expect(f.result.current.changed).toBe(false);
});

it("acknowledges partial saves independently while preserving edits made during Save", () => {
  const f = editor();
  const submitted = {
    ...DEFAULT_CONFIG,
    model: "opus",
    instructions: "Submitted",
  };
  act(() => f.result.current.submitted(submitted));
  act(() => f.result.current.setDraft({ ...submitted, instructions: "Newer" }));
  f.rerender({
    key: "a",
    saved: { ...DEFAULT_CONFIG, instructions: "Submitted" },
    available: true,
  });
  expect(f.result.current.draft).toEqual({
    ...submitted,
    instructions: "Newer",
  });
  expect(f.result.current.conflicts).toEqual([]);
  f.rerender({ key: "a", saved: submitted, available: true });
  expect(f.result.current.draft.instructions).toBe("Newer");
  expect(f.result.current.changed).toBe(true);
  expect(f.result.current.conflicts).toEqual([]);
  // A later external edit is not mistaken for an acknowledgement forever.
  f.rerender({
    key: "a",
    saved: { ...submitted, instructions: "Someone else" },
    available: true,
  });
  expect(f.result.current.conflicts).toEqual(["instructions"]);
  f.rerender({ key: "a", saved: submitted, available: true });
  expect(f.result.current.conflicts).toEqual(["instructions"]);
});

it("preserves an intentional revert during a pending save", () => {
  const f = editor();
  act(() =>
    f.result.current.submitted({
      ...DEFAULT_CONFIG,
      instructions: "Submitted",
    }),
  );
  act(() => f.result.current.setDraft(DEFAULT_CONFIG));
  f.rerender({
    key: "a",
    saved: { ...DEFAULT_CONFIG, instructions: "Submitted" },
    available: true,
  });
  expect(f.result.current.draft.instructions).toBe("");
  expect(f.result.current.changed).toBe(true);
  expect(f.result.current.conflicts).toEqual([]);
});

it("preserves an intentional revert across an unrelated edit", () => {
  const f = editor();
  const submitted = { ...DEFAULT_CONFIG, instructions: "Submitted" };
  act(() => f.result.current.submitted(submitted));
  act(() => f.result.current.setDraft(DEFAULT_CONFIG));
  act(() =>
    f.result.current.setDraft({ ...f.result.current.draft, model: "opus" }),
  );
  f.rerender({ key: "a", saved: submitted, available: true });
  expect(f.result.current.draft).toEqual({ ...DEFAULT_CONFIG, model: "opus" });
  expect(f.result.current.changed).toBe(true);
  expect(f.result.current.conflicts).toEqual([]);
});

it("preserves an intentional revert when a competing update arrives before acknowledgement", () => {
  const f = editor();
  const original = { ...DEFAULT_CONFIG, instructions: "Original" };
  f.rerender({ key: "a", saved: original, available: true });
  const submitted = { ...original, instructions: "Submitted" };
  act(() => f.result.current.submitted(submitted));
  act(() => f.result.current.setDraft(original));
  expect(f.result.current.changed).toBe(true);
  f.rerender({
    key: "a",
    saved: { ...original, instructions: "Other device" },
    available: true,
  });
  expect(f.result.current.draft.instructions).toBe("Original");
  expect(f.result.current.conflicts).toEqual(["instructions"]);
  expect(f.result.current.changed).toBe(true);
  f.rerender({ key: "a", saved: submitted, available: true });
  expect(f.result.current.draft.instructions).toBe("Original");
  expect(f.result.current.conflicts).toEqual(["instructions"]);
});

it("keeps the last usable draft through config loss and reconciles on recovery", () => {
  const f = editor();
  const saved = { ...DEFAULT_CONFIG, model: "opus" };
  f.rerender({ key: "a", saved, available: true });
  act(() => f.result.current.setDraft({ ...saved, instructions: "Draft" }));
  f.rerender({ key: "a", saved: DEFAULT_CONFIG, available: false });
  expect(f.result.current.draft).toEqual({ ...saved, instructions: "Draft" });
  expect(f.result.current.conflicts).toEqual([]);
  f.rerender({
    key: "a",
    saved: { ...saved, model: "sonnet" },
    available: true,
  });
  expect(f.result.current.draft).toEqual({
    ...saved,
    model: "sonnet",
    instructions: "Draft",
  });
});

it("isolates drafts and submission acknowledgements by agent and type", () => {
  const f = editor();
  act(() =>
    f.result.current.submitted({ ...DEFAULT_CONFIG, instructions: "A" }),
  );
  const saved = { ...DEFAULT_CONFIG, model: "other" };
  f.rerender({ key: "b", saved, available: true });
  expect(f.result.current.draft).toEqual(saved);
  expect(f.result.current.changed).toBe(false);
});

it.each([true, false])(
  "retires an old submission after explicit conflict resolution (saved=%s)",
  (useSaved) => {
    const f = editor();
    act(() =>
      f.result.current.submitted({ ...DEFAULT_CONFIG, model: "submitted" }),
    );
    f.rerender({
      key: "a",
      saved: { ...DEFAULT_CONFIG, model: "external" },
      available: true,
    });
    expect(f.result.current.conflicts).toEqual(["model"]);
    act(() => f.result.current.resolve("model", useSaved));
    if (!useSaved)
      act(() =>
        f.result.current.setDraft({
          ...f.result.current.draft,
          model: "newer-local",
        }),
      );
    f.rerender({
      key: "a",
      saved: { ...DEFAULT_CONFIG, model: "submitted" },
      available: true,
    });
    expect(f.result.current.draft.model).toBe(
      useSaved ? "submitted" : "newer-local",
    );
    expect(f.result.current.changed).toBe(!useSaved);
    expect(f.result.current.conflicts).toEqual(useSaved ? [] : ["model"]);
  },
);

it("preserves a revert through acknowledgement of the outstanding submission", () => {
  const f = editor();
  act(() =>
    f.result.current.submitted({
      ...DEFAULT_CONFIG,
      instructions: "Submitted",
    }),
  );
  act(() => f.result.current.setDraft(DEFAULT_CONFIG));
  f.rerender({
    key: "a",
    saved: { ...DEFAULT_CONFIG, instructions: "Submitted" },
    available: true,
  });
  expect(f.result.current.draft.instructions).toBe("");
  expect(f.result.current.changed).toBe(true);
});

it("keeps an outstanding receipt when a retry submits the unchanged saved value", () => {
  const f = editor();
  const submitted = { ...DEFAULT_CONFIG, instructions: "Submitted" };
  act(() => f.result.current.submitted(submitted));
  act(() => f.result.current.setDraft(DEFAULT_CONFIG));
  act(() => f.result.current.submitted(DEFAULT_CONFIG));
  expect(f.result.current.changed).toBe(true);
  // An unrelated group can also be saved without retiring this receipt.
  const draft = { ...DEFAULT_CONFIG, model: "opus" };
  act(() => f.result.current.submitted(draft));
  f.rerender({ key: "a", saved: submitted, available: true });
  expect(f.result.current.draft).toEqual(draft);
  expect(f.result.current.changed).toBe(true);
  expect(f.result.current.conflicts).toEqual([]);
});
