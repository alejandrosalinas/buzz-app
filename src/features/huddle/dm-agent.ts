import { relayOrigin } from "../communities/destination";
import type { Agents } from "../agents/service";
import type { RelaySnapshot } from "../relay/service";
import type { HuddleDestination } from "./bridge";

/** Only this device's owned, unprotected voice runtime can join automatically. */
export function dmVoiceAgent(
  connection: RelaySnapshot,
  destination: HuddleDestination,
  agents: Pick<Agents, "snapshot" | "types">,
) {
  if (
    connection.status !== "ready" ||
    connection.cached ||
    connection.scope !== destination.scope ||
    connection.viewer !== destination.viewer
  )
    return undefined;
  const parent = connection.session.channels
    .list()
    .channels.find((channel) => channel.id === destination.channelId);
  if (
    parent?.channelType !== "dm" ||
    parent.archived ||
    parent.cached ||
    parent.readOnly ||
    parent.members?.length !== 2 ||
    !parent.members.includes(destination.viewer)
  )
    return undefined;
  const peer = parent.members.find((key) => key !== destination.viewer);
  const choices = connection.session.agentChoices.snapshot();
  if (!choices.selectable.some((agent) => agent.pubkey === peer))
    return undefined;
  const snapshot = agents.snapshot();
  if (snapshot.status !== "ready") return undefined;
  return snapshot.running.find(
    (agent) =>
      agent.pubkey === peer &&
      agent.owner === destination.viewer &&
      agent.place === "here" &&
      !agent.executionBinding &&
      relayOrigin(agent.relay) === relayOrigin(destination.relayUrl) &&
      !agent.protection &&
      agents.types().some((type) => type.key === agent.type && type.voice),
  );
}
