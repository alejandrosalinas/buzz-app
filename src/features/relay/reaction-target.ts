import type { EventData } from "./events";

/** NIP-25: the last valid event reference is the reaction's target. */
export function reactionTarget(event: Pick<EventData, "tags">) {
  let target: string | undefined;
  for (const [name, value] of event.tags)
    if (name === "e" && value && /^[0-9a-f]{64}$/i.test(value))
      target = value.toLowerCase();
  return target;
}
