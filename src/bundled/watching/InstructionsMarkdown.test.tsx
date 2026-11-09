// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { InstructionsMarkdown, OpenLink } from "./InstructionsMarkdown";
afterEach(cleanup);
it("renders Markdown structure and reference links without executing HTML or unsafe URLs", () => {
  const { container } = render(
    <InstructionsMarkdown
      text={
        "# Instructions\n\n**Report** blockers and use `check`.\n\n- Read [the PR][pr]\n\n[pr]: https://github.com/example/project/pull/1\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n![Diagram](https://example.com/private.png)"
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "Instructions" })).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("Report");
  expect(container.querySelector("code")?.textContent).toBe("check");
  expect(
    screen.getByRole("link", { name: "the PR" }).getAttribute("href"),
  ).toBe("https://github.com/example/project/pull/1");
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("Diagram")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
});
it("shows a linked person by name and opens their profile where the tab can", () => {
  const target =
    "nostr:npub1vujjkzwrr2v4m2nr4tdzv45lh34r6yh4wvgn7qquuapjlpcd4qsqkjn5uw";
  const text = `Ask [John](${target}) first.`;
  const opened: string[] = [];
  render(
    <OpenLink.Provider
      value={{ open: (link) => opened.push(link) > 0, canOpen: () => true }}
    >
      <InstructionsMarkdown text={text} />
    </OpenLink.Provider>,
  );
  screen.getByRole("button", { name: "John" }).click();
  expect(opened).toEqual([target]);
  cleanup();
  const { container } = render(<InstructionsMarkdown text={text} />);
  expect(container.textContent).toBe("Ask John first.");
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
it("shows a person as text where the host can't open them", () => {
  const target =
    "nostr:npub1vujjkzwrr2v4m2nr4tdzv45lh34r6yh4wvgn7qquuapjlpcd4qsqkjn5uw";
  const { container } = render(
    <OpenLink.Provider value={{ open: () => true, canOpen: () => false }}>
      <InstructionsMarkdown text={`Ask [John](${target}) first.`} />
    </OpenLink.Provider>,
  );
  expect(container.textContent).toBe("Ask John first.");
  expect(screen.queryByRole("button")).toBeNull();
});
