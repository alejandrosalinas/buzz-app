import { isWorkflowOperation } from "../workflows/protocol";
import { yieldToHost } from "./yield";
import { getEventHash, type EventTemplate } from "nostr-tools";
import { eventDto, type EventData, type RelayEvent } from "./events";
import type { RelayWriter } from "./transport";
import { ByteLru, byteSize, OUTBOX_INPUT_MAX_BYTES } from "./budget";
import { createRelayProfiler, type RelayProfiler } from "./profiling";
import { channelRowKind } from "./membership";
import { MessageClock } from "./message-order";
import {
  bytes,
  isCatalogKind,
  MAX_CONTENT_BYTES,
  MAX_EVENT_BYTES,
} from "../agents/catalog-envelope";
import {
  CANVAS_MAX_EVENT_BYTES,
  LIVE_CANVAS_BYTES,
} from "../channel-templates/canvas-limits.ts";

export type Delivery = "sending" | "accepted" | "unknown" | "failed" | "seen";
/** Durable, caller-owned recovery state committed with the operation. */
export type OutboxRecovery = Readonly<{ key: string; value: string }>;
function recoveryValue(value: OutboxRecovery | undefined) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value.key !== "string" ||
    !value.key.length ||
    value.key.length > 200 ||
    typeof value.value !== "string" ||
    byteSize(value) > 64 * 1024
  )
    throw new Error("Invalid outbox recovery state");
  return Object.freeze({ key: value.key, value: value.value });
}
export type OutgoingEvent = Readonly<{
  event: EventData;
  signed?: RelayEvent;
  recovery?: OutboxRecovery | undefined;
  /** Caller verified the operation’s domain outcome, not merely delivery. */
  acknowledged?: true;
  /** A caller-scoped admission requires renewed live eligibility for retry. */
  guarded?: boolean;
  delivery: Delivery;
  error?: string | undefined;
  /** The relay refused the last attempt, rather than it failing on this
   * device, being asked to wait, or going unanswered. */
  refused?: true | undefined;
}>;
type OutboxInput = Pick<EventTemplate, "kind" | "content" | "tags"> & {
  /** NIP-AP: created_at of the newest observed head this event replaces. */
  supersedes?: number;
};
type Replacement = {
  input(): OutboxInput | undefined;
  queued(id: string): void;
};
export interface Outbox {
  /** Outstanding operations only. Confirmed events live in the session's retained data. */
  snapshot(): readonly OutgoingEvent[];
  subscribe(listener: () => void): () => void;
  /** Capture fresh send intent synchronously; returned work runs once after
   * receipt/verified echo, never history hydration. It cannot affect delivery. */
  observeSend(listener: SendObserver): () => void;
  supports(kind: number): boolean;
  ready(): Promise<void>;
  /** Fresh shared-journal ownership without importing another window's operations. */
  recovery(key: string): Promise<OutgoingEvent | undefined>;
  send(
    input: OutboxInput,
    recovery?: OutboxRecovery,
    active?: () => boolean,
  ): string;
  /** Establish durable recovery, then synchronously consume its source while
   * holding the receipt's shared dismissal lock. */
  recover(
    id: string,
    recovery: OutboxRecovery,
    consume?: () => void,
  ): Promise<void>;
  /** An expired no-role invitation may be resolved by fresh command/roster readback. */
  acknowledge(
    id: string,
    verifyRetirement?: (event: EventData) => Promise<"recorded" | undefined>,
    replacement?: Replacement,
  ): Promise<void>;
  retry(id: string, active?: () => boolean): void;
  /** owner: the recovery its caller owns and releases with an unconfirmed send. */
  dismiss(id: string, owner?: OutboxRecovery): Promise<void>;
  /** Durable explicit dismissal, with delivery evidence at removal. */
  observeDismiss(listener: (item: OutgoingEvent) => void): () => void;
}
type SendObserver = (
  event: EventData,
  signal: AbortSignal,
) => ((pending: readonly EventData[]) => void) | undefined;
export type LocalEvents = Pick<Outbox, "snapshot" | "subscribe">;
export interface OutboxStorage {
  /** Serialize receipt adoption and dismissal across windows. */
  lock?<T>(id: string, run: () => Promise<T>): Promise<T>;
  /** Relinquish incremental write ownership after observing external removal. */
  forget?(id: string): void;
  close?(): void;
  load(options?: {
    readOnly?: boolean;
  }): readonly OutgoingEvent[] | Promise<readonly OutgoingEvent[]>;
  save(
    operations: readonly OutgoingEvent[],
    options?: { force?: string },
  ): void | Promise<void>;
}
export class PublishRejected extends Error {
  /** The relay's own refusal text, when it sent one; `message` stays the
   * display summary. Bounded by the transport that read it. */
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** Proven not delivered, but not refused: the request never left this
 * device, or the relay asked it to wait. Retrying may succeed. */
export class PublishNotSent extends PublishRejected {}

export { browserOutboxStorage } from "./outbox-storage";
const abortError = () => new DOMException("Relay session closed", "AbortError");
const MAX_PENDING = 256;
const MAX_CONFIRMED = 2048;
/** Unresolved Canvas saves have their own allowance, so a few large canvases
 * never use up the room that ordinary messages need. */
const PENDING_MESSAGE_BYTES = 2 * 1024 * 1024;
const PENDING_CANVAS_BYTES = 4 * 1024 * 1024;
const CONFIRMED_BYTES = 8 * 1024 * 1024;
/** Stored delivery diagnostics are clipped to this many characters. */
const ERROR_CHARS = 256;
/** Everything a pending record can gain after admission besides its signed
 * copy: two signatures, `signed`, delivery state and flags, and an error of
 * at most `ERROR_CHARS` characters, each escaped to at most 6 bytes. */
const LIFECYCLE_BYTES = 512 + 6 * ERROR_CHARS;
const clip = (error: string) => error.slice(0, ERROR_CHARS);
const unsigned = ({ sig: _, ...event }: EventData & { sig?: string }) => event;
/** Any journal save accepts: the `[…]` list, confirmed records with their
 * commas, and both pending allowances, whose records never outgrow their
 * charges and which already count their own `[]` and commas. */
const SAVED_BYTES =
  2 +
  CONFIRMED_BYTES +
  MAX_CONFIRMED +
  PENDING_MESSAGE_BYTES +
  PENDING_CANVAS_BYTES;

/** One journal owns pending delivery and bounded confirmed retention. Views receive one change stream. */
export function createOutbox(
  viewer: string,
  writer: RelayWriter,
  storage: OutboxStorage,
  {
    timeoutMs = 10_000,
    onAccepted = (_event: RelayEvent, _acknowledged: boolean) => {},
    profiling = createRelayProfiler(),
    notifyListener = (listener: () => void) => listener(),
    preparePublish,
    holdPublish,
    needsReceipt = () => false,
    onReceipt = (_event: EventData, _message: string | undefined) => {},
    clock = new MessageClock(),
  }: {
    /** The session's send clock, shared with its rendered views. */
    clock?: MessageClock;
    timeoutMs?: number;
    /** Commands await their receipt even after a verified echo. Never persisted. */
    needsReceipt?: (event: EventData) => boolean;
    onReceipt?: (event: EventData, message: string | undefined) => void;
    /** `acknowledged` is false when the publisher was entered but delivery is `unknown`. */
    onAccepted?: (event: RelayEvent, acknowledged: boolean) => void;
    profiling?: RelayProfiler;
    notifyListener?: (listener: () => void) => void;
    /** Read-only pre-dispatch work under the attempt deadline. The returned
     * synchronous check runs with no await between it and publisher entry. */
    preparePublish?: (
      event: RelayEvent,
      signal: AbortSignal,
    ) => Promise<(() => void) | undefined>;
    /** Work a signed event waits for before it publishes, such as its
     * channel's creation. A held event takes no delivery slot, and its
     * deadline starts when the hold ends; a rejected hold fails it. */
    holdPublish?: (event: RelayEvent) => Promise<void> | undefined;
  } = {},
) {
  const awaitsReceipt = needsReceipt;
  // Transient policy for a caller-scoped invitation. Restored writes never auto-replay.
  const admissionGates = new Map<string, () => boolean>();
  const checkAdmission = (id: string) => {
    if (find(id)?.guarded && admissionGates.get(id)?.() !== true)
      throw new DOMException("Channel addition cancelled", "AbortError");
  };
  let snapshot: readonly OutgoingEvent[] = Object.freeze([]);
  // Hydrated receipts are observations, not delivery owned by this window.
  const restoredReceipts = new Set<string>();
  let visible: readonly OutgoingEvent[] = snapshot;
  let finalSnapshot: readonly OutgoingEvent[] | undefined;
  let finalVisible: readonly OutgoingEvent[] | undefined;
  const completed = new ByteLru<OutgoingEvent>(MAX_CONFIRMED, CONFIRMED_BYTES);
  const sizes = new WeakMap<OutgoingEvent, number>();
  /** Pending charges, split by allowance. A record is charged its largest
   * size over its delivery lifecycle, so it never outgrows its admission. */
  const pendingSize = (items: readonly OutgoingEvent[]) => {
    const total = { messages: 2, canvases: 2 };
    for (const item of items) {
      let size = sizes.get(item);
      if (size === undefined) {
        size =
          2 * byteSize(unsigned(item.event)) +
          (item.recovery ? byteSize(item.recovery) + 16 : 0) +
          LIFECYCLE_BYTES;
        sizes.set(item, size);
      }
      total[item.event.kind === 40100 ? "canvases" : "messages"] += size + 1;
    }
    return total;
  };
  /** Refuse what an allowance cannot hold, before it joins the outbox. */
  const admit = (items: readonly OutgoingEvent[], kind: number) => {
    const charged = pendingSize(items);
    if (
      kind === 40100
        ? charged.canvases > PENDING_CANVAS_BYTES
        : charged.messages > PENDING_MESSAGE_BYTES
    )
      throw new Error("Outbox storage is full");
  };
  const listeners = new Set<() => void>();
  const localListeners = new Set<() => void>();
  const dismissListeners = new Set<(item: OutgoingEvent) => void>();
  /** One record per queued or active delivery. Its deadline starts at enqueue; a
   * controller exists only while the attempt is signing or publishing. */
  type Attempt = {
    expiresAt: number;
    /** A failed retry cannot disprove an earlier dispatched/accepted attempt. */
    previousDelivery: Delivery;
    timer: ReturnType<typeof setTimeout>;
    intent?: Promise<void>;
    controller?: AbortController;
    /** Waiting on `holdPublish`, or for a slot after it, without using one. */
    held?: true;
  };
  const attempts = new Map<string, Attempt>();
  const dismissing = new Map<string, Promise<void>>();
  const lifetime = new AbortController();
  const sendListeners = new Set<SendObserver>();
  const deliveryWork = new Map<
    string,
    {
      event: EventData;
      work: ((pending: readonly EventData[]) => void)[];
    }
  >();
  const captureSend = (event: EventData) => {
    const work: ((pending: readonly EventData[]) => void)[] = [];
    for (const listener of sendListeners) {
      try {
        const run = listener(event, lifetime.signal);
        if (run) work.push(run);
      } catch {
        /* Independent observer. */
      }
    }
    if (work.length) deliveryWork.set(event.id, { event, work });
  };
  const delivered = (event: RelayEvent) => {
    const work = deliveryWork.get(event.id)?.work;
    const pending = [...deliveryWork.values()].map((item) => item.event);
    deliveryWork.delete(event.id);
    for (const run of work ?? []) {
      // Execution/UI observers must never change message delivery evidence.
      try {
        run(pending);
      } catch {
        /* Observer owns its error presentation. */
      }
    }
  };
  const inflight = () =>
    [...attempts.values()].filter(
      (attempt) => attempt.controller && !attempt.held,
    ).length;
  /** Attempts whose hold ended, waiting for a free slot. */
  const slotWaiters = new Set<() => void>();
  function nextSlot() {
    return new Promise<void>((resolve) => slotWaiters.add(resolve));
  }
  /** Offers free slots to released holds before queued deliveries; each
   * released hold pumps again when it ends. */
  function pumpDeliveries() {
    if (closed) return;
    if (slotWaiters.size) {
      for (const resolve of [...slotWaiters]) {
        slotWaiters.delete(resolve);
        resolve();
      }
      return;
    }
    for (const queued of snapshot)
      if (queued.delivery === "sending") void deliver(queued.event.id);
  }
  let closed = false;
  let confirmedInvalidated = false;
  let confirmedKeep: ((event: EventData) => boolean) | undefined;
  let storageError: string | undefined;
  let hydrated = false;
  let durable = Promise.resolve();
  const notify = () => {
    visible = Object.freeze([
      ...completed.entries().map(([, item]) => item),
      ...snapshot,
    ]);
    for (const listener of localListeners) notifyListener(listener);
    for (const listener of listeners) notifyListener(listener);
  };
  const persist = (
    id: string,
    action?: "acknowledge" | "dismiss" | "recover",
    addition?: OutgoingEvent,
  ) => {
    const queued = profiling.start("outbox.queue", id);
    const work = durable
      .catch(() => {})
      .then(() => ready)
      .then(() => {
        if (storageError) {
          queued("error");
          throw new Error(storageError);
        }
        queued();
        // Hydration may have added restored intent while this commit waited.
        // Commit current state so no intermediate transaction erases that intent.
        const records = [
          ...(action === "dismiss"
            ? visible.filter((item) => item.event.id !== id)
            : action === "acknowledge"
              ? visible.map((item) =>
                  item.event.id === id
                    ? {
                        ...item,
                        recovery: undefined,
                        acknowledged: true as const,
                      }
                    : item,
                )
              : visible),
          ...(addition ? [addition] : []),
        ];
        return profiling.measureAsync("outbox.persist", id, async () => {
          if (action === "recover") await storage.save(records, { force: id });
          else await storage.save(records);
          // The replacement joins visible intent only with durable retirement.
          // Other queued saves must never observe two unresolved recovery keys.
          if (addition) snapshot = Object.freeze([...snapshot, addition]);
          if (action === "dismiss") {
            // Commit removal inside the serialized write, before a later save
            // can capture state. Failed storage never exposes a temporary absence.
            const dismissed = snapshot.find((item) => item.event.id === id);
            deliveryWork.delete(id);
            completed.delete(id);
            snapshot = Object.freeze(
              snapshot.filter((item) => item.event.id !== id),
            );
            notify();
            if (dismissed)
              for (const listener of dismissListeners)
                notifyListener(() => listener(dismissed));
          }
          // Release recovery only after its removal is durable, before the next
          // queued save can run. Preserve delivery evidence received during I/O.
          if (action === "acknowledge") {
            const current = visible.find((item) => item.event.id === id);
            if (current) {
              const cleared = {
                ...current,
                recovery: undefined,
                acknowledged: true as const,
              };
              if (
                (current.delivery === "seen" || current.event.kind === 9000) &&
                !attempts.has(id)
              ) {
                completed.set(id, cleared);
                snapshot = Object.freeze(
                  snapshot.filter((item) => item.event.id !== id),
                );
                notify();
              } else replace(cleared);
            }
          }
        });
      });
    durable = work;
    return work;
  };
  const find = (id: string) => snapshot.find((item) => item.event.id === id);
  function replace(item: OutgoingEvent) {
    snapshot = Object.freeze(
      snapshot.map((old) =>
        old.event.id === item.event.id ? Object.freeze(item) : old,
      ),
    );
    notify();
  }
  function saveStatus(item: OutgoingEvent) {
    replace(item);
    void persist(item.event.id).catch(() => {
      /* Durable intent restores as unknown. */
    });
  }
  function validateSaved(loaded: readonly OutgoingEvent[]) {
    if (
      !Array.isArray(loaded) ||
      loaded.length > MAX_PENDING + MAX_CONFIRMED ||
      byteSize(loaded) > SAVED_BYTES
    )
      throw new Error("Saved outbox exceeds its budget");
  }
  function decode(item: OutgoingEvent): OutgoingEvent {
    const signed = item.signed
      ? eventDto(JSON.parse(JSON.stringify(item.signed)))
      : undefined;
    // Trust the verified copy, in the stored row's own shape, so restoring
    // never changes a row's size.
    const event = signed
      ? item.event && "sig" in item.event
        ? signed
        : unsigned(signed)
      : item.event;
    if (!event || event.pubkey !== viewer || getEventHash(event) !== event.id)
      throw new Error("Saved outbox event is invalid");
    return Object.freeze({
      event: Object.freeze({
        ...event,
        tags: Object.freeze(
          event.tags.map((tag: string[]) => Object.freeze([...tag])),
        ) as unknown as string[][],
      }),
      ...(signed ? { signed } : {}),
      ...(item.recovery ? { recovery: recoveryValue(item.recovery) } : {}),
      ...(item.acknowledged === true ? { acknowledged: true as const } : {}),
      ...(item.guarded ? { guarded: true } : {}),
      delivery:
        item.delivery === "seen" && signed
          ? "seen"
          : item.delivery === "failed"
            ? "failed"
            : "unknown",
      ...(item.error ? { error: clip(item.error) } : {}),
    });
  }
  function restore(restored: readonly OutgoingEvent[]) {
    const pending = restored.filter(
      (item) =>
        (!(item.event.kind === 9000 && item.acknowledged) &&
          item.delivery !== "seen") ||
        !!item.recovery,
    );
    if (pending.length > MAX_PENDING)
      throw new Error("Saved pending outbox exceeds its budget");
    for (const item of restored)
      if (
        ((item.event.kind === 9000 && item.acknowledged) ||
          item.delivery === "seen") &&
        !item.recovery &&
        (!confirmedInvalidated ||
          (item.event.kind === 9007 && confirmedKeep?.(item.event)))
      )
        completed.set(item.event.id, item);
    for (const item of pending) restoredReceipts.add(item.event.id);
    snapshot = Object.freeze([...pending, ...snapshot]);
    notify();
  }
  const loadedTiming = profiling.start("outbox.load", "journal");
  let ready: Promise<void>;
  try {
    const loaded = storage.load();
    if (loaded instanceof Promise)
      ready = loaded.then(async (records) => {
        validateSaved(records);
        const decoded: OutgoingEvent[] = [];
        for (let offset = 0; offset < records.length; offset += 12) {
          decoded.push(...records.slice(offset, offset + 12).map(decode));
          if (offset + 12 < records.length) await yieldToHost();
        }
        restore(decoded);
      });
    else {
      validateSaved(loaded);
      restore(loaded.map(decode));
      ready = Promise.resolve();
    }
  } catch (error) {
    ready = Promise.reject(error);
  }
  ready = ready.then(
    () => {
      hydrated = true;
      loadedTiming();
    },
    (error) => {
      loadedTiming("error");
      storageError = `Could not load the outbox: ${String(error)}`;
    },
  );

  function expire(id: string) {
    const attempt = attempts.get(id);
    if (!attempt) return;
    const error = new Error("Delivery timed out; check or retry this message");
    if (attempt.controller) attempt.controller.abort(error);
    else {
      clearTimeout(attempt.timer);
      attempts.delete(id);
      const item = find(id);
      if (!closed && item) {
        if (awaitsReceipt(item.event)) onReceipt(item.event, undefined);
        saveStatus({
          ...item,
          delivery: failedDelivery(attempt),
          error: error.message,
        });
      }
    }
  }
  function failedDelivery(attempt: Attempt): Delivery {
    return attempt.previousDelivery === "unknown" ||
      attempt.previousDelivery === "accepted" ||
      attempt.previousDelivery === "seen"
      ? attempt.previousDelivery
      : "failed";
  }
  function schedule(
    id: string,
    intent?: Promise<void>,
    previousDelivery: Delivery = "failed",
  ) {
    if (closed || attempts.has(id)) return;
    attempts.set(id, {
      expiresAt: Date.now() + timeoutMs,
      previousDelivery,
      timer: setTimeout(() => expire(id), timeoutMs),
      ...(intent ? { intent } : {}),
    });
    void deliver(id);
  }
  async function deliver(id: string) {
    const attempt = attempts.get(id);
    if (closed || !attempt || attempt.controller || inflight() >= 3) return;
    if (!find(id)) return;
    if (Date.now() >= attempt.expiresAt) {
      expire(id);
      return;
    }
    const controller = new AbortController();
    attempt.controller = controller;
    const signal = controller.signal;
    let publishing = false;
    const total = profiling.start("send.delivery", id);
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? abortError()),
        { once: true },
      ),
    );
    try {
      await Promise.race([
        attempt.intent ??
          ready.then(() => {
            if (storageError) throw new Error(storageError);
            return persist(id);
          }),
        aborted,
      ]);
      if (storageError) throw new Error(storageError);
      const initial = find(id);
      if (!initial || closed || signal.aborted) return;
      checkAdmission(id);
      const signedResult =
        initial.signed ??
        (await profiling.measureAsync("send.sign", id, () =>
          Promise.race([writer.sign(initial.event, signal), aborted]),
        ));
      const signed = profiling.measure("send.verify", id, () =>
        eventDto(signedResult),
      );
      if (closed || signal.aborted) throw abortError();
      if (signed.id !== id || signed.pubkey !== viewer)
        throw new Error("Signer changed the outgoing event");
      const current = find(id);
      if (!current) return; // A verified echo already completed delivery.
      replace({ ...current, signed });
      await Promise.race([persist(id), aborted]);
      if (closed || signal.aborted || !find(id)) return;
      const hold = holdPublish?.(signed);
      if (hold) {
        attempt.held = true;
        clearTimeout(attempt.timer);
        pumpDeliveries();
        await Promise.race([hold, aborted]);
        attempt.expiresAt = Date.now() + timeoutMs;
        attempt.timer = setTimeout(() => expire(id), timeoutMs);
        while (inflight() >= 3) await Promise.race([nextSlot(), aborted]);
        delete attempt.held;
        if (closed || signal.aborted || !find(id)) return;
      }
      const check = preparePublish
        ? await profiling.measureAsync("send.prepare", id, () =>
            Promise.race([preparePublish(signed, signal), aborted]),
          )
        : undefined;
      // Preparation cannot make delivery uncertain. Only entering the actual
      // transport publisher crosses that boundary, including for signed retries.
      if (closed || !find(id)) return;
      signal.throwIfAborted();
      const receipt = await profiling.measureAsync("send.publish", id, () => {
        check?.();
        checkAdmission(id);
        publishing = true;
        return Promise.race([writer.publish(signed, signal), aborted]);
      });
      if (closed || signal.aborted) return;
      if (awaitsReceipt(signed))
        onReceipt(signed, typeof receipt === "string" ? receipt : undefined);
      const latest = find(id);
      if (latest)
        saveStatus({
          ...latest,
          delivery:
            latest.delivery === "seen" || attempt.previousDelivery === "seen"
              ? "seen"
              : "accepted",
          error: undefined,
        });
      delivered(signed);
      onAccepted(signed, true);
    } catch (error) {
      const latest = find(id);
      // A verified observation ends the attempt even if its HTTP ACK never arrives.
      total(!closed && !latest ? "ok" : "error");
      if (closed) return;
      if (latest && awaitsReceipt(latest.event))
        onReceipt(latest.signed ?? latest.event, undefined);
      const delivery: Delivery | undefined =
        latest &&
        (latest.delivery === "seen" || attempt.previousDelivery === "seen"
          ? "seen"
          : attempt.previousDelivery === "accepted"
            ? "accepted"
            : publishing && !(error instanceof PublishRejected)
              ? "unknown"
              : failedDelivery(attempt));
      if (latest && delivery)
        saveStatus({
          ...latest,
          delivery,
          refused:
            delivery === "failed" &&
            error instanceof PublishRejected &&
            !(error instanceof PublishNotSent)
              ? true
              : undefined,
          error: clip(
            awaitsReceipt(latest.event)
              ? publishing && !(error instanceof PublishRejected)
                ? "Workflow delivery could not be confirmed; inspect recent activity before submitting another command."
                : "Workflow command rejected; retain the draft and refresh the saved configuration."
              : `${
                  attempt.previousDelivery === "unknown" ||
                  attempt.previousDelivery === "accepted"
                    ? error instanceof PublishRejected
                      ? "Retry blocked: "
                      : "Retry failed: "
                    : ""
                }${error instanceof Error ? error.message : String(error)}`,
          ),
        });
      if (publishing && latest?.signed && !(error instanceof PublishRejected))
        onAccepted(latest.signed, delivery !== "unknown");
    } finally {
      // Keep a failed invitation fenced for an explicit retry in this session.
      if (
        !find(id) ||
        find(id)?.delivery === "accepted" ||
        find(id)?.delivery === "seen"
      ) {
        admissionGates.delete(id);
      }
      total();
      clearTimeout(attempt.timer);
      if (attempts.get(id) === attempt) attempts.delete(id);
      const observed = find(id);
      if (
        !closed &&
        observed &&
        ((observed.event.kind === 9000 && observed.acknowledged) ||
          observed.delivery === "seen") &&
        !observed.recovery
      ) {
        completed.set(id, observed);
        snapshot = Object.freeze(
          snapshot.filter((item) => item.event.id !== id),
        );
        notify();
        void persist(id).catch(() => {});
      }
      pumpDeliveries();
    }
  }
  const subscribe = (set: Set<() => void>, listener: () => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  /** Persist replacement intent and retire its verified predecessor in one save. */
  function enqueue(
    { supersedes, ...input }: OutboxInput,
    recovery?: OutboxRecovery,
    active?: () => boolean,
    replacing?: string,
  ) {
    if (active && !active())
      throw new DOMException("Channel addition cancelled", "AbortError");
    if (closed) throw abortError();
    if (storageError) throw new Error(storageError);
    const savedRecovery = recoveryValue(recovery);
    if (
      savedRecovery &&
      (!hydrated ||
        snapshot.some(
          (item) =>
            item.event.id !== replacing &&
            item.recovery?.key === savedRecovery.key,
        ))
    )
      throw new Error("Recover the earlier message before sending another");
    if (
      !Number.isInteger(input.kind) ||
      input.kind < 0 ||
      input.kind > 65535 ||
      !outbox.supports(input.kind)
    )
      throw new Error("This relay connection cannot publish that event kind");
    const catalog = isCatalogKind(input.kind);
    if (
      (input.kind === 9 && !input.content.trim()) ||
      // NIP-AP admits larger public definitions than ordinary input.
      (catalog
        ? bytes(input.content) > MAX_CONTENT_BYTES ||
          byteSize(input) > MAX_EVENT_BYTES
        : // A live Canvas carries up to its own content limit.
          input.kind === 40100
          ? bytes(input.content) > LIVE_CANVAS_BYTES ||
            byteSize(input) > CANVAS_MAX_EVENT_BYTES
          : byteSize(input) > OUTBOX_INPUT_MAX_BYTES)
    )
      throw new Error("Message is empty or too large");
    if (snapshot.length >= MAX_PENDING)
      throw new Error(
        "Too many outstanding operations; resolve or dismiss a pending operation",
      );
    // Rendered messages carry send order within their second; the optimistic
    // row and the signed event share this exact ms and created_at.
    const channelId = channelRowKind(input.kind)
      ? input.tags.find(([name]) => name === "h")?.[1]
      : undefined;
    const ms = channelId ? clock.next(channelId) : Date.now();
    let createdAt = Math.floor(ms / 1000);
    if (input.kind === 40003) {
      if (!hydrated)
        throw new Error("Message history is still loading. Try again.");
      const target = input.tags.find(([name]) => name === "e")?.[1];
      const channel = input.tags.find(([name]) => name === "h")?.[1];
      // Edits use second precision on every client. Preserve retained local
      // submission order without changing the protocol's event-ID tie-break.
      for (const { event } of visible) {
        if (
          target &&
          channel &&
          event.kind === 40003 &&
          event.pubkey === viewer &&
          event.tags.some(([name, id]) => name === "e" && id === target) &&
          event.tags.some(([name, id]) => name === "h" && id === channel)
        )
          createdAt = Math.max(createdAt, event.created_at + 1);
      }
      // Stay well inside the signer's 15-minute clock-skew allowance.
      if (createdAt > Math.floor(ms / 1000) + 60)
        throw new Error(
          "Edits are arriving too quickly or your clock changed. Wait a moment and try again.",
        );
    }
    if (catalog) {
      // NIP-AP: max(now, head + 1) over the observed relay head and this
      // device's retained writes, so a replacement can never lose or tie.
      if (supersedes !== undefined)
        createdAt = Math.max(createdAt, supersedes + 1);
      const d = input.tags.find(([name]) => name === "d")?.[1];
      for (const { event } of visible)
        if (
          event.kind === input.kind &&
          event.pubkey === viewer &&
          event.tags.some(([name, value]) => name === "d" && value === d)
        )
          createdAt = Math.max(createdAt, event.created_at + 1);
      if (createdAt > Math.floor(ms / 1000) + 60)
        throw new Error(
          "Sharing is changing too quickly or your clock changed. Wait a moment and try again.",
        );
    }
    const template = {
      ...input,
      pubkey: viewer,
      created_at: createdAt,
      tags: [
        ...input.tags.map((tag) => [...tag]),
        ["client-id", crypto.randomUUID()],
        ...(channelId ? [["ms", String(ms % 1000)]] : []),
      ],
    };
    const event = Object.freeze({
      ...template,
      tags: Object.freeze(
        template.tags.map((tag) => Object.freeze(tag)),
      ) as unknown as string[][],
      id: getEventHash(template),
    });
    const operation = Object.freeze({
      event,
      delivery: "sending" as const,
      ...(savedRecovery ? { recovery: savedRecovery } : {}),
      ...(active ? { guarded: true } : {}),
    });
    admit([...snapshot, operation], event.kind);
    if (active) admissionGates.set(event.id, active);
    captureSend(event);
    if (!replacing)
      profiling.measure("send.local", event.id, () => {
        snapshot = Object.freeze([...snapshot, operation]);
        notify();
      });
    const intent = ready.then(() => {
      if (storageError) throw new Error(storageError);
      return persist(
        replacing ?? event.id,
        replacing ? "acknowledge" : undefined,
        replacing ? operation : undefined,
      );
    });
    void intent.catch(() => {
      if (replacing) deliveryWork.delete(event.id);
    });
    if (replacing)
      void intent.then(
        () => schedule(event.id),
        () => {},
      );
    else schedule(event.id, intent);
    return { id: event.id, persisted: intent };
  }
  const outbox: Outbox = Object.freeze({
    snapshot: () => finalSnapshot ?? snapshot,
    subscribe: (listener: () => void) => subscribe(listeners, listener),
    observeSend: (listener: SendObserver) => {
      sendListeners.add(listener);
      return () => {
        sendListeners.delete(listener);
      };
    },
    supports: (kind: number) =>
      !closed && (!writer.kinds || writer.kinds.includes(kind)),
    async ready() {
      await ready;
      if (closed) throw abortError();
      if (storageError) throw new Error(storageError);
    },
    async recovery(key: string) {
      await outbox.ready();
      const shared = (await storage.load({ readOnly: true })).find(
        (item) => item.recovery?.key === key,
      );
      const local = snapshot.find((item) => item.recovery?.key === key);
      // A local send/retry can still own intent whose save failed or is pending.
      if (local && !restoredReceipts.has(local.event.id)) return local;
      if (local && local.event.id !== shared?.event.id) {
        restoredReceipts.delete(local.event.id);
        storage.forget?.(local.event.id);
        snapshot = Object.freeze(snapshot.filter((item) => item !== local));
        notify();
      }
      return shared;
    },
    async recover(id: string, recovery: OutboxRecovery, consume?: () => void) {
      const adopt = async () => {
        await outbox.ready();
        const saved = recoveryValue(recovery);
        if (!saved) throw new Error("Invalid outbox recovery state");
        let item = visible.find((entry) => entry.event.id === id);
        if (!item || dismissing.has(id))
          throw new Error(
            "The original operation is unavailable. Refresh before retrying.",
          );
        const shared = (await storage.load({ readOnly: true })).find(
          (entry) => entry.event.id === id,
        );
        if (!shared && restoredReceipts.has(id))
          throw new Error(
            "The original operation was removed in another window. Try Send again.",
          );
        if (
          shared?.recovery?.key === saved.key &&
          shared.recovery.value === saved.value
        ) {
          // The receipt already owns this source durably. Do not overwrite
          // delivery progress made by another window after our read.
          consume?.();
          return;
        }
        if (shared && restoredReceipts.has(id)) item = shared;
        if (item.acknowledged) {
          consume?.();
          return;
        }
        if (
          (item.recovery &&
            (item.recovery.key !== saved.key ||
              item.recovery.value !== saved.value)) ||
          snapshot.some(
            (entry) =>
              entry.event.id !== id && entry.recovery?.key === saved.key,
          )
        )
          throw new Error("Recover the earlier message before sending another");
        if (!find(id) && snapshot.length >= MAX_PENDING)
          throw new Error(
            "Too many outstanding operations; resolve a pending operation",
          );
        // Protect immediately against dismissal/echo eviction. On save failure keep
        // that protection; a later recovery attempt must persist it again before use.
        if (!item.recovery) restoredReceipts.delete(id);
        const retained = Object.freeze({ ...item, recovery: saved });
        admit(
          [...snapshot.filter((entry) => entry.event.id !== id), retained],
          item.event.kind,
        );
        completed.delete(id);
        snapshot = Object.freeze([
          ...snapshot.filter((entry) => entry.event.id !== id),
          retained,
        ]);
        notify();
        // Adoption must write the receipt even if this window cached the same
        // record before another window removed it.
        await persist(id, shared ? undefined : "recover");
        consume?.();
      };
      return storage.lock ? storage.lock(id, adopt) : adopt();
    },
    async acknowledge(
      id: string,
      verifyRetirement?: (event: EventData) => Promise<"recorded" | undefined>,
      replacement?: Replacement,
    ) {
      await outbox.ready();
      const item = visible.find((item) => item.event.id === id);
      if (!item?.recovery) return;
      if (verifyRetirement) {
        const eligible = (recorded = false) => {
          const current = find(id);
          return (
            !closed &&
            !attempts.has(id) &&
            current?.event.kind === 9000 &&
            current.recovery?.key.startsWith("member-add:") &&
            (current.delivery === "unknown" ||
              current.delivery === "failed" ||
              (recorded && current.delivery === "seen")) &&
            current.event.content === "" &&
            current.event.tags.every(
              (tag) =>
                tag.length === 2 &&
                ["h", "p", "client-id", "ms"].includes(tag[0] ?? ""),
            ) &&
            current.event.tags.filter(([tag]) => tag === "h").length === 1 &&
            current.event.tags.filter(([tag]) => tag === "p").length === 1 &&
            current.event.created_at < Math.floor(Date.now() / 1000) - 15 * 60
          );
        };
        // Seen may enter verification, but only fresh recorded-command evidence
        // with caller-verified membership can retire it below.
        if (dismissing.has(id) || !eligible(true))
          throw new Error(
            "This saved invitation may still arrive. Retry after its 15-minute delivery window ends.",
          );
        // Fence every local replay until verification and retirement are durable.
        const work = Promise.resolve().then(async () => {
          const result = await verifyRetirement(item.event);
          if (!eligible(result === "recorded"))
            throw new Error(
              "The invitation changed while checking it. Refresh members and try again.",
            );
          const input = replacement?.input();
          if (input) {
            const next = enqueue(input, item.recovery, undefined, id);
            await next.persisted;
            replacement?.queued(next.id);
          } else await persist(id, "acknowledge");
        });
        dismissing.set(id, work);
        try {
          await work;
        } finally {
          if (dismissing.get(id) === work) dismissing.delete(id);
        }
        return;
      }
      // Member callers verify a fresh signed roster even when the receipt was lost.
      if (
        !(
          item.event.kind === 9000 &&
          item.recovery.key.startsWith("member-add:")
        ) &&
        item.delivery !== "accepted" &&
        item.delivery !== "seen"
      )
        throw new Error("Confirm delivery before completing this message");
      await persist(id, "acknowledge");
    },
    send: (
      input: OutboxInput,
      recovery?: OutboxRecovery,
      active?: () => boolean,
    ) => enqueue(input, recovery, active).id,
    retry(id: string, active?: () => boolean) {
      const item = find(id);
      if (item?.guarded && (active ?? admissionGates.get(id))?.() !== true)
        throw new DOMException("Channel addition cancelled", "AbortError");
      // Workflow recovery is inspect/dismiss only, including restored intents.
      if (
        !closed &&
        item &&
        !(item.event.kind === 9000 && item.acknowledged) &&
        !isWorkflowOperation(item.event) &&
        !attempts.has(id) &&
        !dismissing.has(id)
      ) {
        restoredReceipts.delete(id);
        // A profile retry can reuse an older, unguarded saved invitation.
        // Promote that intent before scheduling so signing and publication honor
        // the renewed caller policy, including after the next hydration.
        if (active) admissionGates.set(id, active);
        if (item.delivery === "failed" || item.delivery === "unknown")
          captureSend(item.event);
        replace({
          ...item,
          ...(active ? { guarded: true } : {}),
          delivery: "sending",
          error: undefined,
          refused: undefined,
        });
        schedule(id, undefined, item.delivery);
      }
    },
    observeDismiss(listener: (item: OutgoingEvent) => void) {
      dismissListeners.add(listener);
      return () => {
        dismissListeners.delete(listener);
      };
    },
    dismiss(id: string, owner?: OutboxRecovery) {
      const pending = dismissing.get(id);
      if (pending) return pending;
      if (closed || attempts.has(id)) return Promise.resolve();
      const item = visible.find((item) => item.event.id === id);
      if (
        item?.recovery &&
        item.delivery !== "failed" &&
        (item.recovery.key !== owner?.key ||
          item.recovery.value !== owner.value)
      )
        return Promise.reject(
          new Error(
            item.event.kind === 9000
              ? "Confirm this addition in Members before removing it"
              : "Confirm this message in New message before removing it",
          ),
        );
      const remove = () => persist(id, "dismiss");
      const work = (storage.lock ? storage.lock(id, remove) : remove())
        .then(() => {
          admissionGates.delete(id);
        })
        .finally(() => dismissing.delete(id));
      dismissing.set(id, work);
      return work;
    },
  });
  return {
    outbox,
    local: Object.freeze({
      snapshot: () => finalVisible ?? visible,
      subscribe: (listener: () => void) => subscribe(localListeners, listener),
    }),
    ready,
    /** Fetched/confirmed evidence is disposable; pending intent is not. A revoke
     * during async hydration fences that old confirmed cache, not its writes. */
    purgeConfirmed(keep: (event: EventData) => boolean) {
      confirmedInvalidated = true;
      confirmedKeep = keep;
      const removed = completed
        .entries()
        .filter(([, item]) => !keep(item.event))
        .map(([id]) => id);
      for (const id of removed) completed.delete(id);
      if (removed.length) notify();
      // Queue behind hydration so a revoke cannot be undone by an old disk load.
      void persist("access-revoked").catch(() => {});
    },
    observe(events: readonly RelayEvent[]) {
      if (closed) return;
      const byId = new Map(events.map((event) => [event.id, event]));
      const confirmed = snapshot.flatMap((item) => {
        const event = byId.get(item.event.id);
        return event ? [event] : [];
      });
      const [first] = confirmed;
      if (!first) return;
      for (const event of confirmed) {
        delivered(event);
        if (
          (awaitsReceipt(event) && attempts.has(event.id)) ||
          find(event.id)?.recovery
        ) {
          snapshot = Object.freeze(
            snapshot.map((item) =>
              item.event.id === event.id
                ? Object.freeze({
                    ...item,
                    signed: event,
                    delivery: "seen" as const,
                  })
                : item,
            ),
          );
        } else
          completed.set(
            event.id,
            Object.freeze({
              ...find(event.id),
              event,
              signed: event,
              delivery: "seen",
            }),
          );
      }
      snapshot = Object.freeze(
        snapshot.filter(
          (item) =>
            !byId.has(item.event.id) ||
            (awaitsReceipt(item.event) && attempts.has(item.event.id)) ||
            !!item.recovery,
        ),
      );
      for (const event of confirmed) {
        if (awaitsReceipt(event) && attempts.has(event.id)) continue;
        const attempt = attempts.get(event.id);
        attempt?.controller?.abort();
        clearTimeout(attempt?.timer);
        attempts.delete(event.id);
      }
      notify();
      void persist(first.id).catch(() => {});
    },
    dispose() {
      if (closed) return;
      finalSnapshot = snapshot;
      finalVisible = visible;
      closed = true;
      admissionGates.clear();
      lifetime.abort();
      for (const attempt of attempts.values()) {
        attempt.controller?.abort(abortError());
        clearTimeout(attempt.timer);
      }
      attempts.clear();
      listeners.clear();
      localListeners.clear();
      sendListeners.clear();
      dismissListeners.clear();
      deliveryWork.clear();
      void ready
        .then(() => durable)
        .catch(() => {})
        .finally(() => storage.close?.());
    },
  };
}
