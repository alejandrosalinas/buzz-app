// @vitest-environment jsdom
import * as pierre from "@pierre/diffs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiffViewer } from "./DiffViewer";
import { parsePatch } from "./parse";

vi.mock("@pierre/diffs", async (importOriginal) => {
  const original = await importOriginal<typeof pierre>();
  return {
    ...original,
    preloadHighlighter: vi.fn(original.preloadHighlighter),
  };
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const header =
  "diff --git a/sample.kt b/sample.kt\n--- a/sample.kt\n+++ b/sample.kt\n";
it.each([
  ["modified", "@@ -5181 +5181 @@\n-val n = 1\n+val n = 2\n", 5181],
  ["added", "@@ -0,0 +2000,2 @@\n+val a = 1\n+val b = 2\n", 2001],
  ["deleted", "@@ -2000,2 +0,0 @@\n-val a = 1\n-val b = 2\n", 2001],
  [
    "widely separated",
    "@@ -1 +1 @@\n-val a = 1\n+val a = 2\n@@ -1000000000 +1000000000 @@\n-val b = 1\n+val b = 2\n",
    1000000000,
  ],
])(
  "renders %s lines using patch size rather than absolute offsets",
  async (_name, hunks, lastLine) => {
    const content = header + hunks;
    const files = parsePatch(content);
    expect(files).toHaveLength(1);
    const metadata = pierre.parsePatchFiles(content)[0]?.files[0];
    expect(metadata?.isPartial).toBe(true);
    expect(metadata?.additionLines.length).toBeLessThanOrEqual(2);
    expect(metadata?.deletionLines.length).toBeLessThanOrEqual(2);
    const { container } = render(
      <DiffViewer content={content} files={files} />,
    );
    await vi.waitFor(() => {
      const root = container.querySelector("diffs-container")?.shadowRoot;
      expect(root?.querySelector(`pre [data-line="${lastLine}"]`)).toBeTruthy();
      expect(
        root?.querySelectorAll("pre [data-line]").length,
      ).toBeLessThanOrEqual(4);
    });
    expect(screen.queryByRole("region", { name: "Raw diff" })).toBeNull();
    expect(pierre.preloadHighlighter).toHaveBeenCalled();
  },
);

const tokens = '[style*="--diffs-token"]';
const shadow = (container: HTMLElement) =>
  container.querySelector("diffs-container")?.shadowRoot;

it.each([
  ["line count", `@@ -1,501 +1,501 @@\n${" val n = 1\n".repeat(501)}`, 501],
  [
    "character count",
    `@@ -1,13 +1,13 @@\n${` ${"x".repeat(1000)}\n`.repeat(13)}`,
    13,
  ],
])(
  "renders patches over the %s budget as a diff without highlighting",
  async (_name, hunks, lines) => {
    const content = header + hunks;
    const files = parsePatch(content);
    expect(files).toHaveLength(1);
    const { container } = render(
      <DiffViewer content={content} files={files} />,
    );
    await vi.waitFor(() =>
      expect(
        shadow(container)?.querySelectorAll("pre [data-line]"),
      ).toHaveLength(lines),
    );
    expect(shadow(container)?.querySelector(tokens)).toBeNull();
    expect(screen.queryByRole("region", { name: "Raw diff" })).toBeNull();
    // No grammar loads for a file that will not be tokenized.
    expect(pierre.preloadHighlighter).toHaveBeenCalledWith(
      expect.objectContaining({ langs: ["text"] }),
    );
  },
);

it("leaves only a line over the length budget unhighlighted", async () => {
  const content = `${header}@@ -1,2 +1,2 @@\n val n = 1\n val ${"x".repeat(2001)} = 2\n`;
  const { container } = render(
    <DiffViewer content={content} files={parsePatch(content)} />,
  );
  // The short line's tokens show that highlighting ran for this file.
  await vi.waitFor(() =>
    expect(
      shadow(container)?.querySelector(`pre [data-line="1"] ${tokens}`),
    ).toBeTruthy(),
  );
  const long = shadow(container)?.querySelector('pre [data-line="2"]');
  expect(long?.textContent).toContain("x".repeat(2001));
  expect(long?.querySelector(tokens)).toBeNull();
  expect(screen.queryByRole("region", { name: "Raw diff" })).toBeNull();
});
