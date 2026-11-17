import { assert, expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarAssignmentIntent,
  SidebarMuteMutator,
  SidebarPreferences,
  SidebarSortMutator,
} from "./sidebar-preferences";
import { flush } from "./testing";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup() {
  let data: SidebarPreferences = {
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { alpha: "work", beta: "work" },
    starred: ["alpha"],
    muted: [],
  };
  const read = vi.fn(async () => data);
  const readAfterWrite = vi.fn(async () => data);
  const assignment = vi.fn(async (intent: SidebarAssignmentIntent) => {
    const id = intent.createSection?.id ?? intent.sectionId;
    const assignments = { ...data.assignments };
    if (intent.channelId !== undefined) {
      if (id) assignments[intent.channelId] = id;
      else delete assignments[intent.channelId];
    }
    const sections =
      intent.createSection &&
      !data.sections.some(({ id }) => id === intent.createSection?.id)
        ? intent.createSection.position === "first"
          ? [
              {
                id: intent.createSection.id,
                name: intent.createSection.name,
                ...(intent.createSection.icon
                  ? { icon: intent.createSection.icon }
                  : {}),
                order: -1,
              },
              ...data.sections,
            ]
          : [...data.sections, { ...intent.createSection, order: 2 }]
        : data.sections;
    data = { ...data, sections, assignments };
    return { sections, assignments };
  });
  const star = vi.fn(
    async (intent: { channelId: string; starred: boolean }) => {
      const stars = new Set(data.starred);
      if (intent.starred) stars.add(intent.channelId);
      else stars.delete(intent.channelId);
      data = { ...data, starred: [...stars] };
      return data.starred;
    },
  );
  const mute = vi.fn<SidebarMuteMutator>(async ({ channelId, muted }) => {
    const mutes = new Set(data.muted);
    if (muted) mutes.add(channelId);
    else mutes.delete(channelId);
    data = { ...data, muted: [...mutes] };
    return data.muted;
  });
  const sort = vi.fn<SidebarSortMutator>(async (group, mode) => {
    const next = { ...data.sort };
    if (mode === "alpha") delete next[group];
    else next[group] = mode;
    data = { ...data, sort: next };
    return next;
  });
  const owner = createSidebarPreferencesStore({
    read,
    readAfterWrite,
    available: true,
    write: assignment,
    writeStar: star,
    writeMute: mute,
    writeSort: sort,
  });
  await owner.queries.ensure();
  return {
    owner,
    prefs: owner.queries,
    assignment,
    star,
    read,
    readAfterWrite,
    mute,
    sort,
  };
}

it("moves immediately, keeps later intent through older failure, and serializes both records", async () => {
  const h = await setup();
  const gate = deferred<readonly string[]>();
  h.star.mockImplementationOnce(() => gate.promise);
  try {
    const first = h.prefs.assign("alpha", "later");
    const failed = expect(first).rejects.toThrow("offline");
    expect(h.prefs.snapshot().data?.assignments.alpha).toBe("later");
    expect(h.prefs.snapshot().data?.starred).toEqual([]);
    await flush(); // assignment confirmed, Star clear held
    expect(h.assignment).toHaveBeenCalledOnce();
    const second = h.prefs.setStar("alpha", true);
    const other = h.prefs.assign("beta", "later");
    expect(h.prefs.snapshot().data).toMatchObject({
      assignments: { alpha: "later", beta: "later" },
      starred: ["alpha"],
    });
    gate.reject(new Error("offline"));
    await failed;
    await Promise.all([second, other]);
    expect(h.prefs.snapshot().moves).toBeUndefined(); // stale failure offers no stale retry
    expect(h.prefs.snapshot().data).toMatchObject({
      assignments: { beta: "later" },
      starred: ["alpha"],
    });
  } finally {
    gate.resolve([]);
    h.owner.dispose();
  }
});

