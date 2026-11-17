import { type Feature, LEGACY, memory } from "./features";

/** The hourly check-in as an earlier version saved it: a section of the
 * agent's instructions with all its steps, among them the one that added the
 * agent to each private channel it was added to, and a timer for the DM. */
export const v1CheckIn: Feature = {
  ...(LEGACY[0] as Feature),
  text: `# Hourly upkeep
This runs only when your hourly check-in timer wakes you with "Hourly upkeep wake", in your DM with the owner.

1. LOAD. mem_get mem/heartbeat; if it is absent, create it with channels = [the DM the wake arrived in]. Add to channels each private channel you have been added to that it doesn't list yet, so its new messages are read the same way; you are a guest there and can't post.
2. IDENTIFY WHAT MATTERS. Look for new durable facts or preferences.
6. FINISH. Advance each channel's last-processed created_at only after its work succeeded.`,
};

/** Remembers you as version 1 shipped it, which had chat turns keep prose
 * in mem/memory. */
export const v1Memory: Feature = {
  ...memory,
  version: 1,
  text: memory.earlier?.[1] ?? "",
};
