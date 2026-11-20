import { threadReference } from "../../relay/thread-reference";
import type { ConversationWake, Delivery, Trigger } from "../service";
import { isBuzzUuid, turnErrors, type TurnContext } from "./contract";

/** Where a turn is delivered, as the runner knows it at dispatch. */
export type TurnPlace = Readonly<{
  /** The live route's channel for an addressed trigger. */
  channelId?: string | undefined;
  /** The conversation a watch, timer or source wakes; absent for a
   * standalone turn, which has no channel or thread. */
  wake?: ConversationWake | undefined;
  /** Whether the delivery channel is flat (a DM of any size or a Solo
   * chat), so the turn has no thread. */
  flat: (channelId: string) => boolean;
}>;

/** Where this turn happened and the signed event that caused it, frozen at
 * dispatch under the Buzz context contract. A mention, or a signed event a watch
 * delivered, is the turn's message; a wake, timer, catch-up or source has no
 * single signed event, so its message is null, never a fabricated or
 * selected one. Throws when the delivery cannot be described exactly. */
export function turnContextFor(
  trigger: Trigger,
  place: TurnPlace,
): TurnContext {
  const context = describe(trigger, place);
  const invalid = turnErrors(context);
  if (invalid) throw new Error(`Gateway context unavailable: ${invalid}`);
  return Object.freeze(context);
}

/** The turn context the runner froze for this delivery; absent when the
 * agent's membership doesn't route through the gateway. */
export const turnContext = (delivery: Pick<Delivery, "gateway">) =>
  delivery.gateway?.turn;

function describe(
  trigger: Trigger,
  { channelId, wake, flat }: TurnPlace,
): TurnContext {
  const uuid = (value: string | undefined) =>
    value !== undefined && isBuzzUuid(value) ? value : null;
  // Event IDs are hex, compared case-insensitively where they're read (a
  // thread's `e` tag may be uppercase), so the context carries the
  // contract's lowercase form.
  const where = (channel: string | undefined, root: string | undefined) => ({
    channel_id: uuid(channel),
    thread_id:
      root === undefined || (channel !== undefined && flat(channel))
        ? null
        : root.toLowerCase(),
  });
  switch (trigger.type) {
    case "mention": {
      const { event } = trigger;
      return {
        ...where(
          channelId ?? channelOf(event),
          threadReference(event)?.rootId ?? event.id,
        ),
        message_id: event.id.toLowerCase(),
      };
    }
    case "plugin":
    case "attention":
      return { ...where(trigger.channel, trigger.root), message_id: null };
    case "watch":
      // A watch over every channel has no wake, so its channel is the event's.
      return {
        ...where(
          wake?.channel ?? channelId ?? channelOf(trigger.event),
          wake?.root,
        ),
        message_id: trigger.event.id.toLowerCase(),
      };
    case "catch-up":
    case "source":
    case "timer":
      return { ...where(wake?.channel, wake?.root), message_id: null };
  }
}

const channelOf = (event: { tags: readonly (readonly string[])[] }) =>
  event.tags.find(([name]) => name === "h")?.[1];
