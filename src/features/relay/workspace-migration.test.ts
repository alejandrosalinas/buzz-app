import { expect, it } from "vitest";
import { KIT_TAG, ME_KIT_TAG, type Groups } from "../channel-templates/model";
import { TEAM_MANIFEST_TAG } from "../channel-templates/team-payload";
import {
  editSidebarAssignment,
  editSidebarSectionOrder,
  editSidebarSectionRemoval,
  editSidebarSectionRename,
} from "./sidebar-edits";
import { createRelaySession } from "./session";
import { importWorkspaceFallback } from "./sidebar-registers";
import {
  decodeLegacyWorkspaceEnvelope,
  encodeLegacyWorkspaceEnvelope,
  projectWorkspaceGroups,
  workspaceBaseRecord,
  expandWorkspaceRecord,
  workspacePayloadForSigning,
  workspaceRecordForWrite,
  workspaceSectionOrder,
  type SidebarGroups,
} from "./sidebar-preferences";
import { flush, keypair, roster, scriptedTransport } from "./testing";
import { mergeLegacyWorkspaces } from "./workspace-migration";

const channel = "11111111-1111-4111-8111-111111111111";

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

it("preserves both sets of filings, template coordinates and ordering when legacy IDs collide", () => {
  const solo: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Notes", defaultTemplateId: "old-template" }],
    assignments: { chat: "work" },
  };
  const team: SidebarGroups = {
    sections: [
      { id: "work", name: "Release", order: 0, icon: "📚" },
      { id: "second", name: "Later", order: 1 },
    ],
    assignments: { dm: "work", forum: "second" },
  };
  expect(mergeLegacyWorkspaces(team, solo)).toEqual({
    sections: [
      { id: "work", name: "Notes", order: 0 },
      { id: "legacy-team:work", name: "Release", order: 1, icon: "📚" },
      { id: "second", name: "Later", order: 2 },
    ],
    sectionOrder: [
      "group:work",
      "solo",
      "starred",
      "group:legacy-team:work",
      "group:second",
    ],
    assignments: { chat: "work", dm: "legacy-team:work", forum: "second" },
    legacyTemplates: { work: "old-template" },
  });
});

const soloGroups: Groups = {
  type: "groups",
  id: "me",
  groups: [{ id: "notes", name: "Notes", defaultTemplateId: "" }],
  assignments: {},
};
const teamGroups: SidebarGroups = {
  sections: [{ id: "release", name: "Release", order: 0 }],
  assignments: {},
};
const emptyGroups: SidebarGroups = { sections: [], assignments: {} };

it.each([
  {
    name: "both legacy lists",
    team: teamGroups,
    solo: soloGroups,
    before: ["group:notes"],
    after: ["group:release"],
  },
  {
    name: "only Solo available",
    team: emptyGroups,
    solo: soloGroups,
    before: ["group:notes"],
    after: [],
  },
  {
    name: "only Team available",
    team: teamGroups,
    solo: undefined,
    before: [],
    after: ["group:release"],
  },
  {
    name: "no groups",
    team: emptyGroups,
    solo: undefined,
    before: [],
    after: [],
  },
])(
  "keeps the first-load order after the first save with $name",
  ({ team, solo, before, after }) => {
    const legacy = mergeLegacyWorkspaces(team, solo);
    const expected = [
      "pages",
      ...before,
      "solo",
      "starred",
      ...after,
      "channels",
      "forums",
      "dms",
    ];
    expect(workspaceSectionOrder(legacy)).toEqual(expected);
    const hostLegacy = decodeLegacyWorkspaceEnvelope(
      encodeLegacyWorkspaceEnvelope(legacy),
    );
    const base = workspaceBaseRecord(hostLegacy);
    const sectionId = legacy.sections[0]?.id;
    const edited = sectionId
      ? editSidebarAssignment(base, 0, { channelId: channel, sectionId })
      : base;
    const saved = workspacePayloadForSigning(edited, hostLegacy, base);
    // The first save keeps the order worked out from the legacy records.
    expect(saved.sectionOrder).toEqual(legacy.sectionOrder ?? []);
    const readback = importWorkspaceFallback(
      expandWorkspaceRecord(saved),
      hostLegacy,
    );
    expect(workspaceSectionOrder(projectWorkspaceGroups(readback))).toEqual(
      expected,
    );
  },
);

