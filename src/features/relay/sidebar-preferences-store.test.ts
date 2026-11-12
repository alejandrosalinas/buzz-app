import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import { flush, keypair, scriptedTransport } from "./testing";
import type {
  SidebarAssignmentMutator,
  SidebarStarMutator,
  SidebarMuteMutator,
  SidebarSortMutator,
  SidebarFilterMutator,
  SidebarPreferences,
} from "./sidebar-preferences";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it.each([
  { groupsOnly: false, failure: "Section creation is unavailable" },
  { groupsOnly: true, failure: "Workspaces are unavailable" },
])(
  "keeps creation errors specific to the groupsOnly=$groupsOnly surface",
  async ({ groupsOnly, failure }) => {
    const store = createSidebarPreferencesStore({
      read: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
      }),
      available: true,
      groupsOnly,
    });
    try {
      await expect(
        store.queries.createSection({ id: "new", name: "New" }),
      ).rejects.toThrow(failure);
    } finally {
      store.dispose();
    }
  },
);

const data: SidebarPreferences = {
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { alpha: "work" },
  starred: ["beta"],
  muted: [],
};
function setup(
  decode = vi.fn(async (): Promise<SidebarPreferences> => data),
  write?: SidebarAssignmentMutator,
  writeStar?: SidebarStarMutator,
  writeSidebarMute?: SidebarMuteMutator,
  writeSidebarSort?: SidebarSortMutator,
  writeSidebarFilter?: SidebarFilterMutator,
) {
  const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    decodeSidebarPreferences: decode,
    ...(writeSidebarMute ? { writeSidebarMute } : {}),
    ...(writeSidebarSort ? { writeSidebarSort } : {}),
    ...(writeSidebarFilter ? { writeSidebarFilter } : {}),
    ...(write || writeStar
      ? {
          writeSidebarAssignment:
            write ??
            (async ({ channelId, sectionId }) => {
              const assignments = { ...data.assignments };
              if (channelId !== undefined) {
                if (sectionId) assignments[channelId] = sectionId;
                else delete assignments[channelId];
              }
              return { sections: data.sections, assignments };
            }),
          writeSidebarStar:
            writeStar ??
            (async ({ channelId, starred }) => [
              ...data.starred.filter((id) => id !== channelId),
              ...(starred ? [channelId] : []),
            ]),
        }
      : {}),
  });
  return { wire, owner, preferences: owner.session.sidebarPreferences, decode };
}

it("applies a confirmed assignment to the retained session snapshot", async () => {
  const write = vi.fn<SidebarAssignmentMutator>(async () => ({
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { alpha: "later" },
  }));
  const { wire, owner, preferences } = setup(undefined, write);
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const listener = vi.fn();
    preferences.subscribe(listener);
    await expect(preferences.assign("alpha", "later")).resolves.toMatchObject({
      assignments: { alpha: "later" },
    });
    expect(write).toHaveBeenCalledWith(
      { channelId: "alpha", sectionId: "later" },
      expect.any(AbortSignal),
    );
    expect(preferences.snapshot()).toEqual({
      status: "ready",
      data: {
        sections: [
          { id: "work", name: "Work", order: 0 },
          { id: "later", name: "Later", order: 1 },
        ],
        assignments: { alpha: "later" },
        starred: ["beta"],
        muted: [],
      },
    });
    expect(Object.isFrozen(preferences.snapshot().data?.assignments)).toBe(
      true,
    );
    expect(listener).toHaveBeenCalledTimes(2); // optimistic placement, then confirmation
  } finally {
    owner.dispose();
  }
});

it("keeps the last confirmed snapshot when an assignment fails", async () => {
  const write = vi.fn<SidebarAssignmentMutator>(async () => {
    throw new Error("relay rejected write");
  });
  const { wire, owner, preferences } = setup(undefined, write);
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const retained = preferences.snapshot();
    await expect(preferences.assign("alpha")).rejects.toThrow(
      "relay rejected write",
    );
    expect(preferences.snapshot().data).toEqual(retained.data);
    expect(preferences.snapshot().moves).toEqual([
      expect.objectContaining({
        pending: false,
        error: "relay rejected write",
      }),
    ]);
  } finally {
    owner.dispose();
  }
});

it("does not let an older refresh overwrite a confirmed assignment", async () => {
  let resolveDecode!: (value: SidebarPreferences) => void;
  const decode = vi.fn(
    async () =>
      new Promise<SidebarPreferences>((resolve) => {
        resolveDecode = resolve;
      }),
  );
  const write = vi.fn<SidebarAssignmentMutator>(async () => ({
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { alpha: "work" },
  }));
  const { wire, owner, preferences } = setup(decode, write);
  try {
    decode.mockResolvedValueOnce(data);
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const refresh = preferences.refresh();
    await flush();
    wire.next().respond([]);
    await flush();
    await preferences.assign("alpha", "work");
    resolveDecode({ ...data, assignments: {} });
    await refresh;
    expect(preferences.snapshot().data?.assignments).toEqual({ alpha: "work" });
  } finally {
    owner.dispose();
  }
});

