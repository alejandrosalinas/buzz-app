// @vitest-environment jsdom
import { assert, expect, it, vi } from "vitest";
import {
  createHuddleWindow,
  projectAudioSettings,
  type HuddleWindowAction,
  type WindowBridge,
} from "./window";
import type { Huddles, HuddleSnapshot } from "./service";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";
function harness() {
  const store = createRelaySession(null);
  let snapshot: HuddleSnapshot = {
    id: "00000000-0000-4000-8000-000000000001",
    phase: "connected",
    muted: false,
    participants: [],
    destination: {
      scope: "scope",
      viewer: "viewer",
      channelId: "channel",
      channelName: "Design",
      relayUrl: "wss://example.test",
    },
  };
  const listeners = new Set<() => void>();
  const call: Huddles = {
    voiceError() {},
    remoteVoiceError() {},
    voiceListening() {},
    voiceThinking() {},
    snapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    canJoin: () => true,
    join: async () => {},
    start: async () => {},
    mute: vi.fn(),
    refreshAudioSettings: vi.fn(),
    selectAudioDevice: vi.fn(),
    leave: vi.fn(async () => {}),
    dispose: async () => {},
  };
  const profiles = new Map<string, { name: string; picture?: string }>();
  const session = {
    ...store.session,
    media: (url: string) => url,
    channels: { ...store.session.channels },
    profiles: { ...store.session.profiles, snapshot: () => profiles },
  };
  const connection = {
    session,
    status: "ready",
    scope: "scope",
    viewer: "viewer",
  };
  const relay = { snapshot: () => connection } as unknown as RelayData;
  let action = (_id: string, _action: HuddleWindowAction, _text?: string) => {};
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge: WindowBridge = {
    open: vi.fn(async (_view, act) => {
      action = act;
      await gate;
    }),
    update: vi.fn(async () => {}),
  };
  const openLink = vi.fn(() => true);
  const companion = createHuddleWindow(
    call,
    relay,
    bridge,
    undefined,
    openLink,
  );
  return {
    companion,
    profiles,
    connection,
    openLink,
    bridge,
    call,
    release,
    action: (id: string, a: HuddleWindowAction, text?: string) =>
      action(id, a, text),
    set(next: HuddleSnapshot) {
      snapshot = next;
      for (const fn of listeners) fn();
    },
    async dispose() {
      release();
      await companion.dispose();
      store.dispose();
    },
  };
}
it("closes a late-created window after leaving, and ignores stale controls", async () => {
  const h = harness();
  try {
    const opening = h.companion.open();
    await Promise.resolve();
    await Promise.resolve();
    h.set({ phase: "idle", participants: [], muted: false });
    h.release();
    await opening;
    await vi.waitFor(() =>
      expect(h.bridge.update).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000001",
        null,
      ),
    );
    h.action("00000000-0000-4000-8000-000000000001", "leave");
    expect(h.call.leave).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});
it("synchronizes mute and rejects commands from another call", async () => {
  const h = harness();
  try {
    h.release();
    await h.companion.open();
    const id = h.call.snapshot().id ?? "";
    h.action(id, "mute");
    expect(h.call.mute).toHaveBeenCalledOnce();
    h.action("old-call", "leave");
    expect(h.call.leave).not.toHaveBeenCalled();
    h.set({ ...h.call.snapshot(), muted: true });
    await vi.waitFor(() =>
      expect(h.bridge.update).toHaveBeenLastCalledWith(
        id,
        expect.objectContaining({ muted: true }),
      ),
    );
    h.action(id, "leave");
    expect(h.call.leave).toHaveBeenCalledOnce();
  } finally {
    await h.dispose();
  }
});
it("disposal waits for a pending open then retires its native window", async () => {
  const h = harness();
  const opening = h.companion.open();
  const disposing = h.companion.dispose();
  h.release();
  await opening;
  await disposing;
  expect(h.bridge.update).toHaveBeenLastCalledWith(
    "00000000-0000-4000-8000-000000000001",
    null,
  );
  await h.dispose();
});

