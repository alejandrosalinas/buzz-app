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

const tokens = '[style*="--diffs-token"]';
const hunk = "@@ -1 +1 @@\n-const n = 1;\n+const n = 2;\n";
const patch = (name: string) =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${hunk}`;
const shadow = (container: HTMLElement) =>
  container.querySelector("diffs-container")?.shadowRoot;
function view(content: string) {
  return render(<DiffViewer content={content} files={parsePatch(content)} />);
}

it.each([
  ["bare", "--- a/src/a.ts\n+++ b/src/a.ts\n"],
  [
    "tab-timestamped",
    "--- src/a.ts\t2024-01-01 00:00:00.000000000 +0000\n+++ src/a.ts\t2024-01-02 00:00:00.000000000 +0000\n",
  ],
  [
    "space-timestamped",
    "--- src/a.ts 2024-01-01 00:00:00.000000000 +0000\n+++ src/a.ts 2024-01-02 00:00:00.000000000 +0000\n",
  ],
])(
  "renders a %s patch without a Git header as a highlighted diff",
  async (_name, headers) => {
    const { container } = view(headers + hunk);
    await vi.waitFor(() =>
      expect(
        shadow(container)?.querySelector(`pre [data-line="1"] ${tokens}`),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("region", { name: "src/a.ts" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Raw diff" })).toBeNull();
  },
);

it.each([
  ["App.tsx", "tsx"],
  ["run.sh", "zsh"],
  ["index.html", "html"],
  ["Cargo.toml", "toml"],
])("loads the grammar that renders %s", async (name, language) => {
  const { container } = view(patch(name));
  await vi.waitFor(() =>
    expect(shadow(container)?.querySelector("pre [data-line]")).toBeTruthy(),
  );
  expect(pierre.preloadHighlighter).toHaveBeenCalledWith(
    expect.objectContaining({ langs: [language] }),
  );
});

it.each(["main.lisp", "nginx.conf", "notes"])(
  "renders %s, which has no bundled grammar, as a plain diff",
  async (name) => {
    const { container } = view(patch(name));
    await vi.waitFor(() =>
      expect(
        shadow(container)?.querySelectorAll("pre [data-line]"),
      ).toHaveLength(2),
    );
    expect(shadow(container)?.querySelector(tokens)).toBeNull();
    expect(screen.queryByRole("region", { name: "Raw diff" })).toBeNull();
    expect(pierre.preloadHighlighter).toHaveBeenCalledWith(
      expect.objectContaining({ langs: ["text"] }),
    );
  },
);

it("shows no raw text first once the grammar is loaded", async () => {
  const first = view(patch("a.go"));
  await vi.waitFor(() =>
    expect(shadow(first.container)?.querySelector(tokens)).toBeTruthy(),
  );
  first.unmount();
  const { container } = view(patch("b.go"));
  // Synchronously after mount: no effect or preload has settled yet.
  expect(screen.queryByRole("region", { name: "Raw diff" })).toBeNull();
  expect(container.querySelector("diffs-container")).toBeTruthy();
});
