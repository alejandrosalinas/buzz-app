import { expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarPreferences,
  SidebarSectionRenameMutator,
} from "./sidebar-preferences";

const data: SidebarPreferences = {
  sections: [
    { id: "a", name: "A", order: 0 },
    { id: "b", name: "B", order: 1 },
  ],
  assignments: { alpha: "a" },
  starred: [],
  muted: [],
};
function setup(rename?: SidebarSectionRenameMutator) {
  const store = createSidebarPreferencesStore({
    read: async () => data,
    available: true,
    write: async () => data,
    writeStar: async () => [],
    renameSection: rename,
  });
  return store.queries;
}

it("publishes the confirmed name only after the host accepts the rename", async () => {
  const rename = vi.fn<SidebarSectionRenameMutator>(async ({ name }) => ({
    sections: [
      { id: "a", name: name ?? "A", order: 0 },
      { id: "b", name: "B", order: 1 },
    ],
    assignments: data.assignments,
  }));
  const queries = setup(rename);
  expect(queries.sectionRenameWritable).toBe(false);
  await queries.ensure();
  expect(queries.sectionRenameWritable).toBe(true);
  await queries.renameSection("a", "Projects");
  expect(rename).toHaveBeenCalledWith(
    { sectionId: "a", name: "Projects" },
    expect.any(AbortSignal),
  );
  expect(queries.snapshot().data?.sections.map(({ name }) => name)).toEqual([
    "Projects",
    "B",
  ]);
  await queries.renameSection("a", "Work", "Projects");
  expect(rename).toHaveBeenLastCalledWith(
    { sectionId: "a", name: "Work", expectedName: "Projects" },
    expect.any(AbortSignal),
  );
});

it("publishes a confirmed icon-only edit without resending the name", async () => {
  const rename = vi.fn<SidebarSectionRenameMutator>(async ({ icon }) => ({
    sections: [
      {
        id: "a",
        name: "A",
        ...(icon ? { icon } : {}),
        order: 0,
      },
      { id: "b", name: "B", order: 1 },
    ],
    assignments: data.assignments,
  }));
  const queries = setup(rename);
  await queries.ensure();
  await queries.renameSection("a", { icon: "🚀" });
  expect(rename).toHaveBeenCalledWith(
    { sectionId: "a", icon: "🚀" },
    expect.any(AbortSignal),
  );
  expect(queries.snapshot().data?.sections[0]).toMatchObject({
    name: "A",
    icon: "🚀",
  });
  await expect(
    queries.renameSection("a", { name: "A", icon: null }),
  ).resolves.toBeUndefined();
  expect(rename).toHaveBeenLastCalledWith(
    { sectionId: "a", name: "A", icon: null },
    expect.any(AbortSignal),
  );
  expect(queries.snapshot().data?.sections[0]).not.toHaveProperty("icon");
});

it("keeps the old name when the rename fails and is unavailable without a writer", async () => {
  const queries = setup(vi.fn().mockRejectedValue(new Error("offline")));
  await queries.ensure();
  await expect(queries.renameSection("a", "Projects")).rejects.toThrow(
    "offline",
  );
  expect(queries.snapshot().data?.sections[0]?.name).toBe("A");
  const readOnly = setup();
  await readOnly.ensure();
  expect(readOnly.sectionRenameWritable).toBe(false);
  await expect(readOnly.renameSection("a", "Projects")).rejects.toThrow(
    "unavailable",
  );
});