it("failure rolls back just its channel, persists a retry across refresh, and clears retry after success", async () => {
  const h = await setup();
  h.star.mockRejectedValueOnce(new Error("offline"));
  try {
    const first = h.prefs.assign("alpha", "later");
    const failed = expect(first).rejects.toThrow("offline");
    const other = h.prefs.assign("beta", "later");
    await failed;
    await other;
    expect(h.prefs.snapshot().data?.starred).toEqual(["alpha"]);
    expect(h.prefs.snapshot().data?.assignments.beta).toBe("later");
    expect(h.prefs.snapshot().moves).toEqual([
      expect.objectContaining({
        channelId: "alpha",
        pending: false,
        error: "offline",
      }),
    ]);
    await h.prefs.refresh();
    expect(h.prefs.snapshot().moves).toHaveLength(1);
    const retry = h.prefs.retryMove("alpha");
    expect(h.prefs.snapshot().data?.starred).toEqual([]);
    expect(h.prefs.snapshot().moves?.[0]?.pending).toBe(true);
    await retry;
    expect(h.prefs.snapshot().moves).toBeUndefined();
    expect(h.prefs.snapshot().data?.assignments).toEqual({
      alpha: "later",
      beta: "later",
    });
  } finally {
    h.owner.dispose();
  }
});

it.each([undefined, "first"] as const)(
  "create-and-move at %s appears before the first write, rolls back on failure, and reuses its ID on retry",
  async (position) => {
    const h = await setup();
    const gate = deferred<{
      sections: SidebarPreferences["sections"];
      assignments: SidebarPreferences["assignments"];
    }>();
    h.assignment.mockImplementationOnce(() => gate.promise);
    const section = {
      id: "12345678-1234-1234-1234-123456789abc",
      name: "Launch",
      icon: "📚",
      ...(position ? { position } : {}),
    };
    try {
      const creating = h.prefs.createAndAssign("alpha", section);
      const failed = expect(creating).rejects.toThrow("offline");
      expect(h.prefs.snapshot().data?.sections.at(position ? 0 : -1)?.id).toBe(
        section.id,
      );
      expect(h.prefs.snapshot().data?.assignments.alpha).toBe(section.id);
      expect(
        h.prefs.snapshot().data?.sections.at(position ? 0 : -1),
      ).toMatchObject({
        id: section.id,
        name: section.name,
        icon: section.icon,
      });
      expect(h.prefs.snapshot().data?.starred).toEqual([]);
      await flush();
      gate.reject(new Error("offline"));
      await failed;
      expect(h.prefs.snapshot().data?.sections).toHaveLength(2);
      expect(h.prefs.snapshot().data?.starred).toEqual(["alpha"]);
      await h.prefs.retryMove("alpha");
      expect(
        h.assignment.mock.calls.map(([intent]) => intent.createSection?.id),
      ).toEqual([section.id, section.id]);
      expect(h.prefs.snapshot().data?.sections).toHaveLength(3);
      expect(h.prefs.snapshot().data?.sections.at(position ? 0 : -1)?.id).toBe(
        section.id,
      );
    } finally {
      h.owner.dispose();
    }
  },
);

it.each(["clear", "dispose"] as const)(
  "%s clears optimistic placement/errors and rejects late repopulation",
  async (action) => {
    const h = await setup();
    const gate = deferred<readonly string[]>();
    h.star.mockImplementationOnce(() => gate.promise);
    const moving = h.prefs.assign("alpha", "later");
    const failed = expect(moving).rejects.toThrow("unavailable");
    await flush();
    h.owner[action]();
    gate.resolve([]);
    await failed;
    expect(h.prefs.snapshot().data).toBeUndefined();
    expect(h.prefs.snapshot().moves).toBeUndefined();
    h.owner.dispose();
  },
);

