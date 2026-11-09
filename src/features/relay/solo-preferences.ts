import type { ChannelKit } from "../channel-templates/capability";
import {
  emptyLineup,
  kitRecordFits,
  soloCapacityMessage,
  type Groups,
  type KitEntry,
} from "../channel-templates/model";
import { projectTemplateId, templateEntry } from "../solo/workspace";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarAssignmentIntent,
  SidebarGroups,
} from "./sidebar-preferences";

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

function admit(value: Groups, entry: KitEntry | undefined) {
  // With no saved record, any filing fits. Existing records retain their
  // exact community envelope, including its UTF-8 byte cost.
  if (entry && !kitRecordFits({ ...entry.record, deleted: false, value }))
    throw new Error(soloCapacityMessage);
}

/** Reuse recipe revision checks/outbox and preference lifecycle; never read Messages groups. */
export function createSoloPreferences(kit: ChannelKit, lifetime: AbortSignal) {
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
    if (state.status !== "ready")
      throw new Error(state.error ?? "Solo groups are unavailable");
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
  ) {
    admit(value, entry);
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
        return save({ ...value, groups, assignments }, entry, active);
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
