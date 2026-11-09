// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clearView, writeView } from "../../shared/view-state";
import { useThreadDraft } from "./draft-places";

const root = "a".repeat(64);
const key = `draft:room:thread:${root}`;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("rescans saved drafts only when a write can change where drafts wait", () => {
  const session = { scope: "relay:alice" };
  const { result } = renderHook(() => useThreadDraft(session, "room", root));
  expect(result.current).toBe(false);
  const scans = vi.spyOn(Storage.prototype, "key");

  act(() => void writeView(session.scope, "scroll:room", { bottom: true }));
  expect(scans).not.toHaveBeenCalled();

  act(() => void writeView(session.scope, key, { text: "h" }));
  expect(result.current).toBe(true);
  scans.mockClear();

  act(() => void writeView(session.scope, key, { text: "hi" }));
  expect(scans).not.toHaveBeenCalled();
  expect(result.current).toBe(true);

  act(() => void writeView(session.scope, key, { text: " " }));
  expect(result.current).toBe(false);

  act(() => void writeView(session.scope, key, { text: "back" }));
  expect(result.current).toBe(true);
  act(() => clearView(session.scope, key));
  expect(result.current).toBe(false);
});

it("marks a draft another window saved, from its storage event's key", () => {
  const session = { scope: "relay:alice" };
  const { result } = renderHook(() => useThreadDraft(session, "room", root));
  const stored = `buzz-view.v1:${JSON.stringify([session.scope, key])}`;
  localStorage.setItem(stored, JSON.stringify({ text: "from elsewhere" }));
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: stored, storageArea: localStorage }),
    );
  });
  expect(result.current).toBe(true);
});
