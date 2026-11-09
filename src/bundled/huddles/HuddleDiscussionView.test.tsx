// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi, assert } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => {}),
}));
import { HuddleDiscussionView } from "./HuddleDiscussionView";
import type { HuddleDiscussion } from "../../features/huddle/discussion";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function discussion(delivery: "failed" | "unknown"): HuddleDiscussion {
  return {
    version: 0,
    historyLimited: false,
    status: "ready",
    writable: true,
    sending: false,
    sent: 0,
    hasMore: false,
    rows: [
      {
        id: "message",
        authorId: "ab".repeat(32),
        channelId: "room",
        attachments: [],
        author: "Alex",
        picture: null,
        text: "Hello",
        time: 1,
        delivery,
      },
    ],
  };
}

it.each(["buzz-media://localhost/authorized-avatar", null])(
  "renders a profile avatar only through its resolved media source (%s)",
  (source) => {
    const value = discussion("failed");
    const row = value.rows[0];
    assert.exists(row);
    row.pictureUrl = "https://example.test/avatar.png";
    row.picture = source;
    const { container } = render(
      <HuddleDiscussionView
        discussion={value}
        composer={null}
        older={() => {}}
        retry={() => {}}
        recover={() => {}}
      />,
    );
    expect(container.querySelector("img")?.getAttribute("src") ?? null).toBe(
      source,
    );
  },
);

it.each(["failed", "unknown"] as const)(
  "keeps focus when recovering a %s message succeeds or fails",
  (delivery) => {
    let value = discussion(delivery);
    const recover = vi.fn((_id: string, dismiss?: boolean) => {
      value = {
        ...value,
        rows: dismiss
          ? []
          : value.rows.map((row) => ({ ...row, delivery: "sending" })),
      };
      rerender(view());
    });
    const view = () => (
      <HuddleDiscussionView
        discussion={value}
        composer={<textarea aria-label="Message this Huddle" />}
        older={() => {}}
        retry={() => {}}
        recover={recover}
      />
    );
    const { rerender } = render(view());
    if (delivery === "unknown")
      expect(screen.getByRole("status").textContent).toContain(
        "Retry sends the same message",
      );
    const editor = screen.getByRole("textbox");
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(recover).toHaveBeenCalledWith("message");
    expect(document.activeElement).toBe(editor);
    // The same row returning to failed must not steal the restored focus.
    value = discussion(delivery);
    rerender(view());
    expect(document.activeElement).toBe(editor);
    const discard = screen.getByRole("button", { name: "Discard" });
    discard.focus();
    fireEvent.click(discard);
    expect(recover).toHaveBeenLastCalledWith("message", true);
    expect(document.activeElement).toBe(editor);
    expect(screen.queryByText("Hello")).toBeNull();
  },
);

it("hands focus to the message log when discarding in a read-only room", () => {
  let value = { ...discussion("unknown"), writable: false };
  const view = () => (
    <HuddleDiscussionView
      discussion={value}
      composer={null}
      older={() => {}}
      retry={() => {}}
      recover={() => {
        value = { ...value, rows: [] };
        rerender(view());
      }}
    />
  );
  const { rerender } = render(view());
  const discard = screen.getByRole("button", { name: "Discard" });
  discard.focus();
  fireEvent.click(discard);
  expect(document.activeElement).toBe(screen.getByRole("log"));
});

it("keeps a surviving focus target across load retry success and failure", () => {
  let value: HuddleDiscussion = {
    ...discussion("failed"),
    writable: false,
    error: "Couldn’t load",
    status: "error" as HuddleDiscussion["status"],
    rows: [],
  };
  const view = () => (
    <HuddleDiscussionView
      discussion={value}
      composer={<textarea aria-label="Message this Huddle" />}
      older={() => {}}
      recover={() => {}}
      retry={() => {
        value = { ...value, error: undefined, status: "loading" };
        rerender(view());
      }}
    />
  );
  const { rerender } = render(view());
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  const log = screen.getByRole("log");
  expect(document.activeElement).toBe(log);
  value = { ...value, error: "Still unavailable", status: "error" };
  rerender(view());
  expect(document.activeElement).toBe(log);
  value = { ...value, error: undefined, status: "ready", writable: true };
  rerender(view());
  expect(document.activeElement).toBe(log);
});

it("renders Markdown and downloads the resolved attachment, without falling back when media is unavailable", () => {
  const value = discussion("failed");
  const url = `https://relay.example/media/${"a".repeat(64)}`;
  const source = `http://buzz-media.localhost/${encodeURIComponent(url)}`;
  const row = value.rows[0];
  assert(row);
  value.rows[0] = {
    ...row,
    delivery: "seen",
    text: "**Notes**",
    attachments: [
      {
        url,
        source,
        previewSource: null,
        kind: "file",
        name: "notes.txt",
        mime: "text/plain",
        size: 23,
      },
    ],
  };
  const view = () => (
    <HuddleDiscussionView
      discussion={value}
      composer={null}
      older={() => {}}
      retry={() => {}}
      recover={() => {}}
    />
  );
  const { rerender } = render(view());
  expect(screen.getByText("Notes").tagName).toBe("STRONG");
  fireEvent.click(screen.getByRole("button", { name: "Download notes.txt" }));
  expect(invoke).toHaveBeenCalledWith("media_download", {
    source,
    name: "notes.txt",
  });
  const attachment = value.rows[0].attachments[0];
  assert(attachment);
  attachment.source = null;
  rerender(view());
  expect(
    screen.queryByRole("button", { name: "Download notes.txt" }),
  ).toBeNull();
  expect(screen.getByText("File unavailable")).toBeTruthy();
});

it("routes internal links and signed mentions while leaving unbound or edited names as prose", () => {
  const value = discussion("failed");
  const key = "cd".repeat(32);
  assert(value.rows[0]);
  value.rows[0] = {
    ...value.rows[0],
    text: "@Taylor and @Unbound [Channel](buzz://channel/test)",
    mentions: [key],
    mentionNames: { [key]: "Taylor" },
  };
  const openLink = vi.fn(() => true);
  const view = () => (
    <HuddleDiscussionView
      discussion={value}
      composer={null}
      older={() => {}}
      retry={() => {}}
      recover={() => {}}
      openLink={openLink}
    />
  );
  const mounted = render(view());
  fireEvent.click(screen.getByRole("link", { name: "Channel" }));
  expect(openLink).toHaveBeenCalledWith("buzz://channel/test");
  // A chip splits its first character from the rest of the name.
  const chip = () =>
    [...document.querySelectorAll("[data-mention-kind]")].find(
      (element) => element.textContent === "Taylor",
    );
  expect(chip()?.getAttribute("data-mention-kind")).toBe("person");
  value.rows[0] = { ...value.rows[0], edited: true };
  mounted.rerender(view());
  expect(chip()).toBeUndefined();
  expect(screen.getByText(/@Taylor/)).toBeTruthy();
});