it.each(["success", "failure"])(
  "Mute confirmation preserves a queued optimistic Move through %s",
  async (outcome) => {
    const h = await setup();
    const muteGate = deferred<readonly string[]>();
    const muteStarted = deferred<void>();
    const moveGate = deferred<Awaited<ReturnType<typeof h.assignment>>>();
    const moveStarted = deferred<void>();
    h.mute.mockImplementationOnce(async () => {
      muteStarted.resolve();
      return muteGate.promise;
    });
    h.assignment.mockImplementationOnce(async () => {
      moveStarted.resolve();
      return moveGate.promise;
    });
    const before = h.prefs.snapshot().data;
    if (!before) throw new Error("Initial preferences missing");
    try {
      const muting = h.prefs.setMute("alpha", true);
      await muteStarted.promise;
      const moving = h.prefs.assign("alpha", "later");
      const result = Promise.allSettled([moving]);
      expect(h.assignment).not.toHaveBeenCalled();
      expect(h.prefs.snapshot().data).toMatchObject({
        assignments: { alpha: "later" },
        starred: [],
        muted: [],
      });
      muteGate.resolve(["alpha"]);
      await muting;
      await moveStarted.promise;
      expect(h.prefs.snapshot().data).toMatchObject({
        assignments: { alpha: "later" },
        starred: [],
        muted: ["alpha"],
      });
      expect(Object.isFrozen(h.prefs.snapshot().data?.muted)).toBe(true);
      if (outcome === "success")
        moveGate.resolve({
          sections: before.sections,
          assignments: { ...before.assignments, alpha: "later" },
        });
      else moveGate.reject(new Error("move rejected"));
      expect((await result)[0]?.status).toBe(
        outcome === "success" ? "fulfilled" : "rejected",
      );
      expect(h.prefs.snapshot().data).toEqual({
        ...before,
        assignments:
          outcome === "success"
            ? { ...before.assignments, alpha: "later" }
            : before.assignments,
        starred: outcome === "success" ? [] : before.starred,
        muted: ["alpha"],
      });
    } finally {
      muteGate.resolve([]);
      moveGate.resolve({
        sections: before.sections,
        assignments: before.assignments,
      });
      h.owner.dispose();
    }
  },
);

it.each(["success", "failure"])(
  "Move %s cannot overwrite a later confirmed Mute",
  async (outcome) => {
    const h = await setup();
    const gate = deferred<readonly string[]>();
    const started = deferred<void>();
    h.star.mockImplementationOnce(async () => {
      started.resolve();
      return gate.promise;
    });
    const before = h.prefs.snapshot().data;
    if (!before) throw new Error("Initial preferences missing");
    try {
      const moving = h.prefs.assign("alpha", "later");
      const result = Promise.allSettled([moving]);
      await started.promise;
      const muting = h.prefs.setMute("beta", true);
      expect(h.mute).not.toHaveBeenCalled();
      if (outcome === "success") gate.resolve([]);
      else gate.reject(new Error("star clear rejected"));
      await result;
      await muting;
      expect(h.prefs.snapshot().data).toEqual({
        ...before,
        assignments:
          outcome === "success"
            ? { ...before.assignments, alpha: "later" }
            : before.assignments,
        starred: outcome === "success" ? [] : before.starred,
        muted: ["beta"],
      });
    } finally {
      gate.resolve([]);
      h.owner.dispose();
    }
  },
);