it("rejects queued assignment results after session cache clear", async () => {
  let resolveWrite!: (
    value: Awaited<ReturnType<SidebarAssignmentMutator>>,
  ) => void;
  const write = vi.fn<SidebarAssignmentMutator>(
    async () =>
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
  );
  const { wire, owner, preferences } = setup(undefined, write);
  const initial = preferences.ensure();
  await flush();
  wire.next().respond([]);
  await initial;
  const pending = preferences.assign("alpha", "work");
  await flush();
  await owner.clearCache();
  resolveWrite({
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { alpha: "work" },
  });
  await expect(pending).rejects.toThrow("unavailable");
  expect(preferences.snapshot()).toEqual({ status: "idle" });
  owner.dispose();
});
it("one session retains groups across observers and deduplicates initial reads", async () => {
  const { wire, owner, preferences, decode } = setup();
  try {
    const listener = vi.fn();
    const off = preferences.subscribe(listener);
    const first = preferences.ensure();
    const second = preferences.ensure();
    expect(second).toBe(first);
    await flush();
    wire.next().respond([]);
    await first;
    const retained = preferences.snapshot();
    expect(retained).toEqual({ status: "ready", data });
    expect(Object.isFrozen(retained.data?.sections[0])).toBe(true);
    off();
    const again = preferences.subscribe(listener);
    await preferences.ensure();
    expect(preferences.snapshot()).toBe(retained);
    expect(wire.pending).toHaveLength(0);
    expect(decode).toHaveBeenCalledTimes(1);
    again();
  } finally {
    owner.dispose();
  }
});

it("leaving the page does not abort the session's in-flight initial read", async () => {
  const { wire, owner, preferences } = setup();
  try {
    const off = preferences.subscribe(() => {});
    const pending = preferences.ensure();
    await flush();
    const read = wire.next();
    off();
    expect(read.signal?.aborted).toBe(false);
    read.respond([]);
    await pending;
    expect(preferences.snapshot()).toEqual({ status: "ready", data });
  } finally {
    owner.dispose();
  }
});

it("explicit refresh retains the last good groups through loading/error and can retry", async () => {
  const { wire, owner, preferences, decode } = setup();
  try {
    const first = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await first;
    const retained = preferences.snapshot().data;
    decode.mockRejectedValueOnce(new Error("decode failed"));
    const failed = preferences.refresh();
    expect(preferences.snapshot()).toEqual({
      status: "loading",
      data: retained,
    });
    await flush();
    wire.next().respond([]);
    await failed;
    expect(preferences.snapshot().status).toBe("error");
    expect(preferences.snapshot().data).toBe(retained);
    await preferences.ensure();
    expect(wire.pending).toHaveLength(0); // No automatic retry storm on remount.
    const retry = preferences.refresh();
    expect(preferences.snapshot().error).toBeUndefined();
    await flush();
    wire.next().respond([]);
    await retry;
    expect(preferences.snapshot()).toEqual({ status: "ready", data });
  } finally {
    owner.dispose();
  }
});

it.each(["clearCache", "dispose"] as const)(
  "%s purges retained data and rejects late decoded completion",
  async (action) => {
    let resolve!: (data: SidebarPreferences) => void;
    let decodeSignal: AbortSignal | undefined;
    const { wire, owner, preferences } = setup(
      vi.fn((_events?: unknown, signal?: AbortSignal) => {
        decodeSignal = signal;
        return new Promise<SidebarPreferences>((done) => {
          resolve = done;
        });
      }),
    );
    try {
      const pending = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await flush();
      expect(decodeSignal?.aborted).toBe(false);
      await owner[action]();
      expect(decodeSignal?.aborted).toBe(true);
      expect(preferences.snapshot().data).toBeUndefined();
      resolve(data);
      await pending;
      expect(preferences.snapshot().data).toBeUndefined();
      expect(preferences.snapshot().status).toBe("idle");
      if (action === "dispose") {
        await preferences.ensure();
        expect(wire.pending).toHaveLength(0);
      }
    } finally {
      owner.dispose();
    }
  },
);

it("replacement viewer/community sessions do not reuse another session's groups", async () => {
  const a = setup(),
    b = setup();
  try {
    const first = a.preferences.ensure();
    await flush();
    a.wire.next().respond([]);
    await first;
    expect(a.preferences.snapshot().data).toEqual(data);
    expect(b.preferences.snapshot()).toEqual({ status: "idle" });
    a.owner.dispose();
    expect(a.preferences.snapshot().data).toBeUndefined();
    expect(b.preferences.snapshot().data).toBeUndefined();
  } finally {
    a.owner.dispose();
    b.owner.dispose();
  }
});

