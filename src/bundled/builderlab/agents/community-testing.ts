import type { EventTemplate } from "nostr-tools";
import { keypair, signed } from "../../../features/relay/testing";
import type { RelayEvent, ReadFilter } from "../../../features/relay/events";
import { matchesEvent } from "../../../features/relay/projection";
import { createRelaySession } from "../../../features/relay/session";
import { relayPartition } from "../../../features/relay/partition";
import type { RelaySnapshot } from "../../../features/relay/service";
import type { ClientSnapshot } from "../../../features/communities/service";
import type { OutgoingEvent } from "../../../features/relay/outbox";
import { deferred } from "../test-helpers";

/** Real session/outbox/inventory; only the relay wire and device storage are controlled. */
export function communityFixture(
  selected: string | null = "https://community.example",
) {
  const identity = keypair();
  const viewer = identity.pubkey;
  const events: RelayEvent[] = [];
  const deleted = new Set<string>();
  let saved: readonly OutgoingEvent[] = [];
  const closed = deferred<void>();
  const save = async (next: readonly OutgoingEvent[]) => {
    saved = structuredClone(next);
  };
  const storage = {
    load: () => structuredClone(saved),
    save,
    close: () => closed.resolve(),
  };
  const sign = async (event: EventTemplate) => signed(identity, event);
  const publish = async (event: RelayEvent) => {
    // Kind 5 soft-deletes records present on arrival; it is not a fence for
    // registrations arriving later, even when they have an older timestamp.
    if (event.kind === 5)
      for (const existing of events)
        if (
          existing.pubkey === event.pubkey &&
          existing.created_at <= event.created_at &&
          event.tags.some(
            ([key, value]) =>
              key === "a" &&
              value ===
                `${existing.kind}:${existing.pubkey}:${existing.tags.find(([name]) => name === "d")?.[1]}`,
          )
        )
          deleted.add(existing.id);
    events.push(event);
  };
  const query = async (filters: readonly ReadFilter[]) =>
    events.filter(
      (event) =>
        filters.some((filter) => matchesEvent(event, filter)) &&
        !deleted.has(event.id),
    );
  const owner = createRelaySession(
    {
      viewer,
      relayAuthor: "cd".repeat(32),
      scope: "https://community.example",
      query,
      media: () => undefined,
      writer: { kinds: [30177, 5], sign, publish },
    },
    { outboxStorage: storage },
  );
  const snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer,
    origin: "https://community.example",
    scope: relayPartition("https://community.example", viewer),
    session: owner.session,
  };
  const community: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer,
    selected,
    memberships: [],
    sync: { known: [], outbox: [] },
    profile: { name: "", picture: "", about: "" },
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  const reader = { snapshot: () => community, subscribe: relay.subscribe };
  return {
    relay,
    reader,
    events,
    viewer,
    async dispose() {
      owner.dispose();
      await closed.promise;
      listeners.clear();
    },
  };
}
