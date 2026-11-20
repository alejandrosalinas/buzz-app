import { isSidebarSortMode } from "./sidebar-sort.ts";
import {
  projectSidebarPreferences,
  validActiveWindow,
  DEFAULT_ACTIVE_WINDOW_SECONDS,
  HOME_SIDEBAR_SECTIONS,
  MAX_WORKSPACES,
  MAX_WORKSPACE_ASSIGNMENTS,
  validWorkspaceSectionOrder,
  workspaceSectionOrder,
  type SidebarAssignmentIntent,
  type SidebarSectionEdit,
  type SidebarGroups,
  type SidebarSortMode,
  type SidebarFilterMode,
} from "./sidebar-preferences.ts";
import {
  editSidebarRecord,
  editSidebarSortRecord,
  nextSidebarSectionOrder,
  projectSidebarRecord,
} from "./sidebar-registers.ts";

export class WorkspaceNameConflict extends Error {
  constructor() {
    super(
      "The saved workspace name needs review. Your draft is kept; copy it before reloading saved settings.",
    );
  }
}

/** Tombstone the section and reset its live placements in the same record. */
export function editSidebarSectionRemoval(
  current: Record<string, unknown>,
  createdAt: number,
  sectionId: string,
  now = Date.now(),
): Record<string, unknown> {
  const projected = projectSidebarRecord("channel-sections", current);
  const sections = projected.sections as SidebarGroups["sections"];
  if (!sections.some(({ id }) => id === sectionId)) return current;
  const writes: [string[], unknown][] = [[["s", sectionId, "live"], false]];
  for (const [channelId, id] of Object.entries(
    projected.assignments as SidebarGroups["assignments"],
  ))
    if (id === sectionId) writes.push([["a", channelId], null]);
  return editSidebarRecord("channel-sections", current, createdAt, writes, now);
}

/** Atomically edit only supplied leaves; all other fields stay untouched. */
export function editSidebarSectionRename(
  current: Record<string, unknown>,
  createdAt: number,
  sectionId: string,
  edit: string | (SidebarSectionEdit & { expectedName?: string }),
  now = Date.now(),
): Record<string, unknown> {
  const sections = projectSidebarRecord("channel-sections", current)
    .sections as SidebarGroups["sections"];
  const section = sections.find(({ id }) => id === sectionId);
  if (!section) throw new Error("Sidebar section no longer exists");
  const changes = typeof edit === "string" ? { name: edit } : edit;
  const writes: [string[], unknown][] = [];
  if (changes.name !== undefined) {
    const next = changes.name.trim();
    if (section.name !== next) {
      if (
        "expectedName" in changes &&
        changes.expectedName !== undefined &&
        changes.expectedName !== section.name
      )
        throw new WorkspaceNameConflict();
      writes.push([["s", sectionId, "name"], next]);
    }
  }
  if (
    changes.icon !== undefined &&
    (changes.icon === null
      ? section.icon !== undefined
      : section.icon !== changes.icon)
  )
    writes.push([["s", sectionId, "icon"], changes.icon]);
  if (!writes.length) return current;
  return editSidebarRecord("channel-sections", current, createdAt, writes, now);
}

