import { useEffect, useState } from "react";
import { AgentPortrait } from "../agents/AgentCard";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import type { Agents } from "../../features/agents/service";
import { messageViewKey } from "../../features/messages/view-key";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useSavedAgent } from "../../features/solo/default-agent";
import { RobotIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { bestieChat } from "./chat";
import { BestieChooser } from "./BestieChooser";
import { BestieConversation } from "./BestieConversation";

/** Account-saved Besties use their canonical verified DM. No saved choice means
 * the caller keeps Riley's hosted setup page. */
export function PinnedBestie({
  relay,
  host,
  extensions,
  navigator,
  agents,
  navigation,
}: {
  relay: RelayData;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
  navigator: Navigation;
  agents: Agents;
  navigation?: PageNavigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  const { session, scope, viewer } = connection;
  const saved = useSavedAgent(session, scope ?? "");
  const active =
    connection.status === "ready" &&
    !!scope &&
    !!viewer &&
    scope.endsWith(`:${viewer}`);
  const choices = useAgentChoices(session, active, active);
  const known = choices.identities.find((choice) => choice.pubkey === saved);
  const agent = active
    ? choices.selectable.find((choice) => choice.pubkey === saved)
    : undefined;
  const channels = useChannelList(session.channels);
  // Match promotion: incomplete discovery cannot strand a verified existing DM.
  // Only a selectable agent below may open a conversation that is missing.
  const channel =
    saved &&
    !choices.archives.archived.includes(saved) &&
    (agent || choices.status !== "ready" || !choices.complete)
      ? bestieChat(channels.channels, viewer, saved)
      : undefined;
  const identity = agent ?? known;
  const name = identity ? (identity.managedName ?? identity.name) : "Bestie";
  const icon = identity ? (
    <AgentPortrait
      agent={{ name, picture: identity.avatar }}
      community={connection.origin}
    />
  ) : (
    <RobotIcon size="1rem" />
  );
  const header = (
    <PanelHeader title={<PanelHeaderLabel title={name} icon={icon} />} />
  );
  let content: React.ReactNode;
  if (!active || !scope) {
    content = (
      <Notice
        title={
          connection.status === "connecting"
            ? "Connecting…"
            : connection.status === "error"
              ? "This community is unavailable"
              : "No community selected"
        }
        description={
          connection.status === "connecting"
            ? "Your bestie conversation opens once this community is connected."
            : (connection.error ??
              "Choose a community to chat with your bestie.")
        }
        action={
          connection.status === "error" ? (
            <Button onClick={relay.tryAgain}>Retry connection</Button>
          ) : undefined
        }
      />
    );
  } else if (channel && saved) {
    content = (
      <DirectMessage
        key={saved}
        session={session}
        scope={scope}
        host={host}
        extensions={extensions}
        navigator={navigator}
        navigation={navigation}
        icon={icon}
        agent={{ pubkey: saved, name, picture: identity?.avatar }}
        community={connection.origin}
        channel={channel}
      />
    );
  } else if (!agent) {
    const pending =
      choices.pending ||
      choices.archives.status === "idle" ||
      choices.archives.status === "loading";
    content =
      pending && !choices.error ? (
        <LoadingRegion pending label="Loading your Bestie…">
          <Notice
            title="Loading your Bestie…"
            description="Reading the agents available in this community."
          />
        </LoadingRegion>
      ) : choices.error || !choices.complete ? (
        <Notice
          title="Your agents are unavailable"
          description={
            choices.error ?? "Buzz couldn’t finish reading your agents."
          }
          action={
            <Button
              onClick={() =>
                void session.agentChoices.refresh(true, { fresh: true })
              }
            >
              Try again
            </Button>
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <div className="w-full max-w-md">
            <BestieChooser
              key={scope}
              session={session}
              scope={scope}
              community={connection.origin}
              agents={agents}
              title={`${name} is no longer here`}
              description="Choose an eligible agent, or create one to make your new Bestie."
            />
          </div>
        </div>
      );
  } else {
    content =
      channels.status === "error" || channels.status === "unavailable" ? (
        <Notice
          title="Your chats are unavailable"
          description={
            channels.error ??
            "Buzz couldn’t read your chats, so this one can’t be opened."
          }
          action={
            <Button
              onClick={() =>
                session.channels.refreshList
                  ? session.channels.refreshList()
                  : session.channels.ensureList()
              }
            >
              Try again
            </Button>
          }
        />
      ) : channels.status !== "ready" ? (
        <LoadingRegion pending label="Loading your chats…">
          <Notice
            title="Loading your conversation…"
            description={`Looking for your DM with ${name}.`}
          />
        </LoadingRegion>
      ) : (
        <DirectMessage
          key={agent.pubkey}
          session={session}
          scope={scope}
          host={host}
          extensions={extensions}
          navigator={navigator}
          navigation={navigation}
          icon={icon}
          agent={{ pubkey: agent.pubkey, name, picture: agent.avatar }}
          community={connection.origin}
          channel={undefined}
        />
      );
  }
  if (active && scope && channel && saved) return content;
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Bestie">
        <div className="flex h-full min-h-0 flex-col">
          {header}
          {content}
        </div>
      </FullPageSurface>
    </div>
  );
}

function DirectMessage({
  session,
  scope,
  host,
  extensions,
  navigator,
  navigation,
  agent,
  community,
  icon,
  channel,
}: {
  session: RelaySession;
  scope: string;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
  agent: { pubkey: string; name: string; picture?: string | undefined };
  community?: string | undefined;
  icon: React.ReactNode;
  channel: ChannelSummary | undefined;
}) {
  const [attempt, retry] = useState(0);
  const [error, setError] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately starts a fresh open attempt.
  useEffect(() => {
    if (channel) return;
    const controller = new AbortController();
    setError(undefined);
    void (async () => {
      try {
        if (
          !session.agentChoices
            .snapshot()
            .selectable.some((choice) => choice.pubkey === agent.pubkey)
        )
          throw new Error(
            "This agent is no longer available in this community.",
          );
        await session.directMessages.open([agent.pubkey], controller.signal);
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Buzz couldn’t open this conversation.",
          );
      }
    })();
    return () => controller.abort();
  }, [session, agent.pubkey, channel, attempt]);
  if (channel)
    return (
      <BestieConversation
        key={messageViewKey(session, scope, channel.id)}
        session={session}
        scope={scope}
        host={host}
        extensions={extensions}
        navigator={navigator}
        navigation={navigation}
        channel={channel}
        agent={agent}
        community={community}
        icon={icon}
      />
    );
  if (error || attempt > 0)
    return (
      <Notice
        title="Couldn’t open this conversation"
        description={error ?? `Trying your DM with ${agent.name} again…`}
        announce={error ? "alert" : "status"}
        action={
          <Button loading={!error} onClick={() => retry((value) => value + 1)}>
            Try again
          </Button>
        }
      />
    );
  return (
    <LoadingRegion
      pending
      label={`Opening your conversation with ${agent.name}…`}
    >
      <Notice
        title="Opening your conversation…"
        description={`Connecting to your DM with ${agent.name}.`}
      />
    </LoadingRegion>
  );
}

function Notice({
  title,
  description,
  action,
  announce,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  announce?: "alert" | "status" | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<RobotIcon />}
        title={title}
        description={
          announce ? <span role={announce}>{description}</span> : description
        }
        action={action}
      />
    </div>
  );
}
