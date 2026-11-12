import type { HeadPersistence } from "./persistence";
import { isTransientFailure } from "./errors";
import { projectSidebarPreferences } from "./sidebar-preferences";
import type {
  SidebarAssignmentMutator,
  SidebarAssignmentIntent,
  SidebarSectionOrderMutator,
  SidebarGroups,
  SidebarSectionRemovalMutator,
  SidebarSectionRenameMutator,
  SidebarSectionCreationMutator,
  SidebarStarMutator,
  SidebarMuteMutator,
  SidebarPreferences,
  SidebarSortMode,
  SidebarSortMutator,
  SidebarFilterMode,
  SidebarFilterMutator,
  SidebarFilterSettings,
} from "./sidebar-preferences";

type MoveDestination =
  | { starred: true }
  | Omit<SidebarAssignmentIntent, "channelId">;
type MoveIntent = Readonly<{
  id: number;
  channelId: string;
  destination: MoveDestination;
}>;
type MoveFailure = MoveIntent & Readonly<{ error: string }>;
type SortFailure = Readonly<{
  group: string;
  mode: SidebarSortMode;
  error: string;
}>;
type FilterFailure = Readonly<{
  group: string;
  mode: SidebarFilterMode;
  activeWindowSeconds?: number | null;
  error: string;
}>;
type OrderFailure = Readonly<{
  sectionId: string;
  sectionIds: readonly string[];
  error: string;
}>;
type Snapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error" | "unsupported";
  data?: SidebarPreferences;
  error?: string;
  /** Set with an error that a later retry can fix; see isTransientFailure. */
  transient?: true;
  cached?: true;
  sortErrors?: readonly SortFailure[];
  filterErrors?: readonly FilterFailure[];
  moves?: readonly (MoveIntent & { pending: boolean; error?: string })[];
  orderError?: OrderFailure;
}>;

