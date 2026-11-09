import { WORKFLOW_CHANNEL_BATCH, WORKFLOW_DEFINITION_LIMIT } from "./queries";
import type { EventData } from "../relay/events";
import type { RelayReader } from "../relay/reader";
import type { ProfileQueries } from "../relay/profile-directory";
import type { Outbox, LocalEvents } from "../relay/outbox";
import type { WorkflowHost } from "./host";
import type {
  WorkflowCapability,
  WorkflowOperation,
  WorkflowReference,
  WorkflowView,
  WorkflowDefinition,
  WorkflowDefinitions,
} from "./types";
import {
  definition,
  hookUrl,
  isWorkflowOperation,
  parseRuns,
  record,
  validateReference,
  validateWorkflowEvent,
  workflowReference,
  UUID,
} from "./protocol";

const WORKFLOW_DEFINITION_CACHE_FRESH_MS = 10_000;
const WORKFLOW_DEFINITION_CACHE_RETAIN_MS = 60_000;
const WORKFLOW_DEFINITION_CACHE_MAX_ENTRIES = 32;

/** Session-owned configuration snapshots and bounded result state; never an engine. */
export function createWorkflows({
  reader,
  viewer,
  outbox,
  local,
  host,
  relayHttpUrl,
  canAccess,
  profiles,
  notify = (listener: () => void) => listener(),
}: {
  reader: RelayReader | undefined;
  viewer: string;
  outbox: Outbox | undefined;
  local: LocalEvents | undefined;
  host: WorkflowHost | undefined;
  /** Relay HTTP base for display only; hook URLs are never fetched from here. */
  relayHttpUrl?: string | undefined;
  canAccess(channel: string): boolean;
  profiles?: Pick<ProfileQueries, "owner" | "subscribe"> | undefined;
  notify?: (listener: () => void) => void;
}) {
  let closed = false;
  let definitionCacheVersion = 0;
  const definitionCache = new Map<
    string,
    {
      data: WorkflowDefinitions;
      channelIds: readonly string[];
      readAt: number;
      lastUsedAt: number;
    }
  >();
  function pruneDefinitionCache(now = Date.now()) {
    for (const [key, entry] of definitionCache)
      if (now - entry.readAt > WORKFLOW_DEFINITION_CACHE_RETAIN_MS)
        definitionCache.delete(key);
    while (definitionCache.size > WORKFLOW_DEFINITION_CACHE_MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, entry] of definitionCache) {
        if (entry.lastUsedAt >= oldest) continue;
        oldest = entry.lastUsedAt;
        oldestKey = key;
      }
      if (!oldestKey) break;
      definitionCache.delete(oldestKey);
    }
  }
  function cachedDefinitions(key: string) {
    const now = Date.now();
    pruneDefinitionCache(now);
    const cached = definitionCache.get(key);
    if (cached) cached.lastUsedAt = now;
    return cached;
  }
  function retainDefinitions(
    key: string,
    requestedChannelIds: readonly string[],
    data: WorkflowDefinitions,
    version: number,
  ) {
    if (version !== definitionCacheVersion) return;
    const now = Date.now();
    const requested = new Set(requestedChannelIds);
    for (const [existingKey, entry] of definitionCache)
      if (entry.channelIds.some((id) => requested.has(id)))
        definitionCache.delete(existingKey);
    definitionCache.set(key, {
      data,
      channelIds: Object.freeze([...requestedChannelIds]),
      readAt: now,
      lastUsedAt: now,
    });
    pruneDefinitionCache(now);
  }
  function invalidateDefinitionCache() {
    definitionCache.clear();
    definitionCacheVersion++;
  }
  const views = new Set<{
    clear(): void;
    interrupt(): void;
    emit(): void;
    dispose(): void;
  }>();
  const listeners = new Set<() => void>();
  type Result = {
    outcome: WorkflowOperation["outcome"];
    runId?: string;
    error?: string;
    deletionAccepted?: boolean;
  };
  const results = new Map<string, Result>();
  // One-time webhook secrets, keyed by save event ID, live here and nowhere
  // else: not in results, operations, the journal or any error text.
  const secrets = new Map<string, string>();
  const receiptInterest = new Set<string>();
  const availability = Object.freeze({
    definitions: !!reader,
    history: !!host,
    save: !!host && !!outbox?.supports(30620),
    trigger: !!host && !!outbox?.supports(46020),
    delete: !!host && !!outbox?.supports(5),
  });
  let operations: readonly WorkflowOperation[] = Object.freeze([]);
  function rebuild() {
    operations = closed
      ? Object.freeze([])
      : Object.freeze(
          (local?.snapshot() ?? [])
            .flatMap((item): WorkflowOperation[] => {
              if (!isWorkflowOperation(item.event)) return [];
              let workflow: WorkflowReference;
              try {
                workflow = workflowReference(item.event);
              } catch {
                return [];
              }
              if (
                item.event.pubkey !== viewer ||
                (item.event.kind !== 5 && workflow.owner !== viewer) ||
                !canAccess(workflow.channelId)
              )
                return [];
              const result = results.get(item.event.id);
              const outcome =
                result?.outcome ??
                (item.delivery === "sending"
                  ? "pending"
                  : item.delivery === "failed"
                    ? "rejected"
                    : "unknown");
              const error =
                result?.outcome === "succeeded"
                  ? undefined
                  : (result?.error ?? item.error);
              return [
                Object.freeze({
                  eventId: item.event.id,
                  workflow,
                  action:
                    item.event.kind === 30620
                      ? "save"
                      : item.event.kind === 5
                        ? "delete"
                        : "trigger",
                  createdAt: item.event.created_at,
                  delivery: item.delivery,
                  outcome,
                  ...(result?.runId ? { runId: result.runId } : {}),
                  ...(error !== undefined ? { error } : {}),
                  ...(secrets.has(item.event.id) ? { secretHeld: true } : {}),
                }),
              ];
            })
            .slice(-256),
        );
    const active = new Set(operations.map((op) => op.eventId));
    for (const id of results.keys()) if (!active.has(id)) results.delete(id);
    for (const id of secrets.keys()) if (!active.has(id)) secrets.delete(id);
    for (const listener of listeners) notify(listener);
  }
  const stop = local?.subscribe(rebuild);
  rebuild();
  function assertAccess(reference: WorkflowReference) {
    validateReference(reference);
    if (closed || !canAccess(reference.channelId))
      throw new Error(
        "Workflow access unavailable; refresh channel membership",
      );
  }
  function view<T>(
    channelId: string | readonly string[],
    available: boolean,
    empty: T,
    load: (signal: AbortSignal) => Promise<T>,
    accept?: (data: T) => void,
    cached?: { data: T; isFresh(): boolean },
    needsFreshRead?: () => boolean,
  ): WorkflowView<T> {
    const channelIds =
      typeof channelId === "string" ? [channelId] : [...new Set(channelId)];
    if (
      !channelIds.length ||
      channelIds.length > WORKFLOW_CHANNEL_BATCH ||
      channelIds.some((id) => !UUID.test(id))
    )
      throw new Error("Invalid workflow channels");
    const accessible = () => channelIds.every(canAccess);
    if (views.size >= 16)
      throw new Error("Too many workflow views; close another detail first");
    let disposed = false;
    let controller: AbortController | undefined;
    let pending: Promise<void> | undefined;
    const subscribers = new Set<() => void>();
    type Snapshot = ReturnType<WorkflowView<T>["snapshot"]>;
    let snapshot: Snapshot = Object.freeze({
      status:
        available && !closed && accessible()
          ? cached
            ? "ready"
            : "idle"
          : "unavailable",
      data:
        available && !closed && accessible() ? (cached?.data ?? empty) : empty,
    });
    const emit = () => {
      for (const listener of subscribers) notify(listener);
    };
    function clear() {
      controller?.abort();
      controller = undefined;
      pending = undefined;
      snapshot = Object.freeze({
        status:
          available && !closed && !disposed && accessible()
            ? "idle"
            : "unavailable",
        data: empty,
      });
    }
    const owner = {
      clear,
      interrupt() {
        controller?.abort();
        controller = undefined;
        pending = undefined;
        // Even an idle invalidation observer must distinguish interruption
        // (retain copied data) from clear/access loss (purge it).
        if (snapshot.status === "unavailable") return;
        snapshot = Object.freeze({
          status: "error",
          data: snapshot.data,
          error:
            "Connection interrupted. Refresh to check current workflow data; your draft is retained.",
        });
      },
      emit,
      dispose() {
        disposed = true;
        clear();
        subscribers.clear();
        views.delete(owner);
      },
    };
    views.add(owner);
    const ownerView = Object.freeze({
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed || disposed) return () => {};
        subscribers.add(listener);
        return () => {
          subscribers.delete(listener);
        };
      },
      refresh({ ifStale = false } = {}): Promise<void> {
        if (closed || disposed || !available) return Promise.resolve();
        if (!accessible()) {
          clear();
          emit();
          return Promise.resolve();
        }
        if (pending) {
          const signal = controller?.signal;
          return needsFreshRead?.()
            ? pending.then(() =>
                signal?.aborted ? undefined : ownerView.refresh(),
              )
            : pending;
        }
        if (ifStale && snapshot.status === "ready" && cached?.isFresh())
          return Promise.resolve();
        const owned = new AbortController();
        controller = owned;
        // Paged batches use the shared reader's deadline for each request.
        const signal =
          typeof channelId !== "string"
            ? owned.signal
            : AbortSignal.any([owned.signal, AbortSignal.timeout(10000)]);
        snapshot = Object.freeze({ status: "loading", data: snapshot.data });
        pending = Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            if (!accessible())
              throw new Error("Workflow channel access unavailable");
            return load(signal);
          })
          .then((data) => {
            if (
              closed ||
              disposed ||
              controller !== owned ||
              signal.aborted ||
              !accessible()
            )
              return;
            snapshot = Object.freeze({ status: "ready", data });
            accept?.(data);
            emit();
          })
          .catch(() => {
            if (
              closed ||
              disposed ||
              controller !== owned ||
              owned.signal.aborted
            )
              return;
            snapshot = Object.freeze({
              status: "error",
              data: empty,
              error: "Couldn't read workflow data. Try again.",
            });
            emit();
          })
          .finally(() => {
            if (controller === owned) {
              controller = undefined;
              pending = undefined;
            }
          });
        const started = pending;
        emit();
        return started;
      },
      dispose: owner.dispose,
    });
    return ownerView;
  }
  function assertOperation(kind: number) {
    const enabled =
      kind === 30620
        ? availability.save
        : kind === 46020
          ? availability.trigger
          : availability.delete;
    if (!enabled)
      throw new Error("Workflow writes are unavailable on this connection");
  }
  const permissions = Object.freeze({
    canDelete(workflow: WorkflowReference) {
      return (
        !closed &&
        canAccess(workflow.channelId) &&
        (workflow.owner === viewer ||
          profiles?.owner?.(workflow.owner) === viewer)
      );
    },
    subscribe(listener: () => void) {
      const stopProfiles = profiles?.subscribe(listener);
      // clear() and dispose() already rebuild after access/lifetime changes.
      listeners.add(listener);
      return () => {
        stopProfiles?.();
        listeners.delete(listener);
      };
    },
  });
  function send(
    kind: 30620 | 46020 | 5,
    workflow: WorkflowReference,
    yaml = "",
    revision?: string,
  ) {
    assertAccess(workflow);
    if (
      kind === 5 ? !permissions.canDelete(workflow) : workflow.owner !== viewer
    )
      throw new Error("Only the workflow owner can modify or run it");
    assertOperation(kind);
    const tags = [
      ["h", workflow.channelId],
      ...(kind === 5
        ? [["a", `30620:${workflow.owner}:${workflow.id}`]]
        : [["d", workflow.id]]),
      ...(revision ? [["expected-revision", revision]] : []),
    ];
    const input = { kind, content: yaml, tags };
    validateWorkflowEvent(
      { ...input, pubkey: viewer, id: "", created_at: 0 },
      viewer,
    );
    if (!outbox) throw new Error("Workflow publishing unavailable");
    if (receiptInterest.size >= 256)
      throw new Error("Too many unresolved workflow commands");
    const id = outbox.send(input);
    if (kind !== 46020) invalidateDefinitionCache();
    receiptInterest.add(id);
    return id;
  }
  const capability = Object.freeze<WorkflowCapability>({
    availability,
    permissions,
    definitions(channelId) {
      const aggregate = typeof channelId !== "string";
      const channelIds =
        typeof channelId === "string" ? [channelId] : [...new Set(channelId)];
      const cacheKey = aggregate ? [...channelIds].sort().join(":") : "";
      const cached = aggregate ? cachedDefinitions(cacheKey) : undefined;
      let readVersion = definitionCacheVersion;
      let acceptedDeletions = new Set<string>();
      return view<WorkflowDefinitions>(
        channelId,
        !!reader,
        Object.freeze({
          items: Object.freeze([] as WorkflowDefinition[]),
          partial: false,
        }),
        async (signal) => {
          if (!reader) throw new Error("Workflow definitions unavailable");
          readVersion = definitionCacheVersion;
          // Only receipts received before this read can use absence as readback.
          acceptedDeletions = new Set(
            operations
              .filter((op) => results.get(op.eventId)?.deletionAccepted)
              .map((op) => op.eventId),
          );
          const coordinates = new Map<string, WorkflowDefinition>();
          let cursor: { until: number; before_id: string } | undefined;
          let partial = false;
          while (true) {
            signal.throwIfAborted();
            if (!channelIds.every(canAccess))
              throw new Error("Workflow channel access unavailable");
            const events = await reader.read(
              [
                {
                  kinds: [30620],
                  "#h": channelIds,
                  limit: WORKFLOW_DEFINITION_LIMIT,
                  ...cursor,
                },
              ],
              { signal, fresh: true },
            );
            signal.throwIfAborted();
            if (!channelIds.every(canAccess))
              throw new Error("Workflow channel access unavailable");
            const page = [
              ...new Map(events.map((event) => [event.id, event])).values(),
            ].sort(
              (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
            );
            for (const event of page) {
              if (
                cursor &&
                (event.created_at > cursor.until ||
                  (event.created_at === cursor.until &&
                    event.id <= cursor.before_id))
              )
                throw new Error("Workflow page did not advance");
              const row = definition(event);
              if (!channelIds.includes(row.channelId))
                throw new Error("Mismatched workflow channel");
              const key = `${row.channelId}:${row.owner}:${row.id}`;
              const old = coordinates.get(key);
              if (
                !old ||
                row.createdAt > old.createdAt ||
                (row.createdAt === old.createdAt && row.revision < old.revision)
              )
                coordinates.set(key, row);
            }
            const full = page.length >= WORKFLOW_DEFINITION_LIMIT;
            if (!aggregate) {
              partial = full;
              break;
            }
            const last = page.at(-1);
            if (!full || !last) break;
            cursor = { until: last.created_at, before_id: last.id };
          }
          return Object.freeze({
            items: Object.freeze([...coordinates.values()]),
            partial,
            partialChannelIds: Object.freeze(partial ? channelIds : []),
          });
        },
        (data) => {
          if (aggregate)
            retainDefinitions(cacheKey, channelIds, data, readVersion);
          const { items, partialChannelIds } = data;
          // Only a fresh, verified exact configuration head resolves an unknown
          // save. An echo, another revision, or run history cannot do so.
          let changed = false;
          for (const op of operations) {
            if (
              op.action === "delete" &&
              op.outcome === "unknown" &&
              acceptedDeletions.has(op.eventId) &&
              channelIds.includes(op.workflow.channelId) &&
              !partialChannelIds?.includes(op.workflow.channelId) &&
              !items.some(
                (row) =>
                  row.owner === op.workflow.owner &&
                  row.channelId === op.workflow.channelId &&
                  row.id === op.workflow.id,
              )
            ) {
              results.set(op.eventId, {
                outcome: "succeeded",
                deletionAccepted: true,
              });
              changed = true;
              continue;
            }
            if (
              op.action !== "save" ||
              op.outcome !== "unknown" ||
              !items.some(
                (row) =>
                  row.revision === op.eventId &&
                  row.owner === op.workflow.owner &&
                  row.channelId === op.workflow.channelId &&
                  row.id === op.workflow.id,
              )
            )
              continue;
            results.set(op.eventId, { outcome: "succeeded" });
            // Exact readback proves the configuration, not delivery of the
            // one-time webhook secret. The pending receipt still owns that.
            changed = true;
          }
          if (changed) rebuild();
        },
        cached
          ? {
              data: cached.data,
              isFresh: () =>
                definitionCache.get(cacheKey) === cached &&
                Date.now() - cached.readAt < WORKFLOW_DEFINITION_CACHE_FRESH_MS,
            }
          : undefined,
        () =>
          operations.some(
            (op) =>
              channelIds.includes(op.workflow.channelId) &&
              results.get(op.eventId)?.deletionAccepted &&
              !acceptedDeletions.has(op.eventId),
          ),
      );
    },
    runs(workflow, cursor) {
      assertAccess(workflow);
      return view(
        workflow.channelId,
        !!host,
        Object.freeze({ runs: Object.freeze([]), next: null }),
        async (signal) => {
          if (!host) throw new Error("Workflow history unavailable");
          return parseRuns(
            await host.runs(workflow.id, cursor, signal),
            workflow.id,
          );
        },
      );
    },
    save({ channelId, yaml, existing }) {
      if (existing && existing.channelId !== channelId)
        throw new Error("Workflow channel cannot change");
      return send(
        30620,
        existing ?? { channelId, owner: viewer, id: crypto.randomUUID() },
        yaml,
        existing?.revision,
      );
    },
    delete(workflow) {
      return send(5, workflow);
    },
    trigger(workflow) {
      return send(46020, workflow);
    },
    takeWebhookSecret(eventId) {
      const secret = secrets.get(eventId);
      if (secret === undefined) return undefined;
      secrets.delete(eventId);
      rebuild();
      return secret;
    },
    webhookUrl(workflowId) {
      return relayHttpUrl ? hookUrl(relayHttpUrl, workflowId) : undefined;
    },
    operations: Object.freeze<WorkflowCapability["operations"]>({
      snapshot: () => operations,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async dismiss(id) {
        await outbox?.dismiss(id);
        // The outbox cannot dismiss an active attempt, including one already
        // echoed by the relay. Do not tell the editor it may unlock that intent.
        if (local?.snapshot().some((item) => item.event.id === id))
          throw new Error(
            "Command is still being delivered; wait before dismissing it",
          );
        results.delete(id);
        receiptInterest.delete(id);
        rebuild();
      },
    }),
  });
  return {
    capability,
    validate(event: EventData) {
      if (!isWorkflowOperation(event)) return;
      assertOperation(event.kind);
      const reference = validateWorkflowEvent(event, viewer);
      assertAccess(reference);
      if (event.kind === 5 && !permissions.canDelete(reference))
        throw new Error(
          "Only the author or their verified agent owner can delete this workflow",
        );
    },
    receipt(event: EventData, message: string | undefined) {
      if (closed || !receiptInterest.delete(event.id)) return;
      if (event.kind !== 46020) invalidateDefinitionCache();
      if (message === undefined) {
        if (results.get(event.id)?.outcome !== "succeeded")
          results.delete(event.id);
        rebuild();
        return;
      }
      let result: Result = {
        outcome: "unknown",
        error:
          "Delivery may have succeeded, but its result is unavailable. Do not submit a new command to retry.",
      };
      try {
        assertAccess(workflowReference(event));
        if (event.kind === 5 && message === "") result.deletionAccepted = true;
        if (message?.startsWith("response:")) {
          const value: unknown = JSON.parse(message.slice(9));
          const reference = workflowReference(event);
          if (
            record(value) &&
            (event.kind === 46020
              ? value.workflow_id === undefined ||
                value.workflow_id === reference.id
              : value.workflow_id === reference.id)
          ) {
            const secret = value.webhook_secret;
            // Only a save receives a secret, and only when the workflow first
            // gains a webhook trigger. Hold it for one UI take; never store it
            // on the result.
            if (event.kind === 30620) {
              if (secret === undefined || typeof secret === "string") {
                result = { outcome: "succeeded" };
                if (typeof secret === "string") secrets.set(event.id, secret);
              }
            } else if (secret !== undefined) {
              /* Unexpected secret on a run or deletion: stay unknown. */
            } else if (
              event.kind === 46020 &&
              typeof value.run_id === "string" &&
              UUID.test(value.run_id)
            )
              result = { outcome: "succeeded", runId: value.run_id };
            else if (event.kind === 5 && value.deleted === true)
              result = { outcome: "succeeded", deletionAccepted: true };
          }
        }
      } catch {
        /* Do not leak receipt text into errors/journal. */
      }
      // An unavailable/malformed receipt cannot undo verified exact readback.
      if (
        result.outcome === "succeeded" ||
        results.get(event.id)?.outcome !== "succeeded"
      )
        results.set(event.id, result);
      rebuild();
    },
    interrupt() {
      invalidateDefinitionCache();
      // Socket recovery retires reads, not editor intent or HTTP receipt interest.
      for (const owned of views) owned.interrupt();
      for (const owned of views) owned.emit();
    },
    clear() {
      invalidateDefinitionCache();
      results.clear();
      secrets.clear();
      receiptInterest.clear();
      for (const owned of views) owned.clear();
      rebuild();
      for (const owned of views) owned.emit();
      // Individual view snapshots were cleared before any view callbacks.
      // Views refresh on explicit UI interest; no startup/background fanout.
    },
    dispose() {
      closed = true;
      invalidateDefinitionCache();
      for (const owned of [...views]) owned.dispose();
      results.clear();
      secrets.clear();
      receiptInterest.clear();
      stop?.();
      rebuild();
      listeners.clear();
    },
  };
}