it("accepts a legacy order without Starred and restores it at the top", () => {
  // The derived order is used as saved, never split around Starred again.
  const legacy = decodeLegacyWorkspaceEnvelope({
    version: 1,
    sections: [
      { id: "notes", name: "Notes", order: 0 },
      { id: "release", name: "Release", order: 1 },
    ],
    assignments: {},
    sectionOrder: ["solo", "group:notes", "group:release"],
  });
  const base = workspaceBaseRecord(legacy);
  const order = [
    "pages",
    "starred",
    "solo",
    "group:notes",
    "group:release",
    "channels",
    "forums",
    "dms",
  ];
  expect(workspaceSectionOrder(projectWorkspaceGroups(base))).toEqual(order);
  const saved = workspacePayloadForSigning(
    editSidebarAssignment(base, 0, { channelId: channel, sectionId: "notes" }),
    legacy,
    base,
  );
  expect(
    workspaceSectionOrder(
      projectWorkspaceGroups(
        importWorkspaceFallback(expandWorkspaceRecord(saved), legacy),
      ),
    ),
  ).toEqual(order);
});

it("gives an existing unified record without a saved order the new default", () => {
  const legacy = mergeLegacyWorkspaces(teamGroups, soloGroups);
  const current = { ...workspaceBaseRecord(legacy), sectionOrder: [] };
  const loaded = importWorkspaceFallback(current, legacy);
  expect(loaded).toBe(current);
  const defaults = [
    "pages",
    "solo",
    "starred",
    "group:notes",
    "group:release",
    "channels",
    "forums",
    "dms",
  ];
  expect(workspaceSectionOrder(projectWorkspaceGroups(loaded))).toEqual(
    defaults,
  );
  // An ordinary edit keeps the order empty rather than pinning a layout.
  const edited = editSidebarAssignment(loaded, 1, {
    channelId: channel,
    sectionId: "release",
  });
  const signed = workspacePayloadForSigning(edited, legacy, current);
  expect(signed.sectionOrder).toEqual([]);
  expect(
    workspaceSectionOrder(
      projectWorkspaceGroups(expandWorkspaceRecord(signed)),
    ),
  ).toEqual(defaults);
  const reordered = editSidebarSectionOrder(loaded, 1, [
    "starred",
    "group:release",
    "group:notes",
    "solo",
  ]);
  expect(
    workspacePayloadForSigning(reordered, legacy, current).sectionOrder,
  ).toEqual([
    "starred",
    "group:release",
    "group:notes",
    "solo",
    "pages",
    "channels",
    "forums",
    "dms",
  ]);
});

function legacyWithFilings(count: number, idLength: number): SidebarGroups {
  const sections = Array.from({ length: 20 }, (_, order) => ({
    id: `00000000-0000-0000-0000-${String(order).padStart(12, "0")}`,
    name: `Workspace ${order}`,
    order,
  }));
  return {
    sections,
    assignments: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        String(index).padStart(idLength, "x"),
        sections[index % sections.length]?.id,
      ]),
    ),
  } as SidebarGroups;
}

it("renames, moves, unfiles and deletes a legacy import near the byte limit", () => {
  const legacy = legacyWithFilings(700, 141);
  const source = workspaceBaseRecord(legacy);
  const target = legacy.sections[1]?.id ?? "";
  const original = legacy.sections[0]?.id ?? "";
  const [first, second] = Object.keys(legacy.assignments);
  if (!first || !second) throw new Error("Incomplete fixture");
  const edit = (next: Record<string, unknown>) =>
    workspaceRecordForWrite(next, legacy);

  const renamed = edit(editSidebarSectionRename(source, 0, original, "Notes"));
  expect(renamed.sections[0]?.name).toBe("Notes");
  expect(JSON.stringify(renamed).length).toBeGreaterThan(128_000);
  const moved = edit(
    editSidebarAssignment(renamed, 0, { channelId: first, sectionId: target }),
  );
  expect(moved.assignments[first]).toBe(target);
  const unfiled = edit(editSidebarAssignment(moved, 0, { channelId: second }));
  expect(unfiled.assignments).not.toHaveProperty(second);
  const deleted = edit(editSidebarSectionRemoval(unfiled, 0, original));
  expect(deleted.sections).toHaveLength(19);
  expect(deleted.removedSections).toEqual([original]);
  expect(deleted.unfiled).toContain(second);
  expect(
    importWorkspaceFallback(JSON.parse(JSON.stringify(deleted)), legacy),
  ).toEqual(deleted);
});