/** Requested live sections first, then unlisted live ones; every order is restamped. */
export function editSidebarSectionOrder(
  current: Record<string, unknown>,
  createdAt: number,
  sectionIds: readonly string[],
  now = Date.now(),
): Record<string, unknown> {
  if (current.sectionOrder !== undefined) {
    if (!validWorkspaceSectionOrder(sectionIds))
      throw new Error("Invalid workspace section order");
    const groups = projectSidebarPreferences(
      current,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const live = workspaceSectionOrder(groups);
    const wanted = new Set(sectionIds.filter((id) => live.includes(id)));
    const order = [...wanted, ...live.filter((id) => !wanted.has(id))];
    return order.every((key, index) => key === live[index])
      ? current
      : { ...current, sectionOrder: order };
  }
  const live = projectSidebarPreferences(current, undefined).sections.map(
    ({ id }) => id,
  );
  const wanted = new Set(sectionIds.filter((id) => live.includes(id)));
  const ids = [...wanted, ...live.filter((id) => !wanted.has(id))];
  return editSidebarRecord(
    "channel-sections",
    current,
    createdAt,
    ids.map((id, index) => [["s", id, "order"], index]),
    now,
    true,
  );
}

// Typed intent policy; host adapters retain untrusted-envelope validation.
export function validSidebarChannelId(channelId: string): boolean {
  return !!channelId.trim() && channelId.length <= 256;
}

export function validSidebarAssignment(
  intent: SidebarAssignmentIntent,
): boolean {
  const { channelId, sectionId, createSection, reclaim } = intent;
  return (
    (channelId === undefined
      ? !!createSection
      : validSidebarChannelId(channelId)) &&
    (sectionId === undefined || validSidebarChannelId(sectionId)) &&
    (reclaim === undefined ||
      (reclaim !== null &&
        !!channelId &&
        !!(sectionId || createSection) &&
        reclaim.channelId !== channelId &&
        typeof reclaim.channelId === "string" &&
        validSidebarChannelId(reclaim.channelId) &&
        typeof reclaim.sectionId === "string" &&
        validSidebarChannelId(reclaim.sectionId))) &&
    (!createSection ||
      (sectionId === undefined &&
        validSidebarChannelId(createSection.id) &&
        createSection.id !== "__proto__" &&
        validSidebarChannelId(createSection.name) &&
        (createSection.icon === undefined ||
          validSidebarSectionIcon(createSection.icon)) &&
        (createSection.position === undefined ||
          createSection.position === "first")))
  );
}

export function validSidebarSectionRemoval(sectionId: string): boolean {
  return validSidebarChannelId(sectionId);
}

export function validSidebarSectionIcon(icon: unknown): boolean {
  return typeof icon === "string" && !!icon.trim() && icon.length <= 128;
}

export function validSidebarSectionRename(
  sectionId: string,
  name?: unknown,
  icon?: unknown,
): boolean {
  return (
    validSidebarChannelId(sectionId) &&
    (name !== undefined || icon !== undefined) &&
    (name === undefined ||
      (typeof name === "string" && validSidebarChannelId(name))) &&
    (icon === undefined || icon === null || validSidebarSectionIcon(icon))
  );
}

export function validSidebarSectionOrder(
  sectionIds: readonly string[],
): boolean {
  return (
    validWorkspaceSectionOrder(sectionIds) ||
    (sectionIds.length <= MAX_WORKSPACES &&
      sectionIds.every(validSidebarChannelId) &&
      new Set(sectionIds).size === sectionIds.length)
  );
}

export function validSidebarSort(
  group: string,
  mode: SidebarSortMode,
  sectionIds: readonly string[],
): boolean {
  return (
    group.length <= 264 &&
    isSidebarSortMode(mode) &&
    sectionIds.length <= MAX_WORKSPACES &&
    sectionIds.every(validSidebarChannelId) &&
    (HOME_SIDEBAR_SECTIONS.some((home) => home === group) ||
      (group.startsWith("section:") && sectionIds.includes(group.slice(8))))
  );
}

export function validSidebarFilter(
  group: string,
  mode: SidebarFilterMode,
  sectionIds: readonly string[],
  activeWindowSeconds?: number | null,
): boolean {
  return (
    ["all", "unreads", "active"].includes(mode) &&
    (activeWindowSeconds === undefined ||
      (activeWindowSeconds === null
        ? mode === "all"
        : mode === "active" && validActiveWindow(activeWindowSeconds))) &&
    validSidebarSort(group, "alpha", sectionIds)
  );
}

// Pure edits of validated, projected heads. Hosts retain validation, signing,
// publication, readback and serialization; these functions never perform I/O.
export function editSidebarAssignment(
  current: Record<string, unknown>,
  createdAt: number,
  intent: SidebarAssignmentIntent,
  now = Date.now(),
): Record<string, unknown> {
  const { channelId, sectionId, createSection, reclaim } = intent;
  const section = createSection?.id ?? sectionId;
  const existing = current.sections as SidebarGroups["sections"];
  const sections = [...existing];
  if (createSection) {
    const name = createSection.name.trim();
    const found = sections.find((entry) => entry.id === section);
    // Retrying an unknown publication retains the ID, never duplicates or edits it.
    // Legacy name-only retries deliberately preserve an icon learned meanwhile.
    if (
      found &&
      (found.name !== name ||
        (createSection.icon !== undefined && found.icon !== createSection.icon))
    )
      throw new Error("The new section changed; reload and try again");
    if (!found)
      sections.push({
        id: createSection.id,
        name,
        ...(createSection.icon === undefined
          ? {}
          : { icon: createSection.icon }),
        order: nextSidebarSectionOrder(current, createSection.position),
      });
  }
  if (section !== undefined && !sections.some((entry) => entry.id === section))
    throw new Error("Sidebar group no longer exists");
  const writes: [string[], unknown][] =
    channelId === undefined ? [] : [[["a", channelId], section ?? null]];
  const assignments = current.assignments as SidebarGroups["assignments"];
  if (
    current.sectionOrder !== undefined &&
    channelId !== undefined &&
    section !== undefined &&
    reclaim &&
    !Object.hasOwn(assignments, channelId) &&
    Object.keys(assignments).length >= MAX_WORKSPACE_ASSIGNMENTS &&
    assignments[reclaim.channelId] === reclaim.sectionId
  )
    writes.push([["a", reclaim.channelId], null]);
  if (createSection && !existing.some(({ id }) => id === section)) {
    const added = sections.find(({ id }) => id === section);
    if (!added) throw new Error("Sidebar group no longer exists");
    writes.push(
      [["s", added.id, "name"], added.name],
      [["s", added.id, "icon"], added.icon ?? null],
      [["s", added.id, "order"], added.order],
      [["s", added.id, "live"], true],
    );
  }
  const next = editSidebarRecord(
    "channel-sections",
    current,
    createdAt,
    writes,
    now,
  );
  if (
    current.sectionOrder === undefined ||
    createSection?.position !== "first" ||
    existing.some(({ id }) => id === createSection.id)
  )
    return next;
  const key = `group:${createSection.id}`;
  const previous = workspaceSectionOrder(
    projectSidebarPreferences(
      current,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ),
  );
  const first = previous.findIndex((entry) => entry.startsWith("group:"));
  const order = [...previous];
  order.splice(first < 0 ? order.indexOf("starred") + 1 : first, 0, key);
  return { ...next, sectionOrder: order };
}

export function editSidebarSort(
  current: Record<string, unknown>,
  createdAt: number,
  group: string,
  mode: SidebarSortMode,
  now = Date.now(),
): Record<string, unknown> {
  return editSidebarSortRecord(current, createdAt, group, mode, now);
}

export function editSidebarFilter(
  current: Record<string, unknown>,
  createdAt: number,
  group: string,
  mode: SidebarFilterMode,
  now = Date.now(),
  activeWindowSeconds?: number | null,
): Record<string, unknown> {
  const windows = {
    ...(current.activeWindowSeconds as Record<string, number> | undefined),
  };
  const previous = windows[group] ?? DEFAULT_ACTIVE_WINDOW_SECONDS;
  const changed =
    activeWindowSeconds === null
      ? Object.hasOwn(windows, group)
      : activeWindowSeconds !== undefined && previous !== activeWindowSeconds;
  if (activeWindowSeconds === null) delete windows[group];
  else if (activeWindowSeconds !== undefined)
    windows[group] = activeWindowSeconds;
  const next = editSidebarRecord(
    "channel-filter",
    current,
    createdAt,
    [[["g", group], mode === "all" ? null : mode]],
    now,
  );
  return changed ? { ...next, activeWindowSeconds: windows } : next;
}

export function editSidebarToggle(
  current: Record<string, unknown>,
  channelId: string,
  field: "starred" | "muted",
  enabled: boolean,
  now = Date.now(),
): Record<string, unknown> {
  const channels = current.channels as Record<string, Record<string, unknown>>;
  const previous = Object.hasOwn(channels, channelId)
    ? channels[channelId]
    : undefined;
  // Absent unstars are satisfied; unmute must persist its explicit tombstone.
  if (
    previous?.[field] === enabled ||
    (!previous && !enabled && field === "starred")
  )
    return current;
  return {
    ...current,
    channels: {
      ...channels,
      [channelId]: {
        ...previous,
        [field]: enabled,
        updatedAt: Math.max(now, Number(previous?.updatedAt ?? 0) + 1),
      },
    },
  };
}