it("serializes mute writes without changing saved groups or stars", async () => {
  const gate = deferred<readonly string[]>();
  const started = deferred<void>();
  const mute = vi
    .fn<SidebarMuteMutator>()
    .mockImplementationOnce(async () => {
      started.resolve();
      return gate.promise;
    })
    .mockResolvedValueOnce(["alpha", "beta"]);
  const { wire, owner, preferences } = setup(
    undefined,
    undefined,
    undefined,
    mute,
  );
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const first = preferences.setMute("alpha", true);
    await started.promise;
    const second = preferences.setMute("beta", true);
    expect(mute).toHaveBeenCalledOnce();
    expect(preferences.snapshot().data).toEqual(data);
    gate.resolve(["alpha"]);
    await Promise.all([first, second]);
    expect(preferences.snapshot()).toEqual({
      status: "ready",
      data: { ...data, muted: ["alpha", "beta"] },
    });
    expect(Object.isFrozen(preferences.snapshot().data?.muted)).toBe(true);
  } finally {
    gate.resolve([]);
    owner.dispose();
  }
});
it("failed Mute retains the confirmed snapshot and a retry can unmute", async () => {
  const mute = vi
    .fn<SidebarMuteMutator>()
    .mockRejectedValueOnce(new Error("publish rejected"))
    .mockResolvedValueOnce([]);
  const { wire, owner, preferences } = setup(
    undefined,
    undefined,
    undefined,
    mute,
  );
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const retained = preferences.snapshot();
    await expect(preferences.setMute("beta", false)).rejects.toThrow(
      "publish rejected",
    );
    expect(preferences.snapshot()).toBe(retained);
    await preferences.setMute("beta", false);
    expect(preferences.snapshot().data).toEqual({ ...data, muted: [] });
  } finally {
    owner.dispose();
  }
});

it.each(["success", "failure"])(
  "a stale refresh %s cannot overwrite confirmed Mute",
  async (outcome) => {
    const gate = deferred<SidebarPreferences>();
    const started = deferred<void>();
    const decode = vi
      .fn(async () => data)
      .mockImplementationOnce(async () => data);
    const { wire, owner, preferences } = setup(
      decode,
      undefined,
      undefined,
      async () => ["alpha", "beta"],
    );
    try {
      const initial = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await initial;
      decode.mockImplementationOnce(() => {
        started.resolve();
        return gate.promise;
      });
      const refresh = preferences.refresh();
      await flush();
      wire.next().respond([]);
      await started.promise;
      await preferences.setMute("alpha", true);
      const retained = preferences.snapshot();
      if (outcome === "success") gate.resolve(data);
      else gate.reject(new Error("old read failed"));
      await refresh;
      expect(preferences.snapshot()).toBe(retained);
      expect(retained.status).toBe("ready");
      expect(retained.data?.muted).toEqual(["alpha", "beta"]);
    } finally {
      gate.resolve(data);
      owner.dispose();
    }
  },
);

