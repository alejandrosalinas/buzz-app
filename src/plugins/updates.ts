import { gitScope } from "./git-scope";
import { samePluginRelease } from "./same-release";
import { managedBy } from "./managed";
import type { PluginManager } from "./manager";
import type { ImportPreview } from "./types";

export type GitUpdateSource = {
  repository: string;
  reference: string;
  path: string;
  commit?: string;
};
export type PluginUpdate = {
  id: string;
  source: GitUpdateSource;
  installedRevision: string;
  installedPublisher: string | null;
  installedEnabled: boolean;
  updateChoice: boolean | null;
  candidate?: ImportPreview["candidates"][number];
  error?: string;
  token?: PluginUpdateToken;
};

const MISMATCH =
  "The repository does not match the managed commit. Try again after the recommendation is corrected.";
const MISSING = "The saved repository has no plugin at its installed path.";

/**
 * Returns a hint only when Buzz recognizes an update-check failure. This is not
 * a verdict: repository-not-found and missing-username errors can also reflect
 * access that Buzz could not verify.
 */
export function updateFailure({
  error = "",
  source,
}: Pick<PluginUpdate, "error" | "source">): string | undefined {
  if (
    /repository not found|repository '[^']*' not found|does not appear to be a git repository/i.test(
      error,
    )
  )
    return "Git couldn’t find this plugin’s repository. It may have moved, been removed, or need access you don’t have.";
  if (
    /^https?:/i.test(source.repository) &&
    /could not read Username/i.test(error)
  )
    return "Git needs a sign-in for this repository that Buzz couldn’t provide.";
  if (error === MISMATCH || error === MISSING) return error;
}

declare const pluginUpdateToken: unique symbol;
export type PluginUpdateToken = string & {
  readonly [pluginUpdateToken]: true;
};

declare const pluginUpdateOwnerId: unique symbol;
export type PluginUpdateOwnerId = string & {
  readonly [pluginUpdateOwnerId]: true;
};

export type PluginUpdateStatus =
  | "disabled"
  | "unavailable"
  | "checking"
  | "fresh"
  | "stale"
  | "error";

export type PluginUpdateSnapshot = Readonly<{
  /** Aggregate checker status; `fresh` does not establish any individual plugin is up to date. */
  status: PluginUpdateStatus;
  /** Completion time of the last check, in epoch milliseconds. */
  checkedAt: number | null;
  /** Known updates only; absence from this list is not a per-plugin result. */
  candidates: readonly Readonly<{
    token: PluginUpdateToken;
    id: string;
    name: string;
    installedRevision: string;
    candidateRevision: string;
  }>[];
  /** Known check failures only; absence from this list is not a per-plugin result. */
  errors: readonly Readonly<{ id: string; message: string }>[];
}>;

export type PluginUpdateQueueItemStatus =
  | "queued"
  | "reviewing"
  | "installed"
  | "partial"
  | "cancelled"
  | "failed";

export type PluginUpdateQueueStatus =
  | "queued"
  | "reviewing"
  | "completed"
  | "cancelled"
  | "failed"
  | "partial";

export type PluginUpdateQueueSnapshot = Readonly<{
  id: string;
  status: PluginUpdateQueueStatus;
  items: readonly Readonly<{
    token: PluginUpdateToken;
    id: string;
    status: PluginUpdateQueueItemStatus;
    error?: string;
  }>[];
}>;

export type PluginUpdateQueueRequest = Readonly<{
  /** The provider identity captured before the original submission. */
  ownerId: PluginUpdateOwnerId;
  requestId: string;
  tokens: readonly PluginUpdateToken[];
}>;

export type PluginUpdateQueueRequestIdentity = Readonly<
  Pick<PluginUpdateQueueRequest, "ownerId" | "requestId">
>;

export type PluginUpdateQueueRequestResult =
  | Readonly<{ status: "admitted"; queue: PluginUpdateQueueSnapshot }>
  | Readonly<{ status: "not-admitted" }>
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "conflict" }>;