it("retires partially created windows when native Show or Focus rejects", async () => {
  const h = harness();
  vi.mocked(h.bridge.open).mockRejectedValueOnce(new Error("Focus failed"));
  try {
    await expect(h.companion.open()).rejects.toThrow("Focus failed");
    expect(h.bridge.update).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      null,
    );
    h.release();
    await h.companion.open();
    expect(h.bridge.open).toHaveBeenCalledTimes(2);
  } finally {
    await h.dispose();
  }
});
it("disposal awaits cleanup when a pending native open rejects", async () => {
  const h = harness();
  let reject = (_: Error) => {};
  vi.mocked(h.bridge.open).mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  let releaseCleanup = () => {};
  vi.mocked(h.bridge.update).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      }),
  );
  const opening = h.companion.open();
  const failed = expect(opening).rejects.toThrow("Focus failed");
  await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledOnce());
  let disposed = false;
  const disposing = h.companion.dispose().then(() => {
    disposed = true;
  });
  reject(new Error("Focus failed"));
  await vi.waitFor(() => expect(h.bridge.update).toHaveBeenCalledOnce());
  expect(disposed).toBe(false);
  releaseCleanup();
  await failed;
  await disposing;
  expect(disposed).toBe(true);
  await h.dispose();
});

it.each(["closed", "minimize"] as const)(
  "opens once per call, keeps audio after %s, and reopens explicitly",
  async (action) => {
    const h = harness();
    try {
      h.release();
      h.set({ ...h.call.snapshot() });
      await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledOnce());
      expect(h.companion.snapshot()).toEqual({ visible: true, failed: false });
      const id = h.call.snapshot().id ?? "";
      h.action(id, action);
      expect(h.companion.snapshot().visible).toBe(false);
      expect(h.call.leave).not.toHaveBeenCalled();
      h.set({ ...h.call.snapshot(), muted: true });
      await Promise.resolve();
      expect(h.bridge.open).toHaveBeenCalledOnce();
      await h.companion.open();
      expect(h.companion.snapshot().visible).toBe(true);
      h.set({
        ...h.call.snapshot(),
        id: "00000000-0000-4000-8000-000000000002",
      });
      await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledTimes(3));
      h.action(id, "closed");
      expect(h.companion.snapshot().visible).toBe(true);
    } finally {
      await h.dispose();
    }
  },
);
it("keeps compact controls available after an automatic open failure", async () => {
  const h = harness();
  vi.mocked(h.bridge.open).mockRejectedValueOnce(new Error("Focus failed"));
  try {
    h.set({ ...h.call.snapshot() });
    await vi.waitFor(() =>
      expect(h.companion.snapshot()).toEqual({ visible: false, failed: true }),
    );
    h.set({ ...h.call.snapshot(), muted: true });
    expect(h.bridge.open).toHaveBeenCalledOnce();
    h.release();
    await h.companion.open();
    expect(h.companion.snapshot()).toEqual({ visible: true, failed: false });
  } finally {
    await h.dispose();
  }
});

it("keeps the compact player visible when the window closes before Open resolves", async () => {
  const h = harness();
  try {
    const opening = h.companion.open();
    await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledOnce());
    h.action(h.call.snapshot().id ?? "", "closed");
    h.release();
    await opening;
    expect(h.companion.snapshot()).toEqual({ visible: false, failed: false });
    expect(h.call.leave).not.toHaveBeenCalled();
    h.set({ ...h.call.snapshot(), muted: true });
    expect(h.bridge.open).toHaveBeenCalledOnce();
  } finally {
    await h.dispose();
  }
});
it("ignores delayed closure callbacks from an earlier window opening", async () => {
  const h = harness();
  try {
    h.release();
    await h.companion.open();
    const stale = vi.mocked(h.bridge.open).mock.calls[0]?.[1];
    const id = h.call.snapshot().id ?? "";
    h.action(id, "closed");
    await h.companion.open();
    stale?.(id, "closed");
    expect(h.companion.snapshot().visible).toBe(true);
    h.action(id, "closed");
    expect(h.companion.snapshot().visible).toBe(false);
  } finally {
    await h.dispose();
  }
});

it("sends speaking levels with the matching participant", async () => {
  const h = harness();
  try {
    h.release();
    h.set({
      ...h.call.snapshot(),
      participants: ["viewer", "alex"],
      speakers: { alex: 0.6 },
    });
    await h.companion.open();
    expect(h.bridge.open).toHaveBeenCalledWith(
      expect.objectContaining({
        participants: [
          expect.objectContaining({ key: "viewer", level: 0 }),
          expect.objectContaining({ key: "alex", level: 0.6 }),
        ],
      }),
      expect.any(Function),
    );
  } finally {
    await h.dispose();
  }
});

