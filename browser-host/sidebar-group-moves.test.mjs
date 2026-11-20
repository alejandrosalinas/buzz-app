import { expect, it, vi } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import { createSidebarPreferencesStore } from "../src/features/relay/sidebar-preferences-store.ts";
import { sidebarSections } from "../src/bundled/channels/sidebar-sections.ts";
import {
  decodeSidebarPreferences,
  mutateSidebarAssignment,
} from "./sidebar-preferences.mjs";
import { mutateSidebarStar } from "./sidebar-toggle.mjs";

async function setup({ cachedAssignment = true } = {}) {
  const secret = generateSecretKey();
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  const heads = new Map();
  for (const [coordinate, blob] of [
    [
      "channel-workspaces",
      {
        version: 1,
        sectionOrder: [],
        sections: [{ id: "work", name: "Work", order: 0 }],
        assignments: { alpha: "work", beta: "work" },
      },
    ],
    [
      "channel-stars",
      { version: 1, channels: { alpha: { starred: true, updatedAt: 1 } } },
    ],
  ])
    heads.set(
      coordinate,
      finalizeEvent(
        {
          kind: 30078,
          created_at: 1,
          tags: [["d", coordinate]],
          content: nip44.v2.encrypt(JSON.stringify(blob), key),
        },
        secret,
      ),
    );
  key.fill(0);
  const read = vi.fn(async () =>
    decodeSidebarPreferences([...heads.values()], secret),
  );
  if (!cachedAssignment)
    read.mockResolvedValueOnce({
      ...(await read()),
      assignments: { beta: "work" },
    });
  const publications = [];
  const publish = vi.fn(async (event) => {
    const coordinate = event.tags.find(([tag]) => tag === "d")[1];
    heads.set(coordinate, event);
    publications.push(coordinate);
  });
  const assignment = vi.fn((intent, signal) =>
    mutateSidebarAssignment(
      intent,
      secret,
      async () => {
        signal.throwIfAborted();
        return [heads.get("channel-workspaces")];
      },
      publish,
    ),
  );
  const star = vi.fn(async (intent, signal) => {
    const result = await mutateSidebarStar(
      intent,
      secret,
      async () => {
        signal.throwIfAborted();
        return [heads.get("channel-stars")];
      },
      publish,
    );
    return Object.entries(result.channels)
      .filter(([, value]) => value.starred)
      .map(([id]) => id);
  });
  const owner = createSidebarPreferencesStore({
    read,
    available: true,
    write: assignment,
    writeStar: star,
  });
  await owner.queries.ensure();
  return {
    owner,
    prefs: owner.queries,
    read,
    publish,
    publications,
    assignment,
    star,
  };
}

it.each([true, false])(
  "removal clears the durable previous group even when cached assignment is %s",
  async (cachedAssignment) => {
    const h = await setup({ cachedAssignment });
    try {
      await h.prefs.setStar("alpha", false);
      expect(h.publications).toEqual(["channel-workspaces", "channel-stars"]);
      const restored = await h.read();
      expect(restored.assignments).toEqual({ beta: "work" });
      expect(restored.starred).toEqual([]);
      expect(h.prefs.snapshot().data).toEqual(restored);
      expect(
        sidebarSections([{ id: "alpha", name: "Alpha" }], restored).map(
          ({ key }) => key,
        ),
      ).toEqual(["solo", "starred", "group:work", "channels", "dms"]);
    } finally {
      h.owner.dispose();
    }
  },
);

it("moves directly from Starred into a saved group and retains other assignments", async () => {
  const h = await setup();
  try {
    await h.prefs.assign("alpha", "work");
    const restored = await h.read();
    expect(restored.assignments).toEqual({ alpha: "work", beta: "work" });
    expect(restored.starred).toEqual([]);
    expect(
      sidebarSections([{ id: "alpha", name: "Alpha" }], restored).map(
        ({ key }) => key,
      ),
    ).toEqual(["solo", "starred", "group:work", "channels", "dms"]);
  } finally {
    h.owner.dispose();
  }
});

it("does not clear Star when assignment publication fails", async () => {
  const h = await setup();
  try {
    const before = h.prefs.snapshot();
    h.publish.mockRejectedValueOnce(new Error("assignment rejected"));
    await expect(h.prefs.setStar("alpha", false)).rejects.toThrow(
      "assignment rejected",
    );
    expect(h.star).not.toHaveBeenCalled();
    expect(h.prefs.snapshot().data).toEqual(before.data);
    expect(h.prefs.snapshot().moves).toEqual([
      expect.objectContaining({ pending: false, error: expect.any(String) }),
    ]);
    expect((await h.read()).starred).toEqual(["alpha"]);
    await h.prefs.setStar("alpha", false);
    expect((await h.read()).assignments).toEqual({ beta: "work" });
  } finally {
    h.owner.dispose();
  }
});

