import { useEffect, useSyncExternalStore } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import {
  lifecycleOffer,
  ownerEvidence,
} from "../../features/relay/channel-lifecycle-protocol";

export type LifecycleSession = Pick<
  RelaySession,
  "viewer" | "profiles" | "channelLifecycle"
>;

/**
 * Lifecycle actions from the session's live channel state, ready when a
 * surface opens. Owner-agent evidence comes from the shared profile cache; a
 * missing owner profile is fetched in the background. Confirmation rechecks
 * everything against fresh relay state.
 */
export function useLifecycleOffer(
  { viewer = "", profiles, channelLifecycle }: LifecycleSession,
  channel: ChannelSummary,
) {
  const owners = ownerEvidence(channel, viewer);
  const agentOwner = useSyncExternalStore(profiles.subscribe, () =>
    owners.some((key) => profiles.owner?.(key) === viewer),
  );
  const available = channelLifecycle.available;
  useEffect(() => {
    if (agentOwner || !available || !owners.length) return;
    // A clear, an eviction or a cancelled read drops owner evidence, so ask
    // again when either counter moves. A failed read asks again at the
    // directory's next change; nothing retries on a timer.
    const epoch = () =>
      `${profiles.generation?.() ?? 0}:${profiles.evictions?.() ?? 0}`;
    let asked = "";
    let failed = false;
    let live = true;
    const request = () => {
      asked = epoch();
      failed = false;
      const unnamed = profiles.unnamed?.();
      const missing = owners.filter(
        (key) => !profiles.event?.(key) && !unnamed?.has(key),
      );
      if (missing.length)
        profiles.ensure(missing, "background").catch(() => {
          failed = live;
        });
    };
    const stop = profiles.subscribe(() => {
      if (failed || epoch() !== asked) request();
    });
    request();
    return () => {
      live = false;
      stop();
    };
  }, [agentOwner, available, owners, profiles]);
  return lifecycleOffer(channel, viewer, agentOwner);
}
