import { useChannelActivitySubscription } from "../../features/agents/use-channel-agent-activity";
import { breathing, localActivity } from "../../features/agents/local-activity";
import { useMemo, useSyncExternalStore } from "react";
import type { Profile } from "../../features/relay/contracts";
import { selectProfiles } from "../../features/relay/profile-selection";
import type { RelaySession } from "../../features/relay/session";
import { workingAgents } from "./working-agents";

const noSubscribe = () => () => {};
const noAgents: readonly string[] = [];
const none: ReadonlyMap<string, Profile> = new Map();
const noProfiles = () => none;

/** Shared observer/owned-typing signal for Messages and Solo sidebar rows. */
export function useWorkingAgents(
  session: RelaySession,
  channelId: string,
  working: boolean,
) {
  const subscribe = useChannelActivitySubscription(
    session.agentActivity,
    channelId,
  );
  const local = useSyncExternalStore(subscribe, () =>
    JSON.stringify(
      [
        ...localActivity(
          session.agentActivity.snapshot(channelId),
          channelId,
        ).values(),
      ].map((row) => [row.agent, breathing(row) ? "waiting" : row.state]),
    ),
  );
  const localStates = new Map<string, string>(JSON.parse(local));
  const agentKeys = useSyncExternalStore(
    working ? subscribe : noSubscribe,
    () =>
      working
        ? workingAgents(
            session.agentActivity.snapshot(channelId),
            channelId,
          ).join(",")
        : "",
  );
  // App-managed agents publish no observer telemetry, so typing in this channel
  // or any of its threads is their working signal. Only the viewer's own agents
  // count: the library, not other people's self-declared profile hints.
  const typingKeys = useSyncExternalStore(session.typing.subscribe, () =>
    [
      ...new Set(
        session.typing
          .snapshot()
          .filter((entry) => entry.channelId === channelId)
          .map((entry) => entry.pubkey),
      ),
    ].join(","),
  );
  const observed = [
    ...new Set([
      ...(agentKeys ? agentKeys.split(",") : noAgents),
      ...[...localStates]
        .filter(([, state]) => state === "waiting" || state === "working")
        .map(([key]) => key),
    ]),
  ];
  const typers = typingKeys ? typingKeys.split(",") : noAgents;
  const library = useSyncExternalStore(
    typers.length || localStates.size
      ? session.agentChoices.subscribe
      : noSubscribe,
    typers.length || localStates.size
      ? session.agentChoices.snapshot
      : () => undefined,
  );
  const typingAgents = typers.filter(
    (key) =>
      !localStates.has(key) &&
      library?.identities.some((identity) => identity.pubkey === key),
  );
  const agents = typingAgents.length
    ? [...new Set([...observed, ...typingAgents])].sort()
    : observed;
  // Only these agents' profiles: another profile arriving leaves the row alone.
  const ids = agents.join(",");
  const selection = useMemo(
    () => (ids ? selectProfiles(session.profiles, ids.split(",")) : undefined),
    [session, ids],
  );
  const names = new Map(
    useSyncExternalStore(
      selection?.subscribe ?? noSubscribe,
      selection?.snapshot ?? noProfiles,
    ),
  );
  for (const agent of library?.identities ?? [])
    if (agents.includes(agent.pubkey) && !names.get(agent.pubkey)?.name)
      names.set(agent.pubkey, { ...names.get(agent.pubkey), name: agent.name });
  const waiting =
    agents.length > 0 &&
    agents.every((agent) => localStates.get(agent) === "waiting");
  return { agents, agentProfiles: names, waiting };
}
