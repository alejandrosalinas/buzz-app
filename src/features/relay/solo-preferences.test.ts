import { createSoloPreferences } from "./solo-preferences";
import { TEAM_MANIFEST_TAG } from "../channel-templates/team-payload";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { createApiAdmission } from "./http-admission";
import {
  coordinate,
  KIT_TAG,
  ME_KIT_TAG,
  kitTag,
  kitRecordFits,
  parseKitRecord,
  type Groups,
  type KitRecord,
  type KitValue,
  type Template,
} from "../channel-templates/model";
import { projectTemplateId, templateEntry } from "../solo/workspace";
import { matchesEvent } from "./projection";
import { flush, keypair, roster, scriptedTransport, signed } from "./testing";
import type { ReadFilter, RelayEvent } from "./events";
import type { SidebarPreferences } from "./sidebar-preferences";

afterEach(() => vi.restoreAllMocks());

const channel = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const community = "https://primary.example";
const groups: Groups = {
  type: "groups",
  id: "me",
  groups: [{ id: "work", name: "Solo work", defaultTemplateId: "template" }],
  assignments: { [other]: "work" },
};
function fixture(lane?: ReturnType<typeof createApiAdmission>) {
  const viewer = keypair(),
    relay = keypair();
  let time = 1_700_000_000;
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  const events: RelayEvent[] = [];
  let legacy: SidebarPreferences = {
    sections: [{ id: "work", name: "OG work", icon: "★", order: 0 }],
    assignments: { [channel]: "work" },
    starred: [],
    muted: [],
  };
  const install = (value: KitValue, deleted = false, createdAt = time++) => {
    const record: KitRecord = { version: 1, community, deleted, value };
    events.push(
      signed(viewer, {
        kind: 30078,
        created_at: createdAt,
        tags: [
          ["d", coordinate(record)],
          ["t", kitTag(record)],
        ],
        content: JSON.stringify(record),
      }),
    );
  };
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
  const assignment = vi.fn(async (intent) => {
    const assignments = { ...legacy.assignments };
    if (intent.sectionId) assignments[intent.channelId] = intent.sectionId;
    else delete assignments[intent.channelId];
    legacy = { ...legacy, assignments };
    return legacy;
  });
  const removal = vi.fn(async (sectionId: string) => {
    legacy = {
      ...legacy,
      sections: legacy.sections.filter(({ id }) => id !== sectionId),
      assignments: Object.fromEntries(
        Object.entries(legacy.assignments).filter(([, id]) => id !== sectionId),
      ),
    };
    return legacy;
  });
  const star = vi.fn(async ({ channelId, starred }) => {
    legacy = { ...legacy, starred: starred ? [channelId] : [] };
    return legacy.starred;
  });
  const sort = vi.fn(async () => ({}));
  const publish = vi.fn(async (event: RelayEvent) => {
    events.push(event);
  });
  // `query` is the relay; an admission lane, when given, guards it.
  const admitted = vi.fn(
    (filters: readonly ReadFilter[], signal?: AbortSignal) =>
      lane ? lane.run(() => query(filters), signal) : query(filters),
  );
  const prepare = vi.fn(async (record: KitRecord, _signal: AbortSignal) =>
    JSON.stringify(record),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: community,
      media: () => undefined,
      query: admitted,
      decodeSidebarPreferences: async () => legacy,
      writeSidebarAssignment: assignment,
      removeSidebarSection: removal,
      writeSidebarStar: star,
      writeSidebarSort: sort,
      channelKit: {
        decode: async (rows) =>
          rows.map((event) => ({
            eventId: event.id,
            record: JSON.parse(event.content),
          })),
        prepare,
      },
      writer: {
        kinds: [30078],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  return {
    ...owner,
    query,
    admitted,
    assignment,
    removal,
    sort,
    star,
    publish,
    prepare,
    install,
    events,
    preferences: owner.session.sidebarPreferences,
  };
}

it("reorders Solo workspaces through the existing groups record and preserves fresh defaults and filing", async () => {
  const f = fixture();
  const solo = f.session.soloPreferences;
  const personal = { id: "personal", name: "Personal", defaultTemplateId: "p" };
  const added = {
    id: "added",
    name: "Added elsewhere",
    defaultTemplateId: "a",
  };
  try {
    f.install({ ...groups, groups: [...groups.groups, personal] });
    await solo.ensure();
    expect(solo.sectionOrderWritable).toBe(true);
    const fresh = {
      ...groups,
      groups: [
        { id: "work", defaultTemplateId: "template", name: "Updated work" },
        personal,
        added,
      ],
      assignments: { [channel]: "personal", [other]: "work" },
    };
    f.install(fresh);
    await solo.reorderSections("personal", ["personal", "gone", "work"]);
    const event = f.publish.mock.calls.at(-1)?.[0];
    expect(event).toBeDefined();
    const record = JSON.parse(event?.content ?? "null");
    expect(record.value).toEqual({
      ...fresh,
      groups: [personal, fresh.groups[0], added],
    });
    expect(solo.snapshot().data?.sections.map(({ id }) => id)).toEqual([
      "personal",
      "work",
      "added",
    ]);
    const writes = f.publish.mock.calls.length;
    await solo.reorderSections("personal", ["personal", "work", "added"]);
    expect(f.publish).toHaveBeenCalledTimes(writes);
    for (const write of [f.assignment, f.removal, f.sort, f.star])
      expect(write).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("rolls back a failed Solo workspace order and retries through the same store", async () => {
  const f = fixture();
  const solo = f.session.soloPreferences;
  try {
    f.install({
      ...groups,
      groups: [
        ...groups.groups,
        { id: "home", name: "Home", defaultTemplateId: "h" },
      ],
    });
    await solo.ensure();
    f.prepare.mockRejectedValueOnce(new Error("Order could not save"));
    const saving = solo.reorderSections("home", ["home", "work"]);
    expect(solo.snapshot().data?.sections[0]?.id).toBe("home");
    await expect(saving).rejects.toThrow("Order could not save");
    expect(solo.snapshot().data?.sections[0]?.id).toBe("work");
    const failed = solo.snapshot().orderError;
    if (!failed) throw new Error("Missing failed order");
    expect(failed.sectionIds).toEqual(["home", "work"]);
    await solo.reorderSections(failed.sectionId, failed.sectionIds);
    expect(solo.snapshot().orderError).toBeUndefined();
    expect(solo.snapshot().data?.sections[0]?.id).toBe("home");
  } finally {
    f.dispose();
  }
});

it("refuses workspace order writes without a fresh catalog and rejects duplicate ids", async () => {
  const f = fixture();
  const solo = f.session.soloPreferences;
  try {
    f.install(groups);
    await solo.ensure();
    await expect(
      solo.reorderSections("work", ["work", "work"]),
    ).rejects.toThrow("Invalid Solo workspace order");
    f.query.mockRejectedValueOnce(new Error("offline"));
    await expect(solo.reorderSections("work", ["work"])).rejects.toThrow(
      "offline",
    );
    expect(f.publish).not.toHaveBeenCalled();
    expect(solo.snapshot().data?.sections[0]?.id).toBe("work");
  } finally {
    f.dispose();
  }
});

const SAVE_SECOND = 1_900_000_000;
function fixedClockFixture() {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(Date.now).mockRestore();
  vi.setSystemTime(SAVE_SECOND * 1000 + 250);
  return f;
}

it("serializes rapid workspace creation, reorder and filing into distinct protocol seconds", async () => {
  const f = fixedClockFixture();
  const solo = f.session.soloPreferences;
  try {
    f.install(groups);
    await solo.ensure();
    await solo.createSection({ id: "home", name: "Home" });
    let settled = false;
    const saving = Promise.all([
      solo.reorderSections("home", ["home", "work"]),
      solo.assign(channel, "home"),
    ]).finally(() => {
      settled = true;
    });
    void saving.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(749);
    expect(f.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await saving;
    expect(f.publish.mock.calls.map(([event]) => event.created_at)).toEqual([
      SAVE_SECOND,
      SAVE_SECOND + 1,
      SAVE_SECOND + 2,
    ]);
    const saved = JSON.parse(
      f.publish.mock.calls.at(-1)?.[0].content ?? "null",
    ).value;
    expect(saved.groups.map(({ id }: { id: string }) => id)).toEqual([
      "home",
      "work",
    ]);
    expect(saved.assignments).toEqual({ [other]: "work", [channel]: "home" });
  } finally {
    f.dispose();
    vi.useRealTimers();
  }
});

it.each(["clearCache", "dispose"] as const)(
  "cancels a workspace timestamp wait on %s before publication",
  async (action) => {
    const f = fixedClockFixture();
    const solo = f.session.soloPreferences;
    try {
      f.install(groups);
      await solo.ensure();
      await solo.createSection({ id: "home", name: "Home" });
      const saving = solo.reorderSections("home", ["home", "work"]);
      const cancelled = expect(saving).rejects.toBeDefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(solo.snapshot().orderError).toBeUndefined();
      f[action]();
      await cancelled;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.publish).toHaveBeenCalledTimes(1);
      expect(f.prepare).toHaveBeenCalledTimes(1);
    } finally {
      f.dispose();
      vi.useRealTimers();
    }
  },
);

it("retains the kit revision check when another workspace head arrives during the wait", async () => {
  const f = fixedClockFixture();
  const solo = f.session.soloPreferences;
  try {
    f.install(groups);
    await solo.ensure();
    await solo.createSection({ id: "home", name: "Home" });
    const saving = solo.reorderSections("home", ["home", "work"]);
    const conflict = expect(saving).rejects.toThrow(
      "This saved recipe changed",
    );
    void conflict.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    f.install(
      {
        ...groups,
        groups: [
          ...groups.groups,
          { id: "home", name: "Changed elsewhere", defaultTemplateId: "" },
        ],
      },
      false,
      SAVE_SECOND + 1,
    );
    await vi.advanceTimersByTimeAsync(750);
    await conflict;
    expect(f.publish).toHaveBeenCalledTimes(1);
  } finally {
    f.dispose();
    vi.useRealTimers();
  }
});

it("leaves future-dated workspace heads subject to the kit timestamp refusal", async () => {
  const f = fixedClockFixture();
  try {
    f.install(
      {
        ...groups,
        groups: [
          ...groups.groups,
          { id: "home", name: "Home", defaultTemplateId: "" },
        ],
      },
      false,
      SAVE_SECOND + 10,
    );
    await f.session.soloPreferences.ensure();
    await expect(
      f.session.soloPreferences.reorderSections("home", ["home", "work"]),
    ).rejects.toThrow("Please wait a second");
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    f.dispose();
    vi.useRealTimers();
  }
});

it("retries a catalog read cancelled by initial roster authority", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    channelKit: { decode: async () => [], prepare: async () => "" },
  });
  try {
    const catalog = owner.session.channelKit.refresh();
    await flush();
    const interrupted = wire.next();
    expect(interrupted.filters[0]?.["#t"]).toEqual([
      KIT_TAG,
      TEAM_MANIFEST_TAG,
      ME_KIT_TAG,
    ]);
    owner.session.channels.ensureList();
    await flush();
    wire.next().respond([roster(relay, channel, [viewer.pubkey])]);
    await flush();
    expect(interrupted.signal?.aborted).toBe(true);
    const retry = wire.pending.find((entry) => entry.filters[0]?.["#t"]);
    expect(retry?.filters).toEqual(interrupted.filters);
    for (const entry of wire.pending.splice(0)) entry.respond([]);
    await catalog;
    expect(owner.session.channelKit.snapshot().status).toBe("ready");
  } finally {
    owner.dispose();
  }
});

it.each(["clearCache", "dispose"] as const)(
  "does not retry a catalog read cancelled by %s",
  async (action) => {
    const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      channelKit: { decode: async () => [], prepare: async () => "" },
    });
    try {
      const catalog = owner.session.channelKit.refresh();
      await flush();
      const interrupted = wire.next();
      owner[action]();
      await catalog;
      await flush();
      expect(interrupted.signal?.aborted).toBe(true);
      expect(wire.pending).toHaveLength(0);
    } finally {
      owner.dispose();
    }
  },
);

