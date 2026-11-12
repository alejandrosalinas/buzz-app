import type { ReadTransport } from "../relay/transport";
import type { LiveSubscription } from "../relay/live";
import { transportPartition } from "../relay/partition";
import type { PresenceActivity } from "./activity";

export type PresenceStatus = "online" | "away" | "offline" | "unknown";
type Subject = {
  listeners: Map<() => void, boolean>;
  profiles: number;
  status: PresenceStatus;
  expires: number;
  revision: number;
};
const minute = () => 60000 + Math.random() * 5000;
/** Volatile session-owned evidence. No event retention or outbox. */
export function createPresence(
  transport: ReadTransport | null,
  activity: PresenceActivity | undefined,
  publish: NonNullable<LiveSubscription["publishPresence"]>,
  notify: (listener: () => void) => void,
) {
  const subjects = new Map<string, Subject>();
  const profiles = new Map<string, Subject>();
  let selected = new Map<string, Subject>();
  /** Told when demand moves subjects within or past the limit. */
  const selectionListeners = new Set<() => void>();
  let connected = false,
    closed = false,
    reading = false;
  let nextRead = Infinity,
    readGate = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let publisher: AbortController | undefined;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let stopPublisher: (() => void) | undefined;
  let lastStatus = activity?.status();
  let lastCommand = activity?.command?.();
  let stopObservation: (() => void) | undefined;
  let observedKeys = "";
  function observe() {
    const keys = eligible() ? [...selected.keys()].sort() : [];
    const identity = keys.join(",");
    if (identity === observedKeys) return;
    observedKeys = identity;
    const stopPrevious = stopObservation;
    stopObservation = keys.length
      ? transport?.observePresence?.(keys, (event) => {
          if (!eligible() || event.kind !== 20001) return;
          const subject = selected.get(event.pubkey);
          if (!subject) return;
          let status: unknown = event.content;
          if (event.content.startsWith("{")) {
            try {
              status = JSON.parse(event.content).status;
            } catch {
              status = undefined;
            }
          }
          subject.revision++;
          subject.expires = Date.now() + 75000;
          change(
            subject,
            status === "online" || status === "away" || status === "offline"
              ? status
              : "unknown",
          );
          schedule();
        })
      : undefined;
    stopPrevious?.();
  }
  const change = (subject: Subject, status: PresenceStatus) => {
    if (subject.status === status) return;
    subject.status = status;
    for (const listener of subject.listeners.keys()) notify(listener);
  };
  const eligible = () =>
    !closed &&
    connected &&
    !!transport?.presenceSnapshot &&
    !!activity?.visible();
  function schedule() {
    clearTimeout(timer);
    if (!eligible() || !selected.size) return;
    let wake = reading ? Infinity : nextRead;
    for (const subject of selected.values())
      if (subject.status !== "unknown") wake = Math.min(wake, subject.expires);
    if (Number.isFinite(wake))
      timer = setTimeout(tick, Math.max(0, wake - Date.now()));
  }
  function demand() {
    const previous = selected;
    selected = new Map();
    const self = transport && subjects.get(transport.viewer);
    if (self && transport) selected.set(transport.viewer, self);
    // Stop each source at the cap. Overflow and duplicate rows must not turn
    // mounting a thread into a full-directory scan per subscription.
    for (const source of [profiles, previous, subjects]) {
      for (const [key, subject] of source) {
        if (selected.size === 256) break;
        if (subjects.get(key) === subject) selected.set(key, subject);
      }
    }
    let evicted = false,
      admitted = false;
    for (const [key, subject] of previous)
      if (!selected.has(key)) {
        evicted = true;
        change(subject, "unknown");
        for (const listener of subject.listeners.keys()) notify(listener);
      }
    for (const [key, subject] of selected)
      if (previous.get(key) !== subject) {
        admitted = true;
        for (const listener of subject.listeners.keys()) notify(listener);
      }
    if (admitted) {
      const initial = Math.max(Date.now() + 100, readGate);
      nextRead = previous.size ? Math.min(nextRead, initial) : initial;
    }
    if (!selected.size) {
      nextRead = Infinity;
      controller?.abort();
    }
    schedule();
    if (admitted || evicted)
      for (const listener of selectionListeners) listener();
  }
  let selectionQueued = false;
  function queueDemand() {
    if (selectionQueued || closed) return;
    selectionQueued = true;
    queueMicrotask(() => {
      selectionQueued = false;
      if (!closed) demand();
    });
  }
  async function tick() {
    const now = Date.now();
    for (const subject of selected.values())
      if (subject.expires <= now) change(subject, "unknown");
    if (
      !eligible() ||
      !transport?.presenceSnapshot ||
      reading ||
      now < nextRead ||
      !selected.size
    ) {
      schedule();
      return;
    }
    observe();
    const captured = new Map(selected);
    const revisions = new Map(
      [...captured].map(([key, subject]) => [key, subject.revision]),
    );
    const owned = new AbortController();
    controller = owned;
    reading = true;
    readGate = now + 5000;
    nextRead = Infinity;
    schedule();
    try {
      const values = await transport.presenceSnapshot(
        [...captured.keys()],
        owned.signal,
      );
      if (closed || owned.signal.aborted || controller !== owned) return;
      if (values === null)
        readGate = nextRead = Math.max(
          readGate,
          Date.now() + 5000 + Math.random() * 1000,
        );
      else {
        for (const [key, subject] of captured)
          if (
            subjects.get(key) === subject &&
            selected.get(key) === subject &&
            revisions.get(key) === subject.revision
          ) {
            subject.expires = now + 75000;
            change(
              subject,
              Date.now() < subject.expires
                ? (values.get(key) ?? "unknown")
                : "unknown",
            );
          }
        nextRead = Math.min(nextRead, Date.now() + minute());
      }
    } catch (error) {
      if (closed || owned.signal.aborted || controller !== owned) return;
      for (const [key, subject] of captured)
        if (revisions.get(key) === subject.revision) change(subject, "unknown");
      const retry =
        error &&
        typeof error === "object" &&
        "retryAfterMs" in error &&
        typeof error.retryAfterMs === "number"
          ? error.retryAfterMs
          : 0;
      readGate = nextRead = Date.now() + Math.max(minute(), retry);
    } finally {
      // The broker starts its gate after transit. Measure from settlement so
      // shorter transit on the next read cannot spend a second busy interval.
      readGate = Math.max(readGate, Date.now() + 5000);
      nextRead = Math.max(nextRead, readGate);
      reading = false;
      if (controller === owned) controller = undefined;
      schedule();
    }
  }
  function clear(publication = true) {
    stopObservation?.();
    stopObservation = undefined;
    observedKeys = "";
    controller?.abort();
    controller = undefined;
    nextRead = Math.max(Date.now() + 100, readGate);
    if (publication) {
      stopPublishing();
      startPublishing();
    }
    for (const subject of subjects.values()) change(subject, "unknown");
    schedule();
  }
  function stopPublishing() {
    publisher?.abort();
    publisher = undefined;
    clearTimeout(renewal);
    stopPublisher?.();
    stopPublisher = undefined;
  }
  function startPublishing(immediate = false) {
    if (
      publisher ||
      !connected ||
      !transport?.presenceSnapshot ||
      !activity ||
      closed ||
      typeof navigator === "undefined" ||
      !navigator.locks
    )
      return;
    const owned = new AbortController();
    publisher = owned;
    const valid = () =>
      !closed && connected && publisher === owned && !owned.signal.aborted;
    void navigator.locks
      .request(
        `buzz-presence:${transportPartition(transport)}`,
        { signal: owned.signal },
        async () => {
          if (!valid()) return;
          await new Promise<void>((resolve) => {
            stopPublisher = resolve;
            const renew = async () => {
              if (!valid()) return;
              let delay = minute();
              try {
                const status = activity.status();
                const before = subjects.get(transport.viewer)?.revision;
                const accepted = await publish(status, owned.signal);
                if (!valid()) return;
                if (accepted === true) {
                  const subject = subjects.get(transport.viewer);
                  if (
                    subject &&
                    subject.revision === before &&
                    eligible() &&
                    selected.has(transport.viewer)
                  ) {
                    subject.revision++;
                    subject.expires = Date.now() + 75000;
                    change(subject, status);
                    schedule();
                  }
                }
                // Offline is a clear, not a lease. Keep the lock, but stop
                // renewing once accepted; failed/unsent clears still retry.
                if (accepted === true && status === "offline") return;
                if (accepted === null) delay = 5000 + Math.random() * 1000;
                else if (typeof accepted === "object")
                  delay = accepted.retryAfterMs + 50;
              } catch {
                /* Lossy; next renewal owns current state. */
              }
              if (valid()) renewal = setTimeout(() => void renew(), delay);
            };
            renewal = setTimeout(
              () => void renew(),
              immediate ? 0 : 250 + Math.random() * 750,
            );
          });
        },
      )
      .catch(() => {})
      .finally(() => {
        if (publisher === owned) publisher = undefined;
      });
  }
  /** Read soon without discarding current evidence; the start gate still applies. */
  function refresh() {
    nextRead = Math.min(nextRead, Math.max(Date.now() + 100, readGate));
    schedule();
  }
  const stopActivity = activity?.subscribe(() => {
    if (!activity.visible()) clear(false);
    else refresh();
    if (
      lastStatus !== activity.status() ||
      lastCommand !== activity.command?.()
    ) {
      lastStatus = activity.status();
      lastCommand = activity.command?.();
      // Replace desired state, not an event backlog. Restarting the lock cancels late signing.
      stopPublishing();
      startPublishing(true);
    }
  });
  return {
    status(key: string): PresenceStatus {
      return subjects.get(key)?.status ?? "unknown";
    },
    limited: (key: string) => subjects.has(key) && !selected.has(key),
    /** Notifies when demand moves subjects within or past the limit, so a
     * presence layered on this one can keep to the same window. */
    subscribeSelection(listener: () => void) {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
    subscribe(key: string, listener: () => void, profile = false) {
      if (closed || !/^[0-9a-f]{64}$/.test(key)) return () => {};
      let subject = subjects.get(key);
      if (!subject) {
        subject = {
          listeners: new Map(),
          profiles: 0,
          status: "unknown",
          expires: 0,
          revision: 0,
        };
        subjects.set(key, subject);
      }
      const priority = subject.profiles > 0;
      if (subject.listeners.get(listener)) subject.profiles--;
      if (profile) subject.profiles++;
      subject.listeners.set(listener, profile);
      if (subject.profiles) profiles.set(key, subject);
      else profiles.delete(key);
      if (
        (!selected.has(key) &&
          (selected.size < 256 || key === transport?.viewer)) ||
        priority !== subject.profiles > 0
      )
        demand();
      return () => {
        if (subjects.get(key) !== subject || !subject.listeners.has(listener))
          return;
        const priority = subject.profiles > 0;
        if (subject.listeners.get(listener)) subject.profiles--;
        subject.listeners.delete(listener);
        if (!subject.profiles) profiles.delete(key);
        if (!subject.listeners.size) {
          subjects.delete(key);
          selected.delete(key);
        }
        if (!subjects.size) {
          nextRead = Infinity;
          controller?.abort();
          clearTimeout(timer);
          observe();
        } else if (selected.size < 256 || priority !== subject.profiles > 0)
          queueDemand();
      };
    },
    connected(value: boolean) {
      if (connected === value || closed) return;
      connected = value;
      clear();
    },
    clear,
    refresh,
    dispose() {
      closed = true;
      stopActivity?.();
      stopObservation?.();
      stopPublishing();
      clearTimeout(timer);
      controller?.abort();
      subjects.clear();
      profiles.clear();
      selected.clear();
      selectionListeners.clear();
    },
  };
}
export type Presence = ReturnType<typeof createPresence>;