it("keeps the request window through acceptance and reuses it for the connected call", async () => {
  const h = harness();
  h.release();
  const initial = h.call.snapshot();
  const room = initial.id ?? "";
  try {
    h.set({
      ...initial,
      phase: "incoming",
      room,
      requester: "alex",
      participants: ["alex"],
    });
    await h.companion.open();
    h.set({
      ...initial,
      id: "00000000-0000-4000-8000-000000000002",
      phase: "connecting",
      room,
      requester: "alex",
      participants: ["alex"],
    });
    await vi.waitFor(() =>
      expect(h.bridge.update).toHaveBeenCalledWith(
        room,
        expect.objectContaining({ id: room, phase: "connecting" }),
      ),
    );
    expect(
      vi.mocked(h.bridge.update).mock.calls.some(([, value]) => value === null),
    ).toBe(false);
    h.set({
      ...h.call.snapshot(),
      phase: "connected",
      participants: ["alex", "viewer"],
    });
    await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledTimes(2));
    expect(h.companion.snapshot().visible).toBe(true);
    expect(
      vi.mocked(h.bridge.update).mock.calls.some(([, value]) => value === null),
    ).toBe(false);
  } finally {
    await h.dispose();
  }
});
it("can minimize the old request presentation while its accepted call connects", async () => {
  const h = harness();
  h.release();
  const initial = h.call.snapshot();
  const room = initial.id ?? "";
  try {
    h.set({ ...initial, phase: "incoming", room, requester: "alex" });
    await h.companion.open();
    h.set({
      ...initial,
      id: "00000000-0000-4000-8000-000000000002",
      phase: "connecting",
      room,
      requester: "alex",
    });
    h.action(room, "minimize");
    expect(h.companion.snapshot().visible).toBe(false);
    h.set({ ...h.call.snapshot(), phase: "connected" });
    await Promise.resolve();
    expect(h.bridge.open).toHaveBeenCalledOnce();
    expect(h.companion.snapshot().visible).toBe(false);
    await h.companion.open();
    expect(h.companion.snapshot().visible).toBe(true);
  } finally {
    await h.dispose();
  }
});

it("cancels only the matching accepted request while connection is pending", async () => {
  const h = harness();
  h.release();
  const initial = h.call.snapshot();
  const room = initial.id ?? "";
  try {
    h.set({ ...initial, phase: "incoming", room, requester: "alex" });
    await h.companion.open();
    h.set({
      ...initial,
      id: "00000000-0000-4000-8000-000000000002",
      phase: "connecting",
      room,
      requester: "alex",
    });
    h.action("stale", "decline");
    expect(h.call.leave).not.toHaveBeenCalled();
    h.action(room, "decline");
    expect(h.call.leave).toHaveBeenCalledOnce();
  } finally {
    await h.dispose();
  }
});

