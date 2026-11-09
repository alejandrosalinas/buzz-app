// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import type { LiveCallbacks } from "../../features/relay/live";
import {
  ActivityNavigationIcon,
  ActivityReactionScope,
} from "./ActivityNavigation";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const viewer = keypair(),
    alice = keypair(),
    relay = keypair();
  const target = message(viewer, "room", "Mine", 10);
  const events: RelayEvent[] = [target];
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    query: async (filters) =>
      filters.flatMap((filter) =>
        events.filter((event) => matchesEvent(event, filter)),
      ),
    media: (url) => url,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  disposals.push(owner.dispose);
  const channelEvents = [
    roster(relay, "room", [viewer.pubkey, alice.pubkey], 1),
    metadata(relay, "room", "Room", 1),
  ];
  events.push(...channelEvents);
  live.receive(channelEvents);
  render(
    <ActivityReactionScope session={owner.session} enabled>
      <button type="button" title="Activity">
        <ActivityNavigationIcon>
          <span>bell</span>
        </ActivityNavigationIcon>
        Activity
      </button>
    </ActivityReactionScope>,
  );
  await act(async () => {
    await owner.session.inboxFeed.reactions.ensure();
  });
  let time = 20;
  return {
    async emit(
      content: string,
      tags: string[][] = [],
      phase: "live" | "replay" = "live",
    ) {
      const event = signed(alice, {
        kind: 7,
        content,
        created_at: time++,
        tags: [["e", target.id], ["p", viewer.pubkey], ...tags],
      });
      await act(async () => {
        events.push(event);
        live.receive([event], { phase, channelId: "room" });
        await owner.session.inboxFeed.reactions.ensure();
        expect(owner.session.inboxFeed.reactions.snapshot().status).toBe(
          "ready",
        );
      });
    },
    active: () =>
      screen
        .getByRole("button", { name: "Activity" })
        .querySelector("[data-active]"),
  };
}
it("holds the first live emoji for three seconds, ignores bursts and skips replay", async () => {
  const h = await setup();
  await h.emit("❤️", [], "replay");
  expect(h.active()).toBeNull();
  await h.emit("✅");
  expect(h.active()).toHaveTextContent("✅");
  act(() => vi.advanceTimersByTime(2900));
  await h.emit("👍");
  expect(h.active()).toHaveTextContent("✅");
  act(() => vi.advanceTimersByTime(100));
  expect(h.active()).toBeNull();
  expect(screen.getByRole("button", { name: "Activity" })).toHaveAttribute(
    "title",
    "Activity",
  );
});
it("skips hidden arrivals without queuing them", async () => {
  const h = await setup();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await h.emit("✅");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(h.active()).toBeNull();
  await h.emit("👍");
  expect(h.active()).toHaveTextContent("👍");
});
it("waits for custom image loading and cancels timed-out images", async () => {
  const h = await setup();
  const images: HTMLImageElement[] = [];
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        images.push(this as unknown as HTMLImageElement);
      }
    },
  );
  await h.emit(":yay:", [["emoji", "yay", "https://example.com/yay.png"]]);
  expect(h.active()).toBeNull();
  act(() => images[0]?.onload?.(new Event("load")));
  expect(h.active()?.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.com/yay.png",
  );
  act(() => vi.advanceTimersByTime(3000));
  await h.emit(":slow:", [["emoji", "slow", "https://example.com/slow.png"]]);
  act(() => vi.advanceTimersByTime(1000));
  expect(h.active()).toBeNull();
  expect(images[1]?.onload).toBeNull();
});

it("keeps multi-emoji reactions in the feed but only swaps a single compound grapheme", async () => {
  const h = await setup();
  await h.emit("❤️❤️❤️❤️❤️");
  expect(h.active()).toBeNull();
  await h.emit("👩🏽‍💻");
  expect(h.active()).toHaveTextContent("👩🏽‍💻");
});