it.each(["clearCache", "dispose", "cancel"] as const)(
  "%s aborts Mute and fences active and queued writes",
  async (action) => {
    const gate = deferred<readonly string[]>();
    const started = deferred<AbortSignal>();
    const mute = vi.fn<SidebarMuteMutator>(async (_intent, signal) => {
      started.resolve(signal);
      return gate.promise;
    });
    const { wire, owner, preferences } = setup(
      undefined,
      undefined,
      undefined,
      mute,
    );
    const caller = new AbortController();
    try {
      const initial = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await initial;
      const pending = preferences.setMute("alpha", true, caller.signal);
      const activeSignal = await started.promise;
      const queued = preferences.setMute("beta", false, caller.signal);
      const result = Promise.allSettled([pending, queued]);
      if (action === "cancel") caller.abort();
      else await owner[action]();
      expect(activeSignal.aborted).toBe(true);
      gate.resolve(["alpha", "beta"]);
      expect((await result).map((entry) => entry.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(mute).toHaveBeenCalledOnce();
      expect(preferences.snapshot().data).toEqual(
        action === "cancel" ? data : undefined,
      );
    } finally {
      gate.resolve([]);
      owner.dispose();
    }
  },
);

it("does not mutate before a successful initial preference read or without host capability", async () => {
  const mute = vi.fn<SidebarMuteMutator>(async () => []);
  const { owner, preferences } = setup(undefined, undefined, undefined, mute);
  try {
    await expect(preferences.setMute("alpha", true)).rejects.toThrow(
      "unavailable",
    );
    expect(mute).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
  const readonly = setup();
  try {
    expect(readonly.preferences.muteWritable).toBe(false);
  } finally {
    readonly.owner.dispose();
  }
});

it.each(["mute-first", "sort-first"] as const)(
  "%s shares the session queue and preserves confirmed mutes through sort rollback/retry",
  async (order) => {
    const muteGate = deferred<readonly string[]>();
    const sortGate = deferred<Readonly<Record<string, "recent">>>();
    const muteStarted = deferred<void>();
    const sortStarted = deferred<void>();
    const mute = vi.fn<SidebarMuteMutator>(async () => {
      muteStarted.resolve();
      return muteGate.promise;
    });
    const sort = vi.fn<SidebarSortMutator>(async () => {
      sortStarted.resolve();
      return sortGate.promise;
    });
    const { wire, owner, preferences } = setup(
      undefined,
      undefined,
      undefined,
      mute,
      sort,
    );
    try {
      const initial = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await initial;
      const startMute = () => preferences.setMute("alpha", true);
      const startSort = () =>
        preferences.setSort("channels", "recent", ["work"]);
      const first = order === "mute-first" ? startMute() : startSort();
      const firstResult = Promise.allSettled([first]);
      await (order === "mute-first" ? muteStarted : sortStarted).promise;
      const second = order === "mute-first" ? startSort() : startMute();
      const secondResult = Promise.allSettled([second]);
      expect(order === "mute-first" ? sort : mute).not.toHaveBeenCalled();
      expect(preferences.snapshot().data).toEqual({
        ...data,
        sort: { channels: "recent" },
      }); // Sort is optimistic; mute truth is still confirmed-only.
      if (order === "mute-first") {
        muteGate.resolve(["alpha"]);
        await first;
        expect(preferences.snapshot().data?.sort).toEqual({
          channels: "recent",
        });
        await sortStarted.promise;
        sortGate.reject(new Error("sort failed"));
      } else {
        sortGate.reject(new Error("sort failed"));
        await muteStarted.promise;
        muteGate.resolve(["alpha"]);
      }
      expect(
        [...(await firstResult), ...(await secondResult)].map((r) => r.status),
      ).toEqual(
        order === "mute-first"
          ? ["fulfilled", "rejected"]
          : ["rejected", "fulfilled"],
      );
      expect(preferences.snapshot()).toEqual({
        status: "ready",
        data: { ...data, muted: ["alpha"], sort: {} },
        sortErrors: [
          { group: "channels", mode: "recent", error: "sort failed" },
        ],
      });
      sort.mockResolvedValueOnce({ channels: "recent" });
      await preferences.setSort("channels", "recent", ["work"]);
      expect(preferences.snapshot()).toEqual({
        status: "ready",
        data: { ...data, muted: ["alpha"], sort: { channels: "recent" } },
      });
    } finally {
      muteGate.resolve([]);
      sortGate.resolve({});
      owner.dispose();
    }
  },
);

it.each(["clearCache", "dispose"] as const)(
  "%s fences an active mute and a queued optimistic sort together",
  async (action) => {
    const gate = deferred<readonly string[]>();
    const started = deferred<AbortSignal>();
    const mute = vi.fn<SidebarMuteMutator>(async (_intent, signal) => {
      started.resolve(signal);
      return gate.promise;
    });
    const sort = vi.fn<SidebarSortMutator>(async () => ({
      channels: "recent",
    }));
    const { wire, owner, preferences } = setup(
      undefined,
      undefined,
      undefined,
      mute,
      sort,
    );
    try {
      const initial = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await initial;
      const muting = preferences.setMute("alpha", true);
      const signal = await started.promise;
      const sorting = preferences.setSort("channels", "recent", ["work"]);
      const settled = Promise.allSettled([muting, sorting]);
      await owner[action]();
      expect(signal.aborted).toBe(true);
      gate.resolve(["alpha"]);
      expect((await settled).map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(sort).not.toHaveBeenCalled();
      expect(preferences.snapshot()).toEqual({ status: "idle" });
    } finally {
      gate.resolve([]);
      owner.dispose();
    }
  },
);

it("serializes confirmed assignment and star writes without losing either projection", async () => {
  const gate = deferred<readonly string[]>();
  const started = deferred<void>();
  const star = vi.fn<SidebarStarMutator>(async ({ starred }) => {
    if (!starred) return ["alpha"];
    started.resolve();
    return gate.promise;
  });
  const assign = vi.fn<SidebarAssignmentMutator>(async () => ({
    sections: data.sections,
    assignments: { alpha: "work", beta: "work" },
  }));
  const { wire, owner, preferences } = setup(undefined, assign, star);
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const pending = preferences.setStar("alpha", true);
    await started.promise;
    const queued = preferences.assign("beta", "work");
    expect(preferences.snapshot().data).toEqual({
      ...data,
      assignments: { alpha: "work", beta: "work" },
      starred: ["alpha"],
    });
    expect(assign).not.toHaveBeenCalled();
    gate.resolve(["alpha", "beta"]);
    await Promise.all([pending, queued]);
    expect(preferences.snapshot()).toEqual({
      status: "ready",
      data: {
        ...data,
        assignments: { alpha: "work", beta: "work" },
        starred: ["alpha"],
      },
    });
    expect(Object.isFrozen(preferences.snapshot().data?.starred)).toBe(true);
    expect(star).toHaveBeenCalledWith(
      { channelId: "alpha", starred: true },
      expect.any(AbortSignal),
    );
  } finally {
    gate.resolve([]);
    owner.dispose();
  }
});

it("failed Star retains the confirmed snapshot and a retry can unstar", async () => {
  const star = vi
    .fn<SidebarStarMutator>()
    .mockRejectedValueOnce(new Error("publish rejected"))
    .mockResolvedValueOnce([]);
  const { wire, owner, preferences } = setup(undefined, undefined, star);
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const retained = preferences.snapshot();
    await expect(preferences.setStar("beta", false)).rejects.toThrow(
      "publish rejected",
    );
    expect(preferences.snapshot().data).toEqual(retained.data);
    expect(preferences.snapshot().moves).toEqual([
      expect.objectContaining({ pending: false, error: "publish rejected" }),
    ]);
    await preferences.retryMove("beta");
    expect(preferences.snapshot().data).toEqual({ ...data, starred: [] });
  } finally {
    owner.dispose();
  }
});

it.each(["clearCache", "dispose", "cancel"] as const)(
  "%s aborts Star and fences active and queued writes",
  async (action) => {
    const gate = deferred<readonly string[]>();
    const started = deferred<AbortSignal>();
    const star = vi.fn<SidebarStarMutator>(async (_intent, signal) => {
      started.resolve(signal);
      return gate.promise;
    });
    const { wire, owner, preferences } = setup(undefined, undefined, star);
    const caller = new AbortController();
    try {
      const initial = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await initial;
      const pending = preferences.setStar("alpha", true, caller.signal);
      const activeSignal = await started.promise;
      const queued = preferences.setStar("beta", false, caller.signal);
      const result = Promise.allSettled([pending, queued]);
      if (action === "cancel") caller.abort();
      else await owner[action]();
      expect(activeSignal.aborted).toBe(true);
      gate.resolve(["alpha", "beta"]);
      expect((await result).map((entry) => entry.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(star).toHaveBeenCalledOnce();
      expect(preferences.snapshot().data).toEqual(
        action === "cancel" ? data : undefined,
      );
    } finally {
      gate.resolve([]);
      owner.dispose();
    }
  },
);

it("does not mutate before a successful initial preference read or without host capability", async () => {
  const star = vi.fn<SidebarStarMutator>(async () => []);
  const assign = vi.fn<SidebarAssignmentMutator>(async () => data);
  const { owner, preferences } = setup(undefined, assign, star);
  try {
    await expect(preferences.setStar("alpha", true)).rejects.toThrow(
      "unavailable",
    );
    await expect(preferences.assign("alpha", "work")).rejects.toThrow();
    expect(star).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
  const readonly = setup();
  try {
    expect(readonly.preferences.starWritable).toBe(false);
  } finally {
    readonly.owner.dispose();
  }
});

it("retains confirmed placement but gates moves after a failed refresh until a successful retry", async () => {
  const write = vi.fn<SidebarAssignmentMutator>(async () => data);
  const star = vi.fn<SidebarStarMutator>(async () => data.starred);
  const { wire, owner, preferences, decode } = setup(undefined, write, star);
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const retained = preferences.snapshot().data;
    decode.mockRejectedValueOnce(new Error("legacy decoder unavailable"));
    const failed = preferences.refresh();
    await flush();
    wire.next().respond([]);
    await failed;
    expect(preferences.snapshot().data).toBe(retained);
    expect(preferences.writable).toBe(false);
    expect(preferences.starWritable).toBe(false);
    await expect(preferences.assign("alpha", "work")).rejects.toThrow(
      /unavailable/,
    );
    await expect(preferences.setStar("alpha", true)).rejects.toThrow(
      /unavailable/,
    );
    await expect(
      preferences.createAndAssign("alpha", { id: "new", name: "New" }),
    ).rejects.toThrow(/unavailable/);
    const retry = preferences.refresh();
    await flush();
    const request = wire.next();
    expect(preferences.writable).toBe(false);
    await expect(preferences.setStar("alpha", true)).rejects.toThrow(
      /unavailable/,
    );
    expect(write).not.toHaveBeenCalled();
    expect(star).not.toHaveBeenCalled();
    request.respond([]);
    await retry;
    expect(preferences.writable).toBe(true);
    expect(preferences.starWritable).toBe(true);
    await preferences.assign("alpha", "work");
    expect(write).toHaveBeenCalledOnce();
    expect(star).toHaveBeenCalledOnce();
  } finally {
    owner.dispose();
  }
});

it("keeps newer filter intent visible, rolls back failures, and retries without losing sort state", async () => {
  const first =
    deferred<import("./sidebar-preferences").SidebarFilterSettings>();
  const started = deferred<void>();
  const write = vi
    .fn<SidebarFilterMutator>()
    .mockImplementationOnce(async () => {
      started.resolve();
      return first.promise;
    })
    .mockResolvedValueOnce({
      filters: { channels: "active" },
      activeWindowSeconds: { channels: 7 * 86400 },
    });
  const { owner, wire, preferences } = setup(
    vi.fn(async () => ({ ...data, sort: { channels: "recent" as const } })),
    undefined,
    undefined,
    undefined,
    undefined,
    write,
  );
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const older = preferences.setFilter("channels", "unreads", ["work"]);
    const olderFailure = expect(older).rejects.toThrow("older failed");
    await started.promise;
    expect(preferences.snapshot().data?.filters).toEqual({
      channels: "unreads",
    });
    const newer = preferences.setFilter(
      "channels",
      "active",
      ["work"],
      undefined,
      7 * 86400,
    );
    expect(preferences.snapshot().data?.filters).toEqual({
      channels: "active",
    });
    expect(preferences.snapshot().data?.activeWindowSeconds).toEqual({
      channels: 7 * 86400,
    });
    first.reject(new Error("older failed"));
    await olderFailure;
    await newer;
    expect(preferences.snapshot().filterErrors).toBeUndefined();
    write.mockRejectedValueOnce(new Error("not confirmed"));
    await expect(
      preferences.setFilter(
        "channels",
        "active",
        ["work"],
        undefined,
        90 * 86400,
      ),
    ).rejects.toThrow("not confirmed");
    expect(preferences.snapshot().data).toMatchObject({
      filters: { channels: "active" },
      sort: { channels: "recent" },
      activeWindowSeconds: { channels: 7 * 86400 },
    });
    expect(preferences.snapshot().filterErrors).toEqual([
      {
        group: "channels",
        mode: "active",
        activeWindowSeconds: 90 * 86400,
        error: "not confirmed",
      },
    ]);
    write.mockResolvedValueOnce({ filters: {}, activeWindowSeconds: {} });
    await preferences.setFilter("channels", "all", ["work"]);
    expect(preferences.snapshot().data?.filters).toEqual({});
    expect(preferences.snapshot().filterErrors).toBeUndefined();
  } finally {
    first.resolve({ filters: {}, activeWindowSeconds: {} });
    owner.dispose();
  }
});

it("fences an in-flight filter write when the session cache is cleared", async () => {
  const gate =
    deferred<import("./sidebar-preferences").SidebarFilterSettings>();
  const started = deferred<AbortSignal>();
  const write: SidebarFilterMutator = async (_group, _mode, _ids, signal) => {
    started.resolve(signal);
    return gate.promise;
  };
  const { owner, wire, preferences } = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    write,
  );
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const change = preferences.setFilter("channels", "unreads", ["work"]);
    const rejection = expect(change).rejects.toThrow("unavailable");
    const signal = await started.promise;
    await owner.clearCache();
    expect(signal.aborted).toBe(true);
    gate.resolve({ filters: { channels: "unreads" }, activeWindowSeconds: {} });
    await rejection;
    expect(preferences.snapshot().data).toBeUndefined();
  } finally {
    gate.resolve({ filters: {}, activeWindowSeconds: {} });
    owner.dispose();
  }
});

it("coalesces hints and owes a fresh trailing read after an initial or active read", async () => {
  const initial = deferred<SidebarPreferences>();
  const first = deferred<SidebarPreferences>();
  const second = deferred<SidebarPreferences>();
  const started = deferred<void>();
  const trailing = deferred<void>();
  const read = vi.fn(() => initial.promise);
  const strong = vi
    .fn()
    .mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    })
    .mockImplementationOnce(() => {
      trailing.resolve();
      return second.promise;
    });
  const store = createSidebarPreferencesStore({
    read,
    readAfterWrite: strong,
    available: true,
  });
  try {
    const loading = store.queries.ensure();
    await Promise.resolve(); // the initial read has started
    expect(read).toHaveBeenCalledOnce();
    store.invalidate();
    store.invalidate();
    initial.resolve(data);
    await started.promise;
    store.invalidate(); // newer change while the strong read is in flight
    first.resolve({ ...data, assignments: {} });
    await trailing.promise;
    second.resolve(data);
    await loading;
    expect(strong).toHaveBeenCalledTimes(2);
    expect(store.queries.snapshot()).toEqual({ status: "ready", data });
  } finally {
    initial.resolve(data);
    first.resolve(data);
    second.resolve(data);
    store.dispose();
  }
});