const catalog = (
  calls: readonly (readonly [readonly ReadFilter[], ...unknown[]])[],
) =>
  calls.filter(([filters]) =>
    filters.some((filter) => filter["#t"]?.includes(ME_KIT_TAG)),
  ).length;

it("reloads Solo workspaces by itself once a relay request pause ends", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  const f = fixture(lane);
  const catalogReads = () => catalog(f.query.mock.calls);
  try {
    f.install(groups);
    await f.session.soloPreferences.ensure();
    expect(catalogReads()).toBe(1);
    // Another read's quota 429 paused this account's relay requests while
    // the catalog revalidated, and a Solo read then found it failed.
    lane.pause(10_000);
    await f.session.channelKit.refresh();
    await f.session.soloPreferences.refresh();
    expect(f.session.soloPreferences.snapshot()).toMatchObject({
      status: "error",
      error: "Relay requests paused; retry in 10s",
      transient: true,
    });
    // Recovery's retries meet the pause locally; none reaches the relay.
    const attempts = catalog(f.admitted.mock.calls);
    await vi.advanceTimersByTimeAsync(9_999);
    // One shared attempt per recovery delay (1, 2 and 4 s), not a loop.
    expect(catalog(f.admitted.mock.calls)).toBe(attempts + 3);
    expect(catalogReads()).toBe(1);
    expect(f.session.soloPreferences.snapshot().status).toBe("error");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.session.soloPreferences.snapshot()).toMatchObject({
      status: "ready",
      data: { sections: [{ id: "work", name: "Solo work", order: 0 }] },
    });
    expect(catalogReads()).toBe(2);
  } finally {
    f.dispose();
    vi.useRealTimers();
  }
});

