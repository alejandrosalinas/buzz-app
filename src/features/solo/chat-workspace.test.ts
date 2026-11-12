import { expect, it } from "vitest";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";
import { newChat } from "./chat-workspace";

const window = (extra: Partial<ChannelWindow> = {}): ChannelWindow => ({
  channelId: "chat",
  status: "ready",
  rows: [],
  hasMore: false,
  loadingOlder: false,
  error: undefined,
  freshness: "verified",
  ...extra,
});
const row = (extra: Partial<ChannelMessage> = {}) =>
  ({ id: "m", ...extra }) as ChannelMessage;

it("calls a chat new only while its verified, complete history has no message", () => {
  expect(newChat(window())).toBe(true);
  // The agent joining a new task chat is not a message.
  expect(newChat(window({ rows: [row({ membership: {} as never })] }))).toBe(
    true,
  );
  expect(newChat(window({ rows: [row()] }))).toBe(false);
});

it("never calls a chat new before its history is known", () => {
  expect(newChat(undefined)).toBe(false);
  for (const extra of [
    { status: "loading" },
    { status: "idle" },
    { status: "error" },
    { freshness: "cached" },
    { freshness: undefined },
    { refreshing: true },
    { loadingOlder: true },
    { hasMore: true },
    { historyLimited: true },
    { hasNewer: true },
  ] as const)
    expect(newChat(window(extra as Partial<ChannelWindow>))).toBe(false);
});