it("waits for local moves and reconciles hints without losing other preference families", async () => {
  const write = deferred<Awaited<ReturnType<SidebarAssignmentMutator>>>();
  const started = deferred<void>();
  const fresh = {
    ...data,
    assignments: { alpha: "work", gamma: "work" },
    muted: ["muted"],
    sort: { channels: "recent" as const },
  };
  const strong = vi.fn(async () => {
    started.resolve();
    return fresh;
  });
  const store = createSidebarPreferencesStore({
    read: async () => data,
    readAfterWrite: strong,
    available: true,
    write: () => write.promise,
    writeStar: async () => data.starred,
  });
  try {
    await store.queries.ensure();
    const move = store.queries.assign("gamma", "work");
    store.invalidate();
    store.invalidate();
    await Promise.resolve();
    expect(store.queries.snapshot().data?.assignments.gamma).toBe("work");
    expect(strong).not.toHaveBeenCalled();
    write.resolve({ sections: data.sections, assignments: fresh.assignments });
    await move;
    await started.promise;
    await store.queries.ensure();
    expect(strong).toHaveBeenCalledOnce();
    expect(store.queries.snapshot().data).toEqual(fresh);
  } finally {
    write.resolve(data);
    store.dispose();
  }
});

it("does not consume an invalidation when a local write discards its read", async () => {
  const first = deferred<SidebarPreferences>();
  const started = deferred<void>();
  const trailing = deferred<void>();
  const fresh = { ...data, muted: ["gamma"] };
  const strong = vi
    .fn()
    .mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    })
    .mockImplementationOnce(async () => {
      trailing.resolve();
      return fresh;
    });
  const store = createSidebarPreferencesStore({
    read: async () => data,
    readAfterWrite: strong,
    available: true,
    writeMute: async () => fresh.muted,
  });
  try {
    await store.queries.ensure();
    store.invalidate();
    await started.promise;
    await store.queries.setMute("gamma", true);
    first.resolve(data);
    await trailing.promise;
    await store.queries.ensure();
    expect(store.queries.snapshot().data).toEqual(fresh);
    expect(strong).toHaveBeenCalledTimes(2);
  } finally {
    first.resolve(data);
    store.dispose();
  }
});

