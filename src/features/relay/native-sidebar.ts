import {
  importWorkspaceFallback,
  projectSidebarRecord,
} from "./sidebar-registers";
import {
  editSidebarAssignment,
  editSidebarSectionOrder,
  editSidebarSectionRemoval,
  editSidebarSectionRename,
  validSidebarSectionOrder,
  validSidebarSectionRemoval,
  validSidebarSectionRename,
  editSidebarSort,
  editSidebarFilter,
  editSidebarToggle,
  validSidebarAssignment,
  validSidebarChannelId,
  validSidebarSort,
  validSidebarFilter,
} from "./sidebar-edits";
import { invoke } from "@tauri-apps/api/core";
import { eventDto, type RelayEvent } from "./events";
import {
  projectSidebarPreferences,
  projectWorkspacePreferences,
  projectWorkspaceGroups,
  WORKSPACE_COORDINATE,
  WORKSPACE_SORT_COORDINATE,
  WORKSPACE_FILTER_COORDINATE,
  workspaceBaseRecord,
  expandWorkspaceRecord,
  workspacePayloadForSigning,
  type SidebarAssignmentIntent,
  type SidebarGroups,
  type SidebarSectionEdit,
  type SidebarSortMode,
  type SidebarFilterMode,
} from "./sidebar-preferences";
import type { ReadTransport } from "./transport";

const coordinates = [
  "channel-sections",
  WORKSPACE_COORDINATE,
  "channel-stars",
  "channel-mutes",
  "channel-sort",
  "channel-filter",
  WORKSPACE_SORT_COORDINATE,
  WORKSPACE_FILTER_COORDINATE,
  "main-agent",
] as const;
type Coordinate = (typeof coordinates)[number];
type Head = { payload: Record<string, unknown>; createdAt: number };
const empty = (coordinate: Coordinate): Record<string, unknown> =>
  coordinate === "main-agent"
    ? { version: 1, agent: null }
    : coordinate === "channel-sections"
      ? { version: 1, sections: [], assignments: {} }
      : coordinate.endsWith("-sort") || coordinate.endsWith("-filter")
        ? { version: 1, groups: {} }
        : { version: 1, channels: {} };
const agentKey = /^[0-9a-f]{64}$/;
/** The main agent the viewer chose. A null one, written by development
 * builds that cleared it, is read as none. */