it("surfaces a failed native chat update and lets the next chat action retry", async () => {
  const h = harness();
  try {
    h.release();
    await h.companion.open();
    await vi.waitFor(() => expect(h.bridge.update).toHaveBeenCalled());
    vi.mocked(h.bridge.update).mockRejectedValueOnce(
      new Error("Window resize unavailable"),
    );
    h.action(h.call.snapshot().id ?? "", "thread");
    await vi.waitFor(() =>
      expect(h.companion.snapshot().error).toContain(
        "Window resize unavailable",
      ),
    );
    expect(h.companion.snapshot().visible).toBe(true);
    h.action(h.call.snapshot().id ?? "", "thread");
    await vi.waitFor(() =>
      expect(h.companion.snapshot().error).toBeUndefined(),
    );
    expect(h.call.leave).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

it("routes audio settings only from the current companion call", async () => {
  const h = harness();
  try {
    h.release();
    await h.companion.open();
    const id = h.call.snapshot().id;
    assert.exists(id);
    h.action(id, "refreshAudio");
    h.action(id, "inputDevice", "microphone");
    h.action(id, "outputDevice", "speakers");
    expect(h.call.refreshAudioSettings).toHaveBeenCalledOnce();
    expect(h.call.selectAudioDevice).toHaveBeenCalledWith(
      "input",
      "microphone",
    );
    expect(h.call.selectAudioDevice).toHaveBeenCalledWith("output", "speakers");
    h.action("previous-call", "inputDevice", "wrong");
    h.set({ phase: "idle", participants: [], muted: false });
    h.action(id, "outputDevice", "wrong");
    expect(h.call.selectAudioDevice).toHaveBeenCalledTimes(2);
  } finally {
    await h.dispose();
  }
});

it("bounds multibyte participant names on open and update and routes only current internal links", async () => {
  const h = harness();
  const profiles = h.profiles;
  profiles.set("peer", { name: "界😀".repeat(3000) });
  const destination = h.call.snapshot().destination;
  assert(destination);
  try {
    h.set({
      ...h.call.snapshot(),
      destination: {
        ...destination,
        channelName: "😀".repeat(3000),
      },
      participants: ["peer"],
    });
    h.release();
    await h.companion.open();
    const first = vi.mocked(h.bridge.open).mock.calls[0]?.[0];
    assert(first?.participants[0]);
    expect(new TextEncoder().encode(first.title).length).toBeLessThanOrEqual(
      4096,
    );
    expect(
      new TextEncoder().encode(first.participants[0].name).length,
    ).toBeLessThanOrEqual(4096);
    profiles.set("peer", { name: "😀".repeat(3000) });
    h.set({ ...h.call.snapshot() });
    await vi.waitFor(() =>
      expect(
        vi.mocked(h.bridge.update).mock.lastCall?.[1]?.participants[0]?.name,
      ).toBe("😀".repeat(1000)),
    );
    const id = h.call.snapshot().id;
    assert(id);
    h.action(id, "openLink", "BUZZ://channel/test");
    expect(h.openLink).toHaveBeenCalledWith("BUZZ://channel/test");
    h.action("stale", "openLink", "buzz://channel/test");
    h.action(id, "openLink", "https://example.test");
    expect(h.openLink).toHaveBeenCalledTimes(1);
    h.set({ ...h.call.snapshot(), phase: "leaving" });
    h.connection.scope = "replacement-community";
    h.action(id, "openLink", "buzz://channel/test");
    expect(h.openLink).toHaveBeenCalledTimes(1);
  } finally {
    await h.dispose();
  }
});

it("omits oversized inline avatars on open and update and projects retry errors", async () => {
  const h = harness();
  const oversized = `data:image/png;base64,${"a".repeat(9000)}`;
  try {
    h.profiles.set("peer", { name: "Peer", picture: oversized });
    h.set({
      ...h.call.snapshot(),
      participants: ["peer"],
      error: "Microphone denied",
    });
    h.release();
    await h.companion.open();
    expect(vi.mocked(h.bridge.open).mock.calls[0]?.[0]).toMatchObject({
      error: "Microphone denied",
      participants: [{ picture: null }],
    });
    h.profiles.set("peer", {
      name: "Peer",
      picture: "https://example.test/avatar.png",
    });
    h.set({ ...h.call.snapshot() });
    await vi.waitFor(() =>
      expect(
        vi.mocked(h.bridge.update).mock.lastCall?.[1]?.participants[0]?.picture,
      ).toBe("https://example.test/avatar.png"),
    );
    h.profiles.set("peer", { name: "Peer", picture: oversized });
    h.set({ ...h.call.snapshot() });
    await vi.waitFor(() =>
      expect(
        vi.mocked(h.bridge.update).mock.lastCall?.[1]?.participants[0]?.picture,
      ).toBeNull(),
    );
  } finally {
    await h.dispose();
  }
});

it("reopens the same invitation with its failure after an unsuccessful attempt", async () => {
  const h = harness();
  try {
    const initial = {
      ...h.call.snapshot(),
      phase: "incoming" as const,
      room: "00000000-0000-4000-8000-000000000001",
      requester: "peer",
    };
    h.release();
    h.set(initial);
    await h.companion.open();
    h.set({ ...initial, id: "attempt", phase: "connecting" });
    h.set({ ...initial, id: "attempt", phase: "leaving" });
    h.set({
      phase: "error",
      muted: false,
      participants: [],
      error: "Microphone denied",
    });
    h.set({ ...initial, error: "Microphone denied" });
    await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalledTimes(2));
    expect(vi.mocked(h.bridge.open).mock.lastCall?.[0]).toMatchObject({
      phase: "incoming",
      error: "Microphone denied",
    });
  } finally {
    await h.dispose();
  }
});

it("bounds native audio presentation without truncating device identities", () => {
  const state = projectAudioSettings({
    inputs: [
      { id: "😀".repeat(1025), label: "invalid" },
      ...Array.from({ length: 140 }, (_, i) => ({
        id: String(i),
        label: "😀".repeat(2000),
      })),
    ],
    outputs: [],
    input: "😀".repeat(1025),
    output: "",
    outputSupported: true,
    loading: false,
    busy: false,
  });
  expect(state.inputs).toHaveLength(128);
  expect(state.inputs[0]?.id).toBe("0");
  expect(
    new TextEncoder().encode(state.inputs[0]?.label).length,
  ).toBeLessThanOrEqual(4096);
  expect(state.input).toBe("");
});
it("retries failed profile reads and scopes successes to the relay session", async () => {
  const h = harness();
  const ensure = vi
    .spyOn(h.connection.session.profiles, "ensure")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  h.set({ ...h.call.snapshot(), participants: ["ab".repeat(32)] });
  h.release();
  await h.companion.open();
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => {
    h.set({ ...h.call.snapshot() });
    expect(ensure).toHaveBeenCalledTimes(2);
  });
  const other = vi.fn(async () => {});
  h.connection.session = {
    ...h.connection.session,
    profiles: { ...h.connection.session.profiles, ensure: other },
  };
  h.set({ ...h.call.snapshot() });
  await vi.waitFor(() => expect(other).toHaveBeenCalledTimes(1));
  await h.dispose();
});

it("reads unchanged participants again after an access purge", async () => {
  const h = harness();
  let purges = 0;
  const ensure = vi.fn(async () => {});
  h.connection.session = {
    ...h.connection.session,
    profiles: {
      ...h.connection.session.profiles,
      ensure,
      generation: () => purges,
    },
  };
  h.set({ ...h.call.snapshot(), participants: ["ab".repeat(32)] });
  h.release();
  await h.companion.open();
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
  // Same participants after success: no new demand.
  h.set({ ...h.call.snapshot() });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(ensure).toHaveBeenCalledTimes(1);
  // A purge drops their names; the same participants are a new demand.
  purges++;
  h.set({ ...h.call.snapshot() });
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2));
  await h.dispose();
});