export type PluginUpdateCapability = Readonly<{
  /** Identifies this queue provider lifetime; changes when its retained state is lost. */
  ownerId: PluginUpdateOwnerId | undefined;
  getSnapshot(): PluginUpdateSnapshot;
  subscribe(listener: () => void): () => void;
  /** Explicitly refreshes the one host-retained checker. */
  refresh(): Promise<PluginUpdateSnapshot>;
  /**
   * Starts a serialized explicit-review queue when every token still names a
   * current candidate from a recent completed check. An unrelated source error
   * or source change after that check does not invalidate another current token;
   * source drift during a check invalidates tokens from that run. Admission is
   * refused while 50 update queues are pending or reviewing. Callers that may
   * retry after an ambiguous result must reuse the same ownerId, requestId,
   * and tokens.
   */
  queueUpdates(
    tokens: readonly PluginUpdateToken[],
    /** Stable across retries/remounts and bound to this provider lifetime. */
    request?: PluginUpdateQueueRequestIdentity,
  ): PluginUpdateQueueSnapshot | undefined;
  /** Reconciles one exact request without creating or retrying a queue. */
  getQueueRequest(
    request: PluginUpdateQueueRequest,
  ): PluginUpdateQueueRequestResult;
  /** Returns the retained queue while this host process is alive. */
  getQueue(id: string): PluginUpdateQueueSnapshot | undefined;
  subscribeQueue(id: string, listener: () => void): () => void;
  /** Stops queued/unopened reviews; an already-confirmed operation is not undone. */
  cancelQueue(id: string): boolean;
  /**
   * `retired` only when this host process saw that exact provider lifetime end
   * with no queued, reviewing, or confirmed operation left; otherwise `unknown`.
   * Missing on older hosts. Says nothing about the outcome of an earlier request.
   */
  getOwnerStatus?(ownerId: PluginUpdateOwnerId): "retired" | "unknown";
}>;

function freezeSnapshot(snapshot: PluginUpdateSnapshot): PluginUpdateSnapshot {
  return Object.freeze({
    ...snapshot,
    candidates: Object.freeze(
      snapshot.candidates.map((candidate) => Object.freeze({ ...candidate })),
    ),
    errors: Object.freeze(
      snapshot.errors.map((error) => Object.freeze({ ...error })),
    ),
  });
}

function notifySafely(listeners: ReadonlySet<() => void>) {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      console.error("Plugin update subscriber failed");
    }
  }
}

type UpdateQueueRecord = {
  id: string;
  callerId: string | undefined;
  items: {
    token: PluginUpdateToken;
    id: string;
    status: PluginUpdateQueueItemStatus;
    update: PluginUpdate;
    error: string | undefined;
    installing: boolean;
    confirmed: boolean;
    activationStarted: boolean;
  }[];
  cancelRequested: boolean;
  snapshot: PluginUpdateQueueSnapshot | undefined;
};
type ActiveUpdateReview = {
  queueId: string;
  callerId: string | undefined;
  token: PluginUpdateToken;
  update: PluginUpdate;
};

export function pluginUpdateSource(plugins: PluginManager, id: string) {
  const { configuration } = plugins.snapshot();
  if (configuration.status !== "ready") return;
  const plugin = configuration.catalog.plugins.find(
    (p) => p.manifest.id === id,
  );
  const saved = plugin?.updateSource;
  if (
    plugin?.source !== "external" ||
    !plugin.manifest.updates ||
    !(plugin.updateChecks ?? plugin.manifest.updates.defaultEnabled) ||
    !saved ||
    !("repository" in saved)
  )
    return;
  const managed = managedBy(configuration.managed, id)?.entry;
  if (managed && "url" in managed) return;
  return managed
    ? {
        repository: managed.repository,
        reference: managed.reference,
        path: managed.path,
        commit: managed.commit,
      }
    : {
        repository: saved.repository,
        reference: saved.reference,
        path: saved.path,
      };
}

export const updateSourceKey = (source: GitUpdateSource) =>
  JSON.stringify([
    source.repository,
    source.reference,
    source.path,
    source.commit,
  ]);

const MAX_RETAINED_UPDATE_QUEUES = 50;
const MAX_RETAINED_UPDATE_REQUESTS = 1024;
const MAX_RETAINED_UPDATE_OWNERS = 16;

function uniqueQueueTokens(tokens: readonly PluginUpdateToken[]) {
  return [...new Set(tokens)];
}

function queueRequestTokens(tokens: readonly PluginUpdateToken[]) {
  return JSON.stringify(uniqueQueueTokens(tokens));
}

