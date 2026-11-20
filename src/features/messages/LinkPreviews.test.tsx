// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type {
  ContributionReader,
  LinkPreviewProps,
  LinkPreviewRenderer,
} from "../conversation/contracts";
import { TargetOpenerProvider } from "../conversation/opener";
import { LinkPreviews } from "./LinkPreviews";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function entry(
  id: string,
  matches: (url: string) => boolean,
  order: number,
  component: LinkPreviewRenderer["component"],
): Contribution<LinkPreviewRenderer> {
  return {
    id,
    title: id,
    matches,
    order,
    component,
    key: id,
    pluginId: id,
    revision: "1",
  } as unknown as Contribution<LinkPreviewRenderer>;
}
const reader = (
  entries: Contribution<LinkPreviewRenderer>[],
): ContributionReader<LinkPreviewRenderer> => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});
const card =
  (label: string) =>
  ({ url, open }: LinkPreviewProps) => (
    <button type="button" onClick={open}>
      {label} {url}
    </button>
  );

it("lets the lowest order claim a link ahead of the default card", () => {
  const registry = reader([
    entry("web", () => true, 100, card("web")),
    entry("special", (url) => url.includes("special"), 0, card("special")),
  ]);
  render(
    <LinkPreviews
      urls={["https://a.example/", "https://special.example/"]}
      messageId="m"
      registry={registry}
      onOpenLink={() => true}
    />,
  );
  expect(screen.getByText("web https://a.example/")).toBeTruthy();
  expect(screen.getByText("special https://special.example/")).toBeTruthy();
  expect(screen.queryByText("web https://special.example/")).toBeNull();
});

it("folds past three cards and opens links through the host", () => {
  const onOpenLink = vi.fn(() => true);
  const urls = [1, 2, 3, 4, 5].map((n) => `https://${n}.example/`);
  render(
    <LinkPreviews
      urls={urls}
      messageId="m"
      registry={reader([entry("web", () => true, 100, card("web"))])}
      onOpenLink={onOpenLink}
    />,
  );
  expect(screen.getAllByRole("button", { name: /^web/ })).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Show 2 more previews" }));
  expect(screen.getAllByRole("button", { name: /^web/ })).toHaveLength(5);
  fireEvent.click(
    screen.getByRole("button", { name: "web https://5.example/" }),
  );
  expect(onOpenLink).toHaveBeenCalledWith("https://5.example/");
  fireEvent.click(screen.getByRole("button", { name: "Show fewer previews" }));
  expect(screen.getAllByRole("button", { name: /^web/ })).toHaveLength(3);
});

it("lets a card open its plugin's own target while its link opens as before", () => {
  const onOpenLink = vi.fn(() => true);
  const openTarget = vi.fn(() => true);
  const Card = ({ url, open, opener }: LinkPreviewProps) => (
    <>
      <button type="button" onClick={() => open()}>
        Link {url}
      </button>
      <button
        type="button"
        disabled={!opener?.canOpen("example-panel:item/7")}
        onClick={() => opener?.open("example-panel:item/7")}
      >
        Open panel
      </button>
    </>
  );
  render(
    <TargetOpenerProvider
      canOpen={(target) => target.startsWith("example-panel:")}
      open={openTarget}
    >
      <LinkPreviews
        urls={["https://item.example/7"]}
        messageId="m"
        registry={reader([entry("item", () => true, 0, Card)])}
        onOpenLink={onOpenLink}
      />
    </TargetOpenerProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open panel" }));
  expect(openTarget).toHaveBeenCalledWith("example-panel:item/7");
  expect(onOpenLink).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Link https://item.example/7" }),
  );
  expect(onOpenLink).toHaveBeenCalledWith("https://item.example/7");
  expect(openTarget).toHaveBeenCalledTimes(1);
});

it("closes a card's opener once its contribution is removed or outside a conversation", () => {
  const results: boolean[] = [];
  const Card = ({ opener }: LinkPreviewProps) => (
    <button
      type="button"
      onClick={() =>
        results.push(opener?.open("example-panel:item/7") ?? false)
      }
    >
      Open panel
    </button>
  );
  const openTarget = vi.fn(() => true);
  const live = [entry("item", () => true, 0, Card)];
  const { unmount } = render(
    <TargetOpenerProvider canOpen={() => true} open={openTarget}>
      <LinkPreviews
        urls={["https://item.example/7"]}
        messageId="m"
        registry={reader(live)}
        onOpenLink={() => true}
      />
    </TargetOpenerProvider>,
  );
  const button = screen.getByRole("button", { name: "Open panel" });
  fireEvent.click(button);
  live.length = 0;
  fireEvent.click(button);
  expect(results).toEqual([true, false]);
  expect(openTarget).toHaveBeenCalledTimes(1);
  unmount();

  render(
    <LinkPreviews
      urls={["https://item.example/7"]}
      messageId="m"
      registry={reader([entry("item", () => true, 0, Card)])}
      onOpenLink={() => true}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open panel" }));
  expect(results).toEqual([true, false, false]);
});

it("drops a card whose renderer throws and keeps the rest", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const Broken = () => {
    throw new Error("broken");
  };
  render(
    <LinkPreviews
      urls={["https://broken.example/", "https://ok.example/"]}
      messageId="m"
      registry={reader([
        entry("broken", (url) => url.includes("broken"), 0, Broken),
        entry("web", () => true, 100, card("web")),
      ])}
      onOpenLink={() => true}
    />,
  );
  expect(screen.getByText("web https://ok.example/")).toBeTruthy();
});
