// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { PanelMediaCard } from "./PanelMediaCard";
import type { PanelContext } from "../../features/panels/service";

let captured: PanelContext | undefined;
vi.mock("../../features/panels/PanelCard", () => ({
  PanelCard: ({ context }: { context: PanelContext }) => {
    captured = context;
    return <div>Files</div>;
  },
}));
vi.mock("../../features/messages/MediaReviewViewer", () => ({
  MediaReviewViewer: ({
    attachment,
    messageId,
    close,
  }: {
    attachment: { name: string };
    messageId: string;
    close(): void;
  }) => (
    <button type="button" onClick={close}>
      {messageId}: {attachment.name}
    </button>
  ),
}));
it("opens the shared viewer and retires captured actions when hidden or unmounted", () => {
  let active = true;
  const props = {
    session: {},
    scope: "scope",
    channelId: "channel",
    channelName: "Channel",
    panel: {},
    target: "channel",
    close: vi.fn(),
    context: { channelId: "channel", canOpen: () => false, open: () => false },
    isActive: () => true,
  } as unknown as ComponentProps<typeof PanelMediaCard>;
  const view = render(<PanelMediaCard {...props} />);
  const attachment = {
    url: "https://example.com/photo.png",
    kind: "image" as const,
    name: "photo.png",
  };
  const old = captured;
  if (!old) throw new Error("Panel context missing");
  act(() => {
    expect(old.openMedia?.("message", attachment)).toBe(true);
  });
  expect(screen.getByRole("button").textContent).toBe("message: photo.png");
  active = false;
  view.rerender(<PanelMediaCard {...props} isActive={() => active} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(old.openMedia?.("message", attachment)).toBe(false);
  active = true;
  view.rerender(<PanelMediaCard {...props} isActive={() => active} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(
    captured?.openMedia?.("message", { ...attachment, kind: "file" }),
  ).toBe(false);
  view.unmount();
  expect(old.openMedia?.("message", attachment)).toBe(false);
});
