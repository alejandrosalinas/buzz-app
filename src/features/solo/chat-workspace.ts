import { useMemo, useSyncExternalStore } from "react";
import {
  soloNavigationFor,
  type SoloNavigationSnapshot,
} from "../channel-navigation/solo-navigation";
import type { SoloChatWorkspace } from "../channel-navigation/solo-navigation-contract";
import type { ChannelWindow } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

/** A chat is new until it has a message: its verified, complete history
 * holds only membership changes. History not yet known is not new. */
export function newChat(window: ChannelWindow | undefined) {
  return (
    window?.status === "ready" &&
    window.freshness === "verified" &&
    !window.refreshing &&
    !window.loadingOlder &&
    !window.hasMore &&
    !window.historyLimited &&
    !window.hasNewer &&
    window.rows.every((row) => !!row.membership)
  );
}

const noSubscription = () => () => {};

type SoloRegion = NonNullable<SoloNavigationSnapshot["regions"]>[number];
type ChatOwner = Readonly<{
  binding?: SoloNavigationSnapshot["binding"];
  source?: SoloRegion["source"];
  read?: SoloRegion["snapshot"];
  reason?: SoloRegion["reason"];
}>;

/** The workspace a region files its chat in, when the region offers one. */
export function useRegionWorkspace(
  session: RelaySession,
  channelId: string | undefined,
): SoloChatWorkspace | undefined {
  // Solo navigation publishes on every channel-list change. Without a chat
  // there is nothing to file, so skip the subscription and its renders.
  const reader = channelId ? soloNavigationFor(session) : undefined;
  // The result depends only on the binding, the chat's owning source and that
  // region's snapshot and state (a workspace change shows through its next
  // revision; a failed read keeps the snapshot), so render again only when
  // one of those changes.
  const owner = useMemo(() => {
    let last: ChatOwner = {};
    return (): ChatOwner => {
      const navigation = reader?.snapshot();
      const region = navigation?.regions.find((item) =>
        item.channels.some((channel) => channel.id === channelId),
      );
      const binding = navigation?.binding;
      const source = region?.source;
      const read = region?.snapshot;
      const reason = region?.reason;
      if (
        last.binding !== binding ||
        last.source !== source ||
        last.read !== read ||
        last.reason !== reason
      )
        last = { binding, source, read, reason };
      return last;
    };
  }, [reader, channelId]);
  const { binding, source, reason } = useSyncExternalStore(
    reader?.subscribe ?? noSubscription,
    owner,
  );
  if (!channelId || !binding || reason === "disabled" || !source?.workspace)
    return undefined;
  try {
    return source.workspace(binding, channelId);
  } catch {
    // A broken optional source leaves the chat without the control.
    return undefined;
  }
}