it("leaves an oversized legacy projection readable and never truncates it to save", () => {
  const legacy = legacyWithFilings(700, 190);
  const source = workspaceBaseRecord(legacy);
  expect(Object.keys(source.assignments)).toHaveLength(700);
  expect(() => workspacePayloadForSigning(source, legacy)).toThrow(
    "storage limit",
  );
  const reduced = editSidebarSectionRemoval(
    source,
    0,
    legacy.sections[0]?.id ?? "",
  );
  expect(workspacePayloadForSigning(reduced, legacy).sections).toHaveLength(19);
});

it("keeps a prior unfile when old clients remove and later restore the filing", () => {
  const groups: SidebarGroups = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { [channel]: "work" },
  };
  const legacy = workspaceBaseRecord(groups);
  const unfiled = workspaceRecordForWrite(
    editSidebarAssignment(legacy, 0, { channelId: channel }),
    groups,
  );
  const renamed = workspaceRecordForWrite(
    editSidebarSectionRename(unfiled, 0, "work", "Renamed"),
    { ...groups, assignments: {} },
    unfiled,
  );
  expect(renamed.unfiled).toEqual([channel]);
  expect(importWorkspaceFallback(renamed, groups)).toEqual(renamed);
});

it("fits two full legacy rosters through rename, move, unfile and removal", () => {
  const sections = Array.from({ length: 200 }, (_, order) => ({
    id: `00000000-0000-4000-8000-${String(order).padStart(12, "0")}`,
    name: `Workspace ${order}`,
    order,
  }));
  const assignments = Object.fromEntries(
    Array.from({ length: 2000 }, (_, index) => [
      index.toString(16).padStart(64, "0"),
      sections[index % sections.length]?.id ?? "",
    ]),
  );
  const legacy = { sections, assignments };
  const source = workspaceBaseRecord(legacy);
  const [first, second] = Object.keys(assignments);
  const [original, destination] = sections;
  if (!first || !second || !original || !destination)
    throw new Error("Incomplete fixture");
  const readback = (value: Record<string, unknown>) => {
    const wire = JSON.stringify(workspacePayloadForSigning(value, legacy));
    expect(wire.length).toBeLessThan(128 * 1024);
    expect(JSON.parse(wire)).toHaveProperty("filings");
    return expandWorkspaceRecord(JSON.parse(wire));
  };
  const renamed = readback(
    editSidebarSectionRename(source, 0, original.id, "Renamed"),
  );
  expect(renamed).toMatchObject({ assignments });
  const moved = readback(
    editSidebarAssignment(renamed, 0, {
      channelId: first,
      sectionId: destination.id,
    }),
  );
  expect(moved.assignments).toHaveProperty(first, destination.id);
  const unfiled = readback(
    editSidebarAssignment(moved, 0, { channelId: second }),
  );
  expect(unfiled.assignments).not.toHaveProperty(second);
  const removed = readback(editSidebarSectionRemoval(unfiled, 0, original.id));
  expect(removed.removedSections).toEqual([original.id]);
  expect(removed.unfiled).toEqual([second]);
  expect(Object.keys(removed.assignments as object)).toHaveLength(1990);
});

it("defers new legacy workspaces and filings when the upgraded layout is full", () => {
  const sections = Array.from({ length: 200 }, (_, order) => ({
    id: `workspace-${order}`,
    name: `Workspace ${order}`,
    order,
  }));
  const assignments = Object.fromEntries(
    Array.from({ length: 2000 }, (_, index) => [
      `chat-${index}`,
      index === 0 ? "workspace-199" : "workspace-0",
    ]),
  );
  const current = workspaceBaseRecord({ sections, assignments });
  const legacy = {
    sections: [{ id: "legacy", name: "Older client", order: 0 }],
    assignments: { "legacy-chat": "legacy", "legacy-other": "workspace-0" },
  };
  expect(importWorkspaceFallback(current, legacy)).toBe(current);

  const room = editSidebarSectionRemoval(current, 0, "workspace-199");
  const merged = importWorkspaceFallback(room, legacy);
  expect(merged.sections).toEqual([
    ...sections.slice(0, -1),
    { id: "legacy", name: "Older client", order: 199 },
  ]);
  expect(merged.assignments).toHaveProperty("legacy-chat", "legacy");
  expect(merged.assignments).not.toHaveProperty("legacy-other");
  expect(workspacePayloadForSigning(merged, legacy).sections).toHaveLength(200);
});

