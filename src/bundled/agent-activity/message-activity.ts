import {
  requestWork,
  type RequestWork,
} from "../../features/agents/request-work";

const live = ({ state, lifecycle, dismissed }: RequestWork) =>
  state !== "unknown" &&
  (lifecycle
    ? state !== "done" &&
      state !== "superseded" &&
      state !== "stopped" &&
      !dismissed
    : state === "working" || state === "error");

/** Message and thread displays project the same request status. Pulses alone
 * cannot establish which individual message triggered work. */
export function messageActivity(...args: Parameters<typeof requestWork>) {
  return messageWork(...args).live;
}

/** Working requests and persistent confirmed outcomes: those the owner
 * stopped, and finished or superseded ones with a notice about how they ran
 * (such as without the agent gateway), which says where the turn's data
 * went. Uncertain telemetry is retained by requestWork for recovery, without
 * becoming a conversation error. */
export function messageWork(...args: Parameters<typeof requestWork>) {
  const work = requestWork(...args);
  return {
    live: work.filter(live),
    stopped: work.filter(
      ({ state, notice }) =>
        state === "stopped" ||
        ((state === "done" || state === "superseded") && !!notice),
    ),
  };
}
