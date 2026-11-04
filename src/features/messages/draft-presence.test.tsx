// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import { clearView, writeView } from "../../shared/view-state";
import { attachmentDraft } from "./attachment-draft";
import { followupDraft, mentionDraft } from "./mention-draft";
import { typedDraft } from "./composer-testing";
import { listComposerDrafts, useDraftCount } from "./draft-presence";
import { DraftIndicator } from "./DraftIndicator";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function fixture(scope = "relay:alice") {
  let channels: ChannelSummary[] = [];
  const listeners = new Set<() => void>();
  const session = {
    scope,
    channels: {
      list: () => ({ channels }),
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as unknown as RelaySession;
  return {
    session,
    roster(next: ChannelSummary[]) {
      channels = next;
      for (const listener of listeners) listener();
    },
  };
}

it("counts meaningful channel and thread drafts, excludes automatic prefills and other scopes, and observes removals", () => {
  const { session } = fixture();
  const root = "a".repeat(64);
  writeView(session.scope, "draft:room", typedDraft(mentionDraft("message")));
  writeView(
    session.scope,
    `draft:room:thread:${root}`,
    typedDraft(mentionDraft("reply")),
  );
  writeView(session.scope, "draft:empty", "  ");
  writeView(
    session.scope,
    "draft:seed",
    followupDraft([{ pubkey: "b".repeat(64), name: "Honey" }]),
  );
  writeView("relay:bob", "draft:private", "private");
  const { result } = renderHook(() => [
    useDraftCount(session),
    useDraftCount(session, "room"),
  ]);
  expect(result.current).toEqual([2, 2]);
  act(() => clearView(session.scope, `draft:room:thread:${root}`));
  expect(result.current).toEqual([1, 1]);
  act(() => writeView(session.scope, "draft:room", ""));
  expect(result.current).toEqual([0, 0]);
});

it("changes row presence only when its count changes, without scanning storage for ordinary draft edits", () => {
  const { session } = fixture();
  const renders = vi.fn();
  renderHook(() => {
    const count = useDraftCount(session, "room");
    renders(count);
  });
  act(() => writeView(session.scope, "draft:room", "first"));
  expect(renders).toHaveBeenLastCalledWith(1);
  renders.mockClear();
  const enumerate = vi.spyOn(Storage.prototype, "key");
  act(() => writeView(session.scope, "draft:room", "more text"));
  act(() => writeView(session.scope, "scroll:elsewhere", { offset: 1 }));
  act(() => writeView(session.scope, "draft:elsewhere", "other draft"));
  expect(enumerate).not.toHaveBeenCalled();
  expect(renders).not.toHaveBeenCalled();
});

it("lists and marks file-only drafts without a saved text key, and removes their marker when files clear", () => {
  const { session } = fixture();
  const files = attachmentDraft(session, `${session.scope}:draft:room`, "room");
  render(<DraftIndicator session={session} channelId="room" />);
  expect(screen.queryByRole("img")).toBeNull();
  act(() => {
    files.adopt([
      { id: "file", file: new File(["notes"], "notes.txt"), status: "queued" },
    ]);
  });
  expect(screen.getByRole("img", { name: "1 draft" })).toBeVisible();
  expect(listComposerDrafts(session).entries).toEqual([
    { key: "draft:room", value: "" },
  ]);
  act(() => files.clear());
  expect(screen.queryByRole("img")).toBeNull();
  expect(listComposerDrafts(session).entries).toHaveLength(0);
});

it("responds to scoped cross-window writes and resubscribes after an unmounted interval", () => {
  const { session } = fixture();
  const mounted = renderHook(() => useDraftCount(session));
  const key = `buzz-view.v1:${JSON.stringify([session.scope, "draft:room"])}`;
  act(() => {
    localStorage.setItem(key, JSON.stringify("other window"));
    window.dispatchEvent(
      new StorageEvent("storage", { storageArea: localStorage, key }),
    );
  });
  expect(mounted.result.current).toBe(1);
  mounted.unmount();
  writeView(session.scope, "draft:room", "");
  const next = renderHook(() => useDraftCount(session));
  expect(next.result.current).toBe(0);
});

it("counts destinations beyond the preview cap and follows Huddle metadata without changing stored content", () => {
  const { session, roster } = fixture();
  // The scale is the explicit 500-preview boundary, not a generic large fixture.
  for (let i = 0; i < 501; i++)
    writeView(session.scope, `draft:room-${i}`, "draft");
  const { result } = renderHook(() => [
    useDraftCount(session),
    useDraftCount(session, "room-500"),
  ]);
  expect(listComposerDrafts(session)).toMatchObject({ limited: true });
  expect(listComposerDrafts(session).entries).toHaveLength(500);
  expect(result.current).toEqual([501, 1]);
  act(() => roster([{ id: "room-500", huddle: true } as ChannelSummary]));
  expect(result.current).toEqual([500, 0]);
  act(() => roster([]));
  expect(result.current).toEqual([501, 1]);
});
