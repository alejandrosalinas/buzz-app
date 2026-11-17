import { expect, it } from "vitest";
import { projectSidebarRecord } from "./sidebar-registers";
import type { SidebarGroups } from "./sidebar-preferences";
import {
  editSidebarAssignment,
  editSidebarSectionOrder,
  editSidebarSectionRemoval,
  editSidebarSectionRename,
  validSidebarSectionOrder,
  validSidebarSectionRemoval,
  validSidebarSectionRename,
  validSidebarAssignment,
  validSidebarChannelId,
  validSidebarSort,
} from "./sidebar-edits";

it("validates sidebar removal identifiers without normalizing their wire value", () => {
  for (const id of ["work", " work ", "x".repeat(256)])
    expect(validSidebarSectionRemoval(id)).toBe(true);
  for (const id of ["", " ", "x".repeat(257)])
    expect(validSidebarSectionRemoval(id)).toBe(false);
});

it("tombstones one legacy section and clears only its channel assignments", () => {
  const current = {
    version: 1,
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { alpha: "work", beta: "later", orphan: "missing" },
  };
  const next = editSidebarSectionRemoval(current, 1_700_000_000, "work", 42);
  expect(current.sections).toHaveLength(2);
  expect(current.assignments.alpha).toBe("work");
  expect(next.meta).toMatchObject({
    s: { work: { live: [expect.any(Number), expect.any(String), false] } },
    a: {
      alpha: [expect.any(Number), expect.any(String), null],
      beta: [1_700_000_000_000, "0000000000000000", "later"],
    },
  });
  expect(projectSidebarRecord("channel-sections", next)).toMatchObject({
    sections: [{ id: "later", name: "Later", order: 0 }],
    assignments: { beta: "later" },
  });
  expect(editSidebarSectionRemoval(next, 0, "work", 43)).toBe(next);
  expect(editSidebarSectionRemoval(current, 0, "missing", 42)).toBe(current);
});

it("reorders live sections as one whole-list write and keeps unlisted ones after", () => {
  const current = {
    version: 1,
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "later", name: "Later", order: 1 },
      { id: "home", name: "Home", order: 2 },
    ],
    assignments: { alpha: "work" },
  };
  const next = editSidebarSectionOrder(
    current,
    1_700_000_000,
    ["work", "gone", "home"],
    42,
  );
  expect(projectSidebarRecord("channel-sections", next)).toMatchObject({
    sections: [
      { id: "work", order: 0 },
      { id: "home", order: 1 },
      { id: "later", order: 2 },
    ],
    assignments: { alpha: "work" },
  });
  const meta = next.meta as { s: Record<string, { order: unknown[] }> };
  // Unchanged Work is restamped too: one stamp, so another device cannot interleave it.
  const stamps = Object.values(meta.s).map(({ order }) => order.slice(0, 2));
  expect(new Set(stamps.map(String)).size).toBe(1);
  expect(stamps[0]?.[0]).toBeGreaterThan(1_700_000_000_000);
  expect(meta.s).not.toHaveProperty("gone");
  // A satisfied order does not rewrite the head.
  expect(editSidebarSectionOrder(next, 0, ["work", "home"], 43)).toBe(next);
});

it("validates bounded unique section orders", () => {
  expect(validSidebarSectionOrder([])).toBe(true);
  expect(validSidebarSectionOrder(["a", "b"])).toBe(true);
  expect(validSidebarSectionOrder(["a", "a"])).toBe(false);
  expect(validSidebarSectionOrder([""])).toBe(false);
  expect(
    validSidebarSectionOrder(Array.from({ length: 101 }, (_, i) => `${i}`)),
  ).toBe(false);
});

it("bounds sidebar identifiers without normalizing their wire value", () => {
  for (const id of ["c", " c ", "x".repeat(256), "😀".repeat(128)])
    expect(validSidebarChannelId(id)).toBe(true);
  for (const id of ["", " ", "x".repeat(257), "😀".repeat(129)])
    expect(validSidebarChannelId(id)).toBe(false);
});

it("validates create-section policy separately from the host envelope", () => {
  const createSection = {
    id: "11111111-1111-1111-1111-111111111111",
    name: " Work ",
  };
  expect(validSidebarAssignment({ channelId: "c", createSection })).toBe(true);
  expect(
    validSidebarAssignment({
      channelId: "c",
      createSection: { ...createSection, position: "first" },
    }),
  ).toBe(true);
  expect(validSidebarAssignment({ channelId: "c" })).toBe(true);
  for (const intent of [
    { channelId: "c", sectionId: "" },
    { channelId: "c", sectionId: "existing", createSection },
    { channelId: "c", createSection: { ...createSection, id: "bad" } },
    { channelId: "c", createSection: { ...createSection, name: " " } },
    { channelId: "c", createSection: { ...createSection, icon: " " } },
    {
      channelId: "c",
      createSection: { ...createSection, icon: "x".repeat(129) },
    },
    {
      channelId: "c",
      createSection: { ...createSection, name: "x".repeat(257) },
    },
  ])
    expect(validSidebarAssignment(intent)).toBe(false);
  expect(
    validSidebarAssignment({
      createSection: { ...createSection, icon: "📚" },
    }),
  ).toBe(true);
  expect(
    validSidebarAssignment({
      createSection: { ...createSection, icon: ":books:" },
    }),
  ).toBe(true);
});