/** One bounded account-preference projection per relay session, not per page. */
export function createSidebarPreferencesStore({
  read,
  readAfterWrite = read,
  available,
  write,
  writeStar,
  notify = (listener: () => void) => listener(),
  writeMute,
  writeSort,
  persistence,
  removeSection,
  renameSection,
  groupsOnly = false,
  writeOrder,
  createSection,
  writeFilter,
}: Readonly<{
  read: (signal?: AbortSignal) => Promise<SidebarPreferences>;
  /** Fresh authoritative reconciliation after writes or live invalidation. */
  readAfterWrite?:
    | ((signal?: AbortSignal) => Promise<SidebarPreferences>)
    | undefined;
  available: boolean;
  write?: SidebarAssignmentMutator | undefined;
  writeStar?: SidebarStarMutator | undefined;
  notify?: ((listener: () => void) => void) | undefined;
  writeMute?: SidebarMuteMutator | undefined;
  writeSort?: SidebarSortMutator | undefined;
  persistence?: HeadPersistence | undefined;
  removeSection?: SidebarSectionRemovalMutator | undefined;
  renameSection?: SidebarSectionRenameMutator | undefined;
  /** Solo groups have no Star coordinate; do not write Messages stars on moves. */
  groupsOnly?: boolean | undefined;
  writeOrder?: SidebarSectionOrderMutator | undefined;
  createSection?: SidebarSectionCreationMutator | undefined;
  writeFilter?: SidebarFilterMutator | undefined;
}>) {
  const listeners = new Set<() => void>();
  const empty = (): Snapshot =>
    Object.freeze({ status: available ? "idle" : "unsupported" });
  let snapshot = empty();
  let closed = false;
  let active:
    | { controller: AbortController; promise: Promise<void> }
    | undefined;
  let writeQueue = Promise.resolve();
  let writeLifetime = new AbortController();
  let mutation = 0;
  let invalidation = 0;
  let reconciled = 0;
  let scheduled = false;
  const owed = () => invalidation !== reconciled;
  function scheduleReconciliation() {
    if (closed || !available || scheduled) return;
    scheduled = true;
    const scheduledGeneration = generation;
    queueMicrotask(() => {
      if (closed || generation !== scheduledGeneration) return;
      scheduled = false;
      if (owed()) void refresh(true);
    });
  }
  function invalidate() {
    if (closed || !available) return;
    invalidation++;
    scheduleReconciliation();
  }
  let confirmed: SidebarPreferences | undefined;
  let readFailure: string | undefined;
  let readTransient = false;
  // Retain writer routing through failed reads and cache clears until reconciled.
  let creationUncertain = false;
  const writable = () =>
    !closed &&
    !!confirmed &&
    readFailure === undefined &&
    !!write &&
    (groupsOnly || !!writeStar);
  let nextMove = 0;
  const pendingMoves = new Map<number, MoveIntent>();
  const failedMoves = new Map<string, MoveFailure>();
  const latestMove = new Map<string, number>();
  let nextOrder = 0;
  let pendingOrder:
    | Readonly<{ id: number; sectionIds: readonly string[] }>
    | undefined;
  let failedOrder: OrderFailure | undefined;
  const orderWritable = () =>
    !closed &&
    !!confirmed &&
    readFailure === undefined &&
    !snapshot.cached &&
    !!writeOrder;
  const renameWritable = () =>
    !closed &&
    !!confirmed &&
    readFailure === undefined &&
    !snapshot.cached &&
    !!renameSection;
  const withPendingMoves = (data: SidebarPreferences): SidebarPreferences => {
    let sections = data.sections;
    const assignments = { ...data.assignments };
    const starred = new Set(data.starred);
    for (const { channelId, destination } of pendingMoves.values()) {
      if ("starred" in destination) starred.add(channelId);
      else {
        starred.delete(channelId);
        const created = destination.createSection;
        if (created && !sections.some(({ id }) => id === created.id)) {
          const section = {
            id: created.id,
            name: created.name.trim(),
            order:
              created.position === "first"
                ? Math.min(0, ...sections.map(({ order }) => order)) - 1
                : Math.max(-1, ...sections.map(({ order }) => order)) + 1,
          };
          sections =
            created.position === "first"
              ? [section, ...sections]
              : [...sections, section];
        }
        const target = created?.id ?? destination.sectionId;
        if (target) assignments[channelId] = target;
        else delete assignments[channelId];
      }
    }
    if (pendingOrder) {
      const ids = pendingOrder.sectionIds;
      const rank = (id: string) =>
        ids.includes(id) ? ids.indexOf(id) : ids.length;
      sections = [...sections]
        .sort((a, b) => rank(a.id) - rank(b.id))
        .map((section, order) => ({ ...section, order }));
    }
    return { ...data, sections, assignments, starred: [...starred] };
  };
  let generation = 0;
  let nextSortMutation = 0;
  const latestSort = new Map<string, number>();
  const failedSorts = new Map<string, SortFailure>();
  const pendingSorts = new Map<
    number,
    { group: string; mode: SidebarSortMode }
  >();
  const withSort = (
    sort: Readonly<Record<string, SidebarSortMode>>,
    group: string,
    mode: SidebarSortMode,
  ) => {
    const next = { ...sort };
    if (mode === "alpha") delete next[group];
    else next[group] = mode;
    return next;
  };
  const withPendingSorts = (
    sort: Readonly<Record<string, SidebarSortMode>>,
  ) => {
    let next = sort;
    for (const pending of pendingSorts.values())
      next = withSort(next, pending.group, pending.mode);
    return next;
  };

  let nextFilterMutation = 0;
  const latestFilter = new Map<string, number>();
  const failedFilters = new Map<string, FilterFailure>();
  const pendingFilters = new Map<
    number,
    {
      group: string;
      mode: SidebarFilterMode;
      activeWindowSeconds?: number | null;
    }
  >();
  const withFilter = (
    filters: Readonly<Record<string, SidebarFilterMode>>,
    group: string,
    mode: SidebarFilterMode,
  ) => {
    const next = { ...filters };
    if (mode === "all") delete next[group];
    else next[group] = mode;
    return next;
  };
  const withPendingFilters = (
    filters: Readonly<Record<string, SidebarFilterMode>>,
  ) => {
    let next = filters;
    for (const pending of pendingFilters.values())
      next = withFilter(next, pending.group, pending.mode);
    return next;
  };

  const withPendingWindows = () => {
    const windows = { ...confirmed?.activeWindowSeconds };
    for (const pending of pendingFilters.values()) {
      if (pending.activeWindowSeconds === null) delete windows[pending.group];
      else if (pending.activeWindowSeconds !== undefined)
        windows[pending.group] = pending.activeWindowSeconds;
    }
    return windows;
  };

  const retained = (data: SidebarPreferences): SidebarPreferences =>
    Object.freeze({
      sections: Object.freeze(
        data.sections.map((section) => Object.freeze({ ...section })),
      ),
      assignments: Object.freeze({ ...data.assignments }),
      starred: Object.freeze([...data.starred]),
      muted: Object.freeze([...data.muted]),
      ...(data.sort ? { sort: Object.freeze({ ...data.sort }) } : {}),
      ...(data.filters ? { filters: Object.freeze({ ...data.filters }) } : {}),
      ...(data.activeWindowSeconds
        ? {
            activeWindowSeconds: Object.freeze({ ...data.activeWindowSeconds }),
          }
        : {}),
    });
  const publish = (next: Snapshot) => {
    const {
      moves: _moves,
      sortErrors: _errors,
      filterErrors: _filterErrors,
      orderError: _order,
      ...state
    } = next;
    const moves = [
      ...Array.from(pendingMoves.values(), (intent) => ({
        ...intent,
        pending: true,
      })),
      ...Array.from(failedMoves.values(), (intent) => ({
        ...intent,
        pending: false,
      })),
    ];
    snapshot = Object.freeze({
      ...state,
      ...(failedSorts.size
        ? { sortErrors: Object.freeze([...failedSorts.values()]) }
        : {}),
      ...(failedFilters.size
        ? { filterErrors: Object.freeze([...failedFilters.values()]) }
        : {}),
      ...(moves.length ? { moves: Object.freeze(moves) } : {}),
      ...(failedOrder ? { orderError: failedOrder } : {}),
    });
    for (const listener of listeners) notify(listener);
  };
  // Both optimistic families overlay one confirmed snapshot. A completion only
  // replaces its own fields; mute stays confirmed-only for notification policy.
  const project = () => {
    if (!confirmed) return;
    void persistence
      ?.writeStartup?.({
        preferences: { savedAt: Date.now(), data: confirmed },
      })
      .catch(() => {});
    publish({
      // A field-only confirmation cannot recover a failed full read. Any
      // concurrent read made stale by a write must leave recovery available.
      ...(readFailure === undefined
        ? { status: "ready" as const }
        : {
            status: "error" as const,
            error: readFailure,
            ...(readTransient ? { transient: true as const } : {}),
          }),
      data: retained(
        withPendingMoves({
          ...confirmed,
          ...(pendingSorts.size
            ? { sort: withPendingSorts(confirmed.sort ?? {}) }
            : {}),
          ...(pendingFilters.size
            ? {
                filters: withPendingFilters(confirmed.filters ?? {}),
                activeWindowSeconds: withPendingWindows(),
              }
            : {}),
        }),
      ),
    });
  };
  function refresh(quiet = false): Promise<void> {
    if (closed || !available) return Promise.resolve();
    if (pendingMoves.size) {
      const refreshGeneration = generation;
      return writeQueue.then(() => {
        if (!closed && generation === refreshGeneration) return refresh(quiet);
      });
    }
    if (active) return active.promise;
    const controller = new AbortController();
    const job = { controller, promise: Promise.resolve() };
    active = job;
    job.promise = Promise.resolve().then(async () => {
      if (closed || controller.signal.aborted) return;
      const current = () =>
        !closed && !controller.signal.aborted && active === job;
      try {
        while (current()) {
          // Other preference families share the queue. Read after they settle,
          // and repeat if a write admitted during the read invalidates it.
          const authoritative = creationUncertain || owed();
          const writes = writeQueue;
          if (authoritative) await writes;
          if (!current()) return;
          // A newly admitted writer must settle before a strong read starts.
          if (authoritative && writes !== writeQueue) continue;
          const refreshMutation = mutation;
          const refreshInvalidation = invalidation;
          try {
            const data = await (authoritative ? readAfterWrite : read)(
              controller.signal,
            );
            if (!current()) return;
            if (
              mutation !== refreshMutation ||
              (authoritative && writes !== writeQueue)
            ) {
              if (creationUncertain || owed()) continue;
              return;
            }
            if (invalidation !== refreshInvalidation) continue;
            if (authoritative) reconciled = refreshInvalidation;
            readFailure = undefined;
            creationUncertain = false;
            confirmed = data;
            project();
            return;
          } catch (error) {
            if (!current()) return;
            if (
              mutation !== refreshMutation ||
              (authoritative && writes !== writeQueue)
            ) {
              if (creationUncertain || owed()) continue;
              return;
            }
            if (invalidation !== refreshInvalidation) continue;
            readFailure =
              error instanceof Error ? error.message : String(error);
            readTransient = isTransientFailure(error);
            const { transient: _transient, ...rest } = snapshot;
            publish({
              ...rest,
              status: "error",
              error: readFailure,
              ...(readTransient ? { transient: true as const } : {}),
            });
            return;
          }
        }
      } finally {
        if (active === job) active = undefined;
      }
    });
    // Live reconciliation is quiet while useful confirmed content is mounted.
    if (!quiet || !confirmed) {
      publish({
        status: "loading",
        ...(snapshot.cached ? { cached: true as const } : {}),
        ...(snapshot.data ? { data: snapshot.data } : {}),
      });
    }
    return job.promise;
  }
  function rejectMove(channelId: string, message: string): Promise<never> {
    const failed = failedMoves.get(channelId);
    if (failed) {
      failedMoves.set(channelId, { ...failed, error: message });
      publish(snapshot);
    }
    return Promise.reject(new Error(message));
  }
  // Optimistic placement is a projection over confirmed data. Persistence keeps
  // assignment/create before Star removal. A failed
  // older intent cannot undo a later move or replace its retry state.
  function move(
    channelId: string,
    destination: MoveDestination,
    signal?: AbortSignal,
  ): Promise<SidebarPreferences> {
    if (
      !writable() ||
      (creationUncertain && "createSection" in destination) ||
      !snapshot.data ||
      !confirmed ||
      !write ||
      (!writeStar && !groupsOnly) ||
      (groupsOnly && "starred" in destination)
    )
      return rejectMove(
        channelId,
        "Sidebar group moves are unavailable; refresh saved sidebar preferences before retrying",
      );
    const writeGeneration = generation;
    const writeSignal = AbortSignal.any([
      writeLifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    if (writeSignal.aborted) return Promise.reject(writeSignal.reason);
    const intent: MoveIntent = { id: ++nextMove, channelId, destination };
    pendingMoves.set(intent.id, intent);
    latestMove.set(channelId, intent.id);
    failedMoves.delete(channelId);
    mutation++;
    const check = () => {
      if (closed || generation !== writeGeneration)
        throw new Error("Sidebar group moves are unavailable");
      writeSignal.throwIfAborted();
    };
    const run = writeQueue
      .catch(() => {})
      .then(async () => {
        try {
          check();
          if (creationUncertain && "createSection" in destination)
            throw new Error("Section creation is unavailable");
          const starring = "starred" in destination;
          // Always check the fresh assignment head on removal, even if cached
          // placement has no assignment. Another device may have changed it.
          const groups = starring
            ? undefined
            : await write({ channelId, ...destination }, writeSignal);
          check();
          const stars =
            !groupsOnly && writeStar
              ? await writeStar({ channelId, starred: starring }, writeSignal)
              : [];
          check();
          if (!confirmed)
            throw new Error("Sidebar group moves are unavailable");
          confirmed = {
            ...confirmed,
            ...(groups
              ? { sections: groups.sections, assignments: groups.assignments }
              : {}),
            starred: stars,
          };
          return retained(confirmed);
        } catch (error) {
          if (
            !closed &&
            generation === writeGeneration &&
            !writeSignal.aborted &&
            latestMove.get(channelId) === intent.id
          )
            failedMoves.set(channelId, {
              ...intent,
              error: error instanceof Error ? error.message : String(error),
            });
          throw error;
        } finally {
          if (!closed && generation === writeGeneration) {
            mutation++;
            pendingMoves.delete(intent.id);
            project();
          }
        }
      });
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    project();
    return run;
  }
  async function removeSectionMutation(
    sectionId: string,
    signal?: AbortSignal,
  ) {
    if (
      closed ||
      !confirmed ||
      readFailure !== undefined ||
      snapshot.cached ||
      !removeSection ||
      !writeSort
    )
      throw new Error("Sidebar section removal is unavailable");
    const writeGeneration = generation;
    const writeSignal = AbortSignal.any([
      writeLifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    writeSignal.throwIfAborted();
    mutation++;
    const run = writeQueue
      .catch(() => {})
      .then(async () => {
        if (closed || generation !== writeGeneration)
          throw new Error("Sidebar section removal is unavailable");
        writeSignal.throwIfAborted();
        if (!confirmed?.sections.some(({ id }) => id === sectionId))
          throw new Error("Sidebar section no longer exists");
        const group = `section:${sectionId}`;
        // Local Alpha can be stale while another device has saved an override.
        // Reset while the section is live, so a failed write leaves removal
        // retryable and cannot strand a live override beyond the decoder cap.
        const sort = await writeSort(
          group,
          "alpha",
          confirmed.sections.map(({ id }) => id),
          writeSignal,
        );
        if (closed || generation !== writeGeneration)
          throw new Error("Sidebar section removal is unavailable");
        writeSignal.throwIfAborted();
        if (!confirmed)
          throw new Error("Sidebar section removal is unavailable");
        confirmed = { ...confirmed, sort };
        if (writeFilter) {
          const settings = await writeFilter(
            group,
            "all",
            confirmed.sections.map(({ id }) => id),
            writeSignal,
            null,
          );
          if (closed || generation !== writeGeneration || !confirmed)
            throw new Error("Sidebar section removal is unavailable");
          writeSignal.throwIfAborted();
          confirmed = { ...confirmed, ...settings };
        }
        mutation++;
        project();
        const next = await removeSection(sectionId, writeSignal);
        if (closed || generation !== writeGeneration || !confirmed)
          throw new Error("Sidebar section removal is unavailable");
        writeSignal.throwIfAborted();
        mutation++;
        confirmed = {
          ...confirmed,
          sections: next.sections,
          assignments: next.assignments,
        };
        failedFilters.delete(group);
        project();
        return retained(confirmed);
      })
      .catch((error) => {
        if (!closed && generation === writeGeneration) {
          mutation++;
          project();
        }
        throw error;
      });
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const restoreGeneration = generation;
  const ready = persistence
    ?.readStartup?.()
    .then((saved) => {
      if (
        closed ||
        generation !== restoreGeneration ||
        confirmed ||
        snapshot.status === "ready"
      )
        return;
      const value = saved?.preferences;
      if (
        !value ||
        !Number.isFinite(value.savedAt) ||
        value.savedAt > Date.now() ||
        Date.now() - value.savedAt > 86_400_000
      )
        return;
      const data = value.data;
      const rows = (ids: readonly string[], flag: string) => ({
        version: 1,
        channels: Object.fromEntries(
          ids.map((id) => [id, { [flag]: true, updatedAt: 0 }]),
        ),
      });
      const parsed = projectSidebarPreferences(
        { version: 1, sections: data.sections, assignments: data.assignments },
        rows(data.starred, "starred"),
        rows(data.muted, "muted"),
        { version: 1, groups: data.sort ?? {} },
        undefined,
        data.filters === undefined && data.activeWindowSeconds === undefined
          ? undefined
          : {
              version: 1,
              groups: data.filters ?? {},
              activeWindowSeconds: data.activeWindowSeconds,
            },
      );
      // Display-only: do not initialize the confirmed mutation base from disk.
      publish({
        ...snapshot,
        cached: true,
        data: retained(parsed),
      });
    })
    .catch(() => {});
  /** One queued groups-only write whose confirmed result replaces sections. */
  const writeGroups = (
    failure: string,
    run: (signal: AbortSignal) => Promise<SidebarGroups>,
  ) => {
    const writeGeneration = generation;
    const signal = writeLifetime.signal;
    const next = writeQueue
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        if (closed || generation !== writeGeneration) throw new Error(failure);
        const groups = await run(signal);
        signal.throwIfAborted();
        if (closed || generation !== writeGeneration || !confirmed)
          throw new Error(failure);
        mutation++;
        confirmed = { ...confirmed, ...groups };
        project();
      });
    writeQueue = next.catch(() => {});
    return next;
  };
  return {
    ready,
    invalidate,
    reconnect(continuous = false) {
      if (!continuous) invalidate();
      else if (owed()) scheduleReconciliation();
    },
    queries: Object.freeze({
      available,
      get sectionRemovalWritable() {
        return groupsOnly
          ? writable() && !snapshot.cached && !!removeSection
          : this.removeSectionWritable;
      },
      removeSection(sectionId: string, callerSignal?: AbortSignal) {
        if (!groupsOnly) return removeSectionMutation(sectionId, callerSignal);
        if (!writable() || snapshot.cached || !removeSection)
          return Promise.reject(new Error("Section deletion is unavailable"));
        return writeGroups("Section deletion is unavailable", (signal) =>
          removeSection(sectionId, signal),
        );
      },
      get sectionRenameWritable() {
        return renameWritable();
      },
      renameSection(sectionId: string, name: string) {
        if (!renameWritable() || !renameSection)
          return Promise.reject(new Error("Section rename is unavailable"));
        return writeGroups("Section rename is unavailable", (signal) =>
          renameSection({ sectionId, name }, signal),
        );
      },
      get sectionCreationWritable() {
        return (
          writable() &&
          !creationUncertain &&
          !snapshot.cached &&
          !!(createSection || write)
        );
      },
      createSection(section: Readonly<{ id: string; name: string }>) {
        const failure = groupsOnly
          ? "Workspaces are unavailable"
          : "Section creation is unavailable";
        const create =
          createSection ??
          (write
            ? (
                section: Readonly<{ id: string; name: string }>,
                signal: AbortSignal,
              ) => write({ createSection: section }, signal)
            : undefined);
        if (!writable() || creationUncertain || snapshot.cached || !create)
          return Promise.reject(new Error(failure));
        const writeGeneration = generation;
        return writeGroups(failure, (signal) => create(section, signal)).catch(
          async (error) => {
            if (!closed && generation === writeGeneration) {
              // The relay may have accepted the creation. Reconcile before
              // the form can discard its ID, without replaying the write or
              // joining a read that began before publication.
              active?.controller.abort();
              active = undefined;
              creationUncertain = true;
              await refresh();
            }
            throw error;
          },
        );
      },
      get sectionOrderWritable() {
        return orderWritable();
      },
      /** Optimistic whole-list order; the latest intent supersedes older ones. */
      reorderSections(sectionId: string, sectionIds: readonly string[]) {
        if (!orderWritable() || !writeOrder)
          return Promise.reject(
            new Error("Sidebar section order is unavailable"),
          );
        const save = writeOrder;
        const writeGeneration = generation;
        const signal = writeLifetime.signal;
        const intent = { id: ++nextOrder, sectionIds: [...sectionIds] };
        pendingOrder = intent;
        failedOrder = undefined;
        mutation++;
        project();
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            try {
              if (closed || generation !== writeGeneration)
                throw new Error("Sidebar section order is unavailable");
              signal.throwIfAborted();
              const groups = await save(intent.sectionIds, signal);
              if (closed || generation !== writeGeneration || !confirmed)
                throw new Error("Sidebar section order is unavailable");
              confirmed = {
                ...confirmed,
                sections: groups.sections,
                assignments: groups.assignments,
              };
              return retained(confirmed);
            } catch (error) {
              if (
                !closed &&
                generation === writeGeneration &&
                !signal.aborted &&
                pendingOrder === intent
              )
                failedOrder = {
                  sectionId,
                  sectionIds: intent.sectionIds,
                  error: error instanceof Error ? error.message : String(error),
                };
              throw error;
            } finally {
              if (!closed && generation === writeGeneration) {
                mutation++;
                if (pendingOrder === intent) pendingOrder = undefined;
                project();
              }
            }
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      dismissOrderError() {
        failedOrder = undefined;
        publish(snapshot);
      },
      dismissSortError(group: string) {
        failedSorts.delete(group);
        publish(snapshot);
      },
      get sortWritable() {
        return !!writeSort && !snapshot.cached;
      },
      setSort(
        group: string,
        mode: SidebarSortMode,
        sectionIds: readonly string[],
        signal?: AbortSignal,
      ) {
        if (closed || !writeSort || !snapshot.data || snapshot.cached)
          return Promise.reject(
            new Error("Sidebar sorting is read-only in this host"),
          );
        const writeGeneration = generation;
        const writeSignal = AbortSignal.any([
          writeLifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        if (writeSignal.aborted) return Promise.reject(writeSignal.reason);
        const id = ++nextSortMutation;
        pendingSorts.set(id, { group, mode });
        latestSort.set(group, id);
        failedSorts.delete(group);
        mutation++;
        project();
        const settle = (sort?: Readonly<Record<string, SidebarSortMode>>) => {
          if (closed || generation !== writeGeneration || !confirmed) return;
          confirmed = {
            ...confirmed,
            sort: { ...(sort ?? confirmed.sort ?? {}) },
          };
          pendingSorts.delete(id);
          project();
        };
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar sorting is unavailable");
            try {
              writeSignal.throwIfAborted();
              const sort = await writeSort(
                group,
                mode,
                sectionIds,
                writeSignal,
              );
              if (closed || generation !== writeGeneration)
                throw new Error("Sidebar sorting is unavailable");
              writeSignal.throwIfAborted();
              mutation++;
              settle(sort);
              return sort;
            } catch (error) {
              if (!closed && generation === writeGeneration) {
                mutation++;
                if (!writeSignal.aborted && latestSort.get(group) === id)
                  failedSorts.set(group, {
                    group,
                    mode,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
              }
              settle();
              throw error;
            }
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      dismissFilterError(group: string) {
        failedFilters.delete(group);
        publish(snapshot);
      },
      get filterWritable() {
        return (
          !closed &&
          !!writeFilter &&
          !!confirmed &&
          readFailure === undefined &&
          !snapshot.cached
        );
      },
      setFilter(
        group: string,
        mode: SidebarFilterMode,
        sectionIds: readonly string[],
        signal?: AbortSignal,
        activeWindowSeconds?: number | null,
      ) {
        if (
          closed ||
          !writeFilter ||
          !confirmed ||
          readFailure !== undefined ||
          snapshot.cached
        )
          return Promise.reject(
            new Error("Sidebar filtering is read-only in this host"),
          );
        const writeGeneration = generation;
        const writeSignal = AbortSignal.any([
          writeLifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        if (writeSignal.aborted) return Promise.reject(writeSignal.reason);
        const id = ++nextFilterMutation;
        pendingFilters.set(id, {
          group,
          mode,
          ...(activeWindowSeconds === undefined ? {} : { activeWindowSeconds }),
        });
        latestFilter.set(group, id);
        failedFilters.delete(group);
        mutation++;
        project();
        const settle = (settings?: SidebarFilterSettings) => {
          if (closed || generation !== writeGeneration || !confirmed) return;
          confirmed = {
            ...confirmed,
            ...(settings ?? {}),
          };
          pendingFilters.delete(id);
          project();
        };
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar filtering is unavailable");
            try {
              writeSignal.throwIfAborted();
              const settings = await writeFilter(
                group,
                mode,
                sectionIds,
                writeSignal,
                activeWindowSeconds,
              );
              if (closed || generation !== writeGeneration)
                throw new Error("Sidebar filtering is unavailable");
              writeSignal.throwIfAborted();
              mutation++;
              settle(settings);
              return settings;
            } catch (error) {
              if (!closed && generation === writeGeneration) {
                mutation++;
                if (!writeSignal.aborted && latestFilter.get(group) === id)
                  failedFilters.set(group, {
                    group,
                    mode,
                    ...(activeWindowSeconds === undefined
                      ? {}
                      : { activeWindowSeconds }),
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
              }
              settle();
              throw error;
            }
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      get muteWritable() {
        return !!writeMute && !snapshot.cached;
      },
      setMute(channelId: string, muted: boolean, signal?: AbortSignal) {
        if (closed || !writeMute || !snapshot.data || snapshot.cached)
          return Promise.reject(
            new Error("Sidebar mutes are unavailable in this host"),
          );
        const writeGeneration = generation;
        const writeSignal = AbortSignal.any([
          writeLifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar mutes are unavailable");
            writeSignal.throwIfAborted();
            const mutes = await writeMute({ channelId, muted }, writeSignal);
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar mutes are unavailable");
            writeSignal.throwIfAborted();
            const current = confirmed;
            if (!current) throw new Error("Sidebar mutes are unavailable");
            mutation++;
            confirmed = { ...current, muted: [...mutes] };
            project();
            return mutes;
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },

      retryMove(channelId: string) {
        const failed = failedMoves.get(channelId);
        return failed
          ? move(channelId, failed.destination)
          : Promise.reject(new Error("No failed move to retry"));
      },
      dismissMoveError(channelId: string) {
        failedMoves.delete(channelId);
        publish(snapshot);
      },
      get writable() {
        return writable();
      },
      assign(channelId: string, sectionId?: string, signal?: AbortSignal) {
        return move(channelId, sectionId ? { sectionId } : {}, signal);
      },
      createAndAssign(
        channelId: string,
        section: NonNullable<SidebarAssignmentIntent["createSection"]>,
        signal?: AbortSignal,
      ) {
        return move(channelId, { createSection: section }, signal);
      },
      get removeSectionWritable() {
        return (
          !closed &&
          !!confirmed &&
          readFailure === undefined &&
          !snapshot.cached &&
          !!removeSection &&
          !!writeSort
        );
      },
      get starWritable() {
        return !groupsOnly && writable();
      },
      async setStar(channelId: string, starred: boolean, signal?: AbortSignal) {
        const data = await move(
          channelId,
          starred ? { starred: true } : {},
          signal,
        );
        return data.starred;
      },
      // Keep explicit one-shot reads compatible; views use the retained snapshot.
      read,
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure: () =>
        snapshot.status === "idle"
          ? refresh()
          : (active?.promise ?? Promise.resolve()),
      refresh: () => refresh(),
    }),
    clear() {
      if (closed) return;
      generation++;
      invalidation = reconciled = 0;
      scheduled = false;
      confirmed = undefined;
      pendingSorts.clear();
      latestSort.clear();
      failedSorts.clear();
      pendingFilters.clear();
      latestFilter.clear();
      failedFilters.clear();
      readFailure = undefined;
      pendingMoves.clear();
      failedMoves.clear();
      latestMove.clear();
      pendingOrder = undefined;
      failedOrder = undefined;
      mutation++;
      writeLifetime.abort();
      writeLifetime = new AbortController();
      active?.controller.abort();
      active = undefined;
      publish(empty());
    },
    dispose() {
      closed = true;
      writeLifetime.abort();
      generation++;
      invalidation = reconciled = 0;
      scheduled = false;
      confirmed = undefined;
      pendingSorts.clear();
      latestSort.clear();
      failedSorts.clear();
      pendingFilters.clear();
      latestFilter.clear();
      failedFilters.clear();
      readFailure = undefined;
      pendingMoves.clear();
      failedMoves.clear();
      latestMove.clear();
      pendingOrder = undefined;
      failedOrder = undefined;
      mutation++;
      active?.controller.abort();
      active = undefined;
      snapshot = empty();
      listeners.clear();
    },
  };
}
