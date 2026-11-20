import { isSidebarSortMode, type SidebarSortMode } from "./sidebar-sort.ts";
export type { SidebarSortMode } from "./sidebar-sort.ts";
import {
  MAX_WORKSPACES,
  MAX_WORKSPACE_ASSIGNMENTS,
  projectSidebarRecord,
  projectSidebarSort,
  workspaceTombstones,
  workspaceUnifiedOnly,
  encodeWorkspaceUnifiedOnly,
} from "./sidebar-registers.ts";
export {
  MAX_WORKSPACES,
  MAX_WORKSPACE_ASSIGNMENTS,
} from "./sidebar-registers.ts";
import type { ReadFilter } from "./events.ts";
import type { RelayEvent } from "./events.ts";
import type { RelayReader } from "./reader.ts";

export const WORKSPACE_COORDINATE = "channel-workspaces";
export const WORKSPACE_SORT_COORDINATE = "channel-workspace-sort";
export const WORKSPACE_FILTER_COORDINATE = "channel-workspace-filter";
export const HOME_SIDEBAR_SECTIONS = [
  "starred",
  "solo",
  "channels",
  "forums",
  "dms",
] as const;
/** Sidebar-placed pages, such as Activity, ordered among the sections. */
export const SIDEBAR_PAGES_SECTION = "pages";
export const SIDEBAR_COORDINATES = [
  "channel-sections",
  "channel-stars",
  "channel-mutes",
  "channel-sort",
  "channel-filter",
] as const;
/** Only the complete bounded account-preference batch may exceed the ordinary four-filter limit. */
export function isSidebarPreferencesBatch(
  filters: readonly ReadFilter[],
): boolean {
  const viewer = filters[0]?.authors?.[0];
  return (
    typeof viewer === "string" &&
    !!viewer &&
    filters.length === SIDEBAR_COORDINATES.length &&
    new Set(filters.map((filter) => sidebarBatchCoordinate(filter))).size ===
      SIDEBAR_COORDINATES.length &&
    filters.every(
      (filter) =>
        Array.isArray(filter?.kinds) &&
        filter.kinds.length === 1 &&
        filter.kinds[0] === 30078 &&
        Array.isArray(filter.authors) &&
        filter.authors.length === 1 &&
        filter.authors[0] === viewer &&
        Array.isArray(filter["#d"]) &&
        filter["#d"].length === 1 &&
        SIDEBAR_COORDINATES.includes(
          sidebarBatchCoordinate(
            filter,
          ) as (typeof SIDEBAR_COORDINATES)[number],
        ) &&
        filter.limit === 1 &&
        (filter.consistency === undefined || filter.consistency === "strong") &&
        Object.keys(filter).every((key) =>
          ["kinds", "authors", "#d", "limit", "consistency"].includes(key),
        ),
    )
  );
}
export const WORKSPACE_PREFERENCE_COORDINATES = [
  WORKSPACE_COORDINATE,
  "channel-stars",
  "channel-mutes",
  WORKSPACE_SORT_COORDINATE,
  WORKSPACE_FILTER_COORDINATE,
] as const;

function sidebarBatchCoordinate(filter: ReadFilter) {
  const coordinate = filter?.["#d"]?.[0];
  if (coordinate === WORKSPACE_COORDINATE) return "channel-sections";
  if (coordinate === WORKSPACE_SORT_COORDINATE) return "channel-sort";
  if (coordinate === WORKSPACE_FILTER_COORDINATE) return "channel-filter";
  return coordinate;
}

export type SidebarGroups = Readonly<{
  sections: readonly Readonly<{
    id: string;
    name: string;
    icon?: string;
    order: number;
  }>[];
  assignments: Readonly<Record<string, string>>;
  /** Sidebar section keys, including the home sections. */
  sectionOrder?: readonly string[];
  /** Frozen references used by workspaces saved before per-workspace templates. */
  legacyTemplates?: Readonly<Record<string, string>>;
}>;

export function workspaceBaseRecord(groups: SidebarGroups) {
  const normalized = projectWorkspaceGroups({
    version: 1,
    sections: groups.sections,
    assignments: groups.assignments,
    sectionOrder: groups.sectionOrder ?? [],
    ...(groups.legacyTemplates
      ? { legacyTemplates: groups.legacyTemplates }
      : {}),
  });
  return { version: 1, ...normalized };
}