it("keeps Starred after a partial failure and retry cannot resurrect the old group", async () => {
  const h = await setup();
  try {
    const before = h.prefs.snapshot();
    h.star.mockRejectedValueOnce(new Error("star rejected"));
    await expect(h.prefs.setStar("alpha", false)).rejects.toThrow(
      "star rejected",
    );
    expect(h.prefs.snapshot().data).toEqual(before.data);
    expect(h.prefs.snapshot().moves).toEqual([
      expect.objectContaining({ pending: false, error: expect.any(String) }),
    ]);
    const partial = await h.read();
    expect(partial.assignments).toEqual({ beta: "work" });
    expect(partial.starred).toEqual(["alpha"]);
    await h.prefs.refresh();
    await h.prefs.setStar("alpha", false);
    expect(h.prefs.snapshot().data).toEqual({ ...partial, starred: [] });
    expect(h.publications).toEqual(["channel-workspaces", "channel-stars"]);
  } finally {
    h.owner.dispose();
  }
});

it("a refresh during the two-write move cannot expose the intermediate assignment", async () => {
  const h = await setup();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const star = h.star.getMockImplementation();
  h.star.mockImplementationOnce(async (...args) => {
    started();
    await held;
    return star(...args);
  });
  try {
    const before = h.prefs.snapshot();
    const pending = h.prefs.setStar("alpha", false);
    await entered;
    const optimistic = h.prefs.snapshot();
    expect(optimistic.data.assignments).toEqual({ beta: "work" });
    expect(optimistic.data.starred).toEqual([]);
    const refresh = h.prefs.refresh();
    expect(h.prefs.snapshot()).toBe(optimistic);
    expect(before.data.starred).toEqual(["alpha"]);
    expect(h.read).toHaveBeenCalledOnce();
    release();
    await Promise.all([pending, refresh]);
    expect(h.prefs.snapshot().data.assignments).toEqual({ beta: "work" });
    expect(h.prefs.snapshot().data.starred).toEqual([]);
  } finally {
    release();
    h.owner.dispose();
  }
});

it("failed move plus an older refresh cannot strand the preference status at loading", async () => {
  const h = await setup();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  try {
    const before = h.prefs.snapshot().data;
    h.read.mockImplementationOnce(async () => {
      started();
      return held;
    });
    const refresh = h.prefs.refresh();
    await entered;
    h.assignment.mockRejectedValueOnce(new Error("assignment failed"));
    await expect(h.prefs.setStar("alpha", false)).rejects.toThrow(
      "assignment failed",
    );
    release(before);
    await refresh;
    expect(h.prefs.snapshot()).toEqual({
      status: "ready",
      moves: [
        expect.objectContaining({ pending: false, error: "assignment failed" }),
      ],
      data: before,
    });
    await h.prefs.refresh();
    expect(h.prefs.snapshot().status).toBe("ready");
  } finally {
    release(h.prefs.snapshot().data);
    h.owner.dispose();
  }
});

it("cancellation between records prevents clearing Star and retry finishes from durable state", async () => {
  const h = await setup();
  const caller = new AbortController();
  const assign = h.assignment.getMockImplementation();
  h.assignment.mockImplementationOnce(async (...args) => {
    const result = await assign(...args);
    caller.abort();
    return result;
  });
  try {
    await expect(
      h.prefs.setStar("alpha", false, caller.signal),
    ).rejects.toThrow();
    expect(h.star).not.toHaveBeenCalled();
    expect((await h.read()).starred).toEqual(["alpha"]);
    await h.prefs.setStar("alpha", false);
    const restored = await h.read();
    expect(restored.assignments).toEqual({ beta: "work" });
    expect(restored.starred).toEqual([]);
  } finally {
    h.owner.dispose();
  }
});

it("create-and-move from Starred retries one durable section after partial failure", async () => {
  const h = await setup();
  const section = {
    id: "12345678-1234-1234-1234-123456789abc",
    name: "Launch",
  };
  try {
    const before = h.prefs.snapshot();
    h.star.mockRejectedValueOnce(new Error("star rejected"));
    await expect(h.prefs.createAndAssign("alpha", section)).rejects.toThrow(
      "star rejected",
    );
    expect(h.prefs.snapshot().data).toEqual(before.data);
    expect(h.prefs.snapshot().moves).toEqual([
      expect.objectContaining({ pending: false, error: expect.any(String) }),
    ]);
    expect(h.publications).toEqual(["channel-workspaces"]);
    await h.prefs.createAndAssign("alpha", section);
    expect(h.publications).toEqual(["channel-workspaces", "channel-stars"]);
    const restored = await h.read();
    expect(restored.sections).toHaveLength(2);
    expect(restored.assignments).toEqual({ alpha: section.id, beta: "work" });
    expect(restored.starred).toEqual([]);
    expect(h.prefs.snapshot().data).toEqual(restored);
  } finally {
    h.owner.dispose();
  }
});