it("retains built-in and known-section sorting limits", () => {
  for (const group of ["starred", "channels", "forums", "dms"])
    for (const mode of ["alpha", "recent"] as const)
      expect(validSidebarSort(group, mode, [])).toBe(true);
  const section = "x".repeat(256);
  expect(validSidebarSort(`section:${section}`, "recent", [section])).toBe(
    true,
  );
  expect(validSidebarSort("section:unknown", "recent", [])).toBe(false);
  expect(
    validSidebarSort(`section:${section}x`, "recent", [`${section}x`]),
  ).toBe(false);
  expect(validSidebarSort("channels", "alpha", Array(100).fill("s"))).toBe(
    true,
  );
  expect(validSidebarSort("channels", "alpha", Array(101).fill("s"))).toBe(
    false,
  );
  expect(validSidebarSort("channels", "recent", [" "])).toBe(false);
});

it("renames one live section by rewriting only its name register", () => {
  const current = {
    version: 1,
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { alpha: "work" },
  };
  const next = editSidebarSectionRename(
    current,
    1_700_000_000,
    "work",
    " Projects ",
    42,
  );
  expect(projectSidebarRecord("channel-sections", next)).toMatchObject({
    sections: [
      { id: "work", name: "Projects", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { alpha: "work" },
  });
  expect(editSidebarSectionRename(next, 0, "work", "Projects", 43)).toBe(next);
  expect(() => editSidebarSectionRename(current, 0, "gone", "X", 42)).toThrow(
    "no longer exists",
  );
  expect(validSidebarSectionRename("work", "Projects")).toBe(true);
  expect(validSidebarSectionRename("work", undefined, "📚")).toBe(true);
  expect(validSidebarSectionRename("work", undefined, null)).toBe(true);
  expect(validSidebarSectionRename("work")).toBe(false);
  expect(validSidebarSectionRename("work", undefined, " ")).toBe(false);
  expect(validSidebarSectionRename("work", undefined, 1)).toBe(false);
  expect(validSidebarSectionRename("work", "  ")).toBe(false);
  expect(validSidebarSectionRename("work", "x".repeat(257))).toBe(false);
});

it("creates a section with its icon and confirms only a matching retry", () => {
  const current = {
    version: 1,
    sections: [{ id: "work", name: "Work", icon: "🏢", order: 0 }],
    assignments: {},
    future: { keep: true },
  };
  const createSection = {
    id: "11111111-1111-1111-1111-111111111111",
    name: " Launch ",
    icon: ":launch:",
  };
  const next = editSidebarAssignment(
    current,
    1_700_000_000,
    { createSection },
    42,
  );
  expect(projectSidebarRecord("channel-sections", next)).toMatchObject({
    sections: [
      { id: "work", name: "Work", icon: "🏢", order: 0 },
      { id: createSection.id, name: "Launch", icon: ":launch:", order: 1 },
    ],
    future: { keep: true },
  });
  expect(editSidebarAssignment(next, 0, { createSection })).toBe(next);
  // Existing name-only callers neither overwrite nor clear an existing icon.
  expect(
    editSidebarAssignment(next, 0, {
      createSection: { id: createSection.id, name: " Launch " },
    }),
  ).toBe(next);
  expect(() =>
    editSidebarAssignment(next, 0, {
      createSection: { ...createSection, icon: "📚" },
    }),
  ).toThrow("changed");
});

it("atomically edits only supplied name/icon leaves and explicitly removes icons", () => {
  const current = {
    version: 1,
    sections: [
      { id: "work", name: "Work", icon: "🏢", order: 0 },
      { id: "later", name: "Later", icon: ":later:", order: 1 },
    ],
    assignments: { alpha: "work" },
    future: "keep",
  };
  const named = editSidebarSectionRename(
    current,
    1_700_000_000,
    "work",
    { name: " Projects " },
    42,
  );
  expect(projectSidebarRecord("channel-sections", named)).toMatchObject({
    sections: [
      { id: "work", name: "Projects", icon: "🏢", order: 0 },
      { id: "later", name: "Later", icon: ":later:", order: 1 },
    ],
    assignments: { alpha: "work" },
    future: "keep",
  });
  expect(editSidebarSectionRename(current, 0, "work", { name: "Work" })).toBe(
    current,
  );
  expect(editSidebarSectionRename(current, 0, "work", { icon: "🏢" })).toBe(
    current,
  );
  const iconOnly = editSidebarSectionRename(
    named,
    1_700_000_001,
    "work",
    { icon: "📚" },
    43,
  );
  expect(projectSidebarRecord("channel-sections", iconOnly)).toMatchObject({
    sections: [
      { id: "work", name: "Projects", icon: "📚", order: 0 },
      { id: "later", name: "Later", icon: ":later:", order: 1 },
    ],
    assignments: { alpha: "work" },
  });
  const removed = editSidebarSectionRename(
    iconOnly,
    1_700_000_002,
    "work",
    { icon: null },
    44,
  );
  expect(projectSidebarRecord("channel-sections", removed)).toMatchObject({
    sections: [
      { id: "work", name: "Projects", order: 0 },
      { id: "later", name: "Later", icon: ":later:", order: 1 },
    ],
  });
  const removedSection = (
    projectSidebarRecord("channel-sections", removed)
      .sections as SidebarGroups["sections"]
  )[0];
  expect(removedSection).not.toHaveProperty("icon");
  const meta = removed.meta as {
    s: { work: { name: unknown[]; icon: unknown[]; order: unknown[] } };
  };
  expect(meta.s.work.name[2]).toBe("Projects");
  expect(meta.s.work.icon[2]).toBeNull();
  expect(meta.s.work.order[2]).toBe(0);
});
