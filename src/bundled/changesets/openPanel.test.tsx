// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { isTauri } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import type {
  Panel,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelTabState } from "../channels/useChannelTabState";
import { useConversationTabs } from "../channels/useConversationTabs";
import { apply } from "./index";
import { targetFor } from "./target";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

function registeredPanel() {
  const register = vi.fn();
  apply({
    host: { spawn: vi.fn() },
    effect: vi.fn(),
    relay: { snapshot: vi.fn(), subscribe: vi.fn() },
    conversation: { registerAccessory: vi.fn() },
    panels: { register },
  } as unknown as Parameters<typeof apply>[0]);
  return {
    key: "buzz.changesets/changes",
    ...register.mock.calls[0]?.[0],
  } as Panel & RegisteredPanel;
}

it("shows one Changes tab that follows the file or turn last opened", () => {
  expect(isTauri()).toBe(true);
  const channels = [{ id: "alpha", name: "Alpha" }];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }) },
  } as unknown as RelaySession;
  const panel = registeredPanel();
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => panel,
  } as unknown as Panels;
  const snapshot = { status: "ready", session };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const h = renderHook(() =>
    useConversationTabs({
      profiles: new Map(),
      state: useChannelTabState(session, "alpha"),
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
    } as unknown as Parameters<typeof useConversationTabs>[0]),
  );
  const targets = () =>
    h.result.current.items.map(
      (item) => (item.content as { props: { target: string } }).props.target,
    );
  const open = (target: string) =>
    act(() => h.result.current.open({ channelId: "alpha", panel, target }));

  open(targetFor("t1", 0, "a.txt"));
  open(targetFor("t1", 0, "b.txt"));
  expect(targets()).toEqual([targetFor("t1", 0, "b.txt")]);
  open(targetFor("t2", 0, "c.txt"));
  expect(targets()).toEqual([targetFor("t2", 0, "c.txt")]);
  open(targetFor("t2", 0, "c.txt"));
  expect(targets()).toEqual([targetFor("t2", 0, "c.txt")]);
});
