import type { ChannelMessage } from "../relay/contracts";
import { calendarDay } from "../../shared/datetime";

export function continuesMessageGroup(
  previous: ChannelMessage | undefined,
  current: ChannelMessage,
): boolean {
  return (
    !!previous &&
    !previous.membership &&
    !current.membership &&
    // Legacy output has no workflow ID: one relay signer is not one workflow.
    !previous.workflowOwnerId &&
    !current.workflowOwnerId &&
    !current.sentFromThread &&
    !previous.sentFromThread &&
    previous.channelId === current.channelId &&
    previous.authorId === current.authorId &&
    (previous.audience === current.audience || current.audience === "agents") &&
    current.createdAt >= previous.createdAt &&
    current.createdAt - previous.createdAt <= 5 * 60 &&
    calendarDay(previous.createdAt) === calendarDay(current.createdAt)
  );
}

/** Only same-author activity can bridge two public messages. */
export function publicMessageNeighbor(
  rows: readonly ChannelMessage[],
  index: number,
  direction: -1 | 1,
) {
  for (
    let next = index + direction;
    next >= 0 && next < rows.length;
    next += direction
  ) {
    const row = rows[next];
    if (!row) continue;
    if (row.audience !== "agents") return row;
    if (rows[index] && row.authorId !== rows[index]?.authorId) return undefined;
  }
  return undefined;
}