it("retains failed invalidations for recovery without an immediate retry loop", async () => {
  const strong = vi
    .fn(async () => data)
    .mockRejectedValueOnce(new Error("offline"));
  const store = createSidebarPreferencesStore({
    read: async () => data,
    readAfterWrite: strong,
    available: true,
  });
  try {
    await store.queries.ensure();
    store.invalidate();
    await Promise.resolve();
    await store.queries.ensure();
    expect(store.queries.snapshot()).toMatchObject({
      status: "error",
      data,
      error: "offline",
    });
    expect(strong).toHaveBeenCalledOnce();
    store.reconnect(true);
    await Promise.resolve();
    await store.queries.ensure();
    expect(strong).toHaveBeenCalledTimes(2);
    expect(store.queries.snapshot()).toEqual({ status: "ready", data });
  } finally {
    store.dispose();
  }
});

it.each(["clear", "dispose"] as const)(
  "fences queued hint reads on %s",
  async (action) => {
    const strong = vi.fn(async () => data);
    const store = createSidebarPreferencesStore({
      read: async () => data,
      readAfterWrite: strong,
      available: true,
    });
    try {
      store.invalidate();
      store[action]();
      await Promise.resolve();
      expect(strong).not.toHaveBeenCalled();
      expect(store.queries.snapshot()).toEqual({ status: "idle" });
    } finally {
      store.dispose();
    }
  },
);