it("keeps an explicit unfile or removal when the legacy entry is already absent", () => {
  const groups: SidebarGroups = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { [channel]: "work" },
  };
  const current = workspaceBaseRecord(groups);
  const unfiled = workspaceRecordForWrite(
    editSidebarAssignment(current, 0, { channelId: channel }),
    { ...groups, assignments: {} },
    current,
  );
  expect(unfiled.unfiled).toEqual([channel]);
  expect(importWorkspaceFallback(unfiled, groups)).toEqual(unfiled);

  const removed = workspaceRecordForWrite(
    editSidebarSectionRemoval(current, 0, "work"),
    { sections: [], assignments: {} },
    current,
  );
  expect(removed.removedSections).toEqual(["work"]);
  expect(removed.unfiled).toBeUndefined();
  expect(importWorkspaceFallback(removed, groups)).toEqual(removed);
});

it("only reclaims an unchanged archived filing when a new filing needs room", () => {
  const groups = legacyWithFilings(2000, 12);
  const source = workspaceBaseRecord(groups);
  const [archivedId, liveId] = Object.keys(groups.assignments);
  if (!archivedId || !liveId) throw new Error("Incomplete fixture");
  const sectionId = groups.assignments[archivedId] ?? "";
  const reclaim = { channelId: archivedId, sectionId };
  const edit = (current: Record<string, unknown>, channelId: string) =>
    editSidebarAssignment(current, 0, { channelId, sectionId, reclaim });
  expect(edit(source, liveId).assignments).toHaveProperty(
    archivedId,
    sectionId,
  );
  const saved = workspaceRecordForWrite(edit(source, "new-chat"), groups);
  expect(saved.assignments).toHaveProperty("new-chat", sectionId);
  expect(saved.assignments).not.toHaveProperty(archivedId);
  expect(saved.unfiled).toEqual([archivedId]);
});

it("does not accumulate removal markers under sustained unified-only filing churn", () => {
  const sections = [{ id: "work", name: "Work", order: 0 }];
  const id = (index: number) => index.toString(16).padStart(64, "0");
  const assignments = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [id(index), "work"]),
  );
  const legacy = { sections, assignments: {} };
  const source = workspaceBaseRecord({ sections, assignments });
  let current = workspacePayloadForSigning(source, legacy);
  for (let index = 1000; index < 2300; index++) {
    const channelId = id(index);
    // Writes can still proceed when a verified unified head is available but
    // the two legacy heads temporarily cannot be read.
    const availableLegacy = index < 2250 ? legacy : undefined;
    const save = (sectionId?: string) => {
      const previous = expandWorkspaceRecord(current);
      const next = editSidebarAssignment(previous, 0, {
        channelId,
        ...(sectionId ? { sectionId } : {}),
      });
      current = JSON.parse(
        JSON.stringify(
          workspacePayloadForSigning(next, availableLegacy, previous),
        ),
      );
    };
    save("work");
    save();
  }
  expect(current).not.toHaveProperty("unfiled");
  expect(current).not.toHaveProperty("packedUnfiled");
  expect(expandWorkspaceRecord(current).assignments).toEqual(assignments);
}, 30_000);

it("retains a protected legacy origin through refile and another unfile", () => {
  const sections = [{ id: "work", name: "Work", order: 0 }];
  const legacy = { sections, assignments: { [channel]: "work" } };
  const missing = { sections, assignments: {} };
  const source = workspaceBaseRecord(legacy);
  const unfiled = workspaceRecordForWrite(
    editSidebarAssignment(source, 0, { channelId: channel }),
    legacy,
    source,
  );
  const filedAgain = workspaceRecordForWrite(
    editSidebarAssignment(unfiled, 0, {
      channelId: channel,
      sectionId: "work",
    }),
    missing,
    unfiled,
  );
  const unfiledAgain = workspaceRecordForWrite(
    editSidebarAssignment(filedAgain, 0, { channelId: channel }),
    undefined,
    filedAgain,
  );
  expect(unfiledAgain.unfiled).toEqual([channel]);
  expect(importWorkspaceFallback(unfiledAgain, legacy)).toEqual(unfiledAgain);
});

it("retains a filing once a legacy client is observed using it", () => {
  const sections = [{ id: "work", name: "Work", order: 0 }];
  const empty = { sections, assignments: {} };
  const legacy = { sections, assignments: { [channel]: "work" } };
  const first = workspaceBaseRecord(empty);
  const filed = workspaceRecordForWrite(
    editSidebarAssignment(first, 0, { channelId: channel, sectionId: "work" }),
    empty,
    first,
  );
  const observed = importWorkspaceFallback(filed, legacy);
  const renamed = workspaceRecordForWrite(
    editSidebarSectionRename(observed, 0, "work", "Renamed"),
    legacy,
    observed,
  );
  const unfiled = workspaceRecordForWrite(
    editSidebarAssignment(renamed, 0, { channelId: channel }),
    empty,
    renamed,
  );
  expect(unfiled.unfiled).toEqual([channel]);
  expect(importWorkspaceFallback(unfiled, legacy)).toEqual(unfiled);
});

