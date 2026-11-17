import type { ChannelKit } from "../channel-templates/capability";
import {
  emptyLineup,
  kitRecordFits,
  soloCapacityMessage,
  type Groups,
  type KitEntry,
} from "../channel-templates/model";
import { projectTemplateId, templateEntry } from "../solo/workspace";
import { ReadError } from "./errors";
import { validSidebarSectionOrder } from "./sidebar-edits";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarAssignmentIntent,
  SidebarGroups,
} from "./sidebar-preferences";

export class WorkspaceNameConflict extends Error {
  constructor() {
    super(
      "The saved workspace name needs review. Your draft is kept; copy it before reloading saved settings.",
    );
  }
}

export function soloGroups(entries: readonly KitEntry[]) {
  return entries.find(
    (entry) =>
      entry.record.value.type === "groups" && entry.record.value.id === "me",
  );
}
function project(groups: Groups): SidebarGroups {
  return {
    sections: groups.groups.map(({ id, name }, order) => ({ id, name, order })),
    assignments: groups.assignments,
  };
}
const empty = (): Groups => ({
  type: "groups",
  id: "me",
  groups: [],
  assignments: {},
});

// Object key order changes through native JSON maps. Only group order is
// presentation data; assignment insertion order is not.
function comparable(value: Groups) {
  return JSON.stringify([
    value.id,
    value.groups.map(({ id, name, defaultTemplateId }) => [
      id,
      name,
      defaultTemplateId,
    ]),
    Object.entries(value.assignments).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

// With no saved record, any filing fits. Existing records retain their
// exact community envelope, including its UTF-8 byte cost.
const fits = (value: Groups, entry: KitEntry | undefined) =>
  !entry || kitRecordFits({ ...entry.record, deleted: false, value });

/** Reuse recipe revision checks/outbox and preference lifecycle; never read Messages groups.
 * `gone` names the given chats that are known to be archived or deleted, and
 * none when that isn't known. A full record drops their filings to make room. */
export function createSoloPreferences(
  kit: ChannelKit,
  lifetime: AbortSignal,
  gone: (chats: readonly string[]) => readonly string[] = () => [],
) {
  let mutations = Promise.resolve();
  let generation = new AbortController();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const admitted = generation.signal;
    const next = mutations.then(() => {
      admitted.throwIfAborted();
      lifetime.throwIfAborted();
      return operation();
    });
    mutations = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  async function current(signal = lifetime, fresh = true) {
    const active = AbortSignal.any([lifetime, generation.signal, signal]);
    active.throwIfAborted();
    if (fresh || kit.snapshot().status !== "ready") await kit.refresh();
    active.throwIfAborted();
    const state = kit.snapshot();
    if (state.status !== "ready") {
      const message = state.error ?? "Solo groups are unavailable";
      // Keep a retryable catalog failure retryable, so session recovery
      // reloads the workspaces once the relay answers again.
      throw state.transient
        ? new ReadError("unavailable", message)
        : new Error(message);
    }
    const entry = soloGroups(state.entries);
    return {
      entry,
      value:
        entry && !entry.record.deleted && entry.record.value.type === "groups"
          ? entry.record.value
          : empty(),
      active,
    };
  }
  async function save(
    value: Groups,
    entry: KitEntry | undefined,
    active: AbortSignal,
    filing?: string,
  ) {
    if (!fits(value, entry)) {
      // The chat being filed may be too new for the channel list to know it.
      const assignments = { ...value.assignments };
      for (const chat of gone(Object.keys(assignments)))
        if (chat !== filing) delete assignments[chat];
      value = { ...value, assignments };
      if (!fits(value, entry)) throw new Error(soloCapacityMessage);
    }
    // Serialized Solo edits still need a later second for replaceable records.
    // Future-dated heads remain subject to the kit's existing refusal.
    const delay = entry ? (entry.createdAt + 1) * 1000 - Date.now() : 0;
    if (delay > 0 && delay <= 1000) {
      active.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(active.reason);
        };
        const timer = setTimeout(() => {
          active.removeEventListener("abort", abort);
          resolve();
        }, delay);
        active.addEventListener("abort", abort, { once: true });
      });
    }
    active.throwIfAborted();
    await kit.save(value, entry?.eventId, false, active);
    active.throwIfAborted();
    const confirmed = soloGroups(kit.snapshot().entries);
    if (
      !confirmed ||
      confirmed.record.deleted ||
      confirmed.record.value.type !== "groups" ||
      comparable(confirmed.record.value) !== comparable(value)
    )
      throw new Error("Solo group changes could not be confirmed");
    return project(value);
  }
  const store = createSidebarPreferencesStore({
    read: async (signal) => ({
      ...project((await current(signal, false)).value),
      starred: [],
      muted: [],
    }),
    available: kit.available,
    write: (intent: SidebarAssignmentIntent, signal) =>
      serialize(async () => {
        const { value, entry, active } = await current(signal);
        const target = intent.createSection?.id ?? intent.sectionId;
        let groups = value.groups;
        if (intent.createSection) {
          const name = intent.createSection.name.trim();
          const existing = groups.find((group) => group.id === target);
          if (existing && existing.name !== name)
            throw new Error(
              "The new Solo group changed; refresh before retrying",
            );
          if (!existing)
            groups = [
              ...groups,
              { id: intent.createSection.id, name, defaultTemplateId: "" },
            ];
        }
        if (target && !groups.some((group) => group.id === target))
          throw new Error("The Solo group is unavailable");
        const assignments = { ...value.assignments };
        if (intent.channelId !== undefined) {
          if (target) assignments[intent.channelId] = target;
          else delete assignments[intent.channelId];
        }
        if (
          groups === value.groups &&
          (intent.channelId === undefined ||
            value.assignments[intent.channelId] === target)
        )
          return project(value);
        return save(
          { ...value, groups, assignments },
          entry,
          active,
          intent.channelId,
        );
      }),
    removeSection: (id, signal) =>
      serialize(async () => {
        const { value, entry, active } = await current(signal);
        const groups = {
          ...value,
          groups: value.groups.filter((group) => group.id !== id),
          assignments: Object.fromEntries(
            Object.entries(value.assignments).filter(
              ([, group]) => group !== id,
            ),
          ),
        };
        const saved = value.groups.some((group) => group.id === id)
          ? await save(groups, entry, active)
          : project(value);
        // Best effort, once the workspace is gone: delete its settings (name,
        // instructions, folders, agents). A record left behind is unreachable.
        // An already-absent workspace gets this too: a groups write can land
        // after failing to confirm, and its retry finds the workspace gone.
        void serialize(async () => {
          const cleanup = AbortSignal.any([lifetime, generation.signal]);
          const settings = templateEntry(
            kit.snapshot().entries,
            await projectTemplateId(id),
          );
          if (settings?.record.value.type === "template")
            await kit.save(
              {
                ...settings.record.value,
                ...emptyLineup(),
                name: "Deleted workspace",
              },
              settings.eventId,
              true,
              cleanup,
            );
        }).catch((error: unknown) => {
          console.warn("The deleted workspace's settings were kept", error);
        });
        return saved;
      }),
    groupsOnly: true,
    writeOrder: (sectionIds, signal) =>
      serialize(async () => {
        if (!validSidebarSectionOrder(sectionIds))
          throw new Error("Invalid Solo workspace order");
        const { value, entry, active } = await current(signal);
        const byId = new Map(value.groups.map((group) => [group.id, group]));
        const wanted = new Set(sectionIds);
        const groups = [
          ...sectionIds.flatMap((id) => {
            const group = byId.get(id);
            return group ? [group] : [];
          }),
          ...value.groups.filter((group) => !wanted.has(group.id)),
        ];
        if (groups.every((group, index) => group === value.groups[index]))
          return project(value);
        return save({ ...value, groups }, entry, active);
      }),
    renameSection: ({ sectionId, name, expectedName }, signal) =>
      serialize(async () => {
        const next = name?.trim();
        if (!next || next.length > 120)
          throw new Error("Use a workspace name of 1–120 characters.");
        const { value, entry, active } = await current(signal);
        const group = value.groups.find((group) => group.id === sectionId);
        if (!group) throw new Error("This workspace no longer exists.");
        if (group.name === next) return project(value);
        if (expectedName !== undefined && group.name !== expectedName)
          throw new WorkspaceNameConflict();
        return save(
          {
            ...value,
            groups: value.groups.map((item) =>
              item.id === sectionId ? { ...item, name: next } : item,
            ),
          },
          entry,
          active,
        );
      }),
    createSection: (section, signal) =>
      serialize(async () => {
        const { value, entry, active } = await current(signal);
        const name = section.name.trim();
        const existing = value.groups.find((group) => group.id === section.id);
        if (existing) {
          if (existing.name !== name)
            throw new Error(
              "The new Solo workspace changed; refresh before retrying",
            );
          return project(value);
        }
        return save(
          {
            ...value,
            groups: [
              ...value.groups,
              { id: section.id, name, defaultTemplateId: "" },
            ],
          },
          entry,
          active,
        );
      }),
  });
  return {
    ...store,
    clear() {
      generation.abort();
      generation = new AbortController();
      store.clear();
    },
    dispose() {
      generation.abort();
      store.dispose();
    },
  };
}
