import type { ChannelMessage } from "../relay/contracts";

/** Only consecutive agent-only messages on one local day fold together.
 * Human messages, public agent replies and membership notices stay visible. */
export function activityRuns(
  rows: readonly ChannelMessage[],
  requests?: ReadonlyMap<string, string>,
): ChannelMessage[][] {
  const groups: ChannelMessage[][] = [];
  let group: ChannelMessage[] | undefined;
  let previous: ChannelMessage | undefined;
  for (const row of rows) {
    if (row.audience !== "agents" || row.membership) {
      group = undefined;
    } else {
      if (
        !group ||
        previous?.channelId !== row.channelId ||
        previous.threadRootId !== row.threadRootId ||
        requests?.get(previous.id) !== requests?.get(row.id) ||
        new Date(previous.createdAt * 1000).toDateString() !==
          new Date(row.createdAt * 1000).toDateString()
      ) {
        group = [];
        groups.push(group);
      }
      group.push(row);
    }
    previous = row;
  }
  return groups;
}

/** A run of messages relayed from other chats, folded into one line. */
export type RelayedRun = { ids: string[]; relayed: ChannelMessage[] };

/** Two or more consecutive verified relayed messages in one conversation, on
 * one local day, fold together. Any other row breaks the run. Agent-only rows
 * belong to activity runs, so they break it too, and a message with a thread
 * stays its own line so its replies stay in view. */
export function relayedRuns(
  rows: readonly ChannelMessage[],
  /** The first unread message starts a run, so the New messages line stays above it. */
  unreadBoundary?: string,
): RelayedRun[] {
  const runs: ChannelMessage[][] = [];
  let run: ChannelMessage[] | undefined;
  for (const row of rows) {
    if (
      !row.relayedFrom?.verified ||
      row.audience === "agents" ||
      row.membership ||
      row.replyCount > 0
    ) {
      run = undefined;
      continue;
    }
    const previous = run?.at(-1);
    if (
      !run ||
      row.id === unreadBoundary ||
      previous?.channelId !== row.channelId ||
      previous.threadRootId !== row.threadRootId ||
      new Date(previous.createdAt * 1000).toDateString() !==
        new Date(row.createdAt * 1000).toDateString()
    ) {
      run = [];
      runs.push(run);
    }
    run.push(row);
  }
  return runs
    .filter((relayed) => relayed.length > 1)
    .map((relayed) => ({ ids: relayed.map((row) => row.id), relayed }));
}