export function decodeLegacyWorkspaceEnvelope(value: unknown): SidebarGroups {
  const data = object(value);
  return projectWorkspaceGroups({
    ...data,
    version: 1,
    sectionOrder: data.sectionOrder ?? [],
  });
}

type WorkspaceRecord = SidebarGroups & {
  version: 1;
  sectionOrder: readonly string[];
  removedSections?: readonly string[];
  unfiled?: readonly string[];
  unifiedOnly?: string;
  legacyImportClosed?: true;
};

/** A retained marker survives later changes to either legacy head. */
export function workspaceRecordForWrite(
  payload: Record<string, unknown>,
  legacy: SidebarGroups | undefined,
  previous: Record<string, unknown> = {},
): WorkspaceRecord {
  const groups = projectWorkspaceGroups(payload);
  const live = new Set(groups.sections.map(({ id }) => id));
  const layout = {
    ...groups,
    version: 1 as const,
    sectionOrder:
      groups.sectionOrder?.filter(
        (key) => !key.startsWith("group:") || live.has(key.slice(6)),
      ) ?? [],
  };
  if (previous.legacyImportClosed === true)
    return { ...layout, legacyImportClosed: true };
  const legacySections = legacy && new Set(legacy.sections.map(({ id }) => id));
  const previousRemovals = new Set(
    workspaceTombstones(previous, "removedSections"),
  );
  const previousUnfiled = new Set(workspaceTombstones(previous, "unfiled"));
  const previousSections = new Set(
    (previous.sections as SidebarGroups["sections"] | undefined)?.map(
      ({ id }) => id,
    ),
  );
  const previousAssignments = previous.assignments as
    | SidebarGroups["assignments"]
    | undefined;
  const unifiedOnly = workspaceUnifiedOnly(previous);
  const fromLegacySection = (id: string) =>
    previousRemovals.has(id) ||
    legacySections?.has(id) ||
    (previousSections.has(id) && !unifiedOnly.sections.has(id));
  const legacyTarget = (id: string) =>
    legacy && Object.hasOwn(legacy.assignments, id)
      ? legacy.assignments[id]
      : undefined;
  const priorTarget = (id: string) =>
    previousAssignments && Object.hasOwn(previousAssignments, id)
      ? previousAssignments[id]
      : undefined;
  const removedSections = workspaceTombstones(
    payload,
    "removedSections",
  ).filter(fromLegacySection);
  const removed = new Set(removedSections);
  const unfiled = workspaceTombstones(payload, "unfiled").filter((id) => {
    if (previousUnfiled.has(id)) return true;
    const prior = priorTarget(id);
    const target = legacyTarget(id);
    // A tombstone for a legacy section covers its removed filings. A known
    // legacy filing unfiled on its own must survive a temporary legacy absence.
    return (
      (prior && !unifiedOnly.assignments.has(id) && !removed.has(prior)) ||
      (target && !removed.has(target))
    );
  });
  const result = {
    ...layout,
    ...(removedSections.length ? { removedSections } : {}),
    ...(unfiled.length ? { unfiled } : {}),
  };
  const origins = {
    sections: new Set([...live].filter((id) => !fromLegacySection(id))),
    assignments: new Set(
      Object.keys(groups.assignments).filter(
        (id) =>
          !legacyTarget(id) &&
          !previousUnfiled.has(id) &&
          (!priorTarget(id) || unifiedOnly.assignments.has(id)),
      ),
    ),
  };
  const provenance = encodeWorkspaceUnifiedOnly(result, origins);
  return { ...result, ...(provenance ? { unifiedOnly: provenance } : {}) };
}

const hexConversationId = /^[0-9a-f]{64}$/;

function packConversationId(id: string) {
  if (hexConversationId.test(id)) {
    const bytes =
      id.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
    return `~${btoa(String.fromCharCode(...bytes)).slice(0, -1)}`;
  }
  return id.startsWith("~") ? `~${id}` : id;
}