it("compacts protective legacy markers without restoring their filings", () => {
  const sectionId = "00000000-0000-4000-8000-000000000001";
  const sections = [{ id: sectionId, name: "Work", order: 0 }];
  const assignments = (count: number, from: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        (index + from).toString(16).padStart(64, "0"),
        sectionId,
      ]),
    );
  const legacy = { sections, assignments: assignments(700, 1900) };
  const live = assignments(1900, 0);
  const unfiled = Object.keys(legacy.assignments);
  const packed = workspacePayloadForSigning(
    { ...workspaceBaseRecord({ sections, assignments: live }), unfiled },
    legacy,
  );
  expect(packed).toHaveProperty("packedUnfiled");
  expect(JSON.stringify(packed).length).toBeLessThan(128 * 1024);
  const roundTrip = expandWorkspaceRecord(JSON.parse(JSON.stringify(packed)));
  expect(roundTrip).toMatchObject({ assignments: live, unfiled });
  expect(importWorkspaceFallback(roundTrip, legacy)).toEqual(roundTrip);
});

it("closes a fully accounted legacy import when protective history would block editing", () => {
  const sections = Array.from({ length: 200 }, (_, order) => ({
    id: `00000000-0000-4000-8000-${String(order).padStart(12, "0")}`,
    name: `Workspace ${order}`,
    order,
  }));
  const entries = (from: number) =>
    Array.from(
      { length: 2000 },
      (_, index) =>
        [
          (index + from).toString(16).padStart(64, "0"),
          sections[index % sections.length]?.id ?? "",
        ] as const,
    );
  const legacy = { sections, assignments: Object.fromEntries(entries(0)) };
  const assignments = Object.fromEntries(entries(1000));
  const legacyTemplates = {
    [sections[0]?.id ?? ""]: "original-workspace-template",
  };
  const payload = {
    ...workspaceBaseRecord({ sections, assignments, legacyTemplates }),
    unfiled: entries(0)
      .slice(0, 1000)
      .map(([id]) => id),
  };
  const additional = {
    ...legacy,
    assignments: { ...legacy.assignments, missing: sections[0]?.id ?? "" },
  };
  expect(() => workspacePayloadForSigning(payload, additional)).toThrow(
    "storage limit",
  );
  const signed = workspacePayloadForSigning(payload, legacy);
  expect(signed).toHaveProperty("legacyImportClosed", true);
  expect(signed).not.toHaveProperty("packedUnfiled");
  const roundTrip = expandWorkspaceRecord(JSON.parse(JSON.stringify(signed)));
  expect(roundTrip).toMatchObject({ assignments, legacyTemplates });
  expect(importWorkspaceFallback(roundTrip, additional)).toBe(roundTrip);
  // Closure holds after the layout shrinks below both caps.
  const shrunk = {
    ...roundTrip,
    sections: sections.slice(0, 1),
    assignments: {},
  };
  expect(importWorkspaceFallback(shrunk, additional)).toBe(shrunk);
  // Closure needs every legacy workspace kept or removed; a removal covers its
  // filings.
  const late = { id: "late-workspace", name: "Late", order: 200 };
  const withLate = {
    sections: [...sections, late],
    assignments: { ...legacy.assignments, "late-filing": late.id },
  };
  expect(() =>
    workspacePayloadForSigning(payload, {
      ...legacy,
      sections: withLate.sections,
    }),
  ).toThrow("storage limit");
  expect(
    workspacePayloadForSigning(
      { ...payload, removedSections: [late.id] },
      withLate,
    ),
  ).toHaveProperty("legacyImportClosed", true);
  const [channelId] = Object.keys(assignments);
  if (!channelId) throw new Error("Incomplete fixture");
  const edited = workspacePayloadForSigning(
    editSidebarAssignment(roundTrip, 0, { channelId }),
    undefined,
    roundTrip,
  );
  expect(edited).toHaveProperty("legacyImportClosed", true);
  expect(edited).not.toHaveProperty("unfiled");
  expect(expandWorkspaceRecord(edited).assignments).not.toHaveProperty(
    channelId,
  );
});
