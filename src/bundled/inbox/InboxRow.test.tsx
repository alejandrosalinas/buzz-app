// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import * as content from "../../features/notifications/content";
import type { InboxItem } from "../../features/relay/inbox";
import type { InboxFeedSnapshot } from "../../features/relay/inbox-feed";
import type { RelaySession } from "../../features/relay/session";
import { InboxRowButton } from "./InboxRow";

vi.mock("../../features/notifications/content", async (load) => {
  const actual =
    await load<typeof import("../../features/notifications/content")>();
  return { ...actual, messagePreview: vi.fn(actual.messagePreview) };
});

it("parses a row preview's Markdown once across renders", () => {
  const item = {
    id: "row",
    authorId: "a".repeat(64),
    createdAt: 1,
    messageIds: [],
    preview: "**cached** preview",
    previewMentions: { content: "**cached** preview", mentions: [] },
    unreadCount: 0,
    manual: false,
  } as unknown as InboxItem;
  const row = (time: string) => (
    <InboxRowButton
      item={item}
      identity={{ sender: "Sender", context: "Channel", profile: undefined }}
      session={{} as unknown as RelaySession}
      feed={{ incomplete: [] } as unknown as InboxFeedSnapshot}
      time={time}
    />
  );
  const view = render(row("now"));
  view.rerender(row("later"));
  view.unmount();
  const again = render(row("now"));
  expect(again.getByText("cached preview")).toBeInTheDocument();
  expect(content.messagePreview).toHaveBeenCalledOnce();
});

it("shows a preview's resolved mentions as chips", () => {
  const tomb = "c".repeat(64);
  const profiles = new Map([[tomb, { name: "tomb" }]]);
  const item = {
    id: "row",
    channelId: "room",
    authorId: "a".repeat(64),
    createdAt: 1,
    messageIds: [],
    preview: "ugh @tomb now getting",
    previewMentions: { content: "ugh @tomb now getting", mentions: [tomb] },
    unreadCount: 0,
    manual: false,
  } as unknown as InboxItem;
  const view = render(
    <InboxRowButton
      item={item}
      identity={{ sender: "Sender", context: "Channel", profile: undefined }}
      session={
        {
          profiles: { subscribe: () => () => {}, snapshot: () => profiles },
          channels: {
            list: () => ({ channels: [] }),
            subscribeList: () => () => {},
          },
        } as unknown as RelaySession
      }
      feed={{ incomplete: [] } as unknown as InboxFeedSnapshot}
      time="now"
      previewId="preview"
    />,
  );
  const preview = view.container.querySelector("#preview");
  expect(preview?.querySelector("[data-mention-kind]")).toHaveTextContent(
    "tomb",
  );
  expect(preview).toHaveTextContent("ugh tomb now getting");
  // Names built from the preview still say someone was mentioned.
  expect(view.getByRole("img", { name: "@" })).toBeInTheDocument();
});
