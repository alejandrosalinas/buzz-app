import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { Select } from "../../shared/design-system/ui/Select";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { useAgentOwnerEvidence } from "../profiles/useAgentOwnerEvidence";
import messages from "../messages/Messages.module.css";
import { AgentsContext, useAgents, useAgent } from "./react";
import type { PortableAgent } from "./native";
import type { Agents, RegisteredAgentType } from "./service";

export function connectionDraft(
  candidate: PortableAgent,
  types: readonly RegisteredAgentType[],
): { type: string; config: unknown } | undefined {
  const saved = candidate.connection;
  if (!saved) return undefined;
  for (const type of types) {
    if (type.remote) continue;
    const config = type.importShared?.({ ...saved, model: saved.model ?? "" });
    if (config === undefined) continue;
    return {
      type: type.key,
      config:
        saved.effort &&
        typeof config === "object" &&
        config !== null &&
        "effort" in config
          ? { ...config, effort: saved.effort }
          : config,
    };
  }
  return undefined;
}

/** Latest explicit mention per agent, limited to the viewer's delivered messages. */
export function connectionMentions(
  rows: readonly ChannelMessage[],
  viewer: string,
) {
  const mentions = new Map<string, ChannelMessage>();
  for (const row of rows) {
    if (
      row.authorId !== viewer ||
      (row.signerId && row.signerId !== viewer) ||
      row.edited ||
      row.agentEnvelope ||
      (row.delivery && row.delivery !== "accepted" && row.delivery !== "seen")
    )
      continue;
    for (const peer of row.mentions) {
      if (peer !== viewer) mentions.set(peer, row);
    }
  }
  return mentions;
}

/** A local setup message: never a relay event or an agent-authored response. */
export function AgentConnectionSetup({
  session,
  channel,
  rows = [],
}: {
  session: RelaySession;
  channel: ChannelSummary | undefined;
  rows?: readonly ChannelMessage[];
}) {
  const agents = useContext(AgentsContext);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const isAgent = (key: string) => profiles.get(key)?.isAgent === true;
  // Only a DM has a peer; a channel can have thousands of members.
  const members =
    channel?.channelType === "dm" ? [...new Set(channel.members ?? [])] : [];
  const peer =
    channel?.channelType === "dm" &&
    !channel.archived &&
    channel.viewerRole !== "guest" &&
    members.length === 2 &&
    members.includes(session.viewer ?? "")
      ? members.find((key) => key !== session.viewer)
      : undefined;
  if (
    agents &&
    channel?.channelType === "dm" &&
    import.meta.env.DEV &&
    import.meta.env.VITE_AGENT_CONNECTION_PREVIEW === "1"
  )
    return (
      <AgentConnectionForm
        key={`preview:${channel.id}`}
        agents={agents}
        scope={session.scope}
        preview
        candidate={{
          source: "installed",
          pubkey: peer ?? "preview",
          name: (peer && profiles.get(peer)?.name) || channel.name,
          picture:
            avatarMedia(
              peer ? profiles.get(peer)?.picture : undefined,
              session.media,
            ) ?? "",
          relay: "",
        }}
      />
    );
  if (!agents) return null;
  if (
    channel &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    session.viewer &&
    channel.members?.includes(session.viewer) &&
    !channel.archived &&
    !channel.readOnly &&
    !channel.cached &&
    channel.viewerRole &&
    channel.viewerRole !== "guest"
  ) {
    return (
      <>
        {[...connectionMentions(rows, session.viewer)]
          .filter(([key]) => isAgent(key))
          .map(([mentioned, message]) => (
            <Candidate
              key={`${session.scope}:${channel.id}:${mentioned}`}
              agents={agents}
              session={session}
              peer={mentioned}
              message={message}
            />
          ))}
      </>
    );
  }
  if (!peer || !isAgent(peer)) return null;
  return (
    <Candidate
      key={`${session.scope}:${peer}`}
      agents={agents}
      session={session}
      peer={peer}
    />
  );
}

function Candidate({
  agents,
  session,
  peer,
  message,
}: {
  agents: Agents;
  session: RelaySession;
  peer: string;
  message?: ChannelMessage;
}) {
  const notify = useToastNotification();
  const owned = useAgentOwnerEvidence(session, peer);
  const existing = useAgent(agents, peer)?.agent.key;
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const presence = useSyncExternalStore(
    (listener) => session.presence.subscribe(peer, listener),
    () => session.presence.status(peer),
  );
  const [candidate, setCandidate] = useState<PortableAgent>();
  const [phase, setPhase] = useState<"idle" | "pending" | "done">("idle");
  useEffect(() => {
    if (owned.status !== "ready" || owned.owner !== session.viewer || existing)
      return;
    let active = true;
    void agents
      .portable()
      .then((found) => {
        if (active)
          setCandidate(
            found.agents.find(
              (agent) =>
                agent.pubkey === peer && agent.connection?.runtime !== "hosted",
            ),
          );
      })
      .catch(() => {
        /* The existing Agents import page owns inventory recovery. */
      });
    return () => {
      active = false;
    };
  }, [agents, peer, owned.status, owned.owner, session.viewer, existing]);
  // Retain in-flight UI and successful results through inventory changes.
  // A failed attempt returns to live eligibility checks before offering retry.
  if (
    !candidate ||
    (phase === "idle" &&
      (!choices.complete ||
        existing ||
        owned.status !== "ready" ||
        owned.owner !== session.viewer ||
        presence === "online" ||
        presence === "away" ||
        choices.identities.some(
          (agent) =>
            agent.pubkey === peer && (agent.managed || agent.messageable),
        )))
  )
    return null;
  return (
    <AgentConnectionForm
      agents={agents}
      candidate={candidate}
      scope={session.scope}
      onStart={() => setPhase("pending")}
      onFinish={(success, error) => {
        if (error)
          notify(error, "error", {
            label: "Dismiss",
            onClick() {},
            timeout: Infinity,
          });
        setPhase(success ? "done" : "idle");
      }}
      onSendAgain={
        message
          ? async () => {
              session.messages.reply(
                message.channelId,
                message.threadRootId ?? message.id,
                "Please respond to my message above.",
                [peer],
                [],
                message.id,
              );
            }
          : undefined
      }
    />
  );
}

