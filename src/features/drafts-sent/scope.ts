import type { RelaySnapshot } from "../../features/relay/service";
import { splitPartition } from "../../features/relay/partition";
import type { ChannelSummary } from "../../features/relay/contracts";

/** Navigation scope for a ready connection whose partition is `<origin>:<viewer>`. */
export function scopeOf(connection: RelaySnapshot) {
  const parts = connection.scope && splitPartition(connection.scope);
  return parts && parts.viewer === connection.viewer ? parts : undefined;
}

/** Hidden from both the list and the count: Huddle rooms and channels still resolving. */
export const listed = (channel: ChannelSummary | undefined) =>
  !channel?.huddle && !channel?.metadataPending;
