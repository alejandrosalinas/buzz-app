import type { ChannelMessage } from "./contracts";
import type { EventData } from "./events";
import { newer } from "./events";
import { collapseHuddleCards, foldMessages, messageAuthor } from "./fold";
import type { OutgoingEvent } from "./outbox";
import type { RelayProfiler } from "./profiling";

import { channelRowKind as messageKind } from "./membership";
import { compareMessages, eventMs, MessageClock } from "./message-order";
import { relayedFromClaim } from "./relayed-from";
import { threadReference } from "./thread-reference";
const PARENT_OVERLAY_DEPTH = 2;
const CHILD_OVERLAY_DEPTH = 1;

/** Per-window indexes. New evidence folds only affected messages; status updates never fold. */
export class MessageProjection {
  private inputs = new Map<string, EventData>();
  private overlays = new Map<string, Set<string>>();
  private messages = new Map<string, ChannelMessage>();
  private deliveries = new Map<string, OutgoingEvent>();
  private owners = new Map<string, string>();
  /** This client's reply sends that no relay summary has counted yet. A send
   * `sending` or `failed` when first retained is known to be uncounted: the
   * relay never committed a rejected send, which its row keeps visible for
   * retry across a restart, whereas a confirmed or unknown journal-restored
   * reply is already in its root's retained summary, and another user's live
   * reply is counted by the relay's follow-up.
   * The relay emits a thread's summary after each reply commits, racing the
   * publish receipt and the echo, so a newer root summary observed since the
   * send began vouches for it and the reply leaves once its send also has no
   * attempt in flight (accepted, echoed or unanswered), whichever lands second.
   * Clocks never decide this: the reply carries the client's, the summary the
   * relay's. */
  private pending = new Set<string>();
  private vouched = new Set<string>();
  private rows: readonly ChannelMessage[] = Object.freeze([]);
  constructor(
    private channelId: string,
    private relayAuthor: string,
    private profiling: RelayProfiler,
    private clock = new MessageClock(),
    private signingAuthority?: string,
    private agentOwner?: (pubkey: string) => string | undefined,
  ) {}
  snapshot() {
    return this.rows;
  }
  reconcile(
    events: readonly EventData[],
    operations: readonly OutgoingEvent[],
  ) {
    const next = new Map(events.map((event) => [event.id, event]));
    const deliveries = new Map(operations.map((item) => [item.event.id, item]));
    const affected = new Set<string>();
    for (const event of events) {
      if (!messageKind(event.kind)) continue;
      // A relayed row is the agent's only while the author owns that agent.
      const relayed = relayedFromClaim(event)?.agent;
      const owner = [
        this.agentOwner?.(messageAuthor(event, this.signingAuthority)),
        relayed && this.agentOwner?.(relayed),
      ].join(":");
      if (this.owners.get(event.id) !== owner) affected.add(event.id);
      this.owners.set(event.id, owner);
    }
    for (const id of this.owners.keys())
      if (!next.has(id)) this.owners.delete(id);
    // A reply also targets its thread root: the root's reply count folds from it.
    const targets = (event: EventData) => {
      if (!messageKind(event.kind))
        return event.tags.flatMap(([name, value]) =>
          name === "e" && value ? [value] : [],
        );
      const rootId = threadReference(event)?.rootId;
      return rootId ? [event.id, rootId] : [event.id];
    };
    const parents = (event: EventData) =>
      targets(event).filter((target) => target !== event.id);
    const summarized = new Set<string>();
    for (const [id, event] of this.inputs) {
      if (next.has(id)) continue;
      this.pending.delete(id);
      this.vouched.delete(id);
      for (const target of targets(event)) {
        affected.add(target);
        const refs = this.overlays.get(target);
        refs?.delete(id);
        if (!refs?.size) this.overlays.delete(target);
      }
    }
    for (const [id, event] of next) {
      // Stable event IDs identify immutable payloads, including unsigned local intent.
      if (this.inputs.has(id)) continue;
      if (messageKind(event.kind)) {
        this.clock.observe(this.channelId, eventMs(event));
        const delivery = deliveries.get(id)?.delivery;
        if (
          threadReference(event)?.rootId &&
          (delivery === "sending" || delivery === "failed")
        )
          this.pending.add(id);
      } else if (event.kind === 39005 && event.pubkey === this.relayAuthor) {
        const root = event.tags.find(([name]) => name === "e")?.[1];
        if (root) summarized.add(root);
      }
      for (const target of targets(event)) {
        affected.add(target);
        if (target !== id) {
          const refs = this.overlays.get(target) ?? new Set<string>();
          refs.add(id);
          this.overlays.set(target, refs);
        }
      }
    }
    for (const root of summarized) {
      const refs = [...(this.overlays.get(root) ?? [])].flatMap(
        (ref) => next.get(ref) ?? [],
      );
      // Only a summary that becomes the root's newest can vouch for its replies;
      // a stale page overlay landing after a live one must not.
      const latest = refs
        .filter((ref) => ref.kind === 39005 && ref.pubkey === this.relayAuthor)
        .reduce<EventData | undefined>(
          (current, ref) => newer(current, ref),
          undefined,
        );
      if (!latest || this.inputs.has(latest.id)) continue;
      for (const ref of refs)
        if (this.pending.has(ref.id)) this.vouched.add(ref.id);
    }
    for (const id of this.pending) {
      const delivery = deliveries.get(id)?.delivery;
      // A failed attempt never committed, so no summary so far has counted it.
      if (delivery === "failed") this.vouched.delete(id);
      if (!this.vouched.has(id) || delivery === "sending") continue;
      this.pending.delete(id);
      this.vouched.delete(id);
      affected.add(id);
    }
    // A deletion of an edit/reaction changes its owning message, not a row
    // whose ID is the overlay. Include removed inputs for failure rollback.
    const parentQueue = [...affected].map((id) => ({ id, depth: 0 }));
    const queuedParents = new Set(affected);
    for (let index = 0; index < parentQueue.length; index++) {
      const { id, depth } = parentQueue[index] ?? {};
      if (!id || depth === undefined || depth >= PARENT_OVERLAY_DEPTH) continue;
      const event = next.get(id) ?? this.inputs.get(id);
      if (!event) continue;
      for (const parent of parents(event)) {
        affected.add(parent);
        if (!queuedParents.has(parent)) {
          queuedParents.add(parent);
          parentQueue.push({ id: parent, depth: depth + 1 });
        }
      }
    }
    this.inputs = next;
    for (const [id, item] of deliveries) {
      const previous = this.deliveries.get(id);
      if (
        previous?.delivery !== item.delivery ||
        previous?.error !== item.error
      ) {
        if (messageKind(item.event.kind) && !affected.has(id))
          this.delivery(id, item);
      }
    }
    for (const id of this.deliveries.keys())
      if (!deliveries.has(id) && !affected.has(id))
        this.delivery(id, undefined);
    this.deliveries = deliveries;
    if (affected.size)
      this.profiling.measure(
        "view.fold",
        this.channelId,
        () => {
          for (const id of affected) {
            const event = next.get(id);
            const overlayIds = this.overlayIds(id);
            const row =
              event && messageKind(event.kind)
                ? foldMessages(
                    this.channelId,
                    this.relayAuthor,
                    [
                      event,
                      ...[...overlayIds].flatMap((ref) => next.get(ref) ?? []),
                    ],
                    {
                      collapseHuddles: false,
                      signingAuthority: this.signingAuthority,
                      agentOwner: this.agentOwner,
                      pendingReplies: this.pending,
                    },
                  ).find((row) => row.id === id)
                : undefined;
            if (row)
              this.messages.set(id, this.withDelivery(row, deliveries.get(id)));
            else this.messages.delete(id);
          }
          this.rows = Object.freeze(
            collapseHuddleCards(
              [...this.messages.values()],
              this.relayAuthor,
            ).sort(compareMessages),
          );
        },
        affected.size,
      );
    return this.rows;
  }
  private overlayIds(id: string) {
    const overlayIds = new Set(this.overlays.get(id) ?? []);
    let frontier = [...overlayIds];
    for (let depth = 0; depth < CHILD_OVERLAY_DEPTH; depth++) {
      const children: string[] = [];
      for (const ref of frontier) {
        for (const child of this.overlays.get(ref) ?? []) {
          if (overlayIds.has(child)) continue;
          overlayIds.add(child);
          children.push(child);
        }
      }
      frontier = children;
      if (!frontier.length) break;
    }
    return overlayIds;
  }
  private withDelivery(
    row: ChannelMessage,
    item: OutgoingEvent | undefined,
  ): ChannelMessage {
    return Object.freeze({
      ...row,
      delivery: item?.delivery,
      deliveryError: item?.error,
    });
  }
  private delivery(id: string, item: OutgoingEvent | undefined) {
    const row = this.messages.get(id);
    if (!row) return;
    const next = this.withDelivery(row, item);
    this.messages.set(id, next);
    this.rows = Object.freeze(
      this.rows.map((old) => (old.id === id ? next : old)),
    );
  }
}