function unpackConversationId(id: string) {
  if (id.startsWith("~~")) return id.slice(1);
  if (!id.startsWith("~") && !hexConversationId.test(id)) return id;
  if (!/^~[A-Za-z0-9+/]{43}$/.test(id))
    throw new Error("Invalid compact workspace filing");
  const bytes = atob(id.slice(1));
  if (`~${btoa(bytes).slice(0, -1)}` !== id)
    throw new Error("Invalid compact workspace filing");
  return Array.from(bytes, (byte) =>
    byte.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
}

/** Expand compact filings before applying migration fallbacks or an edit. */
export function expandWorkspaceRecord(value: unknown): Record<string, unknown> {
  const data = object(value);
  if (data.filings === undefined) {
    if (data.packedUnfiled !== undefined)
      throw new Error("Invalid compact workspace removal markers");
    return projectSidebarRecord("channel-sections", data);
  }
  if (data.assignments !== undefined || data.meta !== undefined)
    throw new Error("Invalid compact workspace filings");
  const { filings, packedUnfiled, ...record } = data;
  if (packedUnfiled !== undefined) {
    if (record.unfiled !== undefined || !Array.isArray(packedUnfiled))
      throw new Error("Invalid compact workspace removal markers");
    record.unfiled = packedUnfiled.map((id) =>
      text(unpackConversationId(text(id, 257))),
    );
  }
  const entries = Object.entries(object(filings));
  if (entries.length > MAX_WORKSPACES || !Array.isArray(record.sections))
    throw new Error("Invalid compact workspace filings");
  const workspaceIds = new Set(
    record.sections.map((section) => object(section).id),
  );
  const assignments = new Map<string, string>();
  for (const [section, rows] of entries) {
    text(section);
    if (!workspaceIds.has(section) || !Array.isArray(rows) || !rows.length)
      throw new Error("Invalid compact workspace filings");
    for (const row of rows) {
      const id = text(unpackConversationId(text(row, 257)));
      if (
        id === "__proto__" ||
        assignments.has(id) ||
        assignments.size >= MAX_WORKSPACE_ASSIGNMENTS
      )
        throw new Error("Invalid compact workspace filings");
      assignments.set(id, section);
    }
  }
  return { ...record, assignments: Object.fromEntries(assignments) };
}

function workspaceRecordFits(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length <= 128 * 1024;
}

/** Compact filings and history together before considering closing legacy import. */
export function workspacePayloadForSigning(
  payload: Record<string, unknown>,
  legacy: SidebarGroups | undefined,
  previous?: Record<string, unknown>,
) {
  const record = workspaceRecordForWrite(payload, legacy, previous);
  const packed = compactWorkspaceRecord(record);
  if (workspaceRecordFits(packed)) return packed;

  // Close catch-up only from a complete legacy read, and only when every
  // legacy leaf is already represented or intentionally suppressed.
  if (legacy && legacyWorkspaceCoverageComplete(record, legacy)) {
    const {
      removedSections: _removed,
      unfiled: _unfiled,
      unifiedOnly: _unifiedOnly,
      ...layout
    } = record;
    const closed = compactWorkspaceRecord({
      ...layout,
      legacyImportClosed: true,
    });
    if (workspaceRecordFits(closed)) return closed;
  }
  throw new Error("Saved workspaces exceed the storage limit.");
}

function legacyWorkspaceCoverageComplete(
  record: SidebarGroups & {
    removedSections?: readonly string[];
    unfiled?: readonly string[];
  },
  legacy: SidebarGroups,
) {
  const sections = new Set(record.sections.map(({ id }) => id));
  const removed = new Set(record.removedSections);
  const unfiled = new Set(record.unfiled);
  return (
    legacy.sections.every(({ id }) => sections.has(id) || removed.has(id)) &&
    Object.entries(legacy.assignments).every(
      ([id, section]) =>
        Object.hasOwn(record.assignments, id) ||
        unfiled.has(id) ||
        removed.has(section),
    )
  );
}

export function encodeLegacyWorkspaceEnvelope(groups: SidebarGroups) {
  return compactWorkspaceRecord(workspaceBaseRecord(groups));
}

function compactWorkspaceRecord<
  T extends SidebarGroups & { unfiled?: readonly string[] },
>(record: T) {
  if (workspaceRecordFits(record)) return record;
  const { assignments, ...metadata } = record;
  const filings = new Map<string, string[]>();
  for (const [id, section] of Object.entries(assignments)) {
    const packed = packConversationId(id);
    const rows = filings.get(section);
    if (rows) rows.push(packed);
    else filings.set(section, [packed]);
  }
  const compact = { ...metadata, filings: Object.fromEntries(filings) };
  const unfiled = record.unfiled ?? [];
  if (!unfiled.length || workspaceRecordFits(compact)) return compact;
  const packedUnfiled = unfiled.map(packConversationId);
  if (JSON.stringify(packedUnfiled).length >= JSON.stringify(unfiled).length)
    return compact;
  const { unfiled: _unfiled, ...rest } = compact;
  return { ...rest, packedUnfiled };
}

export function projectWorkspacePreferences(
  workspaces: unknown,
  stars?: unknown,
  mutes?: unknown,
  sort?: unknown,
  filters?: unknown,
) {
  return projectSidebarPreferences(
    workspaces,
    stars,
    mutes,
    sort,
    undefined,
    filters,
    true,
  );
}

export function projectWorkspaceGroups(workspaces: unknown): SidebarGroups {
  const { sections, assignments, sectionOrder, legacyTemplates } =
    projectWorkspacePreferences(workspaces);
  return {
    sections,
    assignments,
    ...(sectionOrder ? { sectionOrder } : {}),
    ...(legacyTemplates ? { legacyTemplates } : {}),
  };
}

export function workspaceSectionOrder(
  groups: Pick<SidebarGroups, "sections" | "sectionOrder"> | undefined,
): readonly string[] {
  const [starred, solo, ...rest] = HOME_SIDEBAR_SECTIONS;
  // Forums list under Channels; "forums" stays valid in saved preferences.
  const otherHomes = rest.filter((key) => key !== "forums");
  const home = [solo, ...otherHomes];
  const defaults = [
    SIDEBAR_PAGES_SECTION,
    solo,
    starred,
    ...(groups?.sections ?? []).map(({ id }) => `group:${id}`),
    ...otherHomes,
  ];
  if (!groups?.sectionOrder?.length) return defaults;
  const available = new Set(defaults);
  const order = groups.sectionOrder.filter((key) => available.delete(key));
  if (available.delete(starred)) order.unshift(starred);
  if (available.delete(SIDEBAR_PAGES_SECTION))
    order.unshift(SIDEBAR_PAGES_SECTION);
  // Workspaces added since the last reorder follow the existing workspaces.
  const newWorkspaces = defaults.filter(
    (key) => key.startsWith("group:") && available.has(key),
  );
  const lastWorkspace = order.lastIndexOf(
    order.filter((key) => key.startsWith("group:")).at(-1) ?? "",
  );
  const insertion = lastWorkspace + 1 || order.indexOf(starred) + 1;
  order.splice(insertion, 0, ...newWorkspaces);
  return [...order, ...home.filter((key) => available.has(key))];
}

export function validWorkspaceSectionOrder(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_WORKSPACES + HOME_SIDEBAR_SECTIONS.length + 1 &&
    new Set(value).size === value.length &&
    value.every(
      (key) =>
        typeof key === "string" &&
        (key === SIDEBAR_PAGES_SECTION ||
          HOME_SIDEBAR_SECTIONS.some((home) => home === key) ||
          (key.startsWith("group:") &&
            !!key.slice(6).trim() &&
            key.length <= 262)),
    )
  );
}
export type SidebarFilterMode = "all" | "unreads" | "active";
export const DEFAULT_ACTIVE_WINDOW_SECONDS = 30 * 86400;
export const MAX_ACTIVE_WINDOW_SECONDS = 365 * 86400;
export function validActiveWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 86400 &&
    value <= MAX_ACTIVE_WINDOW_SECONDS &&
    value % 86400 === 0
  );
}
export type SidebarFilterSettings = Readonly<{
  filters: Readonly<Record<string, SidebarFilterMode>>;
  activeWindowSeconds: Readonly<Record<string, number>>;
}>;
export type SidebarFilterMutator = (
  group: string,
  mode: SidebarFilterMode,
  sectionIds: readonly string[],
  signal: AbortSignal,
  activeWindowSeconds?: number | null,
) => Promise<SidebarFilterSettings>;
export type SidebarSortMutator = (
  group: string,
  mode: SidebarSortMode,
  sectionIds: readonly string[],
  signal: AbortSignal,
) => Promise<Readonly<Record<string, SidebarSortMode>>>;
export type SidebarMuteMutator = (
  intent: Readonly<{ channelId: string; muted: boolean }>,
  signal: AbortSignal,
) => Promise<readonly string[]>;
export type SidebarPreferences = SidebarGroups &
  Readonly<{
    starred: readonly string[];
    muted: readonly string[];
    sort?: Readonly<Record<string, SidebarSortMode>>;
    filters?: Readonly<Record<string, SidebarFilterMode>>;
    activeWindowSeconds?: Readonly<Record<string, number>>;
    /** A first write still needs both verified legacy workspace records. */
    workspaceMigrationPending?: true;
    /** Workspace IDs from the old Solo sidebar, read from its legacy record. */
    soloWorkspaces?: readonly string[];
  }>;