it("leaves a Solo read of a catalog that cannot load for a manual retry", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const catalogReads = () => catalog(f.query.mock.calls);
  try {
    f.install(groups);
    await f.session.soloPreferences.ensure();
    // Rereading a catalog over the read limit cannot fix it.
    f.events.push(...Array(500).fill(f.events.at(-1)));
    await f.session.channelKit.refresh();
    await f.session.soloPreferences.refresh();
    expect(f.session.soloPreferences.snapshot().status).toBe("error");
    expect(f.session.soloPreferences.snapshot().transient).toBeUndefined();
    const reads = catalogReads();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(catalogReads()).toBe(reads);
    f.events.splice(1);
    await f.session.soloPreferences.refresh();
    expect(f.session.soloPreferences.snapshot()).toMatchObject({
      status: "ready",
      data: { sections: [{ id: "work", name: "Solo work", order: 0 }] },
    });
    expect(catalogReads()).toBe(reads + 1);
  } finally {
    f.dispose();
    vi.useRealTimers();
  }
});

it("starts Solo preferences empty and changes only the distinct Solo catalog coordinate", async () => {
  const f = fixture();
  const controller = new AbortController();
  const solo = createSoloPreferences(f.session.channelKit, controller.signal);
  try {
    await solo.queries.ensure();
    expect(solo.queries.snapshot().data?.sections).toEqual([]);
    await solo.queries.createAndAssign(channel, {
      id: "work",
      name: "Solo work",
    });
    expect(solo.queries.snapshot().data?.assignments).toEqual({
      [channel]: "work",
    });
    expect(solo.queries.starWritable).toBe(false);
    const writes = f.publish.mock.calls.map(([event]) => event);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.tags).toContainEqual(["t", ME_KIT_TAG]);
    expect(
      writes[0] &&
        matchesEvent(writes[0], {
          "#t": [KIT_TAG, TEAM_MANIFEST_TAG],
          limit: 500,
        }),
    ).toBe(false);
    await f.preferences.ensure();
    expect(f.preferences.snapshot().data?.sections[0]?.name).toBe("OG work");
    await solo.queries.removeSection("work");
    expect(solo.queries.snapshot().data?.sections).toEqual([]);
    expect(f.star).not.toHaveBeenCalled();
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    solo.dispose();
    f.dispose();
  }
});

