import { describe, expect, it, vi } from "vitest";
import type {
  ChannelLifecycleCapability,
  DmVisibility,
} from "./channel-lifecycle";
import type { RelayEvent } from "./events";
import type { IncomingListener, LiveListener } from "./incoming";
import { resurfaceHiddenDms } from "./dm-resurfacing";

const dm = "11111111-1111-4111-8111-111111111111";
const viewer = "a".repeat(64);
const peer = "b".repeat(64);

function harness(initial: DmVisibility) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const refreshVisibility = vi.fn(async () => {});
  const lifecycle = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshVisibility,
  } as unknown as ChannelLifecycleCapability;
  let incoming: IncomingListener = () => {};
  let replay: LiveListener = () => {};
  const stop = resurfaceHiddenDms(
    {
      channelLifecycle: lifecycle,
      subscribeIncoming: (listener) => {
        incoming = listener;
        return () => {};
      },
      subscribeLive: (listener, options) => {
        expect(options).toEqual({ replay: true });
        replay = listener;
        return () => {};
      },
    },
    viewer,
  );
  const message = (audience?: "agents") =>
    incoming([
      {
        channelId: dm,
        messageId: "m",
        createdAt: 1,
        authorId: peer,
        previewContent: "hi",
        ...(audience ? { audience } : {}),
      },
    ]);
  const replayed = (pubkey: string, tags: string[][] = []) =>
    replay({
      replay: true,
      channelId: dm,
      events: [
        {
          id: "e",
          pubkey,
          kind: 9,
          created_at: 1,
          content: "",
          sig: "",
          tags: [["h", dm], ...tags],
        } as RelayEvent,
      ],
    });
  const emit = (next: DmVisibility) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return { refreshVisibility, message, replayed, emit, stop };
}

const strong = [undefined, { trailing: true, strong: true }];

describe("a hidden DM resurfaces on someone else's message", () => {
  it.each([
    ["a live message", (h: ReturnType<typeof harness>) => h.message(), 1],
    [
      "reconnect replay",
      (h: ReturnType<typeof harness>) => h.replayed(peer),
      1,
    ],
    [
      "an agent-only message",
      (h: ReturnType<typeof harness>) => h.message("agents"),
      0,
    ],
    [
      "agent-only replay",
      (h: ReturnType<typeof harness>) =>
        h.replayed(peer, [["audience", "agents"]]),
      0,
    ],
    [
      "the viewer's own replay",
      (h: ReturnType<typeof harness>) => h.replayed(viewer),
      0,
    ],
  ] as const)("%s", (_name, arrive, reads) => {
    const h = harness({ status: "ready", hidden: [dm] });
    arrive(h);
    expect(h.refreshVisibility).toHaveBeenCalledTimes(reads);
    if (reads) expect(h.refreshVisibility).toHaveBeenLastCalledWith(...strong);
  });

  it("holds an arrival during the first read until its snapshot classifies it", () => {
    const h = harness({ status: "loading", hidden: [] });
    h.message();
    expect(h.refreshVisibility).not.toHaveBeenCalled();
    // The held first response sampled the hide before the message.
    h.emit({ status: "ready", hidden: [dm] });
    expect(h.refreshVisibility).toHaveBeenCalledOnce();
    expect(h.refreshVisibility).toHaveBeenLastCalledWith(...strong);
    // Classified once: the follow-up snapshot does not read again.
    h.emit({ status: "loading", hidden: [dm] });
    h.emit({ status: "ready", hidden: [] });
    expect(h.refreshVisibility).toHaveBeenCalledOnce();
  });

  it("drops a held arrival the first snapshot already shows", () => {
    const h = harness({ status: "idle", hidden: [] });
    h.message();
    h.emit({ status: "ready", hidden: [] });
    expect(h.refreshVisibility).not.toHaveBeenCalled();
  });
});