function mainAgent(value: Record<string, unknown>) {
  const { version, agent, ...rest } = value;
  if (
    version !== 1 ||
    Object.keys(rest).length ||
    (agent !== null && !(typeof agent === "string" && agentKey.test(agent)))
  )
    throw new Error("Invalid main agent record");
  return agent ?? undefined;
}
const cancelled = (signal: AbortSignal) => signal.throwIfAborted();
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function nativeSidebar(transport: ReadTransport) {
  const viewer = transport.viewer;
  const writer = transport.writer;
  // Session store serializes its writers. A separate session or device can still race
  // this whole-record read/replace; readback verifies the requested intent only.
  async function decode(
    events: readonly RelayEvent[],
    signal: AbortSignal,
    legacy?: SidebarGroups,
  ) {
    cancelled(signal);
    const raw = await invoke<Record<string, unknown>>("relay_decode_sidebar", {
      events,
    });
    cancelled(signal);
    if (raw[WORKSPACE_COORDINATE] !== undefined) {
      const workspaces = importWorkspaceFallback(
        expandWorkspaceRecord(raw[WORKSPACE_COORDINATE]),
        legacy,
      );
      return projectWorkspacePreferences(
        workspaces,
        raw["channel-stars"],
        raw["channel-mutes"],
        raw[WORKSPACE_SORT_COORDINATE] ?? raw["channel-sort"],
        raw[WORKSPACE_FILTER_COORDINATE] ?? raw["channel-filter"],
      );
    }
    if (raw[WORKSPACE_SORT_COORDINATE] || raw[WORKSPACE_FILTER_COORDINATE])
      return projectWorkspacePreferences(
        undefined,
        raw["channel-stars"],
        raw["channel-mutes"],
        raw[WORKSPACE_SORT_COORDINATE] ?? raw["channel-sort"],
        raw[WORKSPACE_FILTER_COORDINATE] ?? raw["channel-filter"],
      );
    return projectSidebarPreferences(
      raw["channel-sections"],
      raw["channel-stars"],
      raw["channel-mutes"],
      raw["channel-sort"],
      undefined,
      raw["channel-filter"],
    );
  }
  async function head(
    coordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<Head> {
    cancelled(signal);
    const events = await transport.query(
      [
        {
          kinds: [30078],
          authors: [viewer],
          "#d": [coordinate],
          limit: 1,
          consistency: "strong",
        },
      ],
      signal,
    );
    cancelled(signal);
    if (!events.length) return { payload: empty(coordinate), createdAt: 0 };
    const raw = await invoke<Record<string, unknown>>("relay_decode_sidebar", {
      events,
    });
    cancelled(signal);
    const payload = raw[coordinate];
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid sidebar record");
    // The Rust decoder checks signature, author, coordinate and plaintext budget.
    const value = payload as Record<string, unknown>;
    if (coordinate === "main-agent") mainAgent(value);
    else project(coordinate, value);
    return {
      payload:
        coordinate === WORKSPACE_COORDINATE
          ? expandWorkspaceRecord(value)
          : coordinate === "channel-sections"
            ? projectSidebarRecord("channel-sections", value)
            : coordinate === WORKSPACE_SORT_COORDINATE ||
                coordinate === "channel-sort"
              ? projectSidebarRecord("channel-sort", value)
              : coordinate === WORKSPACE_FILTER_COORDINATE ||
                  coordinate === "channel-filter"
                ? projectSidebarRecord("channel-filter", value)
                : value,
      createdAt: events[0]?.created_at ?? 0,
    };
  }
  function project(
    coordinate: Coordinate,
    value: unknown,
    sectionIds?: readonly string[],
  ) {
    if (coordinate === WORKSPACE_COORDINATE)
      return projectWorkspacePreferences(value);
    return projectSidebarPreferences(
      coordinate === "channel-sections" ? value : undefined,
      coordinate === "channel-stars" ? value : undefined,
      coordinate === "channel-mutes" ? value : undefined,
      coordinate === "channel-sort" || coordinate === WORKSPACE_SORT_COORDINATE
        ? value
        : undefined,
      sectionIds,
      coordinate === "channel-filter" ||
        coordinate === WORKSPACE_FILTER_COORDINATE
        ? value
        : undefined,
      coordinate === WORKSPACE_SORT_COORDINATE ||
        coordinate === WORKSPACE_FILTER_COORDINATE,
    );
  }
  async function mutate<T>(
    coordinate: Coordinate,
    signal: AbortSignal,
    prepare: (
      current: Record<string, unknown>,
      createdAt: number,
    ) => {
      next: Record<string, unknown>;
      result: T;
      /** Write a record even where none exists and `next` matches the empty
       * value, as saving none does. */
      record?: boolean;
    },
    confirms: (current: Record<string, unknown>) => boolean,
    conflict: string,
    legacy?: SidebarGroups,
  ): Promise<T> {
    const current = await head(coordinate, signal);
    const fallback =
      coordinate === WORKSPACE_SORT_COORDINATE
        ? "channel-sort"
        : coordinate === WORKSPACE_FILTER_COORDINATE
          ? "channel-filter"
          : undefined;
    const base =
      fallback && !current.createdAt ? await head(fallback, signal) : current;
    const withLegacy = (head: Head) => {
      if (coordinate !== WORKSPACE_COORDINATE) return head.payload;
      if (head.createdAt) return importWorkspaceFallback(head.payload, legacy);
      if (!legacy)
        throw new Error("Saved workspaces are unavailable. Try again.");
      return workspaceBaseRecord(legacy);
    };
    const payload = withLegacy(base);
    const draft = prepare(payload, base.createdAt);
    const unchanged =
      same(payload, draft.next) && (current.createdAt > 0 || !draft.record);
    if (unchanged) return draft.result;
    // Reject unsupported/over-budget writes at the existing projection boundary.
    if (coordinate === "main-agent") mainAgent(draft.next);
    else project(coordinate, draft.next);
    const next =
      coordinate === WORKSPACE_COORDINATE
        ? workspacePayloadForSigning(draft.next, legacy, payload)
        : draft.next;
    if (new TextEncoder().encode(JSON.stringify(next)).length > 128 * 1024)
      throw new Error("Sidebar plaintext budget exceeded");
    const event = eventDto(
      await invoke<unknown>("relay_sign_sidebar", {
        coordinate,
        payload: next,
        createdAt: Math.max(Math.floor(Date.now() / 1000), base.createdAt + 1),
      }),
    );
    cancelled(signal);
    if (!writer) throw new Error("Native relay writer is unavailable");
    await writer.publish(event, signal);
    const confirmed = await head(coordinate, signal);
    const value = withLegacy(confirmed);
    if (!confirms(value)) throw new Error(conflict);
    return prepare(value, confirmed.createdAt).result;
  }
  return {
    decodeSidebarPreferences: decode,
    workspaceMigration: true as const,
    async readMainAgent(signal: AbortSignal) {
      const current = await head("main-agent", signal);
      // A record of none reads as null, apart from no record at all.
      return current.createdAt
        ? (mainAgent(current.payload) ?? null)
        : undefined;
    },
    async writeMainAgent(agent: string | null, signal: AbortSignal) {
      if (agent !== null && !agentKey.test(agent))
        throw new Error("Invalid main agent intent");
      await mutate(
        "main-agent",
        signal,
        // A saved none matches the empty value but is still a record, unlike
        // none at all, so it is written even then.
        () => ({
          next: { version: 1, agent },
          result: undefined,
          record: true,
        }),
        (value) => value.agent === agent,
        "The main agent changed on another device; reload and try again",
      );
    },
    async clearMainAgent(expected: string, signal: AbortSignal) {
      if (!agentKey.test(expected))
        throw new Error("Invalid main agent intent");
      return mutate(
        "main-agent",
        signal,
        (current) => {
          const agent = mainAgent(current);
          return agent === expected
            ? { next: { version: 1, agent: null }, result: undefined }
            : { next: current, result: agent };
        },
        (value) => mainAgent(value) !== expected,
        "The main agent changed on another device; reload and try again",
      );
    },
    async removeSidebarSection(
      sectionId: string,
      signal: AbortSignal,
      legacy?: SidebarGroups,
    ): Promise<SidebarGroups> {
      if (!validSidebarSectionRemoval(sectionId))
        throw new Error("Invalid sidebar section removal intent");
      const prepare = (current: Record<string, unknown>, createdAt: number) => {
        const next = editSidebarSectionRemoval(current, createdAt, sectionId);
        return { next, result: projectWorkspaceGroups(next) };
      };
      return mutate(
        WORKSPACE_COORDINATE,
        signal,
        prepare,
        (value) => {
          const { sections, assignments } = project(
            WORKSPACE_COORDINATE,
            value,
          );
          return (
            !sections.some(({ id }) => id === sectionId) &&
            !Object.values(assignments).includes(sectionId)
          );
        },
        "Sidebar groups changed on another device; reload and try again",
        legacy,
      );
    },
    async renameSidebarSection(
      intent: SidebarSectionEdit &
        Readonly<{ sectionId: string; expectedName?: string }>,
      signal: AbortSignal,
      legacy?: SidebarGroups,
    ): Promise<SidebarGroups> {
      const { sectionId, name, icon } = intent;
      if (!validSidebarSectionRename(sectionId, name, icon))
        throw new Error("Invalid sidebar section edit intent");
      const edit = intent;
      const prepare = (current: Record<string, unknown>, createdAt: number) => {
        const next = editSidebarSectionRename(
          current,
          createdAt,
          sectionId,
          edit,
        );
        return { next, result: projectWorkspaceGroups(next) };
      };
      return mutate(
        WORKSPACE_COORDINATE,
        signal,
        prepare,
        (value) =>
          same(value, editSidebarSectionRename(value, 0, sectionId, edit)),
        "Sidebar groups changed on another device; reload and try again",
        legacy,
      );
    },
    async writeSidebarSectionOrder(
      sectionIds: readonly string[],
      signal: AbortSignal,
      legacy?: SidebarGroups,
    ): Promise<SidebarGroups> {
      if (!validSidebarSectionOrder(sectionIds))
        throw new Error("Invalid sidebar section order intent");
      const prepare = (current: Record<string, unknown>, createdAt: number) => {
        const next = editSidebarSectionOrder(current, createdAt, sectionIds);
        return { next, result: projectWorkspaceGroups(next) };
      };
      return mutate(
        WORKSPACE_COORDINATE,
        signal,
        prepare,
        (value) => same(value, editSidebarSectionOrder(value, 0, sectionIds)),
        "Sidebar groups changed on another device; reload and try again",
        legacy,
      );
    },
    async writeSidebarAssignment(
      intent: SidebarAssignmentIntent,
      signal: AbortSignal,
      legacy?: SidebarGroups,
    ): Promise<SidebarGroups> {
      const { channelId, sectionId, createSection } = intent;
      if (!validSidebarAssignment(intent))
        throw new Error("Invalid sidebar assignment intent");
      const section = createSection?.id ?? sectionId;
      const prepare = (current: Record<string, unknown>, createdAt: number) => {
        const next = editSidebarAssignment(current, createdAt, intent);
        return { next, result: projectWorkspaceGroups(next) };
      };
      return mutate(
        WORKSPACE_COORDINATE,
        signal,
        prepare,
        (value) => {
          const assigned = value.assignments as Record<string, string>;
          return (
            (channelId === undefined || assigned[channelId] === section) &&
            (!createSection ||
              (value.sections as SidebarGroups["sections"]).some(
                (entry) =>
                  entry.id === section &&
                  entry.name === createSection.name.trim() &&
                  (createSection.icon === undefined ||
                    entry.icon === createSection.icon),
              ))
          );
        },
        "Sidebar groups changed on another device; reload and try again",
        legacy,
      );
    },
    async writeSidebarStar(
      intent: { channelId: string; starred: boolean },
      signal: AbortSignal,
    ) {
      return writeToggle(
        "channel-stars",
        "starred",
        intent,
        signal,
        "Sidebar stars changed on another device; reload and try again",
      );
    },
    async writeSidebarMute(
      intent: { channelId: string; muted: boolean },
      signal: AbortSignal,
    ) {
      return writeToggle(
        "channel-mutes",
        "muted",
        intent,
        signal,
        "Sidebar mutes changed on another device; reload and try again",
      );
    },
    async writeSidebarSort(
      group: string,
      mode: SidebarSortMode,
      sectionIds: readonly string[],
      signal: AbortSignal,
    ) {
      if (!validSidebarSort(group, mode, sectionIds))
        throw new Error("Invalid sidebar sort intent");
      const prepare = (current: Record<string, unknown>, createdAt: number) => {
        const next = editSidebarSort(
          current,
          createdAt,
          group,
          mode,
          Date.now(),
        );
        return {
          next,
          result:
            project(WORKSPACE_SORT_COORDINATE, next, sectionIds).sort ?? {},
        };
      };
      return mutate(
        WORKSPACE_SORT_COORDINATE,
        signal,
        prepare,
        (value) =>
          (project(WORKSPACE_SORT_COORDINATE, value, sectionIds).sort?.[
            group
          ] ?? "alpha") === mode,
        "Sidebar sort changed on another device; reload and try again",
      );
    },
    async writeSidebarFilter(
      group: string,
      mode: SidebarFilterMode,
      sectionIds: readonly string[],
      signal: AbortSignal,
      activeWindowSeconds?: number | null,
    ) {
      if (!validSidebarFilter(group, mode, sectionIds, activeWindowSeconds))
        throw new Error("Invalid sidebar filter intent");
      const prepare = (current: Record<string, unknown>, createdAt: number) => {
        const next = editSidebarFilter(
          current,
          createdAt,
          group,
          mode,
          Date.now(),
          activeWindowSeconds,
        );
        const settings = project(WORKSPACE_FILTER_COORDINATE, next, sectionIds);
        return {
          next,
          result: {
            filters: settings.filters ?? {},
            activeWindowSeconds: settings.activeWindowSeconds ?? {},
          },
        };
      };
      return mutate(
        WORKSPACE_FILTER_COORDINATE,
        signal,
        prepare,
        (value) =>
          editSidebarFilter(
            value,
            0,
            group,
            mode,
            Date.now(),
            activeWindowSeconds,
          ) === value,
        "Sidebar filter changed on another device; reload and try again",
      );
    },
  };
  async function writeToggle(
    coordinate: "channel-stars" | "channel-mutes",
    field: "starred" | "muted",
    intent: { channelId: string; starred?: boolean; muted?: boolean },
    signal: AbortSignal,
    conflict: string,
  ) {
    const { channelId } = intent;
    const enabled = intent[field];
    if (!validSidebarChannelId(channelId) || typeof enabled !== "boolean")
      throw new Error(
        `Invalid sidebar ${field === "starred" ? "star" : "mute"} intent`,
      );
    const prepare = (current: Record<string, unknown>) => {
      const next = editSidebarToggle(current, channelId, field, enabled);
      return {
        next,
        result: project(coordinate, next)[
          field === "starred" ? "starred" : "muted"
        ],
      };
    };
    return mutate(
      coordinate,
      signal,
      prepare,
      (value) => {
        const entry = (
          value.channels as Record<string, Record<string, unknown>>
        )[channelId];
        // An unmute must leave its explicit tombstone, not disappear on readback.
        return (
          entry?.[field] === enabled ||
          (field === "starred" && !enabled && entry === undefined)
        );
      },
      conflict,
    );
  }
}
