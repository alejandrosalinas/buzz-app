import type { EventData } from "./events";
import { eventMs } from "./message-order";
import type { Outbox } from "./outbox";
import { threadReference } from "./thread-reference";

type Source = Readonly<{ channelId: string; rootId: string | null }>;
type Evidence = Readonly<{
  eventId: string;
  createdAtMs: number;
  recipientIds: readonly string[];
}>;
type Invocation = Readonly<{ anchorId: string; threadId: string }>;
const MAX_CANDIDATES = 128;
const MAX_RETAINED = 4096;
const inOrder = (a: Evidence, b: Evidence) =>
  a.createdAtMs - b.createdAtMs || a.eventId.localeCompare(b.eventId);

const capture = new WeakMap<
  Pick<Outbox, "snapshot">,
  {
    outbox: Outbox;
    ownsMessages(messages: object): boolean;
    record(
      event: EventData,
      recipients: readonly string[],
      invocation?: Invocation,
    ): void;
  }
>();

/** Only the human composer calls this. Raw send methods carry no provenance. */
export function sendWithOwnerMentions<T extends string | Promise<string>>(
  sender: { outbox?: Pick<Outbox, "snapshot"> | undefined; messages: object },
  recipients: readonly string[] | undefined,
  send: () => T,
  invocation?: Invocation,
): T {
  const owner = sender.outbox && capture.get(sender.outbox);
  if (!owner?.ownsMessages(sender.messages) || recipients === undefined)
    return send();
  const events: EventData[] = [];
  const stop = owner.outbox.observeSend((candidate) => {
    events.push(candidate);
    return undefined;
  });
  try {
    const id = send();
    const event = events.find((event) => id === event.id);
    if (event) owner.record(event, recipients, invocation);
    return id;
  } finally {
    stop();
  }
}

/** The relay service retains this device-local index across session replacement. */
export function createOwnerMentionStore(viewer: string) {
  const pending = new Map<
    string,
    { evidence: Evidence; invocation: Invocation | undefined }
  >();
  const latest = new Map<string, Evidence>();
  const confirmed = new Map<string, Source>();
  const listeners = new Set<() => void>();
  const key = ({ channelId, rootId }: Source, recipientId?: string) =>
    JSON.stringify([channelId, rootId, recipientId]);
  const put = <T>(map: Map<string, T>, id: string, value: T, limit: number) => {
    map.delete(id);
    map.set(id, value);
    if (map.size > limit) map.delete(map.keys().next().value as string);
  };
  let notifying = false;
  const changed = () => {
    if (notifying || !listeners.size) return;
    notifying = true;
    queueMicrotask(() => {
      notifying = false;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // One consumer cannot interrupt another.
        }
      }
    });
  };
  return {
    bind(
      outbox: Outbox,
      canRead: (channelId: string) => boolean,
      signal: AbortSignal,
      subscribeAccess: (listener: () => void) => () => void,
      ownsMessages: (messages: object) => boolean,
    ) {
      capture.set(outbox, {
        outbox,
        ownsMessages,
        record(event, recipients, invocation) {
          if (event.kind !== 9 || event.pubkey !== viewer) return;
          const tagged = new Set(
            event.tags.filter(([name]) => name === "p").map((tag) => tag[1]),
          );
          const recipientIds = [...new Set(recipients)].filter((id) =>
            tagged.has(id),
          );
          put(
            pending,
            event.id,
            {
              evidence: Object.freeze({
                eventId: event.id,
                createdAtMs: eventMs(event),
                recipientIds: Object.freeze(recipientIds),
              }),
              invocation,
            },
            512,
          );
        },
      });
      const ownListeners = new Set<() => void>();
      const stopAccess = subscribeAccess(changed);
      signal.addEventListener(
        "abort",
        () => {
          capture.delete(outbox);
          stopAccess();
          for (const listener of ownListeners) listeners.delete(listener);
          ownListeners.clear();
        },
        { once: true },
      );
      return Object.freeze({
        version: 1 as const,
        confirmedOwnerSends(
          source: Source,
          eventIds: readonly string[],
        ): readonly string[] {
          if (
            eventIds.length > MAX_CANDIDATES ||
            signal.aborted ||
            !canRead(source.channelId)
          )
            return [];
          return Object.freeze(
            eventIds.filter((id) => {
              const receipt = confirmed.get(id);
              return (
                receipt?.channelId === source.channelId &&
                (receipt.rootId === source.rootId ||
                  (receipt.rootId === null && id === source.rootId))
              );
            }),
          );
        },
        latest(source: Source, eligibleRecipientIds?: readonly string[]) {
          if (signal.aborted || !canRead(source.channelId)) return null;
          if (eligibleRecipientIds === undefined)
            return latest.get(key(source)) ?? null;
          if (eligibleRecipientIds.length > MAX_CANDIDATES) return null;
          let newest: Evidence | undefined;
          const eligible = new Set(eligibleRecipientIds);
          for (const recipientId of eligible) {
            const candidate = latest.get(key(source, recipientId));
            if (candidate && (!newest || inOrder(newest, candidate) < 0))
              newest = candidate;
          }
          if (!newest) return null;
          return Object.freeze({
            ...newest,
            recipientIds: Object.freeze(
              newest.recipientIds.filter((id) => eligible.has(id)),
            ),
          });
        },
        subscribe(listener: () => void) {
          if (signal.aborted) return () => {};
          ownListeners.add(listener);
          listeners.add(listener);
          return () => {
            ownListeners.delete(listener);
            listeners.delete(listener);
          };
        },
      });
    },
    confirm(event: EventData, canRead: (channelId: string) => boolean) {
      const proof = pending.get(event.id);
      if (!proof || event.kind !== 9 || event.pubkey !== viewer) return;
      const channelId = event.tags.find(([name]) => name === "h")?.[1];
      if (!channelId || !canRead(channelId)) return;
      pending.delete(event.id);
      const { evidence, invocation } = proof;
      const thread = threadReference(event);
      // The wire keeps the physical thread and immediate reply target.
      if (invocation && invocation.threadId !== thread?.rootId) return;
      const root = invocation?.anchorId ?? thread?.parentId ?? null;
      put(confirmed, event.id, { channelId, rootId: root }, MAX_RETAINED);
      if (!evidence.recipientIds.length) {
        changed();
        return;
      }
      // A nested reply updates its selected branch. A top-level send also
      // starts the thread whose root is the message itself.
      const roots = root ? [root] : [null, event.id];
      for (const rootId of roots) {
        for (const recipientId of [undefined, ...evidence.recipientIds]) {
          const address = key({ channelId, rootId }, recipientId);
          const previous = latest.get(address);
          if (previous && inOrder(previous, evidence) >= 0) continue;
          put(latest, address, evidence, MAX_RETAINED);
        }
      }
      changed();
    },
    clear() {
      pending.clear();
      latest.clear();
      confirmed.clear();
      changed();
    },
  };
}