export type SidebarSectionDraft = Readonly<{
  id: string;
  name: string;
  icon?: string;
}>;
/** At least one field is supplied; omission preserves the latest saved value. */
export type SidebarSectionEdit = Readonly<{
  name?: string | undefined;
  icon?: string | null | undefined;
}>;
export type SidebarAssignmentIntent = Readonly<{
  /** Omit only when creating an empty section. */
  channelId?: string;
  sectionId?: string;
  createSection?: SidebarSectionDraft & Readonly<{ position?: "first" }>;
  /** A verified archived chat filing that may make room for one new filing. */
  reclaim?: Readonly<{ channelId: string; sectionId: string }>;
}>;
export type SidebarAssignmentMutator = (
  intent: SidebarAssignmentIntent,
  signal: AbortSignal,
  legacy?: SidebarGroups,
) => Promise<SidebarGroups>;
export type SidebarSectionRemovalMutator = (
  sectionId: string,
  signal: AbortSignal,
  legacy?: SidebarGroups,
) => Promise<SidebarGroups>;
export type SidebarSectionRenameMutator = (
  intent: SidebarSectionEdit &
    Readonly<{ sectionId: string; expectedName?: string }>,
  signal: AbortSignal,
  legacy?: SidebarGroups,
) => Promise<SidebarGroups>;
export type SidebarSectionOrderMutator = (
  sectionIds: readonly string[],
  signal: AbortSignal,
  legacy?: SidebarGroups,
) => Promise<SidebarGroups>;
/** Adds an empty section without assigning a conversation. */
export type SidebarSectionCreationMutator = (
  section: SidebarSectionDraft,
  signal: AbortSignal,
) => Promise<SidebarGroups>;
export type SidebarStarMutator = (
  intent: Readonly<{ channelId: string; starred: boolean }>,
  signal: AbortSignal,
) => Promise<readonly string[]>;
export type SidebarDecoder = (
  events: readonly RelayEvent[],
  signal: AbortSignal,
  legacyWorkspaces?: SidebarGroups,
) => Promise<SidebarPreferences>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid sidebar preferences");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid sidebar preference text");
  return value;
}
/** Read-only legacy projection. Never merge, migrate, or publish account preferences. */
export function projectSidebarPreferences(
  sections: unknown,
  stars: unknown,
  mutes?: unknown,
  sort?: unknown,
  sortSectionIds?: readonly string[],
  filters?: unknown,
  workspaceRecord = false,
): SidebarPreferences {
  const result: {
    sections: { id: string; name: string; icon?: string; order: number }[];
    assignments: Record<string, string>;
    sectionOrder?: readonly string[];
    legacyTemplates?: Readonly<Record<string, string>>;
    starred: string[];
    sort?: Record<string, SidebarSortMode>;
    filters?: Record<string, SidebarFilterMode>;
    activeWindowSeconds?: Record<string, number>;
    muted: string[];
  } = {
    sections: [],
    assignments: {},
    starred: [],
    muted: [],
  };
  if (sections !== undefined) {
    const data = workspaceRecord
      ? expandWorkspaceRecord(sections)
      : projectSidebarRecord("channel-sections", object(sections));
    if (
      data.version !== 1 ||
      !Array.isArray(data.sections) ||
      data.sections.length > (workspaceRecord ? MAX_WORKSPACES : 100)
    )
      throw new Error("Unsupported sidebar groups");
    const ids = new Set<string>();
    result.sections = data.sections
      .map((raw) => {
        const entry = object(raw);
        const id = text(entry.id);
        if (
          ids.has(id) ||
          typeof entry.order !== "number" ||
          !Number.isFinite(entry.order)
        )
          throw new Error("Invalid sidebar group order");
        ids.add(id);
        return {
          id,
          name: text(entry.name),
          order: entry.order,
          ...(entry.icon === undefined ? {} : { icon: text(entry.icon, 128) }),
        };
      })
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const assignments = Object.entries(object(data.assignments));
    if (
      assignments.length > (workspaceRecord ? MAX_WORKSPACE_ASSIGNMENTS : 1000)
    )
      throw new Error("Sidebar assignment budget exceeded");
    result.assignments = Object.fromEntries(
      assignments
        .map(([id, section]) => [text(id), text(section)])
        .filter(([, section]) => ids.has(section as string)),
    );
    if (workspaceRecord) {
      if (!validWorkspaceSectionOrder(data.sectionOrder))
        throw new Error("Invalid workspace section order");
      result.sectionOrder = data.sectionOrder;
      workspaceTombstones(data, "removedSections");
      workspaceTombstones(data, "unfiled");
      workspaceUnifiedOnly(data);
      if (
        data.legacyImportClosed !== undefined &&
        (data.legacyImportClosed !== true ||
          ["removedSections", "unfiled", "unifiedOnly"].some((key) =>
            Object.hasOwn(data, key),
          ))
      )
        throw new Error("Invalid workspace legacy import state");
      if (data.legacyTemplates !== undefined) {
        const templates = Object.entries(object(data.legacyTemplates));
        if (
          templates.length > MAX_WORKSPACES ||
          templates.some(
            ([id, template]) =>
              !id.trim() ||
              id.length > 256 ||
              typeof template !== "string" ||
              !/^[a-zA-Z0-9_-]{1,128}$/.test(template),
          )
        )
          throw new Error("Invalid workspace template references");
        result.legacyTemplates = Object.fromEntries(
          templates.flatMap(([id, value]) =>
            ids.has(id) && typeof value === "string" ? [[id, value]] : [],
          ),
        );
      }
    }
  }
  if (stars !== undefined) {
    const data = object(stars);
    if (data.version !== 1) throw new Error("Unsupported sidebar stars");
    const entries = Object.entries(object(data.channels));
    if (entries.length > 500) throw new Error("Sidebar star budget exceeded");
    for (const [id, raw] of entries) {
      text(id);
      const entry = object(raw);
      if (
        typeof entry.starred !== "boolean" ||
        typeof entry.updatedAt !== "number" ||
        !Number.isFinite(entry.updatedAt) ||
        entry.updatedAt < 0
      )
        throw new Error("Invalid sidebar star");
      if (entry.starred) result.starred.push(id);
    }
  }
  if (sort !== undefined) {
    const data = object(sort);
    if (data.version !== 1) throw new Error("Unsupported sidebar sort");
    const entries = Object.entries(
      projectSidebarSort(data, workspaceRecord ? 205 : 104),
    );
    const fixed = new Set<string>(HOME_SIDEBAR_SECTIONS);
    const liveSections = new Set(
      (sortSectionIds ?? []).map((id) => `section:${id}`),
    );
    result.sort = Object.fromEntries(
      entries
        .filter((entry): entry is [string, SidebarSortMode] =>
          isSidebarSortMode(entry[1]),
        )
        .map(([key, mode]) => [text(key, 264), mode] as const)
        .filter(
          ([key]) =>
            fixed.has(key) ||
            liveSections.has(key) ||
            (sortSectionIds === undefined &&
              key.startsWith("section:") &&
              key.length > 8),
        ),
    );
  }
  if (filters !== undefined) {
    const data = projectSidebarRecord("channel-filter", object(filters));
    if (data.version !== 1) throw new Error("Unsupported sidebar filter");
    const entries = Object.entries(object(data.groups));
    if (entries.length > (workspaceRecord ? 205 : 104))
      throw new Error("Sidebar filter budget exceeded");
    const fixed = new Set<string>(HOME_SIDEBAR_SECTIONS);
    const liveSections = new Set(
      (sortSectionIds ?? []).map((id) => `section:${id}`),
    );
    if (
      entries.some(
        ([, mode]) => mode !== "all" && mode !== "unreads" && mode !== "active",
      )
    )
      throw new Error("Invalid sidebar filter mode");
    const windows = Object.entries(
      object(
        data.activeWindowSeconds === undefined ? {} : data.activeWindowSeconds,
      ),
    );
    if (
      windows.length > (workspaceRecord ? 205 : 104) ||
      windows.some(([, value]) => !validActiveWindow(value))
    )
      throw new Error("Invalid sidebar activity window");
    result.activeWindowSeconds = Object.fromEntries(
      windows
        .map(([key, value]) => [text(key, 264), value as number] as const)
        .filter(
          ([key]) =>
            fixed.has(key) ||
            liveSections.has(key) ||
            (sortSectionIds === undefined &&
              key.startsWith("section:") &&
              key.length > 8),
        ),
    );
    result.filters = Object.fromEntries(
      entries
        .filter(
          (entry): entry is [string, SidebarFilterMode] =>
            entry[1] === "all" ||
            entry[1] === "unreads" ||
            entry[1] === "active",
        )
        .map(([key, mode]) => [text(key, 264), mode] as const)
        .filter(
          ([key]) =>
            fixed.has(key) ||
            liveSections.has(key) ||
            (sortSectionIds === undefined &&
              key.startsWith("section:") &&
              key.length > 8),
        ),
    );
  }
  if (mutes !== undefined) {
    const data = object(mutes);
    if (data.version !== 1) throw new Error("Unsupported channel mutes");
    const entries = Object.entries(object(data.channels));
    if (entries.length > 500) throw new Error("Channel mute budget exceeded");
    for (const [id, raw] of entries) {
      text(id);
      const entry = object(raw);
      if (
        typeof entry.muted !== "boolean" ||
        typeof entry.updatedAt !== "number" ||
        !Number.isFinite(entry.updatedAt) ||
        entry.updatedAt < 0
      )
        throw new Error("Invalid channel mute");
      if (entry.muted) result.muted.push(id);
    }
  }
  return result;
}

