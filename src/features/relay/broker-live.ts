import { observerFrame, observerGeneration } from "../agents/observer";
import { createEventVerifier } from "./events";
import type {
  ArtifactSyncFilter,
  ArtifactSyncSink,
} from "./artifact-sync-filter.ts";
import {
  LIVE_PROOF_ENTRIES,
  LIVE_RECOVERY_INTERVAL,
  liveSlowRetryDelay,
  liveChannels,
  livePresenceAuthors,
  liveJoined,
  liveProvenance,
  liveGlobal,
  liveContinuous,
  type LiveCallbacks,
  type LiveSnapshot,
  type LiveRoute,
  type LiveSubscription,
} from "./live";

const MAX_FRAME = 8 * 1024 * 1024;
const MAX_RETRY_MS = 30_000;
/** A generation owns its stream, parser, retry and heartbeat. Interest changes
 * use the same host owner so they cannot interrupt pending publications. */
export function subscribeBrokerTraffic(
  endpoint: string,
  callbacks: LiveCallbacks,
): LiveSubscription {
  let closed = false,
    generation = 0,
    attempts = 0,
    refusals = 0;
  // Outlives each stream, so a reconnect's replay reuses the proofs.
  const verify = createEventVerifier(LIVE_PROOF_ENTRIES);
  let channels: string[] = [];
  let joined: string[] = [];
  let sentChannels: string[] = [];
  // Only IDs in the last dispatched snapshot can have a host wire.
  const removed = new Set<string>();
  let interestRevision = 0;
  const addedAt = new Map<string, number>();
  const currentChannel = (id: string, revision: unknown) => {
    const minimum = addedAt.get(id);
    return (
      minimum !== undefined &&
      (revision === undefined ||
        (Number.isSafeInteger(revision) &&
          (revision as number) >= minimum &&
          (revision as number) <= interestRevision))
    );
  };
  let priority: string[] = [];
  let priorityPending = false;
  let interestsPending = false;
  let observer: number | null = null;
  let observerPending = false;
  let presenceAuthors: string[] = [];
  let presencePending = false;
  let controller: AbortController | undefined;
  let streamId: string | undefined;
  let controlPending = false;
  let receiving = false;
  const routeState = new Map<string, LiveRoute>();
  let latest: LiveSnapshot = { status: "connecting", routes: [] };
  let retryControlError: string | undefined;
  const publish = (snapshot: LiveSnapshot) => {
    latest = snapshot;
    callbacks.state(snapshot);
  };
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  // NIP-AR syncs ride the stream: one host REQ each, ended when the stream ends.
  type BrokerSync = {
    id: string;
    filter: ArtifactSyncFilter;
    sink: ArtifactSyncSink;
    sent?: number;
  };
  const syncs = new Map<string, BrokerSync>();
  let syncSerial = 0;
  const loseSyncs = (reason: string) => {
    for (const sync of [...syncs.values()])
      if (sync.sent !== undefined) {
        syncs.delete(sync.id);
        sync.sink.closed(reason);
      }
  };
  // A refusal the host sends before it allocates anything.
  class SyncRefused extends Error {}
  /** End `id` on the host. The host remembers a close that arrives before
   * its open, so the order of the two POSTs does not matter. If the close
   * itself has no known outcome, the stream is reset: the host ends every
   * sync with its stream, so no host sync can outlive this one. */
  function retireSync(id: string) {
    if (closed || !streamId) return;
    const current = generation;
    void fetch(`${endpoint}/stream-artifact-sync-close`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, id }),
      signal: AbortSignal.any([
        controller?.signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    })
      .then((response) => {
        // 404: the stream, and so every sync on it, is already gone.
        if (!response.ok && response.status !== 404)
          throw new Error("Artifact sync close failed");
      })
      .catch(() => {
        if (!closed && current === generation)
          controller?.abort(new Error("Artifact sync close interrupted"));
      });
  }
  function openSync(sync: BrokerSync) {
    if (closed || !streamId) return;
    const current = generation;
    sync.sent = current;
    void fetch(`${endpoint}/stream-artifact-sync`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, id: sync.id, filter: sync.filter }),
      signal: AbortSignal.any([
        controller?.signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    })
      .then((response) => {
        if (response.ok) return;
        const message = `broker refused sync (${response.status})`;
        throw response.status >= 400 && response.status < 500
          ? new SyncRefused(message)
          : new Error(message);
      })
      .catch((error) => {
        if (closed || current !== generation || syncs.get(sync.id) !== sync)
          return;
        syncs.delete(sync.id);
        // A timeout, network error or 5xx does not say whether the host
        // opened the sync: end it there too, so it cannot hold a slot.
        if (!(error instanceof SyncRefused)) retireSync(sync.id);
        sync.sink.closed(
          `error: ${error instanceof Error ? error.message : "broker sync failed"}`,
        );
      });
  }
  const state = (status: LiveSnapshot["status"], error?: string) =>
    publish({ status, routes: [], ...(error ? { error } : {}) });
  function start() {
    if (closed) return;
    loseSyncs("disconnected: live broker restarted");
    const current = ++generation;
    streamId = undefined;
    controlPending = false;
    priorityPending = false;
    interestsPending = false;
    observerPending = false;
    presencePending = false;
    receiving = true;
    controller?.abort();
    clearTimeout(retryTimer);
    clearTimeout(heartbeat);
    const owned = new AbortController();
    controller = owned;
    const valid = () =>
      !closed && current === generation && !owned.signal.aborted;
    routeState.clear();
    state("connecting");
    const pulse = () => {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(
        () => owned.abort(new Error("Live broker heartbeat timed out")),
        45000,
      );
    };
    pulse();
    const startingInterests = interestRevision;
    sentChannels = channels;
    removed.clear();
    const startingPriority = JSON.stringify(priority);
    const startingObserver = observer;
    const startingPresence = JSON.stringify(presenceAuthors);
    void (async () => {
      let opened: number | undefined;
      try {
        const response = await fetch(`${endpoint}/stream`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channels,
            joined,
            priority,
            observer,
            presenceAuthors,
            interestRevision,
            statusDeltas: true,
          }),
          signal: owned.signal,
        });
        if (!valid()) return;
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get("content-type")?.startsWith("text/event-stream")
        ) {
          if ([400, 401, 403, 413].includes(response.status)) {
            // A broker restart drops registrations, so even a 4xx can clear.
            state(
              "error",
              `Live broker rejected subscription (${response.status})`,
            );
            retryTimer = setTimeout(start, liveSlowRetryDelay(++refusals));
            return;
          }
          throw new Error(`Live broker unavailable (${response.status})`);
        }
        const identity = response.headers.get("x-buzz-live-id");
        if (identity !== null && !/^[0-9a-f]{32}$/.test(identity))
          throw new Error("Invalid live broker control identity");
        streamId = identity ?? undefined;
        opened = Date.now();
        if (startingInterests !== interestRevision) sendInterests();
        if (startingPriority !== JSON.stringify(priority)) sendPriority();
        if (startingObserver !== observer) sendObserver();
        if (startingPresence !== JSON.stringify(presenceAuthors))
          sendPresence();
        for (const sync of syncs.values())
          if (sync.sent === undefined) openSync(sync);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (valid()) {
            const { value, done } = await reader.read();
            if (!valid()) return;
            if (done) throw new Error("Live broker connection ended");
            pulse();
            buffer += decoder.decode(value, { stream: true });
            while (/\r?\n\r?\n/.test(buffer)) {
              const separator = /\r?\n\r?\n/.exec(buffer);
              if (!separator) break;
              const end = separator.index;
              if (end > MAX_FRAME)
                throw new Error("Live broker frame too large");
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + separator[0].length);
              let kind = "message";
              const lines: string[] = [];
              for (const line of frame.split(/\r?\n/)) {
                if (line.startsWith("event:")) kind = line.slice(6).trim();
                else if (line.startsWith("data:"))
                  lines.push(line.slice(5).trimStart());
              }
              if (!lines.length) continue; // Keepalives carry no data.
              const data: unknown = JSON.parse(lines.join("\n"));
              if (!valid()) return;
              if (kind === "message") callbacks.receive([verify(data)]);
              else if (kind === "traffic") {
                if (
                  !data ||
                  typeof data !== "object" ||
                  !("event" in data) ||
                  !("provenance" in data)
                )
                  throw new Error("Invalid live traffic envelope");
                const provenance = liveProvenance(data.provenance);
                const revision = (data as { interestRevision?: unknown })
                  .interestRevision;
                const scopes =
                  provenance.sourceChannels ??
                  (provenance.channelId ? [provenance.channelId] : []);
                if (scopes.every((id) => currentChannel(id, revision)))
                  callbacks.receive([verify(data.event)], provenance);
              } else if (kind === "presence") {
                const event = verify(data);
                if (
                  event.kind === 20001 &&
                  presenceAuthors.includes(event.pubkey)
                )
                  callbacks.presence?.(event);
              } else if (kind === "artifact-sync") {
                const frame = data as {
                  id?: unknown;
                  type?: unknown;
                  event?: unknown;
                  reason?: unknown;
                };
                const sync =
                  typeof frame.id === "string"
                    ? syncs.get(frame.id)
                    : undefined;
                if (sync && sync.sent === current) {
                  if (frame.type === "event")
                    sync.sink.event(verify(frame.event));
                  else if (frame.type === "eose") sync.sink.eose();
                  else if (frame.type === "closed") {
                    syncs.delete(sync.id);
                    sync.sink.closed(
                      typeof frame.reason === "string"
                        ? frame.reason.slice(0, 512)
                        : "error: relay closed the sync",
                    );
                  }
                }
              } else if (kind === "observer") {
                const record = data as {
                  frame?: unknown;
                  generation?: unknown;
                };
                if (observer !== null && record.generation === observer)
                  callbacks.observer?.(observerFrame(record.frame), observer);
              } else if (kind === "state-delta") {
                const snapshot = liveSnapshot(data);
                const delta = data as {
                  interestRevision?: unknown;
                  reset?: unknown;
                  removed?: unknown;
                };
                if (
                  !Number.isSafeInteger(delta.interestRevision) ||
                  (delta.interestRevision as number) < 0 ||
                  (delta.interestRevision as number) > interestRevision ||
                  snapshot.routes.some((route) =>
                    route.channelId
                      ? route.id !== `channel:${route.channelId}`
                      : ![
                          "profiles",
                          "membership",
                          "observer",
                          "presence",
                        ].includes(route.id),
                  ) ||
                  snapshot.routes.length > 512 ||
                  !Array.isArray(delta.removed) ||
                  delta.removed.length + snapshot.routes.length > 512 ||
                  delta.removed.some((id) => typeof id !== "string")
                )
                  throw new Error("Invalid live status delta");
                if (delta.reset === true) {
                  routeState.clear();
                  for (const channelId of channels)
                    routeState.set(
                      `channel:${channelId}`,
                      Object.freeze({
                        id: `channel:${channelId}`,
                        channelId,
                        status: "pending",
                        replay: "unknown",
                      }),
                    );
                }
                for (const id of delta.removed as string[]) {
                  const route = routeState.get(id);
                  if (
                    !route?.channelId ||
                    currentChannel(route.channelId, delta.interestRevision)
                  )
                    routeState.delete(id);
                }
                for (const route of snapshot.routes)
                  if (
                    !route.channelId ||
                    currentChannel(route.channelId, delta.interestRevision)
                  ) {
                    routeState.set(route.id, route);
                  }
                for (const [id, route] of routeState)
                  if (route.channelId && !addedAt.has(route.channelId))
                    routeState.delete(id);
                publish({ ...snapshot, routes: [...routeState.values()] });
              } else if (kind === "state") {
                const snapshot = liveSnapshot(data);
                const revision = (data as { interestRevision?: unknown })
                  .interestRevision;
                publish({
                  ...snapshot,
                  routes: snapshot.routes.filter(
                    (route) =>
                      !route.channelId ||
                      currentChannel(route.channelId, revision),
                  ),
                });
              } else if (kind === "established") {
                const ids = (data as { channels?: unknown }).channels;
                const revision = (data as { interestRevision?: unknown })
                  .interestRevision;
                const continuous = (current: readonly string[]) =>
                  liveContinuous(
                    (data as { continuous?: unknown }).continuous,
                    current,
                  );
                if (ids !== undefined) {
                  const all = liveChannels(ids);
                  const current = all.filter((id) =>
                    currentChannel(id, revision),
                  );
                  // Traffic naming a channel no longer current was dropped
                  // for the whole batch, so no channel of it is continuous.
                  const resumed =
                    current.length < all.length ? [] : continuous(current);
                  if (resumed.length)
                    callbacks.established(current, undefined, resumed);
                  else if (current.length) callbacks.established(current);
                } else {
                  const id = channelField(data);
                  if (id) {
                    if (currentChannel(id, revision)) {
                      const resumed = continuous([id]);
                      if (resumed.length)
                        callbacks.established(id, undefined, resumed);
                      else callbacks.established(id);
                    }
                  } else
                    callbacks.established(
                      undefined,
                      liveGlobal((data as { global?: unknown }).global),
                    );
                }
              } else if (kind === "recover") {
                callbacks.recover?.();
              } else if (kind === "denied") {
                const id = channelField(data);
                if (
                  !id ||
                  typeof (data as { reason?: unknown }).reason !== "string"
                )
                  throw new Error("Invalid live denial");
                if (
                  currentChannel(
                    id,
                    (data as { interestRevision?: unknown }).interestRevision,
                  )
                )
                  callbacks.denied(id, (data as { reason: string }).reason);
              }
              if (!valid()) return;
            }
            if (buffer.length > MAX_FRAME)
              throw new Error("Live broker frame too large");
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        if (closed || current !== generation) return;
        loseSyncs("disconnected: live broker interrupted");
        // A stream up for a minute proves the broker healthy again. Its first
        // frame does not: every accepted stream sends its state at once.
        if (
          opened !== undefined &&
          Date.now() - opened >= LIVE_RECOVERY_INTERVAL
        )
          attempts = refusals = 0;
        state(
          "retrying",
          error instanceof Error ? error.message : "Live broker interrupted",
        );
        // Never give up: a laptop can take minutes to get its network back.
        retryTimer = setTimeout(
          start,
          Math.min(500 * 2 ** attempts++, MAX_RETRY_MS),
        );
      } finally {
        if (current === generation) {
          streamId = undefined;
          receiving = false;
          clearTimeout(heartbeat);
        }
      }
    })();
  }
  function sendInterests() {
    if (closed || !streamId || interestsPending) return;
    const current = generation;
    const sent = interestRevision;
    interestsPending = true;
    const body = JSON.stringify({
      streamId,
      channels,
      joined,
      removed: [...removed],
      interestRevision,
    });
    sentChannels = channels;
    removed.clear();
    void fetch(`${endpoint}/stream-interests`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.any([
        controller?.signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    })
      .then((response) => {
        if (!response.ok) throw new Error("Live interests control failed");
      })
      .catch(() => {
        // Unknown control outcome: bounded reconnect captures current intent.
        if (!closed && current === generation)
          controller?.abort(new Error("Live interests interrupted"));
      })
      .finally(() => {
        if (current !== generation) return;
        interestsPending = false;
        if (sent !== interestRevision) sendInterests();
      });
  }
  function sendPriority() {
    if (closed || !streamId || priorityPending) return;
    const current = generation;
    const sent = JSON.stringify(priority);
    priorityPending = true;
    void fetch(`${endpoint}/stream-priority`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, channels: priority }),
      signal: AbortSignal.any([
        controller?.signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    })
      .then((response) => {
        if (!closed && current === generation && !response.ok)
          throw new Error(`Live priority control failed (${response.status})`);
      })
      .catch((error) => {
        if (!closed && current === generation)
          publish({ ...latest, error: String(error) });
      })
      .finally(() => {
        if (current !== generation) return;
        priorityPending = false;
        if (sent !== JSON.stringify(priority)) sendPriority();
      });
  }
  function sendObserver() {
    if (closed || !streamId || observerPending) return;
    const current = generation;
    const sent = observer;
    observerPending = true;
    void fetch(`${endpoint}/stream-observer`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, observer: sent }),
      signal: AbortSignal.any([
        controller?.signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    })
      .then((response) => {
        if (!response.ok)
          throw new Error("Activity subscription control failed");
      })
      .catch(() => {
        if (!closed && current === generation) {
          // Unknown control outcome: fence this stream; normal bounded reconnect
          // will capture the latest desired generation (never reset chat on toggle).
          controller?.abort(new Error("Activity subscription interrupted"));
        }
      })
      .finally(() => {
        if (current !== generation) return;
        observerPending = false;
        if (sent !== observer) sendObserver();
      });
  }
  function sendPresence() {
    if (closed || !streamId || presencePending) return;
    const current = generation;
    const sent = JSON.stringify(presenceAuthors);
    presencePending = true;
    void fetch(`${endpoint}/stream-presence-authors`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, authors: presenceAuthors }),
      signal: AbortSignal.any([
        controller?.signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    })
      .then((response) => {
        if (!response.ok)
          throw new Error("Presence subscription control failed");
      })
      .catch(() => {
        // Optional live hints may be lost; bounded snapshots still recover status.
      })
      .finally(() => {
        if (current !== generation) return;
        presencePending = false;
        if (sent !== JSON.stringify(presenceAuthors)) sendPresence();
      });
  }
  start();
  return {
    syncArtifacts(filter, sink) {
      if (closed) {
        queueMicrotask(() =>
          sink.closed("unsupported: relay session disposed"),
        );
        return () => {};
      }
      const sync: BrokerSync = { id: `s${++syncSerial}`, filter, sink };
      syncs.set(sync.id, sync);
      queueMicrotask(() => {
        if (syncs.get(sync.id) === sync && sync.sent === undefined)
          openSync(sync);
      });
      return () => {
        if (syncs.get(sync.id) !== sync) return;
        syncs.delete(sync.id);
        // A sync opened on an earlier stream ended with that stream.
        if (sync.sent === generation) retireSync(sync.id);
      };
    },
    watchPresence(authors) {
      const next = livePresenceAuthors(authors);
      if (closed || JSON.stringify(next) === JSON.stringify(presenceAuthors))
        return;
      presenceAuthors = next;
      // Coalesce lifecycle retirement with disposal/replacement before dispatch.
      queueMicrotask(sendPresence);
    },
    async publishPresence(status, signal) {
      if (closed || !streamId || !controller || latest.status !== "connected")
        return null;
      const current = generation;
      const response = await fetch(`${endpoint}/stream-presence`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId, status }),
        signal: AbortSignal.any([
          signal,
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      if (closed || current !== generation || !response.ok) return false;
      const { accepted, retryAfterMs } = await response.json();
      if (accepted === null) {
        return Number.isSafeInteger(retryAfterMs) &&
          retryAfterMs >= 0 &&
          retryAfterMs <= 86_401_000
          ? { retryAfterMs }
          : null;
      }
      return accepted === true;
    },
    identity: () => (closed ? undefined : streamId),
    observe(value) {
      const next = observerGeneration(value);
      if (closed || observer === next) return;
      observer = next; // Fence old SSE frames synchronously, before the POST completes.
      sendObserver();
    },
    prioritize(input) {
      liveChannels(input);
      const next = [...new Set(input)].slice(0, 64);
      if (closed || JSON.stringify(next) === JSON.stringify(priority)) return;
      priority = next;
      sendPriority();
    },
    update(input, batchable = []) {
      const next = liveChannels(input);
      const nextJoined = liveJoined(next, batchable);
      if (
        closed ||
        (JSON.stringify(next) === JSON.stringify(channels) &&
          JSON.stringify(nextJoined) === JSON.stringify(joined))
      )
        return;
      interestRevision++;
      const nextSet = new Set(next),
        joinedSet = new Set(joined),
        nextJoinedSet = new Set(nextJoined),
        sentSet = new Set(sentChannels);
      for (const id of channels)
        if (!nextSet.has(id) || joinedSet.has(id) !== nextJoinedSet.has(id)) {
          addedAt.delete(id);
          routeState.delete(`channel:${id}`);
          if (sentSet.has(id)) removed.add(id);
        }
      for (const id of next)
        if (!addedAt.has(id)) {
          addedAt.set(id, interestRevision);
          routeState.set(
            `channel:${id}`,
            Object.freeze({
              id: `channel:${id}`,
              channelId: id,
              status: "pending",
              replay: "unknown",
            }),
          );
        }
      channels = next;
      joined = nextJoined;
      sendInterests();
    },
    retry() {
      if (closed || controlPending) return;
      if (!streamId) {
        // Reconnect only when there is no open broker owner to preserve.
        if (receiving) return;
        attempts = 0;
        start();
        return;
      }
      const current = generation;
      controlPending = true;
      void fetch(`${endpoint}/stream-retry`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId }),
        signal: AbortSignal.any([
          controller?.signal ?? new AbortController().signal,
          AbortSignal.timeout(5000),
        ]),
      })
        .then((response) => {
          if (closed || current !== generation) return;
          if (!response.ok)
            throw new Error(`Live retry control failed (${response.status})`);
          if (retryControlError && latest.error === retryControlError) {
            const { error: _error, ...recovered } = latest;
            publish(recovered);
          }
          retryControlError = undefined;
        })
        .catch((error) => {
          if (!closed && current === generation) {
            retryControlError =
              error instanceof Error ? error.message : "Live retry unavailable";
            publish({
              ...latest,
              error: retryControlError,
            });
          }
        })
        .finally(() => {
          if (current === generation) controlPending = false;
        });
    },
    dispose() {
      closed = true;
      generation++;
      const ending = [...syncs.values()];
      syncs.clear();
      for (const sync of ending)
        sync.sink.closed("unsupported: relay session disposed");
      controller?.abort();
      clearTimeout(retryTimer);
      clearTimeout(heartbeat);
    },
  };
}
function channelField(data: unknown): string | undefined {
  if (!data || typeof data !== "object")
    throw new Error("Invalid live broker notification");
  const id = (data as { channelId?: unknown }).channelId;
  return id === undefined ? undefined : liveChannels([id])[0];
}
function liveSnapshot(value: unknown): LiveSnapshot {
  if (!value || typeof value !== "object")
    throw new Error("Invalid live broker status");
  const snapshot = value as LiveSnapshot;
  if (
    !["connecting", "connected", "retrying", "error"].includes(
      snapshot.status,
    ) ||
    !Array.isArray(snapshot.routes) ||
    (snapshot.error !== undefined && typeof snapshot.error !== "string")
  )
    throw new Error("Invalid live broker status");
  for (const route of snapshot.routes) {
    if (
      !route ||
      typeof route.id !== "string" ||
      !["pending", "live", "error", "limited"].includes(route.status) ||
      !["unknown", "limited"].includes(route.replay) ||
      (route.error !== undefined && typeof route.error !== "string")
    )
      throw new Error("Invalid live route status");
    channelField(route);
  }
  return Object.freeze({
    ...snapshot,
    routes: Object.freeze(
      snapshot.routes.map((route) => Object.freeze({ ...route })),
    ),
  });
}
