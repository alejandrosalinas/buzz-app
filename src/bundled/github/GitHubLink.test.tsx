// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LinkLabelContext } from "../../features/conversation/LinkLabelContext";
import { GitHubLink } from "./GitHubLink";
import type { PullStates } from "./pull-states";

afterEach(cleanup);

const states = () =>
  ({ get: vi.fn(), watch: vi.fn(() => () => {}) }) as unknown as PullStates &
    Record<"get" | "watch", ReturnType<typeof vi.fn>>;

it("names a pasted repository link by owner and name, reading nothing", () => {
  const held = states();
  const { container } = render(
    <GitHubLink url="https://github.com/bytedance/deer-flow" states={held} />,
  );
  expect(container).toHaveTextContent(/^bytedance\/deer-flow$/);
  expect(container.querySelector("[data-link-kind]")).toHaveAttribute(
    "data-link-kind",
    "github",
  );
  expect(held.watch).not.toHaveBeenCalled();
});

it("names a pasted commit link by repository and short SHA, reading nothing", () => {
  const held = states();
  const { container } = render(
    <GitHubLink
      url="https://github.com/block/buzz-app/commit/48bea39c89249917574dad33663a1039dc7f5c"
      states={held}
    />,
  );
  expect(container).toHaveTextContent(/^buzz-app@48bea39$/);
  expect(container.querySelector("svg")).toBeInTheDocument();
  expect(held.watch).not.toHaveBeenCalled();
});

it("keeps an authored label on repository and commit links", () => {
  for (const url of [
    "https://github.com/bytedance/deer-flow",
    "https://github.com/block/buzz-app/commit/48bea39",
  ]) {
    const { container, unmount } = render(
      <LinkLabelContext value="the fix">
        <GitHubLink url={url} states={states()} />
      </LinkLabelContext>,
    );
    expect(container).toHaveTextContent(/^the fix$/);
    unmount();
  }
});
