// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryNotice } from "./DeliveryNotice";
import type { ChannelMessage } from "../relay/contracts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const row: ChannelMessage = {
  id: "message",
  channelId: "channel",
  authorId: "author",
  content: "Message",
  createdAt: 1,
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
};

it.each(["sending", "accepted", "unknown", "failed"] as const)(
  "keeps %s feedback visible without a retry handler",
  (delivery) => {
    render(<DeliveryNotice row={{ ...row, delivery }} />);
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  },
);

it.each(["sending", "accepted", "unknown", "failed"] as const)(
  "hides %s feedback only when its retry action is available",
  (delivery) => {
    render(<DeliveryNotice row={{ ...row, delivery }} retry={vi.fn()} />);
    const canRetry = delivery === "unknown" || delivery === "failed";
    expect(screen.getByRole("status").classList.contains("sr-only")).toBe(
      canRetry,
    );
    expect(!!screen.queryByRole("button", { name: "Retry" })).toBe(canRetry);
  },
);

it("offers Retry as soon as a pending send fails, and stays quiet while unconfirmed", () => {
  vi.useFakeTimers({ now: 100_050 });
  const pending = { ...row, createdAt: 100 };
  const retry = vi.fn();
  const view = render(
    <DeliveryNotice row={{ ...pending, delivery: "sending" }} retry={retry} />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  view.rerender(
    <DeliveryNotice row={{ ...pending, delivery: "failed" }} retry={retry} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Couldn’t send this message.",
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  view.rerender(
    <DeliveryNotice row={{ ...pending, delivery: "unknown" }} retry={retry} />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