const noSubscribe = () => () => {};
const ready = () => undefined;
export function AgentConnectionForm({
  agents,
  candidate,
  scope,
  onStart,
  onFinish,
  preview = false,
  onSendAgain,
}: {
  agents: Agents;
  candidate: PortableAgent;
  scope: string;
  onStart?: () => void;
  onFinish?: (success: boolean, error?: string) => void;
  preview?: boolean;
  onSendAgain?: (() => Promise<void>) | undefined;
}) {
  const { types } = useAgents(agents);
  const [draft, setDraft] = useState(() => connectionDraft(candidate, types));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [sentAgain, setSentAgain] = useState(false);
  const type = types.find((type) => type.key === draft?.type && !type.remote);
  const provider = type?.provider;
  const state = useSyncExternalStore(
    provider?.subscribe ?? noSubscribe,
    provider?.snapshot ?? ready,
  );
  useEffect(() => {
    void Promise.resolve(provider?.check()).catch(() => {});
  }, [provider]);
  const Model = type?.CreateModel;
  const connect = async () => {
    if (!type || !draft || pending) return;
    if (preview) {
      setError("Preview only. No agent was imported.");
      return;
    }
    setPending(true);
    onStart?.();
    setError("");
    try {
      const result = await agents.port({
        source: candidate.source,
        pubkey: candidate.pubkey,
        type: type.key,
        config: draft.config,
        scope,
      });
      if (result.notes.length) setError(result.notes.join(" "));
      setDone(true);
      onFinish?.(true);
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      setError(error);
      onFinish?.(false, error);
    } finally {
      setPending(false);
    }
  };
  const sendAgain = async () => {
    if (!onSendAgain || pending || sentAgain) return;
    setPending(true);
    setError("");
    try {
      await onSendAgain();
      setSentAgain(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <section aria-label="Agent connection setup" data-agent-connection-setup="">
      <div className={messages.message}>
        <div className={messages.messageBody}>
          <div className="w-full max-w-xl">
            <div className={messages.messageBubble}>
              <div className="flex flex-col gap-4 py-2">
                <div className="size-12">
                  <Avatar
                    src={candidate.picture}
                    fallback={candidate.name}
                    alt=""
                    shape="squircle"
                    size="fill"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <h3 className="m-0 text-label">
                    {done
                      ? `${candidate.name} connected`
                      : `Connect ${candidate.name}`}
                  </h3>
                  <p className="m-0 text-body-sm text-subtle">
                    {preview
                      ? "Choose a harness to import this agent."
                      : done
                        ? onSendAgain
                          ? `Send “Please respond to my message above.” to ${candidate.name} in your original message’s thread.`
                          : "Send a message to continue your conversation."
                        : draft
                          ? "Review the settings to import this agent and continue your conversation."
                          : "Choose a harness for this agent. Its previous harness is not available here."}
                    {!done &&
                      " Stop this agent in old Buzz before connecting, so only one app replies."}
                  </p>
                </div>
                {!done && (
                  <>
                    <div className="flex max-w-full flex-col items-start gap-3">
                      <Select
                        label="Harness"
                        variant="compact"
                        appearance="inverted"
                        size="sm"
                        placeholder="Choose harness"
                        value={type?.key ?? ""}
                        disabled={pending}
                        onValueChange={(key) => {
                          const selected = types.find(
                            (type) => type.key === key,
                          );
                          if (selected)
                            setDraft(
                              connectionDraft(candidate, [selected]) ?? {
                                type: key,
                                config: selected.defaults().config,
                              },
                            );
                          setError("");
                        }}
                        groups={[
                          {
                            label: "",
                            options: types
                              .filter((type) => !type.remote)
                              .map((type) => ({
                                value: type.key,
                                label: type.title,
                              })),
                          },
                        ]}
                      />
                      {Model && draft && (
                        <Model
                          modelAppearance="inverted"
                          showEffort={false}
                          config={draft.config}
                          disabled={pending}
                          onChange={(config) => setDraft({ ...draft, config })}
                        />
                      )}
                    </div>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="prominent"
                        disabled={
                          pending ||
                          !type ||
                          (!!provider && state?.readiness !== "ready")
                        }
                        onClick={() => void connect()}
                      >
                        {pending ? "Connecting…" : "Connect"}
                      </Button>
                    </div>
                  </>
                )}
                {done && onSendAgain && (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="prominent"
                      disabled={pending || sentAgain}
                      onClick={() => void sendAgain()}
                    >
                      {sentAgain
                        ? "Follow-up queued"
                        : pending
                          ? "Sending…"
                          : `Ask ${candidate.name} to respond`}
                    </Button>
                  </div>
                )}
                {error && (
                  <p role="alert" className="m-0 text-body-sm text-danger">
                    {error}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
