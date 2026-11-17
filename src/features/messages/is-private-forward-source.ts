import type { ChannelReference } from "../relay/contracts";

/** Unknown sources receive the same disclosure as known private sources. */
export function isPrivateForwardSource(
  reference: ChannelReference | undefined,
) {
  return (
    reference?.state !== "found" ||
    reference.private ||
    reference.hidden ||
    ["dm", "solo"].includes(reference.channelType ?? "")
  );
}