export async function readSidebarPreferences(
  reader: RelayReader,
  viewer: string,
  decode: SidebarDecoder,
  signal: AbortSignal,
  consistency?: "strong",
  workspaceMigration = false,
): Promise<SidebarPreferences> {
  let events: readonly RelayEvent[];
  try {
    const read = (coordinates: readonly string[]) =>
      reader.read(
        coordinates.map((coordinate) => ({
          kinds: [30078],
          authors: [viewer],
          "#d": [coordinate],
          limit: 1,
          ...(consistency ? { consistency } : {}),
        })),
        {
          signal,
          priority: "foreground",
          ...(consistency ? { fresh: true } : {}),
        },
      );
    events = await read(
      workspaceMigration
        ? WORKSPACE_PREFERENCE_COORDINATES
        : SIDEBAR_COORDINATES,
    );
    if (workspaceMigration) {
      // A new preference coordinate supersedes only its own legacy choice.
      const present = new Set(
        events.flatMap((event) =>
          event.tags.flatMap(([key, value]) =>
            key === "d" && value ? [value] : [],
          ),
        ),
      );
      const legacy = [
        ...(!present.has(WORKSPACE_SORT_COORDINATE) ? ["channel-sort"] : []),
        ...(!present.has(WORKSPACE_FILTER_COORDINATE)
          ? ["channel-filter"]
          : []),
      ];
      if (legacy.length) events = [...events, ...(await read(legacy))];
    }
    signal.throwIfAborted();
  } catch (error) {
    const cause = signal.aborted ? signal.reason : error;
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new Error(
      `Preference query: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  try {
    const result = await decode(events, signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    const cause = signal.aborted ? signal.reason : error;
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new Error(
      `Preference decode: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