it.each(["clear", "dispose", "cancel"] as const)(
  "%s fences an active Mute and queued Move together",
  async (action) => {
    const h = await setup();
    const gate = deferred<readonly string[]>();
    const started = deferred<AbortSignal>();
    const caller = new AbortController();
    h.mute.mockImplementationOnce(async (_intent, signal) => {
      started.resolve(signal);
      return gate.promise;
    });
    const before = h.prefs.snapshot().data;
    try {
      const muting = h.prefs.setMute("alpha", true, caller.signal);
      const signal = await started.promise;
      const moving = h.prefs.assign("alpha", "later", caller.signal);
      const result = Promise.allSettled([muting, moving]);
      if (action === "cancel") caller.abort();
      else h.owner[action]();
      expect(signal.aborted).toBe(true);
      gate.resolve(["alpha"]);
      expect((await result).map(({ status }) => status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(h.assignment).not.toHaveBeenCalled();
      expect(h.star).not.toHaveBeenCalled();
      expect(h.prefs.snapshot().data).toEqual(
        action === "cancel" ? before : undefined,
      );
      expect(h.prefs.snapshot().moves).toBeUndefined();
    } finally {
      gate.resolve([]);
      h.owner.dispose();
    }
  },
);

it.each([false, true])(
  "Mute preserves failed preference recovery without admitting Move (retry pending: %s)",
  async (retryPending) => {
    const h = await setup();
    const gate = deferred<SidebarPreferences>();
    const started = deferred<void>();
    const before = h.prefs.snapshot().data;
    if (!before) throw new Error("Initial preferences missing");
    try {
      h.read.mockRejectedValueOnce(new Error("preferences unavailable"));
      await h.prefs.refresh();
      let retry: Promise<void> | undefined;
      if (retryPending) {
        h.read.mockImplementationOnce(() => {
          started.resolve();
          return gate.promise;
        });
        retry = h.prefs.refresh();
        await started.promise;
      }
      await h.prefs.setMute("alpha", true);
      gate.resolve(before); // Pre-mute read must not overwrite confirmation.
      await retry;
      expect(h.prefs.snapshot()).toMatchObject({
        status: "error",
        error: "preferences unavailable",
        data: { muted: ["alpha"] },
      });
      expect(h.prefs.writable).toBe(false);
      await expect(h.prefs.assign("alpha", "later")).rejects.toThrow(
        "unavailable",
      );
      expect(h.assignment).not.toHaveBeenCalled();
      await h.prefs.refresh();
      expect(h.prefs.snapshot()).toMatchObject({
        status: "ready",
        data: { muted: ["alpha"] },
      });
      expect(h.prefs.writable).toBe(true);
      await h.prefs.assign("alpha", "later");
      expect(h.prefs.snapshot().data).toMatchObject({
        assignments: { alpha: "later" },
        muted: ["alpha"],
      });
    } finally {
      gate.resolve(before);
      h.owner.dispose();
    }
  },
);

// Exercise the shared owner, not separate mock projections: both optimistic
// families must survive each other's confirmation and rollback in either order.
it.each([
  ["move-first", "success"],
  ["move-first", "move-fails"],
  ["move-first", "sort-fails"],
  ["sort-first", "success"],
  ["sort-first", "move-fails"],
  ["sort-first", "sort-fails"],
] as const)(
  "%s preserves unrelated intent through %s",
  async (order, outcome) => {
    const h = await setup();
    const moveGate = deferred<readonly string[]>();
    const sortGate = deferred<Awaited<ReturnType<SidebarSortMutator>>>();
    const moveStarted = deferred<void>();
    const sortStarted = deferred<void>();
    h.star.mockImplementationOnce(() => {
      moveStarted.resolve();
      return moveGate.promise;
    });
    h.sort.mockImplementationOnce(() => {
      sortStarted.resolve();
      return sortGate.promise;
    });
    try {
      const move = () => h.prefs.assign("alpha", "later");
      const sort = () =>
        h.prefs.setSort("channels", "recent", ["work", "later"]);
      const first = order === "move-first" ? move() : sort();
      const firstResult = Promise.allSettled([first]);
      await (order === "move-first" ? moveStarted : sortStarted).promise;
      const second = order === "move-first" ? sort() : move();
      const secondResult = Promise.allSettled([second]);
      expect(
        order === "move-first" ? h.sort : h.assignment,
      ).not.toHaveBeenCalled();
      expect(h.prefs.snapshot().data).toMatchObject({
        assignments: { alpha: "later" },
        starred: [],
        sort: { channels: "recent" },
        muted: [],
      });
      const finishMove = () =>
        outcome === "move-fails"
          ? moveGate.reject(new Error("move failed"))
          : moveGate.resolve([]);
      const finishSort = () =>
        outcome === "sort-fails"
          ? sortGate.reject(new Error("sort failed"))
          : sortGate.resolve({ channels: "recent" });
      if (order === "move-first") {
        finishMove();
        await firstResult;
        await sortStarted.promise;
        expect(h.prefs.snapshot().data?.sort).toEqual({ channels: "recent" });
        finishSort();
      } else {
        finishSort();
        await firstResult;
        await moveStarted.promise;
        expect(h.prefs.snapshot().data?.assignments.alpha).toBe("later");
        expect(h.prefs.snapshot().data?.starred).toEqual([]);
        finishMove();
      }
      const results = [...(await firstResult), ...(await secondResult)];
      expect(
        results.filter(({ status }) => status === "rejected"),
      ).toHaveLength(outcome === "success" ? 0 : 1);
      await h.prefs.setMute("beta", true);
      expect(h.prefs.snapshot().data).toMatchObject({
        assignments: { alpha: outcome === "move-fails" ? "work" : "later" },
        starred: outcome === "move-fails" ? ["alpha"] : [],
        sort: outcome === "sort-fails" ? {} : { channels: "recent" },
        muted: ["beta"],
      });
      expect(h.prefs.snapshot().moves?.[0]?.error).toBe(
        outcome === "move-fails" ? "move failed" : undefined,
      );
      expect(h.prefs.snapshot().sortErrors?.[0]?.error).toBe(
        outcome === "sort-fails" ? "sort failed" : undefined,
      );
    } finally {
      moveGate.resolve([]);
      sortGate.resolve({});
      h.owner.dispose();
    }
  },
);

it.each(["clear", "dispose", "cancel"] as const)(
  "%s fences an active sort, queued move and deferred catalog refresh",
  async (action) => {
    const h = await setup();
    const gate = deferred<Awaited<ReturnType<SidebarSortMutator>>>();
    const started = deferred<AbortSignal>();
    const caller = new AbortController();
    h.sort.mockImplementationOnce((_group, _mode, _ids, signal) => {
      started.resolve(signal);
      return gate.promise;
    });
    const before = h.prefs.snapshot().data;
    try {
      const sorting = h.prefs.setSort("channels", "recent", [], caller.signal);
      const signal = await started.promise;
      const moving = h.prefs.assign("alpha", "later", caller.signal);
      const results = Promise.allSettled([sorting, moving]);
      const refresh = h.prefs.refresh();
      if (action === "cancel") caller.abort();
      else h.owner[action]();
      expect(signal.aborted).toBe(true);
      gate.resolve({ channels: "recent" });
      expect((await results).map(({ status }) => status)).toEqual([
        "rejected",
        "rejected",
      ]);
      await refresh;
      expect(h.assignment).not.toHaveBeenCalled();
      expect(h.star).not.toHaveBeenCalled();
      expect(h.read).toHaveBeenCalledTimes(action === "cancel" ? 2 : 1);
      expect(h.prefs.snapshot().data).toEqual(
        action === "cancel" ? before : undefined,
      );
      expect(h.prefs.snapshot().moves).toBeUndefined();
      expect(h.prefs.snapshot().sortErrors).toBeUndefined();
    } finally {
      gate.resolve({});
      h.owner.dispose();
    }
  },
);

it.each([false, true])(
  "Sort preserves failed full-read recovery (retry pending: %s)",
  async (retryPending) => {
    const h = await setup();
    const gate = deferred<SidebarPreferences>();
    const started = deferred<void>();
    const before = h.prefs.snapshot().data;
    if (!before) throw new Error("Initial preferences missing");
    try {
      h.read.mockRejectedValueOnce(new Error("preferences unavailable"));
      await h.prefs.refresh();
      let retry: Promise<void> | undefined;
      if (retryPending) {
        h.read.mockImplementationOnce(() => {
          started.resolve();
          return gate.promise;
        });
        retry = h.prefs.refresh();
        await started.promise;
      }
      await h.prefs.setSort("channels", "recent", []);
      gate.resolve(before);
      await retry;
      expect(h.prefs.snapshot()).toMatchObject({
        status: "error",
        error: "preferences unavailable",
        data: { sort: { channels: "recent" } },
      });
      expect(h.prefs.writable).toBe(false);
      await expect(h.prefs.assign("alpha", "later")).rejects.toThrow(
        "unavailable",
      );
      await h.prefs.refresh();
      expect(h.prefs.snapshot().status).toBe("ready");
      expect(h.prefs.writable).toBe(true);
      expect(h.prefs.snapshot().data?.sort).toEqual({ channels: "recent" });
    } finally {
      gate.resolve(before);
      h.owner.dispose();
    }
  },
);

it("creates an empty section through the queued writer without altering stars or assignments", async () => {
  const h = await setup();
  const section = {
    id: "12345678-1234-1234-1234-123456789abc",
    name: "Launch",
    icon: ":launch:",
  };
  try {
    expect(h.prefs.sectionCreationWritable).toBe(true);
    await h.prefs.createSection(section);
    expect(h.assignment).toHaveBeenCalledWith(
      { createSection: section },
      expect.any(AbortSignal),
    );
    expect(h.prefs.snapshot().data).toMatchObject({
      assignments: { alpha: "work", beta: "work" },
      starred: ["alpha"],
    });
    expect(h.prefs.snapshot().data?.sections.at(-1)).toMatchObject(section);
    expect(h.star).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
});

it("refreshes an accepted creation before reporting a lost response, superseding an older read", async () => {
  const h = await setup();
  const before = h.prefs.snapshot().data;
  assert(before);
  const stale = deferred<SidebarPreferences>();
  const save = h.assignment.getMockImplementation();
  assert(save);
  h.assignment.mockImplementationOnce(async (intent) => {
    await save(intent);
    throw new Error("response lost");
  });
  h.read.mockImplementationOnce(() => stale.promise);
  const oldRefresh = h.prefs.refresh();
  const section = { id: "accepted", name: "Launch", icon: "📚" };
  try {
    await expect(h.prefs.createSection(section)).rejects.toThrow(
      "response lost",
    );
    expect(h.prefs.snapshot().data?.sections.at(-1)).toMatchObject(section);
    expect(h.assignment).toHaveBeenCalledOnce(); // Recovery never replays a write.
    expect(h.prefs.sectionCreationWritable).toBe(true);
    stale.resolve(before);
    await oldRefresh;
    expect(h.prefs.snapshot().data?.sections.at(-1)).toMatchObject(section);
  } finally {
    stale.resolve(before);
    h.owner.dispose();
  }
});

it.each([{ name: "Renamed", icon: "📚" }, { name: "Launch" }])(
  "reconciles changed creation state after a lost response: %j",
  async (remote) => {
    const h = await setup();
    const save = h.assignment.getMockImplementation();
    assert(save);
    h.assignment.mockImplementationOnce(async (intent) => {
      await save(intent);
      throw new Error("response lost");
    });
    const section = { id: "accepted", name: "Launch", icon: "📚" };
    h.readAfterWrite.mockImplementation(async () => {
      const current = await h.read();
      const recovered = {
        ...current,
        sections: current.sections.map((entry) =>
          entry.id === section.id
            ? { id: entry.id, order: entry.order, ...remote }
            : entry,
        ),
      };
      h.read.mockResolvedValue(recovered);
      return recovered;
    });
    try {
      // Recovering authoritative preferences is not confirmation of this intent.
      await expect(h.prefs.createSection(section)).rejects.toThrow(
        "response lost",
      );
      expect(h.prefs.snapshot()).toMatchObject({ status: "ready" });
      expect(h.prefs.snapshot().data?.sections.at(-1)).toEqual({
        id: section.id,
        order: 2,
        ...remote,
      });
      expect(h.prefs.writable).toBe(true);
      expect(h.prefs.sectionCreationWritable).toBe(true);
      await h.prefs.refresh();
      expect(h.prefs.snapshot()).toMatchObject({ status: "ready" });
      expect(h.prefs.snapshot().data?.sections.at(-1)).toEqual({
        id: section.id,
        order: 2,
        ...remote,
      });
      expect(h.assignment).toHaveBeenCalledOnce(); // Never replay the stale creation.
    } finally {
      h.owner.dispose();
    }
  },
);

it.each([false, true])(
  "gates new creation until writer reconciliation succeeds (clear cache: %s)",
  async (clearCache) => {
    const h = await setup();
    const save = h.assignment.getMockImplementation();
    assert(save);
    h.assignment.mockImplementationOnce(async (intent) => {
      await save(intent);
      throw new Error("response lost");
    });
    h.readAfterWrite.mockRejectedValueOnce(new Error("read offline"));
    const section = { id: "accepted", name: "Launch" };
    try {
      await expect(h.prefs.createSection(section)).rejects.toThrow(
        "response lost",
      );
      expect(h.prefs.snapshot()).toMatchObject({
        status: "error",
        error: "read offline",
      });
      expect(h.prefs.sectionCreationWritable).toBe(false);
      await expect(
        h.prefs.createSection({ id: "duplicate", name: "Launch" }),
      ).rejects.toThrow("unavailable");
      expect(h.assignment).toHaveBeenCalledOnce();
      if (clearCache) h.owner.clear();
      await h.prefs.refresh();
      expect(h.prefs.sectionCreationWritable).toBe(true);
      expect(h.prefs.snapshot().data?.sections.at(-1)).toMatchObject(section);
      expect(h.readAfterWrite).toHaveBeenCalledTimes(2);
      expect(h.read).toHaveBeenCalledOnce();
    } finally {
      h.owner.dispose();
    }
  },
);

it.each(["clear", "dispose"] as const)(
  "fences creation reconciliation after %s",
  async (retire) => {
    const h = await setup();
    const read = deferred<SidebarPreferences>();
    const entered = deferred<void>();
    h.assignment.mockRejectedValueOnce(new Error("response lost"));
    h.readAfterWrite.mockImplementationOnce(() => {
      entered.resolve();
      return read.promise;
    });
    const result = expect(
      h.prefs.createSection({ id: "accepted", name: "Launch" }),
    ).rejects.toThrow("response lost");
    try {
      await entered.promise;
      h.owner[retire]();
      read.resolve({
        sections: [{ id: "accepted", name: "Launch", order: 2 }],
        assignments: {},
        starred: [],
        muted: [],
      });
      await result;
      expect(h.prefs.snapshot().data).toBeUndefined();
    } finally {
      read.resolve({ sections: [], assignments: {}, starred: [], muted: [] });
      h.owner.dispose();
    }
  },
);

it("reconciles a failed creation after a queued move without deadlocking or losing its result", async () => {
  const h = await setup();
  const save = h.assignment.getMockImplementation();
  assert(save);
  h.assignment.mockImplementationOnce(async (intent) => {
    await save(intent);
    throw new Error("response lost");
  });
  const section = { id: "accepted", name: "Launch" };
  try {
    const creating = expect(h.prefs.createSection(section)).rejects.toThrow(
      "response lost",
    );
    const moving = h.prefs.assign("beta", "later");
    await Promise.all([creating, moving]);
    expect(h.prefs.snapshot().data?.sections.at(-1)).toMatchObject(section);
    expect(h.prefs.snapshot().data?.assignments.beta).toBe("later");
    expect(h.assignment).toHaveBeenCalledTimes(2);
  } finally {
    h.owner.dispose();
  }
});

it("reconciles an accepted creation against the writer while ordinary reads lag", async () => {
  const h = await setup();
  const before = h.prefs.snapshot().data;
  assert(before);
  h.read.mockResolvedValue(before);
  const save = h.assignment.getMockImplementation();
  assert(save);
  h.assignment.mockImplementationOnce(async (intent) => {
    await save(intent);
    throw new Error("response lost");
  });
  const section = { id: "accepted", name: "Launch" };
  try {
    await expect(h.prefs.createSection(section)).rejects.toThrow(
      "response lost",
    );
    expect(h.prefs.snapshot().data?.sections.at(-1)).toMatchObject(section);
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.readAfterWrite).toHaveBeenCalledOnce();
    expect(h.assignment).toHaveBeenCalledOnce();
  } finally {
    h.owner.dispose();
  }
});

it("waits for a queued non-move write before reconciling an uncertain creation", async () => {
  const h = await setup();
  const mute = deferred<readonly string[]>();
  const started = deferred<void>();
  h.assignment.mockRejectedValueOnce(new Error("response lost"));
  h.mute.mockImplementationOnce(() => {
    started.resolve();
    return mute.promise;
  });
  const creating = expect(
    h.prefs.createSection({ id: "accepted", name: "Launch" }),
  ).rejects.toThrow("response lost");
  const muting = h.prefs.setMute("alpha", true);
  try {
    await started.promise;
    await flush();
    expect(h.readAfterWrite).not.toHaveBeenCalled();
    mute.resolve(["alpha"]);
    await Promise.all([creating, muting]);
    expect(h.readAfterWrite).toHaveBeenCalledOnce();
    expect(h.prefs.sectionCreationWritable).toBe(true);
  } finally {
    mute.resolve([]);
    await Promise.allSettled([creating, muting]);
    h.owner.dispose();
  }
});

it.each(["mute", "sort", "writer-failure"] as const)(
  "reconciles again when %s invalidates an in-flight writer read",
  async (kind) => {
    const h = await setup();
    const read = deferred<SidebarPreferences>();
    const entered = deferred<void>();
    const save = h.assignment.getMockImplementation();
    assert(save);
    const authoritative = h.readAfterWrite.getMockImplementation();
    assert(authoritative);
    h.assignment.mockImplementationOnce(async (intent) => {
      await save(intent);
      throw new Error("response lost");
    });
    let first!: SidebarPreferences;
    h.readAfterWrite.mockImplementationOnce(async () => {
      first = await authoritative();
      entered.resolve();
      return read.promise;
    });
    if (kind === "writer-failure")
      h.readAfterWrite.mockRejectedValueOnce(new Error("writer offline"));
    const section = { id: "accepted", name: "Launch" };
    const creating = expect(h.prefs.createSection(section)).rejects.toThrow(
      "response lost",
    );
    try {
      await entered.promise;
      if (kind === "sort")
        await h.prefs.setSort("channels", "recent", ["work", "later"]);
      else await h.prefs.setMute("alpha", true);
      read.resolve(first);
      await creating;
      expect(h.readAfterWrite).toHaveBeenCalledTimes(2);
      if (kind === "writer-failure") {
        expect(h.prefs.snapshot()).toMatchObject({
          status: "error",
          error: "writer offline",
        });
        expect(h.prefs.sectionCreationWritable).toBe(false);
        await h.prefs.refresh();
      }
      expect(h.prefs.snapshot().data?.sections.at(-1)).toMatchObject(section);
      expect(h.prefs.snapshot().data).toMatchObject(
        kind === "sort"
          ? { sort: { channels: "recent" } }
          : { muted: ["alpha"] },
      );
      expect(h.prefs.sectionCreationWritable).toBe(true);
      expect(h.assignment).toHaveBeenCalledOnce();
    } finally {
      read.resolve(first);
      await creating;
      h.owner.dispose();
    }
  },
);

it("gates create-and-move during reconciliation while allowing existing destinations", async () => {
  const h = await setup();
  const entered = deferred<void>();
  const read = deferred<SidebarPreferences>();
  const authoritative = h.readAfterWrite.getMockImplementation();
  assert(authoritative);
  h.assignment.mockRejectedValueOnce(new Error("response lost"));
  h.readAfterWrite.mockImplementationOnce(() => {
    entered.resolve();
    return read.promise;
  });
  const creating = expect(
    h.prefs.createSection({ id: "accepted", name: "Launch" }),
  ).rejects.toThrow("response lost");
  try {
    await entered.promise;
    expect(h.prefs.writable).toBe(true);
    await expect(
      h.prefs.createAndAssign("beta", { id: "duplicate", name: "Launch" }),
    ).rejects.toThrow("unavailable");
    expect(h.assignment).toHaveBeenCalledOnce();
    await h.prefs.assign("beta", "later");
    read.resolve(await authoritative());
    await creating;
    expect(h.prefs.snapshot().data?.assignments.beta).toBe("later");
    expect(h.prefs.sectionCreationWritable).toBe(true);
  } finally {
    read.resolve(await authoritative());
    await creating;
    h.owner.dispose();
  }
});
