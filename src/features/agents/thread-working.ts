import { localActivity } from "./local-activity";
import type { createAgentActivity } from "./activity";
import { requestWork } from "./request-work";

type Snapshot = ReturnType<
  ReturnType<typeof createAgentActivity>["queries"]["snapshot"]
>;

type Turns = Snapshot["turns"];
// Every mounted thread asks the same snapshot: index linked turns once per array.
const threadTurns = new WeakMap<object, ReadonlyMap<string, Turns[number][]>>();
function linkedTurns(turns: Turns, channelId: string, rootId: string) {
  let index = threadTurns.get(turns);
  if (!index) {
    const built = new Map<string, Turns[number][]>();
    for (const turn of turns)
      for (const request of turn.requests ?? []) {
        const key = `${turn.channelId}\n${request.threadRootId}`;
        const linked = built.get(key);
        if (!linked) built.set(key, [turn]);
        else if (linked.at(-1) !== turn) linked.push(turn);
      }
    index = built;
    if (Object.isFrozen(turns)) threadTurns.set(turns, index);
  }
  return index.get(`${channelId}\n${rootId}`) ?? [];
}

/** Use the same request state as message bubbles. Pulses remain useful for
 * unassociated work, but cannot revive a request with known lifecycle evidence. */
export function threadWorkingAgents(
  activity: Snapshot | undefined,
  typing: readonly string[],
  channelId: string,
  rootId: string,
  represented?: { messageId: string; agents: ReadonlySet<string> },
): readonly string[] {
  const local = localActivity(activity, channelId, rootId);
  const activeLocal = (activity?.local ?? [])
    .filter(
      (row) =>
        row.channelId === channelId &&
        row.threadRootId === rootId &&
        (row.state === "waiting" || row.state === "working") &&
        !(
          represented?.messageId === row.messageId &&
          represented.agents.has(row.agent)
        ),
    )
    .map((row) => row.agent);
  const untrackedTyping = typing.filter((agent) => !local.has(agent));
  if (activity?.status !== "listening")
    return [...new Set([...untrackedTyping, ...activeLocal])];
  const linked = linkedTurns(activity.turns, channelId, rootId);
  const requests = [
    rootId,
    ...linked.flatMap(
      (turn) =>
        turn.requests
          ?.filter((request) => request.threadRootId === rootId)
          .map((request) => request.messageId) ?? [],
    ),
  ];
  const work = requestWork(activity, channelId, requests);
  const elsewhere = represented?.agents.size
    ? requestWork(
        activity,
        channelId,
        requests.filter((id) => id !== represented.messageId),
      )
    : work;
  const known = new Set([
    ...linked.map((turn) => turn.agent),
    ...work.map((entry) => entry.agent),
  ]);
  return [
    ...new Set([
      ...activeLocal,
      ...work
        .filter(
          (entry) =>
            !local.has(entry.agent) &&
            (represented?.agents.has(entry.agent)
              ? elsewhere.some(
                  (other) => other.agent === entry.agent && other.working,
                )
              : entry.working),
        )
        .map((entry) => entry.agent),
      ...untrackedTyping.filter((agent) => !known.has(agent)),
    ]),
  ];
}