it("releases discussion subscriptions when reopening the companion fails", async () => {
  const h = harness();
  const stopWindow = vi.fn();
  vi.spyOn(h.connection.session.channels, "subscribeWindow").mockReturnValue(
    stopWindow,
  );
  try {
    h.release();
    h.set({ ...h.call.snapshot(), room: "room" });
    await h.companion.open();
    h.action(h.call.snapshot().id ?? "", "thread");
    expect(h.connection.session.channels.subscribeWindow).toHaveBeenCalledWith(
      "room",
      expect.any(Function),
    );
    vi.mocked(h.bridge.open).mockRejectedValueOnce(new Error("Focus failed"));
    await expect(h.companion.open()).rejects.toThrow("Focus failed");
    expect(stopWindow).toHaveBeenCalledOnce();
    expect(h.companion.snapshot()).toMatchObject({
      visible: false,
      failed: true,
    });
    await h.companion.open();
    h.action(h.call.snapshot().id ?? "", "thread");
    expect(h.connection.session.channels.subscribeWindow).toHaveBeenCalledTimes(
      2,
    );
  } finally {
    await h.dispose();
  }
});

it("projects listening only for locally active seats in a connected call", async () => {
  const h = harness();
  h.profiles.set("remote", {
    name: "Remote",
    ...{ isAgent: true, ownerPubkey: "viewer" },
  });
  h.set({
    ...h.call.snapshot(),
    participants: ["local", "remote"],
    listening: ["local"],
    thinking: ["local"],
  });
  h.release();
  await h.companion.open();
  expect(
    vi.mocked(h.bridge.open).mock.lastCall?.[0].participants,
  ).toMatchObject([
    { key: "local", listening: true, thinking: true },
    { key: "remote", listening: false },
  ]);
  h.release();
  h.set({ ...h.call.snapshot(), phase: "leaving" });
  await vi.waitFor(() =>
    expect(
      vi.mocked(h.bridge.update).mock.lastCall?.[1]?.participants,
    ).toMatchObject([
      { key: "local", listening: false, thinking: false },
      { key: "remote", listening: false },
    ]),
  );
  await h.dispose();
});
