// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
afterEach(() => vi.unstubAllGlobals());
import { PullFiles } from "./PullFiles";

it("shows Kotlin syntax from a GitHub PR diff without losing its patch rows", async () => {
  const patch = `diff --git a/src/Main.kt b/src/Main.kt
--- a/src/Main.kt
+++ b/src/Main.kt
@@ -1 +1,2 @@
-val name = "old"
+val name = "new"
+fun greet() = name
`;
  const diff = vi.fn(async () => patch);
  const { container } = render(
    <PullFiles
      url="https://github.com/example-org/sample/pull/1"
      pull={{ repository: "example-org/sample", base: "a", head: "b" }}
      diff={diff}
    />,
  );
  expect(
    await screen.findByRole("region", { name: "src/Main.kt" }),
  ).toBeTruthy();
  expect(diff).toHaveBeenCalledWith(
    {
      repository: "example-org/sample",
      base: "a",
      head: "b",
      merged: undefined,
    },
    expect.any(AbortSignal),
  );
  await vi.waitFor(() =>
    expect(container.querySelector("diffs-container")).not.toBeNull(),
  );
  const rendered = container.querySelector("diffs-container")?.shadowRoot;
  expect(rendered?.textContent).toContain('val name = "old"');
  expect(rendered?.textContent).toContain("fun greet() = name");
  expect(rendered?.querySelectorAll("pre [data-line]").length).toBeGreaterThan(
    0,
  );
});