it.each(["clear", "dispose"] as const)(
  "fences in-flight hint reads on %s",
  async (action) => {
    const pending = deferred<SidebarPreferences>();
    const started = deferred<void>();
    let signal: AbortSignal | undefined;
    const store = createSidebarPreferencesStore({
      available: true,
      read: async () => data,
      readAfterWrite: async (activeSignal) => {
        signal = activeSignal;
        started.resolve();
        return pending.promise;
      },
    });
    try {
      await store.queries.ensure();
      store.invalidate();
      await started.promise;
      const active = store.queries.ensure();
      store[action]();
      expect(signal?.aborted).toBe(true);
      pending.resolve(data);
      await active;
      expect(store.queries.snapshot()).toEqual({ status: "idle" });
    } finally {
      pending.resolve(data);
      store.dispose();
    }
  },
);

it("keeps mounted data and controls usable during a live reconciliation", async () => {
  const pending = deferred<SidebarPreferences>();
  const started = deferred<void>();
  const store = createSidebarPreferencesStore({
    available: true,
    read: async () => data,
    readAfterWrite: async () => {
      started.resolve();
      return pending.promise;
    },
    write: async () => data,
    writeStar: async () => data.starred,
  });
  try {
    await store.queries.ensure();
    const before = store.queries.snapshot();
    store.invalidate();
    await started.promise;
    expect(store.queries.snapshot()).toBe(before);
    expect(store.queries.writable).toBe(true);
    pending.resolve(data);
    await store.queries.ensure();
  } finally {
    pending.resolve(data);
    store.dispose();
  }
});

