import type { ReadTarget } from "./read-state-model";

/** A conversation projected from the unread owner's bounded verified evidence. */
export type InboxItem = Readonly<{
  id: string;
  channelId: string;
  target: ReadTarget;
  /** Oldest observed unread message, otherwise newest relevant message. */
  messageId: string;
  latestMessageId: string;
  /** Exact verified group members, for pending preview evidence across regrouping. */
  messageIds: readonly string[];
  rootId?: string;
  /** A DM row whose every unread message, or with none the representative,
   * is a reply in `rootId`'s thread, so that thread alone shows them. */
  threadOnly?: true;
  authorId: string;
  workflowOwnerId?: string | undefined;
  preview: string;
  /** The message the preview shows, which may be outside `messageIds`. */
  previewMessageId?: string;
  createdAt: number;
  mentioned: boolean;
  /** Verified group members with time and viewer-mention classification. */
  messages: readonly Readonly<{
    id: string;
    createdAt: number;
    mentioned: boolean;
  }>[];
  /** The same conversation projected from explicit mention evidence only. */
  mention?: InboxItem | undefined;
  thread: boolean;
  unreadCount: number;
  manual: boolean;
  /** A session's top-level timeline row: its explicit read is one
   * `markTimelineRead` over `messageIds`, and `readThrough` is empty. */
  timeline?: true;
  /** Explicit prefixes; a thread prefix never acknowledges its top-level root. */
  readThrough: readonly Readonly<{ target: ReadTarget; messageId: string }>[];
}>;
export type InboxSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  items: readonly InboxItem[];
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