export function createPluginUpdates(
  plugins: PluginManager,
  authorizeGit: (
    repository: string,
  ) => Promise<{ repository: string; token: string } | null>,
) {
  const ownerId = crypto.randomUUID() as PluginUpdateOwnerId;
  const lifetime = { ownerId, retired: false };
  let updates: readonly PluginUpdate[] = [];
  let closed = false;
  let pending: Promise<number | undefined> | undefined;
  let refreshing: Promise<PluginUpdateSnapshot> | undefined;
  let lastCallerRefresh: number | undefined;
  let retry = false;
  let checking = false;
  let lastCheck: number | undefined;
  let lastSources = "";
  let lastErrors = false;
  let freshnessTimer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  const dismissed = new Set<string>();
  const listeners = new Set<() => void>();
  const queues = new Map<string, UpdateQueueRecord>();
  const queueRequests = new Map<
    string | undefined,
    Map<string, { tokens: string; queueId: string }>
  >();
  const queueOrder: string[] = [];
  let activeReview: ActiveUpdateReview | undefined;
  let releaseActiveReview: (() => void) | undefined;
  const releaseReview = () => {
    const release = releaseActiveReview;
    releaseActiveReview = undefined;
    release?.();
    // A confirmed operation keeps its review, and so this lifetime, open past dispose.
    if (closed && !activeReview) lifetime.retired = true;
  };
  const key = (update: PluginUpdate) =>
    `${update.id}:${updateSourceKey(update.source)}:${update.candidate?.revision ?? update.error}:${update.candidate?.publisher ?? ""}`;
  const getSources = () => {
    const { configuration } = plugins.snapshot();
    return configuration.status === "ready"
      ? JSON.stringify(
          configuration.catalog.plugins.flatMap((plugin) => {
            const source = pluginUpdateSource(plugins, plugin.manifest.id);
            return source
              ? [
                  [
                    plugin.manifest.id,
                    plugin.revision,
                    plugin.publisher ?? null,
                    plugin.enabled,
                    plugin.updateChecks ?? null,
                    source,
                  ],
                ]
              : [];
          }),
        )
      : "";
  };
  const getEligibleCount = () => {
    const { configuration } = plugins.snapshot();
    return configuration.status === "ready"
      ? configuration.catalog.plugins.filter((plugin) =>
          pluginUpdateSource(plugins, plugin.manifest.id),
        ).length
      : 0;
  };
  const activationFailure = (
    item: UpdateQueueRecord["items"][number],
    snapshot = plugins.snapshot(),
  ) => {
    const candidateRevision = item.update.candidate?.revision;
    if (
      !candidateRevision ||
      !item.update.installedEnabled ||
      !item.activationStarted
    )
      return;
    const plugin =
      snapshot.configuration.status === "ready"
        ? snapshot.configuration.catalog.plugins.find(
            (entry) => entry.manifest.id === item.id,
          )
        : undefined;
    const activation = snapshot.activation[item.id];
    return plugin?.enabled &&
      plugin.revision === candidateRevision &&
      activation?.revision === candidateRevision &&
      activation.status === "failed"
      ? `The update was installed, but activation failed: ${activation.error ?? "Unknown activation error"}`
      : undefined;
  };
  const snapshotStatus = (): PluginUpdateStatus => {
    const { configuration } = plugins.snapshot();
    if (closed || !plugins.imports || configuration.status !== "ready")
      return "unavailable";
    if (checking) return "checking";
    if (!getEligibleCount()) return "disabled";
    if (
      lastCheck === undefined ||
      Date.now() - lastCheck >= 3_600_000 ||
      getSources() !== lastSources
    )
      return "stale";
    return lastErrors ? "error" : "fresh";
  };
  const makeSnapshot = (): PluginUpdateSnapshot => {
    return freezeSnapshot({
      status: snapshotStatus(),
      checkedAt: lastCheck ?? null,
      candidates: updates.flatMap((update) =>
        update.candidate && update.token
          ? [
              {
                token: update.token,
                id: update.id,
                name: update.candidate.manifest.name,
                installedRevision: update.installedRevision,
                candidateRevision: update.candidate.revision,
              },
            ]
          : [],
      ),
      errors: updates.flatMap((update) =>
        update.error ? [{ id: update.id, message: update.error }] : [],
      ),
    });
  };
  let publicSnapshot = makeSnapshot();
  const readSnapshot = () => {
    const status = snapshotStatus();
    if (publicSnapshot.status !== status)
      publicSnapshot = freezeSnapshot({ ...publicSnapshot, status });
    return publicSnapshot;
  };
  const refreshPublicSnapshot = () => {
    publicSnapshot = makeSnapshot();
  };
  const notify = () => {
    revision++;
    notifySafely(listeners);
  };
  const publish = (next?: readonly PluginUpdate[]) => {
    if (closed) return;
    if (next) updates = next;
    refreshPublicSnapshot();
    notify();
  };
  function current(update: PluginUpdate) {
    const { configuration } = plugins.snapshot();
    const plugin =
      configuration.status === "ready"
        ? configuration.catalog.plugins.find(
            (item) => item.manifest.id === update.id,
          )
        : undefined;
    const source = pluginUpdateSource(plugins, update.id);
    return (
      plugin?.revision === update.installedRevision &&
      (plugin.publisher ?? null) === update.installedPublisher &&
      plugin.enabled === update.installedEnabled &&
      (plugin.updateChecks ?? null) === update.updateChoice &&
      source &&
      updateSourceKey(source) === updateSourceKey(update.source)
    );
  }
  const prune = () => {
    const next = updates.filter(current);
    let queueChanged = false;
    const snapshot = plugins.snapshot();
    for (const queue of queues.values()) {
      for (const item of queue.items) {
        const candidateRevision = item.update.candidate?.revision;
        const activation = snapshot.activation[item.id];
        if (
          item.installing &&
          candidateRevision &&
          activation &&
          activation.revision === candidateRevision &&
          activation.status === "starting"
        )
          item.activationStarted = true;
        if (item.status !== "installed" || !item.activationStarted) continue;
        const failure = activationFailure(item, snapshot);
        if (
          activation &&
          activation.revision === candidateRevision &&
          activation.status !== "starting"
        )
          item.activationStarted = false;
        if (!failure) continue;
        item.status = "partial";
        item.error = failure;
        queue.snapshot = undefined;
        queueChanged = true;
      }
    }
    if (next.length !== updates.length) publish(next);
    else if (queueChanged) {
      refreshPublicSnapshot();
      notify();
    } else if (publicSnapshot.status !== snapshotStatus()) publish();
  };
  const unsubscribe = plugins.subscribe(prune);
  async function run(force: boolean) {
    if (closed || !plugins.imports) return;
    const { configuration } = plugins.snapshot();
    if (configuration.status !== "ready") return;
    const now = Date.now();
    const sources = getSources();
    if (
      !force &&
      sources === lastSources &&
      lastCheck !== undefined &&
      now - lastCheck < 3_600_000
    )
      return;
    lastSources = sources;
    checking = true;
    lastErrors = false;
    publish();
    try {
      const repositories = new Map<string, Promise<ImportPreview | null>>();
      const discover = (source: GitUpdateSource) => {
        const key = JSON.stringify([
          source.repository,
          source.reference,
          source.path,
          source.commit,
        ]);
        let result = repositories.get(key);
        if (!result) {
          result = (async () => {
            const signed = await authorizeGit(source.repository);
            const live = plugins.snapshot().configuration;
            if (
              closed ||
              live.status !== "ready" ||
              !live.catalog.plugins.some((plugin) => {
                const current = pluginUpdateSource(plugins, plugin.manifest.id);
                return (
                  current?.repository === source.repository &&
                  current.reference === source.reference &&
                  current.path === source.path &&
                  current.commit === source.commit
                );
              })
            )
              return null;
            return (
              plugins.imports?.checkGit(
                signed?.repository ?? source.repository,
                source.reference,
                signed?.token,
                ...gitScope(source.commit, source.path),
              ) ?? null
            );
          })();
          repositories.set(key, result);
        }
        return result;
      };
      for (const plugin of configuration.catalog.plugins) {
        if (closed) return;
        const id = plugin.manifest.id;
        const source = pluginUpdateSource(plugins, id);
        if (!source) continue;
        const update: PluginUpdate = {
          id,
          source,
          installedRevision: plugin.revision,
          installedPublisher: plugin.publisher ?? null,
          installedEnabled: plugin.enabled,
          updateChoice: plugin.updateChecks ?? null,
        };
        try {
          const preview = await discover(source);
          if (!preview) throw new Error("No update source found. Try again.");
          if (
            source.commit &&
            preview.commit?.toLowerCase() !== source.commit.toLowerCase()
          )
            throw new Error(
              "The repository does not match the managed commit. Try again after the recommendation is corrected.",
            );
          const candidate = preview.candidates.find(
            (item) => item.manifest.id === id && item.path === source.path,
          );
          if (!candidate)
            throw new Error(
              "The saved repository has no plugin at its installed path.",
            );
          if (!samePluginRelease(candidate, plugin)) {
            update.candidate = candidate;
            const previous = updates.find(
              (item) =>
                item.id === id &&
                item.installedRevision === update.installedRevision &&
                item.installedPublisher === update.installedPublisher &&
                item.installedEnabled === update.installedEnabled &&
                item.updateChoice === update.updateChoice &&
                updateSourceKey(item.source) === updateSourceKey(source) &&
                item.candidate?.revision === candidate.revision &&
                (item.candidate.publisher ?? null) ===
                  (candidate.publisher ?? null),
            );
            update.token =
              previous?.token ?? (crypto.randomUUID() as PluginUpdateToken);
          }
        } catch (reason) {
          update.error =
            reason instanceof Error ? reason.message : String(reason);
          lastErrors = true;
        }
        if (current(update))
          publish([
            ...updates.filter((item) => item.id !== id),
            ...(update.candidate || update.error ? [update] : []),
          ]);
      }
      if (closed) return;
      lastCheck = Date.now();
      if (getSources() !== sources) {
        lastCheck = undefined;
        lastErrors = false;
        retry = true;
      }
    } finally {
      checking = false;
      clearTimeout(freshnessTimer);
      if (!closed) {
        // Notify observers at expiry even when the hidden host does not run discovery.
        if (lastCheck !== undefined)
          freshnessTimer = setTimeout(
            () => publish(),
            Math.max(0, lastCheck + 3_600_000 - Date.now()),
          );
        publish();
      }
    }
  }

  const resolveCandidate = (token: PluginUpdateToken) => {
    const update = updates.find((item) => item.token === token);
    return update?.candidate && current(update) ? update : undefined;
  };
  const isCurrentToken = (token: PluginUpdateToken) =>
    !closed &&
    !!plugins.imports &&
    !checking &&
    lastCheck !== undefined &&
    Date.now() - lastCheck < 3_600_000 &&
    !!resolveCandidate(token);
  const snapshotQueue = (queue: UpdateQueueRecord) => {
    if (queue.snapshot) return queue.snapshot;
    const statuses = queue.items.map((item) => item.status);
    const queued = statuses.includes("queued");
    const reviewing = statuses.includes("reviewing");
    const installed = statuses.includes("installed");
    const partial = statuses.includes("partial");
    const failed = statuses.includes("failed");
    const cancelled = statuses.includes("cancelled");
    const status: PluginUpdateQueueStatus = reviewing
      ? "reviewing"
      : queued
        ? "queued"
        : partial || (installed && (failed || cancelled))
          ? "partial"
          : installed
            ? "completed"
            : failed && cancelled
              ? "partial"
              : failed
                ? "failed"
                : "cancelled";
    queue.snapshot = Object.freeze({
      id: queue.id,
      status,
      items: Object.freeze(
        queue.items.map(({ token, id, status, error }) =>
          Object.freeze({
            token,
            id,
            status,
            ...(error ? { error } : {}),
          }),
        ),
      ),
    });
    return queue.snapshot;
  };
  const queueIsActive = (queue: UpdateQueueRecord) =>
    ["queued", "reviewing"].includes(snapshotQueue(queue).status);
  const pruneQueueHistory = () => {
    while (queues.size > MAX_RETAINED_UPDATE_QUEUES) {
      const oldestTerminal = [...queues.values()].find(
        (queue) => !queueIsActive(queue),
      );
      if (!oldestTerminal) return;
      queues.delete(oldestTerminal.id);
    }
  };
  const notifyQueue = () => {
    refreshPublicSnapshot();
    notify();
  };
  const updateQueue = (queue: UpdateQueueRecord) => {
    queue.snapshot = undefined;
    if (!queueIsActive(queue)) {
      const index = queueOrder.indexOf(queue.id);
      if (index !== -1) queueOrder.splice(index, 1);
    }
    pruneQueueHistory();
    notifyQueue();
  };
  const enqueue = (
    tokens: readonly PluginUpdateToken[],
    request?: PluginUpdateQueueRequestIdentity,
    callerId?: string,
  ) => {
    const requestId = request?.requestId;
    if (
      request !== undefined &&
      (request.ownerId !== ownerId ||
        typeof requestId !== "string" ||
        requestId.length === 0 ||
        requestId.length > 128)
    )
      return undefined;
    const unique = uniqueQueueTokens(tokens);
    const requestTokens = JSON.stringify(unique);
    const history = queueRequests.get(callerId);
    if (requestId !== undefined) {
      const previous = history?.get(requestId);
      if (previous) {
        if (previous.tokens !== requestTokens) return undefined;
        const queue = queues.get(previous.queueId);
        return queue && snapshotQueue(queue);
      }
      if (history && history.size >= MAX_RETAINED_UPDATE_REQUESTS)
        return undefined;
    }
    if (!tokens.length) return undefined;
    if (
      [...queues.values()].filter(queueIsActive).length >=
      MAX_RETAINED_UPDATE_QUEUES
    )
      return undefined;
    const candidates = unique.flatMap((token) => {
      const update = isCurrentToken(token)
        ? resolveCandidate(token)
        : undefined;
      return update ? [{ token, update }] : [];
    });
    if (candidates.length !== unique.length) return undefined;
    const id = crypto.randomUUID();
    const queue: UpdateQueueRecord = {
      id,
      callerId,
      cancelRequested: false,
      items: candidates.map(({ token, update }) => {
        return {
          token,
          id: update.id,
          status: "queued" as const,
          update,
          error: undefined,
          installing: false,
          confirmed: false,
          activationStarted: false,
        };
      }),
      snapshot: undefined,
    };
    queues.set(id, queue);
    queueOrder.push(id);
    if (requestId !== undefined) {
      const next = history ?? new Map();
      next.set(requestId, { tokens: requestTokens, queueId: id });
      queueRequests.set(callerId, next);
    }
    pruneQueueHistory();
    notifyQueue();
    return snapshotQueue(queue);
  };
  const startNextReview = (
    tryHoldReview: () => (() => void) | undefined,
  ): ActiveUpdateReview | undefined => {
    if (activeReview) return undefined;
    if (checking || plugins.snapshot().busy) return undefined;
    for (const queueId of [...queueOrder]) {
      const queue = queues.get(queueId);
      if (!queue || queue.cancelRequested) continue;
      for (const item of queue.items) {
        if (item.status !== "queued") continue;
        const update = resolveCandidate(item.token);
        if (!isCurrentToken(item.token) || !update) {
          item.status = "failed";
          item.error = !plugins.imports
            ? "Plugin update installation is unavailable. Try again later."
            : "This update candidate is stale. Refresh and try again.";
          updateQueue(queue);
          continue;
        }
        const release = tryHoldReview();
        if (!release) return undefined;
        item.update = update;
        item.id = update.id;
        item.status = "reviewing";
        releaseActiveReview = release;
        activeReview = {
          queueId,
          callerId: queue.callerId,
          token: item.token,
          update,
        };
        updateQueue(queue);
        return activeReview;
      }
    }
    return undefined;
  };
  const reviewItem = (queueId: string, token: PluginUpdateToken) => {
    if (activeReview?.queueId !== queueId || activeReview.token !== token)
      return undefined;
    return queues.get(queueId)?.items.find((item) => item.token === token);
  };
  const beginOperation = (queueId: string, token: PluginUpdateToken) => {
    const queue = queues.get(queueId);
    const item = reviewItem(queueId, token);
    if (!queue || queue.cancelRequested || !item || item.status !== "reviewing")
      return undefined;
    if (!isCurrentToken(token)) {
      item.status = "failed";
      item.error = "This update candidate is stale. Refresh and try again.";
      activeReview = undefined;
      releaseReview();
      updateQueue(queue);
      return undefined;
    }
    item.installing = true;
    item.confirmed = true;
    item.error = undefined;
    updateQueue(queue);
    return () => {
      if (!item.installing) return;
      item.installing = false;
      updateQueue(queue);
    };
  };
  const finishReview = (
    queueId: string,
    token: PluginUpdateToken,
    outcome: "installed" | "updated" | "cancelled" | "unavailable",
  ) => {
    const queue = queues.get(queueId);
    const item = reviewItem(queueId, token);
    if (!queue || !item) return false;
    item.installing = false;
    const activationError =
      outcome === "installed" || outcome === "updated"
        ? activationFailure(item)
        : undefined;
    const activation = plugins.snapshot().activation[item.id];
    // Queue history records this activation attempt, not later crashes or retries.
    item.activationStarted &&=
      !!activation &&
      activation.revision === item.update.candidate?.revision &&
      activation.status === "starting";
    item.status = activationError
      ? "partial"
      : outcome === "installed" || outcome === "updated"
        ? "installed"
        : outcome === "cancelled"
          ? "cancelled"
          : "failed";
    item.error = activationError;
    activeReview = undefined;
    releaseReview();
    updateQueue(queue);
    return true;
  };
  const endReview = (
    queueId: string,
    token: PluginUpdateToken,
    error?: string,
  ) => {
    const queue = queues.get(queueId);
    const item = reviewItem(queueId, token);
    if (!queue || !item || item.installing) return false;
    if (item.status === "reviewing") {
      item.status = error || item.confirmed ? "failed" : "cancelled";
      item.error = error;
    }
    activeReview = undefined;
    releaseReview();
    if (error) updates = updates.filter((update) => update.token !== token);
    updateQueue(queue);
    if (error) void check(true);
    return true;
  };
  function check(force = false): Promise<number | undefined> {
    retry ||= force;
    pending ??= (async () => {
      do {
        const forced = retry;
        retry = false;
        await run(forced);
      } while (retry && !closed);
      if (
        closed ||
        !plugins.imports ||
        plugins.snapshot().configuration.status !== "ready"
      )
        return;
      return Math.max(0, (lastCheck ?? Date.now()) + 3_600_000 - Date.now());
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  const getQueueRequest = (
    request: PluginUpdateQueueRequest,
    callerId?: string,
  ): PluginUpdateQueueRequestResult => {
    if (closed || request.ownerId !== ownerId)
      return Object.freeze({ status: "unknown" });
    if (
      typeof request.requestId !== "string" ||
      request.requestId.length === 0 ||
      request.requestId.length > 128
    )
      return Object.freeze({ status: "not-admitted" });
    const previous = queueRequests.get(callerId)?.get(request.requestId);
    if (!previous) return Object.freeze({ status: "not-admitted" });
    if (previous.tokens !== queueRequestTokens(request.tokens))
      return Object.freeze({ status: "conflict" });
    const queue = queues.get(previous.queueId);
    return queue
      ? Object.freeze({ status: "admitted", queue: snapshotQueue(queue) })
      : Object.freeze({ status: "unknown" });
  };
  const capability: PluginUpdateCapability = {
    ownerId,
    getSnapshot: readSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh() {
      if (refreshing) return refreshing;
      const next = check(true).then(readSnapshot);
      const coalesced = next.finally(() => {
        if (refreshing === coalesced) refreshing = undefined;
      });
      refreshing = coalesced;
      return coalesced;
    },
    queueUpdates: enqueue,
    getQueueRequest,
    getQueue(id) {
      const queue = queues.get(id);
      return queue && snapshotQueue(queue);
    },
    subscribeQueue(id, listener) {
      let previous = JSON.stringify(capability.getQueue(id));
      const unsubscribe = capability.subscribe(() => {
        const next = JSON.stringify(capability.getQueue(id));
        if (next === previous) return;
        previous = next;
        listener();
      });
      return unsubscribe;
    },
    cancelQueue(id) {
      const queue = queues.get(id);
      if (
        !queue ||
        queue.cancelRequested ||
        !["queued", "reviewing"].includes(snapshotQueue(queue).status)
      )
        return false;
      queue.cancelRequested = true;
      for (const item of queue.items) {
        if (item.status === "queued") item.status = "cancelled";
      }
      if (
        activeReview?.queueId === id &&
        !queue.items.find((item) => item.token === activeReview?.token)
          ?.installing
      ) {
        const item = queue.items.find(
          (candidate) => candidate.token === activeReview?.token,
        );
        if (item) item.status = "cancelled";
        activeReview = undefined;
        releaseReview();
      }
      updateQueue(queue);
      return true;
    },
  };
  return {
    snapshot: () => updates,
    capability,
    lifetime: lifetime as Readonly<typeof lifetime>,
    forCaller(callerId: string): PluginUpdateCapability {
      return {
        ...capability,
        refresh() {
          if (refreshing) return refreshing;
          if (
            lastCallerRefresh !== undefined &&
            Date.now() - lastCallerRefresh < 60_000
          )
            return Promise.resolve(readSnapshot());
          lastCallerRefresh = Date.now();
          return capability.refresh();
        },
        queueUpdates: (tokens, request) => enqueue(tokens, request, callerId),
        getQueueRequest: (request) => getQueueRequest(request, callerId),
      };
    },
    resolveCandidate,
    isCurrentToken,
    getActiveReview: () => activeReview,
    revision: () => revision,
    startNextReview,
    beginOperation,
    finishReview,
    endReview,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hidden: (update: PluginUpdate) => dismissed.has(key(update)),
    later(update: PluginUpdate) {
      dismissed.add(key(update));
      publish([...updates]);
    },
    check,
    dispose() {
      closed = true;
      clearTimeout(freshnessTimer);
      unsubscribe();
      for (const queue of queues.values()) {
        for (const item of queue.items) {
          if (item.status === "queued") item.status = "cancelled";
          else if (item.status === "reviewing" && !item.installing)
            item.status = "cancelled";
        }
        queue.snapshot = undefined;
      }
      if (
        activeReview &&
        !queues
          .get(activeReview.queueId)
          ?.items.find((item) => item.token === activeReview?.token)?.installing
      )
        activeReview = undefined;
      if (!activeReview) releaseReview();
      listeners.clear();
      queueRequests.clear();
    },
  };
}

export function createPluginUpdateCapabilityBridge() {
  const unavailable: PluginUpdateSnapshot = Object.freeze({
    status: "unavailable",
    checkedAt: null,
    candidates: Object.freeze([]),
    errors: Object.freeze([]),
  });
  let provider:
    | Pick<PluginUpdates, "capability" | "forCaller" | "lifetime">
    | undefined;
  let unsubscribeProvider: (() => void) | undefined;
  // Keep lifetime records, not providers, so replaced providers can be collected.
  const lifetimes = new Map<PluginUpdateOwnerId, PluginUpdates["lifetime"]>();
  const getOwnerStatus = (ownerId: PluginUpdateOwnerId) =>
    lifetimes.get(ownerId)?.retired
      ? ("retired" as const)
      : ("unknown" as const);
  const listeners = new Set<() => void>();
  const notify = () => {
    notifySafely(listeners);
  };
  const createCapability = (
    resolve: () => PluginUpdateCapability | undefined,
  ): PluginUpdateCapability => {
    const capability: PluginUpdateCapability = {
      get ownerId() {
        return resolve()?.ownerId;
      },
      getSnapshot: () => resolve()?.getSnapshot() ?? unavailable,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      refresh: () => resolve()?.refresh() ?? Promise.resolve(unavailable),
      queueUpdates: (tokens, request) =>
        resolve()?.queueUpdates(tokens, request),
      getQueueRequest: (request) =>
        resolve()?.getQueueRequest(request) ??
        Object.freeze({ status: "unknown" }),
      getQueue: (id) => resolve()?.getQueue(id),
      subscribeQueue(id, listener) {
        let previous = JSON.stringify(capability.getQueue(id));
        return capability.subscribe(() => {
          const next = JSON.stringify(capability.getQueue(id));
          if (next === previous) return;
          previous = next;
          listener();
        });
      },
      cancelQueue: (id) => resolve()?.cancelQueue(id) ?? false,
      getOwnerStatus,
    };
    return capability;
  };
  const capability = createCapability(() => provider?.capability);
  return {
    capability,
    forCaller(callerId: string) {
      return createCapability(() => provider?.forCaller(callerId));
    },
    register(next: NonNullable<typeof provider>) {
      unsubscribeProvider?.();
      provider = next;
      lifetimes.delete(next.lifetime.ownerId);
      lifetimes.set(next.lifetime.ownerId, next.lifetime);
      // An evicted lifetime becomes unknown, never retired.
      for (const id of lifetimes.keys())
        if (lifetimes.size > MAX_RETAINED_UPDATE_OWNERS) lifetimes.delete(id);
      unsubscribeProvider = next.capability.subscribe(notify);
      notify();
      return () => {
        if (provider !== next) return;
        unsubscribeProvider?.();
        unsubscribeProvider = undefined;
        provider = undefined;
        notify();
      };
    },
  };
}
export type PluginUpdates = ReturnType<typeof createPluginUpdates>;