it("keeps a newer hint owed when an older read fails", async () => {
  const initial = deferred<SidebarPreferences>();
  const started = deferred<void>();
  const strong = vi.fn(async () => {
    started.resolve();
    return data;
  });
  const store = createSidebarPreferencesStore({
    available: true,
    read: () => initial.promise,
    readAfterWrite: strong,
  });
  try {
    const loading = store.queries.ensure();
    await Promise.resolve();
    store.invalidate();
    initial.reject(new Error("obsolete read failed"));
    await started.promise;
    await loading;
    expect(strong).toHaveBeenCalledOnce();
    expect(store.queries.snapshot()).toEqual({ status: "ready", data });
  } finally {
    initial.resolve(data);
    store.dispose();
  }
});

it.each(["success", "failure"] as const)(
  "settles a manual refresh after read %s when a concurrent rename fails",
  async (outcome) => {
    const pending = deferred<SidebarPreferences>();
    const readStarted = deferred<void>();
    const rename = deferred<SidebarPreferences>();
    const renameStarted = deferred<void>();
    const read = vi
      .fn(async () => data)
      .mockImplementationOnce(async () => data)
      .mockImplementationOnce(() => {
        readStarted.resolve();
        return pending.promise;
      });
    const store = createSidebarPreferencesStore({
      available: true,
      read,
      renameSection: () => {
        renameStarted.resolve();
        return rename.promise;
      },
    });
    try {
      await store.queries.ensure();
      const refresh = store.queries.refresh();
      await readStarted.promise;
      expect(store.queries.snapshot().status).toBe("loading");
      const failedRename = expect(
        store.queries.renameSection("work", "Renamed"),
      ).rejects.toThrow("rename rejected");
      await renameStarted.promise;
      if (outcome === "success") pending.resolve(data);
      else pending.reject(new Error("read rejected"));
      await refresh;
      rename.reject(new Error("rename rejected"));
      await failedRename;
      expect(store.queries.snapshot()).toMatchObject({
        status: outcome === "success" ? "ready" : "error",
        data,
        ...(outcome === "failure" ? { error: "read rejected" } : {}),
      });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve(data);
      rename.resolve(data);
      store.dispose();
    }
  },
);

it("shows loading for an explicit retry while a live reconciliation remains owed", async () => {
  const pending = deferred<SidebarPreferences>();
  const started = deferred<void>();
  const strong = vi
    .fn(async () => data)
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
  const store = createSidebarPreferencesStore({
    available: true,
    read: async () => data,
    readAfterWrite: strong,
  });
  try {
    await store.queries.ensure();
    store.invalidate();
    await Promise.resolve();
    await store.queries.ensure();
    expect(store.queries.snapshot().status).toBe("error");
    const retry = store.queries.refresh();
    await started.promise;
    expect(store.queries.snapshot()).toMatchObject({ status: "loading", data });
    pending.resolve(data);
    await retry;
    expect(store.queries.snapshot()).toEqual({ status: "ready", data });
    expect(strong).toHaveBeenCalledTimes(2);
  } finally {
    pending.resolve(data);
    store.dispose();
  }
});

it("keeps authoritative reconciliation behind an admitted rename", async () => {
  const rename = deferred<SidebarPreferences>();
  const renameStarted = deferred<void>();
  const first = deferred<SidebarPreferences>();
  const readStarted = deferred<void>();
  const renamed: SidebarPreferences = {
    ...data,
    sections: [{ id: "work", name: "Renamed", order: 0 }],
  };
  const strong = vi
    .fn(async () => renamed)
    .mockImplementationOnce(() => {
      readStarted.resolve();
      return first.promise;
    });
  const store = createSidebarPreferencesStore({
    available: true,
    read: async () => data,
    readAfterWrite: strong,
    renameSection: () => {
      renameStarted.resolve();
      return rename.promise;
    },
  });
  try {
    await store.queries.ensure();
    store.invalidate();
    await readStarted.promise;
    const write = store.queries.renameSection("work", "Renamed");
    await renameStarted.promise;
    first.resolve(data);
    // Let the stale read finish while the admitted write is still held.
    await Promise.resolve();
    expect(strong).toHaveBeenCalledOnce();
    rename.resolve(renamed);
    await write;
    await store.queries.ensure();
    expect(strong).toHaveBeenCalledTimes(2);
    expect(store.queries.snapshot()).toEqual({
      status: "ready",
      data: renamed,
    });
  } finally {
    first.resolve(data);
    rename.resolve(renamed);
    store.dispose();
  }
});
