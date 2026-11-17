// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { PartMarkdown } from "./PartMarkdown";

afterEach(cleanup);

it("keeps footnote link attributes and moves within the file", () => {
  const onAnchor = vi.fn();
  const { container } = render(
    <PartMarkdown
      content={"A claim.[^1]\n\n[^1]: The source."}
      transforms={[]}
      rehype={[]}
      openLink={() => false}
      session={undefined}
      media={undefined}
      onAnchor={onAnchor}
    />,
    { wrapper: ToastProvider },
  );
  const reference = container.querySelector("a[data-footnote-ref]");
  expect(reference).toHaveAttribute("id", "user-content-fnref-1");
  expect(reference).toHaveAttribute("aria-describedby", "footnote-label");
  const back = container.querySelector("a[data-footnote-backref]");
  expect(back).toHaveAttribute("aria-label");
  expect(container.querySelector("[node]")).toBeNull();
  if (!back) throw new Error("no back reference");
  fireEvent.click(back);
  expect(onAnchor).toHaveBeenCalledWith("user-content-fnref-1");
});
