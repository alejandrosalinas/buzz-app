import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelQueries, ChannelReference } from "../relay/contracts";

const unknown: ChannelReference = Object.freeze({ state: "unknown" });
const noop = () => () => {};

/**
 * What a link can show about a channel the reader may not have joined. The
 * store owns the lookup, its batching, expiry and retry; this hook only
 * demands the channel while the list is ready. The store looks up only an
 * answer that isn't a readable `found`, because discovery owns access.
 */
export function useChannelReference(
  queries: ChannelQueries | undefined,
  channelId: string | undefined,
): ChannelReference {
  const active = channelId && queries?.describe ? queries : undefined;
  // The list is replaced on every message preview; re-render only when this
  // reference's answer changes.
  const key = useSyncExternalStore(
    active?.subscribeList ?? noop,
    () =>
      active && channelId
        ? `${active.list().status === "ready" ? "ready" : ""}:${JSON.stringify(active.describe?.(channelId))}`
        : "",
    () => "",
  );
  const ready = key.startsWith("ready:");
  const reference = useMemo<ChannelReference>(
    () => (key ? JSON.parse(key.slice(key.indexOf(":") + 1)) : unknown),
    [key],
  );
  // Mounted links hold the demand, so the store rechecks them when an answer
  // expires or a failure's backoff ends. Moving between answers that aren't
  // readable keeps the same demand; becoming readable or not asks again. A
  // readable answer needs no lookup, but its demand still tells the store the
  // viewer's own traffic names the channel.
  const readable = reference.state === "found" && reference.readable !== false;
  const demand = ready ? (readable ? "named" : "lookup") : undefined;
  useEffect(() => {
    if (active && channelId && demand) return active.refer?.(channelId);
  }, [active, channelId, demand]);
  return reference;
}

/** A found channel that a link presents as a channel. DMs and Solo chats keep
 * their own presentation. */
export function namedChannel(reference: ChannelReference) {
  return reference.state === "found" &&
    !reference.hidden &&
    reference.channelType !== "dm" &&
    reference.channelType !== "solo"
    ? reference
    : undefined;
}