it("retains Solo tombstone revision and never creates over an unread catalog", async () => {
  const f = fixture();
  f.install({ type: "groups", id: "me", groups: [], assignments: {} }, true);
  const controller = new AbortController();
  const solo = createSoloPreferences(f.session.channelKit, controller.signal);
  try {
    await expect(
      solo.queries.createAndAssign(channel, { id: "new", name: "New" }),
    ).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    await solo.queries.ensure();
    await solo.queries.createAndAssign(channel, { id: "new", name: "New" });
    expect(solo.queries.snapshot().data?.sections[0]?.name).toBe("New");
  } finally {
    controller.abort();
    solo.dispose();
    f.dispose();
  }
});

it("invalidates the session-owned Solo projection on refreshed heads, including tombstones", async () => {
  const f = fixture();
  const solo = f.session.soloPreferences;
  const value: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Solo work", defaultTemplateId: "" }],
    assignments: { [channel]: "work" },
  };
  try {
    await solo.ensure();
    await f.preferences.ensure();
    expect(solo.snapshot().data?.sections).toEqual([]);
    f.install(value);
    await f.session.channelKit.refresh();
    await vi.waitFor(() =>
      expect(solo.snapshot().data?.sections[0]?.name).toBe("Solo work"),
    );
    f.install({
      ...value,
      groups: [
        { id: "work", defaultTemplateId: "", name: "Renamed elsewhere" },
      ],
    });
    await f.session.channelKit.refresh();
    await vi.waitFor(() =>
      expect(solo.snapshot().data?.sections[0]?.name).toBe("Renamed elsewhere"),
    );
    f.install(value, true);
    await f.session.channelKit.refresh();
    await vi.waitFor(() => {
      expect(solo.snapshot().data?.sections).toEqual([]);
      expect(solo.snapshot().data?.assignments).toEqual({});
    });
    expect(f.preferences.snapshot().data?.sections[0]?.name).toBe("OG work");
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("drops the retired Solo channel list on the next project write", async () => {
  const f = fixture();
  try {
    f.install({ ...groups, channels: [channel, other] } as Groups);
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.assign(channel, "work");
    const value = JSON.parse(
      f.publish.mock.calls.at(-1)?.[0].content ?? "null",
    ).value;
    expect(value.channels).toBeUndefined();
    expect(value.assignments).toEqual({ [channel]: "work", [other]: "work" });
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("does not overwrite project filing when a refresh fails, and reconciles retries against the fresh head", async () => {
  const f = fixture();
  try {
    f.install(groups);
    await f.session.soloPreferences.ensure();
    f.query.mockRejectedValueOnce(new Error("offline"));
    await expect(
      f.session.soloPreferences.assign(channel, "work"),
    ).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    await f.session.soloPreferences.assign(channel, "work");
    expect(f.session.soloPreferences.snapshot().data?.assignments).toEqual({
      [channel]: "work",
      [other]: "work",
    });
    const count = f.publish.mock.calls.length;
    await f.session.soloPreferences.assign(channel, "work");
    expect(f.publish).toHaveBeenCalledTimes(count);
  } finally {
    f.dispose();
  }
});

it("retries a workspace rename against fresh defaults and filing without redundant writes or recreating deleted workspaces", async () => {
  const f = fixture();
  try {
    f.install(groups);
    const preferences = f.session.soloPreferences;
    await preferences.ensure();
    const fresh: Groups = {
      ...groups,
      groups: [
        {
          id: "work",
          name: "Renamed elsewhere",
          defaultTemplateId: "new-default",
        },
        { id: "other", name: "Keep", defaultTemplateId: "" },
      ],
      assignments: { [channel]: "work", [other]: "other" },
    };
    f.install(fresh);
    f.query.mockRejectedValueOnce(new Error("offline"));
    await expect(
      preferences.renameSection("work", "Projects"),
    ).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    expect(preferences.snapshot().data?.sections[0]?.name).toBe("Solo work");
    await expect(
      preferences.renameSection("work", "Projects", "Solo work"),
    ).rejects.toThrow("workspace name needs review");
    expect(f.publish).not.toHaveBeenCalled();
    await preferences.renameSection("work", " Projects ", "Renamed elsewhere");
    expect(preferences.snapshot().data?.sections[0]?.name).toBe("Projects");
    expect(written(f).map((record) => record.value)).toEqual([
      {
        ...fresh,
        groups: [{ ...fresh.groups[0], name: "Projects" }, fresh.groups[1]],
      },
    ]);
    // A lost confirmation may retry against its old name once the desired name is live.
    await preferences.renameSection("work", "Projects", "Solo work");
    expect(f.publish).toHaveBeenCalledOnce();
    for (const name of [" ", "x".repeat(121)])
      await expect(preferences.renameSection("work", name)).rejects.toThrow();
    await expect(preferences.renameSection("gone", "Name")).rejects.toThrow(
      "no longer exists",
    );
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.assignment).not.toHaveBeenCalled();
    f.install(
      { ...groups, groups: [], assignments: {} },
      false,
      (f.publish.mock.calls[0]?.[0].created_at ?? 0) + 1,
    );
    await expect(preferences.renameSection("work", "Restore")).rejects.toThrow(
      "no longer exists",
    );
    expect(f.publish).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it("confirms native-shaped reordered assignment maps without losing group order", async () => {
  const f = fixture();
  try {
    f.install(groups);
    f.prepare.mockImplementation(async (record) =>
      JSON.stringify(record, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      ),
    );
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.assign(channel, "work");
    expect(f.session.soloPreferences.snapshot().data?.assignments).toEqual({
      [channel]: "work",
      [other]: "work",
    });
    expect(f.publish).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it("checks the exact project capacity before saving and reclaims a removed filing", async () => {
  const f = fixture();
  const value: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Work", defaultTemplateId: "" }],
    assignments: {},
  };
  const record = () => ({
    version: 1 as const,
    community,
    deleted: false,
    value,
  });
  let id = "";
  for (let i = 1; i < 1000; i++) {
    id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    value.assignments[id] = "work";
    if (!kitRecordFits(record())) {
      delete value.assignments[id];
      break;
    }
  }
  parseKitRecord(record(), community);
  f.install(value);
  try {
    await f.session.soloPreferences.ensure();
    await expect(f.session.soloPreferences.assign(id, "work")).rejects.toThrow(
      "Solo workspace storage is full",
    );
    expect(f.publish).not.toHaveBeenCalled();
    const removed = Object.keys(value.assignments)[0];
    if (!removed) throw new Error("Missing filing");
    await f.session.soloPreferences.assign(removed, undefined);
    await f.session.soloPreferences.assign(id, "work");
    const assignments = f.session.soloPreferences.snapshot().data?.assignments;
    expect(assignments?.[id]).toBe("work");
    expect(assignments?.[removed]).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it("drops filings of archived or deleted chats when the Solo record is full", async () => {
  const f = fixture();
  const value: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Work", defaultTemplateId: "" }],
    assignments: {},
  };
  const record = () => ({
    version: 1 as const,
    community,
    deleted: false,
    value,
  });
  let id = "";
  for (let i = 1; i < 1000; i++) {
    id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    value.assignments[id] = "work";
    if (!kitRecordFits(record())) {
      delete value.assignments[id];
      break;
    }
  }
  f.install(value);
  const [first, second, kept] = Object.keys(value.assignments);
  if (!first || !second || !kept) throw new Error("Missing filing");
  let known = false;
  const controller = new AbortController();
  // The chat being filed is reported gone too, as a brand-new chat can be.
  const solo = createSoloPreferences(
    f.session.channelKit,
    controller.signal,
    () => (known ? [first, second, id] : []),
  );
  try {
    await solo.queries.ensure();
    await expect(solo.queries.assign(id, "work")).rejects.toThrow(
      "Solo workspace storage is full",
    );
    expect(f.publish).not.toHaveBeenCalled();
    known = true;
    await solo.queries.assign(id, "work");
    const assignments = solo.queries.snapshot().data?.assignments;
    expect(assignments?.[id]).toBe("work");
    expect(assignments?.[first]).toBeUndefined();
    expect(assignments?.[second]).toBeUndefined();
    expect(assignments?.[kept]).toBe("work");
    // With room again, a save leaves the remaining filings alone.
    known = false;
    await solo.queries.assign(first, "work");
    expect(solo.queries.snapshot().data?.assignments?.[first]).toBe("work");
  } finally {
    controller.abort();
    solo.dispose();
    f.dispose();
  }
});

const agent = "a".repeat(64);
const settings = async (projectId: string): Promise<Template> => ({
  type: "template",
  id: await projectTemplateId(projectId),
  name: "Solo work chats",
  description: "Starting workspace and Canvas for new chats in this workspace.",
  teamIds: [],
  agents: [agent],
  canvas: "## Project folders\n\n- `/src/launch`",
});
const workspaces: Groups = {
  type: "groups",
  id: "me",
  groups: [
    { id: "work", name: "Solo work", defaultTemplateId: "" },
    { id: "keep", name: "Kept", defaultTemplateId: "" },
  ],
  assignments: { [other]: "work" },
};
const written = (f: ReturnType<typeof fixture>) =>
  f.publish.mock.calls.map(([event]) => JSON.parse(event.content) as KitRecord);

it("tombstones only the removed workspace's settings, without their name, instructions, folders or agents", async () => {
  const f = fixture();
  try {
    const saved = await settings("work");
    const kept = await settings("keep");
    f.install(workspaces);
    f.install(saved);
    f.install(kept);
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.removeSection("work");
    expect(
      f.session.soloPreferences.snapshot().data?.sections.map(({ id }) => id),
    ).toEqual(["keep"]);
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
    const events = f.publish.mock.calls.map(([event]) => event);
    const record = (type: KitValue["type"]) => {
      const event = events.find(
        ({ content }) => JSON.parse(content).value.type === type,
      );
      return event && { event, record: JSON.parse(event.content) as KitRecord };
    };
    expect(record("groups")?.record).toEqual({
      version: 1,
      community,
      deleted: false,
      value: {
        ...workspaces,
        groups: workspaces.groups.slice(1),
        assignments: {},
      },
    });
    const tombstone = record("template");
    expect(tombstone?.record).toEqual({
      version: 1,
      community,
      deleted: true,
      value: { ...saved, name: "Deleted workspace", agents: [], canvas: "" },
    });
    expect(tombstone?.event.tags).toContainEqual([
      "d",
      coordinate({ version: 1, community, deleted: false, value: saved }),
    ]);
    await f.session.channelKit.refresh();
    const { entries } = f.session.channelKit.snapshot();
    expect(
      entries.find(({ record }) => record.value.id === saved.id)?.record
        .deleted,
    ).toBe(true);
    expect(templateEntry(entries, saved.id)).toBeUndefined();
    expect(templateEntry(entries, kept.id)?.record.value).toEqual(kept);
  } finally {
    f.dispose();
  }
});

it("resolves a removal before its tombstone and queues later writes behind it", async () => {
  const f = fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  try {
    f.install(workspaces);
    f.install(await settings("work"));
    f.prepare.mockImplementation(async (record) => {
      if (record.value.type === "template") {
        holding = true;
        await held;
      }
      return JSON.stringify(record);
    });
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.removeSection("work");
    await vi.waitFor(() => expect(holding).toBe(true));
    const created = f.session.soloPreferences.createSection({
      id: "next",
      name: "Next",
    });
    let settled = false;
    const settle = () => {
      settled = true;
    };
    void created.then(settle, settle);
    await flush();
    expect(settled).toBe(false);
    expect(f.publish).toHaveBeenCalledOnce();
    release();
    await expect(created).resolves.toBeUndefined();
    expect(written(f).map(({ value }) => value.type)).toEqual([
      "groups",
      "template",
      "groups",
    ]);
  } finally {
    release();
    f.dispose();
  }
});

it("saves another workspace's settings while a removed workspace's settings are deleted", async () => {
  const f = fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  try {
    const removed = await settings("work");
    const kept = await settings("keep");
    f.install(workspaces);
    f.install(removed);
    f.install(kept);
    f.prepare.mockImplementation(async (record) => {
      if (record.deleted) {
        holding = true;
        await held;
      }
      return JSON.stringify(record);
    });
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.removeSection("work");
    await vi.waitFor(() => expect(holding).toBe(true));
    // Workspace settings save through the kit itself, outside the Solo queue.
    const edited = { ...kept, canvas: "## Project folders\n\n- `/src/kept`" };
    await f.session.channelKit.save(
      edited,
      templateEntry(f.session.channelKit.snapshot().entries, kept.id)?.eventId,
    );
    expect(
      templateEntry(f.session.channelKit.snapshot().entries, kept.id)?.record
        .value,
    ).toEqual(edited);
    release();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(3));
    expect(
      written(f).map(({ deleted, value }) => [value.type, value.id, deleted]),
    ).toEqual([
      ["groups", "me", false],
      ["template", kept.id, false],
      ["template", removed.id, true],
    ]);
  } finally {
    release();
    f.dispose();
  }
});

it("deletes the settings when a retried removal finds its unconfirmed groups write landed", async () => {
  const f = fixture();
  try {
    const removed = await settings("work");
    f.install(workspaces);
    f.install(removed);
    await f.session.soloPreferences.ensure();
    // The relay stores the groups write but never confirms it by id.
    const read = f.query.getMockImplementation();
    let unconfirmed = true;
    f.query.mockImplementation(async (filters) =>
      unconfirmed && filters.some(({ ids }) => ids)
        ? []
        : (read?.(filters) ?? []),
    );
    await expect(
      f.session.soloPreferences.removeSection("work"),
    ).rejects.toThrow("awaiting exact relay confirmation");
    expect(written(f).map(({ value }) => value.type)).toEqual(["groups"]);
    unconfirmed = false;
    await f.session.soloPreferences.removeSection("work");
    expect(
      f.session.soloPreferences.snapshot().data?.sections.map(({ id }) => id),
    ).toEqual(["keep"]);
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
    expect(written(f)[1]).toMatchObject({
      deleted: true,
      value: { id: removed.id, name: "Deleted workspace" },
    });
  } finally {
    f.dispose();
  }
});

it("drops the tombstone when the preferences clear while it hashes the id", async () => {
  const f = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.install(workspaces);
    f.install(await settings("work"));
    await f.session.soloPreferences.ensure();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let hashing = false;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      hashing = true;
      await held;
      return digest(...args);
    });
    await f.session.soloPreferences.removeSection("work");
    await vi.waitFor(() => expect(hashing).toBe(true));
    void f.clearCache();
    release();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(written(f).map(({ value }) => value.type)).toEqual(["groups"]);
  } finally {
    release();
    f.dispose();
  }
});

it.each([
  ["has no saved settings", false],
  ["already has deleted settings", true],
] as const)(
  "writes only the groups record when the workspace %s",
  async (_case, deleted) => {
    const f = fixture();
    try {
      f.install(workspaces);
      if (deleted) f.install(await settings("work"), true);
      await f.session.soloPreferences.ensure();
      await f.session.soloPreferences.removeSection("work");
      // A later queued mutation runs after any cleanup the removal queued.
      await f.session.soloPreferences.removeSection("work");
      expect(written(f).map(({ value }) => value.type)).toEqual(["groups"]);
    } finally {
      f.dispose();
    }
  },
);

it("keeps a workspace deleted when its settings can't be deleted", async () => {
  const f = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const saved = await settings("work");
    f.install(workspaces);
    f.install(saved);
    f.prepare.mockImplementation(async (record) => {
      if (record.value.type === "template") throw new Error("Signer offline");
      return JSON.stringify(record);
    });
    await f.session.soloPreferences.ensure();
    await expect(
      f.session.soloPreferences.removeSection("work"),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(String(warn.mock.calls[0]?.[1])).toContain("Signer offline");
    expect(f.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deleted: true,
        value: expect.objectContaining({ id: saved.id }),
      }),
      expect.anything(),
    );
    expect(written(f).map(({ value }) => value.type)).toEqual(["groups"]);
    await f.session.soloPreferences.refresh();
    expect(
      f.session.soloPreferences.snapshot().data?.sections.map(({ id }) => id),
    ).toEqual(["keep"]);
  } finally {
    f.dispose();
  }
});

it("writes no tombstone when the groups write fails", async () => {
  const f = fixture();
  try {
    f.install(workspaces);
    f.install(await settings("work"));
    f.prepare.mockRejectedValueOnce(new Error("Signer offline"));
    await f.session.soloPreferences.ensure();
    await expect(
      f.session.soloPreferences.removeSection("work"),
    ).rejects.toThrow("Signer offline");
    // A later queued mutation runs after any cleanup the removal queued.
    await f.session.soloPreferences.removeSection("missing");
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.publish).not.toHaveBeenCalled();
    expect(
      f.session.soloPreferences.snapshot().data?.sections.map(({ id }) => id),
    ).toEqual(["work", "keep"]);
  } finally {
    f.dispose();
  }
});
