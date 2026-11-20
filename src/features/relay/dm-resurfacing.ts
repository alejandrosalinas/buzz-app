import { agentAudience } from "./audience";
import type { ChannelLifecycleCapability } from "./channel-lifecycle";
import type { IncomingListener, LiveListener } from "./incoming";

/** A new message from someone else resurfaces a DM the viewer hid: the relay
 * clears the hide before it fans the message out, so visibility is reread
 * from its writer. Replay after a reconnect counts too, since it may carry
 * the only copy. An arrival that a pending read may predate waits for that
 * read's snapshot to classify it. Agent-only coordination leaves the hide in
 * place, so it needs no read. Returns the unsubscribe. */
export function resurfaceHiddenDms(
  session: {
    channelLifecycle: ChannelLifecycleCapability;
    subscribeIncoming(listener: IncomingListener): () => void;
    subscribeLive(
      listener: LiveListener,
      options?: { replay?: boolean },
    ): () => void;
  },
  viewer: string | undefined,
  signal?: AbortSignal,
): () => void {
  const lifecycle = session.channelLifecycle;
  // Arrivals the next ready snapshot classifies.
  const held = new Set<string>();
  const reread = () =>
    void lifecycle.refreshVisibility(signal, { trailing: true, strong: true });
  const arrive = (channelIds: readonly string[]) => {
    const { status, hidden } = lifecycle.snapshot();
    if (channelIds.some((id) => hidden.includes(id))) reread();
    else if (status !== "ready") for (const id of channelIds) held.add(id);
  };
  const stopSnapshot = lifecycle.subscribe(() => {
    const { status, hidden } = lifecycle.snapshot();
    if (status !== "ready" || !held.size) return;
    const resurfaced = [...held].some((id) => hidden.includes(id));
    held.clear();
    if (resurfaced) reread();
  });
  const stopIncoming = session.subscribeIncoming((messages) =>
    arrive(
      messages
        .filter((message) => message.audience !== "agents")
        .map((message) => message.channelId),
    ),
  );
  const stopReplay = session.subscribeLive(
    (batch) => {
      if (!batch.replay) return;
      arrive(
        batch.events.flatMap((event) => {
          const destinations = event.tags.filter(([name]) => name === "h");
          const id = destinations.length === 1 ? destinations[0]?.[1] : "";
          return id &&
            [9, 40002, 40008].includes(event.kind) &&
            event.pubkey !== viewer &&
            !agentAudience(event)
            ? [id]
            : [];
        }),
      );
    },
    { replay: true },
  );
  return () => {
    stopSnapshot();
    stopIncoming();
    stopReplay();
  };
}
